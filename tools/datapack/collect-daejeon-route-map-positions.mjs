#!/usr/bin/env node
// 대전교통공사 1호선 route_map_positions를 KRIC 공식 FILE(도시철도역사정보)에서 결정론적 snapshot으로 수집한다.
//
// Official FILE (id=32):
// - Portal detail: https://data.kric.go.kr/rips/M_01_01/detail.do?id=32
// - Correct download URL (MUST use):
//   https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=32&operation=1
// - Wrong URL `/rips/download.file?...` returns “존재하지 않는 파일” — do not use
// - Filename: 전체_도시철도역사정보_20260630
// - DNS note: data.kric.go.kr may need --resolve data.kric.go.kr:443:210.90.197.25 when re-fetching
//
// 하이브리드 정렬:
// - 공식 FILE 위경도는 provenance(latitude/longitude)로만 유지한다.
// - admitted route_map_positions x/y/label*는 앱 하이브리드 basemap이 쓰는
//   owner-self-drawn-sma-schematic canvas 좌표 fixture에서 역명(정규화) join으로 결속한다.
// - FILE/topology join은 stationCode=역번호(101–122).
// - canvas join은 정규화 역명(괄호·trailing 역 strip). pack station_code 1–22로는 join하지 않는다.
// - 위경도→canvas 투영(projectLatLon)은 admission에 사용하지 않는다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

import { parseSharedStrings } from "./parse-kric-code-catalog.mjs";

const DATASET_ID = "32";
const DETAIL_URL = "https://data.kric.go.kr/rips/M_01_01/detail.do?id=32";
const DOWNLOAD_URL = "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=32&operation=1";
const SOURCE_ID = "daejeon-transportation-route-map-positions";
const ARTIFACT_KIND = "daejeon-route-map-positions-snapshot";
const LINE_ID = "line-7051a9c2525c";
const LINE_NUMBER = "1";
const LINE_IDS = Object.freeze([LINE_ID]);
const EXPECTED_STATION_COUNT = 22;
const EXPECTED_QUARANTINED_COUNT = 0;
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({ "1": EXPECTED_STATION_COUNT });
const STATION_CODES = Object.freeze(
  Array.from({ length: EXPECTED_STATION_COUNT }, (_, index) => String(101 + index)),
);
// MOLIT/pack 정본 역명(괄호 포함). KRIC 역사명은 괄호 없는 표기라 canvas 정규화 join에 쓴다.
const CANONICAL_STATION_NAMES = Object.freeze({
  "101": "판암(대전대)",
  "102": "신흥",
  "103": "대동(우송대)",
  "104": "대전",
  "105": "중앙로",
  "106": "중구청",
  "107": "서대전네거리",
  "108": "오룡",
  "109": "용문",
  "110": "탄방",
  "111": "시청",
  "112": "정부청사",
  "113": "갈마",
  "114": "월평(한국과학기술원)",
  "115": "갑천",
  "116": "유성온천(충남대.목원대)",
  "117": "구암",
  "118": "현충원(한밭대)",
  "119": "월드컵경기장(노은도매시장)",
  "120": "노은",
  "121": "지족(침신대)",
  "122": "반석(칠성대)",
});
const TOPOLOGY_SOURCE_ID = "daejeon-station-distance-fare";
const TOPOLOGY_SNAPSHOT_ID = "daejeon-station-distance-fare-topology-20260720";
const OBSERVED_DATA_UPDATED_AT = "2026-06-25";
const OFFICIAL_DUPLICATE_LATLON = "OFFICIAL_DUPLICATE_LATLON";
const FIELDS_PROVIDED = Object.freeze(["route_map_position", "route_map_label_polygon"]);
const SCHEMATIC_CANVAS_SOURCE_ID = "owner-self-drawn-sma-schematic";
const EXPECTED_LINE_NUMBER_TOKEN = "S3001";
const EXPECTED_LINE_NAME = "대전 도시철도 1호선";
const OPERATOR_NAME_TOKEN = "대전교통공사";
// 앱 pack schematic canvas 실측 범위(x≈540–1584, y≈240–1560)에 여유를 둔다.
const CANVAS_X_MIN = 200;
const CANVAS_X_MAX = 2000;
const CANVAS_Y_MIN = 200;
const CANVAS_Y_MAX = 1800;
// 대전 도심 공식 위경도 허용 범위(실측 36.31–36.40 / 127.31–127.46에 여유 포함).
const LAT_MIN = 36.25;
const LAT_MAX = 36.45;
const LON_MIN = 127.25;
const LON_MAX = 127.55;

