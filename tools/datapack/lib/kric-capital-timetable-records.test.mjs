import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  KRIC_CAPITAL_DUPLICATE_ROW_RESOLUTIONS,
  KRIC_CAPITAL_ROUTE_PROFILES,
  kricCapitalOfficialTimetable,
  projectKricCapitalTimetableSnapshot,
  validateKricCapitalTimetableSnapshot,
} from "./kric-capital-timetable-records.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const cell = (value) => ({ value, cellType: "s", styleId: 1 });
const EMPTY = { value: "", cellType: "n", styleId: 1 };
let row = 10;
function record(routeNumber, routeName, { names, arrivals, departures, day = "평일", type = "일반", train = String(row) }) {
  row += 1;
  return {
    trainNumber: train, routeNumber, routeName, originStationName: "o", destinationStationName: "d", serviceType: type,
    weekdayType: day, stationName: names, arrivalTime: arrivals === "" ? EMPTY : cell(arrivals), departureTime: cell(departures),
    speed: cell("33"), operatorPhone: cell("02"), dataReferenceDate: { value: "46022", cellType: "n", styleId: 1 },
    sourceRowNumber: row, sourceRowSha256: sha(`row-${row}`),
  };
}

// 대상 노선마다 정상 행 하나를 두고, 검사할 행을 더한 관측(observation)을 만든다.
function observation(extra = []) {
  const base = KRIC_CAPITAL_ROUTE_PROFILES.map(({ routeNumber, routeName }) => record(routeNumber, routeName, {
    names: "001-가+002-나", arrivals: "001-00:00+002-05:32", departures: "001-05:30+002-00:00",
  }));
  const records = [...base, ...extra, record("S2601", "부산 도시철도 1호선", {
    names: "001-가+002-나", arrivals: "001-00:00+002-05:32", departures: "001-05:30+002-00:00",
  })];
  return {
    schemaVersion: 1, artifactKind: "kric-nationwide-timetable-observation", sourceId: "kric-nationwide-timetable-file",
    observedAt: "2026-10-02T15:57:05.773Z", rawFile: "kric-nationwide-timetable-file-x.xlsx", rawByteLength: 1,
    rawSha256: "c".repeat(64), rowCount: records.length, records, recordsSha256: "d".repeat(64),
  };
}
const OBSERVED_AT = "2026-10-02T15:57:05.773Z";
const tripsOf = (snapshot, routeNumber) => kricCapitalOfficialTimetable(snapshot, { observedAt: OBSERVED_AT }).provider.trips.filter((trip) => trip.routeKey === routeNumber);
const quarantineOf = (snapshot, routeNumber) => kricCapitalOfficialTimetable(snapshot, { observedAt: OBSERVED_AT }).provider.quarantine.filter((entry) => entry.routeKey === routeNumber);

test("snapshot은 대상 노선 행만 원문 그대로 담고 자기 해시로 식별된다", () => {
  const snapshot = projectKricCapitalTimetableSnapshot(observation());
  assert.equal(snapshot.records.length, KRIC_CAPITAL_ROUTE_PROFILES.length);
  assert.ok(snapshot.records.every(({ routeNumber }) => routeNumber !== "S2601"));
  assert.equal(snapshot.records[0].arrivalTime, "001-00:00+002-05:32");
  assert.equal(validateKricCapitalTimetableSnapshot(snapshot), snapshot);
  const tampered = structuredClone(snapshot);
  tampered.records[0].departureTime = "001-05:31+002-00:00";
  assert.throws(() => validateKricCapitalTimetableSnapshot(tampered), /SNAPSHOT_HASH/u);
});

