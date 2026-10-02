#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { SOURCE_ID, validateSeoulMetroTransferSnapshot } from "./collect-seoul-metro-transfer-car-door-duration.mjs";
import { collectSeoulStationLineInfo } from "./collect-seoul-station-line-info.mjs";

// #876(QA 결정 2026-10-02): 서울교통공사_서울 도시철도 환승정보(15098252)의 실측 소요시간을 공식 환승 시간 원천으로 쓴다.
// - QA 확인: "소요시간"은 실측값이다. 보행속도로 다시 계산하지 않는다. 거리는 원천에 없으므로 null이다(추정 금지).
// - 방향(역, 출발 노선, 도착 노선)마다 칸·문 조합 중 가장 짧은 실측 시간을 쓰고, 그 조합(동률이면 모두)을 빠른 환승 안내로 보존한다.
// - "소요시간"이 빈 행은 사용 불가다. 방향의 모든 행이 비면 그 방향은 지표가 없다. "00:00"은 실측 0초로 쓴다.
// - 매핑(추정·유사도 없음):
//   · 출발: 원천 역명 + 출발 노선 표기. 출발역 코드의 카탈로그 행(역명·노선)이 원천 역명·노선 표기와 같아야 한다.
//     정본 역은 nameKo 또는 nameSub가 원천 역명과 정확히 같고 출발 노선을 가진 역 하나여야 한다(#875 규칙).
//   · 도착 노선: 원천 "환승종료역"은 환승 열차 방면의 다음 역 코드다. 그 코드의 카탈로그 행 역명이 "환승 열차 방면"과 같아야 하고,
//     그 행의 노선이 도착 노선이다. 정본 역이 도착 노선을 가져야 한다.
//   · 역 코드 카탈로그: 서울 역코드 membership 결속 산출물(seoulmetro-station-line-info 원문 799행, #842 승격)이다.
// - 매핑할 수 없는 행은 행 번호·값·사유로 고정한다(PINNED_EXCLUDED_SOURCE_ROWS). 값이 바뀌거나 매핑되기 시작하면 NO_GO다.
export const SEOUL_MEASURED_TRANSFER_METRICS_PATH = "tools/datapack/release/current-seoul-measured-transfer-metrics.json";
export const STATION_CODE_CATALOG_PATH = "tools/datapack/sources/seoul-station-code-membership-20260909T041501Z.json";
const CANONICAL_PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
const SOURCE_INVENTORY_PATH = "tools/datapack/source-inventory.json";
const MEASUREMENT = Object.freeze({
  basis: "PROVIDER_MEASURED_PLATFORM_TO_PLATFORM",
  durationUnitSeconds: 1,
  distance: "NOT_PROVIDED",
  noteKo: "서울교통공사 원천 실측값이다(QA 확인 2026-10-02). 하차 칸·문에서 환승 승차 칸·문까지의 소요시간이며 보행속도로 산정한 값이 아니다. 거리는 원천에 없다.",
});
// 원천 출발 노선 표기 → 역 코드 카탈로그 LINE_NUM.
const SOURCE_LINE_LABELS = new Map([
  ["1", "01호선"], ["2", "02호선"], ["3", "03호선"], ["4", "04호선"], ["5", "05호선"], ["6", "06호선"], ["7", "07호선"],
  ["8", "08호선"], ["9", "09호선"], ["경의선", "경의선"], ["수인분당선", "수인분당선"], ["공항철도", "공항철도"],
  ["경춘선", "경춘선"], ["서해선", "서해선"], ["신분당선", "신분당선"], ["인천선", "인천선"], ["인천2", "인천2호선"],
  ["신림선", "신림선"], ["우이신설경전철", "우이신설경전철"], ["경강선", "경강선"], ["의정부경전철", "의정부경전철"],
]);
// 역 코드 카탈로그 LINE_NUM → 정본 팩 노선 id. 정본 노선 이름(nameKo)까지 같아야 쓴다.
const CATALOG_LINES = new Map([
  ["01호선", ["line-472a81add377", "수도권 1호선"]], ["02호선", ["seoul-2", "수도권 2호선"]],
  ["03호선", ["line-41a8c75ec9d8", "수도권 3호선"]], ["04호선", ["seoul-4", "수도권 4호선"]],
  ["05호선", ["line-80fc4d5350d4", "수도권 5호선"]], ["06호선", ["line-3f41718e0833", "수도권 6호선"]],
  ["07호선", ["line-15b3b8a93259", "수도권 7호선"]], ["08호선", ["line-2b2d9eaa53d0", "수도권 8호선"]],
  ["09호선", ["line-f0e747248a31", "수도권 9호선"]], ["경의선", ["line-6e39be0cb6e2", "수도권 경의중앙"]],
  ["수인분당선", ["line-558d0bd8312d", "수도권 수인분당"]], ["공항철도", ["line-e9e9a5b520a4", "수도권 공항"]],
  ["경춘선", ["line-54a7b980b7c3", "수도권 경춘"]], ["서해선", ["line-051552e50435", "수도권 서해선"]],
  ["신분당선", ["shinbundang", "수도권 신분당"]], ["인천선", ["line-98718184f016", "인천 1호선"]],
  ["인천2호선", ["line-42b5805f3b5a", "인천 2호선"]], ["신림선", ["line-aefa08ccc0a9", "수도권 신림선"]],
  ["우이신설경전철", ["line-30886152e4f8", "수도권 우이신설"]], ["경강선", ["line-e4939a4b4713", "수도권 경강"]],
  ["의정부경전철", ["line-62096860ab09", "수도권 의정부"]], ["김포도시철도", ["line-5500c1600f71", "수도권 김포골드라인"]],
  ["용인경전철", ["line-828f04afc588", "수도권 에버라인"]],
]);
const ROW_VALUE_FIELDS = Object.freeze([
  "startStationName", "startStationCode", "startLine", "alightingDirection", "alightingCar", "alightingDoor",
  "endStationCode", "boardingDirection", "boardingCar", "boardingDoor", "duration",
]);
// 2026-09-02 원천(2026-10-02 수집) 기준 고정 제외 행. 값은 원천 문자열 그대로다.
// - SAME_LINE_BRANCH_TRANSFER: 같은 노선 지선 환승(금천구청 광명셔틀·성수지선·신정지선). 정본 팩은 지선을 같은 노선 id로 표현해
//   역내 환승 간선으로 나타낼 수 없다(#875 S2와 같은 사유).
// - STATION_NOT_IN_CANONICAL_PACK: 원천 역명 "석남"과 정확히 같은 정본 역이 없다. 정본 팩은 석남(거북시장)을 7호선·인천2호선
//   별도 역으로 두고 있어 역내 환승으로 정할 수 없다(역 밖 환승 링크 대상).
export const PINNED_EXCLUDED_SOURCE_ROWS = new Map([
  ["77", { reason: "SAME_LINE_BRANCH_TRANSFER", row: ["금천구청", "1703", "1", "석수 방면", "7", "1", "1750", "광명 방면", "7", "1", "00:00"] }],
  ["144", { reason: "SAME_LINE_BRANCH_TRANSFER", row: ["성수", "0211", "2", "건대입구 방면", "10", "4", "0244", "용답 방면", "1", "1", "03:32"] }],
  ["145", { reason: "SAME_LINE_BRANCH_TRANSFER", row: ["성수", "0211", "2", "뚝섬 방면", "All", "All", "0244", "용답 방면", "All", "All", "00:05"] }],
  ["184", { reason: "SAME_LINE_BRANCH_TRANSFER", row: ["신도림", "0234", "2", "문래 방면", "4", "3", "0247", "도림천 방면", "4", "1", "01:51"] }],
  ["185", { reason: "SAME_LINE_BRANCH_TRANSFER", row: ["신도림", "0234", "2", "대림 방면", "7", "2", "0247", "도림천 방면", "4", "1", "01:51"] }],
  ["999", { reason: "STATION_NOT_IN_CANONICAL_PACK", row: ["석남", "3213", "인천2", "가정중앙시장 방면", "2", "3", "3762", "산곡 방면", "1", "4", "05:45"] }],
  ["1000", { reason: "STATION_NOT_IN_CANONICAL_PACK", row: ["석남", "3213", "인천2", "서부여성회관 방면", "1", "1", "3762", "산곡 방면", "2", "4", "05:26"] }],
]);

