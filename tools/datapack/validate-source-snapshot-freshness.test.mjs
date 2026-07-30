import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertRepositoryRelativePath,
  purgeEvidenceBySnapshot,
  validateSourceSnapshotFreshness,
} from "./validate-source-snapshot-freshness.mjs";
import {
  attachPurgeAttestation,
  purgeReportSha256,
} from "./source-raw-purge-attestation.mjs";

const evaluationAt = "2026-07-15T00:00:00.000Z";
const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const purgeKeys = generateKeyPairSync("ed25519");
const purgePublicKeyText = purgeKeys.publicKey.export({ type: "spki", format: "pem" });
const purgePublicKeySha256 = createHash("sha256")
  .update(purgeKeys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex");
const purgeLedgerText = '{"artifactKind":"trusted-test-retention-ledger"}\n';
const purgeSnapshotText = '[{"artifactKind":"trusted-test-snapshot"}]\n';
const purgeAttestations = new WeakMap();
const policy = {
  clockSkewSeconds: 300,
  sourceClasses: [{
    id: "static_network_metadata",
    sourceIds: ["source-a"],
    basisField: "retrievedAt",
    reverificationCadence: "P30D",
  }],
};

function input(overrides = {}) {
  const snapshots = [{
    snapshotId: "snapshot-a",
    sourceId: "source-a",
    rawObjectUri: "s3://bucket/snapshot-a.json",
    rawSha256: "a".repeat(64),
    redactedRequestFingerprint: "b".repeat(64),
    schemaFingerprint: "c".repeat(64),
    licenseStatus: "PASS",
    redistributionAllowed: true,
    snapshotStatus: "LOCKED",
    credentialRedacted: true,
    retrievedAt: "2026-07-12T00:00:00Z",
    sourceUpdatedAt: null,
    rowCount: 10,
    coverageCount: 10,
    previousSnapshotId: null,
    diffSummary: null,
    freshnessExpiresAt: "2026-08-11T00:00:00Z",
    rawRetentionExpiresAt: "2026-10-10T00:00:00.000Z",
    governancePolicyVersion: "2026-07-15",
    governancePolicySha256: "d".repeat(64),
    ...overrides,
  }];
  return {
    snapshots,
    buildSpec: {
      sourceSnapshotIds: ["snapshot-a"],
      sourceSnapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        sourceId: snapshot.sourceId,
        rawObjectUri: snapshot.rawObjectUri,
        rawSha256: snapshot.rawSha256,
        redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
        schemaFingerprint: snapshot.schemaFingerprint,
        licenseStatus: snapshot.licenseStatus,
        redistributionAllowed: snapshot.redistributionAllowed,
        snapshotStatus: snapshot.snapshotStatus,
        credentialRedacted: snapshot.credentialRedacted,
        freshnessExpiresAt: snapshot.freshnessExpiresAt,
        rawRetentionExpiresAt: snapshot.rawRetentionExpiresAt,
        governancePolicyVersion: snapshot.governancePolicyVersion,
        governancePolicySha256: snapshot.governancePolicySha256,
      })),
      sourceSnapshotSetHash: createHash("sha256").update(JSON.stringify(snapshots)).digest("hex"),
    },
    policy: structuredClone(policy),
    evaluationAt,
  };
}

function twoSourceInput() {
  const value = input();
  const second = {
    ...value.snapshots[0],
    snapshotId: "snapshot-b",
    sourceId: "source-b",
    rawObjectUri: "s3://bucket/snapshot-b.json",
    rawSha256: "e".repeat(64),
    retrievedAt: "2026-07-13T00:00:00Z",
    freshnessExpiresAt: "2026-08-12T00:00:00Z",
    rawRetentionExpiresAt: "2026-10-11T00:00:00.000Z",
  };
  value.snapshots.push(second);
  value.buildSpec.sourceSnapshotIds.push(second.snapshotId);
  value.buildSpec.sourceSnapshots.push({
    ...value.buildSpec.sourceSnapshots[0],
    snapshotId: second.snapshotId,
    sourceId: second.sourceId,
    rawObjectUri: second.rawObjectUri,
    rawSha256: second.rawSha256,
    freshnessExpiresAt: second.freshnessExpiresAt,
    rawRetentionExpiresAt: second.rawRetentionExpiresAt,
  });
  value.buildSpec.sourceSnapshotSetHash = createHash("sha256")
    .update(JSON.stringify(value.snapshots))
    .digest("hex");
  value.policy = {
    ...value.policy,
    sourceClasses: [{
      ...value.policy.sourceClasses[0],
      sourceIds: ["source-a", "source-b"],
    }],
  };
  return value;
}

