import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertErrorOmitsSecrets } from "../datapack/lib/source-collection-retry-test-support.mjs";
import { guardItxCurrentCollectionBudget, runItxCurrentCollectionBudgetGuardCli } from "./guard-itx-current-collection-budget.mjs";

// 2026-10-22 14:47~15:00 UTC GitHub Actions 장애 때 가드 세 곳이 같은 한 줄만 남기고 멈췄다. 실패한 검사와 이유가 로그·영수증에 남아야 한다.
// 가드 CLI를 실제 프로세스로 띄우고(GitHub API와 시계는 test-fixtures의 stub으로 고정) 관찰되는 stderr와 영수증을 확인한다.
const GUARD = path.resolve(import.meta.dirname, "guard-itx-current-collection-budget.mjs");
const STUB = path.resolve(import.meta.dirname, "test-fixtures/guard-itx-github-stub.mjs");
const FAILURE_MESSAGE = "ITX current collection quota guard failed";
const REPOSITORY = "AquilaXk/easysubway-data";
const CURRENT_RUN = 39800679317;
const PRIOR_RUN = 39798715632;
const TOKEN = "synthetic-github-token-that-must-not-leak";
const COLLECTION = "itx-current-collection.yml";
const TOPOLOGY = "current-capital-topology-refresh.yml";
const TOPOLOGY_JOB = "Current topology refresh";
const TOPOLOGY_STEP = "Collect current ITX timetable once";

const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ID: String(CURRENT_RUN),
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_TOKEN: TOKEN,
  ...overrides,
});
const run = (id, workflowFile, event, overrides = {}) => ({
  id, status: "completed", created_at: "2026-10-22T14:00:00Z", event, head_branch: "main", run_attempt: 1, path: `.github/workflows/${workflowFile}`, ...overrides,
});
const currentRun = () => run(CURRENT_RUN, COLLECTION, "workflow_dispatch", { status: "in_progress", created_at: "2026-10-22T14:56:00Z" });
const priorTopologyRun = (overrides) => run(PRIOR_RUN, TOPOLOGY, "schedule", overrides);
const collectorStep = (conclusion, overrides = {}) => ({ name: TOPOLOGY_STEP, status: "completed", conclusion, completed_at: "2026-10-22T14:30:00Z", ...overrides });
const collectorJob = (conclusion, steps = [collectorStep(conclusion)], overrides = {}) => ({
  id: PRIOR_RUN + 10_000, run_id: PRIOR_RUN, name: TOPOLOGY_JOB, status: "completed", conclusion: "failure", steps, ...overrides,
});
const baseRuns = (extra = {}) => ({ [`${COLLECTION}|workflow_dispatch`]: [currentRun()], ...extra });
// 같은 날 topology 갱신(schedule)의 이전 run들이 목록에 있는 시나리오. jobs는 그 run(PRIOR_RUN)의 job 목록이다.
const withTopologyRuns = (runs, jobs = []) => ({ runs: baseRuns({ [`${TOPOLOGY}|schedule`]: runs }), jobs: { [PRIOR_RUN]: jobs } });
const withPriorJobs = (jobs) => withTopologyRuns([priorTopologyRun()], jobs);

