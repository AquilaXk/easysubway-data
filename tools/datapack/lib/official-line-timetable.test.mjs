import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { materializeOfficialLineTimetables, quarantineRowSetSha256 } from "./official-line-timetable.mjs";

// 작은 노선(A-B-C-D 직선)과 원천 trip으로 원천 중립 적재기의 계약을 고정한다.
function fixturePack() {
  const stations = ["A", "B", "C", "D"].map((name) => ({ id: `station-${name}`, nameKo: `${name}역명` }));
  const ride = (from, to) => ({ edgeType: "RIDE", fromNodeId: `station-${from}:line-x`, toNodeId: `station-${to}:line-x` });
  return {
    stations,
    stationLines: stations.map(({ id }) => ({ stationId: id, lineId: "line-x" })),
    networkEdges: [ride("A", "B"), ride("B", "C"), ride("C", "D"), ride("D", "C"), ride("C", "B"), ride("B", "A")],
  };
}

const ROW = (n) => n.toString(16).padStart(64, "0");
function trip(n, names, { pattern = "LOCAL", kind = "WEEKDAY", start = 21_600 } = {}) {
  return {
    lineId: "line-x", routeKey: "X1", providerTripKey: `X1:${n}`, trainNumber: String(n), serviceDayKind: kind,
    sourceDayKey: kind, servicePattern: pattern, headsign: names.at(-1), sourceRowSha256: ROW(n),
    stops: names.map((stationName, index) => ({
      stationName, arrivalSeconds: index === 0 ? null : start + index * 120, departureSeconds: start + index * 120 + 30,
    })),
  };
}
function provider(trips, quarantine = []) {
  return {
    sourceId: "official-source", sourceSnapshotId: "official-source-snap", rawSha256: "a".repeat(64),
    recordsSha256: "b".repeat(64), observedAt: "2026-10-02T15:57:05.773Z", dataReferenceDateByLine: { "line-x": ["2025-12-31"] },
    trips, quarantine,
  };
}
const BINDING = Object.freeze({ lineId: "line-x", routeKey: "X1", routeName: "X선", stationAliases: { 디역: { nameKo: "D역명", reason: "표기 차이" } } });
const args = (overrides) => ({
  pack: fixturePack(), lineBindings: [BINDING], serviceIdPrefix: "official", tripIdPrefix: "of", holidayDates: ["20261009", "20261003"],
  startDate: "20260101", endDate: "20261231", maxQuarantineRatio: 0.05, ...overrides,
});
const manyWeekdayAndWeekend = () => [
  ...Array.from({ length: 30 }, (_, index) => trip(index + 1, ["A역명", "B역명", "C역명", "디역"])),
  trip(100, ["D역명", "C역명", "B역명", "A역명"], { kind: "WEEKEND_HOLIDAY" }),
];

test("원천 정차 순서·시각을 그대로 trip·stop_times로 싣고, 별칭 역명을 팩 역으로 결속한다", () => {
  const result = materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend()) }));
  assert.equal(result.transitRoutes.length, 1);
  assert.equal(result.transitTrips.length, 31);
  const first = result.transitStopTimes.filter(({ tripId }) => tripId === result.transitTrips[0].id);
  assert.deepEqual(first.map(({ stationId }) => stationId), ["station-A", "station-B", "station-C", "station-D"]);
  // 원천 도착이 없는 기점은 출발 값을 두 칸에 쓴다(추정 시각을 만들지 않는다).
  assert.equal(first[0].arrivalSeconds, first[0].departureSeconds);
  assert.ok(result.transitTrips.every(({ sourceId, provenanceKind }) => sourceId === "official-source" && provenanceKind === "OFFICIAL_SOURCE"));
  assert.deepEqual(result.lineSummaries[0].tripsByServiceDayKind, { WEEKDAY: 30, WEEKEND_HOLIDAY: 1 });
});

