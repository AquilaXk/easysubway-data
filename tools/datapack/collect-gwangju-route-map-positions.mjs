#!/usr/bin/env node
// 광주교통공사 1호선 문화노선도 현황(공식 FILE CSV)을 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터(15109340)만 사용한다.
//
// 하이브리드 정렬:
// - 공식 FILE 위경도는 provenance(latitude/longitude)로만 유지한다.
// - admitted route_map_positions x/y/label*는 앱 하이브리드 basemap이 쓰는
//   owner-self-drawn-sma-schematic canvas 좌표 fixture에서 역명(정규화) join으로 결속한다.
// - 위경도→canvas 투영(projectLatLon 식 ~10^4 scale)은 basemap과 불일치하므로 admission에 사용하지 않는다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";

const DATASET_ID = "15109340";
const DETAIL_URL = `https://www.data.go.kr/data/${DATASET_ID}/fileData.do`;
const SOURCE_ID = "gwangju-transportation-route-map-positions";
const ARTIFACT_KIND = "gwangju-route-map-positions-snapshot";
const LINE_ID = "line-e57a361e8892";
const LINE_NUMBER = "1";
const LINE_IDS = Object.freeze([LINE_ID]);
const EXPECTED_STATION_COUNT = 20;
const EXPECTED_QUARANTINED_COUNT = 0;
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({ "1": EXPECTED_STATION_COUNT });
const STATION_CODES = Object.freeze(
  Array.from({ length: EXPECTED_STATION_COUNT }, (_, index) => String(100 + index)),
);
const TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const TOPOLOGY_SNAPSHOT_ID = "gwangju-transportation-route-topology-20260720";
const OBSERVED_DATA_UPDATED_AT = "2022-12-02";
const OFFICIAL_DUPLICATE_LATLON = "OFFICIAL_DUPLICATE_LATLON";
const FIELDS_PROVIDED = Object.freeze(["route_map_position", "route_map_label_polygon"]);
const SCHEMATIC_CANVAS_SOURCE_ID = "owner-self-drawn-sma-schematic";
// 앱 pack schematic canvas 실측 범위(x≈272–1881, y≈284–1666)에 여유를 둔다.
// 위경도 투영(~10^4) 좌표가 이 범위에 들어오면 admission을 거부한다.
const CANVAS_X_MIN = 200;
const CANVAS_X_MAX = 2000;
const CANVAS_Y_MIN = 200;
const CANVAS_Y_MAX = 1800;
// 광주 도심 공식 위경도 허용 범위(실측 35.10–35.16 / 126.76–126.94에 여유 포함).
const LAT_MIN = 35.05;
const LAT_MAX = 35.25;
const LON_MIN = 126.70;
const LON_MAX = 127.00;
// topology/CSV 정규화 역명 → schematic pack stationName.
const SCHEMATIC_NAME_ALIASES = Object.freeze({
  광주송정: "광주송정역",
});

