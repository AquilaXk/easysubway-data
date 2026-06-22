#!/usr/bin/env node
import { createHash, createVerify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { usesLocalPlaceholderHost } from "./production-url-policy.mjs";

const productionMinimumTableRowNames = ["stations", "station_lines", "network_edges", "facilities"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(requireArg(args, "manifest"));
  const root = path.resolve(requireArg(args, "root"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);

  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-validate-"));
  try {
    for (const pack of manifest.packs) {
      await validatePack(root, temporaryDir, pack);
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function validatePack(root, temporaryDir, pack) {
  const compressedPath = localPackPathForUrl(root, pack);
  const compressedBytes = await readFile(compressedPath);
  if (compressedBytes.length !== pack.sizeBytes) {
    throw new Error(`${pack.id}@${pack.version} sizeBytes mismatch: ${compressedBytes.length}`);
  }
  const compressedSha = sha256(compressedBytes);
  if (compressedSha !== pack.sha256) {
    throw new Error(`${pack.id}@${pack.version} compressed checksum mismatch: ${compressedSha}`);
  }

  const sqliteBytes = gunzipSync(compressedBytes);
  const sqliteSha = sha256(sqliteBytes);
  if (sqliteSha !== pack.sqliteSha256) {
    throw new Error(`${pack.id}@${pack.version} sqlite checksum mismatch: ${sqliteSha}`);
  }
  const signature = packSignature(pack);
  if (
    pack.signature.algorithm !== signature.algorithm ||
    pack.signature.value !== signature.value
  ) {
    throw new Error(`${pack.id}@${pack.version} signature mismatch`);
  }
  const routeRegressionSignature = representativeRouteRegressionSignature(pack);
  if (
    pack.representativeRouteRegressionSignature.algorithm !== routeRegressionSignature.algorithm ||
    pack.representativeRouteRegressionSignature.value !== routeRegressionSignature.value
  ) {
    throw new Error(`${pack.id}@${pack.version} representativeRouteRegressionSignature mismatch`);
  }

  const sqlitePath = path.join(temporaryDir, `${pack.id}-v${pack.version}.sqlite`);
  await writeFile(sqlitePath, sqliteBytes);
  validateSqlite(sqlitePath, pack);
}

function localPackPathForUrl(root, pack) {
  if (/^https:\/\//.test(pack.url)) {
    return path.join(root, stagedPackPath(pack));
  }
  return path.join(root, pack.url);
}

function validateSqlite(sqlitePath, pack) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    if (quickCheck.some((row) => row.quick_check !== "ok")) {
      throw new Error(`${pack.id}@${pack.version} PRAGMA quick_check failed`);
    }

    const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyRows.length > 0) {
      throw new Error(`${pack.id}@${pack.version} PRAGMA foreign_key_check failed`);
    }

    const metadata = database.prepare("SELECT value FROM catalog_metadata WHERE key = 'schemaVersion'").get();
    if (!metadata || metadata.value !== pack.schemaVersion) {
      throw new Error(`${pack.id}@${pack.version} schemaVersion mismatch`);
    }
    const userVersion = database.prepare("PRAGMA user_version").get().user_version;
    if (userVersion !== Number(pack.schemaVersion)) {
      throw new Error(`${pack.id}@${pack.version} PRAGMA user_version mismatch`);
    }

    for (const tableName of pack.requiredTables) {
      const table = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName);
      if (!table) {
        throw new Error(`${pack.id}@${pack.version} missing required table: ${tableName}`);
      }
    }

    validateNetworkEdgeReferences(database, pack);
    validateRegionalQualityMetricsMatchDatabase(database, pack);
    validateRepresentativeRouteRegressions(database, pack);

    for (const [tableName, minimumRows] of Object.entries(pack.minimumTableRows ?? {})) {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
      if (row.count < minimumRows) {
        throw new Error(`${pack.id}@${pack.version} ${tableName} row count ${row.count} is below ${minimumRows}`);
      }
    }
  } finally {
    database.close();
  }
}

function validateNetworkEdgeReferences(database, pack) {
  validateNetworkEdgeStationLineEndpoints(database, pack);
  validateNetworkEdgeFacilityReferences(database, pack);
}

function validateRegionalQualityMetricsMatchDatabase(database, pack) {
  if (!hasTable(database, "stations") || !hasTable(database, "facilities") || !hasTable(database, "network_edges")) {
    return;
  }
  const stationCount = database.prepare("SELECT COUNT(DISTINCT id) AS count FROM stations").get().count;
  const coveredStationCount = database
    .prepare(`
      SELECT COUNT(DISTINCT f.station_id) AS count
      FROM facilities f
      INNER JOIN stations s ON s.id = f.station_id
    `)
    .get().count;
  const edgeCount = database.prepare("SELECT COUNT(*) AS count FROM network_edges").get().count;
  const unknownAccessibilityCount = database
    .prepare(`
      SELECT COUNT(*) AS count
      FROM network_edges
      WHERE UPPER(COALESCE(accessibility_status, 'UNKNOWN')) = 'UNKNOWN'
    `)
    .get().count;
  const expectedMetrics = {
    stationCount,
    facilityCoverageRatio: stationCount === 0 ? 0 : Number((coveredStationCount / stationCount).toFixed(4)),
    edgeCount,
    unknownAccessibilityRatio: edgeCount === 0 ? 0 : Number((unknownAccessibilityCount / edgeCount).toFixed(4)),
  };
  for (const [key, expectedValue] of Object.entries(expectedMetrics)) {
    if (pack.regionalQualityMetrics[key] !== expectedValue) {
      throw new Error(
        `${pack.id}@${pack.version} regionalQualityMetrics mismatch: ${key} ${pack.regionalQualityMetrics[key]} != ${expectedValue}`,
      );
    }
  }
}

function validateRepresentativeRouteRegressions(database, pack) {
  if (!hasTable(database, "stations") || !hasTable(database, "station_lines") || !hasTable(database, "network_edges")) {
    return;
  }
  const routes = pack.representativeRouteRegressions;
  const requiredPatterns = requiredRepresentativeRoutePatterns();
  const seenPatterns = new Set(routes.map((route) => route.pattern));
  for (const pattern of requiredPatterns) {
    if (!seenPatterns.has(pattern)) {
      throw new Error(`${pack.id}@${pack.version} representativeRouteRegressions missing required pattern: ${pattern}`);
    }
  }

  const graph = representativeRouteGraph(database);
  for (const route of routes) {
    const fromEndpoint = routeEndpoint(route.fromNodeId, graph.stationIds, graph.stationLineNodes);
    const toEndpoint = routeEndpoint(route.toNodeId, graph.stationIds, graph.stationLineNodes);
    if (
      !fromEndpoint.valid ||
      !toEndpoint.valid ||
      fromEndpoint.stationLineNode === null ||
      toEndpoint.stationLineNode === null
    ) {
      throw new Error(`${pack.id}@${pack.version} representativeRouteRegressions endpoint invalid: ${route.id}`);
    }
    for (const edgeId of route.requiredEdgeIds) {
      if (!graph.routeEdgeIds.has(edgeId)) {
        throw new Error(`${pack.id}@${pack.version} representativeRouteRegressions required edge missing: ${route.id} -> ${edgeId}`);
      }
    }
    validateRequiredRouteEdgeSequence(route, graph, pack);
    const reachableNodes = reachableNodesFrom(fromEndpoint.stationLineNode, graph.directedAdjacency);
    if (!reachableNodes.has(toEndpoint.stationLineNode)) {
      throw new Error(
        `${pack.id}@${pack.version} representativeRouteRegressions route unreachable: ${route.id}`,
      );
    }
  }
}

function representativeRouteGraph(database) {
  const stationLineRows = database
    .prepare("SELECT station_id, line_id FROM station_lines")
    .all();
  const stationIds = new Set(
    database
      .prepare("SELECT id FROM stations")
      .all()
      .map((row) => row.id),
  );
  const stationLineNodes = new Set(
    stationLineRows.map((row) => stationLineNodeId(row.station_id, row.line_id)),
  );
  const connectedNodes = new Set();
  const directedAdjacency = new Map(
    [...stationLineNodes].map((nodeId) => [nodeId, new Set()]),
  );
  const undirectedAdjacency = new Map(
    [...stationLineNodes].map((nodeId) => [nodeId, new Set()]),
  );
  const routeEdgeIds = new Set();
  const routeEdges = new Map();
  addGeneratedStationTransferEdges(
    stationLineRows,
    stationLineNodes,
    connectedNodes,
    directedAdjacency,
    undirectedAdjacency,
  );

  const edges = database
    .prepare("SELECT id, from_node_id, to_node_id, edge_type, service_pattern FROM network_edges ORDER BY id")
    .all();
  for (const edge of edges) {
    const routeGraphEdgeType = routeGraphConnectivityEdgeType(edge.edge_type);
    if (routeGraphEdgeType === null) {
      continue;
    }
    const fromEndpoint = routeEndpoint(edge.from_node_id, stationIds, stationLineNodes);
    const toEndpoint = routeEndpoint(edge.to_node_id, stationIds, stationLineNodes);
    if (fromEndpoint.stationLineNode === null || toEndpoint.stationLineNode === null) {
      continue;
    }
    routeEdgeIds.add(edge.id);
    routeEdges.set(edge.id, {
      fromNode: fromEndpoint.stationLineNode,
      toNode: toEndpoint.stationLineNode,
      fromRouteNodeId: edge.from_node_id,
      toRouteNodeId: edge.to_node_id,
      edgeType: routeGraphEdgeType,
      servicePattern: edge.service_pattern,
    });
    addRouteGraphEdge(
      fromEndpoint.stationLineNode,
      toEndpoint.stationLineNode,
      connectedNodes,
      directedAdjacency,
      undirectedAdjacency,
    );
    if (routeGraphEdgeType === "TRANSFER") {
      addRouteGraphEdge(
        toEndpoint.stationLineNode,
        fromEndpoint.stationLineNode,
        connectedNodes,
        directedAdjacency,
        undirectedAdjacency,
      );
    }
  }
  return { stationIds, stationLineNodes, directedAdjacency, routeEdgeIds, routeEdges };
}

function validateRequiredRouteEdgeSequence(route, graph, pack) {
  let currentRouteNodeId = route.fromNodeId;
  for (const edgeId of route.requiredEdgeIds) {
    const edge = graph.routeEdges.get(edgeId);
    if (!edge) {
      continue;
    }
    if (routeNodeMatches(currentRouteNodeId, edge.fromRouteNodeId, edge.servicePattern)) {
      currentRouteNodeId = edge.toRouteNodeId;
      continue;
    }
    if (
      edge.edgeType === "TRANSFER" &&
      routeNodeMatches(currentRouteNodeId, edge.toRouteNodeId, edge.servicePattern)
    ) {
      currentRouteNodeId = edge.fromRouteNodeId;
      continue;
    }
    throw new Error(`${pack.id}@${pack.version} representativeRouteRegressions required edge not on route: ${route.id} -> ${edgeId}`);
  }
  const lastEdge = graph.routeEdges.get(route.requiredEdgeIds.at(-1));
  if (!routeNodeMatches(route.toNodeId, currentRouteNodeId, lastEdge?.servicePattern)) {
    throw new Error(`${pack.id}@${pack.version} representativeRouteRegressions required edge not on route: ${route.id} -> ${route.requiredEdgeIds.at(-1)}`);
  }
}

function routeNodeMatches(expectedRouteNodeId, actualRouteNodeId, servicePattern) {
  if (expectedRouteNodeId === actualRouteNodeId) {
    return true;
  }
  const expectedStationLineNode = stationLineNodeFromRouteNodeId(expectedRouteNodeId);
  const actualStationLineNode = stationLineNodeFromRouteNodeId(actualRouteNodeId);
  if (expectedStationLineNode === null || expectedStationLineNode !== actualStationLineNode) {
    return false;
  }
  const expectedSuffix = routeNodeServicePattern(expectedRouteNodeId);
  if (expectedSuffix === null) {
    return true;
  }
  const actualSuffix = routeNodeServicePattern(actualRouteNodeId) ?? String(servicePattern ?? "").toUpperCase();
  return actualSuffix === expectedSuffix;
}

function routeNodeServicePattern(routeNodeId) {
  const parts = routeNodeId.split(":");
  if (parts.length <= 2) {
    return null;
  }
  return parts.slice(2).join(":").toUpperCase();
}

function validateNetworkEdgeStationLineEndpoints(database, pack) {
  if (!hasTable(database, "station_lines") || !hasTable(database, "network_edges")) {
    return;
  }
  const stationLineRows = database
    .prepare("SELECT station_id, line_id FROM station_lines")
    .all();
  const stationIds = new Set(
    database
      .prepare("SELECT id FROM stations")
      .all()
      .map((row) => row.id),
  );
  const stationLineNodes = new Set(
    stationLineRows.map((row) => stationLineNodeId(row.station_id, row.line_id)),
  );
  if (stationLineNodes.size === 0) {
    return;
  }
  const routeGraphRequiredNodes = connectedLineNodes(stationLineRows);

  const connectedNodes = new Set();
  const directedAdjacency = new Map(
    [...routeGraphRequiredNodes].map((nodeId) => [nodeId, new Set()]),
  );
  const undirectedAdjacency = new Map(
    [...routeGraphRequiredNodes].map((nodeId) => [nodeId, new Set()]),
  );
  const edges = database
    .prepare("SELECT id, from_node_id, to_node_id, edge_type FROM network_edges ORDER BY id")
    .all();
  addGeneratedStationTransferEdges(
    stationLineRows,
    routeGraphRequiredNodes,
    connectedNodes,
    directedAdjacency,
    undirectedAdjacency,
  );
  for (const edge of edges) {
    const edgeType = normalizedEdgeType(edge.edge_type);
    const endpoints = [
      routeEndpoint(edge.from_node_id, stationIds, stationLineNodes),
      routeEndpoint(edge.to_node_id, stationIds, stationLineNodes),
    ];
    for (const endpoint of endpoints) {
      if (!endpoint.valid) {
        throw new Error(
          `${pack.id}@${pack.version} network_edges endpoint references missing station-line or station: ${edge.id} -> ${endpoint.value}`,
        );
      }
      if (endpoint.stationLineNode === null && !isAccessEdge(edgeType)) {
        throw new Error(
          `${pack.id}@${pack.version} network_edges station endpoint must be ENTRY or EXIT: ${edge.id} -> ${endpoint.value}`,
        );
      }
    }
    validateAccessEdgeEndpointShape(edge, edgeType, endpoints, pack);
    const fromNode = endpoints[0].stationLineNode;
    const toNode = endpoints[1].stationLineNode;
    const routeGraphEdgeType = routeGraphConnectivityEdgeType(edgeType);
    if (
      routeGraphEdgeType !== null &&
      routeGraphRequiredNodes.has(fromNode) &&
      routeGraphRequiredNodes.has(toNode)
    ) {
      addRouteGraphEdge(
        fromNode,
        toNode,
        connectedNodes,
        directedAdjacency,
        undirectedAdjacency,
      );
      if (routeGraphEdgeType === "TRANSFER") {
        addRouteGraphEdge(
          toNode,
          fromNode,
          connectedNodes,
          directedAdjacency,
          undirectedAdjacency,
        );
      }
    }
  }

  for (const nodeId of routeGraphRequiredNodes) {
    if (!connectedNodes.has(nodeId)) {
      throw new Error(`${pack.id}@${pack.version} station-line node is isolated from route graph: ${nodeId}`);
    }
  }
  validateRouteGraphSingleComponent(undirectedAdjacency, pack);
  validateRouteGraphDirectedReachability(directedAdjacency, pack);
}

function stationLineNodeId(stationId, lineId) {
  return `${stationId}:${lineId}`;
}

function routeEndpoint(value, stationIds, stationLineNodes) {
  if (stationIds.has(value)) {
    return { valid: true, value, stationLineNode: null };
  }
  const stationLineNode = stationLineNodeFromRouteNodeId(value);
  if (stationLineNode !== null && stationLineNodes.has(stationLineNode)) {
    return { valid: true, value, stationLineNode };
  }
  return { valid: false, value, stationLineNode: null };
}

function stationLineNodeFromRouteNodeId(nodeId) {
  const parts = nodeId.split(":");
  if (parts.length < 2 || parts[0] === "" || parts[1] === "") {
    return null;
  }
  if (parts.length > 2 && parts.slice(2).some((part) => part === "")) {
    return null;
  }
  return stationLineNodeId(parts[0], parts[1]);
}

function isAccessEdge(edgeType) {
  const normalized = normalizedEdgeType(edgeType);
  return normalized === "ENTRY" || normalized === "EXIT";
}

function validateAccessEdgeEndpointShape(edge, edgeType, endpoints, pack) {
  if (edgeType === "ENTRY") {
    if (endpoints[0].stationLineNode !== null || endpoints[1].stationLineNode === null) {
      throw new Error(
        `${pack.id}@${pack.version} network_edges access edge must connect station and station-line: ${edge.id}`,
      );
    }
    if (endpoints[0].value !== stationIdFromStationLineNode(endpoints[1].stationLineNode)) {
      throw new Error(
        `${pack.id}@${pack.version} network_edges access edge station mismatch: ${edge.id}`,
      );
    }
  } else if (edgeType === "EXIT") {
    if (endpoints[0].stationLineNode === null || endpoints[1].stationLineNode !== null) {
      throw new Error(
        `${pack.id}@${pack.version} network_edges access edge must connect station and station-line: ${edge.id}`,
      );
    }
    if (stationIdFromStationLineNode(endpoints[0].stationLineNode) !== endpoints[1].value) {
      throw new Error(
        `${pack.id}@${pack.version} network_edges access edge station mismatch: ${edge.id}`,
      );
    }
  }
}

function stationIdFromStationLineNode(stationLineNode) {
  return stationLineNode.split(":")[0];
}

function routeGraphConnectivityEdgeType(edgeType) {
  const normalized = normalizedEdgeType(edgeType);
  if (normalized === "RIDE" || normalized === "TRANSFER") {
    return normalized;
  }
  return null;
}

function normalizedEdgeType(edgeType) {
  return String(edgeType ?? "").toUpperCase();
}

function connectedLineNodes(stationLineRows) {
  const lineCounts = new Map();
  for (const row of stationLineRows) {
    lineCounts.set(row.line_id, (lineCounts.get(row.line_id) ?? 0) + 1);
  }
  return new Set(
    stationLineRows
      .filter((row) => (lineCounts.get(row.line_id) ?? 0) > 1)
      .map((row) => stationLineNodeId(row.station_id, row.line_id)),
  );
}

function addGeneratedStationTransferEdges(
  stationLineRows,
  routeGraphRequiredNodes,
  connectedNodes,
  directedAdjacency,
  undirectedAdjacency,
) {
  const nodesByStation = new Map();
  for (const row of stationLineRows) {
    const nodeId = stationLineNodeId(row.station_id, row.line_id);
    if (!routeGraphRequiredNodes.has(nodeId)) {
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
        addRouteGraphEdge(
          fromNode,
          toNode,
          connectedNodes,
          directedAdjacency,
          undirectedAdjacency,
        );
      }
    }
  }
}