function runGuard(args, { scenario = {}, envOverrides = {} } = {}) {
  const result = spawnSync(process.execPath, ["--import", STUB, GUARD, ...args], {
    env: { PATH: process.env.PATH, ...env(envOverrides), GUARD_STUB_SCENARIO: JSON.stringify({ runs: baseRuns(), ...scenario }) },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines: result.stderr.split("\n").filter((line) => line !== "") };
}

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-guard-reason-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 목록 안의 항목이 기대한 모양이 아니다. 각 행은 항목의 검사 하나만 어긴다: [이름, 항목]
const INVALID_RUNS = [
  ["run_attempt가 0", priorTopologyRun({ run_attempt: 0 })],
  ["run_attempt가 정수가 아님", priorTopologyRun({ run_attempt: 1.5 })],
  ["run id가 0", priorTopologyRun({ id: 0 })],
  ["run id가 숫자가 아님", priorTopologyRun({ id: "7" })],
  ["run 항목이 null", null],
  ["run 항목이 배열", []],
];
const INVALID_JOBS = [
  ["job이 다른 run의 것(run_id 불일치)", collectorJob("success", undefined, { run_id: PRIOR_RUN + 1 })],
  ["job 이름이 workflow의 collector job이 아님", collectorJob("success", undefined, { name: "Other job" })],
  ["job의 steps가 배열이 아님", collectorJob("success", "steps")],
  ["job id가 0", collectorJob("success", undefined, { id: 0 })],
  ["job id가 숫자가 아님", collectorJob("success", undefined, { id: "7" })],
  ["job 항목이 null", null],
];
const MISPLACED_RUNS = [
  ["event가 조회한 event와 다름", { event: "push" }],
  ["브랜치가 main이 아님", { head_branch: "feature" }],
  ["생성 시각이 KST 하루의 시작 전", { created_at: "2026-10-21T14:59:59Z" }],
  ["생성 시각이 KST 하루의 끝 뒤", { created_at: "2026-10-22T15:00:00Z" }],
  ["생성 시각을 읽을 수 없음", { created_at: "not-a-date" }],
  ["workflow 경로가 목록의 workflow와 다름", { path: ".github/workflows/other.yml" }],
];

// GitHub가 200으로 보낸 본문이 기대한 모양이 아니다: [이름, JSON 본문]
const RUNS_BODIES = [
  ["본문이 null", "null"],
  ["본문이 문자열", '"text"'],
  ["본문이 배열", "[]"],
  ["total_count가 숫자가 아님", '{"total_count":"101","workflow_runs":[]}'],
  ["total_count가 음수", '{"total_count":-1,"workflow_runs":[]}'],
  ["workflow_runs가 배열이 아님", '{"total_count":0}'],
];
const JOBS_BODIES = [
  ["본문이 null", "null"],
  ["본문이 문자열", '"text"'],
  ["본문이 배열", "[]"],
  ["total_count가 숫자가 아님", '{"total_count":"0","jobs":[]}'],
  ["jobs가 배열이 아님", '{"total_count":1}'],
];
// 환경 값 하나가 기대와 다르다: [이름, 환경 덮어쓰기]. undefined는 환경 변수가 없음을 뜻한다.
const INVALID_ENVS = [
  ["GITHUB_REPOSITORY가 이 저장소가 아님", { GITHUB_REPOSITORY: "AquilaXk/other" }],
  ["GITHUB_EVENT_NAME이 수집 workflow의 event가 아님", { GITHUB_EVENT_NAME: "push" }],
  ["GITHUB_REF가 main이 아님", { GITHUB_REF: "refs/heads/feature" }],
  ["GITHUB_RUN_ID가 없음", { GITHUB_RUN_ID: undefined }],
  ["GITHUB_RUN_ID가 숫자가 아님", { GITHUB_RUN_ID: "abc" }],
  ["GITHUB_RUN_ID가 0", { GITHUB_RUN_ID: "0" }],
  ["GITHUB_RUN_ID가 안전한 정수 범위 밖", { GITHUB_RUN_ID: "9007199254740993" }],
  ["GITHUB_RUN_ATTEMPT가 1이 아님", { GITHUB_RUN_ATTEMPT: "2" }],
  ["GITHUB_TOKEN이 없음", { GITHUB_TOKEN: undefined }],
  ["GITHUB_TOKEN이 빈 문자열", { GITHUB_TOKEN: "" }],
  ["GITHUB_TOKEN이 4096자를 넘음", { GITHUB_TOKEN: "x".repeat(4097) }],
  ["GITHUB_TOKEN에 줄바꿈이 있음", { GITHUB_TOKEN: "line1\nline2" }],
];

// 각 행은 실제로 그 분기를 일으키는 입력이다: [이름, 시나리오, 환경 덮어쓰기, 기대하는 reason 줄]
const PROBE_FAILURES = [
  ["runs 목록 API가 500", { runsFault: { status: 500, body: "boom" } }, {}, `reason=GITHUB_API_STATUS status=500 workflow=${COLLECTION}`],
  ["runs 목록 요청이 예외(네트워크·timeout)", { runsFault: { throwMessage: "network unreachable" } }, {}, `reason=GITHUB_API_REQUEST_FAILED workflow=${COLLECTION}`],
  ["응답 본문이 JSON이 아님", { runsFault: { rawBody: "<html>Bad gateway</html>" } }, {}, `reason=GITHUB_API_BODY_INVALID workflow=${COLLECTION}`],
  ["total_count가 목록 길이와 다름", { runsFault: { totalCount: 2 } }, {}, `reason=GITHUB_API_BODY_INVALID workflow=${COLLECTION}`],
  ["runs가 한 페이지 상한(100)을 넘음", { runsFault: { totalCount: 101 } }, {}, `reason=RUN_LIST_LIMIT workflow=${COLLECTION}`],
  ["본문을 읽는 도중 연결이 끊김", { runsFault: { brokenBody: true } }, {}, `reason=GITHUB_API_REQUEST_FAILED workflow=${COLLECTION}`],
  ["이 run이 목록에 없음", { runs: {} }, {}, "reason=CURRENT_RUN_MISMATCH"],
  ["이 run이 두 번째 시도임", { runs: baseRuns({ [`${COLLECTION}|workflow_dispatch`]: [{ ...currentRun(), run_attempt: 2 }] }) }, {}, "reason=CURRENT_RUN_MISMATCH"],
  ["이 run의 event가 GITHUB_EVENT_NAME과 다름", {}, { GITHUB_EVENT_NAME: "schedule" }, "reason=CURRENT_RUN_MISMATCH"],
  ["다른 workflow의 run이 이 run과 같은 id", withTopologyRuns([priorTopologyRun({ id: CURRENT_RUN })]), {}, "reason=RUN_IDENTITY_MISMATCH"],
  ["이전 run이 같은 목록에 두 번", withTopologyRuns([priorTopologyRun(), priorTopologyRun()]), {}, "reason=RUN_IDENTITY_MISMATCH"],
  ...INVALID_RUNS.map(([name, record]) => [`run 항목 이상: ${name}`, withTopologyRuns([record]), {}, `reason=RUN_RECORD_INVALID workflow=${TOPOLOGY}`]),
  ...MISPLACED_RUNS.map(([name, overrides]) => [`run이 조회 조건과 다름: ${name}`, withTopologyRuns([priorTopologyRun(overrides)]), {}, `reason=RUN_IDENTITY_MISMATCH workflow=${TOPOLOGY}`]),
  ["이전 run의 jobs API가 503", { ...withPriorJobs([]), jobsFault: { status: 503 } }, {}, `reason=GITHUB_API_STATUS status=503 workflow=${TOPOLOGY}`],
  ["이전 run에 job이 하나도 없음", withPriorJobs([]), {}, `reason=JOB_LIST_EMPTY workflow=${TOPOLOGY}`],
  ["이전 run의 job이 한 페이지 상한(100)을 넘음", { ...withPriorJobs([]), jobsFault: { totalCount: 101 } }, {}, `reason=JOB_LIST_LIMIT workflow=${TOPOLOGY}`],
  ["jobs의 total_count가 목록 길이와 다름", { ...withPriorJobs([collectorJob("success")]), jobsFault: { totalCount: 2 } }, {}, `reason=GITHUB_API_BODY_INVALID workflow=${TOPOLOGY}`],
  ["job이 같은 id로 두 번", withPriorJobs([collectorJob("success"), collectorJob("success")]), {}, `reason=JOB_RECORD_INVALID workflow=${TOPOLOGY}`],
  ...INVALID_JOBS.map(([name, record]) => [`job 항목 이상: ${name}`, withPriorJobs([record]), {}, `reason=JOB_RECORD_INVALID workflow=${TOPOLOGY}`]),
  ["이전 run에 collector step이 없음", withPriorJobs([collectorJob("failure", [{ name: "Unrelated step", status: "completed", conclusion: "success" }])]), {}, `reason=COLLECTOR_STEP_SHAPE workflow=${TOPOLOGY}`],
  ["collector step이 둘", withPriorJobs([collectorJob("success", [collectorStep("success"), collectorStep("success")])]), {}, `reason=COLLECTOR_STEP_SHAPE workflow=${TOPOLOGY}`],
  ["collector step이 시작 전(queued)인데 결과가 있음", withPriorJobs([collectorJob("success", [collectorStep("success", { status: "queued" })])]), {}, `reason=COLLECTOR_STEP_SHAPE workflow=${TOPOLOGY}`],
  ["collector step이 끝났는데 결과가 없음", withPriorJobs([collectorJob("success", [collectorStep(null)])]), {}, `reason=COLLECTOR_STEP_SHAPE workflow=${TOPOLOGY}`],
  ["collector step 결과를 해석할 수 없음", withPriorJobs([collectorJob("neutral")]), {}, `reason=COLLECTOR_STEP_SHAPE workflow=${TOPOLOGY}`],
  // 가드가 모르는 예외는 원문(여기서는 토큰이 섞인 메시지) 없이 INTERNAL_ERROR만 남는다.
  ["가드가 모르는 예외", { runsFault: { explodingResponse: `unexpected ${TOKEN}` } }, {}, "reason=INTERNAL_ERROR"],
  ...INVALID_ENVS.map(([name, overrides]) => [`환경 이상: ${name}`, {}, overrides, "reason=ENV_INVALID"]),
  ...RUNS_BODIES.map(([name, rawBody]) => [`runs 응답 모양 이상: ${name}`, { runsFault: { rawBody } }, {}, `reason=GITHUB_API_BODY_INVALID workflow=${COLLECTION}`]),
  ...JOBS_BODIES.map(([name, rawBody]) => [`jobs 응답 모양 이상: ${name}`, { ...withPriorJobs([]), jobsFault: { rawBody } }, {}, `reason=GITHUB_API_BODY_INVALID workflow=${TOPOLOGY}`]),
  ["200이 아닌 성공 상태(201)", { runsFault: { status: 201 } }, {}, `reason=GITHUB_API_STATUS status=201 workflow=${COLLECTION}`],
  ["응답 본문이 2MiB를 넘음", { runsFault: { padBytes: 2 * 1024 * 1024 } }, {}, `reason=GITHUB_API_BODY_INVALID workflow=${COLLECTION}`],
];

for (const [name, scenario, envOverrides, reasonLine] of PROBE_FAILURES) {
  test(`--probe 실패: ${name} -> 기존 메시지 줄 뒤에 ${reasonLine}`, () => {
    const result = runGuard(["--probe"], { scenario, envOverrides });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(result.lines, [FAILURE_MESSAGE, reasonLine]);
  });
}

test("정상 예산 거부(strict): 같은 날 다른 수집이 있으면 QUOTA_EXHAUSTED를 stderr와 영수증에 남긴다", async () => {
  await withDirectory(async (directory) => {
    const output = path.join(directory, "freshness.json");
    const scenario = { runs: baseRuns({ [`${TOPOLOGY}|schedule`]: [priorTopologyRun()] }), jobs: { [PRIOR_RUN]: [collectorJob("success")] } };
    const result = runGuard(["--output", output], { scenario });
    assert.equal(result.status, 1);
    assert.deepEqual(result.lines, [FAILURE_MESSAGE, "reason=QUOTA_EXHAUSTED"]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      schemaVersion: 1,
      artifactKind: "itx-current-collection-preflight",
      status: "FAILED",
      operation: "KST_PROVIDER_ENTRY_QUOTA",
      providerCalls: 0,
      candidateCreated: false,
      credentialRedacted: true,
      reason: "QUOTA_EXHAUSTED",
    });
  });
});

