import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeKricSubwayTimetable } from "./normalize-kric-timetable.mjs";
import { reconstructTransitTrips } from "./reconstruct-transit-trips.mjs";

const hms = (h, m, s = 0) => h * 3600 + m * 60 + s;
const CONTEXT = {
  stationIdByProviderStation: { "S1|4|433": "station-sadang", "S1|4|432": "station-sadang-next" },
  lineIdByProviderLine: { "S1|4": "seoul-4" },
  servicePatternByExptCd: { LOCAL: "LOCAL", EXPRESS: "EXPRESS" },
};
const KRIC_ROWS = [
  { railOprIsttCd: "S1", trnNo: "4719", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "084830", dptTm: "084900", exptCd: "LOCAL" },
  { railOprIsttCd: "S1", trnNo: "4236", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: null, dptTm: "092400", exptCd: "LOCAL" },
  { railOprIsttCd: "S1", trnNo: "4227", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "085330", dptTm: null, exptCd: "LOCAL" },
];

test("KRIC normalizer는 행을 명시적 서비스·정차 역할 계약으로 정규화한다", () => {
  const rows = normalizeKricSubwayTimetable(KRIC_ROWS, CONTEXT);
  assert.deepEqual(rows[0], {
    stationId: "station-sadang", lineId: "seoul-4", trnNo: "4719", dayCd: "8",
    arrivalSeconds: hms(8, 48, 30), departureSeconds: hms(8, 49),
    stopRole: "THROUGH", servicePattern: "LOCAL",
  });
  assert.deepEqual(rows.slice(1).map(({ arrivalSeconds, departureSeconds, stopRole }) => [arrivalSeconds, departureSeconds, stopRole]), [
    [null, hms(9, 24), "ORIGIN"],
    [hms(8, 53, 30), null, "TERMINAL"],
  ]);
});

test("KRIC normalizer는 양쪽 시각 누락·빈 입력을 명시적으로 거부한다", () => {
  assert.throws(() => normalizeKricSubwayTimetable([], CONTEXT), /kricRows must be a non-empty array/);
  assert.throws(() => normalizeKricSubwayTimetable(null, CONTEXT), /kricRows must be a non-empty array/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], arvTm: null, dptTm: null }], CONTEXT), /both arrivalSeconds and departureSeconds are missing/);
});

test("KRIC normalizer는 닫힌 caller mapping 외 exptCd를 추정하지 않는다", () => {
  const express = normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], exptCd: "EXPRESS" }], CONTEXT);
  assert.equal(express[0].servicePattern, "EXPRESS");
  for (const code of [null, " ", "UNKNOWN", "0", "1"]) {
    assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], exptCd: code }], CONTEXT));
  }
  assert.throws(() => normalizeKricSubwayTimetable(KRIC_ROWS, { ...CONTEXT, servicePatternByExptCd: null }), /context.servicePatternByExptCd is required/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], exptCd: "LOCAL" }], { ...CONTEXT, servicePatternByExptCd: { LOCAL: "BEST" } }), /invalid servicePattern mapping/);
  assert.throws(
    () => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], exptCd: "LOCAL" }], { ...CONTEXT, servicePatternByExptCd: { LOCAL: "LOCAL", EXPRESS: "BEST" } }),
    /invalid servicePattern mapping/,
  );
  assert.throws(
    () => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], exptCd: "LOCAL" }], { ...CONTEXT, servicePatternByExptCd: { " ": "LOCAL" } }),
    /invalid servicePattern mapping key/,
  );
});

test("KRIC normalizer는 canonical mapping과 입력 형식을 fail closed한다", () => {
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], stinCd: "999" }], CONTEXT), /no canonical station/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], arvTm: "8:48" }], CONTEXT), /time must be HHMMSS/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], dptTm: "306000" }], CONTEXT), /time out of range/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], trnNo: "" }], CONTEXT), /trnNo must be a non-empty string/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], dayCd: "" }], CONTEXT), /dayCd must be a non-empty string/);
  assert.throws(() => normalizeKricSubwayTimetable(KRIC_ROWS, { ...CONTEXT, lineIdByProviderLine: null }), /context.lineIdByProviderLine is required/);
});

test("KRIC normalizer는 Map mapping도 닫힌 context로 받는다", () => {
  const [row] = normalizeKricSubwayTimetable([KRIC_ROWS[0]], {
    stationIdByProviderStation: new Map([["S1|4|433", "station-sadang"]]),
    lineIdByProviderLine: new Map([["S1|4", "seoul-4"]]),
    servicePatternByExptCd: new Map([["LOCAL", "LOCAL"]]),
  });
  assert.equal(row.stationId, "station-sadang");
});

test("KRIC normalizer는 자정 넘김을 유지하고 공백 시각을 null 종착으로 보존한다", () => {
  const [midnight] = normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], arvTm: "235930", dptTm: "000000" }], CONTEXT);
  assert.equal(midnight.arrivalSeconds, hms(23, 59, 30));
  assert.equal(midnight.departureSeconds, hms(24, 0));
  const [terminal] = normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], arvTm: "085330", dptTm: " " }], CONTEXT);
  assert.deepEqual([terminal.arrivalSeconds, terminal.departureSeconds, terminal.stopRole], [hms(8, 53, 30), null, "TERMINAL"]);
});

test("KRIC normalizer 출력은 explicit servicePattern으로 재구성 코어에 연결된다", () => {
  const rows = normalizeKricSubwayTimetable([
    { ...KRIC_ROWS[0], stinCd: "433", arvTm: "084830", dptTm: "084900" },
    { ...KRIC_ROWS[0], stinCd: "432", arvTm: "085030", dptTm: "085100" },
  ], CONTEXT);
  const { transitTrips, transitStopTimes } = reconstructTransitTrips(rows, {
    lineSequenceByStationLine: { "station-sadang|seoul-4": 28, "station-sadang-next|seoul-4": 29 },
    routeIdByLineDirection: { "seoul-4|up": "route-seoul-4-oido" }, serviceIdByDayCd: { "8": "weekday-2026" },
  });
  assert.equal(transitTrips[0].servicePattern, "LOCAL");
  assert.equal(transitStopTimes.length, 2);
});
