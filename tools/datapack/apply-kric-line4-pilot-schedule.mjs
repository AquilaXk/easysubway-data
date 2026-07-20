#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const SOURCE_ID = "kric-subway-timetable";
const SOURCE_ARTIFACT_IDS = new Set([SOURCE_ID, "kric-subway-route-info"]);
const LINE_ID = "seoul-4";
const START_DATE = "20260101";
const END_DATE = "20261231";
const EXPECTED_REQUEST_COUNT = 153;
const EXPECTED_INTERMEDIATE_ROW_COUNT = 33062;
const EXPECTED_TRANSIT_TRIP_COUNT = 895;
const EXPECTED_TRANSIT_STOP_TIME_COUNT = 33062;
const EXPECTED_PILOT_TRANSIT_TRIP_COUNT = 466;
const EXPECTED_PILOT_TRANSIT_STOP_TIME_COUNT = 932;
const STATION_MAP = {
  "station-seoul-4-433": { stationId: "station-sadang", stationCode: "433", nameKo: "사당" },
  "station-seoul-4-448": { stationId: "station-sangnoksu", stationCode: "448", nameKo: "상록수" },
};
const CALENDAR_DAYS = {
  "weekday-kric": { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
  "saturday-kric": { monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: false },
  "holiday-kric": { monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: true },
};
const WEEKDAY_HOLIDAY_DATES_2026 = [
  "20260101",
  "20260216",
  "20260217",
  "20260218",
  "20260302",
  "20260505",
  "20260525",
  "20260603",
  "20260817",
  "20260924",
  "20260925",
  "20261005",
  "20261009",
  "20261225",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await readFile(requireArg(args, "input"), "utf8"));
  const artifactBytes = await readFile(requireArg(args, "artifact"));
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  const outputPath = requireArg(args, "output");

  const transformed = applySchedule(input, artifact, artifactBytes);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(transformed, null, 2)}\n`);
}

export function applySchedule(input, artifact, artifactBytes = Buffer.from(JSON.stringify(artifact))) {
  validateArtifact(artifact);
  const tripsById = new Map((artifact.transitTrips ?? []).map((trip) => [trip.id, trip]));
  const stopTimesByTrip = new Map();
  for (const stopTime of artifact.transitStopTimes ?? []) {
    if (!STATION_MAP[stopTime.stationId]) continue;
    const rows = stopTimesByTrip.get(stopTime.tripId) ?? [];
    rows.push(stopTime);
    stopTimesByTrip.set(stopTime.tripId, rows);
  }

  const transitTrips = [];
  const transitStopTimes = [];
  for (const [tripId, rows] of [...stopTimesByTrip.entries()].sort(([left], [right]) => codepointCompare(left, right))) {
    if (rows.length !== 2) continue;
    const trip = tripsById.get(tripId);
    if (!trip) continue;
    const ordered = rows.toSorted((left, right) => left.stopSequence - right.stopSequence);
    transitTrips.push({
      id: trip.id,
      routeId: trip.routeId,
      serviceId: trip.serviceId,
      tripHeadsign: STATION_MAP[ordered.at(-1).stationId].nameKo,
      directionId: trip.directionId,
      servicePattern: trip.servicePattern ?? "LOCAL",
    });
    ordered.forEach((row, index) => {
      transitStopTimes.push({
        tripId,
        stopSequence: index + 1,
        stationId: STATION_MAP[row.stationId].stationId,
        lineId: row.lineId,
        arrivalSeconds: row.arrivalSeconds,
        departureSeconds: row.departureSeconds,
      });
    });
  }
  if (transitTrips.length === 0) {
    throw new Error("KRIC pilot schedule has no paired Sangnoksu-Sadang trips");
  }
  requireEqual(transitTrips.length, EXPECTED_PILOT_TRANSIT_TRIP_COUNT, "pairedTransitTripCount");
  requireEqual(transitStopTimes.length, EXPECTED_PILOT_TRANSIT_STOP_TIME_COUNT, "pairedTransitStopTimeCount");

  const serviceCalendars = [...new Set(transitTrips.map((trip) => trip.serviceId))]
    .sort((left, right) => codepointCompare(left, right))
    .map((serviceId) => ({ serviceId, ...requireCalendar(serviceId), startDate: START_DATE, endDate: END_DATE }));

  return {
    ...input,
    sourceIds: unique([...(input.sourceIds ?? []), SOURCE_ID]),
    stationMappings: uniqueBy(
      [
        ...(input.stationMappings ?? []),
        ...Object.values(STATION_MAP).map((station) => ({
          sourceId: SOURCE_ID,
          sourceStationCode: station.stationCode,
          lineId: LINE_ID,
          stationId: station.stationId,
          stationLineId: `${station.stationId}:${LINE_ID}`,
          mappingStatus: "active",
        })),
      ],
      (row) => `${row.sourceId}:${row.sourceStationCode}:${row.lineId}`,
    ),
    stationLineRows: uniqueBy(
      [
        ...(input.stationLineRows ?? []),
        ...Object.values(STATION_MAP).map((station) => ({
          ...stationLineTemplate(input, station.stationCode),
          sourceId: SOURCE_ID,
          sourceStationCode: station.stationCode,
          lastVerifiedAt: `${artifact.capturedAt ?? "2026-07-09"}T00:00:00.000Z`,
        })),
      ],
      (row) => `${row.sourceId}:${row.sourceStationCode}:${row.lineId}`,
    ),
    coverageEvidence: uniqueBy(
      [
        ...(input.coverageEvidence ?? []),
        {
          regionId: "capital",
          operatorId: "seoul-metro",
          sourceDomain: "schedule_timetable",
          sourceIds: [SOURCE_ID],
          evidence: "KRIC subwayTimetableExp 4호선 상록수-사당 pilot 수집 및 trip/stop sequence 재구성 evidence",
        },
      ],
      (row) => `${row.regionId}:${row.operatorId}:${row.sourceDomain}`,
    ),
    scheduleProvenance: {
      sourceId: SOURCE_ID,
      sourceSnapshotId: `kric-subway-timetable-line4-pilot-${String(artifact.capturedAt ?? "20260709").replaceAll("-", "")}`,
      providerRecordHash: sha256(artifactBytes),
      evidenceHash: sha256(`kric-line4-pilot-schedule:${sha256(artifactBytes)}`),
      retrievedAt: `${artifact.capturedAt ?? "2026-07-09"}T00:00:00.000Z`,
    },
    serviceCalendars,
    serviceCalendarDates: holidayExceptionDates(),
    transitRoutes: [
      {
        id: "route-seoul-4-up",
        lineId: LINE_ID,
        routeShortName: "4",
        routeLongName: "수도권 4호선 상록수 방면",
        directionName: "상록수 방면",
      },
      {
        id: "route-seoul-4-down",
        lineId: LINE_ID,
        routeShortName: "4",
        routeLongName: "수도권 4호선 사당 방면",
        directionName: "사당 방면",
      },
    ],
    transitTrips,
    transitStopTimes,
    transitFeedInfo: [{ feedEndDate: END_DATE }],
  };
}

function holidayExceptionDates() {
  return WEEKDAY_HOLIDAY_DATES_2026.flatMap((date) => [
    { serviceId: "holiday-kric", date, exceptionType: 1 },
    { serviceId: "weekday-kric", date, exceptionType: 2 },
  ]);
}

function stationLineTemplate(input, stationCode) {
  const row = (input.stationLineRows ?? []).find((candidate) => candidate.stationCode === stationCode);
  if (!row) {
    throw new Error(`production input missing stationLineRows stationCode: ${stationCode}`);
  }
  return row;
}

function requireCalendar(serviceId) {
  const days = CALENDAR_DAYS[serviceId];
  if (!days) {
    throw new Error(`unknown KRIC serviceId: ${serviceId}`);
  }
  return days;
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(rows, keyFn) {
  return [...new Map(rows.map((row) => [keyFn(row), row])).values()];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("KRIC pilot artifact must be an object");
  }
  requireEqual(artifact.artifactKind, "kric-line4-timetable-collection", "artifactKind");
  if (artifact.sourceId && !SOURCE_ARTIFACT_IDS.has(artifact.sourceId)) {
    throw new Error(`KRIC pilot artifact sourceId mismatch: ${artifact.sourceId}`);
  }
  requireEqual(artifact.lineId, LINE_ID, "lineId");
  requireEqual(artifact.requestCount, EXPECTED_REQUEST_COUNT, "requestCount");
  requireEqual(artifact.failedRequestCount, 0, "failedRequestCount");
  requireEqual(artifact.intermediateRowCount, EXPECTED_INTERMEDIATE_ROW_COUNT, "intermediateRowCount");
  requireEqual(artifact.transitTripCount, EXPECTED_TRANSIT_TRIP_COUNT, "transitTripCount");
  requireEqual(artifact.transitStopTimeCount, EXPECTED_TRANSIT_STOP_TIME_COUNT, "transitStopTimeCount");
  if (!Array.isArray(artifact.transitTrips) || !Array.isArray(artifact.transitStopTimes)) {
    throw new TypeError("KRIC pilot artifact missing transit rows");
  }
  requireEqual(artifact.transitTrips.length, EXPECTED_TRANSIT_TRIP_COUNT, "transitTrips.length");
  requireEqual(artifact.transitStopTimes.length, EXPECTED_TRANSIT_STOP_TIME_COUNT, "transitStopTimes.length");
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    throw new Error(`KRIC pilot artifact ${field} mismatch: ${actual} !== ${expected}`);
  }
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function requireArg(args, name) {
  const value = args.get(name);
  if (!value) {
    throw new Error(`missing required argument: --${name}`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
