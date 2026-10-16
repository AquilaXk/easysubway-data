import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MANUAL_CLOSE_WORKFLOWS,
  MAX_SCANNED_RUNS,
  RECOVERY_PROOF,
  RECOVERY_COMMENT_MARKER,
  closeRecoveredFailureIssues,
  main,
} from "./close-recovered-failure-issues.mjs";
import { REPORTABLE_WORKFLOW_FILES, planRefreshFailureReport } from "./report-refresh-failure.mjs";

// #1287: 같은 workflow가 마지막 보고 실패 run보다 나중에 대상 단계까지 성공했을 때만 실패 이슈를 닫는다. 추정으로 닫지 않는다.
const repository = "AquilaXk/easysubway-data";
const topology = "current-capital-topology-refresh.yml";
const reverification = "source-reverification.yml";
const chain = "datapack-release-cross-repo-chain.yml";
const DELIVERY_STEP = "Create draft pull request";
const BOT = { login: "app/github-actions" };
const runUrl = (id) => `https://github.com/${repository}/actions/runs/${id}`;
const start = new Date("2026-10-15T00:00:00.000Z");

function botIssue(number, { workflowFile = topology, failedRunId = 1000, failures = [], ...overrides } = {}) {
  const plan = planRefreshFailureReport({ repository, workflowFile, runId: String(failedRunId), openIssues: [], now: start, failures });
  return { number, title: plan.title, body: plan.body, author: BOT, createdAt: start.toISOString(), comments: [], ...overrides };
}

const job = (steps) => ({ name: "refresh", conclusion: "success", steps: steps.map(([name, conclusion]) => ({ name, conclusion })) });
const delivered = [job([["Decide whether current topology refresh is due", "success"], [DELIVERY_STEP, "success"]])];
const nothingToDo = [job([["Decide whether current topology refresh is due", "success"], [DELIVERY_STEP, "skipped"]])];
const successRun = (id) => ({ id, conclusion: "success", html_url: runUrl(id) });

// issue list/close와 Actions run·job 조회만 흉내 내는 저장소. 닫기 호출을 기록하고 선택한 이슈에서는 닫기를 실패시킨다.
function fakeGitHub({ issues = [], runs = {}, jobs = {}, failClose = [] }) {
  const calls = [];
  const closed = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(issues);
    if (args[0] === "issue" && args[1] === "close") {
      const number = Number(args[2]);
      if (failClose.includes(number)) throw new Error("gh issue close failed: HTTP 502");
      closed.push({ number, args });
      return "";
    }
    const path = args.find((arg) => arg.startsWith("repos/"));
    const workflowRuns = /\/actions\/workflows\/([^/]+)\/runs$/u.exec(path);
    if (workflowRuns) return JSON.stringify({ workflow_runs: runs[workflowRuns[1]] ?? [] });
    const runJobs = /\/actions\/runs\/(\d+)\/jobs$/u.exec(path);
    if (runJobs) return JSON.stringify({ jobs: jobs[runJobs[1]] ?? [] });
    return assert.fail(`unexpected gh call ${args.join(" ")}`);
  };
  return { calls, closed, runGh };
}

const run = (github) => closeRecoveredFailureIssues({ repository, runGh: github.runGh });
const outcome = (results, number) => results.find((result) => result.issueNumber === number);

test("마지막 실패 run보다 나중에 대상 단계까지 성공한 run이 있으면 닫고, 성공 run URL을 코멘트로 남긴다", async () => {
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: [successRun(1001)] }, jobs: { 1001: delivered } });
  const results = await run(github);
  assert.deepEqual(github.closed.map(({ number }) => number), [1248]);
  const args = github.closed[0].args;
  assert.deepEqual(args.slice(0, 3), ["issue", "close", "1248"]);
  assert.equal(args[args.indexOf("--repo") + 1], repository);
  assert.equal(args[args.indexOf("--reason") + 1], "completed");
  const comment = args[args.indexOf("--comment") + 1];
  assert.ok(comment.includes(RECOVERY_COMMENT_MARKER));
  assert.ok(comment.includes(runUrl(1001)), "성공 run URL");
  assert.ok(comment.includes(runUrl(1000)), "마지막 보고 실패 run URL");
  assert.ok(comment.includes(DELIVERY_STEP), "확인한 단계");
  assert.deepEqual(outcome(results, 1248), { issueNumber: 1248, workflowFile: topology, action: "closed", reason: "RECOVERED", runUrl: runUrl(1001) });
});

