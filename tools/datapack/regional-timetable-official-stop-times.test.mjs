import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { integrateRegionalTimetables } from "./lib/regional-timetable-integrator.mjs";
import { HOLIDAYS_2026 } from "./materialize-incheon-timetable.mjs";

// #855: 대전·광주 시간표 통합(#814)이 공식 원천에 없는 도착 시각을 만들었다.
// - 중간역 도착 = max(앞역 출발 + 30, 이 역 출발 - 20)
// - 종착역 도착 = 마지막 출발 + 120(대전)·180/120(광주)
// 두 원천(대전 getAllTimeTable, 광주 사이버스테이션 시간표)은 역·방향·요일별 시각 하나만 준다.
// 정차 시각 하나는 데이터팩 계약(reconstruct-transit-trips, 부산 통합)대로 도착 = 출발 = 원천 값이다.
// 원천 시각이 없는 정차(종착역)는 만들지 않고, 원천 정차 2개 이상으로 열차를 만들 수 없는
// 원천 시각은 격리 증거로 남긴다.

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const QUARANTINE_REASON = "FEWER_THAN_TWO_SOURCE_STOPS";

const DAEJEON = Object.freeze({
  sourceId: "daejeon-train-timetable",
  lineId: "line-7051a9c2525c",
  timetablePath: "tools/datapack/sources/daejeon-train-timetable-20260909.json",
  accessibilityPath: "tools/datapack/sources/daejeon-transportation-accessibility-31ef85c5ac5d279d7322c028e05f7be16e6c5a794aa313aef314eef076b61426-20260909.json",
  dayKeyByServiceId: { "daejeon-weekday-2026": "0", "daejeon-holiday-2026": "1" },
  directionByDirectionId: { 0: "1", 1: "0" },
});

const GWANGJU = Object.freeze({
  sourceId: "gwangju-transportation-cyberstation-timetable",
  lineId: "line-e57a361e8892",
  timetablePath: "tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json",
  accessibilityPath: "tools/datapack/sources/gwangju-transportation-accessibility-a39793ed95d7f0075fa0fd58378e651823d9c1ed752ac310a86c853f8853f521-20260909.json",
  dayKeyByServiceId: { "gwangju-weekday-2026": "WEEK", "gwangju-holiday-2026": "DAYOFF" },
  directionByDirectionId: { 0: "st", 1: "pd" },
});

// 원천 행 → (요일 키, 방향, 역 코드)별 시각(초) 목록.
function daejeonSourceTimes(timetable) {
  const times = new Map();
  for (const row of timetable.rows) {
    const hour = Number.parseInt(row.tmZone, 10);
    for (const minute of String(row.tmList ?? "").trim().split(/\s+/).filter(Boolean)) {
      const key = `${row.dayType}|${row.drctType}|${row.stNum}`;
      times.set(key, [...(times.get(key) ?? []), hour * 3600 + Number.parseInt(minute, 10) * 60]);
    }
  }
  return times;
}

function gwangjuSourceTimes(timetable) {
  const times = new Map();
  for (const row of timetable.rows) {
    if (!Object.values(GWANGJU.dayKeyByServiceId).includes(row.dayCode)) continue;
    if (!Object.values(GWANGJU.directionByDirectionId).includes(row.direction)) continue;
    const key = `${row.dayCode}|${row.direction}|${row.stationCode}`;
    const seconds = Number.parseInt(row.time.slice(0, 2), 10) * 3600 + Number.parseInt(row.time.slice(2, 4), 10) * 60;
    times.set(key, [...(times.get(key) ?? []), seconds]);
  }
  return times;
}

// 원천 역 코드 → 팩 stationId. 접근성 원천의 코드·역명과 팩 역명을 이름으로만 대조한다.
function stationIdByCode(pack, accessibility, lineId) {
  const normalize = (name) => String(name ?? "").replace(/\(.*?\)/g, "").trim().replace(/역$/, "");
  const onLine = new Set(pack.stationLines.filter((row) => row.lineId === lineId).map((row) => row.stationId));
  const idByName = new Map(pack.stations.filter(({ id }) => onLine.has(id)).map(({ id, nameKo }) => [normalize(nameKo), id]));
  const mapping = new Map();
  for (const row of accessibility.rows) {
    if (row.lineId !== lineId || !row.stationCode) continue;
    const stationId = idByName.get(normalize(row.stationName));
    assert.ok(stationId, `${lineId} 원천 역 ${row.stationCode}(${row.stationName})이 팩 역과 대응해야 한다`);
    mapping.set(String(row.stationCode), stationId);
  }
  return mapping;
}

