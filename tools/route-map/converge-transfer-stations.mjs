#!/usr/bin/env node
//
// #1789 Stage 1a: 환승역 정합. 노드 투영이 한 물리 환승역의 여러 노선 노드를
// 각 노선 track으로 따로 옮겨 분산시킨 문제(김포공항 54px·왕십리 8px)를, 환승역
// (2+ 노선) 노드를 centroid 한 점으로 통일하고 각 노선 track의 최근접 정점을 그
// centroid로 스냅해 모든 노선이 환승 지점에서 수렴하게 한다(공식 노선도처럼).
//
// Usage: node tools/route-map/converge-transfer-stations.mjs --region 수도권 [--check]

import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";

function parseArgs(argv) {
  const o = { pack: "apps/mobile/assets/datapacks/capital.sqlite.gz", index: "apps/mobile/assets/datapacks/index.json", region: "수도권", check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--region") o.region = argv[++i];
    else if (argv[i] === "--check") o.check = true;
    else if (argv[i] === "--pack") o.pack = argv[++i];
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "converge-");
  try {
    // 환승역: 같은 station_id가 2+ line_id
    const byStation = new Map();
    for (const r of db.prepare("SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?").all(o.region)) {
      if (!byStation.has(r.station_id)) byStation.set(r.station_id, []);
      byStation.get(r.station_id).push(r);
    }
    const transfers = [...byStation.entries()].filter(([, rows]) => new Set(rows.map((r) => r.line_id)).size > 1);

    // 환승역 노드를 centroid 한 점으로 통일한다(track은 건드리지 않는다 — 이후
    // octolinearize가 이 통일 노드를 지나도록 전 노선 track을 재생성해 수렴시킨다).
    const nodeUpdates = [];
    for (const [stationId, rows] of transfers) {
      const cx = Math.round(rows.reduce((s, r) => s + r.x, 0) / rows.length);
      const cy = Math.round(rows.reduce((s, r) => s + r.y, 0) / rows.length);
      for (const r of rows) {
        if (r.x !== cx || r.y !== cy) nodeUpdates.push({ stationId, line_id: r.line_id, cx, cy });
      }
    }
    console.log(`[${o.region}] 환승역 ${transfers.length} · 노드 centroid 통일 ${nodeUpdates.length} (track은 octolinearize가 재생성)`);
    if (o.check) { console.log("(--check: 미기록)"); return; }

    db.exec("BEGIN");
    const un = db.prepare("UPDATE route_map_positions SET x=?, y=? WHERE region=? AND station_id=? AND line_id=?");
    for (const u of nodeUpdates) un.run(u.cx, u.cy, o.region, u.stationId, u.line_id);
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
