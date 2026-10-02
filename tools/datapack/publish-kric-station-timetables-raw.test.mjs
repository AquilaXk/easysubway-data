import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectKricStationTimetables } from "./collect-kric-station-timetables.mjs";
import { KRIC_API_STATION_TIMETABLE_BINDINGS } from "./lib/kric-station-timetable-api-trips.mjs";
import { publishKricStationTimetablesRaw } from "./publish-kric-station-timetables-raw.mjs";
import { STATION_LINES_SOURCE_ID } from "./register-kric-station-timetables.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const OCI_ENV = Object.freeze({
  EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o",
});
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

function fakeFetch() {
  return async (url) => {
    const p = Object.fromEntries(new URL(url).searchParams);
    const binding = KRIC_API_STATION_TIMETABLE_BINDINGS.find(({ lnCd }) => lnCd === p.lnCd);
    const index = binding.stations.findIndex(([, stinCd]) => stinCd === p.stinCd);
    const last = binding.stations.length - 1;
    const clock = (minute) => `06${String(minute).padStart(2, "0")}00`;
    const rows = p.dayCd === "7" ? [] : [{ railOprIsttCd: p.railOprIsttCd, trnNo: `Z${p.dayCd}`, dayCd: p.dayCd, dayNm: "x", stinCd: p.stinCd, lnCd: p.lnCd,
      arvTm: index === 0 ? null : clock(index * 2), dptTm: index === last ? null : clock(index * 2 + 1) }];
    return new Response(JSON.stringify({ header: { resultCode: p.dayCd === "7" ? "03" : "00" }, body: rows }), { status: 200 });
  };
}

async function fixture(t, mutate = (value) => value) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-station-raw-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = Date.parse("2026-10-03T03:00:00.000Z");
  const artifact = mutate(await collectKricStationTimetables({ serviceKey: "fixture-service-key-ZZ9", fetchImpl: fakeFetch(), now: () => new Date(tick += 1000) }));
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const inputPath = path.join(root, "collection.json");
  await writeFile(inputPath, bytes);
  return { artifact, bytes, inputPath, receiptPath: path.join(root, "receipt.json"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

function fakeClient() {
  const calls = [];
  let stored = null;
  return { calls, client: {
    async putObjectIfAbsent(key, bytes) { calls.push(["put", key]); if (stored) return false; stored = Buffer.from(bytes); return true; },
    async readObject(key) { calls.push(["get", key]); return { exists: stored != null, body: stored ?? Buffer.alloc(0) }; },
  } };
}

test("역별 수집본을 새 sourceId 경로에 content-addressed로 게시하고 등록기와 같은 보존 만료일 receipt를 남긴다", async (t) => {
  const values = await fixture(t);
  const storage = fakeClient();
  const now = new Date(Date.parse(values.artifact.collectedAt) + 60_000);
  const receipt = await publishKricStationTimetablesRaw({ inputPath: values.inputPath, receiptPath: values.receiptPath,
    expectedRawObjectSha256: values.sha256, expectedByteSize: values.bytes.length, env: OCI_ENV, client: storage.client, now });
  const key = `source-raw/${STATION_LINES_SOURCE_ID}/20261003/${values.sha256}.json`;
  assert.deepEqual(storage.calls, [["put", key], ["get", key]]);
  assert.equal(receipt.sourceId, STATION_LINES_SOURCE_ID);
  assert.equal(receipt.snapshotId, `${STATION_LINES_SOURCE_ID}-20261003`);
  assert.equal(receipt.rawObjectUri, `oci://axvym6vk8g7i/easysubway-datapacks/${key}`);
  const governance = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "tools/datapack/source-governance-policy.json"), "utf8"));
  const terms = governance.sources.find(({ sourceId }) => sourceId === "kric-subway-timetable");
  const projected = { ...governance, sources: [...governance.sources, { ...terms, sourceId: STATION_LINES_SOURCE_ID }] };
  assert.equal(receipt.rawRetentionExpiresAt, deriveRawRetentionExpiresAt({ policy: projected, sourceId: STATION_LINES_SOURCE_ID, retrievedAt: values.artifact.collectedAt }));
  assert.deepEqual(JSON.parse(await readFile(values.receiptPath, "utf8")), receipt);
});

test("게시 전에 수집본 재구성·기대 해시·게시 시각을 검증하고 실패하면 저장소를 호출하지 않는다", async (t) => {
  const partial = await fixture(t, (value) => ({ ...value, responses: value.responses.slice(1) }));
  const storage = fakeClient();
  const now = new Date(Date.parse(partial.artifact.collectedAt) + 60_000);
  await assert.rejects(publishKricStationTimetablesRaw({ inputPath: partial.inputPath, receiptPath: partial.receiptPath,
    expectedRawObjectSha256: partial.sha256, expectedByteSize: partial.bytes.length, env: OCI_ENV, client: storage.client, now }), /STATION_RESPONSE_MISSING/u);
  const values = await fixture(t);
  await assert.rejects(publishKricStationTimetablesRaw({ inputPath: values.inputPath, receiptPath: values.receiptPath,
    expectedRawObjectSha256: "0".repeat(64), expectedByteSize: values.bytes.length, env: OCI_ENV, client: storage.client, now }), /RAW_SHA256_MISMATCH/u);
  await assert.rejects(publishKricStationTimetablesRaw({ inputPath: values.inputPath, receiptPath: values.receiptPath,
    expectedRawObjectSha256: values.sha256, expectedByteSize: values.bytes.length, env: OCI_ENV, client: storage.client,
    now: new Date(Date.parse(values.artifact.collectedAt) - 1) }), /PUBLICATION_BEFORE_COLLECTION/u);
  await assert.rejects(publishKricStationTimetablesRaw({ inputPath: values.inputPath, receiptPath: values.receiptPath,
    expectedRawObjectSha256: values.sha256, expectedByteSize: values.bytes.length, env: {}, client: storage.client, now }), /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/u);
  assert.equal(storage.calls.length, 0);
});
