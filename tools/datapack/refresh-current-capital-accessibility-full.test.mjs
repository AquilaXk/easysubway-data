import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertExactCurrentCapitalFacilityEvidenceTransition,
  assertPendingMarkerProducerBoundary,
  buildCurrentCapitalAccessibilityRefreshOutputs,
  refreshCurrentCapitalAccessibilityFull,
} from "./refresh-current-capital-accessibility-full.mjs";
import { buildAuthenticatedCurrentCapitalFacilityEvidenceRows } from "./build-current-capital-station-line-input.mjs";
import { buildCurrentExitAdmissionOciReceipt, canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { buildReboundCurrentExitAdmissionIdentities } from "./rebind-current-exit-admission-identities.mjs";
import { rebindCurrentActiveFacilityDerivedIdentity } from "./rebind-current-active-facility-derived-identity.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";
import { activateSyntheticCurrentStaticNetworkSuccessors, nextSyntheticCurrentStaticNetworkNow } from "./test-fixtures/current-public-route-map-successor.mjs";
import { currentizeFreshFacilitySource, writeFreshCurrentAccessibilityOutputs, writeFreshExitAdmissionChain } from "./test-fixtures/current-full-capital-production-artifact.mjs";
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
const FAN_IN_OUTPUT = "tools/datapack/release/current-capital-live-chain-fan-in.json";
const TRANSACTION_OUTPUTS = [...OUTPUTS, FAN_IN_OUTPUT];
const TRANSITION = "tools/datapack/release/current-capital-accessibility-transition.json";
const SUCCESSOR = "tools/datapack/release/current-capital-accessibility-transition-successor.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const CURRENT_CAPITAL_SOURCE_ROSTER = Object.freeze([
  "seoul-metro-route-map-positions",
  "kric-subway-timetable",
  "seoul-metro-accessibility",
  "kric-station-convenience-standard",
  "molit-urban-rail-full-route",
  "seoulmetro-station-line-info",
  "incheon-transit-accessibility",
  "seoul-metro-transfer-distance-duration",
]);
const PREDECESSOR_SOURCE_ROSTER = Object.freeze(CURRENT_CAPITAL_SOURCE_ROSTER.slice(0, -1));
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
  assert.equal(route.routeEdges.length, 2654);
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
  const root = await stagedPreApprovalRepository(t);
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
  const root = await stagedPreApprovalRepository(t);
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
    const root = await stagedPreApprovalRepository(t);
    await mutate(root);
    await assert.rejects(buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }), /legacy metadata|v2 predecessor|source identity|source-set/i);
  }
});

