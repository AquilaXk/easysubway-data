import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentKricExitProviderOciPlan, canonicalCurrentKricExitProviderOciPlanJson } from "./build-current-kric-exit-provider-oci-plan.mjs";
import {
  buildCurrentKricExitProviderOciReceipt,
  canonicalCurrentKricExitProviderOciReceiptJson,
  readCurrentKricExitProviderOciReceipt,
  writeCurrentKricExitProviderOciReceipt,
} from "./build-current-kric-exit-provider-oci-receipt.mjs";
import { buildCanonicalCurrentKricExitCollectionBundle } from "./test-fixtures/current-live-chain-artifacts.mjs";

test("EXIT provider OCI receipt is create-once and binds the plan, candidate, object, and verified method", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "current-exit-provider-oci-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = await buildCanonicalCurrentKricExitCollectionBundle({ operationId: "current-capital-647" });
  const providerPlan = JSON.parse(JSON.parse(provider.bytes.toString("utf8")).collectionPlanJson);
  const plan = buildCurrentKricExitProviderOciPlan({ mainSha: "a".repeat(40), operationId: "current-capital-647", providerCollectionBundleBytes: provider.bytes, providerCapturedAt: provider.snapshot.capturedAt });
  const planBytes = Buffer.from(`${canonicalCurrentKricExitProviderOciPlanJson(plan)}\n`);
  const receipt = buildCurrentKricExitProviderOciReceipt({ planBytes });
  assert.deepEqual(JSON.parse(canonicalCurrentKricExitProviderOciReceiptJson(receipt, { planBytes })), receipt);
  assert.equal(receipt.verifiedMethod, "conditional-put-then-full-get");
  assert.deepEqual(receipt.candidate, providerPlan.candidate);
  const outputPath = path.join(directory, "receipt.json");
  await writeCurrentKricExitProviderOciReceipt({ planBytes, outputPath });
  assert.deepEqual(await readCurrentKricExitProviderOciReceipt({ planBytes, receiptPath: outputPath }), receipt);
  assert.equal((await readFile(outputPath)).toString(), `${canonicalCurrentKricExitProviderOciReceiptJson(receipt, { planBytes })}\n`);
  await assert.rejects(() => writeCurrentKricExitProviderOciReceipt({ planBytes, outputPath }), /EEXIST/);
  assert.throws(() => canonicalCurrentKricExitProviderOciReceiptJson({ ...receipt, verifiedMethod: "head" }, { planBytes }), /shape mismatch/);
});
