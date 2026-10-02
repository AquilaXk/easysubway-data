// 서울교통공사 환승 거리·시간 증거를 수도권 정본 팩에 결속한 합성 저장소다(#866).
// 실제 원천 행 대신 합성 145행을 쓰고, 제외·예외 행은 지표 생성기가 고정한 실제 값(연번·행)과 같다.
// 정본 팩·지표·applicability·descriptor·inventory·원장·OCI receipt는 현재 생성기로 만들어 서로 정확히 결속한다.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildApplicability } from "../build-current-capital-transfer-topology-applicability.mjs";
import { rebuildAuthenticatedTransferTopologyMetrics } from "../build-current-transfer-topology-metrics.mjs";
import { registerSeoulTransferSourceSnapshot } from "../register-seoul-transfer-source-snapshot.mjs";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const SEOUL_TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
export const SEOUL_TRANSFER_REBIND_PAR_BASE_URL = "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test-token/n/axvym6vk8g7i/b/easysubway-datapacks/o";
export const SEOUL_TRANSFER_REBIND_PATHS = Object.freeze({
  canonicalPack: "tools/datapack/release/capital-production-canonical-pack.json",
  metrics: "tools/datapack/release/current-transfer-topology-metrics.json",
  applicability: "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  inventory: "tools/datapack/source-inventory.json",
  ledger: "tools/datapack/release/source-snapshots.json",
  sourceCandidates: "tools/datapack/source-candidates.json",
  kricCatalog: "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
});
const FIELDS = ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"];
const LINE = {
  1: ["line-472a81add377", "수도권 1호선"], 2: ["seoul-2", "수도권 2호선"], 3: ["line-41a8c75ec9d8", "수도권 3호선"], 4: ["seoul-4", "수도권 4호선"],
  5: ["line-80fc4d5350d4", "수도권 5호선"], 6: ["line-3f41718e0833", "수도권 6호선"], 7: ["line-15b3b8a93259", "수도권 7호선"], 8: ["line-2b2d9eaa53d0", "수도권 8호선"],
  9: ["line-f0e747248a31", "수도권 9호선"], 공항: ["line-e9e9a5b520a4", "수도권 공항"], 경의중앙: ["line-6e39be0cb6e2", "수도권 경의중앙"], 경춘: ["line-54a7b980b7c3", "수도권 경춘"],
  수인분당: ["line-558d0bd8312d", "수도권 수인분당"], 신분당: ["shinbundang", "수도권 신분당"], 우이신설: ["line-30886152e4f8", "수도권 우이신설"],
  김포골드: ["line-5500c1600f71", "수도권 김포골드라인"], 서해: ["line-051552e50435", "수도권 서해선"], 신림: ["line-aefa08ccc0a9", "수도권 신림선"], GTXA: ["line-8604048b6430", "수도권 GTX-A"],
};
export const seoulTransferFixtureLineId = (key) => LINE[key][0];
const FILLER_STATION_COUNT = 65;
const CAPTURED_AT = "2026-08-15T09:40:38.817Z";
const STORED_AT = "2026-08-16T00:16:05.177Z";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const lineBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const prettyBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
};
const compareBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

export function seoulTransferFixtureCanonicalPack() {
  const stationLines = [];
  const stations = [];
  const station = (stationId, nameKo, lineKeys, extra = {}) => {
    stations.push({ id: stationId, nameKo, ...extra });
    stationLines.push(...lineKeys.map((key) => ({ stationId, lineId: seoulTransferFixtureLineId(key) })));
  };
  station("station-b35616704ce3", "까치산", [2, 5]);
  station("station-gangnam", "강남", [2, "신분당"]);
  station("station-seoul", "서울역", [1, 4, "공항", "경의중앙"]);
  station("station-isu", "총신대입구", [4, 7], { nameSub: "이수" });
  station("station-sindorim", "신도림", [1, 2]);
  station("station-seongsu", "성수", [2]);
  station("station-gangdong", "강동", [5]);
  station("station-suseo", "수서", [3, "수인분당"]);
  station("station-seokgye", "석계", [6, 1]);
  station("station-gimpo", "김포공항", [5, "공항"]);
  station("station-geumjeong", "금정", [1, 4]);
  for (let index = 0; index < FILLER_STATION_COUNT; index += 1) station(`station-filler-${String(index).padStart(2, "0")}`, `환승${String(index).padStart(2, "0")}`, [7, 8]);
  for (const key of [9, "경춘", "우이신설", "김포골드", "서해", "신림", "GTXA"]) station(`station-only-${LINE[key][0]}`, `단일역${LINE[key][0]}`, [key]);
  stations.push({ id: "station-busan", nameKo: "부산역" });
  stationLines.push({ stationId: "station-busan", lineId: "line-ab1a041f6266" });
  const lines = [
    ...Object.values(LINE).map(([lineId, nameKo]) => ({ id: lineId, nameKo, operatorId: "operator-fixture" })),
    { id: "line-ab1a041f6266", nameKo: "부산 1호선", operatorId: "busan-transportation" },
  ];
  return {
    manifest: { manifestVersion: 2, channel: "production", keyId: "fixture-key", ttlSeconds: 1, activePack: { id: "capital", version: "1" } },
    migrationSourceArtifact: { gzipSha256: "a".repeat(64), sqliteSha256: "b".repeat(64) },
    packs: [{
      id: "capital", version: "1", artifactKind: "production", schemaVersion: "1",
      metadata: { productionCoverageEvidence: JSON.stringify([{ regionId: "capital", operatorId: "seoul-metro", sourceDomain: "station_line_membership" }]) },
      stations, lines, stationLines, networkEdges: [{ id: "edge", edgeType: "RIDE" }], operators: [{ id: "seoul-metro", nameKo: "서울교통공사" }],
    }],
  };
}

