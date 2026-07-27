// #2514 (#2510 B0) 전국 candidate pack 게이트 하네스 회귀. #2549 (#2510 B1) 대구 편입,
// #2580 (#2510 B2-a) 다도메인 편입 체인, #2587 (#2510 B2-b) 부산 편입으로 확장.
//
// 검증 축:
//   1. tracked evidence가 현행 입력에서 바이트 단위로 재생성된다(오프라인·서명 키 없이).
//   2. 파일럿 scope가 line-scope 재기술 전 MISSING → 후 SUPPORTED로 전이한다.
//   3. 대구 9 requirement가 같은 실행에서 MISSING → SUPPORTED로 전이한다(B1).
//   4. spec의 line-scope 재기술과 tracked source-inventory가 어긋나면 하네스가 fail closed 한다.
//   5. 지역 데이터 편입은 allowlist materializer·tracked 입력·선언 행수·승계 행 불변에 묶인다(B1).
//   6. production 게시 트랙 fixture는 candidate 조립에 영향받지 않는다.
//   7. 대구 route_map_positions·accessibility_facilities 6 requirement가 B1 편입 뒤 체인으로 전이하고,
//      스키마 일반화가 안전 경계를 넓히지 않는다(B2-a).
//   8. 부산 4노선 5도메인 20 requirement가 같은 실행에서 전이하고, 지역 자체가 없는 승계 원본에
//      topology → 나머지 도메인 순으로 체인되는 선행 조건이 조립에서 강제된다(B2-b).
//   9. 대전·광주 5도메인, 수도권 노선도 23 requirement, 인천 13 requirement가 같은 실행에서 전이한다(B3).
//  10. 선언된 non-transition 축이 전환 범위를 넓히지 못한다(B3): 실제로 전환되는 키에 선언을 달거나,
//      사유를 빼거나, 선언 없이 전환되지 않은 키가 남으면 모두 fail closed 된다.
//
// 실행 시간: 편입별 결속·창 회귀는 그 편입 하나만 담은 축소 spec으로 돈다. 대상 편입은 앞선 편입 결과에
// 의존하지 않고(지역의 첫 편입이 운영기관·노선·역을 세우거나, 수도권 KRIC 노선도처럼 계보를 tracked
// snapshot 파일로 대조한다. 서울 1~8호선 편입만 승계 pack에 의존하는데 그 선행 조건인 서울교통공사
// 운영기관·cyberstation 소스는 승계 원본이 이미 갖고 있어 축소해도 그대로 만족된다),
// 이 회귀들이 겨냥한 두 가드는 모두 어댑터의 경로 결속과 materializer
// requiredSource의 창 판정이라 승계 행수 대조·pack 선행 조건 검사보다 먼저 걸린다(실측). 축소로 달라지는
// addedRows는 그 판정에 닿지 않고, 가드를 끄면 진단 문구가 달라져 assert.rejects가 그대로 FAIL한다.
// 순서 의존·체인 오염·addedRows 누적을 보는 회귀와 전이 판정을 보는 회귀는 그대로 전체 spec으로 돈다.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  EVIDENCE_PATH,
  assertLineScopeRedescriptionsMatchActualRequiredSet,
  assertInheritedRowsUnchanged,
  assertNonTransitionReasons,
  inheritedRowSnapshot,
  runNationwideCandidateCoverageGate,
} from "./run-nationwide-candidate-coverage-gate.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const TOOL_PATH = "tools/datapack/run-nationwide-candidate-coverage-gate.mjs";
const SPEC_PATH = "tools/datapack/nationwide-candidate-pack-spec.json";
const TARGETS_PATH = "tools/datapack/nationwide-coverage-targets.json";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const APP_INVENTORY_PATH = "apps/mobile/assets/datapacks/source-inventory.json";
const RESOLUTION_PLAN_PATH =
  "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json";
const RESOLUTIONS_PATH =
  "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json";
const REVIEWED_PACK_PATH = "tools/datapack/release/capital-production-reviewed-pack.json";
const PILOT_REQUIREMENT_KEY = "capital:seoul-metro:seoul-4:route_map_positions";
const PILOT_SOURCE_ID = "seoulmetro-cyberstation-route-map";
// #2549 B1 대상 9 requirement(대구 3노선 × membership/topology/timetable)와
// #2580 B2-a 대상 6 requirement(대구 3노선 × route_map_positions/accessibility_facilities).
const DAEGU_LINE_IDS = ["line-5b8d9b05e7e6", "line-e2938a4cc492", "line-0ffaa95b1b5d"];
const daeguRequirementKeys = (domains) => DAEGU_LINE_IDS
  .flatMap((lineId) => domains.map((domain) => `daegu:daegu-transportation:${lineId}:${domain}`));
const DAEGU_B1_DOMAINS = ["station_line_membership", "route_graph_topology", "schedule_timetable"];
const DAEGU_B1_REQUIREMENT_KEYS = daeguRequirementKeys(DAEGU_B1_DOMAINS);
const DAEGU_B2A_REQUIREMENT_KEYS = daeguRequirementKeys(["route_map_positions", "accessibility_facilities"]);
const DAEGU_REQUIREMENT_KEYS = [...DAEGU_B1_REQUIREMENT_KEYS, ...DAEGU_B2A_REQUIREMENT_KEYS];
// #2587 B2-b 대상 20 requirement(부산 4노선 × 5도메인).
const BUSAN_LINE_IDS = ["line-ab1a041f6266", "line-d74614a04530", "line-d812a5bc1e5f", "line-eb7b47920390"];
const BUSAN_DOMAINS = [
  "station_line_membership",
  "route_graph_topology",
  "schedule_timetable",
  "route_map_positions",
  "accessibility_facilities",
];
const BUSAN_REQUIREMENT_KEYS = BUSAN_LINE_IDS
  .flatMap((lineId) => BUSAN_DOMAINS.map((domain) => `busan:busan-transportation:${lineId}:${domain}`));
// 편입 체인 순서. route_map·accessibility materializer는 pack.sourceInventory에 대구 시각표 소스가
// 이미 있을 것을 선행 조건으로 검사하므로 시각표 편입이 먼저여야 한다. 부산은 승계 원본에 지역 자체가
// 없어 topology 편입이 운영기관·노선·역을 먼저 싣고 나머지 세 도메인이 그 계보를 선행 조건으로 검사한다.
const DAEGU_MATERIALIZERS = [
  "tools/datapack/materialize-daegu-timetable.mjs",
  "tools/datapack/materialize-daegu-route-map-positions.mjs",
  "tools/datapack/materialize-daegu-accessibility.mjs",
];
const BUSAN_MATERIALIZERS = [
  "tools/datapack/materialize-busan-route-topology.mjs",
  "tools/datapack/materialize-busan-timetable.mjs",
  "tools/datapack/materialize-busan-route-map-positions.mjs",
  "tools/datapack/materialize-busan-accessibility.mjs",
];
// #2595 B3 대상. 대전·광주는 각 1노선 × 5도메인이고, 수도권은 노선도 한 도메인에 11 소스·18 노선이다.
const DAEJEON_LINE_ID = "line-7051a9c2525c";
const GWANGJU_LINE_ID = "line-e57a361e8892";
const SINGLE_LINE_DOMAINS = [
  "station_line_membership",
  "route_graph_topology",
  "schedule_timetable",
  "route_map_positions",
  "accessibility_facilities",
];
const DAEJEON_REQUIREMENT_KEYS = SINGLE_LINE_DOMAINS
  .map((domain) => `daejeon:daejeon-transportation:${DAEJEON_LINE_ID}:${domain}`);
const GWANGJU_REQUIREMENT_KEYS = SINGLE_LINE_DOMAINS
  .map((domain) => `gwangju:gwangju-metropolitan-rapid-transit:${GWANGJU_LINE_ID}:${domain}`);
// 수도권 노선도 재기술이 여는 requirement. 4호선은 B0 파일럿 키와 같아 여기서 제외한다 — 이 배열은
// "이 배치가 새로 여는 키"이고 4호선은 이미 SUPPORTED라 순증이 아니다(근거 소스만 둘로 는다).
const CAPITAL_ROUTE_MAP_REQUIREMENT_KEYS = [
  ["korail", "line-6e39be0cb6e2"],
  ["korail", "line-54a7b980b7c3"],
  ["korail", "line-558d0bd8312d"],
  ["korail", "line-e4939a4b4713"],
  ["operator-8134e61f8dbd", "line-e9e9a5b520a4"],
  ["operator-29e323a78a93", "line-62096860ab09"],
  ["operator-b2d80436b438", "line-828f04afc588"],
  ["operator-3c623bf1a427", "line-30886152e4f8"],
  ["operator-10d7cf275a80", "line-aefa08ccc0a9"],
  ["operator-2e23276dfa94", "line-5500c1600f71"],
  ["seoul-metro", "line-472a81add377"],
  ["seoul-metro", "seoul-2"],
  ["seoul-metro", "line-41a8c75ec9d8"],
  ["seoul-metro", "line-80fc4d5350d4"],
  ["seoul-metro", "line-3f41718e0833"],
  ["seoul-metro", "line-15b3b8a93259"],
  ["seoul-metro", "line-2b2d9eaa53d0"],
].map(([operatorId, lineId]) => `capital:${operatorId}:${lineId}:route_map_positions`);
const DAEJEON_MATERIALIZERS = [
  "tools/datapack/materialize-daejeon-timetable.mjs",
  "tools/datapack/materialize-daejeon-route-map-positions.mjs",
  "tools/datapack/materialize-daejeon-accessibility.mjs",
];
const GWANGJU_MATERIALIZERS = [
  "tools/datapack/materialize-gwangju-timetable.mjs",
  "tools/datapack/materialize-gwangju-route-map-positions.mjs",
  "tools/datapack/materialize-gwangju-accessibility.mjs",
];
// #2595 B3 두 번째 배치. 수도권 노선도 카탈로그의 남은 3노선(서해선·GTX-A·신분당선)은 admission 정본이
// 두 운영기관 scope를 dual coverage로 등재해 materializer 정본 대조가 단일 운영기관만 허용하던 동안 막혀
// 있었다. 서해선·GTX-A는 두 scope가 모두 #2138 activeLineScopes에 있어 노선마다 requirement가 둘이고,
// 신분당선은 정본의 서울교통공사 표기가 FILE admission 계보 항목이라 대응 scope가 없어 하나다.
// 9호선은 한 노선을 두 소스가 나눠 덮어 requirement 하나를 두 소스가 함께 뒷받침한다.
const CAPITAL_DUAL_OPERATOR_REQUIREMENT_KEYS = [
  ["korail", "line-051552e50435"],
  ["operator-38450e138464", "line-051552e50435"],
  ["operator-5ca780d7dee1", "line-8604048b6430"],
  ["operator-9e999d4aa596", "line-8604048b6430"],
  ["operator-28e01fb8509d", "shinbundang"],
  ["operator-936e454d0bfb", "line-f0e747248a31"],
].map(([operatorId, lineId]) => `capital:${operatorId}:${lineId}:route_map_positions`);
// 인천 3노선. 7호선은 인천교통공사 scope로 세 도메인이 열리지만 구간(route_graph_topology)만 열리지
// 않는다 — 역사정보 소스가 7호선 network_edges를 구조적으로 admit하지 않기 때문이며, spec이 그 사실을
// nonTransitioningRequirements로 선언하고 하네스가 실측(뒷받침 행 0건)으로 확인한다.
const INCHEON_LINE1_ID = "line-98718184f016";
const INCHEON_LINE2_ID = "line-42b5805f3b5a";
const INCHEON_LINE7_ID = "line-15b3b8a93259";
const INCHEON_NON_TRANSITION_KEY = `capital:incheon-transit:${INCHEON_LINE7_ID}:route_graph_topology`;
const INCHEON_REQUIREMENT_KEYS = [
  ...[INCHEON_LINE2_ID, INCHEON_LINE1_ID].flatMap(
    (lineId) => SINGLE_LINE_DOMAINS.map((domain) => `capital:incheon-transit:${lineId}:${domain}`),
  ),
  ...["station_line_membership", "route_map_positions", "accessibility_facilities"]
    .map((domain) => `capital:incheon-transit:${INCHEON_LINE7_ID}:${domain}`),
];
const CAPITAL_MATERIALIZERS = [
  "tools/datapack/materialize-kric-capital-wide-rail-route-map-positions.mjs",
  "tools/datapack/materialize-kric-capital-light-rail-route-map-positions.mjs",
  "tools/datapack/materialize-seoul-route-map-positions.mjs",
  "tools/datapack/materialize-seoul9-phase1-route-map-positions.mjs",
  "tools/datapack/materialize-seoul9-route-map-positions.mjs",
];
const INCHEON_MATERIALIZERS = [
  "tools/datapack/materialize-incheon-station-info.mjs",
  "tools/datapack/materialize-incheon-timetable.mjs",
  "tools/datapack/materialize-incheon-accessibility.mjs",
];
const INCLUSION_CHAIN = [
  ...DAEGU_MATERIALIZERS.map((materializer) => ({ regionId: "daegu", materializer })),
  ...BUSAN_MATERIALIZERS.map((materializer) => ({ regionId: "busan", materializer })),
  ...DAEJEON_MATERIALIZERS.map((materializer) => ({ regionId: "daejeon", materializer })),
  ...GWANGJU_MATERIALIZERS.map((materializer) => ({ regionId: "gwangju", materializer })),
  ...CAPITAL_MATERIALIZERS.map((materializer) => ({ regionId: "capital", materializer })),
  ...INCHEON_MATERIALIZERS.map((materializer) => ({ regionId: "incheon", materializer })),
];
// 부산 편입 인덱스(대구 3건 뒤에 이어 붙는다).
const BUSAN_TOPOLOGY_INDEX = DAEGU_MATERIALIZERS.length;
const DAEJEON_INDEX = BUSAN_TOPOLOGY_INDEX + BUSAN_MATERIALIZERS.length;
const GWANGJU_INDEX = DAEJEON_INDEX + DAEJEON_MATERIALIZERS.length;
const CAPITAL_INDEX = GWANGJU_INDEX + GWANGJU_MATERIALIZERS.length;
const INCHEON_INDEX = CAPITAL_INDEX + CAPITAL_MATERIALIZERS.length;
// 부산 편입 4종의 결속 지점·신선도 창 축. 결속 회귀를 편입 하나로만 두면 나머지 편입의 가드가 풀려도
// 회귀가 침묵하므로(네 편입 모두 실측상 fail closed다) 이 표로 편입별로 돌린다. 경로·창 값은 admission
// 정본(source-inventory)에서 끌어오고, 창 밖 진단은 판정 지점이 materializer마다 달라 문구가 갈리므로
// 편입별 패턴으로 고정한다.
const BUSAN_INCLUSION_BINDINGS = [
  {
    labelKo: "topology",
    slug: "route-topology",
    offset: 0,
    sourceId: "busan-transportation-route-topology",
    evidenceKey: "topologyAdmissionEvidence",
    stalePinPattern: /Busan route topology admission stale snapshot is rejected/,
  },
  {
    labelKo: "시각표",
    slug: "timetable",
    offset: 1,
    sourceId: "busan-transportation-timetable",
    evidenceKey: "scheduleAdmissionEvidence",
    stalePinPattern: /busan-transportation-timetable evidence freshness is invalid/,
  },
  {
    labelKo: "노선도",
    slug: "route-map-positions",
    offset: 2,
    sourceId: "busan-transportation-route-map-positions",
    evidenceKey: "routeMapAdmissionEvidence",
    // 이 문구만 신선도 전용이 아니다 — 노선도 정본에는 freshUntil이 없어 materializer에 신선도 블록이
    // 따로 없고, 하한(capturedAt 이후) 검사가 admission 정본 대조(positionsSha256·topologyContentSha256
    // 등)와 한 조건에 묶여 같은 문구를 낸다. 문구를 가르는 것은 materializer 쪽 판단이라 이 하네스가
    // 동작으로 바꾸지 않고, 대신 아래 대조 회귀가 그 문구의 원인을 하한 교차로 좁힌다.
    stalePinPattern: /busan-transportation-route-map-positions inventory evidence does not match snapshot/,
  },
  {
    labelKo: "편의시설",
    slug: "accessibility",
    offset: 3,
    sourceId: "busan-transportation-accessibility",
    evidenceKey: "accessibilityAdmissionEvidence",
    stalePinPattern: /busan-transportation-accessibility evidence freshness is invalid/,
  },
];
const [
  BUSAN_TOPOLOGY_BINDING,
  BUSAN_TIMETABLE_BINDING,
  BUSAN_ROUTE_MAP_BINDING,
  BUSAN_ACCESSIBILITY_BINDING,
] = BUSAN_INCLUSION_BINDINGS;
// 대전·광주·수도권 편입의 결속 지점·신선도 창 축(#2595). 부산 표와 같은 목적이지만 창 서술이 한 단계
// 넓다: 이 배치의 시각표 편입은 소스 하나가 아니라 두셋의 시각 판정을 동시에 받으므로 pin 창의 하한·상한이
// 서로 다른 정본에서 온다. 그래서 snapshot 결속(경로)과 창 경계(어느 정본의 어느 필드)를 따로 기술하고,
// 값은 전부 admission 정본에서 끌어온다. upperBound가 없으면 그 편입의 창에는 상한이 없다는 뜻이다.
const DAEJEON_TOPOLOGY_SOURCE_ID = "daejeon-station-distance-fare";
const GWANGJU_TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const DAEJEON_INCLUSION_BINDINGS = [
  {
    labelKo: "시각표",
    slug: "timetable",
    offset: 0,
    sourceId: "daejeon-train-timetable",
    evidenceKey: "scheduleAdmissionEvidence",
    // 하한을 정하는 것은 시각표 snapshot이 아니라 membership 정본의 verifiedAt이다(세 하한 중 최댓값).
    lowerBound: {
      sourceId: DAEJEON_TOPOLOGY_SOURCE_ID,
      evidenceKey: "membershipAdmissionEvidence",
      field: "verifiedAt",
    },
    // 상한은 topology 창이 먼저 닫힌다(시각표 창보다 3시간 빠르다).
    upperBound: {
      sourceId: DAEJEON_TOPOLOGY_SOURCE_ID,
      evidenceKey: "topologyAdmissionEvidence",
      field: "freshUntil",
    },
    belowLowerBoundPattern: /molit-urban-rail-full-route-daejeon-membership membership evidence is future-dated/,
    atUpperBoundPattern: /daejeon-station-distance-fare topology evidence is stale/,
    topologyBinding: { sourceId: DAEJEON_TOPOLOGY_SOURCE_ID, evidenceKey: "topologyAdmissionEvidence" },
  },
  {
    labelKo: "노선도",
    slug: "route-map-positions",
    offset: 1,
    sourceId: "daejeon-transportation-route-map-positions",
    evidenceKey: "routeMapAdmissionEvidence",
    lowerBound: {
      sourceId: "daejeon-transportation-route-map-positions",
      evidenceKey: "routeMapAdmissionEvidence",
      field: "capturedAt",
    },
    // 부산 노선도와 같은 비대칭이다 — 정본에 freshUntil이 없고 materializer도 하한만 검사하며, 그 하한
    // 검사가 정본 대조와 한 조건에 묶여 있어 문구가 신선도 전용이 아니다.
    belowLowerBoundPattern:
      /daejeon-transportation-route-map-positions inventory evidence does not match snapshot/,
    topologyBinding: { sourceId: DAEJEON_TOPOLOGY_SOURCE_ID, evidenceKey: "topologyAdmissionEvidence" },
  },
  {
    labelKo: "편의시설",
    slug: "accessibility",
    offset: 2,
    sourceId: "daejeon-transportation-accessibility",
    evidenceKey: "accessibilityAdmissionEvidence",
    lowerBound: {
      sourceId: "daejeon-transportation-accessibility",
      evidenceKey: "accessibilityAdmissionEvidence",
      field: "capturedAt",
    },
    upperBound: {
      sourceId: "daejeon-transportation-accessibility",
      evidenceKey: "accessibilityAdmissionEvidence",
      field: "freshUntil",
    },
    belowLowerBoundPattern: /daejeon-transportation-accessibility evidence freshness is invalid/,
    atUpperBoundPattern: /daejeon-transportation-accessibility evidence freshness is invalid/,
    topologyBinding: { sourceId: DAEJEON_TOPOLOGY_SOURCE_ID, evidenceKey: "topologyAdmissionEvidence" },
  },
];
const GWANGJU_INCLUSION_BINDINGS = [
  {
    labelKo: "시각표",
    slug: "timetable",
    offset: 0,
    sourceId: "gwangju-transportation-cyberstation-timetable",
    evidenceKey: "scheduleAdmissionEvidence",
    // 대전과 달리 membership 정본에는 시각 판정이 없다 — 하한은 topology snapshot의 capturedAt이 정한다.
    lowerBound: {
      sourceId: GWANGJU_TOPOLOGY_SOURCE_ID,
      evidenceKey: "topologyAdmissionEvidence",
      field: "capturedAt",
    },
    // 상한은 시각표 창이 먼저 닫힌다(topology 창보다 13분 빠르다).
    upperBound: {
      sourceId: "gwangju-transportation-cyberstation-timetable",
      evidenceKey: "scheduleAdmissionEvidence",
      field: "freshUntil",
    },
    belowLowerBoundPattern: /gwangju-transportation-route-topology evidence is stale or future-dated/,
    atUpperBoundPattern: /gwangju-transportation-cyberstation-timetable evidence is stale or future-dated/,
    topologyBinding: { sourceId: GWANGJU_TOPOLOGY_SOURCE_ID, evidenceKey: "topologyAdmissionEvidence" },
  },
  {
    labelKo: "노선도",
    slug: "route-map-positions",
    offset: 1,
    sourceId: "gwangju-transportation-route-map-positions",
    evidenceKey: "routeMapAdmissionEvidence",
    lowerBound: {
      sourceId: "gwangju-transportation-route-map-positions",
      evidenceKey: "routeMapAdmissionEvidence",
      field: "capturedAt",
    },
    belowLowerBoundPattern:
      /gwangju-transportation-route-map-positions inventory evidence does not match snapshot/,
    topologyBinding: { sourceId: GWANGJU_TOPOLOGY_SOURCE_ID, evidenceKey: "topologyAdmissionEvidence" },
  },
  {
    labelKo: "편의시설",
    slug: "accessibility",
    offset: 2,
    sourceId: "gwangju-transportation-accessibility",
    evidenceKey: "accessibilityAdmissionEvidence",
    lowerBound: {
      sourceId: "gwangju-transportation-accessibility",
      evidenceKey: "accessibilityAdmissionEvidence",
      field: "capturedAt",
    },
    upperBound: {
      sourceId: "gwangju-transportation-accessibility",
      evidenceKey: "accessibilityAdmissionEvidence",
      field: "freshUntil",
    },
    belowLowerBoundPattern: /gwangju-transportation-accessibility evidence freshness is invalid/,
    atUpperBoundPattern: /gwangju-transportation-accessibility evidence freshness is invalid/,
    topologyBinding: { sourceId: GWANGJU_TOPOLOGY_SOURCE_ID, evidenceKey: "topologyAdmissionEvidence" },
  },
];
// 수도권 노선도 편입은 결속 단위가 편입이 아니라 노선(=소스)이다. 광역·경전철 편입은 노선별 snapshotPath를
// 각 노선 소스의 정본 경로에 결속하고, 서울 편입만 편입 층 snapshotPath 하나를 쓴다. 세 편입 모두 창에
// 상한이 없다(정본에 freshUntil이 없고 materializer도 하한만 검사한다).
const CAPITAL_WIDE_RAIL_LINE_SOURCE_IDS = [
  "kric-gyeongui-jungang-route-map-positions",
  "kric-gyeongchun-route-map-positions",
  "kric-suin-bundang-route-map-positions",
  "kric-gyeonggang-route-map-positions",
  "kric-airport-railroad-route-map-positions",
  "kric-uijeongbu-route-map-positions",
  "kric-seohae-route-map-positions",
  "kric-gtx-a-route-map-positions",
];
const CAPITAL_LIGHT_RAIL_LINE_SOURCE_IDS = [
  "kric-shinbundang-route-map-positions",
  "kric-everline-route-map-positions",
  "kric-ui-sinseol-route-map-positions",
  "kric-sillim-route-map-positions",
  "kric-gimpo-goldline-route-map-positions",
];
const CAPITAL_SEOUL_ROUTE_MAP_SOURCE_ID = "seoul-metro-route-map-positions";
const CAPITAL_INCLUSION_BINDINGS = [
  {
    labelKo: "광역철도",
    slug: "wide-rail",
    offset: 0,
    lineSourceIds: CAPITAL_WIDE_RAIL_LINE_SOURCE_IDS,
    reorderedTables: ["lines", "operators"],
    belowLowerBoundPattern:
      /kric-gyeongui-jungang-route-map-positions inventory evidence does not match snapshot/,
  },
  {
    labelKo: "경전철",
    slug: "light-rail",
    offset: 1,
    lineSourceIds: CAPITAL_LIGHT_RAIL_LINE_SOURCE_IDS,
    reorderedTables: ["coverageLineOperatorScopes", "lines", "operators"],
    // 하한 위반은 편입이 체인하는 첫 노선 소스에서 걸린다 — 카탈로그 순서상 신분당선이 첫 노선이다.
    belowLowerBoundPattern: /kric-shinbundang-route-map-positions inventory evidence does not match snapshot/,
  },
  {
    labelKo: "서울 1~8호선",
    slug: "seoul",
    offset: 2,
    sourceId: CAPITAL_SEOUL_ROUTE_MAP_SOURCE_ID,
    evidenceKey: "routeMapAdmissionEvidence",
    reorderedTables: ["lines"],
    belowLowerBoundPattern: /seoul-metro-route-map-positions inventory evidence does not match snapshot/,
  },
  // 9호선 두 소스는 노선 층 경로 키를 쓰지 않는다 — 한 편입이 소스 하나만 싣기 때문이다. 대신 편입 층에
  // snapshotPath와 topologySnapshotPath를 함께 두고 둘 다 그 소스의 정본에 결속한다.
  {
    labelKo: "9호선 1단계",
    slug: "seoul9-phase1",
    offset: 3,
    sourceId: "kric-seoul-metro-line9-1-route-map-positions",
    evidenceKey: "routeMapAdmissionEvidence",
    reorderedTables: ["coverageLineOperatorScopes", "lines", "operators"],
    belowLowerBoundPattern:
      /kric-seoul-metro-line9-1-route-map-positions inventory evidence does not match snapshot/,
  },
  {
    labelKo: "9호선 2·3단계",
    slug: "seoul9-phase23",
    offset: 4,
    sourceId: "seoul-metro-line9-23-route-map-positions",
    evidenceKey: "routeMapAdmissionEvidence",
    // 이 편입은 운영기관·노선·scope를 하나도 더하지 않아(1단계 편입이 이미 만들었고 FILE 계보 표기는
    // scope로 내지 않는다) 어느 표도 재정렬하지 않는다 — 선언 키 자체가 없어야 한다.
    reorderedTables: undefined,
    belowLowerBoundPattern:
      /seoul-metro-line9-23-route-map-positions inventory evidence does not match snapshot/,
  },
];
// 인천 편입 3종의 결속 지점·신선도 창 축. 세 편입 모두 [capturedAt, freshUntil) 양끝을 검사하는 창을
// 갖는데(창 길이 24시간까지 함께 검사한다) 하한·상한이 편입마다 다른 소스에서 온다. 역사정보 편입만
// topologySnapshotPath가 없다 — 그 편입 자신이 topology snapshot을 snapshotPath로 읽기 때문이다.
const INCHEON_STATION_INFO_SOURCE_ID = "incheon-transit-station-info";
const INCHEON_INCLUSION_BINDINGS = [
  {
    labelKo: "역사정보",
    slug: "station-info",
    offset: 0,
    sourceId: INCHEON_STATION_INFO_SOURCE_ID,
    evidenceKey: "topologyAdmissionEvidence",
    windowSourceId: INCHEON_STATION_INFO_SOURCE_ID,
    windowEvidenceKey: "topologyAdmissionEvidence",
    outsideWindowPattern: /incheon-transit-station-info inventory evidence does not match snapshot/,
  },
  {
    labelKo: "시각표",
    slug: "timetable",
    offset: 1,
    // 시각표 편입의 편입 층 경로 키는 topologySnapshotPath 하나이고 snapshotPath는 노선 층에 있다.
    lineSourceIds: ["incheon-line1-train-timetable", "incheon-line2-train-timetable"],
    windowSourceId: "incheon-line1-train-timetable",
    windowEvidenceKey: "scheduleAdmissionEvidence",
    outsideWindowPattern: /incheon-line1-train-timetable evidence freshness is invalid/,
  },
  {
    labelKo: "편의시설",
    slug: "accessibility",
    offset: 2,
    sourceId: "incheon-transit-accessibility",
    evidenceKey: "accessibilityAdmissionEvidence",
    windowSourceId: "incheon-transit-accessibility",
    windowEvidenceKey: "accessibilityAdmissionEvidence",
    outsideWindowPattern: /incheon-transit-accessibility evidence freshness is invalid/,
  },
];
// 이 spec이 전이 대상으로 등재한 requirement 전량. 4호선(B0 파일럿 키)은 수도권 노선도 편입으로 근거
// 소스가 둘이 되지만 키 자체는 이미 등재돼 있어 여기서 한 번만 센다.
const ALL_TRANSITIONING_KEYS = [
  PILOT_REQUIREMENT_KEY,
  ...DAEGU_REQUIREMENT_KEYS,
  ...BUSAN_REQUIREMENT_KEYS,
  ...DAEJEON_REQUIREMENT_KEYS,
  ...GWANGJU_REQUIREMENT_KEYS,
  ...CAPITAL_ROUTE_MAP_REQUIREMENT_KEYS,
  ...CAPITAL_DUAL_OPERATOR_REQUIREMENT_KEYS,
  ...INCHEON_REQUIREMENT_KEYS,
];
const admissionEvidenceOf = (inventory, sourceId, evidenceKey) =>
  inventory.sources.find(({ id }) => id === sourceId)[evidenceKey];