test("pending v2 marker accepts FACILITY next-eight and EXIT previous-seven before full fan-in", async (t) => {
  const root = await actualPendingMarkerRepository(t);
  const [baseBytes, marker, facility, exit, beforeStation, beforeRoute] = await Promise.all([
    readFile(path.join(root, TRANSITION)),
    readFile(path.join(root, SUCCESSOR)).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json")).then(JSON.parse),
    readFile(path.join(root, OUTPUTS[0])).then(JSON.parse),
    readFile(path.join(root, OUTPUTS[1])).then(JSON.parse),
  ]);
  assert.equal(marker.supersededTransition.sha256, sha(baseBytes));
  assert.equal(facility.candidate.candidateId, marker.nextCandidate.candidateId);
  assert.equal(facility.candidate.sourceSnapshotSetHash, marker.nextCandidate.sourceSnapshotSetHash);
  assert.equal(exit.candidate.candidateId, marker.nextCandidate.candidateId);
  assert.equal(exit.candidate.sourceSetSha256, marker.previousCandidate.sourceSnapshotSetHash);
  assert.notEqual(beforeStation.candidate.candidateId, marker.nextCandidate.candidateId);
  assert.notEqual(beforeRoute.candidate.candidateId, marker.nextCandidate.candidateId);
  assert.equal(beforeStation.candidate.sourceSetSha256, marker.previousCandidate.sourceSnapshotSetHash);
  assert.equal(beforeRoute.candidate.sourceSetSha256, marker.previousCandidate.sourceSnapshotSetHash);
  assert.ok(beforeStation.evidenceRows.every((row) => row.candidateId === marker.previousCandidate.candidateId));
  assert.ok(beforeStation.evidenceRows.every((row) => row.sourceSetSha256 === marker.previousCandidate.sourceSnapshotSetHash));

  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
  for (const { bytes } of outputs) {
    const output = JSON.parse(bytes);
    assert.equal(output.candidate.candidateId, marker.nextCandidate.candidateId);
    assert.equal(output.candidate.sourceSetSha256, marker.nextCandidate.sourceSnapshotSetHash);
  }
  const [stationAfter, routeAfter] = outputs.map(({ bytes }) => JSON.parse(bytes));
  assert.deepEqual(stationAfter.stationLines, beforeStation.stationLines);
  assert.deepEqual(routeAfter.stationLines, beforeRoute.stationLines);
  assert.deepEqual(routeAfter.routeEdges, beforeRoute.routeEdges);
  assert.ok(stationAfter.evidenceRows.every((row) => row.candidateId === marker.nextCandidate.candidateId));
  assert.ok(stationAfter.evidenceRows.every((row) => row.sourceSetSha256 === marker.nextCandidate.sourceSnapshotSetHash));
  assert.deepEqual(
    stationAfter.evidenceRows.map(({ candidateId: _candidateId, sourceSetSha256: _sourceSetSha256, ...row }) => row),
    beforeStation.evidenceRows.map(({ candidateId: _candidateId, sourceSetSha256: _sourceSetSha256, ...row }) => row),
  );

  const routePath = path.join(root, OUTPUTS[1]);
  const mutatedRoute = structuredClone(beforeRoute);
  mutatedRoute.stationLines[0].lineSequence = mutatedRoute.stationLines[0].lineSequence + 1;
  await writeFile(routePath, JSON.stringify(mutatedRoute));
  await assert.rejects(buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }), /topology delta mismatch/);
  await writeFile(routePath, JSON.stringify(beforeRoute));

  const stationPath = path.join(root, OUTPUTS[0]);
  const mutatedStation = structuredClone(beforeStation);
  const facilityEvidence = mutatedStation.evidenceRows.find((row) => row.domain === "FACILITY");
  facilityEvidence.capturedAt = facilityEvidence.capturedAt === "2026-08-30T00:00:00.000Z"
    ? "2026-08-30T00:00:00.001Z"
    : "2026-08-30T00:00:00.000Z";
  await writeFile(stationPath, JSON.stringify(mutatedStation));
  await assert.rejects(buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }), /FACILITY evidence projection mismatch/);
  await writeFile(stationPath, JSON.stringify(beforeStation));
});

