import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { deriveFreshnessExpiresAt } from "../freshness-policy.mjs";
import { deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { requiredUtcInstant } from "../lib/utc-instant.mjs";

const REQUIRED_PROVENANCE_FIELDS = [
  "snapshotId",
  "sourceId",
  "rawObjectUri",
  "rawSha256",
  "contentSha256",
  "redactedRequestFingerprint",
  "schemaFingerprint",
  "licenseStatus",
  "redistributionAllowed",
  "adminReviewRecordHash",
  "snapshotStatus",
  "credentialRedacted",
  "freshnessExpiresAt",
  "rawRetentionExpiresAt",
  "governancePolicyVersion",
  "governancePolicySha256",
];

// 실제 승인 증거는 inventory의 license/admin hash로만 묶고, fixture raw/content는 별도 test-only record로 만든다.
export async function createIndependentSourceGovernanceFixture({
  repositoryRoot = process.cwd(),
  buildSpec = {},
} = {}) {
  const root = path.resolve(repositoryRoot);
  const [inventoryBytes, governancePolicyBytes, freshnessPolicyBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json")),
    readFile(path.join(root, "tools/datapack/source-governance-policy.json")),
    readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json")),
  ]);
  const inventory = parseJson(inventoryBytes, "source inventory");
  const governancePolicy = parseJson(governancePolicyBytes, "source governance policy");
  const freshnessPolicy = parseJson(freshnessPolicyBytes, "freshness policy");
  if (!buildSpec || typeof buildSpec !== "object" || Array.isArray(buildSpec)) {
    throw new Error("independent source governance fixture buildSpec must be an object");
  }

  const sources = inventory.sources?.filter((source) => source.requiredForProductionPack === true) ?? [];
  if (sources.length === 0) throw new Error("independent source governance fixture requires production sources");
  const governanceBySource = new Map((governancePolicy.sources ?? []).map((entry) => [entry.sourceId, entry]));
  const evaluationAt = reviewWindowEvaluationAt(sources, governanceBySource);
  const governancePolicySha256 = sha256(governancePolicyBytes);
  const records = [];
  const snapshots = sources.map((source) => {
    const governance = requiredOne(governanceBySource.get(source.id), `${source.id} governance entry`);
    const sourceClass = requiredOne(
      (freshnessPolicy.sourceClasses ?? []).filter((entry) => entry.id === governance.sourceClassId
        && entry.sourceIds?.includes(source.id)),
      `${source.id} freshness class`,
    );
    const adminReviewRecordHash = requiredSha256(
      source.admissionEvidence?.adminReviewRecordHash,
      `${source.id} admin review hash`,
    );
    requiredSha256(source.admissionEvidence?.licenseEvidenceHash, `${source.id} license evidence hash`);
    const rawRecord = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      artifactKind: "independent-source-governance-test-record",
      testOnly: true,
      observedAt: evaluationAt,
      sourceId: source.id,
      recordKind: "raw",
    }));
    const contentRecord = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      artifactKind: "independent-source-governance-test-record",
      testOnly: true,
      observedAt: evaluationAt,
      sourceId: source.id,
      recordKind: "normalized-content",
    }));
    const rawSha256 = sha256(rawRecord);
    const contentSha256 = sha256(contentRecord);
    const freshnessExpiresAt = deriveFreshnessExpiresAt({
      policy: freshnessPolicy,
      sourceClassId: sourceClass.id,
      basisAt: evaluationAt,
      evaluationAt,
    });
    const snapshot = {
      schemaVersion: 1,
      artifactKind: "official-source-snapshot",
      testOnly: true,
      snapshotId: `test-only-${source.id}-initial-${rawSha256.slice(0, 12)}`,
      sourceId: source.id,
      provider: source.provider,
      retrievedAt: evaluationAt,
      sourceUpdatedAt: evaluationAt,
      [sourceClass.basisField]: evaluationAt,
      rowCount: 1,
      coverageCount: 1,
      rawSha256,
      contentSha256,
      rawObjectUri: `oci://test-fixture-source-governance/source-raw/${source.id}/${rawSha256}.json`,
      redactedRequestFingerprint: recordHash(source.id, "redacted-request"),
      schemaFingerprint: recordHash(source.id, "schema"),
      snapshotStatus: "LOCKED",
      schemaStatus: "PASS",
      licenseStatus: "PASS",
      fetchStatus: "SUCCESS",
      redistributionAllowed: true,
      credentialRedacted: true,
      previousSnapshotId: null,
      diffSummary: null,
      freshnessExpiresAt,
      rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
        policy: governancePolicy,
        sourceId: source.id,
        retrievedAt: evaluationAt,
      }),
      adminReviewRecordHash,
      governancePolicyVersion: governancePolicy.policyVersion,
      governancePolicySha256,
    };
    if (sourceClass.providerValidityEndField) {
      snapshot[sourceClass.providerValidityEndField] = freshnessExpiresAt;
    }
    records.push(Object.freeze({
      sourceId: source.id,
      snapshotId: snapshot.snapshotId,
      rawBytes: rawRecord,
      contentBytes: contentRecord,
    }));
    return Object.freeze(snapshot);
  });
  const sourceSnapshots = snapshots.map((snapshot) => Object.freeze(projectBuildProvenance(snapshot)));
  const fixtureBuildSpec = Object.freeze({
    ...buildSpec,
    sourceSnapshotIds: snapshots.map(({ snapshotId }) => snapshotId),
    sourceSnapshots,
    sourceSnapshotSetHash: sha256(JSON.stringify(snapshots)),
    sourceInventorySha256: sha256(JSON.stringify(inventory)),
  });
  return Object.freeze({
    inventory,
    freshnessPolicy,
    governancePolicy,
    governancePolicyBytes,
    governancePolicySha256,
    evaluationAt,
    snapshots: Object.freeze(snapshots),
    records: Object.freeze(records),
    buildSpec: fixtureBuildSpec,
  });
}

function reviewWindowEvaluationAt(sources, governanceBySource) {
  const entries = sources.map((source) => requiredOne(governanceBySource.get(source.id), `${source.id} governance entry`));
  const reviewedAt = Math.max(...entries.map((entry) => utcMillis(entry.licenseReview?.reviewedAt, `${entry.sourceId} reviewedAt`)));
  const evaluationMillis = reviewedAt + 1;
  const earliestNextReviewAt = Math.min(...entries.map((entry) => utcMillis(entry.licenseReview?.nextReviewAt, `${entry.sourceId} nextReviewAt`)));
  if (evaluationMillis >= earliestNextReviewAt) {
    throw new Error("independent source governance fixture has no selected license-review overlap");
  }
  return new Date(evaluationMillis).toISOString();
}

function projectBuildProvenance(snapshot) {
  return Object.fromEntries(REQUIRED_PROVENANCE_FIELDS.map((field) => [field, snapshot[field]]));
}

function recordHash(sourceId, recordKind) {
  return sha256(JSON.stringify({
    schemaVersion: 1,
    artifactKind: "independent-source-governance-test-record",
    testOnly: true,
    sourceId,
    recordKind,
  }));
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`independent source governance fixture ${label} is invalid JSON`);
  }
}

function requiredOne(value, label) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length !== 1 || !values[0]) throw new Error(`independent source governance fixture requires ${label}`);
  return values[0];
}

function requiredSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`independent source governance fixture requires ${label}`);
  }
  return value;
}

function utcMillis(value, label) {
  return requiredUtcInstant(value, label);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