const INPUT_PATHS = {
  spec: SPEC_PATH,
  targets: TARGETS_PATH,
  inventory: INVENTORY_PATH,
  resolutionPlan: RESOLUTION_PLAN_PATH,
  resolutions: RESOLUTIONS_PATH,
  // 승계 원본도 해시 축이다. 경로만 기록하면 원본의 값 drift가 evidence를 바이트 동일하게 통과한다.
  inheritedPack: REVIEWED_PACK_PATH,
};
// 임시 RSA 키·런타임 SQLite에 좌우되는 축은 evidence 어느 노드에도 key로 존재하면 안 된다.
const FORBIDDEN_EVIDENCE_KEYS = ["manifestSha256", "sqliteSha256", "signature"];

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function sha256Of(relativePath) {
  return createHash("sha256").update(await readFile(path.join(root, relativePath))).digest("hex");
}

// 문자열 substring 탐침은 서술 문자열의 인접 문자에 좌우된다 — 전 노드를 순회해 금지 key 부재를 본다.
function forbiddenKeyPaths(node, nodePath = "$") {
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) => forbiddenKeyPaths(entry, `${nodePath}[${index}]`));
  }
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => [
    ...(FORBIDDEN_EVIDENCE_KEYS.includes(key) ? [`${nodePath}.${key}`] : []),
    ...forbiddenKeyPaths(value, `${nodePath}.${key}`),
  ]);
}

test("커밋된 candidate 게이트 evidence는 현행 입력에서 바이트 단위로 재생성된다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-"));
  try {
    const output = path.join(workspace, "evidence.json");
    await execFileAsync(process.execPath, [
      path.join(root, TOOL_PATH),
      "--spec", SPEC_PATH,
      "--targets", TARGETS_PATH,
      "--inventory", INVENTORY_PATH,
      "--resolution-plan", RESOLUTION_PLAN_PATH,
      "--resolutions", RESOLUTIONS_PATH,
      "--output", output,
    ], { cwd: root });

    const regenerated = await readFile(output, "utf8");
    const tracked = await readFile(path.join(root, EVIDENCE_PATH), "utf8");
    assert.equal(regenerated, tracked, "evidence는 재생성 결과와 바이트 단위로 같아야 한다");

    const evidence = JSON.parse(tracked);
    assert.equal(evidence.artifactKind, "nationwide-candidate-coverage-gate-evidence");
    assert.equal(evidence.issue, 2595);
    assert.deepEqual(evidence.parentIssues, [2510, 2138]);
    assert.equal(evidence.regeneration.evidencePath, EVIDENCE_PATH);
    assert.equal(
      evidence.regeneration.command,
      `node ${TOOL_PATH} --spec ${SPEC_PATH} --targets ${TARGETS_PATH} --inventory ${INVENTORY_PATH}`
        + ` --resolution-plan ${RESOLUTION_PLAN_PATH} --resolutions ${RESOLUTIONS_PATH}`
        + ` --output ${EVIDENCE_PATH}`,
    );

    // 기록된 입력 해시는 tracked 입력 파일의 실제 해시여야 한다(입력 drift 감지축).
    for (const [name, relativePath] of Object.entries(INPUT_PATHS)) {
      assert.equal(evidence.inputs[name].path, relativePath);
      assert.equal(evidence.inputs[name].sha256, await sha256Of(relativePath));
    }
    // 지역 편입 입력도 같은 축이다. 저장소에 편입 행을 복제하지 않으므로 이 해시가 candidate 구성의
    // 유일한 결속이며, snapshot 한 바이트가 바뀌면 evidence 재생성이 강제돼야 한다.
    // 체인 순서도 기록 축이다. 다만 조립이 강제하는 순서는 선행 조건이 있는 쌍뿐이고
    // route_map↔accessibility 교환은 조립을 그대로 통과한다(실측) — 기록된 전체 순서를 고정하는 축은
    // 조립 fail closed가 아니라 이 evidence 대조다.
    assert.deepEqual(
      evidence.packDataInclusions.entries.map(({ regionId, materializer }) => ({ regionId, materializer })),
      INCLUSION_CHAIN,
    );
    for (const inclusion of evidence.packDataInclusions.entries) {
      assert.ok(inclusion.inputs.length > 0);
      for (const input of inclusion.inputs) {
        assert.equal(input.sha256, await sha256Of(input.path));
      }
    }

    // 임시 RSA 키·SQLite 바이트·wall-clock 의존 집계는 기록 축이 아니다(결정성 계약).
    assert.equal(evidence.harness.signing.mode, "EPHEMERAL_RSA_2048");
    assert.equal(evidence.determinism.packPayloadIdenticalAcrossVariants, true);
    assert.deepEqual(forbiddenKeyPaths(evidence), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("파일럿 scope는 line-scope 재기술로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);

  // candidate는 root가 되는 단일 pack이어야 게이트가 단독 계약으로 판정한다.
  assert.equal(evidence.candidatePack.id, "nationwide-candidate");
  assert.equal(evidence.candidatePack.artifactKind, "production");
  assert.equal(evidence.candidatePack.inheritsFrom.path, REVIEWED_PACK_PATH);

  // 전이는 절대 수치가 아니라 상대 비교로 본다. 승계 팩의 다른 소스가 line-scope를 갖게 되면
  // 두 variant의 supported 총량이 함께 늘 수 있고, 그때도 아래 두 축은 그대로 성립해야 한다.
  const transitioningKeys = ALL_TRANSITIONING_KEYS;
  const baselineKeys = evidence.variants.baseline.supportedRequirementKeys;
  for (const key of transitioningKeys) {
    assert.equal(baselineKeys.includes(key), false, `${key}는 재기술 전 SUPPORTED가 아니어야 한다`);
  }
  assert.deepEqual(
    evidence.variants.lineScoped.supportedRequirementKeys,
    [...new Set([...baselineKeys, ...transitioningKeys])].sort(),
  );
  assert.equal(
    evidence.variants.lineScoped.launchRequired.supportedCount,
    evidence.variants.baseline.launchRequired.supportedCount + transitioningKeys.length,
  );
  assert.equal(evidence.variants.lineScoped.launchRequired.totalCount, 270);

  // pilotRequirements는 codepoint 순이므로 첫 항목이 어느 지역인지는 등재 범위가 늘 때마다 바뀐다 —
  // 위치가 아니라 키로 찾는다(#2587에서 busan 키가 capital 앞에 오면서 위치 가정이 깨졌다).
  const requirementNamed = (variant, key) =>
    evidence.variants[variant].pilotRequirements.find((entry) => entry.requirementKey === key);
  const before = requirementNamed("baseline", PILOT_REQUIREMENT_KEY);
  const after = requirementNamed("lineScoped", PILOT_REQUIREMENT_KEY);
  assert.equal(before.requirementKey, PILOT_REQUIREMENT_KEY);
  assert.equal(before.status, "MISSING");
  assert.deepEqual(before.missingFields, ["route_map_position", "route_map_label_polygon"]);
  assert.equal(after.status, "SUPPORTED");
  assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
  assert.equal(after.coveredFields, 2);
  assert.equal(after.denominator, 2);
  // #2595부터 4호선은 근거 소스가 둘이다 — B0 파일럿의 cyberstation 좌표 2행에 공식 좌표 snapshot이 더해진다.
  assert.deepEqual(after.sourceIds, [CAPITAL_SEOUL_ROUTE_MAP_SOURCE_ID, PILOT_SOURCE_ID]);
  assert.deepEqual(after.missingFields, []);
  // denominator 2는 필수 필드 2개를 뜻하고 데이터 행 2개가 아니다 — 뒷받침 행수를 따로 고정한다.
  // 27행은 cyberstation 2행 + 공식 좌표 편입 25행이며, 필드 수(2)와도 노선의 역 수와도 다른 축이다.
  assert.deepEqual(after.supportingRecordCountByField, {
    route_map_position: 27,
    route_map_label_polygon: 27,
  });
  assert.deepEqual(before.supportingRecordCountByField, {
    route_map_position: 0,
    route_map_label_polygon: 0,
  });
  assert.match(evidence.readingGuide.denominatorSemanticsKo, /데이터 행 수가 아니다/);

  assert.deepEqual(evidence.transitions.find((entry) => entry.requirementKey === PILOT_REQUIREMENT_KEY), {
    requirementKey: PILOT_REQUIREMENT_KEY,
    before: "MISSING",
    after: "SUPPORTED",
    sourceIds: [CAPITAL_SEOUL_ROUTE_MAP_SOURCE_ID, PILOT_SOURCE_ID],
    coveredFields: 2,
    denominator: 2,
  });
  assert.deepEqual(
    evidence.transitions.map(({ requirementKey }) => requirementKey),
    [...transitioningKeys].sort(),
  );
});

// #2549 B1: 대구 3노선 × membership/topology/timetable 9 requirement가 한 실행에서 함께 전이한다.
test("대구 9 requirement는 candidate 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );
  // 도메인별 필수 필드 3개가 전부 covered여야 SUPPORTED다 — 부분 충족이 통과하지 않는지 필드 단위로 본다.
  const expectedFields = {
    station_line_membership: ["line", "station_name", "station_code"],
    route_graph_topology: ["network_edges", "duration_seconds", "distance_meters"],
    schedule_timetable: ["service_calendar", "trip", "stop_time"],
  };

  assert.equal(DAEGU_B1_REQUIREMENT_KEYS.length, 9);
  for (const requirementKey of DAEGU_B1_REQUIREMENT_KEYS) {
    const [, , , sourceDomain] = requirementKey.split(":");
    const before = baselineByKey.get(requirementKey);
    const after = byKey.get(requirementKey);
    assert.equal(before.status, "MISSING", `${requirementKey} baseline`);
    assert.deepEqual(before.sourceIds, [], `${requirementKey} baseline sourceIds`);
    assert.deepEqual(before.missingFields, expectedFields[sourceDomain], `${requirementKey} baseline missingFields`);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
    assert.equal(after.denominator, 3);
    assert.equal(after.coveredFields, 3);
    assert.deepEqual(after.missingFields, []);
    assert.deepEqual(after.fieldCoverage.map(({ field }) => field), expectedFields[sourceDomain]);
    // 뒷받침 provenance 행이 0인데 covered로 잡히는 판정은 없어야 한다.
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }

  // membership은 molit 소속 소스와 topology 소스가 함께 뒷받침해야 필수 필드 3개가 채워진다.
  const membership = byKey.get(`daegu:daegu-transportation:${DAEGU_LINE_IDS[0]}:station_line_membership`);
  assert.deepEqual(membership.sourceIds, [
    "daegu-line1-route-topology",
    "molit-urban-rail-full-route-daegu-line1-membership",
  ]);
});

