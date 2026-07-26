// SVG ↔ 바탕층 산출물 전수 대조 게이트(#2068 오너 QA 후속, 2026-07-26).
//
// 오너 판정: "버그 전부 SVG를 그대로 가져다 쓰지 않아서 발생". 이 게이트는
// **오너 SVG의 지도 본문 요소 전수**가 바탕층 산출물(.vec 컴파일 입력·labels.json)
// 에 1:1로 들어갔는지를 기계적으로 확인한다. 조용한 누락(패턴 미매칭·정규식
// 오짝짓기)과 조용한 반입(캔버스 장식 유입)을 양방향으로 막는다.
//
// ── 본문 / 장식 분류 기준(게이트 문서화) ────────────────────────────────────
// 지도 본문(반입 대상): 노선 형상(route-lines·terminal-route-extensions),
//   역 심벌(station-symbols·transfer-station-symbols·terminal-station-symbols),
//   배지(terminal-route-badges·line-terminal-badges·route-midline-markers·
//   route-number-badges), 고속철 표장(service-tags·rail-service-marks·
//   logo-ktx/logo-srt), 역명 라벨(station-name-labels / class=label-layer).
// 캔버스 장식(반입 금지): 카드 배경·테두리, 제목/상태 헤더 바, 범례, 상단 노선
//   설명 박스, 규격 견본 라이브러리, display:none으로 폐기된 레이어.
//   → 앱이 자체 UI로 그리므로 바탕층에 있으면 지도 위 유령 그래픽이 된다.
// 분류의 단일 원본은 compile-basemap-vec.mjs의 MAP_BODY_LAYER_IDS /
// EXCLUDED_DECOR_LAYERS / STRUCTURAL_WRAPPER_LAYER_IDS 세 목록이고, 아래
// "레이어 분류 완전성" 테스트가 세 목록의 합집합이 실제 SVG를 덮는지 확인한다.
//
// ── 독립성 ────────────────────────────────────────────────────────────────
// 라벨·표장 전수는 컴파일러 함수를 재사용하지 않고 **이 파일의 별도 파서**로
// 다시 센다(같은 함수로 양쪽을 만들면 대조가 항등식이 되어 아무것도 못 잡는다).
// 좌표도 조상 transform 전체를 행렬로 합성해 독립 계산한다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyLayerId,
  collectServiceMarks,
  decorLayerBoundsOf,
  normalizeSvgForCompile,
  resolveStationNameLabelLayerId,
  svgLayerCandidateIds,
  DECOR_SERVICE_MARK_SAMPLE_IDS,
  PAINT_ORDER_STROKE_COPY_ATTR,
} from "./compile-basemap-vec.mjs";

const sourcesDir = path.join(import.meta.dirname, "route-map-defs/svg-sources");
const labelsSidecarPath = path.join(
  import.meta.dirname,
  "../../apps/mobile/assets/datapacks/metro_map_pack/basemap/labels.json",
);

const REGIONS = [
  { id: "seoul", svg: "easy-subway-sma-v4.svg" },
  { id: "busan", svg: "easy-subway-busan-v3.svg" },
  { id: "daegu", svg: "easy-subway-daegu-v3.svg" },
  { id: "daejeon", svg: "easy-subway-daejeon-v3.svg" },
  { id: "gwangju", svg: "easy-subway-gwangju-v3.svg" },
];

const svgTextOf = (region) =>
  readFileSync(path.join(sourcesDir, region.svg), "utf8");

// ── 독립 SVG 파서(게이트 전용) ─────────────────────────────────────────────

