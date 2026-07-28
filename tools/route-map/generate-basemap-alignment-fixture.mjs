#!/usr/bin/env node
// #2068 Part 3: 바탕(SVG)↔인터랙션(팩) 정합을 "대표 9역 표본"이 아니라 **전 역**
// 하드 게이트로 승격하기 위한 고정 fixture 생성기.
//
// buildAssignments(apply-sma-svg-positions.mjs)가 이미 SVG canonical 정합의
// 단일 정본이므로(별칭/콜론 접미 동명이역 등 실제 매칭 규칙 포함), 그 결과를
// 그대로 재사용해 각 station_id의 "SVG 캔버스 좌표"를 얻고, 팩(hit target)
// route_map_positions와 대조한 delta를 JSON으로 남긴다.
// route_map_basemap_alignment_test.dart가 이 파일을 dart:io로 읽어 **전 역**
// delta < threshold를 하드 게이트로 고정한다(기존 9역 표본은 폐기).
//
// Usage: node tools/route-map/generate-basemap-alignment-fixture.mjs
//   [--pack apps/mobile/assets/datapacks/capital.sqlite.gz]
//   [--geometry tools/route-map/route-map-defs/easy-subway-sma-v4-geometry.json]
//   [--region 수도권]
//   [--out tools/route-map/route-map-defs/seoul-alignment-fixture.json]
//
// 주의: 출력 경로를 apps/mobile/assets/datapacks/metro_map_pack/basemap/ 밑에
// 두지 말 것 — pubspec.yaml이 그 디렉터리를 통째로(와일드카드) 앱 번들에
// 포함시키므로 QA 전용 fixture가 실제 배포 앱에 딸려 들어간다.

import { isMainModule } from "../lib/is-main-module.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildAssignments } from "./apply-sma-svg-positions.mjs";
import { cleanupPackDir, openPack, repoRoot } from "./pack-io.mjs";
import { getRegionConfig } from "./sma-region-configs.mjs";

function codeUnitCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseArgs(argv) {
  const o = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    geometry: "tools/route-map/route-map-defs/easy-subway-sma-v4-geometry.json",
    region: "수도권",
    out: "tools/route-map/route-map-defs/seoul-alignment-fixture.json",
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack":
        o.pack = argv[++i];
        break;
      case "--geometry":
        o.geometry = argv[++i];
        break;
      case "--region":
        o.region = argv[++i];
        break;
      case "--out":
        o.out = argv[++i];
        break;
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const geometryBytes = readFileSync(path.join(repoRoot, o.geometry));
  const packBytes = readFileSync(path.join(repoRoot, o.pack));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const extraction = JSON.parse(geometryBytes.toString("utf8"));
  const config = getRegionConfig(o.region);
  const { db, dir } = openPack(o.pack, "align-fixture-");
  try {
    const { assignments } = buildAssignments(db, extraction, config);
    const svgByStation = new Map(assignments.map((a) => [a.stationId, a]));

    const names = new Map();
    for (const r of db.prepare("SELECT id, name_ko FROM stations").all()) {
      names.set(r.id, r.name_ko);
    }
    // (station_id, line_id) 전 행 — 환승역은 여러 line 행이 같은 캡슐(단일
    // SVG 노드)을 공유하므로 모두 같은 svg 배정과 비교한다(각 행이 별개
    // hit target 후보라 전부 검증 대상).
    const packRows = db
      .prepare(
        "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?",
      )
      .all(config.regionKey);

    const entries = [];
    const unmatched = [];
    for (const row of packRows) {
      const svg = svgByStation.get(row.station_id);
      if (!svg) {
        const name = names.get(row.station_id) ?? row.station_id;
        const exception = config.topologyExceptions.find(
          (candidate) => candidate.name === name,
        );
        if (!exception) {
          throw new Error(
            `Undeclared unmatched route_map_positions row: ${row.station_id}/${row.line_id} (${name}).`,
          );
        }
        unmatched.push({
          stationId: row.station_id,
          lineId: row.line_id,
          name,
          reason: exception.reason,
        });
        continue;
      }
      const dx = svg.x - row.x;
      const dy = svg.y - row.y;
      entries.push({
        stationId: row.station_id,
        lineId: row.line_id,
        name: names.get(row.station_id) ?? row.station_id,
        svgX: Math.round(svg.x * 100) / 100,
        svgY: Math.round(svg.y * 100) / 100,
        packX: row.x,
        packY: row.y,
        deltaPx: Math.round(Math.hypot(dx, dy) * 100) / 100,
      });
    }
    entries.sort((a, b) => b.deltaPx - a.deltaPx);
    unmatched.sort(
      (a, b) =>
        codeUnitCompare(a.stationId, b.stationId) ||
        codeUnitCompare(a.lineId, b.lineId) ||
        codeUnitCompare(a.name, b.name) ||
        codeUnitCompare(a.reason, b.reason),
    );

    const fixture = {
      artifactKind: "basemap-alignment-fixture",
      region: o.region,
      generatedFrom: {
        geometry: o.geometry,
        geometrySha256: sha256(geometryBytes),
        pack: o.pack,
        packSha256: sha256(packBytes),
      },
      stationCount: entries.length,
      unmatchedCount: unmatched.length,
      unmatched,
      maxDeltaPx: entries.length ? entries[0].deltaPx : 0,
      entries,
    };
    writeFileSync(
      path.join(repoRoot, o.out),
      JSON.stringify(fixture, null, 2) + "\n",
    );
    console.log(
      `[${o.region}] alignment fixture: ${entries.length}역 · 미매칭 ${unmatched.length} · ` +
        `max delta ${fixture.maxDeltaPx}px → ${o.out}`,
    );
  } finally {
    cleanupPackDir(dir);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
