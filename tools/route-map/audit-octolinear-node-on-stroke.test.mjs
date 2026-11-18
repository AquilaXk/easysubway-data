import assert from "node:assert/strict";
import test from "node:test";

import {
  curveFlatnessPx,
  extractRouteLineStrokes,
  findNodeOffStrokeViolations,
  findOctolinearViolations,
  parsePathSegments,
  parseScaledLayerTransform,
  renderPolylinesByLine,
  sampleSegmentRender,
  toRenderPoint,
} from "./audit-octolinear-node-on-stroke.mjs";

// #2068 마감 감사 순수 함수 계약. 이 게이트가 과소검출(오너 반려 2026-07-18)을
// 막으므로 판정 로직을 고정한다.

const IDENT = { tx: 0, ty: 0, scale: 1 };

test("parseScaledLayerTransform은 translate+scale를 뽑는다", () => {
  const svg =
    '<g id="main-map-scaled-layer" transform="translate(70 138) scale(0.455)"><path/></g>';
  assert.deepEqual(parseScaledLayerTransform(svg), { tx: 70, ty: 138, scale: 0.455 });
});

test("parseScaledLayerTransform은 쉼표 구분·부호도 처리", () => {
  const svg = '<g id="main-map-scaled-layer" transform="translate(-5,10) scale(2)"/>';
  assert.deepEqual(parseScaledLayerTransform(svg), { tx: -5, ty: 10, scale: 2 });
});

test("toRenderPoint는 균일 scale+translate 적용", () => {
  assert.deepEqual(toRenderPoint({ x: 100, y: 200 }, { tx: 70, ty: 138, scale: 0.5 }), {
    x: 120,
    y: 238,
  });
});

test("parsePathSegments: 절대 L, 상대 l, H/V를 직선으로", () => {
  const segs = parsePathSegments("M0 0 L10 0 l0 10 h-10 v-10");
  assert.deepEqual(
    segs.map((s) => [s.kind, s.a.x, s.a.y, s.b.x, s.b.y]),
    [
      ["line", 0, 0, 10, 0],
      ["line", 10, 0, 10, 10],
      ["line", 10, 10, 0, 10],
      ["line", 0, 10, 0, 0],
    ],
  );
});

test("parsePathSegments: M 후 암시적 lineto·Z 폐합", () => {
  const segs = parsePathSegments("M0 0 5 0 Z"); // M 뒤 두번째 좌표쌍은 lineto
  assert.deepEqual(segs.map((s) => s.kind), ["line", "line"]);
  assert.deepEqual([segs[0].b, segs[1].b], [{ x: 5, y: 0 }, { x: 0, y: 0 }]);
});

test("parsePathSegments: 3차 곡선 C의 제어점 절대화", () => {
  const segs = parsePathSegments("M0 0 C1 2 3 4 5 6");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "curve");
  assert.deepEqual(segs[0].c1, { x: 1, y: 2 });
  assert.deepEqual(segs[0].c2, { x: 3, y: 4 });
  assert.deepEqual(segs[0].b, { x: 5, y: 6 });
});

test("parsePathSegments: 상대 곡선 c와 S 반사 제어점", () => {
  // M10 10, c(rel) 제어 (11,12)(13,14) 끝점(15,16); 이어 S 반사.
  const segs = parsePathSegments("M10 10 c1 2 3 4 5 6 S9 9 20 20");
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0].b, { x: 15, y: 16 }); // 10+5,10+6
  assert.deepEqual(segs[0].c2, { x: 13, y: 14 }); // 10+3,10+4
  // S의 c1 = 직전 c2를 현재점(15,16) 기준 반사 = 2*15-13, 2*16-14 = (17,18)
  assert.deepEqual(segs[1].c1, { x: 17, y: 18 });
});

