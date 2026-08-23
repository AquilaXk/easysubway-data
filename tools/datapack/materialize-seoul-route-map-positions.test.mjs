import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS,
  materializeSeoulRouteMapPositions,
  materializedSeoulRouteMapPackContentHash,
} from "./materialize-seoul-route-map-positions.mjs";
import {
  canonicalSeoulRouteMapStationName,
  collectSeoulRouteMapPositions,
} from "./collect-seoul-route-map-positions.mjs";
import { copySyntheticCurrentPublicRouteMapRepository } from "./test-fixtures/current-public-route-map-successor.mjs";

const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const routeMapNow = new Date("2026-07-24T02:00:00.000Z");
const SOURCE_ID = "seoul-metro-route-map-positions";
const LINE_IDS = Object.freeze([
  "line-472a81add377", "seoul-2", "line-41a8c75ec9d8", "seoul-4",
  "line-80fc4d5350d4", "line-3f41718e0833", "line-15b3b8a93259", "line-2b2d9eaa53d0",
]);
const normalizeStationName = (value) => String(value ?? "").normalize("NFKC")
  .replace(/\s+/gu, "")
  .replace(/\([^()]*\)$/u, "");
function successorProviderHashes(snapshot) {
  // This is the normalized runner projection shape. The public layout artifact
  // deliberately omits provider-only `serial`, so materialization must consume
  // the admitted successor hashes rather than trying to recreate them.
  return snapshot.routeMapLayoutArtifact.rawPositions.map((position, index) => createHash("sha256")
    .update(JSON.stringify({
      serial: index + 1,
      line: position.line,
      stationCode: position.stationCode,
      stationName: position.stationName,
      latitude: position.latitude,
      longitude: position.longitude,
      basisDate: position.basisDate,
    }))
    .digest("hex"));
}

async function inputs() {
  const [base, inventory, seoulCsvBytes, topologyBytes] = await Promise.all([
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv")),
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260814.json")),
  ]);
  const seoulSnapshot = collectSeoulRouteMapPositions({
    csvBytes: seoulCsvBytes, topologySnapshotBytes: topologyBytes, topologySnapshotId: "capital-route-topology-20260814", now: routeMapNow,
  });
  const observation = { schemaVersion: 1, artifactKind: "static-network-successor-observation", sourceId: SOURCE_ID, routeMapLayoutArtifact: seoulSnapshot };
  const seoulSnapshotBytes = Buffer.from(`${JSON.stringify(observation)}\n`);
  const seoulSnapshotSha256 = createHash("sha256").update(seoulSnapshotBytes).digest("hex");
  const publicSource = inventory.sources.find(({ id }) => id === SOURCE_ID);
  publicSource.coverageScope = { regionIds: ["capital"], operatorIds: [...CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS], lineIds: [...LINE_IDS], sourceDomains: ["route_map_positions"] };
  publicSource.routeMapAdmissionEvidence = {
    ...(publicSource.routeMapAdmissionEvidence ?? {}), capturedAt: seoulSnapshot.capturedAt,
    freshUntil: "2026-10-22T02:00:00.000Z",
    currentLayoutAdmission: {
      schemaVersion: 2, artifactKind: "seoul-public-route-map-layout-admission", status: "ADMITTED",
      positionSnapshotId: "seoul-metro-route-map-positions-20260724", snapshotPath: "tools/datapack/sources/seoul-metro-route-map-positions-20260724.json", snapshotSha256: seoulSnapshotSha256,
      layoutArtifactSha256: createHash("sha256").update(`${JSON.stringify(seoulSnapshot)}\n`).digest("hex"),
      rawPositionsSha256: seoulSnapshot.rawPositionsSha256, layoutPositionsSha256: seoulSnapshot.layoutPositionsSha256, layoutTracksSha256: seoulSnapshot.layoutTracksSha256,
      lineOrderSha256: seoulSnapshot.lineOrderSha256, topologySnapshotSha256: seoulSnapshot.topologySnapshotSha256, aliasLedgerSha256: seoulSnapshot.aliasLedgerSha256,
      semanticInputSha256: seoulSnapshot.semanticInputSha256, semanticOutputSha256: seoulSnapshot.semanticOutputSha256,
    },
  };
  return {
    baseFixture: base,
    seoulSnapshot: observation, seoulSnapshotSha256, topologyBytes,
    inventory,
  };
}

