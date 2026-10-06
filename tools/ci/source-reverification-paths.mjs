// P7D 원천 재확인(#984, #969 남은 단계 1)이 바꿀 수 있는 경로와 recipe id의 단일 계약.
// controller(tools/datapack/run-source-reverification.mjs)와 PR 증거 블록(automation-pr-evidence)과 2단계 자동 병합 정책이
// 같은 상수를 읽는다. 코드에 같은 목록을 두 번 쓰지 않는다.

/** 실행 순서이기도 하다. 의존하는 recipe(접근성·계획 시각표)는 의존 대상 뒤에 온다. */
export const SOURCE_REVERIFICATION_RECIPE_IDS = Object.freeze([
  "kric-capital-timetable",
  "korail-topology",
  "korail-planned-timetable",
  "gwangju-topology",
  "gwangju-accessibility",
  "busan-topology",
  "daejeon-topology",
  "daejeon-accessibility",
  "daegu-sources",
]);

/**
 * 재확인이 제자리에서 바꿀 수 있는 원천 등록 결과 파일 셋.
 * 신선도 정책(release/product-gates/datapack-freshness-sla.json)은 일부러 뺐다(#987 리뷰 F4): 등록 도구는 이 파일을 입력으로 읽고
 * 트랜잭션으로 다시 쓰지만, 이미 등록된 원천의 재확인은 바이트가 같아야 한다. dueAt·주기·허용 오차를 정하는 정책이 바뀌면
 * 데이터 행과 같은 신뢰 경로로 조용히 병합되지 않도록 REVERIFICATION_OUTPUT_SCOPE로 멈춘다.
 */
export const SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS = Object.freeze([
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-governance-policy.json",
]);

const SNAPSHOT_FILE = /^tools\/datapack\/sources\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;

/**
 * 재확인 PR이 바꿔도 되는 경로: 등록 결과 세 파일과 새로 만든 원천 snapshot 파일(tools/datapack/sources/<이름>.json).
 * 후보·release request·hash evidence·환승 지표 같은 파생 산출물은 이 PR이 쓰지 않는다(후속 재결속·후보 갱신의 몫이다).
 * 경로만 본다. snapshot 파일이 새 파일인지(기존 파일 수정 금지)는 상태를 아는 controller가 확인한다.
 */
export function isSourceReverificationAllowedPath(relative) {
  if (typeof relative !== "string") return false;
  return SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS.includes(relative) || SNAPSHOT_FILE.test(relative);
}
