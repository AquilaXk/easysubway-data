import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ZOOM_VIEWPORT, measureVec } from "./measure-basemap-vec.mjs";
import { encodeVec, VERB } from "./vec-codec.mjs";

const FILL = { style: "fill", color: 0xff000000, blendMode: 3, shaderId: null };

function square(x, y) {
  return {
    fillType: 0,
    verbs: Uint8Array.of(VERB.moveTo, VERB.lineTo, VERB.lineTo, VERB.close),
    points: Float32Array.of(x, y, x + 10, y, x + 10, y + 10),
  };
}

test("명령 종류별 수, 그리는 좌표 수, 최대 줌 한 화면에 걸리는 그리기 최댓값을 센다", () => {
  const far = MAX_ZOOM_VIEWPORT.width * 3;
  const bytes = encodeVec({
    width: far + 100,
    height: 100,
    paints: [FILL],
    paths: [square(0, 0), square(20, 0), square(far, 0)],
    commands: [
      { op: "clipPath", pathId: 0 },
      { op: "drawPath", pathId: 0, paintId: 0, patternId: null },
      { op: "drawPath", pathId: 1, paintId: 0, patternId: null },
      { op: "drawPath", pathId: 1, paintId: 0, patternId: null },
      { op: "drawPath", pathId: 2, paintId: 0, patternId: null },
      { op: "restore" },
    ],
  });
  const measure = measureVec(bytes);
  assert.deepEqual(measure.commands, { clipPath: 1, drawPath: 4, restore: 1 });
  assert.equal(measure.controlPoints, 9);
  assert.equal(measure.drawnPoints, 12);
  assert.equal(measure.maxZoomWindowDraws, 3);
  assert.equal(measure.maxZoomWindowPoints, 9);
  assert.equal(measure.bytes, bytes.byteLength);
});
