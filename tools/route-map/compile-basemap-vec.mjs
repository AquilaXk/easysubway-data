#!/usr/bin/env node
// 하이브리드 바탕층(#2068) 컴파일 파이프라인.
//
// 5권역 오너 자작 노선도 SVG에서 현재 운행 노선 형상과 기존 역 심벌만 추출해
// vector_graphics 바이너리(.vec) 오프라인 바탕 자산을 만든다. 역명·인터랙션은
// 구조화 데이터 렌더러가 담당한다. 산출 .vec는
// 원본 SVG의 viewBox 좌표계(예: sma-v2 `0 0 2400 1800`)를 그대로 유지하므로,
// 앱은 designScale 곱셈 없이 카메라 변환만으로 인터랙션 좌표와 1:1 정렬한다.
//
// [결정성 확보] 재실행 시 동일 바이트가 나오도록 다음을 고정한다:
//   1) 입력 불변: svg-sources/*.svg 원본 파일은 수정하지 않는다. 필요한 노선층만
//      추출·정규화한 임시 사본을 만들어 컴파일한다. 원본은 그대로다.
//   2) 컴파일러 버전 고정: pubspec dev_dependencies의 vector_graphics_compiler를
//      `dart run`으로 호출한다(패키지 버전은 pubspec.lock에 잠긴다).
//   3) 재현 검증: `--verify` 플래그로 각 SVG를 2회 컴파일해 두 산출물의 sha256이
//      동일한지 확인한다(비결정적 출력 조기 감지). 검증은 별도 임시 파일에 쓰고
//      비교 후 정리한다 — 커밋 산출물은 1회 컴파일 결과다.
//
// 원본 CSS의 비표준 font-weight도 컴파일러가 파싱할 수 있도록 표준 100 배수로
// 정규화한다. 환승 캡슐 내부 노선 표기는 유지하고 역명·제목·범례는 제외한다.
//
// 사용법(apps/mobile pubspec 컨텍스트가 필요하므로 컴파일은 apps/mobile cwd에서 실행):
//   node tools/route-map/compile-basemap-vec.mjs           # 5권역 컴파일 + sha256 출력
//   node tools/route-map/compile-basemap-vec.mjs --verify  # 2회 컴파일 sha256 동일 검증
//
// build-datapack.mjs의 결정적 빌드 관례(canonicalJson·sha256 산출)와 톤을 맞춘다.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { DAEJEON, DAEGU, BUSAN, GWANGJU, SEOUL } from "./sma-region-configs.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const svgSourceDir = path.join(
  root,
  "tools/route-map/route-map-defs/svg-sources",
);
const mobileDir = path.join(root, "apps/mobile");
const outDir = path.join(
  mobileDir,
  "assets/datapacks/metro_map_pack/basemap",
);
const dartBin = process.env.DART_BIN ?? "dart";
const compilerVersion = "1.2.6";
// 바탕층 컴파일 파이프라인의 산출 의미 개정 번호(#2068 리뷰 M2, 2026-07-26).
// compiler.version(=pubspec.lock에 잠긴 vector_graphics_compiler 패키지 버전)과
// 분리해, "무엇을 굽는가"가 바뀔 때만 올린다.
//   1 — 노선 형상 + 역 심벌만 굽던 시기(라벨은 앱 솔버가 그림)
//   2 — 지도 본문 레이어 전수(역명 라벨·표장·중간표기·노선번호 배지 포함)를 굽고
//       캔버스 장식은 명시 계약으로 제외(오너 결정 "글자도 복붙"·"장식 제거")
const basemapPipelineRevision = 2;
const buildManifestPath = path.join(
  root,
  "tools/route-map/basemap-build-manifest.json",
);

// manifest maps[].id → 원본 SVG 파일명. .vec 파일명은 manifest id를 따른다.
const regions = [
  { id: "seoul", svg: "easy-subway-sma-v4.svg" },
  { id: "busan", svg: "easy-subway-busan-v3.svg" },
  { id: "daegu", svg: "easy-subway-daegu-v3.svg" },
  { id: "daejeon", svg: "easy-subway-daejeon-v3.svg" },
  { id: "gwangju", svg: "easy-subway-gwangju-v3.svg" },
];

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256Value(value) {
  return createHash("sha256").update(value).digest("hex");
}

// 비표준 font-weight를 가장 가까운 표준 100 배수(100~900 clamp)로 정규화한다.
// 순수 함수 — 동일 입력에 동일 출력이라 컴파일 결정성을 해치지 않는다.
function normalizeFontWeightValue(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return raw;
  }
  const rounded = Math.round(n / 100) * 100;
  return String(Math.min(900, Math.max(100, rounded)));
}

// 노선 형상·역 심벌만 추출하고 컴파일러가 거부하는 SVG 속성을 정규화한다(원본 불변).
//   1) 비표준 font-weight: 속성형·CSS 선언형 모두 가장 가까운 100 배수로.
//   2) 다중값 x/y/dx/dy(예: <text dy="0 0 0 0">의 per-glyph 리스트): 컴파일러의
//      DoubleOrPercentage.fromString은 단일 double만 파싱하므로 첫 토큰만 남긴다.
//      (#2068 2026-07-26 정정: "해당 값은 전부 0 리스트"는 더 이상 사실이 아니다 —
//      busan v3 벡스코가 `dy="0 0 … 59.27"`(19값)를 쓴다. 다만 그 라벨의 글자
//      수(3)가 0이 아닌 값의 인덱스(18)보다 작아 렌더 결과는 여전히 동일하다.
//      sidecar 추출도 firstCoordinateToken으로 같은 "첫 토큰만" 규칙을 쓴다.)
//      `\b`가 아니라 앞에 `[\s"']` 경계를 둬 viewBox 등 다른 속성명은 건드리지 않는다.
const supportedClassStyleProperties = new Set([
  "alignment-baseline",
  "display",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "opacity",
  "paint-order",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
]);

function extractGroup(svgText, groupId) {
  const id = `id="${groupId}"`;
  const idIndex = svgText.indexOf(id);
  if (idIndex < 0) return "";
  const groupStart = svgText.lastIndexOf("<g", idIndex);
  if (groupStart < 0) return "";

  // #2068 오너 v3 반입 실측: 내용이 빈 레이어를 편집기가 자기폐쇄 태그
  // (`<g id="service-tags-layer" ... />`)로 마감하는 경우가 있다(busan v3의
  // service-tags-layer — v1은 같은 빈 레이어를 `<g ...></g>`로 썼다). 아래
  // depth 카운터는 자기폐쇄 태그로 depth를 올리지 않으므로, 이 태그에서
  // 시작하면 depth가 0인 채로 다음 형제 레이어까지 삼켜 첫 `</g>`에서 끊긴다
  // — 그 결과 allow-list 밖 레이어(station-name-labels-layer 등)가 바탕층에
  // 딸려 들어간다. 자기폐쇄 여는 태그면 그 태그 하나가 곧 빈 그룹 전체다.
  const selfClosingGroup = svgText.slice(groupStart).match(/^<g\b[^>]*?\/>/);
  if (selfClosingGroup) return selfClosingGroup[0];

  const groupTags = /<\/?g\b[^>]*>/g;
  groupTags.lastIndex = groupStart;
  let depth = 0;
  let groupEnd = -1;
  for (let match = groupTags.exec(svgText); match; match = groupTags.exec(svgText)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        groupEnd = groupTags.lastIndex;
        break;
      }
    } else if (!match[0].endsWith("/>")) {
      depth += 1;
    }
  }
  if (groupEnd < 0) {
    throw new Error(`${groupId}의 닫는 태그를 찾지 못했습니다.`);
  }
  return svgText.slice(groupStart, groupEnd);
}

function roundRouteStrokes(group) {
  return group.replace(/<(path|line|polyline)\b([^>]*)>/g, (_match, tag, raw) => {
    const selfClosing = /\/\s*$/.test(raw);
    const attributes = raw
      .replace(/\/\s*$/, "")
      .replace(/\s+stroke-linecap="[^"]*"/g, "")
      .replace(/\s+stroke-linejoin="[^"]*"/g, "");
    return `<${tag}${attributes} stroke-linecap="round" stroke-linejoin="round"${selfClosing ? " /" : ""}>`;
  });
}

function keepGwangjuLine1Stations(group) {
  return group.replace(/<circle\b[^>]*\/>/g, (circle) =>
    circle.includes('stroke="#009088"') ? circle : ""
  );
}

function currentLineStationsFromFutureTransfers(svgText, config) {
  let transferLayer = extractGroup(svgText, "transfer-station-symbols-layer");
  for (const match of transferLayer.matchAll(
    /<g\b(?=[^>]*\bid="([^"]+)")(?=[^>]*\bdata-state="planned")[^>]*>/g,
  )) {
    transferLayer = transferLayer.replace(extractGroup(transferLayer, match[1]), "");
  }
  const circles = [...transferLayer.matchAll(/<circle\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((circle) =>
      new RegExp(`\\bfill="${config.color}"`, "i").test(circle),
    )
    .map((circle, index) => {
      const cx = circle.match(/\bcx="([^"]+)"/)?.[1];
      const cy = circle.match(/\bcy="([^"]+)"/)?.[1];
      if (cx == null || cy == null) {
        throw new Error("미개통 환승 노드의 현재 노선 좌표를 찾지 못했습니다.");
      }
      return `    <circle id="current-line-transfer-station-${index + 1}" data-role="current-line-station" cx="${cx}" cy="${cy}" r="${config.radius}" fill="#FFFFFF" stroke="${config.color}" stroke-width="${config.strokeWidth}" />`;
    });
  return [
    '  <g id="current-line-transfer-station-symbols-layer">',
    ...circles,
    "  </g>",
  ].join("\n");
}

// 지도 본문을 통째로 감싸는 래퍼 레이어 id(바깥 → 안 순서). 권역마다 이름이
// 다르지만 성격은 같다 — 그 안의 모든 좌표가 래퍼 transform을 거쳐 최종 root
// 좌표가 되므로, 컴파일(.vec)·오너 라벨 sidecar·표장 obstacle이 전부 같은
// 변환을 흡수해야 팩 좌표(route_map_positions)와 한 좌표계에 놓인다.
//   - main-map-scaled-layer      : seoul(translate + scale(0.455))
//   - map-content-positioned-layer: daejeon v3(translate(0 88) — 오너가 상단
//     안내 영역과의 겹침을 피하려고 본문을 88px 내렸다. #2068 실측)
// 두 래퍼가 한 SVG에 함께 오면 SVG transform 합성 규칙과 같은 순서로 이어
// 붙인다(현행 5권역 소스에는 각각 하나씩만 존재).
const MAP_WRAPPER_LAYER_IDS = [
  "main-map-scaled-layer",
  "map-content-positioned-layer",
];

function mapWrapperTransform(svgText) {
  const parts = MAP_WRAPPER_LAYER_IDS.map(
    (layerId) =>
      svgText.match(
        new RegExp(
          `<g\\b(?=[^>]*\\bid="${layerId}")(?=[^>]*\\btransform="([^"]+)")[^>]*>`,
        ),
      )?.[1],
  ).filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

// ── 지도 본문 / 캔버스 장식 분류 계약(#2068 오너 결정 2026-07-26) ─────────────
//
// 오너 판정: "버그 전부 SVG를 그대로 가져다 쓰지 않아서 발생". 바탕층(.vec)은
// 오너 SVG의 **지도 본문 요소 전수**(노선·심벌·배지·표장·역명 라벨)를 그대로
// 굽는다. 반대로 캔버스 장식(제목·헤더·범례·상단 설명 박스·카드 배경/테두리)은
// 앱이 자체 UI로 그리므로 반입하지 않는다(오너 추가 지시 2026-07-26).
//
// 두 목록을 **명시 계약**으로 선언한다 — 화이트리스트에 "없어서" 조용히 빠지는
// 구조를 금지한다. 새 레이어가 오너 SVG에 생기면 세 목록 어디에도 없어서
// classifyLayerId가 "unclassified"를 내고 분류 완전성 게이트
// (compile-basemap-vec.test.mjs)가 실패한다 — 사람이 본문/장식/구조 래퍼를
// 판정해 등재해야 한다. 반대 방향(장식이 조용히 반입되는 것)도 같은 게이트가
// 컴파일 산출 안에 장식 id가 없음을 확인해 막는다.

// 역명 라벨 레이어 자리표시자 — 실제 id가 권역마다 달라(아래
// resolveStationNameLabelLayerId) 런타임에 해석한다. 반입 순서(z-순서)에서의
// 위치만 이 상수로 고정한다.
const LABEL_LAYER_PLACEHOLDER_ID = "@station-name-labels-layer";

// 지도 본문 레이어 — 아래 순서대로 이어붙여 컴파일한다(= 렌더 z-순서, 오너 SVG
// 문서 순서와 동일). 미보유 권역은 extractGroup이 빈 문자열을 내 영향이 없다.
const MAP_BODY_LAYER_IDS = [
  "transfer-station-shell-underlay-layer",
  "route-lines-layer",
  // #2408 수도권: 오너가 직접 제작한 종점 노선 심볼 연결 연장선. route-lines-layer
  // 직후(오너 SVG 문서 순서)에 이어 노선 형상과 같은 하단 층위로 렌더한다.
  "terminal-route-extensions-layer",
  "route-endpoint-markers-layer",
  "terminal-station-symbols-layer",
  "station-symbols-layer",
  "transfer-station-symbols-layer",
  // #2068 SVG 충실도(2026-07-26): 수도권 노선 중간 표기(route-midline-markers-v2).
  // 지도 본문 심벌인데도 allow-list에 없어 조용히 누락돼 있었다 — 오너 도식에는
  // 있고 앱에는 없던 차이. 오너 문서 순서대로 환승 심벌 위·종점 배지 아래에 둔다.
  "route-midline-markers-layer",
  // #2408 수도권: 오너 직접 제작 종점 노선 심볼(캡슐 배지). 각 칩 그룹의 축정렬
  // 스케일은 foldTerminalChipScale이 선보정한다.
  "terminal-route-badges-layer",
  // #2068 종점 호선 마크(원+숫자/캡슐) — 대구 전용. 수도권은 #2408에서 이 레이어를
  // 걷어내고 terminal-route-badges-layer(오너 칩)로 대체했다(상호배타).
  "line-terminal-badges-layer",
  // #2068 KTX·SRT·공항 표장: service-tag(inline-svg-paths 벡터 로고) 레이어.
  "service-tags-layer",
  // #2068 대전·광주 v1 형식의 rail chip 레이어(v3 재제작본에서는 비었거나 없음).
  "rail-transfer-layer",
  // #2068 SVG 충실도(2026-07-26, 오너 결정): **역명 라벨도 바탕층에 그대로 굽는다.**
  // "글자도 복붙" — 화면이 SVG와 픽셀 동일해야 한다. 이 레이어는 권역마다 id가
  // 달라(id 또는 class=label-layer) resolveStationNameLabelLayerId가 해석한다.
  // 대전·광주의 KTX·SRT 표장(rail-service-marks)이 이 레이어 안에 있어 함께 반입된다.
  LABEL_LAYER_PLACEHOLDER_ID,
  // #2068 대전: 지도 본문 위 노선 번호 배지(map-line-number-badge). 오너 문서
  // 순서상 역명 라벨 다음(최상단)이다.
  "route-number-badges-layer",
];

// 좌표계를 옮기기만 하는 구조 래퍼 — 그 자체는 본문도 장식도 아니고, 자식이
// 각각 분류된다. compiled-map-coordinate-layer(mapWrapperTransform)가 이 변환을
// 흡수한다.
const STRUCTURAL_WRAPPER_LAYER_IDS = [
  "map-card-clipped-content-layer",
  "main-map-scaled-layer",
  "map-content-positioned-layer",
  "subway-map-all-current-lines-layer",
];

// 캔버스 장식 — 바탕층에 절대 반입하지 않는다(오너 지시 2026-07-26). 앱이 자체
// 헤더·범례 UI로 그리는 영역이라 바탕층에 들어가면 지도 위에 유령 텍스트로 남는다.
const EXCLUDED_DECOR_LAYERS = [
  {
    id: "header-title-legend-and-status-layer",
    reason: "제목·상태 배지 헤더 바 — 앱 앱바가 담당",
  },
  {
    id: "header-complete-route-badges-layer",
    reason: "헤더 전체 노선 약어 배지 — 앱 범례 UI가 담당",
  },
  {
    id: "top-route-line-explanation-layer",
    reason: "상단 간선 노선 설명 박스(범례) — 앱 범례 UI가 담당",
  },
  { id: "legend-layer", reason: "광주 범례 — 앱 범례 UI가 담당" },
  {
    id: "route-label-badges-layer",
    reason:
      "오너가 display:none으로 폐기한 구버전 노선 중간표기(route-midline-markers-v2로 대체)",
  },
  {
    id: "sma-v4-component-spec-library",
    reason: "컴포넌트 규격 견본(display:none) — 지도 본문 아님",
  },
  { id: "header-line-chip", reason: "광주 헤더 노선 칩" },
  { id: "header-status-chip", reason: "광주 헤더 상태 칩" },
];

const EXCLUDED_DECOR_LAYER_ID_SET = new Set(
  EXCLUDED_DECOR_LAYERS.map((layer) => layer.id),
);

// 역명 라벨 레이어 id는 권역마다 다르다(실측):
//   busan·daegu·daejeon·gwangju : id="station-name-labels-layer"
//   seoul                        : id="station-label-group-전곡"(Inkscape가 첫 역명
//                                  그룹 id를 상속시킨 사고성 이름) — 공통 표식은
//                                  class="label-layer"뿐이다.
// id 우선, 없으면 class=label-layer로 해석한다. 둘 다 없으면 null(라벨 레이어
// 미보유 권역 — 현행 5권역엔 없음).
export function resolveStationNameLabelLayerId(svgText) {
  if (svgText.includes('id="station-name-labels-layer"')) {
    return "station-name-labels-layer";
  }
  const classMatch = svgText.match(
    /<g\b(?=[^>]*\bclass="[^"]*\blabel-layer\b[^"]*")[^>]*\bid="([^"]+)"[^>]*>/,
  );
  return classMatch ? classMatch[1] : null;
}

