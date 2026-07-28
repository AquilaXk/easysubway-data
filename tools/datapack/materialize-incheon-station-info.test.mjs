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
import { materializeGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import {
  materializeIncheonStationInfo,
  materializedIncheonPackContentHash,
} from "./materialize-incheon-station-info.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T13:09:00.000Z");
const accessibilityNow = new Date("2026-07-24T03:00:00.000Z");
const incheonNow = new Date("2026-07-24T06:00:00.000Z");
const SOURCE_ID = "incheon-transit-station-info";
const OPERATOR_ID = "incheon-transit";
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE7 = "line-15b3b8a93259";
// gwangju accessibility 누적 fixture coverage baseline(실측): supportedCount=23 → incheon +8 = 31.
const GWANGJU_ACCESSIBILITY_BASELINE_SUPPORTED_COUNT = 23;
const INCHEON_SUPPORTED_COUNT = GWANGJU_ACCESSIBILITY_BASELINE_SUPPORTED_COUNT + 8;

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
    incheonBytes,
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
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-accessibility-20260724.json"),
    readFile(path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260724.json")),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
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
  const incheonSnapshot = JSON.parse(incheonBytes.toString("utf8"));
  return {
    accessibilityFixture,
    incheonSnapshot,
    incheonBytes,
    inventory,
  };
}

test("인천 station-info를 membership·topology·route_map으로 materialize한다", async () => {
  const { accessibilityFixture, incheonSnapshot, incheonBytes, inventory } = await inputs();
  const fixture = materializeIncheonStationInfo({
    baseFixture: accessibilityFixture,
    snapshot: incheonSnapshot,
    snapshotSha256: createHash("sha256").update(incheonBytes).digest("hex"),
    inventory,
    now: incheonNow,
  });
  const pack = fixture.packs[0];
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);
  const stationLines = pack.stationLines.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const edges = pack.networkEdges.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const positions = pack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const stations = pack.stations.filter(({ sourceId }) => sourceId === SOURCE_ID);

  assert.equal(stations.length, 69);
  assert.equal(stationLines.length, 71);
  assert.equal(edges.length, 116);
  assert.equal(positions.length, 71);
  assert.equal(stationLines.filter(({ lineId }) => lineId === LINE1).length, 33);
  assert.equal(stationLines.filter(({ lineId }) => lineId === LINE2).length, 27);
  assert.equal(stationLines.filter(({ lineId }) => lineId === LINE7).length, 11);
  assert.equal(edges.filter(({ fromNodeId }) => fromNodeId.endsWith(`:${LINE1}`)).length, 64);
  assert.equal(edges.filter(({ fromNodeId }) => fromNodeId.endsWith(`:${LINE2}`)).length, 52);
  assert.equal(edges.filter(({ fromNodeId }) => fromNodeId.endsWith(`:${LINE7}`)).length, 0);
  assert.ok(edges.every(({ durationSeconds, distanceMeters }) => (
    durationSeconds === 120 && distanceMeters === 0
  )));
  assert.equal(stationLines.find(({ stationCode, lineId }) => (
    lineId === LINE1 && stationCode === "3139"
  ))?.stationId, "station-dc474ca1fe74");
  assert.equal(
    stationLines.find(({ stationCode, lineId }) => lineId === LINE1 && stationCode === "3124")?.stationId,
    stationLines.find(({ stationCode, lineId }) => lineId === LINE2 && stationCode === "3221")?.stationId,
  );
  assert.equal(
    stationLines.find(({ stationCode, lineId }) => lineId === LINE1 && stationCode === "3118")?.stationId,
    stationLines.find(({ stationCode, lineId }) => lineId === LINE7 && stationCode === "3761")?.stationId,
  );
  assert.equal(
    stationLines.find(({ stationCode, lineId }) => lineId === LINE7 && stationCode === "3763")?.stationId,
    "station-57db2f1fb4f6",
  );
  assert.equal(
    stationLines.find(({ stationCode, lineId }) => lineId === LINE2 && stationCode === "3213")?.stationId,
    "station-37866f28b417",
  );
  assert.equal(
    stations.filter(({ id }) => id === "station-662a880cfe7d").length,
    1,
  );
  assert.equal(
    stations.filter(({ id }) => id === "station-57db2f1fb4f6" || id === "station-37866f28b417").length,
    2,
  );
  assert.ok(pack.operators.some(({ id }) => id === OPERATOR_ID));
  assert.ok(pack.lines.some(({ id, operatorId }) => id === LINE7 && operatorId === OPERATOR_ID));
  assert.deepEqual(
    pack.lines.filter(({ operatorId }) => operatorId === OPERATOR_ID).map(({ id }) => id).sort(),
    [LINE2, LINE1, LINE7].sort(),
  );
  assert.deepEqual(source.coverageScope.lineIds, [LINE2, LINE1, LINE7]);
  assert.deepEqual(source.coverageScope.sourceDomains, [
    "route_graph_topology",
    "route_map_positions",
    "station_line_membership",
  ]);
  assert.ok(pack.coverageLineOperatorScopes?.some((scope) => (
    scope.operatorId === OPERATOR_ID && scope.lineId === LINE7
  )));
  assert.equal(pack.version, "20260724");
  assert.match(pack.id, /^nationwide-incheon-station-info-[a-f0-9]{64}$/);
  assert.match(materializedIncheonPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260724" });
});