test("snapshot은 관측 시각·수집 파일명과 무관하다: 같은 원본을 다른 시각에 관측해도 바이트가 같다(#870)", () => {
  const observed = observation();
  const later = projectKricCapitalTimetableSnapshot({ ...observed, observedAt: "2026-10-09T15:57:05.773Z", rawFile: "kric-nationwide-timetable-file-later.xlsx" });
  // 독립 기대값: snapshot 필드는 원본 내용에서만 나오고, 관측 시각·수집 파일명 필드는 없다.
  assert.deepEqual(Object.keys(later), ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "rawByteLength", "rawSha256",
    "observationRecordsSha256", "routes", "recordCount", "recordsSha256", "records"]);
  assert.equal(later.rawSha256, observed.rawSha256);
  assert.equal(later.observationRecordsSha256, observed.recordsSha256);
  assert.equal(later.recordsSha256, sha(`${JSON.stringify(later.records)}\n`));
  assert.equal(later.snapshotId, `kric-nationwide-timetable-file-capital-${later.recordsSha256}`);
  const first = later;
  assert.throws(() => validateKricCapitalTimetableSnapshot({ ...first, observedAt: "2026-10-02T15:57:05.773Z" }), /KRIC_CAPITAL_TIMETABLE_SNAPSHOT/u);
});

test("대상 노선 행이 관측에 없으면 snapshot을 만들지 않는다", () => {
  const source = observation();
  source.records = source.records.filter(({ routeNumber }) => routeNumber !== "S1102");
  assert.throws(() => projectKricCapitalTimetableSnapshot(source), /ROUTE_MISSING: S1102/u);
});

test("기점 도착·종점 출발 00:00은 미제공으로 보고, 04시 전 시각은 전날 운행일 심야(+24h)로 본다", () => {
  const snapshot = projectKricCapitalTimetableSnapshot(observation([record("S1102", "서울 도시철도 2호선", {
    names: "001-가+002-나+003-다", arrivals: "001-00:00+002-23:58+003-00:01", departures: "001-23:56+002-23:59+003-00:00", train: "late",
  })]));
  const late = tripsOf(snapshot, "S1102").find(({ trainNumber }) => trainNumber === "late");
  assert.deepEqual(late.stops, [
    { stationName: "가", arrivalSeconds: null, departureSeconds: 86_160 },
    { stationName: "나", arrivalSeconds: 86_280, departureSeconds: 86_340 },
    { stationName: "다", arrivalSeconds: 86_460, departureSeconds: null },
  ]);
});

test("시각이 역전되거나 정차 시각이 없거나 문법이 다른 행은 trip을 만들지 않고 사유와 함께 격리한다", () => {
  const snapshot = projectKricCapitalTimetableSnapshot(observation([
    record("S1101", "서울 도시철도 1호선", { names: "001-가+002-나", arrivals: "001-00:00+002-00:00", departures: "001-08:07+002-08:10", train: "scrambled" }),
    record("L11SL", "수도권 경량도시철도 신림선", { names: "001-가+002-나", arrivals: "001-:+002-:", departures: "001-5:30+002-:", train: "noterminal" }),
    record("L11SL", "수도권 경량도시철도 신림선", { names: "001-가+002-나", arrivals: "001-:+002-:0:59", departures: "001-0:42+002-:", train: "grammar" }),
  ]));
  assert.deepEqual(quarantineOf(snapshot, "S1101").map(({ trainNumber, reason }) => `${trainNumber}:${reason}`), ["scrambled:TIME_NOT_MONOTONIC"]);
  assert.deepEqual(quarantineOf(snapshot, "L11SL").map(({ trainNumber, reason }) => `${trainNumber}:${reason}`).sort(),
    ["grammar:TIME_CELL_GRAMMAR", "noterminal:STOP_WITHOUT_TIME"]);
});

