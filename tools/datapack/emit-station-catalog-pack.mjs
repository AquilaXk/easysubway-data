#!/usr/bin/env node
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { canonicalJson, validateArtifactComponentManifest } from "./lib/manifest-validation.mjs";

const INPUT = "tools/datapack/release/capital-production-canonical-pack.json";
const NODE_VERSION = "24.19.0";
const SQLITE_VERSION = "3.53.4";
const TABLES = {
  stations: { source: "stations", keys: ["id", "nameKo", "nameEn", "nameSub", "normalizedName", "region"], allowed: ["id", "nameKo", "nameEn", "nameSub", "normalizedName", "region", "latitude", "longitude", "dataQualityLevel", "dataSourceType", "lastVerifiedAt"], target: ["id", "name_ko", "name_en", "name_sub", "normalized_name", "region"] },
  station_aliases: { source: "stationAliases", keys: ["stationId", "alias", "normalizedAlias"], allowed: ["stationId", "alias", "normalizedAlias"], target: ["station_id", "alias", "normalized_alias"] },
  lines: { source: "lines", keys: ["id", "nameKo", "nameEn"], allowed: ["id", "operatorId", "nameKo", "nameEn", "color"], target: ["id", "name_ko", "name_en"] },
  station_lines: { source: "stationLines", keys: ["stationId", "lineId", "stationCode", "lineSequence"], allowed: ["stationId", "lineId", "stationCode", "lineSequence", "platformInfo"], target: ["station_id", "line_id", "station_code", "line_sequence"] },
};

export async function emitStationCatalogPack(input) {
  if (process.versions.node !== NODE_VERSION || process.versions.sqlite !== SQLITE_VERSION) throw new Error(`runtime must be Node ${NODE_VERSION} with SQLite ${SQLITE_VERSION}`);
  const root = path.resolve(input.repositoryRoot ?? process.cwd());
  const sourceRelative = exact(raw(input.input ?? INPUT, "--input"), INPUT, "--input");
  const source = await exactInput(root, sourceRelative);
  const output = path.resolve(raw(input.output, "--output"));
  await outputParent(output);
  const catalogPackId = raw(input.catalogPackId, "--catalog-pack-id");
  const value = parse(await readFile(source));
  const pack = capitalPack(value);
  const rows = projection(pack);
  const temp = await mkdtemp(path.join(path.dirname(output), ".station-catalog-pack-"));
  let reservation;
  try {
    const artifact = temp;
    const file = path.join(artifact, "payload/catalog.sqlite");
    await mkdir(path.dirname(file), { recursive: true });
    writeSqlite(file, rows);
    const stationSetSha256 = digest(rows.stations.map((row) => row.id).sort(bytes));
    const manifest = { manifestVersion: 1, artifactKind: "station-catalog-pack", catalogPackId, stationSetSha256, payloadSha256: await inventory(artifact) };
    validateArtifactComponentManifest(manifest, stationSetSha256);
    await writeFile(path.join(artifact, "manifest.json"), Buffer.from(canonicalJson(manifest)), { flag: "wx" });
    await validateOutput(artifact);
    reservation = await reserveOutput(output);
    await mkdir(path.join(output, "payload"));
    await link(path.join(artifact, "payload/catalog.sqlite"), path.join(output, "payload/catalog.sqlite"));
    await link(path.join(artifact, "manifest.json"), path.join(output, "manifest.json"));
    await validateOutput(output);
  } catch (error) {
    if (reservation) await removeReservation(output, reservation);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function capitalPack(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.packs)) throw new Error("canonical fixture packs are required");
  const packs = value.packs.filter((pack) => pack?.id === "capital" && pack?.artifactKind === "production");
  if (packs.length !== 1) throw new Error("exactly one capital production pack is required");
  return packs[0];
}

function projection(pack) {
  const result = {};
  for (const [target, contract] of Object.entries(TABLES)) {
    const source = pack[contract.source];
    if (!Array.isArray(source) || (target !== "station_aliases" && source.length === 0)) throw new Error(`${contract.source} must not be empty`);
    result[target] = source.map((row) => projectRow(row, contract.keys, contract.allowed, contract.target));
  }
  validateTypes(result);
  validateRows(result);
  return result;
}

