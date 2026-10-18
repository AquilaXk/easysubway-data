// 공급자 일시 오류 재시도의 공통 정책(#1099). TAGO ITX 수집기(#1090)에 적용한 규칙을 다른 수집기도 쓰도록 모았다.
//
// 재시도 대상은 같은 요청을 다시 보내면 풀릴 수 있는 일시 오류뿐이다.
//   - HTTP 408과 5xx
//   - 전송 오류: 연결·헤더·본문 수신 timeout, 소켓 끊김, DNS 일시 실패(고정된 공식 호스트라 ENOTFOUND도 일시로 본다)
// 이 모듈의 기본값은 쿼터 오류(HTTP 429, 공급자 resultCode 22·23 등)와 인증 오류(401·403), 스키마·내용 오류를 재시도하지 않는다(isTransientStatus는 408·5xx만 참이다).
// 쿼터 신호를 다룰지는 호출자의 정책이다: 부산·서울 수집기는 429를 따로 다룬다(서울: Retry-After가 있고 cap 이하면 그 값을 기다려 재시도하고, 없으면 jitter 대기로 한 번만 재시도하며,
// cap을 넘으면 기다리지 않고 실패한다). 기본 5번·1~16초 백오프는 그대로이고, 호출자는 retryLimit·delayMs로 한도와 대기(full jitter, Retry-After)를 바꿀 수 있다.
// Retry-After 파싱은 parseRetryAfterMs 하나로 모으고, 상한과 fail-closed 여부는 호출자가 정한다.
//
// 재시도는 fallback이 아니다: 같은 원천에 같은 요청을 다시 보낼 뿐이고, 요청당 최대 5번(대기 1·2·4·8·16초)과 실행(프로세스) 단위 재시도 시간 예산 5분을
// 다 쓰고도 실패하면 마지막 오류(또는 마지막 응답)를 호출자의 기존 오류 경로로 그대로 넘긴다. 이전·추정 데이터로 채우지 않는다.
//
// 재시도 시간 예산은 대기(sleep)뿐 아니라 일시 오류로 끝난 시도가 쓴 경과 시간(벽시계)도 센다. 요청 timeout이 30초인 공급자가 느려져
// "한 번 timeout 뒤 성공"이 수백 번 이어져도 재시도가 쓰는 시간이 5분을 넘지 않는다. 예산을 넘기는 순간 재시도를 멈추므로 재시도 때문에 늘어나는
// 실행 시간은 예산(5분) + 마지막 시도 하나다. 정상으로 끝난 시도의 시간은 세지 않는다.
//
// 재시도 단위는 호출자가 정한다: attempt가 "요청 + 본문 읽기"까지 하면 본문 수신 중 timeout도 같은 요청을 다시 보낸다.
export const TRANSIENT_RETRY_LIMIT = 5;
export const TRANSIENT_RETRY_BUDGET_MS = 300_000;
export const TRANSIENT_RETRY_BUDGET_EXHAUSTED = "TRANSIENT_RETRY_BUDGET_EXHAUSTED";
const CAUSE_DEPTH = 4;
const TRANSIENT_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);
const TRANSIENT_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENETDOWN", "ENETRESET", "ECONNABORTED", "EAI_AGAIN", "ENOTFOUND", "ABORT_ERR",
  "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
]);

function invalid(detail) {
  return new Error(`TRANSIENT_RETRY_ARGUMENTS: ${detail}`);
}

export const transientBackoffMs = (retryIndex) => 1_000 * 2 ** retryIndex;

/**
 * Full jitter 대기: random(0, min(cap, base·2^n)) 밀리초(정수). 같은 시각에 몰린 재시도가 겹치지 않게 한다.
 * @param {number} retryIndex 0부터 세는 재시도 순번 n
 * @param {{ baseMs: number, capMs: number, random?: () => number }} policy random은 [0, 1)을 돌려준다(테스트용 주입).
 */
export function fullJitterBackoffMs(retryIndex, { baseMs, capMs, random = Math.random }) {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** retryIndex));
}

const RETRY_AFTER_SECONDS = /^\d+$/u;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// RFC 9110의 HTTP-date 세 형식. 캡처: [일, 월, 연, 시:분:초].
const IMF_FIXDATE = /^[A-Z][a-z]{2}, (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/u;
const RFC_850_DATE = /^[A-Z][a-z]{5,8}, (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/u;
const ASCTIME_DATE = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}:\d{2}:\d{2}) (\d{4})$/u;
const RFC_850_FUTURE_YEARS = 50;

