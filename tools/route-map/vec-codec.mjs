// 바탕층 `.vec`(vector_graphics 바이너리)를 읽고 다시 쓴다(#1495).
//
// vector_graphics_codec 1.1.13 lib/vector_graphics_codec.dart(BSD-3-Clause, Copyright
// 2013 The Flutter Authors)의 형식을 그대로 옮긴다. 태그 번호는 104-127행, 머리(magic·
// version)는 147-160행, 쓰는 순서와 정렬은 1202-1211행(_CurrentSection)·1267-1362행
// (VectorGraphicsBuffer), 읽는 쪽은 166-239행과 1378-1506행(_ReadBuffer)이다.
// 바탕층 컴파일러가 실제로 내는 기록(크기, fill·stroke paint, 단정밀도 path, drawPath,
// saveLayer·restore·clipPath·mask·pattern, 텍스트 라벨 변형의 텍스트 위치·설정·그리기)만 다룬다.
// 텍스트 기록은 쓰기 582-676행, 읽기 918-999행이다. 그 밖의 태그는 조용히 넘기지 않고 던진다.
// id는 코덱과 같이 uint16이고 kMaxId(65535, vector_graphics_codec.dart 109행)는 "없음" 표시라 id로 쓸 수 없다(id는 0..65534).

const MAGIC_NUMBER = 0x00882d62;
const VERSION = 1;
export const VEC_MAX_ID = 65535;
const MATRIX4_LENGTH = 16;

const TAG = Object.freeze({
  path: 27,
  fillPaint: 28,
  strokePaint: 29,
  drawPath: 30,
  saveLayer: 37,
  restore: 38,
  size: 41,
  clipPath: 42,
  mask: 43,
  drawText: 44,
  textConfig: 45,
  beginCommands: 48,
  pattern: 49,
  textPosition: 50,
  updateTextPosition: 51,
  pathHalfPrecision: 52,
});

const UNSUPPORTED_TAGS = new Map([
  [31, "drawVertices"],
  [39, "linearGradient"],
  [40, "radialGradient"],
  [46, "imageConfig"],
  [47, "drawImage"],
]);

// 런타임(vector_graphics 1.2.3 listener.dart 580-614행)이 색인으로 읽는 열거값의 개수.
// FontWeight.values는 w100..w900, TextDecorationStyle.values는 solid·double·dotted·dashed·wavy다.
const FONT_WEIGHT_COUNT = 9;
const TEXT_DECORATION_STYLE_COUNT = 5;
// 코덱은 글자열·서체 이름의 UTF-8 길이를 uint16으로 적는다(608-624행).
export const VEC_MAX_STRING_BYTES = 0xffff;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

