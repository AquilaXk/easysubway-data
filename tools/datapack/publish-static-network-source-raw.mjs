import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertExactMainPreflight } from "./publish-seoul-transfer-raw.mjs";
import { publishImmutableObjectPlan } from "./publish-object-storage.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const NAMESPACE = "axvym6vk8g7i";
const BUCKET = "easysubway-datapacks";
const OCI_PAR = new RegExp(`^https://objectstorage\\.[a-z0-9][a-z0-9-]*\\.oraclecloud\\.com/p/[^/?#]+/n/${NAMESPACE}/b/${BUCKET}/o/?$`, "u");
const SOURCE_TYPES = Object.freeze({
  "seoulmetro-cyberstation-route-map": { extension: "js", contentType: "application/javascript" },
  "molit-urban-rail-full-route": { extension: "csv", contentType: "text/csv; charset=euc-kr" },
});
const sha = (value) => createHash("sha256").update(value).digest("hex");

export async function publishStaticNetworkSourceRaw({ repositoryRoot, expectedMainSha, gitRunner, operationRoot, sourceId, snapshotId, capturedAt, rawRelativePath, env = process.env, client = null, now = new Date() }) {
  const type = SOURCE_TYPES[sourceId];
  if (!type || !path.isAbsolute(repositoryRoot ?? "") || !path.isAbsolute(operationRoot ?? "")
    || !/^[0-9a-f]{40}$/u.test(expectedMainSha ?? "") || typeof snapshotId !== "string" || snapshotId === ""
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(capturedAt ?? "")
    || typeof rawRelativePath !== "string" || path.isAbsolute(rawRelativePath) || rawRelativePath !== `raw.${type.extension}`
    || !(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("static OCI publication arguments are invalid");
  if (!OCI_PAR.test(env?.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL?.trim() ?? "")) throw new Error("static OCI publication requires an OCI PAR URL");
  await assertExactMainPreflight({ repositoryRoot, expectedMainSha, gitRunner });
  const rawBytes = await readFile(path.join(operationRoot, rawRelativePath)); const rawSha256 = sha(rawBytes); const date = capturedAt.slice(0, 10).replaceAll("-", "");
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/source-governance-policy.json"), "utf8"));
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy, sourceId, retrievedAt: capturedAt });
  if (now.valueOf() >= Date.parse(rawRetentionExpiresAt)) throw new Error("static OCI raw retention has expired");
  const objectKey = `source-raw/${sourceId}/${date}/${rawSha256}.${type.extension}`;
  await publishImmutableObjectPlan({ root: operationRoot, client, env, plan: { steps: [
    { type: "put-immutable-bundle-object", objectKey, sourcePath: rawRelativePath, sha256: rawSha256, sizeBytes: rawBytes.length },
    { type: "verify-immutable-bundle-object", objectKey, sourcePath: rawRelativePath, sha256: rawSha256, sizeBytes: rawBytes.length },
  ] } });
  return {
    schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt", sourceId, snapshotId,
    capturedAt, rawObjectUri: `oci://${NAMESPACE}/${BUCKET}/${objectKey}`, rawObjectSha256: rawSha256,
    byteSize: rawBytes.length, storedAt: now.toISOString(), rawRetentionExpiresAt, ociNamespace: NAMESPACE,
    bucket: BUCKET, objectKey, contentType: type.contentType,
  };
}
