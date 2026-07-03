#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_FIELDS = [
  "subwayRouteId",
  "subwayStationId",
  "subwayStationNm",
  "dailyTypeCode",
  "upDownTypeCode",
  "depTime",
  "arrTime",
];
const OBSERVED_FIELDS = [
  ...REQUIRED_FIELDS,
  "endSubwayStationNm",
  "endSubwayStationId",
];
const DAILY_TYPE_CODES = new Set(["01", "02", "03"]);
const UP_DOWN_CODES = new Set(["U", "D"]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    args[flag.slice(2)] = value;
    index += 1;
  }
  args.input ??= args.sample;
  if (!args.input) {
    throw new Error("--input is required");
  }
  return args;
}

function validateTagoScheduleSample(rawText) {
  const payload = JSON.parse(rawText);
  rejectCredentialLeak(rawText, payload);
  if (payload.response?.header && payload.response.header.resultCode !== "00") {
    throw new Error(`TAGO response is not normal service: ${payload.response?.header?.resultCode ?? "missing"}`);
  }

  const rows = normalizeRows(payload.response?.body?.items?.item);
  if (rows.length === 0) {
    throw new Error("TAGO schedule sample has no rows");
  }
  const observedFields = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const field of OBSERVED_FIELDS) {
    if (!observedFields.has(field)) {
      throw new Error(`TAGO schedule sample missing observed field: ${field}`);
    }
  }

  let previousDeparture = -1;
  const providerRecordHashes = [];
  const departures = [];
  for (const [index, row] of rows.entries()) {
    for (const field of REQUIRED_FIELDS) {
      if (typeof row[field] !== "string" || row[field].length === 0) {
        throw new Error(`TAGO schedule row ${index} missing field: ${field}`);
      }
    }
    if (!DAILY_TYPE_CODES.has(row.dailyTypeCode)) {
      throw new Error(`TAGO schedule row ${index} has unknown dailyTypeCode: ${row.dailyTypeCode}`);
    }
    if (!UP_DOWN_CODES.has(row.upDownTypeCode)) {
      throw new Error(`TAGO schedule row ${index} has unknown upDownTypeCode: ${row.upDownTypeCode}`);
    }
    const arrivalSeconds = parseHhmmss(row.arrTime, `row ${index} arrTime`);
    const departureSeconds = parseHhmmss(row.depTime, `row ${index} depTime`);
    if (arrivalSeconds > departureSeconds) {
      throw new Error(`TAGO schedule row ${index} arrival must be <= departure`);
    }
    if (departureSeconds < previousDeparture) {
      throw new Error(`TAGO schedule rows must be sorted by depTime`);
    }
    previousDeparture = departureSeconds;
    providerRecordHashes.push(sha256(JSON.stringify(sortObject(row))));
    departures.push({
      subwayStationId: row.subwayStationId,
      subwayRouteId: row.subwayRouteId,
      dailyTypeCode: row.dailyTypeCode,
      upDownTypeCode: row.upDownTypeCode,
      arrivalSeconds,
      departureSeconds,
    });
  }

  return {
    artifactKind: "tago-schedule-sample-importer-validation",
    candidateId: "molit-tago-subway-info",
    endpoint: "https://apis.data.go.kr/1613000/SubwayInfo/GetSubwaySttnAcctoSchdulList",
    rowCount: rows.length,
    providerRecordHashes,
    rawSha256: sha256(rawText),
    departures,
    stationLevelOnly: true,
    productionUseAllowed: false,
    remainingAdmissionBlocker: "line_wide_trip_stop_sequence_validation_required",
    stationTimetableProjectionStatus: "validated",
    productionCanonicalStopTimesStatus: "blocked_requires_trip_stop_sequence",
    plannedEtaUseAllowed: false,
  };
}

function normalizeRows(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return [value];
  }
  return [];
}

function parseHhmmss(value, label) {
  if (!/^\d{6}$/.test(value)) {
    throw new Error(`${label} must use HHMMSS`);
  }
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  const seconds = Number(value.slice(4, 6));
  if (hours > 29 || minutes > 59 || seconds > 59) {
    throw new Error(`${label} is out of range`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function rejectCredentialLeak(rawText, parsed, pathParts = []) {
  if (
    /serviceKey=(?!\[서비스키값\])[^&\s"]+/i.test(rawText) ||
    /"serviceKey"\s*:\s*"(?!\[서비스키값\]")[^"]+"/i.test(rawText)
  ) {
    throw new Error("TAGO schedule sample must not contain serviceKey credentials");
  }
  if (Array.isArray(parsed)) {
    for (const [index, item] of parsed.entries()) {
      rejectCredentialLeak("", item, [...pathParts, String(index)]);
    }
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (/serviceKey/i.test(key) && value !== "[서비스키값]") {
      throw new Error(`TAGO schedule sample must not contain serviceKey credentials: ${[...pathParts, key].join(".")}`);
    }
    rejectCredentialLeak("", value, [...pathParts, key]);
  }
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const result = validateTagoScheduleSample(await readFile(inputPath, "utf8"));
  if (args.output) {
    await writeFile(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}

export { validateTagoScheduleSample };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
