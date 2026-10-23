import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseProviderCallLedger } from "./provider-call-budget.mjs";
import {
  SOURCE_REVERIFICATION_CALL_EVIDENCE,
  countTelemetryRequests,
  readProviderCallLedger,
  runProviderCallLedgerCli,
} from "./provider-call-ledger.mjs";

// 같은 KST 날 source-reverification run마다 원천 operation별 요청 수를 그 run의 수집 계측 artifact에서 읽는다(Refs AquilaXk/easysubway#3036).
const REPOSITORY = "AquilaXk/easysubway-data";
const WORKFLOW = "source-reverification.yml";
const JOB = "Source reverification";
const STEP = "Reverify due P7D sources";
const CURRENT_RUN = 39380042668;
const NOW = new Date("2026-10-20T06:23:30.000Z");
const TOPOLOGY = "busan-transportation-route-topology";

const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ID: String(CURRENT_RUN), GITHUB_RUN_ATTEMPT: "1", GITHUB_TOKEN: "synthetic-github-token-that-must-not-leak", ...overrides,
});
const run = (id, createdAt, overrides = {}) => ({
  id, status: "completed", created_at: createdAt, event: "workflow_dispatch", head_branch: "main", run_attempt: 1, path: `.github/workflows/${WORKFLOW}`, ...overrides,
});
const currentRun = () => run(CURRENT_RUN, "2026-10-20T06:23:01Z", { status: "in_progress" });
const job = (runId, conclusion, { status = "completed", jobConclusion = "failure", steps } = {}) => ({
  id: runId + 1, run_id: runId, name: JOB, status, conclusion: jobConclusion,
  steps: steps ?? [{ name: STEP, status, conclusion, ...(status === "completed" ? { completed_at: "2026-10-20T05:02:40Z" } : {}) }],
});
const attempt = (sourceId, outcome = "success") => JSON.stringify({ sourceId, host: "data.humetro.busan.kr", attempt: 1, outcome, durationMs: 120, nextDelayMs: null });
const telemetry = (counts) => Object.entries(counts).flatMap(([sourceId, count]) => Array.from({ length: count }, () => attempt(sourceId))).join("\n");

/** runs: event별 run 목록, jobs: run id -> job 목록, artifacts: run id -> 계측 파일 본문(없으면 artifact 없음). */
function github({ runs = { workflow_dispatch: [currentRun()] }, jobs = {}, artifacts = {} } = {}) {
  const queries = [];
  const downloads = [];
  const fetchImpl = async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith(`/workflows/${WORKFLOW}/runs`)) {
      queries.push(Object.fromEntries(request.searchParams));
      const selected = runs[request.searchParams.get("event")] ?? [];
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
    const body = artifacts[args.runId];
    if (body === undefined) throw new Error("no artifact");
    await writeFile(path.join(args.directory, SOURCE_REVERIFICATION_CALL_EVIDENCE.file), body);
  };
  return { fetchImpl, downloadArtifact, queries, downloads };
}
const read = (fixture, overrides = {}) => readProviderCallLedger({ env: env(), now: NOW, ...fixture, ...overrides });

test("실패한 run과 성공한 run의 계측 artifact에서 operation별 요청 수를 모두 읽는다", async () => {
  const fixture = github({
    runs: { workflow_dispatch: [run(39369279984, "2026-10-20T04:23:02Z"), run(39371539115, "2026-10-20T04:48:40Z"), currentRun()] },
    jobs: { 39369279984: [job(39369279984, "success", { jobConclusion: "success" })], 39371539115: [job(39371539115, "failure")] },
    artifacts: {
      39369279984: telemetry({ [TOPOLOGY]: 114, "busan-transportation-accessibility": 114, "busan-transportation-timetable": 342 }),
      39371539115: `${telemetry({ [TOPOLOGY]: 114, "busan-transportation-accessibility": 61 })}\n`,
    },
  });
  const ledger = await read(fixture);
  assert.deepEqual(ledger, {
    schemaVersion: 1, quotaWindow: "2026-10-20", entries: [
      { runId: 39369279984, outcome: "SUCCEEDED", requestCounts: { [TOPOLOGY]: 114, "busan-transportation-accessibility": 114, "busan-transportation-timetable": 342 } },
      { runId: 39371539115, outcome: "FAILED", requestCounts: { [TOPOLOGY]: 114, "busan-transportation-accessibility": 61 } },
    ],
  });
  assert.deepEqual(fixture.downloads.map(({ artifactName, runId }) => [artifactName, runId]), [
    ["source-reverification-calls-39369279984", 39369279984], ["source-reverification-calls-39371539115", 39371539115],
  ]);
  assert.doesNotThrow(() => parseProviderCallLedger(ledger));
});

