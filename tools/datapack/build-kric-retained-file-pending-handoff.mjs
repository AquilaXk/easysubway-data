import { createHash } from "node:crypto";

import { codepointCompare } from "../lib/codepoint-compare.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const TIMETABLE_SOURCE_ID = "kric-nationwide-timetable-file";
const STATION_LINE_SOURCE_ID = "kric-current-station-line-file";
const TIMETABLE_OBSERVATION_KIND = "kric-nationwide-timetable-observation";
const STATION_LINE_OBSERVATION_KIND = "kric-current-station-line-observation";
const TIMETABLE_RECEIPT_KIND = "kric-nationwide-timetable-file-receipt";
const STATION_LINE_RECEIPT_KIND = "kric-current-station-line-file-receipt";
const GAP_CODES = Object.freeze([
  "ROUTE_TOPOLOGY_NOT_ADMITTED",
  "STATION_LINE_MEMBERSHIP_CROSSWALK_NOT_ADMITTED",
  "TIMETABLE_STOP_SEQUENCE_NOT_ADMITTED",
  "TIMETABLE_TIME_GRAMMAR_NOT_ADMITTED",
].sort(codepointCompare));
const TIMETABLE_RECORD_KEYS = Object.freeze([
  "trainNumber", "routeNumber", "routeName", "originStationName", "destinationStationName",
  "serviceType", "weekdayType", "stationName", "arrivalTime", "departureTime", "speed",
  "operatorPhone", "dataReferenceDate", "sourceRowNumber", "sourceRowSha256",
]);
const STATION_LINE_RECORD_KEYS = Object.freeze([
  "operatorName", "lineName", "stationNumber", "stationName", "sourceRowSha256",
]);
const TIMETABLE_GROUP_KEYS = TIMETABLE_RECORD_KEYS.slice(0, 7);
const TIMETABLE_IDENTITY_KEYS = TIMETABLE_RECORD_KEYS.slice(0, 8);
const TIMETABLE_CELL_KEYS = TIMETABLE_RECORD_KEYS.slice(8, 13);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(`KRIC_RETAINED_FILE_PENDING_HANDOFF_${code}`); };

export function buildKricRetainedFilePendingHandoff(input = {}) {
  assertExactKeys(input, ["stationLineObservation", "stationLineReceipt", "timetableObservation", "timetableReceipt"], "INPUT");
  const timetable = validateTimetable(input.timetableObservation, input.timetableReceipt);
  const stationLine = validateStationLine(input.stationLineObservation, input.stationLineReceipt);
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "kric-retained-file-pending-handoff",
    status: "PENDING",
    decision: "CONTRACT_GAP",
    sources: [timetable.summary, stationLine.summary].sort((left, right) => codepointCompare(left.sourceId, right.sourceId)),
    gaps: GAP_CODES.map((code) => ({ code, status: "PENDING", decision: "CONTRACT_GAP" })),
  });
  return Object.freeze({ ...payload, handoffSha256: sha256(Buffer.from(`${JSON.stringify(payload)}\n`)) });
}

function validateTimetable(observation, receipt) {
  assertExactKeys(observation, ["artifactKind", "gaps", "groupCount", "observedAt", "rawByteLength", "rawFile", "rawSha256", "records", "recordsSha256", "rowCount", "schemaVersion", "sourceId"], "TIMETABLE_OBSERVATION");
  validateObservationIdentity(observation, TIMETABLE_SOURCE_ID, TIMETABLE_OBSERVATION_KIND, "TIMETABLE");
  validateReceipt(receipt, TIMETABLE_SOURCE_ID, TIMETABLE_RECEIPT_KIND, observation, "TIMETABLE");
  if (!observation.gaps || typeof observation.gaps !== "object" || Array.isArray(observation.gaps)
    || JSON.stringify(canonicalObject(observation.gaps)) !== JSON.stringify({ stopSequence: "ABSENT", timeGrammar: "UNADMITTED" })) fail("TIMETABLE_GAPS");
  const groups = new Set();
  validateRecords(observation.records, TIMETABLE_RECORD_KEYS, "TIMETABLE", (record) => {
    for (const key of TIMETABLE_IDENTITY_KEYS) if (!normalizedText(record[key])) fail("TIMETABLE_RECORD");
    for (const key of TIMETABLE_CELL_KEYS) validateCell(record[key]);
    if (!Number.isSafeInteger(record.sourceRowNumber) || record.sourceRowNumber <= 0) fail("TIMETABLE_RECORD");
    const expected = sha256(JSON.stringify(Object.fromEntries(TIMETABLE_RECORD_KEYS.slice(0, -1).map((key) => [key, record[key]]))));
    if (record.sourceRowSha256 !== expected) fail("TIMETABLE_RECORD");
    groups.add(JSON.stringify(TIMETABLE_GROUP_KEYS.map((key) => record[key])));
  });
  if (observation.groupCount !== groups.size) fail("TIMETABLE_GROUP_COUNT");
  return { summary: sourceSummary(observation, receipt, { groupCount: observation.groupCount }) };
}