function totalSourceDepartures(sourceTimes) {
  let total = 0;
  for (const times of sourceTimes.values()) total += times.length;
  return total;
}

// 팩 정차 시각이 모두 원천 값(도착 = 출발 = 원천 시각)인지, 원천 시각이 두 번 쓰이지 않는지 검사한다.
function sourceViolations({ trips, stopTimes, sourceTimes, codeByStationId, region }) {
  const tripById = new Map(trips.map((trip) => [trip.id, trip]));
  const remaining = new Map([...sourceTimes].map(([key, times]) => [key, [...times]]));
  const violations = [];
  for (const stop of stopTimes) {
    const trip = tripById.get(stop.tripId);
    const dayKey = region.dayKeyByServiceId[trip?.serviceId];
    const direction = region.directionByDirectionId[trip?.directionId];
    const code = codeByStationId.get(stop.stationId);
    if (stop.arrivalSeconds !== stop.departureSeconds) {
      violations.push(`${stop.tripId}#${stop.stopSequence} 도착 ${stop.arrivalSeconds} != 출발 ${stop.departureSeconds}`);
      continue;
    }
    const pool = remaining.get(`${dayKey}|${direction}|${code}`);
    const index = pool ? pool.indexOf(stop.departureSeconds) : -1;
    if (index === -1) {
      violations.push(`${stop.tripId}#${stop.stopSequence} ${code ?? stop.stationId} ${stop.departureSeconds}초는 원천 행에 없다`);
      continue;
    }
    pool.splice(index, 1);
  }
  return { violations, remaining };
}

function loadRegion(region) {
  const timetable = readJson(region.timetablePath);
  const accessibility = readJson(region.accessibilityPath);
  return { timetable, accessibility };
}

function integrateFromSources(finalPack) {
  const daejeon = loadRegion(DAEJEON);
  const gwangju = loadRegion(GWANGJU);
  return integrateRegionalTimetables({
    finalPack,
    holidayDates: HOLIDAYS_2026,
    daejeonTimetable: daejeon.timetable,
    daejeonAccessibility: daejeon.accessibility,
    gwangjuTimetable: gwangju.timetable,
    gwangjuAccessibility: gwangju.accessibility,
  });
}

function activePackOf(fixture) {
  const matches = (fixture.packs ?? []).filter(({ id }) => id === fixture.manifest?.activePack?.id);
  assert.equal(matches.length, 1, "manifest.activePack.id는 정확히 한 팩과 맞아야 한다");
  return matches[0];
}

// --- 합성 원천: 규칙만 좁게 고정한다 --------------------------------------------------------

function syntheticPack(lineId, stations) {
  return {
    stations: stations.map(([, name], index) => ({ id: `st-${lineId}-${index}`, nameKo: name })),
    stationLines: stations.map((_, index) => ({ stationId: `st-${lineId}-${index}`, lineId })),
    transitRoutes: [],
    transitTrips: [],
    transitStopTimes: [],
    serviceCalendars: [],
    serviceCalendarDates: [],
  };
}

const DAEJEON_SYNTHETIC_STATIONS = [
  ["101", "판암"], ["102", "신흥"], ["103", "대동"], ["104", "대전"],
  ["110", "탄방"], ["111", "시청"], ["122", "반석"],
];

