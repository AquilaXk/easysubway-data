// 원천 수집기의 표준 일시 오류 재시도 정책(data #1334, Refs #870). 서울 접근성 수집기에서 검증한 규칙을 다른 원천 수집기가 그대로 쓰도록 모았다.
//
//   - 멱등 GET만 최대 3회 시도(최초 1회 + 재시도 2회)
//   - 재시도 대상: timeout·reset 같은 전송 오류와 HTTP 429·500·502·503·504. 그 밖의 오류(401·403·404·408·501 등)는 즉시 실패한다.
//     500·502·503·504를 일시 오류로 보는 근거는 AWS SDK standard retry mode다: https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html
//   - 대기는 full jitter random(0, min(cap, base·2^n)), base 2초·cap 20초
//   - Retry-After가 있으면 그 값을 따르고, cap을 넘으면 기다리지 않고 RETRY_AFTER_EXCEEDS_CAP으로 실패한다(fail-closed)
//   - 429는 쿼터 신호다: Retry-After가 없으면 한 번만 재시도한다
//   - 재시도하려고 버리는 응답의 본문은 취소해 연결이 남지 않게 한다
//
// 재시도는 fallback이 아니다: 같은 원천에 같은 요청을 다시 보낼 뿐이고, 소진하면 마지막 오류(또는 마지막 응답)를 호출자의 기존 오류 경로로 그대로 넘긴다.
// 요청 하나의 최악 시간은 3 × 요청 timeout + 2 × cap이고, 한 실행의 재시도 시간은 transient-retry의 시간 예산(5분)으로 따로 막힌다.
import { sha256 } from "../../lib/hash.mjs";
import {
  fullJitterBackoffMs,
  isTransientTransportError,
  parseRetryAfterMs,
  unwrapTransientRetryFailure,
  withTransientRetry,
} from "./transient-retry.mjs";

export const SOURCE_COLLECTION_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 2_000,
  capDelayMs: 20_000,
  transientStatuses: Object.freeze([429, 500, 502, 503, 504]),
  maxUnhintedRateLimitRetries: 1,
});
export const RETRY_AFTER_EXCEEDS_CAP = "RETRY_AFTER_EXCEEDS_CAP";

const RATE_LIMITED_STATUS = 429;
const TRANSIENT_STATUSES = new Set(SOURCE_COLLECTION_RETRY_POLICY.transientStatuses);

/** 서버가 정한 대기가 cap을 넘으면 일찍 다시 요청하지 않고 실패한다. */
export class RetryAfterExceedsCapError extends Error {
  constructor(label, status, retryAfterMilliseconds, capMilliseconds, result) {
    super(`${label} HTTP ${status}: ${RETRY_AFTER_EXCEEDS_CAP} retryAfterSeconds=${Math.ceil(retryAfterMilliseconds / 1_000)} capSeconds=${capMilliseconds / 1_000}`);
    this.code = RETRY_AFTER_EXCEEDS_CAP;
    this.result = result; // 재시도하지 않고 버린 응답의 시도 결과(원본 증거 해시를 남기려는 호출자용)
  }
}

// 공공데이터포털 OpenAPI 게이트웨이 오류 코드(공공데이터 제공 표준 오류코드 표: https://www.data.go.kr/data/15029183/openapi.do).
// 일시: 01 APPLICATION_ERROR(게이트웨이 내부 오류), 02 DB_ERROR, 04 HTTP_ERROR, 05 SERVICETIMEOUT_ERROR, 99 UNKNOWN_ERROR(기타).
// 30 SERVICE_KEY_IS_NOT_REGISTERED_ERROR도 일시로 본다: 같은 키로 여러 run이 통과했고 게이트웨이 노드 사이 키 동기화 지연으로 간헐 발생한다.
// 키가 실제로 미등록이면 모든 시도가 30으로 실패하므로 소진 뒤 resultCode 30으로 실패해 신호가 사라지지 않는다.
// 결정적(즉시 실패): 10·11·12 요청 파라미터·서비스 없음, 20·21 키 없음·권한·접근 거부, 22 일일 요청 한도(쿼터), 31·32·33 기한·IP·서명.
const TRANSIENT_DATA_GO_KR_RESULT_CODES = new Set(["01", "02", "04", "05", "30", "99"]);

/** 공공데이터포털 envelope의 resultCode가 같은 요청을 다시 보내면 풀릴 수 있는 일시 오류인가. */
export const isTransientDataGoKrResultCode = (resultCode) => TRANSIENT_DATA_GO_KR_RESULT_CODES.has(resultCode);

// KRIC OpenAPI(openapi.kric.go.kr) resultCode: 공공데이터 게이트웨이 표준 코드 체계를 쓴다. 저장소 실측으로 03 데이터 없음, 12 폐기 operation,
// 30 미등록 operation, 41 승인 대기를 확인했다. KRIC가 공개한 별도 오류코드 표는 찾지 못했다(2026-10-18 검색). 그래서 위 표준 코드 표를 근거로 하되,
// 30은 일시로 보지 않는다: KRIC는 operation별 활용신청이라 30이 미신청 operation을 뜻하고(재시도해도 풀리지 않음) 즉시 실패해야 신호가 빨리 드러난다.
// 일시: 01·02·04·05·99. 그 밖의 코드(10·11·12·20·21·22·30·31·32·41)는 결정적이라 즉시 실패한다.
const TRANSIENT_KRIC_RESULT_CODES = new Set([...TRANSIENT_DATA_GO_KR_RESULT_CODES].filter((code) => code !== "30"));

/** KRIC OpenAPI 응답의 resultCode가 같은 요청을 다시 보내면 풀릴 수 있는 일시 오류인가. */
export const isTransientKricResultCode = (resultCode) => TRANSIENT_KRIC_RESULT_CODES.has(resultCode);

