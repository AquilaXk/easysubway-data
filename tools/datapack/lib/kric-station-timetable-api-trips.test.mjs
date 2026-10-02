import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOLIDAY_INCLUDES_SATURDAY_POLICY,
  KRIC_API_STATION_TIMETABLE_BINDINGS,
  buildApiStationTimetableTrips,
  parseKricApiClock,
} from "./kric-station-timetable-api-trips.mjs";
import { validateStationRowTripsAgainstPack } from "./kric-station-row-timetable-trips.mjs";

const BINDING = Object.freeze({
  mreaWideCd: "01", lnCd: "T1", lineId: "line-api", routeIdPrefix: "route-kric-api-t1",
  stations: [["TT", "T01", "가역(부역명)"], ["TT", "T02", "나역"], ["TT", "T03", "다역"]],
  stationAliases: { "가역(부역명)": "가역" }, aliasEvidence: { "가역(부역명)": "테스트 고정 근거 문구" },
});

const hhmmss = (value) => value === null ? null : value.replaceAll(":", "");
// trips: [trnNo, dayCd, [[stinCd, arv, dpt], ...]]
function responses(trips, { binding = BINDING, saturday = "03", omit = [] } = {}) {
  const out = [];
  for (const dayCd of ["7", "8", "9"]) {
    for (const [railOprIsttCd, stinCd, stinNm] of binding.stations) {
      if (omit.includes(`${stinCd}|${dayCd}`)) continue;
      const rows = trips.filter(([, day]) => day === dayCd).flatMap(([trnNo, day, stops]) => stops
        .filter(([code]) => code === stinCd)
        .map(([, arv, dpt]) => ({ railOprIsttCd, trnNo, dayCd: day, dayNm: day === "8" ? "평일" : "휴일", stinCd, lnCd: binding.lnCd, arvTm: hhmmss(arv), dptTm: hhmmss(dpt) })));
      const resultCode = dayCd === "7" ? saturday : rows.length === 0 ? "03" : "00";
      out.push({ railOprIsttCd, lnCd: binding.lnCd, stinCd, stinNm, dayCd, resultCode, rows: resultCode === "00" ? rows : [] });
    }
  }
  return out;
}

const LOCAL = (trnNo, dayCd, base = "06") => [trnNo, dayCd, [["T01", null, `${base}:00:00`], ["T02", `${base}:02:00`, `${base}:02:30`], ["T03", `${base}:05:00`, null]]];

