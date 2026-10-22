import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GITHUB_API_REASON, INTERNAL_ERROR_REASON, formatReasonLine } from "./failure-reason.mjs";
import { ITX_COLLECTION_LEDGER_SCHEMA_VERSION, ITX_COLLECTION_OUTCOME, evaluateItxCollectionAllowance } from "./itx-collection-allowance.mjs";
import { readCollectionRequestCount } from "./itx-collection-evidence.mjs";

const EXPECTED_REPOSITORY = "AquilaXk/easysubway-data";
const EXPECTED_REF = "refs/heads/main";
const EXPECTED_BRANCH = "main";
// artifactPrefix: 이 workflow가 실패해도 올리는 증거 artifact(`<prefix>-<run id>`)의 이름. 없으면 실패한 run이 보낸 요청 수를 증명할 수 없다(#1298).
const COLLECTION_CONTEXTS = [
  {
    workflowFile: "itx-current-collection.yml",
    events: ["workflow_dispatch"],
    jobName: "ITX current collection",
    collectorStepName: "ITX current collection / Collect ITX current timetable",
    artifactPrefix: "itx-current-collection",
  },
  {
    workflowFile: "current-capital-topology-refresh.yml",
    events: ["schedule", "workflow_dispatch"],
    jobName: "Current topology refresh",
    collectorStepName: "Collect current ITX timetable once",
    artifactPrefix: "current-capital-topology-refresh-itx-review",
  },
  // #977: ITX 원천 시간표 자동 승격 workflow도 같은 KST 하루 공급자 호출 예산을 나눠 쓴다.
  {
    workflowFile: "itx-current-promotion.yml",
    events: ["schedule", "workflow_dispatch"],
    jobName: "ITX current promotion",
    collectorStepName: "Collect current ITX timetable",
    artifactPrefix: "itx-current-promotion",
  },
];
const ALLOW_AFTER_FAILURE_FLAG = "--allow-after-failure";
const MAX_RUNS = 100;
const MAX_JOBS = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLIS = 10_000;
const KST_OFFSET_MILLIS = 9 * 60 * 60 * 1000;
const DAY_MILLIS = 24 * 60 * 60 * 1000;
const FAILURE_MESSAGE = "ITX current collection quota guard failed";

/**
 * 가드가 실패하는 이유의 전부. 실패마다 정확히 하나가 stderr 마지막 줄(reason=)과 실패 영수증에 남는다(2026-10-22 장애 때 모든 실패가 같은 한 줄이라 원인을 알 수 없었다).
 * 판정(허용·거부)은 사유와 무관하다: 어느 사유든 가드는 막는다(fail closed).
 */
export const GUARD_REASON = Object.freeze({
  ...GITHUB_API_REASON,
  ENV_INVALID: "ENV_INVALID", // GITHUB_* 환경, 토큰, 시계, fetch 구현이 기대와 다르다
  ARGUMENT_INVALID: "ARGUMENT_INVALID", // CLI 인자·출력 경로가 기대와 다르다
  RUN_LIST_LIMIT: "RUN_LIST_LIMIT", // 한 workflow의 같은 날 run이 한 페이지 상한을 넘어 전체를 볼 수 없다
  RUN_RECORD_INVALID: "RUN_RECORD_INVALID", // run 항목의 모양이 다르다
  RUN_IDENTITY_MISMATCH: "RUN_IDENTITY_MISMATCH", // run의 event·branch·workflow 경로·생성 시각이 조회 조건과 다르거나 run이 중복이다
  CURRENT_RUN_MISMATCH: "CURRENT_RUN_MISMATCH", // 이 run이 목록에 정확히 한 번, 첫 시도로 나타나지 않는다
  JOB_LIST_EMPTY: "JOB_LIST_EMPTY", // 이전 run에 job이 없어 collector 진입 여부를 알 수 없다
  JOB_LIST_LIMIT: "JOB_LIST_LIMIT", // 한 run의 job이 한 페이지 상한을 넘는다
  JOB_RECORD_INVALID: "JOB_RECORD_INVALID", // job 항목의 모양이 다르거나 job이 중복이다
  COLLECTOR_STEP_SHAPE: "COLLECTOR_STEP_SHAPE", // collector step이 정확히 하나가 아니거나 상태·결과를 해석할 수 없다
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED", // 정상적인 예산 거부: 같은 날 이미 수집했거나 시도·요청 예산을 썼다
  RECEIPT_WRITE_FAILED: "RECEIPT_WRITE_FAILED", // 실패 영수증을 쓰지 못했다(처음 실패의 사유는 cause=)
  LEDGER_WRITE_FAILED: "LEDGER_WRITE_FAILED", // 수집 기록 파일을 쓰지 못했다
  INTERNAL_ERROR: INTERNAL_ERROR_REASON, // 위 어디에도 속하지 않는 예기치 못한 예외(원문은 비밀이 섞일 수 있어 남기지 않는다)
});

