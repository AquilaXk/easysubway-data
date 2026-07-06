#!/usr/bin/env node
//
// #1789 Phase 1 (P1.3): octi+loom 출력 GeoJSON(위상 그래프 하나)에서 route_map
// positions + line_tracks를 **동일 역변환 1개**로 동시 생성한다(자기정합).
//
//  ┌ 역변환: loom lat/lon → design (export-loom-geojson의 T1 정확 왕복의 역, transform.json)
//  ├ 번들 오프셋(⑤): loom이 준 lines[] 순서대로 에지별 수직 오프셋(선폭 중앙정렬)
//  ├ 체이닝: 노선별 에지를 순서대로 이어 track polyline(분기점서 분리)
//  ├ rectify(8선형): RDP로 서브픽셀 지터 제거 → 세그먼트 방향 8방향 스냅 → 교점 재구성.
//  │   근거(T2 실측): 위반의 전부가 <8px 지터(중앙값 1.9px)·긴 세그먼트 위반 0 → octi
//  │   라우팅 자체는 8선형. octilinearize 재생성(노드만)은 dogleg→자유교차를 낳지만
//  │   rectify는 octi 라우팅을 보존하므로 교차를 유지한다.
//  └ positions: 역 node center를 노선 track에 투영 → 거리-0 정합(환승은 노선별 오프셋 도트)
//
// 좌표는 오직 octi 위상 그래프에서 나온다(CSV 아님 — 라이선스 가드레일 1·3조).
//
// 사용: node tools/route-map/octi-to-pack.mjs \
//         --loom /tmp/capital-loom.geojson --transform /tmp/capital-geo.transform.json \
//         [--region 수도권] [--bundle-spacing 6] [--eps 2] [--tol 0.5] [--check]
import { readFileSync } from "node:fs";
import { makeToDesignFromParams } from "./export-loom-geojson.mjs";
import { verticesToPath } from "./audit-octolinearity.mjs";
import { projectPointToPolylines } from "./project-nodes-to-tracks.mjs";
import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";

// ── 순수 기하 ────────────────────────────────────────────────────────────

/** 방향(dx,dy)을 가장 가까운 8방향(0/45/90/135°…) 단위벡터로 스냅. 축·대각은 정확값. */
export function snapUnit8(dx, dy) {
  const ang = Math.atan2(dy, dx);
  const k = Math.round(ang / (Math.PI / 4)); // 8분원
  const table = [
    { ux: 1, uy: 0 },
    { ux: Math.SQRT1_2, uy: Math.SQRT1_2 },
    { ux: 0, uy: 1 },
    { ux: -Math.SQRT1_2, uy: Math.SQRT1_2 },
    { ux: -1, uy: 0 },
    { ux: -Math.SQRT1_2, uy: -Math.SQRT1_2 },
    { ux: 0, uy: -1 },
    { ux: Math.SQRT1_2, uy: -Math.SQRT1_2 },
  ];
  return table[((k % 8) + 8) % 8];
}

/** 세그먼트 (a→b) 방향각의 45° 배수 편차(도). */
export function segmentAngleDeg8Dev(a, b) {
  const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const mod = ((ang % 45) + 45) % 45;
  return Math.min(mod, 45 - mod);
}

