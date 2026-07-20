#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseMolitGwangjuStationMappings } from "./build-molit-nationwide-fixture.mjs";

const SOURCE_ID = "gwangju-transportation-cyberstation-timetable";
const TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const MEMBERSHIP_SOURCE_ID = "molit-urban-rail-full-route-gwangju-membership";
const MEMBERSHIP_RAW_SOURCE_ID = "molit-urban-rail-full-route";
const OPERATOR_ID = "gwangju-metropolitan-rapid-transit";
const LINE_ID = "line-e57a361e8892";
const PACK_ID = "nationwide-gwangju-schedule";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const STATION_CODES = Object.freeze(Array.from({ length: 20 }, (_, index) => String(100 + index)));
const EXPECTED_TRIP_COUNT = 810;
const EXPECTED_OFFICIAL_STOP_TIME_COUNT = 13_360;
const EXPECTED_GENERATED_STOP_TIME_COUNT = 811;
const EXPECTED_STOP_TIME_COUNT = 14_171;
const SERVICES = Object.freeze({
  WEEK: "gwangju-weekday-2026",
  SAT: "gwangju-saturday-2026",
  HOLI: "gwangju-holiday-2026",
  DAYOFF: "gwangju-sunday-2026",
});
const HOLIDAYS_2026 = Object.freeze([
  "20260101", "20260216", "20260217", "20260218", "20260301", "20260302", "20260501",
  "20260505", "20260524", "20260525", "20260603", "20260606", "20260717", "20260815",
  "20260817", "20260924", "20260925", "20260926", "20261003", "20261005", "20261009", "20261225",
]);
const QUARANTINED_KEYS = Object.freeze([
  "DAYOFF:st:119:0756",
  "DAYOFF:st:118:0759",
]);

