#!/usr/bin/env node
// #2068 마감 3단계(수도권): 유클리드 간격 미달 쌍을 SVG 소스에서 직접 재간격
// 한다. 직전 라운드(01f082ef)는 이 로직을 scratchpad 1회성 스크립트
// (repel-euclidean.mjs + patch-svg-euclidean.mjs)로 돌려 적용했으나 커밋되지
// 않아 재현 불가능했다 — 이 파일이 그 조합을 실측 검증 후 커밋 도구로
// 승격한 것이다(오너 지시, 2026-07-18).
//
// 파이프라인 위치: run-sma-pipeline.sh의 [1/7] geometry 추출 **이전**에 SVG
// 소스 자체를 이 도구로 먼저 패치한다(팩은 건드리지 않음 — 파이프라인
// 재실행이 SVG에서 팩을 다시 파생하므로 SVG가 유일한 진본).
//
//   node tools/route-map/apply-euclidean-svg-respacing.mjs \
//     [--pack apps/mobile/assets/datapacks/capital.sqlite.gz] \
//     [--svg tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg] \
//     [--geometry tools/route-map/route-map-defs/easy-subway-sma-v2-geometry.json] \
//     [--region 수도권] [--threshold 48] [--target 52] [--dry-run]
//
// 3단계 결합:
//  1) 반발 솔버(census-구동): 팩(route_map_positions, 곧 SVG 좌표의 대리)에서
//     같은 노선 내 최근접 쌍 <threshold를 전수 조사하고, 위반마다 두 역을
//     8선형 스냅 방향으로 밀어 정확히 target 이상 벌린다. station_id 단위
//     centroid를 옮겨 캡슐 내부 상대 offset을 보존한다(직전 라운드
//     repel-euclidean.mjs와 동일 알고리즘 — 이미 census 492→16 실증).
//  2) SVG 패처(별칭 인식): 산출 delta를 station_id 단위로 SVG에 되쓴다. 마커는
//     4가지 id 규약(circle id="_<name>" · circle id="station-node-<name>" ·
//     g id="transfer-station-symbol-<name>" · g id="terminal-station-symbol-
//     <name>")을 순서대로 시도하고, 전부 실패하면 **라벨 폴백**(마커 없는
//     v1 안산선 꼬리 역들 — 라벨 <text>의 x/y·tspan x/y 또는 transform을
//     옮긴다)으로 넘어간다. canonical(DB) 이름 ↔ SVG dataStation 표기가
//     다른 역(총신대입구↔이수, 신촌/양평의 콜론 접미 노선별 복수 마커)은
//     SVG_NAME_ALIASES로 명시 매핑한다 — 이 별칭이 직전 라운드의 "13건
//     미매핑"(exceptions 문서화분) 원인이었다.
//  3) stroke 국소 추종(대이동 역): 마커 패치 후 실제 렌더 좌표계 기준으로
//     역과 그 노선 stroke의 최근접 거리를 재실측해 tolerance를 넘는 역만
//     해당 route-line <path>의 최근접 정점/투영점을 찾아 국소 이동(기존
//     정점이 가까우면 그 정점을, 아니면 투영점에 새 정점을 삽입)한다 — 8선형
//     직선 run만 대상(코너 곡선 근방은 건드리지 않아 라운드 커브를 보존).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openPack, cleanupPackDir, repoRoot } from "./pack-io.mjs";

// ── 1) census-구동 반발 솔버 ────────────────────────────────────────────────

/**
 * region의 route_map_positions에서 같은 line_id 내 서로 다른 station_id 쌍의
 * 유클리드 거리가 threshold 미만이면 8선형 스냅 방향으로 밀어 target 이상
 * 벌린다. station_id 단위 centroid를 옮기고 (station_id,line_id) 행별
 * centroid 대비 offset은 고정 보존(캡슐 내부 상대 형상 불변). 순수 함수 —
 * db는 열린 DatabaseSync, 기록하지 않는다(호출부가 결과로 기록 여부 결정).
 */
