import assert from "node:assert/strict";
import test from "node:test";

import { CLAIM_OWNERS } from "./claim-orphans.mjs";
import { main, reclaimStaleClaims } from "./reclaim-stale-claims.mjs";

// #1326: 만든 run이 끝났는데 PR 없이 남은 claim(stale)은 원장을 쓰는 다른 자동화를 막는다. 대기 판정 전에 회수한다.
// 회수는 만든 run이 끝났다는 API 증거가 있고 공유 판정(claim-orphans)이 ABANDONED로 본 claim만 대상이다. 판정할 수 없으면(API 오류 등) 차단을 유지한다(fail closed).
const REPOSITORY = "AquilaXk/easysubway-data";
const SEOUL = "seoul-current-accessibility-refresh.yml";
const REGISTRATION = "current-capital-topology-registration.yml";
const SHA = "a".repeat(40);
const branchOf = (runId, workflow = SEOUL) => `${CLAIM_OWNERS[workflow].prefix}${runId}`;
const pr = (number, state, headRefName) => ({ number, state, isDraft: false, headRefName, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY } });
const publishStep = (conclusion) => ({ name: CLAIM_OWNERS[SEOUL].publicationSteps[0], status: "completed", conclusion });
const runRecord = (overrides = {}) => ({
  status: "completed", conclusion: "failure", workflowName: CLAIM_OWNERS[SEOUL].workflowName, headBranch: "main", jobs: [{ name: "refresh", steps: [publishStep("skipped")] }], ...overrides,
});
const EMPTY = (workflow = SEOUL) => ({ aheadBy: 1, changedFiles: 0, messages: [CLAIM_OWNERS[workflow].claimSubject] });

/** 원격 claim·PR·run 기록을 흉내 내고 호출 순서를 기록한다. runs 값이 Error면 그 오류로 실패한다. */
function harness({ remote = {}, prs = {}, runs = {}, compare = {}, reportError = null, listError = null } = {}) {
  const events = [];
  const runGh = async (args) => {
    if (args[0] === "pr") {
      events.push(["gh", "pr", args[args.indexOf("--state") + 1]]);
      if (listError) throw listError;
      return JSON.stringify(args.includes("--head") ? (prs[args[args.indexOf("--head") + 1]] ?? []) : []);
    }
    if (args[0] === "api") {
      events.push(["gh", "api"]);
      const branch = /compare\/main\.\.\.(.+)$/u.exec(args[1])[1];
      return JSON.stringify(compare[branch] ?? EMPTY());
    }
    events.push(["gh", "run", args[2]]);
    const outcome = runs[args[2]];
    if (outcome instanceof Error) throw outcome;
    if (outcome === undefined) throw new Error("gh run view failed: failed to get run: HTTP 404: Not Found (https://api.github.com/x)");
    return JSON.stringify(outcome);
  };
  const runGit = async (args) => {
    if (args[0] === "ls-remote" && args.at(-1) === "refs/heads/automation/*") {
      return Object.entries(remote).map(([name, sha]) => `${sha}\trefs/heads/${name}\n`).join("");
    }
    if (args[0] === "ls-remote") {
      const ref = args.at(-1).replace("refs/heads/", "");
      return remote[ref] === undefined ? "" : `${remote[ref]}\t${args.at(-1)}\n`;
    }
    events.push(["git", ...args]);
    return "";
  };
  const reports = [];
  const report = async (input) => {
    events.push(["report", input.runId]);
    if (reportError) throw reportError;
    reports.push(input);
    return { action: "comment", issueNumber: 1326 };
  };
  const logs = [];
  return { events, reports, logs, deps: { runGh, runGit, report, log: (line) => logs.push(line), summaryFile: undefined } };
}
const pushed = (h) => h.events.filter(([kind, second]) => kind === "git" && second === "push");

