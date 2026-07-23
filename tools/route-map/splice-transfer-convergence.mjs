#!/usr/bin/env node
// #1789 C3 P1 (B-국소): 환승 멤버를 전역 재생성 없이 국소 splice로 오라클 스팬 캡슐로
// 수렴한다. 오라클 스팬 초과(과분산) 그룹만 압축(코인시던트 보존), 각 노선 track을 국소
// 윈도우에서 45° dogleg(octilinearPolyline)로 splice해 newPos를 정확 통과·8선형 유지.
// 파이프라인: transferGroups → classifyGroup(변위 티어) → needsConvergence(과분산만) →
// capsuleTargets(H/V) → spliceTrackToNode(정점 이동 or mid-segment 삽입) → convergeGroup
// (원자성: track 부착한 멤버만 position 이동). CLI가 티어별로 팩에 적용(게이트 하). 가드레일
// 5조: CSV 좌표 미사용 — 오라클은 집계 스팬만.

import { isMainModule } from "../lib/is-main-module.mjs";
import { readFileSync } from "node:fs";
import { octilinearPolyline } from "./octolinearize-line-tracks.mjs";
import { parsePathVertices, pointToSegmentDistance, verticesToPath } from "./audit-octolinearity.mjs";
import { openPack, writePack, cleanupPackDir } from "./pack-io.mjs";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** posRows({station_id,line_id,x,y}) → 환승 그룹(2+ 노선). span=최대 쌍거리. */
export function transferGroups(posRows) {
  const byStation = new Map();
  for (const r of posRows) {
    if (!byStation.has(r.station_id)) byStation.set(r.station_id, []);
    byStation.get(r.station_id).push(r);
  }
  const groups = [];
  for (const [stationId, rows] of byStation) {
    const lineIds = new Set(rows.map((r) => r.line_id));
    if (lineIds.size < 2) continue;
    let span = 0;
    for (let i = 0; i < rows.length; i += 1)
      for (let j = i + 1; j < rows.length; j += 1)
        span = Math.max(span, Math.hypot(rows[i].x - rows[j].x, rows[i].y - rows[j].y));
    groups.push({
      stationId,
      members: rows.map((r) => ({ lineId: r.line_id, x: r.x, y: r.y })),
      memberCount: lineIds.size,
      span,
    });
  }
  return groups;
}

/** 변위=(span-target)/2. 티어: mild<4·mid<20·large<extremeDisp·나머지 extreme. */
export function classifyGroup(group, oracle, { extremeDisp = 35 } = {}) {
  const target = oracle[String(group.memberCount)] ?? oracle["5"] ?? 56;
  const displacement = Math.max(0, (group.span - target) / 2);
  let tier;
  if (displacement < 4) tier = "mild";
  else if (displacement < 20) tier = "mid";
  else if (displacement < extremeDisp) tier = "large";
  else tier = "extreme";
  return { target, displacement, tier };
}

/** span이 오라클 target을 초과하는 그룹만 수렴 대상(오라클=상한, 이미 타이트/coincident는 보존). */
export function needsConvergence(group, oracle) {
  return group.span > classifyGroup(group, oracle).target;
}

/** 멤버 분산 주방향을 H/V로 스냅(분산이 큰 축). */
export function capsuleAxis(members) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const m of members) {
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
  }
  return maxX - minX >= maxY - minY ? "H" : "V";
}

/** centroid 중심, targetSpan 폭, axis(H/V) 따라 멤버를 균등 배치.
 * 오프셋은 축 투영 순서로 배정해 입력 순서가 축 순서와 달라도 교차/뒤바뀜을 방지한다. */
