#!/usr/bin/env node
// 대구교통공사 역사별 장애인 편의시설 공식 FILE CSV를 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터(15149872)만 사용한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DAEGU_LINES,
  decodeOfficialCsv,
  normalizedStationName,
} from "./collect-daegu-datapack-sources.mjs";

const DATASET_ID = "15149872";
const DETAIL_URL = `https://www.data.go.kr/data/${DATASET_ID}/fileData.do`;
const SOURCE_ID = "daegu-transportation-accessibility";
const ARTIFACT_KIND = "daegu-accessibility-snapshot";
const EXPECTED_STATION_COUNT = 94;
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const LINE_IDS = Object.freeze(DAEGU_LINES.map(({ lineId }) => lineId));
const LINE_BY_NUMBER = Object.freeze(Object.fromEntries(
  DAEGU_LINES.map((line) => [line.lineNumber, line]),
));
const COUNT_HEADERS = Object.freeze({
  wheelchair_lift: "휠체어리프트(대)",
  elevator: "엘리베이터(대)",
  escalator: "에스컬레이터(대)",
});

export function parseDaeguAccessibilityCsv(facilitiesBytes, topologySnapshots) {
  if (!(facilitiesBytes instanceof Uint8Array) || facilitiesBytes.byteLength === 0) {
    throw new Error("Daegu accessibility CSV bytes are required");
  }
  const topologies = validateTopologySnapshots(topologySnapshots);
  const rows = parseCsv(decodeOfficialCsv(facilitiesBytes));
  if (rows.length < 2) throw new Error("Daegu accessibility CSV has no data rows");
  const header = rows[0];
  const lineIndex = header.indexOf("호선");
  const nameIndex = header.indexOf("역명");
  const countIndexes = Object.fromEntries(Object.entries(COUNT_HEADERS).map(([field, label]) => {
    const index = header.indexOf(label);
    if (index < 0) throw new Error(`Daegu accessibility CSV missing column: ${label}`);
    return [field, index];
  }));
  if (lineIndex < 0 || nameIndex < 0) {
    throw new Error("Daegu accessibility CSV missing 호선/역명 columns");
  }

  const scopeByLineNorm = new Map(DAEGU_LINES.map((line) => [
    line.lineNumber,
    new Map(topologies[line.lineNumber].scope.map((station) => [
      normalizedStationName(station.stationName),
      station,
    ])),
  ]));
  const seen = new Set();
  const parsed = [];
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`Daegu accessibility CSV column count mismatch at row ${rowIndex + 2}`);
    }
    const lineNumber = Number(String(row[lineIndex]).trim());
    const config = LINE_BY_NUMBER[lineNumber];
    if (!config) throw new Error(`Daegu accessibility unknown line: ${row[lineIndex]}`);
    const stationNameRaw = String(row[nameIndex] ?? "").trim();
    if (stationNameRaw.length === 0) {
      throw new Error(`Daegu accessibility empty station name at row ${rowIndex + 2}`);
    }
    const norm = normalizedStationName(stationNameRaw);
    const scope = scopeByLineNorm.get(lineNumber).get(norm);
    if (!scope) {
      throw new Error(`Daegu accessibility station join failed: line ${lineNumber} ${stationNameRaw}`);
    }
    const identity = `${config.lineId}:${scope.stationCode}`;
    if (seen.has(identity)) throw new Error(`Daegu accessibility duplicate station: ${identity}`);
    seen.add(identity);
    const counts = Object.fromEntries(Object.entries(countIndexes).map(([field, index]) => {
      const value = String(row[index] ?? "").trim();
      if (!/^\d{1,4}$/.test(value)) {
        throw new Error(`Daegu accessibility invalid ${field} at ${identity}: ${value || "missing"}`);
      }
      return [field, Number(value)];
    }));
    parsed.push({
      stationCode: scope.stationCode,
      stationName: scope.stationName,
      lineId: config.lineId,
      lineNumber,
      wheelchair_lift: counts.wheelchair_lift,
      elevator: counts.elevator,
      escalator: counts.escalator,
    });
  }
  if (parsed.length !== EXPECTED_STATION_COUNT) {
    throw new Error(`Daegu accessibility station count mismatch: ${parsed.length}`);
  }
  for (const config of DAEGU_LINES) {
    const count = parsed.filter((row) => row.lineNumber === config.lineNumber).length;
    if (count !== config.stationCount) {
      throw new Error(`Daegu accessibility line ${config.lineNumber} station count mismatch: ${count}`);
    }
    const codes = new Set(parsed.filter((row) => row.lineNumber === config.lineNumber).map((row) => row.stationCode));
    const expected = new Set(topologies[config.lineNumber].scope.map((station) => station.stationCode));
    if (codes.size !== expected.size || [...codes].some((code) => !expected.has(code))) {
      throw new Error(`Daegu accessibility line ${config.lineNumber} station code scope mismatch`);
    }
  }
  return parsed
    .sort((left, right) => left.lineNumber - right.lineNumber
      || left.stationCode.localeCompare(right.stationCode, "en"))
    .map(({ lineNumber: _lineNumber, ...row }) => row);
}

