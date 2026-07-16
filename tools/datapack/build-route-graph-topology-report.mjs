#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const ADMITTED_ITX_EDGE_SET_SHA256 = "da771d5264efd198989b6e1c589c130620274f7c7d99c423909f3a1c5acf2b2f";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.manifest || !args.root) {
    throw new Error("usage: build-route-graph-topology-report.mjs --manifest <current.json> --root <pack-root> [--output <report.json>]");
  }
  const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-route-graph-topology-"));
  try {
    const packs = [];
    for (const pack of manifest.packs ?? []) {
      const compressed = await readFile(localPackPathForUrl(args.root, pack));
      const sqlitePath = path.join(temporaryDir, `${pack.id}-v${pack.version}.sqlite`);
      await writeFile(sqlitePath, gunzipSync(compressed));
      packs.push(buildRouteGraphTopologyReport(sqlitePath, pack));
    }
    const report = {
      schemaVersion: 1,
      artifactKind: "route-graph-topology-report",
      manifestVersion: manifest.manifestVersion ?? 1,
      channel: manifest.channel ?? null,
      releaseSequence: manifest.releaseSequence ?? null,
      summary: {
        packCount: packs.length,
        localRideAdjacencyViolationCount: packs.reduce((sum, pack) => sum + pack.violations.localRideAdjacency.length, 0),
        nonAdjacentExpressRideViolationCount: packs.reduce((sum, pack) => sum + pack.violations.nonAdjacentExpressRide.length, 0),
        rideSpeedViolationCount: packs.reduce((sum, pack) => sum + pack.violations.rideSpeed.length, 0),
        disconnectedNodeCount: packs.reduce((sum, pack) => sum + pack.violations.disconnectedNodes.length, 0),
        unreachableDirectedPairCount: packs.reduce((sum, pack) => sum + pack.violations.unreachableDirectedPairs.length, 0),
      },
      packs,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
      await mkdir(path.dirname(args.output), { recursive: true });
      await writeFile(args.output, json);
    } else {
      process.stdout.write(json);
    }
    return report;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export function buildRouteGraphTopologyReport(sqlitePath, pack = {}) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const stationLines = database.prepare("SELECT station_id, line_id, line_sequence FROM station_lines ORDER BY line_id, line_sequence, station_id").all();
    const hasServiceClass = database
      .prepare("PRAGMA table_info(network_edges)")
      .all()
      .some(({ name }) => name === "service_class");
    const edges = database
      .prepare(`
        SELECT id, from_node_id, to_node_id, edge_type, service_pattern,
               ${hasServiceClass ? "service_class" : "'SUBWAY' AS service_class"},
               duration_seconds, distance_meters
        FROM network_edges
        ORDER BY id
      `)
      .all();
    const stationLineByNode = new Map(
      stationLines.map((row) => [stationLineNodeId(row.station_id, row.line_id), row]),
    );
    const graphNodes = new Set(stationLineByNode.keys());
    const routeGraphNodes = connectedLineNodes(stationLines);
    const adjacency = new Map([...routeGraphNodes].map((node) => [node, new Set()]));
    const undirected = new Map([...routeGraphNodes].map((node) => [node, new Set()]));
    const violations = {
      localRideAdjacency: [],
      nonAdjacentExpressRide: [],
      rideSpeed: [],
      disconnectedNodes: [],
      unreachableDirectedPairs: [],
    };
    const edgeCountsByType = {};
    const rideCountsByServicePattern = {};
    const rideCountsByServiceClass = {};
    const itxEdges = edges
      .filter((edge) => String(edge.service_class).toUpperCase() === "ITX_CHEONGCHUN")
      .map((edge) => ({ ...edge }));
    const admittedItxEdgeIds = hashJson(itxEdges) === ADMITTED_ITX_EDGE_SET_SHA256
      ? new Set(itxEdges.map(({ id }) => id))
      : new Set();

    addGeneratedStationTransferEdges(stationLines, routeGraphNodes, adjacency, undirected);
    for (const edge of edges) {
      const edgeType = String(edge.edge_type ?? "").toUpperCase();
      const servicePattern = String(edge.service_pattern || "LOCAL").toUpperCase();
      const serviceClass = String(edge.service_class || "SUBWAY").toUpperCase();
      edgeCountsByType[edgeType] = (edgeCountsByType[edgeType] ?? 0) + 1;
      if (edgeType === "RIDE") {
        rideCountsByServicePattern[servicePattern] = (rideCountsByServicePattern[servicePattern] ?? 0) + 1;
        rideCountsByServiceClass[serviceClass] = (rideCountsByServiceClass[serviceClass] ?? 0) + 1;
        const speedKmh = speed(edge.distance_meters, edge.duration_seconds);
        if (speedKmh !== null && (speedKmh < 15 || speedKmh > 110)) {
          violations.rideSpeed.push({ edgeId: edge.id, speedKmh });
        }
      }
      const fromNode = stationLineNodeFromRouteNodeId(edge.from_node_id);
      const toNode = stationLineNodeFromRouteNodeId(edge.to_node_id);
      const from = stationLineByNode.get(fromNode);
      const to = stationLineByNode.get(toNode);
      if (edgeType === "RIDE" && from && to) {
        const isItxExpress = serviceClass === "ITX_CHEONGCHUN"
          && servicePattern === "EXPRESS";
        const isAdmittedItxEdge = isItxExpress && admittedItxEdgeIds.has(edge.id);
        const invalidAdjacency = from.line_id !== to.line_id
          || Math.abs(from.line_sequence - to.line_sequence) !== 1;
        if (
          (isItxExpress && !isAdmittedItxEdge)
          || (!isItxExpress && invalidAdjacency)
        ) {
          const violation = {
            edgeId: edge.id,
            fromNode,
            toNode,
            fromLineSequence: from.line_sequence,
            toLineSequence: to.line_sequence,
          };
          if (servicePattern === "EXPRESS") {
            violations.nonAdjacentExpressRide.push(violation);
          } else {
            violations.localRideAdjacency.push(violation);
          }
        }
      }
      if (
        serviceClass !== "SUBWAY"
        || !isRouteGraphEdge(edgeType)
        || !routeGraphNodes.has(fromNode)
        || !routeGraphNodes.has(toNode)
      ) {
        continue;
      }
      addEdge(adjacency, fromNode, toNode);
      addEdge(undirected, fromNode, toNode);
      addEdge(undirected, toNode, fromNode);
      if (isTransferEdge(edgeType)) {
        addEdge(adjacency, toNode, fromNode);
      }
    }

    for (const node of routeGraphNodes) {
      if ((undirected.get(node)?.size ?? 0) === 0) {
        violations.disconnectedNodes.push(node);
      }
      const reachable = reachableNodesFrom(node, adjacency);
      for (const other of routeGraphNodes) {
        if (other !== node && !reachable.has(other)) {
          violations.unreachableDirectedPairs.push({ fromNode: node, toNode: other });
        }
      }
    }

    return {
      id: pack.id ?? null,
      version: pack.version ?? null,
      artifactKind: pack.artifactKind ?? null,
      stationLineNodeCount: graphNodes.size,
      routeGraphNodeCount: routeGraphNodes.size,
      networkEdgeCount: edges.length,
      edgeCountsByType,
      rideCountsByServicePattern,
      rideCountsByServiceClass,
      itxServiceLayerSegmentCount: rideCountsByServiceClass.ITX_CHEONGCHUN ?? 0,
      violations,
    };
  } finally {
    database.close();
  }
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function connectedLineNodes(stationLines) {
  const lineCounts = new Map();
  for (const row of stationLines) {
    lineCounts.set(row.line_id, (lineCounts.get(row.line_id) ?? 0) + 1);
  }
  return new Set(
    stationLines
      .filter((row) => (lineCounts.get(row.line_id) ?? 0) > 1)
      .map((row) => stationLineNodeId(row.station_id, row.line_id)),
  );
}

