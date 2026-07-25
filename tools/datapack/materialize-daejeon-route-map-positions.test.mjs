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
import {
  materializeDaejeonRouteMapPositions,
  materializedDaejeonRouteMapPackContentHash,
} from "./materialize-daejeon-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T13:09:00.000Z");
const accessibilityNow = new Date("2026-07-24T03:00:00.000Z");
const gwangjuRouteMapNow = new Date("2026-07-25T02:00:00.000Z");
const routeMapNow = new Date("2026-07-25T03:00:00.000Z");
const execFileAsync = promisify(execFile);
const SOURCE_ID = "daejeon-transportation-route-map-positions";
const LINE_ID = "line-7051a9c2525c";
const OPERATOR_ID = "daejeon-transportation";
// gwangju route_map 누적 fixture coverage baseline(실측): supportedCount=24.
// 이번 FILE admission이 daejeon route_map_positions +1을 만든다.
const GWANGJU_ROUTE_MAP_BASELINE_SUPPORTED_COUNT = 24;
const DAEJEON_ROUTE_MAP_SUPPORTED_COUNT = GWANGJU_ROUTE_MAP_BASELINE_SUPPORTED_COUNT + 1;

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
  return {
    baseFixture: gwangjuRouteMapFixture,
    daejeonSnapshot: JSON.parse(daejeonSnapshotBytes),
    daejeonSnapshotSha256: createHash("sha256").update(daejeonSnapshotBytes).digest("hex"),
    topologySnapshot: daejeonTopology,
    inventory,
  };
}

test("공식 대전 KRIC 역사정보 위경도 snapshot을 누적 production candidate pack에 materialize한다", async () => {
  const { baseFixture, daejeonSnapshot, daejeonSnapshotSha256, topologySnapshot, inventory } = await inputs();
  const fixture = materializeDaejeonRouteMapPositions({
    baseFixture,
    snapshot: daejeonSnapshot,
    snapshotSha256: daejeonSnapshotSha256,
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  const pack = fixture.packs[0];
  const rows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  assert.equal(rows.length, 22);
  assert.equal(new Set(rows.map(({ lineId }) => lineId)).size, 1);
  assert.deepEqual([...new Set(rows.map(({ lineId }) => lineId))], [LINE_ID]);
  assert.ok(rows.every(({ labelPolygon, region }) => labelPolygon.length === 4 && region === "대전권"));
  assert.ok(rows.every(({ x, y }) => (
    Number.isInteger(x) && Number.isInteger(y)
    && x >= 540 && x <= 1584 && y >= 240 && y <= 1560
    && x < 5000 && y < 5000
  )));
  assert.ok(daejeonSnapshot.positions.every(({ latitude, longitude, x, y }) => (
    Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude > 36 && longitude > 127
    && Number.isInteger(x) && Number.isInteger(y)
  )));
  assert.equal(daejeonSnapshot.schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
  assert.deepEqual(source.coverageScope.lineIds, [LINE_ID]);
  assert.equal(pack.minimumTableRows.route_map_positions, pack.routeMapPositions.length);
  assert.match(pack.id, /^nationwide-daejeon-route-map-[a-f0-9]{64}$/);
  assert.match(materializedDaejeonRouteMapPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260725");
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260725" });
  assert.ok(pack.operators.some(({ id }) => id === OPERATOR_ID));
  assert.ok(pack.sourceInventory.some(({ id }) => id === "daejeon-train-timetable"));

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .routeMapAdmissionEvidence.positionsSha256 = "0".repeat(64);
  assert.throws(
    () => materializeDaejeonRouteMapPositions({
      baseFixture, snapshot: daejeonSnapshot, snapshotSha256: daejeonSnapshotSha256,
      topologySnapshot, inventory: mismatchedInventory, now: routeMapNow,
    }),
    /inventory evidence/,
  );
  const byteDifferentSnapshotSha256 = createHash("sha256")
    .update(`${JSON.stringify(daejeonSnapshot, null, 2)}\n`)
    .digest("hex");
  assert.notEqual(byteDifferentSnapshotSha256, daejeonSnapshotSha256);
  assert.throws(
    () => materializeDaejeonRouteMapPositions({
      baseFixture, snapshot: daejeonSnapshot, snapshotSha256: byteDifferentSnapshotSha256,
      topologySnapshot, inventory, now: routeMapNow,
    }),
    /snapshot byte identity/,
  );
});

test("materialized SQLite와 provenance가 대전 1호선 route_map_positions를 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-daejeon-route-map-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { baseFixture, daejeonSnapshot, daejeonSnapshotSha256, topologySnapshot, inventory } = await inputs();
  const fixture = materializeDaejeonRouteMapPositions({
    baseFixture,
    snapshot: daejeonSnapshot,
    snapshotSha256: daejeonSnapshotSha256,
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
    .get(SOURCE_ID).count, 22);
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
    ({ operatorId, sourceDomain }) => operatorId === OPERATOR_ID && sourceDomain === "route_map_positions",
  );
  assert.equal(routeMapRequirements.length, 1);
  assert.ok(routeMapRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(routeMapRequirements.map(({ lineId }) => lineId), [LINE_ID]);
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: DAEJEON_ROUTE_MAP_SUPPORTED_COUNT,
    explicitlyUnsupportedCount: 4,
    missingCount: 270 - DAEJEON_ROUTE_MAP_SUPPORTED_COUNT - 4,
    supportedRatio: Number((DAEJEON_ROUTE_MAP_SUPPORTED_COUNT / 270).toFixed(4)),
    terminalResolutionRatio: Number(((DAEJEON_ROUTE_MAP_SUPPORTED_COUNT + 4) / 270).toFixed(4)),
    completionReady: false,
  });
});

test("대전 route_map_positions materialize는 metro_map_pack·capital.sqlite.gz를 건드리지 않는다", async () => {
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
