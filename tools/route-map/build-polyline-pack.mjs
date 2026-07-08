#!/usr/bin/env node
//
// #1876 S0 스파이크 (에픽 #1875, (v) 파이프라인): 준지리형 기하를 버리고,
// "사람이 노선 폴리라인(제어점 6~8개/노선)을 그리고 역은 자동 균등 투영"하는
// 파이프라인의 진입점. 정의 JSON을 읽어 baseline 팩을 복사한 스파이크 팩의
// route_map_line_tracks / route_map_positions를 정의된 노선분만으로 교체한다.
// baseline 원본과 index.json은 절대 건드리지 않는다(스파이크 팩은 index 미등록).
//
// ─────────────────────────────────────────────────────────────────────────
// 폴리라인 정의 포맷 (산출물 1, JSON) — 이 주석이 스키마 정본이다(한국어).
// ─────────────────────────────────────────────────────────────────────────
// {
//   "region": "수도권",                     // 교체 대상 region (필수)
//   "anchors": {                            // 공유 정점 사전(선택): 이름→design 좌표.
//     "시청": { "x": 100, "y": 100 }        // 여러 노선이 같은 정점을 참조해 정합 강제.
//   },
//   "lines": [                              // 노선 목록(필수)
//     {
//       "name": "수도권 2호선",              // 팩 lines.name_ko와 정확히 일치해야 함
//       "loop": true,                       // 닫힌 순환 노선 여부(선택, 기본 false)
//       "vertices": [                       // 폴리라인 제어점(정점) 목록(필수)
//         { "anchor": "시청", "station": "stn-cityhall" },  // ① anchor 참조 + 고정 역
//         { "x": 300, "y": 100 },                            // ② 인라인 좌표(순수 제어점)
//         { "x": 300, "y": 300, "station": "stn-terminus" }  // 인라인 좌표 + 고정 역
//       ],
//       "spurs": [                          // 지선(분기) 목록(선택)
//         {
//           // 첫 정점 = 분기점(본선과 공유하는 역/anchor), 마지막 = 지선 종점.
//           "vertices": [
//             { "anchor": "성수", "station": "stn-seongsu" },
//             { "x": 400, "y": 300, "station": "stn-spur-end" }
//           ]
//         }
//       ]
//     }
//   ],
//   "corridors": [                          // 평행 주행 구간 선언(선택)
//     {
//       "name": "당산-합정",
//       "members": [                        // ≥2개 노선, 각자의 정점 index 구간(inclusive)
//         { "line": "수도권 2호선", "range": [3, 6] },
//         { "line": "수도권 6호선", "range": [0, 3] }
//       ],
//       "offsetOrder": ["수도권 2호선", "수도권 6호선"]  // 렌더 평행 오프셋 순서
//     }
//   ],
//   "guides": [                             // 비노선 가이드 기하(선택, 팩 미기록·파일 보존)
//     { "name": "한강", "vertices": [ { "x": 0, "y": 200 }, { "x": 800, "y": 240 } ] }
//   ]
// }
//
// 규칙:
//  • 정점(vertices)은 ① anchor 참조 또는 ② 인라인 x/y 로 좌표를 갖는다.
//    anchor + 인라인을 함께 주면 anchor가 우선하며 좌표 불일치는 에러.
//  • 정점에 "station"(팩 station_id)을 주면 그 정점 = 고정 역(환승·종점·분기역).
//  • 인접 정점 간 방향은 8선형(0/45/90/135°)이어야 한다(로더 검증, 위반 시 정점 index).
//  • 중간역(고정 아님)은 line_sequence 순서대로 고정 정점 사이 폴리라인에
//    arc-length 균등 투영된다. 각 구간 길이 ≥ (중간역 수 + 1) × min-gap.
//
// ─────────────────────────────────────────────────────────────────────────
// 파이프라인 진입점 (산출물 2)
// ─────────────────────────────────────────────────────────────────────────
// Usage: node tools/route-map/build-polyline-pack.mjs
//          --defs <정의 JSON> --base-pack <baseline 팩> --out <스파이크 팩 경로>
//          [--region 수도권] [--min-gap 26] [--target-gap 50] [--check]
//   (--check 지정 시 --out은 무시되며 파일을 쓰지 않고 통계만 출력한다)

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  isOctolinearAngle,
  segmentAngleDeg,
  verticesToPath,
} from "./audit-octolinearity.mjs";
import { cleanupPackDir, repoRoot, sha256 } from "./pack-io.mjs";

