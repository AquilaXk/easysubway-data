import assert from "node:assert/strict";
import test from "node:test";

import { buildTransferBaseline } from "./import-transfer-baseline.mjs";

// 공용 roster: 사당(2호선·4호선 동일 역, 환승), 서울역 병기명 alias, 동명이역(신촌 2건).
const roster = [
  { stationId: "sadang", lineId: "line-2", nameKo: "사당", normalizedName: "사당", lineNameKo: "2호선", aliases: [] },
  { stationId: "sadang", lineId: "line-4", nameKo: "사당", normalizedName: "사당", lineNameKo: "4호선", aliases: [] },
  {
    stationId: "seoul-station",
    lineId: "line-1",
    nameKo: "서울역",
    normalizedName: "서울",
    lineNameKo: "1호선",
    aliases: [{ alias: "서울역(1)", normalizedAlias: "서울" }],
  },
  {
    stationId: "seoul-station",
    lineId: "line-4",
    nameKo: "서울역",
    normalizedName: "서울",
    lineNameKo: "4호선",
    aliases: [],
  },
  // 동명이역: 신촌(2호선) vs 신촌(경의중앙) — normalizedName 동일, stationId 상이 → 모호.
  { stationId: "sinchon-2", lineId: "line-2", nameKo: "신촌", normalizedName: "신촌", lineNameKo: "2호선", aliases: [] },
  { stationId: "sinchon-gyeongui", lineId: "line-gyeongui", nameKo: "신촌", normalizedName: "신촌", lineNameKo: "경의중앙선", aliases: [] },
];

function transferRow(overrides = {}) {
  return {
    연번: 1,
    호선: "2호선",
    환승역명: "사당",
    환승노선: "4호선",
    환승거리: 120,
    환승소요시간: 180,
    ...overrides,
  };
}

// 사당 두 노선의 PLATFORM 노드 — pathway edge 생성 경로가 quarantine 없이 지나가도록.
const sadangPlatformNodes = [
  { id: "sadang:line-2:PLATFORM", stationId: "sadang", lineId: "line-2", nodeType: "PLATFORM" },
  { id: "sadang:line-4:PLATFORM", stationId: "sadang", lineId: "line-4", nodeType: "PLATFORM" },
];

test("정상 매칭 → transfer_rule 적재 (같은 역, from/to 노선 분리)", () => {
  const result = buildTransferBaseline({
    roster,
    rows: [transferRow()],
    existingNodes: sadangPlatformNodes,
    sourceId: "src",
    verificationStatus: "OFFICIAL",
  });
  assert.equal(result.transferRules.length, 1);
  const rule = result.transferRules[0];
  assert.equal(rule.fromStationId, "sadang");
  assert.equal(rule.toStationId, "sadang");
  assert.equal(rule.fromLineId, "line-2");
  assert.equal(rule.toLineId, "line-4");
  assert.equal(rule.minTransferSeconds, 180);
  assert.equal(rule.sourceId, "src");
  assert.equal(rule.verificationStatus, "OFFICIAL");
  assert.equal(result.quarantine.length, 0);
  assert.equal(result.metadata.speedAnchorMetersPerSecond, 1.2);
});

test("역명 매칭 실패 → quarantine, 적재 없음", () => {
  const result = buildTransferBaseline({ roster, rows: [transferRow({ 환승역명: "없는역" })] });
  assert.equal(result.transferRules.length, 0);
  assert.equal(result.quarantine.length, 1);
  assert.match(result.quarantine[0].reason, /station roster match failed/);
});

test("병기역명 alias 매칭 성공", () => {
  const result = buildTransferBaseline({
    roster,
    rows: [transferRow({ 환승역명: "서울역(1)", 호선: "1호선", 환승노선: "4호선" })],
  });
  assert.equal(result.transferRules.length, 1);
  assert.equal(result.transferRules[0].fromStationId, "seoul-station");
  assert.equal(result.transferRules[0].fromLineId, "line-1");
  assert.equal(result.transferRules[0].toLineId, "line-4");
});

test("동명이역 → 모호 quarantine", () => {
  const result = buildTransferBaseline({
    roster,
    rows: [transferRow({ 환승역명: "신촌", 호선: "2호선", 환승노선: "경의중앙선" })],
  });
  assert.equal(result.transferRules.length, 0);
  assert.equal(result.quarantine.length, 1);
  assert.match(result.quarantine[0].reason, /ambiguous/);
});

test("방향쌍 리포트: 양쪽 있음 + 한쪽만 있음", () => {
  const result = buildTransferBaseline({
    roster,
    rows: [
      transferRow({ 호선: "2호선", 환승노선: "4호선", 환승소요시간: 180 }),
      transferRow({ 호선: "4호선", 환승노선: "2호선", 환승소요시간: 200 }),
      transferRow({ 환승역명: "서울역", 호선: "1호선", 환승노선: "4호선", 환승소요시간: 90 }),
    ],
  });
  const sadangPair = result.directionPairReport.find((r) => r.stationId === "sadang");
  assert.ok(sadangPair);
  assert.equal(sadangPair.hasReverse, true);
  assert.equal(sadangPair.secondsMismatch, true);
  const seoulPair = result.directionPairReport.find((r) => r.stationId === "seoul-station");
  assert.ok(seoulPair);
  assert.equal(seoulPair.hasReverse, false);
  assert.equal(seoulPair.reverseMinTransferSeconds, null);
});

test("중복 레코드 → duplicateReport, 첫 값 유지", () => {
  const result = buildTransferBaseline({
    roster,
    rows: [
      transferRow({ 환승소요시간: 180 }),
      transferRow({ 환승소요시간: 240 }),
    ],
  });
  assert.equal(result.transferRules.length, 1);
  assert.equal(result.transferRules[0].minTransferSeconds, 180);
  assert.equal(result.duplicateReport.length, 1);
  assert.equal(result.duplicateReport[0].firstMinTransferSeconds, 180);
  assert.equal(result.duplicateReport[0].duplicateMinTransferSeconds, 240);
});

