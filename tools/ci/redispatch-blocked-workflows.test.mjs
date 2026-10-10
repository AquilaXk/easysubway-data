import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  REDISPATCH_ACTOR,
  REDISPATCH_DAILY_LIMIT,
  REDISPATCH_TARGETS,
  main,
  runRedispatch,
} from "./redispatch-blocked-workflows.mjs";

// #1097: 차단 PR 때문에 BLOCKED_BY_PENDING_PR로 끝난 정기 workflow를 차단이 풀린 뒤 다시 dispatch한다.
// 시나리오는 2026-10-09 실제 사례(ITX 승격 18:00Z 실행이 재결속 PR #1088에 막힘, 원천 재확인이 KRIC 갱신 PR #1083에 막힘)를 그대로 옮긴다.
const REPOSITORY = "AquilaXk/easysubway-data";
const NOW = new Date("2026-10-10T00:10:00.000Z");
const SCHEDULER = "easysubway-release-chain[bot]";
const NOTE_STEPS = Object.fromEntries(REDISPATCH_TARGETS.map(({ workflow, noteSteps }) => [workflow, noteSteps]));

const pull = (number, headRefName, state = "OPEN") => ({
  number, state, headRefName, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY },
});
const run = (id, createdAt, { event = "workflow_dispatch", actor = SCHEDULER, status = "completed", conclusion = "success", branch = "main" } = {}) => ({
  id, event, status, conclusion: status === "completed" ? conclusion : null, head_branch: branch, created_at: createdAt, actor: { login: actor },
});
// blocked: 그 run이 쓰지 않고 끝났는가. note: 몇 번째 note step이 실행됐는가(0 = waiting, 1·2 = superseded).
const jobsWith = (workflow, { blocked, note = 0 }) => ({
  jobs: [{ id: 1, steps: [
    { name: "Decide", conclusion: "success" },
    ...NOTE_STEPS[workflow].map((name, index) => ({ name, conclusion: blocked && index === note ? "success" : "skipped" })),
  ] }],
});

/** GitHub API를 흉내 낸다. workflow별 run 목록과 run별 job 목록을 돌려주고 dispatch를 기록한다. */
function fixture({ runs = {}, jobs = {}, pullRequests = [], automationBranches = [] }) {
  const state = { runs: structuredClone(runs), dispatched: [], requests: [], nextRunId: 9000 };
  const api = async (endpoint) => {
    state.requests.push(endpoint);
    const listing = /^repos\/[^/]+\/[^/]+\/actions\/workflows\/([a-z0-9-]+\.yml)\/runs\?/u.exec(endpoint);
    if (listing) return { workflow_runs: state.runs[listing[1]] ?? [] };
    const jobsMatch = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs\?/u.exec(endpoint);
    if (jobsMatch) {
      assert.ok(Object.hasOwn(jobs, jobsMatch[1]), `unexpected jobs request ${endpoint}`);
      return jobs[jobsMatch[1]];
    }
    throw new Error(`unexpected request ${endpoint}`);
  };
  // dispatch는 실제처럼 새 run을 만든다(github-actions[bot]이 시작한 workflow_dispatch).
  const dispatchWorkflow = async (workflow) => {
    state.dispatched.push(workflow);
    state.nextRunId += 1;
    state.runs[workflow] = [run(state.nextRunId, NOW.toISOString(), { actor: REDISPATCH_ACTOR, status: "queued" }), ...(state.runs[workflow] ?? [])];
  };
  const input = { repository: REPOSITORY, pullRequests, automationBranches, api, dispatchWorkflow, now: NOW, sleep: async () => {}, log: () => {} };
  return { state, input };
}

const ITX = "itx-current-promotion.yml";
const REVERIFICATION = "source-reverification.yml";
const ITX_BLOCKED_RUN = 37970208675;

test("2026-10-09 ITX: 18:00Z 정기 실행이 재결속 PR #1088에 막혔다가 그 PR이 병합되면 ITX 승격을 한 번 다시 dispatch한다", async () => {
  const { state, input } = fixture({
    runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
    pullRequests: [pull(1088, "automation/969-derivative-rebinding-37962000000", "MERGED")],
  });
  const result = await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX]);
  assert.deepEqual(result.find(({ workflow }) => workflow === ITX), { workflow: ITX, action: "DISPATCH", blockedRunId: ITX_BLOCKED_RUN });
});

