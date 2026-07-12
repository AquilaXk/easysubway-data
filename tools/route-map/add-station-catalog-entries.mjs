#!/usr/bin/env node
// #1954: 역 카탈로그 신설·개명 반영 — 수도권 신설 4역(인천1호선 검단연장 3역 +
// 서해선 원종)과 에버라인 개명 1건(운동장.송담대→용인중앙시장)을 capital 팩에
// 직접 반영한다. merge/split 수술 도구(#1789)와 같은 station-surgery 패턴.
//
// ⛔ 사실 확정은 공식 출처.
//  - 인천1호선 검단연장(2025-06-28 개통, 인천광역시 공식 보도자료·도시철도건설본부):
//    계양 → 아라 → 신검단중앙 → 검단호수공원(종점), 개통 후 인천1호선 총 33역.
//    ※ 이슈 #1954 대조표는 아라를 인천2호선으로 추정했으나 공식 확인 결과
//    3역 모두 인천1호선 검단연장이다 — 인천2호선은 변경하지 않는다.
//  - 서해선 원종: 국가철도공단 도시광역철도 역사정보 2026-06-30 파일
//    (admitted 소스 kric-metropolitan-rail-station-info) 역번호 1981,
//    위도 37.5240628 경도 126.8048386. molit-urban-rail-full-route 순번표도
//    김포공항(7)과 부천종합운동장(9) 사이 8번을 비워 두고 있다.
//  - 에버라인 개명: 같은 KRIC 파일이 Y120을 "용인중앙시장(용인예술과학대)"로
//    표기(역명 개정 반영분). 구명 "운동장.송담대"는 station_aliases로 유지한다.
//
// 좌표 provenance: 검단연장 3역은 admitted 소스(KRIC 2026-06-30 파일·MOLIT
// 2025-12-11 스냅샷) 어디에도 아직 없다(국가 등록 데이터 지연). 날조 금지
// 원칙에 따라 좌표는 NULL, 품질 표기는 LEVEL_1/OPERATOR_PAGE로 낮춰 남기고,
// line_sequence는 공식 개통 순서를 계양(11) 바로 앞 8·9·10에 인접 배치한다.
// 도식 좌표(route_map_positions)는 #1950 수도권 정본 도식이 이어받는다.
//
// 발급된 station id 4건은 향후 tools/datapack/inputs/capital-pilot-production-source-input.json에
// KRIC 공식 레코드 반영 시 반드시 재사용한다(동일 물리역 id 분기 방지).
//
// 사용: node tools/route-map/add-station-catalog-entries.mjs [--pack …] [--index …] [--check]
import { mutatePack, parsePackArgs } from "./station-surgery.mjs";
import { createStationCatalog, insertRow, rideEdgePair } from "./lib/station-catalog.mjs";

const REGION = "수도권";
const INCHEON1 = "line-98718184f016"; // 수도권 인천1호선
const SEOHAE = "line-051552e50435"; // 수도권 서해선
const EVERLINE = "line-828f04afc588"; // 수도권 에버라인

// last_verified_at 기준: 검단연장 3역과 그 체인의 RIDE 엣지는 공식 보도자료 검증일
// (2026-07-11), 원종·개명과 원종 체인의 RIDE 엣지는 KRIC 파일 기반이므로 파일
// 데이터 기준일(2026-06-30) — RIDE_CHAINS[*].lastVerifiedAt이 체인별 근거를 갖는다.
export const VERIFIED_PRESS_AT = Date.UTC(2026, 6, 11) / 1000;
export const VERIFIED_KRIC_AT = Date.UTC(2026, 5, 30) / 1000;

// 신설 역의 결정적 station id·행 planning·체인 반영은 공용 코어(#2035)를 쓴다.
// salt는 split 수술(#1789)의 해시 기반 id 정책과 동일한 이슈 번호(1954).
const catalog = createStationCatalog({ salt: 1954, region: REGION });
export const { newStationId, planNewStation, previewChain, applyChain } = catalog;
export { rideEdgePair };

