#!/usr/bin/env node
// #1789 C3: 사용자 CSV(공식 노선도 검토 좌표, gitignored)에서 멤버수별 환승 스팬 p90을
// 집계한다. ⛔가드레일 5조: 좌표 미방출 — 집계 지표(스팬 p90)만 산출·커밋.
import { isMainModule } from "../lib/is-main-module.mjs";
import { readFileSync, writeFileSync } from "node:fs";

/** nearest-rank p90. */
function p90(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
}

/** groups=[{memberCount,span}] → {"2":p90,...}. */
export function computeSpanOracle(groups) {
  const byN = new Map();
  for (const g of groups) {
    if (!byN.has(g.memberCount)) byN.set(g.memberCount, []);
    byN.get(g.memberCount).push(g.span);
  }
  const out = {};
  for (const [n, spans] of byN) out[String(n)] = p90(spans);
  return out;
}

/** CSV 텍스트 → 행 배열. 실제 컬럼 순서는 --map으로 조정 가능(기본 station,line,x,y). */
export function parseReviewedCsv(text, cols = { station: 0, line: 1, x: 2, y: 3 }) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) { // 헤더 스킵
    const c = lines[i].split(",");
    if (c.length <= Math.max(cols.station, cols.line, cols.x, cols.y)) continue;
    rows.push({
      stationName: c[cols.station].trim(),
      lineId: c[cols.line].trim(),
      x: Number(c[cols.x]), y: Number(c[cols.y]),
    });
  }
  return rows;
}

/** 행 → 역명별 환승 그룹 {memberCount,span}. span=멤버 좌표 최대 쌍거리. */
export function rowsToGroups(rows) {
  const byStation = new Map();
  for (const r of rows) {
    if (!byStation.has(r.stationName)) byStation.set(r.stationName, []);
    byStation.get(r.stationName).push(r);
  }
  const groups = [];
  for (const members of byStation.values()) {
    const lines = new Set(members.map((m) => m.lineId));
    if (lines.size < 2) continue;
    let span = 0;
    for (let i = 0; i < members.length; i += 1)
      for (let j = i + 1; j < members.length; j += 1)
        span = Math.max(span, Math.hypot(members[i].x - members[j].x, members[i].y - members[j].y));
    groups.push({ memberCount: lines.size, span });
  }
  return groups;
}

function main() {
  const argv = process.argv.slice(2);
  let csv = null, out = "tools/route-map/oracle-transfer-spans.json";
  let cols = { station: 0, line: 1, x: 2, y: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--csv") csv = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--map") {
      const map = argv[++i].split(",").map(x => Number(x));
      cols = { station: map[0], line: map[1], x: map[2], y: map[3] };
    }
  }
  if (!csv) throw new Error("사용: --csv <경로> 필수 (gitignored CSV, 좌표 미커밋)");
  const rows = parseReviewedCsv(readFileSync(csv, "utf8"), cols);
  const oracle = computeSpanOracle(rowsToGroups(rows));
  writeFileSync(out, JSON.stringify({ artifactKind: "transfer-span-oracle", source: "reviewed-csv(집계만)", spanP90ByMemberCount: oracle }, null, 2) + "\n");
  console.log("오라클 스팬 p90:", JSON.stringify(oracle));
}

if (isMainModule(import.meta.url)) main();
