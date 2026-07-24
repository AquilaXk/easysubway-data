#!/usr/bin/env node
// 인천교통공사 도시철도역사정보(공식 FILE 15083751)를 결정론적 snapshot으로 수집한다.
// API key·포털 활용신청 없이 data.go.kr 파일데이터만 사용한다.
//
// 범위: 인천지하철 1·2호선만 admit. 7호선(인천·부천 구간)은 seoul-metro lineId와
// 공유되므로 전량 제외한다(fail-closed on unknown 노선명).
//
// Dedup: 동일 (노선명,역번호)가 이름·위경도까지 동일하면 1건만 유지.
// 동일 키가 서로 다른 정체성이면 fail-closed. 단, FILE이 송도달빛축제공원에
// 국제업무지구와 같은 3138을 부여한 결함은 수도권 사이버스테이션 station-cd=3139
// 정본으로만 교정한다(그 외 코드 발명은 금지).
//
// Topology: 노선별 역번호를 숫자 정렬해 인접 역을 양방향 RIDE edge로 연결한다.
// FILE에 거리·소요시간이 없어 durationSeconds=120·distanceMeters=0 placeholder를
// 쓴다(tools/route-map/lib/station-catalog.mjs 동일 관례). haversine 발명 금지.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ID = "incheon-transit-station-info";
const ARTIFACT_KIND = "incheon-station-info-snapshot";
const DATASET_ID = "15083751";
const DETAIL_URL = `https://www.data.go.kr/data/${DATASET_ID}/fileData.do`;
const OPERATOR_ID = "incheon-transit";
const OPERATOR_NAME = "인천교통공사";
const REGION = "수도권";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const OBSERVED_DATA_UPDATED_AT = "2025-06-30";
const SKIP_LINE_NAMES = Object.freeze(new Set(["7호선"]));
const LINE_BY_NAME = Object.freeze({
  "인천지하철 1호선": {
    lineId: "line-98718184f016",
    nameKo: "인천 1호선",
    color: "#7ca8d5",
  },
  "인천지하철 2호선": {
    lineId: "line-42b5805f3b5a",
    nameKo: "인천 2호선",
    color: "#ed8b00",
  },
});
const LINE_IDS = Object.freeze([
  "line-42b5805f3b5a",
  "line-98718184f016",
]);
const EXPECTED_RAW_ROW_COUNT = 71;
const EXPECTED_LINE7_COUNT = 11;
const EXPECTED_ADMITTED_ROW_COUNT = 60;
const EXPECTED_STATION_COUNT = 60;
const EXPECTED_UNIQUE_STATION_COUNT = 59;
const EXPECTED_EDGE_COUNT = 116;
const EXPECTED_LINE_STATION_COUNTS = Object.freeze({
  "line-98718184f016": 33,
  "line-42b5805f3b5a": 27,
});
const PLACEHOLDER_DURATION_SECONDS = 120;
const PLACEHOLDER_DISTANCE_METERS = 0;
const FIELDS_PROVIDED = Object.freeze([
  "line",
  "station_name",
  "station_code",
  "network_edges",
  "duration_seconds",
  "distance_meters",
  "route_map_position",
  "route_map_label_polygon",
]);
const HEADERS = Object.freeze([
  "역번호", "역사명", "노선번호", "노선명", "영문역사명", "한자역사명", "환승역구분",
  "환승노선번호", "환승노선명", "역위도", "역경도", "운영기관명", "역사도로명주소",
  "역사전화번호", "데이터기준일자",
]);
// FILE 15083751이 송도달빛축제공원에 국제업무지구와 동일 역번호 3138을 부여한다.
// 수도권 사이버스테이션 station-cd 정본(3139)으로만 교정한다.
const STATION_CODE_CORRECTIONS = Object.freeze([
  {
    lineName: "인천지하철 1호선",
    stationName: "송도달빛축제공원",
    rawStationCode: "3138",
    correctedStationCode: "3139",
    evidence: "seoulmetro-cyberstation-line-data station-cd=3139",
  },
]);
// 수도권 정본 station id(위키 SVG + #1954 검단연장 salt). 환승역(인천시청)은 단일 id.
const KNOWN_STATION_IDS = Object.freeze({
  마전: "station-02d897b2bcfd",
  가정: "station-0c6099312f48",
  검단사거리: "station-0f36b884433f",
  검암: "station-12984a8c7a35",
  주안국가산단: "station-13bca5055e72",
  완정: "station-1d4d6855a869",
  운연: "station-3359f701c87e",
  석남: "station-37866f28b417",
  인천시청: "station-423d71b94cdc",
  가재울: "station-42c7eef8d1c5",
  모래내시장: "station-556ef3fbf72f",
  왕길: "station-5b8042d974d1",
  검바위: "station-65f9e67f1599",
  서부여성회관: "station-82ecbea93f37",
  석바위시장: "station-8a4d8eb26107",
  인천대공원: "station-8cc7ed221b7a",
  독정: "station-a74ee2ce84eb",
  주안: "station-aba7d8fea4fd",
  인천가좌: "station-acf32c565bf0",
  서구청: "station-b1a5f63faf69",
  검단오류: "station-b8b7c93b0203",
  석천사거리: "station-be0bc5f41d9b",
  만수: "station-d2b72ca2c3cb",
  남동구청: "station-dc463f781f8f",
  시민공원: "station-de9ca3cfa522",
  가정중앙시장: "station-e6a8d225e817",
  아시아드경기장: "station-f1b1f89c1c19",
  동춘: "station-0c76cb09c3c0",
  원인재: "station-1c398a36808a",
  캠퍼스타운: "station-1e58bb30ac58",
  계양: "station-2671dacf496f",
  임학: "station-2e8d89fbaa44",
  예술회관: "station-3aaa7649fbf8",
  부평: "station-3eb92ae69e48",
  간석오거리: "station-4505da5ce301",
  테크노파크: "station-45d15ac4ee45",
  귤현: "station-465aecb00f28",
  신연수: "station-5acf597709aa",
  부평구청: "station-662a880cfe7d",
  동수: "station-730cfed01305",
  문학경기장: "station-7a747e66f553",
  계산: "station-87388ef56c72",
  인천대입구: "station-8fa13d346ce0",
  부평시장: "station-96662c458aac",
  동막: "station-9dd454f6e60c",
  인천터미널: "station-a736f7816a86",
  지식정보단지: "station-ae1223d60f61",
  부평삼거리: "station-d7f69f7c818a",
  경인교대입구: "station-d8e8f695dd92",
  선학: "station-dabe25cae92a",
  송도달빛축제공원: "station-dc474ca1fe74",
  센트럴파크: "station-dc9b41ca470c",
  작전: "station-df649ffec07f",
  갈산: "station-f1ca93b87e1f",
  박촌: "station-f497b2d7043f",
  국제업무지구: "station-f71737c17ce9",
  검단호수공원: "station-62fe7e203078",
  신검단중앙: "station-b78008d08d1f",
  아라: "station-996efa447ecf",
});

