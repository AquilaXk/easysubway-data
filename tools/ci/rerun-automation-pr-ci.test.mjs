import assert from "node:assert/strict";
import test from "node:test";

import { AUTOMATION_PR_ACTIONS_BOT, AUTOMATION_PR_APP } from "./automation-pr-policy.mjs";
import { RERUN_COMMENT_JOB_LIMIT, main, rerunAutomationPullRequestCi, rerunMarker, unresolvedFailureOf } from "./rerun-automation-pr-ci.mjs";

// #1115: 자동화 PR의 required CI가 일시 오류로 실패하면 실패한 job을 정확히 한 번 다시 실행한다.
// 사례(2026-10-10): automation-pr-policy.test.mjs의 `Unable to deserialize cloned data`(test runner 일시 오류)와 Docker Hub 429(actionlint 이미지 pull, exit 125).
const REPOSITORY = "AquilaXk/easysubway-data";
const RUN_ID = 38051844019;
const HEAD_SHA = "a".repeat(40);
const BRANCH = "automation/636-current-topology-refresh-38051689361";
const PULL_NUMBER = 1112;

const identity = (value) => ({ login: value.login, id: value.id, type: value.type });
const humanUser = { login: "AquilaXk", id: 12345, type: "User" };

const run = (overrides = {}) => ({
  id: RUN_ID,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
  head_sha: HEAD_SHA,
  head_branch: BRANCH,
  head_repository: { full_name: REPOSITORY },
  html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
  ...overrides,
});
const pull = (overrides = {}) => ({
  number: PULL_NUMBER,
  state: "open",
  base: { ref: "main" },
  head: { sha: HEAD_SHA, ref: BRANCH, repo: { full_name: REPOSITORY } },
  user: identity(AUTOMATION_PR_APP),
  ...overrides,
});
const job = (name, conclusion, id) => ({ id, name, conclusion, html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}/job/${id}` });
const FAILED_JOBS = [
  job("Data contracts (shard 4/4)", "failure", 11),
  job("Data contracts (shard 1/4)", "success", 12),
  job("Data contracts", "failure", 13),
];

/** GitHub API를 흉내 낸다. 읽기 요청을 기록하고 재실행·코멘트 호출을 기록한다. */
function fixture({ runBody = run(), associated = [{ number: PULL_NUMBER, state: "open", base: { ref: "main" } }], pullBody = pull(), comments = [], jobs = FAILED_JOBS, rerunError = null } = {}) {
  const state = { requests: [], reruns: [], comments: [] };
  const api = async (endpoint) => {
    state.requests.push(endpoint);
    if (endpoint === `repos/${REPOSITORY}/actions/runs/${RUN_ID}`) return runBody;
    if (endpoint === `repos/${REPOSITORY}/commits/${HEAD_SHA}/pulls`) return associated;
    if (endpoint === `repos/${REPOSITORY}/pulls/${PULL_NUMBER}`) return pullBody;
    if (endpoint.startsWith(`repos/${REPOSITORY}/issues/${PULL_NUMBER}/comments?per_page=100&page=`)) return comments;
    if (endpoint === `repos/${REPOSITORY}/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100`) return { jobs };
    throw new Error(`unexpected request ${endpoint}`);
  };
  const rerunFailedJobs = async (runId) => {
    if (rerunError) throw rerunError;
    state.reruns.push(runId);
  };
  const comment = async (number, body) => { state.comments.push({ number, body }); };
  return { state, input: { repository: REPOSITORY, runId: RUN_ID, api, rerunFailedJobs, comment, log: () => {} } };
}

test("첫 시도에서 실패한 자동화 PR CI는 실패한 job만 한 번 다시 실행하고 PR에 기록을 남긴다", async () => {
  const { state, input } = fixture();
  const result = await rerunAutomationPullRequestCi(input);
  assert.deepEqual(result, { state: "RERUN", pullRequest: PULL_NUMBER, failedJobs: ["Data contracts (shard 4/4)", "Data contracts"] });
  assert.deepEqual(state.reruns, [RUN_ID]);
  assert.equal(state.comments.length, 1);
  const [{ number, body }] = state.comments;
  assert.equal(number, PULL_NUMBER);
  assert.ok(body.startsWith(rerunMarker(RUN_ID)), "표식이 본문 맨 앞이다");
  assert.match(body, /시도 1에서 2로/u);
  assert.match(body, /Data contracts \(shard 4\/4\)/u);
  assert.match(body, new RegExp(`actions/runs/${RUN_ID}/job/11`, "u"));
  assert.doesNotMatch(body, /shard 1\/4/u, "성공한 job은 적지 않는다");
  assert.match(body, /두 번째 시도도 실패하면 다시 실행하지 않고/u);
});

test("github-actions[bot]이 만든 자동화 PR도 대상이다", async () => {
  const { state, input } = fixture({ pullBody: pull({ user: identity(AUTOMATION_PR_ACTIONS_BOT) }) });
  assert.equal((await rerunAutomationPullRequestCi(input)).state, "RERUN");
  assert.deepEqual(state.reruns, [RUN_ID]);
});

test("두 번째 시도(run_attempt 2 이상)는 다시 실행하지 않는다: 재실행은 한 번뿐이고 실패는 기존 경로로 드러난다", async () => {
  for (const attempt of [2, 3]) {
    const { state, input } = fixture({ runBody: run({ run_attempt: attempt }) });
    assert.deepEqual(await rerunAutomationPullRequestCi(input), { state: "SECOND_ATTEMPT" });
    assert.deepEqual(state.reruns, []);
    assert.deepEqual(state.comments, []);
    assert.deepEqual(state.requests, [`repos/${REPOSITORY}/actions/runs/${RUN_ID}`], "run만 읽고 PR·job은 읽지 않는다");
  }
});

test("실패가 아닌 결론(success·cancelled·timed_out·진행 중)은 건드리지 않는다", async () => {
  for (const [status, conclusion] of [["completed", "success"], ["completed", "cancelled"], ["completed", "timed_out"], ["in_progress", null]]) {
    const { state, input } = fixture({ runBody: run({ status, conclusion }) });
    assert.deepEqual(await rerunAutomationPullRequestCi(input), { state: "NOT_APPLICABLE", reason: "RUN_NOT_FAILED" });
    assert.deepEqual(state.reruns, []);
  }
});

test("CI의 pull_request 실행이 아니거나 이 저장소의 automation/ 브랜치가 아니면 대상이 아니다(fork PR 포함)", async () => {
  const cases = [
    ["push 실행", run({ event: "push" })],
    ["다른 workflow", run({ path: ".github/workflows/other.yml", name: "Other" })],
    ["fork 저장소 head", run({ head_repository: { full_name: "someone/easysubway-data" } })],
    ["사람 브랜치", run({ head_branch: "fix/something-1" })],
    ["접두사 흉내", run({ head_branch: "automation-evil/636-current-topology-refresh-1" })],
  ];
  for (const [label, runBody] of cases) {
    const { state, input } = fixture({ runBody });
    assert.equal((await rerunAutomationPullRequestCi(input)).state, "NOT_APPLICABLE", label);
    assert.deepEqual(state.reruns, [], label);
    assert.deepEqual(state.comments, [], label);
  }
});

test("사람이 만든 PR과 신뢰하지 않는 작성자의 automation/ 브랜치 PR은 재실행하지 않는다", async () => {
  const users = [
    humanUser,
    { ...identity(AUTOMATION_PR_APP), id: 1 },
    { ...identity(AUTOMATION_PR_APP), type: "User" },
    { login: "dependabot[bot]", id: 49699333, type: "Bot" },
    null,
  ];
  for (const user of users) {
    const { state, input } = fixture({ pullBody: pull({ user }) });
    assert.deepEqual(await rerunAutomationPullRequestCi(input), { state: "NOT_APPLICABLE", reason: "PULL_NOT_AUTOMATION" });
    assert.deepEqual(state.reruns, []);
  }
});

test("PR head가 CI run의 head와 다르면(새 커밋이 올라옴) STALE이고, 열린 PR이 없으면 대상이 아니다", async () => {
  const stale = fixture({ pullBody: pull({ head: { sha: "b".repeat(40), ref: BRANCH, repo: { full_name: REPOSITORY } } }) });
  assert.deepEqual(await rerunAutomationPullRequestCi(stale.input), { state: "STALE" });
  assert.deepEqual(stale.state.reruns, []);
  const closed = fixture({ associated: [{ number: PULL_NUMBER, state: "closed", base: { ref: "main" } }] });
  assert.deepEqual(await rerunAutomationPullRequestCi(closed.input), { state: "NOT_APPLICABLE", reason: "NO_OPEN_PULL" });
  const otherBase = fixture({ associated: [{ number: PULL_NUMBER, state: "open", base: { ref: "release" } }] });
  assert.deepEqual(await rerunAutomationPullRequestCi(otherBase.input), { state: "NOT_APPLICABLE", reason: "NO_OPEN_PULL" });
  assert.deepEqual([...closed.state.reruns, ...otherBase.state.reruns], []);
});

test("같은 head의 열린 PR이 둘 이상이면 하나를 고르지 않고 이름 있는 코드로 실패한다", async () => {
  const { state, input } = fixture({ associated: [
    { number: PULL_NUMBER, state: "open", base: { ref: "main" } },
    { number: 1113, state: "open", base: { ref: "main" } },
  ] });
  await assert.rejects(rerunAutomationPullRequestCi(input), /^Error: CI_RERUN_PULL_AMBIGUOUS: /u);
  assert.deepEqual(state.reruns, []);
});

test("이 run에 대한 기록 코멘트가 github-actions[bot]에게 이미 있으면 다시 실행하지 않는다(멱등). 낯선 사용자의 같은 표식은 인정하지 않는다", async () => {
  const bot = { user: identity(AUTOMATION_PR_ACTIONS_BOT), body: `${rerunMarker(RUN_ID)}\n기록` };
  const recorded = fixture({ comments: [bot] });
  assert.deepEqual(await rerunAutomationPullRequestCi(recorded.input), { state: "ALREADY_RECORDED" });
  assert.deepEqual(recorded.state.reruns, []);
  assert.deepEqual(recorded.state.comments, []);
  const forged = fixture({ comments: [{ user: humanUser, body: `${rerunMarker(RUN_ID)}\n선점` }, { user: identity(AUTOMATION_PR_ACTIONS_BOT), body: rerunMarker(RUN_ID + 1) }] });
  assert.equal((await rerunAutomationPullRequestCi(forged.input)).state, "RERUN");
  assert.deepEqual(forged.state.reruns, [RUN_ID]);
});

test("실패한 job을 찾지 못하면 재실행하지 않고 이름 있는 코드로 실패한다(조용히 넘어가지 않는다)", async () => {
  const { state, input } = fixture({ jobs: [job("Data contracts", "success", 13), job("Automation PR gates", "skipped", 14)] });
  await assert.rejects(rerunAutomationPullRequestCi(input), /^Error: CI_RERUN_NO_FAILED_JOB: /u);
  assert.deepEqual(state.reruns, []);
  assert.deepEqual(state.comments, []);
});

test("재실행 요청이 실패하면 코멘트를 남기지 않고 오류를 그대로 던진다(재실행하지 않았는데 했다고 적지 않는다)", async () => {
  const { state, input } = fixture({ rerunError: new Error("gh api exited 403") });
  await assert.rejects(rerunAutomationPullRequestCi(input), /gh api exited 403/u);
  assert.deepEqual(state.comments, []);
});

test("코멘트에 적는 job 이름은 제어 문자를 지우고 개수를 제한한다", async () => {
  const many = Array.from({ length: RERUN_COMMENT_JOB_LIMIT + 5 }, (_, index) => job(`Job ${index}\u202e\n<!-- x --> [y](http://evil) \`z\``, "failure", 100 + index));
  const { state, input } = fixture({ jobs: many });
  const result = await rerunAutomationPullRequestCi(input);
  assert.equal(result.failedJobs.length, RERUN_COMMENT_JOB_LIMIT + 5);
  const [{ body }] = state.comments;
  assert.doesNotMatch(body, /\u202e/u);
  const jobLines = body.split("\n").filter((line) => line.startsWith("- [Job "));
  for (const line of jobLines) assert.match(line, /^- \[Job \d+ +!-- x -- +y +\(http:\/\/evil\) +z\]\(https:\/\/github\.com\/[^)\s]+\)$/u, "링크 문자와 HTML 표지가 지워진 이름이다");
  assert.doesNotMatch(body.replace(rerunMarker(RUN_ID), ""), /<|>/u);
  assert.equal(body.split("\n").filter((line) => line.startsWith("- [Job ")).length, RERUN_COMMENT_JOB_LIMIT);
  assert.match(body, /외 5개/u);
  assert.equal(body.split(rerunMarker(RUN_ID)).length, 2, "job 이름이 표식을 흉내 내도 표식은 맨 앞 하나뿐이다");
});

