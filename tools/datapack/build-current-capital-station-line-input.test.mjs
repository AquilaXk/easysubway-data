import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildCurrentCapitalStationLineInput } from "./build-current-capital-station-line-input.mjs";
import { buildCurrentExitAdmissionOciReceipt } from "./build-current-exit-admission-oci-receipt.mjs";
import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";

test("full-capital FACILITY·EXIT·TRANSFER fan-in은 213/199/641 closed input을 만든다", async () => {
  const input = await fixture();
  const result = buildCurrentCapitalStationLineInput(input);
  assert.deepEqual(Object.keys(result).sort(), ["candidate", "evidenceRows", "stationLines"]);
  assert.equal(result.candidate.sourceSetSha256, input.sourceSetTransition.currentCandidateSourceSetSha256);
  assert.notEqual(result.candidate.sourceSetSha256, input.sourceSetTransition.evidenceSourceSetSha256);
  assert.equal(result.stationLines.length, 213);
  assert.equal(new Set(result.stationLines.map(({ stationId }) => stationId)).size, 199);
  assert.equal(result.evidenceRows.length, 641);
  assert.equal(result.evidenceRows.filter((row) => row.stationId === "station-b35616704ce3" && row.lineId === "seoul-2" && row.domain === "FACILITY").length, 3);
  const materialization = materializeStationLineAccessibility({ ...result, observedAt: "2026-08-01T01:00:00.000Z" });
  assert.equal(materialization.rows.length, 639);
  assert.equal(materialization.rows.filter(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED").length, 2);
  assert.equal(materialization.rows.filter(({ state, domain }) => state === "UNVERIFIED_EVIDENCE_BLOCKED" && domain === "EXIT").length, 1);
  assert.equal(materialization.stateSummary.MISSING, 0);
  assert.equal(materialization.stateSummary.STALE, 0);
  assert.equal(materialization.stateSummary.UNKNOWN, 0);
});

test("FACILITY snapshot timestamp identity와 candidate freshness는 strict하게 bind한다", async () => {
  for (const [field, mutate] of [
    ["capturedAt", (snapshot) => rebindSnapshotClock(snapshot, "2026-08-01T00:00:00.001Z")],
    ["observedAt", (snapshot) => rebindSnapshotClock(snapshot, "2026-08-01T00:00:00.001Z")],
    ["freshUntil", (snapshot) => { snapshot.freshUntil = "2026-08-02T00:00:00.001Z"; }],
  ]) {
    const timestampDrift = await fixture();
    const snapshot = JSON.parse(timestampDrift.facilitySnapshotBytes.toString("utf8"));
    mutate(snapshot);
    timestampDrift.facilitySnapshotBytes = Buffer.from(JSON.stringify(snapshot));
    assert.throws(() => buildCurrentCapitalStationLineInput(timestampDrift), new RegExp(`FACILITY snapshot binding mismatch`, "u"), field);
  }

  const staleAtCandidate = await fixture();
  staleAtCandidate.candidateBuildSpec.publishedAt = staleAtCandidate.facilityAdmission.sourceIdentity.freshUntil;
  assert.throws(() => buildCurrentCapitalStationLineInput(staleAtCandidate), /FACILITY freshness mismatch/);
});

function rebindSnapshotClock(snapshot, capturedAt) {
  snapshot.capturedAt = capturedAt;
  snapshot.observedAt = capturedAt;
  snapshot.snapshotId = `${snapshot.sourceId}-${capturedAt.replaceAll(/[-:.]/g, "")}`;
}

test("canonical capital pack이 전국 superset이어도 admitted 213 scope만 선택한다", async () => {
  const input = await fixture();
  const pack = input.canonicalPack.packs[0];
  pack.lines.push({ id: "regional-line", operatorId: "regional-operator" });
  pack.stationLines.push({ stationId: "regional-station", lineId: "regional-line", lineSequence: 0 });

  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.stationLines.length, 213);
  assert.equal(new Set(result.stationLines.map(({ stationId }) => stationId)).size, 199);
  assert.equal(result.stationLines.some(({ stationId }) => stationId === "regional-station"), false);
  assert.equal(result.evidenceRows.length, 641);
});

test("admitted target missing·duplicate·operator drift는 superset selection 전에 fail-closed다", async () => {
  for (const mutate of [
    (value) => { value.canonicalPack.packs[0].stationLines.shift(); },
    (value) => { value.canonicalPack.packs[0].stationLines.push(structuredClone(value.canonicalPack.packs[0].stationLines[0])); },
    (value) => { value.canonicalPack.packs[0].lines.find(({ id }) => id === "seoul-2").operatorId = "other-operator"; },
    (value) => { value.canonicalPack.packs[0].lines.push(structuredClone(value.canonicalPack.packs[0].lines[0])); },
    (value) => {
      value.facilityAdmission.cells[1] = structuredClone(value.facilityAdmission.cells[0]);
      resealFacility(value.facilityAdmission);
    },
  ]) {
    const value = await fixture(); mutate(value);
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /full-capital|selection|selector|denominator/i);
  }
});

