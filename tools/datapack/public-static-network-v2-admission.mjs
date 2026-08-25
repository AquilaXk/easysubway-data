import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import {
  CURRENT_MOLIT_FULL_ROUTE_ROW_COUNT,
  CURRENT_SEOUL_PUBLIC_POSITION_COUNT,
  assertCurrentMolitFullRouteCompleteness,
  assertCurrentSeoulPositionProjectionCompleteness,
} from "./lib/static-network-successor-completeness.mjs";

const V2 = "seoul-public-latlon-line-order-layout-v2";
const SHA = /^[a-f0-9]{64}$/u;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const fail = (code) => { throw new Error(`V2_${code}`); };
const CANONICAL_PROVIDERS = Object.freeze({
  "seoul-metro-route-map-positions": "공공데이터포털",
  "molit-urban-rail-full-route": "국토교통부",
});
const V2_SOURCE_CONFIG = Object.freeze({
  "seoul-metro-route-map-positions": {
    count: CURRENT_SEOUL_PUBLIC_POSITION_COUNT, extension: "json", contentType: "application/json",
    assertCompleteness: assertCurrentSeoulPositionProjectionCompleteness,
  },
  "molit-urban-rail-full-route": {
    count: CURRENT_MOLIT_FULL_ROUTE_ROW_COUNT, extension: "csv", contentType: "text/csv; charset=euc-kr",
    assertCompleteness: assertCurrentMolitFullRouteCompleteness,
  },
});
function assertNoLegacySelectedSurface(value) {
  const visit = (current) => {
    if (typeof current === "string") {
      if (/(?:cyber|\.js(?:\b|$)|s3:\/\/|amazonaws\.com)/iu.test(current)) fail("MISSING");
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (["projectionMigration", "migration", "rootSupersession", "historicalPredecessorAudit"].includes(key)) fail("MISSING");
      visit(child);
    }
  };
  visit(value);
}
function isCanonicalOuterSnapshot(snapshot, { now = new Date(), requireCurrentFreshness = false } = {}) {
  let retrievedAt; let sourceUpdatedAt; let freshnessExpiresAt; let rawRetentionExpiresAt;
  let receiptStoredAt; let receiptCapturedAt; let nowMillis;
  try {
    retrievedAt = requiredUtcInstant(snapshot?.retrievedAt, "public static snapshot retrievedAt");
    sourceUpdatedAt = requiredUtcInstant(snapshot?.sourceUpdatedAt, "public static snapshot sourceUpdatedAt");
    freshnessExpiresAt = requiredUtcInstant(snapshot?.freshnessExpiresAt, "public static snapshot freshnessExpiresAt");
    rawRetentionExpiresAt = requiredUtcInstant(snapshot?.rawRetentionExpiresAt, "public static snapshot rawRetentionExpiresAt");
    receiptStoredAt = requiredUtcInstant(snapshot?.rawReceipt?.storedAt, "public static receipt storedAt");
    receiptCapturedAt = requiredUtcInstant(snapshot?.rawReceipt?.capturedAt, "public static receipt capturedAt");
    nowMillis = now instanceof Date ? now.getTime() : requiredUtcInstant(now, "public static validation now");
  } catch { return false; }
  return snapshot?.schemaVersion === 1
    && snapshot.artifactKind === "official-source-snapshot"
    && typeof snapshot.snapshotId === "string" && snapshot.snapshotId !== ""
    && snapshot.provider === CANONICAL_PROVIDERS[snapshot.sourceId]
    && snapshot.snapshotStatus === "LOCKED"
    && snapshot.schemaStatus === "PASS"
    && snapshot.licenseStatus === "PASS"
    && snapshot.fetchStatus === "SUCCESS"
    && snapshot.redistributionAllowed === true
    && snapshot.credentialRedacted === true
    && SHA.test(snapshot.redactedRequestFingerprint ?? "")
    && typeof snapshot.governancePolicyVersion === "string" && snapshot.governancePolicyVersion !== ""
    && SHA.test(snapshot.governancePolicySha256 ?? "")
    && snapshot.rawReceipt?.capturedAt === snapshot.retrievedAt
    && snapshot.rawReceipt?.rawRetentionExpiresAt === snapshot.rawRetentionExpiresAt
    && sourceUpdatedAt <= retrievedAt
    && receiptStoredAt >= receiptCapturedAt && receiptStoredAt <= nowMillis
    && freshnessExpiresAt > retrievedAt && rawRetentionExpiresAt > receiptStoredAt
    && (!requireCurrentFreshness || (freshnessExpiresAt > nowMillis && rawRetentionExpiresAt > nowMillis));
}

export function requireCanonicalPublicStaticNetworkV2OuterSnapshot({ snapshot, now, requireCurrentFreshness = false } = {}) {
  if (!isCanonicalOuterSnapshot(snapshot, { now, requireCurrentFreshness })) throw new Error("current v2 successor canonical outer snapshot is invalid");
  return snapshot;
}