test("입력 오류는 API를 부르기 전에 거부한다", async () => {
  const { state, input } = fixture();
  for (const bad of [{ repository: "not a repo" }, { repository: "a/b/c" }, { runId: 0 }, { runId: "123" }, { runId: 1.5 }, { api: null }, { rerunFailedJobs: null }, { comment: null }]) {
    await assert.rejects(rerunAutomationPullRequestCi({ ...input, ...bad }), /^Error: CI_RERUN_INPUT/u);
  }
  assert.deepEqual(state.requests, []);
});

test("main은 --repository와 --run-id 두 인자만 받는다", async () => {
  const calls = [];
  const runGh = async (args, body) => {
    calls.push({ args, body });
    if (args[0] === "api" && args.at(-1) === `repos/${REPOSITORY}/actions/runs/${RUN_ID}`) return JSON.stringify(run({ run_attempt: 2 }));
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const logs = [];
  const result = await main(["--repository", REPOSITORY, "--run-id", String(RUN_ID)], { runGh, log: (line) => logs.push(line) });
  assert.deepEqual(result, { state: "SECOND_ATTEMPT" });
  assert.match(logs.join("\n"), /SECOND_ATTEMPT/u);
  for (const argv of [[], ["--repository", REPOSITORY], ["--repository", REPOSITORY, "--run-id", "12", "--extra", "x"], ["--repository", REPOSITORY, "--repository", REPOSITORY], ["--repository", REPOSITORY, "--run-id", "0"]]) {
    await assert.rejects(main(argv, { runGh, log: () => {} }), /^Error: CI_RERUN_ARGUMENTS/u);
  }
});

test("main은 재실행을 gh api POST rerun-failed-jobs 한 번으로, 코멘트를 issues API 한 번으로 보낸다", async () => {
  const calls = [];
  const runGh = async (args, body) => {
    calls.push({ args, body });
    const endpoint = args.at(-1);
    if (args.includes("POST")) return "";
    if (endpoint === `repos/${REPOSITORY}/actions/runs/${RUN_ID}`) return JSON.stringify(run());
    if (endpoint === `repos/${REPOSITORY}/commits/${HEAD_SHA}/pulls`) return JSON.stringify([{ number: PULL_NUMBER, state: "open", base: { ref: "main" } }]);
    if (endpoint === `repos/${REPOSITORY}/pulls/${PULL_NUMBER}`) return JSON.stringify(pull());
    if (endpoint.startsWith(`repos/${REPOSITORY}/issues/${PULL_NUMBER}/comments?`)) return JSON.stringify([]);
    if (endpoint.startsWith(`repos/${REPOSITORY}/actions/runs/${RUN_ID}/jobs?`)) return JSON.stringify({ jobs: FAILED_JOBS });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const result = await main(["--repository", REPOSITORY, "--run-id", String(RUN_ID)], { runGh, log: () => {} });
  assert.equal(result.state, "RERUN");
  const posts = calls.filter(({ args }) => args.includes("POST"));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].args.slice(-1), [`repos/${REPOSITORY}/actions/runs/${RUN_ID}/rerun-failed-jobs`]);
  assert.deepEqual(posts[1].args.slice(-1), [`repos/${REPOSITORY}/issues/${PULL_NUMBER}/comments`]);
  assert.ok(posts[1].args.includes("--input"), "코멘트 본문은 인자가 아니라 stdin JSON으로 보낸다");
  assert.ok(JSON.parse(posts[1].body).body.startsWith(rerunMarker(RUN_ID)));
});