function row(line, station, to, distance, time = duration(distance)) { return { 호선: line, 환승역명: station, 환승노선: to, 환승거리: distance, 환승소요시간: time }; }
function duration(distance) { const seconds = Math.round(distance / 1.2); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function providerRows() {
  const pinned = new Map([
    [24, row("2호선", "성수", "2호선", 23, "00:19")], [35, row("2호선", "신도림", "2호선", 81, "01:08")], [59, row("3호선", "수서", "국철", 92, "01:17")],
    [79, row("5호선", "김포공항", "공항철도", 122, "04:42")], [102, row("5호선", "강동", "5호선", 19, "00:16")], [107, row("6호선", "석계", "경원선", 125, "01:44")],
  ]);
  const free = [
    row("5호선", "까치산", "2호선", 17), row("2호선", "강남", "신분당선", 214), row("1호선", "서울역", "4호선", 159), row("4호선", "서울역", "1호선", 159),
    row("1호선", "서울역", "공항철도", 309), row("4호선", "서울역", "공항철도", 224), row("4호선", "총신대입구", "7호선", 171), row("7호선", "이수", "4호선", 171),
    row("2호선", "신도림", "1호선", 81),
    ...Array.from({ length: FILLER_STATION_COUNT }, (_, index) => {
      const name = `환승${String(index).padStart(2, "0")}`;
      return [row("7호선", name, "8호선", 100 + index), row("8호선", name, "7호선", 100 + index)];
    }).flat(),
  ];
  const rows = [];
  let next = 0;
  for (let serial = 1; serial <= 145; serial += 1) rows.push({ 연번: serial, ...(pinned.get(serial) ?? free[next++]) });
  if (next !== free.length) throw new Error("fixture provider rows are not exhaustive");
  return rows;
}

// collect-current-seoul-transfer-distance-duration-snapshot의 raw 형식(페이지 2개, 100·45행)과 같다.
function rawSnapshotBytes(rows) {
  const page = (number, data) => {
    const bytes = Buffer.from(JSON.stringify({ currentCount: data.length, data, matchCount: 145, page: number, perPage: 100, totalCount: 145 }));
    return { page: number, perPage: 100, sha256: sha256(bytes), base64: bytes.toString("base64") };
  };
  return lineBytes({ artifactKind: "seoul-transfer-distance-duration-raw-snapshot", sourceId: SEOUL_TRANSFER_SOURCE_ID, pages: [page(1, rows.slice(0, 100)), page(2, rows.slice(100))] });
}

function observationFrom(rows, rawBytes, endpoint) {
  const sorted = [...rows].sort((left, right) => compareBytes(FIELDS.map((field) => left[field]).join("\0"), FIELDS.map((field) => right[field]).join("\0")));
  const manifest = {
    artifactKind: "seoul-transfer-distance-duration-snapshot-manifest", sourceId: SEOUL_TRANSFER_SOURCE_ID, endpointSha256: sha256(endpoint),
    capturedAt: CAPTURED_AT, freshnessDate: "2025-12-31", rowCount: sorted.length, rawSha256: sha256(rawBytes),
    contentSha256: sha256(lineBytes(sorted)), schemaSha256: sha256(lineBytes({ fields: FIELDS })), credentialRedacted: true,
  };
  const observation = {
    artifactKind: "seoul-transfer-distance-duration-observation", sourceId: SEOUL_TRANSFER_SOURCE_ID, capturedAt: CAPTURED_AT,
    rowCount: sorted.length, rawSha256: manifest.rawSha256, contentSha256: manifest.contentSha256, rows: sorted, credentialRedacted: true,
  };
  return { manifest, observation, manifestBytes: lineBytes(manifest), observationBytes: lineBytes(observation) };
}

function receiptFor({ rawBytes, manifestBytes, observationBytes }) {
  const rawSha = sha256(rawBytes);
  const capturedDate = CAPTURED_AT.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${SEOUL_TRANSFER_SOURCE_ID}/${capturedDate}/${rawSha}.json`;
  return {
    schemaVersion: 1, artifactKind: "seoul-transfer-raw-object-receipt", sourceId: SEOUL_TRANSFER_SOURCE_ID,
    snapshotId: `${SEOUL_TRANSFER_SOURCE_ID}-${CAPTURED_AT.replaceAll(/[-:.]/gu, "")}`, snapshotRawSha256: rawSha, capturedAt: CAPTURED_AT,
    manifestSha256: sha256(manifestBytes), observationSha256: sha256(observationBytes),
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`, rawObjectSha256: rawSha, ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks", objectKey, capturedDate, byteSize: rawBytes.length, storedAt: STORED_AT,
    rawRetentionExpiresAt: "2026-11-13T09:40:38.817Z",
  };
}

