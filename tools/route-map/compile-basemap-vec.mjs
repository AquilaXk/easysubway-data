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
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ── font-weight: CSS Fonts 4 폰트 매칭(#2068 오너 지적, 2026-07-26) ──────────
//
// 오너 SVG는 650·720·750·760·780·850 같은 **비 100배수** font-weight를 쓴다.
// vector_graphics_compiler 1.2.6의 `parseFontWeight`는 100 배수 문자열만 받고
// 나머지는 `StateError`로 던진다 — 그래서 컴파일 입력에서 값을 확정해야 한다.
//
// 종전 구현은 `Math.round(n/100)*100`(가장 가까운 100배수)이었다. 이는 CSS 사양이
// 아니라 임의 반올림이라 원본 의미를 잃는다: 720은 이 규칙에서 700이 되지만,
// CSS Fonts 4 §5.2 폰트 매칭은 "목표가 500 초과면 **목표 이상**의 굵기를 오름차순
// 우선"이라 실제 렌더 페이스는 800이다. 즉 준수 렌더러(브라우저·Inkscape)와
// 우리 산출물이 서로 다른 페이스를 골랐다.
//
// 여기서는 사양의 매칭 알고리즘을 **번들된 Pretendard 페이스 집합**에 그대로
// 적용해, 준수 렌더러가 고를 페이스의 굵기를 확정 값으로 적는다. 실측 계수가
// 아니라 사양 + pubspec 번들 목록에서 유도된 값이다(게이트가 목록 일치를 강제).
// 매칭이 불가능하면(번들 굵기 0건 등) 조용히 넘기지 않고 던진다.
const BUNDLED_TEXT_FONT_WEIGHTS = [400, 600, 700, 800, 900];

/**
 * CSS Fonts 4 §5.2 "font-weight 매칭"을 [available]에 적용한다.
 *   - 목표가 정확히 있으면 그것.
 *   - 400 ≤ 목표 ≤ 500: 목표 이상 500 이하 오름차순, 그다음 목표 미만 내림차순,
 *     그다음 500 초과 오름차순.
 *   - 목표 < 400: 목표 미만 내림차순, 그다음 목표 초과 오름차순.
 *   - 목표 > 500: 목표 초과 오름차순, 그다음 목표 미만 내림차순.
 */
export function matchFontWeight(target, available = BUNDLED_TEXT_FONT_WEIGHTS) {
  const pool = [...new Set(available)].sort((a, b) => a - b);
  if (pool.length === 0) {
    throw new Error("font-weight 매칭 대상(번들 굵기)이 비어 있습니다.");
  }
  if (pool.includes(target)) return target;
  const below = pool.filter((w) => w < target).sort((a, b) => b - a);
  const above = pool.filter((w) => w > target).sort((a, b) => a - b);
  const order = [];
  if (target >= 400 && target <= 500) {
    // 400~500: 목표 이상 500 이하를 오름차순 → 목표 미만 내림차순 → 500 초과 오름차순.
    order.push(
      ...above.filter((weight) => weight <= 500),
      ...below,
      ...above.filter((weight) => weight > 500),
    );
  } else if (target < 400) {
    order.push(...below, ...above);
  } else {
    order.push(...above, ...below);
  }
  const matched = order.find((w) => pool.includes(w));
  if (matched == null) {
    throw new Error(`font-weight ${target}에 매칭되는 번들 굵기가 없습니다.`);
  }
  return matched;
}

// 키워드 → 수치(CSS Fonts 4). 상대 키워드(bolder/lighter)는 상속 문맥이 필요해
// 지원하지 않는다 — 등장하면 던진다(현행 5권역 소스에는 0건).
const FONT_WEIGHT_KEYWORDS = new Map([
  ["normal", 400],
  ["bold", 700],
]);

/** 선언된 font-weight 값을 번들 페이스 굵기 문자열로 확정한다. */
export function resolveFontWeightValue(raw) {
  const value = String(raw).trim();
  if (FONT_WEIGHT_KEYWORDS.has(value)) {
    return String(matchFontWeight(FONT_WEIGHT_KEYWORDS.get(value)));
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Error(
      `지원하지 않는 font-weight 값입니다: "${raw}". CSS Fonts 4는 1~1000 정수 ` +
        "또는 normal/bold만 허용합니다 — 조용히 반올림하지 않고 실패합니다.",
    );
  }
  return String(matchFontWeight(n));
}

/** 마크업 전체의 font-weight(속성형·style 선언형)를 번들 페이스 굵기로 확정한다. */
function resolveFontWeights(markup) {
  return markup
    .replace(
      /font-weight="([^"]+)"/g,
      (_m, v) => `font-weight="${resolveFontWeightValue(v)}"`,
    )
    .replace(
      /font-weight:\s*([^;"}]+)/g,
      (_m, v) => `font-weight:${resolveFontWeightValue(v)}`,
    );
}

// 노선 형상·역 심벌만 추출하고 컴파일러가 거부하는 SVG 속성을 정규화한다(원본 불변).
// CSS 인라인화 대상 property 목록 — 나머지는 렌더 무관 property 목록
// (RENDER_NEUTRAL_STYLE_PROPERTIES)에 있어야 하며, 둘 다 아니면 fail-closed다.
const supportedClassStyleProperties = new Set([
  "alignment-baseline",
  "display",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "font-family",
  "font-size",
  "font-weight",
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
  // SVG2 기하 property(원 반지름). CSS로 선언되면 presentation attribute를 이긴다.
  "r",
  // non-scaling-stroke는 expandNonScalingStroke가 stroke-width로 동치 전개한다.
  "vector-effect",
]);

// ── 표현 불가 property(#2593 리뷰 Major, 2026-07-26) ─────────────────────────
//
// 준수 렌더러는 반영하지만 `.vec` 형식이 **담을 자리가 없는** property다.
// vector_graphics_codec 1.1.13의 `TextConfig`는 text·xAnchorMultiplier·fontFamily·
// fontWeight·fontSize·decoration 3종만 싣는다 — letter-spacing·word-spacing·
// font-style 필드가 아예 없어, 컴파일러가 값을 읽어도 인코딩에서 사라진다.
//
// 그래서 이 property들은 supportedClassStyleProperties(= 인라인하면 렌더에 반영되는
// 목록)에 두지 않는다. 대신
//   ① 캐스케이드가 유효값을 요소에 그대로 인라인해 컴파일 입력이 오너 SVG의 의미를
//      잃지 않게 하고(원본이 정본),
//   ② `unrepresentableTextDeclarations()`가 건수를 세어 산출 로그·게이트에 드러낸다
//      — 조용한 유실을 금지한다.
// 재현하려면 글자별 x 좌표로 펼쳐야 하는데, 번들 폰트의 advance·커닝을 해석해
// 텍스트마다 글리프 수만큼 `<tspan>`을 만들어야 한다(텍스트 draw 3~4배 증가,
// text-anchor 청크 의미 변경). 비용·회귀 위험이 커서 #2571에 후속으로 남긴다.
export const UNREPRESENTABLE_TEXT_PROPERTIES = new Set([
  "letter-spacing",
  "word-spacing",
  "font-style",
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

export const EXCLUDED_DECOR_LAYER_ID_SET = new Set(
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

// 속성명 앞을 공백/태그시작으로 앵커한다. `\b`는 `-`와 문자 사이에서도 성립해
// `data-curve-style="round"`(daegu v3 실재)가 `style` 조회에 잡힌다(#2593 리뷰).
function nodeAttr(node, name) {
  return (node.openTag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`)) || [])[1];
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

// ── 전량 반입 계약(#2068 오너 최종 지시, 2026-07-26) ─────────────────────────
//
// 오너 결정: **"이제 그냥 100% 동일하게 해서 써도 돼, 건들지 마."**
// 오너가 SVG를 정리해 주므로 앱은 **입력 SVG 전체를 그대로 굽는다.** 무엇을 담을지
// 고르는 코드는 파이프라인에 하나도 없다 — 레이어 화이트리스트, 장식 제외 계약,
// 장식 bbox 판정, 표장 골라 담기, 색·상태 기반 필터, 요소 재생성이 전부 폐기됐다.
//
// 남는 것은 **동치 변환**뿐이다. vector_graphics_compiler 1.2.6이 SVG의 일부
// 의미를 직접 해석하지 못하므로, 그 의미를 잃지 않도록 마크업에 **명시적으로
// 펼치는** 단계만 둔다(각 단계 주석에 근거와 동치성 논증을 적는다). 값을 보정하는
// 계수·근사는 금지다.
function extractMapSvg(svgText) {
  if (!/<svg\b[^>]*>/.test(svgText)) {
    throw new Error("SVG 루트 태그를 찾지 못했습니다.");
  }
  return svgText;
}

// ── `<style>` 캐스케이드 전개(#2068 오너 지적, 2026-07-26) ────────────────────
//
// vector_graphics_compiler 1.2.6은 `<style>` 블록을 **읽지 않는다**. 그래서 CSS가
// 준 선언을 컴파일 입력에서 요소 속성으로 펼쳐야 오너 도식과 같은 렌더가 나온다.
//
// 종전 구현은 `.class`·`.a.b` 형태의 단순 선택자만 인라인하고 나머지를 **조용히
// 버렸다** — 실측 5권역에서 버려진 규칙이 84건(수도권 57)이었고, 그중에는
// `#…-map text { font-family:Pretendard }`(전 텍스트의 서체!),
// `#station-name-labels-layer text { paint-order:stroke; stroke:#FFFFFF; … }`
// (대전·광주 역명 halo) 같은 렌더 핵심 선언이 들어 있었다. 즉 "SVG 그대로"가
// 아니었다.
//
// 여기서는 SVG/CSS 캐스케이드를 사양대로 구현한다:
//   - 선택자: 타입·`*`·`.class`·`#id`·`[attr]`·`[attr=value]`·`:not(단순선택자)`의
//     compound와, 자손(공백)·자식(`>`) 결합자.
//   - 특이도: (#id, .class/[attr]/:pseudo, 타입) 3원 튜플. `:not()`은 인자의
//     특이도를 그대로 더한다(CSS Selectors 4).
//   - 정렬: !important 우선 → 특이도 → 소스 순서(뒤가 이김).
//   - presentation attribute는 어떤 CSS 선언에도 진다(SVG 사양) → 인라인 시 덮어씀.
//   - 인라인 `style="…"`은 !important 아닌 CSS를 이긴다 → 그런 선언은 속성으로
//     쓰되 기존 인라인 style 선언을 건드리지 않는다(속성 < style 우선순위 그대로).
//     !important CSS는 인라인 style도 이기므로 style 선언 자체를 교체한다.
// 지원하지 않는 선택자·at-rule·property를 만나면 **던진다** — 조용한 유실 금지.

const CSS_COMBINATORS = new Set([" ", ">"]);

// XML 엔티티 ↔ 평문. `<style>` 내용은 XML 텍스트라 `&quot;` 같은 엔티티가 그대로
// 들어온다(오너 SVG의 `[data-label-role=&quot;ordinary&quot;]`·font-family 목록).
// 디코드하지 않으면 선택자 파싱과 `;` 분리가 모두 깨진다.
const XML_ENTITIES = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
];

function decodeXmlText(value) {
  let result = value;
  for (const [entity, plain] of XML_ENTITIES) result = result.replaceAll(entity, plain);
  return result.replaceAll("&amp;", "&");
}

function encodeXmlAttributeValue(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 따옴표 안의 구분자를 건너뛰며 자른다(`font-family:"a; b", c` 안전). */
function splitTopLevel(value, separator) {
  const parts = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

// 렌더에 영향이 없어 인라인하지 않아도 의미가 보존되는 property → 중립인 값 집합
// (null이면 모든 값이 중립). 여기에도 supportedClassStyleProperties에도 없는
// property, 또는 중립 값 집합 밖의 값이 **실제 요소에 적용되면** 던진다.
//   - pointer-events·cursor·will-change : 정적 래스터 산출에 영향이 없다.
//   - shape-rendering·text-rendering·color-scheme : 렌더 힌트일 뿐 기하가 안 변한다.
//   - isolation : 혼합 그룹 격리. 이 문서에는 mix-blend-mode가 없어 무의미하다.
//   - vector-effect : `none`만 중립. `non-scaling-stroke`는 stroke 폭 의미가 달라
//     컴파일러가 표현하지 못하므로 실제 적용되면 실패한다.
//   - mix-blend-mode : `normal`만 중립.
const RENDER_NEUTRAL_STYLE_PROPERTIES = new Map([
  ["color-scheme", null],
  ["cursor", null],
  ["isolation", null],
  ["mix-blend-mode", new Set(["normal"])],
  ["pointer-events", null],
  ["shape-rendering", null],
  ["text-rendering", null],
  // `none`만 중립. `non-scaling-stroke`는 expandNonScalingStroke가 동치 전개한다.
  ["vector-effect", new Set(["none"])],
  ["will-change", null],
]);

function isRenderNeutralDeclaration(property, value) {
  if (!RENDER_NEUTRAL_STYLE_PROPERTIES.has(property)) return false;
  const neutralValues = RENDER_NEUTRAL_STYLE_PROPERTIES.get(property);
  return neutralValues == null || neutralValues.has(value);
}

/** compound 선택자 하나를 파싱한다(타입/`*`/`.`/`#`/`[]`/`:not()`). */
function parseCompoundSelector(raw, whole) {
  const compound = {
    tag: null,
    ids: [],
    classes: [],
    attributes: [],
    negations: [],
    root: false,
    specificity: [0, 0, 0],
  };
  let rest = raw;
  // 타입 선택자에 `:`를 넣지 않는다 — `circle:not(...)`의 의사클래스를 삼킨다.
  const typeMatch = rest.match(/^(\*|[A-Za-z][\w-]*)/);
  if (typeMatch) {
    if (typeMatch[1] !== "*") {
      compound.tag = typeMatch[1];
      compound.specificity[2] += 1;
    }
    rest = rest.slice(typeMatch[1].length);
  }
  while (rest.length > 0) {
    let match;
    if ((match = rest.match(/^#([^\s.#[\]:>,]+)/))) {
      compound.ids.push(match[1]);
      compound.specificity[0] += 1;
    } else if ((match = rest.match(/^\.([^\s.#[\]:>,]+)/))) {
      compound.classes.push(match[1]);
      compound.specificity[1] += 1;
    } else if (
      (match = rest.match(
        /^\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?\]/,
      ))
    ) {
      compound.attributes.push({
        name: match[1],
        value: match[2] ?? match[3] ?? match[4] ?? null,
      });
      compound.specificity[1] += 1;
    } else if ((match = rest.match(/^:root\b/))) {
      compound.root = true;
      compound.specificity[1] += 1;
    } else if ((match = rest.match(/^:not\(([^()]*)\)/))) {
      const inner = parseCompoundSelector(match[1].trim(), whole);
      compound.negations.push(inner);
      for (let index = 0; index < 3; index += 1) {
        compound.specificity[index] += inner.specificity[index];
      }
    } else {
      throw new Error(
        `지원하지 않는 CSS 선택자 조각입니다: "${rest}" (선택자 "${whole}"). ` +
          "조용히 버리지 않고 실패합니다 — 파서를 확장하거나 오너 SVG를 조정하세요.",
      );
    }
    rest = rest.slice(match[0].length);
  }
  return compound;
}

/** 복합 선택자를 `[{combinator, compound}, …]`(문서 앞→뒤 순)으로 파싱한다. */
export function parseCssSelector(selector) {
  const trimmed = selector.trim();
  if (trimmed === "") throw new Error("빈 CSS 선택자입니다.");
  if (/[+~]/.test(trimmed)) {
    throw new Error(
      `지원하지 않는 형제 결합자(+/~)가 있습니다: "${selector}" — 실패합니다.`,
    );
  }
  const tokens = trimmed
    .split(/\s*(>)\s*|\s+/)
    .filter((part) => part != null && part !== "");
  const parts = [];
  let combinator = null;
  for (const token of tokens) {
    if (CSS_COMBINATORS.has(token)) {
      combinator = token;
      continue;
    }
    parts.push({
      combinator: parts.length === 0 ? null : (combinator ?? " "),
      compound: parseCompoundSelector(token, selector),
    });
    combinator = null;
  }
  if (parts.length === 0) {
    throw new Error(`CSS 선택자를 해석하지 못했습니다: "${selector}"`);
  }
  const specificity = [0, 0, 0];
  for (const part of parts) {
    for (let index = 0; index < 3; index += 1) {
      specificity[index] += part.compound.specificity[index];
    }
  }
  return { parts, specificity };
}

function elementClasses(node) {
  return new Set(
    (firstAttr(node.openTag, "class") ?? "").split(/\s+/).filter(Boolean),
  );
}

function matchesCompound(node, compound) {
  if (compound.root && !(node.parent && node.parent.name === "#root")) return false;
  if (compound.tag != null && compound.tag !== node.name) return false;
  const id = firstAttr(node.openTag, "id");
  if (compound.ids.some((wanted) => wanted !== id)) return false;
  if (compound.classes.length > 0) {
    const classes = elementClasses(node);
    if (!compound.classes.every((name) => classes.has(name))) return false;
  }
  for (const attribute of compound.attributes) {
    const actual = firstAttr(node.openTag, attribute.name);
    if (actual == null) return false;
    if (attribute.value != null && actual !== attribute.value) return false;
  }
  return compound.negations.every((inner) => !matchesCompound(node, inner));
}

/** 오른쪽 compound부터 조상으로 거슬러 올라가며 결합자를 확인한다. */
function matchesSelector(node, selector) {
  const parts = selector.parts;
  if (!matchesCompound(node, parts[parts.length - 1].compound)) return false;
  let current = node;
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const combinator = parts[index].combinator;
    const target = parts[index - 1].compound;
    if (combinator === ">") {
      current = current.parent;
      if (!current || current.name === "#root" || !matchesCompound(current, target)) {
        return false;
      }
    } else {
      let ancestor = current.parent;
      let found = null;
      while (ancestor && ancestor.name !== "#root") {
        if (matchesCompound(ancestor, target)) {
          found = ancestor;
          break;
        }
        ancestor = ancestor.parent;
      }
      if (!found) return false;
      current = found;
    }
  }
  return true;
}

/** `--name: value` 정의를 모은다. 같은 이름에 서로 다른 값이 오면 던진다. */
function collectCustomProperties(blocks) {
  const values = new Map();
  for (const block of blocks) {
    for (const raw of splitTopLevel(block, ";")) {
      const item = raw.trim();
      if (!item.startsWith("--")) continue;
      const [name, value] = splitTopLevel(item, ":").map((part) => part?.trim());
      if (!name || value == null) continue;
      if (values.has(name) && values.get(name) !== value) {
        throw new Error(
          `CSS 사용자 정의 속성 ${name}이 서로 다른 값(${values.get(name)} / ${value})으로 ` +
            "정의돼 있습니다 — 캐스케이드 문맥별 해석이 필요해 실패합니다.",
        );
      }
      values.set(name, value);
    }
  }
  return values;
}

/** `var(--name[, fallback])`을 정의 값으로 치환한다. 정의가 없으면 던진다. */
function resolveCustomPropertyReferences(value, customProperties) {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g, (_m, name, fallback) => {
    if (customProperties.has(name)) return customProperties.get(name);
    if (fallback != null) return fallback.trim();
    throw new Error(
      `정의되지 않은 CSS 사용자 정의 속성을 참조합니다: ${name} — 실패합니다.`,
    );
  });
}

// 바탕층 산출의 렌더 매체. `@media` 질의는 이 매체 기준으로 평가한다 — 화면용
// 자산이므로 `print` 전용 블록은 애초에 적용되지 않는다(무시가 아니라 사양대로의
// 평가 결과다). 매체 이름 외의 질의(feature·논리 연산)는 던진다.
const TARGET_CSS_MEDIA = "screen";

/**
 * `@media` 블록을 대상 매체 기준으로 평가해 펼치거나 제거한다.
 * 그 밖의 at-rule은 던진다(조용한 무시 금지).
 */
export function resolveMediaBlocks(css) {
  let result = "";
  let cursor = 0;
  for (;;) {
    const at = css.indexOf("@", cursor);
    if (at < 0) {
      result += css.slice(cursor);
      return result;
    }
    result += css.slice(cursor, at);
    const header = css.slice(at).match(/^@([A-Za-z-]+)([^{]*)\{/);
    if (!header || header[1] !== "media") {
      throw new Error(
        `지원하지 않는 CSS at-rule입니다: "${css.slice(at, at + 40).trim()}" ` +
          "— 조용히 무시하지 않고 실패합니다.",
      );
    }
    const query = header[2].trim();
    if (!/^[A-Za-z-]+$/.test(query)) {
      throw new Error(
        `지원하지 않는 @media 질의입니다: "${query}". 매체 이름 하나만 해석합니다 — 실패합니다.`,
      );
    }
    let depth = 0;
    let index = at + header[0].length - 1;
    for (; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error("@media 블록의 닫는 중괄호를 찾지 못했습니다.");
    const body = css.slice(at + header[0].length, index);
    // 본문에 또 다른 at-rule이 중첩될 수 있으므로 재귀로 다시 평가한다.
    if (query === TARGET_CSS_MEDIA || query === "all") result += resolveMediaBlocks(body);
    cursor = index + 1;
  }
}

/** `<style>` 블록에서 규칙 목록을 읽는다(소스 순서 유지). */
export function parseStylesheet(svgText) {
  const css = decodeXmlText(
    [...svgText.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
      .map((match) => match[1])
      .join("\n")
      .replaceAll("<![CDATA[", "")
      .replaceAll("]]>", ""),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...resolveMediaBlocks(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const customProperties = collectCustomProperties(blocks.map((block) => block[2]));
  const rules = [];
  let order = 0;
  for (const block of blocks) {
    const declarations = [];
    for (const raw of splitTopLevel(block[2], ";")) {
      const item = raw.trim();
      if (item === "") continue;
      const separator = item.indexOf(":");
      if (separator < 0) {
        throw new Error(`CSS 선언을 해석하지 못했습니다: "${item}"`);
      }
      const property = item.slice(0, separator).trim();
      const rawValue = resolveCustomPropertyReferences(
        item.slice(separator + 1).trim(),
        customProperties,
      );
      if (property.startsWith("--")) continue; // 정의 자체는 렌더하지 않는다.
      const important = /!important\s*$/.test(rawValue);
      const value = rawValue.replace(/\s*!important\s*$/, "").trim();
      const neutral = isRenderNeutralDeclaration(property, value);
      if (
        !neutral &&
        !supportedClassStyleProperties.has(property) &&
        !UNREPRESENTABLE_TEXT_PROPERTIES.has(property)
      ) {
        // 실제로 요소에 적용될 때 던진다(적용되지 않는 규칙은 무해하다).
        declarations.push({ property, value, important, unsupported: true });
        continue;
      }
      if (neutral) continue;
      declarations.push({ property, value, important, unsupported: false });
    }
    for (const raw of splitTopLevel(block[1], ",")) {
      const selector = raw.trim();
      if (selector === "") continue;
      rules.push({
        selector: parseCssSelector(selector),
        declarations,
        order: order++,
      });
    }
  }
  return rules;
}

// ── vector-effect: non-scaling-stroke 전개(#2068, 2026-07-26) ────────────────
//
// SVG 2 §13.4: `non-scaling-stroke`는 stroke를 **viewport 좌표계**에서 그리라는
// 뜻이다 — 조상 transform이 stroke 폭을 키우거나 줄이지 않는다. 컴파일러는 이
// property를 읽지 않고 stroke 폭에 누적 transform 스케일을 곱한다
// (`AffineMatrix.scaleStrokeWidth`).
//
// .vec는 원본 viewBox 좌표계를 그대로 쓰므로, 요소의 누적 스케일 s로 stroke-width를
// **나눠 두면** 컴파일러가 다시 s를 곱해 viewport 단위 폭이 선언값 그대로 남는다 —
// 사양과 동치인 전개다(맞춘 계수가 아니라 s의 역수). 균일 스케일이 아니면 던진다.
// 렌더 대상이 아닌 컨테이너 요소(자신은 stroke를 그리지 않는다).
const CONTAINER_ELEMENT_NAMES = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "marker",
  "clipPath",
  "mask",
  "pattern",
  "switch",
  "a",
]);

function expandNonScalingStroke(svgText) {
  const root = buildSvgTree(svgText);
  const edits = [];
  (function walk(node) {
    for (const child of node.children) {
      const effect = declaredStyleOrAttr(child.openTag, "vector-effect");
      // SVG 2 §13.4에서 vector-effect는 **상속되지 않는다** — 컨테이너(`<g>` 등)에
      // 붙은 선언은 렌더에 아무 영향이 없는 no-op이므로 건드리지 않는다.
      if (effect === "non-scaling-stroke" && !CONTAINER_ELEMENT_NAMES.has(child.name)) {
        const matrix = composeMatrix(
          ancestorMatrixOf(child),
          parseTransformChain(firstAttr(child.openTag, "transform")),
        );
        const describe = `<${child.name}>(${firstAttr(child.openTag, "id") ?? "id 없음"})`;
        const { scale } = decomposeUniformScale(matrix, describe);
        // stroke-width는 상속 property다 — 조상 선언까지 보고, 아무도 선언하지
        // 않았으면 SVG 초기값 1을 쓴다(사양값이라 맞춘 계수가 아니다).
        const width = inheritedStyleOrAttr(child, "stroke-width") ?? "1";
        let openTag = /\sstroke-width="[^"]*"/.test(child.openTag) ||
          /stroke-width\s*:/.test(firstAttr(child.openTag, "style") ?? "")
          ? scaleLengthDeclaration(child.openTag, "stroke-width", 1 / scale)
          : withProperty(
              child.openTag,
              "stroke-width",
              String(roundCoord(Number(String(width).replace(/px$/, "")) / scale)),
            );
        openTag = openTag
          .replace(/\svector-effect="[^"]*"/g, "")
          .replace(/\sstyle="([^"]*)"/, (_m, styleValue) => {
            const kept = styleValue
              .split(";")
              .map((item) => item.trim())
              .filter(Boolean)
              .filter((item) => !/^vector-effect\s*:/.test(item));
            return kept.length ? ` style="${kept.join(";")}"` : "";
          });
        edits.push({ start: child.start, length: child.openTag.length, openTag });
      }
      walk(child);
    }
  })(root);
  return applyOpenTagEdits(svgText, edits);
}

/**
 * 조상 체인까지 거슬러 상속 property의 유효 선언을 찾는다.
 * (font-size·stroke-width·letter-spacing 등 SVG 상속 property용.)
 */
function inheritedStyleOrAttr(node, property) {
  for (let current = node; current && current.name !== "#root"; current = current.parent) {
    const value = declaredStyleOrAttr(current.openTag, property);
    if (value != null && value !== "" && value !== "inherit") return value;
  }
  return null;
}

/** 여는 태그 자체가 display:none을 선언하는지(속성형·인라인 style형). */
function isHiddenOpenTag(openTag) {
  if (firstAttr(openTag, "display") === "none") return true;
  return /display\s*:\s*none/.test(firstAttr(openTag, "style") ?? "");
}

/** 인라인 `style="…"` 선언을 `Map(property → value)`으로 읽는다. */
function parseInlineStyle(openTag) {
  const style = firstAttr(openTag, "style");
  const declarations = new Map();
  if (!style) return declarations;
  for (const raw of splitTopLevel(decodeXmlText(style), ";")) {
    const item = raw.trim();
    if (item === "") continue;
    const separator = item.indexOf(":");
    if (separator < 0) continue;
    declarations.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return declarations;
}

function withInlineStyle(openTag, declarations) {
  const serialized = encodeXmlAttributeValue(
    [...declarations].map(([property, value]) => `${property}:${value}`).join(";"),
  );
  if (/\sstyle="[^"]*"/.test(openTag)) {
    return openTag.replace(/\sstyle="[^"]*"/, ` style="${serialized}"`);
  }
  const selfClosing = /\/\s*>$/.test(openTag);
  return `${openTag.replace(/\s*\/?>$/, "")} style="${serialized}"${selfClosing ? " />" : ">"}`;
}

/**
 * `<style>` 규칙을 SVG/CSS 캐스케이드대로 요소 속성·인라인 style로 전개한다.
 * 텍스트 내용·요소 순서는 불변이며 원본 SVG는 건드리지 않는다(컴파일 입력 사본).
 */
export function applyStylesheet(svgText) {
  const rules = parseStylesheet(svgText);
  if (rules.length === 0) return svgText;
  const root = buildSvgTree(svgText);
  const edits = [];
  (function walk(node, hiddenAncestor) {
    for (const child of node.children) {
      const matched = [];
      for (const rule of rules) {
        if (!matchesSelector(child, rule.selector)) continue;
        for (const declaration of rule.declarations) {
          matched.push({
            ...declaration,
            specificity: rule.selector.specificity,
            order: rule.order,
          });
        }
      }
      if (matched.length > 0) {
        // 캐스케이드: !important → 특이도 → 소스 순서. 뒤에 오는 것이 이긴다.
        matched.sort((a, b) => {
          if (a.important !== b.important) return a.important ? 1 : -1;
          for (let index = 0; index < 3; index += 1) {
            if (a.specificity[index] !== b.specificity[index]) {
              return a.specificity[index] - b.specificity[index];
            }
          }
          return a.order - b.order;
        });
        const winners = new Map();
        for (const declaration of matched) winners.set(declaration.property, declaration);
        // 캐스케이드 결과가 display:none이면(조상 포함) 이 요소는 렌더되지 않는다 —
        // stripHiddenElements가 곧 지우므로 미지원 선언이 있어도 산출에 영향이 없다.
        const hidden =
          hiddenAncestor ||
          winners.get("display")?.value === "none" ||
          isHiddenOpenTag(child.openTag);
        let openTag = child.openTag;
        const inline = parseInlineStyle(openTag);
        let inlineChanged = false;
        for (const [property, declaration] of winners) {
          // `!important`는 인라인 style도 이기므로 인라인 선언 유무와 무관하게 던진다.
          if (
            declaration.unsupported &&
            (declaration.important || !inline.has(property)) &&
            !hidden
          ) {
            throw new Error(
              `분류되지 않은 CSS 선언이 실제 요소에 적용됩니다: "${property}: ${declaration.value}" ` +
                `(${child.openTag.slice(0, 120)}). 렌더에 영향이 있으면 ` +
                "supportedClassStyleProperties에, 없으면 RENDER_NEUTRAL_STYLE_PROPERTIES에 " +
                "등재하세요 — 조용히 버리지 않고 실패합니다.",
            );
          }
          if (declaration.unsupported) continue;
          if (declaration.important) {
            // !important는 인라인 style도 이긴다 → style 선언 자체를 교체한다.
            inline.set(property, declaration.value);
            inlineChanged = true;
            continue;
          }
          if (inline.has(property)) continue; // 인라인 style이 일반 CSS를 이긴다.
          // presentation attribute는 CSS에 지므로 덮어쓴다.
          const pattern = new RegExp(`\\s${property}="[^"]*"`);
          const attribute = ` ${property}="${encodeXmlAttributeValue(declaration.value)}"`;
          openTag = pattern.test(openTag)
            ? openTag.replace(pattern, attribute)
            : `${openTag.replace(/\s*(\/?)>$/, "")}${attribute}${
                /\/\s*>$/.test(openTag) ? " />" : ">"
              }`;
        }
        if (inlineChanged) openTag = withInlineStyle(openTag, inline);
        if (openTag !== child.openTag) {
          edits.push({ start: child.start, length: child.openTag.length, openTag });
        }
        walk(child, hidden);
        continue;
      }
      walk(child, hiddenAncestor || isHiddenOpenTag(child.openTag));
    }
  })(root, false);
  let result = svgText;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.openTag + result.slice(edit.start + edit.length);
  }
  // 전개가 끝난 `<style>` 블록은 컴파일 입력에서 지운다 — 컴파일러가 읽지 않는
  // 원본 CSS가 남아 있으면 "요소 선언이 정본"이라는 이 단계의 계약이 흐려지고,
  // 뒤따르는 단계(font-weight 확정 등)가 죽은 텍스트까지 훑는다.
  return result.replace(/\s*<style\b[^>]*>[\s\S]*?<\/style>/g, "");
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

export function firstAttr(tag, name) {
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

export function composeMatrix(A, B) {
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

export function applyMatrix([a, b, c, d, e, f], x, y) {
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

export function parseTransformChain(transformValue) {
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

// ── 텍스트 verbatim 렌더(#2068 오너 실기기 반려, 2026-07-26) ──────────────────
//
// [원인] vector_graphics_compiler 1.2.6은 텍스트의 **위치와 크기를 다른 규칙으로**
// 처리한다:
//   - 위치: `TextPositionNode.computeTextPosition`(svg/node.dart)이 조상 transform을
//     좌표에 흡수하거나(consumeTransform) .vec에 실어 런타임에 넘긴다.
//   - 크기: `TextNode.computeTextConfig`가 `attributes.fontSize`를 **그대로** 적는다
//     — 어떤 transform도 반영하지 않는다.
//   흡수 판정은 `AffineMatrix.encodableInRect`(= `a>0 && b==0 && c==0 && d>0 &&
//   _m4_10==a`)인데, transform 파서가 `scale(...)`에서는 _m4_10을 a와 같이 키우고
//   `matrix(...)`에서는 1.0으로 고정한다(svg/parsers.dart). 즉 **오너가 같은 배치를
//   scale()로 쓰느냐 matrix()로 쓰느냐에 따라 글자 크기가 배율만큼 달라진다.**
//
// 종전 파이프라인은 이 우연에 맞춘 보정을 쌓았다 — 전역 맵 스케일 k를 모든
// font-size에 선곱(normalizeTextBaselineAndScale)하고, 그 규칙이 깨지는 종점 칩만
// 면제 표식(data-basemap-chip-font-exempt)으로 빼는 식(foldTerminalChipScale).
// 실측 결과 수도권에서 **회전 성분이 남은 텍스트 12건**은 흡수가 일어나지 않아
// 런타임이 스케일을 한 번 더 적용, 의도 크기의 0.455배(≈4.8배 작게)로 렌더됐다.
//
// [수정] 보정 대신 **SVG 의미론을 마크업에 펼친다**. 각 `<text>`의 조상+자신
// transform 합성 M을 M = TR·S(평행이동·회전 TR, 균일 스케일 S=s)로 분해하고
//   ① 좌표(x·y·dx·dy, 자손 tspan 포함)를 s배,
//   ② font-size·stroke-width를 s배,
//   ③ 요소 자신의 transform을 `A⁻¹·TR`(A=조상 합성)로 바꿔 **유효 행렬에서 스케일
//      성분을 제거**한다.
// 결과 행렬에 스케일이 없으므로 컴파일러가 흡수하든(좌표만 이동) 싣든(런타임이 TR을
// 적용) 렌더가 같다 — "fontSize에 transform이 반영되지 않는" 버그가 작동할 여지가
// 사라진다. 수학적 동치이고 맞춘 계수가 없다.
// s=1인 텍스트(부산·대구·대전·광주 전량)는 아예 손대지 않아 산출 바이트가 불변이다.
// 균일 스케일이 아니거나(비균일·기울임) 반전(det≤0)이면 이 동치 변환이 성립하지
// 않으므로 던진다 — 조용히 어긋난 렌더를 배포하지 않는다.

// ── dominant-baseline 전개(#2068, 2026-07-26) ────────────────────────────────
//
// 컴파일러는 dominant-baseline을 읽지 않고, 런타임(vector_graphics 1.2.2)은 언제나
// alphabetic baseline에 그린다(listener.dart `_flushPendingTextChunk`의
// `dy - paragraph.alphabeticBaseline`). 종전 구현은 이를 "0.35 × font-size"라는
// **실측으로 맞춘 계수**로 내렸는데, 그 값의 근거는 사양이 아니라 "숫자 잉크 bbox를
// 원 중심에 맞춘 결과"(= cap-height/2, 번들 Pretendard 실측 0.3535em)였다.
//
// 여기서는 사양대로 전개한다. SVG 1.1 §10.9.2: `central` 베이스라인은
// text-before-edge(ascender)와 text-after-edge(descender)의 중점이므로, alphabetic
// baseline 기준 (ascender + descender)/2 만큼 위에 있다. 그 중점을 y에 맞추려면
// baseline을 같은 양만큼 **아래로** 옮기면 된다. `middle`은 x-height의 절반이다.
// 계수는 **번들 폰트 파일에서 읽은 메트릭**에서 유도한다(맞춘 값이 아니다):
//   Pretendard unitsPerEm=2048, hhea ascender=1950, descender=-494, sxHeight=1086
//   → central=(1950-494)/2/2048=0.355469em, middle=1086/2/2048=0.265137em
// SVG 1.1에서 `alignment-baseline`은 tspan/tref/altGlyph/textPath에만 적용되고
// `<text>`에는 적용되지 않는다 — 실측상 5권역 tspan에는 baseline 속성이 0건이라
// `<text>`의 dominant-baseline만 유효하다. 모르는 값은 던진다.

export const TEXT_FONT_FILE = path.join(mobileDir, "fonts/Pretendard-Regular.otf");

/** OpenType(head·hhea·OS/2) 메트릭을 읽는다. sfnt 테이블 디렉터리만 파싱한다. */
export function readOpenTypeMetrics(fontPath) {
  const buffer = readFileSync(fontPath);
  const tableCount = buffer.readUInt16BE(4);
  const offsets = new Map();
  for (let index = 0; index < tableCount; index += 1) {
    const entry = 12 + index * 16;
    offsets.set(
      buffer.toString("ascii", entry, entry + 4),
      buffer.readUInt32BE(entry + 8),
    );
  }
  for (const table of ["head", "hhea", "OS/2"]) {
    if (!offsets.has(table)) {
      throw new Error(`${fontPath}: ${table} 테이블이 없어 메트릭을 읽을 수 없습니다.`);
    }
  }
  const head = offsets.get("head");
  const hhea = offsets.get("hhea");
  const os2 = offsets.get("OS/2");
  const unitsPerEm = buffer.readUInt16BE(head + 18);
  const os2Version = buffer.readUInt16BE(os2);
  if (unitsPerEm <= 0) throw new Error(`${fontPath}: unitsPerEm이 유효하지 않습니다.`);
  if (os2Version < 2) {
    throw new Error(`${fontPath}: OS/2 v${os2Version}에는 sxHeight가 없습니다.`);
  }
  return {
    unitsPerEm,
    ascender: buffer.readInt16BE(hhea + 4),
    descender: buffer.readInt16BE(hhea + 6),
    xHeight: buffer.readInt16BE(os2 + 86),
  };
}

export const TEXT_FONT_METRICS = readOpenTypeMetrics(TEXT_FONT_FILE);

/**
 * dominant-baseline 값 → alphabetic baseline을 **아래로** 옮길 비율(em 단위).
 * 사양 밖 값은 조용히 무시하지 않고 던진다.
 */
export function baselineShiftRatio(value, metrics = TEXT_FONT_METRICS) {
  switch (String(value).trim()) {
    case "":
    case "auto":
    case "baseline":
    case "alphabetic":
      return 0;
    case "central":
      return (metrics.ascender + metrics.descender) / 2 / metrics.unitsPerEm;
    case "middle":
      return metrics.xHeight / 2 / metrics.unitsPerEm;
    default:
      throw new Error(
        `지원하지 않는 dominant-baseline 값입니다: "${value}". ` +
          "런타임이 alphabetic baseline만 그리므로 사양대로 y로 전개해야 합니다 " +
          "— 조용히 무시하지 않고 실패합니다.",
      );
  }
}

/** 여는 태그에 선언된 property 값(인라인 style이 동명 presentation attribute를 이긴다). */
function declaredStyleOrAttr(openTag, property) {
  const style = firstAttr(openTag, "style");
  if (style) {
    const declared = style.match(
      new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`),
    )?.[1];
    if (declared != null) return declared.trim();
  }
  return firstAttr(openTag, property);
}

/** 여는 태그의 수치 property(font-size·stroke-width)를 factor배 한다(px 접미사 유지). */
function scaleLengthDeclaration(openTag, property, factor) {
  let result = openTag.replace(
    new RegExp(`\\s${property}="([\\d.]+)(px)?"`),
    (_m, num, px) => ` ${property}="${roundCoord(Number(num) * factor)}${px ?? ""}"`,
  );
  result = result.replace(/\sstyle="([^"]*)"/, (_m, styleValue) => {
    const scaled = styleValue.replace(
      new RegExp(`(^|;)(\\s*${property}\\s*:\\s*)([\\d.]+)(px)?`),
      (_sm, head, label, num, px) =>
        `${head}${label}${roundCoord(Number(num) * factor)}${px ?? ""}`,
    );
    return ` style="${scaled}"`;
  });
  return result;
}

/** 여는 태그의 좌표 property를 factor배 한다(단일 토큰 전제 — 리스트는 앞 단계가 해소). */
function scaleCoordinateDeclaration(openTag, name, factor) {
  return openTag.replace(
    new RegExp(`\\s${name}="(-?[\\d.]+)"`),
    (_m, value) => ` ${name}="${roundCoord(Number(value) * factor)}"`,
  );
}

/** 조상 체인에서 상속되는 font-size(로컬 단위). 없으면 null. */
function inheritedFontSizeOf(node) {
  for (let current = node; current && current.name !== "#root"; current = current.parent) {
    const declared = declaredStyleOrAttr(current.openTag, "font-size");
    if (declared != null) {
      const value = Number(String(declared).replace(/px$/, ""));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/** `<text>` 자신·자손의 유효 font-size(로컬 단위). 없으면 null. */
function effectiveFontSize(openTag, inherited) {
  const declared = declaredStyleOrAttr(openTag, "font-size");
  if (declared == null) return inherited;
  const value = Number(String(declared).replace(/px$/, ""));
  return Number.isFinite(value) ? value : inherited;
}

// ── per-glyph 좌표 리스트 해소(#2068 오너 지적, 2026-07-26) ──────────────────
//
// SVG는 `<text>`/`<tspan>`의 x·y·dx·dy에 **글리프별 값 리스트**를 허용한다
// (i번째 값이 i번째 글리프에 적용되고, 리스트 길이를 넘는 글리프에는 x·y는 자연
// 진행, dx·dy는 0). 컴파일러의 `DoubleOrPercentage.fromString`은 단일 double만
// 파싱하므로 리스트를 그대로 넘길 수 없다.
//
// 종전 구현은 **무조건 첫 토큰만 남겼다** — 2번째 이후 글리프의 오프셋을 조용히
// 버리는 재해석이다. 여기서는 SVG 의미와 **동치일 때만** 단일 값으로 접고, 동치가
// 아니면 던진다:
//   - dx·dy: 글리프 수 범위 안의 2번째 이후 값이 전부 0이면 첫 값 하나와 동치다
//     (SVG의 dx는 누적 이동이라 첫 값이 런 전체를 민다). 아니면 실패.
//   - x·y: 2번째 이후 값이 글리프 수 범위 안에 있으면 절대 위치 재지정이라 단일
//     값으로 접을 수 없다. 범위 밖이면(=적용될 글리프가 없으면) 첫 값과 동치다.
// 실측(5권역): 부산 v3 벡스코 `dy="0 0 … 59.27"`(19값, 글자 3)만 해당하고 적용
// 범위 안 값이 전부 0이라 동치로 접힌다. 나머지 권역은 리스트 0건이다.
const GLYPH_COORDINATE_ATTRIBUTES = ["x", "y", "dx", "dy"];

/**
 * 요소가 여는 텍스트 청크의 **자손 문자 데이터 전체**.
 *
 * SVG 1.1 §10.5에서 `x`/`y`/`dx`/`dy` 리스트는 그 요소가 여는 청크의 **자손 글리프
 * 전부**에 적용된다. 직접 문자 데이터만 세면 `<text x="1 20 30"><tspan>가나다</tspan></text>`
 * 에서 글리프 수가 0이 돼 리스트가 조용히 첫 토큰으로 잘린다(#2593 리뷰 실증).
 */
function chunkTextOf(svgText, node) {
  if (node.openTag.endsWith("/>")) return "";
  const innerStart = node.start + node.openTag.length;
  const innerEnd = Math.max(node.end - `</${node.name}>`.length, innerStart);
  return svgText.slice(innerStart, innerEnd).replace(/<[^>]*>/g, "");
}

/** 요소의 **직접** 문자 데이터(자식 요소 내용 제외). */
function directTextOf(svgText, node) {
  if (node.openTag.endsWith("/>")) return "";
  let cursor = node.start + node.openTag.length;
  const innerEnd = Math.max(node.end - `</${node.name}>`.length, cursor);
  let text = "";
  for (const child of node.children) {
    if (child.start < cursor) continue;
    text += svgText.slice(cursor, child.start);
    cursor = child.end;
  }
  if (cursor < innerEnd) text += svgText.slice(cursor, innerEnd);
  return text;
}

/** 렌더되는 글리프 수(XML 공백 정규화 후 코드포인트 수). */
function glyphCount(text) {
  return [...text.replace(/\s+/g, " ").trim()].length;
}

/**
 * per-glyph 좌표 리스트를 SVG 의미와 동치인 단일 값으로 접는다.
 * 동치가 아니면 던진다(조용한 재해석 금지).
 */
export function resolveGlyphCoordinateLists(svgText) {
  const root = buildSvgTree(svgText);
  const edits = [];
  (function walk(node) {
    for (const child of node.children) {
      let openTag = child.openTag;
      for (const name of GLYPH_COORDINATE_ATTRIBUTES) {
        const raw = firstAttr(openTag, name);
        if (raw == null) continue;
        const tokens = raw.trim().split(/[\s,]+/).filter(Boolean);
        if (tokens.length <= 1) continue;
        const describe = `<${child.name}>(${firstAttr(openTag, "id") ?? "id 없음"})의 ${name}="${raw}"`;
        if (child.name !== "text" && child.name !== "tspan") {
          throw new Error(
            `${describe}: 텍스트 요소가 아닌데 좌표 리스트를 씁니다 — 해석 규칙이 없어 실패합니다.`,
          );
        }
        const glyphs = glyphCount(chunkTextOf(svgText, child));
        const applied = tokens.slice(0, Math.max(glyphs, 0));
        const tail = applied.slice(1);
        const foldable =
          tail.length === 0 ||
          ((name === "dx" || name === "dy") && tail.every((value) => Number(value) === 0));
        if (!foldable) {
          throw new Error(
            `${describe}: 글리프 ${glyphs}자에 적용되는 값이 2개 이상이라 ` +
              "단일 값으로 접을 수 없습니다(컴파일러가 리스트를 파싱하지 못함) " +
              "— 조용히 잘라내지 않고 실패합니다.",
          );
        }
        openTag = openTag.replace(
          new RegExp(`\\s${name}="[^"]*"`),
          ` ${name}="${tokens[0]}"`,
        );
      }
      if (openTag !== child.openTag) {
        edits.push({ start: child.start, length: child.openTag.length, openTag });
      }
      walk(child);
    }
  })(root);
  return applyOpenTagEdits(svgText, edits);
}

/**
 * `<text>`의 dominant-baseline을 명시적 y로 전개하고 그 속성을 제거한다.
 * (SVG 1.1: alignment-baseline은 `<text>`에 적용되지 않으므로 값만 제거한다.)
 */
export function expandDominantBaseline(svgText) {
  const root = buildSvgTree(svgText);
  const edits = [];
  (function walk(node) {
    for (const child of node.children) {
      if (child.name !== "text") {
        walk(child);
        continue;
      }
      const ratio = baselineShiftRatio(
        declaredStyleOrAttr(child.openTag, "dominant-baseline") ?? "",
      );
      const stripBaseline = (tag) =>
        tag
          .replace(/\sdominant-baseline="[^"]*"/g, "")
          .replace(/\salignment-baseline="[^"]*"/g, "")
          .replace(/\sstyle="([^"]*)"/, (_m, styleValue) => {
            const kept = styleValue
              .split(";")
              .map((item) => item.trim())
              .filter(Boolean)
              .filter((item) => !/^(?:dominant|alignment)-baseline\s*:/.test(item));
            return kept.length ? ` style="${kept.join(";")}"` : "";
          });
      // font-size는 상속 property다 — 자기 선언이 없으면 조상까지 본다.
      const textFontSize = effectiveFontSize(
        child.openTag,
        inheritedFontSizeOf(child.parent),
      );
      const push = (node_, openTag) => {
        if (openTag !== node_.openTag) {
          edits.push({ start: node_.start, length: node_.openTag.length, openTag });
        }
      };
      if (ratio !== 0 && textFontSize == null) {
        throw new Error(
          `dominant-baseline이 있는 <text>(${firstAttr(child.openTag, "id") ?? "id 없음"})에 ` +
            "font-size가 없어 baseline 이동량을 계산할 수 없습니다 — 실패합니다.",
        );
      }
      push(
        child,
        stripBaseline(
          ratio === 0
            ? child.openTag
            : shiftDeclaredY(child.openTag, ratio * textFontSize, {
                defaultWhenAbsent: true,
              }),
        ),
      );
      (function walkTspans(parent, inheritedFontSize) {
        for (const tspan of parent.children) {
          if (tspan.name !== "tspan") continue;
          // SVG 1.1 §10.9.2에서 alignment-baseline은 tspan에 적용되고
          // dominant-baseline도 tspan에서 재선언될 수 있다. 이 전개는 부모 `<text>`
          // 선언만 해석하므로, tspan 자신의 선언은 조용히 무시하지 않고 던진다
          // (현행 5권역 실측 0건 — 오너 SVG에 생기면 사람이 판정해야 한다).
          for (const property of ["dominant-baseline", "alignment-baseline"]) {
            const declared = declaredStyleOrAttr(tspan.openTag, property);
            if (declared != null && baselineShiftRatio(declared) !== 0) {
              throw new Error(
                `<tspan>이 ${property}="${declared}"를 선언했습니다 — 이 전개는 ` +
                  "부모 <text> 선언만 해석하므로 조용히 무시하지 않고 실패합니다.",
              );
            }
          }
          const own = effectiveFontSize(tspan.openTag, inheritedFontSize);
          if (ratio !== 0) {
            push(tspan, shiftDeclaredY(tspan.openTag, ratio * own));
          }
          walkTspans(tspan, own);
        }
      })(child, textFontSize);
    }
  })(root);
  return applyOpenTagEdits(svgText, edits);
}

/**
 * 여는 태그의 절대 y를 shift만큼 내린다.
 *
 * `<text>`가 y를 선언하지 않으면 SVG 기본값 y=0이므로 **명시적으로 붙인다** —
 * 그냥 두면 baseline 속성만 제거돼 이동량이 통째로 사라진다(#2593 리뷰 실증).
 * `<tspan>`은 y 미선언이 "부모에서 온 펜을 그대로 쓴다"는 뜻이고 부모가 이미
 * 이동했으므로 건드리지 않는다.
 */
function shiftDeclaredY(openTag, shift, { defaultWhenAbsent = false } = {}) {
  if (/\sy="(-?[\d.]+)"/.test(openTag)) {
    return openTag.replace(
      /\sy="(-?[\d.]+)"/,
      (_m, value) => ` y="${roundCoord(Number(value) + shift)}"`,
    );
  }
  if (!defaultWhenAbsent) return openTag;
  return withProperty(openTag, "y", String(roundCoord(shift)));
}

/** 여는 태그 교체 편집 목록을 뒤에서부터 적용한다. */
function applyOpenTagEdits(svgText, edits) {
  if (edits.length === 0) return svgText;
  let result = svgText;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, edit.start) + edit.openTag + result.slice(edit.start + edit.length);
  }
  return result;
}

/** 2×3 아핀 행렬의 역행렬. 특이 행렬이면 던진다. */
export function invertMatrix(matrix) {
  const [a, b, c, d, e, f] = matrix;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error(`역행렬이 없는 transform입니다: matrix(${matrix.join(",")})`);
  }
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

/** M = TR·S(균일 스케일 s)로 분해한다. 균일 스케일이 아니면 던진다. */
export function decomposeUniformScale(matrix, describe) {
  const [a, b, c, d, e, f] = matrix;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const det = a * d - b * c;
  const tolerance = 1e-9 * Math.max(sx, sy, 1);
  if (
    !(sx > 0) ||
    !(sy > 0) ||
    det <= 0 ||
    Math.abs(sx - sy) > tolerance ||
    Math.abs(a * c + b * d) > tolerance * Math.max(sx, sy)
  ) {
    throw new Error(
      `${describe}: 균일 스케일이 아닌 transform(matrix(${matrix
        .map((v) => Number(v.toFixed(6)))
        .join(",")}))이라 텍스트 크기를 SVG와 동치로 펼칠 수 없습니다 ` +
        "— 조용히 어긋난 렌더를 내지 않고 실패합니다.",
    );
  }
  return { scale: sx, translateRotate: [a / sx, b / sx, c / sx, d / sx, e, f] };
}

/**
 * 닮음 행렬을 `translate(...) rotate(...) scale(...)` 원시 함수열로 직렬화한다.
 *
 * `matrix(...)`로 쓰지 않는 이유는 컴파일러 내부 상태 때문이다:
 * `AffineMatrix`는 z축 성분 `_m4_10`을 따로 추적하는데 `_parseSvgMatrix`는 이를
 * **1.0으로 고정**하고 `_parseSvgScale`은 x 배율만큼 키운다(svg/parsers.dart).
 * `encodableInRect`가 `_m4_10 == a`를 요구하므로, matrix()로 쓰면 축정렬 텍스트도
 * 흡수 대상에서 빠져 텍스트마다 4×4 행렬(128B)이 .vec에 실린다. 원시 함수열로
 * 쓰면 스케일 추적이 일관돼 축정렬 텍스트는 좌표로 흡수되고 회전 텍스트만
 * 행렬을 싣는다 — 렌더 결과는 어느 쪽이든 같고(둘 다 동치) 산출만 작아진다.
 * 10자리 고정 소수라 결정적이다.
 */
function serializeSimilarity(matrix, describe) {
  const { scale } = decomposeUniformScale(matrix, describe);
  const round = (value) => Number(value.toFixed(10));
  const degrees = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI;
  const parts = [];
  if (round(matrix[4]) !== 0 || round(matrix[5]) !== 0) {
    parts.push(`translate(${round(matrix[4])},${round(matrix[5])})`);
  }
  if (round(degrees) !== 0) parts.push(`rotate(${round(degrees)})`);
  if (round(scale) !== 1) parts.push(`scale(${round(scale)})`);
  return parts.length ? parts.join(" ") : "translate(0,0)";
}

const TEXT_SCALED_LENGTH_PROPERTIES = ["font-size", "stroke-width"];
const TEXT_SCALED_COORDINATES = ["x", "y", "dx", "dy"];

/**
 * 각 `<text>`의 조상+자신 transform에서 **균일 스케일 성분을 좌표·font-size·
 * stroke-width로 흡수**하고, 남는 평행이동·회전만 요소 transform으로 남긴다.
 * 스케일이 1인 텍스트는 마크업을 그대로 둔다(산출 바이트 불변).
 */
/** 여는 태그가 그 property를 직접 선언하는가(속성형·인라인 style형). */
function declaresLength(openTag, property) {
  if (new RegExp(`\\s${property}="`).test(openTag)) return true;
  return new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(firstAttr(openTag, "style") ?? "");
}

/**
 * `<text>`가 스스로 선언하지 않은 font-size·stroke-width를 조상에서 해석해
 * **s배한 값으로 요소에 명시**한다. 해석할 수 없으면 던진다.
 *
 * stroke-width는 stroke가 실제로 보일 때만 의미가 있다(보이지 않으면 그리지
 * 않으므로 명시할 값도 없다). 그때 아무도 선언하지 않았다면 SVG 초기값 1을 쓴다.
 */
function withInheritedLengthMaterialized(node, openTag, describe, scale) {
  let result = openTag;
  if (!declaresLength(result, "font-size")) {
    const inherited = inheritedFontSizeOf(node.parent);
    if (inherited == null) {
      throw new Error(
        `${describe}: font-size 선언을 요소에서도 조상에서도 찾지 못해 스케일 ` +
          "흡수 후 렌더 크기를 확정할 수 없습니다 — 조용히 어긋난 크기를 내지 않고 실패합니다.",
      );
    }
    result = withProperty(result, "font-size", String(roundCoord(inherited * scale)));
  }
  if (!declaresLength(result, "stroke-width")) {
    const stroke = inheritedStyleOrAttr(node, "stroke");
    if (stroke != null && isVisiblePaint(stroke)) {
      const width = inheritedStyleOrAttr(node, "stroke-width") ?? "1";
      const value = Number(String(width).replace(/px$/, ""));
      if (!Number.isFinite(value)) {
        throw new Error(`${describe}: stroke-width "${width}"를 해석하지 못했습니다.`);
      }
      result = withProperty(result, "stroke-width", String(roundCoord(value * scale)));
    }
  }
  return result;
}

export function flattenTextScale(svgText) {
  const root = buildSvgTree(svgText);
  const edits = [];
  (function walk(node) {
    for (const child of node.children) {
      if (child.name !== "text") {
        walk(child);
        continue;
      }
      const ancestor = ancestorMatrixOf(child);
      const own = parseTransformChain(firstAttr(child.openTag, "transform"));
      const matrix = composeMatrix(ancestor, own);
      const describe = `<text>(${firstAttr(child.openTag, "id") ?? "id 없음"})`;
      const { scale, translateRotate } = decomposeUniformScale(matrix, describe);
      if (Math.abs(scale - 1) < 1e-12) continue;
      const residual = composeMatrix(invertMatrix(ancestor), translateRotate);
      let openTag = child.openTag;
      for (const property of TEXT_SCALED_LENGTH_PROPERTIES) {
        openTag = scaleLengthDeclaration(openTag, property, scale);
      }
      for (const name of TEXT_SCALED_COORDINATES) {
        openTag = scaleCoordinateDeclaration(openTag, name, scale);
      }
      // 유효 행렬에서 스케일을 없애는 이상, **상속된** font-size·stroke-width도
      // 함께 s배해 요소에 명시해야 크기가 맞는다. 선언을 못 찾으면 조용히 넘기지
      // 않고 던진다(#2593 리뷰 실증: `<g transform="scale(0.5)" font-size="12">`
      // 아래 텍스트가 2배로 렌더되는데 경고조차 없었다).
      openTag = withInheritedLengthMaterialized(child, openTag, describe, scale);
      const residualTransform = serializeSimilarity(residual, `${describe}의 잔여 transform`);
      openTag = /\stransform="[^"]*"/.test(openTag)
        ? openTag.replace(/\stransform="[^"]*"/, ` transform="${residualTransform}"`)
        : `${openTag.replace(/\s*(\/?)>$/, "")} transform="${residualTransform}"${
            /\/\s*>$/.test(openTag) ? " />" : ">"
          }`;
      edits.push({ start: child.start, length: child.openTag.length, openTag });
      (function walkTspans(parent) {
        for (const tspan of parent.children) {
          if (tspan.name !== "tspan") continue;
          if (firstAttr(tspan.openTag, "transform") != null) {
            throw new Error(
              `${describe}: <tspan>에 transform이 있습니다 — SVG는 tspan transform을 ` +
                "정의하지 않으며 동치 전개도 불가능해 실패합니다.",
            );
          }
          let tag = tspan.openTag;
          for (const property of TEXT_SCALED_LENGTH_PROPERTIES) {
            tag = scaleLengthDeclaration(tag, property, scale);
          }
          for (const name of TEXT_SCALED_COORDINATES) {
            tag = scaleCoordinateDeclaration(tag, name, scale);
          }
          if (tag !== tspan.openTag) {
            edits.push({ start: tspan.start, length: tspan.openTag.length, openTag: tag });
          }
          walkTspans(tspan);
        }
      })(child);
    }
  })(root);
  return applyOpenTagEdits(svgText, edits);
}

// ── 텍스트 위치 선언 완결화(#2068 대전 라벨 이중 이동, 2026-07-26) ───────────
//
// vector_graphics_compiler 1.2.6의 `TextPositionNode.computeTextPosition`
// (src/svg/node.dart)은 그 노드가 **x·y(또는 dx·dy)를 둘 다** 선언했을 때만
// 조상 transform을 좌표에 흡수한다(consumeTransform). 흡수하지 못하면 그
// transform을 .vec 텍스트 위치 명령에 그대로 싣고, vector_graphics 1.2.2 런타임
// (src/listener.dart의 `_flushPendingTextChunk`)이 그리기 직전
// `canvas.transform(...)`으로 한 번 더 적용한다.
//
// 오너 역명 라벨 마크업은 `<text x y …><tspan x dy="0">역명</tspan></text>`
// 형식이라 부모 `<text>`는 x·y를 둘 다 가져 흡수하는데, 자식 `<tspan>`은 x만
// 있고 y가 없어 흡수하지 못한다 — **같은 transform이 부모에서 한 번(좌표),
// 자식에서 또 한 번(캔버스) 적용**돼 이중 이동이 된다. 실측(2026-07-26,
// .vec 디코드 + 런타임 청크 로직 재현):
//   daejeon 22건 — map-content-positioned-layer의 translate(0 88)가 두 번.
//     월드컵경기장 baseline y 695.727(기대) → 783.727(실측, +88).
//   busan  63건 — 라벨 자신의 transform="translate(dx dy)"가 두 번.
//     김해대학 y 2395.725(기대) → 3364.091(실측, +968.366).
//   gwangju·daegu — 라벨 조상 transform이 항등이라 흡수 판정이 갈리지 않는다(정합).
//   seoul — 래퍼 행렬에 미세 회전 성분이 남아 부모도 흡수하지 못한다(둘 다
//     미흡수 → transform 1회 적용, 정합). 게다가 tspan이 이미 x·y를 둘 다 갖는다.
//
// 교정은 컴파일 입력에서 **부분 선언 `<tspan>`을 완전한 절대 x·y 쌍으로 채우는
// 것**이다. 부모와 자식이 같은 흡수 판정을 받으므로 이중 적용이 구조적으로
// 불가능해진다 — 컴파일러가 흡수하면 양쪽 다 좌표에 반영되고, 흡수하지 않으면
// 양쪽 다 transform으로 남아 런타임이 정확히 한 번 적용한다. 즉 컴파일러 내부
// 판정(encodableInRect 등)에 의존하지 않는다. 조상 transform이 항등인 텍스트는
// 애초에 갈릴 판정이 없어 건드리지 않는다(gwangju·daegu 산출 바이트 불변).
// 오너 SVG 원본은 불변이며 이 정규화는 컴파일 입력 사본에만 적용된다.

function isIdentityMatrix(matrix) {
  return matrix.every(
    (value, index) => Math.abs(value - IDENTITY_MATRIX[index]) < 1e-12,
  );
}

// 여는 태그의 x/y/dx/dy를 지우고 절대 x·y만 남긴다(자기폐쇄 형태 보존).
function withAbsoluteTextPosition(openTag, x, y) {
  const name = openTag.match(/^<([A-Za-z][\w:.-]*)/)?.[1];
  if (!name) {
    throw new Error(`텍스트 위치 태그를 해석하지 못했습니다: ${openTag}`);
  }
  const selfClosing = /\/\s*>$/.test(openTag);
  const attributes = openTag
    .slice(1 + name.length)
    .replace(/\s*\/?>$/, "")
    .replace(/\s+(?:dx|dy|x|y)="[^"]*"/g, "");
  return `<${name}${attributes} x="${x}" y="${y}"${selfClosing ? " /" : ""}>`;
}

// [textNode] 한 그루의 `<tspan>` 위치 선언을 완결화하는 편집 목록을 모은다.
function collectTextPositionEdits(textNode, edits) {
  const matrix = composeMatrix(
    ancestorMatrixOf(textNode),
    parseTransformChain(firstAttr(textNode.openTag, "transform")),
  );
  // 조상·자신 transform이 항등이면 흡수 판정이 갈릴 여지가 없다(산출 불변).
  if (isIdentityMatrix(matrix)) return;
  // 부모 `<text>`가 x·y를 둘 다 선언하지 않으면 부모도 흡수하지 않는다 — 자식과
  // 판정이 갈리지 않으므로 그대로 둔다(수도권 "뚝섬형" transform 배치 라벨).
  const textX = firstCoordinateToken(firstAttr(textNode.openTag, "x"));
  const textY = firstCoordinateToken(firstAttr(textNode.openTag, "y"));
  if (textX == null || textY == null) return;
  let penY = Number(textY);
  if (!Number.isFinite(Number(textX)) || !Number.isFinite(penY)) return;

  (function walk(node) {
    for (const child of node.children) {
      if (child.name !== "tspan") {
        walk(child);
        continue;
      }
      // 자기폐쇄 `<tspan/>`은 컴파일러가 위치 노드를 만들지 않는다(parser.dart의
      // textOrTspan이 isSelfClosing에서 즉시 반환) — 펜도 움직이지 않는다.
      if (child.openTag.endsWith("/>")) continue;
      const rawX = firstCoordinateToken(firstAttr(child.openTag, "x"));
      const rawY = firstCoordinateToken(firstAttr(child.openTag, "y"));
      const rawDx = firstCoordinateToken(firstAttr(child.openTag, "dx"));
      const rawDy = firstCoordinateToken(firstAttr(child.openTag, "dy"));
      if (rawX == null) {
        // x를 스스로 선언하지 않는 tspan의 절대 x는 **직전 글리프들의 진행폭**에
        // 달려 있어 폰트 메트릭 없이는 계산할 수 없다. 조용히 넘기면 그 라벨만
        // transform이 이중 적용된 채 배포되므로 실패시킨다(현행 5권역 소스에는
        // 이 형태가 0건 — 오너 SVG에 새로 생기면 사람이 판정해야 한다).
        throw new Error(
          `x를 선언하지 않은 <tspan>이 transform이 걸린 <text>(${firstAttr(textNode.openTag, "id") ?? "id 없음"}) 안에 있습니다 ` +
            "— 절대 x를 계산할 수 없어 텍스트 위치 완결화가 불가능합니다. " +
            "오너 SVG에서 해당 tspan에 x를 명시하거나 이 정규화를 확장하세요.",
        );
      }
      const x = Number(rawX) + (rawDx == null ? 0 : Number(rawDx));
      const y =
        (rawY == null ? penY : Number(rawY)) +
        (rawDy == null ? 0 : Number(rawDy));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        walk(child);
        continue;
      }
      penY = y;
      // 이미 완전 선언(x·y만 있고 상대 이동 없음)이면 손대지 않는다 — 수도권처럼
      // 정합인 권역의 산출 바이트를 흔들지 않기 위함이다.
      const alreadyComplete = rawY != null && rawDx == null && rawDy == null;
      if (!alreadyComplete) {
        edits.push({
          start: child.start,
          length: child.openTag.length,
          openTag: withAbsoluteTextPosition(
            child.openTag,
            rawDx == null ? rawX : roundCoord(x),
            rawY != null && rawDy == null ? rawY : roundCoord(y),
          ),
        });
      }
      walk(child);
    }
  })(textNode);
}

/**
 * 컴파일 입력의 `<tspan>` 위치 선언을 완전한 절대 x·y 쌍으로 정규화한다
 * (위 주석의 이중 transform 적용 방지). 텍스트 내용·순서·그 밖의 속성은 불변.
 */
export function completePartialTextPositions(svgText) {
  const root = buildSvgTree(svgText);
  const edits = [];
  (function walk(node) {
    for (const child of node.children) {
      if (child.name === "text") {
        collectTextPositionEdits(child, edits);
        continue;
      }
      walk(child);
    }
  })(root);
  if (edits.length === 0) return svgText;
  let result = svgText;
  // 뒤에서부터 치환해 앞쪽 인덱스가 어긋나지 않게 한다.
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, edit.start) +
      edit.openTag +
      result.slice(edit.start + edit.length);
  }
  return result;
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

// ── SVG paint-order 지원(#2068 오너 실기기 회귀, 2026-07-26) ────────────────
//
// [원인] vector_graphics_compiler 1.2.6은 `paint-order`를 **읽지 않는다** —
// svg/parser.dart의 presentation attribute 목록에도, style 선언 파서에도 없어
// 조용히 무시된다(에러도 경고도 없다). 런타임 vector_graphics 1.2.2의
// listener.dart `onDrawText`는 fill paragraph를 먼저 큐에 넣고 stroke paragraph를
// 그 뒤에 넣어 `_flushPendingTextChunk`가 순서대로 그린다 — 즉 파이프라인 전체가
// **fill → stroke 고정**이다.
// 오너 SVG의 역명 라벨은 `paint-order:stroke fill` + 흰 halo를 쓴다
// (busan `.station-name` stroke 5.747px @ font-size 48.85px,
//  daegu `.station-name` stroke 5px @ 34px). stroke는 글리프 외곽선 중심으로
// 그려져 안쪽으로 절반이 파고들므로, 순서가 뒤집히면 흰 stroke가 글자 fill을
// 덮어 속이 빈 유령 글자가 된다(대구는 획 대비 stroke 비율이 커 역명이 화면에서
// 사실상 소멸, 부산은 일반역명 파편화 + 환승역명 가늘어짐 — 오너 실기기 실측).
//
// [수정] 오너 SVG 원본은 불변이라는 원칙을 지키면서 컴파일 경로가 SVG 의미론을
// 따르게 만든다. 정규화 단계에서 해당 요소를
//   ① stroke 전용 사본(fill:none) → ② fill 전용 사본(stroke:none)
// 두 형제로 분해해 halo가 글자 **뒤에** 깔리게 한다. 서브트리를 통째로 복제하므로
// 좌표·transform·text-anchor·다줄 tspan·letter-spacing·font가 전부 동일하다.
// `<text>`는 컴파일러가 anchored chunk를 reset하며 시작하므로(codec의 reset 플래그
// → listener의 `_flushPendingTextChunk`) 두 사본은 각각 독립 chunk로 앵커링돼
// text-anchor 계산도 어긋나지 않는다.
//
// [범위] fill과 stroke가 **둘 다 보이는** 요소만 분해한다. 한쪽이 none/미지정이면
// paint-order는 렌더 결과에 영향이 없어(무의미한 draw 하나만 늘어난다) 원본
// 마크업을 그대로 둔다. 그 결과 권역별 영향은 다음과 같다(실측):
//   - 부산 text 147 + path 2, 대구 text 97 — 역명 라벨이 복원된다.
//   - 수도권 path 6(공항 아이콘)만 분해 — **역명 라벨은 분해 대상 0건**이지만
//     아이콘 분해 때문에 seoul.vec 자체는 바뀐다(라벨 불변 ≠ .vec 불변).
//   - 대전·광주 0건 — 산출물이 바이트 단위로 동일하다.
const PAINT_ORDER_DEFAULT_SEQUENCE = ["fill", "stroke", "markers"];
// halo(stroke 전용) 사본의 표식. 오너 요소 전수를 세는 게이트들이 halo 사본을
// 오너 요소로 오인하지 않도록 이 상수를 공유한다(문자열 중복 금지).
//   - 표식 속성이 정본이다: id가 없는 요소도 분해될 수 있어 id 접미사만으로는
//     판별이 불가능하다. 게이트는 이 속성으로 판별한다.
//   - id 접미사는 그와 별개로 **문서 내 id 중복을 피하기 위한** 것이다.
export const PAINT_ORDER_STROKE_COPY_ATTR = "data-paint-order-stroke-copy";
export const PAINT_ORDER_STROKE_COPY_ID_SUFFIX = "-paint-order-stroke";
// SVG presentation attribute로 실제 쓰이는 마커 property. CSS 축약형 `marker`는
// presentation attribute가 아니라서 축약형만 보면 마커를 전부 놓친다.
const MARKER_PROPERTIES = ["marker", "marker-start", "marker-mid", "marker-end"];

// SVG 사양(`paint-order: normal | [ fill || stroke || markers ]`)대로 실제 그리기
// 순서를 해석한다. 명시되지 않은 나머지 레이어는 기본 순서(fill·stroke·markers)로
// 뒤에 붙는다. 사양 밖 토큰·중복 토큰은 fail-closed로 던진다 — 조용히 무시하면
// 이번 회귀와 똑같은 종류의 사고가 다시 난다.
export function resolvePaintOrderSequence(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (value === "" || value === "normal") return [...PAINT_ORDER_DEFAULT_SEQUENCE];
  const specified = [];
  for (const token of value.split(/\s+/)) {
    if (!PAINT_ORDER_DEFAULT_SEQUENCE.includes(token) || specified.includes(token)) {
      throw new Error(
        `지원하지 않는 paint-order 값입니다: "${rawValue}". ` +
          "SVG 사양은 `normal` 또는 fill/stroke/markers의 중복 없는 나열만 허용합니다 " +
          "— 조용히 무시하지 않고 실패합니다.",
      );
    }
    specified.push(token);
  }
  return [
    ...specified,
    ...PAINT_ORDER_DEFAULT_SEQUENCE.filter((layer) => !specified.includes(layer)),
  ];
}

// 여는 태그에 **직접 선언된** property 값(style 선언이 동명 presentation attribute를
// 이긴다 — SVG/CSS 명세). 선언이 없으면 undefined.
function declaredProperty(openTag, property) {
  const style = openTag.match(/\sstyle="([^"]*)"/)?.[1];
  if (style) {
    const declared = style.match(
      new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`),
    )?.[1];
    if (declared != null) return declared.trim();
  }
  return openTag.match(new RegExp(`\\s${property}="([^"]*)"`))?.[1]?.trim();
}

// 상속을 반영한 유효 paint 값. 조상까지 선언이 없으면 SVG 초기값
// (fill=black 가시, stroke=none 비가시)을 쓴다.
function effectivePaintValue(node, property) {
  for (let current = node; current && current.name !== "#root"; current = current.parent) {
    const value = declaredProperty(current.openTag, property);
    if (value != null && value !== "" && value !== "inherit") return value;
  }
  return property === "fill" ? "#000000" : "none";
}

function isVisiblePaint(value) {
  const normalized = value.toLowerCase();
  return normalized !== "none" && normalized !== "transparent";
}

// 서브트리의 모든 여는 태그에서 property 선언(속성형·style형)을 제거한다.
// `fill`/`stroke`만 지우고 `fill-opacity`·`stroke-width` 등 하이픈 파생 속성은
// 건드리지 않는다(정규식이 `="`를 요구하고 style 선언은 `^property\s*:`로 앵커).
function stripPropertyDeclarations(markup, property) {
  return markup.replace(/<[A-Za-z][\w:.-]*\b[^>]*>/g, (tag) =>
    tag
      .replace(new RegExp(`\\s${property}="[^"]*"`, "g"), "")
      .replace(/\sstyle="([^"]*)"/, (_m, styleValue) => {
        const kept = styleValue
          .split(";")
          .map((declaration) => declaration.trim())
          .filter(Boolean)
          .filter(
            (declaration) =>
              !new RegExp(`^${property}\\s*:`).test(declaration),
          );
        return ` style="${kept.join(";")}"`;
      }),
  );
}

