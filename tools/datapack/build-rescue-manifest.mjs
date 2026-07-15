#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  requiredSha256,
  sha256,
  validateManifest,
} from "./lib/manifest-validation.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";

export function buildRescueManifest(input) {
  const current = requiredManifest(input.currentManifest, "currentManifest");
  const knownGood = requiredManifest(input.knownGoodManifest, "knownGoodManifest");
  const currentBytes = requiredBytes(input.currentManifestBytes, "currentManifestBytes");
  const knownGoodBytes = requiredBytes(input.knownGoodManifestBytes, "knownGoodManifestBytes");
  assertBytesMatchManifest(currentBytes, current, "currentManifestBytes");
  assertBytesMatchManifest(knownGoodBytes, knownGood, "knownGoodManifestBytes");
  if (current.manifestVersion !== 2 || knownGood.manifestVersion !== 2) {
    throw new Error("current and known-good manifests must be v2");
  }
  validateManifest(current);
  validateManifest(knownGood);

  const failedSequence = positiveInteger(input.failedSequence, "failedSequence");
  if (failedSequence !== current.releaseSequence) {
    throw new Error("failedSequence must match current manifest releaseSequence");
  }
  if (knownGood.channel !== current.channel) {
    throw new Error("known-good channel must match current channel");
  }
  if (knownGood.releaseSequence >= failedSequence) {
    throw new Error("known-good releaseSequence must be lower than failedSequence");
  }

  const catalogSequences = requiredCatalogSequences(input.catalogSequences);
  if (!catalogSequences.includes(current.releaseSequence) || !catalogSequences.includes(knownGood.releaseSequence)) {
    throw new Error("catalogSequences must contain current and known-good releases");
  }
  const approval = validateRollbackApproval(input.approval);
  if (approval.targetChannel !== current.channel) {
    throw new Error("approval targetChannel mismatch");
  }
  if (approval.failedManifestSha256 !== sha256(currentBytes)) {
    throw new Error("approval failed manifest identity mismatch");
  }
  if (approval.knownGoodManifestSha256 !== sha256(knownGoodBytes)) {
    throw new Error("approval known-good manifest identity mismatch");
  }
  const publishedAt = dateTime(input.publishedAt, "publishedAt");
  const expiresAt = dateTime(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(publishedAt)) {
    throw new Error("expiresAt must be after publishedAt");
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  if (Date.parse(expiresAt) <= now.getTime()) {
    throw new Error("expiresAt must be in the future");
  }
  if (Date.parse(approval.approvedAt) > Date.parse(publishedAt)) {
    throw new Error("approval.approvedAt must not be after publishedAt");
  }
  const hasProductionPack = knownGood.packs.some((pack) => pack.artifactKind === "production");
  if (hasProductionPack && (typeof input.privateKey !== "string" || input.privateKey.trim() === "")) {
    throw new Error("signing private key is required");
  }

  const releaseSequence = Math.max(current.releaseSequence, failedSequence, ...catalogSequences) + 1;
  if (!Number.isSafeInteger(releaseSequence)) throw new Error("rescue releaseSequence exceeds the safe integer range");
  const rollbackProvenance = {
    kind: "MONOTONIC_RESCUE",
    currentReleaseSequence: current.releaseSequence,
    failedReleaseSequence: failedSequence,
    failedManifestSha256: sha256(currentBytes),
    knownGoodReleaseSequence: knownGood.releaseSequence,
    knownGoodManifestSha256: sha256(knownGoodBytes),
    rollbackApprovalEventId: approval.rollbackApprovalEventId,
    approvedByRole: approval.approvedByRole,
    approvedAt: approval.approvedAt,
    reasonCode: approval.reasonCode,
  };
  const unsigned = {
    manifestVersion: 2,
    channel: current.channel,
    releaseSequence,
    publishedAt,
    expiresAt,
    keyId: current.keyId,
    ttlSeconds: knownGood.ttlSeconds,
    ...(knownGood.activePack === undefined ? {} : { activePack: knownGood.activePack }),
    ...(knownGood.emergencyOverride === undefined ? {} : { emergencyOverride: knownGood.emergencyOverride }),
    packs: knownGood.packs,
    rollbackProvenance,
  };
  const manifest = {
    ...unsigned,
    signature: hasProductionPack
      ? {
          algorithm: "rsa-sha256-manifest-v2",
          value: rsaSha256Signature(input.privateKey, canonicalJson(unsigned)),
        }
      : {
          algorithm: "sha256-manifest-v2",
          value: sha256(Buffer.from(canonicalJson(unsigned))),
        },
  };
  validateManifest(manifest, { requireProduction: current.channel === "production", releasesTarget: true });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = sha256(manifestBytes);

  return {
    manifest,
    manifestBytes,
    evidence: {
      schemaVersion: 1,
      artifactKind: "datapack-rollback-rescue-evidence",
      rollbackApprovalEventId: approval.rollbackApprovalEventId,
      approvedByRole: approval.approvedByRole,
      approvedAt: approval.approvedAt,
      reasonCode: approval.reasonCode,
      from: identity(current, currentBytes),
      failed: identity(current, currentBytes),
      knownGood: {
        ...identity(knownGood, knownGoodBytes),
        packs: knownGood.packs.map((pack) => ({
          id: pack.id,
          version: pack.version,
          sha256: requiredSha256(pack.sha256, `${pack.id}@${pack.version}.sha256`),
          sqliteSha256: requiredSha256(pack.sqliteSha256, `${pack.id}@${pack.version}.sqliteSha256`),
        })),
      },
      rescue: {
        channel: manifest.channel,
        releaseSequence,
        manifestSha256,
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const currentPath = path.resolve(requiredArg(args, "current-manifest"));
  const knownGoodPath = path.resolve(requiredArg(args, "known-good-manifest"));
  const catalogPath = path.resolve(requiredArg(args, "catalog-sequences"));
  const approvalPath = path.resolve(requiredArg(args, "approval"));
  const outputPath = path.resolve(requiredArg(args, "output"));
  const evidenceOutputPath = path.resolve(requiredArg(args, "evidence-output"));
  const [currentBytes, knownGoodBytes, catalogBytes, approvalBytes] = await Promise.all([
    readFile(currentPath),
    readFile(knownGoodPath),
    readFile(catalogPath),
    readFile(approvalPath),
  ]);
  const currentManifest = JSON.parse(currentBytes.toString("utf8"));
  const knownGoodManifest = JSON.parse(knownGoodBytes.toString("utf8"));
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const result = buildRescueManifest({
    currentManifest,
    currentManifestBytes: currentBytes,
    failedSequence: Number(requiredArg(args, "failed-sequence")),
    knownGoodManifest,
    knownGoodManifestBytes: knownGoodBytes,
    catalogSequences: Array.isArray(catalog) ? catalog : catalog.sequences,
    approval: JSON.parse(approvalBytes.toString("utf8")),
    publishedAt: requiredArg(args, "published-at"),
    expiresAt: requiredArg(args, "expires-at"),
    privateKey: knownGoodManifest.packs?.some((pack) => pack.artifactKind === "production")
      ? signingPrivateKey()
      : undefined,
  });
  await Promise.all([
    writeJsonBytes(outputPath, result.manifestBytes),
    writeJsonBytes(evidenceOutputPath, Buffer.from(`${JSON.stringify(result.evidence, null, 2)}\n`)),
  ]);
}

function identity(manifest, bytes) {
  return {
    channel: manifest.channel,
    releaseSequence: manifest.releaseSequence,
    manifestSha256: sha256(bytes),
  };
}

function requiredManifest(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredBytes(value, label) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty Buffer`);
  }
  return value;
}

function assertBytesMatchManifest(bytes, manifest, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain JSON`);
  }
  if (canonicalJson(parsed) !== canonicalJson(manifest)) {
    throw new Error(`${label} must match its manifest`);
  }
}

function requiredCatalogSequences(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("catalogSequences must be a non-empty array");
  }
  const sequences = value.map((sequence) => positiveInteger(sequence, "catalogSequences[]"));
  if (new Set(sequences).size !== sequences.length) {
    throw new Error("catalogSequences must not contain duplicates");
  }
  return sequences;
}

export function validateRollbackApproval(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("approval must be an object");
  }
  if (value.schemaVersion !== 1) throw new Error("approval.schemaVersion is invalid");
  if (value.artifactKind !== "datapack-rollback-approval") {
    throw new Error("approval.artifactKind is invalid");
  }
  return {
    schemaVersion: value.schemaVersion,
    artifactKind: value.artifactKind,
    rollbackApprovalEventId: matched(value.rollbackApprovalEventId, "approval.rollbackApprovalEventId", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    targetChannel: matched(value.targetChannel, "approval.targetChannel", /^(dev|staging|production)$/),
    failedManifestSha256: requiredSha256(value.failedManifestSha256, "approval.failedManifestSha256"),
    knownGoodManifestSha256: requiredSha256(value.knownGoodManifestSha256, "approval.knownGoodManifestSha256"),
    approvedBy: nonEmpty(value.approvedBy, "approval.approvedBy"),
    approvedByRole: matched(value.approvedByRole, "approval.approvedByRole", /^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
    approvedAt: dateTime(value.approvedAt, "approval.approvedAt"),
    reasonCode: matched(value.reasonCode, "approval.reasonCode", /^[A-Z][A-Z0-9_]{0,63}$/),
  };
}

function matched(value, label, pattern) {
  const text = nonEmpty(value, label);
  if (!pattern.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function dateTime(value, label) {
  const text = nonEmpty(value, label);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new Error(`${label} must be an ISO date-time with timezone`);
  }
  return text;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    const name = key.slice(2);
    if (args.has(name)) throw new Error(`duplicate argument: ${key}`);
    args.set(name, value);
  }
  return args;
}

function requiredArg(args, name) {
  return nonEmpty(args.get(name), `--${name}`);
}

async function writeJsonBytes(outputPath, bytes) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
