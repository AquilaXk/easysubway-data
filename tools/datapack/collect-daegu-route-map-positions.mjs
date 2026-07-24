#!/usr/bin/env node
// 대구교통공사 1·2·3호선 역별 출구별 위치정보(공식 FILE CSV)를 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터(15133918/15133920/15133922)만 사용한다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { DAEGU_LINES, normalizedStationName } from "./collect-daegu-datapack-sources.mjs";

const SOURCE_ID = "daegu-transportation-route-map-positions";
const ARTIFACT_KIND = "daegu-route-map-positions-snapshot";
const OFFICIAL_DUPLICATE_LATLON = "OFFICIAL_DUPLICATE_LATLON";
const OBSERVED_DATA_UPDATED_AT = "2024-10-14";
const FIELDS_PROVIDED = Object.freeze(["route_map_position", "route_map_label_polygon"]);
// 출구 CSV 구명칭 → topology 정본 역명(정규화 전 치환).
const CSV_STATION_NAME_ALIASES = Object.freeze({
  수성운동장: "수성구민운동장",
  어린이회관: "어린이세상",
});
const DATASETS = Object.freeze([
  {
    lineNumber: "1",
    lineId: "line-5b8d9b05e7e6",
    datasetId: "15133918",
    detailUrl: "https://www.data.go.kr/data/15133918/fileData.do",
    expectedExitRows: 165,
    expectedAggregatedStations: 32,
  },
  {
    lineNumber: "2",
    lineId: "line-e2938a4cc492",
    datasetId: "15133920",
    detailUrl: "https://www.data.go.kr/data/15133920/fileData.do",
    expectedExitRows: 185,
    expectedAggregatedStations: 29,
  },
  {
    lineNumber: "3",
    lineId: "line-0ffaa95b1b5d",
    datasetId: "15133922",
    detailUrl: "https://www.data.go.kr/data/15133922/fileData.do",
    expectedExitRows: 79,
    expectedAggregatedStations: 30,
  },
]);
const LINE_IDS = Object.freeze(DATASETS.map(({ lineId }) => lineId));
const EXPECTED_EXIT_ROW_COUNT = 429;
const EXPECTED_RAW_STATION_COUNT = 91;
const EXPECTED_QUARANTINED_COUNT = 0;
const EXPECTED_STATION_COUNT = 91;
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({ "1": 32, "2": 29, "3": 30 });
const EXPECTED_RAW_LINE_STATION_COUNTS = Object.freeze({ "1": 32, "2": 29, "3": 30 });
const TOPOLOGY_GAPS = Object.freeze([
  { lineId: "line-5b8d9b05e7e6", stationCode: "147", stationName: "대구한의대병원" },
  { lineId: "line-5b8d9b05e7e6", stationCode: "148", stationName: "부호" },
  { lineId: "line-5b8d9b05e7e6", stationCode: "149", stationName: "하양" },
]);

