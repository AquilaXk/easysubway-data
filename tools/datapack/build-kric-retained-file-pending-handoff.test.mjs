import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildKricRetainedFilePendingHandoff, selectRetainedKricStationLine } from "./build-kric-retained-file-pending-handoff.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const recordHash = (record) => hash(JSON.stringify(record));

function fixture() {
  const timetableRecord = {
    trainNumber: "1001", routeNumber: "1", routeName: "Line 1", originStationName: "A", destinationStationName: "B",
    serviceType: "LOCAL", weekdayType: "WEEKDAY", stationName: "A", arrivalTime: cell("080000"), departureTime: cell("080100"),
    speed: cell(""), operatorPhone: cell(""), dataReferenceDate: cell("2026-08-27"), sourceRowNumber: 2,
  };
  timetableRecord.sourceRowSha256 = recordHash(timetableRecord);
  const stationLineRecord = { operatorName: "KRIC", lineName: "Line 1", stationNumber: "001", stationName: "A" };
  stationLineRecord.sourceRowSha256 = recordHash(stationLineRecord);
  const timetableObservation = observation({
    artifactKind: "kric-nationwide-timetable-observation", sourceId: "kric-nationwide-timetable-file", rawFile: "kric-nationwide-timetable-file-test.xlsx",
    records: [timetableRecord], groupCount: 1, gaps: { stopSequence: "ABSENT", timeGrammar: "UNADMITTED" },
  });
  const stationLineObservation = observation({
    artifactKind: "kric-current-station-line-observation", sourceId: "kric-current-station-line-file", rawFile: "kric-current-station-line-file-test.xlsx",
    records: [stationLineRecord],
  });
  return {
    timetableObservation, stationLineObservation,
    timetableReceipt: receipt(timetableObservation, "kric-nationwide-timetable-file-receipt"),
    stationLineReceipt: receipt(stationLineObservation, "kric-current-station-line-file-receipt"),
  };
}

function observation({ artifactKind, sourceId, rawFile, records, ...extra }) {
  return {
    schemaVersion: 1, artifactKind, sourceId, observedAt: "2026-08-27T00:00:00.000Z", rawFile, rawByteLength: 10,
    rawSha256: "a".repeat(64), rowCount: records.length, records, recordsSha256: hash(Buffer.from(`${JSON.stringify(records)}\n`)), ...extra,
  };
}
function receipt(observationValue, artifactKind) {
  return {
    schemaVersion: 1, artifactKind, sourceId: observationValue.sourceId, capturedAt: observationValue.observedAt,
    rawFile: observationValue.rawFile, byteLength: observationValue.rawByteLength, sha256: observationValue.rawSha256,
    credentialRedacted: true,
  };
}
function cell(value) { return { value, cellType: "inlineStr", styleId: null }; }

test("selects exact retained membership without requiring an unrelated timetable", () => {
  const { stationLineObservation, stationLineReceipt } = fixture();
  const select = (observation = stationLineObservation, receipt = stationLineReceipt,
    operatorName = "KRIC", lineName = "Line 1") => selectRetainedKricStationLine({
    observation, receipt, operatorName, lineName,
  });
  const result = select();
  assert.deepEqual(result.records, stationLineObservation.records);
  assert.equal(result.summary.rawSha256, stationLineObservation.rawSha256);
  assert.throws(() => select(undefined, undefined, "Other operator"), /STATION_LINE_SELECTION/);
  assert.throws(() => select(undefined, undefined, "KRIC", "Line"), /STATION_LINE_SELECTION/);
  assert.throws(() => select(undefined, { ...stationLineReceipt, sha256: "b".repeat(64) }), /STATION_LINE_RECEIPT/);
  const changed = structuredClone(stationLineObservation);
  changed.records[0].stationName = "Changed";
  changed.recordsSha256 = hash(`${JSON.stringify(changed.records)}\n`);
  assert.throws(() => select(changed), /STATION_LINE_RECORD/);
});

test("builds a deterministic compact pending handoff from both retained observations", () => {
  const input = fixture();
  const first = buildKricRetainedFilePendingHandoff(input);
  const second = buildKricRetainedFilePendingHandoff(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.status, "PENDING");
  assert.equal(first.decision, "CONTRACT_GAP");
  assert.deepEqual(first.sources.map(({ sourceId }) => sourceId), ["kric-current-station-line-file", "kric-nationwide-timetable-file"]);
  assert.deepEqual(first.gaps.map(({ code }) => code), [
    "ROUTE_TOPOLOGY_NOT_ADMITTED", "STATION_LINE_MEMBERSHIP_CROSSWALK_NOT_ADMITTED",
    "TIMETABLE_STOP_SEQUENCE_NOT_ADMITTED", "TIMETABLE_TIME_GRAMMAR_NOT_ADMITTED",
  ]);
  assert.equal(first.handoffSha256, hash(Buffer.from(`${JSON.stringify(withoutHash(first))}\n`)));
  assert.ok(!JSON.stringify(first).includes("trainNumber"));
});

test("rejects incomplete, unbound, and tampered retained evidence", () => {
  const cases = [
    ["one sided", (value) => { delete value.stationLineReceipt; }],
    ["receipt mismatch", (value) => { value.timetableReceipt.sha256 = "b".repeat(64); }],
    ["records digest", (value) => { value.stationLineObservation.recordsSha256 = "b".repeat(64); }],
    ["group count", (value) => { value.timetableObservation.groupCount = 2; }],
  ];
  for (const [name, mutate] of cases) {
    const value = fixture(); mutate(value);
    assert.throws(() => buildKricRetainedFilePendingHandoff(value), /KRIC_RETAINED_FILE_PENDING_HANDOFF_/, name);
  }
});

test("rejects inferred admission, product, and topology fields", () => {
  for (const [name, mutate] of [
    ["admission", (value) => { value.timetableObservation.admissionDecision = "ADMITTED"; }],
    ["product", (value) => { value.stationLineObservation.records[0].productId = "line-1"; }],
    ["topology", (value) => { value.stationLineObservation.topology = { edges: [] }; }],
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => buildKricRetainedFilePendingHandoff(value), /KRIC_RETAINED_FILE_PENDING_HANDOFF_/, name);
  }
});

function withoutHash(value) { const { handoffSha256, ...payload } = value; return payload; }
