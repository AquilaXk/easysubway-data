import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertExactMainPreflight } from "./publish-seoul-transfer-raw.mjs";
import { publishImmutableObjectPlan } from "./publish-object-storage.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { readCurrentCapitalRouteTopologyAdmission } from "./register-current-capital-route-topology.mjs";

const NAMESPACE = "axvym6vk8g7i";
const BUCKET = "easysubway-datapacks";
const PAR = new RegExp(`^https://objectstorage\\.[a-z0-9][a-z0-9-]*\\.oraclecloud\\.com/p/[^/?#]+/n/${NAMESPACE}/b/${BUCKET}/o/?$`, "u");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function publishCapitalRouteTopologyRaw({ repositoryRoot, expectedMainSha, gitRunner, operationRoot, rawRelativePath = "capital-route-topology.raw.json", env = process.env, client = null, now = new Date() } = {}) {
  if (!path.isAbsolute(repositoryRoot ?? "") || !path.isAbsolute(operationRoot ?? "") || !/^[0-9a-f]{40}$/u.test(expectedMainSha ?? "")
    || rawRelativePath !== "capital-route-topology.raw.json" || !(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("capital topology OCI publication arguments are invalid");
  if (!PAR.test(env?.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL?.trim() ?? "")) throw new Error("capital topology OCI publication requires an OCI PAR URL");
  await assertExactMainPreflight({ repositoryRoot, expectedMainSha, gitRunner });
  const admission = await readCurrentCapitalRouteTopologyAdmission({ repositoryRoot, now });
  const stagedBytes = await readFile(path.join(operationRoot, rawRelativePath));
  if (!stagedBytes.equals(admission.topologyBytes)) throw new Error("capital topology OCI staged bytes do not match protected topology bytes");
  const rawObjectSha256 = sha(admission.topologyBytes);
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: admission.governancePolicy, sourceId: admission.sourceId, retrievedAt: admission.topology.capturedAt });
  if (now.valueOf() < Date.parse(admission.topology.capturedAt) || now.valueOf() >= Date.parse(rawRetentionExpiresAt)) throw new Error("capital topology OCI raw retention is not current");
  const objectKey = `source-raw/${admission.sourceId}/${admission.capturedDate}/${rawObjectSha256}.json`;
  await publishImmutableObjectPlan({ root: operationRoot, client, env, plan: { steps: [
    { type: "put-immutable-bundle-object", objectKey, sourcePath: rawRelativePath, sha256: rawObjectSha256, sizeBytes: admission.topologyBytes.length },
    { type: "verify-immutable-bundle-object", objectKey, sourcePath: rawRelativePath, sha256: rawObjectSha256, sizeBytes: admission.topologyBytes.length },
  ] } });
  return { schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt", sourceId: admission.sourceId, snapshotId: admission.snapshotId, capturedAt: admission.topology.capturedAt, rawObjectUri: `oci://${NAMESPACE}/${BUCKET}/${objectKey}`, rawObjectSha256, byteSize: admission.topologyBytes.length, storedAt: now.toISOString(), rawRetentionExpiresAt, ociNamespace: NAMESPACE, bucket: BUCKET, objectKey, contentType: "application/json" };
}
