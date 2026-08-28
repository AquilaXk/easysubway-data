import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentCapitalAccessibilityRefreshOutputs, commitCurrentCapitalAccessibilityRefresh, refreshCurrentCapitalAccessibilityFull } from "./refresh-current-capital-accessibility-full.mjs";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";
import { activateSyntheticCurrentStaticNetworkSuccessors, nextSyntheticCurrentStaticNetworkNow } from "./test-fixtures/current-public-route-map-successor.mjs";
import { currentizeFreshFacilitySource, prepareCurrentFullCapitalProductionRepository, writeFreshCurrentAccessibilityOutputs, writeFreshExitAdmissionChain } from "./test-fixtures/current-full-capital-production-artifact.mjs";
import {
  buildCurrentTopologyRefreshPrimaryOutputs,
  collectLayoutTopologySnapshotBytes,
  collectPositionSnapshotBytes,
} from "./activate-current-source-set.mjs";
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

test("activated full-capital inputs are rebuilt across the exact public static-network V2 successor boundary", async (t) => {
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
  assert.equal(route.routeEdges.length, 2664);
  assert.deepEqual(await Promise.all(approvalPaths.map((relative) => readFile(path.join(root, relative)))), approvalInputs);
});

test("atomic public V2 route-map and MOLIT heads refresh the exact two-source predecessor boundary", async (t) => {
  const root = await stagedRefreshRepository(t);
  const beforeStation = JSON.parse(await readFile(path.join(root, OUTPUTS[0]), "utf8"));
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));

  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
  const [station, route] = outputs.map(({ bytes }) => JSON.parse(bytes));

  assert.notEqual(beforeStation.candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
  assert.equal(station.candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
  assert.equal(route.candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
});

test("pre-approval candidate phase keeps stale approval bytes outside the candidate refresh proof", async (t) => {
  const root = await stagedRefreshRepository(t);
  const candidatePath = "tools/datapack/release/candidate-build-spec.json";
  const candidateBytes = await readFile(path.join(root, candidatePath));
  const candidate = JSON.parse(candidateBytes);
  const fixtureBytes = await readFile(path.join(root, candidate.fixturePath));
  const approvalPaths = [
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/hash-evidence.json",
  ];
  const staleApprovalBytes = [Buffer.from("{"), Buffer.from("not-json")];
  await Promise.all(approvalPaths.map((relative, index) =>
    writeFile(path.join(root, relative), staleApprovalBytes[index])));

  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }),
    /invalid JSON/,
  );
  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({
    repositoryRoot: root,
    phase: "PRE_APPROVAL_CURRENT_CANDIDATE",
    candidateBuildSpec: candidate,
    canonicalPack: JSON.parse(fixtureBytes),
  });

  assert.equal(JSON.parse(outputs[0].bytes).candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
  assert.equal(JSON.parse(outputs[1].bytes).candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
  assert.deepEqual(
    await Promise.all(approvalPaths.map((relative) => readFile(path.join(root, relative)))),
    staleApprovalBytes,
  );
});

test("pre-approval candidate phase rejects unknown, one-sided, and non-canonical overrides", async (t) => {
  const root = await stagedRefreshRepository(t);
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")));
  const canonicalPack = JSON.parse(await readFile(path.join(root, candidate.fixturePath)));
  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root, phase: "UNKNOWN" }),
    /phase mismatch/,
  );
  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({
      repositoryRoot: root,
      phase: "PRE_APPROVAL_CURRENT_CANDIDATE",
      candidateBuildSpec: candidate,
    }),
    /per-run input mismatch/,
  );
  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({
      repositoryRoot: root,
      phase: "PRE_APPROVAL_CURRENT_CANDIDATE",
      candidateBuildSpec: { ...candidate, candidateId: "other" },
      canonicalPack,
    }),
    /candidate override mismatch/,
  );
  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({
      repositoryRoot: root,
      phase: "PRE_APPROVAL_CURRENT_CANDIDATE",
      candidateBuildSpec: candidate,
      canonicalPack: { ...canonicalPack, packs: [] },
    }),
    /canonical override mismatch/,
  );
});

