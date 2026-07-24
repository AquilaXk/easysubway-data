#!/usr/bin/env node
// 인천교통공사 1·2호선 공식 timetable snapshot을 production datapack으로 결정론적으로 materialize한다.
// topology lineage는 incheon-transit-station-info에 pin한다(basename + contentSha256 fail-closed).
//
// Day model: 토요일 전용 FILE이 없어 WEEK + HOLI만 admit한다.
// HOLI service에 saturday=true를 두어 토요일에 휴일 시각표를 재사용한다(대전 패턴).
// 토요일 전용 시각을 발명하지 않는다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { INCHEON_TIMETABLE_LINES } from "./collect-incheon-timetable.mjs";
import { validateIncheonStationInfoSnapshot } from "./collect-incheon-station-info.mjs";

const ISSUE = 2488;
const MATERIALIZER = "tools/datapack/materialize-incheon-timetable.mjs";
const VERIFICATION_TEST = "tools/datapack/materialize-incheon-timetable.test.mjs";
const OPERATOR_ID = "incheon-transit";
const TOPOLOGY_SOURCE_ID = "incheon-transit-station-info";
const TOPOLOGY_SNAPSHOT_ID = "incheon-transit-station-info-20260724";
const TOPOLOGY_CONTENT_SHA256 = "710878689282ba967697cd9411940b657a51eee5499106ed884d5bd9111501a8";
const PACK_ID = "nationwide-incheon-schedule";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const DAY_LABEL = Object.freeze({ WEEK: "weekday", HOLI: "holiday" });
const LINE_META = Object.freeze({
  1: { nameKo: "인천 1호선", color: "#7ca8d5", lineId: "line-98718184f016" },
  2: { nameKo: "인천 2호선", color: "#ed8b00", lineId: "line-42b5805f3b5a" },
});
const EXPECTED = Object.freeze({
  trips: 1_414,
  stopTimes: 40_898,
  calendars: 4,
});
// 수도권 2026 공휴일. 토요일이 HOLI service에 포함되므로 평일 공휴일만 WEEK 제거·HOLI 추가.
const HOLIDAYS_2026 = Object.freeze([
  "20260101", "20260216", "20260217", "20260218", "20260301", "20260302", "20260501",
  "20260505", "20260524", "20260525", "20260603", "20260606", "20260717", "20260815",
  "20260817", "20260924", "20260925", "20260926", "20261003", "20261005", "20261009", "20261225",
]);

function serviceIdFor(lineNumber, dayCode) {
  return `incheon-line${lineNumber}-${DAY_LABEL[dayCode]}-2026`;
}