function addRouteGraphEdge(
  fromNode,
  toNode,
  connectedNodes,
  directedAdjacency,
  undirectedAdjacency,
) {
  connectedNodes.add(fromNode);
  connectedNodes.add(toNode);
  directedAdjacency.get(fromNode)?.add(toNode);
  undirectedAdjacency.get(fromNode)?.add(toNode);
  undirectedAdjacency.get(toNode)?.add(fromNode);
}

function validateRouteGraphSingleComponent(adjacency, pack) {
  const [startNode] = adjacency.keys();
  if (!startNode) {
    return;
  }

  const visited = new Set();
  const stack = [startNode];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    for (const nextNodeId of adjacency.get(nodeId) ?? []) {
      if (!visited.has(nextNodeId)) {
        stack.push(nextNodeId);
      }
    }
  }

  for (const nodeId of adjacency.keys()) {
    if (!visited.has(nodeId)) {
      throw new Error(`${pack.id}@${pack.version} route graph has disconnected component: ${nodeId}`);
    }
  }
}

function validateRouteGraphDirectedReachability(adjacency, pack) {
  for (const startNode of adjacency.keys()) {
    const visited = reachableNodesFrom(startNode, adjacency);
    for (const nodeId of adjacency.keys()) {
      if (!visited.has(nodeId)) {
        throw new Error(
          `${pack.id}@${pack.version} route graph has unreachable directed path: ${startNode} -> ${nodeId}`,
        );
      }
    }
  }
}

