#!/usr/bin/env node
// #2068 유클리드 간격 하드 게이트: route_map_positions(팩, hit target)에서 같은
// 노선 내 서로 다른 역 간 **직선(유클리드) 거리**의 최근접 쌍을 전수 조사한다.
//
// respace-route-map.mjs의 기존 audit-station-spacing.mjs는 트랙 호길이(arc
// length) 기준이라 굽은 구간에서 호길이 ≥48이어도 직선거리는 48 미만일 수
// 있다(#2068 오너 반려 실측: 녹번↔홍제 47.65가 임계 근거이며 이것도 유클리드
// 값). 이 게이트는 그 간극을 막는다 — 화면에 그려지는 두 점의 실제 간격이
// 임계다.
//
// 환승 캡슐 내부(동일 station_id, 서로 다른 line_id 멤버)는 원천 제외한다
// (오너 기준: "환승 캡슐 내부만 제외" — 캡슐 밖 이웃 일반역과의 간격은
// 대상). 예외는 route-map-euclidean-spacing-exceptions.json에 근거와 함께
// 명시적으로만 허용한다 — 목록에 없는 <48 쌍이 하나라도 있으면 실패.
//
// Usage: node tools/route-map/audit-station-euclidean-spacing.mjs
//          [--pack apps/mobile/assets/datapacks/capital.sqlite.gz]
//          [--region 수도권] [--threshold 48]
//          [--exceptions tools/route-map/route-map-euclidean-spacing-exceptions.json]
//          [--json out.json]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { cleanupPackDir, openPack, repoRoot } from "./pack-io.mjs";

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    region: "수도권",
    threshold: 48,
    exceptions: "tools/route-map/route-map-euclidean-spacing-exceptions.json",
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack":
        o.pack = argv[++i];
        break;
      case "--region":
        o.region = argv[++i];
        break;
      case "--threshold":
        o.threshold = Number(argv[++i]);
        break;
      case "--exceptions":
        o.exceptions = argv[++i];
        break;
      case "--json":
        o.json = argv[++i];
        break;
    }
  }
  return o;
}

/**
 * region의 route_map_positions에서 같은 line_id 내 서로 다른 station_id 쌍의
 * 최근접 유클리드 거리가 threshold 미만인 목록을 산출한다(동일역 환승 멤버
 * 제외). db는 열린 DatabaseSync, 순수 함수라 테스트 가능.
 */
export function findEuclideanSpacingViolations(db, region, threshold) {
  const rows = db
    .prepare(
      "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?",
    )
    .all(region);
  const byLine = new Map();
  for (const r of rows) {
    if (!byLine.has(r.line_id)) byLine.set(r.line_id, []);
    byLine.get(r.line_id).push(r);
  }
  const violations = [];
  for (const [lineId, sts] of byLine) {
    for (let i = 0; i < sts.length; i += 1) {
      for (let j = i + 1; j < sts.length; j += 1) {
        if (sts[i].station_id === sts[j].station_id) continue; // 환승 캡슐 내부 제외
        const d = Math.hypot(sts[i].x - sts[j].x, sts[i].y - sts[j].y);
        if (d < threshold) {
          const [a, b] = [sts[i].station_id, sts[j].station_id].sort((p, q) =>
            p < q ? -1 : p > q ? 1 : 0,
          );
          violations.push({ lineId, a, b, dist: Math.round(d * 100) / 100 });
        }
      }
    }
  }
  violations.sort((p, q) => p.dist - q.dist);
  return violations;
}

/** 예외 목록과 대조해 허용되지 않은 위반만 남긴다. */
export function filterUnlistedViolations(violations, exceptions) {
  const allowed = new Set(
    (exceptions ?? []).map(
      (e) =>
        `${e.lineId}|${[e.a, e.b].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)).join("|")}`,
    ),
  );
  return violations.filter(
    (v) =>
      !allowed.has(
        `${v.lineId}|${[v.a, v.b].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)).join("|")}`,
      ),
  );
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const exceptionsPath = path.isAbsolute(o.exceptions)
    ? o.exceptions
    : path.join(repoRoot, o.exceptions);
  const exceptions = existsSync(exceptionsPath)
    ? JSON.parse(readFileSync(exceptionsPath, "utf8")).exceptions
    : [];

  const { db, dir } = openPack(o.pack, "audit-euclid-");
  try {
    const nameRows = db.prepare("SELECT id, name_ko FROM stations").all();
    const names = new Map(nameRows.map((r) => [r.id, r.name_ko]));
    const lineRows = db.prepare("SELECT id, name_ko FROM lines").all();
    const lineNames = new Map(lineRows.map((r) => [r.id, r.name_ko]));

    const violations = findEuclideanSpacingViolations(
      db,
      o.region,
      o.threshold,
    );
    const unlisted = filterUnlistedViolations(violations, exceptions);

    console.log(
      `[${o.region}] 유클리드 간격 <${o.threshold} 전수: ${violations.length}건 ` +
        `(예외 등재 ${violations.length - unlisted.length}건 · 미등재 ${unlisted.length}건)`,
    );
    if (o.json) {
      writeFileSync(
        path.isAbsolute(o.json) ? o.json : path.join(repoRoot, o.json),
        JSON.stringify(
          {
            region: o.region,
            threshold: o.threshold,
            total: violations.length,
            unlisted: unlisted.length,
            violations: violations.map((v) => ({
              ...v,
              lineName: lineNames.get(v.lineId) ?? v.lineId,
              aName: names.get(v.a) ?? v.a,
              bName: names.get(v.b) ?? v.b,
            })),
          },
          null,
          2,
        ) + "\n",
      );
    }
    if (unlisted.length) {
      console.error("미등재 위반(하드 게이트 실패):");
      for (const v of unlisted.slice(0, 60)) {
        console.error(
          `  ${v.dist}\t${lineNames.get(v.lineId) ?? v.lineId}\t` +
            `${names.get(v.a) ?? v.a} ↔ ${names.get(v.b) ?? v.b}`,
        );
      }
      process.exit(1);
    }
    console.log("감사 통과 (미등재 유클리드 간격 위반 0).");
  } finally {
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