test("public V2 transition rejects legacy metadata, wrong-source predecessor, and selected source drift", async (t) => {
  for (const mutate of [
    async (root) => {
      const { candidate, snapshots } = await readCurrentStaticBoundary(root);
      const positions = selectedSnapshot(candidate, snapshots, "seoul-metro-route-map-positions");
      positions.projectionMigration = { migrationKind: "CROSS_SOURCE_CANONICAL_REPLACEMENT" };
      await rebindCurrentStaticBoundary(root, candidate, snapshots);
    },
    async (root) => {
      const { candidate, snapshots } = await readCurrentStaticBoundary(root);
      const positions = selectedSnapshot(candidate, snapshots, "seoul-metro-route-map-positions");
      positions.previousSnapshotId = selectedSnapshot(candidate, snapshots, "molit-urban-rail-full-route").previousSnapshotId;
      await rebindCurrentStaticBoundary(root, candidate, snapshots);
    },
    async (root) => {
      const { candidate } = await readCurrentStaticBoundary(root);
      const positionIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
      candidate.sourceSnapshots[positionIndex].sourceId = "molit-urban-rail-full-route";
      await rebindCurrentStaticBoundary(root, candidate);
    },
  ]) {
    const root = await stagedRefreshRepository(t);
    await mutate(root);
    await assert.rejects(buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }), /legacy metadata|v2 predecessor|source identity/i);
  }
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
  assert.equal(route.routeEdges.length, 2664);
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
    const expected = await expectedCurrentBytes(root);
    const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
    const [candidate, facility, exit] = await Promise.all([
      readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")).then(JSON.parse),
      readFile(path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json")).then(JSON.parse),
      readFile(path.join(root, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json")).then(JSON.parse),
    ]);
    assert.notEqual(facility.candidate.sourceSnapshotSetHash, candidate.sourceSnapshotSetHash, `${state} FACILITY transition binding`);
    assert.notEqual(exit.candidate.sourceSetSha256, candidate.sourceSnapshotSetHash, `${state} EXIT transition binding`);
    const records = OUTPUTS.map((relative, index) => ({ relative, before: before[index].toString("base64"), beforeSha256: sha(before[index]), after: expected[index].toString("base64"), afterSha256: sha(expected[index]) }));
    if (state === "PREPARED") for (const [index, relative] of OUTPUTS.entries()) await writeFile(path.join(root, relative), expected[index]);
    if (state === "COMMITTED") for (const [index, relative] of OUTPUTS.entries()) await writeFile(path.join(root, relative), before[index]);
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

test("already-current activated outputs preserve exact bytes through the current live-chain fan-in", async (t) => {
  const root = await prepareCurrentFullCapitalProductionRepository(ROOT);
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));

  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
  assert.deepEqual(outputs.map(({ bytes }) => bytes), before);

  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  assert.deepEqual(await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))), before);
});

test("pre-approval uses the validated current live-chain fan-in for the current production fixture", async (t) => {
  const root = await prepareCurrentFullCapitalProductionRepository(ROOT);
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")));
  const canonicalPack = JSON.parse(await readFile(path.join(root, candidate.fixturePath)));
  const before = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));

  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({
    repositoryRoot: root,
    phase: "PRE_APPROVAL_CURRENT_CANDIDATE",
    candidateBuildSpec: candidate,
    canonicalPack,
  });

  assert.deepEqual(outputs.map(({ bytes }) => bytes), before);
});

test("pre-approval rejects a current live-chain fan-in replacement before commit", async (t) => {
  const root = await prepareCurrentFullCapitalProductionRepository(ROOT);
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")));
  const canonicalPack = JSON.parse(await readFile(path.join(root, candidate.fixturePath)));
  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({
    repositoryRoot: root,
    phase: "PRE_APPROVAL_CURRENT_CANDIDATE",
    candidateBuildSpec: candidate,
    canonicalPack,
  });

  await assert.rejects(commitCurrentCapitalAccessibilityRefresh({
    repositoryRoot: root,
    outputs,
    beforeCommit: async () => writeFile(
      path.join(root, "tools/datapack/release/current-capital-live-chain-fan-in.json"),
      "{}",
    ),
  }), /input changed during refresh/);
});

