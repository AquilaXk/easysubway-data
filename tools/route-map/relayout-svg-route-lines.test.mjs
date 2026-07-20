import assert from "node:assert/strict";
import test from "node:test";

import { collinearOverlap } from "./audit-route-line-layout-quality.mjs";
import {
  applyCorridorBundleOffsets,
  applyStationDeltasGeneric,
  buildMinimalBendVertices,
  countBends,
  detectCorridorBundles,
  detectGeometricCorridorBundles,
  detectRuns,
  enforceEuclideanSafetyNet,
  findAllTagRangesByDataStation,
  projectRun,
  resolveGlobalRuns,
  resolveNodeClearanceByMicroAlign,
  resolveOverlapsByMovingStations,
  snapDirIndex,
} from "./relayout-svg-route-lines.mjs";

// #2068 2차 QA 반려(오너, 2026-07-18) — "노드에서 곡선·간선 겹침·지그재그"
// 대응 재배치 알고리즘 순수 함수 계약.

test("snapDirIndex: 8방향 인덱스 매핑", () => {
  assert.equal(snapDirIndex(10, 0), 0); // E
  assert.equal(snapDirIndex(10, 10), 1); // SE(y+)
  assert.equal(snapDirIndex(0, 10), 2); // S
  assert.equal(snapDirIndex(-10, 10), 3);
  assert.equal(snapDirIndex(-10, 0), 4); // W
  assert.equal(snapDirIndex(0, 0), null);
});

test("detectRuns: 같은 방향이 이어지는 역은 하나의 run", () => {
  const pts = [
    { key: "a", x: 0, y: 0 },
    { key: "b", x: 100, y: 0 },
    { key: "c", x: 200, y: 0 }, // 여전히 동쪽
    { key: "d", x: 200, y: 100 }, // 남쪽으로 전환
  ];
  const runs = detectRuns(pts);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].points.length, 3); // a,b,c
  assert.equal(runs[1].points.length, 2); // c,d
});

test("detectRuns: 지그재그(살짝씩 다른 각도) 입력도 하나의 run으로 뭉친다(스냅 방향 동일)", () => {
  // 셋 다 대략 동쪽(약간의 y 잡음)이지만 전부 최근접 8방향이 '동(E)'으로 스냅.
  const pts = [
    { key: "a", x: 0, y: 0 },
    { key: "b", x: 100, y: 5 },
    { key: "c", x: 200, y: -3 },
    { key: "d", x: 300, y: 8 },
  ];
  const runs = detectRuns(pts);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].dirIndex, 0);
});

test("projectRun: run 내 모든 점을 공통 축(중앙값 perp)으로 투영 — 완전 직선화", () => {
  const run = {
    dirIndex: 0, // 동쪽
    points: [
      { key: "a", x: 0, y: 0 },
      { key: "b", x: 100, y: 5 },
      { key: "c", x: 200, y: -3 },
    ],
  };
  const out = projectRun(run, new Map());
  // 전부 같은 y(투영 후 완전 직선)여야.
  const ys = [...out.values()].map((p) => Math.round(p.y * 1000) / 1000);
  assert.equal(new Set(ys).size, 1);
  // along(x) 성분은 보존.
  assert.equal(out.get("a").x, 0);
  assert.equal(out.get("b").x, 100);
  assert.equal(out.get("c").x, 200);
});

test("projectRun: locked 점은 절대 움직이지 않고 그 perp가 run 전체의 목표", () => {
  const run = {
    dirIndex: 0,
    points: [
      { key: "a", x: 0, y: 0 },
      { key: "b", x: 100, y: 5 },
      { key: "c", x: 200, y: -3 },
    ],
  };
  const locked = new Map([["b", { x: 100, y: 5 }]]); // b는 이미 확정
  const out = projectRun(run, locked);
  assert.deepEqual(out.get("b"), { x: 100, y: 5 }); // 불변
  assert.equal(out.get("a").y, 5); // 다른 점들은 b의 perp(=5, y축 기준)로 정렬
  assert.equal(out.get("c").y, 5);
});

