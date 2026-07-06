import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeKricSubwayTimetable } from "./normalize-kric-timetable.mjs";
import { reconstructTransitTrips } from "./reconstruct-transit-trips.mjs";

const hms = (h, m, s = 0) => h * 3600 + m * 60 + s;

// KRIC trainUseInfo/subwayTimetable 실응답 body 행(라이브 스파이크 캡처, 사당 4호선 S1)
const KRIC_ROWS = [
  { railOprIsttCd: "S1", trnNo: "4719", dayCd: "8", dayNm: "평일", stinCd: "433", lnCd: "4", arvTm: "084830", dptTm: "084900" }, // through
  { railOprIsttCd: "S1", trnNo: "4236", dayCd: "8", dayNm: "평일", stinCd: "433", lnCd: "4", arvTm: null, dptTm: "092400" }, // 시발(도착 없음)
  { railOprIsttCd: "S1", trnNo: "4227", dayCd: "8", dayNm: "평일", stinCd: "433", lnCd: "4", arvTm: "085330", dptTm: null }, // 종착(출발 없음)
];

const CONTEXT = {
  stationIdByProviderStation: { "S1|4|433": "station-sadang", "S1|4|432": "station-sadang-next" },
  lineIdByProviderLine: { "S1|4": "seoul-4" },
};

test("KRIC normalizer는 응답 행을 재구성 코어의 중간 행 계약으로 정규화한다", () => {
  const rows = normalizeKricSubwayTimetable(KRIC_ROWS, CONTEXT);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    stationId: "station-sadang",
    lineId: "seoul-4",
    trnNo: "4719",
    dayCd: "8",
    arrivalSeconds: hms(8, 48, 30),
    departureSeconds: hms(8, 49, 0),
    servicePattern: "LOCAL",
  });
});

test("KRIC normalizer는 시발(arvTm null)·종착(dptTm null)을 도착=출발로 처리한다", () => {
  const rows = normalizeKricSubwayTimetable(KRIC_ROWS, CONTEXT);
  const origin = rows.find((r) => r.trnNo === "4236");
  assert.equal(origin.arrivalSeconds, hms(9, 24, 0));
  assert.equal(origin.departureSeconds, hms(9, 24, 0));
  const terminal = rows.find((r) => r.trnNo === "4227");
  assert.equal(terminal.arrivalSeconds, hms(8, 53, 30));
  assert.equal(terminal.departureSeconds, hms(8, 53, 30));
});

test("KRIC normalizer는 arvTm·dptTm이 모두 없으면 그 행을 버린다", () => {
  const rows = normalizeKricSubwayTimetable(
    [{ railOprIsttCd: "S1", trnNo: "9999", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: null, dptTm: null }],
    CONTEXT,
  );
  assert.equal(rows.length, 0);
});

test("KRIC normalizer는 canonical station 매핑이 없으면 거부한다", () => {
  assert.throws(
    () => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], stinCd: "999" }], CONTEXT),
    /no canonical station for S1\|4\|999/,
  );
});

test("KRIC normalizer는 servicePattern override(급행)를 반영한다", () => {
  const rows = normalizeKricSubwayTimetable(KRIC_ROWS, { ...CONTEXT, servicePattern: "EXPRESS" });
  assert.ok(rows.every((r) => r.servicePattern === "EXPRESS"));
});

test("KRIC normalizer 출력은 재구성 코어에 그대로 투입돼 trip을 만든다(가드레일 1 합성)", () => {
  const kricTwoStops = [
    { railOprIsttCd: "S1", trnNo: "4719", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "084830", dptTm: "084900" },
    { railOprIsttCd: "S1", trnNo: "4719", dayCd: "8", stinCd: "432", lnCd: "4", arvTm: "085030", dptTm: "085100" },
  ];
  const intermediate = normalizeKricSubwayTimetable(kricTwoStops, CONTEXT);
  const { transitTrips, transitStopTimes } = reconstructTransitTrips(intermediate, {
    lineSequenceByStationLine: { "station-sadang|seoul-4": 28, "station-sadang-next|seoul-4": 29 },
    routeIdByLineDirection: { "seoul-4|up": "route-seoul-4-oido" },
    serviceIdByDayCd: { "8": "weekday-2026" },
  });
  assert.equal(transitTrips.length, 1);
  assert.equal(transitTrips[0].serviceId, "weekday-2026");
  assert.equal(transitStopTimes.length, 2);
});

