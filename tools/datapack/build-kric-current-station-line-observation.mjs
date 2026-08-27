import { createHash } from "node:crypto";
import path from "node:path";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { parseKricCurrentStationLineWorkbook } from "./collect-kric-nationwide-timetable-file.mjs";

const SOURCE_ID = "kric-current-station-line-file";
const RECEIPT_KIND = "kric-current-station-line-file-receipt";
const OBSERVATION_KIND = "kric-current-station-line-observation";
const OUTPUT_PREFIX = "kric-current-station-line-file-";
const SHA256 = /^[a-f0-9]{64}$/u;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(`KRIC_CURRENT_STATION_LINE_OBSERVATION_${code}`); };

// This producer is intentionally evidence-only. It does not project KRIC
// records onto product identifiers or make any admission decision.
export function buildKricCurrentStationLineObservation({ workbookBytes, receipt } = {}) {
  const bytes = requireWorkbookBytes(workbookBytes);
  const verifiedReceipt = validateReceipt(receipt, bytes);
  let sourceRows;
  try {
    sourceRows = parseKricCurrentStationLineWorkbook(bytes);
  } catch {
    fail("WORKBOOK");
  }
  if (!Array.isArray(sourceRows) || sourceRows.length === 0) fail("WORKBOOK");

  const records = sourceRows.map((row) => {
    const operatorName = normalized(row?.operator);
    const lineName = normalized(row?.line);
    const stationNumber = normalized(row?.stationCode);
    const stationName = normalized(row?.stationName);
    return {
      operatorName,
      lineName,
      stationNumber,
      stationName,
      sourceRowSha256: sha256(JSON.stringify({ operatorName, lineName, stationNumber, stationName })),
    };
  }).sort(compareRecords);

  return Object.freeze({
    schemaVersion: 1,
    artifactKind: OBSERVATION_KIND,
    sourceId: SOURCE_ID,
    observedAt: verifiedReceipt.capturedAt,
    rawFile: verifiedReceipt.rawFile,
    rawByteLength: bytes.length,
    rawSha256: sha256(bytes),
    rowCount: records.length,
    records,
    recordsSha256: sha256(Buffer.from(`${JSON.stringify(records)}\n`)),
  });
}

function requireWorkbookBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) fail("WORKBOOK");
  return Buffer.from(value);
}

function validateReceipt(receipt, bytes) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.artifactKind !== RECEIPT_KIND
    || receipt.sourceId !== SOURCE_ID || !canonicalInstant(receipt.capturedAt)
    || typeof receipt.rawFile !== "string" || path.basename(receipt.rawFile) !== receipt.rawFile
    || !new RegExp(`^${OUTPUT_PREFIX}[^/]+\\.xlsx$`, "u").test(receipt.rawFile)
    || receipt.credentialRedacted !== true || !Number.isSafeInteger(receipt.byteLength)
    || receipt.byteLength <= 0 || typeof receipt.sha256 !== "string" || !SHA256.test(receipt.sha256)) {
    fail("RECEIPT");
  }
  const actualSha256 = sha256(bytes);
  if (receipt.byteLength !== bytes.length || receipt.sha256 !== actualSha256) fail("CONTENT_DRIFT");
  return Object.freeze({ capturedAt: receipt.capturedAt, rawFile: receipt.rawFile });
}

function canonicalInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function normalized(value) {
  if (typeof value !== "string") fail("WORKBOOK");
  const result = value.normalize("NFC").trim();
  if (result === "") fail("WORKBOOK");
  return result;
}

function compareRecords(left, right) {
  for (const key of ["operatorName", "lineName", "stationNumber", "stationName"]) {
    const comparison = codepointCompare(left[key], right[key]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}
