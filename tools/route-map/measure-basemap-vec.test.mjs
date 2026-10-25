import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { mergeBasemapDraws } from "./merge-basemap-vec-draws.mjs";
import { parseBasemapVectorFileName } from "./basemap-variants.mjs";
import { MAX_ZOOM_VIEWPORT, measureVec, summarizeVecMeasures } from "./measure-basemap-vec.mjs";
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

// 회귀 예산이다. 합치기 묶음 상한(MAX_GROUP_EXTENT 256)이 커지면 최대 줌 한 화면이 처리하는 좌표가
// 늘어난다(화면 밖 도형이 묶음에 딸려 온다). 이 값은 측정치(권역 바탕·강조 레이어 파일 중 최댓값)에
// 약 10% 여유를 둔 상한이고, 기기 래스터 시간을 뜻하지 않는다. 기기 실측(#517)으로 상한을 다시 고르면
// 이 예산도 함께 바꾼다. 측정치: seoul 2847, busan 1231, daegu 1570, daejeon 892, gwangju 1209.
const MAX_ZOOM_WINDOW_POINTS_BUDGET = Object.freeze({ seoul: 3100, busan: 1350, daegu: 1730, daejeon: 980, gwangju: 1330 });
const basemapDir = path.resolve(import.meta.dirname, "../../apps/mobile/assets/datapacks/metro_map_pack/basemap");

// 텍스트 변형(#1495)의 글자는 기기 서체로 그려 영역을 모르므로 창 부하는 path 그리기만 센다.
test("텍스트 그리기와 위치 갱신은 명령 수로 세고, 창 부하에는 path 그리기만 든다", () => {
  const golden = new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures/vec-codec-golden-text.vec")));
  const measure = measureVec(golden);
  assert.deepEqual(measure.commands, { drawPath: 3, updateTextPosition: 5, drawText: 5 });
  assert.equal(measure.maxZoomWindowDraws, 3);
});

test("요약은 변형마다 바탕 한 줄과 권역 강조 레이어 합 한 줄을 낸다", () => {
  const one = { commands: { drawPath: 2, drawText: 1, updateTextPosition: 1 }, paths: 1, controlPoints: 4, drawnPoints: 8, bytes: 10, gzipBytes: 5, maxZoomWindowDraws: 2, maxZoomWindowPoints: 8 };
  const rows = summarizeVecMeasures(
    new Map(["seoul.vec", "seoul.text.vec", "seoul.line-a.vec", "seoul.line-b.vec", "seoul.line-a.text.vec"].map((name) => [name, one])),
  );
  assert.deepEqual([...rows.keys()], ["seoul.vec", "seoul.text.vec", "seoul 강조 레이어 합", "seoul.text 강조 레이어 합"]);
  assert.deepEqual(
    ["files", "drawPath", "drawText", "other", "bytes", "maxZoomWindowPoints"].map((column) => rows.get("seoul 강조 레이어 합")[column]),
    [2, 4, 2, 2, 20, 8],
  );
});

test("배포 바탕·강조 레이어 .vec의 최대 줌 한 화면 좌표 수는 두 변형 모두 권역별 예산 안이다", () => {
  const files = readdirSync(basemapDir).filter((name) => name.endsWith(".vec"));
  const worst = {};
  const variants = new Set();
  for (const name of files) {
    const { regionId: region, variantId } = parseBasemapVectorFileName(name);
    variants.add(variantId);
    const { maxZoomWindowPoints } = measureVec(new Uint8Array(readFileSync(path.join(basemapDir, name))));
    worst[region] = Math.max(worst[region] ?? 0, maxZoomWindowPoints);
  }
  assert.deepEqual([...variants].sort(), ["outlined", "text"]);
  assert.deepEqual(Object.keys(worst).sort(), Object.keys(MAX_ZOOM_WINDOW_POINTS_BUDGET).sort());
  for (const [region, points] of Object.entries(worst)) {
    assert.ok(points <= MAX_ZOOM_WINDOW_POINTS_BUDGET[region], `${region}: 최대 줌 창 좌표 ${points}이 예산 ${MAX_ZOOM_WINDOW_POINTS_BUDGET[region]}을 넘었다`);
  }
});

function grid() {
  const paths = Array.from({ length: 40 }, (_, index) => square(20 * index, 0));
  const commands = paths.map((_, pathId) => ({ op: "drawPath", pathId, paintId: 0, patternId: null }));
  return { width: 1000, height: 100, paints: [FILL], paths, commands };
}

test("묶음 상한이 없으면 같은 장면의 최대 줌 창 좌표가 늘어난다(출하 상한 256이 예산을 지키는 수단이다)", () => {
  const unbounded = mergeBasemapDraws(grid(), [], { maxExtent: { width: Infinity, height: Infinity } }).base;
  const shipped = mergeBasemapDraws(grid()).base;
  assert.ok(measureVec(encodeVec(unbounded)).maxZoomWindowPoints > measureVec(encodeVec(shipped)).maxZoomWindowPoints);
});