// #2580 B2-a: 같은 지역의 route_map_positions·accessibility_facilities 6 requirement가 B1 편입 뒤에
// 체인으로 실린 행으로 전이한다. 두 도메인의 필수 필드 수가 다르므로 분모도 도메인별로 못박는다.
test("대구 route_map/accessibility 6 requirement는 체인 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );
  const expected = {
    route_map_positions: {
      fields: ["route_map_position", "route_map_label_polygon"],
      sourceIds: ["daegu-transportation-route-map-positions"],
    },
    accessibility_facilities: {
      fields: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
      sourceIds: ["daegu-transportation-accessibility"],
    },
  };

  assert.equal(DAEGU_B2A_REQUIREMENT_KEYS.length, 6);
  for (const requirementKey of DAEGU_B2A_REQUIREMENT_KEYS) {
    const [, , , sourceDomain] = requirementKey.split(":");
    const { fields, sourceIds } = expected[sourceDomain];
    const before = baselineByKey.get(requirementKey);
    const after = byKey.get(requirementKey);
    assert.equal(before.status, "MISSING", `${requirementKey} baseline`);
    assert.deepEqual(before.sourceIds, [], `${requirementKey} baseline sourceIds`);
    assert.deepEqual(before.missingFields, fields, `${requirementKey} baseline missingFields`);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
    assert.equal(after.denominator, fields.length);
    assert.equal(after.coveredFields, fields.length);
    assert.deepEqual(after.missingFields, []);
    assert.deepEqual(after.fieldCoverage.map(({ field }) => field), fields);
    assert.deepEqual(after.sourceIds, sourceIds, `${requirementKey} sourceIds`);
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }

  // 체인 편입이 실제로 실은 행수. 두 표 모두 축이 역이 아니라 역·노선 쌍인데 쌍의 수도 표마다 갈리므로
  // 표별로 못박는다 — 노선도 좌표는 91 역·노선 쌍(고유 역 88: 명덕·반월당·청라언덕 환승 3역이 2쌍씩),
  // 편의시설은 94 역·노선 쌍(고유 역 91) × 3종 = 282행이다. 노선도가 3쌍 적은 것은 대구한의대병원·부호·
  // 하양이 노선도 정본에 좌표가 없기 때문이다(snapshot topologyGaps 3건). 각 편입은 소스 등재 1건씩만
  // 더한다(승계 행과 앞선 편입 행은 그대로여야 한다).
  const [, routeMap, accessibility] = evidence.packDataInclusions.entries;
  assert.equal(routeMap.addedRows.routeMapPositions, 91);
  assert.equal(routeMap.addedRows.sourceInventory, 1);
  assert.equal(routeMap.addedRows.transitStopTimes, 0);
  assert.equal(accessibility.addedRows.facilities, 282);
  assert.equal(accessibility.addedRows.stationFacilityEvidence, 282);
  assert.equal(accessibility.addedRows.sourceInventory, 1);
  assert.equal(accessibility.addedRows.routeMapPositions, 0);
  // pin 상호 상이성은 불변식이 아니다 — 노선도 창과 편의시설 창은 겹쳐서 두 편입이 같은 pin을 써도
  // 조립은 통과한다(실측). 대신 각 pin이 그 소스의 admission 창 안인지를 직접 본다. 창의 모양은
  // 소스마다 다르다.
  const inventory = await readJson(INVENTORY_PATH);
  const admissionEvidence = (sourceId, evidenceKey) => admissionEvidenceOf(inventory, sourceId, evidenceKey);
  const pins = new Map(evidence.packDataInclusions.entries.map(
    ({ materializer, materializedAt }) => [materializer, Date.parse(materializedAt)],
  ));

  // 시각표 편입: 3노선의 topology·시각표 admission 창 [capturedAt, freshUntil)을 모두 만족해야 한다.
  for (const lineNumber of [1, 2, 3]) {
    for (const [sourceId, evidenceKey] of [
      [`daegu-line${lineNumber}-route-topology`, "topologyAdmissionEvidence"],
      [`daegu-line${lineNumber}-train-timetable`, "scheduleAdmissionEvidence"],
    ]) {
      const { capturedAt, freshUntil } = admissionEvidence(sourceId, evidenceKey);
      const pin = pins.get(DAEGU_MATERIALIZERS[0]);
      assert.ok(pin >= Date.parse(capturedAt) && pin < Date.parse(freshUntil), `${sourceId} 창`);
    }
  }
  // 노선도 편입: 신선도 보장이 다른 두 편입과 비대칭이다 — admission 정본에 freshUntil이 없고
  // materializer도 하한(capturedAt 이후)만 검사해 상한이 없다(먼 미래 pin도 통과함이 실측된다).
  // 상한 도입 여부는 materializer 쪽 판단이라 이 하네스의 축이 아니며, 여기서는 그 비대칭을 기록한다.
  const routeMapEvidence = admissionEvidence(
    "daegu-transportation-route-map-positions",
    "routeMapAdmissionEvidence",
  );
  assert.equal(routeMapEvidence.freshUntil, undefined, "노선도 admission 정본에는 상한이 없다");
  assert.ok(pins.get(DAEGU_MATERIALIZERS[1]) >= Date.parse(routeMapEvidence.capturedAt), "노선도 창 하한");
  // 편의시설 편입: [capturedAt, freshUntil) 양끝을 검사한다.
  const accessibilityEvidence = admissionEvidence(
    "daegu-transportation-accessibility",
    "accessibilityAdmissionEvidence",
  );
  const accessibilityPin = pins.get(DAEGU_MATERIALIZERS[2]);
  assert.ok(
    accessibilityPin >= Date.parse(accessibilityEvidence.capturedAt)
      && accessibilityPin < Date.parse(accessibilityEvidence.freshUntil),
    "편의시설 창",
  );
});

// #2587 B2-b: 부산 4노선 × 5도메인 20 requirement가 같은 실행에서 전이한다. 대구와 달리 승계 원본에
// 지역 자체가 없어 topology 편입이 운영기관·노선·역까지 함께 싣는다.
test("부산 20 requirement는 체인 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );
  // membership은 대구와 달리 소스 하나가 필수 필드 3개를 전부 댄다(대구는 molit 소속 소스와 topology
  // 소스의 합산이었다) — 재기술도 소스 하나로 등재되고 뒷받침 소스 목록도 하나여야 한다.
  const expected = {
    station_line_membership: {
      fields: ["line", "station_name", "station_code"],
      sourceIds: ["busan-transportation-route-topology"],
    },
    route_graph_topology: {
      fields: ["network_edges", "duration_seconds", "distance_meters"],
      sourceIds: ["busan-transportation-route-topology"],
    },
    schedule_timetable: {
      fields: ["service_calendar", "trip", "stop_time"],
      sourceIds: ["busan-transportation-timetable"],
    },
    route_map_positions: {
      fields: ["route_map_position", "route_map_label_polygon"],
      sourceIds: ["busan-transportation-route-map-positions"],
    },
    accessibility_facilities: {
      fields: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
      sourceIds: ["busan-transportation-accessibility"],
    },
  };

  assert.equal(BUSAN_REQUIREMENT_KEYS.length, 20);
  for (const requirementKey of BUSAN_REQUIREMENT_KEYS) {
    const [, , , sourceDomain] = requirementKey.split(":");
    const { fields, sourceIds } = expected[sourceDomain];
    const before = baselineByKey.get(requirementKey);
    const after = byKey.get(requirementKey);
    assert.equal(before.status, "MISSING", `${requirementKey} baseline`);
    assert.deepEqual(before.sourceIds, [], `${requirementKey} baseline sourceIds`);
    assert.deepEqual(before.missingFields, fields, `${requirementKey} baseline missingFields`);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
    assert.equal(after.denominator, fields.length);
    assert.equal(after.coveredFields, fields.length);
    assert.deepEqual(after.missingFields, []);
    assert.deepEqual(after.fieldCoverage.map(({ field }) => field), fields);
    assert.deepEqual(after.sourceIds, sourceIds, `${requirementKey} sourceIds`);
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }

  // 체인 편입이 실제로 실은 행수. topology는 지역 자체를 세우므로 운영기관 1·노선 4·역 108(정본 station
  // id 기준 고유 역 수라 station_lines 114와 다르다)·구간 220을 함께 싣는다.
  const [topology, timetable, routeMap, accessibility] = evidence.packDataInclusions.entries
    .slice(BUSAN_TOPOLOGY_INDEX);
  assert.equal(topology.addedRows.operators, 1);
  assert.equal(topology.addedRows.lines, 4);
  assert.equal(topology.addedRows.stations, 108);
  assert.equal(topology.addedRows.stationLines, 114);
  assert.equal(topology.addedRows.networkEdges, 220);
  assert.equal(topology.addedRows.sourceInventory, 1);
  assert.equal(topology.addedRows.transitStopTimes, 0);
  assert.equal(timetable.addedRows.serviceCalendars, 3);
  assert.equal(timetable.addedRows.transitRoutes, 8);
  assert.equal(timetable.addedRows.transitTrips, 3_833);
  assert.equal(timetable.addedRows.transitStopTimes, 109_140);
  assert.equal(timetable.addedRows.operators, 0);
  assert.equal(routeMap.addedRows.routeMapPositions, 114);
  // 이 편입은 승계 원본에 없던 표를 새로 만든다 — 집계 목록을 pack 자신에서 끌어오므로 새 표도 선언
  // 대상이며, 뒤 편입은 그 표를 0으로 선언해야 대조를 통과한다.
  assert.equal(routeMap.addedRows.routeMapLineTracks, 4);
  assert.equal(accessibility.addedRows.routeMapLineTracks, 0);
  // 114 역·노선 쌍 × 3종(엘리베이터·에스컬레이터·휠체어리프트). 축은 역이 아니라 역·노선 쌍이라 고유 역
  // 108과 갈린다 — 두 노선에 걸친 환승역 6곳은 6행씩 낸다. 미설치도 NOT_EXISTS 근거로 함께 실린다.
  assert.equal(accessibility.addedRows.facilities, 342);
  assert.equal(accessibility.addedRows.stationFacilityEvidence, 342);
  assert.equal(accessibility.addedRows.routeMapPositions, 0);

  // pin은 편입마다 따로 두고 각각 그 소스의 admission 창 안이어야 한다. 부산 4소스의 창은 모양이 갈린다 —
  // topology·시각표·편의시설은 [capturedAt, freshUntil) 양끝을 검사하고 노선도는 상한이 없다.
  // 소스 id·evidence 키는 BUSAN_INCLUSION_BINDINGS가 정본이다 — 여기서 다시 인라인으로 쓰면 정본이
  // 갱신돼도 이 블록만 낡은 짝을 보게 된다.
  const inventory = await readJson(INVENTORY_PATH);
  const bindingEvidence = ({ sourceId, evidenceKey }) => admissionEvidenceOf(inventory, sourceId, evidenceKey);
  const boundedWindows = [
    [topology, BUSAN_TOPOLOGY_BINDING],
    [timetable, BUSAN_TIMETABLE_BINDING],
    [accessibility, BUSAN_ACCESSIBILITY_BINDING],
  ];
  for (const [inclusion, binding] of boundedWindows) {
    const { capturedAt, freshUntil } = bindingEvidence(binding);
    const pin = Date.parse(inclusion.materializedAt);
    assert.ok(pin >= Date.parse(capturedAt) && pin < Date.parse(freshUntil), `${binding.sourceId} 창`);
  }
  const routeMapEvidence = bindingEvidence(BUSAN_ROUTE_MAP_BINDING);
  assert.equal(routeMapEvidence.freshUntil, undefined, "부산 노선도 admission 정본에도 상한이 없다");
  assert.ok(Date.parse(routeMap.materializedAt) >= Date.parse(routeMapEvidence.capturedAt), "노선도 창 하한");
  // 편의시설 창은 상한이 있는 두 창(topology·시각표)과 서로소다 — 그 셋은 pin 하나로 묶는 것이 애초에
  // 불가능하다. 다만 "부산 네 창이 전부 서로소"는 아니다: 노선도 창은 상한이 없어 [capturedAt, ∞)이고
  // 편의시설 창을 통째로 품는다(실측: 노선도 pin을 편의시설 capturedAt으로 옮기면 조립이 통과하고
  // 시각표 capturedAt으로 옮기면 거부된다). 그 포함 관계까지 함께 고정한다.
  const accessibilityWindow = bindingEvidence(BUSAN_ACCESSIBILITY_BINDING);
  for (const binding of [BUSAN_TOPOLOGY_BINDING, BUSAN_TIMETABLE_BINDING]) {
    assert.ok(
      Date.parse(bindingEvidence(binding).freshUntil) <= Date.parse(accessibilityWindow.capturedAt),
      `${binding.sourceId} 창은 편의시설 창보다 앞에서 닫혀 겹치지 않는다`,
    );
  }
  assert.ok(
    Date.parse(routeMapEvidence.capturedAt) <= Date.parse(accessibilityWindow.capturedAt),
    "상한 없는 노선도 창은 편의시설 창을 통째로 품는다",
  );
});

// #2595 B3: 대전·광주는 1노선 × 5도메인이지만 편입은 3건이다 — topology 전용 materializer가 편입 단위가
// 아니고 시각표 편입 하나가 topology·membership·시각표를 함께 싣는다. 그래서 "편입 수 = 도메인 수"가
// 성립하지 않고, membership 근거 소스도 지역마다 갈린다(대전·광주는 합산, 부산은 단일).
const SINGLE_LINE_DOMAIN_FIELDS = {
  station_line_membership: ["line", "station_name", "station_code"],
  route_graph_topology: ["network_edges", "duration_seconds", "distance_meters"],
  schedule_timetable: ["service_calendar", "trip", "stop_time"],
  route_map_positions: ["route_map_position", "route_map_label_polygon"],
  accessibility_facilities: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
};

async function assertSingleLineRegionTransition({ requirementKeys, sourceIdsByDomain }) {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );
  assert.equal(requirementKeys.length, 5);
  for (const requirementKey of requirementKeys) {
    const [, , , sourceDomain] = requirementKey.split(":");
    const fields = SINGLE_LINE_DOMAIN_FIELDS[sourceDomain];
    const before = baselineByKey.get(requirementKey);
    const after = byKey.get(requirementKey);
    assert.equal(before.status, "MISSING", `${requirementKey} baseline`);
    assert.deepEqual(before.sourceIds, [], `${requirementKey} baseline sourceIds`);
    assert.deepEqual(before.missingFields, fields, `${requirementKey} baseline missingFields`);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.releaseTier, "LAUNCH_REQUIRED");
    assert.equal(after.denominator, fields.length);
    assert.equal(after.coveredFields, fields.length);
    assert.deepEqual(after.missingFields, []);
    assert.deepEqual(after.fieldCoverage.map(({ field }) => field), fields);
    assert.deepEqual(after.sourceIds, sourceIdsByDomain[sourceDomain], `${requirementKey} sourceIds`);
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }
  return evidence;
}

test("대전 5 requirement는 체인 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await assertSingleLineRegionTransition({
    requirementKeys: DAEJEON_REQUIREMENT_KEYS,
    sourceIdsByDomain: {
      // membership 필수 필드 3개는 두 소스의 합산이다 — MOLIT 소속 소스가 line·station_name을,
      // 역간거리·요금 소스가 station_code를 댄다(대구와 같은 구조, 부산과 다른 구조).
      station_line_membership: [
        "daejeon-station-distance-fare",
        "molit-urban-rail-full-route-daejeon-membership",
      ],
      route_graph_topology: ["daejeon-station-distance-fare"],
      schedule_timetable: ["daejeon-train-timetable"],
      route_map_positions: ["daejeon-transportation-route-map-positions"],
      accessibility_facilities: ["daejeon-transportation-accessibility"],
    },
  });

  // 편입이 실제로 실은 행수. 시각표 편입 하나가 소스 3건을 등재하고 운영기관·노선·역·구간까지 함께 싣는다.
  const [timetable, routeMap, accessibility] = evidence.packDataInclusions.entries.slice(DAEJEON_INDEX);
  assert.equal(timetable.addedRows.sourceInventory, 3);
  assert.equal(timetable.addedRows.operators, 1);
  assert.equal(timetable.addedRows.lines, 1);
  // 대전 1호선은 단일 노선이라 고유 역 수와 역·노선 쌍 수가 22로 같다. 구간 42행은 인접 21쌍의 양방향이다.
  assert.equal(timetable.addedRows.stations, 22);
  assert.equal(timetable.addedRows.stationLines, 22);
  assert.equal(timetable.addedRows.networkEdges, 42);
  assert.equal(timetable.addedRows.transitTrips, 460);
  assert.equal(timetable.addedRows.transitStopTimes, 10_034);
  // 부산 노선도 편입이 앞서 만든 표는 뒤 편입이 전부 0으로 선언해야 대조를 통과한다.
  assert.equal(timetable.addedRows.routeMapLineTracks, 0);
  assert.equal(routeMap.addedRows.routeMapPositions, 22);
  assert.equal(routeMap.addedRows.sourceInventory, 1);
  assert.equal(routeMap.addedRows.transitStopTimes, 0);
  // 22 역·노선 쌍 × 3종 = 66행. 단일 노선이라 역 수와 쌍 수가 같아 두 축이 갈리지 않는다.
  assert.equal(accessibility.addedRows.facilities, 66);
  assert.equal(accessibility.addedRows.stationFacilityEvidence, 66);
  assert.equal(accessibility.addedRows.routeMapPositions, 0);

  // pin은 편입마다 따로 두고 각각 그 소스의 창 안이어야 한다. 대전 세 창은 서로소인데, 그 서로소가
  // 성립하는 이유가 광주와 다르므로(상한 없는 노선도 창의 하한이 편의시설 창 상한보다 늦다) 그 부등식을
  // 직접 고정한다 — spec 서술이 실측과 갈리면 여기서 깨진다.
  const inventory = await readJson(INVENTORY_PATH);
  assertPinsInsideWindows(inventory, evidence, DAEJEON_INDEX, DAEJEON_INCLUSION_BINDINGS);
  const daejeonRouteMap = admissionEvidenceOf(
    inventory,
    "daejeon-transportation-route-map-positions",
    "routeMapAdmissionEvidence",
  );
  const daejeonAccessibility = admissionEvidenceOf(
    inventory,
    "daejeon-transportation-accessibility",
    "accessibilityAdmissionEvidence",
  );
  assert.equal(daejeonRouteMap.freshUntil, undefined, "대전 노선도 정본에는 상한이 없다");
  assert.ok(
    Date.parse(daejeonRouteMap.capturedAt) >= Date.parse(daejeonAccessibility.freshUntil),
    "대전은 상한 없는 노선도 창이 편의시설 창보다 뒤에서 시작해 두 창이 서로소다",
  );
});

// pin이 그 편입의 창 [하한, 상한) 안인지 본다. 이 배치의 시각표 편입은 창 경계가 서로 다른 정본에서
// 오므로 경계 값을 binding 기술대로 끌어온다. 상한이 없는 편입은 하한만 본다.
function assertPinsInsideWindows(inventory, evidence, regionIndex, bindings) {
  for (const binding of bindings) {
    const pin = Date.parse(evidence.packDataInclusions.entries[regionIndex + binding.offset].materializedAt);
    const lower = admissionEvidenceOf(
      inventory,
      binding.lowerBound.sourceId,
      binding.lowerBound.evidenceKey,
    )[binding.lowerBound.field];
    assert.ok(pin >= Date.parse(lower), `${binding.sourceId} 창 하한`);
    if (binding.upperBound === undefined) {
      assert.equal(
        admissionEvidenceOf(inventory, binding.sourceId, binding.evidenceKey).freshUntil,
        undefined,
        `${binding.sourceId} 정본에는 상한이 없다`,
      );
      continue;
    }
    const upper = admissionEvidenceOf(
      inventory,
      binding.upperBound.sourceId,
      binding.upperBound.evidenceKey,
    )[binding.upperBound.field];
    assert.ok(pin < Date.parse(upper), `${binding.sourceId} 창 상한`);
  }
}

test("광주 5 requirement는 체인 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await assertSingleLineRegionTransition({
    requirementKeys: GWANGJU_REQUIREMENT_KEYS,
    sourceIdsByDomain: {
      station_line_membership: [
        "gwangju-transportation-route-topology",
        "molit-urban-rail-full-route-gwangju-membership",
      ],
      route_graph_topology: ["gwangju-transportation-route-topology"],
      schedule_timetable: ["gwangju-transportation-cyberstation-timetable"],
      route_map_positions: ["gwangju-transportation-route-map-positions"],
      accessibility_facilities: ["gwangju-transportation-accessibility"],
    },
  });

  const [timetable, routeMap, accessibility] = evidence.packDataInclusions.entries.slice(GWANGJU_INDEX);
  assert.equal(timetable.addedRows.sourceInventory, 3);
  assert.equal(timetable.addedRows.operators, 1);
  assert.equal(timetable.addedRows.lines, 1);
  assert.equal(timetable.addedRows.stations, 20);
  assert.equal(timetable.addedRows.stationLines, 20);
  assert.equal(timetable.addedRows.networkEdges, 38);
  assert.equal(timetable.addedRows.transitTrips, 810);
  assert.equal(timetable.addedRows.transitStopTimes, 14_171);
  assert.equal(timetable.addedRows.routeMapLineTracks, 0);
  assert.equal(routeMap.addedRows.routeMapPositions, 20);
  assert.equal(accessibility.addedRows.facilities, 60);
  assert.equal(accessibility.addedRows.stationFacilityEvidence, 60);

  // 실린 stop_time 14,171행과 판정을 뒷받침한 stop_time 13,360행은 다른 축이다 — 811행은 종착 도착 시각을
  // 구간 소요로 채운 GENERATED라 official provenance 집계에 들어가지 않는다. 두 수를 뒤섞어 읽지 않도록
  // 여기서 함께 못박는다.
  const schedule = evidence.variants.lineScoped.pilotRequirements.find(
    ({ requirementKey }) => requirementKey.endsWith(":schedule_timetable")
      && requirementKey.startsWith("gwangju:"),
  );
  assert.equal(schedule.supportingRecordCountByField.stop_time, 13_360);
  assert.equal(timetable.addedRows.transitStopTimes - schedule.supportingRecordCountByField.stop_time, 811);

  // 광주 세 창의 관계는 대전과 다르다 — 상한 없는 노선도 창의 하한이 편의시설 창 상한보다 이르러 두 창이
  // 한 시간을 공유한다. "상한이 없으면 늘 다른 창을 품는다"도 "지역 안 창은 늘 서로소다"도 아니라는 뜻이라
  // 실측 부등식을 그대로 고정한다.
  const inventory = await readJson(INVENTORY_PATH);
  assertPinsInsideWindows(inventory, evidence, GWANGJU_INDEX, GWANGJU_INCLUSION_BINDINGS);
  const gwangjuRouteMap = admissionEvidenceOf(
    inventory,
    "gwangju-transportation-route-map-positions",
    "routeMapAdmissionEvidence",
  );
  const gwangjuAccessibility = admissionEvidenceOf(
    inventory,
    "gwangju-transportation-accessibility",
    "accessibilityAdmissionEvidence",
  );
  assert.equal(gwangjuRouteMap.freshUntil, undefined, "광주 노선도 정본에도 상한이 없다");
  assert.ok(
    Date.parse(gwangjuRouteMap.capturedAt) < Date.parse(gwangjuAccessibility.freshUntil)
      && Date.parse(gwangjuRouteMap.capturedAt) >= Date.parse(gwangjuAccessibility.capturedAt),
    "광주는 상한 없는 노선도 창이 편의시설 창 안에서 시작해 두 창이 겹친다",
  );
  // 시각표 편입 창은 두 창 모두와 서로소다(상한이 편의시설 창 하한보다 앞에서 닫힌다).
  const gwangjuScheduleUpper = admissionEvidenceOf(
    inventory,
    "gwangju-transportation-cyberstation-timetable",
    "scheduleAdmissionEvidence",
  ).freshUntil;
  assert.ok(
    Date.parse(gwangjuScheduleUpper) <= Date.parse(gwangjuAccessibility.capturedAt),
    "광주 시각표 편입 창은 편의시설 창보다 앞에서 닫혀 겹치지 않는다",
  );
});