test("projectRun: 변위 상한을 넘는 계산 결과는 원위치를 유지(나쁜 앵커 전파 차단)", () => {
  const run = {
    dirIndex: 0, // 동쪽
    points: [
      { key: "a", x: 0, y: 0 },
      { key: "b", x: 100, y: 5 },
    ],
  };
  // 앵커(락)가 이 run과 무관하게 아주 먼 perp를 강요 — 실전에서는 이런 앵커가
  // 다른(엉뚱한) run에서 전파된 상황을 흉내낸다.
  const locked = new Map([["a", { x: 0, y: 500 }]]); // perp 500 강요
  const out = projectRun(run, locked, 150);
  assert.deepEqual(out.get("a"), { x: 0, y: 500 }); // locked 점은 그대로.
  // b는 targetPerp=500을 따라가면 (100,500) — 원래(100,5)에서 495px 변위,
  // 상한 150 초과 → 원위치 유지.
  assert.deepEqual(out.get("b"), { x: 100, y: 5 });
});

test("resolveGlobalRuns: 더 긴 run이 먼저 락 — 짧은 run이 앵커로 정렬", () => {
  // 노선1: 길이 3(우선), 노선2: 길이 2인데 노선1과 station 'b' 공유.
  const runs = [
    {
      dirIndex: 0,
      points: [
        { key: "a", x: 0, y: 0 },
        { key: "b", x: 100, y: 0 },
        { key: "c", x: 200, y: 0 },
      ],
    },
    {
      dirIndex: 2, // 남쪽(교차하는 다른 노선)
      points: [
        { key: "b", x: 100, y: 5 }, // 노선1과 약간 다른 좌표(정합 필요)
        { key: "d", x: 105, y: 100 },
      ],
    },
  ];
  const { locked } = resolveGlobalRuns(runs);
  // b는 긴 run(노선1)이 먼저 락 → y=0으로 확정.
  assert.equal(locked.get("b").y, 0);
});

test("buildMinimalBendVertices: 이미 8선형인 연속 구간은 코너 없이 통과", () => {
  const pts = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 100 },
  ];
  const verts = buildMinimalBendVertices(pts);
  assert.equal(countBends(verts), 0);
});

test("buildMinimalBendVertices: run 전환 지점에만 정확히 1개 합성 코너", () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 30 }]; // 비8선형 — 1개 dogleg 필요
  const verts = buildMinimalBendVertices(pts);
  assert.equal(countBends(verts), 1);
  assert.equal(verts[0].synthetic, false);
  assert.equal(verts[2].synthetic, false);
});

test("detectCorridorBundles: 공유 edge가 있는 두 노선만 번들 배정", () => {
  const seqs = new Map([
    ["4", [{ key: "a" }, { key: "b" }, { key: "c" }]],
    ["sb", [{ key: "a" }, { key: "b" }, { key: "d" }]], // a-b 공유, b-c/b-d는 아님
  ]);
  const bundles = detectCorridorBundles(seqs);
  assert.ok(bundles.assignment.has("4#a|b"));
  assert.ok(bundles.assignment.has("sb#a|b"));
  assert.ok(!bundles.assignment.has("4#b|c"));
  const a4 = bundles.assignment.get("4#a|b");
  const asb = bundles.assignment.get("sb#a|b");
  assert.equal(a4.size, 2);
  assert.notEqual(a4.index, asb.index); // 서로 다른 인덱스(양쪽으로 갈라짐)
});

