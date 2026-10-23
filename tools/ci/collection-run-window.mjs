// 공급자 하루 호출 예산을 지키는 가드들이 같은 KST 날의 수집 workflow run을 읽는 공용 부분(#1298, Refs AquilaXk/easysubway#3036).
// ITX 수집 가드(guard-itx-current-collection-budget)와 부산 원천 호출 기록(provider-call-ledger)이 같은 규칙으로 run과 collector step을 읽는다.
// 읽을 수 없거나 모양이 기대와 다르면 추정하지 않고 COLLECTION_WINDOW_REASON 코드로 실패한다(fail closed).
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { GITHUB_API_REASON } from "./failure-reason.mjs";

const execFileAsync = promisify(execFile);
export const COLLECTION_REPOSITORY = "AquilaXk/easysubway-data";
const EXPECTED_REF = "refs/heads/main";
const EXPECTED_BRANCH = "main";
const MAX_RUNS = 100;
const MAX_JOBS = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLIS = 10_000;
const DOWNLOAD_TIMEOUT_MILLIS = 120_000;
const KST_OFFSET_MILLIS = 9 * 60 * 60 * 1000;
const DAY_MILLIS = 24 * 60 * 60 * 1000;

/** run 창을 읽다 멈추는 이유. 가드마다 이 코드를 자기 사유 목록에 그대로 싣는다. */
export const COLLECTION_WINDOW_REASON = Object.freeze({
  ...GITHUB_API_REASON,
  ENV_INVALID: "ENV_INVALID", // GITHUB_* 환경, 토큰, 시계, fetch 구현이 기대와 다르다
  RUN_LIST_LIMIT: "RUN_LIST_LIMIT", // 한 workflow의 같은 날 run이 한 페이지 상한을 넘어 전체를 볼 수 없다
  RUN_RECORD_INVALID: "RUN_RECORD_INVALID", // run 항목의 모양이 다르다
  RUN_IDENTITY_MISMATCH: "RUN_IDENTITY_MISMATCH", // run의 event·branch·workflow 경로·생성 시각이 조회 조건과 다르거나 run이 중복이다
  CURRENT_RUN_MISMATCH: "CURRENT_RUN_MISMATCH", // 이 run이 목록에 정확히 한 번, 첫 시도로 나타나지 않는다
  JOB_LIST_EMPTY: "JOB_LIST_EMPTY", // 이전 run에 job이 없어 collector 진입 여부를 알 수 없다
  JOB_LIST_LIMIT: "JOB_LIST_LIMIT", // 한 run의 job이 한 페이지 상한을 넘는다
  JOB_RECORD_INVALID: "JOB_RECORD_INVALID", // job 항목의 모양이 다르거나 job이 중복이다
  COLLECTOR_STEP_SHAPE: "COLLECTOR_STEP_SHAPE", // collector step이 정확히 하나가 아니거나 상태·결과를 해석할 수 없다
});

/** collector step의 결과. 같은 KST 날의 기록 항목이 이 값을 싣는다. */
export const COLLECTION_OUTCOME = Object.freeze({ SUCCEEDED: "SUCCEEDED", RUNNING: "RUNNING", FAILED: "FAILED" });

/** run 창 읽기 실패. 메시지는 고정이고 사유는 코드와 숫자·이름만 담는다. 가드는 이것을 자기 오류로 바꿔 던진다. */
export class CollectionWindowError extends Error {
  /** @param {string} reason COLLECTION_WINDOW_REASON 값 @param {{ httpStatus?: number, workflow?: string }} details */
  constructor(reason, { httpStatus, workflow } = {}) {
    super("collection run window could not be read");
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.workflow = workflow;
  }
}

const failure = (reason, details) => new CollectionWindowError(reason, details);

function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw failure(COLLECTION_WINDOW_REASON.ENV_INVALID);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw failure(COLLECTION_WINDOW_REASON.ENV_INVALID);
  return parsed;
}

function requiredToken(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\r\n]/.test(value)) {
    throw failure(COLLECTION_WINDOW_REASON.ENV_INVALID);
  }
  return value;
}

/** now가 속한 KST 날: 라벨(YYYY-MM-DD), UTC 시작·끝 밀리초, GitHub created 조회 범위. */
export function kstQuotaWindow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw failure(COLLECTION_WINDOW_REASON.ENV_INVALID);
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
    throw failure(COLLECTION_WINDOW_REASON.RUN_RECORD_INVALID, { workflow });
  }
  const createdAt = Date.parse(run.created_at);
  if (run.event !== event || run.head_branch !== EXPECTED_BRANCH
    || run.path !== `.github/workflows/${workflow}`
    || !Number.isFinite(createdAt) || createdAt < window.startMillis || createdAt > window.endMillis) {
    throw failure(COLLECTION_WINDOW_REASON.RUN_IDENTITY_MISMATCH, { workflow });
  }
  return run;
}

