import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  BUKSAM,
  DAEGYEONG,
  REGION,
  RIDE_CHAIN,
  VERIFIED_PRESS_AT,
  applyChain,
  newStationId,
  planNewStation,
  previewChain,
  resequenceFrom,
  rideEdgePair,
} from "./add-daegu-buksam-catalog.mjs";

test("newStationId는 노선·역명에 결정적이고 station- 접두 12hex를 낸다", () => {
  const a = newStationId(DAEGYEONG, "북삼");
  const b = newStationId(DAEGYEONG, "북삼");
  assert.equal(a, b, "결정적");
  assert.match(a, /^station-[0-9a-f]{12}$/);
  assert.notEqual(a, newStationId("line-000000000000", "북삼"), "노선이 다르면 다른 id");
});

test("BUKSAM은 공식 근거를 붙인 대경선 신설역이다", () => {
  assert.equal(BUKSAM.name, "북삼");
  assert.equal(BUKSAM.lineId, DAEGYEONG);
  assert.equal(BUKSAM.lineSequence, 6, "왜관(5) 다음, 사곡을 밀어낸다");
  // admitted 소스(MOLIT 2025-12-11)는 북삼 개통(2026-02-28) 이전 스냅샷이라
  // 북삼을 담지 않는다 — 좌표 날조 금지, 품질 표기도 낮춘다.
  assert.equal(BUKSAM.latitude, null);
  assert.equal(BUKSAM.longitude, null);
  assert.equal(BUKSAM.dataQualityLevel, "LEVEL_1");
  assert.equal(BUKSAM.dataSourceType, "OPERATOR_PAGE");
  assert.equal(BUKSAM.lastVerifiedAt, VERIFIED_PRESS_AT);
  assert.ok(BUKSAM.evidence.includes("북삼"), "공식 근거 문자열");
});

test("planNewStation은 대구 카탈로그 관례대로 stations/station_lines 행을 만든다", () => {
  const { station, stationLine } = planNewStation(BUKSAM);
  assert.equal(station.id, newStationId(BUKSAM.lineId, BUKSAM.name));
  assert.equal(station.name_ko, "북삼");
  assert.equal(station.normalized_name, "북삼", "normalized_name = name_ko 원문");
  assert.equal(station.name_en, "");
  assert.equal(station.name_sub, "");
  assert.equal(station.region, REGION);
  assert.equal(stationLine.station_id, station.id);
  assert.equal(stationLine.line_id, BUKSAM.lineId);
  assert.equal(stationLine.line_sequence, 6);
  assert.equal(stationLine.station_code, "6", "station_code = line_sequence 문자열 관례");
  assert.equal(stationLine.platform_info, "");
});

test("RIDE_CHAIN은 왜관→북삼→사곡을 잇고 왜관↔사곡 직결쌍을 제거한다", () => {
  assert.equal(RIDE_CHAIN.lineId, DAEGYEONG);
  assert.equal(RIDE_CHAIN.expectedMembers, 8, "기존 7역 + 북삼");
  assert.deepEqual(
    RIDE_CHAIN.removeDirect,
    [["station-6502c3637045", "station-2e9e270f159d"]],
    "북삼 삽입으로 왜관↔사곡 직결 RIDE 제거",
  );
  assert.equal(RIDE_CHAIN.lastVerifiedAt, VERIFIED_PRESS_AT);
  const names = RIDE_CHAIN.chain.map((e) => (typeof e === "string" ? e : e.name));
  assert.deepEqual(names, ["왜관", "북삼", "사곡"]);
});

test("rideEdgePair는 기존 RIDE 관례 필드값으로 양방향 2행을 만든다", () => {
  const [ab, ba] = rideEdgePair(DAEGYEONG, "station-aaa", "station-bbb", 123);
  assert.equal(ab.id, `edge-${DAEGYEONG}-station-aaa-station-bbb`);
  assert.equal(ba.id, `edge-${DAEGYEONG}-station-bbb-station-aaa`);
  assert.equal(ab.from_node_id, `station-aaa:${DAEGYEONG}`);
  assert.equal(ab.to_node_id, `station-bbb:${DAEGYEONG}`);
  for (const edge of [ab, ba]) {
    assert.equal(edge.duration_seconds, 120);
    assert.equal(edge.edge_type, "RIDE");
    assert.equal(edge.service_pattern, "LOCAL");
    assert.equal(edge.reliability_score, 80);
    assert.equal(edge.facility_id, null);
    assert.equal(edge.last_verified_at, 123);
  }
});

function seedDaegyeongDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL, normalized_name TEXT, region TEXT);`);
  db.exec(`CREATE TABLE station_lines (
    station_id TEXT, line_id TEXT, station_code TEXT, line_sequence INTEGER, platform_info TEXT,
    PRIMARY KEY (station_id, line_id)
  );`);
  db.exec(`CREATE TABLE network_edges (
    id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL,
    duration_seconds INTEGER, distance_meters INTEGER, edge_type TEXT DEFAULT 'RIDE',
    service_pattern TEXT, includes_stairs INTEGER, stair_access_state TEXT,
    accessibility_status TEXT, reliability_score INTEGER, facility_id TEXT, last_verified_at INTEGER
  );`);
  // 왜관(5)-사곡(6)-구미(7) 부분 골격.
  db.exec(`
    INSERT INTO stations VALUES
      ('station-6502c3637045','왜관','왜관','대구권'),
      ('station-2e9e270f159d','사곡','사곡','대구권'),
      ('station-efc0fed91bd1','구미','구미','대구권');
    INSERT INTO station_lines VALUES
      ('station-6502c3637045','${DAEGYEONG}','5',5,''),
      ('station-2e9e270f159d','${DAEGYEONG}','6',6,''),
      ('station-efc0fed91bd1','${DAEGYEONG}','7',7,'');
    INSERT INTO network_edges (id, from_node_id, to_node_id, edge_type, last_verified_at) VALUES
      ('e1','station-6502c3637045:${DAEGYEONG}','station-2e9e270f159d:${DAEGYEONG}','RIDE',1),
      ('e2','station-2e9e270f159d:${DAEGYEONG}','station-6502c3637045:${DAEGYEONG}','RIDE',1),
      ('e3','station-2e9e270f159d:${DAEGYEONG}','station-efc0fed91bd1:${DAEGYEONG}','RIDE',1),
      ('e4','station-efc0fed91bd1:${DAEGYEONG}','station-2e9e270f159d:${DAEGYEONG}','RIDE',1);
  `);
  return db;
}

test("resequenceFrom은 삽입 위치 이후 역의 순번·station_code를 +1 밀고 밀린 목록을 낸다", () => {
  const db = seedDaegyeongDb();
  const shifted = resequenceFrom(db, DAEGYEONG, 6);
  assert.deepEqual(shifted, [
    { name: "사곡", from: 6, to: 7 },
    { name: "구미", from: 7, to: 8 },
  ]);
  const rows = db
    .prepare("SELECT station_id, line_sequence, station_code FROM station_lines WHERE line_id=? ORDER BY line_sequence")
    .all(DAEGYEONG)
    .map((r) => [r.station_id, r.line_sequence, String(r.station_code)]);
  assert.deepEqual(rows, [
    ["station-6502c3637045", 5, "5"],
    ["station-2e9e270f159d", 7, "7"],
    ["station-efc0fed91bd1", 8, "8"],
  ]);
});

test("applyChain은 왜관↔사곡 직결을 제거하고 왜관→북삼→사곡 양방향 엣지를 넣는다", () => {
  const db = seedDaegyeongDb();
  // 북삼 역·순번을 먼저 심어야 applyChain의 멤버 게이트가 8이 된다.
  const buksamId = newStationId(DAEGYEONG, "북삼");
  db.prepare("INSERT INTO stations VALUES (?,?,?,?)").run(buksamId, "북삼", "북삼", "대구권");
  db.prepare("INSERT INTO station_lines VALUES (?,?,?,?,?)").run(buksamId, DAEGYEONG, "6", 6, "");
  // seed는 왜관/사곡/구미+북삼 = 4역 부분 골격이므로 멤버 게이트를 4로 맞춘다.
  const result = applyChain(db, { ...RIDE_CHAIN, expectedMembers: 4 });
  assert.equal(result.removedEdges, 2, "왜관↔사곡 직결 양방향 2행 제거");
  assert.equal(result.insertedEdges, 4, "왜관-북삼, 북삼-사곡 각 양방향 = 4행");
  assert.equal(result.members, 4);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM network_edges WHERE from_node_id=? AND to_node_id=?").get(
      `station-6502c3637045:${DAEGYEONG}`,
      `station-2e9e270f159d:${DAEGYEONG}`,
    ).c,
    0,
    "왜관→사곡 직결은 제거되고 남지 않음",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM network_edges WHERE from_node_id=? AND to_node_id=?").get(
      `station-6502c3637045:${DAEGYEONG}`,
      `${buksamId}:${DAEGYEONG}`,
    ).c,
    1,
    "왜관→북삼 엣지 존재",
  );
});

test("applyChain은 반영 후 멤버 수가 expectedMembers와 다르면 예외를 던진다", () => {
  const db = seedDaegyeongDb();
  const buksamId = newStationId(DAEGYEONG, "북삼");
  db.prepare("INSERT INTO stations VALUES (?,?,?,?)").run(buksamId, "북삼", "북삼", "대구권");
  db.prepare("INSERT INTO station_lines VALUES (?,?,?,?,?)").run(buksamId, DAEGYEONG, "6", 6, "");
  assert.throws(
    () => applyChain(db, { ...RIDE_CHAIN, expectedMembers: 99 }),
    /멤버 수 4 ≠ 기대 99/,
  );
});

test("previewChain은 체인 역·직결 엣지 존재 여부를 읽기 전용으로 점검한다", () => {
  const db = seedDaegyeongDb();
  const rows = previewChain(db, RIDE_CHAIN);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.present]));
  assert.equal(byName["왜관"], true);
  assert.equal(byName["사곡"], true);
  assert.equal(byName["북삼"], false, "아직 없는 북삼은 present=false");
  assert.equal(
    byName["직결 station-6502c3637045↔station-2e9e270f159d"],
    true,
    "존재하는 왜관↔사곡 직결 엣지는 present=true",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM network_edges").get().c,
    4,
    "previewChain은 읽기 전용 — 엣지를 변경하지 않는다",
  );
});
