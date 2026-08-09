#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { canonicalJson, validateArtifactComponentManifest } from "./lib/manifest-validation.mjs";

const GZIP_SHA256 = "f328fbedff014be18a0e8341e0bdbfe9b0dd774fa7e9ae7692aa869e831707b3";
const SQLITE_SHA256 = "a581c5d2a78f765b859e7e7b7d62d3bf0d9b573bcebd246ab4c6f0cd62fddfc5";
const BYTE_SIZE = 1463745;
const CATALOG_PACK_ID = "capital-station-catalog-d85742f14cbf97c526a6b94dd55bbf863e1d1346-v1";
const TABLES = Object.freeze({
  stations: ["id", "name_ko", "name_en", "name_sub", "normalized_name", "region"],
  station_aliases: ["station_id", "alias", "normalized_alias"],
  lines: ["id", "name_ko", "name_en"],
  station_lines: ["station_id", "line_id", "station_code", "line_sequence"],
});

const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (left, right) => Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
const compare = (left, right, fields) => { for (const field of fields) { const value = bytes(left[field], right[field]); if (value) return value; } return 0; };

async function exactInput(input) {
  const before = await lstat(input);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("--input must be a regular non-symlink file");
  const handle = await open(input, "r");
  try {
    const current = await handle.stat();
    if (before.dev !== current.dev || before.ino !== current.ino || current.size !== BYTE_SIZE) throw new Error("--input changed before same-FD read");
    const value = await handle.readFile();
    if (value.length !== BYTE_SIZE || sha(value) !== GZIP_SHA256) throw new Error("--input is not the exact d857 v18 gzip");
    const sqlite = gunzipSync(value);
    if (sha(sqlite) !== SQLITE_SHA256) throw new Error("--input is not the exact d857 v18 SQLite");
    return sqlite;
  } finally { await handle.close(); }
}

function sourceRows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("PRAGMA user_version").get().user_version !== 18 || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("source v18 schema integrity is invalid");
    const result = {};
    for (const [table, columns] of Object.entries(TABLES)) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name);
      if (columns.some((column) => !actual.includes(column))) throw new Error(`source ${table} columns are invalid`);
      const rows = db.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all().map((row) => ({ ...row }));
      if ((table !== "station_aliases" && rows.length === 0) || rows.some((row) => Object.values(row).some((value) => value == null))) throw new Error(`source ${table} rows are invalid`);
      const keys = table === "stations" || table === "lines" ? [columns[0]] : table === "station_lines" ? ["station_id", "line_id"] : columns;
      const seen = new Set(rows.map((row) => keys.map((key) => row[key]).join("\0")));
      if (seen.size !== rows.length) throw new Error(`source ${table} duplicate rows are invalid`);
      result[table] = rows;
    }
    const stations = new Set(result.stations.map((row) => row.id));
    const lines = new Set(result.lines.map((row) => row.id));
    if (result.station_aliases.some((row) => !stations.has(row.station_id)) || result.station_lines.some((row) => !stations.has(row.station_id) || !lines.has(row.line_id))) throw new Error("source station references are invalid");
    return result;
  } finally { db.close(); }
}

