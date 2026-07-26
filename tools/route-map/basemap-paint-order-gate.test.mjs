// 바탕층 paint-order 계약 게이트(#2068 오너 실기기 회귀 핫픽스, 2026-07-26).
//
// [막는 회귀] 오너 SVG의 역명 라벨은 `paint-order:stroke fill` + 흰 halo를 쓴다.
// vector_graphics_compiler 1.2.6은 paint-order를 **읽지 않고**(파서의 presentation
// attribute 목록·style 파서 어디에도 없다) 런타임 vector_graphics 1.2.2는 fill →
// stroke 순서로 그린다. 그대로 컴파일하면 흰 stroke가 글자 fill을 덮어 속이 빈
// 유령 글자가 된다 — 오너 실기기에서 대구 역명은 사실상 소멸했고 부산 일반역명은
// 파편화됐다. compile-basemap-vec.mjs의 decomposePaintOrder가 컴파일 입력에서
// 해당 요소를 `stroke 전용 사본 → fill 전용 사본` 두 형제로 분해해 halo를 글자
// 뒤에 깐다(오너 SVG 원본은 불변).
//
// [고정하는 것]
//   1) 값 해석이 SVG 사양과 일치하고 사양 밖 값은 fail-closed로 던진다.
//   2) 정규화된 컴파일 입력에 "stroke가 fill보다 먼저인데 분해되지 않은 요소"가
//      한 건도 남지 않는다(전 권역 전수).
//   3) 분해된 쌍이 stroke 전용 → fill 전용 순서이고, paint 선언을 뺀 나머지
//      (좌표·transform·text-anchor·tspan·letter-spacing·font)가 완전히 동일하다.
//   4) 권역별 분해 대상 구성 기준선 — 오너 SVG가 바뀌어 대상이 늘거나 줄면 red.
//      halo가 없는 3권역(수도권 라벨·대전·광주)은 분해가 **텍스트에 대해 no-op**
//      임을 함께 고정한다(라벨 산출물 불변).
//
// 픽셀 축(글자 코어 잉크가 실제로 살아있는지)은 컴파일된 .vec을 앱과 동일한
// 런타임으로 렌더해 확인한다:
// apps/mobile/test/features/network_map/presentation/route_map_basemap_label_paint_order_test.dart

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  decomposePaintOrder,
  normalizeSvgForCompile,
  resolvePaintOrderSequence,
  PAINT_ORDER_STROKE_COPY_ATTR,
  PAINT_ORDER_STROKE_COPY_ID_SUFFIX,
} from "./compile-basemap-vec.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sourcesDir = path.join(
  root,
  "tools/route-map/route-map-defs/svg-sources",
);

const REGIONS = [
  { id: "seoul", svg: "easy-subway-sma-v4.svg" },
  { id: "busan", svg: "easy-subway-busan-v3.svg" },
  { id: "daegu", svg: "easy-subway-daegu-v3.svg" },
  { id: "daejeon", svg: "easy-subway-daejeon-v3.svg" },
  { id: "gwangju", svg: "easy-subway-gwangju-v3.svg" },
];

// 정본 상수는 compile-basemap-vec.mjs가 export한다 — 여기서 리터럴을 다시
// 선언하면 접미사·표식이 바뀔 때 아래 정규식들이 조용히 0건 매칭이 된다.
const STROKE_COPY_ID_SUFFIX = PAINT_ORDER_STROKE_COPY_ID_SUFFIX;
const strokeCopyAttrPattern = new RegExp(
  `\\s${PAINT_ORDER_STROKE_COPY_ATTR}="true"`,
);

/**
 * 사본 대조용 정규화 — halo 표식과 id 접미사를 지워 두 사본을 같은 기준으로 만든다.
 * **표식 속성을 먼저** 지운다: 접미사 문자열이 표식 속성명에도 들어 있어
 * 접미사를 먼저 지우면 속성명이 망가져 표식이 남는다.
 */
function canonicalCopy(markup) {
  return markup
    .replace(new RegExp(`\\s${PAINT_ORDER_STROKE_COPY_ATTR}="true"`, "g"), "")
    .replaceAll(STROKE_COPY_ID_SUFFIX, "")
    .replace(/\s(?:fill|stroke)="[^"]*"/g, "");
}

const normalizedByRegion = new Map(
  REGIONS.map((region) => [
    region.id,
    normalizeSvgForCompile(
      readFileSync(path.join(sourcesDir, region.svg), "utf8"),
    ),
  ]),
);