// vector_graphics_codec ControlPointTypes(15-22행)와 각 명령이 쓰는 좌표 수.
export const VERB = Object.freeze({ moveTo: 0, lineTo: 1, cubicTo: 2, close: 3 });
export const VERB_POINT_COUNT = Object.freeze([2, 2, 6, 0]);

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.position = 0;
  }

  get hasRemaining() {
    return this.position < this.bytes.byteLength;
  }

  need(byteCount) {
    if (this.position + byteCount > this.bytes.byteLength) {
      throw new Error(`.vec가 ${this.position}바이트에서 끊겼습니다(${byteCount}바이트 필요).`);
    }
  }

  align(alignment) {
    const mod = this.position % alignment;
    if (mod !== 0) this.position += alignment - mod;
  }

  uint8() {
    this.need(1);
    return this.view.getUint8(this.position++);
  }

  uint16() {
    this.need(2);
    const value = this.view.getUint16(this.position, true);
    this.position += 2;
    return value;
  }

  uint32() {
    this.need(4);
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  float32() {
    this.need(4);
    const value = this.view.getFloat32(this.position, true);
    this.position += 4;
    return value;
  }

  uint8List(length) {
    this.need(length);
    const list = this.bytes.slice(this.position, this.position + length);
    this.position += length;
    return list;
  }

  float32List(length) {
    this.align(4);
    this.need(4 * length);
    const list = new Float32Array(length);
    for (let i = 0; i < length; i += 1) list[i] = this.view.getFloat32(this.position + 4 * i, true);
    this.position += 4 * length;
    return list;
  }

  utf8(length) {
    const bytes = this.uint8List(length);
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      throw new Error(`${this.position - length}바이트의 글자열이 올바른 UTF-8이 아닙니다.`);
    }
  }

  // writeTextPosition(646-668행)은 없는 값을 NaN으로 적고 읽는 쪽(918-938행)은 null로 돌린다.
  optionalFloat32() {
    const value = this.float32();
    return Number.isNaN(value) ? null : value;
  }

  // _ReadBuffer.getTransform(1495-1503행): 길이 0이면 없음, 아니면 8바이트 정렬 float64 16개.
  transform() {
    const length = this.uint8();
    if (length === 0) return null;
    if (length !== MATRIX4_LENGTH) throw new Error(`변환 행렬 길이 ${length}는 16이 아닙니다.`);
    this.align(8);
    this.need(8 * length);
    const list = new Float64Array(length);
    for (let i = 0; i < length; i += 1) list[i] = this.view.getFloat64(this.position + 8 * i, true);
    this.position += 8 * length;
    return list;
  }
}

function optionalId(value) {
  return value === VEC_MAX_ID ? null : value;
}

function expectSequentialId(list, id, kind) {
  if (id !== list.length) {
    throw new Error(`${kind} id ${id}가 기록 순서 ${list.length}와 다릅니다.`);
  }
}

function readPaint(reader, paints, style) {
  const color = reader.uint32();
  const paint = { style, color };
  if (style === "stroke") {
    paint.cap = reader.uint8();
    paint.join = reader.uint8();
    paint.blendMode = reader.uint8();
    paint.miterLimit = reader.float32();
    paint.width = reader.float32();
  } else {
    paint.blendMode = reader.uint8();
  }
  expectSequentialId(paints, reader.uint16(), "paint");
  paint.shaderId = optionalId(reader.uint16());
  if (paint.shaderId !== null) throw new Error("shader가 있는 paint는 다루지 않습니다.");
  paints.push(paint);
}

function readPath(reader, paths) {
  const fillType = reader.uint8();
  expectSequentialId(paths, reader.uint16(), "path");
  const verbs = reader.uint8List(reader.uint32());
  const points = reader.float32List(reader.uint32());
  let expectedPoints = 0;
  for (const verb of verbs) {
    if (verb >= VERB_POINT_COUNT.length) throw new Error(`path ${paths.length}: 알 수 없는 명령 ${verb}`);
    expectedPoints += VERB_POINT_COUNT[verb];
  }
  if (expectedPoints !== points.length) {
    throw new Error(`path ${paths.length}: 좌표 ${points.length}개가 명령이 요구하는 ${expectedPoints}개와 다릅니다.`);
  }
  paths.push({ fillType, verbs, points });
}

function referenced(list, id, kind) {
  if (id >= list.length) throw new Error(`${kind} id ${id}가 없습니다(기록 ${list.length}개).`);
  return id;
}

function readTextPosition(reader, textPositions) {
  expectSequentialId(textPositions, reader.uint16(), "textPosition");
  textPositions.push({
    x: reader.optionalFloat32(),
    y: reader.optionalFloat32(),
    dx: reader.optionalFloat32(),
    dy: reader.optionalFloat32(),
    reset: reader.uint8() !== 0,
    transform: reader.transform(),
  });
}

