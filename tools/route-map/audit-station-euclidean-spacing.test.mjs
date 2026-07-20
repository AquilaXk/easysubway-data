import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  findEuclideanSpacingViolations,
  filterUnlistedViolations,
} from "./audit-station-euclidean-spacing.mjs";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE route_map_positions (
      station_id TEXT, line_id TEXT, region TEXT, x INTEGER, y INTEGER
    );
  `);
  return { db };
}

test("같은 노선 내 유클리드 <threshold 쌍을 잡는다(환승 동일역 제외)", () => {
  const { db } = makeDb();
  try {
    const ins = db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y) VALUES (?,?,?,?,?)",
    );
    ins.run("a", "L1", "수도권", 0, 0);
    ins.run("b", "L1", "수도권", 10, 0); // dist 10 < 48 → violation
    ins.run("c", "L1", "수도권", 100, 0); // dist(a,c)=100, dist(b,c)=90 → ok
    // 환승: 같은 station_id "a"가 L2에도 존재, L1 좌표와 동일 근접 — 다른
    // line_id이므로 별개 그룹, station_id 같으면 제외.
    ins.run("a", "L2", "수도권", 0, 0);
    ins.run("d", "L2", "수도권", 1, 0); // 다른 station_id, L2 내 dist 1 < 48

    const violations = findEuclideanSpacingViolations(db, "수도권", 48);
    // L1: a-b(10), L2: a-d(1) → 2건. a-a(같은 station across lines) 제외 대상 아님(다른 line 그룹이라 애초 비교 안 됨).
    assert.equal(violations.length, 2);
    assert.ok(violations.every((v) => v.a !== v.b));
  } finally {
    db.close();
  }
});

test("동일 station_id(환승 캡슐 멤버)는 같은 line 내에서 자기 자신과 비교되지 않는다", () => {
  const { db } = makeDb();
  try {
    const ins = db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y) VALUES (?,?,?,?,?)",
    );
    ins.run("x", "L1", "수도권", 0, 0);
    ins.run("x", "L1", "수도권", 0, 0); // 같은 station_id 중복 행(있을 수 없지만 방어)
    const violations = findEuclideanSpacingViolations(db, "수도권", 48);
    assert.equal(violations.length, 0);
  } finally {
    db.close();
  }
});

test("예외 목록에 등재된 쌍은 필터링된다(순서 무관)", () => {
  const violations = [
    { lineId: "L1", a: "a", b: "b", dist: 10 },
    { lineId: "L1", a: "c", b: "d", dist: 20 },
  ];
  const exceptions = [{ lineId: "L1", a: "b", b: "a", reason: "test" }];
  const unlisted = filterUnlistedViolations(violations, exceptions);
  assert.equal(unlisted.length, 1);
  assert.equal(unlisted[0].a, "c");
});
