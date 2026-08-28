import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { emitStationCatalogPack } from "./emit-station-catalog-pack.mjs";

test("capital production canonical fixture에서 deterministic한 station catalog만 emit한다", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "station-catalog-pack-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repository");
  await cp("tools/datapack/release/capital-production-canonical-pack.json", path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), { recursive: true });
  const run = (output, values = {}) => emitStationCatalogPack({ repositoryRoot: root, output: path.join(temp, output), catalogPackId: "catalog-v1", ...values });

  for (const name of ["node", "sqlite"]) {
    const version = Object.getOwnPropertyDescriptor(process.versions, name);
    Object.defineProperty(process.versions, name, { ...version, value: "0.0.0" });
    try { await rejectsWithoutTemp(temp, () => run(`wrong-${name}-runtime`), /runtime must be Node 24\.19\.0 with SQLite 3\.53\.4/); }
    finally { Object.defineProperty(process.versions, name, version); }
    assert.equal(await exists(path.join(temp, `wrong-${name}-runtime`)), false);
  }

  await run("one");
  await run("two");
  const paths = await files(path.join(temp, "one"));
  assert.deepEqual(paths, ["manifest.json", "payload/catalog.sqlite"]);
  assert.deepEqual(await files(path.join(temp, "two")), paths);
  for (const file of paths) assert.deepEqual(await readFile(path.join(temp, "one", file)), await readFile(path.join(temp, "two", file)), file);
  const manifest = JSON.parse(await readFile(path.join(temp, "one/manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["artifactKind", "catalogPackId", "manifestVersion", "payloadSha256", "stationSetSha256"]);
  assert.equal(manifest.catalogPackId, "catalog-v1");
  assert.equal(manifest.payloadSha256, await payloadDigest(path.join(temp, "one")));
  const input = JSON.parse(await readFile(path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"), "utf8"));
  const capital = input.packs.find((pack) => pack.id === "capital" && pack.artifactKind === "production");
  const stationIds = [...new Set(capital.stations.map((station) => station.id))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.equal(manifest.stationSetSha256, hash(Buffer.from(canonicalJson(stationIds))));
  const sqlite = await readFile(path.join(temp, "one/payload/catalog.sqlite"));
  assert.equal(sqlite.readUInt32BE(96), 3053004);
  const db = new DatabaseSync(path.join(temp, "one/payload/catalog.sqlite"), { readOnly: true });
  assert.equal(db.prepare("PRAGMA page_size").get().page_size, 4096);
  assert.equal(db.prepare("PRAGMA auto_vacuum").get().auto_vacuum, 0);
  assert.equal(db.prepare("PRAGMA encoding").get().encoding, "UTF-8");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 18);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name COLLATE BINARY").all().map((row) => row.name), ["lines", "station_aliases", "station_lines", "station_search_index", "stations"]);
  assert.deepEqual(tableInfo(db, "stations"), [["id", "TEXT", 1, null, 1], ["name_ko", "TEXT", 1, null, 0], ["name_en", "TEXT", 1, "''", 0], ["name_sub", "TEXT", 1, "''", 0], ["normalized_name", "TEXT", 1, null, 0], ["region", "TEXT", 1, "''", 0]]);
  assert.deepEqual(tableInfo(db, "station_aliases"), [["station_id", "TEXT", 1, null, 0], ["alias", "TEXT", 1, null, 0], ["normalized_alias", "TEXT", 1, null, 0]]);
  assert.deepEqual(tableInfo(db, "lines"), [["id", "TEXT", 1, null, 1], ["name_ko", "TEXT", 1, null, 0], ["name_en", "TEXT", 1, "''", 0]]);
  assert.deepEqual(tableInfo(db, "station_lines"), [["station_id", "TEXT", 1, null, 1], ["line_id", "TEXT", 1, null, 2], ["station_code", "TEXT", 1, "''", 0], ["line_sequence", "INTEGER", 1, null, 0]]);
  assert.deepEqual(tableInfo(db, "station_search_index"), [["station_id", "TEXT", 1, null, 1], ["token", "TEXT", 1, null, 4], ["normalized_token", "TEXT", 1, null, 3], ["source_kind", "TEXT", 1, null, 2]]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(tableRows(db, "stations", ["id", "name_ko", "name_en", "name_sub", "normalized_name", "region"], ["id"]), expectedRows(capital, "stations"));
  assert.deepEqual(tableRows(db, "station_aliases", ["station_id", "alias", "normalized_alias"], ["station_id", "alias", "normalized_alias"]), expectedRows(capital, "station_aliases"));
  assert.deepEqual(tableRows(db, "lines", ["id", "name_ko", "name_en"], ["id"]), expectedRows(capital, "lines"));
  assert.deepEqual(tableRows(db, "station_lines", ["station_id", "line_id", "station_code", "line_sequence"], ["station_id", "line_id", "station_code", "line_sequence"]), expectedRows(capital, "station_lines"));
  assert.deepEqual(tableRows(db, "station_search_index", ["station_id", "token", "normalized_token", "source_kind"], ["station_id", "source_kind", "normalized_token", "token"]), expectedRows(capital, "station_search_index"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('network_edges','transit_routes','station_exits','fare_rules')").get().count, 0);
  db.close();

  await rejectsWithoutTemp(temp, () => run("one"), /must not already exist/);
  await rejectsWithoutTemp(temp, () => run("missing-parent/output"), /--output parent must be an existing directory/);
  await writeFile(path.join(temp, "not-a-directory"), "file");
  await rejectsWithoutTemp(temp, () => run("not-a-directory/output"), /--output parent must be an existing directory/);
  await rejectsWithoutTemp(temp, () => run("wrong", { catalogPackId: " bad" }), /must be raw/);
  await rejectsWithoutTemp(temp, () => emitStationCatalogPack({ repositoryRoot: root, output: path.join(temp, "wrong-input"), catalogPackId: "catalog", input: "fixture.json" }), /must be tools\/datapack\/release\/capital-production-canonical-pack\.json/);

  const late = path.join(temp, "late-output");
  await mkdir(late);
  await rejectsWithoutTemp(temp, () => run("late-output"), /must not already exist/);
  assert.equal(await exists(late), true);
  assert.deepEqual(await readdir(late), []);
});

test("projection row의 누락·unknown·dangling 값은 output 없이 fail closed한다", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "station-catalog-pack-invalid-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repository");
  const fixture = { manifest: {}, packs: [{ id: "capital", artifactKind: "production", stations: [{ id: "s", nameKo: "역", nameEn: "", nameSub: "", normalizedName: "역", region: "수도권" }], stationAliases: [], lines: [{ id: "l", nameKo: "선", nameEn: "" }], stationLines: [{ stationId: "s", lineId: "l", stationCode: "", lineSequence: 1 }] }], migrationSourceArtifact: {} };
  const input = path.join(root, "tools/datapack/release/capital-production-canonical-pack.json");
  await mkdir(path.dirname(input), { recursive: true });
  const write = async (value) => writeFile(input, canonicalJson(value));
  const run = (output) => emitStationCatalogPack({ repositoryRoot: root, output: path.join(temp, output), catalogPackId: "catalog" });
  await write(fixture);
  await run("valid");
  const fixtureWithoutNameSub = structuredClone(fixture);
  delete fixtureWithoutNameSub.packs[0].stations[0].nameSub;
  await write(fixtureWithoutNameSub);
  await run("missing-name-sub");
  const missingNameSubDb = new DatabaseSync(path.join(temp, "missing-name-sub/payload/catalog.sqlite"), { readOnly: true });
  assert.equal(missingNameSubDb.prepare("SELECT name_sub FROM stations WHERE id = 's'").get().name_sub, "");
  missingNameSubDb.close();
  const provenance = {
    sourceId: "incheon-transit-station-info",
    sourceSnapshotId: "incheon-transit-station-info-20260828",
    providerRecordHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    derivationKind: "OFFICIAL",
    lastVerifiedAt: "2026-08-28T04:30:44.000Z",
  };
  const fixtureWithProvenance = structuredClone(fixture);
  Object.assign(fixtureWithProvenance.packs[0].stations[0], provenance);
  Object.assign(fixtureWithProvenance.packs[0].stationLines[0], provenance);
  await write(fixtureWithProvenance);
  await run("valid-provenance");
  assert.deepEqual(
    await readFile(path.join(temp, "valid/payload/catalog.sqlite")),
    await readFile(path.join(temp, "valid-provenance/payload/catalog.sqlite")),
  );
  for (const [name, mutate, message] of [
    ["missing", (value) => delete value.packs[0].stations[0].region, /projection row keys/],
    ["unknown", (value) => { value.packs[0].stationAliases = [{ stationId: "s", alias: "별칭", normalizedAlias: "별칭", extra: true }]; }, /projection row keys/],
    ["invalid-name-sub", (value) => { value.packs[0].stations[0].nameSub = 1; }, /projection row types/],
    ["station-partial-provenance", (value) => { value.packs[0].stations[0].sourceId = provenance.sourceId; }, /provenance keys/],
    ["station-line-standalone-last-verified", (value) => { value.packs[0].stationLines[0].lastVerifiedAt = provenance.lastVerifiedAt; }, /provenance keys/],
    ["station-line-invalid-provenance", (value) => { Object.assign(value.packs[0].stationLines[0], { ...provenance, evidenceHash: "B".repeat(64) }); }, /provenance values/],
    ["dangling", (value) => { value.packs[0].stationLines[0].stationId = "missing"; }, /foreign key mismatch/],
    ["duplicate-station", (value) => value.packs[0].stations.push({ ...value.packs[0].stations[0] }), /stations duplicate key/],
    ["duplicate-line", (value) => value.packs[0].lines.push({ ...value.packs[0].lines[0] }), /lines duplicate key/],
    ["invalid-type", (value) => { value.packs[0].stations[0].nameKo = 1; }, /projection row types/],
    ["invalid-sequence", (value) => { value.packs[0].stationLines[0].lineSequence = 0; }, /projection row types/],
    ["missing-capital", (value) => { value.packs[0].id = "other"; }, /capital production pack/],
  ]) {
    const value = structuredClone(fixture); mutate(value); await write(value);
    await rejectsWithoutTemp(temp, () => run(name), message);
    assert.equal(await exists(path.join(temp, name)), false, name);
  }
  await rm(input);
  await rejectsWithoutTemp(temp, () => run("missing-input"), /must be a regular file/);
  const target = path.join(root, "source.json");
  await writeFile(target, canonicalJson(fixture));
  await symlink(target, input);
  await rejectsWithoutTemp(temp, () => run("symlink-input"), /must be a regular file/);

  const escapedRoot = path.join(temp, "escaped-root");
  const external = path.join(temp, "external-datapack");
  await mkdir(path.join(escapedRoot, "tools"), { recursive: true });
  await mkdir(path.join(external, "release"), { recursive: true });
  await writeFile(path.join(external, "release/capital-production-canonical-pack.json"), canonicalJson(fixture));
  await symlink(external, path.join(escapedRoot, "tools/datapack"));
  await rejectsWithoutTemp(temp, () => emitStationCatalogPack({ repositoryRoot: escapedRoot, output: path.join(temp, "ancestor-symlink"), catalogPackId: "catalog" }), /must resolve under repository root/);
});

async function files(root, current = root, output = []) { for (const entry of await readdir(current, { withFileTypes: true })) { const target = path.join(current, entry.name); if (entry.isDirectory()) await files(root, target, output); else output.push(path.relative(root, target).split(path.sep).join("/")); } return output.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); }
async function payloadDigest(root) { const bytes = await readFile(path.join(root, "payload/catalog.sqlite")); return hash(Buffer.from(canonicalJson([{ path: "payload/catalog.sqlite", sizeBytes: bytes.length, sha256: hash(bytes) }]))); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
async function exists(target) { try { await lstat(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function assertNoTempArtifacts(parent) { assert.deepEqual((await readdir(parent)).filter((name) => name.startsWith(".station-catalog-pack-")), []); }
async function rejectsWithoutTemp(parent, operation, expected) { await assert.rejects(operation, expected); await assertNoTempArtifacts(parent); }
function tableInfo(db, table) { return db.prepare(`PRAGMA table_xinfo(${table})`).all().map((column) => [column.name, column.type, column.notnull, column.dflt_value, column.pk]); }
function tableRows(db, table, columns, order) { return db.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY ${order.map((column) => `${column} COLLATE BINARY`).join(",")}`).all().map((row) => ({ ...row })); }
function expectedRows(pack, table) {
  const mappings = {
    stations: ["stations", [["id", "id"], ["nameKo", "name_ko"], ["nameEn", "name_en"], ["nameSub", "name_sub"], ["normalizedName", "normalized_name"], ["region", "region"]], ["id"]],
    station_aliases: ["stationAliases", [["stationId", "station_id"], ["alias", "alias"], ["normalizedAlias", "normalized_alias"]], ["station_id", "alias", "normalized_alias"]],
    lines: ["lines", [["id", "id"], ["nameKo", "name_ko"], ["nameEn", "name_en"]], ["id"]],
    station_lines: ["stationLines", [["stationId", "station_id"], ["lineId", "line_id"], ["stationCode", "station_code"], ["lineSequence", "line_sequence"]], ["station_id", "line_id", "station_code", "line_sequence"]],
  };
  if (table === "station_search_index") return sortRows([
    ...pack.stations.map((station) => ({ station_id: station.id, token: station.nameKo, normalized_token: station.normalizedName, source_kind: "STATION_NAME" })),
    ...pack.stationAliases.map((alias) => ({ station_id: alias.stationId, token: alias.alias, normalized_token: alias.normalizedAlias, source_kind: "STATION_ALIAS" })),
  ], ["station_id", "source_kind", "normalized_token", "token"]);
  const [source, fields, order] = mappings[table];
  return sortRows(pack[source].map((row) => Object.fromEntries(fields.map(([from, to]) => [to, from === "nameSub" ? row[from] ?? "" : row[from]]))), order);
}
function sortRows(rows, fields) { return [...rows].sort((left, right) => { for (const field of fields) { const result = Buffer.compare(Buffer.from(String(left[field])), Buffer.from(String(right[field]))); if (result) return result; } return 0; }); }
