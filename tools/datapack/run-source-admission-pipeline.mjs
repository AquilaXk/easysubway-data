#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sortJson, compareStrings } from "./lib/ledger-admission-cli.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const quotaEvidenceKeys = ["defaultDailyLimit", "portal", "productionUseAllowed", "unlockStatus"];

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const candidateId = requireArg(args, "candidate");
  const evidenceDir = path.resolve(root, requireArg(args, "evidence-dir"));
  await mkdir(evidenceDir, { recursive: true });

  const rawPath = path.join(evidenceDir, `${candidateId}.raw`);
  const samplePath = path.join(evidenceDir, `${candidateId}.sample-evidence.json`);
  const snapshotPath = path.join(evidenceDir, `${requireArg(args, "snapshot-id")}.snapshot.json`);
  const canonicalRawPath = path.join(evidenceDir, `${requireArg(args, "snapshot-id")}.canonical.raw`);
  const outputInventoryPath = path.resolve(root, requireArg(args, "output-inventory"));

  const raw = await readRaw(args);
  assertNoCredential(raw);
  await writeFile(rawPath, raw);

  const sample = await buildSampleEvidence({ candidateId, rawPath, samplePath, args });
  const snapshot = await buildSnapshot({ rawPath, canonicalRawPath, snapshotPath, args });
  const adminReview = await readJson(path.resolve(root, requireArg(args, "admin-review")));
  const adminReviewRecordHash = validateAdminReview({ adminReview, candidateId, sample, snapshot, args });
  const inventory = await readJson(path.resolve(root, requireArg(args, "inventory")));
  const outputInventory = admitSource({ inventory, productionSource: adminReview.productionSource });
  await writeFile(outputInventoryPath, `${JSON.stringify(outputInventory, null, 2)}\n`);
  await execNode([
    "tools/datapack/validate-source-inventory.mjs",
    "--inventory",
    outputInventoryPath,
    "--candidates",
    args.candidates,
  ]);

  const summary = {
    schemaVersion: 1,
    artifactKind: "source-admission-pipeline-evidence",
    candidateId,
    sourceId: requireArg(args, "source-id"),
    snapshotId: snapshot.snapshotId,
    decision: adminReview.decision,
    sampleEvidencePath: path.relative(root, samplePath),
    sourceSnapshotPath: path.relative(root, snapshotPath),
    outputInventoryPath: path.relative(root, outputInventoryPath),
    rawObjectUri: snapshot.rawObjectUri,
    rawSha256: sample.rawSha256,
    schemaFingerprint: sample.schemaFingerprint,
    providerRecordHashes: sample.providerRecordHashes,
    sourceSnapshotSetHash: sha256(JSON.stringify([snapshot])),
    sourceInventorySha256: sha256(JSON.stringify(outputInventory)),
    adminReviewRecordHash,
    licenseEvidenceHash: adminReview.licenseEvidenceHash,
    aliasLedgerHash: adminReview.aliasLedgerHash,
    operatorMappingLedgerHash: adminReview.operatorMappingLedgerHash,
    facilityEvidenceLedgerHash: adminReview.facilityEvidenceLedgerHash,
    routeEvidenceLedgerHash: adminReview.routeEvidenceLedgerHash,
    overrideHash: adminReview.overrideHash,
    admissionDurationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    quotaEvidence: adminReview.quotaEvidence,
  };

  await writeFile(path.resolve(root, requireArg(args, "output")), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`source admission pipeline evidence written: ${path.relative(root, requireArg(args, "output"))}`);
}

function parseArgs(argv) {
  const args = {
    candidates: "tools/datapack/source-candidates.json",
    inventory: "tools/datapack/source-inventory.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function readRaw(args) {
  if ((args["raw-input"] == null) === (args["url-template"] == null)) {
    throw new Error("exactly one of --raw-input or --url-template is required");
  }
  if (args["raw-input"]) {
    return readFile(path.resolve(root, args["raw-input"]), "utf8");
  }
  const key = process.env[requireArg(args, "service-key-env")];
  if (!key) {
    throw new Error(`${args["service-key-env"]} is required for live source fetch`);
  }
  const url = args["url-template"].replace("{serviceKey}", encodeURIComponent(key));
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error("source live fetch failed before response");
  }
  if (!response.ok) {
    throw new Error(`source live fetch failed: ${response.status}`);
  }
  try {
    return await response.text();
  } catch {
    throw new Error("source live fetch response read failed");
  }
}

async function buildSampleEvidence({ candidateId, rawPath, samplePath, args }) {
  const { stdout } = await execNode([
    "tools/datapack/build-source-candidate-sample-evidence.mjs",
    "--candidates",
    args.candidates,
    "--candidate",
    candidateId,
    "--response",
    rawPath,
  ]);
  await writeFile(samplePath, stdout);
  await execNode([
    "tools/datapack/validate-source-candidate-sample.mjs",
    "--candidates",
    args.candidates,
    "--candidate",
    candidateId,
    "--sample",
    samplePath,
  ]);
  return JSON.parse(stdout);
}

