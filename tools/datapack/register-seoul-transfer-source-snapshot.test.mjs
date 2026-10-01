import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { registerSeoulTransferSourceSnapshot } from "./register-seoul-transfer-source-snapshot.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const hex = (seed) => sha(Buffer.from(seed));
const canonical = (value) => Buffer.from(`${canonicalJson(value)}\n`);
test("registration derives topology counts when canonical membership adds a non-transfer station", () => {
  const capturedAt = "2026-07-12T15:00:00.000Z";
  const observation = { manifest: { sourceId: "seoul-metro-transfer-distance-duration", capturedAt, rawSha256: hex("raw"), contentSha256: hex("content"), schemaSha256: hex("schema"), endpointSha256: hex("endpoint"), rowCount: 145, freshnessDate: "2025-12-31", credentialRedacted: true }, manifestBytes: Buffer.from("manifest"), observationBytes: Buffer.from("observation"), rawBytes: Buffer.from("raw") };
  const canonicalIdentity = { canonicalPackSha256: hex("pack"), stationLineCount: 5, stationCount: 3, physicalPairCount: 2 };
  const sourceIdentity = { sourceId: "seoul-metro-transfer-distance-duration", endpointSha256: hex("endpoint"), manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes), rawSnapshotSha256: sha(observation.rawBytes), rawSha256: hex("raw"), contentSha256: hex("content"), schemaSha256: hex("schema"), rowCount: 145, sourceCandidateSha256: hex("candidate"), kricProviderCatalogSha256: hex("catalog"), capturedAt, freshnessDate: "2025-12-31" };
  const physicalPairs = [
    { stationId: "station-a", lineIds: ["line-a", "line-b"] },
    { stationId: "station-b", lineIds: ["line-b", "line-c"] },
  ];
  const metricsPayload = { artifactKind: "current-transfer-topology-metrics", canonicalIdentity, sourceIdentity, physicalPairs, metrics: [
    { stationId: "station-a", fromLineId: "line-a", toLineId: "line-b", metricProvenance: "DERIVED_RECIPROCAL" },
    { stationId: "station-a", fromLineId: "line-b", toLineId: "line-a", metricProvenance: "OFFICIAL_SOURCE" },
    { stationId: "station-b", fromLineId: "line-b", toLineId: "line-c", metricProvenance: "OFFICIAL_SOURCE" },
    { stationId: "station-b", fromLineId: "line-c", toLineId: "line-b", metricProvenance: "DERIVED_RECIPROCAL" },
  ] };
  const metrics = { ...metricsPayload, artifactSha256: sha(canonicalJson(metricsPayload)) };
  const applicabilityPayload = { artifactKind: "current-capital-transfer-topology-applicability-pre-candidate", productionUseAllowed: false, candidateBinding: null, canonicalIdentity: metrics.canonicalIdentity, sourceIdentity: metrics.sourceIdentity, transferTopologyMetricsIdentity: { artifactSha256: metrics.artifactSha256 }, stateSummary: { APPLICABLE_TRANSFER_ENDPOINT: 4, NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 1 }, cells: [
    { stationId: "station-a", lineId: "line-a", state: "APPLICABLE_TRANSFER_ENDPOINT" },
    { stationId: "station-a", lineId: "line-b", state: "APPLICABLE_TRANSFER_ENDPOINT" },
    { stationId: "station-b", lineId: "line-b", state: "APPLICABLE_TRANSFER_ENDPOINT" },
    { stationId: "station-b", lineId: "line-c", state: "APPLICABLE_TRANSFER_ENDPOINT" },
    { stationId: "station-non-transfer", lineId: "line-a", state: "NOT_APPLICABLE_IN_CANONICAL_PAIR_SET" },
  ] };
  const applicability = { ...applicabilityPayload, artifactSha256: sha(canonical(applicabilityPayload)) };
  const receipt = { sourceId: "seoul-metro-transfer-distance-duration", capturedAt, snapshotRawSha256: observation.manifest.rawSha256, rawObjectSha256: sha(observation.rawBytes), rawObjectUri: "oci://axvym6vk8g7i/easysubway-datapacks/source-raw/seoul-metro-transfer-distance-duration/20260712/x.json", byteSize: 3, storedAt: "2026-07-12T15:00:01.000Z", rawRetentionExpiresAt: "2026-10-10T15:00:00.000Z" };
  const snapshot = registerSeoulTransferSourceSnapshot({ observation, receipt, metrics, metricsBytes: canonical(metrics), applicability, applicabilityBytes: canonical(applicability), now: new Date("2026-07-12T15:00:01.000Z") });
  assert.equal(snapshot.artifactKind, "seoul-transfer-distance-duration-source-snapshot");
  assert.equal(snapshot.rowCount, 145);
  assert.deepEqual(snapshot.transferTopology, {
    canonicalPackSha256: hex("pack"), metricsArtifactSha256: metrics.artifactSha256,
    applicabilityArtifactSha256: applicability.artifactSha256, stationLineCount: 5, stationCount: 3,
    physicalPairCount: 2, directedMetricCount: 4, officialMetricCount: 2, derivedReciprocalMetricCount: 2,
    applicableStationLineCount: 4, notApplicableStationLineCount: 1, durationRole: "REFERENCE_ONLY",
  });
  const { snapshotSha256: ignored, ...payload } = snapshot;
  assert.equal(snapshot.snapshotSha256, sha(canonical(payload)));
});