// 현재 생성기로 지표·applicability·descriptor를 만든다. 정본 팩 바이트만 바꿔 다시 부르면 재결속 기대값이 된다.
export function deriveSeoulTransferFixtureEvidence({ canonicalPackBytes, sourceCandidatesBytes, kricCatalogBytes, rawBytes, receipt, observation }) {
  const canonicalPack = JSON.parse(canonicalPackBytes);
  const metrics = rebuildAuthenticatedTransferTopologyMetrics({
    canonicalPack, canonicalPackBytes, sourceCandidatesBytes, kricCatalogBytes,
    observation: {
      manifest: observation.manifest, observation: observation.observation, raw: JSON.parse(rawBytes),
      bytes: { manifest: observation.manifestBytes, observation: observation.observationBytes, raw: rawBytes },
    },
  });
  const metricsBytes = lineBytes(metrics);
  const applicability = buildApplicability({ canonicalPack, canonicalPackBytes, transferTopologyMetrics: metrics, metricsBytes });
  const applicabilityBytes = lineBytes(applicability);
  const descriptor = registerSeoulTransferSourceSnapshot({
    observation: { manifest: observation.manifest, manifestBytes: observation.manifestBytes, observationBytes: observation.observationBytes, rawBytes },
    receipt, metrics, metricsBytes, applicability, applicabilityBytes, now: new Date(receipt.storedAt),
  });
  return { metrics, metricsBytes, applicability, applicabilityBytes, descriptor, descriptorBytes: prettyBytes(descriptor) };
}