/** Ramer–Douglas–Peucker 단순화(끝점 보존). 서브픽셀 지터 제거용. */
export function rdpSimplify(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let maxDist = -1;
  let idx = -1;
  for (let i = 1; i < pts.length - 1; i += 1) {
    // 점-직선 수직거리(a,b 동일점=폐곡선이면 점-점거리로 폴백 — 순환선 붕괴 방지)
    const d =
      len === 0
        ? Math.hypot(pts[i].x - a.x, pts[i].y - a.y)
        : Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist <= eps) return [a, b];
  const left = rdpSimplify(pts.slice(0, idx + 1), eps);
  const right = rdpSimplify(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** 두 직선(점 p, 방향 d 단위벡터)의 교점 — 평행이면 null. */
function intersectLines(p1, d1, p2, d2) {
  const denom = d1.ux * d2.uy - d1.uy * d2.ux;
  if (Math.abs(denom) < 1e-9) return null; // 평행/collinear
  const t = ((p2.x - p1.x) * d2.uy - (p2.y - p1.y) * d2.ux) / denom;
  return { x: p1.x + t * d1.ux, y: p1.y + t * d1.uy };
}

/**
 * 8선형 근사 폴리라인을 위반 0으로 정류(rectify): RDP 단순화 → 세그먼트 방향을
 * 8방향으로 스냅 → 인접 스냅선의 교점으로 코너 재구성(끝점 정확 보존). 연속
 * 세그먼트가 같은 8방향(평행)이면 정점을 병합한다.
 */
export function rectifyPolyline(pts, { eps = 2, tol = 0.5 } = {}) {
  const s = rdpSimplify(pts, eps);
  if (s.length <= 2) return s;
  const dirs = [];
  for (let i = 0; i + 1 < s.length; i += 1) {
    dirs.push(snapUnit8(s[i + 1].x - s[i].x, s[i + 1].y - s[i].y));
  }
  const start = s[0];
  const end = s[s.length - 1];
  const anchorOf = (i) => {
    if (i === 0) return start;
    if (i === dirs.length - 1) return end;
    return s[i];
  };
  const out = [start];
  let prevPoint = start;
  let prevDir = dirs[0];
  for (let i = 1; i < dirs.length; i += 1) {
    const X = intersectLines(prevPoint, prevDir, anchorOf(i), dirs[i]);
    if (X === null) continue; // 평행: collinear 정점 병합
    out.push(X);
    prevPoint = X;
    prevDir = dirs[i];
  }
  out.push(end);
  return out;
}

/** 폴리라인을 진행방향 왼쪽으로 거리 dist 수직 이동(내부는 miter 조인). dist 0=항등. */
export function offsetPolyline(pts, dist) {
  if (dist === 0 || pts.length < 2) return pts.length < 2 ? pts.slice() : pts;
  const normals = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const L = Math.hypot(dx, dy) || 1;
    normals.push({ nx: dy / L, ny: -dx / L }); // +x 진행 → (0,-1)=왼쪽(위)
  }
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    let nx, ny;
    if (i === 0) ({ nx, ny } = normals[0]);
    else if (i === pts.length - 1) ({ nx, ny } = normals[i - 1]);
    else {
      let ax = normals[i - 1].nx + normals[i].nx;
      let ay = normals[i - 1].ny + normals[i].ny;
      const m = Math.hypot(ax, ay);
      if (m < 1e-6) ({ nx, ny } = normals[i]); // 180° 반전
      else {
        ax /= m;
        ay /= m;
        const cos = normals[i - 1].nx * ax + normals[i - 1].ny * ay;
        const scale = 1 / Math.max(0.35, cos); // miter 스파이크 클램프
        nx = ax * scale;
        ny = ay * scale;
      }
    }
    out.push({ x: pts[i].x + dist * nx, y: pts[i].y + dist * ny });
  }
  return out;
}

/**
 * 노선의 에지 목록({from,to,pts})을 순서대로 이어 track polyline 배열로. 분기점
 * (차수≠2)에서 체인을 분리한다(1호선·수인분당 분기 = 별 track). pts는 from→to 순서.
 */
export function chainEdgesForLine(edges) {
  const adj = new Map();
  edges.forEach((e, idx) => {
    for (const node of [e.from, e.to]) {
      if (!adj.has(node)) adj.set(node, []);
      adj.get(node).push({ idx, from: e.from, to: e.to });
    }
  });
  const deg = (n) => adj.get(n).length;
  const used = new Array(edges.length).fill(false);
  const orientedPts = (e, fromNode) =>
    e.from === fromNode ? e.pts : e.pts.slice().reverse();
  const chains = [];
  const walkChain = (startNode, startIdx) => {
    const chain = [];
    let node = startNode;
    let curIdx = startIdx;
    for (;;) {
      used[curIdx] = true;
      const seg = orientedPts(edges[curIdx], node);
      chain.push(...(chain.length === 0 ? seg : seg.slice(1)));
      node = edges[curIdx].from === node ? edges[curIdx].to : edges[curIdx].from;
      const next = deg(node) === 2 ? adj.get(node).find((a) => !used[a.idx]) : undefined;
      if (!next) break;
      curIdx = next.idx;
    }
    return chain;
  };
  const walkFrom = (startNode) => {
    for (const start of adj.get(startNode)) {
      if (!used[start.idx]) chains.push(walkChain(startNode, start.idx));
    }
  };
  for (const [node] of adj) if (deg(node) !== 2) walkFrom(node);
  for (let i = 0; i < edges.length; i += 1) if (!used[i]) walkFrom(edges[i].from);
  return chains;
}