export function normalizeIncheonStationName(name) {
  return String(name).normalize("NFKC").replace(/\s+/gu, "").replace(/\([^()]*\)$/u, "");
}

export function stationIdFor(stationName) {
  const normalized = normalizeIncheonStationName(stationName);
  const known = KNOWN_STATION_IDS[normalized];
  if (!known) throw new Error(`Incheon station id missing for ${stationName}`);
  return known;
}

export function projectLatLon(latitude, longitude) {
  // 수도권 공식 위경도 → 결정론적 양의 정수 canvas(서울 collector와 동일 투영).
  const x = Math.round((longitude - 126.5) * 100_000);
  const y = Math.round((38.2 - latitude) * 100_000);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw new Error(`Incheon route map projection out of bounds: ${latitude},${longitude}`);
  }
  return { x, y };
}

export function parseIncheonStationInfoCsv(csvBytes) {
  if (!(csvBytes instanceof Uint8Array) || csvBytes.byteLength === 0) {
    throw new Error("Incheon station info CSV bytes are required");
  }
  const table = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(csvBytes));
  if (table.length < 2) throw new Error("Incheon station info CSV empty");
  const header = table[0];
  if (JSON.stringify(header) !== JSON.stringify([...HEADERS])) {
    throw new Error("Incheon station info CSV missing column");
  }
  if (table.length - 1 !== EXPECTED_RAW_ROW_COUNT) {
    throw new Error(`Incheon station info raw row count mismatch: ${table.length - 1}`);
  }

  const indexes = Object.fromEntries(HEADERS.map((name, index) => [name, index]));
  const rawRows = [];
  let excludedLine7Count = 0;
  for (const [rowIndex, row] of table.slice(1).entries()) {
    if (row.length !== header.length) {
      throw new Error(`Incheon station info CSV column count mismatch at row ${rowIndex + 2}`);
    }
    const lineName = String(row[indexes.노선명] ?? "").trim();
    if (SKIP_LINE_NAMES.has(lineName)) {
      excludedLine7Count += 1;
      continue;
    }
    const line = LINE_BY_NAME[lineName];
    if (!line) throw new Error(`Incheon station info unknown line: ${lineName || "(empty)"}`);
    const operatorName = String(row[indexes.운영기관명] ?? "").trim();
    if (operatorName !== OPERATOR_NAME) {
      throw new Error(`Incheon station info unexpected operator at row ${rowIndex + 2}`);
    }
    const stationName = String(row[indexes.역사명] ?? "").trim();
    const nameEn = String(row[indexes.영문역사명] ?? "").trim();
    const rawStationCode = String(row[indexes.역번호] ?? "").trim();
    const latitude = Number(String(row[indexes.역위도] ?? "").trim());
    const longitude = Number(String(row[indexes.역경도] ?? "").trim());
    const dataDate = String(row[indexes.데이터기준일자] ?? "").trim();
    if (!stationName || !rawStationCode) {
      throw new Error(`Incheon station info empty identity at row ${rowIndex + 2}`);
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < 37.2 || latitude > 37.8 || longitude < 126.4 || longitude > 127.0) {
      throw new Error(`Incheon station info invalid coordinates: ${stationName}`);
    }
    if (dataDate !== OBSERVED_DATA_UPDATED_AT) {
      throw new Error(`Incheon station info unexpected data date: ${dataDate}`);
    }
    const stationCode = applyStationCodeCorrection(lineName, stationName, rawStationCode);
    rawRows.push({
      lineName,
      lineId: line.lineId,
      stationCode,
      rawStationCode,
      stationName,
      nameEn,
      latitude,
      longitude,
    });
  }
  if (excludedLine7Count !== EXPECTED_LINE7_COUNT) {
    throw new Error(`Incheon station info line7 exclusion count mismatch: ${excludedLine7Count}`);
  }
  if (rawRows.length !== EXPECTED_ADMITTED_ROW_COUNT) {
    throw new Error(`Incheon station info admitted row count mismatch: ${rawRows.length}`);
  }

  const deduped = dedupeRows(rawRows);
  if (deduped.length !== EXPECTED_ADMITTED_ROW_COUNT) {
    throw new Error(`Incheon station info deduped row count mismatch: ${deduped.length}`);
  }

  const scope = [];
  for (const lineId of LINE_IDS) {
    const lineRows = deduped
      .filter((row) => row.lineId === lineId)
      .sort((left, right) => Number(left.stationCode) - Number(right.stationCode)
        || left.stationName.localeCompare(right.stationName, "ko"));
    const expected = EXPECTED_LINE_STATION_COUNTS[lineId];
    if (lineRows.length !== expected) {
      throw new Error(`Incheon station info line station count mismatch: ${lineId}`);
    }
    const codes = new Set();
    lineRows.forEach((row, index) => {
      if (codes.has(row.stationCode)) {
        throw new Error(`Incheon station info duplicate station code after correction: ${row.stationCode}`);
      }
      codes.add(row.stationCode);
      scope.push({
        lineId,
        stationCode: row.stationCode,
        stationName: row.stationName,
        stationId: stationIdFor(row.stationName),
        nameEn: row.nameEn,
        latitude: row.latitude,
        longitude: row.longitude,
        lineSequence: index + 1,
      });
    });
  }
  if (scope.length !== EXPECTED_STATION_COUNT) {
    throw new Error(`Incheon station info scope count mismatch: ${scope.length}`);
  }
  if (new Set(scope.map(({ stationId }) => stationId)).size !== EXPECTED_UNIQUE_STATION_COUNT) {
    throw new Error("Incheon station info unique station count mismatch");
  }

  const edges = buildAdjacentEdges(scope);
  if (edges.length !== EXPECTED_EDGE_COUNT) {
    throw new Error(`Incheon station info edge count mismatch: ${edges.length}`);
  }

  const positions = scope.map((station) => {
    const { x, y } = projectLatLon(station.latitude, station.longitude);
    const label = labelGeometry(station.stationName, x, y);
    return {
      lineId: station.lineId,
      stationCode: station.stationCode,
      stationName: station.stationName,
      stationId: station.stationId,
      latitude: station.latitude,
      longitude: station.longitude,
      x,
      y,
      labelDx: label.labelDx,
      labelDy: label.labelDy,
      labelPolygon: label.labelPolygon,
    };
  }).sort(comparePositions);

  return {
    excludedLine7Count,
    scope,
    edges,
    positions,
    stationCodeCorrections: STATION_CODE_CORRECTIONS.map((entry) => ({ ...entry })),
  };
}