/** 여는 태그에 직접 선언된 property(style 선언이 presentation attribute를 이긴다). */
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

function isVisiblePaint(value) {
  const normalized = String(value ?? "").toLowerCase();
  return normalized !== "" && normalized !== "none" && normalized !== "transparent";
}

/**
 * 마크업에서 halo(stroke 전용) 사본의 **루트 여는 태그**를 모두 찾는다.
 * 반환 원소는 `[openTag, tagName]`이고 `.index`를 갖는다(matchAll 결과 그대로).
 * 표식 속성은 루트에만 붙으므로 하위 tspan 사본은 포함되지 않는다.
 */
function strokeCopyOpenTags(markup) {
  return [
    ...markup.matchAll(
      new RegExp(
        `<([A-Za-z][\\w:.-]*)\\b[^>]*\\s${PAINT_ORDER_STROKE_COPY_ATTR}="true"[^>]*>`,
        "g",
      ),
    ),
  ].map((match) => {
    const entry = [match[0], match[1]];
    entry.index = match.index;
    return entry;
  });
}

test("paint-order 값 해석이 SVG 사양과 일치한다", () => {
  assert.deepEqual(resolvePaintOrderSequence("normal"), [
    "fill",
    "stroke",
    "markers",
  ]);
  assert.deepEqual(resolvePaintOrderSequence(""), ["fill", "stroke", "markers"]);
  // 일부만 명시하면 나머지는 기본 순서로 뒤에 붙는다.
  assert.deepEqual(resolvePaintOrderSequence("stroke"), [
    "stroke",
    "fill",
    "markers",
  ]);
  assert.deepEqual(resolvePaintOrderSequence("stroke fill"), [
    "stroke",
    "fill",
    "markers",
  ]);
  assert.deepEqual(resolvePaintOrderSequence("stroke markers fill"), [
    "stroke",
    "markers",
    "fill",
  ]);
  assert.deepEqual(resolvePaintOrderSequence("markers"), [
    "markers",
    "fill",
    "stroke",
  ]);
  // 사양 밖 값·중복 토큰은 조용히 무시하지 않고 던진다.
  assert.throws(() => resolvePaintOrderSequence("stroke fill stroke"), /지원하지 않는/);
  assert.throws(() => resolvePaintOrderSequence("outline"), /지원하지 않는/);
});

test("stroke 우선 요소를 stroke 사본 → fill 사본으로 분해한다", () => {
  const input =
    '<svg><g><text id="a" x="10" y="20" text-anchor="middle" ' +
    'paint-order="stroke fill" fill="#111111" stroke="#FFFFFF" ' +
    'stroke-width="4" letter-spacing="-1px">' +
    '<tspan id="a-1" x="10" dy="0">역명</tspan></text></g></svg>';
  const output = decomposePaintOrder(input);
  const texts = [...output.matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/g)].map(
    (match) => match[0],
  );
  assert.equal(texts.length, 2, "두 사본으로 분해돼야 합니다.");

  const [strokeCopy, fillCopy] = texts;
  const strokeOpen = strokeCopy.match(/^<text\b[^>]*>/)[0];
  const fillOpen = fillCopy.match(/^<text\b[^>]*>/)[0];
  // 순서: halo(stroke)가 먼저, 글자(fill)가 나중.
  assert.equal(declaredProperty(strokeOpen, "fill"), "none");
  assert.equal(declaredProperty(strokeOpen, "stroke"), "#FFFFFF");
  assert.equal(declaredProperty(fillOpen, "fill"), "#111111");
  assert.equal(declaredProperty(fillOpen, "stroke"), "none");
  // 원본 id는 글자 사본이 유지하고 halo 사본만 접미사를 붙인다.
  assert.match(strokeOpen, new RegExp(`id="a${STROKE_COPY_ID_SUFFIX}"`));
  assert.match(fillOpen, /id="a"/);
  // halo 사본에만 표식 속성이 붙는다(다운스트림 게이트의 정본 판별 기준).
  assert.match(strokeOpen, strokeCopyAttrPattern);
  assert.ok(!strokeCopyAttrPattern.test(fillOpen));
  // paint-order 선언은 구조로 바뀌었으므로 남지 않는다(id 접미사는 별개).
  assert.ok(!/\spaint-order="/.test(output));
  // paint 선언·id·표식을 제외하면 두 사본은 완전히 동일하다.
  assert.equal(canonicalCopy(strokeCopy), canonicalCopy(fillCopy));
});