function reachableNodesFrom(startNode, adjacency) {
  const visited = new Set();
  const stack = [startNode];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    for (const nextNodeId of adjacency.get(nodeId) ?? []) {
      if (!visited.has(nextNodeId)) {
        stack.push(nextNodeId);
      }
    }
  }
  return visited;
}

function validateNetworkEdgeFacilityReferences(database, pack) {
  if (!hasTable(database, "network_edges") || !hasTable(database, "facilities")) {
    return;
  }
  const hasFacilityIdColumn = database
    .prepare("PRAGMA table_info(network_edges)")
    .all()
    .some((row) => row.name === "facility_id");
  if (!hasFacilityIdColumn) {
    return;
  }

  const missingReference = database
    .prepare(`
      SELECT ne.id AS edge_id, ne.facility_id AS facility_id
      FROM network_edges ne
      LEFT JOIN facilities f ON f.id = ne.facility_id
      WHERE ne.facility_id IS NOT NULL
        AND f.id IS NULL
      ORDER BY ne.id
      LIMIT 1
    `)
    .get();
  if (missingReference) {
    throw new Error(
      `${pack.id}@${pack.version} network_edges facility_id references missing facility: ${missingReference.edge_id} -> ${missingReference.facility_id}`,
    );
  }
}

function hasTable(database, tableName) {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }
  if (!Number.isInteger(manifest.ttlSeconds) || manifest.ttlSeconds <= 0) {
    throw new Error("manifest ttlSeconds must be a positive integer");
  }
  if (!Array.isArray(manifest.packs)) {
    throw new Error("manifest packs must be an array");
  }
  const packIdentities = new Set(
    manifest.packs.map((pack) => `${pack.id ?? ""}@${pack.version ?? ""}`),
  );
  if (manifest.activePack !== undefined) {
    validatePackIdentity(manifest.activePack, "activePack");
    const activePackIdentity = `${manifest.activePack.id}@${manifest.activePack.version}`;
    if (!packIdentities.has(activePackIdentity)) {
      throw new Error("activePack must match one of manifest packs");
    }
  }
  if (manifest.emergencyOverride !== undefined) {
    validatePackIdentity(manifest.emergencyOverride, "emergencyOverride");
    requiredString(manifest.emergencyOverride.reason, "emergencyOverride.reason");
  }
  for (const pack of manifest.packs) {
    validatePackIdentity(pack, "pack");
    validatePackUrl(requiredString(pack.url, "pack.url"), "pack.url");
    validatePackUrlMatchesStagedPath(pack.url, pack, "pack.url");
    const artifactKind = requiredString(pack.artifactKind, "pack.artifactKind");
    if (artifactKind !== "fixture" && artifactKind !== "production") {
      throw new Error(`${pack.id}@${pack.version} artifactKind must be fixture or production`);
    }
    if (artifactKind === "production" && !isAbsoluteHttpsWithHost(pack.url)) {
      throw new Error(`${pack.id}@${pack.version} production pack url must be an absolute HTTPS URL`);
    }
    if (artifactKind === "production" && usesLocalPlaceholderHost(pack.url)) {
      throw new Error(`${pack.id}@${pack.version} production pack url must not use a local placeholder host`);
    }
    requiredSha256(pack.sha256, "pack.sha256");
    requiredSha256(pack.sqliteSha256, "pack.sqliteSha256");
    if (!Number.isInteger(pack.sizeBytes) || pack.sizeBytes <= 0) {
      throw new Error(`${pack.id}@${pack.version} sizeBytes must be a positive integer`);
    }
    validateSignature(pack.signature, `${pack.id}@${pack.version}`);
    validateSourceInventory(pack.sourceInventory, artifactKind, `${pack.id}@${pack.version}`);
    validateRegionalQualityMetrics(pack.regionalQualityMetrics, `${pack.id}@${pack.version}`);
    validateRepresentativeRouteRegressionManifest(pack.representativeRouteRegressions, `${pack.id}@${pack.version}`);
    validateRepresentativeRouteRegressionSignature(
      pack.representativeRouteRegressionSignature,
      `${pack.id}@${pack.version}`,
    );
    requiredString(pack.schemaVersion, "pack.schemaVersion");
    if (!Array.isArray(pack.requiredTables) || pack.requiredTables.length === 0) {
      throw new Error(`${pack.id}@${pack.version} requiredTables must be a non-empty array`);
    }
    for (const tableName of pack.requiredTables) {
      validateTableName(tableName);
    }
    validateMinimumTableRows(pack, artifactKind, `${pack.id}@${pack.version}`);
  }
}

