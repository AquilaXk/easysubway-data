#!/usr/bin/env node
// #2068 마감 2차 QA 반려(오너, 2026-07-18) 대응: "간선 겹침·노드에서 곡선 나옴·
// 지그재그" — 직전 라운드(octolinearize-svg-route-lines.mjs)는 노드를 고정하고
// 인접 역쌍마다 독립적으로 8선형 dogleg을 넣어, 역마다 계단이 생기고(지그재그)
// 그 코너가 노드 바로 옆에 박히는(노드에서 곡선이 나옴) 문제를 냈다. 8선형
// 수치(0)는 맞았지만 노선도 문법 위반.
//
// 이번 라운드는 **선을 구부리는 게 아니라 역을 재배치**한다(오너 명시 허용 —
// "역 재배치", 지리 무관 유지, 표준 노선도 문법 웹 참조). 핵심 아이디어(표준
// 문법 — 굵직한 직선 축 + 드문 코너, corridor 병렬 정렬, 코너는 역 사이에만):
//
//   1) run 검출: 노선의 역 순서(line_sequence)를 훑어 연속 구간의 방향을
//      8선형으로 스냅하고, 같은 방향이 이어지는 역들을 하나의 run으로 묶는다.
//   2) run 투영: run 내 모든 역을 그 run의 대표 축(직선) 위로 투영한다 —
//      진행 방향(along) 성분은 보존하고 수직(perp) 성분만 run 공통값으로
//      맞춰, run 전체가 정확히 한 직선이 되게 한다("역들이 직선 위에 줄줄이").
//   3) 전역 충돌 해소: 물리역 하나가 여러 노선에 걸치면(환승·병주 corridor)
//      먼저 처리되는(더 긴) run이 그 역 위치를 확정(lock)하고, 이후 run은
//      그 역을 고정 앵커로 받아들인다(run 전체가 그 앵커를 지나도록 축을
//      살짝 회전/정렬). 이렇게 하면 같은 corridor를 공유하는 서로 다른
//      노선이 자연히 같은 축 위에 정렬된다(그 다음 4)에서 겹침만 분리).
//   4) 코너: run과 run 사이(=실제 코너)에만 정확히 1개의 8선형 dogleg을
//      넣는다. 필렛은 그 합성 코너에만(실제 역 정점은 sharp) — 직전 라운드와
//      동일한 안전장치를 유지하되, 코너 개수가 역 개수가 아니라 run 전환
//      횟수로 줄어(지그재그 제거의 본질).
//   5) corridor 번들 오프셋: 같은 물리 edge(인접 역쌍)를 공유하는 서로 다른
//      노선은 stroke 렌더링에서만(마커 위치는 불변) 수직으로 갈라 그린다 —
//      octi-to-pack.mjs의 (index-(size-1)/2)*bundleSpacing 공식을 그대로
//      재사용(그 도구가 이미 "번들 오프셋"을 검증된 형태로 구현해 둠).
//
// 마커 이동은 apply-euclidean-svg-respacing.mjs와 동일한 SVG 패치 규약(4종
// id 우선순위 + 라벨 폴백)을 재사용해 마커·라벨·KTX/SRT/ITX chip·종점 마크가
// 함께 이동하게 한다.
import { isMainModule } from "../lib/is-main-module.mjs";
import { addTranslate, SVG_NAME_ALIASES } from "./apply-euclidean-svg-respacing.mjs";
import { resolveLineMap } from "./apply-sma-svg-positions.mjs";
import {
  buildFilletedLocalPath,
  extractStrokeTemplate,
  fallbackStrokeTemplate,
  parseScaledLayerTransform,
  replaceStrokePaths,
  sliceGroup,
} from "./octolinearize-svg-route-lines.mjs";
import { octilinearSegment, splitAtOutlierGaps } from "./octolinearize-line-tracks.mjs";
import { openPack, cleanupPackDir, repoRoot } from "./pack-io.mjs";
import { SEOUL } from "./sma-region-configs.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ── 8방향 유틸 ──────────────────────────────────────────────────────────────