test("역별 응답을 열차번호·요일로 묶어 시각순 정차열로 재구성한다", () => {
  const result = buildApiStationTimetableTrips({ responses: responses([LOCAL("X1", "8"), LOCAL("H1", "9")]), bindings: [BINDING] });
  assert.equal(result.trips.length, 2);
  const trip = result.trips.find(({ providerTripKey }) => providerTripKey === "T1|X1|8|ASC");
  assert.equal(trip.lineId, "line-api");
  assert.equal(trip.providerTripKey, "T1|X1|8|ASC");
  assert.equal(trip.provenance.direction, "ASC");
  assert.equal(trip.serviceDayKind, "WEEKDAY");
  assert.equal(trip.servicePattern, "LOCAL");
  assert.equal(trip.headsign, "다역");
  assert.deepEqual(trip.stops, [
    { stationName: "가역(부역명)", arrivalSeconds: null, departureSeconds: 21600 },
    { stationName: "나역", arrivalSeconds: 21720, departureSeconds: 21750 },
    { stationName: "다역", arrivalSeconds: 21900, departureSeconds: null },
  ]);
  assert.match(trip.sourceRowSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(trip.provenance.stationCodes, ["T01", "T02", "T03"]);
});

test("dayCd 7이 전 역 '데이터 없음'이면 휴일(dayCd 9)을 토·일·공휴일로 적재하고 정책을 provenance에 남긴다", () => {
  const holiday = buildApiStationTimetableTrips({ responses: responses([LOCAL("X2", "8"), LOCAL("X3", "9")]), bindings: [BINDING] });
  assert.deepEqual(holiday.trips.map(({ serviceDayKind }) => serviceDayKind).sort(), ["SATURDAY_SUNDAY_HOLIDAY", "WEEKDAY"]);
  const trip = holiday.trips.find(({ serviceDayKind }) => serviceDayKind === "SATURDAY_SUNDAY_HOLIDAY");
  assert.equal(trip.provenance.serviceDayPolicy, HOLIDAY_INCLUDES_SATURDAY_POLICY);
  assert.match(HOLIDAY_INCLUDES_SATURDAY_POLICY, /^QA 확정 정책\(2026-10-03\): KRIC dayCd 9 '휴일' = 토·일·공휴일/u);
  const mixed = responses([LOCAL("X2", "8"), LOCAL("X3", "9")]);
  mixed.find(({ dayCd, stinCd }) => dayCd === "7" && stinCd === "T02").resultCode = "00";
  assert.throws(() => buildApiStationTimetableTrips({ responses: mixed, bindings: [BINDING] }), /SATURDAY_COVERAGE_INCONSISTENT: line-api/u);
  assert.throws(() => buildApiStationTimetableTrips({ responses: responses([LOCAL("X2", "8"), LOCAL("X3", "9")], { saturday: "00" }), bindings: [BINDING] }), /SATURDAY_TIMETABLE_UNSUPPORTED: line-api/u);
});

test("자정을 넘는 열차는 다음날 초로 이어 정렬한다", () => {
  const late = ["X4", "8", [["T01", null, "23:58:00"], ["T02", "00:00:30", "00:01:00"], ["T03", "00:03:00", null]]];
  const trip = buildApiStationTimetableTrips({ responses: responses([late, LOCAL("H2", "9")]), bindings: [BINDING] }).trips.find(({ providerTripKey }) => providerTripKey === "T1|X4|8|ASC");
  assert.deepEqual(trip.stops.map(({ stationName }) => stationName), ["가역(부역명)", "나역", "다역"]);
  assert.deepEqual(trip.stops.map(({ arrivalSeconds }) => arrivalSeconds), [null, 86430, 86580]);
});

test("중간역 시각 누락(통과 표기)·끝점 null 패턴 위반·동시각 정차는 quarantine하고 상한을 넘으면 실패한다", () => {
  const good = Array.from({ length: 60 }, (_, index) => LOCAL(`G${index}`, "8", String(5 + Math.floor(index / 6)).padStart(2, "0")));
  const pass = ["P1", "8", [["T01", null, "07:00:00"], ["T02", null, "07:02:00"], ["T03", "07:05:00", null]]];
  const endpoint = ["P2", "8", [["T01", "07:10:00", "07:10:30"], ["T02", "07:12:00", "07:12:30"], ["T03", "07:15:00", null]]];
  const tie = ["P3", "8", [["T01", null, "07:20:00"], ["T02", "07:20:00", "07:20:00"], ["T03", "07:25:00", null]]];
  const result = buildApiStationTimetableTrips({ responses: responses([...good, LOCAL("H3", "9"), pass, endpoint, tie]), bindings: [BINDING] });
  assert.deepEqual(result.quarantine.map(({ providerTripKey, reason }) => [providerTripKey, reason]), [
    ["T1|P1|8", "INNER_STOP_TIME_MISSING"], ["T1|P2|8", "ENDPOINT_TIME_PATTERN_INVALID"], ["T1|P3|8", "TIME_ORDER_AMBIGUOUS"],
  ]);
  assert.throws(() => buildApiStationTimetableTrips({ responses: responses([...good.slice(0, 10), LOCAL("H3", "9"), pass, endpoint, tie]), bindings: [BINDING] }),
    /LOCAL_QUARANTINE_RATIO_EXCEEDED: line-api 3\/14/u);
});

test("중간역 출발이 도착보다 이르면(음수 정차) quarantine한다", () => {
  const good = Array.from({ length: 30 }, (_, index) => LOCAL(`D${index}`, "8", String(5 + Math.floor(index / 6)).padStart(2, "0")));
  const negative = ["N1", "8", [["T01", null, "07:00:00"], ["T02", "07:02:30", "07:02:00"], ["T03", "07:05:00", null]]];
  const result = buildApiStationTimetableTrips({ responses: responses([...good, LOCAL("H4", "9"), negative]), bindings: [BINDING] });
  assert.deepEqual(result.quarantine.map(({ providerTripKey, reason }) => [providerTripKey, reason]), [["T1|N1|8", "DWELL_NEGATIVE"]]);
  assert.equal(result.trips.some(({ providerTripKey }) => providerTripKey === "T1|N1|8"), false);
});

test("연속 정차는 같은 구간의 인접역이고 방향이 일정해야 하며, 방향은 trip 키에 들어간다", () => {
  const LINE4 = { ...BINDING, stations: [["TT", "T01", "가역(부역명)"], ["TT", "T02", "나역"], ["TT", "T03", "다역"], ["TT", "T04", "라역"]],
    segments: [["T01", "T02", "T03", "T04"]] };
  const good = Array.from({ length: 40 }, (_, index) => [`G${index}`, "8", [["T01", null, "06:00:00"], ["T02", "06:02:00", "06:02:30"], ["T03", "06:04:00", "06:04:30"], ["T04", "06:06:00", null]]]);
  const reverse = ["V1", "8", [["T04", null, "09:00:00"], ["T03", "09:02:00", "09:02:30"], ["T02", "09:04:00", "09:04:30"], ["T01", "09:06:00", null]]];
  const skip = ["S1", "8", [["T01", null, "07:00:00"], ["T03", "07:04:00", null]]];
  // 같은 열차번호가 반대 방향 다른 운행(겹치지 않는 역)에 다시 쓰이면 한 그룹으로 섞인다: 혼합 trip이 아니라 quarantine이어야 한다.
  const reused = ["R1", "8", [["T01", null, "06:30:00"], ["T02", "06:32:00", null], ["T04", null, "08:30:00"], ["T03", "08:32:00", null]]];
  const result = buildApiStationTimetableTrips({ responses: responses([...good, reverse, skip, reused, ["H5", "9", good[0][2]]], { binding: LINE4 }), bindings: [LINE4] });
  assert.ok(result.trips.some(({ providerTripKey }) => providerTripKey === "T1|V1|8|DESC"));
  assert.ok(result.trips.some(({ providerTripKey }) => providerTripKey === "T1|G0|8|ASC"));
  assert.deepEqual(result.quarantine.map(({ providerTripKey, reason }) => [providerTripKey, reason]),
    [["T1|R1|8", "INNER_STOP_TIME_MISSING"], ["T1|S1|8", "STOP_SEQUENCE_NOT_ADJACENT"]]);
  assert.equal(result.trips.some(({ providerTripKey }) => /\|(R1|S1)\|/u.test(providerTripKey)), false);
});

test("두 구간으로 나뉜 노선(GTX-A형)에서 구간을 건너는 정차열은 quarantine한다", () => {
  const SPLIT = { ...BINDING, stations: [["TT", "T01", "가역(부역명)"], ["TT", "T02", "나역"], ["TT", "T03", "다역"], ["TT", "T04", "라역"]],
    segments: [["T01", "T02"], ["T03", "T04"]] };
  const good = Array.from({ length: 40 }, (_, index) => [`G${index}`, "8", [["T03", null, "06:00:00"], ["T04", "06:03:00", null]]]);
  const cross = ["C1", "8", [["T01", null, "07:00:00"], ["T02", "07:02:00", "07:02:30"], ["T03", "07:05:00", null]]];
  const result = buildApiStationTimetableTrips({ responses: responses([...good, cross, ["H6", "9", [["T01", null, "06:00:00"], ["T02", "06:03:00", null]]], ["H7", "9", [["T03", null, "06:00:00"], ["T04", "06:03:00", null]]]], { binding: SPLIT }), bindings: [SPLIT] });
  assert.deepEqual(result.quarantine.map(({ providerTripKey, reason }) => [providerTripKey, reason]), [["T1|C1|8", "STOP_SEQUENCE_NOT_ADJACENT"]]);
});

test("역 응답이 빠지거나 오류 코드이거나 행이 요청과 다르면 명시적으로 실패한다", () => {
  assert.throws(() => buildApiStationTimetableTrips({ responses: responses([LOCAL("X5", "8"), LOCAL("X6", "9")], { omit: ["T02|8"] }), bindings: [BINDING] }), /STATION_RESPONSE_MISSING: line-api T02 dayCd=8/u);
  const errored = responses([LOCAL("X5", "8"), LOCAL("X6", "9")]);
  errored.find(({ dayCd, stinCd }) => dayCd === "9" && stinCd === "T03").resultCode = "30";
  assert.throws(() => buildApiStationTimetableTrips({ responses: errored, bindings: [BINDING] }), /STATION_RESPONSE_NOT_OK: line-api T03 dayCd=9 code=30/u);
  const empty = responses([LOCAL("X5", "8")]);
  assert.throws(() => buildApiStationTimetableTrips({ responses: empty, bindings: [BINDING] }), /STATION_RESPONSE_NOT_OK: line-api T01 dayCd=9 code=03/u);
  const foreign = responses([LOCAL("X5", "8"), LOCAL("X6", "9")]);
  foreign.find(({ dayCd, stinCd }) => dayCd === "8" && stinCd === "T02").rows[0].stinCd = "T09";
  assert.throws(() => buildApiStationTimetableTrips({ responses: foreign, bindings: [BINDING] }), /ROW_REQUEST_MISMATCH: line-api T02/u);
});

test("API 시각은 HHMMSS만 받는다", () => {
  assert.equal(parseKricApiClock("055100"), 21060);
  assert.equal(parseKricApiClock(null), null);
  assert.throws(() => parseKricApiClock("5:51"), /INVALID_API_CLOCK/u);
  assert.throws(() => parseKricApiClock("246000"), /INVALID_API_CLOCK/u);
});

test("팩 검증: alias 후 노선 소속과 인접 정차", () => {
  const pack = {
    stations: [["s-ga", "가역"], ["s-na", "나역"], ["s-da", "다역"]].map(([id, nameKo]) => ({ id, nameKo })),
    stationLines: ["s-ga", "s-na", "s-da"].map((stationId, index) => ({ stationId, lineId: "line-api", lineSequence: index + 1 })),
    networkEdges: [["s-ga", "s-na"], ["s-na", "s-da"]].map(([a, b]) => ({ edgeType: "RIDE", fromNodeId: `${a}:line-api`, toNodeId: `${b}:line-api` })),
  };
  const { trips } = buildApiStationTimetableTrips({ responses: responses([LOCAL("X7", "8"), LOCAL("X8", "9")]), bindings: [BINDING] });
  assert.deepEqual(validateStationRowTripsAgainstPack({ trips, pack, bindings: [BINDING] }), { "line-api": { trips: 2, stops: 6 } });
});

test("고정 바인딩은 GTX-A·에버라인·의정부·김포골드·부산김해 5개 노선이고 alias마다 근거가 있다", () => {
  assert.deepEqual(KRIC_API_STATION_TIMETABLE_BINDINGS.map(({ lnCd, lineId, stations }) => [lnCd, lineId, stations.length]), [
    ["A", "line-8604048b6430", 9], ["E1", "line-828f04afc588", 15], ["U1", "line-62096860ab09", 15],
    ["G1", "line-5500c1600f71", 10], ["B1", "line-e4cce88f0d7f", 21],
  ]);
  assert.deepEqual(KRIC_API_STATION_TIMETABLE_BINDINGS.find(({ lnCd }) => lnCd === "A").segments,
    [["X101", "X102", "X103", "X105", "X106"], ["X108", "X109", "X110", "X111"]]);
  for (const entry of KRIC_API_STATION_TIMETABLE_BINDINGS) {
    assert.deepEqual(entry.segments.flat().sort(), entry.stations.map(([, stinCd]) => stinCd).sort(), `${entry.lnCd} segments cover stations once`);
    assert.deepEqual(Object.keys(entry.aliasEvidence).sort(), Object.keys(entry.stationAliases).sort(), entry.lnCd);
    for (const name of Object.keys(entry.stationAliases)) assert.ok(entry.stations.some(([, , stinNm]) => stinNm === name), name);
  }
});