// 여는 태그에 property="value"를 덧붙인다(자기폐쇄 여부 유지).
function withProperty(openTag, property, value) {
  const selfClosing = /\/\s*>$/.test(openTag);
  const body = openTag.replace(/\s*\/?>$/, "");
  return `${body} ${property}="${value}"${selfClosing ? " />" : ">"}`;
}

// 요소 서브트리를 한쪽 paint만 남긴 사본으로 만든다.
//   keep="stroke" → fill:none 사본(halo), keep="fill" → stroke:none 사본(글자).
function paintOnlyCopy(subtree, keep) {
  const dropped = keep === "stroke" ? "fill" : "stroke";
  let copy = stripPropertyDeclarations(
    stripPropertyDeclarations(subtree, dropped),
    "paint-order",
  );
  if (keep === "stroke") {
    // id 충돌을 피한다 — 원본 id는 글자(fill) 사본이 그대로 유지해 id 기반
    // 조회(게이트·후속 도구)가 오너 요소를 계속 가리키게 한다.
    copy = copy.replace(
      /(\sid=")([^"]*)(")/g,
      (_m, head, id, tail) => `${head}${id}${PAINT_ORDER_STROKE_COPY_ID_SUFFIX}${tail}`,
    );
  }
  const openTagEnd = copy.indexOf(">") + 1;
  let openTag = withProperty(copy.slice(0, openTagEnd), dropped, "none");
  if (keep === "stroke") {
    // halo 사본의 정본 표식 — id가 없는 요소도 다운스트림 게이트가 정확히
    // 걸러낼 수 있게 한다. 컴파일러가 무시하는 data-* 속성이라 렌더에 영향이 없다.
    openTag = withProperty(openTag, PAINT_ORDER_STROKE_COPY_ATTR, "true");
  }
  return openTag + copy.slice(openTagEnd);
}