function purgeReport(
  entries,
  completedAt = "2026-10-10T00:00:01.000Z",
  evaluatedAt = "2026-10-10T00:00:00.000Z",
) {
  const body = {
    schemaVersion: 1,
    artifactKind: "source-raw-purge-report",
    evaluatedAt,
    completedAt,
    dryRun: false,
    decision: "PASS",
    deleted: entries,
    alreadyAbsent: [],
    protected: [],
    retained: [],
    wouldDelete: [],
    failed: [],
    reasonCodes: [],
  };
  return attestPurgeReport(body);
}

function attestPurgeReport(report, journalText = purgeJournal(report)) {
  report.auditJournalSha256 = sha256(journalText);
  report.auditJournalRecordCount = journalText.trimEnd().split("\n").length;
  attachPurgeAttestation(report, {
    privateKey: purgeKeys.privateKey,
    ledgerText: purgeLedgerText,
    snapshotText: purgeSnapshotText,
    policyBindings: [{ policyVersion: "2026-07-15", policySha256: "d".repeat(64) }],
  });
  report.reportSha256 = purgeReportSha256(report);
  purgeAttestations.set(report, {
    journalText,
    ledgerText: purgeLedgerText,
    snapshotText: purgeSnapshotText,
    governancePolicyVersion: "2026-07-15",
    governancePolicySha256: "d".repeat(64),
    publicKeyText: purgePublicKeyText,
    trustedPublicKeySha256: purgePublicKeySha256,
  });
  return report;
}