const CASES = [
  { name: "completed failure + PR 없음 → 회수", runs: { 7001: runRecord() }, reclaimed: true },
  { name: "completed cancelled + PR 없음 → 회수", runs: { 7001: runRecord({ conclusion: "cancelled" }) }, reclaimed: true },
  { name: "in_progress → 차단 유지", runs: { 7001: runRecord({ status: "in_progress", conclusion: null, startedAt: new Date().toISOString() }) }, kept: /RUN_IN_PROGRESS/u },
  { name: "queued → 차단 유지", runs: { 7001: runRecord({ status: "queued", conclusion: null, createdAt: new Date().toISOString() }) }, kept: /RUN_IN_PROGRESS/u },
  { name: "success + PR open(성공 후 PR 대기) → 차단 유지", runs: { 7001: runRecord({ conclusion: "success" }) }, prs: [pr(11, "OPEN", branchOf(7001))], kept: /HAS_PULL_REQUEST/u },
  { name: "failure + PR closed → 차단 유지(사람이 볼 이상)", runs: { 7001: runRecord() }, prs: [pr(11, "CLOSED", branchOf(7001))], kept: /HAS_PULL_REQUEST/u },
  { name: "run 조회 API 오류 → 차단 유지", runs: { 7001: new Error("gh api failed: HTTP 502 Bad Gateway") }, kept: /HTTP 502/u },
  { name: "run 기록 없음(Not Found) → 게시 여부를 몰라 차단 유지", runs: {}, kept: /CLAIM_ORPHAN_RUN_UNAVAILABLE/u },
  { name: "게시 step이 시작된 failure + 증거 없음 → 차단 유지(사람 확인)", runs: { 7001: runRecord({ jobs: [{ name: "refresh", steps: [publishStep("failure")] }] }) }, kept: /CLAIM_ORPHAN_PUBLISHED_UNREGISTERED/u },
  { name: "출력 커밋이 있는 claim → 소유 workflow가 복구하므로 차단 유지", runs: { 7001: runRecord() }, compare: { aheadBy: 2, changedFiles: 4, messages: [CLAIM_OWNERS[SEOUL].claimSubject, "Refresh Seoul accessibility snapshot"] }, kept: /BRANCH_CARRIES_OUTPUT/u },
  { name: "다른 workflow의 run을 가리키는 claim → 차단 유지", runs: { 7001: runRecord({ workflowName: "Something Else" }) }, kept: /CLAIM_ORPHAN_RUN_MISMATCH/u },
];

for (const { name, runs, prs = [], compare, reclaimed = false, kept } of CASES) {
  test(`stale 판정: ${name}`, async () => {
    const branch = branchOf(7001);
    const h = harness({ remote: { [branch]: SHA }, runs, prs: { [branch]: prs }, compare: compare ? { [branch]: compare } : {} });
    const result = await reclaimStaleClaims({ repository: REPOSITORY, ...h.deps });
    if (reclaimed) {
      assert.deepEqual(result, { reclaimed: [branch], kept: [] });
      assert.deepEqual(pushed(h), [["git", "push", `--force-with-lease=refs/heads/${branch}:${SHA}`, "origin", `:refs/heads/${branch}`]]);
      // 회수는 조용히 하지 않는다: 소유 workflow의 실패 이슈에 보고하고(#926) 지운다.
      assert.deepEqual(h.reports, [{ workflowFile: SEOUL, repository: REPOSITORY, runId: "7001", orphan: { branch, conclusion: runs[7001].conclusion, reason: "PUBLISH_STEP_NOT_STARTED" } }]);
      assert.ok(h.events.findIndex(([kind]) => kind === "report") < h.events.findIndex(([kind, second]) => kind === "git" && second === "push"), "보고가 삭제보다 먼저다");
    } else {
      assert.deepEqual(result.reclaimed, []);
      assert.equal(result.kept.length, 1);
      assert.equal(result.kept[0].branch, branch);
      assert.match(result.kept[0].reason, kept);
      assert.equal(pushed(h).length, 0, "차단을 유지하는 claim은 지우지 않는다");
      assert.deepEqual(h.reports, []);
    }
  });
}

test("stale 판정: 소유자가 다른 claim은 건드리지 않는다(알 수 없는 접두어·자기 판정을 쓰는 등록 workflow·제외한 workflow)", async () => {
  const nationwide = "automation/927-nationwide-candidate-refresh-8001";
  const registration = branchOf(8002, REGISTRATION);
  const own = branchOf(8003);
  const h = harness({ remote: { [nationwide]: SHA, [registration]: SHA, [own]: SHA }, runs: { 8003: runRecord() } });
  const result = await reclaimStaleClaims({ repository: REPOSITORY, exceptWorkflow: SEOUL, ...h.deps });
  assert.deepEqual(result.reclaimed, []);
  assert.deepEqual(result.kept.map(({ branch, reason }) => ({ branch, reason: reason.split(":")[0] })), [{ branch: registration, reason: "OWNER_DECIDES" }]);
  assert.equal(h.events.some(([kind, second]) => kind === "gh" && second === "run"), false, "다른 소유자의 run은 조회하지 않는다");
  assert.equal(pushed(h).length, 0);
});

