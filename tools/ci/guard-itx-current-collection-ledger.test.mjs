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
import { failedRunArtifactZip, kasiFailureArtifactZip } from "./test-fixtures/itx-failed-run-artifact.mjs";

// 2026-10-16 18:00Z 승격 run 38943966334가 TAGO 장애로 실패한 뒤의 같은 KST 날(2026-10-17)을 재현한다.
const REPOSITORY = "AquilaXk/easysubway-data";
const FAILED_RUN = 38943966334;
const CURRENT_RUN = 38952684012;
const NOW = new Date("2026-10-16T19:08:25.000Z");
const PROMOTION = { file: "itx-current-promotion.yml", job: "ITX current promotion", step: "Collect current ITX timetable", artifact: "itx-current-promotion" };
const TOPOLOGY = { file: "current-capital-topology-refresh.yml", job: "Current topology refresh", step: "Collect current ITX timetable once" };

const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ID: String(CURRENT_RUN),
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_TOKEN: "synthetic-github-token-that-must-not-leak",
  ...overrides,
});
const run = (id, context, overrides = {}) => ({
  id, created_at: "2026-10-16T18:00:07Z", updated_at: "2026-10-16T18:52:15Z", event: "workflow_dispatch", head_branch: "main", run_attempt: 1,
  path: `.github/workflows/${context.file}`, ...overrides,
});
const currentRun = () => run(CURRENT_RUN, PROMOTION, { created_at: "2026-10-16T19:08:25Z", updated_at: "2026-10-16T19:08:25Z" });
const job = (runId, context, conclusion, status = "completed") => ({
  id: runId + 10_000, run_id: runId, name: context.job, status, conclusion: "failure",
  steps: [{ name: context.step, status, conclusion }],
});

/** runs: 승격 workflow의 dispatch run 목록, jobs: run id별 collector 결과, artifacts: run id별 artifact ZIP(없으면 artifact 없음). */
function githubFetch({ runs = [], topologyRuns = [], jobs = {}, artifacts = {} }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const request = new URL(url);
    const pathName = request.pathname;
    if (pathName.endsWith("/runs")) {
      const file = pathName.split("/").at(-2);
      const selected = request.searchParams.get("event") === "workflow_dispatch" && file === PROMOTION.file ? runs
        : request.searchParams.get("event") === "schedule" && file === TOPOLOGY.file ? topologyRuns : [];
      return Response.json({ total_count: selected.length, workflow_runs: selected });
    }
    let match = pathName.match(/\/actions\/runs\/(\d+)\/jobs$/u);
    if (match) {
      const found = jobs[match[1]] ?? [];
      return Response.json({ total_count: found.length, jobs: found });
    }
    match = pathName.match(/\/actions\/runs\/(\d+)\/artifacts$/u);
    if (match) {
      const present = artifacts[match[1]] !== undefined;
      return Response.json({ total_count: present ? 1 : 0, artifacts: present ? [{ id: Number(match[1]) + 1, name: request.searchParams.get("name"), expired: false }] : [] });
    }
    match = pathName.match(/\/actions\/artifacts\/(\d+)\/zip$/u);
    if (match) return new Response(artifacts[String(Number(match[1]) - 1)], { status: 200 });
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}
// 앞선 실패 run마다 보낸 요청 수(requestCounts)로 같은 날의 실패 기록을 만든다. capture는 run 하나에 4,000건까지만 담는다.
const failedPriorRuns = async (requestCounts) => {
  const ids = requestCounts.map((_, index) => FAILED_RUN + index);
  return {
    runs: [...ids.map((id) => run(id, PROMOTION)), currentRun()],
    jobs: Object.fromEntries(ids.map((id) => [id, [job(id, PROMOTION, "failure")]])),
    artifacts: Object.fromEntries(await Promise.all(ids.map(async (id, index) => [id, await failedRunArtifactZip({ requestCount: requestCounts[index], transportFailures: 3 })]))),
  };
};
const failedPriorRun = (requestCount = 810) => failedPriorRuns([requestCount]);
const ledgerOf = (fixture, overrides = {}) => readItxCollectionLedger({ env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl, ...overrides });

const contract = { sourceTimetableArtifact: { status: "ADMITTED", freshUntil: "2026-10-18T00:00:00+09:00" } };
const decideAt = (now, entries, force = false) => decideItxCurrentPromotion({
  now, contract, pullRequests: [], branches: [], repository: REPOSITORY, limits: { pullRequests: 1000 }, force, collectionEntries: entries,
});

