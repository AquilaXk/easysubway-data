#!/usr/bin/env node
// 대구교통공사 1·2·3호선 공식 topology·시각표 snapshot을 production datapack으로 결정론적으로 materialize한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DAEGU_LINES, normalizedStationName } from "./collect-daegu-datapack-sources.mjs";
import { parseMolitDaeguStationMappings } from "./build-molit-nationwide-fixture.mjs";

const ISSUE = 2407;
const MATERIALIZER = "tools/datapack/materialize-daegu-timetable.mjs";
const VERIFICATION_TEST = "tools/datapack/materialize-daegu-timetable.test.mjs";
const OPERATOR_ID = "daegu-transportation";
const MEMBERSHIP_RAW_SOURCE_ID = "molit-urban-rail-full-route";
const PACK_ID = "nationwide-daegu-schedule";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const DAY_LABEL = Object.freeze({ WEEK: "weekday", SAT: "saturday", HOLI: "holiday" });
function serviceIdFor(lineNumber, dayCode) {
  return `daegu-line${lineNumber}-${DAY_LABEL[dayCode]}-2026`;
}
const LINE_META = Object.freeze({
  1: { nameKo: "대구 1호선", color: "#d93f3d" },
  2: { nameKo: "대구 2호선", color: "#00aa80" },
  3: { nameKo: "대구 3호선", color: "#f5c400" },
});
const HOLIDAYS_2026 = Object.freeze([
  "20260101", "20260216", "20260217", "20260218", "20260301", "20260302", "20260501",
  "20260505", "20260524", "20260525", "20260603", "20260606", "20260717", "20260815",
  "20260817", "20260924", "20260925", "20260926", "20261003", "20261005", "20261009", "20261225",
]);
const EXPECTED = Object.freeze({
  stations: 91, stationLines: 94, edges: 182, trips: 2_540, stopTimes: 77_970,
});

