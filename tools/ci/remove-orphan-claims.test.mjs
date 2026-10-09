import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PR_FIELDS } from "./collect-automation-prs.mjs";
import { CLAIM_OWNERS } from "./claim-orphans.mjs";
import { main, removeOrphanClaims } from "./remove-orphan-claims.mjs";

// #995: 고아 claim은 조용히 지우지 않는다. 사람이 run 실패를 볼 수 있게 #926 보고(report-refresh-failure)를 먼저 하고, 그 다음에 지운다.
// 병합된 PR의 남은 claim은 끝난 일이라 보고 없이 지운다. PR이 열려 있거나 닫혀 있거나 run이 진행 중이면 지우지 않고 실패한다.
const REPOSITORY = "AquilaXk/easysubway-data";
const GWANGJU = "retained-gwangju-timetable-refresh.yml";
const SHA = "c".repeat(40);
const branchOf = (runId, workflow = GWANGJU) => `${CLAIM_OWNERS[workflow].prefix}${runId}`;
const pr = (number, state, headRefName, overrides = {}) => ({
  number, state, isDraft: false, headRefName, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY }, ...overrides,
});
const publishStep = (workflow, conclusion) => (CLAIM_OWNERS[workflow].publicationSteps ? [{ name: CLAIM_OWNERS[workflow].publicationSteps[0], status: "completed", conclusion, number: 3 }] : []);
// gh run view --json jobs 모양. 기본값은 게시 step이 건너뛰어진(수집 단계에서 실패한) run이다.
const finishedRun = (workflow = GWANGJU, overrides = {}) => ({
  status: "completed", conclusion: "failure", workflowName: CLAIM_OWNERS[workflow].workflowName, headBranch: "main",
  jobs: [{ name: "refresh", steps: publishStep(workflow, "skipped") }], ...overrides,
});

/** gh·git·보고를 흉내 내고 호출 순서를 한 목록에 기록한다. */
function harness({ prs = {}, runs = {}, remote = {}, compare = {}, reportError = null, deleteError = null } = {}) {
  const events = [];
  const runGh = async (args) => {
    events.push(["gh", ...args.slice(0, 2)]);
    if (args[0] === "api") {
      const branch = /compare\/main\.\.\.(.+)$/u.exec(args[1])[1];
      return JSON.stringify(compare[branch] ?? { aheadBy: 1, changedFiles: 0, messages: ["Claim retained Gwangju timetable refresh"] });
    }
    if (args[0] === "pr" && args[1] === "list") {
      assert.equal(args[args.indexOf("--json") + 1], PR_FIELDS);
      assert.equal(args[args.indexOf("--state") + 1], "all");
      return JSON.stringify(prs[args[args.indexOf("--head") + 1]] ?? []);
    }
    assert.deepEqual(args.slice(0, 2), ["run", "view"]);
    const outcome = runs[args[2]];
    if (outcome instanceof Error) throw outcome;
    if (outcome === undefined) throw new Error("gh run view failed: failed to get run: HTTP 404: Not Found (https://api.github.com/x)");
    return JSON.stringify(outcome);
  };
  const runGit = async (args) => {
    if (args[0] === "ls-remote") {
      events.push(["git", "ls-remote"]);
      const ref = args.at(-1).replace("refs/heads/", "");
      return remote[ref] === undefined ? "" : `${remote[ref]}\t${args.at(-1)}\n`;
    }
    events.push(["git", ...args]);
    if (deleteError) throw deleteError;
    return "";
  };
  const reports = [];
  const report = async (input) => {
    events.push(["report", input.runId]);
    if (reportError) throw reportError;
    reports.push(input);
    return { action: "skip", issueNumber: 966 };
  };
  const logs = [];
  return { runGh, runGit, report, events, reports, logs, remote, log: (line) => logs.push(line) };
}
// 판정 시점의 ls-remote 출력(--refs). 기본값은 지금 원격과 같다.
const refsOf = (remote) => Object.entries(remote).map(([name, sha]) => `${sha}\trefs/heads/${name}\n`).join("");
const run = (claims, h, workflowFile = GWANGJU, { refsText = refsOf(h.remote), summaryFile } = {}) => removeOrphanClaims({
  workflowFile, repository: REPOSITORY, claims, refsText, runGh: h.runGh, runGit: h.runGit, report: h.report, log: h.log, summaryFile,
});