export function parseDaejeonRouteMapPositionsXlsx({
  xlsxBytes,
  topologySnapshot,
  schematicCanvas,
} = {}) {
  if (!(xlsxBytes instanceof Uint8Array) || xlsxBytes.byteLength === 0) {
    throw new Error("Daejeon route map positions XLSX bytes are required");
  }
  validateTopologySnapshot(topologySnapshot);
  const canvasByName = indexSchematicCanvas(schematicCanvas);
  const rows = parseOfficialXlsxRows(xlsxBytes);
  if (rows.length < 2) throw new Error("Daejeon route map positions XLSX has no data rows");
  const header = rows[0];
  const indexes = {
    stationCode: header.indexOf("역번호"),
    stationName: header.indexOf("역사명"),
    lineNumber: header.indexOf("노선번호"),
    lineName: header.indexOf("노선명"),
    latitude: header.indexOf("역위도"),
    longitude: header.indexOf("역경도"),
    operatorName: header.indexOf("운영기관명"),
    observed: header.indexOf("데이터기준일자"),
  };
  for (const [field, index] of Object.entries(indexes)) {
    if (index < 0) throw new Error(`Daejeon route map positions XLSX missing column: ${field}`);
  }

  const seen = new Set();
  const joined = [];
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    const operatorName = String(row[indexes.operatorName] ?? "").trim();
    if (!operatorName.includes(OPERATOR_NAME_TOKEN)) continue;
    if (row.length < header.length) {
      throw new Error(`Daejeon route map positions XLSX column count mismatch at row ${rowIndex + 2}`);
    }
    const stationCode = String(row[indexes.stationCode] ?? "").trim();
    const csvStationName = String(row[indexes.stationName] ?? "").trim();
    if (!/^\d{3}$/.test(stationCode) || csvStationName.length === 0) {
      throw new Error(`Daejeon route map positions invalid station identity at row ${rowIndex + 2}`);
    }
    if (seen.has(stationCode)) {
      throw new Error(`Daejeon route map positions duplicate station code: ${stationCode}`);
    }
    seen.add(stationCode);
    const lineNumberToken = String(row[indexes.lineNumber] ?? "").trim();
    const lineName = String(row[indexes.lineName] ?? "").trim();
    if (lineNumberToken !== EXPECTED_LINE_NUMBER_TOKEN || lineName !== EXPECTED_LINE_NAME) {
      throw new Error(`Daejeon route map positions unexpected line at row ${rowIndex + 2}`);
    }
    const observed = String(row[indexes.observed] ?? "").trim();
    if (observed !== OBSERVED_DATA_UPDATED_AT) {
      throw new Error(`Daejeon route map positions unexpected 데이터기준일자: ${observed || "missing"}`);
    }
    const latitude = Number(String(row[indexes.latitude] ?? "").trim());
    const longitude = Number(String(row[indexes.longitude] ?? "").trim());
    if (!Number.isFinite(latitude) || latitude < LAT_MIN || latitude > LAT_MAX
      || !Number.isFinite(longitude) || longitude < LON_MIN || longitude > LON_MAX) {
      throw new Error(`Daejeon route map positions invalid coordinates: ${stationCode}`);
    }
    if (!topologySnapshot.stationNumbers.includes(stationCode)) {
      throw new Error(`Daejeon route map positions topology join failed: ${stationCode}`);
    }
    const stationName = CANONICAL_STATION_NAMES[stationCode];
    if (!stationName) {
      throw new Error(`Daejeon route map positions canonical station name missing: ${stationCode}`);
    }
    // FILE↔topology는 stationCode=역번호, canvas는 정규화 역명(+trailing 역 strip)으로 결속한다.
    const canvas = lookupSchematicCanvas(canvasByName, stationName)
      ?? lookupSchematicCanvas(canvasByName, csvStationName);
    if (!canvas) {
      throw new Error(`Daejeon route map positions schematic canvas join failed: ${stationName}`);
    }
    const x = Math.round(canvas.x);
    const y = Math.round(canvas.y);
    if (!isSchematicCanvasCoordinate(x, y)) {
      throw new Error(`Daejeon route map schematic canvas out of bounds: ${stationName}`);
    }
    joined.push({
      lineId: LINE_ID,
      line: LINE_NUMBER,
      stationCode,
      stationName,
      stationId: stationIdFor(stationName),
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
    throw new Error(`Daejeon route map positions station count mismatch: ${joined.length}`);
  }
  if (STATION_CODES.some((code) => !seen.has(code))) {
    throw new Error("Daejeon route map positions station code scope mismatch");
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
    throw new Error(`Daejeon route map positions admitted station count mismatch: ${positions.length}`);
  }
  if (quarantinedPositions.length !== EXPECTED_QUARANTINED_COUNT) {
    throw new Error(`Daejeon route map positions quarantined count mismatch: ${quarantinedPositions.length}`);
  }
  return { positions, quarantinedPositions };
}

export function collectDaejeonRouteMapPositions({
  xlsxBytes,
  topologySnapshot,
  schematicCanvas,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const { positions, quarantinedPositions } = parseDaejeonRouteMapPositionsXlsx({
    xlsxBytes,
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
      attribution: "국가철도공단 · 대전교통공사 · 공공데이터포털 이용허락범위 제한 없음",
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
    rawSha256: sha256(Buffer.from(xlsxBytes)),
    positionsSha256: sha256(JSON.stringify(positions)),
    positions,
    quarantinedPositions,
  };
  return validateDaejeonRouteMapPositionsSnapshot(snapshot);
}

export function validateDaejeonRouteMapPositionsSnapshot(snapshot) {
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
        && position.stationId === stationIdFor(position.stationName)
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
    throw new Error("invalid Daejeon route map positions snapshot");
  }
  return snapshot;
}

function parseOfficialXlsxRows(xlsxBytes) {
  const files = unzipXlsx(Buffer.from(xlsxBytes));
  const shared = files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const sheet = files.get("xl/worksheets/sheet1.xml")?.toString("utf8");
  if (!sheet) throw new Error("Daejeon route map positions XLSX missing sheet1");
  // KRIC 역사정보 XLSX는 빈 환승열을 self-closing <c .../>로 쓴다.
  // parse-kric-code-catalog.parseWorksheetRows는 이 형태를 지원하지 않아 열 밀림이 난다.
  return parseWorksheetRowsWithSelfClosing(sheet, parseSharedStrings(shared));
}

function parseWorksheetRowsWithSelfClosing(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (rows.length >= 20_000) throw new Error("Daejeon route map XLSX row limit exceeded");
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
      const attributes = Object.fromEntries([...cellMatch[1].matchAll(/(?:^|[ \t\r\n])([:\w-]+)[ \t\r\n]*=[ \t\r\n]*"([^"]*)"/g)]
        .map(([, name, value]) => [name, decodeXml(value)]));
      const column = columnIndex(attributes.r);
      if (column >= 100) throw new Error("Daejeon route map XLSX column limit exceeded");
      const body = cellMatch[2] ?? "";
      row[column] = boundedCell(worksheetCellValue(attributes, body, sharedStrings));
    }
    while (row.length > 0 && row.at(-1) === undefined) row.pop();
    rows.push(Array.from({ length: row.length }, (_, index) => row[index] ?? ""));
  }
  return rows;
}

