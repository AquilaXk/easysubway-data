import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { projectRegionalMaterializeFixture } from "./materialize-test-fixture.mjs";

import {
  parseMolitDaeguStationMappings,
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import { materializeBusanRouteTopology, parseCanonicalBusanStationMappings } from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaeguAccessibility } from "./materialize-daegu-accessibility.mjs";
import { materializeDaeguRouteMapPositions } from "./materialize-daegu-route-map-positions.mjs";
import { materializeDaeguTimetable } from "./materialize-daegu-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import {
  materializeSeoulRouteMapPositions,
  materializedSeoulRouteMapPackContentHash,
} from "./materialize-seoul-route-map-positions.mjs";
import { collectSeoulRouteMapPositions } from "./collect-seoul-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const timetableNow = new Date("2026-07-20T16:00:00.000Z");
const accessibilityNow = new Date("2026-07-24T01:00:00.000Z");
const daeguRouteMapNow = new Date("2026-07-24T03:00:00.000Z");
const routeMapNow = new Date("2026-07-24T02:00:00.000Z");
const execFileAsync = promisify(execFile);
const SOURCE_ID = "seoul-metro-route-map-positions";
const LINE_IDS = Object.freeze([
  "line-472a81add377", "seoul-2", "line-41a8c75ec9d8", "seoul-4",
  "line-80fc4d5350d4", "line-3f41718e0833", "line-15b3b8a93259", "line-2b2d9eaa53d0",
]);
// daegu accessibility coverage baseline(실측): supportedCount=34.
const DAEGU_ACCESSIBILITY_BASELINE_SUPPORTED_COUNT = 34;
// daegu official route_map_positions FILE admission closes daegu-transportation 1~3호선 +3 requirements.
const DAEGU_ROUTE_MAP_SUPPORTED_COUNT = DAEGU_ACCESSIBILITY_BASELINE_SUPPORTED_COUNT + 3;
// seoulmetro-cyberstation-route-map은 coverageScope.lineIds가 비어 strict line scope에서
// seoul-metro 1~8 route_map_positions를 닫지 못하므로 이번 FILE admission이 +8을 더한다.
const SEOUL_ROUTE_MAP_SUPPORTED_COUNT = DAEGU_ROUTE_MAP_SUPPORTED_COUNT + 8;

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
  const [
    base, busanTopology, busanTimetable, busanRouteMapBytes,
    daejeonTopology, daejeonTimetable, gwangjuTopology, gwangjuTimetable,
    inventory, regionalMap, molitMap, daeguAccessibility, daeguRouteMapSnapshotBytes, seoulCsvBytes, topologyBytes,
  ] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json").then(projectRegionalMaterializeFixture),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
    readJson("tools/datapack/sources/daegu-transportation-accessibility-20260724.json"),
    readFile(path.join(root, "tools/datapack/sources/daegu-transportation-route-map-positions-20260724.json")),
    readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv")),
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260814.json")),
  ]);
  const busanTopologyFixture = materializeBusanRouteTopology({
    baseFixture: base, snapshot: busanTopology, inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(regionalMap),
    now: new Date("2026-07-19T18:14:03.004Z"),
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: busanTopologyFixture, timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology, inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitMap), now: timetableNow,
  });
  const busanTimetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture, timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology, inventory, now: timetableNow,
  });
  const busanPositionsFixture = materializeBusanRouteMapPositions({
    baseFixture: busanTimetableFixture, snapshot: JSON.parse(busanRouteMapBytes),
    snapshotSha256: createHash("sha256").update(busanRouteMapBytes).digest("hex"),
    topologySnapshot: busanTopology, inventory, now: timetableNow,
  });
  const gwangjuFixture = materializeGwangjuTimetable({
    baseFixture: busanPositionsFixture, timetableSnapshot: gwangjuTimetable,
    topologySnapshot: gwangjuTopology, inventory,
    canonicalStationMappings: parseMolitGwangjuStationMappings(molitMap), now: timetableNow,
  });
  const topologySnapshots = {};
  const timetableSnapshots = {};
  const mappings = {};
  for (const config of DAEGU_LINES) {
    topologySnapshots[config.lineNumber] = await readJson(
      `tools/datapack/sources/daegu-line${config.lineNumber}-route-topology-20260721.json`,
    );
    timetableSnapshots[config.lineNumber] = await readJson(
      `tools/datapack/sources/daegu-line${config.lineNumber}-train-timetable-20260721.json`,
    );
    mappings[config.lineNumber] = parseMolitDaeguStationMappings(molitMap, config.lineName);
  }
  const daeguFixture = materializeDaeguTimetable({
    baseFixture: gwangjuFixture, topologySnapshots, timetableSnapshots, inventory,
    canonicalStationMappings: mappings, now: timetableNow,
  });
  const daeguAccessibilityFixture = materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot: daeguAccessibility,
    topologySnapshots,
    inventory,
    now: accessibilityNow,
  });
  const daeguRouteMapSnapshot = JSON.parse(daeguRouteMapSnapshotBytes);
  const daeguRouteMapFixture = materializeDaeguRouteMapPositions({
    baseFixture: daeguAccessibilityFixture,
    snapshot: daeguRouteMapSnapshot,
    snapshotSha256: createHash("sha256").update(daeguRouteMapSnapshotBytes).digest("hex"),
    topologySnapshots,
    inventory,
    now: daeguRouteMapNow,
  });
  const seoulSnapshot = collectSeoulRouteMapPositions({
    csvBytes: seoulCsvBytes, topologySnapshotBytes: topologyBytes, topologySnapshotId: "capital-route-topology-20260814", now: routeMapNow,
  });
  const observation = { schemaVersion: 1, artifactKind: "static-network-successor-observation", sourceId: SOURCE_ID, routeMapLayoutArtifact: seoulSnapshot };
  const seoulSnapshotBytes = Buffer.from(`${JSON.stringify(observation)}\n`);
  const seoulSnapshotSha256 = createHash("sha256").update(seoulSnapshotBytes).digest("hex");
  const publicSource = inventory.sources.find(({ id }) => id === SOURCE_ID);
  publicSource.coverageScope = { regionIds: ["capital"], operatorIds: ["seoul-metro"], lineIds: [...LINE_IDS], sourceDomains: ["route_map_positions"] };
  publicSource.routeMapAdmissionEvidence = {
    ...(publicSource.routeMapAdmissionEvidence ?? {}), capturedAt: seoulSnapshot.capturedAt,
    freshUntil: "2027-07-24T02:00:00.000Z",
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
    baseFixture: daeguRouteMapFixture,
    seoulSnapshot: observation, seoulSnapshotSha256, topologyBytes,
    inventory,
  };
}

