#!/usr/bin/env node
// 국가철도공단 data.go.kr 15041335 (수도권 9호선 역위치 CSV) 1단계(개화~신논현)를
// 결정론적 snapshot으로 수집한다. API key·포털 활용신청 없이 FILE CSV만 사용한다.
// fixture CSV는 공식 다운로드 CRLF를 LF로 정규화한 바이트를 고정한다(git diff --check).
//
// CSV는 전 구간 38행을 포함하나, 이번 admission은 1단계 25역(FILE codes 901–925)만 대상이다.
// 2·3단계 13역(언주~중앙보훈병원)은 무시한다(에러 아님). 예상 외 역명/1단계 누락은 fail-closed.
//
// 하이브리드 정렬:
// - 공식 FILE 위경도는 provenance(latitude/longitude)로만 유지한다.
// - admitted route_map_positions x/y/label*는 앱 하이브리드 basemap이 쓰는
//   owner-self-drawn-sma-schematic canvas 좌표 fixture에서 역명(정규화) join으로 결속한다.
// - FILE stationCode(역번호)=901–925는 canonical map으로 부여한다(CSV에 역번호 없음).
//   pack station_code 1–25와는 역명 정규화로만 결속하며, 위경도 투영(projectLatLon)은 금지한다.
// - topology(capital-route-topology)는 정규화 역명 존재 검증에만 쓴다(stationCode 없음).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeOfficialCsv } from "./collect-daegu-datapack-sources.mjs";

const DATASET_ID = "15041335";
const DETAIL_URL = `https://www.data.go.kr/data/${DATASET_ID}/fileData.do`;
const DOWNLOAD_URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003521195&fileDetailSn=1&insertDataPrcus=N";
const SOURCE_ID = "kric-seoul-metro-line9-1-route-map-positions";
const ARTIFACT_KIND = "seoul9-phase1-route-map-positions-snapshot";
const LINE_ID = "line-f0e747248a31";
const LINE_NUMBER = "9";
const LINE_NAME_TOKEN = "9호선";
const OPERATOR_NAME_TOKEN = "서울시메트로9호선주식회사";
const LINE_IDS = Object.freeze([LINE_ID]);
const EXPECTED_STATION_COUNT = 25;
const EXPECTED_QUARANTINED_COUNT = 0;
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({ "9": EXPECTED_STATION_COUNT });
const STATION_CODES = Object.freeze(
  Array.from({ length: EXPECTED_STATION_COUNT }, (_, index) => String(901 + index)),
);
const CANONICAL_STATION_NAMES = Object.freeze({
  "901": "개화",
  "902": "김포공항",
  "903": "공항시장",
  "904": "신방화",
  "905": "마곡나루",
  "906": "양천향교",
  "907": "가양",
  "908": "증미",
  "909": "등촌",
  "910": "염창",
  "911": "신목동",
  "912": "선유도",
  "913": "당산",
  "914": "국회의사당",
  "915": "여의도",
  "916": "샛강",
  "917": "노량진",
  "918": "노들",
  "919": "흑석",
  "920": "동작",
  "921": "구반포",
  "922": "신반포",
  "923": "고속터미널",
  "924": "사평",
  "925": "신논현",
});

