#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decideScheduledRun } from "./freshness-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

export function evaluateReleaseDecision({
  candidateManifest,
  currentManifest,
  candidateManifestSha256,
  currentManifestSha256,
  buildSpec,
  buildSpecSha256,
  releaseRequest,
  strictValidationPassed,
  publishAttempted,
  remoteValidationPassed,
  evaluationAt,
  refreshBeforeMillis = 0,
}) {
  const evaluatedMillis = requiredUtcInstant(evaluationAt, "evaluationAt");
  const candidateIdentity = stableManifestIdentity(candidateManifest);
  const currentIdentity = currentManifest == null ? null : stableManifestIdentity(currentManifest);
  const materialChange = currentManifest == null
    || candidateIdentity !== currentIdentity;
  const requiredRefreshBeforeMillis = requiredNonNegativeInteger(refreshBeforeMillis, "refreshBeforeMillis");
  const currentExpiresAtMillis = currentManifest == null
    ? null
    : requiredUtcInstant(currentManifest.expiresAt, "currentManifest.expiresAt");
  const currentExpired = currentExpiresAtMillis != null && evaluatedMillis >= currentExpiresAtMillis;
  const currentExpiring = currentExpiresAtMillis != null
    && !currentExpired
    && currentExpiresAtMillis - evaluatedMillis <= requiredRefreshBeforeMillis;
  const publishRequired = materialChange || currentExpired || currentExpiring;
  const approvalValid = validApproval({ buildSpec, buildSpecSha256, releaseRequest });
  const candidateSequenceValid = Number.isInteger(candidateManifest.releaseSequence)
    && candidateManifest.releaseSequence >= 1;
  const sequenceValid = !publishRequired || (candidateSequenceValid
    && (currentManifest == null
      || (Number.isInteger(currentManifest.releaseSequence)
        && candidateManifest.releaseSequence > currentManifest.releaseSequence)));
  const sequenceRequiredAndInvalid = approvalValid && !sequenceValid;
  const effectiveStrictValidationPassed = strictValidationPassed && !sequenceRequiredAndInvalid;
  const scheduled = decideScheduledRun({
    materialChange,
    approvalValid,
    strictValidationPassed: effectiveStrictValidationPassed,
    publishRequired,
    publishAttempted,
    remoteValidationPassed,
  });
  const reasonCodes = [];
  if (currentExpired) reasonCodes.push("PACK_PUBLISH_FRESHNESS_EXPIRED");
  if (currentExpiring) reasonCodes.push("PACK_PUBLISH_FRESHNESS_EXPIRING");
  if (publishRequired && !sequenceValid) reasonCodes.push("PUBLISH_SEQUENCE_NOT_INCREASING");
  if (materialChange && !approvalValid) reasonCodes.push("MATERIAL_CHANGE_UNAPPROVED");
  if (scheduled.outcome === "PUBLISH_REQUIRED") reasonCodes.push("PUBLISH_REQUIRED_NOT_COMPLETED");
  if (publishAttempted && !remoteValidationPassed) reasonCodes.push("POST_PUBLISH_REMOTE_VALIDATION_FAILED");
  const selectedManifest = selectedManifestIdentity({
    outcome: scheduled.outcome,
    candidateManifest,
    candidateManifestSha256,
    currentManifest,
    currentManifestSha256,
  });
  if (selectedManifest && (!isSha256(selectedManifest.sha256)
    || !Number.isSafeInteger(selectedManifest.releaseSequence)
    || selectedManifest.releaseSequence < 1)) {
    throw new Error("final release decision requires a selected manifest sha256 and releaseSequence");
  }

  return {
    schemaVersion: 1,
    artifactKind: "datapack-release-decision",
    ...scheduled,
    materialChange,
    approvalValid,
    strictValidationPassed: effectiveStrictValidationPassed,
    publishRequired,
    publishAttempted,
    remoteValidationPassed,
    sourceSnapshotSetHash: buildSpec?.sourceSnapshotSetHash ?? "-",
    selectedManifestSha256: selectedManifest?.sha256 ?? null,
    selectedReleaseSequence: selectedManifest?.releaseSequence ?? null,
    reasonCodes,
    evaluationAt: new Date(evaluatedMillis).toISOString(),
  };
}

function selectedManifestIdentity({
  outcome, candidateManifest, candidateManifestSha256, currentManifest, currentManifestSha256,
}) {
  if (outcome === "PUBLISHED_AND_VERIFIED") {
    return { sha256: candidateManifestSha256, releaseSequence: candidateManifest.releaseSequence };
  }
  if (outcome === "NO_CHANGE_VALID") {
    return { sha256: currentManifestSha256, releaseSequence: currentManifest?.releaseSequence };
  }
  return null;
}