// #2595 B3: 수도권 노선도는 한 도메인에 소스 11건이 붙는다. 이 17건을 여는 편입은 materializer 단위로
// 3건이며(광역철도 6소스 체인 / 경전철 4소스 체인 / 서울 1소스), 수도권 노선도 편입 전체는 9호선 두 건을
// 더해 5건이다. 앞의 두 편입은 승계 pack에 의존하지 않고 서울 1~8호선 편입만 승계 원본의 운영기관·
// cyberstation 소스 등재와 좌표 PK 집합에 의존한다(그 셋은 승계 원본이 이미 갖고 있다).
test("수도권 노선도 17 requirement는 편입 3건으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );
  const fields = SINGLE_LINE_DOMAIN_FIELDS.route_map_positions;

  assert.equal(CAPITAL_ROUTE_MAP_REQUIREMENT_KEYS.length, 17);
  for (const requirementKey of CAPITAL_ROUTE_MAP_REQUIREMENT_KEYS) {
    const before = baselineByKey.get(requirementKey);
    const after = byKey.get(requirementKey);
    assert.equal(before.status, "MISSING", `${requirementKey} baseline`);
    assert.deepEqual(before.missingFields, fields, `${requirementKey} baseline missingFields`);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.denominator, 2);
    assert.equal(after.coveredFields, 2);
    assert.equal(after.sourceIds.length, 1, `${requirementKey} sourceIds`);
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }
  // 4호선만 근거 소스가 둘이다 — 이 배치가 여는 17건과 달리 키 자체는 B0 파일럿에서 이미 열려 있었다.
  assert.equal(CAPITAL_ROUTE_MAP_REQUIREMENT_KEYS.includes(PILOT_REQUIREMENT_KEY), false);
  assert.equal(byKey.get(PILOT_REQUIREMENT_KEY).sourceIds.length, 2);

  const [wideRail, lightRail, seoul] = evidence.packDataInclusions.entries.slice(CAPITAL_INDEX);
  // 광역철도 편입은 승계 원본에 없던 표(coverageLineOperatorScopes)를 새로 만든다 — 뒤 편입은 자기 몫만 더한다.
  // 서해선·GTX-A는 두 운영기관 scope를 함께 내므로 광역철도의 scope 행이 노선 수보다 둘 많다. 경전철은
  // 노선당 하나다 — 신분당선 정본도 두 운영기관을 등재하지만 FILE 계보 표기(서울교통공사)는 scope로 내지 않는다.
  assert.equal(wideRail.addedRows.coverageLineOperatorScopes, 10);
  assert.equal(lightRail.addedRows.coverageLineOperatorScopes, 5);
  assert.equal(seoul.addedRows.coverageLineOperatorScopes, 0);
  assert.equal(wideRail.addedRows.sourceInventory, 8);
  assert.equal(lightRail.addedRows.sourceInventory, 5);
  assert.equal(seoul.addedRows.sourceInventory, 1);
  // 역 수와 역·노선 쌍 수는 다른 축이다 — 환승역은 역 하나에 노선 소속을 여러 개 낸다.
  assert.equal(wideRail.addedRows.stations, 192);
  assert.equal(wideRail.addedRows.stationLines, 217);
  assert.equal(wideRail.addedRows.routeMapPositions, 217);
  assert.equal(lightRail.addedRows.stations, 58);
  assert.equal(lightRail.addedRows.stationLines, 63);
  assert.equal(seoul.addedRows.stations, 213);
  assert.equal(seoul.addedRows.stationLines, 273);
  // 서울 편입은 운영기관을 더하지 않고(승계 원본에 이미 있다) 노선은 4호선을 뺀 7개만 더한다.
  assert.equal(seoul.addedRows.operators, 0);
  assert.equal(seoul.addedRows.lines, 7);
  // 승계 자산 보존: capital pilot cyberstation 좌표 2행과 PK가 겹치는 행은 건너뛴다 —
  // 실린 좌표 273행은 이 편입이 만든 역·노선 쌍 수와 같다.
  assert.equal(seoul.addedRows.routeMapPositions, 273);

  // 재정렬 선언은 evidence에도 남는다. 선언하지 않은 편입에는 키 자체가 없어야 한다(죽은 선언 방지).
  for (const { offset, reorderedTables } of CAPITAL_INCLUSION_BINDINGS) {
    assert.deepEqual(evidence.packDataInclusions.entries[CAPITAL_INDEX + offset].reorderedTables, reorderedTables);
  }
  for (const entry of evidence.packDataInclusions.entries.slice(0, CAPITAL_INDEX)) {
    assert.equal("reorderedTables" in entry, false, `${entry.materializer}는 재정렬을 선언하지 않는다`);
  }
});

// #2595 B3 두 번째 배치. 노선 하나를 두 사업자가 나눠 운영하는 소스는 admission 정본이 두 운영기관 scope를
// dual coverage로 등재하는데, materializer 정본 대조가 단일 운영기관만 허용해 그동안 조립이 막혀 있었다.
// 카탈로그가 두 번째 운영기관을 등재하고 materializer가 그 집합 전체를 정본과 대조하도록 바뀌면서 열린다.
test("수도권 dual-operator 노선 6 requirement는 편입으로 MISSING에서 SUPPORTED로 전이한다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );

  assert.equal(CAPITAL_DUAL_OPERATOR_REQUIREMENT_KEYS.length, 6);
  for (const requirementKey of CAPITAL_DUAL_OPERATOR_REQUIREMENT_KEYS) {
    assert.equal(baselineByKey.get(requirementKey).status, "MISSING", `${requirementKey} baseline`);
    const after = byKey.get(requirementKey);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.equal(after.denominator, 2);
    assert.equal(after.coveredFields, 2);
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }
  // 서해선·GTX-A는 두 scope가 모두 activeLineScopes에 있어 소스 하나가 requirement 둘을 연다.
  for (const [lineId, operatorIds] of [
    ["line-051552e50435", ["korail", "operator-38450e138464"]],
    ["line-8604048b6430", ["operator-5ca780d7dee1", "operator-9e999d4aa596"]],
  ]) {
    for (const operatorId of operatorIds) {
      assert.equal(byKey.get(`capital:${operatorId}:${lineId}:route_map_positions`).sourceIds.length, 1);
    }
  }
  // 9호선은 반대 방향이다 — requirement 하나를 1단계·2·3단계 두 소스가 함께 뒷받침한다.
  assert.deepEqual(byKey.get("capital:operator-936e454d0bfb:line-f0e747248a31:route_map_positions").sourceIds, [
    "kric-seoul-metro-line9-1-route-map-positions",
    "seoul-metro-line9-23-route-map-positions",
  ]);
  // 신분당선 정본의 서울교통공사 표기는 activeLineScopes에 대응 scope가 없어 requirement를 만들지 않는다.
  assert.equal(
    evidence.variants.lineScoped.supportedRequirementKeys
      .includes("capital:seoul-metro:shinbundang:route_map_positions"),
    false,
  );

  const [phase1, phase23] = evidence.packDataInclusions.entries.slice(CAPITAL_INDEX + 3);
  assert.equal(phase1.addedRows.routeMapPositions, 25);
  assert.equal(phase1.addedRows.stations, 18);
  assert.equal(phase1.addedRows.stationLines, 25);
  assert.equal(phase1.addedRows.operators, 1);
  assert.equal(phase1.addedRows.lines, 1);
  assert.equal(phase23.addedRows.routeMapPositions, 13);
  assert.equal(phase23.addedRows.stations, 10);
  assert.equal(phase23.addedRows.stationLines, 13);
  // 2·3단계 편입은 1단계가 만든 운영기관·노선·scope를 다시 만들지 않는다. 정본이 dual coverage로 등재한
  // 나머지 표기(서울교통공사)는 activeLineScopes에 대응이 없는 FILE 계보라 scope 행으로도 내지 않는다.
  assert.equal(phase23.addedRows.operators, 0);
  assert.equal(phase23.addedRows.lines, 0);
  assert.equal(phase23.addedRows.coverageLineOperatorScopes, 0);
  assert.equal("reorderedTables" in phase23, false);
});

// #2138 증거 모델 축. 감사자가 evidence만 보고 "어느 건이 어느 근거 성격으로 섰는지" 알 수 있어야 한다.
// 값은 하네스가 지어내지 않고 판정 경로(report-coverage-gaps.mjs)가 requirement마다 실어 준 domain 선언
// 그대로이며, 범주별 합이 SUPPORTED 총계와 같아야 한다.
test("게이트 evidence는 SUPPORTED를 근거 성격별로 나눠 기록하고 합이 총계와 같다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const targets = await readJson(TARGETS_PATH);
  const modelByDomain = new Map(
    targets.requiredSourceDomains.map(({ id, evidenceModel }) => [id, evidenceModel ?? "official-source"]),
  );
  assert.equal(modelByDomain.get("route_map_positions"), "owner-authored-canonical");

  for (const variant of ["baseline", "lineScoped"]) {
    const summary = evidence.variants[variant];
    // 집계는 SUPPORTED 키를 도메인 선언으로 되짚은 것과 정확히 같아야 한다(하네스가 따로 세지 않는다).
    const expected = {};
    for (const key of summary.supportedRequirementKeys) {
      const model = modelByDomain.get(key.split(":")[3]);
      expected[model] = (expected[model] ?? 0) + 1;
    }
    assert.deepEqual(summary.supportedByEvidenceModel, expected, variant);
    assert.equal(
      Object.values(summary.supportedByEvidenceModel).reduce((sum, count) => sum + count, 0),
      summary.supportedRequirementKeys.length,
      variant,
    );
  }
  // 이 배치의 실측 수치를 못박는다 — 범주 비율이 조용히 움직이면 여기서 걸린다.
  assert.deepEqual(evidence.variants.lineScoped.supportedByEvidenceModel, {
    "official-source": 46,
    "owner-authored-canonical": 36,
  });
  assert.deepEqual(evidence.variants.baseline.supportedByEvidenceModel, {});

  // owner-authored-canonical 선언은 판정을 열어 주지 않는다: baseline에서 그 도메인 키는 재기술 전
  // MISSING이고 분모·차단 임계는 lineScoped와 같다(선언이 아니라 근거가 판정을 낸다).
  const routeMapKey = `capital:seoul-metro:${INCHEON_LINE7_ID}:route_map_positions`;
  const requirementNamed = (variant) =>
    evidence.variants[variant].pilotRequirements.find((entry) => entry.requirementKey === routeMapKey);
  assert.equal(requirementNamed("baseline").status, "MISSING");
  assert.equal(requirementNamed("lineScoped").status, "SUPPORTED");
  assert.equal(requirementNamed("baseline").denominator, requirementNamed("lineScoped").denominator);
  assert.equal(
    requirementNamed("baseline").blockingThreshold,
    requirementNamed("lineScoped").blockingThreshold,
  );
});

// #2595 B3 두 번째 배치. 인천은 부산과 같은 모양(역사정보 편입이 지역 자체를 세운다)이지만, 소스가 덮는
// 세 노선 중 7호선의 route_graph_topology 하나만 열리지 않는다 — 그 사실이 선언과 실측으로 함께 남는다.
test("인천 13 requirement는 체인 편입으로 전이하고 7호선 구간만 선언대로 열리지 않는다", async () => {
  const evidence = await readJson(EVIDENCE_PATH);
  const byKey = new Map(evidence.variants.lineScoped.pilotRequirements.map((entry) => [entry.requirementKey, entry]));
  const baselineByKey = new Map(
    evidence.variants.baseline.pilotRequirements.map((entry) => [entry.requirementKey, entry]),
  );

  assert.equal(INCHEON_REQUIREMENT_KEYS.length, 13);
  for (const requirementKey of INCHEON_REQUIREMENT_KEYS) {
    assert.equal(baselineByKey.get(requirementKey).status, "MISSING", `${requirementKey} baseline`);
    const after = byKey.get(requirementKey);
    assert.equal(after.status, "SUPPORTED", `${requirementKey} lineScoped`);
    assert.deepEqual(after.missingFields, [], `${requirementKey} missingFields`);
    assert.ok(
      Object.values(after.supportingRecordCountByField).every((count) => count > 0),
      `${requirementKey} supporting rows`,
    );
  }

  // 선언된 non-transition은 evidence에 그대로 남고, 사유 코드가 요구한 실측 술어도 함께 기록된다.
  // 수치를 따로 못박아 이 축이 조용히 늘면 evidence diff와 이 회귀가 함께 걸리게 한다.
  assert.equal(evidence.declaredNonTransitions.count, 1);
  assert.equal(evidence.declaredNonTransitions.entries.length, evidence.declaredNonTransitions.count);
  assert.deepEqual(evidence.declaredNonTransitions.entries, [{
    requirementKey: INCHEON_NON_TRANSITION_KEY,
    sourceId: INCHEON_STATION_INFO_SOURCE_ID,
    sourceDomain: "route_graph_topology",
    reasonCode: "NO_SUPPORTING_ROWS_FOR_LINE",
    reasonKo: evidence.declaredNonTransitions.entries[0].reasonKo,
    before: "MISSING",
    after: "MISSING",
    supportingRecordCountByField: { network_edges: 0, duration_seconds: 0, distance_meters: 0 },
  }]);
  assert.match(evidence.declaredNonTransitions.entries[0].reasonKo, /network_edges/);
  // 선언 키는 전이 목록에 없고 SUPPORTED 집합에도 없다 — 선언이 SUPPORTED 수를 늘리지 못한다.
  assert.equal(
    evidence.transitions.some(({ requirementKey }) => requirementKey === INCHEON_NON_TRANSITION_KEY),
    false,
  );
  assert.equal(
    evidence.variants.lineScoped.supportedRequirementKeys.includes(INCHEON_NON_TRANSITION_KEY),
    false,
  );
  // 7호선 서울 구간 route_map_positions는 그대로 남아야 한다 — 인천이 같은 노선에 운영기관 scope를
  // 더하면서 승계 운영기관 scope를 밀어내면 그 requirement가 조용히 사라진다(잃은 키 0 축).
  assert.equal(
    evidence.variants.lineScoped.supportedRequirementKeys
      .includes(`capital:seoul-metro:${INCHEON_LINE7_ID}:route_map_positions`),
    true,
  );

  const [stationInfo, timetable, accessibility] = evidence.packDataInclusions.entries.slice(INCHEON_INDEX);
  // 역 수(69)와 역·노선 쌍 수(71)는 다른 축이고, 그중 4역은 앞선 수도권 편입이 이미 실어 65행만 는다.
  assert.equal(stationInfo.addedRows.stations, 65);
  assert.equal(stationInfo.addedRows.stationLines, 71);
  assert.equal(stationInfo.addedRows.routeMapPositions, 71);
  assert.equal(stationInfo.addedRows.networkEdges, 116);
  // 7호선 노선 레코드는 서울 편입이 이미 만들었고 운영기관 scope만 두 건(서울·인천)으로 는다.
  assert.equal(stationInfo.addedRows.lines, 2);
  assert.equal(stationInfo.addedRows.coverageLineOperatorScopes, 2);
  assert.equal(timetable.addedRows.transitTrips, 1_414);
  assert.equal(timetable.addedRows.transitStopTimes, 40_898);
  assert.equal(timetable.addedRows.sourceInventory, 2);
  // 편의시설은 역·노선 쌍 71 × 시설 3종이며 역 수 69와 곱하지 않는다.
  assert.equal(accessibility.addedRows.facilities, 213);
  assert.equal(accessibility.addedRows.stationFacilityEvidence, 213);
});

