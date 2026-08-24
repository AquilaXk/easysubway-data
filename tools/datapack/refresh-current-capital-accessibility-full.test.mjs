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
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUTS = [
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");

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
  const incheonPath = path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260814.json");
  const incheonSnapshot = JSON.parse(await readFile(incheonPath, "utf8"));
  delete incheonSnapshot.stationCodeCorrections;
  incheonSnapshot.stationCodeDerivations = currentIncheonStationCodeDerivations();
  await writeFile(incheonPath, `${JSON.stringify(incheonSnapshot)}\n`);
  const currentCandidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  await copyCurrentCandidateEvidenceInputs(root, currentCandidate);
  const { inWindow: now } = await currentTopologyAdmissionClock(ROOT);
  await bindCurrentCandidateApprovalFixture(root);
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  await activateSyntheticCurrentStaticNetworkSuccessors(root, { now });
  return root;
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
