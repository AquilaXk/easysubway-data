import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
const sha = (v) => createHash("sha256").update(v).digest("hex");
test("EXIT OCI receipt closes the exact source-raw provider object and admission bytes", () => {
  const provider = Buffer.from("provider"); const normalized = Buffer.from("normalized"); const admission = Buffer.from(JSON.stringify({ decision: "GO", admissionDigest: "a".repeat(64) }));
  const input = { repository: "AquilaXk/easysubway-data", mainSha: "b".repeat(40), operationId: "current-capital-560", providerCapturedAt: "2026-08-25T00:00:00.000Z", providerCollectionBundleBytes: provider, providerObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/kric-station-movement-standard/20260825/${sha(provider)}.json`, providerObjectSha256: sha(provider), providerObjectByteSize: provider.length, normalizedBytes: normalized, admissionBytes: admission };
  const receipt = buildCurrentExitAdmissionOciReceipt(input);
  assert.equal(canonicalCurrentExitAdmissionOciReceiptJson(receipt), JSON.stringify(Object.fromEntries(Object.entries(receipt).sort(([a], [b]) => a.localeCompare(b)))));
  assert.throws(() => buildCurrentExitAdmissionOciReceipt({ ...input, providerCollectionBundleBytes: Buffer.from("other") }), /binding mismatch/);
});
