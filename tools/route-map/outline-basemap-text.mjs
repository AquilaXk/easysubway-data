// 노선도 바탕층 라벨을 참조 서체의 글리프 윤곽선(path)으로 굽는다(#1488).
//
// mobile은 번들 Pretendard를 걷어내(mobile #504) `.vec`의 텍스트를 기기 시스템 서체로
// 그린다. 시스템 서체는 오너 도식의 Pretendard보다 굵고 넓어 역명이 노선과 환승 기호를
// 덮는다. 상용 지하철 서비스의 노선도는 역명을 지도 그림의 일부로 고정된 서체·줄바꿈으로
// 그린다. 그래서 컴파일 입력의 `<text>`를 오너가 설계한 페이스의 윤곽선으로 바꿔
// `.vec`가 기기 서체에 기대지 않게 한다. 앱 UI 글자는 그대로 시스템 서체다.
//
// 셰이핑과 윤곽선은 HarfBuzz가 낸다(harfbuzzjs 1.6.2, HarfBuzz 14.5.0 WASM 빌드,
// MIT·Old MIT). 브라우저·Inkscape·Flutter가 쓰는 같은 셰이퍼라 커닝(GPOS kern)과
// 문맥 대체(GSUB calt, 예: "GTX-A"의 대문자 높이 하이픈)가 그대로 적용된다. npm
// 의존성을 들이지 않으려고 배포 tarball의 파일을 무수정으로 vendor/harfbuzzjs에 두고,
// 불러오기 전에 sha256을 확인한다.
//
// 배치 규칙은 지금 배포 중인 `.vec` 경로를 그대로 따른다. 바뀌는 것은 글자 모양뿐이다.
//   - 공백 처리: vector_graphics_compiler 1.3.0 lib/src/svg/parser.dart 706-764행
//     `_appendText`와 938-942행(`</text>`에서 상태 초기화). xml:space는 보지 않는다.
//   - 청크와 text-anchor: vector_graphics 1.2.2 lib/src/listener.dart 655-805행.
//     `<text>`와 x·y가 있는 요소가 새 청크를 열고, 앵커가 바뀌어도 새 청크다.
//     청크 진행폭 × (0, 0.5, 1)만큼 앞으로 당긴다.
//   두 파일 모두 BSD-3-Clause(Copyright 2013 The Flutter Authors)다.
// letter-spacing은 배포 중인 `.vec` 형식이 담지 못해 지금까지 빠져 있었다. 오너 도식을
// 브라우저가 그리는 방식(Chrome 실측: 글자마다 뒤에 더하고 마지막 글자 뒤에도 더한다,
// 청크 진행폭에 포함)대로 넣는다.
//
// 상한은 HarfBuzz 14.5.0 src/hb-limits.hh 값을 그대로 쓴다. 넘으면 던진다.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildSvgTree,
  decodeXmlText,
  firstAttr,
  inheritedStyleOrAttr,
  parseSvgLength,
  readReferenceFontBytes,
  REFERENCE_TEXT_FACES,
  roundCoord,
} from "./basemap-svg-core.mjs";

const VENDOR_DIR = path.join(import.meta.dirname, "vendor/harfbuzzjs");

// harfbuzzjs 1.6.2 npm tarball(dist.integrity 아래 값)의 dist 파일. 버전을 올릴 때는
// 새 tarball에서 세 파일을 그대로 복사하고 이 표와 versionString 기대값을 함께 바꾼다.
export const HARFBUZZJS_VENDOR = Object.freeze({
  package: "harfbuzzjs",
  version: "1.6.2",
  harfbuzzVersion: "14.5.0",
  integrity:
    "sha512-95c1vWuzoHjM19d5fQgPbz1wcv1pTa0UM9dZrdPgSMUEVuSwuzeVPkq6UhHHw3jLOkE9AYzzTP8XQkRBpPYpEg==",
  files: Object.freeze({
    "index.mjs": "04ece1914c8720ad96257728119c1bf24088ee4ef3ab2a2ca688c9a4895d4e7e",
    "harfbuzz.js": "ba43463df44851fd58211ef8c19aa7956965390857727ae867b70dc7b3682de1",
    "harfbuzz.wasm": "684bda29aee2411d05e6859070a9b1a6b8d061025ededb5a8910098fd0cf10f4",
  }),
});

