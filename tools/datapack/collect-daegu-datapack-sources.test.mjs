import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DAEGU_LINES, decodeOfficialCsv, normalizedStationName, parseDaeguRouteTopology, parseDaeguTrainTimetable,
} from "./collect-daegu-datapack-sources.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readSnapshot = async (name) => JSON.parse(await readFile(path.join(root, "tools/datapack/sources", name), "utf8"));

// 공식 원문 파일별 SHA-256(이슈 #2407 표) — 취득 원문 identity 고정
const RAW_SHA256 = {
  1: { topology: "29398e8792899bc614c8e6563b0f4eaf1fec5182668b89d29045409395aae5c5",
    up: "892b8d397ef917a07851d4a2b33d375a6973df4c19ddadbaff52137f84c9d4e0",
    dn: "3c858a4f8f0ba792635f5bc03fd6e0e7450eb7c853147972529d72cf5ae45c43" },
  2: { topology: "80ea59d739c3a327e1242c67ae9b400f4d393b8acd202ec4a26e9e737f1123c0",
    up: "000c341909c1628f0664b50beef60d232cfae21e38b474467689fddf3b7ad1d8",
    dn: "3b0189ee63f54f313284d0ead497da9a1bb804e7c60499f2c18cf2b27c972dde" },
  3: { topology: "844329649f860449b84e34e2af3841a16387fd39c9b313593bfc850f479eddf7",
    up: "092c4041cffaea99c9dff56671dda2d0de025ced143d1effdcff95c89cb1d42b",
    dn: "a2a3d8ad68decc30222d431eb437799d011cdf3d7f60bff8db2f417300b20bd5" },
};

test("파일별 인코딩(EUC-KR·UTF-8 BOM·UTF-8)을 역명 손상 없이 정규화한다", () => {
  // EUC-KR(cp949)로 인코딩된 "역코드"(bf aa c4 da b5 e5)는 UTF-8로 유효하지 않아 cp949 fallback으로 복원된다.
  assert.equal(decodeOfficialCsv(Buffer.from("bfaac4dab5e5", "hex")), "역코드");
  // UTF-8 BOM은 제거하고, BOM 없는 UTF-8은 그대로 읽는다.
  assert.equal(decodeOfficialCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("역명", "utf8")])), "역명");
  assert.equal(decodeOfficialCsv(Buffer.from("역명", "utf8")), "역명");
  assert.throws(() => decodeOfficialCsv(Buffer.alloc(0)), /required/);
});

test("환승역 접미 숫자·괄호 부기·축약형을 정본 역명으로 정규화한다", () => {
  assert.equal(normalizedStationName("반월당1"), normalizedStationName("반월당"));
  assert.equal(normalizedStationName("청라언덕2"), normalizedStationName("청라언덕3"));
  assert.equal(normalizedStationName("명덕(2.28민주운동기념회관)"), normalizedStationName("명덕3"));
  assert.equal(normalizedStationName("성서산업단지"), normalizedStationName("성서산단"));
  assert.equal(normalizedStationName("대곡(정부대구청사)"), normalizedStationName("대곡"));
});

test("고정된 대구 topology snapshot 6종이 취득 원문·내부 해시·노선 완전성과 일치한다", async () => {
  for (const config of DAEGU_LINES) {
    const topology = await readSnapshot(`daegu-line${config.lineNumber}-route-topology-20260721.json`);
    assert.equal(topology.artifactKind, "daegu-route-topology-snapshot");
    assert.equal(topology.lineId, config.lineId);
    assert.equal(topology.rawSha256, RAW_SHA256[config.lineNumber].topology);
    assert.equal(topology.stationCount, config.stationCount);
    assert.equal(topology.scope.length, config.stationCount);
    assert.equal(topology.edgeCount, config.edgeCount);
    assert.equal(topology.edges.length, config.edgeCount);
    assert.equal(topology.scopeSha256, sha256(JSON.stringify(topology.scope)));
    assert.equal(topology.edgesSha256, sha256(JSON.stringify(topology.edges)));
    assert.equal(topology.contentSha256, sha256(JSON.stringify({ scope: topology.scope, edges: topology.edges })));
    // 인접 edge는 양방향이며 거리가 대칭이고 소요시간이 양수다.
    const distances = new Map();
    for (const edge of topology.edges) {
      assert.ok(Number.isInteger(edge.distanceMeters) && edge.distanceMeters > 0);
      assert.ok(Number.isInteger(edge.durationSeconds) && edge.durationSeconds > 0);
      distances.set([edge.fromStationCode, edge.toStationCode].sort((a, b) => a.localeCompare(b, "en")).join(":"), edge.distanceMeters);
    }
    assert.equal(distances.size, config.edgeCount / 2);
    // 차량기지·비영업 행은 exact tuple로 격리되고 scope에 포함되지 않는다.
    const scopeCodes = new Set(topology.scope.map(({ stationCode }) => stationCode));
    for (const depot of topology.quarantinedDepots) {
      assert.equal(depot.stationType, "차량기지");
      assert.ok(!scopeCodes.has(depot.stationCode));
    }
    assert.equal(topology.depotExcludedCount, topology.quarantinedDepots.length);
  }
});

