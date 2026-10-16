import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { decideItxCurrentPromotion } from "./decide-itx-current-promotion.mjs";
import {
  guardItxCurrentCollectionBudget,
  probeItxCollectionToday,
  readItxCollectionLedger,
  runItxCollectionLedgerCli,
  runItxCurrentCollectionBudgetGuardCli,
} from "./guard-itx-current-collection-budget.mjs";
import { writeFailedRunArtifact, writeKasiFailureArtifact } from "./test-fixtures/itx-failed-run-artifact.mjs";

// 2026-10-16 18:00Z 승격 run 38943966334가 TAGO 장애로 실패한 뒤의 같은 KST 날(2026-10-17)을 재현한다.
const REPOSITORY = "AquilaXk/easysubway-data";
const FAILED_RUN = 38943966334;
const CURRENT_RUN = 38952684012;
const NOW = new Date("2026-10-16T19:08:25.000Z");
const COLLECTOR_ENDED_AT = "2026-10-16T18:52:15.000Z";
const PROMOTION = { file: "itx-current-promotion.yml", job: "ITX current promotion", step: "Collect current ITX timetable", artifact: "itx-current-promotion" };
const TOPOLOGY = { file: "current-capital-topology-refresh.yml", job: "Current topology refresh", step: "Collect current ITX timetable once", artifact: "current-capital-topology-refresh-itx-review" };

const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ID: String(CURRENT_RUN),
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_TOKEN: "synthetic-github-token-that-must-not-leak",
  ...overrides,
});
// run.updated_at은 일부러 collector step 종료(18:52:15Z)보다 늦게 둔다: 종료 시각은 step의 completed_at이어야 한다.
const run = (id, context, overrides = {}) => ({
  id, status: "completed", created_at: "2026-10-16T18:00:07Z", updated_at: "2026-10-16T19:30:00Z", event: "workflow_dispatch", head_branch: "main", run_attempt: 1,
  path: `.github/workflows/${context.file}`, ...overrides,
});
const currentRun = () => run(CURRENT_RUN, PROMOTION, { status: "in_progress", created_at: "2026-10-16T19:08:25Z" });
const job = (runId, context, conclusion, { status = "completed", completedAt = "2026-10-16T18:52:15Z" } = {}) => ({
  id: runId + 10_000, run_id: runId, name: context.job, status, conclusion: "failure",
  steps: [{ name: context.step, status, conclusion, ...(status === "completed" ? { completed_at: completedAt } : {}) }],
});

/**
 * runs: 승격 workflow의 dispatch run, topologyRuns: topology 갱신의 schedule run, jobs: run id별 job 목록,
 * artifacts: run id별 증거 artifact를 directory에 쓰는 함수(없으면 artifact 없음).
 */
function github({ runs = [], topologyRuns = [], jobs = {}, artifacts = {} }) {
  const downloads = [];
  const fetchImpl = async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith("/runs")) {
      const file = request.pathname.split("/").at(-2);
      const selected = request.searchParams.get("event") === "workflow_dispatch" && file === PROMOTION.file ? runs
        : request.searchParams.get("event") === "schedule" && file === TOPOLOGY.file ? topologyRuns : [];
      return Response.json({ total_count: selected.length, workflow_runs: selected });
    }
    const match = request.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/u);
    if (match) {
      const found = jobs[match[1]] ?? [];
      return Response.json({ total_count: found.length, jobs: found });
    }
    return new Response("{}", { status: 404 });
  };
  const downloadArtifact = async (args) => {
    downloads.push(args);
    const populate = artifacts[args.runId];
    if (populate === undefined) throw new Error("no artifact");
    await populate(args.directory);
  };
  return { fetchImpl, downloadArtifact, downloads };
}
const options = (fixture, overrides = {}) => {
  const { fetchImpl, downloadArtifact } = github(fixture);
  return { env: env(), now: NOW, fetchImpl, downloadArtifact, ...overrides };
};

