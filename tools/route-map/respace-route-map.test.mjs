import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePathPoints,
  serializePathPoints,
  buildRespaceGraph,
  medianStationChainLength,
  respaceGraph,
} from "./respace-route-map.mjs";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("parse/serialize 왕복 + 연속 중복 정점 제거", () => {
  const points = parsePathPoints("M 0 0 L 100 0 L 100 0 L 100 50");
  assert.deepEqual(points, [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
  ]);
  assert.equal(serializePathPoints(points), "M 0 0 L 100 0 L 100 50");
});

test("선분 위 역은 정점으로 삽입되고 chain이 갈라진다", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 100 0") },
    ],
    positions: [
      { stationId: "a", lineId: "L1", x: 0, y: 0 },
      { stationId: "b", lineId: "L1", x: 37, y: 0 },
      { stationId: "c", lineId: "L1", x: 100, y: 0 },
    ],
  });
  assert.equal(graph.nodes.length, 3); // 0,0 / 37,0 / 100,0
  assert.equal(graph.stationNodes.length, 3);
  assert.equal(graph.chains.length, 2); // a—b, b—c
  assert.ok(graph.chains.every((c) => c.hasStationEnds));
  assert.deepEqual(graph.tracks[0].nodeIds.length, 3);
});

test("기존 정점과 일치하는 역은 중복 삽입하지 않는다", () => {
  const graph = buildRespaceGraph({
    tracks: [
      {
        lineId: "L1",
        trackIndex: 0,
        points: parsePathPoints("M 0 0 L 50 0 L 50 50"),
      },
    ],
    positions: [{ stationId: "bend", lineId: "L1", x: 50, y: 0 }],
  });
  assert.equal(graph.nodes.length, 3);
});

test("닫힌 track(순환선)은 closed=true, 첫·끝 정점은 같은 노드", () => {
  const graph = buildRespaceGraph({
    tracks: [
      {
        lineId: "ring",
        trackIndex: 0,
        points: parsePathPoints("M 0 0 L 100 0 L 100 100 L 0 100 L 0 0"),
      },
    ],
    positions: [],
  });
  assert.equal(graph.tracks[0].closed, true);
  const ids = graph.tracks[0].nodeIds;
  assert.equal(ids[0], ids[ids.length - 1]);
  assert.equal(graph.nodes.length, 4);
});

test("같은 stationId의 노선별 정점은 cluster로 묶이고 offset을 기록한다", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 100 0") },
      { lineId: "L2", trackIndex: 0, points: parsePathPoints("M 0 6 L 100 6") },
    ],
    positions: [
      { stationId: "x", lineId: "L1", x: 50, y: 0 },
      { stationId: "x", lineId: "L2", x: 50, y: 6 },
    ],
  });
  assert.equal(graph.clusters.length, 1);
  const [m1, m2] = graph.clusters[0].members;
  assert.deepEqual(m1.offset, { x: 0, y: -3 });
  assert.deepEqual(m2.offset, { x: 0, y: 3 });
});

test("역 없는 트랙 꼬리는 hasStationEnds=false chain", () => {
  const graph = buildRespaceGraph({
    tracks: [
      {
        lineId: "L1",
        trackIndex: 0,
        points: parsePathPoints("M 0 0 L 40 0 L 120 0"),
      },
    ],
    positions: [{ stationId: "only", lineId: "L1", x: 40, y: 0 }],
  });
  // 꼬리 2개(0→40, 40→120)는 역-역 chain이 아니다.
  assert.equal(graph.chains.filter((c) => c.hasStationEnds).length, 0);
  assert.equal(graph.chains.filter((c) => !c.hasStationEnds).length, 2);
});

test("직선: 짧은 구간은 unit으로, 긴 구간은 maxRatio*unit으로 클램프", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 10 0 L 410 0") },
    ],
    positions: [
      { stationId: "a", lineId: "L1", x: 0, y: 0 },
      { stationId: "b", lineId: "L1", x: 10, y: 0 },
      { stationId: "c", lineId: "L1", x: 410, y: 0 },
    ],
  });
  const { positions } = respaceGraph(graph, { unit: 100, kAnchor: 0, maxRatio: 2.5 });
  const [a, b, c] = graph.stationNodes.map((s) => positions[s.nodeId]);
  assert.ok(Math.abs(dist(a, b) - 100) < 0.5, `a-b ${dist(a, b)}`);
  assert.ok(Math.abs(dist(b, c) - 250) < 0.5, `b-c ${dist(b, c)}`);
  assert.ok(Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - c.y) < 1e-6);
});

