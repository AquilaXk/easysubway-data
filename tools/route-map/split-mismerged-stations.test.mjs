import assert from "node:assert/strict";
import test from "node:test";
import { newStationId, planSplit, SPLITS } from "./split-mismerged-stations.mjs";

test("newStationId는 원 id·이동 노선에 대해 결정적이고 station- 접두 12hex를 낸다", () => {
  const a = newStationId("station-4e123a19a88f", "line-6e39be0cb6e2");
  const b = newStationId("station-4e123a19a88f", "line-6e39be0cb6e2");
  assert.equal(a, b, "결정적");
  assert.match(a, /^station-[0-9a-f]{12}$/);
  assert.notEqual(
    a,
    newStationId("station-4e123a19a88f", "seoul-2"),
    "이동 노선이 다르면 다른 id",
  );
  assert.notEqual(a, "station-4e123a19a88f", "원 id와 달라야 함");
});

test("planSplit는 이동 노선을 신규 id로 떼고 원 역 메타를 보존한다", () => {
  const station = {
    id: "station-4e123a19a88f",
    name_ko: "신촌",
    name_en: "",
    normalized_name: "신촌",
    region: "수도권",
    latitude: null,
    longitude: null,
  };
  const plan = planSplit(station, "line-6e39be0cb6e2");
  // 신규 역: 원 메타 보존 + 새 id
  assert.equal(plan.newStation.name_ko, "신촌");
  assert.equal(plan.newStation.region, "수도권");
  assert.equal(plan.newStation.id, newStationId(station.id, "line-6e39be0cb6e2"));
  assert.notEqual(plan.newStation.id, station.id);
  // 재지정: 이동 노선 행만 원 id → 신규 id
  assert.deepEqual(plan.reassignment, {
    lineId: "line-6e39be0cb6e2",
    fromStationId: "station-4e123a19a88f",
    toStationId: plan.newStation.id,
  });
});

test("SPLITS는 공식 근거를 붙인 신촌·양평 오병합 대상을 담는다", () => {
  const names = SPLITS.map((s) => s.name).sort();
  assert.deepEqual(names, ["신촌", "양평"]);
  for (const s of SPLITS) {
    assert.match(s.stationId, /^station-[0-9a-f]{12}$/);
    assert.ok(s.moveLineId, "이동(경의중앙) 노선 지정");
    assert.ok(s.keepEvidence && s.moveEvidence, "keep/move 공식 근거 문자열");
  }
});
