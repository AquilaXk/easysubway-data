import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSnapshotDiff, validateLineage } from "../source-snapshot-policy.mjs";
import { requireExactPublicStaticNetworkV2SnapshotBinding } from "../public-static-network-v2-admission.mjs";
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
    now: new Date("2026-08-26T04:00:00.000Z"),
  });

  const before = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  assert.equal(before.sourceSnapshots[0].sourceId, "seoul-metro-route-map-positions");

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: new Date("2026-08-26T04:15:00.000Z"),
  });
  assert.match(result.predecessorSnapshotId, /^seoul-metro-route-map-positions-current-/u);

  const after = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  assert.equal(after.sourceSnapshots[0].sourceId, "seoul-metro-route-map-positions");
  assert.equal(after.sourceSnapshotIds[0], result.snapshotId);
  assert.deepEqual(after.networkEdgeEvidence.capitalTopology, before.networkEdgeEvidence.capitalTopology);
  const admissions = inventory.sources
    .filter(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.topologySourceId === "capital-route-topology")
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence.currentTopologyAdmission);
  const candidate = after.networkEdgeEvidence.capitalTopologyCandidate;
  const topologyAdmission = after.networkEdgeEvidence.capitalTopologyAdmission;
  assert.equal(admissions.length, 16);
  assert.ok(Date.parse(after.publishedAt) >= Date.parse(topologyAdmission.reverifiedAt));
  assert.ok(Date.parse(after.publishedAt) < Date.parse(topologyAdmission.freshUntil));
  assert.ok(admissions.every((admission) => admission.topologySnapshotId === candidate.snapshotId
    && admission.topologyContentSha256 === topologyAdmission.contentSha256
    && admission.reviewedAt === topologyAdmission.reviewedAt
    && admission.freshUntil === topologyAdmission.freshUntil
    && admission.topologyLineages.every((lineage) => lineage.sourceId === "capital-route-topology"
      && lineage.snapshotId === candidate.snapshotId
      && lineage.contentSha256 === admission.topologyContentSha256)));
});

test("already-public-root fixture activation preserves one valid source lineage root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-existing-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-26T04:00:00.000Z"),
  });

  const result = await activateSyntheticCurrentPublicRouteMapSuccessor(root, {
    now: new Date("2026-08-26T04:15:00.000Z"),
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

test("current public fixture rejects a fork outside the selected head before mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-forked-lineage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-26T04:00:00.000Z"),
    activatePublicRouteMap: false,
  });
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const selectedId = candidate.sourceSnapshotIds[candidate.sourceSnapshots.findIndex(({ sourceId }) =>
    sourceId === "seoul-metro-route-map-positions")];
  const selected = snapshots.find(({ snapshotId }) => snapshotId === selectedId);
  const parent = snapshots.find(({ snapshotId }) => snapshotId === selected.previousSnapshotId);
  assert.ok(selected);
  assert.ok(parent);
  const fork = structuredClone(selected);
  fork.snapshotId = `${selected.snapshotId}-fork`;
  fork.retrievedAt = new Date(Date.parse(selected.retrievedAt) + 1_000).toISOString();
  fork.diffSummary = buildSnapshotDiff(parent, fork);
  snapshots.push(fork);
  await writeFile(
    path.join(root, "tools/datapack/release/source-snapshots.json"),
    `${JSON.stringify(snapshots, null, 2)}\n`,
  );

  await assert.rejects(
    activateSyntheticCurrentPublicRouteMapSuccessor(root, { now: new Date("2026-08-26T04:15:00.000Z") }),
    /SOURCE_LINEAGE_BROKEN: snapshot fork/,
  );
});

test("current public fixture rejects a duplicate or out-of-scope candidate lineage before mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-invalid-lineage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-26T04:00:00.000Z"),
    activatePublicRouteMap: false,
  });
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const admission = inventory.sources.find(({ routeMapAdmissionEvidence }) =>
    routeMapAdmissionEvidence?.topologySourceId === "capital-route-topology")
    .routeMapAdmissionEvidence.currentTopologyAdmission;
  admission.topologyLineages.push({ ...admission.topologyLineages[0] });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    activateSyntheticCurrentPublicRouteMapSuccessor(root, { now: new Date("2026-08-26T04:15:00.000Z") }),
    /synthetic current topology admission bytes are invalid/,
  );
});

test("advancing a current public head derives records from its admitted current layout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-current-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-26T04:00:00.000Z"),
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
  assert.equal(child.provider, parent.provider);
  assert.deepEqual(child.providerRecordHashes, parent.providerRecordHashes);
  assert.deepEqual(child.publicStaticNetworkV2Observation.normalizedProjection, parent.publicStaticNetworkV2Observation.normalizedProjection);
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const admission = inventory.sources.find(({ id }) => id === child.sourceId)
    .routeMapAdmissionEvidence.currentLayoutAdmission;
  const observationBytes = await readFile(path.join(root, admission.snapshotPath));
  assert.equal(createHash("sha256").update(observationBytes).digest("hex"), admission.snapshotSha256);
  assert.doesNotThrow(() => requireExactPublicStaticNetworkV2SnapshotBinding({
    snapshot: child,
    source: inventory.sources.find(({ id }) => id === child.sourceId),
  }));
  assert.deepEqual(child.diffSummary, buildSnapshotDiff(parent, child));
  assert.equal(child.diffSummary.status, "NO_CHANGE");
});

test("advancing a current public head keeps retrieval time monotonic in a one-second window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-public-route-map-monotonic-time-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, root, {
    now: new Date("2026-08-26T04:00:00.000Z"),
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
    now: new Date("2026-08-26T04:00:00.000Z"),
  });

  const result = await createStaticNetworkRegistrarPredecessorFixture(source, root, {
    now: new Date("2026-08-26T04:00:00.000Z"),
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
