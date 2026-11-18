import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareRetainedKricTimetablePublication } from "./prepare-retained-kric-timetable-publication.mjs";
import { publishRetainedKricTimetable, validateRetainedKricTimetableReceipt } from "./publish-retained-kric-timetable.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const cell = (value) => ({ value, cellType: "inlineStr", styleId: null });
function input(candidate) {
  const observedAt = new Date(Date.UTC(2040, 0, 1)).toISOString();
  const record = {
    trainNumber: "test", routeNumber: "test-route", routeName: "Test route",
    originStationName: "A", destinationStationName: "B", serviceType: "LOCAL",
    weekdayType: "WEEKDAY", stationName: "A", arrivalTime: cell("080000"),
    departureTime: cell("080100"), speed: cell(""), operatorPhone: cell(""),
    dataReferenceDate: cell("original-source-basis"), sourceRowNumber: 1,
  };
  record.sourceRowSha256 = hash(JSON.stringify(record));
  const observation = {
    schemaVersion: 1, artifactKind: "kric-nationwide-timetable-observation",
    sourceId: candidate.id, observedAt, rawFile: "source.xlsx", rawByteLength: 12,
    rawSha256: "a".repeat(64), rowCount: 1, groupCount: 1, records: [record],
    recordsSha256: hash(`${JSON.stringify([record])}\n`),
    gaps: { stopSequence: "ABSENT", timeGrammar: "UNADMITTED" },
  };
  const receipt = {
    schemaVersion: 1, artifactKind: "kric-nationwide-timetable-file-receipt",
    sourceId: candidate.id, capturedAt: observedAt, rawFile: observation.rawFile,
    byteLength: observation.rawByteLength, sha256: observation.rawSha256, credentialRedacted: true,
  };
  return { candidate, observationBytes: Buffer.from(JSON.stringify(observation, null, 2)),
    receipt, routeNumber: record.routeNumber, sourcePath: "timetable-observation.json",
    evaluationAt: observedAt };
}
const candidate = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"))
  .candidates.find(({ id }) => id === "kric-nationwide-timetable-file");

test("retained publication binds exact JSON separately from the original acquisition", () => {
  const args = input(candidate);
  const result = prepareRetainedKricTimetablePublication(args);
  assert.equal(result.observationSha256, hash(args.observationBytes));
  assert.equal(result.source.rawSha256, args.receipt.sha256);
  assert.notEqual(result.observationSha256, result.source.rawSha256);
  assert.equal(result.source.observedAt, args.receipt.capturedAt);
  assert.equal(result.freshnessExpiresAt, new Date(Date.parse(args.evaluationAt) + 7 * 86400000).toISOString());
  assert.deepEqual(result.plan.steps.map(({ type }) => type),
    ["put-immutable-bundle-object", "verify-immutable-bundle-object"]);
  for (const step of result.plan.steps) {
    assert.equal(step.sizeBytes, args.observationBytes.length);
    assert.equal(step.sha256, hash(args.observationBytes));
    assert.equal(step.sourcePath, args.sourcePath);
    assert.ok(step.objectKey.includes(result.observationSha256));
  }
});

test("retained publication rejects receipt drift, stale evidence, unsafe paths and policy drift", () => {
  const args = input(candidate);
  assert.throws(() => prepareRetainedKricTimetablePublication({
    ...args, receipt: { ...args.receipt, sha256: "b".repeat(64) },
  }), /RECEIPT/);
  assert.throws(() => prepareRetainedKricTimetablePublication({
    ...args, evaluationAt: new Date(Date.parse(args.evaluationAt) + 7 * 86400000).toISOString(),
  }), /STALE/);
  assert.throws(() => prepareRetainedKricTimetablePublication({ ...args, sourcePath: "../outside.json" }), /PATH/);
  assert.throws(() => prepareRetainedKricTimetablePublication({
    ...args, candidate: { ...candidate, confirmationPolicy: { ...candidate.confirmationPolicy, extra: true } },
  }), /POLICY/);
  const result = prepareRetainedKricTimetablePublication({
    ...args, providerValidUntil: new Date(Date.parse(args.evaluationAt) + 86400000).toISOString(),
  });
  assert.equal(result.freshnessExpiresAt, new Date(Date.parse(args.evaluationAt) + 86400000).toISOString());
});

const OCI_ENV = {
  EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL:
    "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o",
};
// 실제 등록 전 정책을 읽지 않는다. 이 테스트는 publisher의 보관기간 소비 경계만 검증한다.
const governancePolicy = {
  retentionClasses: [{ id: "test-retention", retentionDays: 14 }],
  sources: [{ sourceId: candidate.id, retentionClassId: "test-retention" }],
};

