import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { integrateRegionalTimetables } from "./lib/regional-timetable-integrator.mjs";
import { assertLagIsContentEquivalent } from "./test-fixtures/ledger-lag-equivalence.mjs";
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

// #913·#1005: 광주 정차 시각의 원천은 KRIC 보관본 projection이다. 정기 갱신 PR은 원장 행 추가와 inventory head 교체만 하고, 정본 팩과
// projection은 병합 뒤 source-derivative-rebinding과 후보 갱신이 다시 만든다. 그 사이 팩이 이전 보관 스냅샷에 결속된 것은 정상 상태다.
// 단 뒤처짐은 팩(·projection)이 가리키는 행부터 head까지 경로의 모든 행이 내용상 같을 때만 허용한다(ledger-lag-equivalence.mjs).
// 내용이 바뀌었으면 팩은 head와 같아야 하고 아니면 실패한다. release 게이트(validate-candidate-source-set.mjs 114행)는 후보 원천이
// head와 정확히 같을 것을 내용과 무관하게 요구하며, 이 테스트는 그 게이트를 완화하지 않고 required-pr에서 내용이 같은 재확인만 허용한다.
const RETAINED_SOURCE_ID = "kric-nationwide-timetable-file";

// 광주 정차 시각을 정하는 보관본 내용: 원천 원본 sha256과 계약의 결속 내용(역·노선·서비스·요일 시작·공휴일 날짜).
// 갱신마다 새로 쓰는 확인 창(calendar 시작·종료일, confirmationWindow, 공휴일 증거의 수집 시각·manifest sha)은 내용이 아니라 제외한다.
function retainedContentKey(row) {
  const contract = row.retainedTimetableInputs.contract;
  return JSON.stringify({
    rawSha256: row.rawSha256,
    routeNumber: contract.routeNumber,
    stationBindings: contract.stationBindings,
    excludedEndpointLabels: contract.excludedEndpointLabels,
    routeBindings: contract.routeBindings,
    serviceIds: contract.serviceIds,
    servicePatterns: contract.servicePatterns,
    serviceDayStartSeconds: contract.serviceDayStartSeconds,
    publicHolidayDates: contract.calendar?.publicHolidayDates,
    festivalDates: contract.calendar?.festivalDates,
  });
}