export function capsuleTargets(members, targetSpan, axis) {
  const n = members.length;
  const cx = members.reduce((s, m) => s + m.x, 0) / n;
  const cy = members.reduce((s, m) => s + m.y, 0) / n;
  const pitch = n > 1 ? targetSpan / (n - 1) : 0;
  const start = n > 1 ? -(targetSpan) / 2 : 0;
  // 축 투영 순서로 오프셋 배정(입력 순서가 축 순서와 달라도 좌우 뒤바뀜/교차 방지)
  const order = members.map((_, i) => i).sort((a, b) =>
    axis === "H" ? members[a].x - members[b].x : members[a].y - members[b].y);
  const offByIdx = new Map(order.map((idx, k) => [idx, start + k * pitch]));
  return members.map((m, i) => {
    const off = offByIdx.get(i);
    return axis === "H"
      ? { lineId: m.lineId, x: cx + off, y: cy }
      : { lineId: m.lineId, x: cx, y: cy + off };
  });
}

/**
 * oldPos에서 가장 가까운 정점 인덱스를 찾는다 (threshold 30px).
 * 범위 내 정점이 없으면 -1 반환.
 * @internal
 */
function nearestVertexIndex(verts, oldPos, threshold = 30) {
  let minDist = Infinity;
  let minIdx = -1;
  for (let i = 0; i < verts.length; i += 1) {
    const d = dist(verts[i], oldPos);
    if (d < minDist) {
      minDist = d;
      minIdx = i;
    }
  }
  return minDist <= threshold ? minIdx : -1;
}

/**
 * 허브 정점을 newPos로 옮기고 [idx-radius, idx+radius] 윈도우만 8선형 재구성(원위 불변).
 * 정점이 없는 경우(mid-segment) 최근접 세그먼트에 np를 삽입한다.
 * 원위 정점은 반올림하지 않고(float base + 정확 45° dogleg 보존), 이동/삽입하는 np만 정수.
 * @returns {{ verts: Array<{x:number,y:number}>, attached: boolean }}
 */
export function spliceTrackToNode(verts, oldPos, newPos, { radius = 1, maxDist = 30, matchDist = null } = {}) {
  // newPos를 정수로 한번만 반올림 — position과 동일 정수라 track 정합 보장
  const np = { x: Math.round(newPos.x), y: Math.round(newPos.y) };
  // 정점-이동 매칭 반경. 기본은 maxDist(하위호환). 회랑 붕괴처럼 여러 역이 한 정점을
  // 공유할 때는 tight 값으로 넘겨, 앞선 역이 옮긴 정점을 뒤 역이 재포착하지 않고
  // mid-segment 삽입(Step 2)을 타게 한다(자기 정점만 이동, 남의 이동 정점은 삽입).
  const md = matchDist == null ? maxDist : matchDist;

  // Step 1: oldPos 가장 가까운 정점 탐색 (matchDist 이내 — 자기 정점만 이동)
  const idx = nearestVertexIndex(verts, oldPos, md);
  if (idx >= 0) {
    const moved = verts.map((v, i) => (i === idx ? np : { x: v.x, y: v.y }));
    const lo = Math.max(0, idx - radius);
    const hi = Math.min(moved.length - 1, idx + radius);
    const local = octilinearPolyline(moved.slice(lo, hi + 1));
    return { verts: [...moved.slice(0, lo), ...local, ...moved.slice(hi + 1)], attached: true };
  }

  // Step 2: 최근접 세그먼트에 mid-segment 삽입
  let bestSegDist = Infinity;
  let bestSegIdx = -1;
  for (let i = 0; i + 1 < verts.length; i += 1) {
    const d = pointToSegmentDistance(oldPos, verts[i], verts[i + 1]);
    if (d < bestSegDist) {
      bestSegDist = d;
      bestSegIdx = i;
    }
  }
  if (bestSegIdx >= 0 && bestSegDist <= maxDist) {
    const i = bestSegIdx;
    // np를 i+1 위치에 삽입; 원위 정점은 반올림하지 않음
    const moved = [...verts.slice(0, i + 1), np, ...verts.slice(i + 1)];
    // np는 index i+1; 윈도우 [i, (i+1)+radius]로 국소 8선형화
    const lo = Math.max(0, i);
    const hi = Math.min(moved.length - 1, (i + 1) + radius);
    const local = octilinearPolyline(moved.slice(lo, hi + 1));
    return { verts: [...moved.slice(0, lo), ...local, ...moved.slice(hi + 1)], attached: true };
  }

  // Step 3: 모든 세그먼트가 maxDist 밖 — 부착 실패
  return { verts: verts.slice(), attached: false };
}