test("trip_id는 짧고 결정적이며 원천 provider key마다 다르다", () => {
  const first = materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend().reverse()) }));
  // 독립 기대값: <접두>-<노선 키>-<운행일 코드>-sha256(provider key) 앞 12자.
  const expectedId = (key, code) => `of-x1-${code}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  const ids = new Set(first.transitTrips.map(({ id }) => id));
  assert.ok(ids.has(expectedId("X1:1", "w")) && ids.has(expectedId("X1:30", "w")) && ids.has(expectedId("X1:100", "e")));
  assert.ok(first.transitTrips.every(({ id }) => /^of-x1-[wshe]-[0-9a-f]{12}$/u.test(id)), "short trip id format");
  assert.equal(new Set(first.transitTrips.map(({ id }) => id)).size, first.transitTrips.length);
  // 원천 행 식별은 trip provenance에 남는다.
  assert.deepEqual(first.transitTrips.map(({ providerRecordHash }) => providerRecordHash).sort(), manyWeekdayAndWeekend().map(({ sourceRowSha256 }) => sourceRowSha256).sort());
});

test("원천이 한쪽 시각만 준 정차는 그 값을 정차 시각으로 쓰고 timeSource로 표기하며, 노선별 건수를 남긴다(#910 F4)", () => {
  const oneSided = { ...trip(500, ["A역명", "B역명", "C역명"]) };
  oneSided.stops = [
    { stationName: "A역명", arrivalSeconds: null, departureSeconds: 21_600 },
    { stationName: "B역명", arrivalSeconds: null, departureSeconds: 21_720 },
    { stationName: "C역명", arrivalSeconds: 21_840, departureSeconds: null },
  ];
  const result = materializeOfficialLineTimetables(args({ provider: provider([...manyWeekdayAndWeekend(), oneSided]) }));
  const tripId = result.transitTrips.find(({ providerRecordHash }) => providerRecordHash === oneSided.sourceRowSha256).id;
  const rows = result.transitStopTimes.filter((row) => row.tripId === tripId);
  assert.deepEqual(rows.map(({ arrivalSeconds, departureSeconds, timeSource }) => [arrivalSeconds, departureSeconds, timeSource]), [
    [21_600, 21_600, "SINGLE_PROVIDER_TIME_DEPARTURE"],
    [21_720, 21_720, "SINGLE_PROVIDER_TIME_DEPARTURE"],
    [21_840, 21_840, "SINGLE_PROVIDER_TIME_ARRIVAL"],
  ]);
  const both = result.transitStopTimes.find((row) => row.tripId !== tripId && row.stopSequence === 2);
  assert.equal(both.timeSource, "PROVIDER_ARRIVAL_AND_DEPARTURE");
  // 기본 trip 31개는 기점 출발만(31), 이 trip은 기점·중간·종점이 각각 하나씩 단일 시각이다.
  assert.deepEqual(result.lineSummaries[0].singleProviderTimeStopCount, { origin: 32, intermediate: 1, terminal: 1 });
  // 원천이 두 시각을 모두 주지 않은 정차는 적재하지 않고 실패한다.
  const empty = { ...trip(501, ["A역명", "B역명"]) };
  empty.stops = [{ stationName: "A역명", arrivalSeconds: null, departureSeconds: 21_600 }, { stationName: "B역명", arrivalSeconds: null, departureSeconds: null }];
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider([...manyWeekdayAndWeekend(), empty]) })), /OFFICIAL_LINE_TIMETABLE_STOP_WITHOUT_TIME/u);
});

test("평일 공휴일은 평일 운행에서 빼고 주말·공휴일 운행에 더한다", () => {
  const result = materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend()) }));
  const dates = result.serviceCalendarDates.map(({ serviceId, date, exceptionType }) => `${serviceId}|${date}|${exceptionType}`);
  // 2026-10-09(금)은 평일 공휴일, 2026-10-03(토)은 주말이라 주말 운행에 이미 있다.
  assert.deepEqual(dates.sort(), ["official-weekday|20261009|2", "official-weekend-holiday|20261009|1"]);
});

test("팩 역(별칭 포함)에 없는 원천 역명은 노선 적재를 실패시킨다", () => {
  const trips = [...manyWeekdayAndWeekend(), trip(200, ["A역명", "없는역"])];
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(trips) })), /STATION_UNMATCHED: line-x=\[없는역\]/u);
});

test("일반열차의 비인접 연속 정차는 격리하고, 급행은 노선 위상에서 도달 가능하면 싣는다", () => {
  const trips = [...manyWeekdayAndWeekend(), trip(300, ["A역명", "C역명"]), trip(301, ["A역명", "C역명", "D역명"], { pattern: "EXPRESS" })];
  const result = materializeOfficialLineTimetables(args({ provider: provider(trips) }));
  assert.deepEqual(result.quarantine.map(({ trainNumber, reason }) => `${trainNumber}:${reason}`), ["300:NON_ADJACENT_LOCAL_STOP"]);
  assert.ok(result.transitTrips.some(({ servicePattern }) => servicePattern === "EXPRESS"));
});

test("격리 뒤 노선 trip이 0건이거나 원천 운행일 종류에 적재 trip이 없으면 실패한다", () => {
  const quarantined = [{ sourceId: "official-source", lineId: "line-x", routeKey: "X1", trainNumber: "9", serviceDayKind: "WEEKDAY", sourceRowSha256: ROW(9), reason: "TIME_NOT_MONOTONIC" }];
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider([], quarantined), maxQuarantineRatio: 0.99 })), /LINE_HAS_NO_TRIPS: line-x X1/u);
  const weekendOnlyQuarantined = [{ ...quarantined[0], serviceDayKind: "WEEKEND_HOLIDAY" }];
  const weekdays = Array.from({ length: 30 }, (_, index) => trip(index + 1, ["A역명", "B역명"]));
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(weekdays, weekendOnlyQuarantined) })), /SERVICE_DAY_HAS_NO_TRIPS: line-x WEEKEND_HOLIDAY/u);
});

test("노선 격리 비율이 상한을 넘으면 실패한다", () => {
  const trips = [...manyWeekdayAndWeekend(), trip(400, ["A역명", "C역명"]), trip(401, ["B역명", "D역명"])];
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(trips) })), /LINE_QUARANTINE_RATIO_EXCEEDED: line-x X1 2\/33 > 0.05/u);
});

test("고정 격리 집합은 사유·건수·행 집합이 정확히 같을 때만 상한에서 빠지고, 다르면 실패한다", () => {
  const damaged = Array.from({ length: 10 }, (_, index) => ({
    sourceId: "official-source", lineId: "line-x", routeKey: "X1", trainNumber: `d${index}`, serviceDayKind: "WEEKDAY",
    sourceRowSha256: ROW(1000 + index), reason: "TIME_NOT_MONOTONIC",
  }));
  const allowance = { reason: "TIME_NOT_MONOTONIC", rowCount: 10, rowSetSha256: quarantineRowSetSha256(damaged), note: "원천 손상 행" };
  const binding = { ...BINDING, quarantineAllowance: allowance };
  const result = materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend(), damaged), lineBindings: [binding] }));
  assert.equal(result.lineSummaries[0].quarantinedTripCount, 10);
  assert.equal(result.lineSummaries[0].pinnedQuarantine.rowCount, 10);

  // 원천이 바뀌어 손상 행이 하나 늘면 고정 집합과 달라 실패한다.
  const grown = [...damaged, { ...damaged[0], trainNumber: "d10", sourceRowSha256: ROW(2000) }];
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend(), grown), lineBindings: [binding] })),
    /QUARANTINE_ALLOWANCE_MISMATCH: line-x X1 TIME_NOT_MONOTONIC 11\/10/u);
  // 고정 집합 밖의 다른 사유 격리는 일반 상한을 그대로 적용한다.
  const extra = [...manyWeekdayAndWeekend(), trip(500, ["A역명", "C역명"]), trip(501, ["B역명", "D역명"])];
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(extra, damaged), lineBindings: [binding] })),
    /LINE_QUARANTINE_RATIO_EXCEEDED: line-x X1 2\/33 > 0.05/u);
});

test("고정 격리 집합은 건수가 같아도 행 하나가 다르면, 행 집합이 같아도 고정 건수가 다르면 각각 실패한다(#910 F1)", () => {
  const damaged = Array.from({ length: 10 }, (_, index) => ({
    sourceId: "official-source", lineId: "line-x", routeKey: "X1", trainNumber: `d${index}`, serviceDayKind: "WEEKDAY",
    sourceRowSha256: ROW(1000 + index), reason: "TIME_NOT_MONOTONIC",
  }));
  const allowance = { reason: "TIME_NOT_MONOTONIC", rowCount: 10, rowSetSha256: quarantineRowSetSha256(damaged), note: "원천 손상 행" };
  // 건수 10은 그대로이고 행 하나만 다른 원천 행으로 바뀐다(행 집합 hash만 달라진다).
  const swapped = [...damaged.slice(0, 9), { ...damaged[9], sourceRowSha256: ROW(3000) }];
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend(), swapped), lineBindings: [{ ...BINDING, quarantineAllowance: allowance }] })),
    /QUARANTINE_ALLOWANCE_MISMATCH: line-x X1 TIME_NOT_MONOTONIC 10\/10/u);
  // 행 집합은 고정 hash와 같고 고정 건수만 다르다(건수만 달라진다).
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend(), damaged), lineBindings: [{ ...BINDING, quarantineAllowance: { ...allowance, rowCount: 11 } }] })),
    /QUARANTINE_ALLOWANCE_MISMATCH: line-x X1 TIME_NOT_MONOTONIC 10\/11/u);
});

test("서로 다른 원천 행이 같은 짧은 trip_id로 모이면 TRIP_ID_COLLISION으로 실패한다(#910 F3)", () => {
  const trips = manyWeekdayAndWeekend();
  // 같은 provider key(=같은 짧은 trip_id)를 가진 다른 원천 행
  const twin = { ...trip(999, ["A역명", "B역명"]), providerTripKey: trips[0].providerTripKey };
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider([...trips, twin]) })),
    new RegExp(`OFFICIAL_LINE_TIMETABLE_TRIP_ID_COLLISION: of-x1-w-${createHash("sha256").update(trips[0].providerTripKey).digest("hex").slice(0, 12)}`, "u"));
});

test("별칭이 실제 역명을 가리거나 대상 역이 노선에 없으면 실패한다", () => {
  const shadow = { ...BINDING, stationAliases: { A역명: { nameKo: "B역명", reason: "x" } } };
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend()), lineBindings: [shadow] })), /ALIAS_SHADOWS_STATION/u);
  const missing = { ...BINDING, stationAliases: { 디역: { nameKo: "Z역명", reason: "x" } } };
  assert.throws(() => materializeOfficialLineTimetables(args({ provider: provider(manyWeekdayAndWeekend()), lineBindings: [missing] })), /ALIAS_TARGET_MISSING/u);
});
