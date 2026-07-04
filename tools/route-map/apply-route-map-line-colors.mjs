#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

// 공식 노선 색(route-map-line-colors.json)을 capital 팩의 lines.color에 반영한다.
// 위키에서 확정된 노선만 교체하고, 미확정 노선은 데이터팩 노선도(원본 SVG)에서
// 추출된 기존 색을 유지한다. --check는 파일을 쓰지 않고 정합만 검증한다.

function usage() {
  return `Usage: node tools/route-map/apply-route-map-line-colors.mjs --pack apps/mobile/assets/datapacks/capital.sqlite.gz --index apps/mobile/assets/datapacks/index.json [--colors tools/route-map/route-map-line-colors.json] [--check]`;
}

function parseArgs(argv) {
  const options = {
    pack: null,
    index: null,
    colors: "tools/route-map/route-map-line-colors.json",
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--pack":
        options.pack = argv[++index];
        break;
      case "--index":
        options.index = argv[++index];
        break;
      case "--colors":
        options.colors = argv[++index];
        break;
      case "--check":
        options.check = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.pack || !options.index) {
    throw new Error("--pack and --index are required");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "../..");
  const packPath = path.resolve(root, options.pack);
  const indexPath = path.resolve(root, options.index);
  const colorsSpec = JSON.parse(
    await readFile(path.resolve(root, options.colors), "utf8"),
  );
  const colorsByName = colorsSpec.colorsByName;
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-line-colors-"));
  const sqlitePath = path.join(tmp, "capital.sqlite");
  try {
    await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
    const database = new DatabaseSync(sqlitePath);
    let summary;
    try {
      if (!options.check) {
        applyLineColors(database, colorsByName);
      }
      summary = verifyLineColors(database, colorsByName);
      console.log(JSON.stringify(summary, null, 2));
      assertLineColors(summary);
    } finally {
      database.close();
    }
    if (!options.check) {
      const sqliteBytes = await readFile(sqlitePath);
      const compressedBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
      await writeFile(packPath, compressedBytes);
      await updateIndex(indexPath, compressedBytes, sqliteBytes);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function applyLineColors(database, colorsByName) {
  const update = database.prepare("UPDATE lines SET color = ? WHERE name_ko = ?");
  database.exec("BEGIN");
  try {
    for (const [name, hex] of Object.entries(colorsByName)) {
      update.run(hex, name);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function verifyLineColors(database, colorsByName) {
  const present = new Map(
    database
      .prepare("SELECT name_ko, color FROM lines")
      .all()
      .map((row) => [row.name_ko, row.color]),
  );
  const mismatched = [];
  const missing = [];
  for (const [name, hex] of Object.entries(colorsByName)) {
    if (!present.has(name)) {
      missing.push(name);
    } else if (present.get(name) !== hex) {
      mismatched.push({ name, expected: hex, actual: present.get(name) });
    }
  }
  return { expectedCount: Object.keys(colorsByName).length, missing, mismatched };
}

function assertLineColors(summary) {
  if (summary.missing.length > 0) {
    throw new Error(
      `official color 매핑에 있으나 lines에 없는 노선: ${summary.missing.join(", ")}`,
    );
  }
  if (summary.mismatched.length > 0) {
    throw new Error(
      `공식 색이 반영되지 않은 노선: ${summary.mismatched
        .map((m) => `${m.name}(${m.actual}!=${m.expected})`)
        .join(", ")}`,
    );
  }
}

async function updateIndex(indexPath, compressedBytes, sqliteBytes) {
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const capital = index.packs.find((pack) => pack.id === "capital");
  if (!capital) {
    throw new Error("capital pack not found in datapack index");
  }
  capital.sha256 = sha256(compressedBytes);
  capital.sqliteSha256 = sha256(sqliteBytes);
  capital.byteSize = compressedBytes.length;
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// CLI로 직접 실행할 때만 main을 돌린다(import 시 실행 안 함).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
