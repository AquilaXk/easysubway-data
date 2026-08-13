import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectKricStandardAccessibilityObservation,
  writeKricStandardAccessibilityObservation,
} from "./collect-kric-accessibility-snapshots.mjs";
import { publishKricAccessibilityRawArtifact } from "./publish-kric-accessibility-raw.mjs";

const ACCOUNT = "123456789012";
const tuple = {
  stationId: "station-a",
  lineId: "seoul-4",
  railOprIsttCd: "S1",
  lnCd: "4",
  stinCd: "433",
  canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-a", lineId: "seoul-4" }],
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easysubway-kric-raw-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observationRoot = path.join(root, "observation");
  const observation = await collectKricStandardAccessibilityObservation({
    roster: [tuple],
    serviceKey: "secret-must-not-appear",
    now: new Date("2026-08-14T00:00:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        header: { resultCode: "00", resultMsg: "정상" },
        body: [{ dtlLoc: "대합실", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01" }],
      }),
    }),
  });
  await writeKricStandardAccessibilityObservation({ outputRoot: observationRoot, observation });
  return { root, observationRoot, observation, receiptPath: path.join(root, "receipt.json") };
}

function fakeAws(values, { preconditionFailed = false, failAt = null } = {}) {
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    if (failAt && ((failAt === "sts" && args[0] === "sts") || (failAt === "put" && args[1] === "put-object"))) {
      const error = new Error("secret-must-not-appear");
      error.stderr = "An error occurred (AccessDenied) when calling the AWS operation: secret-must-not-appear";
      throw error;
    }
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
        VersionId: "version-1",
        ETag: "\"etag\"",
        LastModified: "2026-08-14T00:01:00+00:00",
        Metadata: {
          sha256: manifest.rawObjectSha256,
          "artifact-kind": "kric-accessibility-raw-collection",
          "source-id": "kric-station-convenience-standard",
        },
      }), stderr: "" };
    }
    throw new Error(`unexpected AWS args: ${args.join(" ")}`);
  };
  return { calls, execFileImpl };
}

test("accessibility raw publisher는 observation identity를 content-addressed object와 registrar receipt로 결속한다", async (t) => {
  const values = await fixture(t);
  const aws = fakeAws(values);
  const receipt = await publishKricAccessibilityRawArtifact({
    observationRoot: values.observationRoot,
    receiptPath: values.receiptPath,
    expectedBucketOwner: ACCOUNT,
    execFileImpl: aws.execFileImpl,
  });

  assert.equal(receipt.sourceId, "kric-station-convenience-standard");
  assert.equal(receipt.snapshotId, values.observation.snapshot.snapshotId);
  assert.equal(receipt.snapshotRawSha256, values.observation.snapshot.rawSha256);
  assert.match(receipt.rawObjectUri, /^s3:\/\/easysubway-datapack-sources\/kric-station-convenience-standard\/20260814\/[0-9a-f]{64}\.json$/u);
  assert.match(receipt.rawRetentionExpiresAt, /^2026-11-/u);
  assert.equal(receipt.storedAt, "2026-08-14T00:01:00.000Z");
  assert.deepEqual(JSON.parse(await readFile(values.receiptPath, "utf8")), receipt);
  assert.deepEqual(aws.calls.map((args) => args.slice(0, 2)), [
    ["sts", "get-caller-identity"], ["s3api", "put-object"], ["s3api", "head-object"],
  ]);
});

test("publisher는 exact existing object만 허용하고 AWS 오류를 credential-safe하게 정제한다", async (t) => {
  const exact = await fixture(t);
  const existing = fakeAws(exact, { preconditionFailed: true });
  const receipt = await publishKricAccessibilityRawArtifact({
    observationRoot: exact.observationRoot,
    receiptPath: exact.receiptPath,
    expectedBucketOwner: ACCOUNT,
    execFileImpl: existing.execFileImpl,
  });
  assert.equal(receipt.idempotentExistingObject, true);

  const failed = await fixture(t);
  const denied = fakeAws(failed, { failAt: "put" });
  await assert.rejects(
    publishKricAccessibilityRawArtifact({
      observationRoot: failed.observationRoot,
      receiptPath: failed.receiptPath,
      expectedBucketOwner: ACCOUNT,
      execFileImpl: denied.execFileImpl,
    }),
    (error) => error.message === "KRIC accessibility raw object upload failed: AccessDenied"
      && !error.message.includes("secret-must-not-appear"),
  );

  const invalidPolicy = await fixture(t);
  const untouchedAws = fakeAws(invalidPolicy);
  await assert.rejects(
    publishKricAccessibilityRawArtifact({
      observationRoot: invalidPolicy.observationRoot,
      receiptPath: invalidPolicy.receiptPath,
      expectedBucketOwner: ACCOUNT,
      repositoryRoot: path.join(invalidPolicy.root, "missing-repository"),
      execFileImpl: untouchedAws.execFileImpl,
    }),
    /ENOENT/u,
  );
  assert.equal(untouchedAws.calls.length, 0);
});
