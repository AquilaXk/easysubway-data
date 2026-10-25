// 바탕층 폰트 굵기 계약 게이트(#2068 리뷰 m9, 2026-07-26 · 윤곽선 굽기 #1488).
//
// 바탕층 윤곽선 변형은 라벨을 참조 페이스의 글리프 윤곽선으로 굽는다(outline-basemap-text.mjs).
// 그래서 굵기는 기기 서체가 아니라 data가 소유한 페이스 파일이 정한다. 텍스트 변형(#1495)은
// 같은 컴파일 입력을 텍스트 그리기로 굽고, 런타임이 그 굵기를 기기 서체에서 고른다. 이 게이트가
// 보장하는 것은 다섯 가지다.
//   1) 컴파일 입력의 모든 굵기는 **참조 페이스 집합**(오너가 도식을 설계한 Pretendard
//      Regular·SemiBold·Bold·ExtraBold·Black)에서 CSS Fonts 4 매칭으로 확정된 값이다.
//      어떤 경로(속성·style·class·키워드)로 선언돼도 이 집합 밖 값이 새면 red다.
//   2) 굵기마다 data가 바이트를 고정한 페이스 파일이 있고, 그 파일의 OS/2 굵기가 같다.
//   3) 다섯 페이스의 세로 메트릭이 같아 Regular에서 읽은 dominant-baseline 오프셋이
//      어느 굵기에도 맞는다.
//   4) 배포 텍스트 변형 .vec의 텍스트 굵기도 참조 페이스 집합 안이다.
//   5) .vec 텍스트 형식이 담지 못하는 선언(letter-spacing 등)의 구성이 기준선과 같다.
//      텍스트 변형은 그만큼 글자 간격이 오너 도식과 다르게 그려진다.
//   6) 텍스트 변형 .vec의 모든 텍스트 설정이 서체 이름 Pretendard 하나를 가리킨다. 런타임은
//      font-family 문자열 전체를 서체 이름 하나로 쓰므로(vector_graphics 1.2.3 listener.dart
//      686-698행 → dart:ui TextStyle.fontFamily) CSS 목록을 담으면 서체가 풀리지 않는다.
//
// 이 게이트는 **정규화된 컴파일 입력**(실제로 .vec가 되는 바로 그 마크업)에서
// 렌더에 쓰이는 font-weight를 전부 모은다. 새 굵기가 오너 SVG에 등장해도 매칭이
// 참조 집합 안에서 확정하므로 red가 되지는 않는다 — 그 변화는 아래 권역별 기준선이
// 잡는다.
//
// 대상은 `<style>` 블록의 CSS 선언이 아니라 **실제 요소에 적용된 값**이다:
// inlineSimpleClassStyles가 단순 class 규칙을 속성으로 인라인한 뒤이므로, 요소의
// `font-weight="…"` 속성과 `style="…font-weight:…"` 선언만 세면 된다.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { basemapVariant } from "./basemap-variants.mjs";
import {
  readReferenceFontBytes,
  REFERENCE_TEXT_FACES,
  REFERENCE_TEXT_FONT_WEIGHTS,
  TEXT_PROPERTY_INITIAL_VALUES,
} from "./basemap-svg-core.mjs";
import {
  normalizeSvgForCompile,
  PAINT_ORDER_STROKE_COPY_ATTR,
  readOpenTypeMetrics,
  TEXT_FONT_FILE,
  TEXT_FONT_METRICS,
  unrepresentableTextDeclarations,
  VEC_UNCARRIED_TEXT_PROPERTIES,
} from "./compile-basemap-vec.mjs";
import { decodeVec } from "./vec-codec.mjs";

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

/**
 * 정규화된 컴파일 입력에서 **요소에 실제로 적용된** font-weight → 요소 수.
 * `<style>` 블록 안의 CSS 선언 텍스트는 제외한다(요소에 적용됐다면
 * inlineSimpleClassStyles가 이미 속성으로 인라인했다).
 */