test("already-current activated outputs without a valid current fan-in fail closed", async (t) => {
  const root = await prepareCurrentFullCapitalProductionRepository(ROOT);
  t.after(() => rm(root, { recursive: true, force: true }));
  await unlink(path.join(root, "tools/datapack/release/current-capital-live-chain-fan-in.json"));

  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }),
    /current-capital-live-chain-fan-in\.json must be a regular non-symlink file/,
  );
});

test("already-current canonical corruption fails closed instead of being returned or rewritten", async (t) => {
  const root = await stagedRefreshRepository(t);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  const stationPath = path.join(root, OUTPUTS[0]); const station = JSON.parse(await readFile(stationPath, "utf8"));
  station.evidenceRows[0].evidenceReason = "corrupt";
  await writeFile(stationPath, JSON.stringify(station));
  await assert.rejects(refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root }), /current-capital refresh evidence delta mismatch/);
});

test("current output headers with a one-sided producer boundary fail closed", async (t) => {
  const root = await stagedRefreshRepository(t);
  const expected = await expectedCurrentBytes(root);
  await Promise.all(OUTPUTS.map((relative, index) => writeFile(path.join(root, relative), expected[index])));
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")));
  await rebindStagedFacilityCandidateId(root, candidate.candidateId, candidate.sourceSnapshotSetHash);

  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }),
    /activated producer boundary mismatch/,
  );
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
  await writeStagedExitOciReceipt(root);
  const currentCandidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  await copyCurrentCandidateEvidenceInputs(root, currentCandidate);
  const { inWindow: now, candidateId, sourceSetSha256 } = await stageCurrentTopologyFixture(root);
  await rebindStagedActivatedOutputCandidateIds(root, candidateId, sourceSetSha256);
  await bindCurrentCandidateApprovalFixture(root);
  await activateSyntheticCurrentStaticNetworkSuccessors(root, { now });
  const facilityNow = await nextSyntheticCurrentStaticNetworkNow(root);
  const canonicalPackPath = path.join(root, "tools/datapack/release/capital-production-canonical-pack.json");
  const canonicalPackBytesBeforeFacilityCurrentization = await readFile(canonicalPackPath);
  await currentizeFreshFacilitySource(root, facilityNow);
  assert.equal((await readFile(canonicalPackPath)).equals(canonicalPackBytesBeforeFacilityCurrentization), true);
  await writeFreshExitAdmissionChain(root, facilityNow);
  await writeFreshCurrentAccessibilityOutputs(root);
  const finalEvidence = await stagedStaticEvidenceIdentity(root);
  await rebindStagedActivatedOutputCandidateIds(root, finalEvidence.candidateId, finalEvidence.predecessorSourceSetSha256);
  await Promise.all([
    rebindStagedFacilityCandidateId(root, finalEvidence.candidateId, finalEvidence.sourceSetSha256),
    rebindStagedExitCandidateId(root, finalEvidence.candidateId, finalEvidence.sourceSetSha256),
  ]);
  return root;
}

