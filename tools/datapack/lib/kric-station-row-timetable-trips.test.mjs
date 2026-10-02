import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  KORAIL_STATION_ROW_BINDINGS,
  EXPRESS_STOP_PATTERN_UNRESOLVED,
  HOLIDAY_INCLUDES_SATURDAY_POLICY,
  LOCAL_QUARANTINE_RATIO_LIMIT,
  buildKorailStationRowTrips,
  parseKricDayFractionSeconds,
  rowSetSha256,
  validateStationRowTripsAgainstPack,
} from "./kric-station-row-timetable-trips.mjs";

const clock = (hhmmss) => {
  const [h, m, s = 0] = hhmmss.split(":").map(Number);
  return String((h * 3600 + m * 60 + s) / 86400);
};
const sha = (value) => createHash("sha256").update(value).digest("hex");

let nextRow = 1000;
function trip({ routeNumber = "TEST1", routeName = "테스트선", trainNumber, weekdayType = "평일", serviceType = "일반",
  origin, destination, stops, startRow, dataReferenceDate = "46173" }) {
  let row = startRow ?? nextRow;
  const records = stops.map(([stationName, arrival, departure]) => ({
    trainNumber, routeNumber, routeName,
    originStationName: origin ?? stops[0][0], destinationStationName: destination ?? stops.at(-1)[0],
    serviceType, weekdayType, stationName,
    arrivalTime: { value: arrival === null ? "" : clock(arrival) },
    departureTime: { value: departure === null ? "" : clock(departure) },
    dataReferenceDate: { value: dataReferenceDate },
    sourceRowNumber: row++,
    sourceRowSha256: sha(`${routeNumber}|${trainNumber}|${weekdayType}|${stationName}`),
  }));
  nextRow = row + 10;
  return records;
}

const BINDING = Object.freeze({
  routeNumber: "TEST1", routeName: "테스트선", lineId: "line-test",
  stationAliases: { "축약역": "축약된역이름" },
  aliasEvidence: { "축약역": "테스트 고정 근거" },
  expressQuarantine: { rowCount: 0, rowSetSha256: rowSetSha256([]) },
});

test("일반열차를 원천 행 순서대로 재구성하고 시각이 단조 증가한다", () => {
  const records = trip({ trainNumber: "K100", stops: [["가역", "06:00:00", "06:00:30"], ["축약역", "06:02:00", "06:02:30"], ["다역", "06:05:00", "06:05:00"]] });
  const result = buildKorailStationRowTrips({ records: [...records].reverse(), bindings: [BINDING] });
  assert.equal(result.trips.length, 1);
  const [built] = result.trips;
  assert.equal(built.lineId, "line-test");
  assert.equal(built.providerTripKey, "TEST1|K100|평일");
  assert.equal(built.serviceDayKind, "WEEKDAY");
  assert.equal(built.servicePattern, "LOCAL");
  assert.equal(built.headsign, "다역");
  assert.deepEqual(built.stops.map(({ stationName }) => stationName), ["가역", "축약역", "다역"]);
  assert.deepEqual(built.stops.map(({ departureSeconds }) => departureSeconds), [21630, 21750, 21900]);
  assert.equal(built.sourceRowSha256, sha(JSON.stringify(records.map(({ sourceRowSha256 }) => sourceRowSha256))));
  assert.deepEqual(built.provenance.sourceRowNumbers, records.map(({ sourceRowNumber }) => sourceRowNumber));
  assert.equal(built.provenance.dataReferenceDate, "2026-05-31");
  assert.deepEqual(result.summary["line-test"], { routeNumber: "TEST1", localTrips: 1, localQuarantined: 0,
    expressRows: 0, expressTrips: 0, expressReason: EXPRESS_STOP_PATTERN_UNRESOLVED });
});

