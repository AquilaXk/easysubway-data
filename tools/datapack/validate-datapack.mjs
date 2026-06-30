#!/usr/bin/env node
import { createHash, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { usesLocalPlaceholderHost } from "./production-url-policy.mjs";

const productionMinimumTableRowNames = [
  "stations",
  "station_lines",
  "network_edges",
  "facilities",
  "station_facility_evidence",
];
const facilityEvidenceProvenanceColumns = [
  "source_id",
  "source_snapshot_id",
  "provider_record_hash",
  "evidence_hash",
  "provenance_kind",
  "installation_status",
  "operational_status",
  "status_meaning",
  "confidence",
  "verified_at",
  "retrieved_at",
];
const productionFacilityProvenanceKinds = ["OFFICIAL_SOURCE", "OPERATOR_CONFIRMED", "FIELD_SURVEY"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(requireArg(args, "manifest"));
  const root = path.resolve(requireArg(args, "root"));
  const requireProduction = args["require-production"] === true;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, { requireProduction });

  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-validate-"));
  try {
    for (const pack of manifest.packs) {
      await validatePack(root, temporaryDir, pack, manifest.manifestVersion ?? 1);
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function validatePack(root, temporaryDir, pack, manifestVersion) {
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
  const signature = packSignature(pack, manifestVersion);
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
    const manifestSchemaVersion = Number(pack.schemaVersion);
    if (!Number.isInteger(manifestSchemaVersion) || manifestSchemaVersion <= 0) {
      throw new Error(`${pack.id}@${pack.version} schemaVersion must be a positive integer string`);
    }
    if (userVersion < manifestSchemaVersion) {
      throw new Error(`${pack.id}@${pack.version} PRAGMA user_version mismatch`);
    }

    for (const tableName of pack.requiredTables) {
      const table = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName);
      if (!table) {
        throw new Error(`${pack.id}@${pack.version} missing required table: ${tableName}`);
      }
    }

    validateNetworkEdgeReferences(database, pack);
    validateTransitSchedule(database, pack);
    validateStationPathways(database, pack);
    const productionCoverageError = validateProductionNetworkEdgeProvenance(database, pack);
    validateProductionInternalRouteEdgeProvenance(database, pack);
    validateProductionStationPathwayEdgeProvenance(database, pack);
    validateProductionFacilityProvenance(database, pack);
    validateProductionStationFacilityEvidence(database, pack);
    validateRegionalQualityMetricsMatchDatabase(database, pack);
    validateRepresentativeRouteRegressions(database, pack);

    for (const [tableName, minimumRows] of Object.entries(pack.minimumTableRows ?? {})) {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
      if (row.count < minimumRows) {
        throw new Error(`${pack.id}@${pack.version} ${tableName} row count ${row.count} is below ${minimumRows}`);
      }
    }
    if (productionCoverageError) {
      throw productionCoverageError;
    }
  } finally {
    database.close();
  }
}

function validateNetworkEdgeReferences(database, pack) {
  validateNetworkEdgeStationLineEndpoints(database, pack);
  validateNetworkEdgeFacilityReferences(database, pack);
}

function validateTransitSchedule(database, pack) {
  if (!hasTable(database, "transit_trips")) {
    return;
  }

  const calendars = new Map(
    database
      .prepare(
        `
        SELECT service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
               start_date, end_date
        FROM service_calendars
      `,
      )
      .all()
      .map((row) => [row.service_id, row]),
  );
  const calendarDateAddsByService = new Map();
  if (hasTable(database, "service_calendar_dates")) {
    for (const row of database
      .prepare("SELECT service_id, date FROM service_calendar_dates WHERE exception_type = 1")
      .all()) {
      const dates = calendarDateAddsByService.get(row.service_id) ?? [];
      dates.push(row.date);
      calendarDateAddsByService.set(row.service_id, dates);
    }
  }
  const routes = new Map(
    database
      .prepare("SELECT id, line_id FROM transit_routes")
      .all()
      .map((row) => [row.id, row]),
  );
  const trips = database
    .prepare("SELECT id, route_id, service_id FROM transit_trips ORDER BY id")
    .all();
  for (const trip of trips) {
    const calendar = calendars.get(trip.service_id);
    if (!calendar || !serviceCalendarHasActiveDate(calendar, calendarDateAddsByService.get(trip.service_id) ?? [])) {
      throw new Error(`${pack.id}@${pack.version} transit_trips service_id is not active: ${trip.id}`);
    }
    const route = routes.get(trip.route_id);
    if (!route) {
      throw new Error(`${pack.id}@${pack.version} transit_trips route_id is missing: ${trip.id}`);
    }
    const stopTimes = database
      .prepare(
        `
        SELECT stop_sequence, station_id, line_id, arrival_seconds, departure_seconds
        FROM transit_stop_times
        WHERE trip_id = ?
        ORDER BY stop_sequence
      `,
      )
      .all(trip.id);
    if (stopTimes.length < 2) {
      throw new Error(`${pack.id}@${pack.version} transit_trips must have at least 2 stop_times: ${trip.id}`);
    }
    let previousSequence = 0;
    let previousDeparture = -1;
    for (const stopTime of stopTimes) {
      if (stopTime.stop_sequence <= previousSequence) {
        throw new Error(`${pack.id}@${pack.version} transit_stop_times stop_sequence must be strictly increasing: ${trip.id}`);
      }
      if (stopTime.arrival_seconds > stopTime.departure_seconds) {
        throw new Error(`${pack.id}@${pack.version} transit_stop_times arrival_seconds must be <= departure_seconds: ${trip.id}`);
      }
      if (stopTime.arrival_seconds < previousDeparture) {
        throw new Error(`${pack.id}@${pack.version} transit_stop_times must be monotonic: ${trip.id}`);
      }
      if (stopTime.line_id !== route.line_id) {
        throw new Error(`${pack.id}@${pack.version} transit_stop_times line_id must match route line_id: ${trip.id}`);
      }
      previousSequence = stopTime.stop_sequence;
      previousDeparture = stopTime.departure_seconds;
    }
  }

  if (hasTable(database, "transit_frequencies")) {
    const frequencies = database
      .prepare("SELECT trip_id, start_time_seconds, end_time_seconds, headway_seconds FROM transit_frequencies")
      .all();
    const tripIds = new Set(trips.map((trip) => trip.id));
    for (const frequency of frequencies) {
      if (!tripIds.has(frequency.trip_id)) {
        throw new Error(`${pack.id}@${pack.version} transit_frequencies trip_id is missing: ${frequency.trip_id}`);
      }
      if (frequency.end_time_seconds <= frequency.start_time_seconds || frequency.headway_seconds <= 0) {
        throw new Error(`${pack.id}@${pack.version} transit_frequencies time range is invalid: ${frequency.trip_id}`);
      }
    }
  }
}

function serviceCalendarHasActiveDate(calendar, addedDates) {
  if (calendar.start_date > calendar.end_date) {
    return false;
  }
  if (addedDates.some((date) => calendar.start_date <= date && date <= calendar.end_date)) {
    return true;
  }
  return [
    calendar.monday,
    calendar.tuesday,
    calendar.wednesday,
    calendar.thursday,
    calendar.friday,
    calendar.saturday,
    calendar.sunday,
  ].some((value) => value === 1);
}

function validateStationPathways(database, pack) {
  if (!hasTable(database, "station_pathway_edges")) {
    return;
  }

  const edges = database
    .prepare(
      `
      SELECT spe.id, spe.from_node_id, spe.to_node_id, spe.edge_type, spe.duration_seconds, spe.bidirectional,
             spe.includes_stairs, spe.requires_elevator, spe.requires_escalator, spe.requires_facility_id,
             spe.accessibility_status, spe.provenance_kind, spe.verification_status, spe.legacy_internal_route_edge_id,
             from_node.station_id AS from_station_id, from_node.line_id AS from_line_id,
             to_node.station_id AS to_station_id, to_node.line_id AS to_line_id
      FROM station_pathway_edges spe
      JOIN station_pathway_nodes from_node ON from_node.id = spe.from_node_id
      JOIN station_pathway_nodes to_node ON to_node.id = spe.to_node_id
      ORDER BY spe.id
    `,
    )
    .all();
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]));

  for (const edge of edges) {
    if (edge.duration_seconds < 0) {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges duration_seconds must be non-negative: ${edge.id}`);
    }
    if (edge.provenance_kind === "GENERATED" && edge.verification_status === "VERIFIED") {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges generated connector cannot be VERIFIED: ${edge.id}`);
    }
  }

  validateStationPathwayLegacyMappings(database, pack);
  validateStationPathwayFacilities(database, pack);

  for (const rule of database
    .prepare(
      `
      SELECT id, from_station_id, from_line_id, to_station_id, to_line_id,
             min_transfer_seconds, pathway_edge_id, strict_step_free_pathway_edge_id
      FROM transfer_rules
      ORDER BY id
    `,
    )
    .all()) {
    if (rule.min_transfer_seconds < 0) {
      throw new Error(`${pack.id}@${pack.version} transfer_rules min_transfer_seconds must be non-negative: ${rule.id}`);
    }
    const pathwayEdge = rule.pathway_edge_id ? edgesById.get(rule.pathway_edge_id) : null;
    if (rule.pathway_edge_id && !pathwayEdge) {
      throw new Error(`${pack.id}@${pack.version} transfer_rules pathway_edge_id is missing: ${rule.id}`);
    }
    if (pathwayEdge && !pathwayEdgeConnectsTransferRule(pathwayEdge, rule)) {
      throw new Error(`${pack.id}@${pack.version} transfer_rules pathway edge does not match endpoints: ${rule.id}`);
    }
    const strictEdge = rule.strict_step_free_pathway_edge_id
      ? edgesById.get(rule.strict_step_free_pathway_edge_id)
      : null;
    if (rule.strict_step_free_pathway_edge_id && !strictEdge) {
      throw new Error(`${pack.id}@${pack.version} transfer_rules strict_step_free_pathway_edge_id is missing: ${rule.id}`);
    }
    if (strictEdge && !pathwayEdgeConnectsTransferRule(strictEdge, rule)) {
      throw new Error(`${pack.id}@${pack.version} transfer_rules strict step-free edge does not match endpoints: ${rule.id}`);
    }
    const strictEdgeType = String(strictEdge?.edge_type ?? "").toUpperCase();
    if (strictEdge && (["STAIRS", "ESCALATOR"].includes(strictEdgeType) || strictEdge.includes_stairs === 1 || (strictEdge.requires_escalator === 1 && strictEdge.requires_elevator === 0))) {
      throw new Error(`${pack.id}@${pack.version} transfer_rules strict step-free edge is not step-free: ${rule.id}`);
    }
    const strictAccessibilityStatus = String(strictEdge?.accessibility_status ?? "").toUpperCase();
    if (strictEdge && strictAccessibilityStatus !== "AVAILABLE") {
      throw new Error(`${pack.id}@${pack.version} transfer_rules strict step-free edge is unavailable: ${rule.id}`);
    }
  }
}