test("candidate spec의 line-scope 재기술은 tracked source inventory와 동기다", async (context) => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);
  const appInventory = await readJson(APP_INVENTORY_PATH);
  const [redescription] = spec.lineScopeRedescriptions;
  assert.equal(redescription.sourceId, PILOT_SOURCE_ID);
  assert.deepEqual(redescription.lineIds, ["seoul-4"]);
  assert.deepEqual(redescription.requirementKeys, [PILOT_REQUIREMENT_KEY]);

  // 재기술 전건이 admission 정본과 동기여야 한다. #2549는 inventory를 바꾸지 않고 이미 line-scope로
  // 기술된 대구 소스를 그대로 승계하므로, 이 축이 깨지면 재기술이 정본을 앞질렀다는 뜻이다.
  // declare한 키 집합은 전이 키 ∪ 선언된 non-transition 키다 — 재기술 lineIds가 admission 정본과 정확히
  // 같아야 하므로 열리지 않는 노선도 declare하되, 그 키는 전이 집합에서 명시로 빠진다.
  assert.deepEqual(
    [...new Set(spec.lineScopeRedescriptions.flatMap(({ requirementKeys }) => requirementKeys))].sort(),
    [...ALL_TRANSITIONING_KEYS, INCHEON_NON_TRANSITION_KEY].sort(),
  );
  assert.deepEqual(
    spec.lineScopeRedescriptions.flatMap(
      ({ nonTransitioningRequirements = [] }) => nonTransitioningRequirements.map(
        ({ requirementKey }) => requirementKey,
      ),
    ),
    [INCHEON_NON_TRANSITION_KEY],
  );
  for (const entry of spec.lineScopeRedescriptions) {
    const declared = inventory.sources.find(({ id }) => id === entry.sourceId);
    assert.deepEqual(declared.coverageScope.lineIds, entry.lineIds, entry.sourceId);
    assert.ok(declared.coverageScope.sourceDomains.includes(entry.sourceDomain), entry.sourceId);
    for (const requirementKey of entry.requirementKeys) {
      const [regionId, operatorId, lineId, sourceDomain] = requirementKey.split(":");
      assert.ok(declared.coverageScope.regionIds.includes(regionId), requirementKey);
      assert.ok(declared.coverageScope.operatorIds.includes(operatorId), requirementKey);
      assert.ok(entry.lineIds.includes(lineId), requirementKey);
      assert.equal(sourceDomain, entry.sourceDomain, requirementKey);
    }
  }
  assert.deepEqual(appInventory, inventory, "앱 번들 사본은 datapack 정본과 같아야 한다");

  await context.test("inventory lineIds가 spec과 어긋나면 하네스가 거부한다", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-drift-"));
    const drifted = structuredClone(inventory);
    delete drifted.sources.find(({ id }) => id === PILOT_SOURCE_ID).coverageScope.lineIds;
    try {
      await assert.rejects(
        runNationwideCandidateCoverageGate({
          spec,
          specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
          targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
          inventory: drifted,
          inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
          resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
          resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
          workDir: workspace,
        }),
        /source inventory coverageScope\.lineIds must match the spec redescription/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

// candidate 안전 경계를 산문이 아니라 코드가 강제하는지 본다. 이 도구는 artifactKind production으로 실제
// RSA 서명 manifest를 만들기 때문에, spec 편집만으로 production 채널·게시 가능 URL 서명본이 나오면 안 된다.
test("candidate 안전 경계는 spec 편집만으로 넓힐 수 없다", async (context) => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);

  // solo에 편입 인덱스를 주면 그 편입 하나만 담은 축소 spec으로 돌리고 mutation 대상도 인덱스 0이 된다.
  // 결속·창 회귀에만 쓴다: 두 가드는 어댑터의 경로 결속과 materializer requiredSource의 창 판정이라 승계
  // 행수 대조(assertDeclaredRows)와 pack 선행 조건 검사보다 먼저 걸리고(실측), 그래서 축소로 달라지는
  // addedRows나 빠진 선행 편입은 판정에 닿지 않는다. 가드를 풀면 진단 문구가 달라져 회귀가 그대로 FAIL한다
  // — assert.rejects가 문구까지 대조하므로 "거부되기만 하면 통과"로 무성화되지 않는다.
  async function rejectsWith(mutate, expected, { solo = null } = {}) {
    const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-guard-"));
    const mutated = structuredClone(spec);
    if (solo !== null) mutated.packDataInclusions = [mutated.packDataInclusions[solo]];
    mutate(mutated);
    try {
      await assert.rejects(
        runNationwideCandidateCoverageGate({
          spec: mutated,
          specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
          targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
          inventory,
          inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
          resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
          resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
          workDir: workspace,
        }),
        expected,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  await context.test("production 채널 manifest는 거부된다", async () => {
    await rejectsWith(
      (value) => { value.manifest.channel = "production"; },
      /manifest\.channel must be candidate/,
    );
  });

  await context.test("게시 가능한 pack url은 거부된다", async () => {
    await rejectsWith(
      (value) => { value.pack.url = "https://objectstorage.example.com/catalog/nationwide-candidate-v1.sqlite.gz"; },
      /pack\.url host must be the non-publishable host/,
    );
  });

  // #2549 B1이 파일럿의 "lineIds 1개" 단언을 근거 결속으로 바꿨다. 개수 제한이 사라진 자리를 아래 축이
  // 대신 막는지 본다 — 선언 범위는 admission 정본(inventory)과 declare한 requirementKeys에 묶여 있다.
  await context.test("선언 lineIds가 admission 정본과 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        // requirementKeys까지 함께 넓혀 spec 내부 정합은 맞춘 채로 정본 결속만 어긋나게 한다.
        value.lineScopeRedescriptions[0].lineIds = ["seoul-4", "seoul-2"];
        value.lineScopeRedescriptions[0].requirementKeys = [
          PILOT_REQUIREMENT_KEY,
          "capital:seoul-metro:seoul-2:route_map_positions",
        ];
      },
      /source inventory coverageScope\.lineIds must match the spec redescription/,
    );
  });

  await context.test("requirementKeys가 덮지 않는 lineIds는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.lineScopeRedescriptions[0].lineIds = ["seoul-4", "seoul-2"];
        value.lineScopeRedescriptions[0].requirementKeys = [PILOT_REQUIREMENT_KEY];
      },
      /requirementKeys must cover every redescribed line/,
    );
  });

  await context.test("재기술 도메인을 벗어난 requirementKey는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.lineScopeRedescriptions[0].requirementKeys = ["capital:seoul-metro:seoul-4:route_graph_topology"];
      },
      /requirementKeys must stay in the redescribed source domain/,
    );
  });

  // 두 항목 각각은 내부 정합(도메인·lineIds·requirementKeys)이 맞아 도메인 가드에 걸리지 않는다 —
  // 오직 소스 간 lineIds 동일 강제 축만 이 mutation을 잡는다(정규식 alternation 없이 그 축을 고정한다).
  await context.test("같은 소스를 도메인별로 갈라 다른 lineIds를 선언할 수 없다", async () => {
    await rejectsWith(
      (value) => {
        const entry = value.lineScopeRedescriptions.find(
          ({ sourceId, sourceDomain }) =>
            sourceId === "daegu-line1-route-topology" && sourceDomain === "route_graph_topology",
        );
        entry.lineIds = [DAEGU_LINE_IDS[1]];
        entry.requirementKeys = [`daegu:daegu-transportation:${DAEGU_LINE_IDS[1]}:route_graph_topology`];
      },
      /must declare the same lineIds across domains/,
    );
  });

  // 저장소에 실재하는 materializer라도 allowlist에 없으면 spec이 가리킬 수 없다(#2587에서 부산 4종이,
  // #2595에서 대전·광주·수도권·인천 14종이 등재되면서 탐침을 그때마다 미등재 모듈로 옮겼다 — 등재 확대가
  // 이 축을 지우지 않는지 본다). 대전 topology 전용 materializer는 편입 단위가 아니라 미등재로 남아 있다.
  await context.test("allowlist에 없는 materializer는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[0].materializer = "tools/datapack/materialize-daejeon-route-topology.mjs";
      },
      /unknown pack data materializer/,
    );
  });

  await context.test("저장소 밖 편입 입력은 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].stationMapPath = "../molit-urban-rail-full-route-20251211.csv"; },
      /must be a repository-relative path inside the repo/,
    );
  });

  // 저장소 안 symlink가 밖을 가리키면 문자열 containment는 통과한다 — 실경로 재확인 축을 고정한다.
  // 링크는 저장소 안에 있어야 이 축에 닿지만 tracked 디렉터리에 두면 강제 종료 시 잔재가 남는다
  // (#2580 재검증 지적) — snapshot 사본 회귀와 같이 gitignore된 tmp/ 아래에 만든다.
  await context.test("저장소 밖을 가리키는 symlink 입력은 거부된다", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-outside-"));
    const linkDir = path.join(root, "tmp", `nationwide-candidate-gate-link-${process.pid}-${Date.now()}`);
    await mkdir(linkDir, { recursive: true });
    const linkPath = path.join(linkDir, "escape.csv");
    await writeFile(path.join(outside, "escape.csv"), "");
    await symlink(path.join(outside, "escape.csv"), linkPath);
    try {
      await rejectsWith(
        (value) => {
          value.packDataInclusions[0].stationMapPath = path.relative(root, linkPath);
        },
        /must not resolve outside the repo/,
      );
    } finally {
      await rm(linkDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await context.test("offset 없는 materializedAt은 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].materializedAt = "2026-07-20T16:00:00"; },
      /materializedAt must be a UTC ISO-8601 timestamp/,
    );
  });

  await context.test("선언과 다른 행수를 싣는 편입은 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].addedRows.transitStopTimes += 1; },
      /added rows do not match the spec declaration/,
    );
  });

  await context.test("snapshot 신선도 창 밖으로 기준 시각을 옮기면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[0].materializedAt = "2026-07-25T00:00:00.000Z"; },
      /evidence is stale or future-dated/,
    );
  });

  // #2580 B2-a가 편입 스키마를 다도메인으로 넓혔다. 아래 축들이 그 완화가 안전 경계를 넓히지
  // 않았음을 고정한다 — 중복 금지는 (regionId, materializer)로 좁혀졌을 뿐 사라지지 않았고,
  // 형상 분기는 materializer가 실제로 읽는 경로 키를 여전히 필수로 요구하며, 그 경로는 모두
  // 저장소 안 실경로 강제와 입력 해시 결속을 그대로 받는다.
  await context.test("같은 지역·materializer 편입을 두 번 선언하면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions.push(structuredClone(value.packDataInclusions[1])); },
      /duplicate pack data inclusion: daegu:tools\/datapack\/materialize-daegu-route-map-positions\.mjs/,
    );
  });

  await context.test("materializer가 요구하는 입력 경로 키가 빠지면 거부된다", async () => {
    await rejectsWith(
      (value) => { delete value.packDataInclusions[1].snapshotPath; },
      /materialize-daegu-route-map-positions\.mjs\.snapshotPath is required/,
    );
  });

  // 형상 분기가 넓힌 자리의 반대 방향 축: 등재 형상에 없는 키는 어댑터가 읽지 않으므로 그대로 두면
  // spec이 선언한 입력이 읽히지도 해시되지도 않은 채 통과한다(실측: 무시됐다) — 좁혀서 거부한다.
  await context.test("materializer 형상에 없는 편입 키는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].timetableSnapshotPath =
          "tools/datapack/sources/daegu-line1-train-timetable-20260721.json";
      },
      /materialize-daegu-route-map-positions\.mjs has unknown keys: timetableSnapshotPath/,
    );
  });

  // 서술 키를 "*Ko 접미사면 통과"로 열어 두면 snapshotPathKo 같은 죽은 선언이 그대로 통과한다(실측).
  // 명시 allowlist(reasonKo·materializedAtReasonKo·addedRowsKo·reorderedTablesKo)로 좁혔으므로 그 밖의
  // 서술 키는 거부된다.
  await context.test("등재되지 않은 서술 키는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].snapshotPathKo = "tools/datapack/sources/does-not-exist.json";
      },
      /materialize-daegu-route-map-positions\.mjs has unknown keys: snapshotPathKo/,
    );
  });

  // 등재된 서술 키라도 선언 키 없이 홀로 서면 아무것도 완화하지 않는 죽은 서술이다 — 그 상태로 통과하면
  // "이 편입은 표를 재정렬한다"는 주장이 실제 결속 없이 evidence 밖에 남는다(실측: 그대로 통과했다).
  await context.test("선언 키 없는 reorderedTablesKo는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].reorderedTablesKo = "선언 없이 서술만 남긴 죽은 키";
      },
      /materialize-daegu-route-map-positions\.mjs\.reorderedTablesKo requires reorderedTables/,
    );
  });

  // lineNumber 생략은 숫자 노선명이 없는 두 KRIC 카탈로그 편입에만 열린다. 그 밖의 편입에서 키가 빠지면
  // 거부되고(주석으로만 범위를 적어 두면 번호 있는 노선에서도 조용히 빠진다), 반대로 열린 편입이 번호를
  // 선언하면 없는 값을 지어낸 것이므로 그것도 거부된다.
  await context.test("생략이 열리지 않은 편입에서 lineNumber가 빠지면 거부된다", async () => {
    await rejectsWith(
      (value) => { delete value.packDataInclusions[INCHEON_INDEX].lines[0].lineNumber; },
      /materialize-incheon-station-info\.mjs\.lines\[\]\.lineNumber must be a positive integer/,
    );
  });

  await context.test("숫자 노선명이 없는 편입이 lineNumber를 선언하면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[CAPITAL_INDEX].lines[0].lineNumber = 1; },
      new RegExp(
        "materialize-kric-capital-wide-rail-route-map-positions\\.mjs\\.lines\\[\\]\\.lineNumber "
          + "must be omitted for lines without a numbered name",
      ),
    );
  });

  // 요구만 하고 대조 상대를 두지 않으면 번호는 선언만 늘고 확인이 없는 축이 된다 — 저장소 정본과 갈린
  // 번호는 그 자리에서 거부된다.
  await context.test("저장소 정본과 다른 lineNumber는 거부된다", async () => {
    await rejectsWith(
      // solo로 줄인 spec에서는 대상 편입이 인덱스 0이다.
      (value) => { value.packDataInclusions[0].lines[0].lineNumber = 3; },
      /materialize-incheon-station-info\.mjs pack data inclusion lines must match the tracked line numbers/,
      { solo: INCHEON_INDEX },
    );
  });

  await context.test("대전·광주 lineNumber도 저장소 정본과 다르면 거부된다", async () => {
    for (const [index, materializer] of [
      [DAEJEON_INDEX, "materialize-daejeon-timetable.mjs"],
      [GWANGJU_INDEX, "materialize-gwangju-timetable.mjs"],
    ]) {
      await rejectsWith(
        (value) => { value.packDataInclusions[0].lines[0].lineNumber = 2; },
        new RegExp(`${materializer.replaceAll(".", "\\.")} pack data inclusion lines must match the tracked line numbers`),
        { solo: index },
      );
    }
  });

  await context.test("materializer 형상에 없는 lines 키는 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].lines[0].timetableSnapshotPath =
          "tools/datapack/sources/daegu-line1-train-timetable-20260721.json";
      },
      /materialize-daegu-route-map-positions\.mjs\.lines\[\] has unknown keys: timetableSnapshotPath/,
    );
  });

  // spec 단계 중복 금지 단위는 (regionId, materializer)라 같은 materializer를 다른 regionId로 두 번
  // 실으면 그 축에 걸리지 않는다 — materializer의 소스 재등재 거부가 그 자리를 실제로 막는지 본다.
  await context.test("같은 materializer를 다른 regionId로 두 번 실으면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const duplicated = structuredClone(value.packDataInclusions[1]);
        duplicated.regionId = "daegu-mirror";
        value.packDataInclusions.push(duplicated);
      },
      /daegu-transportation-route-map-positions already exists/,
    );
  });

  // 두 편입 모두 admission 정본의 snapshotPath에 결속돼 있다. 결속이 없으면 아래 사본들이 그대로 조립을
  // 통과한다(실측) — 편의시설 정본에는 바이트 축이 아예 없어 재직렬화 사본도 rawSha256·rowsSha256이 같고,
  // 노선도 정본에는 바이트 축(snapshotSha256)이 있지만 바이트 동일 사본은 그 축을 그대로 지난다.
  // 사본은 하네스가 읽을 수 있게 저장소 안에 두되 gitignore된 tmp/ 아래에 둔다(강제 종료 시 tracked
  // 디렉터리에 잔재가 남지 않게).
  // lineIndex를 주면 편입 층이 아니라 노선 층 경로 키를 바꾼다(수도권 광역·경전철 편입은 노선마다
  // 자기 소스의 snapshotPath를 갖는다).
  async function rejectsSnapshotCopy({
    index,
    key = "snapshotPath",
    lineIndex = null,
    solo = null,
    sourcePath,
    copyName,
    serialize,
    expected,
  }) {
    const copyDir = path.join(root, "tmp", `nationwide-candidate-gate-copy-${process.pid}-${Date.now()}`);
    await mkdir(copyDir, { recursive: true });
    const copyPath = path.relative(root, path.join(copyDir, copyName));
    await writeFile(path.join(root, copyPath), serialize(await readFile(path.join(root, sourcePath))));
    try {
      await rejectsWith((value) => {
        const inclusion = value.packDataInclusions[solo === null ? index : 0];
        if (lineIndex === null) inclusion[key] = copyPath;
        else inclusion.lines[lineIndex][key] = copyPath;
      }, expected, { solo });
    } finally {
      await rm(copyDir, { recursive: true, force: true });
    }
  }

  await context.test("노선도 편입이 admission 정본 밖 바이트 동일 사본을 가리키면 거부된다", async () => {
    await rejectsSnapshotCopy({
      index: 1,
      sourcePath: "tools/datapack/sources/daegu-transportation-route-map-positions-20260724.json",
      copyName: "route-map-copy.json",
      // 바이트를 그대로 옮긴다 — materializer의 snapshotSha256 대조만으로는 이 사본이 통과한다(실측).
      serialize: (bytes) => bytes,
      expected:
        /snapshotPath must match the daegu-transportation-route-map-positions admission evidence snapshotPath/,
    });
  });

  await context.test("편의시설 편입이 admission 정본 밖 snapshot 사본을 가리키면 거부된다", async () => {
    await rejectsSnapshotCopy({
      index: 2,
      sourcePath: "tools/datapack/sources/daegu-transportation-accessibility-20260724.json",
      copyName: "accessibility-copy.json",
      serialize: (bytes) => JSON.stringify(JSON.parse(bytes.toString("utf8"))),
      expected: /snapshotPath must match the daegu-transportation-accessibility admission evidence snapshotPath/,
    });
  });

  // 노선도 편입의 snapshotPath는 admission 정본 경로에 결속돼 이 축에 닿기 전에 걸린다 — 결속이 없는
  // 경로 키(lines[].topologySnapshotPath)로 일반화된 형상의 저장소 밖 입력 거부를 고정한다.
  await context.test("일반화된 형상의 편입 입력도 저장소 밖을 가리키면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[1].lines[0].topologySnapshotPath =
          "../daegu-line1-route-topology-20260721.json";
      },
      /must be a repository-relative path inside the repo/,
    );
  });

  // 체인 순서는 임의 배열이 아니다 — route_map·accessibility materializer는 대구 운영기관과 시각표
  // 소스가 pack에 이미 있을 것을 선행 조건으로 검사하므로, 시각표 편입을 뒤로 미루면 조립이 멈춘다.
  await context.test("편입 체인 순서를 뒤집으면 선행 조건이 깨져 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions = [
          value.packDataInclusions[1],
          value.packDataInclusions[0],
          ...value.packDataInclusions.slice(2),
        ];
      },
      /Daegu route map positions require daegu-transportation operator pack/,
    );
  });

  await context.test("체인 뒤 편입의 선언 행수가 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[2].addedRows.facilities += 1; },
      /materialize-daegu-accessibility\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // 편입마다 신선도 창이 다르므로 기준 시각 pin도 편입 단위다. 다만 노선도 편입의 창은 하한뿐이라
  // 다른 두 편입(시각표·편의시설의 [capturedAt, freshUntil))과 신선도 보장이 비대칭이다 — 포착 이전
  // pin만 fail closed 되고 먼 미래 pin은 통과한다. 상한 도입은 materializer 쪽 판단이라 여기서
  // 동작으로 고정하지 않고 비대칭을 기록만 한다.
  await context.test("노선도 편입 기준 시각을 snapshot 포착 이전으로 옮기면 거부된다(하한만 검사·상한 없음)", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[1].materializedAt = "2026-07-20T16:00:00.000Z"; },
      /daegu-transportation-route-map-positions inventory evidence does not match snapshot/,
    );
  });

  await context.test("편의시설 편입 기준 시각을 신선도 창 밖으로 옮기면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[2].materializedAt = "2026-07-25T01:00:00.000Z"; },
      /daegu-transportation-accessibility evidence freshness is invalid/,
    );
  });

  // #2587 B2-b. 부산 구간이 강제하는 순서는 "topology가 먼저"다 — 승계 원본에 부산 운영기관·노선·역이
  // 아예 없어 뒤 세 편입이 전부 topology 편입 결과를 선행 조건으로 검사한다.
  await context.test("부산 topology 편입을 뒤로 미루면 선행 조건이 깨져 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const busan = value.packDataInclusions.slice(BUSAN_TOPOLOGY_INDEX);
        value.packDataInclusions = [
          ...value.packDataInclusions.slice(0, BUSAN_TOPOLOGY_INDEX),
          busan[1],
          busan[0],
          ...busan.slice(2),
        ];
      },
      // topology 편입이 앞서지 않으면 pack에 부산 station_lines가 하나도 없어 시각표 정본 대조가
      // 역 범위 단계에서 멈춘다(계보 대조까지 가지도 못한다).
      /Busan timetable canonical station count mismatch: 0/,
    );
  });

  // 선행 조건이 없는 두 편입(시각표↔노선도)의 교환은 대구에서는 조립을 그대로 통과했다. 부산은 노선도
  // 편입이 승계 원본에 없던 표를 새로 만들어 그 표를 0으로 선언해야 하는 편입이 순서에 따라 갈리므로,
  // 선행 조건이 아니라 선언 행수 대조가 교환을 막는다 — evidence chainKo가 기록한 그 축을 고정한다.
  await context.test("부산 시각표·노선도 편입을 교환하면 선언 행수 대조에서 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const busan = value.packDataInclusions.slice(BUSAN_TOPOLOGY_INDEX);
        value.packDataInclusions = [
          ...value.packDataInclusions.slice(0, BUSAN_TOPOLOGY_INDEX),
          busan[0],
          busan[2],
          busan[1],
          busan[3],
        ];
      },
      /materialize-busan-timetable\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // 부산 편입은 대구와 달리 편입 층 경로 키만 쓴다(topology snapshot이 4노선 한 파일). 편입 4종의
  // snapshotPath와, topology 계보를 읽는 뒤 세 편입의 topologySnapshotPath가 admission 정본 경로에
  // 결속돼 있다 — 결속 지점을 하나만 덮으면 나머지가 풀려도 회귀가 침묵하므로 편입별로 돈다.
  //
  // 다만 "부산 편입의 경로 키가 전부 정본 경로에 결속"은 아니다: topology 편입의 stationMapPath에는
  // 경로 결속이 없고 admission 정본의 membership.mappingSha256(파싱 결과에서 파생된 내용 해시)만
  // 판정에 쓴다. 부산권 행만 남긴 축약 CSV(158줄, tracked 원본 302줄)를 gitignore된 tmp/ 아래에 두고
  // 가리켜도 조립이 그대로 통과한다(실측) — 이 키의 결속 축은 경로가 아니라 내용 해시다.
  for (const { labelKo, slug, offset, sourceId, evidenceKey } of BUSAN_INCLUSION_BINDINGS) {
    await context.test(`부산 ${labelKo} 편입 snapshotPath가 정본 밖 바이트 동일 사본이면 거부된다`, async () => {
      await rejectsSnapshotCopy({
        index: BUSAN_TOPOLOGY_INDEX + offset,
        solo: BUSAN_TOPOLOGY_INDEX + offset,
        sourcePath: admissionEvidenceOf(inventory, sourceId, evidenceKey).snapshotPath,
        copyName: `busan-${slug}-copy.json`,
        // 바이트를 그대로 옮긴다 — materializer의 바이트·내용 대조만으로는 사본이 통과한다(실측).
        serialize: (bytes) => bytes,
        expected: new RegExp(`snapshotPath must match the ${sourceId} admission evidence snapshotPath`),
      });
    });
  }

  for (const { labelKo, slug, offset } of BUSAN_INCLUSION_BINDINGS.slice(1)) {
    await context.test(`부산 ${labelKo} 편입 topologySnapshotPath가 정본 밖 사본이면 거부된다`, async () => {
      await rejectsSnapshotCopy({
        index: BUSAN_TOPOLOGY_INDEX + offset,
        solo: BUSAN_TOPOLOGY_INDEX + offset,
        key: "topologySnapshotPath",
        sourcePath: admissionEvidenceOf(
          inventory,
          BUSAN_TOPOLOGY_BINDING.sourceId,
          BUSAN_TOPOLOGY_BINDING.evidenceKey,
        ).snapshotPath,
        copyName: `busan-${slug}-topology-copy.json`,
        // 재직렬화 사본도 contentSha256(내용 파생)은 그대로라 materializer의 계보 대조만으로는 통과한다.
        serialize: (bytes) => JSON.stringify(JSON.parse(bytes.toString("utf8"))),
        expected: new RegExp(
          `snapshotPath must match the ${BUSAN_TOPOLOGY_BINDING.sourceId} admission evidence snapshotPath`,
        ),
      });
    });
  }

  // 부산 lines 선언은 장식이 아니다 — 저장소 정본(BUSAN_LINES)과 대조하지 않으면 틀린 노선 구성이
  // 그대로 통과해 evidence의 선언과 실제 조립이 갈린다.
  await context.test("부산 편입의 노선 선언이 정본과 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[BUSAN_TOPOLOGY_INDEX].lines[1].lineNumber = 5; },
      /must declare every tracked Busan line/,
    );
  });

  // 새로 생기는 표(routeMapLineTracks)도 대조 축이다 — 선언에서 빼면 실제 산출 map과 전키 비교가 어긋난다.
  await context.test("부산 노선도 편입이 새 표를 선언하지 않으면 거부된다", async () => {
    await rejectsWith(
      (value) => { delete value.packDataInclusions[BUSAN_TOPOLOGY_INDEX + 2].addedRows.routeMapLineTracks; },
      /materialize-busan-route-map-positions\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // pin 창 회귀도 편입 단위다. 편입 하나의 창만 덮으면 나머지 세 창이 풀려도 침묵하는데, 창 모양이
  // 편입마다 갈리므로(양끝 검사 3편입 / 하한만 1편입) 한 편입의 통과가 다른 편입의 근거가 되지도
  // 않는다. 창 값은 admission 정본에서 끌어와 하한 직전(capturedAt - 1ms)과 상한 정각(freshUntil,
  // 반개구간이라 이미 창 밖)을 각각 때린다.
  for (const { labelKo, offset, sourceId, evidenceKey, stalePinPattern } of BUSAN_INCLUSION_BINDINGS) {
    const { capturedAt, freshUntil } = admissionEvidenceOf(inventory, sourceId, evidenceKey);
    await context.test(`부산 ${labelKo} 편입 기준 시각을 창 하한 미만으로 옮기면 거부된다`, async () => {
      await rejectsWith(
        (value) => {
          value.packDataInclusions[0].materializedAt = new Date(Date.parse(capturedAt) - 1).toISOString();
        },
        stalePinPattern,
        { solo: BUSAN_TOPOLOGY_INDEX + offset },
      );
    });
    // 노선도 편입의 창에는 상한이 없다 — 그 비대칭은 아래 별도 축이 "먼 미래 pin도 통과한다"로 고정한다.
    if (freshUntil === undefined) continue;
    await context.test(`부산 ${labelKo} 편입 기준 시각을 창 상한 이상으로 옮기면 거부된다`, async () => {
      await rejectsWith(
        (value) => { value.packDataInclusions[0].materializedAt = freshUntil; },
        stalePinPattern,
        { solo: BUSAN_TOPOLOGY_INDEX + offset },
      );
    });
  }

  // ── #2595 B3: 대전·광주·수도권 편입의 결속·창·순서 회귀 ──────────────────────────────────────
  //
  // 결속 회귀를 편입 하나로만 두면 나머지 편입의 가드가 풀려도 회귀가 침묵한다. 지역별 표로 돌리고,
  // 경로·창 값은 전부 admission 정본에서 끌어온다(하드코딩 금지).
  for (const [regionKo, regionIndex, bindings] of [
    ["대전", DAEJEON_INDEX, DAEJEON_INCLUSION_BINDINGS],
    ["광주", GWANGJU_INDEX, GWANGJU_INCLUSION_BINDINGS],
  ]) {
    for (const binding of bindings) {
      const { labelKo, slug, offset, sourceId, evidenceKey, topologyBinding } = binding;
      await context.test(`${regionKo} ${labelKo} 편입 snapshotPath가 정본 밖 바이트 동일 사본이면 거부된다`, async () => {
        await rejectsSnapshotCopy({
          index: regionIndex + offset,
          solo: regionIndex + offset,
          sourcePath: admissionEvidenceOf(inventory, sourceId, evidenceKey).snapshotPath,
          copyName: `${regionKo}-${slug}-copy.json`,
          serialize: (bytes) => bytes,
          expected: new RegExp(`snapshotPath must match the ${sourceId} admission evidence snapshotPath`),
        });
      });
      await context.test(`${regionKo} ${labelKo} 편입 topologySnapshotPath가 정본 밖 사본이면 거부된다`, async () => {
        await rejectsSnapshotCopy({
          index: regionIndex + offset,
          solo: regionIndex + offset,
          key: "topologySnapshotPath",
          sourcePath: admissionEvidenceOf(
            inventory,
            topologyBinding.sourceId,
            topologyBinding.evidenceKey,
          ).snapshotPath,
          copyName: `${regionKo}-${slug}-topology-copy.json`,
          // 재직렬화 사본도 contentSha256(내용 파생)은 그대로라 materializer의 계보 대조만으로는 통과한다.
          serialize: (bytes) => JSON.stringify(JSON.parse(bytes.toString("utf8"))),
          expected: new RegExp(
            `snapshotPath must match the ${topologyBinding.sourceId} admission evidence snapshotPath`,
          ),
        });
      });

      // 창 회귀도 편입 단위다. 이 배치의 시각표 편입은 창 하한·상한이 서로 다른 정본에서 오므로
      // 경계 값을 binding이 가리키는 정본 필드에서 끌어온다.
      const lowerBound = admissionEvidenceOf(
        inventory,
        binding.lowerBound.sourceId,
        binding.lowerBound.evidenceKey,
      )[binding.lowerBound.field];
      await context.test(`${regionKo} ${labelKo} 편입 기준 시각을 창 하한 미만으로 옮기면 거부된다`, async () => {
        await rejectsWith(
          (value) => {
            value.packDataInclusions[0].materializedAt = new Date(Date.parse(lowerBound) - 1).toISOString();
          },
          binding.belowLowerBoundPattern,
          { solo: regionIndex + offset },
        );
      });
      if (binding.upperBound === undefined) continue;
      const upperBound = admissionEvidenceOf(
        inventory,
        binding.upperBound.sourceId,
        binding.upperBound.evidenceKey,
      )[binding.upperBound.field];
      await context.test(`${regionKo} ${labelKo} 편입 기준 시각을 창 상한 이상으로 옮기면 거부된다`, async () => {
        await rejectsWith(
          (value) => { value.packDataInclusions[0].materializedAt = upperBound; },
          binding.atUpperBoundPattern,
          { solo: regionIndex + offset },
        );
      });
    }
  }

  // 수도권 광역·경전철 편입은 결속 단위가 노선(=소스)이다. 노선 하나만 덮으면 나머지 노선의 결속이 풀려도
  // 회귀가 침묵하므로 편입 안의 노선 전체를 돈다.
  for (const { labelKo, slug, offset, lineSourceIds } of CAPITAL_INCLUSION_BINDINGS) {
    if (lineSourceIds === undefined) continue;
    for (const [lineIndex, lineSourceId] of lineSourceIds.entries()) {
      await context.test(
        `수도권 ${labelKo} 편입 ${lineSourceId} snapshotPath가 정본 밖 사본이면 거부된다`,
        async () => {
          await rejectsSnapshotCopy({
            index: CAPITAL_INDEX + offset,
            solo: CAPITAL_INDEX + offset,
            lineIndex,
            sourcePath: admissionEvidenceOf(inventory, lineSourceId, "routeMapAdmissionEvidence").snapshotPath,
            copyName: `capital-${slug}-${lineIndex}-copy.json`,
            serialize: (bytes) => bytes,
            expected: new RegExp(`snapshotPath must match the ${lineSourceId} admission evidence snapshotPath`),
          });
        },
      );
    }
  }

  // 서울 1~8호선·9호선 편입은 편입 층 snapshotPath 하나를 쓴다(소스 하나만 싣는다).
  for (const { labelKo, slug, offset, sourceId, evidenceKey } of CAPITAL_INCLUSION_BINDINGS) {
    if (sourceId === undefined) continue;
    await context.test(`수도권 ${labelKo} 편입 snapshotPath가 정본 밖 바이트 동일 사본이면 거부된다`, async () => {
      await rejectsSnapshotCopy({
        index: CAPITAL_INDEX + offset,
        solo: CAPITAL_INDEX + offset,
        sourcePath: admissionEvidenceOf(inventory, sourceId, evidenceKey).snapshotPath,
        copyName: `capital-${slug}-copy.json`,
        serialize: (bytes) => bytes,
        expected: new RegExp(`snapshotPath must match the ${sourceId} admission evidence snapshotPath`),
      });
    });
  }

  // capital-route-topology는 inventory 소스가 아니라 tracked snapshot 파일로만 존재해 admission 정본에
  // snapshotPath 항목이 없다 — 노선도 정본의 topologySnapshotId에서 유도한 경로에 결속돼 있다. 서울
  // 1~8호선 편입만 이 축이 없다(그 materializer는 경로 그래프 계보를 읽지 않는다).
  for (const { labelKo, slug, offset, lineSourceIds, sourceId } of CAPITAL_INCLUSION_BINDINGS) {
    const topologySourceId = lineSourceIds?.[0] ?? sourceId;
    if (topologySourceId === CAPITAL_SEOUL_ROUTE_MAP_SOURCE_ID) continue;
    await context.test(`수도권 ${labelKo} 편입 topologySnapshotPath가 정본 밖 사본이면 거부된다`, async () => {
      const declared = admissionEvidenceOf(inventory, topologySourceId, "routeMapAdmissionEvidence");
      await rejectsSnapshotCopy({
        index: CAPITAL_INDEX + offset,
        solo: CAPITAL_INDEX + offset,
        key: "topologySnapshotPath",
        sourcePath: `tools/datapack/sources/${declared.topologySnapshotId}.json`,
        copyName: `capital-${slug}-topology-copy.json`,
        serialize: (bytes) => JSON.stringify(JSON.parse(bytes.toString("utf8"))),
        expected: new RegExp(
          `topologySnapshotPath must match the ${topologySourceId} admission evidence topologySnapshotId path`,
        ),
      });
    });
  }

  // 수도권 다섯 편입의 창에는 상한이 없다(정본에 freshUntil이 없고 materializer도 하한만 검사한다).
  // 하한은 광역·경전철에서 노선마다 따로 있지만 값이 모두 같아 편입 하나의 pin이 여덟/다섯 하한을 함께
  // 만족한다 — 그 "값이 같다"는 사실부터 정본에서 확인하고, 하한 위반은 첫 노선 소스에서 걸린다.
  for (const { labelKo, offset, lineSourceIds, sourceId, belowLowerBoundPattern } of CAPITAL_INCLUSION_BINDINGS) {
    const sourceIds = lineSourceIds ?? [sourceId];
    const windows = sourceIds.map((id) => admissionEvidenceOf(inventory, id, "routeMapAdmissionEvidence"));
    await context.test(`수도권 ${labelKo} 편입 소스의 창은 상한이 없고 하한이 하나로 모인다`, () => {
      for (const window of windows) {
        assert.equal(window.freshUntil, undefined, "수도권 노선도 정본에는 상한이 없다");
        assert.equal(window.capturedAt, windows[0].capturedAt, "한 편입이 싣는 소스의 하한은 모두 같다");
      }
    });
    await context.test(`수도권 ${labelKo} 편입 기준 시각을 창 하한 미만으로 옮기면 거부된다`, async () => {
      await rejectsWith(
        (value) => {
          value.packDataInclusions[0].materializedAt =
            new Date(Date.parse(windows[0].capturedAt) - 1).toISOString();
        },
        belowLowerBoundPattern,
        { solo: CAPITAL_INDEX + offset },
      );
    });
  }

  // ── 인천 편입의 결속·창 회귀 ────────────────────────────────────────────────────────────────
  //
  // 세 편입 모두 승계 pack 의존이 없는 축(materializer의 정본 대조가 pack 선행 조건 검사보다 먼저 돈다)
  // 이라 축소 spec으로 돈다. 수도권과 달리 창에 상한이 있고(정본에 freshUntil이 있다) materializer가
  // 창 길이 24시간까지 함께 검사하므로 하한 미만·상한 이상을 모두 때린다.
  for (const binding of INCHEON_INCLUSION_BINDINGS) {
    const { labelKo, slug, offset, sourceId, evidenceKey, lineSourceIds } = binding;
    if (sourceId !== undefined) {
      await context.test(`인천 ${labelKo} 편입 snapshotPath가 정본 밖 사본이면 거부된다`, async () => {
        await rejectsSnapshotCopy({
          index: INCHEON_INDEX + offset,
          solo: INCHEON_INDEX + offset,
          sourcePath: admissionEvidenceOf(inventory, sourceId, evidenceKey).snapshotPath,
          copyName: `incheon-${slug}-copy.json`,
          // 역사정보 정본에는 바이트 축(snapshotSha256)이 있고 편의시설 정본에는 없다 — 어느 쪽이든
          // 바이트 동일 사본은 그 축을 그대로 지나므로 경로 결속만이 정본 하나를 못박는다.
          serialize: (bytes) => bytes,
          expected: new RegExp(`snapshotPath must match the ${sourceId} admission evidence snapshotPath`),
        });
      });
    }
    for (const [lineIndex, lineSourceId] of (lineSourceIds ?? []).entries()) {
      await context.test(
        `인천 ${labelKo} 편입 ${lineSourceId} snapshotPath가 정본 밖 사본이면 거부된다`,
        async () => {
          await rejectsSnapshotCopy({
            index: INCHEON_INDEX + offset,
            solo: INCHEON_INDEX + offset,
            lineIndex,
            sourcePath: admissionEvidenceOf(inventory, lineSourceId, "scheduleAdmissionEvidence").snapshotPath,
            copyName: `incheon-${slug}-${lineIndex}-copy.json`,
            serialize: (bytes) => bytes,
            expected: new RegExp(`snapshotPath must match the ${lineSourceId} admission evidence snapshotPath`),
          });
        },
      );
    }
    // 역사정보 편입은 topology snapshot 자체를 snapshotPath로 읽으므로 이 축이 따로 없다.
    if (offset > 0) {
      await context.test(`인천 ${labelKo} 편입 topologySnapshotPath가 정본 밖 사본이면 거부된다`, async () => {
        await rejectsSnapshotCopy({
          index: INCHEON_INDEX + offset,
          solo: INCHEON_INDEX + offset,
          key: "topologySnapshotPath",
          sourcePath: admissionEvidenceOf(
            inventory,
            INCHEON_STATION_INFO_SOURCE_ID,
            "topologyAdmissionEvidence",
          ).snapshotPath,
          copyName: `incheon-${slug}-topology-copy.json`,
          serialize: (bytes) => JSON.stringify(JSON.parse(bytes.toString("utf8"))),
          expected: new RegExp(
            `snapshotPath must match the ${INCHEON_STATION_INFO_SOURCE_ID} admission evidence snapshotPath`,
          ),
        });
      });
    }

    const { capturedAt, freshUntil } = admissionEvidenceOf(
      inventory,
      binding.windowSourceId,
      binding.windowEvidenceKey,
    );
    await context.test(`인천 ${labelKo} 편입 소스의 창은 24시간 반개구간이다`, () => {
      assert.equal(Date.parse(freshUntil) - Date.parse(capturedAt), 24 * 60 * 60 * 1_000);
    });
    await context.test(`인천 ${labelKo} 편입 기준 시각을 창 하한 미만으로 옮기면 거부된다`, async () => {
      await rejectsWith(
        (value) => {
          value.packDataInclusions[0].materializedAt = new Date(Date.parse(capturedAt) - 1).toISOString();
        },
        binding.outsideWindowPattern,
        { solo: INCHEON_INDEX + offset },
      );
    });
    await context.test(`인천 ${labelKo} 편입 기준 시각을 창 상한 이상으로 옮기면 거부된다`, async () => {
      await rejectsWith(
        (value) => { value.packDataInclusions[0].materializedAt = freshUntil; },
        binding.outsideWindowPattern,
        { solo: INCHEON_INDEX + offset },
      );
    });
  }

  // 순서 회귀. 대전·광주는 시각표 편입이 지역 자체(운영기관·노선·역)를 세우므로 노선도가 앞서면 선행
  // 조건이 막는다. 노선도 materializer는 운영기관 존재와 시각표 소스 등재를 둘 다 검사하는데 실측상 먼저
  // 걸리는 것은 운영기관 쪽이다 — 문구를 그 실측대로 고정한다.
  for (const [regionKo, regionIndex, missingOperatorPattern] of [
    ["대전", DAEJEON_INDEX, /Daejeon route map positions require daejeon-transportation operator pack/],
    [
      "광주",
      GWANGJU_INDEX,
      /Gwangju route map positions require gwangju-metropolitan-rapid-transit operator pack/,
    ],
  ]) {
    await context.test(`${regionKo} 시각표·노선도 편입을 교환하면 선행 조건이 막는다`, async () => {
      await rejectsWith(
        (value) => {
          const region = value.packDataInclusions.slice(regionIndex, regionIndex + 3);
          value.packDataInclusions = [
            ...value.packDataInclusions.slice(0, regionIndex),
            region[1],
            region[0],
            region[2],
            ...value.packDataInclusions.slice(regionIndex + 3),
          ];
        },
        missingOperatorPattern,
      );
    });
  }

  // 수도권 세 편입 사이에는 선행 조건이 아예 없다(승계 pack 의존이 없다) — 그런데도 교환이 막히는 것은
  // 선언 행수 대조 때문이다. 새 표(coverageLineOperatorScopes)를 만드는 편입이 순서에 따라 갈리고,
  // 환승역 중복 제거 결과(stations·stationLines)도 앞선 편입이 무엇을 실었는지에 따라 갈린다.
  // 재정렬 선언도 같은 순서에 묶여 있지만(그 표에 승계 행이 있는지가 순서에 따라 갈린다) 실측상 먼저
  // 걸리는 것은 행수 대조다.
  for (const [labelKo, reordered, blockedMaterializer] of [
    ["광역철도·경전철", [1, 0, 2, 3, 4], "materialize-kric-capital-light-rail-route-map-positions"],
    ["서울·광역철도", [2, 0, 1, 3, 4], "materialize-seoul-route-map-positions"],
    // 9호선 두 소스는 같은 노선의 역을 나눠 실어 중복 제거 결과가 순서에 따라 갈린다.
    ["9호선 1단계·2·3단계", [0, 1, 2, 4, 3], "materialize-seoul9-route-map-positions"],
    ["9호선·서울 1~8호선", [0, 1, 3, 4, 2], "materialize-seoul9-phase1-route-map-positions"],
  ]) {
    await context.test(`수도권 ${labelKo} 편입을 교환하면 선언 행수 대조에서 거부된다`, async () => {
      await rejectsWith(
        (value) => {
          const capital = value.packDataInclusions.slice(CAPITAL_INDEX, INCHEON_INDEX);
          value.packDataInclusions = [
            ...value.packDataInclusions.slice(0, CAPITAL_INDEX),
            ...reordered.map((offset) => capital[offset]),
            ...value.packDataInclusions.slice(INCHEON_INDEX),
          ];
        },
        new RegExp(`${blockedMaterializer}\\.mjs pack data inclusion added rows do not match the spec declaration`),
      );
    });
  }

  // 인천 구간은 부산과 같은 모양이다 — 승계 원본에 지역 자체가 없어 역사정보 편입이 운영기관·노선·역을
  // 함께 싣고 뒤 두 편입이 그 운영기관 존재를 선행 조건으로 검사한다. 두 편입 각각에 대해 돈다(하나만
  // 덮으면 나머지 편입의 선행 조건이 풀려도 회귀가 침묵한다).
  for (const [labelKo, offset, missingOperatorPattern] of [
    ["시각표", 1, /Incheon timetable requires incheon-transit operator pack/],
    ["편의시설", 2, /Incheon accessibility requires incheon-transit operator pack/],
  ]) {
    await context.test(`인천 역사정보·${labelKo} 편입을 교환하면 선행 조건이 막는다`, async () => {
      await rejectsWith(
        (value) => {
          const incheon = value.packDataInclusions.slice(INCHEON_INDEX);
          [incheon[0], incheon[offset]] = [incheon[offset], incheon[0]];
          value.packDataInclusions = [...value.packDataInclusions.slice(0, INCHEON_INDEX), ...incheon];
        },
        missingOperatorPattern,
      );
    });
  }

  // 인천 구간 전체를 수도권 앞으로 옮기는 것은 선행 조건이 아니라 행수 대조가 막는다: 7호선 노선 레코드와
  // 환승역 4곳(검암·계양·원인재·부천종합운동장)을 수도권 편입이 먼저 실었는지에 따라 역사정보 편입의
  // lines·stations·coverageLineOperatorScopes 선언이 갈린다(실측).
  await context.test("인천 편입을 수도권 앞으로 옮기면 선언 행수 대조에서 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const incheon = value.packDataInclusions.slice(INCHEON_INDEX);
        value.packDataInclusions = [
          ...value.packDataInclusions.slice(0, CAPITAL_INDEX),
          ...incheon,
          ...value.packDataInclusions.slice(CAPITAL_INDEX, INCHEON_INDEX),
        ];
      },
      /materialize-incheon-station-info\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // 선행 조건이 없는 쌍(시각표↔편의시설)의 교환은 조립을 그대로 통과한다 — 대구·대전과 같은 축이며
  // 기록된 전체 순서를 고정하는 것은 evidence 순서 대조라는 chainKo 서술이 인천에서도 성립하는지 본다.
  await context.test("인천 시각표·편의시설 편입 교환은 조립을 통과한다", async () => {
    const mutated = structuredClone(spec);
    const incheon = mutated.packDataInclusions.slice(INCHEON_INDEX);
    mutated.packDataInclusions = [
      ...mutated.packDataInclusions.slice(0, INCHEON_INDEX),
      incheon[0],
      incheon[2],
      incheon[1],
    ];
    const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-incheon-order-"));
    try {
      const evidence = await runNationwideCandidateCoverageGate({
        spec: mutated,
        specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
        targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
        inventory,
        inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
        resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
        resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
        workDir: workspace,
      });
      assert.equal(
        evidence.packDataInclusions.entries[INCHEON_INDEX + 1].materializer,
        "tools/datapack/materialize-incheon-accessibility.mjs",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 선행 조건이 없는 쌍의 교환은 조립을 그대로 통과한다(대구와 같은 축) — "기록된 전체 순서를 고정하는
  // 것은 조립 fail closed가 아니라 evidence 순서 대조"라는 chainKo 서술이 대전에서도 성립하는지 본다.
  await context.test("대전 노선도·편의시설 편입 교환은 조립을 통과한다", async () => {
    const mutated = structuredClone(spec);
    const region = mutated.packDataInclusions.slice(DAEJEON_INDEX, DAEJEON_INDEX + 3);
    mutated.packDataInclusions = [
      ...mutated.packDataInclusions.slice(0, DAEJEON_INDEX),
      region[0],
      region[2],
      region[1],
      ...mutated.packDataInclusions.slice(DAEJEON_INDEX + 3),
    ];
    const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-order-"));
    try {
      const evidence = await runNationwideCandidateCoverageGate({
        spec: mutated,
        specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
        targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
        inventory,
        inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
        resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
        resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
        workDir: workspace,
      });
      assert.equal(
        evidence.packDataInclusions.entries[DAEJEON_INDEX + 1].materializer,
        "tools/datapack/materialize-daejeon-accessibility.mjs",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 지역 간 순서도 같은 축에 묶여 있다. 수도권 편입을 대전 앞으로 옮기면 coverageLineOperatorScopes가
  // 대전·광주 편입보다 먼저 생겨 그 편입들의 선언 행수 대조가 어긋난다.
  await context.test("수도권 편입을 대전 앞으로 옮기면 선언 행수 대조에서 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const capital = value.packDataInclusions.slice(CAPITAL_INDEX, INCHEON_INDEX);
        value.packDataInclusions = [
          ...value.packDataInclusions.slice(0, DAEJEON_INDEX),
          ...capital,
          ...value.packDataInclusions.slice(DAEJEON_INDEX, CAPITAL_INDEX),
          ...value.packDataInclusions.slice(INCHEON_INDEX),
        ];
      },
      /materialize-daejeon-timetable\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // 선언 행수 오선언도 지역별로 돈다 — 한 지역만 덮으면 나머지 지역의 대조가 풀려도 회귀가 침묵한다.
  for (const [labelKo, index, table] of [
    ["대전 시각표", DAEJEON_INDEX, "transitStopTimes"],
    ["광주 시각표", GWANGJU_INDEX, "transitStopTimes"],
    ["수도권 광역철도", CAPITAL_INDEX, "routeMapPositions"],
    ["수도권 경전철", CAPITAL_INDEX + 1, "stationLines"],
    ["수도권 서울", CAPITAL_INDEX + 2, "stations"],
    ["수도권 9호선 1단계", CAPITAL_INDEX + 3, "stations"],
    ["수도권 9호선 2·3단계", CAPITAL_INDEX + 4, "routeMapPositions"],
    ["인천 역사정보", INCHEON_INDEX, "networkEdges"],
    ["인천 시각표", INCHEON_INDEX + 1, "transitStopTimes"],
    ["인천 편의시설", INCHEON_INDEX + 2, "facilities"],
  ]) {
    await context.test(`${labelKo} 편입의 addedRows를 오선언하면 거부된다`, async () => {
      await rejectsWith(
        (value) => { value.packDataInclusions[index].addedRows[table] += 1; },
        /pack data inclusion added rows do not match the spec declaration/,
      );
    });
  }

  // 수도권 광역철도 편입이 새로 만드는 표도 선언 대상이다.
  await context.test("수도권 광역철도 편입이 새 표를 선언하지 않으면 거부된다", async () => {
    await rejectsWith(
      (value) => { delete value.packDataInclusions[CAPITAL_INDEX].addedRows.coverageLineOperatorScopes; },
      /materialize-kric-capital-wide-rail-route-map-positions\.mjs pack data inclusion added rows do not match the spec declaration/,
    );
  });

  // 재정렬 선언은 선택 키이지만 선언과 실제가 갈리면 어느 방향으로도 fail closed 된다.
  // 서술 키는 선언 키와 함께 지운다 — 서술만 남기면 그 죽은 선언이 먼저 걸려 이 축에 닿지 못한다.
  await context.test("재정렬 선언을 빼면 승계 행 불변 대조가 거부한다", async () => {
    await rejectsWith(
      (value) => {
        delete value.packDataInclusions[CAPITAL_INDEX].reorderedTables;
        delete value.packDataInclusions[CAPITAL_INDEX].reorderedTablesKo;
      },
      /materialize-kric-capital-wide-rail-route-map-positions\.mjs pack data inclusion modified inherited rows: (lines|operators)/,
    );
  });

  await context.test("재정렬이 없는 표를 선언하면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[CAPITAL_INDEX].reorderedTables = ["lines", "operators", "stations"]; },
      /pack data inclusion declared a reordered table that stayed in order: stations/,
    );
  });

  await context.test("승계 pack에 없는 표를 재정렬 대상으로 선언하면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        value.packDataInclusions[CAPITAL_INDEX].reorderedTables =
          ["coverageLineOperatorScopes", "lines", "operators"];
      },
      /pack data inclusion declared a reordered table the inherited pack lacks: coverageLineOperatorScopes/,
    );
  });

  await context.test("재정렬 선언이 정렬돼 있지 않으면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[CAPITAL_INDEX].reorderedTables = ["operators", "lines"]; },
      /reorderedTables must be sorted by codepoint/,
    );
  });

  // 수도권 노선 선언도 장식이 아니다 — 저장소 카탈로그와 대조하지 않으면 틀린 노선 구성이 그대로 통과한다.
  await context.test("수도권 광역철도 편입의 노선 선언 순서가 카탈로그와 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const { lines } = value.packDataInclusions[CAPITAL_INDEX];
        value.packDataInclusions[CAPITAL_INDEX].lines = [lines[1], lines[0], ...lines.slice(2)];
      },
      /must be distinct tracked catalog lines in catalog order/,
    );
  });

  await context.test("대전 편입의 노선 선언이 admission 정본과 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[DAEJEON_INDEX].lines[0].lineId = "line-e57a361e8892"; },
      /lines must match the daejeon-station-distance-fare admission coverageScope lineIds/,
    );
  });

  await context.test("서울 편입의 노선 번호가 정본 순서와 다르면 거부된다", async () => {
    await rejectsWith(
      (value) => { value.packDataInclusions[CAPITAL_INDEX + 2].lines[0].lineNumber = 2; },
      /must declare Seoul line numbers 1 through 8 in admission order/,
    );
  });

  // 인천 편입의 노선 선언도 장식이 아니다. 결속 정본이 편입마다 다르다 — 역사정보·편의시설은 자기 소스의
  // admission coverageScope.lineIds에, 시각표는 collector 카탈로그(INCHEON_TIMETABLE_LINES)에 묶인다.
  for (const [labelKo, offset, expected] of [
    [
      "역사정보",
      0,
      /lines must match the incheon-transit-station-info admission coverageScope lineIds/,
    ],
    ["시각표", 1, /must declare every tracked Incheon timetable line/],
    [
      "편의시설",
      2,
      /lines must match the incheon-transit-accessibility admission coverageScope lineIds/,
    ],
  ]) {
    await context.test(`인천 ${labelKo} 편입의 노선 선언이 정본과 다르면 거부된다`, async () => {
      await rejectsWith(
        (value) => { value.packDataInclusions[0].lines[0].lineId = "line-e57a361e8892"; },
        expected,
        { solo: INCHEON_INDEX + offset },
      );
    });
  }

  // ── 선언된 non-transition 축(#2595 B3) ──────────────────────────────────────────────────────
  //
  // 이 축은 "선언한 lineId가 전환되지 않는다"를 사유와 함께 적게 해 소스가 덮는 노선 중 일부만 전환되는
  // 편입을 표현한다. 아래 축들이 그 선언으로 전환 범위가 넓어지지 않음을 고정한다.
  const nonTransitionEntryOf = (value) => {
    const redescription = value.lineScopeRedescriptions.find(
      ({ sourceId, sourceDomain }) =>
        sourceId === INCHEON_STATION_INFO_SOURCE_ID && sourceDomain === "route_graph_topology",
    );
    return { redescription, declaration: redescription.nonTransitioningRequirements[0] };
  };

  // 실제로 전환되는 키에 선언을 달면 거부된다 — 선언이 성공을 숨기는 데 쓰이면 안 된다.
  await context.test("실제로 전환되는 requirement에 non-transition 선언을 달면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        nonTransitionEntryOf(value).declaration.requirementKey =
          `capital:incheon-transit:${INCHEON_LINE1_ID}:route_graph_topology`;
      },
      new RegExp(
        "line-scope redescriptions must exactly match the actual required set"
          + "|requirements declared as non-transitioning must not be SUPPORTED after the line-scope redescription: "
          + `capital:incheon-transit:${INCHEON_LINE1_ID}:route_graph_topology`,
      ),
    );
  });

  await context.test("사유 코드가 없는 non-transition 선언은 거부된다", async () => {
    await rejectsWith(
      (value) => { delete nonTransitionEntryOf(value).declaration.reasonCode; },
      /nonTransitioningRequirements\[\]\.reasonCode is required/,
    );
  });

  await context.test("사유 서술이 빈 non-transition 선언은 거부된다", async () => {
    await rejectsWith(
      (value) => { nonTransitionEntryOf(value).declaration.reasonKo = "   "; },
      /nonTransitioningRequirements\[\]\.reasonKo is required/,
    );
  });

  await context.test("등재되지 않은 사유 코드는 거부된다", async () => {
    await rejectsWith(
      (value) => { nonTransitionEntryOf(value).declaration.reasonCode = "OUT_OF_SCOPE"; },
      /nonTransitioningRequirements\[\]\.reasonCode must be one of NO_SUPPORTING_ROWS_FOR_LINE/,
    );
  });

  // 선언하지 않은 키가 전환되지 않으면 기존 fail closed가 그대로 남는다 — 이 축이 이 배치의 전제다.
  await context.test("선언 없이 전환되지 않는 requirement가 남으면 거부된다", async () => {
    await rejectsWith(
      (value) => { delete nonTransitionEntryOf(value).redescription.nonTransitioningRequirements; },
      /line-scope redescriptions must exactly match the actual required set|line-scoped SUPPORTED requirements must equal baseline plus the spec redescription requirementKeys/,
    );
  });

  // 재기술이 declare하지 않은 requirement를 선언 대상으로 삼으면 이 축이 재기술 범위 밖까지 건드리게 된다.
  await context.test("재기술이 declare하지 않은 requirement는 선언 대상이 될 수 없다", async () => {
    await rejectsWith(
      (value) => {
        nonTransitionEntryOf(value).declaration.requirementKey =
          "daegu:daegu-transportation:line-5b8d9b05e7e6:route_graph_topology";
      },
      /nonTransitioningRequirements\[\]\.requirementKey must be one of the declared requirementKeys/,
    );
  });

  // 선언 단위는 (sourceId, sourceDomain, lineId)다. 도메인 전체·소스 전체·와일드카드를 가리키는 키는
  // 재기술이 declare한 requirement 목록 안에 있을 수 없으므로 그 포함 검사에서 그대로 걸린다.
  for (const [labelKo, requirementKey] of [
    ["와일드카드 노선", `capital:incheon-transit:*:route_graph_topology`],
    ["도메인 전체", "capital:incheon-transit:route_graph_topology"],
    ["소스 전체", "incheon-transit-station-info"],
  ]) {
    await context.test(`${labelKo}을(를) 가리키는 non-transition 선언은 거부된다`, async () => {
      await rejectsWith(
        (value) => { nonTransitionEntryOf(value).declaration.requirementKey = requirementKey; },
        /nonTransitioningRequirements\[\]\.requirementKey must be one of the declared requirementKeys/,
      );
    });
  }

  // 재기술 노선을 전부 선언하면 그 재기술은 아무것도 열지 않는다 — 등재의 뜻이 사라지므로 거부한다.
  // 판정 단위가 requirementKey 개수가 아니라 노선이라는 것도 이 축에 함께 걸려 있다.
  await context.test("재기술의 모든 노선을 선언하면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const { redescription } = nonTransitionEntryOf(value);
        redescription.nonTransitioningRequirements = redescription.requirementKeys
          .map((requirementKey) => ({
            requirementKey,
            reasonCode: "NO_SUPPORTING_ROWS_FOR_LINE",
            reasonKo: "전환 없음",
          }))
          .sort((left, right) => (left.requirementKey < right.requirementKey ? -1 : 1));
      },
      /must transition at least one redescribed line/,
    );
  });

  // B2-a 재기술도 B0 파일럿과 같은 축에 묶여 있다: spec만 고쳐서 전환 범위를 넓힐 수 없다.
  // snapshot 근거가 없는 노선을 spec 내부 정합을 맞춰 끼워 넣어도 admission 정본 결속이 막는다.
  await context.test("snapshot 근거가 없는 노선을 재기술에 끼워 넣으면 거부된다", async () => {
    await rejectsWith(
      (value) => {
        const entry = value.lineScopeRedescriptions.find(
          ({ sourceId }) => sourceId === "daegu-transportation-route-map-positions",
        );
        entry.lineIds = [...entry.lineIds, "line-8f7ed01f290a"];
        entry.requirementKeys = [
          ...entry.requirementKeys,
          "daegu:korail:line-8f7ed01f290a:route_map_positions",
        ];
      },
      /source inventory coverageScope\.lineIds must match the spec redescription/,
    );
  });
});