/** 기본 라벨폭(px) — 세그먼트 예산 최소 간격. 롤모델 실측 근거. */
export const DEFAULT_MIN_GAP = 26;
/** 기본 목표 간격(px) = 라벨폭 26 × 1.9 (롤모델 준균일 간격). */
export const DEFAULT_TARGET_GAP = 50;

const round3 = (v) => Math.round(v * 1000) / 1000;

// ── 기하 헬퍼 ───────────────────────────────────────────────────────────

/** 폴리라인(정점 배열)의 총 arc-length. */
export function polylineLength(vertices) {
  let sum = 0;
  for (let i = 1; i < vertices.length; i += 1) {
    sum += Math.hypot(
      vertices[i].x - vertices[i - 1].x,
      vertices[i].y - vertices[i - 1].y,
    );
  }
  return sum;
}

/** 폴리라인 위 arc-length s 위치의 점. s는 [0, 총길이]로 클램프. */
export function pointAtArcLength(vertices, s) {
  if (vertices.length === 0) return null;
  if (vertices.length === 1) return { x: vertices[0].x, y: vertices[0].y };
  const total = polylineLength(vertices);
  const target = Math.max(0, Math.min(total, s));
  let acc = 0;
  for (let i = 1; i < vertices.length; i += 1) {
    const seg = Math.hypot(
      vertices[i].x - vertices[i - 1].x,
      vertices[i].y - vertices[i - 1].y,
    );
    if (seg === 0) continue;
    if (acc + seg >= target) {
      const t = (target - acc) / seg;
      return {
        x: vertices[i - 1].x + t * (vertices[i].x - vertices[i - 1].x),
        y: vertices[i - 1].y + t * (vertices[i].y - vertices[i - 1].y),
      };
    }
    acc += seg;
  }
  const last = vertices[vertices.length - 1];
  return { x: last.x, y: last.y };
}

/**
 * 폴리라인 위에 `count`개의 내부 점을 arc-length 균등 배치해 돌려준다.
 * 두 고정 정점 사이 중간역 투영에 사용(구간을 count+1 등분).
 */
export function equidistantInterior(vertices, count) {
  if (count <= 0) return [];
  const total = polylineLength(vertices);
  const step = total / (count + 1);
  const out = [];
  for (let k = 1; k <= count; k += 1) {
    out.push(pointAtArcLength(vertices, step * k));
  }
  return out;
}

// ── 정의 로드·검증 ───────────────────────────────────────────────────────

/** 정점의 design-space 좌표를 anchors 사전으로 해석. 오류는 한국어 throw. */
function resolveVertexCoord(vertex, anchors, lineName, index) {
  let coord = null;
  if (vertex.anchor !== undefined) {
    if (!Object.hasOwn(anchors, vertex.anchor)) {
      throw new Error(
        `앵커 "${vertex.anchor}"를 anchors 사전에서 찾을 수 없습니다 ` +
          `(노선 "${lineName}" 정점 ${index}).`,
      );
    }
    const a = anchors[vertex.anchor];
    coord = { x: a.x, y: a.y };
  }
  if (vertex.x !== undefined && vertex.y !== undefined) {
    if (coord && (coord.x !== vertex.x || coord.y !== vertex.y)) {
      throw new Error(
        `노선 "${lineName}" 정점 ${index}의 인라인 좌표(${vertex.x},${vertex.y})가 ` +
          `앵커 "${vertex.anchor}" 좌표(${coord.x},${coord.y})와 불일치합니다.`,
      );
    }
    coord = coord ?? { x: vertex.x, y: vertex.y };
  }
  if (!coord) {
    throw new Error(
      `노선 "${lineName}" 정점 ${index}에 좌표가 없습니다(anchor 또는 x/y 필요).`,
    );
  }
  return { x: coord.x, y: coord.y, station: vertex.station };
}