function pathwayEdgeConnectsTransferRule(edge, rule) {
  const direct =
    edge.from_station_id === rule.from_station_id &&
    edge.from_line_id === rule.from_line_id &&
    edge.to_station_id === rule.to_station_id &&
    edge.to_line_id === rule.to_line_id;
  const reverse =
    edge.bidirectional === 1 &&
    edge.from_station_id === rule.to_station_id &&
    edge.from_line_id === rule.to_line_id &&
    edge.to_station_id === rule.from_station_id &&
    edge.to_line_id === rule.from_line_id;
  return direct || reverse;
}

function validateStationPathwayLegacyMappings(database, pack) {
  if (!hasTable(database, "internal_route_edges")) {
    return;
  }
  const rows = database
    .prepare(
      `
      SELECT spe.id, spe.legacy_internal_route_edge_id, spe.edge_type, spe.duration_seconds, spe.distance_meters,
             spe.includes_stairs, spe.requires_elevator, spe.requires_escalator, spe.accessibility_status,
             ire.id AS legacy_id,
             ire.edge_type AS legacy_edge_type, ire.duration_seconds AS legacy_duration_seconds,
             ire.distance_meters AS legacy_distance_meters, ire.includes_stairs AS legacy_includes_stairs,
             ire.requires_elevator AS legacy_requires_elevator, ire.requires_escalator AS legacy_requires_escalator,
             ire.accessibility_status AS legacy_accessibility_status
      FROM station_pathway_edges spe
      LEFT JOIN internal_route_edges ire ON ire.id = spe.legacy_internal_route_edge_id
      WHERE spe.legacy_internal_route_edge_id <> ''
    `,
    )
    .all();
  for (const row of rows) {
    if (row.legacy_id == null) {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges legacy mapping is missing: ${row.id}`);
    }
    for (const [current, legacy] of [
      ["edge_type", "legacy_edge_type"],
      ["duration_seconds", "legacy_duration_seconds"],
      ["distance_meters", "legacy_distance_meters"],
      ["includes_stairs", "legacy_includes_stairs"],
      ["requires_elevator", "legacy_requires_elevator"],
      ["requires_escalator", "legacy_requires_escalator"],
      ["accessibility_status", "legacy_accessibility_status"],
    ]) {
      if (row[current] !== row[legacy]) {
        throw new Error(`${pack.id}@${pack.version} station_pathway_edges legacy mapping mismatch: ${row.id}`);
      }
    }
  }
}

function validateStationPathwayFacilities(database, pack) {
  if (!hasTable(database, "facilities")) {
    return;
  }
  const rows = database
    .prepare(
      `
      SELECT spe.id, spe.accessibility_status, f.status, f.operational_status
      FROM station_pathway_edges spe
      JOIN facilities f ON f.id = spe.requires_facility_id
      WHERE spe.requires_facility_id IS NOT NULL
    `,
    )
    .all();
  for (const row of rows) {
    const facilityAvailable = ["NORMAL", "AVAILABLE", "UNKNOWN"].includes(row.status)
      && ["NORMAL", "AVAILABLE", "UNKNOWN"].includes(row.operational_status);
    if (!facilityAvailable && row.accessibility_status === "AVAILABLE") {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges unavailable facility cannot be AVAILABLE: ${row.id}`);
    }
  }
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

