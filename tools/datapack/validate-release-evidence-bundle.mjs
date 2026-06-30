#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const SHA256 = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED_EXTERNAL"]);

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireField(bundle, field) {
  if (bundle[field] === undefined || bundle[field] === "") {
    throw new Error(`release evidence bundle missing ${field}`);
  }
  return bundle[field];
}

function validateSha(bundle, field) {
  const value = requireField(bundle, field);
  if (!SHA256.test(value)) {
    throw new Error(`${field} must be sha256`);
  }
}

function validateStatus(bundle, field, requirePass) {
  const value = requireField(bundle, field);
  if (!STATUSES.has(value)) {
    throw new Error(`${field} must be a release gate status`);
  }
  if (requirePass && value !== "PASS") {
    throw new Error(`${field} must be PASS for publish`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const bundlePath = argValue(args, "--bundle");
  const requirePass = args.includes("--require-pass");
  if (!bundlePath) {
    throw new Error("--bundle is required");
  }

  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["artifactKind", "datapack-release-evidence-bundle"],
  ]) {
    if (bundle[field] !== expected) {
      throw new Error(`${field} must be ${expected}`);
    }
  }

  for (const field of [
    "candidateId",
    "scopeId",
    "releaseRequestId",
    "builderGitSha",
    "createdAt",
    "workflowRunUrl",
  ]) {
    requireField(bundle, field);
  }
  for (const field of [
    "buildSpecSha256",
    "supportedDenominatorSha256",
    "sourceSnapshotSetHash",
    "approvedAliasLedgerHash",
    "facilityEvidenceLedgerHash",
    "routeEvidenceLedgerHash",
    "approvedOverrideSetHash",
    "normalizedSourceInventorySha256",
    "sqliteSha256",
    "gzipSha256",
    "manifestSha256",
    "coverageSummarySha256",
    "strictRouteRegressionSha256",
    "androidEvidenceSha256",
  ]) {
    validateSha(bundle, field);
  }
  for (const field of [
    "validatorStatus",
    "coverageStatus",
    "strictRouteRegressionStatus",
    "manifestSignatureStatus",
    "androidEvidenceStatus",
  ]) {
    validateStatus(bundle, field, requirePass);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
