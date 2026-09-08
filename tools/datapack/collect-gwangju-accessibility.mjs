#!/usr/bin/env node
// 광주교통공사 1호선 엘리베이터·에스컬레이터 공식 FILE CSV를 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터(15041385·15041362)만 사용한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";

const ELEVATOR_DATASET_ID = "15041385";
const ESCALATOR_DATASET_ID = "15041362";
const DATASET_IDS = Object.freeze([ELEVATOR_DATASET_ID, ESCALATOR_DATASET_ID]);
const ELEVATOR_DETAIL_URL = `https://www.data.go.kr/data/${ELEVATOR_DATASET_ID}/fileData.do`;
const ESCALATOR_DETAIL_URL = `https://www.data.go.kr/data/${ESCALATOR_DATASET_ID}/fileData.do`;
const SOURCE_ID = "gwangju-transportation-accessibility";
const ARTIFACT_KIND = "gwangju-accessibility-snapshot";
const TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const ELEVATOR_HEADERS = Object.freeze([
  "철도운영기관명", "선명", "역명", "출입구번호", "상세위치", "정원_인원", "정원_중량",
]);
const ESCALATOR_HEADERS = Object.freeze([
  "철도운영기관명", "선명", "역명", "상하행구분", "출입구번호", "상세위치", "시작층", "종료층",
]);

export function normalizedGwangjuStationName(name) {
  return String(name).normalize("NFKC")
    .replace(/\([^)]*\)/gu, "")
    .replace(/[\s/.·]/gu, "")
    .replace(/[0-9]+$/u, "")
    .replace(/역$/u, "");
}

export function parseGwangjuAccessibilityCsv({
  elevatorBytes,
  escalatorBytes,
  topologySnapshot,
  topologySource,
}) {
  if (!(elevatorBytes instanceof Uint8Array) || elevatorBytes.byteLength === 0) {
    throw new Error("Gwangju elevator CSV bytes are required");
  }
  if (!(escalatorBytes instanceof Uint8Array) || escalatorBytes.byteLength === 0) {
    throw new Error("Gwangju escalator CSV bytes are required");
  }
  const { scope, lineId } = validateGwangjuAccessibilityTopology(topologySnapshot, topologySource);
  const scopeByNorm = new Map(scope.map((station) => [
    normalizedGwangjuStationName(station.stationName),
    station,
  ]));
  if (scopeByNorm.size !== scope.length) {
    throw new Error("Gwangju accessibility topology normalization collided");
  }

  const elevatorCounts = countFacilityRows({
    bytes: elevatorBytes,
    expectedHeaders: ELEVATOR_HEADERS,
    label: "elevator",
    scopeByNorm,
  });
  const escalatorCounts = countFacilityRows({
    bytes: escalatorBytes,
    expectedHeaders: ESCALATOR_HEADERS,
    label: "escalator",
    scopeByNorm,
  });

  // CSV에 없는 station/type 관측은 부재가 아니라 미관측이다.
  const rows = scope.map((station) => ({
    stationCode: station.stationCode,
    stationName: station.stationName,
    lineId,
    wheelchair_lift: null,
    elevator: elevatorCounts.get(station.stationCode) ?? null,
    escalator: escalatorCounts.get(station.stationCode) ?? null,
  })).sort((left, right) => left.stationCode.localeCompare(right.stationCode, "en"));

  if (rows.length !== scope.length) throw new Error("Gwangju accessibility station count mismatch");
  const codes = new Set(rows.map(({ stationCode }) => stationCode));
  if (codes.size !== rows.length) {
    throw new Error("Gwangju accessibility station code scope mismatch");
  }
  return rows;
}

export function collectGwangjuAccessibility({
  elevatorBytes,
  escalatorBytes,
  topologySnapshot,
  topologySource,
  now,
} = {}) {
  const capturedAt = validDate(now, "now");
  const rows = parseGwangjuAccessibilityCsv({
    elevatorBytes,
    escalatorBytes,
    topologySnapshot,
    topologySource,
  });
  const scope = rows.map(({ stationCode, stationName, lineId }) => ({ stationCode, stationName, lineId }));
  const topologyLineages = [{
    sourceId: TOPOLOGY_SOURCE_ID,
    snapshotId: topologySource.topologyAdmissionEvidence.snapshotId,
    contentSha256: topologySnapshot.contentSha256,
    lineId: topologySource.coverageScope.lineIds[0],
  }];
  const elevatorSha256 = sha256(Buffer.from(elevatorBytes));
  const escalatorSha256 = sha256(Buffer.from(escalatorBytes));
  return {
    schemaVersion: 2,
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
    elevatorRowCount: rows.reduce((sum, row) => sum + (row.elevator ?? 0), 0),
    escalatorRowCount: rows.reduce((sum, row) => sum + (row.escalator ?? 0), 0),
    lineIds: [...topologySource.coverageScope.lineIds],
    fieldsProvided: ["elevator", "escalator", "status", "verified_at"],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: "광주교통공사, 공공데이터포털 이용허락범위 제한 없음",
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

function countFacilityRows({ bytes, expectedHeaders, label, scopeByNorm }) {
  const table = parseCsv(decodeOfficialCsv(bytes));
  if (table.length < 2) throw new Error(`Gwangju ${label} CSV has no data rows`);
  const header = table[0];
  if (JSON.stringify(header) !== JSON.stringify(expectedHeaders)) {
    throw new Error(`Gwangju ${label} CSV missing column`);
  }
  const nameIndex = header.indexOf("역명");
  const operatorIndex = header.indexOf("철도운영기관명");
  const lineIndex = header.indexOf("선명");
  const counts = new Map();
  for (const [rowIndex, row] of table.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`Gwangju ${label} CSV column count mismatch at row ${rowIndex + 2}`);
    }
    if (String(row[operatorIndex] ?? "").trim() !== "광주교통공사") {
      throw new Error(`Gwangju ${label} unexpected operator at row ${rowIndex + 2}`);
    }
    if (String(row[lineIndex] ?? "").trim() !== "1호선") {
      throw new Error(`Gwangju ${label} unexpected line at row ${rowIndex + 2}`);
    }
    const stationNameRaw = String(row[nameIndex] ?? "").trim();
    if (stationNameRaw.length === 0) {
      throw new Error(`Gwangju ${label} empty station name at row ${rowIndex + 2}`);
    }
    const station = scopeByNorm.get(normalizedGwangjuStationName(stationNameRaw));
    if (!station) {
      throw new Error(`Gwangju accessibility station join failed: ${stationNameRaw}`);
    }
    counts.set(station.stationCode, (counts.get(station.stationCode) ?? 0) + 1);
  }
  return counts;
}