// 앞선 실패 run마다 보낸 요청 수(requestCounts)로 같은 날의 실패 기록을 만든다. capture는 run 하나에 4,000건까지만 담는다.
const failedPriorRuns = (requestCounts) => {
  const ids = requestCounts.map((_, index) => FAILED_RUN + index);
  return {
    runs: [...ids.map((id) => run(id, PROMOTION)), currentRun()],
    jobs: Object.fromEntries(ids.map((id) => [id, [job(id, PROMOTION, "failure")]])),
    artifacts: Object.fromEntries(ids.map((id, index) => [id, (directory) => writeFailedRunArtifact(directory, { requestCount: requestCounts[index], transportFailures: 3 })])),
  };
};
const failedPriorRun = (requestCount = 810) => failedPriorRuns([requestCount]);
const ledgerOf = (fixture, overrides = {}) => readItxCollectionLedger(options(fixture, overrides));

const contract = { sourceTimetableArtifact: { status: "ADMITTED", freshUntil: "2026-10-18T00:00:00+09:00" } };
const decideAt = (now, entries, force = false) => decideItxCurrentPromotion({
  now, contract, pullRequests: [], branches: [], repository: REPOSITORY, limits: { pullRequests: 1000 }, force, collectionEntries: entries,
});
const stateOf = (decision) => (({ state, reason }) => ({ state, reason }))(decision);

test("장애 재현(RED): 같은 날 실패 run은 ledger에 FAILED·요청 810건·collector 종료 시각으로 남고 판정은 재수집을 허용한다", async () => {
  const ledger = await ledgerOf(failedPriorRun());
  assert.equal(ledger.quotaWindow, "2026-10-17");
  assert.deepEqual(ledger.entries, [{ runId: FAILED_RUN, workflowFile: PROMOTION.file, outcome: "FAILED", endedAt: COLLECTOR_ENDED_AT, requestCount: 810 }]);
  // 이전 코드는 이 상황을 ITX_COLLECTED_TODAY로 막았다(만료 전에 재수집할 방법이 없었다).
  // 사람 force는 최소 간격 없이 바로(19:08Z), force 없는 정기 실행은 간격(2시간)이 지난 뒤 재수집한다.
  assert.deepEqual(stateOf(decideAt(NOW, ledger.entries, true)), { state: "COLLECT", reason: "SAFETY_LEAD" });
  assert.deepEqual(stateOf(decideAt(NOW, ledger.entries)), { state: "WAIT", reason: "ITX_RETRY_TOO_SOON" });
  assert.equal(decideAt(new Date("2026-10-16T20:52:15.000Z"), ledger.entries).state, "COLLECT");
  assert.equal(decideAt(new Date("2026-10-16T22:30:00.000Z"), ledger.entries).state, "COLLECT");
});

test("성공했거나 진행 중인 수집은 SUCCEEDED·RUNNING이고 artifact를 읽지 않는다. 판정은 ITX_COLLECTED_TODAY로 대기한다", async () => {
  for (const [conclusion, jobOptions, outcome] of [["success", {}, "SUCCEEDED"], [null, { status: "in_progress" }, "RUNNING"]]) {
    const fixture = { runs: [run(FAILED_RUN, PROMOTION), currentRun()], jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, conclusion, jobOptions)] } };
    const { fetchImpl, downloadArtifact, downloads } = github(fixture);
    const ledger = await readItxCollectionLedger({ env: env(), now: NOW, fetchImpl, downloadArtifact });
    assert.deepEqual(ledger.entries, [{ runId: FAILED_RUN, workflowFile: PROMOTION.file, outcome, endedAt: null, requestCount: null }]);
    assert.equal(downloads.length, 0, outcome);
    assert.deepEqual(stateOf(decideAt(NOW, ledger.entries, true)), { state: "WAIT", reason: "ITX_COLLECTED_TODAY" });
  }
});

