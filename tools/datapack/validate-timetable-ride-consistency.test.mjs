import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTimetableRideConsistency } from "./validate-timetable-ride-consistency.mjs";

// 3역(A→B→C) 하행 코리도, trip 2개. 인접역 구간 소요 = arrival(next) - departure(current).
//   A→B: t1 200-100=100, t2 1105-1000=105  → median 102.5
//   B→C: t1 320-210=110, t2 1230-1115=115  → median 112.5
const RECONSTRUCTION = {
  transitStopTimes: [
    { tripId: "t1", stopSequence: 1, stationId: "station-x-1", lineId: "x", arrivalSeconds: 100, departureSeconds: 100 },
    { tripId: "t1", stopSequence: 2, stationId: "station-x-2", lineId: "x", arrivalSeconds: 200, departureSeconds: 210 },
    { tripId: "t1", stopSequence: 3, stationId: "station-x-3", lineId: "x", arrivalSeconds: 320, departureSeconds: 320 },
    { tripId: "t2", stopSequence: 1, stationId: "station-x-1", lineId: "x", arrivalSeconds: 1000, departureSeconds: 1000 },
    { tripId: "t2", stopSequence: 2, stationId: "station-x-2", lineId: "x", arrivalSeconds: 1105, departureSeconds: 1115 },
    { tripId: "t2", stopSequence: 3, stationId: "station-x-3", lineId: "x", arrivalSeconds: 1230, departureSeconds: 1230 },
  ],
};

const RIDE_EDGES = [
  // A→B: 110s vs 시간표 ~103s → 정합(abs 60s 이내)
  { fromNodeId: "station-x-1:x:down", toNodeId: "station-x-2:x:down", edgeType: "RIDE", durationSeconds: 110 },
  // B→C: 400s vs 시간표 ~113s → 비정합(abs·rel 초과)
  { fromNodeId: "station-x-2:x:down", toNodeId: "station-x-3:x:down", edgeType: "RIDE", durationSeconds: 400 },
  // C→D: 시간표 구간 없음 → rideEdgesWithoutTimetable
  { fromNodeId: "station-x-3:x:down", toNodeId: "station-x-4:x:down", edgeType: "RIDE", durationSeconds: 150 },
  // 비 RIDE edge 는 무시
  { fromNodeId: "station-x-1:x:down", toNodeId: "station-x-2:x:down", edgeType: "WALKWAY", durationSeconds: 999 },
];

test("정합 RIDE edge 는 matched 로 분류되고 withinTolerance 다", () => {
  const result = checkTimetableRideConsistency({ reconstruction: RECONSTRUCTION, rideEdges: RIDE_EDGES });
  const ab = result.matched.find((m) => m.fromStationId === "station-x-1" && m.toStationId === "station-x-2");
  assert.ok(ab, "A→B 는 matched 여야 한다");
  assert.equal(ab.lineId, "x");
  assert.equal(ab.edgeSeconds, 110);
  assert.equal(ab.timetableSeconds, 103); // round(102.5)
  assert.equal(ab.withinTolerance, true);
  assert.equal(ab.deltaSeconds, 7);
});

test("허용오차를 벗어난 RIDE edge 는 violations 로 분류된다", () => {
  const result = checkTimetableRideConsistency({ reconstruction: RECONSTRUCTION, rideEdges: RIDE_EDGES });
  assert.equal(result.violations.length, 1);
  const bc = result.violations[0];
  assert.equal(bc.fromStationId, "station-x-2");
  assert.equal(bc.toStationId, "station-x-3");
  assert.equal(bc.edgeSeconds, 400);
  assert.equal(bc.timetableSeconds, 113); // round(112.5)
  assert.equal(bc.deltaSeconds, 287);
  assert.equal(bc.withinTolerance, false);
});

test("시간표 구간이 없는 RIDE edge 는 rideEdgesWithoutTimetable 로 분리된다", () => {
  const result = checkTimetableRideConsistency({ reconstruction: RECONSTRUCTION, rideEdges: RIDE_EDGES });
  assert.equal(result.rideEdgesWithoutTimetable.length, 1);
  assert.equal(result.rideEdgesWithoutTimetable[0].fromStationId, "station-x-3");
  assert.equal(result.rideEdgesWithoutTimetable[0].toStationId, "station-x-4");
});

test("비 RIDE edge(WALKWAY)는 어떤 목록에도 포함되지 않는다", () => {
  const result = checkTimetableRideConsistency({ reconstruction: RECONSTRUCTION, rideEdges: RIDE_EDGES });
  const all = [...result.matched, ...result.violations, ...result.rideEdgesWithoutTimetable];
  assert.equal(all.every((row) => row.edgeSeconds !== 999), true);
});

test("모든 시간표 인접 구간이 RIDE edge 로 커버되면 timetableSegmentsWithoutEdge 는 비어 있다", () => {
  const result = checkTimetableRideConsistency({ reconstruction: RECONSTRUCTION, rideEdges: RIDE_EDGES });
  assert.equal(result.timetableSegmentsWithoutEdge.length, 0);
});

test("RIDE edge 가 없는 시간표 구간은 timetableSegmentsWithoutEdge 로 보고된다", () => {
  const result = checkTimetableRideConsistency({
    reconstruction: RECONSTRUCTION,
    rideEdges: RIDE_EDGES.filter((e) => !(e.edgeType === "RIDE" && e.fromNodeId.startsWith("station-x-2"))),
  });
  const bc = result.timetableSegmentsWithoutEdge.find(
    (s) => s.fromStationId === "station-x-2" && s.toStationId === "station-x-3"
  );
  assert.ok(bc, "B→C 시간표 구간이 edge 미커버로 보고돼야 한다");
  assert.equal(bc.timetableSeconds, 113);
});

test("summary 는 검사·정합·위반 수를 집계한다", () => {
  const result = checkTimetableRideConsistency({ reconstruction: RECONSTRUCTION, rideEdges: RIDE_EDGES });
  assert.equal(result.summary.rideEdgeCount, 3); // WALKWAY 제외
  assert.equal(result.summary.matchedCount, 1);
  assert.equal(result.summary.violationCount, 1);
  assert.equal(result.summary.consistent, false);
});

test("음수·0 구간(도착≤출발)은 표본에서 제외된다", () => {
  const reconstruction = {
    transitStopTimes: [
      { tripId: "bad", stopSequence: 1, stationId: "station-x-1", lineId: "x", arrivalSeconds: 500, departureSeconds: 500 },
      // 다음 역 도착이 이전 역 출발보다 이르다(데이터 오류) → 제외
      { tripId: "bad", stopSequence: 2, stationId: "station-x-2", lineId: "x", arrivalSeconds: 400, departureSeconds: 410 },
    ],
  };
  const result = checkTimetableRideConsistency({
    reconstruction,
    rideEdges: [{ fromNodeId: "station-x-1:x:down", toNodeId: "station-x-2:x:down", edgeType: "RIDE", durationSeconds: 110 }],
  });
  // 유효 표본이 없으므로 A→B 는 matched/violation 이 아니라 edge-without-timetable 이다.
  assert.equal(result.matched.length, 0);
  assert.equal(result.violations.length, 0);
  assert.equal(result.rideEdgesWithoutTimetable.length, 1);
});