// 부산 편입 넷 중 노선도만 신선도 창에 상한이 없다 — admission 정본에 freshUntil이 없고 materializer도
// 하한(capturedAt 이후)만 검사한다. 하한 미만은 위 회귀가 fail closed로 고정하지만 상한 쪽에는 가드가
// 아예 없어 100년 뒤 pin도 조립을 완주하고 판정까지 그대로 낸다. 상한 도입은 materializer 쪽 판단이라
// 이 하네스가 동작으로 바꾸지 않고, 그 비대칭이 의도된 기록이라는 것을 성질 자체로 고정한다 — 나중에
// 상한이 생기면 이 단언이 깨져 spec·evidence 서술까지 함께 고치도록 강제한다.
test("부산 노선도 편입은 상한이 없어 먼 미래 기준 시각도 조립을 통과한다", async () => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);
  const { capturedAt, freshUntil } = admissionEvidenceOf(
    inventory,
    BUSAN_ROUTE_MAP_BINDING.sourceId,
    BUSAN_ROUTE_MAP_BINDING.evidenceKey,
  );
  assert.equal(freshUntil, undefined, "이 축은 노선도 정본에 상한이 없다는 전제 위에 있다");
  const farFuture = capturedAt.replace(/^\d{4}/, (year) => String(Number(year) + 100));
  const index = BUSAN_TOPOLOGY_INDEX + BUSAN_ROUTE_MAP_BINDING.offset;
  spec.packDataInclusions[index].materializedAt = farFuture;

  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-unbounded-"));
  try {
    const evidence = await runNationwideCandidateCoverageGate({
      spec,
      specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
      targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
      inventory,
      inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
      resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
      resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
      workDir: workspace,
    });
    assert.equal(evidence.packDataInclusions.entries[index].materializedAt, farFuture);
    // 조립만 통과하는 것이 아니라 전이 판정도 그대로다 — 상한 부재가 판정에 남기는 흔적이 없다.
    assert.deepEqual(
      evidence.transitions.map(({ requirementKey }) => requirementKey),
      [...ALL_TRANSITIONING_KEYS].sort(),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// 노선도 편입의 하한 회귀는 나머지 셋과 진단 특정성이 비대칭이다: 시각표·편의시설은 신선도 전용 문구
// (`evidence freshness is invalid`), topology는 stale snapshot 전용 문구를 내지만 노선도는 admission 정본
// 대조 축과 한 조건을 공유하는 문구를 낸다(BUSAN_INCLUSION_BINDINGS 주석 참조). 그래서 "거부됐다"만으로는
// 하한 위반이 원인인지 다른 축이 낸 문구인지 갈리지 않는다 — pin 1ms 차이의 대조로 원인을 좁힌다.
// tracked pin은 하한 정각이라 조립을 완주하고, 거기서 1ms만 내리면 같은 입력이 그 문구로 거부된다.
test("부산 노선도 편입의 창 하한 진단은 pin 1ms 대조로 원인이 특정된다", async () => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);
  const { capturedAt } = admissionEvidenceOf(
    inventory,
    BUSAN_ROUTE_MAP_BINDING.sourceId,
    BUSAN_ROUTE_MAP_BINDING.evidenceKey,
  );
  const index = BUSAN_TOPOLOGY_INDEX + BUSAN_ROUTE_MAP_BINDING.offset;
  // tracked pin이 하한 정각이라는 것부터 축이다 — 여기가 어긋나면 아래 1ms 대조가 하한을 때리지 않는다.
  assert.equal(spec.packDataInclusions[index].materializedAt, capturedAt, "tracked pin은 창 하한 정각이다");

  const runWithPin = async (materializedAt) => {
    const mutated = structuredClone(spec);
    mutated.packDataInclusions[index].materializedAt = materializedAt;
    const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-lower-bound-"));
    try {
      return await runNationwideCandidateCoverageGate({
        spec: mutated,
        specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
        targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
        inventory,
        inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
        resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
        resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
        workDir: workspace,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };

  // 하한 정각은 반개구간의 안쪽이다 — 이 실행이 통과해야 아래 거부가 "하한을 넘어서" 났다고 말할 수 있다.
  const evidence = await runWithPin(capturedAt);
  assert.equal(evidence.packDataInclusions.entries[index].materializedAt, capturedAt);
  await assert.rejects(
    runWithPin(new Date(Date.parse(capturedAt) - 1).toISOString()),
    BUSAN_ROUTE_MAP_BINDING.stalePinPattern,
  );
});

// 승계 행 불변 축은 행수가 그대로인 변조를 잡으므로 addedRows 대조가 대신 지켜 주지 못한다.
// 합성 pack으로 단언 자체를 직접 고정한다(append 정상 / 앞쪽 행 수정 / 승계 행 삭제).
test("승계 행 불변 단언은 append만 통과시키고 수정·삭제를 거부한다", () => {
  const inherited = {
    stations: [{ id: "a" }, { id: "b" }],
    networkEdges: [{ id: "e1" }],
    // 배열이 아닌 필드는 집계 축이 아니다.
    metadata: { activePack: "candidate" },
  };
  const snapshot = inheritedRowSnapshot(inherited);
  assert.deepEqual(Object.keys(snapshot.counts).sort(), ["networkEdges", "stations"]);
  assert.deepEqual(snapshot.counts, { stations: 2, networkEdges: 1 });

  assertInheritedRowsUnchanged("synthetic", snapshot, {
    ...inherited,
    stations: [...inherited.stations, { id: "appended" }],
    networkEdges: [...inherited.networkEdges, { id: "e2" }],
  });

  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [{ id: "a", nameKo: "변조" }, inherited.stations[1], { id: "appended" }],
    }),
    /synthetic pack data inclusion modified inherited rows: stations/,
  );

  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [inherited.stations[0]],
    }),
    /synthetic pack data inclusion dropped inherited rows: stations/,
  );
});