async function writeStagedExitOciReceipt(root) {
  const normalizedPath = "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json";
  const admissionPath = "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json";
  const receiptPath = "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json";
  const [normalizedBytes, admissionBytes] = await Promise.all([
    readFile(path.join(root, normalizedPath)),
    readFile(path.join(root, admissionPath)),
  ]);
  const providerCollectionBundleBytes = Buffer.from("synthetic-current-exit-provider");
  const providerObjectSha256 = sha(providerCollectionBundleBytes);
  const receipt = buildCurrentExitAdmissionOciReceipt({
    repository: "AquilaXk/easysubway-data",
    mainSha: "a".repeat(40),
    operationId: "synthetic-current-refresh",
    providerCapturedAt: "2026-08-01T00:00:00.000Z",
    providerCollectionBundleBytes,
    providerObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${"a".repeat(40)}/operations/synthetic-current-refresh/provider-collections/20260801-${providerObjectSha256}.json`,
    providerObjectSha256,
    providerObjectByteSize: providerCollectionBundleBytes.length,
    normalizedBytes,
    admissionBytes,
  });
  await writeFile(path.join(root, receiptPath), canonicalCurrentExitAdmissionOciReceiptJson(receipt));
}

// Staged repository 전용 bootstrap이다. inventory가 선언한 현재 Incheon producer
// snapshots의 exact bytes만 사용해 static-successor transaction을 재현한다.
async function stageCurrentTopologyFixture(root) {
  const [baseSpec, sourceInventory, canonical, productionInput, policyBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-inventory.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json")),
  ]);
  const admission = sourceInventory.sources
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.currentTopologyAdmission)
    .find(({ topologySnapshotId } = {}) => /^capital-route-topology-[0-9]{8}$/u.test(topologySnapshotId));
  if (admission == null) throw new Error("staged current capital topology admission is missing");
  const currentTopologyPath = `tools/datapack/sources/${admission.topologySnapshotId}.json`;
  const currentTopologyBytes = await readFile(path.join(root, currentTopologyPath));
  const currentTopology = JSON.parse(currentTopologyBytes);
  const { inWindow } = await currentTopologyAdmissionClock(root);
  const currentItxTopologyEvidencePath = baseSpec.itxTopologyEvidencePath;
  const currentItxTopologyEvidenceBytes = await readFile(path.join(root, currentItxTopologyEvidencePath));
  const currentIncheonTopology = await admittedIncheonSnapshot(
    root, sourceInventory, "incheon-transit-station-info", "topologyAdmissionEvidence",
  );
  const currentIncheonAccessibility = await admittedIncheonSnapshot(
    root, sourceInventory, "incheon-transit-accessibility", "accessibilityAdmissionEvidence",
  );
  const currentIncheonLine1Timetable = await admittedIncheonSnapshot(
    root, sourceInventory, "incheon-line1-train-timetable", "scheduleAdmissionEvidence",
  );
  const currentIncheonLine2Timetable = await admittedIncheonSnapshot(
    root, sourceInventory, "incheon-line2-train-timetable", "scheduleAdmissionEvidence",
  );
  const exactCurrentSnapshots = [
    currentTopology,
    currentIncheonTopology.value,
    currentIncheonAccessibility.value,
    currentIncheonLine1Timetable.value,
    currentIncheonLine2Timetable.value,
  ];
  const capturedAt = exactCurrentSnapshots.map(({ capturedAt: value }) => Date.parse(value));
  const freshUntil = exactCurrentSnapshots.map(({ freshUntil: value }) => Date.parse(value));
  assert.ok(
    capturedAt.every(Number.isFinite) && freshUntil.every(Number.isFinite),
    "staged exact current snapshots must have finite validity bounds",
  );
  const buildNow = new Date(Math.max(inWindow.getTime(), ...capturedAt) + 1);
  assert.ok(
    freshUntil.every((value) => buildNow.getTime() < value),
    "staged exact current snapshots must share a validity window",
  );
  const baselineTopologyBytes = await readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json"));
  const result = buildCurrentTopologyRefreshPrimaryOutputs({
    baseSpec,
    builderGitSha: baseSpec.builderGitSha,
    sourceInventory,
    currentTopology,
    currentTopologyBytes,
    currentTopologyPath,
    currentIncheonTopology: currentIncheonTopology.value,
    currentIncheonTopologyBytes: currentIncheonTopology.bytes,
    currentIncheonTopologyPath: currentIncheonTopology.snapshotPath,
    currentIncheonAccessibility: currentIncheonAccessibility.value,
    currentIncheonAccessibilityBytes: currentIncheonAccessibility.bytes,
    currentIncheonAccessibilityPath: currentIncheonAccessibility.snapshotPath,
    currentIncheonTimetables: {
      1: currentIncheonLine1Timetable.value,
      2: currentIncheonLine2Timetable.value,
    },
    currentIncheonTimetableBytes: {
      1: currentIncheonLine1Timetable.bytes,
      2: currentIncheonLine2Timetable.bytes,
    },
    currentIncheonTimetablePaths: {
      1: currentIncheonLine1Timetable.snapshotPath,
      2: currentIncheonLine2Timetable.snapshotPath,
    },
    currentItxTopologyEvidencePath,
    currentItxTopologyEvidenceBytes,
    baselineTopology: JSON.parse(baselineTopologyBytes),
    baselineTopologyBytes,
    canonical,
    productionInput,
    productionScopePolicyBytes: policyBytes,
    buildNow: buildNow.toISOString(),
    snapshotBytesByPath: await collectPositionSnapshotBytes(sourceInventory, root),
    layoutTopologySnapshotBytesById: await collectLayoutTopologySnapshotBytes(sourceInventory, root),
  });
  result.spec.publishedAt = buildNow.toISOString();
  result.spec.sourceInventorySha256 = sha(JSON.stringify(result.sourceInventory));
  const reverificationPath = result.spec.networkEdgeEvidence.capitalTopologyReverification.path;
  await Promise.all([
    writeFile(path.join(root, "tools/datapack/source-inventory.json"), result.sourceInventoryBytes),
    writeFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), result.canonicalBytes),
    writeFile(path.join(root, reverificationPath), result.topologyReverificationBytes),
    writeFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), `${JSON.stringify(result.spec, null, 2)}\n`),
  ]);
  return { inWindow: buildNow, candidateId: result.spec.candidateId, sourceSetSha256: result.spec.sourceSnapshotSetHash };
}

async function admittedIncheonSnapshot(root, sourceInventory, sourceId, admissionField) {
  assert.ok(Array.isArray(sourceInventory?.sources), "staged source inventory must contain sources");
  const sources = sourceInventory.sources.filter(({ id }) => id === sourceId);
  assert.equal(sources.length, 1, `staged ${sourceId} source must be unique`);
  const admission = sources[0][admissionField];
  assert.ok(admission && typeof admission === "object", `staged ${sourceId} admission must be present`);
  const { snapshotPath } = admission;
  assert.equal(typeof snapshotPath, "string", `staged ${sourceId} admission path must be present`);
  assert.ok(snapshotPath.startsWith("tools/datapack/sources/"), `staged ${sourceId} admission path must be tracked`);
  const absolute = path.resolve(root, snapshotPath);
  assert.ok(absolute.startsWith(`${path.resolve(root, "tools/datapack/sources")}${path.sep}`), `staged ${sourceId} admission path must be contained`);
  const bytes = await readFile(absolute);
  const value = JSON.parse(bytes);
  assert.equal(bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`)), true, `staged ${sourceId} snapshot bytes must be exact`);
  return { snapshotPath, bytes, value };
}