test("차단 PR이 닫히기만 해도(병합 아님) 차단 대상이 비면 다시 dispatch한다", async () => {
  const { state, input } = fixture({
    runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
    pullRequests: [pull(1088, "automation/969-derivative-rebinding-37962000000", "CLOSED")],
  });
  await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX]);
});

test("차단 PR이 아직 열려 있으면 dispatch하지 않고 기다린다(차단 PR 번호를 남긴다)", async () => {
  const { state, input } = fixture({
    runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
    pullRequests: [pull(1088, "automation/969-derivative-rebinding-37962000000", "OPEN")],
  });
  const result = await runRedispatch(input);
  assert.deepEqual(state.dispatched, []);
  assert.deepEqual(result.find(({ workflow }) => workflow === ITX), { workflow: ITX, action: "WAIT", blockedBy: [1088] });
});

test("원천 재확인: KRIC 갱신 PR #1083이 열려 있는 동안은 기다리고, 병합된 뒤 다시 dispatch한다", async () => {
  const blockedRun = 37990000001;
  const base = {
    runs: { [REVERIFICATION]: [run(blockedRun, "2026-10-09T17:23:00Z")] },
    jobs: { [blockedRun]: jobsWith(REVERIFICATION, { blocked: true }) },
  };
  const waiting = fixture({ ...base, pullRequests: [pull(1083, "automation/629-kric-facility-refresh-37989000000")] });
  assert.deepEqual((await runRedispatch(waiting.input)).find(({ workflow }) => workflow === REVERIFICATION), { workflow: REVERIFICATION, action: "WAIT", blockedBy: [1083] });
  assert.deepEqual(waiting.state.dispatched, []);
  const merged = fixture({ ...base, pullRequests: [pull(1083, "automation/629-kric-facility-refresh-37989000000", "MERGED")] });
  await runRedispatch(merged.input);
  assert.deepEqual(merged.state.dispatched, [REVERIFICATION]);
});

test("PR 없는 claim 브랜치도 원장 쓰기 대기다: 재확인은 claim 브랜치가 사라질 때까지 기다린다(ITX는 열린 PR만 본다)", async () => {
  const claim = "automation/456-capital-topology-registration-37988000000";
  const blockedRun = 37990000002;
  const reverify = fixture({
    runs: { [REVERIFICATION]: [run(blockedRun, "2026-10-09T17:23:00Z")] },
    jobs: { [blockedRun]: jobsWith(REVERIFICATION, { blocked: true }) },
    automationBranches: [claim],
  });
  assert.deepEqual((await runRedispatch(reverify.input)).find(({ workflow }) => workflow === REVERIFICATION), { workflow: REVERIFICATION, action: "WAIT", blockedBy: [claim] });
  const itx = fixture({
    runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
    automationBranches: [claim],
  });
  await runRedispatch(itx.input);
  assert.deepEqual(itx.state.dispatched, [ITX], "ITX 판정(pendingLedgerWriterPullRequests)은 claim 브랜치를 차단으로 보지 않는다");
});