function validateProductionNetworkEdgeProvenance(database, pack) {
  if (pack.artifactKind !== "production" || !hasTable(database, "network_edges")) {
    return null;
  }
  const requiredColumns = [
    "source_id",
    "source_snapshot_id",
    "provider_record_hash",
    "provenance_kind",
    "verification_status",
    "last_verified_at",
    "evidence_hash",
  ];
  const columns = new Set(database.prepare("PRAGMA table_info(network_edges)").all().map((row) => row.name));
  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(`${pack.id}@${pack.version} network_edges provenance column missing: ${column}`);
    }
  }

  const sourceUpdatedAtById = new Map(
    pack.sourceInventory.map((source) => [
      source.id,
      timestampSeconds(requiredString(source.updatedAt, "sourceInventory.updatedAt")),
    ]),
  );
  const edgeRows = database
    .prepare(`
      SELECT id, from_node_id, to_node_id, edge_type, stair_access_state,
             accessibility_status, reliability_score, source_id,
             source_snapshot_id, provider_record_hash, provenance_kind,
             verification_status, last_verified_at, evidence_hash
      FROM network_edges
      ORDER BY id
    `)
    .all();
  const coverage = productionVerifiedCoverage(database, edgeRows);
  const unverifiedAccessibilityCoverageEdges = edgeRows
    .filter(isUnverifiedAccessibilityCoverageEdge)
    .map((edge) => edge.id);

  for (const edge of edgeRows) {
    validateNetworkEdgeBaseProvenance(edge, sourceUpdatedAtById, pack);
    if (isAccessibilityProvenanceCandidate(edge)) {
      validateAccessibilityCoverageEdgeProvenance(edge, sourceUpdatedAtById, pack);
    }
    if (isPositiveAccessibilityEdge(edge)) {
      validatePositiveEdgeProvenance(edge, sourceUpdatedAtById, pack);
    }
  }

  const report = {
    type: "datapack_verified_edge_coverage",
    pack: `${pack.id}@${pack.version}`,
    entry: coverage.entry,
    exit: coverage.exit,
    transfer: coverage.transfer,
    unverifiedAccessibilityCoverageEdges,
    generatedConnectorGapCount:
      coverage.entry.missingCount +
      coverage.exit.missingCount +
      coverage.transfer.missingCount,
  };
  console.log(JSON.stringify(report));

  for (const [kind, item] of Object.entries(coverage)) {
    if (item.missingCount > 0) {
      return new Error(
        `${pack.id}@${pack.version} verified ${kind.toUpperCase()} coverage gap: ${item.missingCount}/${item.denominator}`,
      );
    }
  }
  return null;
}

