#!/usr/bin/env node
// #2068 마감 Phase A: route-lines-layer의 raw path를 8선형(0/45/90/135°) run +
// 짧은 코너 필렛으로 재작도한다(오너 반려 2026-07-18: "간선이 8방향이되 커브
// 부분만 부드럽게 곡선처리"). 팩(route_map_positions — 이미 euclidean 간격
// 확정·유클리드 census 0)의 (station,line) 좌표를 진본으로 삼아 각 노선을
// line_sequence 순서로 잇는다. 연결 알고리즘은 octilinearSegment(#1789
// Stage1a — 이미 route_map_line_tracks에 실사용돼 G1 100% 검증됨)를 그대로
// 재사용해 8선형 이탈을 구조적으로(사후 감사가 아니라 작도 자체로) 0으로
// 만든다.
//
// 좌표 불변 원칙: 이 도구는 route_map_positions의 좌표를 절대 옮기지 않는다
// (조회만) — 선의 모양만 그 좌표에 맞춰 재작도한다("선을 노드에 맞춘다").
// 따라서 유클리드 census·라벨 위치·환승 캡슐은 이 스크립트만으로는 불변이다.
//
// 코너 처리(G-NODE 보존): octilinearSegment가 두 역 사이에 삽입하는 dogleg
// 코너점은 항상 "합성 정점"(실제 역이 아님)이다 — 이 합성 정점에만 짧은
// 원형근사 3차 베지어 필렛(chord ≈ 2×radius, 기본 radius=6 render px)을
// 입힌다. 실제 역 정점은 sharp(필렛 없음)로 통과시켜, 재작도한 stroke가 역
// 중심을 정확히 지나도록(G-NODE 거리 ≈0) 보장한다. 필렛 chord는 감사 도구의
// 코너 예외 임계(20px, audit-octolinear-node-on-stroke.mjs --max-corner-chord)
// 안에 넉넉히 들어가 8선형 판정에 걸리지 않는다.
//
// 분기(지선): line-branches.json(#1793 정본, 이미 프로덕션 route_map_line_tracks
// 생성에 쓰임)을 그대로 재사용 — 본선에서 spur 역을 제외하고 각 지선을
// junction에서 시작하는 별도 path로 그린다. 위상 좌표 이상치는
// splitAtOutlierGaps로 자동 분리해 장거리 오작도(교차 회귀)를 막는다(기존
// 도구와 동일 방어 — 재구현하지 않고 import).
//
// Usage: node tools/route-map/octolinearize-svg-route-lines.mjs
//          [--svg tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v4.svg]
//          [--pack apps/mobile/assets/datapacks/capital.sqlite.gz]
//          [--region 수도권] [--branches tools/route-map/line-branches.json]
//          [--fillet-radius 6] [--line <slug> ...] [--all] [--dry-run] [--check]

import { isMainModule } from "../lib/is-main-module.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveLineMap } from "./apply-sma-svg-positions.mjs";
import { octilinearSegment, splitAtOutlierGaps } from "./octolinearize-line-tracks.mjs";
import { openPack, cleanupPackDir, repoRoot } from "./pack-io.mjs";
import { SEOUL } from "./sma-region-configs.mjs";

function resolveRepo(p) {
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

// ── 좌표 변환(render ↔ SVG 소스 local) ──────────────────────────────────────

export function parseScaledLayerTransform(svgText) {
  const m = svgText.match(
    /<g\b(?=[^>]*\bid="main-map-scaled-layer")[^>]*\btransform="([^"]+)"/,
  );
  if (!m) throw new Error("main-map-scaled-layer transform을 찾지 못했습니다.");
  const t = m[1];
  const tr = t.match(/translate\(\s*(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)\s*\)/);
  const sc = t.match(/scale\(\s*(-?[\d.eE+-]+)\s*\)/);
  if (!tr || !sc) throw new Error(`예상치 못한 scaled-layer transform: ${t}`);
  return { tx: Number(tr[1]), ty: Number(tr[2]), scale: Number(sc[1]) };
}

function toLocal(p, { tx, ty, scale }) {
  return { x: (p.x - tx) / scale, y: (p.y - ty) / scale };
}

// ── 8선형 정점(dogleg 합성 정점 표시) ────────────────────────────────────────

/**
 * 역(run) 순서 목록을 octilinearSegment로 이어 정점 배열을 만든다. 각 정점에
 * synthetic(합성 dogleg 코너 여부)을 표시한다. 실제 역 정점(runNodes 원소)은
 * synthetic:false, octilinearSegment가 삽입한 코너점만 synthetic:true.
 */