// F4: collector step은 이미 실패했지만 run이 아직 끝나지 않았다(always() 증거 업로드 step이 도는 중). 업로드 전에는 요청 수를 증명할 수 없다.
test("run이 끝나기 전에는 collector step이 실패했어도 RUNNING이라 artifact를 읽지 않고 대기한다. 끝난 뒤에는 요청 수로 판정한다", async () => {
  const inFlight = { ...failedPriorRun(), runs: [run(FAILED_RUN, PROMOTION, { status: "in_progress" }), currentRun()] };
  const { fetchImpl, downloadArtifact, downloads } = github(inFlight);
  const racing = await readItxCollectionLedger({ env: env(), now: NOW, fetchImpl, downloadArtifact });
  assert.deepEqual(racing.entries, [{ runId: FAILED_RUN, workflowFile: PROMOTION.file, outcome: "RUNNING", endedAt: null, requestCount: null }]);
  assert.equal(downloads.length, 0);
  assert.deepEqual(stateOf(decideAt(NOW, racing.entries, true)), { state: "WAIT", reason: "ITX_COLLECTED_TODAY" });
  // 수집 직전 가드도 같은 이유로 막는다. 증거 없음 실패가 아니라 진행 중으로 본다.
  await assert.rejects(() => guardItxCurrentCollectionBudget({ ...options(inFlight), allowAfterFailure: true }), /quota guard failed/u);
  // 같은 run이 끝나면(status completed) 실제 요청 수로 판정한다.
  assert.equal((await ledgerOf(failedPriorRun())).entries[0].requestCount, 810);
  // 아직 시작하지 않은(queued) run의 collector step이 skipped여도 기록에 넣지 않는다.
  const queued = { runs: [run(FAILED_RUN, PROMOTION, { status: "queued" }), currentRun()], jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, "skipped")] } };
  assert.deepEqual((await ledgerOf(queued)).entries, []);
});

test("종료 시각은 run.updated_at이 아니라 collector step의 completed_at이다. 없으면 null이다", async () => {
  const fixture = failedPriorRun();
  fixture.jobs[FAILED_RUN] = [job(FAILED_RUN, PROMOTION, "failure", { completedAt: "2026-10-16T17:00:00Z" })];
  assert.equal((await ledgerOf(fixture)).entries[0].endedAt, "2026-10-16T17:00:00.000Z");
  fixture.jobs[FAILED_RUN] = [job(FAILED_RUN, PROMOTION, "failure", { completedAt: null })];
  const noEnd = (await ledgerOf(fixture)).entries[0];
  assert.equal(noEnd.endedAt, null);
  assert.throws(() => decideAt(NOW, [noEnd]), /ITX_COLLECTION_EVIDENCE_MISSING/u);
});

test("collector step이 skipped인 run은 공급자를 부르지 않았으므로 기록에 넣지 않는다", async () => {
  const fixture = { runs: [run(FAILED_RUN, PROMOTION), currentRun()], jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, "skipped")] } };
  assert.deepEqual((await ledgerOf(fixture)).entries, []);
});

test("KASI 휴일 조회 실패로 끝난 run은 TAGO 요청 0건으로 기록한다", async () => {
  const fixture = { ...failedPriorRun(), artifacts: { [FAILED_RUN]: writeKasiFailureArtifact } };
  assert.equal((await ledgerOf(fixture)).entries[0].requestCount, 0);
});

test("증거를 읽을 수 없는 실패 run은 null로 남고, 판정은 ITX_COLLECTION_EVIDENCE_MISSING으로 실패한다 (fail-closed)", async () => {
  const missing = await ledgerOf({ ...failedPriorRun(), artifacts: {} });
  assert.deepEqual(missing.entries.map(({ requestCount, endedAt }) => ({ requestCount, endedAt })), [{ requestCount: null, endedAt: COLLECTOR_ENDED_AT }]);
  assert.throws(() => decideAt(NOW, missing.entries), /ITX_COLLECTION_EVIDENCE_MISSING/u);
});

