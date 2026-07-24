#!/usr/bin/env node
// 인천교통공사 1·2호선 엘리베이터·에스컬레이터·휠체어리프트 공식 FILE CSV를 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터(15083478·15010199·15146049)만 사용한다.
// 7호선 CSV 행과 비상시설(환기구·대피) 행은 skip하며 seoul-metro join을 발명하지 않는다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";
import { validateIncheonStationInfoSnapshot } from "./collect-incheon-station-info.mjs";

const ELEVATOR_DATASET_ID = "15083478";
const ESCALATOR_DATASET_ID = "15010199";
const WHEELCHAIR_DATASET_ID = "15146049";
const DATASET_IDS = Object.freeze([
  ELEVATOR_DATASET_ID,
  ESCALATOR_DATASET_ID,
  WHEELCHAIR_DATASET_ID,
]);
const ELEVATOR_DETAIL_URL = `https://www.data.go.kr/data/${ELEVATOR_DATASET_ID}/fileData.do`;
const ESCALATOR_DETAIL_URL = `https://www.data.go.kr/data/${ESCALATOR_DATASET_ID}/fileData.do`;
const WHEELCHAIR_DETAIL_URL = `https://www.data.go.kr/data/${WHEELCHAIR_DATASET_ID}/fileData.do`;
const SOURCE_ID = "incheon-transit-accessibility";
const ARTIFACT_KIND = "incheon-accessibility-snapshot";
const TOPOLOGY_SOURCE_ID = "incheon-transit-station-info";
const TOPOLOGY_SNAPSHOT_ID = "incheon-transit-station-info-20260724";
const TOPOLOGY_CONTENT_SHA256 = "710878689282ba967697cd9411940b657a51eee5499106ed884d5bd9111501a8";
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE_IDS = Object.freeze([LINE2, LINE1]);
const CSV_LINE_TO_ID = Object.freeze({
  1: LINE1,
  2: LINE2,
});
const EXPECTED_STATION_COUNT = 60;
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({
  [LINE1]: 33,
  [LINE2]: 27,
});
const EXPECTED_ELEVATOR_CSV_ROWS = 269;
const EXPECTED_ESCALATOR_CSV_ROWS = 653;
const EXPECTED_WHEELCHAIR_CSV_ROWS = 3;
const EXPECTED_ELEVATOR_JOINED = 213;
const EXPECTED_ESCALATOR_JOINED = 490;
const EXPECTED_WHEELCHAIR_JOINED = 3;
const EXPECTED_SKIPPED_LINE7_ELEVATOR = 52;
const EXPECTED_SKIPPED_LINE7_ESCALATOR = 163;
const EXPECTED_SKIPPED_NON_STATION_ELEVATOR = 4;
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const ELEVATOR_ESCALATOR_HEADERS = Object.freeze([
  "호선", "역명", "장비종류", "호기", "승강기번호", "운행구간", "설치위치",
]);
const WHEELCHAIR_HEADERS = Object.freeze([
  "호선", "역명", "호기", "운전구간", "정격하중", "비고",
]);
const NON_STATION_FACILITY_NAMES = Object.freeze(new Set([
  "6번환기구(1082)",
  "9번환기구(1072)",
  "대피3",
  "대피4",
]));
const STATION_NAME_ALIASES = Object.freeze({
  문학: "문학경기장",
});

export function normalizedIncheonStationName(name) {
  let value = String(name).normalize("NFKC").trim();
  value = value.replace(/\([^)]*\)/gu, "").trim();
  if (value.endsWith("역")) value = value.slice(0, -1);
  return STATION_NAME_ALIASES[value] ?? value;
}

