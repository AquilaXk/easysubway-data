#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readCurrentCapitalLiveChainBundle } from "./build-current-capital-live-chain-bundle.mjs";
import { canonicalCurrentKricExitCollectionBundleJson } from "./build-current-kric-exit-collection-receipt.mjs";

export const OCI_NAMESPACE = "axvym6vk8g7i";
export const OCI_BUCKET = "easysubway-datapacks";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const OPERATION = /^[a-z0-9][a-z0-9-]{7,127}$/u;
export function buildCurrentCapitalLiveChainOciPlan({ mainSha, operationId, providerCollectionBundleBytes, providerCapturedAt, compositeBundleBytes, outputPaths }) {
  if (!/^[a-f0-9]{40}$/u.test(mainSha ?? "") || !OPERATION.test(operationId ?? "") || !Buffer.isBuffer(providerCollectionBundleBytes) || providerCollectionBundleBytes.length === 0 || !Buffer.isBuffer(compositeBundleBytes) || compositeBundleBytes.length === 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(providerCapturedAt ?? "") || new Date(providerCapturedAt).toISOString() !== providerCapturedAt) throw new Error("current live-chain OCI plan input mismatch");
  const provider = readCanonicalCurrentKricExitCollectionBundle(providerCollectionBundleBytes);
  if (provider.receipt.repositorySha !== mainSha || provider.receipt.operationId !== operationId || provider.snapshot.capturedAt !== providerCapturedAt) throw new Error("current live-chain provider bundle identity mismatch");
  readCurrentCapitalLiveChainBundle(compositeBundleBytes, { repository: "AquilaXk/easysubway-data", repositorySha: mainSha, operationId, outputPaths });
  const providerSha = sha(providerCollectionBundleBytes); const compositeSha = sha(compositeBundleBytes); const day = providerCapturedAt.slice(0, 10).replaceAll("-", "");
  const providerKey = `source-raw/kric-station-movement-standard/${day}/${providerSha}.json`; const compositeKey = `operations/current-capital-live-chain/v1/heads/${mainSha}/operations/${operationId}/bundles/${compositeSha}.json`;
  const steps = [
    { type: "put-immutable-bundle-object", objectKey: providerKey, sourcePath: "current-kric-exit-collection-bundle.json", sha256: providerSha, sizeBytes: providerCollectionBundleBytes.length },
    { type: "verify-immutable-bundle-object", objectKey: providerKey, sourcePath: "current-kric-exit-collection-bundle.json", sha256: providerSha, sizeBytes: providerCollectionBundleBytes.length },
    { type: "put-immutable-bundle-object", objectKey: compositeKey, sourcePath: "current-capital-live-chain-bundle.json", sha256: compositeSha, sizeBytes: compositeBundleBytes.length },
    { type: "verify-immutable-bundle-object", objectKey: compositeKey, sourcePath: "current-capital-live-chain-bundle.json", sha256: compositeSha, sizeBytes: compositeBundleBytes.length },
  ];
  return { schemaVersion: 1, artifactKind: "current-capital-live-chain-oci-plan", repository: "AquilaXk/easysubway-data", mainSha, operationId, ociNamespace: OCI_NAMESPACE, bucket: OCI_BUCKET, providerCapturedAt, providerObject: { objectKey: providerKey, ociUri: `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${providerKey}`, sha256: providerSha, sizeBytes: providerCollectionBundleBytes.length }, compositeObject: { objectKey: compositeKey, ociUri: `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${compositeKey}`, sha256: compositeSha, sizeBytes: compositeBundleBytes.length }, publishPlan: { steps }, fetchPlan: { steps: [{ type: "fetch-source-raw-object", objectKey: compositeKey, destinationPath: "fetched-current-capital-live-chain-bundle.json", sha256: compositeSha, sizeBytes: compositeBundleBytes.length }] } };
}

function readCanonicalCurrentKricExitCollectionBundle(bytes) {
  let bundle;
  try { bundle = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("current live-chain provider bundle must be JSON"); }
  if (bytes.toString("utf8") !== canonicalCurrentKricExitCollectionBundleJson(bundle)) throw new Error("current live-chain provider bundle must be canonical");
  let receipt; let snapshot;
  try {
    receipt = JSON.parse(bundle.collectionReceiptJson);
    snapshot = JSON.parse(bundle.providerSnapshotJson);
  } catch { throw new Error("current live-chain provider bundle embedded JSON mismatch"); }
  return { receipt, snapshot };
}
export const sha256 = sha;

