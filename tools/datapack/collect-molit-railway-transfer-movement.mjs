#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

export const MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID = "molit-railway-transfer-movement";
export const MOLIT_RAILWAY_TRANSFER_MOVEMENT_SNAPSHOT_ID = "molit-railway-transfer-movement-20250811";
export const MOLIT_RAILWAY_TRANSFER_MOVEMENT_DETAIL_URL = "https://www.data.go.kr/data/15130556/fileData.do";

const PROVIDER_COLUMNS = Object.freeze([
  "철도운영기관코드", "선명", "역명", "환승이동순서", "이동내용상세", "환승이동내용",
]);
const COLUMNS = Object.freeze([
  "RAIL_OPR_ISTT_CD", "LN_NM", "STIN_NM", "CHTN_MV_TP_ORDR", "MV_CONT_DTL", "CHTN_MV_CONT",
]);
const LICENSE_TEXT = "이용허락범위 제한 없음";
const EXPECTED_ROW_COUNT = 8054;
export const MOLIT_RAILWAY_TRANSFER_MOVEMENT_RAW_SHA256 = "3a45dc1d82f81666c48eeef81fdc35b0e4a0c59312e4b26907f644c45b518ce3";

export function buildMolitRailwayTransferMovementSnapshot({
  bytes, capturedAt, expectedRowCount = EXPECTED_ROW_COUNT,
  expectedRawSha256 = MOLIT_RAILWAY_TRANSFER_MOVEMENT_RAW_SHA256,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("CSV input is required");
  const capturedMillis = requiredUtcInstant(capturedAt, "capturedAt");
  const observedAt = "2025-08-11T00:00:00.000Z";
  if (capturedMillis < Date.parse(observedAt) || capturedMillis > Date.now()) {
    throw new Error("capturedAt must be between observedAt and now");
  }
  if (!Number.isSafeInteger(expectedRowCount) || expectedRowCount < 1) throw new Error("expected row count is invalid");
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const text = utf8.startsWith(PROVIDER_COLUMNS[0]) ? utf8 : new TextDecoder("euc-kr").decode(bytes);
  const parsed = parseCsv(text);
  const header = parsed.shift();
  if (JSON.stringify(header) !== JSON.stringify(PROVIDER_COLUMNS)) {
    throw new Error(`header mismatch: ${header?.join(",") ?? "<missing>"}`);
  }
  if (parsed.length !== expectedRowCount) {
    throw new Error(`row count mismatch: ${parsed.length}/${expectedRowCount}`);
  }
  if (sha256(bytes) !== expectedRawSha256) throw new Error("raw hash mismatch");
  const rows = parsed.map((values, index) => {
    if (values.length !== COLUMNS.length) throw new Error(`column count mismatch at row ${index + 2}`);
    const row = Object.fromEntries(COLUMNS.map((column, columnIndex) => [column, values[columnIndex]]));
    for (const column of COLUMNS.slice(0, 4)) {
      if (row[column].trim() === "") throw new Error(`identity blank at row ${index + 2}: ${column}`);
    }
    if (!/^\d+$/.test(row.CHTN_MV_TP_ORDR) || Number(row.CHTN_MV_TP_ORDR) < 1) {
      throw new Error(`invalid step at row ${index + 2}`);
    }
    return row;
  });
  const gzipBytes = gzipSync(bytes, { mtime: 0 });
  const freshUntil = "2026-08-11T00:00:00.000Z";
  return {
    schemaVersion: 1,
    artifactKind: "molit-railway-transfer-movement-snapshot-metadata",
    sourceId: MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
    snapshotId: MOLIT_RAILWAY_TRANSFER_MOVEMENT_SNAPSHOT_ID,
    officialUrl: MOLIT_RAILWAY_TRANSFER_MOVEMENT_DETAIL_URL,
    detailUrl: MOLIT_RAILWAY_TRANSFER_MOVEMENT_DETAIL_URL,
    capturedAt,
    observedAt,
    freshUntil,
    licenseText: LICENSE_TEXT,
    licenseSha256: sha256(LICENSE_TEXT),
    rawSha256: sha256(bytes),
    gzipSha256: sha256(gzipBytes),
    schemaFingerprint: sha256(JSON.stringify(COLUMNS)),
    sortedContentSha256: sha256(JSON.stringify([...rows].sort((left, right) => {
      const leftText = JSON.stringify(left);
      const rightText = JSON.stringify(right);
      return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
    }))),
    rowCount: rows.length,
    credentialRedacted: true,
    observedRailOperatorCodes: [...new Set(rows.map((row) => row.RAIL_OPR_ISTT_CD))].sort((left, right) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
    columns: COLUMNS,
    rows,
    gzipBytes,
  };
}

export async function runMolitRailwayTransferMovementCollector(argv, fixture = {}) {
  const args = parseArgs(argv);
  const input = path.resolve(required(args.input, "--input"));
  const output = path.resolve(required(args.output, "--output"));
  if (!path.isAbsolute(args.output)) throw new Error("--output must be absolute");
  if (!output.endsWith(".csv.gz")) throw new Error("--output must end with .csv.gz");
  if (path.basename(output) !== `${MOLIT_RAILWAY_TRANSFER_MOVEMENT_SNAPSHOT_ID}.csv.gz`) {
    throw new Error("--output must use the canonical snapshot filename");
  }
  if (args["verify-existing"] !== undefined && args["verify-existing"] !== "true") throw new Error("--verify-existing must be true");
  const metadataPath = `${output}.json`;
  if (args["verify-existing"] === "true") {
    const [metadataBytes, gzipBytes] = await Promise.all([readFile(metadataPath), readFile(output)]);
    const metadata = JSON.parse(metadataBytes);
    if (sha256(gzipBytes) !== metadata.gzipSha256) throw new Error("gzip hash mismatch");
    const rebuilt = buildMolitRailwayTransferMovementSnapshot({
      bytes: gunzipSync(gzipBytes), capturedAt: required(args["captured-at"], "--captured-at"),
      expectedRowCount: fixture.expectedRowCount, expectedRawSha256: fixture.expectedRawSha256,
    });
    const { gzipBytes: ignored, gzipSha256: ignoredRebuiltGzipSha256, rows, ...rebuiltMetadata } = rebuilt;
    const { gzipSha256: ignoredMetadataGzipSha256, ...logicalMetadata } = metadata;
    if (JSON.stringify({ ...rebuiltMetadata, gzipPath: path.basename(output) }) !== JSON.stringify(logicalMetadata)) {
      throw new Error("metadata mismatch");
    }
    return metadata;
  }
  const snapshot = buildMolitRailwayTransferMovementSnapshot({
    bytes: await readFile(input),
    capturedAt: required(args["captured-at"], "--captured-at"),
    expectedRowCount: fixture.expectedRowCount,
    expectedRawSha256: fixture.expectedRawSha256,
  });
  const { gzipBytes, rows, ...metadata } = snapshot;
  await writeFile(output, gzipBytes);
  await writeFile(metadataPath, `${JSON.stringify({ ...metadata, gzipPath: path.basename(output) }, null, 2)}\n`);
  return { ...metadata, gzipPath: path.basename(output) };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += char;
  }
  if (quoted) throw new Error("unterminated CSV quote");
  if (value !== "" || row.length > 0) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function parseArgs(argv) {
  const allowed = new Set(["input", "output", "captured-at", "verify-existing"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || value == null || !allowed.has(option.slice(2)) || Object.hasOwn(args, option.slice(2))) {
      throw new Error(`unknown or duplicate argument: ${option ?? ""}`);
    }
    args[option.slice(2)] = value;
  }
  return args;
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMolitRailwayTransferMovementCollector(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
