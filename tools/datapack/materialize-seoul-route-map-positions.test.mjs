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

async function inputs() {
  const [
    base, busanTopology, busanTimetable, busanRouteMapBytes,
    daejeonTopology, daejeonTimetable, gwangjuTopology, gwangjuTimetable,
    inventory, regionalMap, molitMap, daeguAccessibility, daeguRouteMapSnapshotBytes, seoulSnapshotBytes,
  ] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
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
    readFile(path.join(root, "tools/datapack/sources/seoul-metro-route-map-positions-20260724.json")),
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
  return {
    baseFixture: daeguRouteMapFixture,
    seoulSnapshot: JSON.parse(seoulSnapshotBytes),
    seoulSnapshotSha256: createHash("sha256").update(seoulSnapshotBytes).digest("hex"),
    inventory,
  };
}

test("공식 서울 위경도 snapshot을 누적 production candidate pack에 materialize한다", async () => {
  const { baseFixture, seoulSnapshot, seoulSnapshotSha256, inventory } = await inputs();
  const cyberstationBefore = baseFixture.packs[0].routeMapPositions
    .filter(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map");
  assert.equal(cyberstationBefore.length, 2);

  const fixture = materializeSeoulRouteMapPositions({
    baseFixture,
    snapshot: seoulSnapshot,
    snapshotSha256: seoulSnapshotSha256,
    inventory,
    now: routeMapNow,
  });
  const pack = fixture.packs[0];
  const rows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const cyberstationAfter = pack.routeMapPositions
    .filter(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map");
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  assert.equal(cyberstationAfter.length, 2);
  assert.deepEqual(cyberstationAfter, cyberstationBefore);
  // admitted 274개 중 capital cyberstation과 PK가 겹치는 사당(seoul-4) 1건만 건너뛴다.
  assert.equal(rows.length, 273);
  assert.equal(new Set(rows.map(({ lineId }) => lineId)).size, 8);
  assert.deepEqual([...new Set(rows.map(({ lineId }) => lineId))].sort(), [...LINE_IDS].sort());
  assert.ok(rows.every(({ labelPolygon, region }) => labelPolygon.length === 4 && region === "수도권"));
  assert.deepEqual(source.coverageScope.lineIds, [...LINE_IDS]);
  assert.equal(pack.minimumTableRows.route_map_positions, pack.routeMapPositions.length);
  assert.match(pack.id, /^nationwide-seoul-route-map-[a-f0-9]{64}$/);
  assert.match(materializedSeoulRouteMapPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260724");
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260724" });

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .routeMapAdmissionEvidence.positionsSha256 = "0".repeat(64);
  assert.throws(
    () => materializeSeoulRouteMapPositions({
      baseFixture, snapshot: seoulSnapshot, snapshotSha256: seoulSnapshotSha256,
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
      baseFixture, snapshot: seoulSnapshot, snapshotSha256: byteDifferentSnapshotSha256,
      inventory, now: routeMapNow,
    }),
    /snapshot byte identity/,
  );
});

test("materialized SQLite와 provenance가 서울 1~8호선 route_map_positions를 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-seoul-route-map-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { baseFixture, seoulSnapshot, seoulSnapshotSha256, inventory } = await inputs();
  const fixture = materializeSeoulRouteMapPositions({
    baseFixture,
    snapshot: seoulSnapshot,
    snapshotSha256: seoulSnapshotSha256,
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
    .get(SOURCE_ID).count, 273);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM route_map_positions WHERE source_id = ?")
    .get("seoulmetro-cyberstation-route-map").count, 2);
  assert.equal(database.prepare(
    "SELECT COUNT(DISTINCT line_id) AS count FROM route_map_positions WHERE source_id IN (?, ?)",
  ).get(SOURCE_ID, "seoulmetro-cyberstation-route-map").count, 8);
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