test("휴일 요일구분은 토·일·공휴일 운행으로 매핑한다", () => {
  const records = trip({ trainNumber: "K101", weekdayType: "휴일", stops: [["가역", "07:00", "07:00"], ["나역", "07:03", "07:03"]] });
  const [built] = buildKorailStationRowTrips({ records, bindings: [BINDING] }).trips;
  assert.equal(built.serviceDayKind, "SATURDAY_SUNDAY_HOLIDAY");
  assert.equal(built.provenance.serviceDayPolicy, HOLIDAY_INCLUDES_SATURDAY_POLICY);
});

test("자정을 넘는 열차는 다음날 초(86400+)로 이어진다", () => {
  const records = trip({ trainNumber: "K102", stops: [["가역", "23:58:00", "23:58:30"], ["나역", "00:01:00", "00:01:30"], ["다역", "00:04:00", "00:04:00"]] });
  const [built] = buildKorailStationRowTrips({ records, bindings: [BINDING] }).trips;
  assert.deepEqual(built.stops.map(({ arrivalSeconds }) => arrivalSeconds), [86280, 86460, 86640]);
});

test("행 순서와 시각 순서가 어긋나면 그 열차를 quarantine하고 상한을 넘으면 실패한다", () => {
  const good = Array.from({ length: 19 }, (_, index) => trip({ trainNumber: `K2${String(index).padStart(2, "0")}`,
    stops: [["가역", "08:00", "08:00"], ["나역", "08:03", "08:03"]] })).flat();
  const bad = trip({ trainNumber: "K299", stops: [["가역", "08:10", "08:10"], ["나역", "08:05", "08:05"]] });
  const result = buildKorailStationRowTrips({ records: [...good, ...bad], bindings: [BINDING] });
  assert.equal(result.trips.length, 19);
  assert.deepEqual(result.quarantine.map(({ providerTripKey, reason }) => [providerTripKey, reason]), [["TEST1|K299|평일", "TIME_ORDER_CONFLICTS_WITH_ROW_ORDER"]]);
  const worse = trip({ trainNumber: "K298", stops: [["가역", "08:10", "08:10"], ["나역", "08:05", "08:05"]] });
  assert.throws(() => buildKorailStationRowTrips({ records: [...good, ...bad, ...worse], bindings: [BINDING] }),
    /LOCAL_QUARANTINE_RATIO_EXCEEDED: line-test 2\/21/u);
  assert.equal(LOCAL_QUARANTINE_RATIO_LIMIT, 0.05);
});

test("한 열차의 원천 행이 연속하지 않거나 시발·종착이 첫·끝 행과 다르면 quarantine한다", () => {
  const split = trip({ trainNumber: "K300", stops: [["가역", "09:00", "09:00"], ["나역", "09:03", "09:03"]] });
  split[1].sourceRowNumber += 5;
  const wrongEnd = trip({ trainNumber: "K301", destination: "다역", stops: [["가역", "09:10", "09:10"], ["나역", "09:13", "09:13"]] });
  const fill = Array.from({ length: 40 }, (_, index) => trip({ trainNumber: `K3${50 + index}`,
    stops: [["가역", "10:00", "10:00"], ["나역", "10:03", "10:03"]] })).flat();
  const result = buildKorailStationRowTrips({ records: [...split, ...wrongEnd, ...fill], bindings: [BINDING] });
  assert.deepEqual(result.quarantine.map(({ reason }) => reason).sort(), ["ENDPOINT_MISMATCH", "ROWS_NOT_CONTIGUOUS"]);
});

test("급행은 정차·통과를 구분할 수 없어 적재하지 않고, 고정한 행 집합과 다르면 실패한다", () => {
  const express = trip({ trainNumber: "K400", serviceType: "급행", stops: [["가역", "11:00", "11:00"], ["나역", "11:02", "11:02"]] });
  const local = trip({ trainNumber: "K401", stops: [["가역", "11:05", "11:05"], ["나역", "11:08", "11:08"]] });
  const pinned = { ...BINDING, expressQuarantine: { rowCount: 2, rowSetSha256: rowSetSha256(express) } };
  const result = buildKorailStationRowTrips({ records: [...express, ...local], bindings: [pinned] });
  assert.deepEqual(result.trips.map(({ providerTripKey }) => providerTripKey), ["TEST1|K401|평일"]);
  assert.deepEqual(result.expressQuarantine["line-test"], { reason: EXPRESS_STOP_PATTERN_UNRESOLVED,
    note: "급행 정차·통과 구분 불가, #902에서 보강", rowCount: 2, tripCount: 1, rowSetSha256: rowSetSha256(express) });
  assert.throws(() => buildKorailStationRowTrips({ records: [...express, ...local], bindings: [BINDING] }),
    /EXPRESS_QUARANTINE_ROW_SET_CHANGED: TEST1/u);
});

