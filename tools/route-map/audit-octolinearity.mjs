#!/usr/bin/env node
//
// #1789 Stage 0 스파이크: 노선도 선의 8선형(octolinear) 품질과 노드-선 정합을
// 지역별로 기계 판정한다. 커밋된 오프라인 팩(capital.sqlite.gz)의
// route_map_line_tracks(선)와 route_map_positions(역 노드)를 직접 읽어:
//   G1  각 track 세그먼트 방향각이 {0,45,90,135}° (mod 180) ±허용오차인 비율
//   G3  각 역 노드에서 소속 노선 track까지의 최단 거리 분포(정합도)
// 를 산출한다. 판정 로직(segmentAngleDeg/isOctolinearAngle/pointToSegmentDistance)은
// 순수 함수로 분리해 Stage 3 CI 계약 테스트가 재사용한다.
//
// Usage: node tools/route-map/audit-octolinearity.mjs
//          [--pack apps/mobile/assets/datapacks/capital.sqlite.gz]
//          [--angle-tolerance 0.5] [--align-threshold 0.75] [--json]

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");

/** 세그먼트 (a→b) 방향각을 [0,180) 도로 정규화해 반환. 길이 0이면 null. */
export function segmentAngleDeg(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return null;
  }
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180; // [0,180)
  return deg;
}

/** 방향각이 8선형(0/45/90/135° mod 180)에서 허용오차 내인지. */
export function isOctolinearAngle(deg, toleranceDeg = 0.5) {
  if (deg === null) {
    return true; // 길이 0 세그먼트는 판정 제외(정합에 영향 없음)
  }
  for (const target of [0, 45, 90, 135, 180]) {
    if (Math.abs(deg - target) <= toleranceDeg) {
      return true;
    }
  }
  return false;
}

/** 점 p에서 선분 (a,b)까지 최단 거리. */
export function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/** 점 p에서 polyline(정점 배열들의 배열)까지 최단 거리. 세그먼트 없으면 Infinity. */
export function pointToPolylinesDistance(p, polylines) {
  let best = Infinity;
  for (const polyline of polylines) {
    for (let i = 0; i + 1 < polyline.length; i += 1) {
      const d = pointToSegmentDistance(p, polyline[i], polyline[i + 1]);
      if (d < best) {
        best = d;
      }
    }
  }
  return best;
}

/** "M x y L x y ..." 절대 경로를 정점 목록으로 파싱(명령 무시, 숫자쌍만). */
export function parsePathVertices(pathText) {
  const nums = (String(pathText).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    points.push({ x: nums[i], y: nums[i + 1] });
  }
  return points;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function parseArgs(argv) {
  const options = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    angleTolerance: 0.5,
    alignThreshold: 0.75,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": options.pack = argv[++i]; break;
      case "--angle-tolerance": options.angleTolerance = Number(argv[++i]); break;
      case "--align-threshold": options.alignThreshold = Number(argv[++i]); break;
      case "--json": options.json = true; break;
    }
  }
  return options;
}

function openPack(packPath) {
  const bytes = gunzipSync(readFileSync(path.join(root, packPath)));
  const dir = mkdtempSync(path.join(tmpdir(), "octolinear-"));
  const sqlitePath = path.join(dir, "pack.sqlite");
  writeFileSync(sqlitePath, bytes);
  return {
    database: new DatabaseSync(sqlitePath, { readOnly: true }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function auditRegion(database, region, options) {
  // 노선별 track polyline(정점)
  const trackRows = database
    .prepare(
      "SELECT line_id, path FROM route_map_line_tracks WHERE region = ? ORDER BY line_id, track_index",
    )
    .all(region);
  const polylinesByLine = new Map();
  for (const row of trackRows) {
    const verts = parsePathVertices(row.path);
    if (verts.length >= 2) {
      if (!polylinesByLine.has(row.line_id)) polylinesByLine.set(row.line_id, []);
      polylinesByLine.get(row.line_id).push(verts);
    }
  }

  // G1: 세그먼트 각도 octolinear 비율
  let segTotal = 0;
  let segOcto = 0;
  for (const polylines of polylinesByLine.values()) {
    for (const verts of polylines) {
      for (let i = 0; i + 1 < verts.length; i += 1) {
        const deg = segmentAngleDeg(verts[i], verts[i + 1]);
        if (deg === null) continue;
        segTotal += 1;
        if (isOctolinearAngle(deg, options.angleTolerance)) {
          segOcto += 1;
        }
      }
    }
  }

  // G3: 역 노드 → 소속 노선 track 최단 거리
  const nodeRows = database
    .prepare(
      "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?",
    )
    .all(region);
  const distances = [];
  let nodesWithoutTrack = 0;
  for (const row of nodeRows) {
    const polylines = polylinesByLine.get(row.line_id);
    if (!polylines) {
      nodesWithoutTrack += 1;
      continue;
    }
    const d = pointToPolylinesDistance({ x: row.x, y: row.y }, polylines);
    distances.push(d);
  }
  distances.sort((a, b) => a - b);
  const aligned = distances.filter((d) => d <= options.alignThreshold).length;

  return {
    region,
    lines: polylinesByLine.size,
    g1: {
      segments: segTotal,
      octolinear: segOcto,
      octolinearRatio: segTotal ? segOcto / segTotal : 1,
    },
    g3: {
      nodes: nodeRows.length,
      nodesWithoutTrack,
      measured: distances.length,
      min: distances[0] ?? null,
      median: quantile(distances, 0.5),
      p90: quantile(distances, 0.9),
      max: distances[distances.length - 1] ?? null,
      alignedWithinThreshold: aligned,
      alignedRatio: distances.length ? aligned / distances.length : 1,
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { database, cleanup } = openPack(options.pack);
  try {
    const regions = database
      .prepare("SELECT DISTINCT region FROM route_map_line_tracks ORDER BY region")
      .all()
      .map((r) => r.region);
    const reports = regions.map((region) =>
      auditRegion(database, region, options),
    );
    if (options.json) {
      console.log(JSON.stringify({ artifactKind: "octolinearity-audit", options, reports }, null, 2));
      return;
    }
    console.log(
      `octolinearity 판정 (각도 오차 ±${options.angleTolerance}°, 정합 임계 ${options.alignThreshold})\n`,
    );
    for (const r of reports) {
      const octoPct = (r.g1.octolinearRatio * 100).toFixed(1);
      const alignPct = (r.g3.alignedRatio * 100).toFixed(1);
      console.log(
        `[${r.region}] 노선 ${r.lines}\n` +
          `  G1 octolinear: ${octoPct}% (${r.g1.octolinear}/${r.g1.segments} 세그먼트)\n` +
          `  G3 노드-선 거리: median ${fmt(r.g3.median)} · p90 ${fmt(r.g3.p90)} · max ${fmt(r.g3.max)} · ≤${options.alignThreshold} ${alignPct}% (${r.g3.alignedWithinThreshold}/${r.g3.measured})` +
          (r.g3.nodesWithoutTrack ? ` · track없는노드 ${r.g3.nodesWithoutTrack}` : "") +
          "\n",
      );
    }
  } finally {
    cleanup();
  }
}

function fmt(v) {
  return v === null ? "n/a" : v.toFixed(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
