#!/usr/bin/env node
//
// #1789 Stage 1a/1b octolinearize(고품질 핵심, 접근 2 공용): track이 손상됐거나
// 각진 노선을, 역 노드를 line_sequence 순서로 정렬해 인접 노드쌍을 8방향
// (0/45/90/135°) 세그먼트로 연결하는 8선형 track으로 재생성한다. 노드 좌표는
// 유지하고(정합 보장), 두 노드를 순수 8방향으로 못 이으면 45° + 수평/수직
// 도그레그(중간 꼭짓점 1개)로 잇는다. 모서리 원호는 렌더러(Stage 2a)가 처리.
//
// Usage: node tools/route-map/octolinearize-line-tracks.mjs
//          --region 수도권 --line "수도권 신림선" [--line ...] [--check]
//          [--branches tools/route-map/line-branches.json] [--all] [--pack <상대경로>]
//   --branches: 분기 정본(JSON)을 읽어 본선에서 spur 역을 제외하고 각 지선을
//               junction에서 시작하는 별도 track 조각으로 그린다(#1793).
//   --all: 지역 전 노선 재생성(baseline 전체 갱신 — 주의). --branches와 동시 사용 불가.

import { readFileSync } from "node:fs";
import path from "node:path";

import { verticesToPath } from "./audit-octolinearity.mjs";
import { cleanupPackDir, openPack, repoRoot, writePack } from "./pack-io.mjs";

/**
 * 두 노드 a→b를 8방향 세그먼트 목록(정점 배열)으로 잇는다. 도그레그 1회 허용.
 *
 * #2068 5차(코디네이터 승인 — 코너 방향 재설계): variant로 도그레그 코너의
 * 위치를 고른다. 두 변형 다 8선형(직선+대각선)이고 corner는 항상 실역이
 * 아닌 합성 정점이므로 G-NODE·8선형 하드 게이트는 어느 쪽을 써도 그대로
 * 유지된다 — "어느 끝이 짧은 대각선 리드(diag*√2)를 받고, 어느 끝이 긴
 * 직선 리드(longAxis-diag)를 받는지"만 바뀐다:
 *   - "bend-early"(기본, 기존 규칙 불변): a에서 대각선(diag*√2) 먼저, b까지
 *     나머지 직선(longAxis-diag).
 *   - "bend-late": a에서 직선(longAxis-diag) 먼저, b까지 나머지 대각선
 *     (diag*√2) — 코너가 b 쪽 가까이 옮겨간다.
 * 기본값(bend-early)만 쓰면 기존 모든 호출부(track 생성 등)의 산출이
 * 완전히 그대로다.
 */
export function octilinearSegment(a, b, variant = "bend-early") {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  // 순수 수평/수직/45° → 직선 1세그먼트(정점 2개).
  if (dx === 0 || dy === 0 || adx === ady) {
    return [a, b];
  }
  const diag = Math.min(adx, ady);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let corner;
  if (variant === "bend-late") {
    // 긴 축 방향으로 (longAxis-diag)만큼 a에서 먼저 이동 — corner가 b 근처.
    if (adx > ady) {
      corner = { x: a.x + sx * (adx - diag), y: a.y };
    } else {
      corner = { x: a.x, y: a.y + sy * (ady - diag) };
    }
  } else {
    // bend-early(기존): 짧은 축 길이(diag)만큼 45°로 이동한 꼭짓점 → 나머지
    // 긴 축 직선. diag가 짧은 축과 같으므로 corner는 자동으로 긴 축의 b
    // 좌표선에 놓인다(수평 우세면 corner.y=b.y, 수직 우세면 corner.x=b.x).
    corner = { x: a.x + sx * diag, y: a.y + sy * diag };
  }
  return [a, corner, b];
}

/**
 * 세그먼트 길이가 이상치(정상 간격의 배수 초과)인 지점에서 노드열을 끊어
 * 별도 조각들로 나눈다. 원본 좌표에 오류가 있는 역(예: 경의중앙 양평 —
 * line_sequence는 오빈·원덕 사이지만 좌표가 도심으로 잘못 찍혀 장거리 detour를
 * 만든다)이 본선 폴리라인에 그려지며 타 노선과 대량 교차하는 회귀를 자동 차단한다.
 * 좌표는 건드리지 않고 "연결(세그먼트)만" 생략한다 — 수동 시드가 아니다.
 * 조각 경계에서 홀로 남는 노드(양쪽이 모두 이상치 간격)는 조각화되며 <2노드로 버려진다.
 */