export function parseGwangjuRouteMapPositionsCsv({
  csvBytes,
  topologySnapshot,
  schematicCanvas,
} = {}) {
  if (!(csvBytes instanceof Uint8Array) || csvBytes.byteLength === 0) {
    throw new Error("Gwangju route map positions CSV bytes are required");
  }
  const scope = validateTopologySnapshot(topologySnapshot);
  const canvasByName = indexSchematicCanvas(schematicCanvas);
  const byCode = new Map(scope.map((station) => [station.stationCode, station]));
  const rows = parseCsv(decodeOfficialCsv(csvBytes));
  if (rows.length < 2) throw new Error("Gwangju route map positions CSV has no data rows");
  const header = rows[0];
  const indexes = {
    stationCode: header.indexOf("역번호"),
    stationName: header.indexOf("역사명"),
    lineNumber: header.indexOf("노선번호"),
    lineName: header.indexOf("노선명"),
    latitude: header.indexOf("역위도"),
    longitude: header.indexOf("역경도"),
    observed: header.indexOf("데이터기준일자"),
  };
  for (const [field, index] of Object.entries(indexes)) {
    if (index < 0) throw new Error(`Gwangju route map positions CSV missing column: ${field}`);
  }

  const seen = new Set();
  const joined = [];
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`Gwangju route map positions CSV column count mismatch at row ${rowIndex + 2}`);
    }
    const stationCode = String(row[indexes.stationCode] ?? "").trim();
    const csvStationName = String(row[indexes.stationName] ?? "").trim();
    if (!/^\d{3}$/.test(stationCode) || csvStationName.length === 0) {
      throw new Error(`Gwangju route map positions invalid station identity at row ${rowIndex + 2}`);
    }
    if (seen.has(stationCode)) {
      throw new Error(`Gwangju route map positions duplicate station code: ${stationCode}`);
    }
    seen.add(stationCode);
    const lineNumberToken = String(row[indexes.lineNumber] ?? "").trim();
    const lineName = String(row[indexes.lineName] ?? "").trim();
    if (lineNumberToken !== "S2901" || !lineName.includes("1호선")) {
      throw new Error(`Gwangju route map positions unexpected line at row ${rowIndex + 2}`);
    }
    const observed = String(row[indexes.observed] ?? "").trim();
    if (observed !== OBSERVED_DATA_UPDATED_AT) {
      throw new Error(`Gwangju route map positions unexpected 데이터기준일자: ${observed || "missing"}`);
    }
    const latitude = Number(String(row[indexes.latitude] ?? "").trim());
    const longitude = Number(String(row[indexes.longitude] ?? "").trim());
    if (!Number.isFinite(latitude) || latitude < LAT_MIN || latitude > LAT_MAX
      || !Number.isFinite(longitude) || longitude < LON_MIN || longitude > LON_MAX) {
      throw new Error(`Gwangju route map positions invalid coordinates: ${stationCode}`);
    }
    const station = byCode.get(stationCode);
    if (!station) {
      throw new Error(`Gwangju route map positions topology join failed: ${stationCode}`);
    }
    // FILE↔topology는 stationCode=역번호, canvas는 정규화 역명(+별칭)으로 결속한다.
    const canvas = lookupSchematicCanvas(canvasByName, station.stationName);
    if (!canvas) {
      throw new Error(
        `Gwangju route map positions schematic canvas join failed: ${station.stationName}`,
      );
    }
    // pack builder/SQLite 계약은 정수 canvas를 요구한다. schematic 실수 좌표를 반올림해 결속한다.
    const x = Math.round(canvas.x);
    const y = Math.round(canvas.y);
    if (!isSchematicCanvasCoordinate(x, y)) {
      throw new Error(`Gwangju route map schematic canvas out of bounds: ${station.stationName}`);
    }
    joined.push({
      lineId: LINE_ID,
      line: LINE_NUMBER,
      stationCode: station.stationCode,
      stationName: station.stationName,
      stationId: stationIdFor(station.stationName),
      csvStationName,
      latitude,
      longitude,
      x,
      y,
      labelDx: canvas.labelDx,
      labelDy: canvas.labelDy,
      labelPolygon: structuredClone(canvas.labelPolygon),
    });
  }
  if (joined.length !== EXPECTED_STATION_COUNT) {
    throw new Error(`Gwangju route map positions station count mismatch: ${joined.length}`);
  }
  if (STATION_CODES.some((code) => !seen.has(code))) {
    throw new Error("Gwangju route map positions station code scope mismatch");
  }

  // 서로 다른 stationId가 같은 위경도를 쓰면 공식 FILE 결함으로 전량 quarantine한다(좌표 발명 금지).
  const byLatLon = new Map();
  for (const row of joined) {
    const key = `${row.latitude},${row.longitude}`;
    const group = byLatLon.get(key);
    if (group) group.push(row);
    else byLatLon.set(key, [row]);
  }
  const positions = [];
  const quarantinedPositions = [];
  for (const group of byLatLon.values()) {
    const distinctStationIds = new Set(group.map((row) => row.stationId));
    if (distinctStationIds.size <= 1) {
      positions.push(...group.map(({ csvStationName: _csv, ...row }) => row));
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
    throw new Error(`Gwangju route map positions admitted station count mismatch: ${positions.length}`);
  }
  if (quarantinedPositions.length !== EXPECTED_QUARANTINED_COUNT) {
    throw new Error(`Gwangju route map positions quarantined count mismatch: ${quarantinedPositions.length}`);
  }
  return { positions, quarantinedPositions };
}

