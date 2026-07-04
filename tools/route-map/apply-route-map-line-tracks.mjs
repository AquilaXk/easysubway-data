#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

// build-route-map-line-tracks가 만든 tracks.json(들)을 capital 팩의
// route_map_line_tracks 테이블에 기록한다. 라이선스 메타데이터는 같은
// (region, line_id)의 route_map_positions에서 승계한다(광주 CC BY-SA 등 유지).
// --check는 파일을 쓰지 않고 커버리지·빈 path만 검증한다.

function usage() {
  return `Usage: node tools/route-map/apply-route-map-line-tracks.mjs --pack apps/mobile/assets/datapacks/capital.sqlite.gz --index apps/mobile/assets/datapacks/index.json --tracks <tracks.json> [--tracks <...>] [--check]`;
}

function parseArgs(argv) {
  const options = { pack: null, index: null, tracks: [], check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--pack": options.pack = argv[++index]; break;
      case "--index": options.index = argv[++index]; break;
      case "--tracks": options.tracks.push(argv[++index]); break;
      case "--check": options.check = true; break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.pack || !options.index) throw new Error("--pack and --index are required");
  if (options.tracks.length === 0) throw new Error("at least one --tracks is required");
  return options;
}

function createLineTracksTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS route_map_line_tracks (
      region TEXT NOT NULL,
      line_id TEXT NOT NULL,
      track_index INTEGER NOT NULL,
      path TEXT NOT NULL,
      svg_color TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      license TEXT NOT NULL,
      license_status TEXT NOT NULL,
      commercial_use_allowed INTEGER NOT NULL DEFAULT 0 CHECK (commercial_use_allowed IN (0, 1)),
      attribution_required INTEGER NOT NULL DEFAULT 1 CHECK (attribution_required IN (0, 1)),
      updated_at INTEGER,
      PRIMARY KEY (region, line_id, track_index)
    )`);
}

// 한 region의 tracks 문서를 기록한다. 같은 region 기존 행은 DELETE 후 INSERT(재실행 안전).
function applyLineTracks(database, tracksDoc) {
  const licenseByLine = new Map(
    database
      .prepare(
        `SELECT line_id, source_id, source_name, source_url, license, license_status,
                commercial_use_allowed, attribution_required
         FROM route_map_positions WHERE region = ? GROUP BY line_id`,
      )
      .all(tracksDoc.region)
      .map((row) => [row.line_id, row]),
  );
  const insert = database.prepare(`
    INSERT INTO route_map_line_tracks (
      region, line_id, track_index, path, svg_color, source_id, source_name,
      source_url, license, license_status, commercial_use_allowed,
      attribution_required, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updatedAt = Math.floor(Date.now() / 1000);
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM route_map_line_tracks WHERE region = ?").run(tracksDoc.region);
    for (const line of tracksDoc.lines) {
      const meta = licenseByLine.get(line.lineId);
      if (!meta) {
        throw new Error(`route_map_positions에 없는 노선을 tracks가 참조: ${line.lineId} (${tracksDoc.region})`);
      }
      line.paths.forEach((pathString, trackIndex) => {
        insert.run(
          tracksDoc.region, line.lineId, trackIndex, pathString, line.svgColor ?? "",
          meta.source_id, meta.source_name, meta.source_url, meta.license,
          meta.license_status, meta.commercial_use_allowed, meta.attribution_required, updatedAt,
        );
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// region의 route_map_positions 노선 전부가 track을 갖고, 빈 path가 없는지 검증.
function verifyLineTracks(database, tracksDoc) {
  const lineIds = new Set(
    database
      .prepare("SELECT DISTINCT line_id FROM route_map_positions WHERE region = ?")
      .all(tracksDoc.region)
      .map((row) => row.line_id),
  );
  const covered = new Set();
  const emptyPaths = [];
  for (const line of tracksDoc.lines) {
    covered.add(line.lineId);
    if (!line.paths || line.paths.length === 0) emptyPaths.push(line.lineId);
    if (!lineIds.has(line.lineId)) {
      throw new Error(`route_map_positions에 없는 노선을 tracks가 참조: ${line.lineId} (${tracksDoc.region})`);
    }
  }
  const missing = [...lineIds].filter((id) => !covered.has(id));
  if (missing.length > 0) throw new Error(`track이 없는 노선: ${missing.join(", ")} (${tracksDoc.region})`);
  if (emptyPaths.length > 0) throw new Error(`빈 track path: ${emptyPaths.join(", ")} (${tracksDoc.region})`);
  return { region: tracksDoc.region, lines: tracksDoc.lines.length };
}

async function updateIndex(indexPath, compressedBytes, sqliteBytes) {
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const capital = index.packs.find((pack) => pack.id === "capital");
  if (!capital) throw new Error("capital pack not found in datapack index");
  capital.sha256 = sha256(compressedBytes);
  capital.sqliteSha256 = sha256(sqliteBytes);
  capital.byteSize = compressedBytes.length;
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "../..");
  const packPath = path.resolve(root, options.pack);
  const indexPath = path.resolve(root, options.index);
  const tracksDocs = await Promise.all(
    options.tracks.map(async (file) => JSON.parse(await readFile(path.resolve(root, file), "utf8"))),
  );

  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-line-tracks-"));
  const sqlitePath = path.join(tmp, "capital.sqlite");
  try {
    await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
    const database = new DatabaseSync(sqlitePath);
    const summary = [];
    try {
      if (!options.check) {
        createLineTracksTable(database);
        for (const tracksDoc of tracksDocs) applyLineTracks(database, tracksDoc);
      }
      for (const tracksDoc of tracksDocs) summary.push(verifyLineTracks(database, tracksDoc));
    } finally {
      database.close();
    }
    console.log(JSON.stringify({ applied: !options.check, regions: summary }, null, 2));
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

// CLI로 직접 실행할 때만 main을 돌린다(import 시 실행 안 함).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