function readTextConfig(reader, texts) {
  expectSequentialId(texts, reader.uint16(), "text");
  const config = {
    xAnchorMultiplier: reader.float32(),
    fontSize: reader.float32(),
    fontWeight: reader.uint8(),
    decoration: reader.uint8(),
    decorationStyle: reader.uint8(),
    decorationColor: reader.uint32(),
  };
  if (config.fontWeight >= FONT_WEIGHT_COUNT) throw new Error(`text ${texts.length}: 굵기 색인 ${config.fontWeight}는 없습니다.`);
  if (config.decorationStyle >= TEXT_DECORATION_STYLE_COUNT) {
    throw new Error(`text ${texts.length}: 장식 모양 색인 ${config.decorationStyle}는 없습니다.`);
  }
  const familyLength = reader.uint16();
  config.fontFamily = familyLength === 0 ? null : reader.utf8(familyLength);
  config.text = reader.utf8(reader.uint16());
  texts.push(config);
}

function readDrawText(reader, doc, patterns) {
  const textId = referenced(doc.texts, reader.uint16(), "text");
  const [fillId, strokeId] = [reader.uint16(), reader.uint16()].map((id) =>
    id === VEC_MAX_ID ? null : referenced(doc.paints, id, "paint"),
  );
  if (fillId === null && strokeId === null) throw new Error(`text ${textId}: 채우기도 선도 없는 텍스트 그리기입니다.`);
  const patternId = optionalId(reader.uint16());
  if (patternId !== null) referenced(patterns, patternId, "pattern");
  return { op: "drawText", textId, fillId, strokeId, patternId };
}

