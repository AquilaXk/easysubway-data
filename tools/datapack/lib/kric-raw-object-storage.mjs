import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";

const ACCESSIBILITY_BUCKET = "easysubway-datapack-sources";
const SHA256 = /^[0-9a-f]{64}$/u;

export async function publishAccessibilityRawObservation({
  observationRoot,
  receiptPath,
  expectedBucketOwner,
  repositoryRoot,
  execFileImpl,
  sourceId,
  observationArtifactKind,
  rawArtifactKind,
  receiptArtifactKind,
  errorPrefix,
  validateSnapshotIdentity,
  validateRawCollection,
}) {
  const root = path.resolve(requiredAbsolutePath(observationRoot, "observationRoot"));
  const resolvedReceipt = path.resolve(requiredAbsolutePath(receiptPath, "receiptPath"));
  const manifest = JSON.parse(await readFile(path.join(root, "observation.json"), "utf8"));
  validateAccessibilityObservationManifest(manifest, { sourceId, observationArtifactKind });
  const snapshotPath = containedObservationFile(root, manifest.snapshotFile);
  const rawArtifactPath = containedObservationFile(root, manifest.rawArtifactFile);
  const [snapshotBytes, rawArtifactBytes] = await Promise.all([
    readFile(snapshotPath),
    readFile(rawArtifactPath),
  ]);
  const snapshot = validateSnapshotIdentity(JSON.parse(snapshotBytes));
  const rawArtifact = validateRawCollection(JSON.parse(rawArtifactBytes), snapshot);
  validateAccessibilityObservationIdentity({ manifest, snapshot, rawArtifact, snapshotBytes, rawArtifactBytes });

  const rawObjectSha256 = sha256(rawArtifactBytes);
  const checksumSha256 = createHash("sha256").update(rawArtifactBytes).digest("base64");
  const dateToken = snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `${sourceId}/${dateToken}/${rawObjectSha256}.json`;
  const governancePolicy = JSON.parse(await readFile(
    path.join(path.resolve(repositoryRoot), "tools/datapack/source-governance-policy.json"),
    "utf8",
  ));
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({
    policy: governancePolicy,
    sourceId,
    retrievedAt: snapshot.capturedAt,
  });
  const { head, trustedBucketOwner, idempotentExistingObject } = await publishImmutableKricRawObject({
    execFileImpl,
    errorPrefix,
    bucket: ACCESSIBILITY_BUCKET,
    objectKey,
    expectedBucketOwner,
    bodyPath: rawArtifactPath,
    checksumSha256,
    byteSize: rawArtifactBytes.length,
    rawObjectSha256,
    artifactKind: rawArtifactKind,
    sourceId,
  });
  const receipt = {
    schemaVersion: 1,
    artifactKind: receiptArtifactKind,
    sourceId,
    snapshotId: snapshot.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    capturedAt: snapshot.capturedAt,
    snapshotFileSha256: manifest.snapshotFileSha256,
    rawObjectUri: `s3://${ACCESSIBILITY_BUCKET}/${objectKey}`,
    rawObjectSha256,
    checksumSha256,
    byteSize: rawArtifactBytes.length,
    expectedBucketOwner: trustedBucketOwner,
    versionId: head.VersionId == null ? null : requiredText(head.VersionId, "S3 VersionId"),
    etag: requiredText(head.ETag, "S3 ETag"),
    storedAt: requiredUtcInstant(head.LastModified, "S3 LastModified"),
    rawRetentionExpiresAt,
    idempotentExistingObject,
  };
  await writeKricRawReceipt(resolvedReceipt, receipt, { mode: 0o600 });
  return receipt;
}

function validateAccessibilityObservationManifest(value, { sourceId, observationArtifactKind }) {
  const keys = [
    "schemaVersion", "artifactKind", "sourceId", "capturedAt", "snapshotId", "snapshotRawSha256",
    "snapshotFile", "snapshotFileSha256", "rawArtifactFile", "rawObjectSha256",
    "rawObjectChecksumSha256", "rawObjectByteSize", "credentialRedacted",
  ];
  if (!exactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.artifactKind !== observationArtifactKind
    || value.sourceId !== sourceId
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
    throw new Error(`${sourceId} accessibility observation manifest is invalid`);
  }
}