// #2595: 재정렬을 선언한 표만 위치 대신 다중집합으로 본다. 완화되는 것은 위치뿐이고 수정·삭제·중복도 변화는
// 그대로 fail closed여야 한다 — 그렇지 않으면 선언 한 줄로 승계 행 불변 축 자체가 꺼진다.
test("재정렬 선언은 위치만 풀고 승계 행의 수정·삭제·중복은 그대로 거부한다", () => {
  const inherited = {
    stations: [{ id: "a" }, { id: "b" }],
    networkEdges: [{ id: "e1" }],
  };
  const snapshot = inheritedRowSnapshot(inherited, ["stations"]);
  assert.deepEqual(snapshot.reorderedTables, ["stations"]);
  assert.deepEqual(Object.keys(snapshot.rowBags), ["stations"]);

  // 재정렬 + append는 통과한다.
  assertInheritedRowsUnchanged("synthetic", snapshot, {
    ...inherited,
    stations: [{ id: "appended" }, inherited.stations[1], inherited.stations[0]],
    networkEdges: [...inherited.networkEdges, { id: "e2" }],
  });

  // 위치만 바뀐 것이 아니라 내용이 바뀌면 다중집합이 갈린다.
  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [{ id: "b" }, { id: "a", nameKo: "변조" }, { id: "appended" }],
    }),
    /synthetic pack data inclusion modified inherited rows: stations/,
  );

  // 승계 행 하나를 다른 승계 행의 사본으로 바꾸면 행수는 그대로여도 중복도가 갈린다.
  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [{ id: "b" }, { id: "b" }],
    }),
    /synthetic pack data inclusion modified inherited rows: stations/,
  );

  // 반대 방향도 같은 축이다: 승계 행을 그대로 둔 채 사본을 하나 더 붙이면 중복도가 *는다*. 부분집합
  // 대조(승계 행이 남아 있기만 하면 통과)로는 이 방향이 그대로 지나가므로 정확 일치로 대조한다.
  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [{ id: "b" }, { id: "a" }, { id: "a" }],
    }),
    /synthetic pack data inclusion modified inherited rows: stations/,
  );

  // 선언하지 않은 표는 접두사 대조가 그대로 걸린다.
  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [{ id: "b" }, { id: "a" }],
      networkEdges: [{ id: "e2" }, { id: "e1" }],
    }),
    /synthetic pack data inclusion modified inherited rows: networkEdges/,
  );

  // 선언은 실측과 일치해야 한다 — 실제로 재정렬이 없었으면 그 선언은 접두사 대조를 근거 없이 끈 것이다.
  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", snapshot, {
      ...inherited,
      stations: [...inherited.stations, { id: "appended" }],
    }),
    /synthetic pack data inclusion declared a reordered table that stayed in order: stations/,
  );

  // 승계 pack에 없는 표를 선언하면 아무것도 완화하지 않는 죽은 선언이다.
  assert.throws(
    () => assertInheritedRowsUnchanged("synthetic", inheritedRowSnapshot(inherited, ["facilities"]), inherited),
    /synthetic pack data inclusion declared a reordered table the inherited pack lacks: facilities/,
  );
});