function validateNetworkEdgeBaseProvenance(edge, sourceUpdatedAtById, pack) {
  const sourceId = requiredString(edge.source_id, `network_edges.${edge.id}.source_id`);
  if (!sourceUpdatedAtById.has(sourceId)) {
    throw new Error(`${pack.id}@${pack.version} network_edges source_id is not in sourceInventory: ${edge.id}`);
  }
  requiredString(edge.source_snapshot_id, `network_edges.${edge.id}.source_snapshot_id`);
  requiredProductionSha256(edge.provider_record_hash, `network_edges.${edge.id}.provider_record_hash`);
  requiredProductionSha256(edge.evidence_hash, `network_edges.${edge.id}.evidence_hash`);
}

function validateProductionInternalRouteEdgeProvenance(database, pack) {
  if (pack.artifactKind !== "production" || !hasTable(database, "internal_route_edges")) {
    return;
  }
  const requiredColumns = [
    "source_id",
    "source_snapshot_id",
    "provider_record_hash",
    "provenance_kind",
    "verification_status",
    "last_verified_at",
    "evidence_hash",
  ];
  const columns = new Set(database.prepare("PRAGMA table_info(internal_route_edges)").all().map((row) => row.name));
  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(`${pack.id}@${pack.version} internal_route_edges provenance column missing: ${column}`);
    }
  }

  const sourceIds = new Set(pack.sourceInventory.map((source) => source.id));
  const rows = database
    .prepare(`
      SELECT id, source_id, source_snapshot_id, provider_record_hash,
             provenance_kind, verification_status, last_verified_at, evidence_hash
      FROM internal_route_edges
      ORDER BY id
    `)
    .all();
  for (const row of rows) {
    const sourceId = requiredString(row.source_id, `internal_route_edges.${row.id}.source_id`);
    if (!sourceIds.has(sourceId)) {
      throw new Error(`${pack.id}@${pack.version} internal_route_edges source_id is not in sourceInventory: ${row.id}`);
    }
    requiredString(row.source_snapshot_id, `internal_route_edges.${row.id}.source_snapshot_id`);
    requiredProductionSha256(row.provider_record_hash, `internal_route_edges.${row.id}.provider_record_hash`);
    const provenanceKind = requiredString(row.provenance_kind, `internal_route_edges.${row.id}.provenance_kind`);
    if (!["OFFICIAL_SOURCE", "OPERATOR_CONFIRMED", "FIELD_SURVEY"].includes(provenanceKind)) {
      throw new Error(`${pack.id}@${pack.version} internal_route_edges provenance_kind is not allowed: ${row.id}`);
    }
    const verificationStatus = requiredString(row.verification_status, `internal_route_edges.${row.id}.verification_status`);
    if (verificationStatus !== "VERIFIED") {
      throw new Error(`${pack.id}@${pack.version} internal_route_edges verification_status must be VERIFIED: ${row.id}`);
    }
    if (!Number.isInteger(row.last_verified_at) || row.last_verified_at <= 0) {
      throw new Error(`${pack.id}@${pack.version} internal_route_edges verifiedAt is required: ${row.id}`);
    }
    requiredProductionSha256(row.evidence_hash, `internal_route_edges.${row.id}.evidence_hash`);
  }
}

function validateProductionStationPathwayEdgeProvenance(database, pack) {
  if (pack.artifactKind !== "production" || !hasTable(database, "station_pathway_edges")) {
    return;
  }
  const requiredColumns = [
    "source_id",
    "source_snapshot_id",
    "provider_record_hash",
    "provenance_kind",
    "verification_status",
    "last_verified_at",
    "evidence_hash",
  ];
  const columns = new Set(database.prepare("PRAGMA table_info(station_pathway_edges)").all().map((row) => row.name));
  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges provenance column missing: ${column}`);
    }
  }

  const sourceIds = new Set(pack.sourceInventory.map((source) => source.id));
  const rows = database
    .prepare(`
      SELECT id, source_id, source_snapshot_id, provider_record_hash,
             provenance_kind, verification_status, last_verified_at, evidence_hash
      FROM station_pathway_edges
      ORDER BY id
    `)
    .all();
  for (const row of rows) {
    const sourceId = requiredString(row.source_id, `station_pathway_edges.${row.id}.source_id`);
    if (!sourceIds.has(sourceId)) {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges source_id is not in sourceInventory: ${row.id}`);
    }
    requiredString(row.source_snapshot_id, `station_pathway_edges.${row.id}.source_snapshot_id`);
    requiredProductionSha256(row.provider_record_hash, `station_pathway_edges.${row.id}.provider_record_hash`);
    const provenanceKind = requiredString(row.provenance_kind, `station_pathway_edges.${row.id}.provenance_kind`);
    if (!productionFacilityProvenanceKinds.includes(provenanceKind)) {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges provenance_kind is not allowed: ${row.id}`);
    }
    const verificationStatus = requiredString(row.verification_status, `station_pathway_edges.${row.id}.verification_status`);
    if (verificationStatus !== "VERIFIED") {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges verification_status must be VERIFIED: ${row.id}`);
    }
    if (!Number.isInteger(row.last_verified_at) || row.last_verified_at <= 0) {
      throw new Error(`${pack.id}@${pack.version} station_pathway_edges verifiedAt is required: ${row.id}`);
    }
    requiredProductionSha256(row.evidence_hash, `station_pathway_edges.${row.id}.evidence_hash`);
  }
}

