#!/usr/bin/env node
// #2514 (#2510 B0) 전국 candidate pack 게이트 하네스. #2549 (#2510 B1)에서 지역 데이터 편입으로 확장하고,
// #2580 (#2510 B2-a)에서 편입 스키마를 다도메인 체인으로 일반화했으며, #2587 (#2510 B2-b)에서 그 스키마로
// 두 번째 지역(부산 4노선 5도메인)을 편입했다. #2595 (#2510 B3)에서 대전·광주 5도메인과 수도권 노선도
// 14소스·인천 4소스를 같은 스키마로 올리면서 축 둘을 더했다: 편입이 재정렬하는 표를 명시 선언하는
// reorderedTables와, 재기술이 선언한 requirement 중 이 배치에서 열리지 않는 것을 사유와 함께 명시 선언하는
// nonTransitioningRequirements다. 뒤 축은 "소스가 덮는 노선 중 일부만 전환되는 편입"을 표현하기 위한
// 것이며(인천 역사정보 소스의 7호선 route_graph_topology), 선언이 전환 범위를 넓히지는 못한다.
//
// candidate spec → candidate fixture 조립 → build-datapack.mjs --fixture → report-coverage-gaps.mjs
// 실행을 한 명령으로 묶고, line-scope 재기술 전(baseline)/후(lineScoped) 두 variant를 같은 실행에서
// 돌려 MISSING → SUPPORTED 전이를 결정적 evidence로 남긴다.
//
// 왜 candidate가 root 단일 pack인가:
//   report-coverage-gaps.mjs의 판정 대상은 manifest의 required root pack(emergencyOverride + activePack
//   /default)뿐이고 각 root pack이 단독으로 coverage 계약을 만족해야 한다. 지역 pack을 병렬로 나열해도
//   provenance가 합산되지 않으므로 candidate는 root가 되는 단일 pack으로 조립한다.
//
// 왜 지역 데이터를 fixture로 복제하지 않고 materializer로 싣나 (#2549 B1):
//   승계 원본(capital production pack)에는 수도권 밖 행이 없다. 대구 9 requirement를 판정에 올리려면
//   candidate root pack이 그 행들을 담아야 한다. 이미 admission이 끝난 snapshot을 tracked materializer로
//   재생해 조립하면 78k stop_time을 저장소에 복제하지 않고도 같은 바이트가 언제든 재현된다 — B0의
//   "참조로 승계하고 복제하지 않는다" 원칙을 지역 편입으로 그대로 확장한 것이다. spec이 가리킬 수 있는
//   materializer는 allowlist(PACK_DATA_MATERIALIZERS)뿐이고 입력은 전부 저장소 안 tracked 경로다.
//
// 왜 두 variant를 한 실행에서 돌리나:
//   before/after를 서로 다른 커밋에서 손으로 뽑으면 재현이 불가능하다. baseline variant는 재기술 대상
//   소스의 coverageScope.lineIds를 fixture와 inventory 사본에서 함께 지워 재기술 이전 상태를 복원한다.
//   같은 tracked 입력에서 before/after가 함께 나오므로 evidence가 언제든 재생성된다.
//
// 서명 키:
//   게이트는 root pack의 field provenance artifactKind가 production일 때만 coverage를 인정하고,
//   production pack 서명은 RSA 개인키를 요구한다. 하네스는 실행마다 임시 RSA-2048 키쌍을 만들어
//   자식 프로세스 env로만 주입한다 — 저장소·CI에 서명 비밀이 필요 없고 키가 디스크에 남지 않는다.
//
// 결정성:
//   임시 키로 만든 manifest·pack 서명과 그 서명이 들어간 manifest sha256, 그리고 런타임 SQLite 구현에
//   좌우되는 sqliteSha256은 evidence에 기록하지 않는다. resolutions 만료(nextReviewAt)는 게이트가
//   wall-clock으로 판정하므로 그 영향을 받는 EXPLICITLY_UNSUPPORTED·MISSING 집계도 기록하지 않는다.
//   기록 축은 SUPPORTED 판정과 분모뿐이며 이 축은 오프라인·키 없이 바이트 단위로 재현된다.
//
// 사용:
//   node tools/datapack/run-nationwide-candidate-coverage-gate.mjs \
//     --spec tools/datapack/nationwide-candidate-pack-spec.json \
//     --targets tools/datapack/nationwide-coverage-targets.json \
//     --inventory tools/datapack/source-inventory.json \
//     --resolution-plan tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json \
//     --resolutions tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json \
//     --output tools/datapack/reports/nationwide-candidate-coverage-gate.json
//
// 선택 인자:
//   --work-dir       중간 산출물(조립 fixture·빌드 결과·원본 게이트 리포트) 보존 경로. 생략하면 임시
//                    디렉터리를 쓰고 실행 후 지운다.
//   --emit-fixture   조립된 lineScoped candidate fixture를 이 경로에 남긴다(수동 재현·검수용).
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import {
  parseMolitDaeguStationMappings,
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { BUSAN_LINES } from "./collect-busan-route-topology.mjs";
import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
import { INCHEON_TIMETABLE_LINES } from "./collect-incheon-timetable.mjs";
import {
  listCapitalLightRailRouteMapPositionLines,
} from "./collect-kric-capital-light-rail-route-map-positions.mjs";
import {
  listCapitalWideRailRouteMapPositionLines,
} from "./collect-kric-capital-wide-rail-route-map-positions.mjs";
import { parseArgs, requireArg, sortJson } from "./lib/ledger-admission-cli.mjs";
import { materializeBusanAccessibility } from "./materialize-busan-accessibility.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import {
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaeguAccessibility } from "./materialize-daegu-accessibility.mjs";
import { materializeDaeguRouteMapPositions } from "./materialize-daegu-route-map-positions.mjs";
import { materializeDaeguTimetable } from "./materialize-daegu-timetable.mjs";
import { materializeDaejeonAccessibility } from "./materialize-daejeon-accessibility.mjs";
import { materializeDaejeonRouteMapPositions } from "./materialize-daejeon-route-map-positions.mjs";
import { DAEJEON_LINES } from "./materialize-daejeon-route-topology.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuAccessibility } from "./materialize-gwangju-accessibility.mjs";
import { materializeGwangjuRouteMapPositions } from "./materialize-gwangju-route-map-positions.mjs";
import { GWANGJU_LINES, materializeGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import { materializeIncheonAccessibility } from "./materialize-incheon-accessibility.mjs";
import { INCHEON_STATION_LINES, materializeIncheonStationInfo } from "./materialize-incheon-station-info.mjs";
import { materializeIncheonTimetable } from "./materialize-incheon-timetable.mjs";
import {
  materializeCapitalLightRailRouteMapPositions,
} from "./materialize-kric-capital-light-rail-route-map-positions.mjs";
import {
  materializeCapitalWideRailRouteMapPositions,
} from "./materialize-kric-capital-wide-rail-route-map-positions.mjs";
import { materializeSeoulRouteMapPositions } from "./materialize-seoul-route-map-positions.mjs";
import {
  materializeSeoul9Phase1RouteMapPositions,
} from "./materialize-seoul9-phase1-route-map-positions.mjs";
import { SEOUL9_LINES, materializeSeoul9RouteMapPositions } from "./materialize-seoul9-route-map-positions.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

// 재생성 명령에 기록하는 tracked evidence 경로. --output이 임시 경로여도 산출 바이트가 달라지지 않도록
// 명령 문자열은 이 상수를 쓴다(재현성 검증이 임시 출력으로 가능해야 한다).
export const EVIDENCE_PATH = "tools/datapack/reports/nationwide-candidate-coverage-gate.json";
const TOOL_PATH = "tools/datapack/run-nationwide-candidate-coverage-gate.mjs";
const BUILDER_PATH = "tools/datapack/build-datapack.mjs";
const GATE_PATH = "tools/datapack/report-coverage-gaps.mjs";
const ALLOWED_FLAGS = new Set([
  "spec",
  "targets",
  "inventory",
  "resolution-plan",
  "resolutions",
  "output",
  "work-dir",
  "emit-fixture",
]);
const SPEC_ARTIFACT_KIND = "nationwide-candidate-pack-spec";
const CANDIDATE_ARTIFACT_KIND = "production";
const CANDIDATE_MANIFEST_CHANNEL = "candidate";
// 예약 TLD(.invalid, RFC 2606)라 어떤 게시 경로에서도 해석되지 않는다.
const NON_PUBLISHABLE_HOST = "easysubway-datapack-candidate.invalid";
const SIGNING_MODE = "EPHEMERAL_RSA_2048";
// spec이 가리킬 수 있는 지역 데이터 materializer 목록. spec 편집만으로 임의 모듈을 실행시킬 수 없다.
// 항목마다 어댑터와 입력 형상을 함께 등재한다(#2580) — materializer가 실제로 읽는 경로 키만 spec에
// 요구해야 한 지역에 여러 도메인 편입을 체인할 수 있다. 형상을 하네스 전역에 하나로 못박으면 대구
// 시각표 한 건의 형상이 다른 도메인·지역 편입을 표현 불가능하게 만든다.
const PACK_DATA_MATERIALIZERS = new Map([
  ["tools/datapack/materialize-daegu-timetable.mjs", {
    materialize: materializeDaeguTimetableInclusion,
    inputs: { paths: ["stationMapPath"], linePaths: ["topologySnapshotPath", "timetableSnapshotPath"] },
  }],
  ["tools/datapack/materialize-daegu-route-map-positions.mjs", {
    materialize: materializeDaeguRouteMapInclusion,
    inputs: { paths: ["snapshotPath"], linePaths: ["topologySnapshotPath"] },
  }],
  ["tools/datapack/materialize-daegu-accessibility.mjs", {
    materialize: materializeDaeguAccessibilityInclusion,
    inputs: { paths: ["snapshotPath"], linePaths: ["topologySnapshotPath"] },
  }],
  // 부산 편입 4종(#2587). 부산 topology snapshot은 4노선을 한 파일에 담으므로 대구와 달리 노선별 경로가
  // 없고 편입 층 경로 키만 쓴다 — 등재 형상이 어댑터가 실제로 읽는 키와 정확히 같아야 한다는 규약 그대로다.
  ["tools/datapack/materialize-busan-route-topology.mjs", {
    materialize: materializeBusanRouteTopologyInclusion,
    inputs: { paths: ["snapshotPath", "stationMapPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-busan-timetable.mjs", {
    materialize: materializeBusanTimetableInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-busan-route-map-positions.mjs", {
    materialize: materializeBusanRouteMapInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-busan-accessibility.mjs", {
    materialize: materializeBusanAccessibilityInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  // 대전·광주 편입 3종씩(#2595). 두 지역 모두 topology 전용 materializer가 편입 단위가 아니다 —
  // 시각표 materializer가 topology·membership·시각표를 한 번에 싣는다(대전은 내부에서
  // materializeDaejeonRouteTopology를 호출하고, 광주는 한 함수가 세 소스를 함께 등재한다). 그래서
  // 지역마다 편입은 시각표·노선도·편의시설 3건이고 도메인은 5개다.
  ["tools/datapack/materialize-daejeon-timetable.mjs", {
    materialize: materializeDaejeonTimetableInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath", "stationMapPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-daejeon-route-map-positions.mjs", {
    materialize: materializeDaejeonRouteMapInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-daejeon-accessibility.mjs", {
    materialize: materializeDaejeonAccessibilityInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-gwangju-timetable.mjs", {
    materialize: materializeGwangjuTimetableInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath", "stationMapPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-gwangju-route-map-positions.mjs", {
    materialize: materializeGwangjuRouteMapInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-gwangju-accessibility.mjs", {
    materialize: materializeGwangjuAccessibilityInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  // 수도권 노선도 다섯 편입 중 셋(#2595). KRIC 광역·경전철 materializer는 소스(=노선) 하나만 처리하므로
  // 편입 하나가 노선별 snapshot을 노선 층 경로 키로 받아 카탈로그 순서대로 체인한다 — 대구 시각표가
  // 노선별 snapshot을 받는 형상과 같다. 앞의 두 편입은 승계 pack에 의존하지 않는다: topology를
  // inventory 소스가 아니라 tracked snapshot 파일로만 대조하고 역·역노선을 스스로 만든다. 서울 1~8호선
  // 편입은 다르다 — 승계 원본의 서울교통공사 운영기관과 capital pilot cyberstation 소스 등재를 선행
  // 조건으로 검사하고 승계 routeMapPositions의 (역, 노선, 권역) PK 집합으로 중복을 거른다. 다만 그 셋은
  // 전부 승계 원본이 이미 갖고 있어 다른 편입에 대한 순서 의존은 없다.
  ["tools/datapack/materialize-kric-capital-wide-rail-route-map-positions.mjs", {
    materialize: materializeCapitalWideRailRouteMapInclusion,
    inputs: { paths: ["topologySnapshotPath"], linePaths: ["snapshotPath"] },
  }],
  ["tools/datapack/materialize-kric-capital-light-rail-route-map-positions.mjs", {
    materialize: materializeCapitalLightRailRouteMapInclusion,
    inputs: { paths: ["topologySnapshotPath"], linePaths: ["snapshotPath"] },
  }],
  ["tools/datapack/materialize-seoul-route-map-positions.mjs", {
    materialize: materializeSeoulRouteMapInclusion,
    inputs: { paths: ["snapshotPath"], linePaths: [] },
  }],
  // 수도권 9호선 편입 2종(#2595). 노선 하나를 두 소스가 나눠 덮는다(1단계 25역 / 2·3단계 13역)라
  // 편입도 소스마다 하나씩이며, 두 소스의 admission 창 하한이 서로 달라(05:00Z / 04:00Z) pin도 갈린다.
  // 두 materializer 모두 승계 pack 의존이 없다 — 경로 그래프 계보를 tracked snapshot 파일로 대조하고
  // 운영기관·노선·역·역노선을 스스로 만든다.
  ["tools/datapack/materialize-seoul9-phase1-route-map-positions.mjs", {
    materialize: materializeSeoul9Phase1RouteMapInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-seoul9-route-map-positions.mjs", {
    materialize: materializeSeoul9RouteMapInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
  // 인천 편입 3종(#2595). 승계 원본에 인천 운영기관·노선·역이 아예 없어 역사정보 편입이 그 셋을 함께
  // 싣고, 시각표·편의시설 편입이 그 소스 등재와 station_lines 계보를 선행 조건으로 검사한다(부산과 같은
  // 모양). 시각표 편입만 노선 층 경로 키를 쓴다 — 인천 시각표 snapshot이 노선마다 따로 있기 때문이다.
  ["tools/datapack/materialize-incheon-station-info.mjs", {
    materialize: materializeIncheonStationInfoInclusion,
    inputs: { paths: ["snapshotPath"], linePaths: [] },
  }],
  ["tools/datapack/materialize-incheon-timetable.mjs", {
    materialize: materializeIncheonTimetableInclusion,
    inputs: { paths: ["topologySnapshotPath"], linePaths: ["snapshotPath"] },
  }],
  ["tools/datapack/materialize-incheon-accessibility.mjs", {
    materialize: materializeIncheonAccessibilityInclusion,
    inputs: { paths: ["snapshotPath", "topologySnapshotPath"], linePaths: [] },
  }],
]);
// 부산 편입이 admission 정본을 찾을 때 쓰는 소스 id. 네 편입 모두 상수로 두어 문자열이 어댑터마다
// 인라인으로 흩어지지 않게 한다.
const BUSAN_TOPOLOGY_SOURCE_ID = "busan-transportation-route-topology";
const BUSAN_TIMETABLE_SOURCE_ID = "busan-transportation-timetable";
const BUSAN_ROUTE_MAP_SOURCE_ID = "busan-transportation-route-map-positions";
const BUSAN_ACCESSIBILITY_SOURCE_ID = "busan-transportation-accessibility";
// 대전·광주 편입이 admission 정본을 찾을 때 쓰는 소스 id(#2595).
const DAEJEON_TOPOLOGY_SOURCE_ID = "daejeon-station-distance-fare";
const DAEJEON_TIMETABLE_SOURCE_ID = "daejeon-train-timetable";
const DAEJEON_ROUTE_MAP_SOURCE_ID = "daejeon-transportation-route-map-positions";
const DAEJEON_ACCESSIBILITY_SOURCE_ID = "daejeon-transportation-accessibility";
const GWANGJU_TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const GWANGJU_TIMETABLE_SOURCE_ID = "gwangju-transportation-cyberstation-timetable";
const GWANGJU_ROUTE_MAP_SOURCE_ID = "gwangju-transportation-route-map-positions";
const GWANGJU_ACCESSIBILITY_SOURCE_ID = "gwangju-transportation-accessibility";
const SEOUL_ROUTE_MAP_SOURCE_ID = "seoul-metro-route-map-positions";
// 수도권 9호선·인천 편입이 admission 정본을 찾을 때 쓰는 소스 id(#2595).
const SEOUL9_PHASE1_ROUTE_MAP_SOURCE_ID = "kric-seoul-metro-line9-1-route-map-positions";
const SEOUL9_PHASE23_ROUTE_MAP_SOURCE_ID = "seoul-metro-line9-23-route-map-positions";
const INCHEON_STATION_INFO_SOURCE_ID = "incheon-transit-station-info";
const INCHEON_ACCESSIBILITY_SOURCE_ID = "incheon-transit-accessibility";
// 형상과 무관하게 모든 편입 레코드가 갖는 키. 나머지 허용 키는 등재 형상의 경로 키와 아래 서술 키뿐이다.
// reorderedTables는 선택 키다 — 선언한 편입에만 재정렬 허용이 열리고, 선언과 실제가 갈리면 fail closed 된다.
const INCLUSION_BASE_KEYS = Object.freeze(["regionId", "materializer", "materializedAt", "lines", "addedRows"]);
const INCLUSION_OPTIONAL_KEYS = Object.freeze(["reorderedTables"]);
const INCLUSION_LINE_BASE_KEYS = Object.freeze(["lineNumber", "lineId"]);
// lineNumber 생략이 열리는 편입. 이 두 카탈로그가 싣는 노선(경의중앙·경춘·수인분당·경강·공항철도·
// 서해·GTX-A·의정부·신분당·에버라인·우이신설·신림·김포골드)에는 숫자 노선명이 아예 없어 선언할 값이
// 없다 — 없는 번호를 지어내면 선언이 거짓이 되므로 이 두 편입만 키를 생략하고, 오히려 선언하면 거부한다.
// 나머지 편입의 노선은 전부 번호가 있어(9호선·인천 1·2호선·수도권 7호선 포함) 키를 요구한다.
const LINE_NUMBER_OPTIONAL_MATERIALIZERS = Object.freeze([
  "tools/datapack/materialize-kric-capital-wide-rail-route-map-positions.mjs",
  "tools/datapack/materialize-kric-capital-light-rail-route-map-positions.mjs",
]);
// 편입 레코드에 허용하는 서술 키. "*Ko 접미사면 통과"로 열어 두면 snapshotPathKo 같은 죽은 선언이 그대로
// 통과해(실측) 선언과 실제 결속이 갈린 채 무성으로 남는다 — 실제로 쓰는 키만 명시로 연다.
const INCLUSION_NARRATIVE_KEYS = Object.freeze([
  "reasonKo",
  "materializedAtReasonKo",
  "addedRowsKo",
  "reorderedTablesKo",
]);
// 선언된 non-transition 레코드에 허용하는 키(#2595).
const NON_TRANSITION_KEYS = Object.freeze(["requirementKey", "reasonCode", "reasonKo"]);
// 선언된 non-transition의 사유 코드. 코드마다 하네스가 실측으로 확인하는 술어가 하나씩 있어야 한다 —
// 확인할 수 없는 사유를 자유 서술로 받으면 그 선언은 "왜 안 열리는가"를 감사할 수 없는 주장이 된다.
// NO_SUPPORTING_ROWS_FOR_LINE: 조립 결과의 그 scope provenance 행이 필드마다 0건임을 확인한다.
const NON_TRANSITION_REASON_CODES = Object.freeze(["NO_SUPPORTING_ROWS_FOR_LINE"]);

export async function runNationwideCandidateCoverageGate({
  spec,
  specInput,
  targetsInput,
  inventory,
  inventoryInput,
  resolutionPlanInput,
  resolutionsInput,
  workDir,
  emitFixturePath = null,
  // 조립 계약(승계 행 불변·선언 행수)을 회귀에서 직접 때리기 위한 in-process seam이다. CLI는 넘기지
  // 않으므로 기본 allowlist가 그대로 적용되고, spec은 이 맵에 항목을 추가할 수 없다 — "spec 편집만으로
  // 임의 모듈을 실행시킬 수 없다"는 성질은 그대로다.
  materializers = PACK_DATA_MATERIALIZERS,
}) {
  validateSpec(spec, materializers);
  assertInventoryLineScopeSync(spec, inventory);
  // 승계 원본도 입력 해시 축에 넣는다. 경로·pack 정체성만 기록하면 원본 좌표 같은 값 drift가
  // evidence를 바이트 동일하게 통과시킨다(구조 drift만 잡히는 상태) — 파일 바이트로 결속한다.
  const inheritedInput = await readJsonInput(spec.inheritsFrom.path);
  const inherited = inheritedInput.document;
  // 지역 데이터 편입은 두 variant가 공유한다. line-scope 재기술은 소스 기술만 바꾸므로 편입 결과가
  // variant마다 달라질 수 없고, 한 번만 조립해 두 실행이 같은 행 바이트를 쓰는 것을 구조로 보장한다.
  const inclusions = await applyPackDataInclusions(spec, inherited, inventory, materializers);
  const targets = (await readJsonInput(targetsInput.path)).document;
  assertLineScopeRedescriptionsMatchActualRequiredSet(
    spec,
    inclusions.pack,
    inventory,
    targets,
    inclusions.inheritedPack,
  );

  const signing = ephemeralSigningKeys();
  const variants = {};
  const reports = {};
  for (const lineScoped of [false, true]) {
    const variant = lineScoped ? "lineScoped" : "baseline";
    const variantDir = path.join(workDir, variant);
    await mkdir(variantDir, { recursive: true });

    const fixture = materializeCandidateFixture(spec, inclusions.pack, { lineScoped });
    const fixturePath = path.join(variantDir, "nationwide-candidate-pack.json");
    await writeJson(fixturePath, fixture);
    if (lineScoped && emitFixturePath) {
      await writeJson(path.resolve(root, emitFixturePath), fixture);
    }

    // baseline은 재기술 이전 상태를 복원해야 하므로 inventory 사본에서도 같은 lineIds를 지운다.
    // lineScoped는 tracked inventory를 그대로 읽어 evidence가 커밋된 정본에 직접 묶이게 한다.
    const inventoryPath = lineScoped
      ? path.resolve(root, inventoryInput.path)
      : path.join(variantDir, "source-inventory.json");
    if (!lineScoped) {
      await writeJson(inventoryPath, withoutLineScopeRedescriptions(spec, inventory));
    }

    const buildDir = path.join(variantDir, "build");
    await execFileAsync(process.execPath, [
      path.join(root, BUILDER_PATH),
      "--fixture", fixturePath,
      "--output", buildDir,
    ], { cwd: root, env: { ...process.env, ...signing.env } });

    const reportPath = path.join(variantDir, "coverage-gap-report.json");
    await execFileAsync(process.execPath, [
      path.join(root, GATE_PATH),
      "--targets", path.resolve(root, targetsInput.path),
      "--inventory", inventoryPath,
      "--manifest", path.join(buildDir, "current.json"),
      "--provenance", path.join(buildDir, "current.provenance.json"),
      "--resolution-plan", path.resolve(root, resolutionPlanInput.path),
      "--resolutions", path.resolve(root, resolutionsInput.path),
      "--output", reportPath,
      // 전국 gap은 아직 남아 있으므로 게이트를 리포트 모드로 돌린다(게시 차단 판정은 이 하네스의 축이 아니다).
      "--allow-gaps",
    ], { cwd: root });

    reports[variant] = JSON.parse(await readFile(reportPath, "utf8"));
    const provenance = JSON.parse(await readFile(path.join(buildDir, "current.provenance.json"), "utf8"));
    variants[variant] = summarizeVariant(spec, reports[variant], provenance);
  }

  return buildEvidence({
    spec,
    inputs: {
      spec: specInput,
      targets: targetsInput,
      inventory: inventoryInput,
      resolutionPlan: resolutionPlanInput,
      resolutions: resolutionsInput,
      inheritedPack: inheritedInput.input,
    },
    packDataInclusions: inclusions.records,
    reports,
    variants,
    signing,
  });
}

// 승계 pack에 지역 데이터를 싣는다. 승계 원본(production 트랙 파일)은 읽기만 하고, 편입은 tracked
// materializer가 tracked snapshot을 재생하는 방식으로만 이뤄진다.
async function applyPackDataInclusions(spec, inherited, inventory, materializers) {
  const inheritedPack = (inherited.packs ?? []).find(
    (pack) => pack.id === spec.inheritsFrom.packId && pack.version === spec.inheritsFrom.packVersion,
  );
  if (!inheritedPack) {
    throw new Error(
      `inherited pack is missing: ${spec.inheritsFrom.packId}@${spec.inheritsFrom.packVersion}`,
    );
  }
  let fixture = {
    manifest: structuredClone(inherited.manifest ?? {}),
    packs: [structuredClone(inheritedPack)],
  };
  const records = [];
  for (const inclusion of spec.packDataInclusions ?? []) {
    const entry = materializers.get(inclusion.materializer);
    if (!entry) throw new Error(`unknown pack data materializer: ${inclusion.materializer}`);
    const inputs = new Map();
    const label = inclusionLabel(inclusion);
    // 경로 키 이름을 함께 넘긴다 — 등재 형상이 어댑터가 실제로 읽는 키보다 좁으면 결측 값이 여기까지
    // 들어오는데, 그때 진단이 spec 검사와 같은 "<편입>.<키> is required" 형식으로 나와야 한다.
    const readTracked = (relativePath, key) => readTrackedBytes(relativePath, inputs, `${label}.${key}`);
    // 승계 스냅샷을 편입마다 다시 뜬다 — 체인의 n번째 편입에게 직전 편입 결과가 곧 승계 원본이므로
    // 앞선 편입이 실은 행도 뒤 편입의 불변 대상이 된다.
    const inheritedSnapshot = inheritedRowSnapshot(fixture.packs[0], inclusion.reorderedTables ?? []);
    fixture = await entry.materialize(fixture, inclusion, { readTracked, inventory });
    if (!Array.isArray(fixture?.packs) || fixture.packs.length !== 1) {
      throw new Error(`${inclusion.materializer} must keep the candidate pack single`);
    }
    const addedRows = subtractRowCounts(packRowCounts(fixture.packs[0]), inheritedSnapshot.counts);
    assertDeclaredRows(inclusion, addedRows);
    assertInheritedRowsUnchanged(label, inheritedSnapshot, fixture.packs[0]);
    records.push({
      regionId: inclusion.regionId,
      materializer: inclusion.materializer,
      materializedAt: inclusion.materializedAt,
      addedRows,
      // 재정렬 허용은 선언한 편입에만 열리므로 evidence에도 선언한 편입에만 남긴다.
      ...(inclusion.reorderedTables ? { reorderedTables: [...inclusion.reorderedTables] } : {}),
      inputs: [...inputs.values()].sort((left, right) => codepointCompare(left.path, right.path)),
    });
  }
  return { pack: fixture.packs[0], inheritedPack, records };
}

// 대구 1·2·3호선 노선 선언 대조와 topology snapshot 로딩. 세 대구 어댑터가 공유한다.
// 노선 구성(lineNumber·lineId)은 저장소 정본(DAEGU_LINES)과 대조해 spec 선언이 데이터와 갈리면 fail closed 한다.
async function daeguTopologySnapshots(inclusion, readTracked) {
  const declaredLines = inclusion.lines;
  if (declaredLines.length !== DAEGU_LINES.length) {
    throw new Error("daegu pack data inclusion must declare every tracked Daegu line");
  }
  const topologySnapshots = {};
  for (const [index, line] of declaredLines.entries()) {
    const config = DAEGU_LINES[index];
    if (line.lineNumber !== config.lineNumber || line.lineId !== config.lineId) {
      throw new Error(`daegu pack data inclusion line ${index} does not match the tracked line config`);
    }
    topologySnapshots[config.lineNumber] = parseJsonBytes(
      await readTracked(line.topologySnapshotPath, "lines[].topologySnapshotPath"),
      line.topologySnapshotPath,
    );
  }
  return topologySnapshots;
}

// 대구 시각표 편입 어댑터. snapshot·역명 매핑 경로는 spec이 선언하고 이 어댑터가 tracked 경로로만 읽는다.
//
// materializedAt은 snapshot 포착 시각대에 고정한다. materializer의 freshness 판정이 wall-clock을 쓰면
// 같은 tracked 입력에서 오늘 되는 조립이 내일 깨져 evidence 재현이 불가능해진다. 임의 시각을 넣어도
// materializer가 [capturedAt, freshUntil) 밖이면 fail closed 하므로 이 pin은 snapshot에 묶여 있다.
// 창은 소스마다 다르므로 pin도 편입마다 따로 둔다.
async function materializeDaeguTimetableInclusion(fixture, inclusion, { readTracked, inventory }) {
  const topologySnapshots = await daeguTopologySnapshots(inclusion, readTracked);
  const stationMapBytes = await readTracked(inclusion.stationMapPath, "stationMapPath");
  const timetableSnapshots = {};
  const canonicalStationMappings = {};
  for (const [index, line] of inclusion.lines.entries()) {
    const config = DAEGU_LINES[index];
    timetableSnapshots[config.lineNumber] = parseJsonBytes(
      await readTracked(line.timetableSnapshotPath, "lines[].timetableSnapshotPath"),
      line.timetableSnapshotPath,
    );
    canonicalStationMappings[config.lineNumber] = parseMolitDaeguStationMappings(stationMapBytes, config.lineName);
  }
  return materializeDaeguTimetable({
    baseFixture: fixture,
    topologySnapshots,
    timetableSnapshots,
    inventory,
    canonicalStationMappings,
    now: new Date(inclusion.materializedAt),
  });
}

// 대구 노선도 좌표 편입 어댑터(#2580). materializer가 snapshot 바이트 정체성(snapshotSha256)을 admission
// 정본과 대조하므로 하네스가 evidence에 남기는 입력 해시와 같은 바이트가 판정 근거가 된다. 다만 바이트
// 축만으로는 저장소 안 다른 경로에 둔 바이트 동일 사본을 가리켜도 통과한다(실측) — 편의시설 편입과 같이
// 정본 snapshotPath에도 결속해 두 편입의 결속 축을 경로·바이트 양방향으로 맞춘다.
async function materializeDaeguRouteMapInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertAdmissionSnapshotPath(
    inventory,
    "daegu-transportation-route-map-positions",
    "routeMapAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshots = await daeguTopologySnapshots(inclusion, readTracked);
  const snapshotBytes = await readTracked(inclusion.snapshotPath, "snapshotPath");
  return materializeDaeguRouteMapPositions({
    baseFixture: fixture,
    snapshot: parseJsonBytes(snapshotBytes, inclusion.snapshotPath),
    snapshotSha256: sha256Hex(snapshotBytes),
    topologySnapshots,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 대구 교통약자 편의시설 편입 어댑터(#2580).
//
// accessibility 정본에는 바이트 축이 아예 없다 — rawSha256·rowsSha256은 snapshot 내용에서 파생돼 재직렬화
// 사본도 같은 값을 낸다(실측: 사본이 그대로 조립을 통과했다). materializer에 검사 지점이 없으므로 하네스가
// 편입이 읽는 경로를 admission 정본의 snapshotPath에 결속한다(노선도 편입과 같은 축). 그 경로에서 실제로
// 읽은 바이트 해시는 evidence inputs에 남으므로, 정본 경로 파일 자체가 재직렬화되면 evidence 바이트 재생성
// 회귀가 잡는다.
async function materializeDaeguAccessibilityInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertAdmissionSnapshotPath(
    inventory,
    "daegu-transportation-accessibility",
    "accessibilityAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshots = await daeguTopologySnapshots(inclusion, readTracked);
  return materializeDaeguAccessibility({
    baseFixture: fixture,
    accessibilitySnapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    topologySnapshots,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 부산 편입 4종이 공유하는 노선 선언 대조. 노선 구성(lineNumber·lineId)은 저장소 정본(BUSAN_LINES)과
// 대조해 spec 선언이 데이터와 갈리면 fail closed 한다 — 대조가 없으면 lines 선언이 죽은 채로 통과한다.
function assertBusanLines(inclusion) {
  const declared = inclusion.lines;
  if (declared.length !== BUSAN_LINES.length
    || declared.some((line, index) => line.lineNumber !== BUSAN_LINES[index].lineNumber
      || line.lineId !== BUSAN_LINES[index].lineId)) {
    throw new Error(`${inclusionLabel(inclusion)} pack data inclusion must declare every tracked Busan line`);
  }
}

// 부산 시각표·노선도·편의시설 편입이 공유하는 topology snapshot 로딩. 세 materializer는 topology 계보를
// contentSha256으로 대조하는데 그 해시는 snapshot 내용에서 파생돼 재직렬화 사본도 같은 값을 낸다 —
// 경로도 admission 정본에 결속해 편입이 읽는 파일을 정본 하나로 못박는다.
async function busanTopologySnapshot(inclusion, readTracked, inventory) {
  assertAdmissionSnapshotPath(
    inventory,
    BUSAN_TOPOLOGY_SOURCE_ID,
    "topologyAdmissionEvidence",
    inclusion.topologySnapshotPath,
  );
  return parseJsonBytes(
    await readTracked(inclusion.topologySnapshotPath, "topologySnapshotPath"),
    inclusion.topologySnapshotPath,
  );
}

// 부산 topology 편입 어댑터(#2587). 체인의 첫 부산 편입이며 운영기관·노선·역·구간을 함께 싣는다.
// 나머지 세 부산 편입은 이 편입이 실은 소스 등재·station_lines·network_edges를 선행 조건으로 검사하므로
// 순서를 바꾸면 조립이 fail closed 된다.
async function materializeBusanRouteTopologyInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertBusanLines(inclusion);
  assertAdmissionSnapshotPath(
    inventory,
    BUSAN_TOPOLOGY_SOURCE_ID,
    "topologyAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const stationMapBytes = await readTracked(inclusion.stationMapPath, "stationMapPath");
  return materializeBusanRouteTopology({
    baseFixture: fixture,
    snapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(stationMapBytes.toString("utf8")),
    now: new Date(inclusion.materializedAt),
  });
}

// 부산 시각표 편입 어댑터(#2587).
async function materializeBusanTimetableInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertBusanLines(inclusion);
  assertAdmissionSnapshotPath(
    inventory,
    BUSAN_TIMETABLE_SOURCE_ID,
    "scheduleAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await busanTopologySnapshot(inclusion, readTracked, inventory);
  return materializeBusanTimetable({
    baseFixture: fixture,
    timetableSnapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    topologySnapshot,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 부산 노선도 좌표 편입 어댑터(#2587). materializer가 snapshot 바이트 정체성(snapshotSha256)을 admission
// 정본과 대조하지만 바이트 축만으로는 저장소 안 바이트 동일 사본도 통과한다 — 대구 편입과 같이 정본
// snapshotPath에도 결속한다.
async function materializeBusanRouteMapInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertBusanLines(inclusion);
  assertAdmissionSnapshotPath(
    inventory,
    BUSAN_ROUTE_MAP_SOURCE_ID,
    "routeMapAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await busanTopologySnapshot(inclusion, readTracked, inventory);
  const snapshotBytes = await readTracked(inclusion.snapshotPath, "snapshotPath");
  return materializeBusanRouteMapPositions({
    baseFixture: fixture,
    snapshot: parseJsonBytes(snapshotBytes, inclusion.snapshotPath),
    snapshotSha256: sha256Hex(snapshotBytes),
    topologySnapshot,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 부산 교통약자 편의시설 편입 어댑터(#2587). 대구 편의시설과 같이 정본에 바이트 축이 없어(rawSha256·
// rowsSha256이 snapshot 내용에서 파생된다) 경로 결속이 유일한 정체성 축이다.
async function materializeBusanAccessibilityInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertBusanLines(inclusion);
  assertAdmissionSnapshotPath(
    inventory,
    BUSAN_ACCESSIBILITY_SOURCE_ID,
    "accessibilityAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await busanTopologySnapshot(inclusion, readTracked, inventory);
  return materializeBusanAccessibility({
    baseFixture: fixture,
    accessibilitySnapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    topologySnapshot,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 선언한 노선 번호를 저장소 정본과 대조한다. lineId의 대조 상대는 admission 정본(coverageScope.lineIds)
// 이지만 그 정본에는 번호 축이 아예 없다 — 번호를 요구하면서 대조 상대를 두지 않으면 선언만 늘고 확인이
// 없는 축이 되므로, 그 노선을 소유하는 materializer 모듈의 정본 표와 (번호, lineId) 쌍째로 맞춘다.
function assertDeclaredLineNumbers(inclusion, canonicalLines) {
  const declared = inclusion.lines.map(({ lineNumber, lineId }) => ({ lineNumber, lineId }));
  const canonical = canonicalLines.map(({ lineNumber, lineId }) => ({ lineNumber, lineId }));
  if (JSON.stringify(declared) !== JSON.stringify(canonical)) {
    throw new Error(
      `${inclusionLabel(inclusion)} pack data inclusion lines must match the tracked line numbers: `
        + `expected ${JSON.stringify(canonical)}, got ${JSON.stringify(declared)}`,
    );
  }
}

// 대전·광주·수도권 편입이 공유하는 노선 선언 대조(#2595). 이 세 지역에는 대구 DAEGU_LINES·부산
// BUSAN_LINES 같은 collector 상수가 없어 저장소 정본을 admission 정본(source-inventory)의
// coverageScope.lineIds로 잡는다 — 재기술 등재가 이미 같은 정본에 결속돼 있으므로(assertInventoryLineScopeSync)
// 편입 선언과 재기술 선언이 한 정본을 함께 가리키게 된다.
function assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, sourceId) {
  const declared = inclusion.lines.map(({ lineId }) => lineId);
  const admitted = inventory?.sources?.find(({ id }) => id === sourceId)?.coverageScope?.lineIds;
  if (!Array.isArray(admitted) || JSON.stringify(declared) !== JSON.stringify(admitted)) {
    throw new Error(
      `${inclusionLabel(inclusion)} pack data inclusion lines must match the ${sourceId} admission coverageScope lineIds: `
        + `expected ${JSON.stringify(admitted)}, got ${JSON.stringify(declared)}`,
    );
  }
}

// 대전 편입 3종이 공유하는 topology snapshot 로딩. 세 materializer는 topology 계보를 contentSha256으로
// 대조하는데 그 해시는 snapshot 내용에서 파생돼 재직렬화 사본도 같은 값을 낸다 — 부산과 같이 경로도
// admission 정본에 결속한다.
async function daejeonTopologySnapshot(inclusion, readTracked, inventory) {
  assertAdmissionSnapshotPath(
    inventory,
    DAEJEON_TOPOLOGY_SOURCE_ID,
    "topologyAdmissionEvidence",
    inclusion.topologySnapshotPath,
  );
  return parseJsonBytes(
    await readTracked(inclusion.topologySnapshotPath, "topologySnapshotPath"),
    inclusion.topologySnapshotPath,
  );
}

// 대전 시각표 편입 어댑터(#2595). 이 편입 하나가 topology·membership·시각표를 함께 싣는다 —
// materializeDaejeonTimetable이 내부에서 materializeDaejeonRouteTopology를 호출해 운영기관·노선·역·
// 역노선·구간을 먼저 만들고 그 위에 시각표를 얹기 때문이다. 따라서 대전 구간에서 이 편입이 항상 먼저다.
async function materializeDaejeonTimetableInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, DAEJEON_TOPOLOGY_SOURCE_ID);
  assertDeclaredLineNumbers(inclusion, DAEJEON_LINES);
  assertAdmissionSnapshotPath(
    inventory,
    DAEJEON_TIMETABLE_SOURCE_ID,
    "scheduleAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await daejeonTopologySnapshot(inclusion, readTracked, inventory);
  const stationMapBytes = await readTracked(inclusion.stationMapPath, "stationMapPath");
  return materializeDaejeonTimetable({
    baseFixture: fixture,
    timetableSnapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    topologySnapshot,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(stationMapBytes),
    now: new Date(inclusion.materializedAt),
  });
}

// 대전 노선도 좌표 편입 어댑터(#2595). materializer가 snapshot 바이트 정체성(snapshotSha256)을 admission
// 정본과 대조하지만 바이트 축만으로는 저장소 안 바이트 동일 사본도 통과한다 — 정본 snapshotPath에도 결속한다.
async function materializeDaejeonRouteMapInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, DAEJEON_ROUTE_MAP_SOURCE_ID);
  assertDeclaredLineNumbers(inclusion, DAEJEON_LINES);
  assertAdmissionSnapshotPath(
    inventory,
    DAEJEON_ROUTE_MAP_SOURCE_ID,
    "routeMapAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await daejeonTopologySnapshot(inclusion, readTracked, inventory);
  const snapshotBytes = await readTracked(inclusion.snapshotPath, "snapshotPath");
  return materializeDaejeonRouteMapPositions({
    baseFixture: fixture,
    snapshot: parseJsonBytes(snapshotBytes, inclusion.snapshotPath),
    snapshotSha256: sha256Hex(snapshotBytes),
    topologySnapshot,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 대전 교통약자 편의시설 편입 어댑터(#2595). 대구·부산 편의시설과 같이 정본에 바이트 축이 없어
// (rawSha256·rowsSha256이 snapshot 내용에서 파생된다) 경로 결속이 유일한 정체성 축이다.
async function materializeDaejeonAccessibilityInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, DAEJEON_ACCESSIBILITY_SOURCE_ID);
  assertDeclaredLineNumbers(inclusion, DAEJEON_LINES);
  assertAdmissionSnapshotPath(
    inventory,
    DAEJEON_ACCESSIBILITY_SOURCE_ID,
    "accessibilityAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await daejeonTopologySnapshot(inclusion, readTracked, inventory);
  return materializeDaejeonAccessibility({
    baseFixture: fixture,
    accessibilitySnapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    topologySnapshot,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 광주 편입 3종이 공유하는 topology snapshot 로딩(대전과 같은 축).
async function gwangjuTopologySnapshot(inclusion, readTracked, inventory) {
  assertAdmissionSnapshotPath(
    inventory,
    GWANGJU_TOPOLOGY_SOURCE_ID,
    "topologyAdmissionEvidence",
    inclusion.topologySnapshotPath,
  );
  return parseJsonBytes(
    await readTracked(inclusion.topologySnapshotPath, "topologySnapshotPath"),
    inclusion.topologySnapshotPath,
  );
}

// 광주 시각표 편입 어댑터(#2595). 대전과 달리 materializer가 다른 materializer를 호출하는 것이 아니라
// 한 함수가 topology·membership·시각표 소스 셋을 함께 등재하고 역·역노선·구간·시각표를 한 번에 싣는다.
// 결과는 같다 — 광주 구간에서 이 편입이 항상 먼저다.
async function materializeGwangjuTimetableInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, GWANGJU_TOPOLOGY_SOURCE_ID);
  assertDeclaredLineNumbers(inclusion, GWANGJU_LINES);
  assertAdmissionSnapshotPath(
    inventory,
    GWANGJU_TIMETABLE_SOURCE_ID,
    "scheduleAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await gwangjuTopologySnapshot(inclusion, readTracked, inventory);
  const stationMapBytes = await readTracked(inclusion.stationMapPath, "stationMapPath");
  return materializeGwangjuTimetable({
    baseFixture: fixture,
    timetableSnapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    topologySnapshot,
    inventory,
    canonicalStationMappings: parseMolitGwangjuStationMappings(stationMapBytes),
    now: new Date(inclusion.materializedAt),
  });
}

// 광주 노선도 좌표 편입 어댑터(#2595).
async function materializeGwangjuRouteMapInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, GWANGJU_ROUTE_MAP_SOURCE_ID);
  assertDeclaredLineNumbers(inclusion, GWANGJU_LINES);
  assertAdmissionSnapshotPath(
    inventory,
    GWANGJU_ROUTE_MAP_SOURCE_ID,
    "routeMapAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await gwangjuTopologySnapshot(inclusion, readTracked, inventory);
  const snapshotBytes = await readTracked(inclusion.snapshotPath, "snapshotPath");
  return materializeGwangjuRouteMapPositions({
    baseFixture: fixture,
    snapshot: parseJsonBytes(snapshotBytes, inclusion.snapshotPath),
    snapshotSha256: sha256Hex(snapshotBytes),
    topologySnapshot,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 광주 교통약자 편의시설 편입 어댑터(#2595).
async function materializeGwangjuAccessibilityInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, GWANGJU_ACCESSIBILITY_SOURCE_ID);
  assertDeclaredLineNumbers(inclusion, GWANGJU_LINES);
  assertAdmissionSnapshotPath(
    inventory,
    GWANGJU_ACCESSIBILITY_SOURCE_ID,
    "accessibilityAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await gwangjuTopologySnapshot(inclusion, readTracked, inventory);
  return materializeGwangjuAccessibility({
    baseFixture: fixture,
    accessibilitySnapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    topologySnapshot,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 수도권 KRIC 노선도 편입 2종(광역·경전철)이 공유하는 체인 어댑터(#2595).
//
// 두 materializer는 소스(=노선) 하나만 처리하므로 편입 하나가 카탈로그 순서대로 노선별 snapshot을 체인한다.
// 노선 선언은 collector 카탈로그(저장소 정본)와 대조하고, 노선별 snapshotPath는 그 노선 소스의 admission
// 정본 경로에 결속한다 — materializer는 snapshotSha256(바이트)까지 보지만 바이트 축만으로는 저장소 안
// 바이트 동일 사본이 통과한다.
//
// topologySnapshotPath는 결이 다르다: capital-route-topology는 inventory 소스가 아니라 tracked snapshot
// 파일로만 존재해 admission 정본에 snapshotPath 항목 자체가 없다. 대신 노선도 정본이 선언한
// topologySnapshotId에서 저장소 경로 규약(tools/datapack/sources/<snapshotId>.json)으로 경로를 유도해
// 결속한다 — materializer는 contentSha256만 대조하므로(재직렬화 사본도 통과) 경로 축을 여기서 더한다.
async function materializeCapitalRailRouteMapInclusion(fixture, inclusion, { readTracked, inventory }, {
  catalog,
  materialize,
}) {
  const catalogByLineId = new Map(catalog.map((line) => [line.lineId, line]));
  const catalogOrder = catalog.map(({ lineId }) => lineId);
  const declared = inclusion.lines.map(({ lineId }) => lineId);
  if (new Set(declared).size !== declared.length
    || declared.some((lineId) => !catalogByLineId.has(lineId))
    || JSON.stringify(declared) !== JSON.stringify(catalogOrder.filter((lineId) => declared.includes(lineId)))) {
    throw new Error(
      `${inclusionLabel(inclusion)} pack data inclusion lines must be distinct tracked catalog lines in catalog order`,
    );
  }
  const topologySnapshotPath = assertAdmissionTopologySnapshotPath(
    inventory,
    catalogByLineId.get(declared[0]).sourceId,
    inclusion.topologySnapshotPath,
  );
  const topologySnapshot = parseJsonBytes(
    await readTracked(topologySnapshotPath, "topologySnapshotPath"),
    topologySnapshotPath,
  );
  let chained = fixture;
  for (const line of inclusion.lines) {
    const { sourceId } = catalogByLineId.get(line.lineId);
    // 노선마다 자기 소스의 정본 경로에 결속한다 — 편입 하나가 여러 소스를 싣더라도 결속은 소스 단위다.
    assertAdmissionSnapshotPath(inventory, sourceId, "routeMapAdmissionEvidence", line.snapshotPath);
    assertAdmissionTopologySnapshotPath(inventory, sourceId, inclusion.topologySnapshotPath);
    const snapshotBytes = await readTracked(line.snapshotPath, "lines[].snapshotPath");
    chained = materialize({
      baseFixture: chained,
      snapshot: parseJsonBytes(snapshotBytes, line.snapshotPath),
      snapshotSha256: sha256Hex(snapshotBytes),
      topologySnapshot,
      inventory,
      now: new Date(inclusion.materializedAt),
    });
  }
  return chained;
}

async function materializeCapitalWideRailRouteMapInclusion(fixture, inclusion, context) {
  return materializeCapitalRailRouteMapInclusion(fixture, inclusion, context, {
    catalog: listCapitalWideRailRouteMapPositionLines(),
    materialize: materializeCapitalWideRailRouteMapPositions,
  });
}

async function materializeCapitalLightRailRouteMapInclusion(fixture, inclusion, context) {
  return materializeCapitalRailRouteMapInclusion(fixture, inclusion, context, {
    catalog: listCapitalLightRailRouteMapPositionLines(),
    materialize: materializeCapitalLightRailRouteMapPositions,
  });
}

// 서울교통공사 1~8호선 노선도 좌표 편입 어댑터(#2595). 노선 선언은 admission 정본의 lineIds와 대조하고,
// lineNumber는 그 정본이 1호선부터 8호선 순으로 기술된다는 사실(실측)에 결속한다.
async function materializeSeoulRouteMapInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, SEOUL_ROUTE_MAP_SOURCE_ID);
  if (inclusion.lines.some((line, index) => line.lineNumber !== index + 1)) {
    throw new Error(
      `${inclusionLabel(inclusion)} pack data inclusion lines must declare Seoul line numbers 1 through `
        + `${inclusion.lines.length} in admission order`,
    );
  }
  assertAdmissionSnapshotPath(
    inventory,
    SEOUL_ROUTE_MAP_SOURCE_ID,
    "routeMapAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const snapshotBytes = await readTracked(inclusion.snapshotPath, "snapshotPath");
  return materializeSeoulRouteMapPositions({
    baseFixture: fixture,
    snapshot: parseJsonBytes(snapshotBytes, inclusion.snapshotPath),
    snapshotSha256: sha256Hex(snapshotBytes),
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 수도권 9호선 편입 2종이 공유하는 어댑터(#2595). 두 materializer는 소스 하나·노선 하나를 처리하므로
// 노선 선언을 admission 정본의 lineIds와 대조하고, snapshotPath와 topologySnapshotPath를 각각 그 소스의
// 정본 경로·정본이 선언한 topologySnapshotId 경로에 결속한다. 광역·경전철 편입과 같은 축이며, 다른 점은
// 두 소스가 같은 노선을 나눠 덮어 편입이 노선 층 경로 키를 쓰지 않는다는 것뿐이다.
async function materializeSeoul9RouteMapInclusionFor(fixture, inclusion, { readTracked, inventory }, {
  sourceId,
  materialize,
}) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, sourceId);
  assertDeclaredLineNumbers(inclusion, SEOUL9_LINES);
  assertAdmissionSnapshotPath(inventory, sourceId, "routeMapAdmissionEvidence", inclusion.snapshotPath);
  const topologySnapshotPath = assertAdmissionTopologySnapshotPath(
    inventory,
    sourceId,
    inclusion.topologySnapshotPath,
  );
  const snapshotBytes = await readTracked(inclusion.snapshotPath, "snapshotPath");
  return materialize({
    baseFixture: fixture,
    snapshot: parseJsonBytes(snapshotBytes, inclusion.snapshotPath),
    snapshotSha256: sha256Hex(snapshotBytes),
    topologySnapshot: parseJsonBytes(
      await readTracked(topologySnapshotPath, "topologySnapshotPath"),
      topologySnapshotPath,
    ),
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

async function materializeSeoul9Phase1RouteMapInclusion(fixture, inclusion, context) {
  return materializeSeoul9RouteMapInclusionFor(fixture, inclusion, context, {
    sourceId: SEOUL9_PHASE1_ROUTE_MAP_SOURCE_ID,
    materialize: materializeSeoul9Phase1RouteMapPositions,
  });
}

async function materializeSeoul9RouteMapInclusion(fixture, inclusion, context) {
  return materializeSeoul9RouteMapInclusionFor(fixture, inclusion, context, {
    sourceId: SEOUL9_PHASE23_ROUTE_MAP_SOURCE_ID,
    materialize: materializeSeoul9RouteMapPositions,
  });
}

// 인천 편입 3종이 공유하는 topology snapshot 로딩(#2595).
//
// 함정: 시각표 materializer는 topology snapshot의 snapshotId를 대조하는데 tracked snapshot 파일에는 그
// 키가 아예 없다 — CLI가 basename에서 파생해 주입한다(runIncheonTimetableMaterializer). 편입 어댑터도
// 같은 주입을 하지 않으면 tracked 정본을 그대로 읽고도 `invalid Incheon topology snapshot`으로 막힌다.
// 주입값은 지어낸 값이 아니라 경로에서 파생한 것이고, 그 경로 자체가 admission 정본에 결속돼 있다.
async function incheonTopologySnapshot(inclusion, readTracked, inventory, key) {
  const snapshotPath = inclusion[key];
  assertAdmissionSnapshotPath(
    inventory,
    INCHEON_STATION_INFO_SOURCE_ID,
    "topologyAdmissionEvidence",
    snapshotPath,
  );
  return {
    ...parseJsonBytes(await readTracked(snapshotPath, key), snapshotPath),
    snapshotId: path.basename(snapshotPath, ".json"),
  };
}

// 인천 역사정보 편입 어댑터(#2595). 인천 구간의 첫 편입이며 운영기관·노선 3개·역·역노선·구간·노선도
// 좌표를 한 번에 싣는다. 뒤 두 편입은 이 편입이 실은 소스 등재와 역노선 계보를 선행 조건으로 검사한다.
async function materializeIncheonStationInfoInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, INCHEON_STATION_INFO_SOURCE_ID);
  assertDeclaredLineNumbers(inclusion, INCHEON_STATION_LINES);
  assertAdmissionSnapshotPath(
    inventory,
    INCHEON_STATION_INFO_SOURCE_ID,
    "topologyAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const snapshotBytes = await readTracked(inclusion.snapshotPath, "snapshotPath");
  return materializeIncheonStationInfo({
    baseFixture: fixture,
    snapshot: parseJsonBytes(snapshotBytes, inclusion.snapshotPath),
    snapshotSha256: sha256Hex(snapshotBytes),
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 인천 시각표 편입 어댑터(#2595). 노선마다 snapshot이 따로라 노선 층 경로 키를 쓰고, 노선 선언은
// 저장소 정본(INCHEON_TIMETABLE_LINES)과 대조한다 — 대구·부산 편입과 같은 축이다.
async function materializeIncheonTimetableInclusion(fixture, inclusion, { readTracked, inventory }) {
  const declared = inclusion.lines;
  if (declared.length !== INCHEON_TIMETABLE_LINES.length
    || declared.some((line, index) => line.lineNumber !== INCHEON_TIMETABLE_LINES[index].lineNumber
      || line.lineId !== INCHEON_TIMETABLE_LINES[index].lineId)) {
    throw new Error(
      `${inclusionLabel(inclusion)} pack data inclusion must declare every tracked Incheon timetable line`,
    );
  }
  const timetableSnapshots = {};
  for (const [index, line] of declared.entries()) {
    const config = INCHEON_TIMETABLE_LINES[index];
    assertAdmissionSnapshotPath(inventory, config.sourceId, "scheduleAdmissionEvidence", line.snapshotPath);
    timetableSnapshots[config.lineNumber] = parseJsonBytes(
      await readTracked(line.snapshotPath, "lines[].snapshotPath"),
      line.snapshotPath,
    );
  }
  return materializeIncheonTimetable({
    baseFixture: fixture,
    topologySnapshot: await incheonTopologySnapshot(inclusion, readTracked, inventory, "topologySnapshotPath"),
    timetableSnapshots,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// 인천 교통약자 편의시설 편입 어댑터(#2595). 대구·부산·대전·광주 편의시설과 같이 정본에 바이트 축이 없어
// (rawSha256·rowsSha256이 snapshot 내용에서 파생된다) 경로 결속이 유일한 정체성 축이다.
async function materializeIncheonAccessibilityInclusion(fixture, inclusion, { readTracked, inventory }) {
  assertDeclaredLinesMatchAdmissionScope(inclusion, inventory, INCHEON_ACCESSIBILITY_SOURCE_ID);
  // 노선 번호 정본은 이 지역의 노선을 세우는 역사정보 materializer가 갖는다 — 두 편입의 admission
  // coverageScope.lineIds가 같은 세 노선이라(위 대조가 그것을 강제한다) 같은 표를 대조 상대로 쓴다.
  assertDeclaredLineNumbers(inclusion, INCHEON_STATION_LINES);
  assertAdmissionSnapshotPath(
    inventory,
    INCHEON_ACCESSIBILITY_SOURCE_ID,
    "accessibilityAdmissionEvidence",
    inclusion.snapshotPath,
  );
  const topologySnapshot = await incheonTopologySnapshot(
    inclusion,
    readTracked,
    inventory,
    "topologySnapshotPath",
  );
  return materializeIncheonAccessibility({
    baseFixture: fixture,
    accessibilitySnapshot: parseJsonBytes(
      await readTracked(inclusion.snapshotPath, "snapshotPath"),
      inclusion.snapshotPath,
    ),
    topologySnapshot,
    inventory,
    now: new Date(inclusion.materializedAt),
  });
}

// capital-route-topology는 inventory 소스가 아니라 tracked snapshot 파일로만 존재해 admission 정본에
// snapshotPath 항목이 없다. 노선도 정본의 topologySnapshotId에서 저장소 경로 규약으로 경로를 유도해
// 선언과 대조하고, 유도한 경로를 돌려준다.
function assertAdmissionTopologySnapshotPath(inventory, sourceId, snapshotPath) {
  const snapshotId = inventory?.sources?.find(({ id }) => id === sourceId)
    ?.routeMapAdmissionEvidence?.topologySnapshotId;
  const expected = typeof snapshotId === "string" && snapshotId.trim() !== ""
    ? `tools/datapack/sources/${snapshotId}.json`
    : null;
  if (expected === null || expected !== snapshotPath) {
    throw new Error(
      `pack data inclusion topologySnapshotPath must match the ${sourceId} admission evidence topologySnapshotId path: `
        + `expected ${expected}, got ${snapshotPath}`,
    );
  }
  return expected;
}

// 편입이 읽는 snapshot 경로를 admission 정본이 선언한 경로와 결속한다(바이트 축이 없는 소스의 대칭 보완).
function assertAdmissionSnapshotPath(inventory, sourceId, evidenceKey, snapshotPath) {
  const declared = inventory?.sources?.find(({ id }) => id === sourceId)?.[evidenceKey]?.snapshotPath;
  if (typeof declared !== "string" || declared !== snapshotPath) {
    throw new Error(
      `pack data inclusion snapshotPath must match the ${sourceId} admission evidence snapshotPath: `
        + `expected ${declared}, got ${snapshotPath}`,
    );
  }
}

// 집계 대상 표를 상수로 못박지 않고 pack 자신의 배열 필드에서 끌어온다. 고정 목록은 목록 밖 표
// (routeMapPositions·facilities·officialOdFareQuotes 등 requirement 판정을 직접 뒷받침하는 표)로의
// 주입을 대조 축 밖에 남긴다 — 새 표가 생겨도 자동으로 축에 들어오게 한다.
function packRowTables(pack) {
  return Object.entries(pack)
    .filter(([, value]) => Array.isArray(value))
    .map(([table]) => table);
}

function packRowCounts(pack) {
  return Object.fromEntries(packRowTables(pack).map((table) => [table, pack[table].length]));
}

// 승계 행이 in-place로 바뀌면 행수 차이는 0이라 assertDeclaredRows가 못 잡는다. 편입 전 각 표의
// 행수와 바이트 해시를 떠 두고, 편입 후 같은 표의 앞쪽 승계 행이 그대로인지 본다(기본 전제는 append —
// 삽입·재정렬·수정이 일어나면 그 자체가 검토 대상이므로 fail closed가 옳다).
//
// #2595에서 그 검토가 실제로 왔다: 수도권 노선도 다섯 편입 중 넷(광역철도·경전철·서울 1~8호선·9호선
// 1단계)이 append 뒤 pack.operators·pack.lines·pack.coverageLineOperatorScopes 중 자기가 손댄 표를 id로
// 다시 정렬한다(실측 — 표 조합은 편입마다 다르다). 정렬 자체는 승계 행을 바꾸지 않으므로 편입을
// 막을 이유가 아니지만, 전제를 조용히 푸는 것도 옳지 않다 — 편입이 reorderedTables로 재정렬 표를 명시
// 선언한 경우에만 그 표를 위치 대신 다중집합으로 본다. 선언한 표에서도 승계 행의 수정·삭제·중복도 변화는
// 그대로 fail closed이며, 선언하지 않은 표는 접두사 대조가 그대로 적용된다.
export function inheritedRowSnapshot(pack, reorderedTables = []) {
  const reordered = new Set(reorderedTables);
  const tables = packRowTables(pack);
  return {
    counts: packRowCounts(pack),
    fingerprints: Object.fromEntries(tables.map((table) => [table, sha256Hex(JSON.stringify(pack[table]))])),
    reorderedTables: [...reorderedTables],
    // 행 단위 다중집합은 선언한 표에만 뜬다. 전 표에 뜨면 편입마다 20만 행을 행별로 해시하게 돼
    // 조립 비용이 표 크기에 비례해 불어난다 — 선언한 표에만 그 값을 치른다.
    rowBags: Object.fromEntries(
      tables.filter((table) => reordered.has(table)).map((table) => [table, rowMultiset(pack[table])]),
    ),
  };
}

function rowMultiset(rows) {
  const bag = new Map();
  for (const row of rows) {
    const hash = sha256Hex(JSON.stringify(row));
    bag.set(hash, (bag.get(hash) ?? 0) + 1);
  }
  return bag;
}

function subtractRowCounts(after, before) {
  const tables = [...new Set([...Object.keys(after), ...Object.keys(before)])].sort(codepointCompare);
  return Object.fromEntries(tables.map((table) => [table, (after[table] ?? 0) - (before[table] ?? 0)]));
}

// 한 지역에 여러 도메인 편입을 체인하면 regionId만으로는 어느 편입이 걸렸는지 알 수 없다 — 편입 정체성
// 단위(regionId, materializer)를 그대로 진단 라벨로 쓴다.
function inclusionLabel(inclusion) {
  return `${inclusion.regionId}:${inclusion.materializer}`;
}

// 편입이 실제로 실은 행수가 spec 선언과 다르면 조립을 멈춘다 — snapshot drift나 선언하지 않은 표로의
// 주입이 candidate 구성을 조용히 바꾸지 못하게 하는 축이다.
function assertDeclaredRows(inclusion, addedRows) {
  if (JSON.stringify(sortJson(addedRows)) !== JSON.stringify(sortJson(inclusion.addedRows))) {
    throw new Error(
      `${inclusionLabel(inclusion)} pack data inclusion added rows do not match the spec declaration: `
        + `expected ${JSON.stringify(sortJson(inclusion.addedRows))}, got ${JSON.stringify(sortJson(addedRows))}`,
    );
  }
}

export function assertInheritedRowsUnchanged(label, snapshot, pack) {
  // 승계 pack에 없는 표를 재정렬 대상으로 선언하면 그 선언은 아무것도 완화하지 않은 채 남는다
  // (그 편입이 처음 만드는 표에는 승계 행 자체가 없다) — 죽은 선언을 그 자리에서 되돌린다.
  for (const table of snapshot.reorderedTables ?? []) {
    if (!(table in snapshot.fingerprints)) {
      throw new Error(`${label} pack data inclusion declared a reordered table the inherited pack lacks: ${table}`);
    }
  }
  for (const [table, fingerprint] of Object.entries(snapshot.fingerprints)) {
    const rows = pack[table];
    if (!Array.isArray(rows) || rows.length < snapshot.counts[table]) {
      throw new Error(`${label} pack data inclusion dropped inherited rows: ${table}`);
    }
    const inheritedBag = snapshot.rowBags?.[table];
    if (!inheritedBag) {
      if (sha256Hex(JSON.stringify(rows.slice(0, snapshot.counts[table]))) !== fingerprint) {
        throw new Error(`${label} pack data inclusion modified inherited rows: ${table}`);
      }
      continue;
    }
    // 재정렬을 선언한 표: 승계 행이 전부 바이트 동일하게, 같은 중복도로 남아 있어야 한다. 늘어난 행수는
    // assertDeclaredRows가 따로 잡으므로 이 둘을 합치면 "승계 다중집합 + 선언한 증가분"으로 결과가 고정된다.
    //
    // 대조는 양방향이다. 승계 행 하나가 사라지는 방향만 보면(부분집합 대조) 승계 행을 복제해 중복도가
    // *느는* 방향이 그대로 통과한다(실측) — 결과 다중집합에서 승계 행 해시의 중복도가 승계 당시와 정확히
    // 같아야 한다. 이 표들의 행은 id/키로 유일해 승계 행과 바이트 동일한 신규 행은 그 자체가 중복이므로,
    // 정확 일치가 정상 편입을 막지 않는다(현행 5개 재정렬 편입 실측).
    const resultBag = rowMultiset(rows);
    for (const [hash, count] of inheritedBag) {
      if (resultBag.get(hash) !== count) {
        throw new Error(`${label} pack data inclusion modified inherited rows: ${table}`);
      }
    }
    // 선언은 실측과 일치해야 한다. 실제로 재정렬이 없었다면(접두사가 그대로면) 그 선언은 접두사 대조를
    // 근거 없이 끈 것이므로 거부한다 — 선언과 실제가 갈린 채 무성으로 남지 않게 한다.
    if (sha256Hex(JSON.stringify(rows.slice(0, snapshot.counts[table]))) === fingerprint) {
      throw new Error(`${label} pack data inclusion declared a reordered table that stayed in order: ${table}`);
    }
  }
}

// 편입 입력은 저장소 안 상대 경로만 허용한다(절대 경로·경로 이탈 fail closed). 문자열 containment만
// 보면 저장소 안 symlink가 밖을 가리킬 때 통과하므로, 링크를 해석한 실경로로 containment를 다시 본다.
// git tracked 여부까지 보지는 않는다 — 그 축은 입력 바이트 해시를 evidence에 남기는 것으로 대신한다.
async function readTrackedBytes(relativePath, inputs, label) {
  // 등재 형상의 경로 키 목록이 어댑터가 실제로 읽는 것보다 좁으면 spec 검사가 그 키를 요구하지 않아
  // undefined가 여기까지 들어온다. 무검사로 path.resolve에 넘기면 fail closed는 유지되지만 진단이
  // TypeError("paths[1] argument must be of type string") 스택으로 붕괴한다 — 결측을 그 자리에서 되돌린다.
  requiredString(relativePath, label);
  const resolved = path.resolve(root, relativePath);
  if (path.isAbsolute(relativePath) || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`pack data inclusion input must be a repository-relative path inside the repo: ${relativePath}`);
  }
  const realRoot = await realpath(root);
  let realResolved;
  try {
    realResolved = await realpath(resolved);
  } catch {
    throw new Error(`pack data inclusion input is missing: ${relativePath}`);
  }
  if (!realResolved.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`pack data inclusion input must not resolve outside the repo: ${relativePath}`);
  }
  const bytes = await readFile(realResolved);
  if (!inputs.has(relativePath)) {
    inputs.set(relativePath, {
      path: relativePath,
      sha256: sha256Hex(bytes),
    });
  }
  return bytes;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`pack data inclusion input is not valid JSON: ${label}`);
  }
}

// candidate fixture 조립: 편입까지 끝난 pack을 복제하고 candidate 정체성과 line-scope 재기술만 덮어쓴다.
function materializeCandidateFixture(spec, basePack, { lineScoped }) {
  const pack = structuredClone(basePack);
  pack.id = spec.pack.id;
  pack.version = spec.pack.version;
  pack.artifactKind = spec.pack.artifactKind;
  pack.url = spec.pack.url;
  pack.metadata = { ...(pack.metadata ?? {}), ...(spec.pack.metadataOverrides ?? {}) };
  for (const redescription of spec.lineScopeRedescriptions) {
    const source = (pack.sourceInventory ?? []).find(({ id }) => id === redescription.sourceId);
    if (!source) {
      throw new Error(`redescribed source is missing from inherited pack: ${redescription.sourceId}`);
    }
    source.coverageScope = coverageScopeWithLineIds(
      source.coverageScope,
      lineScoped ? redescription.lineIds : null,
      `${redescription.sourceId}.coverageScope`,
    );
  }
  return {
    manifest: {
      manifestVersion: spec.manifest.manifestVersion,
      channel: spec.manifest.channel,
      releaseSequence: spec.manifest.releaseSequence,
      publishedAt: spec.manifest.publishedAt,
      expiresAt: spec.manifest.expiresAt,
      keyId: spec.manifest.keyId,
      ttlSeconds: spec.manifest.ttlSeconds,
      activePack: { id: spec.pack.id, version: spec.pack.version },
    },
    packs: [pack],
  };
}

// baseline inventory: 재기술 대상 소스의 lineIds만 지운 사본(다른 소스의 line-scope는 그대로 둔다).
function withoutLineScopeRedescriptions(spec, inventory) {
  const copy = structuredClone(inventory);
  for (const redescription of spec.lineScopeRedescriptions) {
    const source = copy.sources.find(({ id }) => id === redescription.sourceId);
    source.coverageScope = coverageScopeWithLineIds(
      source.coverageScope,
      null,
      `${redescription.sourceId}.coverageScope`,
    );
  }
  return copy;
}

function coverageScopeWithLineIds(coverageScope, lineIds, label) {
  if (!coverageScope || typeof coverageScope !== "object" || Array.isArray(coverageScope)) {
    throw new Error(`${label} must be an object`);
  }
  // coverageScope에 새 key가 생겨도 조립분에서 조용히 탈락하지 않도록 spread로 보존한다
  // (고정 key 재조립은 미래 key를 무성 유실시킨다).
  const { lineIds: _dropped, ...rest } = coverageScope;
  return lineIds === null ? rest : { ...rest, lineIds: [...lineIds] };
}

// fixture와 tracked inventory의 line-scope 재기술이 어긋나면 게이트 판정이 조용히 갈린다 — fail closed.
function assertInventoryLineScopeSync(spec, inventory) {
  for (const redescription of spec.lineScopeRedescriptions) {
    const source = (inventory.sources ?? []).find(({ id }) => id === redescription.sourceId);
    if (!source) {
      throw new Error(`redescribed source is missing from source inventory: ${redescription.sourceId}`);
    }
    const actual = source.coverageScope?.lineIds ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(redescription.lineIds)) {
      throw new Error(
        `source inventory coverageScope.lineIds must match the spec redescription: ${redescription.sourceId}`,
      );
    }
    if (!source.coverageScope?.sourceDomains?.includes(redescription.sourceDomain)) {
      throw new Error(
        `source inventory coverageScope.sourceDomains must include ${redescription.sourceDomain}: ${redescription.sourceId}`,
      );
    }
    // requirement 키의 region·operator도 admission 정본이 덮는 범위여야 한다. 그렇지 않으면 재기술이
    // 실제로 뒷받침하지 못하는 scope를 전이 대상으로 선언하게 된다.
    for (const requirementKey of redescription.requirementKeys) {
      const { regionId, operatorId } = parseRequirementKey(
        requirementKey,
        `${redescription.sourceId}.requirementKeys`,
      );
      if (!source.coverageScope.regionIds?.includes(regionId)
        || !source.coverageScope.operatorIds?.includes(operatorId)) {
        throw new Error(
          "source inventory coverageScope must cover the redescribed requirement scope "
            + `${regionId}:${operatorId}: ${redescription.sourceId}`,
        );
      }
    }
  }
}

// candidate pack에 실제로 실린 line-scope 소스가 LAUNCH_REQUIRED scope를 뒷받침하면, 그 근거는
// lineScopeRedescriptions에 source/domain 단위로 빠짐없이 재기술돼야 한다. 선언 목록을 기준으로
// fixture·baseline을 조립하면 선언을 지운 실제 소스가 두 variant에 함께 남아 fail open하므로, pack ×
// tracked inventory × coverage targets에서 actual required set을 역으로 유도해 양방향 exact-match 한다.
export function assertLineScopeRedescriptionsMatchActualRequiredSet(
  spec,
  pack,
  inventory,
  targets,
  inheritedPack = { sourceInventory: [] },
) {
  const launchRequiredDomains = new Set(
    (targets.requiredSourceDomains ?? [])
      .filter(({ releaseTier }) => releaseTier === "LAUNCH_REQUIRED")
      .map(({ id }) => requiredString(id, "coverage target requiredSourceDomains[].id")),
  );
  const activeLineScopes = targets.activeLineScopes ?? [];
  const inventoryById = new Map((inventory.sources ?? []).map((source) => [source.id, source]));
  const inheritedById = new Map(
    (inheritedPack.sourceInventory ?? []).map((source) => [source.id, source]),
  );
  const actual = new Map();
  const sourcesById = new Map();

  for (const packSource of pack.sourceInventory ?? []) {
    const sourceId = requiredString(packSource?.id, "candidate pack sourceInventory[].id");
    const inventorySource = inventoryById.get(sourceId);
    const packScope = packSource.coverageScope;
    if (!inventorySource) {
      if (packScope?.lineIds?.length) {
        throw new Error(`line-scoped candidate pack source is missing from source inventory: ${sourceId}`);
      }
      continue;
    }
    const inventoryScope = inventorySource.coverageScope;
    if (!inventoryScope?.lineIds?.length) {
      if (packScope?.lineIds?.length) {
        throw new Error(`candidate pack coverageScope.lineIds must match source inventory: ${sourceId}`);
      }
      continue;
    }
    // inclusions.pack은 재기술을 덮기 전 원형이다. 기존 source는 여기서 lineIds가 없고,
    // lineScoped fixture에서만 spec 값이 주입된다. tracked inventory가 그 후보 line scope의 정본이며,
    // 원형에 이미 lineIds가 있는 신규 source라면 둘의 집합이 같아야 한다.
    if (packScope?.lineIds && !sameStringSet(packScope.lineIds, inventoryScope.lineIds)) {
      throw new Error(`candidate pack coverageScope.lineIds must match source inventory: ${sourceId}`);
    }
    const inheritedLineIds = inheritedById.get(sourceId)?.coverageScope?.lineIds;
    if (inheritedLineIds?.length) {
      if (!sameStringSet(inheritedLineIds, inventoryScope.lineIds)
        || !sameStringSet(inheritedLineIds, packScope?.lineIds)) {
        throw new Error(
          `inherited candidate pack coverageScope.lineIds must match candidate pack and source inventory: ${sourceId}`,
        );
      }
      continue;
    }
    sourcesById.set(sourceId, { packScope, inventoryScope });
  }

  const addActualRequirement = (sourceId, requirementKey) => {
    const { regionId, operatorId, lineId, sourceDomain } = parseRequirementKey(
      requirementKey,
      "line-scoped coverage requirement",
    );
    if (!launchRequiredDomains.has(sourceDomain)) return;
    const source = sourcesById.get(sourceId);
    if (!source) return;
    const { packScope, inventoryScope } = source;
    if (!inventoryScope.lineIds.includes(lineId)
      || !packScope?.sourceDomains?.includes(sourceDomain)
      || !packScope.regionIds?.includes(regionId)
      || !packScope.operatorIds?.includes(operatorId)
      || !inventoryScope.sourceDomains?.includes(sourceDomain)
      || !inventoryScope.regionIds?.includes(regionId)
      || !inventoryScope.operatorIds?.includes(operatorId)
      || !activeLineScopes.some((scope) =>
        scope.regionId === regionId && scope.operatorId === operatorId && scope.lineId === lineId,
      )) {
      return;
    }
    const key = `${sourceId}:${sourceDomain}`;
    const entry = actual.get(key) ?? { sourceId, sourceDomain, lineIds: inventoryScope.lineIds, requirementKeys: [] };
    if (!entry.requirementKeys.includes(requirementKey)) entry.requirementKeys.push(requirementKey);
    actual.set(key, entry);
  };

  // report/provenance는 materializer 편입 순서에 따라 supporting-source 표현이 달라질 수 있다. actual
  // required set은 오직 candidate pack에 존재하는 source와 tracked inventory, coverage target의 active
  // scope 교집합에서 유도한다. 따라서 순서 허용 조립은 이 선언 대조에 영향을 줄 수 없다.
  for (const { regionId, operatorId, lineId } of activeLineScopes) {
    for (const sourceDomain of launchRequiredDomains) {
      const key = `${regionId}:${operatorId}:${lineId}:${sourceDomain}`;
      for (const sourceId of sourcesById.keys()) addActualRequirement(sourceId, key);
    }
  }

  const declared = new Map();
  const declaredKeys = new Set();
  for (const redescription of spec.lineScopeRedescriptions) {
    const key = `${redescription.sourceId}:${redescription.sourceDomain}`;
    if (declaredKeys.has(key)) throw new Error(`duplicate declared line-scope source/domain: ${key}`);
    declaredKeys.add(key);
    if (!launchRequiredDomains.has(redescription.sourceDomain)) continue;
    declared.set(key, redescription);
  }

  if (actual.size !== declared.size) {
    throw new Error(
      "line-scope redescriptions must exactly match the actual required set: "
        + `actual=${[...actual.keys()].sort(codepointCompare).join(",")}, `
        + `declared=${[...declared.keys()].sort(codepointCompare).join(",")}`,
    );
  }
  for (const [key, required] of actual) {
    const redescription = declared.get(key);
    if (!redescription
      || !sameStringSet(redescription.lineIds, required.lineIds)
      || !sameStringSet(redescription.requirementKeys, required.requirementKeys)) {
      throw new Error(`line-scope redescriptions must exactly match the actual required set: ${key}`);
    }
  }
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return JSON.stringify([...left].sort(codepointCompare)) === JSON.stringify([...right].sort(codepointCompare));
}

function summarizeVariant(spec, report, provenance) {
  const supported = report.requirements.filter((entry) => entry.status === "SUPPORTED");
  const supportedRequirementKeys = supported.map(requirementKey).sort(codepointCompare);
  return {
    supportedRequirementKeys,
    // #2138 범주별 집계. 어느 건이 어느 근거 성격으로 섰는지 evidence만 보고 알 수 있어야 한다 —
    // 값은 판정 경로(report-coverage-gaps.mjs)가 requirement마다 실어 준 domain 증거 모델 그대로다.
    supportedByEvidenceModel: supportedByEvidenceModel(supported),
    launchRequired: supportedCounts(report.summary.launchRequired),
    enhancement: supportedCounts(report.summary.enhancement),
    // 한 requirement를 여러 소스가 함께 뒷받침하면(대구 membership처럼) 같은 키가 여러 재기술 항목에
    // 등재된다 — 판정 축은 requirement 하나이므로 중복을 접어 기록한다.
    pilotRequirements: declaredRequirementKeys(spec)
      .map((key) => pilotRequirement(report, key, provenance)),
  };
}

// SUPPORTED 건을 domain 증거 모델별로 센다. 판정 경로가 requirement마다 실어 준 값만 쓰고 여기서
// 기본값을 지어내지 않는다 — 값이 없으면 판정 경로가 그 축을 잃은 것이므로 그대로 fail closed 한다.
function supportedByEvidenceModel(supported) {
  const counts = new Map();
  for (const entry of supported) {
    if (typeof entry.evidenceModel !== "string" || entry.evidenceModel.trim() === "") {
      throw new Error(`coverage requirement is missing evidenceModel: ${requirementKey(entry)}`);
    }
    counts.set(entry.evidenceModel, (counts.get(entry.evidenceModel) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => codepointCompare(left, right)));
}

function declaredRequirementKeys(spec) {
  return [...new Set(spec.lineScopeRedescriptions.flatMap(({ requirementKeys }) => requirementKeys))]
    .sort(codepointCompare);
}

function supportedCounts(tier) {
  // EXPLICITLY_UNSUPPORTED·MISSING 집계는 resolutions 만료(wall-clock)에 좌우되므로 기록하지 않는다.
  return {
    totalCount: tier.totalCount,
    supportedCount: tier.supportedCount,
    supportedRatio: tier.supportedRatio,
  };
}

function pilotRequirement(report, key, provenance) {
  const entry = report.requirements.find((requirement) => requirementKey(requirement) === key);
  if (!entry) throw new Error(`pilot requirement is not in the coverage report: ${key}`);
  return {
    requirementKey: key,
    releaseTier: entry.releaseTier,
    status: entry.status,
    // denominator·coveredFields는 domain requiredFields 개수이지 데이터 행 수가 아니다.
    // 실제 뒷받침 행 수는 supportingRecordCountByField로 따로 기록한다.
    denominator: entry.denominator,
    coveredFields: entry.coveredFields,
    coverageRatio: entry.coverageRatio,
    blockingThreshold: entry.blockingThreshold,
    missingFields: entry.missingFields,
    sourceIds: entry.sourceIds,
    fieldCoverage: entry.fieldCoverage.map(({ field, status, sourceIds }) => ({ field, status, sourceIds })),
    supportingRecordCountByField: supportingRecordCountByField(provenance, entry),
  };
}

// requirement scope와 정확히 일치하는 official/field-verified provenance 레코드 수를 필드별로 센다.
// "분모 2 = 데이터 2행"으로 읽히는 오독을 막는 뒷받침 행수 축이다(결정적 — 개수만 기록한다).
function supportingRecordCountByField(provenance, entry) {
  const records = (provenance.packs ?? []).flatMap((pack) => pack.records ?? []);
  return Object.fromEntries(entry.fieldCoverage.map(({ field }) => [
    field,
    records.filter((record) =>
      record.field === field
      && ["OFFICIAL", "FIELD_VERIFIED"].includes(record.derivationKind)
      && (record.coverageScope?.regionIds ?? []).includes(entry.regionId)
      && (record.coverageScope?.operatorIds ?? []).includes(entry.operatorId)
      && (record.coverageScope?.lineIds ?? []).includes(entry.lineId)
      && (record.coverageScope?.sourceDomains ?? []).includes(entry.sourceDomain)).length,
  ]));
}

function buildEvidence({ spec, inputs, packDataInclusions, reports, variants, signing }) {
  const nonTransitions = declaredNonTransitions(spec);
  // 선언된 non-transition은 기대 전환 집합에서만 빠진다. 그 키가 실제로 전환됐다면 선언이 성공을 숨기는
  // 데 쓰인 것이므로 여기서 먼저 거부한다(아래 집합 비교로도 걸리지만 원인을 문구로 특정한다).
  const wronglyDeclared = [...nonTransitions.keys()]
    .filter((key) => variants.lineScoped.supportedRequirementKeys.includes(key));
  if (wronglyDeclared.length > 0) {
    throw new Error(
      "requirements declared as non-transitioning must not be SUPPORTED after the line-scope redescription: "
        + wronglyDeclared.join(","),
    );
  }
  assertNonTransitionReasons(nonTransitions, variants.lineScoped);
  assertEvidenceModelTotals(variants);
  const expectedKeys = declaredRequirementKeys(spec).filter((key) => !nonTransitions.has(key));
  assertCandidateRootPack(spec, reports);
  // 전이 판정은 절대 수치가 아니라 두 variant의 상대 비교다. baseline SUPPORTED 총량을 0으로 못박으면
  // 승계 팩의 다른 소스가 line-scope를 갖는 순간(#2510 로드맵의 정상 진행) 무관한 PR에서 하네스가 깨진다.
  // 아래 두 축은 그대로 fail closed로 남는다: 파일럿 키가 baseline에 이미 있으면 전이 실증이 성립하지 않고,
  // lineScoped가 baseline ∪ 파일럿 키와 다르면 선언보다 넓거나 좁은 전이가 일어난 것이다.
  const baselineKeys = variants.baseline.supportedRequirementKeys;
  const alreadySupported = expectedKeys.filter((key) => baselineKeys.includes(key));
  if (alreadySupported.length > 0) {
    throw new Error(
      `pilot requirements must be MISSING before the line-scope redescription: ${alreadySupported.join(",")}`,
    );
  }
  const expectedLineScopedKeys = [...new Set([...baselineKeys, ...expectedKeys])].sort(codepointCompare);
  if (JSON.stringify(variants.lineScoped.supportedRequirementKeys) !== JSON.stringify(expectedLineScopedKeys)) {
    throw new Error(
      "line-scoped SUPPORTED requirements must equal baseline plus the spec redescription requirementKeys: "
        + `expected ${expectedLineScopedKeys.join(",")}, got ${variants.lineScoped.supportedRequirementKeys.join(",")}`,
    );
  }
  assertDeclaredTransitionSources(spec, variants.lineScoped, nonTransitions);
  const baselineStatuses = new Map(
    reports.baseline.requirements.map((entry) => [requirementKey(entry), entry.status]),
  );
  const transitions = variants.lineScoped.pilotRequirements
    .filter((entry) => !nonTransitions.has(entry.requirementKey))
    .map((entry) => ({
      requirementKey: entry.requirementKey,
      before: baselineStatuses.get(entry.requirementKey),
      after: entry.status,
      sourceIds: entry.sourceIds,
      coveredFields: entry.coveredFields,
      denominator: entry.denominator,
    }));
  const nonTransitionEntries = [...nonTransitions.values()].map((declaration) => {
    const entry = lineScopedPilotRequirement(variants.lineScoped, declaration.requirementKey);
    return {
      requirementKey: declaration.requirementKey,
      sourceId: declaration.sourceId,
      sourceDomain: declaration.sourceDomain,
      reasonCode: declaration.reasonCode,
      reasonKo: declaration.reasonKo,
      before: baselineStatuses.get(declaration.requirementKey),
      after: entry.status,
      supportingRecordCountByField: entry.supportingRecordCountByField,
    };
  });

  return {
    schemaVersion: 1,
    artifactKind: "nationwide-candidate-coverage-gate-evidence",
    issue: spec.issue,
    parentIssues: [...spec.parentIssues],
    targetVersion: reports.lineScoped.targetVersion,
    regeneration: {
      command: regenerationCommand(inputs),
      evidencePath: EVIDENCE_PATH,
      pairedUpdateKo:
        "spec·targets·inventory·resolutions·search plan을 바꾸는 PR은 이 명령으로 evidence를 함께 재생성해야 "
        + "한다. inventory를 바꾸면 tools/datapack/reports/nationwide-coverage-tally.json도 그 ledger의 "
        + "regeneration.command로 같이 재생성한다. 재생성 누락은 datapack 도구 테스트에서 fail closed 된다.",
    },
    harness: {
      tool: TOOL_PATH,
      builder: BUILDER_PATH,
      gate: GATE_PATH,
      offlineKo: "네트워크 호출이 없다. 입력은 전부 tracked 파일이고 산출물은 임시 작업 디렉터리에만 쓴다.",
      signing: {
        mode: SIGNING_MODE,
        keyIdKo: signing.noteKo,
      },
    },
    determinism: {
      recordedAxesKo:
        "SUPPORTED 판정(requirement 키·필드 근거·소스)과 tier 분모만 기록한다. 이 축은 tracked 입력만으로 "
        + "오프라인·서명 키 없이 바이트 단위 재현된다.",
      excludedAxes: [
        "candidate.manifestSha256",
        "manifest.signature",
        "packs[].signature",
        "packs[].sqliteSha256",
        "summary.*.explicitlyUnsupportedCount",
        "summary.*.missingCount",
        "summary.*.terminalResolutionRatio",
      ],
      excludedAxesReasonKo:
        "manifest·pack 서명과 그 서명이 포함된 manifest sha256은 실행마다 새로 만드는 임시 RSA 키에 좌우되고, "
        + "sqliteSha256은 런타임 SQLite 구현에 좌우된다. EXPLICITLY_UNSUPPORTED·MISSING 집계는 게이트가 "
        + "resolutions nextReviewAt을 wall-clock으로 판정하므로 시간이 지나면 같은 입력에서도 값이 갈린다.",
      packPayloadIdenticalAcrossVariants: true,
      packPayloadIdenticalReasonKo:
        "line-scope 재기술은 소스 coverageScope 기술만 바꾸고 pack row 데이터를 바꾸지 않는다 — 두 variant의 "
        + "sqliteSha256이 같은 실행에서 동일함을 하네스가 확인한다.",
    },
    readingGuide: {
      denominatorSemanticsKo:
        "pilotRequirements의 denominator·coveredFields는 domain requiredFields 개수이지 데이터 행 수가 아니다. "
        + "route_map_positions의 denominator 2는 필수 필드 2개(route_map_position·route_map_label_polygon)를 "
        + "뜻하며 역 2개나 행 2개를 뜻하지 않는다. 실제로 그 판정을 뒷받침한 provenance 행 수는 필드별 "
        + "supportingRecordCountByField에 따로 기록한다.",
      supportedScopeKo:
        "이 evidence는 SUPPORTED 축만 기록하므로 전국 gap 총량 판독에 쓰면 안 된다. 전국 진행 집계는 "
        + "tools/datapack/reports/nationwide-coverage-tally.json이 정본이다.",
      variantComparisonKo:
        "전이 판정은 두 variant의 상대 비교다. baseline SUPPORTED 총량은 승계 팩의 다른 소스가 line-scope를 "
        + "갖게 되면 함께 늘어날 수 있고, 하네스는 파일럿 키가 baseline에 없고 lineScoped가 baseline ∪ 파일럿 "
        + "키와 정확히 같은지만 fail closed로 본다.",
      baselineSemanticsKo:
        "baseline은 저장소의 특정 과거 커밋 상태가 아니라 '등재된 재기술을 걷어낸' counterfactual이다. 아래 "
        + "lineScopeRedescriptions에 등재된 소스의 coverageScope.lineIds만 fixture와 inventory 사본에서 지운 "
        + "실행이며, 편입 행은 두 variant에 동일하게 들어간다. 따라서 이 evidence의 전이는 '어떤 소스의 "
        + "line-scope 기술이 그 requirement를 여는가'를 뜻하고, 그 소스의 line-scope가 admission 정본에 언제 "
        + "들어왔는지(대구 소스는 #2549 이전부터 line-scope였다)와는 다른 축이다. 전이를 뒷받침한 소스가 등재 "
        + "목록과 정확히 같은지는 하네스가 fail closed로 확인한다.",
    },
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => [name, { path: input.path, sha256: input.sha256 }]),
    ),
    candidatePack: {
      id: spec.pack.id,
      version: spec.pack.version,
      artifactKind: spec.pack.artifactKind,
      manifestChannel: spec.manifest.channel,
      candidateId: spec.candidateId,
      inheritsFrom: {
        path: spec.inheritsFrom.path,
        packId: spec.inheritsFrom.packId,
        packVersion: spec.inheritsFrom.packVersion,
      },
      rootPackRuleKo:
        "게이트는 manifest의 required root pack(emergencyOverride + activePack/default)만 판정하고 각 root "
        + "pack이 단독으로 coverage 계약을 만족해야 한다. candidate manifest는 이 pack 하나만 root로 둔다.",
    },
    packDataInclusions: {
      modelKo:
        "승계 원본에 없는 지역 행은 tracked materializer가 tracked snapshot을 재생해 조립한다. 저장소에 "
        + "행을 복제하지 않으므로 아래 입력 해시가 candidate 구성의 유일한 결속 축이며, 실제로 실린 "
        + "행수(addedRows)가 spec 선언과 다르면(또는 승계 행이 바뀌면) 조립이 fail closed 된다.",
      variantParityKo:
        "편입 행은 두 variant에 동일하게 들어간다. 편입은 line-scope 재기술과 독립이며, variant를 가르는 "
        + "축은 재기술뿐이다.",
      reorderedTablesKo:
        "승계 행 불변 대조의 기본 전제는 append다 — 편입 후에도 각 표의 앞쪽 승계 행이 바이트 그대로여야 "
        + "한다. 일부 materializer는 append 뒤 표를 id로 다시 정렬하는데(수도권 노선도 다섯 편입 중 넷이 "
        + "operators·lines·coverageLineOperatorScopes 중 자기가 손댄 표를 그렇게 다시 정렬한다, 실측), "
        + "정렬은 승계 행 자체를 바꾸지 않으므로 편입을 막을 "
        + "이유가 아니다. 그렇다고 전제를 조용히 풀지도 않는다: 편입이 reorderedTables로 그 표를 명시 "
        + "선언한 경우에만 위치 대신 다중집합으로 본다. 선언한 표에서도 승계 행의 수정·삭제·중복도 변화는 "
        + "그대로 fail closed이고, 선언하지 않은 표는 접두사 대조가 그대로 적용되며, 실제로 재정렬이 없는 "
        + "표를 선언하거나 승계 행이 없는 표를 선언하면 그 선언 자체가 거부된다. 아래 entries에 이 키가 "
        + "없는 편입은 append만 했다는 뜻이다.",
      chainKo:
        "entries는 적용 순서다. 한 지역에 여러 도메인을 편입하면 뒤 편입의 승계 원본은 앞 편입 결과이므로 "
        + "앞선 편입이 실은 행도 뒤 편입의 불변 대상이 된다. 순서를 조립이 강제하는 구간은 선행 조건이 "
        + "있는 쌍뿐이다 — 대구 route_map·accessibility는 pack에 대구 시각표 소스가 이미 있을 것을 "
        + "검사하므로 시각표 편입보다 앞서면 fail closed 되지만, 서로 선행 조건이 없는 두 편입"
        + "(route_map↔accessibility)은 순서를 바꿔도 조립이 통과한다. 따라서 기록된 전체 순서를 고정하는 "
        + "축은 조립 fail closed가 아니라 이 entries 배열 순서를 그대로 대조하는 회귀다. 부산은 선행 "
        + "구조가 대구와 다르다 — 승계 원본에 부산 운영기관·노선·역이 아예 없어 topology 편입이 그 셋을 "
        + "함께 싣고, 나머지 세 편입(시각표·노선도·편의시설)이 모두 그 소스 등재와 station_lines·"
        + "network_edges 계보를 선행 조건으로 검사한다. 즉 부산 구간에서 선행 조건이 강제하는 것은 "
        + "topology가 먼저라는 것뿐이다. 다만 부산 노선도 편입은 승계 원본에 없던 표"
        + "(routeMapLineTracks)를 새로 만들기 때문에 뒤 세 편입끼리의 교환도 조립을 통과하지 못한다"
        + "(실측) — 그 표를 0으로 선언해야 하는 편입이 순서에 따라 갈려 선언 행수 대조에서 걸리며, "
        + "이는 선행 조건 위반과 다른 축이다. 대전·광주는 부산과 같은 모양이되 편입 단위가 다르다: "
        + "topology 전용 materializer가 편입이 아니고 시각표 편입 하나가 topology·membership·시각표를 "
        + "함께 싣는다(대전은 시각표 materializer가 topology materializer를 호출하고, 광주는 한 함수가 "
        + "세 소스를 함께 등재한다). 그래서 두 지역 모두 시각표 편입이 먼저다 — 노선도·편의시설 "
        + "materializer는 그 지역 운영기관이 pack에 있을 것과 시각표 소스가 등재돼 있을 것을 함께 선행 "
        + "조건으로 검사하고, 시각표 편입보다 앞서면 실측상 운영기관 조건에서 먼저 fail closed 된다. 반면 "
        + "노선도와 편의시설 사이에는 선행 조건이 없어(대구와 같다) 두 편입의 교환은 조립을 통과한다(실측). "
        + "수도권 노선도 다섯 편입 사이에도 다른 지역에 대해서도 선행 조건이 없다 — 네 편입(광역철도·경전철·"
        + "9호선 1단계·2·3단계)은 경로 그래프 계보를 inventory 소스가 아니라 tracked snapshot 파일로 대조하고 "
        + "역·역노선을 스스로 만들어 승계 pack 의존이 아예 없다. 서울 1~8호선 편입만 승계 pack에 의존한다: "
        + "승계 원본의 서울교통공사 운영기관과 capital pilot cyberstation 소스 등재를 선행 조건으로 검사하고 "
        + "승계 routeMapPositions의 (역, 노선, 권역) PK 집합으로 중복을 거른다. 그 셋은 전부 승계 원본이 이미 "
        + "갖고 있어 다른 편입에 대한 순서 의존은 되지 않는다. 그런데도 순서를 바꾸면 조립이 막힌다(실측): "
        + "광역철도 편입이 승계 원본에 없던 "
        + "표(coverageLineOperatorScopes)를 새로 만들고 환승역 중복 제거 결과(stations·stationLines)도 앞선 "
        + "편입이 무엇을 실었는지에 따라 갈려, 부산 노선도와 같은 선언 행수 대조가 걸린다. 9호선 1단계·2·3단계 "
        + "두 편입의 교환도, 9호선 두 편입을 서울 1~8호선 앞으로 옮기는 것도 같은 행수 대조에서 걸린다(실측). "
        + "재정렬 선언(reorderedTables)도 같은 순서에 묶여 있지만(그 표에 승계 행이 있는지가 순서에 따라 "
        + "갈린다) 실측상 먼저 걸리는 것은 행수 대조다. 인천은 부산과 같은 모양이다 — 승계 원본에 인천 "
        + "운영기관·노선·역이 아예 없어 역사정보 편입이 그 셋을 함께 싣고, 시각표·편의시설 편입이 그 운영기관 "
        + "존재를 선행 조건으로 검사해 역사정보보다 앞서면 각각 `Incheon timetable requires incheon-transit "
        + "operator pack`·`Incheon accessibility requires incheon-transit operator pack`으로 막힌다(실측). "
        + "시각표와 편의시설 사이에는 선행 조건이 없어 둘의 교환은 조립을 그대로 통과한다(실측). 인천 구간 "
        + "전체를 수도권 앞으로 옮기는 것은 선행 조건이 아니라 행수 대조가 막는다: 7호선 노선 레코드와 "
        + "환승역 4곳(검암·계양·원인재·부천종합운동장)을 수도권 편입이 먼저 실었는지에 따라 역사정보 편입의 "
        + "lines·stations·coverageLineOperatorScopes 선언이 갈린다(실측).",
      entries: packDataInclusions,
    },
    lineScopeRedescriptions: spec.lineScopeRedescriptions.map((redescription) => ({
      sourceId: redescription.sourceId,
      sourceDomain: redescription.sourceDomain,
      lineIds: [...redescription.lineIds],
      requirementKeys: [...redescription.requirementKeys],
      // 선언한 재기술에만 남긴다 — 키가 없는 재기술은 declare한 requirement가 전부 전환됐다는 뜻이다.
      ...(redescription.nonTransitioningRequirements
        ? {
          nonTransitioningRequirements: redescription.nonTransitioningRequirements.map(
            ({ requirementKey: key, reasonCode, reasonKo }) => ({ requirementKey: key, reasonCode, reasonKo }),
          ),
        }
        : {}),
    })),
    declaredNonTransitions: {
      modelKo:
        "재기술이 declare한 requirement 중 이 배치에서 전환되지 않는 것을 명시 선언한 목록이다. 소스가 "
        + "덮는 노선 중 일부만 전환되는 편입을 표현하려면 이 축이 필요하다 — 재기술 lineIds는 admission "
        + "정본과 정확히 같아야 하고 선언한 lineIds는 requirementKeys가 전수 덮어야 하기 때문이다. 이 "
        + "선언은 전환 범위를 넓히지 못한다: 기대 전환 집합에서 그 키를 빼는 것이 전부이고, 하네스가 "
        + "① 그 키가 실제로 SUPPORTED면 거부하고 ② 사유 코드가 요구하는 실측 술어를 확인한다. 선언하지 "
        + "않은 키가 전환되지 않으면 그대로 fail closed다.",
      reasonCodesKo:
        "NO_SUPPORTING_ROWS_FOR_LINE — 그 scope를 뒷받침하는 official/field-verified provenance 행이 "
        + "조립 결과에 필드마다 0건임을 하네스가 확인한다(아래 supportingRecordCountByField). 사유가 "
        + "자유 서술로만 남지 않도록 코드마다 실측 술어를 하나씩 둔다. 새 사유 코드는 그 코드가 요구하는 "
        + "실측 술어를 함께 넣어야만 allowlist에 오른다.",
      scopeKo:
        "선언 단위는 (sourceId, sourceDomain, lineId)다. 선언은 그 재기술이 declare한 requirement 키 "
        + "안에서만 고를 수 있어 도메인 전체·소스 전체·와일드카드 선언이 들어올 통로가 없고, 한 재기술의 "
        + "노선을 전부 선언하면 그 재기술이 아무것도 열지 않게 되므로 거부된다.",
      // 이 축이 조용히 늘지 않도록 수치를 함께 남긴다 — evidence diff에서 한 줄로 드러난다.
      count: nonTransitionEntries.length,
      entries: nonTransitionEntries,
    },
    variants: {
      baseline: {
        descriptionKo:
          "line-scope 재기술 이전 상태. 재기술 대상 소스의 coverageScope.lineIds를 candidate fixture와 "
          + "inventory 사본에서 함께 지워 operator-scope provenance만 나오게 한 실행이다.",
        ...variants.baseline,
      },
      lineScoped: {
        descriptionKo:
          "line-scope 재기술 이후 상태. candidate fixture와 tracked source-inventory.json이 같은 lineIds를 "
          + "기술해 (operator, line) 단일 pair provenance가 나온 실행이다.",
        ...variants.lineScoped,
      },
    },
    transitions,
  };
}

// 범주별 집계의 합이 SUPPORTED 총계와 같아야 한다. 이 축이 없으면 범주 하나가 빠져도 evidence는
// 그럴듯하게 남는다 — 감사자가 두 수를 손으로 더해 맞춰 보지 않아도 되게 하네스가 대조한다.
function assertEvidenceModelTotals(variants) {
  for (const [variant, summary] of Object.entries(variants)) {
    const total = Object.values(summary.supportedByEvidenceModel).reduce((sum, count) => sum + count, 0);
    if (total !== summary.supportedRequirementKeys.length) {
      throw new Error(
        `${variant} supportedByEvidenceModel must sum to the SUPPORTED total: `
          + `expected ${summary.supportedRequirementKeys.length}, got ${total}`,
      );
    }
  }
}

// spec이 선언한 non-transition을 requirementKey로 색인한다. 같은 키를 두 재기술이 선언하면(한 소스가
// 여러 도메인을 덮는 경우와 달리 이 축은 requirement 단위 판정이라) 어느 사유가 정본인지 갈리므로 거부한다.
function declaredNonTransitions(spec) {
  const declarations = new Map();
  for (const redescription of spec.lineScopeRedescriptions) {
    for (const declaration of redescription.nonTransitioningRequirements ?? []) {
      if (declarations.has(declaration.requirementKey)) {
        throw new Error(
          `duplicate non-transition declaration across redescriptions: ${declaration.requirementKey}`,
        );
      }
      declarations.set(declaration.requirementKey, {
        requirementKey: declaration.requirementKey,
        sourceId: redescription.sourceId,
        sourceDomain: redescription.sourceDomain,
        reasonCode: declaration.reasonCode,
        reasonKo: declaration.reasonKo,
      });
    }
  }
  return declarations;
}

function lineScopedPilotRequirement(lineScoped, key) {
  const entry = lineScoped.pilotRequirements.find(({ requirementKey: found }) => found === key);
  if (!entry) throw new Error(`declared non-transition requirement is not in the evidence: ${key}`);
  return entry;
}

// 사유 코드가 요구하는 실측 술어를 확인한다. 이 확인이 없으면 non-transition 선언이 "안 열린다"는 주장을
// 자유 서술로만 남기게 되고, 뒤에 데이터가 들어와 실제로 열릴 수 있게 돼도 선언이 그대로 살아남는다.
//
// 분기는 전수 switch다. "관심 없는 코드는 continue"로 두면 술어 없는 코드를 allowlist에 얹는 것만으로
// 그 선언이 무성 통과한다(실측) — 미처리 코드는 그 자리에서 fail closed 해 "새 사유 코드는 실측 술어를
// 함께 넣어야만 allowlist에 오른다"는 계약을 서술이 아니라 코드가 강제하게 한다.
export function assertNonTransitionReasons(nonTransitions, lineScoped) {
  for (const declaration of nonTransitions.values()) {
    const entry = lineScopedPilotRequirement(lineScoped, declaration.requirementKey);
    switch (declaration.reasonCode) {
      case "NO_SUPPORTING_ROWS_FOR_LINE": {
        const supporting = Object.entries(entry.supportingRecordCountByField)
          .filter(([, count]) => count !== 0);
        if (supporting.length > 0) {
          throw new Error(
            `non-transition reason NO_SUPPORTING_ROWS_FOR_LINE requires zero supporting provenance rows for `
              + `${declaration.requirementKey}: ${supporting.map(([field, count]) => `${field}=${count}`).join(",")}`,
          );
        }
        break;
      }
      default:
        throw new Error(
          `non-transition reason code has no harness predicate: ${declaration.reasonCode}`,
        );
    }
  }
}

// 전이한 requirement를 실제로 뒷받침한 소스가 spec 등재분과 정확히 같아야 한다. 이 축이 없으면
// 등재 소스를 spec에서 빼도(그 소스는 baseline에서도 line-scope를 유지해 판정이 그대로 나온다) 하네스가
// 통과해, evidence의 재기술 목록이 실제 근거보다 좁아진 채로 남는다.
//
// 선언된 non-transition 키는 이 축의 대상이 아니다 — 전환되지 않은 키에는 뒷받침 소스가 없고, 그 키가
// 실제로 전환되지 않았다는 것은 buildEvidence의 SUPPORTED 대조와 사유 술어가 따로 확인한다.
function assertDeclaredTransitionSources(spec, lineScoped, nonTransitions) {
  const declaredSourceIds = new Map();
  for (const redescription of spec.lineScopeRedescriptions) {
    for (const key of redescription.requirementKeys) {
      const sourceIds = declaredSourceIds.get(key) ?? new Set();
      sourceIds.add(redescription.sourceId);
      declaredSourceIds.set(key, sourceIds);
    }
  }
  for (const entry of lineScoped.pilotRequirements) {
    if (nonTransitions.has(entry.requirementKey)) continue;
    const declared = [...(declaredSourceIds.get(entry.requirementKey) ?? [])].sort(codepointCompare);
    if (JSON.stringify(entry.sourceIds) !== JSON.stringify(declared)) {
      throw new Error(
        `supporting sources must equal the spec redescriptions for ${entry.requirementKey}: `
          + `expected ${declared.join(",")}, got ${entry.sourceIds.join(",")}`,
      );
    }
  }
}

function assertCandidateRootPack(spec, reports) {
  for (const [variant, report] of Object.entries(reports)) {
    const packs = report.candidate?.packs ?? [];
    if (packs.length !== 1) {
      throw new Error(`${variant} candidate manifest must have exactly one required root pack`);
    }
    const [pack] = packs;
    if (pack.id !== spec.pack.id || pack.version !== spec.pack.version) {
      throw new Error(`${variant} candidate root pack identity mismatch: ${pack.id}@${pack.version}`);
    }
    if (pack.artifactKind !== CANDIDATE_ARTIFACT_KIND) {
      throw new Error(`${variant} candidate root pack artifactKind must be ${CANDIDATE_ARTIFACT_KIND}`);
    }
  }
  if (reports.baseline.candidate.packs[0].sqliteSha256 !== reports.lineScoped.candidate.packs[0].sqliteSha256) {
    throw new Error("line-scope redescription must not change candidate pack payload bytes");
  }
}

function requirementKey({ regionId, operatorId, lineId, sourceDomain }) {
  return `${regionId}:${operatorId}:${lineId}:${sourceDomain}`;
}

function regenerationCommand(inputs) {
  return [
    "node",
    TOOL_PATH,
    "--spec", inputs.spec.path,
    "--targets", inputs.targets.path,
    "--inventory", inputs.inventory.path,
    "--resolution-plan", inputs.resolutionPlan.path,
    "--resolutions", inputs.resolutions.path,
    "--output", EVIDENCE_PATH,
  ].join(" ");
}

function ephemeralSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    noteKo:
      "production artifactKind pack은 RSA 서명이 필수라 실행마다 임시 RSA-2048 키쌍을 만들어 자식 프로세스 "
      + "env로만 주입한다. 저장소·CI 비밀에 서명 키가 필요 없고 키는 디스크에 남지 않는다.",
    env: {
      EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  };
}

function validateSpec(spec, materializers) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("candidate spec must be an object");
  }
  if (spec.schemaVersion !== 1) throw new Error("candidate spec schemaVersion must be 1");
  if (spec.artifactKind !== SPEC_ARTIFACT_KIND) {
    throw new Error(`candidate spec artifactKind must be ${SPEC_ARTIFACT_KIND}`);
  }
  if (!Number.isInteger(spec.issue) || spec.issue <= 0) {
    throw new Error("candidate spec issue must be a positive integer");
  }
  if (!Array.isArray(spec.parentIssues) || spec.parentIssues.some((issue) => !Number.isInteger(issue))) {
    throw new Error("candidate spec parentIssues must be an integer array");
  }
  requiredString(spec.candidateId, "candidate spec candidateId");
  requiredString(spec.inheritsFrom?.path, "candidate spec inheritsFrom.path");
  requiredString(spec.inheritsFrom?.packId, "candidate spec inheritsFrom.packId");
  requiredString(spec.inheritsFrom?.packVersion, "candidate spec inheritsFrom.packVersion");
  // candidate 안전 경계는 주석이 아니라 단언으로 강제한다. 이 도구는 artifactKind production으로
  // 실제 RSA 서명 manifest를 만들기 때문에, spec 편집만으로 production 채널·게시 가능 URL 서명본이
  // 나오면 안 된다(심층방어 — 게시 경로에 오르지 못하게 채널과 호스트를 fail closed로 묶는다).
  if (spec.manifest?.channel !== CANDIDATE_MANIFEST_CHANNEL) {
    throw new Error(`candidate spec manifest.channel must be ${CANDIDATE_MANIFEST_CHANNEL}`);
  }
  requiredString(spec.manifest?.publishedAt, "candidate spec manifest.publishedAt");
  requiredString(spec.manifest?.expiresAt, "candidate spec manifest.expiresAt");
  requiredString(spec.manifest?.keyId, "candidate spec manifest.keyId");
  if (spec.manifest.manifestVersion !== 2) throw new Error("candidate spec manifest.manifestVersion must be 2");
  if (!Number.isInteger(spec.manifest.releaseSequence) || spec.manifest.releaseSequence <= 0) {
    throw new Error("candidate spec manifest.releaseSequence must be a positive integer");
  }
  if (!Number.isInteger(spec.manifest.ttlSeconds) || spec.manifest.ttlSeconds <= 0) {
    throw new Error("candidate spec manifest.ttlSeconds must be a positive integer");
  }
  requiredString(spec.pack?.id, "candidate spec pack.id");
  requiredString(spec.pack?.version, "candidate spec pack.version");
  assertNonPublishablePackUrl(requiredString(spec.pack?.url, "candidate spec pack.url"));
  if (spec.pack.artifactKind !== CANDIDATE_ARTIFACT_KIND) {
    throw new Error(`candidate spec pack.artifactKind must be ${CANDIDATE_ARTIFACT_KIND}`);
  }
  if (spec.pack.id === spec.inheritsFrom.packId) {
    throw new Error("candidate pack id must differ from the inherited production pack id");
  }
  validatePackDataInclusions(spec, materializers);
  if (!Array.isArray(spec.lineScopeRedescriptions) || spec.lineScopeRedescriptions.length === 0) {
    throw new Error("candidate spec lineScopeRedescriptions must be a non-empty array");
  }
  // 한 소스가 여러 도메인을 덮으면(대구 topology 소스는 route_graph_topology와 station_line_membership을
  // 함께 덮는다) 도메인마다 재기술 항목을 따로 둔다 — claim 단위를 requirement 단위와 맞춰 evidence가
  // "어느 도메인을 왜 열었나"를 잃지 않게 한다. 중복 금지 단위도 (sourceId, sourceDomain)이다.
  const redescriptionKeys = new Set();
  const lineIdsBySource = new Map();
  for (const redescription of spec.lineScopeRedescriptions) {
    const sourceId = requiredString(redescription?.sourceId, "lineScopeRedescriptions.sourceId");
    const sourceDomain = requiredString(redescription.sourceDomain, `${sourceId}.sourceDomain`);
    const redescriptionKey = `${sourceId}:${sourceDomain}`;
    if (redescriptionKeys.has(redescriptionKey)) {
      throw new Error(`duplicate line-scope redescription: ${redescriptionKey}`);
    }
    redescriptionKeys.add(redescriptionKey);
    // B0 파일럿은 lineIds 1개만 허용했다(#2514). #2549 B1이 이 단언을 근거 결속으로 넓힌다: 개수 대신
    // (1) 같은 소스를 여러 도메인으로 재기술해도 lineIds가 갈리지 않고, (2) 선언한 lineIds를 declare한
    // requirementKeys가 정확히 덮는지를 본다. 여기에 assertInventoryLineScopeSync가 tracked
    // source-inventory의 lineIds와 정확히 같음을 강제하므로, spec만 고쳐서는 전환 범위가 넓어지지 않는다
    // (inventory 변경은 ledger·tally 동반 갱신과 datapack 테스트가 따로 막는다).
    const lineIds = requiredStringArray(redescription.lineIds, `${sourceId}.lineIds`);
    if (new Set(lineIds).size !== lineIds.length) {
      throw new Error(`${sourceId}.lineIds must not repeat a line`);
    }
    const declaredLineIds = lineIdsBySource.get(sourceId);
    if (declaredLineIds && JSON.stringify(declaredLineIds) !== JSON.stringify(lineIds)) {
      throw new Error(`${sourceId} line-scope redescriptions must declare the same lineIds across domains`);
    }
    lineIdsBySource.set(sourceId, lineIds);
    const requirementKeys = requiredStringArray(redescription.requirementKeys, `${sourceId}.requirementKeys`);
    const coveredLineIds = new Set();
    for (const requirementKey of requirementKeys) {
      const parsed = parseRequirementKey(requirementKey, `${redescriptionKey}.requirementKeys`);
      if (parsed.sourceDomain !== sourceDomain) {
        throw new Error(
          `${redescriptionKey}.requirementKeys must stay in the redescribed source domain: ${requirementKey}`,
        );
      }
      if (!lineIds.includes(parsed.lineId)) {
        throw new Error(
          `${redescriptionKey}.requirementKeys must stay in the redescribed lineIds: ${requirementKey}`,
        );
      }
      coveredLineIds.add(parsed.lineId);
    }
    if (coveredLineIds.size !== lineIds.length) {
      throw new Error(`${redescriptionKey}.requirementKeys must cover every redescribed line`);
    }
    validateNonTransitions(redescription, redescriptionKey, requirementKeys, lineIds);
  }
}

// 선언된 non-transition 축(#2595). "이 lineId는 선언하되 이 배치에서는 전환되지 않으며 사유는 X"를
// 명시로 적게 한다. 이 축이 없으면 소스가 덮는 노선 중 일부만 전환되는 편입을 표현할 수 없다 —
// 재기술 lineIds는 admission 정본과 정확히 같아야 하고(assertInventoryLineScopeSync), 선언한 lineIds는
// requirementKeys가 전수 덮어야 하며, lineScoped SUPPORTED는 baseline ∪ 선언 키와 정확히 같아야 하기
// 때문이다. 인천 역사정보 소스는 7호선을 route_graph_topology scope로 덮지만 materializer가 7호선 구간을
// 구조적으로 만들지 않아 그 requirement 하나만 열리지 않는다(실측).
//
// 이 선언은 전환 범위를 넓히지 못한다. 선언이 하는 일은 기대 전환 집합에서 그 키를 빼는 것뿐이고,
// buildEvidence가 ① 그 키가 실제로 SUPPORTED면 거부하고 ② 사유 코드가 요구하는 실측 술어(그 scope
// provenance 행 0건)를 확인한다. 선언하지 않은 키가 전환되지 않으면 여전히 거부된다.
function validateNonTransitions(redescription, redescriptionKey, requirementKeys, lineIds) {
  if (redescription.nonTransitioningRequirements === undefined) return;
  const declarations = redescription.nonTransitioningRequirements;
  if (!Array.isArray(declarations) || declarations.length === 0) {
    throw new Error(`${redescriptionKey}.nonTransitioningRequirements must be a non-empty array`);
  }
  const seen = new Set();
  const declaredLineIds = new Set();
  for (const declaration of declarations) {
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
      throw new Error(`${redescriptionKey}.nonTransitioningRequirements[] must be an object`);
    }
    const label = `${redescriptionKey}.nonTransitioningRequirements[]`;
    assertKnownKeys(declaration, NON_TRANSITION_KEYS, label);
    const requirementKey = requiredString(declaration.requirementKey, `${label}.requirementKey`);
    // 선언 대상은 이 재기술이 이미 declare한 requirement여야 한다. 그렇지 않으면 이 축이 재기술 범위 밖
    // 키까지 건드리는 통로가 된다.
    if (!requirementKeys.includes(requirementKey)) {
      throw new Error(
        `${label}.requirementKey must be one of the declared requirementKeys: ${requirementKey}`,
      );
    }
    if (seen.has(requirementKey)) {
      throw new Error(`${label} must not repeat a requirement: ${requirementKey}`);
    }
    seen.add(requirementKey);
    // 선언 단위는 (sourceId, sourceDomain, lineId)다. requirementKey가 재기술의 declare 목록 안에 있어야
    // 하므로 도메인 전체·소스 전체·와일드카드 선언은 이 축에 들어올 통로 자체가 없다 — 그 키들은 위
    // 포함 검사에서 걸린다. lineId는 사유 술어와 전량 선언 금지 판정에 쓴다.
    declaredLineIds.add(parseRequirementKey(requirementKey, `${label}.requirementKey`).lineId);
    // 사유는 필수다. 코드는 하네스가 실측 술어를 갖고 있는 것만 허용하고, 한국어 사유도 함께 요구한다 —
    // 코드만 남으면 "왜 이 배치에서 못 여는가"가 evidence에서 사라진다.
    const reasonCode = requiredString(declaration.reasonCode, `${label}.reasonCode`);
    if (!NON_TRANSITION_REASON_CODES.includes(reasonCode)) {
      throw new Error(`${label}.reasonCode must be one of ${NON_TRANSITION_REASON_CODES.join(",")}: ${reasonCode}`);
    }
    requiredString(declaration.reasonKo, `${label}.reasonKo`);
  }
  if (JSON.stringify([...seen]) !== JSON.stringify([...seen].sort(codepointCompare))) {
    throw new Error(`${redescriptionKey}.nonTransitioningRequirements must be sorted by requirementKey`);
  }
  // 선언한 노선이 재기술 lineIds 전부가 되면 그 재기술은 아무것도 열지 않는다 — 등재의 뜻이 사라지므로
  // 거부한다(그 경우 옳은 조치는 선언이 아니라 재기술 자체를 지우는 것이다). 판정 단위는 requirementKey
  // 개수가 아니라 노선이다: 한 노선이 requirement 둘을 여는 재기술(dual-operator scope)에서 한쪽만
  // 선언해도 그 노선은 여전히 열리므로 개수 비교는 이 성질을 잘못 읽는다.
  if (declaredLineIds.size === new Set(lineIds).size) {
    throw new Error(`${redescriptionKey} must transition at least one redescribed line`);
  }
}

function validatePackDataInclusions(spec, materializers) {
  if (spec.packDataInclusions === undefined) return;
  if (!Array.isArray(spec.packDataInclusions)) {
    throw new Error("candidate spec packDataInclusions must be an array");
  }
  // 중복 금지 단위는 (regionId, materializer)다(#2580). 한 지역의 여러 도메인을 체인 편입하려면
  // regionId 단독 유일성이 성립할 수 없고, 같은 materializer를 같은 지역에 두 번 싣는 이중 편입은
  // 그대로 막아야 한다(대상 materializer들은 소스 재등재를 자체적으로도 거부하지만 spec 단계에서 끊는다).
  const inclusionKeys = new Set();
  for (const inclusion of spec.packDataInclusions) {
    const regionId = requiredString(inclusion?.regionId, "packDataInclusions.regionId");
    const materializer = requiredString(inclusion.materializer, `${regionId}.materializer`);
    const entry = materializers.get(materializer);
    if (!entry) {
      throw new Error(`unknown pack data materializer: ${materializer}`);
    }
    const label = inclusionLabel(inclusion);
    if (inclusionKeys.has(label)) throw new Error(`duplicate pack data inclusion: ${label}`);
    inclusionKeys.add(label);
    // offset 없는 값(예: "2026-07-20T16:00:00")은 new Date()가 로컬 타임존으로 해석해 같은 tracked
    // 입력이 머신 타임존에 따라 조립 성공/실패로 갈린다 — UTC ISO-8601 왕복을 강제해 검사와 메시지를 맞춘다.
    const materializedAt = requiredString(inclusion.materializedAt, `${label}.materializedAt`);
    if (!Number.isFinite(Date.parse(materializedAt))
      || new Date(materializedAt).toISOString() !== materializedAt) {
      throw new Error(`${label}.materializedAt must be a UTC ISO-8601 timestamp`);
    }
    validateInclusionInputs(inclusion, entry.inputs, label);
    // 표 목록은 pack 자신에서 끌어오므로 여기서 정적으로 고정하지 않는다. "선언이 pack의 모든 표를
    // 빠짐없이 덮는가"는 assertDeclaredRows가 실제 산출 map과 전키 비교로 강제한다.
    const addedRows = inclusion.addedRows;
    if (!addedRows || typeof addedRows !== "object" || Array.isArray(addedRows)) {
      throw new Error(`${label}.addedRows must be an object`);
    }
    if (Object.keys(addedRows).length === 0) {
      throw new Error(`${label}.addedRows must declare every pack row table`);
    }
    for (const [table, count] of Object.entries(addedRows)) {
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`${label}.addedRows.${table} must be a non-negative integer`);
      }
    }
    validateReorderedTables(inclusion, label);
  }
}

// 재정렬 선언은 선택 키다. 선언하지 않으면 승계 행 접두사 대조가 그대로 적용되고, 선언하면 그 표만
// 다중집합 대조로 바뀐다. 빈 배열은 아무것도 열지 않는 죽은 선언이라 키 자체를 두지 않는 것과 갈리지
// 않으므로 거부한다. 표 이름은 중복 없이 코드포인트 오름차순으로 둬 spec diff가 정렬에 흔들리지 않게 한다.
//
// 서술 키(reorderedTablesKo)는 선언 키가 있을 때만 뜻이 있다. 선언 없이 서술만 남기면 "이 편입은 표를
// 재정렬한다"는 주장이 아무것도 완화하지 않은 채 통과해(실측) 서술과 실제 결속이 갈린다 —
// evidenceModelReasonKo·evidenceCategoryReasonKo가 선언 키를 요구하는 것과 같은 축으로 거부한다.
function validateReorderedTables(inclusion, label) {
  if (inclusion.reorderedTables === undefined) {
    if (inclusion.reorderedTablesKo !== undefined) {
      throw new Error(`${label}.reorderedTablesKo requires reorderedTables`);
    }
    return;
  }
  const tables = requiredStringArray(inclusion.reorderedTables, `${label}.reorderedTables`);
  if (new Set(tables).size !== tables.length) {
    throw new Error(`${label}.reorderedTables must not repeat a table`);
  }
  if (JSON.stringify(tables) !== JSON.stringify([...tables].sort(codepointCompare))) {
    throw new Error(`${label}.reorderedTables must be sorted by codepoint`);
  }
}

// 편입 입력 형상은 allowlist 항목이 등재한 경로 키만 요구한다. 선언한 경로는 전부 어댑터가 readTracked로
// 읽어 저장소 안 실경로 강제와 입력 해시 결속을 받으므로, 형상을 넓혀도 안전 경계는 그대로다.
// lines는 형상과 무관하게 편입이 선언한 노선 범위라 어느 materializer에서도 요구한다.
//
// 허용 키는 등재 형상이 정하고 그 밖의 키는 거부한다. 미등재 키를 조용히 무시하면 spec이 선언한 입력이
// 읽히지도 해시되지도 않은 채 evidence를 통과해(예: 노선도 편입에 남은 시각표 경로), 선언과 실제 결속이
// 갈린 상태가 무성으로 남는다. 서술 키는 INCLUSION_NARRATIVE_KEYS에 등재된 것만 연다.
function validateInclusionInputs(inclusion, inputs, label) {
  const { paths, linePaths } = materializerInputShape(inclusion.materializer, inputs);
  for (const key of paths) {
    requiredString(inclusion[key], `${label}.${key}`);
  }
  assertKnownKeys(
    inclusion,
    [...INCLUSION_BASE_KEYS, ...INCLUSION_OPTIONAL_KEYS, ...INCLUSION_NARRATIVE_KEYS, ...paths],
    label,
  );
  if (!Array.isArray(inclusion.lines) || inclusion.lines.length === 0) {
    throw new Error(`${label}.lines must be a non-empty array`);
  }
  // lineNumber 생략은 "숫자 노선명이 없다"는 사실에 열리는 것이지 편입이 고를 수 있는 자유가 아니다.
  // 주석으로만 그 범위를 적어 두면 번호가 있는 노선에서도 키가 조용히 빠진다(실측: 9호선·인천 편입 4건이
  // 그렇게 생략돼 있었다) — 생략을 여는 materializer를 allowlist로 못박아 그 밖에서는 키를 요구한다.
  const lineNumberOptional = LINE_NUMBER_OPTIONAL_MATERIALIZERS.includes(inclusion.materializer);
  for (const line of inclusion.lines) {
    // 노선 정체성 축(lineId)은 어느 편입에서든 요구하고 어댑터가 저장소 정본과 대조한다.
    if (lineNumberOptional) {
      if (line?.lineNumber !== undefined) {
        throw new Error(`${label}.lines[].lineNumber must be omitted for lines without a numbered name`);
      }
    } else if (!Number.isInteger(line?.lineNumber) || line.lineNumber <= 0) {
      throw new Error(`${label}.lines[].lineNumber must be a positive integer`);
    }
    requiredString(line?.lineId, `${label}.lines[].lineId`);
    for (const key of linePaths) {
      requiredString(line[key], `${label}.lines[].${key}`);
    }
    assertKnownKeys(line, [...INCLUSION_LINE_BASE_KEYS, ...linePaths], `${label}.lines[]`);
  }
}

// allowlist 항목의 형상 자체도 검사한다. 무검사 구조분해는 형상이 빠진 항목에서 TypeError로 터져
// 진단이 "무엇이 잘못됐나" 대신 스택으로 붕괴한다(in-process seam으로 항목을 넘기는 경로가 그렇다).
function materializerInputShape(materializer, inputs) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)
    || !isPathKeyList(inputs.paths) || !isPathKeyList(inputs.linePaths)) {
    throw new Error(`pack data materializer inputs shape is invalid: ${materializer}`);
  }
  return { paths: inputs.paths, linePaths: inputs.linePaths };
}

// 경로 키 목록은 비어 있어도 된다(그 층에 경로 입력이 없는 materializer). 항목은 전부 비어 있지 않은 문자열이어야 한다.
function isPathKeyList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

function assertKnownKeys(record, knownKeys, label) {
  const known = new Set(knownKeys);
  const unknown = Object.keys(record)
    .filter((key) => !known.has(key))
    .sort(codepointCompare);
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(",")}`);
  }
}

function parseRequirementKey(key, label) {
  const parts = key.split(":");
  if (parts.length !== 4 || parts.some((part) => part.trim() === "")) {
    throw new Error(`${label} must be regionId:operatorId:lineId:sourceDomain: ${key}`);
  }
  const [regionId, operatorId, lineId, sourceDomain] = parts;
  return { regionId, operatorId, lineId, sourceDomain };
}

// candidate pack url은 예약 TLD(.invalid)만 허용한다. 게이트가 root pack artifactKind=production을
// 요구해 production 형태로 서명하지만, 그 산출물이 게시 가능한 호스트를 가리키면 안 된다.
function assertNonPublishablePackUrl(packUrl) {
  let url;
  try {
    url = new URL(packUrl);
  } catch {
    throw new Error("candidate spec pack.url must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new Error("candidate spec pack.url must use https");
  if (url.hostname.toLowerCase().replace(/\.$/, "") !== NON_PUBLISHABLE_HOST) {
    throw new Error(`candidate spec pack.url host must be the non-publishable host ${NON_PUBLISHABLE_HOST}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function requiredStringArray(value, label) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonInput(filePath) {
  const bytes = await readFile(path.resolve(root, filePath));
  return {
    document: JSON.parse(bytes.toString("utf8")),
    input: { path: filePath, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  for (const flag of Object.keys(args)) {
    if (!ALLOWED_FLAGS.has(flag)) throw new Error(`unexpected argument: --${flag}`);
  }
  const outputPath = requireArg(args, "output");
  const spec = await readJsonInput(requireArg(args, "spec"));
  const targets = await readJsonInput(requireArg(args, "targets"));
  const inventory = await readJsonInput(requireArg(args, "inventory"));
  const resolutionPlan = await readJsonInput(requireArg(args, "resolution-plan"));
  const resolutions = await readJsonInput(requireArg(args, "resolutions"));

  const requestedWorkDir = args["work-dir"];
  const workDir = requestedWorkDir
    ? path.resolve(root, requestedWorkDir)
    : await mkdtemp(path.join(tmpdir(), "easysubway-nationwide-candidate-gate-"));
  try {
    await mkdir(workDir, { recursive: true });
    const evidence = await runNationwideCandidateCoverageGate({
      spec: spec.document,
      specInput: spec.input,
      targetsInput: targets.input,
      inventory: inventory.document,
      inventoryInput: inventory.input,
      resolutionPlanInput: resolutionPlan.input,
      resolutionsInput: resolutions.input,
      workDir,
      emitFixturePath: args["emit-fixture"] ?? null,
    });
    await mkdir(path.dirname(path.resolve(root, outputPath)), { recursive: true });
    await writeFile(path.resolve(root, outputPath), `${JSON.stringify(sortJson(evidence), null, 2)}\n`);
  } finally {
    if (!requestedWorkDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
