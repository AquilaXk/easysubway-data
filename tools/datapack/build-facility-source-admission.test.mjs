import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFacilitySourceAdmission,
  canonicalFacilitySourceAdmissionJson,
  loadCurrentFacilitySourceAdmissionInput,
} from "./build-facility-source-admission.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FRESH_AT = await selectedSourceEvaluationAt();

test("current FACILITY official source admission은 exact six-cell handoff를 만든다", async () => {
  const input = await historicalFacilityFixtureInput();
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

test("current mixed accessibility evidence는 legacy FACILITY builder에서 fail-closed다", async () => {
  const input = await loadCurrentFacilitySourceAdmissionInput({ repositoryRoot: root, observedAt: FRESH_AT });
  assert.throws(() => buildFacilitySourceAdmission(input), /FACILITY absence evidence mode mismatch/);
});

test("historical FACILITY fixture는 변경된 inventory bytes에 candidate 결속을 갱신한다", async () => {
  const input = await historicalFacilityFixtureInput();
  const inventoryBytes = Buffer.from(JSON.stringify(input.sourceInventory));

  assert.equal(input.candidateBuildSpec.sourceInventorySha256, sha256(inventoryBytes));
  assert.equal(input.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256, sha256(inventoryBytes));
});

test("historical FACILITY fixture는 selected snapshot을 append-only ledger 순서로 결속한다", async () => {
  const input = await historicalFacilityFixtureInput();
  const selectedIds = new Set(input.candidateBuildSpec.sourceSnapshotIds);
  const selectedInLedgerOrder = input.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  input.candidateBuildSpec.sourceSnapshotIds.reverse();

  assert.equal(selectedSourceSnapshotSetHash(input), sha256(JSON.stringify(selectedInLedgerOrder)));
});

test("missing/non-exhaustive evidence와 stale admission은 partial handoff 없이 fail closed한다", async () => {
  const missing = await historicalFacilityFixtureInput();
  missing.productionInput.accessibilityStatusEvidence =
    missing.productionInput.accessibilityStatusEvidence.filter((row) => !(
      row.stationId === "station-sangnoksu" && row.facilityType === "WHEELCHAIR_LIFT"
    ));
  const missingResult = buildFacilitySourceAdmission(missing);
  assert.equal(missingResult.decision, "NO_GO");
  assert.equal(missingResult.denominatorStateSummary.MISSING, 1);
  assert.deepEqual(missingResult.materializerEvidenceRows, []);

  const nonExhaustive = await historicalFacilityFixtureInput();
  const source = sourceEntry(nonExhaustive);
  source.accessibilityAdmissionEvidence.absenceEvidenceMode = "NONE";
  assert.throws(
    () => buildFacilitySourceAdmission(nonExhaustive),
    /absence evidence mode mismatch/,
  );

  const fresh = await historicalFacilityFixtureInput();
  const stale = await historicalFacilityFixtureInput(new Date(
    Date.parse(sourceEntry(fresh).accessibilityAdmissionEvidence.freshUntil) + 1,
  ).toISOString());
  const staleResult = buildFacilitySourceAdmission(stale);
  assert.equal(staleResult.decision, "NO_GO");
  assert.equal(staleResult.denominatorStateSummary.STALE, 6);
  assert.deepEqual(staleResult.materializerEvidenceRows, []);
});

test("three-way raw identity mismatch와 duplicate/unmapped evidence를 거부한다", async () => {
  const rawMismatch = await historicalFacilityFixtureInput();
  sourceSnapshotEntry(rawMismatch).rawReceipt.snapshotRawSha256 = "0".repeat(64);
  assert.throws(
    () => buildFacilitySourceAdmission(rawMismatch),
    /raw receipt identity mismatch/,
  );

  const duplicate = await historicalFacilityFixtureInput();
  duplicate.productionInput.facilityRows.push(structuredClone(duplicate.productionInput.facilityRows[0]));
  assert.throws(
    () => buildFacilitySourceAdmission(duplicate),
    /duplicate FACILITY evidence/,
  );

  const unmatched = await historicalFacilityFixtureInput();
  unmatched.productionInput.accessibilityStatusEvidence.push({
    ...structuredClone(unmatched.productionInput.accessibilityStatusEvidence[0]),
    stationId: "station-unmapped",
  });
  const unmatchedResult = buildFacilitySourceAdmission(unmatched);
  assert.equal(unmatchedResult.decision, "NO_GO");
  assert.equal(unmatchedResult.inputEvidencePartition.summary.unmatchedCount, 1);
  assert.deepEqual(unmatchedResult.materializerEvidenceRows, []);

  const schemaDrift = await historicalFacilityFixtureInput();
  const ledger = sourceSnapshotEntry(schemaDrift);
  const candidateMember = schemaDrift.candidateBuildSpec.sourceSnapshots.find(({ snapshotId }) =>
    snapshotId === ledger.snapshotId);
  ledger.schemaFingerprint = "drifted-schema";
  candidateMember.schemaFingerprint = "drifted-schema";
  schemaDrift.candidateBuildSpec.sourceSnapshotSetHash = selectedSourceSnapshotSetHash(schemaDrift);
  assert.throws(
    () => buildFacilitySourceAdmission(schemaDrift),
    /schema fingerprint mismatch/,
  );

  const emptyScope = await historicalFacilityFixtureInput();
  emptyScope.productionInput.supportedV1Scope.includedStationIds = [];
  emptyScope.productionInput.supportedV1Scope.facilityCoverageDenominator.expectedRows = 0;
  emptyScope.productionInput.facilityRows = [];
  emptyScope.productionInput.accessibilityStatusEvidence = [];
  assert.throws(
    () => buildFacilitySourceAdmission(emptyScope),
    /current scope cardinality mismatch/,
  );

  const duplicateMapping = await historicalFacilityFixtureInput();
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

test("FACILITY admission은 pilot의 2개 station-line 가정 없이 injected multi-line scope shape를 보존한다", async () => {
  const input = await historicalFacilityFixtureInput();
  const extraLineId = "seoul-2";
  const extraLine = { ...structuredClone(input.productionInput.lines.find(({ id }) => id === "seoul-4")), id: extraLineId, nameKo: "수도권 2호선" };
  const sourceMapping = structuredClone(input.productionInput.stationMappings.find(({ stationId }) => stationId === "station-sangnoksu"));
  const sourceRow = structuredClone(input.productionInput.stationLineRows.find((row) =>
    row.sourceId === sourceMapping.sourceId && row.sourceStationCode === sourceMapping.sourceStationCode && row.lineId === sourceMapping.lineId));
  const extraMapping = { ...sourceMapping, lineId: extraLineId, stationLineId: `station-sangnoksu:${extraLineId}` };
  const extraRow = { ...sourceRow, lineId: extraLineId };
  input.productionInput.lines.push(extraLine);
  input.productionInput.stationMappings.push(extraMapping);
  input.productionInput.stationLineRows.push(extraRow);
  input.productionInput.supportedV1Scope.includedLineIds.push(extraLineId);
  input.productionInput.supportedV1Scope.facilityCoverageDenominator.expectedRows = 9;

  const result = buildFacilitySourceAdmission(input);
  assert.equal(result.decision, "NO_GO");
  assert.equal(result.queryPartition.summary.missingTargetCount, 1);
  assert.equal(result.denominatorRows.length, 9);
});

test("FACILITY admission은 scope에 선언만 된 unused operator를 거부한다", async () => {
  const input = await historicalFacilityFixtureInput();
  input.productionInput.supportedV1Scope.includedOperatorIds.push("operator-unused");
  input.productionInput.operators.push({ id: "operator-unused", nameKo: "미사용 운영사" });
  assert.throws(() => buildFacilitySourceAdmission(input), /current scope cardinality mismatch/);
});

test("FACILITY source license/admission evidence revoke와 hash drift를 provider call 전에 거부한다", async () => {
  const revoked = await historicalFacilityFixtureInput();
  sourceEntry(revoked).license.commercialUseAllowed = false;
  assert.throws(() => buildFacilitySourceAdmission(revoked), /FACILITY source production admission mismatch/);

  const hashDrift = await historicalFacilityFixtureInput();
  sourceEntry(hashDrift).admissionEvidence.licenseEvidenceHash = "0".repeat(64);
  assert.throws(() => buildFacilitySourceAdmission(hashDrift), /FACILITY source approval or license mismatch/);
});

test("등록된 current snapshot path만 resolver가 읽고 stale/pilot path mismatch는 admission 전에 거부한다", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "easysubway-facility-current-path-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "tools/datapack");
  const tempDatapack = path.join(temporary, "tools/datapack");
  const fixture = await historicalFacilityFixtureInput();
  await Promise.all([
    mkdir(path.join(tempDatapack, "release"), { recursive: true }),
    mkdir(path.join(tempDatapack, "inputs"), { recursive: true }),
    mkdir(path.join(tempDatapack, "sources"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(tempDatapack, "release/candidate-build-spec.json"), JSON.stringify(fixture.candidateBuildSpec)),
    writeFile(path.join(tempDatapack, "release/source-snapshots.json"), JSON.stringify(fixture.sourceSnapshots)),
    writeFile(path.join(tempDatapack, "inputs/capital-pilot-production-source-input.json"), JSON.stringify(fixture.productionInput)),
  ]);
  const inventory = fixture.sourceInventory;
  const source = inventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
  source.accessibilityAdmissionEvidence.snapshotPath = "tools\\datapack\\sources\\current.json";
  await writeFile(path.join(tempDatapack, "source-inventory.json"), JSON.stringify(inventory));
  const currentSnapshot = path.join(root, fixture.snapshotPath);
  await copyFile(currentSnapshot, path.join(tempDatapack, "sources/current.json"));

  const resolved = await loadCurrentFacilitySourceAdmissionInput({ repositoryRoot: temporary, observedAt: fixture.observedAt });
  assert.equal(resolved.snapshotPath, "tools/datapack/sources/current.json");
  assert.deepEqual(Buffer.from(resolved.snapshotBytes), await readFile(path.join(tempDatapack, "sources/current.json")));
  assert.equal(buildFacilitySourceAdmission(resolved).decision, "GO");

  source.accessibilityAdmissionEvidence.snapshotPath = "tools/datapack/sources/pilot.json";
  await writeFile(path.join(tempDatapack, "source-inventory.json"), JSON.stringify(inventory));
  await copyFile(path.join(sourceRoot, "sources/kric-station-convenience-standard-20260728.json"), path.join(tempDatapack, "sources/pilot.json"));
  const stale = await loadCurrentFacilitySourceAdmissionInput({ repositoryRoot: temporary, observedAt: fixture.observedAt });
  assert.throws(() => buildFacilitySourceAdmission(stale), /KRIC accessibility snapshot identity is invalid|snapshot admission identity mismatch/);

  source.accessibilityAdmissionEvidence.snapshotPath = "tools/datapack/sources/current.json";
  await writeFile(path.join(tempDatapack, "source-inventory.json"), JSON.stringify(inventory));
  const outside = await mkdtemp(path.join(tmpdir(), "easysubway-facility-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await copyFile(currentSnapshot, path.join(outside, "current.json"));
  await rm(path.join(tempDatapack, "sources"), { recursive: true, force: true });
  await symlink(outside, path.join(tempDatapack, "sources"));
  await assert.rejects(
    loadCurrentFacilitySourceAdmissionInput({ repositoryRoot: temporary, observedAt: fixture.observedAt }),
    /registered snapshot path escapes repository/,
  );
});

test("consumer input order가 달라도 admission bytes와 caller input은 동일하다", async () => {
  const firstInput = await historicalFacilityFixtureInput();
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

async function historicalFacilityFixtureInput(observedAt) {
  const [input, historicalAdmission] = await Promise.all([
    loadCurrentFacilitySourceAdmissionInput({ repositoryRoot: root, observedAt: FRESH_AT }),
    readFile(path.join(root, "tools/datapack/release/facility-source-admission.json"), "utf8").then(JSON.parse),
  ]);
  const historicalSnapshotPath = "tools/datapack/sources/kric-station-convenience-standard-20260813T200604805Z.json";
  const historicalSnapshotBytes = await readFile(path.join(root, historicalSnapshotPath));
  const historicalSnapshot = JSON.parse(historicalSnapshotBytes);
  const historicalMembershipAt = historicalAdmission.observedAt;
  const historicalObservedAt = observedAt ?? historicalMembershipAt;
  if (observedAt == null) {
    assert.ok(Date.parse(historicalSnapshot.capturedAt) < Date.parse(historicalObservedAt));
    assert.ok(Date.parse(historicalObservedAt) < Date.parse(historicalSnapshot.freshUntil));
  }
  const historicalSourceIds = input.candidateBuildSpec.sourceSnapshots
    .map(({ sourceId }) => sourceId)
    .filter((sourceId) => sourceId !== "seoul-metro-transfer-distance-duration");
  assert.equal(historicalSourceIds.length, 6, "historical FACILITY source count");
  assert.equal(new Set(historicalSourceIds).size, historicalSourceIds.length, "historical FACILITY source identities");
  const historicalLedgerHeads = historicalSourceIds.map((sourceId) => {
    const entries = input.sourceSnapshots.filter((entry) =>
      entry.sourceId === sourceId && snapshotEvidenceAt(entry) <= Date.parse(historicalMembershipAt));
    assert.ok(entries.length > 0, `historical ${sourceId} ledger head`);
    return entries.at(-1);
  });
  const historicalKricLedger = historicalLedgerHeads.find(({ sourceId }) =>
    sourceId === "kric-station-convenience-standard");
  assert.equal(historicalKricLedger?.snapshotId, historicalSnapshot.snapshotId, "historical KRIC ledger head");
  const historicalSnapshotIds = new Set(historicalLedgerHeads.map(({ snapshotId }) => snapshotId));
  const historicalLedgerOrder = input.sourceSnapshots.filter(({ snapshotId }) => historicalSnapshotIds.has(snapshotId));
  assert.deepEqual(historicalLedgerOrder.map(({ sourceId }) => sourceId), historicalSourceIds);
  const historicalSourceSetSha256 = sha256(JSON.stringify(historicalLedgerOrder));
  assert.equal(historicalSourceSetSha256, historicalAdmission.candidate.sourceSetSha256);
  const source = sourceEntry(input);
  Object.assign(source.accessibilityAdmissionEvidence, {
    snapshotId: historicalSnapshot.snapshotId,
    snapshotPath: historicalSnapshotPath,
    capturedAt: historicalSnapshot.capturedAt,
    observedAt: historicalSnapshot.observedAt,
    freshUntil: historicalSnapshot.freshUntil,
    rawSha256: historicalSnapshot.rawSha256,
    contentSha256: historicalSnapshot.contentSha256,
    schemaFingerprint: historicalSnapshot.schemaFingerprint,
    snapshotFileSha256: sha256(historicalSnapshotBytes),
    absenceEvidenceMode: "EXHAUSTIVE_LIST",
  });
  input.snapshotPath = historicalSnapshotPath;
  input.snapshotBytes = new Uint8Array(historicalSnapshotBytes);
  input.observedAt = historicalObservedAt;
  const currentProjectionsBySourceId = new Map(input.candidateBuildSpec.sourceSnapshots.map((projection) =>
    [projection.sourceId, projection]));
  input.candidateBuildSpec.sourceSnapshots = historicalLedgerHeads.map((entry) => {
    const projection = currentProjectionsBySourceId.get(entry.sourceId);
    assert.ok(projection, `current ${entry.sourceId} projection`);
    return Object.fromEntries(Object.keys(projection).flatMap((key) =>
      entry[key] === undefined ? [] : [[key, entry[key]]]));
  });
  input.candidateBuildSpec.sourceSnapshotIds = historicalLedgerHeads.map(({ snapshotId }) => snapshotId);
  input.candidateBuildSpec.sourceSnapshotSetHash = historicalSourceSetSha256;
  const inventoryBytes = Buffer.from(JSON.stringify(input.sourceInventory));
  input.candidateBuildSpec.sourceInventorySha256 = sha256(inventoryBytes);
  input.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha256(inventoryBytes);
  return input;
}

function selectedSourceSnapshotSetHash(input) {
  const selectedIds = new Set(input.candidateBuildSpec.sourceSnapshotIds);
  return sha256(JSON.stringify(
    input.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId)),
  ));
}

function snapshotEvidenceAt(entry) {
  return Math.max(...[
    entry.retrievedAt, entry.sourceUpdatedAt, entry.capturedAt, entry.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse));
}

function sourceEntry(input) {
  return input.sourceInventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
}

function sourceSnapshotEntry(input) {
  const snapshotId = input.candidateBuildSpec.sourceSnapshots
    .find(({ sourceId }) => sourceId === "kric-station-convenience-standard")?.snapshotId;
  return input.sourceSnapshots.find((entry) => entry.snapshotId === snapshotId);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function selectedSourceEvaluationAt() {
  const [buildSpec, sourceSnapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const selected = buildSpec.sourceSnapshotIds.map((snapshotId) => {
    const matches = sourceSnapshots.filter((entry) => entry.snapshotId === snapshotId);
    assert.equal(matches.length, 1, `selected source snapshot identity: ${snapshotId}`);
    return matches[0];
  });
  const basisAt = Math.max(...selected.flatMap((entry) => [
    entry.retrievedAt, entry.sourceUpdatedAt, entry.capturedAt, entry.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)));
  const freshUntil = Math.min(...selected.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)));
  assert.ok(Number.isFinite(basisAt) && Number.isFinite(freshUntil) && basisAt + 1_000 < freshUntil);
  return new Date(basisAt + 1_000).toISOString();
}
