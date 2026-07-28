#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const TABLES = Object.freeze([
  ["operators", "operators"],
  ["lines", "lines"],
  ["stations", "stations"],
  ["station_aliases", "stationAliases"],
  ["station_lines", "stationLines"],
  ["service_calendars", "serviceCalendars"],
  ["service_calendar_dates", "serviceCalendarDates"],
  ["transit_routes", "transitRoutes"],
  ["transit_trips", "transitTrips"],
  ["transit_stop_times", "transitStopTimes"],
  ["transit_frequencies", "transitFrequencies"],
  ["fare_zones", "fareZones"],
  ["fare_rules", "fareRules"],
  ["fare_discounts", "fareDiscounts"],
  ["station_fare_zones", "stationFareZones"],
  ["official_od_fare_quotes", "officialOdFareQuotes"],
  ["transit_feed_info", "transitFeedInfo"],
  ["route_service_artifact_evidence", "routeServiceArtifactEvidence"],
  ["realtime_provider_line_mappings", "realtimeProviderLineMappings"],
  ["realtime_provider_station_mappings", "realtimeProviderStationMappings"],
  ["network_edges", "networkEdges"],
  ["out_of_station_transfer_links", "outOfStationTransferLinks"],
  ["station_exits", "stationExits"],
  ["facilities", "facilities"],
  ["station_facility_evidence", "stationFacilityEvidence"],
  ["station_accessibility_summaries", "stationAccessibilitySummaries"],
  ["internal_route_nodes", "internalRouteNodes"],
  ["internal_route_edges", "internalRouteEdges"],
  ["station_pathway_nodes", "stationPathwayNodes"],
  ["station_pathway_edges", "stationPathwayEdges"],
  ["transfer_rules", "transferRules"],
  ["station_car_door_hints", "stationCarDoorHints"],
  ["data_quality_records", "dataQualityRecords"],
  ["route_map_positions", "routeMapPositions"],
  ["route_map_line_tracks", "routeMapLineTracks"],
]);

const BOOLEAN_COLUMNS = new Set([
  "service_calendars.monday",
  "service_calendars.tuesday",
  "service_calendars.wednesday",
  "service_calendars.thursday",
  "service_calendars.friday",
  "service_calendars.saturday",
  "service_calendars.sunday",
  "transit_frequencies.exact_times",
  "fare_discounts.free_ride",
  "route_service_artifact_evidence.admission_eligible",
  "realtime_provider_line_mappings.supports_arrivals",
  "realtime_provider_line_mappings.supports_train_positions",
  "realtime_provider_station_mappings.supports_arrivals",
  "realtime_provider_station_mappings.supports_train_positions",
  "network_edges.includes_stairs",
  "out_of_station_transfer_links.bidirectional",
  "out_of_station_transfer_links.requires_fare_exit",
  "out_of_station_transfer_links.requires_reentry",
  "station_exits.has_elevator_connection",
  "station_facility_evidence.strict_route_eligible",
  "internal_route_edges.includes_stairs",
  "internal_route_edges.requires_elevator",
  "internal_route_edges.requires_escalator",
  "station_pathway_edges.bidirectional",
  "station_pathway_edges.includes_stairs",
  "station_pathway_edges.requires_elevator",
  "station_pathway_edges.requires_escalator",
  "route_map_positions.commercial_use_allowed",
  "route_map_positions.attribution_required",
  "route_map_line_tracks.commercial_use_allowed",
  "route_map_line_tracks.attribution_required",
]);

const TIMESTAMP_COLUMNS = new Set([
  "stations.last_verified_at",
  "realtime_provider_line_mappings.updated_at",
  "realtime_provider_station_mappings.updated_at",
  "network_edges.last_verified_at",
  "out_of_station_transfer_links.last_field_verified_at",
  "station_exits.last_verified_at",
  "facilities.verified_at",
  "facilities.retrieved_at",
  "station_facility_evidence.verified_at",
  "station_facility_evidence.retrieved_at",
  "internal_route_edges.last_verified_at",
  "station_pathway_edges.last_verified_at",
  "station_car_door_hints.last_verified_at",
  "data_quality_records.checked_at",
  "route_map_positions.reviewed_at",
  "route_map_positions.updated_at",
  "route_map_line_tracks.updated_at",
]);

const JSON_COLUMNS = new Set([
  "fare_rules.additional_steps_json",
  "route_map_positions.label_polygon",
]);

const DERIVED_EDGE_PROVENANCE_KEYS = Object.freeze([
  "sourceId",
  "sourceSnapshotId",
  "providerRecordHash",
  "evidenceHash",
  "lastFieldVerifiedAt",
  "lastVerifiedAt",
  "verifiedAt",
  "fieldProvenance",
  "provenanceKind",
  "verificationStatus",
]);

const PASSTHROUGH_ARRAYS = new Set([
  "sourceInventory",
  "requiredTables",
  "movementPathCandidates",
  "representativeRouteRegressions",
  "coverageLineOperatorScopes",
]);

