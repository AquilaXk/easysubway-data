import assert from "node:assert/strict";
import test from "node:test";

import { octilinearPolyline, octilinearSegment } from "./octolinearize-line-tracks.mjs";

// #1789 octolinearize 순수함수 테스트. 노드를 8방향(0/45/90/135°) 세그먼트로
// 잇되 노드 좌표는 유지하고 도그레그 꼭짓점 1개만 넣는지 고정한다.

test("순수 수평/수직/45°는 직선 1세그먼트", () => {
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: 10, y: 0 }), [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: 0, y: 7 }), [
    { x: 0, y: 0 },
    { x: 0, y: 7 },
  ]);
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: 5, y: 5 }), [
    { x: 0, y: 0 },
    { x: 5, y: 5 },
  ]);
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: -5, y: 5 }), [
    { x: 0, y: 0 },
    { x: -5, y: 5 },
  ]);
});

test("수평 우세는 45° 후 수평 도그레그(꼭짓점 1개)", () => {
  // (0,0)→(10,3): 짧은 축 3만큼 45° → (3,3), 이후 수평 → (10,3).
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: 10, y: 3 }), [
    { x: 0, y: 0 },
    { x: 3, y: 3 },
    { x: 10, y: 3 },
  ]);
});

test("수직 우세도 45° 후 수직 도그레그", () => {
  // (0,0)→(3,10): 짧은 축 3만큼 45° → (3,3), 이후 수직 → (3,10).
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: 3, y: 10 }), [
    { x: 0, y: 0 },
    { x: 3, y: 3 },
    { x: 3, y: 10 },
  ]);
});

test("octilinearSegment: bend-late는 코너를 b 근처로 옮긴다(#2068 5차 코너 방향 선택)", () => {
  // (0,0)→(10,3): bend-early는 코너(3,3)=a에서 45° 먼저(diag*√2 짧은 리드가
  // a쪽). bend-late는 직선(longAxis-diag=7)을 a에서 먼저 가고 나머지 대각선
  // (diag*√2)이 b쪽 — 코너는 (7,0).
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: 10, y: 3 }, "bend-late"), [
    { x: 0, y: 0 },
    { x: 7, y: 0 },
    { x: 10, y: 3 },
  ]);
});

test("octilinearSegment: bend-late 수직 우세도 코너를 b 근처로", () => {
  // (0,0)→(3,10): bend-early 코너(3,3). bend-late는 직선(longAxis-diag=7)을
  // a에서 먼저(y축) → 코너(0,7).
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: 3, y: 10 }, "bend-late"), [
    { x: 0, y: 0 },
    { x: 0, y: 7 },
    { x: 3, y: 10 },
  ]);
});

test("octilinearSegment: variant 미지정(기본)은 bend-early와 동일(기존 산출 불변)", () => {
  assert.deepEqual(
    octilinearSegment({ x: 0, y: 0 }, { x: 10, y: 3 }),
    octilinearSegment({ x: 0, y: 0 }, { x: 10, y: 3 }, "bend-early"),
  );
});

test("octilinearSegment: 이미 8선형이면 variant와 무관하게 직선 1세그먼트", () => {
  assert.deepEqual(octilinearSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, "bend-late"), [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);
});

test("octilinearPolyline은 노드를 모두 지나고 중복 없이 이어붙인다", () => {
  const nodes = [
    { x: 0, y: 0 },
    { x: 10, y: 3 },
    { x: 10, y: 13 },
  ];
  const poly = octilinearPolyline(nodes);
  // 각 원본 노드가 정점에 포함(노드 정합).
  for (const n of nodes) {
    assert.ok(poly.some((v) => v.x === n.x && v.y === n.y), `${JSON.stringify(n)} 포함`);
  }
  // 첫 정점 = 첫 노드, 끝 정점 = 끝 노드.
  assert.deepEqual(poly[0], nodes[0]);
  assert.deepEqual(poly[poly.length - 1], nodes[nodes.length - 1]);
  // 모든 세그먼트가 8방향인지.
  for (let i = 0; i + 1 < poly.length; i += 1) {
    const dx = Math.abs(poly[i + 1].x - poly[i].x);
    const dy = Math.abs(poly[i + 1].y - poly[i].y);
    assert.ok(dx === 0 || dy === 0 || dx === dy, `세그 ${i} 8방향`);
  }
});
