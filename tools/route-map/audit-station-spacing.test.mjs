import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRespaceGraph, parsePathPoints } from "./respace-route-map.mjs";
import {
  chainLengthStats,
  segmentCrossingCount,
  octolinearityViolations,
  classifyCrossings,
  clusterCentroids,
} from "./audit-station-spacing.mjs";

test("chainLengthStats: 분포와 p95/p5", () => {
  const graph = buildRespaceGraph({
    tracks: [
      {
        lineId: "L1",
        trackIndex: 0,
        points: parsePathPoints("M 0 0 L 10 0 L 110 0 L 510 0"),
      },
    ],
    positions: [
      { stationId: "a", lineId: "L1", x: 0, y: 0 },
      { stationId: "b", lineId: "L1", x: 10, y: 0 },
      { stationId: "c", lineId: "L1", x: 110, y: 0 },
      { stationId: "d", lineId: "L1", x: 510, y: 0 },
    ],
  });
  const stats = chainLengthStats(graph);
  assert.equal(stats.count, 3); // 10, 100, 400
  assert.equal(stats.median, 100);
  assert.equal(stats.max, 400);
  assert.ok(stats.p95OverP5 > 1);
});

test("segmentCrossingCount: 교차는 세고 끝점 접촉은 무시", () => {
  const crossing = [
    parsePathPoints("M 0 0 L 100 100"),
    parsePathPoints("M 0 100 L 100 0"),
  ];
  assert.equal(segmentCrossingCount(crossing), 1);
  const touching = [
    parsePathPoints("M 0 0 L 100 0"),
    parsePathPoints("M 100 0 L 200 0"),
  ];
  assert.equal(segmentCrossingCount(touching), 0);
});

test("octolinearityViolations: 45° 배수 이탈만 잡는다", () => {
  const tracks = [parsePathPoints("M 0 0 L 100 0 L 200 103")];
  const violations = octolinearityViolations(tracks, { toleranceDeg: 0.5 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].segIdx, 1);
});

test("classifyCrossings: cluster 거리로 free/knotVisible/knotCovered 3분류", () => {
  // X자 교차 3쌍: 교차점 (0,0) / (100,0) / (300,0). centroid는 (0,0) 하나.
  const tracks = [
    // 교차점 (0,0) — coverRadius(10) 내 → knotCovered
    parsePathPoints("M -5 -5 L 5 5"),
    parsePathPoints("M -5 5 L 5 -5"),
    // 교차점 (100,0) — knotRadius(150) 내, coverRadius 밖 → knotVisible
    parsePathPoints("M 95 -5 L 105 5"),
    parsePathPoints("M 95 5 L 105 -5"),
    // 교차점 (300,0) — knotRadius 밖 → free
    parsePathPoints("M 295 -5 L 305 5"),
    parsePathPoints("M 295 5 L 305 -5"),
  ];
  const result = classifyCrossings(tracks, [{ x: 0, y: 0 }], {
    knotRadius: 150,
    coverRadius: 10,
  });
  assert.deepEqual(result, {
    free: 1,
    knotCovered: 1,
    knotVisible: 1,
    knot: 2,
    total: 3,
  });
});

test("clusterCentroids: 멤버 좌표 − offset 평균", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 100 0") },
      { lineId: "L2", trackIndex: 0, points: parsePathPoints("M 0 6 L 100 6") },
    ],
    positions: [
      { stationId: "x", lineId: "L1", x: 50, y: 0 },
      { stationId: "x", lineId: "L2", x: 50, y: 6 },
    ],
  });
  const centroids = clusterCentroids(graph, graph.nodes);
  assert.equal(centroids.length, 1);
  assert.ok(Math.abs(centroids[0].x - 50) < 1e-6);
  assert.ok(Math.abs(centroids[0].y - 3) < 1e-6);
});