/**
 * 레이어 id 하나를 본문/장식/구조 래퍼로 분류한다. 세 목록 어디에도 없으면
 * "unclassified" — 분류 완전성 게이트가 실패한다(조용한 누락·조용한 반입 금지).
 */
export function classifyLayerId(layerId, labelLayerId) {
  if (layerId === labelLayerId) return "map-body";
  if (MAP_BODY_LAYER_IDS.includes(layerId)) return "map-body";
  if (EXCLUDED_DECOR_LAYER_ID_SET.has(layerId)) return "decor";
  if (STRUCTURAL_WRAPPER_LAYER_IDS.includes(layerId)) return "structural";
  return "unclassified";
}

/** 권역 SVG의 레이어 후보 id 전수(= 분류 게이트 입력). */
export function svgLayerCandidateIds(svgText) {
  const ids = new Set();
  for (const match of svgText.matchAll(/<g\b[^>]*>/g)) {
    const tag = match[0];
    const id = (tag.match(/\bid="([^"]*)"/) || [])[1];
    if (!id) continue;
    const className = (tag.match(/\bclass="([^"]*)"/) || [])[1] ?? "";
    const classes = className.split(/\s+/);
    if (
      id.endsWith("-layer") ||
      classes.includes("render-layer") ||
      classes.includes("label-layer")
    ) {
      ids.add(id);
    }
  }
  return [...ids].sort(codepointCompare);
}

// ── KTX·SRT 표장 전수 수집(#2068 오너 지적 2026-07-26) ────────────────────────
//
// 종전 구현은 수도권 표장을 id 정규식 두 개
// (`logo-ktx-inline-vector-footer-0-6-9-\d+` · `logo-srt-inline-vector-footer-2-6-2-\d+`)
// 로만 잡았다. 오너가 v4에서 일부 마크를 `<g id="rail-service-logo-chip-ktx-srt">`
// 안으로 옮기면서 그 id들이 패턴을 벗어나 **실제 역 표장 6건이 조용히 누락**됐다
// (실측: 반입 18/24 — 누락분은 전부 chip 안의 비어 있지 않은 로고 그룹).
// 패턴 나열을 버리고 **문서 전수 수집 + 명시 제외**로 뒤집는다.
//
// 표장 판정(오너 지시 그대로): `<g>`의 id/class에 logo-ktx·logo-srt가 있거나,
// id가 rail-service-marks-로 시작하거나, class에 rail-service-marks·service-tag가
// 있거나, data-services 속성이 있는 요소.
const MARK_ID_PATTERN = /logo-ktx|logo-srt|^rail-service-marks-/;
const MARK_CLASS_NAMES = ["rail-service-marks", "service-tag"];

