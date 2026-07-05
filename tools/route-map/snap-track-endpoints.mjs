#!/usr/bin/env node
//
// #1789 Stage 1a: track 조각 끝점을 노드에 스냅해 접합부를 체계적으로 정합한다.
// SVG stroke track이 여러 조각으로 분리돼 조각 끝점이 공유 역 노드/인접 조각과
// 연결되지 않는 문제(6호선 응암순환 등)를, 각 조각의 시작/끝 정점을 그 노선의
// 최근접 역 노드(스냅 임계 내)로 옮겨 일괄 연결한다. 임계를 크게 벗어난 끝점은
// track 데이터 오류(불완전/추출오류)로 리포트한다(수동 검수).
//
// Usage: node tools/route-map/snap-track-endpoints.mjs
//          --region 수도권 [--threshold 80] [--check] [--report out.json]

import { writeFileSync } from "node:fs";
import path from "node:path";

import { parsePathVertices, verticesToPath } from "./audit-octolinearity.mjs";
import { cleanupPackDir, openPack, repoRoot, writePack } from "./pack-io.mjs";

function nearestNode(vertex, nodes) {
  let best = null;
  for (const n of nodes) {
    const d = Math.hypot(vertex.x - n.x, vertex.y - n.y);
    if (best === null || d < best.dist) best = { node: n, dist: d };
  }
  return best;
}

function parseArgs(argv) {
  const o = { pack: "apps/mobile/assets/datapacks/capital.sqlite.gz", index: "apps/mobile/assets/datapacks/index.json", region: "수도권", threshold: 80, check: false, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--region": o.region = argv[++i]; break;
      case "--threshold": o.threshold = Number(argv[++i]); break;
      case "--check": o.check = true; break;
      case "--report": o.report = argv[++i]; break;
      case "--pack": o.pack = argv[++i]; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "snap-junctions-");
  try {
    const nodesByLine = new Map();
    for (const r of db.prepare("SELECT line_id, x, y FROM route_map_positions WHERE region = ?").all(o.region)) {
      if (!nodesByLine.has(r.line_id)) nodesByLine.set(r.line_id, []);
      nodesByLine.get(r.line_id).push({ x: r.x, y: r.y });
    }
    const tracks = db.prepare("SELECT rowid, line_id, track_index, path FROM route_map_line_tracks WHERE region = ? ORDER BY line_id, track_index").all(o.region);

    let snapped = 0;
    const errors = [];
    const updates = [];
    for (const t of tracks) {
      const verts = parsePathVertices(t.path);
      if (verts.length < 2) continue;
      const nodes = nodesByLine.get(t.line_id) ?? [];
      let changed = false;
      for (const idx of [0, verts.length - 1]) {
        const near = nearestNode(verts[idx], nodes);
        if (!near) continue;
        if (near.dist > 0 && near.dist <= o.threshold) {
          verts[idx] = { x: near.node.x, y: near.node.y };
          changed = true;
          snapped += 1;
        } else if (near.dist > o.threshold) {
          errors.push({ line_id: t.line_id, track_index: t.track_index, end: idx === 0 ? "start" : "end", dist: Math.round(near.dist) });
        }
      }
      if (changed) updates.push({ rowid: t.rowid, path: verticesToPath(verts) });
    }

    const report = { artifactKind: "track-endpoint-snap-report", region: o.region, threshold: o.threshold, tracks: tracks.length, snapped, errors };
    if (o.report) writeFileSync(path.isAbsolute(o.report) ? o.report : path.join(repoRoot, o.report), JSON.stringify(report, null, 2));
    console.log(`[${o.region}] track ${tracks.length} · 끝점 스냅 ${snapped} · 임계(${o.threshold}) 초과(추출오류 후보) ${errors.length}`);
    for (const e of errors) console.log(`  오류후보: ${e.line_id} 조각${e.track_index} ${e.end} 거리 ${e.dist}`);

    if (o.check) { console.log("(--check: 미기록)"); return; }

    const upd = db.prepare("UPDATE route_map_line_tracks SET path = ? WHERE rowid = ?");
    db.exec("BEGIN");
    for (const u of updates) upd.run(u.path, u.rowid);
    db.exec("COMMIT");
    db.exec("VACUUM");
    db.close();

    const { byteSize } = writePack({ sqlitePath, packPath, packRelPath: o.pack, indexRelPath: o.index });
    console.log(`팩 갱신 (byteSize ${byteSize})`);
  } finally {
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