test("applyCorridorBundleOffsets: 번들 edge만 수직 오프셋, 비번들은 불변", () => {
  const seqA = [{ key: "a", x: 0, y: 0 }, { key: "b", x: 100, y: 0 }, { key: "c", x: 200, y: 0 }];
  const seqB = [{ key: "a", x: 0, y: 0 }, { key: "b", x: 100, y: 0 }, { key: "d", x: 100, y: 100 }];
  const bundles = detectCorridorBundles(new Map([["L1", seqA], ["L2", seqB]]));
  const outA = applyCorridorBundleOffsets("L1", seqA, bundles, 6);
  const outB = applyCorridorBundleOffsets("L2", seqB, bundles, 6);
  // a-b는 번들(동쪽 방향) → y가 갈라진다(부호 반대).
  assert.notEqual(outA.find((p) => p.key === "a").y, outB.find((p) => p.key === "a").y);
  assert.notEqual(outA.find((p) => p.key === "b").y, outB.find((p) => p.key === "b").y);
  // c는 번들 아님 → L1의 c는 불변.
  const cOut = outA.find((p) => p.key === "c");
  assert.equal(cOut.x, 200);
  assert.equal(cOut.y, 0);
});

test("findAllTagRangesByDataStation: 중첩된 자식(같은 data-station)은 제외 — 최상위만", () => {
  // 오금 환승 심벌 실제 구조 축약본: g(부모) 안에 title·circle·text가 전부
  // 같은 data-station="오금"을 들고 있다.
  const svg = [
    '<g id="transfer-station-symbol-오금" data-station="오금">',
    '  <title data-station="오금">오금</title>',
    '  <g id="badge" data-station="오금">',
    '    <circle data-station="오금" cx="0" cy="0" />',
    '    <text data-station="오금">3</text>',
    "  </g>",
    "</g>",
  ].join("\n");
  const ranges = findAllTagRangesByDataStation(svg, "오금");
  assert.equal(ranges.length, 1); // 최상위 <g> 하나만.
  assert.ok(svg.slice(ranges[0].start, ranges[0].end).includes('id="transfer-station-symbol-오금"'));
});

test("findAllTagRangesByDataStation: 서로 다른(형제) 요소는 전부 반환", () => {
  const svg = [
    '<circle id="_a" data-station="가산디지털단지" cx="0" cy="0" />',
    '<text id="station-label-가산디지털단지" data-station="가산디지털단지">가산디지털단지</text>',
  ].join("\n");
  const ranges = findAllTagRangesByDataStation(svg, "가산디지털단지");
  assert.equal(ranges.length, 2);
});

test("applyStationDeltasGeneric: 중첩 구조에서도 delta가 1회만 적용(이중이동 방지)", () => {
  const svg =
    '<g id="transfer-station-symbol-오금" data-station="오금" transform="translate(0,0)">' +
    '<circle data-station="오금" cx="5" cy="5" />' +
    "</g>";
  const { svg: out } = applyStationDeltasGeneric(svg, [{ name: "오금", dx: 10, dy: 20 }]);
  assert.ok(out.includes('transform="translate(10,20)"'));
  // 자식 circle 자체는 건드리지 않음(부모 transform 상속으로 충분).
  assert.ok(out.includes('<circle data-station="오금" cx="5" cy="5" />'));
});

test("applyStationDeltasGeneric: 콜론 동명이역은 slugs로 올바른 별칭만 매칭", () => {
  const svg = [
    '<text id="station-label-양평:5호선" data-station="양평:5호선">양평</text>',
    '<text id="station-label-양평:경의중앙선" data-station="양평:경의중앙선">양평</text>',
  ].join("\n");
  const deltas = [
    { name: "양평", dx: 10, dy: 0, slugs: new Set(["5"]) },
    { name: "양평", dx: 0, dy: 20, slugs: new Set(["gyeongui-jungang"]) },
  ];
  const { svg: out } = applyStationDeltasGeneric(svg, deltas);
  const line5 = out.match(/<text id="station-label-양평:5호선"[^>]*>/)[0];
  const lineGJ = out.match(/<text id="station-label-양평:경의중앙선"[^>]*>/)[0];
  assert.ok(line5.includes('translate(10,0)'));
  assert.ok(lineGJ.includes('translate(0,20)'));
});

