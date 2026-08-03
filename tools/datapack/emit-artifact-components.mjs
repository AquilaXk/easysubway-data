#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";

import { canonicalJson, validateArtifactComponentManifest, withoutSignature } from "./lib/manifest-validation.mjs";
import { validateSourceSnapshotFreshness } from "./validate-source-snapshot-freshness.mjs";

const CLI_ARGS = new Set(["source-sqlite", "source-provenance", "build-spec", "output", "map-pack-id", "catalog-pack-id", "bundle-id", "release-sequence", "active-from", "fresh-until", "built-at", "key-id"]);
const COMPONENTS = {
  topology: ["network_edges", "out_of_station_transfer_links", "transfer_rules", "realtime_provider_line_mappings", "realtime_provider_station_mappings"],
  timetable: ["service_calendars", "service_calendar_dates", "transit_routes", "transit_trips", "transit_stop_times", "transit_frequencies", "transit_feed_info", "route_service_artifact_evidence"],
  accessibility: ["station_exits", "facilities", "facility_status_snapshots", "station_facility_evidence", "station_accessibility_summaries", "internal_route_nodes", "internal_route_edges", "station_pathway_nodes", "station_pathway_edges", "station_car_door_hints"],
  fare: ["fare_zones", "fare_rules", "fare_discounts", "station_fare_zones", "official_od_fare_quotes"],
};
const REFERENCES = { stations: ["id"], lines: ["id"], station_lines: ["station_id", "line_id", "line_sequence"] };
const EXPECTED_CHILDREN = ["map-pack", "station-catalog-pack", "server-route-bundle"];
const IDENTITY_DDL = "CREATE TABLE artifact_component_identity (bundleId TEXT NOT NULL, releaseSequence INTEGER NOT NULL CHECK (releaseSequence BETWEEN 1 AND 9007199254740991), stationSetSha256 TEXT NOT NULL, serviceTimezone TEXT NOT NULL CHECK (serviceTimezone = 'Asia/Seoul'))";