test("9호선·신분당선은 역 코드 키의 셀 토큰 순서를, 공항철도는 키·시각 교차 문법을 원천 순서대로 읽는다", () => {
  const snapshot = projectKricCapitalTimetableSnapshot(observation([
    record("S1109", "서울 도시철도 9호선", { names: "4107-가양+4106-양천향교", arrivals: "4106-05:32", departures: "4107-05:30+4106-05:32", train: "code" }),
    record("I11D1", "신분당선", { names: "D12-정자+D11-판교", arrivals: "D12-  :  +D11-05:32", departures: "D12-05:30+D11-05:33", day: "토요일", train: "spaced" }),
    record("I28A1", "인천국제공항선", { names: "001-서울+002-인천공항1터미널", arrivals: "", departures: "001+06:00+002+06:45", day: "휴일", type: "직통", train: "pairs" }),
  ]));
  assert.deepEqual(tripsOf(snapshot, "S1109").find(({ trainNumber }) => trainNumber === "code").stops.map(({ stationName }) => stationName), ["가양", "양천향교"]);
  const spaced = tripsOf(snapshot, "I11D1").find(({ trainNumber }) => trainNumber === "spaced");
  assert.equal(spaced.serviceDayKind, "SATURDAY");
  assert.equal(spaced.stops[0].arrivalSeconds, null);
  const pairs = tripsOf(snapshot, "I28A1").find(({ trainNumber }) => trainNumber === "pairs");
  assert.deepEqual([pairs.servicePattern, pairs.serviceDayKind, pairs.stops[1].departureSeconds], ["EXPRESS", "WEEKEND_HOLIDAY", 24_300]);
});

test("노선별 요일구분·운행유형 표기가 표에 없으면 추정하지 않고 실패한다", () => {
  const unknownDay = projectKricCapitalTimetableSnapshot(observation([record("S1102", "서울 도시철도 2호선", {
    names: "001-가+002-나", arrivals: "001-00:00+002-05:32", departures: "001-05:30+002-00:00", day: "명절",
  })]));
  assert.throws(() => kricCapitalOfficialTimetable(unknownDay, { observedAt: OBSERVED_AT }), /SERVICE_DAY_UNKNOWN: S1102 명절/u);
  const unknownType = projectKricCapitalTimetableSnapshot(observation([record("S1102", "서울 도시철도 2호선", {
    names: "001-가+002-나", arrivals: "001-00:00+002-05:32", departures: "001-05:30+002-00:00", type: "특급",
  })]));
  assert.throws(() => kricCapitalOfficialTimetable(unknownType, { observedAt: OBSERVED_AT }), /SERVICE_TYPE_UNKNOWN: S1102 특급/u);
});

