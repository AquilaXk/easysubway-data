import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import test from "node:test";
import { readIndexedKricStopFields } from "./read-kric-retained-file-observations.mjs";

test("indexed stop fields join explicit keys without interpreting time or sequence", () => {
  const record = indexedRecord();
  const result = readIndexedKricStopFields(record);
  assert.equal(result.sourceRowSha256, record.sourceRowSha256);
  assert.deepEqual(result.stops, [
    { sourceStopKey: "007", stationName: "출발역", arrivalLiteral: "00:00", departureLiteral: "5:30" },
    { sourceStopKey: "012", stationName: "도착역", arrivalLiteral: "5:40", departureLiteral: ":" },
  ]);
  assert.equal(Object.hasOwn(result.stops[0], "stopSequence"), false);
  assert.equal(Object.hasOwn(result, "releaseEligible"), false);
});

test("indexed stop fields preserve absent endpoint cells without filling time", () => {
  const record = indexedRecord();
  record.arrivalTime.value = "012-5:40";
  record.departureTime.value = "007-5:30";
  const { stops } = readIndexedKricStopFields(record);
  assert.equal(stops[0].arrivalLiteral, null);
  assert.equal(stops[1].departureLiteral, null);
});

test("indexed stop fields reject duplicate unknown and unsupported inputs", () => {
  for (const edit of [
    (r) => { r.stationName = "007-출발역+007-다른역"; },
    (r) => { r.arrivalTime.value = "099-5:40"; },
    (r) => { r.arrivalTime.value = "007-5:30+007-5:31"; },
    (r) => { r.stationName = "출발역"; },
    (r) => { r.departureTime = { value: "0.25", cellType: "n", styleId: 59 }; },
    (r) => { r.arrivalTime.value = "007-"; },
  ]) {
    const record = indexedRecord();
    edit(record);
    assert.throws(() => readIndexedKricStopFields(record), /KRIC_RETAINED_FILE_OBSERVATION_READER_INDEXED_/u);
  }
});

function indexedRecord() {
  return {
    sourceRowSha256: "a".repeat(64), stationName: "007-출발역+012-도착역",
    arrivalTime: { value: "012-5:40+007-00:00", cellType: "s", styleId: 1 },
    departureTime: { value: "007-5:30+012-:", cellType: "s", styleId: 2 },
  };
}

