import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadCurrentMolitMembershipMappings,
  projectHistoricalRegionalMaterializeInventory,
  projectRegionalMaterializeFixture,
} from "./materialize-test-fixture.mjs";

const legacyEvidence = {
  serviceClass: "ITX_CHEONGCHUN",
  timetableArtifactId: "itx-cheongchun-completeness-admission-20260714T083544292Z",
  timetableArtifactSha256: "347aec507ec951dde65c10a1c4bff9f94454f762d76a5a74064a40662008336c",
  canonicalPackId: "capital",
  canonicalPackSha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
  canonicalPackSqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
  admissionStatus: "MISSING",
  admissionEligible: false,
  freshUntil: "2026-07-20T00:00:00.000Z",
  sourceIssue: 2116,
};
const root = path.resolve(import.meta.dirname, "../..");

function fixture() {
  return {
    manifest: { activePack: { id: "capital", version: "1" } },
    packs: [{
      id: "capital",
      version: "1",
      artifactKind: "production",
      routeServiceArtifactEvidence: [structuredClone(legacyEvidence)],
      minimumTableRows: {
        network_edges: 1,
        transit_routes: 1,
        transit_trips: 1,
        transit_stop_times: 1,
      },
      transitRoutes: [{ id: "route-local", serviceClass: "URBAN_RAIL" }],
      transitTrips: [{ id: "trip-local", routeId: "route-local", serviceId: "local-calendar" }],
      transitStopTimes: [{ tripId: "trip-local" }],
      networkEdges: [{ id: "edge-local", serviceClass: "URBAN_RAIL" }],
      serviceCalendars: [{ serviceId: "local-calendar" }],
      serviceCalendarDates: [{ serviceId: "local-calendar" }],
    }],
  };
}

test("regional projection clones only capital@1 and removes its sole legacy evidence", () => {
  const input = fixture();
  const originalBytes = JSON.stringify(input);
  const projected = projectRegionalMaterializeFixture(input);
  const { routeServiceArtifactEvidence, ...projectedPack } = projected.packs[0];
  const { routeServiceArtifactEvidence: inputLegacyEvidence, ...inputPack } = input.packs[0];

  assert.equal(JSON.stringify(input), originalBytes);
  assert.notEqual(projected, input);
  assert.equal(routeServiceArtifactEvidence, undefined);
  assert.deepEqual(projectedPack, inputPack);
  assert.deepEqual(inputLegacyEvidence, [legacyEvidence]);
});

test("regional projection fails closed when a current table or relationship references ITX", () => {
  const input = fixture();
  input.packs[0].transitTrips.push({ id: "trip-itx", routeId: "ITX_route", serviceId: "local-calendar" });

  assert.throws(
    () => projectRegionalMaterializeFixture(input),
    /contains an unexpected ITX reference/,
  );
});

test("regional projection rejects lowercase ITX identifiers", () => {
  const input = fixture();
  input.packs[0].networkEdges.push({ id: "itx-edge", serviceClass: "URBAN_RAIL" });

  assert.throws(
    () => projectRegionalMaterializeFixture(input),
    /contains an unexpected ITX reference/,
  );
});

test("regional projection rejects embedded ITX tokens and mutated legacy evidence", () => {
  const embeddedItx = fixture();
  embeddedItx.packs[0].transitRoutes[0].id = "KORAIL_ITX_CHEONGCHUN";
  assert.throws(
    () => projectRegionalMaterializeFixture(embeddedItx),
    /contains an unexpected ITX reference/,
  );

  const arbitrarySubstring = fixture();
  arbitrarySubstring.packs[0].transitRoutes[0].id = "station-itxpress-local";
  assert.doesNotThrow(() => projectRegionalMaterializeFixture(arbitrarySubstring));

  const mutatedEvidence = fixture();
  mutatedEvidence.packs[0].routeServiceArtifactEvidence[0].snapshotId = "unexpected";
  assert.throws(
    () => projectRegionalMaterializeFixture(mutatedEvidence),
    /must match the exact known contract/,
  );

  const duplicateEvidence = fixture();
  duplicateEvidence.packs[0].routeServiceArtifactEvidence.push(structuredClone(legacyEvidence));
  assert.throws(
    () => projectRegionalMaterializeFixture(duplicateEvidence),
    /zero current or exactly one legacy routeServiceArtifactEvidence/,
  );

  const manifestItx = fixture();
  manifestItx.manifest.note = "ITX_CHEONGCHUN";
  assert.throws(
    () => projectRegionalMaterializeFixture(manifestItx),
    /contains an unexpected ITX reference/,
  );

  const rootSibling = fixture();
  rootSibling.hidden = "ITX_CHEONGCHUN";
  assert.throws(() => projectRegionalMaterializeFixture(rootSibling));
});

