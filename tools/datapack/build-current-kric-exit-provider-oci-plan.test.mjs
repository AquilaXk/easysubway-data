import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCurrentKricExitProviderOciPlan,
  canonicalCurrentKricExitProviderOciPlanJson,
} from "./build-current-kric-exit-provider-oci-plan.mjs";
import { buildCanonicalCurrentKricExitCollectionBundle } from "./test-fixtures/current-live-chain-artifacts.mjs";

test("EXIT provider OCI plan fixes one canonical collection bundle to one exact-main immutable object", async () => {
  const provider = await buildCanonicalCurrentKricExitCollectionBundle({ operationId: "current-capital-647" });
  const providerPlan = JSON.parse(JSON.parse(provider.bytes.toString("utf8")).collectionPlanJson);
  const plan = buildCurrentKricExitProviderOciPlan({
    mainSha: "a".repeat(40),
    operationId: "current-capital-647",
    providerCollectionBundleBytes: provider.bytes,
    providerCapturedAt: provider.snapshot.capturedAt,
  });
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.artifactKind, "current-kric-exit-provider-oci-plan");
  assert.deepEqual(plan.candidate, providerPlan.candidate);
  assert.match(plan.providerObject.objectKey, new RegExp(`^operations/current-capital-live-chain/v1/heads/a{40}/operations/current-capital-647/provider-collections/${provider.snapshot.capturedAt.slice(0, 10).replaceAll("-", "")}-[a-f0-9]{64}\\.json$`));
  assert.deepEqual(plan.publishPlan.steps.map(({ type, objectKey }) => ({ type, objectKey })), [
    { type: "put-immutable-bundle-object", objectKey: plan.providerObject.objectKey },
    { type: "verify-immutable-bundle-object", objectKey: plan.providerObject.objectKey },
  ]);
  assert.deepEqual(JSON.parse(canonicalCurrentKricExitProviderOciPlanJson(plan)), plan);
  assert.throws(() => buildCurrentKricExitProviderOciPlan({
    mainSha: "a".repeat(40), operationId: "current-capital-647", providerCollectionBundleBytes: provider.bytes,
    providerCapturedAt: "2026-08-15T16:00:00.000Z",
  }), /provider bundle identity mismatch/);
});
