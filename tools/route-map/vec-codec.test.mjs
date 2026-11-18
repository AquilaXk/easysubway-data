import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseBasemapVectorFileName } from "./basemap-variants.mjs";
import {
  decodeVec,
  encodeVec,
  assertVecBounds,
  VEC_MAX_ID,
  VEC_MAX_TOTAL_VERTICES,
  VEC_MAX_STATION_COUNT,
  VERB,
  encodeZigZag,
  decodeZigZag,
  writeVarint,
  readVarint,
  encodeCommandInteger,
  decodeCommandInteger,
  encodeGeometry,
  decodeGeometry,
  MVT_COMMAND,
  MAX_QUANTIZATION_ERROR,
} from "./vec-codec.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const basemapDir = path.join(root, "apps/mobile/assets/datapacks/metro_map_pack/basemap");

const FILL = { style: "fill", color: 0xff112233, blendMode: 3, shaderId: null };
const STROKE = { style: "stroke", color: 0x80ffffff, cap: 2, join: 0, blendMode: 3, miterLimit: 4, width: 1.5, shaderId: null };

// 읽혀야 하는 바이트가 던지면 예외가 아니라 단언 실패로 드러나게 한다.
function decoded(bytes) {
  let doc;
  assert.doesNotThrow(() => {
    doc = decodeVec(bytes);
  });
  return doc;
}

function sample() {
  return {
    width: 100.5,
    height: 40,
    paints: [FILL, STROKE],
    textPositions: [],
    texts: [],
    paths: [
      // 명령 3개(홀수 바이트)라 좌표 목록 앞에 정렬 채움이 생긴다.
      { fillType: 1, verbs: Uint8Array.of(VERB.moveTo, VERB.cubicTo, VERB.close), points: Float32Array.of(1, 2, 3, 4, 5, 6, 7.25, 8) },
      { fillType: 0, verbs: Uint8Array.of(VERB.moveTo, VERB.lineTo), points: Float32Array.of(0, 0, 10, 10) },
    ],
    commands: [
      { op: "pattern", x: 0, y: 0, width: 44, height: 44, transform: Float64Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)) },
      { op: "drawPath", pathId: 1, paintId: 1, patternId: null },
      { op: "restore" },
      { op: "drawPath", pathId: 0, paintId: 0, patternId: 0 },
      { op: "clipPath", pathId: 0 },
      { op: "drawPath", pathId: 1, paintId: 1, patternId: null },
      { op: "restore" },
    ],
  };
}

test("쓰고 다시 읽으면 같은 문서다(정렬 채움·무늬·clip 포함)", () => {
  assert.deepEqual(decodeVec(encodeVec(sample())), sample());
});

test("vector_graphics_compiler가 쓴 .vec(무늬·clip·채우기와 선·정렬 채움)를 읽고 다시 쓰면 같은 바이트다", () => {
  // fixtures/vec-codec-golden.vec는 같은 이름 .svg를 vector_graphics_compiler 1.3.0
  // --no-optimize-clips로 구운 산출이다. 기대값이 Dart 코덱이 쓴 바이트라 이 코덱과 독립이다.
  const golden = new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures/vec-codec-golden.vec")));
  const doc = decodeVec(golden);
  assert.deepEqual(
    doc.commands.map(({ op, patternId }) => (patternId == null ? op : `${op}*`)),
    ["pattern", "drawPath", "restore", "drawPath*", "clipPath", "drawPath", "drawPath", "drawPath", "drawPath", "drawPath", "restore"],
  );
  assert.deepEqual(Buffer.from(encodeVec(doc)), Buffer.from(golden));
});

