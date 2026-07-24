#!/usr/bin/env node
// 서울교통공사 1~8호선 역사 좌표(위경도) 공식 FILE CSV를 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터(15099316)만 사용한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const DATASET_ID = "15099316";
const DETAIL_URL = `https://www.data.go.kr/data/${DATASET_ID}/fileData.do`;
const SOURCE_ID = "seoul-metro-route-map-positions";
const ARTIFACT_KIND = "seoul-metro-route-map-positions-snapshot";
// 공식 FILE CSV 원본 행 수. 마곡·발산 동일 위경도(OFFICIAL_DUPLICATE_LATLON)는 admission에서 제외한다.
const EXPECTED_RAW_STATION_COUNT = 276;
const EXPECTED_RAW_LINE_STATION_COUNTS = Object.freeze({
  "1": 10,
  "2": 51,
  "3": 34,
  "4": 26,
  "5": 56,
  "6": 39,
  "7": 42,
  "8": 18,
});
const EXPECTED_STATION_COUNT = 274;
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({
  "1": 10,
  "2": 51,
  "3": 34,
  "4": 26,
  "5": 54,
  "6": 39,
  "7": 42,
  "8": 18,
});
const EXPECTED_QUARANTINED_COUNT = 2;
const OFFICIAL_DUPLICATE_LATLON = "OFFICIAL_DUPLICATE_LATLON";
const OBSERVED_DATA_UPDATED_AT = "2025-08-14";
const LINE_IDS_BY_NUMBER = Object.freeze({
  "1": "line-472a81add377",
  "2": "seoul-2",
  "3": "line-41a8c75ec9d8",
  "4": "seoul-4",
  "5": "line-80fc4d5350d4",
  "6": "line-3f41718e0833",
  "7": "line-15b3b8a93259",
  "8": "line-2b2d9eaa53d0",
});
const LINE_IDS = Object.freeze(Object.values(LINE_IDS_BY_NUMBER));
const KNOWN_STATION_IDS = Object.freeze({
  상록수: "station-sangnoksu",
  사당: "station-sadang",
  강남: "station-gangnam",
  성수: "station-seongsu",
  신설동: "station-sinseoldong",
});
const FIELDS_PROVIDED = Object.freeze(["route_map_position", "route_map_label_polygon"]);

export function parseSeoulRouteMapPositionsCsv(csvBytes) {
  if (!(csvBytes instanceof Uint8Array) || csvBytes.byteLength === 0) {
    throw new Error("Seoul route map positions CSV bytes are required");
  }
  const rows = parseCsv(decodeOfficialCsv(csvBytes));
  if (rows.length < 2) throw new Error("Seoul route map positions CSV has no data rows");
  const header = rows[0];
  const indexes = {
    line: header.indexOf("호선"),
    stationCode: header.indexOf("고유역번호(외부역코드)"),
    stationName: header.indexOf("역명"),
    latitude: header.indexOf("위도"),
    longitude: header.indexOf("경도"),
    writtenOn: header.indexOf("작성기준일"),
  };
  for (const [field, index] of Object.entries(indexes)) {
    if (index < 0) throw new Error(`Seoul route map positions CSV missing column: ${field}`);
  }

  const seen = new Set();
  const parsed = [];
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`Seoul route map positions CSV column count mismatch at row ${rowIndex + 2}`);
    }
    const lineNumber = String(row[indexes.line] ?? "").trim();
    const lineId = LINE_IDS_BY_NUMBER[lineNumber];
    if (!lineId) throw new Error(`Seoul route map positions unknown line: ${lineNumber || "missing"}`);
    const stationCode = String(row[indexes.stationCode] ?? "").trim();
    const stationName = String(row[indexes.stationName] ?? "").trim();
    if (!/^\d{3,4}$/.test(stationCode)) {
      throw new Error(`Seoul route map positions invalid station code at row ${rowIndex + 2}`);
    }
    if (stationName.length === 0 || stationName.length > 40) {
      throw new Error(`Seoul route map positions invalid station name at row ${rowIndex + 2}`);
    }
    const identity = `${lineId}:${stationCode}`;
    if (seen.has(identity)) throw new Error(`Seoul route map positions duplicate station: ${identity}`);
    seen.add(identity);
    const latitude = Number(String(row[indexes.latitude] ?? "").trim());
    const longitude = Number(String(row[indexes.longitude] ?? "").trim());
    if (!Number.isFinite(latitude) || latitude < 37 || latitude > 38.2
      || !Number.isFinite(longitude) || longitude < 126.5 || longitude > 127.5) {
      throw new Error(`Seoul route map positions invalid coordinates: ${identity}`);
    }
    const observed = String(row[indexes.writtenOn] ?? "").trim();
    if (observed !== OBSERVED_DATA_UPDATED_AT) {
      throw new Error(`Seoul route map positions unexpected 작성기준일: ${observed || "missing"}`);
    }
    const { x, y } = projectLatLon(latitude, longitude);
    const label = labelGeometry(stationName, x, y);
    parsed.push({
      lineId,
      line: lineNumber,
      stationCode,
      stationName,
      stationId: stationIdFor(stationName),
      latitude,
      longitude,
      x,
      y,
      labelDx: label.labelDx,
      labelDy: label.labelDy,
      labelPolygon: label.labelPolygon,
    });
  }
  if (parsed.length !== EXPECTED_RAW_STATION_COUNT) {
    throw new Error(`Seoul route map positions station count mismatch: ${parsed.length}`);
  }
  for (const [line, expected] of Object.entries(EXPECTED_RAW_LINE_STATION_COUNTS)) {
    const count = parsed.filter((row) => row.line === line).length;
    if (count !== expected) {
      throw new Error(`Seoul route map positions line ${line} station count mismatch: ${count}`);
    }
  }

  // 환승역은 동일 역명·동일 위경도를 호선별로 공유할 수 있다.
  // 서로 다른 역명이 같은 위경도를 쓰면 공식 FILE 결함으로 전량 quarantine한다.
  const byLatLon = new Map();
  for (const row of parsed) {
    const key = `${row.latitude},${row.longitude}`;
    const group = byLatLon.get(key);
    if (group) group.push(row);
    else byLatLon.set(key, [row]);
  }
  const positions = [];
  const quarantinedPositions = [];
  for (const group of byLatLon.values()) {
    const distinctNames = new Set(group.map((row) => row.stationName));
    if (distinctNames.size <= 1) {
      positions.push(...group);
      continue;
    }
    for (const row of group) {
      quarantinedPositions.push({
        lineId: row.lineId,
        line: row.line,
        stationCode: row.stationCode,
        stationName: row.stationName,
        stationId: row.stationId,
        latitude: row.latitude,
        longitude: row.longitude,
        x: row.x,
        y: row.y,
        reasonCode: OFFICIAL_DUPLICATE_LATLON,
      });
    }
  }
  positions.sort(comparePositions);
  quarantinedPositions.sort(comparePositions);
  if (positions.length !== EXPECTED_STATION_COUNT) {
    throw new Error(`Seoul route map positions admitted station count mismatch: ${positions.length}`);
  }
  if (quarantinedPositions.length !== EXPECTED_QUARANTINED_COUNT) {
    throw new Error(`Seoul route map positions quarantined count mismatch: ${quarantinedPositions.length}`);
  }
  for (const [line, expected] of Object.entries(EXPECTED_LINE_STATION_COUNTS)) {
    const count = positions.filter((row) => row.line === line).length;
    if (count !== expected) {
      throw new Error(`Seoul route map positions admitted line ${line} station count mismatch: ${count}`);
    }
  }
  return { positions, quarantinedPositions };
}

