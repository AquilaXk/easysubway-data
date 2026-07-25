import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseMolitLineOperatorRosters } from "./build-molit-nationwide-fixture.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const MOLIT_ROSTER_PATH = "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv";
const ROUTE_MAP_DOMAIN = "route_map_positions";

// MOLIT 원본과 admitted snapshot은 같은 역을 다른 표기로 싣는다(부역명 병기, 역 접미사).
// 판정 대상은 역 집합의 포함 관계뿐이므로 표기 차이만 제거하고 비교한다.
function normalizeStationName(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/\([^)]*\)/gu, "")
    .replace(/[·.\s]/gu, "")
    .replace(/역$/u, "")
    .trim();
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function scopeKey({ regionId, operatorId, lineId }) {
  return `${regionId}:${operatorId}:${lineId}`;
}

// coverageScope에 운영기관을 2개 이상 등재한 route_map_positions 소스(#2499·#2508 dual coverage)만 감사한다.
// 전 도메인 containment 게이트는 역명 별칭 사전이 따로 필요해 이 회귀의 범위 밖이다.
async function auditableDualOperatorSources(inventory) {
  const sources = [];
  for (const source of inventory.sources) {
    const scope = source.coverageScope;
    if (!scope?.sourceDomains?.includes(ROUTE_MAP_DOMAIN) || (scope.operatorIds ?? []).length < 2) {
      continue;
    }
    const snapshotPath = source.routeMapAdmissionEvidence?.snapshotPath;
    assert.ok(
      snapshotPath,
      `${source.id}: dual-operator route_map_positions 소스는 routeMapAdmissionEvidence.snapshotPath가 필요하다`,
    );
    sources.push({ id: source.id, scope, snapshotPath });
  }
  return sources;
}

// 같은 scope를 여러 소스가 나눠 커버할 수 있으므로(예: 9호선 1단계 + 2·3단계) snapshot 역 집합을 합집합으로 모은다.
async function snapshotStationNamesByScope(inventory) {
  const namesByScope = new Map();
  for (const source of inventory.sources) {
    const scope = source.coverageScope;
    const snapshotPath = source.routeMapAdmissionEvidence?.snapshotPath;
    if (!scope?.sourceDomains?.includes(ROUTE_MAP_DOMAIN) || !snapshotPath) {
      continue;
    }
    const snapshot = await readJson(snapshotPath);
    for (const regionId of scope.regionIds ?? []) {
      for (const operatorId of scope.operatorIds ?? []) {
        for (const lineId of scope.lineIds ?? []) {
          const key = scopeKey({ regionId, operatorId, lineId });
          const names = namesByScope.get(key) ?? { sourceIds: [], stationNames: new Set() };
          names.sourceIds.push(source.id);
          for (const position of snapshot.positions ?? []) {
            if (position.lineId === lineId) {
              names.stationNames.add(normalizeStationName(position.stationName));
            }
          }
          namesByScope.set(key, names);
        }
      }
    }
  }
  return namesByScope;
}

test("route_map_positions dual-operator coverageScope는 MOLIT roster ⊆ snapshot 역 집합을 유지한다 (#2508)", async () => {
  const [inventory, targets, molitCsvBytes] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/nationwide-coverage-targets.json"),
    readFile(path.join(root, MOLIT_ROSTER_PATH)),
  ]);
  const rosters = parseMolitLineOperatorRosters(molitCsvBytes);
  const activeScopeKeys = new Set(targets.activeLineScopes.map(scopeKey));
  const dualOperatorSources = await auditableDualOperatorSources(inventory);
  const namesByScope = await snapshotStationNamesByScope(inventory);

  assert.ok(dualOperatorSources.length > 0, "dual-operator route_map_positions 소스가 하나도 없다");

  const audited = [];
  for (const source of dualOperatorSources) {
    for (const regionId of source.scope.regionIds) {
      for (const operatorId of source.scope.operatorIds) {
        for (const lineId of source.scope.lineIds ?? []) {
          const key = scopeKey({ regionId, operatorId, lineId });
          // activeLineScopes에 없는 (operator, line) 조합은 #2138 requirement가 아니라 lineage 표기다.
          if (!activeScopeKeys.has(key) || audited.includes(key)) {
            continue;
          }
          const roster = rosters.get(key);
          assert.ok(roster, `${key}: MOLIT roster가 없다`);
          const covered = namesByScope.get(key).stationNames;
          const missing = [...new Set(roster.stationNames.map(normalizeStationName))]
            .filter((stationName) => !covered.has(stationName))
            .sort();
          assert.deepEqual(
            missing,
            [],
            `${key} (${roster.operatorName}): admitted snapshot [${namesByScope.get(key).sourceIds.join(", ")}]에 없는 역 ${missing.join(", ")}`,
          );
          audited.push(key);
        }
      }
    }
  }

  // #2508에서 보정한 3건과 #2499 선례 1건 + 기존 단독 operator 3건이 dual-operator 소스에 묶여 있다.
  assert.deepEqual(audited.sort(), [
    "capital:korail:line-051552e50435",
    "capital:operator-28e01fb8509d:shinbundang",
    "capital:operator-38450e138464:line-051552e50435",
    "capital:operator-5ca780d7dee1:line-8604048b6430",
    "capital:operator-936e454d0bfb:line-f0e747248a31",
    "capital:operator-9e999d4aa596:line-8604048b6430",
  ]);
});
