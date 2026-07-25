import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { materializeBusanRouteTopology, parseCanonicalBusanStationMappings } from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import {
  connectorTrackPath,
  materializeBusanRouteMapPositions,
  materializedBusanRouteMapPackContentHash,
} from "./materialize-busan-route-map-positions.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const routeMapNow = new Date("2026-07-20T11:13:18.000Z");

test("공식 connector 경로를 역 순서대로 연결해 노선 track을 만든다", async () => {
  const snapshot = await readJson("tools/datapack/sources/busan-transportation-route-map-positions-20260720.json");
  const path = connectorTrackPath(snapshot, "line-d74614a04530");
  assert.match(path, /^M 1132 539 L 1126 539/);
  assert.ok((path.match(/(?:M|L) /g) ?? []).length > 17);
  assert.match(path, /L 1080 486/);
});

async function inputs() {
  const [
    baseFixture,
    topologySnapshot,
    timetableSnapshot,
    routeMapSnapshotBytes,
    daejeonTopologySnapshot,
    daejeonTimetableSnapshot,
    inventory,
    stationMapCsv,
    molitStationMapCsv,
  ] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const topologyFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot: topologySnapshot,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(stationMapCsv),
    now: topologyNow,
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: topologyFixture,
    timetableSnapshot: daejeonTimetableSnapshot,
    topologySnapshot: daejeonTopologySnapshot,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitStationMapCsv),
    now: routeMapNow,
  });
  const timetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture,
    timetableSnapshot,
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  return {
    timetableFixture,
    topologySnapshot,
    routeMapSnapshot: JSON.parse(routeMapSnapshotBytes),
    routeMapSnapshotSha256: createHash("sha256").update(routeMapSnapshotBytes).digest("hex"),
    inventory,
  };
}

test("공식 부산 좌표 snapshot을 누적 production candidate pack에 materialize한다", async () => {
  const {
    timetableFixture, topologySnapshot, routeMapSnapshot, routeMapSnapshotSha256, inventory,
  } = await inputs();
  const fixture = materializeBusanRouteMapPositions({
    baseFixture: timetableFixture,
    snapshot: routeMapSnapshot,
    snapshotSha256: routeMapSnapshotSha256,
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  const pack = fixture.packs[0];
  const rows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === routeMapSnapshot.sourceId);
  const tracks = pack.routeMapLineTracks.filter(({ sourceId }) => sourceId === routeMapSnapshot.sourceId);
  const source = pack.sourceInventory.find(({ id }) => id === routeMapSnapshot.sourceId);

  assert.equal(rows.length, 114);
  assert.equal(tracks.length, 4);
  assert.ok(tracks.every(({ trackIndex, path }) => trackIndex === 0 && /^M \d+ \d+(?: L \d+ \d+)+$/.test(path)));
  assert.deepEqual(
    Object.fromEntries(tracks.map(({ lineId, path }) => [lineId, (path.match(/(?:M|L) /g) ?? []).length])),
    {
      "line-ab1a041f6266": 258,
      "line-d74614a04530": 249,
      "line-d812a5bc1e5f": 196,
      "line-eb7b47920390": 736,
    },
  );
  const station301 = rows.find(({ lineId, sourceLabel }) => (
    lineId === "line-d74614a04530" && sourceLabel === "수영"
  ));
  assert.match(station301.upPath, /^M 1080 486 L 1080 482/);
  assert.equal(station301.downPath, "");
  assert.ok(rows.every(({ labelPolygon }) => labelPolygon.length === 4));
  assert.equal(new Set(rows.map(({ lineId }) => lineId)).size, 4);
  assert.deepEqual(source.coverageScope.lineIds, routeMapSnapshot.lineIds);
  assert.equal(pack.minimumTableRows.route_map_positions, pack.routeMapPositions.length);
  assert.equal(pack.minimumTableRows.route_map_line_tracks, pack.routeMapLineTracks.length);
  assert.match(pack.id, /^nationwide-busan-route-map-[a-f0-9]{64}$/);
  assert.equal(pack.id, `nationwide-busan-route-map-${materializedBusanRouteMapPackContentHash(pack, pack.version)}`);

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === routeMapSnapshot.sourceId)
    .routeMapAdmissionEvidence.positionsSha256 = "0".repeat(64);
  assert.throws(
    () => materializeBusanRouteMapPositions({
      baseFixture: timetableFixture,
      snapshot: routeMapSnapshot,
      snapshotSha256: routeMapSnapshotSha256,
      topologySnapshot,
      inventory: mismatchedInventory,
      now: routeMapNow,
    }),
    /inventory evidence/,
  );
  const tamperedSnapshot = structuredClone(routeMapSnapshot);
  tamperedSnapshot.connectors[0].path = "M 0 0 L 1 1";
  assert.throws(
    () => materializeBusanRouteMapPositions({
      baseFixture: timetableFixture,
      snapshot: tamperedSnapshot,
      snapshotSha256: routeMapSnapshotSha256,
      topologySnapshot,
      inventory,
      now: routeMapNow,
    }),
    /invalid Busan route map positions snapshot/,
  );
  const incompleteFixture = structuredClone(timetableFixture);
  incompleteFixture.packs[0].stationLines = incompleteFixture.packs[0].stationLines.filter(
    ({ lineId, stationCode }) => !(lineId === "line-ab1a041f6266" && stationCode === "95"),
  );
  assert.throws(
    () => materializeBusanRouteMapPositions({
      baseFixture: incompleteFixture,
      snapshot: routeMapSnapshot,
      snapshotSha256: routeMapSnapshotSha256,
      topologySnapshot,
      inventory,
      now: routeMapNow,
    }),
    /canonical station scope/,
  );
  const swappedFixture = structuredClone(timetableFixture);
  const station95 = swappedFixture.packs[0].stationLines.find(
    ({ lineId, stationCode }) => lineId === "line-ab1a041f6266" && stationCode === "95",
  );
  const station96 = swappedFixture.packs[0].stationLines.find(
    ({ lineId, stationCode }) => lineId === "line-ab1a041f6266" && stationCode === "96",
  );
  [station95.stationId, station96.stationId] = [station96.stationId, station95.stationId];
  assert.throws(
    () => materializeBusanRouteMapPositions({
      baseFixture: swappedFixture,
      snapshot: routeMapSnapshot,
      snapshotSha256: routeMapSnapshotSha256,
      topologySnapshot,
      inventory,
      now: routeMapNow,
    }),
    /topology lineage mismatch/,
  );

  const byteDifferentSnapshotSha256 = createHash("sha256")
    .update(`${JSON.stringify(routeMapSnapshot, null, 2)}\n`)
    .digest("hex");
  assert.notEqual(byteDifferentSnapshotSha256, routeMapSnapshotSha256);
  assert.throws(
    () => materializeBusanRouteMapPositions({
      baseFixture: timetableFixture,
      snapshot: routeMapSnapshot,
      snapshotSha256: byteDifferentSnapshotSha256,
      topologySnapshot,
      inventory,
      now: routeMapNow,
    }),
    /snapshot byte identity/,
  );
});

