import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { validateKorailTimetableFileReceipt } from "./collect-korail-metropolitan-timetable-file.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { requireOciParBaseUrl } from "./lib/kric-raw-object-storage.mjs";
import { preauthenticatedObjectStorageClient } from "./publish-object-storage.mjs";

const SOURCE_ID = "korail-metropolitan-timetable-file";
const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PAR_PATH = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function publishKorailTimetableRaw({ preparation, collectionDirectory, operationDirectory,
  env = process.env, client = null, clock = () => new Date() } = {}) {
  const collection = absoluteDirectory(collectionDirectory, "COLLECTION");
  const operation = absoluteDirectory(operationDirectory, "OPERATION");
  const prepared = validatePreparation(preparation);
  try { await mkdir(operation); } catch { fail("OPERATION"); }
  const receiptBytes = await safeRead(path.join(collection, "receipt.json"), "COLLECTION");
  const rawBytes = await safeRead(path.join(collection, "timetable.xlsx"), "COLLECTION");
  const receipt = parseReceipt(receiptBytes);
  const source = prepared.snapshot.observation?.sources?.timetable;
  validateKorailReceipt(receipt, source, receiptBytes, prepared.snapshot);
  const rawSha256 = sha256(rawBytes);
  if (rawSha256 !== source.rawSha256 || rawBytes.length !== source.rawByteLength) fail("RAW");
  const beforeStore = instant(clock(), "CLOCK");
  assertCurrent(prepared, beforeStore);
  let parBaseUrl;
  try { requireOciParBaseUrl(env); parBaseUrl = new URL(env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL.trim()); } catch { fail("OCI_ENV"); }
  const [, namespace, bucket] = PAR_PATH.exec(parBaseUrl.pathname) ?? [];
  if (!namespace || !bucket) fail("OCI_ENV");
  const key = `source-raw/${SOURCE_ID}/${prepared.snapshot.capturedAt.slice(0, 10).replaceAll("-", "")}/${rawSha256}.xlsx`;
  const step = { sha256: rawSha256, sizeBytes: rawBytes.length, contentType: CONTENT_TYPE };
  const storage = client ?? preauthenticatedObjectStorageClient(parBaseUrl, { includeErrorBody: false });
  if (!storage || typeof storage.putObjectIfAbsent !== "function" || typeof storage.verifyObject !== "function") fail("OCI_ENV");
  let created;
  try { created = await storage.putObjectIfAbsent(key, rawBytes, step); } catch { fail("PUT"); }
  if (created !== true) fail("EXISTS");
  try { await storage.verifyObject(key, step); } catch { fail("VERIFY"); }
  const storedAt = instant(clock(), "CLOCK");
  assertCurrent(prepared, storedAt);
  const result = {
    schemaVersion: 1,
    artifactKind: "korail-metropolitan-timetable-raw-receipt",
    sourceId: SOURCE_ID,
    snapshotId: prepared.snapshot.snapshotId,
    contentSha256: prepared.snapshot.contentSha256,
    collectionReceiptSha256: source.collectionReceiptSha256,
    capturedAt: prepared.snapshot.capturedAt,
    rawObjectUri: `oci://${namespace}/${bucket}/${key}`,
    rawObjectSha256: rawSha256,
    byteSize: rawBytes.length,
    storedAt,
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
  };
  try { await writeFile(path.join(operation, "receipt.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 }); } catch { fail("RECEIPT"); }
  return result;
}

function validatePreparation(value) {
  const snapshot = value?.snapshot;
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "korail-metropolitan-topology-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.status !== "PENDING" || snapshot.releaseEligible !== false
    || !shaText(snapshot.contentSha256) || typeof snapshot.snapshotId !== "string" || snapshot.snapshotId !== `${SOURCE_ID}-${snapshot.contentSha256}`
    || !instantText(snapshot.capturedAt) || !instantText(snapshot.freshUntil) || Date.parse(snapshot.capturedAt) >= Date.parse(snapshot.freshUntil)
    || !instantText(value?.rawRetentionExpiresAt)) fail("PREPARATION");
  const content = structuredClone(snapshot);
  delete content.contentSha256; delete content.snapshotId;
  if (sha256(canonicalJson(content)) !== snapshot.contentSha256) fail("PREPARATION");
  return { snapshot: structuredClone(snapshot), rawRetentionExpiresAt: value.rawRetentionExpiresAt };
}

function validateKorailReceipt(receipt, source, receiptBytes, snapshot) {
  try { validateKorailTimetableFileReceipt(receipt, source); } catch { fail("RECEIPT"); }
  if (source?.collectionReceiptSha256 !== sha256(receiptBytes) || receipt.capturedAt !== snapshot.capturedAt
    || snapshot.rawSha256 !== receipt.sha256 || !isDeepStrictEqual(source.collectionReceipt, receipt)) fail("RECEIPT");
}

function parseReceipt(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail("RECEIPT"); }
}

async function safeRead(file, code) {
  try { return await readFile(file); } catch { fail(code); }
}

function assertCurrent(preparation, at) {
  if (Date.parse(preparation.snapshot.capturedAt) > Date.parse(at) || Date.parse(at) >= Date.parse(preparation.snapshot.freshUntil)
    || Date.parse(at) >= Date.parse(preparation.rawRetentionExpiresAt)) fail("FRESHNESS");
}

function absoluteDirectory(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(code);
  return value;
}

function instant(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) fail(code);
  return value.toISOString();
}

function instantText(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function shaText(value) { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function fail(code) { throw new Error(`KORAIL_RAW_${code}`); }