function validateMinimumTableRows(pack, artifactKind, label) {
  if (pack.minimumTableRows !== undefined) {
    if (!pack.minimumTableRows || typeof pack.minimumTableRows !== "object" || Array.isArray(pack.minimumTableRows)) {
      throw new Error(`${label} minimumTableRows must be an object`);
    }
    for (const [tableName, minimumRows] of Object.entries(pack.minimumTableRows)) {
      validateTableName(tableName);
      if (!Number.isInteger(minimumRows) || minimumRows < 0) {
        throw new Error(`${label} minimumTableRows entry must be a non-negative integer`);
      }
    }
  }
  if (artifactKind !== "production") {
    return;
  }
  if (!hasProductionMinimumTableRows(pack.minimumTableRows)) {
    throw new Error(`${label} production minimumTableRows must define positive stations, station_lines, network_edges, and facilities`);
  }
}

function hasProductionMinimumTableRows(minimumTableRows) {
  return (
    minimumTableRows &&
    typeof minimumTableRows === "object" &&
    !Array.isArray(minimumTableRows) &&
    productionMinimumTableRowNames.every((tableName) => Number.isInteger(minimumTableRows[tableName]) && minimumTableRows[tableName] > 0)
  );
}

function validatePackUrl(packUrl, label) {
  if (/%[0-9a-f]{2}/i.test(packUrl)) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  if (/^https:\/\//.test(packUrl)) {
    if (!isAbsoluteHttpsWithHost(packUrl)) {
      throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
    }
    return;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(packUrl) || packUrl.startsWith("/") || packUrl.startsWith("//") || packUrl.includes("\\")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  if (packUrl.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  const normalized = path.posix.normalize(packUrl);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
}

function validatePackUrlMatchesStagedPath(packUrl, pack, label) {
  if (!/^https:\/\//.test(packUrl)) {
    return;
  }
  const url = new URL(packUrl);
  const expectedPathSuffix = `/${stagedPackPath(pack)}`;
  if (!url.pathname.endsWith(expectedPathSuffix) || url.search !== "" || url.hash !== "") {
    throw new Error(`${label} absolute HTTPS URL path must end with ${stagedPackPath(pack)}`);
  }
}

function stagedPackPath(pack) {
  return `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
}

function validateSignature(signature, label) {
  if (!signature || typeof signature !== "object") {
    throw new Error(`${label} signature must be an object`);
  }
  const algorithm = requiredString(signature.algorithm, "signature.algorithm");
  if (algorithm !== "sha256-pack-manifest-v1" && algorithm !== "rsa-sha256-pack-manifest-v1") {
    throw new Error(`${label} signature algorithm is unsupported`);
  }
  const value = requiredString(signature.value, "signature.value");
  if (algorithm === "sha256-pack-manifest-v1") {
    requiredSha256(value, "signature.value");
  } else if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("signature.value must be a base64url string");
  }
}

function validateRepresentativeRouteRegressionSignature(signature, label) {
  if (!signature || typeof signature !== "object") {
    throw new Error(`${label} representativeRouteRegressionSignature must be an object`);
  }
  const algorithm = requiredString(signature.algorithm, "representativeRouteRegressionSignature.algorithm");
  if (algorithm !== "sha256-route-regression-v1" && algorithm !== "rsa-sha256-route-regression-v1") {
    throw new Error(`${label} representativeRouteRegressionSignature algorithm is unsupported`);
  }
  const value = requiredString(signature.value, "representativeRouteRegressionSignature.value");
  if (algorithm === "sha256-route-regression-v1") {
    requiredSha256(value, "representativeRouteRegressionSignature.value");
  } else if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("representativeRouteRegressionSignature.value must be a base64url string");
  }
}

function validateSourceInventory(sourceInventory, artifactKind, label) {
  if (!Array.isArray(sourceInventory) || sourceInventory.length === 0) {
    throw new Error(`${label} sourceInventory must be a non-empty array`);
  }
  for (const source of sourceInventory) {
    requiredString(source.id, "sourceInventory.id");
    requiredString(source.owner, "sourceInventory.owner");
    requiredString(source.url, "sourceInventory.url");
    requiredString(source.license, "sourceInventory.license");
    const licenseStatus = requiredString(source.licenseStatus, "sourceInventory.licenseStatus");
    if (typeof source.redistributionAllowed !== "boolean") {
      throw new Error(`${label} sourceInventory.redistributionAllowed must be a boolean`);
    }
    requiredString(source.updateFrequency, "sourceInventory.updateFrequency");
    requiredString(source.updatedAt, "sourceInventory.updatedAt");
    if (!Array.isArray(source.fields) || source.fields.length === 0) {
      throw new Error(`${label} sourceInventory.fields must be a non-empty array`);
    }
    for (const field of source.fields) {
      requiredString(field, "sourceInventory.fields");
    }
    if (artifactKind === "production") {
      if (licenseStatus !== "redistributable" || source.redistributionAllowed !== true) {
        throw new Error(`${label} production sourceInventory must be redistributable`);
      }
      if (!isAbsoluteHttpsWithHost(source.url)) {
        throw new Error(`${label} production sourceInventory.url must be HTTPS`);
      }
      if (usesLocalPlaceholderHost(source.url)) {
        throw new Error(`${label} production sourceInventory.url must not use a local placeholder host`);
      }
    }
  }
}

function isAbsoluteHttpsWithHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

function validateRegionalQualityMetrics(metrics, label) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error(`${label} regionalQualityMetrics must be an object`);
  }
  if (!Number.isInteger(metrics.stationCount) || metrics.stationCount < 0) {
    throw new Error(`${label} regionalQualityMetrics.stationCount must be a non-negative integer`);
  }
  if (!Number.isInteger(metrics.edgeCount) || metrics.edgeCount < 0) {
    throw new Error(`${label} regionalQualityMetrics.edgeCount must be a non-negative integer`);
  }
  for (const key of ["facilityCoverageRatio", "unknownAccessibilityRatio"]) {
    if (typeof metrics[key] !== "number" || metrics[key] < 0 || metrics[key] > 1) {
      throw new Error(`${label} regionalQualityMetrics.${key} must be a ratio`);
    }
  }
}

function validateRepresentativeRouteRegressionManifest(routes, label) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error(`${label} representativeRouteRegressions must be a non-empty array`);
  }
  const requiredPatterns = requiredRepresentativeRoutePatterns();
  const seenPatterns = new Set();
  for (const route of routes) {
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      throw new Error(`${label} representativeRouteRegressions entries must be objects`);
    }
    requiredString(route.id, "representativeRouteRegressions.id");
    const pattern = requiredString(route.pattern, "representativeRouteRegressions.pattern");
    if (!requiredPatterns.has(pattern)) {
      throw new Error(`${label} representativeRouteRegressions pattern is invalid: ${pattern}`);
    }
    seenPatterns.add(pattern);
    requiredString(route.fromNodeId, "representativeRouteRegressions.fromNodeId");
    requiredString(route.toNodeId, "representativeRouteRegressions.toNodeId");
    if (!Array.isArray(route.requiredEdgeIds) || route.requiredEdgeIds.length === 0) {
      throw new Error(`${label} representativeRouteRegressions.requiredEdgeIds must be a non-empty array`);
    }
    for (const edgeId of route.requiredEdgeIds) {
      requiredString(edgeId, "representativeRouteRegressions.requiredEdgeIds");
    }
  }
  for (const pattern of requiredPatterns) {
    if (!seenPatterns.has(pattern)) {
      throw new Error(`${label} representativeRouteRegressions missing required pattern: ${pattern}`);
    }
  }
}

function requiredRepresentativeRoutePatterns() {
  return new Set(["DIRECT", "TRANSFER", "MULTI_TRANSFER", "LOOP_BRANCH", "EXPRESS_LOCAL"]);
}

function packSignature(pack) {
  if (pack.artifactKind === "production") {
    const canonical = productionSignaturePayload(pack);
    const signature = {
      algorithm: "rsa-sha256-pack-manifest-v1",
      value: pack.signature.value,
    };
    if (!verifyRsaSha256Signature(signingPublicKey(), canonical, pack.signature.value)) {
      return {
        algorithm: signature.algorithm,
        value: "",
      };
    }
    return signature;
  }
  return {
    algorithm: "sha256-pack-manifest-v1",
    value: sha256(Buffer.from(fixtureSignaturePayload(pack))),
  };
}

function fixtureSignaturePayload(pack) {
  return `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
}

function productionSignaturePayload(pack) {
  return `${fixtureSignaturePayload(pack)}:${canonicalProductionPackUrl(pack.url)}`;
}

function representativeRouteRegressionSignature(pack) {
  if (pack.artifactKind === "production") {
    const signature = {
      algorithm: "rsa-sha256-route-regression-v1",
      value: pack.representativeRouteRegressionSignature.value,
    };
    if (!verifyRsaSha256Signature(signingPublicKey(), representativeRouteRegressionSignaturePayload(pack), pack.representativeRouteRegressionSignature.value)) {
      return {
        algorithm: signature.algorithm,
        value: "",
      };
    }
    return signature;
  }
  return {
    algorithm: "sha256-route-regression-v1",
    value: sha256(Buffer.from(representativeRouteRegressionSignaturePayload(pack))),
  };
}

function representativeRouteRegressionSignaturePayload(pack) {
  const basePayload = `${fixtureSignaturePayload(pack)}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`;
  if (pack.artifactKind === "production") {
    return `${basePayload}:${canonicalProductionPackUrl(pack.url)}`;
  }
  return basePayload;
}

function representativeRouteRegressionPayload(routes) {
  return JSON.stringify(canonicalRepresentativeRouteRegressions(routes));
}

function canonicalRepresentativeRouteRegressions(routes) {
  return routes.map((route) => ({
    id: requiredString(route.id, "representativeRouteRegressions.id"),
    pattern: requiredString(route.pattern, "representativeRouteRegressions.pattern"),
    fromNodeId: requiredString(route.fromNodeId, "representativeRouteRegressions.fromNodeId"),
    toNodeId: requiredString(route.toNodeId, "representativeRouteRegressions.toNodeId"),
    requiredEdgeIds: route.requiredEdgeIds.map((edgeId) =>
      requiredString(edgeId, "representativeRouteRegressions.requiredEdgeIds"),
    ),
  }));
}

function canonicalProductionPackUrl(packUrl) {
  return new URL(packUrl).toString();
}

function signingPublicKey() {
  const key = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM?.trim();
  if (!key) {
    throw new Error("EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM is required for production data pack validation");
  }
  return key;
}

function verifyRsaSha256Signature(publicKey, value, signature) {
  return createVerify("RSA-SHA256").update(value).verify(publicKey, Buffer.from(signature, "base64url"));
}

function validatePackIdentity(value, label) {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const packId = requiredString(value.id, `${label}.id`);
  const version = requiredString(value.version, `${label}.version`);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(packId)) {
    throw new Error(`${label}.id is invalid`);
  }
  if (!/^[0-9]+$/.test(version)) {
    throw new Error(`${label}.version is invalid`);
  }
}

function validateTableName(value) {
  const tableName = requiredString(value, "tableName");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid table name: ${tableName}`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function requireArg(args, name) {
  if (!args[name]) {
    throw new Error(`--${name} is required`);
  }
  return args[name];
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredSha256(value, label) {
  const hash = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${label} must be a lowercase sha256 hex string`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
