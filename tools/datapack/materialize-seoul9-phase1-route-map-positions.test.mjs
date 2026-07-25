import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import {
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuAccessibility } from "./materialize-gwangju-accessibility.mjs";
import { materializeGwangjuRouteMapPositions } from "./materialize-gwangju-route-map-positions.mjs";
import { materializeGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import { materializeDaejeonRouteMapPositions } from "./materialize-daejeon-route-map-positions.mjs";
import {
  materializeSeoul9Phase1RouteMapPositions,
  materializedSeoul9Phase1RouteMapPackContentHash,
} from "./materialize-seoul9-phase1-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T13:09:00.000Z");
const accessibilityNow = new Date("2026-07-24T03:00:00.000Z");
const gwangjuRouteMapNow = new Date("2026-07-25T02:00:00.000Z");
const daejeonRouteMapNow = new Date("2026-07-25T03:00:00.000Z");
const routeMapNow = new Date("2026-07-25T05:00:00.000Z");
const execFileAsync = promisify(execFile);
const SOURCE_ID = "kric-seoul-metro-line9-1-route-map-positions";
const LINE_ID = "line-f0e747248a31";
const LINE_OPERATOR_ID = "operator-936e454d0bfb";
// daejeon route_map 누적 fixture coverage baseline(실측): supportedCount=25.
// 이번 FILE admission이 seoul9 phase1 route_map_positions +1을 만든다.
const DAEJEON_ROUTE_MAP_BASELINE = 25;
const SEOUL9_PHASE1_ROUTE_MAP_SUPPORTED_COUNT = DAEJEON_ROUTE_MAP_BASELINE + 1;
const SCHEMATIC_X_MIN = 694;
const SCHEMATIC_X_MAX = 2219;
const SCHEMATIC_Y_MIN = 995;
const SCHEMATIC_Y_MAX = 1863;

async function inputs() {
  const [
    baseFixture,
    busanTopology,
    busanTimetable,
    busanRouteMapBytes,
    daejeonTopology,
    daejeonTimetable,
    gwangjuTopology,
    gwangjuTimetable,
    accessibilitySnapshot,
    inventory,
    stationMapCsv,
    molitStationMapCsv,
    gwangjuSnapshotBytes,
    daejeonSnapshotBytes,
    phase1SnapshotBytes,
    capitalTopology,
  ] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-accessibility-20260724.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
    readFile(path.join(root, "tools/datapack/sources/gwangju-transportation-route-map-positions-20260725.json")),
    readFile(path.join(root, "tools/datapack/sources/daejeon-transportation-route-map-positions-20260725.json")),
    readFile(path.join(root, "tools/datapack/sources/kric-seoul-metro-line9-1-route-map-positions-20260725.json")),
    readJson("tools/datapack/sources/capital-route-topology-20260724.json"),
  ]);
  const busanTopologyFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot: busanTopology,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(stationMapCsv),
    now: topologyNow,
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: busanTopologyFixture,
    timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitStationMapCsv),
    now: timetableNow,
  });
  const busanTimetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture,
    timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology,
    inventory,
    now: timetableNow,
  });
  const routeMapFixture = materializeBusanRouteMapPositions({
    baseFixture: busanTimetableFixture,
    snapshot: JSON.parse(busanRouteMapBytes),
    snapshotSha256: createHash("sha256").update(busanRouteMapBytes).digest("hex"),
    topologySnapshot: busanTopology,
    inventory,
    now: timetableNow,
  });
  const gwangjuFixture = materializeGwangjuTimetable({
    baseFixture: routeMapFixture,
    timetableSnapshot: gwangjuTimetable,
    topologySnapshot: gwangjuTopology,
    inventory,
    canonicalStationMappings: parseMolitGwangjuStationMappings(molitStationMapCsv),
    now: timetableNow,
  });
  const accessibilityFixture = materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot,
    topologySnapshot: gwangjuTopology,
    inventory,
    now: accessibilityNow,
  });
  const gwangjuRouteMapFixture = materializeGwangjuRouteMapPositions({
    baseFixture: accessibilityFixture,
    snapshot: JSON.parse(gwangjuSnapshotBytes),
    snapshotSha256: createHash("sha256").update(gwangjuSnapshotBytes).digest("hex"),
    topologySnapshot: gwangjuTopology,
    inventory,
    now: gwangjuRouteMapNow,
  });
  const daejeonRouteMapFixture = materializeDaejeonRouteMapPositions({
    baseFixture: gwangjuRouteMapFixture,
    snapshot: JSON.parse(daejeonSnapshotBytes),
    snapshotSha256: createHash("sha256").update(daejeonSnapshotBytes).digest("hex"),
    topologySnapshot: daejeonTopology,
    inventory,
    now: daejeonRouteMapNow,
  });
  return {
    baseFixture: daejeonRouteMapFixture,
    phase1Snapshot: JSON.parse(phase1SnapshotBytes),
    phase1SnapshotSha256: createHash("sha256").update(phase1SnapshotBytes).digest("hex"),
    topologySnapshot: capitalTopology,
    inventory,
  };
}

