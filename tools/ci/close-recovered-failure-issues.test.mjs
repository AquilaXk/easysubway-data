import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MANUAL_CLOSE_WORKFLOWS,
  MAX_JOB_LOOKUPS_PER_SWEEP,
  MAX_RUN_PAGES,
  RECOVERY_PROOF,
  RECOVERY_COMMENT_MARKER,
  closeRecoveredFailureIssues,
  main,
} from "./close-recovered-failure-issues.mjs";
import { REPORTABLE_WORKFLOW_FILES, planRefreshFailureReport } from "./report-refresh-failure.mjs";
import { parseWorkflow } from "./workflow-secret-classification.mjs";

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
// run id가 커질수록 늦게 생긴다: 생성 시각은 id초 뒤다.
const createdAt = (id) => new Date(start.getTime() + id * 1000).toISOString();
const successRun = (id) => ({ id, conclusion: "success", html_url: runUrl(id), created_at: createdAt(id) });
const PAGE_SIZE = 100;
// 실패 이후 성공 run이 쌓인 API 응답(최근 순). proofIds의 run만 대상 단계가 success다.
const accumulatedRuns = (firstId, count, proofIds) => {
  const ids = Array.from({ length: count }, (_, index) => firstId + count - 1 - index);
  return { runs: ids.map(successRun), jobs: Object.fromEntries(ids.map((id) => [id, proofIds.includes(id) ? delivered : nothingToDo])) };
};

// issue list/close와 Actions run·job 조회만 흉내 내는 저장소. run 목록은 created 범위와 페이징을 지키고, 닫기 호출을 기록하며 선택한 이슈에서는 닫기를 실패시킨다.
function fakeGitHub({ issues = [], runs = {}, jobs = {}, failClose = [], unreadableRuns = [] }) {
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
    const query = Object.fromEntries(args.flatMap((arg, index) => (args[index - 1] === "-f" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : [])));
    const workflowRuns = /\/actions\/workflows\/([^/]+)\/runs$/u.exec(path);
    if (workflowRuns) {
      const since = query.created.replace(/^>=/u, "");
      const inRange = (runs[workflowRuns[1]] ?? []).filter((candidate) => candidate.created_at >= since);
      const page = Number(query.page);
      return JSON.stringify({ total_count: inRange.length, workflow_runs: inRange.slice((page - 1) * Number(query.per_page), page * Number(query.per_page)) });
    }
    const runJobs = /\/actions\/runs\/(\d+)\/jobs$/u.exec(path);
    if (runJobs) return JSON.stringify({ jobs: jobs[runJobs[1]] ?? [] });
    const singleRun = /\/actions\/runs\/(\d+)$/u.exec(path);
    if (singleRun) {
      if (unreadableRuns.includes(Number(singleRun[1]))) throw new Error("gh api failed: HTTP 404");
      return JSON.stringify({ created_at: createdAt(Number(singleRun[1])) });
    }
    return assert.fail(`unexpected gh call ${args.join(" ")}`);
  };
  return { calls, closed, runGh };
}

const callsTo = (github, pattern) => github.calls.filter((args) => pattern.test(args.find((arg) => String(arg).startsWith("repos/")) ?? ""));

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

test("실패 run보다 앞서 시작한 성공 run은 회복이 아니다", async () => {
  const github = fakeGitHub({ issues: [botIssue(1248, { failedRunId: 1000 })], runs: { [topology]: [successRun(1000), successRun(999)] }, jobs: { 1000: delivered, 999: delivered } });
  const results = await run(github);
  assert.deepEqual(github.closed, []);
  assert.equal(outcome(results, 1248).reason, "NO_RECOVERY_PROOF");
});

const NOTICE_MARKER = "<!-- easysubway-refresh-failure-comment -->";

