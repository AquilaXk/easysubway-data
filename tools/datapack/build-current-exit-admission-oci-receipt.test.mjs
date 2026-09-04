import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildCurrentExitReboundAdmissionOciReceipt, canonicalCurrentExitReboundAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

test("v2 EXIT OCI receipt separately binds immutable source and rebound candidate objects", () => {
  const sourceProvider = Buffer.from("source-provider"); const rebound = Buffer.from("candidate-rebound"); const normalized = Buffer.from("normalized"); const admission = Buffer.from(JSON.stringify({ decision: "GO", admissionDigest: "a".repeat(64) }));
  const input = { repository: "AquilaXk/easysubway-data", sourceMainSha: "b".repeat(40), sourceOperationId: "current-capital-source-560", candidateHeadSha: "c".repeat(40), candidateOperationId: "current-capital-560", providerCapturedAt: "2026-08-25T00:00:00.000Z", providerCollectionBundleBytes: sourceProvider, providerObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${"b".repeat(40)}/operations/current-capital-source-560/provider-collections/20260825-${sha(sourceProvider)}.json`, providerObjectSha256: sha(sourceProvider), providerObjectByteSize: sourceProvider.length, sourceReceiptSha256: "d".repeat(64), candidateReceiptSha256: "e".repeat(64), reboundCollectionBundleBytes: rebound, normalizedBytes: normalized, admissionBytes: admission };
  const receipt = buildCurrentExitReboundAdmissionOciReceipt(input);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.sourceMainSha, input.sourceMainSha);
  assert.equal(receipt.candidateHeadSha, input.candidateHeadSha);
  assert.equal(receipt.reboundCollectionBundleSha256, sha(rebound));
  assert.equal(canonicalCurrentExitReboundAdmissionOciReceiptJson(receipt), canonical(receipt));
  assert.throws(() => buildCurrentExitReboundAdmissionOciReceipt({ ...input, providerCollectionBundleBytes: Buffer.from("other") }), /binding mismatch/);
  assert.throws(() => buildCurrentExitReboundAdmissionOciReceipt({ ...input, candidateHeadSha: input.sourceMainSha }), /identity mismatch/);
  assert.throws(() => buildCurrentExitReboundAdmissionOciReceipt({ ...input, sourceOperationId: input.candidateOperationId }), /identity mismatch/);
  assert.throws(() => buildCurrentExitReboundAdmissionOciReceipt({ ...input, sourceReceiptSha256: undefined }), /identity mismatch/);
  assert.notEqual(buildCurrentExitReboundAdmissionOciReceipt({ ...input, reboundCollectionBundleBytes: Buffer.from("other") }).receiptSha256, receipt.receiptSha256);
  assert.throws(() => canonicalCurrentExitReboundAdmissionOciReceiptJson({ ...receipt, providerObjectUri: receipt.providerObjectUri.replace("20260825", "20260826") }), /mismatch/);
  assert.throws(() => canonicalCurrentExitReboundAdmissionOciReceiptJson({ ...receipt, receiptSha256: "f".repeat(64) }), /mismatch/);
  assert.throws(() => canonicalCurrentExitReboundAdmissionOciReceiptJson({ ...receipt, schemaVersion: 1 }), /keys mismatch|mismatch/);
});
