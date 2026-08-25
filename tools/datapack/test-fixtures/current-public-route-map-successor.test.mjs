import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSnapshotDiff, validateLineage } from "../source-snapshot-policy.mjs";
import {
  activateSyntheticCurrentPublicRouteMapSuccessor,
  copySyntheticCurrentPublicRouteMapRepository,
  createStaticNetworkRegistrarPredecessorFixture,
} from "./current-public-route-map-successor.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

test("current public candidate slot derives a same-source public V2 successor on a topology-only refresh", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-predecessor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-22T09:45:18.609Z"),
  });

  const before = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  assert.equal(before.sourceSnapshots[0].sourceId, "seoul-metro-route-map-positions");

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: new Date("2026-08-22T10:45:18.609Z"),
  });
  assert.match(result.predecessorSnapshotId, /^seoul-metro-route-map-positions-current-/u);

  const after = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  assert.equal(after.sourceSnapshots[0].sourceId, "seoul-metro-route-map-positions");
  assert.equal(after.sourceSnapshotIds[0], result.snapshotId);
});

test("already-public-root fixture activation preserves one valid source lineage root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-existing-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-25T09:45:18.609Z"),
  });

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: new Date("2026-08-25T10:45:18.609Z"),
  });
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const publicSnapshots = snapshots.filter(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");

  assert.doesNotThrow(() => validateLineage(snapshots));
  assert.equal(publicSnapshots.filter(({ previousSnapshotId }) => previousSnapshotId == null).length, 1);
  assert.equal(candidate.sourceSnapshotIds[0], result.snapshotId);
});

test("advancing a current public head derives records from its admitted current layout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-current-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-25T09:45:18.609Z"),
    activatePublicRouteMap: false,
  });

  const [candidate, beforeSnapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const publicIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions");
  const parent = beforeSnapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[publicIndex]);
  assert.notEqual(publicIndex, -1);
  assert.ok(parent);

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: new Date(Date.parse(parent.retrievedAt) + 120_000),
    advanceCurrentPublicHead: true,
  });
  const afterSnapshots = JSON.parse(await readFile(
    path.join(root, "tools/datapack/release/source-snapshots.json"),
    "utf8",
  ));
  const child = afterSnapshots.find(({ snapshotId }) => snapshotId === result.snapshotId);

  assert.equal(result.predecessorSnapshotId, parent.snapshotId);
  assert.equal(child.previousSnapshotId, parent.snapshotId);
  assert.equal(child.rawSha256, parent.rawSha256);
  assert.equal(child.contentSha256, parent.contentSha256);
  assert.equal(child.schemaFingerprint, parent.schemaFingerprint);
  assert.equal(child.rowCount, parent.rowCount);
  assert.equal(child.coverageCount, parent.coverageCount);
  assert.deepEqual(child.providerRecordHashes, parent.providerRecordHashes);
  assert.deepEqual(child.diffSummary, buildSnapshotDiff(parent, child));
  assert.equal(child.diffSummary.status, "NO_CHANGE");
});

test("advancing a current public head keeps retrieval time monotonic in a one-second window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-monotonic-time-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-25T09:45:18.609Z"),
    activatePublicRouteMap: false,
  });

  const [candidate, beforeSnapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const publicIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions");
  const parent = beforeSnapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[publicIndex]);
  assert.notEqual(publicIndex, -1);
  assert.ok(parent);
  const now = new Date(Date.parse(parent.retrievedAt) + 1_000);

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now,
    advanceCurrentPublicHead: true,
  });
  const afterSnapshots = JSON.parse(await readFile(
    path.join(root, "tools/datapack/release/source-snapshots.json"),
    "utf8",
  ));
  const child = afterSnapshots.find(({ snapshotId }) => snapshotId === result.snapshotId);

  assert.equal(result.predecessorSnapshotId, parent.snapshotId);
  assert.ok(Date.parse(child.retrievedAt) > Date.parse(parent.retrievedAt));
  assert.ok(Date.parse(child.retrievedAt) <= now.getTime());
  assert.doesNotThrow(() => validateLineage(afterSnapshots));
});

test("registrar fixture derives a selected same-source public root", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-registrar-source-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-registrar-predecessor-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, source, {
    now: new Date("2026-08-25T09:45:18.609Z"),
  });

  const result = await createStaticNetworkRegistrarPredecessorFixture(source, root, {
    now: new Date("2026-08-25T09:45:18.609Z"),
  });
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const selected = snapshots.find(({ snapshotId }) => snapshotId === candidate.sourceSnapshotIds[0]);

  assert.equal(selected.snapshotId, result.currentSnapshotId);
  assert.equal(candidate.sourceSnapshots[0].sourceId, "seoul-metro-route-map-positions");
  assert.equal(selected.previousSnapshotId, result.predecessorSnapshotId);
  assert.doesNotThrow(() => validateLineage(snapshots));
});