for (const [name, expected] of Object.entries(HARFBUZZJS_VENDOR.files)) {
  const digest = createHash("sha256")
    .update(readFileSync(path.join(VENDOR_DIR, name)))
    .digest("hex");
  if (digest !== expected) {
    throw new Error(
      `vendor/harfbuzzjs/${name}: 고정 digest와 다릅니다(sha256 ${digest}, 기대 ${expected}).`,
    );
  }
}
const hb = await import(pathToFileURL(path.join(VENDOR_DIR, "index.mjs")).href);
if (hb.versionString() !== HARFBUZZJS_VENDOR.harfbuzzVersion) {
  throw new Error(
    `HarfBuzz ${hb.versionString()}가 올라왔습니다(기대 ${HARFBUZZJS_VENDOR.harfbuzzVersion}).`,
  );
}

export const OUTLINE_LIMITS = Object.freeze({
  // hb-limits.hh:132-133 HB_SVG_MAX_DOCUMENT_SIZE. 입력 SVG 문서 하나의 바이트 수.
  // 적용은 src/OT/Color/svg/svg.hh:78-79(`data_len > HB_SVG_MAX_DOCUMENT_SIZE`면 거부)와 같다.
  maxInputBytes: 16 << 20,
  // hb-limits.hh:53 HB_MAX_NESTING_LEVEL. `<tspan>` 중첩 깊이.
  maxTextNesting: 64,
  // hb-limits.hh:35 HB_BUFFER_MAX_LEN_MIN. 텍스트 노드 하나의 코드포인트 수.
  maxRunCodePoints: 65536,
  // hb-limits.hh:107-108 HB_CFF_MAX_OPS. 참조 페이스 5종이 모두 CFF(OTTO)라 글리프 하나는
  // charstring 하나이고, HarfBuzz가 그 연산자 수를 이 값으로 끊는다
  // (hb-cff-interp-cs-common.hh:898-906). 여기서는 꺼낸 윤곽선 명령 수에 같은 값을 건다.
  maxGlyphCommands: 200000,
  // hb-limits.hh:143 HB_VECTOR_MAX_DOCUMENT_SIZE. 문서 하나에 더하는 path 데이터 바이트.
  maxOutlineBytes: 16 << 20,
});

const DESIGN_FONT_FAMILY = "Pretendard";
const SHAPING_LANGUAGE = "ko";
const NOTDEF_GLYPH = 0;

function loadFace(weight, { file, sha256 }) {
  const face = new hb.Face(new hb.Blob(readReferenceFontBytes(file, sha256)), 0);
  return { weight, font: new hb.Font(face), unitsPerEm: face.upem };
}

const FACES = new Map(
  [...REFERENCE_TEXT_FACES].map(([weight, face]) => [weight, loadFace(weight, face)]),
);

// 텍스트 property가 이 단계에서 어떻게 다뤄지는지. 표에 없는 선언(fill·stroke·
// transform·id·data-* 등)은 윤곽선을 감싸는 `<g>`에 그대로 남는다.
//   layout   — 배치에 쓰고 지운다.
//   authoring — 렌더에 영향이 없는 저작 도구 정보(Inkscape 줄 상자 등). 배포 중인
//               `.vec` 경로도 읽지 않는다. 지운다.
//   initial  — 초기값만 받는다. 다른 값은 이 단계가 그리지 못하므로 던진다.
const TEXT_PROPERTY_POLICY = new Map([
  ...["x", "y", "dx", "dy", "font-family", "font-size", "font-weight", "letter-spacing", "text-anchor"]
    .map((name) => [name, { kind: "layout" }]),
  ...[
    "xml:space",
    "white-space",
    "sodipodi:role",
    "line-height",
    "text-align",
    "inline-size",
    "shape-inside",
    "-inkscape-font-specification",
    "text-rendering",
  ].map((name) => [name, { kind: "authoring" }]),
  ...Object.entries({
    "font-style": ["normal"],
    "font-variant": ["normal"],
    "font-stretch": ["normal"],
    "font-kerning": ["auto", "normal"],
    "font-feature-settings": ["normal"],
    "font-variant-ligatures": ["normal"],
    kerning: ["auto"],
    "word-spacing": ["normal", "0", "0px"],
    "writing-mode": ["lr-tb", "lr", "horizontal-tb"],
    direction: ["ltr"],
    "baseline-shift": ["baseline", "0", "0px"],
    "dominant-baseline": ["auto"],
    "alignment-baseline": ["auto", "baseline"],
    "text-decoration": ["none"],
    rotate: [],
    textLength: [],
    lengthAdjust: [],
  }).map(([name, values]) => [name, { kind: "initial", values: new Set(values) }]),
]);