/** 신설 4역(공식 근거 첨부). 좌표 null = admitted 소스 미반영(날조 금지). */
export const NEW_STATIONS = [
  {
    name: "검단호수공원",
    lineId: INCHEON1,
    lineSequence: 8,
    latitude: null,
    longitude: null,
    dataQualityLevel: "LEVEL_1",
    dataSourceType: "OPERATOR_PAGE",
    lastVerifiedAt: VERIFIED_PRESS_AT,
    evidence: "인천1호선 검단연장 종점(2025-06-28 개통, 인천시 공식 보도자료)",
  },
  {
    name: "신검단중앙",
    lineId: INCHEON1,
    lineSequence: 9,
    latitude: null,
    longitude: null,
    dataQualityLevel: "LEVEL_1",
    dataSourceType: "OPERATOR_PAGE",
    lastVerifiedAt: VERIFIED_PRESS_AT,
    evidence: "인천1호선 검단연장 102역(2025-06-28 개통, 인천시 공식 보도자료)",
  },
  {
    name: "아라",
    lineId: INCHEON1,
    lineSequence: 10,
    latitude: null,
    longitude: null,
    dataQualityLevel: "LEVEL_1",
    dataSourceType: "OPERATOR_PAGE",
    lastVerifiedAt: VERIFIED_PRESS_AT,
    evidence:
      "인천1호선 검단연장 계양 인접역(2025-06-28 개통) — 대조표의 인천2호선 추정을 공식 보도자료로 정정",
  },
  {
    name: "원종",
    lineId: SEOHAE,
    lineSequence: 8,
    latitude: 37.5240628,
    longitude: 126.8048386,
    dataQualityLevel: "LEVEL_2",
    dataSourceType: "OFFICIAL_FILE",
    lastVerifiedAt: VERIFIED_KRIC_AT,
    evidence:
      "KRIC 역사정보 2026-06-30 역번호 1981(대곡소사선 2023-07 개통) — MOLIT 순번 8 공백 위치",
  },
];

/**
 * 신설 역을 잇는 RIDE 인접 체인. 문자열은 NEW_STATIONS의 역명(신규 id로 해소),
 * `{id,name}`은 기존 역. removeDirect는 사이 역이 생겨 제거할 기존 직결쌍.
 * expectedMembers는 반영 후 노선 멤버 수(공식 근거) 게이트.
 */
export const RIDE_CHAINS = [
  {
    lineId: INCHEON1,
    // 검단호수공원(종점) → 신검단중앙 → 아라 → 계양(기존)
    chain: [
      "검단호수공원",
      "신검단중앙",
      "아라",
      { id: "station-2671dacf496f", name: "계양" },
    ],
    expectedMembers: 33, // 개통 보도자료: 검단연장 후 인천1호선 총 33역
    removeDirect: [],
    lastVerifiedAt: VERIFIED_PRESS_AT, // 인천시 공식 보도자료 검증일
  },
  {
    lineId: SEOHAE,
    // 김포공항(기존) → 원종 → 부천종합운동장(기존)
    chain: [
      { id: "station-1f38f0831cb1", name: "김포공항" },
      "원종",
      { id: "station-28be6a80c00e", name: "부천종합운동장" },
    ],
    expectedMembers: 21, // 기존 20역 + 원종
    // 원종이 사이에 들어가므로 기존 김포공항↔부천종합운동장 직결 RIDE 제거
    removeDirect: [["station-1f38f0831cb1", "station-28be6a80c00e"]],
    lastVerifiedAt: VERIFIED_KRIC_AT, // KRIC 역사정보 2026-06-30 파일 기준일
  },
];

/** 개명 1건(공식 근거 첨부). 구명은 별칭으로 유지해 구명 검색 사용자를 보호한다. */
export const RENAME = {
  stationId: "station-9d261727e400", // 에버라인 Y120
  lineId: EVERLINE,
  fromName: "운동장.송담대",
  toName: "용인중앙시장",
  nameSub: "용인예술과학대", // KRIC 표기 "용인중앙시장(용인예술과학대)"의 병기 부역명
  lastVerifiedAt: VERIFIED_KRIC_AT,
  evidence: "KRIC 역사정보 2026-06-30 Y120 용인중앙시장(용인예술과학대)",
};

