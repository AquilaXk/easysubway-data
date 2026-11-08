import { gzipSync, gunzipSync } from "node:zlib";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
import { sha256 } from "../lib/hash.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";

const root = path.resolve(import.meta.dirname, "../..");
stageLocalMobileFixture({ repositoryRoot: root });

const BUNDLED_PACK_PATH = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
const BUNDLED_INDEX_PATH = path.join(root, "apps/mobile/assets/datapacks/index.json");

function runApplyOfficialOdFares({ packPath, indexPath, extraArgs = [] }) {
  return execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
      "--pack",
      packPath,
      "--index",
      indexPath,
      ...extraArgs,
    ],
    { cwd: root },
  );
}

async function withBundledOdWorkspace(prefix, fn) {
  const directory = await mkdtemp(path.join(tmpdir(), `bundled-official-od-${prefix}-`));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  try {
    await copyFile(BUNDLED_PACK_PATH, packPath);
    await copyFile(BUNDLED_INDEX_PATH, indexPath);
    await fn({ directory, packPath, indexPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withReversionedBundledOdWorkspace(prefix, userVersion, { updateIndexHash = false } = {}, fn) {
  const directory = await mkdtemp(path.join(tmpdir(), `bundled-official-od-${prefix}-`));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(sqlitePath, gunzipSync(await readFile(BUNDLED_PACK_PATH)));
    const database = new DatabaseSync(sqlitePath);
    database.exec(`PRAGMA user_version = ${userVersion}`);
    database.close();
    const sqliteBytes = await readFile(sqlitePath);
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    await writeFile(packPath, gzipBytes);
    if (updateIndexHash) {
      const index = JSON.parse(await readFile(BUNDLED_INDEX_PATH, "utf8"));
      Object.assign(index.packs.find(({ id }) => id === "capital"), {
        sha256: sha256(gzipBytes),
        sqliteSha256: sha256(sqliteBytes),
        byteSize: gzipBytes.length,
      });
      await writeFile(indexPath, JSON.stringify(index));
    } else {
      await copyFile(BUNDLED_INDEX_PATH, indexPath);
    }
    await fn({ packPath, indexPath, inputPack: gzipBytes });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("전국 bundled datapack은 수도권·부산 대표 공식 OD를 각 3건 포함한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-fares-"));
  const databasePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(databasePath, gunzipSync(await readFile(BUNDLED_PACK_PATH)));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT origin_station_id AS originStationId,
               destination_station_id AS destinationStationId,
               source_id AS sourceId,
               snapshot_id AS snapshotId
        FROM official_od_fare_quotes
        ORDER BY source_id, origin_station_id, destination_station_id
      `).all().map((row) => ({ ...row }));
      const capitalRows = rows.filter(({ sourceId }) => sourceId.startsWith("seoul-metro-official-od-fare"));
      const busanRows = rows.filter(({ sourceId }) => sourceId === "busan-transportation-official-od-fares");
      assert.equal(capitalRows.length, 3);
      assert.equal(busanRows.length, 3);
      for (const row of rows) {
        assert.equal(
          database.prepare("SELECT COUNT(*) AS count FROM stations WHERE id IN (?, ?)")
            .get(row.originStationId, row.destinationStationId).count,
          2,
        );
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote 적용은 admission 일부 source가 빠진 입력을 거부한다", async () => {
  await withBundledOdWorkspace("partial-source", async ({ directory, packPath, indexPath }) => {
    const quotesPath = path.join(directory, "quotes.json");
    const quotes = JSON.parse(await readFile(path.join(root, "tools/datapack/official-od-fare-quotes.json"), "utf8"));
    quotes.quotes = quotes.quotes.filter(({ sourceId }) => sourceId === "seoul-metro-official-od-fares");
    await writeFile(quotesPath, JSON.stringify(quotes));
    const originalPackHash = sha256(await readFile(packPath));

    await assert.rejects(
      runApplyOfficialOdFares({ packPath, indexPath, extraArgs: ["--quotes", quotesPath] }),
      /quote source set must match admission source set/,
    );
    assert.equal(sha256(await readFile(packPath)), originalPackHash);
  });
});

test("bundled 공식 OD quote 재적용은 SQLite와 gzip hash를 변경하지 않는다", async () => {
  await withBundledOdWorkspace("idempotent", async ({ packPath, indexPath }) => {
    const apply = () => runApplyOfficialOdFares({ packPath, indexPath });

    await apply();
    const firstPack = await readFile(packPath);
    const firstIndex = await readFile(indexPath);
    await apply();

    assert.equal(sha256(await readFile(packPath)), sha256(firstPack));
    assert.equal(sha256(await readFile(indexPath)), sha256(firstIndex));
  });
});

test("bundled 공식 OD quote check는 catalog user_version 19을 요구한다", async () => {
  await withReversionedBundledOdWorkspace(
    "check-version",
    15,
    { updateIndexHash: true },
    async ({ packPath, indexPath }) => {
      await assert.rejects(
        runApplyOfficialOdFares({ packPath, indexPath, extraArgs: ["--check"] }),
        /bundled catalog user_version must be 19/,
      );
    },
  );
});

test("bundled 공식 OD quote 후처리기는 v18 production pack을 거부한다", async () => {
  await withReversionedBundledOdWorkspace(
    "user-version",
    18,
    {},
    async ({ packPath, indexPath, inputPack }) => {
      await assert.rejects(
        runApplyOfficialOdFares({ packPath, indexPath }),
        /requires catalog user_version 19, got 18/,
      );
      assert.equal(sha256(await readFile(packPath)), sha256(inputPack));
    },
  );
});

test("bundled 공식 OD quote 후처리기는 v20 catalog를 v19로 낮추지 않는다", async () => {
  await withReversionedBundledOdWorkspace(
    "newer-version",
    20,
    {},
    async ({ packPath, indexPath, inputPack }) => {
      await assert.rejects(
        runApplyOfficialOdFares({ packPath, indexPath }),
        /requires catalog user_version 19, got 20/,
      );
      assert.equal(sha256(await readFile(packPath)), sha256(inputPack));
    },
  );
});