export function collectSeoulRouteMapPositions({
  csvBytes,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const { positions, quarantinedPositions } = parseSeoulRouteMapPositionsCsv(csvBytes);
  const scope = positions.map(({ lineId, stationCode, stationName, stationId }) => ({
    lineId,
    stationCode,
    stationName,
    stationId,
  }));
  const snapshot = {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    detailUrl: DETAIL_URL,
    datasetId: DATASET_ID,
    datasetUrl: DETAIL_URL,
    endpoint: DETAIL_URL,
    capturedAt: capturedAt.toISOString(),
    observedDataUpdatedAt: OBSERVED_DATA_UPDATED_AT,
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    rawStationCount: EXPECTED_RAW_STATION_COUNT,
    stationCount: positions.length,
    quarantinedCount: quarantinedPositions.length,
    lineIds: [...LINE_IDS],
    lineStationCounts: { ...EXPECTED_LINE_STATION_COUNTS },
    fieldsProvided: [...FIELDS_PROVIDED],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: "서울교통공사 · 공공데이터포털 이용허락범위 제한 없음",
      redistributionAllowed: true,
      evidenceUrl: DETAIL_URL,
    },
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(Buffer.from(csvBytes)),
    positionsSha256: sha256(JSON.stringify(positions)),
    positions,
    quarantinedPositions,
  };
  return validateSeoulRouteMapPositionsSnapshot(snapshot);
}

