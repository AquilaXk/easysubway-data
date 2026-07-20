#!/usr/bin/env node
// #2068 마감 감사(정량 게이트): 렌더되는 바탕(basemap) SVG의 **원본(raw)**
// 노선 간선을 렌더 좌표계에서 전수 검사한다. 오너 실기기 QA 반려(2026-07-18)
// 사유 — "간선이 8방향이되 커브 부분만 부드럽게 곡선처리하는게 원칙인데 이상한
// 모양인 간선과 노드에 위치하지 않는 간선이 너무 많음" — 을 정량으로 잡는
// 과소검출 방지 게이트다.
//
// 왜 raw SVG인가: 렌더 자산(seoul.vec)은 compile-basemap-vec.mjs가
// route-lines-layer의 **원본 path d**를 main-map-scaled-layer transform
// (translate(70 138) scale(0.455))과 함께 그대로 임베드해 만든다(octolinear
// 정리 전 원본). 따라서 화면에 보이는 간선은 원본 path이고, audit도 원본
// path를 렌더 좌표(root viewBox)로 변환해 재야 한다. extract-svg-geometry의
// stroke 추출은 octolinearizePolyline로 8선형 스냅을 이미 적용하므로 원본
// 이탈을 가려버린다 — 이 도구는 스냅 전 원본을 잰다.
//
// 두 게이트:
//  G-OCTO  route-line 그룹의 각 path 세그먼트를 직선(L/H/V/Z)·곡선(C/S/Q/T/A)로
//          분류한다. 직선 세그먼트의 방향각은 45° 배수(±angleTolerance)여야
//          한다(line-non-octolinear). 곡선은 정당한 코너 라운딩이면 각도 예외다
//          — 코너는 방향을 트므로 chord 각이 8선형이 아닌 게 정상. 단 chord
//          길이가 maxCornerChord 이상인 곡선은 코너가 아니라 하나의 간선 run을
//          곡선으로 그린 것("직선 구간을 곡선으로 뭉갠 경우")이므로 그 chord
//          방향이 8선형이 아니면 위반(curve-run-non-octolinear). 길이가 판별자다:
//          짧은 필렛은 예외, 긴 곡선은 run으로 보고 8선형을 강제.
//  G-NODE  전 역 노드(geometry.json stationNodes — 렌더 좌표, extractor의
//          getScreenCTM 전체 transform 합성 결과)에 대해, 소속 각 노선(dataLine
//          ∪ transferLines)의 원본 stroke까지 최근접 거리를 재고 nodeTolerance를
//          넘으면 위반. 환승역은 소속 노선 전부 검사.
//
// 좌표계: 모든 측정은 렌더(root viewBox) px. route-line path·그 조상에 개별
// transform이 없음을 실측 확인했으므로(main-map-scaled-layer 균일 scale+translate만
// 존재) 균일 affine 해석 변환이 정확하다 — 결정적이라 단위 테스트가 재현한다.
//
// 판정 순수 함수(segmentAngleDeg/isOctolinearAngle/pointToSegmentDistance/
// pointToPolylinesDistance)는 audit-octolinearity.mjs에서 재사용한다. CLI·예외
// 목록·JSON 산출 골격은 audit-station-euclidean-spacing.mjs와 동형이다.
//
// Usage: node tools/route-map/audit-octolinear-node-on-stroke.mjs
//          [--svg tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg]
//          [--geometry tools/route-map/route-map-defs/easy-subway-sma-v2-geometry.json]
//          [--angle-tolerance 0.5] [--min-segment-len 0.5]
//          [--max-corner-chord 20]
//          [--node-tolerance 1.365]
//          [--exceptions <file>] [--json out.json]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isOctolinearAngle,
  pointToPolylinesDistance,
  segmentAngleDeg,
} from "./audit-octolinearity.mjs";
import { repoRoot } from "./pack-io.mjs";

// ── SVG transform 파싱 (main-map-scaled-layer의 균일 scale + translate) ────────

/**
 * main-map-scaled-layer의 transform="translate(tx ty) scale(s)"에서 균일 변환을
 * 뽑는다. route-line path·조상엔 개별 transform이 없음이 실측 전제(감사 대상은
 * 이 레이어 자식뿐). 파싱 실패 시 오류.
 */
