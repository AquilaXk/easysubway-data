// 자동화 가드가 실패할 때 stderr 마지막 줄과 실패 영수증에 남기는 사유의 공용 어휘와 형식.
// 판정은 그대로 fail-closed이고, 이 모듈은 "어떤 검사에서 왜 멈췄는지"를 안정적인 코드로 드러내기만 한다.
// 사유에는 토큰·Authorization 헤더·응답 본문·URL 쿼리를 싣지 않는다. 코드와 숫자·파일 이름만 쓴다.

/** GitHub REST를 부르는 가드가 공유하는 사유. 호출 방식 실패, HTTP 상태, 본문 이상을 구분한다. */
export const GITHUB_API_REASON = Object.freeze({
  GITHUB_API_REQUEST_FAILED: "GITHUB_API_REQUEST_FAILED", // fetch·gh 호출이 응답을 받기 전에 실패했다(연결 실패·timeout·본문 읽기 중단)
  GITHUB_API_STATUS: "GITHUB_API_STATUS", // 응답을 받았지만 성공(200)이 아니다. HTTP 상태 숫자를 함께 남긴다
  GITHUB_API_BODY_INVALID: "GITHUB_API_BODY_INVALID", // 성공 응답의 본문이 JSON이 아니거나 기대한 모양이 아니다
});

// 사유 줄의 키 순서. 사유 코드가 항상 먼저다.
const REASON_LINE_KEYS = Object.freeze([["reason", "reason"], ["status", "httpStatus"], ["workflow", "workflow"], ["allowance", "allowance"], ["cause", "causeReason"]]);

/** `reason=<CODE> status=<n> workflow=<file> ...` 한 줄. 값이 없는 키는 쓰지 않는다. */
export function formatReasonLine(details) {
  return REASON_LINE_KEYS
    .filter(([, field]) => details[field] !== undefined)
    .map(([key, field]) => `${key}=${details[field]}`)
    .join(" ");
}