export function appliedFontWeights(normalizedSvg) {
  let withoutStyleBlocks = normalizedSvg;
  for (;;) {
    const next = withoutStyleBlocks.replace(
      /<style\b[^>]*>[\s\S]*?<\/style>/g,
      "",
    );
    if (next === withoutStyleBlocks) break;
    withoutStyleBlocks = next;
  }
  const counts = new Map();
  for (const tag of withoutStyleBlocks.matchAll(/<[A-Za-z][\w:.-]*\b[^>]*>/g)) {
    // #2068 paint-order 분해가 만든 halo 사본은 같은 오너 요소의 stroke 레이어라
    // 굵기 구성에 두 번 세지 않는다(글자 사본이 원본 요소를 그대로 유지한다).
    if (new RegExp(`\\s${PAINT_ORDER_STROKE_COPY_ATTR}="true"`).test(tag[0])) {
      continue;
    }
    const attr = tag[0].match(/\sfont-weight="([^"]*)"/)?.[1];
    const styled = tag[0]
      .match(/\bstyle="([^"]*)"/)?.[1]
      ?.match(/font-weight\s*:\s*([^;"]*)/)?.[1];
    // style 선언이 동명 presentation attribute를 이긴다(SVG/CSS 명세).
    const raw = (styled ?? attr)?.trim();
    if (!raw) continue;
    // 숫자가 아닌 값(bold·bolder 등)은 매칭을 거치지 않고 남은 선언이다. 건수에서
    // 빠지지 않도록 원문 그대로 세어 참조 집합 밖으로 드러낸다.
    const weight = /^\d+$/.test(raw) ? Number(raw) : raw;
    counts.set(weight, (counts.get(weight) ?? 0) + 1);
  }
  return counts;
}

test("오너 SVG가 쓰는 font-weight가 전부 참조 페이스 집합에서 확정된다", () => {
  // 실측 기준선 — 참조 집합이 바뀌면 즉시 red(매칭 결과가 통째로 달라진다).
  assert.deepEqual(
    [...REFERENCE_TEXT_FONT_WEIGHTS].sort((a, b) => a - b),
    [400, 600, 700, 800, 900],
  );
  for (const weight of REFERENCE_TEXT_FONT_WEIGHTS) {
    assert.ok(
      Number.isInteger(weight) && weight >= 100 && weight <= 900 && weight % 100 === 0,
      `참조 굵기 ${weight}는 Flutter FontWeight(100..900의 100배수)로 표현되지 않습니다.`,
    );
  }

  const reference = new Set(REFERENCE_TEXT_FONT_WEIGHTS);
  const outside = [];
  for (const region of REGIONS) {
    const normalized = normalizeSvgForCompile(
      readFileSync(path.join(sourcesDir, region.svg), "utf8"),
    );
    for (const [weight, count] of appliedFontWeights(normalized)) {
      if (!reference.has(weight)) {
        outside.push(`${region.id}: font-weight ${weight} × ${count}건`);
      }
    }
  }
  assert.deepEqual(
    outside,
    [],
    "참조 페이스 집합 밖의 font-weight가 컴파일 입력에 남았습니다 — " +
      "CSS Fonts 4 매칭(resolveFontWeights)을 거치지 않은 선언입니다:\n" +
      outside.join("\n"),
  );
});

// 오너 SVG에 지금 없는 선언 형태(속성형 키워드 등)도 같은 경로를 지난다. 위 게이트는
// 현재 오너 SVG의 내용만 보므로, 선언 형태별로 CSS Fonts 4 기대값(사양에서 손으로
// 유도한 값)을 직접 확인한다.
test("속성·style·class·키워드 선언이 모두 참조 페이스로 확정된다", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<style>.heavy { font-weight:720; }</style>
<text x="1" y="2" font-weight="bold">a</text>
<text x="1" y="2" font-weight="normal">b</text>
<text x="1" y="2" font-weight="650">c</text>
<text x="1" y="2" style="font-weight:100">d</text>
<text x="1" y="2" class="heavy">e</text>
</svg>`;
  const counts = appliedFontWeights(normalizeSvgForCompile(svg));
  assert.deepEqual(
    Object.fromEntries([...counts].sort((a, b) => a[0] - b[0])),
    { 400: 2, 700: 2, 800: 1 },
  );
});

// 참조 서체 파일은 윤곽선·dominant-baseline 오프셋의 입력이다. mobile
// 픽스처에서 읽으면 mobile이 서체를 바꿀 때마다 같은 SVG의 컴파일 결과가 달라진다.
// data가 바이트를 고정해 소유한다.
test("참조 페이스는 굵기마다 data 레포가 소유한 고정 바이트이고 OS/2 굵기가 같다", () => {
  assert.equal(
    path.relative(root, TEXT_FONT_FILE).replaceAll(path.sep, "/"),
    "tools/route-map/fonts/Pretendard-Regular.otf",
  );
  for (const [weight, face] of REFERENCE_TEXT_FACES) {
    const bytes = readReferenceFontBytes(face.file, face.sha256);
    assert.equal(
      path.dirname(path.relative(root, face.file)).replaceAll(path.sep, "/"),
      "tools/route-map/fonts",
    );
    const tables = new Map();
    for (let index = 0; index < bytes.readUInt16BE(4); index += 1) {
      const entry = 12 + index * 16;
      tables.set(bytes.toString("ascii", entry, entry + 4), bytes.readUInt32BE(entry + 8));
    }
    assert.equal(bytes.readUInt16BE(tables.get("OS/2") + 4), weight, `${face.file} usWeightClass`);
    assert.deepEqual(readOpenTypeMetrics(face.file, face.sha256), TEXT_FONT_METRICS, `${weight} 세로 메트릭`);
  }
  const license = readFileSync(path.join(path.dirname(TEXT_FONT_FILE), "OFL.txt"), "utf8");
  assert.match(license, /Copyright \(c\) 2021, Kil Hyung-jin/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

// 실측 기준선(2026-07-26 갱신) — 오너 SVG의 굵기 구성이 바뀌면 red가 되어 위 계약을
// 다시 보게 한다. 이번 라운드 변화 두 가지:
//   - 굵기 확정 규칙이 "가장 가까운 100배수 반올림"에서 **CSS Fonts 4 폰트 매칭**
//     으로 바뀌었다(720→800 등, 준수 렌더러와 같은 페이스 선택).
//   - 전량 반입 계약으로 오너 SVG 전체가 대상이 됐다.
test("권역별 font-weight 구성 기준선", () => {
  const expected = {
    seoul: { 600: 124, 700: 539, 900: 312 },
    busan: { 700: 135, 800: 12, 900: 32 },
    daegu: { 700: 92, 800: 5, 900: 18 },
    daejeon: { 700: 22, 900: 3 },
    gwangju: { 700: 20, 900: 2 },
  };
  for (const region of REGIONS) {
    const normalized = normalizeSvgForCompile(
      readFileSync(path.join(sourcesDir, region.svg), "utf8"),
    );
    const counts = Object.fromEntries(
      [...appliedFontWeights(normalized)].sort((a, b) => a[0] - b[0]),
    );
    assert.deepEqual(counts, expected[region.id], `${region.id} 굵기 구성`);
  }
});

// .vec 텍스트 설정의 굵기는 Flutter FontWeight.values 색인이다(w100 = 0, vector_graphics_compiler
// 1.3.0 vector_graphics_compiler.dart 257행 fontWeight.index).
test("배포 텍스트 변형 .vec의 텍스트 굵기는 모두 참조 페이스 집합 안이다", () => {
  const basemapDir = path.join(root, "apps/mobile/assets/datapacks/metro_map_pack/basemap");
  const reference = new Set(REFERENCE_TEXT_FONT_WEIGHTS);
  for (const region of REGIONS) {
    const { texts } = decodeVec(new Uint8Array(readFileSync(path.join(basemapDir, `${region.id}.text.vec`))));
    const weights = new Set(texts.map(({ fontWeight }) => (fontWeight + 1) * 100));
    assert.ok(weights.size > 0, `${region.id}: 텍스트가 없습니다`);
    assert.deepEqual([...weights].filter((weight) => !reference.has(weight)), [], `${region.id} 텍스트 굵기`);
  }
});

// ── 표현 불가 텍스트 선언 계측(#2593 리뷰 Major, 텍스트 변형 #1495) ─────────────────
//
// `.vec`의 TextConfig에는 letter-spacing·word-spacing·font-style 필드가 없어(vector_graphics_codec
// 1.1.13 vector_graphics_codec.dart 583-627행) 텍스트 변형에서 이 선언들은 인코딩에서 사라진다.
// 윤곽선 변형은 윤곽선 단계가 letter-spacing을 배치에 쓴다. 텍스트 변형이 오너 도식과 글자 간격이
// 다르게 그려지는 범위를 기준선으로 고정해 조용히 늘어나는 것을 막는다. 값은 정규화가 텍스트
// 스케일을 흡수한 뒤의 값이다. 수도권 0.32967px 9건은 scale(2.1978…) 그룹 안 선언이라 #1488부터
// 0.15px로 적힌다.
test("텍스트 변형에서 표현 불가 텍스트 선언(letter-spacing 등) 기준선", () => {
  const expected = {
    seoul: { "letter-spacing:0.15px": 10 },
    busan: { "letter-spacing:-1.26px": 270, "letter-spacing:-1.4px": 24 },
    daegu: { "letter-spacing:-0.7px": 184, "letter-spacing:-0.8px": 10 },
    daejeon: { "letter-spacing:-.22px": 44 },
    gwangju: { "letter-spacing:-.22px": 40 },
  };
  for (const region of REGIONS) {
    const normalized = normalizeSvgForCompile(readFileSync(path.join(sourcesDir, region.svg), "utf8"));
    const counts = Object.fromEntries([...unrepresentableTextDeclarations(normalized)].sort((a, b) => b[1] - a[1]));
    assert.deepEqual(
      counts,
      expected[region.id],
      `${region.id}: 텍스트 변형 .vec가 담지 못하는 텍스트 선언 구성이 바뀌었습니다. ` +
        "글자 간격이 오너 도식과 달라지는 범위가 변했다는 뜻입니다.",
    );
  }
});

// 런타임은 TextConfig.fontFamily를 서체 이름 하나로 쓴다(vector_graphics 1.2.3 listener.dart 686-698행,
// Flutter 3.44 dart:ui text.dart 3613-3618행). `Pretendard, "Noto Sans CJK KR", sans-serif` 같은
// CSS 목록은 없는 서체로 풀려 기기 서체로 대체되고, 윤곽선 변형(첫 서체 Pretendard 글리프)과 다르게 그려진다.
// 윤곽선 단계는 첫 서체가 Pretendard가 아니면 던진다. 텍스트 변형은 그 검사를 거치지 않으므로
// 배포 바이트에서 직접 확인한다.
test("배포 텍스트 변형 .vec의 모든 텍스트 설정 서체는 Pretendard 하나다", () => {
  const basemapDir = path.join(root, "apps/mobile/assets/datapacks/metro_map_pack/basemap");
  const files = readdirSync(basemapDir).filter((name) => name.endsWith(".text.vec")).sort();
  assert.ok(files.length >= REGIONS.length, "텍스트 변형 .vec가 없습니다");
  const families = new Map();
  for (const name of files) {
    const { texts } = decodeVec(new Uint8Array(readFileSync(path.join(basemapDir, name))));
    for (const { fontFamily } of texts) families.set(fontFamily, (families.get(fontFamily) ?? 0) + 1);
  }
  assert.deepEqual([...families.keys()], ["Pretendard"]);
});

/** 정규화된 컴파일 입력의 font-family 선언 값(속성과 style 선언) 전부. */
function fontFamilyDeclarations(markup) {
  return [
    ...[...markup.matchAll(/\sfont-family="([^"]*)"/g)].map((match) => match[1]),
    ...[...markup.matchAll(/font-family\s*:\s*([^;"}]+)/g)].map((match) => match[1].trim()),
  ];
}

test("텍스트 변형 컴파일 입력의 font-family 선언은 서체 이름 하나다", () => {
  const { compileInput } = basemapVariant("text");
  for (const region of REGIONS) {
    const normalized = normalizeSvgForCompile(readFileSync(path.join(sourcesDir, region.svg), "utf8"));
    const declared = fontFamilyDeclarations(compileInput(normalized));
    assert.ok(declared.length > 0, `${region.id}: font-family 선언이 없습니다`);
    const lists = declared.filter((value) => value.includes(","));
    assert.deepEqual(lists, [], `${region.id}: CSS 서체 목록이 남았습니다`);
  }
});

// 초기값은 렌더 차이가 없으므로 세지 않는다. 초기값 표는 윤곽선 단계와 공유하는 하나다
// (TEXT_PROPERTY_INITIAL_VALUES). 표의 초기값은 모두 빠지고 그 밖의 값은 센다.
test("표현 불가 텍스트 선언 계측은 초기값 표의 값만 빼고 센다", () => {
  assert.deepEqual([...VEC_UNCARRIED_TEXT_PROPERTIES].filter((name) => !TEXT_PROPERTY_INITIAL_VALUES.has(name)), []);
  for (const property of VEC_UNCARRIED_TEXT_PROPERTIES) {
    const initials = [...TEXT_PROPERTY_INITIAL_VALUES.get(property)];
    assert.ok(initials.length > 0, `${property}: 초기값이 없습니다`);
    const markup =
      initials.map((value) => `<text ${property}="${value}">a</text>`).join("") +
      `<tspan style="${property}:7px">b</tspan><text ${property}="7px">c</text>`;
    assert.deepEqual([...unrepresentableTextDeclarations(markup)], [[`${property}:7px`, 2]], property);
  }
});