function purgeJournal(report) {
  const candidates = [...report.deleted, ...report.alreadyAbsent, ...report.failed];
  const records = [{
    event: "PLAN",
    evaluatedAt: report.evaluatedAt,
    dryRun: false,
    deleteCandidates: candidates,
  }];
  for (const entry of report.deleted) {
    records.push({ event: "DELETE_INTENT", evaluatedAt: report.evaluatedAt, item: entry });
    records.push({ event: "DELETE_RESULT", evaluatedAt: report.evaluatedAt, item: entry, outcome: "DELETED" });
  }
  for (const entry of report.alreadyAbsent) {
    records.push({ event: "DELETE_RESULT", evaluatedAt: report.evaluatedAt, item: entry, outcome: "ALREADY_ABSENT" });
  }
  for (const entry of report.failed) {
    records.push({ event: "DELETE_INTENT", evaluatedAt: report.evaluatedAt, item: entry });
    records.push({ event: "DELETE_RESULT", evaluatedAt: report.evaluatedAt, item: entry, outcome: "FAILED" });
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function verifiedPurgeEvidence(report) {
  return purgeEvidenceBySnapshot(report, purgeAttestations.get(report));
}

function bindPurgeReport(value, report) {
  value.purgeReport = report;
  value.purgeAttestation = purgeAttestations.get(report);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bindInventory(value) {
  value.buildSpec.sourceInventorySha256 = createHash("sha256")
    .update(JSON.stringify(value.inventory))
    .digest("hex");
}

test("source snapshot ID·hash·policy 파생 freshness가 맞으면 통과한다", () => {
  const result = validateSourceSnapshotFreshness(input());

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, "FRESH");
});

test("sourceSnapshotIds 순서가 evidence와 달라도 동일한 snapshot 집합은 통과한다", () => {
  const value = twoSourceInput();
  value.buildSpec.sourceSnapshotIds.reverse();

  const result = validateSourceSnapshotFreshness(value);

  assert.deepEqual(result.results.map((entry) => entry.snapshotId), ["snapshot-a", "snapshot-b"]);
});

test("governance 입력이 없을 때 policy provenance는 snapshot ID로 비교한다", () => {
  const value = twoSourceInput();
  value.buildSpec.sourceSnapshots.reverse();

  assert.doesNotThrow(() => validateSourceSnapshotFreshness(value));
});

test("PASS purge report를 snapshot별 완료 evidence로 검증해 변환한다", () => {
  const report = purgeReport([
    { sourceId: "source-a", snapshotId: "snapshot-a", rawSha256: "a".repeat(64) },
  ]);

  assert.deepEqual(verifiedPurgeEvidence(report).get("source-a\0snapshot-a"), {
    sourceId: "source-a",
    snapshotId: "snapshot-a",
    rawSha256: "a".repeat(64),
    purgedAt: report.completedAt,
  });
  assert.throws(
    () => purgeEvidenceBySnapshot({ ...report, dryRun: true }, purgeAttestations.get(report)),
    /purge attestation|purge report/,
  );
  assert.throws(
    () => purgeEvidenceBySnapshot({ ...report, completedAt: undefined }, purgeAttestations.get(report)),
    /purge attestation|purge report/,
  );
});

test("self-hash만 다시 계산한 위조 purge report는 실행 attestation으로 거부한다", () => {
  const report = purgeReport([
    { sourceId: "source-a", snapshotId: "snapshot-a", rawSha256: "a".repeat(64) },
  ]);
  const forged = structuredClone(report);
  forged.deleted[0].rawSha256 = "b".repeat(64);
  forged.reportSha256 = purgeReportSha256(forged);

  assert.throws(
    () => purgeEvidenceBySnapshot(forged, purgeAttestations.get(report)),
    /purge attestation/,
  );
});

test("attestation에 결합된 journal·ledger·public key 변조를 거부한다", () => {
  const report = purgeReport([
    { sourceId: "source-a", snapshotId: "snapshot-a", rawSha256: "a".repeat(64) },
  ]);
  const attestation = purgeAttestations.get(report);
  const otherPublicKeyText = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" });

  assert.throws(
    () => purgeEvidenceBySnapshot(report, { ...attestation, journalText: `${attestation.journalText} ` }),
    /purge journal hash/,
  );
  assert.throws(
    () => purgeEvidenceBySnapshot(report, { ...attestation, ledgerText: `${attestation.ledgerText} ` }),
    /purge attestation/,
  );
  assert.throws(
    () => purgeEvidenceBySnapshot(report, { ...attestation, publicKeyText: otherPublicKeyText }),
    /purge attestation/,
  );
  assert.throws(
    () => purgeEvidenceBySnapshot(report, { ...attestation, trustedPublicKeySha256: "f".repeat(64) }),
    /trusted purge attestation key/,
  );
});

test("서명된 purge journal도 PLAN dryRun과 deleteCandidates를 report에 결합한다", () => {
  const entry = { sourceId: "source-a", snapshotId: "snapshot-a", rawSha256: "a".repeat(64) };
  const dryRunMismatch = purgeReport([entry]);
  const dryRunRecords = purgeJournal(dryRunMismatch).trimEnd().split("\n").map(JSON.parse);
  dryRunRecords[0].dryRun = true;
  attestPurgeReport(dryRunMismatch, `${dryRunRecords.map(JSON.stringify).join("\n")}\n`);
  assert.throws(() => verifiedPurgeEvidence(dryRunMismatch), /purge journal plan/);

  const candidatesMismatch = purgeReport([entry]);
  const candidateRecords = purgeJournal(candidatesMismatch).trimEnd().split("\n").map(JSON.parse);
  candidateRecords[0].deleteCandidates = [];
  attestPurgeReport(candidatesMismatch, `${candidateRecords.map(JSON.stringify).join("\n")}\n`);
  assert.throws(() => verifiedPurgeEvidence(candidatesMismatch), /purge journal plan/);
});

test("purge journal의 추가·미완료 DELETE_INTENT는 증거로 소비하지 않는다", () => {
  const entry = { sourceId: "source-a", snapshotId: "snapshot-a", rawSha256: "a".repeat(64) };
  const report = purgeReport([entry]);
  const records = purgeJournal(report).trimEnd().split("\n").map(JSON.parse);
  records.push({
    event: "DELETE_INTENT",
    evaluatedAt: report.evaluatedAt,
    item: { sourceId: "source-b", snapshotId: "snapshot-b", rawSha256: "b".repeat(64) },
  });
  attestPurgeReport(report, `${records.map(JSON.stringify).join("\n")}\n`);

  assert.throws(() => verifiedPurgeEvidence(report), /purge journal sequence/);
});

test("GET 404로 이미 사라진 raw는 DELETE intent 없이도 idempotent purge evidence로 검증한다", () => {
  const report = purgeReport([]);
  report.alreadyAbsent = [
    { sourceId: "source-a", snapshotId: "snapshot-a", rawSha256: "a".repeat(64) },
  ];
  attestPurgeReport(report);

  assert.equal(verifiedPurgeEvidence(report).get("source-a\0snapshot-a").purgedAt, report.completedAt);
});

test("FAIL purge report도 완료된 삭제 증거만 소비하고 실패 항목은 미완료로 남긴다", () => {
  const report = purgeReport([
    { sourceId: "source-a", snapshotId: "snapshot-a", rawSha256: "a".repeat(64) },
  ]);
  report.decision = "FAIL";
  report.failed = [
    { sourceId: "source-b", snapshotId: "snapshot-b", rawSha256: "b".repeat(64) },
  ];
  report.reasonCodes = ["RAW_RETENTION_OVERDUE"];
  attestPurgeReport(report);
  const evidence = verifiedPurgeEvidence(report);

  assert.equal(evidence.has("source-a\0snapshot-a"), true);
  assert.equal(evidence.has("source-b\0snapshot-b"), false);
  const missingReason = { ...report, reasonCodes: [] };
  attestPurgeReport(missingReason);
  assert.throws(() => verifiedPurgeEvidence(missingReason), /purge report/);
  const duplicated = {
    ...report,
    failed: [{ sourceId: "source-a", snapshotId: "snapshot-a", rawSha256: "a".repeat(64) }],
  };
  attestPurgeReport(duplicated);
  assert.throws(() => verifiedPurgeEvidence(duplicated), /duplicate snapshot|journal result set/);
});

test("PASS purge report의 검증된 protection을 snapshot governance 입력으로 변환한다", () => {
  const report = purgeReport([]);
  report.protected = [{
    sourceId: "source-a",
    snapshotId: "snapshot-a",
    rawSha256: "a".repeat(64),
    protectedBy: ["ACTIVE_RELEASE"],
    legalHold: null,
  }];
  attestPurgeReport(report);

  assert.deepEqual(verifiedPurgeEvidence(report).get("source-a\0snapshot-a"), {
    sourceId: "source-a",
    snapshotId: "snapshot-a",
    rawSha256: "a".repeat(64),
    protectedBy: ["ACTIVE_RELEASE"],
    legalHold: null,
    protectedAt: report.evaluatedAt,
  });
});

test("freshness validator는 hash-bound purge report를 retention 완료 근거로 소비한다", () => {
  const value = input({
    freshnessExpiresAt: "2027-07-12T00:00:00Z",
  });
  value.buildSpec.sourceSnapshots[0].freshnessExpiresAt = value.snapshots[0].freshnessExpiresAt;
  value.policy.sourceClasses[0].reverificationCadence = "P1Y";
  value.evaluationAt = "2026-10-11T00:00:00Z";
  value.inventory = {
    sources: [{
      id: "source-a",
      provider: "provider-a",
      datasetUrl: "https://example.invalid/source-a",
      requiredForProductionPack: true,
      license: { redistributionAllowed: true },
      admissionEvidence: { licenseEvidenceHash: "e".repeat(64) },
    }],
  };
  bindInventory(value);
  value.governancePolicy = {
    schemaVersion: 1,
    artifactKind: "datapack-source-governance-policy",
    policyVersion: "2026-07-15",
    retentionClasses: [{ id: "standard-90d", retentionDays: 90 }],
    reasonCodeEscalations: [{
      reasonCodes: [
        "SOURCE_LINEAGE_BROKEN",
        "SOURCE_DIFF_MISSING",
        "SOURCE_FRESHNESS_POLICY_MISSING",
        "SOURCE_SNAPSHOT_EXPIRED",
        "RAW_RETENTION_OVERDUE",
        "LEGAL_HOLD_INVALID",
        "LICENSE_REVIEW_REQUIRED",
        "REDISTRIBUTION_NOT_APPROVED",
        "SOURCE_GOVERNANCE_OWNER_MISSING",
      ],
      responsibleRole: "datapack-source-owner",
      alertRoute: "github:area-datapack",
      escalationHours: 4,
    }],
    sources: [{
      sourceId: "source-a",
      sourceClassId: "static_network_metadata",
      retentionClassId: "standard-90d",
      ownerRole: "datapack-source-owner",
      stewardRole: "datapack-data-steward",
      approvalRole: "datapack-release-approver",
      escalationHours: 4,
      alertRoute: "github:area-datapack",
      licenseReview: {
        status: "APPROVED",
        termsHash: "e".repeat(64),
        reviewedAt: "2026-07-01T00:00:00Z",
        nextReviewAt: "2027-07-01T00:00:00Z",
        termsUrl: "https://example.invalid/source-a",
        reviewedProvider: "provider-a",
        reviewedDatasetUrl: "https://example.invalid/source-a",
        redistributionScopes: ["DERIVED_DATAPACK"],
        approvedByRole: "datapack-release-approver",
      },
    }],
  };
  value.governancePolicySha256 = "d".repeat(64);
  bindPurgeReport(value, purgeReport([{
    sourceId: value.snapshots[0].sourceId,
    snapshotId: value.snapshots[0].snapshotId,
    rawSha256: value.snapshots[0].rawSha256,
  }]));

  const result = validateSourceSnapshotFreshness(value);

  assert.equal(result.governanceResults[0].decision, "GO");

  const freshProtectionReport = purgeReport(
    [],
    "2026-10-11T00:00:01.000Z",
    value.evaluationAt,
  );
  freshProtectionReport.protected = [{
    sourceId: value.snapshots[0].sourceId,
    snapshotId: value.snapshots[0].snapshotId,
    rawSha256: value.snapshots[0].rawSha256,
    protectedBy: ["ACTIVE_RELEASE"],
    legalHold: null,
  }];
  bindPurgeReport(value, attestPurgeReport(freshProtectionReport));

  assert.equal(validateSourceSnapshotFreshness(value).governanceResults[0].decision, "GO");

  const staleProtectionReport = purgeReport([]);
  staleProtectionReport.protected = [{
    sourceId: value.snapshots[0].sourceId,
    snapshotId: value.snapshots[0].snapshotId,
    rawSha256: value.snapshots[0].rawSha256,
    protectedBy: ["ACTIVE_RELEASE"],
    legalHold: null,
  }];
  bindPurgeReport(value, attestPurgeReport(staleProtectionReport));

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /RAW_RETENTION_OVERDUE/,
  );

  const mismatchedProtectionReport = purgeReport(
    [],
    "2026-10-11T00:00:01.000Z",
    value.evaluationAt,
  );
  mismatchedProtectionReport.protected = [{
    sourceId: value.snapshots[0].sourceId,
    snapshotId: value.snapshots[0].snapshotId,
    rawSha256: "f".repeat(64),
    protectedBy: ["ACTIVE_RELEASE"],
    legalHold: null,
  }];
  bindPurgeReport(value, attestPurgeReport(mismatchedProtectionReport));

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /purge report protection raw hash/,
  );

  value.inventory.sources[0].datasetUrl = "https://example.invalid/unapproved-source-a";
  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /source inventory hash/,
  );
});