function projectRow(row, sourceKeys, allowedKeys, targetKeys) {
  if (!row || typeof row !== "object" || Array.isArray(row) || sourceKeys.some((key) => !(key in row)) || Object.keys(row).some((key) => !allowedKeys.includes(key))) throw new Error("projection row keys are required");
  const selected = Object.fromEntries(sourceKeys.map((key, index) => [targetKeys[index], row[key]]));
  return selected;
}

function validateTypes(rows) {
  for (const [name, fields] of [["stations", ["id", "name_ko", "normalized_name", "region"]], ["station_aliases", ["station_id", "alias", "normalized_alias"]], ["lines", ["id", "name_ko"]], ["station_lines", ["station_id", "line_id"]]]) for (const row of rows[name]) for (const field of fields) if (typeof row[field] !== "string" || row[field].length === 0) throw new Error("projection row types are invalid");
  for (const [name, fields] of [["stations", ["name_en", "name_sub"]], ["lines", ["name_en"]], ["station_lines", ["station_code"]]]) for (const row of rows[name]) for (const field of fields) if (typeof row[field] !== "string") throw new Error("projection row types are invalid");
  if (rows.station_lines.some((row) => !Number.isSafeInteger(row.line_sequence) || row.line_sequence < 1)) throw new Error("projection row types are invalid");
}

function validateRows(rows) {
  for (const [name, keys] of [["stations", ["id"]], ["lines", ["id"]], ["station_aliases", ["station_id", "alias", "normalized_alias"]], ["station_lines", ["station_id", "line_id"]]]) {
    const seen = new Set();
    for (const row of rows[name]) { const key = keys.map((field) => row[field]).join("\0"); if (seen.has(key)) throw new Error(`${name} duplicate key`); seen.add(key); }
  }
  const stations = new Set(rows.stations.map((row) => row.id));
  const lines = new Set(rows.lines.map((row) => row.id));
  if (rows.station_aliases.some((row) => !stations.has(row.station_id)) || rows.station_lines.some((row) => !stations.has(row.station_id) || !lines.has(row.line_id))) throw new Error("foreign key mismatch");
}

function writeSqlite(file, rows) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE; PRAGMA encoding='UTF-8'; PRAGMA foreign_keys=ON; CREATE TABLE stations(id TEXT NOT NULL PRIMARY KEY,name_ko TEXT NOT NULL,name_en TEXT NOT NULL DEFAULT '',name_sub TEXT NOT NULL DEFAULT '',normalized_name TEXT NOT NULL,region TEXT NOT NULL DEFAULT ''); CREATE TABLE station_aliases(station_id TEXT NOT NULL,alias TEXT NOT NULL,normalized_alias TEXT NOT NULL,FOREIGN KEY(station_id) REFERENCES stations(id)); CREATE TABLE lines(id TEXT NOT NULL PRIMARY KEY,name_ko TEXT NOT NULL,name_en TEXT NOT NULL DEFAULT ''); CREATE TABLE station_lines(station_id TEXT NOT NULL,line_id TEXT NOT NULL,station_code TEXT NOT NULL DEFAULT '',line_sequence INTEGER NOT NULL,PRIMARY KEY(station_id,line_id),FOREIGN KEY(station_id) REFERENCES stations(id),FOREIGN KEY(line_id) REFERENCES lines(id)); CREATE TABLE station_search_index(station_id TEXT NOT NULL,token TEXT NOT NULL,normalized_token TEXT NOT NULL,source_kind TEXT NOT NULL CHECK(source_kind IN ('STATION_NAME','STATION_ALIAS')),PRIMARY KEY(station_id,source_kind,normalized_token,token),FOREIGN KEY(station_id) REFERENCES stations(id)); BEGIN");
    for (const [name, columns] of Object.entries({ stations: TABLES.stations.target, station_aliases: TABLES.station_aliases.target, lines: TABLES.lines.target, station_lines: TABLES.station_lines.target })) insertRows(db, name, columns, rows[name]);
    const index = [...rows.stations.map((row) => ({ station_id: row.id, token: row.name_ko, normalized_token: row.normalized_name, source_kind: "STATION_NAME" })), ...rows.station_aliases.map((row) => ({ station_id: row.station_id, token: row.alias, normalized_token: row.normalized_alias, source_kind: "STATION_ALIAS" }))].sort((a, b) => compareTuple(a, b, ["station_id", "source_kind", "normalized_token", "token"]));
    insertRows(db, "station_search_index", ["station_id", "token", "normalized_token", "source_kind"], index);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("foreign key mismatch");
    db.exec("COMMIT; PRAGMA user_version=18; VACUUM;");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction was not open */ }
    throw error;
  } finally { db.close(); }
}