function validateStationLine(observation, receipt) {
  assertExactKeys(observation, ["artifactKind", "observedAt", "rawByteLength", "rawFile", "rawSha256", "records", "recordsSha256", "rowCount", "schemaVersion", "sourceId"], "STATION_LINE_OBSERVATION");
  validateObservationIdentity(observation, STATION_LINE_SOURCE_ID, STATION_LINE_OBSERVATION_KIND, "STATION_LINE");
  validateReceipt(receipt, STATION_LINE_SOURCE_ID, STATION_LINE_RECEIPT_KIND, observation, "STATION_LINE");
  validateRecords(observation.records, STATION_LINE_RECORD_KEYS, "STATION_LINE", (record) => {
    for (const key of STATION_LINE_RECORD_KEYS.slice(0, -1)) if (!normalizedText(record[key])) fail("STATION_LINE_RECORD");
    const expected = sha256(JSON.stringify(Object.fromEntries(STATION_LINE_RECORD_KEYS.slice(0, -1).map((key) => [key, record[key]]))));
    if (record.sourceRowSha256 !== expected) fail("STATION_LINE_RECORD");
  });
  return { summary: sourceSummary(observation, receipt) };
}

function validateObservationIdentity(observation, sourceId, artifactKind, label) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)
    || observation.schemaVersion !== 1 || observation.artifactKind !== artifactKind || observation.sourceId !== sourceId
    || !canonicalInstant(observation.observedAt) || !safeBasename(observation.rawFile)
    || !Number.isSafeInteger(observation.rawByteLength) || observation.rawByteLength <= 0
    || !SHA256.test(observation.rawSha256 ?? "") || !Number.isSafeInteger(observation.rowCount)
    || observation.rowCount <= 0 || !SHA256.test(observation.recordsSha256 ?? "")) fail(`${label}_OBSERVATION`);
}

function validateReceipt(receipt, sourceId, artifactKind, observation, label) {
  assertExactKeys(receipt, ["artifactKind", "byteLength", "capturedAt", "credentialRedacted", "rawFile", "schemaVersion", "sha256", "sourceId"], `${label}_RECEIPT`);
  if (receipt.schemaVersion !== 1 || receipt.artifactKind !== artifactKind || receipt.sourceId !== sourceId
    || receipt.credentialRedacted !== true || !canonicalInstant(receipt.capturedAt) || !safeBasename(receipt.rawFile)
    || !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength <= 0 || !SHA256.test(receipt.sha256 ?? "")
    || receipt.capturedAt !== observation.observedAt || receipt.rawFile !== observation.rawFile
    || receipt.byteLength !== observation.rawByteLength || receipt.sha256 !== observation.rawSha256) fail(`${label}_RECEIPT`);
}

function validateRecords(records, keys, label, validateRecord) {
  if (!Array.isArray(records) || records.length === 0) fail(`${label}_RECORDS`);
  for (const record of records) {
    assertExactKeys(record, keys, `${label}_RECORD`);
    validateRecord(record);
  }
}

function sourceSummary(observation, receipt, extra = {}) {
  if (observation.rowCount !== observation.records.length
    || observation.recordsSha256 !== sha256(Buffer.from(`${JSON.stringify(observation.records)}\n`))) fail("RECORDS_BINDING");
  const identity = canonicalObject({
    sourceId: observation.sourceId,
    artifactKind: observation.artifactKind,
    observedAt: observation.observedAt,
    rawFile: observation.rawFile,
    rawByteLength: observation.rawByteLength,
    rawSha256: observation.rawSha256,
    rowCount: observation.rowCount,
    recordsSha256: observation.recordsSha256,
    ...extra,
  });
  return canonicalObject({
    ...identity,
    observationIdentitySha256: sha256(Buffer.from(`${JSON.stringify(identity)}\n`)),
    receiptSha256: sha256(Buffer.from(`${JSON.stringify(canonicalObject(receipt))}\n`)),
  });
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort(codepointCompare)) !== JSON.stringify([...keys].sort(codepointCompare))) fail(label);
}

function safeBasename(value) { return typeof value === "string" && value.length > 0 && !value.includes("/") && !value.includes("\\"); }
function normalizedText(value) { return typeof value === "string" && value !== "" && value === value.normalize("NFC").trim(); }
function validateCell(cell) {
  assertExactKeys(cell, ["cellType", "styleId", "value"], "TIMETABLE_CELL");
  if (typeof cell.value !== "string" || !["inlineStr", "s", "n", "str", "b", "e", "d"].includes(cell.cellType)
    || (cell.styleId !== null && (!Number.isSafeInteger(cell.styleId) || cell.styleId < 0))) fail("TIMETABLE_CELL");
}
function canonicalInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(codepointCompare).map((key) => [key, canonicalObject(value[key])]));
}
