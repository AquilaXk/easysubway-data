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

// 재확인이 inventory 항목에서 바꾸는 필드(#987 N1). 정책성 필드(productionUseAllowed·requiredForProductionPack·license·datasetUrl·coverage 등)는 어떤 recipe도 바꾸지 않는다.
// 실제 등록 도구가 바꾼 필드를 seq127(#940)의 recipe별 커밋(광주·부산·대전·대구·접근성·코레일·KRIC)에서 읽어 정했다.
const TOPOLOGY_FIELDS = Object.freeze(["observedDataUpdatedAt", "retrievedAt", "topologyAdmissionEvidence", "membershipAdmissionEvidence"]);
const SCHEDULE_FIELDS = Object.freeze(["observedDataUpdatedAt", "retrievedAt", "scheduleAdmissionEvidence"]);
const ACCESSIBILITY_FIELDS = Object.freeze(["accessibilityAdmissionEvidence"]);
const ROUTE_MAP_FIELDS = Object.freeze(["routeMapAdmissionEvidence"]);
const MEMBERSHIP_FIELDS = Object.freeze(["membershipAdmissionEvidence"]);
const changes = (map) => Object.freeze(Object.fromEntries(Object.entries(map).map(([sourceId, fields]) => [sourceId, Object.freeze([...fields])])));

const ledgerHead = (...sourceIds) => Object.freeze({ kind: "ledger-head", sourceIds: Object.freeze(sourceIds) });

