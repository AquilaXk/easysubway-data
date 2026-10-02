import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  RAW_PUBLICATION_MODE,
  appendLedgerRow,
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
