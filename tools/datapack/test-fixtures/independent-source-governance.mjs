import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { deriveFreshnessExpiresAt } from "../freshness-policy.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, buildGovernancePolicyRetirement, deriveRawRetentionExpiresAt } from "../source-governance-policy.mjs";
import { requiredUtcInstant } from "../lib/utc-instant.mjs";
import { sha256 } from "../../lib/hash.mjs";

// 최신 lineage 단계 직전의 정책과 원문 bytes다. 등록 단계는 추가분(additions)을, 퇴역 단계는 퇴역 id(retiredSourceIds)를 돌려준다.
// 퇴역 단계는 기록된 위치에 퇴역 원문을 되돌려 재구성한다.
export function governanceBeforeLatestStep(policy) {
  const lineage = policy.registrationLineage;
  assert.ok(lineage, "test policy must belong to append-only registration lineage");
  const retiredSourceIds = lineage.retiredSourceIds ?? [];
  const additions = retiredSourceIds.length > 0 ? [] : policy.sources.filter(row => lineage.addedSourceIds.includes(row.sourceId));
  const sources = policy.sources.filter(row => !additions.includes(row));
  for (const { position, source } of lineage.retiredSources ?? []) sources.splice(position, 0, source);
  const predecessor = { ...policy, sources };
  if (lineage.predecessorLineage === null) delete predecessor.registrationLineage;
  else predecessor.registrationLineage = lineage.predecessorLineage;
  const bytes = lineage.predecessorPolicyText === null
    ? Buffer.from(`${JSON.stringify(predecessor, null, 2)}\n`) : Buffer.from(lineage.predecessorPolicyText);
  assert.equal(sha256(bytes), lineage.predecessorPolicySha256);
  return { policy: JSON.parse(bytes), bytes, additions, retiredSourceIds };
}

// 퇴역 단계 위에 쌓인 정책을 퇴역 직전 정책으로 되돌린다. 등록 단계 자체를 검증하는 테스트가 쓴다.
export function governanceBeforeRetirements(current) {
  let policy = structuredClone(current);
  while (policy.registrationLineage?.retiredSourceIds !== undefined) policy = governanceBeforeLatestStep(policy).policy;
  return policy;
}

// 대상 source가 사라질 때까지 최신 단계부터 되감는다. steps는 오래된 단계가 앞에 오는 시간순이고,
// base는 되감은 정책과 그 원문 bytes다(닫힌 epoch 루트는 원문 bytes가 곧 증거다).
function rewindUntilSourceAbsent(current, sourceId) {
  const steps = [];
  let base = { policy: structuredClone(current), bytes: Buffer.from(`${JSON.stringify(current, null, 2)}\n`) };
  while (base.policy.sources.some(row => row.sourceId === sourceId)) {
    const step = governanceBeforeLatestStep(base.policy);
    steps.unshift(step);
    base = { policy: step.policy, bytes: step.bytes };
  }
  return { base, steps };
}

function applyStep({ bytes: predecessorPolicyBytes }, { additions, retiredSourceIds }) {
  if (retiredSourceIds.length > 0) return buildGovernancePolicyRetirement({ predecessorPolicyBytes, retiredSourceIds });
  return buildAppendOnlyGovernancePolicyRegistration({ predecessorPolicyBytes, addedSources: additions });
}

// 실제 이력 결속을 유지하면서 테스트 대상 source만 아직 등록되지 않은 상태로 만든다.
// 대상 등록 이후의 등록과 퇴역은 같은 순서로 다시 적용해 현재 정책의 활성 원천 집합을 보존한다.
export function governanceBeforeSource(current, sourceId) {
  const { base, steps } = rewindUntilSourceAbsent(current, sourceId);
  return steps.reduce((rewound, step) => {
    const additions = step.additions.filter(row => row.sourceId !== sourceId);
    return additions.length === 0 && step.retiredSourceIds.length === 0 ? rewound : applyStep(rewound, { ...step, additions });
  }, base).policy;
}

// 대상 source의 등록과 그 이후 등록을 모두 되감고, 이후 퇴역만 남은 활성 원천에 다시 적용한다.
// targetStepSourceIds는 대상과 같은 단계에 등록된 id, registeredSourceIds는 되감은 모든 등록 id다.
export function governanceBeforeRegistration(current, sourceId) {
  const { base, steps } = rewindUntilSourceAbsent(current, sourceId);
  const rewound = steps.reduce((state, step) => {
    const active = new Set(state.policy.sources.map(row => row.sourceId));
    const retiredSourceIds = step.retiredSourceIds.filter(id => active.has(id));
    return retiredSourceIds.length === 0 ? state : applyStep(state, { additions: [], retiredSourceIds });
  }, base);
  const registered = steps.map(step => step.additions.map(row => row.sourceId));
  return {
    policy: rewound.policy,
    bytes: Buffer.from(rewound.bytes),
    registeredSourceIds: registered.flat(),
    targetStepSourceIds: registered[0],
  };
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
  const evaluationAt = reviewWindowEvaluationAt(sources, governanceBySource, buildSpec.publishedAt);
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

// #862: 후보 spec이 주어지면 test-only snapshot의 관측 시각을 후보 시계(publishedAt) 이후로 둔다.
// FINAL은 max(publishedAt, evaluationAt)에서 신선도를 평가하므로, 후보를 재생성해도 같은 경계를 검사한다.
function reviewWindowEvaluationAt(sources, governanceBySource, candidatePublishedAt) {
  const entries = sources.map((source) => requiredOne(governanceBySource.get(source.id), `${source.id} governance entry`));
  const reviewedAt = Math.max(...entries.map((entry) => utcMillis(entry.licenseReview?.reviewedAt, `${entry.sourceId} reviewedAt`)));
  const candidateMillis = candidatePublishedAt === undefined ? Number.NEGATIVE_INFINITY
    : utcMillis(candidatePublishedAt, "candidate publishedAt");
  const evaluationMillis = Math.max(reviewedAt + 1, candidateMillis);
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

