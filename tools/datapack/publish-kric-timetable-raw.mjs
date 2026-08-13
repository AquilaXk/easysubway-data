#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "../lib/is-main-module.mjs";
import { validateKricLine4PilotCollectionArtifact } from "./apply-kric-line4-pilot-schedule.mjs";
import {
  publishImmutableKricRawObject,
  requiredAccount,
  requiredText,
  requiredUtcInstant,
  writeKricRawReceipt,
} from "./lib/kric-raw-object-storage.mjs";

const execFileAsync = promisify(execFileCallback);
const BUCKET = "easysubway-datapack-sources";
const SOURCE_ID = "kric-subway-timetable";
const ARTIFACT_KIND = "kric-line4-timetable-collection";

export async function publishKricTimetableRawArtifact({
  inputPath,
  receiptPath,
  expectedBucketOwner,
  expectedRawObjectSha256,
  expectedByteSize,
  execFileImpl = execFileAsync,
}) {
  const resolvedInput = path.resolve(requiredText(inputPath, "inputPath"));
  const resolvedReceipt = path.resolve(requiredText(receiptPath, "receiptPath"));
  const bytes = await readFile(resolvedInput);
  const artifact = JSON.parse(bytes.toString("utf8"));
  const rawObjectSha256 = createHash("sha256").update(bytes).digest("hex");
  validateKricLine4PilotCollectionArtifact(artifact);
  requireEqual(rawObjectSha256, requiredSha256(expectedRawObjectSha256, "expectedRawObjectSha256"), "raw object SHA-256");
  requireEqual(bytes.length, requiredPositiveInteger(expectedByteSize, "expectedByteSize"), "raw object byte size");
  const checksumSha256 = createHash("sha256").update(bytes).digest("base64");
  const dateToken = artifact.capturedAt.replaceAll("-", "");
  const objectKey = `${SOURCE_ID}/${dateToken}/${rawObjectSha256}.json`;
  const { head, trustedBucketOwner, idempotentExistingObject } = await publishImmutableKricRawObject({
    execFileImpl,
    errorPrefix: "KRIC raw object",
    bucket: BUCKET,
    objectKey,
    expectedBucketOwner,
    bodyPath: resolvedInput,
    checksumSha256,
    byteSize: bytes.length,
    rawObjectSha256,
    artifactKind: ARTIFACT_KIND,
    sourceId: SOURCE_ID,
  });

  const receipt = {
    schemaVersion: 1,
    artifactKind: "kric-timetable-raw-object-receipt",
    sourceId: SOURCE_ID,
    snapshotId: `kric-subway-timetable-line4-pilot-${dateToken}`,
    capturedAt: artifact.capturedAt,
    collectedAt: artifact.collectedAt,
    rawObjectUri: `s3://${BUCKET}/${objectKey}`,
    rawObjectSha256,
    checksumSha256,
    byteSize: bytes.length,
    expectedBucketOwner: trustedBucketOwner,
    versionId: requiredText(head.VersionId, "S3 VersionId"),
    etag: requiredText(head.ETag, "S3 ETag"),
    storedAt: requiredUtcInstant(head.LastModified, "S3 LastModified"),
    idempotentExistingObject,
  };
  await writeKricRawReceipt(resolvedReceipt, receipt);
  return receipt;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function requiredPositiveInteger(value, label) {
  const integer = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(integer) || integer < 1) throw new Error(`${label} is invalid`);
  return integer;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`KRIC ${label} mismatch`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await publishKricTimetableRawArtifact({
    inputPath: args.input,
    receiptPath: args.receipt,
    expectedBucketOwner: args["expected-bucket-owner"],
    expectedRawObjectSha256: args["expected-sha256"],
    expectedByteSize: args["expected-byte-size"],
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