test("장애 재현(RED): 같은 날 실패 run은 ledger에 FAILED·요청 810건·종료 시각으로 남고 판정은 재수집을 허용한다", async () => {
  const ledger = await ledgerOf(await failedPriorRun());
  assert.equal(ledger.quotaWindow, "2026-10-17");
  assert.deepEqual(ledger.entries, [{
    runId: FAILED_RUN, workflowFile: PROMOTION.file, outcome: "FAILED", endedAt: "2026-10-16T18:52:15.000Z", requestCount: 810,
  }]);
  // 이전 코드는 이 상황을 ITX_COLLECTED_TODAY로 막았다(만료 전에 재수집할 방법이 없었다).
  assert.equal((await probeItxCollectionToday({ env: env(), now: NOW, fetchImpl: githubFetch(await failedPriorRun()).fetchImpl })).collectedToday, true);
  // 사람 force는 최소 간격 없이 바로(19:08Z), force 없는 정기 실행은 간격(2시간)이 지난 뒤 재수집한다.
  assert.deepEqual((({ state, reason }) => ({ state, reason }))(decideAt(NOW, ledger.entries, true)), { state: "COLLECT", reason: "SAFETY_LEAD" });
  assert.deepEqual((({ state, reason }) => ({ state, reason }))(decideAt(NOW, ledger.entries)), { state: "WAIT", reason: "ITX_RETRY_TOO_SOON" });
  assert.equal(decideAt(new Date("2026-10-16T20:52:15.000Z"), ledger.entries).state, "COLLECT");
  assert.equal(decideAt(new Date("2026-10-16T22:30:00.000Z"), ledger.entries).state, "COLLECT");
});

test("성공했거나 진행 중인 수집은 SUCCEEDED·RUNNING이고 artifact를 읽지 않는다. 판정은 ITX_COLLECTED_TODAY로 대기한다", async () => {
  for (const [conclusion, status, outcome] of [["success", "completed", "SUCCEEDED"], [null, "in_progress", "RUNNING"]]) {
    const fixture = { runs: [run(FAILED_RUN, PROMOTION), currentRun()], jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, conclusion, status)] } };
    const { fetchImpl, calls } = githubFetch(fixture);
    const ledger = await readItxCollectionLedger({ env: env(), now: NOW, fetchImpl });
    assert.deepEqual(ledger.entries, [{ runId: FAILED_RUN, workflowFile: PROMOTION.file, outcome, endedAt: null, requestCount: null }]);
    assert.equal(calls.some((url) => url.includes("/artifacts")), false, outcome);
    assert.deepEqual((({ state, reason }) => ({ state, reason }))(decideAt(NOW, ledger.entries, true)), { state: "WAIT", reason: "ITX_COLLECTED_TODAY" });
  }
});

test("collector step이 skipped인 run은 공급자를 부르지 않았으므로 기록에 넣지 않는다", async () => {
  const fixture = { runs: [run(FAILED_RUN, PROMOTION), currentRun()], jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, "skipped")] } };
  assert.deepEqual((await ledgerOf(fixture)).entries, []);
});

test("KASI 휴일 조회 실패로 끝난 run은 TAGO 요청 0건으로 기록한다", async () => {
  const fixture = { ...(await failedPriorRun()), artifacts: { [FAILED_RUN]: kasiFailureArtifactZip() } };
  assert.equal((await ledgerOf(fixture)).entries[0].requestCount, 0);
});

test("증거를 읽을 수 없는 실패 run은 null로 남고, 판정은 ITX_COLLECTION_EVIDENCE_MISSING으로 실패한다 (fail-closed)", async () => {
  const noArtifact = { ...(await failedPriorRun()), artifacts: {} };
  const missing = await ledgerOf(noArtifact);
  assert.deepEqual(missing.entries.map(({ requestCount, endedAt }) => ({ requestCount, endedAt })), [{ requestCount: null, endedAt: "2026-10-16T18:52:15.000Z" }]);
  assert.throws(() => decideAt(NOW, missing.entries), /ITX_COLLECTION_EVIDENCE_MISSING/u);
  // artifact 이름이 없는 topology 갱신 run의 실패는 요청 수를 증명할 수 없다.
  const topology = {
    topologyRuns: [run(FAILED_RUN, TOPOLOGY, { event: "schedule" })],
    runs: [currentRun()],
    jobs: { [FAILED_RUN]: [job(FAILED_RUN, TOPOLOGY, "failure")] },
  };
  const { fetchImpl, calls } = githubFetch(topology);
  const entries = (await readItxCollectionLedger({ env: env(), now: NOW, fetchImpl })).entries;
  assert.deepEqual(entries.map(({ workflowFile, outcome, requestCount }) => ({ workflowFile, outcome, requestCount })), [{ workflowFile: TOPOLOGY.file, outcome: "FAILED", requestCount: null }]);
  assert.equal(calls.some((url) => url.includes("/artifacts")), false);
  // 종료 시각이 없으면 간격을 계산할 수 없다.
  const noEnd = await ledgerOf({ ...(await failedPriorRun()), runs: [run(FAILED_RUN, PROMOTION, { updated_at: undefined }), currentRun()] });
  assert.equal(noEnd.entries[0].endedAt, null);
});

test("ledger는 목록 응답이 잘못되면 추정하지 않고 실패한다", async () => {
  await assert.rejects(() => readItxCollectionLedger({ env: env(), now: NOW, fetchImpl: githubFetch({}).fetchImpl }), /quota guard failed/u);
  const fixture = await failedPriorRun();
  await assert.rejects(() => readItxCollectionLedger({ env: env({ GITHUB_EVENT_NAME: "push" }), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl }), /quota guard failed/u);
});

