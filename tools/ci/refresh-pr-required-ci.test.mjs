import assert from "node:assert/strict";
import test from "node:test";

import { ensureRefreshPullRequestRequiredCi, requiredCiState } from "./refresh-pr-required-ci.mjs";

// #939·#947 리뷰 F2: 열린 갱신 PR(OPEN_PR)의 head에 pull_request CI가 없으면 App 토큰으로 그 PR만 닫았다 다시 연다.
// reopened 이벤트가 App 행위자로 pull_request CI를 다시 실행한다. 이미 붙었거나 돌고 있으면 아무것도 하지 않는다(멱등).
const HEAD = "a".repeat(40);
const REPOSITORY = "AquilaXk/easysubway-data";
const BRANCH = "automation/636-current-topology-refresh-37209118635";

test("required CI 상태: rollup에 Data contracts가 있으면 ATTACHED, 같은 head의 pull_request CI가 진행 중이면 PENDING, 그 밖은 MISSING", () => {
  assert.equal(requiredCiState({ headSha: HEAD, rollupContexts: [{ name: "Data contracts" }], ciRuns: [] }), "ATTACHED");
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
    assert.equal(requiredCiState({ headSha: HEAD, rollupContexts: [], ciRuns: [{ event: "pull_request", headSha: HEAD, status, conclusion: "" }] }), "PENDING", status);
  }
  // 승인 대기로 끝난 run(action_required), 다른 head, dispatch run은 CI가 붙은 것으로 보지 않는다.
  assert.equal(requiredCiState({
    headSha: HEAD,
    rollupContexts: [{ name: "CodeQL" }, { context: "Data contracts (shard 1/4)" }],
    ciRuns: [
      { event: "pull_request", headSha: HEAD, status: "completed", conclusion: "action_required" },
      { event: "pull_request", headSha: "b".repeat(40), status: "in_progress", conclusion: "" },
      { event: "workflow_dispatch", headSha: HEAD, status: "in_progress", conclusion: "" },
    ],
  }), "MISSING");
  assert.throws(() => requiredCiState({ headSha: "x", rollupContexts: [], ciRuns: [] }), /REFRESH_PR_CI_INPUT_INVALID/);
});

// #969: required CI(Data contracts 계열)가 실패·취소·시간초과면 그 PR은 이상이다. 열린 지 P1D가 지나서야 드러나지 않게 바로 멈춘다.
test("required CI 상태: Data contracts 계열 check가 실패하면 ATTACHED·PENDING보다 FAILED가 우선한다", () => {
  const failed = (name, conclusion) => requiredCiState({ headSha: HEAD, rollupContexts: [{ name, conclusion, status: "COMPLETED" }], ciRuns: [] });
  for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"]) {
    assert.equal(failed("Data contracts (shard 2/4)", conclusion), "FAILED", conclusion);
    assert.equal(failed("Data contracts", conclusion), "FAILED", conclusion);
  }
  assert.equal(requiredCiState({ headSha: HEAD, rollupContexts: [{ context: "Data contracts", state: "FAILURE" }], ciRuns: [] }), "FAILED");
  assert.equal(requiredCiState({ headSha: HEAD, rollupContexts: [{ context: "Data contracts", state: "ERROR" }], ciRuns: [] }), "FAILED");
  // shard 하나만 실패해도 집계 check가 성공으로 보이는 순간과 무관하게 FAILED다.
  assert.equal(requiredCiState({
    headSha: HEAD,
    rollupContexts: [{ name: "Data contracts", conclusion: "SUCCESS" }, { name: "Data contracts (shard 1/4)", conclusion: "FAILURE" }],
    ciRuns: [{ event: "pull_request", headSha: HEAD, status: "in_progress", conclusion: "" }],
  }), "FAILED");
  // 성공·건너뜀·중립·진행 중과, Data contracts가 아닌 check의 실패는 FAILED가 아니다.
  for (const conclusion of ["SUCCESS", "SKIPPED", "NEUTRAL", ""]) {
    assert.equal(failed("Data contracts (shard 1/4)", conclusion), "MISSING", conclusion);
  }
  assert.equal(failed("CodeQL", "FAILURE"), "MISSING");
  // action_required는 승인 대기로 CI가 안 붙은 경우라 다시 열기 경로(MISSING)로 간다.
  assert.equal(failed("Data contracts (shard 1/4)", "ACTION_REQUIRED"), "MISSING");
});

function fakeGh({ pullRequests, rollup = [], runs = [], failOn = null }) {
  const calls = [];
  const gh = async (args, { token }) => {
    calls.push({ args: args.join(" "), token });
    if (failOn && args.join(" ").startsWith(failOn)) throw new Error(`gh ${failOn} failed`);
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(pullRequests);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ statusCheckRollup: rollup });
    if (args[0] === "run" && args[1] === "list") return JSON.stringify(runs);
    return "";
  };
  return { gh, calls };
}