const DIRS = [
  { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
  { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
].map((d) => ({ x: d.x / Math.hypot(d.x, d.y), y: d.y / Math.hypot(d.x, d.y) }));

/** dx,dy를 최근접 8방향 인덱스(0..7)로. 길이 0이면 null. */
export function snapDirIndex(dx, dy) {
  if (dx === 0 && dy === 0) return null;
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < DIRS.length; i += 1) {
    const dot = (dx * DIRS[i].x + dy * DIRS[i].y) / Math.hypot(dx, dy);
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
}

/** 방향 인덱스를 단위벡터로. */
function dirVec(i) {
  return DIRS[i];
}

/** 방향 인덱스의 수직(90° 회전) 단위벡터(일관된 부호 — "왼쪽"). */
function perpVec(i) {
  const d = DIRS[i];
  return { x: -d.y, y: d.x };
}

// ── 1) run 검출 ─────────────────────────────────────────────────────────────

// run 판정 허용오차(렌더 px) 기본값 — 역 하나가 run의 대표 축에서 이만큼
// 벗어나도 "같은 직선 구간"으로 본다. 전형적 역 간격(48~120px render)의
// 15~20%. 실측: 이 값 없이(순수 인접쌍 방향 정확 일치)는 655역에 378run이
// 나와(평균 1.7역/run — 사실상 역마다 계단) 오너가 반려한 지그재그를 그대로
// 재현한다. tolerance 도입으로 노이즈 있는 실좌표도 하나의 직선 run으로
// 묶는다(표준 노선도 문법 — "굵직한 직선 축 + 드문 코너").
export const DEFAULT_RUN_TOLERANCE_PX = 18;

/**
 * 역 순서(점 배열, {key,x,y})를 8선형 run으로 나눈다. 순수 인접쌍 방향이 아니라
 * "run 시작점 → 후보점" 방향을 스냅해 그 축 기준 중간점들의 수직 편차가
 * tolerance 이내인 동안 run을 늘리는 region-growing. 편차가 넘으면 run을
 * 닫고 그 경계점(공유)에서 새 run을 시작한다(끊김 없는 연속 폴리라인 유지).
 * 반환: [{ dirIndex, points: [원소] }].
 */
// 인접 두 점의 along(그 축 위 진행) 차이가 실제 유클리드 거리의 이 비율보다
// 작으면 그 축을 거부한다. 이게 없으면 실제로 코너(예: 남→서 90° 전환)인
// 구간을 "탈락 없이 멀리 뻗는" 축(예: 무작정 남쪽)으로 욱여넣어, 코너 이후
// 구간(예: 서쪽으로 가는 3역)의 along이 전부 거의 같아져 투영 후 좌표가
// 겹친다(#2068 2차 실측 — 경마공원·대공원·과천이 along 붕괴로 거리 0px까지
// 포개짐, euclidean census 272건 위반으로 재현). 진행 방향이 그 축과 최소
// 이 정도는 나란해야 "직선 run"으로 인정한다.
const MIN_ALONG_RATIO = 0.85;

/** points[i..k]가 축(dirIndex, start=points[i] 기준)에서 전부 tolerance 이내이고,
 *  각 점이 시작점 기준 along(진행) 방향으로 단조 전진(뒤로 가지 않음)하며,
 *  인접 점 사이 along 증가분이 실제 거리 대비 MIN_ALONG_RATIO 이상인지(=이
 *  축이 실제 진행 방향을 잘 대표하는지). 단조성만 보면 가까운 두 점(짧은
 *  edge)은 8방향 전부가 우연히 tolerance를 통과해 버려 엉뚱한 축을 "가장
 *  멀리 뻗는다"는 이유로 고르는 사고가 난다(#2068 2차 실측 — 성신여대입구
 *  y=-66 이탈, 경마공원 등 along 붕괴 두 사고 모두 이 함수 보강으로 수정). */
function fitsAxis(points, i, k, start, dirIndex, tolerancePx) {
  const u = dirVec(dirIndex);
  const v = perpVec(dirIndex);
  let prevAlong = -Infinity;
  let prevPoint = points[i];
  for (let m = i; m <= k; m += 1) {
    const dx = points[m].x - start.x;
    const dy = points[m].y - start.y;
    const dev = Math.abs(dx * v.x + dy * v.y);
    if (dev > tolerancePx) return false;
    const along = dx * u.x + dy * u.y;
    if (along < prevAlong - 1e-6) return false; // 역행 금지(단조 전진)
    if (m > i) {
      const realDist = Math.hypot(points[m].x - prevPoint.x, points[m].y - prevPoint.y);
      const alongDelta = along - prevAlong;
      if (realDist > 1e-6 && alongDelta < realDist * MIN_ALONG_RATIO) return false;
    }
    prevAlong = along;
    prevPoint = points[m];
  }
  return true;
}

// 후보 축 탐색을 raw 인접쌍 방향(snapDirIndex) 기준 ±1 스텝(45°)으로 제한한다
// (전방향 8개 전부 시도하면 위 "짧은 edge 우연 통과" 문제의 근본 원인이 남는다
// — 실제 물리 코너는 인접한 45° 전환이지 반대·수직 방향 도약이 아니다).
function neighborDirIndices(rawDir) {
  if (rawDir === null) return [...DIRS.keys()];
  const n = DIRS.length;
  return [rawDir, (rawDir + 1) % n, (rawDir + n - 1) % n];
}

export function detectRuns(points, tolerancePx = DEFAULT_RUN_TOLERANCE_PX) {
  if (points.length < 2) return points.length === 1 ? [{ dirIndex: null, points: [...points] }] : [];
  const runs = [];
  let i = 0;
  while (i < points.length - 1) {
    const start = points[i];
    // 중복좌표 스킵: start와 동일한 좌표가 이어지면 그대로 run에 편입.
    let firstDiff = i + 1;
    while (firstDiff < points.length && points[firstDiff].x === start.x && points[firstDiff].y === start.y) {
      firstDiff += 1;
    }
    if (firstDiff >= points.length) {
      runs.push({ dirIndex: null, points: points.slice(i) });
      break;
    }
    const rawDir = snapDirIndex(points[firstDiff].x - start.x, points[firstDiff].y - start.y);
    // 후보 축은 raw 인접쌍 방향 근방(±45°)만 — "가장 멀리 뻗는" 탐색을 물리적으로
    // 타당한 방향으로 한정한다.
    let bestDirIndex = null;
    let bestExtend = firstDiff;
    for (const d of neighborDirIndices(rawDir)) {
      if (!fitsAxis(points, i, firstDiff, start, d, tolerancePx)) continue;
      let k = firstDiff;
      while (k + 1 < points.length && fitsAxis(points, i, k + 1, start, d, tolerancePx)) k += 1;
      if (k > bestExtend || bestDirIndex === null) {
        bestExtend = k;
        bestDirIndex = d;
      }
    }
    if (bestDirIndex === null) {
      bestDirIndex = rawDir;
      bestExtend = firstDiff;
    }
    runs.push({ dirIndex: bestDirIndex, points: points.slice(i, bestExtend + 1) });
    i = bestExtend; // 다음 run은 이 run의 마지막 점에서 이어(경계점 공유 — 폴리라인 연속).
  }
  return runs;
}

// ── 2) run 투영 + 3) 전역 충돌 해소(락) ─────────────────────────────────────

/**
 * run을 그 축(dirIndex) 위로 투영한 새 좌표를 계산한다. locked(station key →
 * 확정 좌표)에 이미 있는 점은 절대 움직이지 않고, 그 점의 perp 값을 run 전체의
 * 목표 perp로 채택(앵커 피벗)한다. locked에 없는 run이면 전 점의 perp 중앙값을
 * 목표로 쓴다(전체 변위 최소화). along 성분은 각 점의 기존 위치 그대로 보존
 * (상대 간격 불변 — 유클리드 census 보호는 호출부가 재검증).
 * 반환: Map(key → {x,y}) — run의 새 좌표(락 안 된 점만 실제로 바뀔 수 있음).
 */
// 투영 결과 최대 변위 상한(렌더 px). 한 run이 이미 락된(다른 run이 먼저 확정한)
// 점을 앵커로 물려받을 때, 그 앵커 자체가 "나쁜 락"(더 앞서 처리된 엉뚱한
// run에서 파생)이면 앵커 → 이번 run 전체로 왜곡이 전파된다(#2068 2차 실측 —
// 성신여대입구가 y=632→425로 튀는 사고를 역추적한 결과, 원인은 성신여대입구
// 자신이 아니라 그 run이 물려받은 이웃 락이었다: 3개 run이 전부 같은 잘못된
// y로 수렴). 이 상한은 그 전파를 국소적으로 끊는다 — 계산된 새 위치가 원래
// 위치에서 이만큼 넘게 벗어나면 원래 위치를 그대로 쓴다("차라리 안 움직인다").
export const DEFAULT_MAX_DISPLACEMENT_PX = 150;

export function projectRun(run, locked, maxDisplacementPx = DEFAULT_MAX_DISPLACEMENT_PX) {
  const { dirIndex, points } = run;
  const out = new Map();
  if (dirIndex === null || points.length < 2) {
    for (const p of points) out.set(p.key, { x: p.x, y: p.y });
    return out;
  }
  const u = dirVec(dirIndex);
  const v = perpVec(dirIndex);
  const origin = points[0];
  const proj = points.map((p) => ({
    key: p.key,
    x: p.x,
    y: p.y,
    along: (p.x - origin.x) * u.x + (p.y - origin.y) * u.y,
    perp: (p.x - origin.x) * v.x + (p.y - origin.y) * v.y,
    lockedPos: locked.get(p.key) ?? null,
  }));
  let targetPerp;
  const anchors = proj.filter((p) => p.lockedPos);
  if (anchors.length > 0) {
    // 앵커가 여럿이면 중앙값(단일 이상치 앵커에 덜 민감 — "첫 발견"보다 견고).
    const anchorPerps = anchors
      .map((p) => (p.lockedPos.x - origin.x) * v.x + (p.lockedPos.y - origin.y) * v.y)
      .sort((a, b) => a - b);
    targetPerp = anchorPerps[Math.floor(anchorPerps.length / 2)];
  } else {
    const perps = proj.map((p) => p.perp).sort((a, b) => a - b);
    targetPerp = perps[Math.floor(perps.length / 2)];
  }
  for (const p of proj) {
    if (p.lockedPos) {
      out.set(p.key, p.lockedPos);
      continue;
    }
    const candidate = {
      x: origin.x + p.along * u.x + targetPerp * v.x,
      y: origin.y + p.along * u.y + targetPerp * v.y,
    };
    const displacement = Math.hypot(candidate.x - p.x, candidate.y - p.y);
    out.set(p.key, displacement > maxDisplacementPx ? { x: p.x, y: p.y } : candidate);
  }
  return out;
}

/**
 * 여러 노선의 run 목록(전역, 각 run에 sourceLineId 태그)을 길이(역 수) 내림차순
 * 처리해 전역 충돌을 해소한다. 먼저 처리된(더 긴) run이 station key를 lock —
 * 이후 run은 그 좌표를 앵커로 받아들인다(같은 corridor 자연 정렬).
 * 반환: { locked: Map(key→{x,y}), order: [run과 그 시점 locked 스냅샷] }.
 */
export function resolveGlobalRuns(allRuns) {
  const sorted = [...allRuns].sort((a, b) => b.points.length - a.points.length);
  const locked = new Map();
  const projectedRuns = [];
  for (const run of sorted) {
    const proj = projectRun(run, locked);
    for (const [key, pos] of proj) {
      if (!locked.has(key)) locked.set(key, pos);
    }
    projectedRuns.push({ ...run, projected: proj });
  }
  return { locked, projectedRuns };
}

// ── 4) 코너(run 전환) 연결 ───────────────────────────────────────────────────

/**
 * 한 노선의 (락 해소된) 역 순서를 run 경계마다 정확히 1개의 8선형 코너로 잇는다.
 * 반환: annotated 정점열([{x,y,synthetic}]) — octolinearize-svg-route-lines.mjs의
 * buildFilletedLocalPath가 그대로 소비 가능한 형식(synthetic=true인 정점에만
 * 필렛 적용).
 */
/**
 * #2068 5차(코디네이터 승인 — 코너 방향 선택): variantForEdge(i, a, b)가 있으면
 * edge i의 코너 방향("bend-early"/"bend-late")을 겨냥 선택할 수 있다(생략 시
 * 전부 bend-early — 기존 산출 완전 불변). 멀쩡한 edge까지 흔들지 않도록
 * 호출부가 위반이 있는 edge에만 override를 주는 방식을 권장한다.
 */
export function buildMinimalBendVertices(finalPoints, variantForEdge = null) {
  if (finalPoints.length < 2) return finalPoints.map((p) => ({ ...p, synthetic: false }));
  const verts = [{ x: finalPoints[0].x, y: finalPoints[0].y, synthetic: false }];
  for (let i = 0; i + 1 < finalPoints.length; i += 1) {
    const a = finalPoints[i];
    const b = finalPoints[i + 1];
    const variant = variantForEdge ? variantForEdge(i, a, b) : "bend-early";
    const seg = octilinearSegment(a, b, variant);
    if (seg.length === 3) verts.push({ x: seg[1].x, y: seg[1].y, synthetic: true });
    verts.push({ x: b.x, y: b.y, synthetic: false });
  }
  return verts;
}

// ── 5) corridor 번들(병렬 오프셋) ────────────────────────────────────────────

/**
 * 노선별 최종(락 해소된) 역 순서 목록(Map lineId → [{key,x,y}])에서, 물리
 * edge(정렬된 station key 쌍)를 공유하는 노선들을 묶어 번들을 만든다. 번들
 * 크기가 1이면(공유 없음) 오프셋 0. 반환: Map("lineId|key1|key2" → offsetIndex,
 * bundleSize) — 렌더 단계에서 edge별 수직 오프셋 계산에 쓴다.
 */
export function detectCorridorBundles(lineStationSeqs) {
  const edgeLines = new Map(); // edgeKey → Set(lineId)
  const edgeKeyOf = (k1, k2) =>
    [k1, k2].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("|");
  for (const [lineId, seqOrPieces] of lineStationSeqs) {
    // 값이 [{key,x,y}...](단일 조각) 또는 [[{...}],[{...}]](다중 조각/지선)
    // 둘 다 허용 — 조각 "사이"는 edge를 만들지 않는다(지선 경계에서 가짜 edge
    // 방지, #2068 2차 버그: 본선만 저장하면 지선이 통째로 빠지던 것의 재발
    // 방지책으로 조각 배열을 그대로 받게 확장).
    const pieces = Array.isArray(seqOrPieces[0]) ? seqOrPieces : [seqOrPieces];
    for (const seq of pieces) {
      for (let i = 0; i + 1 < seq.length; i += 1) {
        const ek = edgeKeyOf(seq[i].key, seq[i + 1].key);
        if (!edgeLines.has(ek)) edgeLines.set(ek, new Set());
        edgeLines.get(ek).add(lineId);
      }
    }
  }
  const assignment = new Map(); // "lineId#edgeKey" → { index, size }
  for (const [ek, lineSet] of edgeLines) {
    if (lineSet.size < 2) continue;
    const sortedLines = [...lineSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    sortedLines.forEach((lineId, index) => {
      assignment.set(`${lineId}#${ek}`, { index, size: sortedLines.length });
    });
  }
  return { assignment, edgeKeyOf };
}

/**
 * 위상(같은 station-pair edge 공유)이 아니라 **기하학적** 공선+구간겹침으로
 * 우연히 포개지는 노선쌍을 찾아 같은 assignment(bundles)에 추가한다(#2068 2차
 * QA 반려 "간선 겹침" — 서로 다른 물리 edge를 지나는 두 노선이 재배치 후
 * 우연히 같은 축 위에 놓이는 경우, 위상 기반 번들만으로는 못 잡는다. tolerance
 * 조정으로도 이 겹침 수는 거의 안 줄어든다는 걸 실측했다 — 밀집 도심 격자에서
 * 8선형으로 스냅하면 서로 다른 노선이 같은 축에 놓이는 게 구조적으로 흔하다).
 * 이미 위상 번들이 배정된 edge는 건드리지 않는다(우선순위: 위상 > 기하).
 * finalPiecesBySlug: Map(slug → [piece(seq)...]) 락 해소된 최종 좌표.
 * bundles는 detectCorridorBundles의 반환값(assignment를 그 자리에서 확장).
 */
export function detectGeometricCorridorBundles(finalPiecesBySlug, bundles, collinearFn, opts = {}) {
  const { assignment, edgeKeyOf } = bundles;
  const { maxSeparationForBundlePx = 3 } = opts;
  const edgesBySlug = new Map();
  for (const [slug, pieces] of finalPiecesBySlug) {
    const edges = [];
    for (const seq of pieces) {
      for (let i = 0; i + 1 < seq.length; i += 1) {
        edges.push({ a: seq[i], b: seq[i + 1], ek: edgeKeyOf(seq[i].key, seq[i + 1].key) });
      }
    }
    edgesBySlug.set(slug, edges);
  }
  const slugs = [...edgesBySlug.keys()];
  const coBundle = new Map(); // "slug#ek" → { slug, ek, partners: Set(slug) }
  const entryFor = (slug, ek) => {
    const key = `${slug}#${ek}`;
    if (!coBundle.has(key)) coBundle.set(key, { slug, ek, partners: new Set([slug]) });
    return coBundle.get(key);
  };
  for (let i = 0; i < slugs.length; i += 1) {
    for (let j = i + 1; j < slugs.length; j += 1) {
      for (const eA of edgesBySlug.get(slugs[i])) {
        for (const eB of edgesBySlug.get(slugs[j])) {
          const ov = collinearFn(eA, eB);
          if (ov && ov.separationPx < maxSeparationForBundlePx && ov.overlapLenPx > 1) {
            entryFor(slugs[i], eA.ek).partners.add(slugs[j]);
            entryFor(slugs[j], eB.ek).partners.add(slugs[i]);
          }
        }
      }
    }
  }
  for (const [key, entry] of coBundle) {
    if (assignment.has(key)) continue; // 위상 번들 우선(이미 배정됨).
    if (entry.partners.size < 2) continue;
    const sorted = [...entry.partners].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assignment.set(key, { index: sorted.indexOf(entry.slug), size: sorted.length });
  }
  return bundles;
}

/**
 * #2068 5차(코디네이터 승인 — 코너 방향 재설계, 2026-07-18): G-NODE-STRAIGHT
 * (노드 직선여유) 위반의 근본 원인을 분석적으로 풀었다 — octilinearSegment는
 * edge(a,b)의 짧은 축 길이 diag=min(|dx|,|dy|)만큼 45° 리드를 만드는데, 이
 * 리드가 diag*√2이고 어느 끝(a 또는 b)에 놓이든 값 자체(diag*√2)는 그대로다
 * (코너 방향을 bend-early/late로 바꿔도 {legA,legB} 집합은 불변 — 어느 역이
 * 짧은 다리를 받는지만 바뀐다). 즉 "코너 방향 선택"만으로는 diag*√2 <
 * thresholdPx인 edge의 위반을 **없앨** 수 없고 다른 역으로 떠넘길 뿐이다.
 * 진짜 해법은 diag 자체를 0으로 만드는 것 — 그 edge를 완전히 8선형(코너 없음)
 * 으로 미세 정렬(snap)한다. diag가 애초에 threshold/√2px 미만인 edge에서만
 * (=코너가 실제로 노드 근접 위반을 만드는 edge에서만) 발동하므로 멀쩡한 edge는
 * 전혀 건드리지 않는다(겨냥 적용, 전역 재생성 아님).
 *
 * 이동 대상 역 선택: 두 끝(a,b) 중 "그 역의 다른(이 edge 아닌) 이웃 edge가
 * 이미 8선형으로 정렬돼 있지 않은" 쪽을 우선한다 — 이미 정렬된 이웃 edge를
 * 깨지 않기 위해서다(그 역이 여러 노선에 걸치면 전 노선의 이웃 edge를 전부
 * 검사한다 — locked가 노선 간 공유 Map이라 한 노선만 보면 다른 노선을 깰 수
 * 있다). 양쪽 다 이미 정렬된 이웃이 있으면(둘 다 옮기면 다른 edge가 깨짐)
 * 이 edge는 건너뛴다 — 잔존 위반으로 보고에 남긴다.
 *
 * 짧은 축이 이미 0에 매우 가까우면(원래도 거의 8선형) 이동량은 diag(최대
 * threshold/√2 ≈ 4.2px, threshold=6이면)로 작다 — census(48px) 안전망은
 * 뒤에서 다시 돈다.
 *
 * 반환: { movedKeys: Set, fixes: [{slug,station,from,to,diagPx}], skipped:
 * [{slug,station,partnerStation,diagPx,reason}] }.
 */
export function resolveNodeClearanceByMicroAlign(finalPiecesBySlug, locked, opts = {}) {
  const { thresholdPx = 6, maxRounds = 6, bundles = null, bundleSpacingPx = 0 } = opts;
  const movedKeys = new Set();
  const fixes = [];
  let skipped = [];

  // 전역 위상 인덱스: key -> [{slug, pieceIdx, idx}] (모든 노선·조각에서 이
  // 역이 등장하는 위치). 위상(어떤 역이 어떤 순서로 이어지는지)은 재배치로
  // 안 바뀌므로 한 번만 구성한다 — 좌표만 그때그때 locked에서 읽는다.
  const pieceKeysBySlug = new Map();
  const touches = new Map();
  for (const [slug, pieces] of finalPiecesBySlug) {
    const keyPieces = pieces.map((seq) => seq.map((s) => s.key));
    pieceKeysBySlug.set(slug, keyPieces);
    keyPieces.forEach((keys, pieceIdx) => {
      keys.forEach((key, idx) => {
        if (!touches.has(key)) touches.set(key, []);
        touches.get(key).push({ slug, pieceIdx, idx });
      });
    });
  }

  function posOf(key) {
    return locked.get(key);
  }
  // #2068 5차 실측 버그: 진단(diag)·정렬 판정을 raw 역좌표로만 하면, 실제
  // 렌더는 corridor 번들 오프셋(같은 edge를 공유하는 노선이 stroke만 수직
  // 갈라 그림)까지 반영하므로 "고쳤다"고 표시된 edge가 실제 렌더에서는 다시
  // 어긋난다(67건이 52건으로만 줄고, 새 위반 1건까지 생겼다 — 실측 확인).
  // 번들 오프셋은 위치가 아니라 위상(어떤 edge를 공유하는지)만으로 정해지는
  // 고정 벡터이므로, 판정은 번들 반영 좌표로 하고 "고침"은 그 델타를 raw
  // 역좌표에 그대로 더해 적용한다(오프셋 자체는 안 바뀌므로 델타가 그대로
  // 전달된다).
  function renderedOf(slug, pieceIdx) {
    const keys = pieceKeysBySlug.get(slug)[pieceIdx];
    const seq = keys.map((k) => ({ key: k, ...(posOf(k) ?? { x: 0, y: 0 }) }));
    if (!bundles) return seq;
    return applyCorridorBundleOffsets(slug, seq, bundles, bundleSpacingPx);
  }
  /** p→q(rendered) 두 다리(diag*√2, longAxis-diag)가 전부 thresholdPx 이상인지
   *  (또는 이미 완전 8선형인지) — #2068 5차 실측 버그와 같은 기준으로 "이
   *  edge가 위반을 만들지 않는지"를 판정한다. */
  function legsOk(p, q, threshold) {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx < 1e-6 && ady < 1e-6) return false; // 겹침(퇴화 edge) — 항상 위반 취급.
    if (dx === 0 || dy === 0 || adx === ady) return true; // 코너 없음.
    const diag = Math.min(adx, ady);
    const longAxis = Math.max(adx, ady);
    return diag * Math.SQRT2 >= threshold && longAxis - diag >= threshold;
  }
  /** key를 delta(rendered 기준)만큼 옮기면, key가 걸린 "이 edge"(현재 처리
   *  중, excludeIdx가 가리키는 edge=(excludeIdx,excludeIdx+1), 검사에서 빼야
   *  함) 말고 다른 이웃 edge 중 새로 위반(또는 기존보다 더 나빠짐)이 되는 게
   *  있으면 true. #2068 5차 실측 버그: "이미 완전 정렬된 이웃만 보호"로는
   *  부족하다 — 부분적으로만 정렬된(짧지만 임계는 넘는) 이웃도 이 이동으로
   *  임계 밑으로 떨어질 수 있어(연쇄), 실측에서 새 위반 최대 7건이 반복
   *  발생했다. 이동 "후" 두 다리 전부를 직접 재계산해 확인한다. */
  function wouldBreakOtherEdges(key, delta, excludeSlug, excludePieceIdx, excludeIdx, threshold) {
    for (const t of touches.get(key) ?? []) {
      const keys = pieceKeysBySlug.get(t.slug)[t.pieceIdx];
      const sameTouchSet = t.slug === excludeSlug && t.pieceIdx === excludePieceIdx;
      const rendered = renderedOf(t.slug, t.pieceIdx);
      const prevIsExcluded = sameTouchSet && t.idx === excludeIdx + 1;
      if (t.idx > 0 && !prevIsExcluded) {
        const p = rendered[t.idx - 1];
        const qAfter = { x: rendered[t.idx].x + delta.x, y: rendered[t.idx].y + delta.y };
        if (!legsOk(p, qAfter, threshold)) return true;
      }
      const nextIsExcluded = sameTouchSet && t.idx === excludeIdx;
      if (t.idx + 1 < keys.length && !nextIsExcluded) {
        const pAfter = { x: rendered[t.idx].x + delta.x, y: rendered[t.idx].y + delta.y };
        const q = rendered[t.idx + 1];
        if (!legsOk(pAfter, q, threshold)) return true;
      }
    }
    return false;
  }

  for (let round = 0; round < maxRounds; round += 1) {
    let anyFixed = false;
    skipped = [];
    for (const [slug, keyPieces] of pieceKeysBySlug) {
      for (let pieceIdx = 0; pieceIdx < keyPieces.length; pieceIdx += 1) {
        const keys = keyPieces[pieceIdx];
        for (let i = 0; i + 1 < keys.length; i += 1) {
          const rendered = renderedOf(slug, pieceIdx);
          const a = rendered[i];
          const b = rendered[i + 1];
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const adx = Math.abs(dx);
          const ady = Math.abs(dy);
          if (dx === 0 || dy === 0 || adx === ady) continue; // 이미 8선형.
          const diag = Math.min(adx, ady);
          const longAxis = Math.max(adx, ady);
          // #2068 5차 실측 버그: octilinearSegment(bend-early)는 a에서 diag*√2
          // 만큼 대각선 리드, corner에서 b까지 (longAxis-diag)만큼 직선 리드를
          // 만든다 — 위반은 "a쪽 리드(diag*√2)"뿐 아니라 "b쪽 리드
          // (longAxis-diag)"에서도 생긴다(예: 주안→도화 diag=35로 diag*√2≈49.5는
          // 여유 있지만 longAxis-diag=4로 도화 쪽이 위반). diag*√2만 검사하면
          // 이런 edge를 전부 놓친다(실측: 67건 중 상당수가 정수/반정수 값 —
          // longAxis-diag 패턴). 어느 쪽이든 미세정렬(코너 제거)로 둘 다 함께
          // 해소되므로 감지 조건만 두 다리 전부로 넓히면 된다.
          const legAtA = diag * Math.SQRT2;
          const legAtB = longAxis - diag;
          if (legAtA >= thresholdPx && legAtB >= thresholdPx) continue; // 위반 안 만드는 edge.

          // #2068 5차 실측 버그(2번째): "짧은 축을 0으로 스냅"(축 정렬, 이동량
          // =diag)만 시도하면, legAtB(=longAxis-diag)가 작은 근-45° edge(예:
          // diag=35~49인데 longAxis-diag만 작은 경우)에서 이동량이 30~50px까지
          // 커진다("미세"정렬이 아니게 됨 — 실측: 안전망이 이 큰 이동을 census
          // 위반으로 보고 130건까지 되돌려 결국 위반이 안 줄었다). 이런 edge는
          // "긴 축을 짧은 축에 맞춰 45°로 스냅"(대각선 정렬, 이동량=legAtB)이
          // 훨씬 싸다 — 두 방식 중 이동량이 작은 쪽을 고른다(항상 min(diag,
          // legAtB) 이하로 이동, threshold=6이면 최대 6px).
          const useDiagonalSnap = legAtB < diag;
          const snapY = adx > ady; // "짧은" 축(축-정렬 시 바꿀 축)이 y인지.
          const signX = Math.sign(dx) || 1;
          const signY = Math.sign(dy) || 1;
          let deltaForA;
          let deltaForB;
          let moveCostPx;
          if (useDiagonalSnap) {
            // 긴 축을 diag만큼(=legAtB만큼 줄여) 짧은 축에 맞춘다.
            deltaForA = snapY
              ? { x: signX * legAtB, y: 0 } // x가 긴 축이면 a.x를 legAtB만큼 b쪽으로.
              : { x: 0, y: signY * legAtB };
            deltaForB = snapY ? { x: -signX * legAtB, y: 0 } : { x: 0, y: -signY * legAtB };
            moveCostPx = legAtB;
          } else {
            // 짧은 축을 0으로(상대 좌표에 맞춘다).
            deltaForA = snapY ? { x: 0, y: b.y - a.y } : { x: b.x - a.x, y: 0 };
            deltaForB = snapY ? { x: 0, y: a.y - b.y } : { x: a.x - b.x, y: 0 };
            moveCostPx = diag;
          }
          const aBreaks = wouldBreakOtherEdges(keys[i], deltaForA, slug, pieceIdx, i, thresholdPx);
          const bBreaks = wouldBreakOtherEdges(keys[i + 1], deltaForB, slug, pieceIdx, i, thresholdPx);
          let target = null;
          if (!bBreaks) target = "b";
          else if (!aBreaks) target = "a";
          if (!target) {
            skipped.push({
              slug,
              station: keys[i],
              partnerStation: keys[i + 1],
              diagPx: Math.round(diag * 100) / 100,
              reason: "양끝 모두 옮기면 다른 이웃 edge가 위반(또는 악화)됨 — 연쇄 방지로 스킵",
            });
            continue;
          }

          const key = target === "a" ? keys[i] : keys[i + 1];
          const delta = target === "a" ? deltaForA : deltaForB;
          const rawCur = posOf(key);
          const next = { x: rawCur.x + delta.x, y: rawCur.y + delta.y };
          locked.set(key, next);
          movedKeys.add(key);
          fixes.push({
            slug,
            station: key,
            from: { x: rawCur.x, y: rawCur.y },
            to: next,
            diagPx: Math.round(moveCostPx * 100) / 100,
          });
          anyFixed = true;
        }
      }
    }
    if (!anyFixed) break;
  }
  return { movedKeys, fixes, skipped };
}

/**
 * #2068 4차(오너 재반려 "간선 겹침" 대응, 2026-07-18): 위상적으로 무관한(edge를
 * 공유하지 않는) 두 노선의 edge가 우연히 공선+구간겹침이면, 겹치는 쪽 edge의
 * 실제 역(마커·라벨·chip 전부 함께 이동 — locked를 직접 수정)을 그 edge垂직
 * 방향으로 밀어낸다. 직전 라운드의 실패 원인(stroke만 옮기고 역은 안 옮겨
 * G-NODE가 깨짐)을 피한다 — 역을 옮기면 이후 stroke 재작도가 자동으로 그
 * 역을 지나 정합이 유지된다. endpoint를 공유하는 edge 쌍(진짜 환승/분기 접점)은
 * 건너뛴다 — 위상적 수렴이지 겹침 결함이 아니다.
 *
 * 이동 방향은 "이미 살짝 벌어진 쪽으로 더 밀기"(부호 반전 방지) — signed perp
 * 값의 부호를 그대로 증폭한다(0이면 슬러그 정렬로 결정적 기본 부호).
 * 이동 대상 노선은 두 슬러그 중 알파벳으로 뒤(second)인 쪽 — 결정적, 매 실행
 * 동일 결과.
 *
 * 반환: { locked(제자리 수정됨), movedKeys: Set, clusters: [{lineA,lineB,edges}] }
 * — clusters는 보고용(라인쌍별 몇 edge가 밀렸는지).
 */
export function resolveOverlapsByMovingStations(finalPiecesBySlug, locked, opts = {}) {
  const {
    offsetPx = 8,
    maxSeparationForOverlapPx = 2,
    maxIters = 80,
    bundles = null,
    bundleSpacingPx = 0,
  } = opts;
  const clusterCounts = new Map(); // "lineA|lineB" -> count(옮긴 edge 수)
  const movedKeys = new Set();

  // slug -> [ {piece: [{key,x,y}...]} ] — locked의 최신 위치 반영해 매 반복 재구성.
  function seqsFor(slug) {
    return finalPiecesBySlug.get(slug).map((seq) =>
      seq.map((s) => ({ key: s.key, ...(locked.get(s.key) ?? s) })),
    );
  }

  // 겹침 "판정"은 위상 번들(공유 edge) 오프셋까지 반영한 실제 렌더 좌표로 해야
  // 감사 도구(실제 stroke를 측정)와 같은 것을 본다 — 오프셋을 무시하면 번들이
  // 겹침 없던 인접 corridor를 새로 겹치게 만드는 경우를 대부분 놓친다(#2068 4차
  // 실측: 오프셋 미반영 시 104→87건만 잡혔고 대부분이 sillim/incheon-2/gtx-a
  // 등 번들-유발 신규 겹침이었다). 이동 대상 판정(run 경계·key)은 계속 실제
  // 역좌표(seqsFor)로 한다 — 옮기는 건 마커지 렌더 오프셋이 아니다.
  function renderedSeqsFor(slug, seqs) {
    if (!bundles) return seqs;
    return seqs.map((seq) => applyCorridorBundleOffsets(slug, seq, bundles, bundleSpacingPx));
  }

  /** dirIndexOf(seq[i],seq[i+1])의 canonical(mod4)이 target과 같은지. */
  function edgeDirMatches(seq, i, target) {
    if (i < 0 || i + 1 >= seq.length) return false;
    const d = snapDirIndex(seq[i + 1].x - seq[i].x, seq[i + 1].y - seq[i].y);
    return d !== null && d % 4 === target;
  }

  /**
   * seq(역 순서)를 실제로 그려질 sub-segment 목록으로 편다 — 역쌍(i,i+1)이
   * 8선형이 아니면 octilinearSegment이 합성 dogleg 코너를 하나 넣어 [a,corner,b]
   * 2개 sub-segment로 그려진다(#2068 4차 실측 버그: 역-단위 raw edge만 비교하면
   * 이 dogleg sub-segment의 실제 겹침을 놓쳐 겹침 58쌍 중 4쌍만 잡혔다 — 감사
   * 도구는 렌더된 stroke를 보므로 sub-segment까지 봐야 같은 것을 비교한다).
   * 각 sub-segment는 부모 edge 인덱스 i(run 확장 시 seq[i]/[i+1] 기준으로 삼음)와
   * 부모 edge의 "진짜 역" 양끝(realA/realB)을 들고 있다 — dogleg로 쪼개지면 코너
   * 점은 key가 없으므로, 끝점-공유(진짜 환승/분기) 판정은 반드시 이 realA/realB로
   * 해야 한다(합성 코너 좌표로 비교하면 실제로는 같은 역에서 갈라진 두 edge인데도
   * "끝점 공유 아님"으로 오판해 진짜 분기점을 겹침으로 오검출한다).
   */
  function subSegmentsOf(seq) {
    const out = [];
    for (let i = 0; i + 1 < seq.length; i += 1) {
      const realA = seq[i];
      const realB = seq[i + 1];
      const pts = octilinearSegment(realA, realB);
      for (let k = 0; k + 1 < pts.length; k += 1) {
        out.push({ edgeIndex: i, a: pts[k], b: pts[k + 1], realA, realB });
      }
    }
    return out;
  }

  for (let iter = 0; iter < maxIters; iter += 1) {
    const slugs = [...finalPiecesBySlug.keys()].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    let anyMoved = false;

    for (let i = 0; i < slugs.length; i += 1) {
      for (let j = i + 1; j < slugs.length; j += 1) {
        const slugA = slugs[i];
        const slugB = slugs[j]; // 알파벳 뒤 — 이동 대상.
        // pairLoop: 이 (slugA,slugB) 쌍 안에서 발견된 겹침을 한 번에 하나씩 고치고,
        // 매번 seqsA/seqsB를 다시 읽어(locked 최신 반영) 같은 쌍 안의 다음 겹침도
        // 계속 처리한다 — 쌍 전체를 스킵하지 않아 수렴이 훨씬 빠르다.
        //
        // #2068 4차 실측: "공유역만 보호하고 나머지를 부분 이동"(run 일부만
        // 옮김)도, "공유역이 run 어디에든 있으면 통째로 스킵"(run 레벨 검사)도
        // 모두 실측에서 문제가 났다 — 전자는 강체성이 깨져 클러스터당 최대
        // 2799건까지 무한 진동(8방향 스냅 경계에서 부호가 왕복하며 수렴하지
        // 않음)했고, 후자는 과잉 차단(긴 run이 우연히 지나는 무관한 공유역까지
        // 걸려 8개였던 정상 클러스터마저 0으로 떨어짐). 안전하다고 실측된
        // 유일한 기준으로 되돌린다: 비교 중인 두 "직접 edge"(eA·eB의 부모 edge,
        // run 확장 전)가 끝점을 하나라도 공유하면 그 조합만 스킵 — 확장된 run
        // 전체가 아니라 지금 판정 중인 edge 쌍만 본다.
        let fixedThisGuard = true;
        for (let guard = 0; guard < 40 && fixedThisGuard; guard += 1) {
        fixedThisGuard = false;
        const seqsA = seqsFor(slugA);
        const seqsB = seqsFor(slugB);
        const renderedA = renderedSeqsFor(slugA, seqsA);
        const renderedB = renderedSeqsFor(slugB, seqsB);
        pairScan: for (let pai = 0; pai < seqsA.length; pai += 1) {
          for (const eA of subSegmentsOf(renderedA[pai])) {
            for (let pbi = 0; pbi < seqsB.length; pbi += 1) {
              const seqB = seqsB[pbi]; // run 확장·key는 실제 역좌표 기준.
              for (const eB of subSegmentsOf(renderedB[pbi])) {
                const bi = eB.edgeIndex;
                if (
                  eA.realA.key === eB.realA.key || eA.realA.key === eB.realB.key ||
                  eA.realB.key === eB.realA.key || eA.realB.key === eB.realB.key
                ) {
                  continue; // 두 직접 edge가 끝점을 공유 — 환승/분기점, 겹침 결함 아님.
                }
                const degA = segmentAngleDegLocal(eA.a, eA.b);
                const degB = segmentAngleDegLocal(eB.a, eB.b);
                if (degA === null || degB === null) continue;
                let diff = Math.abs(degA - degB);
                if (diff > 90) diff = 180 - diff;
                if (diff > 0.5) continue; // 공선 아님(교차는 별도 게이트).
                const dirIndex = snapDirIndex(eA.b.x - eA.a.x, eA.b.y - eA.a.y);
                if (dirIndex === null) continue;
                const canonicalDir = dirIndex % 4;
                const v = perpVec(canonicalDir);
                const signedPerp = (p) => (p.x - eA.a.x) * v.x + (p.y - eA.a.y) * v.y;
                const pA = signedPerp(eB.a);
                const pB = signedPerp(eB.b);
                const maxAbsPerp = Math.max(Math.abs(pA), Math.abs(pB));
                if (maxAbsPerp >= maxSeparationForOverlapPx) continue; // 이미 충분히 분리.
                const u = { x: v.y, y: -v.x };
                const alongOf = (p) => (p.x - eA.a.x) * u.x + (p.y - eA.a.y) * u.y;
                const aMinMax = [0, alongOf(eA.b)].sort((x, y) => x - y);
                const bMinMax = [alongOf(eB.a), alongOf(eB.b)].sort((x, y) => x - y);
                const overlapLen = Math.min(aMinMax[1], bMinMax[1]) - Math.max(aMinMax[0], bMinMax[0]);
                if (overlapLen <= 1) continue;

                // #2068 4차 실측 수정: edge 2점만 옮기면 그 역의 "다른" 이웃(같은
                // run의 안 옮긴 옆 역)과 새 꺾임이 생겨 G-NODE가 대량으로 깨진다
                // (직전 시도 실측: node-on-stroke 0→130). run 전체(같은 canonical
                // 방향이 이어지는 구간, 양쪽으로 최대한 확장)를 강체로 함께 옮겨
                // 내부 정합을 보존한다 — run 경계(자연스러운 코너)에서만 이음매가
                // 생긴다.
                let lo = bi;
                let hi = bi + 1;
                while (lo > 0 && edgeDirMatches(seqB, lo - 1, canonicalDir)) lo -= 1;
                while (hi + 1 < seqB.length && edgeDirMatches(seqB, hi, canonicalDir)) hi += 1;

                const sign = pA + pB >= 0 ? 1 : -1;
                const push = { x: v.x * sign * offsetPx, y: v.y * sign * offsetPx };
                for (let k = lo; k <= hi; k += 1) {
                  const key = seqB[k].key;
                  const cur = locked.get(key);
                  if (!cur) continue;
                  locked.set(key, { x: cur.x + push.x, y: cur.y + push.y });
                  movedKeys.add(key);
                }
                const ck = [slugA, slugB]
                  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
                  .join("|");
                clusterCounts.set(ck, (clusterCounts.get(ck) ?? 0) + 1);
                anyMoved = true;
                fixedThisGuard = true;
                // seqA/seqB가 stale해졌으니 이 (slugA,slugB) 쌍을 처음부터 다시
                // 스캔한다(guard 루프가 seqsA/seqsB를 새로 읽음).
                break pairScan;
              }
            }
          }
        }
        } // guard
      }
    }
    if (!anyMoved) break;
  }
  const clusters = [...clusterCounts.entries()].map(([k, count]) => {
    const [lineA, lineB] = k.split("|");
    return { lineA, lineB, edgesMoved: count };
  });
  return { movedKeys, clusters };
}

/** local: segmentAngleDeg([0,180)) — audit-octolinearity.mjs와 동일 공식(별도
 *  import 없이 자급 — relayout 모듈이 audit 모듈에 의존하지 않게 유지). */
function segmentAngleDegLocal(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return null;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180;
  return deg;
}

/**
 * 노선의 최종 역 순서에 번들 오프셋을 적용한 "렌더용" 좌표열을 만든다(마커
 * 좌표는 불변 — 이 함수의 출력은 stroke path 전용). edge가 번들이면 그 edge의
 * 두 끝점 모두를, edge 고유 방향의 수직으로 (index-(size-1)/2)*spacingPx만큼
 * 옮긴다. 한 정점이 여러(번들 edge들의) 오프셋 요청을 받으면 평균한다(부드러운
 * 전환 — octi-to-pack.mjs의 "부호 어긋남" 함정을 피하려 전역 고정 좌표축
 * perpVec(dirIndex)만 쓴다, edge의 from→to 상대 방향 아님).
 */
export function applyCorridorBundleOffsets(lineId, seq, bundles, spacingPx) {
  const { assignment, edgeKeyOf } = bundles;
  const accum = new Map(); // key → {sx,sy,n}
  for (let i = 0; i + 1 < seq.length; i += 1) {
    const a = seq[i];
    const b = seq[i + 1];
    const ek = edgeKeyOf(a.key, b.key);
    const info = assignment.get(`${lineId}#${ek}`);
    if (!info) continue;
    const dirIndex = snapDirIndex(b.x - a.x, b.y - a.y);
    if (dirIndex === null) continue;
    // 방향을 [0,3]으로 정규화(4=West는 0=East의 반대 순회일 뿐 같은 축) —
    // 정규화 없이 원 dirIndex로 perpVec를 구하면 같은 물리 corridor를 서로
    // 반대 순서(from→to)로 도는 두 노선의 오프셋 부호가 뒤집혀 분리 대신
    // 겹침이 악화된다(#1789 octi-to-pack.mjs 기존 주석의 "번들 오프셋 부호
    // 한계"와 동일 함정 — 여기서는 정규화로 고정 해소).
    const canonicalDir = dirIndex % 4;
    const v = perpVec(canonicalDir);
    const off = (info.index - (info.size - 1) / 2) * spacingPx;
    for (const p of [a, b]) {
      if (!accum.has(p.key)) accum.set(p.key, { sx: 0, sy: 0, n: 0 });
      const acc = accum.get(p.key);
      acc.sx += v.x * off;
      acc.sy += v.y * off;
      acc.n += 1;
    }
  }
  return seq.map((p) => {
    const acc = accum.get(p.key);
    if (!acc) return { ...p };
    return { key: p.key, x: p.x + acc.sx / acc.n, y: p.y + acc.sy / acc.n };
  });
}

// ── 코너(bend) 카운트 — before/after 계측용 ─────────────────────────────────

/** annotated 정점열에서 synthetic(코너) 정점 수. */
export function countBends(vertices) {
  return vertices.filter((v) => v.synthetic).length;
}

export { repoRoot };

function resolveRepo(p) {
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

// corridor 병렬 오프셋 간격(렌더 px). octi-to-pack.mjs의 bundleSpacing=6(design px)
// 관례를 그대로 계승하되, 이 도구는 render 좌표계(local×0.455)에서 직접 동작하므로
// 렌더 stroke 폭(6~13 local ≈2.7~5.9 render px) 대비 "살짝 겹치지 않을 정도"인
// 5px를 쓴다(선폭과 비슷한 간격 — 표준 노선도의 병주 트랙 간격 관례).
export const DEFAULT_CORRIDOR_SPACING_PX = 5;

// 노드-코너 최소 직선 여유(렌더 px) — 오너 반려 "노드에서 곡선이 나온다" 하드
// 게이트. 실제 역 정점은 이 도구가 항상 sharp(필렛 없음)로 두므로 구조적으로
// 0 여유가 기본이지만, 필렛 반경(6px 기본)만큼은 최소 확보돼야 "직선처럼" 보인다.
export const DEFAULT_MIN_NODE_CLEARANCE_PX = 6;

// ── 마커·라벨·chip·종점마크 이동(data-station 속성 전역 스캔) ────────────────

/** svgText에서 data-station="svgName"을 가진 모든 요소의 [start,end) 태그 범위. */
/** tagStart(`<`)에서 시작하는 요소의 "전체" 범위(자식 포함, 짝닫는 태그까지).
 *  자체닫힘(`/>`)이면 여는 태그가 곧 전체. 아니면 같은 태그명의 열림/닫힘
 *  깊이를 세어 정확한 짝닫는 태그를 찾는다(중첩 판정용 — sliceGroup의 일반화). */
function findFullElementSpan(svgText, tagStart) {
  const openEnd = svgText.indexOf(">", tagStart);
  if (openEnd === -1) return null;
  const openTagText = svgText.slice(tagStart, openEnd + 1);
  if (/\/>\s*$/.test(openTagText)) return { start: tagStart, end: openEnd + 1 };
  const nameMatch = openTagText.match(/^<([a-zA-Z][\w:-]*)/);
  if (!nameMatch) return { start: tagStart, end: openEnd + 1 };
  const tagName = nameMatch[1];
  const re = new RegExp(`<${tagName}\\b|</${tagName}>`, "g");
  re.lastIndex = tagStart;
  let depth = 0;
  for (let m = re.exec(svgText); m; m = re.exec(svgText)) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return { start: tagStart, end: m.index + m[0].length };
    } else {
      depth += 1;
    }
  }
  return { start: tagStart, end: openEnd + 1 }; // 방어: 짝을 못 찾으면 여는 태그만.
}

/**
 * svgText에서 data-station="svgName"을 가진 모든 요소의 [start,end) "여는 태그"
 * 범위 중, 다른 매치 요소에 중첩되지 않은(최상위) 것만 반환한다. 중첩 자식은
 * 부모 transform을 상속하므로 따로 옮기면 이중(누적) 이동이 된다(#2068 2차
 * 실측 — 오금 환승 배지(circle·text)가 전부 자기 data-station="오금"을 들고
 * 있어 부모 g + 자식들이 각자 translate를 더해 좌표가 3배 이상 튐, 305px+
 * 노드-간선 이탈로 재현됨). 전체 span(짝닫는 태그까지)으로 포함관계를 판정한다.
 */
export function findAllTagRangesByDataStation(svgText, svgName) {
  const attr = `data-station="${svgName}"`;
  const candidates = [];
  let from = 0;
  for (;;) {
    const pos = svgText.indexOf(attr, from);
    if (pos === -1) break;
    const tagStart = svgText.lastIndexOf("<", pos);
    const tagEnd = svgText.indexOf(">", pos);
    if (tagStart === -1 || tagEnd === -1) {
      from = pos + attr.length;
      continue;
    }
    const full = findFullElementSpan(svgText, tagStart) ?? { start: tagStart, end: tagEnd + 1 };
    candidates.push({ openStart: tagStart, openEnd: tagEnd + 1, fullStart: full.start, fullEnd: full.end });
    from = tagEnd + 1;
  }
  candidates.sort((a, b) => a.openStart - b.openStart);
  const kept = [];
  let barrier = -1;
  for (const c of candidates) {
    if (c.openStart < barrier) continue; // 이미 채택된 조상 요소 안에 중첩됨 — 스킵.
    kept.push({ start: c.openStart, end: c.openEnd });
    barrier = Math.max(barrier, c.fullEnd);
  }
  return kept;
}

/**
 * 역 이름(canonical) 목록별 delta(local 좌표, dx/dy)를 SVG의 data-station 속성을
 * 가진 모든 요소(마커·환승/종점 심벌·라벨·KTX/SRT/ITX chip — 별칭 포함)에
 * translate로 가산한다. 요소 종류를 몰라도 되는 범용 패치(#2068 2차 QA 반려 —
 * 역 이동에 이 모든 부속 요소가 함께 따라가야 함). 겹치는 범위는 없다고 가정
 * (data-station 속성이 있는 서로 다른 요소는 SVG 상 형제/독립 트리 — 실측
 * 확인: 마커·라벨·chip·종점마크가 서로 다른 layer의 독립 요소).
 */
// #2068 2차 실측 보완 별칭. SVG_NAME_ALIASES(apply-euclidean-svg-respacing.mjs)는
// 콜론 동명이역(신촌/양평)만 다루고 canonical↔SVG 표기가 다른 단수 역은 빠져
// 있다 — 하남검단산역(DB canonical) ↔ 하남검단산(SVG data-station, canonicalRules
// 의 svg→canonical 역방향 규칙과 대칭). 이 역이 "미발견"으로 남아 재배치 후
// 마커가 그대로 있고 stroke만 옮겨가 104px 이탈이 났다(#2068 2차 실측).
const EXTRA_NAME_ALIASES = {
  하남검단산역: ["하남검단산"],
};

/**
 * name→svgNames 확장(별칭 병합). disambiguateSlugs가 주어지고 이름이 콜론
 * 동명이역(별칭 svgName에 ":<접미>"가 있는 경우)이면, 이 역이 실제로 속한
 * 노선 slug의 접미(SEOUL.slugToSuffix)와 일치하는 별칭 하나만 남긴다 — 그렇지
 * 않으면 같은 이름의 서로 다른 물리역(예: 양평 2역)에 서로의 delta가 겹쳐
 * 적용된다(#2068 2차 실측: 양평 2역이 25px·13px 이탈).
 */
function resolveSvgNamesForDelta(name, disambiguateSlugs, config) {
  const aliases = SVG_NAME_ALIASES[name] ?? EXTRA_NAME_ALIASES[name] ?? [name];
  if (aliases.length <= 1 || !disambiguateSlugs || disambiguateSlugs.size === 0) return aliases;
  const suffixes = [...disambiguateSlugs].map((slug) => config.slugToSuffix[slug]).filter(Boolean);
  // startsWith(정확 일치 아님): slugToSuffix 값이 별칭 콜론 접미의 접두만 되는
  // 경우가 있다(예: slug "gyeongui-jungang" → suffix "경의중앙"이지만 별칭은
  // "양평:경의중앙선" — "선"이 더 붙음). 정확 일치만 요구하면 매칭 실패로
  // "전체 별칭 폴백"이 발동해 서로 다른 물리역의 delta가 같은 요소에 중복
  // 적용되는 사고가 난다(#2068 2차 실측 — 양평 2역이 25px·13px 이탈 + 크래시).
  const matched = aliases.filter((a) => {
    const colon = a.indexOf(":");
    if (colon < 0) return false;
    const aliasSuffix = a.slice(colon + 1);
    return suffixes.some((suf) => aliasSuffix.startsWith(suf));
  });
  return matched.length > 0 ? matched : aliases;
}

export function applyStationDeltasGeneric(svgText, deltas, config = SEOUL) {
  const edits = []; // { start, end, svgName }
  const missing = [];
  for (const d of deltas) {
    const svgNames = resolveSvgNamesForDelta(d.name, d.slugs, config);
    let any = false;
    for (const svgName of svgNames) {
      const ranges = findAllTagRangesByDataStation(svgText, svgName);
      for (const r of ranges) edits.push({ ...r, dx: d.dx, dy: d.dy });
      if (ranges.length) any = true;
    }
    if (!any) missing.push(d.name);
  }
  // 같은 [start,end] 범위에 두 delta가 겹치면(정상 로직상 없어야 하나 방어) 합산
  // 1회만 적용 — 겹친 채 중복 적용하면 두 번째 slice 인덱스가 첫 적용으로 밀린
  // 문자열에 어긋나 요소가 깨진다(#2068 2차 실측: 별칭 매칭 실패로 전체 폴백이
  // 발동했을 때 이 경로로 크래시 재현).
  const byRange = new Map();
  for (const e of edits) {
    const rk = `${e.start}|${e.end}`;
    if (byRange.has(rk)) {
      const prev = byRange.get(rk);
      prev.dx += e.dx;
      prev.dy += e.dy;
    } else {
      byRange.set(rk, { ...e });
    }
  }
  const dedupedEdits = [...byRange.values()];
  dedupedEdits.sort((a, b) => b.start - a.start); // 뒤에서부터 치환(앞쪽 인덱스 불변 보장)
  let out = svgText;
  for (const e of dedupedEdits) {
    const elText = out.slice(e.start, e.end);
    const patched = addTranslate(elText, e.dx, e.dy);
    out = out.slice(0, e.start) + patched + out.slice(e.end);
  }
  return { svg: out, patchedCount: dedupedEdits.length, missing };
}

// ── CLI: 팩 기반 오케스트레이션(마커 이동은 별도 스크립트가 담당 — 관심사 분리) ──

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    region: "수도권",
    branches: "tools/route-map/line-branches.json",
    svg: null,
    out: null,
    corridorSpacing: DEFAULT_CORRIDOR_SPACING_PX,
    filletRadius: 6,
    runTolerance: DEFAULT_RUN_TOLERANCE_PX,
    minNodeClearance: DEFAULT_MIN_NODE_CLEARANCE_PX,
    censusHardGate: true,
    applyStationFixups: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": o.pack = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--branches": o.branches = argv[++i]; break;
      case "--svg": o.svg = argv[++i]; break;
      case "--out": o.out = argv[++i]; break;
      case "--corridor-spacing": o.corridorSpacing = Number(argv[++i]); break;
      case "--fillet-radius": o.filletRadius = Number(argv[++i]); break;
      case "--run-tolerance": o.runTolerance = Number(argv[++i]); break;
      case "--min-node-clearance": o.minNodeClearance = Number(argv[++i]); break;
      // #2068 오너 결정(2026-07-19): 오너 손수 다듬기 기준본 위에서는 census가
      // 하드 게이트가 아니라 보고 항목이다("위반이 나와도 역을 옮기지 말고
      // 수치만 보고") — 이 플래그로 안전망(reactive revert)을 끄면 run
      // 투영·미세정렬 결과가 그대로 유지되고, census는 별도로 측정만 한다.
      case "--no-census-hard-gate": o.censusHardGate = false; break;
      // #2068 오너 결정(2026-07-19): "오너 손수 기준본 다듬기" 모드 — run
      // 투영·필렛(자연스러운 8방향 스냅)만 적용하고, 겹침/직선여유를 위해
      // 역을 추가로 밀어내는 능동적 재배치(resolveOverlapsByMovingStations·
      // resolveNodeClearanceByMicroAlign)는 건드리지 않는다(오너 원본 형상
      // 최대 보존 — "다듬기"지 "재설계" 아님).
      case "--no-station-fixups": o.applyStationFixups = false; break;
    }
  }
  return o;
}