export function parseIncheonAccessibilityCsv({
  elevatorBytes,
  escalatorBytes,
  wheelchairBytes,
  topologySnapshot,
}) {
  if (!(elevatorBytes instanceof Uint8Array) || elevatorBytes.byteLength === 0) {
    throw new Error("Incheon elevator CSV bytes are required");
  }
  if (!(escalatorBytes instanceof Uint8Array) || escalatorBytes.byteLength === 0) {
    throw new Error("Incheon escalator CSV bytes are required");
  }
  if (!(wheelchairBytes instanceof Uint8Array) || wheelchairBytes.byteLength === 0) {
    throw new Error("Incheon wheelchair CSV bytes are required");
  }
  const scope = validateTopologySnapshot(topologySnapshot);
  const scopeByKey = new Map(scope.map((station) => [
    `${station.lineId}:${normalizedIncheonStationName(station.stationName)}`,
    station,
  ]));
  if (scopeByKey.size !== EXPECTED_STATION_COUNT) {
    throw new Error("Incheon accessibility topology normalization collided");
  }

  const elevator = countFacilityRows({
    bytes: elevatorBytes,
    expectedHeaders: ELEVATOR_ESCALATOR_HEADERS,
    expectedCsvRowCount: EXPECTED_ELEVATOR_CSV_ROWS,
    expectedJoinedCount: EXPECTED_ELEVATOR_JOINED,
    expectedSkippedLine7: EXPECTED_SKIPPED_LINE7_ELEVATOR,
    expectedSkippedNonStation: EXPECTED_SKIPPED_NON_STATION_ELEVATOR,
    label: "elevator",
    scopeByKey,
    allowNonStationSkip: true,
  });
  const escalator = countFacilityRows({
    bytes: escalatorBytes,
    expectedHeaders: ELEVATOR_ESCALATOR_HEADERS,
    expectedCsvRowCount: EXPECTED_ESCALATOR_CSV_ROWS,
    expectedJoinedCount: EXPECTED_ESCALATOR_JOINED,
    expectedSkippedLine7: EXPECTED_SKIPPED_LINE7_ESCALATOR,
    expectedSkippedNonStation: 0,
    label: "escalator",
    scopeByKey,
    allowNonStationSkip: true,
  });
  const wheelchair = countFacilityRows({
    bytes: wheelchairBytes,
    expectedHeaders: WHEELCHAIR_HEADERS,
    expectedCsvRowCount: EXPECTED_WHEELCHAIR_CSV_ROWS,
    expectedJoinedCount: EXPECTED_WHEELCHAIR_JOINED,
    expectedSkippedLine7: 0,
    expectedSkippedNonStation: 0,
    label: "wheelchair",
    scopeByKey,
    allowNonStationSkip: false,
  });

  // topology 60 membership 전량 admit. CSV에 없는 역·시설은 공식 미게재로 count=0(장비 발명 금지).
  const rows = scope.map((station) => ({
    stationCode: station.stationCode,
    stationName: station.stationName,
    lineId: station.lineId,
    wheelchair_lift: wheelchair.counts.get(station.stationCode) ?? 0,
    elevator: elevator.counts.get(station.stationCode) ?? 0,
    escalator: escalator.counts.get(station.stationCode) ?? 0,
  })).sort((left, right) => {
    const lineCmp = left.lineId.localeCompare(right.lineId, "en");
    return lineCmp !== 0 ? lineCmp : left.stationCode.localeCompare(right.stationCode, "en");
  });

  if (rows.length !== EXPECTED_STATION_COUNT) {
    throw new Error(`Incheon accessibility station count mismatch: ${rows.length}`);
  }
  for (const [lineId, expected] of Object.entries(EXPECTED_LINE_STATION_COUNTS)) {
    if (rows.filter((row) => row.lineId === lineId).length !== expected) {
      throw new Error(`Incheon accessibility line station count mismatch: ${lineId}`);
    }
  }
  if (rows.reduce((sum, row) => sum + row.elevator, 0) !== EXPECTED_ELEVATOR_JOINED
    || rows.reduce((sum, row) => sum + row.escalator, 0) !== EXPECTED_ESCALATOR_JOINED
    || rows.reduce((sum, row) => sum + row.wheelchair_lift, 0) !== EXPECTED_WHEELCHAIR_JOINED) {
    throw new Error("Incheon accessibility aggregated facility counts mismatch");
  }
  return {
    rows,
    skippedNonStationFacilityRows: elevator.skippedNonStationNames,
    skippedLine7RowCounts: {
      elevator: elevator.skippedLine7,
      escalator: escalator.skippedLine7,
      wheelchair_lift: wheelchair.skippedLine7,
    },
  };
}

