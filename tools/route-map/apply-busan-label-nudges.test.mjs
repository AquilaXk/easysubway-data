import assert from "node:assert/strict";
import test from "node:test";
import { deriveCorner, moveTrackVertex } from "./apply-busan-label-nudges.mjs";

test("deriveCorner: corner=(prev.x, next.y)로 축정렬 코너를 도출한다", () => {
  const posByStation = new Map([
    ["prev", { x: 2294.484, y: 1287.729 }],
    ["next", { x: 2474.572, y: 1467.761 }],
  ]);
  const nudge = {
    prevStationId: "prev",
    nextStationId: "next",
    cornerX: "prev",
    cornerY: "next",
  };
  // prev.x=2294, next.y=1468 → prev·node 수직(공유 x), node·next 수평(공유 y).
  assert.deepEqual(deriveCorner(nudge, posByStation), { x: 2294, y: 1468 });
});

test("deriveCorner: cornerX/cornerY 선택으로 반대 코너도 도출", () => {
  const posByStation = new Map([
    ["prev", { x: 2294, y: 1288 }],
    ["next", { x: 2475, y: 1468 }],
  ]);
  const nudge = {
    prevStationId: "prev",
    nextStationId: "next",
    cornerX: "next",
    cornerY: "prev",
  };
  assert.deepEqual(deriveCorner(nudge, posByStation), { x: 2475, y: 1288 });
});

test("deriveCorner: 인접역 좌표가 없으면 던진다", () => {
  const nudge = { prevStationId: "missing", nextStationId: "next", cornerX: "prev", cornerY: "next" };
  assert.throws(() => deriveCorner(nudge, new Map([["next", { x: 1, y: 2 }]])), /인접역 좌표 없음/);
});

test("moveTrackVertex: old 근접 정점만 corner로 이동하고 나머지는 보존", () => {
  const verts = [
    { x: 2294, y: 1288 },
    { x: 2384.7, y: 1377.9 }, // old node(±5px 내)
    { x: 2475, y: 1468 },
  ];
  const { verts: out, changed } = moveTrackVertex(
    verts,
    { x: 2384.726, y: 1377.941 },
    { x: 2294, y: 1468 },
  );
  assert.equal(changed, true);
  assert.deepEqual(out, [
    { x: 2294, y: 1288 },
    { x: 2294, y: 1468 },
    { x: 2475, y: 1468 },
  ]);
});

test("moveTrackVertex: old 정점이 없으면 무변경(changed=false)", () => {
  const verts = [
    { x: 100, y: 100 },
    { x: 200, y: 200 },
  ];
  const { verts: out, changed } = moveTrackVertex(verts, { x: 999, y: 999 }, { x: 0, y: 0 });
  assert.equal(changed, false);
  assert.deepEqual(out, verts);
});
