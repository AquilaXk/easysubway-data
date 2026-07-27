import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  ...process.env,
  EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }),
};
const verifierEnv = { ...process.env };
delete verifierEnv.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;

test("production build와 bundled asset/index의 artifact identity를 exact-match한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-production-pack-identity-"));
  const baselineDir = path.join(workspace, "baseline");
  const assetPath = path.join(workspace, "capital.sqlite.gz");
  const indexPath = path.join(workspace, "index.json");
  try {
    await execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--build-spec", "tools/datapack/release/candidate-build-spec.json",
      "--output", baselineDir,
    ], { cwd: root, env });
    const manifest = JSON.parse(await readFile(path.join(baselineDir, "current.json"), "utf8"));
    const pack = manifest.packs.find(({ id }) => id === "capital");
    await copyFile(path.join(baselineDir, "catalog/capital-v1.sqlite.gz"), assetPath);
    const gzipBytes = await readFile(assetPath);
    assert.equal(gzipBytes[9], 255);
    const sqliteBytes = gunzipSync(gzipBytes);
    assert.equal(sqliteBytes.readUInt32BE(96), 3_053_000);
    const sqlitePath = path.join(workspace, "capital.sqlite");
    await writeFile(sqlitePath, sqliteBytes);
    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      assert.deepEqual(database.prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'sqlite_stat%' ORDER BY name",
      ).all(), []);
    } finally {
      database.close();
    }
    await writeFile(indexPath, `${JSON.stringify({ packs: [{
      id: "capital",
      sha256: pack.sha256,
      sqliteSha256: pack.sqliteSha256,
      byteSize: pack.sizeBytes,
    }] })}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      "tools/datapack/verify-production-pack-artifact-identity.mjs",
      "--build-spec", "tools/datapack/release/candidate-build-spec.json",
      "--asset", assetPath,
      "--index", indexPath,
      "--pack-id", "capital",
    ], { cwd: root, env: verifierEnv });
    const report = JSON.parse(stdout);
    assert.equal(report.gzipSha256, pack.sha256);
    assert.equal(report.sqliteSha256, pack.sqliteSha256);
    assert.equal(report.byteSize, pack.sizeBytes);
    assert.ok(report.rowCounts.stations > 0);

    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.packs[0].sha256 = "f".repeat(64);
    await writeFile(indexPath, `${JSON.stringify(index)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/verify-production-pack-artifact-identity.mjs",
        "--build-spec", "tools/datapack/release/candidate-build-spec.json",
        "--asset", assetPath,
        "--index", indexPath,
        "--pack-id", "capital",
      ], { cwd: root, env: verifierEnv }),
      /index sha256 mismatch/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