test("1호선 binding만 원천 손상 행 집합을 고정 허용치로 가진다", () => {
  const { lineBindings } = kricCapitalOfficialTimetable(projectKricCapitalTimetableSnapshot(observation()), { observedAt: OBSERVED_AT });
  const pinned = lineBindings.filter((binding) => binding.quarantineAllowance);
  assert.deepEqual(pinned.map(({ routeKey }) => routeKey), ["S1101"]);
  assert.deepEqual([pinned[0].quarantineAllowance.reason, pinned[0].quarantineAllowance.rowCount], ["TIME_NOT_MONOTONIC", 453]);
  assert.match(pinned[0].quarantineAllowance.note, /#902/u);
});

// #920: 같은 노선·요일구분에서 정차·도착·출발 칸이 모두 같은 원천 행은 한 열차의 중복 기재다(한 선로에서 두 열차가 같은 초에
// 같은 역을 같은 다음 역으로 출발할 수 없다). 어느 행을 남길지는 공식 근거로 고정한 규칙이 있을 때만 정하고, 없으면 실패한다.
const duplicateRows = () => {
  const late = { names: "001-서동탄+002-병점+003-구로", arrivals: "001-00:00+002-23:19+003-24:09", departures: "001-23:14+002-23:21+003-00:00", day: "토요일+공휴일" };
  return [
    record("S1101", "서울 도시철도 1호선", { ...late, train: "506" }),
    record("S1101", "서울 도시철도 1호선", { ...late, train: "512" }),
  ];
};

test("#920 같은 요일구분의 내용 중복 행은 고정 근거가 가리키는 행만 남기고 나머지를 DUPLICATE_SERVICE_ROW로 격리한다", () => {
  const rows = duplicateRows();
  const snapshot = projectKricCapitalTimetableSnapshot(observation(rows));
  const resolutions = [{
    routeNumber: "S1101", weekdayType: "토요일+공휴일",
    keep: { trainNumber: "506", sourceRowSha256: rows[0].sourceRowSha256 },
    drop: { trainNumber: "512", sourceRowSha256: rows[1].sourceRowSha256 },
    evidence: "테스트 근거",
  }];
  const { provider } = kricCapitalOfficialTimetable(snapshot, { observedAt: OBSERVED_AT, duplicateResolutions: resolutions });
  const weekend = provider.trips.filter((trip) => trip.routeKey === "S1101" && trip.sourceDayKey === "토요일+공휴일");
  assert.deepEqual(weekend.map(({ trainNumber }) => trainNumber), ["506"]);
  assert.deepEqual(provider.quarantine.filter(({ routeKey }) => routeKey === "S1101")
    .map(({ trainNumber, reason, sourceRowSha256 }) => [trainNumber, reason, sourceRowSha256]),
  [["512", "DUPLICATE_SERVICE_ROW", rows[1].sourceRowSha256]]);
});

test("#920 고정 근거가 없는 내용 중복 행은 임의로 버리지 않고 실패한다", () => {
  const snapshot = projectKricCapitalTimetableSnapshot(observation(duplicateRows()));
  assert.throws(() => kricCapitalOfficialTimetable(snapshot, { observedAt: OBSERVED_AT, duplicateResolutions: [] }),
    /KRIC_CAPITAL_TIMETABLE_DUPLICATE_TRIP_UNRESOLVED: S1101 토요일\+공휴일 506,512/u);
  // 시각이 하나라도 다르면 중복이 아니다.
  const [first, second] = duplicateRows();
  second.departureTime = cell("001-23:15+002-23:22+003-00:00");
  second.arrivalTime = cell("001-00:00+002-23:20+003-24:10");
  const distinct = kricCapitalOfficialTimetable(projectKricCapitalTimetableSnapshot(observation([first, second])),
    { observedAt: OBSERVED_AT, duplicateResolutions: [] });
  assert.equal(distinct.provider.trips.filter((trip) => trip.routeKey === "S1101" && trip.sourceDayKey === "토요일+공휴일").length, 2);
});

test("#920 기본 고정 근거는 1호선 주말 512·514 행을 같은 시각 506·508 행의 중복으로 KRIC 역별 API 실측과 함께 남긴다", () => {
  assert.deepEqual(KRIC_CAPITAL_DUPLICATE_ROW_RESOLUTIONS.map(({ routeNumber, weekdayType, keep, drop }) =>
    [routeNumber, weekdayType, keep.trainNumber, drop.trainNumber]), [
    ["S1101", "토요일+공휴일", "506", "512"],
    ["S1101", "토요일+공휴일", "508", "514"],
  ]);
  for (const { keep, drop, evidence } of KRIC_CAPITAL_DUPLICATE_ROW_RESOLUTIONS) {
    assert.match(keep.sourceRowSha256, /^[a-f0-9]{64}$/u);
    assert.match(drop.sourceRowSha256, /^[a-f0-9]{64}$/u);
    assert.match(evidence, /subwayTimetable/u);
  }
});

// 리뷰 F1(#924): 규칙은 행 해시와 열차 번호가 함께 맞을 때만 적용된다. 어느 한쪽만 맞거나
// 노선·요일구분이 다르면 중복을 버리지 않고 실패한다.
test("#920 행 해시만 맞거나 열차 번호만 맞거나 노선·요일구분이 다른 규칙은 중복을 격리하지 않고 실패한다", () => {
  const rows = duplicateRows();
  const snapshot = projectKricCapitalTimetableSnapshot(observation(rows));
  const rule = (overrides) => [{
    routeNumber: "S1101", weekdayType: "토요일+공휴일",
    keep: { trainNumber: "506", sourceRowSha256: rows[0].sourceRowSha256 },
    drop: { trainNumber: "512", sourceRowSha256: rows[1].sourceRowSha256 },
    evidence: "테스트 근거", ...overrides,
  }];
  const unresolved = /KRIC_CAPITAL_TIMETABLE_DUPLICATE_TRIP_UNRESOLVED: S1101 토요일\+공휴일 506,512/u;
  for (const resolutions of [
    rule({ drop: { trainNumber: "999", sourceRowSha256: rows[1].sourceRowSha256 } }),
    rule({ drop: { trainNumber: "512", sourceRowSha256: "f".repeat(64) } }),
    rule({ keep: { trainNumber: "999", sourceRowSha256: rows[0].sourceRowSha256 } }),
    rule({ keep: { trainNumber: "506", sourceRowSha256: "f".repeat(64) } }),
    rule({ routeNumber: "S1102" }),
    rule({ weekdayType: "평일" }),
  ]) {
    assert.throws(() => kricCapitalOfficialTimetable(snapshot, { observedAt: OBSERVED_AT, duplicateResolutions: resolutions }), unresolved);
  }
});

// 리뷰 F2(#924): 남길 행의 근거인 KRIC 역별 API 응답(서비스 키 제외, 2026-10-04 수집)을 보관하고 그 원문으로 판정을 확인한다.
test("#920 보관된 KRIC 역별 API 응답에서 휴일 23:14·23:34 서동탄 출발은 506·508뿐이고 512·514는 평일 열차다", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const directory = path.join(import.meta.dirname, "../fixtures/kric-line1-weekend-duplicate-evidence");
  const manifest = JSON.parse(await readFile(path.join(directory, "responses.json"), "utf8"));
  const responses = new Map();
  for (const entry of manifest.responses) {
    const bytes = await readFile(path.join(directory, entry.file));
    assert.equal(sha(bytes), entry.sha256, entry.file);
    assert.doesNotMatch(bytes.toString("utf8"), /serviceKey/iu);
    responses.set(`${entry.request.stinCd}|${entry.request.dayCd}`, JSON.parse(bytes));
  }
  const trains = (stinCd, dayCd, field, times) => (responses.get(`${stinCd}|${dayCd}`).body ?? [])
    .filter((row) => times.includes(row[field])).map(({ trnNo }) => trnNo).sort();
  // 서동탄(P157-1) 시발 23:14·23:34
  assert.deepEqual(trains("P157-1", "9", "dptTm", ["231400", "233400"]), ["K506", "K508"]);
  assert.deepEqual(trains("P157-1", "8", "dptTm", ["231400", "233400"]), ["K512", "K514"]);
  // 같은 열차의 수원(P155)·금정(P149) 출발
  assert.deepEqual(trains("P155", "9", "dptTm", ["232900", "234900"]), ["K506", "K508"]);
  assert.deepEqual(trains("P155", "8", "dptTm", ["232900", "234900"]), ["K512", "K514"]);
  assert.deepEqual(trains("P149", "9", "dptTm", ["234630", "000630"]), ["K506", "K508"]);
  assert.deepEqual(trains("P149", "8", "dptTm", ["234630", "000630"]), ["K512", "K514"]);
  // 토요일(dayCd 7)은 '데이터 없음'이라 휴일 시간표가 토요일에도 운행한다.
  for (const stinCd of ["P157-1", "P155", "P149"]) assert.equal(responses.get(`${stinCd}|7`).header.resultCode, "03");
  // 고정 규칙은 이 원문과 같은 선택(506·508 유지, 512·514 제외)이다.
  assert.deepEqual(KRIC_CAPITAL_DUPLICATE_ROW_RESOLUTIONS.map(({ keep, drop }) => [keep.trainNumber, drop.trainNumber]),
    [["506", "512"], ["508", "514"]]);
});