export function splitAtOutlierGaps(nodes, { absFloor = 400, p90Mult = 4 } = {}) {
  if (nodes.length < 3) return nodes.length >= 2 ? [nodes.slice()] : [];
  const segLens = [];
  for (let i = 1; i < nodes.length; i += 1) {
    segLens.push(Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].y - nodes[i - 1].y));
  }
  const sorted = [...segLens].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  const threshold = Math.max(absFloor, p90Mult * p90);
  const runs = [];
  let cur = [nodes[0]];
  for (let i = 1; i < nodes.length; i += 1) {
    if (segLens[i - 1] > threshold) {
      runs.push(cur);
      cur = [nodes[i]];
    } else {
      cur.push(nodes[i]);
    }
  }
  runs.push(cur);
  const valid = runs.filter((r) => r.length >= 2);
  const dropped = runs.filter((r) => r.length < 2).flat();
  if (dropped.length > 0) {
    const droppedCoords = dropped.map((n) => `(${n.x},${n.y})`).join(", ");
    console.warn(`[splitAtOutlierGaps] 고립 노드 ${dropped.length}개 드롭됨: ${droppedCoords}`);
  }
  return valid;
}

/** 노드 목록(sequence 순)을 8선형 polyline 정점 배열로. */
export function octilinearPolyline(nodes) {
  if (nodes.length < 2) return nodes.slice();
  const out = [nodes[0]];
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const seg = octilinearSegment(nodes[i], nodes[i + 1]);
    // seg[0]은 직전 노드(중복) → 제외하고 이어붙임.
    for (let k = 1; k < seg.length; k += 1) out.push(seg[k]);
  }
  return out;
}