async function rebindStagedActivatedOutputCandidateIds(root, candidateId, sourceSetSha256) {
  if (typeof candidateId !== "string" || !/^capital-pilot-candidate-[0-9]{8}$/u.test(candidateId)) {
    throw new Error("staged candidate identity is invalid");
  }
  if (typeof sourceSetSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sourceSetSha256)) {
    throw new Error("staged candidate source set is invalid");
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
  if (previousCandidateId === candidateId
    && station.candidate.sourceSetSha256 === sourceSetSha256
    && route.candidate.sourceSetSha256 === sourceSetSha256) return;
  const before = structuredClone(parsed.map(({ value }) => value));
  station.candidate.candidateId = candidateId; station.candidate.sourceSetSha256 = sourceSetSha256;
  for (const row of station.evidenceRows) row.candidateId = candidateId;
  route.candidate.candidateId = candidateId; route.candidate.sourceSetSha256 = sourceSetSha256;
  const restored = structuredClone(parsed.map(({ value }) => value));
  restored[0].candidate.candidateId = previousCandidateId; restored[0].candidate.sourceSetSha256 = before[0].candidate.sourceSetSha256;
  for (const row of restored[0].evidenceRows) row.candidateId = previousCandidateId;
  restored[1].candidate.candidateId = previousCandidateId; restored[1].candidate.sourceSetSha256 = before[1].candidate.sourceSetSha256;
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
  const positionIndex = selected.findIndex(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  const molitIndex = selected.findIndex(({ sourceId }) => sourceId === "molit-urban-rail-full-route");
  const seoulIndex = selected.findIndex(({ sourceId }) => sourceId === "seoul-metro-accessibility");
  if (positionIndex < 0 || molitIndex < 0 || seoulIndex < 0
    || [selected[positionIndex], selected[molitIndex]].some((snapshot) =>
      snapshot?.publicStaticNetworkV2Observation?.artifactKind !== "public-static-network-v2-observation"
      || typeof snapshot.previousSnapshotId !== "string"
      || Object.hasOwn(snapshot, "projectionMigration")
      || Object.hasOwn(snapshot, "migration"))) {
    throw new Error("staged static successor evidence lineage is incomplete");
  }
  const predecessorIds = candidate.sourceSnapshotIds.map((snapshotId, index) =>
    index === positionIndex ? selected[index].previousSnapshotId
      : index === molitIndex ? selected[index].previousSnapshotId
      : snapshotId);
  const evidenceIds = new Set(predecessorIds.flatMap((snapshotId, index) => {
    const sourceId = candidate.sourceSnapshots[index].sourceId;
    if (sourceId === "seoul-metro-transfer-distance-duration") return [];
    return [sourceId === "seoul-metro-accessibility" ? selected[seoulIndex].previousSnapshotId : snapshotId];
  }));
  const predecessorIdSet = new Set(predecessorIds);
  const predecessor = snapshots.filter(({ snapshotId }) => predecessorIdSet.has(snapshotId));
  const evidence = snapshots.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  if (predecessorIdSet.size !== 7 || predecessor.length !== 7
    || evidenceIds.size !== 6 || evidence.length !== 6) {
    throw new Error("staged static successor evidence set is incomplete");
  }
  return {
    candidateId: candidate.candidateId,
    predecessorSourceSetSha256: sha(JSON.stringify(predecessor)),
    sourceSetSha256: sha(JSON.stringify(evidence)),
  };
}

async function readCurrentStaticBoundary(root) {
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json")).then(JSON.parse),
  ]);
  return { candidate, snapshots };
}

