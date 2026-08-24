import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { requirePublicStaticNetworkV2Admission } from "./public-static-network-v2-admission.mjs";

function valid() {
  const layoutAlgorithmVersion = "seoul-public-latlon-line-order-layout-v2";
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const keys = { layoutAlgorithmVersion, topologySnapshotId: "capital-route-topology-20260823", topologySnapshotSha256: "1".repeat(64), topologySnapshotIdentity: `capital-route-topology-20260823:${"1".repeat(64)}`, lineOrderSha256: "2".repeat(64), aliasLedgerVersion: "v1", aliasLedgerSha256: "3".repeat(64), rawPositionsSha256: "4".repeat(64), layoutPositionsSha256: "5".repeat(64), layoutTracksSha256: "6".repeat(64), semanticInputSha256: "7".repeat(64), semanticOutputSha256: "8".repeat(64), outputSchemaSha256: "9".repeat(64) };
  const artifact = { ...keys, rawSha256: "a".repeat(64) }; const layout = { ...keys, layoutArtifactSha256: sha(Buffer.from(`${JSON.stringify(artifact)}\n`)) };
  const observation = { schemaVersion: 2, artifactKind: "public-static-network-v2-observation", sourceId: "seoul-metro-route-map-positions", snapshotId: "positions-current", capturedAt: "2026-08-25T00:00:00.000Z", rawSha256: artifact.rawSha256, contentSha256: "b".repeat(64), rowCount: 276, routeMapLayoutEvidence: layout, routeMapLayoutArtifact: artifact };
  const positions = { ...structuredClone(observation), retrievedAt: observation.capturedAt, normalizedObservationSha256: sha(Buffer.from(`${JSON.stringify(observation)}\n`)), publicStaticNetworkV2Observation: observation };
  const admission = { schemaVersion: 2, artifactKind: "seoul-public-route-map-layout-admission", status: "ADMITTED", positionSnapshotId: positions.snapshotId, snapshotPath: `tools/datapack/sources/${positions.snapshotId}.json`, snapshotSha256: positions.normalizedObservationSha256, rawSha256: positions.rawSha256, contentSha256: positions.contentSha256, ...layout };
  return { positions, positionSource: { routeMapAdmissionEvidence: { currentLayoutAdmission: admission } } };
}

test("v2 admission requires all three layout bindings", () => {
  const { positions, positionSource } = valid();
  const result = requirePublicStaticNetworkV2Admission({ positions, positionSource });
  assert.equal(result.layout, positions.routeMapLayoutEvidence);
  assert.equal(result.admission, positionSource.routeMapAdmissionEvidence.currentLayoutAdmission);
});

test("v2 admission fails closed when a layout binding is absent or wrong", () => {
  assert.throws(() => requirePublicStaticNetworkV2Admission({}), /V2_MISSING/);
  for (const mutate of [
    (value) => { delete value.positions.routeMapLayoutEvidence; },
    (value) => { value.positions.routeMapLayoutArtifact.layoutAlgorithmVersion = "wrong"; },
    (value) => { value.positionSource.routeMapAdmissionEvidence.currentLayoutAdmission.layoutAlgorithmVersion = "wrong"; },
    (value) => { value.positions.projectionMigration = { migrationKind: "CROSS_SOURCE_CANONICAL_REPLACEMENT" }; },
  ]) { const value = valid(); mutate(value); assert.throws(() => requirePublicStaticNetworkV2Admission(value), /V2_MISSING/); }
});

test("v2 admission permits opaque historical predecessor audit only", () => {
  const value = valid();
  value.positions.publicStaticNetworkV2Observation.historicalPredecessorAudit = { archivedUri: "s3://audit-only" };
  value.positions.normalizedObservationSha256 = createHash("sha256")
    .update(Buffer.from(`${JSON.stringify(value.positions.publicStaticNetworkV2Observation)}\n`)).digest("hex");
  value.positionSource.routeMapAdmissionEvidence.currentLayoutAdmission.snapshotSha256 = value.positions.normalizedObservationSha256;
  const result = requirePublicStaticNetworkV2Admission(value);
  assert.equal(result.admission.positionSnapshotId, value.positions.snapshotId);
});
