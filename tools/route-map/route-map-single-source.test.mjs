import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");

// #1763 단일 기준 가드: 노선도 렌더 레이어(route_map_positions·line_tracks)는
// 앱이 여는 active pack(capital) 하나만 소유한다. base 카탈로그 팩(core)이 낡은
// route map 레이어를 함께 들고 있으면 좌표·라이선스·역 집합이 capital과 어긋나
// "단일 기준"이 깨진다(#1635 완료조건). 이 테스트가 그 재발산을 잡는다.
function openPack(id) {
  const index = JSON.parse(
    readFileSync(
      path.join(root, "apps/mobile/assets/datapacks/index.json"),
      "utf8",
    ),
  );
  const pack = index.packs.find((entry) => entry.id === id);
  assert.ok(pack, `${id} 팩이 index.json에 있어야 함`);
  // index.json의 asset 경로는 apps/mobile 기준 상대경로다.
  const sqliteBytes = gunzipSync(
    readFileSync(path.join(root, "apps/mobile", pack.asset)),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "route-map-single-source-"));
  const sqlitePath = path.join(dir, `${id}.sqlite`);
  writeFileSync(sqlitePath, sqliteBytes);
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  return { database, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function count(database, sql, ...params) {
  return database.prepare(sql).get(...params).n;
}

test("route map 레이어는 active pack(capital)만 소유한다 — core는 비운다", () => {
  const { database, cleanup } = openPack("core");
  try {
    // base 카탈로그 팩은 route map 렌더 레이어를 소유하지 않는다.
    assert.equal(
      count(database, "SELECT COUNT(*) AS n FROM route_map_positions"),
      0,
      "core.sqlite는 route_map_positions를 비워 capital을 단일 기준으로 둔다",
    );
    // core는 route_map_line_tracks 테이블 자체가 없다(capital 전용 레이어).
    const hasTracks = count(
      database,
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='route_map_line_tracks'",
    );
    assert.equal(hasTracks, 0, "core.sqlite는 route_map_line_tracks 테이블이 없어야 함");
  } finally {
    cleanup();
  }
});

test("capital route map은 운행 중단된 인천공항 자기부상선을 도식에서 제외한다", () => {
  const { database, cleanup } = openPack("capital");
  try {
    // 정책: 노선도는 현재 운행 중이며 도시철도로 분류된 노선만 표시한다.
    // 인천공항 자기부상철도(line-cbe75f5287a1)는 2023-11 도시철도 분류 해제·
    // 2025-07 수도권 전철 시스템 제외 → route map 도식에서 제외한다.
    // (카탈로그 lines/station_lines에는 존재할 수 있으나 렌더 레이어에는 없다.)
    assert.equal(
      count(
        database,
        "SELECT COUNT(*) AS n FROM route_map_positions WHERE line_id = 'line-cbe75f5287a1'",
      ),
      0,
      "자기부상선은 route_map_positions에서 제외되어야 함",
    );
    assert.equal(
      count(
        database,
        "SELECT COUNT(*) AS n FROM route_map_line_tracks WHERE line_id = 'line-cbe75f5287a1'",
      ),
      0,
      "자기부상선은 route_map_line_tracks에서도 제외되어야 함",
    );
  } finally {
    cleanup();
  }
});
