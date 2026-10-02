import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXTERNAL_STOP_TIMES_KEY, expandExternalStopTimes } from "./lib/external-stop-times.mjs";
import { prepareNationwideCandidate } from "./prepare-nationwide-candidate-run.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const COMMITTED_PACK = "tools/datapack/release/nationwide-production-canonical-pack.json";
const CAPITAL_REPORT = "tools/datapack/release/nationwide-capital-timetable-report.json";

// #899: 전국 후보 팩에 수도권 공식 시간표(KRIC 전체_도시철도운행정보, 정차 순서 명시 노선)가 실려야 한다.
// seq 124는 수도권 4호선 pilot(상록수·사당 2정차)만 있어 신도림→강남 canary가 후보 0개였다.

// 대상 노선과 대표 역 쌍(같은 trip이 앞 역에서 출발해 뒤 역에 도착). 첫 쌍은 platform canary probe와 같다.
const CAPITAL_LINES = Object.freeze([
  { lineId: "line-472a81add377", label: "1호선", pair: ["서울역", "청량리"] },
  { lineId: "seoul-2", label: "2호선", pair: ["신도림", "강남"] },
  { lineId: "line-41a8c75ec9d8", label: "3호선", pair: ["교대", "경복궁"] },
  { lineId: "seoul-4", label: "4호선", pair: ["사당", "서울역"] },
  { lineId: "line-80fc4d5350d4", label: "5호선", pair: ["여의도", "광화문"] },
  { lineId: "line-3f41718e0833", label: "6호선", pair: ["합정", "삼각지"] },
  { lineId: "line-15b3b8a93259", label: "7호선", pair: ["고속터미널", "강남구청"] },
  { lineId: "line-2b2d9eaa53d0", label: "8호선", pair: ["잠실", "가락시장"] },
  { lineId: "line-f0e747248a31", label: "9호선", pair: ["김포공항", "여의도"] },
  { lineId: "shinbundang", label: "신분당선", pair: ["강남", "판교"] },
  { lineId: "line-30886152e4f8", label: "우이신설선", pair: ["신설동", "북한산우이"] },
  { lineId: "line-aefa08ccc0a9", label: "신림선", pair: ["샛강", "관악산"] },
  { lineId: "line-e9e9a5b520a4", label: "공항철도", pair: ["서울역", "김포공항"] },
]);
const CANARY = Object.freeze({ originStationId: "station-6a5e08288b46", destinationStationId: "station-gangnam" });

let prepared;
async function nationwidePack() {
  prepared ??= prepareNationwideCandidate({
    requestedBy: "data-operator-lead",
    approvedBy: "data-release-authority",
    releaseSequence: 125,
    writeFiles: false,
  });
  return (await prepared).finalPack;
}

function tripStops(pack) {
  const byTrip = new Map();
  for (const stopTime of pack.transitStopTimes) {
    if (!byTrip.has(stopTime.tripId)) byTrip.set(stopTime.tripId, []);
    byTrip.get(stopTime.tripId).push(stopTime);
  }
  for (const rows of byTrip.values()) rows.sort((left, right) => left.stopSequence - right.stopSequence);
  return byTrip;
}

function stationIdOnLine(pack, lineId, nameKo) {
  const lineStations = new Set(pack.stationLines.filter((row) => row.lineId === lineId).map(({ stationId }) => stationId));
  const matches = pack.stations.filter((station) => station.nameKo === nameKo && lineStations.has(station.id));
  assert.equal(matches.length, 1, `${lineId} ${nameKo}`);
  return matches[0].id;
}

function servesPair(rows, lineId, fromStationId, toStationId) {
  const from = rows.find((row) => row.lineId === lineId && row.stationId === fromStationId);
  const to = from && rows.find((row) => row.lineId === lineId && row.stationId === toStationId && row.stopSequence > from.stopSequence);
  return Boolean(to) && to.arrivalSeconds > from.departureSeconds;
}

test("#899 수도권 대상 노선마다 평일·주말 공식 trip이 1건 이상 있다", async () => {
  const pack = await nationwidePack();
  const routeLine = new Map(pack.transitRoutes.map(({ id, lineId }) => [id, lineId]));
  const calendars = new Map(pack.serviceCalendars.map((calendar) => [calendar.serviceId, calendar]));
  for (const { lineId, label } of CAPITAL_LINES) {
    const trips = pack.transitTrips.filter(({ routeId }) => routeLine.get(routeId) === lineId);
    assert.ok(trips.length >= 1, `${label} trip 0건`);
    assert.ok(trips.every(({ sourceId }) => sourceId === "kric-nationwide-timetable-file"), `${label} 공식 원천 외 trip`);
    const runs = (day) => trips.some(({ serviceId }) => calendars.get(serviceId)?.[day] === true);
    assert.ok(runs("monday"), `${label} 평일 trip 0건`);
    assert.ok(runs("saturday"), `${label} 토요일 trip 0건`);
    assert.ok(runs("sunday"), `${label} 일요일 trip 0건`);
  }
});