export function collectIncheonAccessibility({
  elevatorBytes,
  escalatorBytes,
  wheelchairBytes,
  topologySnapshot,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const {
    rows,
    skippedNonStationFacilityRows,
    skippedLine7RowCounts,
  } = parseIncheonAccessibilityCsv({
    elevatorBytes,
    escalatorBytes,
    wheelchairBytes,
    topologySnapshot,
  });
  const scope = rows.map(({ stationCode, stationName, lineId }) => ({ stationCode, stationName, lineId }));
  const topologyLineages = LINE_IDS.map((lineId) => ({
    sourceId: TOPOLOGY_SOURCE_ID,
    snapshotId: TOPOLOGY_SNAPSHOT_ID,
    contentSha256: topologySnapshot.contentSha256,
    lineId,
  }));
  const elevatorSha256 = sha256(Buffer.from(elevatorBytes));
  const escalatorSha256 = sha256(Buffer.from(escalatorBytes));
  const wheelchairSha256 = sha256(Buffer.from(wheelchairBytes));
  return {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    detailUrl: ELEVATOR_DETAIL_URL,
    detailUrls: {
      elevator: ELEVATOR_DETAIL_URL,
      escalator: ESCALATOR_DETAIL_URL,
      wheelchair_lift: WHEELCHAIR_DETAIL_URL,
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
    elevatorRowCount: EXPECTED_ELEVATOR_JOINED,
    escalatorRowCount: EXPECTED_ESCALATOR_JOINED,
    wheelchairRowCount: EXPECTED_WHEELCHAIR_JOINED,
    elevatorCsvRowCount: EXPECTED_ELEVATOR_CSV_ROWS,
    escalatorCsvRowCount: EXPECTED_ESCALATOR_CSV_ROWS,
    wheelchairCsvRowCount: EXPECTED_WHEELCHAIR_CSV_ROWS,
    skippedNonStationFacilityRows,
    skippedLine7RowCounts,
    lineIds: [...LINE_IDS],
    fieldsProvided: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: "인천교통공사, 공공데이터포털 이용허락범위 제한 없음",
      redistributionAllowed: true,
      evidenceUrl: ELEVATOR_DETAIL_URL,
    },
    topologyLineages,
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(JSON.stringify({
      [ELEVATOR_DATASET_ID]: elevatorSha256,
      [ESCALATOR_DATASET_ID]: escalatorSha256,
      [WHEELCHAIR_DATASET_ID]: wheelchairSha256,
    })),
    elevatorRawSha256: elevatorSha256,
    escalatorRawSha256: escalatorSha256,
    wheelchairRawSha256: wheelchairSha256,
    rowsSha256: sha256(JSON.stringify(rows)),
    rows,
  };
}

function countFacilityRows({
  bytes,
  expectedHeaders,
  expectedCsvRowCount,
  expectedJoinedCount,
  expectedSkippedLine7,
  expectedSkippedNonStation,
  label,
  scopeByKey,
  allowNonStationSkip,
}) {
  const table = parseCsv(decodeOfficialCsv(bytes));
  if (table.length < 2) throw new Error(`Incheon ${label} CSV has no data rows`);
  const header = table[0];
  if (JSON.stringify(header) !== JSON.stringify(expectedHeaders)) {
    throw new Error(`Incheon ${label} CSV missing column`);
  }
  const lineIndex = header.indexOf("호선");
  const nameIndex = header.indexOf("역명");
  const counts = new Map();
  let skippedLine7 = 0;
  const skippedNonStationNames = [];
  for (const [rowIndex, row] of table.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`Incheon ${label} CSV column count mismatch at row ${rowIndex + 2}`);
    }
    const lineRaw = String(row[lineIndex] ?? "").normalize("NFKC").trim();
    if (lineRaw === "7") {
      skippedLine7 += 1;
      continue;
    }
    const lineId = CSV_LINE_TO_ID[lineRaw];
    if (!lineId) {
      throw new Error(`Incheon ${label} unexpected line at row ${rowIndex + 2}: ${lineRaw}`);
    }
    const stationNameRaw = String(row[nameIndex] ?? "").normalize("NFKC").trim();
    if (stationNameRaw.length === 0) {
      throw new Error(`Incheon ${label} empty station name at row ${rowIndex + 2}`);
    }
    if (NON_STATION_FACILITY_NAMES.has(stationNameRaw)) {
      if (!allowNonStationSkip) {
        throw new Error(`Incheon ${label} unexpected non-station facility row: ${stationNameRaw}`);
      }
      skippedNonStationNames.push(stationNameRaw);
      continue;
    }
    const station = scopeByKey.get(`${lineId}:${normalizedIncheonStationName(stationNameRaw)}`);
    if (!station) {
      throw new Error(`Incheon accessibility station join failed: ${lineRaw}:${stationNameRaw}`);
    }
    counts.set(station.stationCode, (counts.get(station.stationCode) ?? 0) + 1);
  }
  if (table.length - 1 !== expectedCsvRowCount) {
    throw new Error(`Incheon ${label} CSV row count mismatch: ${table.length - 1}`);
  }
  if (skippedLine7 !== expectedSkippedLine7) {
    throw new Error(`Incheon ${label} line7 skip count mismatch: ${skippedLine7}`);
  }
  if (skippedNonStationNames.length !== expectedSkippedNonStation) {
    throw new Error(`Incheon ${label} non-station skip count mismatch: ${skippedNonStationNames.length}`);
  }
  const joined = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (joined !== expectedJoinedCount) {
    throw new Error(`Incheon ${label} joined row count mismatch: ${joined}`);
  }
  return { counts, skippedLine7, skippedNonStationNames };
}

