#!/usr/bin/env node
// 대전교통공사 1호선 엘리베이터·에스컬레이터 공식 FILE CSV를 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터(15041384·15041361)만 사용한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";

const ELEVATOR_DATASET_ID = "15041384";
const ESCALATOR_DATASET_ID = "15041361";
const DATASET_IDS = Object.freeze([ELEVATOR_DATASET_ID, ESCALATOR_DATASET_ID]);
const ELEVATOR_DETAIL_URL = `https://www.data.go.kr/data/${ELEVATOR_DATASET_ID}/fileData.do`;
const ESCALATOR_DETAIL_URL = `https://www.data.go.kr/data/${ESCALATOR_DATASET_ID}/fileData.do`;
const SOURCE_ID = "daejeon-transportation-accessibility";
const ARTIFACT_KIND = "daejeon-accessibility-snapshot";
const TOPOLOGY_SOURCE_ID = "daejeon-station-distance-fare";
const TOPOLOGY_SNAPSHOT_ID = "daejeon-station-distance-fare-topology-20260720";
const LINE_ID = "line-7051a9c2525c";
const EXPECTED_STATION_COUNT = 22;
const EXPECTED_ELEVATOR_ROWS = 76;
const EXPECTED_ESCALATOR_ROWS = 168;
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const STATION_NUMBERS = Object.freeze(Array.from({ length: EXPECTED_STATION_COUNT }, (_, index) => String(101 + index)));
const ELEVATOR_HEADERS = Object.freeze([
  "철도운영기관명", "선명", "역명", "출입구번호", "상세위치", "정원_인원", "정원_중량",
]);
const ESCALATOR_HEADERS = Object.freeze([
  "철도운영기관명", "선명", "역명", "상하행구분", "출입구번호", "상세위치", "시작층", "종료층",
]);

export function normalizedDaejeonStationName(name) {
  return String(name).normalize("NFKC")
    .replace(/\([^)]*\)/gu, "")
    .replace(/[\s/.·]/gu, "")
    .replace(/[0-9]+$/u, "")
    .replace(/역$/u, "");
}

export function parseDaejeonAccessibilityCsv({
  elevatorBytes,
  escalatorBytes,
  topologySnapshot,
  canonicalStationMappings,
}) {
  if (!(elevatorBytes instanceof Uint8Array) || elevatorBytes.byteLength === 0) {
    throw new Error("Daejeon elevator CSV bytes are required");
  }
  if (!(escalatorBytes instanceof Uint8Array) || escalatorBytes.byteLength === 0) {
    throw new Error("Daejeon escalator CSV bytes are required");
  }
  validateTopologySnapshot(topologySnapshot);
  const mappings = validateMappings(canonicalStationMappings);
  const scopeByNorm = new Map(mappings.map((mapping) => [
    normalizedDaejeonStationName(mapping.stationName),
    mapping,
  ]));
  if (scopeByNorm.size !== EXPECTED_STATION_COUNT) {
    throw new Error("Daejeon accessibility mapping normalization collided");
  }

  const elevatorCounts = countFacilityRows({
    bytes: elevatorBytes,
    expectedHeaders: ELEVATOR_HEADERS,
    expectedRowCount: EXPECTED_ELEVATOR_ROWS,
    label: "elevator",
    scopeByNorm,
  });
  const escalatorCounts = countFacilityRows({
    bytes: escalatorBytes,
    expectedHeaders: ESCALATOR_HEADERS,
    expectedRowCount: EXPECTED_ESCALATOR_ROWS,
    label: "escalator",
    scopeByNorm,
  });

  const rows = mappings.map((mapping) => {
    const elevator = elevatorCounts.get(mapping.stationNumber);
    const escalator = escalatorCounts.get(mapping.stationNumber);
    if (!Number.isInteger(elevator) || elevator < 1) {
      throw new Error(`Daejeon accessibility missing elevator rows: ${mapping.stationName}`);
    }
    if (!Number.isInteger(escalator) || escalator < 1) {
      throw new Error(`Daejeon accessibility missing escalator rows: ${mapping.stationName}`);
    }
    return {
      stationCode: mapping.stationNumber,
      stationName: mapping.stationName,
      lineId: LINE_ID,
      wheelchair_lift: 0,
      elevator,
      escalator,
    };
  }).sort((left, right) => left.stationCode.localeCompare(right.stationCode, "en"));

  if (rows.length !== EXPECTED_STATION_COUNT) {
    throw new Error(`Daejeon accessibility station count mismatch: ${rows.length}`);
  }
  const codes = new Set(rows.map(({ stationCode }) => stationCode));
  if (codes.size !== EXPECTED_STATION_COUNT
    || STATION_NUMBERS.some((code) => !codes.has(code))) {
    throw new Error("Daejeon accessibility station code scope mismatch");
  }
  return rows;
}