test("본문 상태 블록과 봇이 단 알림 댓글에 기록된 가장 최근 실패 run이 기준이다", async () => {
  const later = botIssue(1248, { failedRunId: 1000 });
  later.body = later.body.replace(`  - ${runUrl(1000)}`, `  - ${runUrl(1010)}\n  - ${runUrl(1000)}`);
  later.comments = [{ body: `${NOTICE_MARKER}\n다시 실패했다.\n- 실패 run: ${runUrl(1020)}`, createdAt: start.toISOString(), author: { login: "github-actions" } }];
  const github = fakeGitHub({ issues: [later], runs: { [topology]: [successRun(1021), successRun(1015)] }, jobs: { 1015: delivered, 1021: delivered } });
  assert.equal(outcome(await run(github), 1248).runUrl, runUrl(1021));
  const onlyBefore = fakeGitHub({ issues: [later], runs: { [topology]: [successRun(1015)] }, jobs: { 1015: delivered } });
  assert.deepEqual(await run(onlyBefore).then(() => onlyBefore.closed), []);
});

test("사람 댓글, 알림 표지 없는 댓글, 이전 자동 종료 댓글의 run URL은 기준에 끼지 않는다", async () => {
  const issue = botIssue(1248, { failedRunId: 1000 });
  issue.comments = [
    { body: `${NOTICE_MARKER}\n- 실패 run: ${runUrl(1900)}`, createdAt: start.toISOString(), author: { login: "AquilaXk" } },
    { body: `봇 같은 말투\n- 실패 run: ${runUrl(1901)}`, createdAt: start.toISOString(), author: { login: "github-actions" } },
    { body: `<!-- easysubway-refresh-failure-recovered -->\n- 성공 run: ${runUrl(1902)}`, createdAt: start.toISOString(), author: { login: "github-actions" } },
  ];
  const github = fakeGitHub({ issues: [issue], runs: { [topology]: [successRun(1001)] }, jobs: { 1001: delivered } });
  assert.equal(outcome(await run(github), 1248).runUrl, runUrl(1001));
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

test("여러 증명 run이 있으면 가장 이른 run을 인용한다: API가 최근 순으로 줘도 정렬은 오름차순이다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248)],
    runs: { [topology]: [1005, 1004, 1003, 1002, 1001].map(successRun) },
    jobs: { 1005: delivered, 1004: nothingToDo, 1003: delivered, 1002: nothingToDo, 1001: nothingToDo },
  });
  assert.equal(outcome(await run(github), 1248).runUrl, runUrl(1003));
  assert.deepEqual(callsTo(github, /\/runs\/\d+\/jobs$/u).map((args) => args.find((arg) => arg.includes("/jobs")).match(/runs\/(\d+)/u)[1]), ["1001", "1002", "1003"], "이른 run부터 조회하고 증거에서 멈춘다");
});

test("실패 뒤 성공 run이 한 페이지(100개)를 넘게 쌓여도 앞쪽에 있는 증명 run을 찾는다", async () => {
  const { runs, jobs } = accumulatedRuns(1001, 2 * PAGE_SIZE + 50, [1003]);
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: runs }, jobs });
  assert.equal(outcome(await run(github), 1248).runUrl, runUrl(1003));
  const pages = callsTo(github, /\/workflows\/[^/]+\/runs$/u).map((args) => args.find((arg) => arg.startsWith("page=")));
  assert.deepEqual(pages, ["page=1", "page=2", "page=3"]);
});

test("run 범위는 마지막 실패 run의 생성 시각부터다", async () => {
  const github = fakeGitHub({ issues: [botIssue(1248, { failedRunId: 1000 })], runs: { [topology]: [] } });
  await run(github);
  assert.ok(callsTo(github, /\/workflows\/[^/]+\/runs$/u)[0].includes(`created=>=${createdAt(1000)}`));
});

test("상한 페이지 수에 닿았는데 증거가 없으면 NO_RECOVERY_PROOF로 넘기지 않고 SCAN_TRUNCATED로 드러낸다", async () => {
  const { runs, jobs } = accumulatedRuns(1001, MAX_RUN_PAGES * PAGE_SIZE + 20, [1003]);
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: runs }, jobs });
  // job 조회 예산이 먼저 바닥나지 않도록 상한 페이지의 run 수보다 크게 준다(예산과 페이지 상한은 서로 다른 자원의 한도다).
  const results = await closeRecoveredFailureIssues({ repository, runGh: github.runGh, jobLookupBudget: MAX_RUN_PAGES * PAGE_SIZE });
  assert.deepEqual(github.closed, []);
  assert.equal(outcome(results, 1248).reason, "SCAN_TRUNCATED");
  assert.equal(callsTo(github, /\/workflows\/[^/]+\/runs$/u).length, MAX_RUN_PAGES);
  const lines = [];
  await main(["--repository", repository], { runGh: github.runGh, log: (line) => lines.push(line), jobLookupBudget: MAX_RUN_PAGES * PAGE_SIZE });
  assert.ok(lines.some((line) => line.startsWith("::warning title=Recovered failure issue::#1248") && line.includes("SCAN_TRUNCATED")));
});