/**
 * paint-order가 stroke를 fill보다 먼저 그리도록 지정한 요소를
 * `stroke 전용 사본 → fill 전용 사본` 두 형제로 분해한다.
 * 그 외(기본 순서·한쪽 paint만 가시)는 마크업을 그대로 둔다.
 */
export function decomposePaintOrder(markup) {
  const root = buildSvgTree(markup);
  const targets = [];
  (function walk(node) {
    for (const child of node.children) {
      const declared = declaredProperty(child.openTag, "paint-order");
      if (declared != null) {
        const sequence = resolvePaintOrderSequence(declared);
        const strokeFirst = sequence.indexOf("stroke") < sequence.indexOf("fill");
        const fillVisible = isVisiblePaint(effectivePaintValue(child, "fill"));
        const strokeVisible = isVisiblePaint(effectivePaintValue(child, "stroke"));
        if (strokeFirst && fillVisible && strokeVisible) {
          // 마커를 가진 요소를 분해하면 두 사본이 마커를 중복 렌더한다.
          // 축약형 `marker`뿐 아니라 실제로 쓰이는 marker-start/mid/end까지 본다.
          const marker = MARKER_PROPERTIES.find((property) => {
            const value = declaredProperty(child.openTag, property);
            return value != null && isVisiblePaint(value);
          });
          if (marker) {
            throw new Error(
              `marker(${marker})와 paint-order를 함께 쓰는 요소는 지원하지 ` +
                `않습니다 — 사본이 마커를 중복 렌더합니다: ${child.openTag}`,
            );
          }
          targets.push(child);
        }
      }
      walk(child);
    }
  })(root);
  if (targets.length === 0) return markup;

  for (const target of targets) {
    for (const other of targets) {
      if (other !== target && other.start > target.start && other.end <= target.end) {
        throw new Error(
          "paint-order 분해 대상이 서로 중첩돼 있습니다 — 순서 보장이 불가능해 " +
            `실패합니다: ${target.openTag}`,
        );
      }
    }
  }

  let result = markup;
  // 인덱스가 밀리지 않도록 문서 역순으로 치환한다.
  for (const target of [...targets].sort((a, b) => b.start - a.start)) {
    const subtree = result.slice(target.start, target.end);
    const lineStart = result.lastIndexOf("\n", target.start - 1) + 1;
    const indent = /^[ \t]*/.exec(result.slice(lineStart, target.start))[0];
    result =
      result.slice(0, target.start) +
      paintOnlyCopy(subtree, "stroke") +
      `\n${indent}` +
      paintOnlyCopy(subtree, "fill") +
      result.slice(target.end);
  }
  return result;
}