export function materializeIncheonTimetable({
  baseFixture,
  topologySnapshot,
  timetableSnapshots,
  inventory,
  now = new Date(),
} = {}) {
  validateIncheonStationInfoSnapshot(topologySnapshot);
  if (topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || topologySnapshot.contentSha256 !== TOPOLOGY_CONTENT_SHA256) {
    throw new Error("invalid Incheon topology snapshot");
  }

  const lines = INCHEON_TIMETABLE_LINES.map((config) => {
    const timetable = timetableSnapshots[config.lineNumber];
    validateTimetableSnapshot(timetable, config);
    const source = requiredSource(inventory, config, timetable, topologySnapshot, now);
    return { config, timetable, source };
  });

  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Incheon timetable requires one cumulative production pack");
  }
  if (!pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Incheon timetable requires incheon-transit operator pack");
  }
  if (!pack.sourceInventory.some(({ id }) => id === TOPOLOGY_SOURCE_ID)) {
    throw new Error("Incheon timetable requires incheon-transit-station-info source");
  }
  for (const { config, source } of lines) {
    if (!pack.lines.some(({ id }) => id === config.lineId)) {
      throw new Error(`Incheon timetable requires ${config.lineId} in base fixture`);
    }
    if (pack.sourceInventory.some(({ id }) => id === source.id)) {
      throw new Error(`${source.id} already exists`);
    }
  }

  const stationIdByLineCode = canonicalStations(pack, topologySnapshot);
  for (const line of lines) {
    pack.sourceInventory.push(packSource(line.source, line.timetable.capturedAt));
    addCalendars(pack, line);
    addRoutesAndTrips(pack, line, stationIdByLineCode);
  }

  const trips = pack.transitTrips.filter(({ id }) => id.startsWith("trip-incheon-"));
  const stopTimes = pack.transitStopTimes.filter(({ tripId }) => tripId.startsWith("trip-incheon-"));
  const calendars = pack.serviceCalendars.filter(({ serviceId }) => serviceId.startsWith("incheon-line"));
  if (trips.length !== EXPECTED.trips || stopTimes.length !== EXPECTED.stopTimes
    || calendars.length !== EXPECTED.calendars) {
    throw new Error(
      `Incheon materialized counts invalid: trips=${trips.length} stopTimes=${stopTimes.length} `
      + `calendars=${calendars.length}`,
    );
  }

  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    service_calendars: pack.serviceCalendars.length,
    service_calendar_dates: pack.serviceCalendarDates.length,
    transit_routes: pack.transitRoutes.length,
    transit_trips: pack.transitTrips.length,
    transit_stop_times: pack.transitStopTimes.length,
    transit_feed_info: pack.transitFeedInfo.length,
  };
  const version = compactSeoulDate(lines[0].timetable.capturedAt);
  const composition = sha256(JSON.stringify({
    previousPackId: pack.id,
    lines: lines.map(({ config, timetable, source }) => ({
      lineId: config.lineId,
      timetableSnapshotId: source.scheduleAdmissionEvidence.snapshotId,
      timetableContentSha256: timetable.contentSha256,
      topologySnapshotId: TOPOLOGY_SNAPSHOT_ID,
      topologyContentSha256: TOPOLOGY_CONTENT_SHA256,
    })),
    packContentSha256: materializedIncheonTimetablePackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedIncheonTimetablePackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function validateTimetableSnapshot(snapshot, config) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "incheon-train-timetable-snapshot"
    || snapshot.sourceId !== config.sourceId || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || snapshot.lineId !== config.lineId || snapshot.stationCount !== config.stationCount
    || snapshot.tripCount !== config.tripCount || snapshot.stopTimeCount !== config.stopTimeCount
    || snapshot.trips?.length !== config.tripCount
    || snapshot.rolloverTripCount !== config.rolloverTripCount
    || snapshot.destinationLabelNormalizedCount !== config.destinationLabelNormalizedCount
    || snapshot.dayModel !== "WEEK_HOLI_NO_SATURDAY_FILE"
    || JSON.stringify(snapshot.dayCodes) !== JSON.stringify(["WEEK", "HOLI"])
    || JSON.stringify(snapshot.directions) !== JSON.stringify(["up", "dn"])
    || snapshot.topologySourceId !== TOPOLOGY_SOURCE_ID
    || snapshot.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || snapshot.topologyContentSha256 !== TOPOLOGY_CONTENT_SHA256
    || snapshot.tripsSha256 !== sha256(JSON.stringify(snapshot.trips))
    || snapshot.contentSha256 !== sha256(JSON.stringify({
      tripsSha256: snapshot.tripsSha256,
      stopTimeCount: snapshot.stopTimeCount,
      stationCount: config.stationCount,
    }))) {
    throw new Error(`invalid Incheon line ${config.lineNumber} timetable snapshot`);
  }
  const stopTotal = snapshot.trips.reduce((total, trip) => total + trip.stops.length, 0);
  if (stopTotal !== config.stopTimeCount) {
    throw new Error(`Incheon line ${config.lineNumber} stop time total mismatch`);
  }
}

function requiredSource(inventory, config, timetable, topologySnapshot, now) {
  const source = inventory?.sources?.find(({ id }) => id === config.sourceId);
  const evidence = source?.scheduleAdmissionEvidence;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.capabilities?.schedule?.productionUseAllowed !== true
    || source.capabilities?.schedule?.status !== "SUPPORTED"
    || evidence?.issue !== ISSUE
    || evidence.materializer !== MATERIALIZER
    || evidence.verificationTest !== VERIFICATION_TEST
    || evidence.snapshotId !== `${config.sourceId}-20260724`
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`
    || evidence.capturedAt !== timetable.capturedAt || evidence.freshUntil !== timetable.freshUntil
    || evidence.tripCount !== config.tripCount || evidence.stopTimeCount !== config.stopTimeCount
    || evidence.rowCount !== timetable.rowCount || evidence.departureCount !== config.stopTimeCount
    || evidence.rawSha256 !== timetable.rawSha256 || evidence.rowsSha256 !== timetable.rowsSha256
    || evidence.tripsSha256 !== timetable.tripsSha256
    || evidence.contentSha256 !== timetable.contentSha256
    || evidence.rawUpSha256 !== timetable.rawUpSha256 || evidence.rawDownSha256 !== timetable.rawDownSha256
    || evidence.rolloverTripCount !== timetable.rolloverTripCount
    || evidence.destinationLabelNormalizedCount !== timetable.destinationLabelNormalizedCount
    || evidence.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || evidence.topologyContentSha256 !== TOPOLOGY_CONTENT_SHA256
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["capital"],
      operatorIds: [OPERATOR_ID],
      lineIds: [config.lineId],
      sourceDomains: ["schedule_timetable"],
    })) {
    throw new Error(`${config.sourceId} inventory evidence does not match snapshot`);
  }
  validateTopologyLineage(inventory, evidence, topologySnapshot);
  const version = evidence.snapshotId.slice(-8);
  if (version !== compactSeoulDate(evidence.capturedAt)) {
    throw new Error(`${config.sourceId} snapshotId must match capturedAt Asia/Seoul date`);
  }
  const capturedAt = Date.parse(evidence.capturedAt);
  const freshUntil = Date.parse(evidence.freshUntil);
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(capturedAt) || freshUntil !== capturedAt + FRESHNESS_MILLIS
    || !Number.isFinite(observedNow) || observedNow < capturedAt || observedNow >= freshUntil) {
    throw new Error(`${config.sourceId} evidence freshness is invalid`);
  }
  return source;
}

function validateTopologyLineage(inventory, evidence, topologySnapshot) {
  const topologyEvidence = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID)
    ?.topologyAdmissionEvidence;
  if (evidence?.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== topologyEvidence?.contentSha256
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || topologyEvidence?.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || topologyEvidence.snapshotPath !== `tools/datapack/sources/${TOPOLOGY_SNAPSHOT_ID}.json`
    || path.basename(topologyEvidence.snapshotPath, ".json") !== TOPOLOGY_SNAPSHOT_ID) {
    throw new Error("Incheon timetable topology lineage mismatch");
  }
}

function canonicalStations(pack, topologySnapshot) {
  const expected = new Map();
  for (const config of INCHEON_TIMETABLE_LINES) {
    for (const station of topologySnapshot.scope.filter((entry) => entry.lineId === config.lineId)) {
      expected.set(`${config.lineId}:${station.stationCode}`, {
        stationName: station.stationName,
        lineSequence: station.lineSequence,
      });
    }
  }
  const stationNames = new Map(pack.stations.map(({ id, nameKo }) => [id, nameKo]));
  const stations = new Map();
  for (const stationLine of pack.stationLines) {
    const key = `${stationLine.lineId}:${stationLine.stationCode}`;
    const expectedStation = expected.get(key);
    if (!expectedStation) continue;
    if (stations.has(key)) throw new Error(`Incheon timetable duplicate canonical station: ${key}`);
    if (stationLine.sourceId !== TOPOLOGY_SOURCE_ID
      || stationLine.lineSequence !== expectedStation.lineSequence
      || stationNames.get(stationLine.stationId)?.normalize("NFKC") !== expectedStation.stationName.normalize("NFKC")) {
      throw new Error(`Incheon timetable topology lineage mismatch: ${key}`);
    }
    stations.set(key, stationLine.stationId);
  }
  if (stations.size !== 60) {
    throw new Error(`Incheon timetable canonical station count mismatch: ${stations.size}`);
  }
  return stations;
}

function addCalendars(pack, line) {
  const provenance = scheduleProvenance(line);
  const number = line.config.lineNumber;
  // WEEK = 월~금. HOLI = 토·일(+공휴일). 토요일 전용 FILE이 없어 HOLI 시각표를 재사용한다.
  pack.serviceCalendars.push(
    withProvenance({
      serviceId: serviceIdFor(number, "WEEK"),
      monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
      saturday: false, sunday: false, startDate: "20260101", endDate: "20261231",
    }, provenance),
    withProvenance({
      serviceId: serviceIdFor(number, "HOLI"),
      monday: false, tuesday: false, wednesday: false, thursday: false, friday: false,
      saturday: true, sunday: true, startDate: "20260101", endDate: "20261231",
    }, provenance),
  );
  for (const date of HOLIDAYS_2026) {
    const weekday = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`).getUTCDay();
    pack.serviceCalendarDates.push(
      withProvenance({ serviceId: serviceIdFor(number, "HOLI"), date, exceptionType: 1 }, provenance, "GENERATED"),
    );
    if (weekday !== 0 && weekday !== 6) {
      pack.serviceCalendarDates.push(
        withProvenance({ serviceId: serviceIdFor(number, "WEEK"), date, exceptionType: 2 }, provenance, "GENERATED"),
      );
    }
  }
}