test("pending marker authenticates an exact FACILITY snapshot transition", async (t) => {
  const root = await actualPendingMarkerRepository(t);
  const [baseMarker, effectiveMarker, beforeStation] = await Promise.all([
    readFile(path.join(root, TRANSITION)).then(JSON.parse),
    readFile(path.join(root, SUCCESSOR)).then(JSON.parse),
    readFile(path.join(root, OUTPUTS[0])).then(JSON.parse),
  ]);
  const previousFacilityBytes = Buffer.from(effectiveMarker.previousFacilityAdmissionBase64, "base64");
  const previousFacility = JSON.parse(previousFacilityBytes);
  const previousSnapshotBytes = await readFile(path.join(root, previousFacility.sourceIdentity.snapshotPath));
  const [rebuiltStation] = (await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }))
    .map(({ bytes }) => JSON.parse(bytes));
  assert.equal(rebuiltStation.candidate.candidateId, effectiveMarker.nextCandidate.candidateId);
  assert.equal(rebuiltStation.candidate.sourceSetSha256, effectiveMarker.nextCandidate.sourceSnapshotSetHash);
  const expectedBeforeRows = buildAuthenticatedCurrentCapitalFacilityEvidenceRows({
    facilityAdmission: previousFacility,
    facilitySnapshotBytes: previousSnapshotBytes,
    stationLines: beforeStation.stationLines,
    admissionCandidate: baseMarker.nextCandidate,
    outputCandidate: beforeStation.candidate,
    candidatePublishedAt: Date.parse(baseMarker.previousCandidate.canonicalCandidate.publishedAt),
  });
  const beforeFacilityRows = beforeStation.evidenceRows.filter(({ domain }) => domain === "FACILITY");
  assert.deepEqual(beforeFacilityRows, expectedBeforeRows);
  const expectedAfterRows = rebuiltStation.evidenceRows.filter(({ domain }) => domain === "FACILITY");
  assert.doesNotThrow(() => assertExactCurrentCapitalFacilityEvidenceTransition({
    beforeRows: beforeFacilityRows,
    afterRows: expectedAfterRows,
    expectedBeforeRows,
    expectedAfterRows,
  }));

  const corrupted = structuredClone(beforeFacilityRows);
  const row = corrupted.find(({ providerRecordHash }) => providerRecordHash !== null);
  row.providerRecordHash = row.providerRecordHash === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
  assert.throws(
    () => assertExactCurrentCapitalFacilityEvidenceTransition({
      beforeRows: corrupted,
      afterRows: expectedAfterRows,
      expectedBeforeRows,
      expectedAfterRows,
    }),
    /FACILITY evidence projection mismatch/,
  );
});

test("pending marker producer boundary distinguishes base prestates from effective evidence", async (t) => {
  const root = await actualPendingMarkerRepository(t);
  const [baseMarker, effectiveMarker, candidate, facility, exit, station, route] = await Promise.all([
    readFile(path.join(root, TRANSITION)).then(JSON.parse),
    readFile(path.join(root, SUCCESSOR)).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json")).then(JSON.parse),
    readFile(path.join(root, OUTPUTS[0])).then(JSON.parse),
    readFile(path.join(root, OUTPUTS[1])).then(JSON.parse),
  ]);

  const currentSourceSetSha256 = "a".repeat(64);
  const refreshedPredecessorSourceSetSha256 = "b".repeat(64);
  candidate.sourceSnapshotSetHash = currentSourceSetSha256;
  facility.candidate.sourceSnapshotSetHash = currentSourceSetSha256;
  effectiveMarker.previousCandidate.candidateId = "capital-accessibility-20260902-refreshed-seven";
  effectiveMarker.previousCandidate.sourceSnapshotSetHash = refreshedPredecessorSourceSetSha256;
  exit.candidate.sourceSetSha256 = refreshedPredecessorSourceSetSha256;
  assert.notEqual(baseMarker.previousCandidate.candidateId, effectiveMarker.previousCandidate.candidateId);
  assert.notEqual(baseMarker.previousCandidate.sourceSnapshotSetHash, effectiveMarker.previousCandidate.sourceSnapshotSetHash);
  assert.equal(effectiveMarker.nextCandidate.candidateId, candidate.candidateId);
  assert.equal(facility.candidate.candidateId, candidate.candidateId);
  assert.equal(facility.candidate.sourceSnapshotSetHash, candidate.sourceSnapshotSetHash);
  assert.equal(exit.candidate.sourceSetSha256, effectiveMarker.previousCandidate.sourceSnapshotSetHash);
  assert.equal(station.candidate.sourceSetSha256, baseMarker.previousCandidate.sourceSnapshotSetHash);
  assert.equal(route.candidate.sourceSetSha256, baseMarker.previousCandidate.sourceSnapshotSetHash);
  assertPendingMarkerProducerBoundary({ baseMarker, effectiveMarker, candidate, facility, exit, station, route });
});

