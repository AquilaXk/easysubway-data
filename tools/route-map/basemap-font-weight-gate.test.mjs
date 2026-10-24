// 바탕층 폰트 굵기 계약 게이트(#2068 리뷰 m9, 2026-07-26 · 시스템 서체 전환 #1488).
//
// `.vec`는 글리프 아웃라인이 아니라 **텍스트 draw 명령**을 담는다 — 굵기 해석은
// 런타임 Flutter 폰트 매칭이 한다. mobile은 번들 Pretendard를 걷어내고(mobile #504)
// 기기 시스템 서체로 그리므로, 어떤 굵기가 실제로 그려지는지는 기기 서체가 정하고
// data는 그 집합을 알 수 없다. data가 보장하는 것은 두 가지다.
//   1) 컴파일 입력의 모든 굵기는 컴파일러의 **참조 페이스 집합**(오너가 도식을
//      설계한 Pretendard의 페이스)에서 CSS Fonts 4 매칭으로 확정된 값이다.
//      어떤 경로(속성·style·class·키워드)로 선언돼도 이 집합 밖 값이 새면 red다.
//   2) 참조 페이스는 모두 Flutter `FontWeight`가 표현하는 값(100..900의 100배수)이다.
//      vector_graphics_compiler가 그 밖의 값을 던지기 때문이다.
// 참조 서체 파일은 mobile 픽스처가 아니라 data 레포가 소유한다. mobile 픽스처의
// pubspec·서체 번들에 기대면 픽스처를 올릴 때 컴파일러와 이 게이트가 함께 깨진다.
//
// 서체 이름은 정규화하지 않는다(#1488 결정). 컴파일된 `.vec`에는 오너 SVG의
// `font-family`("Pretendard", 대전·광주는 `Pretendard, "Noto Sans CJK KR", sans-serif`
// 문자열 전체)가 그대로 남는다. Flutter는 등록되지 않은 family를 기기 기본 서체로
// 그리므로 이름을 지워도 픽셀이 같다(Android 에뮬레이터·iOS 시뮬레이터에서 mobile과
// 같은 `loadPicture`+`drawPicture` 경로로 실측: 이름 있음/없음 0픽셀 차이). 이름을
// 지우면 바탕 `.vec` 5개와 노선별 강조 레이어 36개의 바이트·manifest sha가 바뀌고
// mobile이 41개 파일과 `line-overlays.json`을 다시 반입해야 하는데, 기기에서 보이는
// 변화가 없다. 같은 사유로 이미 mobile 재반입이 필요한 변경(오너 SVG 개정, 파이프라인
// 개정)이 생기면 그때 컴파일러 정규화로 함께 지운다.
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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  normalizeSvgForCompile,
  PAINT_ORDER_STROKE_COPY_ATTR,
  REFERENCE_TEXT_FONT_WEIGHTS,
  TEXT_FONT_FILE,
  unrepresentableTextDeclarations,
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

// 참조 서체 파일은 폭(svg-ink-bbox)과 dominant-baseline 오프셋의 입력이다. mobile
// 픽스처에서 읽으면 mobile이 서체를 바꿀 때마다 같은 SVG의 컴파일 결과가 달라지거나
// 컴파일러가 로드 중에 죽는다. data가 바이트를 고정해 소유한다.
const REFERENCE_FONT_SHA256 =
  "3ffbacde6ab8411f1d2db54bb9b1f0b3ee2a738932033722cf0388c06aed1c93";

test("참조 서체 파일은 data 레포가 소유한 고정 바이트다(mobile 픽스처 의존 없음)", () => {
  const relative = path.relative(root, TEXT_FONT_FILE).replaceAll(path.sep, "/");
  assert.equal(relative, "tools/route-map/fonts/Pretendard-Regular.otf");
  assert.equal(
    createHash("sha256").update(readFileSync(TEXT_FONT_FILE)).digest("hex"),
    REFERENCE_FONT_SHA256,
  );
  const license = readFileSync(
    path.join(path.dirname(TEXT_FONT_FILE), "OFL.txt"),
    "utf8",
  );
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

// ── 표현 불가 텍스트 선언 계측(#2593 리뷰 Major) ─────────────────────────────
//
// `.vec`의 TextConfig에는 letter-spacing·word-spacing·font-style 필드가 없어
// 이 선언들은 인코딩에서 사라진다 — 즉 오너 SVG와 **글자 간격이 다르게 렌더된다**.
// 재현하려면 글자별 x로 펼쳐야 하는데 폰트 advance·커닝 해석이 필요해 #2571로
// 미뤘다. 그동안 이 계측을 기준선으로 고정해 **조용히 늘어나는 것**을 막는다.
// (오너가 letter-spacing을 더 쓰거나 새 권역이 들어오면 red가 되어 재판단하게 된다.)
test("표현 불가 텍스트 선언(letter-spacing 등) 기준선", () => {
  const expected = {
    seoul: { "letter-spacing:0.32967px": 9, "letter-spacing:0.15px": 1 },
    busan: { "letter-spacing:-1.26px": 270, "letter-spacing:-1.4px": 24 },
    daegu: { "letter-spacing:-0.7px": 184, "letter-spacing:-0.8px": 10 },
    daejeon: { "letter-spacing:-.22px": 44 },
    gwangju: { "letter-spacing:-.22px": 40 },
  };
  for (const region of REGIONS) {
    const normalized = normalizeSvgForCompile(
      readFileSync(path.join(sourcesDir, region.svg), "utf8"),
    );
    const counts = Object.fromEntries(
      [...unrepresentableTextDeclarations(normalized)].sort((a, b) => b[1] - a[1]),
    );
    assert.deepEqual(
      counts,
      expected[region.id],
      `${region.id}: .vec가 담지 못하는 텍스트 선언 구성이 바뀌었습니다 — ` +
        "글자 간격이 오너 SVG와 달라지는 범위가 변했다는 뜻입니다. " +
        "#2571의 글자별 x 전개를 앞당길지 먼저 판단하세요.",
    );
  }
});