test("꺾임 포함 chain은 선분 비례 배분 + 45° 방향 보존", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 8 0 L 16 8") },
    ],
    positions: [
      { stationId: "a", lineId: "L1", x: 0, y: 0 },
      { stationId: "b", lineId: "L1", x: 16, y: 8 },
    ],
  });
  const { positions } = respaceGraph(graph, { unit: 100, kAnchor: 0 });
  const [p0, p1, p2] = graph.tracks[0].nodeIds.map((id) => positions[id]);
  assert.ok(Math.abs(p1.y - p0.y) < 1e-3);
  assert.ok(Math.abs((p2.y - p1.y) - (p2.x - p1.x)) < 1e-3);
  const total = dist(p0, p1) + dist(p1, p2);
  assert.ok(Math.abs(total - 100) < 0.5, `total ${total}`);
});

test("순환 track은 재간격 후에도 닫힘·방향이 유지된다", () => {
  const graph = buildRespaceGraph({
    tracks: [
      {
        lineId: "ring",
        trackIndex: 0,
        points: parsePathPoints("M 0 0 L 40 0 L 40 40 L 0 40 L 0 0"),
      },
    ],
    positions: [
      { stationId: "s1", lineId: "ring", x: 0, y: 0 },
      { stationId: "s2", lineId: "ring", x: 40, y: 0 },
      { stationId: "s3", lineId: "ring", x: 40, y: 40 },
      { stationId: "s4", lineId: "ring", x: 0, y: 40 },
    ],
  });
  const { positions } = respaceGraph(graph, { unit: 100, kAnchor: 0 });
  const ids = graph.tracks[0].nodeIds;
  for (let i = 1; i < ids.length; i += 1) {
    const a = positions[ids[i - 1]];
    const b = positions[ids[i]];
    const horizontal = Math.abs(a.y - b.y) < 1e-3;
    const vertical = Math.abs(a.x - b.x) < 1e-3;
    assert.ok(horizontal || vertical, `변 ${i} 방향 붕괴`);
    assert.ok(Math.abs(dist(a, b) - 100) < 1.0, `변 ${i} 길이 ${dist(a, b)}`);
  }
});

test("환승 cluster의 멤버 상대 offset은 정확히 유지된다", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 10 0 L 200 0") },
      { lineId: "L2", trackIndex: 0, points: parsePathPoints("M 0 6 L 10 6 L 200 6") },
    ],
    positions: [
      { stationId: "west", lineId: "L1", x: 0, y: 0 },
      { stationId: "x", lineId: "L1", x: 10, y: 0 },
      { stationId: "x", lineId: "L2", x: 10, y: 6 },
      { stationId: "west2", lineId: "L2", x: 0, y: 6 },
      { stationId: "east", lineId: "L1", x: 200, y: 0 },
      { stationId: "east2", lineId: "L2", x: 200, y: 6 },
    ],
  });
  const { positions } = respaceGraph(graph, { unit: 100 });
  const members = graph.clusters.find((c) => c.stationId === "x").members;
  const [a, b] = members.map((m) => positions[m.nodeId]);
  assert.ok(Math.abs(a.x - b.x) < 1e-3);
  assert.ok(Math.abs(Math.abs(a.y - b.y) - 6) < 1e-3);
});

test("결정성: 같은 입력 → 같은 출력", () => {
  const build = () =>
    buildRespaceGraph({
      tracks: [
        { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 10 0 L 410 0") },
      ],
      positions: [
        { stationId: "a", lineId: "L1", x: 0, y: 0 },
        { stationId: "b", lineId: "L1", x: 10, y: 0 },
        { stationId: "c", lineId: "L1", x: 410, y: 0 },
      ],
    });
  const r1 = respaceGraph(build(), { unit: 100 });
  const r2 = respaceGraph(build(), { unit: 100 });
  assert.deepEqual(r1.positions, r2.positions);
});

test("이미 준균일한 기하는 사실상 무변형", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 100 0 L 200 0") },
    ],
    positions: [
      { stationId: "a", lineId: "L1", x: 0, y: 0 },
      { stationId: "b", lineId: "L1", x: 100, y: 0 },
      { stationId: "c", lineId: "L1", x: 200, y: 0 },
    ],
  });
  const { positions } = respaceGraph(graph, { unit: 100 });
  graph.nodes.forEach((n, i) => {
    assert.ok(dist(n, positions[i]) < 0.5, `노드 ${i} 이동 ${dist(n, positions[i])}`);
  });
});