export function parseDaeguRouteMapPositionsCsvs({ csvByDatasetId, topologySnapshots }) {
  const exitRows = [];
  for (const dataset of DATASETS) {
    const csvBytes = csvByDatasetId[dataset.datasetId];
    if (!(csvBytes instanceof Uint8Array) || csvBytes.byteLength === 0) {
      throw new Error(`Daegu route map positions CSV missing: ${dataset.datasetId}`);
    }
    const rows = parseCsv(decodeOfficialCsv(csvBytes));
    if (rows.length < 2) throw new Error(`Daegu route map positions CSV empty: ${dataset.datasetId}`);
    const header = rows[0];
    const indexes = {
      line: header.indexOf("호선"),
      stationName: header.indexOf("역명"),
      exitNumber: header.indexOf("출구번호"),
      latitude: header.indexOf("위도"),
      longitude: header.indexOf("경도"),
    };
    for (const [field, index] of Object.entries(indexes)) {
      if (index < 0) throw new Error(`Daegu route map positions CSV missing column: ${field}`);
    }
    let exitCount = 0;
    for (const [rowIndex, row] of rows.slice(1).entries()) {
      if (row.length !== header.length) {
        throw new Error(`Daegu route map positions CSV column count mismatch at row ${rowIndex + 2}`);
      }
      const lineNumber = String(row[indexes.line] ?? "").trim();
      if (lineNumber !== dataset.lineNumber) {
        throw new Error(`Daegu route map positions unexpected line ${lineNumber} in ${dataset.datasetId}`);
      }
      const rawStationName = String(row[indexes.stationName] ?? "").trim();
      const stationName = CSV_STATION_NAME_ALIASES[rawStationName] ?? rawStationName;
      const exitNumber = String(row[indexes.exitNumber] ?? "").trim();
      const latitude = Number(String(row[indexes.latitude] ?? "").trim());
      const longitude = Number(String(row[indexes.longitude] ?? "").trim());
      if (!stationName || !exitNumber) {
        throw new Error(`Daegu route map positions invalid exit identity at row ${rowIndex + 2}`);
      }
      if (!Number.isFinite(latitude) || latitude < 35.7 || latitude > 36.1
        || !Number.isFinite(longitude) || longitude < 128.3 || longitude > 128.9) {
        throw new Error(`Daegu route map positions invalid coordinates: ${stationName}:${exitNumber}`);
      }
      exitRows.push({
        lineNumber,
        lineId: dataset.lineId,
        datasetId: dataset.datasetId,
        stationName,
        exitNumber,
        latitude,
        longitude,
      });
      exitCount += 1;
    }
    if (exitCount !== dataset.expectedExitRows) {
      throw new Error(`Daegu route map positions exit row count mismatch: ${dataset.datasetId}`);
    }
  }
  if (exitRows.length !== EXPECTED_EXIT_ROW_COUNT) {
    throw new Error(`Daegu route map positions total exit row count mismatch: ${exitRows.length}`);
  }

  // 출구 행 → 역 대표 좌표: 출구번호 안정 정렬 후 lat/lon 각각의 중앙값(짝수면 두 중앙값 평균).
  const grouped = new Map();
  for (const exit of exitRows) {
    const key = `${exit.lineId}\0${exit.stationName}`;
    const group = grouped.get(key);
    if (group) group.push(exit);
    else grouped.set(key, [exit]);
  }
  const aggregated = [];
  for (const group of grouped.values()) {
    group.sort((left, right) => left.exitNumber.localeCompare(right.exitNumber, "en")
      || left.latitude - right.latitude
      || left.longitude - right.longitude);
    const latitude = median(group.map(({ latitude }) => latitude));
    const longitude = median(group.map(({ longitude }) => longitude));
    aggregated.push({
      lineId: group[0].lineId,
      line: group[0].lineNumber,
      datasetId: group[0].datasetId,
      stationName: group[0].stationName,
      exitCount: group.length,
      latitude,
      longitude,
    });
  }
  for (const dataset of DATASETS) {
    const count = aggregated.filter((row) => row.line === dataset.lineNumber).length;
    if (count !== dataset.expectedAggregatedStations) {
      throw new Error(`Daegu route map positions aggregated station count mismatch: line ${dataset.lineNumber}`);
    }
  }

  const joined = [];
  for (const dataset of DATASETS) {
    const topology = topologySnapshots?.[Number(dataset.lineNumber)] ?? topologySnapshots?.[dataset.lineNumber];
    if (topology?.sourceId !== `daegu-line${dataset.lineNumber}-route-topology`
      || topology.lineId !== dataset.lineId
      || !Array.isArray(topology.scope)) {
      throw new Error(`Daegu route map positions topology missing: ${dataset.lineNumber}`);
    }
    const byNormalized = new Map(
      topology.scope.map((station) => [normalizedStationName(station.stationName), station]),
    );
    const lineStations = aggregated.filter((row) => row.lineId === dataset.lineId);
    for (const row of lineStations) {
      const station = byNormalized.get(normalizedStationName(row.stationName));
      if (!station) {
        throw new Error(`Daegu route map positions topology join failed: ${row.stationName}`);
      }
      const { x, y } = projectLatLon(row.latitude, row.longitude);
      const label = labelGeometry(station.stationName, x, y);
      joined.push({
        lineId: dataset.lineId,
        line: dataset.lineNumber,
        stationCode: station.stationCode,
        stationName: station.stationName,
        stationId: stationIdFor(station.stationName),
        latitude: row.latitude,
        longitude: row.longitude,
        exitCount: row.exitCount,
        x,
        y,
        labelDx: label.labelDx,
        labelDy: label.labelDy,
        labelPolygon: label.labelPolygon,
      });
    }
  }
  if (joined.length !== EXPECTED_RAW_STATION_COUNT) {
    throw new Error(`Daegu route map positions joined station count mismatch: ${joined.length}`);
  }
  for (const [line, expected] of Object.entries(EXPECTED_RAW_LINE_STATION_COUNTS)) {
    const count = joined.filter((row) => row.line === line).length;
    if (count !== expected) {
      throw new Error(`Daegu route map positions raw line ${line} station count mismatch: ${count}`);
    }
  }
  for (const gap of TOPOLOGY_GAPS) {
    if (joined.some((row) => row.lineId === gap.lineId && row.stationCode === gap.stationCode)) {
      throw new Error(`Daegu route map positions unexpected topology gap admission: ${gap.stationCode}`);
    }
  }

  // 환승역은 동일 stationId·동일 위경도를 호선별 역명으로 공유할 수 있다.
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
    throw new Error(`Daegu route map positions admitted station count mismatch: ${positions.length}`);
  }
  if (quarantinedPositions.length !== EXPECTED_QUARANTINED_COUNT) {
    throw new Error(`Daegu route map positions quarantined count mismatch: ${quarantinedPositions.length}`);
  }
  for (const [line, expected] of Object.entries(EXPECTED_LINE_STATION_COUNTS)) {
    const count = positions.filter((row) => row.line === line).length;
    if (count !== expected) {
      throw new Error(`Daegu route map positions admitted line ${line} station count mismatch: ${count}`);
    }
  }
  return { positions, quarantinedPositions, exitRowCount: exitRows.length };
}

