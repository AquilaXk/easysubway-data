// P7D 원천 재확인 recipe 표(#984, #969 남은 단계 1, #870 전체 자동화 1단계).
//
// seq127(#940)·seq128(#976)에서 에이전트가 손으로 실행한 수집 → OCI 게시 → 원장 등록 절차를 원천별 recipe로 고정한다.
// 이 파일은 메타데이터(원천·의존·만료 기준)만 둔다. 단계 구현은 run-source-reverification.mjs의 RECIPE_STEPS에 있다.
//
// - 정책(release/product-gates/datapack-freshness-sla.json)의 P7D 원천은 모두 P7D_SOURCE_COVERAGE에 있어야 한다.
//   recipe가 맡거나(recipe), 이미 자기 workflow가 있거나(external), 막힌 사유가 있다(blocked). 빠진 원천이 생기면 테스트가 실패한다.
// - recipe는 자기 만료 기준(due)을 갖거나, 의존 대상(dependsOn)이 돌 때 함께 돈다. 둘 다 갖거나 둘 다 없을 수 없다.
// - 순서는 SOURCE_REVERIFICATION_RECIPE_IDS(경로·증거 계약)와 같다. 의존하는 recipe는 의존 대상 뒤에 온다.
import { SOURCE_REVERIFICATION_RECIPE_IDS } from "../ci/source-reverification-paths.mjs";

const DAEGU_LINES = Object.freeze([1, 2, 3]);
const DAEGU_TOPOLOGY_SOURCE_IDS = Object.freeze(DAEGU_LINES.map((line) => `daegu-line${line}-route-topology`));
const DAEGU_TIMETABLE_SOURCE_IDS = Object.freeze(DAEGU_LINES.map((line) => `daegu-line${line}-train-timetable`));

const ledgerHead = (...sourceIds) => Object.freeze({ kind: "ledger-head", sourceIds: Object.freeze(sourceIds) });

export const REVERIFICATION_RECIPES = Object.freeze([
  {
    id: "kric-capital-timetable",
    message: "[Data] KRIC 전국 시간표 수도권·코레일 projection을 원본 재수집으로 재확인",
    sourceIds: ["kric-nationwide-timetable-file"],
    dependsOn: [],
    // 원장 행이 아니라 inventory 증거(capital·korail projection)의 observedAt이 기준이다.
    due: Object.freeze({
      kind: "inventory-evidence", sourceId: "kric-nationwide-timetable-file", classId: "official_static_timetable_confirmation",
      evidenceKeys: Object.freeze(["capitalScheduleAdmissionEvidence", "korailScheduleAdmissionEvidence"]), basisField: "observedAt",
    }),
  },
  {
    id: "korail-topology",
    message: "[Data] 코레일 광역 시간표 topology를 같은 원본으로 재확인해 등록",
    sourceIds: ["korail-metropolitan-timetable-file"],
    dependsOn: [],
    due: ledgerHead("korail-metropolitan-timetable-file"),
  },
  {
    id: "korail-planned-timetable",
    message: "[Data] 코레일 계획 시각표를 재확인한 topology head에 다시 결속해 등록",
    sourceIds: ["korail-metropolitan-planned-timetable"],
    dependsOn: ["korail-topology"],
    due: null,
  },
  {
    id: "gwangju-topology",
    message: "[Data] 광주 topology를 다시 수집해 등록",
    sourceIds: ["gwangju-transportation-route-topology"],
    dependsOn: [],
    due: ledgerHead("gwangju-transportation-route-topology"),
  },
  {
    id: "gwangju-accessibility",
    message: "[Data] 광주 접근성 시설을 새 topology head에 다시 결속해 등록",
    sourceIds: ["gwangju-transportation-accessibility"],
    dependsOn: ["gwangju-topology"],
    due: null,
  },
  {
    id: "busan-topology",
    message: "[Data] 부산 topology를 다시 수집해 등록",
    sourceIds: ["busan-transportation-route-topology"],
    dependsOn: [],
    due: ledgerHead("busan-transportation-route-topology"),
  },
  {
    id: "daejeon-topology",
    message: "[Data] 대전 topology를 다시 수집해 등록",
    sourceIds: ["daejeon-station-distance-fare"],
    dependsOn: [],
    due: ledgerHead("daejeon-station-distance-fare"),
  },
  {
    id: "daejeon-accessibility",
    message: "[Data] 대전 접근성 시설을 새 topology head에 다시 결속해 등록",
    sourceIds: ["daejeon-transportation-accessibility"],
    dependsOn: ["daejeon-topology"],
    due: null,
  },
  {
    id: "daegu-sources",
    message: "[Data] 대구 1~3호선 topology·시간표 파일을 다시 받아 등록",
    // 여섯 원천은 한 번에 등록한다(등록기가 여섯 개를 묶는다). 만료 기준은 P7D인 topology 셋이다.
    sourceIds: [...DAEGU_TOPOLOGY_SOURCE_IDS, ...DAEGU_TIMETABLE_SOURCE_IDS],
    dependsOn: [],
    due: ledgerHead(...DAEGU_TOPOLOGY_SOURCE_IDS),
  },
]);