test("선택한 head만 freshness를 판정하고 만료된 이전 snapshot은 lineage로만 검증한다", () => {
  const value = input();
  const previous = {
    ...value.snapshots[0],
    snapshotId: "snapshot-a-1",
    retrievedAt: "2026-05-01T00:00:00Z",
    freshnessExpiresAt: "2026-05-31T00:00:00Z",
    previousSnapshotId: null,
    diffSummary: null,
  };
  const head = {
    ...value.snapshots[0],
    snapshotId: "snapshot-a-2",
    previousSnapshotId: previous.snapshotId,
    diffSummary: {
      status: "NO_CHANGE",
      rawHashChanged: false,
      schemaHashChanged: false,
      requestHashChanged: false,
      sourceUpdatedAtChanged: false,
      rowDelta: 0,
      coverageDelta: 0,
    },
  };
  value.snapshots = [previous, head];
  value.buildSpec.sourceSnapshotIds = [head.snapshotId];
  value.buildSpec.sourceSnapshots = value.buildSpec.sourceSnapshots.map((snapshot) => ({
    ...snapshot,
    snapshotId: head.snapshotId,
  }));
  value.buildSpec.sourceSnapshotSetHash = createHash("sha256")
    .update(JSON.stringify([head]))
    .digest("hex");

  const result = validateSourceSnapshotFreshness(value);

  assert.deepEqual(result.results.map((entry) => entry.snapshotId), [head.snapshotId]);
});