export function validateSeoulRouteMapPositionsSnapshot(snapshot) {
  const positions = snapshot?.positions;
  const quarantinedPositions = snapshot?.quarantinedPositions;
  const keys = new Set();
  const latLonOwners = new Map();
  const canvasOwners = new Map();
  const validPositions = Array.isArray(positions) && positions.length === EXPECTED_STATION_COUNT
    && positions.every((position) => {
      const key = `${position.lineId}:${position.stationCode}`;
      const owner = `${position.stationId}\0${position.stationName}`;
      const latLonKey = `${position.latitude},${position.longitude}`;
      const canvasKey = `${position.x},${position.y}`;
      const latLonOwner = latLonOwners.get(latLonKey);
      const canvasOwner = canvasOwners.get(canvasKey);
      const uniqueCoords = (latLonOwner == null || latLonOwner === owner)
        && (canvasOwner == null || canvasOwner === owner);
      const valid = LINE_IDS_BY_NUMBER[position.line] === position.lineId
        && /^\d{3,4}$/.test(position.stationCode)
        && typeof position.stationName === "string" && position.stationName.length > 0
        && typeof position.stationId === "string" && position.stationId.startsWith("station-")
        && [position.x, position.y, position.labelDx, position.labelDy].every(Number.isInteger)
        && position.x >= 0 && position.y >= 0
        && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
        && Array.isArray(position.labelPolygon) && position.labelPolygon.length === 4
        && position.labelPolygon.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)
        && !keys.has(key)
        && uniqueCoords;
      keys.add(key);
      latLonOwners.set(latLonKey, owner);
      canvasOwners.set(canvasKey, owner);
      return valid;
    });
  const quarantinedKeys = new Set();
  const validQuarantine = Array.isArray(quarantinedPositions)
    && quarantinedPositions.length === EXPECTED_QUARANTINED_COUNT
    && quarantinedPositions.every((entry) => {
      const key = `${entry.lineId}:${entry.stationCode}`;
      const valid = LINE_IDS_BY_NUMBER[entry.line] === entry.lineId
        && /^\d{3,4}$/.test(entry.stationCode)
        && typeof entry.stationName === "string" && entry.stationName.length > 0
        && typeof entry.stationId === "string" && entry.stationId.startsWith("station-")
        && Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude)
        && Number.isInteger(entry.x) && Number.isInteger(entry.y)
        && entry.reasonCode === OFFICIAL_DUPLICATE_LATLON
        && !quarantinedKeys.has(key)
        && !keys.has(key);
      quarantinedKeys.add(key);
      return valid;
    });
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== ARTIFACT_KIND
    || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || snapshot.datasetId !== DATASET_ID || snapshot.detailUrl !== DETAIL_URL
    || snapshot.datasetUrl !== DETAIL_URL || snapshot.endpoint !== DETAIL_URL
    || Number.isNaN(Date.parse(snapshot.capturedAt))
    || snapshot.observedDataUpdatedAt !== OBSERVED_DATA_UPDATED_AT
    || snapshot.rawStationCount !== EXPECTED_RAW_STATION_COUNT
    || snapshot.stationCount !== EXPECTED_STATION_COUNT
    || snapshot.quarantinedCount !== EXPECTED_QUARANTINED_COUNT
    || snapshot.rawStationCount !== snapshot.stationCount + snapshot.quarantinedCount
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify(LINE_IDS)
    || JSON.stringify(snapshot.lineStationCounts) !== JSON.stringify(EXPECTED_LINE_STATION_COUNTS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify(FIELDS_PROVIDED)
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.scopeSha256 ?? "")
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || !validPositions
    || !validQuarantine
    || JSON.stringify([...positions].sort(comparePositions)) !== JSON.stringify(positions)
    || JSON.stringify([...quarantinedPositions].sort(comparePositions)) !== JSON.stringify(quarantinedPositions)
    || snapshot.positionsSha256 !== sha256(JSON.stringify(positions))) {
    throw new Error("invalid Seoul route map positions snapshot");
  }
  return snapshot;
}

export function projectLatLon(latitude, longitude) {
  // 공식 위경도를 결정론적 양의 정수 canvas 좌표로 투영한다(경도→x, 북→작은 y).
  const x = Math.round((longitude - 126.5) * 100_000);
  const y = Math.round((38.2 - latitude) * 100_000);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw new Error(`Seoul route map projection out of bounds: ${latitude},${longitude}`);
  }
  return { x, y };
}

function labelGeometry(stationName, x, y) {
  const width = Math.max(28, [...normalizeStationName(stationName)].length * 14);
  const height = 22;
  const left = Math.max(0, x - Math.floor(width / 2));
  const top = Math.max(0, y - 34);
  const right = left + width;
  const bottom = top + height;
  const labelCenterX = (left + right) / 2;
  const labelCenterY = (top + bottom) / 2;
  return {
    labelDx: Math.round(labelCenterX - x),
    labelDy: Math.round(labelCenterY - y),
    labelPolygon: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
  };
}

function stationIdFor(stationName) {
  const normalized = normalizeStationName(stationName);
  return KNOWN_STATION_IDS[normalized] ?? `station-${sha1(`수도권:${normalized}`).slice(0, 12)}`;
}

function normalizeStationName(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, "").replace(/\([^()]*\)$/, "");
}

function decodeOfficialCsv(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
  }
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

function comparePositions(left, right) {
  return Number(left.line) - Number(right.line)
    || left.stationCode.localeCompare(right.stationCode, "en");
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) {
      throw new Error("usage: collect-seoul-route-map-positions.mjs --input <csv> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args.input || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-seoul-route-map-positions.mjs --input <csv> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runSeoulRouteMapPositionsCollector(argv) {
  const args = parseArgs(argv);
  const csvBytes = await readFile(args.input);
  const snapshot = collectSeoulRouteMapPositions({
    csvBytes,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Seoul route map positions snapshot ready: stations=${snapshot.stationCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runSeoulRouteMapPositionsCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Seoul route map position collection failed");
    process.exitCode = 1;
  }
}