// 텍스트 라벨 변형(#1495)이 쓰는 기록이다. 텍스트 위치는 path 뒤·텍스트 설정 앞에 오고, 회전한
// 텍스트의 위치는 8바이트 정렬 변환 행렬을 싣는다(vector_graphics_codec.dart 646-668행).
test("vector_graphics_compiler가 쓴 텍스트 .vec(위치·설정·선만·채우기만 텍스트·회전)를 읽고 다시 쓰면 같은 바이트다", () => {
  // fixtures/vec-codec-golden-text.vec는 같은 이름 .svg를 vector_graphics_compiler 1.3.0
  // --no-optimize-clips로 구운 산출이다.
  const golden = new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures/vec-codec-golden-text.vec")));
  const doc = decoded(golden);
  const drawTexts = [
    "updateTextPosition", "drawText", "updateTextPosition", "drawText",
    "updateTextPosition", "drawText", "updateTextPosition", "drawText",
    "updateTextPosition", "drawText",
  ];
  assert.deepEqual(doc.commands.map(({ op }) => op), ["drawPath", "drawPath", ...drawTexts, "drawPath"]);
  assert.deepEqual(
    doc.texts.map(({ text, fontFamily, fontWeight, xAnchorMultiplier }) => [text, fontFamily, fontWeight, xAnchorMultiplier]),
    [["서면", "Pretendard", 6, 0.5], ["Seomyeon", "Pretendard", 6, 0.5], ["1", null, 3, 0]],
  );
  const halo = doc.commands.find(({ op }) => op === "drawText");
  assert.deepEqual([halo.fillId, doc.paints[halo.strokeId].style], [null, "stroke"]);
  assert.deepEqual(
    doc.textPositions.map(({ x, y, dx, dy, reset, transform }) => [x, y, dx, dy, reset, transform === null]),
    [[60, 30, null, null, true, true], [60, null, null, 14, false, true], [10, 70, null, null, true, false]],
  );
  assert.deepEqual(Buffer.from(encodeVec(doc)), Buffer.from(golden));
});

function textSample() {
  return {
    ...sample(),
    textPositions: [{ x: 1, y: null, dx: null, dy: 2.5, reset: true, transform: null }],
    texts: [
      {
        xAnchorMultiplier: 0.5,
        fontSize: 12,
        fontWeight: 8,
        decoration: 0,
        decorationStyle: 0,
        decorationColor: 0,
        fontFamily: null,
        text: "가나",
      },
    ],
    commands: [
      { op: "updateTextPosition", textPositionId: 0 },
      { op: "drawText", textId: 0, fillId: 0, strokeId: 1, patternId: null },
    ],
  };
}

test("텍스트 위치·설정·그리기를 쓰고 다시 읽으면 같은 문서다", () => {
  assert.deepEqual(decoded(encodeVec(textSample())), textSample());
});

// 런타임(vector_graphics 1.2.3 listener.dart 580-614행)은 굵기·장식 모양을 FontWeight.values·
// TextDecorationStyle.values 색인으로 읽고, 코덱(vector_graphics_codec.dart 629-644행)은 채우기나
// 선 중 하나는 있는 그리기만 쓴다. 그 밖의 값은 런타임에서 터지므로 읽을 때 거부한다.
test("없는 텍스트 참조·paint 없는 텍스트·범위 밖 굵기와 장식 모양·깨진 UTF-8은 읽기를 실패시킨다", () => {
  const broken = (patch) => {
    const doc = textSample();
    patch(doc);
    return encodeVec(doc);
  };
  assert.throws(() => decodeVec(broken((doc) => { doc.commands[1].textId = 3; })), /text id 3가 없습니다/);
  assert.throws(
    () => decodeVec(broken((doc) => { doc.commands[0].textPositionId = 2; })),
    /textPosition id 2가 없습니다/,
  );
  assert.throws(
    () => decodeVec(broken((doc) => { Object.assign(doc.commands[1], { fillId: null, strokeId: null }); })),
    /채우기도 선도 없는 텍스트/,
  );
  assert.throws(() => decodeVec(broken((doc) => { doc.texts[0].fontWeight = 9; })), /굵기 색인 9/);
  assert.throws(() => decodeVec(broken((doc) => { doc.texts[0].decorationStyle = 5; })), /장식 모양 색인 5/);
  const bytes = encodeVec(textSample());
  const text = Buffer.from(bytes).indexOf(Buffer.from("가나", "utf8"));
  const malformed = Uint8Array.from(bytes);
  malformed[text] = 0xff;
  assert.throws(() => decodeVec(malformed), /UTF-8/);
  assert.throws(() => decodeVec(bytes.subarray(0, text + 2)), /끊겼습니다/);
});

