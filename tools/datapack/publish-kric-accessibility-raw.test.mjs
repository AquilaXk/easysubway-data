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

const OCI_ENV = Object.freeze({
  EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o",
});
const VERIFIED_AT = new Date("2026-08-14T00:01:00.000Z");
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

function fakeOciClient(values, { existing = false, mismatch = false, failMessage = null } = {}) {
  const calls = [];
  let stored;
  return {
    calls,
    client: {
      async putObjectIfAbsent(key, bytes, step) {
        calls.push({ type: "put", key, bytes, step });
        if (failMessage != null) throw new Error(failMessage);
        if (existing) return false;
        stored = Buffer.from(bytes);
        return true;
      },
      async readObject(key) {
        calls.push({ type: "get", key });
        const body = mismatch ? Buffer.from("different") : (stored ?? await readFile(path.join(values.observationRoot, `${values.observation.snapshot.snapshotId}.raw.json`)));
        return { exists: true, body };
      },
    },
  };
}

test("accessibility raw publisher는 observation identity를 content-addressed object와 registrar receipt로 결속한다", async (t) => {
  const values = await fixture(t);
  const oci = fakeOciClient(values);
  const receipt = await publishKricAccessibilityRawArtifact({
    observationRoot: values.observationRoot,
    receiptPath: values.receiptPath,
    env: OCI_ENV,
    client: oci.client,
    now: VERIFIED_AT,
  });

  assert.equal(receipt.sourceId, "kric-station-convenience-standard");
  assert.equal(receipt.snapshotId, values.observation.snapshot.snapshotId);
  assert.equal(receipt.snapshotRawSha256, values.observation.snapshot.rawSha256);
  assert.match(receipt.rawObjectUri, /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/source-raw\/kric-station-convenience-standard\/20260814\/[0-9a-f]{64}\.json$/u);
  assert.match(receipt.rawRetentionExpiresAt, /^2026-11-/u);
  assert.equal(receipt.storedAt, VERIFIED_AT.toISOString());
  assert.deepEqual(JSON.parse(await readFile(values.receiptPath, "utf8")), receipt);
  assert.deepEqual(oci.calls.map(({ type }) => type), ["put", "get"]);
  assert.equal(oci.calls[0].step.type, "put-immutable-bundle-object");
  assert.equal(oci.calls[0].step.objectKey, receipt.rawObjectUri.slice("oci://axvym6vk8g7i/easysubway-datapacks/".length));
  await assert.doesNotReject(publishKricAccessibilityRawArtifact({
    observationRoot: values.observationRoot, receiptPath: values.receiptPath, env: OCI_ENV, client: oci.client, now: VERIFIED_AT,
  }));
});

test("publisher는 exact existing object만 허용하고 full-byte mismatch를 fail closed한다", async (t) => {
  const values = await fixture(t);
  const existing = fakeOciClient(values, { existing: true });
  const receipt = await publishKricAccessibilityRawArtifact({
    observationRoot: values.observationRoot,
    receiptPath: values.receiptPath,
    env: OCI_ENV,
    client: existing.client,
    now: VERIFIED_AT,
  });
  assert.equal(existing.calls[0].type, "put");
  assert.equal(existing.calls[1].type, "get");
  assert.deepEqual(JSON.parse(await readFile(values.receiptPath, "utf8")), receipt);
  const failed = await fixture(t);
  const mismatch = fakeOciClient(failed, { existing: true, mismatch: true });
  await assert.rejects(
    publishKricAccessibilityRawArtifact({
      observationRoot: failed.observationRoot,
      receiptPath: failed.receiptPath,
      env: OCI_ENV,
      client: mismatch.client,
    }),
    /KRIC accessibility raw object storage publication failed/u,
  );

  const invalidPolicy = await fixture(t);
  const untouched = fakeOciClient(invalidPolicy);
  await assert.rejects(
    publishKricAccessibilityRawArtifact({
      observationRoot: invalidPolicy.observationRoot,
      receiptPath: invalidPolicy.receiptPath,
      env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/secret-must-not-appear/n/wrong-namespace/b/easysubway-datapacks/o" },
      client: untouched.client,
    }),
    (error) => /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/u.test(error.message)
      && !error.message.includes("secret-must-not-appear"),
  );
  assert.equal(untouched.calls.length, 0);
});

test("publisher는 verification instant가 invalid 또는 capture 이전이면 receipt를 만들지 않는다", async (t) => {
  for (const now of [new Date("invalid"), new Date("2026-08-13T23:59:59.999Z")]) {
    const values = await fixture(t);
    const oci = fakeOciClient(values);
    await assert.rejects(publishKricAccessibilityRawArtifact({
      observationRoot: values.observationRoot, receiptPath: values.receiptPath, env: OCI_ENV, client: oci.client, now,
    }), /(valid Date|precedes snapshot capture)/u);
    assert.equal(oci.calls.length, 0);
    await assert.rejects(readFile(values.receiptPath), { code: "ENOENT" });
  }
});

test("publisher storage failures never reflect raw or encoded PAR credentials", async (t) => {
  for (const secret of ["raw-par-token", "raw%2Dpar%2Dtoken"]) {
    const values = await fixture(t);
    const oci = fakeOciClient(values, { failMessage: `HTTP 403 response body ${secret}` });
    await assert.rejects(publishKricAccessibilityRawArtifact({
      observationRoot: values.observationRoot, receiptPath: values.receiptPath, env: OCI_ENV, client: oci.client, now: VERIFIED_AT,
    }), (error) => error.message === "KRIC accessibility raw object storage publication failed: HTTP 403"
      && !error.message.includes(secret));
  }
});