test("공식 수도권 9호선 1단계 역사좌표 snapshot을 누적 production candidate pack에 materialize한다", async () => {
  const { baseFixture, phase1Snapshot, phase1SnapshotSha256, topologySnapshot, inventory } = await inputs();
  const fixture = materializeSeoul9Phase1RouteMapPositions({
    baseFixture,
    snapshot: phase1Snapshot,
    snapshotSha256: phase1SnapshotSha256,
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  const pack = fixture.packs[0];
  const rows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  assert.equal(rows.length, 25);
  assert.equal(new Set(rows.map(({ lineId }) => lineId)).size, 1);
  assert.deepEqual([...new Set(rows.map(({ lineId }) => lineId))], [LINE_ID]);
  assert.ok(rows.every(({ labelPolygon, region }) => labelPolygon.length === 4 && region === "수도권"));
  assert.ok(rows.every(({ x, y }) => (
    Number.isInteger(x) && Number.isInteger(y)
    && x >= SCHEMATIC_X_MIN && x <= SCHEMATIC_X_MAX
    && y >= SCHEMATIC_Y_MIN && y <= SCHEMATIC_Y_MAX
    && x < 5000 && y < 5000
  )));
  assert.ok(phase1Snapshot.positions.every(({ latitude, longitude, x, y }) => (
    Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude > 37 && longitude > 126
    && Number.isInteger(x) && Number.isInteger(y)
  )));
  const positionsByStationId = new Map(
    phase1Snapshot.positions.map((position) => [position.stationId, position]),
  );
  assert.ok(rows.every((row) => {
    const position = positionsByStationId.get(row.stationId);
    return position != null
      && row.x === position.x
      && row.y === position.y
      && row.labelDx === position.labelDx
      && row.labelDy === position.labelDy;
  }), "materialized canvas coordinates must equal snapshot positions without projection");
  assert.equal(phase1Snapshot.schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
  assert.deepEqual(source.coverageScope.lineIds, [LINE_ID]);
  assert.deepEqual(source.coverageScope.operatorIds, [LINE_OPERATOR_ID]);
  assert.equal(pack.minimumTableRows.route_map_positions, pack.routeMapPositions.length);
  assert.match(pack.id, /^nationwide-seoul9-phase1-route-map-[a-f0-9]{64}$/);
  assert.match(materializedSeoul9Phase1RouteMapPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260725");
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260725" });
  assert.ok(pack.operators.some(({ id }) => id === LINE_OPERATOR_ID));
  assert.ok(pack.coverageLineOperatorScopes?.some((scope) => (
    scope.lineId === LINE_ID && scope.operatorId === LINE_OPERATOR_ID
  )));
  assert.deepEqual(
    pack.coverageLineOperatorScopes
      ?.filter((scope) => scope.lineId === LINE_ID)
      .map(({ operatorId }) => operatorId)
      .sort(),
    [LINE_OPERATOR_ID],
  );
  assert.ok(pack.sourceInventory.some(({ id }) => id === "daejeon-transportation-route-map-positions"));

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .routeMapAdmissionEvidence.positionsSha256 = "0".repeat(64);
  assert.throws(
    () => materializeSeoul9Phase1RouteMapPositions({
      baseFixture, snapshot: phase1Snapshot, snapshotSha256: phase1SnapshotSha256,
      topologySnapshot, inventory: mismatchedInventory, now: routeMapNow,
    }),
    /inventory evidence/,
  );
  const byteDifferentSnapshotSha256 = createHash("sha256")
    .update(`${JSON.stringify(phase1Snapshot, null, 2)}\n`)
    .digest("hex");
  assert.notEqual(byteDifferentSnapshotSha256, phase1SnapshotSha256);
  assert.throws(
    () => materializeSeoul9Phase1RouteMapPositions({
      baseFixture, snapshot: phase1Snapshot, snapshotSha256: byteDifferentSnapshotSha256,
      topologySnapshot, inventory, now: routeMapNow,
    }),
    /snapshot byte identity/,
  );
});

test("materialized SQLite와 provenance가 수도권 9호선 1단계 route_map_positions를 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-seoul9-phase1-route-map-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { baseFixture, phase1Snapshot, phase1SnapshotSha256, topologySnapshot, inventory } = await inputs();
  const fixture = materializeSeoul9Phase1RouteMapPositions({
    baseFixture,
    snapshot: phase1Snapshot,
    snapshotSha256: phase1SnapshotSha256,
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
    .get(SOURCE_ID).count, 25);
  assert.equal(database.prepare(
    "SELECT COUNT(DISTINCT line_id) AS count FROM route_map_positions WHERE source_id = ?",
  ).get(SOURCE_ID).count, 1);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  for (const field of ["route_map_position", "route_map_label_polygon"]) {
    const fieldRecords = provenance.packs.flatMap(({ records }) => records).filter(
      ({ sourceId, field: recordField }) => sourceId === SOURCE_ID && recordField === field,
    );
    assert.ok(fieldRecords.length > 0, `provenance missing field: ${field}`);
    assert.deepEqual(
      [...new Set(fieldRecords.flatMap(({ coverageScope }) => coverageScope?.lineIds ?? []))],
      [LINE_ID],
    );
  }

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
    ({ lineId, sourceDomain }) => lineId === LINE_ID && sourceDomain === "route_map_positions",
  );
  assert.equal(routeMapRequirements.length, 1);
  assert.ok(routeMapRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(routeMapRequirements.map(({ lineId }) => lineId), [LINE_ID]);
  assert.ok(routeMapRequirements.every(({ operatorId }) => operatorId === LINE_OPERATOR_ID));
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: SEOUL9_PHASE1_ROUTE_MAP_SUPPORTED_COUNT,
    explicitlyUnsupportedCount: 4,
    missingCount: 270 - SEOUL9_PHASE1_ROUTE_MAP_SUPPORTED_COUNT - 4,
    supportedRatio: Number((SEOUL9_PHASE1_ROUTE_MAP_SUPPORTED_COUNT / 270).toFixed(4)),
    terminalResolutionRatio: Number(((SEOUL9_PHASE1_ROUTE_MAP_SUPPORTED_COUNT + 4) / 270).toFixed(4)),
    completionReady: false,
  });
});

test("서울9 phase1 route_map_positions materialize는 metro_map_pack·capital.sqlite.gz를 건드리지 않는다", async () => {
  const { stdout } = await execFileAsync("git", [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    "apps/mobile/assets/datapacks/metro_map_pack",
    "apps/mobile/assets/datapacks/capital.sqlite.gz",
  ], { cwd: root });
  assert.equal(stdout.trim(), "");
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