export function collectDaeguRouteMapPositions({
  csvByDatasetId,
  topologySnapshots,
  now = new Date(),
} = {}) {
  const capturedAt = validDate(now, "now");
  const { positions, quarantinedPositions, exitRowCount } = parseDaeguRouteMapPositionsCsvs({
    csvByDatasetId,
    topologySnapshots,
  });
  const rawParts = DATASETS.map(({ datasetId }) => Buffer.from(csvByDatasetId[datasetId]));
  const scope = positions.map(({ lineId, stationCode, stationName, stationId }) => ({
    lineId,
    stationCode,
    stationName,
    stationId,
  }));
  const topologyLineages = DAEGU_LINES.map((line) => {
    const topology = topologySnapshots[line.lineNumber];
    return {
      sourceId: topology.sourceId,
      snapshotId: `${topology.sourceId}-20260721`,
      contentSha256: topology.contentSha256,
      lineId: line.lineId,
    };
  });
  const snapshot = {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    detailUrl: DATASETS[0].detailUrl,
    datasetIds: DATASETS.map(({ datasetId }) => datasetId),
    datasetUrls: DATASETS.map(({ detailUrl }) => detailUrl),
    endpoint: DATASETS.map(({ detailUrl }) => detailUrl).join(" "),
    capturedAt: capturedAt.toISOString(),
    observedDataUpdatedAt: OBSERVED_DATA_UPDATED_AT,
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    exitRowCount,
    rawStationCount: EXPECTED_RAW_STATION_COUNT,
    stationCount: positions.length,
    quarantinedCount: quarantinedPositions.length,
    topologyGapCount: TOPOLOGY_GAPS.length,
    topologyGaps: [...TOPOLOGY_GAPS],
    lineIds: [...LINE_IDS],
    lineStationCounts: { ...EXPECTED_LINE_STATION_COUNTS },
    fieldsProvided: [...FIELDS_PROVIDED],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: "대구교통공사 · 공공데이터포털 이용허락범위 제한 없음",
      redistributionAllowed: true,
      evidenceUrl: DATASETS[0].detailUrl,
    },
    topologyLineages,
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(Buffer.concat(rawParts)),
    positionsSha256: sha256(JSON.stringify(positions)),
    positions,
    quarantinedPositions,
  };
  return validateDaeguRouteMapPositionsSnapshot(snapshot);
}

