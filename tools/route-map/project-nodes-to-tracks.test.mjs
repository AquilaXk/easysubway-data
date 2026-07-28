import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProjectionReport,
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

test("checkProjectionReport는 기존 도라산만 허용하고 신규·악화·누락·stale을 실패시킨다", () => {
  const report = (overThreshold, withoutTrack = []) => ({
    region: "수도권",
    nodes: 1,
    nodesWithoutTrack: withoutTrack.length,
    withoutTrack,
    overThreshold,
  });
  const dorasan = {
    station_id: "station-4c48e8115728",
    line_id: "line-6e39be0cb6e2",
    dist: 406,
  };

  assert.deepEqual(checkProjectionReport(report([dorasan])), {
    unexpected: [],
    exceededBaseline: [],
    staleBaseline: [],
    missingTracks: [],
    emptyRegion: [],
  });
  assert.deepEqual(
    checkProjectionReport(report([{ ...dorasan, dist: 407 }])).exceededBaseline,
    [{ ...dorasan, dist: 407, maxDistancePx: 406 }],
  );
  assert.deepEqual(
    checkProjectionReport(
      report([
        dorasan,
        { station_id: "station-new", line_id: "line-new", dist: 101 },
      ]),
    ).unexpected,
    [{ station_id: "station-new", line_id: "line-new", dist: 101 }],
  );
  assert.deepEqual(
    checkProjectionReport(
      report([dorasan], [{ station_id: "station-missing", line_id: "line-missing" }]),
    ).missingTracks,
    [{ station_id: "station-missing", line_id: "line-missing" }],
  );
  assert.deepEqual(checkProjectionReport(report([])).staleBaseline, [
    {
      region: "수도권",
      stationId: "station-4c48e8115728",
      lineId: "line-6e39be0cb6e2",
      maxDistancePx: 406,
      reason: "도라산은 오너 SMA SVG 미수록 topology exception; #2571에서 기존 실측만 동결",
    },
  ]);
});

test("checkProjectionReport는 역이 하나도 없는 권역을 실패시킨다", () => {
  assert.deepEqual(checkProjectionReport({
    region: "부산권",
    nodes: 0,
    withoutTrack: [],
    overThreshold: [],
  }).emptyRegion, ["부산권"]);
});
