#!/usr/bin/env node
// #1789 재간격 감사: 간격 분포(p95/p5)·교차 증가·8선형 위반을 기계 판정한다.
// 인접 판정은 line_sequence가 아니라 track arc-length(Task 4 chains) 기준이라
// 1호선 분기의 가짜 인접쌍(오산—인천 등)이 원천 배제된다.
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  loadRegionRespaceGraph,
  medianStationChainLength,
} from "./respace-route-map.mjs";
import { cleanupPackDir, openPack, repoRoot } from "./pack-io.mjs";

/** hasStationEnds chain arc length 분포 (nearest-rank 분위수). */
export function chainLengthStats(graph) {
  const lens = graph.chains
    .filter((c) => c.hasStationEnds)
    .map((c) => {
      let s = 0;
      for (let i = 1; i < c.nodeIds.length; i += 1) {
        const a = graph.nodes[c.nodeIds[i - 1]];
        const b = graph.nodes[c.nodeIds[i]];
        s += Math.hypot(a.x - b.x, a.y - b.y);
      }
      return s;
    })
    .sort((a, b) => a - b);
  const n = lens.length;
  if (n === 0) {
    return { count: 0, p5: 0, p25: 0, median: 0, p75: 0, p95: 0, max: 0, p95OverP5: 0 };
  }
  const pct = (q) => lens[Math.max(0, Math.min(n - 1, Math.ceil(q * n) - 1))];
  const p5 = pct(0.05);
  const p95 = pct(0.95);
  return {
    count: n,
    p5,
    p25: pct(0.25),
    median: pct(0.5),
    p75: pct(0.75),
    p95,
    max: lens[n - 1],
    p95OverP5: p5 > 0 ? p95 / p5 : 0,
  };
}