test("공식 서울 위경도 snapshot을 누적 production candidate pack에 materialize한다", async () => {
  const { baseFixture, seoulSnapshot, seoulSnapshotSha256, topologyBytes, inventory } = await inputs();

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
  assert.equal(rows.length, 276);
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
  assert.equal(preservedPack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID).length, 276);
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

test("materialized SQLite와 provenance가 서울 1~8호선 route_map_positions를 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-seoul-route-map-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { baseFixture, seoulSnapshot, seoulSnapshotSha256, topologyBytes, inventory } = await inputs();
  const fixture = materializeSeoulRouteMapPositions({
    baseFixture,
    snapshot: seoulSnapshot,
    snapshotSha256: seoulSnapshotSha256,
    topologySnapshotBytes: topologyBytes,
    inventory,
    now: routeMapNow,
  });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], { cwd: root, env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey } });

  const manifestPath = path.join(packOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(
    packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/"),
  ).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM route_map_positions WHERE source_id = ?")
    .get(SOURCE_ID).count, 276);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM route_map_positions WHERE source_id = ?")
    .get("seoulmetro-cyberstation-route-map").count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(DISTINCT line_id) AS count FROM route_map_positions WHERE source_id = ?",
  ).get(SOURCE_ID).count, 8);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  for (const field of ["route_map_position", "route_map_label_polygon"]) {
    const fieldRecords = provenance.packs.flatMap(({ records }) => records).filter(
      ({ sourceId, field: recordField }) => sourceId === SOURCE_ID && recordField === field,
    );
    assert.ok(fieldRecords.length > 0, `provenance missing field: ${field}`);
    assert.deepEqual(
      [...new Set(fieldRecords.flatMap(({ coverageScope }) => coverageScope?.lineIds ?? []))].sort(),
      [...LINE_IDS].sort(),
    );
  }

  await execFileAsync(process.execPath, [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets", "tools/datapack/nationwide-coverage-targets.json",
    "--inventory", inventoryPath,
    "--manifest", manifestPath,
    "--provenance", path.join(packOutput, "current.provenance.json"),
    "--resolution-plan", "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json",
    "--resolutions", "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json",
    "--output", reportPath,
    "--allow-gaps",
  ], { cwd: root });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const routeMapRequirements = report.requirements.filter(
    ({ operatorId, sourceDomain }) => operatorId === "seoul-metro" && sourceDomain === "route_map_positions",
  );
  assert.equal(routeMapRequirements.length, 8);
  assert.ok(routeMapRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(
    routeMapRequirements.map(({ lineId }) => lineId).sort(),
    [...LINE_IDS].sort(),
  );
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: SEOUL_ROUTE_MAP_SUPPORTED_COUNT,
    explicitlyUnsupportedCount: 4,
    missingCount: 270 - SEOUL_ROUTE_MAP_SUPPORTED_COUNT - 4,
    supportedRatio: Number((SEOUL_ROUTE_MAP_SUPPORTED_COUNT / 270).toFixed(4)),
    terminalResolutionRatio: Number(((SEOUL_ROUTE_MAP_SUPPORTED_COUNT + 4) / 270).toFixed(4)),
    completionReady: false,
  });
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
