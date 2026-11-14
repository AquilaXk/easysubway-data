import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  coverageNodeId,
  stationLineNodeFromEdgeEndpoint,
  validateStationCarDoorHints,
} from "./validate-datapack.mjs";

const itxExpressRide = {
  edge_type: "RIDE",
  service_class: "ITX_CHEONGCHUN",
  service_pattern: "EXPRESS",
};

test("network edge endpoints accept only exact station-line nodes except ITX EXPRESS RIDE", () => {
  assert.equal(
    stationLineNodeFromEdgeEndpoint("station-a:line-1", { edge_type: "RIDE", service_class: "SUBWAY", service_pattern: "LOCAL" }),
    "station-a:line-1",
  );
  assert.equal(stationLineNodeFromEdgeEndpoint("station-a:line-k:EXPRESS", itxExpressRide), "station-a:line-k");
  assert.equal(coverageNodeId("station-a:line-1"), "station-a:line-1");
  assert.equal(coverageNodeId("station-a:line-k:EXPRESS"), "station-a:line-k:EXPRESS");
  assert.equal(coverageNodeId("station-a:line-k:LOCAL"), "station-a:line-k:LOCAL");

  for (const [suffix, edge] of [
    ["LOCAL", { edge_type: "RIDE", service_class: "SUBWAY", service_pattern: "LOCAL" }],
    ["EXPRESS", { edge_type: "RIDE", service_class: "SUBWAY", service_pattern: "EXPRESS" }],
    ["LOCAL", { edge_type: "TRANSFER", service_class: "SUBWAY", service_pattern: "LOCAL" }],
    ["EXPRESS", { edge_type: "TRANSFER", service_class: "SUBWAY", service_pattern: "EXPRESS" }],
    ["LOCAL", { edge_type: "RIDE", service_class: "ITX_CHEONGCHUN", service_pattern: "EXPRESS" }],
    ["EXPRESS", { edge_type: "RIDE", service_class: "ITX_CHEONGCHUN", service_pattern: "LOCAL" }],
  ]) {
    assert.equal(stationLineNodeFromEdgeEndpoint(`station-a:line-1:${suffix}`, edge), null);
  }
});

test("datapack and route-map source scripts do not contain raw 0x00 NUL bytes", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const offenders = [];
  for (const relativeDir of ["tools/datapack", "tools/route-map", "tools/ci", "tools/release"]) {
    const dir = path.join(repoRoot, relativeDir);
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(?:mjs|js|sh|json|yml|yaml)$/.test(entry.name)) continue;
      const fullPath = path.join(entry.parentPath, entry.name);
      const bytes = readFileSync(fullPath);
      if (bytes.includes(0)) {
        offenders.push(path.relative(repoRoot, fullPath));
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("validateStationCarDoorHints rejects missing station-line pairs without delimiter collisions", () => {
  const createDb = (stationLines, hints) => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE station_lines (station_id TEXT NOT NULL, line_id TEXT NOT NULL);
      CREATE TABLE station_car_door_hints (
        id INTEGER PRIMARY KEY,
        station_id TEXT NOT NULL,
        line_id TEXT NOT NULL,
        target_facility_type TEXT NOT NULL,
        car_number INTEGER NOT NULL,
        door_number INTEGER NOT NULL
      );
    `);
    const insLine = db.prepare("INSERT INTO station_lines (station_id, line_id) VALUES (?, ?)");
    for (const [s, l] of stationLines) insLine.run(s, l);
    const insHint = db.prepare(
      "INSERT INTO station_car_door_hints (id, station_id, line_id, target_facility_type, car_number, door_number) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const [id, s, l, type, car, door] of hints) insHint.run(id, s, l, type, car, door);
    return db;
  };

  const validDb = createDb([["s1", "l1"]], [[1, "s1", "l1", "ELEVATOR", 2, 3]]);
  assert.doesNotThrow(() => validateStationCarDoorHints(validDb, { id: "nationwide", version: "1" }));
  validDb.close();

  const missingDb = createDb([["s1", "l1"]], [[2, "s1", "l2", "STAIR", 1, 1]]);
  assert.throws(
    () => validateStationCarDoorHints(missingDb, { id: "nationwide", version: "1" }),
    /references missing station-line: 2/,
  );
  missingDb.close();

  const collisionDb = createDb([["a", "b\u0000c"]], [[3, "a\u0000b", "c", "ELEVATOR", 1, 1]]);
  assert.throws(
    () => validateStationCarDoorHints(collisionDb, { id: "nationwide", version: "1" }),
    /references missing station-line: 3/,
  );
  collisionDb.close();
});