test("가장 최근 run이 막히지 않았으면(정상 실행·대기 없음) dispatch하지 않는다", async () => {
  const { state, input } = fixture({
    runs: { [ITX]: [run(37998529320, "2026-10-09T22:18:57Z", { event: "schedule", actor: "github-actions[bot]" }), run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { 37998529320: jobsWith(ITX, { blocked: false }) },
  });
  await runRedispatch(input);
  assert.deepEqual(state.dispatched, []);
  assert.equal(state.requests.some((endpoint) => endpoint.includes(`/runs/${ITX_BLOCKED_RUN}/jobs`)), false, "이미 지난 run의 job은 읽지 않는다");
});

test("진행 중이거나 대기열에 있는 run이 있으면 dispatch하지 않는다", async () => {
  for (const status of ["queued", "in_progress", "waiting"]) {
    const { state, input } = fixture({
      runs: { [ITX]: [run(9100, "2026-10-09T23:59:00Z", { actor: REDISPATCH_ACTOR, status }), run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
      jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
    });
    const result = await runRedispatch(input);
    assert.deepEqual(state.dispatched, [], status);
    assert.deepEqual(result.find(({ workflow }) => workflow === ITX), { workflow: ITX, action: "SKIP", reason: "RUN_IN_PROGRESS" }, status);
    assert.equal(state.requests.some((endpoint) => endpoint.includes("/jobs")), false, "진행 중인 run의 job은 읽지 않는다");
  }
});

test("실패한 run과 조건에 걸려 건너뛴 run은 막힌 run이 아니다(실패는 실패 이슈 경로가 맡는다)", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    const { state, input } = fixture({ runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z", { conclusion })] } });
    await runRedispatch(input);
    assert.deepEqual(state.dispatched, [], conclusion);
  }
});

test("main이 아닌 ref와 정기·dispatch 외 이벤트의 run은 보지 않는다", async () => {
  const { state, input } = fixture({
    runs: { [ITX]: [
      run(9201, "2026-10-09T23:00:00Z", { branch: "feature" }),
      run(9202, "2026-10-09T23:30:00Z", { event: "pull_request" }),
      run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z"),
    ] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
  });
  await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX]);
});

test("dispatch가 새 run을 만든 뒤 다시 실행해도 중복 dispatch하지 않는다(진행 중 run이 있다)", async () => {
  const { state, input } = fixture({
    runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
  });
  await runRedispatch(input);
  await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX]);
});

test("다시 깨운 run이 또 막혀도 상한(24시간 3회)까지만 반복하고, 넘으면 dispatch 없이 이름 있는 코드로 실패한다", async () => {
  assert.equal(REDISPATCH_DAILY_LIMIT, 3);
  const redispatched = (id, at) => run(id, at, { actor: REDISPATCH_ACTOR });
  const runs = [
    redispatched(9303, "2026-10-09T23:40:00Z"),
    redispatched(9302, "2026-10-09T22:40:00Z"),
    redispatched(9301, "2026-10-09T21:40:00Z"),
    run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z"),
  ];
  // 각 재dispatch의 바로 앞 run이 쓰지 않고 끝났다 = 막힘 -> 재dispatch -> 막힘 루프.
  const jobs = { 9303: jobsWith(ITX, { blocked: true }), 9302: jobsWith(ITX, { blocked: true }), 9301: jobsWith(ITX, { blocked: true }), [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) };
  const { state, input } = fixture({ runs: { [ITX]: runs }, jobs });
  await assert.rejects(runRedispatch(input), /REDISPATCH_LIMIT: itx-current-promotion\.yml .*3/u);
  assert.deepEqual(state.dispatched, []);
  // 24시간보다 오래된 재dispatch는 세지 않는다.
  const aged = fixture({ runs: { [ITX]: [redispatched(9303, "2026-10-09T23:40:00Z"), redispatched(9302, "2026-10-09T22:40:00Z"), redispatched(9301, "2026-10-08T23:00:00Z")] }, jobs: { 9303: jobsWith(ITX, { blocked: true }), 9302: jobsWith(ITX, { blocked: true }), 9301: jobsWith(ITX, { blocked: true }) } });
  await runRedispatch(aged.input);
  assert.deepEqual(aged.state.dispatched, [ITX]);
});

// #1097 리뷰 F3: 상한은 막힘 -> 재dispatch -> 막힘 루프만 센다. 정상 dispatch(일을 한 run 뒤, 뒤처진 PR 재생성 경로)가 하루에 몰려도 거짓 경보를 내지 않는다.
test("상한은 막힌 run 바로 뒤의 github-actions[bot] dispatch만 센다(일을 한 run 뒤의 dispatch는 세지 않는다)", async () => {
  const redispatched = (id, at) => run(id, at, { actor: REDISPATCH_ACTOR });
  const runs = [
    redispatched(9304, "2026-10-09T23:50:00Z"),
    redispatched(9303, "2026-10-09T23:40:00Z"),
    redispatched(9302, "2026-10-09T22:40:00Z"),
    redispatched(9301, "2026-10-09T21:40:00Z"),
    run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z"),
  ];
  // 9304만 막혔고(최신), 나머지 dispatch의 앞 run은 모두 정상 실행(일을 했거나 NOT_DUE)이었다.
  const jobs = { 9304: jobsWith(ITX, { blocked: true }), 9303: jobsWith(ITX, { blocked: false }), 9302: jobsWith(ITX, { blocked: false }), 9301: jobsWith(ITX, { blocked: false }), [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: false }) };
  const { state, input } = fixture({ runs: { [ITX]: runs }, jobs });
  const result = await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX]);
  assert.equal(result.find(({ workflow }) => workflow === ITX).action, "DISPATCH");
  // 앞 run이 success가 아니면(실패·취소) 막힘 루프가 아니다.
  const failedBefore = fixture({ runs: { [ITX]: [redispatched(9304, "2026-10-09T23:50:00Z"), run(9303, "2026-10-09T23:40:00Z", { conclusion: "failure" }), redispatched(9302, "2026-10-09T22:40:00Z"), run(9301, "2026-10-09T21:40:00Z", { conclusion: "cancelled" })] }, jobs: { 9304: jobsWith(ITX, { blocked: true }) } });
  await runRedispatch(failedBefore.input);
  assert.deepEqual(failedBefore.state.dispatched, [ITX]);
});