export function materializeGwangjuTimetable({
  baseFixture,
  timetableSnapshot,
  topologySnapshot,
  inventory,
  canonicalStationMappings,
  now = new Date(),
}) {
  validateTimetableSnapshot(timetableSnapshot);
  validateTopologySnapshot(topologySnapshot);
  const sources = requiredSources(inventory, timetableSnapshot, topologySnapshot, canonicalStationMappings, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Gwangju timetable requires one cumulative production pack");
  }
  for (const id of [SOURCE_ID, TOPOLOGY_SOURCE_ID, MEMBERSHIP_SOURCE_ID]) {
    if (pack.sourceInventory.some((source) => source.id === id)) throw new Error(`${id} already exists`);
  }
  if (pack.lines.some(({ id }) => id === LINE_ID) || pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Gwangju line already exists in base fixture");
  }

  pack.sourceInventory.push(
    packSource(sources.membership, sources.membership.membershipAdmissionEvidence.verifiedAt),
    packSource(sources.topology, topologySnapshot.capturedAt),
    packSource(sources.timetable, timetableSnapshot.capturedAt),
  );
  pack.operators.push({ id: OPERATOR_ID, nameKo: "광주교통공사", nameEn: "" });
  pack.lines.push({ id: LINE_ID, operatorId: OPERATOR_ID, nameKo: "광주 1호선", nameEn: "", color: "#009088" });

  const stations = addStationsAndTopology(pack, topologySnapshot, canonicalStationMappings, sources);
  const durations = new Map(topologySnapshot.edges.map((edge) => [
    `${edge.fromStationCode}:${edge.toStationCode}`, edge.durationSeconds,
  ]));
  const { trips, quarantinedRows, repairedStopCount } = reconstructTrips(
    timetableSnapshot.rows,
    stations,
    durations,
  );
  if (JSON.stringify(quarantinedRows.map(rowKey)) !== JSON.stringify(QUARANTINED_KEYS)
    || repairedStopCount !== 1) {
    throw new Error("Gwangju timetable quarantine tuple mismatch");
  }

  const scheduleProvenance = provenanceForSchedule(sources.timetable, timetableSnapshot, topologySnapshot);
  addCalendars(pack, scheduleProvenance);
  addRoutes(pack, scheduleProvenance);
  for (const trip of trips) {
    const tripProvenance = { ...scheduleProvenance, providerRecordHash: trip.providerRecordHash };
    pack.transitTrips.push(withProvenance({
      id: trip.id,
      routeId: `route-gwangju-1-${trip.direction}`,
      serviceId: SERVICES[trip.dayCode],
      tripHeadsign: trip.endName.replace(/역$/u, ""),
      directionId: trip.direction === "pd" ? "increasing" : "decreasing",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      serviceDayStartSeconds: 0,
    }, tripProvenance));
    for (const [index, stop] of trip.stops.entries()) {
      pack.transitStopTimes.push(withProvenance({
        tripId: trip.id,
        stopSequence: index + 1,
        stationId: stop.stationId,
        lineId: LINE_ID,
        arrivalSeconds: stop.seconds,
        departureSeconds: stop.seconds,
        pickupType: index === trip.stops.length - 1 ? 1 : 0,
        dropOffType: index === 0 ? 1 : 0,
        ...(stop.repairReason ? { repairReason: stop.repairReason } : {}),
      }, {
        ...tripProvenance,
        providerRecordHash: stop.providerRecordHash ?? trip.providerRecordHash,
      }, stop.derivationKind));
    }
  }
  const producedStopTimes = pack.transitStopTimes.filter(({ sourceId }) => sourceId === SOURCE_ID);
  if (trips.length !== EXPECTED_TRIP_COUNT || producedStopTimes.length !== EXPECTED_STOP_TIME_COUNT
    || producedStopTimes.filter(({ derivationKind }) => derivationKind === "OFFICIAL").length
      !== EXPECTED_OFFICIAL_STOP_TIME_COUNT
    || producedStopTimes.filter(({ derivationKind }) => derivationKind === "GENERATED").length
      !== EXPECTED_GENERATED_STOP_TIME_COUNT) {
    throw new Error("Gwangju timetable materialized row counts are invalid");
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
  const version = compactSeoulDate(timetableSnapshot.capturedAt);
  const composition = sha256(JSON.stringify({
    previousPackId: pack.id,
    timetableSnapshotId: sources.timetable.scheduleAdmissionEvidence.snapshotId,
    topologySnapshotId: sources.topology.topologyAdmissionEvidence.snapshotId,
    timetableRowsSha256: timetableSnapshot.rowsSha256,
    topologyContentSha256: topologySnapshot.contentSha256,
    sourceEvidence: sources,
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

function validateTimetableSnapshot(snapshot) {
  const fragments = snapshot?.fragments?.map(({ stationId, rawSha256 }) => ({ stationId, rawSha256 }));
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "gwangju-cyberstation-timetable-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRedacted !== true || snapshot.requestCount !== 21 || snapshot.stationRequestCount !== 20
    || snapshot.stationCount !== 20 || snapshot.rowCount !== 13_362 || snapshot.rows?.length !== 13_362
    || snapshot.excludedPlaceholderCount !== 1 || snapshot.normalizedBoundaryMinuteCount !== 1
    || JSON.stringify(snapshot.dayCodes) !== JSON.stringify(["DAYOFF", "HOLI", "SAT", "WEEK"])
    || JSON.stringify(snapshot.directions) !== JSON.stringify(["nd", "pd", "st"])
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || snapshot.contentSha256 !== sha256(JSON.stringify({ fragments, rowsSha256: snapshot.rowsSha256 }))) {
    throw new Error("invalid Gwangju timetable snapshot");
  }
  const keys = new Set();
  for (const row of snapshot.rows) {
    const key = rowKey(row);
    if (!SERVICES[row.dayCode] || !new Set(["nd", "pd", "st"]).has(row.direction)
      || !STATION_CODES.includes(row.stationCode) || !STATION_CODES.includes(row.endCode)
      || !/^\d{4}$/.test(row.time) || Number(row.time.slice(0, 2)) > 29
      || Number(row.time.slice(2)) > 59 || keys.has(key)) {
      throw new Error(`invalid Gwangju timetable row: ${key}`);
    }
    keys.add(key);
  }
}

function validateTopologySnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "gwangju-route-topology-snapshot"
    || snapshot.sourceId !== TOPOLOGY_SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || snapshot.requestCount !== 20 || snapshot.stationCount !== 20 || snapshot.odRowCount !== 380
    || snapshot.edgeCount !== 38 || snapshot.scope?.length !== 20 || snapshot.edges?.length !== 38
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || snapshot.edgesSha256 !== sha256(JSON.stringify(snapshot.edges))
    || snapshot.contentSha256 !== sha256(JSON.stringify({ scope: snapshot.scope, edges: snapshot.edges }))) {
    throw new Error("invalid Gwangju topology snapshot");
  }
  const pairs = new Set();
  for (const edge of snapshot.edges) {
    const key = `${edge.fromStationCode}:${edge.toStationCode}`;
    if (!STATION_CODES.includes(edge.fromStationCode) || !STATION_CODES.includes(edge.toStationCode)
      || Math.abs(Number(edge.fromStationCode) - Number(edge.toStationCode)) !== 1
      || !Number.isInteger(edge.distanceMeters) || edge.distanceMeters <= 0
      || !Number.isInteger(edge.durationSeconds) || edge.durationSeconds <= 0 || pairs.has(key)) {
      throw new Error(`invalid Gwangju topology edge: ${key}`);
    }
    pairs.add(key);
  }
}

function requiredSources(inventory, timetableSnapshot, topologySnapshot, mappings, now) {
  const timetable = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const topology = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID);
  const membership = inventory?.sources?.find(({ id }) => id === MEMBERSHIP_SOURCE_ID);
  const rawMembership = inventory?.sources?.find(({ id }) => id === MEMBERSHIP_RAW_SOURCE_ID);
  const schedule = timetable?.scheduleAdmissionEvidence;
  const topologyEvidence = topology?.topologyAdmissionEvidence;
  const membershipEvidence = membership?.membershipAdmissionEvidence;
  const mappingSha256 = sha256(JSON.stringify(mappings));
  const stationCodesSha256 = sha256(JSON.stringify(mappings?.map(({ stationNumber }) => stationNumber)));
  if (timetable?.productionUseAllowed !== true || timetable.license?.redistributionAllowed !== true
    || timetable.capabilities?.schedule?.productionUseAllowed !== true
    || schedule?.issue !== 2383 || schedule.materializer !== "tools/datapack/materialize-gwangju-timetable.mjs"
    || schedule.verificationTest !== "tools/datapack/materialize-gwangju-timetable.test.mjs"
    || schedule.snapshotId !== "gwangju-transportation-cyberstation-timetable-20260720"
    || schedule.capturedAt !== timetableSnapshot.capturedAt || schedule.freshUntil !== timetableSnapshot.freshUntil
    || schedule.rowCount !== 13_362 || schedule.departureCount !== EXPECTED_OFFICIAL_STOP_TIME_COUNT
    || schedule.tripCount !== EXPECTED_TRIP_COUNT || schedule.stopTimeCount !== EXPECTED_STOP_TIME_COUNT
    || schedule.rawSha256 !== timetableSnapshot.rawSha256
    || schedule.rowsSha256 !== timetableSnapshot.rowsSha256
    || schedule.topologySourceId !== TOPOLOGY_SOURCE_ID
    || schedule.topologySnapshotId !== topologyEvidence?.snapshotId
    || schedule.topologyContentSha256 !== topologySnapshot.contentSha256) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  if (topology?.productionUseAllowed !== true || topology.license?.redistributionAllowed !== true
    || topologyEvidence?.issue !== 2383
    || topologyEvidence.materializer !== "tools/datapack/materialize-gwangju-timetable.mjs"
    || topologyEvidence.verificationTest !== "tools/datapack/materialize-gwangju-timetable.test.mjs"
    || topologyEvidence.snapshotId !== "gwangju-transportation-route-topology-20260720"
    || topologyEvidence.capturedAt !== topologySnapshot.capturedAt
    || topologyEvidence.freshUntil !== topologySnapshot.freshUntil
    || topologyEvidence.stationCount !== 20 || topologyEvidence.excludedTransferCount !== 0
    || topologyEvidence.edgeCount !== 38 || topologyEvidence.rawSha256 !== topologySnapshot.rawSha256
    || topologyEvidence.contentSha256 !== topologySnapshot.contentSha256
    || JSON.stringify(topology.membershipAdmissionEvidence) !== JSON.stringify(membershipEvidence)) {
    throw new Error(`${TOPOLOGY_SOURCE_ID} inventory evidence does not match snapshot`);
  }
  if (!Array.isArray(mappings) || mappings.length !== 20
    || mappings.some((mapping, index) => mapping.stationNumber !== STATION_CODES[index])
    || membership?.productionUseAllowed !== true || membership.license?.redistributionAllowed !== true
    || rawMembership?.admissionEvidence?.decision !== "APPROVED"
    || membershipEvidence?.issue !== 2383
    || membershipEvidence.materializer !== "tools/datapack/materialize-gwangju-timetable.mjs"
    || membershipEvidence.verificationTest !== "tools/datapack/materialize-gwangju-timetable.test.mjs"
    || membershipEvidence.stationCount !== 20 || membershipEvidence.mappingSha256 !== mappingSha256
    || membershipEvidence.stationCodesSha256 !== stationCodesSha256
    || membershipEvidence.membershipSourceId !== MEMBERSHIP_RAW_SOURCE_ID
    || membershipEvidence.membershipSourceRawSha256 !== rawMembership.admissionEvidence.rawSha256
    || membershipEvidence.membershipSourceSnapshotSha256 !== mappings.sourceRawSha256
    || membershipEvidence.stationCodeSourceId !== TOPOLOGY_SOURCE_ID
    || membershipEvidence.stationCodeSnapshotId !== topologyEvidence.snapshotId
    || membershipEvidence.stationCodeContentSha256 !== topologySnapshot.contentSha256) {
    throw new Error(`${MEMBERSHIP_SOURCE_ID} membership evidence is invalid`);
  }
  for (const [label, capturedAt, freshUntil] of [
    [SOURCE_ID, schedule.capturedAt, schedule.freshUntil],
    [TOPOLOGY_SOURCE_ID, topologyEvidence.capturedAt, topologyEvidence.freshUntil],
  ]) {
    const captured = Date.parse(capturedAt);
    const fresh = Date.parse(freshUntil);
    const current = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(captured) || fresh !== captured + FRESHNESS_MILLIS
      || !Number.isFinite(current) || current < captured || current >= fresh) {
      throw new Error(`${label} evidence is stale or future-dated`);
    }
  }
  return { timetable, topology, membership };
}