/** line-branches.json에서 이 노선(canonical name_ko)의 지선 목록. */
function branchesFor(branchesJson, region, lineNameKo) {
  return branchesJson?.linesByRegion?.[region]?.[lineNameKo] ?? [];
}

/**
 * 팩에서 전 노선의 run을 구성하고 전역 충돌 해소를 실행한다(리포트 전용 —
 * 마커 이동·SVG 패치는 별도). 반환: { locked, perLine: Map(slug→{seq(원본),
 * projectedSeq, runs, bundles}), bundles }.
 */
export function computeGlobalRelayout(
  db,
  region,
  branchesJson,
  runTolerancePx = DEFAULT_RUN_TOLERANCE_PX,
  censusHardGate = true,
) {
  const slugToId = resolveLineMap(db, SEOUL);
  const allRuns = [];
  // slug → [piece...] — piece = 한 노선의 그리는 조각 하나(본선 outlier-split
  // 조각 또는 지선 1개)의 원본 역 순서. mainSeq만 저장하면 지선(예: 1호선
  // 경인선)이 최종 stroke에서 통째로 빠지는 버그가 난다(#2068 2차 실측 — 이
  // 버그로 인천·부평 등 경인선 역이 stroke에서 최대 541px 이탈했었다). 반드시
  // 조각 단위로 보존해 최종 stroke가 본선+지선 전부를 그리게 한다.
  const perLinePieces = new Map();
  for (const [slug, lineId] of slugToId) {
    const lineNameKo = `${SEOUL.lineNamePrefix} ${SEOUL.slugToSuffix[slug]}`;
    const branches = branchesFor(branchesJson, region, lineNameKo);
    const nodeRows = db
      .prepare(
        `SELECT s.name_ko AS name, rmp.station_id AS key, rmp.x AS x, rmp.y AS y, sl.line_sequence AS seq
         FROM route_map_positions rmp
         JOIN station_lines sl ON sl.station_id = rmp.station_id AND sl.line_id = rmp.line_id
         JOIN stations s ON s.id = rmp.station_id
         WHERE rmp.region = ? AND rmp.line_id = ?
         ORDER BY sl.line_sequence`,
      )
      .all(region, lineId);
    if (nodeRows.length < 2) continue;
    const spurNames = new Set(branches.flatMap((b) => b.spur));
    const mainSeq = nodeRows.filter((r) => !spurNames.has(r.name));
    const pieces = [];
    for (const piece of splitAtOutlierGaps(mainSeq)) {
      pieces.push(piece);
      for (const run of detectRuns(piece, runTolerancePx)) allRuns.push({ ...run, lineId, slug });
    }
    for (const b of branches) {
      const jn = nodeRows.find((r) => r.name === b.junction);
      const spurNodes = b.spur.map((sn) => nodeRows.find((r) => r.name === sn)).filter(Boolean);
      if (!jn || spurNodes.length === 0) continue;
      const chain = [jn, ...spurNodes];
      for (const piece of splitAtOutlierGaps(chain)) {
        pieces.push(piece);
        for (const run of detectRuns(piece, runTolerancePx)) allRuns.push({ ...run, lineId, slug });
      }
    }
    if (pieces.length) perLinePieces.set(slug, pieces);
  }
  const { locked, projectedRuns } = resolveGlobalRuns(allRuns);
  // 안전망 스코프는 perLinePieces(본선/지선 조각, outlier-split로 일부 역이
  // 빠질 수 있음)가 아니라 route_map_positions 전체(감사 도구
  // findEuclideanSpacingViolations와 동일 쿼리 스코프)로 잡는다 — 안전망
  // 스코프가 실제 하드 게이트 스코프보다 좁으면 게이트가 여전히 깨질 수
  // 있다(#2068 2차 실측: perLinePieces 스코프로는 269건이 남았는데 그중
  // 다수가 outlier-split로 조각 밖에 있던 역이었다).
  const allLineRows = db
    .prepare(`SELECT station_id AS key, line_id AS lineId, x, y FROM route_map_positions WHERE region = ?`)
    .all(region);
  const byLineAll = new Map(); // lineId → [[{key,x,y}...]] (단일 "조각"으로 감쌈 — 안전망의 nested-piece 포맷과 호환)
  for (const r of allLineRows) {
    if (!byLineAll.has(r.lineId)) byLineAll.set(r.lineId, [[]]);
    byLineAll.get(r.lineId)[0].push({ key: r.key, x: r.x, y: r.y });
  }
  const origAll = new Map();
  for (const r of allLineRows) if (!origAll.has(r.key)) origAll.set(r.key, { x: r.x, y: r.y });
  // 하드 게이트 임계는 48px지만, SVG round-trip(마커 patch → 재추출 →
  // apply-sma-svg-positions의 정수 반올림)이 최대 ~1px을 깎아 먹는 걸 실측
  // 했다(#2068 1·2차 공통 실측 — 뚝섬↔성수 47.85px 재발). 안전망 자체는 여유를
  // 두고(50px), 실제 게이트 임계(48)는 audit-station-euclidean-spacing.mjs가
  // 그대로 지킨다.
  //
  // #2068 오너 결정(2026-07-19): 오너 손수 기준본 위에서는 census가 하드
  // 게이트가 아니다("위반이 나와도 역을 옮기지 말고 수치만 보고") —
  // censusHardGate=false면 안전망(reactive revert)을 아예 돌리지 않는다.
  if (censusHardGate) enforceEuclideanSafetyNet(locked, byLineAll, origAll, 50);
  return { locked, projectedRuns, perLinePieces, slugToId };
}

