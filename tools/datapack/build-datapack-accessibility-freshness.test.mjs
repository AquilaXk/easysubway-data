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
