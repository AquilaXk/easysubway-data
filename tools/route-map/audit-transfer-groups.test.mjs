import assert from "node:assert/strict";
import test from "node:test";
import {
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