test("lineage head가 아닌 이전 snapshot을 release 대상으로 선택하면 거부한다", () => {
  const value = input();
  const previous = {
    ...value.snapshots[0],
    snapshotId: "snapshot-a-1",
    previousSnapshotId: null,
    diffSummary: null,
  };
  const head = {
    ...value.snapshots[0],
    snapshotId: "snapshot-a-2",
    retrievedAt: "2026-07-13T00:00:00Z",
    previousSnapshotId: previous.snapshotId,
    diffSummary: {
      status: "NO_CHANGE",
      rawHashChanged: false,
      schemaHashChanged: false,
      requestHashChanged: false,
      sourceUpdatedAtChanged: false,
      rowDelta: 0,
      coverageDelta: 0,
    },
  };
  value.snapshots = [previous, head];
  value.buildSpec.sourceSnapshotIds = [previous.snapshotId];
  value.buildSpec.sourceSnapshots = value.buildSpec.sourceSnapshots.map((snapshot) => ({
    ...snapshot,
    snapshotId: previous.snapshotId,
  }));
  value.buildSpec.sourceSnapshotSetHash = createHash("sha256")
    .update(JSON.stringify([previous]))
    .digest("hex");

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /SOURCE_LINEAGE_BROKEN: selected snapshot is not source head/,
  );
});

