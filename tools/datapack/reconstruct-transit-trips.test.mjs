import assert from "node:assert/strict";
import { test } from "node:test";
import { reconstructTransitTrips } from "./reconstruct-transit-trips.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

// 4호선 pilot 축약 lineSequence (오이도 방면으로 갈수록 큰 값)
const LINE_SEQUENCE = {
  "station-sadang|seoul-4": 28,
  "station-oido|seoul-4": 47,
  "station-sangnoksu|seoul-4": 43,
  "station-geumjeong|seoul-4": 35,
};

const CONTEXT = {
  lineSequenceByStationLine: LINE_SEQUENCE,
  routeIdByLineDirection: {
    "seoul-4|up": "route-seoul-4-oido",
    "seoul-4|down": "route-seoul-4-danggogae",
  },
  serviceIdByDayCd: { "01": "weekday-2026", "02": "saturday-2026", "03": "holiday-2026" },
};

// ground-truth trip → station-level 중간 행으로 사영(trip 구조 제거)
function projectTripToRows(trip) {
  return trip.stops.map((stop) => ({
    stationId: stop.stationId,
    lineId: "seoul-4",
    trnNo: trip.trnNo,
    dayCd: trip.dayCd,
    arrivalSeconds: stop.arrivalSeconds,
    departureSeconds: stop.departureSeconds,
    servicePattern: trip.servicePattern,
  }));
}

test("재구성은 (trnNo,dayCd) group-by로 station 행에서 trip과 stop_times를 복원한다", () => {
  // upbound: sadang(28) → geumjeong(35) → sangnoksu(43) 시각 증가
  const trips = [
    {
      trnNo: "K4501",
      dayCd: "01",
      servicePattern: "LOCAL",
      stops: [
        { stationId: "station-sadang", arrivalSeconds: 30000, departureSeconds: 30000 },
        { stationId: "station-geumjeong", arrivalSeconds: 30600, departureSeconds: 30630 },
        { stationId: "station-sangnoksu", arrivalSeconds: 31200, departureSeconds: 31200 },
      ],
    },
  ];
  const rows = trips.flatMap(projectTripToRows);
  // 입력 순서에 의존하지 않음을 보이려 역순으로
  rows.reverse();

  const { transitTrips, transitStopTimes } = reconstructTransitTrips(rows, CONTEXT);

  assert.equal(transitTrips.length, 1);
  const trip = transitTrips[0];
  assert.equal(trip.routeId, "route-seoul-4-oido");
  assert.equal(trip.serviceId, "weekday-2026");
  assert.equal(trip.directionId, "up");
  assert.equal(trip.tripHeadsign, "station-sangnoksu");
  assert.equal(trip.servicePattern, "LOCAL");

  const stops = transitStopTimes.filter((s) => s.tripId === trip.id);
  assert.deepEqual(
    stops.map((s) => [s.stopSequence, s.stationId, s.arrivalSeconds, s.departureSeconds]),
    [
      [1, "station-sadang", 30000, 30000],
      [2, "station-geumjeong", 30600, 30630],
      [3, "station-sangnoksu", 31200, 31200],
    ],
  );
});

test("재구성은 lineSequence 감소 방향을 down으로 도출한다", () => {
  const rows = [
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "K4502", dayCd: "01", arrivalSeconds: 40000, departureSeconds: 40000 },
    { stationId: "station-geumjeong", lineId: "seoul-4", trnNo: "K4502", dayCd: "01", arrivalSeconds: 40600, departureSeconds: 40630 },
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "K4502", dayCd: "01", arrivalSeconds: 41200, departureSeconds: 41200 },
  ];
  const { transitTrips } = reconstructTransitTrips(rows, CONTEXT);
  assert.equal(transitTrips[0].directionId, "down");
  assert.equal(transitTrips[0].routeId, "route-seoul-4-danggogae");
  assert.equal(transitTrips[0].tripHeadsign, "station-sadang");
});

