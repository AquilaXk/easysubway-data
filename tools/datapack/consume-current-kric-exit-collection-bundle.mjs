#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";
import {
  buildCurrentKricExitCollectionReceipt,
  canonicalCurrentKricExitCollectionBundleJson,
  canonicalCurrentKricExitCollectionReceiptJson,
} from "./build-current-kric-exit-collection-receipt.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";

export async function consumeCurrentKricExitCollectionBundle({
  collectionBundle,
  expectedBundleSha256,
  expectedRepositorySha,
  expectedWorkflowRunId,
}) {
  const snapshot = await readRegularSnapshot(collectionBundle, "collection bundle");
  if (typeof expectedBundleSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedBundleSha256)) {
    throw new Error("expected bundle SHA mismatch");
  }
  if (sha256(snapshot.bytes) !== expectedBundleSha256) {
    throw new Error("collection bundle expected digest mismatch");
  }
  const bundle = parseJson(snapshot.bytes, "collection bundle");
  const canonical = canonicalCurrentKricExitCollectionBundleJson(bundle);
  if (!snapshot.bytes.equals(Buffer.from(canonical))) {
    throw new Error("collection bundle must be canonical JSON");
  }
  if (typeof expectedRepositorySha !== "string" || !/^[a-f0-9]{40}$/.test(expectedRepositorySha)) {
    throw new Error("expected repository SHA mismatch");
  }
  if (!Number.isSafeInteger(expectedWorkflowRunId) || expectedWorkflowRunId <= 0) {
    throw new Error("expected workflow run ID mismatch");
  }
  const collectionPlanBytes = Buffer.from(bundle.collectionPlanJson, "utf8");
  const providerSnapshotBytes = Buffer.from(bundle.providerSnapshotJson, "utf8");
  const receiptBytes = Buffer.from(bundle.collectionReceiptJson, "utf8");
  const receipt = parseJson(receiptBytes, "collection receipt");
  if (!receiptBytes.equals(Buffer.from(canonicalCurrentKricExitCollectionReceiptJson(receipt)))) {
    throw new Error("collection receipt must be canonical JSON");
  }
  if (receipt.repository !== REPOSITORY || receipt.repositorySha !== expectedRepositorySha
    || receipt.workflowRunId !== expectedWorkflowRunId) {
    throw new Error("collection receipt expected identity mismatch");
  }
  const rebuiltReceipt = buildCurrentKricExitCollectionReceipt({
    collectionPlanBytes,
    providerSnapshotBytes,
    repository: receipt.repository,
    repositorySha: receipt.repositorySha,
    workflowRunId: receipt.workflowRunId,
  });
  if (canonicalCurrentKricExitCollectionReceiptJson(rebuiltReceipt)
    !== canonicalCurrentKricExitCollectionReceiptJson(receipt)) {
    throw new Error("collection receipt producer reconstruction mismatch");
  }
  return { collectionPlanBytes, providerSnapshotBytes, receipt, bundleSha256: bundle.bundleSha256 };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} must be strict UTF-8 JSON`);
  }
}
