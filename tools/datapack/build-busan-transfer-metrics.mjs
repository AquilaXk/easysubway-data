#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractBusanTransferRows, validateBusanRouteTopologySnapshot } from "./collect-busan-route-topology.mjs";
import {
  canonicalStationIdFor,
  canonicalStationMappingHash,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";

// #872 S3(QA 결정 2026-10-02): 부산교통공사 원천(busan-transportation-route-topology, data.go.kr 15001019)의
// 환승 행(exchange=Y)을 공식 환승 거리·시간으로 쓴다.
// - 매핑: 역 코드로만 한다. 원천 역명(EUC-KR)은 쓰지 않는다. 코드 → 승인된 membership 매핑(inventory
//   membershipAdmissionEvidence.mappingSha256으로 결속) → 정본 역. 대상은 1~4호선 내부 환승이다.
// - 값: 원천 그대로다. 거리 = dist × 100m, 시간 = time 초. 보행속도로 다시 계산하지 않는다.
// - 방향: 원천에 있는 방향만 OFFICIAL_SOURCE다. 원천에 없는 반대 방향은 D4대로 DERIVED_RECIPROCAL로만 표기한다.
// - 범위 밖 역 코드(8xx·9xx)는 정본 역을 코드로 정할 수 없어 쓰지 않는다. 행과 값을 고정해 두고 바뀌면 NO_GO다.
export const BUSAN_TRANSFER_METRICS_PATH = "tools/datapack/release/current-busan-transfer-metrics.json";
const SOURCE_ID = "busan-transportation-route-topology";
const STATION_MAP_PATH = "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv";
const CANONICAL_PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
const SOURCE_INVENTORY_PATH = "tools/datapack/source-inventory.json";
const DISTANCE_UNIT_METERS = 100;
const DURATION_UNIT_SECONDS = 60;
const VALUE_PRECISION = Object.freeze({
  basis: "PROVIDER_ROUNDED_OPERATING_REFERENCE",
  distanceMeters: DISTANCE_UNIT_METERS,
  durationSeconds: DURATION_UNIT_SECONDS,
  noteKo: "부산교통공사 원천 값이다. 환승 거리는 100m 단위, 환승 시간은 분 단위로 반올림된 운영 기준값이며 실측 보행 거리·시간이 아니다.",
});
const EXCLUSION_REASON = "STATION_CODE_OUTSIDE_ADMITTED_SCOPE";
// 2026-10-01 수집(snapshot 31fc…) 기준. 상대 역 코드가 부산교통공사 1~4호선 114역 scope 밖이다.
const PINNED_EXCLUSIONS = new Map([
  ["120:801", { dist: "5", time: "480", stoppingTime: "0" }],
  ["124:804", { dist: "3", time: "240", stoppingTime: "0" }],
  ["205:810", { dist: "4", time: "360", stoppingTime: "0" }],
  ["227:901", { dist: "0", time: "300", stoppingTime: "0" }],
  ["306:803", { dist: "3", time: "300", stoppingTime: "0" }],
  ["317:907", { dist: "0", time: "240", stoppingTime: "0" }],
]);

export async function readBusanTransferMetricsInputs({ repositoryRoot, snapshotId, read: readOverride } = {}) {
  const read = readOverride ?? ((relative) => readFile(path.join(path.resolve(repositoryRoot), relative)));
  const sourceInventoryBytes = await read(SOURCE_INVENTORY_PATH);
  const selectedSnapshotId = snapshotId ?? busanInventorySource(JSON.parse(sourceInventoryBytes)).topologyAdmissionEvidence?.snapshotId;
  if (typeof selectedSnapshotId !== "string" || !/^busan-transportation-route-topology-[a-f0-9]{64}$/u.test(selectedSnapshotId)) {
    throw new Error("NO_GO Busan transfer snapshot binding mismatch");
  }
  const [snapshotBytes, stationMapBytes, canonicalPackBytes] = await Promise.all([
    read(`tools/datapack/sources/${selectedSnapshotId}.json`),
    read(STATION_MAP_PATH),
    read(CANONICAL_PACK_PATH),
  ]);
  return { snapshotBytes, sourceInventoryBytes, stationMapBytes, canonicalPackBytes };
}

export function buildBusanTransferMetrics({ snapshotBytes, sourceInventoryBytes, stationMapBytes, canonicalPackBytes }) {
  for (const [value, label] of [[snapshotBytes, "snapshot"], [sourceInventoryBytes, "source inventory"], [stationMapBytes, "station map"], [canonicalPackBytes, "canonical pack"]]) {
    if (!Buffer.isBuffer(value) || value.length === 0) throw new Error(`NO_GO Busan transfer ${label} bytes are required`);
  }
  const snapshot = parseJson(snapshotBytes, "snapshot");
  const source = busanInventorySource(parseJson(sourceInventoryBytes, "source inventory"));
  const snapshotFileSha256 = sha256(snapshotBytes);
  const snapshotId = `${SOURCE_ID}-${snapshotFileSha256}`;
  const topology = source.topologyAdmissionEvidence;
  if (topology?.snapshotId !== snapshotId || topology.rawSha256 !== snapshot.rawSha256 || topology.contentSha256 !== snapshot.contentSha256
    || topology.capturedAt !== snapshot.capturedAt || topology.excludedTransferCount !== snapshot.excludedTransferCount) {
    throw new Error("NO_GO Busan transfer snapshot binding mismatch");
  }
  validateBusanRouteTopologySnapshot(snapshot);
  const stationMapCsv = stationMapBytes.toString("utf8");
  const membership = source.membershipAdmissionEvidence;
  if (membership?.snapshotId !== snapshotId || membership.stationCodeSnapshotId !== snapshotId
    || membership.mappingSha256 !== canonicalStationMappingHash(parseCanonicalBusanStationMappings(stationMapCsv), snapshot.scope)) {
    throw new Error("NO_GO Busan station code mapping mismatch");
  }
  const pack = parseJson(canonicalPackBytes, "canonical pack")?.packs?.[0];
  if (!Array.isArray(pack?.stationLines)) throw new Error("NO_GO Busan transfer canonical pack identity mismatch");
  const { metrics, excludedSourceRows } = deriveBusanTransferMetrics({
    transferRows: extractBusanTransferRows(snapshot), scope: snapshot.scope, stationMapCsv, stationLines: pack.stationLines,
  });
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-busan-transfer-metrics",
    sourceIdentity: {
      sourceId: SOURCE_ID,
      snapshotId,
      snapshotFileSha256,
      capturedAt: snapshot.capturedAt,
      rawSha256: snapshot.rawSha256,
      contentSha256: snapshot.contentSha256,
      stationCodeMappingSha256: membership.mappingSha256,
      stationMapSha256: sha256(stationMapBytes),
      canonicalPackSha256: sha256(canonicalPackBytes),
    },
    valuePrecision: { ...VALUE_PRECISION },
    metrics,
    excludedSourceRows,
  };
  return canonicalObject({ ...payload, artifactSha256: sha256(canonicalJson(payload)) });
}