test("KST 날 경계: 14:59:59Z는 그날, 15:00:00Z부터는 다음 날 창을 조회한다", async () => {
  const before = github();
  await read(before, { now: new Date("2026-10-19T14:59:59.000Z"), env: env() }).catch(() => {});
  assert.equal(before.queries[0].created, "2026-10-18T15:00:00.000Z..2026-10-19T14:59:59.999Z");
  const after = github({ runs: { workflow_dispatch: [run(CURRENT_RUN, "2026-10-19T15:00:00Z", { status: "in_progress" })] } });
  const ledger = await read(after, { now: new Date("2026-10-19T15:00:00.000Z") });
  assert.equal(after.queries[0].created, "2026-10-19T15:00:00.000Z..2026-10-20T14:59:59.999Z");
  assert.equal(ledger.quotaWindow, "2026-10-20");
  assert.deepEqual(after.queries.map(({ event }) => event), ["schedule", "workflow_dispatch"]);
});

test("수집 step이 건너뛰어졌거나 job이 통째로 건너뛰어진 run은 공급자를 부르지 않았으므로 artifact를 읽지 않는다", async () => {
  const fixture = github({
    runs: { schedule: [run(1, "2026-10-20T00:00:01Z", { event: "schedule" })], workflow_dispatch: [run(2, "2026-10-20T01:00:01Z"), currentRun()] },
    jobs: { 1: [job(1, "skipped", { jobConclusion: "success" })], 2: [{ id: 3, run_id: 2, name: JOB, status: "completed", conclusion: "skipped", steps: [] }] },
  });
  assert.deepEqual((await read(fixture)).entries, []);
  assert.deepEqual(fixture.downloads, []);
});

test("artifact가 없거나 계측 파일이 없거나 읽을 수 없으면 그 run의 요청 수는 null이다 (판정이 fail closed한다)", async () => {
  const ids = [11, 12, 13, 14];
  const fixture = github({
    runs: { workflow_dispatch: [...ids.map((id) => run(id, "2026-10-20T01:00:00Z")), currentRun()] },
    jobs: Object.fromEntries(ids.map((id) => [id, [job(id, "failure")]])),
    artifacts: { 12: "not json\n", 13: `${attempt(TOPOLOGY)}\n{"sourceId":"x"}\n`, 14: attempt("../../etc") },
  });
  const ledger = await read(fixture);
  assert.deepEqual(ledger.entries.map(({ runId, requestCounts }) => [runId, requestCounts]), ids.map((id) => [id, null]));
});

// F1(PR #1452): 공급자를 부르지 않았다는 증명은 "건너뛴 빈 job" 하나뿐이다. 대기·취소·실패한 job은 step이 비었거나 일부만 있어도 호출 여부를 알 수 없어 기록 전체가 읽을 수 없게 된다.
test("job 모양별: 건너뛴 빈 job만 호출 없음이고 대기·취소·실패 job은 step이 비었거나 일부만 있어도 증명되지 않는다", async () => {
  const shaped = (status, conclusion, steps) => ({ id: 52, run_id: 51, name: JOB, status, conclusion, steps });
  const setUp = { name: "Set up job", status: "completed", conclusion: "success" };
  const ledgerFor = (candidate, runOverrides = {}) => read(github({ runs: { workflow_dispatch: [run(51, "2026-10-20T01:00:00Z", runOverrides), currentRun()] }, jobs: { 51: [candidate] } }));
  assert.deepEqual((await ledgerFor(shaped("completed", "skipped", []))).entries, []);
  for (const [label, candidate] of [
    ["queued, 빈 step", shaped("queued", null, [])],
    ["cancelled, 빈 step", shaped("completed", "cancelled", [])],
    ["failure, 빈 step", shaped("completed", "failure", [])],
    ["cancelled, collector 없는 일부 step", shaped("completed", "cancelled", [setUp])],
    ["failure, collector 없는 일부 step", shaped("completed", "failure", [setUp])],
    ["skipped지만 collector 없는 일부 step", shaped("completed", "skipped", [setUp])],
  ]) await assert.rejects(ledgerFor(candidate), { reason: "COLLECTOR_STEP_SHAPE" }, label);
  await assert.rejects(ledgerFor(shaped("queued", null, []), { status: "queued" }), { reason: "COLLECTOR_STEP_SHAPE" }, "queued run");
});

test("아직 끝나지 않은 run(수집 중이거나 증거 업로드 전)은 요청 수를 증명할 수 없어 null이다", async () => {
  const fixture = github({
    runs: { workflow_dispatch: [run(21, "2026-10-20T05:00:00Z", { status: "in_progress" }), currentRun()] },
    jobs: { 21: [job(21, "failure", { jobConclusion: null })] },
    artifacts: { 21: telemetry({ [TOPOLOGY]: 3 }) },
  });
  assert.deepEqual((await read(fixture)).entries, [{ runId: 21, outcome: "RUNNING", requestCounts: null }]);
  assert.deepEqual(fixture.downloads, []);
});