const PRODUCTION_FACILITY_COLUMNS = Object.freeze([
  "source_id",
  "source_snapshot_id",
  "provider_facility_ref",
  "provider_record_hash",
  "provenance_kind",
  "verified_at",
  "retrieved_at",
  "evidence_hash",
  "status_meaning",
  "operational_status",
  "installation_status",
  "confidence",
]);

const LEGACY_DEFAULTS = Object.freeze({
  network_edges: Object.freeze({
    source_id: "",
    source_snapshot_id: "",
    provider_record_hash: "",
    provenance_kind: "UNKNOWN",
    verification_status: "UNKNOWN",
    evidence_hash: "",
  }),
  internal_route_edges: Object.freeze({
    source_id: "",
    source_snapshot_id: "",
    provider_record_hash: "",
    provenance_kind: "UNKNOWN",
    verification_status: "UNKNOWN",
    facility_id: null,
    last_verified_at: null,
    evidence_hash: "",
  }),
});

export function extractBundledPackFixture({ database, expectedDatabase, template, gzipSha256, sqliteSha256 }) {
  if (template?.packs?.length !== 1 || template.packs[0]?.artifactKind !== "production") {
    throw new Error("template must contain exactly one production pack");
  }
  if (!expectedDatabase) throw new Error("expectedDatabase is required");
  assertSha256(gzipSha256, "gzipSha256");
  assertSha256(sqliteSha256, "sqliteSha256");

  const fixture = structuredClone(template);
  const pack = fixture.packs[0];
  assertKnownTemplateArrays(pack);
  assertKnownDatabaseTables(database, expectedDatabase);
  const supportedTables = new Set([...TABLES.map(([table]) => table), "catalog_metadata"]);
  for (const table of listTables(database)) {
    if (!supportedTables.has(table)
      && database.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get().count !== 0) {
      throw new Error(`non-empty unsupported table: ${table}`);
    }
  }
  for (const [table, target] of TABLES) {
    if (!tableExists(database, table)) continue;
    const available = tableColumns(database, table);
    if (table === "facilities" && PRODUCTION_FACILITY_COLUMNS.some((column) => !available.has(column))) {
      const expected = tableColumns(expectedDatabase, table);
      const unknown = [...available].filter((column) => !expected.has(column));
      if (unknown.length > 0) throw new Error(`unknown facilities columns: ${unknown.join(", ")}`);
      if (!Array.isArray(pack.facilities)) throw new Error("legacy facilities require reviewed template rows");
      for (const legacy of database.prepare("SELECT * FROM facilities ORDER BY id").all()) {
        const matches = pack.facilities.filter((facility) =>
          facility.stationId === legacy.station_id && facility.type === legacy.type);
        if (matches.length === 1) {
          matches[0].id = legacy.id;
          continue;
        }
        // ponytail: only this reviewed unmatched legacy ID is a compatibility record; add a mapping if another appears.
        if (matches.length !== 0 || legacy.id !== "facility-sangnoksu-accessible-toilet-1") {
          throw new Error(`legacy facility requires one reviewed successor: ${legacy.id}`);
        }
        pack.facilities.push({
          ...normalizeRow("facilities", legacy, available),
          lineId: "seoul-4",
          sourceId: "seoul-metro-accessibility",
          sourceSnapshotId: "seoul-metro-accessibility-capital-admission-20260712",
          providerFacilityRef: legacy.id,
          providerRecordHash: sqliteSha256,
          provenanceKind: "MIGRATION_COMPATIBILITY",
          verifiedAt: "2025-06-01T00:00:00.000Z",
          retrievedAt: "2026-07-12T00:00:00.000Z",
          evidenceHash: gzipSha256,
          statusMeaning: "COMPATIBILITY_REFERENCE_ONLY",
          operationalStatus: "UNKNOWN",
          installationStatus: "UNKNOWN",
          confidence: 0,
          derivationKind: "GENERATED",
        });
      }
      continue;
    }
    pack[target] = readRows(database, expectedDatabase, table);
  }
  if (tableExists(database, "catalog_metadata")) {
    pack.metadata = readMetadata(database, expectedDatabase);
  }
  pack.minimumTableRows = Object.fromEntries(pack.requiredTables.map((table) => [
    table,
    requiredTableRowCount(database, pack, table),
  ]));
  fixture.migrationSourceArtifact = { gzipSha256, sqliteSha256 };
  return fixture;
}

function readRows(database, expectedDatabase, table) {
  const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  const expectedColumns = expectedDatabase.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  assertKnownColumns(table, columns, expectedColumns);
  const available = new Set(columns.map(({ name }) => name));
  const primaryKeyColumns = expectedColumns
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(({ name }) => name);
  const orderColumns = primaryKeyColumns.filter((name) => available.has(name));
  if (orderColumns.length === 0) orderColumns.push(...columns.map(({ name }) => name));
  const rows = database.prepare(
    `SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderColumns.map(quoteIdentifier).join(", ")}`,
  ).all();
  assertUniqueRows(table, rows, primaryKeyColumns);
  return rows.map((row) => {
    const normalized = normalizeRow(table, row, available);
    if (table === "network_edges" || table === "out_of_station_transfer_links") {
      for (const key of DERIVED_EDGE_PROVENANCE_KEYS) delete normalized[key];
    }
    return normalized;
  });
}