export function collectDaeguAccessibility({
  facilitiesBytes,
  topologySnapshots,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const rows = parseDaeguAccessibilityCsv(facilitiesBytes, topologySnapshots);
  const scope = rows.map(({ stationCode, stationName, lineId }) => ({ stationCode, stationName, lineId }));
  const topologyLineages = DAEGU_LINES.map((line) => {
    const topology = topologySnapshots[line.lineNumber];
    return {
      sourceId: topology.sourceId,
      snapshotId: `${topology.sourceId}-20260721`,
      contentSha256: topology.contentSha256,
      lineId: line.lineId,
    };
  });
  return {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    detailUrl: DETAIL_URL,
    datasetId: DATASET_ID,
    endpoint: DETAIL_URL,
    capturedAt: capturedAt.toISOString(),
    freshUntil: new Date(capturedAt.getTime() + FRESHNESS_MILLIS).toISOString(),
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    stationCount: rows.length,
    rowCount: rows.length,
    lineIds: [...LINE_IDS],
    fieldsProvided: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
    license: {
      type: "PUBLIC-DOMAIN",
      attribution: "대구교통공사",
      redistributionAllowed: true,
      evidenceUrl: DETAIL_URL,
    },
    topologyLineages,
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(Buffer.from(facilitiesBytes)),
    rowsSha256: sha256(JSON.stringify(rows)),
    rows,
  };
}

function validateTopologySnapshots(topologySnapshots) {
  if (!topologySnapshots || typeof topologySnapshots !== "object") {
    throw new Error("Daegu accessibility topology snapshots are required");
  }
  const topologies = {};
  for (const config of DAEGU_LINES) {
    const topology = topologySnapshots[config.lineNumber];
    if (topology?.schemaVersion !== 1
      || topology.artifactKind !== "daegu-route-topology-snapshot"
      || topology.sourceId !== `daegu-line${config.lineNumber}-route-topology`
      || topology.lineId !== config.lineId
      || topology.official !== true
      || topology.fixture !== false
      || topology.credentialRedacted !== true
      || topology.stationCount !== config.stationCount
      || topology.scope?.length !== config.stationCount
      || topology.contentSha256 !== sha256(JSON.stringify({ scope: topology.scope, edges: topology.edges }))) {
      throw new Error(`invalid Daegu line ${config.lineNumber} topology snapshot`);
    }
    topologies[config.lineNumber] = topology;
  }
  return topologies;
}

function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(","));
  const [header, ...body] = rows;
  if (header) {
    for (const [index, row] of body.entries()) {
      if (row.length !== header.length) {
        throw new Error(`CSV column count mismatch at row ${index + 2}: expected ${header.length}, got ${row.length}`);
      }
    }
  }
  return rows;
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) {
      throw new Error("usage: collect-daegu-accessibility.mjs --input <csv> --sources-dir <dir> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args.input || !args["sources-dir"] || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-daegu-accessibility.mjs --input <csv> --sources-dir <dir> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runDaeguAccessibilityCollector(argv) {
  const args = parseArgs(argv);
  const [facilitiesBytes, ...topologyBytes] = await Promise.all([
    readFile(args.input),
    ...DAEGU_LINES.map((line) => readFile(
      path.join(args["sources-dir"], `daegu-line${line.lineNumber}-route-topology-20260721.json`),
      "utf8",
    )),
  ]);
  const topologySnapshots = Object.fromEntries(DAEGU_LINES.map((line, index) => [
    line.lineNumber,
    JSON.parse(topologyBytes[index]),
  ]));
  const snapshot = collectDaeguAccessibility({
    facilitiesBytes,
    topologySnapshots,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Daegu accessibility snapshot ready: stations=${snapshot.stationCount} rows=${snapshot.rowCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDaeguAccessibilityCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daegu accessibility collection failed");
    process.exitCode = 1;
  }
}