export function solveEuclideanRepel(
  db,
  region,
  { threshold = 48, target = 52, maxIters = 3000, damping = 0.4 } = {},
) {
  const rows = db
    .prepare(
      "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region=?",
    )
    .all(region);

  const byStation = new Map();
  for (const r of rows) {
    if (!byStation.has(r.station_id)) byStation.set(r.station_id, []);
    byStation.get(r.station_id).push(r);
  }
  const centroid = new Map(); // stationId -> {x,y}
  const offset = new Map(); // "stationId|lineId" -> {dx,dy}
  for (const [sid, members] of byStation) {
    const cx = members.reduce((s, m) => s + m.x, 0) / members.length;
    const cy = members.reduce((s, m) => s + m.y, 0) / members.length;
    centroid.set(sid, { x: cx, y: cy });
    for (const m of members) {
      offset.set(`${sid}|${m.line_id}`, { dx: m.x - cx, dy: m.y - cy });
    }
  }

  const rowPositions = () =>
    rows.map((r) => {
      const c = centroid.get(r.station_id);
      const off = offset.get(`${r.station_id}|${r.line_id}`);
      return {
        station_id: r.station_id,
        line_id: r.line_id,
        x: c.x + off.dx,
        y: c.y + off.dy,
      };
    });

  const findViolations = (pos) => {
    const byLine = new Map();
    for (const r of pos) {
      if (!byLine.has(r.line_id)) byLine.set(r.line_id, []);
      byLine.get(r.line_id).push(r);
    }
    const out = [];
    for (const [lineId, sts] of byLine) {
      for (let i = 0; i < sts.length; i += 1) {
        for (let j = i + 1; j < sts.length; j += 1) {
          if (sts[i].station_id === sts[j].station_id) continue;
          const dx = sts[j].x - sts[i].x;
          const dy = sts[j].y - sts[i].y;
          const d = Math.hypot(dx, dy);
          if (d < threshold) out.push({ lineId, a: sts[i], b: sts[j], d, dx, dy });
        }
      }
    }
    return out;
  };

  const snapOcto = (dx, dy) => {
    if (dx === 0 && dy === 0) return { x: 1, y: 0 };
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: Math.cos(ang), y: Math.sin(ang) };
  };

  let iters = 0;
  let finalViolations = [];
  for (let iter = 0; iter < maxIters; iter += 1) {
    const pos = rowPositions();
    const violations = findViolations(pos);
    iters = iter;
    if (violations.length === 0) {
      finalViolations = [];
      break;
    }
    finalViolations = violations;

    const corr = new Map(); // stationId -> {x,y}
    const bump = (sid, vx, vy) => {
      if (!corr.has(sid)) corr.set(sid, { x: 0, y: 0 });
      const c = corr.get(sid);
      c.x += vx;
      c.y += vy;
    };
    for (const v of violations) {
      const dir = snapOcto(v.dx, v.dy);
      const deficit = target - v.d;
      bump(v.a.station_id, -dir.x * deficit * 0.5, -dir.y * deficit * 0.5);
      bump(v.b.station_id, dir.x * deficit * 0.5, dir.y * deficit * 0.5);
    }
    for (const [sid, c] of corr) {
      const cur = centroid.get(sid);
      centroid.set(sid, { x: cur.x + c.x * damping, y: cur.y + c.y * damping });
    }
  }

  const names = new Map();
  for (const r of db.prepare("SELECT id, name_ko FROM stations").all()) {
    names.set(r.id, r.name_ko);
  }
  const deltas = [];
  for (const [sid, members] of byStation) {
    const cx0 = members.reduce((s, m) => s + m.x, 0) / members.length;
    const cy0 = members.reduce((s, m) => s + m.y, 0) / members.length;
    const c1 = centroid.get(sid);
    const dx = c1.x - cx0;
    const dy = c1.y - cy0;
    if (Math.hypot(dx, dy) < 0.01) continue;
    deltas.push({
      stationId: sid,
      name: names.get(sid) ?? sid,
      dx: Math.round(dx * 1000) / 1000,
      dy: Math.round(dy * 1000) / 1000,
    });
  }
  deltas.sort((p, q) => Math.hypot(q.dx, q.dy) - Math.hypot(p.dx, p.dy));

  return { deltas, iters, finalViolations };
}