test("stale 판정: claim마다 독립이다. 하나가 판정 불가여도 나머지 stale은 회수한다", async () => {
  const stale = branchOf(7101);
  const active = branchOf(7102);
  const broken = branchOf(7103);
  const h = harness({
    remote: { [stale]: SHA, [active]: "b".repeat(40), [broken]: "c".repeat(40) },
    runs: { 7101: runRecord(), 7102: runRecord({ status: "in_progress", conclusion: null, startedAt: new Date().toISOString() }), 7103: new Error("HTTP 500") },
  });
  const result = await reclaimStaleClaims({ repository: REPOSITORY, ...h.deps });
  assert.deepEqual(result.reclaimed, [stale]);
  assert.deepEqual(result.kept.map(({ branch }) => branch).sort(), [active, broken].sort());
  assert.deepEqual(pushed(h).map((event) => event.at(-1)), [`:refs/heads/${stale}`]);
});

test("stale 판정: 보고나 삭제가 실패하면 차단을 유지한다(조용한 삭제 없음)", async () => {
  const branch = branchOf(7201);
  const h = harness({ remote: { [branch]: SHA }, runs: { 7201: runRecord() }, reportError: new Error("REFRESH_FAILURE_REPORT_DUPLICATE_ISSUES: x") });
  const result = await reclaimStaleClaims({ repository: REPOSITORY, ...h.deps });
  assert.deepEqual(result.reclaimed, []);
  assert.match(result.kept[0].reason, /DUPLICATE_ISSUES/u);
  assert.equal(pushed(h).length, 0);
});

test("stale 판정: 목록 조회(PR) 자체가 실패하면 판정 근거가 없으므로 실패한다", async () => {
  const branch = branchOf(7301);
  const h = harness({ remote: { [branch]: SHA }, runs: { 7301: runRecord() }, listError: new Error("gh api failed: HTTP 502") });
  await assert.rejects(reclaimStaleClaims({ repository: REPOSITORY, ...h.deps }), /HTTP 502/u);
  assert.equal(pushed(h).length, 0);
});

test("stale 판정: 회수 결과는 notice로, 판정하지 못한 claim은 warning으로 남긴다", async () => {
  const stale = branchOf(7401);
  const broken = branchOf(7402);
  const h = harness({ remote: { [stale]: SHA, [broken]: "b".repeat(40) }, runs: { 7401: runRecord(), 7402: new Error("HTTP 500") } });
  await reclaimStaleClaims({ repository: REPOSITORY, ...h.deps });
  const text = h.logs.join("\n");
  assert.match(text, new RegExp(`::notice title=Stale ledger claim reclaimed::.*${stale}`, "u"));
  assert.match(text, new RegExp(`::warning title=Stale ledger claim kept::.*${broken}.*HTTP 500`, "u"));
});

test("CLI는 --repository가 필요하고 --except-workflow는 선택이다", async () => {
  const branch = branchOf(7501);
  const h = harness({ remote: { [branch]: SHA }, runs: { 7501: runRecord() } });
  await assert.rejects(main([], h.deps), /CLAIM_ORPHAN_INPUT_INVALID.*missing --repository/u);
  await assert.rejects(main(["--repository", REPOSITORY, "--except-workflow", "nope.yml"], h.deps), /CLAIM_ORPHAN_INPUT_INVALID.*nope\.yml/u);
  await assert.rejects(main(["--repository", REPOSITORY, "--repository", REPOSITORY], h.deps), /CLAIM_ORPHAN_INPUT_INVALID/u);
  assert.deepEqual((await main(["--repository", REPOSITORY, "--except-workflow", SEOUL], h.deps)).reclaimed, []);
  assert.deepEqual((await main(["--repository", REPOSITORY], h.deps)).reclaimed, [branch]);
});
