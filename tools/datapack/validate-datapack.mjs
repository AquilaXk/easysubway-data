#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";

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
  const compressedPath = path.join(root, pack.url);
  const compressedBytes = await readFile(compressedPath);
  const compressedSha = sha256(compressedBytes);
  if (compressedSha !== pack.sha256) {
    throw new Error(`${pack.id}@${pack.version} compressed checksum mismatch: ${compressedSha}`);
  }

  const sqliteBytes = gunzipSync(compressedBytes);
  const sqliteSha = sha256(sqliteBytes);
  if (sqliteSha !== pack.sqliteSha256) {
    throw new Error(`${pack.id}@${pack.version} sqlite checksum mismatch: ${sqliteSha}`);
  }

  const sqlitePath = path.join(temporaryDir, `${pack.id}-v${pack.version}.sqlite`);
  await writeFile(sqlitePath, sqliteBytes);
  validateSqlite(sqlitePath, pack);
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

    validateNetworkEdgeFacilityReferences(database, pack);

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
    requiredString(pack.url, "pack.url");
    requiredSha256(pack.sha256, "pack.sha256");
    requiredSha256(pack.sqliteSha256, "pack.sqliteSha256");
    requiredString(pack.schemaVersion, "pack.schemaVersion");
    if (!Array.isArray(pack.requiredTables) || pack.requiredTables.length === 0) {
      throw new Error(`${pack.id}@${pack.version} requiredTables must be a non-empty array`);
    }
    for (const tableName of pack.requiredTables) {
      validateTableName(tableName);
    }
    if (pack.minimumTableRows !== undefined) {
      if (!pack.minimumTableRows || typeof pack.minimumTableRows !== "object" || Array.isArray(pack.minimumTableRows)) {
        throw new Error(`${pack.id}@${pack.version} minimumTableRows must be an object`);
      }
      for (const [tableName, minimumRows] of Object.entries(pack.minimumTableRows)) {
        validateTableName(tableName);
        if (!Number.isInteger(minimumRows) || minimumRows < 0) {
          throw new Error(`${pack.id}@${pack.version} minimumTableRows entry must be a non-negative integer`);
        }
      }
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
