// 원천 수집기의 표준 일시 오류 재시도 정책(data #1334, Refs #870). 서울 접근성 수집기에서 검증한 규칙을 다른 원천 수집기가 그대로 쓰도록 모았다.
//
//   - 멱등 GET만 최대 3회 시도(최초 1회 + 재시도 2회)
//   - 재시도 대상: timeout·reset 같은 전송 오류와 HTTP 429·502·503·504. 그 밖의 오류(401·403·404·500 등)는 즉시 실패한다
//   - 대기는 full jitter random(0, min(cap, base·2^n)), base 2초·cap 20초
//   - Retry-After가 있으면 그 값을 따르고, cap을 넘으면 기다리지 않고 RETRY_AFTER_EXCEEDS_CAP으로 실패한다(fail-closed)
//   - 429는 쿼터 신호다: Retry-After가 없으면 한 번만 재시도한다
//   - 재시도하려고 버리는 응답의 본문은 취소해 연결이 남지 않게 한다
//
// 재시도는 fallback이 아니다: 같은 원천에 같은 요청을 다시 보낼 뿐이고, 소진하면 마지막 오류(또는 마지막 응답)를 호출자의 기존 오류 경로로 그대로 넘긴다.
// 요청 하나의 최악 시간은 3 × 요청 timeout + 2 × cap이고, 한 실행의 재시도 시간은 transient-retry의 시간 예산(5분)으로 따로 막힌다.
import {
  fullJitterBackoffMs,
  isTransientTransportError,
  parseRetryAfterMs,
  withTransientRetry,
} from "./transient-retry.mjs";

export const SOURCE_COLLECTION_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 2_000,
  capDelayMs: 20_000,
  transientStatuses: Object.freeze([429, 502, 503, 504]),
  maxUnhintedRateLimitRetries: 1,
});
export const RETRY_AFTER_EXCEEDS_CAP = "RETRY_AFTER_EXCEEDS_CAP";

const RATE_LIMITED_STATUS = 429;
const TRANSIENT_STATUSES = new Set(SOURCE_COLLECTION_RETRY_POLICY.transientStatuses);

/** 서버가 정한 대기가 cap을 넘으면 일찍 다시 요청하지 않고 실패한다. */
export class RetryAfterExceedsCapError extends Error {
  constructor(label, status, retryAfterMilliseconds, capMilliseconds) {
    super(`${label} HTTP ${status}: ${RETRY_AFTER_EXCEEDS_CAP} retryAfterSeconds=${Math.ceil(retryAfterMilliseconds / 1_000)} capSeconds=${capMilliseconds / 1_000}`);
    this.code = RETRY_AFTER_EXCEEDS_CAP;
  }
}

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
 * @param {number} [options.maxAttempts] 최대 시도 수(1~3). 요청 수 × 최악 대기가 job timeout을 넘는 수집기만 줄인다.
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
    if (retryAfter > capDelayMs) throw new RetryAfterExceedsCapError(label, response.status, retryAfter, capDelayMs);
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