/** 한 폴리라인(정점 배열)의 인접 정점 방향이 8선형인지 검증. closed면 wrap도. */
function assertOctolinear(vertices, closed, label) {
  const pairs = [];
  for (let i = 1; i < vertices.length; i += 1) pairs.push([i - 1, i]);
  if (closed && vertices.length >= 2) pairs.push([vertices.length - 1, 0]);
  for (const [i, j] of pairs) {
    const deg = segmentAngleDeg(vertices[i], vertices[j]);
    if (!isOctolinearAngle(deg, 0.5)) {
      throw new Error(
        `${label} 정점 ${i}→${j} 방향이 8선형(0/45/90/135°)이 아닙니다: ` +
          `${deg === null ? "길이0" : round3(deg) + "°"}.`,
      );
    }
  }
}

/** 정의의 한 노선을 검증·정규화한다(본선·지선 정점 해석 + 8선형 검증). */
function normalizeLine(line, anchors) {
  if (!line.name) throw new Error("노선에 name이 없습니다.");
  if (!Array.isArray(line.vertices) || line.vertices.length < 2) {
    throw new Error(`노선 "${line.name}"에 정점이 2개 미만입니다.`);
  }
  const mainVerts = line.vertices.map((v, i) =>
    resolveVertexCoord(v, anchors, line.name, i),
  );
  assertOctolinear(mainVerts, Boolean(line.loop), `노선 "${line.name}"`);

  const spurs = (line.spurs ?? []).map((spur, si) => {
    if (!Array.isArray(spur.vertices) || spur.vertices.length < 2) {
      throw new Error(`노선 "${line.name}" 지선 ${si}에 정점이 2개 미만입니다.`);
    }
    const verts = spur.vertices.map((v, i) =>
      resolveVertexCoord(v, anchors, `${line.name} 지선 ${si}`, i),
    );
    assertOctolinear(verts, false, `노선 "${line.name}" 지선 ${si}`);
    return { vertices: verts };
  });

  return { name: line.name, loop: Boolean(line.loop), vertices: mainVerts, spurs };
}

/** corridor 한 멤버의 선언 구간 정점 시퀀스를 잘라 돌려준다. */
function corridorMemberSeq(member, corridorName, linesByName) {
  const line = linesByName.get(member.line);
  if (!line) {
    throw new Error(
      `corridor "${corridorName}"가 없는 노선 "${member.line}"를 참조합니다.`,
    );
  }
  const [lo, hi] = member.range ?? [];
  if (lo == null || hi == null || lo < 0 || hi >= line.vertices.length) {
    throw new Error(
      `corridor "${corridorName}" 노선 "${member.line}" 구간 [${lo},${hi}]가 ` +
        `정점 범위를 벗어납니다(0~${line.vertices.length - 1}).`,
    );
  }
  const step = lo <= hi ? 1 : -1;
  const out = [];
  for (let i = lo; step > 0 ? i <= hi : i >= hi; i += step) {
    out.push(line.vertices[i]);
  }
  return { line: member.line, verts: out };
}

/** 한 corridor의 멤버 시퀀스들이 정점 좌표까지 일치하는지 검증한다. */
function assertCorridorMatch(corridorName, seqs) {
  const ref = seqs[0];
  for (let k = 1; k < seqs.length; k += 1) {
    const cur = seqs[k];
    if (cur.verts.length !== ref.verts.length) {
      throw new Error(
        `corridor "${corridorName}" 구간 길이가 노선 "${ref.line}"(${ref.verts.length})와 ` +
          `"${cur.line}"(${cur.verts.length})에서 다릅니다.`,
      );
    }
    for (let i = 0; i < ref.verts.length; i += 1) {
      if (ref.verts[i].x !== cur.verts[i].x || ref.verts[i].y !== cur.verts[i].y) {
        throw new Error(
          `corridor "${corridorName}" 정점 ${i}가 노선 "${ref.line}"` +
            `(${ref.verts[i].x},${ref.verts[i].y})와 "${cur.line}"` +
            `(${cur.verts[i].x},${cur.verts[i].y})에서 일치하지 않습니다.`,
        );
      }
    }
  }
}

