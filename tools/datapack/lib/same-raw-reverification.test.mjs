import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  RAW_PUBLICATION_MODE,
  appendLedgerRow,
  assertReverificationReceiptMatchesHead,
  planRawObjectPublication,
  verifyReusedRawObject,
} from "./same-raw-reverification.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const RAW = Buffer.from("PK\x03\x04same-official-file");
const RAW_SHA = sha(RAW);
const AUTHORITY = Object.freeze({ namespace: "axvym6vk8g7i", bucket: "easysubway-datapacks" });
const HEAD_KEY = `source-raw/official-file/20261001/${RAW_SHA}.xlsx`;
const head = (overrides = {}) => ({
  sourceId: "official-file", snapshotId: "official-file-a", previousSnapshotId: null,
  rawSha256: RAW_SHA, rawObjectSha256: RAW_SHA, byteSize: RAW.length,
  rawObjectUri: `oci://${AUTHORITY.namespace}/${AUTHORITY.bucket}/${HEAD_KEY}`, ...overrides,
});
function storageWith(objects) {
  const calls = [];
  return {
    calls,
    // 실제 GET 본문으로 sha·크기를 계산하는 클라이언트임을 표시한다(#911 F4).
    verifiesObjectBytes: true,
    async putObjectIfAbsent(key) { calls.push(["put", key]); throw new Error("reverification must not publish"); },
    async verifyObject(key, step) {
      calls.push(["verify", key]);
      const stored = objects.get(key);
      if (!stored) throw new Error(`${key} GET failed with HTTP 404`);
      if (stored.length !== step.sizeBytes) throw new Error(`${key} uploaded size mismatch`);
      if (sha(stored) !== step.sha256) throw new Error(`${key} uploaded checksum mismatch`);
    },
  };
}

test("원장 head와 원본 sha가 같으면 기존 원본 객체를 재사용하는 재확인으로 계획한다", () => {
  const plan = planRawObjectPublication({ head: head(), rawSha256: RAW_SHA, byteSize: RAW.length });
  assert.deepEqual(plan, {
    mode: RAW_PUBLICATION_MODE.REVERIFY_EXISTING,
    reusedFromSnapshotId: "official-file-a",
    rawObjectUri: head().rawObjectUri,
    namespace: AUTHORITY.namespace,
    bucket: AUTHORITY.bucket,
    objectKey: HEAD_KEY,
    rawObjectSha256: RAW_SHA,
    byteSize: RAW.length,
  });
});

test("원장 head가 없거나 원본 sha가 다르면 기존 신규 게시 경로로 계획한다", () => {
  assert.deepEqual(planRawObjectPublication({ head: null, rawSha256: RAW_SHA, byteSize: RAW.length }), { mode: RAW_PUBLICATION_MODE.PUBLISH_NEW });
  const changed = Buffer.from("PK\x03\x04revised-official-file");
  assert.deepEqual(planRawObjectPublication({ head: head(), rawSha256: sha(changed), byteSize: changed.length }), { mode: RAW_PUBLICATION_MODE.PUBLISH_NEW });
});

test("sha는 같은데 원장 head의 크기·URI가 원본과 맞지 않으면 재확인을 계획하지 않고 실패한다", () => {
  assert.throws(() => planRawObjectPublication({ head: head({ byteSize: RAW.length + 1 }), rawSha256: RAW_SHA, byteSize: RAW.length }), /SAME_RAW_REVERIFICATION_HEAD_SIZE/u);
  assert.throws(() => planRawObjectPublication({ head: head({ rawObjectUri: "https://example.invalid/raw.xlsx" }), rawSha256: RAW_SHA, byteSize: RAW.length }), /SAME_RAW_REVERIFICATION_HEAD_URI/u);
  assert.throws(() => planRawObjectPublication({ head: head({ rawObjectUri: `oci://${AUTHORITY.namespace}/${AUTHORITY.bucket}/source-raw/official-file/20261001/${"0".repeat(64)}.xlsx` }), rawSha256: RAW_SHA, byteSize: RAW.length }), /SAME_RAW_REVERIFICATION_HEAD_URI/u);
});

test("재사용할 기존 원본 객체를 실제로 읽어 크기·sha가 같을 때만 통과하고, 새로 게시하지 않는다", async () => {
  const plan = planRawObjectPublication({ head: head(), rawSha256: RAW_SHA, byteSize: RAW.length });
  const ok = storageWith(new Map([[HEAD_KEY, RAW]]));
  await verifyReusedRawObject({ plan, storage: ok, ...AUTHORITY, contentType: "application/octet-stream" });
  assert.deepEqual(ok.calls, [["verify", HEAD_KEY]]);

  for (const [objects, label] of [
    [new Map(), "missing"],
    [new Map([[HEAD_KEY, Buffer.concat([RAW, Buffer.from("x")])]]), "size"],
    [new Map([[HEAD_KEY, Buffer.from(RAW).fill(0x41, 4)]]), "sha"],
  ]) {
    const storage = storageWith(objects);
    await assert.rejects(verifyReusedRawObject({ plan, storage, ...AUTHORITY, contentType: "application/octet-stream" }), /SAME_RAW_REVERIFICATION_OBJECT_VERIFY/u, label);
    assert.deepEqual(storage.calls.map(([type]) => type), ["verify"], label);
  }
  await assert.rejects(verifyReusedRawObject({ plan, storage: ok, namespace: AUTHORITY.namespace, bucket: "other-bucket", contentType: "application/octet-stream" }), /SAME_RAW_REVERIFICATION_OBJECT_AUTHORITY/u);
  await assert.rejects(verifyReusedRawObject({ plan: { mode: RAW_PUBLICATION_MODE.PUBLISH_NEW }, storage: ok, ...AUTHORITY, contentType: "application/octet-stream" }), /SAME_RAW_REVERIFICATION_PLAN/u);
});

