#!/usr/bin/env node
// #2068 2차 QA 반려(오너, 2026-07-18) 대응 — "간선 겹침·노드에서 곡선 나옴"을
// 정량 게이트로 못박는다(audit-octolinear-node-on-stroke.mjs의 자매 감사).
// 직전 라운드는 노드 고정 + 역쌍마다 독립 dogleg으로 8선형 수치(0)는 맞췄지만
// 노선도 문법(굵직한 직선 + 드문 코너, 노드는 직선 통과, corridor 겹침 없음)을
// 어겼다 — 이 도구는 relayout-svg-route-lines.mjs가 만든 결과를 검증한다.
//
// 두 게이트:
//  G-NODE-STRAIGHT  모든 역 노드(환승 캡슐 포함)에서 그 노드가 걸린 stroke가
//                    노드 자신으로부터 최소 직선 여유(minClearancePx) 안쪽에
//                    코너(곡선 정점 또는 8선형 이탈 꺾임)를 갖지 않는지 검사한다.
//                    "노드에서 곡선이 나온다" 반려의 정량화 — 노드 근접부 stroke
//                    세그먼트가 8선형이고, 그 세그먼트 길이가 minClearancePx
//                    이상이어야 한다(=필렛/코너가 노드 바로 옆에 없다는 뜻).
//  G-OVERLAP         서로 다른 stroke(다른 노선, 또는 같은 노선의 다른 run)의
//                    세그먼트가 겹치면(공선+ 구간 겹침, 평행 병주가 아니라 진짜
//                    포개짐) 위반. 병렬 corridor(다른 offset으로 갈라진 번들)는
//                    겹침이 아니다 — 최소 분리 간격(minSeparationPx, corridor
//                    번들 오프셋 관례 절반)을 넘겨야 통과.
//
// Usage: node tools/route-map/audit-route-line-layout-quality.mjs
//          [--svg tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg]
//          [--geometry tools/route-map/route-map-defs/easy-subway-sma-v2-geometry.json]
//          [--min-clearance 6] [--min-separation 2] [--json out.json]

import { isMainModule } from "../lib/is-main-module.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  extractRouteLineStrokes,
  parseScaledLayerTransform,
  sampleSegmentRender,
} from "./audit-octolinear-node-on-stroke.mjs";
import { isOctolinearAngle, pointToSegmentDistance, segmentAngleDeg } from "./audit-octolinearity.mjs";
import { repoRoot } from "./pack-io.mjs";

