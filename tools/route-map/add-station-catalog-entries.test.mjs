import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  NEW_STATIONS,
  RENAME,
  RIDE_CHAINS,
  VERIFIED_KRIC_AT,
  VERIFIED_PRESS_AT,
  applyChain,
  newStationId,
  planNewStation,
  previewChain,
  rideEdgePair,
} from "./add-station-catalog-entries.mjs";

test("newStationId는 노선·역명에 대해 결정적이고 station- 접두 12hex를 낸다", () => {
  const a = newStationId("line-98718184f016", "아라");
  const b = newStationId("line-98718184f016", "아라");
  assert.equal(a, b, "결정적");
  assert.match(a, /^station-[0-9a-f]{12}$/);
  assert.notEqual(a, newStationId("line-051552e50435", "아라"), "노선이 다르면 다른 id");
  assert.notEqual(a, newStationId("line-98718184f016", "원종"), "역명이 다르면 다른 id");
});

test("NEW_STATIONS는 공식 근거를 붙인 신설 4역을 담는다", () => {
  const names = NEW_STATIONS.map((s) => s.name).sort();
  assert.deepEqual(names, ["검단호수공원", "신검단중앙", "아라", "원종"]);
  for (const s of NEW_STATIONS) {
    assert.match(s.lineId, /^line-[0-9a-f]{12}$/);
    assert.ok(Number.isInteger(s.lineSequence) && s.lineSequence > 0);
    assert.ok(s.evidence, "공식 근거 문자열");
  }
});

test("검단연장 3역은 인천1호선 계양(11) 앞 8·9·10에 개통 순서대로 배치된다", () => {
  const incheon1 = NEW_STATIONS.filter((s) => s.lineId === "line-98718184f016");
  assert.deepEqual(
    incheon1.map((s) => [s.name, s.lineSequence]),
    [
      ["검단호수공원", 8],
      ["신검단중앙", 9],
      ["아라", 10],
    ],
    "계양 방향 순서: 검단호수공원(종점)→신검단중앙→아라→계양",
  );
  for (const s of incheon1) {
    // admitted 소스 미반영 — 좌표 날조 금지, 품질 표기도 낮춰 남긴다.
    assert.equal(s.latitude, null);
    assert.equal(s.longitude, null);
    assert.equal(s.dataQualityLevel, "LEVEL_1");
    assert.equal(s.dataSourceType, "OPERATOR_PAGE");
    assert.equal(s.lastVerifiedAt, VERIFIED_PRESS_AT);
  }
});

test("원종은 KRIC admitted 파일 근거로 서해선 순번 8 공백에 좌표와 함께 들어간다", () => {
  const wonjong = NEW_STATIONS.find((s) => s.name === "원종");
  assert.equal(wonjong.lineId, "line-051552e50435");
  assert.equal(wonjong.lineSequence, 8);
  assert.equal(wonjong.latitude, 37.5240628);
  assert.equal(wonjong.longitude, 126.8048386);
  assert.equal(wonjong.dataQualityLevel, "LEVEL_2");
  assert.equal(wonjong.dataSourceType, "OFFICIAL_FILE");
  assert.equal(wonjong.lastVerifiedAt, VERIFIED_KRIC_AT);
});

test("planNewStation은 카탈로그 관례대로 stations/station_lines 행을 만든다", () => {
  const spec = NEW_STATIONS.find((s) => s.name === "원종");
  const { station, stationLine } = planNewStation(spec);
  assert.equal(station.id, newStationId(spec.lineId, spec.name));
  assert.equal(station.name_ko, "원종");
  assert.equal(station.normalized_name, "원종", "normalized_name = name_ko 원문");
  assert.equal(station.name_en, "");
  assert.equal(station.name_sub, "");
  assert.equal(station.region, "수도권");
  assert.equal(stationLine.station_id, station.id);
  assert.equal(stationLine.line_id, spec.lineId);
  assert.equal(stationLine.line_sequence, 8);
  assert.equal(stationLine.station_code, "8", "station_code = line_sequence 문자열 관례");
  assert.equal(stationLine.platform_info, "");
});

