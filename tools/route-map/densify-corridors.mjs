#!/usr/bin/env node
// #1789 P2.1: 밀집 회랑을 공유 노선 track 방향으로 arc-length 재배치하고 그룹-원자 splice로 옮긴다
// (캡슐 강체 보존, respace 무재실행). 축은 track 로컬 방향(붕괴 그룹도 정의됨), 정렬은 line_sequence.
// track 방향 이동이라 8선형이 구성상 보존된다.

import { isMainModule } from "../lib/is-main-module.mjs";
import { spliceTrackToNode } from "./splice-transfer-convergence.mjs";
import { parsePathVertices, verticesToPath } from "./audit-octolinearity.mjs";
import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";
import { denseHubs } from "./densify-hubs.mjs";

const SNAP8 = [
  { ux: 1, uy: 0 }, { ux: Math.SQRT1_2, uy: Math.SQRT1_2 }, { ux: 0, uy: 1 }, { ux: -Math.SQRT1_2, uy: Math.SQRT1_2 },
];
/** 벡터를 4개 무방향 8축(0/45/90/135°) 중 최근접으로 스냅. */
function snapAxis(dx, dy) {
  let best = SNAP8[0], bestDot = -1;
  for (const a of SNAP8) { const d = Math.abs(dx * a.ux + dy * a.uy); if (d > bestDot) { bestDot = d; best = a; } }
  return best;
}

/** centroid 최근접 정점의 인접 세그먼트 중 긴 쪽 방향을 8축 스냅(코너 tie-break=긴 세그먼트). */
export function trackAxis8(trackVerts, centroid) {
  let idx = 0, bd = Infinity;
  for (let i = 0; i < trackVerts.length; i += 1) { const d = Math.hypot(trackVerts[i].x - centroid.x, trackVerts[i].y - centroid.y); if (d < bd) { bd = d; idx = i; } }
  const segs = [];
  let buildIdx = 0;
  if (idx > 0) segs.push({ seg: [trackVerts[idx - 1], trackVerts[idx]], buildIdx: buildIdx++ });
  if (idx < trackVerts.length - 1) segs.push({ seg: [trackVerts[idx], trackVerts[idx + 1]], buildIdx: buildIdx++ });
  if (segs.length === 0) return { ux: 1, uy: 0 };
  segs.sort((a, b) => {
    const lenA = Math.hypot(a.seg[1].x - a.seg[0].x, a.seg[1].y - a.seg[0].y);
    const lenB = Math.hypot(b.seg[1].x - b.seg[0].x, b.seg[1].y - b.seg[0].y);
    return (lenB - lenA) || (b.buildIdx - a.buildIdx);
  });
  const [p, q] = segs[0].seg;
  return snapAxis(q.x - p.x, q.y - p.y);
}

/** membersSeq([{stationId,x,y,seq}]) + 공유 노선 track → 축(track 방향)·정렬(seq)·centroid. */
export function corridorLayout(membersSeq, trackVerts) {
  const cx = membersSeq.reduce((s, m) => s + m.x, 0) / membersSeq.length;
  const cy = membersSeq.reduce((s, m) => s + m.y, 0) / membersSeq.length;
  const axis = trackAxis8(trackVerts, { x: cx, y: cy });
  const ordered = [...membersSeq].sort((a, b) => a.seq - b.seq).map((m) => m.stationId);
  return { axis, ordered, centroid: { x: cx, y: cy } };
}

/** 회랑 역들을 track축 따라 targetGap 간격·seq 순·centroid 중심 재배치(비축=centroid 통일, 정수). */
export function corridorTargets(membersSeq, trackVerts, targetGap = 30) {
  const { axis, ordered, centroid } = corridorLayout(membersSeq, trackVerts);
  const n = ordered.length;
  const cProj = centroid.x * axis.ux + centroid.y * axis.uy;       // centroid 축좌표
  const perp = { x: centroid.x - cProj * axis.ux, y: centroid.y - cProj * axis.uy }; // centroid 비축 성분(통일)
  const start = cProj - ((n - 1) * targetGap) / 2;
  const out = new Map();
  ordered.forEach((id, k) => {
    const s = start + k * targetGap;
    out.set(id, { x: Math.round(perp.x + s * axis.ux), y: Math.round(perp.y + s * axis.uy) });
  });
  return out;
}

