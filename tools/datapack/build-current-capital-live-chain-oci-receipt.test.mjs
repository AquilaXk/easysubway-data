import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCurrentCapitalLiveChainOciPlan, canonicalCurrentCapitalLiveChainOciPlanJson } from "./build-current-capital-live-chain-oci-plan.mjs";
import {
  buildCurrentCapitalLiveChainOciReceipt,
  canonicalCurrentCapitalLiveChainOciReceiptJson,
  readCurrentCapitalLiveChainOciReceipt,
  writeCurrentCapitalLiveChainOciReceipt,
} from "./build-current-capital-live-chain-oci-receipt.mjs";
import { buildCanonicalCurrentKricExitCollectionBundle, buildCanonicalCurrentLiveChainComposite, canonicalCurrentKricExitCollectionReceiptJson, deriveCurrentIncheonTopologyFixturePath } from "./test-fixtures/current-live-chain-artifacts.mjs";

async function planFixture(root) {
  const provider = await buildCanonicalCurrentKricExitCollectionBundle();
  const composite = await buildCanonicalCurrentLiveChainComposite({ root, providerCollectionBundleBytes: provider.bytes });
  const plan = buildCurrentCapitalLiveChainOciPlan({ mainSha: "a".repeat(40), operationId: "current-capital-560", providerCollectionBundleBytes: provider.bytes, providerCapturedAt: provider.snapshot.capturedAt, compositeBundleBytes: composite.bytes });
  return { plan, planBytes: Buffer.from(`${canonicalCurrentCapitalLiveChainOciPlanJson(plan)}\n`) };
}

test("shared provider fixture derives its Incheon topology input from current inventory", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(import.meta.dirname, "source-inventory.json"), "utf8"));
  const source = sourceInventory.sources.filter(({ id }) => id === "incheon-transit-station-info");
  assert.equal(source.length, 1);
  assert.equal(
    deriveCurrentIncheonTopologyFixturePath(sourceInventory),
    source[0].topologyAdmissionEvidence.snapshotPath.slice("tools/datapack/".length),
  );
  const provider = await buildCanonicalCurrentKricExitCollectionBundle();
  assert.equal(provider.snapshot.capturedAt, source[0].topologyAdmissionEvidence.capturedAt);
});

test("OCI receipt closes the canonical plan and both exact OCI object identities", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "current-live-chain-receipt-plan-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const { plan, planBytes } = await planFixture(directory);
  const receipt = buildCurrentCapitalLiveChainOciReceipt({ planBytes });
  assert.deepEqual(JSON.parse(canonicalCurrentCapitalLiveChainOciReceiptJson(receipt, { planBytes })), receipt);
  assert.throws(() => canonicalCurrentCapitalLiveChainOciReceiptJson({ ...receipt, bucket: "other" }, { planBytes }), /shape mismatch/);
});

test("OCI receipt is canonical and create-new only", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "current-live-chain-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { planBytes } = await planFixture(directory);
  const outputPath = path.join(directory, "receipt.json");
  const expected = await writeCurrentCapitalLiveChainOciReceipt({ planBytes, outputPath });
  const bytes = await readFile(outputPath);
  assert.equal(bytes.toString("utf8"), `${canonicalCurrentCapitalLiveChainOciReceiptJson(expected, { planBytes })}\n`);
  assert.deepEqual(await readCurrentCapitalLiveChainOciReceipt({ planBytes, receiptPath: outputPath }), expected);
  await assert.rejects(() => writeCurrentCapitalLiveChainOciReceipt({ planBytes, outputPath }), /EEXIST/);
  await assert.rejects(() => writeCurrentCapitalLiveChainOciReceipt({ planBytes, outputPath: path.join(directory, "missing", "receipt.json") }), /ENOENT/);
});