test("공식 서울 위경도 snapshot을 current canonical pack에 materialize한다", async () => {
  const { baseFixture, seoulSnapshot, seoulSnapshotSha256, topologyBytes, inventory } = await inputs();
  const predecessorSourceIndex = baseFixture.packs[0].sourceInventory.findIndex(
    ({ id }) => id === "seoulmetro-cyberstation-route-map",
  );
  assert.notEqual(predecessorSourceIndex, -1);

  const fixture = materializeSeoulRouteMapPositions({
    baseFixture,
    snapshot: seoulSnapshot,
    snapshotSha256: seoulSnapshotSha256,
    topologySnapshotBytes: topologyBytes,
    inventory,
    now: routeMapNow,
  });
  const pack = fixture.packs[0];
  const rows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  assert.equal(pack.routeMapPositions.filter(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map").length, 0);
  assert.equal(pack.sourceInventory.filter(({ id }) => id === "seoulmetro-cyberstation-route-map").length, 0);
  assert.equal(pack.sourceInventory.findIndex(({ id }) => id === SOURCE_ID), predecessorSourceIndex);
  assert.equal(rows.length, seoulSnapshot.routeMapLayoutArtifact.rawPositions.length);
  assert.equal(new Set(rows.map(({ lineId }) => lineId)).size, 8);
  assert.deepEqual([...new Set(rows.map(({ lineId }) => lineId))].sort(), [...LINE_IDS].sort());
  assert.ok(rows.every(({ labelPolygon, region, derivationKind, provenanceKind }) => labelPolygon.length === 4 && region === "수도권" && derivationKind === "GENERATED" && provenanceKind === "OFFICIAL_SOURCE"));
  assert.deepEqual(source.coverageScope.lineIds, [...LINE_IDS]);
  assert.equal(pack.minimumTableRows.route_map_positions, pack.routeMapPositions.length);
  assert.match(pack.id, /^nationwide-seoul-route-map-[a-f0-9]{64}$/);
  assert.match(materializedSeoulRouteMapPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260724");
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260724" });

  const identityBaseFixture = structuredClone(baseFixture);
  identityBaseFixture.packs[0].id = "capital";
  identityBaseFixture.manifest.activePack = {
    id: "capital",
    version: identityBaseFixture.packs[0].version,
  };
  const basePack = identityBaseFixture.packs[0];
  const identityPreserved = materializeSeoulRouteMapPositions({
    baseFixture: identityBaseFixture,
    snapshot: seoulSnapshot,
    snapshotSha256: seoulSnapshotSha256,
    topologySnapshotBytes: topologyBytes,
    inventory,
    now: routeMapNow,
    rewritePackIdentity: false,
    successorProviderRecordHashes: successorProviderHashes(seoulSnapshot),
  });
  const preservedPack = identityPreserved.packs[0];
  assert.equal(basePack.id, "capital");
  assert.equal(preservedPack.id, basePack.id);
  assert.equal(preservedPack.version, basePack.version);
  assert.equal(preservedPack.url, basePack.url);
  assert.deepEqual(identityPreserved.manifest.activePack, identityBaseFixture.manifest.activePack);
  assert.equal(identityPreserved.manifest.activePack.id, "capital");
  assert.equal(
    preservedPack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID).length,
    seoulSnapshot.routeMapLayoutArtifact.rawPositions.length,
  );
  assert.equal(preservedPack.sourceInventory.filter(({ id }) => id === SOURCE_ID).length, 1);
  assert.equal(
    preservedPack.routeMapPositions.find(({ sourceId }) => sourceId === SOURCE_ID).providerRecordHash,
    successorProviderHashes(seoulSnapshot)[0],
  );
  assert.equal(preservedPack.routeMapPositions.some(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map"), false);
  const preservedSeoulTracks = preservedPack.routeMapLineTracks.filter(({ region, lineId }) =>
    region === "수도권" && LINE_IDS.includes(lineId));
  assert.equal(preservedSeoulTracks.length > 0, true);
  assert.equal(preservedSeoulTracks.every(({ sourceId }) => sourceId === SOURCE_ID), true);
  assert.throws(
    () => materializeSeoulRouteMapPositions({
      baseFixture: identityBaseFixture,
      snapshot: seoulSnapshot,
      snapshotSha256: seoulSnapshotSha256,
      topologySnapshotBytes: topologyBytes,
      inventory,
      now: routeMapNow,
      rewritePackIdentity: false,
      requireSuccessorProviderRecordHashes: true,
    }),
    /successor provider record hashes are invalid/,
  );

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .routeMapAdmissionEvidence.currentLayoutAdmission.layoutPositionsSha256 = "0".repeat(64);
  assert.throws(
    () => materializeSeoulRouteMapPositions({
      baseFixture, snapshot: seoulSnapshot, snapshotSha256: seoulSnapshotSha256, topologySnapshotBytes: topologyBytes,
      inventory: mismatchedInventory, now: routeMapNow,
    }),
    /inventory evidence/,
  );
  const byteDifferentSnapshotSha256 = createHash("sha256")
    .update(`${JSON.stringify(seoulSnapshot, null, 2)}\n`)
    .digest("hex");
  assert.notEqual(byteDifferentSnapshotSha256, seoulSnapshotSha256);
  assert.throws(
    () => materializeSeoulRouteMapPositions({
      baseFixture, snapshot: seoulSnapshot, snapshotSha256: byteDifferentSnapshotSha256, topologySnapshotBytes: topologyBytes,
      inventory, now: routeMapNow,
    }),
    /snapshot byte identity/,
  );

});

test("current public route-map row는 canonical station membership 누락을 확장하지 않고 거부한다", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "current-public-route-map-membership-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const repositoryRoot = path.join(temporary, "repository");
  const now = new Date("2026-08-22T09:45:18.609Z");
  await copySyntheticCurrentPublicRouteMapRepository(root, repositoryRoot, { now });
  const [candidate, ledger, inventory, baseFixture] = await Promise.all([
    readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8").then(JSON.parse),
  ]);
  const successorProjection = candidate.sourceSnapshots.find(({ sourceId }) => sourceId === SOURCE_ID);
  const successor = ledger.find(({ snapshotId }) => snapshotId === successorProjection.snapshotId);
  assert.ok(successor?.routeMapLayoutArtifact);
  const rawPosition = successor.routeMapLayoutArtifact.rawPositions[0];
  const canonicalName = canonicalSeoulRouteMapStationName(rawPosition.line, rawPosition.stationName);
  const pack = baseFixture.packs[0];
  const stations = new Map(pack.stations.map((station) => [station.id, station]));
  const matchingMemberships = pack.stationLines.filter(({ stationId, lineId }) => (
    lineId === rawPosition.lineId
      && normalizeStationName(stations.get(stationId)?.nameKo) === normalizeStationName(canonicalName)
  ));
  assert.equal(matchingMemberships.length, 1);
  pack.stationLines = pack.stationLines.filter((membership) => membership !== matchingMemberships[0]);
  const topologySnapshotBytes = await readFile(path.join(
    repositoryRoot,
    `tools/datapack/sources/${successor.routeMapLayoutArtifact.topologySnapshotId}.json`,
  ));

  assert.throws(
    () => materializeSeoulRouteMapPositions({
      baseFixture,
      snapshot: successor,
      snapshotSha256: successor.normalizedObservationSha256,
      topologySnapshotBytes,
      inventory,
      now,
      rewritePackIdentity: false,
      successorProviderRecordHashes: successor.providerRecordHashes,
      requireSuccessorProviderRecordHashes: true,
    }),
    /canonical station is missing/,
  );
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