/** 가드 실패. 메시지는 기존 고정 문구 그대로이고, 사유는 코드와 숫자·이름만 담는다. */
export class ItxCollectionGuardError extends Error {
  /** @param {string} reason GUARD_REASON 값 @param {{ httpStatus?: number, workflow?: string, allowance?: string, causeReason?: string }} details */
  constructor(reason, { httpStatus, workflow, allowance, causeReason } = {}) {
    super(FAILURE_MESSAGE);
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.workflow = workflow;
    this.allowance = allowance;
    this.causeReason = causeReason;
  }
}

function failure(reason, details) {
  return new ItxCollectionGuardError(reason, details);
}

const asGuardError = (error) => (error instanceof ItxCollectionGuardError ? error : failure(GUARD_REASON.INTERNAL_ERROR));

function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw failure(GUARD_REASON.ENV_INVALID);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw failure(GUARD_REASON.ENV_INVALID);
  return parsed;
}

function requiredToken(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\r\n]/.test(value)) {
    throw failure(GUARD_REASON.ENV_INVALID);
  }
  return value;
}

function quotaWindow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw failure(GUARD_REASON.ENV_INVALID);
  const shifted = new Date(now.getTime() + KST_OFFSET_MILLIS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const startMillis = Date.UTC(year, month, day) - KST_OFFSET_MILLIS;
  const endMillis = startMillis + DAY_MILLIS - 1;
  const label = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    label,
    startMillis,
    endMillis,
    createdRange: `${new Date(startMillis).toISOString()}..${new Date(endMillis).toISOString()}`,
  };
}

function validateRun(run, window, context, event) {
  const workflow = context.workflowFile;
  if (!run || typeof run !== "object" || Array.isArray(run)
    || !Number.isSafeInteger(run.id) || run.id <= 0
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
    throw failure(GUARD_REASON.RUN_RECORD_INVALID, { workflow });
  }
  const createdAt = Date.parse(run.created_at);
  if (run.event !== event || run.head_branch !== EXPECTED_BRANCH
    || run.path !== `.github/workflows/${workflow}`
    || !Number.isFinite(createdAt) || createdAt < window.startMillis || createdAt > window.endMillis) {
    throw failure(GUARD_REASON.RUN_IDENTITY_MISMATCH, { workflow });
  }
  return run;
}