// 코덱은 글자열과 서체 이름 길이를 uint16으로 적는다(vector_graphics_codec.dart 608-624행).
test("UTF-8로 65535바이트를 넘는 글자열·서체 이름은 쓰기를 거부한다", () => {
  const withText = (field, value) => {
    const doc = textSample();
    doc.texts[0][field] = value;
    return doc;
  };
  assert.doesNotThrow(() => encodeVec(withText("text", "a".repeat(65535))));
  assert.throws(() => encodeVec(withText("text", "가".repeat(21846))), /65538바이트가 상한 65535/);
  assert.throws(() => encodeVec(withText("fontFamily", "a".repeat(65536))), /65536바이트가 상한 65535/);
});

test(`텍스트 위치·설정도 ${VEC_MAX_ID}개까지 쓰고 한 개 더는 id 상한으로 거부한다`, () => {
  const { textPositions, texts } = textSample();
  const many = (list, count) => Array.from({ length: count }, () => list[0]);
  const atLimit = { ...textSample(), textPositions: many(textPositions, VEC_MAX_ID), texts: many(texts, VEC_MAX_ID) };
  assert.doesNotThrow(() => encodeVec(atLimit));
  assert.throws(() => encodeVec({ ...atLimit, texts: many(texts, VEC_MAX_ID + 1) }), /text .*id 상한 65534/);
  assert.throws(
    () => encodeVec({ ...atLimit, textPositions: many(textPositions, VEC_MAX_ID + 1) }),
    /textPosition .*id 상한 65534/,
  );
});

test("고정 mobile 픽스처의 두 변형 바탕·강조 레이어 .vec가 모두 읽히고, 텍스트 변형만 텍스트를 그린다", () => {
  const files = readdirSync(basemapDir).filter((name) => name.endsWith(".vec"));
  assert.equal(files.length, 82);
  for (const name of files) {
    const doc = decoded(new Uint8Array(readFileSync(path.join(basemapDir, name))));
    assert.ok(doc.commands.some(({ op }) => op === "drawPath"), name);
    const drawsText = doc.commands.some(({ op }) => op === "drawText");
    assert.equal(drawsText, parseBasemapVectorFileName(name).variantId === "text", name);
  }
});

test("잘린 바이트·모르는 태그·없는 id 참조는 읽기를 실패시킨다", () => {
  const bytes = encodeVec(sample());
  assert.throws(() => decodeVec(bytes.subarray(0, bytes.length - 3)), /끊겼습니다/);
  const unknownTag = Uint8Array.of(...bytes.subarray(0, 5), 99);
  assert.throws(() => decodeVec(unknownTag), /알 수 없는 태그 99/);
  const strayPath = { ...sample(), commands: [{ op: "drawPath", pathId: 7, paintId: 0, patternId: null }] };
  assert.throws(() => decodeVec(encodeVec(strayPath)), /path id 7/);
});

// vector_graphics_codec 1.1.13 lib/vector_graphics_codec.dart: kMaxId 65535(109행)는 "없음" 표시라
// id는 0..65534이고(paint 327·438행, path 732행 `assert(nextId < kMaxId)`) 기록은 65535개까지 쓴다.
test(`paint·path는 코덱처럼 ${VEC_MAX_ID}개까지 쓰고 한 개 더는 id 상한으로 거부한다`, () => {
  const paintsOf = (count) => Array.from({ length: count }, () => FILL);
  const pathsOf = (count) => Array.from({ length: count }, () => sample().paths[1]);
  const atLimit = { ...sample(), paints: paintsOf(VEC_MAX_ID), paths: pathsOf(VEC_MAX_ID), commands: [] };
  let bytes;
  assert.doesNotThrow(() => {
    bytes = encodeVec(atLimit);
  });
  const decoded = decodeVec(bytes);
  assert.equal(decoded.paints.length, VEC_MAX_ID);
  assert.equal(decoded.paths.length, VEC_MAX_ID);
  assert.throws(() => encodeVec({ ...atLimit, paints: paintsOf(VEC_MAX_ID + 1) }), /paint .*id 상한 65534/);
  assert.throws(() => encodeVec({ ...atLimit, paths: pathsOf(VEC_MAX_ID + 1) }), /path .*id 상한 65534/);
});

