import { createHash } from "node:crypto";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import {
  materializeGwangjuTimetable,
  projectRetainedGwangjuTimetable,
} from "./materialize-gwangju-timetable.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";
const ROUTE_NUMBER = "S2901";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function nativeCell(value) {
  return { value, cellType: "inlineStr", styleId: null };
}

export function createRetainedGwangjuTestInput({
  baseFixture,
  topologySnapshot,
  inventory,
  canonicalStationMappings,
}) {
  const [first, second] = canonicalStationMappings;
  if (!first || !second) throw new Error("retained Gwangju test fixture requires two canonical stations");
  const observedAt = topologySnapshot.capturedAt;
  const calendarYear = observedAt.slice(0, 4);
  const records = [first, second].map((mapping, index) => {
    const row = {
      trainNumber: "test-1", routeNumber: ROUTE_NUMBER, routeName: "광주 1호선",
      originStationName: first.stationName, destinationStationName: second.stationName,
      serviceType: "LOCAL", weekdayType: "평일", stationName: mapping.stationName,
      arrivalTime: nativeCell(`24:0${index}:00`), departureTime: nativeCell(`24:0${index}:30`),
      speed: nativeCell(""), operatorPhone: nativeCell(""),
      dataReferenceDate: nativeCell(observedAt.slice(0, 10)), sourceRowNumber: index + 1,
    };
    return { ...row, sourceRowSha256: sha256(JSON.stringify(row)) };
  });
  const observation = {
    schemaVersion: 1, artifactKind: "kric-nationwide-timetable-observation", sourceId: SOURCE_ID,
    observedAt, rawFile: "test.xlsx", rawByteLength: 12, rawSha256: "a".repeat(64),
    rowCount: records.length, groupCount: 1, records,
    recordsSha256: sha256(`${JSON.stringify(records)}\n`),
    gaps: { stopSequence: "ABSENT", timeGrammar: "UNADMITTED" },
  };
  const receipt = {
    schemaVersion: 1, artifactKind: "kric-nationwide-timetable-file-receipt", sourceId: SOURCE_ID,
    capturedAt: observedAt, rawFile: observation.rawFile, byteLength: observation.rawByteLength,
    sha256: observation.rawSha256, credentialRedacted: true,
  };
  const retainedTimetable = {
    observation, receipt, routeNumber: ROUTE_NUMBER,
    stationBindings: [first, second].map((mapping) => ({
      sourceLabel: mapping.stationName, stationId: mapping.stationId, stationCode: mapping.stationNumber,
    })),
    excludedEndpointLabels: [],
    routeBindings: [{
      originStationName: first.stationName, destinationStationName: second.stationName,
      routeId: "route-test", directionId: "forward", tripHeadsign: second.stationName,
      stationCodes: [first.stationNumber, second.stationNumber],
    }],
    serviceIds: { "평일": "weekday", "토요일": "saturday", "휴일": "holiday", "명절": "special" },
    servicePatterns: { LOCAL: "LOCAL" }, serviceDayStartSeconds: 0,
    calendar: {
      startDate: `${calendarYear}0101`, endDate: `${calendarYear}1231`,
      publicHolidayDates: [],
    },
  };
  const summary = projectRetainedGwangjuTimetable({
    observation, receipt, routeNumber: retainedTimetable.routeNumber,
    stationBindings: retainedTimetable.stationBindings,
    directedEdges: topologySnapshot.edges.map(({ fromStationCode, toStationCode }) => ({
      fromStationCode, toStationCode,
    })),
    excludedEndpointLabels: [],
  }).source;
  const contract = { ...retainedTimetable };
  delete contract.observation;
  delete contract.receipt;
  const topologySource = inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology");
  if (!topologySource?.topologyAdmissionEvidence?.snapshotId) {
    throw new Error("retained Gwangju test fixture requires topology inventory evidence");
  }
  // 실제 등록 여부와 무관하게 이 테스트의 원문·계약에 결속된 source로 교체한다.
  inventory.sources = inventory.sources.filter(({ id }) => id !== SOURCE_ID);
  inventory.sources.push({
    id: SOURCE_ID, owner: "KRIC", datasetUrl: "https://test.invalid/kric",
    license: { name: "test-file", redistributionAllowed: true }, productionUseAllowed: true,
    capabilities: { schedule: { status: "SUPPORTED", productionUseAllowed: true } },
    updateFrequency: "static", fieldsProvided: ["service_calendar", "trip", "stop_time"],
    coverageScope: {
      regionIds: ["gwangju"], operatorIds: ["gwangju-metropolitan-rapid-transit"],
      lineIds: ["line-e57a361e8892"], sourceDomains: ["schedule_timetable"],
    },
    retainedScheduleAdmissionEvidence: {
      snapshotId: "test-only-retained", rawSha256: summary.rawSha256,
      recordsSha256: summary.recordsSha256, observationIdentitySha256: summary.observationIdentitySha256,
      receiptSha256: summary.receiptSha256, observedAt: summary.observedAt,
      retainedContractSha256: sha256(canonicalJson(contract)),
      topologySourceId: "gwangju-transportation-route-topology",
      topologySnapshotId: topologySource.topologyAdmissionEvidence.snapshotId,
      topologyContentSha256: topologySnapshot.contentSha256,
    },
  });
  return {
    baseFixture, retainedTimetable, topologySnapshot, inventory,
    mappings: canonicalStationMappings,
  };
}

/** Test-only bridge for cumulative regional materializer callers. */
export function materializeRetainedGwangjuTestFixture({
  baseFixture,
  topologySnapshot,
  inventory,
  canonicalStationMappings,
  now,
}) {
  const input = createRetainedGwangjuTestInput({
    baseFixture, topologySnapshot, inventory, canonicalStationMappings,
  });
  return materializeGwangjuTimetable({ ...input, canonicalStationMappings, now });
}