function writeCatalog(file, rows) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE; PRAGMA encoding='UTF-8'; PRAGMA foreign_keys=ON; CREATE TABLE stations(id TEXT NOT NULL PRIMARY KEY,name_ko TEXT NOT NULL,name_en TEXT NOT NULL DEFAULT '',name_sub TEXT NOT NULL DEFAULT '',normalized_name TEXT NOT NULL,region TEXT NOT NULL DEFAULT ''); CREATE TABLE station_aliases(station_id TEXT NOT NULL,alias TEXT NOT NULL,normalized_alias TEXT NOT NULL,FOREIGN KEY(station_id) REFERENCES stations(id)); CREATE TABLE lines(id TEXT NOT NULL PRIMARY KEY,name_ko TEXT NOT NULL,name_en TEXT NOT NULL DEFAULT ''); CREATE TABLE station_lines(station_id TEXT NOT NULL,line_id TEXT NOT NULL,station_code TEXT NOT NULL DEFAULT '',line_sequence INTEGER NOT NULL,PRIMARY KEY(station_id,line_id),FOREIGN KEY(station_id) REFERENCES stations(id),FOREIGN KEY(line_id) REFERENCES lines(id)); CREATE TABLE station_search_index(station_id TEXT NOT NULL,token TEXT NOT NULL,normalized_token TEXT NOT NULL,source_kind TEXT NOT NULL CHECK(source_kind IN ('STATION_NAME','STATION_ALIAS')),PRIMARY KEY(station_id,source_kind,normalized_token,token),FOREIGN KEY(station_id) REFERENCES stations(id)); BEGIN");
    for (const [table, columns] of Object.entries(TABLES)) {
      const insert = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of [...rows[table]].sort((left, right) => compare(left, right, columns))) insert.run(...columns.map((column) => row[column]));
    }
    const search = [...rows.stations.map((row) => ({ station_id: row.id, token: row.name_ko, normalized_token: row.normalized_name, source_kind: "STATION_NAME" })), ...rows.station_aliases.map((row) => ({ station_id: row.station_id, token: row.alias, normalized_token: row.normalized_alias, source_kind: "STATION_ALIAS" }))];
    const insertSearch = db.prepare("INSERT INTO station_search_index VALUES (?,?,?,?)");
    for (const row of search.sort((left, right) => compare(left, right, ["station_id", "source_kind", "normalized_token", "token"]))) insertSearch.run(row.station_id, row.token, row.normalized_token, row.source_kind);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("catalog foreign key check failed");
    db.exec("COMMIT; PRAGMA user_version=18; VACUUM;");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
}

async function payloadDigest(file) { const bytes = await readFile(file); return sha(Buffer.from(canonicalJson([{ path: "payload/catalog.sqlite", sizeBytes: bytes.length, sha256: sha(bytes) }]))); }

export async function emitStationCatalogFromBundledPack({ input, output }) {
  if (typeof input !== "string" || typeof output !== "string" || !input || !output) throw new Error("--input and --output are required");
  const parent = path.dirname(output);
  const parentStat = await lstat(parent).catch(() => undefined);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) throw new Error("--output parent must be a real directory");
  if (await lstat(output).then(() => true).catch(() => false)) throw new Error("--output must be absent");
  const sqlite = await exactInput(input);
  const temp = await mkdtemp(path.join(parent, ".bundled-station-catalog-"));
  try {
    const source = path.join(temp, ".source.sqlite");
    await writeFile(source, sqlite, { flag: "wx" });
    const rows = sourceRows(source);
    const payload = path.join(temp, "payload/catalog.sqlite");
    await mkdir(path.dirname(payload));
    writeCatalog(payload, rows);
    const stationIds = [...new Set(rows.stations.map((row) => row.id))].sort(bytes);
    const manifest = { manifestVersion: 1, artifactKind: "station-catalog-pack", catalogPackId: CATALOG_PACK_ID, stationSetSha256: sha(Buffer.from(canonicalJson(stationIds))), payloadSha256: await payloadDigest(payload) };
    validateArtifactComponentManifest(manifest, manifest.stationSetSha256);
    await writeFile(path.join(temp, "manifest.json"), Buffer.from(canonicalJson(manifest)), { flag: "wx" });
    await rm(source);
    await rename(temp, output);
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
}

function cli(argv) { if (argv.length !== 4 || argv[0] !== "--input" || argv[2] !== "--output") throw new Error("exactly --input and --output are required"); return { input: argv[1], output: argv[3] }; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) emitStationCatalogFromBundledPack(cli(process.argv.slice(2))).catch((error) => { process.stderr.write(`emit-station-catalog-from-bundled-pack: ${error.message}\n`); process.exitCode = 1; });
