import assert from "node:assert/strict";
import test from "node:test";

import { buildCurrentCapitalStationLineInput } from "./build-current-capital-station-line-input.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import {
  buildCurrentCapitalStationLineInputFixture,
  fixtureCanonicalJson as canonical,
  fixtureSha256 as sha,
  FIXTURE_PUBLISHED_AT,
  FIXTURE_RETENTION_UNTIL,
  resealFixtureFacilityAdmission as resealFacility,
} from "./test-fixtures/current-capital-station-line-input.mjs";

test("full-capital FACILITY·EXIT·TRANSFER fan-in은 station-line exact-set input을 만든다", async () => {
  const input = await buildCurrentCapitalStationLineInputFixture();
  const result = buildCurrentCapitalStationLineInput(input);
  assert.deepEqual(Object.keys(result).sort(), ["candidate", "evidenceRows", "stationLines"]);
  assert.equal(result.candidate.sourceSetSha256, input.sourceSetTransition.currentCandidateSourceSetSha256);
  assert.notEqual(result.candidate.sourceSetSha256, input.sourceSetTransition.evidenceSourceSetSha256);
  const stationLineKeys = new Set(result.stationLines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  for (const domain of ["FACILITY", "EXIT", "TRANSFER"]) {
    assert.deepEqual(new Set(result.evidenceRows.filter((row) => row.domain === domain).map(({ stationId, lineId }) => `${stationId}\0${lineId}`)), stationLineKeys);
  }
  const materialization = materializeStationLineAccessibility({ ...result, observedAt: FIXTURE_PUBLISHED_AT });
  const expectedMaterializationKeys = new Set(result.stationLines.flatMap(({ stationId, lineId }) =>
    ["FACILITY", "EXIT", "TRANSFER"].map((domain) => `${stationId}\0${lineId}\0${domain}`)));
  const actualMaterializationKeys = new Set(materialization.rows.map(({ stationId, lineId, domain }) => `${stationId}\0${lineId}\0${domain}`));
  assert.deepEqual(actualMaterializationKeys, expectedMaterializationKeys);
  assert.equal(materialization.rows.length, expectedMaterializationKeys.size);
  assert.ok(materialization.rows.some(({ state, domain }) => state === "UNVERIFIED_EVIDENCE_BLOCKED" && domain === "EXIT"));
  assert.equal(materialization.stateSummary.MISSING, 0);
  assert.equal(materialization.stateSummary.STALE, 0);
  assert.equal(materialization.stateSummary.UNKNOWN, 0);
});

test("FACILITY snapshot timestamp identity와 candidate freshness는 strict하게 bind한다", async () => {
  for (const [field, mutate] of [
    ["capturedAt", (snapshot) => rebindSnapshotClock(snapshot, FIXTURE_PUBLISHED_AT)],
    ["observedAt", (snapshot) => rebindSnapshotClock(snapshot, FIXTURE_PUBLISHED_AT)],
    ["freshUntil", (snapshot) => { snapshot.freshUntil = FIXTURE_RETENTION_UNTIL; }],
  ]) {
    const timestampDrift = await buildCurrentCapitalStationLineInputFixture();
    const snapshot = JSON.parse(timestampDrift.facilitySnapshotBytes.toString("utf8"));
    mutate(snapshot);
    timestampDrift.facilitySnapshotBytes = Buffer.from(JSON.stringify(snapshot));
    assert.throws(() => buildCurrentCapitalStationLineInput(timestampDrift), new RegExp(`FACILITY snapshot binding mismatch`, "u"), field);
  }

  const staleAtCandidate = await buildCurrentCapitalStationLineInputFixture();
  staleAtCandidate.candidateBuildSpec.publishedAt = staleAtCandidate.facilityAdmission.sourceIdentity.freshUntil;
  assert.throws(() => buildCurrentCapitalStationLineInput(staleAtCandidate), /FACILITY freshness mismatch/);
});

function rebindSnapshotClock(snapshot, capturedAt) {
  snapshot.capturedAt = capturedAt;
  snapshot.observedAt = capturedAt;
  snapshot.snapshotId = `${snapshot.sourceId}-${capturedAt.replaceAll(/[-:.]/g, "")}`;
}

test("canonical capital pack이 전국 superset이어도 admitted scope만 선택한다", async () => {
  const input = await buildCurrentCapitalStationLineInputFixture();
  const pack = input.canonicalPack.packs[0];
  pack.lines.push({ id: "regional-line", operatorId: "regional-operator" });
  pack.stationLines.push({ stationId: "regional-station", lineId: "regional-line", lineSequence: 0 });

  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.stationLines.length, input.facilityAdmission.cells.length);
  assert.equal(result.stationLines.some(({ stationId }) => stationId === "regional-station"), false);
  assert.ok(result.evidenceRows.length >= result.stationLines.length * 3);
});

