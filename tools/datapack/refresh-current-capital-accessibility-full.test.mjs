import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentCapitalAccessibilityRefreshOutputs, commitCurrentCapitalAccessibilityRefresh, refreshCurrentCapitalAccessibilityFull } from "./refresh-current-capital-accessibility-full.mjs";
import { readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";
import { activateSyntheticCurrentStaticNetworkSuccessors } from "./test-fixtures/current-public-route-map-successor.mjs";
import { currentIncheonStationCodeDerivations } from "./collect-incheon-station-info.mjs";
import { buildCurrentTopologyRefreshPrimaryOutputs, collectPositionSnapshotBytes } from "./activate-current-source-set.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUTS = [
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);

test("activated full-capital inputs are rebuilt across the exact public static-network successor boundary", async (t) => {
  const root = await stagedRefreshRepository(t);
  const approvalPaths = [
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/hash-evidence.json",
  ];
  const approvalInputs = await Promise.all(approvalPaths.map((relative) => readFile(path.join(root, relative))));
  const beforeStation = JSON.parse(await readFile(path.join(root, OUTPUTS[0]), "utf8"));
  const beforeRoute = JSON.parse(await readFile(path.join(root, OUTPUTS[1]), "utf8"));
  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
  assert.deepEqual(outputs.map(({ relative }) => relative), [
    "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
    "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  ]);
  const station = JSON.parse(outputs[0].bytes); const route = JSON.parse(outputs[1].bytes);
  assert.notEqual(station.candidate.sourceSetSha256, beforeStation.candidate.sourceSetSha256);
  assert.notEqual(route.candidate.sourceSetSha256, beforeRoute.candidate.sourceSetSha256);
  assert.deepEqual(station.stationLines, beforeStation.stationLines);
  assert.deepEqual(route.stationLines, beforeRoute.stationLines);
  assert.deepEqual(route.routeEdges, beforeRoute.routeEdges);
  assert.equal(station.evidenceRows.length, 641);
  assert.equal(route.routeEdges.length, 2674);
  assert.deepEqual(await Promise.all(approvalPaths.map((relative) => readFile(path.join(root, relative)))), approvalInputs);
});

test("atomic route-map and MOLIT successors refresh the exact two-source predecessor boundary", async (t) => {
  const root = await stagedRefreshRepository(t);
  const beforeStation = JSON.parse(await readFile(path.join(root, OUTPUTS[0]), "utf8"));
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));

  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
  const [station, route] = outputs.map(({ bytes }) => JSON.parse(bytes));

  assert.notEqual(beforeStation.candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
  assert.equal(station.candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
  assert.equal(route.candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
});

test("two-file refresh transaction rolls back a partial replacement without residue", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-capital-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [
    "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
    "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  ];
  for (const [index, relative] of paths.entries()) {
    const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, `before-${index}`);
  }
  const outputs = await Promise.all(paths.map(async (relative, index) => {
    const target = path.join(root, relative); return { relative, prestate: await readStableRegularFile(target, "refresh fixture"), bytes: Buffer.from(`after-${index}`) };
  }));
  await assert.rejects(commitCurrentCapitalAccessibilityRefresh({ repositoryRoot: root, outputs, failAfter: 0 }), /injected refresh failure/);
  assert.deepEqual(await Promise.all(paths.map((relative) => readFile(path.join(root, relative), "utf8"))), ["before-0", "before-1"]);
  await assert.rejects(readFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh-transaction.json")), { code: "ENOENT" });
});

test("predecessor-bound activated inputs are rebuilt atomically to exact current bytes", async (t) => {
  const root = await stagedRefreshRepository(t);
  const expected = await expectedCurrentBytes(root);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  assert.deepEqual(await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))), expected);
  const [station, route] = await Promise.all(OUTPUTS.map(async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"))));
  assert.equal(station.evidenceRows.length, 641);
  assert.equal(route.stationLines.length, 1102);
  assert.equal(route.routeEdges.length, 2674);
});

test("input mutation after build is rejected before either output replacement", async (t) => {
  const root = await stagedRefreshRepository(t);
  const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
  await assert.rejects(refreshCurrentCapitalAccessibilityFull({
    repositoryRoot: root,
    beforeCommit: async () => writeFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "{}"),
  }), /input changed during refresh/);
  assert.deepEqual(await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))), before);
});