function selectedSnapshot(candidate, snapshots, sourceId) {
  const index = candidate.sourceSnapshots.findIndex(({ sourceId: actual }) => actual === sourceId);
  const snapshot = snapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[index]);
  if (index < 0 || !snapshot) throw new Error("staged public V2 selected snapshot is incomplete");
  return snapshot;
}

async function rebindCurrentStaticBoundary(root, candidate, snapshots) {
  const candidatePath = "tools/datapack/release/candidate-build-spec.json";
  const snapshotsPath = "tools/datapack/release/source-snapshots.json";
  const requestPath = "tools/datapack/release/release-request.json";
  const hashesPath = "tools/datapack/release/hash-evidence.json";
  if (snapshots != null) {
    const selectedIds = new Set(candidate.sourceSnapshotIds);
    candidate.sourceSnapshotSetHash = sha(JSON.stringify(snapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId))));
    await writeFile(path.join(root, snapshotsPath), `${JSON.stringify(snapshots)}\n`);
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
  const [request, hashes] = await Promise.all([
    readFile(path.join(root, requestPath)).then(JSON.parse),
    readFile(path.join(root, hashesPath)).then(JSON.parse),
  ]);
  request.buildSpecSha256 = sha(candidateBytes);
  request.sourceSnapshotSetHash = candidate.sourceSnapshotSetHash;
  hashes.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  await Promise.all([
    writeFile(path.join(root, candidatePath), candidateBytes),
    writeFile(path.join(root, requestPath), `${JSON.stringify(request)}\n`),
    writeFile(path.join(root, hashesPath), `${JSON.stringify(hashes)}\n`),
  ]);
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
  const receiptPath = "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json";
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