function validateTopologySnapshot(topologySnapshot) {
  validateIncheonStationInfoSnapshot(topologySnapshot);
  const topologyScope = (topologySnapshot.scope ?? [])
    .filter((station) => LINE_IDS.includes(station.lineId));
  if (topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || topologySnapshot.contentSha256 !== TOPOLOGY_CONTENT_SHA256
    || JSON.stringify(topologySnapshot.topologyLineIds) !== JSON.stringify([...LINE_IDS])
    || topologyScope.length !== EXPECTED_STATION_COUNT) {
    throw new Error("invalid Incheon topology snapshot");
  }
  return topologyScope;
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
      throw new Error("usage: collect-incheon-accessibility.mjs --elevator-input <csv> --escalator-input <csv> --wheelchair-input <csv> --topology-snapshot <json> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args["elevator-input"] || !args["escalator-input"] || !args["wheelchair-input"]
    || !args["topology-snapshot"] || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-incheon-accessibility.mjs --elevator-input <csv> --escalator-input <csv> --wheelchair-input <csv> --topology-snapshot <json> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runIncheonAccessibilityCollector(argv) {
  const args = parseArgs(argv);
  const topologyPath = args["topology-snapshot"];
  const topologySnapshotId = path.basename(topologyPath, ".json");
  if (topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID) {
    throw new Error(`Incheon topology snapshot path must be ${TOPOLOGY_SNAPSHOT_ID}.json`);
  }
  const [elevatorBytes, escalatorBytes, wheelchairBytes, topologySnapshot] = await Promise.all([
    readFile(args["elevator-input"]),
    readFile(args["escalator-input"]),
    readFile(args["wheelchair-input"]),
    readFile(topologyPath, "utf8").then(JSON.parse),
  ]);
  const snapshot = collectIncheonAccessibility({
    elevatorBytes,
    escalatorBytes,
    wheelchairBytes,
    topologySnapshot: {
      ...topologySnapshot,
      snapshotId: topologySnapshot.snapshotId ?? topologySnapshotId,
    },
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Incheon accessibility snapshot ready: stations=${snapshot.stationCount} rows=${snapshot.rowCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runIncheonAccessibilityCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Incheon accessibility collection failed");
    process.exitCode = 1;
  }
}