test("수도권 밖·미바인딩 노선번호 행(경부선 동대구-경산 등)은 어떤 노선에도 넣지 않는다", () => {
  const daegu = trip({ routeNumber: "I4101", routeName: "경부선", trainNumber: "K1701", stops: [["동대구", "06:00", "06:00"], ["경산", "06:10", "06:10"]] });
  const local = trip({ trainNumber: "K500", stops: [["가역", "12:00", "12:00"], ["나역", "12:03", "12:03"]] });
  const result = buildKorailStationRowTrips({ records: [...daegu, ...local], bindings: [BINDING] });
  assert.deepEqual(result.trips.map(({ lineId, providerTripKey }) => [lineId, providerTripKey]), [["line-test", "TEST1|K500|평일"]]);
});

test("여러 노선을 잇는 같은 열차번호는 노선별 별도 trip이며 서로 섞이지 않는다", () => {
  const other = { ...BINDING, routeNumber: "TEST2", routeName: "연결선", lineId: "line-other" };
  const first = trip({ trainNumber: "K600", stops: [["가역", "13:00", "13:00"], ["나역", "13:03", "13:03"]] });
  const second = trip({ routeNumber: "TEST2", routeName: "연결선", trainNumber: "K600", stops: [["나역", "13:04", "13:04"], ["라역", "13:08", "13:08"]] });
  const result = buildKorailStationRowTrips({ records: [...first, ...second], bindings: [BINDING, other] });
  assert.deepEqual(result.trips.map(({ lineId, providerTripKey, stops }) => [lineId, providerTripKey, stops.length]),
    [["line-other", "TEST2|K600|평일", 2], ["line-test", "TEST1|K600|평일", 2]]);
});

test("노선명이 바인딩과 다르거나 요일·운행 구분이 알 수 없는 값이면 명시적으로 실패한다", () => {
  assert.throws(() => buildKorailStationRowTrips({ records: trip({ routeName: "다른선", trainNumber: "K700", stops: [["가역", "14:00", "14:00"], ["나역", "14:03", "14:03"]] }), bindings: [BINDING] }), /ROUTE_NAME_MISMATCH/u);
  assert.throws(() => buildKorailStationRowTrips({ records: trip({ weekdayType: "토요일", trainNumber: "K701", stops: [["가역", "14:00", "14:00"], ["나역", "14:03", "14:03"]] }), bindings: [BINDING] }), /UNSUPPORTED_WEEKDAY_TYPE/u);
  assert.throws(() => buildKorailStationRowTrips({ records: trip({ serviceType: "직통", trainNumber: "K702", stops: [["가역", "14:00", "14:00"], ["나역", "14:03", "14:03"]] }), bindings: [BINDING] }), /UNSUPPORTED_SERVICE_TYPE/u);
  assert.throws(() => buildKorailStationRowTrips({ records: [], bindings: [BINDING] }), /NO_TRIPS: line-test/u);
});

test("Excel 일 분수(과학 표기 포함)를 정수 초로만 해석한다", () => {
  assert.equal(parseKricDayFractionSeconds("0.25034722222222222"), 21630);
  assert.equal(parseKricDayFractionSeconds("1.5625E-2"), 1350);
  assert.equal(parseKricDayFractionSeconds(""), null);
  assert.throws(() => parseKricDayFractionSeconds("05:00"), /INVALID_DAY_FRACTION/u);
  assert.throws(() => parseKricDayFractionSeconds("1.2"), /INVALID_DAY_FRACTION/u);
  assert.throws(() => parseKricDayFractionSeconds(String(0.5 + 0.4 / 86400)), /INVALID_DAY_FRACTION/u);
});

