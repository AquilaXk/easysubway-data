#!/usr/bin/env node
import { createHash } from "node:crypto";

const SHA = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const OCI = /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/(source-raw\/kric-station-movement-standard\/\d{8}\/[a-f0-9]{64}\.json)$/u;
const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function buildCurrentExitAdmissionOciReceipt({ repository, mainSha, operationId, providerCapturedAt, providerCollectionBundleBytes, providerObjectUri, providerObjectSha256, providerObjectByteSize, normalizedBytes, admissionBytes }) {
  if (repository !== "AquilaXk/easysubway-data" || !GIT_SHA.test(mainSha ?? "") || typeof operationId !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(operationId) || typeof providerCapturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(providerCapturedAt) || new Date(providerCapturedAt).toISOString() !== providerCapturedAt || !Buffer.isBuffer(providerCollectionBundleBytes) || !Buffer.isBuffer(normalizedBytes) || !Buffer.isBuffer(admissionBytes) || !SHA.test(providerObjectSha256 ?? "") || !Number.isSafeInteger(providerObjectByteSize) || providerObjectByteSize < 1 || !OCI.test(providerObjectUri ?? "")) throw new Error("EXIT OCI receipt input mismatch");
  if (sha(providerCollectionBundleBytes) !== providerObjectSha256 || providerCollectionBundleBytes.length !== providerObjectByteSize) throw new Error("EXIT OCI provider object binding mismatch");
  let admission; try { admission = JSON.parse(admissionBytes); } catch { throw new Error("EXIT OCI admission JSON mismatch"); }
  if (admission?.decision !== "GO" || !SHA.test(admission.admissionDigest ?? "")) throw new Error("EXIT OCI admission mismatch");
  const providerObjectKey = OCI.exec(providerObjectUri)[1];
  if (providerObjectKey !== `source-raw/kric-station-movement-standard/${providerCapturedAt.slice(0, 10).replaceAll("-", "")}/${providerObjectSha256}.json`) throw new Error("EXIT OCI provider date/key mismatch");
  const payload = { schemaVersion: 1, artifactKind: "current-exit-admission-oci-receipt", repository, mainSha, operationId, ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", providerCapturedAt, providerCollectionBundleSha256: providerObjectSha256, providerCollectionBundleByteSize: providerObjectByteSize, providerObjectUri, providerObjectKey, normalizedSnapshotSha256: sha(normalizedBytes), admissionSha256: sha(admissionBytes), admissionDigest: admission.admissionDigest };
  return { ...payload, receiptSha256: sha(canonical(payload)) };
}
export function canonicalCurrentExitAdmissionOciReceiptJson(receipt) {
  const { receiptSha256, ...payload } = receipt ?? {};
  if (receipt?.schemaVersion !== 1 || receipt.artifactKind !== "current-exit-admission-oci-receipt" || receipt.repository !== "AquilaXk/easysubway-data" || !GIT_SHA.test(receipt.mainSha ?? "") || typeof receipt.operationId !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(receipt.operationId) || receipt.ociNamespace !== "axvym6vk8g7i" || receipt.bucket !== "easysubway-datapacks" || typeof receipt.providerCapturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.providerCapturedAt) || new Date(receipt.providerCapturedAt).toISOString() !== receipt.providerCapturedAt || !SHA.test(receipt.providerCollectionBundleSha256 ?? "") || !SHA.test(receipt.normalizedSnapshotSha256 ?? "") || !SHA.test(receipt.admissionSha256 ?? "") || !SHA.test(receipt.admissionDigest ?? "") || !SHA.test(receiptSha256 ?? "") || !Number.isSafeInteger(receipt.providerCollectionBundleByteSize) || receipt.providerCollectionBundleByteSize < 1 || !OCI.test(receipt.providerObjectUri ?? "") || receipt.providerObjectKey !== OCI.exec(receipt.providerObjectUri)[1] || receipt.providerObjectKey !== `source-raw/kric-station-movement-standard/${receipt.providerCapturedAt.slice(0, 10).replaceAll("-", "")}/${receipt.providerCollectionBundleSha256}.json` || sha(canonical(payload)) !== receiptSha256) throw new Error("EXIT OCI receipt mismatch");
  return canonical(receipt);
}