async function publisherInput(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "retained-kric-timetable-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const args = input(candidate);
  const inputPath = path.join(directory, "timetable-observation.json");
  const receiptPath = path.join(directory, "publication-receipt.json");
  await writeFile(inputPath, args.observationBytes);
  return { ...args, inputPath, receiptPath, governancePolicy, env: OCI_ENV,
    now: new Date(args.evaluationAt) };
}

function storageClient({ wrongGet = false } = {}) {
  const objects = new Map();
  const calls = { put: 0, get: 0 };
  return {
    calls,
    client: {
      async putObjectIfAbsent(key, bytes) { calls.put += 1; objects.set(key, Buffer.from(bytes)); return true; },
      async readObject(key) {
        calls.get += 1;
        const body = objects.get(key);
        return wrongGet ? { exists: true, body: Buffer.from("wrong") } : { exists: body != null, body };
      },
    },
  };
}

test("retained registration receipt rejects identity, location, time and byte drift", async (context) => {
  const args = await publisherInput(context);
  const { client } = storageClient();
  const published = await publishRetainedKricTimetable({ ...args, client });
  const validate = (receiptBytes) => validateRetainedKricTimetableReceipt({
    ...args, receiptBytes, evaluationAt: args.now.toISOString(),
  });
  assert.deepEqual(validate(await readFile(args.receiptPath)), published);
  const altered = [
    { rawObjectSha256: args.receipt.sha256 },
    { acquisitionRawSha256: hash(args.observationBytes) },
    { collectionReceiptSha256: "b".repeat(64) },
    { byteSize: args.observationBytes.length + 1 },
    { rawObjectUri: published.rawObjectUri.replace("/sources/", "/foreign/") },
    { storedAt: new Date(args.now.valueOf() + 1000).toISOString() },
    { freshnessExpiresAt: new Date(args.now.valueOf() + 14 * 86400000).toISOString() },
    { rawRetentionExpiresAt: new Date(args.now.valueOf() + 365 * 86400000).toISOString() },
    { extra: true },
  ];
  for (const change of altered) {
    assert.throws(() => validate(Buffer.from(`${JSON.stringify({ ...published, ...change }, null, 2)}\n`)));
  }
  assert.throws(() => validate(Buffer.from(JSON.stringify(published))), /RECEIPT/);
});

test("retained publisher stores the prepared object then creates its bound receipt", async (context) => {
  const args = await publisherInput(context);
  const { client, calls } = storageClient();
  const result = await publishRetainedKricTimetable({ ...args, client });
  assert.deepEqual(JSON.parse(await readFile(args.receiptPath, "utf8")), result);
  assert.equal(calls.put, 1);
  assert.equal(calls.get, 1);
  assert.equal(result.snapshotId, `${candidate.id}-${result.observationIdentitySha256}`);
  assert.equal(result.rawObjectSha256, hash(args.observationBytes));
  assert.equal(result.acquisitionRawSha256, args.receipt.sha256);
  assert.equal((await stat(args.receiptPath)).mode & 0o777, 0o600);
});

test("retained publisher leaves no receipt on storage verification failure", async (context) => {
  const args = await publisherInput(context);
  const { client, calls } = storageClient({ wrongGet: true });
  await assert.rejects(() => publishRetainedKricTimetable({ ...args, client }), /storage publication failed/);
  await assert.rejects(() => readFile(args.receiptPath), { code: "ENOENT" });
  assert.equal(calls.put, 1);
  assert.equal(calls.get, 1);
});

test("retained publisher stops before storage for stale, missing OCI, or preexisting receipt", async (context) => {
  const cases = [
    { mutate: (args) => ({ ...args, now: new Date(Date.parse(args.now) + 365 * 86400000) }) },
    { mutate: (args) => ({ ...args,
      providerValidUntil: new Date(args.now.valueOf() + 86400000).toISOString(),
      now: new Date(args.now.valueOf() + 2 * 86400000) }) },
    { mutate: (args) => ({ ...args, env: {} }) },
    { mutate: async (args) => { await writeFile(args.receiptPath, "already exists"); return args; } },
  ];
  for (const { mutate } of cases) {
    const args = await publisherInput(context);
    const { client, calls } = storageClient();
    const next = await mutate(args);
    await assert.rejects(() => publishRetainedKricTimetable({ ...next, client }));
    assert.equal(calls.put, 0);
    assert.equal(calls.get, 0);
  }
});
