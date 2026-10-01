#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";

export const MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID = "molit-railway-transfer-movement";
// #862: 판(edition)은 상수가 아니라 공식 파일명(…_YYYYMMDD.csv)에서 유도한다.
export function molitRailwayTransferMovementSnapshotId(editionDate) {
  return `${MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID}-${requiredEditionDate(editionDate)}`;
}
export function molitRailwayTransferMovementEditionDate(officialFileName) {
  const match = /_(\d{8})\.csv$/u.exec(String(officialFileName ?? ""));
  return requiredEditionDate(match?.[1]);
}
export function molitRailwayTransferMovementEditionFromSnapshotId(snapshotId) {
  const prefix = `${MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID}-`;
  if (typeof snapshotId !== "string" || !snapshotId.startsWith(prefix)) throw new Error("official file edition date is invalid");
  return requiredEditionDate(snapshotId.slice(prefix.length));
}
function requiredEditionDate(value) {
  const text = String(value ?? "");
  const iso = /^\d{8}$/u.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00.000Z` : "";
  if (!iso || !Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw new Error("official file edition date is invalid");
  return text;
}
// 수집은 판 독립이지만, inventory에 결속할 수 있는 원본은 검토된 판별 provider 원본으로 고정한다.
// 새 판을 받으려면 이 목록에 판 snapshotId와 raw sha256을 추가하는 검토된 변경이 필요하다(#862).
export const MOLIT_RAILWAY_TRANSFER_MOVEMENT_ADMITTED_RAW_SHA256 = Object.freeze({
  "molit-railway-transfer-movement-20260811": "8f9a448e1601bc49dd370de5af0d7ab8884d930131e05f8fc9773445bded16f8",
});
export const MOLIT_RAILWAY_TRANSFER_MOVEMENT_DETAIL_URL = "https://www.data.go.kr/data/15130556/fileData.do";

const PROVIDER_COLUMNS = Object.freeze([
  "철도운영기관코드", "선명", "역명", "환승이동순서", "이동내용상세", "환승이동내용",
]);
const COLUMNS = Object.freeze([
  "RAIL_OPR_ISTT_CD", "LN_NM", "STIN_NM", "CHTN_MV_TP_ORDR", "MV_CONT_DTL", "CHTN_MV_CONT",
]);
const LICENSE_TEXT = "이용허락범위 제한 없음";

// 행 수·sha는 파일에서 계산한다. expected 값을 주면(기존 binding 재검증) 같아야 한다.
export function buildMolitRailwayTransferMovementSnapshot({
  bytes, capturedAt, editionDate, freshnessPolicy, expectedRowCount, expectedRawSha256,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("CSV input is required");
  const capturedMillis = requiredUtcInstant(capturedAt, "capturedAt");
  const edition = requiredEditionDate(editionDate);
  const observedAt = `${edition.slice(0, 4)}-${edition.slice(4, 6)}-${edition.slice(6, 8)}T00:00:00.000Z`;
  if (capturedMillis < Date.parse(observedAt) || capturedMillis > Date.now()) {
    throw new Error("capturedAt must be between observedAt and now");
  }
  if (expectedRowCount !== undefined && (!Number.isSafeInteger(expectedRowCount) || expectedRowCount < 1)) throw new Error("expected row count is invalid");
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const text = utf8.startsWith(PROVIDER_COLUMNS[0]) ? utf8 : new TextDecoder("euc-kr").decode(bytes);
  const parsed = parseCsv(text);
  const header = parsed.shift();
  if (JSON.stringify(header) !== JSON.stringify(PROVIDER_COLUMNS)) {
    throw new Error(`header mismatch: ${header?.join(",") ?? "<missing>"}`);
  }
  if (parsed.length === 0 || (expectedRowCount !== undefined && parsed.length !== expectedRowCount)) {
    throw new Error(`row count mismatch: ${parsed.length}/${expectedRowCount ?? "nonempty"}`);
  }
  if (expectedRawSha256 !== undefined && sha256(bytes) !== expectedRawSha256) throw new Error("raw hash mismatch");
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
  const sourceClass = (freshnessPolicy?.sourceClasses ?? []).filter(({ sourceIds }) => sourceIds?.includes(MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID));
  if (sourceClass.length !== 1 || sourceClass[0].basisField !== "observedAt") throw new Error("MOLIT transfer freshness policy is invalid");
  const freshUntil = deriveFreshnessExpiresAt({ policy: freshnessPolicy, sourceClassId: sourceClass[0].id, basisAt: observedAt, evaluationAt: capturedAt });
  return {
    schemaVersion: 1,
    artifactKind: "molit-railway-transfer-movement-snapshot-metadata",
    sourceId: MOLIT_RAILWAY_TRANSFER_MOVEMENT_SOURCE_ID,
    snapshotId: molitRailwayTransferMovementSnapshotId(edition),
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
  if (args["verify-existing"] !== undefined && args["verify-existing"] !== "true") throw new Error("--verify-existing must be true");
  const freshnessPolicy = fixture.freshnessPolicy
    ?? JSON.parse(await readFile(new URL("../../release/product-gates/datapack-freshness-sla.json", import.meta.url), "utf8"));
  const metadataPath = `${output}.json`;
  if (args["verify-existing"] === "true") {
    const [metadataBytes, gzipBytes] = await Promise.all([readFile(metadataPath), readFile(output)]);
    const metadata = JSON.parse(metadataBytes);
    if (path.basename(output) !== `${metadata.snapshotId}.csv.gz`) throw new Error("--output must use the canonical snapshot filename");
    if (sha256(gzipBytes) !== metadata.gzipSha256) throw new Error("gzip hash mismatch");
    const rebuilt = buildMolitRailwayTransferMovementSnapshot({
      bytes: gunzipSync(gzipBytes), capturedAt: required(args["captured-at"], "--captured-at"),
      editionDate: molitRailwayTransferMovementEditionFromSnapshotId(metadata.snapshotId), freshnessPolicy,
      expectedRowCount: fixture.expectedRowCount ?? metadata.rowCount, expectedRawSha256: fixture.expectedRawSha256 ?? metadata.rawSha256,
    });
    const { gzipBytes: ignored, gzipSha256: ignoredRebuiltGzipSha256, rows, ...rebuiltMetadata } = rebuilt;
    const { gzipSha256: ignoredMetadataGzipSha256, ...logicalMetadata } = metadata;
    if (JSON.stringify({ ...rebuiltMetadata, gzipPath: path.basename(output) }) !== JSON.stringify(logicalMetadata)) {
      throw new Error("metadata mismatch");
    }
    return metadata;
  }
  const editionDate = molitRailwayTransferMovementEditionDate(required(args["official-file-name"], "--official-file-name"));
  if (path.basename(output) !== `${molitRailwayTransferMovementSnapshotId(editionDate)}.csv.gz`) {
    throw new Error("--output must use the canonical snapshot filename");
  }
  const snapshot = buildMolitRailwayTransferMovementSnapshot({
    bytes: await readFile(input),
    capturedAt: required(args["captured-at"], "--captured-at"),
    editionDate,
    freshnessPolicy,
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
  const allowed = new Set(["input", "official-file-name", "output", "captured-at", "verify-existing"]);
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