test("KRIC normalizer는 잘못된 시각 포맷·범위·필수 필드·context 누락을 거부한다", () => {
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], arvTm: "8:48" }], CONTEXT), /time must be HHMMSS/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], dptTm: "306000" }], CONTEXT), /time out of range/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], trnNo: "" }], CONTEXT), /trnNo must be a non-empty string/);
  assert.throws(() => normalizeKricSubwayTimetable([{ ...KRIC_ROWS[0], dayCd: "" }], CONTEXT), /dayCd must be a non-empty string/);
  assert.throws(() => normalizeKricSubwayTimetable(KRIC_ROWS, { ...CONTEXT, lineIdByProviderLine: null }), /context.lineIdByProviderLine is required/);
});

test("KRIC normalizer는 context를 Map으로도 받는다", () => {
  const rows = normalizeKricSubwayTimetable([KRIC_ROWS[0]], {
    stationIdByProviderStation: new Map([["S1|4|433", "station-sadang"]]),
    lineIdByProviderLine: new Map([["S1|4", "seoul-4"]]),
  });
  assert.equal(rows[0].stationId, "station-sadang");
});

test("KRIC normalizer는 자정 넘김(3시 미만) 시각에 +24h를 적용해 도착<=출발을 유지한다", () => {
  // 오남 실데이터: 23:59:30 도착 → 00:00:00 출발(자정 넘김)
  const rows = normalizeKricSubwayTimetable(
    [{ railOprIsttCd: "S1", trnNo: "S4224", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "235930", dptTm: "000000" }],
    CONTEXT,
  );
  const hms = (h, m, s = 0) => h * 3600 + m * 60 + s;
  assert.equal(rows[0].arrivalSeconds, hms(23, 59, 30)); // 그대로
  assert.equal(rows[0].departureSeconds, hms(24, 0, 0)); // 00:00 → 24:00
  assert.ok(rows[0].arrivalSeconds <= rows[0].departureSeconds);
});

test("KRIC normalizer는 row별 exptCd로 급행/일반 servicePattern을 도출한다", () => {
  const rows = normalizeKricSubwayTimetable(
    [
      { railOprIsttCd: "S1", trnNo: "E1", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "084830", dptTm: "084900", exptCd: "1" },
      { railOprIsttCd: "S1", trnNo: "L1", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "085830", dptTm: "085900", exptCd: null },
    ],
    CONTEXT,
  );
  assert.equal(rows.find((r) => r.trnNo === "E1").servicePattern, "EXPRESS");
  assert.equal(rows.find((r) => r.trnNo === "L1").servicePattern, "LOCAL");
});

test("KRIC normalizer는 공백(' ') 시각을 미제공(null)으로 처리한다", () => {
  // 불암산 K4534 실데이터: dptTm=" "(공백) → 종착으로 보고 출발=도착
  const rows = normalizeKricSubwayTimetable(
    [{ railOprIsttCd: "S1", trnNo: "K4534", dayCd: "8", stinCd: "433", lnCd: "4", arvTm: "085330", dptTm: " " }],
    CONTEXT,
  );
  const hms = (h, m, s = 0) => h * 3600 + m * 60 + s;
  assert.equal(rows[0].arrivalSeconds, hms(8, 53, 30));
  assert.equal(rows[0].departureSeconds, hms(8, 53, 30));
});
