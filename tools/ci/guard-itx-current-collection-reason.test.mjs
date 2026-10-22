import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertErrorOmitsSecrets } from "../datapack/lib/source-collection-retry-test-support.mjs";
import { guardItxCurrentCollectionBudget } from "./guard-itx-current-collection-budget.mjs";

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
const collectorJob = (conclusion, steps = [{ name: TOPOLOGY_STEP, status: "completed", conclusion, completed_at: "2026-10-22T14:30:00Z" }]) => ({
  id: PRIOR_RUN + 10_000, run_id: PRIOR_RUN, name: TOPOLOGY_JOB, status: "completed", conclusion: "failure", steps,
});
const baseRuns = (extra = {}) => ({ [`${COLLECTION}|workflow_dispatch`]: [currentRun()], ...extra });

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

// 각 행은 실제로 그 분기를 일으키는 입력이다: [이름, 시나리오, 환경 덮어쓰기, 기대하는 reason 줄]
const PROBE_FAILURES = [
  ["runs 목록 API가 500", { runsFault: { status: 500, body: "boom" } }, {}, `reason=GITHUB_API_STATUS status=500 workflow=${COLLECTION}`],
  ["runs 목록 요청이 예외(네트워크·timeout)", { runsFault: { throwMessage: "network unreachable" } }, {}, `reason=GITHUB_API_REQUEST_FAILED workflow=${COLLECTION}`],
  ["응답 본문이 JSON이 아님", { runsFault: { rawBody: "<html>Bad gateway</html>" } }, {}, `reason=GITHUB_API_BODY_INVALID workflow=${COLLECTION}`],
  ["total_count가 목록 길이와 다름", { runsFault: { totalCount: 2 } }, {}, `reason=GITHUB_API_BODY_INVALID workflow=${COLLECTION}`],
  ["runs가 한 페이지 상한(100)을 넘음", { runsFault: { totalCount: 101 } }, {}, `reason=RUN_LIST_LIMIT workflow=${COLLECTION}`],
  ["이전 run의 workflow 경로가 목록의 workflow와 다름", {
    runs: baseRuns({ [`${TOPOLOGY}|schedule`]: [priorTopologyRun({ path: ".github/workflows/other.yml" })] }),
  }, {}, `reason=RUN_IDENTITY_MISMATCH workflow=${TOPOLOGY}`],
  ["이 run이 목록에 없음", { runs: {} }, {}, "reason=CURRENT_RUN_MISMATCH"],
  ["이전 run의 jobs API가 503", {
    runs: baseRuns({ [`${TOPOLOGY}|schedule`]: [priorTopologyRun()] }),
    jobsFault: { status: 503 },
  }, {}, `reason=GITHUB_API_STATUS status=503 workflow=${TOPOLOGY}`],
  ["이전 run의 job에 collector step이 없음", {
    runs: baseRuns({ [`${TOPOLOGY}|schedule`]: [priorTopologyRun()] }),
    jobs: { [PRIOR_RUN]: [collectorJob("failure", [{ name: "Unrelated step", status: "completed", conclusion: "success" }])] },
  }, {}, `reason=COLLECTOR_STEP_SHAPE workflow=${TOPOLOGY}`],
  ["GITHUB_REPOSITORY가 이 저장소가 아님", {}, { GITHUB_REPOSITORY: "AquilaXk/other" }, "reason=ENV_INVALID"],
  ["GITHUB_RUN_ATTEMPT가 1이 아님", {}, { GITHUB_RUN_ATTEMPT: "2" }, "reason=ENV_INVALID"],
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
    const relative = runGuard(["--ledger", "ledger.json"]);
    assert.deepEqual(relative.lines, [FAILURE_MESSAGE, "reason=ARGUMENT_INVALID"]);
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

// 판정 동작은 그대로다: 같은 입력이면 같은 허용·거부이고, 허용이면 stdout에 결과가 나가며 stderr는 비어 있다.
test("허용 판정: 같은 날 다른 수집이 없으면 stdout에 결과를 쓰고 stderr는 비어 있다", () => {
  const result = runGuard(["--probe"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "false\n");
  assert.equal(result.stderr, "");
});