test("applyStationDeltasGeneric: canonical↔SVG 표기가 다른 역은 EXTRA_NAME_ALIASES로 매칭", () => {
  const svg = '<text id="station-label-하남검단산" data-station="하남검단산">하남검단산</text>';
  const { svg: out, missing } = applyStationDeltasGeneric(svg, [
    { name: "하남검단산역", dx: 5, dy: 5 },
  ]);
  assert.equal(missing.length, 0);
  assert.ok(out.includes("translate(5,5)"));
});

test("detectGeometricCorridorBundles: 위상적으로 무관해도 기하학적으로 겹치면 번들 배정", () => {
  // 두 노선이 서로 다른 station-pair(edge)를 지나지만 좌표가 우연히 같은
  // 직선 위에서 겹친다.
  const finalPieces = new Map([
    ["A", [[{ key: "a1", x: 0, y: 0 }, { key: "a2", x: 100, y: 0 }]]],
    ["B", [[{ key: "b1", x: 20, y: 0.2 }, { key: "b2", x: 120, y: 0.2 }]]],
  ]);
  const bundles = detectCorridorBundles(finalPieces);
  assert.equal(bundles.assignment.size, 0); // 위상적으로는 공유 edge 없음.
  detectGeometricCorridorBundles(finalPieces, bundles, collinearOverlap, { maxSeparationForBundlePx: 3 });
  assert.ok(bundles.assignment.size > 0); // 기하 겹침으로 번들 배정됨.
  const aEntry = bundles.assignment.get("A#a1|a2");
  const bEntry = bundles.assignment.get("B#b1|b2");
  assert.equal(aEntry.size, 2);
  assert.equal(bEntry.size, 2);
  assert.notEqual(aEntry.index, bEntry.index);
});

test("detectGeometricCorridorBundles: 위상 번들이 이미 있으면 기하 배정으로 덮어쓰지 않는다", () => {
  const finalPieces = new Map([
    ["A", [[{ key: "s1", x: 0, y: 0 }, { key: "s2", x: 100, y: 0 }]]],
    ["B", [[{ key: "s1", x: 0, y: 0 }, { key: "s2", x: 100, y: 0 }]]], // 완전히 같은 edge(위상 공유)
  ]);
  const bundles = detectCorridorBundles(finalPieces);
  const before = bundles.assignment.get("A#s1|s2");
  detectGeometricCorridorBundles(finalPieces, bundles, collinearOverlap, { maxSeparationForBundlePx: 3 });
  const after = bundles.assignment.get("A#s1|s2");
  assert.deepEqual(before, after); // 그대로 유지(위상 우선).
});

test("enforceEuclideanSafetyNet: 48px 미만으로 붕괴한 쌍은 원좌표로 되돌린다", () => {
  const locked = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 10, y: 0 }], // a와 10px — 위반
    ["c", { x: 200, y: 0 }],
  ]);
  const perLinePieces = new Map([
    ["L", [[{ key: "a", x: 0, y: 0 }, { key: "b", x: 100, y: 0 }, { key: "c", x: 200, y: 0 }]]],
  ]);
  const orig = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 0 }],
    ["c", { x: 200, y: 0 }],
  ]);
  const result = enforceEuclideanSafetyNet(locked, perLinePieces, orig, 48);
  assert.ok(result.revertedCount >= 2);
  assert.deepEqual(locked.get("a"), { x: 0, y: 0 });
  assert.deepEqual(locked.get("b"), { x: 100, y: 0 }); // 원좌표로 복귀 — 다시 90px 이상.
  const d = Math.hypot(locked.get("a").x - locked.get("b").x, locked.get("a").y - locked.get("b").y);
  assert.ok(d >= 48);
});

