#!/usr/bin/env node
// #1789 Phase 0 (P0.1b 확장): 부역명에 가려졌던 환승역 오분리 병합. 준지리형
// 소스가 한 물리 환승역의 노선들을 별도 station_id로 쪼갰는데, 한쪽만 부역명이
// 붙어 name_ko가 달라 audit(동명 근접)가 못 잡았다. P0.2가 부역명을 name_sub로
// 떼어내며 두 id의 name_ko가 같아져 노출됐다. 전부 공식 환승역(같은 물리역)이라
// 단일 노드로 병합한다.
//
// ⛔ 사실 확정은 공식 출처(서울열린데이터광장 환승역 목록). audit 병합의심은
//   탐지 힌트. 신촌·양평(108/382px 별개역)과 달리 이들은 <60px 동일역.
//
// id 정책: 대표 id = 노선 많은 쪽(동수면 번호 호선 우선) 유지, 흡수 id의 노선
// 멤버십을 대표로 재지정 후 고아 삭제. 부역명은 병합 후 대표에 보존
// (대표가 비면 흡수분에서 가져옴).
//
// 사용: node tools/route-map/merge-oversplit-transfers.mjs [--pack …] [--check]
import {
  mutatePack,
  parsePackArgs,
  reparentLine,
  reparentStation,
} from "./station-surgery.mjs";
import { planMerge } from "./merge-alias-stations.mjs";

/** 병합 대상. keepId=대표(노선 많은/번호 호선), dropId=흡수, expectedSub=병합 후 부역명. */
export const MERGES = [
  { name: "온수", keepId: "station-0fe1a97dd89c", dropId: "station-8a825f7102fc", expectedSub: "성공회대입구", evidence: "1호선·7호선 환승역(성공회대입구)" },
  { name: "별내", keepId: "station-6f6328bd8ba0", dropId: "station-8dbfb267f86a", expectedSub: "삼육대학교", evidence: "8호선·경춘선 환승역(삼육대학교)" },
  { name: "복정", keepId: "station-0da713fa586e", dropId: "station-b0d79168d9e1", expectedSub: "동서울대학", evidence: "8호선·수인분당선 환승역(동서울대학)" },
  { name: "성신여대입구", keepId: "station-d490bb686722", dropId: "station-768d93d8b4c1", expectedSub: "돈암", evidence: "4호선·우이신설선 환승역(돈암)" },
  { name: "종로3가", keepId: "station-1c24eb757f3c", dropId: "station-839e725421e8", expectedSub: "탑골공원", evidence: "1·3·5호선 환승역(탑골공원)" },
  { name: "청량리", keepId: "station-b819702fa7d9", dropId: "station-b3a9b7ff1478", expectedSub: "서울시립대입구", evidence: "1호선·경의중앙·경춘·수인분당 환승역(서울시립대입구)" },
  { name: "이촌", keepId: "station-b90e3daa23a1", dropId: "station-bef6478fc602", expectedSub: "국립중앙박물관", evidence: "4호선·경의중앙 환승역(국립중앙박물관)" },
  { name: "상봉", keepId: "station-83bcb1eae340", dropId: "station-f4a450b35d91", expectedSub: "시외버스터미널", evidence: "서울교통공사 공식 노선도 data-uid 2722(7호선·경의중앙·경춘 환승)" },
  { name: "석남", keepId: "station-57db2f1fb4f6", dropId: "station-37866f28b417", expectedSub: "거북시장", evidence: "인천교통공사 공식 7호선↔인천2호선 환승 지도" },
  { name: "이매", keepId: "station-ea48bd3f46f2", dropId: "station-7423a5270c95", expectedSub: "성남아트센터", evidence: "서울교통공사 공식 노선도 data-uid 1860(수인분당·경강 환승)" },
];

/** 순수: 병합 후 부역명 = 대표 우선, 없으면 흡수분. */
export function reconcileNameSub(keepSub, dropSub) {
  return keepSub || dropSub || "";
}

function applyMerge(db, spec) {
  const keep = db.prepare("SELECT id, name_sub FROM stations WHERE id=?").get(spec.keepId);
  const drop = db.prepare("SELECT id, name_sub FROM stations WHERE id=?").get(spec.dropId);
  if (!keep) throw new Error(`${spec.name}: 대표 역 없음 ${spec.keepId}`);
  if (!drop) {
    // 이미 병합됨: 대표가 기대 부역명을 실제로 보유하는지로 id 유효성을 확인하고
    // (오타/드리프트한 dropId를 완료된 병합과 구분), 흡수 역의 잔여 라우팅 노드가
    // 남아 있으면 대표로 재지정한다(network_edges 정합, idempotent 복구).
    if (spec.expectedSub && keep.name_sub !== spec.expectedSub) {
      throw new Error(
        `${spec.name}: 이미 병합됐다고 보기엔 대표 부역명이 기대와 다름 ("${keep.name_sub}" ≠ "${spec.expectedSub}") — id 확인 필요`,
      );
    }
    reparentStation(db, { fromStationId: spec.dropId, toStationId: spec.keepId });
    return { name: spec.name, skipped: "이미 병합됨(엣지 정합 확인)" };
  }
  const dropLines = db
    .prepare("SELECT * FROM station_lines WHERE station_id=? ORDER BY line_id")
    .all(spec.dropId);
  const plan = planMerge(spec.dropId, dropLines.map((r) => r.line_id), spec.keepId);
  for (const r of plan.reassignments) {
    reparentLine(db, { ...r, label: spec.name });
  }
  reparentStation(db, { fromStationId: spec.dropId, toStationId: spec.keepId });
  // 부역명 보존 + 기대값 검증(하드코딩 불변식 강제)
  const mergedSub = reconcileNameSub(keep.name_sub, drop.name_sub);
  if (spec.expectedSub && mergedSub !== spec.expectedSub) {
    throw new Error(
      `${spec.name}: 병합 부역명이 기대와 다름 ("${mergedSub}" ≠ "${spec.expectedSub}") — 소스 확인 필요`,
    );
  }
  db.prepare("UPDATE stations SET name_sub=? WHERE id=?").run(mergedSub, spec.keepId);
  db.prepare("DELETE FROM stations WHERE id=?").run(plan.deleteStationId);
  const memberCount = db
    .prepare("SELECT COUNT(*) c FROM station_lines WHERE station_id=?")
    .get(spec.keepId).c;
  return { name: spec.name, keepId: spec.keepId, dropId: spec.dropId, mergedSub, memberCount };
}

function main() {
  const o = parsePackArgs(process.argv.slice(2));
  mutatePack({ ...o, tmpPrefix: "merge-oversplit-", run: (db) => {
    if (o.check) {
      for (const spec of MERGES) {
        const drop = db.prepare("SELECT name_ko FROM stations WHERE id=?").get(spec.dropId);
        console.log(`(--check) ${spec.name}: ${spec.dropId}(${drop?.name_ko ?? "없음"}) → ${spec.keepId} · 부역명 ${spec.expectedSub} (${spec.evidence})`);
      }
      return;
    }
    db.exec("BEGIN");
    const results = MERGES.map((spec) => applyMerge(db, spec));
    db.exec("COMMIT");
    for (const r of results) {
      if (r.skipped) console.log(`${r.name}: ${r.skipped}`);
      else console.log(`${r.name}: ${r.dropId} → ${r.keepId} · 멤버 ${r.memberCount} · 부역명 "${r.mergedSub}"`);
    }
  } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