// ── 오케스트레이션 ────────────────────────────────────────────────────────

/**
 * transform.json 파라미터 → loom(lon,lat) → design 역변환 클로저(동일 역변환 1개).
 * export-loom-geojson의 forward(buildGeoTransform)와 **동일 수식 1벌**을 공유해
 * forward↔inverse 부호가 조용히 어긋나지 않게 한다.
 */
export function makeToDesign(tf) {
  return makeToDesignFromParams(tf);
}

/** loom GeoJSON + 역변환에서 노선별 track(rectified·offset) + 역 중심좌표를 만든다. */
export function buildTracksAndCenters(geojson, toDesign, { bundleSpacing, eps, tol }) {
  const stationCenter = new Map(); // station_id → {x,y}(base label)
  const edges = [];
  for (const f of geojson.features) {
    if (f.geometry.type === "Point") {
      const label = f.properties.station_label || "";
      const [lon, lat] = f.geometry.coordinates;
      const p = toDesign(lon, lat);
      if (label.startsWith("station-") && !label.includes("#")) {
        stationCenter.set(label, p);
      }
    } else if (f.geometry.type === "LineString") {
      edges.push({
        from: f.properties.from,
        to: f.properties.to,
        lines: f.properties.lines.map((l) => l.id),
        pts: f.geometry.coordinates.map(([lon, lat]) => toDesign(lon, lat)),
      });
    }
  }
  // 노선별 에지(번들 오프셋 적용)
  // ⚠️ 알려진 한계(#1789 C3 판정 시점): 오프셋은 각 에지의 from→to 프레임에서 왼쪽으로
  // 적용된다. loom lines[] 순서도 그 프레임 기준이라 에지 내부 번들 순서는 일관되나,
  // 인접 에지의 from→to 방향이 뒤집히면 물리적 오프셋 쪽이 어긋나 번들-내부 교차가
  // 소량 생긴다(수도권 실측 free +11). octi 경로를 되살릴 경우 노선별 "한쪽" 부호를
  // 전역 일관되게 배정해야 한다(현재는 C3 폴백으로 octi 미채택 — 도구 보존용 주석).
  const byLine = new Map();
  for (const e of edges) {
    const size = e.lines.length;
    e.lines.forEach((lineId, index) => {
      const off = (index - (size - 1) / 2) * bundleSpacing;
      if (!byLine.has(lineId)) byLine.set(lineId, []);
      byLine.get(lineId).push({ from: e.from, to: e.to, pts: offsetPolyline(e.pts, off) });
    });
  }
  const tracksByLine = new Map(); // lineId → [polyline...]
  for (const [lineId, lineEdges] of byLine) {
    const chains = chainEdgesForLine(lineEdges);
    tracksByLine.set(
      lineId,
      chains.map((c) => rectifyPolyline(c, { eps, tol })).filter((p) => p.length >= 2),
    );
  }
  return { tracksByLine, stationCenter };
}

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    index: "apps/mobile/assets/datapacks/index.json",
    region: "수도권",
    loom: null,
    transform: null,
    bundleSpacing: 6,
    eps: 2,
    tol: 0.5,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": o.pack = argv[++i]; break;
      case "--index": o.index = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--loom": o.loom = argv[++i]; break;
      case "--transform": o.transform = argv[++i]; break;
      case "--bundle-spacing": o.bundleSpacing = Number(argv[++i]); break;
      case "--eps": o.eps = Number(argv[++i]); break;
      case "--tol": o.tol = Number(argv[++i]); break;
      case "--check": o.check = true; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.loom || !o.transform) {
    throw new Error("사용: --loom <loom.geojson> --transform <transform.json> 필수");
  }
  const geojson = JSON.parse(readFileSync(o.loom, "utf8"));
  const tf = JSON.parse(readFileSync(o.transform, "utf8"));
  const toDesign = makeToDesign(tf);
  const { tracksByLine, stationCenter } = buildTracksAndCenters(geojson, toDesign, {
    bundleSpacing: o.bundleSpacing,
    eps: o.eps,
    tol: o.tol,
  });

  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "octi-to-pack-");
  try {
    // track 라이선스 메타는 기존 첫 행 승계(노선별) — DELETE 전에 미리 수집한다
    // (삭제 후 조회하면 전부 null이 되어 track이 하나도 안 써진다).
    const metaByLine = new Map();
    for (const m of db
      .prepare(
        "SELECT line_id, svg_color, source_id, source_name, source_url, license, license_status, commercial_use_allowed, attribution_required, updated_at FROM route_map_line_tracks WHERE region=? GROUP BY line_id",
      )
      .all(o.region)) {
      metaByLine.set(m.line_id, m);
    }

    let trackRows = 0;
    const posRows = db
      .prepare("SELECT station_id, line_id FROM route_map_positions WHERE region=?")
      .all(o.region);

    // 각 (역,노선)을 노선 track에 투영 → 거리-0 정합 좌표
    const posUpdates = [];
    let unmatchedPos = 0;
    for (const r of posRows) {
      const center = stationCenter.get(r.station_id);
      const track = tracksByLine.get(r.line_id);
      if (!center || !track || track.length === 0) {
        unmatchedPos += 1;
        continue;
      }
      const proj = projectPointToPolylines(center, track);
      if (!proj) {
        unmatchedPos += 1;
        continue;
      }
      posUpdates.push({
        station_id: r.station_id,
        line_id: r.line_id,
        x: Math.round(proj.x),
        y: Math.round(proj.y),
      });
    }

    console.log(
      `[${o.region}] 노선 ${tracksByLine.size} · 역중심 ${stationCenter.size} · ` +
        `positions ${posUpdates.length}/${posRows.length} 투영 (미매칭 ${unmatchedPos})`,
    );
    if (o.check) {
      console.log("(--check: 팩 미기록)");
      db.close();
      return;
    }

    db.exec("BEGIN");
    db.prepare("DELETE FROM route_map_line_tracks WHERE region=?").run(o.region);
    const insTrack = db.prepare(
      "INSERT INTO route_map_line_tracks (region, line_id, track_index, path, svg_color, source_id, source_name, source_url, license, license_status, commercial_use_allowed, attribution_required, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const [lineId, tracks] of tracksByLine) {
      const meta = metaByLine.get(lineId);
      if (!meta) continue; // 팩에 없는 노선(정비 대상 아님)
      tracks.forEach((verts, ti) => {
        insTrack.run(
          o.region, lineId, ti, verticesToPath(verts.map((v) => ({ x: Math.round(v.x), y: Math.round(v.y) }))),
          meta.svg_color, meta.source_id, meta.source_name, meta.source_url,
          meta.license, meta.license_status, meta.commercial_use_allowed,
          meta.attribution_required, meta.updated_at,
        );
        trackRows += 1;
      });
    }
    if (trackRows === 0) throw new Error("track 0행 — 메타 수집/노선 매칭 실패(가드)");
    const updPos = db.prepare(
      "UPDATE route_map_positions SET x=?, y=? WHERE region=? AND station_id=? AND line_id=?",
    );
    for (const u of posUpdates) updPos.run(u.x, u.y, o.region, u.station_id, u.line_id);
    db.exec("COMMIT");
    db.exec("VACUUM");
    db.close();

    const { byteSize } = writePack({ sqlitePath, packPath, packRelPath: o.pack, indexRelPath: o.index });
    console.log(`팩 갱신 (track 행 ${trackRows} · position 갱신 ${posUpdates.length} · byteSize ${byteSize})`);
  } finally {
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