export function parseScaledLayerTransform(svgText) {
  const m = svgText.match(
    /<g\b(?=[^>]*\bid="main-map-scaled-layer")[^>]*\btransform="([^"]+)"/,
  );
  if (!m) throw new Error("main-map-scaled-layer transform을 찾지 못했습니다.");
  const t = m[1];
  const tr = t.match(/translate\(\s*(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)\s*\)/);
  const sc = t.match(/scale\(\s*(-?[\d.eE+-]+)\s*\)/);
  if (!tr || !sc) {
    throw new Error(`예상치 못한 scaled-layer transform: ${t}`);
  }
  return { tx: Number(tr[1]), ty: Number(tr[2]), scale: Number(sc[1]) };
}

/** 로컬(SVG 소스) 점을 렌더(root) 좌표로. */
export function toRenderPoint(pt, { tx, ty, scale }) {
  return { x: tx + scale * pt.x, y: ty + scale * pt.y };
}

// ── raw path 파서 (세그먼트 kind 보존: 직선/곡선/호) ─────────────────────────

const PATH_TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

/** path d를 토큰(명령 문자 또는 수)으로. */
function tokenizePath(d) {
  const out = [];
  for (const m of String(d).matchAll(PATH_TOKEN)) {
    out.push(m[1] ?? Number(m[2]));
  }
  return out;
}

/**
 * path d를 절대 좌표 세그먼트 목록으로 파싱한다(로컬 좌표). 각 세그먼트는
 * { kind: 'line'|'curve'|'arc', a, b, c1?, c2? }. 곡선(C/S/Q/T)은 3차 베지어
 * 제어점(c1,c2)까지 절대화해 담는다(flatness/접선 계산용). H/V/L/Z는 직선,
 * A는 arc(제어점 없음, chord만). S의 첫 제어점은 직전 곡선 제어점의 반사.
 */
export function parsePathSegments(d) {
  const tk = tokenizePath(d);
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = null;
  const segs = [];
  const num = () => tk[i++];
  while (i < tk.length) {
    if (typeof tk[i] === "string") {
      cmd = tk[i++];
    }
    if (cmd == null) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ax = cx;
    const ay = cy;
    if (C === "M") {
      cx = (rel ? cx : 0) + num();
      cy = (rel ? cy : 0) + num();
      sx = cx;
      sy = cy;
      cmd = rel ? "l" : "L"; // 후속 좌표쌍은 lineto
    } else if (C === "L") {
      cx = (rel ? cx : 0) + num();
      cy = (rel ? cy : 0) + num();
      segs.push({ kind: "line", a: { x: ax, y: ay }, b: { x: cx, y: cy } });
    } else if (C === "H") {
      cx = (rel ? cx : 0) + num();
      segs.push({ kind: "line", a: { x: ax, y: ay }, b: { x: cx, y: cy } });
    } else if (C === "V") {
      cy = (rel ? cy : 0) + num();
      segs.push({ kind: "line", a: { x: ax, y: ay }, b: { x: cx, y: cy } });
    } else if (C === "C") {
      const c1 = { x: (rel ? ax : 0) + num(), y: (rel ? ay : 0) + num() };
      const c2 = { x: (rel ? ax : 0) + num(), y: (rel ? ay : 0) + num() };
      cx = (rel ? ax : 0) + num();
      cy = (rel ? ay : 0) + num();
      segs.push({ kind: "curve", a: { x: ax, y: ay }, b: { x: cx, y: cy }, c1, c2 });
    } else if (C === "S") {
      const c2 = { x: (rel ? ax : 0) + num(), y: (rel ? ay : 0) + num() };
      cx = (rel ? ax : 0) + num();
      cy = (rel ? ay : 0) + num();
      const prev = segs.length ? segs[segs.length - 1] : null;
      const c1 =
        prev && prev.kind === "curve"
          ? { x: 2 * ax - prev.c2.x, y: 2 * ay - prev.c2.y }
          : { x: ax, y: ay };
      segs.push({ kind: "curve", a: { x: ax, y: ay }, b: { x: cx, y: cy }, c1, c2 });
    } else if (C === "Q") {
      const q = { x: (rel ? ax : 0) + num(), y: (rel ? ay : 0) + num() };
      cx = (rel ? ax : 0) + num();
      cy = (rel ? ay : 0) + num();
      // 2차→3차 승격: c1 = a + 2/3(q-a), c2 = b + 2/3(q-b)
      const c1 = { x: ax + (2 / 3) * (q.x - ax), y: ay + (2 / 3) * (q.y - ay) };
      const c2 = { x: cx + (2 / 3) * (q.x - cx), y: cy + (2 / 3) * (q.y - cy) };
      segs.push({ kind: "curve", a: { x: ax, y: ay }, b: { x: cx, y: cy }, c1, c2 });
    } else if (C === "T") {
      cx = (rel ? ax : 0) + num();
      cy = (rel ? ay : 0) + num();
      segs.push({
        kind: "curve",
        a: { x: ax, y: ay },
        b: { x: cx, y: cy },
        c1: { x: ax, y: ay },
        c2: { x: cx, y: cy },
      });
    } else if (C === "A") {
      num();
      num();
      num();
      num();
      num(); // rx ry x-rot large sweep
      cx = (rel ? ax : 0) + num();
      cy = (rel ? ay : 0) + num();
      segs.push({ kind: "arc", a: { x: ax, y: ay }, b: { x: cx, y: cy } });
    } else if (C === "Z") {
      segs.push({ kind: "line", a: { x: ax, y: ay }, b: { x: sx, y: sy } });
      cx = sx;
      cy = sy;
    } else {
      i += 1; // 알 수 없는 토큰 방어
    }
  }
  return segs;
}