function isServiceMarkOpenTag(openTag) {
  const id = (openTag.match(/\bid="([^"]*)"/) || [])[1] ?? "";
  const className = (openTag.match(/\bclass="([^"]*)"/) || [])[1] ?? "";
  if (/\bdata-services="/.test(openTag)) return true;
  if (MARK_ID_PATTERN.test(id)) return true;
  if (/logo-ktx|logo-srt/.test(className)) return true;
  return className.split(/\s+/).some((name) => MARK_CLASS_NAMES.includes(name));
}

// SVG 요소 트리(여는 태그 스트림 기반). 표장 전수 수집과 장식 bbox 판정만
// 사용한다 — 기존 레이어 슬라이스 경로(extractGroup)는 그대로 둔다.
function buildSvgTree(svgText) {
  const root = {
    name: "#root",
    openTag: "",
    start: 0,
    end: svgText.length,
    children: [],
    parent: null,
  };
  const stack = [root];
  for (const match of svgText.matchAll(
    /<(\/?)([A-Za-z][\w:.-]*)\b([^>]*?)(\/?)>/g,
  )) {
    const [full, closing, name, , selfClosing] = match;
    if (closing) {
      if (stack.length > 1) {
        stack[stack.length - 1].end = match.index + full.length;
        stack.pop();
      }
      continue;
    }
    const node = {
      name,
      openTag: full,
      start: match.index,
      end: match.index + full.length,
      children: [],
      parent: stack[stack.length - 1],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function nodeAttr(node, name) {
  return (node.openTag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
}

function isHiddenNode(node) {
  if (nodeAttr(node, "display") === "none") return true;
  const style = nodeAttr(node, "style") ?? "";
  return /display\s*:\s*none/.test(style);
}

/** 조상(자기 자신 제외) transform 체인을 합성한 행렬. */
function ancestorMatrixOf(node) {
  const chain = [];
  for (let p = node.parent; p && p.name !== "#root"; p = p.parent) chain.unshift(p);
  let matrix = IDENTITY_MATRIX;
  for (const ancestor of chain) {
    const transform = nodeAttr(ancestor, "transform");
    if (transform) matrix = composeMatrix(matrix, parseTransformChain(transform));
  }
  return matrix;
}

/** 여는 태그와 닫는 태그 사이의 본문 텍스트(자기폐쇄면 빈 문자열). */
function nodeInnerText(svgText, node) {
  if (node.openTag.endsWith("/>")) return "";
  const innerStart = node.start + node.openTag.length;
  const innerEnd = Math.max(node.end - `</${node.name}>`.length, innerStart);
  return svgText.slice(innerStart, innerEnd);
}

function nodeBounds(svgText, node, matrix) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const ownTransform = nodeAttr(node, "transform");
  const own = ownTransform
    ? composeMatrix(matrix, parseTransformChain(ownTransform))
    : matrix;
  collectShapeBoundsRecursive(nodeInnerText(svgText, node), own, (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// ── 장식 표장 견본 명시 목록(#2068 리뷰 M5, 2026-07-26) ──────────────────────
//
// 오너 수도권 v4는 헤더 범례용 KTX·SRT 로고 **견본** 2건을 지도 본문 마크 6건과
// **같은 chip 그룹 안**(`rail-service-logo-chip-ktx-srt`)에 담았다 — 컨테이너
// 소속으로는 못 가른다. 종전 구현은 오직 기하 규칙(장식 레이어 bbox 안이면 장식)
// 하나로 갈랐는데, 실측 여유가 **148단위(viewBox 높이의 4.9%)** 뿐이라
// (최상단 본문 표장 `logo-ktx-inline-vector-footer-0-6-9-4`의 minY=388.23 vs
// 상단 설명 박스 하단 240) 오너가 상단 설명 박스를 키우거나 도면 최상단 역에
// 표장을 추가하면 **본문 표장이 조용히 장식으로 오판**돼 바탕층에서 사라진다.
//
// 그래서 판정을 두 단계로 나눈다:
//   1) **명시 견본 목록**(아래) — id가 확정된 장식 견본만 무조건 제외한다.
//      오너가 견본을 어디로 옮겨도 제외가 유지되고, 반대로 본문 표장이 장식
//      영역에 가까워져도 이 목록에 없으면 절대 제외되지 않는다.
//   2) **기하 판정**(장식 레이어 bbox 안) — 목록에 없는 표장이 장식 영역에
//      들어앉으면 **조용히 빼지 않고 실패**시킨다(fail-closed). 새 장식 견본이
//      생기면 사람이 아래 목록에 사유와 함께 등재해야 한다.
// 두 규칙의 조합으로 "조용한 누락 금지" 원칙이 기하 여유와 무관하게 성립한다.
export const DECOR_SERVICE_MARK_SAMPLE_IDS = [
  {
    id: "logo-ktx-inline-vector-footer-0",
    reason:
      "수도권 헤더 상단 설명 박스의 KTX 범례 견본(translate(1400 0)로 헤더 배지 프레임에 얹혀 있다) — 지도 본문 표장 아님",
  },
  {
    id: "logo-srt-inline-vector-footer-2",
    reason:
      "수도권 헤더 상단 설명 박스의 SRT 범례 견본(위와 같은 프레임) — 지도 본문 표장 아님",
  },
];

const DECOR_SERVICE_MARK_SAMPLE_ID_SET = new Set(
  DECOR_SERVICE_MARK_SAMPLE_IDS.map((sample) => sample.id),
);

/**
 * 장식 레이어들의 절대 bbox 합집합. 명시 견본 목록 밖의 표장이 이 영역에
 * 들어앉으면 fail-closed로 빌드를 실패시키는 데 쓴다(위 주석 참고).
 */
export function decorLayerBoundsOf(svgText) {
  return decorBoundsOf(svgText, buildSvgTree(svgText));
}

function decorBoundsOf(svgText, root) {
  const bounds = [];
  (function walk(node) {
    for (const child of node.children) {
      const id = nodeAttr(child, "id");
      if (id && EXCLUDED_DECOR_LAYER_ID_SET.has(id)) {
        // 렌더되지 않는 장식(display:none)은 화면에 영역을 차지하지 않으므로
        // 판정 영역에서 뺀다 — 넣으면 수도권 route-label-badges-layer(폐기된
        // 구버전 중간표기, 지도 본문 전역에 걸쳐 있다)의 bbox가 지도 대부분을
        // 덮어 정상 표장까지 장식으로 오판한다(실측: 수도권 표장 17→4).
        if (!isHiddenNode(child)) {
          const box = nodeBounds(svgText, child, ancestorMatrixOf(child));
          if (box) bounds.push(box);
        }
        continue; // 장식 레이어 내부는 더 볼 필요 없다.
      }
      walk(child);
    }
  })(root);
  return bounds;
}

function centerInsideAny(box, boxes) {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return boxes.some(
    (b) => cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY,
  );
}

/**
 * 지도 본문 표장 전수(문서 순서). 반환 항목:
 *   { id, markup, ancestorTransform, bounds, insideBodyLayer }
 * - `insideBodyLayer`: 이미 본문 레이어 슬라이스로 반입되는 표장(부산 station-symbols
 *   -layer, 대구 service-tags-layer, 대전·광주 역명 라벨 레이어). 중복 반입을
 *   막으려고 별도 반입은 하지 않지만 전수 대조 게이트의 분모에는 포함한다.
 * - 제외: display:none(자신·조상), 시각 내용이 없는 빈 그룹, 장식 레이어 소속·
 *   장식 영역 안(헤더 범례 견본), 이미 표장으로 잡힌 요소의 하위 서브그룹.
 */
export function collectServiceMarks(svgText) {
  const root = buildSvgTree(svgText);
  const labelLayerId = resolveStationNameLabelLayerId(svgText);
  const bodyLayerIds = new Set(
    MAP_BODY_LAYER_IDS.filter((id) => id !== LABEL_LAYER_PLACEHOLDER_ID),
  );
  if (labelLayerId) bodyLayerIds.add(labelLayerId);
  const decorBounds = decorBoundsOf(svgText, root);
  const marks = [];

  (function walk(node, inDecor, inBodyLayer) {
    for (const child of node.children) {
      if (child.name === "defs" || child.name === "style") continue;
      const id = nodeAttr(child, "id") ?? "";
      const childInDecor = inDecor || EXCLUDED_DECOR_LAYER_ID_SET.has(id);
      const childInBody = inBodyLayer || bodyLayerIds.has(id);
      if (isHiddenNode(child)) continue; // display:none 견본·폐기 레이어.
      // 표장 그룹을 더 담고 있는 `<g>`는 마크가 아니라 컨테이너다(수도권
      // `rail-service-logo-chip-ktx-srt`는 data-services를 달고 있으면서 안에
      // 로고 그룹 8개를 담는다 — 컨테이너를 마크로 세면 지도 절반을 덮는 bbox
      // 하나가 되고 실제 마크 8건이 통째로 사라진다). 내부 마크를 개별로 센다.
      if (
        child.name === "g" &&
        isServiceMarkOpenTag(child.openTag) &&
        !containsNestedServiceMark(child)
      ) {
        const bounds = nodeBounds(svgText, child, ancestorMatrixOf(child));
        // 시각 내용이 없는 빈 표장(오너 소스의 잔재 `<g/>`)은 반입 대상이 아니다.
        if (!bounds) {
          walk(child, childInDecor, childInBody);
          continue;
        }
        // (1) 명시 견본 목록 — id가 확정된 장식 견본만 무조건 제외한다.
        if (DECOR_SERVICE_MARK_SAMPLE_ID_SET.has(id)) continue;
        // (2) 장식 레이어 소속이면 제외(레이어 단위 계약).
        if (childInDecor) continue;
        // (3) 명시 목록에 없는데 장식 영역에 들어앉았다 — 조용히 빼지 않고
        //     실패시킨다. 종전에는 여기서 조용히 제외해, 오너가 상단 설명 박스를
        //     키우거나 도면 최상단에 표장을 추가하면 본문 표장이 소리 없이
        //     사라졌다(#2068 리뷰 M5). 새 장식 견본이면 사람이
        //     DECOR_SERVICE_MARK_SAMPLE_IDS에 사유와 함께 등재해야 한다.
        if (centerInsideAny(bounds, decorBounds)) {
          throw new Error(
            `표장 ${id || "(id 없음)"}가 장식 레이어 영역 안에 있습니다 ` +
              `(bbox [${bounds.minX.toFixed(1)},${bounds.minY.toFixed(1)} .. ` +
              `${bounds.maxX.toFixed(1)},${bounds.maxY.toFixed(1)}]). ` +
              "지도 본문 표장이면 장식 레이어 bbox와 겹치지 않게 오너 SVG를 확인하고, " +
              "장식 견본이면 DECOR_SERVICE_MARK_SAMPLE_IDS에 사유와 함께 등재하세요 " +
              "— 조용히 누락시키지 않고 실패합니다.",
          );
        }
        marks.push({
          id,
          markup: svgText.slice(child.start, child.end),
          ancestorTransform: ancestorTransformValue(child),
          bounds,
          insideBodyLayer: childInBody,
        });
        continue; // 하위 서브그룹(로고 path 묶음)은 이 마크에 포함된다.
      }
      walk(child, childInDecor, childInBody);
    }
  })(root, false, false);

  return marks;
}

/** 자손에 표장 `<g>`가 하나라도 있으면 true(= 이 노드는 마크가 아니라 컨테이너). */
function containsNestedServiceMark(node) {
  return node.children.some(
    (child) =>
      (child.name === "g" && isServiceMarkOpenTag(child.openTag)) ||
      containsNestedServiceMark(child),
  );
}

/** 조상 transform 속성값들을 바깥→안 순서로 이어 붙인 문자열(없으면 ""). */
function ancestorTransformValue(node) {
  const values = [];
  for (let p = node.parent; p && p.name !== "#root"; p = p.parent) {
    const transform = nodeAttr(p, "transform");
    if (transform) values.unshift(transform);
  }
  return values.join(" ");
}

function extractMapSvg(svgText) {
  const svgStart = svgText.match(/<svg\b[^>]*>/)?.[0];
  if (!svgStart) throw new Error("SVG 루트 태그를 찾지 못했습니다.");

  const defs = [...svgText.matchAll(/<defs\b[^>]*>[\s\S]*?<\/defs>/g)]
    .map((match) => match[0])
    .join("\n");
  const styles = defs
    ? ""
    : [...svgText.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/g)]
        .map((match) => match[0])
        .join("\n");
  const mapTransform = mapWrapperTransform(svgText);
  const regionalSingleLine = /id="(?:gwangju|daejeon)-metro-/.test(svgStart);
  const gwangju = svgStart.includes('id="gwangju-metro-');
  const currentLineTransferStations = regionalSingleLine
    ? currentLineStationsFromFutureTransfers(
        svgText,
        gwangju
          ? { color: "#009088", radius: "20", strokeWidth: "6" }
          : { color: "#00975A", radius: "15", strokeWidth: "4.5" },
      )
    : "";
  // 지도 본문 레이어 목록은 MAP_BODY_LAYER_IDS(명시 계약)를 그대로 쓴다.
  // 라벨 레이어 자리표시자만 권역별 실제 id로 치환하고, 광주·대전 단일노선
  // 권역은 미개통 환승 심벌을 별도 경로로 합성하므로 transfer-station-symbols
  // -layer를 건너뛴다(기존 동작 유지).
  const labelLayerId = resolveStationNameLabelLayerId(svgText);
  const layerIds = MAP_BODY_LAYER_IDS.map((id) =>
    id === LABEL_LAYER_PLACEHOLDER_ID ? labelLayerId : id,
  ).filter(
    (id) =>
      Boolean(id) &&
      !(regionalSingleLine && id === "transfer-station-symbols-layer"),
  );
  const mapGroup = [
    ...layerIds.map((id) => {
      const group = extractGroup(svgText, id);
      if (id === "route-lines-layer") return roundRouteStrokes(group);
      if (gwangju && id === "station-symbols-layer") {
        return keepGwangjuLine1Stations(group);
      }
      return group;
    }),
  ]
    .filter(Boolean)
    .join("\n")
    .replace(
      /<g\b(?=[^>]*data-state="(?:construction|planned)")[^>]*>[\s\S]*?<\/g>/g,
      "",
    )
    .replace(
      /<(?:path|polyline)\b(?=[^>]*data-status="planned-unbuilt")[^>]*\/>/g,
      "",
    )
    .replace(
      /<(?:path|polyline)\b(?=[^>]*data-line="line2-phase[^"]*")[^>]*\/>/g,
      "",
    )
    .replace(
      /<circle\b(?=[^>]*stroke="#E63332")[^>]*\/>/g,
      regionalSingleLine ? "" : "$&",
    )
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/g, "");
  let renderedMap = currentLineTransferStations
    ? `${mapGroup}\n${currentLineTransferStations}`
    : mapGroup;
  if (mapTransform) {
    renderedMap = `<g id="compiled-map-coordinate-layer" transform="${mapTransform}">\n${renderedMap}\n</g>`;
  }
  if (!mapGroup.includes('id="route-lines-layer"')) {
    throw new Error("route-lines-layer를 SVG에서 찾지 못했습니다.");
  }
  // #2068 표장 전수 반입(2026-07-26): 오너가 직접 배치한 KTX·SRT 표장 중 본문
  // 레이어 밖(수도권은 main-map-scaled-layer 밖 최상위 형제, 일부는
  // `<g id="rail-service-logo-chip-ktx-srt">` 안)에 있는 것들을 여기서 이어
  // 붙인다. 각 마크는 자기 조상 transform 체인을 그대로 두른 래퍼 `<g>`에 담아
  // mapTransform 밖 형제로 넣는다 — 조상 변환을 포함한 절대 좌표가 보존되고,
  // 안에 넣었을 때 생기는 이중 스케일이 없다. 본문 레이어 안에 이미 있는 표장
  // (부산 station-symbols-layer, 대구 service-tags-layer, 대전·광주 역명 라벨
  // 레이어)은 insideBodyLayer로 걸러 중복 반입하지 않는다.
  const outsideMarks = collectServiceMarks(svgText).filter(
    (mark) => !mark.insideBodyLayer,
  );
  if (outsideMarks.length) {
    const wrapped = outsideMarks
      .map((mark) =>
        mark.ancestorTransform
          ? `<g transform="${mark.ancestorTransform}">\n${mark.markup}\n</g>`
          : mark.markup,
      )
      .join("\n");
    renderedMap = `${renderedMap}\n<g id="owner-rail-service-marks-layer" data-name="오너 KTX·SRT 마크(원본 root 좌표 보존)">\n${wrapped}\n</g>`;
  }
  return `${svgStart}\n${defs || styles}\n${renderedMap}\n</svg>`;
}

function inlineSimpleClassStyles(svgText) {
  const rules = [];
  const css = [...svgText.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    const declarations = match[2]
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.split(/:(.*)/s).slice(0, 2).map((part) => part.trim()))
      .filter(
        ([property, value]) =>
          supportedClassStyleProperties.has(property) && !value.includes("var("),
      );
    for (const selector of match[1].split(",").map((item) => item.trim())) {
      if (/^(\.[A-Za-z_][\w-]*)+$/.test(selector)) {
        rules.push({
          classes: selector.slice(1).split("."),
          declarations,
        });
      }
    }
  }

  return svgText.replace(/<([A-Za-z][\w:-]*)\b([^<>]*\bclass="([^"]+)"[^<>]*)>/g, (
    tag,
    name,
    attributes,
    classValue,
  ) => {
    const selfClosing = /\/\s*$/.test(attributes);
    attributes = attributes.replace(/\/\s*$/, "");
    const classes = new Set(classValue.split(/\s+/));
    const declarations = rules
      .filter((rule) => rule.classes.every((className) => classes.has(className)))
      .flatMap((rule) => rule.declarations);
    for (const [property, value] of declarations) {
      const attributePattern = new RegExp(`\\s${property}="[^"]*"`);
      const attribute = ` ${property}="${value.replace(/\s*!important\s*$/, "")}"`;
      attributes = attributePattern.test(attributes)
        ? attributes.replace(attributePattern, attribute)
        : `${attributes}${attribute}`;
    }
    return `<${name}${attributes}${selfClosing ? " /" : ""}>`;
  });
}

// compiled-map-coordinate-layer 래퍼의 `scale(k)`에서 k를 파싱한다(없으면 1).
// `scale(x y)` 2값 형식은 첫 값을 쓴다(축정렬 가정과 정합).
function scaleFromMapTransform(transform) {
  if (!transform) return 1;
  const match = transform.match(/scale\(\s*(-?[\d.]+)/);
  const k = match ? Number(match[1]) : 1;
  return Number.isFinite(k) ? k : 1;
}

// 결정성 유지를 위해 고정 소수 4자리로 직렬화(trailing zero는 Number가 정리).
function roundCoord(value) {
  return Number(value.toFixed(4));
}

// 오너 SVG 라벨 실측 좌표 추출(#2068 6차) — 자동 솔버가 밀집부에서 선을
// 가로지르는 한계를, 오너가 SVG에서 손으로 배치한 역명 라벨 앵커로 대체한다.
// station-name-labels-layer(및 gwangju의 동등 레이어)는 컴파일 대상(.vec)에서
// 제외되므로(제목·범례·역명은 구조화 오버레이가 담당) 원본 svgText에서 별도
// 추출해 sidecar JSON으로 낸다.
//
// 5권역 실측(2026-07) 결과 마크업이 서로 다르다:
//   - seoul/busan/daegu/daejeon: data-label-role이 <text> 태그 자체에 있다.
//   - gwangju: data-label-role이 감싸는 <g>에 있고 바로 안에 <text>가 온다.
// 위치도 2형식이 섞여 있다: x/y 속성형(대부분) / transform="translate(a b)"
// + tspan x="0" y="0" 형(예: 뚝섬). 드물게(인천 다중행 라벨 2건) 양쪽 다 있어
// "발견한 모든 translate 오프셋의 합 + text(또는 첫 tspan) x/y"라는 단일
// 공식을 쓴다 — SVG 렌더 의미(자신의 transform이 좌표계를 옮긴 뒤 그 안에서
// x/y를 해석)와 정확히 일치해 모든 형식을 하나로 포섭한다.
//
// 역명 키는 속성명이 권역마다 다르다(seoul/busan="data-station" 직접 한글명,
// daejeon="data-full-official-name", gwangju="data-station-name" g 래퍼) —
// 신뢰하지 않는다. 대신 렌더된 텍스트 내용(tspan 연결)을 station 키로 쓴다.
// 전 권역 실측 결과 텍스트 내용이 해당 속성값과 항상 일치해 더 단순·강건하다.
//
// role 필터: ordinary/transfer/terminal만 포함. code(대구 역번호 라벨) 제외.
// daejeon의 planned·regional 6+2건은 전부 data-status="construction"/"planned"
// (미개통 연장·충청권 광역철도 공사중 표기)이라 제외 — compile-basemap-vec.mjs의
// 기존 construction/planned 제외 관례와 일치한다.
//
// font-size는 대개 <text> 속성이지만 gwangju는 CSS class(.station-label-<role>)
// 에서만 온다 — 클래스 규칙을 role별로 미리 읽어 인라인 속성이 없을 때 쓴다.
const ownerLabelRoles = ["ordinary", "transfer", "terminal"];

// #2068 오너 기준본 전환(2026-07-19) 실측 버그 수정: transform 속성에 여러
// translate(...)가 공백으로 이어 붙은 체인(예: 반복 패치가 누적된
// "translate(a,b) translate(c,d) translate(e,f)")이면 SVG 의미상 전부
// 합산돼야 하는데, .match()는 첫 translate 하나만 읽고 나머지를 버렸다 —
// 라벨 위치가 실제와 크게 어긋나(원종 등 다수가 같은 좌표 근처로 뭉침)
// 오너 라벨 매치율이 650→185로 붕괴하는 회귀를 실측으로 잡았다. .matchAll()
// 로 전부 찾아 합산한다(단순 translate만 조합되는 한 순서 무관하게 합이
// 곧 최종 오프셋 — rotate/scale이 섞이면 이 근사가 깨지지만, 라벨 transform은
// 실측상 translate만 쌓인다).
function parseTranslate(transformValue) {
  if (!transformValue) return { dx: 0, dy: 0 };
  const matches = [...transformValue.matchAll(/translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)/g)];
  if (matches.length === 0) return { dx: 0, dy: 0 };
  let dx = 0;
  let dy = 0;
  for (const m of matches) {
    dx += Number(m[1]);
    dy += Number(m[2]);
  }
  return { dx, dy };
}

function firstAttr(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1] : null;
}

// SVG path `d` number 토큰 렉서(#2068 ITX-청춘 chip 반입 대비 파서 강화 —
// 정본). SVG 좌표는 공백/콤마로 구분되지 않고 그냥 이어붙을 수 있다(선행
// 0 생략 + 연접 소수, 예: 벡터 최적화 export가 흔히 내는 ".191.132" =
// 0.191과 0.132 두 숫자). 기존 `/-?\d+\.?\d*/g`(정수부 우선)는 이 표기에서
// "191.132" 하나로 오병합해(정수부를 억지로 채워 넣음) bbox가 크게 부풀거나
// 좌표가 어긋난다 — extract-svg-geometry.mjs의 pathEndpointVertices가 이미
// 쓰는 순서(선택 부호 → 선택 정수부 → 선택 소수부 → 필수 최소 1자리)를
// 공유해 "정수부 없이 소수부만"과 "정수부만"을 모두 정확히 개별 숫자로
// 나눈다: 정수부를 최대한 욕심껏 먼저 소비하고, 소수점 뒤에 최소 1자리가
// 없으면 정규식 엔진이 역추적해 정수부를 한 자리씩 양보하며 재시도한다 —
// 그 결과 "12.34.56"도 12.34·0.56 두 숫자로 올바르게 분리된다(수동 검증:
// 이 파일의 compile-basemap-vec.test.mjs 참고). 지수 표기(e/E)도 지원.
export const SVG_NUMBER_TOKEN_RE = /-?\d*\.?\d+(?:[eE][+-]?\d+)?/g;

/** path `d`(또는 임의 좌표 나열 문자열)에서 숫자 토큰만 뽑는다(위 렉서). */
export function parseSvgNumbers(d) {
  return [...d.matchAll(SVG_NUMBER_TOKEN_RE)].map((m) => Number(m[0]));
}

// 커맨드별 인자 개수(#2068 ITX-청춘 chip 반입 대비 정본). collectShapeBounds의
// 기존 "커맨드 무시, 숫자 2개씩 짝짓기" 간이 파서는 KTX/SRT/rail chip 로고가
// 전부 M/L/C(2·2·6개 인자, 항상 2의 배수)만 쓰는 절대좌표 path라 우연히
// 맞았다. ITX-청춘 로고는 A(호, 7개 인자 — rx ry x축회전 large-arc sweep x y,
// 마지막 2개만 좌표)와 상대좌표 명령(소문자, 현재점 기준 델타)을 함께 쓴다 —
// 숫자를 그냥 2개씩 짝지으면 A의 비좌표 인자(rx/ry/플래그)가 좌표로 오인되며
// 그 뒤 전체 인자 정렬이 밀리고, 상대좌표 델타를 절대좌표인 양 그대로 쓰면
// 도형이 원점 근처로 뭉친다 — 그 결과 bbox가 실제보다 훨씬 크게 부풀었다
// (헤드리스 렌더·실측 대조로 발견: ITX 로고 자체 bbox가 viewBox 300 대비
// 590 높이로 나옴). 아래 표는 각 커맨드의 인자 개수(좌표쌍 여부와 무관하게
// 정확한 인자 소비량만 규정) — A는 좌표가 아닌 5개를 건너뛰고 마지막 (x,y)만
// 좌표로 낸다.
const PATH_COMMAND_ARITY = {
  M: 2, L: 2, T: 2, // (x y)
  H: 1, V: 1, // (x) / (y)
  C: 6, S: 4, Q: 4, // (cp... x y) — 좌표쌍 전부 좌표로 취급(제어점 포함 보수적 bbox)
  A: 7, // rx ry x-rot large-arc sweep x y — 좌표는 마지막 (x,y)뿐
  Z: 0,
};

/**
 * path `d`를 명령 인식 파서로 순회하며 실제 도형 좌표(절대화됨)만 [visit]에
 * 넘긴다. curve 제어점(C/S/Q)은 여전히 좌표로 방문해 기존의 "보수적으로
 * 넉넉한 bbox" 방향을 유지하되, A의 반지름·플래그 인자와 상대좌표 누적은
 * 정확히 처리한다(extract-svg-geometry.mjs의 pathEndpointVertices와 동일한
 * 커맨드·상대/절대 처리 원리 — 그쪽은 끝점만, 이쪽은 제어점도 포함).
 */
function visitPathCoordinates(d, visit) {
  const tokens =
    d.match(new RegExp(`[a-zA-Z]|${SVG_NUMBER_TOKEN_RE.source}`, "g")) || [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let cmd = "";
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) {
      cmd = tokens[i++];
    }
    const c = cmd.toUpperCase();
    const rel = cmd === cmd.toLowerCase();
    if (c === "Z") {
      cx = startX;
      cy = startY;
      continue;
    }
    if (c === "H") {
      cx = (rel ? cx : 0) + num();
      visit(cx, cy);
      continue;
    }
    if (c === "V") {
      cy = (rel ? cy : 0) + num();
      visit(cx, cy);
      continue;
    }
    if (c === "A") {
      num();
      num();
      num();
      num();
      num(); // rx ry x-rot large-arc sweep — 좌표 아님, 건너뜀.
      cx = (rel ? cx : 0) + num();
      cy = (rel ? cy : 0) + num();
      visit(cx, cy);
      continue;
    }
    const pairCount = (PATH_COMMAND_ARITY[c] ?? 2) / 2;
    if (!Number.isInteger(pairCount)) break; // 알 수 없는 커맨드 방어.
    for (let p = 0; p < pairCount; p += 1) {
      const isLast = p === pairCount - 1;
      const x = (rel ? cx : 0) + num();
      const y = (rel ? cy : 0) + num();
      visit(x, y);
      if (isLast) {
        cx = x;
        cy = y;
        if (c === "M") {
          startX = cx;
          startY = cy;
          cmd = rel ? "l" : "L"; // 후속 좌표쌍은 lineto(SVG 스펙).
        }
      }
    }
  }
}

