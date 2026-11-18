import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadCurrentMolitMembershipMappings,
} from "./materialize-test-fixture.mjs";
const root = path.resolve(import.meta.dirname, "../..");

test("current MOLIT observation binds all five regional mappings to the active ledger", async () => {
  const mappings = await loadCurrentMolitMembershipMappings({ repositoryRoot: root });
  assert.deepEqual([
    mappings.daejeon.length,
    mappings.gwangju.length,
    mappings.daeguLine1.length,
    mappings.daeguLine2.length,
    mappings.daeguLine3.length,
  ], [22, 20, 35, 29, 30]);
  assert.ok(Object.values(mappings).every((value) =>
    value.sourceRawSha256 === "8a60490ea582a62ce859877380e4b96b34416c536d96b1dcb1a869426bedc363"));
});

test("current MOLIT loader records supplied ledger and observation inputs while retaining admission checks", async () => {
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json")));
  const recorded = [];
  const readTracked = async (relativePath) => {
    recorded.push(relativePath);
    return readFile(path.join(root, relativePath));
  };
  const mappings = await loadCurrentMolitMembershipMappings({ inventory, readTracked });
  const admission = inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route").admissionEvidence;
  const daejeonAdmission = inventory.sources.find(({ id }) =>
    id === "molit-urban-rail-full-route-daejeon-membership").membershipAdmissionEvidence;
  assert.equal(mappings.daejeon.length, daejeonAdmission.stationCount);
  assert.equal(mappings.daejeon.sourceRawSha256, admission.rawSha256);
  assert.deepEqual(recorded, [
    "tools/datapack/release/source-snapshots.json",
    `tools/datapack/sources/${admission.snapshotId}.json`,
    inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology")
      .topologyAdmissionEvidence.snapshotPath,
  ]);

  const denied = structuredClone(inventory);
  denied.sources.find(({ id }) => id === "molit-urban-rail-full-route").admissionEvidence.decision = "DENIED";
  await assert.rejects(
    loadCurrentMolitMembershipMappings({ inventory: denied, readTracked }),
    /current MOLIT inventory admission is invalid/,
  );
});

test("current MOLIT loader rejects denied snapshots and incomplete dual evidence", async (context) => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "easysubway-current-molit-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(repositoryRoot, "tools/datapack/source-inventory.json");
  const snapshotsPath = path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json");
  const currentInventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const currentSnapshotsPath = path.join(root, "tools/datapack/release/source-snapshots.json");
  const inventory = JSON.parse(await readFile(currentInventoryPath));
  const snapshots = JSON.parse(await readFile(currentSnapshotsPath));
  const admission = inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route").admissionEvidence;
  const observationRelative = `tools/datapack/sources/${admission.snapshotId}.json`;
  const observationPath = path.join(repositoryRoot, observationRelative);
  const topologyRelative = inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology")
    .topologyAdmissionEvidence.snapshotPath;
  const topologyPath = path.join(repositoryRoot, topologyRelative);
  await Promise.all([
    mkdir(path.dirname(inventoryPath), { recursive: true }),
    mkdir(path.dirname(snapshotsPath), { recursive: true }),
    mkdir(path.dirname(observationPath), { recursive: true }),
    mkdir(path.dirname(topologyPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(inventoryPath, JSON.stringify(inventory)),
    writeFile(snapshotsPath, JSON.stringify(snapshots)),
    writeFile(observationPath, await readFile(path.join(root, observationRelative))),
    writeFile(topologyPath, await readFile(path.join(root, topologyRelative))),
  ]);

  const denied = structuredClone(inventory);
  denied.sources.find(({ id }) => id === "molit-urban-rail-full-route").admissionEvidence.decision = "DENIED";
  await writeFile(inventoryPath, JSON.stringify(denied));
  await assert.rejects(
    loadCurrentMolitMembershipMappings({ repositoryRoot }),
    /current MOLIT inventory admission is invalid/,
  );

  const incomplete = structuredClone(inventory);
  incomplete.sources = incomplete.sources.filter(({ id }) => id !== "molit-urban-rail-full-route-daejeon-membership");
  await writeFile(inventoryPath, JSON.stringify(incomplete));
  await assert.rejects(
    loadCurrentMolitMembershipMappings({ repositoryRoot }),
    /current MOLIT line-7051a9c2525c membership admission is incomplete/,
  );

  const failedSnapshots = structuredClone(snapshots);
  failedSnapshots.find(({ snapshotId }) => snapshotId === admission.snapshotId).fetchStatus = "FAILED";
  await Promise.all([
    writeFile(inventoryPath, JSON.stringify(inventory)),
    writeFile(snapshotsPath, JSON.stringify(failedSnapshots)),
  ]);
  await assert.rejects(
    loadCurrentMolitMembershipMappings({ repositoryRoot }),
    /current MOLIT source snapshot binding is invalid/,
  );
});
