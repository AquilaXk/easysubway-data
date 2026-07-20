import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnnotatedOctolinearVertices,
  buildFilletedLocalPath,
  buildLineRuns,
  parseScaledLayerTransform,
  replaceStrokePaths,
} from "./octolinearize-svg-route-lines.mjs";

const IDENT = { tx: 0, ty: 0, scale: 1 };

test("parseScaledLayerTransform: 기존 감사 도구와 동일 파싱", () => {
  const svg = '<g id="main-map-scaled-layer" transform="translate(70 138) scale(0.455)"/>';
  assert.deepEqual(parseScaledLayerTransform(svg), { tx: 70, ty: 138, scale: 0.455 });
});

test("buildAnnotatedOctolinearVertices: 8선형 정렬 역은 dogleg 없음(전부 실역)", () => {
  const runNodes = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 100 }]; // 0°→45°
  const verts = buildAnnotatedOctolinearVertices(runNodes);
  assert.equal(verts.length, 3);
  assert.ok(verts.every((v) => v.synthetic === false));
});

test("buildAnnotatedOctolinearVertices: 비8선형 쌍은 dogleg 합성 정점 삽입", () => {
  const runNodes = [{ x: 0, y: 0 }, { x: 100, y: 30 }]; // ~16.7° — 8선형 아님
  const verts = buildAnnotatedOctolinearVertices(runNodes);
  assert.equal(verts.length, 3);
  assert.equal(verts[0].synthetic, false);
  assert.equal(verts[1].synthetic, true); // dogleg 코너
  assert.equal(verts[2].synthetic, false);
  // 코너를 지나는 두 세그먼트 모두 8선형이어야 함(45°+수평/수직).
  const dx1 = verts[1].x - verts[0].x, dy1 = verts[1].y - verts[0].y;
  const dx2 = verts[2].x - verts[1].x, dy2 = verts[2].y - verts[1].y;
  assert.ok(Math.abs(dx1) < 1e-9 || Math.abs(dy1) < 1e-9 || Math.abs(Math.abs(dx1) - Math.abs(dy1)) < 1e-9);
  assert.ok(Math.abs(dx2) < 1e-9 || Math.abs(dy2) < 1e-9 || Math.abs(Math.abs(dx2) - Math.abs(dy2)) < 1e-9);
});

test("buildFilletedLocalPath: 실역 정점은 sharp(정확히 통과)", () => {
  const verts = [
    { x: 0, y: 0, synthetic: false },
    { x: 100, y: 0, synthetic: false },
    { x: 100, y: 100, synthetic: false },
  ];
  const d = buildFilletedLocalPath(verts, IDENT, 6);
  // 필렛(C 명령) 없이 M/L만 — 정점을 정확히 지난다.
  assert.ok(!d.includes("C"));
  assert.equal(d, "M 0 0 L 100 0 L 100 100");
});

test("buildFilletedLocalPath: 합성 dogleg 정점에만 짧은 필렛(C)", () => {
  const verts = [
    { x: 0, y: 0, synthetic: false },
    { x: 100, y: 0, synthetic: true }, // 코너
    { x: 100, y: 100, synthetic: false },
  ];
  const d = buildFilletedLocalPath(verts, IDENT, 6);
  assert.ok(d.includes("C")); // 필렛 곡선 포함
  // 필렛은 코너에서 반경만큼만 벗어난다 — chord가 작아야 함(코너 예외 임계 20px 이내).
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  // 첫 L 종점(P0)이 코너(100,0)에서 x축 방향으로 radius(6) 이내여야.
  const p0x = nums[2]; // "M 0 0" -> nums[0,1]; "L p0x p0y" -> nums[2,3]
  assert.ok(Math.abs(100 - p0x) <= 6 + 1e-6);
});

test("buildFilletedLocalPath: 짧은 leg는 필렛 반경을 축소(겹침 방지)", () => {
  const verts = [
    { x: 0, y: 0, synthetic: false },
    { x: 4, y: 0, synthetic: true }, // leg 4px, radius 6보다 짧음
    { x: 4, y: 4, synthetic: false },
  ];
  const d = buildFilletedLocalPath(verts, IDENT, 6);
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const p0x = nums[2];
  // rr = min(6, 4*0.45, 4*0.45) = 1.8 → P0.x = 4 - 1.8 = 2.2
  assert.ok(Math.abs(p0x - 2.2) < 0.01);
});