// ── 2) SVG 패처(별칭 인식) ───────────────────────────────────────────────

// canonical(DB) 이름 → SVG data-station 표기 별칭. 값은 svgName 배열 — 배열의
// 모든 항목이 같은 delta로 함께 패치된다(하나의 물리역이 노선별 복수 마커로
// 그려진 경우, 콜론 접미 동명이역 구분 표기). #2068 3단계 실측(check-canonical류
// 진단 재현): 이 3건이 직전 라운드 13건 미매핑의 근본 원인이었다(나머지
// 10건은 별칭이 아니라 마커 자체가 없는 v1 안산선 꼬리 라벨-only 역 — 아래
// 라벨 폴백이 이름 변경 없이 처리한다).
export const SVG_NAME_ALIASES = {
  총신대입구: ["이수"],
  신촌: ["신촌:2호선", "신촌:경의중앙선"],
  양평: ["양평:5호선", "양평:경의중앙선"],
};

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/** idAttr(예: 'id="_검단오류"')의 정확한 위치를 찾아 요소 [start,end) 범위를
 *  반환한다(patch-svg-euclidean.mjs 원안과 동일 — indexOf로 정확한 위치를
 *  먼저 찾고 그 지점에서 국소 탐색해 요소 경계를 잡는다. 단일 정규식
 *  전역 삼킴 버그 재발 방지, #2068 1단계 실측 근거 주석 유지). */
export function findElementRange(text, idAttr, tagName, selfClosingOnly) {
  const idPos = text.indexOf(idAttr);
  if (idPos === -1) return null;
  const tagOpen = `<${tagName}`;
  const startPos = text.lastIndexOf(tagOpen, idPos);
  if (startPos === -1) return null;
  const nextLt = text.indexOf("<", startPos + 1);
  if (nextLt !== -1 && nextLt < idPos) return null;
  if (selfClosingOnly) {
    const closePos = text.indexOf("/>", idPos);
    if (closePos === -1) return null;
    const nextLt2 = text.indexOf("<", idPos);
    if (nextLt2 !== -1 && nextLt2 < closePos) return null;
    return { start: startPos, end: closePos + 2 };
  }
  const gt = text.indexOf(">", idPos);
  if (gt === -1) return null;
  return { start: startPos, end: gt + 1 };
}

/** 요소 텍스트에 로컬 delta(localDx,localDy)를 transform="translate(...)"로
 *  가산한다. 2-인수·1-인수 translate·기존 transform(회전 캡슐) 합성·
 *  transform 속성 부재 세 경우 모두 처리(#2068 1단계 실측 3버그 수정 계승). */
export function addTranslate(elText, localDx, localDy) {
  const re2 = /transform="translate\(\s*(-?[\d.eE+-]+)[,\s]+(-?[\d.eE+-]+)\s*\)"/;
  const m2 = elText.match(re2);
  if (m2) {
    const a = Number(m2[1]) + localDx;
    const b = Number(m2[2]) + localDy;
    return elText.replace(re2, `transform="translate(${round3(a)},${round3(b)})"`);
  }
  const re1 = /transform="translate\(\s*(-?[\d.eE+-]+)\s*\)"/;
  const m1 = elText.match(re1);
  if (m1) {
    const a = Number(m1[1]) + localDx;
    const b = 0 + localDy;
    return elText.replace(re1, `transform="translate(${round3(a)},${round3(b)})"`);
  }
  const anyTransformRe = /transform="([^"]*)"/;
  const mAny = elText.match(anyTransformRe);
  if (mAny) {
    const combined = `translate(${round3(localDx)},${round3(localDy)}) ${mAny[1]}`;
    return elText.replace(anyTransformRe, `transform="${combined}"`);
  }
  const insertion = ` transform="translate(${round3(localDx)},${round3(localDy)})"`;
  if (elText.endsWith("/>")) return elText.slice(0, -2) + insertion + "/>";
  if (elText.endsWith(">")) return elText.slice(0, -1) + insertion + ">";
  throw new Error("예상치 못한 요소 종료: " + elText.slice(-20));
}

