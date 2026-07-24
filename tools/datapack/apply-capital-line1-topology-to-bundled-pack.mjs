#!/usr/bin/env node
/**
 * capital-line1-route-topology snapshot → capital.sqlite.gz LOCAL SUBWAY RIDE edges.
 * line-472a81add377 의 기존 SUBWAY LOCAL RIDE만 교체하고 ITX 등 다른 service_class는 보존한다.
 *
 * 수도권 전 노선 적용은 apply-capital-route-topology-to-bundled-pack.mjs 를 사용한다.
 * 이 스크립트는 line-1 단독 스냅샷/회귀 테스트용으로 유지한다.
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
  LINE_ID,
  SOURCE_ID,
  normalizeStationName,
} from "./collect-capital-line1-route-topology.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const DEFAULT_SNAPSHOT = "tools/datapack/sources/capital-line1-route-topology-20260724.json";
const DEFAULT_PACK = "apps/mobile/assets/datapacks/capital.sqlite.gz";

/** CSV/스냅샷 역명 → pack stations.name_ko 별칭(정규화 후). */
const STATION_NAME_ALIASES = Object.freeze({
  // 필요 시 확장. 현재 공식 CSV는 괄호 제거만으로 name_ko와 일치한다.
});

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryPath(value) {
  return path.resolve(root, value);
}

export function loadCapitalLine1Snapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1
    || snapshot?.artifactKind !== ARTIFACT_KIND
    || snapshot?.sourceId !== SOURCE_ID
    || snapshot?.lineId !== LINE_ID
    || !Array.isArray(snapshot.edges)
    || snapshot.edges.length === 0) {
    throw new Error("capital line-1 topology snapshot identity is invalid");
  }
  if (snapshot.contentSha256 !== sha256(JSON.stringify({
    scope: snapshot.scope,
    edges: snapshot.edges,
  }))) {
    throw new Error("capital line-1 topology snapshot contentSha256 mismatch");
  }
  return snapshot;
}

export function resolveStationIdByName(database, stationName) {
  const normalized = STATION_NAME_ALIASES[normalizeStationName(stationName)]
    ?? normalizeStationName(stationName);
  const candidates = database.prepare(`
    SELECT s.id AS stationId, s.name_ko AS nameKo
    FROM stations s
    JOIN station_lines sl ON sl.station_id = s.id
    WHERE sl.line_id = ?
  `).all(LINE_ID);
  const matches = candidates.filter(({ nameKo }) => {
    const packName = nameKo.normalize("NFKC");
    return packName === normalized || normalizeStationName(nameKo) === normalized;
  });
  if (matches.length === 1) return matches[0].stationId;
  if (matches.length > 1) {
    throw new Error(`capital line-1 station name is ambiguous: ${stationName}`);
  }
  throw new Error(`capital line-1 station name not found on ${LINE_ID}: ${stationName}`);
}

function buildStationIdMap(database, snapshot) {
  const names = new Set(snapshot.edges.flatMap(({ fromStationName, toStationName }) => [
    fromStationName,
    toStationName,
  ]));
  const map = new Map();
  for (const name of [...names].sort(codepointCompare)) {
    map.set(name, resolveStationIdByName(database, name));
  }
  return map;
}

export function materializeCapitalLine1Edges(snapshot, stationIdByName) {
  const edges = [];
  for (const edge of snapshot.edges) {
    const fromStationId = stationIdByName.get(edge.fromStationName);
    const toStationId = stationIdByName.get(edge.toStationName);
    if (fromStationId == null || toStationId == null) {
      throw new Error(`capital line-1 edge station unresolved: ${edge.fromStationName}->${edge.toStationName}`);
    }
    const fromNodeId = `${fromStationId}:${LINE_ID}`;
    const toNodeId = `${toStationId}:${LINE_ID}`;
    edges.push({
      id: `edge-${LINE_ID}-${fromStationId}-${toStationId}`,
      fromNodeId,
      toNodeId,
      durationSeconds: Number.isInteger(edge.durationSeconds) ? edge.durationSeconds : 0,
      distanceMeters: edge.distanceMeters,
      edgeType: "RIDE",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
    });
  }
  edges.sort((left, right) => codepointCompare(left.id, right.id));
  if (new Set(edges.map(({ id }) => id)).size !== edges.length) {
    throw new Error("capital line-1 materialized edge ids are not unique");
  }
  return edges;
}