function addGeneratedStationTransferEdges(stationLines, routeGraphNodes, adjacency, undirected) {
  const nodesByStation = new Map();
  for (const row of stationLines) {
    const nodeId = stationLineNodeId(row.station_id, row.line_id);
    if (!routeGraphNodes.has(nodeId)) {
      continue;
    }
    const stationNodes = nodesByStation.get(row.station_id) ?? [];
    stationNodes.push(nodeId);
    nodesByStation.set(row.station_id, stationNodes);
  }
  for (const stationNodes of nodesByStation.values()) {
    for (const fromNode of stationNodes) {
      for (const toNode of stationNodes) {
        if (fromNode === toNode) {
          continue;
        }
        addEdge(adjacency, fromNode, toNode);
        addEdge(undirected, fromNode, toNode);
        addEdge(undirected, toNode, fromNode);
      }
    }
  }
}

function addEdge(graph, from, to) {
  graph.get(from)?.add(to);
}

function reachableNodesFrom(startNode, adjacency) {
  const visited = new Set([startNode]);
  const queue = [startNode];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency.get(queue[index]) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

function stationLineNodeId(stationId, lineId) {
  return `${stationId}:${lineId}`;
}

function stationLineNodeFromRouteNodeId(nodeId) {
  const parts = String(nodeId ?? "").split(":");
  return parts.length >= 2 && parts[0] && parts[1] ? stationLineNodeId(parts[0], parts[1]) : null;
}

function isRouteGraphEdge(edgeType) {
  return edgeType === "RIDE" || isTransferEdge(edgeType);
}

function isTransferEdge(edgeType) {
  return edgeType === "IN_STATION_TRANSFER" || edgeType === "OUT_OF_STATION_TRANSFER" || edgeType === "LEGACY_TRANSFER";
}

function speed(distanceMeters, durationSeconds) {
  return durationSeconds > 0 && distanceMeters > 0 ? (distanceMeters / durationSeconds) * 3.6 : null;
}

function localPackPathForUrl(root, pack) {
  if (/^https:\/\//.test(pack.url)) {
    return path.join(root, "catalog", `${pack.id}-v${pack.version}.sqlite.gz`);
  }
  return path.join(root, pack.url);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}