export function canonicalCurrentCapitalLiveChainOciPlanJson(plan) {
  const keys = ["schemaVersion", "artifactKind", "repository", "mainSha", "operationId", "ociNamespace", "bucket", "providerCapturedAt", "providerObject", "compositeObject", "publishPlan", "fetchPlan"];
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify([...keys].sort()) || plan.schemaVersion !== 1 || plan.artifactKind !== "current-capital-live-chain-oci-plan" || plan.repository !== "AquilaXk/easysubway-data" || !/^[a-f0-9]{40}$/.test(plan.mainSha ?? "") || !OPERATION.test(plan.operationId ?? "") || plan.ociNamespace !== OCI_NAMESPACE || plan.bucket !== OCI_BUCKET || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(plan.providerCapturedAt ?? "") || new Date(plan.providerCapturedAt).toISOString() !== plan.providerCapturedAt) throw new Error("current live-chain OCI plan mismatch");
  const checkObject = (object, key, label) => {
    if (!object || typeof object !== "object" || JSON.stringify(Object.keys(object).sort()) !== JSON.stringify(["objectKey", "ociUri", "sha256", "sizeBytes"].sort()) || object.objectKey !== key || object.ociUri !== `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${key}` || !/^[a-f0-9]{64}$/.test(object.sha256 ?? "") || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1) throw new Error(`${label} mismatch`);
  };
  const providerKey = `source-raw/kric-station-movement-standard/${plan.providerCapturedAt.slice(0, 10).replaceAll("-", "")}/${plan.providerObject?.sha256}.json`;
  const compositeKey = `operations/current-capital-live-chain/v1/heads/${plan.mainSha}/operations/${plan.operationId}/bundles/${plan.compositeObject?.sha256}.json`;
  checkObject(plan.providerObject, providerKey, "provider object"); checkObject(plan.compositeObject, compositeKey, "composite object");
  const expected = [["put-immutable-bundle-object", plan.providerObject, "current-kric-exit-collection-bundle.json"], ["verify-immutable-bundle-object", plan.providerObject, "current-kric-exit-collection-bundle.json"], ["put-immutable-bundle-object", plan.compositeObject, "current-capital-live-chain-bundle.json"], ["verify-immutable-bundle-object", plan.compositeObject, "current-capital-live-chain-bundle.json"]].map(([type, object, sourcePath]) => ({ type, objectKey: object.objectKey, sourcePath, sha256: object.sha256, sizeBytes: object.sizeBytes }));
  if (JSON.stringify(plan.publishPlan?.steps) !== JSON.stringify(expected) || JSON.stringify(plan.fetchPlan) !== JSON.stringify({ steps: [{ type: "fetch-source-raw-object", objectKey: plan.compositeObject.objectKey, destinationPath: "fetched-current-capital-live-chain-bundle.json", sha256: plan.compositeObject.sha256, sizeBytes: plan.compositeObject.sizeBytes }] })) throw new Error("OCI plan steps mismatch");
  return JSON.stringify(plan);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length !== 14 || args[0] !== "--main-sha" || args[2] !== "--operation-id" || args[4] !== "--provider-collection-bundle" || args[6] !== "--provider-captured-at" || args[8] !== "--composite-bundle" || args[10] !== "--output-paths-json" || args[12] !== "--output" || !path.isAbsolute(args[5]) || !path.isAbsolute(args[9]) || !path.isAbsolute(args[13])) throw new Error("current live-chain OCI plan arguments mismatch");
  let outputPaths; try { outputPaths = JSON.parse(args[11]); } catch { throw new Error("current live-chain OCI plan output paths mismatch"); }
  const plan = buildCurrentCapitalLiveChainOciPlan({ mainSha: args[1], operationId: args[3], providerCollectionBundleBytes: await readFile(args[5]), providerCapturedAt: args[7], compositeBundleBytes: await readFile(args[9]), outputPaths });
  await writeFile(args[13], `${canonicalCurrentCapitalLiveChainOciPlanJson(plan)}\n`, { flag: "wx", mode: 0o600 });
}