// 2D 아핀 [a,b,c,d,e,f]: x'=a*x+c*y+e, y'=b*x+d*y+f. SVG transform 속성 합성 관례.
const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

function composeMatrix(A, B) {
  const [a1, b1, c1, d1, e1, f1] = A;
  const [a2, b2, c2, d2, e2, f2] = B;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatrix([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}

/**
 * `translate(dx,dy)`·`matrix(a,b,c,d,e,f)`·`scale(sx[,sy])` 체인을 순서대로
 * 합성한 단일 행렬. scale 누락 시 로고 내부 path 로컬 좌표(수백~수천 단위)가
 * 거의 미스케일된 채로 절대화돼 바운딩박스가 터무니없이 커진다(#2068 마감
 * 라운드 실측: 센텀·태화강·공항 KTX/AIR 로고가 `scale(0.036)`류를 쓴다).
 */
// 이 체인 파서가 아는 transform 함수. 그 밖(skewX·skewY 등)을 만나면 조용히
// 항등 취급하지 않고 실패한다(#2068 리뷰): 표장 obstacle bbox는 게이트가
// 교차 검증할 수단이 없어서, 무시된 변환 하나가 회피 영역을 통째로 엉뚱한 곳에
// 놓아도 label overlap 게이트는 green으로 통과한다. 잘못된 좌표가 아니라 빌드
// 실패로 드러나야 한다.
//
// #2068 SVG 충실도(2026-07-26): rotate를 "미지원 → throw"에서 **정확한 회전
// 행렬 지원**으로 승격한다. 오너 부산 v3 재수정본이 환승 심벌·종점 배지에
// rotate(±90,cx,cy)를 쓰고(실측 5건), 이후 도입하는 표장 전수 수집·장식 레이어
// bbox 판정이 그 요소들을 지나가므로, throw로 두면 정상 소스에서 빌드가 죽는다.
// rotate(a)와 rotate(a,cx,cy) 두 형식 모두 SVG 스펙대로 translate·rotate·
// translate⁻¹로 합성한다(항등 취급이 아니라 실제 계산 — 조용한 오차 없음).
const SUPPORTED_TRANSFORM_FUNCTIONS = new Set([
  "translate",
  "matrix",
  "scale",
  "rotate",
]);

function parseTransformChain(transformValue) {
  let M = IDENTITY_MATRIX;
  if (!transformValue) return M;
  for (const m of transformValue.matchAll(/([A-Za-z]+)\s*\(([^)]*)\)/g)) {
    const fn = m[1];
    if (!SUPPORTED_TRANSFORM_FUNCTIONS.has(fn)) {
      throw new Error(
        `지원하지 않는 transform 함수 ${fn}(...)입니다 — 조용히 무시하지 않고 실패합니다: "${transformValue}"`,
      );
    }
    const args = m[2]
      .trim()
      .split(/[,\s]+/)
      .map(Number);
    let T;
    if (fn === "translate") {
      T = [1, 0, 0, 1, args[0], args[1] ?? 0];
    } else if (fn === "scale") {
      const sx = args[0];
      const sy = args[1] ?? sx;
      T = [sx, 0, 0, sy, 0, 0];
    } else if (fn === "rotate") {
      const radians = (args[0] * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const rotation = [cos, sin, -sin, cos, 0, 0];
      T =
        args.length >= 3
          ? composeMatrix(
              composeMatrix([1, 0, 0, 1, args[1], args[2]], rotation),
              [1, 0, 0, 1, -args[1], -args[2]],
            )
          : rotation;
    } else {
      T = args;
    }
    M = composeMatrix(M, T);
  }
  return M;
}

// obstacle 좌표계 정합(#2068 수도권 표장 마감) — service-tags-layer·
// rail-transfer-layer는 seoul처럼 main-map-scaled-layer(scale(k)+translate) 안에
// 중첩될 수 있다(예: seoul k=0.455). 그 안의 표장은 SVG 저자 좌표(로컬, pre-scale)
// 로 쓰여 있으므로, extractOwnerLabels와 동일한 공식(로컬×mapScale+mapTranslate)
// 으로 최종 라벨·vec 좌표계(라벨 sidecar·route_map_positions와 공유하는 좌표계)
// 로 변환해야 게이트가 참조하는 라벨·노드 위치와 정합한다. main-map-scaled-layer가
// 없는 권역(busan·daegu·daejeon·gwangju)은 mapScale=1·mapTranslate=(0,0)이라
// 항등 변환 — 기존 obstacle 좌표는 완전히 불변이다(회귀 테스트로 실증).
function mapScaleAndTranslateFrom(svgText) {
  const mapTransform = mapWrapperTransform(svgText);
  return {
    mapScale: scaleFromMapTransform(mapTransform),
    mapTranslate: parseTranslate(mapTransform),
  };
}

function applyMapScaleToObstacles(obstacles, svgText) {
  const { mapScale, mapTranslate } = mapScaleAndTranslateFrom(svgText);
  return obstacles.map((o) => ({
    ...o,
    x: mapTranslate.dx + o.x * mapScale,
    y: mapTranslate.dy + o.y * mapScale,
    halfWidth: o.halfWidth * mapScale,
    halfHeight: o.halfHeight * mapScale,
  }));
}

// 표장 레이어(service-tags-layer·rail-transfer-layer) 자신의 transform.
//
// #2068 오너 v3 실측 회귀(2026-07-25): 표장 bbox 합성이 `<g class="service-tag">`
// 자신의 transform에서 시작해, 그 부모인 레이어 <g>의 transform을 빠뜨렸다.
// 대구 service-tags-layer는 matrix(1.2543717,0,0,1.1621081,-619.36561,-141.97865)
// 를 갖고 있어 동대구역 KTX·SRT 표장 장애물이 실제 렌더 위치에서 x +58~62px
// 어긋나고 크기도 1/1.25배로 축소돼, 오너 도식에서는 4.2px 떨어져 있는 동대구역
// 환승 라벨과 유령 겹침(18px)을 만들었다(Chrome getBBox 실측 대조로 확정).
// 레이어 transform을 체인 최외곽에 합성한다.
function layerOwnTransform(layerSlice) {
  const openTag = layerSlice.match(/^<g\b[^>]*>/)?.[0] ?? "";
  return (openTag.match(/\btransform="([^"]*)"/) || [])[1] ?? "";
}

// SVG transform 속성값들을 바깥→안 순서로 이어 붙인다(SVG `transform="A B"`는
// A·B 합성이고 parseTransformChain도 같은 순서로 곱한다).
function composeTransformValues(...values) {
  return values.filter(Boolean).join(" ");
}

// 표장 레이어(service-tags-layer·rail-transfer-layer) `<g>` 슬라이스.
//
// #2068 오너 v3 리뷰 지적(2026-07-25): extractGroup(:115)과 같은 결함이 표장
// 추출기 두 곳에 복제돼 있었다 — 여는 태그를 `/<g\b|<\/g>/`(태그 접두만)로 세어
// **자기폐쇄 `<g …/>`도 depth를 올려** 균형이 영구히 깨진다. 그러면 layerEnd를
// 못 찾고 조용히 `return []`이 되어 **표장 회피 목록이 통째로 사라져도 게이트가
// green**이다(라벨이 KTX·SRT 로고 위에 얹혀도 아무도 못 잡는다). 세 가지를
// 고친다:
//   1) 레이어 여는 태그 자체가 자기폐쇄면 그 태그가 곧 빈 레이어다(표장 0건).
//   2) depth는 자기폐쇄가 아닌 여는 태그에서만 올린다(extractGroup과 동일 규칙).
//   3) 닫는 태그를 못 찾으면 빈 배열이 아니라 **명시 실패(throw)** — 회피 목록
//      소실을 조용히 통과시키지 않는다(fail-closed).
// 레이어가 아예 없는 권역은 null(정상 — 호출부가 빈 배열을 낸다).
// [startIndex]의 여는 `<g>` 태그에 대응하는 `</g>` 끝 인덱스(자기폐쇄면 그 태그
// 끝). depth는 자기폐쇄가 아닌 여는 태그에서만 올린다 — `/<g\b|<\/g>/`처럼 태그
// 접두만 세면 자기폐쇄 `<g …/>`가 균형을 깨고, 깨진 스캔을 조용한 continue나
// 부분 슬라이스로 넘기면 표장이 목록에서 사라지거나 다음 형제까지 삼킨 과대
// bbox가 된다. 균형을 못 찾으면 실패한다(fail-closed).
//
// 표장 레이어·표장 블록·중첩 <g> 세 층위가 모두 이 함수를 쓴다. 다만 공개
// 진입점(extractServiceTagObstacles·extractRailTransferChipObstacles)으로는
// 블록 층위의 throw에 도달할 수 없다 — 레이어 슬라이스가 균형을 이룬 시점에
// 그 안은 well-nested가 보장되므로, 블록이 닫히지 않은 입력은 레이어 스캔이
// 먼저 잡는다(실측: 블록 미종료·중첩 2중 미종료·잉여 </g> 배치를 모두 시도해도
// 예외 메시지가 항상 레이어 층위였다). 블록·중첩 층위 가드는 그래서 이 함수를
// 직접 호출하는 단위 테스트로 고정한다.
export function matchingGroupEnd(text, startIndex, context) {
  const openTag = text.slice(startIndex).match(/^<g\b[^>]*>/)?.[0];
  if (!openTag) {
    throw new Error(`${context}의 여는 <g> 태그를 해석하지 못했습니다.`);
  }
  if (openTag.endsWith("/>")) return startIndex + openTag.length;

  const tagRe = /<g\b[^>]*>|<\/g>/g;
  tagRe.lastIndex = startIndex;
  let depth = 0;
  for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return tagRe.lastIndex;
    } else if (!m[0].endsWith("/>")) {
      depth += 1;
    }
  }
  throw new Error(
    `${context}의 닫는 태그를 찾지 못했습니다 — 조용히 건너뛰지 않고 실패합니다.`,
  );
}

function extractObstacleLayerSlice(svgText, layerId) {
  const layerStart = svgText.indexOf(`id="${layerId}"`);
  if (layerStart < 0) return null;
  const groupStart = svgText.lastIndexOf("<g", layerStart);
  if (groupStart < 0) return null;
  return svgText.slice(
    groupStart,
    matchingGroupEnd(svgText, groupStart, layerId),
  );
}