const TEXT_ANCHOR_MULTIPLIERS = new Map([
  ["start", 0],
  ["middle", 0.5],
  ["end", 1],
]);

function describeElement(node) {
  return `<${node.name}>(${firstAttr(node.openTag, "id") ?? "id 없음"})`;
}

function parseLength(raw, property, node) {
  const length = parseSvgLength(raw);
  if (length == null) {
    throw new Error(
      `${describeElement(node)}: ${property}="${String(raw).trim()}"를 길이로 읽지 못했습니다.`,
    );
  }
  return length.number;
}

function optionalNumber(node, name) {
  const raw = firstAttr(node.openTag, name);
  return raw == null ? null : parseLength(raw, name, node);
}

function firstFamilyOf(list) {
  const first = list.split(",")[0].trim();
  return first.replace(/^(['"])(.*)\1$/, "$2").trim();
}

// 텍스트 노드가 속한 요소에서 상속까지 반영한 글자 속성.
function textStyleOf(node) {
  for (const [property, policy] of TEXT_PROPERTY_POLICY) {
    if (policy.kind !== "initial") continue;
    const value = inheritedStyleOrAttr(node, property);
    if (value != null && !policy.values.has(value.trim())) {
      throw new Error(
        `${describeElement(node)}: ${property}="${value}"는 윤곽선 굽기가 그리지 못하는 텍스트 선언입니다.`,
      );
    }
  }
  const family = decodeXmlText(inheritedStyleOrAttr(node, "font-family") ?? "");
  if (firstFamilyOf(family) !== DESIGN_FONT_FAMILY) {
    throw new Error(
      `${describeElement(node)}: font-family "${family}"의 첫 서체가 오너 도식 서체 ` +
        `${DESIGN_FONT_FAMILY}가 아닙니다.`,
    );
  }
  const weight = Number(inheritedStyleOrAttr(node, "font-weight") ?? 400);
  const face = FACES.get(weight);
  if (!face) {
    throw new Error(`${describeElement(node)}: font-weight ${weight}에 맞는 참조 페이스가 없습니다.`);
  }
  const rawSize = inheritedStyleOrAttr(node, "font-size");
  if (rawSize == null) {
    throw new Error(`${describeElement(node)}: font-size를 찾지 못했습니다.`);
  }
  const rawSpacing = inheritedStyleOrAttr(node, "letter-spacing");
  const anchorName = (inheritedStyleOrAttr(node, "text-anchor") ?? "start").trim();
  const anchor = TEXT_ANCHOR_MULTIPLIERS.get(anchorName);
  if (anchor === undefined) {
    throw new Error(`${describeElement(node)}: text-anchor="${anchorName}"를 해석하지 못했습니다.`);
  }
  return {
    face,
    fontSize: parseLength(rawSize, "font-size", node),
    letterSpacing:
      rawSpacing == null || rawSpacing.trim() === "normal"
        ? 0
        : parseLength(rawSpacing, "letter-spacing", node),
    anchor,
  };
}

// 요소 안의 문자 데이터와 자식 요소를 문서 순서로 낸다.
function* contentOf(svgText, node) {
  if (node.openTag.endsWith("/>")) return;
  let cursor = node.start + node.openTag.length;
  const innerEnd = node.end - `</${node.name}>`.length;
  for (const child of node.children) {
    if (child.start > cursor) yield { text: svgText.slice(cursor, child.start) };
    yield { element: child };
    cursor = child.end;
  }
  if (innerEnd > cursor) yield { text: svgText.slice(cursor, innerEnd) };
}

// parser.dart `_appendText`의 공백 규칙. `<text>`마다 새로 만든다.
function createWhitespaceState() {
  return { lastTextEndedWithSpace: false, lastEndedElement: null, currentX: null };
}

function collapseWhitespace(raw, state) {
  const hasNonWhitespace = raw.trim() !== "";
  const hasLeadingWhitespace = /^\s/.test(raw);
  const followsTspan = state.lastEndedElement === "tspan";
  const prependSpace =
    state.currentX == null &&
    (state.lastTextEndedWithSpace || (followsTspan && hasLeadingWhitespace));
  state.lastTextEndedWithSpace = hasNonWhitespace && /\s$/.test(raw);
  const text = raw
    .replaceAll("\n", "")
    .replaceAll("\t", " ")
    .trim()
    .replaceAll(/ +/g, " ");
  if (text === "") {
    if (hasLeadingWhitespace && followsTspan) state.lastTextEndedWithSpace = true;
    return "";
  }
  return prependSpace ? ` ${text}` : text;
}

function glyphOutline(face, glyphId, context) {
  const key = `${face.weight}:${glyphId}`;
  let commands = context.cache.get(key);
  if (!commands) {
    commands = face.font.glyphToJson(glyphId);
    context.outlineDraws += 1;
    if (commands.length > context.limits.maxGlyphCommands) {
      throw new Error(
        `페이스 ${face.weight} 글리프 ${glyphId}의 윤곽선 명령이 ${commands.length}개로 ` +
          `상한 ${context.limits.maxGlyphCommands}을 넘습니다.`,
      );
    }
    context.cache.set(key, commands);
  }
  return commands;
}

// HarfBuzz 셰이핑 결과를 펜 기준 글리프 배치로 바꾼다. 진행폭에는 letter-spacing을
// 글자마다(마지막 글자 포함) 더한다.
function shapeRun(text, style, node, limits) {
  const codePoints = [...text];
  if (codePoints.length > limits.maxRunCodePoints) {
    throw new Error(
      `${describeElement(node)}: 텍스트 ${codePoints.length}자가 상한 ${limits.maxRunCodePoints}자를 넘습니다.`,
    );
  }
  const units = codePoints.map((character) => character.codePointAt(0));
  const buffer = new hb.Buffer();
  buffer.addCodePoints(units);
  buffer.setDirection(hb.Direction.LTR);
  buffer.setLanguage(SHAPING_LANGUAGE);
  buffer.guessSegmentProperties();
  hb.shape(style.face.font, buffer);
  const shaped = buffer.getGlyphInfosAndPositions();
  if (shaped.length === 0) {
    throw new Error(`${describeElement(node)}: "${text}"를 셰이핑하지 못했습니다.`);
  }
  const missing = shaped.find((glyph) => glyph.codepoint === NOTDEF_GLYPH);
  if (missing) {
    const unit = units[missing.cluster].toString(16).toUpperCase().padStart(4, "0");
    throw new Error(
      `${describeElement(node)}: "${text}"의 U+${unit} 글리프가 참조 페이스 ${style.face.weight}에 없습니다.`,
    );
  }
  // 브라우저는 letter-spacing이 있으면 선택 합자를 끈다. 그 상태의 대체 규칙을 여기서
  // 재현하지 않으므로, 글자와 글리프가 일대일이 아니면 던진다.
  const substituted =
    shaped.length !== units.length ||
    shaped.some((glyph, index) => glyph.codepoint !== style.face.font.nominalGlyph(units[index]));
  if (style.letterSpacing !== 0 && substituted) {
    throw new Error(
      `${describeElement(node)}: letter-spacing이 있는 "${text}"에 글리프 대체가 생겨 ` +
        "브라우저와 같은 배치를 낼 수 없습니다.",
    );
  }
  const scale = style.fontSize / style.face.unitsPerEm;
  const glyphs = [];
  let pen = 0;
  shaped.forEach((glyph, index) => {
    glyphs.push({
      glyphId: glyph.codepoint,
      x: pen + glyph.xOffset * scale,
      y: -glyph.yOffset * scale,
    });
    pen += glyph.xAdvance * scale;
    const next = shaped[index + 1];
    if (!next || next.cluster !== glyph.cluster) pen += style.letterSpacing;
  });
  return { glyphs, advance: pen };
}

function serializeCommands(commands, originX, originY, scale) {
  let d = "";
  for (const { type, values } of commands) {
    d += type;
    for (let i = 0; i < values.length; i += 2) {
      if (i > 0) d += " ";
      d += `${roundCoord(originX + values[i] * scale)} ${roundCoord(originY - values[i + 1] * scale)}`;
    }
  }
  return d;
}

// listener.dart 의 청크 규칙으로 `<text>` 한 그루의 텍스트 노드마다 path d를 만든다.
function layoutText(svgText, textNode, context) {
  const paths = new Map();
  const whitespace = createWhitespaceState();
  const pen = { x: null, y: 0 };
  let chunk = null;

  const flush = () => {
    if (!chunk) return;
    const shift = chunk.advance * chunk.anchor;
    for (const draw of chunk.draws) {
      const scale = draw.style.fontSize / draw.style.face.unitsPerEm;
      let d = "";
      for (const glyph of draw.glyphs) {
        d += serializeCommands(
          glyphOutline(draw.style.face, glyph.glyphId, context),
          chunk.originX + draw.offset + glyph.x - shift,
          draw.y + glyph.y,
          scale,
        );
      }
      context.glyphCount += draw.glyphs.length;
      context.outlineBytes += d.length;
      if (context.outlineBytes > context.limits.maxOutlineBytes) {
        throw new Error(
          `윤곽선 path 데이터가 ${context.outlineBytes}바이트로 문서 상한 ` +
            `${context.limits.maxOutlineBytes}바이트를 넘습니다.`,
        );
      }
      paths.set(draw.key, d);
    }
    chunk = null;
  };

  const position = (node) => {
    const x = optionalNumber(node, "x");
    const y = optionalNumber(node, "y");
    const dx = optionalNumber(node, "dx");
    const dy = optionalNumber(node, "dy");
    const reset = node.name === "text";
    if (reset || x != null || y != null) flush();
    if (reset) {
      pen.x = 0;
      pen.y = 0;
    }
    if (x != null) pen.x = x;
    if (y != null) pen.y = y;
    if (dx != null) pen.x = (pen.x ?? 0) + dx;
    if (dy != null) pen.y += dy;
    whitespace.currentX = x;
  };

  const draw = (node, raw, key) => {
    if (/&#/.test(raw)) {
      throw new Error(`${describeElement(node)}: 숫자 문자 참조는 해석하지 않습니다: "${raw.trim()}"`);
    }
    const text = collapseWhitespace(decodeXmlText(raw), whitespace);
    whitespace.currentX = null;
    if (text === "") return;
    const style = textStyleOf(node);
    const run = shapeRun(text, style, node, context.limits);
    const startX = pen.x ?? 0;
    if (chunk && chunk.anchor !== style.anchor) flush();
    if (!chunk) chunk = { originX: startX, anchor: style.anchor, advance: 0, draws: [] };
    const offset = startX - chunk.originX;
    chunk.draws.push({ key, style, glyphs: run.glyphs, offset, y: pen.y });
    chunk.advance = offset + run.advance;
    pen.x = startX + run.advance;
  };

  (function visit(node, depth) {
    if (depth > context.limits.maxTextNesting) {
      throw new Error(
        `${describeElement(textNode)}: 텍스트 요소 중첩이 상한 ${context.limits.maxTextNesting}단을 넘습니다.`,
      );
    }
    const selfClosing = node.openTag.endsWith("/>");
    if (selfClosing) {
      whitespace.currentX = null;
      return;
    }
    position(node);
    let index = 0;
    for (const item of contentOf(svgText, node)) {
      if (item.element) {
        if (item.element.name !== "tspan") {
          throw new Error(
            `${describeElement(node)} 안의 <${item.element.name}>는 윤곽선 굽기가 다루지 않는 요소입니다.`,
          );
        }
        visit(item.element, depth + 1);
        // 자기폐쇄 태그는 끝 이벤트가 없다(parser.dart는 끝 요소만 기억한다).
        if (!item.element.openTag.endsWith("/>")) whitespace.lastEndedElement = "tspan";
        whitespace.currentX = null;
      } else {
        draw(node, item.text, `${node.start}:${index}`);
      }
      index += 1;
    }
  })(textNode, 1);
  flush();
  return paths;
}

const ATTRIBUTE_RE = /\s([A-Za-z_:-][\w:.-]*)="([^"]*)"/g;

function withoutTextProperties(openTag) {
  const kept = [];
  for (const [, name, value] of openTag.matchAll(ATTRIBUTE_RE)) {
    if (TEXT_PROPERTY_POLICY.has(name)) continue;
    if (name === "style") {
      const declarations = value
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item) => !TEXT_PROPERTY_POLICY.has(item.slice(0, item.indexOf(":")).trim()));
      if (declarations.length > 0) kept.push(` style="${declarations.join(";")}"`);
      continue;
    }
    kept.push(` ${name}="${value}"`);
  }
  return kept.join("");
}