test("pre-approval projection consumes the validated pending v2 marker without mutating tracked bytes", async (t) => {
  const root = await actualPendingMarkerRepository(t);
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")));
  const canonicalPack = JSON.parse(await readFile(path.join(root, candidate.fixturePath)));
  const trackedPaths = [...TRANSACTION_OUTPUTS, TRANSITION, SUCCESSOR];
  const before = await Promise.all(trackedPaths.map((relative) => readFile(path.join(root, relative))));

  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({
    repositoryRoot: root,
    phase: "PRE_APPROVAL_CURRENT_CANDIDATE",
    candidateBuildSpec: candidate,
    canonicalPack,
  });

  for (const { bytes } of outputs) {
    const output = JSON.parse(bytes);
    assert.equal(output.candidate.candidateId, candidate.candidateId);
    assert.equal(output.candidate.sourceSetSha256, candidate.sourceSnapshotSetHash);
  }
  assert.deepEqual(
    await Promise.all(trackedPaths.map((relative) => readFile(path.join(root, relative)))),
    before,
  );
});

test("predecessor-bound activated inputs are rebuilt atomically to exact current bytes", async (t) => {
  const root = await stagedRefreshRepository(t);
  const expected = await expectedCurrentBytes(root);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  assert.deepEqual(await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))), expected);
  await assert.rejects(readFile(path.join(root, TRANSITION)), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, SUCCESSOR)), { code: "ENOENT" });
  const [station, route] = await Promise.all(OUTPUTS.map(async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"))));
  assert.equal(station.evidenceRows.length, 641);
  assert.equal(route.stationLines.length, 1102);
  assert.equal(route.routeEdges.length, 2654);
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

test("PREPARED residue restores the exact marker after a partial deletion", async (t) => {
  const fixture = await transactionRecoveryFixture(t, "PREPARED");
  await assert.rejects(refreshCurrentCapitalAccessibilityFull({ repositoryRoot: fixture.root }));
  assert.deepEqual(await Promise.all(TRANSACTION_OUTPUTS.map((relative) => readFile(path.join(fixture.root, relative)))), fixture.before);
  assert.deepEqual(await readFile(path.join(fixture.root, TRANSITION)), fixture.marker);
  assert.deepEqual(await readFile(path.join(fixture.root, SUCCESSOR)), fixture.successor);
  await assert.rejects(readFile(path.join(fixture.root, "tools/datapack/.current-capital-accessibility-refresh-transaction.json")), { code: "ENOENT" });
});

test("a demonstrably dead refresh owner lease permits PREPARED and COMMITTED journal recovery", async (t) => {
  for (const state of ["PREPARED", "COMMITTED"]) {
    const fixture = await transactionRecoveryFixture(t, state);
    await writeRefreshLease(fixture.root, { schemaVersion: 1, token: "00000000-0000-4000-8000-000000000001", pid: 999999 });

    await assert.rejects(refreshCurrentCapitalAccessibilityFull({ repositoryRoot: fixture.root }));

    assert.deepEqual(await Promise.all(TRANSACTION_OUTPUTS.map((relative) => readFile(path.join(fixture.root, relative)))), state === "PREPARED" ? fixture.before : fixture.after, state);
    if (state === "PREPARED") {
      assert.deepEqual(await readFile(path.join(fixture.root, TRANSITION)), fixture.marker, state);
      assert.deepEqual(await readFile(path.join(fixture.root, SUCCESSOR)), fixture.successor, state);
    } else {
      await assert.rejects(readFile(path.join(fixture.root, TRANSITION)), { code: "ENOENT" }, state);
      await assert.rejects(readFile(path.join(fixture.root, SUCCESSOR)), { code: "ENOENT" }, state);
    }
    await assert.rejects(readFile(path.join(fixture.root, "tools/datapack/.current-capital-accessibility-refresh-transaction.json")), { code: "ENOENT" }, state);
    await assert.rejects(readFile(path.join(fixture.root, "tools/datapack/.current-capital-accessibility-refresh.lock/owner.json")), { code: "ENOENT" }, state);
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
  const root = await stagedRefreshRepository(t);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  const before = await Promise.all(TRANSACTION_OUTPUTS.map((relative) => readFile(path.join(root, relative))));

  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
  assert.deepEqual(outputs.map(({ bytes }) => bytes), before.slice(0, 2));

  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  assert.deepEqual(await Promise.all(TRANSACTION_OUTPUTS.map((relative) => readFile(path.join(root, relative)))), before);
});

test("pre-approval uses the validated current live-chain fan-in for the current production fixture", async (t) => {
  const root = await stagedRefreshRepository(t);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
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

test("pre-approval remains a non-marker phase", async (t) => {
  const root = await stagedRefreshRepository(t);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  await assert.rejects(readFile(path.join(root, TRANSITION)), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, SUCCESSOR)), { code: "ENOENT" });
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

test("already-current activated outputs without a valid current fan-in fail closed", async (t) => {
  const root = await stagedRefreshRepository(t);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  await unlink(path.join(root, "tools/datapack/release/current-capital-live-chain-fan-in.json"));

  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }),
    /current-capital-live-chain-fan-in\.json must be a regular non-symlink file/,
  );
});

test("already-current canonical corruption fails closed instead of being returned or rewritten", async (t) => {
  const root = await stagedRefreshRepository(t);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  const terminalBytes = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative))));
  const terminalOutputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
  assert.deepEqual(terminalOutputs.map(({ bytes }) => bytes), terminalBytes);
  const stationPath = path.join(root, OUTPUTS[0]); const station = JSON.parse(await readFile(stationPath, "utf8"));
  station.evidenceRows[0].evidenceReason = "corrupt";
  await writeFile(stationPath, JSON.stringify(station));
  await assert.rejects(refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root }), /current-capital refresh current output bytes mismatch/);
});