/** 한 그룹 수렴: 캡슐 타깃 → 각 노선 track splice.
 * tracksByLine = Map(lineId → [{trackIndex, verts}]).
 * 원자성 불변식: 멤버 track에 부착(attached:true)한 경우에만 positionUpdate를 발행한다.
 * 어떤 track도 부착하지 못한 멤버는 positionUpdate를 발행하지 않는다.
 * 반환: { positionUpdates:[{stationId,lineId,x,y}], trackUpdates:[{lineId,trackIndex,verts}] }
 */
export function convergeGroup(group, oracle, tracksByLine) {
  const { target } = classifyGroup(group, oracle);
  const axis = capsuleAxis(group.members);
  const targets = capsuleTargets(group.members, target, axis);
  const targetByLine = new Map(targets.map((t) => [t.lineId, t]));
  const positionUpdates = [];
  const trackUpdates = [];
  for (const m of group.members) {
    const nt = targetByLine.get(m.lineId);
    // splice newPos는 정수로 반올림해 넘긴다(position과 동일 정수). octilinearSegment가
    // 정수 좌표에서 정확한 45°/축 corner를 내므로 dogleg 후 8선형이 반올림에 깨지지 않는다.
    const newPos = { x: Math.round(nt.x), y: Math.round(nt.y) };
    let memberAttached = false;
    for (const trk of tracksByLine.get(m.lineId) ?? []) {
      const { verts: spliced, attached } = spliceTrackToNode(trk.verts, { x: m.x, y: m.y }, newPos);
      if (attached) {
        memberAttached = true;
        if (JSON.stringify(spliced) !== JSON.stringify(trk.verts)) {
          trackUpdates.push({ lineId: m.lineId, trackIndex: trk.trackIndex, verts: spliced });
        }
      }
    }
    // 원자성: 부착 성공한 멤버만 positionUpdate 발행. attached:true가 "position이 track 위"를
    // 보장하는 근거 = octilinearPolyline이 입력 정점(정수 np)을 절대 드롭하지 않는 계약
    // (octolinearize-line-tracks.mjs). 그 헬퍼가 RDP/단순화로 바뀌면 이 불변식이 깨진다.
    if (memberAttached) {
      positionUpdates.push({
        stationId: group.stationId,
        lineId: m.lineId,
        x: newPos.x, // splice에 넘긴 정수 newPos와 동일값(반올림 이중 계산 제거)
        y: newPos.y,
      });
    }
  }
  return { positionUpdates, trackUpdates };
}

/** route_map_line_tracks → Map(lineId → [{trackIndex, verts}]). */
function loadTracksByLine(db, region) {
  const trackRows = db
    .prepare(
      "SELECT line_id, track_index, path FROM route_map_line_tracks WHERE region=? ORDER BY line_id, track_index",
    )
    .all(region);
  const tracksByLine = new Map();
  for (const t of trackRows) {
    if (!tracksByLine.has(t.line_id)) tracksByLine.set(t.line_id, []);
    tracksByLine.get(t.line_id).push({ trackIndex: t.track_index, verts: parsePathVertices(t.path) });
  }
  return tracksByLine;
}

/** 그룹별 수렴 루프: DB 기록(check=false 시) + 누적 tracksByLine 갱신.
 * @returns {{ applied: number, tierCount: object }}
 */
