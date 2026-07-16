import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildRouteGraphTopologyReport } from "./build-route-graph-topology-report.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

test("route graph topology report exposes LOCAL adjacency and speed violations", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-4", 1],
      ["station-b", "line-4", 2],
      ["station-c", "line-4", 5],
    ],
    edges: [
      ["edge-a-b-local", "station-a:line-4:LOCAL", "station-b:line-4:LOCAL", "RIDE", "LOCAL", 120, 1000],
      ["edge-a-c-local", "station-a:line-4:LOCAL", "station-c:line-4:LOCAL", "RIDE", "LOCAL", 30, 5000],
      ["edge-c-a-express", "station-c:line-4:EXPRESS", "station-a:line-4:EXPRESS", "RIDE", "EXPRESS", 600, 5000],
    ],
  });

  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "production",
  });

  assert.equal(report.stationLineNodeCount, 3);
  assert.equal(report.edgeCountsByType.RIDE, 3);
  assert.deepEqual(report.rideCountsByServicePattern, { EXPRESS: 1, LOCAL: 2 });
  assert.deepEqual(report.violations.localRideAdjacency, [
    {
      edgeId: "edge-a-c-local",
      fromNode: "station-a:line-4",
      toNode: "station-c:line-4",
      fromLineSequence: 1,
      toLineSequence: 5,
    },
  ]);
  assert.deepEqual(report.violations.nonAdjacentExpressRide, [
    {
      edgeId: "edge-c-a-express",
      fromNode: "station-c:line-4",
      toNode: "station-a:line-4",
      fromLineSequence: 5,
      toLineSequence: 1,
    },
  ]);
  assert.deepEqual(report.violations.rideSpeed.map((row) => row.edgeId), ["edge-a-c-local"]);
  assert.equal(report.violations.unreachableDirectedPairs.length, 2);
});

test("route graph topology report seeds implicit same-station transfers", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-2", 10],
      ["station-a", "line-4", 20],
      ["station-b", "line-2", 11],
      ["station-c", "line-4", 21],
    ],
    edges: [
      ["edge-a-b-line2", "station-a:line-2:LOCAL", "station-b:line-2:LOCAL", "RIDE", "LOCAL", 120, 1000],
      ["edge-b-a-line2", "station-b:line-2:LOCAL", "station-a:line-2:LOCAL", "RIDE", "LOCAL", 120, 1000],
      ["edge-a-c-line4", "station-a:line-4:LOCAL", "station-c:line-4:LOCAL", "RIDE", "LOCAL", 120, 1000],
      ["edge-c-a-line4", "station-c:line-4:LOCAL", "station-a:line-4:LOCAL", "RIDE", "LOCAL", 120, 1000],
    ],
  });

  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "production",
  });

  assert.equal(report.routeGraphNodeCount, 4);
  assert.equal(report.violations.unreachableDirectedPairs.length, 0);
});

test("route graph topology report는 ITX service layer row를 별도 집계한다", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k2", 1],
      ["station-b", "line-k2", 2],
    ],
    edges: [
      ["edge-a-b-itx", "station-a:line-k2:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 300, 6000, "ITX_CHEONGCHUN"],
    ],
  });

  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "fixture",
  });

  assert.deepEqual(report.rideCountsByServiceClass, { ITX_CHEONGCHUN: 1 });
  assert.equal(report.itxServiceLayerSegmentCount, 1);
  assert.equal(report.violations.nonAdjacentExpressRide.length, 1);
});

test("route graph topology report는 승인되지 않은 ITX 노선 경계 edge를 거부한다", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k1", 10],
      ["station-b", "line-k2", 20],
    ],
    edges: [
      ["edge-a-b-itx", "station-a:line-k1:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 0, 0, "ITX_CHEONGCHUN"],
    ],
  });

  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "fixture",
  });

  assert.equal(report.itxServiceLayerSegmentCount, 1);
  assert.deepEqual(report.violations.nonAdjacentExpressRide, [
    {
      edgeId: "edge-a-b-itx",
      fromNode: "station-a:line-k1",
      toNode: "station-b:line-k2",
      fromLineSequence: 10,
      toLineSequence: 20,
    },
  ]);
});

test("route graph topology report는 #2135 admitted ITX edge set만 예외로 허용한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "route-graph-admitted-itx-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, "capital.sqlite");
  await writeFile(sqlitePath, gunzipSync(await readFile(
    path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"),
  )));

  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "capital",
    version: "18",
    artifactKind: "production",
  });

  assert.equal(report.itxServiceLayerSegmentCount, 48);
  assert.deepEqual(report.violations.nonAdjacentExpressRide, []);
});