/**
 * 컴파일 입력에서 **표현 불가 property가 실제로 걸린 텍스트 요소**를 센다.
 * 초기값(예: `font-style:normal`)은 렌더 차이가 없으므로 제외한다.
 */
export function unrepresentableTextDeclarations(normalizedSvg) {
  const INITIAL_VALUES = new Map([
    ["letter-spacing", new Set(["normal", "0", "0px"])],
    ["word-spacing", new Set(["normal", "0", "0px"])],
    ["font-style", new Set(["normal"])],
  ]);
  const counts = new Map();
  for (const tag of normalizedSvg.matchAll(/<(?:text|tspan)\b[^>]*>/g)) {
    for (const property of UNREPRESENTABLE_TEXT_PROPERTIES) {
      const value = declaredStyleOrAttr(tag[0], property);
      if (value == null) continue;
      if (INITIAL_VALUES.get(property)?.has(value.trim())) continue;
      const key = `${property}:${value.trim()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function normalizeSvgForCompile(svgText) {
  // ① `<style>` 캐스케이드를 요소 선언으로 전개(컴파일러가 <style>을 못 읽는다).
  //    이후 모든 단계가 "요소에 선언된 값"만 보면 되도록 가장 먼저 둔다.
  const styled = applyStylesheet(extractMapSvg(svgText));
  // ② 오너가 숨긴 요소 제거(class가 준 display:none도 ①이 펼친 뒤라야 잡힌다).
  const visible = stripHiddenElements(styled);
  // ③ font-weight를 번들 페이스 굵기로 확정(컴파일러가 100배수만 받는다).
  const weighted = resolveFontWeights(visible);
  // ④ per-glyph 좌표 리스트를 단일 값으로 해소(동치가 아니면 fail-closed).
  const coordinated = resolveGlyphCoordinateLists(weighted);
  // ⑤ vector-effect:non-scaling-stroke를 stroke-width로 동치 전개.
  const strokes = expandNonScalingStroke(coordinated);
  // ⑥ dominant-baseline을 명시적 y로 전개(런타임은 alphabetic baseline만 그린다).
  const baselined = expandDominantBaseline(strokes);
  // ⑥ 조상 transform의 균일 스케일을 좌표·font-size·stroke-width로 흡수하고
  //    요소 transform에는 평행이동·회전만 남긴다(컴파일러의 fontSize 미변환
  //    동작 자체를 무력화한다).
  const flattened = flattenTextScale(baselined);
  // ⑦ 텍스트 위치 완결화는 ⑤·⑥이 `<text>` 좌표를 최종값으로 옮긴 **뒤**라야
  //    한다 — 그 값에서 파생한 tspan y가 부모와 같은 기준선을 갖는다. 동시에
  //    paint-order 분해보다는 **앞**이다(분해가 복제하는 마크업이 이미 완결된
  //    위치 선언을 담고 있어야 두 사본이 동일하다).
  const positioned = completePartialTextPositions(flattened);
  // ⑧ paint-order 분해는 마지막 — 앞선 전개를 모두 마친 마크업을 복제해야 두
  //    사본이 paint 선언을 제외하고 완전히 동일해진다.
  return decomposePaintOrder(positioned);
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
      const outputDisplaySvg = path.join(outDir, `${region.id}.svg`);
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
      copyFileSync(inputSvg, outputDisplaySvg);
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
        displaySvg: path.relative(root, outputDisplaySvg).replaceAll(path.sep, "/"),
        sourceSvgSha256: sha256Value(sourceSvg),
        displaySvgSha256: sha256(outputDisplaySvg),
        normalizedSvgSha256: sha256Value(normalizedSvg),
        compiledVectorSha256: digest,
        viewBox,
        ownerLabelCount: ownerLabels.length,
      });
      process.stdout.write(
        `${region.id}.vec  sha256=${digest}  ownerLabels=${ownerLabels.length}\n`,
      );
      // 표현 불가 property는 조용히 사라지지 않고 산출 로그에 드러낸다(#2593 리뷰).
      const unrepresentable = unrepresentableTextDeclarations(normalizedSvg);
      if (unrepresentable.size > 0) {
        process.stdout.write(
          `${region.id}.vec  .vec 형식이 담지 못하는 텍스트 선언: ` +
            `${[...unrepresentable]
              .sort((a, b) => b[1] - a[1])
              .map(([key, count]) => `${key} ×${count}`)
              .join(", ")}\n`,
        );
      }

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
