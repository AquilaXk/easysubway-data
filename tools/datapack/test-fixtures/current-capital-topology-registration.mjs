import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { readCurrentCapitalRouteTopologyAdmission } from "../register-current-capital-route-topology.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function createFixtureCapitalTopologyReceipt({ repositoryRoot, now, receiptPath }) {
  if (typeof receiptPath !== "string" || !path.isAbsolute(receiptPath)) {
    throw new Error("fixture capital topology receipt path is required");
  }
  const admission = await readCurrentCapitalRouteTopologyAdmission({ repositoryRoot, now });
  const rawObjectSha256 = sha256(admission.topologyBytes);
  const objectKey = `source-raw/${admission.sourceId}/${admission.capturedDate}/${rawObjectSha256}.json`;
  const receipt = {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: admission.sourceId,
    snapshotId: admission.snapshotId,
    capturedAt: admission.topology.capturedAt,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`,
    rawObjectSha256,
    byteSize: admission.topologyBytes.length,
    storedAt: now.toISOString(),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
      policy: admission.governancePolicy,
      sourceId: admission.sourceId,
      retrievedAt: admission.topology.capturedAt,
    }),
    ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks",
    objectKey,
    contentType: "application/json",
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { admission, receipt, receiptPath };
}
