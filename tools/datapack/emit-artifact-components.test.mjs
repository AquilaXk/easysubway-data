import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { emitArtifactComponents } from "./emit-artifact-components.mjs";

test("materialized SQLite에서 keyless 세 artifact를 deterministic하게 emit한다", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "artifact-emitter-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const fixtureRoot = path.join(temp, "repository");
  for (const relative of ["contracts/datapack", "tools/datapack/release", "tools/datapack/schema", "tools/datapack/source-governance-policy.json", "tools/datapack/source-inventory.json", "release/product-gates/datapack-freshness-sla.json", "tools/route-map/basemap-build-manifest.json", "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v4.svg"]) await cp(relative, path.join(fixtureRoot, relative), { recursive: true });
  const source = path.join(temp, "source.sqlite");
  const db = new DatabaseSync(source);
  db.exec(await readFile(path.join(fixtureRoot, "tools/datapack/schema/catalog-schema.sql"), "utf8"));
  db.exec("INSERT INTO operators VALUES('o1','운영사','Operator'); INSERT INTO lines(id,operator_id,name_ko,name_en,color) VALUES('l1','o1','1호선','Line 1','#123456'); INSERT INTO stations(id,name_ko,name_en,normalized_name,region) VALUES('s1','가역','Ga','가역','수도권'),('s2','나역','Na','나역','수도권'); INSERT INTO station_aliases(station_id,alias,normalized_alias) VALUES('s1','가','가'); INSERT INTO station_lines(station_id,line_id,line_sequence) VALUES('s1','l1',1),('s2','l1',2); INSERT INTO station_pathway_nodes(id,station_id,line_id,node_type,label) VALUES('path-null','s1',NULL,'CONCOURSE','대합실'); INSERT INTO route_map_positions(station_id,line_id,region,x,y,label_dx,label_dy,label_polygon,up_path,down_path,source_id,source_name,source_url,license,license_status) VALUES('s1','l1','수도권',1,2,0,0,'raw polygon','','','source','source','https://example.test','license','PASS'),('s2','l1','수도권',3,4,0,0,'raw polygon','','','source','source','https://example.test','license','PASS'); INSERT INTO route_map_line_tracks(region,line_id,track_index,path,svg_color,source_id,source_name,source_url,license,license_status) VALUES('수도권','l1',1,'M0','#123456','source','source','https://example.test','license','PASS');");
  db.close();
  const current = { packs: [{ id: "capital", artifactKind: "production", sqliteSha256: hash(await readFile(source)) }], expiresAt: "2026-08-03T15:00:00.000Z" };
  await writeFile(path.join(temp, "current.json"), canonicalJson(current));
  const spec = await readFile(path.join(fixtureRoot, "tools/datapack/release/candidate-build-spec.json"));
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: hash(Buffer.from(canonicalJson(current))), packs: current.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
  const run = (name, values = {}) => emitArtifactComponents({ repositoryRoot: fixtureRoot, sourceSqlite: source, sourceProvenance: path.join(temp, "current.provenance.json"), buildSpec: "tools/datapack/release/candidate-build-spec.json", output: path.join(temp, name), mapPackId: "map-v1", catalogPackId: "catalog-v1", bundleId: "bundle-v1", releaseSequence: "1", activeFrom: "2026-08-03T00:00:00.000+09:00", freshUntil: "2026-08-04T00:00:00.000+09:00", builtAt: "2026-08-03T00:00:00.000Z", keyId: "test-key", ...values });
  await run("one"); await run("two"); await run("three");
  const paths = await emittedPaths(path.join(temp, "one"));
  assert.deepEqual(paths, ["map-pack/manifest.json", "map-pack/payload/interchange-layout.json", "map-pack/payload/line-styles.json", "map-pack/payload/metropolitan.svg", "map-pack/payload/stations-layout.json", "server-route-bundle/compatibility.json", "server-route-bundle/manifest.signing-input.json", "server-route-bundle/payload/accessibility.sqlite.zst", "server-route-bundle/payload/fare.sqlite.zst", "server-route-bundle/payload/timetable.sqlite.zst", "server-route-bundle/payload/topology.sqlite.zst", "server-route-bundle/provenance.json", "station-catalog-pack/manifest.json", "station-catalog-pack/payload/catalog.sqlite"]);
  assert.deepEqual(await emittedPaths(path.join(temp, "two")), paths);
  assert.deepEqual(await emittedPaths(path.join(temp, "three")), paths);
  for (const file of paths) {
    assert.deepEqual(await readFile(path.join(temp, "one", file)), await readFile(path.join(temp, "two", file)), `two: ${file}`);
    assert.deepEqual(await readFile(path.join(temp, "one", file)), await readFile(path.join(temp, "three", file)), `three: ${file}`);
  }
  assert.deepEqual((await readdir(path.join(temp, "one"))).sort(), ["map-pack", "server-route-bundle", "station-catalog-pack"]);
  const mapRoot = path.join(temp, "one", "map-pack");
  const mapManifest = JSON.parse(await readFile(path.join(mapRoot, "manifest.json"), "utf8"));
  assert.equal(mapManifest.payloadSha256, await payloadDigest(mapRoot));
  assert.deepEqual(JSON.parse(await readFile(path.join(mapRoot, "payload/stations-layout.json"), "utf8")), [
    { stationId: "s1", lineId: "l1", region: "수도권", x: 1, y: 2, labelDx: 0, labelDy: 0, labelPolygon: "raw polygon", upPath: "", downPath: "" },
    { stationId: "s2", lineId: "l1", region: "수도권", x: 3, y: 4, labelDx: 0, labelDy: 0, labelPolygon: "raw polygon", upPath: "", downPath: "" },
  ]);
  assert.deepEqual(JSON.parse(await readFile(path.join(mapRoot, "payload/line-styles.json"), "utf8")), [{ lineId: "l1", color: "#123456" }]);
  assert.deepEqual(JSON.parse(await readFile(path.join(mapRoot, "payload/interchange-layout.json"), "utf8")), []);
  const catalogRoot = path.join(temp, "one", "station-catalog-pack");
  const catalogManifest = JSON.parse(await readFile(path.join(catalogRoot, "manifest.json"), "utf8"));
  assert.equal(catalogManifest.payloadSha256, await payloadDigest(catalogRoot));
  const catalog = new DatabaseSync(path.join(catalogRoot, "payload/catalog.sqlite"), { readOnly: true });
  assert.deepEqual(catalog.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name COLLATE BINARY").all().map((row) => row.name), ["lines", "station_aliases", "station_lines", "station_search_index", "stations"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(stations)").all().map((column) => column.name), ["id", "name_ko", "name_en", "name_sub", "normalized_name", "region"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(station_aliases)").all().map((column) => column.name), ["station_id", "alias", "normalized_alias"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(lines)").all().map((column) => column.name), ["id", "name_ko", "name_en"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(station_lines)").all().map((column) => column.name), ["station_id", "line_id", "station_code", "line_sequence"]);
  assert.deepEqual(catalog.prepare("PRAGMA table_info(station_search_index)").all().map((column) => column.name), ["station_id", "token", "normalized_token", "source_kind"]);
  assert.deepEqual(catalog.prepare("SELECT id,name_ko,name_en,name_sub,normalized_name,region FROM stations ORDER BY id").all().map((row) => ({ ...row })), [{ id: "s1", name_ko: "가역", name_en: "Ga", name_sub: "", normalized_name: "가역", region: "수도권" }, { id: "s2", name_ko: "나역", name_en: "Na", name_sub: "", normalized_name: "나역", region: "수도권" }]);
  assert.deepEqual(catalog.prepare("SELECT station_id,token,normalized_token,source_kind FROM station_search_index ORDER BY station_id,source_kind,normalized_token,token").all().map((row) => ({ ...row })), [{ station_id: "s1", token: "가", normalized_token: "가", source_kind: "STATION_ALIAS" }, { station_id: "s1", token: "가역", normalized_token: "가역", source_kind: "STATION_NAME" }, { station_id: "s2", token: "나역", normalized_token: "나역", source_kind: "STATION_NAME" }]);
  assert.equal(catalog.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('network_edges','transit_routes','transfer_rules','station_exits','fare_rules','operators')").all().length, 0);
  assert.equal(catalog.prepare("SELECT count(*) AS count FROM pragma_table_info('lines') WHERE name IN ('operator_id','color')").get().count, 0);
  catalog.close();
  const signingInput = JSON.parse(await readFile(path.join(temp, "one", "server-route-bundle/manifest.signing-input.json"), "utf8"));
  assert.equal(signingInput.payloadSha256, await payloadDigest(path.join(temp, "one", "server-route-bundle")));
  const buildContract = JSON.parse(await readFile(path.join(fixtureRoot, "contracts/datapack/server-route-bundle-build-contract.json"), "utf8"));
  for (const metadata of ["provenance", "compatibility"]) {
    const value = JSON.parse(await readFile(path.join(temp, "one", `server-route-bundle/${metadata}.json`), "utf8"));
    assert.deepEqual(Object.keys(value).sort(), [...buildContract.metadata[metadata].exactFields].sort());
  }
  assert.equal(signingInput.provenanceSha256, hash(await readFile(path.join(temp, "one", "server-route-bundle/provenance.json"))));
  assert.equal(signingInput.compatibilitySha256, hash(await readFile(path.join(temp, "one", "server-route-bundle/compatibility.json"))));
  for (const component of ["topology", "timetable", "accessibility", "fare"]) assert.equal(signingInput[`${component}Sha256`], hash(await readFile(path.join(temp, "one", `server-route-bundle/payload/${component}.sqlite.zst`))));
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  for (const component of ["topology", "timetable", "accessibility", "fare"]) {
    const sqlite = path.join(temp, `${component}.sqlite`);
    await writeFile(sqlite, zstdDecompressSync(await readFile(path.join(temp, "one", `server-route-bundle/payload/${component}.sqlite.zst`))));
    const componentDb = new DatabaseSync(sqlite, { readOnly: true });
    assert.equal(componentDb.prepare("PRAGMA user_version").get().user_version, 18);
    assert.deepEqual(componentDb.prepare("SELECT * FROM artifact_component_identity").all().map((row) => ({ ...row })), [{ bundleId: "bundle-v1", releaseSequence: 1, stationSetSha256: signingInput.stationSetSha256, serviceTimezone: "Asia/Seoul" }]);
    assert.deepEqual(componentDb.prepare("PRAGMA table_info(stations)").all().map((column) => column.name), ["id"]);
    assert.deepEqual(componentDb.prepare("PRAGMA table_info(lines)").all().map((column) => column.name), ["id"]);
    assert.deepEqual(componentDb.prepare("PRAGMA table_info(station_lines)").all().map((column) => column.name), ["station_id", "line_id", "line_sequence"]);
    assert.equal(componentDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('route_map_positions','station_aliases','station_search_index')").all().length, 0);
    assert.deepEqual(componentDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all(), []);
    for (const table of ["stations", "station_lines"]) {
      assert.deepEqual(tablePrimaryKey(componentDb, table), tablePrimaryKey(sourceDb, table));
      assert.deepEqual(groupedForeignKeys(componentDb, table), groupedForeignKeys(sourceDb, table));
    }
    componentDb.close();
    assert.equal((await readFile(sqlite)).readUInt32BE(96), 3053000);
  }
  sourceDb.close();
  assert.equal(await exists(path.join(temp, "one", "server-route-bundle/manifest.json")), false);
  const allBytes = Buffer.concat(await Promise.all(paths.map((file) => readFile(path.join(temp, "one", file))))).toString("utf8");
  assert.doesNotMatch(allBytes, /"signature"|"probe"/);

  await assert.rejects(() => run("late", { freshUntil: "2026-08-04T00:00:00.001+09:00" }), /source freshness/);
  assert.equal(await exists(path.join(temp, "late")), false);

  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: "0".repeat(64), packs: current.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
  await assert.rejects(() => run("rejected"), /raw current\.json/);
  assert.equal(await exists(path.join(temp, "rejected")), false);

  await writeBindings(temp, source, current, spec);
  const provenance = JSON.parse(await readFile(path.join(temp, "current.provenance.json"), "utf8"));
  provenance.packs[0].sqliteSha256 = "0".repeat(64);
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson(provenance));
  await assert.rejects(() => run("bad-provenance"), /source pack identity/);
  assert.equal(await exists(path.join(temp, "bad-provenance")), false);

  const missingPack = { ...current, packs: [] };
  await writeFile(path.join(temp, "current.json"), canonicalJson(missingPack));
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: hash(Buffer.from(canonicalJson(missingPack))), packs: current.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
  await assert.rejects(() => run("missing-pack"), /source pack identity/);
  assert.equal(await exists(path.join(temp, "missing-pack")), false);

  const duplicatePack = { ...current, packs: [...current.packs, { ...current.packs[0] }] };
  await writeFile(path.join(temp, "current.json"), canonicalJson(duplicatePack));
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: hash(Buffer.from(canonicalJson(duplicatePack))), packs: duplicatePack.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
  await assert.rejects(() => run("duplicate-pack"), /source pack identity/);
  assert.equal(await exists(path.join(temp, "duplicate-pack")), false);

  const mutate = (sql) => { const mutation = new DatabaseSync(source); mutation.exec("PRAGMA foreign_keys=OFF; " + sql); mutation.close(); };
  mutate("PRAGMA user_version=17");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("bad-version"), /user_version/);
  assert.equal(await exists(path.join(temp, "bad-version")), false);
  mutate("PRAGMA user_version=18");

  mutate("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type,facility_id) VALUES('cross-component','s1','s1:l1','WALKWAY','missing-facility')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("bad-cross-component"), /cross-component reference mismatch/);
  assert.equal(await exists(path.join(temp, "bad-cross-component")), false);
  mutate("DELETE FROM network_edges WHERE id='cross-component'");

  mutate("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type) VALUES('unknown-walkway','','s1','WALKWAY')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("bad-endpoint"), /invalid network endpoint/);
  assert.equal(await exists(path.join(temp, "bad-endpoint")), false);
  mutate("DELETE FROM network_edges WHERE id='unknown-walkway'");

  mutate("INSERT INTO network_edges(id,from_node_id,to_node_id,edge_type) VALUES('reversed-entry','s1:l1','s1','ENTRY')");
  await writeBindings(temp, source, current, spec);
  await assert.rejects(() => run("reversed-entry"), /network edge endpoint mismatch/);
  assert.equal(await exists(path.join(temp, "reversed-entry")), false);
  mutate("DELETE FROM network_edges WHERE id='reversed-entry'");

  const occupied = path.join(temp, "occupied");
  await writeFile(occupied, "marker");
  const beforeTemps = await taskTemps(temp);
  await assert.rejects(() => run("occupied"), /must not already exist/);
  assert.equal(await readFile(occupied, "utf8"), "marker");
  assert.deepEqual(await taskTemps(temp), beforeTemps);
});

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function payloadDigest(artifact) {
  const payload = path.join(artifact, "payload");
  const inventory = [];
  for (const name of await readdir(payload)) {
    const bytes = await readFile(path.join(payload, name));
    inventory.push({ path: `payload/${name}`, sizeBytes: bytes.length, sha256: hash(bytes) });
  }
  return hash(Buffer.from(canonicalJson(inventory.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))))));
}
async function writeBindings(temp, source, current, spec) {
  const sourceHash = hash(await readFile(source));
  const bound = { ...current, packs: current.packs.map((pack) => ({ ...pack, sqliteSha256: sourceHash })) };
  await writeFile(path.join(temp, "current.json"), canonicalJson(bound));
  await writeFile(path.join(temp, "current.provenance.json"), canonicalJson({ schemaVersion: 1, artifactKind: "datapack-field-provenance", manifestSha256: hash(Buffer.from(canonicalJson(bound))), packs: bound.packs, candidateBuild: { buildSpecSha256: hash(spec) } }));
}
function tablePrimaryKey(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all().filter((column) => column.pk).map((column) => ({ name: column.name, pk: column.pk })); }
function groupedForeignKeys(db, table) { const groups = new Map(); for (const row of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) { const value = groups.get(row.id) ?? { table: row.table, from: [], to: [], onUpdate: row.on_update, onDelete: row.on_delete, match: row.match }; value.from[row.seq] = row.from; value.to[row.seq] = row.to; groups.set(row.id, value); } return [...groups.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); }
async function taskTemps(temp) { return (await readdir(temp)).filter((entry) => entry.startsWith(".artifact-components-")).sort(); }
async function exists(target) { try { await readFile(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function emittedPaths(root, current = root, paths = []) { for (const entry of await readdir(current, { withFileTypes: true })) { const target = path.join(current, entry.name); if (entry.isDirectory()) await emittedPaths(root, target, paths); else paths.push(path.relative(root, target).split(path.sep).join("/")); } return paths.sort(); }
