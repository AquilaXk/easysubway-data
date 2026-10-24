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

test("고정 mobile 픽스처의 바탕·강조 레이어 .vec 전부가 읽고 다시 쓰면 같은 바이트다", () => {
  const files = readdirSync(basemapDir).filter((name) => name.endsWith(".vec"));
  assert.equal(files.length, 41);
  for (const name of files) {
    const bytes = new Uint8Array(readFileSync(path.join(basemapDir, name)));
    assert.deepEqual(encodeVec(decodeVec(bytes)), bytes, name);
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

test(`id는 코덱 상한(${VEC_MAX_ID}은 "없음" 표시)을 넘겨 쓸 수 없다`, () => {
  const tooMany = { ...sample(), paints: Array.from({ length: VEC_MAX_ID }, () => FILL), commands: [] };
  assert.throws(() => encodeVec(tooMany), /id 상한/);
  const atLimit = { ...sample(), paints: Array.from({ length: VEC_MAX_ID - 1 }, () => FILL), commands: [] };
  assert.equal(decodeVec(encodeVec(atLimit)).paints.length, VEC_MAX_ID - 1);
});