test("current output headers with a one-sided producer boundary fail closed", async (t) => {
  const root = await stagedRefreshRepository(t);
  const expected = await expectedCurrentBytes(root);
  await Promise.all(OUTPUTS.map((relative, index) => writeFile(path.join(root, relative), expected[index])));
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")));
  await rebindStagedFacilityCandidateId(root, candidate.candidateId, candidate.sourceSnapshotSetHash);

  await assert.rejects(
    buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root }),
    /pending marker producer boundary mismatch/,
  );
});

async function stagedRefreshRepository(t) {
  return actualPendingMarkerRepository(t);
}

async function stagedPreApprovalRepository(t) {
  const root = await actualPendingMarkerRepository(t);
  await writeFreshCurrentAccessibilityOutputs(root);
  await Promise.all([
    unlink(path.join(root, TRANSITION)),
    unlink(path.join(root, SUCCESSOR)),
  ]);
  return root;
}

async function actualPendingMarkerRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-capital-refresh-marker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of ["tools/datapack/release", "tools/datapack/inputs", "release/product-gates"]) {
    await cp(path.join(ROOT, relative), path.join(root, relative), { recursive: true });
  }
  for (const relative of [
    "tools/datapack/source-inventory.json", "tools/datapack/source-governance-policy.json",
    "tools/datapack/official-od-fare-admission.json", "tools/datapack/nationwide-coverage-targets.json",
  ]) {
    const destination = path.join(root, relative); await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(ROOT, relative), destination);
  }
  await cp(path.join(ROOT, "tools/datapack/sources"), path.join(root, "tools/datapack/sources"), { recursive: true });
  await copyCurrentCandidateEvidenceInputs(
    root,
    JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"))),
  );
  await rebindCurrentActiveFacilityDerivedIdentity({ repositoryRoot: root });
  const marker = JSON.parse(await readFile(path.join(root, SUCCESSOR), "utf8"));
  const paths = {
    transition: SUCCESSOR,
    normalized: "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
    admission: "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
    receipt: "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, relative]) =>
    [key, await readFile(path.join(root, relative))])));
  const rebound = buildReboundCurrentExitAdmissionIdentities({
    transitionBytes: bytes.transition,
    normalizedBytes: bytes.normalized,
    admissionBytes: bytes.admission,
    receiptBytes: bytes.receipt,
  });
  await Promise.all([
    writeFile(path.join(root, paths.admission), rebound.admissionBytes),
    writeFile(path.join(root, paths.receipt), rebound.receiptBytes),
  ]);
  await writeFreshCurrentAccessibilityOutputs(root);
  await rebindStagedActivatedOutputCandidateIds(
    root,
    marker.previousCandidate.candidateId,
    marker.previousCandidate.sourceSnapshotSetHash,
    { rebindAdmissions: false },
  );
  return root;
}

