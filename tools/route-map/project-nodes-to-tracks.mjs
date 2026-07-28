#!/usr/bin/env node
//
// #1789 Stage 1a (접근 1, 수도권): 역 노드가 선(track)에서 벗어난 문제를,
// 각 역을 소속 노선 track의 최근접 점으로 **투영**해 해결한다. 선(원본 SVG
// stroke, 이미 8선형)은 그대로 두고 route_map_positions.x/y만 선 위로 옮긴다.
// 투영 거리가 임계를 넘는 역은 수동 검수 리포트로 남긴다(조건 1 산출물).
//
// Usage: node tools/route-map/project-nodes-to-tracks.mjs
//          --pack apps/mobile/assets/datapacks/capital.sqlite.gz
//          --index apps/mobile/assets/datapacks/index.json
//          --region 수도권 [--threshold 100] [--check] [--report out.json]

import { isMainModule } from "../lib/is-main-module.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { parsePathVertices } from "./audit-octolinearity.mjs";
import { cleanupPackDir, openPack, repoRoot, writePack } from "./pack-io.mjs";

export const CHECK_BASELINES = [{
  region: "수도권",
  stationId: "station-4c48e8115728",
  lineId: "line-6e39be0cb6e2",
  maxDistancePx: 406,
  reason: "도라산은 오너 SMA SVG 미수록 topology exception; #2571에서 기존 실측만 동결",
}];

export function checkProjectionReport(report) {
  const baselines = CHECK_BASELINES.filter((item) => item.region === report.region);
  const byKey = new Map(
    baselines.map((item) => [`${item.stationId}:${item.lineId}`, item]),
  );
  const seen = new Set();
  const unexpected = [];
  const exceededBaseline = [];
  for (const row of report.overThreshold) {
    const key = `${row.station_id}:${row.line_id}`;
    const baseline = byKey.get(key);
    if (!baseline) {
      unexpected.push(row);
      continue;
    }
    seen.add(key);
    if (!Number.isFinite(row.dist) || row.dist > baseline.maxDistancePx) {
      exceededBaseline.push({ ...row, maxDistancePx: baseline.maxDistancePx });
    }
  }
  return {
    unexpected,
    exceededBaseline,
    staleBaseline: baselines.filter(
      (item) => !seen.has(`${item.stationId}:${item.lineId}`),
    ),
    missingTracks: report.withoutTrack,
    emptyRegion: report.nodes === 0 ? [report.region] : [],
  };
}

/** 점 p를 선분 (a,b)에 투영한 점과 거리. */
export function projectPointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return { x: a.x, y: a.y, dist: Math.hypot(p.x - a.x, p.y - a.y) };
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return { x, y, dist: Math.hypot(p.x - x, p.y - y) };
}

/** 점 p를 polyline들(정점 배열의 배열) 중 최근접 점으로 투영. */
export function projectPointToPolylines(p, polylines) {
  let best = null;
  for (const polyline of polylines) {
    for (let i = 0; i + 1 < polyline.length; i += 1) {
      const proj = projectPointToSegment(p, polyline[i], polyline[i + 1]);
      if (best === null || proj.dist < best.dist) {
        best = proj;
      }
    }
  }
  return best;
}

function parseArgs(argv) {
  const options = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    index: "apps/mobile/assets/datapacks/index.json",
    region: "수도권",
    threshold: 100,
    check: false,
    report: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": options.pack = argv[++i]; break;
      case "--index": options.index = argv[++i]; break;
      case "--region": options.region = argv[++i]; break;
      case "--threshold": options.threshold = Number(argv[++i]); break;
      case "--check": options.check = true; break;
      case "--report": options.report = argv[++i]; break;
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { db: database, dir, sqlitePath, packPath } = openPack(options.pack, "project-nodes-");
  try {
    // 노선별 track polyline
    const polylinesByLine = new Map();
    for (const row of database
      .prepare(
        "SELECT line_id, path FROM route_map_line_tracks WHERE region = ? ORDER BY line_id, track_index",
      )
      .all(options.region)) {
      const verts = parsePathVertices(row.path);
      if (verts.length >= 2) {
        if (!polylinesByLine.has(row.line_id)) polylinesByLine.set(row.line_id, []);
        polylinesByLine.get(row.line_id).push(verts);
      }
    }

    const nodeRows = database
      .prepare(
        "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?",
      )
      .all(options.region);

    const updates = [];
    const overThreshold = [];
    const withoutTrack = [];
    let movedTotal = 0;
    for (const row of nodeRows) {
      const polylines = polylinesByLine.get(row.line_id);
      if (!polylines) {
        withoutTrack.push({ station_id: row.station_id, line_id: row.line_id });
        continue;
      }
      const proj = projectPointToPolylines({ x: row.x, y: row.y }, polylines);
      if (proj === null) continue;
      const nx = Math.max(0, Math.round(proj.x));
      const ny = Math.max(0, Math.round(proj.y));
      if (nx !== row.x || ny !== row.y) {
        updates.push({ ...row, nx, ny, dist: proj.dist });
        movedTotal += 1;
      }
      if (proj.dist > options.threshold) {
        overThreshold.push({
          station_id: row.station_id,
          line_id: row.line_id,
          dist: Math.round(proj.dist),
        });
      }
    }

    const report = {
      artifactKind: "node-projection-report",
      region: options.region,
      threshold: options.threshold,
      nodes: nodeRows.length,
      nodesWithoutTrack: withoutTrack.length,
      withoutTrack,
      moved: movedTotal,
      overThreshold,
    };
    if (options.report) {
      writeFileSync(path.isAbsolute(options.report) ? options.report : path.join(repoRoot, options.report), JSON.stringify(report, null, 2));
    }
    console.log(
      `[${options.region}] 노드 ${report.nodes} · 투영 이동 ${report.moved} · 임계(${options.threshold}) 초과 ${overThreshold.length}` +
        (withoutTrack.length ? ` · track없는노드 ${withoutTrack.length}` : ""),
    );
    if (overThreshold.length) {
      console.log("  임계 초과(수동 검수):");
      for (const o of overThreshold.slice(0, 30)) {
        console.log(`    ${o.station_id} (${o.line_id}) 거리 ${o.dist}`);
      }
    }

    if (options.check) {
      const findings = checkProjectionReport(report);
      if (Object.values(findings).some((rows) => rows.length > 0)) {
        console.error(JSON.stringify(findings, null, 2));
        process.exitCode = 1;
      }
      database.close();
      console.log("(--check: 팩 미기록)");
      return;
    }

    // 투영 좌표 반영
    const update = database.prepare(
      "UPDATE route_map_positions SET x = ?, y = ? WHERE region = ? AND station_id = ? AND line_id = ?",
    );
    database.exec("BEGIN");
    for (const u of updates) {
      update.run(u.nx, u.ny, options.region, u.station_id, u.line_id);
    }
    database.exec("COMMIT");
    database.close();

    // 팩 재압축 + index.json sha 갱신
    const { byteSize, sha256: gzSha } = writePack({ sqlitePath, packPath, packRelPath: options.pack, indexRelPath: options.index });
    console.log(`팩 갱신 완료 (byteSize ${byteSize}, sha ${gzSha.slice(0, 12)})`);
  } finally {
    cleanupPackDir(dir);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