test("#899 대표 역 쌍마다 같은 trip이 앞 역 출발 뒤 뒤 역에 도착하는 stop_times가 있다", async () => {
  const pack = await nationwidePack();
  const byTrip = tripStops(pack);
  for (const { lineId, label, pair } of CAPITAL_LINES) {
    const [from, to] = pair.map((name) => stationIdOnLine(pack, lineId, name));
    const served = [...byTrip.values()].some((rows) => servesPair(rows, lineId, from, to));
    assert.ok(served, `${label} ${pair.join("→")} stop_times 없음`);
  }
  const canary = [...byTrip.values()].some((rows) => servesPair(rows, "seoul-2", CANARY.originStationId, CANARY.destinationStationId));
  assert.ok(canary, "canary 신도림→강남 stop_times 없음");
});

test("#899 4호선 2정차 pilot은 공식 전 노선 시간표로 교체되고 남지 않는다", async () => {
  const pack = await nationwidePack();
  assert.equal(pack.transitRoutes.some(({ id }) => id.startsWith("route-seoul-4-")), false);
  assert.equal(pack.transitTrips.some(({ routeId }) => routeId.startsWith("route-seoul-4-")), false);
  assert.equal(pack.serviceCalendars.some(({ serviceId }) => serviceId.endsWith("-kric")), false);
  assert.equal(pack.serviceCalendarDates.some(({ serviceId }) => serviceId.endsWith("-kric")), false);
  const seoul4Stations = new Set(pack.transitStopTimes.filter(({ lineId }) => lineId === "seoul-4").map(({ stationId }) => stationId));
  assert.ok(seoul4Stations.size > 2, "4호선 정차역이 pilot 2역을 넘어야 한다");
});

// 크기 상한: 팩 JSON 70MB(2026-10-03 실측 약 58MB + #903 공식 원천 route·inline 증가 여유), 외부 파일 50MB(실측 약 6MB).
// GitHub 파일 한도는 100MB다. 상한을 넘으면 원천을 외부 파일로 더 옮겨야 한다.
const PACK_JSON_MAX_BYTES = 70 * 1024 * 1024;
const EXTERNAL_FILE_MAX_BYTES = 50 * 1024 * 1024;

test("#899 커밋된 전국 팩·외부 시간표 파일은 크기 상한 안이고, 펼치면 수도권 공식 trip·정차가 보고서와 같다", async () => {
  assert.ok((await stat(path.join(root, COMMITTED_PACK))).size < PACK_JSON_MAX_BYTES, "committed pack JSON size");
  const committed = JSON.parse(await readFile(path.join(root, COMMITTED_PACK), "utf8"));
  const binding = committed.packs[0][EXTERNAL_STOP_TIMES_KEY];
  assert.ok((await stat(path.join(root, binding.path))).size < EXTERNAL_FILE_MAX_BYTES, "external timetable file size");
  const report = JSON.parse(await readFile(path.join(root, CAPITAL_REPORT), "utf8"));
  const capital = binding.sections.filter(({ sourceId }) => sourceId === report.source.sourceId);
  assert.deepEqual(capital.map(({ sourceSnapshotId, stopTimeProvenance, tripCount, stopTimeCount }) => ({ sourceSnapshotId, stopTimeProvenance, tripCount, stopTimeCount })),
    [{ sourceSnapshotId: report.source.snapshotId, stopTimeProvenance: "TRIP_INHERITED", tripCount: report.summary.admittedTripCount, stopTimeCount: report.summary.admittedStopTimeCount }]);
  for (const line of report.lines) {
    assert.deepEqual(capital[0].byLine[line.lineId], { tripCount: line.admittedTripCount, stopTimeCount: line.admittedStopTimeCount }, line.lineId);
  }
  assert.equal(committed.packs[0].transitTrips.some(({ sourceId }) => sourceId === report.source.sourceId), false, "capital trips live in the external file");
  const pack = expandExternalStopTimes(committed, { repositoryRoot: root }).packs[0];
  const capitalTrips = pack.transitTrips.filter(({ sourceId }) => sourceId === report.source.sourceId);
  const capitalTripIds = new Set(capitalTrips.map(({ id }) => id));
  assert.equal(capitalTripIds.size, report.summary.admittedTripCount);
  assert.equal(capitalTrips.length, capitalTripIds.size, "short trip ids must not collide");
  assert.ok(capitalTrips.every(({ id }) => /^kc-[a-z0-9]+-[wshe]-[0-9a-f]{12}$/u.test(id)), "short trip id format");
  assert.equal(new Set(capitalTrips.map(({ providerRecordHash }) => providerRecordHash)).size, capitalTrips.length, "each trip keeps its source row hash");
  assert.equal(pack.transitStopTimes.filter(({ tripId }) => capitalTripIds.has(tripId)).length, report.summary.admittedStopTimeCount);
});
