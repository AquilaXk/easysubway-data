import assert from "node:assert/strict";
import test from "node:test";

import { productionAccessibilityFreshUntil } from "./build-datapack.mjs";

test("accessibility freshness ignores ordinary walk edges", (t) => {
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = "2026-07-28T00:00:00.000Z";
  t.after(() => {
    if (previousBuildNow === undefined) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  });

  const freshUntil = productionAccessibilityFreshUntil([{
    facilities: [],
    stationFacilityEvidence: [],
    networkEdges: [
      { edgeType: "WALK", sourceId: "topology", sourceSnapshotId: "topology-snapshot" },
      { edgeType: "ENTRY", sourceId: "accessibility", sourceSnapshotId: "accessibility-snapshot" },
    ],
  }], {
    sources: [{ id: "accessibility", accessibilityAdmissionEvidence: {
      snapshotId: "accessibility-snapshot", freshUntil: "2026-07-28T00:00:00.000Z",
    } }],
  }, [{
    sourceId: "accessibility", snapshotId: "accessibility-snapshot",
    freshnessExpiresAt: "2026-08-28T00:00:00.000Z",
  }]);

  assert.equal(freshUntil, "2026-08-28T00:00:00.000Z");
});

test("accessibility freshness fails closed at the locked snapshot policy boundary", (t) => {
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = "2026-07-28T00:00:00.000Z";
  t.after(() => {
    if (previousBuildNow === undefined) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  });

  assert.throws(() => productionAccessibilityFreshUntil([{
    facilities: [{ sourceId: "accessibility", sourceSnapshotId: "accessibility-snapshot" }],
  }], {
    sources: [{ id: "accessibility", accessibilityAdmissionEvidence: {
      snapshotId: "accessibility-snapshot", freshUntil: "2026-07-29T00:00:00.000Z",
    } }],
  }, [{
    sourceId: "accessibility", snapshotId: "accessibility-snapshot",
    freshnessExpiresAt: "2026-07-28T00:00:00.000Z",
  }]), /production accessibility snapshot is stale: accessibility/);
});

test("accessibility freshness reports missing admission without a TypeError", () => {
  assert.throws(() => productionAccessibilityFreshUntil([{
    facilities: [{ sourceId: "missing", sourceSnapshotId: undefined }],
  }], { sources: [] }, []), /production accessibility evidence mismatch: missing/);
});

test("registered Incheon accessibility freshness uses the generic candidate projection", () => {
  const sourceId = "incheon-transit-accessibility";
  const snapshotId = "incheon-transit-accessibility-20260828T043356000Z";
  const evidenceHash = "a".repeat(64);
  const schemaFingerprint = "b".repeat(64);
  const claimBindingsSha256 = "c".repeat(64);
  const adminReviewRecordHash = "d".repeat(64);
  const rawSha256 = "e".repeat(64);
  const source = {
    id: sourceId,
    requiredForProductionPack: true,
    productionUseAllowed: true,
    license: { redistributionAllowed: true },
    admissionEvidence: { sampleEvidenceHash: evidenceHash, adminReviewRecordHash },
    registrationEvidence: {
      sourceId,
      snapshotId,
      rawObjectUri: "oci://example/incheon.json",
      rawObjectSha256: rawSha256,
      normalizedSchemaFingerprint: schemaFingerprint,
      claimBindingsSha256,
      adminReviewRecordHash,
    },
  };
  const admission = { source, snapshotId, evidenceHash };
  assert.equal(productionAccessibilityFreshUntil([{
    facilities: [{ sourceId, sourceSnapshotId: snapshotId, evidenceHash }],
  }], { sources: [source] }, [{
    sourceId,
    snapshotId,
    rawObjectUri: "oci://example/incheon.json",
    rawSha256,
    schemaFingerprint,
    adminReviewRecordHash,
    licenseStatus: "PASS",
    redistributionAllowed: true,
    credentialRedacted: true,
    snapshotStatus: "LOCKED",
    freshnessExpiresAt: "2026-08-28T00:00:00.000Z",
  }], new Date("2026-07-28T00:00:00.000Z"), {
    admittedNonLedgerAccessibility: new Map([[sourceId, admission]]),
  }), "2026-08-28T00:00:00.000Z");
});
