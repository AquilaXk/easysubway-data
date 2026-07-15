#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildRescueManifest, validateRollbackApproval } from "./build-rescue-manifest.mjs";
import { signingPrivateKey } from "./lib/manifest-signing.mjs";
import { validateManifest } from "./lib/manifest-validation.mjs";
import {
  objectUrl,
  putCurrentAndVerify,
  putImmutableAndVerify,
  request,
  sha256,
  validateReferencedPacksForRescue,
} from "./lib/object-storage-publish.mjs";

async function main() {
  const startedAtMs = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const targetSequence = positiveInteger(Number(requiredArg(args, "target-sequence")), "--target-sequence");
  const failedSequence = positiveInteger(Number(requiredArg(args, "failed-sequence")), "--failed-sequence");
  const channel = requiredArg(args, "channel");
  const baseUrl = new URL(requiredArg(args, "base-url"));
  const approval = validateRollbackApproval(
    JSON.parse(await readFile(path.resolve(requiredArg(args, "approval")), "utf8")),
  );
  const manifestOutput = path.resolve(requiredArg(args, "manifest-output"));
  const evidenceOutput = path.resolve(requiredArg(args, "evidence-output"));
  const dryRun = args.has("dry-run");

  const currentResponse = await getRequiredObject(baseUrl, "catalog/current.json");
  const currentBytes = currentResponse.body;
  const current = JSON.parse(currentBytes.toString("utf8"));
  validateManifest(current, { requireProduction: channel === "production" });
  if (current.channel !== channel) throw new Error(`current channel mismatch: ${current.channel} != ${channel}`);

  const releaseKey = `catalog/releases/${targetSequence}.json`;
  const knownGoodResponse = await getRequiredObject(baseUrl, releaseKey);
  const knownGoodBytes = knownGoodResponse.body;
  const knownGood = JSON.parse(knownGoodBytes.toString("utf8"));
  validateManifest(knownGood, { requireProduction: channel === "production", releasesTarget: true });
  if (knownGood.channel !== channel) throw new Error(`known-good channel mismatch: ${knownGood.channel} != ${channel}`);
  if (knownGood.releaseSequence !== targetSequence) throw new Error("known-good releaseSequence mismatch");
  if (approval.targetChannel !== channel) throw new Error("approval targetChannel mismatch");
  if (approval.knownGoodManifestSha256 !== sha256(knownGoodBytes)) {
    throw new Error("approval known-good manifest identity mismatch");
  }
  await validateReferencedPacksForRescue(baseUrl, knownGood);
  const catalogSequences = await authenticatedCatalogSequences(baseUrl, channel);

  if (isSameApprovedRescue(current, approval, targetSequence)) {
    if (approval.failedManifestSha256 !== current.rollbackProvenance.failedManifestSha256) {
      throw new Error("approval failed manifest identity mismatch");
    }
    if (Date.parse(current.expiresAt) <= Date.now()) {
      throw new Error("idempotent rescue expired");
    }
    if (Math.max(...catalogSequences) > current.releaseSequence) {
      throw new Error("immutable catalog advanced beyond the idempotent rescue");
    }
    if (sha256(knownGoodBytes) !== current.rollbackProvenance.knownGoodManifestSha256) {
      throw new Error("idempotent rescue known-good manifest identity mismatch");
    }
    const immutable = await getRequiredObject(baseUrl, `catalog/releases/${current.releaseSequence}.json`);
    if (sha256(immutable.body) !== sha256(currentBytes)) {
      throw new Error("idempotent rescue immutable/current identity mismatch");
    }
    const report = buildReport({
      knownGood,
      knownGoodBytes,
      rescue: current,
      rescueBytes: currentBytes,
      approval,
      baseUrl,
      dryRun,
      manifestLastStatus: "PASS",
      startedAtMs,
      idempotentReplay: true,
    });
    await Promise.all([
      writeOutput(manifestOutput, currentBytes),
      writeOutput(evidenceOutput, Buffer.from(`${JSON.stringify(report, null, 2)}\n`)),
    ]);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  if (current.releaseSequence !== failedSequence) {
    throw new Error("failedSequence must match current manifest releaseSequence");
  }
  const failedResponse = await getRequiredObject(baseUrl, `catalog/releases/${failedSequence}.json`);
  const failedBytes = failedResponse.body;
  const failed = JSON.parse(failedBytes.toString("utf8"));
  validateManifest(failed, { requireProduction: channel === "production", releasesTarget: true });
  if (failed.channel !== channel || failed.releaseSequence !== failedSequence) {
    throw new Error("failed immutable release identity mismatch");
  }
  if (approval.failedManifestSha256 !== sha256(failedBytes)) {
    throw new Error("approval failed manifest identity mismatch");
  }
  const result = buildRescueManifest({
    currentManifest: failed,
    currentManifestBytes: failedBytes,
    failedSequence,
    knownGoodManifest: knownGood,
    knownGoodManifestBytes: knownGoodBytes,
    catalogSequences,
    approval,
    publishedAt: requiredArg(args, "published-at"),
    expiresAt: requiredArg(args, "expires-at"),
    privateKey: knownGood.packs?.some((pack) => pack.artifactKind === "production")
      ? signingPrivateKey()
      : undefined,
  });
  await writeOutput(manifestOutput, result.manifestBytes);

  let manifestLastStatus = "NOT_EXECUTED";
  if (!dryRun) {
    const rescueKey = `catalog/releases/${result.manifest.releaseSequence}.json`;
    await putImmutableAndVerify(baseUrl, rescueKey, result.manifestBytes);
    await putCurrentAndVerify(baseUrl, result.manifestBytes, sha256(currentBytes));
    manifestLastStatus = "PASS";
  }
  const report = {
    ...result.evidence,
    status: "PASS",
    validatorStatus: "PASS",
    manifestLastStatus,
    dryRun,
    productionExecuted: !dryRun && channel === "production" && !isLoopback(baseUrl.hostname),
    executionEnvironment: executionEnvironment(baseUrl, channel, dryRun),
    idempotentReplay: false,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date().toISOString(),
    recoveryDurationSeconds: Math.max(0, Math.ceil((Date.now() - startedAtMs) / 1000)),
  };
  await writeOutput(evidenceOutput, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function buildReport({ knownGood, knownGoodBytes, rescue, rescueBytes, approval, baseUrl, dryRun, manifestLastStatus, startedAtMs, idempotentReplay }) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-rollback-rescue-evidence",
    rollbackApprovalEventId: approval.rollbackApprovalEventId,
    approvedByRole: approval.approvedByRole,
    approvedAt: approval.approvedAt,
    reasonCode: approval.reasonCode,
    from: {
      channel: rescue.channel,
      releaseSequence: rescue.rollbackProvenance.currentReleaseSequence,
      manifestSha256: rescue.rollbackProvenance.failedManifestSha256,
    },
    failed: {
      channel: rescue.channel,
      releaseSequence: rescue.rollbackProvenance.failedReleaseSequence,
      manifestSha256: rescue.rollbackProvenance.failedManifestSha256,
    },
    knownGood: {
      ...identity(knownGood, knownGoodBytes),
      packs: knownGood.packs.map((pack) => ({ id: pack.id, version: pack.version, sha256: pack.sha256, sqliteSha256: pack.sqliteSha256 })),
    },
    rescue: identity(rescue, rescueBytes),
    status: "PASS",
    validatorStatus: "PASS",
    manifestLastStatus,
    dryRun,
    productionExecuted: !dryRun && rescue.channel === "production" && !isLoopback(baseUrl.hostname),
    executionEnvironment: executionEnvironment(baseUrl, rescue.channel, dryRun),
    idempotentReplay,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date().toISOString(),
    recoveryDurationSeconds: Math.max(0, Math.ceil((Date.now() - startedAtMs) / 1000)),
  };
}

function isSameApprovedRescue(current, approval, targetSequence) {
  const provenance = current.rollbackProvenance;
  return provenance?.kind === "MONOTONIC_RESCUE"
    && provenance.rollbackApprovalEventId === approval.rollbackApprovalEventId
    && provenance.approvedByRole === approval.approvedByRole
    && provenance.approvedAt === approval.approvedAt
    && provenance.reasonCode === approval.reasonCode
    && provenance.knownGoodReleaseSequence === targetSequence;
}

function identity(manifest, bytes) {
  return { channel: manifest.channel, releaseSequence: manifest.releaseSequence, manifestSha256: sha256(bytes) };
}

async function getRequiredObject(baseUrl, key) {
  const response = await request(objectUrl(baseUrl, key), "GET");
  if (response.statusCode !== 200) throw new Error(`${key} not found (HTTP ${response.statusCode})`);
  return response;
}

async function authenticatedCatalogSequences(baseUrl, channel) {
  const names = [];
  const starts = new Set();
  let start;
  do {
    if (start && starts.has(start)) throw new Error("immutable catalog pagination did not advance");
    if (start) starts.add(start);
    if (starts.size > 1_000) throw new Error("immutable catalog pagination exceeds 1000 pages");
    const url = new URL(baseUrl);
    url.searchParams.set("prefix", "catalog/releases/");
    url.searchParams.set("fields", "name,etag");
    if (start) url.searchParams.set("start", start);
    const response = await request(url, "GET");
    if (response.statusCode !== 200) {
      throw new Error(`immutable catalog listing failed with HTTP ${response.statusCode}`);
    }
    let page;
    try {
      page = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new Error("immutable catalog listing must be JSON");
    }
    if (!page || typeof page !== "object" || !Array.isArray(page.objects)) {
      throw new Error("immutable catalog listing objects must be an array");
    }
    for (const object of page.objects) {
      if (!object || typeof object.name !== "string") {
        throw new Error("immutable catalog object name is required");
      }
      names.push(object.name);
    }
    start = page.nextStartWith;
    if (start !== undefined && (typeof start !== "string" || start.length === 0)) {
      throw new Error("immutable catalog nextStartWith is invalid");
    }
  } while (start);

  const sequences = names.map((name) => {
    const match = name.match(/^catalog\/releases\/([1-9][0-9]*)\.json$/);
    if (!match) throw new Error(`unexpected immutable catalog object: ${name}`);
    return positiveInteger(Number(match[1]), "immutable catalog sequence");
  });
  if (sequences.length === 0 || new Set(sequences).size !== sequences.length) {
    throw new Error("immutable catalog listing must contain unique release sequences");
  }
  const maximum = Math.max(...sequences);
  const maximumResponse = await getRequiredObject(baseUrl, `catalog/releases/${maximum}.json`);
  const maximumManifest = JSON.parse(maximumResponse.body.toString("utf8"));
  validateManifest(maximumManifest, { requireProduction: channel === "production", releasesTarget: true });
  if (maximumManifest.channel !== channel || maximumManifest.releaseSequence !== maximum) {
    throw new Error("maximum immutable release identity mismatch");
  }
  return sequences;
}

async function writeOutput(outputPath, bytes) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function executionEnvironment(baseUrl, channel, dryRun) {
  if (dryRun) return "DRY_RUN";
  if (isLoopback(baseUrl.hostname)) return "LOCAL_FIXTURE";
  return channel === "production" ? "PRODUCTION" : "NON_PRODUCTION";
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--dry-run") {
      if (args.has("dry-run")) throw new Error("duplicate argument: --dry-run");
      args.set("dry-run", "true");
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    const name = key.slice(2);
    if (args.has(name)) throw new Error(`duplicate argument: ${key}`);
    args.set(name, value);
    index += 1;
  }
  return args;
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (typeof value !== "string" || value.trim() === "") throw new Error(`missing required argument: --${name}`);
  return value.trim();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