test("대전: 원천 출발 시각 하나만 있는 역은 도착 = 출발 = 원천 값이고 종착역 도착을 만들지 않는다", () => {
  const finalPack = syntheticPack(DAEJEON.lineId, DAEJEON_SYNTHETIC_STATIONS);
  const daejeonAccessibility = {
    rows: DAEJEON_SYNTHETIC_STATIONS.map(([code, name]) => ({ lineId: DAEJEON.lineId, stationCode: code, stationName: name })),
  };
  const daejeonTimetable = {
    rows: [
      { dayType: "0", drctType: "1", stNum: "101", tmZone: "5", tmList: "30" },
      { dayType: "0", drctType: "1", stNum: "102", tmZone: "5", tmList: "32" },
      { dayType: "0", drctType: "1", stNum: "103", tmZone: "5", tmList: "34" },
      // 뒤 역과 이어지지 않는 단독 출발: 열차를 만들 수 없으니 격리한다.
      { dayType: "0", drctType: "1", stNum: "110", tmZone: "10", tmList: "00" },
    ],
  };
  const integrated = integrateRegionalTimetables({ finalPack, holidayDates: HOLIDAYS_2026, daejeonTimetable, daejeonAccessibility });
  const stops = integrated.transitStopTimes.filter(({ sourceId }) => sourceId === DAEJEON.sourceId);
  const stationId = (code) => `st-${DAEJEON.lineId}-${DAEJEON_SYNTHETIC_STATIONS.findIndex(([c]) => c === code)}`;

  assert.deepEqual(
    stops.map(({ stationId: id, stopSequence, arrivalSeconds, departureSeconds }) => ({ id, stopSequence, arrivalSeconds, departureSeconds })),
    [
      { id: stationId("101"), stopSequence: 1, arrivalSeconds: 5 * 3600 + 30 * 60, departureSeconds: 5 * 3600 + 30 * 60 },
      { id: stationId("102"), stopSequence: 2, arrivalSeconds: 5 * 3600 + 32 * 60, departureSeconds: 5 * 3600 + 32 * 60 },
      { id: stationId("103"), stopSequence: 3, arrivalSeconds: 5 * 3600 + 34 * 60, departureSeconds: 5 * 3600 + 34 * 60 },
    ],
  );
  assert.equal(stops.some(({ stationId: id }) => id === stationId("122")), false, "원천 시각이 없는 종착역(반석) 정차를 만들지 않는다");
  assert.equal(integrated.transitTrips.filter(({ sourceId }) => sourceId === DAEJEON.sourceId).length, 1);
  assert.deepEqual(integrated.regionalTimetableQuarantine, [{
    sourceId: DAEJEON.sourceId,
    serviceId: "daejeon-weekday-2026",
    sourceDayKey: "0",
    sourceDirection: "1",
    stationCode: "110",
    stationId: stationId("110"),
    departureSeconds: 10 * 3600,
    reason: QUARANTINE_REASON,
  }]);
});

const GWANGJU_SYNTHETIC_STATIONS = [
  ["100", "녹동"], ["101", "소태"], ["105", "금남로4가"], ["117", "광주송정"],
  ["118", "도산"], ["119", "평동"],
];

test("광주: 원천 시각 하나만 있는 역은 도착 = 출발 = 원천 값이고 종착역 도착을 만들지 않는다", () => {
  const finalPack = syntheticPack(GWANGJU.lineId, GWANGJU_SYNTHETIC_STATIONS);
  const gwangjuAccessibility = {
    rows: GWANGJU_SYNTHETIC_STATIONS.map(([code, name]) => ({ lineId: GWANGJU.lineId, stationCode: code, stationName: name })),
  };
  const row = (stationCode, time) => ({ dayCode: "WEEK", direction: "st", stationCode, time });
  const gwangjuTimetable = {
    rows: [
      row("119", "0530"), row("118", "0533"), row("117", "0535"),
      // 녹동 단독 출발(평동 방향): 뒤 역과 이어지지 않는다.
      { dayCode: "WEEK", direction: "pd", stationCode: "100", time: "0614" },
    ],
  };
  const integrated = integrateRegionalTimetables({ finalPack, holidayDates: HOLIDAYS_2026, gwangjuTimetable, gwangjuAccessibility });
  const stops = integrated.transitStopTimes.filter(({ sourceId }) => sourceId === GWANGJU.sourceId);
  const stationId = (code) => `st-${GWANGJU.lineId}-${GWANGJU_SYNTHETIC_STATIONS.findIndex(([c]) => c === code)}`;

  assert.deepEqual(
    stops.map(({ stationId: id, stopSequence, arrivalSeconds, departureSeconds }) => ({ id, stopSequence, arrivalSeconds, departureSeconds })),
    [
      { id: stationId("119"), stopSequence: 1, arrivalSeconds: 5 * 3600 + 30 * 60, departureSeconds: 5 * 3600 + 30 * 60 },
      { id: stationId("118"), stopSequence: 2, arrivalSeconds: 5 * 3600 + 33 * 60, departureSeconds: 5 * 3600 + 33 * 60 },
      { id: stationId("117"), stopSequence: 3, arrivalSeconds: 5 * 3600 + 35 * 60, departureSeconds: 5 * 3600 + 35 * 60 },
    ],
  );
  assert.equal(stops.some(({ stationId: id }) => id === stationId("101")), false, "원천 시각이 없는 종착역(소태) 정차를 만들지 않는다");
  assert.equal(integrated.transitTrips.filter(({ sourceId }) => sourceId === GWANGJU.sourceId).length, 1);
  assert.deepEqual(integrated.regionalTimetableQuarantine, [{
    sourceId: GWANGJU.sourceId,
    serviceId: "gwangju-weekday-2026",
    sourceDayKey: "WEEK",
    sourceDirection: "pd",
    stationCode: "100",
    stationId: stationId("100"),
    departureSeconds: 6 * 3600 + 14 * 60,
    reason: QUARANTINE_REASON,
  }]);
});