export const REVERIFICATION_RECIPES = Object.freeze([
  {
    id: "kric-capital-timetable",
    message: "[Data] KRIC 전국 시간표 수도권·코레일 projection을 원본 재수집으로 재확인",
    sourceIds: ["kric-nationwide-timetable-file"],
    dependsOn: [],
    inventoryChanges: changes({ "kric-nationwide-timetable-file": ["capitalScheduleAdmissionEvidence", "korailScheduleAdmissionEvidence"] }),
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
    inventoryChanges: changes({ "korail-metropolitan-timetable-file": ["retrievedAt", "observedDataUpdatedAt", "topologyAdmissionEvidence"] }),
    due: ledgerHead("korail-metropolitan-timetable-file"),
  },
  {
    id: "korail-planned-timetable",
    message: "[Data] 코레일 계획 시각표를 재확인한 topology head에 다시 결속해 등록",
    sourceIds: ["korail-metropolitan-planned-timetable"],
    dependsOn: ["korail-topology"],
    inventoryChanges: changes({ "korail-metropolitan-planned-timetable": SCHEDULE_FIELDS }),
    due: null,
  },
  {
    id: "gwangju-topology",
    message: "[Data] 광주 topology를 다시 수집해 등록",
    sourceIds: ["gwangju-transportation-route-topology"],
    dependsOn: [],
    // 등록 도구가 의존 항목(접근성·노선도 위치·MOLIT 멤버십)과 광주 보관 시간표의 topology 결속도 함께 다시 맞춘다.
    inventoryChanges: changes({
      "gwangju-transportation-route-topology": TOPOLOGY_FIELDS, "gwangju-transportation-accessibility": ACCESSIBILITY_FIELDS,
      "gwangju-transportation-route-map-positions": ROUTE_MAP_FIELDS, "molit-urban-rail-full-route-gwangju-membership": MEMBERSHIP_FIELDS,
      "kric-nationwide-timetable-file": ["retainedScheduleAdmissionEvidence"],
    }),
    due: ledgerHead("gwangju-transportation-route-topology"),
  },
  {
    id: "gwangju-accessibility",
    message: "[Data] 광주 접근성 시설을 새 topology head에 다시 결속해 등록",
    sourceIds: ["gwangju-transportation-accessibility"],
    dependsOn: ["gwangju-topology"],
    inventoryChanges: changes({ "gwangju-transportation-accessibility": ACCESSIBILITY_FIELDS }),
    due: null,
  },
  {
    id: "busan-topology",
    message: "[Data] 부산 topology를 다시 수집해 등록",
    sourceIds: ["busan-transportation-route-topology"],
    dependsOn: [],
    inventoryChanges: changes({ "busan-transportation-route-topology": TOPOLOGY_FIELDS }),
    due: ledgerHead("busan-transportation-route-topology"),
  },
  {
    id: "daejeon-topology",
    message: "[Data] 대전 topology를 다시 수집해 등록",
    sourceIds: ["daejeon-station-distance-fare"],
    dependsOn: [],
    inventoryChanges: changes({
      "daejeon-station-distance-fare": TOPOLOGY_FIELDS, "daejeon-train-timetable": ["scheduleAdmissionEvidence"], "daejeon-transportation-accessibility": ACCESSIBILITY_FIELDS,
      "daejeon-transportation-route-map-positions": ROUTE_MAP_FIELDS, "molit-urban-rail-full-route-daejeon-membership": MEMBERSHIP_FIELDS,
    }),
    due: ledgerHead("daejeon-station-distance-fare"),
  },
  {
    id: "daejeon-accessibility",
    message: "[Data] 대전 접근성 시설을 새 topology head에 다시 결속해 등록",
    sourceIds: ["daejeon-transportation-accessibility"],
    dependsOn: ["daejeon-topology"],
    inventoryChanges: changes({ "daejeon-transportation-accessibility": ACCESSIBILITY_FIELDS }),
    due: null,
  },
  {
    id: "daegu-sources",
    message: "[Data] 대구 1~3호선 topology·시간표 파일을 다시 받아 등록",
    // 여섯 원천은 한 번에 등록한다(등록기가 여섯 개를 묶는다). 만료 기준은 P7D인 topology 셋이다.
    sourceIds: [...DAEGU_TOPOLOGY_SOURCE_IDS, ...DAEGU_TIMETABLE_SOURCE_IDS],
    dependsOn: [],
    inventoryChanges: changes({
      ...Object.fromEntries(DAEGU_TOPOLOGY_SOURCE_IDS.map((id) => [id, TOPOLOGY_FIELDS])),
      ...Object.fromEntries(DAEGU_TIMETABLE_SOURCE_IDS.map((id) => [id, SCHEDULE_FIELDS])),
      "daegu-transportation-route-map-positions": ROUTE_MAP_FIELDS,
      ...Object.fromEntries(DAEGU_LINES.map((line) => [`molit-urban-rail-full-route-daegu-line${line}-membership`, MEMBERSHIP_FIELDS])),
    }),
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

const byText = (left, right) => (left < right ? -1 : Number(left > right));

/**
 * inventory 변화가 소유 범위 안인지 본다(#987 N1, 등록 단계 #989와 공용).
 * - allowed에 없는 항목은 base와 head가 깊은 비교로 같아야 한다.
 * - allowed에 있는 항목은 명시한 필드만 바뀔 수 있다. 정책성 필드는 어디에도 명시하지 않으므로 고정이다.
 * - 항목을 더하거나 지우는 것은 소유 여부와 상관없이 위반이다.
 * @param {{ base: object, head: object, allowed: Map<string, Set<string>> }} input allowed는 항목 id -> 바뀔 수 있는 필드 집합
 * @returns {string[]} 항목별 위반 사유(없으면 빈 배열)
 */
export function inventoryScopeViolations({ base, head, allowed }) {
  const entries = (inventory) => new Map(inventory.sources.map((entry) => [entry?.id, entry]));
  const before = entries(base);
  const after = entries(head);
  const violations = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort(byText)) {
    const [was, now] = [before.get(id), after.get(id)];
    if (was === undefined || now === undefined) { violations.push(`${String(id)}: the inventory entry was ${was === undefined ? "added" : "removed"}`); continue; }
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    const fields = allowed.get(id);
    if (!fields) { violations.push(`${id}: the entry changed but no recipe in this pull request owns it (not owned)`); continue; }
    const outside = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]) && !fields.has(key));
    if (outside.length > 0) violations.push(`${id}: fields outside the recipe's refresh set changed: ${outside.sort(byText).join(", ")}`);
  }
  return violations;
}

/**
 * 재확인 PR의 inventory 변화가 실행한 recipe의 소유 범위 안인지 본다(#987 N1).
 * @returns {string[]} 항목별 위반 사유(없으면 빈 배열)
 */
export function inventoryChangeViolations({ base, head, recipeIds }) {
  const allowed = new Map();
  for (const id of recipeIds) {
    for (const [sourceId, fields] of Object.entries(recipeById(id).inventoryChanges)) allowed.set(sourceId, new Set([...(allowed.get(sourceId) ?? []), ...fields]));
  }
  return inventoryScopeViolations({ base, head, allowed });
}