test("재구성은 dayCd(평일/토/휴일)를 별도 trip과 serviceId로 분리한다", () => {
  const rows = ["01", "02", "03"].flatMap((dayCd) => [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "K4600", dayCd, arrivalSeconds: 30000, departureSeconds: 30000 },
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "K4600", dayCd, arrivalSeconds: 31200, departureSeconds: 31200 },
  ]);
  const { transitTrips } = reconstructTransitTrips(rows, CONTEXT);
  assert.equal(transitTrips.length, 3);
  assert.deepEqual(
    transitTrips.map((t) => t.serviceId).sort((left, right) => codepointCompare(left, right)),
    ["holiday-2026", "saturday-2026", "weekday-2026"],
  );
});

test("재구성은 급행(정차역 skip)을 단조 유지로 허용하고 servicePattern을 보존한다", () => {
  // sadang(28) → sangnoksu(43): geumjeong(35) 통과 — 여전히 단조 증가
  const rows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "X4701", dayCd: "01", arrivalSeconds: 50000, departureSeconds: 50000, servicePattern: "EXPRESS" },
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "X4701", dayCd: "01", arrivalSeconds: 50900, departureSeconds: 50900, servicePattern: "EXPRESS" },
  ];
  const { transitTrips, transitStopTimes } = reconstructTransitTrips(rows, CONTEXT);
  assert.equal(transitTrips[0].servicePattern, "EXPRESS");
  assert.equal(transitStopTimes.length, 2);
});

test("재구성은 lineSequence 비단조(zigzag) trip을 거부한다", () => {
  // 시각순 sadang(28) → sangnoksu(43) → geumjeong(35): 마지막에 감소 → 비단조
  const rows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "Z4801", dayCd: "01", arrivalSeconds: 60000, departureSeconds: 60000 },
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "Z4801", dayCd: "01", arrivalSeconds: 60600, departureSeconds: 60600 },
    { stationId: "station-geumjeong", lineId: "seoul-4", trnNo: "Z4801", dayCd: "01", arrivalSeconds: 61200, departureSeconds: 61200 },
  ];
  assert.throws(
    () => reconstructTransitTrips(rows, CONTEXT),
    /stop order must follow station lineSequence/,
  );
});

test("재구성은 정차가 1개뿐인 group을 거부한다", () => {
  const rows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "S4901", dayCd: "01", arrivalSeconds: 30000, departureSeconds: 30000 },
  ];
  assert.throws(() => reconstructTransitTrips(rows, CONTEXT), /at least 2 stops/);
});

test("재구성은 인접 정차의 lineSequence가 같으면 거부한다", () => {
  const ctx = {
    ...CONTEXT,
    lineSequenceByStationLine: { ...LINE_SEQUENCE, "station-dup|seoul-4": 28 },
  };
  const rows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "D4001", dayCd: "01", arrivalSeconds: 30000, departureSeconds: 30000 },
    { stationId: "station-dup", lineId: "seoul-4", trnNo: "D4001", dayCd: "01", arrivalSeconds: 30600, departureSeconds: 30600 },
  ];
  assert.throws(() => reconstructTransitTrips(rows, ctx), /lineSequence must change/);
});

test("재구성은 다른 노선의 동일 trnNo+dayCd를 별도 trip으로 분리한다(lineId 키)", () => {
  const ctx = {
    lineSequenceByStationLine: {
      "station-sadang|seoul-4": 28,
      "station-sangnoksu|seoul-4": 43,
      "station-a|seoul-2": 1,
      "station-b|seoul-2": 2,
    },
    routeIdByLineDirection: {
      "seoul-4|up": "route-seoul-4-oido",
      "seoul-2|up": "route-seoul-2-inner",
    },
    serviceIdByDayCd: { "01": "weekday-2026" },
  };
  const rows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "100", dayCd: "01", arrivalSeconds: 30000, departureSeconds: 30000 },
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "100", dayCd: "01", arrivalSeconds: 31200, departureSeconds: 31200 },
    { stationId: "station-a", lineId: "seoul-2", trnNo: "100", dayCd: "01", arrivalSeconds: 30000, departureSeconds: 30000 },
    { stationId: "station-b", lineId: "seoul-2", trnNo: "100", dayCd: "01", arrivalSeconds: 30300, departureSeconds: 30300 },
  ];
  const { transitTrips } = reconstructTransitTrips(rows, ctx);
  assert.equal(transitTrips.length, 2);
  assert.deepEqual(
    transitTrips.map((t) => t.routeId).sort((left, right) => codepointCompare(left, right)),
    ["route-seoul-2-inner", "route-seoul-4-oido"],
  );
});