export function materializeDaeguTimetable({
  baseFixture, topologySnapshots, timetableSnapshots, inventory, canonicalStationMappings, now = new Date(),
}) {
  const lines = DAEGU_LINES.map((config) => {
    const topology = topologySnapshots[config.lineNumber];
    const timetable = timetableSnapshots[config.lineNumber];
    validateTopologySnapshot(topology, config);
    validateTimetableSnapshot(timetable, config, topology);
    const mappings = canonicalStationMappings[config.lineNumber];
    const sources = requiredSources(inventory, config, topology, timetable, mappings, now);
    return { config, topology, timetable, mappings, sources };
  });

  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Daegu timetable requires one cumulative production pack");
  }
  if (pack.operators.some(({ id }) => id === OPERATOR_ID)) throw new Error("Daegu operator already exists");
  for (const { config, sources } of lines) {
    if (pack.lines.some(({ id }) => id === config.lineId)) throw new Error(`Daegu ${config.lineId} already exists`);
    for (const source of [sources.membership, sources.topology, sources.timetable]) {
      if (pack.sourceInventory.some((entry) => entry.id === source.id)) throw new Error(`${source.id} already exists`);
    }
  }

  pack.operators.push({ id: OPERATOR_ID, nameKo: "대구교통공사", nameEn: "" });
  for (const { config, topology, timetable, sources } of lines) {
    pack.sourceInventory.push(
      packSource(sources.membership, sources.membership.membershipAdmissionEvidence.verifiedAt),
      packSource(sources.topology, topology.capturedAt),
      packSource(sources.timetable, timetable.capturedAt),
    );
    pack.lines.push({
      id: config.lineId, operatorId: OPERATOR_ID,
      nameKo: LINE_META[config.lineNumber].nameKo, nameEn: "", color: LINE_META[config.lineNumber].color,
    });
  }

  const addedStations = new Set();
  for (const line of lines) {
    addStationsAndTopology(pack, line, addedStations);
  }
  for (const line of lines) {
    addCalendars(pack, line);
    addRoutesAndTrips(pack, line);
  }

  const stationCount = pack.stations.filter(({ sourceId }) => sourceId.startsWith("molit-urban-rail-full-route-daegu-line")).length;
  const stationLineCount = pack.stationLines.filter(({ lineId }) => DAEGU_LINES.some((line) => line.lineId === lineId)).length;
  const edgeCount = pack.networkEdges.filter(({ id }) => id.startsWith("edge-daegu-")).length;
  const trips = pack.transitTrips.filter(({ id }) => id.startsWith("trip-daegu-"));
  const stopTimes = pack.transitStopTimes.filter(({ tripId }) => tripId.startsWith("trip-daegu-"));
  if (stationCount !== EXPECTED.stations || stationLineCount !== EXPECTED.stationLines
    || edgeCount !== EXPECTED.edges || trips.length !== EXPECTED.trips || stopTimes.length !== EXPECTED.stopTimes) {
    throw new Error(`Daegu materialized counts invalid: stations=${stationCount} stationLines=${stationLineCount} edges=${edgeCount} trips=${trips.length} stopTimes=${stopTimes.length}`);
  }

  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    stations: pack.stations.length,
    station_lines: pack.stationLines.length,
    network_edges: pack.networkEdges.length,
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
    lines: lines.map(({ config, topology, timetable }) => ({
      lineId: config.lineId,
      topologySnapshotId: topology.sourceId,
      timetableSnapshotId: timetable.sourceId,
      topologyContentSha256: topology.contentSha256,
      timetableContentSha256: timetable.contentSha256,
    })),
    packContentSha256: materializedPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function validateTopologySnapshot(snapshot, config) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "daegu-route-topology-snapshot"
    || snapshot.sourceId !== `daegu-line${config.lineNumber}-route-topology`
    || snapshot.official !== true || snapshot.fixture !== false || snapshot.credentialRedacted !== true
    || snapshot.lineId !== config.lineId || snapshot.stationCount !== config.stationCount
    || snapshot.edgeCount !== config.edgeCount || snapshot.scope?.length !== config.stationCount
    || snapshot.edges?.length !== config.edgeCount
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || snapshot.edgesSha256 !== sha256(JSON.stringify(snapshot.edges))
    || snapshot.contentSha256 !== sha256(JSON.stringify({ scope: snapshot.scope, edges: snapshot.edges }))) {
    throw new Error(`invalid Daegu line ${config.lineNumber} topology snapshot`);
  }
  const codes = new Set(snapshot.scope.map(({ stationCode }) => stationCode));
  if (codes.size !== snapshot.scope.length) throw new Error(`Daegu line ${config.lineNumber} topology duplicate station code`);
  const pairs = new Set();
  for (const edge of snapshot.edges) {
    const key = `${edge.fromStationCode}:${edge.toStationCode}`;
    if (!codes.has(edge.fromStationCode) || !codes.has(edge.toStationCode)
      || !Number.isInteger(edge.distanceMeters) || edge.distanceMeters <= 0
      || !Number.isInteger(edge.durationSeconds) || edge.durationSeconds <= 0 || pairs.has(key)) {
      throw new Error(`invalid Daegu line ${config.lineNumber} topology edge: ${key}`);
    }
    pairs.add(key);
  }
}

function validateTimetableSnapshot(snapshot, config, topology) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "daegu-train-timetable-snapshot"
    || snapshot.sourceId !== `daegu-line${config.lineNumber}-train-timetable`
    || snapshot.official !== true || snapshot.fixture !== false || snapshot.credentialRedacted !== true
    || snapshot.lineId !== config.lineId || snapshot.tripCount !== config.tripCount
    || snapshot.stopTimeCount !== config.stopTimeCount || snapshot.trips?.length !== config.tripCount
    || JSON.stringify(snapshot.dayCodes) !== JSON.stringify(["WEEK", "SAT", "HOLI"])
    || JSON.stringify(snapshot.directions) !== JSON.stringify(["up", "dn"])
    || snapshot.tripsSha256 !== sha256(JSON.stringify(snapshot.trips))
    || snapshot.contentSha256 !== sha256(JSON.stringify({
      tripsSha256: snapshot.tripsSha256, stopTimeCount: snapshot.stopTimeCount, stationCount: config.stationCount,
    }))) {
    throw new Error(`invalid Daegu line ${config.lineNumber} timetable snapshot`);
  }
  const codes = new Set(topology.scope.map(({ stationCode }) => stationCode));
  const tripIds = new Set();
  let stopTotal = 0;
  for (const trip of snapshot.trips) {
    if (!DAY_LABEL[trip.dayCode] || !["up", "dn"].includes(trip.direction) || tripIds.has(trip.id)
      || trip.stops.length < 2) {
      throw new Error(`invalid Daegu line ${config.lineNumber} trip: ${trip.id}`);
    }
    tripIds.add(trip.id);
    let previous = -1;
    for (const stop of trip.stops) {
      if (!codes.has(stop.c) || !Number.isInteger(stop.a) || !Number.isInteger(stop.d)
        || stop.a < previous || stop.d < stop.a) {
        throw new Error(`invalid Daegu line ${config.lineNumber} stop time in ${trip.id}`);
      }
      previous = stop.d;
    }
    stopTotal += trip.stops.length;
  }
  if (stopTotal !== config.stopTimeCount) throw new Error(`Daegu line ${config.lineNumber} stop time total mismatch`);
}

