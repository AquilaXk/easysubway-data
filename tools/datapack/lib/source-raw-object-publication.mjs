import path from "node:path";
import { preauthenticatedObjectStorageClient, publishImmutableObjectPlan } from "../publish-object-storage.mjs";

/** 기존 객체는 영수증 없는 재사용으로 간주하며 새 원문만 한 번 발행한다. */
export async function publishSourceRawObject({ sourcePath, sha256, sizeBytes, target, baseUrl, client, label }) {
  const storage = client ?? preauthenticatedObjectStorageClient(baseUrl, { includeErrorBody: false });
  const object = { objectKey: target.objectKey, sourcePath: path.basename(sourcePath), sha256, sizeBytes };
  try {
    await publishImmutableObjectPlan({
      root: path.dirname(sourcePath),
      plan: { steps: [
        { type: "put-immutable-bundle-object", ...object },
        { type: "verify-immutable-bundle-object", ...object },
      ] },
      client: {
        putObjectIfAbsent: async (...args) => {
          if (!await storage.putObjectIfAbsent(...args)) throw new Error(`${label} object already exists`);
          return true;
        },
        readObject: (...args) => storage.readObject(...args),
      },
    });
  } catch {
    throw new Error(`${label} OCI publication failed`);
  }
}

const RECEIPT_KEYS = [
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "rawObjectUri",
  "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt", "ociNamespace",
  "bucket", "objectKey", "contentType",
].sort();

/** 관측 시각 필드의 지역별 차이는 호출자가 명시하고, 영수증 계약은 한 곳에서 유지한다. */
export function validateSourceRawObjectReceipt({ receipt, expected, target, now, label }) {
  if (JSON.stringify(Object.keys(receipt ?? {}).sort()) !== JSON.stringify(RECEIPT_KEYS)
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== expected.sourceId || receipt.snapshotId !== expected.snapshotId
    || receipt.capturedAt !== expected.capturedAt || receipt.rawObjectSha256 !== expected.rawObjectSha256
    || receipt.byteSize !== expected.byteSize || receipt.ociNamespace !== target.ociNamespace
    || receipt.bucket !== target.bucket || receipt.objectKey !== target.objectKey || receipt.rawObjectUri !== target.rawObjectUri
    || receipt.contentType !== "application/json" || !instant(receipt.storedAt) || !instant(receipt.rawRetentionExpiresAt)
    || Date.parse(receipt.storedAt) < Date.parse(receipt.capturedAt) || Date.parse(receipt.storedAt) > now.valueOf()
    || receipt.rawRetentionExpiresAt !== expected.rawRetentionExpiresAt) {
    throw new Error(`${label} OCI receipt binding is invalid`);
  }
}

function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