test("재구성은 한 trip 안에서 servicePattern이 섞이면 거부한다(결정성 계약)", () => {
  const rows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "M100", dayCd: "01", arrivalSeconds: 30000, departureSeconds: 30000, servicePattern: "LOCAL" },
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "M100", dayCd: "01", arrivalSeconds: 31200, departureSeconds: 31200, servicePattern: "EXPRESS" },
  ];
  assert.throws(() => reconstructTransitTrips(rows, CONTEXT), /inconsistent servicePattern/);
});

test("재구성은 필수 필드 누락·잘못된 시각·arr>dep 행을 거부한다", () => {
  const base = { stationId: "station-sadang", lineId: "seoul-4", trnNo: "E1", dayCd: "01", arrivalSeconds: 30000, departureSeconds: 30000 };
  assert.throws(() => reconstructTransitTrips([{ ...base, stationId: "" }], CONTEXT), /missing field stationId/);
  assert.throws(() => reconstructTransitTrips([{ ...base, arrivalSeconds: -1 }], CONTEXT), /arrivalSeconds must be a non-negative integer/);
  assert.throws(() => reconstructTransitTrips([{ ...base, arrivalSeconds: 31000, departureSeconds: 30000 }], CONTEXT), /arrivalSeconds must be <= departureSeconds/);
});

test("재구성은 lineSequence·route·serviceId 매핑이 없으면 거부한다", () => {
  const rows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "E2", dayCd: "01", arrivalSeconds: 30000, departureSeconds: 30000 },
    { stationId: "station-unknown", lineId: "seoul-4", trnNo: "E2", dayCd: "01", arrivalSeconds: 31000, departureSeconds: 31000 },
  ];
  assert.throws(() => reconstructTransitTrips(rows, CONTEXT), /unknown lineSequence for station-unknown/);

  const upOnly = { ...CONTEXT, routeIdByLineDirection: { "seoul-4|up": "route-seoul-4-oido" } };
  const downRows = [
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "E3", dayCd: "01", arrivalSeconds: 40000, departureSeconds: 40000 },
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "E3", dayCd: "01", arrivalSeconds: 41000, departureSeconds: 41000 },
  ];
  assert.throws(() => reconstructTransitTrips(downRows, upOnly), /no route mapping for seoul-4\|down/);

  const noService = { ...CONTEXT, serviceIdByDayCd: { "01": "weekday-2026" } };
  const satRows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "E4", dayCd: "02", arrivalSeconds: 30000, departureSeconds: 30000 },
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "E4", dayCd: "02", arrivalSeconds: 31000, departureSeconds: 31000 },
  ];
  assert.throws(() => reconstructTransitTrips(satRows, noService), /no serviceId mapping for 02/);
});

test("재구성 context는 Map도 허용하고, 누락되면 거부한다", () => {
  const rows = [
    { stationId: "station-sadang", lineId: "seoul-4", trnNo: "E5", dayCd: "01", arrivalSeconds: 30000, departureSeconds: 30000 },
    { stationId: "station-sangnoksu", lineId: "seoul-4", trnNo: "E5", dayCd: "01", arrivalSeconds: 31000, departureSeconds: 31000 },
  ];
  const mapCtx = {
    lineSequenceByStationLine: new Map([["station-sadang|seoul-4", 28], ["station-sangnoksu|seoul-4", 43]]),
    routeIdByLineDirection: new Map([["seoul-4|up", "route-seoul-4-oido"]]),
    serviceIdByDayCd: new Map([["01", "weekday-2026"]]),
  };
  const { transitTrips } = reconstructTransitTrips(rows, mapCtx);
  assert.equal(transitTrips[0].routeId, "route-seoul-4-oido");

  assert.throws(() => reconstructTransitTrips(rows, { ...CONTEXT, serviceIdByDayCd: null }), /context.serviceIdByDayCd is required/);
});