function addRoutesAndTrips(pack, line, stationIdByLineCode) {
  const { config, timetable } = line;
  const provenance = scheduleProvenance(line);
  const meta = LINE_META[config.lineNumber];
  const terminals = terminalNames(timetable);
  for (const direction of ["up", "dn"]) {
    const headsign = terminals[direction];
    pack.transitRoutes.push(withProvenance({
      id: `route-incheon-${config.lineNumber}-${direction}`,
      lineId: config.lineId,
      routeShortName: String(config.lineNumber),
      routeLongName: `${meta.nameKo} ${headsign} 방면`,
      directionName: `${headsign} 방면`,
    }, provenance));
  }
  for (const trip of timetable.trips) {
    const tripProvenance = { ...provenance, providerRecordHash: sha256(JSON.stringify(trip)) };
    const headsign = trip.destinationName.normalize("NFKC")
      .replace(/\([^)]*\)/gu, "")
      .replace(/역$/u, "");
    pack.transitTrips.push(withProvenance({
      id: trip.id,
      routeId: `route-incheon-${config.lineNumber}-${trip.direction}`,
      serviceId: serviceIdFor(config.lineNumber, trip.dayCode),
      tripHeadsign: headsign,
      directionId: trip.direction === "up" ? "decreasing" : "increasing",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      serviceDayStartSeconds: 0,
    }, tripProvenance));
    for (const [index, stop] of trip.stops.entries()) {
      const stationId = stationIdByLineCode.get(`${config.lineId}:${stop.c}`);
      if (!stationId) {
        throw new Error(`Incheon timetable unknown stop station: ${config.lineId}:${stop.c}`);
      }
      pack.transitStopTimes.push(withProvenance({
        tripId: trip.id,
        stopSequence: index + 1,
        stationId,
        lineId: config.lineId,
        arrivalSeconds: stop.a,
        departureSeconds: stop.d,
        pickupType: index === trip.stops.length - 1 ? 1 : 0,
        dropOffType: index === 0 ? 1 : 0,
      }, tripProvenance));
    }
  }
}

