// 바탕층 폰트 굵기 계약 게이트(#2068 리뷰 m9, 2026-07-26).
//
// `.vec`는 글리프 아웃라인이 아니라 **텍스트 draw 명령**을 담는다 — 굵기 해석은
// 런타임 Flutter 폰트 매칭이 하고, 번들되지 않은 굵기는 가장 가까운 번들 굵기로
// 대체된다. 따라서 오너 SVG가 쓰는 굵기 중 하나라도 pubspec에 없으면 "화면이
// 오너 SVG와 픽셀 동일"이라는 이 트랙의 계약이 굵기 축에서 조용히 깨진다.
//
// 이 게이트는 **정규화된 컴파일 입력**(실제로 .vec가 되는 바로 그 마크업)에서
// 렌더에 쓰이는 font-weight를 전부 모아, pubspec.yaml의 Pretendard 번들 굵기
// 집합에 포함되는지 확인한다. 새 굵기가 오너 SVG에 등장하면 red가 되고, 사람이
// 해당 굵기를 번들하거나(권장 — 오너 디자인 우선) 오너에게 조정을 요청해야 한다.
//
// 대상은 `<style>` 블록의 CSS 선언이 아니라 **실제 요소에 적용된 값**이다:
// inlineSimpleClassStyles가 단순 class 규칙을 속성으로 인라인한 뒤이므로, 요소의
// `font-weight="…"` 속성과 `style="…font-weight:…"` 선언만 세면 된다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  normalizeSvgForCompile,
  PAINT_ORDER_STROKE_COPY_ATTR,
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

/** pubspec.yaml의 Pretendard family에 번들된 weight 집합. */
function bundledPretendardWeights() {
  const pubspec = readFileSync(
    path.join(root, "apps/mobile/pubspec.yaml"),
    "utf8",
  );
  const family = pubspec.match(
    /-\s*family:\s*Pretendard\s*\n\s*fonts:\n([\s\S]*?)(?=\n\s*-\s*family:|\n[^\s#]|$)/,
  );
  assert.ok(family, "pubspec.yaml에서 Pretendard font family 블록을 찾지 못했습니다.");
  const weights = [...family[1].matchAll(/weight:\s*(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(weights.length > 0, "Pretendard 번들 weight가 0건입니다.");
  return new Set(weights);
}

/**
 * 정규화된 컴파일 입력에서 **요소에 실제로 적용된** font-weight → 요소 수.
 * `<style>` 블록 안의 CSS 선언 텍스트는 제외한다(요소에 적용됐다면
 * inlineSimpleClassStyles가 이미 속성으로 인라인했다).
 */
export function appliedFontWeights(normalizedSvg) {
  const withoutStyleBlocks = normalizedSvg.replace(
    /<style\b[^>]*>[\s\S]*?<\/style>/g,
    "",
  );
  const counts = new Map();
  for (const tag of withoutStyleBlocks.matchAll(/<[A-Za-z][\w:.-]*\b[^>]*>/g)) {
    // #2068 paint-order 분해가 만든 halo 사본은 같은 오너 요소의 stroke 레이어라
    // 굵기 구성에 두 번 세지 않는다(글자 사본이 원본 요소를 그대로 유지한다).
    if (new RegExp(`\\s${PAINT_ORDER_STROKE_COPY_ATTR}="true"`).test(tag[0])) {
      continue;
    }
    const attr = tag[0].match(/\sfont-weight="(\d+)"/)?.[1];
    const styled = tag[0]
      .match(/\bstyle="([^"]*)"/)?.[1]
      ?.match(/font-weight\s*:\s*(\d+)/)?.[1];
    // style 선언이 동명 presentation attribute를 이긴다(SVG/CSS 명세).
    const weight = styled ?? attr;
    if (!weight) continue;
    counts.set(Number(weight), (counts.get(Number(weight)) ?? 0) + 1);
  }
  return counts;
}

test("오너 SVG가 쓰는 font-weight가 전부 번들돼 있다(대체 렌더 금지)", () => {
  const bundled = bundledPretendardWeights();
  // 실측 기준선 — 번들 목록이 줄면 즉시 red.
  assert.deepEqual([...bundled].sort((a, b) => a - b), [400, 600, 700, 800, 900]);

  const missing = [];
  for (const region of REGIONS) {
    const normalized = normalizeSvgForCompile(
      readFileSync(path.join(sourcesDir, region.svg), "utf8"),
    );
    for (const [weight, count] of appliedFontWeights(normalized)) {
      if (!bundled.has(weight)) {
        missing.push(`${region.id}: font-weight ${weight} × ${count}건`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    "번들되지 않은 font-weight가 컴파일 입력에 있습니다 — 그 굵기는 런타임에 " +
      "가장 가까운 번들 굵기로 대체돼 오너 도식과 다르게 렌더됩니다. " +
      "apps/mobile/pubspec.yaml의 Pretendard family에 해당 굵기를 번들하세요:\n" +
      missing.join("\n"),
  );
});

test("번들 굵기 자산이 실제로 존재하고 pubspec 선언과 1:1이다", () => {
  const pubspec = readFileSync(
    path.join(root, "apps/mobile/pubspec.yaml"),
    "utf8",
  );
  const family = pubspec.match(
    /-\s*family:\s*Pretendard\s*\n\s*fonts:\n([\s\S]*?)(?=\n\s*-\s*family:|\n[^\s#]|$)/,
  )[1];
  const entries = [
    ...family.matchAll(/-\s*asset:\s*(\S+)\s*\n\s*weight:\s*(\d+)/g),
  ];
  assert.equal(entries.length, 5);
  for (const [, asset, weight] of entries) {
    const file = path.join(root, "apps/mobile", asset);
    const size = readFileSync(file).byteLength;
    assert.ok(size > 0, `${asset}(weight ${weight}) 자산이 비어 있습니다.`);
  }
});

// 실측 기준선(2026-07-26) — 오너 SVG의 굵기 구성이 바뀌면 red가 되어 위 계약을
// 다시 보게 한다. 800은 이번 라벨 반입으로 새로 들어온 굵기이고, 900은 그 이전부터
// 쓰이던(그러나 700으로 대체 렌더되던) 굵기다.
test("권역별 font-weight 구성 기준선", () => {
  const expected = {
    seoul: { 600: 124, 700: 531, 900: 312 },
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