// ── route-line 그룹 추출 ────────────────────────────────────────────────────

/** id="..." 위치의 <g> 요소를 균형 잡힌 깊이로 잘라 [start,end)와 여는 태그를 반환. */
function sliceGroup(svgText, startIdx) {
  const gStart = svgText.lastIndexOf("<g", startIdx);
  const openEnd = svgText.indexOf(">", startIdx);
  const openTag = svgText.slice(gStart, openEnd + 1);
  let depth = 0;
  let i = gStart;
  const re = /<g\b|<\/g>/g;
  re.lastIndex = i;
  for (let m = re.exec(svgText); m; m = re.exec(svgText)) {
    if (m[0] === "<g") depth += 1;
    else {
      depth -= 1;
      if (depth === 0) return { start: gStart, end: m.index + m[0].length, openTag };
    }
  }
  throw new Error("route-line 그룹의 닫는 </g>를 찾지 못했습니다.");
}

/**
 * route-lines-layer의 각 route-line-* 그룹에서 노선 간선 path를 뽑는다. 반환:
 * [{ lineId, segments }]. lineId는 그룹의 data-line. 한 그룹에 복수 path(본선+
 * 분기·급행)면 각각 별도 항목(같은 lineId). fill/stroke 표현 방식(속성형·style형)
 * 무관하게 그룹 안의 모든 <path d> 를 간선으로 본다(그룹 자체가 route-line).
 */
export function extractRouteLineStrokes(svgText) {
  const out = [];
  const groupRe = /<g\b[^>]*?\bid="route-line-[^"]*"[^>]*?>/g;
  for (let gm = groupRe.exec(svgText); gm; gm = groupRe.exec(svgText)) {
    const dlMatch = gm[0].match(/\bdata-line="([^"]*)"/);
    const lineId = dlMatch ? dlMatch[1] : "";
    const { start, end } = sliceGroup(svgText, gm.index);
    const block = svgText.slice(start, end);
    groupRe.lastIndex = end; // 그룹 내부의 중첩 route-line-* 오탐 방지(없지만 안전)
    const pathRe = /<path\b[^>]*?>/gs;
    for (let pm = pathRe.exec(block); pm; pm = pathRe.exec(block)) {
      const dm = pm[0].match(/\sd="([^"]*)"/s);
      if (!dm) continue;
      const segments = parsePathSegments(dm[1]);
      if (segments.length) out.push({ lineId, segments });
    }
  }
  return out;
}

// ── 베지어 샘플·flatness·접선 ───────────────────────────────────────────────

function cubicPoint(a, c1, c2, b, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * b.x,
    y: mt * mt * mt * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * b.y,
  };
}

/** 곡선 세그먼트를 n+1개 렌더 점으로 샘플. 직선/호는 두 끝점. */
export function sampleSegmentRender(seg, transform, n = 8) {
  const A = toRenderPoint(seg.a, transform);
  const B = toRenderPoint(seg.b, transform);
  if (seg.kind !== "curve") return [A, B];
  const c1 = toRenderPoint(seg.c1, transform);
  const c2 = toRenderPoint(seg.c2, transform);
  const pts = [];
  for (let k = 0; k <= n; k += 1) pts.push(cubicPoint(A, c1, c2, B, k / n));
  return pts;
}