test("가장 최근의 증거 run을 쓰고, 증거가 없는 더 최근 성공 run은 건너뛴다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248)],
    runs: { [topology]: [successRun(1004), successRun(1003), successRun(1002), successRun(1001)] },
    jobs: { 1004: nothingToDo, 1003: nothingToDo, 1002: delivered, 1001: delivered },
  });
  assert.equal(outcome(await run(github), 1248).runUrl, runUrl(1002));
});

test("실패 run보다 앞서 시작한 성공 run은 회복이 아니다", async () => {
  const github = fakeGitHub({ issues: [botIssue(1248, { failedRunId: 1000 })], runs: { [topology]: [successRun(1000), successRun(999)] }, jobs: { 1000: delivered, 999: delivered } });
  const results = await run(github);
  assert.deepEqual(github.closed, []);
  assert.equal(outcome(results, 1248).reason, "NO_RECOVERY_PROOF");
});

test("본문 상태 블록과 댓글에 기록된 가장 최근 실패 run이 기준이다", async () => {
  const later = botIssue(1248, { failedRunId: 1000 });
  later.body = later.body.replace(`  - ${runUrl(1000)}`, `  - ${runUrl(1010)}\n  - ${runUrl(1000)}`);
  later.comments = [{ body: `다시 실패했다.\n- 실패 run: ${runUrl(1020)}`, createdAt: start.toISOString(), author: BOT }];
  const github = fakeGitHub({ issues: [later], runs: { [topology]: [successRun(1015), successRun(1021)] }, jobs: { 1015: delivered, 1021: delivered } });
  assert.equal(outcome(await run(github), 1248).runUrl, runUrl(1021));
  const onlyBefore = fakeGitHub({ issues: [later], runs: { [topology]: [successRun(1015)] }, jobs: { 1015: delivered } });
  assert.deepEqual(await run(onlyBefore).then(() => onlyBefore.closed), []);
});

test("목록에 섞인 성공이 아닌 run은 단계가 success여도 증거가 아니다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248)],
    runs: { [topology]: [{ ...successRun(1002), conclusion: "failure" }, { ...successRun(1001), conclusion: "cancelled" }] },
    jobs: { 1002: delivered, 1001: delivered },
  });
  await run(github);
  assert.deepEqual(github.closed, []);
});

test("대상 단계가 건너뛰어진 성공 run(할 일 없음)은 회복이 아니다", async () => {
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: [successRun(1001)] }, jobs: { 1001: nothingToDo } });
  const results = await run(github);
  assert.deepEqual(github.closed, []);
  assert.equal(outcome(results, 1248).action, "kept");
});

test("체인은 배포와 검증 단계가 모두 성공해야 하고, chain job이 skipped인 성공 run은 회복이 아니다", async () => {
  const [publish, deploy, verify] = RECOVERY_PROOF[chain][0];
  const issue = botIssue(1242, { workflowFile: chain });
  const attempt = (steps) => fakeGitHub({ issues: [issue], runs: { [chain]: [successRun(1001)] }, jobs: { 1001: steps } });
  for (const steps of [
    [],
    [job([["Identify the release-candidate run", "success"]])],
    [job([[publish, "success"], [deploy, "success"], [verify, "skipped"]])],
    [job([[publish, "success"], [deploy, "skipped"], [verify, "success"]])],
    [job([[publish, "skipped"], [deploy, "success"], [verify, "success"]])],
    [job([[publish, "success"], [deploy, "success"], [verify, "failure"]])],
    [job([[publish, "success"], [deploy, "success"]]), job([[verify, "success"]])],
  ]) {
    const github = attempt(steps);
    await run(github);
    assert.deepEqual(github.closed, [], JSON.stringify(steps));
  }
  const github = attempt([job([[publish, "success"], [deploy, "success"], [verify, "success"]])]);
  await run(github);
  assert.deepEqual(github.closed.map(({ number }) => number), [1242]);
});