test("PREPARED residue with already-current output bytes recovers under the refresh lock", async (t) => {
  const root = await stagedRefreshRepository(t);
  const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
  const expected = await expectedCurrentBytes(root);
  const records = OUTPUTS.map((relative, index) => ({ relative, before: before[index].toString("base64"), beforeSha256: sha(before[index]), after: expected[index].toString("base64"), afterSha256: sha(expected[index]) }));
  for (const [index, relative] of OUTPUTS.entries()) await writeFile(path.join(root, relative), expected[index]);
  await writeFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh-transaction.json"), JSON.stringify({ schemaVersion: 1, state: "PREPARED", records }));
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  assert.deepEqual(await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))), expected);
});

test("a demonstrably dead refresh owner lease permits PREPARED and COMMITTED journal recovery", async (t) => {
  for (const state of ["PREPARED", "COMMITTED"]) {
    const root = await stagedRefreshRepository(t);
    const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
    const expected = await expectedCurrentBytes(root);
    const records = OUTPUTS.map((relative, index) => ({ relative, before: before[index].toString("base64"), beforeSha256: sha(before[index]), after: expected[index].toString("base64"), afterSha256: sha(expected[index]) }));
    if (state === "PREPARED") for (const [index, relative] of OUTPUTS.entries()) await writeFile(path.join(root, relative), expected[index]);
    await writeFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh-transaction.json"), JSON.stringify({ schemaVersion: 1, state, records }));
    await writeRefreshLease(root, { schemaVersion: 1, token: "00000000-0000-4000-8000-000000000001", pid: 999999 });

    await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });

    assert.deepEqual(await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))), expected, state);
    await assert.rejects(readFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh-transaction.json")), { code: "ENOENT" }, state);
    await assert.rejects(readFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh.lock/owner.json")), { code: "ENOENT" }, state);
  }
});

test("active, malformed, and foreign refresh leases remain fail-closed", async (t) => {
  const cases = [
    { name: "active", lease: { schemaVersion: 1, token: "00000000-0000-4000-8000-000000000002", pid: process.pid } },
    { name: "malformed", lease: { schemaVersion: 1, token: "00000000-0000-4000-8000-000000000003", pid: "not-a-pid" } },
    { name: "foreign", lease: { schemaVersion: 1, token: "00000000-0000-4000-8000-000000000004", pid: 999999 }, foreign: true },
  ];
  for (const fixture of cases) {
    const root = await stagedRefreshRepository(t);
    const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
    await writeRefreshLease(root, fixture.lease);
    if (fixture.foreign) await writeFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh.lock/foreign"), "foreign");

    await assert.rejects(refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root }), /current-capital refresh lock/, fixture.name);
    assert.deepEqual(await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))), before, fixture.name);
  }
});

test("already-current canonical corruption fails closed instead of being returned or rewritten", async (t) => {
  const root = await stagedRefreshRepository(t);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  const stationPath = path.join(root, OUTPUTS[0]); const station = JSON.parse(await readFile(stationPath, "utf8"));
  station.evidenceRows[0].evidenceReason = "corrupt";
  await writeFile(stationPath, JSON.stringify(station));
  await assert.rejects(refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root }), /current output bytes mismatch/);
});