test("timed_out으로 끝난 job도 실패 job으로 보고 정확히 한 번 재실행한다(그 job만 나쁠 때도)", async () => {
  const { state, input } = fixture({ jobs: [job("Data contracts (shard 2/4)", "timed_out", 21), job("Data contracts (shard 1/4)", "success", 22), job("Automation PR gates", "cancelled", 23)] });
  const result = await rerunAutomationPullRequestCi(input);
  assert.deepEqual(result, { state: "RERUN", pullRequest: PULL_NUMBER, failedJobs: ["Data contracts (shard 2/4)"] });
  assert.deepEqual(state.reruns, [RUN_ID]);
  assert.match(state.comments[0].body, /shard 2\/4/u);
  assert.doesNotMatch(state.comments[0].body, /Automation PR gates/u, "취소된 job은 실패 job으로 적지 않는다");
});

test("라벨러가 건너뛴 첫 시도 실패가 재실행 없이 남는 결과(STALE, ALREADY_RECORDED, 작성자가 자동화가 아닌 PR)는 미해결 실패로 분류한다", () => {
  assert.equal(unresolvedFailureOf({ state: "STALE" }), "STALE");
  assert.equal(unresolvedFailureOf({ state: "ALREADY_RECORDED" }), "ALREADY_RECORDED");
  assert.equal(unresolvedFailureOf({ state: "NOT_APPLICABLE", reason: "PULL_NOT_AUTOMATION" }), "NOT_APPLICABLE:PULL_NOT_AUTOMATION");
  // 재실행했거나, 두 번째 시도이거나, 라벨러도 대상으로 보지 않는 경우에는 남는 실패 상태가 없다.
  assert.equal(unresolvedFailureOf({ state: "RERUN", pullRequest: 1, failedJobs: [] }), null);
  assert.equal(unresolvedFailureOf({ state: "SECOND_ATTEMPT" }), null);
  for (const reason of ["NO_OPEN_PULL", "RUN_NOT_FAILED", "RUN_NOT_AUTOMATION_PULL_REQUEST_CI"]) {
    assert.equal(unresolvedFailureOf({ state: "NOT_APPLICABLE", reason }), null, reason);
  }
});

