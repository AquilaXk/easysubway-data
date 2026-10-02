import { terminalHead } from "../build-current-five-region-source-fan-in.mjs";

// #870: 같은 공식 원본(바이트 sha256이 원장 head와 같음)을 다시 수집했을 때, 원본을 다시 게시하지 않고
// head가 가리키는 기존 OCI 객체를 실제로 읽어 확인한 뒤 재확인 원장 행만 append한다.
// - sha가 다르면 기존 신규 게시 경로(PUBLISH_NEW)다.
// - sha가 같은데 head의 크기·URI가 원본과 맞지 않거나, 기존 객체를 읽을 수 없거나 크기·sha가 다르면 실패한다.
// - 원장은 append-only다. 기존 행은 바꾸지 않고, 새 행은 head를 previousSnapshotId로 잇는다.

export const RAW_PUBLICATION_MODE = Object.freeze({
  PUBLISH_NEW: "PUBLISH_NEW",
  REVERIFY_EXISTING: "REVERIFY_EXISTING",
});

const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_RAW_URI = /^oci:\/\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)\/(source-raw\/[A-Za-z0-9._-]+\/\d{8}\/([a-f0-9]{64})\.[a-z0-9]+)$/u;
const fail = (code, detail = "") => { throw new Error(`SAME_RAW_REVERIFICATION_${code}${detail ? `: ${detail}` : ""}`); };

/**
 * 원장 head와 새 수집 원본을 비교해 게시 방식을 정한다.
 * @param {{ head: object|null, rawSha256: string, byteSize: number }} input
 */
export function planRawObjectPublication({ head, rawSha256, byteSize }) {
  if (!SHA256.test(rawSha256 ?? "") || !Number.isSafeInteger(byteSize) || byteSize <= 0) fail("RAW");
  if (head == null || head.rawObjectSha256 !== rawSha256) return { mode: RAW_PUBLICATION_MODE.PUBLISH_NEW };
  if (head.byteSize !== byteSize) fail("HEAD_SIZE", head.snapshotId);
  const match = OCI_RAW_URI.exec(head.rawObjectUri ?? "");
  if (!match || match[4] !== rawSha256) fail("HEAD_URI", head.snapshotId);
  if (typeof head.snapshotId !== "string" || head.snapshotId.length === 0) fail("HEAD_SNAPSHOT");
  return {
    mode: RAW_PUBLICATION_MODE.REVERIFY_EXISTING,
    reusedFromSnapshotId: head.snapshotId,
    rawObjectUri: head.rawObjectUri,
    namespace: match[1],
    bucket: match[2],
    objectKey: match[3],
    rawObjectSha256: rawSha256,
    byteSize,
  };
}

/**
 * 재사용할 기존 원본 객체를 실제로 읽어(크기·sha256) 확인한다. 새로 게시하지 않는다.
 * storage는 실제 GET 본문으로 확인하는 verifyObject(key, { sha256, sizeBytes, contentType })와
 * verifiesObjectBytes: true를 제공해야 한다(publish-object-storage의 PAR 클라이언트).
 */
export async function verifyReusedRawObject({ plan, storage, namespace, bucket, contentType }) {
  if (plan?.mode !== RAW_PUBLICATION_MODE.REVERIFY_EXISTING) fail("PLAN");
  if (plan.namespace !== namespace || plan.bucket !== bucket) fail("OBJECT_AUTHORITY");
  // #911 F4: verifyObject가 실제 GET 본문으로 크기·sha를 계산하는 클라이언트만 받는다(HEAD 메타데이터 비교는 거부).
  if (!storage || typeof storage.verifyObject !== "function" || storage.verifiesObjectBytes !== true) fail("STORAGE");
  try {
    await storage.verifyObject(plan.objectKey, { sha256: plan.rawObjectSha256, sizeBytes: plan.byteSize, contentType });
  } catch {
    fail("OBJECT_VERIFY", plan.objectKey);
  }
}

/** 재확인 영수증이 원장 head 객체를 정확히 가리키는지 확인한다(등록기 공용). */
export function assertReverificationReceiptMatchesHead({ receipt, head, rawSha256, byteSize }) {
  const plan = planRawObjectPublication({ head, rawSha256, byteSize });
  if (plan.mode !== RAW_PUBLICATION_MODE.REVERIFY_EXISTING
    || receipt?.rawObjectUri !== plan.rawObjectUri
    || receipt.reusedFromSnapshotId !== plan.reusedFromSnapshotId
    || receipt.rawObjectSha256 !== rawSha256
    || receipt.byteSize !== byteSize) fail("RECEIPT_HEAD");
  return plan;
}

/** 원장에 행 하나를 append한다. 기존 행은 그대로 두고, 새 행은 같은 원천의 head를 잇는다. */
export function appendLedgerRow(ledger, row) {
  if (!Array.isArray(ledger) || typeof row?.sourceId !== "string" || typeof row.snapshotId !== "string") fail("LEDGER");
  if (ledger.some((entry) => entry?.snapshotId === row.snapshotId)) fail("SNAPSHOT_COLLISION", row.snapshotId);
  const head = ledger.some((entry) => entry?.sourceId === row.sourceId) ? terminalHead(row.sourceId, ledger) : null;
  if ((row.previousSnapshotId ?? null) !== (head?.snapshotId ?? null)) fail("LINEAGE", row.snapshotId);
  return [...ledger, row];
}