test("candidate order ends in TRANSFER even when exact ledger order does not", async () => {
  const input = await fixture();
  input.sourceSnapshots = [input.sourceSnapshots.at(-1), ...input.sourceSnapshots.slice(0, -1)];
  const sourceSet = sha(JSON.stringify(input.sourceSnapshots));
  const predecessorIds = new Set(input.candidateBuildSpec.sourceSnapshotIds.slice(0, -1));
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
  assert.equal(input.candidateBuildSpec.sourceSnapshots.at(-1).sourceId, "seoul-metro-transfer-distance-duration");
  assert.notEqual(input.sourceSnapshots.at(-1).sourceId, "seoul-metro-transfer-distance-duration");
  assert.equal(result.stationLines.length, 213);
  assert.equal(result.evidenceRows.length, 641);
});

test("current capital candidate는 exact eight-source roster만 허용한다", async () => {
  const input = await fixture();
  assert.deepEqual(input.candidateBuildSpec.sourceSnapshots.map(({ sourceId }) => sourceId), [
    "seoul-metro-route-map-positions",
    "kric-subway-timetable",
    "seoul-metro-accessibility",
    "kric-station-convenience-standard",
    "molit-urban-rail-full-route",
    "seoulmetro-station-line-info",
    "incheon-transit-accessibility",
    "seoul-metro-transfer-distance-duration",
  ]);
  for (const mutate of [
    (value) => { value.candidateBuildSpec.sourceSnapshots.splice(1, 1); value.candidateBuildSpec.sourceSnapshotIds.splice(1, 1); },
    (value) => { [value.candidateBuildSpec.sourceSnapshots[0], value.candidateBuildSpec.sourceSnapshots[1]] = [value.candidateBuildSpec.sourceSnapshots[1], value.candidateBuildSpec.sourceSnapshots[0]]; },
    (value) => { value.candidateBuildSpec.sourceSnapshots[0].snapshotId = "projection-drift"; },
    (value) => { value.candidateBuildSpec.sourceSnapshots.splice(-1, 0, { sourceId: "extra-source", snapshotId: "extra-snapshot" }); value.candidateBuildSpec.sourceSnapshotIds.splice(-1, 0, "extra-snapshot"); },
  ]) {
    const value = await fixture(); mutate(value);
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /eighth|source roster|source-set/i);
  }
});

test("candidate inventory semantic hash와 authenticated raw-byte hash를 분리 검증한다", async () => {
  const input = await fixture();
  input.sourceInventoryBytes = Buffer.from(`${JSON.stringify(input.sourceInventory, null, 2)}\n`);
  input.candidateBuildSpec.sourceInventorySha256 = sha(JSON.stringify(input.sourceInventory));
  input.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha(input.sourceInventoryBytes);

  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.stationLines.length, 213);
  assert.equal(result.evidenceRows.length, 641);
});

