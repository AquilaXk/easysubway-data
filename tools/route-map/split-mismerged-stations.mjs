#!/usr/bin/env node
// #1789 Phase 0 (P0.1a): 환승 오병합 분리 — 한 station_id에 잘못 묶인 별개
// 동명이역을 별도 역으로 분리한다. 준지리형 base는 지리적으로 붙은 동명이역을
// 하나로 병합해 환승처럼 렌더했으나(신촌 108px·양평 382px spread), 공식 역
// 목록상 이들은 환승이 아닌 별개 역이다.
//
// ⛔ 사실 확정은 공식 출처(서울열린데이터광장 역 목록), CSV 스팬은 탐지 힌트만.
//   - 신촌: 2호선 신촌(코드 240, 서대문구) ↔ 경의중앙 신촌(P312, 마포구) = 별개역
//   - 양평: 5호선 양평(코드 522, 영등포구) ↔ 경의중앙 양평(K135, 양평군) = 동명이역
//
// #2068 부산: 좌천과 동래는 도시철도 환승군과 동해선의 서로 다른 물리역이 단일
// station_id로 오병합됐다. 오너 자작 도식은 각 실체를 별도 노드·라벨로 그리므로
// 동해선 멤버만 신규 id로 분리한다.
//
// id 정책(파급 대비 — station_id는 즐겨찾기·경로계획·시간표(#1415)·datapack(#1690)
// 참조): 원 id는 승객 많은 도심 노선(2호선·5호선)에 유지, 경의중앙 쪽을 신규 id로
// 발급. route_map_positions·station_lines의 경의중앙 행만 신규 id로 재지정한다.
//
// 사용: node tools/route-map/split-mismerged-stations.mjs [--pack …] [--check]
import { isMainModule } from "../lib/is-main-module.mjs";
import { createHash } from "node:crypto";
import {
  mutatePack,
  parsePackArgs,
  reparentLine,
  rehomeLineNode,
} from "./station-surgery.mjs";

const REGION = "수도권";
const GYEONGUI = "line-6e39be0cb6e2"; // 수도권 경의중앙 — 분리 시 떼어낼 쪽
const BUSAN_DONGHAE = "line-f52eb59d8497"; // 부산 동해 — 좌천 분리 시 떼어낼 쪽

/** 분리 대상(공식 근거 첨부). moveLineId = 원 id에서 떼어 신규 id로 옮길 노선. */
export const SPLITS = [
  {
    name: "신촌",
    stationId: "station-4e123a19a88f",
    moveLineId: GYEONGUI,
    keepEvidence: "2호선 신촌 240(서대문구)",
    moveEvidence: "경의중앙 신촌 P312(마포구)",
  },
  {
    name: "양평",
    stationId: "station-d5909895c7d7",
    moveLineId: GYEONGUI,
    keepEvidence: "5호선 양평 522(영등포구)",
    moveEvidence: "경의중앙 양평 K135(양평군)",
  },
  {
    // 유지=승객 많은 도시철도 1호선, 분리=동해선(광역전철).
    name: "좌천",
    stationId: "station-d7f9228b4b73",
    moveLineId: BUSAN_DONGHAE,
    keepEvidence: "부산 1호선 좌천 22",
    moveEvidence: "동해선 좌천 16",
  },
  {
    name: "동래",
    stationId: "station-dbfe9e072d98",
    moveLineId: BUSAN_DONGHAE,
    keepEvidence: "부산 1호선 125·4호선 402 환승역 동래",
    moveEvidence: "동해선 동래 K115",
  },
];

/** 원 id·이동 노선에 대한 결정적 신규 station id(재현·테스트 가능). */
export function newStationId(originalId, moveLineId) {
  const hex = createHash("sha256")
    .update(`split:${originalId}:${moveLineId}`)
    .digest("hex");
  return `station-${hex.slice(0, 12)}`;
}

/**
 * 순수: 원 역 행 + 떼어낼 노선 → 분리 계획.
 * `newStation`은 원 메타를 보존한 신규 id 역, `reassignment`은 이동 노선 행의
 * station_id 재지정 지시(route_map_positions·station_lines 공통).
 */
export function planSplit(station, moveLineId) {
  const newStation = { ...station, id: newStationId(station.id, moveLineId) };
  return {
    newStation,
    reassignment: {
      lineId: moveLineId,
      fromStationId: station.id,
      toStationId: newStation.id,
    },
  };
}

function applySplit(db, spec) {
  const station = db
    .prepare("SELECT * FROM stations WHERE id=?")
    .get(spec.stationId);
  if (!station) throw new Error(`${spec.name}: 역 없음 ${spec.stationId}`);
  const { newStation, reassignment } = planSplit(station, spec.moveLineId);
  // 멤버십 검사보다 먼저: 이미 분리됐으면(신규 id 존재) 멤버십은 이미 원 id에서
  // 빠졌으므로 아래 검사가 오히려 throw한다. 이 경우 이동 노선의 잔여 라우팅 노드가
  // 원 id를 계속 가리키면 신규 id로 재지정하고 종료한다(network_edges 정합).
  const exists = db.prepare("SELECT 1 FROM stations WHERE id=?").get(newStation.id);
  if (exists) {
    rehomeLineNode(db, spec.stationId, newStation.id, spec.moveLineId);
    return { name: spec.name, skipped: "이미 분리됨(엣지 정합 확인)", newId: newStation.id };
  }
  const members = db
    .prepare(
      "SELECT line_id FROM station_lines WHERE station_id=? ORDER BY line_id",
    )
    .all(spec.stationId)
    .map((r) => r.line_id);
  if (!members.includes(spec.moveLineId)) {
    throw new Error(
      `${spec.name}: 이동 노선 ${spec.moveLineId} 멤버 아님 (현재 ${members.join(",")})`,
    );
  }
  if (members.length < 2) {
    throw new Error(`${spec.name}: 분리하려면 노선 2개 이상 필요`);
  }
  // 신규 역 행 삽입(원 메타 보존) 후, 이동 노선의 위상·좌표를 신규 id로 재지정.
  const cols = Object.keys(newStation);
  db.prepare(
    `INSERT INTO stations (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...cols.map((c) => newStation[c]));
  reparentLine(db, { ...reassignment, label: spec.name });
  return {
    name: spec.name,
    keepId: spec.stationId,
    keep: spec.keepEvidence,
    newId: newStation.id,
    moved: spec.moveEvidence,
  };
}

function main() {
  const o = parsePackArgs(process.argv.slice(2));
  mutatePack({ ...o, tmpPrefix: "split-mismerged-", run: (db) => {
    if (o.check) {
      for (const spec of SPLITS) {
        const spreadRow = db
          .prepare("SELECT COUNT(*) c FROM station_lines WHERE station_id=?")
          .get(spec.stationId);
        console.log(
          `(--check) ${spec.name} ${spec.stationId}: 노선 ${spreadRow.c}개 → 신규 id ${newStationId(spec.stationId, spec.moveLineId)} 예정 (유지=${spec.keepEvidence} / 분리=${spec.moveEvidence})`,
        );
      }
      return;
    }
    db.exec("BEGIN");
    const results = SPLITS.map((spec) => applySplit(db, spec));
    db.exec("COMMIT");
    for (const r of results) {
      if (r.skipped) {
        console.log(`${r.name}: ${r.skipped} (${r.newId})`);
      } else {
        console.log(`${r.name}: 유지 ${r.keepId}(${r.keep}) · 분리 ${r.newId}(${r.moved})`);
      }
    }
  } });
}

if (isMainModule(import.meta.url)) {
  main();
}
