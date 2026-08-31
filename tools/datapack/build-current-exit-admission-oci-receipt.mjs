#!/usr/bin/env node
import { createHash } from "node:crypto";

const SHA = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const OCI = /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/(operations\/current-capital-live-chain\/v1\/heads\/([a-f0-9]{40})\/operations\/([a-z0-9][a-z0-9-]{7,127})\/provider-collections\/(\d{8})-([a-f0-9]{64})\.json)$/u;
const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const OPERATION = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function receiptTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
    throw new Error("EXIT OCI receipt timestamp mismatch");
  }
  return value;
}

function exactReceiptKeys(receipt, keys, label) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || Object.keys(receipt).length !== keys.length || !keys.every((key) => Object.hasOwn(receipt, key))) {
    throw new Error(`${label} keys mismatch`);
  }
}

function admissionValues(admissionBytes) {
  let admission;
  try { admission = JSON.parse(admissionBytes); } catch { throw new Error("EXIT OCI admission JSON mismatch"); }
  if (admission?.decision !== "GO" || !SHA.test(admission.admissionDigest ?? "")) {
    throw new Error("EXIT OCI admission mismatch");
  }
  return admission;
}

function sourceProviderObject({ sourceMainSha, sourceOperationId, providerCapturedAt, providerCollectionBundleBytes, providerObjectUri, providerObjectSha256, providerObjectByteSize }) {
  if (!GIT_SHA.test(sourceMainSha ?? "") || !OPERATION.test(sourceOperationId ?? "")
    || !Buffer.isBuffer(providerCollectionBundleBytes) || !SHA.test(providerObjectSha256 ?? "")
    || !Number.isSafeInteger(providerObjectByteSize) || providerObjectByteSize < 1 || !OCI.test(providerObjectUri ?? "")) {
    throw new Error("EXIT OCI source provider input mismatch");
  }
  const capturedAt = receiptTimestamp(providerCapturedAt);
  if (sha(providerCollectionBundleBytes) !== providerObjectSha256 || providerCollectionBundleBytes.length !== providerObjectByteSize) {
    throw new Error("EXIT OCI provider object binding mismatch");
  }
  const [, providerObjectKey, uriMainSha, uriOperationId, providerDay, uriDigest] = OCI.exec(providerObjectUri);
  if (uriMainSha !== sourceMainSha || uriOperationId !== sourceOperationId
    || providerDay !== capturedAt.slice(0, 10).replaceAll("-", "") || uriDigest !== providerObjectSha256) {
    throw new Error("EXIT OCI provider date/key mismatch");
  }
  return { providerObjectKey, capturedAt };
}