async function stagedRefreshRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-capital-refresh-staged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of ["tools/datapack/release", "tools/datapack/inputs", "release/product-gates"]) {
    await cp(path.join(ROOT, relative), path.join(root, relative), { recursive: true });
  }
  for (const relative of ["tools/datapack/source-inventory.json", "tools/datapack/source-governance-policy.json", "tools/datapack/official-od-fare-admission.json", "tools/datapack/nationwide-coverage-targets.json"]) {
    const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(ROOT, relative), target);
  }
  await cp(path.join(ROOT, "tools/datapack/sources"), path.join(root, "tools/datapack/sources"), { recursive: true });
  const currentCandidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  await copyCurrentCandidateEvidenceInputs(root, currentCandidate);
  const { inWindow: now, candidateId } = await stageCurrentTopologyFixture(root);
  await rebindStagedActivatedOutputCandidateIds(root, candidateId);
  await bindCurrentCandidateApprovalFixture(root);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  await activateSyntheticCurrentStaticNetworkSuccessors(root, { now });
  const finalEvidence = await stagedStaticEvidenceIdentity(root);
  await Promise.all([
    rebindStagedFacilityCandidateId(root, finalEvidence.candidateId, finalEvidence.sourceSetSha256),
    rebindStagedExitCandidateId(root, finalEvidence.candidateId, finalEvidence.sourceSetSha256),
  ]);
  return root;
}

// Staged repository 전용 bootstrap이다. 현재 capital admission과 같은 시계의
// synthetic Incheon 입력을 exact bytes로 결속해, 과거 tracked 관측을 현재 성공으로
// 오인하지 않고 static-successor transaction의 정상 경로만 재현한다.
async function stageCurrentTopologyFixture(root) {
  const [baseSpec, sourceInventory, canonical, policyBytes, incheonBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-inventory.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
    readFile(path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260814.json")),
  ]);
  const admission = sourceInventory.sources
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.currentTopologyAdmission)
    .find(({ topologySnapshotId } = {}) => /^capital-route-topology-[0-9]{8}$/u.test(topologySnapshotId));
  if (admission == null) throw new Error("staged current capital topology admission is missing");
  const currentTopologyPath = `tools/datapack/sources/${admission.topologySnapshotId}.json`;
  const currentTopologyBytes = await readFile(path.join(root, currentTopologyPath));
  const currentTopology = JSON.parse(currentTopologyBytes);
  const { inWindow } = await currentTopologyAdmissionClock(root);
  const { baseSpec: currentItxBaseSpec, admissionPath: currentItxAdmissionPath, admissionBytes: currentItxAdmissionBytes } =
    await stageCurrentItxTopologyAdmission(root, baseSpec, inWindow);
  const currentIncheonTopology = JSON.parse(incheonBytes);
  delete currentIncheonTopology.stationCodeCorrections;
  currentIncheonTopology.stationCodeDerivations = currentIncheonStationCodeDerivations();
  currentIncheonTopology.capturedAt = inWindow.toISOString();
  currentIncheonTopology.freshUntil = new Date(inWindow.getTime() + 24 * 60 * 60 * 1_000).toISOString();
  const currentIncheonTopologyBytes = Buffer.from(`${JSON.stringify(currentIncheonTopology)}\n`);
  const currentIncheonTopologyPath = "tools/datapack/sources/incheon-transit-station-info-20260824.json";
  const result = buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec: currentItxBaseSpec,
    builderGitSha: baseSpec.builderGitSha,
    sourceInventory,
    currentTopology,
    currentTopologyBytes,
    currentTopologyPath,
    currentIncheonTopology,
    currentIncheonTopologyBytes,
    currentIncheonTopologyPath,
    currentItxAdmissionPath,
    currentItxAdmissionBytes,
    baselineTopology: await readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json")).then(JSON.parse),
    canonical,
    productionScopePolicyBytes: policyBytes,
    buildNow: inWindow.toISOString(),
    snapshotBytesByPath: await collectPositionSnapshotBytes(sourceInventory, root),
  });
  result.spec.publishedAt = inWindow.toISOString();
  result.spec.sourceInventorySha256 = sha(JSON.stringify(result.sourceInventory));
  const reverificationPath = result.spec.networkEdgeEvidence.capitalTopologyReverification.path;
  await Promise.all([
    writeFile(path.join(root, currentIncheonTopologyPath), currentIncheonTopologyBytes),
    writeFile(path.join(root, "tools/datapack/source-inventory.json"), result.sourceInventoryBytes),
    writeFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), result.canonicalBytes),
    writeFile(path.join(root, reverificationPath), result.topologyReverificationBytes),
    writeFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), `${JSON.stringify(result.spec, null, 2)}\n`),
  ]);
  return { inWindow, candidateId: result.spec.candidateId };
}