export function validateGwangjuAccessibilityTopology(topologySnapshot, topologySource) {
  const evidence = topologySource?.topologyAdmissionEvidence;
  if (topologySnapshot?.schemaVersion !== 1
    || topologySnapshot.artifactKind !== "gwangju-route-topology-snapshot"
    || topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.credentialRedacted !== true
    || topologySource?.id !== TOPOLOGY_SOURCE_ID
    || topologySource.coverageScope?.lineIds?.length !== 1
    || typeof topologySource.coverageScope.lineIds[0] !== "string"
    || typeof evidence?.snapshotId !== "string" || !evidence.snapshotId
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`
    || !Array.isArray(topologySnapshot.scope) || !topologySnapshot.scope.length
    || !Array.isArray(topologySnapshot.edges)
    || topologySnapshot.stationCount !== topologySnapshot.scope.length
    || topologySnapshot.edgeCount !== topologySnapshot.edges.length
    || ["stationCount", "edgeCount", "rawSha256", "contentSha256", "capturedAt", "freshUntil"]
      .some((key) => evidence[key] !== topologySnapshot[key])
    || topologySnapshot.contentSha256 !== sha256(JSON.stringify({
      scope: topologySnapshot.scope,
      edges: topologySnapshot.edges,
    }))
    || topologySnapshot.scopeSha256 !== sha256(JSON.stringify(topologySnapshot.scope))) {
    throw new Error("invalid Gwangju topology snapshot");
  }
  const codes = topologySnapshot.scope.map(({ stationCode }) => stationCode);
  if (new Set(codes).size !== codes.length || codes.some((code) => typeof code !== "string" || !code)
    || topologySnapshot.scope.some((station) => (
      typeof station.stationName !== "string" || station.stationName.trim() === ""
    ))) {
    throw new Error("invalid Gwangju topology snapshot scope");
  }
  return { scope: topologySnapshot.scope, lineId: topologySource.coverageScope.lineIds[0], evidence };
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
  // 행 수와 무관하게, 인용 필드가 닫히기 전에 끝난 CSV는 거부한다.
  if (quoted) throw new Error("Gwangju CSV has unterminated quoted field");
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
  const required = ["elevator-input", "escalator-input", "inventory", "output", "captured-at"];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.slice(2);
    if (!argv[index]?.startsWith("--") || !required.includes(key) || Object.hasOwn(args, key) || !argv[index + 1]) throw new Error("Gwangju collector arguments mismatch");
    args[key] = argv[index + 1];
  }
  if (required.some((key) => !args[key]) || !path.isAbsolute(args.output)) throw new Error("Gwangju collector arguments mismatch");
  return args;
}

export async function runGwangjuAccessibilityCollector(argv) {
  const args = parseArgs(argv);
  const [elevatorBytes, escalatorBytes, inventory] = await Promise.all([
    readFile(args["elevator-input"]),
    readFile(args["escalator-input"]),
    readFile(args.inventory, "utf8").then(JSON.parse),
  ]);
  const selected = inventory.sources?.filter(({ id }) => id === TOPOLOGY_SOURCE_ID) ?? [];
  if (selected.length !== 1) throw new Error("Gwangju topology source selection mismatch");
  const topologySource = selected[0];
  const relative = topologySource.topologyAdmissionEvidence?.snapshotPath;
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) throw new Error("Gwangju topology path mismatch");
  const topologySnapshot = JSON.parse(await readFile(path.resolve(relative), "utf8"));
  const snapshot = collectGwangjuAccessibility({
    elevatorBytes,
    escalatorBytes,
    topologySnapshot,
    topologySource,
    now: new Date(args["captured-at"]),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Gwangju accessibility snapshot ready: stations=${snapshot.stationCount} rows=${snapshot.rowCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runGwangjuAccessibilityCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju accessibility collection failed");
    process.exitCode = 1;
  }
}