// #2595: 사유 코드마다 실측 술어가 하나씩 있어야 한다는 계약을 코드가 강제하는지 본다. 분기가 "관심 없는
// 코드는 continue"였을 때는 술어 없는 코드를 allowlist에 얹는 것만으로 그 선언이 무성 통과했다(실측) —
// 전수 switch로 바꿔 미처리 코드가 그 자리에서 fail closed 되는지 고정한다.
test("사유 술어가 없는 non-transition 코드는 무성 통과하지 않는다", () => {
  const requirementKey = "capital:incheon-transit:line-15b3b8a93259:route_graph_topology";
  const lineScoped = {
    pilotRequirements: [{ requirementKey, supportingRecordCountByField: { network_edges: 0 } }],
  };
  const declarationWith = (reasonCode) => new Map([
    [requirementKey, { requirementKey, reasonCode, reasonKo: "합성 선언" }],
  ]);

  // 술어가 있는 코드는 그대로 통과한다(전제 확인).
  assertNonTransitionReasons(declarationWith("NO_SUPPORTING_ROWS_FOR_LINE"), lineScoped);

  assert.throws(
    () => assertNonTransitionReasons(declarationWith("OWNER_DEFERRED"), lineScoped),
    /non-transition reason code has no harness predicate: OWNER_DEFERRED/,
  );
});

// 승계 pack의 배열 표 전체를 0으로 선언한 addedRows. 합성 편입은 행을 더하지 않으므로 addedRows 대조는
// 통과하고 회귀가 겨냥한 축만 걸린다.
async function zeroAddedRows() {
  const [inheritedPack] = (await readJson(REVIEWED_PACK_PATH)).packs;
  return Object.fromEntries(
    Object.entries(inheritedPack).filter(([, value]) => Array.isArray(value)).map(([table]) => [table, 0]),
  );
}

// 위 단위 축과 별개로, 조립 경로가 그 단언을 실제로 호출하는지를 고정한다(호출이 사라지면 이 회귀가 깨진다).
// PACK_DATA_MATERIALIZERS는 모듈 내부 상수라 spec 편집으로는 이 경로에 닿을 수 없어 in-process seam을 쓴다.
test("조립 경로는 승계 행을 변조하는 materializer를 거부한다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const materializerId = "test://mutates-inherited-rows";
  spec.packDataInclusions = [{
    regionId: "synthetic",
    materializer: materializerId,
    materializedAt: "2026-07-20T16:00:00.000Z",
    stationMapPath: "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
    lines: [{
      lineNumber: 1,
      lineId: "line-5b8d9b05e7e6",
      topologySnapshotPath: "tools/datapack/sources/daegu-line1-route-topology-20260721.json",
      timetableSnapshotPath: "tools/datapack/sources/daegu-line1-train-timetable-20260721.json",
    }],
    addedRows: await zeroAddedRows(),
  }];
  const materializers = new Map([[materializerId, {
    materialize: (fixture) => {
      const mutated = structuredClone(fixture);
      mutated.packs[0].stations[0].nameKo = "변조";
      return mutated;
    },
    inputs: { paths: ["stationMapPath"], linePaths: ["topologySnapshotPath", "timetableSnapshotPath"] },
  }]]);

  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-inherited-"));
  try {
    await assert.rejects(
      runNationwideCandidateCoverageGate({
        spec,
        specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
        targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
        inventory,
        inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
        resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
        resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
        workDir: workspace,
        materializers,
      }),
      // 편입 정체성 라벨은 (regionId, materializer)다 — 같은 지역을 여러 도메인으로 체인하면
      // regionId만으로는 어느 편입이 걸렸는지 알 수 없다.
      /synthetic:test:\/\/mutates-inherited-rows pack data inclusion modified inherited rows: stations/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// 아래 두 회귀도 in-process seam으로 항목을 넘긴다(allowlist는 모듈 내부 상수라 spec 편집으로 닿을 수 없다).
// 공통 실행부와 합성 편입 레코드만 묶고, 항목 형상·materializer 동작은 회귀마다 다르게 준다.
const SEAM_INPUTS = { paths: ["stationMapPath"], linePaths: ["topologySnapshotPath"] };

async function runWithMaterializers(spec, inventory, materializers) {
  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-seam-"));
  try {
    return await runNationwideCandidateCoverageGate({
      spec,
      specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
      targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
      inventory,
      inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
      resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
      resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
      workDir: workspace,
      materializers,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function seamInclusion(materializer, addedRows) {
  return {
    regionId: "synthetic",
    materializer,
    materializedAt: "2026-07-20T16:00:00.000Z",
    stationMapPath: "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
    lines: [{
      lineNumber: 1,
      lineId: "line-5b8d9b05e7e6",
      topologySnapshotPath: "tools/datapack/sources/daegu-line1-route-topology-20260721.json",
    }],
    addedRows,
  };
}

// 단일 편입 회귀는 승계 원본(capital pack) 행만 태운다. 체인에서는 앞 편입이 실은 행도 뒤 편입의 불변
// 대상이므로, 1번째가 append한 행을 2번째가 in-place로 변조하는 2단 케이스를 따로 고정한다
// (행수는 그대로라 addedRows 대조는 통과하고 승계 행 불변 축만 걸린다).
test("조립 경로는 앞 편입이 실은 행을 뒤 편입이 변조하면 거부한다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const zeroRows = await zeroAddedRows();
  const appendId = "test://appends-station-row";
  const mutateId = "test://mutates-chained-row";
  spec.packDataInclusions = [
    seamInclusion(appendId, { ...zeroRows, stations: 1 }),
    seamInclusion(mutateId, zeroRows),
  ];
  const materializers = new Map([
    [appendId, {
      materialize: (fixture) => {
        const mutated = structuredClone(fixture);
        mutated.packs[0].stations.push({
          ...mutated.packs[0].stations[0],
          id: "station-synthetic-chained",
        });
        return mutated;
      },
      inputs: SEAM_INPUTS,
    }],
    [mutateId, {
      materialize: (fixture) => {
        const mutated = structuredClone(fixture);
        // 승계 원본 행이 아니라 직전 편입이 append한 마지막 행을 건드린다.
        mutated.packs[0].stations.at(-1).nameKo = "변조";
        return mutated;
      },
      inputs: SEAM_INPUTS,
    }],
  ]);

  await assert.rejects(
    runWithMaterializers(spec, inventory, materializers),
    /synthetic:test:\/\/mutates-chained-row pack data inclusion modified inherited rows: stations/,
  );
});

// 등재 항목의 형상 자체가 깨지면(inputs 결측·형 오류) 무검사 구조분해는 TypeError로 터져 진단이
// "무엇이 잘못됐나" 대신 스택으로 붕괴한다 — 형상 검사가 그 자리를 대신 잡는지 본다.
test("allowlist 항목의 inputs 형상이 깨지면 진단 가능한 오류로 거부된다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const zeroRows = await zeroAddedRows();
  const keep = (fixture) => fixture;

  spec.packDataInclusions = [seamInclusion("test://missing-inputs", zeroRows)];
  await assert.rejects(
    runWithMaterializers(spec, inventory, new Map([["test://missing-inputs", { materialize: keep }]])),
    /pack data materializer inputs shape is invalid: test:\/\/missing-inputs/,
  );

  spec.packDataInclusions = [seamInclusion("test://broken-inputs", zeroRows)];
  await assert.rejects(
    runWithMaterializers(spec, inventory, new Map([["test://broken-inputs", {
      materialize: keep,
      inputs: { paths: "stationMapPath", linePaths: ["topologySnapshotPath"] },
    }]])),
    /pack data materializer inputs shape is invalid: test:\/\/broken-inputs/,
  );
});

// 형상 검사가 잡는 것은 형상 자체가 깨진 경우뿐이다. 형상이 성립하면서 어댑터가 실제로 읽는 키보다 좁으면
// spec 검사가 그 키를 요구하지 않아 결측 값이 readTracked까지 들어온다 — fail closed는 유지되지만 진단이
// path.resolve TypeError로 붕괴했다(실측). 결측을 spec 검사와 같은 형식으로 되돌리는지 본다.
test("등재 형상이 어댑터 read보다 좁으면 결측 입력을 진단 가능한 오류로 거부한다", async () => {
  const spec = structuredClone(await readJson(SPEC_PATH));
  const inventory = await readJson(INVENTORY_PATH);
  const materializerId = "test://narrow-input-shape";
  const inclusion = seamInclusion(materializerId, await zeroAddedRows());
  // 등재 형상에 없는 키는 그 자체로 거부되므로 spec 쪽 선언도 함께 지운다.
  delete inclusion.stationMapPath;
  spec.packDataInclusions = [inclusion];

  await assert.rejects(
    runWithMaterializers(spec, inventory, new Map([[materializerId, {
      materialize: async (fixture, entry, { readTracked }) => {
        await readTracked(entry.stationMapPath, "stationMapPath");
        return fixture;
      },
      inputs: { paths: [], linePaths: ["topologySnapshotPath"] },
    }]])),
    /synthetic:test:\/\/narrow-input-shape\.stationMapPath is required/,
  );
});

test("production 게시 트랙 fixture는 candidate 조립에 영향받지 않는다", async () => {
  const spec = await readJson(SPEC_PATH);
  const reviewed = await readJson(REVIEWED_PACK_PATH);
  const [pack] = reviewed.packs;

  assert.equal(reviewed.packs.length, 1);
  assert.equal(pack.id, "capital");
  assert.equal(pack.version, "1");
  assert.equal(pack.artifactKind, "production");
  assert.equal(reviewed.manifest.channel, "production");
  assert.deepEqual(reviewed.manifest.activePack, { id: "capital", version: "1" });
  assert.notEqual(spec.pack.id, pack.id);
  assert.notEqual(spec.pack.url, pack.url);
  // 게시 fixture의 coverageScope 기술 자체는 여기서 못박지 않는다. #2510 로드맵의 최종 목표가 게시 팩의
  // line-scope화이므로 operator-scope를 영구 계약으로 고정하면 정상 진행과 충돌한다. 게시 동작 불변은
  // candidate 조립이 게시 정체성(id·version·url·channel·activePack)을 건드리지 않는다는 위 행위 단언과
  // datapack/release 계약 테스트로 유지한다.
});

test("누락된 재기술은 emit fixture를 남기지 않고 거부된다", async () => {
  const spec = await readJson(SPEC_PATH);
  const inventory = await readJson(INVENTORY_PATH);
  spec.lineScopeRedescriptions = spec.lineScopeRedescriptions.filter(
    ({ sourceId, sourceDomain }) =>
      sourceId !== "busan-transportation-timetable" || sourceDomain !== "schedule_timetable",
  );
  const workspace = await mkdtemp(path.join(tmpdir(), "nationwide-candidate-gate-no-emit-"));
  const emitFixturePath = path.join("tmp", `nationwide-candidate-gate-no-emit-${process.pid}.json`);
  const emittedPath = path.join(root, emitFixturePath);
  await rm(emittedPath, { force: true });
  try {
    await assert.rejects(
      runNationwideCandidateCoverageGate({
        spec,
        specInput: { path: SPEC_PATH, sha256: "a".repeat(64) },
        targetsInput: { path: TARGETS_PATH, sha256: "b".repeat(64) },
        inventory,
        inventoryInput: { path: INVENTORY_PATH, sha256: "c".repeat(64) },
        resolutionPlanInput: { path: RESOLUTION_PLAN_PATH, sha256: "d".repeat(64) },
        resolutionsInput: { path: RESOLUTIONS_PATH, sha256: "e".repeat(64) },
        workDir: workspace,
        emitFixturePath,
      }),
      /line-scope redescriptions must exactly match the actual required set/,
    );
    await assert.rejects(readFile(emittedPath), { code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(emittedPath, { force: true });
  }
});

function lineScopeExactMatchFixture(sourceId, sourceDomain, releaseTier = "LAUNCH_REQUIRED") {
  const requirementKey = `region:operator:line:${sourceDomain}`;
  const coverageScope = {
    lineIds: ["line"], sourceDomains: [sourceDomain], regionIds: ["region"], operatorIds: ["operator"],
  };
  return {
    spec: {
      lineScopeRedescriptions: [{ sourceId, sourceDomain, lineIds: ["line"], requirementKeys: [requirementKey] }],
    },
    pack: {
      sourceInventory: [{ id: sourceId, coverageScope: { ...coverageScope, lineIds: undefined } }],
    },
    inheritedPack: { sourceInventory: [] },
    inventory: { sources: [{ id: sourceId, coverageScope }] },
    targets: {
      requiredSourceDomains: [{ id: sourceDomain, releaseTier }],
      activeLineScopes: [{ regionId: "region", operatorId: "operator", lineId: "line" }],
    },
  };
}

const OMITTED_LINE_SCOPE_CASES = Object.freeze([
  { sourceId: "busan-transportation-timetable", sourceDomain: "schedule_timetable" },
  { sourceId: "busan-transportation-route-map-positions", sourceDomain: "route_map_positions" },
  { sourceId: "busan-transportation-accessibility", sourceDomain: "accessibility_facilities" },
  { sourceId: "daegu-transportation-accessibility", sourceDomain: "accessibility_facilities" },
]);

test("omission 회귀 대상은 tracked candidate spec에 선언돼 있다", async () => {
  const { lineScopeRedescriptions } = await readJson(SPEC_PATH);
  for (const { sourceId, sourceDomain } of OMITTED_LINE_SCOPE_CASES) {
    assert.ok(
      lineScopeRedescriptions.some(
        (entry) => entry.sourceId === sourceId && entry.sourceDomain === sourceDomain,
      ),
      `${sourceId}/${sourceDomain}`,
    );
  }
});

for (const { sourceId, sourceDomain } of OMITTED_LINE_SCOPE_CASES) {
  test(`${sourceId}/${sourceDomain} omission은 actual line-scope set에서 거부된다`, () => {
    const fixture = lineScopeExactMatchFixture(sourceId, sourceDomain);
    fixture.spec.lineScopeRedescriptions = [];
    assert.throws(
      () => assertLineScopeRedescriptionsMatchActualRequiredSet(fixture.spec, fixture.pack, fixture.inventory, fixture.targets),
      /line-scope redescriptions must exactly match the actual required set/,
    );
  });
}

test("actual line-scope 선언은 source/domain, lineIds, requirementKeys가 정확히 일치해야 한다", () => {
  const valid = lineScopeExactMatchFixture("source", "schedule_timetable");
  assert.doesNotThrow(() => assertLineScopeRedescriptionsMatchActualRequiredSet(
    valid.spec, valid.pack, valid.inventory, valid.targets,
  ));

  for (const [label, mutate, expected] of [
    [
      "추가",
      (fixture) => fixture.spec.lineScopeRedescriptions.push({
        sourceId: "extra", sourceDomain: "schedule_timetable", lineIds: ["line"], requirementKeys: [],
      }),
      /line-scope redescriptions must exactly match the actual required set/,
    ],
    [
      "중복",
      (fixture) => fixture.spec.lineScopeRedescriptions.push(structuredClone(fixture.spec.lineScopeRedescriptions[0])),
      /duplicate declared line-scope source\/domain/,
    ],
    [
      "lineIds 불일치",
      (fixture) => { fixture.spec.lineScopeRedescriptions[0].lineIds = ["other-line"]; },
      /line-scope redescriptions must exactly match the actual required set/,
    ],
    [
      "requirementKeys 불일치",
      (fixture) => { fixture.spec.lineScopeRedescriptions[0].requirementKeys = []; },
      /line-scope redescriptions must exactly match the actual required set/,
    ],
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.throws(
      () => assertLineScopeRedescriptionsMatchActualRequiredSet(
        fixture.spec, fixture.pack, fixture.inventory, fixture.targets,
      ),
      expected,
      label,
    );
  }
});

test("inactive scope와 LAUNCH_REQUIRED가 아닌 domain은 actual line-scope set에서 제외한다", () => {
  const inactive = lineScopeExactMatchFixture("inactive", "schedule_timetable");
  inactive.spec.lineScopeRedescriptions = [];
  inactive.targets.activeLineScopes = [];
  assert.doesNotThrow(() => assertLineScopeRedescriptionsMatchActualRequiredSet(
    inactive.spec, inactive.pack, inactive.inventory, inactive.targets,
  ));

  const enhancement = lineScopeExactMatchFixture("enhancement", "schedule_timetable", "ENHANCEMENT");
  assert.doesNotThrow(() => assertLineScopeRedescriptionsMatchActualRequiredSet(
    enhancement.spec, enhancement.pack, enhancement.inventory, enhancement.targets,
  ));
});

test("승계 pack에 이미 있던 line scope는 신규 재기술 대상으로 세지 않는다", () => {
  const fixture = lineScopeExactMatchFixture("inherited", "schedule_timetable");
  fixture.spec.lineScopeRedescriptions = [];
  fixture.pack.sourceInventory[0].coverageScope = structuredClone(
    fixture.inventory.sources[0].coverageScope,
  );
  fixture.inheritedPack.sourceInventory = structuredClone(fixture.pack.sourceInventory);

  assert.doesNotThrow(() => assertLineScopeRedescriptionsMatchActualRequiredSet(
    fixture.spec, fixture.pack, fixture.inventory, fixture.targets, fixture.inheritedPack,
  ));

  fixture.inheritedPack.sourceInventory[0].coverageScope.lineIds = ["other-line"];
  assert.throws(
    () => assertLineScopeRedescriptionsMatchActualRequiredSet(
      fixture.spec, fixture.pack, fixture.inventory, fixture.targets, fixture.inheritedPack,
    ),
    /inherited candidate pack coverageScope\.lineIds must match candidate pack and source inventory/,
  );
});

test("pack-only lineIds와 inventory 누락 lineIds는 fail closed다", () => {
  const coverageScope = {
    lineIds: ["line"], sourceDomains: ["schedule_timetable"], regionIds: ["region"], operatorIds: ["operator"],
  };
  assert.throws(
    () => assertLineScopeRedescriptionsMatchActualRequiredSet(
      { lineScopeRedescriptions: [] },
      { sourceInventory: [{ id: "pack-only", coverageScope }] },
      { sources: [{ id: "pack-only", coverageScope: { ...coverageScope, lineIds: [] } }] },
      {
        requiredSourceDomains: [{ id: "schedule_timetable", releaseTier: "LAUNCH_REQUIRED" }],
        activeLineScopes: [{ regionId: "region", operatorId: "operator", lineId: "line" }],
      },
    ),
    /candidate pack coverageScope\.lineIds must match source inventory: pack-only/,
  );
});
