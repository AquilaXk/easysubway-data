import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
    artifactPrefix: null,
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
const ALLOW_FAILED_RETRY_FLAG = "--allow-failed-retry";
const MAX_RUNS = 100;
const MAX_JOBS = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLIS = 10_000;
const KST_OFFSET_MILLIS = 9 * 60 * 60 * 1000;
const DAY_MILLIS = 24 * 60 * 60 * 1000;
const FAILURE_MESSAGE = "ITX current collection quota guard failed";

function failure() {
  return new Error(FAILURE_MESSAGE);
}

function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw failure();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw failure();
  return parsed;
}

function requiredToken(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\r\n]/.test(value)) {
    throw failure();
  }
  return value;
}

function quotaWindow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw failure();
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
  if (!run || typeof run !== "object" || Array.isArray(run)) throw failure();
  if (!Number.isSafeInteger(run.id) || run.id <= 0) throw failure();
  if (run.event !== event || run.head_branch !== EXPECTED_BRANCH) throw failure();
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) throw failure();
  if (run.path !== `.github/workflows/${context.workflowFile}`) throw failure();
  const createdAt = Date.parse(run.created_at);
  if (!Number.isFinite(createdAt) || createdAt < window.startMillis || createdAt > window.endMillis) {
    throw failure();
  }
  return run;
}

// collector step 결과를 수집 결과로 바꾼다. skipped면 공급자를 부르지 않았으므로 null이다.
function collectorJobOutcome(job, runId, context) {
  if (!job || typeof job !== "object" || Array.isArray(job)
    || !Number.isSafeInteger(job.id) || job.id <= 0 || job.run_id !== runId
    || job.name !== context.jobName || !Array.isArray(job.steps)) {
    throw failure();
  }
  const steps = job.steps.filter((step) => step?.name === context.collectorStepName);
  if (steps.length !== 1) throw failure();
  const step = steps[0];
  if (step.status === "in_progress" && step.conclusion == null) return ITX_COLLECTION_OUTCOME.RUNNING;
  if (step.status !== "completed" || typeof step.conclusion !== "string") throw failure();
  if (step.conclusion === "skipped") return null;
  if (step.conclusion === "success") return ITX_COLLECTION_OUTCOME.SUCCEEDED;
  if (["failure", "cancelled", "timed_out", "action_required"].includes(step.conclusion)) return ITX_COLLECTION_OUTCOME.FAILED;
  throw failure();
}

// 한 run에 collector job이 여럿이면 가장 소비가 확실한 결과를 고른다: 진행 중 > 성공 > 실패.
const OUTCOME_PRECEDENCE = [ITX_COLLECTION_OUTCOME.RUNNING, ITX_COLLECTION_OUTCOME.SUCCEEDED, ITX_COLLECTION_OUTCOME.FAILED];

async function readResponse(response) {
  if (!response || response.ok !== true || response.status !== 200 || typeof response.text !== "function") {
    throw failure();
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw failure();
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw failure();
  try {
    return JSON.parse(text);
  } catch {
    throw failure();
  }
}

// 이 run이 collector에 들어갔다면 그 결과, 공급자를 부르지 않았다면 null.
async function previousRunCollectorOutcome({ runId, token, fetchImpl, context }) {
  const requestUrl = new URL(
    `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/runs/${runId}/jobs`,
  );
  requestUrl.searchParams.set("filter", "all");
  requestUrl.searchParams.set("per_page", String(MAX_JOBS));
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
    throw failure();
  }
  const body = await readResponse(response);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Number.isSafeInteger(body.total_count) || body.total_count < 1 || body.total_count > MAX_JOBS
    || !Array.isArray(body.jobs) || body.jobs.length !== body.total_count) {
    throw failure();
  }
  const jobIds = new Set();
  const outcomes = new Set();
  for (const job of body.jobs) {
    if (jobIds.has(job?.id)) throw failure();
    jobIds.add(job?.id);
    outcomes.add(collectorJobOutcome(job, runId, context));
  }
  return OUTCOME_PRECEDENCE.find((outcome) => outcomes.has(outcome)) ?? null;
}