test("production 필수 source가 build snapshot에서 빠지면 governance GO를 거부한다", () => {
  const value = input();
  value.inventory = {
    sources: [
      { id: "source-a", requiredForProductionPack: true },
      { id: "source-b", requiredForProductionPack: true },
    ],
  };
  bindInventory(value);
  value.governancePolicy = {};
  value.governancePolicySha256 = "d".repeat(64);

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /SOURCE_FRESHNESS_POLICY_MISSING: required production source source-b/,
  );
});

test("실제 release build spec은 current source inventory에 결합되어 governance를 통과한다", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "tools/datapack/validate-source-snapshot-freshness.mjs",
    "--build-spec", "tools/datapack/release/candidate-build-spec.json",
    "--policy", "release/product-gates/datapack-freshness-sla.json",
    "--governance-policy", "tools/datapack/source-governance-policy.json",
    "--inventory", "tools/datapack/source-inventory.json",
    "--evaluation-at", "2026-07-28T19:00:00.000Z",
  ], { cwd: root });

  assert.equal(JSON.parse(stdout).governanceDecision, "GO");
});

test("실제 release hash evidence는 current source inventory와 build spec에 결합된다", async () => {
  const [inventory, buildSpec, hashEvidence] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/hash-evidence.json"), "utf8").then(JSON.parse),
  ]);
  const inventorySha256 = createHash("sha256")
    .update(JSON.stringify(inventory))
    .digest("hex");

  assert.equal(buildSpec.sourceInventorySha256, inventorySha256);
  assert.equal(hashEvidence.sourceInventorySha256.value, inventorySha256);
});