// collector step 결과를 수집 결과와 step 종료 시각으로 바꾼다. skipped면 공급자를 부르지 않았으므로 null이다.
function collectorJobOutcome(job, runId, context) {
  const workflow = context.workflowFile;
  if (!job || typeof job !== "object" || Array.isArray(job)
    || !Number.isSafeInteger(job.id) || job.id <= 0 || job.run_id !== runId
    || job.name !== context.jobName || !Array.isArray(job.steps)) {
    throw failure(COLLECTION_WINDOW_REASON.JOB_RECORD_INVALID, { workflow });
  }
  if (job.steps.length === 0 && job.conclusion === "skipped") return null;
  const steps = job.steps.filter((step) => step?.name === context.collectorStepName);
  if (steps.length !== 1) throw failure(COLLECTION_WINDOW_REASON.COLLECTOR_STEP_SHAPE, { workflow });
  const step = steps[0];
  if (step.status === "in_progress" && step.conclusion == null) return { outcome: COLLECTION_OUTCOME.RUNNING, completedAt: null };
  if (step.status !== "completed" || typeof step.conclusion !== "string") throw failure(COLLECTION_WINDOW_REASON.COLLECTOR_STEP_SHAPE, { workflow });
  if (step.conclusion === "skipped") return null;
  const completedAt = Date.parse(step.completed_at);
  const endedAt = Number.isFinite(completedAt) ? new Date(completedAt).toISOString() : null;
  if (step.conclusion === "success") return { outcome: COLLECTION_OUTCOME.SUCCEEDED, completedAt: endedAt };
  if (["failure", "cancelled", "timed_out", "action_required"].includes(step.conclusion)) return { outcome: COLLECTION_OUTCOME.FAILED, completedAt: endedAt };
  throw failure(COLLECTION_WINDOW_REASON.COLLECTOR_STEP_SHAPE, { workflow });
}

// 한 run에 collector job이 여럿이면 가장 소비가 확실한 결과를 고른다: 진행 중 > 성공 > 실패.
const OUTCOME_PRECEDENCE = [COLLECTION_OUTCOME.RUNNING, COLLECTION_OUTCOME.SUCCEEDED, COLLECTION_OUTCOME.FAILED];
const RUN_COMPLETED = "completed";

async function readResponse(response, workflow) {
  if (!response || typeof response.text !== "function") throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_BODY_INVALID, { workflow });
  if (response.ok !== true || response.status !== 200) {
    throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_STATUS, { workflow, httpStatus: Number.isSafeInteger(response.status) ? response.status : undefined });
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_REQUEST_FAILED, { workflow });
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_BODY_INVALID, { workflow });
  try {
    return JSON.parse(text);
  } catch {
    throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_BODY_INVALID, { workflow });
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
    throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_REQUEST_FAILED, { workflow });
  }
  return readResponse(response, workflow);
}

// 이 run이 collector에 들어갔다면 그 결과({ outcome, completedAt }), 공급자를 부르지 않았다면 null.
// run이 아직 끝나지 않았으면 collector step이 이미 실패했어도 진행 중이다: 뒤따르는 증거 artifact 업로드가 끝나기 전에는 쓴 요청 수를 증명할 수 없다.
async function previousRunCollectorOutcome({ run, token, fetchImpl, context }) {
  const runId = run.id;
  const requestUrl = new URL(
    `https://api.github.com/repos/${COLLECTION_REPOSITORY}/actions/runs/${runId}/jobs`,
  );
  requestUrl.searchParams.set("filter", "all");
  requestUrl.searchParams.set("per_page", String(MAX_JOBS));
  const workflow = context.workflowFile;
  const body = await getGithubJson({ requestUrl, token, fetchImpl, workflow });
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Number.isSafeInteger(body.total_count) || !Array.isArray(body.jobs)) {
    throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_BODY_INVALID, { workflow });
  }
  if (body.total_count < 1) throw failure(COLLECTION_WINDOW_REASON.JOB_LIST_EMPTY, { workflow });
  if (body.total_count > MAX_JOBS) throw failure(COLLECTION_WINDOW_REASON.JOB_LIST_LIMIT, { workflow });
  if (body.jobs.length !== body.total_count) throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_BODY_INVALID, { workflow });
  const jobIds = new Set();
  const results = [];
  for (const job of body.jobs) {
    if (jobIds.has(job?.id)) throw failure(COLLECTION_WINDOW_REASON.JOB_RECORD_INVALID, { workflow });
    jobIds.add(job?.id);
    results.push(collectorJobOutcome(job, runId, context));
  }
  for (const outcome of OUTCOME_PRECEDENCE) {
    const result = results.find((candidate) => candidate?.outcome === outcome);
    if (result !== undefined) return run.status === RUN_COMPLETED ? result : { outcome: COLLECTION_OUTCOME.RUNNING, completedAt: null };
  }
  return null;
}