test("main은 재실행하지 않고 실패가 남는 결과에서 이름 있는 코드로 실패해 #926 실패 이슈 경로로 드러낸다", async () => {
  const gh = ({ runBody = run(), pullBody = pull(), comments = [] } = {}) => async (args) => {
    const endpoint = args.at(-1);
    if (args.includes("POST")) throw new Error(`unexpected write ${endpoint}`);
    if (endpoint === `repos/${REPOSITORY}/actions/runs/${RUN_ID}`) return JSON.stringify(runBody);
    if (endpoint === `repos/${REPOSITORY}/commits/${HEAD_SHA}/pulls`) return JSON.stringify([{ number: PULL_NUMBER, state: "open", base: { ref: "main" } }]);
    if (endpoint === `repos/${REPOSITORY}/pulls/${PULL_NUMBER}`) return JSON.stringify(pullBody);
    if (endpoint.startsWith(`repos/${REPOSITORY}/issues/${PULL_NUMBER}/comments?`)) return JSON.stringify(comments);
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const argv = ["--repository", REPOSITORY, "--run-id", String(RUN_ID)];
  const stale = pull({ head: { sha: "b".repeat(40), ref: BRANCH, repo: { full_name: REPOSITORY } } });
  await assert.rejects(main(argv, { runGh: gh({ pullBody: stale }), log: () => {} }), /^Error: CI_RERUN_FAILURE_UNRESOLVED: STALE/u);
  await assert.rejects(main(argv, { runGh: gh({ pullBody: pull({ user: humanUser }) }), log: () => {} }), /^Error: CI_RERUN_FAILURE_UNRESOLVED: NOT_APPLICABLE:PULL_NOT_AUTOMATION/u);
  const recorded = [{ user: identity(AUTOMATION_PR_ACTIONS_BOT), body: `${rerunMarker(RUN_ID)}\n기록` }];
  await assert.rejects(main(argv, { runGh: gh({ comments: recorded }), log: () => {} }), /^Error: CI_RERUN_FAILURE_UNRESOLVED: ALREADY_RECORDED/u);
  // 대상이 아닌 결과는 조용히 끝난다.
  assert.equal((await main(argv, { runGh: gh({ runBody: run({ run_attempt: 2 }) }), log: () => {} })).state, "SECOND_ATTEMPT");
  assert.equal((await main(argv, { runGh: gh({ runBody: run({ status: "completed", conclusion: "success" }) }), log: () => {} })).state, "NOT_APPLICABLE");
});
