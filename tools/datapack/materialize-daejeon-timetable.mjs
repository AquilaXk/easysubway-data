#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { materializeDaejeonRouteTopology } from "./materialize-daejeon-route-topology.mjs";
import { DAEJEON_COVERAGE_OPERATIONS } from "./probe-daejeon-coverage-api.mjs";

const SOURCE_ID = "daejeon-train-timetable";
const TOPOLOGY_SOURCE_ID = "daejeon-station-distance-fare";
const LINE_ID = "line-7051a9c2525c";
const PACK_ID = "nationwide-daejeon-schedule";
const SUPPORTED_SERVICE_CALENDAR_YEAR = "2026";
const SEOUL_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
});
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const EXPECTED_ROW_COUNT = 1_628;
const EXPECTED_DEPARTURE_COUNT = 9_574;
const EXPECTED_TRIP_COUNT = 460;
const EXPECTED_STOP_TIME_COUNT = 10_034;
const STATION_NUMBERS = Object.freeze(Array.from({ length: 22 }, (_, index) => String(101 + index)));
const SERVICE_BY_DAY_TYPE = Object.freeze({
  "0": "daejeon-weekday-2026",
  "1": "daejeon-holiday-2026",
});
const HOLIDAY_DATES_2026 = Object.freeze([
  "20260101", "20260216", "20260217", "20260218", "20260302", "20260505", "20260525",
  "20260603", "20260817", "20260924", "20260925", "20261005", "20261009", "20261225",
]);

