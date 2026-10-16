// ITX 수집의 KST 하루 공급자 호출 예산 규칙(#1298). 승격 판정(decide-itx-current-promotion)과 수집 직전 가드(guard-itx-current-collection-budget)가 같은 규칙을 쓴다.
//
// 예전 규칙은 "KST 하루 한 번"이었다. 실패한 수집도 그날을 소진해서 공급자 장애로 실패한 날에는 만료 전에 다시 받을 방법이 없었다.
// 지금 규칙은 같은 KST 날의 기록(entries)에서 정한다.
//   성공했거나 진행 중인 수집이 있다   ITX_COLLECTED_TODAY            대기. 하루 한 번 받으면 충분하다.
//   요청 수 증거가 없는 실패가 있다    ITX_COLLECTION_EVIDENCE_MISSING  실패. 쓴 요청 수를 모르면 추정하지 않고 막는다.
//   시도가 하루 상한에 닿았다           ITX_DAILY_ATTEMPTS_EXHAUSTED     실패. 사람이 봐야 한다.
//   쓴 요청 + 최악 수집이 예산을 넘는다 ITX_DAILY_REQUEST_BUDGET_EXHAUSTED 실패. 사람이 봐야 한다.
//   마지막 시도가 끝난 지 얼마 안 됐다  ITX_RETRY_TOO_SOON               대기. 장애가 계속되는 동안 주기마다 예산을 태우지 않는다.
// 실패 종류는 job 실패로 끝나 실패 보고(#926)와 관리자 자동화 상태에 드러난다. 대기 종류는 이상이 아니다.
import { DEFAULT_MAX_RECORDS } from "../datapack/provider-response-capture.mjs";

export const ITX_COLLECTION_OUTCOME = Object.freeze({ SUCCEEDED: "SUCCEEDED", RUNNING: "RUNNING", FAILED: "FAILED" });
/** guard-itx-current-collection-budget --ledger가 쓰고 decide-itx-current-promotion이 읽는 기록 파일의 형식 버전. */
export const ITX_COLLECTION_LEDGER_SCHEMA_VERSION = 1;

/** 공급자(TAGO 개발계정)의 일일 요청 한도. collect-tago-itx-cheongchun-od의 TAGO_DAILY_REQUEST_LIMIT과 같다. */
export const ITX_PROVIDER_DAILY_LIMIT = 10_000;
/**
 * 수집 한 번이 보낼 수 있는 요청 수의 상한. provider-response-capture의 기록 상한이다: 기록이 가득 차면 다음 요청은 보내기 전에 막힌다.
 * 정상 수집은 약 1,900건이고 재시도 예산(900초)을 다 써도 약 2,800건이라 이 값은 보수적인 최악이다.
 */
export const ITX_WORST_CASE_COLLECTION_REQUESTS = DEFAULT_MAX_RECORDS;
/**
 * KST 하루에 ITX 수집에 쓰는 요청 예산. 공급자 한도에서 1,000건(10%)을 남겨 둔다: 이어받기 수집(최대 18건)과 사람 확인 호출이 같은 키를 쓴다.
 * 예산 안에서 최악 수집 하나는 항상 들어가고(4,000 <= 9,000) 사용량이 5,000건 이하일 때만 다음 수집을 시작하므로, 하루 합계는 이 예산을 넘지 못한다.
 */
export const ITX_DAILY_REQUEST_BUDGET = 9_000;
/** KST 하루 수집 시도 상한. 정기 1회 + 재시도 2회다. 장애가 하루 종일 이어져도 공급자를 세 번까지만 부른다. */
export const ITX_MAX_COLLECTIONS_PER_DAY = 3;
/** 같은 날 실패한 수집을 다시 시도하기까지 마지막 시도가 끝난 뒤 기다리는 최소 시간. 정기 실행 주기(3시간)보다 짧아 주기마다 재시도할 수 있다. */
export const ITX_MIN_RETRY_GAP_MS = 2 * 3_600_000;

const OUTCOMES = new Set(Object.values(ITX_COLLECTION_OUTCOME));
const isoInstant = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function isEntry(entry) {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry)
    && Number.isSafeInteger(entry.runId) && entry.runId > 0
    && typeof entry.workflowFile === "string" && entry.workflowFile.length > 0
    && OUTCOMES.has(entry.outcome)
    && (entry.endedAt === null || isoInstant(entry.endedAt))
    && (entry.requestCount === null || nonnegativeInteger(entry.requestCount));
}

/** 같은 KST 날의 수집 기록 목록 형식이 맞는가. */
export const isItxCollectionEntries = (entries) => Array.isArray(entries) && entries.every(isEntry);

const wait = (reason) => ({ allowed: false, kind: "WAIT", reason });
const failure = (reason, detail) => ({ allowed: false, kind: "FAIL", reason, detail });

/**
 * 오늘 다시 ITX를 수집해도 되는가.
 * @param {{ entries: object[], now: Date, skipRetryGap?: boolean }} input skipRetryGap: 사람 force나 수집 직전 가드처럼 최소 간격을 이 호출에서 보지 않는다. 상한·예산·증거 규칙은 건너뛰지 않는다.
 */
export function evaluateItxCollectionAllowance({ entries, now, skipRetryGap = false }) {
  if (!isItxCollectionEntries(entries)) throw new Error("ITX_COLLECTION_ENTRIES_INVALID");
  if (entries.some(({ outcome }) => outcome !== ITX_COLLECTION_OUTCOME.FAILED)) return wait("ITX_COLLECTED_TODAY");
  const unproven = entries.filter(({ requestCount, endedAt }) => requestCount === null || endedAt === null);
  if (unproven.length > 0) return failure("ITX_COLLECTION_EVIDENCE_MISSING", `no request count or end time for run ${unproven.map(({ runId }) => runId).join(", ")}`);
  if (entries.length >= ITX_MAX_COLLECTIONS_PER_DAY) return failure("ITX_DAILY_ATTEMPTS_EXHAUSTED", `${entries.length} failed collection(s) today, the limit is ${ITX_MAX_COLLECTIONS_PER_DAY}`);
  const requestsUsed = entries.reduce((sum, { requestCount }) => sum + requestCount, 0);
  if (requestsUsed + ITX_WORST_CASE_COLLECTION_REQUESTS > ITX_DAILY_REQUEST_BUDGET) {
    return failure("ITX_DAILY_REQUEST_BUDGET_EXHAUSTED", `used ${requestsUsed} + worst case ${ITX_WORST_CASE_COLLECTION_REQUESTS} requests exceeds the daily budget ${ITX_DAILY_REQUEST_BUDGET} (provider limit ${ITX_PROVIDER_DAILY_LIMIT})`);
  }
  const lastEnd = Math.max(0, ...entries.map(({ endedAt }) => Date.parse(endedAt)));
  if (!skipRetryGap && !(now.getTime() - lastEnd >= ITX_MIN_RETRY_GAP_MS)) return wait("ITX_RETRY_TOO_SOON");
  return { allowed: true, attempts: entries.length, requestsUsed };
}