/** 곡선의 chord(끝점 직선) 대비 최대 수직 이탈(렌더 px). 굽은 정도. */
export function curveFlatnessPx(seg, transform, n = 12) {
  const pts = sampleSegmentRender(seg, transform, n);
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  let best = 0;
  for (let k = 1; k < pts.length - 1; k += 1) {
    const p = pts[k];
    const d =
      L < 1e-9
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
    if (d > best) best = d;
  }
  return best;
}

function renderLenPx(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ── G-OCTO: 8선형 위반 ──────────────────────────────────────────────────────

/**
 * 노선 stroke 목록의 8선형 위반을 렌더 좌표에서 전수 산출한다. 반환 위반 종류:
 *  - line-non-octolinear     : 직선 세그먼트 각이 45° 배수에서 이탈
 *  - flat-curve-non-octolinear: 사실상 평평한 곡선의 chord 각이 8선형 아님
 *  - curve-too-long          : 굽은 곡선 chord가 maxCornerChord 초과(직선을 곡선으로 뭉갬)
 *  - curve-tangent-non-octolinear: 곡선 진입/이탈 접선이 8선형 아님
 */
export function findOctolinearViolations(strokes, transform, opts = {}) {
  const {
    angleToleranceDeg = 0.5,
    minSegmentLenPx = 0.5,
    maxCornerChordPx = 20,
  } = opts;
  const violations = [];
  const offDeg = (deg) => {
    if (deg === null) return 0;
    let best = 90;
    for (const t of [0, 45, 90, 135, 180]) best = Math.min(best, Math.abs(deg - t));
    return Math.round(best * 1000) / 1000;
  };
  for (const { lineId, segments } of strokes) {
    for (const seg of segments) {
      const a = toRenderPoint(seg.a, transform);
      const b = toRenderPoint(seg.b, transform);
      const lenPx = renderLenPx(a, b);
      if (seg.kind === "line" || seg.kind === "arc") {
        if (lenPx < minSegmentLenPx) continue;
        const deg = segmentAngleDeg(a, b);
        if (!isOctolinearAngle(deg, angleToleranceDeg)) {
          violations.push({
            lineId,
            kind: seg.kind === "arc" ? "arc-non-octolinear" : "line-non-octolinear",
            angleDeg: deg === null ? null : Math.round(deg * 1000) / 1000,
            offDeg: offDeg(deg),
            lengthPx: Math.round(lenPx * 100) / 100,
            from: { x: Math.round(a.x * 100) / 100, y: Math.round(a.y * 100) / 100 },
            to: { x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100 },
          });
        }
        continue;
      }
      // 곡선. 길이가 코너 라운딩(maxCornerChord)보다 짧으면 정당한 코너 곡선으로
      // 보아 예외 처리한다 — 코너는 방향을 트므로 chord 각이 8선형이 아닌 게
      // 정상이다(45° 전환 코너의 chord는 ~22.5°). 반대로 chord가 maxCornerChord
      // 이상으로 길면 그것은 코너가 아니라 하나의 간선 run을 곡선 명령으로 그린
      // 것이므로("직선 구간을 곡선으로 뭉갠 경우") 그 chord 방향은 반드시 8선형
      // 이어야 한다. 렌더 stroke 폭(~2.73px) 대비 20px chord는 이미 폭의 7배로,
      // 정당한 코너 필렛의 상한을 넉넉히 넘는다(실측 근거: 오너 도식의 코너
      // 필렛 chord는 대부분 6px 안팎, 20px↑ 비8선형 곡선은 전부 사선 간선).
      if (lenPx >= maxCornerChordPx) {
        const deg = segmentAngleDeg(a, b);
        if (!isOctolinearAngle(deg, angleToleranceDeg)) {
          violations.push({
            lineId,
            kind: "curve-run-non-octolinear",
            angleDeg: deg === null ? null : Math.round(deg * 1000) / 1000,
            offDeg: offDeg(deg),
            lengthPx: Math.round(lenPx * 100) / 100,
            flatnessPx: Math.round(curveFlatnessPx(seg, transform) * 100) / 100,
            from: { x: Math.round(a.x * 100) / 100, y: Math.round(a.y * 100) / 100 },
            to: { x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100 },
          });
        }
      }
    }
  }
  return violations;
}

// ── G-NODE: 노드-간선 정합 위반 ─────────────────────────────────────────────

/** transferLines 문자열을 토큰 배열로(공백/쉼표 구분). */
function lineTokens(node) {
  const set = new Set();
  if (node.dataLine) set.add(node.dataLine);
  const tl = node.transferLines || "";
  for (const t of tl.split(/[\s,]+/)) if (t) set.add(t);
  return [...set];
}

/** strokes를 lineId → 렌더 좌표 polyline 배열로 샘플(node 거리 측정용). */
export function renderPolylinesByLine(strokes, transform) {
  const byLine = new Map();
  for (const { lineId, segments } of strokes) {
    if (!byLine.has(lineId)) byLine.set(lineId, []);
    const polylines = byLine.get(lineId);
    for (const seg of segments) polylines.push(sampleSegmentRender(seg, transform));
  }
  return byLine;
}

// 환승 캡슐 멤버의 "정당한 병렬 오프셋" 허용 한계(렌더 px) — 캡슐 반폭 실측치
// (memory: kRouteMapBasemapTransferCapsuleHalfWidthPx=13.0, #2068 designScale
// 실측). transfer 역할 노드는 캡슐 안에서 소속 노선별로 중심에서 최대 이
// 거리까지 벌어져도 정당한 시각 배치다 — ordinary/terminal(기본
// nodeTolerancePx, 렌더 stroke 반폭)보다 넓은 별도 허용치를 둔다.
const DEFAULT_TRANSFER_NODE_TOLERANCE_PX = 13;

/**
 * 전 역 노드에 대해 소속 각 노선 stroke까지 최근접 거리를 재 tolerance 초과를
 * 위반으로 산출한다. role별 tolerance: transfer는 캡슐 반폭(넓게), 그 외
 * (ordinary/terminal)는 nodeTolerancePx(좁게, stroke 반폭 근사).
 *
 * 중복 마커 대응(#2068 실측, 2026-07-18): 오너 SVG에 사전 존재하는 중복 요소
 * (정왕·한대앞처럼 같은 역·같은 노선 조합을 가리키는 <g> 배지가 여러 개 —
 * 이 도구가 만든 게 아니라 HEAD에 이미 있던 편집 잔여물)가 있으면 같은
 * (역,노선) 조합의 최소 거리를 그 조합의 "진짜 마커" 판정으로 채택한다.
 * 중복 자체를 숨기지 않는다 — 서로 다른 위치의 각 요소가 최소 하나만 stroke에
 * 붙어 있으면 되는 것이지, 잔여 중복 요소 개수만큼 허위로 노선이탈 위반을
 * 부풀리지 않는다는 뜻이다. 반환 { violations, checks, unmappable }. checks는
 * 중복 제거 후 고유 (역,노선) 조합 수.
 */
export function findNodeOffStrokeViolations(nodes, polylinesByLine, opts = {}) {
  const {
    nodeTolerancePx = 1.365,
    transferNodeTolerancePx = DEFAULT_TRANSFER_NODE_TOLERANCE_PX,
  } = opts;
  const best = new Map(); // "station|lineId" -> 최소 거리 판정
  let unmappable = 0;
  for (const node of nodes) {
    const lines = lineTokens(node);
    if (lines.length === 0) {
      unmappable += 1;
      continue;
    }
    const station = node.dataStation || node.dataName || node.id;
    for (const lineId of lines) {
      const polylines = polylinesByLine.get(lineId);
      if (!polylines || polylines.length === 0) {
        unmappable += 1;
        continue;
      }
      const dist = pointToPolylinesDistance({ x: node.x, y: node.y }, polylines);
      const key = `${station}|${lineId}`;
      const prev = best.get(key);
      if (!prev || dist < prev.dist) {
        best.set(key, { station, lineId, dist, nodeRole: node.nodeRole || "", x: node.x, y: node.y });
      }
    }
  }
  const violations = [];
  for (const { station, lineId, dist, nodeRole, x, y } of best.values()) {
    const tolerance = nodeRole === "transfer" ? transferNodeTolerancePx : nodeTolerancePx;
    if (dist > tolerance) {
      violations.push({
        station,
        lineId,
        nodeRole,
        distPx: Math.round(dist * 100) / 100,
        tolerancePx: tolerance,
        x,
        y,
      });
    }
  }
  violations.sort((p, q) => q.distPx - p.distPx);
  return { violations, checks: best.size, unmappable };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    svg: "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg",
    geometry: "tools/route-map/route-map-defs/easy-subway-sma-v2-geometry.json",
    angleTolerance: 0.5,
    minSegmentLen: 0.5,
    maxCornerChord: 20,
    nodeTolerance: 1.365,
    transferNodeTolerance: DEFAULT_TRANSFER_NODE_TOLERANCE_PX,
    exceptions: null,
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--svg": o.svg = argv[++i]; break;
      case "--geometry": o.geometry = argv[++i]; break;
      case "--angle-tolerance": o.angleTolerance = Number(argv[++i]); break;
      case "--min-segment-len": o.minSegmentLen = Number(argv[++i]); break;
      case "--max-corner-chord": o.maxCornerChord = Number(argv[++i]); break;
      case "--node-tolerance": o.nodeTolerance = Number(argv[++i]); break;
      case "--transfer-node-tolerance": o.transferNodeTolerance = Number(argv[++i]); break;
      case "--exceptions": o.exceptions = argv[++i]; break;
      case "--json": o.json = argv[++i]; break;
    }
  }
  return o;
}

