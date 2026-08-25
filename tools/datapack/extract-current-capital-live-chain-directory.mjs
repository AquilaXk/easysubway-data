#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { CURRENT_CAPITAL_LIVE_CHAIN_PROVIDER_RECEIPT_PATH, readCurrentCapitalLiveChainBundle } from "./build-current-capital-live-chain-bundle.mjs";
import { canonicalCurrentCapitalLiveChainOciPlanJson, readCanonicalCurrentKricExitCollectionBundle } from "./build-current-capital-live-chain-oci-plan.mjs";
import { canonicalCurrentCapitalLiveChainOciReceiptJson } from "./build-current-capital-live-chain-oci-receipt.mjs";
import { canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parseCanonical(bytes, canonicalizer, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error(`${label} bytes mismatch`);
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} JSON mismatch`); }
  if (!bytes.equals(Buffer.from(`${canonicalizer(value)}\n`))) throw new Error(`${label} must be canonical bytes`);
  return value;
}
async function requireRealDirectory(directory, label) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}
async function requireAbsent(directory) {
  try { await lstat(directory); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("extract destination must be absent");
}
function stagedTarget(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("extract entry escapes staging directory");
  return target;
}
async function writeVerifiedEntry(root, entry) {
  const target = stagedTarget(root, entry.path);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(Buffer.from(entry.bytesBase64, "base64")); await file.sync(); } finally { await file.close(); }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("extract staged entry must be regular");
  const bytes = await readFile(target);
  if (bytes.length !== Buffer.from(entry.bytesBase64, "base64").length || sha256(bytes) !== entry.sha256) throw new Error("extract staged entry checksum mismatch");
}

/** Extract only after exact OCI plan, external receipt, and fetched bytes agree. */
export async function extractCurrentCapitalLiveChainDirectory({ ociPlanBytes, externalReceiptBytes, fetchedProviderCollectionBundleBytes, fetchedBundleBytes, destinationDirectory, repository, repositorySha, operationId, failBeforeRename = false }) {
  const plan = parseCanonical(ociPlanBytes, canonicalCurrentCapitalLiveChainOciPlanJson, "OCI plan");
  const receipt = parseCanonical(externalReceiptBytes, (value) => canonicalCurrentCapitalLiveChainOciReceiptJson(value, { planBytes: ociPlanBytes }), "OCI receipt");
  if (plan.repository !== repository || plan.mainSha !== repositorySha || plan.operationId !== operationId
    || receipt.providerObject.sizeBytes !== fetchedProviderCollectionBundleBytes?.length || receipt.providerObject.sha256 !== sha256(fetchedProviderCollectionBundleBytes)
    || receipt.compositeObject.sizeBytes !== fetchedBundleBytes?.length || receipt.compositeObject.sha256 !== sha256(fetchedBundleBytes)) throw new Error("extract external receipt binding mismatch");
  const provider = readCanonicalCurrentKricExitCollectionBundle(fetchedProviderCollectionBundleBytes);
  if (provider.receipt.repository !== repository || provider.receipt.repositorySha !== repositorySha || provider.receipt.operationId !== operationId || provider.snapshot.capturedAt !== plan.providerCapturedAt) throw new Error("extract provider collection binding mismatch");
  const bundle = readCurrentCapitalLiveChainBundle(fetchedBundleBytes, { repository, repositorySha, operationId });
  assertEmbeddedExitReceipt({ bundle, plan, repository, repositorySha, operationId });
  const destination = path.resolve(destinationDirectory); const parent = path.dirname(destination);
  await requireRealDirectory(parent, "extract destination parent"); await requireAbsent(destination);
  const staging = await mkdtemp(path.join(parent, ".current-capital-live-chain-")); let renamed = false;
  try {
    for (const entry of bundle.entries) await writeVerifiedEntry(staging, entry);
    if (failBeforeRename) throw new Error("extract injected pre-rename failure");
    await requireAbsent(destination); await rename(staging, destination); renamed = true;
  } finally { if (!renamed) await rm(staging, { recursive: true, force: true }); }
  return { destinationDirectory: destination, manifestSha256: bundle.manifestSha256, published: bundle.entries.map(({ path: entryPath }) => entryPath) };
}

function assertEmbeddedExitReceipt({ bundle, plan, repository, repositorySha, operationId }) {
  const entries = new Map(bundle.entries.map((entry) => [entry.path, entry]));
  const receiptEntry = entries.get(CURRENT_CAPITAL_LIVE_CHAIN_PROVIDER_RECEIPT_PATH);
  const normalizedEntry = entries.get("tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json");
  const admissionEntry = entries.get("tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json");
  if (!receiptEntry || !normalizedEntry || !admissionEntry) throw new Error("extract exact live-chain output binding mismatch");
  const receiptBytes = Buffer.from(receiptEntry.bytesBase64, "base64");
  let exitReceipt;
  try { exitReceipt = JSON.parse(receiptBytes.toString("utf8")); } catch { throw new Error("extract embedded EXIT receipt JSON mismatch"); }
  if (!receiptBytes.equals(Buffer.from(`${canonicalCurrentExitAdmissionOciReceiptJson(exitReceipt)}\n`))) throw new Error("extract embedded EXIT receipt must be canonical");
  if (exitReceipt.repository !== repository || exitReceipt.mainSha !== repositorySha || exitReceipt.operationId !== operationId
    || exitReceipt.providerCapturedAt !== plan.providerCapturedAt || exitReceipt.providerObjectKey !== plan.providerObject.objectKey
    || exitReceipt.providerObjectUri !== plan.providerObject.ociUri || exitReceipt.providerCollectionBundleSha256 !== plan.providerObject.sha256
    || exitReceipt.providerCollectionBundleByteSize !== plan.providerObject.sizeBytes || exitReceipt.normalizedSnapshotSha256 !== normalizedEntry.sha256
    || exitReceipt.admissionSha256 !== admissionEntry.sha256) throw new Error("extract embedded EXIT receipt binding mismatch");
  let admission;
  try { admission = JSON.parse(Buffer.from(admissionEntry.bytesBase64, "base64").toString("utf8")); } catch { throw new Error("extract EXIT admission JSON mismatch"); }
  if (admission?.decision !== "GO" || admission.admissionDigest !== exitReceipt.admissionDigest) throw new Error("extract EXIT admission digest mismatch");
}
