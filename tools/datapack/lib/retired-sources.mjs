// 거버넌스 원장에서 퇴역한 KRIC 접근성 원천 id. 정기 수집은 stationCnvFacl 하나만 하고 공개 데이터팩에도 행이 없다.
// 옛 데이터팩 잔재가 다시 쓰이지 않도록 막는 fail-closed 방어 전용이며, 새 소비처를 만들지 않는다.
export const RETIRED_KRIC_ACCESSIBILITY_SOURCE_IDS = Object.freeze([
  "kric-station-elevator",
  "kric-station-elevator-movement",
  "kric-station-escalator",
  "kric-wheelchair-lift-location",
  "kric-wheelchair-lift-movement",
]);

// 그중 이동동선 원천. #834 QA 결정(2026-09-30): 엘리베이터 이동경로는 kric-station-movement-standard(서버 번들 전용)로 교체했고,
// 이 원천들은 구조화된 엘리베이터 참조가 없어 계속 차단한다.
export const RETIRED_KRIC_MOVEMENT_SOURCE_IDS = Object.freeze([
  "kric-station-elevator-movement",
  "kric-wheelchair-lift-movement",
]);
