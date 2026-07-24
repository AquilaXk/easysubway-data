import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import {
  applyCapitalLine1Topology,
  loadCapitalLine1Snapshot,
  queryAnyangNeighbors,
} from "./apply-capital-line1-topology-to-bundled-pack.mjs";
import {
  LINE_ID,
  normalizeStationName,
  parseCapitalLine1RouteTopology,
} from "./collect-capital-line1-route-topology.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const SNAPSHOT_PATH = path.join(root, "tools/datapack/sources/capital-line1-route-topology-20260724.json");
const RAW_CSV_PATH = path.join(root, "tools/datapack/sources/capital-line1-distance-20260724.csv");
const PACK_PATH = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");

test("공식 CSV 괄호 부기 역명을 pack name_ko 매칭용으로 정규화한다", () => {
  assert.equal(normalizeStationName("청량리(서울시립대입구)"), "청량리");
  assert.equal(normalizeStationName("쌍용(나사렛대)"), "쌍용");
  assert.equal(normalizeStationName("신창(순천향대)"), "신창");
  assert.equal(normalizeStationName("안양"), "안양");
});

test("고정 스냅샷은 원문 CSV와 Anyang 이웃 계약을 만족한다", async () => {
  const snapshot = loadCapitalLine1Snapshot(JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")));
  const rawBytes = await readFile(RAW_CSV_PATH);
  const parsed = parseCapitalLine1RouteTopology(rawBytes, { capturedAt: snapshot.capturedAt });
  assert.equal(parsed.rawSha256, snapshot.rawSha256);
  assert.equal(parsed.contentSha256, snapshot.contentSha256);
  assert.equal(parsed.stationCount, 102);
  assert.equal(parsed.edgeCount, 202);
  assert.equal(parsed.lineId, LINE_ID);

  const anyangNeighbors = [...new Set(
    parsed.edges.filter(({ fromStationName }) => fromStationName === "안양")
      .map(({ toStationName }) => toStationName),
  )].sort((left, right) => left.localeCompare(right, "ko"));
  assert.deepEqual(anyangNeighbors, ["관악", "명학"]);
  assert.ok(!anyangNeighbors.includes("소사"));
});

test("bundled capital pack에 공식 topology를 적용하면 안양 이웃이 관악·명학만이다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capital-line1-apply-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const sqlitePath = path.join(directory, "capital.sqlite");
  await copyFile(PACK_PATH, packPath);

  const beforeSqlite = gunzipSync(await readFile(packPath));
  await writeFile(sqlitePath, beforeSqlite);
  const beforeDb = new DatabaseSync(sqlitePath, { readOnly: true });
  const beforeItx = beforeDb.prepare(`
    SELECT COUNT(*) AS count FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN'
  `).get().count;
  const beforeNeighbors = queryAnyangNeighbors(sqlitePath);
  beforeDb.close();
  const alreadyApplied = JSON.stringify(beforeNeighbors) === JSON.stringify(["관악", "명학"]);
  if (!alreadyApplied) {
    assert.ok(
      beforeNeighbors.includes("소사"),
      "precondition: unfixed pack still has wrong 소사↔안양",
    );
  }

  const { stdout } = await execFileAsync(process.execPath, [
    "tools/datapack/apply-capital-line1-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--snapshot", SNAPSHOT_PATH,
    "--dry-run",
  ], { cwd: root });
  assert.match(stdout, /Anyang=\[관악, 명학\]/);
  // dry-run은 pack을 쓰지 않는다.
  assert.equal(
    Buffer.compare(await readFile(packPath), await readFile(PACK_PATH)),
    0,
  );

  const snapshot = loadCapitalLine1Snapshot(JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")));
  await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
  applyCapitalLine1Topology(sqlitePath, snapshot);
  const neighbors = queryAnyangNeighbors(sqlitePath);
  assert.deepEqual(neighbors, ["관악", "명학"]);

  const afterDb = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const afterItx = afterDb.prepare(`
      SELECT COUNT(*) AS count FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN'
    `).get().count;
    assert.equal(afterItx, beforeItx);
    const rideCount = afterDb.prepare(`
      SELECT COUNT(*) AS count FROM network_edges
      WHERE edge_type = 'RIDE'
        AND service_class = 'SUBWAY'
        AND service_pattern = 'LOCAL'
        AND from_node_id GLOB '*:line-472a81add377'
    `).get().count;
    assert.equal(rideCount, snapshot.edgeCount);

    const sosaAnyang = afterDb.prepare(`
      SELECT COUNT(*) AS count FROM network_edges e
      JOIN stations a ON a.id = substr(e.from_node_id, 1, instr(e.from_node_id, ':') - 1)
      JOIN stations b ON b.id = substr(e.to_node_id, 1, instr(e.to_node_id, ':') - 1)
      WHERE e.service_class = 'SUBWAY'
        AND e.service_pattern = 'LOCAL'
        AND e.edge_type = 'RIDE'
        AND e.from_node_id GLOB '*:line-472a81add377'
        AND ((a.name_ko = '소사' AND b.name_ko = '안양') OR (a.name_ko = '안양' AND b.name_ko = '소사'))
    `).get().count;
    assert.equal(sosaAnyang, 0);

    const guro = afterDb.prepare(`
      SELECT DISTINCT other.name_ko AS name
      FROM network_edges e
      JOIN stations g ON g.name_ko = '구로'
      JOIN station_lines gsl ON gsl.station_id = g.id AND gsl.line_id = ?
      JOIN stations other ON other.id = CASE
        WHEN e.from_node_id = g.id || ':' || ? THEN substr(e.to_node_id, 1, instr(e.to_node_id, ':') - 1)
        ELSE substr(e.from_node_id, 1, instr(e.from_node_id, ':') - 1)
      END
      WHERE e.edge_type = 'RIDE' AND e.service_class = 'SUBWAY' AND e.service_pattern = 'LOCAL'
        AND (e.from_node_id = g.id || ':' || ? OR e.to_node_id = g.id || ':' || ?)
      ORDER BY other.name_ko
    `).all(LINE_ID, LINE_ID, LINE_ID, LINE_ID).map(({ name }) => name);
    assert.deepEqual(guro, ["가산디지털단지", "구일", "신도림"]);
  } finally {
    afterDb.close();
  }

  // CLI write 경로: temp pack에 실제 gzip 기록
  await execFileAsync(process.execPath, [
    "tools/datapack/apply-capital-line1-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--snapshot", SNAPSHOT_PATH,
  ], { cwd: root });
  await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
  assert.deepEqual(queryAnyangNeighbors(sqlitePath), ["관악", "명학"]);
  assert.notEqual(
    Buffer.compare(await readFile(packPath), await readFile(PACK_PATH)),
    0,
  );
});

test("apply는 지원하지 않는 snapshot identity를 거부한다", async () => {
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  snapshot.schemaVersion = 999;
  assert.throws(() => loadCapitalLine1Snapshot(snapshot), /identity is invalid/);
});