export function buildCurrentExitAdmissionOciReceipt({ repository, mainSha, operationId, providerCapturedAt, providerCollectionBundleBytes, providerObjectUri, providerObjectSha256, providerObjectByteSize, normalizedBytes, admissionBytes }) {
  if (repository !== "AquilaXk/easysubway-data" || !Buffer.isBuffer(normalizedBytes) || !Buffer.isBuffer(admissionBytes)) throw new Error("EXIT OCI receipt input mismatch");
  const { providerObjectKey, capturedAt } = sourceProviderObject({ sourceMainSha: mainSha, sourceOperationId: operationId, providerCapturedAt, providerCollectionBundleBytes, providerObjectUri, providerObjectSha256, providerObjectByteSize });
  const admission = admissionValues(admissionBytes);
  const payload = { schemaVersion: 1, artifactKind: "current-exit-admission-oci-receipt", repository, mainSha, operationId, ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", providerCapturedAt, providerCollectionBundleSha256: providerObjectSha256, providerCollectionBundleByteSize: providerObjectByteSize, providerObjectUri, providerObjectKey, normalizedSnapshotSha256: sha(normalizedBytes), admissionSha256: sha(admissionBytes), admissionDigest: admission.admissionDigest };
  return { ...payload, receiptSha256: sha(canonical(payload)) };
}
function canonicalCurrentExitAdmissionOciReceiptV1Json(receipt) {
  const { receiptSha256, ...payload } = receipt ?? {};
  const uri = OCI.exec(receipt?.providerObjectUri ?? "");
  exactReceiptKeys(receipt, ["schemaVersion", "artifactKind", "repository", "mainSha", "operationId", "ociNamespace", "bucket", "providerCapturedAt", "providerCollectionBundleSha256", "providerCollectionBundleByteSize", "providerObjectUri", "providerObjectKey", "normalizedSnapshotSha256", "admissionSha256", "admissionDigest", "receiptSha256"], "EXIT OCI receipt");
  if (receipt.schemaVersion !== 1 || receipt.artifactKind !== "current-exit-admission-oci-receipt" || receipt.repository !== "AquilaXk/easysubway-data" || !GIT_SHA.test(receipt.mainSha ?? "") || !OPERATION.test(receipt.operationId ?? "") || receipt.ociNamespace !== "axvym6vk8g7i" || receipt.bucket !== "easysubway-datapacks" || !SHA.test(receipt.providerCollectionBundleSha256 ?? "") || !SHA.test(receipt.normalizedSnapshotSha256 ?? "") || !SHA.test(receipt.admissionSha256 ?? "") || !SHA.test(receipt.admissionDigest ?? "") || !SHA.test(receiptSha256 ?? "") || !Number.isSafeInteger(receipt.providerCollectionBundleByteSize) || receipt.providerCollectionBundleByteSize < 1 || !uri || receipt.providerObjectKey !== uri[1] || uri[2] !== receipt.mainSha || uri[3] !== receipt.operationId || uri[4] !== receiptTimestamp(receipt.providerCapturedAt).slice(0, 10).replaceAll("-", "") || uri[5] !== receipt.providerCollectionBundleSha256 || sha(canonical(payload)) !== receiptSha256) throw new Error("EXIT OCI receipt mismatch");
  return canonical(receipt);
}

export function buildCurrentExitReboundAdmissionOciReceipt({ repository, sourceMainSha, sourceOperationId, candidateHeadSha, candidateOperationId, providerCapturedAt, providerCollectionBundleBytes, providerObjectUri, providerObjectSha256, providerObjectByteSize, sourceReceiptSha256, candidateReceiptSha256, reboundCollectionBundleBytes, normalizedBytes, admissionBytes }) {
  if (repository !== "AquilaXk/easysubway-data" || !GIT_SHA.test(candidateHeadSha ?? "") || !OPERATION.test(candidateOperationId ?? "")
    || sourceMainSha === candidateHeadSha || sourceOperationId === candidateOperationId || !SHA.test(sourceReceiptSha256 ?? "")
    || !SHA.test(candidateReceiptSha256 ?? "") || !Buffer.isBuffer(reboundCollectionBundleBytes) || reboundCollectionBundleBytes.length < 1
    || !Buffer.isBuffer(normalizedBytes) || !Buffer.isBuffer(admissionBytes)) {
    throw new Error("EXIT rebound OCI receipt identity mismatch");
  }
  const { providerObjectKey, capturedAt } = sourceProviderObject({ sourceMainSha, sourceOperationId, providerCapturedAt, providerCollectionBundleBytes, providerObjectUri, providerObjectSha256, providerObjectByteSize });
  const admission = admissionValues(admissionBytes);
  const payload = {
    schemaVersion: 2,
    artifactKind: "current-exit-rebound-admission-oci-receipt",
    repository,
    sourceMainSha,
    sourceOperationId,
    candidateHeadSha,
    candidateOperationId,
    ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks",
    providerCapturedAt: capturedAt,
    providerObjectUri,
    providerObjectKey,
    sourceProviderCollectionBundleSha256: providerObjectSha256,
    sourceProviderCollectionBundleByteSize: providerObjectByteSize,
    sourceReceiptSha256,
    candidateReceiptSha256,
    reboundCollectionBundleSha256: sha(reboundCollectionBundleBytes),
    reboundCollectionBundleByteSize: reboundCollectionBundleBytes.length,
    normalizedSnapshotSha256: sha(normalizedBytes),
    admissionSha256: sha(admissionBytes),
    admissionDigest: admission.admissionDigest,
  };
  return { ...payload, receiptSha256: sha(canonical(payload)) };
}

export function canonicalCurrentExitReboundAdmissionOciReceiptJson(receipt) {
  const keys = ["schemaVersion", "artifactKind", "repository", "sourceMainSha", "sourceOperationId", "candidateHeadSha", "candidateOperationId", "ociNamespace", "bucket", "providerCapturedAt", "providerObjectUri", "providerObjectKey", "sourceProviderCollectionBundleSha256", "sourceProviderCollectionBundleByteSize", "sourceReceiptSha256", "candidateReceiptSha256", "reboundCollectionBundleSha256", "reboundCollectionBundleByteSize", "normalizedSnapshotSha256", "admissionSha256", "admissionDigest", "receiptSha256"];
  exactReceiptKeys(receipt, keys, "EXIT rebound OCI receipt");
  const { receiptSha256, ...payload } = receipt;
  const uri = OCI.exec(receipt.providerObjectUri ?? "");
  if (receipt.schemaVersion !== 2 || receipt.artifactKind !== "current-exit-rebound-admission-oci-receipt"
    || receipt.repository !== "AquilaXk/easysubway-data" || !GIT_SHA.test(receipt.sourceMainSha ?? "")
    || !OPERATION.test(receipt.sourceOperationId ?? "") || !GIT_SHA.test(receipt.candidateHeadSha ?? "")
    || !OPERATION.test(receipt.candidateOperationId ?? "") || receipt.sourceMainSha === receipt.candidateHeadSha
    || receipt.sourceOperationId === receipt.candidateOperationId || receipt.ociNamespace !== "axvym6vk8g7i"
    || receipt.bucket !== "easysubway-datapacks" || !SHA.test(receipt.sourceProviderCollectionBundleSha256 ?? "")
    || !SHA.test(receipt.sourceReceiptSha256 ?? "") || !SHA.test(receipt.candidateReceiptSha256 ?? "")
    || !SHA.test(receipt.reboundCollectionBundleSha256 ?? "") || !SHA.test(receipt.normalizedSnapshotSha256 ?? "")
    || !SHA.test(receipt.admissionSha256 ?? "") || !SHA.test(receipt.admissionDigest ?? "") || !SHA.test(receiptSha256 ?? "")
    || !Number.isSafeInteger(receipt.sourceProviderCollectionBundleByteSize) || receipt.sourceProviderCollectionBundleByteSize < 1
    || !Number.isSafeInteger(receipt.reboundCollectionBundleByteSize) || receipt.reboundCollectionBundleByteSize < 1
    || !uri || receipt.providerObjectKey !== uri[1] || uri[2] !== receipt.sourceMainSha || uri[3] !== receipt.sourceOperationId
    || uri[4] !== receiptTimestamp(receipt.providerCapturedAt).slice(0, 10).replaceAll("-", "")
    || uri[5] !== receipt.sourceProviderCollectionBundleSha256 || sha(canonical(payload)) !== receiptSha256) {
    throw new Error("EXIT rebound OCI receipt mismatch");
  }
  return canonical(receipt);
}

export function canonicalCurrentExitAdmissionOciReceiptJson(receipt) {
  if (receipt?.schemaVersion === 1) return canonicalCurrentExitAdmissionOciReceiptV1Json(receipt);
  if (receipt?.schemaVersion === 2) return canonicalCurrentExitReboundAdmissionOciReceiptJson(receipt);
  throw new Error("EXIT OCI receipt schema mismatch");
}