test("인천 station-info materialize는 freshness·hash·중복을 fail closed한다", async () => {
  const { accessibilityFixture, incheonSnapshot, incheonBytes, inventory } = await inputs();
  const snapshotSha256 = createHash("sha256").update(incheonBytes).digest("hex");

  assert.throws(() => materializeIncheonStationInfo({
    baseFixture: accessibilityFixture,
    snapshot: incheonSnapshot,
    snapshotSha256,
    inventory,
    now: new Date("2026-07-25T06:00:00.000Z"),
  }), /inventory evidence|fresh/);

  const mismatchedRouteMapFreshness = structuredClone(inventory);
  mismatchedRouteMapFreshness.sources.find(({ id }) => id === SOURCE_ID)
    .routeMapAdmissionEvidence.freshUntil = "2026-07-25T06:00:00.000Z";
  assert.throws(() => materializeIncheonStationInfo({
    baseFixture: accessibilityFixture,
    snapshot: incheonSnapshot,
    snapshotSha256,
    inventory: mismatchedRouteMapFreshness,
    now: incheonNow,
  }), /route-map freshness contract is invalid/);

  const badHash = structuredClone(incheonSnapshot);
  badHash.contentSha256 = "0".repeat(64);
  assert.throws(() => materializeIncheonStationInfo({
    baseFixture: accessibilityFixture,
    snapshot: badHash,
    snapshotSha256,
    inventory,
    now: incheonNow,
  }), /snapshot/);

  const admitted = materializeIncheonStationInfo({
    baseFixture: accessibilityFixture,
    snapshot: incheonSnapshot,
    snapshotSha256,
    inventory,
    now: incheonNow,
  });
  assert.throws(() => materializeIncheonStationInfo({
    baseFixture: admitted,
    snapshot: incheonSnapshot,
    snapshotSha256,
    inventory,
    now: incheonNow,
  }), /already exists/);
});

test("materialized SQLite와 provenance가 인천 1·2호선 6 + 7호선 membership/positions 2 requirements를 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-station-info-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { accessibilityFixture, incheonSnapshot, incheonBytes, inventory } = await inputs();
  const fixture = materializeIncheonStationInfo({
    baseFixture: accessibilityFixture,
    snapshot: incheonSnapshot,
    snapshotSha256: createHash("sha256").update(incheonBytes).digest("hex"),
    inventory,
    now: incheonNow,
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
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_lines WHERE line_id IN (?, ?, ?)")
    .get(LINE1, LINE2, LINE7).count, 71);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_lines WHERE line_id = ?")
    .get(LINE7).count, 11);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE source_id = ?")
    .get(SOURCE_ID).count, 116);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE from_node_id LIKE ?")
    .get(`%:${LINE7}`).count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM route_map_positions WHERE source_id = ?")
    .get(SOURCE_ID).count, 71);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM station_lines
    WHERE line_id = ? AND station_code = '3139'
  `).get(LINE1).count, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM station_lines
    WHERE line_id = ? AND station_code LIKE '37%'
  `).get(LINE7).count, 11);
  assert.equal(database.prepare(`
    SELECT station_id AS stationId FROM station_lines
    WHERE line_id = ? AND station_code = '3763'
  `).get(LINE7).stationId, "station-57db2f1fb4f6");
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM stations WHERE id IN (?, ?)
  `).get("station-57db2f1fb4f6", "station-37866f28b417").count, 2);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM stations WHERE id = ?
  `).get("station-662a880cfe7d").count, 1);
  database.close();

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
  const incheon12 = report.requirements.filter(({ operatorId, lineId, sourceDomain }) => (
    operatorId === OPERATOR_ID
      && [LINE1, LINE2].includes(lineId)
      && ["station_line_membership", "route_graph_topology", "route_map_positions"].includes(sourceDomain)
  ));
  assert.equal(incheon12.length, 6);
  assert.ok(incheon12.every(({ status }) => status === "SUPPORTED"));
  const incheon7 = report.requirements.filter(({ operatorId, lineId, sourceDomain }) => (
    operatorId === OPERATOR_ID
      && lineId === LINE7
      && ["station_line_membership", "route_map_positions", "route_graph_topology"].includes(sourceDomain)
  ));
  assert.equal(incheon7.length, 3);
  assert.deepEqual(
    Object.fromEntries(incheon7.map(({ sourceDomain, status }) => [sourceDomain, status])),
    {
      station_line_membership: "SUPPORTED",
      route_map_positions: "SUPPORTED",
      route_graph_topology: "MISSING",
    },
  );
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: INCHEON_SUPPORTED_COUNT,
    explicitlyUnsupportedCount: 4,
    missingCount: 270 - INCHEON_SUPPORTED_COUNT - 4,
    supportedRatio: Number((INCHEON_SUPPORTED_COUNT / 270).toFixed(4)),
    terminalResolutionRatio: Number(((INCHEON_SUPPORTED_COUNT + 4) / 270).toFixed(4)),
    completionReady: false,
  });
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
