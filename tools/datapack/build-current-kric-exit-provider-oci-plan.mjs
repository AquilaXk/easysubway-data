#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";
import { readCanonicalCurrentKricExitCollectionBundle } from "./build-current-kric-exit-collection-receipt.mjs";

export const OCI_NAMESPACE = "axvym6vk8g7i";
export const OCI_BUCKET = "easysubway-datapacks";
const REPOSITORY = "AquilaXk/easysubway-data";
const OPERATION = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA = /^[a-f0-9]{64}$/u;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort((a, b) => a.localeCompare(b)).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exactKeys(value, keys, label) {
  const compare = (left, right) => left.localeCompare(right, "en");
  if (!value || typeof value !== "object" || Array.isArray(value) || canonical(Object.keys(value).sort(compare)) !== canonical([...keys].sort(compare))) throw new Error(`${label} mismatch`);
}

function parseProviderBundle(bytes) {
  const bundle = readCanonicalCurrentKricExitCollectionBundle(bytes);
  let plan;
  try { plan = JSON.parse(JSON.parse(bytes.toString("utf8")).collectionPlanJson); } catch { throw new Error("current EXIT provider bundle embedded plan mismatch"); }
  canonicalKricExitPathCollectionPlanJson(plan);
  return { ...bundle, plan };
}

function validateInput({ mainSha, operationId, providerCollectionBundleBytes, providerCapturedAt }) {
  if (!/^[a-f0-9]{40}$/u.test(mainSha ?? "") || !OPERATION.test(operationId ?? "") || !Buffer.isBuffer(providerCollectionBundleBytes) || providerCollectionBundleBytes.length < 1 || !TIMESTAMP.test(providerCapturedAt ?? "") || new Date(providerCapturedAt).toISOString() !== providerCapturedAt) throw new Error("current EXIT provider OCI plan input mismatch");
  const provider = parseProviderBundle(providerCollectionBundleBytes);
  if (provider.receipt.repository !== REPOSITORY || provider.receipt.repositorySha !== mainSha || provider.receipt.operationId !== operationId || provider.snapshot.capturedAt !== providerCapturedAt) throw new Error("current EXIT provider bundle identity mismatch");
  return provider;
}

export function buildCurrentKricExitProviderObject({ mainSha, operationId, providerCollectionBundleBytes, providerCapturedAt }) {
  validateInput({ mainSha, operationId, providerCollectionBundleBytes, providerCapturedAt });
  const digest = sha256(providerCollectionBundleBytes);
  const day = providerCapturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `operations/current-capital-live-chain/v1/heads/${mainSha}/operations/${operationId}/provider-collections/${day}-${digest}.json`;
  return { objectKey, ociUri: `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${objectKey}`, sha256: digest, sizeBytes: providerCollectionBundleBytes.length };
}

export function buildCurrentKricExitProviderOciPlan(input) {
  const provider = validateInput(input);
  const providerObject = buildCurrentKricExitProviderObject(input);
  const step = { objectKey: providerObject.objectKey, sourcePath: "current-kric-exit-collection-bundle.json", sha256: providerObject.sha256, sizeBytes: providerObject.sizeBytes };
  return {
    schemaVersion: 1,
    artifactKind: "current-kric-exit-provider-oci-plan",
    repository: REPOSITORY,
    mainSha: input.mainSha,
    operationId: input.operationId,
    ociNamespace: OCI_NAMESPACE,
    bucket: OCI_BUCKET,
    providerCapturedAt: input.providerCapturedAt,
    candidate: provider.plan.candidate,
    providerObject,
    publishPlan: { steps: [
      { type: "put-immutable-bundle-object", ...step },
      { type: "verify-immutable-bundle-object", ...step },
    ] },
  };
}

export function canonicalCurrentKricExitProviderOciPlanJson(plan) {
  const keys = ["schemaVersion", "artifactKind", "repository", "mainSha", "operationId", "ociNamespace", "bucket", "providerCapturedAt", "candidate", "providerObject", "publishPlan"];
  exactKeys(plan, keys, "current EXIT provider OCI plan");
  if (plan.schemaVersion !== 1 || plan.artifactKind !== "current-kric-exit-provider-oci-plan" || plan.repository !== REPOSITORY || !/^[a-f0-9]{40}$/u.test(plan.mainSha ?? "") || !OPERATION.test(plan.operationId ?? "") || plan.ociNamespace !== OCI_NAMESPACE || plan.bucket !== OCI_BUCKET || !TIMESTAMP.test(plan.providerCapturedAt ?? "") || new Date(plan.providerCapturedAt).toISOString() !== plan.providerCapturedAt) throw new Error("current EXIT provider OCI plan mismatch");
  const candidateKeys = ["candidateId", "stationSetSha256", "stationLineSetSha256", "stationLineMappingSha256", "providerMappingSha256", "topologySha256"];
  exactKeys(plan.candidate, candidateKeys, "current EXIT provider candidate");
  if (typeof plan.candidate.candidateId !== "string" || plan.candidate.candidateId === "" || Object.values(plan.candidate).slice(1).some((value) => !SHA.test(value ?? ""))) throw new Error("current EXIT provider candidate mismatch");
  const key = `operations/current-capital-live-chain/v1/heads/${plan.mainSha}/operations/${plan.operationId}/provider-collections/${plan.providerCapturedAt.slice(0, 10).replaceAll("-", "")}-${plan.providerObject?.sha256}.json`;
  exactKeys(plan.providerObject, ["objectKey", "ociUri", "sha256", "sizeBytes"], "current EXIT provider object");
  if (plan.providerObject.objectKey !== key || plan.providerObject.ociUri !== `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${key}` || !SHA.test(plan.providerObject.sha256 ?? "") || !Number.isSafeInteger(plan.providerObject.sizeBytes) || plan.providerObject.sizeBytes < 1) throw new Error("current EXIT provider object mismatch");
  const step = { objectKey: key, sourcePath: "current-kric-exit-collection-bundle.json", sha256: plan.providerObject.sha256, sizeBytes: plan.providerObject.sizeBytes };
  const expected = { steps: [{ type: "put-immutable-bundle-object", ...step }, { type: "verify-immutable-bundle-object", ...step }] };
  if (canonical(plan.publishPlan) !== canonical(expected)) throw new Error("current EXIT provider OCI plan steps mismatch");
  return canonical(plan);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length !== 10 || args[0] !== "--main-sha" || args[2] !== "--operation-id" || args[4] !== "--provider-collection-bundle" || args[6] !== "--provider-captured-at" || args[8] !== "--output" || !path.isAbsolute(args[5]) || !path.isAbsolute(args[9])) throw new Error("current EXIT provider OCI plan arguments mismatch");
  const plan = buildCurrentKricExitProviderOciPlan({ mainSha: args[1], operationId: args[3], providerCollectionBundleBytes: await readFile(args[5]), providerCapturedAt: args[7] });
  await writeFile(args[9], `${canonicalCurrentKricExitProviderOciPlanJson(plan)}\n`, { flag: "wx", mode: 0o600 });
}