test("가장 큰 id 65534를 참조하는 그리기는 다시 읽으면 같은 id다", () => {
  const paints = Array.from({ length: VEC_MAX_ID }, () => FILL);
  const paths = Array.from({ length: VEC_MAX_ID }, () => sample().paths[1]);
  const last = VEC_MAX_ID - 1;
  const doc = { ...sample(), paints, paths, commands: [{ op: "drawPath", pathId: last, paintId: last, patternId: null }] };
  let bytes;
  assert.doesNotThrow(() => {
    bytes = encodeVec(doc);
  });
  assert.deepEqual(decodeVec(bytes).commands, [{ op: "drawPath", pathId: 65534, paintId: 65534, patternId: null }]);
});

test("초기 버퍼를 넘는 대용량 .vec 인코딩 시 버퍼 확장·정렬 패딩·정확한 슬라이스 경계를 유지한다", () => {
  const paths = [];
  const commands = [];
  for (let i = 0; i < 400; i += 1) {
    const verbs = Uint8Array.from({ length: 31 }, (_, idx) => (idx === 0 ? VERB.moveTo : VERB.lineTo));
    const points = Float32Array.from({ length: 62 }, (_, idx) => i + idx * 0.25);
    paths.push({ fillType: i % 2, verbs, points });
    commands.push({ op: "drawPath", pathId: i, paintId: 0, patternId: null });
  }
  const textPositions = Array.from({ length: 200 }, (_, i) => ({
    x: i * 1.5,
    y: i * 2.5,
    dx: i % 2 === 0 ? 4 : null,
    dy: i % 3 === 0 ? -4 : null,
    reset: i % 5 === 0,
    transform: i % 4 === 0 ? Float64Array.from({ length: 16 }, (_, k) => (k % 5 === 0 ? 1 : 0)) : null,
  }));
  const texts = Array.from({ length: 200 }, (_, i) => ({
    xAnchorMultiplier: 0.5,
    fontSize: 12,
    fontWeight: 4,
    decoration: 0,
    decorationStyle: 0,
    decorationColor: 0xff000000,
    fontFamily: i % 2 === 0 ? "Pretendard" : null,
    text: `수도권역-${i}`,
  }));
  const doc = {
    width: 2400,
    height: 1800,
    paints: [FILL, STROKE],
    paths,
    textPositions,
    texts,
    commands: [
      { op: "pattern", x: 1, y: 2, width: 16, height: 16, transform: Float64Array.from({ length: 16 }, (_, k) => (k % 5 === 0 ? 1 : 0)) },
      ...commands,
    ],
  };

  const t0 = performance.now();
  const encoded = encodeVec(doc);
  const elapsedMs = performance.now() - t0;

  assert.ok(encoded instanceof Uint8Array);
  assert.ok(encoded.byteLength > 65_536, `expected resized >64KiB output, got ${encoded.byteLength}`);
  assert.equal(encoded.byteOffset, 0);
  assert.equal(encoded.buffer.byteLength, encoded.byteLength, "done() must return exact slice without trailing capacity");
  assert.deepEqual(decodeVec(encoded), doc);
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs < 2_000, `encodeVec took unexpectedly long: ${elapsedMs.toFixed(2)}ms`);
});

test("Mapbox PBF ZigZag 및 LEB128 Varint는 경계값과 음수에서 정확히 왕복한다", () => {
  const boundaryValues = [0, -1, 1, -2, 2, 63, -64, 64, 127, 128, -128, 255, 256, 16383, 16384, -16384, 1_000_000, -1_000_000, 2147483647, -2147483648];
  for (const v of boundaryValues) {
    const zz = encodeZigZag(v);
    assert.ok(zz >= 0 && Number.isSafeInteger(zz));
    assert.equal(decodeZigZag(zz), v);

    const buf = new Uint8Array(10);
    const end = writeVarint(buf, 0, zz);
    const { value: readVal, bytesRead } = readVarint(buf, 0);
    assert.equal(bytesRead, end);
    assert.equal(readVal, zz);
    assert.equal(decodeZigZag(readVal), v);
  }

  // 잘린 Varint 버퍼는 Fail-Closed로 거부
  assert.throws(() => readVarint(Uint8Array.of(0x80, 0x80), 0), /exceeded buffer bounds/);
});