/** 정의 corridor 목록 전체의 정점 시퀀스 일치를 검증한다. */
function validateCorridors(corridors, linesByName) {
  for (const corridor of corridors) {
    const members = corridor.members ?? [];
    const corridorName = corridor.name ?? "?";
    if (members.length < 2) {
      throw new Error(`corridor "${corridorName}"는 멤버 노선이 2개 미만입니다.`);
    }
    const seqs = members.map((m) => corridorMemberSeq(m, corridorName, linesByName));
    assertCorridorMatch(corridorName, seqs);
  }
}

/**
 * 정의 JSON을 검증·정규화한다. anchor 참조 무결성·8선형·corridor 일치를 확인하고,
 * 노선별 해석된 정점(본선/지선)을 돌려준다. 위반은 정점 index를 짚어 한국어 throw.
 */
export function loadAndValidateDefs(defs) {
  if (!defs || typeof defs !== "object") {
    throw new Error("정의가 객체가 아닙니다.");
  }
  // region은 선택 필드 — 없으면 null 반환(buildPolylinePack에서 CLI --region으로 보완).
  if (!Array.isArray(defs.lines) || defs.lines.length === 0) {
    throw new Error("정의에 lines가 없습니다.");
  }
  const anchors = defs.anchors ?? {};

  const lines = [];
  const linesByName = new Map();
  for (const line of defs.lines) {
    const normalized = normalizeLine(line, anchors);
    lines.push(normalized);
    linesByName.set(normalized.name, normalized);
  }

  // corridor 일치 검증: 선언 구간의 정점 좌표 시퀀스가 멤버 노선에서 실제 일치.
  validateCorridors(defs.corridors ?? [], linesByName);

  return { region: defs.region ?? null, anchors, lines, guides: defs.guides ?? [] };
}

// ── 역 배치(고정 + 중간역 균등 투영) ──────────────────────────────────────

/** closed 여부를 고려해 start→end 정점 index 사이 sub-polyline을 잘라 돌려준다. */
function subPolyline(vertices, startIdx, endIdx, closed) {
  if (!closed || startIdx <= endIdx) {
    return vertices.slice(startIdx, endIdx + 1);
  }
  return vertices.slice(startIdx).concat(vertices.slice(0, endIdx + 1));
}

/** piece 정점 중 sequence에 있는 고정 정점을 {vIndex, station, seqPos}로 수집. */
function collectFixedVertices(verts, seqIndex) {
  const fixedV = [];
  verts.forEach((v, i) => {
    if (v.station !== undefined && seqIndex.has(v.station)) {
      fixedV.push({ vIndex: i, station: v.station, seqPos: seqIndex.get(v.station) });
    }
  });
  return fixedV;
}

/** 고정 정점 순서가 line_sequence 전진 방향(단조 증가)인지 검증. 위반 시 throw. */
function assertForwardSequence(fixedV, closed, pieceLabel) {
  // 루프면 최소 seqPos 위치로 회전한 뒤 단조 증가를 확인한다.
  let ordered = fixedV;
  let loopNote = "";
  if (closed) {
    const minIdx = fixedV.reduce(
      (mi, v, i) => (v.seqPos < fixedV[mi].seqPos ? i : mi),
      0,
    );
    ordered = [...fixedV.slice(minIdx), ...fixedV.slice(0, minIdx)];
    loopNote = "(루프)";
  }
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].seqPos <= ordered[i - 1].seqPos) {
      throw new Error(
        `${pieceLabel}: 폴리라인 정점 순서가 line_sequence 전진 방향과 반대입니다${loopNote}. ` +
          `정점 ${ordered[i - 1].vIndex}(seqPos=${ordered[i - 1].seqPos}) → ` +
          `정점 ${ordered[i].vIndex}(seqPos=${ordered[i].seqPos}): seqPos가 감소합니다.`,
      );
    }
  }
}

/** 고정 정점 배열을 인접 arc [a,b] 쌍으로 만든다(closed면 마지막→첫 정점 추가). */
function buildArcs(fixedV, closed) {
  const arcs = [];
  for (let i = 0; i + 1 < fixedV.length; i += 1) arcs.push([fixedV[i], fixedV[i + 1]]);
  if (closed) arcs.push([fixedV.at(-1), fixedV[0]]);
  return arcs;
}