function addStationsAndTopology(pack, snapshot, mappings, sources) {
  const scopeByCode = new Map(snapshot.scope.map((row) => [row.stationCode, row]));
  const stations = new Map();
  const membershipEvidence = sources.membership.membershipAdmissionEvidence;
  const topologyEvidence = sources.topology.topologyAdmissionEvidence;
  for (const [index, mapping] of mappings.entries()) {
    const scope = scopeByCode.get(mapping.stationNumber);
    if (!scope || normalizedName(mapping.stationName) !== normalizedName(scope.stationName)) {
      throw new Error(`Gwangju canonical station mapping mismatch: ${mapping.stationNumber}`);
    }
    const membershipHash = sha256(JSON.stringify({
      lineId: LINE_ID, stationName: mapping.stationName, stationSequence: index + 1,
    }));
    pack.stations.push({
      id: mapping.stationId,
      nameKo: mapping.stationName,
      nameEn: "",
      normalizedName: mapping.stationName.normalize("NFKC"),
      region: "광주권",
      latitude: null,
      longitude: null,
      dataQualityLevel: "LEVEL_2",
      dataSourceType: "OFFICIAL_FILE",
      sourceId: MEMBERSHIP_SOURCE_ID,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipHash,
      evidenceHash: membershipEvidence.mappingSha256,
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
    pack.stationLines.push({
      stationId: mapping.stationId,
      lineId: LINE_ID,
      stationCode: mapping.stationNumber,
      lineSequence: index + 1,
      platformInfo: "",
      sourceId: MEMBERSHIP_SOURCE_ID,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipHash,
      evidenceHash: membershipEvidence.mappingSha256,
      fieldProvenance: {
        station_code: {
          sourceId: TOPOLOGY_SOURCE_ID,
          sourceSnapshotId: topologyEvidence.snapshotId,
          providerRecordHash: sha256(JSON.stringify(scope)),
          evidenceHash: snapshot.contentSha256,
          derivationKind: "OFFICIAL",
          verifiedAt: snapshot.capturedAt,
        },
      },
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
    stations.set(mapping.stationNumber, mapping);
  }
  for (const edge of snapshot.edges) {
    const from = stations.get(edge.fromStationCode);
    const to = stations.get(edge.toStationCode);
    pack.networkEdges.push({
      id: `edge-gwangju-${edge.fromStationCode}-${edge.toStationCode}`,
      fromNodeId: `${from.stationId}:${LINE_ID}`,
      toNodeId: `${to.stationId}:${LINE_ID}`,
      durationSeconds: edge.durationSeconds,
      distanceMeters: edge.distanceMeters,
      edgeType: "RIDE",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      includesStairs: false,
      stairAccessState: "UNKNOWN",
      accessibilityStatus: "UNKNOWN",
      reliabilityScore: 100,
      sourceId: TOPOLOGY_SOURCE_ID,
      sourceSnapshotId: topologyEvidence.snapshotId,
      providerRecordHash: sha256(JSON.stringify(edge)),
      provenanceKind: "OFFICIAL_SOURCE",
      derivationKind: "OFFICIAL",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: snapshot.capturedAt,
      evidenceHash: snapshot.contentSha256,
    });
  }
  return stations;
}

function reconstructTrips(rows, stations, durations) {
  const byScope = Map.groupBy(rows, (row) => `${row.dayCode}:${row.direction}:${row.stationCode}`);
  const completed = [];
  const quarantinedRows = [];
  let repairedStopCount = 0;
  for (const dayCode of ["WEEK", "SAT", "HOLI", "DAYOFF"]) {
    for (const direction of ["pd", "st", "nd"]) {
      const codes = direction === "pd" ? STATION_CODES : [...STATION_CODES].reverse();
      let active = [];
      for (const [stationIndex, stationCode] of codes.entries()) {
        const events = [...(byScope.get(`${dayCode}:${direction}:${stationCode}`) ?? [])]
          .map((row) => ({ row, seconds: serviceSeconds(row.time) }))
          .sort((left, right) => left.seconds - right.seconds);
        if (stationIndex === 0) {
          active = events.map((event) => newTrip(event, stations));
          continue;
        }
        const used = new Set();
        const nextActive = [];
        for (const trip of active) {
          const previous = trip.officialStops.at(-1);
          if (previous.row.endCode === stationCode) {
            const duration = requiredDuration(durations, previous.row.stationCode, stationCode);
            trip.stops.push(generatedStop(stations.get(stationCode), previous.seconds + duration, "OFFICIAL_TOPOLOGY_TERMINAL"));
            completed.push(trip);
            continue;
          }
          if (trip.pendingGap) {
            const firstDuration = requiredDuration(durations, previous.row.stationCode, trip.pendingGap);
            const secondDuration = requiredDuration(durations, trip.pendingGap, stationCode);
            const match = uniqueMatch(events, used, trip, firstDuration + secondDuration);
            if (!match) {
              quarantinedRows.push(...trip.officialStops.map(({ row }) => row));
              continue;
            }
            const missingSeconds = previous.seconds + firstDuration;
            trip.stops.push(generatedStop(
              stations.get(trip.pendingGap),
              missingSeconds,
              "OFFICIAL_ADJACENT_TIMES_AND_TOPOLOGY",
            ));
            repairedStopCount += 1;
            appendOfficialStop(trip, match, stations);
            used.add(match.index);
            trip.pendingGap = null;
            nextActive.push(trip);
            continue;
          }
          const duration = requiredDuration(durations, previous.row.stationCode, stationCode);
          const match = uniqueMatch(events, used, trip, duration);
          if (match) {
            appendOfficialStop(trip, match, stations);
            used.add(match.index);
          } else {
            trip.pendingGap = stationCode;
          }
          nextActive.push(trip);
        }
        for (const [index, event] of events.entries()) {
          if (!used.has(index)) nextActive.push(newTrip(event, stations));
        }
        active = nextActive.sort((left, right) =>
          left.officialStops.at(-1).seconds - right.officialStops.at(-1).seconds);
      }
      if (active.length !== 0) {
        quarantinedRows.push(...active.flatMap((trip) => trip.officialStops.map(({ row }) => row)));
      }
    }
  }
  quarantinedRows.sort((left, right) => QUARANTINED_KEYS.indexOf(rowKey(left)) - QUARANTINED_KEYS.indexOf(rowKey(right)));
  const accounted = completed.reduce((total, trip) => total + trip.officialStops.length, 0) + quarantinedRows.length;
  if (accounted !== rows.length || quarantinedRows.length !== 2 || completed.length !== EXPECTED_TRIP_COUNT) {
    throw new Error(`Gwangju timetable reconstruction incomplete: accounted=${accounted} trips=${completed.length}`);
  }
  completed.sort((left, right) => [left.dayCode, left.direction, left.originCode, left.originSeconds].join(":")
    .localeCompare([right.dayCode, right.direction, right.originCode, right.originSeconds].join(":"), "en"));
  const ids = new Set();
  for (const trip of completed) {
    trip.id = `trip-gwangju-${trip.dayCode.toLowerCase()}-${trip.direction}-${trip.originCode}-${serviceTime(trip.originSeconds)}`;
    if (ids.has(trip.id)) throw new Error(`duplicate Gwangju trip id: ${trip.id}`);
    ids.add(trip.id);
    trip.providerRecordHash = sha256(JSON.stringify({
      rows: trip.officialStops.map(({ row }) => row),
      generatedStops: trip.stops.filter(({ derivationKind }) => derivationKind === "GENERATED")
        .map(({ stationId, seconds, repairReason }) => ({ stationId, seconds, repairReason })),
    }));
  }
  return { trips: completed, quarantinedRows, repairedStopCount };
}

function uniqueMatch(events, used, trip, expectedDuration) {
  const previous = trip.officialStops.at(-1);
  const eligible = events.map((event, index) => ({ ...event, index,
    deviation: Math.abs(event.seconds - previous.seconds - expectedDuration) }))
    .filter((event) => !used.has(event.index) && event.row.endCode === previous.row.endCode
      && event.seconds >= previous.seconds && event.deviation <= 120);
  if (eligible.length === 0) return null;
  const bestDeviation = Math.min(...eligible.map(({ deviation }) => deviation));
  const best = eligible.filter(({ deviation }) => deviation === bestDeviation);
  if (best.length !== 1) {
    throw new Error(`Gwangju timetable adjacent match is ambiguous: ${rowKey(previous.row)}`);
  }
  return best[0];
}

function newTrip(event, stations) {
  const stop = officialStop(event, stations);
  return {
    dayCode: event.row.dayCode,
    direction: event.row.direction,
    endName: event.row.endName,
    originCode: event.row.stationCode,
    originSeconds: event.seconds,
    officialStops: [event],
    stops: [stop],
    pendingGap: null,
  };
}

function appendOfficialStop(trip, event, stations) {
  trip.officialStops.push({ row: event.row, seconds: event.seconds });
  trip.stops.push(officialStop(event, stations));
}

function officialStop(event, stations) {
  return {
    stationId: stations.get(event.row.stationCode).stationId,
    seconds: event.seconds,
    derivationKind: "OFFICIAL",
    providerRecordHash: sha256(JSON.stringify(event.row)),
  };
}

function generatedStop(station, seconds, repairReason) {
  return { stationId: station.stationId, seconds, derivationKind: "GENERATED", repairReason };
}

function requiredDuration(durations, from, to) {
  const duration = durations.get(`${from}:${to}`);
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error(`Gwangju topology duration missing: ${from}:${to}`);
  }
  return duration;
}

function addCalendars(pack, provenance) {
  pack.serviceCalendars.push(
    withProvenance({ serviceId: SERVICES.WEEK, monday: true, tuesday: true, wednesday: true,
      thursday: true, friday: true, saturday: false, sunday: false,
      startDate: "20260101", endDate: "20261231" }, provenance),
    withProvenance({ serviceId: SERVICES.SAT, monday: false, tuesday: false, wednesday: false,
      thursday: false, friday: false, saturday: true, sunday: false,
      startDate: "20260101", endDate: "20261231" }, provenance),
    withProvenance({ serviceId: SERVICES.HOLI, monday: false, tuesday: false, wednesday: false,
      thursday: false, friday: false, saturday: false, sunday: false,
      startDate: "20260101", endDate: "20261231" }, provenance),
    withProvenance({ serviceId: SERVICES.DAYOFF, monday: false, tuesday: false, wednesday: false,
      thursday: false, friday: false, saturday: false, sunday: true,
      startDate: "20260101", endDate: "20261231" }, provenance),
  );
  pack.serviceCalendarDates.push(...HOLIDAYS_2026.flatMap((date) => {
    const day = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`).getUTCDay();
    const base = day === 0 ? SERVICES.DAYOFF : day === 6 ? SERVICES.SAT : SERVICES.WEEK;
    return [
      withProvenance({ serviceId: SERVICES.HOLI, date, exceptionType: 1 }, provenance, "GENERATED"),
      withProvenance({ serviceId: base, date, exceptionType: 2 }, provenance, "GENERATED"),
    ];
  }));
}

function addRoutes(pack, provenance) {
  for (const [direction, endName] of [["pd", "평동"], ["st", "소태"], ["nd", "녹동"]]) {
    pack.transitRoutes.push(withProvenance({
      id: `route-gwangju-1-${direction}`,
      lineId: LINE_ID,
      routeShortName: "1",
      routeLongName: `광주 1호선 ${endName} 방면`,
      directionName: `${endName} 방면`,
    }, provenance));
  }
}

function provenanceForSchedule(source, timetableSnapshot, topologySnapshot) {
  return {
    sourceId: SOURCE_ID,
    sourceSnapshotId: source.scheduleAdmissionEvidence.snapshotId,
    providerRecordHash: timetableSnapshot.rowsSha256,
    evidenceHash: sha256(JSON.stringify({
      timetableContentSha256: timetableSnapshot.contentSha256,
      topologyContentSha256: topologySnapshot.contentSha256,
    })),
    updatedAt: timetableSnapshot.capturedAt,
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

function normalizedName(value) {
  return String(value).normalize("NFKC").replace(/\([^)]*\)/g, "").replace(/[\s/.·]/g, "").replace(/역$/u, "");
}
function rowKey(row) { return [row.dayCode, row.direction, row.stationCode, row.time].join(":"); }
function serviceSeconds(time) { return Number(time.slice(0, 2)) * 3_600 + Number(time.slice(2)) * 60; }
function serviceTime(seconds) {
  return `${String(Math.floor(seconds / 3_600)).padStart(2, "0")}${String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0")}`;
}
function compactSeoulDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function parseArgs(argv) {
  const expected = ["--base-fixture", "--timetable-snapshot", "--topology-snapshot", "--inventory", "--station-map", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-gwangju-timetable.mjs --base-fixture <json> --timetable-snapshot <json> --topology-snapshot <json> --inventory <json> --station-map <csv> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runGwangjuTimetableMaterializer(argv, { now = new Date() } = {}) {
  const args = parseArgs(argv);
  const [baseFixture, timetableSnapshot, topologySnapshot, inventory, stationMap] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["timetable-snapshot"], "utf8").then(JSON.parse),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
    readFile(args["station-map"]),
  ]);
  const fixture = materializeGwangjuTimetable({
    baseFixture,
    timetableSnapshot,
    topologySnapshot,
    inventory,
    canonicalStationMappings: parseMolitGwangjuStationMappings(stationMap),
    now,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Gwangju timetable materialized: trips=${EXPECTED_TRIP_COUNT} stopTimes=${EXPECTED_STOP_TIME_COUNT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runGwangjuTimetableMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju timetable materialization failed");
    process.exitCode = 1;
  }
}