function serializeOutlined(svgText, node, paths) {
  const attributes = withoutTextProperties(node.openTag);
  if (node.openTag.endsWith("/>")) return `<g${attributes}/>`;
  let body = "";
  let index = 0;
  for (const item of contentOf(svgText, node)) {
    if (item.element) {
      body += serializeOutlined(svgText, item.element, paths);
    } else {
      const d = paths.get(`${node.start}:${index}`);
      if (d) body += `<path d="${d}" fill-rule="nonzero"/>`;
    }
    index += 1;
  }
  return `<g${attributes}>${body}</g>`;
}

/**
 * 컴파일 입력의 `<text>`를 전부 참조 페이스의 윤곽선 `<path>`로 바꾼다.
 * `<text>`·`<tspan>`은 같은 속성(텍스트 property 제외)의 `<g>`가 되어 요소 순서와
 * paint 상속이 그대로 남는다. 반환값의 glyphCount는 그린 글리프 수,
 * distinctGlyphOutlines는 실제로 HarfBuzz에서 꺼낸 윤곽선 수(같은 글리프는 한 번)다.
 */
export function outlineBasemapText(svgText, limits = OUTLINE_LIMITS) {
  const inputBytes = Buffer.byteLength(svgText);
  if (inputBytes > limits.maxInputBytes) {
    throw new Error(`입력 SVG ${inputBytes}바이트가 상한 ${limits.maxInputBytes}바이트를 넘습니다.`);
  }
  const root = buildSvgTree(svgText);
  const context = { limits, cache: new Map(), glyphCount: 0, outlineBytes: 0, outlineDraws: 0 };
  const replacements = [];
  (function walk(node) {
    for (const child of node.children) {
      if (child.name === "text") {
        const paths = child.openTag.endsWith("/>")
          ? new Map()
          : layoutText(svgText, child, context);
        replacements.push({ start: child.start, end: child.end, markup: serializeOutlined(svgText, child, paths) });
      } else if (child.name === "tspan") {
        throw new Error(`${describeElement(child)}가 <text> 밖에 있습니다.`);
      } else {
        walk(child);
      }
    }
  })(root);
  let svg = "";
  let cursor = 0;
  for (const { start, end, markup } of replacements) {
    svg += svgText.slice(cursor, start) + markup;
    cursor = end;
  }
  svg += svgText.slice(cursor);
  return { svg, glyphCount: context.glyphCount, distinctGlyphOutlines: context.outlineDraws };
}
