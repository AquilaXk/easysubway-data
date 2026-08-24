import assert from "node:assert/strict";
import test from "node:test";

import { requirePublicStaticNetworkV2Admission } from "./public-static-network-v2-admission.mjs";

function valid() {
  const layoutAlgorithmVersion = "seoul-public-latlon-line-order-layout-v2";
  return { positions: { routeMapLayoutEvidence: { layoutAlgorithmVersion }, routeMapLayoutArtifact: { layoutAlgorithmVersion } }, positionSource: { routeMapAdmissionEvidence: { currentLayoutAdmission: { layoutAlgorithmVersion } } } };
}

test("v2 admission requires all three layout bindings", () => {
  requirePublicStaticNetworkV2Admission(valid());
});

test("v2 admission fails closed when a layout binding is absent or wrong", () => {
  assert.throws(() => requirePublicStaticNetworkV2Admission({}), /V2_MISSING/);
  for (const mutate of [
    (value) => { delete value.positions.routeMapLayoutEvidence; },
    (value) => { value.positions.routeMapLayoutArtifact.layoutAlgorithmVersion = "wrong"; },
    (value) => { value.positionSource.routeMapAdmissionEvidence.currentLayoutAdmission.layoutAlgorithmVersion = "wrong"; },
  ]) { const value = valid(); mutate(value); assert.throws(() => requirePublicStaticNetworkV2Admission(value), /V2_MISSING/); }
});
