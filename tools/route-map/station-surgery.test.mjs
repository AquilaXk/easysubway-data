import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  assertReferentialIntegrity,
  parsePackArgs,
  rehomeAllStationNodes,
  rehomeLineNode,
  reparentLine,
} from "./station-surgery.mjs";

test("parsePackArgs는 기본값과 --pack/--index/--check를 파싱한다", () => {
  assert.deepEqual(parsePackArgs([]), {
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    index: "apps/mobile/assets/datapacks/index.json",
    check: false,
  });
  const o = parsePackArgs(["--pack", "p.gz", "--index", "i.json", "--check"]);
  assert.equal(o.pack, "p.gz");
  assert.equal(o.index, "i.json");
  assert.equal(o.check, true);
});

function seedDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL);`);
  db.exec(
    `CREATE TABLE station_lines (station_id TEXT, line_id TEXT, station_code TEXT DEFAULT '',
      PRIMARY KEY (station_id, line_id), FOREIGN KEY (station_id) REFERENCES stations(id));`,
  );
  db.exec(
    `CREATE TABLE route_map_positions (station_id TEXT, line_id TEXT, x INTEGER,
      PRIMARY KEY (station_id, line_id), FOREIGN KEY (station_id, line_id) REFERENCES station_lines(station_id, line_id));`,
  );
  // network_edges는 FK 없는 "station:line" 문자열 노드 (실제 스키마와 동일).
  db.exec(
    `CREATE TABLE network_edges (id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, edge_type TEXT DEFAULT 'RIDE');`,
  );
  db.exec(
    `INSERT INTO stations VALUES ('a','역'),('b','역');
     INSERT INTO station_lines VALUES ('a','L1','7'),('b','L2','3');
     INSERT INTO route_map_positions VALUES ('a','L1',10),('b','L2',20);
     INSERT INTO network_edges VALUES ('e1','a:L1','n:L1','RIDE'),('e2','n:L1','a:L1','RIDE');`,
  );
  return db;
}

test("reparentLine은 노선의 station_lines·positions·network_edges 노드를 from→to로 옮긴다(FK 무결)", () => {
  const db = seedDb();
  reparentLine(db, { fromStationId: "a", toStationId: "b", lineId: "L1", label: "온수" });
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(
    db.prepare("SELECT station_id FROM station_lines WHERE line_id='L1'").get().station_id,
    "b",
  );
  assert.equal(
    db.prepare("SELECT station_id FROM route_map_positions WHERE line_id='L1'").get().station_id,
    "b",
  );
  // network_edges 노드도 a:L1 → b:L1 로 재지정 (고아 방지)
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM network_edges WHERE from_node_id='a:L1' OR to_node_id='a:L1'").get().c,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM network_edges WHERE from_node_id='b:L1' OR to_node_id='b:L1'").get().c,
    2,
  );
  assert.equal(db.prepare("SELECT COUNT(*) c FROM station_lines WHERE station_id='b'").get().c, 2);
});

test("reparentLine은 대상이 이미 그 노선을 가지면 예외", () => {
  const db = seedDb();
  db.exec("INSERT INTO station_lines VALUES ('b','L1','9')");
  assert.throws(
    () => reparentLine(db, { fromStationId: "a", toStationId: "b", lineId: "L1" }),
    /PK 충돌/,
  );
});

test("rehomeAllStationNodes는 삭제된 역의 잔여 노드를 접두만 바꿔 대표로 옮긴다", () => {
  const db = seedDb();
  // 이미 병합돼 'a'가 삭제된 상태를 모사: 노드만 남아 있음
  db.exec("DELETE FROM route_map_positions WHERE station_id='a'");
  db.exec("DELETE FROM station_lines WHERE station_id='a'");
  db.exec("DELETE FROM stations WHERE id='a'");
  rehomeAllStationNodes(db, "a", "b");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM network_edges WHERE from_node_id LIKE 'a:%' OR to_node_id LIKE 'a:%'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM network_edges WHERE from_node_id='b:L1' OR to_node_id='b:L1'").get().c, 2);
});

function seedRealisticDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL);`);
  db.exec(`CREATE TABLE station_lines (station_id TEXT, line_id TEXT, PRIMARY KEY (station_id, line_id));`);
  db.exec(`CREATE TABLE network_edges (id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL);`);
  const s1 = "station-0123456789ab";
  const s2 = "station-abcdef012345";
  const l1 = "line-0011223344ff";
  db.exec(`INSERT INTO stations VALUES ('${s1}','역'),('${s2}','역');`);
  db.exec(`INSERT INTO station_lines VALUES ('${s1}','${l1}'),('${s2}','${l1}');`);
  db.exec(`INSERT INTO network_edges VALUES ('e1','${s1}:${l1}','${s2}:${l1}');`);
  return { db, s1, s2, l1 };
}

test("assertReferentialIntegrity는 정합 팩을 통과시킨다", () => {
  const { db } = seedRealisticDb();
  assert.doesNotThrow(() => assertReferentialIntegrity(db));
});

test("assertReferentialIntegrity는 station이 사라진 network_edges 노드를 잡는다(병합 고아)", () => {
  const { db, s1, l1 } = seedRealisticDb();
  db.exec(`DELETE FROM station_lines WHERE station_id='${s1}'`);
  db.exec(`DELETE FROM stations WHERE id='${s1}'`);
  assert.throws(() => assertReferentialIntegrity(db), /network_edges 고아 노드/);
});

test("assertReferentialIntegrity는 멤버십이 빠진 노드를 잡는다(분리 고아 — station은 존재)", () => {
  const { db, s1, l1 } = seedRealisticDb();
  // s1은 stations에 남지만 해당 (station,line) 멤버십이 다른 id로 옮겨진 상태
  db.exec(`DELETE FROM station_lines WHERE station_id='${s1}' AND line_id='${l1}'`);
  assert.throws(() => assertReferentialIntegrity(db), /network_edges 고아 노드/);
});
