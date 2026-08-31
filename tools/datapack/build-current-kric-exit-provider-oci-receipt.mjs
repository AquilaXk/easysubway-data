#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalCurrentKricExitProviderOciPlanJson } from "./build-current-kric-exit-provider-oci-plan.mjs";

const SHA = /^[a-f0-9]{64}$/u;
const METHOD = "conditional-put-then-full-get";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort((a, b) => a.localeCompare(b)).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function parsePlan(planBytes) {
  if (!Buffer.isBuffer(planBytes) || planBytes.length < 1) throw new Error("current EXIT provider OCI plan bytes mismatch");
  let plan; try { plan = JSON.parse(planBytes.toString("utf8")); } catch { throw new Error("current EXIT provider OCI plan JSON mismatch"); }
  if (!planBytes.equals(Buffer.from(`${canonicalCurrentKricExitProviderOciPlanJson(plan)}\n`))) throw new Error("current EXIT provider OCI plan must be canonical bytes");
  return plan;
}
export function buildCurrentKricExitProviderOciReceipt({ planBytes }) {
  const plan = parsePlan(planBytes);
  const payload = { schemaVersion: 1, artifactKind: "current-kric-exit-provider-oci-receipt", repository: plan.repository, mainSha: plan.mainSha, operationId: plan.operationId, ociNamespace: plan.ociNamespace, bucket: plan.bucket, providerCapturedAt: plan.providerCapturedAt, candidate: plan.candidate, planSha256: sha256(planBytes), providerObject: plan.providerObject, verifiedMethod: METHOD };
  return { ...payload, receiptSha256: sha256(Buffer.from(canonical(payload))) };
}
export function canonicalCurrentKricExitProviderOciReceiptJson(receipt, { planBytes } = {}) {
  const keys = ["schemaVersion", "artifactKind", "repository", "mainSha", "operationId", "ociNamespace", "bucket", "providerCapturedAt", "candidate", "planSha256", "providerObject", "verifiedMethod", "receiptSha256"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || canonical(Object.keys(receipt).sort()) !== canonical([...keys].sort()) || receipt.schemaVersion !== 1 || receipt.artifactKind !== "current-kric-exit-provider-oci-receipt" || receipt.repository !== "AquilaXk/easysubway-data" || !/^[a-f0-9]{40}$/u.test(receipt.mainSha ?? "") || typeof receipt.operationId !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(receipt.operationId) || receipt.ociNamespace !== "axvym6vk8g7i" || receipt.bucket !== "easysubway-datapacks" || typeof receipt.providerCapturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.providerCapturedAt) || new Date(receipt.providerCapturedAt).toISOString() !== receipt.providerCapturedAt || !SHA.test(receipt.planSha256 ?? "") || !SHA.test(receipt.receiptSha256 ?? "") || receipt.verifiedMethod !== METHOD) throw new Error("current EXIT provider OCI receipt shape mismatch");
  const { receiptSha256, ...payload } = receipt;
  if (sha256(Buffer.from(canonical(payload))) !== receiptSha256) throw new Error("current EXIT provider OCI receipt hash mismatch");
  if (planBytes !== undefined && canonical(buildCurrentKricExitProviderOciReceipt({ planBytes })) !== canonical(receipt)) throw new Error("current EXIT provider OCI receipt plan binding mismatch");
  return canonical(receipt);
}
export async function writeCurrentKricExitProviderOciReceipt({ planBytes, outputPath }) {
  if (!path.isAbsolute(outputPath ?? "")) throw new Error("current EXIT provider OCI receipt output must be absolute");
  const output = path.resolve(outputPath); const parent = await lstat(path.dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("current EXIT provider OCI receipt parent mismatch");
  const receipt = buildCurrentKricExitProviderOciReceipt({ planBytes });
  await writeFile(output, `${canonicalCurrentKricExitProviderOciReceiptJson(receipt, { planBytes })}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}
export async function readCurrentKricExitProviderOciReceipt({ planBytes, receiptPath }) {
  if (!path.isAbsolute(receiptPath ?? "")) throw new Error("current EXIT provider OCI receipt path must be absolute");
  const file = await lstat(receiptPath); if (!file.isFile() || file.isSymbolicLink()) throw new Error("current EXIT provider OCI receipt must be regular");
  const bytes = await readFile(receiptPath); let receipt; try { receipt = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("current EXIT provider OCI receipt JSON mismatch"); }
  if (!bytes.equals(Buffer.from(`${canonicalCurrentKricExitProviderOciReceiptJson(receipt, { planBytes })}\n`))) throw new Error("current EXIT provider OCI receipt must be canonical bytes");
  return receipt;
}
