#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import { validateKricLine4PilotCollectionArtifact } from "./apply-kric-line4-pilot-schedule.mjs";
import {
  requireOciParBaseUrl,
  requiredText,
  writeKricRawReceipt,
} from "./lib/kric-raw-object-storage.mjs";
import { publishImmutableObjectPlan } from "./publish-object-storage.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const SOURCE_ID = "kric-subway-timetable";
const ARTIFACT_KIND = "kric-line4-timetable-collection";
const OCI_NAMESPACE = "axvym6vk8g7i";
const OCI_BUCKET = "easysubway-datapacks";
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function publishKricTimetableRawArtifact({
  inputPath,
  receiptPath,
  expectedRawObjectSha256,
  expectedByteSize,
  repositoryRoot = REPOSITORY_ROOT,
  env = process.env,
  client = null,
  now = new Date(),
} = {}) {
  const resolvedInput = path.resolve(requiredText(inputPath, "inputPath"));
  const resolvedReceipt = path.resolve(requiredText(receiptPath, "receiptPath"));
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("publication time must be a valid Date");
  requireOciParBaseUrl(client == null ? process.env : env);
  const bytes = await readFile(resolvedInput);
  const artifact = JSON.parse(bytes.toString("utf8"));
  const rawObjectSha256 = createHash("sha256").update(bytes).digest("hex");
  validateKricLine4PilotCollectionArtifact(artifact);
  requireEqual(rawObjectSha256, requiredSha256(expectedRawObjectSha256, "expectedRawObjectSha256"), "raw object SHA-256");
  requireEqual(bytes.length, requiredPositiveInteger(expectedByteSize, "expectedByteSize"), "raw object byte size");
  const dateToken = artifact.capturedAt.replaceAll("-", "");
  const objectKey = `source-raw/${SOURCE_ID}/${dateToken}/${rawObjectSha256}.json`;
  const storedAt = now.toISOString();
  if (Date.parse(storedAt) < Date.parse(artifact.collectedAt)) {
    throw new Error("publication time precedes collection");
  }
  const governancePolicy = JSON.parse(await readFile(
    path.join(path.resolve(repositoryRoot), "tools/datapack/source-governance-policy.json"),
    "utf8",
  ));
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({
    policy: governancePolicy,
    sourceId: SOURCE_ID,
    retrievedAt: artifact.collectedAt,
  });
  if (Date.parse(storedAt) >= Date.parse(rawRetentionExpiresAt)) {
    throw new Error("KRIC raw retention has expired");
  }
  try {
    await publishImmutableObjectPlan({
      root: path.dirname(resolvedInput),
      client,
      plan: {
        steps: [
          { type: "put-immutable-bundle-object", objectKey, sourcePath: path.basename(resolvedInput), sha256: rawObjectSha256, sizeBytes: bytes.length },
          { type: "verify-immutable-bundle-object", objectKey, sourcePath: path.basename(resolvedInput), sha256: rawObjectSha256, sizeBytes: bytes.length },
        ],
      },
    });
  } catch (error) {
    const status = /\bHTTP\s+([1-5]\d\d)\b/u.exec(String(error?.message ?? ""))?.[1];
    const statusSuffix = status == null ? "" : `: HTTP ${status}`;
    throw new Error(`KRIC raw object storage publication failed${statusSuffix}`);
  }

  const receipt = {
    schemaVersion: 1,
    artifactKind: "kric-timetable-raw-object-receipt",
    sourceId: SOURCE_ID,
    snapshotId: `kric-subway-timetable-line4-pilot-${dateToken}`,
    capturedAt: artifact.capturedAt,
    collectedAt: artifact.collectedAt,
    rawObjectUri: `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${objectKey}`,
    rawObjectSha256,
    ociNamespace: OCI_NAMESPACE,
    bucket: OCI_BUCKET,
    objectKey,
    capturedDate: dateToken,
    byteSize: bytes.length,
    storedAt,
    rawRetentionExpiresAt,
  };
  await writeKricRawReceipt(resolvedReceipt, receipt, { mode: 0o600 });
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
