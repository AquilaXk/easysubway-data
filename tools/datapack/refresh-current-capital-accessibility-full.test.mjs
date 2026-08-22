import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentCapitalAccessibilityRefreshOutputs, commitCurrentCapitalAccessibilityRefresh, refreshCurrentCapitalAccessibilityFull } from "./refresh-current-capital-accessibility-full.mjs";
import { readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUTS = [
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("activated full-capital inputs are rebuilt only across the exact Seoul direct-successor boundary", async () => {
  const beforeStation = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json"), "utf8"));
  const beforeRoute = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json"), "utf8"));
  const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: ROOT });
  assert.deepEqual(outputs.map(({ relative }) => relative), [
    "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
    "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  ]);
  const station = JSON.parse(outputs[0].bytes); const route = JSON.parse(outputs[1].bytes);
  assert.equal(station.candidate.sourceSetSha256, beforeStation.candidate.sourceSetSha256);
  assert.equal(route.candidate.sourceSetSha256, beforeRoute.candidate.sourceSetSha256);
  assert.deepEqual(station.stationLines, beforeStation.stationLines);
  assert.deepEqual(route.stationLines, beforeRoute.stationLines);
  assert.deepEqual(route.routeEdges, beforeRoute.routeEdges);
  assert.equal(station.evidenceRows.length, 641);
  assert.equal(route.routeEdges.length, 2674);
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
  const expected = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(ROOT, relative))));
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
  const expected = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(ROOT, relative))));
  const records = OUTPUTS.map((relative, index) => ({ relative, before: before[index].toString("base64"), beforeSha256: sha(before[index]), after: expected[index].toString("base64"), afterSha256: sha(expected[index]) }));
  for (const [index, relative] of OUTPUTS.entries()) await writeFile(path.join(root, relative), expected[index]);
  await writeFile(path.join(root, "tools/datapack/.current-capital-accessibility-refresh-transaction.json"), JSON.stringify({ schemaVersion: 1, state: "PREPARED", records }));
  await refreshCurrentCapitalAccessibilityFull({ repositoryRoot: root });
  assert.deepEqual(await Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))), expected);
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
  const candidate = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  await cp(path.join(ROOT, "tools/datapack/sources"), path.join(root, "tools/datapack/sources"), { recursive: true });
  const facility = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/current-capital-facility-source-admission.json"), "utf8"));
  const facilitySnapshot = facility.sourceIdentity.snapshotPath; await mkdir(path.dirname(path.join(root, facilitySnapshot)), { recursive: true }); await cp(path.join(ROOT, facilitySnapshot), path.join(root, facilitySnapshot));
  const itx = candidate.itxTopologyEvidencePath; await mkdir(path.dirname(path.join(root, itx)), { recursive: true }); await cp(path.join(ROOT, itx), path.join(root, itx));
  for (const relative of [candidate.networkEdgeEvidence.capitalTopology.path, candidate.networkEdgeEvidence.capitalTopologyCandidate.path, candidate.networkEdgeEvidence.capitalTopologyReverification.path, candidate.networkEdgeEvidence.itxCoverageContract.path]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await cp(path.join(ROOT, relative), path.join(root, relative));
  }
  const ledger = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/release/source-snapshots.json"), "utf8"));
  const seoul = candidate.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-accessibility"); const current = ledger.find(({ snapshotId }) => snapshotId === seoul.snapshotId);
  const predecessorIds = candidate.sourceSnapshotIds.map((snapshotId) => snapshotId === current.snapshotId ? current.previousSnapshotId : snapshotId);
  const predecessorHash = sha(JSON.stringify(ledger.filter(({ snapshotId }) => predecessorIds.includes(snapshotId))));
  const stationPath = path.join(root, OUTPUTS[0]); const routePath = path.join(root, OUTPUTS[1]);
  const station = JSON.parse(await readFile(stationPath, "utf8")); const route = JSON.parse(await readFile(routePath, "utf8"));
  station.candidate.sourceSetSha256 = predecessorHash; station.evidenceRows = station.evidenceRows.map((row) => ({ ...row, sourceSetSha256: predecessorHash })); route.candidate.sourceSetSha256 = predecessorHash;
  await writeFile(stationPath, JSON.stringify(station)); await writeFile(routePath, JSON.stringify(route));
  return root;
}