test("materialized SQLite와 provenance가 부산 route_map_positions 4건을 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-busan-route-map-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const {
    timetableFixture, topologySnapshot, routeMapSnapshot, routeMapSnapshotSha256, inventory,
  } = await inputs();
  const fixture = materializeBusanRouteMapPositions({
    baseFixture: timetableFixture,
    snapshot: routeMapSnapshot,
    snapshotSha256: routeMapSnapshotSha256,
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
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
    .get(routeMapSnapshot.sourceId).count, 114);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM route_map_positions WHERE source_id = ? AND label_polygon <> ''")
    .get(routeMapSnapshot.sourceId).count, 114);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM route_map_line_tracks WHERE source_id = ?")
    .get(routeMapSnapshot.sourceId).count, 4);
  assert.equal(database.prepare("SELECT COUNT(DISTINCT line_id) AS count FROM route_map_line_tracks WHERE region = ?")
    .get("부산권").count, 4);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  const trackRecords = provenance.packs.flatMap(({ records }) => records).filter(
    ({ sourceId, field }) => sourceId === routeMapSnapshot.sourceId && field === "route_map_line_track",
  );
  assert.equal(trackRecords.length, 4);
  assert.ok(trackRecords.every((record) => (
    record.entityType === "route_map_line_track"
      && record.sourceSnapshotId === "busan-transportation-route-map-positions-20260720"
      && record.evidenceHash === routeMapSnapshot.connectorsSha256
      && /^[a-f0-9]{64}$/.test(record.providerRecordHash)
      && record.derivationKind === "OFFICIAL"
  )));

  await execFileAsync(process.execPath, [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets", "tools/datapack/nationwide-coverage-targets.json",
    "--inventory", "tools/datapack/source-inventory.json",
    "--manifest", manifestPath,
    "--provenance", path.join(packOutput, "current.provenance.json"),
    "--resolution-plan", "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json",
    "--resolutions", "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json",
    "--output", reportPath,
    "--allow-gaps",
  ], { cwd: root });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const routeMapRequirements = report.requirements.filter(
    ({ operatorId, sourceDomain }) => operatorId === "busan-transportation" && sourceDomain === "route_map_positions",
  );
  assert.equal(routeMapRequirements.length, 4);
  assert.ok(routeMapRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: 19,
    explicitlyUnsupportedCount: 4,
    missingCount: 247,
    supportedRatio: 0.0704,
    terminalResolutionRatio: 0.0852,
    completionReady: false,
  });
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