export function applyCapitalLine1Topology(sqlitePath, snapshot) {
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      const stationIdByName = buildStationIdMap(database, snapshot);
      const edges = materializeCapitalLine1Edges(snapshot, stationIdByName);

      // 해당 lineId 노드가 포함된 SUBWAY LOCAL RIDE만 제거. ITX/EXPRESS 등은 유지.
      database.prepare(`
        DELETE FROM network_edges
        WHERE edge_type = 'RIDE'
          AND service_class = 'SUBWAY'
          AND service_pattern = 'LOCAL'
          AND (
            from_node_id LIKE '%' || ?
            OR to_node_id LIKE '%' || ?
          )
          AND (
            from_node_id GLOB '*:line-472a81add377'
            OR to_node_id GLOB '*:line-472a81add377'
          )
      `).run(`:${LINE_ID}`, `:${LINE_ID}`);

      const insert = database.prepare(`
        INSERT INTO network_edges (
          id, from_node_id, to_node_id, duration_seconds, distance_meters,
          edge_type, service_pattern, service_class
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
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

      const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeys.length !== 0) throw new Error("capital line-1 topology foreign_key_check failed");
      const integrity = database.prepare("PRAGMA integrity_check").get();
      if (integrity.integrity_check !== "ok") throw new Error("capital line-1 topology integrity_check failed");
      database.exec("COMMIT");
      return { edgeCount: edges.length, stationCount: stationIdByName.size };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function queryAnyangNeighbors(sqlitePath) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const anyang = database.prepare(`
      SELECT s.id AS stationId
      FROM stations s
      JOIN station_lines sl ON sl.station_id = s.id
      WHERE sl.line_id = ? AND s.name_ko = '안양'
    `).get(LINE_ID);
    if (anyang == null) throw new Error("안양 station missing on capital line-1");
    const nodeId = `${anyang.stationId}:${LINE_ID}`;
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

async function main() {
  const packPath = path.resolve(root, option("--pack", DEFAULT_PACK));
  const snapshotPath = path.resolve(root, option("--snapshot", DEFAULT_SNAPSHOT));
  const checkOnly = process.argv.includes("--check-neighbors");
  const snapshot = loadCapitalLine1Snapshot(JSON.parse(await readFile(snapshotPath, "utf8")));

  const directory = await mkdtemp(path.join(os.tmpdir(), `capital-line1-topology-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    const inputGzipBytes = await readFile(packPath);
    const inputSqliteBytes = gunzipSync(inputGzipBytes);
    await writeFile(sqlitePath, inputSqliteBytes);
    const beforeItx = countServiceClass(sqlitePath, "ITX_CHEONGCHUN");
    applyCapitalLine1Topology(sqlitePath, snapshot);
    const afterItx = countServiceClass(sqlitePath, "ITX_CHEONGCHUN");
    if (beforeItx !== afterItx) {
      throw new Error("capital line-1 apply must preserve ITX_CHEONGCHUN edges");
    }
    const neighbors = queryAnyangNeighbors(sqlitePath);
    if (JSON.stringify(neighbors) !== JSON.stringify(["관악", "명학"])) {
      throw new Error(`Anyang neighbors must be 관악,명학; got ${neighbors.join(",") || "none"}`);
    }
    if (checkOnly) {
      process.stdout.write(`Anyang neighbors: ${neighbors.join(", ")}\n`);
      return;
    }
    if (process.argv.includes("--dry-run")) {
      process.stdout.write(
        `dry-run ok: edges=${snapshot.edgeCount} Anyang=[${neighbors.join(", ")}] `
        + `(pack not written)\n`,
      );
      return;
    }
    const outputSqliteBytes = await readFile(sqlitePath);
    const outputGzipBytes = gzipSync(outputSqliteBytes, { level: 9, mtime: 0 });
    await writeFile(packPath, outputGzipBytes);
    process.stdout.write(
      `capital line-1 topology applied: edges=${snapshot.edgeCount} `
      + `Anyang=[${neighbors.join(", ")}] pack=${packPath}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