function buildTree(text) {
  const root = { name: "#root", attrs: "", children: [], parent: null };
  const stack = [root];
  for (const match of text.matchAll(/<(\/?)([A-Za-z][\w:.-]*)\b([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrs, selfClosing] = match;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = {
      name,
      attrs,
      children: [],
      parent: stack[stack.length - 1],
      index: match.index,
      textEnd: match.index + match[0].length,
      raw: match[0],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const attrOf = (attrs, name) =>
  (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

function transformMatrix(value) {
  let M = IDENTITY;
  if (!value) return M;
  for (const m of value.matchAll(/([A-Za-z]+)\s*\(([^)]*)\)/g)) {
    const args = m[2].trim().split(/[,\s]+/).map(Number);
    let T;
    switch (m[1]) {
      case "translate":
        T = [1, 0, 0, 1, args[0], args[1] ?? 0];
        break;
      case "scale":
        T = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
        break;
      case "matrix":
        T = args;
        break;
      case "rotate": {
        const r = (args[0] * Math.PI) / 180;
        const R = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
        T =
          args.length >= 3
            ? multiply(multiply([1, 0, 0, 1, args[1], args[2]], R), [
                1,
                0,
                0,
                1,
                -args[1],
                -args[2],
              ])
            : R;
        break;
      }
      default:
        throw new Error(`게이트 파서가 모르는 transform: ${m[1]}`);
    }
    M = multiply(M, T);
  }
  return M;
}

function chainMatrix(node, { includeSelf }) {
  const chain = [];
  for (let p = includeSelf ? node : node.parent; p && p.name !== "#root"; p = p.parent) {
    chain.unshift(p);
  }
  let M = IDENTITY;
  for (const ancestor of chain) {
    M = multiply(M, transformMatrix(attrOf(ancestor.attrs, "transform")));
  }
  return M;
}

const applyPoint = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

const firstToken = (value) =>
  value == null ? null : (value.trim().split(/[\s,]+/)[0] ?? null);

const LABEL_ROLES = new Set(["ordinary", "transfer", "terminal"]);

/**
 * SVG의 역명 라벨 전수(독립 계산). 반환: { text, x, y, anchor, fontSizePx }.
 * - 위치: 첫 tspan의 x/y가 있으면 그 값(SVG 텍스트 청크 규칙), 없으면 <text>의 x/y.
 *   여기에 <text> 자신을 포함한 **조상 transform 전체**를 행렬로 합성해 절대화한다.
 * - anchor: style 선언 > presentation attribute > "start"(SVG/CSS 우선순위).
 * - 미개통(construction/planned)·role 밖(code 등)은 제외.
 */
function svgStationLabels(text) {
  const root = buildTree(text);
  const labels = [];
  const cssFontSizeByRole = {};
  for (const role of LABEL_ROLES) {
    const rule = text.match(new RegExp(`\\.station-label-${role}\\s*\\{([^}]*)\\}`));
    const size = rule?.[1].match(/font-size:\s*([\d.]+)px/)?.[1];
    if (size) cssFontSizeByRole[role] = Number(size);
  }

  (function walk(node) {
    for (const child of node.children) {
      if (child.name === "text") {
        // #2068 paint-order 분해가 만든 halo 사본은 같은 오너 라벨의 stroke
        // 레이어라 라벨 전수에 두 번 세지 않는다(글자 사본이 원본 요소를 유지).
        // id가 없는 halo 사본도 걸러지도록 표식 속성으로 판별한다.
        if (attrOf(child.attrs, PAINT_ORDER_STROKE_COPY_ATTR) === "true") continue;
        const role =
          attrOf(child.attrs, "data-label-role") ??
          attrOf(child.parent?.attrs ?? "", "data-label-role");
        if (role && LABEL_ROLES.has(role)) {
          const hidden = [child, child.parent].some((n) =>
            /data-(?:status|state)="(?:construction|planned)"/.test(n?.attrs ?? ""),
          );
          if (!hidden) labels.push(makeLabel(text, child, role, cssFontSizeByRole));
        }
        continue;
      }
      walk(child);
    }
  })(root);
  return labels;
}

function makeLabel(text, node, role, cssFontSizeByRole) {
  const firstTspan = node.children.find((c) => c.name === "tspan");
  const localX = Number(
    firstToken(firstTspan && attrOf(firstTspan.attrs, "x")) ??
      firstToken(attrOf(node.attrs, "x")),
  );
  const localY = Number(
    firstToken(firstTspan && attrOf(firstTspan.attrs, "y")) ??
      firstToken(attrOf(node.attrs, "y")),
  );
  const matrix = chainMatrix(node, { includeSelf: true });
  const [x, y] = applyPoint(matrix, localX, localY);
  const style = attrOf(node.attrs, "style") ?? "";
  const anchor =
    style.match(/text-anchor\s*:\s*(start|middle|end)/)?.[1] ??
    attrOf(node.attrs, "text-anchor") ??
    "start";
  const fontSizeAttr = attrOf(node.attrs, "font-size");
  const localFontSize = fontSizeAttr
    ? Number(fontSizeAttr.replace(/px$/, ""))
    : cssFontSizeByRole[role];
  // 균일 축정렬 스케일만 쓰는 소스라 fontSize 배율은 행렬의 a 성분과 같다.
  return {
    role,
    x,
    y,
    anchor,
    fontSizePx: localFontSize * Math.abs(matrix[0]),
    rendered: renderedText(text, node),
  };
}

/** <text> 안의 표시 텍스트(부기 캡션 class="station-sub" 제외). */
function renderedText(text, node) {
  const slice = text.slice(node.index, findElementEnd(text, node.index, "text"));
  return slice
    .replace(/<tspan\b[^>]*class="[^"]*station-sub[^"]*"[^>]*>[\s\S]*?<\/tspan>/g, "")
    .replace(/^<text\b[^>]*>/, "")
    .replace(/<\/text>$/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function findElementEnd(text, startIndex, tagName) {
  const open = text.slice(startIndex).match(/^<[A-Za-z][\w:.-]*\b[^>]*>/)[0];
  if (open.endsWith("/>")) return startIndex + open.length;
  const re = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}>`, "g");
  re.lastIndex = startIndex;
  let depth = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return re.lastIndex;
    } else if (!m[0].endsWith("/>")) depth += 1;
  }
  throw new Error(`${tagName} 닫는 태그를 찾지 못했습니다.`);
}

// ── 게이트 ────────────────────────────────────────────────────────────────

test("레이어 분류 완전성: 5권역 SVG의 모든 레이어가 본문/장식/구조 중 하나로 분류된다", () => {
  for (const region of REGIONS) {
    const text = svgTextOf(region);
    const labelLayerId = resolveStationNameLabelLayerId(text);
    const unclassified = svgLayerCandidateIds(text).filter(
      (id) => classifyLayerId(id, labelLayerId) === "unclassified",
    );
    assert.deepEqual(
      unclassified,
      [],
      `${region.id}: 분류되지 않은 레이어 — MAP_BODY_LAYER_IDS / EXCLUDED_DECOR_LAYERS / ` +
        `STRUCTURAL_WRAPPER_LAYER_IDS 중 하나에 사유와 함께 등재해야 한다: ${unclassified.join(", ")}`,
    );
    assert.ok(labelLayerId, `${region.id}: 역명 라벨 레이어를 찾지 못했습니다.`);
  }
});

test("장식 미반입: 컴파일 입력에 헤더·범례·설명·견본 장식이 하나도 없다", () => {
  // 장식 레이어 id + 그 안에서만 나오는 대표 텍스트를 함께 본다(id만 보면
  // 레이어를 풀어헤친 채 내용만 딸려 오는 경우를 놓친다).
  const decorMarkers = [
    /id="header-title-legend-and-status-layer"/,
    /id="header-complete-route-badges-layer"/,
    /id="top-route-line-explanation-layer"/,
    /id="legend-layer"/,
    /id="route-label-badges-layer"/,
    /spec-library/,
    /id="header-background-pill"/,
    /id="page-background"/,
    /id="main-map-card-background"/,
    /id="background-grid-overlay"/,
    /통합 노선도/,
    /간선 색상별/,
  ];
  for (const region of REGIONS) {
    const normalized = normalizeSvgForCompile(svgTextOf(region));
    const rendered = normalized.includes("</defs>")
      ? normalized.slice(normalized.lastIndexOf("</defs>") + 7)
      : normalized;
    for (const marker of decorMarkers) {
      assert.doesNotMatch(
        rendered,
        marker,
        `${region.id}: 장식 요소가 바탕층에 반입됐습니다 — ${marker}`,
      );
    }
  }
});

test("역명 라벨 전수 ↔ labels.json 1:1 (개수·좌표 Δ<ε·anchor)", () => {
  const sidecar = JSON.parse(readFileSync(labelsSidecarPath, "utf8"));
  const EPSILON = 0.01;
  for (const region of REGIONS) {
    const text = svgTextOf(region);
    const svgLabels = svgStationLabels(text);
    const entries = sidecar.regions[region.id];
    assert.ok(entries, `${region.id}: labels.json에 권역이 없습니다.`);

    assert.equal(
      svgLabels.length,
      entries.length,
      `${region.id}: SVG 라벨 ${svgLabels.length}건 ↔ labels.json ${entries.length}건 — 개수 불일치`,
    );

    // 좌표로 1:1 짝짓기(정규화 키에 의존하지 않는 독립 대조).
    const remaining = entries.map((entry, index) => ({ entry, index, used: false }));
    const unmatched = [];
    for (const label of svgLabels) {
      const hit = remaining.find(
        (candidate) =>
          !candidate.used &&
          Math.abs(candidate.entry.x - label.x) < EPSILON &&
          Math.abs(candidate.entry.y - label.y) < EPSILON &&
          candidate.entry.role === label.role,
      );
      if (!hit) {
        unmatched.push(
          `${label.rendered}(role=${label.role}, x=${label.x.toFixed(4)}, y=${label.y.toFixed(4)})`,
        );
        continue;
      }
      hit.used = true;
      assert.equal(
        hit.entry.anchor,
        label.anchor,
        `${region.id}/${label.rendered}: anchor 불일치 — sidecar=${hit.entry.anchor} SVG=${label.anchor}`,
      );
      assert.ok(
        Math.abs(hit.entry.fontSizePx - label.fontSizePx) < 0.05,
        `${region.id}/${label.rendered}: fontSizePx 불일치 — sidecar=${hit.entry.fontSizePx} SVG=${label.fontSizePx}`,
      );
    }
    assert.deepEqual(
      unmatched,
      [],
      `${region.id}: labels.json에서 짝을 못 찾은 SVG 라벨(좌표 차집합) ${unmatched.length}건`,
    );
    assert.deepEqual(
      remaining.filter((candidate) => !candidate.used).map((c) => c.entry.station),
      [],
      `${region.id}: SVG에 대응이 없는 labels.json 엔트리(역방향 차집합)`,
    );
  }
});

test("역명 라벨 전수 ↔ .vec 컴파일 입력 1:1 (라벨 글자가 전부 바탕층에 굽힌다)", () => {
  for (const region of REGIONS) {
    const text = svgTextOf(region);
    const normalized = normalizeSvgForCompile(text);
    const labelLayerId = resolveStationNameLabelLayerId(text);
    assert.match(
      normalized,
      new RegExp(`id="${labelLayerId}"`),
      `${region.id}: 역명 라벨 레이어가 컴파일 입력에 없습니다.`,
    );
    const svgLabels = svgStationLabels(text);
    const normalizedLabels = svgStationLabels(normalized);
    assert.equal(
      normalizedLabels.length,
      svgLabels.length,
      `${region.id}: 컴파일 입력 라벨 ${normalizedLabels.length}건 ↔ SVG ${svgLabels.length}건`,
    );
    const svgTexts = svgLabels.map((label) => label.rendered).sort();
    const bakedTexts = normalizedLabels.map((label) => label.rendered).sort();
    assert.deepEqual(
      bakedTexts,
      svgTexts,
      `${region.id}: 바탕층에 구워진 라벨 텍스트가 SVG와 다릅니다.`,
    );
  }
});

test("KTX·SRT 표장 전수 ↔ 컴파일 입력 1:1 (누락 0 · 중복 0)", () => {
  // 실측 기준선(2026-07-26). 컴파일러 인식기가 바뀌어 표장이 조용히 늘거나
  // 줄면 이 수치가 먼저 깨진다.
  const expectedMarkCounts = {
    seoul: 17,
    busan: 3,
    daegu: 2,
    daejeon: 1,
    gwangju: 1,
  };
  for (const region of REGIONS) {
    const text = svgTextOf(region);
    const marks = collectServiceMarks(text);
    // 실패 메시지에 **무엇이 잡혔는지**를 함께 낸다 — 숫자만 내면 원인 규명 없이
    // 기준선을 낮추는 흐름을 유도한다(#2068 리뷰 M5).
    assert.equal(
      marks.length,
      expectedMarkCounts[region.id],
      `${region.id}: 표장 전수 ${marks.length}건 (기준 ${expectedMarkCounts[region.id]}건).\n` +
        "현재 수집된 표장:\n" +
        marks
          .map(
            (mark) =>
              `  - ${mark.id} [${mark.bounds.minX.toFixed(1)},${mark.bounds.minY.toFixed(1)} .. ` +
              `${mark.bounds.maxX.toFixed(1)},${mark.bounds.maxY.toFixed(1)}]`,
          )
          .join("\n") +
        "\n기준선을 낮추기 전에 어떤 마크가 왜 빠졌는지 먼저 규명하세요.",
    );
    const normalized = normalizeSvgForCompile(text);
    for (const mark of marks) {
      const occurrences = (
        normalized.match(new RegExp(`id="${mark.id}"`, "g")) ?? []
      ).length;
      assert.equal(
        occurrences,
        1,
        `${region.id}: 표장 ${mark.id}가 컴파일 입력에 ${occurrences}회 — 정확히 1회여야 합니다(누락/중복).`,
      );
    }
  }
});

test("표장은 오너 원본 좌표를 그대로 유지한다(bbox 재계산 대조)", () => {
  // 반입 경로(본문 레이어 슬라이스 / 외부 래퍼)에 관계없이 컴파일 입력에서
  // 다시 계산한 절대 bbox가 원본 SVG bbox와 같아야 한다 — 이중 스케일·조상
  // transform 누락이 있으면 여기서 어긋난다.
  for (const region of REGIONS) {
    const text = svgTextOf(region);
    const before = collectServiceMarks(text);
    const after = collectServiceMarks(normalizeSvgForCompile(text));
    const byId = new Map(after.map((mark) => [mark.id, mark]));
    for (const mark of before) {
      const baked = byId.get(mark.id);
      assert.ok(baked, `${region.id}: 표장 ${mark.id}가 컴파일 입력에서 사라졌습니다.`);
      for (const key of ["minX", "minY", "maxX", "maxY"]) {
        assert.ok(
          Math.abs(baked.bounds[key] - mark.bounds[key]) < 0.05,
          `${region.id}/${mark.id}: ${key} 좌표 이동 — 원본 ${mark.bounds[key]} → 반입 ${baked.bounds[key]}`,
        );
      }
    }
  }
});

// #2068 리뷰 M5(2026-07-26) — 장식/본문 표장 판정이 기하 여유에만 기대지 않는다.
//
// 리뷰 실측: seoul 장식 밴드(top-route-line-explanation-background 등)의 하단은
// y=240이고, 지도 본문 최상단 표장의 minY는 388.23 — 여유가 약 148단위(viewBox
// 높이 3020의 4.9%)뿐이다. 오너가 상단 설명 박스를 키우거나 도면 최상단 역에
// 표장을 추가하면 기하 규칙만으로는 본문 표장이 장식으로 오판된다.
//
// 그래서 판정을 (1) 명시 견본 id 목록 (2) 그 밖이 장식 영역에 들어오면 fail-closed
// 두 단계로 나눴다. 아래 세 테스트가 그 계약과 실측 여유를 함께 고정한다.
test("장식 견본은 명시 id 목록으로 제외된다(기하 규칙 단독 의존 금지)", () => {
  assert.deepEqual(
    DECOR_SERVICE_MARK_SAMPLE_IDS.map((sample) => sample.id).sort(),
    ["logo-ktx-inline-vector-footer-0", "logo-srt-inline-vector-footer-2"],
  );
  for (const sample of DECOR_SERVICE_MARK_SAMPLE_IDS) {
    assert.ok(
      typeof sample.reason === "string" && sample.reason.length > 10,
      `${sample.id}: 제외 사유가 비었습니다 — 명시 계약은 사유를 요구합니다.`,
    );
  }
  // 견본이 실제로 수집 결과에서 빠진다.
  const seoul = svgTextOf(REGIONS[0]);
  const ids = new Set(collectServiceMarks(seoul).map((mark) => mark.id));
  for (const sample of DECOR_SERVICE_MARK_SAMPLE_IDS) {
    assert.ok(!ids.has(sample.id), `${sample.id}가 배포 표장에 남아 있습니다.`);
  }
});

test("본문 표장과 장식 영역의 기하 여유를 실측으로 고정한다", () => {
  // 여유가 줄어드는 변화(오너가 상단 박스를 키우는 등)가 오면 red가 되어
  // 사람이 명시 목록/계약을 다시 보게 한다. green이어도 기하 규칙 단독으로는
  // 안전하지 않다는 것이 위 fail-closed 계약의 존재 이유다.
  const seoulText = svgTextOf(REGIONS[0]);
  const decor = decorLayerBoundsOf(seoulText);
  assert.ok(decor.length > 0, "seoul 장식 bbox가 0건입니다.");
  const decorBottom = Math.max(...decor.map((box) => box.maxY));
  const marks = collectServiceMarks(seoulText);
  const topMarkMinY = Math.min(...marks.map((mark) => mark.bounds.minY));
  const margin = topMarkMinY - decorBottom;
  assert.ok(
    Math.abs(decorBottom - 240) < 1,
    `seoul 장식 밴드 하단 실측 ${decorBottom.toFixed(2)} (기준 240)`,
  );
  assert.ok(
    Math.abs(topMarkMinY - 388.2343) < 0.01,
    `seoul 최상단 본문 표장 minY 실측 ${topMarkMinY.toFixed(4)} (기준 388.2343)`,
  );
  assert.ok(
    margin > 100 && margin < 200,
    `장식↔본문 표장 여유 ${margin.toFixed(1)}단위 — 실측 기준선(약 148, viewBox 높이의 4.9%)에서 벗어났습니다.`,
  );
});

test("명시 목록에 없는 표장이 장식 영역에 들어오면 조용히 빠지지 않고 실패한다", () => {
  // 지도 본문 표장 하나를 장식 밴드(y 136~240) 안으로 옮긴 합성 입력.
  // 종전 구현은 이때 그 마크를 조용히 제외했다(바탕층에서 표장 소실).
  const moved = svgTextOf(REGIONS[0]).replace(
    /(<g\s+id="logo-ktx-inline-vector-footer-0-6-9-4"\s+transform="matrix\()[^)]*(\))/,
    "$10.02638383,0,0,0.02297538,1000,180$2",
  );
  assert.notEqual(moved, svgTextOf(REGIONS[0]), "합성 입력이 적용되지 않았습니다.");
  assert.throws(
    () => collectServiceMarks(moved),
    /장식 레이어 영역 안에 있습니다/,
    "장식 영역에 들어온 미등재 표장은 fail-closed여야 합니다.",
  );
});