test("id가 없는 요소도 halo 사본이 표식 속성으로 식별된다", () => {
  // id 접미사만으로 판별하면 이 사본은 오너 요소와 구분되지 않는다.
  const input =
    '<svg><path d="M0,0 L1,1" paint-order="stroke fill" ' +
    'fill="#111111" stroke="#FFFFFF" stroke-width="3" /></svg>';
  const output = decomposePaintOrder(input);
  const paths = [...output.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]);
  assert.equal(paths.length, 2);
  assert.ok(!/\sid="/.test(output), "원본에 id가 없으면 사본에도 없다.");
  assert.match(paths[0], strokeCopyAttrPattern);
  assert.ok(!strokeCopyAttrPattern.test(paths[1]));
});

test("marker를 가진 stroke-우선 요소는 fail-closed로 던진다", () => {
  // 축약형 `marker`뿐 아니라 실제 presentation attribute인
  // marker-start/mid/end도 가드에 걸려야 한다(사본이 마커를 중복 렌더한다).
  for (const property of [
    "marker",
    "marker-start",
    "marker-mid",
    "marker-end",
  ]) {
    const attr =
      '<svg><path d="M0,0 L1,1" paint-order="stroke fill" fill="#111" ' +
      `stroke="#FFF" ${property}="url(#arrow)" /></svg>`;
    assert.throws(
      () => decomposePaintOrder(attr),
      /marker\(.+\)와 paint-order를 함께/,
      `${property} 속성형이 가드를 통과했습니다.`,
    );
    const styled =
      '<svg><path d="M0,0 L1,1" paint-order="stroke fill" fill="#111" ' +
      `stroke="#FFF" style="${property}:url(#arrow)" /></svg>`;
    assert.throws(
      () => decomposePaintOrder(styled),
      /marker\(.+\)와 paint-order를 함께/,
      `${property} style 선언형이 가드를 통과했습니다.`,
    );
  }
  // marker:none은 렌더되지 않으므로 가드 대상이 아니다.
  const none =
    '<svg><path d="M0,0 L1,1" paint-order="stroke fill" fill="#111" ' +
    'stroke="#FFF" marker-end="none" /></svg>';
  assert.equal(
    [...decomposePaintOrder(none).matchAll(/<path\b/g)].length,
    2,
    "marker-end:none은 분해를 막지 않아야 합니다.",
  );
});

test("fill·stroke 중 한쪽만 보이면 분해하지 않는다(불필요한 draw 금지)", () => {
  const strokeless =
    '<svg><text paint-order="stroke" fill="#FFFFFF">배지</text></svg>';
  assert.equal(decomposePaintOrder(strokeless), strokeless);

  const fillless =
    '<svg><text paint-order="stroke fill" fill="none" stroke="#FFF">x</text></svg>';
  assert.equal(decomposePaintOrder(fillless), fillless);

  // 기본 순서(fill 먼저)는 런타임 순서와 이미 같다 — 건드리지 않는다.
  const defaultOrder =
    '<svg><text paint-order="fill stroke" fill="#111" stroke="#FFF">x</text></svg>';
  assert.equal(decomposePaintOrder(defaultOrder), defaultOrder);
});

test("상속된 fill·stroke도 유효 값으로 반영한다", () => {
  // 자신에겐 stroke 선언이 없지만 조상이 준다 → 분해 대상.
  const inherited =
    '<svg><g stroke="#FFFFFF" stroke-width="4">' +
    '<text paint-order="stroke fill" fill="#111111">역</text></g></svg>';
  const output = decomposePaintOrder(inherited);
  assert.equal(
    [...output.matchAll(/<text\b/g)].length,
    2,
    "조상이 준 stroke도 halo로 보고 분해해야 합니다.",
  );
});

test("전 권역 컴파일 입력에 미분해 stroke-우선 요소가 남지 않는다", () => {
  const leftovers = [];
  for (const region of REGIONS) {
    const normalized = normalizedByRegion.get(region.id);
    for (const match of normalized.matchAll(
      /<[A-Za-z][\w:.-]*\b[^>]*>/g,
    )) {
      const openTag = match[0];
      const declared = declaredProperty(openTag, "paint-order");
      if (declared == null) continue;
      const sequence = resolvePaintOrderSequence(declared);
      if (sequence.indexOf("stroke") > sequence.indexOf("fill")) continue;
      // 상속까지 보진 않지만, 자기 선언만으로 둘 다 보이면 확실한 누락이다.
      if (
        isVisiblePaint(declaredProperty(openTag, "fill")) &&
        isVisiblePaint(declaredProperty(openTag, "stroke"))
      ) {
        leftovers.push(`${region.id}: ${openTag.slice(0, 160)}`);
      }
    }
  }
  assert.deepEqual(
    leftovers,
    [],
    "paint-order가 stroke를 먼저 그리라고 지정했는데 분해되지 않은 요소가 " +
      "컴파일 입력에 남아 있습니다 — 흰 halo가 글자를 덮습니다:\n" +
      leftovers.join("\n"),
  );
});

