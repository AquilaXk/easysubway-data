#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

// region별 기대 역 point/노선 수 — QA 회귀 방지용 고정값. 새 region을 enrich할 때
// 여기에 등록해야 exact-count 검증이 동작한다. (segment path 수는 positions-lines로
// region 무관하게 파생된다.)
export const expectedCountsByRegion = {
  // #1950: 오너 자작 8선형 도식 채택 + #1954 검단연장 3역·서해선 원종 좌표행 신설로 796→800.
  "수도권": { positions: 800, lines: 24 },
  "부산권": { positions: 158, lines: 6 },
  "대구권": { positions: 101, lines: 4 },
  "광주권": { positions: 20, lines: 1 },
  "대전권": { positions: 22, lines: 1 },
};

function usage() {
  return `Usage: node tools/route-map/enrich-capital-route-map-layer.mjs --pack apps/mobile/assets/datapacks/capital.sqlite.gz --index apps/mobile/assets/datapacks/index.json [--region 수도권] [--check] [--qa-report report.json] [--max-label-overlaps N]

Adds derived route-map line paths and label polygons for a region's route-map
positions inside the capital pack. --check validates without rewriting files.`;
}

function parseArgs(argv) {
  const options = {
    pack: null,
    index: null,
    region: "수도권",
    check: false,
    qaReport: null,
    maxLabelOverlaps: null,
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
      case "--region":
        options.region = argv[++index];
        break;
      case "--check":
        options.check = true;
        break;
      case "--qa-report":
        options.qaReport = argv[++index];
        break;
      case "--max-label-overlaps":
        options.maxLabelOverlaps = Number(argv[++index]);
        if (!Number.isInteger(options.maxLabelOverlaps) || options.maxLabelOverlaps < 0) {
          throw new Error("--max-label-overlaps must be a non-negative integer");
        }
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
  const region = options.region;
  const root = path.resolve(import.meta.dirname, "../..");
  const packPath = path.resolve(root, options.pack);
  const indexPath = path.resolve(root, options.index);
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-capital-route-map-"));
  const sqlitePath = path.join(tmp, "capital.sqlite");
  try {
    await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
    const database = new DatabaseSync(sqlitePath);
    let output;
    try {
      const before = capitalRouteMapSummary(database, region);
      if (!options.check) {
        enrichCapitalRouteMap(database, region);
      }
      const after = capitalRouteMapSummary(database, region);
      assertCapitalRouteMap(after, region);
      output = {
        before,
        after,
        labelCollisionQa: labelCollisionQa(database, region),
      };
      assertLabelCollisionBudget(output.labelCollisionQa, options.maxLabelOverlaps);
      console.log(JSON.stringify(output, null, 2));
    } finally {
      database.close();
    }
    if (options.qaReport) {
      await writeJson(path.resolve(root, options.qaReport), output);
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

function enrichCapitalRouteMap(database, region) {
  const rows = database.prepare(`
    SELECT
      rmp.station_id,
      s.name_ko,
      rmp.line_id,
      sl.line_sequence,
      rmp.x,
      rmp.y,
      rmp.label_dx,
      rmp.label_dy,
      rmp.label_polygon
    FROM route_map_positions rmp
    JOIN stations s ON s.id = rmp.station_id
    JOIN station_lines sl
      ON sl.station_id = rmp.station_id
     AND sl.line_id = rmp.line_id
    WHERE rmp.region = ?
    ORDER BY rmp.line_id, sl.line_sequence, rmp.station_id
  `).all(region);
  const byLine = new Map();
  for (const row of rows) {
    byLine.set(row.line_id, [...(byLine.get(row.line_id) ?? []), row]);
  }

  const update = database.prepare(`
    UPDATE route_map_positions
    SET
      label_dx = ?,
      label_dy = ?,
      label_polygon = ?,
      up_path = ?,
      down_path = ?
    WHERE region = ?
      AND station_id = ?
      AND line_id = ?
  `);

  database.exec("BEGIN");
  try {
    for (const lineRows of byLine.values()) {
      for (let index = 0; index < lineRows.length; index += 1) {
        const row = lineRows[index];
        const previous = lineRows[index - 1] ?? null;
        const next = lineRows[index + 1] ?? null;
        const labelOffset = labelOffsetFor(row, previous, next);
        update.run(
          labelOffset.dx,
          labelOffset.dy,
          JSON.stringify(labelPolygonFor(row, labelOffset)),
          next ? segmentPath(next, row) : "",
          previous ? segmentPath(previous, row) : "",
          region,
          row.station_id,
          row.line_id,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function labelOffsetFor(row, previous, next) {
  if (row.label_dx !== 0 || row.label_dy !== 0) {
    return { dx: row.label_dx, dy: row.label_dy };
  }
  const other = next ?? previous;
  if (!other) {
    return { dx: 14, dy: 0 };
  }
  const horizontal = Math.abs(other.x - row.x) >= Math.abs(other.y - row.y);
  return horizontal ? { dx: 0, dy: 16 } : { dx: 16, dy: 0 };
}

function labelPolygonFor(row, offset) {
  const width = Math.max(32, [...row.name_ko].length * 13 + 12);
  const height = 22;
  const centerX = row.x + offset.dx;
  const centerY = row.y + offset.dy;
  const left = Math.max(0, Math.round(centerX - width / 2));
  const top = Math.max(0, Math.round(centerY - height / 2));
  const right = Math.round(centerX + width / 2);
  const bottom = Math.round(centerY + height / 2);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function segmentPath(from, to) {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

function capitalRouteMapSummary(database, region) {
  const base = database.prepare(`
    SELECT
      COUNT(*) AS positions,
      COUNT(DISTINCT line_id) AS lines,
      SUM(CASE WHEN up_path <> '' THEN 1 ELSE 0 END) AS upPaths,
      SUM(CASE WHEN down_path <> '' THEN 1 ELSE 0 END) AS downPaths,
      SUM(CASE WHEN label_polygon <> '' THEN 1 ELSE 0 END) AS labelPolygons
    FROM route_map_positions
    WHERE region = ?
  `).get(region);
  const transfers = database.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT station_id
      FROM route_map_positions
      WHERE region = ?
      GROUP BY station_id
      HAVING COUNT(DISTINCT line_id) > 1
    )
  `).get(region).count;
  const lodMajor = database.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT station_id
      FROM route_map_positions
      WHERE region = ?
      GROUP BY station_id
      HAVING COUNT(DISTINCT line_id) > 1
    )
  `).get(region).count;
  return {
    region,
    positions: base.positions,
    lines: base.lines,
    upPaths: base.upPaths,
    downPaths: base.downPaths,
    labelPolygons: base.labelPolygons,
    transferGroups: transfers,
    lod: {
      zoom0: "lines_only",
      zoom1MajorLabels: lodMajor,
      zoom2StationLabels: base.labelPolygons,
    },
  };
}

function labelCollisionQa(database, region) {
  const rows = database.prepare(`
    SELECT
      rmp.station_id,
      s.name_ko,
      rmp.line_id,
      rmp.label_polygon,
      COUNT(*) OVER (PARTITION BY rmp.station_id) AS station_line_count
    FROM route_map_positions rmp
    JOIN stations s ON s.id = rmp.station_id
    WHERE rmp.region = ?
      AND rmp.label_polygon <> ''
    ORDER BY rmp.station_id, rmp.line_id
  `).all(region);
  const zoom2Labels = rows.map(labelRow).filter(Boolean);
  const seenTransferStations = new Set();
  const zoom1Labels = [];
  for (const row of rows) {
    if (row.station_line_count <= 1 || seenTransferStations.has(row.station_id)) {
      continue;
    }
    seenTransferStations.add(row.station_id);
    const label = labelRow(row);
    if (label) {
      zoom1Labels.push(label);
    }
  }
  return {
    zoom1: collisionSummary(zoom1Labels),
    zoom2: collisionSummary(zoom2Labels),
  };
}

function labelRow(row) {
  const polygon = JSON.parse(row.label_polygon);
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return null;
  }
  return {
    stationId: row.station_id,
    stationName: row.name_ko,
    lineId: row.line_id,
    bounds: boundsForPolygon(polygon),
  };
}

function boundsForPolygon(polygon) {
  return polygon.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

function collisionSummary(labels) {
  const collisions = [];
  for (let leftIndex = 0; leftIndex < labels.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < labels.length; rightIndex += 1) {
      const left = labels[leftIndex];
      const right = labels[rightIndex];
      if (left.stationId === right.stationId) {
        continue;
      }
      const overlap = overlapArea(left.bounds, right.bounds);
      if (overlap > 0) {
        collisions.push({
          left: labelKey(left),
          right: labelKey(right),
          overlapArea: overlap,
        });
      }
    }
  }
  collisions.sort((left, right) => right.overlapArea - left.overlapArea);
  return {
    labelCount: labels.length,
    overlapCount: collisions.length,
    worstOverlaps: collisions.slice(0, 50),
  };
}

function overlapArea(left, right) {
  const width = Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX);
  const height = Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY);
  return width > 0 && height > 0 ? width * height : 0;
}

function labelKey(label) {
  return `${label.stationName}(${label.stationId}:${label.lineId})`;
}

function assertCapitalRouteMap(summary, region) {
  const expected = expectedCountsByRegion[region];
  if (!expected) {
    throw new Error(
      `no expected route map counts configured for region ${region}; add it to expectedCountsByRegion`,
    );
  }
  if (summary.positions !== expected.positions) {
    throw new Error(
      `${region} route map positions must be ${expected.positions}, got ${summary.positions}`,
    );
  }
  if (summary.lines !== expected.lines) {
    throw new Error(
      `${region} route map lines must be ${expected.lines}, got ${summary.lines}`,
    );
  }
  const expectedSegmentPaths = summary.positions - summary.lines;
  if (summary.upPaths !== expectedSegmentPaths || summary.downPaths !== expectedSegmentPaths) {
    throw new Error(
      `${region} line paths must be ${expectedSegmentPaths} up/down segments, got ${summary.upPaths}/${summary.downPaths}`,
    );
  }
  if (summary.labelPolygons !== summary.positions) {
    throw new Error(
      `${region} label polygons must cover every station-line row, got ${summary.labelPolygons}/${summary.positions}`,
    );
  }
  // 단일 노선 지역(예: 광주·대전 1호선)은 환승역이 없어 transfer 0이 정상.
  // 다노선 지역은 환승 그룹이 도출되어야 한다.
  if (expected.lines > 1 && summary.transferGroups <= 0) {
    throw new Error(`${region} transfer groups must be derivable`);
  }
  if (summary.lod.zoom1MajorLabels !== summary.transferGroups) {
    throw new Error(`${region} LOD major labels must match transfer groups`);
  }
}

function assertLabelCollisionBudget(labelCollisionQa, maxLabelOverlaps) {
  if (maxLabelOverlaps == null) {
    return;
  }
  const totalOverlaps =
    labelCollisionQa.zoom1.overlapCount + labelCollisionQa.zoom2.overlapCount;
  if (totalOverlaps > maxLabelOverlaps) {
    throw new Error(
      `capital label overlaps ${totalOverlaps} exceed budget ${maxLabelOverlaps}`,
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

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// CLI로 직접 실행할 때만 main을 돌린다. import(테스트에서 expectedCountsByRegion
// 재사용)로 로드하면 실행하지 않는다.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