const PHASE23_STATION_NAMES = Object.freeze([
  "언주",
  "선정릉",
  "삼성중앙",
  "봉은사",
  "종합운동장",
  "삼전",
  "석촌고분",
  "석촌",
  "송파나루",
  "한성백제",
  "올림픽공원",
  "둔촌오륜",
  "중앙보훈병원",
]);
const PHASE23_NORMALIZED = Object.freeze(new Set(
  PHASE23_STATION_NAMES.map((name) => normalizeStationName(name)),
));
const PHASE1_BY_NORMALIZED = Object.freeze(new Map(
  Object.entries(CANONICAL_STATION_NAMES).map(([code, name]) => [normalizeStationName(name), code]),
));
const TOPOLOGY_SOURCE_ID = "capital-route-topology";
const TOPOLOGY_SNAPSHOT_ID = "capital-route-topology-20260724";
const OBSERVED_DATA_UPDATED_AT = "2025-06-30";
const OFFICIAL_DUPLICATE_LATLON = "OFFICIAL_DUPLICATE_LATLON";
const FIELDS_PROVIDED = Object.freeze(["route_map_position", "route_map_label_polygon"]);
const SCHEMATIC_CANVAS_SOURCE_ID = "owner-self-drawn-sma-schematic";
// 수도권 9호선 1단계 schematic canvas 실측 범위(x≈694–2219, y≈995–1863)에 여유를 둔다.
// 위경도 투영(~10^4) 좌표가 이 범위에 들어오면 admission을 거부한다.
const CANVAS_X_MIN = 600;
const CANVAS_X_MAX = 2300;
const CANVAS_Y_MIN = 900;
const CANVAS_Y_MAX = 2000;
// 개화~신논현 공식 위경도 허용 범위.
const LAT_MIN = 37.45;
const LAT_MAX = 37.65;
const LON_MIN = 126.70;
const LON_MAX = 127.10;

export function parseSeoul9Phase1RouteMapPositionsCsv({
  csvBytes,
  topologySnapshot,
  schematicCanvas,
} = {}) {
  if (!(csvBytes instanceof Uint8Array) || csvBytes.byteLength === 0) {
    throw new Error("Seoul9 phase1 route map positions CSV bytes are required");
  }
  validateTopologySnapshot(topologySnapshot);
  const canvasByName = indexSchematicCanvas(schematicCanvas);
  const rows = parseCsv(decodeOfficialCsv(csvBytes));
  if (rows.length < 2) throw new Error("Seoul9 phase1 route map positions CSV has no data rows");
  const header = rows[0];
  const indexes = {
    operator: header.indexOf("철도운영기관"),
    lineName: header.indexOf("선명"),
    stationName: header.indexOf("역명"),
    longitude: header.indexOf("경도"),
    latitude: header.indexOf("위도"),
  };
  for (const [field, index] of Object.entries(indexes)) {
    if (index < 0) throw new Error(`Seoul9 phase1 route map positions CSV missing column: ${field}`);
  }

  const seen = new Set();
  const joined = [];
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(
        `Seoul9 phase1 route map positions CSV column count mismatch at row ${rowIndex + 2}`,
      );
    }
    const operatorToken = String(row[indexes.operator] ?? "").trim();
    if (operatorToken !== OPERATOR_NAME_TOKEN) {
      throw new Error(`Seoul9 phase1 route map positions unexpected operator at row ${rowIndex + 2}`);
    }
    const lineNameToken = String(row[indexes.lineName] ?? "").trim();
    if (lineNameToken !== LINE_NAME_TOKEN) {
      throw new Error(`Seoul9 phase1 route map positions unexpected line at row ${rowIndex + 2}`);
    }
    const csvStationName = String(row[indexes.stationName] ?? "").trim();
    if (csvStationName.length === 0) {
      throw new Error(`Seoul9 phase1 route map positions invalid station identity at row ${rowIndex + 2}`);
    }
    const normalizedName = normalizeStationName(csvStationName);
    if (PHASE23_NORMALIZED.has(normalizedName)) {
      continue;
    }
    const stationCode = PHASE1_BY_NORMALIZED.get(normalizedName);
    if (!stationCode) {
      throw new Error(`Seoul9 phase1 route map positions unexpected station: ${csvStationName}`);
    }
    if (seen.has(stationCode)) {
      throw new Error(`Seoul9 phase1 route map positions duplicate station code: ${stationCode}`);
    }
    seen.add(stationCode);
    const latitude = Number(String(row[indexes.latitude] ?? "").trim());
    const longitude = Number(String(row[indexes.longitude] ?? "").trim());
    if (!Number.isFinite(latitude) || latitude < LAT_MIN || latitude > LAT_MAX
      || !Number.isFinite(longitude) || longitude < LON_MIN || longitude > LON_MAX) {
      throw new Error(`Seoul9 phase1 route map positions invalid coordinates: ${stationCode}`);
    }
    const stationName = CANONICAL_STATION_NAMES[stationCode];
    if (normalizeStationName(csvStationName) !== normalizeStationName(stationName)) {
      throw new Error(`Seoul9 phase1 route map positions station name mismatch: ${stationCode}`);
    }
    const canvas = lookupSchematicCanvas(canvasByName, stationName)
      ?? lookupSchematicCanvas(canvasByName, csvStationName);
    if (!canvas) {
      throw new Error(`Seoul9 phase1 route map positions schematic canvas join failed: ${stationName}`);
    }
    if (canvas.stationCode != null && String(canvas.stationCode) !== stationCode) {
      throw new Error(`Seoul9 phase1 route map positions schematic stationCode mismatch: ${stationName}`);
    }
    const x = Math.round(canvas.x);
    const y = Math.round(canvas.y);
    if (!isSchematicCanvasCoordinate(x, y)) {
      throw new Error(`Seoul9 phase1 route map schematic canvas out of bounds: ${stationName}`);
    }
    joined.push({
      lineId: LINE_ID,
      line: LINE_NUMBER,
      stationCode,
      stationName,
      stationId: canvas.stationId,
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
    throw new Error(`Seoul9 phase1 route map positions station count mismatch: ${joined.length}`);
  }
  if (STATION_CODES.some((code) => !seen.has(code))) {
    throw new Error("Seoul9 phase1 route map positions station code scope mismatch");
  }

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
    throw new Error(`Seoul9 phase1 route map positions admitted station count mismatch: ${positions.length}`);
  }
  if (quarantinedPositions.length !== EXPECTED_QUARANTINED_COUNT) {
    throw new Error(`Seoul9 phase1 route map positions quarantined count mismatch: ${quarantinedPositions.length}`);
  }
  return { positions, quarantinedPositions };
}

