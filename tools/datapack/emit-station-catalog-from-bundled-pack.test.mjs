import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const mobile = path.resolve(root, "../easysubway-mobile");
const revision = "d85742f14cbf97c526a6b94dd55bbf863e1d1346";
const gzipSha256 = "f328fbedff014be18a0e8341e0bdbfe9b0dd774fa7e9ae7692aa869e831707b3";
const catalogPackId = "capital-station-catalog-d85742f14cbf97c526a6b94dd55bbf863e1d1346-v1";

function sha(value) { return createHash("sha256").update(value).digest("hex"); }

test("exact d857 bundled pack station projection은 deterministic catalog artifact를 emit한다", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "bundled-station-catalog-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const pack = path.join(temp, "capital.sqlite.gz");
  const outputA = path.join(temp, "a");
  const outputB = path.join(temp, "b");
  const { stdout } = await execFileAsync("git", ["-C", mobile, "show", `${revision}:apps/mobile/assets/datapacks/capital.sqlite.gz`], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  await (await import("node:fs/promises")).writeFile(pack, stdout);
  assert.equal(sha(stdout), gzipSha256);
  for (const output of [outputA, outputB]) await execFileAsync(process.execPath, [
    "tools/datapack/emit-station-catalog-from-bundled-pack.mjs", "--input", pack,
    "--output", output,
  ], { cwd: root });
  for (const file of ["manifest.json", "payload/catalog.sqlite"]) {
    assert.deepEqual(await readFile(path.join(outputA, file)), await readFile(path.join(outputB, file)), file);
  }
  const manifest = JSON.parse(await readFile(path.join(outputA, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["artifactKind", "catalogPackId", "manifestVersion", "payloadSha256", "stationSetSha256"]);
  assert.equal(manifest.catalogPackId, catalogPackId);
  const db = new DatabaseSync(path.join(outputA, "payload/catalog.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(db.prepare("SELECT count(*) AS count FROM stations").get().count > 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('network_edges','fare_rules')").get().count, 0);
  } finally { db.close(); }
});