test("상한 안에서 찾은 증거는 상한에 닿았어도 인정한다", async () => {
  const { runs, jobs } = accumulatedRuns(1001, MAX_RUN_PAGES * PAGE_SIZE + 20, [1100]);
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: runs }, jobs });
  assert.equal(outcome(await run(github), 1248).runUrl, runUrl(1100));
});

const jobLookups = (github) => callsTo(github, /\/runs\/\d+\/jobs$/u).length;
const GWANGJU = "retained-gwangju-timetable-refresh.yml";

test("job 조회가 실행당 예산을 다 쓰면 판정을 멈추고 대상 이슈를 경고로 드러내며, 종료 코드는 0이다", async () => {
  const { runs, jobs } = accumulatedRuns(1001, MAX_JOB_LOOKUPS_PER_SWEEP + 50, [1001 + MAX_JOB_LOOKUPS_PER_SWEEP + 10]);
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: runs }, jobs });
  const lines = [];
  assert.equal(await main(["--repository", repository], { runGh: github.runGh, log: (line) => lines.push(line) }), 0);
  assert.deepEqual(github.closed, []);
  assert.equal(jobLookups(github), MAX_JOB_LOOKUPS_PER_SWEEP, "예산을 넘겨 조회하지 않는다");
  assert.ok(lines.some((line) => line.startsWith("::warning title=Recovered failure issue::#1248") && line.includes("JOB_LOOKUP_BUDGET_EXHAUSTED")));
});

test("예산을 쓴 뒤 남은 이슈는 조회 없이 예산 소진으로 드러내고, 조회가 필요 없는 판정은 계속한다", async () => {
  const { runs, jobs } = accumulatedRuns(1001, MAX_JOB_LOOKUPS_PER_SWEEP + 50, []);
  const github = fakeGitHub({
    issues: [botIssue(1248), botIssue(1255, { workflowFile: GWANGJU, failedRunId: 900 }), botIssue(1276, { workflowFile: reverification, failures: [{ recipeId: "korail-topology", code: "SOURCE_EXPECTATION_CHANGED" }] })],
    runs: { [topology]: runs, [GWANGJU]: [successRun(901)] },
    jobs: { ...jobs, 901: [job([["Create retained timetable draft pull request", "success"]])] },
  });
  const results = await run(github);
  assert.deepEqual(github.closed, []);
  assert.equal(outcome(results, 1248).reason, "JOB_LOOKUP_BUDGET_EXHAUSTED");
  assert.equal(outcome(results, 1255).reason, "JOB_LOOKUP_BUDGET_EXHAUSTED");
  assert.equal(outcome(results, 1276).reason, "BLOCKED_RECIPE");
  assert.equal(jobLookups(github), MAX_JOB_LOOKUPS_PER_SWEEP);
  assert.equal(callsTo(github, new RegExp(`/workflows/${GWANGJU}/runs$`, "u")).length, 0, "소진 뒤에는 run도 조회하지 않는다");
});

test("예산 안에서 찾은 증거는 정상으로 닫는다: 마지막 조회에서 찾아도 닫힌다", async () => {
  const { runs, jobs } = accumulatedRuns(1001, MAX_JOB_LOOKUPS_PER_SWEEP + 50, [1000 + MAX_JOB_LOOKUPS_PER_SWEEP]);
  const github = fakeGitHub({ issues: [botIssue(1248)], runs: { [topology]: runs }, jobs });
  assert.equal(outcome(await run(github), 1248).runUrl, runUrl(1000 + MAX_JOB_LOOKUPS_PER_SWEEP));
  assert.equal(jobLookups(github), MAX_JOB_LOOKUPS_PER_SWEEP);
});