export const isRetryAfterExceedsCap = (error) => error?.code === RETRY_AFTER_EXCEEDS_CAP;

const retryAfterOf = (response) => parseRetryAfterMs(response?.headers?.get?.("retry-after"));

// 재시도하려고 버리는 응답의 본문은 읽지 않으므로 취소한다. 취소 실패(이미 읽은 본문 포함)는 수집을 막지 않는다.
const discardBody = (response) => { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); };

/**
 * attempt를 표준 정책으로 실행한다. 결과(또는 던진 오류)가 일시 상태면 같은 요청을 다시 보낸다.
 * @param {(context: { attemptNumber: number }) => Promise<T>} attempt 요청(과 본문 읽기) 한 번.
 * @param {object} [options]
 * @param {(result: T) => Response | undefined} [options.responseOf] 결과에서 HTTP 응답을 꺼낸다. 기본은 result.response.
 * @param {(result: T) => boolean} [options.isTransientResult] 상태 코드 말고도 일시로 볼 결과(예: 200이지만 공급자가 일시 오류 본문을 준 경우).
 * @param {(error: unknown) => boolean} [options.isTransientError] 던져진 오류가 일시 오류인가. 기본은 isTransientTransportError.
 * @param {number} [options.maxAttempts] 최대 시도 수(1~SOURCE_COLLECTION_RETRY_POLICY.maxAttempts, 기본은 그 값). 범위 밖이면 거부한다. 요청 수 × 최악 대기가 job timeout을 넘는 수집기만 줄인다.
 * @param {string} [options.label] Retry-After 초과 오류 메시지의 원천 이름.
 * @param {() => number} [options.random] [0, 1)을 돌려주는 난수(테스트용 주입).
 * @param {(event: object) => void} [options.onRetry] 재시도 직전 알림(응답 본문은 이미 취소했다).
 */
export function withSourceCollectionRetry(attempt, {
  responseOf = (result) => result?.response,
  isTransientResult = () => false,
  isTransientError = isTransientTransportError,
  maxAttempts = SOURCE_COLLECTION_RETRY_POLICY.maxAttempts,
  label = "source collection",
  random,
  sleep,
  budget,
  onRetry = () => {},
} = {}) {
  const { baseDelayMs, capDelayMs, maxUnhintedRateLimitRetries } = SOURCE_COLLECTION_RETRY_POLICY;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > SOURCE_COLLECTION_RETRY_POLICY.maxAttempts) {
    throw new Error(`SOURCE_COLLECTION_RETRY_ARGUMENTS: maxAttempts must be an integer from 1 to ${SOURCE_COLLECTION_RETRY_POLICY.maxAttempts}`);
  }
  let unhintedRateLimits = 0;
  const isTransientResponse = (response) => {
    if (!TRANSIENT_STATUSES.has(response?.status)) return false;
    if (response.status !== RATE_LIMITED_STATUS || retryAfterOf(response) !== undefined) return true;
    unhintedRateLimits += 1;
    return unhintedRateLimits <= maxUnhintedRateLimitRetries;
  };
  const delayMs = ({ retryIndex, result }) => {
    const response = result === undefined ? undefined : responseOf(result);
    const retryAfter = retryAfterOf(response);
    if (retryAfter === undefined) return fullJitterBackoffMs(retryIndex, { baseMs: baseDelayMs, capMs: capDelayMs, random });
    if (retryAfter > capDelayMs) throw new RetryAfterExceedsCapError(label, response.status, retryAfter, capDelayMs, result);
    return retryAfter;
  };
  return withTransientRetry(attempt, {
    isTransientResult: (result) => isTransientResponse(responseOf(result)) || isTransientResult(result),
    isTransientError,
    retryLimit: maxAttempts - 1,
    sleep,
    budget,
    delayMs,
    onRetry: (event) => {
      if (event.result !== undefined) discardBody(responseOf(event.result));
      onRetry(event);
    },
  });
}

/**
 * 요청과 본문 바이트 읽기를 한 번의 시도로 묶어 표준 정책으로 재시도하는 HTTP GET 수집 공용 함수.
 * @param {object} options
 * @param {string | URL} options.url
 * @param {Function} options.fetchImpl
 * @param {string} options.accept Accept 헤더.
 * @param {string} options.label 오류 메시지의 원천 이름.
 * @param {(failure: unknown) => Error} options.transportFailure 재시도를 소진했거나 일시 아닌 전송 오류를 수집기의 기존 오류로 바꾼다.
 * @param {(result: { response: Response, bytes: Buffer }) => boolean} [options.isTransientResult] 상태 코드 말고 본문으로 판정하는 일시 상태(예: 공공데이터포털 resultCode).
 * @returns {Promise<{ response: Response, bytes: Buffer }>}
 */
export async function fetchBytesWithSourceRetry({
  url, fetchImpl, accept, label, transportFailure, isTransientResult, sleep, budget, random, timeoutMs = 15_000,
}) {
  try {
    return await withSourceCollectionRetry(async () => {
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept } });
      return { response, bytes: Buffer.from(await response.arrayBuffer()) };
    }, { label, isTransientResult, sleep, budget, random });
  } catch (error) {
    if (!isRetryAfterExceedsCap(error)) throw transportFailure(unwrapTransientRetryFailure(error));
    const bytes = error.result?.bytes;
    if (bytes === undefined) throw error;
    // 기다리지 않고 버린 응답도 원본 증거(바이트 수·해시)를 남긴다.
    throw Object.assign(new Error(`${error.message}; rawBytes=${bytes.length}; rawSha256=${sha256(bytes)}`), { code: error.code });
  }
}