export function collectSeoul9Phase1RouteMapPositions({
  csvBytes,
  topologySnapshot,
  schematicCanvas,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const { positions, quarantinedPositions } = parseSeoul9Phase1RouteMapPositionsCsv({
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
    downloadUrl: DOWNLOAD_URL,
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
      attribution: "국가철도공단 · 서울시메트로9호선 · 공공데이터포털 이용허락범위 제한 없음",
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
  return validateSeoul9Phase1RouteMapPositionsSnapshot(snapshot);
}

export function validateSeoul9Phase1RouteMapPositionsSnapshot(snapshot) {
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
        && CANONICAL_STATION_NAMES[position.stationCode] === position.stationName
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
    || snapshot.downloadUrl !== DOWNLOAD_URL
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
    throw new Error("invalid Seoul9 phase1 route map positions snapshot");
  }
  return snapshot;
}

function indexSchematicCanvas(schematicCanvas) {
  const resolved = resolveSchematicCanvas(schematicCanvas);
  const byName = new Map();
  for (const entry of resolved.stations) {
    if (typeof entry.stationName !== "string" || entry.stationName.length === 0) {
      throw new Error("Seoul9 phase1 route map schematic canvas stationName is required");
    }
    if (typeof entry.stationId !== "string" || !entry.stationId.startsWith("station-")) {
      throw new Error(`Seoul9 phase1 route map schematic canvas stationId is required: ${entry.stationName}`);
    }
    if (!isSchematicCanvasCoordinate(entry.x, entry.y)
      || !Number.isInteger(entry.labelDx) || !Number.isInteger(entry.labelDy)
      || !Array.isArray(entry.labelPolygon) || entry.labelPolygon.length !== 4
      || !entry.labelPolygon.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)) {
      throw new Error(`Seoul9 phase1 route map schematic canvas invalid geometry: ${entry.stationName}`);
    }
    const key = normalizeStationName(entry.stationName);
    if (byName.has(key)) {
      throw new Error(`Seoul9 phase1 route map schematic canvas duplicate station name: ${key}`);
    }
    byName.set(key, {
      stationCode: entry.stationCode == null ? null : String(entry.stationCode),
      stationId: entry.stationId,
      x: entry.x,
      y: entry.y,
      labelDx: entry.labelDx,
      labelDy: entry.labelDy,
      labelPolygon: entry.labelPolygon,
    });
  }
  return byName;
}

function resolveSchematicCanvas(schematicCanvas) {
  if (Array.isArray(schematicCanvas)) {
    if (schematicCanvas.length !== EXPECTED_STATION_COUNT) {
      throw new Error("Seoul9 phase1 route map schematic canvas fixture must contain 25 stations");
    }
    if (schematicCanvas.some((entry) => entry?.canvasSourceId !== SCHEMATIC_CANVAS_SOURCE_ID)) {
      throw new Error("Seoul9 phase1 route map schematic canvasSourceId mismatch");
    }
    return { sourceId: SCHEMATIC_CANVAS_SOURCE_ID, stations: schematicCanvas };
  }
  if (schematicCanvas?.sourceId !== SCHEMATIC_CANVAS_SOURCE_ID
    || schematicCanvas.lineId !== LINE_ID
    || !Array.isArray(schematicCanvas.stations)
    || schematicCanvas.stations.length !== EXPECTED_STATION_COUNT) {
    throw new Error("Seoul9 phase1 route map schematic canvas fixture must contain 25 stations");
  }
  return schematicCanvas;
}

function lookupSchematicCanvas(canvasByName, stationName) {
  return canvasByName.get(normalizeStationName(stationName)) ?? null;
}

function isSchematicCanvasCoordinate(x, y) {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= CANVAS_X_MIN && x <= CANVAS_X_MAX
    && y >= CANVAS_Y_MIN && y <= CANVAS_Y_MAX;
}

function validateTopologySnapshot(topologySnapshot) {
  if (topologySnapshot?.sourceId !== TOPOLOGY_SOURCE_ID
    || !/^[a-f0-9]{64}$/.test(topologySnapshot.contentSha256 ?? "")
    || !Array.isArray(topologySnapshot.lines)) {
    throw new Error("Seoul9 phase1 route map positions topology snapshot is invalid");
  }
  const line = topologySnapshot.lines.find(({ lineId }) => lineId === LINE_ID);
  if (!line || !Array.isArray(line.scope) || line.stationCount !== 38) {
    throw new Error("Seoul9 phase1 route map positions topology line scope is invalid");
  }
  const expectedLineHash = sha256(JSON.stringify({ scope: line.scope, edges: line.edges }));
  if (line.contentSha256 !== expectedLineHash) {
    throw new Error("Seoul9 phase1 route map positions topology line contentSha256 mismatch");
  }
  const scopeNames = new Set(line.scope.map(({ stationName }) => normalizeStationName(stationName)));
  for (const stationName of Object.values(CANONICAL_STATION_NAMES)) {
    if (!scopeNames.has(normalizeStationName(stationName))) {
      throw new Error(`Seoul9 phase1 route map positions topology name missing: ${stationName}`);
    }
  }
}

function normalizeStationName(value) {
  return String(value).normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/\([^()]*\)$/, "")
    .replace(/역$/, "");
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

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) {
      throw new Error("usage: collect-seoul9-phase1-route-map-positions.mjs --input <csv> --topology <json> --schematic <json> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args.input || !args.topology || !args.schematic || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-seoul9-phase1-route-map-positions.mjs --input <csv> --topology <json> --schematic <json> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runSeoul9Phase1RouteMapPositionsCollector(argv) {
  const args = parseArgs(argv);
  const [csvBytes, topologySnapshot, schematicCanvas] = await Promise.all([
    readFile(args.input),
    readFile(args.topology, "utf8").then(JSON.parse),
    readFile(args.schematic, "utf8").then(JSON.parse),
  ]);
  const snapshot = collectSeoul9Phase1RouteMapPositions({
    csvBytes,
    topologySnapshot,
    schematicCanvas,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Seoul9 phase1 route map positions snapshot ready: stations=${snapshot.stationCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runSeoul9Phase1RouteMapPositionsCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Seoul9 phase1 route map position collection failed");
    process.exitCode = 1;
  }
}