function refreshRecords(before, after, marker, successor) {
  return [
    ...TRANSACTION_OUTPUTS.map((relative, index) => ({
      operation: "replace", relative, before: before[index].toString("base64"), beforeSha256: sha(before[index]),
      after: after[index].toString("base64"), afterSha256: sha(after[index]),
    })),
    { operation: "delete", relative: TRANSITION, before: marker.toString("base64"), beforeSha256: sha(marker) },
    { operation: "delete", relative: SUCCESSOR, before: successor.toString("base64"), beforeSha256: sha(successor) },
  ];
}

async function transactionRecoveryFixture(t, state) {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-capital-refresh-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = TRANSACTION_OUTPUTS.map((_, index) => Buffer.from(`before-${index}`));
  const after = TRANSACTION_OUTPUTS.map((_, index) => Buffer.from(`after-${index}`));
  const marker = Buffer.from("marker-before");
  const successor = Buffer.from("successor-before");
  for (const [index, relative] of TRANSACTION_OUTPUTS.entries()) {
    const output = path.join(root, relative); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, state === "PREPARED" ? after[index] : before[index]);
  }
  const markerPath = path.join(root, TRANSITION); await mkdir(path.dirname(markerPath), { recursive: true });
  const successorPath = path.join(root, SUCCESSOR);
  if (state === "COMMITTED") await Promise.all([
    writeFile(markerPath, marker),
    writeFile(successorPath, successor),
  ]);
  await writeFile(
    path.join(root, "tools/datapack/.current-capital-accessibility-refresh-transaction.json"),
    JSON.stringify({ schemaVersion: 2, state, records: refreshRecords(before, after, marker, successor) }),
  );
  return { root, before, after, marker, successor };
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
    root, sourceInventory, "incheon-transit-accessibility", "admissionEvidence",
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
  const snapshotPath = admission.snapshotPath ?? (
    sourceId === "incheon-transit-accessibility"
      && admissionField === "admissionEvidence"
      && admission.decision === "APPROVED"
      && admission.sourceId === sourceId
      && typeof admission.snapshotId === "string"
      ? `tools/datapack/sources/${admission.snapshotId}.json`
      : undefined
  );
  assert.equal(typeof snapshotPath, "string", `staged ${sourceId} admission path must be present`);
  assert.ok(snapshotPath.startsWith("tools/datapack/sources/"), `staged ${sourceId} admission path must be tracked`);
  const absolute = path.resolve(root, snapshotPath);
  assert.ok(absolute.startsWith(`${path.resolve(root, "tools/datapack/sources")}${path.sep}`), `staged ${sourceId} admission path must be contained`);
  const bytes = await readFile(absolute);
  const value = JSON.parse(bytes);
  const registeredSnapshotSha256 = sources[0].registrationEvidence?.snapshotFileSha256;
  assert.equal(
    sourceId === "incheon-transit-accessibility" && admissionField === "admissionEvidence"
      ? sha(bytes) === registeredSnapshotSha256
      : bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`)),
    true,
    `staged ${sourceId} snapshot bytes must be exact`,
  );
  return { snapshotPath, bytes, value };
}

async function rebindStagedActivatedOutputCandidateIds(root, candidateId, sourceSetSha256, { rebindAdmissions = true } = {}) {
  if (typeof candidateId !== "string" || !/^(?:capital-pilot-candidate-[0-9]{8}|capital-accessibility-predecessor-[a-f0-9]{64})$/u.test(candidateId)) {
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
  const stationSourceSets = [station?.candidate?.sourceSetSha256, ...(station?.evidenceRows ?? []).map(({ sourceSetSha256: value }) => value)];
  const routeIds = [route?.candidate?.candidateId];
  if (!Array.isArray(station?.evidenceRows) || stationIds.length !== station.evidenceRows.length + 1
    || [...stationIds, ...stationSourceSets, ...routeIds, route?.candidate?.sourceSetSha256].some((value) => typeof value !== "string")
    || new Set([...stationIds, ...routeIds]).size !== 1 || new Set([...stationSourceSets, route.candidate.sourceSetSha256]).size !== 1) {
    throw new Error("staged activated output candidate identity is invalid");
  }
  const [previousCandidateId] = stationIds;
  if (previousCandidateId === candidateId
    && station.candidate.sourceSetSha256 === sourceSetSha256
    && route.candidate.sourceSetSha256 === sourceSetSha256) return;
  const before = structuredClone(parsed.map(({ value }) => value));
  station.candidate.candidateId = candidateId; station.candidate.sourceSetSha256 = sourceSetSha256;
  for (const row of station.evidenceRows) { row.candidateId = candidateId; row.sourceSetSha256 = sourceSetSha256; }
  route.candidate.candidateId = candidateId; route.candidate.sourceSetSha256 = sourceSetSha256;
  const restored = structuredClone(parsed.map(({ value }) => value));
  restored[0].candidate.candidateId = previousCandidateId; restored[0].candidate.sourceSetSha256 = before[0].candidate.sourceSetSha256;
  for (const row of restored[0].evidenceRows) { row.candidateId = previousCandidateId; row.sourceSetSha256 = before[0].candidate.sourceSetSha256; }
  restored[1].candidate.candidateId = previousCandidateId; restored[1].candidate.sourceSetSha256 = before[1].candidate.sourceSetSha256;
  assert.deepEqual(restored, before, "staged candidate rebind must not change other semantics");
  await Promise.all(parsed.map(({ relative, value }) =>
    writeFile(path.join(root, relative), JSON.stringify(value))));
  if (rebindAdmissions) {
    await rebindStagedFacilityCandidateId(root, candidateId);
    await rebindStagedExitCandidateId(root, candidateId);
  }
}

async function stagedStaticEvidenceIdentity(root) {
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")).then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json")).then(JSON.parse),
  ]);
  const selected = candidate.sourceSnapshotIds.map((snapshotId) =>
    snapshots.find((row) => row.snapshotId === snapshotId));
  if (selected.some((row) => row == null)) throw new Error("staged static successor ledger is incomplete");
  if (selected.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length
    || candidate.sourceSnapshots.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length
    || !candidate.sourceSnapshots.every(({ sourceId }, index) => sourceId === CURRENT_CAPITAL_SOURCE_ROSTER[index])) {
    throw new Error("staged static successor roster is incomplete");
  }
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
  const predecessorIds = candidate.sourceSnapshotIds.slice(0, -1).map((snapshotId, index) =>
    index === positionIndex ? selected[index].previousSnapshotId
      : index === molitIndex ? selected[index].previousSnapshotId
      : snapshotId);
  const evidenceIds = new Set(predecessorIds.flatMap((snapshotId, index) => {
    const sourceId = candidate.sourceSnapshots[index].sourceId;
    return [sourceId === "seoul-metro-accessibility" ? selected[seoulIndex].previousSnapshotId : snapshotId];
  }));
  const predecessorIdSet = new Set(predecessorIds);
  const predecessor = snapshots.filter(({ snapshotId }) => predecessorIdSet.has(snapshotId));
  const evidence = snapshots.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  if (predecessorIdSet.size !== PREDECESSOR_SOURCE_ROSTER.length || predecessor.length !== PREDECESSOR_SOURCE_ROSTER.length
    || evidenceIds.size !== PREDECESSOR_SOURCE_ROSTER.length || evidence.length !== PREDECESSOR_SOURCE_ROSTER.length) {
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