test("public static-network V2 transition은 Seoul accessibility의 evidence predecessor semantics를 유지한다", async () => {
  const input = await publicStaticV2Fixture();
  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.candidate.sourceSetSha256, input.sourceSetTransition.currentCandidateSourceSetSha256);
  assert.notEqual(result.candidate.sourceSetSha256, input.sourceSetTransition.evidenceSourceSetSha256);
  assert.equal(result.evidenceRows.length, 641);
});

test("public static-network V2 두 head는 first-seven predecessor/evidence seven만 허용한다", async () => {
  const input = await publicStaticV2Fixture();

  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.candidate.sourceSetSha256, input.sourceSetTransition.currentCandidateSourceSetSha256);
  assert.equal(result.evidenceRows.length, 641);
  for (const mutate of [
    (value) => { value.sourceSnapshots.find(({ snapshotId }) => snapshotId === "positions-current").projectionMigration = { migrationKind: "legacy" }; },
    (value) => { value.sourceSnapshots.find(({ snapshotId }) => snapshotId === "molit-current").previousSnapshotId = "positions-old"; },
    (value) => { value.candidateBuildSpec.sourceSnapshots[0].sourceId = "molit-urban-rail-full-route"; },
  ]) {
    const value = await publicStaticV2Fixture(); mutate(value);
    const selectedIds = new Set(value.candidateBuildSpec.sourceSnapshotIds);
    const selected = value.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
    value.candidateBuildSpec.sourceSnapshotSetHash = sha(JSON.stringify(selected));
    value.sourceSetTransition.currentCandidateSourceSetSha256 = value.candidateBuildSpec.sourceSnapshotSetHash;
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /public v2|source identity|eighth projection/i);
  }
});

