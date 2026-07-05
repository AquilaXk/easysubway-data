#!/usr/bin/env node
//
// #1789 Stage 1a/1b octolinearize(고품질 핵심, 접근 2 공용): track이 손상됐거나
// 각진 노선을, 역 노드를 line_sequence 순서로 정렬해 인접 노드쌍을 8방향
// (0/45/90/135°) 세그먼트로 연결하는 8선형 track으로 재생성한다. 노드 좌표는
// 유지하고(정합 보장), 두 노드를 순수 8방향으로 못 이으면 45° + 수평/수직
// 도그레그(중간 꼭짓점 1개)로 잇는다. 모서리 원호는 렌더러(Stage 2a)가 처리.
//
// Usage: node tools/route-map/octolinearize-line-tracks.mjs
//          --region 수도권 --line "수도권 신림선" [--line ...] [--check]

import { verticesToPath } from "./audit-octolinearity.mjs";
import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";

/** 두 노드 a→b를 8방향 세그먼트 목록(정점 배열)으로 잇는다. 도그레그 1회 허용. */
export function octilinearSegment(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  // 순수 수평/수직/45° → 직선 1세그먼트(정점 2개).
  if (dx === 0 || dy === 0 || adx === ady) {
    return [a, b];
  }
  // 도그레그: 짧은 축 길이(diag)만큼 45°로 이동한 꼭짓점 → 나머지 긴 축 직선.
  // diag가 짧은 축과 같으므로 corner는 자동으로 긴 축의 b 좌표선에 놓인다
  // (수평 우세면 corner.y=b.y, 수직 우세면 corner.x=b.x) — 두 경우 식이 동일하다.
  const diag = Math.min(adx, ady);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const corner = { x: a.x + sx * diag, y: a.y + sy * diag };
  return [a, corner, b];
}

/** 노드 목록(sequence 순)을 8선형 polyline 정점 배열로. */
export function octilinearPolyline(nodes) {
  if (nodes.length < 2) return nodes.slice();
  const out = [nodes[0]];
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const seg = octilinearSegment(nodes[i], nodes[i + 1]);
    // seg[0]은 직전 노드(중복) → 제외하고 이어붙임.
    for (let k = 1; k < seg.length; k += 1) out.push(seg[k]);
  }
  return out;
}

function parseArgs(argv) {
  const o = { pack: "apps/mobile/assets/datapacks/capital.sqlite.gz", index: "apps/mobile/assets/datapacks/index.json", region: "수도권", lines: [], all: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--region": o.region = argv[++i]; break;
      case "--line": o.lines.push(argv[++i]); break;
      case "--all": o.all = true; break;
      case "--check": o.check = true; break;
      case "--pack": o.pack = argv[++i]; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "octolinearize-");
  try {
    const lineIds = [];
    if (o.all) {
      // 지역 내 route_map_positions에 노드가 있는 전 노선.
      for (const r of db.prepare("SELECT DISTINCT rmp.line_id AS id, l.name_ko AS name FROM route_map_positions rmp JOIN lines l ON l.id = rmp.line_id WHERE rmp.region = ? ORDER BY l.name_ko").all(o.region)) {
        lineIds.push({ id: r.id, name: r.name });
      }
    } else {
      for (const nm of o.lines) {
        const row = db.prepare("SELECT id FROM lines WHERE name_ko = ?").get(nm);
        if (row) lineIds.push({ id: row.id, name: nm });
      }
    }
    for (const { id, name } of lineIds) {
      // 노드를 line_sequence 순서로 (동일 물리역은 x/y 그대로)
      const nodes = db
        .prepare(
          `SELECT rmp.x AS x, rmp.y AS y, sl.line_sequence AS seq
           FROM route_map_positions rmp
           JOIN station_lines sl ON sl.station_id = rmp.station_id AND sl.line_id = rmp.line_id
           WHERE rmp.region = ? AND rmp.line_id = ?
           ORDER BY sl.line_sequence`,
        )
        .all(o.region, id)
        .map((r) => ({ x: r.x, y: r.y }));
      if (nodes.length < 2) {
        console.log(`  ${name}: 노드 ${nodes.length} → 스킵`);
        continue;
      }
      const verts = octilinearPolyline(nodes);
      const newPath = verticesToPath(verts);
      console.log(`  ${name}: 노드 ${nodes.length} → 정점 ${verts.length} (기존 조각 대체)`);
      if (!o.check) {
        // 기존 조각 삭제 후 단일 조각으로 재생성(라이선스 컬럼은 기존 첫 행 승계)
        const meta = db.prepare("SELECT svg_color, source_id, source_name, source_url, license, license_status, commercial_use_allowed, attribution_required, updated_at FROM route_map_line_tracks WHERE region=? AND line_id=? ORDER BY track_index LIMIT 1").get(o.region, id);
        db.exec("BEGIN");
        db.prepare("DELETE FROM route_map_line_tracks WHERE region=? AND line_id=?").run(o.region, id);
        db.prepare("INSERT INTO route_map_line_tracks (region, line_id, track_index, path, svg_color, source_id, source_name, source_url, license, license_status, commercial_use_allowed, attribution_required, updated_at) VALUES (?,?,0,?,?,?,?,?,?,?,?,?,?)")
          .run(o.region, id, newPath, meta.svg_color, meta.source_id, meta.source_name, meta.source_url, meta.license, meta.license_status, meta.commercial_use_allowed, meta.attribution_required, meta.updated_at);
        db.exec("COMMIT");
      }
    }
    if (o.check) { console.log("(--check: 미기록)"); return; }
    db.exec("VACUUM");
    db.close();
    const { byteSize } = writePack({ sqlitePath, packPath, packRelPath: o.pack, indexRelPath: o.index });
    console.log(`팩 갱신 (byteSize ${byteSize})`);
  } finally {
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