test("route graph topology report는 SUBWAY 연결성을 ITX edge로 보완하지 않는다", () => {
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-k2", 1],
      ["station-b", "line-k2", 2],
      ["station-c", "line-k2", 3],
    ],
    edges: [
      ["subway-a-b", "station-a:line-k2:LOCAL", "station-b:line-k2:LOCAL", "RIDE", "LOCAL", 120, 1000],
      ["subway-b-a", "station-b:line-k2:LOCAL", "station-a:line-k2:LOCAL", "RIDE", "LOCAL", 120, 1000],
      ["itx-b-c", "station-b:line-k2:EXPRESS", "station-c:line-k2:EXPRESS", "RIDE", "EXPRESS", 120, 1000, "ITX_CHEONGCHUN"],
      ["itx-c-b", "station-c:line-k2:EXPRESS", "station-b:line-k2:EXPRESS", "RIDE", "EXPRESS", 120, 1000, "ITX_CHEONGCHUN"],
    ],
  });

  const report = buildRouteGraphTopologyReport(sqlitePath, {
    id: "capital",
    version: "1",
    artifactKind: "fixture",
  });

  assert.deepEqual(report.violations.disconnectedNodes, ["station-c:line-k2"]);
  assert.equal(report.violations.unreachableDirectedPairs.length, 4);
});

test("route graph topology report CLI writes artifact json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "route-graph-topology-report-"));
  await mkdir(path.join(dir, "catalog"), { recursive: true });
  const sqlitePath = createTopologySqlite({
    stationLines: [
      ["station-a", "line-4", 1],
      ["station-b", "line-4", 2],
    ],
    edges: [
      ["edge-a-b-local", "station-a:line-4:LOCAL", "station-b:line-4:LOCAL", "RIDE", "LOCAL", 120, 1000],
      ["edge-b-a-local", "station-b:line-4:LOCAL", "station-a:line-4:LOCAL", "RIDE", "LOCAL", 120, 1000],
    ],
  });
  const sqliteBytes = await readFile(sqlitePath);
  await writeFile(path.join(dir, "catalog", "capital-v1.sqlite.gz"), gzipSync(sqliteBytes));
  const manifestPath = path.join(dir, "current.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      manifestVersion: 2,
      channel: "production",
      releaseSequence: 7,
      packs: [
        {
          id: "capital",
          version: "1",
          artifactKind: "production",
          url: "catalog/capital-v1.sqlite.gz",
        },
      ],
    })}\n`,
  );
  const outputPath = path.join(dir, "route-graph-topology-report.json");

  await execFileAsync(process.execPath, [
    "tools/datapack/build-route-graph-topology-report.mjs",
    "--manifest",
    manifestPath,
    "--root",
    dir,
    "--output",
    outputPath,
  ], { cwd: root });

  const report = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(report.artifactKind, "route-graph-topology-report");
  assert.equal(report.summary.packCount, 1);
  assert.equal(report.summary.localRideAdjacencyViolationCount, 0);
  assert.equal(report.summary.nonAdjacentExpressRideViolationCount, 0);
  assert.equal(report.summary.rideSpeedViolationCount, 0);
  assert.equal(report.summary.unreachableDirectedPairCount, 0);
});

function createTopologySqlite({ stationLines, edges }) {
  const sqlitePath = path.join(tmpdir(), `route-graph-topology-${Date.now()}-${Math.random()}.sqlite`);
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE station_lines (
        station_id TEXT NOT NULL,
        line_id TEXT NOT NULL,
        line_sequence INTEGER NOT NULL
      );
      CREATE TABLE network_edges (
        id TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        service_pattern TEXT NOT NULL,
        service_class TEXT NOT NULL DEFAULT 'SUBWAY',
        duration_seconds INTEGER NOT NULL,
        distance_meters INTEGER NOT NULL
      );
    `);
    const insertStationLine = database.prepare("INSERT INTO station_lines VALUES (?, ?, ?)");
    const insertEdge = database.prepare(`
      INSERT INTO network_edges (
        id, from_node_id, to_node_id, edge_type, service_pattern,
        duration_seconds, distance_meters, service_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of stationLines) {
      insertStationLine.run(...row);
    }
    for (const row of edges) {
      insertEdge.run(...row, ...(row.length === 7 ? ["SUBWAY"] : []));
    }
  } finally {
    database.close();
  }
  return sqlitePath;
}