if (JSON.stringify(REVERIFICATION_RECIPES.map(({ id }) => id)) !== JSON.stringify(SOURCE_REVERIFICATION_RECIPE_IDS)) {
  throw new Error("REVERIFICATION_RECIPE_TABLE: recipe order differs from the shared recipe id contract");
}

export function recipeById(id) {
  const found = REVERIFICATION_RECIPES.find((recipe) => recipe.id === id);
  if (!found) throw new Error(`REVERIFICATION_RECIPE_UNKNOWN: ${String(id)}`);
  return found;
}

/**
 * 정책의 P7D 원천 → 누가 다시 확인하는가.
 *  recipe   이 단계의 recipe가 맡는다.
 *  external 이미 자기 workflow가 있다(중복 자동화를 만들지 않는다). 값은 REFRESH_CLAIM_PREFIXES의 workflow 파일이다.
 *  blocked  자동화할 수 없는 사유(없애는 이슈를 가리킨다). 지금은 없다.
 * kric-nationwide-timetable-file은 두 갈래다: 수도권·코레일 projection은 이 recipe, 광주 보관본은 일일 재확인 workflow.
 */
export const P7D_SOURCE_COVERAGE = Object.freeze({
  "capital-route-topology": Object.freeze({ external: "current-capital-topology-registration.yml" }),
  "incheon-transit-station-info": Object.freeze({ external: "current-capital-topology-refresh.yml" }),
  "korail-metropolitan-timetable-file": Object.freeze({ recipe: "korail-topology" }),
  "gwangju-transportation-route-topology": Object.freeze({ recipe: "gwangju-topology" }),
  "busan-transportation-route-topology": Object.freeze({ recipe: "busan-topology" }),
  "daejeon-station-distance-fare": Object.freeze({ recipe: "daejeon-topology" }),
  "daegu-line1-route-topology": Object.freeze({ recipe: "daegu-sources" }),
  "daegu-line2-route-topology": Object.freeze({ recipe: "daegu-sources" }),
  "daegu-line3-route-topology": Object.freeze({ recipe: "daegu-sources" }),
  "kric-nationwide-timetable-file": Object.freeze({ recipe: "kric-capital-timetable", external: "retained-gwangju-timetable-refresh.yml" }),
});

/** 정책에서 reverificationCadence가 P7D인 클래스의 원천 id(정렬). */
export function p7dSourceIds(policy) {
  if (!Array.isArray(policy?.sourceClasses)) throw new Error("REVERIFICATION_POLICY_INVALID: sourceClasses");
  return policy.sourceClasses.filter((entry) => entry?.reverificationCadence === "P7D").flatMap((entry) => entry.sourceIds ?? []).sort();
}