export function collectDaejeonAccessibility({
  elevatorBytes,
  escalatorBytes,
  topologySnapshot,
  canonicalStationMappings,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const rows = parseDaejeonAccessibilityCsv({
    elevatorBytes,
    escalatorBytes,
    topologySnapshot,
    canonicalStationMappings,
  });
  const scope = rows.map(({ stationCode, stationName, lineId }) => ({ stationCode, stationName, lineId }));
  const topologyLineages = [{
    sourceId: TOPOLOGY_SOURCE_ID,
    snapshotId: TOPOLOGY_SNAPSHOT_ID,
    contentSha256: topologySnapshot.contentSha256,
    lineId: LINE_ID,
  }];
  const elevatorSha256 = sha256(Buffer.from(elevatorBytes));
  const escalatorSha256 = sha256(Buffer.from(escalatorBytes));
  return {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    detailUrl: ELEVATOR_DETAIL_URL,
    detailUrls: {
      elevator: ELEVATOR_DETAIL_URL,
      escalator: ESCALATOR_DETAIL_URL,
    },
    datasetIds: [...DATASET_IDS],
    endpoint: ELEVATOR_DETAIL_URL,
    capturedAt: capturedAt.toISOString(),
    freshUntil: new Date(capturedAt.getTime() + FRESHNESS_MILLIS).toISOString(),
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    stationCount: rows.length,
    rowCount: rows.length,
    elevatorRowCount: EXPECTED_ELEVATOR_ROWS,
    escalatorRowCount: EXPECTED_ESCALATOR_ROWS,
    lineIds: [LINE_ID],
    fieldsProvided: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
    license: {
      type: "PUBLIC-DOMAIN",
      attribution: "대전교통공사",
      redistributionAllowed: true,
      evidenceUrl: ELEVATOR_DETAIL_URL,
    },
    topologyLineages,
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(JSON.stringify({
      [ELEVATOR_DATASET_ID]: elevatorSha256,
      [ESCALATOR_DATASET_ID]: escalatorSha256,
    })),
    elevatorRawSha256: elevatorSha256,
    escalatorRawSha256: escalatorSha256,
    rowsSha256: sha256(JSON.stringify(rows)),
    rows,
  };
}

function countFacilityRows({ bytes, expectedHeaders, expectedRowCount, label, scopeByNorm }) {
  const table = parseCsv(decodeOfficialCsv(bytes));
  if (table.length < 2) throw new Error(`Daejeon ${label} CSV has no data rows`);
  const header = table[0];
  if (JSON.stringify(header) !== JSON.stringify(expectedHeaders)) {
    throw new Error(`Daejeon ${label} CSV missing column`);
  }
  const nameIndex = header.indexOf("역명");
  const operatorIndex = header.indexOf("철도운영기관명");
  const lineIndex = header.indexOf("선명");
  const counts = new Map();
  for (const [rowIndex, row] of table.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`Daejeon ${label} CSV column count mismatch at row ${rowIndex + 2}`);
    }
    if (String(row[operatorIndex] ?? "").trim() !== "대전교통공사") {
      throw new Error(`Daejeon ${label} unexpected operator at row ${rowIndex + 2}`);
    }
    if (String(row[lineIndex] ?? "").trim() !== "1호선") {
      throw new Error(`Daejeon ${label} unexpected line at row ${rowIndex + 2}`);
    }
    const stationNameRaw = String(row[nameIndex] ?? "").trim();
    if (stationNameRaw.length === 0) {
      throw new Error(`Daejeon ${label} empty station name at row ${rowIndex + 2}`);
    }
    const mapping = scopeByNorm.get(normalizedDaejeonStationName(stationNameRaw));
    if (!mapping) {
      throw new Error(`Daejeon accessibility station join failed: ${stationNameRaw}`);
    }
    counts.set(mapping.stationNumber, (counts.get(mapping.stationNumber) ?? 0) + 1);
  }
  if (table.length - 1 !== expectedRowCount) {
    throw new Error(`Daejeon ${label} row count mismatch: ${table.length - 1}`);
  }
  if (counts.size !== EXPECTED_STATION_COUNT) {
    throw new Error(`Daejeon ${label} station coverage incomplete: ${counts.size}`);
  }
  for (const code of STATION_NUMBERS) {
    if (!counts.has(code)) throw new Error(`Daejeon ${label} missing station code: ${code}`);
  }
  return counts;
}

