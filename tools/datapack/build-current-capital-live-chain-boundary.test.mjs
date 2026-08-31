import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildCurrentCapitalLiveChainFanInBoundary, canonicalCurrentCapitalLiveChainFanInBoundaryJson, deriveCurrentLiveChainTerminalTransferEvidenceSubset, readCurrentCapitalLiveChainFanInBoundary, verifyCurrentCapitalLiveChainFanInComponents } from "./build-current-capital-live-chain-boundary.mjs";
import { buildCurrentCapitalStationLineInput } from "./build-current-capital-station-line-input.mjs";
import { fixture } from "./build-current-capital-station-line-input.test.mjs";

test("tracked current live-chain fan-in binds the repository component bytes", async () => {
  await assert.doesNotReject(readCurrentCapitalLiveChainFanInBoundary({
    repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
  }));
});

test("current live-chain fan-in binds current eight and evidence seven component identities", async () => {
  const input = await fixture();
  const components = fanInComponents(input);
  const boundary = buildCurrentCapitalLiveChainFanInBoundary(components);
  input.sourceSetTransition = boundary;
  input.currentFanInComponents = components;

  const result = buildCurrentCapitalStationLineInput(input);

  assert.equal(result.candidate.sourceSetSha256, boundary.currentCandidateSourceSetSha256);
  assert.notEqual(boundary.evidenceSourceSetSha256, boundary.currentCandidateSourceSetSha256);
  assert.equal(result.evidenceRows.length, 641);
});

test("current live-chain fan-in rejects component drift and boundary historical metadata", async () => {
  for (const mutate of [
    (components) => { components.facilityAdmission.value.candidate.sourceSnapshotSetHash = "0".repeat(64); components.facilityAdmission.bytes = bytes(components.facilityAdmission.value); },
    (components) => { components.exitAdmission.value.candidate.sourceSetSha256 = "0".repeat(64); components.exitAdmission.bytes = bytes(components.exitAdmission.value); },
    (components) => { components.transferMetrics.value.sourceIdentity.rawSha256 = "0".repeat(64); components.transferMetrics.bytes = bytes(components.transferMetrics.value); },
  ]) {
    const input = await fixture();
    const components = fanInComponents(input);
    mutate(components);
    assert.throws(() => buildCurrentCapitalLiveChainFanInBoundary(components), /current live-chain|forbidden historical/i);
  }
  const input = await fixture();
  const boundary = buildCurrentCapitalLiveChainFanInBoundary(fanInComponents(input));
  boundary.previousSnapshotId = "forbidden";
  assert.throws(() => canonicalCurrentCapitalLiveChainFanInBoundaryJson(boundary), /keys mismatch|forbidden historical/i);
});

test("current live-chain derives evidence set in ledger order while allowing ledger lineage metadata", async () => {
  const input = await fixture();
  const components = fanInComponents(input);
  components.sourceSnapshotLedger.value[0].previousSnapshotId = "prior-current-head";
  const sourceSetSha256 = sha(JSON.stringify(components.sourceSnapshotLedger.value));
  components.sourceSnapshotLedger.bytes = bytes(components.sourceSnapshotLedger.value);
  components.candidateBuildSpec.value.sourceSnapshotSetHash = sourceSetSha256;
  components.candidateBuildSpec.bytes = bytes(components.candidateBuildSpec.value);
  components.facilityAdmission.value.candidate.sourceSnapshotSetHash = sourceSetSha256;
  components.facilityAdmission.bytes = bytes(components.facilityAdmission.value);
  const transferSnapshotId = components.candidateBuildSpec.value.sourceSnapshotIds.at(-1);
  const evidenceSourceSetSha256 = sha(JSON.stringify(
    components.sourceSnapshotLedger.value.filter(({ snapshotId }) => snapshotId !== transferSnapshotId),
  ));
  components.exitAdmission.value.candidate.sourceSetSha256 = evidenceSourceSetSha256;
  components.exitAdmission.bytes = bytes(components.exitAdmission.value);
  components.exitAdmissionOciReceipt.value.admissionSha256 = sha(components.exitAdmission.bytes);
  components.exitAdmissionOciReceipt.bytes = bytes(components.exitAdmissionOciReceipt.value);

  const boundary = buildCurrentCapitalLiveChainFanInBoundary(components);

  assert.equal(boundary.currentCandidateSourceSetSha256, sourceSetSha256);
  assert.equal(boundary.evidenceSourceSetSha256, evidenceSourceSetSha256);
});