function terminalNames(timetable) {
  const byDirection = { up: null, dn: null };
  for (const trip of timetable.trips) {
    if (!byDirection[trip.direction]) {
      byDirection[trip.direction] = trip.destinationName.normalize("NFKC")
        .replace(/\([^)]*\)/gu, "")
        .replace(/역$/u, "");
    }
  }
  if (!byDirection.up || !byDirection.dn) {
    throw new Error("Incheon timetable missing direction terminals");
  }
  return byDirection;
}

function scheduleProvenance(line) {
  const { timetable, source } = line;
  return {
    sourceId: source.id,
    sourceSnapshotId: source.scheduleAdmissionEvidence.snapshotId,
    providerRecordHash: timetable.tripsSha256,
    evidenceHash: sha256(JSON.stringify({
      timetableContentSha256: timetable.contentSha256,
      topologyContentSha256: TOPOLOGY_CONTENT_SHA256,
    })),
    updatedAt: timetable.capturedAt,
  };
}

function withProvenance(row, provenance, derivationKind = "OFFICIAL") {
  return {
    ...row,
    sourceId: provenance.sourceId,
    sourceSnapshotId: provenance.sourceSnapshotId,
    providerRecordHash: provenance.providerRecordHash,
    evidenceHash: provenance.evidenceHash,
    provenanceKind: "OFFICIAL_SOURCE",
    derivationKind,
    updatedAt: provenance.updatedAt,
  };
}

function packSource(source, updatedAt) {
  return {
    id: source.id,
    owner: source.owner,
    url: source.datasetUrl,
    license: source.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: source.updateFrequency,
    updatedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function compactSeoulDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const expected = [
    "--base-fixture", "--topology-snapshot", "--line1-snapshot", "--line2-snapshot",
    "--inventory", "--output",
  ];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error(
      "usage: materialize-incheon-timetable.mjs --base-fixture <json> --topology-snapshot <json> "
      + "--line1-snapshot <json> --line2-snapshot <json> --inventory <json> --output <absolute.json>",
    );
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runIncheonTimetableMaterializer(argv, { now = new Date() } = {}) {
  const args = parseArgs(argv);
  const topologyPath = args["topology-snapshot"];
  const topologySnapshotId = path.basename(topologyPath, ".json");
  if (topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID) {
    throw new Error(`Incheon topology snapshot path must be ${TOPOLOGY_SNAPSHOT_ID}.json`);
  }
  const [baseFixture, inventory, topologySnapshot, line1, line2] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
    readFile(topologyPath, "utf8").then(JSON.parse),
    readFile(args["line1-snapshot"], "utf8").then(JSON.parse),
    readFile(args["line2-snapshot"], "utf8").then(JSON.parse),
  ]);
  const fixture = materializeIncheonTimetable({
    baseFixture,
    topologySnapshot: { ...topologySnapshot, snapshotId: topologySnapshotId },
    timetableSnapshots: { 1: line1, 2: line2 },
    inventory,
    now,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Incheon timetable materialized: trips=${EXPECTED.trips} stopTimes=${EXPECTED.stopTimes}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runIncheonTimetableMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Incheon timetable materialization failed");
    process.exitCode = 1;
  }
}
