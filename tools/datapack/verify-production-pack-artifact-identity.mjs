#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { stagedPackPath } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || argv[index + 1] == null) throw new Error(`invalid argument: ${flag ?? ""}`);
    args[flag.slice(2)] = argv[index + 1];
  }
  return args;
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required`);
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
}

function tableRowCounts(sqlitePath) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    return Object.fromEntries(tables.map(({ name }) => [
      name,
      database.prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count,
    ]));
  } finally {
    database.close();
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const buildSpecPath = path.resolve(requiredArg(args, "build-spec"));
  const assetPath = path.resolve(requiredArg(args, "asset"));
  const indexPath = path.resolve(requiredArg(args, "index"));
  const packId = requiredArg(args, "pack-id");
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-production-pack-identity-"));
  try {
    // ponytail: manifest signatures are outside this SQLite identity gate, so CI needs no publish private key.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await execFileAsync(process.execPath, [
      path.join(root, "tools/datapack/build-datapack.mjs"),
      "--build-spec", buildSpecPath,
      "--output", outputDir,
    ], {
      cwd: root,
      env: {
        ...process.env,
        EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }),
      },
    });

    const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
    const packs = manifest.packs.filter(({ id }) => id === packId);
    if (packs.length !== 1 || packs[0].artifactKind !== "production") {
      throw new Error(`build must contain exactly one production pack: ${packId}`);
    }
    const pack = packs[0];
    const builtPath = path.join(outputDir, stagedPackPath(pack));
    const builtGzip = await readFile(builtPath);
    const assetGzip = await readFile(assetPath);
    const assetSqlite = gunzipSync(assetGzip);
    const gzipSha256 = sha256(assetGzip);
    const sqliteSha256 = sha256(assetSqlite);
    const byteSize = assetGzip.length;

    assertEqual(gzipSha256, pack.sha256, "asset gzip sha256");
    assertEqual(sqliteSha256, pack.sqliteSha256, "asset SQLite sha256");
    assertEqual(byteSize, pack.sizeBytes, "asset byteSize");
    assertEqual(sha256(builtGzip), pack.sha256, "built gzip sha256");

    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const indexPacks = index.packs?.filter(({ id }) => id === packId) ?? [];
    if (indexPacks.length !== 1) throw new Error(`index must contain exactly one pack: ${packId}`);
    assertEqual(indexPacks[0].sha256, gzipSha256, "index sha256");
    assertEqual(indexPacks[0].sqliteSha256, sqliteSha256, "index SQLite sha256");
    assertEqual(indexPacks[0].byteSize, byteSize, "index byteSize");

    process.stdout.write(`${JSON.stringify({
      packId,
      gzipSha256,
      sqliteSha256,
      byteSize,
      rowCounts: tableRowCounts(builtPath.replace(/\.gz$/, "")),
    }, null, 2)}\n`);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
