#!/usr/bin/env node
/**
 * capital-route-topology snapshot → capital.sqlite.gz LOCAL SUBWAY RIDE edges.
 * snapshot.lines 에 있는 capital map lineId 의 SUBWAY LOCAL RIDE 만 교체.
 * topologyGaps lineId · ITX_CHEONGCHUN · 비수도권 노선은 보존.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import {
  ARTIFACT_KIND,
  CAPITAL_MAP_LINE_IDS,
  SOURCE_ID,
  normalizeStationName,
} from "./collect-capital-route-topology.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const DEFAULT_SNAPSHOT = "tools/datapack/sources/capital-route-topology-20260724.json";
const DEFAULT_PACK = "apps/mobile/assets/datapacks/capital.sqlite.gz";
const DEFAULT_INDEX = "apps/mobile/assets/datapacks/index.json";

/** CSV/스냅샷 역명 → pack stations.name_ko 별칭(정규화 후). */
const STATION_NAME_ALIASES = Object.freeze({
  능길: "신길온천",
  김포공항역: "김포공항",
  부천종합운동장역: "부천종합운동장",
});

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function loadCapitalRouteTopologySnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1
    || snapshot?.artifactKind !== ARTIFACT_KIND
    || snapshot?.sourceId !== SOURCE_ID
    || !Array.isArray(snapshot.lines)
    || snapshot.lines.length === 0) {
    throw new Error("capital route topology snapshot identity is invalid");
  }
  const payload = {
    lines: snapshot.lines.map(({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId }) => ({
      lineId,
      edgeCount,
      stationCount,
      contentSha256,
      rawSha256,
      datasetId,
    })),
    topologyGaps: snapshot.topologyGaps ?? [],
  };
  if (snapshot.contentSha256 !== sha256(JSON.stringify(payload))) {
    throw new Error("capital route topology snapshot contentSha256 mismatch");
  }
  const gapIds = new Set((snapshot.topologyGaps ?? []).map(({ lineId }) => lineId));
  for (const line of snapshot.lines) {
    if (!CAPITAL_MAP_LINE_IDS.includes(line.lineId)) {
      throw new Error(`snapshot lineId not in capital map: ${line.lineId}`);
    }
    if (gapIds.has(line.lineId)) {
      throw new Error(`snapshot lineId also listed as gap: ${line.lineId}`);
    }
    if (!Array.isArray(line.edges) || line.edges.length === 0) {
      throw new Error(`snapshot line has no edges: ${line.lineId}`);
    }
    if (line.contentSha256 !== sha256(JSON.stringify({ scope: line.scope, edges: line.edges }))) {
      throw new Error(`line contentSha256 mismatch: ${line.lineId}`);
    }
  }
  return snapshot;
}

export function resolveStationIdByName(database, lineId, stationName) {
  const normalized = STATION_NAME_ALIASES[normalizeStationName(stationName)]
    ?? normalizeStationName(stationName);
  const candidates = database.prepare(`
    SELECT s.id AS stationId, s.name_ko AS nameKo
    FROM stations s
    JOIN station_lines sl ON sl.station_id = s.id
    WHERE sl.line_id = ?
  `).all(lineId);
  const matches = candidates.filter(({ nameKo }) => {
    const packName = nameKo.normalize("NFKC");
    return packName === normalized
      || normalizeStationName(nameKo) === normalized
      || normalizeStationName(nameKo) === normalizeStationName(normalized);
  });
  if (matches.length === 1) return matches[0].stationId;
  if (matches.length > 1) {
    throw new Error(`station name is ambiguous on ${lineId}: ${stationName}`);
  }
  throw new Error(`station name not found on ${lineId}: ${stationName}`);
}

function buildStationIdMap(database, lineId, edges) {
  const names = new Set(edges.flatMap(({ fromStationName, toStationName }) => [
    fromStationName,
    toStationName,
  ]));
  const map = new Map();
  for (const name of [...names].sort(codepointCompare)) {
    map.set(name, resolveStationIdByName(database, lineId, name));
  }
  return map;
}

function undirectedPairKey(leftNodeId, rightNodeId) {
  return [leftNodeId, rightNodeId].sort(codepointCompare).join("\0");
}

export function materializeLineEdges(lineId, edges, stationIdByName) {
  const out = [];
  for (const edge of edges) {
    const fromStationId = stationIdByName.get(edge.fromStationName);
    const toStationId = stationIdByName.get(edge.toStationName);
    if (fromStationId == null || toStationId == null) {
      throw new Error(`edge station unresolved on ${lineId}: ${edge.fromStationName}->${edge.toStationName}`);
    }
    out.push({
      id: `edge-${lineId}-${fromStationId}-${toStationId}`,
      fromNodeId: `${fromStationId}:${lineId}`,
      toNodeId: `${toStationId}:${lineId}`,
      durationSeconds: Number.isInteger(edge.durationSeconds) ? edge.durationSeconds : 0,
      distanceMeters: edge.distanceMeters,
      edgeType: "RIDE",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
    });
  }
  out.sort((left, right) => codepointCompare(left.id, right.id));
  if (new Set(out.map(({ id }) => id)).size !== out.length) {
    throw new Error(`materialized edge ids are not unique for ${lineId}`);
  }
  return out;
}

