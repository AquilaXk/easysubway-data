#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import {
  validateKricAccessibilityRawCollection,
  validateKricAccessibilitySnapshotIdentity,
} from "./collect-kric-accessibility-snapshots.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import {
  publishImmutableKricRawObject,
  requiredText,
  requiredUtcInstant,
  writeKricRawReceipt,
} from "./lib/kric-raw-object-storage.mjs";

const execFileAsync = promisify(execFileCallback);
const BUCKET = "easysubway-datapack-sources";
const SOURCE_ID = "kric-station-convenience-standard";
const ARTIFACT_KIND = "kric-accessibility-raw-collection";
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SHA256 = /^[0-9a-f]{64}$/u;

export async function publishKricAccessibilityRawArtifact({
  observationRoot,
  receiptPath,
  expectedBucketOwner,
  repositoryRoot = REPOSITORY_ROOT,
  execFileImpl = execFileAsync,
} = {}) {
  const root = path.resolve(requiredAbsolutePath(observationRoot, "observationRoot"));
  const resolvedReceipt = path.resolve(requiredAbsolutePath(receiptPath, "receiptPath"));
  const manifest = JSON.parse(await readFile(path.join(root, "observation.json"), "utf8"));
  validateManifest(manifest);
  const snapshotPath = containedFile(root, manifest.snapshotFile);
  const rawArtifactPath = containedFile(root, manifest.rawArtifactFile);
  const [snapshotBytes, rawArtifactBytes] = await Promise.all([
    readFile(snapshotPath),
    readFile(rawArtifactPath),
  ]);
  const snapshot = validateKricAccessibilitySnapshotIdentity(JSON.parse(snapshotBytes));
  const rawArtifact = validateKricAccessibilityRawCollection(JSON.parse(rawArtifactBytes), snapshot);
  validateObservationIdentity({ manifest, snapshot, rawArtifact, snapshotBytes, rawArtifactBytes });

  const rawObjectSha256 = sha256(rawArtifactBytes);
  const checksumSha256 = createHash("sha256").update(rawArtifactBytes).digest("base64");
  const dateToken = snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `${SOURCE_ID}/${dateToken}/${rawObjectSha256}.json`;
  const { head, trustedBucketOwner, idempotentExistingObject } = await publishImmutableKricRawObject({
    execFileImpl,
    errorPrefix: "KRIC accessibility raw object",
    bucket: BUCKET,
    objectKey,
    expectedBucketOwner,
    bodyPath: rawArtifactPath,
    checksumSha256,
    byteSize: rawArtifactBytes.length,
    rawObjectSha256,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
  });
  const governancePolicy = JSON.parse(await readFile(path.join(path.resolve(repositoryRoot), "tools/datapack/source-governance-policy.json"), "utf8"));
  const receipt = {
    schemaVersion: 1,
    artifactKind: "kric-accessibility-raw-object-receipt",
    sourceId: SOURCE_ID,
    snapshotId: snapshot.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    capturedAt: snapshot.capturedAt,
    snapshotFileSha256: manifest.snapshotFileSha256,
    rawObjectUri: `s3://${BUCKET}/${objectKey}`,
    rawObjectSha256,
    checksumSha256,
    byteSize: rawArtifactBytes.length,
    expectedBucketOwner: trustedBucketOwner,
    versionId: requiredText(head.VersionId, "S3 VersionId"),
    etag: requiredText(head.ETag, "S3 ETag"),
    storedAt: requiredUtcInstant(head.LastModified, "S3 LastModified"),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
      policy: governancePolicy,
      sourceId: SOURCE_ID,
      retrievedAt: snapshot.capturedAt,
    }),
    idempotentExistingObject,
  };
  await writeKricRawReceipt(resolvedReceipt, receipt, { mode: 0o600 });
  return receipt;
}

function validateManifest(value) {
  const keys = [
    "schemaVersion", "artifactKind", "sourceId", "capturedAt", "snapshotId", "snapshotRawSha256",
    "snapshotFile", "snapshotFileSha256", "rawArtifactFile", "rawObjectSha256",
    "rawObjectChecksumSha256", "rawObjectByteSize", "credentialRedacted",
  ];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.artifactKind !== "kric-standard-accessibility-observation"
    || value.sourceId !== SOURCE_ID
    || !Number.isFinite(Date.parse(value.capturedAt))
    || typeof value.snapshotId !== "string"
    || !SHA256.test(value.snapshotRawSha256 ?? "")
    || !SHA256.test(value.snapshotFileSha256 ?? "")
    || !SHA256.test(value.rawObjectSha256 ?? "")
    || typeof value.rawObjectChecksumSha256 !== "string" || value.rawObjectChecksumSha256 === ""
    || !Number.isSafeInteger(value.rawObjectByteSize) || value.rawObjectByteSize < 1
    || value.credentialRedacted !== true
    || value.snapshotFile !== `${value.snapshotId}.json`
    || value.rawArtifactFile !== `${value.snapshotId}.raw.json`) {
    throw new Error("KRIC accessibility observation manifest is invalid");
  }
}

function validateObservationIdentity({ manifest, snapshot, rawArtifact, snapshotBytes, rawArtifactBytes }) {
  if (manifest.sourceId !== snapshot.sourceId
    || manifest.capturedAt !== snapshot.capturedAt
    || manifest.snapshotId !== snapshot.snapshotId
    || manifest.snapshotRawSha256 !== snapshot.rawSha256
    || rawArtifact.snapshotId !== snapshot.snapshotId
    || sha256(snapshotBytes) !== manifest.snapshotFileSha256
    || sha256(rawArtifactBytes) !== manifest.rawObjectSha256
    || createHash("sha256").update(rawArtifactBytes).digest("base64") !== manifest.rawObjectChecksumSha256
    || rawArtifactBytes.length !== manifest.rawObjectByteSize) {
    throw new Error("KRIC accessibility observation identity mismatch");
  }
}

function containedFile(root, filename) {
  if (typeof filename !== "string" || filename === "" || path.basename(filename) !== filename) {
    throw new Error("KRIC accessibility observation path is invalid");
  }
  const resolved = path.resolve(root, filename);
  if (path.dirname(resolved) !== root) throw new Error("KRIC accessibility observation path is invalid");
  return resolved;
}

function exactKeys(value, expected) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key, index) => Object.keys(value)[index] === key);
}

function requiredAbsolutePath(value, label) {
  const text = requiredText(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be absolute`);
  return text;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value == null || value.startsWith("--") || name.slice(2) in args) {
      throw new Error("invalid arguments");
    }
    args[name.slice(2)] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await publishKricAccessibilityRawArtifact({
    observationRoot: args.observation,
    receiptPath: args.receipt,
    expectedBucketOwner: args["expected-bucket-owner"],
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "KRIC accessibility raw publication failed");
    process.exitCode = 1;
  });
}