function resolveRepo(p) {
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

// ── G-NODE-STRAIGHT: 노드 직선 통과 ──────────────────────────────────────────

/** strokes를 lineId → [{a,b,kind}] 렌더 세그먼트 목록으로 편다(직선/곡선
 *  구분 유지 — 곡선은 8선형 판정에서 항상 "코너"로 취급). */
function flattenSegments(strokes, transform) {
  const byLine = new Map();
  for (const { lineId, segments } of strokes) {
    if (!byLine.has(lineId)) byLine.set(lineId, []);
    const list = byLine.get(lineId);
    for (const seg of segments) {
      const pts = sampleSegmentRender(seg, transform, seg.kind === "curve" ? 8 : 1);
      const a = pts[0];
      const b = pts[pts.length - 1];
      list.push({ a, b, kind: seg.kind, curvePts: seg.kind === "curve" ? pts : null });
    }
  }
  return byLine;
}

/**
 * 노드(x,y)가 걸린 노선(lineId)의 stroke에서, 노드에 가장 가까운 지점을 지나는
 * "직선 세그먼트"의 길이가 minClearancePx 이상인지 검사한다. 노드 최근접점이
 * 곡선(curve) 세그먼트 위에 있으면 그 자체로 위반(노드에서 바로 곡선이 시작).
 * 노드 최근접점이 직선 세그먼트 위에 있어도, 그 직선 세그먼트 길이가
 * minClearancePx보다 짧으면(=노드 바로 옆이 곧 코너) 위반.
 * 반환: violations 배열.
 */
export function findNodeStraightPassthroughViolations(nodes, segmentsByLine, opts = {}) {
  const { minClearancePx = 6 } = opts;
  const violations = [];
  const checked = new Set();
  for (const node of nodes) {
    const lines = new Set();
    if (node.dataLine) lines.add(node.dataLine);
    for (const t of String(node.transferLines || "").split(/[\s,]+/)) if (t) lines.add(t);
    const station = node.dataStation || node.dataName || node.id;
    for (const lineId of lines) {
      const key = `${station}|${lineId}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const segs = segmentsByLine.get(lineId);
      if (!segs || segs.length === 0) continue;
      let best = null;
      let bestDist = Infinity;
      for (const seg of segs) {
        const d = pointToSegmentDistance({ x: node.x, y: node.y }, seg.a, seg.b);
        if (d < bestDist) {
          bestDist = d;
          best = seg;
        }
      }
      if (!best || bestDist > 20) continue; // 이 노선과 무관한 노드(정합은 별도 게이트).
      if (best.kind === "curve") {
        violations.push({
          station,
          lineId,
          reason: "node-on-curve",
          detail: "노드 최근접점이 곡선 세그먼트 위 — 노드에서 바로 곡선 시작",
        });
        continue;
      }
      const segLen = Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y);
      if (segLen < minClearancePx) {
        violations.push({
          station,
          lineId,
          reason: "short-straight-lead",
          detail: `직선 리드 길이 ${segLen.toFixed(2)}px < ${minClearancePx}px`,
          segLenPx: Math.round(segLen * 100) / 100,
        });
      }
    }
  }
  return violations;
}

// ── G-OVERLAP: 간선 겹침 ─────────────────────────────────────────────────────

/** 두 세그먼트가 공선(같은 무한직선 위)이고 along-축으로 구간이 겹치는지, 겹치면
 *  그 겹침부의 최소 수직 분리 간격(0이면 완전 포개짐)을 반환. 공선 아니면 null. */
export function collinearOverlap(segA, segB, angleTolDeg = 0.5) {
  const degA = segmentAngleDeg(segA.a, segA.b);
  const degB = segmentAngleDeg(segB.a, segB.b);
  if (degA === null || degB === null) return null;
  let diff = Math.abs(degA - degB);
  if (diff > 90) diff = 180 - diff;
  if (diff > angleTolDeg) return null; // 방향이 다르면 평행/공선 아님(교차는 별도 게이트).
  // A의 직선 방정식 기준 B 양끝의 수직거리(공선이면 거의 0).
  // pointToSegmentDistance는 clamp된 최단거리라 무한직선 판정엔 부적합하므로
  // 직접 무한직선까지 수직거리를 계산한다.
  const ang = (degA * Math.PI) / 180;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const vx = -uy;
  const vy = ux;
  const perpOf = (p) => Math.abs((p.x - segA.a.x) * vx + (p.y - segA.a.y) * vy);
  const perpDist = Math.max(perpOf(segB.a), perpOf(segB.b));
  if (perpDist > 3) return null; // 같은 직선 위가 아님(다른 corridor).
  // along 축 투영으로 구간 겹침 판정.
  const alongOf = (p) => (p.x - segA.a.x) * ux + (p.y - segA.a.y) * uy;
  const a0 = 0;
  const a1 = alongOf(segA.b);
  const [aMin, aMax] = a0 < a1 ? [a0, a1] : [a1, a0];
  const b0 = alongOf(segB.a);
  const b1 = alongOf(segB.b);
  const [bMin, bMax] = b0 < b1 ? [b0, b1] : [b1, b0];
  const overlapLen = Math.min(aMax, bMax) - Math.max(aMin, bMin);
  if (overlapLen <= 0) return null;
  return { overlapLenPx: overlapLen, separationPx: perpDist };
}

/**
 * 서로 다른 lineId(또는 같은 lineId의 서로 다른 stroke 인스턴스 — 호출부가
 * segmentsByLine 키를 "lineId#run인덱스"처럼 세분해 넘기면 같은 노선 내 run간
 * 겹침도 잡을 수 있다) stroke가 공선+구간겹침이면서 분리간격이
 * minSeparationPx 미만이면 위반으로 산출한다. 반환: violations.
 */
export function findLineOverlapViolations(segmentsByLine, opts = {}) {
  const { minSeparationPx = 2 } = opts;
  const violations = [];
  const lineIds = [...segmentsByLine.keys()];
  for (let i = 0; i < lineIds.length; i += 1) {
    for (let j = i + 1; j < lineIds.length; j += 1) {
      const idA = lineIds[i];
      const idB = lineIds[j];
      for (const segA of segmentsByLine.get(idA)) {
        if (segA.kind !== "line") continue;
        for (const segB of segmentsByLine.get(idB)) {
          if (segB.kind !== "line") continue;
          const ov = collinearOverlap(segA, segB);
          if (ov && ov.separationPx < minSeparationPx && ov.overlapLenPx > 1) {
            violations.push({
              lineA: idA,
              lineB: idB,
              overlapLenPx: Math.round(ov.overlapLenPx * 100) / 100,
              separationPx: Math.round(ov.separationPx * 100) / 100,
              at: { x: Math.round(segA.a.x * 10) / 10, y: Math.round(segA.a.y * 10) / 10 },
            });
          }
        }
      }
    }
  }
  return violations;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    svg: "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg",
    geometry: "tools/route-map/route-map-defs/easy-subway-sma-v2-geometry.json",
    minClearance: 6,
    minSeparation: 2,
    exceptions: null,
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--svg": o.svg = argv[++i]; break;
      case "--geometry": o.geometry = argv[++i]; break;
      case "--min-clearance": o.minClearance = Number(argv[++i]); break;
      case "--min-separation": o.minSeparation = Number(argv[++i]); break;
      case "--exceptions": o.exceptions = argv[++i]; break;
      case "--json": o.json = argv[++i]; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const svgText = readFileSync(resolveRepo(o.svg), "utf8");
  const geometry = JSON.parse(readFileSync(resolveRepo(o.geometry), "utf8"));
  const transform = parseScaledLayerTransform(svgText);
  const strokes = extractRouteLineStrokes(svgText);
  const segmentsByLine = flattenSegments(strokes, transform);

  const nodeViolations = findNodeStraightPassthroughViolations(
    geometry.stationNodes ?? [],
    segmentsByLine,
    { minClearancePx: o.minClearance },
  );
  const overlapViolations = findLineOverlapViolations(segmentsByLine, {
    minSeparationPx: o.minSeparation,
  });

  const exceptions =
    o.exceptions && existsSync(resolveRepo(o.exceptions))
      ? JSON.parse(readFileSync(resolveRepo(o.exceptions), "utf8"))
      : { nodeStraight: [], overlap: [] };

  console.log(
    `[노드 직선통과] 위반 ${nodeViolations.length}건(clearance ${o.minClearance}px) · ` +
      `[간선 겹침] 위반 ${overlapViolations.length}건(separation ${o.minSeparation}px)`,
  );
  if (nodeViolations.length) {
    console.log("  노드 직선통과 위반 상위:");
    for (const v of nodeViolations.slice(0, 20)) {
      console.log(`    ${v.station}\t${v.lineId}\t${v.reason}\t${v.detail}`);
    }
  }
  if (overlapViolations.length) {
    console.log("  간선 겹침 위반 상위:");
    for (const v of overlapViolations.slice(0, 20)) {
      console.log(
        `    ${v.lineA} × ${v.lineB}\t길이${v.overlapLenPx}px\t간격${v.separationPx}px\tat(${v.at.x},${v.at.y})`,
      );
    }
  }

  if (o.json) {
    writeFileSync(
      resolveRepo(o.json),
      JSON.stringify(
        {
          nodeStraight: { tolerancePx: o.minClearance, total: nodeViolations.length, violations: nodeViolations },
          overlap: { tolerancePx: o.minSeparation, total: overlapViolations.length, violations: overlapViolations },
        },
        null,
        2,
      ) + "\n",
    );
  }

  const nodeUnlisted = nodeViolations.length - (exceptions.nodeStraight?.length ?? 0);
  const overlapUnlisted = overlapViolations.length - (exceptions.overlap?.length ?? 0);
  if (nodeUnlisted > 0 || overlapUnlisted > 0) {
    console.error(
      `감사 실패 — 노드직선통과 미등재 ${Math.max(0, nodeUnlisted)} · 간선겹침 미등재 ${Math.max(0, overlapUnlisted)}`,
    );
    process.exit(1);
  }
  console.log("감사 통과 (노드 직선통과·간선 겹침 위반 0).");
}

if (isMainModule(import.meta.url)) {
  main();
}
