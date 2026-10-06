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

/** 원천 등록 도구(createSourceRegistrationTransaction)가 쓰는 네 파일. */
export const SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS = Object.freeze([
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
]);

const SNAPSHOT_FILE = /^tools\/datapack\/sources\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;

/**
 * 재확인 PR이 바꿔도 되는 경로: 등록 도구의 네 출력 파일과 새로 만든 원천 snapshot 파일(tools/datapack/sources/<이름>.json).
 * 후보·release request·hash evidence·환승 지표 같은 파생 산출물은 이 PR이 쓰지 않는다(후속 재결속·후보 갱신의 몫이다).
 * 경로만 본다. snapshot 파일이 새 파일인지(기존 파일 수정 금지)는 상태를 아는 controller가 확인한다.
 */
export function isSourceReverificationAllowedPath(relative) {
  if (typeof relative !== "string") return false;
  return SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS.includes(relative) || SNAPSHOT_FILE.test(relative);
}
