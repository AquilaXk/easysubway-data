import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { listCapitalWideRailRouteMapPositionLines } from "./collect-kric-capital-wide-rail-route-map-positions.mjs";
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
import { materializeSeoul9Phase1RouteMapPositions } from "./materialize-seoul9-phase1-route-map-positions.mjs";
import {
  materializeCapitalWideRailRouteMapPositions,
  materializedCapitalWideRailRouteMapPackContentHash,
} from "./materialize-kric-capital-wide-rail-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T13:09:00.000Z");
const accessibilityNow = new Date("2026-07-24T03:00:00.000Z");
const gwangjuRouteMapNow = new Date("2026-07-25T02:00:00.000Z");
const daejeonRouteMapNow = new Date("2026-07-25T03:00:00.000Z");
const seoul9RouteMapNow = new Date("2026-07-25T05:00:00.000Z");
const routeMapNow = new Date("2026-07-25T06:00:00.000Z");
const SAMPLE_SOURCE_ID = "kric-airport-railroad-route-map-positions";
const SAMPLE_LINE_ID = "line-e9e9a5b520a4";
const SAMPLE_OPERATOR_ID = "operator-8134e61f8dbd";

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

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
    sampleSnapshotBytes,
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
    readFile(path.join(root, "tools/datapack/sources", `${SAMPLE_SOURCE_ID}-20260725.json`)),
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
  const seoul9Fixture = materializeSeoul9Phase1RouteMapPositions({
    baseFixture: daejeonRouteMapFixture,
    snapshot: JSON.parse(phase1SnapshotBytes),
    snapshotSha256: createHash("sha256").update(phase1SnapshotBytes).digest("hex"),
    topologySnapshot: capitalTopology,
    inventory,
    now: seoul9RouteMapNow,
  });
  return {
    baseFixture: seoul9Fixture,
    sampleSnapshot: JSON.parse(sampleSnapshotBytes),
    sampleSnapshotSha256: createHash("sha256").update(sampleSnapshotBytes).digest("hex"),
    topologySnapshot: capitalTopology,
    inventory,
  };
}

test("공식 공항철도 역사좌표 snapshot을 누적 production candidate pack에 materialize한다", async () => {
  const { baseFixture, sampleSnapshot, sampleSnapshotSha256, topologySnapshot, inventory } = await inputs();
  const fixture = materializeCapitalWideRailRouteMapPositions({
    baseFixture,
    snapshot: sampleSnapshot,
    snapshotSha256: sampleSnapshotSha256,
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  const pack = fixture.packs[0];
  const rows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === SAMPLE_SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SAMPLE_SOURCE_ID);

  assert.equal(rows.length, 14);
  assert.deepEqual([...new Set(rows.map(({ lineId }) => lineId))], [SAMPLE_LINE_ID]);
  assert.ok(rows.every(({ labelPolygon, region }) => labelPolygon.length === 4 && region === "수도권"));
  assert.ok(rows.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x < 5000 && y < 5000));
  const positionsByStationId = new Map(
    sampleSnapshot.positions.map((position) => [position.stationId, position]),
  );
  assert.ok(rows.every((row) => {
    const position = positionsByStationId.get(row.stationId);
    return position != null
      && row.x === position.x
      && row.y === position.y
      && row.labelDx === position.labelDx
      && row.labelDy === position.labelDy;
  }), "materialized canvas coordinates must equal snapshot positions without projection");
  assert.deepEqual(source.coverageScope.lineIds, [SAMPLE_LINE_ID]);
  assert.deepEqual(source.coverageScope.operatorIds, [SAMPLE_OPERATOR_ID]);
  assert.equal(pack.minimumTableRows.route_map_positions, pack.routeMapPositions.length);
  assert.match(pack.id, /^nationwide-capital-wide-rail-route-map-[a-f0-9]{64}$/);
  assert.match(materializedCapitalWideRailRouteMapPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260725");
  assert.ok(pack.operators.some(({ id }) => id === SAMPLE_OPERATOR_ID));
  assert.ok(pack.coverageLineOperatorScopes?.some((scope) => (
    scope.lineId === SAMPLE_LINE_ID && scope.operatorId === SAMPLE_OPERATOR_ID
  )));

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SAMPLE_SOURCE_ID)
    .routeMapAdmissionEvidence.positionsSha256 = "0".repeat(64);
  assert.throws(
    () => materializeCapitalWideRailRouteMapPositions({
      baseFixture, snapshot: sampleSnapshot, snapshotSha256: sampleSnapshotSha256,
      topologySnapshot, inventory: mismatchedInventory, now: routeMapNow,
    }),
    /inventory evidence/,
  );
});

test("8노선 inventory evidence·snapshot byte identity가 모두 맞물린다", async () => {
  const inventory = await readJson("tools/datapack/source-inventory.json");
  for (const line of listCapitalWideRailRouteMapPositionLines()) {
    const snapshotBytes = await readFile(
      path.join(root, "tools/datapack/sources", `${line.sourceId}-20260725.json`),
    );
    const snapshot = JSON.parse(snapshotBytes);
    const source = inventory.sources.find(({ id }) => id === line.sourceId);
    assert.ok(source, line.sourceId);
    assert.equal(
      source.routeMapAdmissionEvidence.snapshotSha256,
      createHash("sha256").update(snapshotBytes).digest("hex"),
    );
    assert.equal(source.routeMapAdmissionEvidence.rawSha256, snapshot.rawSha256);
    assert.equal(source.routeMapAdmissionEvidence.stationCount, snapshot.stationCount);
    assert.equal(source.routeMapAdmissionEvidence.quarantinedCount, snapshot.quarantinedCount);
    assert.equal(source.routeMapAdmissionEvidence.issue, 2503);
    assert.equal(source.routeMapAdmissionEvidence.admissionKind, "official-file-latlon");
  }
});

test("capital-wide rail route_map_positions materialize는 metro_map_pack·capital.sqlite.gz를 건드리지 않는다", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
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
