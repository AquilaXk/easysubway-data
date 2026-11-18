import assert from "node:assert/strict";
import test from "node:test";
import { MERGES, planMerge } from "./merge-alias-stations.mjs";

test("MERGES는 공식 근거를 붙인 서해선 별칭 오분리 2쌍을 담는다", () => {
  const names = MERGES.map((m) => m.name).sort();
  assert.deepEqual(names, ["김포공항", "부천종합운동장"]);
  for (const m of MERGES) {
    assert.match(m.aliasId, /^station-[0-9a-f]{12}$/);
    assert.match(m.representativeId, /^station-[0-9a-f]{12}$/);
    assert.notEqual(m.aliasId, m.representativeId);
    assert.ok(m.evidence, "공식 근거 문자열");
  }
});

test("planMerge는 별칭의 모든 노선 멤버십을 대표 id로 재지정하고 별칭 역 삭제를 낸다", () => {
  const plan = planMerge("station-cbe94ebaafe2", ["line-051552e50435"], "station-1f38f0831cb1");
  assert.equal(plan.deleteStationId, "station-cbe94ebaafe2");
  assert.deepEqual(plan.reassignments, [
    {
      lineId: "line-051552e50435",
      fromStationId: "station-cbe94ebaafe2",
      toStationId: "station-1f38f0831cb1",
    },
  ]);
});

test("planMerge는 별칭이 여러 노선을 가져도 각각 재지정한다", () => {
  const plan = planMerge("alias", ["l1", "l2"], "rep");
  assert.deepEqual(
    plan.reassignments.map((r) => r.lineId),
    ["l1", "l2"],
  );
  assert.ok(plan.reassignments.every((r) => r.toStationId === "rep"));
});