// 같은 KST 날의 ITX 수집 workflow 실행을 모두 읽어, 이 run 밖에서 collector에 들어간 실행과 그 결과를 돌려준다.
async function inspectItxCollectionWindow({ env, now, fetchImpl }) {
  if (!env || typeof env !== "object") throw failure();
  if (env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY
    || !COLLECTION_CONTEXTS.some(({ events }) => events.includes(env.GITHUB_EVENT_NAME))
    || env.GITHUB_REF !== EXPECTED_REF) throw failure();

  const runId = positiveInteger(env.GITHUB_RUN_ID);
  if (positiveInteger(env.GITHUB_RUN_ATTEMPT) !== 1) throw failure();
  const token = requiredToken(env.GITHUB_TOKEN);
  if (typeof fetchImpl !== "function") throw failure();

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
        throw failure();
      }
      const body = await readResponse(response);
      if (!body || typeof body !== "object" || Array.isArray(body)
        || !Number.isSafeInteger(body.total_count) || body.total_count < 0 || body.total_count > MAX_RUNS
        || !Array.isArray(body.workflow_runs) || body.workflow_runs.length !== body.total_count) {
        throw failure();
      }
      runs.push(...body.workflow_runs.map((run) => ({
        run: validateRun(run, window, context, event),
        context,
      })));
    }
  }
  if (new Set(runs.map(({ run }) => run.id)).size !== runs.length) throw failure();
  const currentRuns = runs.filter(({ run }) => run.id === runId);
  if (currentRuns.length !== 1 || currentRuns[0].run.run_attempt !== 1
    || currentRuns[0].run.event !== env.GITHUB_EVENT_NAME) throw failure();
  const entered = [];
  for (const { run, context } of runs) {
    if (run.id === runId) continue;
    const outcome = await previousRunCollectorOutcome({ runId: run.id, token, fetchImpl, context });
    if (outcome !== null) entered.push({ run, context, outcome });
  }
  return { runId, window, token, entered };
}

async function ledgerEntry({ run, context, outcome }, { token, fetchImpl }) {
  const entry = { runId: run.id, workflowFile: context.workflowFile, outcome, endedAt: null, requestCount: null };
  if (outcome !== ITX_COLLECTION_OUTCOME.FAILED) return entry;
  const updatedAt = Date.parse(run.updated_at);
  return {
    ...entry,
    endedAt: Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : null,
    requestCount: await readCollectionRequestCount({
      repository: EXPECTED_REPOSITORY,
      runId: run.id,
      artifactName: context.artifactPrefix === null ? null : `${context.artifactPrefix}-${run.id}`,
      token,
      fetchImpl,
    }),
  };
}

/**
 * 같은 KST 날 이 run 밖에서 collector에 들어간 수집의 기록(#1298): 결과(성공·진행 중·실패), 실패한 수집의 종료 시각과 실제 요청 수.
 * 요청 수는 실패한 run의 증거 artifact에서만 읽고, 읽지 못하면 null로 남긴다(itx-collection-allowance가 증거 없음으로 막는다).
 */
