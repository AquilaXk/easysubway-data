import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  buildPolylinePack,
  equidistantInterior,
  loadAndValidateDefs,
  planLine,
  polylineLength,
} from "./build-polyline-pack.mjs";

// ── fixture: 가상 소형 팩 + 정의 ──────────────────────────────────────────
//
// 3개 노선:
//  ① 닫힌 순환 노선(2호선): 사각 루프, 고정 정점 4·중간역 8.
//  ② 방사 직선 노선(4호선): 세로 직선, anchor "센터"를 2호선과 공유.
//  ③ 분기 노선(7호선): 가로 본선 + 세로 지선 1개.

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// 2호선 사각 루프: 코너 4개 고정, 변마다 중간역 2개(총 8).
const L2_CORNERS = [
  { x: 100, y: 100 }, // seq0 코너
  { x: 300, y: 100 }, // seq3 코너
  { x: 300, y: 300 }, // seq6 코너
  { x: 100, y: 300 }, // seq9 코너
];
const L2_STATIONS = []; // {id, seq}
for (let i = 0; i < 12; i += 1) L2_STATIONS.push({ id: `l2-${i}`, seq: i });
const L2_FIXED = new Set([0, 3, 6, 9]);

// 4호선 세로 직선: (100,100)→(100,500), 고정 양끝 + 중간역 2.
const L4_STATIONS = [
  { id: "l4-0", seq: 0, coord: { x: 100, y: 100 } }, // 센터 공유·고정
  { id: "l4-1", seq: 1 },
  { id: "l4-2", seq: 2 },
  { id: "l4-3", seq: 3, coord: { x: 100, y: 500 } }, // 종점·고정
];

// 7호선 본선 (0,100)→(400,100), 분기점 (200,100), 지선 (200,100)→(200,300).
const L7_STATIONS = [
  { id: "l7-0", seq: 0, coord: { x: 0, y: 100 } }, // 종점·고정
  { id: "l7-1", seq: 1 },
  { id: "l7-2", seq: 2 },
  { id: "l7-3", seq: 3, coord: { x: 200, y: 100 } }, // 분기역·고정
  { id: "l7-4", seq: 4 },
  { id: "l7-5", seq: 5 },
  { id: "l7-6", seq: 6, coord: { x: 400, y: 100 } }, // 본선 종점·고정
  { id: "l7-7", seq: 7 }, // 지선 중간역
  { id: "l7-8", seq: 8 }, // 지선 중간역
  { id: "l7-9", seq: 9, coord: { x: 200, y: 300 } }, // 지선 종점·고정
];

const META = {
  source_id: "test-src",
  source_name: "테스트 출처",
  source_url: "https://example.test",
  license: "CC0",
  license_status: "approved",
  commercial_use_allowed: 1,
  attribution_required: 0,
};

