import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentCapitalLiveChainOciPlan, canonicalCurrentCapitalLiveChainOciPlanJson } from "./build-current-capital-live-chain-oci-plan.mjs";
import { buildCurrentCapitalLiveChainOciReceipt, canonicalCurrentCapitalLiveChainOciReceiptJson } from "./build-current-capital-live-chain-oci-receipt.mjs";
import { extractCurrentCapitalLiveChainDirectory } from "./extract-current-capital-live-chain-directory.mjs";
import { buildCanonicalCurrentKricExitCollectionBundle, buildCanonicalCurrentLiveChainComposite, canonicalCurrentKricExitCollectionReceiptJson } from "./test-fixtures/current-live-chain-artifacts.mjs";

test("extract atomically creates only an absent verified composite directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-chain-extract-")); const destination = path.join(root, "destination");
  const repositorySha = "d".repeat(40); const operationId = "current-capital-560";
  const provider = await buildCanonicalCurrentKricExitCollectionBundle({ repositorySha, operationId });
  const composite = await buildCanonicalCurrentLiveChainComposite({ root, repositorySha, operationId, providerCollectionBundleBytes: provider.bytes });
  const bundle = composite.bytes;
  const plan = buildCurrentCapitalLiveChainOciPlan({ mainSha: repositorySha, operationId, providerCollectionBundleBytes: provider.bytes, providerCapturedAt: provider.snapshot.capturedAt, compositeBundleBytes: bundle });
  const planBytes = Buffer.from(`${canonicalCurrentCapitalLiveChainOciPlanJson(plan)}\n`); const receipt = buildCurrentCapitalLiveChainOciReceipt({ planBytes }); const receiptBytes = Buffer.from(`${canonicalCurrentCapitalLiveChainOciReceiptJson(receipt, { planBytes })}\n`);
  await assert.rejects(() => extractCurrentCapitalLiveChainDirectory({ ociPlanBytes: planBytes, externalReceiptBytes: receiptBytes, fetchedProviderCollectionBundleBytes: provider.bytes, fetchedBundleBytes: bundle, destinationDirectory: destination, repository: "AquilaXk/easysubway-data", repositorySha, operationId, failBeforeRename: true }), /pre-rename/);
  await assert.rejects(() => readFile(destination), /ENOENT/);
  await extractCurrentCapitalLiveChainDirectory({ ociPlanBytes: planBytes, externalReceiptBytes: receiptBytes, fetchedProviderCollectionBundleBytes: provider.bytes, fetchedBundleBytes: bundle, destinationDirectory: destination, repository: "AquilaXk/easysubway-data", repositorySha, operationId });
  assert.equal(await readFile(path.join(destination, "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json"), "utf8").then((bytes) => bytes.length > 0), true);
});