function orient(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function properIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/** properIntersect가 참일 때 교차점 좌표 — 아니면 null. */
function intersectionPoint(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  const proper =
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  if (!proper) return null;
  const t = d1 / (d1 - d2);
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/** cluster 중심 목록 — positions는 graph.nodes와 같은 길이의 좌표 배열. */
export function clusterCentroids(graph, positions) {
  return graph.clusters.map((cluster) => {
    let cx = 0;
    let cy = 0;
    for (const m of cluster.members) {
      cx += positions[m.nodeId].x - m.offset.x;
      cy += positions[m.nodeId].y - m.offset.y;
    }
    return { x: cx / cluster.members.length, y: cy / cluster.members.length };
  });
}

/**
 * 교차 3분류(#1789 원인 ③): 환승매듭(cluster 근접)은 구조적·실기기 시각 판정
 * 대상이고, 그중 coverRadius 내는 환승 캡슐이 가려 화면에 안 보인다. 게이트는
 * 자유공간 엉킴(free)만 수치로 잡는다.
 *
 * freeAllowlist(선택, #2068 부산 부전 — 오너 확정 2026-07-20): 좌표·노선쌍으로
 * 정밀하게 특정한 "실제 무환승 교차"(환승역이 아닌데 두 노선이 그냥 지나가며
 * 만나는 지점 — 데이터 결함이 아니라 오너가 그렇게 그린 실제 지리)를 free
 * 카운트에서 제외한다. trackLineIds(각 트랙의 line_id, tracksPoints와 병렬)를
 * 함께 줘야 노선쌍 매칭이 가능하다 — 포괄 완화가 아니라 (lineIds 쌍 + 좌표
 * 반경) 둘 다 일치해야만 제외되는 정밀 예외.
 */
export function classifyCrossings(
  tracksPoints,
  centroids,
  { knotRadius, coverRadius = 17, trackLineIds = null, freeAllowlist = [] },
) {
  const segs = [];
  for (let ti = 0; ti < tracksPoints.length; ti += 1) {
    const pts = tracksPoints[ti];
    for (let i = 1; i < pts.length; i += 1) {
      segs.push({ ti, a: pts[i - 1], b: pts[i] });
    }
  }
  const matchesAllowlist = (pt, lineIdA, lineIdB) => {
    if (!trackLineIds || lineIdA == null || lineIdB == null) return false;
    for (const entry of freeAllowlist) {
      const [x, y] = entry.lineIds;
      const pairMatches =
        (lineIdA === x && lineIdB === y) || (lineIdA === y && lineIdB === x);
      if (!pairMatches) continue;
      const d = Math.hypot(pt.x - entry.point.x, pt.y - entry.point.y);
      if (d <= (entry.toleranceRadius ?? 50)) return true;
    }
    return false;
  };
  let free = 0;
  let freeAllowlisted = 0;
  let knotCovered = 0;
  let knotVisible = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (segs[i].ti === segs[j].ti) continue;
      const shared = [segs[i].a, segs[i].b].some((p) =>
        [segs[j].a, segs[j].b].some(
          (q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6,
        ),
      );
      if (shared) continue;
      const pt = intersectionPoint(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      if (!pt) continue;
      let nearest = Infinity;
      for (const c of centroids) {
        const d = Math.hypot(pt.x - c.x, pt.y - c.y);
        if (d < nearest) nearest = d;
      }
      if (nearest < coverRadius) knotCovered += 1;
      else if (nearest < knotRadius) knotVisible += 1;
      else if (
        matchesAllowlist(
          pt,
          trackLineIds?.[segs[i].ti],
          trackLineIds?.[segs[j].ti],
        )
      ) {
        freeAllowlisted += 1;
      } else free += 1;
    }
  }
  return {
    free,
    freeAllowlisted,
    knotCovered,
    knotVisible,
    knot: knotCovered + knotVisible,
    total: free + knotCovered + knotVisible + freeAllowlisted,
  };
}

/** 서로 다른 폴리라인 간 순수 교차 수(공유 끝점·collinear 접촉 제외). */
export function segmentCrossingCount(tracksPoints) {
  const segs = [];
  for (let ti = 0; ti < tracksPoints.length; ti += 1) {
    const pts = tracksPoints[ti];
    for (let i = 1; i < pts.length; i += 1) {
      segs.push({ ti, a: pts[i - 1], b: pts[i] });
    }
  }
  let count = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (segs[i].ti === segs[j].ti) continue;
      const shared = [segs[i].a, segs[i].b].some((p) =>
        [segs[j].a, segs[j].b].some(
          (q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6,
        ),
      );
      if (shared) continue;
      if (properIntersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) {
        count += 1;
      }
    }
  }
  return count;
}

/** 45° 배수에서 tolerance 초과 이탈한 선분 목록(0-길이 무시). segIdx는 선분 index. */
export function octolinearityViolations(tracksPoints, { toleranceDeg = 0.5 } = {}) {
  const out = [];
  for (let ti = 0; ti < tracksPoints.length; ti += 1) {
    const pts = tracksPoints[ti];
    for (let i = 1; i < pts.length; i += 1) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      if (Math.hypot(dx, dy) === 0) continue;
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      const mod = ((ang % 45) + 45) % 45;
      const dev = Math.min(mod, 45 - mod);
      if (dev > toleranceDeg) {
        out.push({ trackIdx: ti, segIdx: i - 1, angleDeg: ang });
      }
    }
  }
  return out;
}

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    region: "수도권",
    json: null,
    compare: null,
    // 2026-07-06 스윕 실측(sweep-respacing.mjs): kAnchor=0.1, maxRatio=1.8 →
    // free=26, octo=11, p95/p5=6.6 — 게이트는 이 실측치 + 소여유(p95/p5 +0.5, free +2).
    maxP95p5: 7.1,
    maxFree: 28,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": o.pack = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--json": o.json = argv[++i]; break;
      case "--compare": o.compare = argv[++i]; break;
      case "--max-p95p5": o.maxP95p5 = Number(argv[++i]); break;
      case "--max-free": o.maxFree = Number(argv[++i]); break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir } = openPack(o.pack, "audit-spacing-");
  try {
    const graph = loadRegionRespaceGraph(db, o.region);
    // graph 노드 재구성으로 통일 — 재간격 솔버가 팩 path를 graph 노드로 재작성하므로
    // before/after 감사를 동일 기반으로 맞춰야 게이트가 오염되지 않는다.
    const tracksPoints = graph.tracks
      .filter((t) => t.nodeIds.length)
      .map((t) => t.nodeIds.map((id) => graph.nodes[id]));
    const unit = medianStationChainLength(graph);
    const byClass = classifyCrossings(
      tracksPoints,
      clusterCentroids(graph, graph.nodes),
      { knotRadius: unit * 0.75 },
    );
    const report = {
      region: o.region,
      spacing: chainLengthStats(graph),
      crossings: byClass.total,
      crossingsByClass: byClass,
      octoViolations: octolinearityViolations(tracksPoints).length,
      warnings: graph.warnings.length,
    };
    const s = report.spacing;
    console.log(
      `[${o.region}] 간격 chain ${s.count} · median ${Math.round(s.median)} · ` +
        `p5 ${Math.round(s.p5)} · p95 ${Math.round(s.p95)} · p95/p5 ${s.p95OverP5.toFixed(1)}`,
    );
    console.log(
      `교차 ${report.crossings} (자유 ${byClass.free} · 매듭 가림 ${byClass.knotCovered} · ` +
        `매듭 노출 ${byClass.knotVisible}) · 8선형 위반 ${report.octoViolations} · ` +
        `투영 경고 ${report.warnings}`,
    );
    if (o.json) {
      writeFileSync(
        path.isAbsolute(o.json) ? o.json : path.join(repoRoot, o.json),
        JSON.stringify(report, null, 2) + "\n",
      );
    }
    if (o.compare) {
      const before = JSON.parse(
        readFileSync(
          path.isAbsolute(o.compare) ? o.compare : path.join(repoRoot, o.compare),
          "utf8",
        ),
      );
      const fails = [];
      if (report.octoViolations > before.octoViolations) {
        fails.push(`8선형 위반 증가 ${before.octoViolations}→${report.octoViolations}`);
      }
      if (report.spacing.p95OverP5 > o.maxP95p5) {
        fails.push(`간격 p95/p5 ${report.spacing.p95OverP5.toFixed(1)} > ${o.maxP95p5}`);
      }
      if (byClass.free > o.maxFree) {
        fails.push(`자유공간 교차 ${byClass.free} > ${o.maxFree}`);
      }
      const beforeVisible = before.crossingsByClass?.knotVisible;
      if (beforeVisible !== undefined) {
        console.log(
          `환승매듭 노출 ${beforeVisible}→${byClass.knotVisible} — 게이트 아님, 실기기 판정 대상`,
        );
      }
      if (fails.length) {
        console.error("감사 실패: " + fails.join(" · "));
        process.exit(1);
      }
      console.log("감사 통과 (8선형·간격·자유공간 교차 안전).");
    }
  } finally {
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
