#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalCurrentCapitalLiveChainOciPlanJson } from "./build-current-capital-live-chain-oci-plan.mjs";

const SHA = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const OPERATION = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const METHOD = "conditional-put-then-full-get";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function parsePlan(planBytes) {
  if (!Buffer.isBuffer(planBytes) || planBytes.length === 0) throw new Error("OCI plan bytes mismatch");
  let plan; try { plan = JSON.parse(planBytes.toString("utf8")); } catch { throw new Error("OCI plan JSON mismatch"); }
  if (!planBytes.equals(Buffer.from(`${canonicalCurrentCapitalLiveChainOciPlanJson(plan)}\n`))) throw new Error("OCI plan must be canonical bytes");
  return plan;
}
function object(value, label) {
  if (!value || typeof value !== "object" || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["objectKey", "ociUri", "sha256", "sizeBytes"].sort()) || typeof value.objectKey !== "string" || !SHA.test(value.sha256 ?? "") || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || typeof value.ociUri !== "string") throw new Error(`${label} mismatch`);
  return value;
}

export function buildCurrentCapitalLiveChainOciReceipt({ planBytes }) {
  const plan = parsePlan(planBytes);
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-capital-live-chain-oci-receipt",
    repository: plan.repository,
    mainSha: plan.mainSha,
    operationId: plan.operationId,
    ociNamespace: plan.ociNamespace,
    bucket: plan.bucket,
    planSha256: sha(planBytes),
    providerObject: plan.providerObject,
    compositeObject: plan.compositeObject,
    verifiedMethod: METHOD,
  };
  return { ...payload, receiptSha256: sha(Buffer.from(canonical(payload))) };
}

export function canonicalCurrentCapitalLiveChainOciReceiptJson(receipt, { planBytes } = {}) {
  const keys = ["schemaVersion", "artifactKind", "repository", "mainSha", "operationId", "ociNamespace", "bucket", "planSha256", "providerObject", "compositeObject", "verifiedMethod", "receiptSha256"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([...keys].sort()) || receipt.schemaVersion !== 1 || receipt.artifactKind !== "current-capital-live-chain-oci-receipt" || receipt.repository !== "AquilaXk/easysubway-data" || !SHA1.test(receipt.mainSha ?? "") || !OPERATION.test(receipt.operationId ?? "") || receipt.ociNamespace !== "axvym6vk8g7i" || receipt.bucket !== "easysubway-datapacks" || !SHA.test(receipt.planSha256 ?? "") || receipt.verifiedMethod !== METHOD || !SHA.test(receipt.receiptSha256 ?? "")) throw new Error("OCI receipt shape mismatch");
  object(receipt.providerObject, "provider object"); object(receipt.compositeObject, "composite object");
  const { receiptSha256, ...payload } = receipt;
  if (sha(Buffer.from(canonical(payload))) !== receiptSha256) throw new Error("OCI receipt hash mismatch");
  if (planBytes !== undefined) {
    const expected = buildCurrentCapitalLiveChainOciReceipt({ planBytes });
    if (canonical(expected) !== canonical(receipt)) throw new Error("OCI receipt plan binding mismatch");
  }
  return canonical(receipt);
}

export async function writeCurrentCapitalLiveChainOciReceipt({ planBytes, outputPath }) {
  if (!path.isAbsolute(outputPath ?? "")) throw new Error("OCI receipt output must be absolute");
  const output = path.resolve(outputPath); const parent = path.dirname(output); const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("OCI receipt parent mismatch");
  const receipt = buildCurrentCapitalLiveChainOciReceipt({ planBytes });
  await writeFile(output, `${canonicalCurrentCapitalLiveChainOciReceiptJson(receipt, { planBytes })}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

export async function readCurrentCapitalLiveChainOciReceipt({ planBytes, receiptPath }) {
  if (!path.isAbsolute(receiptPath ?? "")) throw new Error("OCI receipt path must be absolute");
  const stat = await lstat(receiptPath); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("OCI receipt must be regular");
  const bytes = await readFile(receiptPath); let receipt; try { receipt = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("OCI receipt JSON mismatch"); }
  if (!bytes.equals(Buffer.from(`${canonicalCurrentCapitalLiveChainOciReceiptJson(receipt, { planBytes })}\n`))) throw new Error("OCI receipt must be canonical bytes");
  return receipt;
}