/** 회랑 그룹 적용: 전 노선노드 강체 델타 이동(캡슐 보존) + 노선 track splice(부착 실패 원자적 미이동). */
export function applyCorridor(membersSeq, trackVerts, memberLines, tracksByLine, maxDist = 30, targetGap = 30) {
  const targets = corridorTargets(membersSeq, trackVerts, targetGap);
  const { axis } = corridorLayout(membersSeq, trackVerts);            // 정렬용 축
  const reprById = new Map(membersSeq.map((m) => [m.stationId, { x: m.x, y: m.y }]));
  const positionUpdates = [];
  const trackUpdates = [];
  // 목표 축 투영 오름차순(135° 포함 정확) — 단일 패스로 공유 정점 순서 처리.
  const proj = (id) => targets.get(id).x * axis.ux + targets.get(id).y * axis.uy;
  const order = [...targets.keys()].sort((a, b) => proj(a) - proj(b));
  for (const stationId of order) {
    const np = targets.get(stationId);
    const repr = reprById.get(stationId);
    const dx = np.x - repr.x, dy = np.y - repr.y;                     // 강체 델타(캡슐 span 보존)
    const nodes = memberLines.get(stationId) ?? [];
    let attachedAny = false;
    const pending = [];
    const nodeNew = [];
    const unattached = [];                                            // 트랙 미부착 노선노드(진단용)
    for (const node of nodes) {
      const nnp = { x: Math.round(node.x + dx), y: Math.round(node.y + dy) };  // 노드별 동일 델타
      nodeNew.push({ node, nnp });
      let nodeAttached = false;
      for (const trk of tracksByLine.get(node.lineId) ?? []) {
        // matchDist=2: 붕괴 회랑서 앞 역이 옮긴 정점을 뒤 역이 재포착하지 않도록 자기
        // 정점(≈0px)만 이동, 그 외엔 mid-segment 삽입(F1 캐스케이드 오염 방지).
        const { verts, attached } = spliceTrackToNode(trk.verts, { x: node.x, y: node.y }, nnp, { maxDist, matchDist: 2 });
        if (attached) { attachedAny = true; nodeAttached = true; if (JSON.stringify(verts) !== JSON.stringify(trk.verts)) pending.push({ lineId: node.lineId, trackIndex: trk.trackIndex, verts, trk }); }
      }
      if (!nodeAttached) unattached.push(node.lineId);
    }
    if (!attachedAny) continue;                                       // 원자성
    // 캡슐 강체(G3)상 이동은 하되 자기 트랙엔 dogleg이 없는 노드 — 트랙 밖에 뜰 수 있어 경고.
    if (unattached.length) console.warn(`  ⚠️ ${stationId}: 노선 ${unattached.join(",")} 트랙 미부착(캡슐 강체로 이동만, maxDist ${maxDist} 밖)`);
    for (const p of pending) { p.trk.verts = p.verts; trackUpdates.push({ lineId: p.lineId, trackIndex: p.trackIndex, verts: p.verts }); }
    for (const { node, nnp } of nodeNew) positionUpdates.push({ stationId, lineId: node.lineId, x: nnp.x, y: nnp.y });
  }
  return { positionUpdates, trackUpdates };
}

/**
 * 공유 노선 없는 그룹(반포↔잠원): 첫 역만 자기 노선 track 방향으로 targetGap 이동해 분리.
 * 둘 다 기하축으로 밀면 둘 다 자기 track 밖으로 나가므로 한 역만 자기 노선 방향으로.
 */