// 두 자리 해는 지금보다 50년 넘게 먼 미래로 읽히면 지난 세기로 본다(RFC 9110 5.6.7).
function rfc850Year(twoDigitYear, nowMs) {
  const year = 2000 + twoDigitYear;
  return year > new Date(nowMs).getUTCFullYear() + RFC_850_FUTURE_YEARS ? year - 100 : year;
}

function httpDateMs(value, nowMs) {
  let day; let month; let year; let time;
  let match = IMF_FIXDATE.exec(value);
  if (match) [, day, month, year, time] = match;
  else if ((match = RFC_850_DATE.exec(value))) { [, day, month, year, time] = match; year = rfc850Year(Number(year), nowMs); }
  else if ((match = ASCTIME_DATE.exec(value))) [, month, day, time, year] = match;
  else return Number.NaN;
  const monthIndex = MONTHS.indexOf(month);
  const [hour, minute, second] = time.split(":").map(Number);
  const parsed = new Date(Date.UTC(Number(year), monthIndex, Number(day), hour, minute, second));
  const consistent = monthIndex >= 0 && parsed.getUTCDate() === Number(day) && parsed.getUTCHours() === hour;
  return consistent ? parsed.getTime() : Number.NaN;
}

/**
 * Retry-After 헤더 값(초, IMF-fixdate, RFC 850, asctime)을 대기 밀리초로 읽는다. 날짜가 이미 지났으면 0이다.
 * 파싱만 한다: 상한이나 fail-closed 여부는 호출자의 정책이다. 헤더가 없거나 읽을 수 없으면 undefined다.
 * @param {string | null | undefined} headerValue
 * @param {{ now?: () => number }} [options] now는 시계(테스트용 주입)다.
 */
export function parseRetryAfterMs(headerValue, { now = Date.now } = {}) {
  if (typeof headerValue !== "string") return undefined;
  const value = headerValue.trim();
  if (RETRY_AFTER_SECONDS.test(value)) return Number(value) * 1_000;
  const nowMs = now();
  const dateMs = httpDateMs(value, nowMs);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - nowMs);
}

/** 재시도 시간 예산(대기 + 일시 오류로 끝난 시도의 경과 시간). 같은 예산을 쓰는 요청들이 나눠 쓴다. now는 시계(테스트용 주입)다. */
export function createTransientRetryBudget(limitMs = TRANSIENT_RETRY_BUDGET_MS, { now = Date.now } = {}) {
  if (!Number.isSafeInteger(limitMs) || limitMs < 1) throw invalid("limitMs must be a positive integer");
  if (typeof now !== "function") throw invalid("now must be a function");
  return { limitMs, spentMs: 0, now };
}

// 예산을 주지 않은 재시도는 수집기 실행(프로세스) 하나가 예산 하나를 나눠 쓴다.
const processBudget = createTransientRetryBudget();

export function isTransientStatus(status) {
  return status === 408 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function transportDetails(error) {
  try {
    return { name: typeof error.name === "string" ? error.name : "", code: typeof error.code === "string" ? error.code : "", cause: error.cause };
  } catch {
    return null;
  }
}

/** 오류와 cause 사슬(4단계까지)에서 일시 전송 오류의 이름·코드를 찾는다. */
export function isTransientTransportError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth <= CAUSE_DEPTH; depth += 1) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null || seen.has(current)) return false;
    seen.add(current);
    const details = transportDetails(current);
    if (details === null) return false;
    if (TRANSIENT_ERROR_NAMES.has(details.name) || TRANSIENT_ERROR_CODES.has(details.code)) return true;
    current = details.cause;
  }
  return false;
}

/**
 * 대기 예산 소진으로 던져진 오류를 마지막 시도의 원래 오류로 되돌린다. 수집기가 자기 오류 코드·분류(예: *_TRANSPORT)로 실패를 드러낼 때 쓴다.
 * 그 밖의 오류는 그대로 돌려준다.
 */
export function unwrapTransientRetryFailure(error) {
  return error?.code === TRANSIENT_RETRY_BUDGET_EXHAUSTED && error.cause !== undefined ? error.cause : error;
}

const defaultSleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

/**
 * attempt를 실행하고 일시 오류면 같은 요청을 다시 보낸다.
 * @param {(context: { attemptNumber: number }) => Promise<T>} attempt 요청(과 본문 읽기) 한 번. 1부터 센다.
 * @param {object} [options]
 * @param {(result: T) => boolean} [options.isTransientResult] 반환값이 일시 상태(예: 5xx 응답)인가. 한도나 예산을 다 쓰면 마지막 결과를 그대로 돌려준다.
 * @param {(error: unknown) => boolean} [options.isTransientError] 던져진 오류가 일시 오류인가. 한도를 다 쓰면 마지막 오류를 그대로 던진다.
 * @param {{ limitMs: number, spentMs: number, now: () => number }} [options.budget] 재시도 시간 예산. 넘기는 재시도는 하지 않는다:
 *   오류였으면 TRANSIENT_RETRY_BUDGET_EXHAUSTED(cause = 마지막 오류)를 던지고, 일시 상태 결과였으면 마지막 결과를 그대로 돌려준다.
 * @param {(event: { retryIndex: number, delayMs: number, error?: unknown, result?: T }) => void} [options.onRetry] 재시도 직전 알림. 오류로 끝난 시도면 error, 일시 상태 결과였으면 result가 들어 있다.
 * @param {number} [options.retryLimit] 재시도 횟수 상한(0~TRANSIENT_RETRY_LIMIT). 기본은 TRANSIENT_RETRY_LIMIT. 최대 시도 수는 retryLimit + 1이다.
 * @param {(context: { retryIndex: number, error?: unknown, result?: T }) => number} [options.delayMs] 재시도 전 대기(ms). 기본은 1·2·4·8·16초 지수 백오프다.
 */
export async function withTransientRetry(attempt, {
  isTransientResult = () => false, isTransientError = isTransientTransportError, budget = processBudget, sleep = defaultSleep, onRetry = () => {},
  retryLimit = TRANSIENT_RETRY_LIMIT, delayMs = ({ retryIndex }) => transientBackoffMs(retryIndex),
} = {}) {
  if (typeof attempt !== "function" || typeof isTransientResult !== "function" || typeof isTransientError !== "function"
    || typeof sleep !== "function" || typeof onRetry !== "function" || typeof delayMs !== "function") throw invalid("attempt and the option callbacks must be functions");
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 0 || retryLimit > TRANSIENT_RETRY_LIMIT) throw invalid(`retryLimit must be an integer from 0 to ${TRANSIENT_RETRY_LIMIT}`);
  if (!Number.isSafeInteger(budget?.limitMs) || budget.limitMs < 1 || !Number.isFinite(budget.spentMs) || budget.spentMs < 0 || typeof budget.now !== "function") {
    throw invalid("budget must come from createTransientRetryBudget");
  }
  for (let retryIndex = 0; ; retryIndex += 1) {
    const startedAt = budget.now();
    let transient;
    try {
      const result = await attempt({ attemptNumber: retryIndex + 1 }); // NOSONAR -- 재시도는 앞 시도가 끝난 뒤 순서대로 한다
      if (retryIndex >= retryLimit || !isTransientResult(result)) return result;
      transient = { result };
    } catch (error) {
      if (retryIndex >= retryLimit || !isTransientError(error)) throw error;
      transient = { error };
    }
    // 일시 오류로 끝난 시도가 쓴 시간도 예산에서 쓴다(벽시계). 시계가 거꾸로 가도 줄지 않는다.
    budget.spentMs += Math.max(0, budget.now() - startedAt);
    const waitMs = delayMs({ retryIndex, ...transient });
    if (budget.spentMs + waitMs > budget.limitMs) {
      if (Object.hasOwn(transient, "result")) return transient.result;
      throw Object.assign(new Error(`${TRANSIENT_RETRY_BUDGET_EXHAUSTED}: the retry time budget of ${budget.limitMs} ms is used up`, { cause: transient.error }), { code: TRANSIENT_RETRY_BUDGET_EXHAUSTED });
    }
    budget.spentMs += waitMs;
    onRetry({ retryIndex, delayMs: waitMs, ...transient });
    await sleep(waitMs); // NOSONAR -- 위와 같다
  }
}