// service-tag(KTX·SRT·AIR 표장) 장애물 목록(#2068 마감 라운드 item 3) — 라벨
// solver가 이 표장 위에 라벨을 얹지 않도록 회피 대상으로 쓴다. 각
// `<g class="service-tag">` 서브그룹의 transform 체인(중첩 `<g transform>`
// 포함)을 실제로 합성해 내부 <path>/<circle>/<rect> 좌표를 절대 좌표로 변환한
// 외접 바운딩박스를 낸다(근사 상수가 아니라 실측) — path는 curve 제어점도
// 좌표 토큰으로 잡아 실제보다 살짝 넓게 잡히는 보수적 근사(안전 방향). 시각
// 내용이 없는 빈 그룹(예: 부산 기장 KTX — title만 있고 실제 로고 도형이 없는
// 소스 데이터 결측)은 회피할 것이 없으므로 건너뛴다. 같은 역에 서브그룹이
// 여럿(예: 부전 KTX 아이콘+배경 pill)이면 각자 별도 obstacle로 낸다 — 합집합
// 커버리지가 되어 더 안전하다. 반환 좌표는 mapScaleAndTranslateFrom으로 최종
// 좌표계로 변환됨(위 주석 참고).
export function extractServiceTagObstacles(svgText) {
  const layer = extractObstacleLayerSlice(svgText, "service-tags-layer");
  if (layer === null) return [];
  const layerTransform = layerOwnTransform(layer);

  const obstacles = [];
  // 속성 순서 무관용(#2068 마감): 소스마다 여는 <g> 태그의 속성 나열 순서가
  // 다르다(부산: class→data-station→transform, 대구: class→transform→
  // data-station). 예전 정규식은 data-station이 transform보다 앞에 오는 순서를
  // 고정 가정해 대구 동대구 KTX·SRT 표장을 놓쳤다. 여는 태그 전체를 먼저 잡고
  // class·data-station·transform을 각각 순서 독립으로 추출한다.
  const tagOpenRe = /<g\b[^>]*>/g;
  for (const tm of layer.matchAll(tagOpenRe)) {
    const openTag = tm[0];
    // id·class를 순서 독립으로 검사한다 — id를 첫 속성으로 고정 가정하면
    // 편집기가 class·transform을 앞에 내보내는 순간 그 권역 표장이 전량 0건이
    // 되고, 회피 목록 소실을 아무 게이트도 잡지 못한다(#2068 리뷰).
    if (!/\bid="service-tag-[^"]*"/.test(openTag)) continue;
    if (!/\bclass="service-tag"/.test(openTag)) continue;
    const station = (openTag.match(/\bdata-station="([^"]*)"/) || [])[1] ?? "";
    const rootTransform =
      (openTag.match(/\btransform="([^"]*)"/) || [])[1] ?? "";
    const blockStart = tm.index;
    const blockEnd = matchingGroupEnd(
      layer,
      blockStart,
      `service-tag 블록(${station || openTag.match(/\bid="([^"]*)"/)?.[1] || "id 없음"})`,
    );
    const block = layer.slice(blockStart + openTag.length, blockEnd);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const visit = (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    collectShapeBoundsRecursive(
      block,
      parseTransformChain(composeTransformValues(layerTransform, rootTransform)),
      visit,
    );
    if (!Number.isFinite(minX)) {
      continue; // 시각 내용 없는 빈 표장(예: 기장 KTX) — 회피 대상 아님.
    }
    obstacles.push({
      station,
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      halfWidth: (maxX - minX) / 2,
      halfHeight: (maxY - minY) / 2,
    });
  }
  return applyMapScaleToObstacles(obstacles, svgText);
}

// 대전·광주 rail chip 표장 장애물(#2068 대전·광주 마감) — 부산·대구는
// service-tags-layer에 class="service-tag"·data-station 마크업을 쓰지만,
// 재설계된 대전·광주 SVG는 rail-transfer-layer 안에 data-services를 가진
// chip <g>(대전 대전역·서대전역, 광주 광주송정역)로 KTX·SRT 로고를 담는다.
// extractServiceTagObstacles의 인식 조건(class="service-tag")에 걸리지 않으므로
// 별도 인식기로 스캔한다. chip <g>는 data-services 속성으로 판별하고(내부 로고
// 서브그룹은 data-logo만 가져 제외됨), 역 앵커는 data-station-name(없으면 <g>
// id)으로 잡는다. bbox는 extractServiceTagObstacles와 같은 transform 체인 합성·
// 재귀 도형 수집으로 절대 좌표화한다. 표장이 없는 권역은 빈 배열.
//
// #2068 대전·광주 v3 실측: 오너가 재제작하며 rail chip을 rail-transfer-layer
// (v1에선 두 권역 모두 내용이 빈 껍데기였다)에서 station-name-labels-layer 안
// `<g class="rail-service-marks" data-services="KTX,SRT" data-station-name="…">`
// 로 옮겼다. 마크업 문법(data-services + data-station-name)은 그대로라 인식기는
// 재사용하고 스캔 대상 레이어만 넓힌다. 다른 권역은 이 레이어에 data-services
// chip이 없어(부산 0 · 대구는 service-tags-layer에 있음 · 수도권은 레이어 자체
// 부재) 산출물이 불변이다 — 회귀 가드 테스트가 커밋된 labels.json과 대조한다.
const RAIL_CHIP_LAYER_IDS = ["rail-transfer-layer", "station-name-labels-layer"];

export function extractRailTransferChipObstacles(svgText) {
  const obstacles = [];
  for (const layerId of RAIL_CHIP_LAYER_IDS) {
    const layer = extractObstacleLayerSlice(svgText, layerId);
    if (layer === null) continue;
    const layerTransform = layerOwnTransform(layer);

    const tagOpenRe = /<g\b[^>]*>/g;
    for (const tm of layer.matchAll(tagOpenRe)) {
      const openTag = tm[0];
      if (!/\bdata-services="/.test(openTag)) continue; // chip <g>만(로고 서브그룹 제외).
      const station =
        (openTag.match(/\bdata-station-name="([^"]*)"/) || [])[1] ??
        (openTag.match(/\bid="([^"]*)"/) || [])[1] ??
        "";
      const rootTransform =
        (openTag.match(/\btransform="([^"]*)"/) || [])[1] ?? "";
      const blockStart = tm.index;
      const blockEnd = matchingGroupEnd(
        layer,
        blockStart,
        `rail chip 블록(${station || "id 없음"})`,
      );
      const block = layer.slice(blockStart + openTag.length, blockEnd);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const visit = (x, y) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      };
      collectShapeBoundsRecursive(
        block,
        parseTransformChain(
          composeTransformValues(layerTransform, rootTransform),
        ),
        visit,
      );
      if (!Number.isFinite(minX)) continue; // 시각 내용 없는 빈 chip — 회피 대상 아님.
      obstacles.push({
        station,
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        halfWidth: (maxX - minX) / 2,
        halfHeight: (maxY - minY) / 2,
      });
    }
  }
  return applyMapScaleToObstacles(obstacles, svgText);
}

/**
 * [text](임의 중첩 깊이의 <g transform>·<path>·<circle>·<rect> 혼재) 안의
 * 도형 좌표를 [matrix] 기준으로 재귀 합성해 절대 좌표로 [visit]에 넘긴다.
 * 중첩 <g transform>은 그 balanced 내용만 재귀 처리하고, 그 구간을 제외한
 * "직계" 텍스트(= <g> 바깥에 직접 놓인 <path>/<circle>/<rect>, 예: 센텀
 * 배경 rect)는 현재 [matrix]로 처리한다 — 이중 계산·누락을 모두 막는다.
 */
function collectShapeBoundsRecursive(text, matrix, visit) {
  const nestedGroupRe = /<g\b[^>]*>/g;
  let cursor = 0;
  let m;
  while ((m = nestedGroupRe.exec(text))) {
    if (m.index < cursor) continue;
    collectShapeBounds(text.slice(cursor, m.index), matrix, visit);
    const openTag = m[0];
    const childTransform = firstAttr(openTag, "transform");
    const childMatrix = childTransform
      ? composeMatrix(matrix, parseTransformChain(childTransform))
      : matrix;
    const innerEnd = matchingGroupEnd(
      text,
      m.index,
      `중첩 <g>(${firstAttr(openTag, "id") ?? "id 없음"})`,
    );
    // 자기폐쇄 <g …/>는 내용이 없다 — 도형 없이 건너뛴다(부분 슬라이스 폴백 금지).
    if (!openTag.endsWith("/>")) {
      const innerBody = text.slice(
        m.index + openTag.length,
        innerEnd - "</g>".length,
      );
      collectShapeBoundsRecursive(innerBody, childMatrix, visit);
    }
    cursor = innerEnd;
    nestedGroupRe.lastIndex = innerEnd;
  }
  collectShapeBounds(text.slice(cursor), matrix, visit);
}

/**
 * [text] 안의 <path d>/<circle>/<rect> 좌표를 [matrix]로 절대화해 [visit]에
 * 넘긴다. 도형 태그 자체에 `transform`이 직접 붙은 경우(예: 부산 공항 AIR
 * 픽토그램 `<path transform="matrix(...)">`, `<g>` 래핑 없이 도형 태그
 * 자체에 스케일이 온다)도 [matrix]와 합성해 반영한다.
 */
function collectShapeBounds(text, matrix, visit) {
  // path는 커맨드 인식 파서(visitPathCoordinates)로 절대좌표를 정확히
  // 추적하되, curve 제어점까지 좌표로 방문해 실제 외곽보다 넉넉한(장애물
  // 회피에는 안전한 방향) bbox를 낸다 — A(호)의 비좌표 인자·상대좌표
  // 누적은 정확히 처리한다(#2068 ITX-청춘 chip: 절대/상대 혼용 + arc 사용).
  for (const pm of text.matchAll(/<path\b[^>]*\/?>/g)) {
    const tag = pm[0];
    const d = firstAttr(tag, "d");
    if (!d) continue;
    const pathTransform = firstAttr(tag, "transform");
    const pathMatrix = pathTransform
      ? composeMatrix(matrix, parseTransformChain(pathTransform))
      : matrix;
    visitPathCoordinates(d, (px, py) => {
      const [x, y] = applyMatrix(pathMatrix, px, py);
      visit(x, y);
    });
  }
  for (const cm of text.matchAll(/<circle\b[^>]*\/?>/g)) {
    const tag = cm[0];
    const cx = Number(firstAttr(tag, "cx"));
    const cy = Number(firstAttr(tag, "cy"));
    const r = Number(firstAttr(tag, "r"));
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) {
      continue;
    }
    const shapeTransform = firstAttr(tag, "transform");
    const shapeMatrix = shapeTransform
      ? composeMatrix(matrix, parseTransformChain(shapeTransform))
      : matrix;
    for (const [dx, dy] of [
      [-r, 0],
      [r, 0],
      [0, -r],
      [0, r],
    ]) {
      const [x, y] = applyMatrix(shapeMatrix, cx + dx, cy + dy);
      visit(x, y);
    }
  }
  for (const rm of text.matchAll(/<rect\b[^>]*\/?>/g)) {
    const tag = rm[0];
    const x = Number(firstAttr(tag, "x"));
    const y = Number(firstAttr(tag, "y"));
    const w = Number(firstAttr(tag, "width"));
    const h = Number(firstAttr(tag, "height"));
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(w) ||
      !Number.isFinite(h)
    ) {
      continue;
    }
    const shapeTransform = firstAttr(tag, "transform");
    const shapeMatrix = shapeTransform
      ? composeMatrix(matrix, parseTransformChain(shapeTransform))
      : matrix;
    for (const [px, py] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ]) {
      const [ax, ay] = applyMatrix(shapeMatrix, px, py);
      visit(ax, ay);
    }
  }
}

