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
 *
 * `pinStations`(#2068 P-65 재설계): true면 역을 트랙 위 투영점이 아니라 역의
 * **원본(SVG) 좌표 그대로** 트랙에 삽입한다 — "팩(hit target) = SVG(화면 그림)"
 * 정합을 트랙 쪽이 흡수하도록 방향을 뒤집는다(역이 트랙으로 이동하는 대신
 * 트랙이 역을 지나도록 정점을 꽂는다). 삽입 노드는 `pinnedNodeIds`에 표기되고
 * respaceGraph가 이 노드를 절대 움직이지 않는다. 기본값 false(기존 동작,
 * 타 권역 파이프라인 회귀 없음 — project-nodes-to-tracks가 여전히 이 역할).
 */
export function buildRespaceGraph({ tracks, positions, pinStations = false }) {
  // 트랙별 기하 사전 계산(closed/verts/segCount).
  const trackInfo = tracks.map((track) => {
    const pts = track.points;
    const closed =
      pts.length >= 2 &&
      Math.abs(pts[0].x - pts[pts.length - 1].x) < EPS &&
      Math.abs(pts[0].y - pts[pts.length - 1].y) < EPS;
    const verts = closed ? pts.slice(0, pts.length - 1) : pts.slice();
    const segCount =
      pts.length === 0 ? 0 : closed ? verts.length : verts.length - 1;
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
        if (best === null || pr.dist < best.dist)
          best = { ...pr, seg: s, tIdx };
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
          // pinStations: 투영점(asg.x/y) 대신 역의 원본 좌표를 그대로 꽂는다
          // — 트랙이 역을 향해 살짝 구부러지고, 역 자체는 절대 움직이지 않는다.
          x: pinStations ? st.x : asg.x,
          y: pinStations ? st.y : asg.y,
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
      const bounds = [...new Set([0, newVerts.length - 1, ...stIdx])].sort(
        (p, q) => p - q,
      );
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

  // pinStations: 역이 매핑된 모든 노드는 절대 이동 금지(원본 SVG 좌표 고정).
  const pinnedNodeIds = pinStations
    ? new Set(stationNodes.map((sn) => sn.nodeId))
    : new Set();

  return {
    nodes,
    tracks: outTracks,
    stationNodes,
    chains,
    clusters,
    warnings,
    pinnedNodeIds,
  };
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
  const snapped =
    Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
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
    // #2068 SVG euclidean 재간격기(Part 1): "arcLength"(기본, 기존 동작)는
    // clampLen([minRatio,maxRatio]*unit)로 chain 호길이를 양방향 클램프한다.
    // "euclideanFloor"는 chain **양끝 직선거리**가 unit(=임계, 보통 48)
    // 미만일 때만 그 직선거리를 unit까지 밀어 올린다(편측·하한만). 이미
    // 충분히 떨어진 chain은 절대 건드리지 않는다("코리더 방향 보존 연장" —
    // 압축·상한 없음, 필요한 곳만 정확히 늘린다). 직선(끝점) 거리 target으로
    // scale을 잡고 그 scale을 모든 세그먼트에 동일 적용하면(방향 고정 상태의
    // 균등 확대는 시작점 기준 닮음변환이라) 수렴 시 끝점 직선거리가 정확히
    // target에 도달한다.
    chainLengthMetric = "arcLength",
  } = options;
  const orig = graph.nodes;
  const pinned = graph.pinnedNodeIds ?? new Set();
  const clampLen = (v) =>
    Math.max(minRatio * unit, Math.min(maxRatio * unit, v));

  // 세그먼트 목표 길이(chain 비례 배분) + 스냅된 방향(고정).
  //
  // pinStations 그래프에서 hasStationEnds chain의 양끝은 고정 노드다 — 그
  // 양끝 간 실거리는 이미 SVG(euclidean 재간격기 산출물)가 결정했으므로,
  // clampLen으로 인위적 목표 arc length를 강제하면 고정 끝점과 충돌해 해가
  // 없는 제약이 된다(끝점이 못 움직이니 내부 정점만 무의미하게 진동).
  // clampLen을 건너뛰고 원래 arc length를 그대로 목표로 삼아 — 세그먼트별
  // 상대 배분(scale=1)만 유지, 방향 스냅(8선형)과 내부 정점 폴리싱만 작동한다.
  const segTargetByKey = new Map();
  for (const chain of graph.chains) {
    const ids = chain.nodeIds;
    const arcLen = chainLength(orig, ids);
    let target;
    if (chainLengthMetric === "euclideanFloor" && chain.hasStationEnds) {
      const endpointDist = dist2(orig[ids[0]], orig[ids[ids.length - 1]]);
      const floorTarget = Math.max(unit, endpointDist);
      // scale은 "끝점 직선거리 → floorTarget" 비율로 잡는다(arcLen이 아니라
      // endpointDist 기준) — 굽은 chain도 균등 확대가 시작점 기준 닮음변환이라
      // 수렴 시 끝점 직선거리가 정확히 floorTarget에 도달한다.
      target =
        endpointDist > 0 ? arcLen * (floorTarget / endpointDist) : arcLen;
    } else {
      target =
        chain.hasStationEnds && pinned.size === 0 ? clampLen(arcLen) : arcLen;
    }
    const cur = arcLen;
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
  //
  // pinStations: 고정 노드는 보정을 절대 받지 않는다 — 한쪽만 고정이면 반대쪽이
  // 보정 전량(기존 50/50 대신 100%)을 흡수해 내부(비역) 정점이 휘어 방향·길이를
  // 맞춘다. 양끝이 모두 고정(직접 인접 역-역 세그먼트)이면 보정 불가 — 그대로
  // 둔다(원본 SVG 기하가 곧 정답이므로 자유도가 없는 게 올바른 동작).
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
      const aPinned = pinned.has(seg.a);
      const bPinned = pinned.has(seg.b);
      if (aPinned && bPinned) continue;
      if (aPinned) {
        positions[seg.b] = { x: pb.x - cx, y: pb.y - cy };
      } else if (bPinned) {
        positions[seg.a] = { x: pa.x + cx, y: pa.y + cy };
      } else {
        positions[seg.a] = { x: pa.x + cx / 2, y: pa.y + cy / 2 };
        positions[seg.b] = { x: pb.x - cx / 2, y: pb.y - cy / 2 };
      }
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
      const along = (pb.x - pa.x) * seg.dir.x + (pb.y - pa.y) * seg.dir.y;
      return Math.abs(along - seg.target);
    })
    .sort((a, b) => a - b);
  const pct = (q) =>
    lengthErrs.length
      ? lengthErrs[
          Math.max(
            0,
            Math.min(
              lengthErrs.length - 1,
              Math.ceil(q * lengthErrs.length) - 1,
            ),
          )
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
    pinStations: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack":
        o.pack = argv[++i];
        break;
      case "--index":
        o.index = argv[++i];
        break;
      case "--region":
        o.region = argv[++i];
        break;
      case "--min":
        o.min = Number(argv[++i]);
        break;
      case "--max":
        o.max = Number(argv[++i]);
        break;
      case "--k-len":
        o.kLen = Number(argv[++i]);
        break;
      case "--k-anchor":
        o.kAnchor = Number(argv[++i]);
        break;
      case "--check":
        o.check = true;
        break;
      // #2068 P-65: 역 좌표를 SVG(=팩 route_map_positions 현재값, apply-sma-svg-
      // positions 직후 상태)에 고정하고 트랙만 정리한다. 기본 false — 지정하지
      // 않으면 기존 동작(타 권역 회귀 없음).
      case "--pin-stations":
        o.pinStations = true;
        break;
    }
  }
  return o;
}

/**
 * 팩(region)의 route_map_line_tracks + route_map_positions를 읽어 재간격 그래프를
 * 만든다. respace 솔버와 audit 게이트가 동일 기반을 쓰도록 공용화(중복 제거).
 */
export function loadRegionRespaceGraph(
  db,
  region,
  { pinStations = false } = {},
) {
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
    pinStations,
  });
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "respace-");
  try {
    const graph = loadRegionRespaceGraph(db, o.region, {
      pinStations: o.pinStations,
    });
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