function worksheetCellValue(attributes, body, sharedStrings) {
  if (attributes.t === "inlineStr") {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map(([, text]) => decodeXml(text))
      .join("");
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? "";
  if (attributes.t !== "s") return decodeXml(raw);
  const normalizedIndex = raw.trim();
  const index = Number(normalizedIndex);
  if (!/^\d+$/.test(normalizedIndex) || !Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
    throw new Error("Daejeon route map XLSX shared string index is invalid");
  }
  return sharedStrings[index];
}

function columnIndex(reference) {
  const letters = /^([A-Z]{1,3})\d+$/i.exec(reference ?? "")?.[1]?.toUpperCase();
  if (!letters) throw new Error("Daejeon route map XLSX cell reference is invalid");
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.codePointAt(0) - 64;
  return value - 1;
}

function boundedCell(value) {
  const normalized = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
  if (normalized.length > 2_048) throw new Error("Daejeon route map XLSX cell limit exceeded");
  return normalized;
}

function decodeXml(value) {
  return String(value).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function unzipXlsx(buffer) {
  const out = new Map();
  let offset = 0;
  while (offset + 30 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const flags = buffer.readUInt16LE(offset + 6);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    const start = offset + 30 + nameLen + extraLen;
    if ((flags & 0x8) !== 0 && compSize === 0) {
      throw new Error(`xlsx entry uses data descriptor unsupported: ${name}`);
    }
    const compressed = buffer.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    out.set(name, data);
    offset = start + compSize;
  }
  if (!out.has("xl/sharedStrings.xml") || !out.has("xl/worksheets/sheet1.xml")) {
    throw new Error("failed to unzip xlsx local entries");
  }
  return out;
}

function indexSchematicCanvas(schematicCanvas) {
  if (!Array.isArray(schematicCanvas) || schematicCanvas.length !== EXPECTED_STATION_COUNT) {
    throw new Error("Daejeon route map schematic canvas fixture must contain 22 stations");
  }
  const byName = new Map();
  for (const entry of schematicCanvas) {
    if (entry?.canvasSourceId !== SCHEMATIC_CANVAS_SOURCE_ID) {
      throw new Error(`Daejeon route map schematic canvasSourceId mismatch: ${entry?.canvasSourceId}`);
    }
    if (typeof entry.stationName !== "string" || entry.stationName.length === 0) {
      throw new Error("Daejeon route map schematic canvas stationName is required");
    }
    if (!isSchematicCanvasCoordinate(entry.x, entry.y)
      || !Number.isInteger(entry.labelDx) || !Number.isInteger(entry.labelDy)
      || !Array.isArray(entry.labelPolygon) || entry.labelPolygon.length !== 4
      || !entry.labelPolygon.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)) {
      throw new Error(`Daejeon route map schematic canvas invalid geometry: ${entry.stationName}`);
    }
    const key = normalizeStationName(entry.stationName);
    if (byName.has(key)) {
      throw new Error(`Daejeon route map schematic canvas duplicate station name: ${key}`);
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
  return canvasByName.get(normalized) ?? null;
}

function isSchematicCanvasCoordinate(x, y) {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= CANVAS_X_MIN && x <= CANVAS_X_MAX
    && y >= CANVAS_Y_MIN && y <= CANVAS_Y_MAX;
}

function validateTopologySnapshot(topologySnapshot) {
  if (topologySnapshot?.sourceId !== TOPOLOGY_SOURCE_ID
    || !Array.isArray(topologySnapshot.stationNumbers)
    || topologySnapshot.stationNumbers.length !== EXPECTED_STATION_COUNT
    || JSON.stringify(topologySnapshot.stationNumbers) !== JSON.stringify([...STATION_CODES])
    || !Array.isArray(topologySnapshot.rows)
    || !/^[a-f0-9]{64}$/.test(topologySnapshot.contentSha256 ?? "")
    || topologySnapshot.contentSha256 !== sha256(JSON.stringify(topologySnapshot.rows))) {
    throw new Error("Daejeon route map positions topology snapshot is invalid");
  }
}

function stationIdFor(stationName) {
  // pack/MOLIT stationId는 괄호 포함 정식 역명을 해시한다(정규화 strip 금지).
  return `station-${sha1(`대전:${String(stationName).normalize("NFKC").replace(/\s+/g, "")}`).slice(0, 12)}`;
}

function normalizeStationName(value) {
  return String(value).normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/\([^()]*\)$/, "")
    .replace(/역$/, "");
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
      throw new Error("usage: collect-daejeon-route-map-positions.mjs --input <xlsx> --topology <json> --schematic <json> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args.input || !args.topology || !args.schematic || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-daejeon-route-map-positions.mjs --input <xlsx> --topology <json> --schematic <json> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runDaejeonRouteMapPositionsCollector(argv) {
  const args = parseArgs(argv);
  const [xlsxBytes, topologySnapshot, schematicCanvas] = await Promise.all([
    readFile(args.input),
    readFile(args.topology, "utf8").then(JSON.parse),
    readFile(args.schematic, "utf8").then(JSON.parse),
  ]);
  const snapshot = collectDaejeonRouteMapPositions({
    xlsxBytes,
    topologySnapshot,
    schematicCanvas,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Daejeon route map positions snapshot ready: stations=${snapshot.stationCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDaejeonRouteMapPositionsCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daejeon route map position collection failed");
    process.exitCode = 1;
  }
}
