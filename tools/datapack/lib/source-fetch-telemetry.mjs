// 원천 수집 시도별 계측(data, Refs AquilaXk/easysubway#3036). 국내 공공 API 연결 실패의 원인(DNS·connect·headers·body 중 어디서, 어느 호스트가)을 실측하는 근거를 남긴다.
//
// 시도마다 JSON 한 줄을 `$SOURCE_FETCH_TELEMETRY_PATH` 파일에 덧붙인다. 환경 변수가 없으면 아무것도 쓰지 않는다(로컬 실행·테스트에 출력 잡음을 만들지 않는다).
// 기록 항목: sourceId, host(경로·쿼리·인증 정보 제외), attempt, outcome(success·http_error·retryable_result·error), status, resultCode(retryable_result만), errorCode, stage, durationMs, nextDelayMs.
// 비밀 노출 금지: URL 전체·쿼리스트링·serviceKey·헤더·오류 메시지는 기록하지 않는다. 호스트와 형식이 안전한 오류 코드만 남긴다.
// 이 파일은 원천 하루 호출 예산의 증거다(provider-call-ledger가 다음 run에서 센다). 기록을 잃으면 요청 수를 적게 세어 예산을 부당하게 풀어주므로,
// 쓰기 실패는 치명적이다: SOURCE_FETCH_TELEMETRY_WRITE_FAILED로 던지고, 오류를 잡아도 프로세스가 0이 아닌 상태로 끝나 그 run은 증명되지 않음으로 남는다.
// 실패한 run도 계측 artifact를 올리므로, 쓰지 못한 줄이 있는 파일이 "정확한 요청 수"로 읽히지 않게 첫 실패 때 표지 줄을 덧붙인다(호출 기록은 시도 기록이 아닌 줄을 증명 불가로 거부한다).
// 환경 변수가 없으면 아무것도 하지 않으므로 이 파일을 쓰지 않는 수집(ITX 등)은 영향이 없다.
import { appendFileSync } from "node:fs";

import { causeChainDetails } from "./transient-retry.mjs";

export const SOURCE_FETCH_TELEMETRY_PATH_ENV = "SOURCE_FETCH_TELEMETRY_PATH";
export const UNKNOWN_HOST = "unknown";
export const UNKNOWN_SOURCE = "unknown";
export const UNKNOWN_ERROR_CODE = "UNKNOWN";
export const UNKNOWN_STAGE = "unknown";

const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,48}$/u;

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

/** 오류와 cause 사슬에서 가장 깊은 안전한 오류 코드를 찾고, 없으면 가장 바깥의 안전한 오류 이름(TimeoutError·AbortError 등), 그것도 없으면 UNKNOWN이다. */
export function errorCodeOf(error) {
  const chain = causeChainDetails(error);
  const deepestCode = chain.map(({ code }) => safeToken(code)).findLast((code) => code !== undefined);
  const outerName = chain.map(({ name }) => safeToken(name === "Error" ? "" : name)).find((name) => name !== undefined);
  return deepestCode ?? outerName ?? UNKNOWN_ERROR_CODE;
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
 * @param {boolean} [input.retryableResult] 응답은 2xx지만 본문(공급자 resultCode)이 일시 오류라 재시도 대상으로 본 시도.
 * @param {string} [input.resultCode] retryableResult일 때 본문의 resultCode. 안전한 토큰만 남기고 아니면 생략한다.
 */
export function buildAttemptRecord({ sourceId, url, attempt, response, error, durationMs, nextDelayMs, retryableResult = false, resultCode }) {
  const base = { sourceId: safeToken(sourceId) ?? UNKNOWN_SOURCE, host: url === undefined ? UNKNOWN_HOST : hostOf(url), attempt };
  const timing = { durationMs: Math.max(0, Math.round(durationMs)), nextDelayMs };
  if (error !== undefined) {
    const errorCode = errorCodeOf(error);
    return { ...base, outcome: "error", errorCode, stage: stageOfErrorCode(errorCode), ...timing };
  }
  const status = response?.status;
  const ok = Number.isInteger(status) && status >= 200 && status < 300;
  if (ok && retryableResult) return { ...base, outcome: "retryable_result", status, resultCode: safeToken(resultCode), ...timing };
  return { ...base, outcome: ok ? "success" : "http_error", status, ...timing };
}

export const SOURCE_FETCH_TELEMETRY_WRITE_FAILED = "SOURCE_FETCH_TELEMETRY_WRITE_FAILED";

/** 시도 기록 한 줄을 쓰지 못했다. 호출 수 증거가 불완전하므로 수집은 계속될 수 없다. */
export class SourceFetchTelemetryWriteError extends Error {
  constructor() {
    super(`${SOURCE_FETCH_TELEMETRY_WRITE_FAILED}: an attempt record could not be written to ${SOURCE_FETCH_TELEMETRY_PATH_ENV}`);
    this.code = SOURCE_FETCH_TELEMETRY_WRITE_FAILED;
  }
}

/** 기록을 잃은 파일에 덧붙이는 표지 줄. 시도 기록이 아니라서 호출 기록이 그 파일의 요청 수를 증명 불가(null)로 본다. */
export const TELEMETRY_WRITE_FAILED_MARKER = JSON.stringify({ telemetryWriteFailed: true });

let writeFailures = 0;

// 호출한 쪽이 오류를 잡거나 삼켜도 이 프로세스는 실패로 끝난다: 종료 때 이름 있는 ::error:: 한 줄에 건수를 남기고 종료 상태를 1로 정한다.
function countWriteFailure(target) {
  if (writeFailures === 0) {
    try { appendFileSync(target, `${TELEMETRY_WRITE_FAILED_MARKER}\n`); } catch { /* 같은 원인으로 표지도 못 쓰면 파일은 없거나 불완전하다: 프로세스 종료 상태가 실패를 드러낸다 */ }
    process.once("exit", () => {
      process.stderr.write(`::error title=Source fetch telemetry::${SOURCE_FETCH_TELEMETRY_WRITE_FAILED}: ${writeFailures} attempt records could not be written to ${SOURCE_FETCH_TELEMETRY_PATH_ENV}; the call count evidence is incomplete.\n`);
      if (!process.exitCode) process.exitCode = 1;
    });
  }
  writeFailures += 1;
}

/** 기록 한 줄을 `$SOURCE_FETCH_TELEMETRY_PATH`에 덧붙인다. 환경 변수가 없으면 쓰지 않는다. 쓰기에 실패하면 SourceFetchTelemetryWriteError를 던지고 프로세스를 실패로 끝낸다. */
export function emitAttemptRecord(record, env = process.env) {
  const target = env[SOURCE_FETCH_TELEMETRY_PATH_ENV];
  if (typeof target !== "string" || target === "") return;
  try { appendFileSync(target, `${JSON.stringify(record)}\n`); } catch {
    countWriteFailure(target);
    throw new SourceFetchTelemetryWriteError();
  }
}

/** 사람이 읽는 label을 계측용 원천 식별자로 바꾼다(소문자, 영숫자 밖은 `-`). sourceId를 따로 주지 않은 호출자의 기본값이다. */
export const sourceIdFromLabel = (label) => String(label).toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "").slice(0, 48) || UNKNOWN_SOURCE;