export function materializeDaejeonTimetable({
  baseFixture,
  timetableSnapshot,
  topologySnapshot,
  inventory,
  canonicalStationMappings,
  now = new Date(),
}) {
  const events = validateSnapshot(timetableSnapshot);
  const source = requiredSource(inventory, timetableSnapshot, topologySnapshot, now);
  const version = /-(\d{8})$/.exec(source.scheduleAdmissionEvidence.snapshotId)?.[1];
  if (!version) throw new Error(`${SOURCE_ID} snapshotId must end with YYYYMMDD`);
  const capturedDate = compactSeoulDate(source.scheduleAdmissionEvidence.capturedAt);
  if (version !== capturedDate) {
    throw new Error(`${SOURCE_ID} snapshotId must match capturedAt Asia/Seoul date`);
  }
  if (!capturedDate.startsWith(SUPPORTED_SERVICE_CALENDAR_YEAR)) {
    throw new Error(`${SOURCE_ID} snapshotId must use supported service calendar year ${SUPPORTED_SERVICE_CALENDAR_YEAR}`);
  }
  const fixture = materializeDaejeonRouteTopology({
    baseFixture,
    snapshot: topologySnapshot,
    inventory,
    canonicalStationMappings,
    now,
  });
  const pack = fixture.packs[0];
  validateTopologyLineage(pack, source.scheduleAdmissionEvidence);
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists in base fixture`);
  }
  pack.sourceInventory.push(packSource(source, timetableSnapshot));

  const stationByNumber = canonicalStations(pack);
  const durationByStationPair = topologyDurations(pack);
  const { trips, stopTimes } = reconstructTrips(events, stationByNumber, durationByStationPair);
  const provenance = scheduleProvenance(source, timetableSnapshot);

  pack.serviceCalendars.push(
    withProvenance({
      serviceId: SERVICE_BY_DAY_TYPE["0"],
      monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
      saturday: false, sunday: false, startDate: "20260101", endDate: "20261231",
    }, provenance),
    withProvenance({
      serviceId: SERVICE_BY_DAY_TYPE["1"],
      monday: false, tuesday: false, wednesday: false, thursday: false, friday: false,
      saturday: true, sunday: true, startDate: "20260101", endDate: "20261231",
    }, provenance),
  );
  pack.serviceCalendarDates.push(...HOLIDAY_DATES_2026.flatMap((date) => [
    withProvenance({ serviceId: SERVICE_BY_DAY_TYPE["1"], date, exceptionType: 1 }, provenance, "GENERATED"),
    withProvenance({ serviceId: SERVICE_BY_DAY_TYPE["0"], date, exceptionType: 2 }, provenance, "GENERATED"),
  ]));
  pack.transitRoutes.push(
    withProvenance({
      id: "route-daejeon-1-decreasing",
      lineId: LINE_ID,
      routeShortName: "1",
      routeLongName: "대전 1호선 판암 방면",
      directionName: "판암 방면",
    }, provenance),
    withProvenance({
      id: "route-daejeon-1-increasing",
      lineId: LINE_ID,
      routeShortName: "1",
      routeLongName: "대전 1호선 반석 방면",
      directionName: "반석 방면",
    }, provenance),
  );
  pack.transitTrips.push(...trips.map((trip) => withProvenance({
    id: trip.id,
    routeId: trip.direction === "1" ? "route-daejeon-1-increasing" : "route-daejeon-1-decreasing",
    serviceId: SERVICE_BY_DAY_TYPE[trip.dayType],
    tripHeadsign: trip.destinationName,
    directionId: trip.direction === "1" ? "increasing" : "decreasing",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
    serviceDayStartSeconds: 0,
  }, { ...provenance, providerRecordHash: trip.providerRecordHash })));
  pack.transitStopTimes.push(...stopTimes.map((stopTime) => withProvenance({
    tripId: stopTime.tripId,
    stopSequence: stopTime.stopSequence,
    stationId: stopTime.stationId,
    lineId: LINE_ID,
    arrivalSeconds: stopTime.arrivalSeconds,
    departureSeconds: stopTime.departureSeconds,
    pickupType: stopTime.pickupType,
    dropOffType: stopTime.dropOffType,
  }, { ...provenance, providerRecordHash: stopTime.providerRecordHash })));
  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    service_calendars: pack.serviceCalendars.length,
    service_calendar_dates: pack.serviceCalendarDates.length,
    transit_routes: pack.transitRoutes.length,
    transit_trips: pack.transitTrips.length,
    transit_stop_times: pack.transitStopTimes.length,
    transit_feed_info: pack.transitFeedInfo.length,
  };
  const compositionSha256 = sha256(JSON.stringify({
    timetableSnapshotIdentity: {
      snapshotId: source.scheduleAdmissionEvidence.snapshotId,
      observedAt: timetableSnapshot.observedAt,
      rawSha256: timetableSnapshot.rawSha256,
      rowsSha256: timetableSnapshot.rowsSha256,
    },
    source,
    materializedPackContentSha256: materializedPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${compositionSha256}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${pack.version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version: pack.version };
  return fixture;
}

export function materializedPackContentHash(pack, version) {
  const { id: previousPackId, version: _previousVersion, url: _previousUrl, ...content } = pack;
  return sha256(JSON.stringify({ previousPackId, version, content }));
}

function compactSeoulDate(value) {
  const parts = Object.fromEntries(SEOUL_DATE_FORMATTER.formatToParts(new Date(value))
    .map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function validateSnapshot(snapshot) {
  const operation = DAEJEON_COVERAGE_OPERATIONS[SOURCE_ID];
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "daejeon-coverage-api-probe-evidence"
    || snapshot.sourceId !== SOURCE_ID || snapshot.endpoint !== operation.endpoint
    || snapshot.httpStatus !== 200 || snapshot.providerResultCode !== "00" || snapshot.schemaStatus !== "EXPECTED"
    || snapshot.credentialRedacted !== true || snapshot.rowCount !== EXPECTED_ROW_COUNT
    || snapshot.rows?.length !== EXPECTED_ROW_COUNT
    || JSON.stringify(snapshot.outputFields) !== JSON.stringify(operation.expectedFields)
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")) {
    throw new Error("invalid Daejeon timetable snapshot");
  }
  const observedAt = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== snapshot.observedAt) {
    throw new Error("invalid Daejeon timetable snapshot observedAt");
  }

  const byKey = new Map();
  let departureCount = 0;
  for (const row of snapshot.rows) {
    const station = Number(row.stNum);
    const hour = Number(row.tmZone);
    const key = `${row.dayType}:${row.drctType}:${row.stNum}:${row.tmZone}`;
    if (!new Set(["0", "1"]).has(row.dayType) || !new Set(["0", "1"]).has(row.drctType)
      || !/^\d{3}$/.test(row.stNum) || station < 101 || station > 122
      || !/^\d{1,2}$/.test(row.tmZone) || hour < 5 || hour > 24 || byKey.has(key)) {
      throw new Error(`invalid Daejeon timetable row: ${key}`);
    }
    const parsed = row.tmList.split(" ").map((token) => {
      const match = /^(\d{1,2})(?:\(([가-힣A-Za-z0-9.· ]{1,40})\))?$/.exec(token);
      const minute = Number(match?.[1]);
      if (!match || minute < 0 || minute > 59) throw new Error(`invalid Daejeon timetable token: ${key}`);
      return { seconds: hour * 3_600 + minute * 60, destinationName: match[2] ?? "" };
    });
    if (parsed.length === 0) throw new Error(`invalid Daejeon timetable row: ${key}`);
    departureCount += parsed.length;
    byKey.set(key, parsed);
  }
  if (departureCount !== EXPECTED_DEPARTURE_COUNT) {
    throw new Error(`invalid Daejeon timetable departure count: ${departureCount}`);
  }
  return [...byKey.entries()].flatMap(([key, rows]) => {
    const [dayType, direction, stationNumber] = key.split(":");
    return rows.map((row) => ({ ...row, dayType, direction, stationNumber }));
  });
}

function requiredSource(inventory, snapshot, topologySnapshot, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.capabilities?.schedule?.productionUseAllowed !== true) {
    throw new Error(`${SOURCE_ID} is not admitted for production use`);
  }
  const evidence = source.scheduleAdmissionEvidence;
  if (!evidence || !/^daejeon-train-timetable-\d{8}$/.test(evidence.snapshotId ?? "")
    || evidence.capturedAt !== snapshot.observedAt || evidence.rowCount !== snapshot.rowCount
    || evidence.departureCount !== EXPECTED_DEPARTURE_COUNT || evidence.tripCount !== EXPECTED_TRIP_COUNT
    || evidence.stopTimeCount !== EXPECTED_STOP_TIME_COUNT || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.rowsSha256 !== snapshot.rowsSha256 || evidence.topologySourceId !== topologySnapshot.sourceId
    || evidence.topologySnapshotId !== inventory.sources.find(({ id }) => id === TOPOLOGY_SOURCE_ID)
      ?.topologyAdmissionEvidence?.snapshotId
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  const capturedAt = Date.parse(evidence.capturedAt);
  const freshUntil = Date.parse(evidence.freshUntil);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(freshUntil)
    || freshUntil !== capturedAt + FRESHNESS_MILLIS) {
    throw new Error(`${SOURCE_ID} inventory evidence freshness contract is invalid`);
  }
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(observedNow)) throw new Error("materialization time is invalid");
  if (observedNow < capturedAt) throw new Error(`${SOURCE_ID} evidence is future-dated`);
  if (observedNow >= freshUntil) throw new Error(`${SOURCE_ID} evidence is stale`);
  return source;
}

function validateTopologyLineage(pack, evidence) {
  const topologySource = pack.sourceInventory.find(({ id }) => id === TOPOLOGY_SOURCE_ID);
  const topologyEdges = pack.networkEdges.filter(({ sourceId }) => sourceId === TOPOLOGY_SOURCE_ID);
  if (!topologySource || topologyEdges.length !== 42
    || topologyEdges.some(({ sourceSnapshotId, evidenceHash }) =>
      sourceSnapshotId !== evidence.topologySnapshotId || evidenceHash !== evidence.topologyContentSha256)) {
    throw new Error("Daejeon timetable topology lineage mismatch");
  }
}

function canonicalStations(pack) {
  const stationNames = new Map(pack.stations.map(({ id, nameKo }) => [id, nameKo]));
  const rows = pack.stationLines
    .filter(({ lineId }) => lineId === LINE_ID)
    .sort((left, right) => Number(left.stationCode) - Number(right.stationCode));
  if (rows.length !== 22 || rows.some((row, index) => row.stationCode !== STATION_NUMBERS[index])) {
    throw new Error("Daejeon timetable canonical station mapping mismatch");
  }
  return new Map(rows.map((row) => [row.stationCode, {
    stationId: row.stationId,
    stationName: stationNames.get(row.stationId),
  }]));
}

function topologyDurations(pack) {
  const durations = new Map();
  for (const edge of pack.networkEdges.filter(({ sourceId }) => sourceId === TOPOLOGY_SOURCE_ID)) {
    const from = edge.fromNodeId.split(":")[0];
    const to = edge.toNodeId.split(":")[0];
    durations.set(`${from}:${to}`, edge.durationSeconds);
  }
  return durations;
}

function reconstructTrips(events, stationByNumber, durationByStationPair) {
  const byScope = Map.groupBy(events, ({ dayType, direction, stationNumber }) =>
    `${dayType}:${direction}:${stationNumber}`);
  const completed = [];
  for (const dayType of ["0", "1"]) {
    for (const direction of ["0", "1"]) {
      const stationNumbers = direction === "1" ? STATION_NUMBERS : [...STATION_NUMBERS].reverse();
      let active = [];
      for (const [stationIndex, stationNumber] of stationNumbers.entries()) {
        const station = stationByNumber.get(stationNumber);
        const departures = [...(byScope.get(`${dayType}:${direction}:${stationNumber}`) ?? [])]
          .sort((left, right) => left.seconds - right.seconds);
        if (stationIndex === 0) {
          active = departures.map((departure) => newTrip(dayType, direction, stationNumber, station, departure));
          continue;
        }
        const used = new Set();
        const nextActive = [];
        for (const trip of active) {
          const previous = trip.stops.at(-1);
          const duration = durationByStationPair.get(`${previous.stationId}:${station.stationId}`);
          if (!Number.isInteger(duration) || duration <= 0) {
            throw new Error(`Daejeon timetable topology duration missing: ${previous.stationId}:${station.stationId}`);
          }
          const terminalHere = trip.destinationName === station.stationName || stationIndex === stationNumbers.length - 1;
          if (terminalHere) {
            trip.stops.push(terminalStop(station, previous.departureSeconds + duration));
            completed.push(trip);
            continue;
          }
          const eligible = departures
            .map((departure, index) => ({ departure, index }))
            .filter(({ departure, index }) => !used.has(index)
              && departure.seconds - previous.departureSeconds >= 60
              && departure.seconds - previous.departureSeconds <= 300
              && (!trip.destinationName || !departure.destinationName
                || departure.destinationName === trip.destinationName));
          if (eligible.length !== 1) {
            throw new Error(`Daejeon timetable adjacent departure match is not unique: ${dayType}:${direction}:${stationNumber}`);
          }
          const [{ departure, index }] = eligible;
          used.add(index);
          trip.destinationName ||= departure.destinationName;
          trip.rawDepartures.push({ stationNumber, ...departure });
          trip.stops.push(departureStop(station, departure.seconds));
          nextActive.push(trip);
        }
        for (const [index, departure] of departures.entries()) {
          if (!used.has(index)) nextActive.push(newTrip(dayType, direction, stationNumber, station, departure));
        }
        active = nextActive.sort((left, right) =>
          left.stops.at(-1).departureSeconds - right.stops.at(-1).departureSeconds);
      }
      if (active.length !== 0) throw new Error(`Daejeon timetable active trips remain: ${dayType}:${direction}`);
    }
  }
  if (completed.length !== EXPECTED_TRIP_COUNT) {
    throw new Error(`Daejeon timetable trip count mismatch: ${completed.length}`);
  }
  completed.sort((left, right) => `${left.dayType}:${left.direction}:${left.originSeconds}:${left.originStationNumber}`
    .localeCompare(`${right.dayType}:${right.direction}:${right.originSeconds}:${right.originStationNumber}`));
  const ids = new Set();
  const stopTimes = [];
  for (const trip of completed) {
    trip.destinationName ||= trip.direction === "1" ? "반석" : "판암";
    trip.id = `trip-daejeon-${trip.dayType}-${trip.direction}-${trip.originStationNumber}-${serviceTime(trip.originSeconds)}`;
    if (ids.has(trip.id)) throw new Error(`duplicate Daejeon timetable trip id: ${trip.id}`);
    ids.add(trip.id);
    trip.providerRecordHash = sha256(JSON.stringify(trip.rawDepartures));
    trip.stops.forEach((stop, index) => stopTimes.push({
      ...stop,
      tripId: trip.id,
      stopSequence: index + 1,
      pickupType: index === trip.stops.length - 1 ? 1 : 0,
      dropOffType: index === 0 ? 1 : 0,
      providerRecordHash: trip.providerRecordHash,
    }));
  }
  if (stopTimes.length !== EXPECTED_STOP_TIME_COUNT) {
    throw new Error(`Daejeon timetable stop time count mismatch: ${stopTimes.length}`);
  }
  return { trips: completed, stopTimes };
}

function newTrip(dayType, direction, stationNumber, station, departure) {
  return {
    dayType,
    direction,
    originStationNumber: stationNumber,
    originSeconds: departure.seconds,
    destinationName: departure.destinationName,
    rawDepartures: [{ stationNumber, ...departure }],
    stops: [departureStop(station, departure.seconds)],
  };
}

function departureStop(station, seconds) {
  return { stationId: station.stationId, arrivalSeconds: seconds, departureSeconds: seconds };
}

function terminalStop(station, seconds) {
  return { stationId: station.stationId, arrivalSeconds: seconds, departureSeconds: seconds };
}

function serviceTime(seconds) {
  const hour = Math.floor(seconds / 3_600);
  const minute = Math.floor((seconds % 3_600) / 60);
  return `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
}

