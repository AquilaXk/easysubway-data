import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  requireOciParBaseUrl,
  requiredText,
  writeKricRawReceipt,
} from "./lib/kric-raw-object-storage.mjs";
import { prepareRetainedKricTimetablePublication } from "./prepare-retained-kric-timetable-publication.mjs";
import { publishImmutableObjectPlan } from "./publish-object-storage.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";

export async function publishRetainedKricTimetable({
  inputPath,
  receiptPath,
  receipt,
  routeNumber,
  candidate,
  governancePolicy,
  providerValidUntil,
  env = process.env,
  client = null,
  now = new Date(),
} = {}) {
  const resolvedInput = requiredAbsolutePath(inputPath, "inputPath");
  const resolvedReceipt = requiredAbsolutePath(receiptPath, "receiptPath");
  await requireAbsentReceipt(resolvedReceipt);
  const storedAt = canonicalUtcInstant(now, "publication time");
  requireOciParBaseUrl(env);

  const observationBytes = await readFile(resolvedInput);
  const preparation = prepareRetainedKricTimetablePublication({
    candidate,
    observationBytes,
    receipt,
    routeNumber,
    sourcePath: path.basename(resolvedInput),
    evaluationAt: storedAt,
    providerValidUntil,
  });
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({
    policy: governancePolicy,
    sourceId: SOURCE_ID,
    retrievedAt: preparation.source.observedAt,
  });
  if (Date.parse(storedAt) >= Date.parse(rawRetentionExpiresAt)) {
    throw new Error("KRIC retained timetable raw retention has expired");
  }

  try {
    await publishImmutableObjectPlan({
      root: path.dirname(resolvedInput),
      client,
      env,
      plan: preparation.plan,
    });
  } catch (error) {
    throw sanitizedPublicationError(error);
  }

  const { namespace, bucket } = ociLocation(env);
  const rawObjectSha256 = sha256(observationBytes);
  const objectKey = preparation.plan.steps[0].objectKey;
  const publishedReceipt = {
    schemaVersion: 1,
    artifactKind: "kric-retained-timetable-object-receipt",
    sourceId: SOURCE_ID,
    snapshotId: `${SOURCE_ID}-${preparation.source.observationIdentitySha256}`,
    observedAt: preparation.source.observedAt,
    acquisitionRawSha256: preparation.source.rawSha256,
    rawObjectSha256,
    collectionReceiptSha256: preparation.source.receiptSha256,
    observationIdentitySha256: preparation.source.observationIdentitySha256,
    recordsSha256: preparation.source.recordsSha256,
    rawObjectUri: `oci://${namespace}/${bucket}/${objectKey}`,
    byteSize: observationBytes.length,
    storedAt,
    freshnessExpiresAt: preparation.freshnessExpiresAt,
    rawRetentionExpiresAt,
  };
  await writeKricRawReceipt(resolvedReceipt, publishedReceipt, { mode: 0o600 });
  return publishedReceipt;
}

// 등록 시 업로드 receipt만 신뢰하지 않고 원문·취득 receipt·정책으로 다시 결속한다.
export function validateRetainedKricTimetableReceipt({
  receiptBytes, observationBytes, receipt, candidate, routeNumber,
  governancePolicy, env = process.env, evaluationAt, providerValidUntil,
}) {
  if (!Buffer.isBuffer(receiptBytes)) throw new Error("RETAINED_TIMETABLE_RECEIPT_BYTES_INVALID");
  const value = JSON.parse(receiptBytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !receiptBytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) {
    throw new Error("RETAINED_TIMETABLE_RECEIPT_BYTES_INVALID");
  }
  const prepared = prepareRetainedKricTimetablePublication({
    candidate, observationBytes, receipt, routeNumber,
    sourcePath: "observation.json", evaluationAt, providerValidUntil,
  });
  const storedAt = requiredUtcInstant(value.storedAt, "receipt.storedAt");
  if (storedAt < requiredUtcInstant(prepared.source.observedAt, "observedAt")
    || storedAt > requiredUtcInstant(evaluationAt, "evaluationAt")) {
    throw new Error("RETAINED_TIMETABLE_RECEIPT_TIME_INVALID");
  }
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({
    policy: governancePolicy, sourceId: SOURCE_ID, retrievedAt: prepared.source.observedAt,
  });
  if (Date.parse(evaluationAt) >= Date.parse(rawRetentionExpiresAt)) {
    throw new Error("RETAINED_TIMETABLE_RECEIPT_RETENTION_EXPIRED");
  }
  const { namespace, bucket } = ociLocation(env);
  const expected = {
    schemaVersion: 1, artifactKind: "kric-retained-timetable-object-receipt",
    sourceId: SOURCE_ID, snapshotId: `${SOURCE_ID}-${prepared.source.observationIdentitySha256}`,
    observedAt: prepared.source.observedAt, acquisitionRawSha256: prepared.source.rawSha256,
    rawObjectSha256: prepared.observationSha256, collectionReceiptSha256: prepared.source.receiptSha256,
    observationIdentitySha256: prepared.source.observationIdentitySha256,
    recordsSha256: prepared.source.recordsSha256,
    rawObjectUri: `oci://${namespace}/${bucket}/${prepared.plan.steps[0].objectKey}`,
    byteSize: observationBytes.length, storedAt: value.storedAt,
    freshnessExpiresAt: prepared.freshnessExpiresAt, rawRetentionExpiresAt,
  };
  if (Object.keys(value).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) {
    throw new Error("RETAINED_TIMETABLE_RECEIPT_BINDING_INVALID");
  }
  return value;
}

function requiredAbsolutePath(value, label) {
  const text = requiredText(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be absolute`);
  return path.resolve(text);
}

async function requireAbsentReceipt(receiptPath) {
  try {
    await access(receiptPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("retained timetable receipt already exists");
}

function canonicalUtcInstant(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value.toISOString();
}

function ociLocation(env) {
  requireOciParBaseUrl(env);
  const url = new URL(env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL.trim());
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(url.pathname);
  if (match == null) throw new Error("OCI preauthenticated object URL is invalid");
  return { namespace: match[1], bucket: match[2] };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizedPublicationError(error) {
  const status = /\bHTTP\s+([1-5]\d\d)\b/u.exec(String(error?.message ?? ""))?.[1];
  return new Error(`KRIC retained timetable storage publication failed${status == null ? "" : `: HTTP ${status}`}`);
}