test("PR 없는 고아는 보고(#926)한 뒤에 지운다. 지울 때 본 sha가 아니면 지우지 않는다(lease)", async () => {
  const branch = branchOf(37399282636);
  const h = harness({ runs: { 37399282636: finishedRun() }, remote: { [branch]: SHA } });
  const result = await run([branch], h);
  assert.deepEqual(result, [{ branch, action: "removed_orphan", reported: "skip" }]);
  assert.deepEqual(h.reports, [{ workflowFile: GWANGJU, repository: REPOSITORY, runId: "37399282636", orphan: { branch, conclusion: "failure", reason: "PUBLISH_STEP_NOT_STARTED" } }]);
  const order = h.events.map(([kind, second]) => `${kind}:${second}`);
  assert.ok(order.indexOf("report:37399282636") < order.findIndex((entry) => entry === "git:push"), "보고가 삭제보다 먼저다");
  assert.deepEqual(h.events.at(-1), ["git", "push", `--force-with-lease=refs/heads/${branch}:${SHA}`, "origin", `:refs/heads/${branch}`]);
});

// #995 F1: run 기록이 없으면 게시 step까지 갔는지 알 수 없다. OCI 게시가 없는 workflow(topology)만 지운다.
test("run 기록이 없으면(Not Found) 게시 여부를 알 수 없어 지우지 않는다. 게시가 없는 workflow만 예외다", async () => {
  const branch = branchOf(5);
  const h = harness({ runs: {}, remote: { [branch]: SHA } });
  await assert.rejects(run([branch], h), /CLAIM_ORPHAN_RUN_UNAVAILABLE/u);
  assert.deepEqual(h.reports, []);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  const topology = "current-capital-topology-refresh.yml";
  const topologyBranch = branchOf(5, topology);
  const t = harness({ runs: {}, remote: { [topologyBranch]: SHA }, compare: { [topologyBranch]: { aheadBy: 1, changedFiles: 0, messages: [CLAIM_OWNERS[topology].claimSubject] } } });
  assert.equal((await run([topologyBranch], t, topology))[0].action, "removed_orphan");
});

test("병합된 PR의 남은 claim은 보고 없이 지운다", async () => {
  const branch = branchOf(6);
  const h = harness({ prs: { [branch]: [pr(1, "MERGED", branch)] }, remote: { [branch]: SHA } });
  assert.deepEqual(await run([branch], h), [{ branch, action: "removed_merged", reported: null }]);
  assert.deepEqual(h.reports, []);
  assert.equal(h.events.some(([, second]) => second === "run"), false, "병합된 claim은 run도 조회하지 않는다");
  assert.deepEqual(h.events.at(-1), ["git", "push", `--force-with-lease=refs/heads/${branch}:${SHA}`, "origin", `:refs/heads/${branch}`]);
});

test("열린 PR이나 닫힌 PR이 있는 claim은 지우지 않고 실패한다", async () => {
  for (const state of ["OPEN", "CLOSED"]) {
    const branch = branchOf(7);
    const h = harness({ prs: { [branch]: [pr(2, state, branch)] }, runs: { 7: finishedRun() }, remote: { [branch]: SHA } });
    await assert.rejects(run([branch], h), /CLAIM_ORPHAN_REMOVE_REFUSED/u, state);
    assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
    assert.deepEqual(h.reports, []);
  }
});

test("다른 저장소의 PR은 claim의 PR이 아니다", async () => {
  const branch = branchOf(8);
  const fork = pr(3, "OPEN", branch, { isCrossRepository: true, headRepository: { nameWithOwner: "fork/easysubway-data" } });
  const h = harness({ prs: { [branch]: [fork] }, runs: { 8: finishedRun() }, remote: { [branch]: SHA } });
  assert.equal((await run([branch], h))[0].action, "removed_orphan");
});

test("만든 run이 아직 끝나지 않았으면 보고도 삭제도 하지 않고 실패한다", async () => {
  for (const status of ["in_progress", "queued", "waiting", "pending", "requested"]) {
    const branch = branchOf(9);
    const h = harness({ runs: { 9: finishedRun(GWANGJU, { status, conclusion: null }) }, remote: { [branch]: SHA } });
    await assert.rejects(run([branch], h), /CLAIM_ORPHAN_REMOVE_REFUSED/u, status);
    assert.deepEqual(h.reports, []);
    assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false, status);
  }
});

