import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { publishKricTimetableRawArtifact } from "./publish-kric-timetable-raw.mjs";

const OCI_ENV = Object.freeze({
  EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o",
});
const STORED_AT = new Date("2026-08-09T12:05:00.000Z");

function artifact() {
  const responses = Array.from({ length: 153 }, (_, index) => {
    const bytes = Buffer.from(`response-${index}`);
    return {
      requestKey: `subwayTimetableExp|fixture-${index}`,
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      bodyBase64: bytes.toString("base64"),
    };
  });
  return {
    artifactKind: "kric-line4-timetable-collection",
    sourceId: "kric-subway-route-info",
    operation: "subwayTimetableExp",
    collectedAt: "2026-08-09T12:04:20.479Z",
    capturedAt: "2026-08-09",
    requestCount: 153,
    failedRequestCount: 0,
    expectedNoDataRequestCount: 51,
    lineId: "seoul-4",
    intermediateRowCount: 33062,
    excludedOutsidePilotGroupCount: 429,
    excludedOutsidePilotGroups: Array.from({ length: 429 }, (_, index) => ({ index })),
    excludedNonStopRowCount: 42,
    excludedNonStopRows: Array.from({ length: 42 }, (_, index) => ({ index })),
    reconstructionRowCount: 22004,
    transitTripCount: 466,
    transitTrips: Array.from({ length: 466 }, (_, index) => ({ id: `trip-${index}` })),
    transitStopTimeCount: 22004,
    transitStopTimes: Array.from({ length: 22004 }, (_, index) => ({ stopSequence: index + 1 })),
    rawResponseInventory: {
      responseCount: responses.length,
      inventorySha256: createHash("sha256").update(JSON.stringify(responses)).digest("hex"),
      responses,
    },
  };
}

async function fixture(t, value = artifact()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-raw-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, "collection.json");
  const receiptPath = path.join(root, "receipt.json");
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(inputPath, bytes);
  return {
    root,
    inputPath,
    receiptPath,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function fakeClient(values, { existing = false, tamper = false, failAt = null } = {}) {
  const calls = [];
  let stored = existing ? (tamper ? Buffer.from("tampered") : values.bytes) : null;
  return {
    calls,
    client: {
      async putObjectIfAbsent(key, bytes) {
        calls.push(["put", key]);
        if (failAt === "put") throw new Error("HTTP 403 SHOULD-NOT-LEAK");
        if (stored != null) return false;
        stored = Buffer.from(bytes);
        return true;
      },
      async readObject(key) {
        calls.push(["get", key]);
        if (failAt === "get") throw new Error("HTTP 503 SHOULD-NOT-LEAK");
        return { exists: stored != null, body: stored ?? Buffer.alloc(0) };
      },
    },
  };
}

function publishOptions(values, overrides = {}) {
  return {
    inputPath: values.inputPath,
    receiptPath: values.receiptPath,
    expectedRawObjectSha256: values.sha256,
    expectedByteSize: values.bytes.length,
    env: OCI_ENV,
    now: STORED_AT,
    ...overrides,
  };
}

test("KRIC raw publisher는 content-addressed OCI object와 retention receipt를 결속한다", async (t) => {
  const values = await fixture(t);
  const storage = fakeClient(values);
  const receipt = await publishKricTimetableRawArtifact(publishOptions(values, { client: storage.client }));
  const key = `source-raw/kric-subway-timetable/20260809/${values.sha256}.json`;
  assert.equal(receipt.rawObjectUri, `oci://axvym6vk8g7i/easysubway-datapacks/${key}`);
  assert.equal(receipt.rawObjectSha256, values.sha256);
  assert.equal(receipt.objectKey, key);
  assert.equal(receipt.ociNamespace, "axvym6vk8g7i");
  assert.equal(receipt.bucket, "easysubway-datapacks");
  assert.equal(receipt.byteSize, values.bytes.length);
  assert.equal(receipt.storedAt, STORED_AT.toISOString());
  assert.ok(Date.parse(receipt.rawRetentionExpiresAt) > STORED_AT.valueOf());
  assert.deepEqual(JSON.parse(await readFile(values.receiptPath, "utf8")), receipt);
  assert.deepEqual(storage.calls, [["put", key], ["get", key]]);
});

test("KRIC raw publisher는 existing exact OCI object만 idempotent하게 허용한다", async (t) => {
  const values = await fixture(t);
  const exact = fakeClient(values, { existing: true });
  await publishKricTimetableRawArtifact(publishOptions(values, { client: exact.client }));
  assert.deepEqual(exact.calls.map(([operation]) => operation), ["put", "get", "get"]);

  const tamperedValues = await fixture(t);
  const tampered = fakeClient(tamperedValues, { existing: true, tamper: true });
  await assert.rejects(
    publishKricTimetableRawArtifact(publishOptions(tamperedValues, { client: tampered.client })),
    /storage publication failed/,
  );
});

test("KRIC raw publisher는 OCI PAR 부재와 storage failure를 credential-safe하게 보고한다", async (t) => {
  const values = await fixture(t);
  const storage = fakeClient(values);
  await assert.rejects(
    publishKricTimetableRawArtifact(publishOptions(values, { env: {}, client: storage.client })),
    /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/,
  );
  assert.equal(storage.calls.length, 0);

  for (const failAt of ["put", "get"]) {
    const failedValues = await fixture(t);
    const failed = fakeClient(failedValues, { failAt });
    await assert.rejects(
      publishKricTimetableRawArtifact(publishOptions(failedValues, { client: failed.client })),
      (error) => /HTTP (403|503)/u.test(error.message) && !error.message.includes("SHOULD-NOT-LEAK"),
    );
  }
});

test("KRIC raw publisher는 full collection contract를 게시 전에 검증한다", async (t) => {
  const base = artifact();
  for (const mutate of [
    (value) => { value.lineId = "other"; },
    (value) => { value.intermediateRowCount = 1; },
    (value) => { value.excludedOutsidePilotGroups = []; },
    (value) => { value.excludedNonStopRows = []; },
    (value) => { value.transitTrips = []; },
    (value) => { value.transitStopTimes = []; },
    (value) => { value.rawResponseInventory.responses[0].bodyBase64 = "dGFtcGVyZWQ="; },
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    const values = await fixture(t, changed);
    const storage = fakeClient(values);
    await assert.rejects(
      publishKricTimetableRawArtifact(publishOptions(values, { client: storage.client })),
      /KRIC pilot artifact/,
    );
    assert.equal(storage.calls.length, 0);
  }
});

test("KRIC raw publisher는 expected identity와 publication clock drift를 거부한다", async (t) => {
  const values = await fixture(t);
  const storage = fakeClient(values);
  await assert.rejects(
    publishKricTimetableRawArtifact(publishOptions(values, {
      client: storage.client,
      expectedRawObjectSha256: "0".repeat(64),
    })),
    /raw object SHA-256 mismatch/,
  );
  await assert.rejects(
    publishKricTimetableRawArtifact(publishOptions(values, {
      client: storage.client,
      now: new Date("2026-08-09T12:00:00.000Z"),
    })),
    /publication time precedes collection/,
  );
  assert.equal(storage.calls.length, 0);
});