test("admitted target missing·duplicate·operator drift는 superset selection 전에 fail-closed다", async () => {
  for (const mutate of [
    (value) => { value.canonicalPack.packs[0].stationLines.shift(); },
    (value) => { value.canonicalPack.packs[0].stationLines.push(structuredClone(value.canonicalPack.packs[0].stationLines[0])); },
    (value) => { const admittedLineId = value.facilityAdmission.cells[0].lineId; value.canonicalPack.packs[0].lines.find(({ id }) => id === admittedLineId).operatorId = "other-operator"; },
    (value) => { value.canonicalPack.packs[0].lines.push(structuredClone(value.canonicalPack.packs[0].lines[0])); },
    (value) => {
      value.facilityAdmission.cells[1] = structuredClone(value.facilityAdmission.cells[0]);
      resealFacility(value.facilityAdmission);
    },
  ]) {
    const value = await buildCurrentCapitalStationLineInputFixture(); mutate(value);
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /full-capital|selection|selector|denominator/i);
  }
});

test("candidate transfer source is independent of exact ledger order", async () => {
  const input = await buildCurrentCapitalStationLineInputFixture();
  const transferLedger = input.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration");
  input.sourceSnapshots = [transferLedger, ...input.sourceSnapshots.filter(({ snapshotId }) => snapshotId !== transferLedger.snapshotId)];
  const sourceSet = sha(JSON.stringify(input.sourceSnapshots));
  const transferProjection = input.candidateBuildSpec.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration");
  const predecessorIds = new Set(input.candidateBuildSpec.sourceSnapshotIds.filter((snapshotId) => snapshotId !== transferProjection.snapshotId));
  const evidenceSourceSet = sha(JSON.stringify(input.sourceSnapshots.filter(({ snapshotId }) => predecessorIds.has(snapshotId))));
  input.candidateBuildSpec.sourceSnapshotSetHash = sourceSet;
  input.sourceSetTransition.currentCandidateSourceSetSha256 = sourceSet;
  input.sourceSetTransition.evidenceSourceSetSha256 = evidenceSourceSet;
  input.facilityAdmission.candidate.sourceSnapshotSetHash = sourceSet;
  resealFacility(input.facilityAdmission);
  input.exitAdmission.candidate.sourceSetSha256 = evidenceSourceSet;
  input.exitAdmission.materializerEvidenceRows = input.exitAdmission.materializerEvidenceRows.map((row) => ({ ...row, sourceSetSha256: evidenceSourceSet }));
  rebindExitArtifacts(input);

  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.candidate.sourceSetSha256, sourceSet);
  assert.equal(transferProjection.sourceId, "seoul-metro-transfer-distance-duration");
  assert.equal(result.stationLines.length, input.facilityAdmission.cells.length);
  assert.ok(result.evidenceRows.length >= result.stationLines.length * 3);
});