// collector step 결과를 수집 결과와 step 종료 시각으로 바꾼다. skipped면 공급자를 부르지 않았으므로 null이다.
function collectorJobOutcome(job, runId, context) {
  const workflow = context.workflowFile;
  if (!job || typeof job !== "object" || Array.isArray(job)
    || !Number.isSafeInteger(job.id) || job.id <= 0 || job.run_id !== runId
    || job.name !== context.jobName || !Array.isArray(job.steps)) {
    throw failure(GUARD_REASON.JOB_RECORD_INVALID, { workflow });
  }
  const steps = job.steps.filter((step) => step?.name === context.collectorStepName);
  if (steps.length !== 1) throw failure(GUARD_REASON.COLLECTOR_STEP_SHAPE, { workflow });
  const step = steps[0];
  if (step.status === "in_progress" && step.conclusion == null) return { outcome: ITX_COLLECTION_OUTCOME.RUNNING, completedAt: null };
  if (step.status !== "completed" || typeof step.conclusion !== "string") throw failure(GUARD_REASON.COLLECTOR_STEP_SHAPE, { workflow });
  if (step.conclusion === "skipped") return null;
  const completedAt = Date.parse(step.completed_at);
  const endedAt = Number.isFinite(completedAt) ? new Date(completedAt).toISOString() : null;
  if (step.conclusion === "success") return { outcome: ITX_COLLECTION_OUTCOME.SUCCEEDED, completedAt: endedAt };
  if (["failure", "cancelled", "timed_out", "action_required"].includes(step.conclusion)) return { outcome: ITX_COLLECTION_OUTCOME.FAILED, completedAt: endedAt };
  throw failure(GUARD_REASON.COLLECTOR_STEP_SHAPE, { workflow });
}

// 한 run에 collector job이 여럿이면 가장 소비가 확실한 결과를 고른다: 진행 중 > 성공 > 실패.
const OUTCOME_PRECEDENCE = [ITX_COLLECTION_OUTCOME.RUNNING, ITX_COLLECTION_OUTCOME.SUCCEEDED, ITX_COLLECTION_OUTCOME.FAILED];
const RUN_COMPLETED = "completed";

async function readResponse(response, workflow) {
  if (!response || typeof response.text !== "function") throw failure(GUARD_REASON.GITHUB_API_BODY_INVALID, { workflow });
  if (response.ok !== true || response.status !== 200) {
    throw failure(GUARD_REASON.GITHUB_API_STATUS, { workflow, httpStatus: Number.isSafeInteger(response.status) ? response.status : undefined });
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw failure(GUARD_REASON.GITHUB_API_REQUEST_FAILED, { workflow });
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw failure(GUARD_REASON.GITHUB_API_BODY_INVALID, { workflow });
  try {
    return JSON.parse(text);
  } catch {
    throw failure(GUARD_REASON.GITHUB_API_BODY_INVALID, { workflow });
  }
}

// GitHub REST GET 한 번. 실패 사유에는 예외 원문·URL·헤더를 싣지 않는다: fetch 예외 메시지에는 URL과 헤더가 섞일 수 있다.
async function getGithubJson({ requestUrl, token, fetchImpl, workflow }) {
  let response;
  try {
    response = await fetchImpl(requestUrl.href, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2026-03-10",
      },
    });
  } catch {
    throw failure(GUARD_REASON.GITHUB_API_REQUEST_FAILED, { workflow });
  }
  return readResponse(response, workflow);
}

// 이 run이 collector에 들어갔다면 그 결과({ outcome, completedAt }), 공급자를 부르지 않았다면 null.
// run이 아직 끝나지 않았으면 collector step이 이미 실패했어도 진행 중이다: 뒤따르는 증거 artifact 업로드가 끝나기 전에는 쓴 요청 수를 증명할 수 없다.
async function previousRunCollectorOutcome({ run, token, fetchImpl, context }) {
  const runId = run.id;
  const requestUrl = new URL(
    `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/runs/${runId}/jobs`,
  );
  requestUrl.searchParams.set("filter", "all");
  requestUrl.searchParams.set("per_page", String(MAX_JOBS));
  const workflow = context.workflowFile;
  const body = await getGithubJson({ requestUrl, token, fetchImpl, workflow });
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Number.isSafeInteger(body.total_count) || !Array.isArray(body.jobs)) {
    throw failure(GUARD_REASON.GITHUB_API_BODY_INVALID, { workflow });
  }
  if (body.total_count < 1) throw failure(GUARD_REASON.JOB_LIST_EMPTY, { workflow });
  if (body.total_count > MAX_JOBS) throw failure(GUARD_REASON.JOB_LIST_LIMIT, { workflow });
  if (body.jobs.length !== body.total_count) throw failure(GUARD_REASON.GITHUB_API_BODY_INVALID, { workflow });
  const jobIds = new Set();
  const results = [];
  for (const job of body.jobs) {
    if (jobIds.has(job?.id)) throw failure(GUARD_REASON.JOB_RECORD_INVALID, { workflow });
    jobIds.add(job?.id);
    results.push(collectorJobOutcome(job, runId, context));
  }
  for (const outcome of OUTCOME_PRECEDENCE) {
    const result = results.find((candidate) => candidate?.outcome === outcome);
    if (result !== undefined) return run.status === RUN_COMPLETED ? result : { outcome: ITX_COLLECTION_OUTCOME.RUNNING, completedAt: null };
  }
  return null;
}