const PACK = {
  stations: [["s-ga", "가역"], ["s-na", "축약된역이름"], ["s-da", "다역"], ["s-ra", "라역"]].map(([id, nameKo]) => ({ id, nameKo })),
  stationLines: ["s-ga", "s-na", "s-da"].map((stationId, index) => ({ stationId, lineId: "line-test", lineSequence: index + 1 }))
    .concat([{ stationId: "s-ra", lineId: "line-other", lineSequence: 1 }]),
  networkEdges: [["s-ga", "s-na"], ["s-na", "s-da"]].flatMap(([a, b]) => [
    { edgeType: "RIDE", fromNodeId: `${a}:line-test`, toNodeId: `${b}:line-test` },
    { edgeType: "RIDE", fromNodeId: `${b}:line-test`, toNodeId: `${a}:line-test` }]),
};

test("정차역은 alias 적용 후 해당 노선 소속이어야 하고 일반열차 연속 정차는 인접역이어야 한다", () => {
  const ok = buildKorailStationRowTrips({ records: trip({ trainNumber: "K800", stops: [["가역", "15:00", "15:00"], ["축약역", "15:03", "15:03"], ["다역", "15:06", "15:06"]] }), bindings: [BINDING] });
  assert.deepEqual(validateStationRowTripsAgainstPack({ trips: ok.trips, pack: PACK, bindings: [BINDING] }), { "line-test": { trips: 1, stops: 3 } });
  const foreign = buildKorailStationRowTrips({ records: trip({ trainNumber: "K801", stops: [["가역", "15:00", "15:00"], ["라역", "15:03", "15:03"]] }), bindings: [BINDING] });
  assert.throws(() => validateStationRowTripsAgainstPack({ trips: foreign.trips, pack: PACK, bindings: [BINDING] }), /STATION_NOT_ON_LINE: line-test 라역/u);
  const skip = buildKorailStationRowTrips({ records: trip({ trainNumber: "K802", stops: [["가역", "15:00", "15:00"], ["다역", "15:06", "15:06"]] }), bindings: [BINDING] });
  assert.throws(() => validateStationRowTripsAgainstPack({ trips: skip.trips, pack: PACK, bindings: [BINDING] }), /LOCAL_STOP_NOT_ADJACENT: TEST1\|K802\|평일 가역->다역/u);
  const badAlias = { ...BINDING, stationAliases: { "축약역": "없는역" } };
  assert.throws(() => validateStationRowTripsAgainstPack({ trips: [], pack: PACK, bindings: [badAlias] }), /ALIAS_TARGET_NOT_ON_LINE: line-test 축약역->없는역/u);
});

test("고정 바인딩은 코레일 단독 5개 노선과 동해선을 정확히 한 번씩 가리키고 alias마다 근거가 있다", () => {
  assert.deepEqual(KORAIL_STATION_ROW_BINDINGS.map(({ routeNumber, lineId }) => [routeNumber, lineId]), [
    ["I41WS", "line-051552e50435"], ["I41K2", "line-54a7b980b7c3"], ["I28K1", "line-558d0bd8312d"],
    ["I4108", "line-6e39be0cb6e2"], ["I41K5", "line-e4939a4b4713"], ["I26K6", "line-f52eb59d8497"],
  ]);
  for (const binding of KORAIL_STATION_ROW_BINDINGS) {
    assert.deepEqual(Object.keys(binding.aliasEvidence).sort(), Object.keys(binding.stationAliases).sort(), binding.routeNumber);
    for (const reason of Object.values(binding.aliasEvidence)) assert.ok(reason.length > 10, binding.routeNumber);
    assert.match(binding.expressQuarantine.rowSetSha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(binding.expressQuarantine.rowCount));
  }
});