test("buildFilletedLocalPath: minClearancePx를 주면 leg가 짧을 때 필렛을 생략(sharp)한다", () => {
  // #2068 4차: G-NODE-STRAIGHT(노드 직선 여유) 하드 게이트 — leg(4px)가
  // minClearancePx(6px)보다 짧으면 필렛 자체를 생략해 leg 전체가 직선으로
  // 남는다(노드 바로 앞에서 곡선이 시작되지 않는다).
  const verts = [
    { x: 0, y: 0, synthetic: false },
    { x: 4, y: 0, synthetic: true },
    { x: 4, y: 4, synthetic: false },
  ];
  const d = buildFilletedLocalPath(verts, IDENT, 6, 6);
  assert.ok(!d.includes("C")); // 필렛 없음 — sharp corner.
  assert.equal(d, "M 0 0 L 4 0 L 4 4");
});

test("buildFilletedLocalPath: minClearancePx 미지정(기본 0)이면 기존 동작 유지", () => {
  const verts = [
    { x: 0, y: 0, synthetic: false },
    { x: 4, y: 0, synthetic: true },
    { x: 4, y: 4, synthetic: false },
  ];
  const d = buildFilletedLocalPath(verts, IDENT, 6);
  assert.ok(d.includes("C")); // 기본값은 기존처럼 필렛 적용.
});

test("buildFilletedLocalPath: local 변환(render→SVG local) 적용", () => {
  const verts = [
    { x: 70, y: 138, synthetic: false },
    { x: 70 + 45.5, y: 138, synthetic: false }, // render 45.5px = local 100px @scale 0.455
  ];
  const transform = { tx: 70, ty: 138, scale: 0.455 };
  const d = buildFilletedLocalPath(verts, transform, 6);
  assert.equal(d, "M 0 0 L 100 0");
});

test("buildLineRuns: 순수 함수 — sequence 순 노드 조회(fake db)", () => {
  const rows = [
    { name: "A", x: 0, y: 0, seq: 1 },
    { name: "B", x: 100, y: 0, seq: 2 },
    { name: "C", x: 200, y: 0, seq: 3 },
  ];
  const fakeDb = { prepare: () => ({ all: () => rows }) };
  const { runs, nodeCount } = buildLineRuns(fakeDb, "수도권", "line-x", []);
  assert.equal(nodeCount, 3);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 3);
});

test("replaceStrokePaths: stroke 있는 그룹은 비-stroke 장식 요소 보존", () => {
  const groupText =
    '<title id="t1">6호선</title>' +
    '<path id="_6호선-2" fill="#fff" d="M0 0z" />' + // 장식(비-stroke) — 보존돼야.
    '<path id="_6호선-3" fill="none" stroke="#7c4932" d="M0 0 L10 0" />';
  const out = replaceStrokePaths(groupText, "6", [{ d: "M 1 1 L 2 2" }], 'fill="none" stroke="#7c4932"', true);
  assert.ok(out.includes('fill="#fff" d="M0 0z"')); // 장식 요소 그대로.
  assert.ok(out.includes('id="_6-octo-0"'));
  assert.ok(!out.includes("_6호선-3")); // 원래 stroke path는 삭제.
});

test("replaceStrokePaths: stroke 없는 그룹(fill-ribbon)은 전부 치환", () => {
  const groupText = '<title id="t2">서해선</title><path id="_서해선-2" fill="#5eac41" d="M0 0z" />';
  const out = replaceStrokePaths(groupText, "seohae", [{ d: "M 1 1 L 2 2" }], 'fill="none" stroke="#5eac41"', false);
  assert.ok(!out.includes("_서해선-2")); // 낡은 fill-ribbon 완전 제거.
  assert.ok(out.includes('id="_seohae-octo-0"'));
  assert.equal((out.match(/<path\b/g) || []).length, 1); // path 하나만 남음.
});

test("buildLineRuns: 지선 junction+spur 별도 run", () => {
  const rows = [
    { name: "본선1", x: 0, y: 0, seq: 1 },
    { name: "분기역", x: 100, y: 0, seq: 2 },
    { name: "본선2", x: 200, y: 0, seq: 3 },
    { name: "지선1", x: 100, y: 100, seq: 4 },
    { name: "지선2", x: 100, y: 200, seq: 5 },
  ];
  const fakeDb = { prepare: () => ({ all: () => rows }) };
  const branches = [{ name: "테스트지선", junction: "분기역", spur: ["지선1", "지선2"] }];
  const { runs } = buildLineRuns(fakeDb, "수도권", "line-x", branches);
  // 본선(지선역 제외 3역) + 지선(junction+2역=3) = 2 run.
  assert.equal(runs.length, 2);
  assert.equal(runs[0].length, 3); // 본선1,분기역,본선2
  assert.equal(runs[1].length, 3); // 분기역,지선1,지선2
});