test("blocked tuple·receipt·TRANSFER admission drift는 output 없이 fail-closed다", async () => {
  for (const mutate of [
    (value) => { value.facilityAdmission.cells.find((cell) => cell.stationId === "station-b35616704ce3" && cell.lineId === "seoul-2").state = "ADMITTED_FACILITY_PRESENT"; resealFacility(value.facilityAdmission); },
    (value) => { value.exitReceipt.admissionDigest = "0".repeat(64); resealReceipt(value.exitReceipt); },
    (value) => { value.transferMetrics.metrics[0].durationRole = "RUNTIME"; },
    (value) => { value.transferApplicability.cells.pop(); resealApplicability(value.transferApplicability); },
    (value) => { value.candidateBuildSpec.sourceSnapshots.pop(); },
    (value) => { value.candidateBuildSpec.sourceSnapshots.at(-1).rawSha256 = "0".repeat(64); },
    (value) => { value.candidateBuildSpec.sourceSnapshots.at(-1).extra = true; },
    (value) => { value.sourceInventoryBytes = Buffer.concat([value.sourceInventoryBytes, Buffer.from(" ")]); },
    (value) => { value.sourceSetTransition.currentCandidateSourceSetSha256 = "0".repeat(64); },
    (value) => { value.sourceSetTransition.evidenceSourceSetSha256 = value.sourceSetTransition.currentCandidateSourceSetSha256; },
    (value) => { value.sourceSetTransition.evidenceSourceSetSha256 = "0".repeat(64); },
    (value) => { value.exitAdmission.materializerEvidenceRows.find(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED").sourceId = "wrong-source"; rebindExitArtifacts(value); },
    (value) => { value.exitAdmission.materializerEvidenceRows.find(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED").evidenceHash = "0".repeat(64); rebindExitArtifacts(value); },
  ]) {
    const value = await fixture(); mutate(value);
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /full-capital|mismatch|denominator|blocked/i);
  }
});

test("count를 유지한 blocked carrier·directed pair·applicability swap drift도 fail-closed다", async () => {
  for (const mutate of [
    (value) => {
      const blockedRows = value.facilityAdmission.denominatorRows.filter((row) => row.stationId === "station-b35616704ce3" && row.lineId === "seoul-2");
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
    const value = await fixture(); mutate(value);
    assert.throws(() => buildCurrentCapitalStationLineInput(value), /full-capital|mismatch|blocked/i);
  }
});

export async function fixture() {
  const lines = stationLines(); const stationIds = [...new Set(lines.map(({ stationId }) => stationId))].sort();
  const sourceIds = ["seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info", "incheon-transit-accessibility", "seoul-metro-transfer-distance-duration"];
  const snapshotIds = ["positions-snapshot", "timetable-snapshot", "seoul-snapshot", "facility-snapshot", "molit-snapshot", "station-line-snapshot", "incheon-snapshot", "transfer-snapshot"];
  const sourceSnapshots = snapshotIds.map((snapshotId, index) => index === 7 ? ({ snapshotId, sourceId: sourceIds[index], rawObjectUri: "oci://fixture/transfer", rawSha256: "a".repeat(64), redactedRequestFingerprint: "b".repeat(64), schemaFingerprint: "c".repeat(64), licenseStatus: "PASS", redistributionAllowed: true, adminReviewRecordHash: "d".repeat(64), snapshotStatus: "LOCKED", credentialRedacted: true, freshnessExpiresAt: "2026-09-01T00:00:00.000Z", rawRetentionExpiresAt: "2026-10-01T00:00:00.000Z", governancePolicyVersion: "fixture", governancePolicySha256: "e".repeat(64) }) : ({ sourceId: sourceIds[index], snapshotId, snapshotStatus: "LOCKED" }));
  const sourceSet = sha(JSON.stringify(sourceSnapshots)); const evidenceSourceSet = sha(JSON.stringify(sourceSnapshots.slice(0, -1))); const stationSet = sha(canonical(stationIds));
  const candidate = { candidateId: "capital-full-fixture", stationSetSha256: stationSet, sourceSetSha256: sourceSet, mappingContractVersion: "station-line-v1", materializerVersion: "1" };
  const evidenceCandidate = { ...candidate, sourceSetSha256: evidenceSourceSet };
  const snapshot = await facilitySnapshot(lines); const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const sourceIdentity = { sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`, rawSha256: snapshot.rawSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint, contentSha256: snapshot.contentSha256, schemaFingerprint: snapshot.schemaFingerprint, snapshotFileSha256: sha(snapshotBytes), capturedAt: snapshot.capturedAt, observedAt: snapshot.observedAt, freshUntil: snapshot.freshUntil, rawObjectUri: "oci://fixture/facility", rawObjectSha256: "7".repeat(64), credentialRedacted: true, licenseEvidenceHash: "8".repeat(64) };
  const facilityAdmission = facility(lines, sourceSet, sourceIdentity);
  const normalized = { schemaVersion: 4, artifactKind: "exit-path-normalized-source-snapshot", sourceId: "kric-station-movement-standard", snapshotId: "exit-snapshot", queryPlan: Array.from({ length: 420 }, (_, index) => index < 213 ? ({ queryId: `query-${index}`, stationName: `역${index}`, lineName: "2호선", operatorName: "서울교통공사", regionId: "capital" }) : ({ queryId: `query-${index}` })), results: Array.from({ length: 420 }, (_, index) => ({ queryId: `query-${index}`, providerResponseSha256: index === 0 ? "9".repeat(64) : "8".repeat(64) })) };
  const exitAdmission = exit(lines, evidenceCandidate); exitAdmission.queryPartition = { joined: lines.map((line, index) => ({ stationLineId: `${line.stationId}:${line.lineId}`, queryId: `query-${index}` })) }; const mapping = lines.map((line, index) => ({ stationId: line.stationId, stationName: `역${index}`, stationAliases: [], regionId: "capital", lineId: line.lineId, lineName: "2호선", operatorId: "seoul-metro", operatorName: "서울교통공사" })).sort((a, b) => a.stationId.localeCompare(b.stationId) || a.lineId.localeCompare(b.lineId)); exitAdmission.stationLineMappingSha256 = sha(canonical(mapping)); resealFacility(exitAdmission); const exitNormalizedBytes = Buffer.from(canonical(normalized)); const exitAdmissionBytes = Buffer.from(canonical(exitAdmission));
  const exitReceipt = receipt(exitNormalizedBytes, exitAdmissionBytes, exitAdmission.admissionDigest);
  const metrics = transferMetrics(lines); const applicability = transferApplicability(lines, metrics);
  const transferAdmissionEvidence = { decision: "APPROVED", metricsArtifactSha256: metrics.artifactSha256, applicabilityArtifactSha256: applicability.artifactSha256, physicalPairCount: 15, directedMetricCount: 30, officialMetricCount: 28, derivedReciprocalMetricCount: 2, durationRole: "REFERENCE_ONLY", snapshotId: "transfer-snapshot", freshUntil: "2026-09-01T00:00:00.000Z", licenseEvidenceHash: "9".repeat(64) };
  const sourceInventory = { sources: [{ id: "seoul-metro-transfer-distance-duration", requiredForProductionPack: true, admissionEvidence: { adminReviewRecordHash: "d".repeat(64) }, transferAdmissionEvidence }] }; const sourceInventoryBytes = Buffer.from(canonical(sourceInventory));
  const candidateBuildSpec = { candidateId: candidate.candidateId, publishedAt: "2026-08-01T00:00:00.000Z", sourceSnapshotIds: snapshotIds, sourceSnapshots: [...sourceSnapshots.slice(0, -1).map((entry) => ({ snapshotId: entry.snapshotId, sourceId: entry.sourceId })), Object.fromEntries(["snapshotId", "sourceId", "rawObjectUri", "rawSha256", "redactedRequestFingerprint", "schemaFingerprint", "licenseStatus", "redistributionAllowed", "adminReviewRecordHash", "snapshotStatus", "credentialRedacted", "freshnessExpiresAt", "rawRetentionExpiresAt", "governancePolicyVersion", "governancePolicySha256"].map((key) => [key, sourceSnapshots.at(-1)[key]]))], sourceSnapshotSetHash: sha(JSON.stringify(sourceSnapshots)), sourceInventorySha256: sha(JSON.stringify(sourceInventory)), networkEdgeEvidence: { sourceInventory: { path: "tools/datapack/source-inventory.json", sha256: sha(sourceInventoryBytes) } } };
  return { canonicalPack: { manifest: { channel: "production", activePack: { id: "capital" } }, packs: [{ id: "capital", lines: [{ id: "seoul-2", operatorId: "seoul-metro" }, { id: "seoul-4", operatorId: "seoul-metro" }, { id: "seoul-5", operatorId: "seoul-metro" }], stationLines: lines.map((line, lineSequence) => ({ ...line, lineSequence })) }] }, candidateBuildSpec, exitAdmission, exitAdmissionBytes, exitNormalized: normalized, exitNormalizedBytes, exitReceipt, facilityAdmission, facilitySnapshotBytes: snapshotBytes, policy: { artifactKind: "route-edge-evaluation-policy", policyVersion: "route-edge-evaluation-v2", edgeDomainMap: { RIDE: { endpointTarget: "NONE" } } }, sourceInventory, sourceInventoryBytes, sourceSnapshots, sourceSetTransition: { currentCandidateBytesSha256: "1".repeat(64), currentCandidateSourceSetSha256: sourceSet, evidenceSourceSetSha256: evidenceSourceSet, facilityAdmissionBytesSha256: "2".repeat(64) }, transferMetrics: metrics, transferApplicability: applicability };
}

async function publicStaticV2Fixture() {
  const input = await fixture();
  const positionsOld = structuredClone(input.sourceSnapshots[0]);
  const molitOld = structuredClone(input.sourceSnapshots[4]);
  const seoulOld = structuredClone(input.sourceSnapshots[2]);
  Object.assign(positionsOld, { sourceId: "seoul-metro-route-map-positions", snapshotId: "positions-old" });
  Object.assign(molitOld, { sourceId: "molit-urban-rail-full-route", snapshotId: "molit-old" });
  Object.assign(seoulOld, { sourceId: "seoul-metro-accessibility", snapshotId: "seoul-old" });
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
  input.sourceSnapshots = [
    positionsOld, molitOld, seoulOld,
    positionsCurrent, input.sourceSnapshots[1], seoulCurrent, input.sourceSnapshots[3],
    molitCurrent, input.sourceSnapshots[5], input.sourceSnapshots[6], input.sourceSnapshots[7],
  ];
  input.candidateBuildSpec.sourceSnapshotIds.splice(0, 1, positionsCurrent.snapshotId);
  input.candidateBuildSpec.sourceSnapshotIds.splice(2, 1, seoulCurrent.snapshotId);
  input.candidateBuildSpec.sourceSnapshotIds.splice(4, 1, molitCurrent.snapshotId);
  input.candidateBuildSpec.sourceSnapshots.splice(0, 1, { sourceId: positionsCurrent.sourceId, snapshotId: positionsCurrent.snapshotId });
  input.candidateBuildSpec.sourceSnapshots.splice(2, 1, { sourceId: seoulCurrent.sourceId, snapshotId: seoulCurrent.snapshotId });
  input.candidateBuildSpec.sourceSnapshots.splice(4, 1, { sourceId: molitCurrent.sourceId, snapshotId: molitCurrent.snapshotId });
  const selectedIds = new Set(input.candidateBuildSpec.sourceSnapshotIds);
  const selected = input.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const predecessor = input.sourceSnapshots.filter(({ snapshotId }) => new Set([
    positionsOld.snapshotId, input.candidateBuildSpec.sourceSnapshotIds[1], seoulCurrent.snapshotId,
    input.candidateBuildSpec.sourceSnapshotIds[3], molitOld.snapshotId,
    ...input.candidateBuildSpec.sourceSnapshotIds.slice(5, 7),
  ]).has(snapshotId));
  const evidence = input.sourceSnapshots.filter(({ snapshotId }) => new Set([
    positionsOld.snapshotId, input.candidateBuildSpec.sourceSnapshotIds[1], seoulOld.snapshotId,
    input.candidateBuildSpec.sourceSnapshotIds[3], molitOld.snapshotId,
    ...input.candidateBuildSpec.sourceSnapshotIds.slice(5, -1),
  ]).has(snapshotId));
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

function stationLines() { const stations = [...Array.from({ length: 198 }, (_, index) => `station-${String(index).padStart(3, "0")}`), "station-b35616704ce3"]; return stations.flatMap((stationId, index) => index < 12 ? ["seoul-2", "seoul-4"].map((lineId) => ({ stationId, lineId })) : index === 12 ? ["seoul-2", "seoul-4", "seoul-5"].map((lineId) => ({ stationId, lineId })) : [{ stationId, lineId: "seoul-2" }]).sort((a, b) => a.stationId.localeCompare(b.stationId) || a.lineId.localeCompare(b.lineId)); }
async function facilitySnapshot(lines) { const roster = lines.map((line, index) => ({ ...line, railOprIsttCd: line.stationId === "station-b35616704ce3" ? "S1" : "S2", lnCd: line.lineId === "seoul-2" ? "2" : "4", stinCd: line.stationId === "station-b35616704ce3" ? "234-4" : String(index), canonicalMappings: [{ artifactId: "fixture", ...line }] })); const [snapshot] = await collectKricAccessibilitySnapshots({ roster, operations: [{ sourceId: "kric-station-convenience-standard", endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl", responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"], tupleIdentityFields: [] }], serviceKey: "fixture", now: new Date("2026-08-01T00:00:00.000Z"), allowTerminalResult03: true, fetchImpl: async (url) => url.searchParams.get("railOprIsttCd") === "S1" ? ({ ok: true, status: 200, json: async () => ({ header: { resultCode: "03" }, body: [] }) }) : ({ ok: true, status: 200, json: async () => ({ header: { resultCode: "00" }, body: [{ dtlLoc: "x", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01" }] }) }) }); return snapshot; }
function facility(lines, sourceSet, sourceIdentity) { const cells = lines.map((line) => ({ ...line, state: line.stationId === "station-b35616704ce3" && line.lineId === "seoul-2" ? "ADMITTED_FACILITY_UNVERIFIED_BLOCKED" : "ADMITTED_FACILITY_PRESENT", sourceId: sourceIdentity.sourceId, snapshotId: sourceIdentity.snapshotId })); const denominatorRows = cells.flatMap((cell) => ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"].map((facilityType) => ({ stationId: cell.stationId, lineId: cell.lineId, facilityType, state: cell.state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED" ? "UNVERIFIED_EVIDENCE_BLOCKED" : "VERIFIED_PRESENT", sourceId: cell.sourceId, snapshotId: cell.snapshotId }))); const value = { schemaVersion: 1, artifactKind: "current-capital-facility-source-admission", observedAt: "2026-08-01T00:00:00.000Z", candidate: { candidateId: "capital-full-fixture", sourceSnapshotSetHash: sourceSet }, sourceIdentity, stationLineProviderMappingSha256: "a".repeat(64), denominatorRows, denominatorStateSummary: { VERIFIED_PRESENT: 636, VERIFIED_ABSENT: 0, UNVERIFIED_EVIDENCE_BLOCKED: 3 }, cells, cellStateSummary: { ADMITTED_FACILITY_PRESENT: 212, ADMITTED_FACILITY_ABSENT: 0, ADMITTED_FACILITY_UNVERIFIED_BLOCKED: 1 }, materializerEvidenceRows: cells.map((cell) => ({ ...cell, evidenceState: cell.state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED" ? "UNVERIFIED_EVIDENCE_BLOCKED" : "VERIFIED_PRESENT" })), decision: "GO" }; resealFacility(value); return value; }
function exit(lines, candidate) { const projection = lines.map((line) => ({ ...line, operatorId: "seoul-metro" })).sort((a, b) => a.stationId.localeCompare(b.stationId) || a.lineId.localeCompare(b.lineId)); const projectionSha256 = sha(canonical(projection)); const evidence = projection.map((line, index) => { const base = { ...candidate, ...line, domain: "EXIT", sourceId: "kric-station-movement-standard", sourceSnapshotId: "exit-snapshot", evidenceRawSha256: "b".repeat(64), capturedAt: "2026-08-01T00:00:00.000Z", freshUntil: "2026-09-01T00:00:00.000Z", provenanceId: "d".repeat(64), licenseId: "e".repeat(64) }; if (index !== 0) return { ...base, state: "VERIFIED_PRESENT", providerRecordHash: "c".repeat(64), evidenceKind: "OBSERVED", evidenceReason: "fixture" }; const providerResponseSha256 = "9".repeat(64); const terminalPolicy = "PROVIDER_NO_DATA_RESULT_03_BLOCKED"; const evidenceHash = sha(canonical({ sourceSnapshotId: base.sourceSnapshotId, stationId: line.stationId, lineId: line.lineId, operatorId: line.operatorId, domain: "EXIT", terminalPolicy, providerResponseSha256 })); return { ...base, state: "UNVERIFIED_EVIDENCE_BLOCKED", providerRecordHash: null, evidenceKind: "UNVERIFIED_EVIDENCE_BLOCKED", evidenceReason: "출구 이동경로가 검증되지 않아 경로를 차단했습니다.", terminalPolicy, providerResultCode: "03", strictRouteEligible: false, strictRouteEligibleReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED", statusMeaning: "PROVIDER_NO_DATA_NOT_ABSENCE", confidence: 0, providerResponseSha256, evidenceHash }; }); const payload = { schemaVersion: 2, artifactKind: "exit-path-admission-matrix", candidate, sourceIdentity: { sourceId: "kric-station-movement-standard", snapshotId: "exit-snapshot", rawSha256: "b".repeat(64) }, stationLineMappingSha256: projectionSha256, stationLineSetSha256: projectionSha256, normalizedEvidenceSha256: "1".repeat(64), queryPartition: {}, cells: [], materializerEvidenceRows: evidence, stateSummary: { ADMITTED_EXIT_PATH: 212, ADMITTED_EXIT_UNVERIFIED_BLOCKED: 1 }, decision: "GO" }; return { ...payload, admissionDigest: sha(canonical(payload)) }; }
function receipt(normalizedBytes, admissionBytes) { const provider = Buffer.from("fixture-provider"); return buildCurrentExitAdmissionOciReceipt({ repository: "AquilaXk/easysubway-data", mainSha: "a".repeat(40), operationId: "current-capital-560", providerCapturedAt: "2026-08-01T00:00:00.000Z", providerCollectionBundleBytes: provider, providerObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${"a".repeat(40)}/operations/current-capital-560/provider-collections/20260801-${sha(provider)}.json`, providerObjectSha256: sha(provider), providerObjectByteSize: provider.length, normalizedBytes, admissionBytes }); }
function transferMetrics(lines) { const pairs = [...Array.from({ length: 12 }, (_, index) => ({ stationId: `station-${String(index).padStart(3, "0")}`, lineIds: ["seoul-2", "seoul-4"] })), { stationId: "station-012", lineIds: ["seoul-2", "seoul-4"] }, { stationId: "station-012", lineIds: ["seoul-2", "seoul-5"] }, { stationId: "station-012", lineIds: ["seoul-4", "seoul-5"] }]; const metrics = pairs.flatMap((pair, index) => pair.lineIds.map((fromLineId, direction) => ({ stationId: pair.stationId, fromLineId, toLineId: pair.lineIds[1 - direction], distanceMeters: 10, officialDurationSecondsReference: 10, durationRole: "REFERENCE_ONLY", metricProvenance: index === 0 && direction < 2 ? "DERIVED_RECIPROCAL" : "OFFICIAL_SOURCE" }))); metrics[0].metricProvenance = "DERIVED_RECIPROCAL"; metrics[1].metricProvenance = "DERIVED_RECIPROCAL"; const canonicalIdentity = { stationLineCount: 213, stationCount: 199, physicalPairCount: 15 }; const sourceIdentity = { sourceId: "seoul-metro-transfer-distance-duration", rawSha256: "f".repeat(64), capturedAt: "2026-08-01T00:00:00.000Z" }; const payload = { artifactKind: "current-transfer-topology-metrics", physicalPairs: pairs, metrics, canonicalIdentity, sourceIdentity }; return { ...payload, artifactSha256: sha(canonical(payload)) }; }
function transferApplicability(lines, metrics) { const endpoints = new Set(metrics.metrics.flatMap((metric) => [`${metric.stationId}\0${metric.fromLineId}`, `${metric.stationId}\0${metric.toLineId}`])); const cells = lines.map((line) => ({ ...line, state: endpoints.has(`${line.stationId}\0${line.lineId}`) ? "APPLICABLE_TRANSFER_ENDPOINT" : "NOT_APPLICABLE_IN_CANONICAL_PAIR_SET" })); const payload = { artifactKind: "current-capital-transfer-topology-applicability-pre-candidate", candidateBinding: null, productionUseAllowed: false, canonicalIdentity: metrics.canonicalIdentity, sourceIdentity: metrics.sourceIdentity, transferTopologyMetricsIdentity: { artifactSha256: metrics.artifactSha256 }, cells }; return { ...payload, artifactSha256: sha(`${canonical(payload)}\n`) }; }
function resealFacility(value) { const { admissionDigest: _ignored, ...payload } = value; value.admissionDigest = sha(canonical(payload)); }
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
  const admission = value.sourceInventory.sources[0].transferAdmissionEvidence;
  admission.metricsArtifactSha256 = value.transferMetrics.artifactSha256;
  admission.applicabilityArtifactSha256 = value.transferApplicability.artifactSha256;
  value.sourceInventoryBytes = Buffer.from(canonical(value.sourceInventory));
  value.candidateBuildSpec.sourceInventorySha256 = sha(JSON.stringify(value.sourceInventory));
  value.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha(value.sourceInventoryBytes);
}
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
