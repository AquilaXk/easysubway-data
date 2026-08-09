import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { publishKricTimetableRawArtifact } from "./publish-kric-timetable-raw.mjs";

const ACCOUNT = "123456789012";

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

async function fixture(value = artifact()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-raw-publish-"));
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
    checksumSha256: createHash("sha256").update(bytes).digest("base64"),
  };
}

function fakeAws(values, { preconditionFailed = false, tamperHead = false, callerAccount = ACCOUNT, failAt = null } = {}) {
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push([command, args]);
    if ((args[0] === "sts" && failAt === "sts")
      || (args[1] === "put-object" && failAt === "put")
      || (args[1] === "head-object" && failAt === "head")) {
      const error = new Error("SHOULD-NOT-LEAK");
      error.stderr = "An error occurred (AccessDenied) when calling the AWS operation: SHOULD-NOT-LEAK";
      throw error;
    }
    if (args[0] === "sts") return { stdout: `${callerAccount}\n`, stderr: "" };
    if (args[1] === "put-object") {
      if (preconditionFailed) {
        const error = new Error("put failed");
        error.stderr = "An error occurred (PreconditionFailed) when calling the PutObject operation: 412";
        throw error;
      }
      return { stdout: JSON.stringify({ VersionId: "version-1" }), stderr: "" };
    }
    if (args[1] === "head-object") {
      return {
        stdout: JSON.stringify({
          ContentLength: tamperHead ? values.bytes.length + 1 : values.bytes.length,
          ChecksumSHA256: values.checksumSha256,
          VersionId: "version-1",
          ETag: '"etag"',
          LastModified: "2026-08-09T12:05:00.000Z",
          Metadata: {
            sha256: values.sha256,
            "artifact-kind": "kric-line4-timetable-collection",
            "source-id": "kric-subway-timetable",
          },
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected AWS command: ${args.join(" ")}`);
  };
  return { calls, execFileImpl };
}

function publishOptions(values, overrides = {}) {
  return {
    inputPath: values.inputPath,
    receiptPath: values.receiptPath,
    expectedBucketOwner: ACCOUNT,
    expectedRawObjectSha256: values.sha256,
    expectedByteSize: values.bytes.length,
    ...overrides,
  };
}

test("KRIC raw publisher는 content-addressed S3 object를 owner·checksum에 결속한다", async () => {
  const values = await fixture();
  const aws = fakeAws(values);

  const receipt = await publishKricTimetableRawArtifact(publishOptions(values, { execFileImpl: aws.execFileImpl }));

  const key = `kric-subway-timetable/20260809/${values.sha256}.json`;
  assert.equal(receipt.rawObjectUri, `s3://easysubway-datapack-sources/${key}`);
  assert.equal(receipt.rawObjectSha256, values.sha256);
  assert.equal(receipt.byteSize, values.bytes.length);
  assert.equal(receipt.expectedBucketOwner, ACCOUNT);
  assert.deepEqual(JSON.parse(await readFile(values.receiptPath, "utf8")), receipt);
  assert.deepEqual(aws.calls.map(([, args]) => args.slice(0, 2)), [
    ["sts", "get-caller-identity"],
    ["s3api", "put-object"],
    ["s3api", "head-object"],
  ]);
  const putArgs = aws.calls[1][1];
  assert.ok(putArgs.includes("--if-none-match"));
  assert.ok(putArgs.includes("*"));
  assert.ok(putArgs.includes("--checksum-sha256"));
  assert.ok(putArgs.includes(values.checksumSha256));
  assert.ok(putArgs.includes("--expected-bucket-owner"));
  assert.ok(putArgs.includes(ACCOUNT));
});

test("KRIC raw publisher는 existing exact object만 idempotent하게 허용한다", async () => {
  const values = await fixture();
  const exact = fakeAws(values, { preconditionFailed: true });
  const receipt = await publishKricTimetableRawArtifact(publishOptions(values, { execFileImpl: exact.execFileImpl }));
  assert.equal(receipt.idempotentExistingObject, true);

  const tampered = fakeAws(values, { preconditionFailed: true, tamperHead: true });
  await assert.rejects(
    publishKricTimetableRawArtifact(publishOptions(values, {
      receiptPath: path.join(values.root, "tampered-receipt.json"),
      execFileImpl: tampered.execFileImpl,
    })),
    /S3 object identity mismatch/,
  );
});

test("KRIC raw publisher는 AWS failure code만 credential-safe하게 보고한다", async () => {
  const values = await fixture();
  const secretText = "SHOULD-NOT-LEAK";
  const execFileImpl = async (_command, args) => {
    if (args[0] === "sts") return { stdout: `${ACCOUNT}\n`, stderr: "" };
    const error = new Error("put failed");
    error.stderr = `An error occurred (AccessDenied) when calling the PutObject operation: ${secretText}`;
    throw error;
  };
  await assert.rejects(
    publishKricTimetableRawArtifact(publishOptions(values, { execFileImpl })),
    (error) => error.message === "KRIC raw object upload failed: AccessDenied"
      && !error.message.includes(secretText),
  );
});

test("KRIC raw publisher는 full collection contract와 caller owner를 게시 전에 검증한다", async () => {
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
    const values = await fixture(changed);
    const aws = fakeAws(values);
    await assert.rejects(
      publishKricTimetableRawArtifact(publishOptions(values, { execFileImpl: aws.execFileImpl })),
      /KRIC pilot artifact/,
    );
    assert.equal(aws.calls.length, 0);
  }

  const values = await fixture(base);
  const wrongCaller = fakeAws(values, { callerAccount: "999999999999" });
  await assert.rejects(
    publishKricTimetableRawArtifact(publishOptions(values, { execFileImpl: wrongCaller.execFileImpl })),
    /caller account does not match expected bucket owner/,
  );
});

test("KRIC raw publisher는 STS·PUT·HEAD 실패를 모두 credential-safe하게 정제한다", async () => {
  const values = await fixture();
  for (const failAt of ["sts", "put", "head"]) {
    const aws = fakeAws(values, { failAt });
    await assert.rejects(
      publishKricTimetableRawArtifact(publishOptions(values, {
        receiptPath: path.join(values.root, `${failAt}.json`),
        execFileImpl: aws.execFileImpl,
      })),
      (error) => error.message.includes("AccessDenied") && !error.message.includes("SHOULD-NOT-LEAK"),
    );
  }
});
