import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { publishKorailTimetableRaw } from "./publish-korail-metropolitan-timetable-raw.mjs";
import { preauthenticatedObjectStorageClient } from "./publish-object-storage.mjs";

const ENV = { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" };
const NOW = new Date("2040-01-02T01:00:00.000Z");

test("publishes one exact raw object, verifies it once, and writes a bound raw-only receipt", async (t) => {
  const value = await fixture(t), calls = [], objects = new Map();
  const client = clientFor(calls, objects);
  const receipt = await publishKorailTimetableRaw({ ...value, env: ENV, client, clock: () => NOW });
  assert.deepEqual(calls.map(({ type }) => type), ["put", "get"]);
  assert.equal(receipt.rawObjectUri, `oci://axvym6vk8g7i/easysubway-datapacks/${calls[0].key}`);
  assert.equal(receipt.rawObjectSha256, value.sha256);
  assert.equal(receipt.byteSize, value.raw.length);
  assert.equal(receipt.storedAt, NOW.toISOString());
  assert.equal(receipt.snapshotId, value.preparation.snapshot.snapshotId);
  assert.equal(receipt.contentSha256, value.preparation.snapshot.contentSha256);
  assert.equal(receipt.collectionReceiptSha256, value.preparation.snapshot.observation.sources.timetable.collectionReceiptSha256);
  assert.equal(receipt.capturedAt, value.preparation.snapshot.capturedAt);
  assert.equal(receipt.rawRetentionExpiresAt, value.preparation.rawRetentionExpiresAt);
  assert.deepEqual(calls[0].bytes, value.raw);
  assert.deepEqual(JSON.parse(await readFile(path.join(value.operationDirectory, "receipt.json"), "utf8")), receipt);
});

test("rejects collection/raw bindings before OCI effects", async (t) => {
  const value = await fixture(t), calls = [];
  await writeFile(path.join(value.collectionDirectory, "timetable.xlsx"), Buffer.from("PK\x03\x04different"));
  await assert.rejects(publishKorailTimetableRaw({ ...value, env: ENV, client: clientFor(calls), clock: () => NOW }), /KORAIL_RAW_/);
  assert.deepEqual(calls, []);
});

test("treats an existing object as a closed publication failure without a GET or receipt", async (t) => {
  const value = await fixture(t), calls = [];
  const client = { async putObjectIfAbsent(key) { calls.push({ type: "put", key }); return false; }, async verifyObject() { calls.push({ type: "get" }); } };
  await assert.rejects(publishKorailTimetableRaw({ ...value, env: ENV, client, clock: () => NOW }), /KORAIL_RAW_EXISTS/);
  assert.deepEqual(calls.map(({ type }) => type), ["put"]);
  await assert.rejects(readFile(path.join(value.operationDirectory, "receipt.json")));
});

test("fails closed on readback drift and creates no receipt", async (t) => {
  const value = await fixture(t), calls = [];
  const client = clientFor(calls, new Map(), true);
  await assert.rejects(publishKorailTimetableRaw({ ...value, env: ENV, client, clock: () => NOW }), /KORAIL_RAW_VERIFY/);
  await assert.rejects(readFile(path.join(value.operationDirectory, "receipt.json")));
  assert.deepEqual(calls.map(({ type }) => type), ["put", "get"]);
});

test("rejects a snapshot raw digest inconsistent with its collection before OCI", async (t) => {
  const value = await fixture(t), calls = [];
  const snapshot = value.preparation.snapshot;
  delete snapshot.contentSha256; delete snapshot.snapshotId;
  snapshot.rawSha256 = hash("unrelated raw");
  snapshot.contentSha256 = hash(canonicalJson(snapshot));
  snapshot.snapshotId = `${snapshot.sourceId}-${snapshot.contentSha256}`;
  await assert.rejects(publishKorailTimetableRaw({ ...value, env: ENV, client: clientFor(calls), clock: () => NOW }), /KORAIL_RAW_RECEIPT/);
  assert.deepEqual(calls, []);
});

test("rejects a duplicate operation directory before OCI effects", async (t) => {
  const value = await fixture(t), calls = [];
  await mkdir(value.operationDirectory);
  await assert.rejects(publishKorailTimetableRaw({ ...value, env: ENV, client: clientFor(calls), clock: () => NOW }), /KORAIL_RAW_OPERATION/);
  assert.deepEqual(calls, []);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "korail-raw-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const collectionDirectory = path.join(root, "collection"), operationDirectory = path.join(root, "operation");
  await mkdir(collectionDirectory);
  const raw = Buffer.from("PK\x03\x04synthetic-xlsx"), sha256 = hash(raw);
  const capturedAt = new Date(NOW.valueOf() - 3600000).toISOString();
  const source = { rawSha256: sha256, rawByteLength: raw.length };
  const collectionReceipt = { schemaVersion: 1, artifactKind: "korail-metropolitan-timetable-file-receipt", sourceId: "korail-metropolitan-timetable-file", capturedAt, rawFile: "timetable.xlsx", byteLength: raw.length, sha256, officialUrl: "https://www.korail.com/file/cubedata/COMMON/jfile/test.xlsx", credentialRedacted: true };
  const receiptBytes = Buffer.from(JSON.stringify(collectionReceipt));
  await writeFile(path.join(collectionDirectory, "timetable.xlsx"), raw);
  await writeFile(path.join(collectionDirectory, "receipt.json"), receiptBytes);
  const snapshot = { schemaVersion: 1, artifactKind: "korail-metropolitan-topology-snapshot", status: "PENDING", releaseEligible: false, sourceId: collectionReceipt.sourceId, capturedAt, freshUntil: new Date(NOW.valueOf() + 86400000).toISOString(), rawSha256: sha256, observation: { sources: { timetable: { ...source, collectionReceipt, collectionReceiptSha256: hash(receiptBytes) } } } };
  snapshot.contentSha256 = hash(canonicalJson(snapshot)); snapshot.snapshotId = `${snapshot.sourceId}-${snapshot.contentSha256}`;
  return { preparation: { snapshot, rawRetentionExpiresAt: new Date(NOW.valueOf() + 90 * 86400000).toISOString() }, collectionDirectory, operationDirectory, raw, sha256 };
}

function clientFor(calls, objects = new Map(), corruptRead = false) {
  return preauthenticatedObjectStorageClient(ENV.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL, {
    includeErrorBody: false,
    requestImpl: async ({ method, url, body, headers, maxResponseBytes }) => {
      const key = url.pathname.split("/o/")[1];
      calls.push({ type: method.toLowerCase(), key, bytes: body });
      if (method === "PUT") {
        assert.equal(headers["if-none-match"], "*");
        objects.set(key, Buffer.from(body));
        return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
      }
      assert.equal(method, "GET");
      const stored = Buffer.from(objects.get(key));
      assert.equal(maxResponseBytes, stored.length);
      if (corruptRead) stored[0] ^= 1;
      return { statusCode: 200, headers: { "cache-control": "public, max-age=31536000, immutable" }, body: stored };
    },
  });
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
