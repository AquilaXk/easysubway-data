#!/usr/bin/env node
// #1789 Phase 0 (P0.1b): 오분리 별칭 병합 — 실제로는 한 물리역(환승)이 별도
// station_id("…역" 접미 별칭)로 잘못 나뉜 것을 대표 역의 환승 그룹에 병합한다.
// 서해선 개통 데이터가 기존 환승역과 이어지지 못하고 별칭 역으로 남은 사례.
//
// ⛔ 사실 확정은 공식 출처(서울열린데이터광장 역 목록). audit-transfer-groups의
//   병합 의심(동명 정규화·근접·별개 id)은 탐지 힌트. 수도권 전 노선 전수에서
//   "…역" 접미 별칭 오분리는 아래 2건뿐이다.
//   - 김포공항: 서해선 "김포공항역" → 공항철도·5·9·김포골드 환승 그룹(대표)
//   - 부천종합운동장: 서해선 "부천종합운동장역" → 7호선 환승 그룹(대표)
//
// id 정책: 대표 id 유지, 별칭 id의 station_lines·route_map_positions 행을 대표
// id로 재지정 후 고아 별칭 stations 행 삭제. 병합 후 환승 그룹 멤버 수가 공식과
// 일치해야 한다(김포공항 5개).
//
// 사용: node tools/route-map/merge-alias-stations.mjs [--pack …] [--check]
import {
  mutatePack,
  parsePackArgs,
  reparentLine,
  reparentStation,
} from "./station-surgery.mjs";

/** 병합 대상(공식 근거 첨부). aliasId를 representativeId 그룹으로 흡수. */
export const MERGES = [
  {
    name: "김포공항",
    aliasId: "station-cbe94ebaafe2", // "김포공항역"(서해선)
    representativeId: "station-1f38f0831cb1", // "김포공항"(공항·5·9·김포골드)
    expectedMembers: 5, // 병합 후 대표 환승 그룹 멤버 수(공식)
    evidence: "서해선 김포공항역 = 공항철도·5·9·김포골드 환승과 동일 물리역(멤버 5)",
  },
  {
    name: "부천종합운동장",
    aliasId: "station-bf7791ea1bfd", // "부천종합운동장역"(서해선)
    representativeId: "station-28be6a80c00e", // "부천종합운동장"(7호선)
    expectedMembers: 2, // 서해선 흡수 후 7호선+서해선
    evidence: "서해선 부천종합운동장역 = 7호선 환승과 동일 물리역(멤버 2)",
  },
];

/**
 * 순수: 별칭 id·그 노선 목록·대표 id → 병합 계획.
 * 각 노선 멤버십 행을 대표 id로 재지정(route_map_positions·station_lines 공통)
 * 하고, 흡수된 뒤 남는 별칭 stations 행을 삭제한다.
 */
export function planMerge(aliasId, aliasLineIds, representativeId) {
  return {
    deleteStationId: aliasId,
    reassignments: aliasLineIds.map((lineId) => ({
      lineId,
      fromStationId: aliasId,
      toStationId: representativeId,
    })),
  };
}

function applyMerge(db, spec) {
  const alias = db.prepare("SELECT id FROM stations WHERE id=?").get(spec.aliasId);
  const rep = db.prepare("SELECT id FROM stations WHERE id=?").get(spec.representativeId);
  if (!rep) throw new Error(`${spec.name}: 대표 역 없음 ${spec.representativeId}`);
  if (!alias) {
    // 이미 병합됨: 대표 멤버 수가 기대와 맞는지로 id 유효성을 확인하고(오타/드리프트한
    // aliasId를 완료된 병합과 구분), 별칭의 잔여 라우팅 노드를 대표로 재지정한다
    // (network_edges 정합, idempotent 복구).
    const current = db
      .prepare("SELECT COUNT(*) c FROM station_lines WHERE station_id=?")
      .get(spec.representativeId).c;
    if (spec.expectedMembers && current !== spec.expectedMembers) {
      throw new Error(
        `${spec.name}: 이미 병합됐다고 보기엔 대표 멤버 수가 기대와 다름 (${current} ≠ ${spec.expectedMembers}) — id 확인 필요`,
      );
    }
    reparentStation(db, { fromStationId: spec.aliasId, toStationId: spec.representativeId });
    return { name: spec.name, skipped: "이미 병합됨(엣지 정합 확인)" };
  }
  const aliasLines = db
    .prepare("SELECT * FROM station_lines WHERE station_id=? ORDER BY line_id")
    .all(spec.aliasId);
  const plan = planMerge(
    spec.aliasId,
    aliasLines.map((r) => r.line_id),
    spec.representativeId,
  );
  for (const r of plan.reassignments) {
    reparentLine(db, { ...r, label: spec.name });
  }
  reparentStation(db, { fromStationId: spec.aliasId, toStationId: spec.representativeId });
  db.prepare("DELETE FROM stations WHERE id=?").run(plan.deleteStationId);
  const memberCount = db
    .prepare("SELECT COUNT(*) c FROM station_lines WHERE station_id=?")
    .get(spec.representativeId).c;
  if (spec.expectedMembers && memberCount !== spec.expectedMembers) {
    throw new Error(
      `${spec.name}: 병합 후 멤버 수가 기대와 다름 (${memberCount} ≠ ${spec.expectedMembers}) — 소스 확인 필요`,
    );
  }
  return {
    name: spec.name,
    representativeId: spec.representativeId,
    merged: spec.aliasId,
    lines: plan.reassignments.map((r) => r.lineId),
    memberCount,
    evidence: spec.evidence,
  };
}

function main() {
  const o = parsePackArgs(process.argv.slice(2));
  mutatePack({ ...o, tmpPrefix: "merge-alias-", run: (db) => {
    if (o.check) {
      for (const spec of MERGES) {
        const alias = db.prepare("SELECT name_ko FROM stations WHERE id=?").get(spec.aliasId);
        console.log(
          `(--check) ${spec.name}: 별칭 ${spec.aliasId}(${alias?.name_ko ?? "없음"}) → 대표 ${spec.representativeId} (${spec.evidence})`,
        );
      }
      return;
    }
    db.exec("BEGIN");
    const results = MERGES.map((spec) => applyMerge(db, spec));
    db.exec("COMMIT");
    for (const r of results) {
      if (r.skipped) {
        console.log(`${r.name}: ${r.skipped}`);
      } else {
        console.log(
          `${r.name}: ${r.merged} → ${r.representativeId} · 노선 ${r.lines.join(",")} · 멤버 ${r.memberCount} (${r.evidence})`,
        );
      }
    }
  } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