/** arc a→b 사이의 중간역 station_id를 seq 순서로 수집(고정·기배치 역 제외). */
function collectArcMiddles(a, b, { sequence, total, closed, fixedStations, claimed }) {
  const middles = [];
  let p = a.seqPos;
  for (let step = 0; step < total; step += 1) {
    p = closed ? (p + 1) % total : p + 1;
    if (!closed && p >= total) break;
    if (p === b.seqPos) break;
    const sid = sequence[p];
    if (fixedStations.has(sid) || claimed.has(sid)) continue;
    middles.push(sid);
  }
  return middles;
}

/**
 * 한 노선의 track path + 역 위치를 계획한다.
 *  - sequence: line_sequence 오름차순 station_id 배열(중간역 순서 원천).
 *  - 반환 tracks: [{ trackIndex, vertices, path }] (0=본선, 1..N=지선).
 *  - 반환 positions: [{ stationId, x, y }] (고정 정점 역 + 중간역).
 * 세그먼트 예산 위반·미배치 역은 한국어 throw.
 */
export function planLine({ line, sequence, minGap = DEFAULT_MIN_GAP }) {
  if (!Number.isFinite(minGap) || minGap <= 0) {
    throw new Error(`minGap은 양의 유한수여야 합니다(현재값: ${minGap}).`);
  }
  const seqIndex = new Map();
  sequence.forEach((sid, i) => seqIndex.set(sid, i));

  // 모든 piece(본선+지선)의 고정 역 집합.
  const fixedStations = new Set();
  const collectFixed = (verts) => {
    for (const v of verts) {
      if (v.station !== undefined) fixedStations.add(v.station);
    }
  };
  collectFixed(line.vertices);
  for (const spur of line.spurs) collectFixed(spur.vertices);

  const positions = [];
  const claimed = new Set();
  const stats = [];

  // 고정 정점 역 좌표 확정(본선 정점 우선).
  const fixedCoord = new Map();
  const setFixed = (verts) => {
    for (const v of verts) {
      if (v.station !== undefined && !fixedCoord.has(v.station)) {
        fixedCoord.set(v.station, { x: v.x, y: v.y });
      }
    }
  };
  setFixed(line.vertices);
  for (const spur of line.spurs) setFixed(spur.vertices);
  for (const [sid, c] of fixedCoord) {
    positions.push({ stationId: sid, x: c.x, y: c.y });
  }

  const total = sequence.length;
  const placePiece = (verts, closed, pieceLabel) => {
    // piece의 고정 정점(정점 index + seq 위치)을 정점 순서로 수집.
    const fixedV = collectFixedVertices(verts, seqIndex);
    if (fixedV.length < 2) return; // 고정 정점 부족 — 중간역 배치 없음.

    // seqPos 방향성 검증: 폴리라인 정점 순서가 line_sequence 전진 방향이어야 함.
    assertForwardSequence(fixedV, closed, pieceLabel);

    const arcs = buildArcs(fixedV, closed);
    for (const [a, b] of arcs) {
      // 중간역: seq를 a.seqPos+1부터 전진(closed면 wrap)해 b.seqPos 전까지,
      // 고정도 아니고 이미 배치되지 않은 역만 순서대로 수집.
      const middles = collectArcMiddles(a, b, {
        sequence,
        total,
        closed,
        fixedStations,
        claimed,
      });
      const sub = subPolyline(verts, a.vIndex, b.vIndex, closed);
      const arcLen = polylineLength(sub);
      const needed = (middles.length + 1) * minGap;
      if (arcLen < needed - 1e-6) {
        throw new Error(
          `${pieceLabel} 구간 ${a.station}→${b.station} 길이 ${round3(arcLen)}px가 ` +
            `필요 길이 ${round3(needed)}px(중간역 ${middles.length}개 + 1 × ${minGap})보다 짧습니다.`,
        );
      }
      const pts = equidistantInterior(sub, middles.length);
      middles.forEach((sid, i) => {
        positions.push({ stationId: sid, x: pts[i].x, y: pts[i].y });
        claimed.add(sid);
      });
      stats.push({
        piece: pieceLabel,
        from: a.station,
        to: b.station,
        middles: middles.length,
        arcLen: round3(arcLen),
        gap: round3(arcLen / (middles.length + 1)),
      });
    }
  };

  placePiece(line.vertices, line.loop, `노선 "${line.name}"`);
  line.spurs.forEach((spur, si) =>
    placePiece(spur.vertices, false, `노선 "${line.name}" 지선 ${si}`),
  );

  // 미배치 역(고정도 중간도 아님) 검출.
  const unplaced = sequence.filter(
    (sid) => !fixedStations.has(sid) && !claimed.has(sid),
  );
  if (unplaced.length > 0) {
    throw new Error(
      `노선 "${line.name}" 미배치 역 ${unplaced.length}개: ${unplaced.slice(0, 8).join(", ")}` +
        `${unplaced.length > 8 ? " …" : ""} (고정 정점 배치·구간 커버리지 확인).`,
    );
  }

  // track path 직렬화(closed면 첫 정점 append로 닫음).
  const tracks = [];
  const mainVerts = line.loop
    ? line.vertices.concat([line.vertices[0]])
    : line.vertices;
  tracks.push({ trackIndex: 0, vertices: mainVerts, path: verticesToPath(mainVerts) });
  line.spurs.forEach((spur, si) => {
    tracks.push({
      trackIndex: si + 1,
      vertices: spur.vertices,
      path: verticesToPath(spur.vertices),
    });
  });

  return { tracks, positions, stats };
}

