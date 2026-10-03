import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  KORAIL_EXPRESS_ALLOWANCE,
  kricKorailOfficialTimetable,
  projectKricKorailTimetableSnapshot,
  validateKricKorailTimetableSnapshot,
} from "./kric-korail-timetable.mjs";
import { KORAIL_STATION_ROW_BINDINGS } from "./kric-station-row-timetable-trips.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return String((h * 3600 + m * 60) / 86400); };
let row = 100;
function trip(routeNumber, trainNumber, weekdayType, stops, serviceType = "일반") {
  const { routeName } = KORAIL_STATION_ROW_BINDINGS.find((entry) => entry.routeNumber === routeNumber) ?? { routeName: "경부선" };
  return stops.map(([stationName, time]) => ({
    trainNumber, routeNumber, routeName, originStationName: stops[0][0], destinationStationName: stops.at(-1)[0], serviceType, weekdayType,
    stationName, arrivalTime: { value: clock(time), cellType: "n", styleId: 1 }, departureTime: { value: clock(time), cellType: "n", styleId: 1 },
    dataReferenceDate: { value: "46173", cellType: "n", styleId: 2 }, sourceRowNumber: row++, sourceRowSha256: sha(`${routeNumber}${trainNumber}${weekdayType}${stationName}`),
  }));
}
function observation(extra = []) {
  const records = KORAIL_STATION_ROW_BINDINGS.flatMap(({ routeNumber }) => [
    ...trip(routeNumber, `${routeNumber}-1`, "평일", [["가역", "06:00"], ["나역", "06:03"]]),
    ...trip(routeNumber, `${routeNumber}-2`, "휴일", [["나역", "07:00"], ["가역", "07:03"]]),
  ]);
  return { artifactKind: "kric-nationwide-timetable-observation", sourceId: "kric-nationwide-timetable-file", rawSha256: "a".repeat(64),
    recordsSha256: "b".repeat(64), rawByteLength: 10, observedAt: "2026-10-03T00:00:00.000Z", records: [...records, ...extra].reverse() };
}

test("관측에서 코레일 6개 노선 행만 원문 그대로 골라 결정적 snapshot을 만든다", () => {
  const other = trip("I4101", "K1701", "평일", [["동대구", "06:00"], ["경산", "06:10"]]);
  const observed = observation(other);
  const snapshot = projectKricKorailTimetableSnapshot(observed);
  assert.equal(snapshot.records.some(({ routeNumber }) => routeNumber === "I4101"), false);
  assert.equal(snapshot.recordCount, 24);
  assert.deepEqual(snapshot.records.map(({ sourceRowNumber }) => sourceRowNumber), [...snapshot.records.map(({ sourceRowNumber }) => sourceRowNumber)].sort((a, b) => a - b));
  assert.deepEqual(snapshot.records[0].arrivalTime, { cellType: "n", value: clock("06:00") });
  assert.match(snapshot.snapshotId, /^kric-nationwide-timetable-file-korail-[a-f0-9]{64}$/u);
  assert.deepEqual(projectKricKorailTimetableSnapshot(structuredClone(observed)), snapshot);
  validateKricKorailTimetableSnapshot(snapshot);
  assert.throws(() => validateKricKorailTimetableSnapshot({ ...snapshot, records: snapshot.records.slice(1) }), /SNAPSHOT_HASH/u);
  const missing = observation();
  missing.records = missing.records.filter(({ routeNumber }) => routeNumber !== "I26K6");
  assert.throws(() => projectKricKorailTimetableSnapshot(missing), /ROUTE_MISSING: I26K6/u);
});

test("공용 적재기 입력으로 바꿀 때 휴일은 WEEKEND_HOLIDAY, alias는 근거를 함께, 급행은 고정 집합 격리 행이 된다", () => {
  const express = trip("I28K1", "K6401", "평일", [["가역", "08:00"], ["나역", "08:02"]], "급행");
  const snapshot = projectKricKorailTimetableSnapshot(observation(express));
  const unpinned = Object.fromEntries(KORAIL_STATION_ROW_BINDINGS.map(({ routeNumber }) => [routeNumber, undefined]));
  const expressBindings = KORAIL_STATION_ROW_BINDINGS.map((entry) => ({ ...entry,
    expressQuarantine: entry.routeNumber === "I28K1" ? { rowCount: 2, rowSetSha256: createHash("sha256").update(JSON.stringify(express.map(({ sourceRowSha256 }) => sourceRowSha256).sort())).digest("hex") } : { rowCount: 0, rowSetSha256: sha("[]") } }));
  // 고정 바인딩의 급행 집합(실측)과 합성 입력은 다르므로, 변환만 검사하려고 바인딩 고정값을 합성 입력에 맞춘 사본을 쓴다.
  const { provider, lineBindings, expressRowSetSha256ByRoute } = kricKorailOfficialTimetable(snapshot, { observedAt: "2026-10-03T00:00:00.000Z", allowance: unpinned, bindings: expressBindings });
  const holiday = provider.trips.find(({ trainNumber }) => trainNumber === "I41WS-2");
  assert.equal(holiday.serviceDayKind, "WEEKEND_HOLIDAY");
  assert.equal(holiday.routeKey, "I41WS");
  assert.equal(holiday.sourceDayKey, "휴일");
  assert.deepEqual(provider.quarantine.map(({ routeKey, trainNumber, serviceDayKind, reason }) => [routeKey, trainNumber, serviceDayKind, reason]),
    [["I28K1", "K6401", "WEEKDAY", "EXPRESS_STOP_PATTERN_UNRESOLVED"]]);
  assert.match(expressRowSetSha256ByRoute.I28K1, /^[a-f0-9]{64}$/u);
  const seohae = lineBindings.find(({ routeKey }) => routeKey === "I41WS");
  assert.deepEqual(seohae.stationAliases["신김포"], { nameKo: "김포공항", reason: seohae.stationAliases["신김포"].reason });
  assert.match(seohae.stationAliases["신김포"].reason, /^KRIC 파일 900 코레일 행의 역명 칸 축약 표기: /u);
  assert.equal(lineBindings.some(({ quarantineAllowance }) => quarantineAllowance), false);
  assert.deepEqual(provider.dataReferenceDateByLine["line-051552e50435"], ["2026-05-31"]);
  assert.throws(() => kricKorailOfficialTimetable(snapshot, { observedAt: "2026-10-03" , bindings: expressBindings }), /OBSERVED_AT/u);
});

test("급행 고정 집합은 실측(원천 sha256 218f76dd…) 경춘 5·수인분당 22·경의중앙 28 trip으로 고정한다", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(KORAIL_EXPRESS_ALLOWANCE).map(([key, { rowCount, rowSetSha256 }]) => [key, [rowCount, rowSetSha256]])), {
    I41K2: [5, "5934643bec13e0cd32aeb7c2ce8300478699abaa6a55da1fd49960a0da0b30a3"],
    I28K1: [22, "e21e4cd62f74db32c0fa2b01813fe18f671d08ffc2cba86c2eb3c3e88f5e9f79"],
    I4108: [28, "f4efb4e31fc9ebb2cb7c3e0ef14292b52ca8addbde5589ca99e5fc5d2755dee9"],
  });
});
