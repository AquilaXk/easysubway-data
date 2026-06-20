#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = path.resolve(root, requireArg(args, "fixture"));
  const outputDir = path.resolve(root, requireArg(args, "output"));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const schema = await readFile(path.join(root, "tools/datapack/schema/catalog-schema.sql"), "utf8");

  validateFixture(fixture);
  await mkdir(outputDir, { recursive: true });

  const manifestPacks = [];
  for (const pack of fixture.packs) {
    const packUrl = pack.url ?? `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
    const sqlitePath = path.join(outputDir, packUrl.replace(/\.gz$/, ""));
    const compressedPath = path.join(outputDir, packUrl);

    await mkdir(path.dirname(sqlitePath), { recursive: true });
    await rm(sqlitePath, { force: true });
    await rm(compressedPath, { force: true });

    buildSqlitePack(sqlitePath, schema, pack);

    const sqliteBytes = await readFile(sqlitePath);
    const compressedBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    await writeFile(compressedPath, compressedBytes);

    manifestPacks.push({
      id: pack.id,
      version: pack.version,
      url: packUrl,
      sha256: sha256(compressedBytes),
      sqliteSha256: sha256(sqliteBytes),
      schemaVersion: pack.schemaVersion,
      requiredTables: pack.requiredTables,
      minimumTableRows: pack.minimumTableRows ?? {},
    });
  }

  const manifest = {
    ttlSeconds: fixture.manifest.ttlSeconds,
    activePack: fixture.manifest.activePack,
    packs: manifestPacks,
  };
  if (fixture.manifest.emergencyOverride !== undefined) {
    manifest.emergencyOverride = fixture.manifest.emergencyOverride;
  }

  await writeFile(path.join(outputDir, "current.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function buildSqlitePack(sqlitePath, schema, pack) {
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec(schema);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertCatalogMetadata(database, pack);
      insertRows(database, "operators", ["id", "name_ko", "name_en"], pack.operators, (row) => [
        requiredString(row.id, "operators.id"),
        requiredString(row.nameKo, "operators.nameKo"),
        row.nameEn ?? "",
      ]);
      insertRows(database, "lines", ["id", "operator_id", "name_ko", "name_en", "color"], pack.lines, (row) => [
        requiredString(row.id, "lines.id"),
        requiredString(row.operatorId, "lines.operatorId"),
        requiredString(row.nameKo, "lines.nameKo"),
        row.nameEn ?? "",
        row.color ?? "",
      ]);
      insertRows(
        database,
        "stations",
        [
          "id",
          "name_ko",
          "name_en",
          "normalized_name",
          "region",
          "latitude",
          "longitude",
          "data_quality_level",
          "data_source_type",
          "last_verified_at",
        ],
        pack.stations,
        (row) => [
          requiredString(row.id, "stations.id"),
          requiredString(row.nameKo, "stations.nameKo"),
          row.nameEn ?? "",
          requiredString(row.normalizedName, "stations.normalizedName"),
          row.region ?? "",
          row.latitude ?? null,
          row.longitude ?? null,
          row.dataQualityLevel ?? "LEVEL_1",
          row.dataSourceType ?? "OFFICIAL_FILE",
          timestamp(row.lastVerifiedAt),
        ],
      );
      insertRows(database, "station_aliases", ["station_id", "alias", "normalized_alias"], pack.stationAliases ?? [], (row) => [
        requiredString(row.stationId, "stationAliases.stationId"),
        requiredString(row.alias, "stationAliases.alias"),
        requiredString(row.normalizedAlias, "stationAliases.normalizedAlias"),
      ]);
      insertRows(
        database,
        "station_lines",
        ["station_id", "line_id", "station_code", "line_sequence", "platform_info"],
        pack.stationLines,
        (row) => [
          requiredString(row.stationId, "stationLines.stationId"),
          requiredString(row.lineId, "stationLines.lineId"),
          row.stationCode ?? "",
          requiredInteger(row.lineSequence, "stationLines.lineSequence"),
          row.platformInfo ?? "",
        ],
      );
      insertRows(
        database,
        "network_edges",
        [
          "id",
          "from_node_id",
          "to_node_id",
          "duration_seconds",
          "distance_meters",
          "edge_type",
          "service_pattern",
          "includes_stairs",
          "stair_access_state",
          "accessibility_status",
          "reliability_score",
          "last_verified_at",
        ],
        pack.networkEdges ?? [],
        (row) => {
          const stairAccessState = row.stairAccessState ?? (row.includesStairs ? "STAIR_ONLY" : "UNKNOWN");

          return [
            requiredString(row.id, "networkEdges.id"),
            requiredString(row.fromNodeId, "networkEdges.fromNodeId"),
            requiredString(row.toNodeId, "networkEdges.toNodeId"),
            row.durationSeconds ?? 0,
            row.distanceMeters ?? 0,
            row.edgeType ?? "WALK",
            row.servicePattern ?? "",
            stairAccessState === "STAIR_ONLY" ? 1 : 0,
            stairAccessState,
            row.accessibilityStatus ?? "UNKNOWN",
            row.reliabilityScore ?? 100,
            timestamp(row.lastVerifiedAt),
          ];
        },
      );
      insertRows(database, "station_exits", ["id", "station_id", "exit_number", "description"], pack.stationExits ?? [], (row) => [
        requiredString(row.id, "stationExits.id"),
        requiredString(row.stationId, "stationExits.stationId"),
        requiredString(row.exitNumber, "stationExits.exitNumber"),
        row.description ?? "",
      ]);
      insertRows(
        database,
        "facilities",
        ["id", "station_id", "exit_id", "type", "name", "status", "floor_from", "floor_to", "description"],
        pack.facilities ?? [],
        (row) => [
          requiredString(row.id, "facilities.id"),
          requiredString(row.stationId, "facilities.stationId"),
          row.exitId ?? null,
          requiredString(row.type, "facilities.type"),
          requiredString(row.name, "facilities.name"),
          row.status ?? "NORMAL",
          row.floorFrom ?? "",
          row.floorTo ?? "",
          row.description ?? "",
        ],
      );
      insertRows(
        database,
        "station_accessibility_summaries",
        ["station_id", "summary", "warning"],
        pack.stationAccessibilitySummaries ?? [],
        (row) => [
          requiredString(row.stationId, "stationAccessibilitySummaries.stationId"),
          requiredString(row.summary, "stationAccessibilitySummaries.summary"),
          row.warning ?? "",
        ],
      );
      insertRows(database, "internal_route_nodes", ["id", "station_id", "label", "node_type"], pack.internalRouteNodes ?? [], (row) => [
        requiredString(row.id, "internalRouteNodes.id"),
        requiredString(row.stationId, "internalRouteNodes.stationId"),
        requiredString(row.label, "internalRouteNodes.label"),
        requiredString(row.nodeType, "internalRouteNodes.nodeType"),
      ]);
      insertRows(
        database,
        "internal_route_edges",
        [
          "id",
          "from_node_id",
          "to_node_id",
          "edge_type",
          "distance_meters",
          "duration_seconds",
          "includes_stairs",
          "requires_elevator",
          "requires_escalator",
          "slope_level",
          "width_level",
          "reliability_score",
          "instruction",
        ],
        pack.internalRouteEdges ?? [],
        (row) => [
          requiredString(row.id, "internalRouteEdges.id"),
          requiredString(row.fromNodeId, "internalRouteEdges.fromNodeId"),
          requiredString(row.toNodeId, "internalRouteEdges.toNodeId"),
          row.edgeType ?? "WALK",
          row.distanceMeters ?? 0,
          row.durationSeconds ?? 0,
          row.includesStairs ? 1 : 0,
          row.requiresElevator ? 1 : 0,
          row.requiresEscalator ? 1 : 0,
          row.slopeLevel ?? 1,
          row.widthLevel ?? 2,
          row.reliabilityScore ?? 100,
          row.instruction ?? "",
        ],
      );
      insertRows(
        database,
        "data_quality_records",
        ["id", "target_type", "target_id", "quality_level", "checked_at"],
        pack.dataQualityRecords ?? [],
        (row) => [
          requiredString(row.id, "dataQualityRecords.id"),
          requiredString(row.targetType, "dataQualityRecords.targetType"),
          requiredString(row.targetId, "dataQualityRecords.targetId"),
          requiredString(row.qualityLevel, "dataQualityRecords.qualityLevel"),
          timestamp(row.checkedAt),
        ],
      );
      database.exec("COMMIT");
      vacuum(database);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function insertCatalogMetadata(database, pack) {
  const rows = [
    ["schemaVersion", pack.schemaVersion],
    ...Object.entries(pack.metadata ?? {}),
  ];
  const statement = database.prepare("INSERT INTO catalog_metadata (key, value, updated_at) VALUES (?, ?, ?)");
  const updatedAt = Date.UTC(2026, 5, 19) / 1000;
  for (const [key, value] of rows) {
    statement.run(key, String(value), updatedAt);
  }
}

function insertRows(database, table, columns, rows, mapRow) {
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows ?? []) {
    statement.run(...mapRow(row));
  }
}

function vacuum(database) {
  database.exec("PRAGMA optimize");
  database.exec("VACUUM");
}

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== "object") {
    throw new Error("fixture must be an object");
  }
  if (!Number.isInteger(fixture.manifest?.ttlSeconds) || fixture.manifest.ttlSeconds <= 0) {
    throw new Error("manifest ttlSeconds must be a positive integer");
  }
  if (!Array.isArray(fixture.packs) || fixture.packs.length === 0) {
    throw new Error("fixture packs must be a non-empty array");
  }
  const packIdentities = new Set(
    fixture.packs.map((pack) => `${pack.id ?? ""}@${pack.version ?? ""}`),
  );
  if (fixture.manifest.activePack !== undefined) {
    validatePackIdentity(fixture.manifest.activePack, "manifest.activePack");
    const activePackIdentity = `${fixture.manifest.activePack.id}@${fixture.manifest.activePack.version}`;
    if (!packIdentities.has(activePackIdentity)) {
      throw new Error("manifest.activePack must match one of fixture packs");
    }
  }
  if (fixture.manifest.emergencyOverride !== undefined) {
    validatePackIdentity(fixture.manifest.emergencyOverride, "manifest.emergencyOverride");
    requiredString(fixture.manifest.emergencyOverride.reason, "manifest.emergencyOverride.reason");
  }
  for (const pack of fixture.packs) {
    validatePackIdentity(pack, "pack");
    requiredString(pack.schemaVersion, "pack.schemaVersion");
    if (!Array.isArray(pack.requiredTables) || pack.requiredTables.length === 0) {
      throw new Error(`${pack.id} requiredTables must be a non-empty array`);
    }
  }
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

function requiredInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return Math.floor(millis / 1000);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