// 같은 KST 날의 ITX 수집 workflow 실행을 모두 읽어, 이 run 밖에서 collector에 들어간 실행과 그 결과를 돌려준다.
async function inspectItxCollectionWindow({ env, now, fetchImpl }) {
  if (!env || typeof env !== "object") throw failure(GUARD_REASON.ENV_INVALID);
  if (env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY
    || !COLLECTION_CONTEXTS.some(({ events }) => events.includes(env.GITHUB_EVENT_NAME))
    || env.GITHUB_REF !== EXPECTED_REF) throw failure(GUARD_REASON.ENV_INVALID);

  const runId = positiveInteger(env.GITHUB_RUN_ID);
  if (positiveInteger(env.GITHUB_RUN_ATTEMPT) !== 1) throw failure(GUARD_REASON.ENV_INVALID);
  const token = requiredToken(env.GITHUB_TOKEN);
  if (typeof fetchImpl !== "function") throw failure(GUARD_REASON.ENV_INVALID);

  const window = quotaWindow(now);
  const runs = [];
  for (const context of COLLECTION_CONTEXTS) {
    for (const event of context.events) {
      const requestUrl = new URL(
        `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/workflows/${context.workflowFile}/runs`,
      );
      requestUrl.searchParams.set("event", event);
      requestUrl.searchParams.set("branch", EXPECTED_BRANCH);
      requestUrl.searchParams.set("created", window.createdRange);
      requestUrl.searchParams.set("per_page", String(MAX_RUNS));
      const workflow = context.workflowFile;
      const body = await getGithubJson({ requestUrl, token, fetchImpl, workflow }); // NOSONAR -- 순차가 의도다: 같은 KST 날 run 조회의 GitHub API 호출 수와 rate를 억제한다
      if (!body || typeof body !== "object" || Array.isArray(body)
        || !Number.isSafeInteger(body.total_count) || body.total_count < 0 || !Array.isArray(body.workflow_runs)) {
        throw failure(GUARD_REASON.GITHUB_API_BODY_INVALID, { workflow });
      }
      if (body.total_count > MAX_RUNS) throw failure(GUARD_REASON.RUN_LIST_LIMIT, { workflow });
      if (body.workflow_runs.length !== body.total_count) throw failure(GUARD_REASON.GITHUB_API_BODY_INVALID, { workflow });
      runs.push(...body.workflow_runs.map((run) => ({
        run: validateRun(run, window, context, event),
        context,
      })));
    }
  }
  if (new Set(runs.map(({ run }) => run.id)).size !== runs.length) throw failure(GUARD_REASON.RUN_IDENTITY_MISMATCH);
  const currentRuns = runs.filter(({ run }) => run.id === runId);
  if (currentRuns.length !== 1 || currentRuns[0].run.run_attempt !== 1
    || currentRuns[0].run.event !== env.GITHUB_EVENT_NAME) throw failure(GUARD_REASON.CURRENT_RUN_MISMATCH);
  const entered = [];
  for (const { run, context } of runs) {
    if (run.id === runId) continue;
    const result = await previousRunCollectorOutcome({ run, token, fetchImpl, context });
    if (result !== null) entered.push({ run, context, ...result });
  }
  return { runId, window, token, entered };
}

