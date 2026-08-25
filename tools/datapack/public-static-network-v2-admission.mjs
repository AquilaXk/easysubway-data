import { createHash } from "node:crypto";

import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const V2 = "seoul-public-latlon-line-order-layout-v2";
const SHA = /^[a-f0-9]{64}$/u;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const fail = (code) => { throw new Error(`V2_${code}`); };
const CANONICAL_PROVIDERS = Object.freeze({
  "seoul-metro-route-map-positions": "공공데이터포털",
  "molit-urban-rail-full-route": "국토교통부",
});
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

export function requirePublicStaticNetworkV2Admission({ positions, positionSource } = {}) {
  const layout = positions?.routeMapLayoutEvidence;
  const artifact = positions?.routeMapLayoutArtifact;
  const admission = positionSource?.routeMapAdmissionEvidence?.currentLayoutAdmission;
  const observation = positions?.publicStaticNetworkV2Observation;
  const keys = ["layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256", "topologySnapshotIdentity", "lineOrderSha256", "aliasLedgerVersion", "aliasLedgerSha256", "rawPositionsSha256", "layoutPositionsSha256", "layoutTracksSha256", "semanticInputSha256", "semanticOutputSha256", "outputSchemaSha256", "layoutArtifactSha256"];
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
    || observation.historicalPredecessorAudit != null || positions.historicalPredecessorAudit != null
    || positions.projectionMigration != null || observation.projectionMigration != null || observation.migration != null
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