export function collectIncheonStationInfo({ csvBytes, now = new Date() } = {}) {
  const capturedAt = validDate(now, "now");
  const parsed = parseIncheonStationInfoCsv(csvBytes);
  const scope = parsed.scope;
  const edges = parsed.edges;
  const positions = parsed.positions;
  const snapshot = {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    detailUrl: DETAIL_URL,
    datasetId: DATASET_ID,
    endpoint: DETAIL_URL,
    capturedAt: capturedAt.toISOString(),
    freshUntil: new Date(capturedAt.getTime() + FRESHNESS_MILLIS).toISOString(),
    observedDataUpdatedAt: OBSERVED_DATA_UPDATED_AT,
    official: true,
    fixture: false,
    credentialRequired: false,
    credentialRedacted: true,
    rawRowCount: EXPECTED_RAW_ROW_COUNT,
    admittedRowCount: EXPECTED_ADMITTED_ROW_COUNT,
    excludedLine7Count: parsed.excludedLine7Count,
    excludedTransferCount: parsed.excludedLine7Count,
    stationCount: scope.length,
    uniqueStationCount: EXPECTED_UNIQUE_STATION_COUNT,
    edgeCount: edges.length,
    positionCount: positions.length,
    lineIds: [...LINE_IDS],
    lineStationCounts: { ...EXPECTED_LINE_STATION_COUNTS },
    operatorId: OPERATOR_ID,
    region: REGION,
    fieldsProvided: [...FIELDS_PROVIDED],
    license: {
      type: "PUBLIC_DATA_FREE_USE",
      attribution: "인천교통공사, 공공데이터포털 이용허락범위 제한 없음",
      redistributionAllowed: true,
      evidenceUrl: DETAIL_URL,
    },
    stationCodeCorrections: parsed.stationCodeCorrections,
    scope,
    edges,
    positions,
    scopeSha256: sha256(JSON.stringify(scope)),
    edgesSha256: sha256(JSON.stringify(edges)),
    positionsSha256: sha256(JSON.stringify(positions)),
    rawSha256: sha256(Buffer.from(csvBytes)),
    contentSha256: sha256(JSON.stringify({ scope, edges, positions })),
  };
  return validateIncheonStationInfoSnapshot(snapshot);
}

