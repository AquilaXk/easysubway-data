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
const finishedRun = (workflow = GWANGJU, overrides = {}) => ({ status: "completed", conclusion: "failure", workflowName: CLAIM_OWNERS[workflow].workflowName, headBranch: "main", ...overrides });

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
const run = (claims, h, workflowFile = GWANGJU, { refsText = refsOf(h.remote) } = {}) => removeOrphanClaims({
  workflowFile, repository: REPOSITORY, claims, refsText, runGh: h.runGh, runGit: h.runGit, report: h.report, log: h.log,
});

test("PR 없는 고아는 보고(#926)한 뒤에 지운다. 지울 때 본 sha가 아니면 지우지 않는다(lease)", async () => {
  const branch = branchOf(37399282636);
  const h = harness({ runs: { 37399282636: finishedRun() }, remote: { [branch]: SHA } });
  const result = await run([branch], h);
  assert.deepEqual(result, [{ branch, action: "removed_orphan", reported: "skip" }]);
  assert.deepEqual(h.reports, [{ workflowFile: GWANGJU, repository: REPOSITORY, runId: "37399282636" }]);
  const order = h.events.map(([kind, second]) => `${kind}:${second}`);
  assert.ok(order.indexOf("report:37399282636") < order.findIndex((entry) => entry === "git:push"), "보고가 삭제보다 먼저다");
  assert.deepEqual(h.events.at(-1), ["git", "push", `--force-with-lease=refs/heads/${branch}:${SHA}`, "origin", `:refs/heads/${branch}`]);
});

test("run 기록이 없어도(Not Found) 끝난 run이라 보고하고 지운다", async () => {
  const branch = branchOf(5);
  const h = harness({ runs: {}, remote: { [branch]: SHA } });
  assert.equal((await run([branch], h))[0].action, "removed_orphan");
  assert.equal(h.reports.length, 1);
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
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[0], /"action":"removed_orphan"/u);
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
    await assert.rejects(run([branch], h), /CLAIM_ORPHAN_REMOVE_REFUSED.*not an empty claim/u, JSON.stringify(carried));
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
  await assert.rejects(removeOrphanClaims({ workflowFile: GWANGJU, repository: REPOSITORY, claims: [branch], refsText: refsOf(h.remote), runGh: h.runGh, runGit: h.runGit, report, log: h.log }), /CLAIM_ORPHAN_REMOVE_REFUSED.*not an empty claim/u);
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