/** `.vec` 바이트를 `{ width, height, paints, paths, textPositions, texts, commands }`로 읽는다. */
export function decodeVec(bytes) {
  const reader = new Reader(bytes);
  if (bytes.byteLength < 5 || reader.uint32() !== MAGIC_NUMBER) {
    throw new Error("vector_graphics 바이너리가 아닙니다.");
  }
  if (reader.uint8() !== VERSION) throw new Error("지원하지 않는 vector_graphics 버전입니다.");
  const doc = { width: null, height: null, paints: [], paths: [], textPositions: [], texts: [], commands: [] };
  const patterns = [];
  while (reader.hasRemaining) {
    const tag = reader.uint8();
    switch (tag) {
      case TAG.size:
        doc.width = reader.float32();
        doc.height = reader.float32();
        break;
      case TAG.fillPaint:
        readPaint(reader, doc.paints, "fill");
        break;
      case TAG.strokePaint:
        readPaint(reader, doc.paints, "stroke");
        break;
      case TAG.path:
        readPath(reader, doc.paths);
        break;
      case TAG.beginCommands:
        break;
      case TAG.drawPath: {
        const pathId = referenced(doc.paths, reader.uint16(), "path");
        const paintId = referenced(doc.paints, reader.uint16(), "paint");
        const patternId = optionalId(reader.uint16());
        if (patternId !== null) referenced(patterns, patternId, "pattern");
        doc.commands.push({ op: "drawPath", pathId, paintId, patternId });
        break;
      }
      case TAG.pattern: {
        expectSequentialId(patterns, reader.uint16(), "pattern");
        const pattern = {
          op: "pattern",
          x: reader.float32(),
          y: reader.float32(),
          width: reader.float32(),
          height: reader.float32(),
          transform: reader.transform(),
        };
        if (pattern.transform === null) throw new Error("변환 행렬 없는 pattern은 런타임이 받지 않습니다.");
        patterns.push(pattern);
        doc.commands.push(pattern);
        break;
      }
      case TAG.saveLayer:
        doc.commands.push({ op: "saveLayer", paintId: referenced(doc.paints, reader.uint16(), "paint") });
        break;
      case TAG.restore:
        doc.commands.push({ op: "restore" });
        break;
      case TAG.clipPath:
        doc.commands.push({ op: "clipPath", pathId: referenced(doc.paths, reader.uint16(), "path") });
        break;
      case TAG.mask:
        doc.commands.push({ op: "mask" });
        break;
      case TAG.textPosition:
        readTextPosition(reader, doc.textPositions);
        break;
      case TAG.textConfig:
        readTextConfig(reader, doc.texts);
        break;
      case TAG.updateTextPosition:
        doc.commands.push({
          op: "updateTextPosition",
          textPositionId: referenced(doc.textPositions, reader.uint16(), "textPosition"),
        });
        break;
      case TAG.drawText:
        doc.commands.push(readDrawText(reader, doc, patterns));
        break;
      case TAG.pathHalfPrecision:
        throw new Error("반정밀도 path는 다루지 않습니다.");
      default:
        throw new Error(
          UNSUPPORTED_TAGS.has(tag)
            ? `${UNSUPPORTED_TAGS.get(tag)} 기록은 다루지 않습니다.`
            : `알 수 없는 태그 ${tag}`,
        );
    }
  }
  if (doc.width === null) throw new Error("크기 기록이 없습니다.");
  return doc;
}

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.scratch = new DataView(new ArrayBuffer(4));
  }

  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
  }

  scalar(setter, byteCount, value) {
    this.scratch[setter](0, value, true);
    this.push(new Uint8Array(this.scratch.buffer.slice(0, byteCount)));
  }

  uint8(value) {
    this.push(Uint8Array.of(value));
  }

  uint16(value) {
    this.scalar("setUint16", 2, value);
  }

  uint32(value) {
    this.scalar("setUint32", 4, value);
  }

  float32(value) {
    this.scalar("setFloat32", 4, value);
  }

  optionalFloat32(value) {
    this.float32(value ?? Number.NaN);
  }

  utf8WithLength(value, kind) {
    const bytes = utf8Encoder.encode(value);
    if (bytes.byteLength > VEC_MAX_STRING_BYTES) {
      throw new Error(`${kind} ${bytes.byteLength}바이트가 상한 ${VEC_MAX_STRING_BYTES}바이트를 넘습니다.`);
    }
    this.uint16(bytes.byteLength);
    this.push(bytes);
  }

  // _writeTransform(1284-1291행): 없으면 길이 0, 있으면 길이 16과 8바이트 정렬 float64.
  transform(matrix) {
    if (matrix === null) {
      this.uint8(0);
      return;
    }
    this.uint8(MATRIX4_LENGTH);
    this.float64List(matrix);
  }

  align(alignment) {
    const mod = this.length % alignment;
    if (mod !== 0) this.push(new Uint8Array(alignment - mod));
  }

  float32List(list) {
    this.align(4);
    const bytes = new Uint8Array(4 * list.length);
    const view = new DataView(bytes.buffer);
    list.forEach((value, index) => view.setFloat32(4 * index, value, true));
    this.push(bytes);
  }

  float64List(list) {
    this.align(8);
    const bytes = new Uint8Array(8 * list.length);
    const view = new DataView(bytes.buffer);
    list.forEach((value, index) => view.setFloat64(8 * index, value, true));
    this.push(bytes);
  }

  done() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

// 코덱은 id를 0부터 매기고 id가 kMaxId 미만이어야 한다(vector_graphics_codec 1.1.13
// vector_graphics_codec.dart 327·438·732행 assert). 그래서 기록은 kMaxId개까지다.
function checkIdSpace(count, kind) {
  if (count > VEC_MAX_ID) throw new Error(`${kind} ${count}개는 코덱 id 상한 ${VEC_MAX_ID - 1}을 넘습니다.`);
}

function writeTextPositions(writer, textPositions) {
  textPositions.forEach(({ x, y, dx, dy, reset, transform }, id) => {
    writer.uint8(TAG.textPosition);
    writer.uint16(id);
    for (const value of [x, y, dx, dy]) writer.optionalFloat32(value);
    writer.uint8(reset ? 1 : 0);
    writer.transform(transform);
  });
}