function assertGwangjuStopTimesBoundToRetainedSource({ pack, inventory, ledger, readProjection }) {
  const source = inventory.sources.find(({ id }) => id === RETAINED_SOURCE_ID);
  const headSnapshotId = source.retainedScheduleAdmissionEvidence.snapshotId;
  const rows = new Map(ledger.filter(({ sourceId }) => sourceId === RETAINED_SOURCE_ID).map((row) => [row.snapshotId, row]));
  const projection = readProjection(source.retainedGwangjuProjectionEvidence.snapshotPath);
  const trips = new Map(pack.transitTrips.filter(({ lineId, routeId }) => lineId === GWANGJU.lineId || routeId?.startsWith("route-S2901-"))
    .map((trip) => [trip.id, trip]));
  assert.ok(trips.size > 0);
  const stops = pack.transitStopTimes.filter(({ tripId }) => trips.has(tripId));
  assert.ok(stops.length > 0);

  // 팩의 결속: 광주 trip 전부가 같은 보관 스냅샷 하나를 가리키고, 그 스냅샷부터 head까지 내용이 같아야 한다.
  const packSnapshotIds = new Set([...trips.values()].map(({ sourceSnapshotId }) => sourceSnapshotId));
  assert.equal(packSnapshotIds.size, 1, `광주 trip은 보관 스냅샷 하나에 결속돼야 한다: ${[...packSnapshotIds].join(", ")}`);
  const [packSnapshotId] = packSnapshotIds;
  assertLagIsContentEquivalent({
    ledger, sourceId: RETAINED_SOURCE_ID, snapshotId: packSnapshotId, headSnapshotId, contentKeyOf: retainedContentKey, label: "팩",
  });
  const packRow = rows.get(packSnapshotId);

  // projection의 결속: projection이 만든 보관 스냅샷도 같은 규칙으로 head와 내용이 같아야 하고, projection이 읽은 records의 sha256은
  // head 증거(inventory)가 기록한 recordsSha256과 같아야 한다. 원장 행에는 행별 recordsSha256이 없고, 같은 원본·같은 계약이면 records도 같다.
  assertLagIsContentEquivalent({
    ledger, sourceId: RETAINED_SOURCE_ID, snapshotId: projection.retainedSnapshotId, headSnapshotId, contentKeyOf: retainedContentKey, label: "projection",
  });
  assert.equal(projection.observationRecordsSha256, source.retainedScheduleAdmissionEvidence.recordsSha256,
    "projection이 읽은 records의 sha256은 head 증거의 recordsSha256과 같아야 한다");

  const contract = packRow.retainedTimetableInputs.contract;
  const weekdayTypeByServiceId = new Map(Object.entries(contract.serviceIds).map(([weekdayType, serviceId]) => [serviceId, weekdayType]));
  const labelByStationId = new Map(contract.stationBindings.map(({ stationId, sourceLabel }) => [stationId, sourceLabel]));
  const seconds = (value) => { const [h, m, s] = value.split(":").map(Number); return h * 3600 + m * 60 + s; };
  const official = new Set(projection.records.flatMap((record) => [record.arrivalTime, record.departureTime]
    .filter((cell) => /^\d{2}:\d{2}:\d{2}$/u.test(cell?.value ?? ""))
    // 자정 뒤 정차는 운행일 기준으로 86,400초를 더한 값일 수 있다.
    .flatMap((cell) => [0, 86_400].map((offset) => `${record.trainNumber}|${record.weekdayType}|${record.stationName}|${seconds(cell.value) + offset}`))));
  for (const stop of stops) {
    const trip = trips.get(stop.tripId);
    const weekdayType = weekdayTypeByServiceId.get(trip.serviceId);
    const label = labelByStationId.get(stop.stationId);
    for (const value of [stop.arrivalSeconds, stop.departureSeconds]) {
      assert.ok(official.has(`${trip.trainNo}|${weekdayType}|${label}|${value}`),
        `광주 정차 ${trip.trainNo} ${weekdayType} ${label} ${value}초는 보관본 원천 행 값이어야 한다`);
    }
  }
}

const gwangjuBindingInputs = () => ({
  pack: activePackOf(readJson("tools/datapack/release/nationwide-production-canonical-pack.json")),
  inventory: readJson("tools/datapack/source-inventory.json"),
  ledger: readJson("tools/datapack/release/source-snapshots.json"),
  readProjection: readJson,
});

// 정기 갱신(register-retained-kric-timetable)이 만드는 변화만 흉내 낸다: 원장 행 추가, inventory head 교체. 팩·projection은 그대로다.
// mutate는 새 head 행을 바꾼다(기본: 내용 변화 없이 재확인만 한 갱신).
function withRetainedRefresh({ inventory, ledger, ...rest }, suffix = "f", mutate = (row) => row) {
  const source = inventory.sources.find(({ id }) => id === RETAINED_SOURCE_ID);
  const head = ledger.find(({ snapshotId }) => snapshotId === source.retainedScheduleAdmissionEvidence.snapshotId);
  const refreshed = mutate({ ...structuredClone(head), snapshotId: `${RETAINED_SOURCE_ID}-${suffix.repeat(64)}`, previousSnapshotId: head.snapshotId, observedAt: "2099-01-01T00:00:00.000Z" });
  const nextInventory = { ...inventory, sources: inventory.sources.map((entry) => entry.id !== RETAINED_SOURCE_ID ? entry : {
    ...entry, retainedScheduleAdmissionEvidence: { ...entry.retainedScheduleAdmissionEvidence, snapshotId: refreshed.snapshotId } }) };
  return { ...rest, inventory: nextInventory, ledger: [...ledger, refreshed] };
}