test("예산은 이슈마다가 아니라 실행 전체에서 나눠 쓴다: 앞 이슈가 쓴 만큼 뒤 이슈의 조회가 줄어든다", async () => {
  const first = accumulatedRuns(1001, 60, []);
  const second = accumulatedRuns(2001, 60, [2060]);
  const github = fakeGitHub({
    issues: [botIssue(1248), botIssue(1255, { workflowFile: GWANGJU, failedRunId: 2000 })],
    runs: { [topology]: first.runs, [GWANGJU]: second.runs.map((candidate) => candidate) },
    jobs: { ...first.jobs, ...Object.fromEntries(second.runs.map(({ id }) => [id, id === 2060 ? [job([["Create retained timetable draft pull request", "success"]])] : nothingToDo])) },
  });
  const results = await run(github);
  assert.equal(outcome(results, 1255).reason, "JOB_LOOKUP_BUDGET_EXHAUSTED");
  assert.equal(jobLookups(github), MAX_JOB_LOOKUPS_PER_SWEEP);
});

test("마지막 실패 run을 읽지 못하면 그 이슈만 이상으로 남기고 다른 이슈 처리는 계속한다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248, { failedRunId: 1000 }), botIssue(1255, { workflowFile: "retained-gwangju-timetable-refresh.yml", failedRunId: 900 })],
    runs: { [topology]: [successRun(1001)], "retained-gwangju-timetable-refresh.yml": [successRun(901)] },
    jobs: { 1001: delivered, 901: [job([["Create retained timetable draft pull request", "success"]])] },
    unreadableRuns: [1000],
  });
  const results = await run(github);
  assert.equal(outcome(results, 1248).reason, "FAILURE_RUN_UNREADABLE");
  assert.match(outcome(results, 1248).error, /HTTP 404/u);
  assert.deepEqual(github.closed.map(({ number }) => number), [1255]);
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

test("같은 workflow의 이슈가 여럿이면 각각 자기 기준으로 판정한다", async () => {
  const github = fakeGitHub({
    issues: [botIssue(1248, { failedRunId: 1000 }), botIssue(1249, { failedRunId: 1500 })],
    runs: { [topology]: [successRun(1001)] },
    jobs: { 1001: delivered },
  });
  await run(github);
  assert.deepEqual(github.closed.map(({ number }) => number), [1248]);
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

const stepCount = (jobText, stepName) => jobText.split("\n").filter((line) => line === `      - name: ${stepName}`).length;

test("회복 판정의 대안은 실제 workflow의 한 job 안에 있고 그 job에서 step 이름이 유일하다(구조가 바뀌면 판정이 조용히 멈추지 않고 여기서 실패한다)", () => {
  for (const [workflowFile, alternatives] of Object.entries(RECOVERY_PROOF)) {
    assert.ok(alternatives.length > 0 && alternatives.every((steps) => steps.length > 0), workflowFile);
    const { jobs } = parseWorkflow(readFileSync(new URL(`../../.github/workflows/${workflowFile}`, import.meta.url), "utf8"));
    for (const steps of alternatives) {
      const owners = jobs.filter(({ text }) => steps.some((name) => stepCount(text, name) > 0));
      assert.equal(owners.length, 1, `${workflowFile}: ${steps.join(" + ")}는 한 job에 있어야 한다`);
      for (const name of steps) assert.equal(stepCount(owners[0].text, name), 1, `${workflowFile}/${owners[0].name}: ${name}`);
    }
  }
});

test("구조 검사 반례: 대안의 step이 두 job에 나뉘거나 한 job에 이름이 겹치면 걸린다", () => {
  const yml = "jobs:\n  a:\n    steps:\n      - name: One\n      - name: One\n  b:\n    steps:\n      - name: Two\n";
  const { jobs } = parseWorkflow(yml);
  assert.equal(jobs.filter(({ text }) => ["One", "Two"].some((name) => stepCount(text, name) > 0)).length, 2);
  assert.equal(stepCount(jobs[0].text, "One"), 2);
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
