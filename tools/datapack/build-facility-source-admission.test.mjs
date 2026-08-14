import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
  buildFacilitySourceAdmission,
  canonicalFacilitySourceAdmissionJson,
  loadCurrentFacilitySourceAdmissionInput,
} from "./build-facility-source-admission.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FRESH_AT = "2026-08-14T15:34:07.000Z";

test("current FACILITY official source admission은 exact six-cell handoff를 만든다", async () => {
  const input = await currentInput();
  const before = structuredClone(input);
  const result = buildFacilitySourceAdmission(input);

  assert.deepEqual(input, before);
  assert.equal(result.decision, "GO");
  assert.equal(result.candidate.candidateId, "capital-pilot-candidate-20260814");
  assert.equal(result.queryPartition.summary.totalCount, 7);
  assert.equal(result.queryPartition.summary.partitionedQueryCount, 7);
  assert.equal(result.queryPartition.summary.joinedCount, 2);
  assert.equal(result.queryPartition.summary.outOfScopeCount, 5);
  assert.equal(result.queryPartition.summary.unmatchedCount, 0);
  assert.equal(result.queryPartition.summary.ambiguousCount, 0);
  assert.equal(result.queryPartition.summary.missingTargetCount, 0);
  assert.equal(result.inputEvidencePartition.summary.totalCount, 10);
  assert.equal(result.inputEvidencePartition.summary.joinedCount, 8);
  assert.equal(result.inputEvidencePartition.summary.outOfDomainCount, 2);
  assert.equal(result.inputEvidencePartition.summary.unmatchedCount, 0);
  assert.equal(result.inputEvidencePartition.summary.duplicateCount, 0);
  assert.equal(result.denominatorRows.length, 6);
  assert.deepEqual(result.denominatorStateSummary, {
    BLOCKED_WITH_EVIDENCE: 0,
    MISSING: 0,
    STALE: 0,
    UNKNOWN: 0,
    VERIFIED_ABSENT: 4,
    VERIFIED_PRESENT: 2,
  });
  assert.deepEqual(result.cellStateSummary, {
    ADMITTED_FACILITY_ABSENT: 0,
    ADMITTED_FACILITY_PRESENT: 2,
    BLOCKED_WITH_EVIDENCE: 0,
    MISSING: 0,
    STALE: 0,
    UNKNOWN: 0,
  });
  assert.equal(result.cells.length, 2);
  assert.equal(result.materializerEvidenceRows.length, 2);
  assert.ok(result.materializerEvidenceRows.every(({ state, domain, evidenceKind }) =>
    state === "VERIFIED_PRESENT" && domain === "FACILITY" && evidenceKind === "OBSERVED"));
  assert.notEqual(result.sourceIdentity.snapshotPayloadRawSha256, result.sourceIdentity.snapshotFileSha256);
  assert.notEqual(result.sourceIdentity.snapshotFileSha256, result.sourceIdentity.rawObjectSha256);
  assert.notEqual(result.sourceIdentity.snapshotPayloadRawSha256, result.sourceIdentity.rawObjectSha256);
  assert.match(canonicalFacilitySourceAdmissionJson(result), /"admissionDigest"/);
});

test("missing/non-exhaustive evidence와 stale admission은 partial handoff 없이 fail closed한다", async () => {
  const missing = await currentInput();
  missing.productionInput.accessibilityStatusEvidence =
    missing.productionInput.accessibilityStatusEvidence.filter((row) => !(
      row.stationId === "station-sangnoksu" && row.facilityType === "WHEELCHAIR_LIFT"
    ));
  const missingResult = buildFacilitySourceAdmission(missing);
  assert.equal(missingResult.decision, "NO_GO");
  assert.equal(missingResult.denominatorStateSummary.MISSING, 1);
  assert.deepEqual(missingResult.materializerEvidenceRows, []);

  const nonExhaustive = await currentInput();
  const source = sourceEntry(nonExhaustive);
  source.accessibilityAdmissionEvidence.absenceEvidenceMode = "NONE";
  assert.throws(
    () => buildFacilitySourceAdmission(nonExhaustive),
    /absence evidence mode mismatch/,
  );

  const stale = await currentInput("2026-08-14T20:06:04.805Z");
  const staleResult = buildFacilitySourceAdmission(stale);
  assert.equal(staleResult.decision, "NO_GO");
  assert.equal(staleResult.denominatorStateSummary.STALE, 6);
  assert.deepEqual(staleResult.materializerEvidenceRows, []);
});

