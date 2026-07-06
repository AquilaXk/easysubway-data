#!/usr/bin/env node
// #1789 재간격(schematic respacing): 준지리형 수도권 기하의 인접 역 간격을
// 8선형 방향 보존 아래 [min,max]로 정규화한다(도심 확대·외곽 압축 — 카카오·
// 서울시 신형 노선도의 준균일 간격 문법). 스펙:
// docs/superpowers/specs/2026-07-06-route-map-respacing-design.md

const round3 = (v) => Math.round(v * 1000) / 1000;
const EPS = 1e-6;
const REUSE_DIST = 0.5; // 이 거리 내면 기존 정점 재사용(중복 삽입 방지).
const WARN_DIST = 2.0; // 투영 거리가 이보다 크면 데이터 의심 경고.

/** 점 p를 선분 (a,b)에 투영 — 삽입 정렬에 필요한 매개변수 t 포함. */
function projectWithParam(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return { x: a.x, y: a.y, t: 0, dist: Math.hypot(p.x - a.x, p.y - a.y) };
  }
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq),
  );
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return { x, y, t, dist: Math.hypot(p.x - x, p.y - y) };
}

export function parsePathPoints(path) {
  const nums = [...String(path).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) =>
    Number(m[0]),
  );
  const points = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const p = { x: nums[i], y: nums[i + 1] };
    const last = points[points.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) {
      points.push(p);
    }
  }
  return points;
}