export function collectGwangjuRouteMapPositions({
  csvBytes,
  topologySnapshot,
  schematicCanvas,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const { positions, quarantinedPositions } = parseGwangjuRouteMapPositionsCsv({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
  });
  const topologyLineages = [{
    sourceId: topologySnapshot.sourceId,
    snapshotId: TOPOLOGY_SNAPSHOT_ID,
    contentSha256: topologySnapshot.contentSha256,
    lineId: LINE_ID,
  }];
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
    datasetIds: [DATASET_ID],
    datasetUrl: DETAIL_URL,
    endpoint: DETAIL_URL,
    capturedAt: capturedAt.toISOString(),
    observedDataUpdatedAt: OBSERVED_DATA_UPDATED_AT,
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    rawStationCount: EXPECTED_STATION_COUNT,
    stationCount: positions.length,
    quarantinedCount: quarantinedPositions.length,
    lineIds: [...LINE_IDS],
    lineStationCounts: { ...EXPECTED_LINE_STATION_COUNTS },
    fieldsProvided: [...FIELDS_PROVIDED],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: "광주교통공사 · 공공데이터포털 이용허락범위 제한 없음",
      redistributionAllowed: true,
      evidenceUrl: DETAIL_URL,
    },
    topologySourceId: TOPOLOGY_SOURCE_ID,
    topologySnapshotId: TOPOLOGY_SNAPSHOT_ID,
    topologyContentSha256: topologySnapshot.contentSha256,
    topologyLineages,
    schematicCanvasSourceId: SCHEMATIC_CANVAS_SOURCE_ID,
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(Buffer.from(csvBytes)),
    positionsSha256: sha256(JSON.stringify(positions)),
    positions,
    quarantinedPositions,
  };
  return validateGwangjuRouteMapPositionsSnapshot(snapshot);
}

export function validateGwangjuRouteMapPositionsSnapshot(snapshot) {
  const positions = snapshot?.positions;
  const quarantinedPositions = snapshot?.quarantinedPositions;
  const keys = new Set();
  const latLonOwners = new Map();
  const canvasOwners = new Map();
  const validPositions = Array.isArray(positions) && positions.length === EXPECTED_STATION_COUNT
    && positions.every((position) => {
      const key = `${position.lineId}:${position.stationCode}`;
      const owner = position.stationId;
      const latLonKey = `${position.latitude},${position.longitude}`;
      const canvasKey = `${position.x},${position.y}`;
      const latLonOwner = latLonOwners.get(latLonKey);
      const canvasOwner = canvasOwners.get(canvasKey);
      const uniqueCoords = (latLonOwner == null || latLonOwner === owner)
        && (canvasOwner == null || canvasOwner === owner);
      const valid = position.lineId === LINE_ID
        && position.line === LINE_NUMBER
        && /^\d{3}$/.test(position.stationCode)
        && typeof position.stationName === "string" && position.stationName.length > 0
        && typeof position.stationId === "string" && position.stationId.startsWith("station-")
        && Number.isInteger(position.x) && Number.isInteger(position.y)
        && isSchematicCanvasCoordinate(position.x, position.y)
        && Number.isInteger(position.labelDx) && Number.isInteger(position.labelDy)
        && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
        && position.latitude >= LAT_MIN && position.latitude <= LAT_MAX
        && position.longitude >= LON_MIN && position.longitude <= LON_MAX
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
      const valid = entry.lineId === LINE_ID
        && /^\d{3}$/.test(entry.stationCode)
        && typeof entry.stationName === "string" && entry.stationName.length > 0
        && typeof entry.stationId === "string" && entry.stationId.startsWith("station-")
        && Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude)
        && Number.isInteger(entry.x) && Number.isInteger(entry.y)
        && isSchematicCanvasCoordinate(entry.x, entry.y)
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
    || JSON.stringify(snapshot.datasetIds) !== JSON.stringify([DATASET_ID])
    || Number.isNaN(Date.parse(snapshot.capturedAt))
    || snapshot.observedDataUpdatedAt !== OBSERVED_DATA_UPDATED_AT
    || snapshot.rawStationCount !== EXPECTED_STATION_COUNT
    || snapshot.stationCount !== EXPECTED_STATION_COUNT
    || snapshot.quarantinedCount !== EXPECTED_QUARANTINED_COUNT
    || snapshot.rawStationCount !== snapshot.stationCount + snapshot.quarantinedCount
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify(LINE_IDS)
    || JSON.stringify(snapshot.lineStationCounts) !== JSON.stringify(EXPECTED_LINE_STATION_COUNTS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify(FIELDS_PROVIDED)
    || snapshot.topologySourceId !== TOPOLOGY_SOURCE_ID
    || snapshot.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || snapshot.schematicCanvasSourceId !== SCHEMATIC_CANVAS_SOURCE_ID
    || !/^[a-f0-9]{64}$/.test(snapshot.topologyContentSha256 ?? "")
    || !Array.isArray(snapshot.topologyLineages) || snapshot.topologyLineages.length !== 1
    || snapshot.topologyLineages[0]?.sourceId !== TOPOLOGY_SOURCE_ID
    || snapshot.topologyLineages[0]?.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || snapshot.topologyLineages[0]?.contentSha256 !== snapshot.topologyContentSha256
    || snapshot.topologyLineages[0]?.lineId !== LINE_ID
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.scopeSha256 ?? "")
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || !validPositions
    || !validQuarantine
    || JSON.stringify([...positions].sort(comparePositions)) !== JSON.stringify(positions)
    || JSON.stringify([...quarantinedPositions].sort(comparePositions)) !== JSON.stringify(quarantinedPositions)
    || snapshot.positionsSha256 !== sha256(JSON.stringify(positions))) {
    throw new Error("invalid Gwangju route map positions snapshot");
  }
  return snapshot;
}