test("current live-chain rejects schema 1, all-current EXIT, and a wrong evidence hash", async () => {
  const input = await fixture();
  const components = fanInComponents(input);
  const boundary = buildCurrentCapitalLiveChainFanInBoundary(components);

  assert.throws(() => canonicalCurrentCapitalLiveChainFanInBoundaryJson({ ...boundary, schemaVersion: 1 }), /identity mismatch/);
  const allCurrentExit = fanInComponents(await fixture());
  allCurrentExit.exitAdmission.value.candidate.sourceSetSha256 = boundary.currentCandidateSourceSetSha256;
  allCurrentExit.exitAdmission.bytes = bytes(allCurrentExit.exitAdmission.value);
  assert.throws(() => buildCurrentCapitalLiveChainFanInBoundary(allCurrentExit), /EXIT candidate mismatch/);
  assert.throws(() => verifyCurrentCapitalLiveChainFanInComponents(
    { ...boundary, evidenceSourceSetSha256: "0".repeat(64) },
    components,
  ), /source-set mismatch/);
});

test("current live-chain rejects a non-terminal TRANSFER candidate projection", async () => {
  const components = fanInComponents(await fixture());
  const candidate = components.candidateBuildSpec.value;
  const transferIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration");
  const [transferId] = candidate.sourceSnapshotIds.splice(transferIndex, 1);
  const [transferProjection] = candidate.sourceSnapshots.splice(transferIndex, 1);
  candidate.sourceSnapshotIds.unshift(transferId);
  candidate.sourceSnapshots.unshift(transferProjection);
  components.candidateBuildSpec.bytes = bytes(candidate);

  assert.throws(() => deriveCurrentLiveChainTerminalTransferEvidenceSubset({
    candidate,
    sourceInventory: components.sourceInventory.value,
    sourceSnapshotLedger: components.sourceSnapshotLedger.value,
  }), /terminal in the candidate/);
  assert.throws(() => buildCurrentCapitalLiveChainFanInBoundary(components), /terminal in the candidate/);
});

test("current live-chain derives EXIT evidence from exactly the ledger-order terminal TRANSFER predecessors", async () => {
  const components = fanInComponents(await fixture());
  const candidate = components.candidateBuildSpec.value;
  const evidence = deriveCurrentLiveChainTerminalTransferEvidenceSubset({
    candidate,
    sourceInventory: components.sourceInventory.value,
    sourceSnapshotLedger: components.sourceSnapshotLedger.value,
  });

  assert.equal(evidence.currentCandidateSourceSetSha256, candidate.sourceSnapshotSetHash);
  assert.equal(evidence.predecessorEvidenceSha256, sha(JSON.stringify(evidence.predecessorEvidenceRows)));
  assert.deepEqual(
    evidence.predecessorEvidenceRows.map(({ snapshotId }) => snapshotId),
    components.sourceSnapshotLedger.value
      .filter(({ snapshotId }) => candidate.sourceSnapshotIds.slice(0, -1).includes(snapshotId))
      .map(({ snapshotId }) => snapshotId),
  );
  assert.equal(evidence.predecessorEvidenceRows.some(({ sourceId }) => sourceId === evidence.sourceId), false);
});

test("current live-chain boundary detects source-set and byte mismatch before station-line materialization", async () => {
  const input = await fixture();
  const components = fanInComponents(input);
  const boundary = buildCurrentCapitalLiveChainFanInBoundary(components);
  components.facilityAdmission.bytes = Buffer.concat([components.facilityAdmission.bytes, Buffer.from(" ")]);
  assert.throws(() => verifyCurrentCapitalLiveChainFanInComponents(boundary, components), /semantic byte|byte binding/i);

  const drifted = fanInComponents(await fixture());
  drifted.candidateBuildSpec.value.sourceSnapshotSetHash = "0".repeat(64);
  drifted.candidateBuildSpec.bytes = bytes(drifted.candidateBuildSpec.value);
  assert.throws(() => buildCurrentCapitalLiveChainFanInBoundary(drifted), /source-set/i);

  const stationInput = await fixture();
  const stationComponents = fanInComponents(stationInput);
  stationInput.sourceSetTransition = buildCurrentCapitalLiveChainFanInBoundary(stationComponents);
  stationInput.currentFanInComponents = stationComponents;
  stationInput.facilityAdmission = { ...stationInput.facilityAdmission, candidate: { ...stationInput.facilityAdmission.candidate, sourceSnapshotSetHash: "0".repeat(64) } };
  assert.throws(() => buildCurrentCapitalStationLineInput(stationInput), /fan-in.*facilityAdmission projection mismatch/i);
});