export function readStationCodeCatalogRows(catalogBytes) {
  const artifact = parseJson(catalogBytes, "station code catalog");
  const snapshot = artifact?.snapshot;
  if (artifact?.artifactKind !== "seoul-station-code-membership-binding" || snapshot?.sourceId !== "seoulmetro-station-line-info"
    || typeof snapshot.rawBytesBase64 !== "string") {
    throw new Error("NO_GO Seoul station code catalog identity mismatch");
  }
  const replay = collectSeoulStationLineInfo({ csvBytes: Buffer.from(snapshot.rawBytesBase64, "base64"), capturedAt: snapshot.capturedAt });
  if (!isDeepStrictEqual(replay, snapshot)) throw new Error("NO_GO Seoul station code catalog replay mismatch");
  const codes = new Set();
  for (const row of replay.rows) {
    if (codes.has(row.STATION_CD)) throw new Error(`NO_GO duplicate Seoul station code: ${row.STATION_CD}`);
    codes.add(row.STATION_CD);
  }
  return replay.rows;
}

export function deriveSeoulMeasuredTransferMetrics({ rows, catalogRows, pack, pinnedExclusions = PINNED_EXCLUDED_SOURCE_ROWS }) {
  if (!Array.isArray(rows) || !Array.isArray(catalogRows) || !Array.isArray(pack?.stations) || !Array.isArray(pack.stationLines) || !Array.isArray(pack.lines)) {
    throw new Error("NO_GO Seoul measured transfer derivation inputs are required");
  }
  const catalog = new Map(catalogRows.map((row) => [row.STATION_CD, row]));
  const lineNames = new Map(pack.lines.map(({ id, nameKo }) => [id, nameKo]));
  const stationLines = new Set(pack.stationLines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  const lineIdFor = (lineNum) => {
    const entry = CATALOG_LINES.get(lineNum);
    if (!entry) throw new Error(`NO_GO unknown Seoul measured transfer catalog line: ${lineNum}`);
    if (lineNames.get(entry[0]) !== entry[1]) throw new Error(`NO_GO Seoul measured transfer line identity mismatch: ${lineNum}`);
    return entry[0];
  };
  const catalogRow = (code) => {
    const row = catalog.get(code);
    if (!row) throw new Error(`NO_GO Seoul measured transfer station code is absent from catalog: ${code}`);
    return row;
  };
  const directions = new Map();
  const excludedSourceRows = [];
  const unavailableSourceRows = [];
  const seenRows = new Set();
  const seenPins = new Set();
  for (const row of rows) {
    const rowNumber = row?.sourceRowNumber;
    if (seenRows.has(rowNumber)) throw new Error(`NO_GO duplicate Seoul measured transfer source row: ${rowNumber}`);
    seenRows.add(rowNumber);
    const sourceLineNum = SOURCE_LINE_LABELS.get(row.startLine);
    if (!sourceLineNum) throw new Error(`NO_GO unknown Seoul measured transfer line label: ${row.startLine}`);
    const start = catalogRow(row.startStationCode);
    if (start.STATION_NM !== row.startStationName || start.LINE_NUM !== sourceLineNum) {
      throw new Error(`NO_GO Seoul measured transfer start code catalog mismatch: ${rowNumber}`);
    }
    const end = catalogRow(row.endStationCode);
    if (`${end.STATION_NM} 방면` !== row.boardingDirection) throw new Error(`NO_GO Seoul measured transfer end code catalog mismatch: ${rowNumber}`);
    const fromLineId = lineIdFor(start.LINE_NUM);
    const toLineId = lineIdFor(end.LINE_NUM);
    const stations = pack.stations.filter(({ id, nameKo, nameSub }) => (nameKo === row.startStationName || nameSub === row.startStationName)
      && stationLines.has(`${id}\0${fromLineId}`));
    if (stations.length > 1) throw new Error(`NO_GO ambiguous Seoul measured transfer station: ${rowNumber}`);
    const stationId = stations[0]?.id;
    const mapped = stationId !== undefined && fromLineId !== toLineId && stationLines.has(`${stationId}\0${toLineId}`);
    const pin = pinnedExclusions.get(rowNumber);
    if (pin) {
      if (mapped) throw new Error(`NO_GO pinned Seoul measured transfer exclusion now maps: ${rowNumber}`);
      if (!isDeepStrictEqual(ROW_VALUE_FIELDS.map((field) => row[field]), pin.row)) {
        throw new Error(`NO_GO pinned Seoul measured transfer exclusion drift: ${rowNumber}`);
      }
      seenPins.add(rowNumber);
      excludedSourceRows.push({ ...sourceRow(row), reason: pin.reason });
      continue;
    }
    if (!mapped) throw new Error(`NO_GO unpinned Seoul measured transfer row: ${rowNumber}`);
    const key = directionKey(stationId, fromLineId, toLineId);
    const direction = directions.get(key) ?? { stationId, fromLineId, toLineId, rows: [] };
    direction.rows.push(row);
    directions.set(key, direction);
    if (row.duration === "") unavailableSourceRows.push({ ...sourceRow(row), stationId, fromLineId, toLineId, reason: "EMPTY_DURATION" });
  }
  for (const rowNumber of pinnedExclusions.keys()) {
    if (!seenPins.has(rowNumber)) throw new Error(`NO_GO pinned Seoul measured transfer exclusion is absent: ${rowNumber}`);
  }
  const metrics = [];
  const unavailableDirections = [];
  for (const { stationId, fromLineId, toLineId, rows: directionRows } of [...directions.values()].sort(compareDirection)) {
    const measured = directionRows.filter(({ duration }) => duration !== "").map((row) => ({ row, seconds: durationSeconds(row.duration) }));
    const sourceRowNumbers = directionRows.map(({ sourceRowNumber }) => sourceRowNumber);
    if (measured.length === 0) {
      unavailableDirections.push({ stationId, fromLineId, toLineId, sourceRowNumbers });
      continue;
    }
    const minimum = Math.min(...measured.map(({ seconds }) => seconds));
    metrics.push({
      stationId,
      fromLineId,
      toLineId,
      measuredDurationSeconds: minimum,
      distanceMeters: null,
      metricProvenance: "OFFICIAL_SOURCE",
      measurement: "MEASURED",
      fastTransferHints: measured.filter(({ seconds }) => seconds === minimum).map(({ row }) => ({
        sourceRowNumber: row.sourceRowNumber,
        alightingDirection: row.alightingDirection,
        alightingCar: row.alightingCar,
        alightingDoor: row.alightingDoor,
        boardingDirection: row.boardingDirection,
        boardingCar: row.boardingCar,
        boardingDoor: row.boardingDoor,
      })),
      sourceRowNumbers,
      sourceRecordSha256: sha256(canonicalJson({ sourceId: SOURCE_ID, rows: directionRows.map(sourceRow) })),
    });
  }
  return { metrics, unavailableDirections, excludedSourceRows, unavailableSourceRows };
}

export async function readSeoulMeasuredTransferMetricsInputs({ repositoryRoot, snapshotId, read: readOverride } = {}) {
  const read = readOverride ?? ((relative) => readFile(path.join(path.resolve(repositoryRoot), relative)));
  const sourceInventoryBytes = await read(SOURCE_INVENTORY_PATH);
  const selected = snapshotId ?? inventorySource(parseJson(sourceInventoryBytes, "source inventory")).admissionEvidence?.snapshotId;
  if (typeof selected !== "string" || !new RegExp(`^${SOURCE_ID}-[a-f0-9]{64}$`, "u").test(selected)) {
    throw new Error("NO_GO Seoul measured transfer snapshot binding mismatch");
  }
  const [snapshotBytes, catalogBytes, canonicalPackBytes] = await Promise.all([
    read(`tools/datapack/sources/${selected}.json`), read(STATION_CODE_CATALOG_PATH), read(CANONICAL_PACK_PATH),
  ]);
  return { snapshotBytes, sourceInventoryBytes, catalogBytes, canonicalPackBytes };
}

export function buildSeoulMeasuredTransferMetrics({ snapshotBytes, sourceInventoryBytes, catalogBytes, canonicalPackBytes }) {
  for (const [value, label] of [[snapshotBytes, "snapshot"], [sourceInventoryBytes, "source inventory"], [catalogBytes, "station code catalog"], [canonicalPackBytes, "canonical pack"]]) {
    if (!Buffer.isBuffer(value) || value.length === 0) throw new Error(`NO_GO Seoul measured transfer ${label} bytes are required`);
  }
  const snapshotFileSha256 = sha256(snapshotBytes);
  const snapshotId = `${SOURCE_ID}-${snapshotFileSha256}`;
  const admission = inventorySource(parseJson(sourceInventoryBytes, "source inventory")).admissionEvidence;
  const snapshot = validateSeoulMetroTransferSnapshot(parseJson(snapshotBytes, "snapshot"));
  if (admission?.snapshotId !== snapshotId || admission.rawSha256 !== snapshot.rawSha256 || admission.schemaFingerprint !== snapshot.schemaFingerprint) {
    throw new Error("NO_GO Seoul measured transfer snapshot binding mismatch");
  }
  const pack = parseJson(canonicalPackBytes, "canonical pack")?.packs?.[0];
  const derived = deriveSeoulMeasuredTransferMetrics({ rows: snapshot.rows, catalogRows: readStationCodeCatalogRows(catalogBytes), pack });
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-seoul-measured-transfer-metrics",
    sourceIdentity: {
      sourceId: SOURCE_ID,
      snapshotId,
      snapshotFileSha256,
      capturedAt: snapshot.capturedAt,
      sourceEffectiveDate: snapshot.sourceEffectiveDate,
      rawSha256: snapshot.rawSha256,
      contentSha256: snapshot.contentSha256,
      rowCount: snapshot.rowCount,
      stationCodeCatalogSha256: sha256(catalogBytes),
      canonicalPackSha256: sha256(canonicalPackBytes),
    },
    measurement: { ...MEASUREMENT },
    metrics: derived.metrics,
    unavailableDirections: derived.unavailableDirections,
    excludedSourceRows: derived.excludedSourceRows,
    unavailableSourceRows: derived.unavailableSourceRows,
  };
  return canonicalObject({ ...payload, artifactSha256: sha256(canonicalJson(payload)) });
}