function requiredSources(inventory, config, topology, timetable, mappings, now) {
  const topologyId = `daegu-line${config.lineNumber}-route-topology`;
  const timetableId = `daegu-line${config.lineNumber}-train-timetable`;
  const membershipId = `molit-urban-rail-full-route-daegu-line${config.lineNumber}-membership`;
  const topologySource = inventory?.sources?.find(({ id }) => id === topologyId);
  const timetableSource = inventory?.sources?.find(({ id }) => id === timetableId);
  const membershipSource = inventory?.sources?.find(({ id }) => id === membershipId);
  const rawMembership = inventory?.sources?.find(({ id }) => id === MEMBERSHIP_RAW_SOURCE_ID);
  const topologyEvidence = topologySource?.topologyAdmissionEvidence;
  const scheduleEvidence = timetableSource?.scheduleAdmissionEvidence;
  const membershipEvidence = membershipSource?.membershipAdmissionEvidence;
  const mappingSha256 = sha256(JSON.stringify(mappings));
  const stationCodesSha256 = sha256(JSON.stringify(topology.scope.map(({ stationCode }) => stationCode)));

  if (topologySource?.productionUseAllowed !== true || topologySource.license?.redistributionAllowed !== true
    || topologyEvidence?.issue !== ISSUE || topologyEvidence.materializer !== MATERIALIZER
    || topologyEvidence.verificationTest !== VERIFICATION_TEST
    || topologyEvidence.snapshotId !== `${topologyId}-20260721`
    || topologyEvidence.capturedAt !== topology.capturedAt || topologyEvidence.freshUntil !== topology.freshUntil
    || topologyEvidence.stationCount !== config.stationCount || topologyEvidence.edgeCount !== config.edgeCount
    || topologyEvidence.depotExcludedCount !== topology.depotExcludedCount
    || topologyEvidence.rawSha256 !== topology.rawSha256
    || topologyEvidence.contentSha256 !== topology.contentSha256) {
    throw new Error(`${topologyId} inventory evidence does not match snapshot`);
  }
  if (timetableSource?.productionUseAllowed !== true || timetableSource.license?.redistributionAllowed !== true
    || timetableSource.capabilities?.schedule?.productionUseAllowed !== true
    || scheduleEvidence?.issue !== ISSUE || scheduleEvidence.materializer !== MATERIALIZER
    || scheduleEvidence.verificationTest !== VERIFICATION_TEST
    || scheduleEvidence.snapshotId !== `${timetableId}-20260721`
    || scheduleEvidence.capturedAt !== timetable.capturedAt || scheduleEvidence.freshUntil !== timetable.freshUntil
    || scheduleEvidence.tripCount !== config.tripCount || scheduleEvidence.stopTimeCount !== config.stopTimeCount
    || scheduleEvidence.dayLabelNormalizedCount !== timetable.dayLabelNormalizedCount
    || scheduleEvidence.rolloverTripCount !== timetable.rolloverTripCount
    || scheduleEvidence.rawUpSha256 !== timetable.rawUpSha256
    || scheduleEvidence.rawDownSha256 !== timetable.rawDownSha256
    || scheduleEvidence.tripsSha256 !== timetable.tripsSha256
    || scheduleEvidence.topologySnapshotId !== topologyEvidence.snapshotId
    || scheduleEvidence.contentSha256 !== timetable.contentSha256) {
    throw new Error(`${timetableId} inventory evidence does not match snapshot`);
  }
  if (!Array.isArray(mappings) || mappings.length !== config.stationCount
    || membershipSource?.productionUseAllowed !== true || membershipSource.license?.redistributionAllowed !== true
    || rawMembership?.admissionEvidence?.decision !== "APPROVED"
    || membershipEvidence?.issue !== ISSUE || membershipEvidence.materializer !== MATERIALIZER
    || membershipEvidence.verificationTest !== VERIFICATION_TEST
    || membershipEvidence.snapshotId !== `${membershipId}-20260721`
    || JSON.stringify(membershipEvidence.lineIds) !== JSON.stringify([config.lineId])
    || membershipEvidence.stationCount !== config.stationCount
    || membershipEvidence.mappingSha256 !== mappingSha256
    || membershipEvidence.stationCodesSha256 !== stationCodesSha256
    || membershipEvidence.membershipSourceId !== MEMBERSHIP_RAW_SOURCE_ID
    || membershipEvidence.membershipSourceRawSha256 !== rawMembership.admissionEvidence.rawSha256
    || membershipEvidence.membershipSourceSnapshotSha256 !== mappings.sourceRawSha256
    || membershipEvidence.stationCodeSourceId !== topologyId
    || membershipEvidence.stationCodeSnapshotId !== topologyEvidence.snapshotId
    || membershipEvidence.stationCodeContentSha256 !== topology.contentSha256) {
    throw new Error(`${membershipId} membership evidence is invalid`);
  }
  for (const [label, capturedAt, freshUntil] of [
    [topologyId, topologyEvidence.capturedAt, topologyEvidence.freshUntil],
    [timetableId, scheduleEvidence.capturedAt, scheduleEvidence.freshUntil],
  ]) {
    const captured = Date.parse(capturedAt);
    const fresh = Date.parse(freshUntil);
    const current = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(captured) || fresh !== captured + FRESHNESS_MILLIS
      || !Number.isFinite(current) || current < captured || current >= fresh) {
      throw new Error(`${label} evidence is stale or future-dated`);
    }
  }
  return { topology: topologySource, timetable: timetableSource, membership: membershipSource };
}