export function applyNoSharedLine(g, memberLines, tracksByLine, repr, targetGap = 30, maxDist = 30) {
  const [aId, bId] = g;
  // 이 분기는 쌍(반포↔잠원)을 전제로 한 역만 분리한다. union-find가 공유노선 없는
  // 3+역 성분을 반환하면 index 2+ 멤버는 미처리 — 조용히 잔존하지 않도록 진단.
  if (g.length > 2) console.warn(`  ⚠️ 공유노선 없는 ${g.length}역 그룹 — 첫 역만 분리, 나머지 ${g.slice(2).join(",")} 미처리`);
  const a = repr.get(aId), b = repr.get(bId);
  const aLine = (memberLines.get(aId) ?? [])[0];
  const track = aLine ? (tracksByLine.get(aLine.lineId) ?? [])[0] : null;
  if (!track) return { positionUpdates: [], trackUpdates: [] };
  const axis = trackAxis8(track.verts, a);
  const away = ((a.x - b.x) * axis.ux + (a.y - b.y) * axis.uy) >= 0 ? 1 : -1;
  const dx = away * targetGap * axis.ux, dy = away * targetGap * axis.uy;   // 강체 델타
  const positionUpdates = [], trackUpdates = [];
  let attached = false;
  const unattached = [];                                                   // 트랙 미부착 노선노드(진단용)
  for (const node of memberLines.get(aId) ?? []) {
    const nnp = { x: Math.round(node.x + dx), y: Math.round(node.y + dy) };
    let nodeAttached = false;
    for (const trk of tracksByLine.get(node.lineId) ?? []) {
      const r = spliceTrackToNode(trk.verts, { x: node.x, y: node.y }, nnp, { maxDist });
      if (r.attached) { attached = true; nodeAttached = true; if (JSON.stringify(r.verts) !== JSON.stringify(trk.verts)) { trk.verts = r.verts; trackUpdates.push({ lineId: node.lineId, trackIndex: trk.trackIndex, verts: r.verts }); } }
    }
    if (!nodeAttached) unattached.push(node.lineId);
  }
  if (attached) {
    // applyCorridor와 대칭: 이동하되 자기 트랙 부착 실패한 노드는 진단(트랙 밖 뜰 수 있음).
    if (unattached.length) console.warn(`  ⚠️ ${aId}: 노선 ${unattached.join(",")} 트랙 미부착(이동만, maxDist ${maxDist} 밖)`);
    for (const node of memberLines.get(aId) ?? []) positionUpdates.push({ stationId: aId, lineId: node.lineId, x: Math.round(node.x + dx), y: Math.round(node.y + dy) });
  }
  return { positionUpdates, trackUpdates };
}