test("recipe 표지가 남은 이슈는 어떤 성공 run에도 닫지 않는다", async () => {
  const blocked = botIssue(1276, {
    workflowFile: reverification,
    failures: [{ recipeId: "kric-station-timetable", code: "SOURCE_EXPECTATION_CHANGED" }],
  });
  const github = fakeGitHub({
    issues: [blocked],
    runs: { [reverification]: [successRun(1001)] },
    jobs: { 1001: [job([["Create source reverification pull request", "success"]])] },
  });
  const results = await run(github);
  assert.deepEqual(github.closed, []);
  assert.deepEqual(outcome(results, 1276), { issueNumber: 1276, workflowFile: reverification, action: "kept", reason: "BLOCKED_RECIPE", recipes: ["kric-station-timetable"] });
  assert.equal(github.calls.some((args) => String(args.find((arg) => String(arg).startsWith("repos/"))).includes("/runs")), false, "표지 이슈는 run을 조회하지 않는다");
});

test("표지 없는 재확인 실패 이슈는 PR 생성 단계가 성공한 run으로 닫는다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1260, { workflowFile: reverification })],
    runs: { [reverification]: [successRun(1001)] },
    jobs: { 1001: [job([["Create source reverification pull request", "success"]])] },
  });
  await run(github);
  assert.deepEqual(github.closed.map(({ number }) => number), [1260]);
});

test("사람이 연 이슈, 제목이 다른 이슈, 다른 마커의 이슈는 닫지 않는다", async () => {
  const bot = botIssue(1);
  const issues = [
    { ...bot, number: 2, author: { login: "AquilaXk" } },
    { ...bot, number: 3, title: "[Fix] 사람이 쓴 제목" },
    { ...bot, number: 4, body: "사람이 인용한 표지가 없는 본문" },
    { ...botIssue(5, { workflowFile: "source-derivative-rebinding.yml" }), number: 5 },
  ];
  const github = fakeGitHub({
    issues,
    runs: { [topology]: [successRun(1001)] },
    jobs: { 1001: delivered },
  });
  await run(github);
  assert.deepEqual(github.closed, []);
});

test("다른 workflow의 성공 run은 증거가 아니다: 이슈 마커의 workflow run만 조회한다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248)],
    runs: { [topology]: [], "kric-current-facility-refresh.yml": [successRun(1001)] },
    jobs: { 1001: delivered },
  });
  await run(github);
  assert.deepEqual(github.closed, []);
  const listed = github.calls.map((args) => args.find((arg) => String(arg).includes("/workflows/"))).filter(Boolean);
  assert.deepEqual(listed, [`repos/${repository}/actions/workflows/${topology}/runs`]);
});

test("run 조회는 main의 성공 run만 요청한다", async () => {
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: [] } });
  await run(github);
  const call = github.calls.find((args) => args.some((arg) => String(arg).includes("/workflows/")));
  for (const flag of ["status=success", "branch=main", "per_page=100"]) assert.ok(call.includes(flag), flag);
});

test("닫기 API가 실패하면 조용히 넘기지 않고 close-failed로 드러내며 다른 이슈 처리는 계속한다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248), botIssue(1255, { workflowFile: "retained-gwangju-timetable-refresh.yml" })],
    runs: { [topology]: [successRun(1001)], "retained-gwangju-timetable-refresh.yml": [successRun(1002)] },
    jobs: { 1001: delivered, 1002: [job([["Create retained timetable draft pull request", "success"]])] },
    failClose: [1248],
  });
  const results = await run(github);
  assert.deepEqual(github.closed.map(({ number }) => number), [1255]);
  assert.equal(outcome(results, 1248).action, "close-failed");
  assert.match(outcome(results, 1248).error, /HTTP 502/u);
});

test("최근 성공 run 상한 안에 증거가 없으면 닫지 않는다", async () => {
  const runs = Array.from({ length: MAX_SCANNED_RUNS + 1 }, (_, index) => successRun(2000 - index));
  const jobs = Object.fromEntries(runs.map(({ id }) => [id, nothingToDo]));
  jobs[runs.at(-1).id] = delivered;
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: runs }, jobs });
  await run(github);
  assert.deepEqual(github.closed, []);
  assert.equal(github.calls.filter((args) => String(args.find((arg) => String(arg).includes("/jobs")) ?? "").length > 0).length, MAX_SCANNED_RUNS);
});