function indexSchematicCanvas(schematicCanvas) {
  if (!Array.isArray(schematicCanvas) || schematicCanvas.length !== EXPECTED_STATION_COUNT) {
    throw new Error("Gwangju route map schematic canvas fixture must contain 20 stations");
  }
  const byName = new Map();
  for (const entry of schematicCanvas) {
    if (entry?.canvasSourceId !== SCHEMATIC_CANVAS_SOURCE_ID) {
      throw new Error(`Gwangju route map schematic canvasSourceId mismatch: ${entry?.canvasSourceId}`);
    }
    if (typeof entry.stationName !== "string" || entry.stationName.length === 0) {
      throw new Error("Gwangju route map schematic canvas stationName is required");
    }
    if (!isSchematicCanvasCoordinate(entry.x, entry.y)
      || !Number.isInteger(entry.labelDx) || !Number.isInteger(entry.labelDy)
      || !Array.isArray(entry.labelPolygon) || entry.labelPolygon.length !== 4
      || !entry.labelPolygon.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)) {
      throw new Error(`Gwangju route map schematic canvas invalid geometry: ${entry.stationName}`);
    }
    const key = normalizeStationName(entry.stationName);
    if (byName.has(key)) {
      throw new Error(`Gwangju route map schematic canvas duplicate station name: ${key}`);
    }
    byName.set(key, {
      x: entry.x,
      y: entry.y,
      labelDx: entry.labelDx,
      labelDy: entry.labelDy,
      labelPolygon: entry.labelPolygon,
    });
  }
  return byName;
}

function lookupSchematicCanvas(canvasByName, stationName) {
  const normalized = normalizeStationName(stationName);
  const aliased = SCHEMATIC_NAME_ALIASES[normalized] ?? normalized;
  return canvasByName.get(aliased) ?? canvasByName.get(normalized) ?? null;
}

function isSchematicCanvasCoordinate(x, y) {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= CANVAS_X_MIN && x <= CANVAS_X_MAX
    && y >= CANVAS_Y_MIN && y <= CANVAS_Y_MAX;
}

function validateTopologySnapshot(topologySnapshot) {
  if (topologySnapshot?.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.stationCount !== EXPECTED_STATION_COUNT
    || !Array.isArray(topologySnapshot.scope)
    || topologySnapshot.scope.length !== EXPECTED_STATION_COUNT
    || !/^[a-f0-9]{64}$/.test(topologySnapshot.contentSha256 ?? "")
    || topologySnapshot.contentSha256 !== sha256(JSON.stringify({
      scope: topologySnapshot.scope,
      edges: topologySnapshot.edges,
    }))) {
    throw new Error("Gwangju route map positions topology snapshot is invalid");
  }
  const codes = new Set();
  for (const station of topologySnapshot.scope) {
    if (!/^\d{3}$/.test(station.stationCode ?? "")
      || typeof station.stationName !== "string"
      || station.stationName.length === 0
      || codes.has(station.stationCode)) {
      throw new Error(`Gwangju route map positions invalid topology station: ${station?.stationCode}`);
    }
    codes.add(station.stationCode);
  }
  if (STATION_CODES.some((code) => !codes.has(code))) {
    throw new Error("Gwangju route map positions topology station code scope mismatch");
  }
  return topologySnapshot.scope;
}

function stationIdFor(stationName) {
  return `station-${sha1(`광주:${normalizeStationName(stationName)}`).slice(0, 12)}`;
}

function normalizeStationName(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, "").replace(/\([^()]*\)$/, "");
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
      throw new Error("usage: collect-gwangju-route-map-positions.mjs --input <csv> --topology <json> --schematic <json> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args.input || !args.topology || !args.schematic || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-gwangju-route-map-positions.mjs --input <csv> --topology <json> --schematic <json> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runGwangjuRouteMapPositionsCollector(argv) {
  const args = parseArgs(argv);
  const [csvBytes, topologySnapshot, schematicCanvas] = await Promise.all([
    readFile(args.input),
    readFile(args.topology, "utf8").then(JSON.parse),
    readFile(args.schematic, "utf8").then(JSON.parse),
  ]);
  const snapshot = collectGwangjuRouteMapPositions({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Gwangju route map positions snapshot ready: stations=${snapshot.stationCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runGwangjuRouteMapPositionsCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju route map position collection failed");
    process.exitCode = 1;
  }
}