test("계측 파일 하나: 줄마다 원천 id별 시도를 세고, 빈 파일은 0건이다", () => {
  assert.deepEqual(countTelemetryRequests(Buffer.from("")), {});
  assert.deepEqual(countTelemetryRequests(Buffer.from(`${attempt("a")}\n${attempt("b", "error")}\n${attempt("a", "http_error")}\n`)), { a: 2, b: 1 });
});

test("악의적·손상된 계측: 형식이 다른 줄, 깊은 중첩, 알 수 없는 결과는 추정하지 않고 거부한다", () => {
  const deep = `${"[".repeat(5_000)}${"]".repeat(5_000)}`;
  for (const body of [
    "{}",
    "[]",
    deep,
    JSON.stringify({ sourceId: "a", attempt: 1, outcome: "maybe", durationMs: 1 }),
    JSON.stringify({ sourceId: "a", attempt: 0, outcome: "success", durationMs: 1 }),
    JSON.stringify({ sourceId: "a".repeat(49), attempt: 1, outcome: "success", durationMs: 1 }),
    `${attempt("a")}\n\n${attempt("a")}`,
  ]) assert.throws(() => countTelemetryRequests(Buffer.from(body)), /^Error: PROVIDER_CALL_TELEMETRY_INVALID/u);
});

test("계측 파일이 크기 상한을 넘거나 일반 파일이 아니면(심볼릭 링크) 그 run은 null이다", async () => {
  const fixture = github({
    runs: { workflow_dispatch: [run(31, "2026-10-20T01:00:00Z"), run(32, "2026-10-20T02:00:00Z"), currentRun()] },
    jobs: { 31: [job(31, "failure")], 32: [job(32, "failure")] },
  });
  const outside = await mkdtemp(path.join(tmpdir(), "provider-call-ledger-outside-"));
  try {
    await writeFile(path.join(outside, "secret.jsonl"), telemetry({ [TOPOLOGY]: 1 }));
    const downloadArtifact = async ({ runId, directory }) => {
      const target = path.join(directory, SOURCE_REVERIFICATION_CALL_EVIDENCE.file);
      if (runId === 31) await writeFile(target, Buffer.alloc(SOURCE_REVERIFICATION_CALL_EVIDENCE.maxBytes + 1, 0x20));
      else await symlink(path.join(outside, "secret.jsonl"), target);
    };
    const ledger = await read({ ...fixture, downloadArtifact });
    assert.deepEqual(ledger.entries.map(({ requestCounts }) => requestCounts), [null, null]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("CLI: 기록을 파일로 쓰고, run 창을 읽지 못하면 이유를 담은 읽을 수 없는 기록을 쓴다(묶음 판정이 막는다)", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "provider-call-ledger-cli-"));
  try {
    const okOutput = path.join(directory, "ok.json");
    await runProviderCallLedgerCli({ argv: ["--ledger", okOutput], env: env(), now: NOW, ...github() });
    assert.deepEqual(JSON.parse(await readFile(okOutput, "utf8")), { schemaVersion: 1, quotaWindow: "2026-10-20", entries: [] });
    const failedOutput = path.join(directory, "failed.json");
    const failing = { ...github(), fetchImpl: async () => new Response("{}", { status: 503 }) };
    await runProviderCallLedgerCli({ argv: ["--ledger", failedOutput], env: env(), now: NOW, ...failing });
    const written = await readFile(failedOutput, "utf8");
    assert.deepEqual(JSON.parse(written), { schemaVersion: 1, quotaWindow: null, entries: null, unreadableReason: "GITHUB_API_STATUS" });
    assert.doesNotMatch(written, /synthetic-github-token/u);
    const rerun = path.join(directory, "rerun.json");
    await runProviderCallLedgerCli({ argv: ["--ledger", rerun], env: env({ GITHUB_RUN_ATTEMPT: "2" }), now: NOW, ...github() });
    assert.equal(JSON.parse(await readFile(rerun, "utf8")).unreadableReason, "ENV_INVALID");
    await assert.rejects(runProviderCallLedgerCli({ argv: ["--ledger", okOutput], env: env(), now: NOW, ...github() }), /PROVIDER_CALL_LEDGER_WRITE_FAILED/u);
    await assert.rejects(runProviderCallLedgerCli({ argv: ["--ledger", "relative.json"], env: env(), now: NOW, ...github() }), /PROVIDER_CALL_LEDGER_ARGUMENTS/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