// #872 S2: DERIVED_RECIPROCAL 수는 고정값(2)이 아니라 원천에 반대 방향이 없는 쌍 수다. 쌍마다 OFFICIAL_SOURCE가 하나 이상 있어야 한다.
test("registration은 쌍마다 OFFICIAL_SOURCE가 있으면 DERIVED_RECIPROCAL 수를 지표에서 유도한다", () => {
  const capturedAt = "2026-07-12T15:00:00.000Z";
  const register = (metricRows) => {
    const observation = { manifest: { sourceId: "seoul-metro-transfer-distance-duration", capturedAt, rawSha256: hex("raw"), contentSha256: hex("content"), schemaSha256: hex("schema"), endpointSha256: hex("endpoint"), rowCount: 145, freshnessDate: "2025-12-31", credentialRedacted: true }, manifestBytes: Buffer.from("manifest"), observationBytes: Buffer.from("observation"), rawBytes: Buffer.from("raw") };
    const physicalPairs = [{ stationId: "station-a", lineIds: ["line-a", "line-b"] }, { stationId: "station-b", lineIds: ["line-b", "line-c"] }, { stationId: "station-c", lineIds: ["line-a", "line-c"] }];
    const canonicalIdentity = { canonicalPackSha256: hex("pack"), stationLineCount: 6, stationCount: 3, physicalPairCount: 3 };
    const sourceIdentity = { sourceId: "seoul-metro-transfer-distance-duration", endpointSha256: hex("endpoint"), manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes), rawSnapshotSha256: sha(observation.rawBytes), rawSha256: hex("raw"), contentSha256: hex("content"), schemaSha256: hex("schema"), rowCount: 145, sourceCandidateSha256: hex("candidate"), kricProviderCatalogSha256: hex("catalog"), capturedAt, freshnessDate: "2025-12-31" };
    const metricsPayload = { artifactKind: "current-transfer-topology-metrics", canonicalIdentity, sourceIdentity, physicalPairs, metrics: metricRows };
    const metrics = { ...metricsPayload, artifactSha256: sha(canonicalJson(metricsPayload)) };
    const cells = ["station-a|line-a", "station-a|line-b", "station-b|line-b", "station-b|line-c", "station-c|line-a", "station-c|line-c"].map((cell) => { const [stationId, lineId] = cell.split("|"); return { stationId, lineId, state: "APPLICABLE_TRANSFER_ENDPOINT" }; });
    const applicabilityPayload = { artifactKind: "current-capital-transfer-topology-applicability-pre-candidate", productionUseAllowed: false, candidateBinding: null, canonicalIdentity, sourceIdentity, transferTopologyMetricsIdentity: { artifactSha256: metrics.artifactSha256 }, stateSummary: { APPLICABLE_TRANSFER_ENDPOINT: 6, NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 0 }, cells };
    const applicability = { ...applicabilityPayload, artifactSha256: sha(canonical(applicabilityPayload)) };
    const receipt = { sourceId: "seoul-metro-transfer-distance-duration", capturedAt, snapshotRawSha256: observation.manifest.rawSha256, rawObjectSha256: sha(observation.rawBytes), rawObjectUri: "oci://axvym6vk8g7i/easysubway-datapacks/source-raw/seoul-metro-transfer-distance-duration/20260712/x.json", byteSize: 3, storedAt: "2026-07-12T15:00:01.000Z", rawRetentionExpiresAt: "2026-10-10T15:00:00.000Z" };
    return registerSeoulTransferSourceSnapshot({ observation, receipt, metrics, metricsBytes: canonical(metrics), applicability, applicabilityBytes: canonical(applicability), now: new Date("2026-07-12T15:00:01.000Z") });
  };
  const metric = (stationId, fromLineId, toLineId, metricProvenance) => ({ stationId, fromLineId, toLineId, metricProvenance });
  const snapshot = register([
    metric("station-a", "line-a", "line-b", "OFFICIAL_SOURCE"), metric("station-a", "line-b", "line-a", "OFFICIAL_SOURCE"),
    metric("station-b", "line-b", "line-c", "OFFICIAL_SOURCE"), metric("station-b", "line-c", "line-b", "DERIVED_RECIPROCAL"),
    metric("station-c", "line-a", "line-c", "OFFICIAL_SOURCE"), metric("station-c", "line-c", "line-a", "OFFICIAL_SOURCE"),
  ]);
  assert.deepEqual({ physicalPairCount: snapshot.transferTopology.physicalPairCount, directedMetricCount: snapshot.transferTopology.directedMetricCount, officialMetricCount: snapshot.transferTopology.officialMetricCount, derivedReciprocalMetricCount: snapshot.transferTopology.derivedReciprocalMetricCount }, { physicalPairCount: 3, directedMetricCount: 6, officialMetricCount: 5, derivedReciprocalMetricCount: 1 });
  assert.throws(() => register([
    metric("station-a", "line-a", "line-b", "OFFICIAL_SOURCE"), metric("station-a", "line-b", "line-a", "OFFICIAL_SOURCE"),
    metric("station-b", "line-b", "line-c", "DERIVED_RECIPROCAL"), metric("station-b", "line-c", "line-b", "DERIVED_RECIPROCAL"),
    metric("station-c", "line-a", "line-c", "OFFICIAL_SOURCE"), metric("station-c", "line-c", "line-a", "OFFICIAL_SOURCE"),
  ]), /transfer metrics identity mismatch/);
});