test("medianStationChainLength는 역-역 chain 길이 중앙값", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 10 0 L 40 0 L 140 0") },
    ],
    positions: [
      { stationId: "a", lineId: "L1", x: 0, y: 0 },
      { stationId: "b", lineId: "L1", x: 10, y: 0 },
      { stationId: "c", lineId: "L1", x: 40, y: 0 },
      { stationId: "d", lineId: "L1", x: 140, y: 0 },
    ],
  });
  // 간격 10, 30, 100 → 중앙값 30.
  assert.equal(medianStationChainLength(graph), 30);
});

test("off-grid 원본 선분은 45° 배수로 스냅된다 (하드 방향)", () => {
  // 원본 각도 ~1.7° — 폴리싱 후 수평(0°)이어야 한다.
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 100 3") },
    ],
    positions: [
      { stationId: "a", lineId: "L1", x: 0, y: 0 },
      { stationId: "b", lineId: "L1", x: 100, y: 3 },
    ],
  });
  const { positions } = respaceGraph(graph, { unit: 100, kAnchor: 0 });
  const [a, b] = graph.tracks[0].nodeIds.map((id) => positions[id]);
  assert.ok(Math.abs(a.y - b.y) < 1e-3, `수평 스냅 실패 dy=${b.y - a.y}`);
});

test("순환+환승 강결합에서도 수렴한다 — 과제약 plateau 회귀 방지", () => {
  // 순환 track + 그 정점에 환승으로 결합된 직선 track: 하드 길이 정식화가
  // ~150px plateau를 만들던 최소 재현 위상. 소프트 길이에서는 방향 정확
  // (maxPerpResidual < 0.01)하게 수렴해야 한다.
  const graph = buildRespaceGraph({
    tracks: [
      {
        lineId: "ring",
        trackIndex: 0,
        points: parsePathPoints("M 0 0 L 60 0 L 60 60 L 0 60 L 0 0"),
      },
      { lineId: "L2", trackIndex: 0, points: parsePathPoints("M 60 4 L 300 4") },
    ],
    positions: [
      { stationId: "s1", lineId: "ring", x: 0, y: 0 },
      { stationId: "x", lineId: "ring", x: 60, y: 0 },
      { stationId: "s3", lineId: "ring", x: 60, y: 60 },
      { stationId: "x", lineId: "L2", x: 60, y: 4 },
      { stationId: "far", lineId: "L2", x: 300, y: 4 },
    ],
  });
  const { positions, report } = respaceGraph(graph, { unit: 100 });
  assert.ok(
    report.maxPerpResidual < 0.01,
    `방향 잔차 ${report.maxPerpResidual}`,
  );
  // 8선형 정확: 모든 선분이 45° 배수 (0-길이 제외)
  for (const track of graph.tracks) {
    for (let i = 1; i < track.nodeIds.length; i += 1) {
      const a = positions[track.nodeIds[i - 1]];
      const b = positions[track.nodeIds[i]];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) continue;
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const mod = ((ang % 45) + 45) % 45;
      assert.ok(
        Math.min(mod, 45 - mod) < 0.1,
        `track ${track.lineId} seg ${i} 각도 ${ang}`,
      );
    }
  }
});

test("앵커는 이동을 유계시킨다 — 길이는 타협, 방향은 정확", () => {
  const graph = buildRespaceGraph({
    tracks: [
      { lineId: "L1", trackIndex: 0, points: parsePathPoints("M 0 0 L 10 0 L 410 0") },
    ],
    positions: [
      { stationId: "a", lineId: "L1", x: 0, y: 0 },
      { stationId: "b", lineId: "L1", x: 10, y: 0 },
      { stationId: "c", lineId: "L1", x: 410, y: 0 },
    ],
  });
  const { positions } = respaceGraph(graph, {
    unit: 100,
    kAnchor: 0.3,
    maxRatio: 2.5,
  });
  const [a, b, c] = graph.stationNodes.map((s) => positions[s.nodeId]);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  // 앵커가 강하면 목표(250)까지 못 가고 원길이(400)와의 사이에서 평형.
  assert.ok(bc > 250 && bc < 400, `bc=${bc}`);
  assert.ok(Math.abs(a.y - b.y) < 1e-3 && Math.abs(b.y - c.y) < 1e-3);
});
