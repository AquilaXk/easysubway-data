// AquilaXk/easysubway-backend#480: network_edges의 계단 칸 규칙(서버 경로 번들·모바일 카탈로그 팩 공통).
// - stair_access_state(STEP_FREE·STAIR_ONLY·UNKNOWN)가 기준값이다.
// - includes_stairs는 NOT NULL 계약이라 미확인을 담지 못한다. 그래서 확인된 계단(STAIR_ONLY)일 때만 1이다.
// - includes_stairs=0은 계단 없음이 아니다. 계단 없음은 STEP_FREE로만 표현한다.
// - 상태가 없으면 includesStairs=true일 때만 STAIR_ONLY이고, 그 밖에는 UNKNOWN이다.
// - 계단 여부와 상태가 어긋나거나 상태 값이 계약 밖이면 팩을 만들지 않는다.
// 읽는 쪽(2026-10-04 확인)
// - backend(#471 병합): strict 환승은 STEP_FREE를 요구하고, UNKNOWN은 미확정으로 다룬다.
// - mobile: includes_stairs 칸을 화면에 쓰는 기능이 없다.
const STAIR_ACCESS_STATES = new Set(["STEP_FREE", "STAIR_ONLY", "UNKNOWN"]);

export function networkEdgeStairColumns(edge, edgeId) {
  const declared = edge.includesStairs;
  const stairAccessState = edge.stairAccessState ?? (declared === true ? "STAIR_ONLY" : "UNKNOWN");
  if (!STAIR_ACCESS_STATES.has(stairAccessState) || (declared !== undefined && typeof declared !== "boolean")
    || (declared === true && stairAccessState !== "STAIR_ONLY") || (declared === false && stairAccessState === "STAIR_ONLY")) {
    throw new Error(`network edge stair state is invalid: ${edgeId}`);
  }
  return { includesStairs: stairAccessState === "STAIR_ONLY" ? 1 : 0, stairAccessState };
}