// ── 팩 I/O(절대경로 지원 + index 미갱신) ──────────────────────────────────

/** gz 팩을 임시 sqlite로 푼다. 절대·상대(리포 루트 기준) 경로 모두 지원. */
function readPackToTemp(packPath, prefix) {
  const abs = path.isAbsolute(packPath) ? packPath : path.join(repoRoot, packPath);
  const bytes = gunzipSync(readFileSync(abs));
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const sqlitePath = path.join(dir, "pack.sqlite");
  writeFileSync(sqlitePath, bytes);
  return { dir, sqlitePath };
}

/** 임시 sqlite를 gz(level 9)로 out 경로에 쓴다. index.json은 갱신하지 않는다. */
function writeSpikePack(sqlitePath, outPath) {
  const sqliteBytes = readFileSync(sqlitePath);
  const gz = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const abs = path.isAbsolute(outPath) ? outPath : path.join(repoRoot, outPath);
  writeFileSync(abs, gz);
  return { byteSize: gz.length, sha256: sha256(gz) };
}

/** 각 정의 노선의 line_id·line_sequence를 팩에서 조회하고 planLine으로 계획한다. */
function planAllLines(db, lines, targetRegion, minGap) {
  const plans = [];
  for (const line of lines) {
    const lineRow = db.prepare("SELECT id FROM lines WHERE name_ko = ?").get(line.name);
    if (!lineRow) {
      throw new Error(`팩 lines에 없는 노선명: "${line.name}".`);
    }
    const lineId = lineRow.id;
    // 순서는 station_lines.line_sequence, 대상은 baseline이 이 region에 가진
    // 역만(station_lines는 region 비의존이라 타 region 역 유입을 막는다).
    const seq = db
      .prepare(
        `SELECT sl.station_id
         FROM station_lines sl
         JOIN route_map_positions rmp
           ON rmp.station_id = sl.station_id AND rmp.line_id = sl.line_id
         WHERE sl.line_id = ? AND rmp.region = ?
         ORDER BY sl.line_sequence`,
      )
      .all(lineId, targetRegion)
      .map((r) => r.station_id);
    const plan = planLine({ line, sequence: seq, minGap });
    // 라이선스 메타는 baseline positions에서 승계(교체 전 확보).
    const meta = db
      .prepare(
        `SELECT source_id, source_name, source_url, license, license_status,
                commercial_use_allowed, attribution_required
         FROM route_map_positions WHERE region = ? AND line_id = ? LIMIT 1`,
      )
      .get(targetRegion, lineId);
    plans.push({ line, lineId, plan, meta });
  }
  return plans;
}