function stableManifestIdentity(manifest) {
  if (!manifest || !Array.isArray(manifest.packs) || manifest.packs.length === 0) {
    throw new Error("manifest.packs must be a non-empty array");
  }
  const {
    releaseSequence: _releaseSequence,
    publishedAt: _publishedAt,
    expiresAt: _expiresAt,
    signature: _signature,
    ...stable
  } = manifest;
  stable.packs = manifest.packs.map((pack) => {
    const normalized = {
      ...pack,
      id: requiredString(pack.id, "pack.id"),
      version: requiredString(String(pack.version ?? ""), "pack.version"),
      sha256: requiredSha256(pack.sha256, "pack.sha256"),
      sqliteSha256: requiredSha256(pack.sqliteSha256, "pack.sqliteSha256"),
      schemaVersion: requiredString(String(pack.schemaVersion ?? ""), "pack.schemaVersion"),
    };
    if (pack.sourceInventory != null) {
      if (!Array.isArray(pack.sourceInventory)) {
        throw new Error("pack.sourceInventory must be an array");
      }
      normalized.sourceInventory = pack.sourceInventory.map((source) => ({
        ...source,
        id: requiredString(source.id, "source.id"),
        updatedAt: requiredString(source.updatedAt, "source.updatedAt"),
        fields: [...(source.fields ?? [])].sort(compareStrings),
      })).sort((left, right) => compareStrings(left.id, right.id));
    }
    return normalized;
  }).sort((left, right) => compareStrings(left.id, right.id) || compareStrings(left.version, right.version));
  return JSON.stringify(canonicalize(stable));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareStrings).map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validApproval({ buildSpec, buildSpecSha256, releaseRequest }) {
  if (!buildSpec || !releaseRequest) return false;
  return releaseRequest.artifactKind === "datapack-release-request"
    && releaseRequest.targetChannel === "production"
    && typeof releaseRequest.approvalId === "string"
    && releaseRequest.approvalId.length > 0
    && requiredNonEmptyPair(releaseRequest.requestedBy, releaseRequest.approvedBy)
    && isSha256(buildSpecSha256)
    && isSha256(buildSpec.sourceSnapshotSetHash)
    && isSha256(buildSpec.approvedAliasLedgerHash)
    && releaseRequest.candidateId === buildSpec.candidateId
    && releaseRequest.buildSpecSha256 === buildSpecSha256
    && releaseRequest.sourceSnapshotSetHash === buildSpec.sourceSnapshotSetHash
    && releaseRequest.approvedLedgerHash === buildSpec.approvedAliasLedgerHash;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(value ?? "");
}

function requiredNonEmptyPair(requestedBy, approvedBy) {
  return typeof requestedBy === "string" && requestedBy.length > 0
    && typeof approvedBy === "string" && approvedBy.length > 0
    && requestedBy !== approvedBy;
}

async function main(argv) {
  const args = parseArgs(argv);
  const currentDocument = await optionalJsonDocument(args.get("current-manifest"));
  const currentManifest = currentDocument?.value ?? null;
  const alertOnly = args.has("alert-only");
  if (alertOnly && !currentManifest) {
    throw new Error("--current-manifest is required with --alert-only");
  }
  const candidateDocument = alertOnly
    ? currentDocument
    : await requiredJsonDocument(args, "candidate-manifest");
  const candidateManifest = candidateDocument.value;

  const buildSpecPath = args.get("build-spec");
  const buildSpecBytes = buildSpecPath ? await readFile(buildSpecPath) : null;
  const buildSpec = buildSpecBytes ? JSON.parse(buildSpecBytes.toString("utf8")) : null;
  const releaseRequest = await optionalJson(args.get("release-request"));
  const freshnessPolicy = await optionalJson(args.get("freshness-policy"));
  const evaluationAt = args.get("evaluation-at") ?? new Date().toISOString();
  const strictValidationPassed = alertOnly || args.get("strict-validation-status") === "PASS";
  const publishAttempted = args.get("publish-attempted") === "true";
  const remoteValidationPassed = args.get("remote-validation-status") === "PASS";
  const decision = evaluateReleaseDecision({
    candidateManifest,
    currentManifest,
    candidateManifestSha256: sha256(candidateDocument.bytes),
    currentManifestSha256: currentDocument ? sha256(currentDocument.bytes) : null,
    buildSpec,
    buildSpecSha256: buildSpecBytes ? sha256(buildSpecBytes) : null,
    releaseRequest,
    strictValidationPassed,
    publishAttempted,
    remoteValidationPassed,
    evaluationAt,
    refreshBeforeMillis: freshnessPolicy == null
      ? 0
      : requiredFixedDurationMillis(freshnessPolicy.scheduledPipeline?.cadence),
  });

  const outputPath = requiredArg(args, "output");
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(decision, null, 2)}\n`);
  const githubOutput = args.get("github-output");
  if (githubOutput) {
    await appendFile(githubOutput, [
      `outcome=${decision.outcome}`,
      `productionWriteAllowed=${decision.productionWriteAllowed}`,
      `materialChange=${decision.materialChange}`,
      `approvalValid=${decision.approvalValid}`,
      `publishRequired=${decision.publishRequired}`,
      `sourceSnapshotSetHash=${decision.sourceSnapshotSetHash}`,
      `reasonCodes=${decision.reasonCodes.join(",") || "NONE"}`,
    ].join("\n") + "\n");
  }
}

function parseArgs(argv) {
  const flags = new Set(["alert-only"]);
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new Error(`invalid argument: ${token ?? "<end>"}`);
    const name = token.slice(2);
    if (args.has(name)) throw new Error(`duplicate argument: ${token}`);
    if (flags.has(name)) {
      args.set(name, true);
      continue;
    }
    const value = argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`missing value: ${token}`);
    args.set(name, value);
  }
  return args;
}

async function requiredJsonDocument(args, name) {
  const bytes = await readFile(requiredArg(args, name));
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

async function optionalJson(file) {
  return file ? JSON.parse(await readFile(file, "utf8")) : null;
}

async function optionalJsonDocument(file) {
  if (!file) return null;
  const bytes = await readFile(file);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requiredFixedDurationMillis(value) {
  const days = /^P([1-9][0-9]*)D$/.exec(value ?? "");
  if (days) return Number(days[1]) * 86_400_000;
  const hours = /^PT([1-9][0-9]*)H$/.exec(value ?? "");
  if (hours) return Number(hours[1]) * 3_600_000;
  throw new Error("freshness policy scheduledPipeline.cadence must be a fixed day/hour duration");
}

function requiredSha256(value, label) {
  if (!isSha256(value)) throw new Error(`${label} must be sha256`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
