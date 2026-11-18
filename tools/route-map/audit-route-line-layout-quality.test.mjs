import assert from "node:assert/strict";
import test from "node:test";

import {
  findLineOverlapViolations,
  findNodeStraightPassthroughViolations,
} from "./audit-route-line-layout-quality.mjs";

// #2068 2차 QA 반려("간선 겹침·노드에서 곡선") 대응 게이트 순수 함수 계약.

test("findNodeStraightPassthroughViolations: 충분히 긴 직선 리드는 통과", () => {
  const nodes = [{ dataStation: "역A", dataLine: "1", transferLines: "", x: 50, y: 0 }];
  const segmentsByLine = new Map([
    ["1", [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, kind: "line" }]],
  ]);
  const v = findNodeStraightPassthroughViolations(nodes, segmentsByLine, { minClearancePx: 6 });
  assert.equal(v.length, 0);
});

test("findNodeStraightPassthroughViolations: 노드 최근접점이 곡선 위면 위반", () => {
  const nodes = [{ dataStation: "역A", dataLine: "1", transferLines: "", x: 50, y: 0 }];
  const segmentsByLine = new Map([
    ["1", [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, kind: "curve" }]],
  ]);
  const v = findNodeStraightPassthroughViolations(nodes, segmentsByLine, { minClearancePx: 6 });
  assert.equal(v.length, 1);
  assert.equal(v[0].reason, "node-on-curve");
});

test("findNodeStraightPassthroughViolations: 직선 리드가 tolerance보다 짧으면 위반", () => {
  const nodes = [{ dataStation: "역A", dataLine: "1", transferLines: "", x: 2, y: 0 }];
  const segmentsByLine = new Map([
    ["1", [{ a: { x: 0, y: 0 }, b: { x: 3, y: 0 }, kind: "line" }]], // 길이 3 < clearance 6
  ]);
  const v = findNodeStraightPassthroughViolations(nodes, segmentsByLine, { minClearancePx: 6 });
  assert.equal(v.length, 1);
  assert.equal(v[0].reason, "short-straight-lead");
});

test("findNodeStraightPassthroughViolations: 노선과 무관한(멀리 떨어진) 노드는 건너뜀", () => {
  const nodes = [{ dataStation: "역A", dataLine: "1", transferLines: "", x: 500, y: 500 }];
  const segmentsByLine = new Map([
    ["1", [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, kind: "line" }]],
  ]);
  const v = findNodeStraightPassthroughViolations(nodes, segmentsByLine, { minClearancePx: 6 });
  assert.equal(v.length, 0);
});

test("findLineOverlapViolations: 공선+구간겹침+간격<threshold면 위반", () => {
  const segmentsByLine = new Map([
    ["A", [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, kind: "line" }]],
    ["B", [{ a: { x: 20, y: 0.5 }, b: { x: 120, y: 0.5 }, kind: "line" }]], // 거의 같은 직선, 0.5px 간격
  ]);
  const v = findLineOverlapViolations(segmentsByLine, { minSeparationPx: 2 });
  assert.equal(v.length, 1);
  assert.ok(v[0].overlapLenPx > 0);
});

test("findLineOverlapViolations: 충분히 분리된 병렬 corridor는 통과", () => {
  const segmentsByLine = new Map([
    ["A", [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, kind: "line" }]],
    ["B", [{ a: { x: 0, y: 6 }, b: { x: 100, y: 6 }, kind: "line" }]], // 6px 분리 — 정상 병주
  ]);
  const v = findLineOverlapViolations(segmentsByLine, { minSeparationPx: 2 });
  assert.equal(v.length, 0);
});

test("findLineOverlapViolations: 방향이 다르면(교차) 겹침 아님", () => {
  const segmentsByLine = new Map([
    ["A", [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, kind: "line" }]],
    ["B", [{ a: { x: 50, y: -50 }, b: { x: 50, y: 50 }, kind: "line" }]], // 수직 교차
  ]);
  const v = findLineOverlapViolations(segmentsByLine, { minSeparationPx: 2 });
  assert.equal(v.length, 0);
});

test("findLineOverlapViolations: 공선이어도 along 구간이 안 겹치면 통과", () => {
  const segmentsByLine = new Map([
    ["A", [{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, kind: "line" }]],
    ["B", [{ a: { x: 200, y: 0 }, b: { x: 300, y: 0 }, kind: "line" }]], // 같은 직선이지만 멀리 떨어짐
  ]);
  const v = findLineOverlapViolations(segmentsByLine, { minSeparationPx: 2 });
  assert.equal(v.length, 0);
});