const openPr = { number: 936, url: `https://github.com/${REPOSITORY}/pull/936`, headRefName: BRANCH, headRefOid: HEAD, baseRefName: "main", isCrossRepository: false };
const input = { workflow: "current-capital-topology-refresh.yml", repository: REPOSITORY, readToken: "read-token", appToken: "app-token" };

test("CI가 없으면 그 PR만 App 토큰으로 닫았다 다시 열고 REOPENED를 돌려준다", async () => {
  const { gh, calls } = fakeGh({ pullRequests: [openPr, { ...openPr, number: 5, headRefName: "feature/x" }] });
  assert.deepEqual(await ensureRefreshPullRequestRequiredCi({ ...input, gh }), { state: "REOPENED", number: 936, headSha: HEAD });
  const writes = calls.filter(({ args }) => /^pr (close|reopen)/u.test(args));
  assert.deepEqual(writes, [
    { args: `pr close 936 --repo ${REPOSITORY} --comment 열린 갱신 PR head에 required CI(pull_request)가 없어 App으로 다시 열어 CI를 실행한다(#939).`, token: "app-token" },
    { args: `pr reopen 936 --repo ${REPOSITORY}`, token: "app-token" },
  ]);
  assert.ok(calls.filter(({ args }) => !/^pr (close|reopen)/u.test(args)).every(({ token }) => token === "read-token"));
  assert.ok(calls.some(({ args }) => args === `run list --repo ${REPOSITORY} --workflow ci.yml --branch ${BRANCH} --event pull_request --limit 100 --json event,headSha,status,conclusion`));
});

test("CI가 붙었거나 진행 중이면 아무 쓰기도 하지 않는다(멱등)", async () => {
  for (const [state, fixture] of [
    ["ATTACHED", { rollup: [{ name: "Data contracts", conclusion: "SUCCESS" }] }],
    ["PENDING", { runs: [{ event: "pull_request", headSha: HEAD, status: "in_progress", conclusion: "" }] }],
  ]) {
    const { gh, calls } = fakeGh({ pullRequests: [openPr], ...fixture });
    assert.deepEqual(await ensureRefreshPullRequestRequiredCi({ ...input, gh }), { state, number: 936, headSha: HEAD });
    assert.equal(calls.some(({ args }) => /^pr (close|reopen)/u.test(args)), false, state);
  }
});

test("열린 갱신 PR이 없거나 둘 이상이거나, 닫기·다시 열기가 실패하면 job을 실패시킨다", async () => {
  await assert.rejects(ensureRefreshPullRequestRequiredCi({ ...input, gh: fakeGh({ pullRequests: [] }).gh }), /REFRESH_PR_CI_PR_MISSING/);
  await assert.rejects(ensureRefreshPullRequestRequiredCi({ ...input, gh: fakeGh({ pullRequests: [openPr, { ...openPr, number: 937, headRefName: `${BRANCH}9` }] }).gh }),
    /REFRESH_PR_CI_PR_DUPLICATE/);
  await assert.rejects(ensureRefreshPullRequestRequiredCi({ ...input, gh: fakeGh({ pullRequests: [openPr], failOn: "pr reopen" }).gh }), /gh pr reopen failed/);
  await assert.rejects(ensureRefreshPullRequestRequiredCi({ ...input, appToken: "", gh: fakeGh({ pullRequests: [openPr] }).gh }), /REFRESH_PR_CI_APP_TOKEN_REQUIRED/);
  await assert.rejects(ensureRefreshPullRequestRequiredCi({ ...input, workflow: "other.yml", gh: fakeGh({ pullRequests: [openPr] }).gh }), /REFRESH_PR_CI_WORKFLOW_INVALID/);
});

test("열린 갱신 PR의 required CI가 실패했으면 쓰기 없이 AUTOMATION_PR_CI_FAILED로 job을 실패시킨다", async () => {
  const { gh, calls } = fakeGh({
    pullRequests: [openPr],
    rollup: [{ name: "Data contracts (shard 2/4)", conclusion: "FAILURE" }, { name: "Data contracts (shard 1/4)", conclusion: "SUCCESS" }],
  });
  await assert.rejects(ensureRefreshPullRequestRequiredCi({ ...input, gh }), (error) => {
    assert.match(error.message, /^AUTOMATION_PR_CI_FAILED: #936 /u);
    assert.match(error.message, /Data contracts \(shard 2\/4\)=FAILURE/u);
    assert.doesNotMatch(error.message, /shard 1\/4/u);
    return true;
  });
  assert.equal(calls.some(({ args }) => /^pr (close|reopen)/u.test(args)), false);
});
