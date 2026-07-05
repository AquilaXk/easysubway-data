import assert from "node:assert/strict";
import test from "node:test";

import {
  projectPointToPolylines,
  projectPointToSegment,
} from "./project-nodes-to-tracks.mjs";

// #1789 Stage 1a: 노드→선 투영 순수 함수 테스트. 접근 1(수도권)에서 역을 선 위로
// 옮기는 투영이 정확해야 노드-선 정합(G3)이 보장된다.

test("projectPointToSegment는 선분 위 최근접 점·거리를 준다", () => {
  // 선분 (0,0)-(10,0), 점 (5,3) → 투영 (5,0), 거리 3.
  const r = projectPointToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(r.x, 5);
  assert.equal(r.y, 0);
  assert.equal(r.dist, 3);
});

test("projectPointToSegment는 선분 밖이면 끝점으로 clamp", () => {
  const r = projectPointToSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.dist, 5);
});

test("projectPointToSegment 길이 0 선분은 그 점 반환", () => {
  const r = projectPointToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 });
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.dist, 5);
});

test("projectPointToPolylines는 여러 조각 중 최근접에 투영", () => {
  const polylines = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 0, y: 100 }, { x: 10, y: 100 }],
  ];
  const near = projectPointToPolylines({ x: 5, y: 98 }, polylines);
  assert.equal(near.x, 5);
  assert.equal(near.y, 100);
  assert.equal(near.dist, 2);
  assert.equal(projectPointToPolylines({ x: 5, y: 5 }, []), null);
});
