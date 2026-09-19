#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const HEADER = [
  "전철역코드", "전철역명", "전철명명(영문)", "호선", "외부코드", "전철명명(중문)", "전철명명(일문)",
];
const REQUIRED_COLUMNS = [0, 1, 3, 4];
const REQUIRED_KEYS = ["STATION_CD", "STATION_NM", "LINE_NUM", "FR_CODE"];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalUtc(value, label) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC instant`);
  }
  return value;
}

function tokenizeCsv(bytes) {
  const rows = [];
  let row = [];
  let field = [];
  let quoted = false;
  let afterQuote = false;
  let rowStarted = false;
  const pushField = () => {
    row.push(Buffer.from(field));
    field = [];
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    rowStarted = false;
    afterQuote = false;
  };
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (quoted) {
      if (byte === 0x22) {
        if (bytes[index + 1] === 0x22) {
          field.push(byte);
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field.push(byte);
      }
      rowStarted = true;
      continue;
    }
    if (afterQuote && byte !== 0x2c && byte !== 0x0a && byte !== 0x0d) {
      throw new Error("CSV trailing junk after closing quote");
    }
    if (byte === 0x2c) {
      pushField();
      rowStarted = true;
      afterQuote = false;
    } else if (byte === 0x0a || byte === 0x0d) {
      if (byte === 0x0d && bytes[index + 1] === 0x0a) index += 1;
      pushRow();
    } else if (byte === 0x22) {
      if (field.length !== 0) throw new Error("CSV quote must begin a field");
      quoted = true;
      rowStarted = true;
    } else {
      field.push(byte);
      rowStarted = true;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quote");
  if (rowStarted) pushRow();
  return rows;
}

function decodeRequired(bytes, label) {
  let value;
  try {
    value = new TextDecoder("euc-kr", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error(`${label} is not valid EUC-KR`);
  }
  if (value.length === 0 || /[\x00-\x1f\x7f-\x9f]/u.test(value)) {
    throw new Error(`${label} must be non-empty text without controls`);
  }
  return value;
}

export function parseSeoulStationLineInfoCsv(bytes) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) throw new Error("CSV bytes are required");
  const csvRows = tokenizeCsv(bytes);
  if (csvRows.length < 2) throw new Error("CSV must contain a header and at least one row");
  const header = csvRows[0].map((cell, index) => decodeRequired(cell, `header column ${index + 1}`));
  if (header.length !== HEADER.length || JSON.stringify(header) !== JSON.stringify(HEADER)) {
    throw new Error("CSV header must exactly match the OA15442 seven-column schema");
  }
  const seen = new Map();
  return csvRows.slice(1).map((csvRow, rowIndex) => {
    const label = `CSV row ${rowIndex + 2}`;
    if (csvRow.length !== HEADER.length) throw new Error(`${label} must have exactly seven columns`);
    const values = REQUIRED_COLUMNS.map((column, index) => decodeRequired(csvRow[column], `${label} ${REQUIRED_KEYS[index]}`));
    const row = Object.fromEntries(REQUIRED_KEYS.map((key, index) => [key, values[index]]));
    const key = `${row.LINE_NUM}\u0000${row.STATION_CD}`;
    const previous = seen.get(key);
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(row)) {
        throw new Error(`${label} exact duplicate station-line row is ambiguous: ${key}`);
      }
      throw new Error(`${label} conflicts with duplicate station-line row: ${key}`);
    }
    seen.set(key, row);
    return row;
  });
}

export function collectSeoulStationLineInfo({ csvBytes, capturedAt }) {
  const rawBytes = Buffer.from(csvBytes);
  const rows = parseSeoulStationLineInfoCsv(rawBytes);
  return {
    schemaVersion: 1,
    sourceId: "seoulmetro-station-line-info",
    artifactKind: "seoul-station-line-info-snapshot",
    official: true,
    fixture: false,
    capturedAt: canonicalUtc(capturedAt, "capturedAt"),
    rawSha256: sha256(rawBytes),
    rowsSha256: sha256(JSON.stringify(rows)),
    rowCount: rows.length,
    rows,
    rawBytesBase64: rawBytes.toString("base64"),
  };
}

function parseArgs(argv) {
  const allowed = new Set(["input", "output", "captured-at"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/u.test(flag) || !allowed.has(flag.slice(2)) || value === undefined || Object.hasOwn(args, flag.slice(2))) {
      throw new Error("expected each of --input, --output, and --captured-at exactly once");
    }
    args[flag.slice(2)] = value;
  }
  if (Object.keys(args).length !== allowed.size) throw new Error("expected each of --input, --output, and --captured-at exactly once");
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!path.isAbsolute(args.output)) throw new Error("--output must be an absolute path");
  const snapshot = collectSeoulStationLineInfo({
    csvBytes: await readFile(args.input),
    capturedAt: args["captured-at"],
  });
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
