#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const componentKeys = [
  "schemaVersion", "component", "repository", "gitSha", "workflowRunId", "dataVersion",
  "releaseSequence", "manifestSha256", "provenance", "artifactInventorySha256",
  "contractVersion", "issueRef",
];
const requestKeys = [
  "schemaVersion", "artifactKind", "candidate", "compatibilityEvidenceSha256", "requestedBy",
  "approval", "contractVersion", "issueRef",
];

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function regularJson(file, label) {
  const bytes = await regularBytes(file, label);
  try {
    return [JSON.parse(bytes), bytes];
  } catch {
    throw new Error(`${label} must contain JSON`);
  }
}

export async function regularBytes(file, label) {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return readFile(file);
}

export function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error(`${label} keys are invalid`);
  }
}

export function validateComponent(value) {
  exactKeys(value, componentKeys, "component");
  if (value.schemaVersion !== 1 || value.component !== "data"
    || value.repository !== "AquilaXk/easysubway" || !sha40(value.gitSha)
    || !positiveDecimal(value.workflowRunId) || !text(value.dataVersion)
    || !Number.isInteger(value.releaseSequence) || value.releaseSequence < 1
    || !sha64(value.manifestSha256) || !sha64(value.artifactInventorySha256)
    || value.contractVersion !== "datapack-contract-v3"
    || value.issueRef !== "AquilaXk/easysubway#2699") {
    throw new Error("component is invalid");
  }
  exactKeys(value.provenance, ["sourceSnapshotSetHash"], "component.provenance");
  if (!sha64(value.provenance.sourceSnapshotSetHash)) {
    throw new Error("component provenance is invalid");
  }
  return value;
}

export function validateInventory(value) {
  exactKeys(value, ["schemaVersion", "artifactKind", "entries"], "inventory");
  if (value.schemaVersion !== 1 || value.artifactKind !== "datapack-candidate-inventory"
    || !Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error("inventory is invalid");
  }

  let previousPath;
  for (const entry of value.entries) {
    exactKeys(entry, ["path", "sizeBytes", "sha256"], "inventory entry");
    if (!safeRelativePosixPath(entry.path) || !Number.isInteger(entry.sizeBytes)
      || entry.sizeBytes < 1 || !sha64(entry.sha256)
      || (previousPath != null
        && Buffer.compare(Buffer.from(previousPath), Buffer.from(entry.path)) >= 0)) {
      throw new Error("inventory entry is invalid");
    }
    previousPath = entry.path;
  }
  return value;
}

export function validateCompatibilityEvidence(value, component) {
  exactKeys(value, ["schemaVersion", "artifactKind", "decision", "candidate"], "compatibility evidence");
  if (value.schemaVersion !== 1
    || value.artifactKind !== "datapack-mobile-compatibility-evidence"
    || value.decision !== "PASS"
    || !isDeepStrictEqual(value.candidate, component)) {
    throw new Error("compatibility evidence is invalid");
  }
  return value;
}

export function reviewerFromApproval(bytes) {
  let reviews;
  try {
    reviews = JSON.parse(bytes);
  } catch {
    throw new Error("approval evidence must contain JSON");
  }
  const selected = Array.isArray(reviews)
    ? reviews.filter((review) => review?.state === "approved"
      && Array.isArray(review.environments) && review.environments.length === 1
      && review.environments[0]?.name === "datapack-promotion")
    : [];
  if (selected.length !== 1 || !text(selected[0].user?.login)) {
    throw new Error("exactly one datapack-promotion approval is required");
  }
  return selected[0].user.login;
}

export function validateRequest({
  request,
  component,
  inventory,
  inventoryBytes,
  compatibility,
  compatibilityBytes,
  approvalBytes,
  workflowRunId,
}) {
  validateComponent(component);
  validateInventory(inventory);
  validateCompatibilityEvidence(compatibility, component);
  exactKeys(request, requestKeys, "request");
  if (request.schemaVersion !== 1 || request.artifactKind !== "datapack-promotion-request"
    || !isDeepStrictEqual(request.candidate, component)
    || request.compatibilityEvidenceSha256 !== hash(compatibilityBytes)
    || !text(request.requestedBy) || request.contractVersion !== "datapack-promotion-v1"
    || request.issueRef !== "AquilaXk/easysubway#2699") {
    throw new Error("request is invalid");
  }

  exactKeys(
    request.approval,
    ["workflowRunId", "environment", "reviewer", "approvalEvidenceSha256"],
    "approval",
  );
  if (!positiveDecimal(workflowRunId) || request.approval.workflowRunId !== workflowRunId
    || request.approval.environment !== "datapack-promotion"
    || request.approval.reviewer !== reviewerFromApproval(approvalBytes)
    || request.approval.approvalEvidenceSha256 !== hash(approvalBytes)
    || component.artifactInventorySha256 !== hash(inventoryBytes)) {
    throw new Error("request identity is invalid");
  }
}

export function parseArgs(argv, names) {
  if (argv.length !== names.length * 2) throw new Error("exact arguments required");
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    const name = option?.startsWith("--") ? option.slice(2) : null;
    if (!name || !names.includes(name) || result.has(name) || value == null || value.startsWith("--")) {
      throw new Error("invalid arguments");
    }
    result.set(name, value);
  }
  return result;
}

export function positiveDecimal(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function safeRelativePosixPath(value) {
  return typeof value === "string" && value !== "" && !value.startsWith("/")
    && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function text(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sha64(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha40(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), [
    "request", "component", "inventory", "compatibility-evidence", "approval-evidence",
    "workflow-run-id",
  ]);
  const [request] = await regularJson(args.get("request"), "--request");
  const [component] = await regularJson(args.get("component"), "--component");
  const [inventory, inventoryBytes] = await regularJson(args.get("inventory"), "--inventory");
  const [compatibility, compatibilityBytes] = await regularJson(
    args.get("compatibility-evidence"),
    "--compatibility-evidence",
  );
  const approvalBytes = await regularBytes(args.get("approval-evidence"), "--approval-evidence");
  validateRequest({
    request,
    component,
    inventory,
    inventoryBytes,
    compatibility,
    compatibilityBytes,
    approvalBytes,
    workflowRunId: args.get("workflow-run-id"),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`validate-promotion-request: ${error.message}\n`);
    process.exitCode = 1;
  });
}