export function serializePathPoints(points) {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${round3(p.x)} ${round3(p.y)}`)
    .join(" ");
}

/**
 * track polyline과 역 투영점을 하나의 그래프로 만든다. 역을 선분 위 정점으로
 * 삽입하고, 역-역 chain·환승 cluster를 산출한다(스펙 R1 Task 4).
 */
export function buildRespaceGraph({ tracks, positions }) {
  // 트랙별 기하 사전 계산(closed/verts/segCount).
  const trackInfo = tracks.map((track) => {
    const pts = track.points;
    const closed =
      pts.length >= 2 &&
      Math.abs(pts[0].x - pts[pts.length - 1].x) < EPS &&
      Math.abs(pts[0].y - pts[pts.length - 1].y) < EPS;
    const verts = closed ? pts.slice(0, pts.length - 1) : pts.slice();
    const segCount = pts.length === 0 ? 0 : closed ? verts.length : verts.length - 1;
    return { track, closed, verts, segCount };
  });
  const trackIdxByLine = new Map();
  trackInfo.forEach((info, idx) => {
    if (!trackIdxByLine.has(info.track.lineId)) {
      trackIdxByLine.set(info.track.lineId, []);
    }
    trackIdxByLine.get(info.track.lineId).push(idx);
  });
  // 각 역을 **자기 노선의 트랙들 중 최근접 트랙 1개**에만 배정한다(다중 조각
  // 노선에서 엉뚱한 조각에 중복 삽입되던 버그 방지). positions 순회 순서 보존.
  const assignByTrack = new Map(); // trackIdx → [{station, seg, t, x, y, dist}]
  for (const st of positions) {
    let best = null;
    for (const tIdx of trackIdxByLine.get(st.lineId) ?? []) {
      const { verts, segCount } = trackInfo[tIdx];
      for (let s = 0; s < segCount; s += 1) {
        const a = verts[s];
        const b = verts[(s + 1) % verts.length];
        const pr = projectWithParam(st, a, b);
        if (best === null || pr.dist < best.dist) best = { ...pr, seg: s, tIdx };
      }
    }
    if (best === null) continue;
    if (!assignByTrack.has(best.tIdx)) assignByTrack.set(best.tIdx, []);
    assignByTrack.get(best.tIdx).push({ station: st, ...best });
  }

  const nodes = [];
  const outTracks = [];
  const stationNodes = [];
  const chains = [];
  const warnings = [];
  const clusterAcc = new Map(); // stationId → [{nodeId, point}]

  for (let ti = 0; ti < tracks.length; ti += 1) {
    const { track, closed, verts } = trackInfo[ti];
    if (track.points.length === 0) {
      outTracks.push({
        lineId: track.lineId,
        trackIndex: track.trackIndex,
        nodeIds: [],
        closed: false,
      });
      continue;
    }

    // 이 트랙에 배정된 역만 기존 정점 재사용 or 삽입 예약.
    const insertions = new Map(); // segIndex → [{t, station, x, y}]
    const exactVertex = []; // {station, vertexIndex}
    const assigned = assignByTrack.get(ti) ?? [];
    for (const asg of assigned) {
      const st = asg.station;
      if (asg.dist > WARN_DIST) {
        warnings.push(`${st.stationId} 투영거리 ${round3(asg.dist)}`);
      }
      const a = verts[asg.seg];
      const b = verts[(asg.seg + 1) % verts.length];
      if (Math.hypot(st.x - a.x, st.y - a.y) < REUSE_DIST) {
        exactVertex.push({ station: st, vertexIndex: asg.seg });
      } else if (Math.hypot(st.x - b.x, st.y - b.y) < REUSE_DIST) {
        exactVertex.push({
          station: st,
          vertexIndex: (asg.seg + 1) % verts.length,
        });
      } else {
        if (!insertions.has(asg.seg)) insertions.set(asg.seg, []);
        insertions.get(asg.seg).push({
          t: asg.t,
          station: st,
          x: asg.x,
          y: asg.y,
        });
      }
    }

    // 삽입을 반영한 새 정점 배열 + 역→새 정점 index 매핑.
    const newVerts = [];
    const oldToNew = new Array(verts.length);
    const stationToVertex = new Map();
    for (let vi = 0; vi < verts.length; vi += 1) {
      oldToNew[vi] = newVerts.length;
      newVerts.push(verts[vi]);
      const ins = insertions.get(vi);
      if (ins) {
        ins.sort((p, q) => p.t - q.t);
        for (const it of ins) {
          stationToVertex.set(it.station, newVerts.length);
          newVerts.push({ x: it.x, y: it.y });
        }
      }
    }
    for (const ev of exactVertex) {
      stationToVertex.set(ev.station, oldToNew[ev.vertexIndex]);
    }

    // 노드 등록(트랙 간 비공유). 닫힌 트랙은 끝에 첫 노드 alias.
    const baseNodeId = nodes.length;
    for (const v of newVerts) nodes.push({ x: v.x, y: v.y });
    const nodeIds = newVerts.map((_, i) => baseNodeId + i);
    if (closed) nodeIds.push(baseNodeId);
    outTracks.push({
      lineId: track.lineId,
      trackIndex: track.trackIndex,
      nodeIds,
      closed,
    });

    // stationNodes + cluster 누적. (positions 순서 보존을 위해 순회 순서 유지.)
    const stationVertexIndices = [];
    for (const asg of assigned) {
      const st = asg.station;
      if (!stationToVertex.has(st)) continue;
      const vIndex = stationToVertex.get(st);
      const nodeId = baseNodeId + vIndex;
      stationNodes.push({
        stationId: st.stationId,
        lineId: st.lineId,
        nodeId,
      });
      if (!clusterAcc.has(st.stationId)) clusterAcc.set(st.stationId, []);
      clusterAcc.get(st.stationId).push({
        nodeId,
        point: { x: nodes[nodeId].x, y: nodes[nodeId].y },
      });
      stationVertexIndices.push(vIndex);
    }

    // chains: 트랙 정점열을 역 정점에서 절단.
    const stIdx = [...new Set(stationVertexIndices)].sort((p, q) => p - q);
    const stSet = new Set(stIdx);
    if (!closed) {
      const bounds = [
        ...new Set([0, newVerts.length - 1, ...stIdx]),
      ].sort((p, q) => p - q);
      for (let i = 0; i + 1 < bounds.length; i += 1) {
        const lo = bounds[i];
        const hi = bounds[i + 1];
        chains.push({
          trackIdx: ti,
          nodeIds: nodeIds.slice(lo, hi + 1),
          hasStationEnds: stSet.has(lo) && stSet.has(hi),
        });
      }
    } else if (stIdx.length >= 2) {
      for (let i = 0; i < stIdx.length; i += 1) {
        const lo = stIdx[i];
        const hi = stIdx[(i + 1) % stIdx.length];
        const seq = [nodeIds[lo]];
        let k = lo;
        while (k !== hi) {
          k = (k + 1) % newVerts.length;
          seq.push(nodeIds[k]);
        }
        chains.push({ trackIdx: ti, nodeIds: seq, hasStationEnds: true });
      }
    }
  }

  const clusters = [];
  for (const [stationId, members] of clusterAcc) {
    if (members.length < 2) continue;
    const mx = members.reduce((s, m) => s + m.point.x, 0) / members.length;
    const my = members.reduce((s, m) => s + m.point.y, 0) / members.length;
    clusters.push({
      stationId,
      members: members.map((m) => ({
        nodeId: m.nodeId,
        offset: { x: m.point.x - mx, y: m.point.y - my },
      })),
    });
  }

  return { nodes, tracks: outTracks, stationNodes, chains, clusters, warnings };
}

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function chainLength(nodes, nodeIds) {
  let sum = 0;
  for (let i = 1; i < nodeIds.length; i += 1) {
    sum += dist2(nodes[nodeIds[i - 1]], nodes[nodeIds[i]]);
  }
  return sum;
}

/** hasStationEnds chain 길이의 중앙값 (재간격 단위 unit 기본값). */
export function medianStationChainLength(graph) {
  const lengths = graph.chains
    .filter((c) => c.hasStationEnds)
    .map((c) => chainLength(graph.nodes, c.nodeIds))
    .sort((a, b) => a - b);
  return lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
}

/** 원본 방향을 가장 가까운 45° 배수로 스냅 — 원본이 95.6% octolinear라
 *  스냅이 off-grid 잔재(baseline 위반 39건)까지 정리한다. */
function snapOctolinearDir(dx, dy) {
  const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: Math.cos(snapped), y: Math.sin(snapped) };
}

/**
 * 하드 방향(45° 스냅) + 소프트 길이(스프링) + 소프트 앵커 완화 솔버.
 *
 * 하드 방향·하드 길이 정식화는 순환선·환승 cluster가 만드는 순환 제약
 * 그래프에서 해가 없어 잔차 ~150px plateau에 갇힌다(2026-07-06 실측, 계획서
 * "근본 원인 진단" ①). 길이를 스프링으로 풀면 cycle 불일치가 각도 붕괴 대신
 * 미세 길이 신축으로 흡수된다 — 8선형은 하드(수직 성분 전량 제거 + 폴리싱),
 * 길이는 kLen, 원위치는 kAnchor 가중(자유공간 교차 ↔ 간격 트레이드오프 축).
 * cluster는 매 sweep 강체 재동기화 — 멤버 상대 offset은 렌더 정합상 정확해야
 * 하며, 소프트 cluster + 최종 스냅 변형은 폴리싱을 깨 8선형 위반 11→300+로
 * 악화되어 기각됐다(동 실측 ②).
 *
 * kLen/kAnchor/maxRatio 시작값은 상수로 두고 Task 3 스윕에서 실측 확정한다.
 */
export function respaceGraph(graph, options) {
  const {
    unit,
    minRatio = 1.0,
    // 2026-07-06 스윕 실측(sweep-respacing.mjs): kAnchor=0.1, maxRatio=1.8 →
    // free=26, octo=11, p95/p5=6.6 — 게이트는 이 실측치 + 소여유.
    maxRatio = 1.8, // Task 3 스윕에서 확정 (균형 config)
    kLen = 0.3, // Task 3 스윕에서 확정 (길이 스프링 강도)
    kAnchor = 0.1, // Task 3 스윕에서 확정 (원위치 앵커 강도)
    iterations = 1500,
    tolerance = 0.01,
    polishSweeps = 150,
  } = options;
  const orig = graph.nodes;
  const clampLen = (v) =>
    Math.max(minRatio * unit, Math.min(maxRatio * unit, v));

  // 세그먼트 목표 길이(chain 비례 배분) + 스냅된 방향(고정).
  const segTargetByKey = new Map();
  for (const chain of graph.chains) {
    const ids = chain.nodeIds;
    const cur = chainLength(orig, ids);
    const target = chain.hasStationEnds ? clampLen(cur) : cur;
    const scale = cur > 0 ? target / cur : 1;
    for (let i = 1; i < ids.length; i += 1) {
      const ol = dist2(orig[ids[i - 1]], orig[ids[i]]);
      segTargetByKey.set(`${ids[i - 1]},${ids[i]}`, ol * scale);
    }
  }
  const segments = [];
  for (const track of graph.tracks) {
    const ids = track.nodeIds;
    for (let i = 1; i < ids.length; i += 1) {
      const a = ids[i - 1];
      const b = ids[i];
      const ol = dist2(orig[a], orig[b]);
      if (ol === 0) continue;
      const key = `${a},${b}`;
      segments.push({
        a,
        b,
        dir: snapOctolinearDir(orig[b].x - orig[a].x, orig[b].y - orig[a].y),
        target: segTargetByKey.has(key) ? segTargetByKey.get(key) : ol,
      });
    }
  }

  const positions = orig.map((n) => ({ x: n.x, y: n.y }));

  const resyncClusters = () => {
    for (const cluster of graph.clusters) {
      let mx = 0;
      let my = 0;
      for (const m of cluster.members) {
        mx += positions[m.nodeId].x - m.offset.x;
        my += positions[m.nodeId].y - m.offset.y;
      }
      mx /= cluster.members.length;
      my /= cluster.members.length;
      for (const m of cluster.members) {
        positions[m.nodeId] = { x: mx + m.offset.x, y: my + m.offset.y };
      }
    }
  };

  // perpendicularOnly=false: 수직 성분 전량 + 길이 오차의 kLen배를 보정.
  // perpendicularOnly=true(폴리싱): 수직 성분만 — 8선형 방향 정확 복원.
  const sweep = (perpendicularOnly) => {
    let maxCorrection = 0;
    for (const seg of segments) {
      const pa = positions[seg.a];
      const pb = positions[seg.b];
      const ex = pb.x - pa.x;
      const ey = pb.y - pa.y;
      const along = ex * seg.dir.x + ey * seg.dir.y;
      const lenErr = perpendicularOnly ? 0 : (along - seg.target) * kLen;
      const cx = ex - along * seg.dir.x + lenErr * seg.dir.x;
      const cy = ey - along * seg.dir.y + lenErr * seg.dir.y;
      const mag = Math.hypot(cx, cy);
      if (mag > maxCorrection) maxCorrection = mag;
      positions[seg.a] = { x: pa.x + cx / 2, y: pa.y + cy / 2 };
      positions[seg.b] = { x: pb.x - cx / 2, y: pb.y - cy / 2 };
    }
    return maxCorrection;
  };

  let sweeps = 0;
  for (let it = 0; it < iterations; it += 1) {
    const moved = sweep(false);
    if (kAnchor > 0) {
      for (let i = 0; i < positions.length; i += 1) {
        positions[i].x += (orig[i].x - positions[i].x) * kAnchor;
        positions[i].y += (orig[i].y - positions[i].y) * kAnchor;
      }
    }
    resyncClusters();
    sweeps += 1;
    if (moved < tolerance) break;
  }
  let maxPerpResidual = 0;
  for (let it = 0; it < polishSweeps; it += 1) {
    maxPerpResidual = sweep(true);
    resyncClusters();
    sweeps += 1;
  }

  const lengthErrs = segments
    .map((seg) => {
      const pa = positions[seg.a];
      const pb = positions[seg.b];
      const along =
        (pb.x - pa.x) * seg.dir.x + (pb.y - pa.y) * seg.dir.y;
      return Math.abs(along - seg.target);
    })
    .sort((a, b) => a - b);
  const pct = (q) =>
    lengthErrs.length
      ? lengthErrs[
          Math.max(0, Math.min(lengthErrs.length - 1, Math.ceil(q * lengthErrs.length) - 1))
        ]
      : 0;
  return {
    positions,
    report: {
      sweeps,
      maxPerpResidual,
      lengthErrP95: pct(0.95),
      lengthErrMax: lengthErrs.length ? lengthErrs[lengthErrs.length - 1] : 0,
    },
  };
}

import { cleanupPackDir, openPack, writePack } from "./pack-io.mjs";

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    index: "apps/mobile/assets/datapacks/index.json",
    region: "수도권",
    min: 1.0,
    // 2026-07-06 스윕 실측(sweep-respacing.mjs): kAnchor=0.1, maxRatio=1.8 →
    // free=26, octo=11, p95/p5=6.6 — CLI 기본값을 respaceGraph 함수 기본값과 정합.
    max: 1.8,
    kLen: 0.3,
    kAnchor: 0.1,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": o.pack = argv[++i]; break;
      case "--index": o.index = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--min": o.min = Number(argv[++i]); break;
      case "--max": o.max = Number(argv[++i]); break;
      case "--k-len": o.kLen = Number(argv[++i]); break;
      case "--k-anchor": o.kAnchor = Number(argv[++i]); break;
      case "--check": o.check = true; break;
    }
  }
  return o;
}

/**
 * 팩(region)의 route_map_line_tracks + route_map_positions를 읽어 재간격 그래프를
 * 만든다. respace 솔버와 audit 게이트가 동일 기반을 쓰도록 공용화(중복 제거).
 */
export function loadRegionRespaceGraph(db, region) {
  const trackRows = db
    .prepare(
      "SELECT line_id, track_index, path FROM route_map_line_tracks " +
        "WHERE region = ? ORDER BY line_id, track_index",
    )
    .all(region);
  const posRows = db
    .prepare(
      "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?",
    )
    .all(region);
  const tracks = trackRows.map((r) => ({
    lineId: r.line_id,
    trackIndex: r.track_index,
    points: parsePathPoints(r.path),
  }));
  return buildRespaceGraph({
    tracks,
    positions: posRows.map((r) => ({
      stationId: r.station_id,
      lineId: r.line_id,
      x: r.x,
      y: r.y,
    })),
  });
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "respace-");
  try {
    const graph = loadRegionRespaceGraph(db, o.region);
    const unit = medianStationChainLength(graph);
    const { positions, report } = respaceGraph(graph, {
      unit,
      minRatio: o.min,
      maxRatio: o.max,
      kLen: o.kLen,
      kAnchor: o.kAnchor,
    });
    console.log(
      `[${o.region}] unit ${round3(unit)} · sweeps ${report.sweeps} · ` +
        `방향잔차 ${round3(report.maxPerpResidual)} · ` +
        `길이타협 p95 ${round3(report.lengthErrP95)} max ${round3(report.lengthErrMax)} · ` +
        `투영경고 ${graph.warnings.length}`,
    );
    for (const w of graph.warnings.slice(0, 10)) console.log("  " + w);
    if (o.check) {
      console.log("(--check: 미기록)");
      return;
    }
    db.exec("BEGIN");
    const updTrack = db.prepare(
      "UPDATE route_map_line_tracks SET path = ? " +
        "WHERE region = ? AND line_id = ? AND track_index = ?",
    );
    for (const t of graph.tracks) {
      if (t.nodeIds.length === 0) continue;
      const pts = t.nodeIds.map((id) => positions[id]);
      updTrack.run(serializePathPoints(pts), o.region, t.lineId, t.trackIndex);
    }
    const updPos = db.prepare(
      "UPDATE route_map_positions SET x = ?, y = ? " +
        "WHERE region = ? AND station_id = ? AND line_id = ?",
    );
    for (const sn of graph.stationNodes) {
      const p = positions[sn.nodeId];
      updPos.run(round3(p.x), round3(p.y), o.region, sn.stationId, sn.lineId);
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
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