/** 계획된 한 노선의 track/position 행을 준비된 INSERT 문으로 기록한다. */
function insertPlanRows({ lineId, plan, meta }, { db, insTrack, insPos, targetRegion, now }) {
  if (!meta) {
    db.exec("ROLLBACK");
    throw new Error(`라이선스 메타를 찾지 못했습니다(line_id ${lineId}).`);
  }
  for (const t of plan.tracks) {
    insTrack.run(
      targetRegion, lineId, t.trackIndex, t.path, "",
      meta.source_id, meta.source_name, meta.source_url, meta.license,
      meta.license_status, meta.commercial_use_allowed, meta.attribution_required, now,
    );
  }
  for (const p of plan.positions) {
    const rx = Math.round(p.x);
    const ry = Math.round(p.y);
    if (rx < 0 || ry < 0) {
      db.exec("ROLLBACK");
      throw new Error(
        `역 "${p.stationId}" 좌표(${rx}, ${ry})가 음수입니다. ` +
          `폴리라인 정의의 좌표 범위를 확인하세요.`,
      );
    }
    insPos.run(
      p.stationId, lineId, targetRegion, rx, ry,
      meta.source_id, meta.source_name, meta.source_url, meta.license,
      meta.license_status, meta.commercial_use_allowed, meta.attribution_required, now,
    );
  }
}