function validateProductionFacilityProvenance(database, pack) {
  if (pack.artifactKind !== "production" || !hasTable(database, "facilities")) {
    return;
  }
  const requiredColumns = [
    "provider_facility_ref",
    ...facilityEvidenceProvenanceColumns,
  ];
  const columns = new Set(database.prepare("PRAGMA table_info(facilities)").all().map((row) => row.name));
  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(`${pack.id}@${pack.version} facilities provenance column missing: ${column}`);
    }
  }
  const sourceIds = new Set(pack.sourceInventory.map((source) => source.id));
  const rows = database
    .prepare(`
      SELECT id, status, source_id, source_snapshot_id, provider_facility_ref,
             provider_record_hash, provenance_kind,
             verified_at, retrieved_at, evidence_hash, status_meaning,
             operational_status, installation_status, confidence
      FROM facilities
      ORDER BY id
    `)
    .all();
  for (const row of rows) {
    validateProductionFacilityRow(row, sourceIds, pack);
  }
}

function validateProductionFacilityRow(row, sourceIds, pack) {
  validateProductionEvidenceSource(row, sourceIds, pack, "facilities", row.id);
  requiredString(row.provider_facility_ref, `facilities.${row.id}.provider_facility_ref`);
  validateProductionEvidenceHashesAndKind(row, pack, "facilities", row.id);
  const statusMeaning = validateProductionFacilityEvidenceState(row, pack, "facilities", row.id);
  validateProductionFacilityPositiveStatus(row, statusMeaning, pack);
}

function validateProductionEvidenceSource(row, sourceIds, pack, tableName, rowId) {
  const label = `${tableName}.${rowId}`;
  if (!sourceIds.has(requiredString(row.source_id, `${label}.source_id`))) {
    throw new Error(`${pack.id}@${pack.version} ${tableName} source_id is not in sourceInventory: ${rowId}`);
  }
  requiredString(row.source_snapshot_id, `${label}.source_snapshot_id`);
}

function validateProductionEvidenceHashesAndKind(row, pack, tableName, rowId) {
  const label = `${tableName}.${rowId}`;
  requiredProductionSha256(row.provider_record_hash, `${label}.provider_record_hash`);
  requiredProductionSha256(row.evidence_hash, `${label}.evidence_hash`);
  const provenanceKind = requiredString(row.provenance_kind, `${label}.provenance_kind`);
  if (!productionFacilityProvenanceKinds.includes(provenanceKind)) {
    throw new Error(`${pack.id}@${pack.version} ${tableName} provenance_kind is not allowed: ${rowId}`);
  }
}

function validateProductionFacilityEvidenceState(row, pack, tableName, rowId) {
  const label = `${tableName}.${rowId}`;
  const statusMeaning = requiredString(row.status_meaning, `${label}.status_meaning`);
  requiredString(row.operational_status, `${label}.operational_status`);
  requiredString(row.installation_status, `${label}.installation_status`);
  validateProductionFacilityEvidenceConfidence(row.confidence, pack, tableName, rowId);
  validateProductionFacilityEvidenceTimestamps(row, pack, tableName, rowId);
  return statusMeaning;
}

function validateProductionFacilityEvidenceTimestamps(row, pack, tableName, rowId) {
  if (!Number.isInteger(row.verified_at) || row.verified_at <= 0) {
    throw new Error(`${pack.id}@${pack.version} ${tableName} verified_at is required: ${rowId}`);
  }
  if (!Number.isInteger(row.retrieved_at) || row.retrieved_at <= 0) {
    throw new Error(`${pack.id}@${pack.version} ${tableName} retrieved_at is required: ${rowId}`);
  }
}

function validateProductionFacilityEvidenceConfidence(confidence, pack, tableName, rowId) {
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    throw new Error(`${pack.id}@${pack.version} ${tableName} confidence must be between 0 and 100: ${rowId}`);
  }
}

function validateProductionFacilityPositiveStatus(row, statusMeaning, pack) {
  const positiveStatus = ["NORMAL", "AVAILABLE", "IN_SERVICE", "OPERATING", "OPEN", "ADMIN_VERIFIED"].includes(
    String(row.status ?? "").toUpperCase(),
  );
  if (positiveStatus && statusMeaning !== "REALTIME_OPERATION") {
    throw new Error(`${pack.id}@${pack.version} facilities positive status requires REALTIME_OPERATION evidence: ${row.id}`);
  }
}