test("rideEdgePair는 기존 RIDE 관례 필드값으로 양방향 2행을 만든다", () => {
  const [ab, ba] = rideEdgePair("line-98718184f016", "station-aaa", "station-bbb", 123);
  assert.equal(ab.id, "edge-line-98718184f016-station-aaa-station-bbb");
  assert.equal(ba.id, "edge-line-98718184f016-station-bbb-station-aaa");
  assert.equal(ab.from_node_id, "station-aaa:line-98718184f016");
  assert.equal(ab.to_node_id, "station-bbb:line-98718184f016");
  assert.equal(ba.from_node_id, "station-bbb:line-98718184f016");
  assert.equal(ba.to_node_id, "station-aaa:line-98718184f016");
  for (const edge of [ab, ba]) {
    assert.equal(edge.duration_seconds, 120);
    assert.equal(edge.distance_meters, 0);
    assert.equal(edge.edge_type, "RIDE");
    assert.equal(edge.service_pattern, "LOCAL");
    assert.equal(edge.includes_stairs, 0);
    assert.equal(edge.stair_access_state, "UNKNOWN");
    assert.equal(edge.accessibility_status, "UNKNOWN");
    assert.equal(edge.reliability_score, 80);
    assert.equal(edge.facility_id, null);
    assert.equal(edge.last_verified_at, 123);
  }
});

test("RIDE_CHAINS는 신설 4역 전부를 기존 인접역과 잇고 서해선 직결쌍을 제거한다", () => {
  const newNames = new Set(NEW_STATIONS.map((s) => s.name));
  const chained = new Set();
  for (const { lineId, chain, expectedMembers, removeDirect } of RIDE_CHAINS) {
    assert.match(lineId, /^line-[0-9a-f]{12}$/);
    assert.ok(Number.isInteger(expectedMembers) && expectedMembers > 0);
    assert.ok(Array.isArray(removeDirect));
    assert.ok(chain.length >= 2, "체인은 인접쌍을 만들 수 있어야 함");
    for (const entry of chain) {
      if (typeof entry === "string") {
        assert.ok(newNames.has(entry), `신규 역명만 문자열 허용: ${entry}`);
        const spec = NEW_STATIONS.find((s) => s.name === entry);
        assert.equal(spec.lineId, lineId, "체인 노선과 신규 역 노선이 일치");
        chained.add(entry);
      } else {
        assert.match(entry.id, /^station-[0-9a-f]{12}$/);
        assert.ok(entry.name, "기존 역은 이름 주석 필수");
      }
    }
  }
  assert.deepEqual([...chained].sort(), [...newNames].sort(), "신설 4역 전부 체인에 포함");
  const seohae = RIDE_CHAINS.find((c) => c.lineId === "line-051552e50435");
  assert.deepEqual(
    seohae.removeDirect,
    [["station-1f38f0831cb1", "station-28be6a80c00e"]],
    "원종 삽입으로 김포공항↔부천종합운동장 직결 RIDE 제거",
  );
});

test("RIDE_CHAINS의 lastVerifiedAt은 체인별 실제 근거를 따른다(인천1호선=보도자료, 서해선=KRIC)", () => {
  const incheon1 = RIDE_CHAINS.find((c) => c.lineId === "line-98718184f016");
  const seohae = RIDE_CHAINS.find((c) => c.lineId === "line-051552e50435");
  assert.equal(
    incheon1.lastVerifiedAt,
    VERIFIED_PRESS_AT,
    "검단연장 체인은 인천시 공식 보도자료 검증일",
  );
  assert.equal(
    seohae.lastVerifiedAt,
    VERIFIED_KRIC_AT,
    "원종 체인은 KRIC 파일 데이터 기준일(보도자료 검증일이 아님)",
  );
});

test("RENAME은 신명으로 갱신하되 구명을 별칭으로 유지한다", () => {
  assert.match(RENAME.stationId, /^station-[0-9a-f]{12}$/);
  assert.equal(RENAME.fromName, "운동장.송담대");
  assert.equal(RENAME.toName, "용인중앙시장");
  assert.equal(RENAME.nameSub, "용인예술과학대");
  assert.equal(RENAME.lastVerifiedAt, VERIFIED_KRIC_AT);
  assert.ok(RENAME.evidence, "공식 근거 문자열");
});

function seedChainDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL);`);
  db.exec(`CREATE TABLE station_lines (station_id TEXT, line_id TEXT, PRIMARY KEY (station_id, line_id));`);
  db.exec(`CREATE TABLE network_edges (
    id TEXT PRIMARY KEY,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    duration_seconds INTEGER,
    distance_meters INTEGER,
    edge_type TEXT DEFAULT 'RIDE',
    service_pattern TEXT,
    includes_stairs INTEGER,
    stair_access_state TEXT,
    accessibility_status TEXT,
    reliability_score INTEGER,
    facility_id TEXT,
    last_verified_at INTEGER
  );`);
  db.exec(
    `INSERT INTO stations VALUES ('a','역A'),('b','역B'),('c','역C');
     INSERT INTO station_lines VALUES ('a','L1'),('b','L1'),('c','L1');`,
  );
  return db;
}

test("applyChain은 spec의 lastVerifiedAt을 network_edges 행에 그대로 반영한다", () => {
  const db = seedChainDb();
  const result = applyChain(db, {
    lineId: "L1",
    chain: [{ id: "a", name: "역A" }, { id: "b", name: "역B" }, { id: "c", name: "역C" }],
    expectedMembers: 3,
    removeDirect: [],
    lastVerifiedAt: 999,
  });
  assert.equal(result.insertedEdges, 4, "3역 체인 → 인접쌍 2개 × 양방향 = 4행");
  assert.equal(result.removedEdges, 0);
  assert.equal(result.members, 3);
  const rows = db.prepare("SELECT last_verified_at FROM network_edges").all();
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.last_verified_at, 999, "체인에 전달한 lastVerifiedAt이 모든 엣지에 그대로 반영");
  }
});

test("applyChain은 removeDirect로 지정한 기존 직결 RIDE 엣지를 양방향 제거한다", () => {
  const db = seedChainDb();
  db.exec(
    `INSERT INTO network_edges (id, from_node_id, to_node_id, edge_type, last_verified_at)
     VALUES ('e1','a:L1','c:L1','RIDE',1),('e2','c:L1','a:L1','RIDE',1);`,
  );
  const result = applyChain(db, {
    lineId: "L1",
    chain: [{ id: "a", name: "역A" }, { id: "b", name: "역B" }, { id: "c", name: "역C" }],
    expectedMembers: 3,
    removeDirect: [["a", "c"]],
    lastVerifiedAt: 555,
  });
  assert.equal(result.removedEdges, 2, "기존 직결쌍 양방향 2행 제거");
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM network_edges WHERE from_node_id='a:L1' AND to_node_id='c:L1'").get().c,
    0,
    "직결 엣지는 제거되고 남지 않음",
  );
});

test("applyChain은 반영 후 멤버 수가 expectedMembers와 다르면 예외를 던진다", () => {
  const db = seedChainDb();
  assert.throws(
    () =>
      applyChain(db, {
        lineId: "L1",
        chain: [{ id: "a", name: "역A" }, { id: "b", name: "역B" }],
        expectedMembers: 99,
        removeDirect: [],
        lastVerifiedAt: 1,
      }),
    /멤버 수 3 ≠ 기대 99/,
  );
});

test("previewChain은 체인 역·removeDirect 직결 엣지의 존재 여부를 읽기 전용으로 점검한다", () => {
  const db = seedChainDb();
  db.exec(
    `INSERT INTO network_edges (id, from_node_id, to_node_id, edge_type, last_verified_at)
     VALUES ('e1','a:L1','c:L1','RIDE',1);`,
  );
  const rows = previewChain(db, {
    lineId: "L1",
    chain: [{ id: "a", name: "역A" }, { id: "z", name: "역Z" }],
    removeDirect: [["a", "c"], ["a", "b"]],
  });
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.present]));
  assert.equal(byName["역A"], true, "존재하는 체인 역은 present=true");
  assert.equal(byName["역Z"], false, "없는 체인 역은 present=false");
  assert.equal(byName["직결 a↔c"], true, "존재하는 직결 엣지는 present=true");
  assert.equal(byName["직결 a↔b"], false, "없는 직결 엣지는 present=false");
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM network_edges").get().c,
    1,
    "previewChain은 읽기 전용 — 엣지를 변경하지 않는다",
  );
});