/** 대상 region의 tracks/positions를 지우고 계획된 노선분을 트랜잭션으로 재기록한다. */
function writePlansToPack(db, plans, targetRegion) {
  db.exec("BEGIN");
  db.prepare("DELETE FROM route_map_line_tracks WHERE region = ?").run(targetRegion);
  db.prepare("DELETE FROM route_map_positions WHERE region = ?").run(targetRegion);
  const now = Math.floor(Date.now() / 1000);

  const insTrack = db.prepare(
    `INSERT INTO route_map_line_tracks
      (region, line_id, track_index, path, svg_color, source_id, source_name,
       source_url, license, license_status, commercial_use_allowed,
       attribution_required, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insPos = db.prepare(
    `INSERT INTO route_map_positions
      (station_id, line_id, region, x, y, label_dx, label_dy, up_path, down_path,
       source_id, source_name, source_url, license, license_status,
       commercial_use_allowed, attribution_required, updated_at, label_polygon)
     VALUES (?,?,?,?,?,0,0,'','',?,?,?,?,?,?,?,?,'')`,
  );

  for (const plan of plans) {
    insertPlanRows(plan, { db, insTrack, insPos, targetRegion, now });
  }
  db.exec("COMMIT");
  db.exec("VACUUM");
}

/**
 * 파이프라인 진입점. 정의를 로드·검증하고 baseline을 복사한 스파이크 팩의
 * (region) route_map_line_tracks / route_map_positions를 정의된 노선분으로 교체한다.
 * check=true면 파일을 쓰지 않고 통계만 돌려준다.
 */
export function buildPolylinePack({
  defs,
  basePackPath,
  outPath,
  region,
  minGap = DEFAULT_MIN_GAP,
  targetGap = DEFAULT_TARGET_GAP,
  check = false,
}) {
  // minGap / targetGap 숫자 검증: NaN·0·음수이면 세그먼트 예산 검증이 조용히 무력화됨.
  if (!Number.isFinite(minGap) || minGap <= 0) {
    throw new Error(`minGap은 양의 유한수여야 합니다(현재값: ${minGap}).`);
  }
  if (!Number.isFinite(targetGap) || targetGap <= 0) {
    throw new Error(`targetGap은 양의 유한수여야 합니다(현재값: ${targetGap}).`);
  }
  // defs 구조 검증을 먼저 수행해 null/비객체 시 TypeError 대신 의도된 에러를 돌려준다.
  const model = loadAndValidateDefs(defs);
  // --region 오버라이드 불일치 검증: model.region이 있고 CLI region이 다르면 즉시 에러.
  if (region !== null && region !== undefined && model.region && region !== model.region) {
    throw new Error(
      `--region "${region}"이(가) 정의 파일의 region "${model.region}"과(와) 불일치합니다. ` +
        `정의를 수정하거나 --region을 생략하세요.`,
    );
  }
  const targetRegion = region ?? model.region;
  if (!targetRegion) {
    throw new Error(
      "region이 지정되지 않았습니다(--region 인자 또는 정의의 region 필드 필요).",
    );
  }

  const { dir, sqlitePath } = readPackToTemp(basePackPath, "polyline-pack-");
  try {
    const db = new DatabaseSync(sqlitePath);
    let allStats;
    try {
      // 노선명 → line_id, line_sequence 조회 + 계획.
      const plans = planAllLines(db, model.lines, targetRegion, minGap);

      allStats = plans.map((p) => ({
        line: p.line.name,
        vertices: p.line.vertices.length,
        spurs: p.line.spurs.length,
        arcs: p.plan.stats,
        positions: p.plan.positions.length,
      }));

      if (check) {
        return { region: targetRegion, check: true, stats: allStats };
      }

      // 대상 region의 tracks/positions를 전부 지우고 정의 노선분만 재기록.
      writePlansToPack(db, plans, targetRegion);
    } finally {
      // 예외·정상 경로 모두 db 닫힘 보장.
      db.close();
    }

    // db가 닫힌 뒤 팩 파일 기록(check=true는 이미 return되어 여기 미도달).
    const { byteSize, sha256: gzSha } = writeSpikePack(sqlitePath, outPath);
    return { region: targetRegion, check: false, byteSize, sha256: gzSha, stats: allStats };
  } finally {
    cleanupPackDir(dir);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    defs: null,
    basePack: null,
    out: null,
    region: null,
    minGap: DEFAULT_MIN_GAP,
    targetGap: DEFAULT_TARGET_GAP,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--defs": o.defs = argv[++i]; break;
      case "--base-pack": o.basePack = argv[++i]; break;
      case "--out": o.out = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--min-gap": {
        const raw = argv[++i];
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0) {
          throw new Error(`--min-gap은 양의 유한수여야 합니다: "${raw}".`);
        }
        o.minGap = v;
        break;
      }
      case "--target-gap": {
        const raw = argv[++i];
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0) {
          throw new Error(`--target-gap은 양의 유한수여야 합니다: "${raw}".`);
        }
        o.targetGap = v;
        break;
      }
      case "--check": o.check = true; break;
      default:
        throw new Error(`알 수 없는 인자: ${argv[i]}`);
    }
  }
  if (!o.defs) throw new Error("--defs가 필요합니다.");
  if (!o.basePack) throw new Error("--base-pack이 필요합니다.");
  if (!o.check && !o.out) throw new Error("--out이 필요합니다(--check 제외).");
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const defsAbs = path.isAbsolute(o.defs) ? o.defs : path.join(repoRoot, o.defs);
  const defs = JSON.parse(readFileSync(defsAbs, "utf8"));
  const result = buildPolylinePack({
    defs,
    basePackPath: o.basePack,
    outPath: o.out,
    region: o.region,
    minGap: o.minGap,
    targetGap: o.targetGap,
    check: o.check,
  });
  for (const line of result.stats) {
    const gaps = line.arcs.map((a) => a.gap).sort((x, y) => x - y);
    const min = gaps[0] ?? 0;
    const max = gaps.at(-1) ?? 0;
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    console.log(
      `[${result.region}] ${line.line}: 정점 ${line.vertices} · 지선 ${line.spurs} · ` +
        `구간 ${line.arcs.length} · 역 ${line.positions} · 간격 min ${min}/med ${median}/max ${max}`,
    );
    // 구간별 실제 간격 vs. targetGap 편차 표시.
    for (const arc of line.arcs) {
      const pct = round3(((arc.gap - o.targetGap) / o.targetGap) * 100);
      const sign = pct >= 0 ? "+" : "";
      console.log(
        `  ${arc.from}→${arc.to}: gap ${arc.gap} (target ${o.targetGap}, ${sign}${pct}%)`,
      );
    }
  }
  if (result.check) {
    console.log("(--check: 스파이크 팩 미기록)");
  } else {
    console.log(
      `스파이크 팩 기록: byteSize ${result.byteSize} · sha ${result.sha256.slice(0, 12)}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 실패는 Node 기본 예외 처리로 표준 에러에 노출하고 비정상 종료(코드 1)한다.
  // 정의 파일 내용을 직접 로그로 재출력하지 않는다.
  main();
}