function buildFixturePack() {
  const dir = mkdtempSync(path.join(tmpdir(), "polyline-fixture-"));
  const sqlitePath = path.join(dir, "pack.sqlite");
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE lines (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL);
    CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL);
    CREATE TABLE station_lines (
      station_id TEXT NOT NULL, line_id TEXT NOT NULL,
      station_code TEXT NOT NULL DEFAULT '', line_sequence INTEGER NOT NULL,
      platform_info TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (station_id, line_id)
    );
    CREATE TABLE route_map_positions (
      station_id TEXT NOT NULL, line_id TEXT NOT NULL, region TEXT NOT NULL DEFAULT '',
      x INTEGER NOT NULL CHECK (x >= 0), y INTEGER NOT NULL CHECK (y >= 0),
      label_dx INTEGER NOT NULL DEFAULT 0, label_dy INTEGER NOT NULL DEFAULT 0,
      up_path TEXT NOT NULL DEFAULT '', down_path TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL, source_name TEXT NOT NULL, source_url TEXT NOT NULL,
      license TEXT NOT NULL, license_status TEXT NOT NULL,
      commercial_use_allowed INTEGER NOT NULL DEFAULT 0,
      attribution_required INTEGER NOT NULL DEFAULT 1,
      reviewed_at INTEGER, updated_at INTEGER,
      label_polygon TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (station_id, line_id, region)
    );
    CREATE TABLE route_map_line_tracks (
      region TEXT NOT NULL, line_id TEXT NOT NULL, track_index INTEGER NOT NULL,
      path TEXT NOT NULL, svg_color TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL, source_name TEXT NOT NULL, source_url TEXT NOT NULL,
      license TEXT NOT NULL, license_status TEXT NOT NULL,
      commercial_use_allowed INTEGER NOT NULL DEFAULT 0,
      attribution_required INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER,
      PRIMARY KEY (region, line_id, track_index)
    );
    CREATE TABLE unrelated (k TEXT PRIMARY KEY, v TEXT);
  `);

  const insLine = db.prepare("INSERT INTO lines VALUES (?, ?)");
  insLine.run("line-2", "테스트 2호선");
  insLine.run("line-4", "테스트 4호선");
  insLine.run("line-7", "테스트 7호선");

  const insStation = db.prepare("INSERT INTO stations VALUES (?, ?)");
  const insSL = db.prepare(
    "INSERT INTO station_lines (station_id, line_id, line_sequence) VALUES (?, ?, ?)",
  );
  const insPos = db.prepare(
    `INSERT INTO route_map_positions
       (station_id, line_id, region, x, y, source_id, source_name, source_url,
        license, license_status, commercial_use_allowed, attribution_required)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insTrack = db.prepare(
    `INSERT INTO route_map_line_tracks
       (region, line_id, track_index, path, source_id, source_name, source_url,
        license, license_status, commercial_use_allowed, attribution_required)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const seen = new Set();
  const addStation = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    insStation.run(id, id);
  };

  const addLine = (lineId, stations) => {
    for (const s of stations) {
      addStation(s.id);
      insSL.run(s.id, lineId, s.seq);
      // baseline 좌표는 임의(스파이크가 전부 교체) — 1 이상으로.
      insPos.run(
        s.id, lineId, "수도권", 1, 1, META.source_id, META.source_name,
        META.source_url, META.license, META.license_status,
        META.commercial_use_allowed, META.attribution_required,
      );
    }
    insTrack.run(
      "수도권", lineId, 0, "M 1 1 L 2 2", META.source_id, META.source_name,
      META.source_url, META.license, META.license_status,
      META.commercial_use_allowed, META.attribution_required,
    );
  };

  addLine("line-2", L2_STATIONS);
  addLine("line-4", L4_STATIONS);
  addLine("line-7", L7_STATIONS);

  // 다른 region(부산) — 스파이크가 건드리면 안 됨.
  addStation("busan-a");
  insSL.run("busan-a", "line-2", 99);
  insPos.run(
    "busan-a", "line-2", "부산", 5, 5, META.source_id, META.source_name,
    META.source_url, META.license, META.license_status,
    META.commercial_use_allowed, META.attribution_required,
  );
  insTrack.run(
    "부산", "line-2", 0, "M 5 5 L 6 6", META.source_id, META.source_name,
    META.source_url, META.license, META.license_status,
    META.commercial_use_allowed, META.attribution_required,
  );
  db.prepare("INSERT INTO unrelated VALUES (?, ?)").run("keep", "me");

  db.close();
  const gz = gzipSync(readFileSync(sqlitePath), { level: 9, mtime: 0 });
  const packPath = path.join(dir, "base.sqlite.gz");
  writeFileSync(packPath, gz);
  return { dir, packPath };
}

// 유효한 정의: 3개 노선 전부.
function validDefs() {
  return {
    region: "수도권",
    anchors: {
      센터: { x: 100, y: 100 },
    },
    lines: [
      {
        name: "테스트 2호선",
        loop: true,
        vertices: [
          { anchor: "센터", station: "l2-0" },
          { x: 300, y: 100, station: "l2-3" },
          { x: 300, y: 300, station: "l2-6" },
          { x: 100, y: 300, station: "l2-9" },
        ],
      },
      {
        name: "테스트 4호선",
        vertices: [
          { anchor: "센터", station: "l4-0" },
          { x: 100, y: 500, station: "l4-3" },
        ],
      },
      {
        name: "테스트 7호선",
        vertices: [
          { x: 0, y: 100, station: "l7-0" },
          { x: 200, y: 100, station: "l7-3" },
          { x: 400, y: 100, station: "l7-6" },
        ],
        spurs: [
          {
            vertices: [
              { x: 200, y: 100, station: "l7-3" },
              { x: 200, y: 300, station: "l7-9" },
            ],
          },
        ],
      },
    ],
  };
}

// ── 순수 기하 헬퍼 ─────────────────────────────────────────────────────────

test("equidistantInterior: 구간 균등 분할(상대오차 ≤1%)", () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 90, y: 0 },
    { x: 90, y: 90 },
  ];
  const pts = equidistantInterior(poly, 5);
  assert.equal(pts.length, 5);
  const total = polylineLength(poly);
  const step = total / 6;
  // 인접 간격(끝점 포함)이 모두 step에 근접.
  const seq = [{ x: 0, y: 0 }, ...pts, { x: 90, y: 90 }];
  const gaps = [];
  for (let i = 1; i < seq.length; i += 1) {
    gaps.push(Math.hypot(seq[i].x - seq[i - 1].x, seq[i].y - seq[i - 1].y));
  }
  for (const g of gaps) {
    assert.ok(Math.abs(g - step) / step <= 0.01, `간격 ${g} vs ${step}`);
  }
});

// ── 정의 검증 ──────────────────────────────────────────────────────────────

test("8선형 위반 정의 → 정점 index 포함 에러", () => {
  const defs = validDefs();
  // 2호선 두 번째 정점을 대각선(30°에 가까운 비8선형)으로.
  defs.lines[0].vertices[1] = { x: 320, y: 180, station: "l2-3" };
  assert.throws(() => loadAndValidateDefs(defs), /8선형/);
  assert.throws(() => loadAndValidateDefs(defs), /정점 0→1/);
});

test("anchor 오탈자 → 에러", () => {
  const defs = validDefs();
  defs.lines[1].vertices[0] = { anchor: "센타", station: "l4-0" }; // 오탈자
  assert.throws(() => loadAndValidateDefs(defs), /앵커 "센타"/);
});

test("corridor 불일치 → 에러", () => {
  const defs = validDefs();
  defs.corridors = [
    {
      name: "불일치",
      members: [
        { line: "테스트 2호선", range: [0, 1] },
        { line: "테스트 7호선", range: [0, 1] },
      ],
      offsetOrder: ["테스트 2호선", "테스트 7호선"],
    },
  ];
  assert.throws(() => loadAndValidateDefs(defs), /일치하지 않습니다/);
});

test("corridor 일치 → 통과", () => {
  const defs = validDefs();
  // 2호선 [0,1] = (100,100)->(300,100). 7호선에 동일 좌표 구간 얹기.
  defs.lines[2].vertices = [
    { x: 100, y: 100, station: "l7-0" },
    { x: 300, y: 100, station: "l7-3" },
    { x: 400, y: 100, station: "l7-6" },
  ];
  defs.corridors = [
    {
      name: "일치",
      members: [
        { line: "테스트 2호선", range: [0, 1] },
        { line: "테스트 7호선", range: [0, 1] },
      ],
      offsetOrder: ["테스트 2호선", "테스트 7호선"],
    },
  ];
  assert.doesNotThrow(() => loadAndValidateDefs(defs));
});

// ── planLine 균등 투영·고정 정점 ─────────────────────────────────────────

test("균등 투영: 닫힌 루프 구간 내 인접 간격 상대오차 ≤1%", () => {
  const model = loadAndValidateDefs(validDefs());
  const l2 = model.lines[0];
  const seq = L2_STATIONS.map((s) => s.id);
  const { positions } = planLine({ line: l2, sequence: seq });
  const byId = new Map(positions.map((p) => [p.stationId, p]));
  // 변 0 (l2-0 → l2-3): 중간 l2-1, l2-2. 4점 등간격.
  const side = ["l2-0", "l2-1", "l2-2", "l2-3"].map((id) => byId.get(id));
  const gaps = [];
  for (let i = 1; i < side.length; i += 1) {
    gaps.push(Math.hypot(side[i].x - side[i - 1].x, side[i].y - side[i - 1].y));
  }
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  for (const g of gaps) {
    assert.ok(Math.abs(g - avg) / avg <= 0.01, `루프 간격 ${g} vs ${avg}`);
  }
  // 모든 12개 역 배치.
  assert.equal(positions.length, 12);
  // [I-2] wrap 구간(l2-9→l2-0, 세로선 x=100) 중간역 좌표 검증.
  // l2-9(100,300)→l2-0(100,100): 길이 200, 중간역 2개 → step≈66.667.
  // l2-10: x=100, y≈233.333 / l2-11: x=100, y≈166.667.
  const p10 = byId.get("l2-10");
  const p11 = byId.get("l2-11");
  assert.equal(p10.x, 100, "l2-10 x=100 이어야 함(세로 wrap 구간)");
  assert.ok(p10.y > 100 && p10.y < 300, `l2-10 y=${p10.y} — 100~300 범위 벗어남`);
  assert.equal(p11.x, 100, "l2-11 x=100 이어야 함(세로 wrap 구간)");
  assert.ok(p11.y > 100 && p11.y < 300, `l2-11 y=${p11.y} — 100~300 범위 벗어남`);
  // l2-10 이 l2-11 보다 l2-9(y=300)에 가까워야 함(순서 검증).
  assert.ok(p10.y > p11.y, `wrap 순서: l2-10(y=${p10.y}) > l2-11(y=${p11.y}) 기대`);
});

test("고정 정점 역 = anchor 좌표, 공유 anchor 두 노선 좌표 일치", () => {
  const model = loadAndValidateDefs(validDefs());
  const l2 = planLine({ line: model.lines[0], sequence: L2_STATIONS.map((s) => s.id) });
  const l4 = planLine({ line: model.lines[1], sequence: L4_STATIONS.map((s) => s.id) });
  const p2 = l2.positions.find((p) => p.stationId === "l2-0");
  const p4 = l4.positions.find((p) => p.stationId === "l4-0");
  assert.deepEqual({ x: p2.x, y: p2.y }, { x: 100, y: 100 }); // anchor 좌표
  assert.deepEqual({ x: p4.x, y: p4.y }, { x: 100, y: 100 }); // 공유 anchor 일치
});

test("분기 노선: 지선 track_index=1, 지선 중간역 배치", () => {
  const model = loadAndValidateDefs(validDefs());
  const l7 = planLine({ line: model.lines[2], sequence: L7_STATIONS.map((s) => s.id) });
  const trackIdx = l7.tracks.map((t) => t.trackIndex).sort((a, b) => a - b);
  assert.deepEqual(trackIdx, [0, 1]);
  const byId = new Map(l7.positions.map((p) => [p.stationId, p]));
  // 지선 종점 고정.
  assert.deepEqual({ x: byId.get("l7-9").x, y: byId.get("l7-9").y }, { x: 200, y: 300 });
  // 지선 중간역 l7-7, l7-8은 x=200 세로선 위, y는 100~300 사이.
  for (const id of ["l7-7", "l7-8"]) {
    assert.equal(Math.round(byId.get(id).x), 200);
    assert.ok(byId.get(id).y > 100 && byId.get(id).y < 300);
  }
  assert.equal(l7.positions.length, 10);
});

test("세그먼트 예산 위반 → 실패", () => {
  const model = loadAndValidateDefs(validDefs());
  // 4호선 구간 길이 400. 중간역 2개 → 필요 3×min-gap. min-gap 200이면 600>400 위반.
  assert.throws(
    () => planLine({ line: model.lines[1], sequence: L4_STATIONS.map((s) => s.id), minGap: 200 }),
    /필요 길이/,
  );
});

// ── [I-1] 역방향 폴리라인 방향성 검증 ─────────────────────────────────────

test("[I-1] 역방향 비루프 폴리라인 → seqPos 방향성 에러", () => {
  // 4호선: l4-0(seqPos=0)→l4-3(seqPos=3) 정방향을 역순으로 넘기면 에러.
  const model = loadAndValidateDefs(validDefs());
  const l4 = model.lines[1]; // 테스트 4호선(비루프)
  const reversedLine = { ...l4, vertices: [...l4.vertices].reverse() };
  // 역순 정점: [{l4-3, seqPos=3}, {l4-0, seqPos=0}] — seqPos 감소.
  assert.throws(
    () => planLine({ line: reversedLine, sequence: L4_STATIONS.map((s) => s.id) }),
    /전진 방향과 반대/,
  );
});

test("[I-1] 역방향 루프 폴리라인(seqPos=[9,6,3,0]) → seqPos 방향성 에러", () => {
  // 2호선(loop): 코너 seqPos=[0,3,6,9]를 역순([9,6,3,0])으로 넘기면 에러.
  // I-1 시나리오 재현: 정점 4개 seqPos=[9,6,3,0].
  const model = loadAndValidateDefs(validDefs());
  const l2 = model.lines[0]; // 테스트 2호선(loop)
  const reversedLine = { ...l2, vertices: [...l2.vertices].reverse() };
  // 역순 정점: [{l2-9,seqPos=9},{l2-6,seqPos=6},{l2-3,seqPos=3},{l2-0,seqPos=0}].
  assert.throws(
    () => planLine({ line: reversedLine, sequence: L2_STATIONS.map((s) => s.id) }),
    /전진 방향과 반대/,
  );
});

// ── 전체 파이프라인(팩) ──────────────────────────────────────────────────

test("buildPolylinePack: baseline 불변 + 스파이크에 대상 노선만", () => {
  const { dir, packPath } = buildFixturePack();
  const outPath = path.join(dir, "spike.sqlite.gz");
  try {
    const baseHashBefore = sha256(readFileSync(packPath));
    const result = buildPolylinePack({
      defs: validDefs(),
      basePackPath: packPath,
      outPath,
      region: "수도권",
    });
    assert.equal(result.check, false);

    // baseline 파일 불변.
    assert.equal(sha256(readFileSync(packPath)), baseHashBefore, "baseline 팩 변경됨");

    // 스파이크 팩 검증.
    const spikeSqlite = gunzipSync(readFileSync(outPath));
    const spikePath = path.join(dir, "spike.sqlite");
    writeFileSync(spikePath, spikeSqlite);
    const db = new DatabaseSync(spikePath, { readOnly: true });

    // 수도권 tracks: 정의 3개 노선만(line-2/4/7), track 개수 = 3본선 + 7호선 지선 1.
    const capLines = db
      .prepare("SELECT DISTINCT line_id FROM route_map_line_tracks WHERE region='수도권' ORDER BY line_id")
      .all()
      .map((r) => r.line_id);
    assert.deepEqual(capLines, ["line-2", "line-4", "line-7"]);
    const l7tracks = db
      .prepare("SELECT track_index FROM route_map_line_tracks WHERE region='수도권' AND line_id='line-7' ORDER BY track_index")
      .all()
      .map((r) => r.track_index);
    assert.deepEqual(l7tracks, [0, 1]);

    // 수도권 positions: 정의 노선 역만, 좌표 교체됨(1,1 아님).
    const posCount = db
      .prepare("SELECT COUNT(*) AS n FROM route_map_positions WHERE region='수도권'")
      .get().n;
    assert.equal(posCount, 12 + 4 + 10);
    const l2corner = db
      .prepare("SELECT x, y FROM route_map_positions WHERE region='수도권' AND station_id='l2-0' AND line_id='line-2'")
      .get();
    assert.deepEqual({ x: l2corner.x, y: l2corner.y }, { x: 100, y: 100 });

    // 다른 region(부산)·타 테이블 불변.
    const busan = db
      .prepare("SELECT x, y FROM route_map_positions WHERE region='부산' AND station_id='busan-a'")
      .get();
    assert.deepEqual({ x: busan.x, y: busan.y }, { x: 5, y: 5 });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM route_map_line_tracks WHERE region='부산'").get().n,
      1,
    );
    assert.equal(db.prepare("SELECT v FROM unrelated WHERE k='keep'").get().v, "me");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── [CR-1] --region 오버라이드 불일치 검증 ────────────────────────────────

test("[CR-1] --region이 defs.region과 다르면 즉시 에러(두 값 포함)", () => {
  const { dir, packPath } = buildFixturePack();
  try {
    // defs.region = "수도권", CLI region = "부산" → 불일치 에러.
    assert.throws(
      () =>
        buildPolylinePack({
          defs: validDefs(),
          basePackPath: packPath,
          outPath: path.join(dir, "spike.sqlite.gz"),
          region: "부산",
        }),
      (err) => {
        assert.ok(/불일치/.test(err.message), `에러 메시지에 "불일치" 없음: ${err.message}`);
        assert.ok(/부산/.test(err.message), `에러 메시지에 CLI 값 "부산" 없음: ${err.message}`);
        assert.ok(/수도권/.test(err.message), `에러 메시지에 defs 값 "수도권" 없음: ${err.message}`);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[CR-1] --region이 defs.region과 동일하면 통과", () => {
  const { dir, packPath } = buildFixturePack();
  try {
    // defs.region = "수도권", CLI region = "수도권" → 일치, 에러 없음.
    assert.doesNotThrow(() =>
      buildPolylinePack({
        defs: validDefs(),
        basePackPath: packPath,
        outPath: path.join(dir, "spike2.sqlite.gz"),
        region: "수도권",
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[CR-1] defs가 null이면 TypeError 아닌 검증 에러", () => {
  const { dir, packPath } = buildFixturePack();
  try {
    assert.throws(
      () =>
        buildPolylinePack({
          defs: null,
          basePackPath: packPath,
          outPath: path.join(dir, "spike-null.sqlite.gz"),
          region: "수도권",
        }),
      (err) => {
        assert.ok(
          !(err instanceof TypeError),
          `TypeError가 발생했습니다(defs 검증 전 접근 버그): ${err}`,
        );
        assert.ok(/객체가 아닙/.test(err.message), `예상 메시지 없음: ${err.message}`);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── [CR-2] --min-gap / --target-gap 숫자 검증 ────────────────────────────

test("[CR-2] NaN minGap → 양의 유한수 에러(planLine 직접 호출)", () => {
  const model = loadAndValidateDefs(validDefs());
  assert.throws(
    () => planLine({ line: model.lines[1], sequence: L4_STATIONS.map((s) => s.id), minGap: NaN }),
    /양의 유한수/,
  );
});

test("[CR-2] 음수 minGap → 에러", () => {
  const model = loadAndValidateDefs(validDefs());
  assert.throws(
    () => planLine({ line: model.lines[1], sequence: L4_STATIONS.map((s) => s.id), minGap: -1 }),
    /양의 유한수/,
  );
});

test("[CR-2] 0 minGap → 에러", () => {
  const model = loadAndValidateDefs(validDefs());
  assert.throws(
    () => planLine({ line: model.lines[1], sequence: L4_STATIONS.map((s) => s.id), minGap: 0 }),
    /양의 유한수/,
  );
});

test("[CR-2] NaN targetGap → buildPolylinePack 에러", () => {
  const { dir, packPath } = buildFixturePack();
  try {
    assert.throws(
      () =>
        buildPolylinePack({
          defs: validDefs(),
          basePackPath: packPath,
          outPath: path.join(dir, "spike.sqlite.gz"),
          targetGap: NaN,
        }),
      /양의 유한수/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPolylinePack --check: 파일 미기록 + 통계", () => {
  const { dir, packPath } = buildFixturePack();
  try {
    const result = buildPolylinePack({
      defs: validDefs(),
      basePackPath: packPath,
      region: "수도권",
      check: true,
    });
    assert.equal(result.check, true);
    assert.equal(result.stats.length, 3);
    const l7 = result.stats.find((s) => s.line === "테스트 7호선");
    assert.equal(l7.spurs, 1);
    assert.equal(l7.positions, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
