import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseBasemapVectorFileName } from "./basemap-variants.mjs";
import { decodeVec, encodeVec, VEC_MAX_ID, VERB } from "./vec-codec.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const basemapDir = path.join(root, "apps/mobile/assets/datapacks/metro_map_pack/basemap");

const FILL = { style: "fill", color: 0xff112233, blendMode: 3, shaderId: null };
const STROKE = { style: "stroke", color: 0x80ffffff, cap: 2, join: 0, blendMode: 3, miterLimit: 4, width: 1.5, shaderId: null };

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
  const doc = decodeVec(golden);
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
  assert.deepEqual(decodeVec(encodeVec(textSample())), textSample());
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
    const doc = decodeVec(new Uint8Array(readFileSync(path.join(basemapDir, name))));
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