function fanInComponents(input) {
  // The station-line fixture retains a transition shape. The terminal fan-in
  // binds FACILITY to the selected candidate and EXIT to its ledger-order
  // evidence subset, excluding only terminal TRANSFER.
  const transferSource = input.sourceInventory.sources.find(({ transferAdmissionEvidence }) => transferAdmissionEvidence);
  const transfer = input.sourceSnapshots.find(({ sourceId }) => sourceId === transferSource.id);
  transfer.rawReceipt = {
    snapshotId: transfer.snapshotId,
    snapshotRawSha256: transfer.rawSha256,
    rawObjectSha256: transfer.rawSha256,
    rawObjectUri: transfer.rawObjectUri,
  };
  input.candidateBuildSpec.sourceSnapshotSetHash = sha(JSON.stringify(input.sourceSnapshots));
  const facilityAdmission = structuredClone(input.facilityAdmission);
  facilityAdmission.candidate.sourceSnapshotSetHash = input.candidateBuildSpec.sourceSnapshotSetHash;
  resealFacilityAdmission(facilityAdmission);
  input.facilityAdmission = facilityAdmission;
  const exitAdmission = structuredClone(input.exitAdmission);
  const evidenceSourceSetSha256 = sha(JSON.stringify(input.sourceSnapshots.filter(({ snapshotId }) =>
    snapshotId !== input.candidateBuildSpec.sourceSnapshotIds.at(-1))));
  exitAdmission.candidate.sourceSetSha256 = evidenceSourceSetSha256;
  exitAdmission.materializerEvidenceRows = exitAdmission.materializerEvidenceRows.map((row) => ({
    ...row,
    sourceSetSha256: evidenceSourceSetSha256,
  }));
  resealExitAdmission(exitAdmission);
  input.exitAdmission = exitAdmission;
  input.exitAdmissionBytes = Buffer.from(canonical(exitAdmission));
  input.exitReceipt = structuredClone(input.exitReceipt);
  input.exitReceipt.admissionSha256 = sha(input.exitAdmissionBytes);
  input.exitReceipt.admissionDigest = exitAdmission.admissionDigest;
  resealExitReceipt(input.exitReceipt);
  const values = {
    candidateBuildSpec: input.candidateBuildSpec,
    facilityAdmission,
    transferMetrics: input.transferMetrics,
    transferApplicability: input.transferApplicability,
    sourceInventory: input.sourceInventory,
    sourceSnapshotLedger: input.sourceSnapshots,
    exitNormalized: input.exitNormalized,
    exitAdmission,
    exitAdmissionOciReceipt: input.exitReceipt,
  };
  values.transferMetrics = structuredClone(values.transferMetrics);
  values.transferMetrics.sourceIdentity.rawSha256 = transfer.rawSha256;
  const { artifactSha256: _metricsArtifactSha256, ...metricsPayload } = values.transferMetrics;
  values.transferMetrics.artifactSha256 = sha(canonical(metricsPayload));
  values.transferApplicability = structuredClone(values.transferApplicability);
  values.transferApplicability.sourceIdentity = structuredClone(values.transferMetrics.sourceIdentity);
  values.transferApplicability.transferTopologyMetricsIdentity.artifactSha256 = values.transferMetrics.artifactSha256;
  const { artifactSha256: _applicabilityArtifactSha256, ...applicabilityPayload } = values.transferApplicability;
  values.transferApplicability.artifactSha256 = sha(`${canonical(applicabilityPayload)}\n`);
  values.sourceInventory = structuredClone(values.sourceInventory);
  for (const { sourceId } of input.candidateBuildSpec.sourceSnapshots) {
    if (!values.sourceInventory.sources.some(({ id }) => id === sourceId)) {
      values.sourceInventory.sources.push({ id: sourceId, requiredForProductionPack: true });
    }
  }
  Object.assign(values.sourceInventory.sources[0].transferAdmissionEvidence, {
    snapshotPath: `tools/datapack/sources/${transfer.snapshotId}.json`, rawSha256: transfer.rawSha256,
    schemaFingerprint: transfer.schemaFingerprint,
    metricsArtifactSha256: values.transferMetrics.artifactSha256,
    applicabilityArtifactSha256: values.transferApplicability.artifactSha256,
  });
  input.transferMetrics = values.transferMetrics;
  input.transferApplicability = values.transferApplicability;
  input.sourceInventory = values.sourceInventory;
  input.sourceInventoryBytes = Buffer.from(canonical(values.sourceInventory));
  input.candidateBuildSpec.sourceInventorySha256 = sha(JSON.stringify(values.sourceInventory));
  input.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha(input.sourceInventoryBytes);
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, bytes: name === "sourceInventory" ? bytes(value) : name === "exitNormalized" ? input.exitNormalizedBytes : name === "exitAdmission" ? input.exitAdmissionBytes : bytes(value) }]));
}
function bytes(value) { return Buffer.from(JSON.stringify(value)); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function resealFacilityAdmission(value) {
  const { admissionDigest: _ignored, ...payload } = value;
  value.admissionDigest = sha(canonical(payload));
}
function resealExitAdmission(value) {
  const { admissionDigest: _ignored, ...payload } = value;
  value.admissionDigest = sha(canonical(payload));
}
function resealExitReceipt(value) {
  const { receiptSha256: _ignored, ...payload } = value;
  value.receiptSha256 = sha(canonical(payload));
}
function canonical(value) { return JSON.stringify(sort(value)); }
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
}