test("고정된 대구 시각표 snapshot 3종이 취득 원문·trip 완전성·원문 결함 정규화를 고정한다", async () => {
  const expectedDayLabelNormalized = { 1: 0, 2: 55, 3: 0 };
  const expectedRollover = { 1: 12, 2: 9, 3: 6 };
  for (const config of DAEGU_LINES) {
    const timetable = await readSnapshot(`daegu-line${config.lineNumber}-train-timetable-20260721.json`);
    assert.equal(timetable.artifactKind, "daegu-train-timetable-snapshot");
    assert.equal(timetable.lineId, config.lineId);
    assert.equal(timetable.rawUpSha256, RAW_SHA256[config.lineNumber].up);
    assert.equal(timetable.rawDownSha256, RAW_SHA256[config.lineNumber].dn);
    assert.equal(timetable.tripCount, config.tripCount);
    assert.equal(timetable.trips.length, config.tripCount);
    assert.equal(timetable.tripsSha256, sha256(JSON.stringify(timetable.trips)));
    assert.equal(timetable.contentSha256, sha256(JSON.stringify({
      tripsSha256: timetable.tripsSha256, stopTimeCount: timetable.stopTimeCount, stationCount: config.stationCount,
    })));
    assert.deepEqual(timetable.dayCodes, ["WEEK", "SAT", "HOLI"]);
    assert.deepEqual(timetable.directions, ["up", "dn"]);
    // 2호선 하선 파일의 휴일(상) 오라벨 행은 파일 방향(하)으로 정규화한 건수로 고정한다.
    assert.equal(timetable.dayLabelNormalizedCount, expectedDayLabelNormalized[config.lineNumber]);
    // 자정을 넘는 막차만 24시 이후 service second로 rollover 한다.
    assert.equal(timetable.rolloverTripCount, expectedRollover[config.lineNumber]);
    let stopTotal = 0;
    for (const trip of timetable.trips) {
      assert.ok(trip.stops.length >= 2);
      let previous = -1;
      for (const stop of trip.stops) {
        assert.ok(stop.a >= previous && stop.d >= stop.a);
        previous = stop.d;
      }
      stopTotal += trip.stops.length;
    }
    assert.equal(stopTotal, config.stopTimeCount);
  }
});

// 아래부터는 fail-closed 회귀: 실제 원문 CSV 대신 최소 합성 데이터로 parseDaeguRouteTopology·parseDaeguTrainTimetable의
// 개별 throw 분기를 직접 재현한다.
const CAPTURED_AT = "2026-07-21T00:00:00.000Z";

function intervalRow({ code, type = "일반", name, upKm = "1.000", downKm = "1.000" }) {
  return [code, type, name, "", "", "", upKm, downKm, "30", "0:01:00", "0:01:00", "0"];
}

// line 1(35역) 규모의 최소 합성 역 구간정보 CSV. mutateRows로 개별 행을 변조해 실패 분기를 재현한다.
function buildIntervalCsv(lineNumber, mutateRows) {
  const config = DAEGU_LINES.find((line) => line.lineNumber === lineNumber);
  const header = ["역코드", "구분", "역명", "", "", "", "상행거리", "하행거리", "정차시간", "상행소요", "하행소요", "회차"];
  // 이름 끝을 "동"으로 고정해 normalizedStationName의 trailing 숫자·"역" 제거로 서로 다른 역명이
  // 같은 정규화 키로 충돌하지 않게 한다("테스트1역"처럼 끝을 "역"+숫자로 두면 모두 "테스트"로 붕괴한다).
  const rows = Array.from({ length: config.stationCount }, (_, index) => intervalRow({
    code: `T${String(index + 1).padStart(3, "0")}`,
    name: `테스트${index + 1}동`,
  }));
  mutateRows?.(rows);
  return Buffer.from([header, ...rows].map((row) => row.join(",")).join("\n"), "utf8");
}

