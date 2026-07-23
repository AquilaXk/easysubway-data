#!/usr/bin/env node
// #1789: 환승 그룹 데이터 품질 감사 — 멤버 이격(spread)·분리/병합 의심을
// 기계 검출한다. 지도는 렌더 3모드로 방어하지만(스택/스팬/분리), 근본 원인
// (동명이역 오병합: 양평·신촌 / 별칭 중복: 김포공항역)은 카탈로그 수술이
// 필요하므로 리포트를 후속 이슈의 증거로 남긴다.
import { isMainModule } from "../lib/is-main-module.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupPackDir, openPack, repoRoot } from "./pack-io.mjs";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const compareStrings = (a, b) => a.localeCompare(b, "en");

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
      lineIds: members.map((m) => m.line_id).sort(compareStrings),
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
      byName.set(key, new Map());
    }
    if (!byName.get(key).has(s.stationId)) byName.get(key).set(s.stationId, s);
  }
  const pairs = [];
  for (const entries of byName.values()) {
    const group = [...entries.values()];
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

export function loadCanonicalStationDecisions(
  file = path.join(repoRoot, "tools/route-map/canonical-station-decisions.json"),
) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function canonicalStationIdentityViolations({ stations, aliases, decisions }) {
  const byName = indexStationsByName(stations);
  const byDecision = new Map(decisions.map((decision) => [decision.normalizedName, decision]));
  const aliasTargets = indexAliasTargets(aliases);
  const violations = missingDecisionViolations(byName, byDecision);

  for (const decision of decisions) {
    appendDecisionViolations(violations, decision, byName, aliasTargets);
  }
  return violations;
}

function indexStationsByName(stations) {
  const byName = new Map();
  for (const row of stations) {
    if (!byName.has(row.normalizedName)) byName.set(row.normalizedName, new Map());
    const byId = byName.get(row.normalizedName);
    if (!byId.has(row.stationId)) byId.set(row.stationId, new Set());
    byId.get(row.stationId).add(row.lineId);
  }
  return byName;
}

function indexAliasTargets(aliases) {
  const aliasTargets = new Map();
  for (const row of aliases) {
    if (!aliasTargets.has(row.alias)) aliasTargets.set(row.alias, new Set());
    aliasTargets.get(row.alias).add(row.stationId);
  }
  return aliasTargets;
}

function missingDecisionViolations(byName, byDecision) {
  const violations = [];
  for (const [name, byId] of byName) {
    if (byId.size > 1 && !byDecision.has(name)) {
      violations.push(`${name}: MISSING_EVIDENCE (canonical station ${byId.size}개)`);
    }
  }
  return violations;
}

function appendDecisionViolations(violations, decision, byName, aliasTargets) {
  const { normalizedName: name, status } = decision;
  if (!["MERGE_CONFIRMED", "DISTINCT_CONFIRMED", "MISSING_EVIDENCE"].includes(status)) {
    violations.push(`${name}: 알 수 없는 판정 ${status}`);
    return;
  }
  if (status === "MISSING_EVIDENCE" || !isReviewedDecision(decision)) {
    violations.push(`${name}: MISSING_EVIDENCE`);
    return;
  }
  const byId = byName.get(name) ?? new Map();
  if (status === "MERGE_CONFIRMED") {
    appendMergeViolations(violations, decision, byId, aliasTargets);
    return;
  }
  appendDistinctViolations(violations, decision, byId);
}

function appendMergeViolations(violations, decision, byId, aliasTargets) {
  const name = decision.normalizedName;
  if (byId.size !== 1 || !byId.has(decision.canonicalStationId)) {
    violations.push(`${name}: MERGE_CONFIRMED인데 canonical station이 ${byId.size}개입니다`);
    return;
  }
  appendLineViolation(violations, name, decision.canonicalStationId, byId.get(decision.canonicalStationId), decision.expectedLineIds);
  for (const absorbedId of decision.absorbedStationIds ?? []) {
    const targets = aliasTargets.get(absorbedId) ?? new Set();
    if (targets.size !== 1 || !targets.has(decision.canonicalStationId)) {
      violations.push(`${name}: 흡수 ID alias ${absorbedId} → ${decision.canonicalStationId}가 없습니다`);
    }
  }
}

function appendDistinctViolations(violations, decision, byId) {
  const name = decision.normalizedName;
  const expectedStationIds = Object.keys(decision.stationLines ?? {}).sort(compareStrings);
  const actualStationIds = [...byId.keys()].sort(compareStrings);
  if (JSON.stringify(actualStationIds) !== JSON.stringify(expectedStationIds)) {
    violations.push(`${name}: DISTINCT_CONFIRMED station ID 집합이 기대와 다릅니다 (${actualStationIds.join(",")})`);
  }
  for (const [stationId, expectedLines] of Object.entries(decision.stationLines ?? {})) {
    if (!byId.has(stationId)) {
      violations.push(`${name}: DISTINCT_CONFIRMED station ${stationId}가 없습니다`);
    } else {
      appendLineViolation(violations, name, stationId, byId.get(stationId), expectedLines);
    }
  }
}

export function canonicalStationViolationsForRegion({
  contract,
  region,
  stations,
  aliases,
}) {
  if (contract.region !== region) return [];
  const controlDecisions = contract.controls.map((control) => ({
    ...control,
    status: "MERGE_CONFIRMED",
    absorbedStationIds: [],
    reviewedAt: contract.reviewedAt,
    reason: "회귀 control",
  }));
  return canonicalStationIdentityViolations({
    stations,
    aliases,
    decisions: [...contract.decisions, ...controlDecisions],
  });
}

function isReviewedDecision(decision) {
  return (decision.evidenceUrl ?? "").startsWith("https://") &&
    /^\d{4}-\d{2}-\d{2}$/.test(decision.reviewedAt ?? "") &&
    Boolean(decision.reason?.trim());
}

function appendLineViolation(violations, name, stationId, actual, expected) {
  const actualLines = [...(actual ?? [])].sort(compareStrings);
  const expectedLines = [...(expected ?? [])].sort(compareStrings);
  if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
    violations.push(`${name}: ${stationId} 노선이 기대와 다릅니다 (${actualLines.join(",")})`);
  }
}

function parseArgs(argv) {
  const options = {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    region: "수도권",
    json: null,
    strict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--pack": options.pack = argv[++i]; break;
      case "--region": options.region = argv[++i]; break;
      case "--json": options.json = argv[++i]; break;
      case "--strict": options.strict = true; break;
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
    const contract = loadCanonicalStationDecisions();
    const identityRows = db.prepare(
      `SELECT s.normalized_name AS normalizedName, s.id AS stationId, sl.line_id AS lineId
       FROM stations s JOIN station_lines sl ON sl.station_id=s.id
       WHERE s.region=? ORDER BY s.normalized_name, s.id, sl.line_id`,
    ).all(options.region);
    const aliases = db.prepare("SELECT station_id AS stationId, alias FROM station_aliases").all();
    const identityViolations = canonicalStationViolationsForRegion({
      contract,
      region: options.region,
      stations: identityRows,
      aliases,
    });
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
    console.log(`canonical station strict 위반: ${identityViolations.length}`);
    for (const violation of identityViolations) console.log(`  ${violation}`);
    if (options.json) {
      writeFileSync(
        path.join(repoRoot, options.json),
        JSON.stringify({ region: options.region, spreads, splits, merges, identityViolations }, null, 2) + "\n",
      );
    }
    if (options.strict && identityViolations.length > 0) process.exitCode = 1;
  } finally {
    cleanupPackDir(dir);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