function validateAccessibilityObservationIdentity({ manifest, snapshot, rawArtifact, snapshotBytes, rawArtifactBytes }) {
  if (manifest.sourceId !== snapshot.sourceId
    || manifest.capturedAt !== snapshot.capturedAt
    || manifest.snapshotId !== snapshot.snapshotId
    || manifest.snapshotRawSha256 !== snapshot.rawSha256
    || rawArtifact.snapshotId !== snapshot.snapshotId
    || sha256(snapshotBytes) !== manifest.snapshotFileSha256
    || sha256(rawArtifactBytes) !== manifest.rawObjectSha256
    || createHash("sha256").update(rawArtifactBytes).digest("base64") !== manifest.rawObjectChecksumSha256
    || rawArtifactBytes.length !== manifest.rawObjectByteSize) {
    throw new Error(`${manifest.sourceId} accessibility observation identity mismatch`);
  }
}

function containedObservationFile(root, filename) {
  if (typeof filename !== "string" || filename === "" || path.basename(filename) !== filename) {
    throw new Error("accessibility observation path is invalid");
  }
  const resolved = path.resolve(root, filename);
  if (path.dirname(resolved) !== root) throw new Error("accessibility observation path is invalid");
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

export async function publishImmutableKricRawObject({
  execFileImpl,
  errorPrefix,
  bucket,
  objectKey,
  expectedBucketOwner,
  bodyPath,
  checksumSha256,
  byteSize,
  rawObjectSha256,
  artifactKind,
  sourceId,
}) {
  const trustedBucketOwner = requiredAccount(expectedBucketOwner, "expectedBucketOwner");
  const { stdout: callerStdout } = await runAws(execFileImpl, errorPrefix, "caller identity", [
    "sts", "get-caller-identity", "--query", "Account", "--output", "text", "--no-cli-pager",
  ]);
  const caller = callerStdout.trim();
  if (!/^\d{12}$/u.test(caller)) throw new Error("AWS caller account is invalid");
  if (caller !== trustedBucketOwner) throw new Error("AWS caller account does not match expected bucket owner");

  const common = [
    "--bucket", bucket,
    "--key", objectKey,
    "--expected-bucket-owner", trustedBucketOwner,
    "--output", "json",
    "--no-cli-pager",
  ];
  let idempotentExistingObject = false;
  try {
    await runAws(execFileImpl, errorPrefix, "upload", [
      "s3api", "put-object",
      ...common,
      "--body", bodyPath,
      "--content-type", "application/json",
      "--checksum-sha256", checksumSha256,
      "--metadata", `artifact-kind=${artifactKind},source-id=${sourceId},sha256=${rawObjectSha256}`,
      "--if-none-match", "*",
    ]);
  } catch (error) {
    if (error?.awsFailureCode !== "PreconditionFailed" && error?.awsFailureCode !== "412") throw error;
    idempotentExistingObject = true;
  }

  const { stdout } = await runAws(execFileImpl, errorPrefix, "head verification", [
    "s3api", "head-object",
    ...common,
    "--checksum-mode", "ENABLED",
  ]);
  const head = JSON.parse(stdout);
  if (head?.ContentLength !== byteSize
    || head.ChecksumSHA256 !== checksumSha256
    || head.Metadata?.sha256 !== rawObjectSha256
    || head.Metadata?.["artifact-kind"] !== artifactKind
    || head.Metadata?.["source-id"] !== sourceId) {
    throw new Error("S3 object identity mismatch");
  }
  return { head, trustedBucketOwner, idempotentExistingObject };
}

export async function writeKricRawReceipt(receiptPath, receipt, { mode } = {}) {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const options = mode == null ? { flag: "wx" } : { flag: "wx", mode };
  try {
    await writeFile(receiptPath, body, options);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (await readFile(receiptPath, "utf8") !== body) {
      throw new Error("raw receipt already exists with different bytes");
    }
  }
}

export function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

export function requiredAccount(value, label) {
  const text = requiredText(value, label);
  if (!/^\d{12}$/u.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

export function requiredUtcInstant(value, label) {
  const text = requiredText(value, label);
  const timestamp = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/u.test(text)
    || Number.isNaN(timestamp)) throw new Error(`${label} must be a UTC instant`);
  return new Date(timestamp).toISOString();
}

function safeAwsFailureCode(error) {
  const text = String(error?.stderr ?? error?.message ?? "");
  return text.match(/\(([A-Za-z][A-Za-z0-9_-]*)\) when calling/u)?.[1]
    ?? text.match(/\b([45]\d\d)\b/u)?.[1]
    ?? "UNKNOWN";
}

async function runAws(execFileImpl, errorPrefix, context, args) {
  try {
    return await execFileImpl("aws", args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    const failureCode = safeAwsFailureCode(error);
    const sanitized = new Error(`${errorPrefix} ${context} failed: ${failureCode}`);
    sanitized.awsFailureCode = failureCode;
    throw sanitized;
  }
}