export function applyCapitalRouteTopology(sqlitePath, snapshot) {
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      const gapIds = new Set((snapshot.topologyGaps ?? []).map(({ lineId }) => lineId));
      const applied = [];
      const insert = database.prepare(`
        INSERT INTO network_edges (
          id, from_node_id, to_node_id, duration_seconds, distance_meters,
          edge_type, service_pattern, service_class
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const deleteLine = database.prepare(`
        DELETE FROM network_edges
        WHERE edge_type = 'RIDE'
          AND service_class = 'SUBWAY'
          AND service_pattern = 'LOCAL'
          AND (
            from_node_id GLOB ?
            OR to_node_id GLOB ?
          )
      `);

      const selectLine = database.prepare(`
        SELECT id,
               from_node_id AS fromNodeId,
               to_node_id AS toNodeId,
               duration_seconds AS durationSeconds,
               distance_meters AS distanceMeters,
               edge_type AS edgeType,
               service_pattern AS servicePattern,
               includes_stairs AS includesStairs,
               stair_access_state AS stairAccessState,
               accessibility_status AS accessibilityStatus,
               reliability_score AS reliabilityScore,
               last_verified_at AS lastVerifiedAt,
               facility_id AS facilityId,
               service_class AS serviceClass
        FROM network_edges
        WHERE edge_type = 'RIDE'
          AND service_class = 'SUBWAY'
          AND service_pattern = 'LOCAL'
          AND (
            from_node_id GLOB ?
            OR to_node_id GLOB ?
          )
      `);
      const insertPreserved = database.prepare(`
        INSERT INTO network_edges (
          id, from_node_id, to_node_id, duration_seconds, distance_meters,
          edge_type, service_pattern, includes_stairs, stair_access_state,
          accessibility_status, reliability_score, last_verified_at, facility_id,
          service_class
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const selectTimetablePairs = database.prepare(`
        SELECT DISTINCT
          (st1.station_id || ':' || st1.line_id) AS fromNodeId,
          (st2.station_id || ':' || st2.line_id) AS toNodeId
        FROM transit_stop_times st1
        JOIN transit_stop_times st2
          ON st1.trip_id = st2.trip_id
         AND st2.stop_sequence = st1.stop_sequence + 1
        WHERE st1.line_id = ?
      `);

      for (const line of snapshot.lines) {
        if (gapIds.has(line.lineId)) continue;
        const stationIdByName = buildStationIdMap(database, line.lineId, line.edges);
        const edges = materializeLineEdges(line.lineId, line.edges, stationIdByName);
        const glob = `*:${line.lineId}`;
        // 공식 consecutive topology에 없지만 timetable stop_times에서 연속 정차하는
        // hop(예: seoul-4 KRIC pilot 상록수↔사당)만 보존한다. 안양↔소사처럼
        // timetable에 없는 잘못된 hop은 버린다.
        const previous = selectLine.all(glob, glob);
        const officialPairs = new Set(
          edges.map((edge) => undirectedPairKey(edge.fromNodeId, edge.toNodeId)),
        );
        const timetablePairs = new Set(
          selectTimetablePairs.all(line.lineId)
            .map((row) => undirectedPairKey(row.fromNodeId, row.toNodeId)),
        );
        const preserved = previous.filter((edge) => {
          const pair = undirectedPairKey(edge.fromNodeId, edge.toNodeId);
          return !officialPairs.has(pair) && timetablePairs.has(pair);
        });
        deleteLine.run(glob, glob);
        for (const edge of edges) {
          insert.run(
            edge.id,
            edge.fromNodeId,
            edge.toNodeId,
            edge.durationSeconds,
            edge.distanceMeters,
            edge.edgeType,
            edge.servicePattern,
            edge.serviceClass,
          );
        }
        for (const edge of preserved) {
          insertPreserved.run(
            edge.id,
            edge.fromNodeId,
            edge.toNodeId,
            edge.durationSeconds,
            edge.distanceMeters,
            edge.edgeType,
            edge.servicePattern,
            edge.includesStairs,
            edge.stairAccessState,
            edge.accessibilityStatus,
            edge.reliabilityScore,
            edge.lastVerifiedAt,
            edge.facilityId,
            edge.serviceClass,
          );
        }
        applied.push({
          lineId: line.lineId,
          edgeCount: edges.length + preserved.length,
          stationCount: stationIdByName.size,
          preservedHopCount: preserved.length,
        });
      }

      const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeys.length !== 0) throw new Error("capital topology foreign_key_check failed");
      const integrity = database.prepare("PRAGMA integrity_check").get();
      if (integrity.integrity_check !== "ok") throw new Error("capital topology integrity_check failed");
      database.exec("COMMIT");
      return { applied };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function queryNeighbors(sqlitePath, lineId, stationNameKo) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const station = database.prepare(`
      SELECT s.id AS stationId
      FROM stations s
      JOIN station_lines sl ON sl.station_id = s.id
      WHERE sl.line_id = ? AND s.name_ko = ?
    `).get(lineId, stationNameKo);
    if (station == null) throw new Error(`${stationNameKo} missing on ${lineId}`);
    const nodeId = `${station.stationId}:${lineId}`;
    const rows = database.prepare(`
      SELECT DISTINCT other.name_ko AS neighborName
      FROM network_edges e
      JOIN stations other ON other.id = CASE
        WHEN e.from_node_id = ? THEN substr(e.to_node_id, 1, instr(e.to_node_id, ':') - 1)
        ELSE substr(e.from_node_id, 1, instr(e.from_node_id, ':') - 1)
      END
      WHERE e.edge_type = 'RIDE'
        AND e.service_class = 'SUBWAY'
        AND e.service_pattern = 'LOCAL'
        AND (e.from_node_id = ? OR e.to_node_id = ?)
      ORDER BY other.name_ko
    `).all(nodeId, nodeId, nodeId);
    return rows.map(({ neighborName }) => neighborName);
  } finally {
    database.close();
  }
}