function validateProductionStationFacilityEvidence(database, pack) {
  if (pack.artifactKind !== "production" || !hasTable(database, "station_facility_evidence")) {
    return;
  }
  const requiredColumns = [
    "station_id",
    "line_id",
    "facility_type",
    "evidence_kind",
    ...facilityEvidenceProvenanceColumns,
    "strict_route_eligible",
    "strict_route_eligible_reason",
  ];
  const columns = new Set(database.prepare("PRAGMA table_info(station_facility_evidence)").all().map((row) => row.name));
  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(`${pack.id}@${pack.version} station_facility_evidence provenance column missing: ${column}`);
    }
  }

  const sourceIds = new Set(pack.sourceInventory.map((source) => source.id));
  const rows = database
    .prepare(`
      SELECT station_id, line_id, facility_type, evidence_kind, source_id,
             source_snapshot_id, provider_record_hash, evidence_hash,
             provenance_kind, installation_status, operational_status,
             status_meaning, confidence, verified_at, retrieved_at,
             strict_route_eligible, strict_route_eligible_reason
      FROM station_facility_evidence
      ORDER BY station_id, line_id, facility_type
    `)
    .all();
  for (const row of rows) {
    validateProductionStationFacilityEvidenceRow(row, sourceIds, pack);
  }
}

function validateProductionStationFacilityEvidenceRow(row, sourceIds, pack) {
  const id = `${row.station_id}:${row.line_id}:${row.facility_type}`;
  requiredString(row.station_id, `station_facility_evidence.${id}.station_id`);
  requiredString(row.line_id, `station_facility_evidence.${id}.line_id`);
  requiredString(row.facility_type, `station_facility_evidence.${id}.facility_type`);
  const evidenceKind = requiredString(row.evidence_kind, `station_facility_evidence.${id}.evidence_kind`);
  if (!["EXISTS", "NOT_EXISTS", "UNKNOWN"].includes(evidenceKind)) {
    throw new Error(`${pack.id}@${pack.version} station_facility_evidence evidence_kind is not allowed: ${id}`);
  }
  validateProductionEvidenceSource(row, sourceIds, pack, "station_facility_evidence", id);
  validateProductionEvidenceHashesAndKind(row, pack, "station_facility_evidence", id);
  validateProductionFacilityEvidenceState(row, pack, "station_facility_evidence", id);
  if (row.strict_route_eligible === 1 && evidenceKind !== "EXISTS") {
    throw new Error(`${pack.id}@${pack.version} station_facility_evidence strict route eligibility requires EXISTS: ${id}`);
  }
  if (row.strict_route_eligible === 1) {
    requiredString(row.strict_route_eligible_reason, `station_facility_evidence.${id}.strict_route_eligible_reason`);
  }
}

function validateAccessibilityCoverageEdgeProvenance(edge, sourceUpdatedAtById, pack) {
  const sourceId = requiredString(edge.source_id, `network_edges.${edge.id}.source_id`);
  const sourceUpdatedAt = sourceUpdatedAtById.get(sourceId);
  if (sourceUpdatedAt === undefined) {
    throw new Error(`${pack.id}@${pack.version} network_edges accessibility edge source_id is not in sourceInventory: ${edge.id}`);
  }
  const provenanceKind = requiredString(edge.provenance_kind, `network_edges.${edge.id}.provenance_kind`);
  if (!["OFFICIAL_SOURCE", "OPERATOR_CONFIRMED", "FIELD_SURVEY"].includes(provenanceKind)) {
    throw new Error(`${pack.id}@${pack.version} network_edges accessibility edge provenance_kind is not allowed: ${edge.id}`);
  }
  const verificationStatus = requiredString(edge.verification_status, `network_edges.${edge.id}.verification_status`);
  if (verificationStatus !== "VERIFIED") {
    throw new Error(`${pack.id}@${pack.version} network_edges accessibility edge verification_status must be VERIFIED: ${edge.id}`);
  }
  if (!Number.isInteger(edge.last_verified_at) || edge.last_verified_at <= 0) {
    throw new Error(`${pack.id}@${pack.version} network_edges accessibility edge verifiedAt is required: ${edge.id}`);
  }
  if (edge.last_verified_at < sourceUpdatedAt) {
    throw new Error(`${pack.id}@${pack.version} network_edges accessibility edge verifiedAt is older than source evidence: ${edge.id}`);
  }
  if (!Number.isInteger(edge.reliability_score) || edge.reliability_score < 80) {
    throw new Error(`${pack.id}@${pack.version} network_edges accessibility edge reliability_score is below 80: ${edge.id}`);
  }
}

function validatePositiveEdgeProvenance(edge, sourceUpdatedAtById, pack) {
  validateAccessibilityCoverageEdgeProvenance(edge, sourceUpdatedAtById, pack);
}

function productionVerifiedCoverage(database, edgeRows) {
  const stationLineRows = database
    .prepare("SELECT station_id, line_id FROM station_lines ORDER BY station_id, line_id")
    .all();
  const requiredEntryPairs = new Set();
  const requiredExitPairs = new Set();
  const requiredTransferPairs = new Set();
  const lineNodesByStation = new Map();
  for (const row of stationLineRows) {
    const nodeId = stationLineNodeId(row.station_id, row.line_id);
    requiredEntryPairs.add(edgePairKey(row.station_id, nodeId));
    requiredExitPairs.add(edgePairKey(nodeId, row.station_id));
    const stationNodes = lineNodesByStation.get(row.station_id) ?? [];
    stationNodes.push(nodeId);
    lineNodesByStation.set(row.station_id, stationNodes);
  }
  for (const stationNodes of lineNodesByStation.values()) {
    for (const fromNode of stationNodes) {
      for (const toNode of stationNodes) {
        if (fromNode !== toNode) {
          requiredTransferPairs.add(edgePairKey(fromNode, toNode));
        }
      }
    }
  }

  const verifiedEntryPairs = new Set();
  const verifiedExitPairs = new Set();
  const verifiedTransferPairs = new Set();
  for (const edge of edgeRows) {
    if (!isVerifiedAccessibilityCoverageEdge(edge)) {
      continue;
    }
    const edgeType = normalizedEdgeType(edge.edge_type);
    const fromNodeId = coverageNodeId(edge.from_node_id);
    const toNodeId = coverageNodeId(edge.to_node_id);
    if (edgeType === "ENTRY") {
      verifiedEntryPairs.add(edgePairKey(fromNodeId, toNodeId));
    } else if (edgeType === "EXIT") {
      verifiedExitPairs.add(edgePairKey(fromNodeId, toNodeId));
    } else if (edgeType === "TRANSFER") {
      verifiedTransferPairs.add(edgePairKey(fromNodeId, toNodeId));
      verifiedTransferPairs.add(edgePairKey(toNodeId, fromNodeId));
    }
  }

  return {
    entry: coverageItem(requiredEntryPairs, verifiedEntryPairs),
    exit: coverageItem(requiredExitPairs, verifiedExitPairs),
    transfer: coverageItem(requiredTransferPairs, verifiedTransferPairs),
  };
}

