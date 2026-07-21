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
import { DAEJEON, DAEGU, BUSAN } from "./sma-region-configs.mjs";

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
const buildManifestPath = path.join(
  root,
  "tools/route-map/basemap-build-manifest.json",
);

// manifest maps[].id → 원본 SVG 파일명. .vec 파일명은 manifest id를 따른다.
const regions = [
  { id: "seoul", svg: "easy-subway-sma-v2.svg" },
  { id: "busan", svg: "easy-subway-busan-v1.svg" },
  { id: "daegu", svg: "easy-subway-daegu-v1.svg" },
  { id: "daejeon", svg: "easy-subway-daejeon-v1.svg" },
  { id: "gwangju", svg: "easy-subway-gwangju-v1.svg" },
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
//      (자작 SVG의 해당 값은 전부 0 리스트라 첫 토큰 축약이 시각적으로 무해하다.)
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
  const mapTransform = svgText.match(
    /<g\b(?=[^>]*\bid="main-map-scaled-layer")(?=[^>]*\btransform="([^"]+)")[^>]*>/,
  )?.[1];
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
  const layerIds = [
    "transfer-station-shell-underlay-layer",
    "route-lines-layer",
    // #2408 수도권: 오너가 직접 제작한 종점 노선 심볼 연결 연장선. route-lines-layer
    // 직후(오너 SVG 문서 순서)에 이어 노선 형상과 같은 하단 층위로 렌더한다. 숫자
    // id(terminal-route-extension-<line>-<n>)의 octilinear 연장 path만 담고 텍스트가
    // 없다. 다른 권역 SVG엔 이 레이어가 없어 extractGroup이 빈 문자열을 반환하므로
    // 영향이 없다.
    "terminal-route-extensions-layer",
    "route-endpoint-markers-layer",
    "terminal-station-symbols-layer",
    "station-symbols-layer",
    ...(!regionalSingleLine ? ["transfer-station-symbols-layer"] : []),
    // #2408 수도권: 오너가 직접 제작한 종점 노선 심볼(캡슐 배지). 오너 SVG 문서
    // 순서상 최상위(route-midline-markers 다음) 배지 층위라 transfer-station-symbols
    // -layer 뒤 맨 위에 렌더한다 — 종착역 심벌 위로 배지가 덮여 가려지지 않는다.
    // 각 칩 그룹은 matrix(2.198,…) 축정렬 스케일을 가지므로 내부 <text> font-size가
    // normalizeTextBaselineAndScale에서 그 그룹 스케일까지 선보정된다(아래 함수 주석
    // 참조). 수도권만 이 레이어를 가지며(다른 권역은 extractGroup 빈 문자열) 수도권은
    // 기계 이식 배지(line-terminal-badges-layer)를 SVG에서 걷어내고 이 오너 칩으로
    // 대체했다.
    "terminal-route-badges-layer",
    // #2068 종점 호선 마크(원+숫자/캡슐). 대구는 오너 SVG가 아직 이 형식의 종점
    // 배지를 line-terminal-badges-layer에 담아 마감하므로 그대로 컴파일한다. 수도권은
    // #2408에서 이 레이어를 SVG에서 제거하고 위 terminal-route-badges-layer(오너 칩)로
    // 대체했다 — 수도권 SVG엔 이 레이어가 없어 extractGroup이 빈 문자열을 반환한다.
    // 두 레이어는 권역별로 상호배타(한 권역엔 하나만 존재)라 순서 충돌이 없다.
    "line-terminal-badges-layer",
    // #2068 KTX·SRT·공항 표장: service-tag(inline-svg-paths 벡터 로고)를 바탕층에
    // 포함한다. 마크가 라벨·심벌 위에 오도록 맨 위에 렌더한다. 텍스트 없는 벡터
    // path라 폰트 정규화·baseline 경로와 무관하다. 미보유 권역은 빈 문자열.
    "service-tags-layer",
    // #2068 대전·광주 고속철 표장: 재설계된 두 권역 SVG는 service-tag 마크업
    // (class="service-tag"·data-station) 대신 rail-transfer-layer 안 rail chip
    // (data-services·data-station-name·<title> 역명) 형식으로 KTX·SRT 로고를
    // 담는다. 부산·대구형 인식기가 못 잡던 이 표장을 바탕층 최상단에 반입한다.
    // 다른 권역엔 이 레이어가 없어(extractGroup 빈 문자열) 영향이 없다.
    "rail-transfer-layer",
  ];
  const mapGroup = layerIds
    .map((id) => {
      const group = extractGroup(svgText, id);
      if (id === "route-lines-layer") return roundRouteStrokes(group);
      if (gwangju && id === "station-symbols-layer") {
        return keepGwangjuLine1Stations(group);
      }
      return group;
    })
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
  // #2068 오너 v3 KTX·SRT 마크(정정): 오너가 직접 배치한 표장은 우리 관례
  // (service-tags-layer/rail-transfer-layer, main-map-scaled-layer 안 로컬
  // 좌표)를 따르지 않고, main-map-scaled-layer 밖 최상위 형제 요소로 이미
  // 최종 root viewBox 좌표에 배치돼 있다(각 <g>의 matrix(...) e,f가 그 자체로
  // 렌더 좌표). 오너 마크를 옮기지 않고(요청 조건) 렌더 대상에만 포함하려면
  // 그 좌표계를 그대로 보존해야 하므로, 다른 layerIds와 달리 mapTransform(k
  // 스케일) 밖 형제로 이어붙인다 — 안에 넣으면 좌표가 이중 스케일된다.
  // id 패턴은 오너 SVG 실측(도구용 legend/chip 사본과 실제 역 마크를 구분):
  // legend 사본은 "-footer-0-6-9"·"-footer-2-6-2"에서 끝나고(추가 숫자 접미
  // 없음), 실제 역 마크만 그 뒤에 "-<숫자>"가 더 붙는다.
  const ownerRailMarks = [
    ...svgText.matchAll(
      /<g\s+id="logo-ktx-inline-vector-footer-0-6-9-\d+"[^>]*>[\s\S]*?<\/g>/g,
    ),
    ...svgText.matchAll(
      /<g\s+id="logo-srt-inline-vector-footer-2-6-2-\d+"[^>]*>[\s\S]*?<\/g>/g,
    ),
  ]
    .map((m) => m[0])
    .join("\n");
  if (ownerRailMarks) {
    renderedMap = `${renderedMap}\n<g id="owner-rail-service-marks-layer" data-name="오너 KTX·SRT 마크(원본 root 좌표 보존)">\n${ownerRailMarks}\n</g>`;
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
function parseTransformChain(transformValue) {
  let M = IDENTITY_MATRIX;
  if (!transformValue) return M;
  for (const m of transformValue.matchAll(
    /(translate|matrix|scale)\(([^)]*)\)/g,
  )) {
    const args = m[2]
      .trim()
      .split(/[,\s]+/)
      .map(Number);
    let T;
    if (m[1] === "translate") {
      T = [1, 0, 0, 1, args[0], args[1] ?? 0];
    } else if (m[1] === "scale") {
      const sx = args[0];
      const sy = args[1] ?? sx;
      T = [sx, 0, 0, sy, 0, 0];
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
  const mapTransform = svgText.match(
    /<g\b(?=[^>]*\bid="main-map-scaled-layer")(?=[^>]*\btransform="([^"]+)")[^>]*>/,
  )?.[1];
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
  const layerStart = svgText.indexOf('id="service-tags-layer"');
  if (layerStart < 0) return [];
  const groupStart = svgText.lastIndexOf("<g", layerStart);
  let depth = 0;
  let layerEnd = -1;
  const tagRe = /<g\b|<\/g>/g;
  tagRe.lastIndex = groupStart;
  let m;
  while ((m = tagRe.exec(svgText))) {
    depth += m[0] === "</g>" ? -1 : 1;
    if (depth === 0) {
      layerEnd = tagRe.lastIndex;
      break;
    }
  }
  if (layerEnd < 0) return [];
  const layer = svgText.slice(groupStart, layerEnd);

  const obstacles = [];
  // 속성 순서 무관용(#2068 마감): 소스마다 여는 <g> 태그의 속성 나열 순서가
  // 다르다(부산: class→data-station→transform, 대구: class→transform→
  // data-station). 예전 정규식은 data-station이 transform보다 앞에 오는 순서를
  // 고정 가정해 대구 동대구 KTX·SRT 표장을 놓쳤다. 여는 태그 전체를 먼저 잡고
  // class·data-station·transform을 각각 순서 독립으로 추출한다.
  const tagOpenRe = /<g\s+id="service-tag-[^"]*"[^>]*>/g;
  for (const tm of layer.matchAll(tagOpenRe)) {
    const openTag = tm[0];
    if (!/\bclass="service-tag"/.test(openTag)) continue;
    const station = (openTag.match(/\bdata-station="([^"]*)"/) || [])[1] ?? "";
    const rootTransform =
      (openTag.match(/\btransform="([^"]*)"/) || [])[1] ?? "";
    const blockStart = tm.index;
    let d = 0;
    const innerRe = /<g\b|<\/g>/g;
    innerRe.lastIndex = blockStart;
    let im;
    let blockEnd = -1;
    while ((im = innerRe.exec(layer))) {
      d += im[0] === "</g>" ? -1 : 1;
      if (d === 0) {
        blockEnd = innerRe.lastIndex;
        break;
      }
    }
    if (blockEnd < 0) continue;
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
      parseTransformChain(rootTransform),
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
export function extractRailTransferChipObstacles(svgText) {
  const layerStart = svgText.indexOf('id="rail-transfer-layer"');
  if (layerStart < 0) return [];
  const groupStart = svgText.lastIndexOf("<g", layerStart);
  let depth = 0;
  let layerEnd = -1;
  const tagRe = /<g\b|<\/g>/g;
  tagRe.lastIndex = groupStart;
  let m;
  while ((m = tagRe.exec(svgText))) {
    depth += m[0] === "</g>" ? -1 : 1;
    if (depth === 0) {
      layerEnd = tagRe.lastIndex;
      break;
    }
  }
  if (layerEnd < 0) return [];
  const layer = svgText.slice(groupStart, layerEnd);

  const obstacles = [];
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
    let d = 0;
    const innerRe = /<g\b|<\/g>/g;
    innerRe.lastIndex = blockStart;
    let im;
    let blockEnd = -1;
    while ((im = innerRe.exec(layer))) {
      d += im[0] === "</g>" ? -1 : 1;
      if (d === 0) {
        blockEnd = innerRe.lastIndex;
        break;
      }
    }
    if (blockEnd < 0) continue;
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
      parseTransformChain(rootTransform),
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
    let d = 1;
    const innerRe = /<g\b|<\/g>/g;
    innerRe.lastIndex = m.index + openTag.length;
    let im;
    let innerEnd = -1;
    while ((im = innerRe.exec(text))) {
      d += im[0] === "</g>" ? -1 : 1;
      if (d === 0) {
        innerEnd = innerRe.lastIndex;
        break;
      }
    }
    if (innerEnd < 0) {
      cursor = m.index + openTag.length;
      continue;
    }
    const innerBody = text.slice(m.index + openTag.length, innerEnd - "</g>".length);
    collectShapeBoundsRecursive(innerBody, childMatrix, visit);
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

function ownerLabelTextContent(textBlock) {
  return textBlock
    .replace(/^<text\b[^>]*>/, "")
    .replace(/<\/text>$/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
}

// station 키 결정: daejeon 환승 라벨(5역)은 텍스트 내용이 메인+부기 tspan을
// 이어붙인 복합 표기("1호선 대동"+"하늘공원" → "대동하늘공원")라 카탈로그 표기
// ("대동")와 매치되지 않는다(#2068 실기기 확정 — 좌열 왼쪽 폴백 배치로 화면 밖
// 잘림). daejeon <text>에만 있는 data-full-official-name("1호선 대동 | 2호선
// 208 대동(하늘공원)")은 sma-region-configs.mjs DAEJEON.canonicalRules가 이미
// 정확히 같은 정규화(파이프 앞 "1호선 " 접두 제거·괄호 제거·"역" 접미 제거)를
// 파이프라인 노드 매칭에 쓰고 있으므로 그 정본 규칙을 그대로 재사용해 station
// 키를 뽑는다 — 텍스트 flatten보다 우선한다. 다른 권역 SVG는 <text>에
// data-full-official-name이 없으므로(daejeon 전용 마크업) 이 분기는 daejeon
// 외에는 발동하지 않는다(그 외 권역 회귀 0).
//
// daegu/busan(#2068 QA): 오너 라벨 <text> 내용이 카탈로그 name_ko와 어긋나는
// 역이 data-full-official-name 없이 순수 <text> 내용으로만 온다 — daegu 3역
// (부호(경일대·호산대)→부호, 하양(대구가톨릭대)→하양, 서대구→서대구역), busan
// 4역(벡스코(시립미술관)→벡스코, 부산역→부산, 경성대·부경대→경성대.부경대,
// 국제금융센터·부산은행→국제금융센터.부산은행). daejeon처럼 파이프라인 노드
// 매칭에 이미 쓰는 정본 규칙(DAEGU/BUSAN.canonicalRules)을 그대로 flatten
// 텍스트에 적용해 station 키를 카탈로그 표기와 맞춘다 — 매칭 실패로 앱이 폴백
// 미니 크기로 잘못 배치하던 회귀(실기기)를 없앤다. [canonicalize]는 daegu/busan
// 에서만 넘어오므로(extractOwnerLabels가 regionId로 판정) 다른 권역 불변.
function ownerLabelStationKey(textOpenTag, textBlock, canonicalize) {
  const fullOfficialName = firstAttr(textOpenTag, "data-full-official-name");
  if (fullOfficialName) {
    const canonical = DAEJEON.canonicalRules(fullOfficialName)?.name;
    if (canonical) return canonical;
  }
  const textContent = ownerLabelTextContent(textBlock);
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
  const leafTspanRe = /<tspan\b([^>]*)>([^<]*)</g;
  let cursorX = firstAttr(textOpenTag, "x");
  let cursorY = firstAttr(textOpenTag, "y");
  const lines = [];
  for (const match of textBlock.matchAll(leafTspanRe)) {
    const tspanAttrs = match[1];
    const rawText = match[2];
    if (!rawText || !rawText.trim()) continue; // wrapper-only(빈 텍스트) 제외.
    if ((firstAttr(tspanAttrs, "class") ?? "").includes("station-sub")) {
      continue; // 부기 캡션 제외.
    }
    const tspanX = firstAttr(tspanAttrs, "x");
    if (tspanX != null) cursorX = tspanX;
    const tspanY = firstAttr(tspanAttrs, "y");
    const tspanDy = firstAttr(tspanAttrs, "dy");
    if (tspanY != null) {
      cursorY = tspanY;
    } else if (tspanDy != null && cursorY != null) {
      cursorY = String(Number(cursorY) + Number(tspanDy));
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
  const groupTranslate = groupOpenTag
    ? parseTranslate(firstAttr(groupOpenTag, "transform"))
    : { dx: 0, dy: 0 };
  const textTranslate = parseTranslate(firstAttr(textOpenTag, "transform"));
  // 첫 tspan이 스스로 x/y를 선언하면 SVG 텍스트 청크 규칙상 그 지점이 실제
  // 앵커 기준이다(text-anchor는 그 청크 기준으로 계산됨) — 부모 <text>의 x/y
  // 보다 우선한다. 일반 라벨은 tspan이 부모와 같은 x/y를 반복해(무의미) 결과가
  // 같지만, 여러 줄 라벨 4건(#2068 수도권 게이트 조사 실측 — 영등포구청·이수·
  // 부천종합운동장·신검단중앙)은 tspan이 부모보다 작은 x를 가져, 부모 값을
  // 쓰면 앵커가 실제보다 오른쪽으로 밀려 이웃 라벨과 오탐 겹침을 만들었다.
  // tspan에 x/y가 없으면(daegu 등 transform 전용 다음 줄 tspan 관례, 뚝섬형
  // 위치형 포함) 부모 값을 그대로 쓴다.
  const firstTspan = textBlock.match(/<tspan\b[^>]*>/)?.[0] ?? null;
  const x =
    (firstTspan && firstAttr(firstTspan, "x")) ??
    firstAttr(textOpenTag, "x");
  const y =
    (firstTspan && firstAttr(firstTspan, "y")) ??
    firstAttr(textOpenTag, "y");
  const localX = groupTranslate.dx + textTranslate.dx + Number(x ?? NaN);
  const localY = groupTranslate.dy + textTranslate.dy + Number(y ?? NaN);
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
  const anchorRaw =
    firstAttr(textOpenTag, "text-anchor") ?? styleAnchorRaw ?? "start";
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
  // x/y와 같은 변환 파이프라인(groupTranslate+textTranslate 후
  // ×mapScale+mapTranslate)을 줄마다 적용해 최종 좌표계(entry.x/y와 동일 단위)
  // 로 낸다. 단일 줄이면 빈 배열(스키마 항상 존재, 호출부가 length로 분기).
  const lineLocalPositions = extractOwnerLabelLineLocalPositions(
    textOpenTag,
    textBlock,
  );
  const lines =
    lineLocalPositions.length >= 2
      ? lineLocalPositions.map((line) => ({
          text: line.text,
          x: roundCoord(
            mapTranslate.dx +
              (groupTranslate.dx + textTranslate.dx + line.localX) * mapScale,
          ),
          y: roundCoord(
            mapTranslate.dy +
              (groupTranslate.dy + textTranslate.dy + line.localY) * mapScale,
          ),
        }))
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

// 원본 svgText(정규화·레이어 추출 이전)에서 오너 라벨 앵커 목록을 뽑는다.
// 반환은 station 오름차순(로케일 정렬) → role 오름차순으로 정렬해 결정적이다.
export function extractOwnerLabels(svgText, regionId) {
  const mapTransform = svgText.match(
    /<g\b(?=[^>]*\bid="main-map-scaled-layer")(?=[^>]*\btransform="([^"]+)")[^>]*>/,
  )?.[1];
  const mapScale = scaleFromMapTransform(mapTransform);
  const mapTranslate = parseTranslate(mapTransform);
  const cssFontSizeByRole = stationLabelFontSizesByRole(svgText);
  const rolePattern = ownerLabelRoles.join("|");
  // #2068 대구/부산: flatten 텍스트 station 키를 카탈로그 표기로 정규화한다.
  //   daegu(부호/하양/서대구역), busan(벡스코(시립미술관)→벡스코·부산역→부산·
  //   경성대·부경대→경성대.부경대·국제금융센터·부산은행→국제금융센터.부산은행).
  // 파이프라인 노드 매칭이 이미 쓰는 정본 규칙(DAEGU/BUSAN.canonicalRules)을 그대로
  // sidecar 키에 적용해 매칭 실패(폴백 미니) 회귀를 없앤다. daejeon은
  // data-full-official-name 경로라 여기 canonicalize를 타지 않는다.
  const canonicalize =
    regionId === "daegu"
      ? DAEGU.canonicalRules
      : regionId === "busan"
        ? BUSAN.canonicalRules
        : null;

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
function normalizeTextBaselineAndScale(svgText, k) {
  const withStyleFontSizeScaled = svgText.replace(
    /<(?:text|tspan)\b[^>]*>/g,
    (tag) => scaleStyleFontSize(tag, k),
  );
  return withStyleFontSizeScaled.replace(/<text\b[^>]*>/g, (tag) => {
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
        // font-size(attr·style 양쪽)에 그룹 스케일 s를 곱한다. SVG에서 style이
        // presentation attribute보다 우선하므로 어느 쪽이 렌더에 쓰이든 일관되게
        // s배되도록 둘 다 처리한다(기존 normalizeTextBaselineAndScale의 attr·style
        // 병행 스케일 관례와 동일).
        newOpen = newOpen
          .replace(
            /(\sfont-size=")([\d.]+)(px)?(")/,
            (_m, pre, n, px, post) =>
              `${pre}${roundCoord(Number(n) * s)}${px ?? ""}${post}`,
          )
          .replace(
            /(font-size\s*:\s*)([\d.]+)(px)?/,
            (_m, pre, n, px) => `${pre}${roundCoord(Number(n) * s)}${px ?? ""}`,
          );
        return newOpen + newRest;
      });
    },
  );
}

export function normalizeSvgForCompile(svgText) {
  const extracted = extractMapSvg(svgText);
  const k = scaleFromMapTransform(
    extracted.match(
      /<g id="compiled-map-coordinate-layer" transform="([^"]+)"/,
    )?.[1],
  );
  const inlined = foldTerminalChipScale(inlineSimpleClassStyles(extracted))
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
  return normalizeTextBaselineAndScale(inlined, k);
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
        content: {
          svgLayer: "route-lines-and-station-symbols",
          stationSymbols: "owner-svg",
          labels: "owner-svg-anchor-with-solver-fallback",
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
