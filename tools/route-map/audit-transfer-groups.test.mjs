import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalStationViolationsForRegion,
  canonicalStationIdentityViolations,
  loadCanonicalStationDecisions,
  suspectMergePairs,
  suspectSplitGroups,
  transferGroupSpreads,
} from "./audit-transfer-groups.mjs";

test("transferGroupSpreads는 2노선 이상 그룹의 최대 쌍거리를 계산한다", () => {
  const rows = [
    { station_id: "s1", line_id: "a", x: 0, y: 0 },
    { station_id: "s1", line_id: "b", x: 3, y: 4 },
    { station_id: "s2", line_id: "a", x: 9, y: 9 },
  ];
  const spreads = transferGroupSpreads(rows);
  assert.equal(spreads.length, 1);
  assert.deepEqual(spreads[0], { stationId: "s1", lineIds: ["a", "b"], spread: 5 });
});

test("suspectSplitGroups는 임계 초과만 남긴다", () => {
  const spreads = [
    { stationId: "s1", lineIds: ["a", "b"], spread: 5 },
    { stationId: "s2", lineIds: ["a", "b"], spread: 200 },
  ];
  assert.deepEqual(suspectSplitGroups(spreads, { threshold: 60 }).map((s) => s.stationId), ["s2"]);
});

test("suspectMergePairs는 '역' 꼬리 정규화 동명·근접·별개 id 쌍을 찾는다", () => {
  const stations = [
    { stationId: "s-hub", nameKo: "김포공항", x: 100, y: 100 },
    { stationId: "s-dup", nameKo: "김포공항역", x: 110, y: 120 },
    { stationId: "s-far", nameKo: "김포공항역", x: 900, y: 900 },
  ];
  const pairs = suspectMergePairs(stations);
  assert.equal(pairs.length, 1);
  assert.deepEqual(
    [pairs[0].a.stationId, pairs[0].b.stationId].sort(),
    ["s-dup", "s-hub"],
  );
});

test("canonical station strict audit는 미분류·오분리·오병합·흡수 ID alias 누락을 잡는다", () => {
  const contract = loadCanonicalStationDecisions();
  const stations = [
    { stationId: "sangbong-a", normalizedName: "상봉", lineId: "line-7" },
    { stationId: "sangbong-b", normalizedName: "상봉", lineId: "line-gyeongui" },
    { stationId: "sinchon-2", normalizedName: "신촌", lineId: "line-2" },
    { stationId: "seoknam", normalizedName: "석남", lineId: "line-7" },
    { stationId: "unknown-a", normalizedName: "미분류", lineId: "line-a" },
    { stationId: "unknown-b", normalizedName: "미분류", lineId: "line-b" },
  ];
  const decisions = [
    {
      normalizedName: "상봉",
      status: "MERGE_CONFIRMED",
      canonicalStationId: "sangbong-a",
      absorbedStationIds: ["sangbong-b"],
      expectedLineIds: ["line-7", "line-gyeongui"],
      evidenceUrl: "https://example.com/official",
      reviewedAt: "2026-07-13",
      reason: "공식 환승역",
    },
    {
      normalizedName: "신촌",
      status: "DISTINCT_CONFIRMED",
      stationLines: {
        "sinchon-2": ["line-2"],
        "sinchon-gyeongui": ["line-gyeongui"],
      },
      evidenceUrl: "https://example.com/official",
      reviewedAt: "2026-07-13",
      reason: "공식 동명이역",
    },
    {
      normalizedName: "석남",
      status: "MERGE_CONFIRMED",
      canonicalStationId: "seoknam",
      absorbedStationIds: ["seoknam-old"],
      expectedLineIds: ["line-7"],
      evidenceUrl: "https://example.com/official",
      reviewedAt: "2026-07-13",
      reason: "공식 환승역",
    },
  ];

  assert.deepEqual(canonicalStationIdentityViolations({ stations, aliases: [], decisions }), [
    "미분류: MISSING_EVIDENCE (canonical station 2개)",
    "상봉: MERGE_CONFIRMED인데 canonical station이 2개입니다",
    "신촌: DISTINCT_CONFIRMED station ID 집합이 기대와 다릅니다 (sinchon-2)",
    "신촌: DISTINCT_CONFIRMED station sinchon-gyeongui가 없습니다",
    "석남: 흡수 ID alias seoknam-old → seoknam가 없습니다",
  ]);
  assert.ok(contract.decisions.some((decision) => decision.normalizedName === "상봉"));
  assert.ok(contract.decisions.some((decision) => decision.normalizedName === "신촌"));
});

test("DISTINCT_CONFIRMED는 계약 밖 추가 station ID를 거부한다", () => {
  const violations = canonicalStationIdentityViolations({
    stations: [
      { stationId: "sinchon-2", normalizedName: "신촌", lineId: "line-2" },
      { stationId: "sinchon-gyeongui", normalizedName: "신촌", lineId: "line-gyeongui" },
      { stationId: "sinchon-extra", normalizedName: "신촌", lineId: "line-extra" },
    ],
    aliases: [],
    decisions: [{
      normalizedName: "신촌",
      status: "DISTINCT_CONFIRMED",
      stationLines: {
        "sinchon-2": ["line-2"],
        "sinchon-gyeongui": ["line-gyeongui"],
      },
      evidenceUrl: "https://example.com/official",
      reviewedAt: "2026-07-13",
      reason: "공식 동명이역",
    }],
  });

  assert.deepEqual(violations, [
    "신촌: DISTINCT_CONFIRMED station ID 집합이 기대와 다릅니다 (sinchon-2,sinchon-extra,sinchon-gyeongui)",
  ]);
});

test("canonical 계약은 같은 region 감사에만 적용한다", () => {
  const contract = {
    region: "수도권",
    reviewedAt: "2026-07-13",
    decisions: [],
    controls: [],
  };
  const stations = [
    { stationId: "bujeon-a", normalizedName: "부전", lineId: "line-1" },
    { stationId: "bujeon-b", normalizedName: "부전", lineId: "line-2" },
  ];

  assert.deepEqual(canonicalStationViolationsForRegion({
    contract,
    region: "부산권",
    stations,
    aliases: [],
  }), []);
});
