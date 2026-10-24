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
  normalizeSvgForCompile,
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

// 그려져야 하는 입력이 던지면 예외가 아니라 단언 실패로 드러나게 한다.
function outlined(svg, limits = OUTLINE_LIMITS) {
  let result;
  assert.doesNotThrow(() => {
    result = outlineBasemapText(svg, limits);
  });
  return result;
}

function glyphsDrawn(svg) {
  return outlined(svg).glyphCount;
}

function inkOf(body) {
  return inkBBoxOf(outlined(svgOf(body)).svg);
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

// 두 변형은 같은 정규화·강조 레이어 분할에서 나온다. 윤곽선 변형만 윤곽선 단계를 거치고, 텍스트
// 변형은 정규화 입력을 그대로 굽는다(#1495).
test("build manifest의 변형별 컴파일 입력 sha가 윤곽선 변형은 다시 구운 윤곽선 입력, 텍스트 변형은 정규화 입력과 같다", () => {
  const compileInputOf = { outlined: (svg) => outlineBasemapText(svg).svg, text: (svg) => svg };
  for (const map of manifest.maps) {
    const normalized = normalizedByRegion.get(map.id);
    const overlays = buildBasemapLineOverlays(normalized, REGION_CONFIGS[map.id]);
    assert.deepEqual(Object.keys(map.variants), Object.keys(compileInputOf));
    for (const [variantId, variant] of Object.entries(map.variants)) {
      const label = `${map.id}/${variantId}`;
      const compileInput = compileInputOf[variantId];
      assert.equal(variant.compileInputSvgSha256, sha256(compileInput(normalized)), label);
      for (const [index, entry] of variant.lineOverlays.entries()) {
        assert.equal(entry.compileInputSvgSha256, sha256(compileInput(overlays[index].svg)), `${label}/${entry.lineId}`);
      }
    }
  }
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

// 표(TEXT_PROPERTY_POLICY)에 없는 텍스트 계열 선언은 이 단계가 어떻게 그릴지 모른다. 조용히
// 통과시키면 글자 모양이 오너 도식과 달라진 채 .vec가 만들어진다.
test("표에 없는 텍스트 계열 선언은 text·tspan·조상 어디에 있어도 조용히 통과하지 않고 실패한다", () => {
  for (const [declaration, property] of [
    ['font="italic 20px Pretendard"', "font"],
    ['text-transform="uppercase"', "text-transform"],
    ["style=\"font-variation-settings:'wght' 700\"", "font-variation-settings"],
    ['text-orientation="upright"', "text-orientation"],
    ['unicode-bidi="bidi-override"', "unicode-bidi"],
    ['font-size-adjust="0.5"', "font-size-adjust"],
    ['style="-webkit-text-stroke:1px"', "-webkit-text-stroke"],
    ['style="hyphens:auto"', "hyphens"],
  ]) {
    const onText = svgOf(`<text x="1" y="9" ${LABEL} ${declaration}>가</text>`);
    const onTspan = svgOf(`<text x="1" y="9" ${LABEL}><tspan ${declaration}>가</tspan></text>`);
    const onAncestor = svgOf(`<g ${declaration}><text x="1" y="9" ${LABEL}>가</text></g>`);
    for (const [where, markup] of [["text", onText], ["tspan", onTspan], ["조상", onAncestor]]) {
      assert.throws(
        () => outlineBasemapText(markup),
        (error) => error.message.includes(`: ${property}은 `) && error.message.includes("알지 못하는 텍스트 property"),
        `${where}: ${declaration}`,
      );
    }
  }
});

test("텍스트 계열이 아닌 선언은 표에 없어도 윤곽선 그룹에 그대로 남는다", () => {
  const { svg } = outlined(
    svgOf(
      `<text id="t" x="1" y="9" ${LABEL} mix-blend-mode="multiply" pointer-events="none" stroke-linecap="round" ` +
        'style="isolation:isolate" aria-label="양재" data-role="ordinary">양재</text>',
    ),
  );
  const group = svg.match(/<g [^>]*>/)[0];
  for (const kept of ["mix-blend-mode=\"multiply\"", "pointer-events=\"none\"", "stroke-linecap=\"round\"", "isolation:isolate", "aria-label=\"양재\""]) {
    assert.ok(group.includes(kept), `${kept}가 남지 않았습니다: ${group}`);
  }
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

// ── 윤곽선 굽기가 그리지 못하는 입력은 대체 없이 실패한다 ─────────────────────
// 브라우저는 letter-spacing이 있으면 선택 합자를 끈다. 그 대체 규칙은 재현하지 않으므로
// 글자와 글리프가 일대일이 아닌 라벨(GTX-A의 calt 하이픈)은 던지고, 대체가 없는 라벨은
// 같은 letter-spacing으로 그려진다.
test("letter-spacing이 있는 라벨에 글리프 대체가 생기면 실패한다", () => {
  const spaced = (label) => svgOf(`<text id="t" x="0" y="50" ${LABEL} letter-spacing="1px">${label}</text>`);
  assert.throws(
    () => outlineBasemapText(spaced("GTX-A")),
    /<text>\(t\): letter-spacing이 있는 "GTX-A"에 글리프 대체가 생겨 브라우저와 같은 배치를 낼 수 없습니다/,
  );
  assert.equal(glyphsDrawn(spaced("GTX")), 3);
  assert.equal(
    glyphsDrawn(svgOf(`<text x="0" y="50" ${LABEL}>GTX-A</text>`)),
    5,
    "letter-spacing이 없으면 같은 라벨의 글리프 대체를 그대로 그린다",
  );
});

test("숫자 문자 참조는 글자로 읽지 않고 실패한다", () => {
  for (const reference of ["&#44032;", "&#x1F600;", "가&#10;나"]) {
    assert.throws(
      () => outlineBasemapText(svgOf(`<text id="t" x="0" y="50" ${LABEL}>${reference}</text>`)),
      /<text>\(t\): 숫자 문자 참조는 해석하지 않습니다/,
      reference,
    );
  }
  assert.equal(
    glyphsDrawn(svgOf(`<text x="0" y="50" ${LABEL}>A &amp; B</text>`)),
    5,
    "이름 있는 엔티티는 해석한다",
  );
});

test("<text> 밖의 tspan은 어디에 있든 실패한다", () => {
  for (const body of [
    '<tspan id="s">가</tspan>',
    '<g><g><tspan id="s">가</tspan></g></g>',
  ]) {
    assert.throws(
      () => outlineBasemapText(svgOf(body)),
      /<tspan>\(s\)가 <text> 밖에 있습니다/,
      body,
    );
  }
});

// ── 악의적 입력(상한은 HarfBuzz 14.5.0 hb-limits.hh) ─────────────────────────
test("상한값은 HarfBuzz hb-limits.hh와 같다", () => {
  assert.deepEqual(OUTLINE_LIMITS, {
    maxInputBytes: 16 << 20,
    maxTextNesting: 64,
    maxRunCodePoints: 65536,
    maxGlyphCommands: 200000,
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

// 중첩 깊이는 `<text>`가 1이고 tspan 하나마다 1씩 는다. 상한 64단은 허용하고 65단부터 막는다.
test("텍스트 노드의 코드포인트 수는 상한까지 허용하고 하나 더 많으면 실패한다", () => {
  const limits = { ...OUTLINE_LIMITS, maxRunCodePoints: 3 };
  const labelOf = (text) => svgOf(`<text x="0" y="50" ${LABEL}>${text}</text>`);
  assert.equal(outlined(labelOf("가나다"), limits).glyphCount, 3);
  assert.throws(() => outlineBasemapText(labelOf("가나다라"), limits), /4자가 상한 3자를 넘습니다/);
});

// 입력 SVG의 UTF-8 바이트 수를 센다(HarfBuzz는 data_len 바이트를 비교한다).
test("입력 SVG가 바이트 상한을 넘으면 파싱 전에 실패한다", () => {
  const empty = svgOf("");
  const emptyBytes = Buffer.byteLength(empty);
  const limits = (maxInputBytes) => ({ ...OUTLINE_LIMITS, maxInputBytes });
  assert.equal(outlined(empty, limits(emptyBytes)).svg, empty);
  assert.throws(
    () => outlineBasemapText(empty, limits(emptyBytes - 1)),
    new RegExp(`입력 SVG ${emptyBytes}바이트가 상한 ${emptyBytes - 1}바이트를 넘습니다`),
  );
  const multibyte = svgOf("<!--가-->");
  assert.equal(Buffer.byteLength(multibyte), multibyte.length + 2, "가는 UTF-8로 3바이트다");
  assert.equal(outlined(multibyte, limits(Buffer.byteLength(multibyte))).svg, multibyte);
  assert.throws(
    () => outlineBasemapText(multibyte, limits(multibyte.length)),
    /입력 SVG \d+바이트가 상한 \d+바이트를 넘습니다/,
  );
});

test("기본 입력 상한 16MiB를 넘는 SVG는 실패한다", () => {
  const oversized = svgOf(`<!--${"a".repeat(OUTLINE_LIMITS.maxInputBytes)}-->`);
  assert.throws(() => outlineBasemapText(oversized), /입력 SVG \d+바이트가 상한 16777216바이트를 넘습니다/);
});

// 길이 문법은 `<number>` 뒤에 선택적 `px`다. 숫자 앞뒤 공백은 무시한다.
test("길이 값은 유효한 표기만 읽고 나머지는 대체 없이 실패한다", () => {
  const withX = (x) => `<text id="t" x="${x}" y="9" ${LABEL}>가</text>`;
  const originX = inkOf(withX("0")).minX;
  for (const [written, expected] of [
    ["12", 12],
    ["1.5", 1.5],
    ["-.5", -0.5],
    ["1e3", 1000],
    ["1E3", 1000],
    ["2px", 2],
    ["2PX", 2],
    ["1.", 1],
    ["-3.25e-1px", -0.325],
    ["  7  ", 7],
  ]) {
    assert.ok(Math.abs(inkOf(withX(written)).minX - originX - expected) < 1e-3, written);
  }
  for (const written of ["", "px", "1.2.3", "1e", "--1", "+5", "1 2", "1pt", "abc", "1e3.5", ".", "-"]) {
    assert.throws(
      () => outlineBasemapText(svgOf(withX(written))),
      /<text>\(t\): x=".*"를 길이로 읽지 못했습니다/,
      JSON.stringify(written),
    );
  }
});

// 문법에 맞아도 Number()가 Infinity로 넘치는 값(지수 초과, 수백 자리 숫자열)은 길이가 아니다.
// 읽어 들이면 윤곽선 좌표가 NaN이 되므로 어떤 속성에서든 대체 없이 실패한다.
test("유한하지 않은 길이는 어느 속성에서도 NaN 윤곽선 대신 실패한다", () => {
  const overflows = ["1e999", "-1e999", "9".repeat(400), `${"9".repeat(400)}px`];
  const labelWith = (attribute, written) => {
    const declared = { x: "0", "font-size": "20px", "letter-spacing": "0", [attribute]: written };
    return (
      `<text id="t" x="${declared.x}" y="9" font-family="Pretendard" font-weight="700" ` +
      `font-size="${declared["font-size"]}" letter-spacing="${declared["letter-spacing"]}">가</text>`
    );
  };
  for (const attribute of ["x", "font-size", "letter-spacing"]) {
    for (const written of overflows) {
      assert.throws(
        () => outlineBasemapText(svgOf(labelWith(attribute, written))),
        new RegExp(`${attribute}=".*"를 길이로 읽지 못했습니다`),
        `${attribute}=${written.slice(0, 12)}`,
      );
    }
  }
  assert.doesNotThrow(() => outlineBasemapText(svgOf(labelWith("x", "0"))));
});

// 숫자열에서 정규식이 역추적으로 제곱 시간을 쓰면 안 된다. 같은 입력이 이전 문법에서는
// 64,000자에 수 초였고 선형 문법에서는 1ms 안쪽이다. 경계는 느린 CI에서도 흔들리지 않게 크게 둔다.
test("긴 숫자열 길이는 입력 크기에 선형인 시간에 거부한다", () => {
  const bad = `${"1".repeat(64_000)}x`;
  for (const [attribute, body] of [
    ["x", `<text id="t" x="${bad}" y="9" ${LABEL}>가</text>`],
    ["font-size", `<text id="t" x="0" y="9" font-family="Pretendard" font-size="${bad}">가</text>`],
    ["letter-spacing", `<text id="t" x="0" y="9" ${LABEL} letter-spacing="${bad}">가</text>`],
  ]) {
    const started = performance.now();
    assert.throws(() => outlineBasemapText(svgOf(body)), /길이로 읽지 못했습니다/, attribute);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 1000, `${attribute}: ${bad.length}자 거부에 ${elapsedMs.toFixed(0)}ms`);
  }
});

test("tspan 중첩이 상한 64단까지는 허용하고 65단부터 실패한다", () => {
  const nestedLabel = (tspans) =>
    svgOf(`<text x="0" y="50" ${LABEL}>${"<tspan>".repeat(tspans)}가${"</tspan>".repeat(tspans)}</text>`);
  const atLimit = OUTLINE_LIMITS.maxTextNesting - 1;
  assert.equal(glyphsDrawn(nestedLabel(atLimit)), 1);
  assert.throws(
    () => outlineBasemapText(nestedLabel(atLimit + 1)),
    /<text>\(id 없음\): 텍스트 요소 중첩이 상한 64단을 넘습니다/,
  );
});

test("문서의 윤곽선 데이터가 상한을 넘으면 실패한다", () => {
  const body = `<text x="0" y="50" ${LABEL}>가나다라</text>`.repeat(50);
  assert.throws(
    () => outlineBasemapText(svgOf(body), { ...OUTLINE_LIMITS, maxOutlineBytes: 10_000 }),
    /문서 상한 10000바이트를 넘습니다/,
  );
  assert.throws(
    () => outlineBasemapText(svgOf(body), { ...OUTLINE_LIMITS, maxGlyphCommands: 3 }),
    /상한 3을 넘습니다/,
  );
});

// 글리프 하나의 명령 수가 상한과 같으면 그리고, 하나 더 많으면 던진다.
test("글리프 윤곽선 명령 수는 상한까지 허용하고 하나 더 많으면 실패한다", () => {
  const svg = svgOf(`<text x="0" y="50" ${LABEL}>가</text>`);
  const withCap = (maxGlyphCommands) => () =>
    outlineBasemapText(svg, { ...OUTLINE_LIMITS, maxGlyphCommands });
  let overflow = "";
  try {
    withCap(0)();
  } catch (error) {
    overflow = error.message;
  }
  const commands = Number(/윤곽선 명령이 (\d+)개로/.exec(overflow)?.[1]);
  assert.ok(commands > 1, overflow);
  outlined(svg, { ...OUTLINE_LIMITS, maxGlyphCommands: commands });
  assert.throws(withCap(commands - 1), new RegExp(`${commands}개로 상한 ${commands - 1}을 넘습니다`));
});

test("같은 라벨이 반복돼도 글리프 윤곽선은 한 번만 꺼낸다", () => {
  const body = `<text x="0" y="50" ${LABEL}>가나가나</text>`.repeat(2000);
  const { glyphCount, distinctGlyphOutlines } = outlineBasemapText(svgOf(body));
  assert.equal(glyphCount, 8000);
  assert.equal(distinctGlyphOutlines, 2);
});