export function requireExactPublicStaticNetworkV2SnapshotBinding({ snapshot, source, now, requireCurrentFreshness = false } = {}) {
  const config = V2_SOURCE_CONFIG[snapshot?.sourceId];
  const observation = snapshot?.publicStaticNetworkV2Observation;
  const date = snapshot?.retrievedAt?.slice(0, 10).replaceAll("-", "");
  const objectKey = config == null || date == null
    ? null
    : `source-raw/${snapshot.sourceId}/${date}/${snapshot.rawSha256}.${config.extension}`;
  const receipt = snapshot?.rawReceipt;
  assertNoLegacySelectedSurface({ snapshot, observation, source });
  requireCanonicalPublicStaticNetworkV2OuterSnapshot({ snapshot, now, requireCurrentFreshness });
  if (!config
    || observation?.schemaVersion !== 2
    || observation.artifactKind !== "public-static-network-v2-observation"
    || observation.sourceId !== snapshot.sourceId
    || observation.snapshotId !== snapshot.snapshotId
    || observation.capturedAt !== snapshot.retrievedAt
    || observation.rawSha256 !== snapshot.rawSha256
    || observation.contentSha256 !== snapshot.contentSha256
    || observation.schemaFingerprint !== snapshot.schemaFingerprint
    || observation.rowCount !== snapshot.rowCount
    || !Array.isArray(observation.normalizedProjection)
    || observation.rowCount !== observation.normalizedProjection.length
    || observation.contentSha256 !== sha(bytes(observation.normalizedProjection))
    || !Array.isArray(observation.providerRecordHashes)
    || !isDeepStrictEqual(observation.providerRecordHashes, snapshot.providerRecordHashes)
    || !observation.providerRecordHashes.every((hash) => SHA.test(hash))
    || !isDeepStrictEqual(observation.providerRecordHashes, observation.normalizedProjection.map((record) => sha(JSON.stringify(record))))
    || !isDeepStrictEqual(observation.rawReceipt, receipt)
    || snapshot.normalizedObservationSha256 !== sha(bytes(observation))
    || snapshot.rowCount !== config.count || snapshot.coverageCount !== config.count
    || !Array.isArray(snapshot.providerRecordHashes) || snapshot.providerRecordHashes.length !== config.count
    || receipt?.schemaVersion !== 1
    || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== snapshot.sourceId
    || receipt.snapshotId !== snapshot.snapshotId
    || receipt.capturedAt !== snapshot.retrievedAt
    || receipt.rawObjectSha256 !== snapshot.rawSha256
    || receipt.rawObjectUri !== snapshot.rawObjectUri
    || receipt.ociNamespace !== "axvym6vk8g7i"
    || receipt.bucket !== "easysubway-datapacks"
    || receipt.objectKey !== objectKey
    || receipt.contentType !== config.contentType
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 1
    || source?.id !== snapshot.sourceId
    || source.admissionEvidence?.decision !== "APPROVED"
    || source.admissionEvidence?.sourceId !== snapshot.sourceId
    || source.admissionEvidence?.snapshotId !== snapshot.snapshotId
    || source.admissionEvidence?.rawSha256 !== snapshot.rawSha256
    || source.admissionEvidence?.schemaFingerprint !== snapshot.schemaFingerprint
    || source.requiredForProductionPack !== true || source.productionUseAllowed !== true) fail("MISSING");
  config.assertCompleteness(observation.normalizedProjection);
  if (snapshot.sourceId === "seoul-metro-route-map-positions") {
    requirePublicStaticNetworkV2Admission({ positions: snapshot, positionSource: source });
  }
  return { snapshot, observation, source };
}

export function requirePublicStaticNetworkV2Admission({ positions, positionSource } = {}) {
  const layout = positions?.routeMapLayoutEvidence;
  const artifact = positions?.routeMapLayoutArtifact;
  const admission = positionSource?.routeMapAdmissionEvidence?.currentLayoutAdmission;
  const observation = positions?.publicStaticNetworkV2Observation;
  const keys = ["layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256", "topologySnapshotIdentity", "lineOrderSha256", "aliasLedgerVersion", "aliasLedgerSha256", "rawPositionsSha256", "layoutPositionsSha256", "layoutTracksSha256", "semanticInputSha256", "semanticOutputSha256", "outputSchemaSha256", "layoutArtifactSha256"];
  assertNoLegacySelectedSurface({ positions, observation, positionSource });
  if (!layout || !artifact || !admission
    || layout.layoutAlgorithmVersion !== V2
    || artifact.layoutAlgorithmVersion !== V2
    || admission.layoutAlgorithmVersion !== V2
    || observation?.schemaVersion !== 2
    || observation.artifactKind !== "public-static-network-v2-observation"
    || observation.sourceId !== positions.sourceId
    || observation.snapshotId !== positions.snapshotId
    || observation.capturedAt !== positions.retrievedAt
    || observation.rawSha256 !== positions.rawSha256
    || observation.contentSha256 !== positions.contentSha256
    || observation.rowCount !== positions.rowCount
    || positions.normalizedObservationSha256 !== sha(bytes(observation))
    || JSON.stringify(observation.routeMapLayoutEvidence) !== JSON.stringify(layout)
    || JSON.stringify(observation.routeMapLayoutArtifact) !== JSON.stringify(artifact)
    || layout.layoutArtifactSha256 !== sha(bytes(artifact))
    || keys.some((key) => layout[key] == null || admission[key] !== layout[key]
      || (key !== "layoutArtifactSha256" && artifact[key] !== layout[key]))
    || !keys.filter((key) => key.endsWith("Sha256")).every((key) => SHA.test(layout[key] ?? ""))
    || admission.schemaVersion !== 2
    || admission.artifactKind !== "seoul-public-route-map-layout-admission"
    || admission.status !== "ADMITTED"
    || admission.positionSnapshotId !== positions.snapshotId
    || admission.snapshotPath !== `tools/datapack/sources/${positions.snapshotId}.json`
    || admission.snapshotSha256 !== positions.normalizedObservationSha256
    || admission.rawSha256 !== positions.rawSha256
    || admission.contentSha256 !== positions.contentSha256) fail("MISSING");
  return { layout, admission };
}
