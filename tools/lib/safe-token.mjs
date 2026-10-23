// 로그·계측 기록·정책에 남기는 식별자(원천 id, 오류 코드 등)의 안전한 토큰 형식. 경로·공백·개행·비밀이 섞일 수 없는 최소 문자 집합이다.
// 계측을 쓰는 쪽(source-fetch-telemetry)과 그 기록을 읽는 쪽(provider-call-ledger, provider-call-budget)이 같은 형식을 써야 하므로 한 곳에 둔다.
export const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,48}$/u;

export const isSafeToken = (value) => typeof value === "string" && SAFE_TOKEN.test(value);
