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

const OCI_ENV = Object.freeze({
  EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o",
});
const STORED_AT = new Date("2026-08-14T00:01:00.000Z");
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
  const manifest = JSON.parse(await readFile(path.join(observationRoot, "observation.json"), "utf8"));
  const rawBytes = await readFile(path.join(observationRoot, manifest.rawArtifactFile));
  return { root, observationRoot, observation, rawBytes, receiptPath: path.join(root, "receipt.json") };
}

function fakeClient(values, { existing = false, tamper = false } = {}) {
  const calls = [];
  let stored = existing ? (tamper ? Buffer.from("tampered") : values.rawBytes) : null;
  return {
    calls,
    client: {
      async putObjectIfAbsent(key, bytes) {
        calls.push(["put", key]);
        if (stored != null) return false;
        stored = Buffer.from(bytes);
        return true;
      },
      async readObject(key) {
        calls.push(["get", key]);
        return { exists: stored != null, body: stored ?? Buffer.alloc(0) };
      },
    },
  };
}

function publishOptions(values, client, overrides = {}) {
  return {
    observationRoot: values.observationRoot,
    receiptPath: values.receiptPath,
    env: OCI_ENV,
    client,
    now: STORED_AT,
    ...overrides,
  };
}

test("Seoul raw publisher는 observation identity를 OCI immutable receipt로 결속한다", async (t) => {
  const values = await fixture(t);
  const storage = fakeClient(values);
  const receipt = await publishSeoulAccessibilityRawArtifact(publishOptions(values, storage.client));
  assert.equal(receipt.sourceId, "seoul-metro-accessibility");
  assert.equal(receipt.snapshotId, values.observation.snapshot.snapshotId);
  assert.match(receipt.rawObjectUri, /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/source-raw\/seoul-metro-accessibility\/20260814\/[0-9a-f]{64}\.json$/u);
  assert.equal(receipt.storedAt, STORED_AT.toISOString());
  assert.ok(Date.parse(receipt.rawRetentionExpiresAt) > STORED_AT.valueOf());
  assert.deepEqual(JSON.parse(await readFile(values.receiptPath, "utf8")), receipt);
  assert.deepEqual(storage.calls.map(([operation]) => operation), ["put", "get"]);
});

test("Seoul raw publisher는 exact existing OCI object만 idempotent하게 허용한다", async (t) => {
  const values = await fixture(t);
  const exact = fakeClient(values, { existing: true });
  await publishSeoulAccessibilityRawArtifact(publishOptions(values, exact.client));
  assert.deepEqual(exact.calls.map(([operation]) => operation), ["put", "get", "get"]);

  const tamperedValues = await fixture(t);
  const tampered = fakeClient(tamperedValues, { existing: true, tamper: true });
  await assert.rejects(
    publishSeoulAccessibilityRawArtifact(publishOptions(tamperedValues, tampered.client)),
    /storage publication failed/,
  );
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
  const storage = fakeClient(values);
  await assert.rejects(
    publishSeoulAccessibilityRawArtifact(publishOptions(values, storage.client)),
    /raw collection is invalid/,
  );
  assert.equal(storage.calls.length, 0);
});