// 종료 시각은 collector step의 completed_at이다. run.updated_at은 재실행과 뒤이은 job 갱신으로 움직인다.
async function ledgerEntry({ run, context, outcome, completedAt }, { token, downloadArtifact }) {
  const entry = { runId: run.id, workflowFile: context.workflowFile, outcome, endedAt: null, requestCount: null };
  if (outcome !== ITX_COLLECTION_OUTCOME.FAILED) return entry;
  return {
    ...entry,
    endedAt: completedAt,
    requestCount: await readCollectionRequestCount({
      repository: EXPECTED_REPOSITORY,
      runId: run.id,
      artifactName: context.artifactPrefix === null ? null : `${context.artifactPrefix}-${run.id}`,
      token,
      downloadArtifact,
    }),
  };
}

/**
 * 같은 KST 날 이 run 밖에서 collector에 들어간 수집의 기록(#1298): 결과(성공·진행 중·실패), 실패한 수집의 종료 시각과 실제 요청 수.
 * 요청 수는 실패한 run의 증거 artifact에서만 읽고, 읽지 못하면 null로 남긴다(itx-collection-allowance가 증거 없음으로 막는다).
 */
export async function readItxCollectionLedger({ env = process.env, now = new Date(), fetchImpl = globalThis.fetch, downloadArtifact } = {}) {
  const { runId, window, token, entered } = await inspectItxCollectionWindow({ env, now, fetchImpl });
  const entries = [];
  for (const candidate of entered) entries.push(await ledgerEntry(candidate, { token, downloadArtifact }));
  entries.sort((left, right) => left.runId - right.runId);
  return { repository: EXPECTED_REPOSITORY, runId, quotaWindow: window.label, entries };
}

/**
 * 수집 직전 가드. 기본은 같은 KST 날 collector에 들어간 다른 실행이 하나라도 있으면 막는다.
 * allowAfterFailure(승격 workflow만)는 앞선 수집이 실패뿐이고 하루 시도 상한·요청 예산 안일 때 다시 허용한다. 최소 간격은 판정 단계의 정책이라 여기서는 보지 않는다.
 */
export async function guardItxCurrentCollectionBudget({
  argv = [],
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  allowAfterFailure = false,
  downloadArtifact,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0 || typeof allowAfterFailure !== "boolean") throw failure(GUARD_REASON.ARGUMENT_INVALID);
  if (allowAfterFailure) {
    const { runId, quotaWindow, entries } = await readItxCollectionLedger({ env, now, fetchImpl, downloadArtifact });
    const allowance = evaluateItxCollectionAllowance({ entries, now, skipRetryGap: true });
    if (!allowance.allowed) throw failure(GUARD_REASON.QUOTA_EXHAUSTED, { allowance: allowance.reason });
    return { repository: EXPECTED_REPOSITORY, runId, quotaWindow, otherRunCount: entries.length };
  }
  const { runId, window, entered } = await inspectItxCollectionWindow({ env, now, fetchImpl });
  if (entered.length > 0) throw failure(GUARD_REASON.QUOTA_EXHAUSTED);
  return {
    repository: EXPECTED_REPOSITORY,
    runId,
    quotaWindow: window.label,
    otherRunCount: 0,
  };
}

/**
 * 오늘 ITX를 더 수집하지 않아야 하는지 실패 없이 알려 준다(#977, #1298). topology 갱신 판정이 공급자 호출 전에 이것을 보고 정상 종료(WAIT)한다.
 * collectedToday가 true인 경우: 성공·진행 중 수집이 있다, 마지막 실패 뒤 최소 간격 전이다, 하루 시도 상한·요청 예산을 썼다, 쓴 요청 수를 증명할 수 없다.
 * 승격 workflow와 같은 allowance 규칙이라, 실패만 한 날은 예산 안에서 두 workflow 모두 다시 수집한다. 읽을 수 없으면 추정하지 않고 실패한다.
 */
export async function probeItxCollectionToday({
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  downloadArtifact,
} = {}) {
  const { runId, quotaWindow, entries } = await readItxCollectionLedger({ env, now, fetchImpl, downloadArtifact });
  return { repository: EXPECTED_REPOSITORY, runId, quotaWindow, collectedToday: !evaluateItxCollectionAllowance({ entries, now }).allowed };
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw failure(GUARD_REASON.ARGUMENT_INVALID);
  return value;
}