test("CommandInteger RLE는 (cmd & 0x7) | (count << 3) 형식과 일치한다", () => {
  const cases = [
    { cmd: MVT_COMMAND.moveTo, count: 1, expected: (1 & 0x7) | (1 << 3) },
    { cmd: MVT_COMMAND.lineTo, count: 42, expected: (2 & 0x7) | (42 << 3) },
    { cmd: MVT_COMMAND.closePath, count: 1, expected: (7 & 0x7) | (1 << 3) },
  ];
  for (const { cmd, count, expected } of cases) {
    const encoded = encodeCommandInteger(cmd, count);
    assert.equal(encoded, expected);
    assert.deepEqual(decodeCommandInteger(encoded), { command: cmd, count });
  }
  assert.throws(() => encodeCommandInteger(MVT_COMMAND.moveTo, 0), /Invalid command count/);
});

test("1/16px 고정소수점 델타-ZigZag-Varint 지오메트리는 양자화 오차 0.03125px 이내 및 압축률을 검증한다", () => {
  const commands = [
    { command: "moveTo", x: 100.123, y: 200.456 },
    { command: "lineTo", x: 102.500, y: 203.125 },
    { command: "lineTo", x: 105.789, y: 207.999 },
    { command: "lineTo", x: 110.000, y: 215.333 },
    { command: "closePath" },
  ];

  const encoded = encodeGeometry(commands);
  assert.ok(encoded instanceof Uint8Array);

  // 4개 정점(float32 기준 4 * 2 * 4 = 32바이트) 대비 Varint 압축 바이트 수 비교
  const rawFloatBytes = 4 * 2 * 4;
  assert.ok(encoded.byteLength < rawFloatBytes, `압축 바이트(${encoded.byteLength})가 raw Float32(${rawFloatBytes})보다 작아야 한다`);

  const decoded = decodeGeometry(encoded);
  assert.equal(decoded.length, commands.length);

  for (let i = 0; i < commands.length; i += 1) {
    assert.equal(decoded[i].command, commands[i].command);
    if (commands[i].command !== "closePath") {
      const errX = Math.abs(decoded[i].x - commands[i].x);
      const errY = Math.abs(decoded[i].y - commands[i].y);
      assert.ok(errX <= MAX_QUANTIZATION_ERROR + 1e-9, `x error ${errX} exceeds ${MAX_QUANTIZATION_ERROR}`);
      assert.ok(errY <= MAX_QUANTIZATION_ERROR + 1e-9, `y error ${errY} exceeds ${MAX_QUANTIZATION_ERROR}`);
    }
  }
});

test("varint-zigzag-codec은 maxVertices·maxBytes 초과 시 Fail-Closed로 거부한다", () => {
  const manyLines = [
    { command: "moveTo", x: 0, y: 0 },
    ...Array.from({ length: 50 }, (_, i) => ({ command: "lineTo", x: i + 1, y: i + 1 })),
  ];
  // maxVertices = 10 초과
  assert.throws(() => encodeGeometry(manyLines, { maxVertices: 10 }), /exceeds limit of 10/);

  // maxBytes = 15 초과
  assert.throws(() => encodeGeometry(manyLines, { maxBytes: 15 }), /exceeds limit of 15 bytes/);

  const encoded = encodeGeometry(manyLines);
  assert.throws(() => decodeGeometry(encoded, { maxVertices: 10 }), /exceeds limit of 10/);
  assert.throws(() => decodeGeometry(encoded, { maxBytes: 15 }), /exceeds limit of 15/);
});

test("assertVecBounds는 정점 수 1,000,000 또는 텍스트 수 10,000 초과 시 Fail-Closed 거부한다", () => {
  const normalDoc = {
    paths: [{ points: new Float32Array([0, 0, 10, 10]) }],
    texts: [{ text: "시청" }],
  };
  assert.doesNotThrow(() => assertVecBounds(normalDoc));

  // 정점 수 초과 (1,000,001 정점 = points 길이 2,000,002)
  const hugePathsDoc = {
    paths: [{ points: { length: 2_000_002 } }],
    texts: [],
  };
  assert.throws(() => assertVecBounds(hugePathsDoc), /총 정점 수 .*개가 상한 1000000개를 넘습니다/);

  // 텍스트 수 초과 (10,001개)
  const hugeTextsDoc = {
    paths: [],
    texts: Array.from({ length: 10_001 }, () => ({ text: "역" })),
  };
  assert.throws(() => assertVecBounds(hugeTextsDoc), /라벨 텍스트 수 .*개가 상한 10000개를 넘습니다/);
});