test("정상 예산 거부(--allow-after-failure): 허용 규칙이 거부한 이유를 allowance로 함께 남긴다", async () => {
  await withDirectory(async (directory) => {
    const output = path.join(directory, "freshness.json");
    const scenario = { runs: baseRuns({ [`${TOPOLOGY}|schedule`]: [priorTopologyRun()] }), jobs: { [PRIOR_RUN]: [collectorJob("success")] } };
    const result = runGuard(["--output", output, "--allow-after-failure"], { scenario });
    assert.equal(result.status, 1);
    assert.deepEqual(result.lines, [FAILURE_MESSAGE, "reason=QUOTA_EXHAUSTED allowance=ITX_COLLECTED_TODAY"]);
    assert.equal(JSON.parse(await readFile(output, "utf8")).allowance, "ITX_COLLECTED_TODAY");
  });
});

test("API 장애로 멈춘 가드의 영수증에는 reason·status·workflow가 남는다", async () => {
  await withDirectory(async (directory) => {
    const output = path.join(directory, "freshness.json");
    const result = runGuard(["--output", output], { scenario: { runsFault: { status: 500 } } });
    assert.deepEqual(result.lines, [FAILURE_MESSAGE, `reason=GITHUB_API_STATUS status=500 workflow=${COLLECTION}`]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      schemaVersion: 1,
      artifactKind: "itx-current-collection-preflight",
      status: "FAILED",
      operation: "KST_PROVIDER_ENTRY_QUOTA",
      providerCalls: 0,
      candidateCreated: false,
      credentialRedacted: true,
      reason: "GITHUB_API_STATUS",
      httpStatus: 500,
      workflow: COLLECTION,
    });
  });
});