// --- 실제 공식 원천 스냅샷 -------------------------------------------------------------------

function regionContext({ region, trips, stopTimes, pack }) {
  const accessibility = readJson(region.accessibilityPath);
  const codeByStationId = new Map([...stationIdByCode(pack, accessibility, region.lineId)].map(([code, id]) => [id, code]));
  const regionStops = stopTimes.filter(({ sourceId }) => sourceId === region.sourceId);
  const regionTrips = trips.filter(({ sourceId }) => sourceId === region.sourceId);
  assert.ok(regionTrips.length > 0, `${region.sourceId} 열차가 있어야 한다`);
  return { codeByStationId, regionStops, regionTrips };
}

// 1) 모든 정차 시각이 원천 값이다. 반환값은 팩에 쓰이지 않은 원천 시각.
function assertStopTimesFromSource({ region, sourceTimes, trips, stopTimes, pack }) {
  const { codeByStationId, regionStops, regionTrips } = regionContext({ region, trips, stopTimes, pack });
  const { violations, remaining } = sourceViolations({ trips: regionTrips, stopTimes: regionStops, sourceTimes, codeByStationId, region });
  assert.deepEqual(violations.slice(0, 20), [], `${region.sourceId} 정차 시각 ${violations.length}건이 원천 값과 다르다`);
  return { codeByStationId, regionStops, remaining };
}

// 2) 쓰이지 않은 원천 시각은 모두 격리 증거에 있고, 격리 행은 쓰이지 않은 원천 시각이다.
function assertUnusedSourceQuarantined({ region, sourceTimes, quarantine, codeByStationId, regionStops, remaining }) {
  const regionQuarantine = quarantine.filter(({ sourceId }) => sourceId === region.sourceId);
  for (const row of regionQuarantine) {
    assert.equal(row.reason, QUARANTINE_REASON);
    assert.equal(codeByStationId.get(row.stationId), row.stationCode);
    const pool = remaining.get(`${row.sourceDayKey}|${row.sourceDirection}|${row.stationCode}`);
    const index = pool ? pool.indexOf(row.departureSeconds) : -1;
    assert.notEqual(index, -1, `격리 행 ${JSON.stringify(row)}은 팩에 쓰이지 않은 원천 시각이어야 한다`);
    pool.splice(index, 1);
  }
  const leftovers = [...remaining].filter(([, times]) => times.length > 0);
  assert.deepEqual(leftovers.slice(0, 10), [], `${region.sourceId} 원천 시각이 팩과 격리 증거 어디에도 없다`);
  assert.equal(regionStops.length + regionQuarantine.length, totalSourceDepartures(sourceTimes));
}

test("실제 대전·광주 공식 원천으로 통합한 모든 정차 시각은 원천 값이고 남은 원천 시각은 격리된다", () => {
  const capital = activePackOf(readJson("tools/datapack/release/capital-production-canonical-pack.json"));
  const integrated = integrateFromSources(capital);
  const regions = [
    [DAEJEON, daejeonSourceTimes(readJson(DAEJEON.timetablePath))],
    [GWANGJU, gwangjuSourceTimes(readJson(GWANGJU.timetablePath))],
  ];
  const checked = regions.map(([region, sourceTimes]) => ({
    region,
    sourceTimes,
    ...assertStopTimesFromSource({ region, sourceTimes, trips: integrated.transitTrips, stopTimes: integrated.transitStopTimes, pack: capital }),
  }));
  const quarantine = integrated.regionalTimetableQuarantine;
  assert.ok(Array.isArray(quarantine), "통합 결과는 regionalTimetableQuarantine 배열을 가져야 한다");
  for (const context of checked) assertUnusedSourceQuarantined({ ...context, quarantine });
});

