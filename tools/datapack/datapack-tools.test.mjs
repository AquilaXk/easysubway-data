import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

test("데이터팩 생성기는 fixture로 원격 manifest와 gzip SQLite pack을 만든다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
  assert.equal(manifest.ttlSeconds, 3600);
  assert.deepEqual(manifest.activePack, { id: "capital", version: "1" });
  assert.equal(manifest.packs.length, 1);

  const pack = manifest.packs[0];
  assert.equal(pack.id, "capital");
  assert.equal(pack.version, "1");
  assert.equal(pack.url, "catalog/capital-v1.sqlite.gz");
  assert.deepEqual(pack.requiredTables, [
    "catalog_metadata",
    "operators",
    "lines",
    "stations",
    "station_lines",
    "station_exits",
    "facilities",
  ]);
  assert.equal(pack.minimumTableRows.stations, 2);
  assert.match(pack.sha256, /^[a-f0-9]{64}$/);
  assert.match(pack.sqliteSha256, /^[a-f0-9]{64}$/);

  const compressed = await readFile(path.join(outputDir, pack.url));
  const sqlite = gunzipSync(compressed);
  assert.equal(sha256(compressed), pack.sha256);
  assert.equal(sha256(sqlite), pack.sqliteSha256);

  const sqlitePath = path.join(outputDir, "catalog", "capital-v1.sqlite");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root },
  );

  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(database.prepare("SELECT value FROM catalog_metadata WHERE key = 'schemaVersion'").get().value, "1");
    assert.equal(database.prepare("SELECT updated_at FROM catalog_metadata WHERE key = 'schemaVersion'").get().updated_at, 1781827200);
    assert.equal(database.prepare("SELECT last_verified_at FROM stations WHERE id = 'station-sangnoksu'").get().last_verified_at, 1781827200);
    assert.equal(database.prepare("SELECT checked_at FROM data_quality_records WHERE id = 'quality-station-sangnoksu'").get().checked_at, 1781827200);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM stations").get().count, 2);
  } finally {
    database.close();
  }
});

test("데이터팩 검증기는 manifest checksum 불일치를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-invalid-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs[0].sha256 = "0".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /compressed checksum mismatch/,
  );
});

test("데이터팩 검증기는 packs에 없는 activePack을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-active-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.activePack = { id: "capital", version: "999" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /activePack must match one of manifest packs/,
  );
});

test("데이터팩 검증기는 invalid emergencyOverride를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-override-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.emergencyOverride = { id: "capital", version: "1" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /emergencyOverride.reason must be a non-empty string/,
  );
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