function coverageItem(requiredPairs, verifiedPairs) {
  const missing = [...requiredPairs].filter((pair) => !verifiedPairs.has(pair));
  return {
    denominator: requiredPairs.size,
    verified: requiredPairs.size - missing.length,
    missingCount: missing.length,
    ratio: requiredPairs.size === 0 ? 1 : Number(((requiredPairs.size - missing.length) / requiredPairs.size).toFixed(4)),
  };
}

function isPositiveAccessibilityEdge(edge) {
  return (
    String(edge.stair_access_state ?? "").toUpperCase() === "STEP_FREE" &&
    String(edge.accessibility_status ?? "").toUpperCase() === "AVAILABLE"
  );
}

function isAccessibilityCoverageCandidate(edge) {
  const edgeType = normalizedEdgeType(edge.edge_type);
  return (
    ["ENTRY", "EXIT", "TRANSFER"].includes(edgeType) &&
    String(edge.stair_access_state ?? "").toUpperCase() === "STEP_FREE" &&
    String(edge.accessibility_status ?? "").toUpperCase() === "AVAILABLE"
  );
}

function isAccessibilityProvenanceCandidate(edge) {
  const edgeType = normalizedEdgeType(edge.edge_type);
  const accessibilityStatus = String(edge.accessibility_status ?? "").toUpperCase();
  return (
    ["ENTRY", "EXIT", "TRANSFER"].includes(edgeType) &&
    String(edge.stair_access_state ?? "").toUpperCase() === "STEP_FREE" &&
    ["AVAILABLE", "UNKNOWN"].includes(accessibilityStatus)
  );
}

function isUnverifiedAccessibilityCoverageEdge(edge) {
  const edgeType = normalizedEdgeType(edge.edge_type);
  return (
    ["ENTRY", "EXIT", "TRANSFER"].includes(edgeType) &&
    String(edge.stair_access_state ?? "").toUpperCase() === "STEP_FREE" &&
    String(edge.accessibility_status ?? "").toUpperCase() !== "AVAILABLE"
  );
}

function isVerifiedAccessibilityCoverageEdge(edge) {
  return (
    isAccessibilityCoverageCandidate(edge) &&
    edge.source_id &&
    edge.provenance_kind &&
    edge.verification_status === "VERIFIED" &&
    Number.isInteger(edge.last_verified_at) &&
    edge.last_verified_at > 0 &&
    Number.isInteger(edge.reliability_score) &&
    edge.reliability_score >= 80
  );
}

function edgePairKey(fromNodeId, toNodeId) {
  return `${fromNodeId}->${toNodeId}`;
}

function coverageNodeId(nodeId) {
  return stationLineNodeFromRouteNodeId(nodeId) ?? nodeId;
}

function timestampSeconds(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return Math.floor(parsed / 1000);
}