function parseArgs(argv) {
  const o = { pack: "apps/mobile/assets/datapacks/capital.sqlite.gz", index: "apps/mobile/assets/datapacks/index.json", region: "수도권", lines: [], all: false, branches: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--region": o.region = argv[++i]; break;
      case "--line": o.lines.push(argv[++i]); break;
      case "--all": o.all = true; break;
      case "--branches": o.branches = argv[++i]; break;
      case "--check": o.check = true; break;
      case "--pack": o.pack = argv[++i]; break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.all && o.branches) {
    console.error(
      "오류: --all과 --branches는 동시에 지정할 수 없습니다. 분기 위상 정정은 " +
        "영향 노선만 --line으로 지정해 실행하세요(baseline 전체 재생성 금지).",
    );
    process.exit(1);
  }
  const { db, dir, sqlitePath, packPath } = openPack(o.pack, "octolinearize-");
  // 분기(지선) 데이터: { "<노선명>": [{junction, spur:[역명...]}...] }
  const branchesByLine = {};
  if (o.branches) {
    const bj = JSON.parse(readFileSync(path.join(repoRoot, o.branches), "utf8"));
    Object.assign(branchesByLine, bj.linesByRegion?.[o.region] ?? {});
  }
  try {
    const lineIds = [];
    if (o.all) {
      // 지역 내 route_map_positions에 노드가 있는 전 노선.
      for (const r of db.prepare("SELECT DISTINCT rmp.line_id AS id, l.name_ko AS name FROM route_map_positions rmp JOIN lines l ON l.id = rmp.line_id WHERE rmp.region = ? ORDER BY l.name_ko").all(o.region)) {
        lineIds.push({ id: r.id, name: r.name });
      }
    } else {
      for (const nm of o.lines) {
        const row = db.prepare("SELECT id FROM lines WHERE name_ko = ?").get(nm);
        if (row) lineIds.push({ id: row.id, name: nm });
      }
    }
    for (const { id, name } of lineIds) {
      // 노드를 역명 + line_sequence 순서로 (동일 물리역은 x/y 그대로).
      const nodeRows = db
        .prepare(
          `SELECT s.name_ko AS name, rmp.x AS x, rmp.y AS y, sl.line_sequence AS seq
           FROM route_map_positions rmp
           JOIN station_lines sl ON sl.station_id = rmp.station_id AND sl.line_id = rmp.line_id
           JOIN stations s ON s.id = rmp.station_id
           WHERE rmp.region = ? AND rmp.line_id = ?
           ORDER BY sl.line_sequence`,
        )
        .all(o.region, id);
      if (nodeRows.length < 2) {
        console.log(`  ${name}: 노드 ${nodeRows.length} → 스킵`);
        continue;
      }
      const branches = branchesByLine[name] ?? [];
      const spurNames = new Set(branches.flatMap((b) => b.spur));
      // 본선: spur 역을 제외한 sequence(분기점 junction은 본선에 남는다).
      // 좌표 오류로 생기는 장거리 detour는 이상치 간격에서 끊어 별도 조각으로
      // 나눈다(교차 회귀 자동 차단). 정상 노선은 조각 1개 그대로.
      // 지선도 동일하게 splitAtOutlierGaps를 통과시켜 이상치 간격 방어 적용.
      const mainNodes = nodeRows.filter((r) => !spurNames.has(r.name)).map((r) => ({ x: r.x, y: r.y }));
      const paths = splitAtOutlierGaps(mainNodes).map((run) => verticesToPath(octilinearPolyline(run)));
      // 각 지선: junction 역에서 시작해 spur 역들을 잇는 별도 조각.
      // 이상치 간격이 있는 지선도 각 run을 별도 track 조각으로 나눠 본선과 동일하게 방어한다.
      for (const b of branches) {
        const jn = nodeRows.find((r) => r.name === b.junction);
        const spurNodes = b.spur.map((sn) => nodeRows.find((r) => r.name === sn)).filter(Boolean);
        if (!jn || spurNodes.length === 0) {
          console.log(`  ${name}/${b.name}: junction·spur 노드 부족 → 스킵`);
          continue;
        }
        const chain = [jn, ...spurNodes].map((r) => ({ x: r.x, y: r.y }));
        for (const run of splitAtOutlierGaps(chain)) {
          paths.push(verticesToPath(octilinearPolyline(run)));
        }
      }
      const branchSuffix = branches.length ? ` (지선 ${branches.length})` : "";
      console.log(`  ${name}: 노드 ${nodeRows.length} → 본선+지선 조각 ${paths.length}${branchSuffix}`);
      if (!o.check) {
        // 기존 조각 삭제 후 본선+지선 조각으로 재생성(라이선스 컬럼은 기존 첫 행 승계)
        const meta = db.prepare("SELECT svg_color, source_id, source_name, source_url, license, license_status, commercial_use_allowed, attribution_required, updated_at FROM route_map_line_tracks WHERE region=? AND line_id=? ORDER BY track_index LIMIT 1").get(o.region, id);
        if (!meta) {
          throw new Error(
            `${name}: 기존 track 메타가 없어 재생성할 수 없습니다(라이선스·색 메타 부재). --line 지정을 확인하세요`,
          );
        }
        db.exec("BEGIN");
        db.prepare("DELETE FROM route_map_line_tracks WHERE region=? AND line_id=?").run(o.region, id);
        const ins = db.prepare("INSERT INTO route_map_line_tracks (region, line_id, track_index, path, svg_color, source_id, source_name, source_url, license, license_status, commercial_use_allowed, attribution_required, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
        paths.forEach((p, ti) => ins.run(o.region, id, ti, p, meta.svg_color, meta.source_id, meta.source_name, meta.source_url, meta.license, meta.license_status, meta.commercial_use_allowed, meta.attribution_required, meta.updated_at));
        db.exec("COMMIT");
      }
    }
    if (o.check) { console.log("(--check: 미기록)"); return; }
    db.exec("VACUUM");
    db.close();
    const { byteSize } = writePack({ sqlitePath, packPath, packRelPath: o.pack, indexRelPath: o.index });
    console.log(`팩 갱신 (byteSize ${byteSize})`);
  } finally {
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