/** perLinePieces에서 station key → 원 좌표(재배치 전) 맵. */
function origPositionsFor(perLinePieces) {
  const orig = new Map();
  for (const [, pieces] of perLinePieces) {
    for (const seq of pieces) {
      for (const s of seq) if (!orig.has(s.key)) orig.set(s.key, { x: s.x, y: s.y });
    }
  }
  return orig;
}

// 유클리드 census 하드 게이트(48px) 안전망 — run 투영·전역 락 알고리즘이 아무리
// 정교해도(#2068 2차 실측: 축 오선택·앵커 전파 등 서로 다른 원인의 붕괴 사고가
// 반복 발견됨) 이 게이트를 절대 어길 수 없다는 게 원 과업의 하드 제약이다.
// 그래서 `locked`를 직접 검증해, 같은 노선 내 두 역의 재배치 후 거리가
// thresholdPx 미만이면 그 역(들)을 원좌표로 되돌린다(재배치 전 상태는 이미
// census를 만족했으므로 항상 안전한 폴백). 몇 라운드 반복해 안정화한다 —
// 되돌림이 이웃과의 새 충돌을 만들 수 있어서다.
export function enforceEuclideanSafetyNet(locked, perLinePieces, origPositions, thresholdPx = 48, maxRounds = 6) {
  const cumulativeReverted = new Set();
  for (let round = 0; round < maxRounds; round += 1) {
    const reverted = new Set();
    for (const [, pieces] of perLinePieces) {
      const pts = [];
      for (const seq of pieces) {
        for (const s of seq) {
          // #2068 4차 실측 회귀 수정: locked에 없는 역(예: splitAtOutlierGaps로
          // run 계산에서 조각 밖으로 드롭된 도라산 — 자기 자신은 안 움직이지만
          // "이웃"인 청량리가 재배치로 다가오며 census를 깰 수 있다)을 통째로
          // 건너뛰면 그 역이 참여하는 모든 쌍이 안전망 검사에서 사라진다. 원
          // 좌표(s.x/s.y — perLinePieces가 route_map_positions 원본에서 구성됨)로
          // 폴백해 "안 옮긴 역도 항상 검사에 포함"되게 한다.
          const p = locked.get(s.key) ?? { x: s.x, y: s.y };
          pts.push({ key: s.key, x: p.x, y: p.y });
        }
      }
      for (let i = 0; i < pts.length; i += 1) {
        for (let j = i + 1; j < pts.length; j += 1) {
          if (pts[i].key === pts[j].key) continue;
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
          if (d < thresholdPx) {
            reverted.add(pts[i].key);
            reverted.add(pts[j].key);
          }
        }
      }
    }
    if (reverted.size === 0) return { revertedCount: cumulativeReverted.size };
    for (const key of reverted) {
      cumulativeReverted.add(key);
      const orig = origPositions.get(key);
      if (orig) locked.set(key, { x: orig.x, y: orig.y });
    }
    if (round === maxRounds - 1) return { revertedCount: cumulativeReverted.size, exhausted: true };
  }
  return { revertedCount: cumulativeReverted.size };
}