// <style> 블록에서 .station-label-<role> { ... font-size:<n>px ... } 규칙을
// role → local px 맵으로 읽는다(gwangju처럼 인라인 font-size가 없는 경우 폴백).
function stationLabelFontSizesByRole(svgText) {
  const css = [...svgText.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join("\n");
  const byRole = {};
  for (const role of ownerLabelRoles) {
    const rule = css.match(
      new RegExp(`\\.station-label-${role}\\s*\\{([^}]*)\\}`),
    );
    const fontSize = rule?.[1].match(/font-size:\s*([\d.]+)px/)?.[1];
    if (fontSize) byRole[role] = Number(fontSize);
  }
  return byRole;
}

// SVG x/y/dx/dy는 **글리프별 값 리스트**가 올 수 있다(예: 부산 벡스코 첫 줄
// tspan의 dy="0 0 0 … 59.27" — 3글자 라벨에 19개 값). 첫 값이 그 청크(줄)의
// 위치를 결정하고 나머지는 뒤 글리프 개별 이동이다. Number("0 0 … 59.27")은
// NaN이라 그대로 쓰면 그 줄이 조용히 버려진다(#2068 벡스코 실측: 다줄 라벨
// "벡스코"/"(시립미술관)" 중 첫 줄이 NaN으로 탈락해 lines가 1건→빈 배열이
// 되고 둘째 줄이 통째로 사라졌다). 컴파일 입력 정규화(normalizeSvgForCompile)가
// 같은 규칙으로 첫 토큰만 남기므로 .vec과 sidecar가 같은 값을 본다.
function firstCoordinateToken(value) {
  if (value == null) return null;
  const first = value.trim().split(/[\s,]+/)[0];
  return first === "" ? null : first;
}

function ownerLabelTextContent(textBlock) {
  return textBlock
    .replace(/^<text\b[^>]*>/, "")
    .replace(/<\/text>$/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
}

// station 키 결정: daejeon 환승 라벨(v1 5역)은 텍스트 내용이 메인+부기 tspan을
// 이어붙인 복합 표기("1호선 대동"+"하늘공원" → "대동하늘공원")라 카탈로그 표기
// ("대동")와 매치되지 않는다(#2068 실기기 확정 — 좌열 왼쪽 폴백 배치로 화면 밖
// 잘림). 오너가 <text>에 직접 단 data-full-official-name("1호선 대동 | 2호선
// 208 대동(하늘공원)")이 역 신원의 제1 원천이고, sma-region-configs.mjs의 권역
// canonicalRules가 이미 정확히 같은 정규화를 파이프라인 노드 매칭에 쓰고 있으므로
// 그 정본 규칙을 그대로 재사용해 station 키를 뽑는다 — 텍스트 flatten보다
// 우선한다.
//
// #2068 대전·광주 v3(2026-07-25): 오너가 재제작하며 **광주 라벨도** 이 속성으로
// 통일했다(대전 22건·광주 20건). 규칙을 DAEJEON.canonicalRules로 고정해 두면
// 광주가 대전 규칙(역 접미 제거·가운뎃점 보존)으로 뽑혀 카탈로그와 어긋난다 —
// 광주송정역→"광주송정"(카탈로그 "광주송정역"), 학동·증심사입구는 가운뎃점이
// 남아 "학동증심사입구"와 불일치. 두 역만 조용히 폴백 미니 크기로 회귀하는
// #2068 광주송정역 사례와 동형이라, 권역 규칙([canonicalize])으로 뽑는다.
// [canonicalize]가 없으면(regionId 미지정 호출) 마크업 값을 그대로 쓴다.
//
// daegu/busan(#2068 QA): 오너 라벨 <text> 내용이 카탈로그 name_ko와 어긋나는
// 역이 data-full-official-name 없이 순수 <text> 내용으로만 온다 — daegu 3역
// (부호(경일대·호산대)→부호, 하양(대구가톨릭대)→하양, 서대구→서대구역), busan
// 4역(벡스코(시립미술관)→벡스코, 부산역→부산, 경성대·부경대→경성대.부경대,
// 국제금융센터·부산은행→국제금융센터.부산은행). 같은 정본 규칙을 flatten
// 텍스트에 적용해 station 키를 카탈로그 표기와 맞춘다 — 매칭 실패로 앱이 폴백
// 미니 크기로 잘못 배치하던 회귀(실기기)를 없앤다.
function ownerLabelStationKey(textOpenTag, textBlock, canonicalize) {
  const fullOfficialName = firstAttr(textOpenTag, "data-full-official-name");
  if (fullOfficialName) {
    return canonicalize?.(fullOfficialName)?.name ?? fullOfficialName;
  }
  // #2068 오너 v4 실측: 오너가 라벨에 직접 단 data-station이 역 신원의 제1
  // 원천이다. v2까지는 렌더 텍스트가 그 값과 (콜론 접미 표기를 빼면) 항상
  // 같아 텍스트만 써도 됐지만, v4의 성신여대입구는 오너가 둘째 줄 tspan
  // ("입구")을 걷어내 렌더 텍스트가 "성신여대"가 됐다 — 텍스트를 키로 쓰면
  // 카탈로그 "성신여대입구"와 어긋나 그 역만 폴백 미니 크기로 회귀한다
  // (#2068 광주송정역 사례와 동형). 명시 신원 속성을 우선한다.
  // 실측 영향 범위: seoul v4 1건(성신여대입구)뿐 — busan은 147건 전부
  // 텍스트와 동일하고, daegu·daejeon·gwangju 라벨엔 이 속성이 없어 기존
  // 텍스트 경로를 그대로 탄다(산출물 불변).
  const dataStation =
    firstAttr(textOpenTag, "data-station") ??
    firstAttr(textOpenTag, "data-station-name");
  const textContent = dataStation || ownerLabelTextContent(textBlock);
  if (canonicalize) {
    const canonical = canonicalize(textContent)?.name;
    if (canonical) return canonical;
  }
  return textContent;
}

// 여러 줄(2단) 라벨의 줄 구성을 local(pre-transform) 단위로 뽑는다(#2068
// 다줄 라벨 렌더 — 앱이 오너 매치 라벨을 늘 단일 줄로 측정·렌더해, 오너가 2줄로
// 좁게 배치한 이름(예: 검단사거리="검단"/"사거리")을 풀네임 1줄 폭으로 오판해
// 이웃 라벨과 오탐 겹침을 만들었다).
//
// "leaf" tspan(직계 텍스트만 담고 다른 태그를 안 감싸는 tspan)만 대상으로 한다
// — 중첩 wrapper tspan(이수형 sodipodi:role="line")은 자기 텍스트가 없어(다음
// 문자가 바로 `<tspan`) 자동 제외된다. y는 절대값이 있으면 그 값을, 없고 dy만
// 있으면(daegu·busan·daejeon 관례) 직전 커서 + dy로 누적한다(seoul·gwangju는
// 절대 y만 씀, 관측 확인). x도 tspan 자체 값이 있으면 갱신하고 없으면 직전
// 커서를 이어받는다.
//
// class="station-sub"(daejeon 부기 캡션 — 예: "오정" 메인 + "한남대" 부기, 메인과
// 다른 축소 font-size)는 표시 라벨의 일부가 아니라 장식 주석이라 제외한다 —
// 포함하면 카탈로그가 모르는 텍스트가 둘째 줄로 렌더되고 per-line 별도 font-size
// 지원도 필요해진다(범위 밖). daejeon 환승 5역(대동 등)은 이 필터로 "station-main"
// 한 줄만 남아 lines.length<=1이 되므로 기존 단일 줄 렌더가 그대로 유지된다.
//
// 반환이 2줄 미만이면 호출부가 entry에 lines를 붙이지 않는다(스키마 최소화 —
// 기존 단일 줄 엔트리·매치 키(ownerLabelStationKey는 무관)와 100% 호환).
function extractOwnerLabelLineLocalPositions(textOpenTag, textBlock) {
  // 다음 `<`는 **선행 탐색으로만** 확인하고 소비하지 않는다(#2068 벡스코 실측):
  // 소비하면 wrapper tspan을 건너뛴 직후 그 안쪽 leaf tspan의 여는 `<`까지 함께
  // 먹어 leaf 줄 하나가 통째로 사라진다. 부산 벡스코가 정확히 이 형태
  // (`<tspan role=line><tspan dy=…>벡스코</tspan></tspan><tspan …>(시립미술관)`)
  // 라 첫 줄 "벡스코"를 잃고 남은 1줄이 임계(2줄) 미만이 돼 다줄 정보가 통째로
  // 비었다.
  const leafTspanRe = /<tspan\b([^>]*)>([^<]*)(?=<)/g;
  let cursorX = firstAttr(textOpenTag, "x");
  let cursorY = firstAttr(textOpenTag, "y");
  const lines = [];
  for (const match of textBlock.matchAll(leafTspanRe)) {
    const tspanAttrs = match[1];
    const rawText = match[2];
    // 커서 갱신은 **빈 텍스트 wrapper tspan에도** 적용한다 — SVG에서 x/y를 단
    // tspan은 자기 텍스트가 없어도 그 자리에서 새 텍스트 청크를 연다. 종전처럼
    // 먼저 continue하면 wrapper가 준 위치를 잃고 안쪽 leaf 줄이 부모 <text>의
    // x/y로 되돌아간다(부산 벡스코 wrapper x=9301.377 / text x=9646).
    const tspanX = firstCoordinateToken(firstAttr(tspanAttrs, "x"));
    if (tspanX != null) cursorX = tspanX;
    const tspanY = firstCoordinateToken(firstAttr(tspanAttrs, "y"));
    const tspanDy = firstCoordinateToken(firstAttr(tspanAttrs, "dy"));
    if (tspanY != null) {
      cursorY = tspanY;
    } else if (tspanDy != null && cursorY != null) {
      cursorY = String(Number(cursorY) + Number(tspanDy));
    }
    if (!rawText || !rawText.trim()) continue; // wrapper-only(빈 텍스트) 제외.
    if ((firstAttr(tspanAttrs, "class") ?? "").includes("station-sub")) {
      continue; // 부기 캡션 제외.
    }
    if (cursorX == null || cursorY == null) continue; // 위치 미상 줄은 제외.
    const localX = Number(cursorX);
    const localY = Number(cursorY);
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) continue;
    lines.push({ text: rawText.trim(), localX, localY });
  }
  return lines;
}

// [groupOpenTag]는 gwangju처럼 role이 감싸는 <g>에 있을 때만 넘긴다(그 외 null).
function ownerLabelEntryFrom(
  groupOpenTag,
  textBlock,
  role,
  mapScale,
  mapTranslate,
  cssFontSizeByRole,
  canonicalize,
) {
  const textOpenTagMatch = textBlock.match(/^<text\b[^>]*>/);
  if (!textOpenTagMatch) return null;
  const textOpenTag = textOpenTagMatch[0];
  // 미개통(공사중) 라벨 제외 — role만으로는 못 거른다(daejeon 2호선 트램 39건이
  // role="ordinary/transfer/terminal"이면서 data-status="construction"). 기존
  // compile-basemap-vec.mjs의 construction/planned 제외 관례와 일치시킨다.
  const constructionPattern = /data-(?:status|state)="(?:construction|planned)"/;
  if (
    constructionPattern.test(textOpenTag) ||
    (groupOpenTag && constructionPattern.test(groupOpenTag))
  ) {
    return null;
  }
  // #2068 SVG 충실도(2026-07-26): 라벨 로컬 변환은 translate 합이 아니라 **행렬
  // 합성**으로 계산한다. 오너 수도권 v4는 라벨 10건에 `transform="rotate(±0.1~0.7)"`
  // (미세 기울임)을 쓰는데, translate만 더하던 종전 계산은 그 회전을 통째로
  // 무시해 앵커가 로컬 기준 최대 (-54, +33) → 최종 좌표계로 약 25px 어긋났다
  // (병점·동오·새말·경기도청북부청사·효자·곤제·어룡·송산·범골·흥선 — 전수 대조
  // 게이트가 실측으로 잡아냈다). translate만 있는 라벨은 결과가 완전히 동일하다.
  const localMatrix = composeMatrix(
    parseTransformChain(
      groupOpenTag ? firstAttr(groupOpenTag, "transform") : null,
    ),
    parseTransformChain(firstAttr(textOpenTag, "transform")),
  );
  // 첫 tspan이 스스로 x/y를 선언하면 SVG 텍스트 청크 규칙상 그 지점이 실제
  // 앵커 기준이다(text-anchor는 그 청크 기준으로 계산됨) — 부모 <text>의 x/y
  // 보다 우선한다. 일반 라벨은 tspan이 부모와 같은 x/y를 반복해(무의미) 결과가
  // 같지만, 여러 줄 라벨 4건(#2068 수도권 게이트 조사 실측 — 영등포구청·이수·
  // 부천종합운동장·신검단중앙)은 tspan이 부모보다 작은 x를 가져, 부모 값을
  // 쓰면 앵커가 실제보다 오른쪽으로 밀려 이웃 라벨과 오탐 겹침을 만들었다.
  // tspan에 x/y가 없으면(daegu 등 transform 전용 다음 줄 tspan 관례, 뚝섬형
  // 위치형 포함) 부모 값을 그대로 쓴다.
  // 글리프별 좌표 리스트(`x="9301.4 9355.9 9410.5"`)는 entry-level x/y에도 올 수
  // 있다 — 줄 단위 경로(extractOwnerLabelLineLocalPositions)에만
  // firstCoordinateToken을 적용하면 비대칭이 되고, 리스트를 만난 라벨은
  // Number()가 NaN을 내 아래 유한성 검사에서 엔트리가 통째로 사라진다(lines는
  // 정상 좌표인데 entry만 없어지는 자기모순). 컴파일 입력 정규화
  // (normalizeSvgForCompile)가 이미 같은 "첫 토큰만" 규칙을 쓰므로 .vec와
  // sidecar가 같은 값을 본다.
  const firstTspan = textBlock.match(/<tspan\b[^>]*>/)?.[0] ?? null;
  const x =
    firstCoordinateToken(firstTspan && firstAttr(firstTspan, "x")) ??
    firstCoordinateToken(firstAttr(textOpenTag, "x"));
  const y =
    firstCoordinateToken(firstTspan && firstAttr(firstTspan, "y")) ??
    firstCoordinateToken(firstAttr(textOpenTag, "y"));
  const [localX, localY] = applyMatrix(
    localMatrix,
    Number(x ?? NaN),
    Number(y ?? NaN),
  );
  // text-anchor는 속성형(`text-anchor="middle"`)뿐 아니라 style 선언 안
  // (`style="text-align:center;text-anchor:middle"`, Inkscape 수작업 라벨 —
  // sma-v2 6건 실측: 영등포구청·이수·부천종합운동장·송도달빛축제공원·
  // 신검단중앙·국제업무지구)으로도 온다. 속성형만 읽으면 이 라벨들이 전부
  // "start"로 오판돼 앵커가 실제보다 좌측으로 쏠려 이웃 라벨과 겹친다(#2068
  // 수도권 게이트 회귀 조사). style font-size를 이미 파싱하는 관례
  // (scaleStyleFontSize)와 같은 자리에서 style text-anchor도 폴백으로 읽는다.
  const styleValue = firstAttr(textOpenTag, "style");
  const styleAnchorRaw = styleValue?.match(
    /text-anchor\s*:\s*(start|middle|end)/,
  )?.[1];
  // #2068 벡스코 오배치 원인(2026-07-26 실측 확정): SVG/CSS 명세상 **style
  // 선언이 동명 presentation attribute를 이긴다**. 종전 코드는 속성을 먼저 읽어
  // 두 값이 어긋나는 라벨에서 앵커를 뒤집었다. 부산 벡스코는
  // `text-anchor="start"` + `style="text-align:end;text-anchor:end"`라 실제
  // 렌더는 end(=x가 오른쪽 끝)인데 sidecar는 start로 기록돼, 앱이 앵커 x에서
  // **오른쪽으로** 라벨 폭(4자×54.6px ≈ 218px)만큼 밀어 그렸다 — 오너가 왼쪽에
  // 배치한 라벨이 노드 반대편에 찍혀 "완전히 다른 곳"으로 보였다.
  // 실측 영향 범위: busan 4건(벡스코·부산대양산캠퍼스·서부산유통지구·괘법르네시떼)
  // + daegu 3건 = 7건. 나머지 권역은 두 값이 일치하거나 한쪽만 있어 산출 불변.
  const anchorRaw =
    styleAnchorRaw ?? firstAttr(textOpenTag, "text-anchor") ?? "start";
  const anchor = ["start", "middle", "end"].includes(anchorRaw)
    ? anchorRaw
    : "start";
  const fontSizeAttr = firstAttr(textOpenTag, "font-size");
  const fontSizeLocal = fontSizeAttr
    ? Number(fontSizeAttr.replace(/px$/, ""))
    : cssFontSizeByRole[role];
  const station = ownerLabelStationKey(textOpenTag, textBlock, canonicalize);
  if (
    !station ||
    !Number.isFinite(localX) ||
    !Number.isFinite(localY) ||
    !Number.isFinite(fontSizeLocal)
  ) {
    return null;
  }
  // 2줄 이상일 때만 lines에 항목을 채운다(#2068 다줄 라벨 렌더) — entry-level
  // x/y와 같은 변환 파이프라인(localMatrix 합성 후 ×mapScale+mapTranslate)을
  // 줄마다 적용해 최종 좌표계(entry.x/y와 동일 단위)로 낸다. 단일 줄이면 빈
  // 배열(스키마 항상 존재, 호출부가 length로 분기).
  const lineLocalPositions = extractOwnerLabelLineLocalPositions(
    textOpenTag,
    textBlock,
  );
  const lines =
    lineLocalPositions.length >= 2
      ? lineLocalPositions.map((line) => {
          const [lineX, lineY] = applyMatrix(
            localMatrix,
            line.localX,
            line.localY,
          );
          return {
            text: line.text,
            x: roundCoord(mapTranslate.dx + lineX * mapScale),
            y: roundCoord(mapTranslate.dy + lineY * mapScale),
          };
        })
      : [];
  return {
    station,
    role,
    x: roundCoord(mapTranslate.dx + localX * mapScale),
    y: roundCoord(mapTranslate.dy + localY * mapScale),
    anchor,
    fontSizePx: roundCoord(fontSizeLocal * mapScale),
    lines,
  };
}

// 오너 라벨 sidecar의 station 키를 카탈로그 표기로 정규화하는 권역별 정본 규칙.
// 파이프라인 노드 매칭(apply-sma-svg-positions)이 이미 쓰는 그 규칙을 그대로
// 재사용한다 — 도식 표기와 카탈로그 표기가 다른 역이 매칭에 실패하면 그 역만
// 조용히 솔버 폴백(미니 크기)으로 렌더되기 때문이다(#2068 광주송정역 사례).
// 실측 교정 이력:
//   daegu  — 부호(경일대·호산대)→부호 · 하양(대구가톨릭대)→하양 · 서대구→서대구역
//   busan  — 벡스코(시립미술관)→벡스코 · 부산역→부산 · 경성대·부경대→경성대.부경대 ·
//            국제금융센터·부산은행→국제금융센터.부산은행
//   seoul  — 총신대입구(이수)→총신대입구 · 신촌(경의중앙선)→신촌 · 하남검단산→하남검단산역
//   daejeon— "1호선 대동 | 2호선 208 대동(하늘공원)"→대동 · 대전역→대전
//   gwangju— 광주송정역(유지) · 학동·증심사입구→학동증심사입구 ·
//            김대중컨벤션센터(마륵)→김대중컨벤션센터 · 문화전당(구도청)→문화전당
// regionId를 넘기지 않는 호출(단위 테스트 등)은 null이라 마크업 값을 그대로 쓴다.
const OWNER_LABEL_CANONICAL_RULES = {
  seoul: SEOUL.canonicalRules,
  busan: BUSAN.canonicalRules,
  daegu: DAEGU.canonicalRules,
  daejeon: DAEJEON.canonicalRules,
  gwangju: GWANGJU.canonicalRules,
};

// 원본 svgText(정규화·레이어 추출 이전)에서 오너 라벨 앵커 목록을 뽑는다.
// 반환은 station 오름차순(로케일 정렬) → role 오름차순으로 정렬해 결정적이다.
export function extractOwnerLabels(svgText, regionId) {
  const mapTransform = mapWrapperTransform(svgText);
  const mapScale = scaleFromMapTransform(mapTransform);
  const mapTranslate = parseTranslate(mapTransform);
  const cssFontSizeByRole = stationLabelFontSizesByRole(svgText);
  const rolePattern = ownerLabelRoles.join("|");
  const canonicalize = OWNER_LABEL_CANONICAL_RULES[regionId] ?? null;

  const entries = [];
  const textRe = new RegExp(
    `<text\\b[^>]*\\bdata-label-role="(${rolePattern})"[^>]*>[\\s\\S]*?<\\/text>`,
    "g",
  );
  for (const match of svgText.matchAll(textRe)) {
    // #2068 오너 기준본 전환(2026-07-19) 실측 버그 수정: 오너 v2.1 일부 라벨은
    // data-label-role이 <text> 자신에 있지만(이 정규식 경로), 그 <text>가
    // <g id="station-label-group-<name>" transform="...">로 한 겹 더 감싸여
    // 있다(수도권 기존 관례에 없던 패턴 — 인천1·2호선 다수). 이 그룹 변환을
    // 못 읽으면 라벨이 station-label-group의 transform만큼(관측 최대
    // 500px대) 엉뚱한 곳에 앉아 오너 매치율이 붕괴한다(실측: 601/656 중
    // 다수가 이 패턴). 매치 직전 512자 이내에서 가장 가까운
    // station-label-group 열림 태그를 찾아 감싸는지 확인한다.
    const before = svgText.slice(Math.max(0, match.index - 512), match.index);
    // #2068 대구 오너 직접 제작본 전환(2026-07-20) 실측 버그 수정: 대구 오너는
    // 밀집 회랑(line3 매천~북구청 등)의 라벨 17건을 per-라벨 그룹
    // <g class="horizontal-station-label-group" id="lineN-N-horizontal-label"
    // transform="translate(...)">로 감싸 nudge한다 — seoul/gwangju의
    // id="station-label-group-…" 래퍼와 문법만 다를 뿐 같은 "라벨 감싸는 그룹
    // transform"이다. 이 래퍼를 못 읽으면 라벨이 translate만큼(관측 최대 ~215px)
    // 엉뚱한 곳(예: 팔달 라벨이 매천시장 노드 위)에 앉아 라벨-노드 겹침 게이트
    // 오탐·실기기 오배치를 낸다. 두 래퍼 문법을 모두 인식한다(다른 권역 SVG엔
    // horizontal-station-label-group 클래스가 없어 산출물 불변).
    const wrapMatch =
      before.match(/<g\b[^>]*\bid="station-label-group-[^"]*"[^>]*>\s*$/) ??
      before.match(
        /<g\b[^>]*\bclass="[^"]*horizontal-station-label-group[^"]*"[^>]*>\s*$/,
      );
    const entry = ownerLabelEntryFrom(
      wrapMatch ? wrapMatch[0] : null,
      match[0],
      match[1],
      mapScale,
      mapTranslate,
      cssFontSizeByRole,
      canonicalize,
    );
    if (entry) entries.push(entry);
  }
  const groupRe = new RegExp(
    `<g\\b[^>]*\\bdata-label-role="(${rolePattern})"[^>]*>\\s*<text\\b[^>]*>[\\s\\S]*?<\\/text>`,
    "g",
  );
  for (const match of svgText.matchAll(groupRe)) {
    const groupOpenTag = match[0].match(/^<g\b[^>]*>/)[0];
    const textBlock = match[0].slice(groupOpenTag.length).trim();
    const entry = ownerLabelEntryFrom(
      groupOpenTag,
      textBlock,
      match[1],
      mapScale,
      mapTranslate,
      cssFontSizeByRole,
      canonicalize,
    );
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) =>
    a.station === b.station
      ? codepointCompare(a.role, b.role)
      : a.station.localeCompare(b.station, "ko"),
  );
  return entries;
}