test("역 구간정보 CSV의 상하행 거리(km)가 비대칭이면 fail-closed한다", () => {
  const bytes = buildIntervalCsv(1, (rows) => { rows[0][7] = "2.000"; }); // downKm(col7)만 변조
  assert.throws(() => parseDaeguRouteTopology(bytes, { lineNumber: 1, capturedAt: CAPTURED_AT }), /distance asymmetry/);
});

test("역 구간정보 CSV에 중복 역 코드가 있으면 fail-closed한다", () => {
  const bytes = buildIntervalCsv(1, (rows) => { rows[1][0] = rows[0][0]; });
  assert.throws(() => parseDaeguRouteTopology(bytes, { lineNumber: 1, capturedAt: CAPTURED_AT }), /duplicate station identity/);
});

test("역 구간정보 CSV 행의 열 수가 헤더와 다르면 CSV column count mismatch로 fail-closed한다", () => {
  const bytes = buildIntervalCsv(1, (rows) => { rows[2].pop(); });
  assert.throws(() => parseDaeguRouteTopology(bytes, { lineNumber: 1, capturedAt: CAPTURED_AT }), /CSV column count mismatch/);
});

const FAKE_TIMETABLE_TOPOLOGY = {
  scope: [
    { stationCode: "T001", stationName: "가나역", sequence: 1 },
    { stationCode: "T002", stationName: "다라역", sequence: 2 },
    { stationCode: "T003", stationName: "마바역", sequence: 3 },
  ],
};

function buildTimetableCsv(header, rows) {
  return Buffer.from([header, ...rows].map((row) => row.join(",")).join("\n"), "utf8");
}

test("시각표 CSV에 topology에 없는 역명이 있으면 unknown station으로 fail-closed한다", () => {
  const header = ["요일", "역명", "비고", "101"];
  const upBytes = buildTimetableCsv(header, [["평일", "없는역", "", "08:00:00"]]);
  const downBytes = buildTimetableCsv(header, []);
  assert.throws(() => parseDaeguTrainTimetable(upBytes, downBytes, FAKE_TIMETABLE_TOPOLOGY,
    { lineNumber: 1, capturedAt: CAPTURED_AT }), /unknown station/);
});

test("시각표 CSV의 동일 열차가 인접하지 않은 역을 건너뛰면 non-contiguous trip으로 fail-closed한다", () => {
  const header = ["요일", "역명", "비고", "101"];
  // seq 1(가나역)과 seq 3(마바역)만 있고 중간 seq 2(다라역)가 빠져 인접하지 않다.
  const upBytes = buildTimetableCsv(header, [
    ["평일", "가나역", "", "08:00:00"],
    ["평일", "마바역", "", "08:05:00"],
  ]);
  const downBytes = buildTimetableCsv(header, []);
  assert.throws(() => parseDaeguTrainTimetable(upBytes, downBytes, FAKE_TIMETABLE_TOPOLOGY,
    { lineNumber: 1, capturedAt: CAPTURED_AT }), /non-contiguous trip/);
});

test("시각표 CSV의 미인식 요일 접두 행은 개별 오류 없이 조용히 제외되고, 집계 trip·stop time 건수 계약이 fail-closed로 잡아낸다", () => {
  const header = ["요일", "역명", "비고", "101"];
  // "임시"는 DAY_PREFIX(평일/토요일/휴일) 어디에도 매칭되지 않아 어떤 day bucket에도 포함되지 않고 조용히 제외된다.
  const upBytes = buildTimetableCsv(header, [
    ["임시", "가나역", "", "08:00:00"],
    ["평일", "다라역", "", "08:05:00"],
  ]);
  const downBytes = buildTimetableCsv(header, []);
  // 미인식 행이 개별적으로 에러를 내지 않으므로, line 1의 실제 기대 trip·stop time 총량 계약(824건/27,514건)과
  // 불일치해 collector 최종 count 검증이 fail-closed로 잡아낸다.
  assert.throws(() => parseDaeguTrainTimetable(upBytes, downBytes, FAKE_TIMETABLE_TOPOLOGY,
    { lineNumber: 1, capturedAt: CAPTURED_AT }), /timetable counts mismatch/);
});