export function canonicalSeoulMeasuredTransferMetricsJson(artifact) {
  const { artifactSha256, ...payload } = artifact ?? {};
  if (artifact?.artifactKind !== "current-seoul-measured-transfer-metrics" || artifactSha256 !== sha256(canonicalJson(payload))) {
    throw new Error("NO_GO Seoul measured transfer metrics artifact digest mismatch");
  }
  return `${canonicalJson(artifact)}\n`;
}

function inventorySource(inventory) {
  const matches = (inventory?.sources ?? []).filter(({ id }) => id === SOURCE_ID);
  if (matches.length !== 1) throw new Error("NO_GO Seoul measured transfer inventory source is missing or ambiguous");
  return matches[0];
}

function sourceRow(row) {
  return { sourceRowNumber: row.sourceRowNumber, ...Object.fromEntries(ROW_VALUE_FIELDS.map((field) => [field, row[field]])) };
}

function durationSeconds(value) {
  const match = /^(\d{2}):([0-5]\d)$/u.exec(value);
  if (!match) throw new Error(`NO_GO Seoul measured transfer duration mismatch: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function compareDirection(left, right) {
  return compareBytes(directionKey(left.stationId, left.fromLineId, left.toLineId), directionKey(right.stationId, right.fromLineId, right.toLineId));
}
function directionKey(stationId, fromLineId, toLineId) { return `${stationId}\0${fromLineId}\0${toLineId}`; }
function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`NO_GO Seoul measured transfer ${label} must be strict UTF-8 JSON`); }
}
function canonicalJson(value) { return JSON.stringify(canonicalObject(value)); }
function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  return value;
}
function compareBytes(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !path.isAbsolute(argv[1])) {
    throw new Error("usage: build-seoul-measured-transfer-metrics.mjs --output <absolute absent file>");
  }
  const output = path.resolve(argv[1]);
  await lstat(output).then(() => { throw new Error("output must be absent"); }, (error) => { if (error?.code !== "ENOENT") throw error; });
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const artifact = buildSeoulMeasuredTransferMetrics(await readSeoulMeasuredTransferMetricsInputs({ repositoryRoot }));
  await writeFile(output, canonicalSeoulMeasuredTransferMetricsJson(artifact), { flag: "wx", mode: 0o644 });
  console.log(JSON.stringify({
    metricCount: artifact.metrics.length, unavailableDirectionCount: artifact.unavailableDirections.length,
    excludedSourceRowCount: artifact.excludedSourceRows.length, unavailableSourceRowCount: artifact.unavailableSourceRows.length,
    artifactSha256: artifact.artifactSha256,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