// 종점 호선 마크 sidecar 플래그(#2068 광주 2차) — region의 원본 SVG가 자체
// 종점 배지를 그리면 앱 솔버가 같은 자리에 노선 뱃지 pill을 중복해 그리지 않도록
// terminal role 오너 라벨 엔트리에 hasLineTerminalBadge:true를 표시한다. 감지
// 대상 자체 배지는 두 형식이다:
//   1) 광주·대전형: route-lines-layer 내 <g data-role="line-terminal-badge"> 원+숫자.
//   2) #2408 수도권형: 오너 직접 제작 종점 심볼(terminal-route-badges-layer의 캡슐
//      칩). 수도권은 기계 이식 배지를 걷어내고 이 오너 칩을 렌더하므로, 같은 자리에
//      앱 pill을 중복하지 않도록 이 레이어가 있으면 동일하게 플래그를 켠다.
// region 단위 감지(개별 역 좌표 매칭 불필요 — terminal 엔트리 전부에 표시해도
// 의미가 동일하다). 두 형식 모두 없는 권역은 기존 엔트리 그대로 — 하위 호환.
export function markLineTerminalBadgeEntries(ownerLabels, sourceText) {
  const hasOwnTerminalBadges =
    /data-role="line-terminal-badge"/.test(sourceText) ||
    /id="terminal-route-badges-layer"/.test(sourceText);
  if (!hasOwnTerminalBadges) {
    return ownerLabels;
  }
  return ownerLabels.map((entry) =>
    entry.role === "terminal"
      ? { ...entry, hasLineTerminalBadge: true }
      : entry,
  );
}

// style="...font-size:<n>px?..." 선언 값을 ×k로 교체한다(px 접미사는 유지).
// text·tspan 공통 — SVG에서 style 속성은 동명 presentation attribute보다 우선하므로
// (예: 클래스가 준 font-size 속성 위에 개별 style로 덮어쓴 배지들) 실제 렌더 크기는
// style 값이 결정한다. Inkscape 수작업 stray 텍스트(예: GTX-A 배지 옆 tspan, class
// 없음)는 font-size가 style에만 있어 속성형 스케일링을 비껴간다 — 별도로 보정한다.
function scaleStyleFontSize(tag, k) {
  return tag.replace(/style="([^"]*)"/, (_m, styleValue) => {
    if (!/font-size\s*:/.test(styleValue)) return `style="${styleValue}"`;
    const scaled = styleValue.replace(
      /font-size\s*:\s*([\d.]+)(px)?/,
      (_fm, num, px) => `font-size:${roundCoord(Number(num) * k)}${px ?? ""}`,
    );
    return `style="${scaled}"`;
  });
}

// vector_graphics_compiler 1.2.6은 축정렬 transform을 소비하며 텍스트 x/y만 변환하고
// transform을 버린다(node.dart computeTextPosition). 런타임은 fontSize를 그대로 쓰므로
// scale(k) 레이어 안 텍스트가 viewBox 좌표계에서 k배 안 된 크기로 렌더된다. 또한
// dominant-baseline central/alignment-baseline middle을 컴파일러·런타임이 지원하지 않아
// 글리프가 의도한 세로 중심보다 위로 뜬다. 정규화 단계에서 결정적으로 보정한다:
//   1) font-size(속성형·style형 모두)를 로컬 값 × k로 교체(px 접미사는 속성형만 제거,
//      style형은 유지) — k=1이면 값 유지.
//   2) baseline이 central/middle이면 y를 로컬 단위 0.35*fontSize만큼 내리고
//      baseline 속성을 제거(이후 컴파일러가 point를 k배 변환하므로 로컬 단위가 맞다).
//      style형 전용 stray 텍스트(Inkscape 수작업)에는 baseline 속성이 없어 대상이
//      아니다 — 이미 alphabetic 기준으로 배치돼 있으므로 y는 건드리지 않는다.
//      계수 0.35는 번들 Pretendard 실측(컴파일 .vec 픽셀 실측, 숫자 배지 bbox
//      중심 오차 ≤ fontSize의 2%)으로 유지가 정답임을 확인했다.
//      주의: scale(-1)+rotate(180) 중첩 프레임(수도권 마곡나루 9호선·공항철도
//      배지 — 전 권역 유일)에서는 이 로컬 +보정이 렌더에서 반대로 작동해 배지
//      글자가 원 밖으로 이탈했다(#2068 오너 강반려). 그 2개 배지는 소스에서
//      alphabetic 기준 y로 사전 중심 정렬하고 central/middle 속성을 제거해 이
//      보정 대상에서 뺐다(easy-subway-sma-v2.svg). 따라서 여기 규칙은 축정렬(비
//      반전) central 텍스트에만 적용되며 반전 프레임 특례가 필요 없다.
// inlineSimpleClassStyles 이후에 적용해 class에서 온 font-size·baseline도 속성으로
// 정리된 상태를 다룬다. text·tspan 이외 요소는 건드리지 않으며, 텍스트 내용은 불변이다.
// #2408/#2068 종점 칩 텍스트 표식. foldTerminalChipScale이 이미 렌더 배율을
// 반영해 둔 텍스트라, normalizeTextBaselineAndScale의 전역 font-size ×k 패스에서
// 제외해야 한다(이중 적용 방지). 컴파일 입력 사본에만 붙고 정규화 마지막 단계에서
// 제거되므로 산출 .vec에는 남지 않는다.
const TERMINAL_CHIP_FONT_EXEMPT_ATTR = "data-basemap-chip-font-exempt";

function normalizeTextBaselineAndScale(svgText, k) {
  const withStyleFontSizeScaled = svgText.replace(
    /<(?:text|tspan)\b[^>]*>/g,
    (tag) =>
      tag.includes(TERMINAL_CHIP_FONT_EXEMPT_ATTR) ? tag : scaleStyleFontSize(tag, k),
  );
  return withStyleFontSizeScaled.replace(/<text\b[^>]*>/g, (tag) => {
    // 종점 칩 텍스트는 foldTerminalChipScale이 이미 렌더 배율을 반영했다 —
    // 여기서 다시 k를 곱하면 이중 적용이 된다(#2068 v4 실측).
    if (tag.includes(TERMINAL_CHIP_FONT_EXEMPT_ATTR)) return tag;
    const fontSizeMatch = tag.match(/\sfont-size="([\d.]+)(?:px)?"/);
    if (!fontSizeMatch) return tag;
    const fontSizeLocal = Number(fontSizeMatch[1]);
    if (!Number.isFinite(fontSizeLocal)) return tag;
    let result = tag;
    const central =
      /\sdominant-baseline="central"/.test(result) ||
      /\salignment-baseline="(?:middle|central)"/.test(result);
    if (central) {
      const yMatch = result.match(/\sy="(-?[\d.]+)"/);
      if (yMatch && Number.isFinite(Number(yMatch[1]))) {
        result = result.replace(
          /\sy="-?[\d.]+"/,
          ` y="${roundCoord(Number(yMatch[1]) + 0.35 * fontSizeLocal)}"`,
        );
      }
      result = result
        .replace(/\sdominant-baseline="[^"]*"/g, "")
        .replace(/\salignment-baseline="[^"]*"/g, "");
    }
    return result.replace(
      /\sfont-size="[\d.]+(?:px)?"/,
      ` font-size="${roundCoord(fontSizeLocal * k)}"`,
    );
  });
}

// tag 문자열의 y="..." 값을 shift만큼 더한다(단일 값 가정). y가 없으면 그대로 둔다.
function shiftTextYAttr(tag, shift) {
  const yMatch = tag.match(/\sy="(-?[\d.]+)"/);
  if (!yMatch || !Number.isFinite(Number(yMatch[1]))) return tag;
  return tag.replace(
    /\sy="-?[\d.]+"/,
    ` y="${roundCoord(Number(yMatch[1]) + shift)}"`,
  );
}