test("curveFlatnessPx: 직선형 곡선은 ~0, 굽은 곡선은 양수", () => {
  const straight = { kind: "curve", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c1: { x: 3, y: 0 }, c2: { x: 7, y: 0 } };
  assert.ok(curveFlatnessPx(straight, IDENT) < 1e-6);
  const bent = { kind: "curve", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c1: { x: 3, y: 6 }, c2: { x: 7, y: 6 } };
  assert.ok(curveFlatnessPx(bent, IDENT) > 3);
});

test("findOctolinearViolations: 8선형 직선 통과, 사선 직선 위반", () => {
  const strokes = [
    { lineId: "1", segments: parsePathSegments("M0 0 L100 0 L100 100 L200 200") }, // 0°,90°,45° 통과
  ];
  assert.deepEqual(findOctolinearViolations(strokes, IDENT), []);
  const bad = [{ lineId: "1", segments: parsePathSegments("M0 0 L100 30") }]; // ~16.7°
  const v = findOctolinearViolations(bad, IDENT);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "line-non-octolinear");
  assert.ok(v[0].offDeg > 1);
});

test("findOctolinearViolations: 짧은 코너 곡선은 예외, 긴 사선 곡선은 위반", () => {
  // 짧은(<20px) 코너 곡선: chord 각이 22.5°여도 예외.
  const fillet = [{ lineId: "1", segments: parsePathSegments("M0 0 C2 0 5 3 5 5") }];
  assert.deepEqual(findOctolinearViolations(fillet, IDENT), []);
  // 긴(>=20px) 사선 곡선 = 간선 run을 곡선으로 그린 것 → 위반.
  const run = [{ lineId: "1", segments: parsePathSegments("M0 0 C10 3 20 6 30 9") }]; // chord ~31px, ~16.7°
  const v = findOctolinearViolations(run, IDENT);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "curve-run-non-octolinear");
});

test("findOctolinearViolations: 긴 8선형 곡선(수평 run)은 통과", () => {
  // chord가 정확히 수평이면 길어도 통과(직선을 곡선으로 그렸지만 8선형).
  const run = [{ lineId: "1", segments: parsePathSegments("M0 0 C10 0 20 0 30 0") }];
  assert.deepEqual(findOctolinearViolations(run, IDENT), []);
});

test("findOctolinearViolations: angleTolerance 안쪽 미세 편차는 통과", () => {
  const nearly = [{ lineId: "1", segments: parsePathSegments("M0 0 L1000 3") }]; // ~0.17°
  assert.deepEqual(findOctolinearViolations(nearly, IDENT, { angleToleranceDeg: 0.5 }), []);
});

test("findNodeOffStrokeViolations: 선 위 노드 통과, 이탈 노드 위반", () => {
  const strokes = [{ lineId: "1", segments: parsePathSegments("M0 0 L100 0") }];
  const polys = renderPolylinesByLine(strokes, IDENT);
  const nodes = [
    { dataStation: "온선", dataLine: "1", nodeRole: "ordinary", x: 50, y: 0.5 },
    { dataStation: "이탈", dataLine: "1", nodeRole: "ordinary", x: 50, y: 20 },
  ];
  const r = findNodeOffStrokeViolations(nodes, polys, { nodeTolerancePx: 1.365 });
  assert.equal(r.checks, 2);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].station, "이탈");
  assert.equal(r.violations[0].distPx, 20);
});

test("findNodeOffStrokeViolations: 환승역은 소속 노선 전부 검사", () => {
  const strokes = [
    { lineId: "1", segments: parsePathSegments("M0 0 L100 0") },
    { lineId: "2", segments: parsePathSegments("M0 50 L100 50") },
  ];
  const polys = renderPolylinesByLine(strokes, IDENT);
  // 환승역이 1호선 위(y=0)에는 있으나 2호선(y=50)에서 멀다 → 2호선만 위반.
  const nodes = [
    { dataStation: "환승", dataLine: "1", transferLines: "1 2", nodeRole: "transfer", x: 50, y: 0 },
  ];
  const r = findNodeOffStrokeViolations(nodes, polys, { nodeTolerancePx: 1.365 });
  assert.equal(r.checks, 2);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].lineId, "2");
});