export function queryAnyangNeighbors(sqlitePath) {
  return queryNeighbors(sqlitePath, "line-472a81add377", "안양");
}

function countServiceClass(sqlitePath, serviceClass) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT COUNT(*) AS count FROM network_edges WHERE service_class = ?
    `).get(serviceClass).count;
  } finally {
    database.close();
  }
}

function countLocalRide(sqlitePath, lineId) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT COUNT(*) AS count FROM network_edges
      WHERE edge_type = 'RIDE'
        AND service_class = 'SUBWAY'
        AND service_pattern = 'LOCAL'
        AND from_node_id GLOB ?
    `).get(`*:${lineId}`).count;
  } finally {
    database.close();
  }
}

async function updateIndex(indexPath, packPath, sqliteBytes, gzipBytes) {
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const pack = index.packs.find(({ id }) => id === "capital");
  if (!pack) throw new Error("capital pack index entry is missing");
  Object.assign(pack, {
    sha256: sha256(gzipBytes),
    sqliteSha256: sha256(sqliteBytes),
    byteSize: gzipBytes.length,
  });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

async function main() {
  const packPath = path.resolve(root, option("--pack", DEFAULT_PACK));
  const snapshotPath = path.resolve(root, option("--snapshot", DEFAULT_SNAPSHOT));
  const indexPath = path.resolve(root, option("--index", DEFAULT_INDEX));
  const checkOnly = process.argv.includes("--check-neighbors");
  const dryRun = process.argv.includes("--dry-run");
  const snapshot = loadCapitalRouteTopologySnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));

  const directory = await mkdtemp(path.join(os.tmpdir(), `capital-route-topology-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    const inputGzipBytes = await readFile(packPath);
    await writeFile(sqlitePath, gunzipSync(inputGzipBytes));
    const beforeItx = countServiceClass(sqlitePath, "ITX_CHEONGCHUN");
    const beforeGaps = Object.fromEntries(
      (snapshot.topologyGaps ?? []).map(({ lineId }) => [lineId, countLocalRide(sqlitePath, lineId)]),
    );

    const { applied } = applyCapitalRouteTopology(sqlitePath, snapshot);
    const afterItx = countServiceClass(sqlitePath, "ITX_CHEONGCHUN");
    if (beforeItx !== afterItx) {
      throw new Error("apply must preserve ITX_CHEONGCHUN edges");
    }
    for (const [lineId, before] of Object.entries(beforeGaps)) {
      const after = countLocalRide(sqlitePath, lineId);
      if (after !== before) {
        throw new Error(`gap line edges changed for ${lineId}: ${before} -> ${after}`);
      }
    }

    const anyang = queryAnyangNeighbors(sqlitePath);
    if (JSON.stringify(anyang) !== JSON.stringify(["관악", "명학"])) {
      throw new Error(`Anyang neighbors must be 관악,명학; got ${anyang.join(",") || "none"}`);
    }

    if (checkOnly) {
      process.stdout.write(`Anyang neighbors: ${anyang.join(", ")}\n`);
      for (const row of applied) {
        process.stdout.write(`  ${row.lineId} edges=${row.edgeCount}\n`);
      }
      return;
    }
    if (dryRun) {
      process.stdout.write(
        `dry-run ok: lines=${applied.length} totalEdges=${applied.reduce((s, r) => s + r.edgeCount, 0)} `
        + `Anyang=[${anyang.join(", ")}] (pack not written)\n`,
      );
      return;
    }

    const outputSqliteBytes = await readFile(sqlitePath);
    const outputGzipBytes = gzipSync(outputSqliteBytes, { level: 9, mtime: 0 });
    await writeFile(packPath, outputGzipBytes);
    await updateIndex(indexPath, packPath, outputSqliteBytes, outputGzipBytes);
    process.stdout.write(
      `capital route topology applied: lines=${applied.length} `
      + `edges=${applied.reduce((s, r) => s + r.edgeCount, 0)} `
      + `Anyang=[${anyang.join(", ")}] pack=${packPath}\n`,
    );
    for (const row of applied) {
      process.stdout.write(`  ${row.lineId} edges=${row.edgeCount}\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
