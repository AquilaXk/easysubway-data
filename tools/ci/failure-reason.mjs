// 자동화 가드가 실패할 때 stderr 마지막 줄과 실패 영수증에 남기는 사유의 공용 어휘와 형식.
// 판정은 그대로 fail-closed이고, 이 모듈은 "어떤 검사에서 왜 멈췄는지"를 안정적인 코드로 드러내기만 한다.
// 사유에는 토큰·Authorization 헤더·응답 본문·URL 쿼리를 싣지 않는다. 코드와 숫자·파일 이름만 쓴다.

/** GitHub REST를 부르는 가드가 공유하는 사유. 호출 방식 실패, HTTP 상태, 본문 이상을 구분한다. */
export const GITHUB_API_REASON = Object.freeze({
  GITHUB_API_REQUEST_FAILED: "GITHUB_API_REQUEST_FAILED", // fetch·gh 호출이 응답을 받기 전에 실패했다(연결 실패·timeout·본문 읽기 중단)
  GITHUB_API_STATUS: "GITHUB_API_STATUS", // 응답을 받았지만 성공(200)이 아니다. HTTP 상태 숫자를 함께 남긴다
  GITHUB_API_BODY_INVALID: "GITHUB_API_BODY_INVALID", // 성공 응답의 본문이 JSON이 아니거나 기대한 모양이 아니다
});

/** 가드가 모르는 예외. 원문은 비밀이 섞일 수 있어 남기지 않고 이 코드만 남긴다. */
export const INTERNAL_ERROR_REASON = "INTERNAL_ERROR";

export const SECRET_SYNC_REASON = Object.freeze({
  ARGUMENT_INVALID: "ARGUMENT_INVALID",
  SECRET_INVALID: "SECRET_INVALID",
  GH_SYNC_FAILED: "GH_SYNC_FAILED",
  INTERNAL_ERROR: INTERNAL_ERROR_REASON,
});

const REASON_LINE_KEYS = Object.freeze([["reason", "reason"], ["secret", "secret"], ["status", "httpStatus"], ["workflow", "workflow"], ["allowance", "allowance"], ["cause", "causeReason"]]);

/** `reason=<CODE> status=<n> workflow=<file> ...` 한 줄. 값이 없는 키는 쓰지 않는다. */
export function formatReasonLine(details) {
  return REASON_LINE_KEYS
    .filter(([, field]) => details[field] !== undefined)
    .map(([key, field]) => `${key}=${details[field]}`)
    .join(" ");
}

export function createSecretSyncError(message, reason, secret) {
  const resolvedReason = Object.values(SECRET_SYNC_REASON).includes(reason)
    ? reason
    : INTERNAL_ERROR_REASON;
  const error = new Error(message);
  error.reason = resolvedReason;
  if (typeof secret === "string" && secret.length > 0) {
    error.secret = secret;
  }
  return error;
}

export function formatSecretSyncReasonLine(error, allowedSecrets = []) {
  const reason = Object.values(SECRET_SYNC_REASON).includes(error?.reason)
    ? error.reason
    : INTERNAL_ERROR_REASON;
  const secret = typeof error?.secret === "string" && allowedSecrets.includes(error.secret)
    ? error.secret
    : undefined;
  return formatReasonLine({ reason, secret });
}

