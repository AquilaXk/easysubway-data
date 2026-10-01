import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPITAL_ROUTE_TOPOLOGY_SNAPSHOT_PATH_PATTERN,
  CAPITAL_TOPOLOGY_REVERIFICATION_PATH_PATTERN,
  capitalRouteTopologySnapshotIdForCapturedAt,
  capitalRouteTopologySnapshotIdMatchesCapturedAt,
  capitalTopologyReverificationPathForSnapshotId,
  isCapitalRouteTopologySnapshotId,
} from "./capital-route-topology-snapshot-id.mjs";

test("새 capital topology id는 수집 시각(ms)까지 넣고 capturedAt 전체에 결속된다(#862)", () => {
  const capturedAt = "2026-10-01T07:30:12.345Z";
  const snapshotId = capitalRouteTopologySnapshotIdForCapturedAt(capturedAt);
  assert.equal(snapshotId, "capital-route-topology-20261001T073012345Z");
  assert.equal(isCapitalRouteTopologySnapshotId(snapshotId), true);
  assert.equal(capitalRouteTopologySnapshotIdMatchesCapturedAt(snapshotId, capturedAt), true);
  assert.equal(capitalRouteTopologySnapshotIdMatchesCapturedAt(snapshotId, "2026-10-01T07:30:12.346Z"), false);
  assert.equal(
    capitalTopologyReverificationPathForSnapshotId(snapshotId),
    "tools/datapack/release/capital-topology-reverification-20261001T073012345Z.json",
  );
  assert.throws(() => capitalRouteTopologySnapshotIdForCapturedAt("2026-10-01T07:30:12Z"), /capturedAt is invalid/);
});

test("기존 날짜형 capital topology id는 그대로 읽히고 capturedAt UTC 날짜에만 결속된다(#862 append-only)", () => {
  const snapshotId = "capital-route-topology-20261001";
  assert.equal(isCapitalRouteTopologySnapshotId(snapshotId), true);
  assert.equal(capitalRouteTopologySnapshotIdMatchesCapturedAt(snapshotId, "2026-10-01T04:09:54.809Z"), true);
  assert.equal(capitalRouteTopologySnapshotIdMatchesCapturedAt(snapshotId, "2026-10-02T00:00:00.000Z"), false);
  assert.equal(
    capitalTopologyReverificationPathForSnapshotId(snapshotId),
    "tools/datapack/release/capital-topology-reverification-20261001.json",
  );
  for (const invalid of ["capital-route-topology-2026100", "capital-route-topology-20261001T0730Z", "capital-route-topology-20261001T073012345"]) {
    assert.equal(isCapitalRouteTopologySnapshotId(invalid), false, invalid);
  }
  assert.equal(CAPITAL_ROUTE_TOPOLOGY_SNAPSHOT_PATH_PATTERN.exec("tools/datapack/sources/capital-route-topology-20261001.json")?.[2], "20261001");
  assert.equal(CAPITAL_TOPOLOGY_REVERIFICATION_PATH_PATTERN.test("tools/datapack/release/capital-topology-reverification-20261001T073012345Z.json"), true);
  assert.equal(CAPITAL_TOPOLOGY_REVERIFICATION_PATH_PATTERN.test("tools/datapack/release/capital-topology-reverification-2026100.json"), false);
});