export async function readItxCollectionLedger({ env = process.env, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const { runId, window, token, entered } = await inspectItxCollectionWindow({ env, now, fetchImpl });
  const entries = [];
  for (const candidate of entered) entries.push(await ledgerEntry(candidate, { token, fetchImpl }));
  entries.sort((left, right) => left.runId - right.runId);
  return { repository: EXPECTED_REPOSITORY, runId, quotaWindow: window.label, entries };
}

/**
 * 수집 직전 가드. 기본은 같은 KST 날 collector에 들어간 다른 실행이 하나라도 있으면 막는다.
 * allowFailedRetry(승격 workflow만)는 앞선 수집이 실패뿐이고 하루 시도 상한·요청 예산 안일 때 다시 허용한다. 최소 간격은 판정 단계의 정책이라 여기서는 보지 않는다.
 */
export async function guardItxCurrentCollectionBudget({
  argv = [],
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  allowFailedRetry = false,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0 || typeof allowFailedRetry !== "boolean") throw failure();
  if (allowFailedRetry) {
    const { runId, quotaWindow, entries } = await readItxCollectionLedger({ env, now, fetchImpl });
    if (!evaluateItxCollectionAllowance({ entries, now, skipRetryGap: true }).allowed) throw failure();
    return { repository: EXPECTED_REPOSITORY, runId, quotaWindow, otherRunCount: entries.length };
  }
  const { runId, window, entered } = await inspectItxCollectionWindow({ env, now, fetchImpl });
  if (entered.length > 0) throw failure();
  return {
    repository: EXPECTED_REPOSITORY,
    runId,
    quotaWindow: window.label,
    otherRunCount: 0,
  };
}

/**
 * 같은 KST 날 다른 ITX 수집 workflow가 이미 collector에 들어갔는지 실패 없이 알려 준다(#977).
 * 판정 단계가 공급자 호출 전에 이것을 보고 정상 종료(WAIT)한다. 읽을 수 없으면 추정하지 않고 실패한다.
 */
export async function probeItxCollectionToday({
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const { runId, window, entered } = await inspectItxCollectionWindow({ env, now, fetchImpl });
  return { repository: EXPECTED_REPOSITORY, runId, quotaWindow: window.label, collectedToday: entered.length > 0 };
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw failure();
  return value;
}

function receiptOutput(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--output"
    || typeof argv[1] !== "string" || !path.isAbsolute(argv[1]) || path.basename(argv[1]) !== "freshness.json") {
    throw failure();
  }
  return argv[1];
}

async function writeFailureReceipt(output) {
  const receipt = {
    schemaVersion: 1,
    artifactKind: "itx-current-collection-preflight",
    status: "FAILED",
    operation: "KST_PROVIDER_ENTRY_QUOTA",
    providerCalls: 0,
    candidateCreated: false,
    credentialRedacted: true,
  };
  try {
    await writeFile(output, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o644 });
  } catch {
    throw failure();
  }
}

// 가드 인자: --output <절대 경로>/freshness.json [--allow-failed-retry]
function guardCliArgs(argv) {
  const allowFailedRetry = Array.isArray(argv) && argv.length === 3 && argv[2] === ALLOW_FAILED_RETRY_FLAG;
  return { output: receiptOutput(allowFailedRetry ? argv.slice(0, 2) : argv), allowFailedRetry };
}

export async function runItxCurrentCollectionBudgetGuardCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const { output, allowFailedRetry } = guardCliArgs(argv);
  try {
    return await guardItxCurrentCollectionBudget({ argv: [], env, now, fetchImpl, allowFailedRetry });
  } catch {
    await writeFailureReceipt(output);
    throw failure();
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
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--ledger") throw failure();
  const output = absolutePath(argv[1]);
  try {
    const { quotaWindow, entries } = await readItxCollectionLedger({ env, now, fetchImpl });
    await writeFile(output, `${JSON.stringify({ schemaVersion: ITX_COLLECTION_LEDGER_SCHEMA_VERSION, quotaWindow, entries })}\n`, { flag: "wx", mode: 0o644 });
    return { quotaWindow, entries };
  } catch {
    throw failure();
  }
}

async function main() {
  const [flag] = process.argv.slice(2);
  if (process.argv.length === 3 && flag === "--probe") {
    try {
      const { collectedToday } = await probeItxCollectionToday();
      process.stdout.write(`${collectedToday}\n`);
    } catch {
      process.stderr.write(`${FAILURE_MESSAGE}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (flag === "--ledger") {
    try {
      await runItxCollectionLedgerCli();
    } catch {
      process.stderr.write(`${FAILURE_MESSAGE}\n`);
      process.exitCode = 1;
    }
    return;
  }
  try {
    const result = await runItxCurrentCollectionBudgetGuardCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(`${FAILURE_MESSAGE}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