export function validateIncheonStationInfoSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== ARTIFACT_KIND
    || snapshot.sourceId !== SOURCE_ID || snapshot.datasetId !== DATASET_ID
    || snapshot.detailUrl !== DETAIL_URL || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || snapshot.observedDataUpdatedAt !== OBSERVED_DATA_UPDATED_AT
    || snapshot.rawRowCount !== EXPECTED_RAW_ROW_COUNT
    || snapshot.admittedRowCount !== EXPECTED_ADMITTED_ROW_COUNT
    || snapshot.excludedLine7Count !== EXPECTED_LINE7_COUNT
    || snapshot.excludedTransferCount !== EXPECTED_LINE7_COUNT
    || snapshot.stationCount !== EXPECTED_STATION_COUNT
    || snapshot.uniqueStationCount !== EXPECTED_UNIQUE_STATION_COUNT
    || snapshot.edgeCount !== EXPECTED_EDGE_COUNT
    || snapshot.positionCount !== EXPECTED_STATION_COUNT
    || snapshot.scope?.length !== EXPECTED_STATION_COUNT
    || snapshot.edges?.length !== EXPECTED_EDGE_COUNT
    || snapshot.positions?.length !== EXPECTED_STATION_COUNT
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify([...LINE_IDS])
    || JSON.stringify(snapshot.lineStationCounts) !== JSON.stringify(EXPECTED_LINE_STATION_COUNTS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify([...FIELDS_PROVIDED])
    || snapshot.operatorId !== OPERATOR_ID || snapshot.region !== REGION
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || snapshot.edgesSha256 !== sha256(JSON.stringify(snapshot.edges))
    || snapshot.positionsSha256 !== sha256(JSON.stringify(snapshot.positions))
    || snapshot.contentSha256 !== sha256(JSON.stringify({
      scope: snapshot.scope,
      edges: snapshot.edges,
      positions: snapshot.positions,
    }))
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || Number.isNaN(Date.parse(snapshot.capturedAt))
    || Number.isNaN(Date.parse(snapshot.freshUntil))
    || Date.parse(snapshot.freshUntil) !== Date.parse(snapshot.capturedAt) + FRESHNESS_MILLIS) {
    throw new Error("invalid Incheon station info snapshot");
  }
  const membershipKeys = new Set();
  for (const station of snapshot.scope) {
    const key = `${station.lineId}:${station.stationCode}`;
    if (membershipKeys.has(key) || station.stationId !== stationIdFor(station.stationName)
      || !Number.isInteger(station.lineSequence) || station.lineSequence < 1
      || !Number.isFinite(station.latitude) || !Number.isFinite(station.longitude)) {
      throw new Error(`invalid Incheon station scope row: ${key}`);
    }
    membershipKeys.add(key);
  }
  for (const [lineId, expected] of Object.entries(EXPECTED_LINE_STATION_COUNTS)) {
    const lineScope = snapshot.scope.filter((station) => station.lineId === lineId);
    if (lineScope.length !== expected) throw new Error(`invalid Incheon line scope: ${lineId}`);
    for (let index = 0; index < lineScope.length - 1; index += 1) {
      if (Number(lineScope[index].stationCode) >= Number(lineScope[index + 1].stationCode)) {
        throw new Error(`Incheon station codes are not sorted: ${lineId}`);
      }
    }
  }
  const edgeKeys = new Set();
  for (const edge of snapshot.edges) {
    const key = `${edge.lineId}:${edge.fromStationCode}:${edge.toStationCode}`;
    if (edgeKeys.has(key) || edge.durationSeconds !== PLACEHOLDER_DURATION_SECONDS
      || edge.distanceMeters !== PLACEHOLDER_DISTANCE_METERS
      || Math.abs(Number(edge.fromStationCode) - Number(edge.toStationCode)) !== 1) {
      throw new Error(`invalid Incheon topology edge: ${key}`);
    }
    edgeKeys.add(key);
  }
  const positionKeys = new Set();
  for (const position of snapshot.positions) {
    const key = `${position.lineId}:${position.stationCode}`;
    const projected = projectLatLon(position.latitude, position.longitude);
    if (positionKeys.has(key) || position.x !== projected.x || position.y !== projected.y
      || !Array.isArray(position.labelPolygon) || position.labelPolygon.length !== 4) {
      throw new Error(`invalid Incheon route map position: ${key}`);
    }
    positionKeys.add(key);
  }
  if (JSON.stringify([...snapshot.positions].sort(comparePositions)) !== JSON.stringify(snapshot.positions)) {
    throw new Error("Incheon route map positions are not sorted");
  }
  return snapshot;
}