function hasTable(database, tableName) {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function validateManifest(manifest, { requireProduction = false } = {}) {
  validateManifestJsonSchema(manifest);
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }
  const manifestVersion = manifest.manifestVersion ?? 1;
  if (manifestVersion !== 1 && manifestVersion !== 2) {
    throw new Error("manifestVersion must be 1 or 2");
  }
  if (manifestVersion === 2) {
    validateManifestV2Envelope(manifest);
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
    if (requireProduction && artifactKind !== "production") {
      throw new Error(`${pack.id}@${pack.version} remote publish requires production artifactKind`);
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
    validateSignature(pack.signature, `${pack.id}@${pack.version}`, manifestVersion, artifactKind);
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
  if (manifestVersion === 2) {
    validateManifestSignature(manifest);
  }
}

function validateManifestJsonSchema(manifest) {
  const schema = JSON.parse(readFileSync(new URL("./schema/manifest.schema.json", import.meta.url), "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must match manifest.schema.json");
  }
  for (const key of schema.required ?? []) {
    if (!(key in manifest)) {
      throw new Error(`manifest.schema.json required field missing: ${key}`);
    }
  }
  const allowedProperties = new Set(Object.keys(schema.properties ?? {}));
  for (const key of Object.keys(manifest)) {
    if (!allowedProperties.has(key)) {
      throw new Error(`manifest.schema.json additional field is unsupported: ${key}`);
    }
  }
  const manifestVersion = manifest.manifestVersion ?? 1;
  if (manifestVersion === 2) {
    const versionRule = schema.allOf?.find((rule) => rule?.then?.required?.includes("signature"));
    for (const key of versionRule?.then?.required ?? []) {
      if (!(key in manifest)) {
        throw new Error(`manifest.schema.json v2 required field missing: ${key}`);
      }
    }
  }
}

function validateManifestV2Envelope(manifest) {
  requiredChannel(manifest.channel, "manifest.channel");
  requiredPositiveInteger(manifest.releaseSequence, "manifest.releaseSequence");
  const publishedAt = requiredDate(manifest.publishedAt, "manifest.publishedAt");
  const expiresAt = requiredDate(manifest.expiresAt, "manifest.expiresAt");
  if (expiresAt <= publishedAt) {
    throw new Error("manifest.expiresAt must be after manifest.publishedAt");
  }
  requiredString(manifest.keyId, "manifest.keyId");
  if (!manifest.signature || typeof manifest.signature !== "object") {
    throw new Error("manifest.signature must be an object");
  }
  const algorithm = requiredString(manifest.signature.algorithm, "manifest.signature.algorithm");
  if (algorithm !== "sha256-manifest-v2" && algorithm !== "rsa-sha256-manifest-v2") {
    throw new Error("manifest.signature algorithm is unsupported");
  }
  const value = requiredString(manifest.signature.value, "manifest.signature.value");
  if (algorithm === "sha256-manifest-v2") {
    requiredSha256(value, "manifest.signature.value");
  } else if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("manifest.signature.value must be a base64url string");
  }
}

function validateManifestSignature(manifest) {
  const canonical = canonicalJson(withoutSignature(manifest));
  const hasProductionPack = manifest.packs.some((pack) => pack.artifactKind === "production");
  if (hasProductionPack) {
    if (manifest.keyId !== signingKeyId()) {
      throw new Error("manifest.keyId is unknown");
    }
    if (
      manifest.signature.algorithm !== "rsa-sha256-manifest-v2" ||
      !verifyRsaSha256Signature(signingPublicKey(), canonical, manifest.signature.value)
    ) {
      throw new Error("manifest signature mismatch");
    }
    return;
  }
  if (
    manifest.signature.algorithm !== "sha256-manifest-v2" ||
    manifest.signature.value !== sha256(Buffer.from(canonical))
  ) {
    throw new Error("manifest signature mismatch");
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
    throw new Error(
      `${label} production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence`,
    );
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

function validateSignature(signature, label, manifestVersion, artifactKind) {
  if (!signature || typeof signature !== "object") {
    throw new Error(`${label} signature must be an object`);
  }
  const algorithm = requiredString(signature.algorithm, "signature.algorithm");
  const expectedAlgorithm = artifactKind === "production"
    ? (manifestVersion === 2 ? "rsa-sha256-pack-manifest-v2" : "rsa-sha256-pack-manifest-v1")
    : (manifestVersion === 2 ? "sha256-pack-manifest-v2" : "sha256-pack-manifest-v1");
  if (algorithm !== expectedAlgorithm) {
    throw new Error(`${label} signature algorithm is unsupported`);
  }
  const value = requiredString(signature.value, "signature.value");
  if (algorithm.startsWith("sha256-")) {
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
    if (artifactKind === "production" || source.coverageScope !== undefined) {
      validateSourceInventoryCoverageScope(
        source.coverageScope,
        artifactKind === "production"
          ? `${label} production sourceInventory.coverageScope`
          : `${label} sourceInventory.coverageScope`,
      );
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

function validateSourceInventoryCoverageScope(coverageScope, label) {
  if (!coverageScope || typeof coverageScope !== "object" || Array.isArray(coverageScope)) {
    throw new Error(`${label} must be an object`);
  }
  requiredStringArray(coverageScope.regionIds, `${label}.regionIds`);
  requiredStringArray(coverageScope.operatorIds, `${label}.operatorIds`);
  requiredStringArray(coverageScope.sourceDomains, `${label}.sourceDomains`);
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

function packSignature(pack, manifestVersion) {
  if (pack.artifactKind === "production") {
    const canonical = productionSignaturePayload(pack);
    const signature = {
      algorithm: manifestVersion === 2 ? "rsa-sha256-pack-manifest-v2" : "rsa-sha256-pack-manifest-v1",
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
    algorithm: manifestVersion === 2 ? "sha256-pack-manifest-v2" : "sha256-pack-manifest-v1",
    value: sha256(Buffer.from(fixtureSignaturePayload(pack))),
  };
}

function withoutSignature(value) {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  throw new Error("manifest canonical value is unsupported");
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

function signingKeyId() {
  return process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID?.trim() || "production-v1";
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
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--require-production") {
      args["require-production"] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    args[key.slice(2)] = value;
    index += 1;
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

function requiredChannel(value, label) {
  const channel = requiredString(value, label);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(channel)) {
    throw new Error(`${label} must match ^[A-Za-z][A-Za-z0-9_-]*$`);
  }
  return channel;
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value.map((entry) => requiredString(entry, `${label}[]`));
}

function requiredPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredDate(value, label) {
  const rawValue = requiredString(value, label);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(rawValue)) {
    throw new Error(`${label} must include timezone offset`);
  }
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return parsed;
}

function requiredSha256(value, label) {
  const hash = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${label} must be a lowercase sha256 hex string`);
  }
  return hash;
}

function requiredProductionSha256(value, label) {
  const hash = requiredSha256(value, label);
  if (/^([0-9a-f])\1{63}$/.test(hash)) {
    throw new Error(`${label} is placeholder evidence`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