function scheduleProvenance(source, snapshot) {
  return {
    sourceId: SOURCE_ID,
    sourceSnapshotId: source.scheduleAdmissionEvidence.snapshotId,
    providerRecordHash: snapshot.rowsSha256,
    evidenceHash: sha256(JSON.stringify({
      timetableRowsSha256: snapshot.rowsSha256,
      topologyContentSha256: source.scheduleAdmissionEvidence.topologyContentSha256,
    })),
    updatedAt: snapshot.observedAt,
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

function packSource(source, snapshot) {
  return {
    id: source.id,
    owner: source.owner,
    url: source.datasetUrl,
    license: source.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: source.updateFrequency,
    updatedAt: snapshot.observedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const expected = ["--base-fixture", "--timetable-snapshot", "--topology-snapshot", "--inventory", "--station-map", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-daejeon-timetable.mjs --base-fixture <json> --timetable-snapshot <json> --topology-snapshot <json> --inventory <json> --station-map <csv> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

async function main(argv) {
  const args = parseArgs(argv);
  const [baseFixture, timetableSnapshot, topologySnapshot, inventory, stationMapCsv] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["timetable-snapshot"], "utf8").then(JSON.parse),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
    readFile(args["station-map"]),
  ]);
  const fixture = materializeDaejeonTimetable({
    baseFixture,
    timetableSnapshot,
    topologySnapshot,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(stationMapCsv),
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Daejeon timetable materialized: trips=${EXPECTED_TRIP_COUNT} stopTimes=${EXPECTED_STOP_TIME_COUNT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daejeon timetable materialization failed");
    process.exitCode = 1;
  }
}