/** 마커 없는 역(v1 안산선 꼬리 등)의 라벨 <text id="station-label-<name>">을
 *  대신 옮긴다. text-anchor·글리프는 불변, 위치만 이동:
 *   - transform="translate(...)"가 있으면 그걸 가산(addTranslate 재사용).
 *   - 없고 <text>가 x/y 속성을 직접 가지면(그리고 첫 tspan도 보통 같은 값을
 *     반복) 그 x/y와 모든 자식 <tspan x= y=>를 가산.
 *  반환: 패치된 elText 또는 실패 시 null. */
export function patchLabelElement(elText, localDx, localDy) {
  if (/transform="/.test(elText.slice(0, elText.indexOf(">") + 1))) {
    return addTranslate(elText, localDx, localDy);
  }
  const openEnd = elText.indexOf(">");
  if (openEnd === -1) return null;
  let openTag = elText.slice(0, openEnd + 1);
  let body = elText.slice(openEnd + 1);
  if (!/\bx="/.test(openTag)) return null;
  const shiftAttr = (tag, attr, delta) =>
    tag.replace(
      new RegExp(`\\b${attr}="(-?[\\d.eE+-]+)"`, "g"),
      (_m, v) => `${attr}="${round3(Number(v) + delta)}"`,
    );
  openTag = shiftAttr(openTag, "x", localDx);
  openTag = shiftAttr(openTag, "y", localDy);
  body = body.replace(/<tspan\b[^>]*>/g, (tag) => {
    let t = shiftAttr(tag, "x", localDx);
    t = shiftAttr(t, "y", localDy);
    return t;
  });
  return openTag + body;
}

/**
 * 델타 목록을 SVG에 적용한다. 각 delta.name(canonical)에 대해
 * SVG_NAME_ALIASES 별칭(있으면 전부, 없으면 name 그대로) 각각을 대상으로,
 * (a) circle id="_<svgName>" (b) circle id="station-node-<svgName>"
 * (c) g id="transfer-station-symbol-<svgName>" (d) g id="terminal-station-
 * symbol-<svgName>" 순서로 마커를 찾아 로컬 delta(=delta/mapScale)를
 * translate로 가산한다. 넷 다 실패하면 g/text id="station-label-<svgName>"
 * 라벨로 폴백한다(마커 없는 역). 반환: {svg, patched:[...], missing:[...]}.
 */
export function applyDeltasToSvg(svg, deltas, { mapScale = 0.455 } = {}) {
  const patched = [];
  const missing = [];
  for (const d of deltas) {
    const svgNames = SVG_NAME_ALIASES[d.name] ?? [d.name];
    const localDx = d.dx / mapScale;
    const localDy = d.dy / mapScale;
    let anyPatched = false;
    for (const svgName of svgNames) {
      const attempts = [
        { idAttr: `id="_${svgName}"`, tag: "circle", selfClosing: true, kind: "circle" },
        { idAttr: `id="station-node-${svgName}"`, tag: "circle", selfClosing: true, kind: "circle" },
        { idAttr: `id="transfer-station-symbol-${svgName}"`, tag: "g", selfClosing: false, kind: "capsule" },
        { idAttr: `id="terminal-station-symbol-${svgName}"`, tag: "g", selfClosing: false, kind: "terminal" },
      ];
      let done = false;
      for (const a of attempts) {
        const range = findElementRange(svg, a.idAttr, a.tag, a.selfClosing);
        if (!range) continue;
        const elText = svg.slice(range.start, range.end);
        const newText = addTranslate(elText, localDx, localDy);
        svg = svg.slice(0, range.start) + newText + svg.slice(range.end);
        patched.push({ name: d.name, svgName, kind: a.kind });
        done = true;
        anyPatched = true;
        break;
      }
      if (done) continue;
      // 라벨 폴백.
      const labelIdAttr = `id="station-label-${svgName}"`;
      const range = findElementRange(svg, labelIdAttr, "text", false);
      if (!range) {
        missing.push({ name: d.name, svgName, reason: "마커·라벨 전부 미발견" });
        continue;
      }
      // <text ...>...</text> 전체(자식 tspan 포함)를 옮겨야 하므로 </text>까지 확장.
      const closeIdx = svg.indexOf("</text>", range.end);
      if (closeIdx === -1) {
        missing.push({ name: d.name, svgName, reason: "</text> 미발견" });
        continue;
      }
      const fullRange = { start: range.start, end: closeIdx + "</text>".length };
      const elText = svg.slice(fullRange.start, fullRange.end);
      const newText = patchLabelElement(elText, localDx, localDy);
      if (newText === null) {
        missing.push({ name: d.name, svgName, reason: "라벨 패치 실패(형식 미인식)" });
        continue;
      }
      svg = svg.slice(0, fullRange.start) + newText + svg.slice(fullRange.end);
      patched.push({ name: d.name, svgName, kind: "label" });
      anyPatched = true;
    }
    if (!anyPatched) {
      missing.push({ name: d.name, svgName: svgNames.join("/"), reason: "전 별칭 미발견" });
    }
  }
  return { svg, patched, missing };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    svg: "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg",
    region: "수도권",
    threshold: 48,
    target: 52,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": o.pack = argv[++i]; break;
      case "--svg": o.svg = argv[++i]; break;
      case "--region": o.region = argv[++i]; break;
      case "--threshold": o.threshold = Number(argv[++i]); break;
      case "--target": o.target = Number(argv[++i]); break;
      case "--dry-run": o.dryRun = true; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { db, dir } = openPack(o.pack, "euclid-svg-");
  let deltas, iters, finalViolations;
  try {
    ({ deltas, iters, finalViolations } = solveEuclideanRepel(db, o.region, {
      threshold: o.threshold,
      target: o.target,
    }));
  } finally {
    cleanupPackDir(dir);
  }
  console.log(
    `[${o.region}] 반발 솔버 ${iters}회 · 이동 대상 역 ${deltas.length} · ` +
      `잔존 위반 ${finalViolations.length}` +
      (deltas[0] ? ` · 최대 이동 ${Math.hypot(deltas[0].dx, deltas[0].dy).toFixed(1)}px(${deltas[0].name})` : ""),
  );
  if (finalViolations.length) {
    console.log("  솔버 미수렴 잔존 위반(다체 클러스터 등 — 예외 목록 확인 필요):");
    for (const v of finalViolations.slice(0, 20)) {
      console.log(`    ${v.d.toFixed(1)}  ${v.a.station_id} <-> ${v.b.station_id}`);
    }
  }

  const svgPath = path.isAbsolute(o.svg) ? o.svg : path.join(repoRoot, o.svg);
  const svgIn = readFileSync(svgPath, "utf8");
  const { svg: svgOut, patched, missing } = applyDeltasToSvg(svgIn, deltas);
  console.log(`SVG 패치: 대상 ${deltas.length} · 마커/라벨 요소 패치 ${patched.length} · 미발견 ${missing.length}`);
  if (missing.length) {
    console.log("  미발견 목록(수동 확인 필요):");
    for (const m of missing) console.log(`    ${m.name} (${m.svgName}) — ${m.reason}`);
  }
  if (o.dryRun) {
    console.log("(--dry-run: SVG 미기록)");
    return;
  }
  writeFileSync(svgPath, svgOut);
  console.log(`쓰기 완료: ${svgPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