test("three-way raw identity mismatch와 duplicate/unmapped evidence를 거부한다", async () => {
  const rawMismatch = await currentInput();
  sourceSnapshotEntry(rawMismatch).rawReceipt.snapshotRawSha256 = "0".repeat(64);
  assert.throws(
    () => buildFacilitySourceAdmission(rawMismatch),
    /raw receipt identity mismatch/,
  );

  const duplicate = await currentInput();
  duplicate.productionInput.facilityRows.push(structuredClone(duplicate.productionInput.facilityRows[0]));
  assert.throws(
    () => buildFacilitySourceAdmission(duplicate),
    /duplicate FACILITY evidence/,
  );

  const unmatched = await currentInput();
  unmatched.productionInput.accessibilityStatusEvidence.push({
    ...structuredClone(unmatched.productionInput.accessibilityStatusEvidence[0]),
    stationId: "station-unmapped",
  });
  const unmatchedResult = buildFacilitySourceAdmission(unmatched);
  assert.equal(unmatchedResult.decision, "NO_GO");
  assert.equal(unmatchedResult.inputEvidencePartition.summary.unmatchedCount, 1);
  assert.deepEqual(unmatchedResult.materializerEvidenceRows, []);

  const schemaDrift = await currentInput();
  const ledger = sourceSnapshotEntry(schemaDrift);
  const candidateMember = schemaDrift.candidateBuildSpec.sourceSnapshots.find(({ snapshotId }) =>
    snapshotId === ledger.snapshotId);
  ledger.schemaFingerprint = "drifted-schema";
  candidateMember.schemaFingerprint = "drifted-schema";
  schemaDrift.candidateBuildSpec.sourceSnapshotSetHash = sha256(JSON.stringify(
    schemaDrift.candidateBuildSpec.sourceSnapshotIds.map((snapshotId) =>
      schemaDrift.sourceSnapshots.find((entry) => entry.snapshotId === snapshotId)),
  ));
  assert.throws(
    () => buildFacilitySourceAdmission(schemaDrift),
    /schema fingerprint mismatch/,
  );

  const emptyScope = await currentInput();
  emptyScope.productionInput.supportedV1Scope.includedStationIds = [];
  emptyScope.productionInput.supportedV1Scope.facilityCoverageDenominator.expectedRows = 0;
  emptyScope.productionInput.facilityRows = [];
  emptyScope.productionInput.accessibilityStatusEvidence = [];
  assert.throws(
    () => buildFacilitySourceAdmission(emptyScope),
    /current scope cardinality mismatch/,
  );

  const duplicateMapping = await currentInput();
  const sangnoksu = duplicateMapping.productionInput.stationMappings.find((row) =>
    row.stationId === "station-sangnoksu" && row.sourceId === "molit-urban-rail-full-route");
  const sadang = duplicateMapping.productionInput.stationMappings.find((row) =>
    row.stationId === "station-sadang" && row.sourceId === "molit-urban-rail-full-route");
  sadang.sourceStationCode = sangnoksu.sourceStationCode;
  assert.throws(
    () => buildFacilitySourceAdmission(duplicateMapping),
    /source mapping tuple is ambiguous/,
  );
});

test("consumer input order가 달라도 admission bytes와 caller input은 동일하다", async () => {
  const firstInput = await currentInput();
  const secondInput = structuredClone(firstInput);
  secondInput.productionInput.facilityRows.reverse();
  secondInput.productionInput.accessibilityStatusEvidence.reverse();
  secondInput.productionInput.stationMappings.reverse();
  secondInput.productionInput.stationLineRows.reverse();
  const secondBefore = structuredClone(secondInput);

  const first = canonicalFacilitySourceAdmissionJson(buildFacilitySourceAdmission(firstInput));
  const second = canonicalFacilitySourceAdmissionJson(buildFacilitySourceAdmission(secondInput));

  assert.equal(second, first);
  assert.deepEqual(secondInput, secondBefore);
});

async function currentInput(observedAt = FRESH_AT) {
  return loadCurrentFacilitySourceAdmissionInput({ repositoryRoot: root, observedAt });
}

function sourceEntry(input) {
  return input.sourceInventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
}

function sourceSnapshotEntry(input) {
  return input.sourceSnapshots.find(({ snapshotId }) =>
    snapshotId === "kric-station-convenience-standard-20260813T200604805Z");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