// F1: topology 갱신도 실패해도 capture를 올리므로(current-capital-topology-refresh-itx-review-<run id>) 쓴 요청 수를 증명할 수 있다.
test("topology 갱신 run이 실패한 날도 그 run의 증거 artifact에서 요청 수를 읽는다", async () => {
  const topology = {
    topologyRuns: [run(FAILED_RUN, TOPOLOGY, { event: "schedule" })],
    runs: [currentRun()],
    jobs: { [FAILED_RUN]: [job(FAILED_RUN, TOPOLOGY, "failure")] },
    artifacts: { [FAILED_RUN]: (directory) => writeFailedRunArtifact(directory, { requestCount: 420 }) },
  };
  const { fetchImpl, downloadArtifact, downloads } = github(topology);
  const { entries } = await readItxCollectionLedger({ env: env(), now: NOW, fetchImpl, downloadArtifact });
  assert.deepEqual(entries.map(({ workflowFile, outcome, requestCount }) => ({ workflowFile, outcome, requestCount })), [{ workflowFile: TOPOLOGY.file, outcome: "FAILED", requestCount: 420 }]);
  assert.equal(downloads[0].artifactName, `current-capital-topology-refresh-itx-review-${FAILED_RUN}`);
  assert.deepEqual(stateOf(decideAt(NOW, entries, true)), { state: "COLLECT", reason: "SAFETY_LEAD" });
});

test("ledger는 목록 응답이 잘못되면 추정하지 않고 실패한다", async () => {
  await assert.rejects(() => readItxCollectionLedger(options({})), /quota guard failed/u);
  await assert.rejects(() => readItxCollectionLedger(options(failedPriorRun(), { env: env({ GITHUB_EVENT_NAME: "push" }) })), /quota guard failed/u);
});

test("재시도 가드: 실패한 앞선 수집만 있고 예산·상한 안이면 허용하고, 기본 가드는 여전히 막는다", async () => {
  const fixture = failedPriorRun();
  await assert.rejects(() => guardItxCurrentCollectionBudget(options(fixture)), /quota guard failed/u);
  const allowed = await guardItxCurrentCollectionBudget({ ...options(fixture), allowAfterFailure: true });
  assert.deepEqual(allowed, { repository: REPOSITORY, runId: CURRENT_RUN, quotaWindow: "2026-10-17", otherRunCount: 1 });
});

test("재시도 가드는 성공·진행 중 수집, 예산 초과, 시도 상한, 증거 없음을 막는다", async () => {
  const guard = (fixture) => guardItxCurrentCollectionBudget({ ...options(fixture), allowAfterFailure: true });
  const success = { runs: [run(FAILED_RUN, PROMOTION), currentRun()], jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, "success")] } };
  await assert.rejects(() => guard(success), /quota guard failed/u);
  await assert.rejects(() => guard({ ...success, jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, null, { status: "in_progress" })] } }), /quota guard failed/u);
  // 사용 5,483건 + 최악 4,000건은 일일 예산 9,482건을 넘고, 5,482건까지는 들어간다.
  await assert.rejects(() => guard(failedPriorRuns([2_741, 2_742])), /quota guard failed/u);
  assert.equal((await guard(failedPriorRuns([2_741, 2_741]))).otherRunCount, 2);
  await assert.rejects(() => guard({ ...failedPriorRun(), artifacts: {} }), /quota guard failed/u);
  await assert.rejects(() => guard(failedPriorRuns([10, 10, 10])), /quota guard failed/u);
  assert.equal((await guard(failedPriorRuns([10, 10]))).otherRunCount, 2);
  // 간격은 판정 단계의 정책이라 가드는 보지 않는다: 방금 끝난 실패도 가드를 막지 않는다.
  const justFailed = failedPriorRun();
  justFailed.jobs[FAILED_RUN] = [job(FAILED_RUN, PROMOTION, "failure", { completedAt: "2026-10-16T19:08:00Z" })];
  assert.equal((await guard(justFailed)).otherRunCount, 1);
});