function writeTexts(writer, texts) {
  texts.forEach((config, id) => {
    writer.uint8(TAG.textConfig);
    writer.uint16(id);
    writer.float32(config.xAnchorMultiplier);
    writer.float32(config.fontSize);
    writer.uint8(config.fontWeight);
    writer.uint8(config.decoration);
    writer.uint8(config.decorationStyle);
    writer.uint32(config.decorationColor);
    if (config.fontFamily === null) writer.uint16(0);
    else writer.utf8WithLength(config.fontFamily, "서체 이름");
    writer.utf8WithLength(config.text, "글자열");
  });
}

/** decodeVec가 읽은 모양을 코덱과 같은 바이트 순서로 쓴다(_CurrentSection 1202-1211행 순서). */
export function encodeVec({ width, height, paints, paths, textPositions = [], texts = [], commands }) {
  checkIdSpace(paints.length, "paint");
  checkIdSpace(paths.length, "path");
  checkIdSpace(textPositions.length, "textPosition");
  checkIdSpace(texts.length, "text");
  const writer = new Writer();
  writer.uint32(MAGIC_NUMBER);
  writer.uint8(VERSION);
  writer.uint8(TAG.size);
  writer.float32(width);
  writer.float32(height);
  paints.forEach((paint, id) => {
    writer.uint8(paint.style === "stroke" ? TAG.strokePaint : TAG.fillPaint);
    writer.uint32(paint.color);
    if (paint.style === "stroke") {
      writer.uint8(paint.cap);
      writer.uint8(paint.join);
      writer.uint8(paint.blendMode);
      writer.float32(paint.miterLimit);
      writer.float32(paint.width);
    } else {
      writer.uint8(paint.blendMode);
    }
    writer.uint16(id);
    writer.uint16(VEC_MAX_ID);
  });
  paths.forEach(({ fillType, verbs, points }, id) => {
    writer.uint8(TAG.path);
    writer.uint8(fillType);
    writer.uint16(id);
    writer.uint32(verbs.length);
    writer.push(Uint8Array.from(verbs));
    writer.uint32(points.length);
    writer.float32List(points);
  });
  writeTextPositions(writer, textPositions);
  writeTexts(writer, texts);
  // writePattern(691-711행)만 commands 시작 태그를 붙이지 않는다(_addCommandsTag 1267-1273행).
  let commandsTagWritten = false;
  let nextPatternId = 0;
  for (const command of commands) {
    if (command.op !== "pattern" && !commandsTagWritten) {
      writer.uint8(TAG.beginCommands);
      commandsTagWritten = true;
    }
    switch (command.op) {
      case "drawPath":
        writer.uint8(TAG.drawPath);
        writer.uint16(command.pathId);
        writer.uint16(command.paintId);
        writer.uint16(command.patternId ?? VEC_MAX_ID);
        break;
      case "pattern":
        checkIdSpace(nextPatternId + 1, "pattern");
        writer.uint8(TAG.pattern);
        writer.uint16(nextPatternId);
        nextPatternId += 1;
        writer.float32(command.x);
        writer.float32(command.y);
        writer.float32(command.width);
        writer.float32(command.height);
        writer.transform(command.transform);
        break;
      case "saveLayer":
        writer.uint8(TAG.saveLayer);
        writer.uint16(command.paintId);
        break;
      case "restore":
        writer.uint8(TAG.restore);
        break;
      case "clipPath":
        writer.uint8(TAG.clipPath);
        writer.uint16(command.pathId);
        break;
      case "mask":
        writer.uint8(TAG.mask);
        break;
      case "updateTextPosition":
        writer.uint8(TAG.updateTextPosition);
        writer.uint16(command.textPositionId);
        break;
      case "drawText":
        writer.uint8(TAG.drawText);
        writer.uint16(command.textId);
        writer.uint16(command.fillId ?? VEC_MAX_ID);
        writer.uint16(command.strokeId ?? VEC_MAX_ID);
        writer.uint16(command.patternId ?? VEC_MAX_ID);
        break;
      default:
        throw new Error(`쓸 수 없는 명령 ${command.op}`);
    }
  }
  return writer.done();
}