test("enforceEuclideanSafetyNet: locked에 없는 역(run 계산에서 드롭)도 원좌표로 검사에 포함한다", () => {
  // #2068 4차 실측 회귀: 도라산(splitAtOutlierGaps로 run 조각 밖으로 드롭 —
  // locked에 없음)이 자기는 안 움직였는데, "이웃" 청량리가 재배치로 다가와
  // census를 깼다 — locked.get()이 없다고 그 역을 통째로 건너뛰면 이 쌍이
  // 안전망 검사에서 사라진다. perLinePieces의 원좌표(s.x/s.y)로 폴백해야 한다.
  const locked = new Map([
    ["b", { x: 40, y: 0 }], // b만 재배치로 이동(a에 46px까지 근접) — a는 locked에 없음.
  ]);
  const perLinePieces = new Map([
    ["L", [[{ key: "a", x: 0, y: 0 }, { key: "b", x: 100, y: 0 }]]], // a의 원좌표는 여기서만 옴.
  ]);
  const orig = new Map([["a", { x: 0, y: 0 }], ["b", { x: 100, y: 0 }]]);
  const result = enforceEuclideanSafetyNet(locked, perLinePieces, orig, 48);
  assert.ok(result.revertedCount >= 1);
  assert.deepEqual(locked.get("b"), { x: 100, y: 0 }); // b는 원좌표로 복귀.
});

test("enforceEuclideanSafetyNet: 위반 없으면 아무 것도 안 바꾼다", () => {
  const locked = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 0 }],
  ]);
  const perLinePieces = new Map([["L", [[{ key: "a", x: 0, y: 0 }, { key: "b", x: 100, y: 0 }]]]]);
  const orig = new Map([["a", { x: 0, y: 0 }], ["b", { x: 100, y: 0 }]]);
  const result = enforceEuclideanSafetyNet(locked, perLinePieces, orig, 48);
  assert.equal(result.revertedCount, 0);
});

test("resolveOverlapsByMovingStations: 위상 무관 공선+겹침 노선은 뒤 슬러그의 역을 밀어낸다", () => {
  // A: (0,0)-(100,0). B: (20,1)-(120,1) — 거의 같은 직선(1px 간격), 알파벳
  // 뒤인 B가 이동 대상.
  const locked = new Map([
    ["a1", { x: 0, y: 0 }], ["a2", { x: 100, y: 0 }],
    ["b1", { x: 20, y: 1 }], ["b2", { x: 120, y: 1 }],
  ]);
  const finalPieces = new Map([
    ["A", [[{ key: "a1" }, { key: "a2" }]]],
    ["B", [[{ key: "b1" }, { key: "b2" }]]],
  ]);
  const result = resolveOverlapsByMovingStations(finalPieces, locked, { offsetPx: 8, maxSeparationForOverlapPx: 2 });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].lineA, "A");
  assert.equal(result.clusters[0].lineB, "B");
  assert.ok(result.movedKeys.has("b1"));
  assert.ok(result.movedKeys.has("b2"));
  // A는 불변.
  assert.deepEqual(locked.get("a1"), { x: 0, y: 0 });
  // B는 y가 벌어짐(이미 +1이었으니 + 방향으로 증폭).
  assert.ok(locked.get("b1").y > 1);
});

test("resolveOverlapsByMovingStations: 끝점을 공유하는 직접 edge(진짜 환승/분기)는 건드리지 않는다", () => {
  // #2068 4차 실측: 공유역만 보호하고 나머지(b2)를 부분 이동(run 일부만 이동)
  // 하거나, run 전체를 대상으로 공유역 포함 여부를 검사하는 방식 모두 실측에서
  // 문제가 났다 — 전자는 강체성이 깨져 클러스터당 최대 2799건까지 무한 진동
  // (8방향 스냅 경계에서 부호가 왕복하며 수렴하지 않음)했고, 후자는 과잉
  // 차단(긴 run이 우연히 지나는 무관한 공유역까지 걸려 정상 클러스터 8개마저
  // 0으로 떨어짐). 안전하다고 실측된 유일한 기준: 지금 비교 중인 두 "직접
  // edge"(run 확장 전, eA·eB의 부모 edge)가 끝점을 하나라도 공유하면 그 조합만
  // 스킵한다.
  const locked = new Map([
    ["shared", { x: 0, y: 0 }],
    ["a2", { x: 100, y: 0 }],
    ["b2", { x: 100, y: 0.5 }], // shared와 거의 같은 축을 공유하되 endpoint가 겹침
  ]);
  const finalPieces = new Map([
    ["A", [[{ key: "shared" }, { key: "a2" }]]],
    ["B", [[{ key: "shared" }, { key: "b2" }]]],
  ]);
  const result = resolveOverlapsByMovingStations(finalPieces, locked, { offsetPx: 8, maxSeparationForOverlapPx: 2 });
  assert.equal(result.movedKeys.size, 0); // shared를 낀 run은 통째로 보호.
});