async function stageCurrentItxTopologyAdmission(root, baseSpec, inWindow) {
  const contractPath = baseSpec.networkEdgeEvidence?.itxCoverageContract?.path;
  if (typeof contractPath !== "string") throw new Error("staged ITX coverage contract path is invalid");
  const contractBytes = await readFile(path.join(root, contractPath));
  const contract = JSON.parse(contractBytes);
  const reference = contract.sourceTimetableArtifact;
  const sourceBytes = await readFile(path.join(root, reference?.artifactPath ?? ""));
  const source = JSON.parse(sourceBytes);
  const serviceDate = kstDate(inWindow);
  const stagedContract = structuredClone(contract);
  stagedContract.sourceTimetableArtifact.promotion.mode = "UNCHANGED_AUTO";
  stagedContract.sourceTimetableArtifact.promotion.previousArtifactSha256 = reference.sha256;
  const admission = syntheticCurrentItxTopologyAdmission({ source, previousArtifactSha256: reference.sha256, inWindow, serviceDate });
  const admissionPath = `tools/datapack/itx-current-network-edge-admission-${serviceDate}.json`;
  const stagedContractBytes = Buffer.from(`${JSON.stringify(stagedContract, null, 2)}\n`);
  const admissionBytes = Buffer.from(`${JSON.stringify(admission, null, 2)}\n`);
  await Promise.all([
    writeFile(path.join(root, contractPath), stagedContractBytes),
    writeFile(path.join(root, admissionPath), admissionBytes),
  ]);
  const nextBaseSpec = structuredClone(baseSpec);
  nextBaseSpec.networkEdgeEvidence.itxCoverageContract.sha256 = sha(stagedContractBytes);
  return { baseSpec: nextBaseSpec, admissionPath, admissionBytes };
}

