// 공급자 operation별 KST 하루 호출 예산(Refs AquilaXk/easysubway#3036, data #1435). ITX 수집의 하루 예산 규칙(itx-collection-allowance, #1298)을
// 원천 재확인의 결속 묶음(부산 topology·접근성·시간표)에 옮긴 것이다. 원천 재확인 판정(decide-source-reverification)이 묶음을 시작하기 전에 부른다.
//
// 같은 KST 날의 호출 기록(provider-call-ledger가 앞선 run의 계측 artifact에서 읽은 operation별 요청 수)으로 정한다.
//   기록을 읽지 못했거나 요청 수 증거가 없는 run이 있다       PROVIDER_CALL_EVIDENCE_MISSING      쓴 요청 수를 모르면 추정하지 않고 막는다.
//   묶음 operation을 부른 run이 하루 상한에 닿았다            PROVIDER_DAILY_ATTEMPTS_EXHAUSTED   싼 실패가 되풀이돼도 그날은 더 보내지 않는다.
//   operation 하나라도 쓴 요청 + 이번 묶음 요청이 한도를 넘는다 PROVIDER_DAILY_BUDGET_INSUFFICIENT  묶음 중간에 한도에 닿지 않게 아예 시작하지 않는다.
// 상한과 한도 거부(ATTEMPTS_EXHAUSTED, BUDGET_INSUFFICIENT)는 그 KST 날이 끝날 때까지 풀리지 않는다(쓴 요청 수는 줄지 않는다).
// 증거 거부(EVIDENCE_MISSING)는 원인에 따라 다르다. run 창을 읽지 못한 경우와 아직 진행 중인 run(요청 수가 아직 없다)은 다음 run에서 풀릴 수 있다.
// 끝났는데 계측 파일을 증명할 수 없는 run(artifact·파일 없음, 손상, 기록 유실)은 그 날이 끝날 때까지 증명되지 않은 채 남는다.
// 판정은 묶음을 빼고, workflow가 job을 실패시켜 실패 이슈로 드러낸다.
import { isSafeToken } from "../lib/safe-token.mjs";
import { MAX_RUNS } from "./collection-run-window.mjs";

export const PROVIDER_CALL_LEDGER_SCHEMA_VERSION = 1;
/** 호출 기록이 읽는 source-reverification 실행 event. 호출 기록(provider-call-ledger)이 이 목록으로 run 창을 조회한다. */
export const SOURCE_REVERIFICATION_EVENTS = Object.freeze(["schedule", "workflow_dispatch"]);
export const PROVIDER_BUDGET_REASON = Object.freeze({
  EVIDENCE_MISSING: "PROVIDER_CALL_EVIDENCE_MISSING",
  ATTEMPTS_EXHAUSTED: "PROVIDER_DAILY_ATTEMPTS_EXHAUSTED",
  BUDGET_INSUFFICIENT: "PROVIDER_DAILY_BUDGET_INSUFFICIENT",
});
/** 묶음이 예산에 막히면 job을 실패시키는 source-reverification step. 관리자 자동화 상태가 같은 이름으로 오늘의 막힘을 찾는다. */
export const PROVIDER_BUDGET_BLOCK_STEP = "Fail recipes blocked by the provider daily call budget";

const POLICY_KIND = "provider-daily-call-budget-policy";
// 한 KST 날 run 목록은 event마다 한 페이지 MAX_RUNS개까지라서 기록 항목도 그 곱을 넘지 않는다(collection-run-window).
const MAX_LEDGER_ENTRIES = MAX_RUNS * SOURCE_REVERIFICATION_EVENTS.length;
const OUTCOMES = new Set(["SUCCEEDED", "RUNNING", "FAILED"]);
const QUOTA_WINDOW = /^\d{4}-\d{2}-\d{2}$/u;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function policyInvalid(detail) {
  throw new Error(`PROVIDER_BUDGET_POLICY_INVALID: ${detail}`);
}

function inputInvalid(detail) {
  throw new Error(`PROVIDER_BUDGET_INPUT_INVALID: ${detail}`);
}

function parseOperation(operation) {
  if (!isPlainObject(operation) || !isSafeToken(operation.sourceId)) policyInvalid("operation sourceId");
  if (!positiveInteger(operation.dailyRequestLimit)) policyInvalid(`${operation.sourceId} dailyRequestLimit must be a positive integer`);
  if (typeof operation.expectedRequestsEvidence !== "string" || operation.expectedRequestsEvidence === "") policyInvalid(`${operation.sourceId} expectedRequestsEvidence`);
  if (typeof operation.datasetUrl !== "string" || !operation.datasetUrl.startsWith("https://")) policyInvalid(`${operation.sourceId} datasetUrl`);
  return Object.freeze({ sourceId: operation.sourceId, dailyRequestLimit: operation.dailyRequestLimit, expectedRequestsEvidence: operation.expectedRequestsEvidence });
}

/** release/product-gates/provider-daily-call-budget.json을 판정이 쓰는 모양으로 읽는다. 어긋나면 추정하지 않고 실패한다. */
export function parseProviderCallBudgetPolicy(policy) {
  if (!isPlainObject(policy) || policy.schemaVersion !== 1 || policy.artifactKind !== POLICY_KIND || policy.quotaWindow !== "KST_DAY") policyInvalid("header");
  if (!positiveInteger(policy.maxCollectionsPerDay)) policyInvalid("maxCollectionsPerDay must be a positive integer");
  if (!Array.isArray(policy.operations) || policy.operations.length === 0) policyInvalid("operations");
  const operations = policy.operations.map(parseOperation);
  if (new Set(operations.map(({ sourceId }) => sourceId)).size !== operations.length) policyInvalid("duplicate operation sourceId");
  return Object.freeze({ maxCollectionsPerDay: policy.maxCollectionsPerDay, operations: Object.freeze(operations) });
}