function insertRows(db, table, columns, rows) { const insert = db.prepare(`INSERT INTO ${quote(table)} VALUES(${columns.map(() => "?").join(",")})`); for (const row of [...rows].sort((a, b) => compareTuple(a, b, columns))) insert.run(...columns.map((column) => row[column])); }
async function inventory(root) { const payload = path.join(root, "payload"); const names = await readdir(payload); if (canonicalJson(names.sort(bytes)) !== canonicalJson(["catalog.sqlite"])) throw new Error("payload paths mismatch"); const file = path.join(payload, "catalog.sqlite"); const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("payload has unknown or invalid file"); const value = await readFile(file); return digest([{ path: "payload/catalog.sqlite", sizeBytes: value.length, sha256: digest(value) }]); }
async function validateOutput(root) { const actual = []; async function collect(current) { for (const entry of await readdir(current, { withFileTypes: true })) { const target = path.join(current, entry.name); if (entry.isDirectory()) await collect(target); else if (entry.isFile() && !entry.isSymbolicLink()) actual.push(path.relative(root, target).split(path.sep).join("/")); else throw new Error("artifact output must be regular files"); } } await collect(root); if (canonicalJson(actual.sort(bytes)) !== canonicalJson(["manifest.json", "payload/catalog.sqlite"])) throw new Error("unknown artifact output"); }
function parse(bytes) { try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("canonical fixture must be JSON"); } }
function digest(value) { return createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(canonicalJson(value))).digest("hex"); }
function compareTuple(left, right, fields) { for (const field of fields) { const result = bytes(left[field], right[field]); if (result) return result; } return 0; }
function bytes(left, right) { return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right))); }
function quote(value) { return `"${value.replaceAll('"', '""')}"`; }
function raw(value, label) { if (typeof value !== "string" || !value || value.trim() !== value) throw new Error(`${label} must be raw`); return value; }
function exact(value, expected, label) { if (value !== expected) throw new Error(`${label} must be ${expected}`); return value; }
async function regular(target, label) { let stat; try { stat = await lstat(target); } catch { throw new Error(`${label} must be a regular file`); } if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`); return target; }
async function outputParent(output) { let stat; try { stat = await lstat(path.dirname(output)); } catch { throw new Error("--output parent must be an existing directory"); } if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("--output parent must be an existing directory"); }
async function reserveOutput(output) { try { await mkdir(output); } catch (error) { if (error.code === "EEXIST") throw new Error("--output must not already exist"); throw error; } return lstat(output); }
async function removeReservation(output, reservation) { try { const current = await lstat(output); if (current.dev === reservation.dev && current.ino === reservation.ino) await rm(output, { recursive: true, force: true }); } catch (error) { if (error.code !== "ENOENT") throw error; } }
async function exactInput(root, relative) { const target = path.join(root, relative); await regular(target, "--input"); let realRoot; let realTarget; try { [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]); } catch { throw new Error("--input must resolve under repository root"); } if (realTarget !== path.join(realRoot, relative)) throw new Error("--input must resolve under repository root"); return target; }

function cli(argv) { if (argv.length !== 4 || argv[0] !== "--output" || argv[2] !== "--catalog-pack-id") throw new Error("exactly --output and --catalog-pack-id are required"); return { output: argv[1], catalogPackId: argv[3] }; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) emitStationCatalogPack(cli(process.argv.slice(2))).catch((error) => { process.stderr.write(`emit-station-catalog-pack: ${error.message}\n`); process.exitCode = 1; });