function syntheticCurrentItxTopologyAdmission({ source, previousArtifactSha256, inWindow, serviceDate }) {
  const tuples = [...new Map((source.stationSequences ?? []).flatMap(({ stops = [] }) =>
    stops.slice(1).map((to, index) => [stops[index].stationId, to.stationId, "ITX_CHEONGCHUN"])
  ).map((tuple) => [JSON.stringify(tuple), tuple])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  const stationIds = [...new Set(tuples.flatMap(([fromStationId, toStationId]) => [fromStationId, toStationId]))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const reconstructionSummary = {
    trainCount: source.stationSequences.length,
    stopCount: source.stationSequences.reduce((sum, { stops = [] }) => sum + stops.length, 0),
    conflictingTimestampCount: 0,
    missingPairCount: 0,
    duplicateOdCount: 0,
  };
  const artifact = {
    schemaVersion: 1,
    artifactKind: "itx-current-network-edge-admission",
    artifactId: `itx-current-network-edge-admission-${serviceDate}`,
    serviceId: "ITX_CHEONGCHUN",
    sourceIssue: 2776,
    status: "ADMITTED",
    scheduleAdmissionStatus: "MISSING",
    topologyMode: "UNCHANGED_AUTO_STATION_SET",
    serviceDate,
    observedAt: inWindow.toISOString(),
    freshUntil: nextKstMidnight(serviceDate),
    collectionSha256: sha(JSON.stringify(source)),
    previousArtifactSha256,
    stationSetHash: sha(JSON.stringify(stationIds)),
    odMatrixHash: sha(JSON.stringify(tuples)),
    operationEvidenceSha256: sha(JSON.stringify(source.stationSequences)),
    stationSequenceSha256: sha(JSON.stringify(source.stationSequences)),
    canonicalStationSetSha256: sha(JSON.stringify(stationIds)),
    observedPairSetSha256: sha(JSON.stringify(tuples)),
    admittedPairSetSha256: sha(JSON.stringify(tuples)),
    observedPairChange: {
      addedCount: 0,
      removedCount: 0,
      addedSha256: sha(JSON.stringify([])),
      removedSha256: sha(JSON.stringify([])),
    },
    pairHashes: tuples.map((tuple) => sha(JSON.stringify(tuple))),
    reconstructionSummary,
    credentialRedacted: true,
  };
  artifact.evidenceHash = sha(JSON.stringify(artifact));
  return artifact;
}

function kstDate(value) {
  return new Date(value.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10).replaceAll("-", "");
}

function nextKstMidnight(serviceDate) {
  const date = new Date(Date.UTC(Number(serviceDate.slice(0, 4)), Number(serviceDate.slice(4, 6)) - 1, Number(serviceDate.slice(6, 8))));
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T00:00:00+09:00`;
}

async function rebindStagedActivatedOutputCandidateIds(root, candidateId) {
  if (typeof candidateId !== "string" || !/^capital-pilot-candidate-[0-9]{8}$/u.test(candidateId)) {
    throw new Error("staged candidate identity is invalid");
  }
  const documents = await Promise.all(OUTPUTS.map(async (relative) => ({
    relative,
    bytes: await readFile(path.join(root, relative)),
  })));
  const parsed = documents.map(({ relative, bytes }) => ({ relative, value: JSON.parse(bytes) }));
  const [station, route] = parsed.map(({ value }) => value);
  const stationIds = [station?.candidate?.candidateId, ...(station?.evidenceRows ?? []).map(({ candidateId: value }) => value)];
  const routeIds = [route?.candidate?.candidateId];
  if (!Array.isArray(station?.evidenceRows) || stationIds.length !== station.evidenceRows.length + 1
    || [...stationIds, ...routeIds].some((value) => typeof value !== "string")
    || new Set([...stationIds, ...routeIds]).size !== 1) {
    throw new Error("staged activated output candidate identity is invalid");
  }
  const [previousCandidateId] = stationIds;
  if (previousCandidateId === candidateId) return;
  const before = structuredClone(parsed.map(({ value }) => value));
  station.candidate.candidateId = candidateId;
  for (const row of station.evidenceRows) row.candidateId = candidateId;
  route.candidate.candidateId = candidateId;
  const restored = structuredClone(parsed.map(({ value }) => value));
  restored[0].candidate.candidateId = previousCandidateId;
  for (const row of restored[0].evidenceRows) row.candidateId = previousCandidateId;
  restored[1].candidate.candidateId = previousCandidateId;
  assert.deepEqual(restored, before, "staged candidate rebind must not change other semantics");
  await Promise.all(parsed.map(({ relative, value }) =>
    writeFile(path.join(root, relative), JSON.stringify(value))));
  await rebindStagedFacilityCandidateId(root, candidateId);
  await rebindStagedExitCandidateId(root, candidateId);
}

async function stagedStaticEvidenceIdentity(root) {
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json")).then(JSON.parse),
  ]);
  const selected = candidate.sourceSnapshotIds.map((snapshotId) =>
    snapshots.find((row) => row.snapshotId === snapshotId));
  if (selected.some((row) => row == null)) throw new Error("staged static successor ledger is incomplete");
  const staticIndex = selected.findIndex(({ projectionMigration }) =>
    projectionMigration?.migrationKind === "CROSS_SOURCE_CANONICAL_REPLACEMENT");
  const molitIndex = selected.findIndex(({ sourceId }) => sourceId === "molit-urban-rail-full-route");
  const seoulIndex = selected.findIndex(({ sourceId }) => sourceId === "seoul-metro-accessibility");
  if (staticIndex < 0 || molitIndex < 0 || seoulIndex < 0) {
    throw new Error("staged static successor evidence lineage is incomplete");
  }
  const predecessorIds = candidate.sourceSnapshotIds.map((snapshotId, index) =>
    index === staticIndex ? selected[index].projectionMigration.replacedSnapshotId
      : index === molitIndex ? selected[index].previousSnapshotId
      : snapshotId);
  const evidenceIds = new Set(predecessorIds.flatMap((snapshotId, index) => {
    const sourceId = candidate.sourceSnapshots[index].sourceId;
    if (sourceId === "seoul-metro-transfer-distance-duration") return [];
    return [sourceId === "seoul-metro-accessibility" ? selected[seoulIndex].previousSnapshotId : snapshotId];
  }));
  const evidence = snapshots.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  if (evidenceIds.size !== 6 || evidence.length !== 6) {
    throw new Error("staged static successor evidence set is incomplete");
  }
  return { candidateId: candidate.candidateId, sourceSetSha256: sha(JSON.stringify(evidence)) };
}

async function rebindStagedFacilityCandidateId(root, candidateId, sourceSetSha256) {
  const relative = "tools/datapack/release/current-capital-facility-source-admission.json";
  const admission = JSON.parse(await readFile(path.join(root, relative)));
  admission.candidate.candidateId = candidateId;
  if (sourceSetSha256 != null) admission.candidate.sourceSnapshotSetHash = sourceSetSha256;
  const { admissionDigest: _previousAdmissionDigest, ...payload } = admission;
  admission.admissionDigest = sha(canonical(payload));
  await writeFile(path.join(root, relative), `${canonical(admission)}\n`);
}

async function rebindStagedExitCandidateId(root, candidateId, sourceSetSha256) {
  const admissionPath = "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json";
  const receiptPath = "tools/datapack/release/current-exit-admission-v2/exit-path-admission-artifact-receipt.json";
  const [admission, receipt] = await Promise.all([
    readFile(path.join(root, admissionPath)).then(JSON.parse),
    readFile(path.join(root, receiptPath)).then(JSON.parse),
  ]);
  admission.candidate.candidateId = candidateId;
  if (sourceSetSha256 != null) admission.candidate.sourceSetSha256 = sourceSetSha256;
  for (const row of admission.materializerEvidenceRows) {
    row.candidateId = candidateId;
    if (sourceSetSha256 != null) row.sourceSetSha256 = sourceSetSha256;
  }
  const { admissionDigest: _previousAdmissionDigest, ...admissionPayload } = admission;
  admission.admissionDigest = sha(canonical(admissionPayload));
  const admissionBytes = Buffer.from(canonical(admission));
  receipt.admissionDigest = admission.admissionDigest;
  receipt.admissionSha256 = sha(admissionBytes);
  const { receiptSha256: _previousReceiptSha256, ...receiptPayload } = receipt;
  receipt.receiptSha256 = sha(canonical(receiptPayload));
  await Promise.all([
    writeFile(path.join(root, admissionPath), admissionBytes),
    writeFile(path.join(root, receiptPath), canonical(receipt)),
  ]);
}

async function copyCurrentCandidateEvidenceInputs(root, candidate) {
  const facility = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/current-capital-facility-source-admission.json"), "utf8"));
  const paths = [
    facility.sourceIdentity.snapshotPath,
    candidate.itxTopologyEvidencePath,
    candidate.networkEdgeEvidence?.capitalTopology?.path,
    candidate.networkEdgeEvidence?.capitalTopologyCandidate?.path,
    candidate.networkEdgeEvidence?.capitalTopologyReverification?.path,
    candidate.networkEdgeEvidence?.itxCoverageContract?.path,
    candidate.networkEdgeEvidence?.itxCurrentTopologyAdmission?.path,
  ];
  for (const relative of paths) {
    if (relative == null) continue;
    if (typeof relative !== "string") throw new Error("current candidate evidence path is invalid");
    const source = path.resolve(ROOT, relative);
    if (relative.length === 0 || path.isAbsolute(relative)
      || !source.startsWith(`${ROOT}${path.sep}`)) {
      throw new Error("current candidate evidence path is unsafe");
    }
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error("current candidate evidence path is unsafe");
    }
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }
}

async function bindCurrentCandidateApprovalFixture(root) {
  const paths = {
    candidate: "tools/datapack/release/candidate-build-spec.json",
    request: "tools/datapack/release/release-request.json",
    hashes: "tools/datapack/release/hash-evidence.json",
    snapshots: "tools/datapack/release/source-snapshots.json",
    inventory: "tools/datapack/source-inventory.json",
    pack: "tools/datapack/release/capital-production-canonical-pack.json",
  };
  const [candidateBytes, requestBytes, hashesBytes, snapshotsBytes, inventoryBytes, packBytes] = await Promise.all(
    Object.values(paths).map((relative) => readFile(path.join(root, relative))),
  );
  const [candidate, request, hashes, snapshots, inventory] = [candidateBytes, requestBytes, hashesBytes, snapshotsBytes, inventoryBytes]
    .map((bytes) => JSON.parse(bytes));
  const stale = releaseRequestBindingViolations({
    buildSpec: candidate,
    buildSpecSha256: sha(candidateBytes),
    releaseRequest: request,
  });
  assert.ok(stale.length > 0, "tracked approval fixture must not be treated as current candidate approval");
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  const selected = snapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  assert.equal(selected.length, candidate.sourceSnapshotIds.length);
  assert.equal(sha(JSON.stringify(selected)), candidate.sourceSnapshotSetHash);
  const nextRequest = {
    ...request,
    candidateId: candidate.candidateId,
    buildSpecSha256: sha(candidateBytes),
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
    approvedLedgerHash: candidate.approvedAliasLedgerHash,
  };
  const nextHashes = structuredClone(hashes);
  nextHashes.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  nextHashes.sourceInventorySha256.value = sha(JSON.stringify(inventory));
  nextHashes.fixturePath.sha256 = sha(packBytes);
  nextHashes.sourceSnapshots.order = `release snapshot 순서: ${selected.map(({ sourceId }) => sourceId).join(" → ")}`;
  nextHashes.perSourceEvidence = selected.map((snapshot) => ({
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    rawSha256: snapshot.rawSha256,
    adminReviewRecordHash: inventory.sources.find(({ id }) => id === snapshot.sourceId).admissionEvidence.adminReviewRecordHash,
    perSourceSnapshotSetHash: sha(JSON.stringify([snapshot])),
  }));
  const nextRequestBytes = Buffer.from(`${JSON.stringify(nextRequest, null, 2)}\n`);
  assert.deepEqual(releaseRequestBindingViolations({
    buildSpec: candidate,
    buildSpecSha256: sha(candidateBytes),
    releaseRequest: JSON.parse(nextRequestBytes),
  }), []);
  await Promise.all([
    writeFile(path.join(root, paths.request), nextRequestBytes),
    writeFile(path.join(root, paths.hashes), `${JSON.stringify(nextHashes, null, 2)}\n`),
  ]);
}

async function expectedCurrentBytes(root) {
  return (await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }))
    .map(({ bytes }) => bytes);
}

async function writeRefreshLease(root, lease) {
  const lock = path.join(root, "tools/datapack/.current-capital-accessibility-refresh.lock");
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, "owner.json"), JSON.stringify(lease));
}