import { buildKricRetainedFilePendingHandoff } from "./build-kric-retained-file-pending-handoff.mjs";
import { readKricRetainedFileObservations } from "./read-kric-retained-file-observations.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : !value || typeof value !== "object" ? value : Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => [key, canonical(value[key])]));
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value))}\n`);

test("reads the exact pending bundle and its two source-native observations", async () => {
  const fixture = validFixture();
  const calls = [];
  const reader = memoryReader(fixture.objects, calls);
  const result = await readKricRetainedFileObservations({
    bundleSha256: fixture.bundleSha256, handoffSha256: fixture.handoff.handoffSha256, reader,
  });

  assert.deepEqual(calls, [fixture.bundleKey, fixture.timetableKey, fixture.stationLineKey]);
  assert.equal(result.bundleBytes.equals(fixture.bundleBytes), true);
  assert.equal(result.timetable.bytes.equals(fixture.timetableBytes), true);
  assert.equal(result.stationLine.bytes.equals(fixture.stationLineBytes), true);
  assert.equal(result.handoff.status, "PENDING");
  assert.equal(result.handoff.decision, "CONTRACT_GAP");
  assert.equal(result.handoff.releaseEligible, undefined);
  assert.equal(result.bundle.releaseEligible, false);
});

test("fails before output for missing, corrupt, and identity-mismatched objects", async () => {
  for (const [name, mutate] of [
    ["missing bundle", (fixture) => fixture.objects.delete(fixture.bundleKey)],
    ["corrupt observation", (fixture) => fixture.objects.set(fixture.timetableKey, Buffer.from("{}\n"))],
    ["wrong observation identity", (fixture) => { fixture.bundle.provenance.sources[0].observation.sha256 = "b".repeat(64); fixture.bundleBytes = jsonBytes(fixture.bundle); fixture.bundleSha256 = sha256(fixture.bundleBytes); fixture.bundleKey = `kric-retained-file-operations/${fixture.bundleSha256}.json`; fixture.objects.set(fixture.bundleKey, fixture.bundleBytes); }],
  ]) {
    const fixture = validFixture();
    mutate(fixture);
    const outputDir = `/private/tmp/kric-retained-reader-${process.pid}-${name.replaceAll(" ", "-")}`;
    try {
      await assert.rejects(readKricRetainedFileObservations({
        bundleSha256: fixture.bundleSha256, handoffSha256: fixture.handoff.handoffSha256,
        reader: memoryReader(fixture.objects, []), outputDir,
      }), /KRIC_RETAINED_FILE_OBSERVATION_READER_/u, name);
      await assert.rejects(lstat(outputDir), { code: "ENOENT" });
    } finally {
      // The reader must leave this absent; keep cleanup unnecessary and bounded.
    }
  }
});

function validFixture() {
  const timetable = observation({
    artifactKind: "kric-nationwide-timetable-observation", sourceId: "kric-nationwide-timetable-file",
    rawFile: "timetable.xlsx", records: [timetableRecord()], groupCount: 1,
    gaps: { stopSequence: "ABSENT", timeGrammar: "UNADMITTED" },
  });
  const stationLine = observation({
    artifactKind: "kric-current-station-line-observation", sourceId: "kric-current-station-line-file",
    rawFile: "station-line.xlsx", records: [stationLineRecord()],
  });
  const timetableReceipt = receipt(timetable, "kric-nationwide-timetable-file-receipt");
  const stationLineReceipt = receipt(stationLine, "kric-current-station-line-file-receipt");
  const handoff = buildKricRetainedFilePendingHandoff({ timetableObservation: timetable, timetableReceipt, stationLineObservation: stationLine, stationLineReceipt });
  const timetableBytes = Buffer.from(`${JSON.stringify(timetable)}\n`);
  const stationLineBytes = Buffer.from(`${JSON.stringify(stationLine)}\n`);
  const source = (observationValue, bytes) => {
    const date = observationValue.observedAt.slice(0, 10).replaceAll("-", "");
    return {
      sourceId: observationValue.sourceId,
      raw: { objectKey: `source-raw/${observationValue.sourceId}/${date}/${observationValue.rawSha256}.xlsx`, sizeBytes: observationValue.rawByteLength, sha256: observationValue.rawSha256 },
      observation: { objectKey: `source-observation/${observationValue.sourceId}/${date}/${observationValue.recordsSha256}.json`, sizeBytes: bytes.length, sha256: sha256(bytes) },
    };
  };
  const provenance = canonical({ repository: "AquilaXk/easysubway-data", mainSha: "a".repeat(40), operationId: "retained-reader-test", sources: [source(timetable, timetableBytes), source(stationLine, stationLineBytes)] });
  const releaseTuple = canonical({ artifactKind: "kric-retained-file-pending-release-tuple", status: "PENDING", decision: "CONTRACT_GAP", releaseEligible: false, provenanceSha256: sha256(jsonBytes(provenance)), handoffSha256: handoff.handoffSha256 });
  const bundle = canonical({ schemaVersion: 1, artifactKind: "kric-retained-file-operation-bundle", status: "PENDING", decision: "CONTRACT_GAP", releaseEligible: false, receipts: { timetable: canonical(timetableReceipt), stationLine: canonical(stationLineReceipt) }, handoff, provenance, releaseTuple });
  const bundleBytes = jsonBytes(bundle); const bundleSha256 = sha256(bundleBytes);
  const bundleKey = `kric-retained-file-operations/${bundleSha256}.json`;
  return { bundle, bundleBytes, bundleSha256, bundleKey, handoff, timetableBytes, stationLineBytes, timetableKey: provenance.sources[0].observation.objectKey, stationLineKey: provenance.sources[1].observation.objectKey, objects: new Map([[bundleKey, bundleBytes], [provenance.sources[0].observation.objectKey, timetableBytes], [provenance.sources[1].observation.objectKey, stationLineBytes]]) };
}

function memoryReader(objects, calls) { return { async readObject(key, { maxResponseBytes }) { calls.push(key); const body = objects.get(key); return !body ? { exists: false } : body.length > maxResponseBytes ? { exists: true, body: Buffer.alloc(maxResponseBytes + 1) } : { exists: true, body: Buffer.from(body) }; } }; }
function observation({ artifactKind, sourceId, rawFile, records, ...extra }) { return { schemaVersion: 1, artifactKind, sourceId, observedAt: "2026-08-27T00:00:00.000Z", rawFile, rawByteLength: 10, rawSha256: "a".repeat(64), rowCount: records.length, records, recordsSha256: sha256(Buffer.from(`${JSON.stringify(records)}\n`)), ...extra }; }
function receipt(value, artifactKind) { return { schemaVersion: 1, artifactKind, sourceId: value.sourceId, capturedAt: value.observedAt, rawFile: value.rawFile, byteLength: value.rawByteLength, sha256: value.rawSha256, credentialRedacted: true }; }
function timetableRecord() { const value = { trainNumber: "1001", routeNumber: "1", routeName: "Line 1", originStationName: "A", destinationStationName: "B", serviceType: "LOCAL", weekdayType: "WEEKDAY", stationName: "A", arrivalTime: cell("080000"), departureTime: cell("080100"), speed: cell(""), operatorPhone: cell(""), dataReferenceDate: cell("2026-08-27"), sourceRowNumber: 2 }; value.sourceRowSha256 = sha256(JSON.stringify(value)); return value; }
function stationLineRecord() { const value = { operatorName: "KRIC", lineName: "Line 1", stationNumber: "001", stationName: "A" }; value.sourceRowSha256 = sha256(JSON.stringify(value)); return value; }
function cell(value) { return { value, cellType: "inlineStr", styleId: null }; }