function resolveRepo(p) {
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const svgText = readFileSync(resolveRepo(o.svg), "utf8");
  const geometry = JSON.parse(readFileSync(resolveRepo(o.geometry), "utf8"));
  const transform = parseScaledLayerTransform(svgText);
  const strokes = extractRouteLineStrokes(svgText);

  const exceptions =
    o.exceptions && existsSync(resolveRepo(o.exceptions))
      ? JSON.parse(readFileSync(resolveRepo(o.exceptions), "utf8"))
      : { octolinear: [], nodeOnStroke: [] };

  const octoAll = findOctolinearViolations(strokes, transform, {
    angleToleranceDeg: o.angleTolerance,
    minSegmentLenPx: o.minSegmentLen,
    maxCornerChordPx: o.maxCornerChord,
  });
  const polylinesByLine = renderPolylinesByLine(strokes, transform);
  const nodeResult = findNodeOffStrokeViolations(
    geometry.stationNodes ?? [],
    polylinesByLine,
    { nodeTolerancePx: o.nodeTolerance, transferNodeTolerancePx: o.transferNodeTolerance },
  );

  const octoByKind = {};
  for (const v of octoAll) octoByKind[v.kind] = (octoByKind[v.kind] ?? 0) + 1;

  console.log(
    `[8선형] route-line stroke ${strokes.length}개 · 위반 ${octoAll.length}건 ` +
      `(${Object.entries(octoByKind).map(([k, n]) => `${k}:${n}`).join(" · ") || "0"})`,
  );
  console.log(
    `[노드-간선] 검사 ${nodeResult.checks}쌍 · 위반(>${o.nodeTolerance}px) ` +
      `${nodeResult.violations.length}건 · 미매핑 ${nodeResult.unmappable}`,
  );

  if (octoAll.length) {
    console.log("  8선형 위반 상위(각도이탈·길이):");
    for (const v of octoAll
      .slice()
      .sort((p, q) => (q.offDeg ?? 0) - (p.offDeg ?? 0) || (q.lengthPx ?? 0) - (p.lengthPx ?? 0))
      .slice(0, 20)) {
      console.log(
        `    ${v.kind}\t${v.lineId}\t${v.offDeg ?? "-"}°\t${v.lengthPx ?? "-"}px`,
      );
    }
  }
  if (nodeResult.violations.length) {
    console.log("  노드-간선 이탈 상위:");
    for (const v of nodeResult.violations.slice(0, 20)) {
      console.log(`    ${v.distPx}px\t${v.lineId}\t${v.station}\t(${v.nodeRole})`);
    }
  }

  if (o.json) {
    writeFileSync(
      resolveRepo(o.json),
      JSON.stringify(
        {
          transform,
          strokeCount: strokes.length,
          octolinear: { total: octoAll.length, byKind: octoByKind, violations: octoAll },
          nodeOnStroke: {
            tolerancePx: o.nodeTolerance,
            checks: nodeResult.checks,
            unmappable: nodeResult.unmappable,
            total: nodeResult.violations.length,
            violations: nodeResult.violations,
          },
        },
        null,
        2,
      ) + "\n",
    );
  }

  const octoUnlisted = octoAll.length - (exceptions.octolinear?.length ?? 0);
  const nodeUnlisted =
    nodeResult.violations.length - (exceptions.nodeOnStroke?.length ?? 0);
  if (octoUnlisted > 0 || nodeUnlisted > 0) {
    console.error(
      `감사 실패 — 8선형 미등재 ${Math.max(0, octoUnlisted)} · 노드-간선 미등재 ${Math.max(0, nodeUnlisted)}`,
    );
    process.exit(1);
  }
  console.log("감사 통과 (8선형·노드-간선 위반 0).");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
