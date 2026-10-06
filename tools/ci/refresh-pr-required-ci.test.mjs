import assert from "node:assert/strict";
import test from "node:test";

import { ensureRefreshPullRequestRequiredCi, requiredCiState } from "./refresh-pr-required-ci.mjs";

// #939·#947 리뷰 F2: 열린 갱신 PR(OPEN_PR)의 head에 pull_request CI가 없으면 App 토큰으로 그 PR만 닫았다 다시 연다.
// reopened 이벤트가 App 행위자로 pull_request CI를 다시 실행한다. 이미 붙었거나 돌고 있으면 아무것도 하지 않는다(멱등).
const HEAD = "a".repeat(40);
const REPOSITORY = "AquilaXk/easysubway-data";
const BRANCH = "automation/636-current-topology-refresh-37209118635";

test("required CI 상태: rollup에 Data contracts가 있으면 ATTACHED, 같은 head의 pull_request CI가 진행 중이면 PENDING, 그 밖은 MISSING", () => {
  assert.equal(requiredCiState({ headSha: HEAD, rollupContexts: [{ name: "Data contracts", status: "COMPLETED", conclusion: "SUCCESS" }], ciRuns: [] }), "ATTACHED");
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
    assert.equal(requiredCiState({ headSha: HEAD, rollupContexts: [], ciRuns: [{ event: "pull_request", headSha: HEAD, status, conclusion: "" }] }), "PENDING", status);
  }
  // 승인 대기로 끝난 run(action_required), 다른 head, dispatch run은 CI가 붙은 것으로 보지 않는다.
  assert.equal(requiredCiState({
    headSha: HEAD,
    rollupContexts: [{ name: "CodeQL", status: "COMPLETED", conclusion: "SUCCESS" }, { context: "Data contracts (shard 1/4)", state: "SUCCESS" }],
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
  // 성공한 shard만 있고 집계 check가 없으면 CI가 다 붙은 것이 아니다(MISSING). Data contracts가 아닌 check의 실패는 보지 않는다.
  assert.equal(failed("Data contracts (shard 1/4)", "SUCCESS"), "MISSING");
  assert.equal(failed("CodeQL", "FAILURE"), "MISSING");
});

// #970 리뷰 F1: 판정은 allow list다. 성공은 SUCCESS만, 진행 중은 알려진 상태만 인정하고 실패는 기존 목록이다.
// 그 밖의 값(STALE·ACTION_REQUIRED·SKIPPED·모르는 값)은 ATTACHED로 조용히 넘어가지 않고 UNKNOWN 이상이다.
test("required CI 상태: 성공이 아니고 실패·진행 중도 아닌 값은 집계·shard 이름 모두 UNKNOWN이다", () => {
  const state = (name, conclusion, status = "COMPLETED") => requiredCiState({ headSha: HEAD, rollupContexts: [{ name, status, conclusion }], ciRuns: [] });
  for (const name of ["Data contracts", "Data contracts (shard 2/4)", "Data contracts (mobile-v19)"]) {
    for (const conclusion of ["STALE", "ACTION_REQUIRED", "SKIPPED", "NEUTRAL", "SOMETHING_NEW", ""]) {
      assert.equal(state(name, conclusion), "UNKNOWN", `${name} ${conclusion}`);
    }
  }
  assert.equal(state("Data contracts", "SUCCESS"), "ATTACHED");
  // status context(state 필드)도 같다. PENDING은 진행 중이고 EXPECTED·모르는 값은 UNKNOWN이다.
  const context = (value) => requiredCiState({ headSha: HEAD, rollupContexts: [{ context: "Data contracts", state: value }], ciRuns: [] });
  assert.equal(context("SUCCESS"), "ATTACHED");
  assert.equal(context("PENDING"), "PENDING");
  assert.equal(context("EXPECTED"), "UNKNOWN");
  assert.equal(context("WHATEVER"), "UNKNOWN");
  // 실패가 모르는 값보다 우선한다.
  assert.equal(requiredCiState({ headSha: HEAD, rollupContexts: [{ name: "Data contracts", status: "COMPLETED", conclusion: "STALE" }, { name: "Data contracts (shard 1/4)", status: "COMPLETED", conclusion: "FAILURE" }], ciRuns: [] }), "FAILED");
});

test("required CI 상태: 진행 중 상태는 알려진 값만 PENDING이고 모르는 상태는 UNKNOWN이다", () => {
  const state = (status) => requiredCiState({ headSha: HEAD, rollupContexts: [{ name: "Data contracts", status, conclusion: "" }], ciRuns: [] });
  for (const status of ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]) assert.equal(state(status), "PENDING", status);
  assert.equal(state("MYSTERY"), "UNKNOWN");
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
    ["ATTACHED", { rollup: [{ name: "Data contracts", status: "COMPLETED", conclusion: "SUCCESS" }] }],
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

test("집계 check의 ACTION_REQUIRED·STALE·모르는 값은 닫았다 다시 열지 않고 AUTOMATION_PR_CI_STATE_UNKNOWN으로 job을 실패시킨다", async () => {
  for (const conclusion of ["ACTION_REQUIRED", "STALE", "SOMETHING_NEW"]) {
    const { gh, calls } = fakeGh({ pullRequests: [openPr], rollup: [{ name: "Data contracts", status: "COMPLETED", conclusion }] });
    await assert.rejects(ensureRefreshPullRequestRequiredCi({ ...input, gh }), (error) => {
      assert.match(error.message, /^AUTOMATION_PR_CI_STATE_UNKNOWN: #936 /u);
      assert.ok(error.message.includes(`Data contracts=${conclusion}`), error.message);
      return true;
    }, conclusion);
    assert.equal(calls.some(({ args }) => /^pr (close|reopen)/u.test(args)), false, conclusion);
  }
});