test("env 이상이면 영수증의 reason이 ENV_INVALID다", async () => {
  await withDirectory(async (directory) => {
    const output = path.join(directory, "freshness.json");
    const result = runGuard(["--output", output], { envOverrides: { GITHUB_REF: "refs/heads/feature" } });
    assert.deepEqual(result.lines, [FAILURE_MESSAGE, "reason=ENV_INVALID"]);
    assert.equal(JSON.parse(await readFile(output, "utf8")).reason, "ENV_INVALID");
  });
});

test("인자 이상은 ARGUMENT_INVALID이고, 영수증을 쓸 위치를 알 수 없으므로 파일을 만들지 않는다", async () => {
  await withDirectory(async (directory) => {
    const relative = runGuard(["--output", "freshness.json"]);
    assert.deepEqual(relative.lines, [FAILURE_MESSAGE, "reason=ARGUMENT_INVALID"]);
    const unknownFlag = runGuard(["--output", path.join(directory, "freshness.json"), "--force"]);
    assert.deepEqual(unknownFlag.lines, [FAILURE_MESSAGE, "reason=ARGUMENT_INVALID"]);
    await assert.rejects(() => stat(path.join(directory, "freshness.json")), { code: "ENOENT" });
  });
});

test("--ledger 실패도 같은 방식으로 사유를 남긴다", async () => {
  await withDirectory(async (directory) => {
    const output = path.join(directory, "ledger.json");
    const apiFailure = runGuard(["--ledger", output], { scenario: { runsFault: { status: 502 } } });
    assert.deepEqual(apiFailure.lines, [FAILURE_MESSAGE, `reason=GITHUB_API_STATUS status=502 workflow=${COLLECTION}`]);
  });
});

