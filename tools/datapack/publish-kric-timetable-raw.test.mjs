import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { publishKricTimetableRawArtifact } from "./publish-kric-timetable-raw.mjs";

const ACCOUNT = "123456789012";

function artifact() {
  return {
    artifactKind: "kric-line4-timetable-collection",
    sourceId: "kric-subway-route-info",
    operation: "subwayTimetableExp",
    collectedAt: "2026-08-09T12:04:20.479Z",
    capturedAt: "2026-08-09",
    requestCount: 153,
    failedRequestCount: 0,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-raw-publish-"));
  const inputPath = path.join(root, "collection.json");
  const receiptPath = path.join(root, "receipt.json");
  const bytes = Buffer.from(`${JSON.stringify(artifact(), null, 2)}\n`);
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

function fakeAws(values, { preconditionFailed = false, tamperHead = false } = {}) {
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "sts") return { stdout: `${ACCOUNT}\n`, stderr: "" };
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

test("KRIC raw publisher는 content-addressed S3 object를 owner·checksum에 결속한다", async () => {
  const values = await fixture();
  const aws = fakeAws(values);

  const receipt = await publishKricTimetableRawArtifact({
    inputPath: values.inputPath,
    receiptPath: values.receiptPath,
    execFileImpl: aws.execFileImpl,
  });

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
  const receipt = await publishKricTimetableRawArtifact({
    inputPath: values.inputPath,
    receiptPath: values.receiptPath,
    execFileImpl: exact.execFileImpl,
  });
  assert.equal(receipt.idempotentExistingObject, true);

  const tampered = fakeAws(values, { preconditionFailed: true, tamperHead: true });
  await assert.rejects(
    publishKricTimetableRawArtifact({
      inputPath: values.inputPath,
      receiptPath: path.join(values.root, "tampered-receipt.json"),
      execFileImpl: tampered.execFileImpl,
    }),
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
    publishKricTimetableRawArtifact({
      inputPath: values.inputPath,
      receiptPath: values.receiptPath,
      execFileImpl,
    }),
    (error) => error.message === "KRIC raw object upload failed: AccessDenied"
      && !error.message.includes(secretText),
  );
});