function normalizeRow(table, row, available) {
  const normalized = {};
  for (const [column, value] of Object.entries(row)) {
    const key = column === "additional_steps_json" ? "additionalSteps" : snakeToCamel(column);
    const identity = `${table}.${column}`;
    normalized[key] = BOOLEAN_COLUMNS.has(identity)
      ? value === 1
      : TIMESTAMP_COLUMNS.has(identity)
        ? isoTimestamp(value)
        : JSON_COLUMNS.has(identity) && value !== ""
          ? JSON.parse(value)
          : value;
  }
  for (const [column, value] of Object.entries(LEGACY_DEFAULTS[table] ?? {})) {
    if (!available.has(column)) normalized[snakeToCamel(column)] = value;
  }
  return normalized;
}

function assertKnownTemplateArrays(pack) {
  const known = new Set([...TABLES.map(([, target]) => target), ...PASSTHROUGH_ARRAYS]);
  for (const [key, value] of Object.entries(pack)) {
    if (Array.isArray(value) && !known.has(key)) throw new Error(`unknown production template array: ${key}`);
  }
}

function assertKnownDatabaseTables(database, expectedDatabase) {
  const expected = new Set(listTables(expectedDatabase));
  for (const table of listTables(database)) {
    if (!expected.has(table)) throw new Error(`unknown bundled pack table: ${table}`);
  }
}

function assertKnownColumns(table, columns, expectedColumns) {
  const expected = new Set(expectedColumns.map(({ name }) => name));
  const unknown = columns.map(({ name }) => name).filter((name) => !expected.has(name));
  if (unknown.length > 0) throw new Error(`unknown ${table} columns: ${unknown.join(", ")}`);
  const actual = new Set(columns.map(({ name }) => name));
  const supportedLegacyColumns = new Set(Object.keys(LEGACY_DEFAULTS[table] ?? {}));
  const missing = [...expected].filter((name) => !actual.has(name) && !supportedLegacyColumns.has(name));
  if (missing.length > 0) throw new Error(`missing ${table} columns: ${missing.join(", ")}`);
}

function assertUniqueRows(table, rows, primaryKeyColumns) {
  if (primaryKeyColumns.length === 0) return;
  const keys = new Set();
  for (const row of rows) {
    const key = JSON.stringify(primaryKeyColumns.map((column) => row[column]));
    if (keys.has(key)) throw new Error(`duplicate ${table} primary key: ${key}`);
    keys.add(key);
  }
}

function listTables(database) {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(({ name }) => name);
}

function tableExists(database, table) {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) != null;
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map(({ name }) => name));
}

function readMetadata(database, expectedDatabase) {
  const rows = readRows(database, expectedDatabase, "catalog_metadata");
  return Object.fromEntries(rows.filter(({ key }) => key !== "schemaVersion").map(({ key, value }) => [key, value]));
}

function requiredTableRowCount(database, pack, table) {
  if (table === "catalog_metadata") return 1 + Object.keys(pack.metadata ?? {}).length;
  const target = TABLES.find(([name]) => name === table)?.[1];
  if (!target) throw new Error(`required table has no fixture mapping: ${table}`);
  return pack[target]?.length ?? (tableExists(database, table) ? database.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get().count : 0);
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function isoTimestamp(value) {
  if (value == null) return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid SQLite timestamp: ${value}`);
  return date.toISOString();
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${label} must be lowercase sha256`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || argv[index + 1] == null) throw new Error(`invalid argument: ${flag ?? ""}`);
    args[flag.slice(2)] = argv[index + 1];
  }
  return args;
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required`);
  return value;
}

async function main(argv) {
  const args = parseArgs(argv);
  const packPath = path.resolve(requiredArg(args, "pack"));
  const templatePath = path.resolve(requiredArg(args, "template"));
  const outputPath = path.resolve(requiredArg(args, "output"));
  const schemaPath = path.resolve(args.schema ?? path.join(import.meta.dirname, "schema/catalog-schema.sql"));
  const gzipBytes = await readFile(packPath);
  const sqliteBytes = gunzipSync(gzipBytes);
  const expectedDatabase = new DatabaseSync(":memory:");
  expectedDatabase.exec(await readFile(schemaPath, "utf8"));
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-export-bundled-pack-"));
  const sqlitePath = path.join(directory, "pack.sqlite");
  try {
    await writeFile(sqlitePath, sqliteBytes);
    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const fixture = extractBundledPackFixture({
        database,
        expectedDatabase,
        template: JSON.parse(await readFile(templatePath, "utf8")),
        gzipSha256: sha256(gzipBytes),
        sqliteSha256: sha256(sqliteBytes),
      });
      await writeFile(outputPath, `${JSON.stringify(fixture)}\n`);
    } finally {
    database.close();
    }
  } finally {
    expectedDatabase.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