export async function emitArtifactComponents(input) {
  const root = path.resolve(input.repositoryRoot ?? process.cwd());
  const source = await regular(input.sourceSqlite, "--source-sqlite");
  const output = path.resolve(required(input.output, "--output"));
  if (await exists(output)) throw new Error("--output must not already exist");
  const buildSpecPath = exact(required(input.buildSpec, "--build-spec"), "tools/datapack/release/candidate-build-spec.json", "--build-spec");
  const ids = readIds(input);
  if (Date.parse(ids.activeFrom) >= Date.parse(ids.freshUntil)) throw new Error("--active-from must be before --fresh-until");

  const [buildSpecBytes, layoutBytes, contractBytes, sourceSchemaBytes] = await Promise.all([
    readFile(path.join(root, buildSpecPath)), readFile(path.join(root, "contracts/datapack/artifact-component-table-layout.json")),
    readFile(path.join(root, "contracts/datapack/server-route-bundle-build-contract.json")), readFile(path.join(root, "tools/datapack/schema/catalog-schema.sql")),
  ]);
  const buildSpec = parseJson(buildSpecBytes, "build spec");
  const layout = parseJson(layoutBytes, "table layout");
  const buildContract = parseJson(contractBytes, "build contract");
  const sourceSchema = layout?.serverRouteBundle?.sourceSchema;
  validateFixedContracts(layout, buildContract, sourceSchema, sourceSchemaBytes);
  const provenancePath = await regular(input.sourceProvenance, "--source-provenance");
  if (path.basename(provenancePath) !== "current.provenance.json") throw new Error("--source-provenance must be current.provenance.json");
  const currentPath = path.join(path.dirname(provenancePath), "current.json");
  const [provenanceBytes, currentBytes, sourceBytes, snapshots, policy, governanceBytes, inventoryBytes] = await Promise.all([
    readFile(provenancePath), readFile(currentPath), readFile(source), readJson(path.join(root, buildSpec.sourceSnapshotEvidencePath)),
    readJson(path.join(root, "release/product-gates/datapack-freshness-sla.json")), readFile(path.join(root, "tools/datapack/source-governance-policy.json")), readFile(path.join(root, "tools/datapack/source-inventory.json")),
  ]);
  const provenance = parseJson(provenanceBytes, "source provenance");
  const current = parseJson(currentBytes, "current manifest");
  validateInputBinding(provenance, current, sha(currentBytes), sha(sourceBytes), sha(buildSpecBytes));
  const freshness = validateSourceSnapshotFreshness({ buildSpec, snapshots, policy, evaluationAt: ids.builtAt, governancePolicy: parseJson(governanceBytes, "governance policy"), inventory: parseJson(inventoryBytes, "source inventory"), governancePolicySha256: sha(governanceBytes) });
  const cap = Math.min(requiredInstant(current.expiresAt, "current.json.expiresAt"), ...freshness.results.map((result) => requiredInstant(result.freshnessExpiresAt, "source freshness")));
  if (Date.parse(ids.freshUntil) > cap) throw new Error("--fresh-until exceeds source freshness");

  const temp = await mkdtemp(path.join(path.dirname(output), ".artifact-components-"));
  const snapshot = path.join(temp, ".source.sqlite");
  let sourceDb;
  try {
    await writeFile(snapshot, sourceBytes, { flag: "wx" });
    sourceDb = new DatabaseSync(snapshot, { open: true, readOnly: true });
    if (sourceDb.prepare("PRAGMA user_version").get().user_version !== sourceSchema.sqliteUserVersion) throw new Error("source SQLite user_version mismatch");
    validateSourceSchema(sourceDb, sourceSchemaBytes);
    const stationSetSha256 = stationSetDigest(sourceDb);
    validateBundleReferences(sourceDb, layout.serverRouteBundle);
    await emitMap(root, temp, sourceDb, ids, stationSetSha256, buildContract);
    await emitCatalog(temp, sourceDb, ids, stationSetSha256);
    await emitServer(temp, sourceDb, ids, stationSetSha256, buildSpec, buildSpecBytes, layout, buildContract);
    sourceDb.close(); sourceDb = undefined;
    await Promise.all([snapshot, `${snapshot}-wal`, `${snapshot}-shm`].map((file) => rm(file, { force: true })));
    await validateOutput(temp);
    await rename(temp, output);
  } catch (error) {
    sourceDb?.close();
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

function readIds(input) {
  return { mapPackId: raw(input.mapPackId, "--map-pack-id"), catalogPackId: raw(input.catalogPackId, "--catalog-pack-id"), bundleId: raw(input.bundleId, "--bundle-id"), keyId: raw(input.keyId, "--key-id"), releaseSequence: positive(input.releaseSequence), activeFrom: kst(input.activeFrom, "--active-from"), freshUntil: kst(input.freshUntil, "--fresh-until"), builtAt: utc(input.builtAt, "--built-at") };
}

function validateFixedContracts(layout, build, sourceSchema, sourceSchemaBytes) {
  if (layout?.schemaVersion !== 1 || layout?.artifactKind !== "artifact-component-table-layout") throw new Error("table layout contract mismatch");
  if (!sourceSchema || sourceSchema.path !== "tools/datapack/schema/catalog-schema.sql" || sourceSchema.sqliteUserVersion !== 18 || sha(sourceSchemaBytes) !== sourceSchema.sha256) throw new Error("source schema contract mismatch");
  if (build?.artifactKind !== "server-route-bundle-build-contract" || build?.compressionProfile?.api !== "node:zlib.zstdCompressSync" || build.compressionProfile.requiredNodeMajor !== 24 || build.compressionProfile.compressionLevel !== 10 || build.compressionProfile.checksumFlag !== 1 || build.compressionProfile.dictionary !== null || build?.capitalMapInput?.sourcePath !== "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v4.svg") throw new Error("build contract mismatch");
  if (Number(process.versions.node.split(".")[0]) !== 24 || !raw(process.versions.node, "process.versions.node") || !raw(process.versions.zstd, "process.versions.zstd")) throw new Error("Node 24 Zstd runtime is required");
}

function validateSourceSchema(source, sourceSchemaBytes) {
  const canonical = new DatabaseSync(":memory:");
  try {
    canonical.exec(Buffer.from(sourceSchemaBytes).toString("utf8"));
    const tables = [...new Set(["operators", "route_map_positions", "route_map_line_tracks", "stations", "station_aliases", "lines", "station_lines", ...Object.keys(REFERENCES), ...Object.values(COMPONENTS).flat()])];
    for (const table of tables) {
      const columns = (db) => db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().map((column) => ({ name: column.name, type: column.type, notnull: column.notnull, dflt_value: column.dflt_value, pk: column.pk, hidden: column.hidden }));
      const foreignKeys = (db) => db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all().map((foreign) => ({ id: foreign.id, seq: foreign.seq, table: foreign.table, from: foreign.from, to: foreign.to, on_update: foreign.on_update, on_delete: foreign.on_delete, match: foreign.match }));
      if (canonicalJson(columns(source)) !== canonicalJson(columns(canonical)) || canonicalJson(foreignKeys(source)) !== canonicalJson(foreignKeys(canonical)) || canonicalJson(groupedForeignKeys(source, table)) !== canonicalJson(groupedForeignKeys(canonical, table))) throw new Error("source schema mismatch");
    }
    canonical.exec("PRAGMA foreign_keys=OFF; BEGIN");
    try {
      for (const table of tables) {
        const columns = canonical.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().filter((column) => !column.hidden).map((column) => column.name);
        const insert = canonical.prepare(`INSERT INTO ${quote(table)} VALUES(${columns.map(() => "?").join(",")})`);
        for (const row of source.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`).all()) insert.run(...columns.map((column) => row[column]));
      }
      canonical.exec("COMMIT");
    } catch (error) {
      canonical.exec("ROLLBACK");
      throw error;
    }
    if (canonical.prepare("PRAGMA foreign_key_check").all().length) throw new Error("source foreign key mismatch");
  } finally {
    canonical.close();
  }
}

async function emitMap(root, out, db, ids, stationSetSha256, build) {
  const artifact = path.join(out, "map-pack"); const payload = path.join(artifact, "payload"); await mkdir(payload, { recursive: true });
  const base = parseJson(await readFile(path.join(root, build.capitalMapInput.basemapManifestPath)), "basemap manifest");
  const seoul = base?.maps?.find?.((entry) => entry.id === "seoul") ?? base?.find?.((entry) => entry.id === "seoul");
  if (!seoul || seoul.source !== build.capitalMapInput.sourcePath || seoul.sourceSvgSha256 !== build.capitalMapInput.sourceSha256) throw new Error("Seoul basemap binding mismatch");
  const svg = await readFile(path.join(root, build.capitalMapInput.sourcePath));
  if (sha(svg) !== build.capitalMapInput.sourceSha256) throw new Error("Seoul SVG digest mismatch");
  await writeFile(path.join(payload, "metropolitan.svg"), svg);
  const rows = db.prepare("SELECT station_id AS stationId,line_id AS lineId,region,x,y,label_dx AS labelDx,label_dy AS labelDy,label_polygon AS labelPolygon,up_path AS upPath,down_path AS downPath FROM route_map_positions WHERE region='수도권' ORDER BY station_id COLLATE BINARY,line_id COLLATE BINARY").all();
  if (!rows.length) throw new Error("capital map rows are required");
  const stationIds = new Set(db.prepare("SELECT id FROM stations").all().map((row) => row.id));
  if (rows.some((row) => !stationIds.has(row.stationId))) throw new Error("map station is missing");
  const lineIds = new Set(rows.map((row) => row.lineId));
  for (const row of db.prepare("SELECT line_id,svg_color FROM route_map_line_tracks WHERE region='수도권'").all()) lineIds.add(row.line_id);
  const lineStyles = [...lineIds].sort(bytes).map((lineId) => {
    const line = db.prepare("SELECT color FROM lines WHERE id=?").get(lineId);
    if (!line) throw new Error("map line is missing");
    if (db.prepare("SELECT 1 FROM route_map_line_tracks WHERE region='수도권' AND line_id=? AND svg_color<>'' AND svg_color<>?").get(lineId, line.color)) throw new Error("svg color disagrees");
    return { lineId, color: line.color };
  });
  const displayed = new Map(); for (const row of rows) displayed.set(row.stationId, [...(displayed.get(row.stationId) ?? []), row.lineId]);
  const interchanges = [...displayed].filter(([, lines]) => new Set(lines).size >= 2).sort(([a], [b]) => bytes(a, b)).map(([stationId, lines]) => ({ stationId, lineIds: [...new Set(lines)].sort(bytes) }));
  for (const [file, value] of [["stations-layout.json", rows], ["line-styles.json", lineStyles], ["interchange-layout.json", interchanges]]) await json(path.join(payload, file), value);
  const manifest = { manifestVersion: 1, artifactKind: "map-pack", mapPackId: ids.mapPackId, stationSetSha256, payloadSha256: await inventory(artifact, new Set(["payload/metropolitan.svg", "payload/stations-layout.json", "payload/line-styles.json", "payload/interchange-layout.json"])) };
  validateArtifactComponentManifest(manifest, stationSetSha256); await json(path.join(artifact, "manifest.json"), manifest);
}

async function emitCatalog(out, source, ids, stationSetSha256) {
  const artifact = path.join(out, "station-catalog-pack"); const file = path.join(artifact, "payload/catalog.sqlite"); await mkdir(path.dirname(file), { recursive: true });
  const target = new DatabaseSync(file); sqliteProfile(target);
  target.exec("CREATE TABLE stations(id TEXT NOT NULL PRIMARY KEY,name_ko TEXT NOT NULL,name_en TEXT NOT NULL DEFAULT '',name_sub TEXT NOT NULL DEFAULT '',normalized_name TEXT NOT NULL,region TEXT NOT NULL DEFAULT ''); CREATE TABLE station_aliases(station_id TEXT NOT NULL,alias TEXT NOT NULL,normalized_alias TEXT NOT NULL,FOREIGN KEY(station_id) REFERENCES stations(id)); CREATE TABLE lines(id TEXT NOT NULL PRIMARY KEY,name_ko TEXT NOT NULL,name_en TEXT NOT NULL DEFAULT ''); CREATE TABLE station_lines(station_id TEXT NOT NULL,line_id TEXT NOT NULL,station_code TEXT NOT NULL DEFAULT '',line_sequence INTEGER NOT NULL,PRIMARY KEY(station_id,line_id),FOREIGN KEY(station_id) REFERENCES stations(id),FOREIGN KEY(line_id) REFERENCES lines(id)); CREATE TABLE station_search_index(station_id TEXT NOT NULL,token TEXT NOT NULL,normalized_token TEXT NOT NULL,source_kind TEXT NOT NULL CHECK(source_kind IN ('STATION_NAME','STATION_ALIAS')),PRIMARY KEY(station_id,source_kind,normalized_token,token),FOREIGN KEY(station_id) REFERENCES stations(id))");
  project(source, target, "stations", ["id", "name_ko", "name_en", "name_sub", "normalized_name", "region"], ["id"]); project(source, target, "station_aliases", ["station_id", "alias", "normalized_alias"], ["station_id", "alias", "normalized_alias"]); project(source, target, "lines", ["id", "name_ko", "name_en"], ["id"]); project(source, target, "station_lines", ["station_id", "line_id", "station_code", "line_sequence"], ["station_id", "line_id"]);
  const index = [...source.prepare("SELECT id AS station_id,name_ko AS token,normalized_name AS normalized_token,'STATION_NAME' AS source_kind FROM stations").all(), ...source.prepare("SELECT station_id,alias AS token,normalized_alias AS normalized_token,'STATION_ALIAS' AS source_kind FROM station_aliases").all()].sort((a, b) => tupleCompare(a, b, ["station_id", "source_kind", "normalized_token", "token"]));
  const insert = target.prepare("INSERT OR IGNORE INTO station_search_index VALUES(?,?,?,?)"); for (const row of index) insert.run(row.station_id, row.token, row.normalized_token, row.source_kind);
  finishSqlite(target); target.close(); await normalizeHeader(file);
  const manifest = { manifestVersion: 1, artifactKind: "station-catalog-pack", catalogPackId: ids.catalogPackId, stationSetSha256, payloadSha256: await inventory(artifact, new Set(["payload/catalog.sqlite"])) };
  validateArtifactComponentManifest(manifest, stationSetSha256); await json(path.join(artifact, "manifest.json"), manifest);
}

async function emitServer(out, source, ids, stationSetSha256, buildSpec, buildSpecBytes, layout, build) {
  const artifact = path.join(out, "server-route-bundle"); const payload = path.join(artifact, "payload"); await mkdir(payload, { recursive: true }); const hashes = {};
  for (const [name, owned] of Object.entries(COMPONENTS)) {
    const componentPath = path.join(artifact, `.${name}.sqlite`); const target = new DatabaseSync(componentPath); sqliteProfile(target);
    const present = new Set([...Object.keys(REFERENCES), ...owned]);
    for (const [table, columns] of Object.entries(REFERENCES)) copyTable(source, target, table, columns, present);
    for (const table of owned) copyTable(source, target, table, undefined, present);
    target.exec(IDENTITY_DDL); target.prepare("INSERT INTO artifact_component_identity VALUES(?,?,?,?)").run(ids.bundleId, ids.releaseSequence, stationSetSha256, "Asia/Seoul");
    validateComponent(target, name, layout.serverRouteBundle);
    finishSqlite(target); target.close(); await normalizeHeader(componentPath);
    const compressed = zstdCompressSync(await readFile(componentPath), { params: { [constants.ZSTD_c_compressionLevel]: build.compressionProfile.compressionLevel, [constants.ZSTD_c_checksumFlag]: build.compressionProfile.checksumFlag } }); await rm(componentPath);
    const output = path.join(payload, `${name}.sqlite.zst`); await writeFile(output, compressed); hashes[`${name}Sha256`] = sha(compressed);
  }
  const manifest = { manifestVersion: 1, artifactKind: "server-route-bundle", bundleId: ids.bundleId, releaseSequence: ids.releaseSequence, stationSetSha256, payloadSha256: await inventory(artifact, new Set(Object.keys(COMPONENTS).map((name) => `payload/${name}.sqlite.zst`))), ...hashes, provenanceSha256: "0".repeat(64), compatibilitySha256: "0".repeat(64), serviceTimezone: "Asia/Seoul", activeFrom: ids.activeFrom, freshUntil: ids.freshUntil, schemaCompatibility: build.manifestLifecycle.schemaCompatibility, keyId: ids.keyId, signature: { algorithm: "rsa-sha256-server-route-bundle-v1", value: "probe" } };
  validateArtifactComponentManifest(manifest, stationSetSha256);
  const provenance = { schemaVersion: 1, artifactKind: "server-route-bundle-provenance", bundleId: ids.bundleId, releaseSequence: ids.releaseSequence, stationSetSha256, serviceTimezone: "Asia/Seoul", activeFrom: ids.activeFrom, freshUntil: ids.freshUntil, builtAt: ids.builtAt, buildSpecSha256: sha(buildSpecBytes), sourceSnapshotSetHash: buildSpec.sourceSnapshotSetHash, sourceInventorySha256: buildSpec.sourceInventorySha256, sourceSnapshotIds: [...new Set(buildSpec.sourceSnapshotIds)].sort(bytes) };
  await json(path.join(artifact, "provenance.json"), provenance); manifest.provenanceSha256 = sha(await readFile(path.join(artifact, "provenance.json")));
  const sourceSchema = layout.serverRouteBundle.sourceSchema;
  const compatibility = { schemaVersion: 1, artifactKind: "server-route-bundle-compatibility", bundleId: ids.bundleId, releaseSequence: ids.releaseSequence, stationSetSha256, serviceTimezone: "Asia/Seoul", manifestVersion: 1, tableLayoutSchemaVersion: layout.schemaVersion, sourceSchemaPath: sourceSchema.path, sourceSqliteUserVersion: sourceSchema.sqliteUserVersion, sourceSchemaSha256: sourceSchema.sha256, schemaCompatibility: build.manifestLifecycle.schemaCompatibility, compressionProfile: build.compressionProfile, encoderRuntime: { node: process.versions.node, zstd: process.versions.zstd } };
  await json(path.join(artifact, "compatibility.json"), compatibility); manifest.compatibilitySha256 = sha(await readFile(path.join(artifact, "compatibility.json")));
  validateArtifactComponentManifest(manifest, stationSetSha256); await json(path.join(artifact, "manifest.signing-input.json"), withoutSignature(manifest));
}

function copyTable(source, target, table, projection = undefined, presentTables = undefined) {
  const info = source.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().filter((column) => !column.hidden); if (!info.length) throw new Error(`source table missing: ${table}`);
  const columns = projection ?? info.map((column) => column.name); if (columns.some((column) => !info.some((entry) => entry.name === column))) throw new Error(`source projection missing: ${table}`);
  const sourcePk = info.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  const pk = sourcePk.every((column) => columns.includes(column)) ? sourcePk : [];
  const definitions = columns.map((name) => { const column = info.find((entry) => entry.name === name); return `${quote(name)} ${column.type || ""}${column.notnull ? " NOT NULL" : ""}${column.dflt_value == null ? "" : ` DEFAULT ${column.dflt_value}`}`; });
  if (pk.length) definitions.push(`PRIMARY KEY (${pk.map(quote).join(",")})`);
  for (const foreign of groupedForeignKeys(source, table)) if (presentTables?.has(foreign.table) && foreign.from.every((column) => columns.includes(column))) definitions.push(`FOREIGN KEY (${foreign.from.map(quote).join(",")}) REFERENCES ${quote(foreign.table)} (${foreign.to.map(quote).join(",")}) ON UPDATE ${foreign.onUpdate} ON DELETE ${foreign.onDelete} MATCH ${foreign.match}`);
  target.exec(`CREATE TABLE ${quote(table)} (${definitions.join(",")})`);
  const select = `SELECT ${columns.map(quote).join(",")} FROM ${quote(table)} ORDER BY ${columns.map((column) => `${quote(column)} COLLATE BINARY`).join(",")}`; const insert = target.prepare(`INSERT INTO ${quote(table)} VALUES(${columns.map(() => "?").join(",")})`);
  target.exec("BEGIN");
  try {
    for (const row of source.prepare(select).all()) insert.run(...columns.map((column) => row[column]));
    target.exec("COMMIT");
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
}

function groupedForeignKeys(source, table) { const groups = new Map(); for (const row of source.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) { const group = groups.get(row.id) ?? { table: row.table, from: [], to: [], onUpdate: row.on_update, onDelete: row.on_delete, match: row.match }; group.from[row.seq] = row.from; group.to[row.seq] = row.to; groups.set(row.id, group); } return [...groups.values()]; }
function validateComponent(db, name, layout) {
  validateLocalReferences(db, name);
  const identity = db.prepare("SELECT * FROM artifact_component_identity").all(); if (identity.length !== 1) throw new Error(`${name} component identity mismatch`);
  if (name === "topology") validateNetworkEdges(db);
}
function validateLocalReferences(db, name) { for (const table of [...Object.keys(REFERENCES), ...COMPONENTS[name]]) for (const foreign of groupedForeignKeys(db, table)) { const rows = db.prepare(`SELECT * FROM ${quote(table)}`).all(); const target = db.prepare(`SELECT 1 FROM ${quote(foreign.table)} WHERE ${foreign.to.map((column) => `${quote(column)} IS ?`).join(" AND ")}`); for (const row of rows) { const values = foreign.from.map((column) => row[column]); if (values.some((value) => value == null)) continue; if (!target.get(...values)) throw new Error(`${name} local foreign key mismatch`); } } }
function validateBundleReferences(db, layout) {
  for (const reference of layout.crossComponentReferences) {
    const [sourceComponent, sourceTable, sourceColumn] = reference.source.split(".");
    const [targetComponent, targetTable, targetColumn] = reference.target.split(".");
    if (sourceComponent !== "topology" || !COMPONENTS[sourceComponent]?.includes(sourceTable) || !COMPONENTS[targetComponent]?.includes(targetTable)) throw new Error("cross-component reference contract mismatch");
    const sourceColumns = db.prepare(`PRAGMA table_xinfo(${quote(sourceTable)})`).all().map((column) => column.name);
    const targetColumns = db.prepare(`PRAGMA table_xinfo(${quote(targetTable)})`).all().map((column) => column.name);
    if (!sourceColumns.includes(sourceColumn) || !targetColumns.includes(targetColumn)) throw new Error("cross-component reference schema mismatch");
    const rows = db.prepare(`SELECT ${quote(sourceColumn)} AS value FROM ${quote(sourceTable)}`).all();
    if (!reference.nullable && rows.some((row) => row.value == null)) throw new Error("cross-component required reference missing");
    const targets = new Set(db.prepare(`SELECT ${quote(targetColumn)} AS value FROM ${quote(targetTable)}`).all().map((row) => row.value));
    if (rows.some((row) => row.value != null && !targets.has(row.value))) throw new Error("cross-component reference mismatch");
  }
}
function validateNetworkEdges(db) { const stations = new Set(db.prepare("SELECT id FROM stations").all().map((row) => row.id)); const pairs = new Set(db.prepare("SELECT station_id,line_id FROM station_lines").all().map((row) => `${row.station_id}\u0000${row.line_id}`)); for (const row of db.prepare("SELECT from_node_id,to_node_id,edge_type FROM network_edges").all()) { const from = endpoint(row.from_node_id, stations, pairs); const to = endpoint(row.to_node_id, stations, pairs); if (row.edge_type !== "ENTRY" && row.edge_type !== "EXIT") continue; const valid = row.edge_type === "ENTRY" ? from.kind === "station" && to.kind === "line" : from.kind === "line" && to.kind === "station"; if (!valid || from.station !== to.station) throw new Error("network edge endpoint mismatch"); } }
function endpoint(value, stations, pairs) { if (typeof value !== "string" || !value || /:/.test(value) && value.split(":").some((part) => !part)) throw new Error("invalid network endpoint"); const parts = value.split(":"); if (parts.length === 1) { if (!stations.has(value)) throw new Error("network station endpoint missing"); return { kind: "station", station: value }; } if (!pairs.has(`${parts[0]}\u0000${parts[1]}`)) throw new Error("network station-line endpoint missing"); return { kind: "line", station: parts[0] }; }
function sqliteProfile(db) { db.exec("PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE; PRAGMA encoding='UTF-8'; PRAGMA foreign_keys=OFF;"); }
function finishSqlite(db) { db.exec("PRAGMA user_version=18; VACUUM;"); }
async function normalizeHeader(file) { const value = await readFile(file); value.writeUInt32BE(3053000, 96); await writeFile(file, value); }
function project(source, target, table, columns, order) { const insert = target.prepare(`INSERT INTO ${quote(table)} VALUES(${columns.map(() => "?").join(",")})`); const sql = `SELECT ${columns.map(quote).join(",")} FROM ${quote(table)} ORDER BY ${order.map((column) => `${quote(column)} COLLATE BINARY`).join(",")}`; target.exec("BEGIN"); try { for (const row of source.prepare(sql).all()) insert.run(...columns.map((column) => row[column])); target.exec("COMMIT"); } catch (error) { target.exec("ROLLBACK"); throw error; } }
function stationSetDigest(db) { return sha(Buffer.from(canonicalJson([...new Set(db.prepare("SELECT id FROM stations ORDER BY id COLLATE BINARY").all().map((row) => row.id))].sort(bytes)))); }
async function inventory(root, expected) { const payload = path.join(root, "payload"); const entries = []; for (const name of await readdir(payload)) { const file = path.join(payload, name); const stat = await lstat(file); const relative = `payload/${name}`; if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || !expected.has(relative)) throw new Error("payload has unknown or invalid file"); const value = await readFile(file); entries.push({ path: relative, sizeBytes: value.length, sha256: sha(value) }); } if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry.path))) throw new Error("payload paths mismatch"); return sha(Buffer.from(canonicalJson(entries.sort((a, b) => bytes(a.path, b.path))))); }
async function validateOutput(root) { const children = (await readdir(root)).sort(bytes); if (canonicalJson(children) !== canonicalJson([...EXPECTED_CHILDREN].sort(bytes))) throw new Error("output children mismatch"); for (const [artifact, files] of [["map-pack", new Set(["manifest.json", "payload/metropolitan.svg", "payload/stations-layout.json", "payload/line-styles.json", "payload/interchange-layout.json"])], ["station-catalog-pack", new Set(["manifest.json", "payload/catalog.sqlite"])], ["server-route-bundle", new Set(["manifest.signing-input.json", "provenance.json", "compatibility.json", "payload/topology.sqlite.zst", "payload/timetable.sqlite.zst", "payload/accessibility.sqlite.zst", "payload/fare.sqlite.zst"])]] ) { const actual = new Set(); await collectFiles(path.join(root, artifact), path.join(root, artifact), actual); if (actual.size !== files.size || [...actual].some((file) => !files.has(file))) throw new Error("unknown artifact output"); } }
async function collectFiles(root, current, output) { for (const entry of await readdir(current, { withFileTypes: true })) { const target = path.join(current, entry.name); if (entry.isDirectory()) await collectFiles(root, target, output); else if (entry.isFile() && !entry.isSymbolicLink()) output.add(path.relative(root, target).split(path.sep).join("/")); else throw new Error("artifact output must be regular files"); } }
function validateInputBinding(provenance, current, currentHash, sourceHash, buildSpecHash) { if (provenance?.schemaVersion !== 1 || provenance.artifactKind !== "datapack-field-provenance" || provenance.manifestSha256 !== currentHash) throw new Error("source provenance does not bind raw current.json"); for (const packs of [current?.packs, provenance?.packs]) { if (!Array.isArray(packs)) throw new Error("source pack identities are required"); const matching = packs.filter((pack) => pack?.id === "capital" && pack?.artifactKind === "production"); if (matching.length !== 1 || matching[0].sqliteSha256 !== sourceHash) throw new Error("source pack identity mismatch"); } if (!provenance?.candidateBuild || typeof provenance.candidateBuild !== "object" || Array.isArray(provenance.candidateBuild) || provenance.candidateBuild.buildSpecSha256 !== buildSpecHash) throw new Error("build spec identity mismatch"); }
function parseJson(bytes, label) { try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error(`${label} must be JSON`); } }
function requiredInstant(value, label) { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an instant`); return Date.parse(value); }
function tupleCompare(a, b, fields) { for (const field of fields) { const result = bytes(a[field], b[field]); if (result) return result; } return 0; }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function bytes(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
function quote(value) { return `"${String(value).replaceAll('"', '""')}"`; }
function required(value, label) { if (typeof value !== "string" || !value) throw new Error(`${label} is required`); return value; }
function raw(value, label) { value = required(value, label); if (value.trim() !== value) throw new Error(`${label} must be raw`); return value; }
function exact(value, expected, label) { if (value !== expected) throw new Error(`${label} must be ${expected}`); return value; }
function positive(value) { value = Number(value); if (!Number.isSafeInteger(value) || value < 1) throw new Error("--release-sequence must be positive safe integer"); return value; }
function kst(value, label) { value = raw(value, label); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+09:00$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be KST milliseconds`); return value; }
function utc(value, label) { value = raw(value, label); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be UTC milliseconds`); return value; }
async function regular(value, label) { const target = path.resolve(required(value, label)); const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`); return target; }
async function exists(target) { try { await lstat(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function readJson(target) { return parseJson(await readFile(target), target); }
async function json(target, value) { await writeFile(target, Buffer.from(canonicalJson(value))); }
function parse(argv) { if (argv.length !== CLI_ARGS.size * 2) throw new Error("exactly the required arguments are required"); const values = {}; for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || !CLI_ARGS.has(key.slice(2)) || Object.hasOwn(values, key.slice(2))) throw new Error("invalid arguments"); values[key.slice(2)] = value; } return values; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) emitArtifactComponents(Object.fromEntries(Object.entries(parse(process.argv.slice(2))).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]))).catch((error) => { process.stderr.write(`emit-artifact-components: ${error.message}\n`); process.exitCode = 1; });