test("run 조회가 Not Found가 아닌 오류로 실패하면 fail closed다", async () => {
  const branch = branchOf(10);
  const h = harness({ runs: { 10: new Error("gh run view failed: HTTP 403: Resource not accessible by integration") }, remote: { [branch]: SHA } });
  await assert.rejects(run([branch], h), /HTTP 403/u);
  assert.deepEqual(h.reports, []);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("다른 workflow나 main이 아닌 run을 가리키는 claim은 지우지 않는다", async () => {
  for (const overrides of [{ workflowName: "Source Reverification" }, { headBranch: "feature" }]) {
    const branch = branchOf(11);
    const h = harness({ runs: { 11: finishedRun(GWANGJU, overrides) }, remote: { [branch]: SHA } });
    await assert.rejects(run([branch], h), /CLAIM_ORPHAN_RUN_MISMATCH/u);
    assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  }
});

test("보고가 실패하면 지우지 않는다. 조용한 삭제를 만들지 않는다", async () => {
  const branch = branchOf(12);
  const h = harness({ runs: { 12: finishedRun() }, remote: { [branch]: SHA }, reportError: new Error("REFRESH_FAILURE_REPORT_DUPLICATE_ISSUES: x") });
  await assert.rejects(run([branch], h), /DUPLICATE_ISSUES/u);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("삭제가 실패하면(lease 불일치 포함) 실패한다", async () => {
  const branch = branchOf(13);
  const h = harness({ runs: { 13: finishedRun() }, remote: { [branch]: SHA }, deleteError: new Error("git push failed: stale info") });
  await assert.rejects(run([branch], h), /stale info/u);
});

test("이미 사라진 브랜치는 건너뛴다", async () => {
  const branch = branchOf(14);
  const h = harness({ remote: {} });
  assert.deepEqual(await run([branch], h, GWANGJU, { refsText: refsOf({ [branch]: SHA }) }), [{ branch, action: "absent", reported: null }]);
  assert.deepEqual(h.reports, []);
});

test("claim 이름이 이 workflow의 형식이 아니거나 중복이면 아무것도 하지 않고 실패한다", async () => {
  const h = harness();
  for (const claims of [["automation/639-seoul-accessibility-refresh-1"], ["main"], [branchOf(15), branchOf(15)], []]) {
    await assert.rejects(run(claims, h), /CLAIM_ORPHAN_INPUT_INVALID/u, JSON.stringify(claims));
  }
  assert.deepEqual(h.events, []);
});

test("CLI는 쉼표로 이어진 claim 목록을 받는다", async () => {
  const a = branchOf(21); const b = branchOf(22);
  const h = harness({ runs: { 21: finishedRun(), 22: finishedRun() }, remote: { [a]: SHA, [b]: SHA } });
  const directory = await mkdtemp(path.join(tmpdir(), "remove-claims-"));
  const refsFile = path.join(directory, "claims.txt");
  await writeFile(refsFile, refsOf(h.remote));
  const result = await main(["--workflow", GWANGJU, "--repository", REPOSITORY, "--claims", `${a},${b}`, "--refs", refsFile], { runGh: h.runGh, runGit: h.runGit, report: h.report, log: h.log });
  await rm(directory, { recursive: true, force: true });
  assert.deepEqual(result.map(({ action }) => action), ["removed_orphan", "removed_orphan"]);
  assert.equal(h.logs.filter((line) => line.startsWith("{")).length, 2);
  assert.match(h.logs.find((line) => line.startsWith("{")), /"action":"removed_orphan"/u);
  await assert.rejects(main(["--workflow", GWANGJU, "--repository", REPOSITORY, "--claims", a], { runGh: h.runGh, runGit: h.runGit, report: h.report, log: h.log }), /CLAIM_ORPHAN_INPUT_INVALID/u);
});

test("등록·재확인 workflow의 정리도 같은 경로를 쓴다", async () => {
  for (const workflow of ["current-capital-topology-registration.yml", "source-reverification.yml"]) {
    const branch = branchOf(31, workflow);
    const h = harness({ runs: { 31: finishedRun(workflow) }, remote: { [branch]: SHA }, compare: { [branch]: { aheadBy: 1, changedFiles: 0, messages: [CLAIM_OWNERS[workflow].claimSubject] } } });
    assert.equal((await run([branch], h, workflow))[0].action, "removed_orphan", workflow);
    assert.equal(h.reports[0].workflowFile, workflow);
  }
});

// #995 F2: 삭제 guard. lease는 판정 시점의 sha이고, push 직전에 빈 claim인지와 run 상태를 다시 확인한다.
test("삭제 lease는 판정 시점(--refs)의 sha다. 그 뒤 브랜치가 움직였으면 지우지 않는다", async () => {
  const branch = branchOf(41);
  const moved = harness({ runs: { 41: finishedRun() }, remote: { [branch]: "d".repeat(40) } });
  await assert.rejects(run([branch], moved, GWANGJU, { refsText: refsOf({ [branch]: SHA }) }), /CLAIM_ORPHAN_REMOVE_REFUSED.*moved since classification/u);
  assert.equal(moved.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  assert.deepEqual(moved.reports, []);
  const same = harness({ runs: { 41: finishedRun() }, remote: { [branch]: SHA } });
  await run([branch], same);
  assert.deepEqual(same.events.at(-1), ["git", "push", `--force-with-lease=refs/heads/${branch}:${SHA}`, "origin", `:refs/heads/${branch}`]);
  // 판정 시점 목록에 없는 claim은 지우지 않는다.
  await assert.rejects(run([branch], harness({ runs: { 41: finishedRun() }, remote: { [branch]: SHA } }), GWANGJU, { refsText: "" }), /CLAIM_ORPHAN_INPUT_INVALID.*classification refs/u);
});

test("출력 커밋이 있거나 비어 있지 않은 claim은 remover에 넘겨도 거부한다(보고도 삭제도 하지 않는다)", async () => {
  const branch = branchOf(42);
  const subject = "Claim retained Gwangju timetable refresh";
  for (const carried of [
    { aheadBy: 2, changedFiles: 2, messages: [subject, "Refresh retained Gwangju timetable"] },
    { aheadBy: 1, changedFiles: 1, messages: [subject] },
    { aheadBy: 1, changedFiles: 0, messages: ["someone else"] },
    { aheadBy: 0, changedFiles: 0, messages: [] },
  ]) {
    const h = harness({ runs: { 42: finishedRun() }, remote: { [branch]: SHA }, compare: { [branch]: carried } });
    await assert.rejects(run([branch], h), /CLAIM_ORPHAN_REMOVE_REFUSED.*not an empty or closed-out claim/u, JSON.stringify(carried));
    assert.deepEqual(h.reports, []);
    assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  }
});

test("보고 사이에 claim에 커밋이 올라오면 push 직전 재확인에서 거부한다", async () => {
  const branch = branchOf(43);
  const subject = "Claim retained Gwangju timetable refresh";
  const compare = { [branch]: { aheadBy: 1, changedFiles: 0, messages: [subject] } };
  const h = harness({ runs: { 43: finishedRun() }, remote: { [branch]: SHA }, compare });
  const report = async (input) => { await h.report(input); compare[branch] = { aheadBy: 2, changedFiles: 2, messages: [subject, "Refresh retained Gwangju timetable"] }; return { action: "skip" }; };
  await assert.rejects(removeOrphanClaims({ workflowFile: GWANGJU, repository: REPOSITORY, claims: [branch], refsText: refsOf(h.remote), runGh: h.runGh, runGit: h.runGit, report, log: h.log }), /CLAIM_ORPHAN_REMOVE_REFUSED.*not an empty or closed-out claim/u);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("보고 사이에 run 상태가 진행 중으로 바뀌면 push 직전 재확인에서 거부한다", async () => {
  const branch = branchOf(45);
  const runs = { 45: finishedRun() };
  const h = harness({ runs, remote: { [branch]: SHA } });
  const report = async (input) => { await h.report(input); runs[45] = finishedRun(GWANGJU, { status: "in_progress", conclusion: null }); return { action: "skip" }; };
  await assert.rejects(removeOrphanClaims({ workflowFile: GWANGJU, repository: REPOSITORY, claims: [branch], refsText: refsOf(h.remote), runGh: h.runGh, runGit: h.runGit, report, log: h.log }), /CLAIM_ORPHAN_REMOVE_REFUSED.*producer run 45 is still in_progress/u);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("병합된 PR의 남은 claim은 빈 claim 검사 없이 지운다", async () => {
  const branch = branchOf(44);
  const h = harness({ prs: { [branch]: [pr(1, "MERGED", branch)] }, remote: { [branch]: SHA }, compare: { [branch]: { aheadBy: 3, changedFiles: 4, messages: ["a", "b", "c"] } } });
  assert.equal((await run([branch], h))[0].action, "removed_merged");
  assert.equal(h.events.some(([kind, second]) => kind === "gh" && second === "api"), false);
});

// #995 F3: 삭제할 때마다 남기는 기록. 보고가 건너뛰어져도(이미 기록된 run) 삭제 사실이 run 로그와 요약에 남는다.
test("삭제할 때마다 notice와 step summary에 branch·producer run·conclusion·분류 reason·보고 action을 남긴다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "remove-claims-summary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const summaryFile = path.join(directory, "summary.md");
  const branch = branchOf(37399282636);
  const h = harness({ runs: { 37399282636: finishedRun(GWANGJU, { conclusion: "cancelled" }) }, remote: { [branch]: SHA } });
  await run([branch], h, GWANGJU, { summaryFile });
  const notice = h.logs.find((line) => line.startsWith("::notice"));
  assert.ok(notice, "notice 줄");
  for (const expected of [branch, "37399282636", "conclusion=cancelled", "reason=PUBLISH_STEP_NOT_STARTED", "report=skip"]) assert.ok(notice.includes(expected), `${expected} in ${notice}`);
  const { readFile } = await import("node:fs/promises");
  const summary = await readFile(summaryFile, "utf8");
  for (const expected of [branch, "37399282636", "cancelled", "PUBLISH_STEP_NOT_STARTED", "skip"]) assert.ok(summary.includes(expected), `${expected} in summary`);
  assert.deepEqual(h.reports[0].orphan, { branch, conclusion: "cancelled", reason: "PUBLISH_STEP_NOT_STARTED" });
});

test("병합된 PR의 남은 claim 삭제도 notice에 남지만 보고에는 orphan 정보가 없다", async () => {
  const branch = branchOf(46);
  const h = harness({ prs: { [branch]: [pr(1, "MERGED", branch)] }, remote: { [branch]: SHA } });
  await run([branch], h);
  assert.ok(h.logs.some((line) => line.startsWith("::notice") && line.includes(branch) && line.includes("reason=MERGED_LEFTOVER")));
  assert.deepEqual(h.reports, []);
});

test("게시 step이 시작된 run의 claim은 이 workflow의 판정을 거쳤어도 remover가 지우지 않는다", async () => {
  const branch = branchOf(47);
  const h = harness({ runs: { 47: finishedRun(GWANGJU, { jobs: [{ name: "refresh", steps: publishStep(GWANGJU, "failure") }] }) }, remote: { [branch]: SHA } });
  await assert.rejects(run([branch], h), /CLAIM_ORPHAN_PUBLISHED_UNREGISTERED/u);
  assert.deepEqual(h.reports, []);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("자기 판정을 쓰는 등록·재확인 workflow의 reason은 OWNER_DECISION이다", async () => {
  for (const workflow of ["current-capital-topology-registration.yml", "source-reverification.yml"]) {
    const branch = branchOf(48, workflow);
    const h = harness({ runs: { 48: finishedRun(workflow) }, remote: { [branch]: SHA }, compare: { [branch]: { aheadBy: 1, changedFiles: 0, messages: [CLAIM_OWNERS[workflow].claimSubject] } } });
    await run([branch], h, workflow);
    assert.equal(h.reports[0].orphan.reason, "OWNER_DECISION", workflow);
  }
});

// #995 F2 잔여: KRIC이 Abandon 커밋으로 닫은 claim(claim + Abandon, ahead 2, files 0)은 판정에서 ABANDONED/CLAIM_CLOSED_OUT이다.
// remover가 이를 거부하면 cleanup step이 매 run 실패해 KRIC 갱신이 막힌다.
const KRIC = "kric-current-facility-refresh.yml";
const closedOut = (messages = [CLAIM_OWNERS[KRIC].claimSubject, CLAIM_OWNERS[KRIC].abandonedSubject], overrides = {}) => ({ aheadBy: messages.length, changedFiles: 0, messages, ...overrides });

test("Abandon 커밋으로 닫힌 KRIC claim은 CLAIM_CLOSED_OUT으로 보고 후 지운다", async () => {
  const branch = branchOf(51, KRIC);
  const h = harness({ runs: { 51: finishedRun(KRIC) }, remote: { [branch]: SHA }, compare: { [branch]: closedOut() } });
  const [result] = await run([branch], h, KRIC);
  assert.equal(result.action, "removed_orphan");
  assert.equal(h.reports[0].orphan.reason, "CLAIM_CLOSED_OUT");
  assert.deepEqual(h.events.at(-1), ["git", "push", `--force-with-lease=refs/heads/${branch}:${SHA}`, "origin", `:refs/heads/${branch}`]);
});

test("닫힌 claim의 조건이 하나라도 어긋나면 거부한다(내용 변경, 첫 커밋, 커밋 수, Abandon 커밋 없음)", async () => {
  const claim = CLAIM_OWNERS[KRIC].claimSubject;
  const abandon = CLAIM_OWNERS[KRIC].abandonedSubject;
  for (const compare of [
    closedOut(undefined, { changedFiles: 1 }),
    closedOut([abandon, abandon]),
    closedOut([claim, "Refresh KRIC facility snapshot", abandon]),
    closedOut([claim, "Refresh KRIC facility snapshot"]),
    closedOut([claim, abandon], { aheadBy: 3 }),
  ]) {
    const branch = branchOf(52, KRIC);
    const h = harness({ runs: { 52: finishedRun(KRIC) }, remote: { [branch]: SHA }, compare: { [branch]: compare } });
    await assert.rejects(run([branch], h, KRIC), /CLAIM_ORPHAN_REMOVE_REFUSED.*not an empty or closed-out claim/u, JSON.stringify(compare));
    assert.deepEqual(h.reports, []);
    assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  }
});

test("Abandon 커밋을 쓰지 않는 workflow의 claim은 같은 모양이어도 거부한다", async () => {
  for (const workflow of [GWANGJU, "current-capital-topology-refresh.yml", "current-capital-topology-registration.yml", "source-reverification.yml"]) {
    assert.equal(CLAIM_OWNERS[workflow].abandonedSubject, undefined);
    const branch = branchOf(53, workflow);
    const h = harness({ runs: { 53: finishedRun(workflow) }, remote: { [branch]: SHA }, compare: { [branch]: closedOut([CLAIM_OWNERS[workflow].claimSubject, CLAIM_OWNERS[KRIC].abandonedSubject]) } });
    await assert.rejects(run([branch], h, workflow), /CLAIM_ORPHAN_REMOVE_REFUSED.*not an empty or closed-out claim/u, workflow);
    assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  }
});

// #1064: 실패한 topology run이 자기 claim을 같은 run에서 지운다. 반복 실패하는 원장 writer가 후보 갱신을 매 주기 막지 못하게 한다.
// 자기 run은 실패 step(`failure()`)에서만 이 도구를 부르므로 gh 기록상 아직 끝나지 않았어도 끝난 것으로 본다(--self-run-id).
// 이 예외는 OCI에 게시하지 않는 workflow(publicationSteps null)의 빈 claim에만 적용된다. 빈 claim 하나가 "출력도 게시도 없다"는 전체 증거다.
const TOPOLOGY = "current-capital-topology-refresh.yml";
const topologyHarness = (runId, overrides = {}, harnessOptions = {}) => {
  const branch = branchOf(runId, TOPOLOGY);
  const h = harness({
    runs: { [runId]: finishedRun(TOPOLOGY, { status: "in_progress", conclusion: null }) },
    remote: { [branch]: SHA },
    compare: { [branch]: { aheadBy: 1, changedFiles: 0, messages: [CLAIM_OWNERS[TOPOLOGY].claimSubject] } },
    ...harnessOptions,
  });
  return { branch, h, ...overrides };
};
const runSelf = (branch, h, selfRunId, options = {}) => removeOrphanClaims({
  workflowFile: TOPOLOGY, repository: REPOSITORY, claims: [branch], refsText: refsOf(h.remote), runGh: h.runGh, runGit: h.runGit, report: h.report, log: h.log, selfRunId,
  ...(selfRunId === undefined ? {} : { expectedSha: SHA }), ...options,
});

test("#1064 자기 run의 빈 claim: run 기록이 진행 중이어도 보고한 뒤 지운다(lease)", async () => {
  const { branch, h } = topologyHarness(5001);
  const result = await runSelf(branch, h, "5001");
  assert.deepEqual(result, [{ branch, action: "removed_orphan", reported: "skip" }]);
  // 삭제 댓글을 쌓지 않는다: orphan 없이 run 실패 보고(그 run을 기록)만 확인한다.
  assert.deepEqual(h.reports, [{ workflowFile: TOPOLOGY, repository: REPOSITORY, runId: "5001" }]);
  const order = h.events.map(([kind, second]) => `${kind}:${second}`);
  assert.ok(order.indexOf("report:5001") < order.indexOf("git:push"), "보고가 삭제보다 먼저다");
  assert.deepEqual(h.events.at(-1), ["git", "push", `--force-with-lease=refs/heads/${branch}:${SHA}`, "origin", `:refs/heads/${branch}`]);
  assert.equal(h.events.some(([kind, second]) => kind === "gh" && second === "run"), false, "자기 run은 gh run view로 조회하지 않는다");
});

test("#1064 반증: --self-run-id가 없으면 진행 중인 run의 claim은 지금처럼 지우지 않는다", async () => {
  const { branch, h } = topologyHarness(5002);
  await assert.rejects(runSelf(branch, h, undefined), /CLAIM_ORPHAN_REMOVE_REFUSED.*producer run 5002 is still in_progress/u);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("#1064 반증: 자기 run이 만든 claim이 아니면(다른 run이 진행 중) 지우지 않는다", async () => {
  const { branch, h } = topologyHarness(5003);
  await assert.rejects(runSelf(branch, h, "5004"), /CLAIM_ORPHAN_REMOVE_REFUSED.*producer run 5003 is still in_progress/u);
  assert.deepEqual(h.reports, []);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("#1064 반증: 자기 run의 claim이어도 출력이 있거나 PR이 있거나 제목이 다르면 지우지 않는다", async () => {
  const branch = branchOf(5005, TOPOLOGY);
  const subject = CLAIM_OWNERS[TOPOLOGY].claimSubject;
  for (const carried of [
    { aheadBy: 3, changedFiles: 4, messages: [subject, "Register current topology inputs", "Activate current topology inputs"] },
    { aheadBy: 2, changedFiles: 4, messages: [subject, "Register current topology inputs"] },
    { aheadBy: 1, changedFiles: 1, messages: [subject] },
    { aheadBy: 1, changedFiles: 0, messages: ["someone else"] },
  ]) {
    const { h } = topologyHarness(5005, {}, { compare: { [branch]: carried } });
    await assert.rejects(runSelf(branch, h, "5005"), /CLAIM_ORPHAN_REMOVE_REFUSED.*not an empty or closed-out claim/u, JSON.stringify(carried));
    assert.deepEqual(h.reports, []);
    assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  }
  for (const state of ["OPEN", "CLOSED"]) {
    const { h } = topologyHarness(5005, {}, { prs: { [branch]: [pr(7, state, branch)] } });
    await assert.rejects(runSelf(branch, h, "5005"), /CLAIM_ORPHAN_REMOVE_REFUSED/u, state);
    assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  }
});

test("#1064 반증: OCI에 게시하는 workflow는 자기 run 예외를 쓸 수 없다", async () => {
  const branch = branchOf(5006);
  const h = harness({ runs: { 5006: finishedRun(GWANGJU, { status: "in_progress", conclusion: null }) }, remote: { [branch]: SHA } });
  await assert.rejects(removeOrphanClaims({ workflowFile: GWANGJU, repository: REPOSITORY, claims: [branch], refsText: refsOf(h.remote), runGh: h.runGh, runGit: h.runGit, report: h.report, log: h.log, selfRunId: "5006", expectedSha: SHA }), /CLAIM_ORPHAN_REMOVE_REFUSED.*publishes/u);
  assert.deepEqual(h.reports, []);
  assert.equal(h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("#1064 반증: 보고가 실패하거나 lease가 어긋나면 자기 run의 claim도 지우지 않는다", async () => {
  const failing = topologyHarness(5007, {}, { reportError: new Error("REFRESH_FAILURE_REPORT_DUPLICATE_ISSUES: x") });
  await assert.rejects(runSelf(failing.branch, failing.h, "5007"), /DUPLICATE_ISSUES/u);
  assert.equal(failing.h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  const moved = topologyHarness(5008);
  await assert.rejects(runSelf(moved.branch, moved.h, "5008", { refsText: refsOf({ [moved.branch]: "d".repeat(40) }) }), /CLAIM_ORPHAN_REMOVE_REFUSED.*moved since classification/u);
  assert.equal(moved.h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
});

test("#1064 이전 run이 만든 claim(재사용된 claim)은 끝난 run이면 --self-run-id 없이도 지운다", async () => {
  const branch = branchOf(5009, TOPOLOGY);
  const h = harness({ runs: { 5009: finishedRun(TOPOLOGY) }, remote: { [branch]: SHA }, compare: { [branch]: { aheadBy: 1, changedFiles: 0, messages: [CLAIM_OWNERS[TOPOLOGY].claimSubject] } } });
  assert.equal((await runSelf(branch, h, "5010"))[0].action, "removed_orphan");
  // 재사용 claim은 다른 run이 만들었으므로 삭제 기록(orphan)을 남긴다. 자기 run 판정(AND)이 OR로 바뀌면 이 기록이 사라진다.
  assert.deepEqual(h.reports, [{ workflowFile: TOPOLOGY, repository: REPOSITORY, runId: "5009", orphan: { branch, conclusion: "failure", reason: "EMPTY_CLAIM_NO_PUBLICATION" } }]);
});

test("#1064 CLI는 --self-run-id를 받고 숫자가 아니거나 중복이면 실패한다", async () => {
  const { branch, h } = topologyHarness(5011);
  const directory = await mkdtemp(path.join(tmpdir(), "remove-claims-self-"));
  const refsFile = path.join(directory, "claims.txt");
  await writeFile(refsFile, refsOf(h.remote));
  const base = ["--workflow", TOPOLOGY, "--repository", REPOSITORY, "--claims", branch, "--refs", refsFile];
  const dependencies = { runGh: h.runGh, runGit: h.runGit, report: h.report, log: h.log };
  const sha = ["--expected-sha", SHA];
  assert.equal((await main([...base, "--self-run-id", "5011", ...sha], dependencies))[0].action, "removed_orphan");
  for (const bad of [["--self-run-id", "abc"], ["--self-run-id", "0"], ["--self-run-id", "5011", "--self-run-id", "5011"]]) {
    await assert.rejects(main([...base, ...bad, ...sha], dependencies), /CLAIM_ORPHAN_INPUT_INVALID/u, bad.join(" "));
  }
  await rm(directory, { recursive: true, force: true });
});

// #1063 리뷰 F1(#1065): 자기 run 모드는 claim을 만들 때 기록한 sha와 ls-remote sha가 정확히 같을 때만 지운다. 이 run이 이미 올린 출력 커밋이 compare API 지연으로 안 보여도 sha가 다르다.
const CLAIM_SHA = SHA;
test("#1064 자기 run 모드는 claim 생성 때 기록한 sha(--expected-sha)와 원격 sha가 같을 때만 지운다", async () => {
  const { branch, h } = topologyHarness(5101);
  const result = await runSelf(branch, h, "5101", { expectedSha: CLAIM_SHA });
  assert.equal(result[0].action, "removed_orphan");
  const pushed = topologyHarness(5102, {}, { remote: { [branchOf(5102, TOPOLOGY)]: "e".repeat(40) } });
  await assert.rejects(runSelf(pushed.branch, pushed.h, "5102", { expectedSha: CLAIM_SHA }), /CLAIM_ORPHAN_REMOVE_REFUSED.*differs from the recorded claim commit/u);
  assert.deepEqual(pushed.h.reports, []);
  assert.equal(pushed.h.events.some(([kind, second]) => kind === "git" && second === "push"), false);
  const missing = topologyHarness(5103);
  await assert.rejects(runSelf(missing.branch, missing.h, "5103", { expectedSha: undefined }), /CLAIM_ORPHAN_INPUT_INVALID.*expected sha/u, "자기 run 모드는 기록한 sha가 필수다");
  assert.equal(missing.h.events.length, 0);
  await assert.rejects(runSelf(missing.branch, missing.h, "5103", { expectedSha: "abc" }), /CLAIM_ORPHAN_INPUT_INVALID.*expected sha/u);
});

test("#1064 CLI는 --expected-sha를 받고 --self-run-id가 있으면 필수다", async () => {
  const { branch, h } = topologyHarness(5104);
  const directory = await mkdtemp(path.join(tmpdir(), "remove-claims-sha-"));
  const refsFile = path.join(directory, "claims.txt");
  await writeFile(refsFile, refsOf(h.remote));
  const base = ["--workflow", TOPOLOGY, "--repository", REPOSITORY, "--claims", branch, "--refs", refsFile];
  const dependencies = { runGh: h.runGh, runGit: h.runGit, report: h.report, log: h.log };
  await assert.rejects(main([...base, "--self-run-id", "5104"], dependencies), /CLAIM_ORPHAN_INPUT_INVALID.*expected sha/u);
  await assert.rejects(main([...base, "--expected-sha", CLAIM_SHA], dependencies), /CLAIM_ORPHAN_REMOVE_REFUSED.*still in_progress/u, "--self-run-id 없이는 진행 중인 run의 claim을 지우지 않는다");
  assert.equal((await main([...base, "--self-run-id", "5104", "--expected-sha", CLAIM_SHA], dependencies))[0].action, "removed_orphan");
  await rm(directory, { recursive: true, force: true });
});