test("재시도 가드: 실패한 앞선 수집만 있고 예산·상한 안이면 허용하고, 기본 가드는 여전히 막는다", async () => {
  const fixture = await failedPriorRun();
  const options = { env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl };
  await assert.rejects(() => guardItxCurrentCollectionBudget(options), /quota guard failed/u);
  const allowed = await guardItxCurrentCollectionBudget({ ...options, allowFailedRetry: true });
  assert.deepEqual(allowed, { repository: REPOSITORY, runId: CURRENT_RUN, quotaWindow: "2026-10-17", otherRunCount: 1 });
});

test("재시도 가드는 성공·진행 중 수집, 예산 초과, 시도 상한, 증거 없음을 막는다", async () => {
  const guard = (fixture) => guardItxCurrentCollectionBudget({ env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl, allowFailedRetry: true });
  const success = { runs: [run(FAILED_RUN, PROMOTION), currentRun()], jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, "success")] } };
  await assert.rejects(() => guard(success), /quota guard failed/u);
  await assert.rejects(() => guard({ ...success, jobs: { [FAILED_RUN]: [job(FAILED_RUN, PROMOTION, null, "in_progress")] } }), /quota guard failed/u);
  // 사용 5,001건 + 최악 4,000건은 일일 예산 9,000건을 넘고, 5,000건까지는 들어간다.
  const overBudget = await failedPriorRuns([2_500, 2_501]);
  await assert.rejects(() => guard(overBudget), /quota guard failed/u);
  assert.equal((await guard(await failedPriorRuns([2_500, 2_500]))).otherRunCount, 2);
  const noEvidence = { ...(await failedPriorRun()), artifacts: {} };
  await assert.rejects(() => guard(noEvidence), /quota guard failed/u);
  const exhausted = await failedPriorRuns([10, 10, 10]);
  await assert.rejects(() => guard(exhausted), /quota guard failed/u);
  assert.equal((await guard(await failedPriorRuns([10, 10]))).otherRunCount, 2);
  // 간격은 판정 단계의 정책이라 가드는 보지 않는다: 방금 끝난 실패도 가드를 막지 않는다.
  const justFailed = await failedPriorRun();
  justFailed.runs = [run(FAILED_RUN, PROMOTION, { updated_at: "2026-10-16T19:08:00Z" }), currentRun()];
  assert.equal((await guard(justFailed)).otherRunCount, 1);
});

test("가드 CLI: --allow-failed-retry는 --output과 함께일 때만 받고 다른 인자 조합은 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-guard-"));
  try {
    const fixture = await failedPriorRun();
    const output = path.join(dir, "freshness.json");
    const result = await runItxCurrentCollectionBudgetGuardCli({ argv: ["--output", output, "--allow-failed-retry"], env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl });
    assert.equal(result.otherRunCount, 1);
    await assert.rejects(() => stat(output), { code: "ENOENT" });
    for (const argv of [["--allow-failed-retry"], ["--output", output, "--allow-failed-retry", "--allow-failed-retry"], ["--output", output, "--force"], ["--allow-failed-retry", "--output", output]]) {
      await assert.rejects(() => runItxCurrentCollectionBudgetGuardCli({ argv, env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl }), /quota guard failed/u, argv.join(" "));
    }
    // --allow-failed-retry 없이는 실패한 앞선 수집도 막고 sanitized preflight receipt만 남긴다.
    const strict = path.join(dir, "strict", "freshness.json");
    await mkdir(path.dirname(strict));
    await assert.rejects(() => runItxCurrentCollectionBudgetGuardCli({ argv: ["--output", strict], env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl }), /quota guard failed/u);
    assert.equal(JSON.parse(await readFile(strict, "utf8")).operation, "KST_PROVIDER_ENTRY_QUOTA");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledger CLI: --ledger <절대 경로>에 기록을 쓰고 그 외 인자·기존 파일은 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-ledger-"));
  try {
    const fixture = await failedPriorRun();
    const output = path.join(dir, "itx-collection-ledger.json");
    await runItxCollectionLedgerCli({ argv: ["--ledger", output], env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      schemaVersion: 1,
      quotaWindow: "2026-10-17",
      entries: [{ runId: FAILED_RUN, workflowFile: PROMOTION.file, outcome: "FAILED", endedAt: "2026-10-16T18:52:15.000Z", requestCount: 810 }],
    });
    await assert.rejects(() => runItxCollectionLedgerCli({ argv: ["--ledger", output], env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl }), /quota guard failed/u);
    for (const argv of [[], ["--ledger"], ["--ledger", "relative.json"], ["--ledger", path.join(dir, "other.json"), "--probe"]]) {
      await assert.rejects(() => runItxCollectionLedgerCli({ argv, env: env(), now: NOW, fetchImpl: githubFetch(fixture).fetchImpl }), /quota guard failed/u, argv.join(" "));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