test("상한에 닿은 workflow가 있어도 다음 우선순위 workflow의 재dispatch는 끝낸 뒤 실패한다", async () => {
  const redispatched = (id, at) => run(id, at, { actor: REDISPATCH_ACTOR });
  const blockedRun = 37990000003;
  const itxBlocked = (id) => [id, jobsWith(ITX, { blocked: true })];
  const { state, input } = fixture({
    runs: {
      [ITX]: [redispatched(9303, "2026-10-09T23:40:00Z"), redispatched(9302, "2026-10-09T22:40:00Z"), redispatched(9301, "2026-10-09T21:40:00Z"), run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")],
      [REVERIFICATION]: [run(blockedRun, "2026-10-09T17:23:00Z")],
    },
    jobs: { ...Object.fromEntries([9303, 9302, 9301, ITX_BLOCKED_RUN].map(itxBlocked)), [blockedRun]: jobsWith(REVERIFICATION, { blocked: true }) },
  });
  await assert.rejects(runRedispatch(input), /REDISPATCH_LIMIT: itx-current-promotion\.yml/u);
  assert.deepEqual(state.dispatched, [REVERIFICATION]);
});

// #1097 리뷰 F1: 한 sweep은 쓰기 workflow를 최대 하나만 깨운다. 병합 하나가 여러 대상을 한꺼번에 풀어도 우선순위(ITX > 재확인 > 등록 > 재결속)대로 하나씩 처리한다.
const REGISTRATION = "current-capital-topology-registration.yml";
const REBINDING = "source-derivative-rebinding.yml";
const allBlocked = () => {
  const ids = { [ITX]: 41000, [REVERIFICATION]: 42000, [REGISTRATION]: 43000, [REBINDING]: 44000 };
  return {
    runs: Object.fromEntries(Object.entries(ids).map(([workflow, id]) => [workflow, [run(id, "2026-10-09T18:00:04Z")]])),
    jobs: Object.fromEntries(Object.entries(ids).map(([workflow, id]) => [id, jobsWith(workflow, { blocked: true })])),
  };
};

test("우선순위 표는 ITX > 원천 재확인 > 수도권 등록 > 파생 재결속이다", () => {
  assert.deepEqual(REDISPATCH_TARGETS.map(({ workflow }) => workflow), [ITX, REVERIFICATION, REGISTRATION, REBINDING]);
});

test("모든 대상이 한꺼번에 풀려도 sweep 하나는 우선순위가 가장 높은 workflow 하나만 dispatch하고 나머지는 미룬다", async () => {
  const { state, input } = fixture(allBlocked());
  const result = await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX]);
  assert.deepEqual(result.map(({ workflow, action, reason, by }) => ({ workflow, action, reason, by })), [
    { workflow: ITX, action: "DISPATCH", reason: undefined, by: undefined },
    { workflow: REVERIFICATION, action: "DEFER", reason: "ANOTHER_DISPATCHED", by: ITX },
    { workflow: REGISTRATION, action: "DEFER", reason: "ANOTHER_DISPATCHED", by: ITX },
    { workflow: REBINDING, action: "DEFER", reason: "ANOTHER_DISPATCHED", by: ITX },
  ]);
  // 다음 sweep: 먼저 dispatch한 run이 아직 진행 중이면 아무것도 깨우지 않는다.
  const second = await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX]);
  assert.deepEqual(second.filter(({ action }) => action === "DEFER").map(({ workflow, reason, by }) => ({ workflow, reason, by })), [
    { workflow: REVERIFICATION, reason: "RUN_ACTIVE", by: ITX },
    { workflow: REGISTRATION, reason: "RUN_ACTIVE", by: ITX },
    { workflow: REBINDING, reason: "RUN_ACTIVE", by: ITX },
  ]);
  // 그 run이 PR 없이 끝나면(정상 완료, 막히지 않음) 다음 우선순위가 이어서 처리된다.
  state.runs[ITX][0] = { ...state.runs[ITX][0], status: "completed", conclusion: "success" };
  input.api = ((original) => async (endpoint) => {
    const match = /\/runs\/(\d+)\/jobs/u.exec(endpoint);
    if (match && Number(match[1]) === state.runs[ITX][0].id) return jobsWith(ITX, { blocked: false });
    return original(endpoint);
  })(input.api);
  await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX, REVERIFICATION]);
});