test("수동 종료 workflow의 이슈는 run을 조회하지 않고 남긴다", async () => {
  const [workflowFile] = Object.keys(MANUAL_CLOSE_WORKFLOWS);
  const github = fakeGitHub({ issues: [botIssue(7, { workflowFile })], runs: { [workflowFile]: [successRun(1001)] }, jobs: { 1001: delivered } });
  const results = await run(github);
  assert.deepEqual(github.closed, []);
  assert.equal(outcome(results, 7).reason, "MANUAL_CLOSE");
  assert.equal(github.calls.some((args) => args.some((arg) => String(arg).includes("/runs"))), false);
});

test("실패 run이 하나도 기록되지 않은 이슈는 추정하지 않고 이상으로 남긴다", async () => {
  const empty = { ...botIssue(1248), body: botIssue(1248).body.replaceAll(/https:\/\/github\.com\/\S+\/actions\/runs\/\d+/gu, "") };
  const github = fakeGitHub({ issues: [empty], runs: { [topology]: [successRun(1001)] }, jobs: { 1001: delivered } });
  const results = await run(github);
  assert.deepEqual(github.closed, []);
  assert.equal(outcome(results, 1248).reason, "NO_RECORDED_FAILURE_RUN");
});

test("같은 workflow의 이슈가 여럿이면 각각 자기 기준으로 판정하고 run 목록은 한 번만 읽는다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248, { failedRunId: 1000 }), botIssue(1249, { failedRunId: 1500 })],
    runs: { [topology]: [successRun(1001)] },
    jobs: { 1001: delivered },
  });
  await run(github);
  assert.deepEqual(github.closed.map(({ number }) => number), [1248]);
  assert.equal(github.calls.filter((args) => args.some((arg) => String(arg).endsWith(`/workflows/${topology}/runs`))).length, 1);
});

test("열린 실패 이슈가 없으면 Actions API를 부르지 않는다", async () => {
  const github = fakeGitHub({ issues: [] });
  assert.deepEqual(await run(github), []);
  assert.equal(github.calls.length, 1);
});

test("보고 대상 workflow는 모두 회복 판정 기준이나 수동 종료 사유를 하나만 가진다", () => {
  const proven = Object.keys(RECOVERY_PROOF);
  const manual = Object.keys(MANUAL_CLOSE_WORKFLOWS);
  assert.deepEqual([...proven, ...manual].sort(), [...REPORTABLE_WORKFLOW_FILES].sort());
  assert.deepEqual(proven.filter((file) => manual.includes(file)), []);
  for (const reason of Object.values(MANUAL_CLOSE_WORKFLOWS)) assert.ok(reason.length > 0);
});

test("회복 판정 단계 이름은 실제 workflow에 있는 step이다(이름이 바뀌면 판정이 조용히 멈추지 않고 여기서 실패한다)", () => {
  for (const [workflowFile, alternatives] of Object.entries(RECOVERY_PROOF)) {
    assert.ok(alternatives.length > 0 && alternatives.every((steps) => steps.length > 0), workflowFile);
    const yml = readFileSync(new URL(`../../.github/workflows/${workflowFile}`, import.meta.url), "utf8");
    for (const stepName of alternatives.flat()) assert.ok(yml.includes(`      - name: ${stepName}\n`), `${workflowFile}: ${stepName}`);
  }
});

test("main은 결과를 annotation으로 쓰고, 닫기 실패는 경고로만 드러내 종료 코드를 바꾸지 않는다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248), botIssue(1255, { workflowFile: "retained-gwangju-timetable-refresh.yml" })],
    runs: { [topology]: [successRun(1001)] },
    jobs: { 1001: delivered },
    failClose: [1248],
  });
  const lines = [];
  const exitCode = await main(["--repository", repository], { runGh: github.runGh, log: (line) => lines.push(line) });
  assert.equal(exitCode, 0);
  assert.ok(lines.some((line) => line.startsWith("::warning title=Recovered failure issue::#1248") && line.includes("HTTP 502")));
  assert.ok(lines.some((line) => line.includes("#1255") && !line.startsWith("::")));
  await assert.rejects(main(["--repository", "bad repo"], { runGh: github.runGh, log: () => {} }), /CLOSE_RECOVERED_ARGUMENTS/u);
});

test("main은 회복을 닫으면 notice로 알린다", async () => {
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: [successRun(1001)] }, jobs: { 1001: delivered } });
  const lines = [];
  await main(["--repository", repository], { runGh: github.runGh, log: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.startsWith("::notice title=Recovered failure issue::#1248") && line.includes(runUrl(1001))));
});