test("regional projection preserves the tracked current fixture with empty evidence", async () => {
  const fixturePath = path.join(root, "tools/datapack/release/capital-production-reviewed-pack.json");
  const bytes = await readFile(fixturePath);
  const input = JSON.parse(bytes);
  const original = structuredClone(input);
  const projected = projectRegionalMaterializeFixture(input);
  assert.deepEqual(await readFile(fixturePath), bytes);
  assert.deepEqual(input, original);
  assert.deepEqual(projected.manifest, original.manifest);
  assert.deepEqual(projected.packs[0], original.packs[0]);
});

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
  ]);

  const denied = structuredClone(inventory);
  denied.sources.find(({ id }) => id === "molit-urban-rail-full-route").admissionEvidence.decision = "DENIED";
  await assert.rejects(
    loadCurrentMolitMembershipMappings({ inventory: denied, readTracked }),
    /current MOLIT inventory admission is invalid/,
  );
});

test("regional inventory projection restores only the exact historical MOLIT replay tuple", async () => {
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const input = JSON.parse(await readFile(inventoryPath));
  const original = structuredClone(input);
  const projected = projectHistoricalRegionalMaterializeInventory(input);
  const raw = projected.sources.find(({ id }) => id === "molit-urban-rail-full-route");
  const memberships = projected.sources.filter(({ membershipAdmissionEvidence: evidence }) =>
    evidence?.membershipSourceId === "molit-urban-rail-full-route"
      && Array.isArray(evidence.lineIds) && evidence.lineIds.length === 1);

  assert.deepEqual(input, original);
  assert.notEqual(projected, input);
  assert.equal(raw.admissionEvidence.snapshotId, "molit-urban-rail-full-route-revalidated-20260814");
  assert.equal(raw.admissionEvidence.rawSha256, "178af75ece72b2f6a58226063e05f1e1f45f50c779c7fbf2905f7df1384a9e22");
  assert.equal(memberships.length, 10);
  assert.ok(memberships.every(({ membershipAdmissionEvidence: evidence }) =>
    evidence.membershipSourceRawSha256 === raw.admissionEvidence.rawSha256
      && evidence.membershipSourceSnapshotSha256 === "3f08fb398bcb16e8ff047ec17f094a28590ec8d5aa1b8df2d6e9cec85ed0f6e7"
      && Date.parse(evidence.verifiedAt) <= Date.parse("2026-07-20T15:30:00.000Z")));

  const malformed = structuredClone(original);
  malformed.sources.find(({ id }) => id === "molit-urban-rail-full-route-daejeon-membership")
    .membershipAdmissionEvidence.membershipSourceSnapshotSha256 = "0".repeat(64);
  assert.throws(
    () => projectHistoricalRegionalMaterializeInventory(malformed),
    /current MOLIT line-7051a9c2525c membership inventory is invalid/,
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
  await Promise.all([
    mkdir(path.dirname(inventoryPath), { recursive: true }),
    mkdir(path.dirname(snapshotsPath), { recursive: true }),
    mkdir(path.dirname(observationPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(inventoryPath, JSON.stringify(inventory)),
    writeFile(snapshotsPath, JSON.stringify(snapshots)),
    writeFile(observationPath, await readFile(path.join(root, observationRelative))),
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