test("current capital candidate는 inventory-bound source roster만 허용한다", async () => {
  const input = await buildCurrentCapitalStationLineInputFixture();
  assert.deepEqual(new Set(input.candidateBuildSpec.sourceSnapshots.map(({ sourceId }) => sourceId)), new Set(input.sourceInventory.sources.filter(({ requiredForProductionPack }) => requiredForProductionPack).map(({ id }) => id)));
  for (const mutate of [
    (value) => { removeCandidateSource(value, "kric-subway-timetable"); },
    (value) => { swapCandidateProjections(value, "seoul-metro-route-map-positions", "kric-subway-timetable"); },
    (value) => { candidateProjection(value, "seoul-metro-route-map-positions").snapshotId = "projection-drift"; },
    (value) => { value.candidateBuildSpec.sourceSnapshots.push({ sourceId: "extra-source", snapshotId: "extra-snapshot" }); value.candidateBuildSpec.sourceSnapshotIds.push("extra-snapshot"); },
  ]) {
    const value = await buildCurrentCapitalStationLineInputFixture(); mutate(value);
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /candidate source snapshot|projection|inventory|source-set/i);
  }
});

test("candidate inventory semantic hash와 authenticated raw-byte hash를 분리 검증한다", async () => {
  const input = await buildCurrentCapitalStationLineInputFixture();
  input.sourceInventoryBytes = Buffer.from(`${JSON.stringify(input.sourceInventory, null, 2)}\n`);
  input.candidateBuildSpec.sourceInventorySha256 = sha(JSON.stringify(input.sourceInventory));
  input.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha(input.sourceInventoryBytes);

  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.stationLines.length, input.facilityAdmission.cells.length);
  assert.ok(result.evidenceRows.length >= result.stationLines.length * 3);
});

test("public static-network V2 transition은 Seoul accessibility의 evidence predecessor semantics를 유지한다", async () => {
  const input = await publicStaticV2Fixture();
  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.candidate.sourceSetSha256, input.sourceSetTransition.currentCandidateSourceSetSha256);
  assert.notEqual(result.candidate.sourceSetSha256, input.sourceSetTransition.evidenceSourceSetSha256);
  assert.ok(result.evidenceRows.length >= result.stationLines.length * 3);
});

test("public static-network V2 두 head는 first-seven predecessor/evidence seven만 허용한다", async () => {
  const input = await publicStaticV2Fixture();

  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.candidate.sourceSetSha256, input.sourceSetTransition.currentCandidateSourceSetSha256);
  assert.ok(result.evidenceRows.length >= result.stationLines.length * 3);
  for (const mutate of [
    (value) => { value.sourceSnapshots.find(({ snapshotId }) => snapshotId === "positions-current").projectionMigration = { migrationKind: "legacy" }; },
    (value) => { value.sourceSnapshots.find(({ snapshotId }) => snapshotId === "molit-current").previousSnapshotId = "positions-old"; },
    (value) => { candidateProjection(value, "seoul-metro-route-map-positions").sourceId = "molit-urban-rail-full-route"; },
  ]) {
    const value = await publicStaticV2Fixture(); mutate(value);
    const selectedIds = new Set(value.candidateBuildSpec.sourceSnapshotIds);
    const selected = value.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
    value.candidateBuildSpec.sourceSnapshotSetHash = sha(JSON.stringify(selected));
    value.sourceSetTransition.currentCandidateSourceSetSha256 = value.candidateBuildSpec.sourceSnapshotSetHash;
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /candidate projection|public v2|source identity|eighth projection/i);
  }
});