function applyStationCodeCorrection(lineName, stationName, rawStationCode) {
  const correction = STATION_CODE_CORRECTIONS.find((entry) => (
    entry.lineName === lineName
      && entry.stationName === stationName
      && entry.rawStationCode === rawStationCode
  ));
  if (correction) return correction.correctedStationCode;
  return rawStationCode;
}

function dedupeRows(rows) {
  // Dedup key=(노선명,역번호). 동일 정체성이면 1건 유지, 분기하면 fail-closed.
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.lineName}\0${row.stationCode}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const deduped = [];
  for (const group of groups.values()) {
    const [first, ...rest] = group;
    for (const other of rest) {
      if (other.stationName !== first.stationName
        || other.latitude !== first.latitude
        || other.longitude !== first.longitude
        || other.nameEn !== first.nameEn) {
        throw new Error(
          `Incheon station info divergent duplicate: ${first.lineName}:${first.stationCode}`,
        );
      }
    }
    deduped.push(first);
  }
  return deduped;
}

function buildAdjacentEdges(scope) {
  const edges = [];
  for (const lineId of LINE_IDS) {
    const lineScope = scope.filter((station) => station.lineId === lineId);
    for (let index = 0; index < lineScope.length - 1; index += 1) {
      const left = lineScope[index];
      const right = lineScope[index + 1];
      for (const [from, to] of [[left, right], [right, left]]) {
        edges.push({
          edgeId: `${lineId}:${from.stationCode}:${to.stationCode}`,
          lineId,
          fromStationCode: from.stationCode,
          toStationCode: to.stationCode,
          fromStationId: from.stationId,
          toStationId: to.stationId,
          durationSeconds: PLACEHOLDER_DURATION_SECONDS,
          distanceMeters: PLACEHOLDER_DISTANCE_METERS,
        });
      }
    }
  }
  return edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId, "en"));
}