export function buildAnnotatedOctolinearVertices(runNodes) {
  if (runNodes.length < 2) return runNodes.map((n) => ({ ...n, synthetic: false }));
  const verts = [{ x: runNodes[0].x, y: runNodes[0].y, synthetic: false }];
  for (let i = 0; i + 1 < runNodes.length; i += 1) {
    const seg = octilinearSegment(runNodes[i], runNodes[i + 1]);
    if (seg.length === 3) {
      verts.push({ x: seg[1].x, y: seg[1].y, synthetic: true });
    }
    verts.push({ x: runNodes[i + 1].x, y: runNodes[i + 1].y, synthetic: false });
  }
  return verts;
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function unit(v) {
  const L = Math.hypot(v.x, v.y);
  return L < 1e-9 ? { x: 0, y: 0 } : { x: v.x / L, y: v.y / L };
}
function addScaled(p, dir, s) {
  return { x: p.x + dir.x * s, y: p.y + dir.y * s };
}
// 오너 지시(2026-07-18, 3차 재확인): "직선은 정확히 8방향 스냅, 부동소수 잔차도
// 최소화" — 좌표를 3자리에서 6자리로 반올림해 짧은(서브px) 세그먼트에서
// 독립 반올림이 만드는 각도 잔차를 실질적으로 제거한다(0.001° tolerance 실측
// 검증 — round-svg-route-lines.mjs 참고).
function fmt(p) {
  return `${Math.round(p.x * 1e6) / 1e6} ${Math.round(p.y * 1e6) / 1e6}`;
}

const BEZIER_CIRCLE_K = 0.5523;

/**
 * 주석 달린(annotated) render-space 정점열을 SVG path `d`(local 좌표)로 만든다.
 * synthetic 정점에서만 짧은 원형근사 3차 베지어 필렛을 입힌다(실제 역 정점은
 * sharp — G-NODE 보존). 반환: d 문자열, 또는 정점<2면 null.
 */
export function buildFilletedLocalPath(annotatedVerts, transform, radiusPx = 6, minClearancePx = 0) {
  const n = annotatedVerts.length;
  if (n < 2) return null;
  const cmds = [`M ${fmt(toLocal(annotatedVerts[0], transform))}`];
  let pen = annotatedVerts[0]; // render-space 현재 펜 위치(필렛 후 P1일 수 있음)
  for (let i = 1; i < n; i += 1) {
    const cur = annotatedVerts[i];
    if (cur.synthetic && i + 1 < n) {
      const prev = pen;
      const next = annotatedVerts[i + 1];
      const dIn = unit(sub(cur, prev));
      const dOut = unit(sub(next, cur));
      const legIn = dist(prev, cur);
      const legOut = dist(cur, next);
      // #2068 4차: minClearancePx(기본 0=미적용)를 주면 필렛이 역 바로 앞에서
      // 곡선을 시작하지 않도록 반경을 추가로 축소한다 — G-NODE-STRAIGHT 하드
      // 게이트(노드에서 최소 직선 리드 확보)를 만족시킨다. leg가
      // minClearancePx보다 짧으면(직선 리드를 남길 여지 자체가 없으면) 필렛을
      // 아예 생략(rr=0, sharp corner)해 leg 전체가 직선으로 남는다.
      const rr = Math.max(
        0,
        Math.min(radiusPx, legIn * 0.45, legOut * 0.45, legIn - minClearancePx, legOut - minClearancePx),
      );
      if (rr < 0.05) {
        cmds.push(`L ${fmt(toLocal(cur, transform))}`);
        pen = cur;
        continue;
      }
      const P0 = addScaled(cur, dIn, -rr);
      const P1 = addScaled(cur, dOut, rr);
      const C1 = addScaled(P0, dIn, rr * BEZIER_CIRCLE_K);
      const C2 = addScaled(P1, dOut, -rr * BEZIER_CIRCLE_K);
      cmds.push(`L ${fmt(toLocal(P0, transform))}`);
      cmds.push(
        `C ${fmt(toLocal(C1, transform))} ${fmt(toLocal(C2, transform))} ${fmt(toLocal(P1, transform))}`,
      );
      pen = P1;
    } else {
      cmds.push(`L ${fmt(toLocal(cur, transform))}`);
      pen = cur;
    }
  }
  return cmds.join(" ");
}

// ── route-line 그룹 조작 ────────────────────────────────────────────────────

export function sliceGroup(svgText, idIdx) {
  const gStart = svgText.lastIndexOf("<g", idIdx);
  let depth = 0;
  let i = gStart;
  const re = /<g\b|<\/g>/g;
  re.lastIndex = i;
  for (let m = re.exec(svgText); m; m = re.exec(svgText)) {
    if (m[0] === "<g") depth += 1;
    else {
      depth -= 1;
      if (depth === 0) return { start: gStart, end: m.index + m[0].length };
    }
  }
  throw new Error("route-line 그룹의 닫는 </g>를 찾지 못했습니다.");
}

/** 그룹 텍스트에서 첫 stroke(색 지정) path의 속성 템플릿(문자열)을 뽑는다.
 *  id/d/sodipodi:nodetypes는 제외 — id·d는 새로 만들고, sodipodi:nodetypes는
 *  path 재구성 후 정점 수가 달라져 stale해지므로 버린다. */
export function extractStrokeTemplate(groupText) {
  const pathRe = /<path\b[^>]*?\/>/gs;
  for (let m = pathRe.exec(groupText); m; m = pathRe.exec(groupText)) {
    const p = m[0];
    if (!/\sstroke="#/.test(p) && !/style="[^"]*\bstroke:#/.test(p)) continue;
    let attrs = p
      .replace(/^<path\b/, "")
      .replace(/\/>\s*$/, "")
      .replace(/\sid="[^"]*"/, "")
      .replace(/\sd="[^"]*"/, "")
      .replace(/\ssodipodi:nodetypes="[^"]*"/, "")
      .trim();
    return attrs;
  }
  return null;
}

// seohae(서해선)처럼 stroke 없이 fill-ribbon으로 그려진 노선의 폴백 템플릿
// (다른 23개 노선과 동일한 round-cap stroke 관례로 정규화 — #2068 실측: 서해선이
// 유일한 fill-ribbon 표현이라 통일이 일관성을 높인다).
export function fallbackStrokeTemplate(slug, config) {
  const color =
    Object.entries(config.colorToSlug).find(([, s]) => s === slug)?.[0] ?? "#666666";
  return (
    `fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" ` +
    `stroke-width="6" stroke-miterlimit="1" data-bend-smoothing="round-cap-round-join-global-pass" ` +
    `data-line="${slug}" data-line-name="${config.slugToSuffix[slug] ?? slug}" data-line-color="${color}"`
  );
}

/** 그룹 텍스트에서 노선 stroke path 전부를 새 path 목록으로 치환한다.
 *  hasAnyStroke=true(정상: fill=none stroke=#색 관례)면 stroke 있는 path만
 *  치환하고 비-stroke 장식 요소(예: 6호선 백색 틈새 패치)는 보존한다.
 *  hasAnyStroke=false(서해선처럼 노선 전체가 fill-ribbon으로만 그려진 경우)면
 *  그룹 안의 모든 <path>가 "그 노선 자체"이므로 전부 치환한다(fallback
 *  템플릿으로 stroke 관례에 정규화 — 낡은 fill-ribbon을 남겨두면 8선형 감사가
 *  옛 비-stroke 외곽선을 계속 노선으로 오인해 거짓 위반을 낸다). */
export function replaceStrokePaths(groupText, slug, newPaths, template, hasAnyStroke) {
  let out = "";
  let idx = 0;
  let replaced = false;
  const pathRe = /<path\b[^>]*?\/>/gs;
  for (let m = pathRe.exec(groupText); m; m = pathRe.exec(groupText)) {
    const p = m[0];
    const isStroke = /\sstroke="#/.test(p) || /style="[^"]*\bstroke:#/.test(p);
    const isRouteRepresentation = hasAnyStroke ? isStroke : true;
    out += groupText.slice(idx, m.index);
    if (isRouteRepresentation) {
      if (!replaced) {
        out += newPaths
          .map((np, i) => `<path id="_${slug}-octo-${i}" ${template} d="${np.d}" />`)
          .join("\n            ");
        replaced = true;
      } // 이후 노선 표현 path(있었다면)는 삭제(새 목록으로 이미 대체됨).
    } else {
      out += p; // 비-stroke(장식) 요소 보존.
    }
    idx = m.index + p.length;
  }
  out += groupText.slice(idx);
  if (!replaced) {
    // 원래 path가 하나도 없던 그룹(있을 수 없지만 방어): 그룹 끝(닫는 </g> 앞)에 삽입.
    const closeIdx = out.lastIndexOf("</g>");
    const insertion =
      newPaths.map((np, i) => `<path id="_${slug}-octo-${i}" ${template} d="${np.d}" />`).join("\n            ") +
      "\n          ";
    out = out.slice(0, closeIdx) + insertion + out.slice(closeIdx);
  }
  return out;
}

// ── 노선별 run(본선+지선) 구성 ────────────────────────────────────────────────

/** line-branches.json에서 이 노선(canonical name_ko)의 지선 목록. 없으면 []. */
function branchesFor(branchesJson, region, lineNameKo) {
  return branchesJson?.linesByRegion?.[region]?.[lineNameKo] ?? [];
}

/**
 * pack에서 노선의 역 순서(line_sequence)를 읽어 본선+지선 run 목록(각 run은
 * {x,y,name}[])을 만든다. splitAtOutlierGaps로 위상 이상치를 분리한다.
 */
export function buildLineRuns(db, region, lineId, branches) {
  const nodeRows = db
    .prepare(
      `SELECT s.name_ko AS name, rmp.x AS x, rmp.y AS y, sl.line_sequence AS seq
       FROM route_map_positions rmp
       JOIN station_lines sl ON sl.station_id = rmp.station_id AND sl.line_id = rmp.line_id
       JOIN stations s ON s.id = rmp.station_id
       WHERE rmp.region = ? AND rmp.line_id = ?
       ORDER BY sl.line_sequence`,
    )
    .all(region, lineId);
  if (nodeRows.length < 2) return { runs: [], nodeCount: nodeRows.length };

  const spurNames = new Set(branches.flatMap((b) => b.spur));
  const mainNodes = nodeRows.filter((r) => !spurNames.has(r.name)).map((r) => ({ x: r.x, y: r.y }));
  const runs = splitAtOutlierGaps(mainNodes);
  for (const b of branches) {
    const jn = nodeRows.find((r) => r.name === b.junction);
    const spurNodes = b.spur.map((sn) => nodeRows.find((r) => r.name === sn)).filter(Boolean);
    if (!jn || spurNodes.length === 0) continue;
    const chain = [jn, ...spurNodes].map((r) => ({ x: r.x, y: r.y }));
    for (const run of splitAtOutlierGaps(chain)) runs.push(run);
  }
  return { runs, nodeCount: nodeRows.length };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    svg: "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v4.svg",
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    region: "수도권",
    branches: "tools/route-map/line-branches.json",
    filletRadius: 6,
    lines: [],
    all: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--svg": o.svg = argv[++i]; break;
      case "--pack": o.pack = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--branches": o.branches = argv[++i]; break;
      case "--fillet-radius": o.filletRadius = Number(argv[++i]); break;
      case "--line": o.lines.push(argv[++i]); break;
      case "--all": o.all = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--check": o.dryRun = true; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  let svgText = readFileSync(resolveRepo(o.svg), "utf8");
  const transform = parseScaledLayerTransform(svgText);
  const branchesJson = JSON.parse(readFileSync(resolveRepo(o.branches), "utf8"));

  const { db, dir } = openPack(o.pack, "octo-svg-");
  const slugs = o.all ? Object.keys(SEOUL.slugToSuffix) : o.lines;
  const report = [];
  try {
    const slugToId = resolveLineMap(db, SEOUL);
    for (const slug of slugs) {
      const lineId = slugToId.get(slug);
      if (!lineId) {
        console.error(`슬러그 "${slug}"를 노선 카탈로그에서 못 찾음 — 스킵`);
        continue;
      }
      const lineNameKo = `${SEOUL.lineNamePrefix} ${SEOUL.slugToSuffix[slug]}`;
      const branches = branchesFor(branchesJson, o.region, lineNameKo);
      const { runs, nodeCount } = buildLineRuns(db, o.region, lineId, branches);
      if (runs.length === 0) {
        console.log(`  ${slug}(${lineNameKo}): 노드 ${nodeCount} → 스킵(부족)`);
        continue;
      }
      const newPaths = runs
        .map((run) => buildAnnotatedOctolinearVertices(run))
        .map((verts) => buildFilletedLocalPath(verts, transform, o.filletRadius))
        .filter(Boolean)
        .map((d) => ({ d }));

      const groupIdAttr = `id="route-line-${slug}"`;
      const idPos = svgText.indexOf(groupIdAttr);
      if (idPos === -1) {
        console.error(`  ${slug}: route-line-${slug} 그룹을 SVG에서 못 찾음 — 스킵`);
        continue;
      }
      const { start, end } = sliceGroup(svgText, idPos);
      const groupText = svgText.slice(start, end);
      const strokeTemplate = extractStrokeTemplate(groupText);
      const template = strokeTemplate ?? fallbackStrokeTemplate(slug, SEOUL);
      const newGroupText = replaceStrokePaths(groupText, slug, newPaths, template, strokeTemplate !== null);
      svgText = svgText.slice(0, start) + newGroupText + svgText.slice(end);

      report.push({ slug, lineNameKo, nodeCount, runCount: newPaths.length, branchCount: branches.length });
      console.log(
        `  ${slug}(${lineNameKo}): 노드 ${nodeCount} → 본선+지선 run ${newPaths.length}` +
          (branches.length ? ` (지선 ${branches.length})` : ""),
      );
    }
  } finally {
    cleanupPackDir(dir);
  }

  if (o.dryRun) {
    console.log("(--dry-run: SVG 미기록)");
    return;
  }
  writeFileSync(resolveRepo(o.svg), svgText);
  console.log(`SVG 갱신: ${o.svg} (노선 ${report.length}개 재작도)`);
}

if (isMainModule(import.meta.url)) {
  main();
}
