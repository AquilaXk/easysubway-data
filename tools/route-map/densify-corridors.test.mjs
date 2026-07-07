import assert from "node:assert/strict";
import test from "node:test";
import { trackAxis8, corridorLayout, corridorTargets, applyCorridor, applyNoSharedLine } from "./densify-corridors.mjs";

test("trackAxis8은 centroid 인접 세그먼트 긴 쪽 방향을 8축 스냅(세로 track→(0,1))", () => {
  // 세로 track, centroid가 (100,100) 근처 — 인접 세그먼트 모두 수직
  const verts = [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 300 }];
  const a = trackAxis8(verts, { x: 100, y: 100 });
  assert.deepEqual({ ux: Math.round(a.ux), uy: Math.round(a.uy) }, { ux: 0, uy: 1 });
});

test("corridorLayout: 0px 붕괴 3역·세로 track → 축(0,1)·정렬=line_sequence(역전 방지)", () => {
  // 세 역이 (100,100)에 붕괴, 입력 순서는 뒤섞임, seq가 진짜 순서
  const membersSeq = [
    { stationId: "도라산", x: 100, y: 100, seq: 3 },
    { stationId: "운천", x: 100, y: 100, seq: 1 },
    { stationId: "임진강", x: 100, y: 100, seq: 2 },
  ];
  const verts = [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 300 }];
  const r = corridorLayout(membersSeq, verts);
  assert.deepEqual({ ux: Math.round(r.axis.ux), uy: Math.round(r.axis.uy) }, { ux: 0, uy: 1 });
  assert.deepEqual(r.ordered, ["운천", "임진강", "도라산"]); // seq 순, 기하 아님
});

test("corridorTargets는 track축 따라 targetGap 간격·seq 순·centroid 중심 재배치(정수)", () => {
  // 3역 (100,100) 붕괴, 세로 track, seq 1/2/3
  const membersSeq = [
    { stationId: "a", x: 100, y: 100, seq: 1 }, { stationId: "b", x: 100, y: 100, seq: 2 }, { stationId: "c", x: 100, y: 100, seq: 3 },
  ];
  const verts = [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 300 }];
  const t = corridorTargets(membersSeq, verts, 30);
  const ys = ["a", "b", "c"].map((id) => t.get(id).y);
  assert.ok(ys[1] - ys[0] === 30 && ys[2] - ys[1] === 30, `y간격 ${ys}`); // 세로축 펼침
  assert.ok(Math.abs((ys[0] + ys[2]) / 2 - 100) < 1, "centroid y≈100 보존");
  assert.ok(["a", "b", "c"].every((id) => t.get(id).x === 100), "비축(x) 성분 통일");
});

test("applyNoSharedLine은 공유노선 없는 쌍의 한 역만 자기 노선 방향으로 벌린다", () => {
  // 반포↔잠원형: (100,100) 근접, A(반포)는 세로 노선 → A만 세로로 이동해 분리
  const g = ["A", "B"];
  const repr = new Map([["A", { x: 100, y: 100 }], ["B", { x: 100, y: 102 }]]);
  const memberLines = new Map([["A", [{ lineId: "LA", x: 100, y: 100 }]], ["B", [{ lineId: "LB", x: 100, y: 102 }]]]);
  const tracksByLine = new Map([
    ["LA", [{ trackIndex: 0, verts: [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 300 }] }]],
    ["LB", [{ trackIndex: 0, verts: [{ x: 0, y: 102 }, { x: 100, y: 102 }, { x: 200, y: 102 }] }]],
  ]);
  const r = applyNoSharedLine(g, memberLines, tracksByLine, repr, 30, 40);
  const pa = r.positionUpdates.find((p) => p.stationId === "A");
  assert.ok(pa && Math.hypot(pa.x - 100, pa.y - 102) >= 30 - 1e-6, `분리 거리 부족`);
  assert.ok(!r.positionUpdates.some((p) => p.stationId === "B"), "B는 미이동(한 역만)");
});