// root 아래에 결속이 맞는 합성 저장소를 쓴다. rawBytes는 OCI에 잠긴 원본(가짜 PAR client가 돌려줄 바이트)이다.
export async function writeSeoulTransferRebindRepository(root) {
  const canonicalPack = seoulTransferFixtureCanonicalPack();
  const canonicalPackBytes = lineBytes(canonicalPack);
  const [sourceCandidatesBytes, kricCatalogBytes] = await Promise.all([
    readFile(path.join(REPOSITORY_ROOT, SEOUL_TRANSFER_REBIND_PATHS.sourceCandidates)),
    readFile(path.join(REPOSITORY_ROOT, SEOUL_TRANSFER_REBIND_PATHS.kricCatalog)),
  ]);
  const endpoint = JSON.parse(sourceCandidatesBytes).candidates.find(({ id }) => id === SEOUL_TRANSFER_SOURCE_ID).requestUrl;
  const rows = providerRows();
  const rawBytes = rawSnapshotBytes(rows);
  const observation = observationFrom(rows, rawBytes, endpoint);
  const receipt = receiptFor({ rawBytes, ...observation });
  const evidence = deriveSeoulTransferFixtureEvidence({ canonicalPackBytes, sourceCandidatesBytes, kricCatalogBytes, rawBytes, receipt, observation });
  const { descriptor, descriptorBytes } = evidence;
  const topology = descriptor.transferTopology;
  const descriptorPath = `tools/datapack/sources/${descriptor.snapshotId}.json`;
  const inventory = {
    schemaVersion: 1,
    sources: [
      { id: "unrelated-source", requiredForProductionPack: true, admissionEvidence: { adminReviewRecordHash: "e".repeat(64) } },
      {
        id: SEOUL_TRANSFER_SOURCE_ID, requiredForProductionPack: true,
        admissionEvidence: { adminReviewRecordHash: "f".repeat(64), licenseEvidenceHash: "1".repeat(64) },
        capabilities: { transfer: { status: "SUPPORTED", coverageStatus: `CAPITAL_SEOUL_METRO_${topology.physicalPairCount}_PAIRS_${topology.directedMetricCount}_DIRECTED_METRICS` } },
        transferAdmissionEvidence: {
          artifactKind: "transfer-source-admission-evidence", approvalIssue: 350, decision: "APPROVED", approvedBy: "AquilaXk",
          approvedAt: "2026-08-21T08:47:48.289Z", productionUseAllowed: true, snapshotId: descriptor.snapshotId, snapshotPath: descriptorPath,
          snapshotFileSha256: sha256(descriptorBytes), capturedAt: CAPTURED_AT, observedAt: CAPTURED_AT, freshUntil: descriptor.freshUntil,
          sourceEffectiveDate: "2025-12-31", rawSha256: descriptor.rawSha256, contentSha256: descriptor.contentSha256,
          schemaFingerprint: descriptor.schemaFingerprint, metricsPath: SEOUL_TRANSFER_REBIND_PATHS.metrics,
          metricsArtifactSha256: topology.metricsArtifactSha256, applicabilityPath: SEOUL_TRANSFER_REBIND_PATHS.applicability,
          applicabilityArtifactSha256: topology.applicabilityArtifactSha256, rowCount: 145, physicalPairCount: topology.physicalPairCount,
          directedMetricCount: topology.directedMetricCount, officialMetricCount: topology.officialMetricCount,
          derivedReciprocalMetricCount: topology.derivedReciprocalMetricCount, stationLineCount: topology.stationLineCount,
          applicableStationLineCount: topology.applicableStationLineCount, notApplicableStationLineCount: topology.notApplicableStationLineCount,
          durationRole: "REFERENCE_ONLY", licenseEvidenceHash: "1".repeat(64),
        },
      },
    ],
  };
  const ledger = [
    { sourceId: "unrelated-source", snapshotId: "unrelated-source-20261002", snapshotStatus: "LOCKED", fetchStatus: "SUCCESS", rawSha256: "2".repeat(64) },
    {
      sourceId: SEOUL_TRANSFER_SOURCE_ID, snapshotId: descriptor.snapshotId, snapshotStatus: "LOCKED", fetchStatus: "SUCCESS",
      rowCount: 145, coverageCount: topology.directedMetricCount, rawSha256: receipt.rawObjectSha256, contentSha256: descriptor.contentSha256,
      rawObjectUri: receipt.rawObjectUri, schemaFingerprint: descriptor.schemaFingerprint, rawReceipt: receipt, transferTopology: topology,
    },
  ];
  const files = new Map([
    [SEOUL_TRANSFER_REBIND_PATHS.canonicalPack, canonicalPackBytes],
    [SEOUL_TRANSFER_REBIND_PATHS.sourceCandidates, sourceCandidatesBytes],
    [SEOUL_TRANSFER_REBIND_PATHS.kricCatalog, kricCatalogBytes],
    [SEOUL_TRANSFER_REBIND_PATHS.metrics, evidence.metricsBytes],
    [SEOUL_TRANSFER_REBIND_PATHS.applicability, evidence.applicabilityBytes],
    [descriptorPath, descriptorBytes],
    [SEOUL_TRANSFER_REBIND_PATHS.inventory, prettyBytes(inventory)],
    [SEOUL_TRANSFER_REBIND_PATHS.ledger, prettyBytes(ledger)],
  ]);
  for (const [relative, bytes] of files) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
  }
  return { rawBytes, receipt, observation, descriptorPath, sourceCandidatesBytes, kricCatalogBytes, canonicalPack, ...evidence };
}

// 일일 갱신의 activate 단계처럼 환승 분모(서울교통공사·상대 노선 역-노선)와 무관한 정본 팩 내용만 바꾼다.
export async function rewriteSeoulTransferFixtureCanonicalPack(root, mutate) {
  const file = path.join(root, SEOUL_TRANSFER_REBIND_PATHS.canonicalPack);
  const pack = JSON.parse(await readFile(file));
  mutate(pack);
  const bytes = lineBytes(pack);
  await writeFile(file, bytes);
  return bytes;
}

export { sortValue as sortSeoulTransferFixtureValue };