test("진행 중인 대상 run이 하나라도 있으면(다른 대상의 run이어도) 아무것도 dispatch하지 않는다", async () => {
  const fixtureInput = allBlocked();
  delete fixtureInput.runs[ITX];
  fixtureInput.runs[ITX] = [run(41500, "2026-10-10T00:05:00Z", { status: "in_progress" })];
  const { state, input } = fixture(fixtureInput);
  const result = await runRedispatch(input);
  assert.deepEqual(state.dispatched, []);
  assert.deepEqual(result.filter(({ action }) => action === "DEFER").map(({ workflow, by }) => [workflow, by]), [[REVERIFICATION, ITX], [REGISTRATION, ITX], [REBINDING, ITX]]);
});

test("우선순위가 높은 대상이 아직 차단 중이면 다음 우선순위 대상이 dispatch된다", async () => {
  const { state, input } = fixture({ ...allBlocked(), pullRequests: [pull(1088, "automation/969-derivative-rebinding-37962000000", "OPEN")] });
  // 열린 재결속 PR은 ITX·재확인·등록을 막는다(재결속 자신은 막지 않는다).
  const result = await runRedispatch(input);
  assert.deepEqual(state.dispatched, [REBINDING]);
  assert.deepEqual(result.map(({ workflow, action }) => [workflow, action]), [[ITX, "WAIT"], [REVERIFICATION, "WAIT"], [REGISTRATION, "WAIT"], [REBINDING, "DISPATCH"]]);
});