test("원장은 append-only다: 기존 행을 그대로 두고 head를 잇는 새 행 하나만 붙인다", () => {
  const first = head();
  const other = { sourceId: "other-source", snapshotId: "other-a", previousSnapshotId: null };
  const ledger = Object.freeze([Object.freeze(first), Object.freeze(other)]);
  const row = { ...head(), snapshotId: "official-file-b", previousSnapshotId: "official-file-a" };
  const next = appendLedgerRow(ledger, row);
  assert.deepEqual(next, [first, other, row]);
  assert.equal(next[0], ledger[0]);
  assert.equal(next[1], ledger[1]);
  assert.throws(() => appendLedgerRow(ledger, { ...row, snapshotId: "official-file-a" }), /SAME_RAW_REVERIFICATION_SNAPSHOT_COLLISION/u);
  assert.throws(() => appendLedgerRow(ledger, { ...row, previousSnapshotId: null }), /SAME_RAW_REVERIFICATION_LINEAGE/u);
  assert.throws(() => appendLedgerRow(ledger, { ...row, sourceId: "new-source", previousSnapshotId: "official-file-a" }), /SAME_RAW_REVERIFICATION_LINEAGE/u);
  assert.deepEqual(appendLedgerRow(ledger, { sourceId: "new-source", snapshotId: "new-a", previousSnapshotId: null }).length, 3);
});

// #911 F2: 재확인 영수증의 결속 필드를 하나씩 바꾸면 각각 실패한다.
test("재확인 영수증은 head의 URI·snapshot·sha·크기와 각각 정확히 같아야 한다(#911 F2)", () => {
  const receipt = { rawObjectUri: head().rawObjectUri, reusedFromSnapshotId: "official-file-a", rawObjectSha256: RAW_SHA, byteSize: RAW.length };
  assert.equal(assertReverificationReceiptMatchesHead({ receipt, head: head(), rawSha256: RAW_SHA, byteSize: RAW.length }).mode, RAW_PUBLICATION_MODE.REVERIFY_EXISTING);
  for (const [field, value] of [
    ["rawObjectUri", head().rawObjectUri.replace("20261001", "20261002")],
    ["reusedFromSnapshotId", "official-file-other"],
    ["rawObjectSha256", "0".repeat(64)],
    ["byteSize", RAW.length + 1],
  ]) {
    assert.throws(() => assertReverificationReceiptMatchesHead({ receipt: { ...receipt, [field]: value }, head: head(), rawSha256: RAW_SHA, byteSize: RAW.length }),
      /SAME_RAW_REVERIFICATION_RECEIPT_HEAD/u, field);
  }
});

// #911 F4: 재확인은 실제 GET 본문으로 sha를 계산하는 클라이언트만 받는다. HEAD 메타데이터만 보는 클라이언트는 거부한다.
test("실제 바이트를 읽지 않는(HEAD 메타데이터) 저장소 클라이언트로는 재확인하지 않는다(#911 F4)", async () => {
  const plan = planRawObjectPublication({ head: head(), rawSha256: RAW_SHA, byteSize: RAW.length });
  const calls = [];
  const headOnly = { async verifyObject(key) { calls.push(["head", key]); } };
  await assert.rejects(verifyReusedRawObject({ plan, storage: headOnly, ...AUTHORITY, contentType: "application/octet-stream" }), /SAME_RAW_REVERIFICATION_STORAGE/u);
  await assert.rejects(verifyReusedRawObject({ plan, storage: { ...headOnly, verifiesObjectBytes: "yes" }, ...AUTHORITY, contentType: "application/octet-stream" }), /SAME_RAW_REVERIFICATION_STORAGE/u);
  assert.deepEqual(calls, []);
});

test("PAR 저장소 클라이언트는 실제 GET 본문으로 확인하는 클라이언트로 표시되고, 서명 클라이언트는 아니다(#911 F4)", async () => {
  const { preauthenticatedObjectStorageClient, objectStorageClient } = await import("../publish-object-storage.mjs");
  assert.equal(preauthenticatedObjectStorageClient("https://objectstorage.ap-seoul-1.oraclecloud.com/p/x/n/ns/b/bucket/o", { requestImpl: async () => ({}) }).verifiesObjectBytes, true);
  const signed = objectStorageClient({ EASYSUBWAY_OBJECT_STORAGE_ENDPOINT: "https://example.invalid", EASYSUBWAY_DATAPACK_BUCKET: "bucket",
    EASYSUBWAY_OBJECT_STORAGE_REGION: "r", EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY: "k", EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY: "s" });
  assert.notEqual(signed?.verifiesObjectBytes, true);
});
