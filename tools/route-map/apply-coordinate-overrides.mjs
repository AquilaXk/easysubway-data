#!/usr/bin/env node
// #1789 P2.2: C2 수동 오버라이드 테이블(route-map-coordinate-overrides.json)로 B-국소가
// 극단 티어로 미룬 환승 7건을 오라클 캡슐에 손배치한다. B-국소 splice 기계 재사용,
// 그룹별 maxDist 상향으로 대변위(신사 102px) 부착. 자동 수렴 경로 기본값은 불변.
// ⛔ 가드레일: 테이블은 targetSpan·axis만(좌표 없음). 좌표는 여기서 8선형으로 도출.
import { readFileSync } from "node:fs";
import { capsuleAxis, capsuleTargets, spliceTrackToNode, transferGroups } from "./splice-transfer-convergence.mjs";
import { parsePathVertices, verticesToPath } from "./audit-octolinearity.mjs";
import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";

/** 한 그룹을 override(targetSpan·axis·maxDist)로 수렴. convergeGroup과 동형·maxDist 전달. */
export function applyOverrideGroup(group, override, tracksByLine) {
  const axis = override.axis === "auto" || !override.axis ? capsuleAxis(group.members) : override.axis;
  const targets = capsuleTargets(group.members, override.targetSpan, axis);
  const targetByLine = new Map(targets.map((t) => [t.lineId, t]));
  const positionUpdates = [];
  const trackUpdates = [];
  for (const m of group.members) {
    const nt = targetByLine.get(m.lineId);
    const newPos = { x: Math.round(nt.x), y: Math.round(nt.y) };
    let attachedAny = false;
    for (const trk of tracksByLine.get(m.lineId) ?? []) {
      // override.maxDist는 nearestVertexIndex 탐색 반경도 겸한다 — 테이블은 대략 2×변위+여유로
      // 잡는다(대변위 극단역 부착용). ⚠️ 과도하게 키우면 허브서 먼 distal 정점을 잡아 기하를
      // 왜곡할 수 있다(현 게이트 8선형 0·미부착 0으로 무왜곡 확인). C2 7건 한정, 무단 확대 금지.
      const { verts, attached } = spliceTrackToNode(trk.verts, { x: m.x, y: m.y }, newPos, { maxDist: override.maxDist });
      if (attached) {
        attachedAny = true;
        if (JSON.stringify(verts) !== JSON.stringify(trk.verts)) {
          trackUpdates.push({ lineId: m.lineId, trackIndex: trk.trackIndex, verts });
        }
      }
    }
    if (attachedAny) positionUpdates.push({ stationId: group.stationId, lineId: m.lineId, x: newPos.x, y: newPos.y });
  }
  return { positionUpdates, trackUpdates };
}

function parseArgs(argv) {
  const o = { pack: "apps/mobile/assets/datapacks/capital.sqlite.gz", index: "apps/mobile/assets/datapacks/index.json", region: "수도권", overrides: "tools/route-map/route-map-coordinate-overrides.json", check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pack") o.pack = argv[++i];
    else if (a === "--index") o.index = argv[++i];
    else if (a === "--region") o.region = argv[++i];
    else if (a === "--overrides") o.overrides = argv[++i];
    else if (a === "--check") o.check = true;
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const table = JSON.parse(readFileSync(o.overrides, "utf8"));
  const byStation = new Map(table.overrides.map((ov) => [ov.stationId, ov]));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "apply-ovr-");
  try {
    const posRows = db.prepare("SELECT station_id, line_id, x, y FROM route_map_positions WHERE region=?").all(o.region);
    const trackRows = db.prepare("SELECT line_id, track_index, path FROM route_map_line_tracks WHERE region=? ORDER BY line_id, track_index").all(o.region);
    const tracksByLine = new Map();
    for (const t of trackRows) {
      if (!tracksByLine.has(t.line_id)) tracksByLine.set(t.line_id, []);
      tracksByLine.get(t.line_id).push({ trackIndex: t.track_index, verts: parsePathVertices(t.path) });
    }
    const groups = transferGroups(posRows);
    const posU = db.prepare("UPDATE route_map_positions SET x=?, y=? WHERE region=? AND station_id=? AND line_id=?");
    const trkU = db.prepare("UPDATE route_map_line_tracks SET path=? WHERE region=? AND line_id=? AND track_index=?");
    if (!o.check) db.exec("BEGIN");
    let applied = 0;
    for (const g of groups) {
      const ov = byStation.get(g.stationId);
      if (!ov) continue;
      const { positionUpdates, trackUpdates } = applyOverrideGroup(g, ov, tracksByLine);
      if (!positionUpdates.length) { console.log(`  미부착: ${g.stationId} (maxDist ${ov.maxDist} 부족)`); continue; }
      applied += 1;
      if (o.check) continue;
      for (const p of positionUpdates) posU.run(p.x, p.y, o.region, p.stationId, p.lineId);
      for (const tu of trackUpdates) {
        const tracks = tracksByLine.get(tu.lineId);
        const idx = tracks?.findIndex((t) => t.trackIndex === tu.trackIndex);
        if (idx >= 0) tracks[idx] = { trackIndex: tu.trackIndex, verts: tu.verts };
        trkU.run(verticesToPath(tu.verts), o.region, tu.lineId, tu.trackIndex);
      }
    }
    console.log(`[${o.region}] 오버라이드 ${table.overrides.length} · 적용 ${applied}`);
    if (o.check) { console.log("(--check: 미기록)"); db.close(); return; }
    db.exec("COMMIT"); db.exec("VACUUM"); db.close();
    const { byteSize } = writePack({ sqlitePath, packPath, packRelPath: o.pack, indexRelPath: o.index });
    console.log(`팩 갱신 (byteSize ${byteSize})`);
  } finally {
    try { db.close(); } catch { /* 이미 닫힘 */ }
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
