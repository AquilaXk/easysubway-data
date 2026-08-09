#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "../lib/is-main-module.mjs";

const execFileAsync = promisify(execFileCallback);
const BUCKET = "easysubway-datapack-sources";
const SOURCE_ID = "kric-subway-timetable";
const ARTIFACT_KIND = "kric-line4-timetable-collection";

export async function publishKricTimetableRawArtifact({ inputPath, receiptPath, execFileImpl = execFileAsync }) {
  const resolvedInput = path.resolve(requiredText(inputPath, "inputPath"));
  const resolvedReceipt = path.resolve(requiredText(receiptPath, "receiptPath"));
  const bytes = await readFile(resolvedInput);
  const artifact = JSON.parse(bytes.toString("utf8"));
  validateArtifact(artifact);

  const rawObjectSha256 = createHash("sha256").update(bytes).digest("hex");
  const checksumSha256 = createHash("sha256").update(bytes).digest("base64");
  const dateToken = artifact.capturedAt.replaceAll("-", "");
  const objectKey = `${SOURCE_ID}/${dateToken}/${rawObjectSha256}.json`;
  const expectedBucketOwner = await callerAccount(execFileImpl);
  const common = [
    "--bucket", BUCKET,
    "--key", objectKey,
    "--expected-bucket-owner", expectedBucketOwner,
    "--output", "json",
    "--no-cli-pager",
  ];

  let idempotentExistingObject = false;
  try {
    await execFileImpl("aws", [
      "s3api", "put-object",
      ...common,
      "--body", resolvedInput,
      "--content-type", "application/json",
      "--checksum-sha256", checksumSha256,
      "--metadata", `artifact-kind=${ARTIFACT_KIND},source-id=${SOURCE_ID},sha256=${rawObjectSha256}`,
      "--if-none-match", "*",
    ], { maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (!/PreconditionFailed|\b412\b/.test(String(error?.stderr ?? error?.message ?? ""))) {
      throw new Error(`KRIC raw object upload failed: ${safeAwsFailureCode(error)}`);
    }
    idempotentExistingObject = true;
  }

  const { stdout } = await execFileImpl("aws", [
    "s3api", "head-object",
    ...common,
    "--checksum-mode", "ENABLED",
  ], { maxBuffer: 1024 * 1024 });
  const head = JSON.parse(stdout);
  validateHead(head, { byteSize: bytes.length, checksumSha256, rawObjectSha256 });

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
    expectedBucketOwner,
    versionId: requiredText(head.VersionId, "S3 VersionId"),
    etag: requiredText(head.ETag, "S3 ETag"),
    storedAt: requiredUtcInstant(head.LastModified, "S3 LastModified"),
    idempotentExistingObject,
  };
  await writeReceipt(resolvedReceipt, receipt);
  return receipt;
}

function safeAwsFailureCode(error) {
  const text = String(error?.stderr ?? error?.message ?? "");
  return text.match(/\(([A-Za-z][A-Za-z0-9_-]*)\) when calling/)?.[1]
    ?? text.match(/\b([45]\d\d)\b/)?.[1]
    ?? "UNKNOWN";
}

async function callerAccount(execFileImpl) {
  const { stdout } = await execFileImpl("aws", [
    "sts", "get-caller-identity", "--query", "Account", "--output", "text", "--no-cli-pager",
  ], { maxBuffer: 1024 * 1024 });
  const account = stdout.trim();
  if (!/^\d{12}$/.test(account)) throw new Error("AWS caller account is invalid");
  return account;
}

function validateArtifact(artifact) {
  if (artifact?.artifactKind !== ARTIFACT_KIND
    || artifact.sourceId !== "kric-subway-route-info"
    || artifact.operation !== "subwayTimetableExp"
    || artifact.requestCount !== 153
    || artifact.failedRequestCount !== 0
    || typeof artifact.collectedAt !== "string"
    || Number.isNaN(Date.parse(artifact.collectedAt))
    || !/^\d{4}-\d{2}-\d{2}$/.test(artifact.capturedAt ?? "")
    || artifact.capturedAt !== artifact.collectedAt.slice(0, 10)) {
    throw new Error("KRIC raw artifact identity is invalid");
  }
}

function validateHead(head, expected) {
  if (head?.ContentLength !== expected.byteSize
    || head.ChecksumSHA256 !== expected.checksumSha256
    || head.Metadata?.sha256 !== expected.rawObjectSha256
    || head.Metadata?.["artifact-kind"] !== ARTIFACT_KIND
    || head.Metadata?.["source-id"] !== SOURCE_ID) {
    throw new Error("S3 object identity mismatch");
  }
}

async function writeReceipt(receiptPath, receipt) {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    await writeFile(receiptPath, body, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(receiptPath, "utf8");
    if (existing !== body) throw new Error("raw receipt already exists with different bytes");
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function requiredUtcInstant(value, label) {
  const text = requiredText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)
    || Number.isNaN(Date.parse(text))) throw new Error(`${label} must be a UTC instant`);
  return text;
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
  const receipt = await publishKricTimetableRawArtifact({ inputPath: args.input, receiptPath: args.receipt });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