function validateTopologySnapshot(topologySnapshot) {
  if (topologySnapshot?.schemaVersion !== 1
    || topologySnapshot.artifactKind !== "daejeon-route-topology-collection"
    || topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.credentialRedacted !== true
    || JSON.stringify(topologySnapshot.stationNumbers) !== JSON.stringify(STATION_NUMBERS)
    || topologySnapshot.rowCount !== 42
    || topologySnapshot.rows?.length !== 42
    || topologySnapshot.contentSha256 !== sha256(JSON.stringify(topologySnapshot.rows))
    || topologySnapshot.rowsSha256 !== topologySnapshot.contentSha256) {
    throw new Error("invalid Daejeon topology snapshot");
  }
}

function validateMappings(canonicalStationMappings) {
  if (!Array.isArray(canonicalStationMappings) || canonicalStationMappings.length !== EXPECTED_STATION_COUNT) {
    throw new Error("Daejeon accessibility MOLIT mappings must contain 22 stations");
  }
  const codes = new Set();
  for (const [index, mapping] of canonicalStationMappings.entries()) {
    if (mapping.stationNumber !== STATION_NUMBERS[index]
      || typeof mapping.stationName !== "string"
      || mapping.stationName.trim() === ""
      || codes.has(mapping.stationNumber)) {
      throw new Error("Daejeon accessibility MOLIT mappings are invalid");
    }
    codes.add(mapping.stationNumber);
  }
  return canonicalStationMappings;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
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
      throw new Error("usage: collect-daejeon-accessibility.mjs --elevator-input <csv> --escalator-input <csv> --topology-snapshot <json> --molit-csv <csv> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args["elevator-input"] || !args["escalator-input"] || !args["topology-snapshot"]
    || !args["molit-csv"] || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-daejeon-accessibility.mjs --elevator-input <csv> --escalator-input <csv> --topology-snapshot <json> --molit-csv <csv> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runDaejeonAccessibilityCollector(argv) {
  const args = parseArgs(argv);
  const [elevatorBytes, escalatorBytes, topologySnapshot, molitBytes] = await Promise.all([
    readFile(args["elevator-input"]),
    readFile(args["escalator-input"]),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args["molit-csv"]),
  ]);
  const snapshot = collectDaejeonAccessibility({
    elevatorBytes,
    escalatorBytes,
    topologySnapshot,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitBytes),
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Daejeon accessibility snapshot ready: stations=${snapshot.stationCount} rows=${snapshot.rowCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDaejeonAccessibilityCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daejeon accessibility collection failed");
    process.exitCode = 1;
  }
}
