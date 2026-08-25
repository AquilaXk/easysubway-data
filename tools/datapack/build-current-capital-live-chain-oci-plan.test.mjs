import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCurrentCapitalLiveChainOciPlan, canonicalCurrentCapitalLiveChainOciPlanJson } from "./build-current-capital-live-chain-oci-plan.mjs";
import { buildCanonicalCurrentKricExitCollectionBundle, buildCanonicalCurrentLiveChainComposite, canonicalCurrentKricExitCollectionReceiptJson } from "./test-fixtures/current-live-chain-artifacts.mjs";

test("OCI plan fixes two immutable writes and one exact composite fetch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "current-live-chain-plan-")); t.after(() => rm(root, { recursive: true, force: true }));
  const provider = await buildCanonicalCurrentKricExitCollectionBundle();
  const composite = await buildCanonicalCurrentLiveChainComposite({ root, providerReceiptBytes: Buffer.from(canonicalCurrentKricExitCollectionReceiptJson(provider.receipt)) });
  const plan = buildCurrentCapitalLiveChainOciPlan({ mainSha: "a".repeat(40), operationId: "current-capital-560", providerCollectionBundleBytes: provider.bytes, providerCapturedAt: provider.snapshot.capturedAt, compositeBundleBytes: composite.bytes, outputPaths: composite.outputPaths });
  assert.match(plan.providerObject.objectKey, /^source-raw\/kric-station-movement-standard\/20260814\/[a-f0-9]{64}\.json$/); assert.match(plan.compositeObject.objectKey, /^operations\/current-capital-live-chain\/v1\/heads\/a{40}\/operations\/current-capital-560\/bundles\/[a-f0-9]{64}\.json$/); assert.equal(plan.publishPlan.steps.length, 4); assert.equal(plan.fetchPlan.steps[0].objectKey, plan.compositeObject.objectKey); assert.equal(canonicalCurrentCapitalLiveChainOciPlanJson(plan), JSON.stringify(plan));
  const wrongSha = await buildCanonicalCurrentKricExitCollectionBundle({ repositorySha: "b".repeat(40) });
  const wrongOperation = await buildCanonicalCurrentKricExitCollectionBundle({ operationId: "current-capital-561" });
  for (const altered of [wrongSha, wrongOperation]) assert.throws(() => buildCurrentCapitalLiveChainOciPlan({ mainSha: "a".repeat(40), operationId: "current-capital-560", providerCollectionBundleBytes: altered.bytes, providerCapturedAt: altered.snapshot.capturedAt, compositeBundleBytes: composite.bytes, outputPaths: composite.outputPaths }), /provider bundle identity mismatch/);
  assert.throws(() => buildCurrentCapitalLiveChainOciPlan({ mainSha: "a".repeat(40), operationId: "current-capital-560", providerCollectionBundleBytes: provider.bytes, providerCapturedAt: "2026-08-15T16:00:00.000Z", compositeBundleBytes: composite.bytes, outputPaths: composite.outputPaths }), /provider bundle identity mismatch/);
  assert.throws(() => buildCurrentCapitalLiveChainOciPlan({ mainSha: "a".repeat(40), operationId: "current-capital-560", providerCollectionBundleBytes: provider.bytes, providerCapturedAt: provider.snapshot.capturedAt, compositeBundleBytes: Buffer.from("not-a-bundle"), outputPaths: composite.outputPaths }), /bundle must be JSON/);
});
