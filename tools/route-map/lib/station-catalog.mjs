// 역 카탈로그 신설 도구 공용 코어 (#2035 중복 정리).
//
// add-station-catalog-entries(#1954)와 add-daegu-buksam-catalog(#2019)가
// 팩에 신설 역·RIDE 인접 체인을 반영하는 절차를 대량 복제했다 — 결정적
// station id 발급, stations/station_lines 행 planning, 양방향 RIDE 엣지 생성,
// 체인 사전조건 preview, 직결 제거 + 인접 엣지 삽입 + 멤버 게이트가 동일하다.
// 여기에 salt·region-agnostic 코어를 모으고, 두 도구는 자기 salt/region에
// 바인딩한 파생 함수만 re-export한다 (각 도구의 CLI·산출 계약은 불변).
import { createHash } from "node:crypto";

/**
 * 결정적 station id 발급기를 만든다. salt(이슈 번호)로 네임스페이스를 갈라
 * 도구별 id 충돌을 막는다. 반환 함수는 `(lineId, nameKo) => "station-<12hex>"`.
 */
export function makeStationIdFactory(salt) {
  return function newStationId(lineId, nameKo) {
    const hex = createHash("sha256")
      .update(`new-station:${lineId}:${nameKo}:${salt}`)
      .digest("hex");
    return `station-${hex.slice(0, 12)}`;
  };
}

/** 순수: 인접쌍 → 양방향 RIDE 엣지 2행(기존 RIDE 관례 필드값·id 포맷). */
export function rideEdgePair(lineId, fromStationId, toStationId, lastVerifiedAt) {
  const row = (a, b) => ({
    id: `edge-${lineId}-${a}-${b}`,
    from_node_id: `${a}:${lineId}`,
    to_node_id: `${b}:${lineId}`,
    duration_seconds: 120,
    distance_meters: 0,
    edge_type: "RIDE",
    service_pattern: "LOCAL",
    includes_stairs: 0,
    stair_access_state: "UNKNOWN",
    accessibility_status: "UNKNOWN",
    reliability_score: 80,
    facility_id: null,
    last_verified_at: lastVerifiedAt,
  });
  return [row(fromStationId, toStationId), row(toStationId, fromStationId)];
}

/** 임의 테이블에 열 순서대로 한 행을 INSERT 한다. */
export function insertRow(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...cols.map((c) => row[c]));
}

/** 체인 항목(문자열=신규 역명, {id,name}=기존 역)을 id로 해소한다. */
function resolveEntryId(entry, lineId, newStationId) {
  return typeof entry === "string" ? newStationId(lineId, entry) : entry.id;
}

/** 체인 항목의 표시 이름을 얻는다. */
function entryName(entry) {
  return typeof entry === "string" ? entry : entry.name;
}

/** 직결 RIDE 엣지 존재 여부(읽기 전용). */
function directEdgePresent(db, lineId, a, b) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM network_edges WHERE edge_type='RIDE' AND from_node_id=? AND to_node_id=?",
      )
      .get(`${a}:${lineId}`, `${b}:${lineId}`),
  );
}

/**
 * salt/region에 바인딩한 카탈로그 코어를 만든다. 반환한 함수들은 두 도구가
 * 그대로 re-export 해 각자의 테스트·CLI 계약을 유지한다.
 *  - newStationId: 이 도구 salt에 묶인 id 발급기
 *  - planNewStation: 신설 역 스펙 → stations/station_lines 행
 *  - previewChain: 체인 사전조건 읽기 전용 점검
 *  - applyChain: 직결 제거 + 인접 엣지 삽입 + 멤버 게이트
 */
export function createStationCatalog({ salt, region }) {
  const newStationId = makeStationIdFactory(salt);

  /**
   * 순수: 신설 역 스펙 → stations/station_lines 행. 카탈로그 관례를 따른다
   * (normalized_name = name_ko 원문, station_code = line_sequence 문자열,
   * name_en/name_sub/platform_info 빈 문자열).
   */
  function planNewStation(spec) {
    const id = newStationId(spec.lineId, spec.name);
    return {
      station: {
        id,
        name_ko: spec.name,
        name_en: "",
        normalized_name: spec.name,
        region,
        latitude: spec.latitude,
        longitude: spec.longitude,
        data_quality_level: spec.dataQualityLevel,
        data_source_type: spec.dataSourceType,
        last_verified_at: spec.lastVerifiedAt,
        name_sub: "",
      },
      stationLine: {
        station_id: id,
        line_id: spec.lineId,
        station_code: String(spec.lineSequence),
        line_sequence: spec.lineSequence,
        platform_info: "",
      },
    };
  }

  /**
   * 읽기 전용: applyChain 사전조건(체인 역 존재·removeDirect 직결 엣지 존재)을
   * --check 미리보기용으로 점검한다. applyChain과 동일한 id 해소 규칙을 쓴다.
   */
  function previewChain(db, { lineId, chain, removeDirect }) {
    const rows = [];
    for (const entry of chain) {
      const id = resolveEntryId(entry, lineId, newStationId);
      const present = Boolean(db.prepare("SELECT 1 FROM stations WHERE id=?").get(id));
      rows.push({ name: entryName(entry), id, present });
    }
    for (const [a, b] of removeDirect) {
      rows.push({
        name: `직결 ${a}↔${b}`,
        id: `${a}:${lineId}`,
        present: directEdgePresent(db, lineId, a, b),
      });
    }
    return rows;
  }

  function applyChain(db, { lineId, chain, expectedMembers, removeDirect, lastVerifiedAt }) {
    const ids = chain.map((entry) => resolveEntryId(entry, lineId, newStationId));
    for (const entry of chain) {
      const id = resolveEntryId(entry, lineId, newStationId);
      if (!db.prepare("SELECT 1 FROM stations WHERE id=?").get(id)) {
        throw new Error(`${lineId}: 체인 역 없음 ${entryName(entry)}(${id})`);
      }
    }
    const del = db.prepare(
      "DELETE FROM network_edges WHERE edge_type='RIDE' AND from_node_id=? AND to_node_id=?",
    );
    let removed = 0;
    for (const [a, b] of removeDirect) {
      removed += del.run(`${a}:${lineId}`, `${b}:${lineId}`).changes;
      removed += del.run(`${b}:${lineId}`, `${a}:${lineId}`).changes;
    }
    let inserted = 0;
    for (let i = 0; i + 1 < ids.length; i += 1) {
      for (const edge of rideEdgePair(lineId, ids[i], ids[i + 1], lastVerifiedAt)) {
        const dup = db
          .prepare(
            "SELECT 1 FROM network_edges WHERE edge_type='RIDE' AND from_node_id=? AND to_node_id=?",
          )
          .get(edge.from_node_id, edge.to_node_id);
        if (dup) continue;
        insertRow(db, "network_edges", edge);
        inserted += 1;
      }
    }
    const members = db
      .prepare("SELECT COUNT(*) c FROM station_lines WHERE line_id=?")
      .get(lineId).c;
    if (members !== expectedMembers) {
      throw new Error(`${lineId}: 반영 후 멤버 수 ${members} ≠ 기대 ${expectedMembers}`);
    }
    return { lineId, removedEdges: removed, insertedEdges: inserted, members };
  }

  return { newStationId, planNewStation, previewChain, applyChain };
}