// F6: topology 갱신 판정은 같은 allowance 규칙을 쓴다(probe). 실패만 한 날은 간격 뒤 예산 안에서 승격·topology 모두 다시 수집한다.
test("probe는 승격 판정과 같은 규칙이다: 성공·진행 중·재시도 간격 전·예산 소진·증거 없음은 true, 실패만 했고 여유가 있으면 false", async () => {
  const probe = (fixture, now = NOW) => probeItxCollectionToday(options(fixture, { now })).then(({ collectedToday }) => collectedToday);
  assert.equal(await probe({ runs: [currentRun()] }), false);
  assert.equal(await probe(failedPriorRun(), new Date("2026-10-16T20:52:15.000Z")), false);
  assert.equal(await probe(failedPriorRun(), new Date("2026-10-16T20:52:14.999Z")), true);
  assert.equal(await probe(failedPriorRuns([2_741, 2_742]), new Date("2026-10-16T22:30:00.000Z")), true);
  assert.equal(await probe({ ...failedPriorRun(), artifacts: {} }, new Date("2026-10-16T22:30:00.000Z")), true);
  assert.equal(await probe({ runs: [run(FAILED_RUN, PROMOTION), currentRun()], jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, "success")] } }), true);
});

test("가드 CLI: --allow-after-failure는 --output과 함께일 때만 받고 다른 인자 조합은 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-guard-"));
  try {
    const fixture = failedPriorRun();
    const output = path.join(dir, "freshness.json");
    const result = await runItxCurrentCollectionBudgetGuardCli({ argv: ["--output", output, "--allow-after-failure"], ...options(fixture) });
    assert.equal(result.otherRunCount, 1);
    await assert.rejects(() => stat(output), { code: "ENOENT" });
    for (const argv of [["--allow-after-failure"], ["--output", output, "--allow-after-failure", "--allow-after-failure"], ["--output", output, "--force"], ["--allow-after-failure", "--output", output]]) {
      await assert.rejects(() => runItxCurrentCollectionBudgetGuardCli({ argv, ...options(fixture) }), /quota guard failed/u, argv.join(" "));
    }
    // --allow-after-failure 없이는 실패한 앞선 수집도 막고 sanitized preflight receipt만 남긴다.
    const strict = path.join(dir, "strict", "freshness.json");
    await mkdir(path.dirname(strict));
    await assert.rejects(() => runItxCurrentCollectionBudgetGuardCli({ argv: ["--output", strict], ...options(fixture) }), /quota guard failed/u);
    assert.equal(JSON.parse(await readFile(strict, "utf8")).operation, "KST_PROVIDER_ENTRY_QUOTA");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledger CLI: --ledger <절대 경로>에 기록을 쓰고 그 외 인자·기존 파일은 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-ledger-"));
  try {
    const fixture = failedPriorRun();
    const output = path.join(dir, "itx-collection-ledger.json");
    await runItxCollectionLedgerCli({ argv: ["--ledger", output], ...options(fixture) });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      schemaVersion: 1,
      quotaWindow: "2026-10-17",
      entries: [{ runId: FAILED_RUN, workflowFile: PROMOTION.file, outcome: "FAILED", endedAt: COLLECTOR_ENDED_AT, requestCount: 810 }],
    });
    await assert.rejects(() => runItxCollectionLedgerCli({ argv: ["--ledger", output], ...options(fixture) }), /quota guard failed/u);
    for (const argv of [[], ["--ledger"], ["--ledger", "relative.json"], ["--ledger", path.join(dir, "other.json"), "--probe"]]) {
      await assert.rejects(() => runItxCollectionLedgerCli({ argv, ...options(fixture) }), /quota guard failed/u, argv.join(" "));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