function receiptOutput(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--output"
    || typeof argv[1] !== "string" || !path.isAbsolute(argv[1]) || path.basename(argv[1]) !== "freshness.json") {
    throw failure(GUARD_REASON.ARGUMENT_INVALID);
  }
  return argv[1];
}

// 영수증에는 사유 코드와 숫자·이름만 남긴다(reason, httpStatus, workflow, allowance). 값이 없는 키는 JSON에서 빠진다.
async function writeFailureReceipt(output, { reason, httpStatus, workflow, allowance }) {
  const receipt = {
    schemaVersion: 1,
    artifactKind: "itx-current-collection-preflight",
    status: "FAILED",
    operation: "KST_PROVIDER_ENTRY_QUOTA",
    providerCalls: 0,
    candidateCreated: false,
    credentialRedacted: true,
    reason,
    httpStatus,
    workflow,
    allowance,
  };
  try {
    await writeFile(output, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o644 });
  } catch {
    throw failure(GUARD_REASON.RECEIPT_WRITE_FAILED, { causeReason: reason });
  }
}

// 가드 인자: --output <절대 경로>/freshness.json [--allow-after-failure]
function guardCliArgs(argv) {
  const allowAfterFailure = Array.isArray(argv) && argv.length === 3 && argv[2] === ALLOW_AFTER_FAILURE_FLAG;
  return { output: receiptOutput(allowAfterFailure ? argv.slice(0, 2) : argv), allowAfterFailure };
}

export async function runItxCurrentCollectionBudgetGuardCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  downloadArtifact,
} = {}) {
  const { output, allowAfterFailure } = guardCliArgs(argv);
  try {
    return await guardItxCurrentCollectionBudget({ argv: [], env, now, fetchImpl, allowAfterFailure, downloadArtifact });
  } catch (error) {
    const failed = asGuardError(error);
    await writeFailureReceipt(output, failed);
    throw failed;
  }
}

/**
 * 같은 KST 날 수집 기록을 파일로 쓴다(--ledger <절대 경로>). 승격 판정이 공급자 호출 전에 읽는다. 이미 있는 파일은 덮어쓰지 않는다.
 * 읽을 수 없으면 추정하지 않고 실패한다.
 */
export async function runItxCollectionLedgerCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  downloadArtifact,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--ledger") throw failure(GUARD_REASON.ARGUMENT_INVALID);
  const output = absolutePath(argv[1]);
  let ledger;
  try {
    ledger = await readItxCollectionLedger({ env, now, fetchImpl, downloadArtifact });
  } catch (error) {
    throw asGuardError(error);
  }
  const { quotaWindow, entries } = ledger;
  try {
    await writeFile(output, `${JSON.stringify({ schemaVersion: ITX_COLLECTION_LEDGER_SCHEMA_VERSION, quotaWindow, entries })}\n`, { flag: "wx", mode: 0o644 });
  } catch {
    throw failure(GUARD_REASON.LEDGER_WRITE_FAILED);
  }
  return { quotaWindow, entries };
}

// 실패하면 기존 고정 문구 줄 뒤에 사유 줄(reason=...)을 stderr에 쓴다. 문구를 읽는 쪽은 첫 줄만 보면 된다.
async function main() {
  const argv = process.argv.slice(2);
  try {
    if (argv.length === 1 && argv[0] === "--probe") {
      const { collectedToday } = await probeItxCollectionToday();
      process.stdout.write(`${collectedToday}\n`);
    } else if (argv[0] === "--ledger") {
      await runItxCollectionLedgerCli();
    } else {
      process.stdout.write(`${JSON.stringify(await runItxCurrentCollectionBudgetGuardCli())}\n`);
    }
  } catch (error) {
    process.stderr.write(`${FAILURE_MESSAGE}\n${formatReasonLine(asGuardError(error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