test("resolveOverlapsByMovingStations: 이미 충분히 분리된 병렬 corridor는 손대지 않는다", () => {
  const locked = new Map([
    ["a1", { x: 0, y: 0 }], ["a2", { x: 100, y: 0 }],
    ["b1", { x: 20, y: 6 }], ["b2", { x: 120, y: 6 }],
  ]);
  const finalPieces = new Map([
    ["A", [[{ key: "a1" }, { key: "a2" }]]],
    ["B", [[{ key: "b1" }, { key: "b2" }]]],
  ]);
  const result = resolveOverlapsByMovingStations(finalPieces, locked, { offsetPx: 8, maxSeparationForOverlapPx: 2 });
  assert.equal(result.movedKeys.size, 0);
});

test("resolveNodeClearanceByMicroAlign: diag가 작은 edge를 완전 8선형으로 스냅한다", () => {
  // a(0,0) -> b(100,3): dy=3(diag)이 짧은 축. diag*√2≈4.24 < threshold(6) —
  // 위반. b를 옮겨 y를 a와 맞추면(0) 코너가 완전히 사라진다.
  const locked = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 3 }],
  ]);
  const finalPieces = new Map([["L", [[{ key: "a" }, { key: "b" }]]]]);
  const result = resolveNodeClearanceByMicroAlign(finalPieces, locked, { thresholdPx: 6 });
  assert.ok(result.movedKeys.has("b"));
  assert.deepEqual(locked.get("b"), { x: 100, y: 0 });
  assert.equal(result.skipped.length, 0);
});

test("resolveNodeClearanceByMicroAlign: b쪽 직선 리드(longAxis-diag)가 짧은 edge도 잡는다", () => {
  // #2068 5차 실측 버그 회귀 가드: a(0,0) -> b(39,35)(주안→도화 패턴). diag=35
  // (짧은 축), longAxis=39. legAtA=diag*√2≈49.5(여유 있음), legAtB=longAxis-diag
  // =4(위반) — a쪽만 보면(diag*√2) 이 edge를 놓친다. b를 옮겨 x를 a와 맞추면
  // (0) 코너가 사라져 legAtB 위반도 함께 해소된다.
  const locked = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 39, y: 35 }],
  ]);
  const finalPieces = new Map([["L", [[{ key: "a" }, { key: "b" }]]]]);
  const result = resolveNodeClearanceByMicroAlign(finalPieces, locked, { thresholdPx: 6 });
  assert.ok(result.movedKeys.has("b"));
  assert.equal(result.skipped.length, 0);
  const p = locked.get("b");
  const dx = p.x - 0;
  const dy = p.y - 0;
  assert.ok(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)); // 완전 8선형.
});