test("승인 allowlist 밖의 unbound snapshot은 build spec policy로 backfill할 수 없다", () => {
  const value = input();
  delete value.snapshots[0].governancePolicyVersion;
  delete value.snapshots[0].governancePolicySha256;
  value.buildSpec.sourceSnapshotSetHash = createHash("sha256")
    .update(JSON.stringify(value.snapshots))
    .digest("hex");
  value.governancePolicy = {};
  value.inventory = { sources: [] };
  bindInventory(value);
  value.governancePolicySha256 = "d".repeat(64);

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /SOURCE_FRESHNESS_POLICY_MISSING: governance policy binding/,
  );
});

test("승인 legacy snapshot ID를 재사용해도 exact evidence hash가 다르면 backfill할 수 없다", () => {
  const value = input({
    snapshotId: "kric-subway-timetable-line4-pilot-20260709",
  });
  delete value.snapshots[0].governancePolicyVersion;
  delete value.snapshots[0].governancePolicySha256;
  value.buildSpec.sourceSnapshotIds = [value.snapshots[0].snapshotId];
  value.buildSpec.sourceSnapshots[0].snapshotId = value.snapshots[0].snapshotId;
  value.buildSpec.sourceSnapshotSetHash = createHash("sha256")
    .update(JSON.stringify(value.snapshots))
    .digest("hex");
  value.governancePolicy = {};
  value.inventory = { sources: [] };
  bindInventory(value);
  value.governancePolicySha256 = "d".repeat(64);

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /SOURCE_FRESHNESS_POLICY_MISSING: governance policy binding/,
  );
});

test("governance 입력이 없으면 provenance의 governance binding도 선택 사항이다", () => {
  const value = input();
  delete value.snapshots[0].governancePolicyVersion;
  delete value.snapshots[0].governancePolicySha256;
  delete value.buildSpec.sourceSnapshots[0].governancePolicyVersion;
  delete value.buildSpec.sourceSnapshots[0].governancePolicySha256;
  value.buildSpec.sourceSnapshotSetHash = createHash("sha256")
    .update(JSON.stringify(value.snapshots))
    .digest("hex");

  assert.doesNotThrow(() => validateSourceSnapshotFreshness(value));
});

test("source snapshot evidence의 absolute relative-result를 거부한다", () => {
  assert.throws(
    () => assertRepositoryRelativePath("/other-drive/snapshots.json"),
    /must stay within the repository/,
  );
});

test("저장된 far-future expiry는 fail closed한다", () => {
  assert.throws(
    () => validateSourceSnapshotFreshness(input({ freshnessExpiresAt: "2099-08-01T00:00:00Z" })),
    /SOURCE_FRESHNESS_DERIVATION_MISMATCH/,
  );
});

test("build spec의 snapshot ID와 evidence가 다르면 fail closed한다", () => {
  const value = input();
  value.buildSpec.sourceSnapshotIds = ["snapshot-other"];

  assert.throws(() => validateSourceSnapshotFreshness(value), /source snapshot IDs/);
});

test("build provenance와 검증 evidence의 snapshot 내용이 다르면 fail closed한다", () => {
  const value = input();
  value.buildSpec.sourceSnapshots[0].rawObjectUri = "s3://bucket/other.json";

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /source snapshot provenance/,
  );
});

test("build admission schema hash가 actual snapshot evidence와 다르면 fail closed한다", () => {
  const value = input();
  value.buildSpec.sourceSnapshots[0].schemaFingerprint = "e".repeat(64);

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /source snapshot provenance/,
  );
});