async function listWindowRuns({ window, token, fetchImpl, context, event }) {
  const requestUrl = new URL(
    `https://api.github.com/repos/${COLLECTION_REPOSITORY}/actions/workflows/${context.workflowFile}/runs`,
  );
  requestUrl.searchParams.set("event", event);
  requestUrl.searchParams.set("branch", EXPECTED_BRANCH);
  requestUrl.searchParams.set("created", window.createdRange);
  requestUrl.searchParams.set("per_page", String(MAX_RUNS));
  const workflow = context.workflowFile;
  const body = await getGithubJson({ requestUrl, token, fetchImpl, workflow });
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Number.isSafeInteger(body.total_count) || body.total_count < 0 || !Array.isArray(body.workflow_runs)) {
    throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_BODY_INVALID, { workflow });
  }
  if (body.total_count > MAX_RUNS) throw failure(COLLECTION_WINDOW_REASON.RUN_LIST_LIMIT, { workflow });
  if (body.workflow_runs.length !== body.total_count) throw failure(COLLECTION_WINDOW_REASON.GITHUB_API_BODY_INVALID, { workflow });
  return body.workflow_runs.map((run) => ({ run: validateRun(run, window, context, event), context }));
}

/**
 * 같은 KST 날 contexts의 workflow 실행을 모두 읽어, 이 run 밖에서 collector에 들어간 실행과 그 결과를 돌려준다.
 * @param {{ env: object, now: Date, fetchImpl: Function, contexts: { workflowFile: string, events: string[], jobName: string, collectorStepName: string }[] }} input
 * @returns {Promise<{ runId: number, window: ReturnType<typeof kstQuotaWindow>, token: string, entered: { run: object, context: object, outcome: string, completedAt: string | null }[] }>}
 */
export async function inspectCollectionWindow({ env, now, fetchImpl, contexts }) {
  if (!env || typeof env !== "object") throw failure(COLLECTION_WINDOW_REASON.ENV_INVALID);
  if (env.GITHUB_REPOSITORY !== COLLECTION_REPOSITORY
    || !contexts.some(({ events }) => events.includes(env.GITHUB_EVENT_NAME))
    || env.GITHUB_REF !== EXPECTED_REF) throw failure(COLLECTION_WINDOW_REASON.ENV_INVALID);

  const runId = positiveInteger(env.GITHUB_RUN_ID);
  if (positiveInteger(env.GITHUB_RUN_ATTEMPT) !== 1) throw failure(COLLECTION_WINDOW_REASON.ENV_INVALID);
  const token = requiredToken(env.GITHUB_TOKEN);
  if (typeof fetchImpl !== "function") throw failure(COLLECTION_WINDOW_REASON.ENV_INVALID);

  const window = kstQuotaWindow(now);
  const runs = [];
  for (const context of contexts) {
    for (const event of context.events) {
      runs.push(...await listWindowRuns({ window, token, fetchImpl, context, event })); // NOSONAR -- 순차가 의도다: 같은 KST 날 run 조회의 GitHub API 호출 수와 rate를 억제한다
    }
  }
  if (new Set(runs.map(({ run }) => run.id)).size !== runs.length) throw failure(COLLECTION_WINDOW_REASON.RUN_IDENTITY_MISMATCH);
  const currentRuns = runs.filter(({ run }) => run.id === runId);
  if (currentRuns.length !== 1 || currentRuns[0].run.run_attempt !== 1
    || currentRuns[0].run.event !== env.GITHUB_EVENT_NAME) throw failure(COLLECTION_WINDOW_REASON.CURRENT_RUN_MISMATCH);
  const entered = [];
  for (const { run, context } of runs) {
    if (run.id === runId) continue;
    const result = await previousRunCollectorOutcome({ run, token, fetchImpl, context }); // NOSONAR -- 순차가 의도다: GitHub REST 권장대로 같은 토큰의 요청을 동시에 보내지 않아 secondary rate limit을 피한다
    if (result !== null) entered.push({ run, context, ...result });
  }
  return { runId, window, token, entered };
}

/** 기본 내려받기: gh run download <run id> --name <artifact> --dir <빈 디렉터리>. artifact가 없거나 만료됐으면 gh가 실패한다. */
export async function downloadArtifactWithGh({ repository, runId, artifactName, directory, token }) {
  await execFileAsync("gh", ["run", "download", String(runId), "--repo", repository, "--name", artifactName, "--dir", directory], {
    env: { ...process.env, GH_TOKEN: token },
    timeout: DOWNLOAD_TIMEOUT_MILLIS,
  });
}

/** 내려받은 증거 파일 하나: 일반 파일(심볼릭 링크 아님)이고 크기 상한 안일 때만 읽는다. 없으면 null. */
export async function readEvidenceFile(directory, name, maxBytes) {
  const file = path.join(directory, name);
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${name} is not a regular file within its size limit`);
  return readFile(file);
}