async function buildSnapshot({ rawPath, canonicalRawPath, snapshotPath, args }) {
  await execNode([
    "tools/datapack/build-source-snapshot.mjs",
    "--input",
    rawPath,
    "--raw-output",
    canonicalRawPath,
    "--output",
    snapshotPath,
    "--snapshot-id",
    requireArg(args, "snapshot-id"),
    "--source-id",
    requireArg(args, "source-id"),
    "--provider",
    requireArg(args, "provider"),
    "--retrieved-at",
    requireArg(args, "retrieved-at"),
    "--raw-object-uri",
    requireArg(args, "raw-object-uri"),
    "--freshness-expires-at",
    requireArg(args, "freshness-expires-at"),
    "--raw-retention-expires-at",
    requireArg(args, "raw-retention-expires-at"),
    ...(args["source-updated-at"] ? ["--source-updated-at", args["source-updated-at"]] : []),
  ]);
  return readJson(snapshotPath);
}

function validateAdminReview({ adminReview, candidateId, sample, snapshot, args }) {
  if (adminReview.schemaVersion !== 1) throw new Error("adminReview.schemaVersion must be 1");
  if (adminReview.artifactKind !== "source-admission-admin-review") {
    throw new Error("adminReview.artifactKind must be source-admission-admin-review");
  }
  if (adminReview.decision !== "APPROVED") throw new Error("adminReview.decision must be APPROVED");
  assertEqual(adminReview.candidateId, candidateId, "adminReview.candidateId");
  assertEqual(adminReview.sourceId, requireArg(args, "source-id"), "adminReview.sourceId");
  assertEqual(adminReview.snapshotId, snapshot.snapshotId, "adminReview.snapshotId");
  assertEqual(adminReview.sampleEvidenceHash, sample.evidenceHash, "adminReview.sampleEvidenceHash");
  requiredText(adminReview.approvedBy, "adminReview.approvedBy");
  requiredText(adminReview.approvedAt, "adminReview.approvedAt");
  for (const field of [
    "licenseEvidenceHash",
    "aliasLedgerHash",
    "operatorMappingLedgerHash",
    "facilityEvidenceLedgerHash",
    "routeEvidenceLedgerHash",
    "overrideHash",
  ]) {
    assertSha256(adminReview[field], `adminReview.${field}`);
  }
  validateQuotaEvidence(adminReview.quotaEvidence, "adminReview.quotaEvidence");
  if (!adminReview.productionSource || adminReview.productionSource.id !== adminReview.sourceId) {
    throw new Error("adminReview.productionSource.id must match adminReview.sourceId");
  }
  const productionAdmissionEvidence = adminReview.productionSource.admissionEvidence;
  if (productionAdmissionEvidence != null) {
    if (typeof productionAdmissionEvidence !== "object" || Array.isArray(productionAdmissionEvidence)) {
      throw new Error("adminReview.productionSource.admissionEvidence must be an object");
    }
    validateQuotaEvidence(
      productionAdmissionEvidence.quotaEvidence,
      "adminReview.productionSource.admissionEvidence.quotaEvidence",
    );
    const productionQuota = JSON.stringify(sortJson(productionAdmissionEvidence.quotaEvidence));
    const adminQuota = JSON.stringify(sortJson(adminReview.quotaEvidence));
    if (productionQuota !== adminQuota) {
      throw new Error("adminReview.productionSource.admissionEvidence.quotaEvidence must match adminReview.quotaEvidence");
    }
  }
  const fieldsProvided = new Set(adminReview.productionSource.fieldsProvided ?? []);
  for (const field of sample.fields) {
    if (!fieldsProvided.has(field)) {
      throw new Error(`adminReview.productionSource.fieldsProvided missing sample field: ${field}`);
    }
  }
  return sha256(JSON.stringify(sortJson(adminReview)));
}

function validateQuotaEvidence(quotaEvidence, label) {
  if (!quotaEvidence || typeof quotaEvidence !== "object" || Array.isArray(quotaEvidence)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(quotaEvidence).sort(compareStrings);
  if (JSON.stringify(keys) !== JSON.stringify(quotaEvidenceKeys)) {
    throw new Error(`${label} must only include ${quotaEvidenceKeys.join(", ")}`);
  }
  requiredText(quotaEvidence.portal, `${label}.portal`);
  if (
    quotaEvidence.defaultDailyLimit !== "unlimited" &&
    (!Number.isInteger(quotaEvidence.defaultDailyLimit) || quotaEvidence.defaultDailyLimit < 0)
  ) {
    throw new Error(`${label}.defaultDailyLimit must be a non-negative integer or unlimited`);
  }
  requiredText(quotaEvidence.unlockStatus, `${label}.unlockStatus`);
  if (typeof quotaEvidence.productionUseAllowed !== "boolean") {
    throw new Error(`${label}.productionUseAllowed must be a boolean`);
  }
}

function admitSource({ inventory, productionSource }) {
  const sources = inventory.sources.filter((source) => source.id !== productionSource.id);
  sources.push(productionSource);
  sources.sort((left, right) => compareStrings(left.id, right.id));
  return { ...inventory, sources };
}

async function execNode(args) {
  return execFileAsync(process.execPath, args, { cwd: root });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertNoCredential(raw) {
  if (/"?(serviceKey|apiKey|access[_-]?token|secret)"?\s*[:=]\s*"?[^\s&"'}]+/i.test(raw)) {
    throw new Error("source admission raw response contains credential-like token");
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must be ${expected}`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 hex string`);
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireArg(args, name) {
  return requiredText(args[name], `--${name}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export { sortJson };
