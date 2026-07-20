#!/usr/bin/env node
// #2068 부산 마감: 벡스코 환승 오분리 병합. 준지리형 소스가 한 물리 환승역의
// 노선들을 별개 station_id로 쪼갠 것을 단일 노드로 병합한다. 좌천 분리
// (split-mismerged-stations.mjs)와 대칭 구조 — 좌천은 1509px 이격한 별개 물리역을
// 나누고, 벡스코는 <60px 동일 물리역(2호선×동해선 환승)을 합친다.
//
// ⛔ 사실 확정은 오너(#2068 "실제로 환승역임, 이 이슈에서 처리")·공식 환승역 목록.
//   벡스코는 부산 2호선(코드 209)과 동해선이 같은 승강장 지하로 이어지는 공식
//   환승역이나, 소스가 2호선 벡스코(부역명 시립미술관)와 동해선 벡스코를 별도
//   station_id로 두어 카탈로그에서 환승 그룹이 형성되지 않았다. 그 결과 파이프라인
//   graph.clusters에 벡스코가 knot로 등록되지 않아, 두 노선이 벡스코에서 만나는
//   교차가 "자유 교차"로 분류됐다(busan-free-crossing-gate 참고). 병합으로 단일
//   station_id·2노선이 되면 knot로 등록돼 자유 교차가 사라진다.
//
// SMA(#1789)용 merge-oversplit-transfers.mjs의 MERGES는 수도권 전용 하드코딩이라
// 부산 항목을 혼입하지 않고 이 부산 전용 스크립트를 둔다. station-surgery.mjs의
// reparentLine/reparentStation 헬퍼를 직접 호출하며 수기 SQL을 쓰지 않는다.
//
// id 정책: 대표 id = 부역명(시립미술관)을 보유한 2호선 쪽 유지, 흡수 id(동해선)의
// 노선 멤버십·좌표·라우팅 노드를 대표로 재지정한 뒤 고아 stations 행을 삭제한다.
// 부역명은 병합 후 대표에 보존한다.
//
// 사용: node tools/route-map/merge-busan-transfers.mjs [--pack …] [--check]
import {
  mutatePack,
  parsePackArgs,
  reparentLine,
  reparentStation,
} from "./station-surgery.mjs";

/** 병합 대상. keepId=대표(부역명 보유 2호선), dropId=흡수(동해선). */
export const MERGES = [
  {
    name: "벡스코",
    keepId: "station-fbcc387e1db9", // 부산 2호선 벡스코(부역명 시립미술관)
    dropId: "station-6820d21cea02", // 부산 동해선 벡스코
    expectedSub: "시립미술관",
    expectedMembers: 2, // 병합 후 대표 멤버 수(2호선 + 동해선)
    evidence: "부산 2호선·동해선 환승역(시립미술관) — #2068 오너 확정",
  },
];

/** 순수: 병합 후 부역명 = 대표 우선, 없으면 흡수분. */
export function reconcileNameSub(keepSub, dropSub) {
  return keepSub || dropSub || "";
}

export function applyMerge(db, spec) {
  const keep = db.prepare("SELECT id, name_sub FROM stations WHERE id=?").get(spec.keepId);
  const drop = db.prepare("SELECT id, name_sub FROM stations WHERE id=?").get(spec.dropId);
  if (!keep) throw new Error(`${spec.name}: 대표 역 없음 ${spec.keepId}`);
  if (!drop) {
    // 이미 병합됨: 대표가 기대 부역명·멤버 수를 실제로 갖는지로 id 유효성을 확인하고
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
    .prepare("SELECT line_id FROM station_lines WHERE station_id=? ORDER BY line_id")
    .all(spec.dropId)
    .map((r) => r.line_id);
  if (dropLines.length === 0) {
    throw new Error(`${spec.name}: 흡수 역 ${spec.dropId}에 노선 멤버십이 없음`);
  }
  for (const lineId of dropLines) {
    reparentLine(db, { fromStationId: spec.dropId, toStationId: spec.keepId, lineId, label: spec.name });
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
  db.prepare("DELETE FROM stations WHERE id=?").run(spec.dropId);
  const memberCount = db
    .prepare("SELECT COUNT(*) c FROM station_lines WHERE station_id=?")
    .get(spec.keepId).c;
  if (spec.expectedMembers && memberCount !== spec.expectedMembers) {
    throw new Error(
      `${spec.name}: 병합 후 멤버 수가 기대와 다름 (${memberCount} ≠ ${spec.expectedMembers}) — 소스 확인 필요`,
    );
  }
  return { name: spec.name, keepId: spec.keepId, dropId: spec.dropId, mergedSub, memberCount };
}

function main() {
  const o = parsePackArgs(process.argv.slice(2));
  mutatePack({ ...o, tmpPrefix: "merge-busan-", run: (db) => {
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