export function deriveBusanTransferMetrics({ transferRows, scope, stationMapCsv, stationLines }) {
  if (!Array.isArray(transferRows) || !Array.isArray(scope) || !Array.isArray(stationLines)) {
    throw new Error("NO_GO Busan transfer derivation inputs are required");
  }
  const scopeByCode = new Map(scope.map((station) => [station.stationCode, station]));
  const mappings = parseCanonicalBusanStationMappings(stationMapCsv);
  const membership = new Set(stationLines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  const records = new Map();
  const excludedSourceRows = [];
  const seenExclusions = new Set();
  for (const row of transferRows) {
    const from = scopeByCode.get(row?.fromStationCode);
    const to = scopeByCode.get(row?.toStationCode);
    if (!/^[a-f0-9]{64}$/u.test(row?.rawResponseSha256 ?? "")) throw new Error("NO_GO Busan transfer row schema mismatch");
    if (!from || !to) {
      const pinKey = `${row.fromStationCode}:${row.toStationCode}`;
      const pin = PINNED_EXCLUSIONS.get(pinKey);
      if (!pin) throw new Error(`NO_GO unpinned Busan transfer row: ${pinKey}`);
      if (pin.dist !== row.dist || pin.time !== row.time || pin.stoppingTime !== row.stoppingTime) {
        throw new Error(`NO_GO pinned Busan transfer exclusion drift: ${pinKey}`);
      }
      if (seenExclusions.has(pinKey)) throw new Error(`NO_GO duplicate Busan transfer direction: ${pinKey}`);
      seenExclusions.add(pinKey);
      excludedSourceRows.push({
        fromStationCode: row.fromStationCode, toStationCode: row.toStationCode, dist: row.dist, time: row.time,
        stoppingTime: row.stoppingTime, rawResponseSha256: row.rawResponseSha256, reason: EXCLUSION_REASON,
      });
      continue;
    }
    if (row.stoppingTime !== "0" || from.lineId === to.lineId) {
      throw new Error(`NO_GO Busan transfer row schema mismatch: ${row.fromStationCode}:${row.toStationCode}`);
    }
    const stationId = canonicalStationIdFor(mappings, from);
    if (canonicalStationIdFor(mappings, to) !== stationId) {
      throw new Error(`NO_GO Busan transfer endpoints map to different stations: ${row.fromStationCode}:${row.toStationCode}`);
    }
    for (const lineId of [from.lineId, to.lineId]) {
      if (!membership.has(`${stationId}\0${lineId}`)) throw new Error(`NO_GO Busan transfer station-line is absent: ${stationId}/${lineId}`);
    }
    const distanceUnits = positiveInteger(row.dist);
    const durationSeconds = positiveInteger(row.time);
    if (distanceUnits === null || durationSeconds === null || durationSeconds % DURATION_UNIT_SECONDS !== 0) {
      throw new Error(`NO_GO Busan transfer value precision mismatch: ${row.fromStationCode}:${row.toStationCode}`);
    }
    const key = directionKey(stationId, from.lineId, to.lineId);
    if (records.has(key)) throw new Error(`NO_GO duplicate Busan transfer direction: ${row.fromStationCode}:${row.toStationCode}`);
    records.set(key, {
      stationId,
      fromLineId: from.lineId,
      toLineId: to.lineId,
      fromStationCode: row.fromStationCode,
      toStationCode: row.toStationCode,
      distanceMeters: distanceUnits * DISTANCE_UNIT_METERS,
      officialDurationSeconds: durationSeconds,
      metricProvenance: "OFFICIAL_SOURCE",
      sourceRecordSha256: sha256(canonicalJson({
        sourceId: SOURCE_ID, rawResponseSha256: row.rawResponseSha256, fromStationCode: row.fromStationCode,
        toStationCode: row.toStationCode, dist: row.dist, time: row.time, stoppingTime: row.stoppingTime,
      })),
    });
  }
  for (const pinKey of PINNED_EXCLUSIONS.keys()) {
    if (!seenExclusions.has(pinKey)) throw new Error(`NO_GO pinned Busan transfer exclusion is absent: ${pinKey}`);
  }
  // D4: 원천에 없는 반대 방향은 원천 방향 값을 DERIVED_RECIPROCAL로만 표기한다(원천 행이 아니므로 원천 역 코드는 없다).
  const derived = [...records.values()]
    .filter(({ stationId, fromLineId, toLineId }) => !records.has(directionKey(stationId, toLineId, fromLineId)))
    .map((official) => ({
      stationId: official.stationId,
      fromLineId: official.toLineId,
      toLineId: official.fromLineId,
      distanceMeters: official.distanceMeters,
      officialDurationSeconds: official.officialDurationSeconds,
      metricProvenance: "DERIVED_RECIPROCAL",
      sourceRecordSha256: official.sourceRecordSha256,
      derivedFrom: {
        stationId: official.stationId, fromLineId: official.fromLineId, toLineId: official.toLineId,
        sourceRecordSha256: official.sourceRecordSha256,
      },
    }));
  const metrics = [...records.values(), ...derived].sort((left, right) => compareBytes(
    directionKey(left.stationId, left.fromLineId, left.toLineId), directionKey(right.stationId, right.fromLineId, right.toLineId),
  ));
  excludedSourceRows.sort((left, right) => compareBytes(`${left.fromStationCode}:${left.toStationCode}`, `${right.fromStationCode}:${right.toStationCode}`));
  return { metrics, excludedSourceRows };
}

export function canonicalBusanTransferMetricsJson(artifact) {
  const { artifactSha256, ...payload } = artifact ?? {};
  if (artifact?.artifactKind !== "current-busan-transfer-metrics" || artifactSha256 !== sha256(canonicalJson(payload))) {
    throw new Error("NO_GO Busan transfer metrics artifact digest mismatch");
  }
  return `${canonicalJson(artifact)}\n`;
}

function busanInventorySource(inventory) {
  const matches = (inventory?.sources ?? []).filter(({ id }) => id === SOURCE_ID);
  if (matches.length !== 1) throw new Error("NO_GO Busan transfer inventory source is missing or ambiguous");
  return matches[0];
}

function positiveInteger(value) {
  return typeof value === "string" && /^[1-9]\d{0,5}$/u.test(value) ? Number(value) : null;
}

function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`NO_GO Busan transfer ${label} must be strict UTF-8 JSON`); }
}
function directionKey(stationId, fromLineId, toLineId) { return `${stationId}\0${fromLineId}\0${toLineId}`; }
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
    throw new Error("usage: build-busan-transfer-metrics.mjs --output <absolute absent file>");
  }
  const output = path.resolve(argv[1]);
  await lstat(output).then(() => { throw new Error("output must be absent"); }, (error) => { if (error?.code !== "ENOENT") throw error; });
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const artifact = buildBusanTransferMetrics(await readBusanTransferMetricsInputs({ repositoryRoot }));
  await writeFile(output, canonicalBusanTransferMetricsJson(artifact), { flag: "wx", mode: 0o644 });
  console.log(JSON.stringify({
    metricCount: artifact.metrics.length, excludedSourceRowCount: artifact.excludedSourceRows.length, artifactSha256: artifact.artifactSha256,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