// #2408 오너 종점 칩 그룹 스케일 선보정. 오너가 직접 배치한 종점 노선 심볼(캡슐
// 배지)은 각 <g class="ui-chip terminal-route-badge">에 matrix(2.198,0,0,2.198,…)
// 또는 translate(…) scale(2.198) translate(…) 축정렬 스케일 s를 걸어 배치한다.
// vector_graphics_compiler 1.2.6은 이 축정렬 그룹 스케일을 텍스트 위치(x/y)에는
// 반영하지만 fontSize에는 반영하지 않아(아래 normalizeTextBaselineAndScale 주석의
// node.dart 버그) 칩 글자가 캡슐 대비 s배(≈2.198×)만큼 작게 렌더된다(#2408 실측:
// 캡슐 ~23유닛 높이 안에 글자 잉크 ~4.6유닛). 컴파일 입력에서 각 칩의 그룹 스케일을
// 내부 <text>/<tspan> font-size에 미리 곱해 보정한다.
//   - baseline central/middle 보정(+0.35×fontSize)은 텍스트의 로컬 프레임에서
//     이뤄져야 이후 컴파일러가 그룹 스케일로 그 오프셋까지 렌더에서 변환한다.
//     따라서 여기서는 로컬 유효 font-size(그룹 스케일 곱 전) 기준으로 y를 내리고
//     central/middle 속성을 제거한다. 이렇게 하면 뒤이은 normalizeTextBaselineAndScale
//     은 map 스케일 k만 추가로 곱하므로 최종 fontSize=L×s×k, 렌더 baseline 오프셋=
//     0.35×L×s×k=0.35×(렌더 fontSize)로 비반전 종점 숫자 배지와 동일한 0.35 비율에
//     수렴한다.
//   - 유효 로컬 font-size L은 inline style(존재 시 우선) 아니면 attr font-size를 쓴다
//     (SVG에서 style이 presentation attribute보다 우선). font-size는 attr·style 양쪽을
//     s배해 어느 쪽이 렌더에 쓰이든 일관되게 한다.
//   - 칩 그룹은 rect+text만 담고 중첩 <g>가 없어 non-greedy 그룹 매치가 안전하다.
//     축정렬(비반전) 균일 스케일만 대상으로 하며, 그 외(회전·비균일·s=1)는 건드리지
//     않는다. 다른 권역 SVG엔 이 클래스가 없어 영향이 없다. 오너 SVG 원본은 불변이며
//     이 정규화는 컴파일 입력 사본에만 적용된다.
//   - #2408 리뷰 반영: inlineSimpleClassStyles 이후에 적용해야 한다 — CSS 클래스
//     유래 font-size/baseline(단순 compound class 선택자로 인라인되는 경우)도 이
//     함수의 attr·style 판독 대상이 되도록 하기 위함. 현재 오너 칩은 전부 속성형
//     font-size(attr="10.5", 일부 style override)만 쓰고 관련 CSS 규칙
//     (.ui-chip text {...})은 descendant 결합자라 애초에 inlineSimpleClassStyles가
//     인식하지 않는 단순 선택자 요건 밖이라 순서 무관하게 현재 결과는 불변이지만,
//     향후 단순 class 선택자로 font-size/baseline을 주는 칩이 추가되면 이 순서가
//     아니면 fold가 그 값을 놓친다.
function foldTerminalChipScale(svgText) {
  return svgText.replace(
    /<g\b[^>]*\bclass="ui-chip terminal-route-badge"[^>]*>[\s\S]*?<\/g>/g,
    (chip) => {
      const transform = chip.match(/\btransform="([^"]*)"/)?.[1];
      if (!transform) return chip;
      let s = null;
      const matrix = transform.match(
        /matrix\(\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)/,
      );
      if (matrix) {
        const [a, b, c, d] = matrix.slice(1).map(Number);
        if (Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9 && Math.abs(a - d) < 1e-6) {
          s = Math.abs(a);
        }
      }
      if (s == null) {
        const scale = transform.match(/scale\(\s*([-\d.]+)\s*\)/);
        if (scale) s = Math.abs(Number(scale[1]));
      }
      if (s == null || !Number.isFinite(s) || Math.abs(s - 1) < 1e-9) {
        return chip;
      }
      return chip.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, (block) => {
        const open = block.match(/^<text\b[^>]*>/)?.[0];
        if (!open) return block;
        const rest = block.slice(open.length);
        const styleFs = open.match(/font-size\s*:\s*([\d.]+)/)?.[1];
        const attrFs = open.match(/\sfont-size="([\d.]+)(?:px)?"/)?.[1];
        const localFontSize = Number(styleFs ?? attrFs);
        const central =
          /\bdominant-baseline="central"/.test(open) ||
          /\balignment-baseline="(?:middle|central)"/.test(open);
        let newOpen = open;
        let newRest = rest;
        if (central && Number.isFinite(localFontSize)) {
          const shift = 0.35 * localFontSize;
          newOpen = shiftTextYAttr(newOpen, shift)
            .replace(/\sdominant-baseline="[^"]*"/g, "")
            .replace(/\salignment-baseline="[^"]*"/g, "");
          newRest = newRest.replace(/<tspan\b[^>]*>/g, (t) =>
            shiftTextYAttr(t, shift),
          );
        }
        // #2068 오너 v4(2026-07-25) 픽셀 실측 교정 — **칩 텍스트 font-size는
        // 아무 배율도 곱하지 않는다.** 렌더러가 칩 텍스트에 적용하는 실효 배율은
        // (칩 그룹 스케일 s × 맵 레이어 스케일 k)이므로, 최종 렌더 em이 오너
        // 의도값 L×s×k가 되려면 .vec에 적힌 값이 로컬 원값 L 그대로여야 한다.
        // 그래서 여기서 s를 곱하지 않고, 뒤이은 normalizeTextBaselineAndScale의
        // ×k 패스에서도 이 텍스트를 제외한다(아래 표식 속성).
        //
        // v2까지 `×s`가 통했던 이유는 우연이다 — v2 칩은 s=2.198, k=0.455라
        // s×k=1.00009로 사실상 1이어서 `L×s×k ≈ L`이었다. 오너가 v4에서 칩
        // 배치를 matrix(2.7475,…)로 키우며 s×k=1.25011이 되자 이 우연이 깨져
        // 칩 숫자가 1.25배 커지고 캡슐 중심에서 1.85design px 위로 떠올랐다
        // (route_map_basemap_badge_center_test 실측: 신창 ratio -0.19 > 0.15).
        // 실측 대조(신창 "1" 잉크, design px):
        //   v2(정상)            높이 7.79  · bbox 중심 -0.06 · ratio -0.035
        //   v4 `×s`(결함)       높이 12.04 · bbox 중심 -1.85 · ratio -0.190
        //   v4 스케일 면제(교정) 높이 9.63  · bbox 중심 -0.06 · ratio -0.044
        // 교정본 높이 9.63 = v2 높이 × 1.25(오너가 키운 배율) — 오너 디자인을
        // 그대로 렌더한다. baseline shift(0.35×L, 위)는 로컬 프레임 값이라
        // 렌더에서 0.35×L×s×k = 0.35×(렌더 em)이 돼 중심 정렬이 유지된다.
        //
        // s는 이제 font-size 산술에는 쓰이지 않지만, "축정렬 균일 스케일 그룹만
        // 대상"이라는 적용 범위 판정에는 그대로 쓴다(회전·비균일 그룹은 이 모델이
        // 성립하지 않으므로 손대지 않는다).
        // 면제 표식은 `<text>`뿐 아니라 **칩 내부 `<tspan>`에도** 붙인다.
        // 소비 측 scaleStyleFontSize는 `/<(?:text|tspan)\b[^>]*>/`로 tspan까지
        // 대상으로 잡으므로, tspan에 표식이 없으면 그 style font-size만 ×k돼
        // 한 칩 안에 로컬 원값과 ×k 값 두 배율이 섞인다(v4 실측 해당 tspan 0건 —
        // 잠복 결함 선차단). 산출물에는 남지 않는다(normalizeSvgForCompile 말미 제거).
        newOpen = newOpen.replace(
          /^<text\b/,
          `<text ${TERMINAL_CHIP_FONT_EXEMPT_ATTR}="true"`,
        );
        newRest = newRest.replace(
          /<tspan\b/g,
          `<tspan ${TERMINAL_CHIP_FONT_EXEMPT_ATTR}="true"`,
        );
        return newOpen + newRest;
      });
    },
  );
}

// 여는 태그 [startIndex]에 대응하는 요소 끝 인덱스(자기폐쇄면 그 태그 끝).
// matchingGroupEnd의 태그명 일반화판 — display:none 제거가 `<g>`뿐 아니라
// `<text>`·`<path>` 등 어떤 요소에도 적용돼야 하기 때문이다.
function matchingElementEnd(text, startIndex, tagName) {
  const openTag = text.slice(startIndex).match(/^<[A-Za-z][\w:.-]*\b[^>]*>/)?.[0];
  if (!openTag) {
    throw new Error(`${tagName} 여는 태그를 해석하지 못했습니다.`);
  }
  if (openTag.endsWith("/>")) return startIndex + openTag.length;
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}>`, "g");
  tagRe.lastIndex = startIndex;
  let depth = 0;
  for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return tagRe.lastIndex;
    } else if (!m[0].endsWith("/>")) {
      depth += 1;
    }
  }
  throw new Error(
    `${tagName}의 닫는 태그를 찾지 못했습니다 — 조용히 건너뛰지 않고 실패합니다.`,
  );
}

// #2068 SVG 충실도(2026-07-26): display:none 요소를 컴파일 입력에서 제거한다.
// 오너가 숨긴 요소는 오너 도식에 **보이지 않는다** — 바탕층에도 없어야 한다.
// 역명 라벨 레이어를 반입하면서 대구 역번호 라벨 17건(class="station-code"
// display="none")이 컴파일 입력에 들어오는데, vector_graphics_compiler가 이
// 속성을 존중하는지에 산출 충실도를 의존시키지 않고 여기서 결정적으로 잘라낸다
// (수도권 경의중앙선 숨김 path 2건·환승 베이스 레이어도 같은 처리). CSS 클래스가
// 준 display:none도 잡히도록 inlineSimpleClassStyles 뒤에 적용한다.
// `<style>`/`<defs>` 자체는 속성에 display가 없어 대상이 아니다.
export function stripHiddenElements(markup) {
  let result = markup;
  for (;;) {
    const match = result.match(
      /<([A-Za-z][\w:.-]*)\b(?=[^>]*(?:\sdisplay="none"|style="[^"]*display\s*:\s*none))[^>]*>/,
    );
    if (!match) return result;
    const end = matchingElementEnd(result, match.index, match[1]);
    result = result.slice(0, match.index) + result.slice(end);
  }
}

export function normalizeSvgForCompile(svgText) {
  const extracted = extractMapSvg(svgText);
  const k = scaleFromMapTransform(
    extracted.match(
      /<g id="compiled-map-coordinate-layer" transform="([^"]+)"/,
    )?.[1],
  );
  const inlined = stripHiddenElements(
    foldTerminalChipScale(inlineSimpleClassStyles(extracted)),
  )
    .replace(
      /font-weight="(\d+)"/g,
      (_m, v) => `font-weight="${normalizeFontWeightValue(v)}"`,
    )
    .replace(
      /font-weight:\s*(\d+)/g,
      (_m, v) => `font-weight:${normalizeFontWeightValue(v)}`,
    )
    .replace(
      /([\s"'])(x|y|dx|dy)="([^"]*)"/g,
      (_m, boundary, attr, value) => {
        const first = value.trim().split(/\s+/)[0] ?? value;
        return `${boundary}${attr}="${first}"`;
      },
    );
  // 칩 폰트 스케일 면제 표식은 정규화 파이프라인 내부용이라 컴파일 입력에서 지운다.
  return normalizeTextBaselineAndScale(inlined, k).replaceAll(
    ` ${TERMINAL_CHIP_FONT_EXEMPT_ATTR}="true"`,
    "",
  );
}

// vector_graphics_compiler를 apps/mobile 컨텍스트에서 실행한다. `--packages`가
// 자동 해석되도록 cwd를 apps/mobile로 둔다. 경로는 전부 절대경로로 넘긴다.
// 원본 SVG를 정규화한 임시 사본을 컴파일 입력으로 쓴다(원본 불변).
function compile(inputSvg, outputVec, normalizedSvgDir) {
  const normalizedSvg = path.join(
    normalizedSvgDir,
    `${path.basename(outputVec, ".vec")}.svg`,
  );
  writeFileSync(
    normalizedSvg,
    normalizeSvgForCompile(readFileSync(inputSvg, "utf8")),
  );
  execFileSync(dartBin, [
    "run",
    "vector_graphics_compiler",
    "-i",
    normalizedSvg,
    "-o",
    outputVec,
  ], { cwd: mobileDir, stdio: ["ignore", "inherit", "inherit"] });
}

const labelsSidecarPath = path.join(outDir, "labels.json");

function main() {
  const verify = process.argv.slice(2).includes("--verify");
  mkdirSync(outDir, { recursive: true });

  // 정규화 임시 SVG·재현검증 산출물은 커밋 대상 밖(.tmp)에 둔다.
  const tmpDir = path.join(outDir, ".tmp");
  const normalizedSvgDir = path.join(tmpDir, "svg");
  const verifyDir = path.join(tmpDir, "verify");
  mkdirSync(normalizedSvgDir, { recursive: true });
  if (verify) {
    mkdirSync(verifyDir, { recursive: true });
  }

  let allMatch = true;
  const buildMaps = [];
  const labelsByRegion = {};
  const serviceTagObstaclesByRegion = {};
  try {
    for (const region of regions) {
      const inputSvg = path.join(svgSourceDir, region.svg);
      const outputVec = path.join(outDir, `${region.id}.vec`);
      const sourceSvg = readFileSync(inputSvg);
      const sourceText = sourceSvg.toString("utf8");
      const normalizedSvg = normalizeSvgForCompile(sourceText);
      const viewBox = sourceText
        .match(/\bviewBox="([^"]+)"/)?.[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (viewBox?.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
        throw new Error(`${region.svg}: 유효한 viewBox를 찾지 못했습니다.`);
      }
      compile(inputSvg, outputVec, normalizedSvgDir);
      const digest = sha256(outputVec);
      const ownerLabels = markLineTerminalBadgeEntries(
        extractOwnerLabels(sourceText, region.id),
        sourceText,
      );
      labelsByRegion[region.id] = ownerLabels;
      // 부산·대구형(service-tag) + 대전·광주형(rail chip) 표장 장애물을 합쳐
      // 단일 회피 목록으로 낸다 — 앱·게이트는 origin 구분 없이 rect로 소비한다.
      serviceTagObstaclesByRegion[region.id] = [
        ...extractServiceTagObstacles(sourceText),
        ...extractRailTransferChipObstacles(sourceText),
      ];
      buildMaps.push({
        id: region.id,
        source: path.relative(root, inputSvg).replaceAll(path.sep, "/"),
        compiledVector: path.relative(root, outputVec).replaceAll(path.sep, "/"),
        sourceSvgSha256: sha256Value(sourceSvg),
        normalizedSvgSha256: sha256Value(normalizedSvg),
        compiledVectorSha256: digest,
        viewBox,
        ownerLabelCount: ownerLabels.length,
      });
      process.stdout.write(
        `${region.id}.vec  sha256=${digest}  ownerLabels=${ownerLabels.length}\n`,
      );

      if (verify) {
        const secondVec = path.join(verifyDir, `${region.id}.vec`);
        compile(inputSvg, secondVec, normalizedSvgDir);
        const secondDigest = sha256(secondVec);
        const match = secondDigest === digest;
        allMatch &&= match;
        process.stdout.write(
          `${region.id}.vec  재현검증(2회) ${match ? "일치" : "불일치"}` +
            `${match ? "" : ` (${secondDigest})`}\n`,
        );
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  if (verify) {
    if (!allMatch) {
      process.stderr.write(
        "컴파일 산출이 비결정적입니다(2회 sha256 불일치). 실패로 종료합니다.\n",
      );
      process.exit(1);
    }
    process.stdout.write("전 권역 재현검증 통과: 2회 컴파일 sha256 동일.\n");
  }

  // 오너 라벨 sidecar(#2068 6차): basemap 모드가 자동 솔버 대신 참조하는 SVG
  // 실측 앵커. 5권역 결합 단일 파일 — metro_map_pack/basemap/ 디렉터리는
  // pubspec.yaml에 통째로 등록돼 있어 추가 자산 등록이 필요 없다.
  const labelsSidecarJson = `${JSON.stringify(
    {
      schemaVersion: 1,
      artifactKind: "route-map-basemap-owner-labels",
      regions: labelsByRegion,
      // #2068 마감 라운드 item 3: KTX·SRT·AIR 표장 장애물(라벨 회피용) —
      // 추가 필드라 기존 파서(regions만 읽음)와 하위호환.
      serviceTagObstacles: serviceTagObstaclesByRegion,
    },
    null,
    2,
  )}\n`;
  writeFileSync(labelsSidecarPath, labelsSidecarJson);
  const labelsSidecarSha256 = sha256Value(labelsSidecarJson);
  process.stdout.write(
    `labels.json  sha256=${labelsSidecarSha256}  regions=${Object.keys(labelsByRegion).length}\n`,
  );

  writeFileSync(
    buildManifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "route-map-basemap-build-manifest",
        compiler: {
          package: "vector_graphics_compiler",
          version: compilerVersion,
        },
        // #2068 리뷰 M2(2026-07-26): compiler.version은 pubspec.lock에 잠긴
        // **패키지 버전 그대로**를 적는 필드다(현재 1.2.6). 컴파일 의미가 바뀌었다고
        // 이 값을 올리면 패키지 버전에 대한 거짓말이 되므로 올리지 않고, 산출 의미의
        // 개정은 아래 pipelineRevision으로 따로 기록한다.
        pipelineRevision: basemapPipelineRevision,
        content: {
          // #2068 SVG 충실도(2026-07-26): 실태 갱신. 이제 노선·역 심벌만이 아니라
          // 오너 SVG의 **지도 본문 레이어 전수**(MAP_BODY_LAYER_IDS)를 굽는다.
          svgLayer: "owner-svg-map-body-layers",
          stationSymbols: "owner-svg",
          // 앱의 오너 앵커 고정 배치도 솔버 폴백도 바탕층 모드에서 실행되지 않는다
          // — 역명 글자는 .vec에 구워져 있다(오너 결정 "글자도 복붙").
          labels: "baked-into-vec",
          // 캔버스 장식(헤더·범례·상단 설명 박스·카드 배경·규격 견본)은 반입 금지
          // (EXCLUDED_DECOR_LAYERS 명시 계약 + 분류 완전성 게이트).
          decoration: "excluded",
          interaction: "route_map_positions",
        },
        ownerLabelsSidecar: {
          path: path
            .relative(root, labelsSidecarPath)
            .replaceAll(path.sep, "/"),
          sha256: labelsSidecarSha256,
        },
        maps: buildMaps,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