function parseArgs(argv) {
  const o = { pack: "apps/mobile/assets/datapacks/capital.sqlite.gz", index: "apps/mobile/assets/datapacks/index.json", region: "수도권", threshold: 26, gap: 30, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pack") o.pack = argv[++i]; else if (a === "--index") o.index = argv[++i];
    else if (a === "--region") o.region = argv[++i]; else if (a === "--threshold") o.threshold = Number(argv[++i]);
    else if (a === "--gap") o.gap = Number(argv[++i]); else if (a === "--check") o.check = true;
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "densify-cor-");
  try {
    const posRows = db.prepare("SELECT station_id, line_id, x, y FROM route_map_positions WHERE region=?").all(o.region);
    const memberLines = new Map(); // stationId → [{lineId,x,y}]
    const repr = new Map();        // stationId → {x,y} 대표(평균)
    for (const r of posRows) {
      if (!memberLines.has(r.station_id)) memberLines.set(r.station_id, []);
      memberLines.get(r.station_id).push({ lineId: r.line_id, x: r.x, y: r.y });
    }
    for (const [id, ns] of memberLines) repr.set(id, { x: ns.reduce((s, n) => s + n.x, 0) / ns.length, y: ns.reduce((s, n) => s + n.y, 0) / ns.length });
    const stations = [...repr].map(([stationId, p]) => ({ stationId, ...p }));
    const groups = denseHubs(stations, o.threshold);
    // station_lines: stationId → [{lineId, seq}] (공유 노선·순서 판정용)
    const stationLines = new Map();
    for (const r of db.prepare("SELECT sl.station_id, sl.line_id, sl.line_sequence AS seq FROM station_lines sl JOIN route_map_positions p ON p.station_id=sl.station_id AND p.line_id=sl.line_id AND p.region=?").all(o.region)) {
      if (!stationLines.has(r.station_id)) stationLines.set(r.station_id, []);
      stationLines.get(r.station_id).push({ lineId: r.line_id, seq: r.seq });
    }
    const trackRows = db.prepare("SELECT line_id, track_index, path FROM route_map_line_tracks WHERE region=? ORDER BY line_id, track_index").all(o.region);
    const tracksByLine = new Map();
    for (const t of trackRows) { if (!tracksByLine.has(t.line_id)) tracksByLine.set(t.line_id, []); tracksByLine.get(t.line_id).push({ trackIndex: t.track_index, verts: parsePathVertices(t.path) }); }
    console.log(`[${o.region}] 밀집 회랑 ${groups.length}그룹 (역 ${groups.reduce((s, g) => s + g.length, 0)})`);
    const posU = db.prepare("UPDATE route_map_positions SET x=?, y=? WHERE region=? AND station_id=? AND line_id=?");
    const trkU = db.prepare("UPDATE route_map_line_tracks SET path=? WHERE region=? AND line_id=? AND track_index=?");
    if (!o.check) db.exec("BEGIN");
    let applied = 0;
    for (const g of groups) {
      // 공유 노선(전 멤버 교집합) 판정
      let common = null;
      for (const id of g) { const ls = new Set((stationLines.get(id) ?? []).map((x) => x.lineId)); common = common === null ? ls : new Set([...common].filter((l) => ls.has(l))); }
      const sharedLine = common && common.size ? [...common][0] : null;
      let positionUpdates, trackUpdates;
      if (sharedLine && (tracksByLine.get(sharedLine) ?? [])[0]) {
        const trackVerts = tracksByLine.get(sharedLine)[0].verts;
        const membersSeq = g.map((id) => ({ stationId: id, ...repr.get(id), seq: (stationLines.get(id) ?? []).find((x) => x.lineId === sharedLine)?.seq ?? 0 }));
        ({ positionUpdates, trackUpdates } = applyCorridor(membersSeq, trackVerts, memberLines, tracksByLine, o.gap * 2 + 20, o.gap));
      } else {
        // 공유 노선 없음(반포↔잠원): 한 역만 자기 노선 track 방향으로 이동
        ({ positionUpdates, trackUpdates } = applyNoSharedLine(g, memberLines, tracksByLine, repr, o.gap, o.gap * 2 + 20));
      }
      if (!positionUpdates.length) { console.log(`  미부착 그룹: ${g.join(",")}`); continue; }
      applied += 1;
      if (o.check) continue;
      for (const p of positionUpdates) posU.run(p.x, p.y, o.region, p.stationId, p.lineId);
      for (const tu of trackUpdates) trkU.run(verticesToPath(tu.verts), o.region, tu.lineId, tu.trackIndex);
    }
    console.log(`  적용 ${applied}/${groups.length}`);
    if (o.check) { console.log("(--check: 미기록)"); db.close(); return; }
    db.exec("COMMIT"); db.exec("VACUUM"); db.close();
    const { byteSize } = writePack({ sqlitePath, packPath, packRelPath: o.pack, indexRelPath: o.index });
    console.log(`팩 갱신 (byteSize ${byteSize})`);
  } finally { try { db.close(); } catch { /* 이미 닫힘 */ } cleanupPackDir(dir); }
}

if (isMainModule(import.meta.url)) main();