test("findNodeOffStrokeViolations: 중복 마커(같은 역·같은 노선 조합)는 최소거리 채택", () => {
  const strokes = [{ lineId: "1", segments: parsePathSegments("M0 0 L100 0") }];
  const polys = renderPolylinesByLine(strokes, IDENT);
  // 같은 역·같은 노선을 가리키는 중복 요소 3개 — 하나만 stroke에 붙어 있음.
  const nodes = [
    { dataStation: "정왕", dataLine: "1", nodeRole: "transfer", x: 50, y: 0 }, // dist 0
    { dataStation: "정왕", dataLine: "1", nodeRole: "transfer", x: 50, y: 40 }, // dist 40(잔여 중복)
    { dataStation: "정왕", dataLine: "1", nodeRole: "transfer", x: 50, y: 30 }, // dist 30(잔여 중복)
  ];
  const r = findNodeOffStrokeViolations(nodes, polys, { nodeTolerancePx: 1.365 });
  assert.equal(r.checks, 1); // (역,노선) 고유 조합 1개로 중복 제거.
  assert.equal(r.violations.length, 0); // 최소거리(0)가 채택되므로 위반 없음.
});

test("findNodeOffStrokeViolations: transfer 역할은 넓은(캡슐) tolerance", () => {
  const strokes = [{ lineId: "1", segments: parsePathSegments("M0 0 L100 0") }];
  const polys = renderPolylinesByLine(strokes, IDENT);
  const nodes = [
    { dataStation: "환승역", dataLine: "1", nodeRole: "transfer", x: 50, y: 10 }, // dist 10
    { dataStation: "일반역", dataLine: "1", nodeRole: "ordinary", x: 60, y: 10 }, // dist 10
  ];
  const r = findNodeOffStrokeViolations(nodes, polys, {
    nodeTolerancePx: 1.365,
    transferNodeTolerancePx: 13,
  });
  // transfer는 10px이 13px 이내라 통과, ordinary는 1.365px 초과라 위반.
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].station, "일반역");
});

test("findNodeOffStrokeViolations: 소속 노선 없거나 stroke 없으면 미매핑", () => {
  const polys = renderPolylinesByLine(
    [{ lineId: "1", segments: parsePathSegments("M0 0 L100 0") }],
    IDENT,
  );
  const nodes = [
    { dataStation: "무선", dataLine: "", transferLines: "", nodeRole: "ordinary", x: 0, y: 0 },
    { dataStation: "없는선", dataLine: "9", nodeRole: "ordinary", x: 0, y: 0 },
  ];
  const r = findNodeOffStrokeViolations(nodes, polys, {});
  assert.equal(r.unmappable, 2);
  assert.equal(r.checks, 0);
});

test("sampleSegmentRender: 직선은 두 끝점, 곡선은 n+1점", () => {
  const line = { kind: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  assert.equal(sampleSegmentRender(line, IDENT).length, 2);
  const curve = { kind: "curve", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c1: { x: 3, y: 3 }, c2: { x: 7, y: 3 } };
  assert.equal(sampleSegmentRender(curve, IDENT, 8).length, 9);
});

test("extractRouteLineStrokes: route-line 그룹의 path만·data-line 매핑", () => {
  const svg = [
    '<g id="route-lines-layer">',
    '  <g id="route-line-1" data-line="1"><path d="M0 0 L10 0"/></g>',
    '  <g id="route-line-2" data-line="2"><path d="M0 5 L10 5"/><path d="M0 6 L10 6"/></g>',
    "</g>",
    '<g id="other-layer"><path d="M0 0 L1 1"/></g>',
  ].join("\n");
  const strokes = extractRouteLineStrokes(svg);
  assert.equal(strokes.length, 3);
  assert.deepEqual(
    strokes.map((s) => s.lineId),
    ["1", "2", "2"],
  );
});
