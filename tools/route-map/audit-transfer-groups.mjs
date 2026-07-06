#!/usr/bin/env node
// #1789: 환승 그룹 데이터 품질 감사 — 멤버 이격(spread)·분리/병합 의심을
// 기계 검출한다. 지도는 렌더 3모드로 방어하지만(스택/스팬/분리), 근본 원인
// (동명이역 오병합: 양평·신촌 / 별칭 중복: 김포공항역)은 카탈로그 수술이
// 필요하므로 리포트를 후속 이슈의 증거로 남긴다.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupPackDir, openPack, repoRoot } from "./pack-io.mjs";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** station_id별 (line,x,y) 묶음에서 2노선 이상 그룹의 최대 쌍거리. */
export function transferGroupSpreads(rows) {
  const byStation = new Map();
  for (const row of rows) {
    if (!byStation.has(row.station_id)) {
      byStation.set(row.station_id, []);
    }
    byStation.get(row.station_id).push(row);
  }
  const spreads = [];
  for (const [stationId, members] of byStation) {
    if (members.length < 2) {
      continue;
    }
    let spread = 0;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        spread = Math.max(spread, dist(members[i], members[j]));
      }
    }
    spreads.push({
      stationId,
      lineIds: members.map((m) => m.line_id).sort(),
      spread: Math.round(spread * 10) / 10,
    });
  }
  return spreads.sort((a, b) => b.spread - a.spread);
}

/** spread가 임계를 넘는 그룹 — 동명이역 오병합 또는 좌표 검수 대상. */
export function suspectSplitGroups(spreads, { threshold = 60 } = {}) {
  return spreads.filter((s) => s.spread > threshold);
}

const normalizeName = (name) => name.replace(/역$/, "");

/** 정규화 이름 동일 + 별개 station_id + 근접(<60) 쌍 — 병합 의심. */
export function suspectMergePairs(stations) {
  const byName = new Map();
  for (const s of stations) {
    const key = normalizeName(s.nameKo);
    if (!byName.has(key)) {
      byName.set(key, []);
    }
    byName.get(key).push(s);
  }
  const pairs = [];
  for (const group of byName.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (
          group[i].stationId !== group[j].stationId &&
          dist(group[i], group[j]) < 60
        ) {
          pairs.push({ a: group[i], b: group[j] });
        }
      }
    }
  }
  return pairs;
}

function parseArgs(argv) {
  const options = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    region: "수도권",
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": options.pack = argv[++i]; break;
      case "--region": options.region = argv[++i]; break;
      case "--json": options.json = argv[++i]; break;
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { db, dir } = openPack(options.pack, "audit-transfer-");
  try {
    const rows = db
      .prepare(
        "SELECT station_id, line_id, x, y FROM route_map_positions WHERE region = ?",
      )
      .all(options.region);
    const named = db
      .prepare(
        `SELECT p.station_id AS stationId, s.name_ko AS nameKo, p.x, p.y
         FROM route_map_positions p JOIN stations s ON s.id = p.station_id
         WHERE p.region = ?`,
      )
      .all(options.region);
    const spreads = transferGroupSpreads(rows);
    const splits = suspectSplitGroups(spreads);
    const merges = suspectMergePairs(named);
    console.log(`[${options.region}] 환승 그룹 ${spreads.length}`);
    console.log(`분리/좌표검수 의심(spread>60): ${splits.length}`);
    for (const s of splits) {
      const name = named.find((n) => n.stationId === s.stationId)?.nameKo ?? "?";
      console.log(`  ${name} ${s.stationId} spread=${s.spread} lines=${s.lineIds.join(",")}`);
    }
    console.log(`병합 의심(동명 근접 별개 id): ${merges.length}`);
    for (const p of merges) {
      console.log(`  ${p.a.nameKo}(${p.a.stationId}) ~ ${p.b.nameKo}(${p.b.stationId})`);
    }
    if (options.json) {
      writeFileSync(
        path.join(repoRoot, options.json),
        JSON.stringify({ region: options.region, spreads, splits, merges }, null, 2) + "\n",
      );
    }
  } finally {
    cleanupPackDir(dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
