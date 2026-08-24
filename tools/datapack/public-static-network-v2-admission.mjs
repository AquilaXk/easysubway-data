import { createHash } from "node:crypto";

import { SEOUL_POSITION_SCHEMA_FINGERPRINT } from "./collect-current-static-network-successors.mjs";
import { CURRENT_SEOUL_PUBLIC_POSITION_COUNT } from "./lib/static-network-successor-completeness.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const V2 = "seoul-public-latlon-line-order-layout-v2";
const SHA = /^[a-f0-9]{64}$/u;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const fail = (code) => { throw new Error(`V2_${code}`); };
const LEGACY_PUBLIC_SOURCE_ID = "seoul-metro-route-map-positions";
const LEGACY_CYBER_SOURCE_ID = "seoulmetro-cyberstation-route-map";
const CANONICAL_PROVIDERS = Object.freeze({
  "seoul-metro-route-map-positions": "공공데이터포털",
  "molit-urban-rail-full-route": "국토교통부",
});
const LEGACY_LAYOUT_KEYS = Object.freeze([
  "layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256",
  "topologySnapshotIdentity", "lineOrderSha256", "aliasLedgerVersion", "aliasLedgerSha256",
  "rawPositionsSha256", "layoutPositionsSha256", "layoutTracksSha256", "semanticInputSha256",
  "semanticOutputSha256", "outputSchemaSha256", "layoutArtifactSha256",
]);
const LEGACY_MIGRATION_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "migrationKind", "sourceId", "replacedSourceId",
  "replacedSnapshotId", "replacedRawSha256", "replacedSchemaFingerprint", "candidateSlotSourceId",
]);
const exactKeys = (value, keys) => value != null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

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

// A v2 positions root may supersede exactly the approved public v1 root. This
// preserves the historical Cyber reference as immutable audit evidence without
// allowing an arbitrary non-v2 record to seed a new canonical root.
export function requireApprovedLegacyV1PublicPositionsPredecessor({ sourceSnapshots, positions, now } = {}) {
  const migration = positions?.projectionMigration;
  const replaced = Array.isArray(sourceSnapshots)
    ? sourceSnapshots.filter(({ snapshotId }) => snapshotId === migration?.replacedSnapshotId)
    : [];
  const receipt = positions?.rawReceipt;
  const date = positions?.retrievedAt?.slice(0, 10).replaceAll("-", "");
  const objectKey = date == null ? null : `source-raw/${LEGACY_PUBLIC_SOURCE_ID}/${date}/${positions.rawSha256}.json`;
  const layout = positions?.routeMapLayoutEvidence;
  const artifact = positions?.routeMapLayoutArtifact;
  const providerHashes = positions?.providerRecordHashes;
  if (!isCanonicalOuterSnapshot(positions, { now })
    || positions.sourceId !== LEGACY_PUBLIC_SOURCE_ID
    || positions.publicStaticNetworkV2Observation != null
    || positions.previousSnapshotId !== null || positions.diffSummary !== null || positions.rootSupersession != null
    || positions.rowCount !== CURRENT_SEOUL_PUBLIC_POSITION_COUNT
    || positions.coverageCount !== CURRENT_SEOUL_PUBLIC_POSITION_COUNT
    || positions.schemaFingerprint !== SEOUL_POSITION_SCHEMA_FINGERPRINT
    || !SHA.test(positions.rawSha256 ?? "") || !SHA.test(positions.contentSha256 ?? "")
    || !SHA.test(positions.normalizedObservationSha256 ?? "")
    || !Array.isArray(providerHashes) || providerHashes.length !== CURRENT_SEOUL_PUBLIC_POSITION_COUNT
    || providerHashes.some((value) => !SHA.test(value ?? ""))
    || !exactKeys(migration, LEGACY_MIGRATION_KEYS)
    || migration.schemaVersion !== 1 || migration.artifactKind !== "source-projection-migration-evidence"
    || migration.migrationKind !== "CROSS_SOURCE_CANONICAL_REPLACEMENT"
    || migration.sourceId !== LEGACY_PUBLIC_SOURCE_ID
    || migration.replacedSourceId !== LEGACY_CYBER_SOURCE_ID
    || migration.candidateSlotSourceId !== LEGACY_CYBER_SOURCE_ID
    || replaced.length !== 1 || replaced[0].sourceId !== LEGACY_CYBER_SOURCE_ID
    || migration.replacedRawSha256 !== replaced[0].rawSha256
    || migration.replacedSchemaFingerprint !== replaced[0].schemaFingerprint
    || !SHA.test(migration.replacedRawSha256 ?? "") || !SHA.test(migration.replacedSchemaFingerprint ?? "")
    || positions.rawObjectUri !== `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`
    || !exactKeys(receipt, ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt", "ociNamespace", "bucket", "objectKey", "contentType"])
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== positions.sourceId || receipt.snapshotId !== positions.snapshotId
    || receipt.capturedAt !== positions.retrievedAt || receipt.rawObjectSha256 !== positions.rawSha256
    || receipt.rawObjectUri !== positions.rawObjectUri || receipt.ociNamespace !== "axvym6vk8g7i"
    || receipt.bucket !== "easysubway-datapacks" || receipt.objectKey !== objectKey
    || receipt.contentType !== "application/json" || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 1
    || receipt.rawRetentionExpiresAt !== positions.rawRetentionExpiresAt
    || !exactKeys(layout, LEGACY_LAYOUT_KEYS)
    || layout.layoutAlgorithmVersion !== V2
    || layout.topologySnapshotIdentity !== `${layout.topologySnapshotId}:${layout.topologySnapshotSha256}`
    || !LEGACY_LAYOUT_KEYS.filter((key) => key.endsWith("Sha256")).every((key) => SHA.test(layout[key] ?? ""))
    || !artifact || artifact.rawSha256 !== positions.rawSha256
    || layout.layoutArtifactSha256 !== sha(bytes(artifact))
    || LEGACY_LAYOUT_KEYS.filter((key) => key !== "layoutArtifactSha256")
      .some((key) => artifact[key] !== layout[key])) {
    throw new Error("legacy v1 public positions predecessor is invalid");
  }
  return { positions, replaced: replaced[0] };
}

// This is deliberately additive: predecessor lineage, CAS and OCI receipt
// validation remain owned by the caller and must already have passed.
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
    || positions.projectionMigration != null || observation.projectionMigration != null || observation.migration != null
    || positions.normalizedObservationSha256 !== sha(bytes(observation))
    || JSON.stringify(observation.routeMapLayoutEvidence) !== JSON.stringify(layout)
    || JSON.stringify(observation.routeMapLayoutArtifact) !== JSON.stringify(artifact)
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
