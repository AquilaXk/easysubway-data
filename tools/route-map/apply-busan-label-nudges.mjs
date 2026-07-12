#!/usr/bin/env node
// #2011 부산 라벨-선 겹침 결정적 해소: route-map-busan-label-nudges.json 선언대로
// 특정 역을 인접 두 정점 사이의 축정렬 L-굴절 코너로 옮긴다.
//
// 배경: regional_label_overlap_gate_test 부산권은 라벨-선 겹침 0을 요구한다. 라벨
// solver(solveRouteMapLabelLayout)의 gap 사다리 확장으로 대부분(연산·범내골)은
// 풀리지만, 폭이 매우 넓은 라벨이 45° 대각 track 위에 놓인 케이스(국제금융센터.
// 부산은행, 폭 143px)는 어떤 anchor·gap에서도 대각을 벗어나지 못한다. 이 역을
// prev/next 인접역이 만드는 축정렬 코너(수평+수직 L-굴절)로 옮기면 라벨이 축과
// 나란한 쪽(왼/아래)으로 선-clear 배치된다.
//
// ⛔ 가드레일:
//  - corner=(prev.x, next.y)로 두 인접 정점 좌표에서만 도출 → 두 arm이 각각 수직·
//    수평이라 8선형이 보존된다(별도 스냅 불필요). JSON에 좌표를 직접 두지 않는다.
//  - route_map_positions의 (station_id,line_id) 좌표와 그 track 정점만 갱신 →
//    토폴로지(158쌍)·간격 chain 분포는 불변(간격은 track arc-length라 arm 길이만
//    바뀌고 chain 수·구성은 그대로).
//  - 멱등: 이미 코너에 있으면 no-op.
import { readFileSync } from "node:fs";
import { parsePathVertices, verticesToPath } from "./audit-octolinearity.mjs";
import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";

const VERT_MATCH_TOL = 5; // track 정점 매칭 반경(px) — 스냅 잔차 포함.

/** 한 nudge의 코너 좌표를 인접역에서 도출한다. */
export function deriveCorner(nudge, posByStation) {
  const prev = posByStation.get(nudge.prevStationId);
  const next = posByStation.get(nudge.nextStationId);
  if (!prev || !next) {
    throw new Error(`인접역 좌표 없음: prev=${nudge.prevStationId} next=${nudge.nextStationId}`);
  }
  const cornerX = nudge.cornerX === "next" ? next.x : prev.x;
  const cornerY = nudge.cornerY === "next" ? next.y : prev.y;
  return { x: Math.round(cornerX), y: Math.round(cornerY) };
}

/** track 정점 배열에서 old에 가장 근접한 정점을 corner로 옮긴 새 배열(변경 여부 포함). */
export function moveTrackVertex(verts, old, corner) {
  let changed = false;
  const out = verts.map((v) => {
    if (Math.hypot(v.x - old.x, v.y - old.y) < VERT_MATCH_TOL) {
      changed = true;
      return { x: corner.x, y: corner.y };
    }
    return v;
  });
  return { verts: out, changed };
}

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    index: "apps/mobile/assets/datapacks/index.json",
    nudges: "tools/route-map/route-map-busan-label-nudges.json",
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pack") o.pack = argv[++i];
    else if (a === "--index") o.index = argv[++i];
    else if (a === "--nudges") o.nudges = argv[++i];
    else if (a === "--check") o.check = true;
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const table = JSON.parse(readFileSync(o.nudges, "utf8"));
  const region = table.region;
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "apply-busan-nudge-");
  try {
    const posRows = db.prepare(
      "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region=?",
    ).all(region);
    const posByStation = new Map(posRows.map((r) => [r.station_id, { x: r.x, y: r.y }]));
    const posU = db.prepare(
      "UPDATE route_map_positions SET x=?, y=? WHERE region=? AND station_id=? AND line_id=?",
    );
    const trkU = db.prepare(
      "UPDATE route_map_line_tracks SET path=? WHERE region=? AND line_id=? AND track_index=?",
    );

    if (!o.check) db.exec("BEGIN");
    let applied = 0;
    for (const nudge of table.nudges) {
      const cur = posRows.find(
        (r) => r.station_id === nudge.stationId && r.line_id === nudge.lineId,
      );
      if (!cur) {
        console.log(`  미발견: ${nudge.name} (${nudge.stationId}/${nudge.lineId})`);
        continue;
      }
      const corner = deriveCorner(nudge, posByStation);
      if (Math.round(cur.x) === corner.x && Math.round(cur.y) === corner.y) {
        console.log(`  이미 코너: ${nudge.name} (${corner.x},${corner.y}) — no-op`);
        continue;
      }
      const old = { x: cur.x, y: cur.y };
      // 노드 좌표 갱신.
      if (!o.check) posU.run(corner.x, corner.y, region, nudge.stationId, nudge.lineId);
      // 해당 노선 track의 old 정점을 corner로 이동.
      const trackRows = db.prepare(
        "SELECT track_index, path FROM route_map_line_tracks WHERE region=? AND line_id=? ORDER BY track_index",
      ).all(region, nudge.lineId);
      let vertMoved = 0;
      for (const t of trackRows) {
        const { verts, changed } = moveTrackVertex(parsePathVertices(t.path), old, corner);
        if (changed) {
          vertMoved += 1;
          if (!o.check) trkU.run(verticesToPath(verts), region, nudge.lineId, t.track_index);
        }
      }
      console.log(
        `  적용: ${nudge.name} (${Math.round(old.x)},${Math.round(old.y)}) → (${corner.x},${corner.y}) · track 정점 ${vertMoved}`,
      );
      applied += 1;
    }
    console.log(`[${region}] 라벨 nudge ${table.nudges.length} · 적용 ${applied}`);
    if (o.check) {
      console.log("(--check: 미기록)");
      db.close();
      return;
    }
    db.exec("COMMIT");
    db.exec("VACUUM");
    db.close();
    const { byteSize } = writePack({
      sqlitePath,
      packPath,
      packRelPath: o.pack,
      indexRelPath: o.index,
    });
    console.log(`팩 갱신 (byteSize ${byteSize})`);
  } finally {
    try {
      db.close();
    } catch {
      /* 이미 닫힘 */
    }
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