// #1097 리뷰 F2: 재확인·재결속이 push 직전 재확인에서 새 원장 쓰기 자동화를 만나거나 main이 움직여 올리지 않고 끝나도 같은 슬롯 손실이다.
test("superseded note로 쓰지 않고 끝난 재확인·재결속 run도 막힌 run으로 보고 차단이 풀리면 다시 dispatch한다", async () => {
  for (const [workflow, id] of [[REVERIFICATION, 42000], [REBINDING, 44000]]) {
    for (const note of [1, 2]) {
      const { state, input } = fixture({ runs: { [workflow]: [run(id, "2026-10-09T17:23:00Z")] }, jobs: { [id]: jobsWith(workflow, { blocked: true, note }) } });
      await runRedispatch(input);
      assert.deepEqual(state.dispatched, [workflow], `${workflow} note ${note}`);
    }
  }
  // superseded 뒤에도 그 원장 쓰기 PR이 아직 열려 있으면 기다린다.
  const waiting = fixture({
    runs: { [REVERIFICATION]: [run(42000, "2026-10-09T17:23:00Z")] },
    jobs: { 42000: jobsWith(REVERIFICATION, { blocked: true, note: 1 }) },
    pullRequests: [pull(1083, "automation/629-kric-facility-refresh-37989000000")],
  });
  const result = await runRedispatch(waiting.input);
  assert.deepEqual(waiting.state.dispatched, []);
  assert.deepEqual(result.find(({ workflow }) => workflow === REVERIFICATION), { workflow: REVERIFICATION, action: "WAIT", blockedBy: [1083] });
  // 일을 한 run·이미 최신인 run(note가 모두 건너뜀)은 막힌 run이 아니다.
  const done = fixture({ runs: { [REVERIFICATION]: [run(42000, "2026-10-09T17:23:00Z")] }, jobs: { 42000: jobsWith(REVERIFICATION, { blocked: false }) } });
  await runRedispatch(done.input);
  assert.deepEqual(done.state.dispatched, []);
});

test("후보 갱신은 대상이 아니다: github.token dispatch는 정기 역할을 받지 못하고 스케줄러가 2시간마다 다시 깨운다", () => {
  assert.equal(REDISPATCH_TARGETS.some(({ workflow }) => workflow === "nationwide-candidate-refresh.yml"), false);
  assert.deepEqual(REDISPATCH_TARGETS.map(({ workflow }) => workflow).sort(), [
    "current-capital-topology-registration.yml",
    "itx-current-promotion.yml",
    "source-derivative-rebinding.yml",
    "source-reverification.yml",
  ]);
});

test("run 목록 조회가 실패하면 모른 채 덮지 않고 그대로 실패한다", async () => {
  const { input } = fixture({});
  input.api = async () => { throw new Error("gh api failed: HTTP 502"); };
  await assert.rejects(runRedispatch(input), /HTTP 502/u);
});

test("run 응답 형식이 어긋나면 실패한다", async () => {
  const { input } = fixture({});
  input.api = async () => ({ workflow_runs: "nope" });
  await assert.rejects(runRedispatch(input), /REDISPATCH_RUNS_INVALID/u);
  const jobsBroken = fixture({ runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] }, jobs: { [ITX_BLOCKED_RUN]: { jobs: "nope" } } });
  await assert.rejects(runRedispatch(jobsBroken.input), /REDISPATCH_JOBS_INVALID/u);
});

test("dispatch 요청이 실패하면 성공으로 덮지 않고 실패한다", async () => {
  const { input } = fixture({
    runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
  });
  input.dispatchWorkflow = async () => { throw new Error("gh workflow run failed: HTTP 403"); };
  await assert.rejects(runRedispatch(input), /HTTP 403/u);
});

test("dispatch한 run이 잠시 목록에 보이지 않아도 기다렸다가 확인한다(보이지 않으면 경고만)", async () => {
  const { state, input } = fixture({
    runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
  });
  const created = input.dispatchWorkflow;
  const logs = [];
  input.log = (line) => logs.push(line);
  let delayed = 0;
  input.dispatchWorkflow = async (workflow) => {
    await created(workflow);
    state.hidden = state.runs[workflow].shift();
  };
  input.sleep = async () => {
    delayed += 1;
    if (delayed === 2) state.runs[ITX].unshift(state.hidden);
  };
  await runRedispatch(input);
  assert.deepEqual(state.dispatched, [ITX]);
  assert.equal(delayed, 2);
  assert.equal(logs.some((line) => /not visible/u.test(line)), false);

  const never = fixture({
    runs: { [ITX]: [run(ITX_BLOCKED_RUN, "2026-10-09T18:00:04Z")] },
    jobs: { [ITX_BLOCKED_RUN]: jobsWith(ITX, { blocked: true }) },
  });
  const neverLogs = [];
  never.input.log = (line) => neverLogs.push(line);
  const neverCreated = never.input.dispatchWorkflow;
  never.input.dispatchWorkflow = async (workflow) => { await neverCreated(workflow); never.state.runs[workflow].shift(); };
  await runRedispatch(never.input);
  assert.equal(neverLogs.some((line) => /::warning title=Blocked redispatch::.*not visible/u.test(line)), true);
});