test("applyCorridor는 회랑 역들을 track축 간격으로 벌리고 전 노선노드 강체 이동", () => {
  // 2역 (100,100) 붕괴, 세로 track, seq 1/2
  const membersSeq = [{ stationId: "a", x: 100, y: 100, seq: 1 }, { stationId: "b", x: 100, y: 100, seq: 2 }];
  const verts = [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 300 }];
  const memberLines = new Map([
    ["a", [{ lineId: "L", x: 100, y: 100 }]],
    ["b", [{ lineId: "L", x: 100, y: 100 }]],
  ]);
  const tracksByLine = new Map([["L", [{ trackIndex: 0, verts }]]]);
  const r = applyCorridor(membersSeq, verts, memberLines, tracksByLine, 40);
  const pa = r.positionUpdates.find((p) => p.stationId === "a"), pb = r.positionUpdates.find((p) => p.stationId === "b");
  assert.ok(Math.abs(Math.abs(pa.y - pb.y) - 30) < 1e-6, `y간격 ${Math.abs(pa.y - pb.y)}`); // 세로축 30px
});

test("applyCorridor: 단일 공유 정점 붕괴쌍도 두 역 모두 track 정점 위 안착(캐스케이드 오염 방지)", () => {
  // 정점 1개 (100,100)이 두 역 담당(진짜 0px 공유 정점). 첫 역이 정점을 옮기면
  // 둘째 역이 이동된 정점을 재포착해 첫 역을 off-track으로 밀던 F1 회귀 방지.
  const membersSeq = [{ stationId: "a", x: 100, y: 100, seq: 1 }, { stationId: "b", x: 100, y: 100, seq: 2 }];
  const verts = [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 300 }];
  const memberLines = new Map([
    ["a", [{ lineId: "L", x: 100, y: 100 }]],
    ["b", [{ lineId: "L", x: 100, y: 100 }]],
  ]);
  const tracksByLine = new Map([["L", [{ trackIndex: 0, verts }]]]);
  const r = applyCorridor(membersSeq, verts, memberLines, tracksByLine, 40);
  const pa = r.positionUpdates.find((p) => p.stationId === "a"), pb = r.positionUpdates.find((p) => p.stationId === "b");
  const finalVerts = tracksByLine.get("L")[0].verts;
  const onTrack = (p) => finalVerts.some((v) => Math.hypot(v.x - p.x, v.y - p.y) <= 1);
  assert.ok(onTrack(pa), `a off-track: ${pa.x},${pa.y} vs ${JSON.stringify(finalVerts)}`);
  assert.ok(onTrack(pb), `b off-track: ${pb.x},${pb.y} vs ${JSON.stringify(finalVerts)}`);
});

test("applyCorridor는 다중 노선노드를 동일 델타로 강체 이동(캡슐 span 보존, 붕괴 방지)", () => {
  // a: 2노선 노드가 6px 오프셋(캡슐), b: 1노선. 붕괴 근접.
  const membersSeq = [{ stationId: "a", x: 100, y: 100, seq: 1 }, { stationId: "b", x: 100, y: 100, seq: 2 }];
  const verts = [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 300 }];
  const memberLines = new Map([
    ["a", [{ lineId: "L1", x: 97, y: 100 }, { lineId: "L2", x: 103, y: 100 }]], // 캡슐 span 6
    ["b", [{ lineId: "L", x: 100, y: 100 }]],
  ]);
  const tracksByLine = new Map([
    ["L1", [{ trackIndex: 0, verts: [{ x: 97, y: 0 }, { x: 97, y: 100 }, { x: 97, y: 300 }] }]],
    ["L2", [{ trackIndex: 0, verts: [{ x: 103, y: 0 }, { x: 103, y: 100 }, { x: 103, y: 300 }] }]],
    ["L", [{ trackIndex: 0, verts }]],
  ]);
  const r = applyCorridor(membersSeq, verts, memberLines, tracksByLine, 40);
  const aL1 = r.positionUpdates.find((p) => p.stationId === "a" && p.lineId === "L1");
  const aL2 = r.positionUpdates.find((p) => p.stationId === "a" && p.lineId === "L2");
  assert.ok(Math.abs(Math.abs(aL1.x - aL2.x) - 6) < 1e-6, `캡슐 span 6 보존, 실제 ${Math.abs(aL1.x - aL2.x)}`); // 붕괴 아님
});
