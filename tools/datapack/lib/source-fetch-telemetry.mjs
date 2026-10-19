// 원천 수집 시도별 계측(data, Refs AquilaXk/easysubway#3036). 국내 공공 API 연결 실패의 원인(DNS·connect·headers·body 중 어디서, 어느 호스트가)을 실측하는 근거를 남긴다.
//
// 시도마다 JSON 한 줄을 `$SOURCE_FETCH_TELEMETRY_PATH` 파일에 덧붙인다. 환경 변수가 없으면 아무것도 쓰지 않는다(로컬 실행·테스트에 출력 잡음을 만들지 않는다).
// 기록 항목: sourceId, host(경로·쿼리·인증 정보 제외), attempt, outcome(success·http_error·error), status, errorCode, stage, durationMs, nextDelayMs.
// 비밀 노출 금지: URL 전체·쿼리스트링·serviceKey·헤더·오류 메시지는 기록하지 않는다. 호스트와 형식이 안전한 오류 코드만 남긴다.
// 계측은 관측일 뿐이다: 기록에 실패해도 수집을 막거나 결과를 바꾸지 않는다.
import { appendFileSync } from "node:fs";

export const SOURCE_FETCH_TELEMETRY_PATH_ENV = "SOURCE_FETCH_TELEMETRY_PATH";
export const UNKNOWN_HOST = "unknown";
export const UNKNOWN_SOURCE = "unknown";
export const UNKNOWN_ERROR_CODE = "UNKNOWN";
export const UNKNOWN_STAGE = "unknown";

const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,48}$/u;
const CAUSE_DEPTH = 4;

// undici·Node 오류 코드에서 실패 단계를 유추한다. 단계가 코드만으로 정해지지 않는 오류(ECONNRESET·UND_ERR_SOCKET·abort)는 unknown이다.
const STAGE_BY_ERROR_CODE = Object.freeze({
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
  UND_ERR_CONNECT_TIMEOUT: "connect",
  ECONNREFUSED: "connect",
  ETIMEDOUT: "connect",
  EHOSTUNREACH: "connect",
  ENETUNREACH: "connect",
  UND_ERR_HEADERS_TIMEOUT: "headers",
  UND_ERR_BODY_TIMEOUT: "body",
  ERR_STREAM_PREMATURE_CLOSE: "body",
  UND_ERR_RES_CONTENT_LENGTH_MISMATCH: "body",
});

const safeToken = (value) => (typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined);

/** URL 문자열·URL 객체에서 호스트만 꺼낸다. 읽을 수 없으면 UNKNOWN_HOST다. 경로·쿼리·사용자 정보는 버린다. */
export function hostOf(url) {
  try { return new URL(String(url)).hostname || UNKNOWN_HOST; } catch { return UNKNOWN_HOST; }
}

/** 오류와 cause 사슬(4단계까지)에서 가장 깊은 안전한 오류 코드를 찾고, 없으면 오류 이름(TimeoutError·AbortError 등), 그것도 없으면 UNKNOWN이다. */
export function errorCodeOf(error) {
  let deepestCode;
  let firstName;
  let current = error;
  for (let depth = 0; depth <= CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    deepestCode = safeToken(current.code) ?? deepestCode;
    firstName ??= safeToken(current.name === "Error" ? undefined : current.name);
    current = current.cause;
  }
  return deepestCode ?? firstName ?? UNKNOWN_ERROR_CODE;
}

export const stageOfErrorCode = (code) => STAGE_BY_ERROR_CODE[code] ?? UNKNOWN_STAGE;

/**
 * 시도 하나의 계측 기록(비밀 없음)을 만든다.
 * @param {object} input
 * @param {string} input.sourceId 원천 식별자(안전한 토큰이 아니면 unknown).
 * @param {string | URL} [input.url] 요청 URL. 호스트만 쓴다.
 * @param {number} input.attempt 1부터 세는 시도 번호.
 * @param {Response} [input.response] 시도가 응답을 받았다면 그 응답(status만 읽는다).
 * @param {unknown} [input.error] 시도가 던진 오류(코드·이름만 읽는다).
 * @param {number} input.durationMs 시도 소요 시간.
 * @param {number | null} input.nextDelayMs 다음 시도 전 대기. 마지막 시도면 null.
 */
export function buildAttemptRecord({ sourceId, url, attempt, response, error, durationMs, nextDelayMs }) {
  const base = { sourceId: safeToken(sourceId) ?? UNKNOWN_SOURCE, host: url === undefined ? UNKNOWN_HOST : hostOf(url), attempt };
  const timing = { durationMs: Math.max(0, Math.round(durationMs)), nextDelayMs };
  if (error !== undefined) {
    const errorCode = errorCodeOf(error);
    return { ...base, outcome: "error", errorCode, stage: stageOfErrorCode(errorCode), ...timing };
  }
  const status = response?.status;
  const ok = Number.isInteger(status) && status >= 200 && status < 300;
  return { ...base, outcome: ok ? "success" : "http_error", status, ...timing };
}

/** 기록 한 줄을 `$SOURCE_FETCH_TELEMETRY_PATH`에 덧붙인다. 환경 변수가 없거나 쓰기에 실패하면 조용히 넘어간다(수집을 막지 않는다). */
export function emitAttemptRecord(record, env = process.env) {
  const target = env[SOURCE_FETCH_TELEMETRY_PATH_ENV];
  if (typeof target !== "string" || target === "") return;
  try { appendFileSync(target, `${JSON.stringify(record)}\n`); } catch { /* 계측 실패는 수집 결과를 바꾸지 않는다 */ }
}

/** 사람이 읽는 label을 계측용 원천 식별자로 바꾼다(소문자, 영숫자 밖은 `-`). sourceId를 따로 주지 않은 호출자의 기본값이다. */
export const sourceIdFromLabel = (label) => String(label).toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 48) || UNKNOWN_SOURCE;
