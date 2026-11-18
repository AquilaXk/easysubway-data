import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assertReferentialIntegrity } from "./station-surgery.mjs";
import { applyMerge, MERGES, reconcileNameSub } from "./merge-busan-transfers.mjs";

test("reconcileNameSub는 대표의 부역명을 유지하고 없으면 흡수분에서 가져온다", () => {
  assert.equal(reconcileNameSub("시립미술관", ""), "시립미술관");
  assert.equal(reconcileNameSub("", "시립미술관"), "시립미술관");
  assert.equal(reconcileNameSub("시립미술관", "시립미술관"), "시립미술관");
  assert.equal(reconcileNameSub("", ""), "");
});

test("MERGES는 오너 확정 부산 환승역 오분리(벡스코)를 담는다", () => {
  const names = MERGES.map((m) => m.name).sort();
  assert.deepEqual(names, ["벡스코"]);
  for (const m of MERGES) {
    assert.match(m.keepId, /^station-[0-9a-f]{12}$/);
    assert.match(m.dropId, /^station-[0-9a-f]{12}$/);
    assert.notEqual(m.keepId, m.dropId);
    assert.ok(m.expectedSub, "부역명 기대값");
    assert.ok(m.expectedMembers >= 2, "환승은 병합 후 2노선 이상");
    assert.ok(m.evidence, "공식/오너 근거");
  }
});

// 실제 벡스코 스키마를 축약한 in-memory 팩으로 병합 동작을 검증한다: 대표가
// 2노선 환승으로 합쳐지고, 부역명이 보존되며, 흡수 역이 삭제되고, network_edges
// 노드가 대표로 재지정돼 참조 무결(고아 0)이 유지되는지.
function seedBexcoDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL, name_sub TEXT DEFAULT '', region TEXT);`);
  db.exec(`CREATE TABLE station_lines (station_id TEXT, line_id TEXT, PRIMARY KEY (station_id, line_id), FOREIGN KEY (station_id) REFERENCES stations(id));`);
  db.exec(`CREATE TABLE route_map_positions (station_id TEXT, line_id TEXT, x INTEGER, y INTEGER, PRIMARY KEY (station_id, line_id), FOREIGN KEY (station_id, line_id) REFERENCES station_lines(station_id, line_id));`);
  db.exec(`CREATE TABLE station_aliases (station_id TEXT, alias TEXT, normalized_alias TEXT);`);
  db.exec(`CREATE TABLE network_edges (id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, edge_type TEXT DEFAULT 'RIDE');`);
  const keep = "station-fbcc387e1db9";
  const drop = "station-6820d21cea02";
  const line2 = "line-eb7b47920390"; // 2호선
  const donghae = "line-f52eb59d8497"; // 동해선
  db.exec(`INSERT INTO stations VALUES
    ('${keep}','벡스코','시립미술관','부산권'),
    ('${drop}','벡스코','','부산권');`);
  db.exec(`INSERT INTO station_lines VALUES ('${keep}','${line2}'),('${drop}','${donghae}');`);
  db.exec(`INSERT INTO route_map_positions VALUES ('${keep}','${line2}',9185,3708),('${drop}','${donghae}',9185,3708);`);
  // 동해선 벡스코의 라우팅 엣지(방향 suffix 포함) — 병합 시 대표로 재지정돼야 한다.
  db.exec(`INSERT INTO network_edges VALUES
    ('e1','${drop}:${donghae}:UP','${keep}:${line2}:UP','TRANSFER'),
    ('e2','${keep}:${line2}:UP','${drop}:${donghae}:UP','TRANSFER');`);
  return { db, keep, drop, line2, donghae };
}

const SPEC = MERGES[0];

test("applyMerge는 벡스코 2노선을 대표로 합치고 부역명 보존·흡수 삭제·엣지 재지정한다", () => {
  const { db, keep, drop } = seedBexcoDb();
  const result = applyMerge(db, SPEC);
  assert.equal(result.memberCount, 2, "2호선 + 동해선");
  assert.equal(result.mergedSub, "시립미술관");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stations WHERE id=?").get(drop).c, 0, "흡수 역 삭제");
  assert.equal(db.prepare("SELECT name_sub FROM stations WHERE id=?").get(keep).name_sub, "시립미술관");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM station_lines WHERE station_id=?").get(keep).c, 2);
  // 흡수 역 접두 노드가 하나도 남지 않아야 한다(라우팅 그래프 정합).
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM network_edges WHERE from_node_id LIKE ? OR to_node_id LIKE ?").get(`${drop}:%`, `${drop}:%`).c,
    0,
  );
  assert.doesNotThrow(() => assertReferentialIntegrity(db), "고아 노드 없이 참조 무결");
});

test("applyMerge는 이미 병합된 팩에서 멱등하다(대표 부역명 확인 후 잔여 노드만 복구)", () => {
  const { db, drop } = seedBexcoDb();
  applyMerge(db, SPEC);
  // 두 번째 호출: dropId가 이미 없으므로 skipped 경로. 예외 없이 통과해야 한다.
  const again = applyMerge(db, SPEC);
  assert.match(again.skipped, /이미 병합됨/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stations WHERE id=?").get(drop).c, 0);
  assert.doesNotThrow(() => assertReferentialIntegrity(db));
});