// 어떤 모드로도 해석할 수 없는 인자는 GitHub를 부르기 전에 ARGUMENT_INVALID로 멈춘다. 경로는 모두 존재하지 않는 위치라 파일이 생기면 안 된다.
const INVALID_ARGUMENTS = [
  ["--output이 상대 경로", ["--output", "freshness.json"]],
  ["--output의 파일 이름이 freshness.json이 아님", ["--output", "/nonexistent/other.json"]],
  ["--output에 값이 없음", ["--output"]],
  ["알 수 없는 인자", ["--force"]],
  ["--probe 뒤에 인자가 더 있음", ["--probe", "extra"]],
  ["--ledger에 값이 없음", ["--ledger"]],
  ["--ledger 값이 상대 경로", ["--ledger", "ledger.json"]],
  ["--ledger 뒤에 인자가 더 있음", ["--ledger", "/nonexistent/ledger.json", "extra"]],
];

for (const [name, args] of INVALID_ARGUMENTS) {
  test(`인자 이상: ${name} -> ARGUMENT_INVALID`, () => {
    const result = runGuard(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(result.lines, [FAILURE_MESSAGE, "reason=ARGUMENT_INVALID"]);
  });
}

test("--ledger 출력 파일이 이미 있으면 LEDGER_WRITE_FAILED이고 기존 파일은 그대로다", async () => {
  await withDirectory(async (directory) => {
    const output = path.join(directory, "ledger.json");
    await writeFile(output, "existing\n");
    const result = runGuard(["--ledger", output]);
    assert.equal(result.status, 1);
    assert.deepEqual(result.lines, [FAILURE_MESSAGE, "reason=LEDGER_WRITE_FAILED"]);
    assert.equal(await readFile(output, "utf8"), "existing\n");
  });
});

test("영수증을 이미 쓴 자리에는 다시 쓰지 못해 RECEIPT_WRITE_FAILED로 드러나고 처음 실패 사유도 cause로 남는다", async () => {
  await withDirectory(async (directory) => {
    const output = path.join(directory, "freshness.json");
    runGuard(["--output", output], { scenario: { runsFault: { status: 500 } } });
    const second = runGuard(["--output", output], { scenario: { runsFault: { status: 500 } } });
    assert.deepEqual(second.lines, [FAILURE_MESSAGE, "reason=RECEIPT_WRITE_FAILED cause=GITHUB_API_STATUS"]);
  });
});

// 비밀 금지: 토큰·Authorization 헤더·응답 본문·URL 쿼리는 사유에 들어가지 않는다.
const SECRET_SURFACES = [TOKEN, "Bearer", "Authorization", "authorization", "per_page", "created=", "api.github.com", "secret-response-body"];

test("비밀: stderr와 영수증에 토큰·Authorization·응답 본문·URL 쿼리가 실리지 않는다", async () => {
  await withDirectory(async (directory) => {
    const faults = [
      { throwMessage: `fetch failed for https://api.github.com/repos/${REPOSITORY}/actions/workflows/x/runs?per_page=100&created=2026 with Authorization: Bearer ${TOKEN}` },
      { status: 500, body: "secret-response-body" },
      { rawBody: "secret-response-body" },
    ];
    for (const [index, fault] of faults.entries()) {
      const output = path.join(directory, `case-${index}`, "freshness.json");
      await mkdir(path.dirname(output));
      const result = runGuard(["--output", output], { scenario: { runsFault: fault } });
      const receipt = await readFile(output, "utf8");
      assertErrorOmitsSecrets(new Error(`${result.stderr}\n${receipt}`), SECRET_SURFACES);
    }
  });
});

test("비밀: 던져지는 오류 객체(cause·속성 포함)에도 fetch 예외의 원문이 남지 않는다", async () => {
  const fetchImpl = async () => {
    throw new Error(`socket hang up Authorization: Bearer ${TOKEN} https://api.github.com/x?per_page=100`);
  };
  const error = await guardItxCurrentCollectionBudget({ env: env(), now: new Date("2026-10-22T14:57:17Z"), fetchImpl }).then(() => null, (caught) => caught);
  assert.equal(error.message, FAILURE_MESSAGE);
  assert.equal(error.reason, "GITHUB_API_REQUEST_FAILED");
  assertErrorOmitsSecrets(error, SECRET_SURFACES);
});

// 가드 모듈을 라이브러리로 부르는 쪽(승격 판정 등)의 잘못된 입력도 사유 코드가 붙은 같은 오류로 거부된다. CLI로는 만들 수 없는 입력(주입한 fetch·시계·인자)이다.
const NOW = new Date("2026-10-22T14:57:17Z");
const nonConformingFetch = (response) => async () => response;
const INVALID_LIBRARY_INPUTS = [
  ["env가 객체가 아님", { env: null }, "ENV_INVALID"],
  ["fetch 구현이 함수가 아님", { fetchImpl: null }, "ENV_INVALID"],
  ["시계가 Date가 아님", { now: "2026-10-22T14:57:17Z" }, "ENV_INVALID"],
  ["시계가 유효하지 않은 Date", { now: new Date(Number.NaN) }, "ENV_INVALID"],
  ["argv가 비어 있지 않음", { argv: ["--unexpected"] }, "ARGUMENT_INVALID"],
  ["allowAfterFailure가 boolean이 아님", { allowAfterFailure: "yes" }, "ARGUMENT_INVALID"],
  ["fetch 응답에 text()가 없음", { fetchImpl: nonConformingFetch({ ok: true, status: 200 }) }, "GITHUB_API_BODY_INVALID"],
  ["fetch 응답 본문이 문자열이 아님", { fetchImpl: nonConformingFetch({ ok: true, status: 200, text: async () => 5 }) }, "GITHUB_API_BODY_INVALID"],
];

for (const [name, overrides, reason] of INVALID_LIBRARY_INPUTS) {
  test(`가드 직접 호출: ${name} -> ${reason}`, async () => {
    const error = await guardItxCurrentCollectionBudget({ env: env(), now: NOW, fetchImpl: nonConformingFetch(new Response("{}")), ...overrides }).then(() => null, (caught) => caught);
    assert.equal(error.message, FAILURE_MESSAGE);
    assert.equal(error.reason, reason);
  });
}

test("가드 CLI 진입점: --output 값이 문자열이 아니면 ARGUMENT_INVALID", async () => {
  const error = await runItxCurrentCollectionBudgetGuardCli({ argv: ["--output", 5], env: env(), now: NOW }).then(() => null, (caught) => caught);
  assert.equal(error.reason, "ARGUMENT_INVALID");
});

// 판정 동작은 그대로다: 같은 입력이면 같은 허용·거부이고, 허용이면 stdout에 결과가 나가며 stderr는 비어 있다.
test("허용 판정: 같은 날 다른 수집이 없으면 stdout에 결과를 쓰고 stderr는 비어 있다", () => {
  const result = runGuard(["--probe"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "false\n");
  assert.equal(result.stderr, "");
});