test("CLI는 인자가 어긋나면 실패하고, 입력 파일로 판정해 gh로 dispatch한다", async () => {
  await assert.rejects(main(["--repository", REPOSITORY]), /REDISPATCH_ARGUMENTS/u);
  await assert.rejects(main(["--repository", "not a repo", "--refs", "a", "--prs", "b"]), /REDISPATCH_ARGUMENTS/u);
});

test("대상 표는 workflow 파일의 note step과 판정 도구가 쓰는 차단 함수와 일치한다(표만 고치면 실패)", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const decideFiles = {
    "itx-current-promotion.yml": ["decide-itx-current-promotion.mjs", "pendingLedgerWriterPullRequests"],
    "current-capital-topology-registration.yml": ["decide-capital-topology-registration.mjs", "pendingLedgerWriterPullRequests"],
    "source-reverification.yml": ["decide-source-reverification.mjs", "pendingLedgerWriters"],
    "source-derivative-rebinding.yml": ["decide-derivative-rebinding.mjs", "pendingLedgerWriters"],
  };
  for (const { workflow, noteSteps, blockers } of REDISPATCH_TARGETS) {
    const yml = readFileSync(path.join(root, ".github/workflows", workflow), "utf8");
    const blocks = yml.split("\n      - name: ").slice(1);
    const find = (name) => blocks.find((candidate) => candidate.split("\n")[0] === name);
    const [waiting, ...superseded] = noteSteps;
    assert.ok(find(waiting), `${workflow}: step "${waiting}"`);
    assert.match(find(waiting), /\n        if: \$\{\{ steps\.decision\.outputs\.state == 'BLOCKED_BY_PENDING_PR' \}\}\n/u, `${workflow}: waiting note runs only for BLOCKED_BY_PENDING_PR`);
    // superseded note: 쓰지 않고 끝났다는 알림이다. push 직전 재확인(idle == 'false')이나 main 이동(pushed == 'false') 조건이다.
    for (const name of superseded) {
      const block = find(name);
      assert.ok(block, `${workflow}: step "${name}"`);
      assert.match(block, /\n        if: \$\{\{ [^\n]*(?:steps\.recheck\.outputs\.idle == 'false'|steps\.push\.outputs\.pushed == 'false')[^\n]* \}\}\n/u, `${workflow}: "${name}" condition`);
      assert.match(block, /nothing was pushed|was dropped/u, `${workflow}: "${name}" says nothing was pushed`);
    }
    // 이 workflow에서 쓰지 않고 끝나는 note는 표가 전부 알고 있어야 한다: 'nothing was pushed'/'dropped' 계열 note step 수와 표가 같다.
    const droppedNotes = blocks.filter((block) => /\n        if: [^\n]*(?:steps\.recheck\.outputs\.idle == 'false'|steps\.push\.outputs\.pushed == 'false')/u.test(block)).map((block) => block.split("\n")[0]);
    assert.deepEqual(droppedNotes.sort(), [...superseded].sort(), `${workflow}: every note that ends a run without writing is in the table`);
    const [decideFile, fn] = decideFiles[workflow];
    const decide = readFileSync(path.join(root, "tools/ci", decideFile), "utf8");
    assert.match(decide, new RegExp(String.raw`${fn}\(`, "u"), `${workflow}: ${decideFile} blocks on ${fn}`);
    assert.equal(blockers, fn === "pendingLedgerWriters" ? "pull-requests-and-claims" : "pull-requests", workflow);
    // 이 workflow에서 BLOCKED_BY_PENDING_PR를 내는 곳은 note step 하나뿐이어야 막힌 run을 note step으로 알아볼 수 있다.
    assert.equal(yml.split("outputs.state == 'BLOCKED_BY_PENDING_PR'").length - 1, 1, `${workflow}: a single BLOCKED_BY_PENDING_PR consumer`);
  }
});