function addStationsAndTopology(pack, line, addedStations) {
  const { config, topology, mappings, sources } = line;
  const scopeByNorm = new Map(topology.scope.map((station) => [normalizedStationName(station.stationName), station]));
  const membershipEvidence = sources.membership.membershipAdmissionEvidence;
  const topologyEvidence = sources.topology.topologyAdmissionEvidence;
  const stationIdByCode = new Map();
  const membershipId = `molit-urban-rail-full-route-daegu-line${config.lineNumber}-membership`;
  // membership(mappings)과 topology(scope)는 둘 다 노선 순서(sequence)로 정렬되어 있어야 한다.
  // 이름 결속(scopeByNorm)만으로는 두 소스가 서로 다른 순서로 재정렬되어도 감지하지 못하므로,
  // index-wise로 정규화 역명이 일치하는지 전 index에서 단언하고 불일치 시 fail-closed한다.
  for (let index = 0; index < mappings.length; index += 1) {
    const molitNorm = normalizedStationName(mappings[index].stationName);
    const topologyNorm = normalizedStationName(topology.scope[index].stationName);
    if (molitNorm !== topologyNorm) {
      throw new Error(`Daegu line ${config.lineNumber} membership↔topology index mismatch at ${index}: `
        + `${mappings[index].stationName} (membership) vs ${topology.scope[index].stationName} (topology)`);
    }
  }
  for (const mapping of mappings) {
    const scope = scopeByNorm.get(normalizedStationName(mapping.stationName));
    if (!scope) throw new Error(`Daegu line ${config.lineNumber} canonical station mapping mismatch: ${mapping.stationName}`);
    stationIdByCode.set(scope.stationCode, mapping.stationId);
    const membershipHash = sha256(JSON.stringify({
      lineId: config.lineId, stationName: mapping.stationName, stationSequence: mapping.sequence,
    }));
    if (!addedStations.has(mapping.stationId)) {
      addedStations.add(mapping.stationId);
      pack.stations.push({
        id: mapping.stationId,
        nameKo: mapping.stationName,
        nameEn: "",
        normalizedName: mapping.stationName.normalize("NFKC"),
        region: "대구권",
        latitude: null,
        longitude: null,
        dataQualityLevel: "LEVEL_2",
        dataSourceType: "OFFICIAL_FILE",
        sourceId: membershipId,
        sourceSnapshotId: membershipEvidence.snapshotId,
        providerRecordHash: membershipHash,
        evidenceHash: membershipEvidence.mappingSha256,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: membershipEvidence.verifiedAt,
      });
    }
    pack.stationLines.push({
      stationId: mapping.stationId,
      lineId: config.lineId,
      stationCode: scope.stationCode,
      lineSequence: mapping.sequence,
      platformInfo: "",
      sourceId: membershipId,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipHash,
      evidenceHash: membershipEvidence.mappingSha256,
      fieldProvenance: {
        station_code: {
          sourceId: sources.topology.id,
          sourceSnapshotId: topologyEvidence.snapshotId,
          providerRecordHash: sha256(JSON.stringify(scope)),
          evidenceHash: topology.contentSha256,
          derivationKind: "OFFICIAL",
          verifiedAt: topology.capturedAt,
        },
      },
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
  }
  for (const edge of topology.edges) {
    const fromId = stationIdByCode.get(edge.fromStationCode);
    const toId = stationIdByCode.get(edge.toStationCode);
    pack.networkEdges.push({
      id: `edge-daegu-${config.lineNumber}-${edge.fromStationCode}-${edge.toStationCode}`,
      fromNodeId: `${fromId}:${config.lineId}`,
      toNodeId: `${toId}:${config.lineId}`,
      durationSeconds: edge.durationSeconds,
      distanceMeters: edge.distanceMeters,
      edgeType: "RIDE",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      includesStairs: false,
      stairAccessState: "UNKNOWN",
      accessibilityStatus: "UNKNOWN",
      reliabilityScore: 100,
      sourceId: sources.topology.id,
      sourceSnapshotId: topologyEvidence.snapshotId,
      providerRecordHash: sha256(JSON.stringify(edge)),
      provenanceKind: "OFFICIAL_SOURCE",
      derivationKind: "OFFICIAL",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: topology.capturedAt,
      evidenceHash: topology.contentSha256,
    });
  }
  line.stationIdByCode = stationIdByCode;
  line.nameByCode = new Map(topology.scope.map((station) => [station.stationCode, station.stationName]));
}

function addCalendars(pack, line) {
  const provenance = scheduleProvenance(line);
  const number = line.config.lineNumber;
  pack.serviceCalendars.push(
    withProvenance({ serviceId: serviceIdFor(number, "WEEK"), monday: true, tuesday: true, wednesday: true,
      thursday: true, friday: true, saturday: false, sunday: false, startDate: "20260101", endDate: "20261231" }, provenance),
    withProvenance({ serviceId: serviceIdFor(number, "SAT"), monday: false, tuesday: false, wednesday: false,
      thursday: false, friday: false, saturday: true, sunday: false, startDate: "20260101", endDate: "20261231" }, provenance),
    withProvenance({ serviceId: serviceIdFor(number, "HOLI"), monday: false, tuesday: false, wednesday: false,
      thursday: false, friday: false, saturday: false, sunday: true, startDate: "20260101", endDate: "20261231" }, provenance),
  );
  for (const date of HOLIDAYS_2026) {
    const weekday = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`).getUTCDay();
    pack.serviceCalendarDates.push(withProvenance({ serviceId: serviceIdFor(number, "HOLI"), date, exceptionType: 1 }, provenance, "GENERATED"));
    if (weekday !== 0) {
      pack.serviceCalendarDates.push(withProvenance({
        serviceId: serviceIdFor(number, weekday === 6 ? "SAT" : "WEEK"), date, exceptionType: 2,
      }, provenance, "GENERATED"));
    }
  }
}

function addRoutesAndTrips(pack, line) {
  const { config, timetable, nameByCode } = line;
  const provenance = scheduleProvenance(line);
  const terminalName = (direction) => {
    const scope = line.topology.scope;
    return direction === "up" ? scope[0].stationName : scope.at(-1).stationName;
  };
  for (const direction of ["up", "dn"]) {
    const headsign = terminalName(direction).normalize("NFKC").replace(/\([^)]*\)/gu, "").replace(/[0-9]+$/u, "");
    pack.transitRoutes.push(withProvenance({
      id: `route-daegu-${config.lineNumber}-${direction}`,
      lineId: config.lineId,
      routeShortName: String(config.lineNumber),
      routeLongName: `${LINE_META[config.lineNumber].nameKo} ${headsign} 방면`,
      directionName: `${headsign} 방면`,
    }, provenance));
  }
  for (const trip of timetable.trips) {
    const tripProvenance = { ...provenance, providerRecordHash: sha256(JSON.stringify(trip)) };
    const lastName = nameByCode.get(trip.stops.at(-1).c).normalize("NFKC").replace(/\([^)]*\)/gu, "").replace(/[0-9]+$/u, "");
    pack.transitTrips.push(withProvenance({
      id: trip.id,
      routeId: `route-daegu-${config.lineNumber}-${trip.direction}`,
      serviceId: serviceIdFor(config.lineNumber, trip.dayCode),
      tripHeadsign: lastName,
      directionId: trip.direction === "up" ? "decreasing" : "increasing",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      serviceDayStartSeconds: 0,
    }, tripProvenance));
    for (const [index, stop] of trip.stops.entries()) {
      pack.transitStopTimes.push(withProvenance({
        tripId: trip.id,
        stopSequence: index + 1,
        stationId: line.stationIdByCode.get(stop.c),
        lineId: config.lineId,
        arrivalSeconds: stop.a,
        departureSeconds: stop.d,
        pickupType: index === trip.stops.length - 1 ? 1 : 0,
        dropOffType: index === 0 ? 1 : 0,
      }, tripProvenance));
    }
  }
}

function scheduleProvenance(line) {
  const { timetable, sources } = line;
  return {
    sourceId: sources.timetable.id,
    sourceSnapshotId: sources.timetable.scheduleAdmissionEvidence.snapshotId,
    providerRecordHash: timetable.tripsSha256,
    evidenceHash: sha256(JSON.stringify({
      timetableContentSha256: timetable.contentSha256,
      topologyContentSha256: line.topology.contentSha256,
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
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function parseArgs(argv) {
  const expected = ["--base-fixture", "--sources-dir", "--inventory", "--station-map", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-daegu-timetable.mjs --base-fixture <json> --sources-dir <dir> --inventory <json> --station-map <csv> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runDaeguTimetableMaterializer(argv, { now = new Date() } = {}) {
  const args = parseArgs(argv);
  const [baseFixture, inventory, stationMapBytes] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
    readFile(args["station-map"]),
  ]);
  const topologySnapshots = {};
  const timetableSnapshots = {};
  const canonicalStationMappings = {};
  for (const config of DAEGU_LINES) {
    topologySnapshots[config.lineNumber] = JSON.parse(await readFile(
      path.join(args["sources-dir"], `daegu-line${config.lineNumber}-route-topology-20260721.json`), "utf8"));
    timetableSnapshots[config.lineNumber] = JSON.parse(await readFile(
      path.join(args["sources-dir"], `daegu-line${config.lineNumber}-train-timetable-20260721.json`), "utf8"));
    canonicalStationMappings[config.lineNumber] = parseMolitDaeguStationMappings(stationMapBytes, config.lineName);
  }
  const fixture = materializeDaeguTimetable({
    baseFixture, topologySnapshots, timetableSnapshots, inventory, canonicalStationMappings, now,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Daegu timetable materialized: trips=${EXPECTED.trips} stopTimes=${EXPECTED.stopTimes}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDaeguTimetableMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daegu timetable materialization failed");
    process.exitCode = 1;
  }
}