test("pathway edge 이미 있는 역 → baseline edge 생성 안 함", () => {
  const existingEdges = [
    { fromNodeId: "sadang:line-2:PLATFORM", toNodeId: "sadang:line-4:PLATFORM" },
  ];
  const existingNodes = [
    { id: "sadang:line-2:PLATFORM", stationId: "sadang", lineId: "line-2", nodeType: "PLATFORM" },
    { id: "sadang:line-4:PLATFORM", stationId: "sadang", lineId: "line-4", nodeType: "PLATFORM" },
  ];
  const result = buildTransferBaseline({ roster, rows: [transferRow()], existingEdges, existingNodes });
  assert.equal(result.transferRules.length, 1);
  assert.equal(result.stationPathwayEdges.length, 0);
  assert.equal(result.transferRules[0].pathwayEdgeId, null);
});

test("pathway edge 없는 역 → 검증 가능한 OFFICIAL_SOURCE 단방향 edge 생성 + rule 연결", () => {
  const existingNodes = [
    { id: "sadang:line-2:PLATFORM", stationId: "sadang", lineId: "line-2", nodeType: "PLATFORM" },
    { id: "sadang:line-4:PLATFORM", stationId: "sadang", lineId: "line-4", nodeType: "PLATFORM" },
  ];
  const result = buildTransferBaseline({
    roster,
    rows: [transferRow()],
    existingEdges: [],
    existingNodes,
    verifiedAt: "2026-07-12T00:00:00.000Z",
    evidenceHash: "a".repeat(64),
  });
  assert.equal(result.stationPathwayEdges.length, 1);
  const edge = result.stationPathwayEdges[0];
  assert.equal(edge.provenanceKind, "OFFICIAL_SOURCE");
  assert.equal(edge.edgeType, "WALK");
  assert.equal(edge.durationSeconds, 180);
  assert.equal(edge.distanceMeters, 120);
  assert.equal(edge.bidirectional, false);
  assert.equal(edge.verificationStatus, "VERIFIED");
  assert.equal(edge.verifiedAt, "2026-07-12T00:00:00.000Z");
  assert.equal(edge.evidenceHash, "a".repeat(64));
  assert.equal(edge.fromNodeId, "sadang:line-2:PLATFORM");
  assert.equal(edge.toNodeId, "sadang:line-4:PLATFORM");
  assert.equal(result.transferRules[0].pathwayEdgeId, edge.id);
});

test("서로 다른 방향 row는 각각 단방향 pathway edge로 보존한다", () => {
  const result = buildTransferBaseline({
    roster,
    rows: [transferRow(), transferRow({ 호선: "4호선", 환승노선: "2호선", 환승소요시간: 200 })],
    existingNodes: sadangPlatformNodes,
  });
  assert.equal(result.stationPathwayEdges.length, 2);
  assert.deepEqual(
    result.stationPathwayEdges.map((edge) => [edge.fromNodeId, edge.toNodeId, edge.bidirectional]),
    [
      ["sadang:line-2:PLATFORM", "sadang:line-4:PLATFORM", false],
      ["sadang:line-4:PLATFORM", "sadang:line-2:PLATFORM", false],
    ],
  );
});

test("임의 node ID를 쓰는 기존 edge도 node roster로 endpoint를 찾아 중복 생성하지 않는다", () => {
  const existingNodes = [
    { id: "platform-a", stationId: "sadang", lineId: "line-2", nodeType: "PLATFORM" },
    { id: "platform-b", stationId: "sadang", lineId: "line-4", nodeType: "PLATFORM" },
  ];
  const result = buildTransferBaseline({
    roster,
    rows: [transferRow()],
    existingNodes,
    existingEdges: [{ fromNodeId: "platform-a", toNodeId: "platform-b" }],
  });
  assert.equal(result.stationPathwayEdges.length, 0);
  assert.equal(result.transferRules[0].pathwayEdgeId, null);
});

test("중복 row는 방향쌍 리포트의 첫 적재값을 덮어쓰지 않는다", () => {
  const result = buildTransferBaseline({
    roster,
    rows: [
      transferRow({ 환승소요시간: 180 }),
      transferRow({ 환승소요시간: 240 }),
      transferRow({ 호선: "4호선", 환승노선: "2호선", 환승소요시간: 180 }),
    ],
  });
  const pair = result.directionPairReport.find((row) => row.stationId === "sadang");
  assert.equal(pair.forwardMinTransferSeconds, 180);
  assert.equal(pair.reverseMinTransferSeconds, 180);
  assert.equal(pair.secondsMismatch, false);
});

test("PLATFORM 노드 없는 역 → pathway edge quarantine, edge 미생성", () => {
  const result = buildTransferBaseline({ roster, rows: [transferRow()], existingEdges: [], existingNodes: [] });
  assert.equal(result.stationPathwayEdges.length, 0);
  assert.equal(result.transferRules.length, 1);
  assert.equal(result.transferRules[0].pathwayEdgeId, null);
  assert.equal(result.quarantine.length, 1);
  assert.match(result.quarantine[0].reason, /platform node missing/);
});

test("distanceMeters 형식 오류 → quarantine", () => {
  const result = buildTransferBaseline({ roster, rows: [transferRow({ 환승거리: "120" })] });
  assert.equal(result.transferRules.length, 0);
  assert.equal(result.quarantine.length, 1);
  assert.match(result.quarantine[0].reason, /환승거리/);
});
