import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectSeoulAccessibilityObservation,
  writeSeoulAccessibilityObservation,
} from "./collect-seoul-accessibility-evidence.mjs";
import { publishSeoulAccessibilityRawArtifact } from "./publish-seoul-accessibility-raw.mjs";

const ACCOUNT = "123456789012";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easysubway-seoul-raw-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observationRoot = path.join(root, "observation");
  const observation = await collectSeoulAccessibilityObservation({
    endpoint: "https://apis.data.go.kr/example",
    serviceKey: "secret-must-not-appear",
    retrievedAt: "2026-08-14T00:00:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        response: {
          header: { resultCode: "00" },
          body: {
            totalCount: 1,
            items: { item: [{ lineNm: "4호선", stnNm: "사당", oprtngSitu: "M", dtlPstn: "대합실" }] },
          },
        },
      }),
    }),
  });
  await writeSeoulAccessibilityObservation({ outputRoot: observationRoot, observation });
  return { root, observationRoot, observation, receiptPath: path.join(root, "receipt.json") };
}

function fakeAws(values, { preconditionFailed = false } = {}) {
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    if (args[0] === "sts") return { stdout: `${ACCOUNT}\n`, stderr: "" };
    if (args[1] === "put-object") {
      if (preconditionFailed) {
        const error = new Error("put failed");
        error.stderr = "An error occurred (PreconditionFailed) when calling the PutObject operation: 412";
        throw error;
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args[1] === "head-object") {
      const manifest = JSON.parse(await readFile(path.join(values.observationRoot, "observation.json"), "utf8"));
      return { stdout: JSON.stringify({
        ContentLength: manifest.rawObjectByteSize,
        ChecksumSHA256: manifest.rawObjectChecksumSha256,
        ETag: "\"etag\"",
        LastModified: "2026-08-14T00:01:00+00:00",
        Metadata: {
          sha256: manifest.rawObjectSha256,
          "artifact-kind": "seoul-accessibility-raw-collection",
          "source-id": "seoul-metro-accessibility",
        },
      }), stderr: "" };
    }
    throw new Error(`unexpected AWS args: ${args.join(" ")}`);
  };
  return { calls, execFileImpl };
}

test("Seoul raw publisher는 observation identity를 unversioned immutable receipt로 결속한다", async (t) => {
  const values = await fixture(t);
  const aws = fakeAws(values);
  const receipt = await publishSeoulAccessibilityRawArtifact({
    observationRoot: values.observationRoot,
    receiptPath: values.receiptPath,
    expectedBucketOwner: ACCOUNT,
    execFileImpl: aws.execFileImpl,
  });
  assert.equal(receipt.sourceId, "seoul-metro-accessibility");
  assert.equal(receipt.snapshotId, values.observation.snapshot.snapshotId);
  assert.equal(receipt.versionId, null);
  assert.match(receipt.rawObjectUri, /^s3:\/\/easysubway-datapack-sources\/seoul-metro-accessibility\/20260814\/[0-9a-f]{64}\.json$/u);
  assert.deepEqual(JSON.parse(await readFile(values.receiptPath, "utf8")), receipt);
  assert.deepEqual(aws.calls.map((args) => args.slice(0, 2)), [
    ["sts", "get-caller-identity"], ["s3api", "put-object"], ["s3api", "head-object"],
  ]);
});

test("Seoul raw publisher는 exact existing object만 idempotent하게 허용한다", async (t) => {
  const values = await fixture(t);
  const receipt = await publishSeoulAccessibilityRawArtifact({
    observationRoot: values.observationRoot,
    receiptPath: values.receiptPath,
    expectedBucketOwner: ACCOUNT,
    execFileImpl: fakeAws(values, { preconditionFailed: true }).execFileImpl,
  });
  assert.equal(receipt.idempotentExistingObject, true);
});

test("Seoul raw publisher는 self-consistent snapshot 변조도 raw page projection으로 거부한다", async (t) => {
  const values = await fixture(t);
  const manifestPath = path.join(values.observationRoot, "observation.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const snapshotPath = path.join(values.observationRoot, manifest.snapshotFile);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  snapshot.stations[0].facilities[0].pathDescription = "tampered projection";
  snapshot.contentSha256 = sha256(JSON.stringify(snapshot.stations));
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  manifest.snapshotFileSha256 = sha256(snapshotBytes);
  await writeFile(snapshotPath, snapshotBytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const aws = fakeAws(values);
  await assert.rejects(publishSeoulAccessibilityRawArtifact({
    observationRoot: values.observationRoot,
    receiptPath: values.receiptPath,
    expectedBucketOwner: ACCOUNT,
    execFileImpl: aws.execFileImpl,
  }), /raw collection is invalid/);
  assert.equal(aws.calls.length, 0);
});