function labelGeometry(stationName, x, y) {
  const width = Math.max(28, [...normalizeIncheonStationName(stationName)].length * 14);
  const height = 22;
  const left = Math.max(0, x - Math.floor(width / 2));
  const top = Math.max(0, y - 34);
  const right = left + width;
  const bottom = top + height;
  return {
    labelDx: Math.round(((left + right) / 2) - x),
    labelDy: Math.round(((top + bottom) / 2) - y),
    labelPolygon: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
  };
}

function comparePositions(left, right) {
  return left.lineId.localeCompare(right.lineId, "en")
    || left.stationCode.localeCompare(right.stationCode, "en");
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
      throw new Error("usage: collect-incheon-station-info.mjs --input <csv> --output <absolute.json> [--captured-at <iso>]");
    }
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!args.input || !args.output || !path.isAbsolute(args.output)) {
    throw new Error("usage: collect-incheon-station-info.mjs --input <csv> --output <absolute.json> [--captured-at <iso>]");
  }
  return args;
}

export async function runIncheonStationInfoCollector(argv) {
  const args = parseArgs(argv);
  const csvBytes = await readFile(args.input);
  const snapshot = collectIncheonStationInfo({
    csvBytes,
    now: args["captured-at"] ? new Date(args["captured-at"]) : new Date(),
  });
  await writeFile(args.output, `${JSON.stringify(snapshot)}\n`);
  console.log(
    `Incheon station info snapshot ready: stations=${snapshot.stationCount} edges=${snapshot.edgeCount} positions=${snapshot.positionCount}`,
  );
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runIncheonStationInfoCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Incheon station info collection failed");
    process.exitCode = 1;
  }
}