test("blocked tuple·receipt·TRANSFER admission drift는 output 없이 fail-closed다", async () => {
  for (const mutate of [
    (value) => { value.facilityAdmission.cells.find(({ state }) => state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED").state = "ADMITTED_FACILITY_PRESENT"; resealFacility(value.facilityAdmission); },
    (value) => { value.exitReceipt.admissionDigest = "0".repeat(64); resealReceipt(value.exitReceipt); },
    (value) => { value.transferMetrics.metrics[0].durationRole = "RUNTIME"; },
    (value) => { value.transferApplicability.cells.pop(); resealApplicability(value.transferApplicability); },
    (value) => { value.candidateBuildSpec.sourceSnapshots.pop(); },
    (value) => { value.candidateBuildSpec.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration").rawSha256 = "0".repeat(64); },
    (value) => { value.candidateBuildSpec.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration").extra = true; },
    (value) => { value.sourceInventoryBytes = Buffer.concat([value.sourceInventoryBytes, Buffer.from(" ")]); },
    (value) => { value.sourceSetTransition.currentCandidateSourceSetSha256 = "0".repeat(64); },
    (value) => { value.sourceSetTransition.evidenceSourceSetSha256 = value.sourceSetTransition.currentCandidateSourceSetSha256; },
    (value) => { value.sourceSetTransition.evidenceSourceSetSha256 = "0".repeat(64); },
    (value) => { value.exitAdmission.materializerEvidenceRows.find(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED").sourceId = "wrong-source"; rebindExitArtifacts(value); },
    (value) => { value.exitAdmission.materializerEvidenceRows.find(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED").evidenceHash = "0".repeat(64); rebindExitArtifacts(value); },
  ]) {
    const value = await buildCurrentCapitalStationLineInputFixture(); mutate(value);
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /full-capital|mismatch|denominator|blocked/i);
  }
});

test("TRANSFER admission은 허용된 provenance가 전체 metric을 소진해야 한다", async () => {
  const value = await buildCurrentCapitalStationLineInputFixture();
  value.transferMetrics.metrics[0].metricProvenance = "UNKNOWN_PROVENANCE";
  const admission = value.sourceInventory.sources
    .find(({ id }) => id === "seoul-metro-transfer-distance-duration")
    .transferAdmissionEvidence;
  admission.officialMetricCount = value.transferMetrics.metrics
    .filter(({ metricProvenance }) => metricProvenance === "OFFICIAL_SOURCE").length;
  admission.derivedReciprocalMetricCount = value.transferMetrics.metrics
    .filter(({ metricProvenance }) => metricProvenance === "DERIVED_RECIPROCAL").length;
  rebindTransferArtifacts(value);

  assert.throws(
    () => buildCurrentCapitalStationLineInput(value),
    /full-capital TRANSFER metrics mismatch/,
  );
});

test("count를 유지한 blocked carrier·directed pair·applicability swap drift도 fail-closed다", async () => {
  for (const mutate of [
    (value) => {
      const blocked = value.facilityAdmission.cells.find(({ state }) => state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED");
      const blockedRows = value.facilityAdmission.denominatorRows.filter((row) => row.stationId === blocked.stationId && row.lineId === blocked.lineId);
      blockedRows.find(({ facilityType }) => facilityType === "ESCALATOR").facilityType = "ELEVATOR";
      resealFacility(value.facilityAdmission);
    },
    (value) => {
      value.transferMetrics.metrics[0].toLineId = value.transferMetrics.metrics[0].fromLineId;
      rebindTransferArtifacts(value);
    },
    (value) => {
      const applicable = value.transferApplicability.cells.find(({ state }) => state === "APPLICABLE_TRANSFER_ENDPOINT");
      const notApplicable = value.transferApplicability.cells.find(({ state }) => state === "NOT_APPLICABLE_IN_CANONICAL_PAIR_SET");
      applicable.state = "NOT_APPLICABLE_IN_CANONICAL_PAIR_SET";
      notApplicable.state = "APPLICABLE_TRANSFER_ENDPOINT";
      rebindTransferArtifacts(value);
    },
  ]) {
    const value = await buildCurrentCapitalStationLineInputFixture(); mutate(value);
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /full-capital|mismatch|blocked/i);
  }
});

async function publicStaticV2Fixture() {
  const input = await buildCurrentCapitalStationLineInputFixture();
  const positionsOld = previousSourceSnapshot(input, "seoul-metro-route-map-positions");
  const molitOld = previousSourceSnapshot(input, "molit-urban-rail-full-route");
  const seoulOld = previousSourceSnapshot(input, "seoul-metro-accessibility");
  const v2Head = (previous, snapshotId) => ({
    ...structuredClone(previous),
    snapshotId,
    previousSnapshotId: previous.snapshotId,
    publicStaticNetworkV2Observation: {
      schemaVersion: 2,
      artifactKind: "public-static-network-v2-observation",
      sourceId: previous.sourceId,
      snapshotId,
    },
  });
  const positionsCurrent = v2Head(positionsOld, "positions-current");
  const molitCurrent = v2Head(molitOld, "molit-current");
  const seoulCurrent = { ...structuredClone(seoulOld), snapshotId: "seoul-current", previousSnapshotId: seoulOld.snapshotId };
  const replacedSourceIds = new Set([positionsOld.sourceId, molitOld.sourceId, seoulOld.sourceId]);
  input.sourceSnapshots = [
    positionsOld, molitOld, seoulOld,
    positionsCurrent, seoulCurrent, molitCurrent,
    ...input.sourceSnapshots.filter(({ sourceId }) => !replacedSourceIds.has(sourceId)),
  ];
  replaceCandidateSource(input, positionsCurrent);
  replaceCandidateSource(input, seoulCurrent);
  replaceCandidateSource(input, molitCurrent);
  const selectedIds = new Set(input.candidateBuildSpec.sourceSnapshotIds);
  const selected = input.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const transitionSnapshots = new Map([
    [positionsOld.sourceId, { predecessor: positionsOld.snapshotId, evidence: positionsOld.snapshotId }],
    [molitOld.sourceId, { predecessor: molitOld.snapshotId, evidence: molitOld.snapshotId }],
    [seoulOld.sourceId, { predecessor: seoulCurrent.snapshotId, evidence: seoulOld.snapshotId }],
  ]);
  const transferSourceId = "seoul-metro-transfer-distance-duration";
  const selectedNonTransfer = input.candidateBuildSpec.sourceSnapshots.filter(({ sourceId }) => sourceId !== transferSourceId);
  const transitionIds = (kind) => new Set(selectedNonTransfer.map(({ sourceId, snapshotId }) => transitionSnapshots.get(sourceId)?.[kind] ?? snapshotId));
  const predecessorIds = transitionIds("predecessor");
  const evidenceIds = transitionIds("evidence");
  const predecessor = input.sourceSnapshots.filter(({ snapshotId }) => predecessorIds.has(snapshotId));
  const evidence = input.sourceSnapshots.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  const sourceSet = sha(JSON.stringify(selected)); const predecessorSourceSet = sha(JSON.stringify(predecessor)); const evidenceSourceSet = sha(JSON.stringify(evidence));
  input.candidateBuildSpec.sourceSnapshotSetHash = sourceSet;
  input.sourceSetTransition = {
    currentCandidateBytesSha256: "1".repeat(64), currentCandidateSourceSetSha256: sourceSet,
    evidenceSourceSetSha256: evidenceSourceSet, facilityAdmissionBytesSha256: "2".repeat(64),
    kind: "PUBLIC_STATIC_NETWORK_V2_SUCCESSOR_REFRESH", predecessorCandidateSourceSetSha256: predecessorSourceSet,
    positionPreviousSnapshotId: positionsOld.snapshotId, molitPreviousSnapshotId: molitOld.snapshotId,
  };
  input.facilityAdmission.candidate.sourceSnapshotSetHash = evidenceSourceSet; resealFacility(input.facilityAdmission);
  input.exitAdmission.candidate.sourceSetSha256 = evidenceSourceSet;
  input.exitAdmission.materializerEvidenceRows = input.exitAdmission.materializerEvidenceRows.map((row) => ({ ...row, sourceSetSha256: evidenceSourceSet }));
  rebindExitArtifacts(input);
  return input;
}

function previousSourceSnapshot(input, sourceId) {
  const previous = structuredClone(sourceLedger(input, sourceId));
  previous.snapshotId = `${sourceId}-previous`;
  return previous;
}

function replaceCandidateSource(input, snapshot) {
  const index = input.candidateBuildSpec.sourceSnapshots.findIndex(({ sourceId }) => sourceId === snapshot.sourceId);
  assert.notEqual(index, -1);
  input.candidateBuildSpec.sourceSnapshots[index] = { sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId };
  input.candidateBuildSpec.sourceSnapshotIds[index] = snapshot.snapshotId;
}

function candidateProjection(input, sourceId) {
  const matches = input.candidateBuildSpec.sourceSnapshots.filter((projection) => projection.sourceId === sourceId);
  assert.equal(matches.length, 1);
  return matches[0];
}

function sourceLedger(input, sourceId) {
  const matches = input.sourceSnapshots.filter((snapshot) => snapshot.sourceId === sourceId);
  assert.equal(matches.length, 1);
  return matches[0];
}

function removeCandidateSource(input, sourceId) {
  const index = input.candidateBuildSpec.sourceSnapshots.findIndex((projection) => projection.sourceId === sourceId);
  assert.notEqual(index, -1);
  input.candidateBuildSpec.sourceSnapshots.splice(index, 1);
  input.candidateBuildSpec.sourceSnapshotIds.splice(index, 1);
}

function swapCandidateProjections(input, leftSourceId, rightSourceId) {
  const left = input.candidateBuildSpec.sourceSnapshots.findIndex(({ sourceId }) => sourceId === leftSourceId);
  const right = input.candidateBuildSpec.sourceSnapshots.findIndex(({ sourceId }) => sourceId === rightSourceId);
  assert.notEqual(left, -1);
  assert.notEqual(right, -1);
  [input.candidateBuildSpec.sourceSnapshots[left], input.candidateBuildSpec.sourceSnapshots[right]] = [input.candidateBuildSpec.sourceSnapshots[right], input.candidateBuildSpec.sourceSnapshots[left]];
}

function resealReceipt(value) { const { receiptSha256: _ignored, ...payload } = value; value.receiptSha256 = sha(canonical(payload)); }
function rebindExitArtifacts(value) {
  const { admissionDigest: _ignored, ...payload } = value.exitAdmission;
  value.exitAdmission.admissionDigest = sha(canonical(payload));
  value.exitAdmissionBytes = Buffer.from(canonical(value.exitAdmission));
  value.exitReceipt.admissionSha256 = sha(value.exitAdmissionBytes);
  value.exitReceipt.admissionDigest = value.exitAdmission.admissionDigest;
  resealReceipt(value.exitReceipt);
}
function resealApplicability(value) { const { artifactSha256: _ignored, ...payload } = value; value.artifactSha256 = sha(`${canonical(payload)}\n`); }
function rebindTransferArtifacts(value) {
  const { artifactSha256: _ignored, ...metricsPayload } = value.transferMetrics;
  value.transferMetrics.artifactSha256 = sha(canonical(metricsPayload));
  value.transferApplicability.transferTopologyMetricsIdentity.artifactSha256 = value.transferMetrics.artifactSha256;
  resealApplicability(value.transferApplicability);
  const admission = value.sourceInventory.sources.find(({ id }) => id === "seoul-metro-transfer-distance-duration").transferAdmissionEvidence;
  admission.metricsArtifactSha256 = value.transferMetrics.artifactSha256;
  admission.applicabilityArtifactSha256 = value.transferApplicability.artifactSha256;
  value.sourceInventoryBytes = Buffer.from(canonical(value.sourceInventory));
  value.candidateBuildSpec.sourceInventorySha256 = sha(JSON.stringify(value.sourceInventory));
  value.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha(value.sourceInventoryBytes);
}
