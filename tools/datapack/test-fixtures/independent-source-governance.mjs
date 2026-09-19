import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { deriveFreshnessExpiresAt } from "../freshness-policy.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { requiredUtcInstant } from "../lib/utc-instant.mjs";

// 실제 이력 결속을 유지하면서 테스트 대상 source만 아직 등록되지 않은 상태로 만든다.
export function governanceBeforeSource(current, sourceId) {
  const batches = [];
  let policy = structuredClone(current);
  while (policy.sources.some(row => row.sourceId === sourceId)) {
    const lineage = policy.registrationLineage;
    assert.ok(lineage, "test source must belong to append-only registration lineage");
    const additions = policy.sources.filter(row => lineage.addedSourceIds.includes(row.sourceId));
    batches.unshift(additions.filter(row => row.sourceId !== sourceId));
    const predecessor = { ...policy, sources: policy.sources.filter(row => !lineage.addedSourceIds.includes(row.sourceId)) };
    if (lineage.predecessorLineage === null) delete predecessor.registrationLineage;
    else predecessor.registrationLineage = lineage.predecessorLineage;
    const bytes = lineage.predecessorPolicyText === null
      ? Buffer.from(`${JSON.stringify(predecessor, null, 2)}\n`) : Buffer.from(lineage.predecessorPolicyText);
    assert.equal(sha256(bytes), lineage.predecessorPolicySha256);
    policy = JSON.parse(bytes);
  }
  for (const addedSources of batches.filter(rows => rows.length > 0)) {
    policy = buildAppendOnlyGovernancePolicyRegistration({
      predecessorPolicyBytes: Buffer.from(`${JSON.stringify(policy, null, 2)}\n`), addedSources,
    }).policy;
  }
  return policy;
}

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

// 실제 license 정책은 그대로 읽고, snapshot 내부 결속은 별도 test-only 기록으로 만든다.
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
    const bindingRecord = Buffer.from(JSON.stringify({
      artifactKind: "independent-source-governance-test-binding",
      testOnly: true, sourceId: source.id, rawSha256, contentSha256,
      governancePolicySha256,
    }));
    const adminReviewRecordHash = sha256(bindingRecord);
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
      bindingBytes: bindingRecord,
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