function applyNewStation(db, spec) {
  const { station, stationLine } = planNewStation(spec);
  if (db.prepare("SELECT 1 FROM stations WHERE id=?").get(station.id)) {
    return { name: spec.name, id: station.id, skipped: "이미 반영됨" };
  }
  const clash = db
    .prepare("SELECT id FROM stations WHERE normalized_name=? AND region=?")
    .get(station.normalized_name, REGION);
  if (clash) {
    throw new Error(`${spec.name}: 동명 역이 이미 있음(${clash.id}) — 수동 확인`);
  }
  const occupied = db
    .prepare("SELECT station_id FROM station_lines WHERE line_id=? AND line_sequence=?")
    .get(spec.lineId, spec.lineSequence);
  if (occupied) {
    throw new Error(
      `${spec.name}: ${spec.lineId} seq=${spec.lineSequence} 이미 점유(${occupied.station_id})`,
    );
  }
  insertRow(db, "stations", station);
  insertRow(db, "station_lines", stationLine);
  return {
    name: spec.name,
    id: station.id,
    lineId: spec.lineId,
    lineSequence: spec.lineSequence,
    evidence: spec.evidence,
  };
}

function applyRename(db, spec) {
  const row = db
    .prepare("SELECT id, name_ko FROM stations WHERE id=?")
    .get(spec.stationId);
  if (!row) throw new Error(`개명 대상 역 없음: ${spec.stationId}`);
  const already = row.name_ko === spec.toName;
  if (!already && row.name_ko !== spec.fromName) {
    throw new Error(`개명 대상 이름 불일치: ${row.name_ko} (기대 ${spec.fromName})`);
  }
  if (!already) {
    db.prepare(
      "UPDATE stations SET name_ko=?, normalized_name=?, name_sub=?, last_verified_at=? WHERE id=?",
    ).run(spec.toName, spec.toName, spec.nameSub, spec.lastVerifiedAt, spec.stationId);
  }
  const alias = db
    .prepare("SELECT 1 FROM station_aliases WHERE station_id=? AND alias=?")
    .get(spec.stationId, spec.fromName);
  if (!alias) {
    // normalized_alias는 import-official-sources의 previousNames 관례대로 원문 그대로.
    insertRow(db, "station_aliases", {
      station_id: spec.stationId,
      alias: spec.fromName,
      normalized_alias: spec.fromName,
    });
  }
  return { stationId: spec.stationId, renamed: !already, aliasKept: spec.fromName };
}

function main() {
  const o = parsePackArgs(process.argv.slice(2));
  mutatePack({ ...o, tmpPrefix: "add-station-catalog-", run: (db) => {
    if (o.check) {
      for (const spec of NEW_STATIONS) {
        const { station } = planNewStation(spec);
        const exists = db.prepare("SELECT 1 FROM stations WHERE id=?").get(station.id);
        const occupied = db
          .prepare("SELECT station_id FROM station_lines WHERE line_id=? AND line_sequence=?")
          .get(spec.lineId, spec.lineSequence);
        console.log(
          `(--check) ${spec.name} → ${station.id} ${spec.lineId} seq=${spec.lineSequence} [${exists ? "이미 있음" : "신규"}${occupied ? `, seq 점유: ${occupied.station_id}` : ""}] (${spec.evidence})`,
        );
      }
      for (const spec of RIDE_CHAINS) {
        for (const { name, id, present } of previewChain(db, spec)) {
          console.log(
            `(--check) 체인 ${spec.lineId}: ${name}(${id}) ${present ? "있음" : "없음 ⚠"}`,
          );
        }
      }
      const target = db
        .prepare("SELECT name_ko FROM stations WHERE id=?")
        .get(RENAME.stationId);
      console.log(
        `(--check) 개명 ${RENAME.stationId}: ${target?.name_ko ?? "없음"} → ${RENAME.toName} (${RENAME.evidence})`,
      );
      return;
    }
    db.exec("BEGIN");
    const stations = NEW_STATIONS.map((spec) => applyNewStation(db, spec));
    const chains = RIDE_CHAINS.map((spec) => applyChain(db, spec));
    const rename = applyRename(db, RENAME);
    db.exec("COMMIT");
    for (const r of stations) {
      if (r.skipped) console.log(`${r.name}: ${r.skipped} (${r.id})`);
      else console.log(`${r.name}: ${r.id} ${r.lineId} seq=${r.lineSequence} (${r.evidence})`);
    }
    for (const c of chains) {
      console.log(
        `${c.lineId}: RIDE 엣지 +${c.insertedEdges}/-${c.removedEdges} · 멤버 ${c.members}`,
      );
    }
    console.log(
      `개명 ${rename.stationId}: ${rename.renamed ? `${RENAME.fromName} → ${RENAME.toName}` : "이미 반영됨"} · 구명 별칭 유지(${rename.aliasKept})`,
    );
  } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