export function validateDaeguRouteMapPositionsSnapshot(snapshot) {
  const positions = snapshot?.positions;
  const quarantinedPositions = snapshot?.quarantinedPositions;
  const keys = new Set();
  const latLonOwners = new Map();
  const canvasOwners = new Map();
  const stationIdCoords = new Map();
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
      const expectedCoords = stationIdCoords.get(owner);
      const sharedStationCoords = expectedCoords == null
        || (expectedCoords.latitude === position.latitude
          && expectedCoords.longitude === position.longitude
          && expectedCoords.x === position.x
          && expectedCoords.y === position.y);
      const dataset = DATASETS.find(({ lineNumber }) => lineNumber === position.line);
      const valid = dataset?.lineId === position.lineId
        && /^\d{3}$/.test(position.stationCode)
        && typeof position.stationName === "string" && position.stationName.length > 0
        && typeof position.stationId === "string" && position.stationId.startsWith("station-")
        && [position.x, position.y, position.labelDx, position.labelDy].every(Number.isInteger)
        && position.x >= 0 && position.y >= 0
        && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
        && Number.isInteger(position.exitCount) && position.exitCount > 0
        && Array.isArray(position.labelPolygon) && position.labelPolygon.length === 4
        && position.labelPolygon.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0)
        && !keys.has(key)
        && uniqueCoords
        && sharedStationCoords;
      keys.add(key);
      latLonOwners.set(latLonKey, owner);
      canvasOwners.set(canvasKey, owner);
      if (expectedCoords == null) {
        stationIdCoords.set(owner, {
          latitude: position.latitude,
          longitude: position.longitude,
          x: position.x,
          y: position.y,
        });
      }
      return valid;
    });
  const quarantinedKeys = new Set();
  const validQuarantine = Array.isArray(quarantinedPositions)
    && quarantinedPositions.length === EXPECTED_QUARANTINED_COUNT
    && quarantinedPositions.every((entry) => {
      const key = `${entry.lineId}:${entry.stationCode}`;
      const dataset = DATASETS.find(({ lineNumber }) => lineNumber === entry.line);
      const valid = dataset?.lineId === entry.lineId
        && /^\d{3}$/.test(entry.stationCode)
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
    || snapshot.exitRowCount !== EXPECTED_EXIT_ROW_COUNT
    || Number.isNaN(Date.parse(snapshot.capturedAt))
    || snapshot.observedDataUpdatedAt !== OBSERVED_DATA_UPDATED_AT
    || snapshot.rawStationCount !== EXPECTED_RAW_STATION_COUNT
    || snapshot.stationCount !== EXPECTED_STATION_COUNT
    || snapshot.quarantinedCount !== EXPECTED_QUARANTINED_COUNT
    || snapshot.rawStationCount !== snapshot.stationCount + snapshot.quarantinedCount
    || snapshot.topologyGapCount !== TOPOLOGY_GAPS.length
    || JSON.stringify(snapshot.topologyGaps) !== JSON.stringify(TOPOLOGY_GAPS)
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify(LINE_IDS)
    || JSON.stringify(snapshot.lineStationCounts) !== JSON.stringify(EXPECTED_LINE_STATION_COUNTS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify(FIELDS_PROVIDED)
    || JSON.stringify(snapshot.datasetIds) !== JSON.stringify(DATASETS.map(({ datasetId }) => datasetId))
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.scopeSha256 ?? "")
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || !validPositions
    || !validQuarantine
    || JSON.stringify([...positions].sort(comparePositions)) !== JSON.stringify(positions)
    || JSON.stringify([...quarantinedPositions].sort(comparePositions)) !== JSON.stringify(quarantinedPositions)
    || snapshot.positionsSha256 !== sha256(JSON.stringify(positions))) {
    throw new Error("invalid Daegu route map positions snapshot");
  }
  return snapshot;
}

export function projectLatLon(latitude, longitude) {
  // 공식 위경도를 결정론적 양의 정수 canvas 좌표로 투영한다(경도→x, 북→작은 y).
  const x = Math.round((longitude - 128.3) * 100_000);
  const y = Math.round((36.1 - latitude) * 100_000);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw new Error(`Daegu route map projection out of bounds: ${latitude},${longitude}`);
  }
  return { x, y };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function labelGeometry(stationName, x, y) {
  const width = Math.max(28, [...normalizedStationName(stationName)].length * 14);
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
  return `station-${sha1(`대구:${normalizedStationName(stationName)}`).slice(0, 12)}`;
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
      throw new Error("usage: collect-daegu-route-map-positions.mjs --fixtures-dir <dir> --sources-dir <dir> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args["fixtures-dir"] || !args["sources-dir"] || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-daegu-route-map-positions.mjs --fixtures-dir <dir> --sources-dir <dir> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runDaeguRouteMapPositionsCollector(argv) {
  const args = parseArgs(argv);
  const csvByDatasetId = {};
  const topologySnapshots = {};
  for (const dataset of DATASETS) {
    csvByDatasetId[dataset.datasetId] = await readFile(
      path.join(args["fixtures-dir"], `data-go-${dataset.datasetId}.csv`),
    );
    topologySnapshots[Number(dataset.lineNumber)] = JSON.parse(await readFile(
      path.join(args["sources-dir"], `daegu-line${dataset.lineNumber}-route-topology-20260721.json`),
      "utf8",
    ));
  }
  const snapshot = collectDaeguRouteMapPositions({
    csvByDatasetId,
    topologySnapshots,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(`Daegu route map positions snapshot ready: stations=${snapshot.stationCount}`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDaeguRouteMapPositionsCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daegu route map position collection failed");
    process.exitCode = 1;
  }
}
