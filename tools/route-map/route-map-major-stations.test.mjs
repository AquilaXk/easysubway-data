import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");

// #1764 C: major(주요역) allowlist 정본(major-stations.json) ↔ 앱 상수
// (route_map_major_stations.dart) ↔ 데이터팩 정합을 검증한다. major는 앱
// 런타임 산출이지만, 거점 allowlist는 사람이 검수하므로 드리프트·오타·환승
// 오분류를 계약으로 잡는다.
const decision = JSON.parse(
  readFileSync(path.join(root, "tools/route-map/major-stations.json"), "utf8"),
);

/// route_map_major_stations.dart의 지역별 역명 집합을 파싱한다.
/// 현재 상수는 한 줄·중첩 없는 set이라 아래 정규식으로 충분하다. 여러 줄 set,
/// 중첩 `{}`, 이름 내 따옴표가 생기면 파서를 강화해야 한다(그 경우에도 json↔dart
/// region-key deepEqual이 누락을 실패로 잡으므로 vacuous pass는 아니다).
function parseDartLandmarks() {
  const source = readFileSync(
    path.join(
      root,
      "apps/mobile/lib/features/network_map/domain/route_map_major_stations.dart",
    ),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("{", source.indexOf("routeMapMajorLandmarkStationNamesByRegion")),
  );
  const result = {};
  const entryRe = /'([^']+)':\s*\{([^}]*)\}/g;
  let match;
  while ((match = entryRe.exec(body)) !== null) {
    const region = match[1];
    const names = [...match[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    result[region] = new Set(names);
  }
  return result;
}

function jsonLandmarks() {
  const result = {};
  for (const [region, entries] of Object.entries(decision.landmarksByRegion)) {
    result[region] = new Set(entries.map((entry) => entry.name));
  }
  return result;
}

// capital 팩은 전 지역(수도권·부산·대구·대전·광주)의 route_map_positions를 담는
// 단일 오프라인 팩이다(#1763 단일 기준). per-region 팩 분할이 생기면 이 조회를
// 팩별로 확장해야 한다.
function openCapitalPack() {
  const index = JSON.parse(
    readFileSync(
      path.join(root, "apps/mobile/assets/datapacks/index.json"),
      "utf8",
    ),
  );
  const pack = index.packs.find((entry) => entry.id === "capital");
  const sqliteBytes = gunzipSync(
    readFileSync(path.join(root, "apps/mobile", pack.asset)),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "major-stations-"));
  const sqlitePath = path.join(dir, "capital.sqlite");
  writeFileSync(sqlitePath, sqliteBytes);
  return {
    database: new DatabaseSync(sqlitePath, { readOnly: true }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("major-stations.json 메타·구조", () => {
  assert.equal(decision.artifactKind, "route-map-major-stations");
  assert.equal(decision.issue, 1764);
  assert.ok(/종점/.test(decision.rule) && /비환승/.test(decision.rule));
});

test("json landmark ↔ 앱 Dart 상수 정합", () => {
  const jsonMap = jsonLandmarks();
  const dartMap = parseDartLandmarks();
  assert.deepEqual(
    Object.keys(jsonMap).sort(),
    Object.keys(dartMap).sort(),
    "지역 집합 일치",
  );
  for (const region of Object.keys(jsonMap)) {
    assert.deepEqual(
      [...jsonMap[region]].sort(),
      [...(dartMap[region] ?? new Set())].sort(),
      `${region} landmark 역명 일치`,
    );
  }
});

test("모든 landmark는 데이터팩에 존재하고 비환승이다", () => {
  const { database, cleanup } = openCapitalPack();
  try {
    const jsonMap = jsonLandmarks();
    for (const [region, names] of Object.entries(jsonMap)) {
      for (const name of names) {
        const rows = database
          .prepare(
            `SELECT s.id AS id, COUNT(DISTINCT rmp.line_id) AS lineCount
             FROM stations s
             JOIN route_map_positions rmp ON rmp.station_id = s.id
             WHERE s.name_ko = ? AND rmp.region = ?
             GROUP BY s.id`,
          )
          .all(name, region);
        assert.ok(
          rows.length > 0,
          `${region} '${name}'는 데이터팩에 존재해야 함`,
        );
        // allowlist는 비환승 거점만 둔다(환승역은 transfer로 우선 처리됨).
        for (const row of rows) {
          assert.equal(
            row.lineCount,
            1,
            `${region} '${name}'는 비환승이어야 함(환승은 allowlist 불필요)`,
          );
        }
      }
    }
  } finally {
    cleanup();
  }
});
