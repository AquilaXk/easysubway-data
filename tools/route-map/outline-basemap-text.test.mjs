// 바탕층 라벨 윤곽선 굽기(#1488) 계약.
//
// 바탕 `.vec`와 노선 강조 레이어의 컴파일 입력에는 `<text>`가 남지 않고, 라벨은 오너
// 도식 서체(Pretendard 참조 페이스)의 윤곽선으로 그려진다. 서체에 없는 글자, 다른 서체
// 이름, 그리지 못하는 텍스트 선언은 대체 없이 실패한다.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildBasemapLineOverlays,
  buildSvgTree,
  inheritedStyleOrAttr,
  normalizeSvgForCompile,
  TEXT_FONT_METRICS,
} from "./compile-basemap-vec.mjs";
import { OUTLINE_LIMITS, outlineBasemapText } from "./outline-basemap-text.mjs";
import { REGION_CONFIGS } from "./sma-region-configs.mjs";
import { inkBBoxOf } from "./svg-ink-bbox.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "basemap-build-manifest.json"), "utf8"),
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const normalizedByRegion = new Map(
  manifest.maps.map((map) => [
    map.id,
    normalizeSvgForCompile(readFileSync(path.join(root, map.source), "utf8")),
  ]),
);

function svgOf(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${body}</svg>`;
}

function inkOf(body) {
  return inkBBoxOf(outlineBasemapText(svgOf(body)).svg);
}

const LABEL = 'font-family="Pretendard" font-size="20px" font-weight="700"';

test("5권역 바탕과 노선 강조 레이어의 컴파일 입력에 <text>·<tspan>이 남지 않는다", () => {
  for (const [regionId, normalized] of normalizedByRegion) {
    const base = outlineBasemapText(normalized);
    assert.doesNotMatch(base.svg, /<(?:text|tspan)\b/, `${regionId} 바탕`);
    assert.ok(base.glyphCount > 0, `${regionId}: 라벨 글리프가 하나도 그려지지 않았습니다`);
    for (const overlay of buildBasemapLineOverlays(normalized, REGION_CONFIGS[regionId])) {
      assert.doesNotMatch(
        outlineBasemapText(overlay.svg).svg,
        /<(?:text|tspan)\b/,
        `${regionId}/${overlay.lineId}`,
      );
    }
  }
});

// 앱은 흐린 바탕 위에 고른 노선 레이어를 겹친다. 레이어의 요소는 바탕과 같은 마크업·
// 같은 순서여야 글자가 겹쳐 맞는다.
test("노선 강조 레이어의 윤곽선 마크업은 바탕 윤곽선 마크업의 순서 보존 부분열이다", () => {
  const tokensOf = (svg) => svg.match(/<[^>]+>/g);
  for (const [regionId, normalized] of normalizedByRegion) {
    const base = tokensOf(outlineBasemapText(normalized).svg);
    for (const overlay of buildBasemapLineOverlays(normalized, REGION_CONFIGS[regionId])) {
      const layer = tokensOf(outlineBasemapText(overlay.svg).svg);
      let cursor = 0;
      for (const token of layer) {
        while (cursor < base.length && base[cursor] !== token) cursor += 1;
        assert.ok(cursor < base.length, `${regionId}/${overlay.lineId}: 바탕에 없는 마크업 ${token.slice(0, 80)}`);
        cursor += 1;
      }
    }
  }
});

test("build manifest의 컴파일 입력 sha가 다시 구운 윤곽선 입력과 같다", () => {
  for (const map of manifest.maps) {
    const normalized = normalizedByRegion.get(map.id);
    assert.equal(map.compileInputSvgSha256, sha256(outlineBasemapText(normalized).svg), map.id);
    const overlays = buildBasemapLineOverlays(normalized, REGION_CONFIGS[map.id]);
    for (const [index, entry] of map.lineOverlays.entries()) {
      assert.equal(
        entry.compileInputSvgSha256,
        sha256(outlineBasemapText(overlays[index].svg).svg),
        `${map.id}/${entry.lineId}`,
      );
    }
  }
});

// 오너 도식 서체 모델(svg-ink-bbox: Regular advance 합 × 앵커, ascender~descender)과
// 대조한다. 한글 advance는 다섯 페이스 모두 1770/2048em이라 이 모델이 한글 라벨의
// 펜 위치를 정확히 낸다. 잉크는 advance 상자 안에서 좌우 사이드베어링만큼 들어온다.
// 허용 오차는 가로 0.12em이다. 오너 SVG가 쓰는 한글 335자의 다섯 페이스 사이드베어링
// 최대값(왼쪽 0.092em, 오른쪽 0.117em)이다. 세로는 0.01em이다. letter-spacing과 halo
// stroke가 있는 라벨은 모델이 다루지 않아 뺀다.
test("한글 역명 라벨의 윤곽선 잉크가 오너 도식 서체 모델 상자와 맞는다", () => {
  const emPerBoxHeight = TEXT_FONT_METRICS.unitsPerEm /
    (TEXT_FONT_METRICS.ascender - TEXT_FONT_METRICS.descender);
  let compared = 0;
  for (const [regionId, normalized] of normalizedByRegion) {
    const tree = buildSvgTree(normalized);
    (function walk(node, chain) {
      for (const child of node.children) {
        if (child.name !== "text") {
          walk(child, [...chain, child]);
          continue;
        }
        const markup = normalized.slice(child.start, child.end);
        const content = markup.replaceAll(/<[^>]*>/g, "").replaceAll(/[<>]/g, "");
        if (!/^[가-힣\s]*[가-힣][가-힣\s]*$/.test(content)) continue;
        const spacing = inheritedStyleOrAttr(child, "letter-spacing");
        const stroke = inheritedStyleOrAttr(child, "stroke");
        if ((spacing && Number.parseFloat(spacing) !== 0) || (stroke && stroke !== "none")) continue;
        const doc =
          chain.map((ancestor) => ancestor.openTag).join("") +
          markup +
          chain.map((ancestor) => `</${ancestor.name}>`).reverse().join("");
        const model = inkBBoxOf(doc);
        const outlined = inkBBoxOf(outlineBasemapText(doc).svg);
        const em = (model.maxY - model.minY) * emPerBoxHeight;
        const label = `${regionId}:${content.trim()}`;
        assert.ok(Math.abs(outlined.minX - model.minX) <= 0.12 * em, `${label} 왼쪽`);
        assert.ok(Math.abs(outlined.maxX - model.maxX) <= 0.12 * em, `${label} 오른쪽`);
        assert.ok(outlined.minY >= model.minY - 0.01 * em, `${label} 위`);
        assert.ok(outlined.maxY <= model.maxY + 0.01 * em, `${label} 아래`);
        compared += 1;
      }
    })(tree, []);
  }
  assert.ok(compared > 500, `비교한 라벨 ${compared}개`);
});

test("서체에 없는 글자는 대체 글리프로 넘기지 않고 실패한다", () => {
  assert.throws(
    () => outlineBasemapText(svgOf(`<text id="t" x="10" y="50" ${LABEL}>가\u0E01</text>`)),
    /<text>\(t\).*U\+0E01 글리프가 참조 페이스 700에 없습니다/,
  );
});

test("첫 서체가 Pretendard가 아니면 실패한다", () => {
  assert.throws(
    () => outlineBasemapText(svgOf('<text x="1" y="9" font-family="Noto Sans" font-size="9">가</text>')),
    /첫 서체가 오너 도식 서체 Pretendard가 아닙니다/,
  );
  const listed = outlineBasemapText(
    svgOf(`<text x="1" y="9" font-family="Pretendard, &quot;Noto Sans CJK KR&quot;, sans-serif" font-size="9">가</text>`),
  );
  assert.equal(listed.glyphCount, 1);
});

test("윤곽선으로 그리지 못하는 텍스트 선언과 요소는 실패한다", () => {
  for (const [declaration, pattern] of [
    ['font-style="italic"', /font-style="italic"/],
    ['style="word-spacing:3px"', /word-spacing="3px"/],
    ['baseline-shift="4"', /baseline-shift="4"/],
    ['text-decoration="underline"', /text-decoration="underline"/],
    ['rotate="10"', /rotate="10"/],
    ['textLength="80"', /textLength="80"/],
    ['writing-mode="tb"', /writing-mode="tb"/],
    ['text-anchor="left"', /text-anchor="left"/],
  ]) {
    assert.throws(
      () => outlineBasemapText(svgOf(`<text x="1" y="9" ${LABEL} ${declaration}>가</text>`)),
      pattern,
      declaration,
    );
  }
  assert.throws(
    () => outlineBasemapText(svgOf(`<text x="1" y="9" ${LABEL}><textPath href="#p">가</textPath></text>`)),
    /<textPath>는 윤곽선 굽기가 다루지 않는 요소입니다/,
  );
});

test("윤곽선 그룹은 paint·transform·id를 남기고 텍스트 배치 선언을 지운다", () => {
  const { svg } = outlineBasemapText(
    svgOf(
      `<text id="label" x="1" y="9" ${LABEL} fill="#111" stroke="#fff" transform="translate(3,4)" ` +
        `style="letter-spacing:-1px;stroke-width:2;line-height:1" data-station="양재">양재</text>`,
    ),
  );
  const group = svg.match(/<g [^>]*>/)[0];
  assert.match(group, /id="label"/);
  assert.match(group, /fill="#111"/);
  assert.match(group, /transform="translate\(3,4\)"/);
  assert.match(group, /data-station="양재"/);
  assert.match(group, /style="stroke-width:2"/);
  assert.doesNotMatch(group, /font-|letter-spacing|line-height|\sx="|\sy="/);
  assert.match(svg, /<path d="M[^"]+" fill-rule="nonzero"\/>/);
});

// Chrome 실측(2026-10-24): letter-spacing은 글자마다 뒤에 더하고 마지막 글자 뒤에도
// 더해 청크 진행폭에 들어간다. 3글자 × 10px이면 end 앵커 라벨의 왼쪽 잉크가 30, 오른쪽
// 잉크가 10만큼 왼쪽으로 간다.
test("letter-spacing은 글자마다 뒤에 더하고 청크 앵커에 포함한다", () => {
  const plain = inkOf(`<text x="200" y="50" ${LABEL} text-anchor="end">가나다</text>`);
  const spaced = inkOf(`<text x="200" y="50" ${LABEL} text-anchor="end" letter-spacing="10px">가나다</text>`);
  assert.ok(Math.abs(spaced.minX - (plain.minX - 30)) < 1e-3);
  assert.ok(Math.abs(spaced.maxX - (plain.maxX - 10)) < 1e-3);
  const start = inkOf(`<text x="200" y="50" ${LABEL} letter-spacing="10px">가나다</text>`);
  const startPlain = inkOf(`<text x="200" y="50" ${LABEL}>가나다</text>`);
  assert.ok(Math.abs(start.minX - startPlain.minX) < 1e-3);
  assert.ok(Math.abs(start.maxX - (startPlain.maxX + 20)) < 1e-3);
});

// 커닝은 HarfBuzz 셰이핑(GPOS kern)에서 온다. Pretendard Black의 G·T 쌍은 -64/2048em다.
test("셰이핑이 서체 커닝을 적용한다(advance 합으로 배치하지 않는다)", () => {
  const black = 'font-family="Pretendard" font-size="20px" font-weight="900"';
  const advanceOf = (character) =>
    inkOf(`<text x="0" y="50" ${black}>${character}</text>`).maxX -
    inkOf(`<text x="0" y="50" ${black} text-anchor="end">${character}</text>`).maxX;
  const gtx = inkOf(`<text x="0" y="50" ${black}>GTX</text>`).maxX;
  const x = inkOf(`<text x="0" y="50" ${black}>X</text>`).maxX;
  const kerning = gtx - x - advanceOf("G") - advanceOf("T");
  assert.ok(Math.abs(kerning - (-64 * 20) / 2048) < 1e-3, `kerning ${kerning}`);
});

test("굵기마다 해당 참조 페이스의 윤곽선을 쓴다", () => {
  const at = (weight) =>
    outlineBasemapText(
      svgOf(`<text x="0" y="50" font-family="Pretendard" font-size="20px" font-weight="${weight}">가</text>`),
    ).svg.match(/ d="([^"]+)"/)[1];
  const paths = [400, 600, 700, 800, 900].map(at);
  assert.equal(new Set(paths).size, 5);
  assert.throws(
    () => outlineBasemapText(svgOf('<text x="0" y="50" font-family="Pretendard" font-size="20px" font-weight="500">가</text>')),
    /font-weight 500에 맞는 참조 페이스가 없습니다/,
  );
});

test("x·y가 있는 tspan은 새 청크로 앵커를 다시 잡고, 없는 tspan은 청크를 잇는다", () => {
  const whole = inkOf(`<text x="200" y="50" ${LABEL} text-anchor="end">가나</text>`);
  const continued = inkOf(`<text x="200" y="50" ${LABEL} text-anchor="end">가<tspan>나</tspan></text>`);
  assert.deepEqual(continued, whole);
  const single = inkOf(`<text x="200" y="50" ${LABEL} text-anchor="end">가</text>`);
  const split = outlineBasemapText(
    svgOf(`<text x="200" y="50" ${LABEL} text-anchor="end">가<tspan x="200" y="80">나</tspan></text>`),
  ).svg;
  const firstPath = split.match(/<path d="([^"]+)"/)[1];
  assert.equal(firstPath, outlineBasemapText(svgOf(`<text x="200" y="50" ${LABEL} text-anchor="end">가</text>`)).svg.match(/<path d="([^"]+)"/)[1]);
  assert.ok(single.maxX <= 200);
});

// 배포 중인 `.vec` 경로(vector_graphics_compiler parser.dart `_appendText`)와 같은 공백
// 규칙이다. tspan 사이에 공백이 있으면 다음 글자 앞에 공백 하나를 둔다.
test("tspan 사이 공백은 배포 중인 컴파일러 규칙대로 한 칸이 된다", () => {
  const spaced = inkOf(`<text x="0" y="50" ${LABEL}><tspan>가</tspan> <tspan>나</tspan></text>`);
  const literal = inkOf(`<text x="0" y="50" ${LABEL}>가 나</text>`);
  const joined = inkOf(`<text x="0" y="50" ${LABEL}><tspan>가</tspan><tspan>나</tspan></text>`);
  assert.deepEqual(spaced, literal);
  assert.ok(joined.maxX < spaced.maxX);
});

// ── 악의적 입력(상한은 HarfBuzz 14.5.0 hb-limits.hh) ─────────────────────────
test("상한값은 HarfBuzz hb-limits.hh와 같다", () => {
  assert.deepEqual(OUTLINE_LIMITS, {
    maxTextNesting: 64,
    maxRunCodePoints: 65536,
    maxGlyphSegments: 262144,
    maxOutlineBytes: 16 << 20,
  });
});

test("텍스트 노드가 코드포인트 상한을 넘으면 셰이핑 전에 실패한다", () => {
  const text = "가".repeat(OUTLINE_LIMITS.maxRunCodePoints + 1);
  assert.throws(
    () => outlineBasemapText(svgOf(`<text x="0" y="50" ${LABEL}>${text}</text>`)),
    /65537자가 상한 65536자를 넘습니다/,
  );
});

test("tspan 중첩이 상한을 넘으면 실패한다", () => {
  const depth = OUTLINE_LIMITS.maxTextNesting;
  const nested = "<tspan>".repeat(depth) + "가" + "</tspan>".repeat(depth);
  assert.throws(
    () => outlineBasemapText(svgOf(`<text x="0" y="50" ${LABEL}>${nested}</text>`)),
    /중첩이 상한 64단을 넘습니다/,
  );
});

test("문서의 윤곽선 데이터가 상한을 넘으면 실패한다", () => {
  const body = `<text x="0" y="50" ${LABEL}>가나다라</text>`.repeat(50);
  assert.throws(
    () => outlineBasemapText(svgOf(body), { ...OUTLINE_LIMITS, maxOutlineBytes: 10_000 }),
    /문서 상한 10000바이트를 넘습니다/,
  );
  assert.throws(
    () => outlineBasemapText(svgOf(body), { ...OUTLINE_LIMITS, maxGlyphSegments: 3 }),
    /상한 3을 넘습니다/,
  );
});

test("같은 라벨이 반복돼도 글리프 윤곽선은 한 번만 꺼낸다", () => {
  const body = `<text x="0" y="50" ${LABEL}>가나가나</text>`.repeat(2000);
  const { glyphCount, distinctGlyphOutlines } = outlineBasemapText(svgOf(body));
  assert.equal(glyphCount, 8000);
  assert.equal(distinctGlyphOutlines, 2);
});
