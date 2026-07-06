import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBackendTimetableSeed } from "./build-backend-timetable-seed.mjs";

// 재구성 artifact(수집기 산출물) 축약 — up/down 각 1 trip, weekday/holiday 각 1.
const ARTIFACT = {
  transitTrips: [
    {
      id: "route-seoul-4-up-4719-8",
      routeId: "route-seoul-4-up",
      serviceId: "weekday-kric",
      tripHeadsign: "station-seoul-4-433",
      directionId: "up",
      servicePattern: "LOCAL",
    },
    {
      id: "route-seoul-4-down-4108-9",
      routeId: "route-seoul-4-down",
      serviceId: "holiday-kric",
      tripHeadsign: "station-seoul-4-456",
      directionId: "down",
      servicePattern: "LOCAL",
    },
  ],
  transitStopTimes: [
    { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 30000, departureSeconds: 30030 },
    { tripId: "route-seoul-4-up-4719-8", stopSequence: 2, stationId: "station-seoul-4-433", lineId: "seoul-4", arrivalSeconds: 30900, departureSeconds: 30930 },
    { tripId: "route-seoul-4-down-4108-9", stopSequence: 1, stationId: "station-seoul-4-433", lineId: "seoul-4", arrivalSeconds: 40000, departureSeconds: 40030 },
  ],
};

const OPTIONS = { lineId: "seoul-4", startDate: "20260101", endDate: "20261231" };

test("service_calendar는 토요일을 휴일 다이어로 매핑한다 (holiday-kric=토·일, weekday-kric=월~금)", () => {
  const seed = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  const byId = Object.fromEntries(seed.calendars.map((c) => [c.serviceId, c]));

  assert.deepEqual(
    { mon: byId["weekday-kric"].monday, fri: byId["weekday-kric"].friday, sat: byId["weekday-kric"].saturday, sun: byId["weekday-kric"].sunday },
    { mon: true, fri: true, sat: false, sun: false },
  );
  assert.deepEqual(
    { mon: byId["holiday-kric"].monday, fri: byId["holiday-kric"].friday, sat: byId["holiday-kric"].saturday, sun: byId["holiday-kric"].sunday },
    { mon: false, fri: false, sat: true, sun: true },
  );
  assert.equal(byId["weekday-kric"].startDate, "20260101");
  assert.equal(byId["weekday-kric"].endDate, "20261231");
});

test("transit_routes를 distinct routeId에서 line_id·direction으로 파생한다", () => {
  const seed = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  const byId = Object.fromEntries(seed.routes.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ["route-seoul-4-down", "route-seoul-4-up"]);
  assert.equal(byId["route-seoul-4-up"].lineId, "seoul-4");
  assert.equal(byId["route-seoul-4-up"].directionName, "up");
  assert.equal(byId["route-seoul-4-down"].directionName, "down");
});

test("SQL은 FK 순서(calendars→routes→trips→stop_times)로 INSERT를 낸다", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  const iCal = sql.indexOf("INSERT INTO service_calendars");
  const iRoute = sql.indexOf("INSERT INTO transit_routes");
  const iTrip = sql.indexOf("INSERT INTO transit_trips");
  const iStop = sql.indexOf("INSERT INTO transit_stop_times");
  assert.ok(iCal >= 0 && iRoute > iCal && iTrip > iRoute && iStop > iTrip, `순서 위반: ${[iCal, iRoute, iTrip, iStop]}`);
});

test("stop_time 행을 스키마 컬럼으로 직역한다 (pickup/drop_off 기본 0)", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  assert.match(
    sql,
    /INSERT INTO transit_stop_times \(trip_id, stop_sequence, station_id, line_id, pickup_type, drop_off_type, arrival_seconds, departure_seconds\)/,
  );
  assert.match(sql, /\('route-seoul-4-up-4719-8', 1, 'station-seoul-4-448', 'seoul-4', 0, 0, 30000, 30030\)/);
});

test("V29 CHECK를 위반하는 행(arrival>departure)은 거부한다", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 500, departureSeconds: 400 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /arrival/i);
});

test("시각 범위(0~107999)를 벗어나는 행은 거부한다", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 108000, departureSeconds: 108000 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /range|108000|107999/i);
});

test("미지 serviceId(캘린더 매핑 없음)는 거부한다", () => {
  const bad = {
    transitTrips: [{ ...ARTIFACT.transitTrips[0], serviceId: "unknown-kric" }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /unknown-kric|service/i);
});

test("stop_time의 tripId가 trips에 없으면 거부한다(FK)", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-orphan", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 30000, departureSeconds: 30030 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /orphan|trip_id|tripId|references|not found/i);
});

test("(tripId, stopSequence) 중복은 거부한다(PK)", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 30000, departureSeconds: 30030 },
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-433", lineId: "seoul-4", arrivalSeconds: 30900, departureSeconds: 30930 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /duplicate|중복|stop_sequence/i);
});

test("trip.id 중복은 거부한다(PK)", () => {
  const bad = {
    transitTrips: [ARTIFACT.transitTrips[0], { ...ARTIFACT.transitTrips[0] }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /duplicate|중복|transitTrips\.id/i);
});

test("service_pattern이 LOCAL/EXPRESS가 아니면 거부한다(V29 CHECK)", () => {
  const bad = {
    transitTrips: [{ ...ARTIFACT.transitTrips[0], servicePattern: "RAPID" }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /service_pattern|LOCAL|EXPRESS|RAPID/i);
});

test("service_day_start_seconds가 범위(0~107999)를 벗어나면 거부한다(V29 CHECK)", () => {
  const bad = {
    transitTrips: [{ ...ARTIFACT.transitTrips[0], serviceDayStartSeconds: 200000 }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /service_day_start|range|107999|200000/i);
});

test("trip 내 인접 정차 시각이 단조가 아니면 거부한다(departure[N] > arrival[N+1])", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 30000, departureSeconds: 30030 },
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 2, stationId: "station-seoul-4-433", lineId: "seoul-4", arrivalSeconds: 29000, departureSeconds: 29000 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /monoton|단조|order|departure/i);
});

test("transit_feed_info를 feed_end_date와 함께 방출한다(기본=endDate)", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  assert.match(sql, /INSERT INTO transit_feed_info \(id, feed_end_date\) VALUES \(1, '20261231'\);/);
});

test("--feed-end-date 명시 시 endDate와 분리된다", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, { ...OPTIONS, feedEndDate: "20260930" });
  assert.match(sql, /INSERT INTO transit_feed_info \(id, feed_end_date\) VALUES \(1, '20260930'\);/);
});

test("feed_end_date가 8자리 YYYYMMDD가 아니면 거부한다(transit_feed_info VARCHAR(8))", () => {
  assert.throws(() => buildBackendTimetableSeed(ARTIFACT, { ...OPTIONS, feedEndDate: "2026-12-31" }), /feed_end_date|YYYYMMDD|8/i);
});

test("값에 개행이 있으면 거부한다(한 줄=한 statement 불변식, 로더 라인 파서 전제)", () => {
  const bad = {
    transitTrips: [{ ...ARTIFACT.transitTrips[0], tripHeadsign: "사당\n방면" }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /newline|개행|single-line|한 줄/i);
});