const changeRawSha = (row) => ({ ...row, rawSha256: "3".repeat(64) });
// 계약의 결속 내용 한 항목만 바꾼 행.
const changeContractField = (field) => (row) => {
  const next = structuredClone(row);
  next.retainedTimetableInputs.contract[field] = { changedByTest: field };
  return next;
};
const CONTRACT_CONTENT_FIELDS = ["routeNumber", "stationBindings", "excludedEndpointLabels", "routeBindings", "serviceIds", "servicePatterns", "serviceDayStartSeconds"];
const changeCalendarDates = (field) => (row) => {
  const next = structuredClone(row);
  next.retainedTimetableInputs.contract.calendar = { ...next.retainedTimetableInputs.contract.calendar, [field]: ["20991225"] };
  return next;
};
// 갱신마다 새로 쓰는 확인 창만 바뀐 행(실제 #1004가 이렇다).
const shiftConfirmationWindow = (row) => {
  const next = structuredClone(row);
  const contract = next.retainedTimetableInputs.contract;
  contract.calendar = { ...contract.calendar, startDate: "20991231", endDate: "21000107" };
  contract.confirmationWindow = { observedAt: "2099-01-01T00:00:00.000Z", expiresAt: "2099-01-08T00:00:00.000Z" };
  contract.holidayCalendarEvidence = { ...contract.holidayCalendarEvidence, manifestSha256: "4".repeat(64) };
  return next;
};

test("커밋된 전국 정본 팩의 광주 정차 시각은 KRIC 보관본 projection 행의 도착·출발 값이다(#913)", () => {
  assertGwangjuStopTimesBoundToRetainedSource(gwangjuBindingInputs());
});

test("광주 보관 시간표 정기 갱신(원장 행 추가·inventory head 교체)은 내용이 같으면 팩 결속 계약을 깨지 않는다(#1005)", () => {
  const refreshed = withRetainedRefresh(gwangjuBindingInputs());
  assertGwangjuStopTimesBoundToRetainedSource(refreshed);
  // 갱신이 두 번 이어져도(확인 창만 바뀐 갱신 포함) 경로의 모든 행이 내용상 같다.
  assertGwangjuStopTimesBoundToRetainedSource(withRetainedRefresh(refreshed, "e", shiftConfirmationWindow));
});