/** route-lines-layer 내 slug 그룹의 <path> d에서 curve(C/S/Q/T) 세그먼트 수를
 *  센다 — 재작도 전(직전 라운드 산출물) "코너 수" 근사치(전 라운드는 모든 코너가
 *  필렛 곡선이었으므로 curve 세그먼트 수 = 코너 수와 거의 같다). */
function countExistingCurvesForSlug(svgText, slug) {
  const idPos = svgText.indexOf(`id="route-line-${slug}"`);
  if (idPos === -1) return 0;
  const { start, end } = sliceGroup(svgText, idPos);
  const block = svgText.slice(start, end);
  const ds = [...block.matchAll(/\sd="([^"]*)"/gs)].map((m) => m[1]);
  let count = 0;
  for (const d of ds) count += (d.match(/[CSQT]/g) ?? []).length;
  return count;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const branchesJson = JSON.parse(readFileSync(resolveRepo(o.branches), "utf8"));
  const svgPath = resolveRepo(o.svg ?? "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg");
  let svgText = readFileSync(svgPath, "utf8");
  const transform = parseScaledLayerTransform(svgText);

  const { db, dir } = openPack(o.pack, "relayout-");
  let report;
  try {
    const { locked, perLinePieces, slugToId } = computeGlobalRelayout(
      db,
      o.region,
      branchesJson,
      o.runTolerance,
      o.censusHardGate,
    );

    // 원 좌표(팩) — delta 계산용(조각 전부 순회 — 지선 포함). key→slugs도 함께
    // 모아 콜론 동명이역(양평 2역 등) 별칭 disambiguation에 쓴다.
    const origPos = new Map();
    const keySlugs = new Map();
    for (const [slug, pieces] of perLinePieces) {
      for (const seq of pieces) {
        for (const s of seq) {
          if (!origPos.has(s.key)) origPos.set(s.key, { x: s.x, y: s.y, name: s.name });
          if (!keySlugs.has(s.key)) keySlugs.set(s.key, new Set());
          keySlugs.get(s.key).add(slug);
        }
      }
    }

    const buildFinalPieces = () => {
      const m = new Map();
      for (const [slug, pieces] of perLinePieces) {
        m.set(
          slug,
          pieces.map((seq) =>
            seq.map((s) => {
              const p = locked.get(s.key) ?? s;
              return { key: s.key, x: p.x, y: p.y, name: s.name };
            }),
          ),
        );
      }
      return m;
    };

    // #2068 4차: 위상적으로 무관한 노선쌍이 재배치 후 우연히 공선+겹침이면
    // 겹치는 쪽의 실제 역(마커·라벨·chip 전부)을 수직으로 밀어낸다(직전 라운드는
    // stroke만 옮겨 G-NODE가 깨졌다 — 이번엔 역 자체를 옮겨 stroke가 그 역을
    // 그대로 따라가게 한다). 판정은 위상 번들(공유 edge) 오프셋까지 반영한
    // 렌더 좌표로 해야 감사 도구와 같은 것을 본다 — 번들 topology는 역 위치가
    // 아니라 edge 공유 여부(perLinePieces의 key 순서)로만 정해지므로 재배치
    // 전에 한 번 계산해도 무효화되지 않는다.
    const overlapDetectionBundles = detectCorridorBundles(perLinePieces);
    let overlapResolution = { clusters: [], movedKeys: new Set() };
    let safetyNet2 = { revertedCount: 0 };
    let clearanceResolution = { fixes: [], movedKeys: new Set(), skipped: [] };
    let safetyNet3 = { revertedCount: 0 };
    if (o.applyStationFixups) {
      overlapResolution = resolveOverlapsByMovingStations(buildFinalPieces(), locked, {
        offsetPx: o.corridorSpacing >= 8 ? o.corridorSpacing : 8,
        bundles: overlapDetectionBundles,
        bundleSpacingPx: o.corridorSpacing,
      });

      // 역 이동(위 겹침 해소 + 원래 재배치)로 새 유클리드 위반이 생겼을 수 있어
      // 안전망을 다시 돌린다(하드 게이트 census 0 보장 — computeGlobalRelayout
      // 내부와 동일 스코프의 region 전체 쿼리 재사용).
      const allLineRows2 = db
        .prepare(`SELECT station_id AS key, line_id AS lineId, x, y FROM route_map_positions WHERE region = ?`)
        .all(o.region);
      const byLineAll2 = new Map();
      for (const r of allLineRows2) {
        if (!byLineAll2.has(r.lineId)) byLineAll2.set(r.lineId, [[]]);
        byLineAll2.get(r.lineId)[0].push({ key: r.key, x: r.x, y: r.y });
      }
      const origAll2 = new Map();
      for (const r of allLineRows2) if (!origAll2.has(r.key)) origAll2.set(r.key, { x: r.x, y: r.y });
      if (o.censusHardGate) safetyNet2 = enforceEuclideanSafetyNet(locked, byLineAll2, origAll2, 50);

      // #2068 5차(코디네이터 승인 — 코너 방향 재설계): G-NODE-STRAIGHT(노드
      // 직선여유) 위반을 만드는 edge(diag*√2 < 임계)를 미세정렬해 코너 자체를
      // 없앤다. resolveNodeClearanceByMicroAlign 주석 참고 — 코너 방향
      // (bend-early/late) 선택만으로는 {legA,legB} 값 자체가 안 바뀌어(어느
      // 역이 짧은 다리를 받는지만 바뀜) 위반을 없앨 수 없다는 분석적 결론에
      // 따른 것이다.
      clearanceResolution = resolveNodeClearanceByMicroAlign(buildFinalPieces(), locked, {
        thresholdPx: o.minNodeClearance,
        bundles: overlapDetectionBundles,
        bundleSpacingPx: o.corridorSpacing,
      });
      const allLineRows3 = db
        .prepare(`SELECT station_id AS key, line_id AS lineId, x, y FROM route_map_positions WHERE region = ?`)
        .all(o.region);
      const byLineAll3 = new Map();
      for (const r of allLineRows3) {
        if (!byLineAll3.has(r.lineId)) byLineAll3.set(r.lineId, [[]]);
        byLineAll3.get(r.lineId)[0].push({ key: r.key, x: r.x, y: r.y });
      }
      const origAll3 = new Map();
      for (const r of allLineRows3) if (!origAll3.has(r.key)) origAll3.set(r.key, { x: r.x, y: r.y });
      if (o.censusHardGate) safetyNet3 = enforceEuclideanSafetyNet(locked, byLineAll3, origAll3, 50);
    }

    // 1) 마커·라벨·chip·종점마크 이동(local delta = render delta / scale) — 겹침
    //    해소로 옮긴 역까지 반영한 최종 locked 기준.
    const deltas = [];
    for (const [key, newPos] of locked) {
      const orig = origPos.get(key);
      if (!orig) continue;
      const dxRender = newPos.x - orig.x;
      const dyRender = newPos.y - orig.y;
      if (Math.hypot(dxRender, dyRender) < 0.05) continue;
      deltas.push({
        name: orig.name,
        dx: dxRender / transform.scale,
        dy: dyRender / transform.scale,
        slugs: keySlugs.get(key),
      });
    }
    const patchResult = applyStationDeltasGeneric(svgText, deltas, SEOUL);
    svgText = patchResult.svg;

    // 2) 노선별 최종(락 해소) 조각들(본선+지선 전부 보존, 겹침 해소 반영) +
    //    corridor 번들 오프셋(위상적으로 진짜 공유하는 edge만 — 병렬 표시).
    const finalPiecesBySlug = buildFinalPieces();
    const bundles = detectCorridorBundles(finalPiecesBySlug);
    // 기하 번들(detectGeometricCorridorBundles)은 의도적으로 미적용 — 실측 결과
    // 겹침(G-OVERLAP)은 108→64로 줄지만, 오프셋이 그 edge의 실제 역(ordinary
    // tolerance 1.365px)에서 stroke를 최대 5.87px까지 떼어놓아 이미 통과하던
    // G-NODE(노드-간선 정합) 하드 게이트가 0→34로 깨진다(#2068 2차 실측 — 두
    // 하드 게이트가 이 경로에서 국소적으로 양립 불가, 보고서에 트레이드오프로
    // 기록). 기존 하드 게이트(G-NODE=0) 유지가 우선이므로 위상 번들만 쓴다.
    // 함수 자체는 향후(예: G-NODE tolerance를 번들 edge에 한해 문서화된 예외로
    // 넓히는 설계가 승인되면) 재활성화할 수 있도록 보존한다.

    // #2068 5차(코디네이터 승인 — 코너 방향 선택, 간선 겹침 겨냥) 실측 기록:
    // "환승 허브가 edge의 시작점(a)이면 bend-late로 바꿔 허브 근접 대각선
    // 리드를 없앤다"는 전역 휴리스틱을 실측했다 — 결과는 악화(간선 겹침
    // 85→109, 노드 직선여유 41→49, 신림×2/gtx-a×1/gtx-a×6 등 새 겹침 발생).
    // 허브 쪽 코너를 옮기면 그 허브에 걸린 "다른" 노선들과의 상대 각도가
    // 동시에 바뀌어, 마침 안 겹치던 다른 조합을 새로 겹치게 만드는 경우가
    // 더 많았다 — 되돌린다(bend-early 기본만 사용, 아래 겹침 잔존 41건은
    // 코너 방향 선택으로 해소 시도했으나 실패했음을 기록). octilinearSegment
    // 의 variant 매개변수·buildMinimalBendVertices의 variantForEdge 콜백
    // 인프라는 향후 "겹치는 두 edge만" 좁게 겨냥하는 재설계를 위해 보존한다.
    function variantForEdge() {
      return "bend-early";
    }

    // 3) 노선별 stroke 재작도(조각마다: 번들 오프셋 적용 → 최소굴절 정점 → 필렛
    //    → local d). 조각 전부를 route-line 그룹의 path 목록으로 출력(본선+지선
    //    전부 그려짐 — #2068 2차 버그 재발 방지).
    const perLineReport = [];
    for (const [slug] of slugToId) {
      const pieces = finalPiecesBySlug.get(slug);
      if (!pieces || pieces.length === 0) continue;
      const beforeCurves = countExistingCurvesForSlug(svgText, slug);
      const newPaths = [];
      let afterBends = 0;
      let stationCount = 0;
      for (const seq of pieces) {
        if (seq.length < 2) continue;
        const rendered = applyCorridorBundleOffsets(slug, seq, bundles, o.corridorSpacing);
        const verts = buildMinimalBendVertices(rendered, variantForEdge);
        const d = buildFilletedLocalPath(verts, transform, o.filletRadius, o.minNodeClearance);
        if (d) newPaths.push({ d });
        afterBends += countBends(verts);
        stationCount += seq.length;
      }
      if (newPaths.length === 0) continue;

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

      perLineReport.push({
        slug,
        stations: stationCount,
        pieces: newPaths.length,
        bendsBefore: beforeCurves,
        bendsAfter: afterBends,
      });
    }

    writeFileSync(svgPath, svgText);

    const totalBefore = perLineReport.reduce((s, r) => s + r.bendsBefore, 0);
    const totalAfter = perLineReport.reduce((s, r) => s + r.bendsAfter, 0);
    report = {
      lockedStations: locked.size,
      movedStations: deltas.length,
      patchedElements: patchResult.patchedCount,
      missingStations: patchResult.missing,
      corridorBundleEdges: bundles.assignment.size,
      overlapResolutionClusters: overlapResolution.clusters,
      overlapMovedStations: overlapResolution.movedKeys.size,
      safetyNetRevertedAfterOverlapFix: safetyNet2.revertedCount,
      clearanceFixes: clearanceResolution.fixes,
      clearanceMovedStations: clearanceResolution.movedKeys.size,
      clearanceSkipped: clearanceResolution.skipped,
      safetyNetRevertedAfterClearanceFix: safetyNet3.revertedCount,
      totalBendsBefore: totalBefore,
      totalBendsAfter: totalAfter,
      perLine: perLineReport,
    };
    console.log(
      `역 재배치: 락 ${locked.size} · 이동 ${deltas.length} · 패치요소 ${patchResult.patchedCount} · ` +
        `미발견 ${patchResult.missing.length} · corridor번들edge ${bundles.assignment.size}`,
    );
    console.log(
      `간선 겹침 해소: 클러스터 ${overlapResolution.clusters.length}개 · 이동역 ${overlapResolution.movedKeys.size} · ` +
        `안전망 추가복귀 ${safetyNet2.revertedCount}`,
    );
    for (const c of overlapResolution.clusters) {
      console.log(`    ${c.lineA} x ${c.lineB}: edge ${c.edgesMoved}건 이동`);
    }
    console.log(
      `노드 직선여유 미세정렬: 이동역 ${clearanceResolution.movedKeys.size} · ` +
        `skip ${clearanceResolution.skipped.length} · 안전망 추가복귀 ${safetyNet3.revertedCount}`,
    );
    for (const sk of clearanceResolution.skipped) {
      console.log(`    skip: ${sk.slug} ${sk.station}↔${sk.partnerStation} diag=${sk.diagPx}px — ${sk.reason}`);
    }
    console.log(`코너(bend) 총합: ${totalBefore} → ${totalAfter}`);
    for (const r of perLineReport) {
      console.log(`  ${r.slug}: 역${r.stations} 코너 ${r.bendsBefore}→${r.bendsAfter}`);
    }
    if (patchResult.missing.length) {
      console.log("  미발견(수동확인):", patchResult.missing.join(", "));
    }
  } finally {
    cleanupPackDir(dir);
  }

  if (o.out) {
    writeFileSync(resolveRepo(o.out), JSON.stringify(report, null, 2) + "\n");
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
