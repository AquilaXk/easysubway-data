import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

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

test("고정 mobile 픽스처의 바탕·강조 레이어 .vec 41개가 모두 읽히고 그리기가 있다", () => {
  const files = readdirSync(basemapDir).filter((name) => name.endsWith(".vec"));
  assert.equal(files.length, 41);
  for (const name of files) {
    const doc = decodeVec(new Uint8Array(readFileSync(path.join(basemapDir, name))));
    assert.ok(doc.commands.some(({ op }) => op === "drawPath"), name);
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
  assert.deepEqual(decodeVec(bytes).commands, doc.commands);
});