test("광주 팩 결속 계약은 실제 결속 불일치를 계속 거부한다(#1005 반례, release 게이트 validate-candidate-source-set.mjs 114행과 같은 방향)", () => {
  const inputs = gwangjuBindingInputs();
  const gwangjuTripIds = new Set(inputs.pack.transitTrips.filter(({ lineId, routeId }) => lineId === GWANGJU.lineId || routeId?.startsWith("route-S2901-")).map(({ id }) => id));
  const withTrips = (mutate) => ({ ...inputs, pack: { ...inputs.pack, transitTrips: inputs.pack.transitTrips.map((trip) => gwangjuTripIds.has(trip.id) ? mutate(trip) : trip) } });
  const ledgerRowOf = (snapshotId) => inputs.ledger.find((row) => row.snapshotId === snapshotId);
  const [{ sourceSnapshotId: packSnapshotId }] = inputs.pack.transitTrips.filter(({ id }) => gwangjuTripIds.has(id));
  const orphan = { ...structuredClone(ledgerRowOf(packSnapshotId)), snapshotId: `${RETAINED_SOURCE_ID}-${"1".repeat(64)}`, previousSnapshotId: null };
  const missing = `${RETAINED_SOURCE_ID}-${"0".repeat(64)}`;

  // 팩이 원장에 없는 스냅샷을 가리킨다.
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(withTrips((trip) => ({ ...trip, sourceSnapshotId: missing }))), /LAG_NOT_IN_LEDGER: 팩/u);
  // 팩이 head 경로 밖의 원장 행을 가리킨다.
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource({ ...withTrips((trip) => ({ ...trip, sourceSnapshotId: orphan.snapshotId })), ledger: [...inputs.ledger, orphan] }), /LAG_OFF_CHAIN: 팩/u);
  // 광주 trip이 서로 다른 스냅샷에 걸친다.
  let first = true;
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(withTrips((trip) => {
    if (!first) return trip;
    first = false;
    return { ...trip, sourceSnapshotId: missing };
  })), /하나에 결속/u);

  // 낡은 팩: 경로 중간 행의 원천 원본이 바뀌었다. 뒤의 head가 팩과 같아 보여도 실패해야 한다.
  const midChanged = withRetainedRefresh(withRetainedRefresh(inputs, "d", changeRawSha), "e");
  midChanged.ledger.at(-1).rawSha256 = ledgerRowOf(packSnapshotId).rawSha256;
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(midChanged), /LAG_CONTENT_CHANGED: 팩/u);
  // 낡은 팩: head의 원천 원본이 바뀌었다.
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(withRetainedRefresh(inputs, "f", changeRawSha)), /LAG_CONTENT_CHANGED: 팩/u);
  // 낡은 팩: 중간 행의 계약 결속 내용(항목마다)이나 공휴일 날짜가 바뀌었다.
  for (const field of CONTRACT_CONTENT_FIELDS) {
    assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(withRetainedRefresh(withRetainedRefresh(inputs, "d", changeContractField(field)), "e")), /LAG_CONTENT_CHANGED: 팩/u, field);
  }
  for (const field of ["publicHolidayDates", "festivalDates"]) {
    assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(withRetainedRefresh(withRetainedRefresh(inputs, "d", changeCalendarDates(field)), "e")), /LAG_CONTENT_CHANGED: 팩/u, field);
  }

  // projection이 head 경로 밖의 원장 행을 가리킨다.
  const projectionOf = (retainedSnapshotId, extra = {}) => ({ ...inputs, readProjection: (relative) => ({ ...readJson(relative), retainedSnapshotId, ...extra }) });
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource({ ...projectionOf(orphan.snapshotId), ledger: [...inputs.ledger, orphan] }), /LAG_OFF_CHAIN: projection/u);
  // projection이 원장에 없는 스냅샷을 가리킨다.
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(projectionOf(missing)), /LAG_NOT_IN_LEDGER: projection/u);
  // 낡은 projection: 팩은 내용이 바뀐 새 head로 다시 만들어졌지만 projection은 이전 보관 스냅샷에 남았다.
  const changedHead = withRetainedRefresh(inputs, "d", changeRawSha);
  const changedHeadId = changedHead.ledger.at(-1).snapshotId;
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource({
    ...changedHead,
    pack: { ...inputs.pack, transitTrips: inputs.pack.transitTrips.map((trip) => gwangjuTripIds.has(trip.id) ? { ...trip, sourceSnapshotId: changedHeadId } : trip) },
  }), /LAG_CONTENT_CHANGED: projection/u);
  // projection이 읽은 records의 sha256이 head 증거의 recordsSha256과 다르다.
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(projectionOf(inputs.inventory.sources.find(({ id }) => id === RETAINED_SOURCE_ID).retainedGwangjuProjectionEvidence.retainedSnapshotId, { observationRecordsSha256: "5".repeat(64) })), /recordsSha256/u);

  // 정차 시각이 projection 값과 다르다.
  const target = inputs.pack.transitStopTimes.findIndex(({ tripId }) => gwangjuTripIds.has(tripId));
  const shifted = { ...inputs, pack: { ...inputs.pack, transitStopTimes: inputs.pack.transitStopTimes.map((stop, index) => (
    index === target ? { ...stop, arrivalSeconds: stop.arrivalSeconds + 1 } : stop)) } };
  assert.throws(() => assertGwangjuStopTimesBoundToRetainedSource(shifted), /보관본 원천 행 값/u);
});
