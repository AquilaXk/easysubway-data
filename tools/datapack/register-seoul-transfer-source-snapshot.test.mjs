import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { registerSeoulTransferSourceSnapshot } from "./register-seoul-transfer-source-snapshot.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const hex = (seed) => sha(Buffer.from(seed));
const canonical = (value) => Buffer.from(`${canonicalJson(value)}\n`);
test("transfer registrar closes the 145-row OCI receipt and 15/30/28+2 applicability identities", () => {
  const capturedAt = "2026-07-12T15:00:00.000Z";
  const observation = { manifest: { sourceId: "seoul-metro-transfer-distance-duration", capturedAt, rawSha256: hex("raw"), contentSha256: hex("content"), schemaSha256: hex("schema"), endpointSha256: hex("endpoint"), rowCount: 145, freshnessDate: "2025-12-31", credentialRedacted: true }, manifestBytes: Buffer.from("manifest"), observationBytes: Buffer.from("observation"), rawBytes: Buffer.from("raw") };
  const metricsPayload = { artifactKind: "current-transfer-topology-metrics", canonicalIdentity: { canonicalPackSha256: hex("pack"), stationLineCount: 213, stationCount: 199, physicalPairCount: 15 }, sourceIdentity: { sourceId: "seoul-metro-transfer-distance-duration", endpointSha256: hex("endpoint"), manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes), rawSnapshotSha256: sha(observation.rawBytes), rawSha256: hex("raw"), contentSha256: hex("content"), schemaSha256: hex("schema"), rowCount: 145, sourceCandidateSha256: hex("candidate"), kricProviderCatalogSha256: hex("catalog"), capturedAt, freshnessDate: "2025-12-31" }, physicalPairs: Array(15).fill({}), metrics: [...Array(28).fill({ metricProvenance: "OFFICIAL_SOURCE" }), ...Array(2).fill({ metricProvenance: "DERIVED_RECIPROCAL" })] };
  const metrics = { ...metricsPayload, artifactSha256: sha(canonicalJson(metricsPayload)) };
  const applicabilityPayload = { artifactKind: "current-capital-transfer-topology-applicability-pre-candidate", productionUseAllowed: false, candidateBinding: null, canonicalIdentity: metrics.canonicalIdentity, sourceIdentity: metrics.sourceIdentity, transferTopologyMetricsIdentity: { artifactSha256: metrics.artifactSha256 }, stateSummary: { APPLICABLE_TRANSFER_ENDPOINT: 27, NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 186 } };
  const applicability = { ...applicabilityPayload, artifactSha256: sha(canonical(applicabilityPayload)) };
  const receipt = { sourceId: "seoul-metro-transfer-distance-duration", capturedAt, snapshotRawSha256: observation.manifest.rawSha256, rawObjectSha256: sha(observation.rawBytes), rawObjectUri: "oci://axvym6vk8g7i/easysubway-datapacks/source-raw/seoul-metro-transfer-distance-duration/20260712/x.json", byteSize: 3, storedAt: "2026-07-12T15:00:01.000Z", rawRetentionExpiresAt: "2026-10-10T15:00:00.000Z" };
  const snapshot = registerSeoulTransferSourceSnapshot({ observation, receipt, metrics, metricsBytes: canonical(metrics), applicability, applicabilityBytes: canonical(applicability), now: new Date("2026-07-12T15:00:01.000Z") });
  assert.equal(snapshot.artifactKind, "seoul-transfer-distance-duration-source-snapshot");
  assert.equal(snapshot.rowCount, 145); assert.equal(snapshot.transferTopology.directedMetricCount, 30);
  const { snapshotSha256: ignored, ...payload } = snapshot;
  assert.equal(snapshot.snapshotSha256, sha(canonical(payload)));
});
