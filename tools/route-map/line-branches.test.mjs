import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");

// #1793 분기 데이터 정본(line-branches.json)이 실제 팩과 정합하는지 계약으로 고정한다.
// junction·spur 역명이 해당 노선에 존재해야 octolinearize 분기가 올바로 그려진다.
const branches = JSON.parse(
  readFileSync(path.join(root, "tools/route-map/line-branches.json"), "utf8"),
);

function openCapital() {
  const index = JSON.parse(readFileSync(path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"));
  const pack = index.packs.find((p) => p.id === "capital");
  const bytes = gunzipSync(readFileSync(path.join(root, "apps/mobile", pack.asset)));
  const dir = mkdtempSync(path.join(tmpdir(), "line-branches-"));
  const sqlitePath = path.join(dir, "capital.sqlite");
  writeFileSync(sqlitePath, bytes);
  return { db: new DatabaseSync(sqlitePath, { readOnly: true }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("line-branches 메타·구조", () => {
  assert.equal(branches.artifactKind, "route-map-line-branches");
  assert.equal(branches.issue, 1793);
  assert.ok(branches.linesByRegion && typeof branches.linesByRegion === "object");
});

// 생성된 팩의 track path를 파싱해 정점 배열로. (verticesToPath는 좌표를 그대로 직렬화)
function pathVertices(path) {
  const nums = [...String(path).matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}
const hasVertex = (verts, p, tol = 1e-3) =>
  p != null && verts.some((v) => Math.abs(v.x - p.x) < tol && Math.abs(v.y - p.y) < tol);

// 노선의 역명→좌표(route_map_positions join, 하드코딩 금지).
function lineStationPos(db, region, lineId) {
  const map = new Map();
  for (const r of db
    .prepare(
      "SELECT s.name_ko AS n, rmp.x, rmp.y FROM route_map_positions rmp " +
        "JOIN stations s ON s.id = rmp.station_id WHERE rmp.region = ? AND rmp.line_id = ?",
    )
    .all(region, lineId)) {
    map.set(r.n, { x: r.x, y: r.y });
  }
  return map;
}
function lineTracks(db, region, lineId) {
  return db
    .prepare("SELECT track_index, path FROM route_map_line_tracks WHERE region = ? AND line_id = ? ORDER BY track_index")
    .all(region, lineId)
    .map((r) => ({ trackIndex: r.track_index, verts: pathVertices(r.path) }));
}

test("생성 팩 위상: 본선은 spur 역 제외, spur track은 junction에서 시작한다", () => {
  const { db, cleanup } = openCapital();
  try {
    for (const [region, lines] of Object.entries(branches.linesByRegion)) {
      for (const [lineName, specs] of Object.entries(lines)) {
        const lineId = db.prepare("SELECT id FROM lines WHERE name_ko = ?").get(lineName).id;
        const pos = lineStationPos(db, region, lineId);
        const tracks = lineTracks(db, region, lineId);
        for (const spec of specs) {
          const jn = pos.get(spec.junction);
          const spurPos = spec.spur.map((n) => pos.get(n)).filter(Boolean);
          // spur track = spur 역 전부를 정점으로 갖는 조각(본선은 이들을 제외하므로 유일).
          const spurTrack = tracks.find((t) => spurPos.every((p) => hasVertex(t.verts, p)));
          assert.ok(spurTrack, `${lineName} ${spec.name}: spur track(모든 spur 역 포함)이 있어야 함`);
          // spur track은 junction 좌표에서 시작한다.
          assert.ok(
            hasVertex([spurTrack.verts[0]], jn),
            `${lineName} ${spec.name}: spur track 시작 정점이 junction '${spec.junction}' 좌표와 일치`,
          );
          // 본선(및 타 조각)에는 spur 역(junction 제외)이 없다 — 잘못된 인라인 연결 제거.
          for (const [i, p] of spec.spur.map((n) => pos.get(n)).entries()) {
            if (!p) continue;
            for (const t of tracks) {
              if (t === spurTrack) continue;
              assert.ok(
                !hasVertex(t.verts, p),
                `${lineName} spur '${spec.spur[i]}'가 spur track 외 조각(#${t.trackIndex})에 없어야 함`,
              );
            }
          }
        }
      }
    }
  } finally {
    cleanup();
  }
});

test("생성 팩 위상: 2호선 신설동-신당 오직결 제거·성수지선 분리", () => {
  const { db, cleanup } = openCapital();
  try {
    const region = "수도권";
    const lineId = db.prepare("SELECT id FROM lines WHERE name_ko = ?").get("수도권 2호선").id;
    const pos = lineStationPos(db, region, lineId);
    const tracks = lineTracks(db, region, lineId);
    assert.ok(tracks.length >= 3, `2호선 track 조각 ≥3 (본선+지선 2), 실제 ${tracks.length}`);
    const mainTrack = tracks.find((t) => hasVertex(t.verts, pos.get("신당")));
    assert.ok(mainTrack, "신당을 포함한 본선 track이 있어야 함");
    assert.ok(!hasVertex(mainTrack.verts, pos.get("신설동")), "본선에 신설동이 없어야 함(오직결 제거)");
    // 성수지선: 신설동은 성수(junction)에서 시작하는 조각에만.
    const spurTrack = tracks.find((t) => hasVertex(t.verts, pos.get("신설동")));
    assert.ok(spurTrack, "신설동을 포함한 성수지선 track이 있어야 함");
    assert.ok(hasVertex([spurTrack.verts[0]], pos.get("성수")), "성수지선 시작 정점이 성수(junction) 좌표와 일치");
  } finally {
    cleanup();
  }
});

test("junction·spur 역명이 해당 노선에 존재하고 spur는 비어있지 않다", () => {
  const { db, cleanup } = openCapital();
  try {
    for (const [region, lines] of Object.entries(branches.linesByRegion)) {
      for (const [lineName, specs] of Object.entries(lines)) {
        const line = db.prepare("SELECT id FROM lines WHERE name_ko = ?").get(lineName);
        assert.ok(line, `${lineName} 노선이 있어야 함`);
        const stationsOnLine = new Set(
          db.prepare(`SELECT s.name_ko AS n FROM route_map_positions rmp JOIN stations s ON s.id = rmp.station_id WHERE rmp.region = ? AND rmp.line_id = ?`).all(region, line.id).map((r) => r.n),
        );
        for (const spec of specs) {
          assert.ok(stationsOnLine.has(spec.junction), `${lineName} junction '${spec.junction}' 존재`);
          assert.ok(spec.spur.length > 0, `${lineName} ${spec.name} spur 비어있지 않음`);
          for (const st of spec.spur) {
            assert.ok(stationsOnLine.has(st), `${lineName} spur '${st}' 존재`);
          }
        }
      }
    }
  } finally {
    cleanup();
  }
});
