import { pathToFileURL } from "node:url";

const EXPECTED_REPOSITORY = "AquilaXk/easysubway-data";
const EXPECTED_EVENT = "workflow_dispatch";
const EXPECTED_REF = "refs/heads/main";
const EXPECTED_BRANCH = "main";
const WORKFLOW_FILE = "itx-current-collection.yml";
const MAX_RUNS = 100;
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

function validateRun(run, window) {
  if (!run || typeof run !== "object" || Array.isArray(run)) throw failure();
  if (!Number.isSafeInteger(run.id) || run.id <= 0) throw failure();
  if (run.event !== EXPECTED_EVENT || run.head_branch !== EXPECTED_BRANCH) throw failure();
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) throw failure();
  if (typeof run.path !== "string"
    || !run.path.startsWith(`.github/workflows/${WORKFLOW_FILE}@`)) throw failure();
  const createdAt = Date.parse(run.created_at);
  if (!Number.isFinite(createdAt) || createdAt < window.startMillis || createdAt > window.endMillis) {
    throw failure();
  }
  return run;
}

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

export async function guardItxCurrentCollectionBudget({
  argv = [],
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw failure();
  if (!env || typeof env !== "object") throw failure();
  if (env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY
    || env.GITHUB_EVENT_NAME !== EXPECTED_EVENT
    || env.GITHUB_REF !== EXPECTED_REF) throw failure();

  const runId = positiveInteger(env.GITHUB_RUN_ID);
  if (positiveInteger(env.GITHUB_RUN_ATTEMPT) !== 1) throw failure();
  const token = requiredToken(env.GITHUB_TOKEN);
  if (typeof fetchImpl !== "function") throw failure();

  const window = quotaWindow(now);
  const requestUrl = new URL(
    `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs`,
  );
  requestUrl.searchParams.set("event", EXPECTED_EVENT);
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

  const runs = body.workflow_runs.map((run) => validateRun(run, window));
  const currentRuns = runs.filter((run) => run.id === runId);
  if (currentRuns.length !== 1 || currentRuns[0].run_attempt !== 1 || runs.length !== 1) throw failure();

  return {
    repository: EXPECTED_REPOSITORY,
    runId,
    quotaWindow: window.label,
    otherRunCount: 0,
  };
}

async function main() {
  try {
    const result = await guardItxCurrentCollectionBudget({ argv: process.argv.slice(2) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(`${FAILURE_MESSAGE}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