test("분해 쌍은 stroke 사본이 먼저이고 paint 외 모든 속성이 동일하다", () => {
  const mismatches = [];
  for (const region of REGIONS) {
    const normalized = normalizedByRegion.get(region.id);
    // halo 사본은 표식 속성으로 찾는다(id 유무와 무관한 정본 기준). 표식은
    // 분해 대상의 **루트 여는 태그에만** 붙으므로 하위 tspan 사본은 잡히지 않는다.
    for (const match of strokeCopyOpenTags(normalized)) {
      const [strokeOpen, tagName] = match;
      const label = strokeOpen.match(/\sid="([^"]*)"/)?.[1] ?? tagName;
      // 같은 태그의 형제 fill 사본이 바로 뒤에 있어야 한다.
      const fillOpen = normalized
        .slice(normalized.indexOf(`<${tagName}`, match.index + 1))
        .match(new RegExp(`^<${tagName}\\b[^>]*>`))?.[0];
      if (fillOpen == null || strokeCopyAttrPattern.test(fillOpen)) {
        mismatches.push(
          `${region.id}: ${label} — stroke 사본 뒤에 대응하는 fill 사본이 없습니다.`,
        );
        continue;
      }
      if (declaredProperty(strokeOpen, "fill") !== "none") {
        mismatches.push(`${region.id}: ${label} — stroke 사본에 fill:none이 없습니다.`);
      }
      if (declaredProperty(fillOpen, "stroke") !== "none") {
        mismatches.push(`${region.id}: ${label} — fill 사본에 stroke:none이 없습니다.`);
      }
      if (canonicalCopy(strokeOpen) !== canonicalCopy(fillOpen)) {
        mismatches.push(
          `${region.id}: ${label} — 두 사본의 좌표·앵커·폰트 속성이 다릅니다.\n` +
            `  stroke: ${canonicalCopy(strokeOpen)}\n` +
            `  fill:   ${canonicalCopy(fillOpen)}`,
        );
      }
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});

// 실측 기준선(2026-07-26). 오너 SVG의 halo 구성이 바뀌면 red가 되어 사람이
// 이 계약을 다시 보게 한다.
test("권역별 paint-order 분해 대상 구성 기준선", () => {
  const expected = {
    // 수도권 역명 라벨은 CSS가 stroke를 주지 않아 분해 대상이 아니고, 공항 아이콘
    // path 6건만 분해된다.
    seoul: { path: 6 },
    busan: { text: 147, path: 2 },
    daegu: { text: 97 },
    // 대전·광주: `#station-name-labels-layer text { paint-order:stroke; stroke:#FFFFFF; … }`
    // 규칙이 **자손 결합자**라 종전 단순 class 인라이너가 통째로 버렸다 — 그래서
    // 라벨 halo가 조용히 빠져 있었다. 캐스케이드 전개가 사양대로 적용되면서
    // 라벨 전량이 halo/글자 두 사본으로 분해된다(대전 22 · 광주 20).
    daejeon: { text: 22 },
    gwangju: { text: 20 },
  };
  for (const region of REGIONS) {
    const normalized = normalizedByRegion.get(region.id);
    const counts = {};
    for (const [, tagName] of strokeCopyOpenTags(normalized)) {
      counts[tagName] = (counts[tagName] ?? 0) + 1;
    }
    assert.deepEqual(counts, expected[region.id], `${region.id} 분해 대상 구성`);
  }
});

test("halo 없는 권역은 텍스트 분해가 no-op이다(라벨 산출물 불변)", () => {
  for (const regionId of ["seoul"]) {
    const normalized = normalizedByRegion.get(regionId);
    const textCopies = strokeCopyOpenTags(normalized).filter(
      ([, tagName]) => tagName === "text",
    );
    assert.equal(
      textCopies.length,
      0,
      `${regionId}: 역명 라벨이 분해됐습니다 — 이 권역은 halo가 없어 라벨 ` +
        "산출물이 바뀌면 안 됩니다.",
    );
  }
});