function parseRequestCounts(requestCounts) {
  if (requestCounts === null) return null;
  if (!isPlainObject(requestCounts)) inputInvalid("call ledger requestCounts");
  for (const [sourceId, count] of Object.entries(requestCounts)) {
    if (!isSafeToken(sourceId) || !nonnegativeInteger(count)) inputInvalid(`call ledger requestCounts ${sourceId}`);
  }
  return Object.freeze({ ...requestCounts });
}

function parseEntry(entry) {
  if (!isPlainObject(entry) || !positiveInteger(entry.runId) || !OUTCOMES.has(entry.outcome)) inputInvalid("call ledger entry");
  return Object.freeze({ runId: entry.runId, outcome: entry.outcome, requestCounts: parseRequestCounts(entry.requestCounts) });
}

/**
 * provider-call-ledger --ledger 출력을 읽는다. 읽을 수 없었던 기록은 entries 없이 unreadableReason만 싣는다(예산 대상 묶음만 막힌다).
 * @returns {{ quotaWindow: string | null, entries: object[] | null, unreadableReason: string | null }}
 */
export function parseProviderCallLedger(ledger) {
  if (!isPlainObject(ledger) || ledger.schemaVersion !== PROVIDER_CALL_LEDGER_SCHEMA_VERSION) inputInvalid("call ledger schemaVersion");
  if (ledger.entries === null) {
    if (ledger.quotaWindow !== null || typeof ledger.unreadableReason !== "string" || !REASON_CODE.test(ledger.unreadableReason)) inputInvalid("call ledger unreadable reason");
    return Object.freeze({ quotaWindow: null, entries: null, unreadableReason: ledger.unreadableReason });
  }
  if (typeof ledger.quotaWindow !== "string" || !QUOTA_WINDOW.test(ledger.quotaWindow)) inputInvalid("call ledger quotaWindow");
  if (!Array.isArray(ledger.entries) || ledger.entries.length > MAX_LEDGER_ENTRIES) inputInvalid("call ledger entries");
  const entries = ledger.entries.map(parseEntry);
  if (new Set(entries.map(({ runId }) => runId)).size !== entries.length) inputInvalid("call ledger duplicate run");
  return Object.freeze({ quotaWindow: ledger.quotaWindow, entries: Object.freeze(entries), unreadableReason: null });
}

const refuse = (reason, detail) => ({ allowed: false, reason, detail });

/**
 * 같은 KST 날 이 묶음(sourceIds)을 공급자에게 보내도 되는가.
 * @param {{ policy: ReturnType<typeof parseProviderCallBudgetPolicy>, ledger: ReturnType<typeof parseProviderCallLedger>, sourceIds: string[], expectedRequests: Record<string, number> }} input
 *   expectedRequests: 묶음이 이번에 operation마다 보낼 요청 수(마지막 성공 수집 snapshot의 requestCount).
 * @returns {{ allowed: true, attempts: number, used: Record<string, number> } | { allowed: false, reason: string, detail: string }}
 */
export function evaluateProviderCallAllowance({ policy, ledger, sourceIds, expectedRequests }) {
  const group = new Set(sourceIds);
  const operations = policy.operations.filter(({ sourceId }) => group.has(sourceId));
  if (operations.length === 0) return { allowed: true, attempts: 0, used: {} };
  for (const { sourceId } of operations) {
    if (!positiveInteger(expectedRequests?.[sourceId])) inputInvalid(`expected requests for ${sourceId} must be a positive integer`);
  }
  if (ledger.entries === null) return refuse(PROVIDER_BUDGET_REASON.EVIDENCE_MISSING, `the call ledger could not be read: ${ledger.unreadableReason}`);
  const unproven = ledger.entries.filter(({ requestCounts }) => requestCounts === null);
  if (unproven.length > 0) return refuse(PROVIDER_BUDGET_REASON.EVIDENCE_MISSING, `no request counts for run ${unproven.map(({ runId }) => runId).join(", ")}`);
  const countOf = (entry, sourceId) => entry.requestCounts[sourceId] ?? 0;
  const attempts = ledger.entries.filter((entry) => operations.some(({ sourceId }) => countOf(entry, sourceId) > 0)).length;
  if (attempts >= policy.maxCollectionsPerDay) {
    return refuse(PROVIDER_BUDGET_REASON.ATTEMPTS_EXHAUSTED, `${attempts} run(s) already sent this group's requests today, the limit is ${policy.maxCollectionsPerDay}`);
  }
  const used = Object.fromEntries(operations.map(({ sourceId }) => [sourceId, ledger.entries.reduce((sum, entry) => sum + countOf(entry, sourceId), 0)]));
  const short = operations.filter(({ sourceId, dailyRequestLimit }) => used[sourceId] + expectedRequests[sourceId] > dailyRequestLimit);
  if (short.length > 0) {
    return refuse(PROVIDER_BUDGET_REASON.BUDGET_INSUFFICIENT, short.map(({ sourceId, dailyRequestLimit }) => `${sourceId} used ${used[sourceId]} + expected ${expectedRequests[sourceId]} exceeds the daily limit ${dailyRequestLimit}`).join("; "));
  }
  return { allowed: true, attempts, used };
}