test("커밋된 전국 정본 팩의 대전 정차 시각은 원천 값이고 격리 증거 파일과 맞는다", async () => {
  const pack = activePackOf(readJson("tools/datapack/release/nationwide-production-canonical-pack.json"));
  // #913: 광주는 cyberstation이 아니라 KRIC 보관본에서 만든다(아래 별도 테스트).
  const regions = [
    [DAEJEON, daejeonSourceTimes(readJson(DAEJEON.timetablePath))],
  ];
  const checked = regions.map(([region, sourceTimes]) => ({
    region,
    sourceTimes,
    ...assertStopTimesFromSource({ region, sourceTimes, trips: pack.transitTrips, stopTimes: pack.transitStopTimes, pack }),
  }));

  const { REGIONAL_TIMETABLE_QUARANTINE_PATH } = await import("./prepare-nationwide-candidate-run.mjs");
  assert.equal(typeof REGIONAL_TIMETABLE_QUARANTINE_PATH, "string", "REGIONAL_TIMETABLE_QUARANTINE_PATH export");
  const evidence = readJson(REGIONAL_TIMETABLE_QUARANTINE_PATH);
  assert.equal(evidence.artifactKind, "datapack-regional-timetable-quarantine");
  assert.equal(evidence.issue, "https://github.com/AquilaXk/easysubway-data/issues/855");
  assert.equal(evidence.summary.quarantinedCount, evidence.rows.length);
  for (const context of checked) {
    const { region, sourceTimes, regionStops } = context;
    const source = evidence.sources.find(({ sourceId }) => sourceId === region.sourceId);
    assert.ok(source, `${region.sourceId} 원천 기록이 있어야 한다`);
    assert.equal(source.rawSha256, readJson(region.timetablePath).rawSha256);
    assert.equal(source.admittedStopTimeCount, regionStops.length);
    assert.equal(source.admittedStopTimeCount + source.quarantinedCount, totalSourceDepartures(sourceTimes));
    assertUnusedSourceQuarantined({ ...context, quarantine: evidence.rows });
  }
});

test("커밋된 전국 정본 팩의 광주 정차 시각은 KRIC 보관본 projection 행의 도착·출발 값이다(#913)", async () => {
  const pack = activePackOf(readJson("tools/datapack/release/nationwide-production-canonical-pack.json"));
  const inventory = readJson("tools/datapack/source-inventory.json");
  const ledger = readJson("tools/datapack/release/source-snapshots.json");
  const source = inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file");
  const projection = readJson(source.retainedGwangjuProjectionEvidence.snapshotPath);
  const head = ledger.find(({ snapshotId }) => snapshotId === source.retainedScheduleAdmissionEvidence.snapshotId);
  const contract = head.retainedTimetableInputs.contract;
  const weekdayTypeByServiceId = new Map(Object.entries(contract.serviceIds).map(([weekdayType, serviceId]) => [serviceId, weekdayType]));
  const labelByStationId = new Map(contract.stationBindings.map(({ stationId, sourceLabel }) => [stationId, sourceLabel]));
  const seconds = (value) => { const [h, m, s] = value.split(":").map(Number); return h * 3600 + m * 60 + s; };
  const official = new Set(projection.records.flatMap((record) => [record.arrivalTime, record.departureTime]
    .filter((cell) => /^\d{2}:\d{2}:\d{2}$/u.test(cell?.value ?? ""))
    // 자정 뒤 정차는 운행일 기준으로 86,400초를 더한 값일 수 있다.
    .flatMap((cell) => [0, 86_400].map((offset) => `${record.trainNumber}|${record.weekdayType}|${record.stationName}|${seconds(cell.value) + offset}`))));
  const trips = new Map(pack.transitTrips.filter(({ lineId, routeId }) => lineId === GWANGJU.lineId || routeId?.startsWith("route-S2901-"))
    .map((trip) => [trip.id, trip]));
  assert.ok(trips.size > 0);
  const stops = pack.transitStopTimes.filter(({ tripId }) => trips.has(tripId));
  assert.ok(stops.length > 0);
  for (const stop of stops) {
    const trip = trips.get(stop.tripId);
    assert.equal(trip.sourceSnapshotId, source.retainedScheduleAdmissionEvidence.snapshotId);
    const weekdayType = weekdayTypeByServiceId.get(trip.serviceId);
    const label = labelByStationId.get(stop.stationId);
    for (const value of [stop.arrivalSeconds, stop.departureSeconds]) {
      assert.ok(official.has(`${trip.trainNo}|${weekdayType}|${label}|${value}`),
        `광주 정차 ${trip.trainNo} ${weekdayType} ${label} ${value}초는 보관본 원천 행 값이어야 한다`);
    }
  }
});