function applyConvergence(db, groups, oracle, selected, tracksByLine, check, region) {
  const posU = db.prepare(
    "UPDATE route_map_positions SET x=?, y=? WHERE region=? AND station_id=? AND line_id=?",
  );
  const trkU = db.prepare(
    "UPDATE route_map_line_tracks SET path=? WHERE region=? AND line_id=? AND track_index=?",
  );
  let applied = 0;
  const tierCount = { mild: 0, mid: 0, large: 0, extreme: 0 };
  for (const g of groups) {
    const cls = classifyGroup(g, oracle);
    tierCount[cls.tier] += 1;
    if (!selected.has(cls.tier)) continue;
    if (g.span <= cls.target) continue; // 이미 오라클 이내 — 스프레드 금지
    const { positionUpdates, trackUpdates } = convergeGroup(g, oracle, tracksByLine);
    if (positionUpdates.length) applied += 1;
    // 누적 갱신: 다음 그룹이 최신 정점을 사용하도록 tracksByLine 제자리 갱신
    for (const tu of trackUpdates) {
      const tracks = tracksByLine.get(tu.lineId);
      if (tracks) {
        const idx = tracks.findIndex((t) => t.trackIndex === tu.trackIndex);
        if (idx >= 0) tracks[idx] = { trackIndex: tu.trackIndex, verts: tu.verts };
      }
    }
    if (check) continue;
    for (const p of positionUpdates)
      posU.run(p.x, p.y, region, p.stationId, p.lineId);
    for (const tu of trackUpdates)
      // track 정점은 반올림하지 않는다: float base + 정확 45° dogleg 보존(convergeGroup 주석 참조)
      trkU.run(verticesToPath(tu.verts), region, tu.lineId, tu.trackIndex);
  }
  return { applied, tierCount };
}

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    index: "apps/mobile/assets/datapacks/index.json",
    region: "수도권",
    oracle: "tools/route-map/oracle-transfer-spans.json",
    tiers: "mild,mid,large",
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pack") o.pack = argv[++i];
    else if (a === "--index") o.index = argv[++i];
    else if (a === "--region") o.region = argv[++i];
    else if (a === "--oracle") o.oracle = argv[++i];
    else if (a === "--tiers") o.tiers = argv[++i];
    else if (a === "--check") o.check = true;
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  let oracle;
  try {
    oracle = JSON.parse(readFileSync(o.oracle, "utf8")).spanP90ByMemberCount;
  } catch (e) {
    console.error(`oracle 파일을 읽을 수 없음: ${o.oracle} (${e.message}) — oracle-metrics.mjs로 먼저 생성하세요`);
    process.exit(1);
  }
  if (!oracle) {
    // 유효 JSON이나 spanP90ByMemberCount 키 없음(스키마 불일치·잘못된 --oracle 경로) →
    // try-catch를 통과해 undefined가 되므로 여기서 명시 실패(안 하면 classifyGroup서 TypeError).
    console.error(`oracle 파일에 spanP90ByMemberCount 키가 없음: ${o.oracle}`);
    process.exit(1);
  }
  const selected = new Set(o.tiers.split(","));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "splice-conv-");
  try {
    const posRows = db
      .prepare("SELECT station_id, line_id, x, y FROM route_map_positions WHERE region=?")
      .all(o.region);
    const tracksByLine = loadTracksByLine(db, o.region);
    const groups = transferGroups(posRows);
    if (!o.check) db.exec("BEGIN");
    const { applied, tierCount } = applyConvergence(db, groups, oracle, selected, tracksByLine, o.check, o.region);
    console.log(
      `[${o.region}] 환승 ${groups.length} · 티어 ${JSON.stringify(tierCount)} · 적용(${o.tiers}) ${applied}`,
    );
    if (o.check) {
      console.log("(--check: 미기록)");
      db.close();
      return;
    }
    db.exec("COMMIT");
    db.exec("VACUUM");
    db.close();
    const { byteSize } = writePack({ sqlitePath, packPath, packRelPath: o.pack, indexRelPath: o.index });
    console.log(`팩 갱신 (byteSize ${byteSize})`);
  } finally {
    try { db.close(); } catch { /* 이미 닫힘(정상 경로) — 예외 이탈 시 핸들 누수 방지용 */ }
    cleanupPackDir(dir);
  }
}

if (isMainModule(import.meta.url)) main();