test("resolveNodeClearanceByMicroAlign: 근-45° edge는 축 정렬이 아니라 대각선 정렬(이동량 작은 쪽)을 쓴다", () => {
  // #2068 5차 실측 버그 회귀 가드: a(0,0) -> b(39,35)(diag=35, legAtB=4).
  // 축 정렬(짧은 축을 0으로)은 35px나 옮겨야 하지만, 대각선 정렬(긴 축을
  // 짧은 축에 맞춤)은 4px만 옮기면 된다 — 반드시 이동량이 작은 쪽(대각선)을
  // 골라야 한다(실측: 축 정렬만 쓰면 이동량이 30~50px까지 커져 안전망이
  // census 위반으로 되돌리는 바람에 위반이 거의 안 줄었다).
  const locked = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 39, y: 35 }],
  ]);
  const finalPieces = new Map([["L", [[{ key: "a" }, { key: "b" }]]]]);
  const result = resolveNodeClearanceByMicroAlign(finalPieces, locked, { thresholdPx: 6 });
  assert.equal(result.fixes.length, 1);
  const moveDist = Math.hypot(
    result.fixes[0].to.x - result.fixes[0].from.x,
    result.fixes[0].to.y - result.fixes[0].from.y,
  );
  assert.ok(moveDist <= 6); // 대각선 정렬(legAtB=4) — 축 정렬(diag=35)보다 훨씬 작다.
});

test("resolveNodeClearanceByMicroAlign: 이미 여유가 충분한 edge는 손대지 않는다", () => {
  // diag=50 -> diag*√2≈70.7 >= threshold — 위반 아님.
  const locked = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 50 }],
  ]);
  const finalPieces = new Map([["L", [[{ key: "a" }, { key: "b" }]]]]);
  const result = resolveNodeClearanceByMicroAlign(finalPieces, locked, { thresholdPx: 6 });
  assert.equal(result.movedKeys.size, 0);
  assert.deepEqual(locked.get("b"), { x: 100, y: 50 });
});

test("resolveNodeClearanceByMicroAlign: 옮기면 이미 정렬된 다른 edge가 깨질 역은 피하고 반대쪽을 옮긴다", () => {
  // 역 순서 a(0,0) - b(100,3) - c(200,3): a-b가 위반(diag=3). b를 옮기면
  // b-c(이미 완전 수평 정렬)가 깨진다 — 그러니 a를 옮겨야 한다(a는 이 edge
  // 말고 다른 이웃이 없음, 피스 경계).
  const locked = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 3 }],
    ["c", { x: 200, y: 3 }],
  ]);
  const finalPieces = new Map([["L", [[{ key: "a" }, { key: "b" }, { key: "c" }]]]]);
  const result = resolveNodeClearanceByMicroAlign(finalPieces, locked, { thresholdPx: 6 });
  assert.ok(result.movedKeys.has("a"));
  assert.ok(!result.movedKeys.has("b"));
  assert.deepEqual(locked.get("a"), { x: 0, y: 3 }); // a를 b의 y에 맞춤.
  assert.deepEqual(locked.get("b"), { x: 100, y: 3 }); // b-c 정렬 보존.
});

test("resolveNodeClearanceByMicroAlign: 양끝 다 다른 정렬 edge를 깨면 skip하고 사유를 남긴다", () => {
  // z(-100,0)-a(0,0)-b(100,3)-c(200,3): a-b가 위반(diag=3, y축을 맞춰야 함).
  // a를 옮기면(y 0→3) z-a(수평 정렬, dy=0)가 dy=3짜리 위반으로 깨지고, b를
  // 옮기면(y 3→0) b-c(수평 정렬, dy=0)가 마찬가지로 깨진다 — 둘 다 불가, skip.
  const locked = new Map([
    ["z", { x: -100, y: 0 }],
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 3 }],
    ["c", { x: 200, y: 3 }],
  ]);
  const finalPieces = new Map([["L", [[{ key: "z" }, { key: "a" }, { key: "b" }, { key: "c" }]]]]);
  const result = resolveNodeClearanceByMicroAlign(finalPieces, locked, { thresholdPx: 6 });
  assert.equal(result.movedKeys.size, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].station, "a");
});

test("countBends: synthetic 정점만 센다", () => {
  const verts = [
    { x: 0, y: 0, synthetic: false },
    { x: 5, y: 5, synthetic: true },
    { x: 10, y: 10, synthetic: false },
    { x: 15, y: 5, synthetic: true },
  ];
  assert.equal(countBends(verts), 2);
});
