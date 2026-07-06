import assert from "node:assert/strict";
import { test } from "node:test";
import { buildKricLine4CollectionPlan } from "./plan-kric-line4-collection.mjs";

const ROSTER = {
  lnCd: "4",
  stations: [
    { stinConsOrdr: 28, stinCd: "433", railOprIsttCd: "S1", stinNm: "사당" },
    { stinConsOrdr: 43, stinCd: "448", railOprIsttCd: "KR", stinNm: "상록수" },
  ],
};

test("KRIC 수집 계획은 역×dayCd(3)로 subwayTimetableExp만 요청한다(일반의 상위집합)", () => {
  const plan = buildKricLine4CollectionPlan(ROSTER);
  assert.equal(plan.stationCount, 2);
  assert.equal(plan.operation, "subwayTimetableExp");
  assert.deepEqual(plan.dayCds, ["8", "7", "9"]);
  // 2역 × 3 dayCd × 1 operation = 6 (일반+급행 중복 수집 없음)
  assert.equal(plan.requestCount, 6);
  assert.ok(plan.requests.every((r) => r.operation === "subwayTimetableExp"));
  const first = plan.requests[0];
  assert.equal(first.requestKey, "subwayTimetableExp|S1|433|8");
  assert.equal(first.params.railOprIsttCd, "S1");
  assert.equal(first.params.lnCd, "4");
});

test("KRIC 수집 계획은 각 역을 자기 소유기관으로 조회한다(직결 열차 포함 목적)", () => {
  const plan = buildKricLine4CollectionPlan(ROSTER);
  const sadang = plan.requests.filter((r) => r.params.stinCd === "433");
  const sangnoksu = plan.requests.filter((r) => r.params.stinCd === "448");
  assert.ok(sadang.every((r) => r.params.railOprIsttCd === "S1"));
  assert.ok(sangnoksu.every((r) => r.params.railOprIsttCd === "KR"));
});

test("KRIC 수집 계획은 dayCd 지정을 반영한다", () => {
  const plan = buildKricLine4CollectionPlan(ROSTER, { dayCds: ["8"] });
  assert.equal(plan.requestCount, 2);
  assert.ok(plan.requests.every((r) => r.params.dayCd === "8"));
});

test("KRIC 수집 계획은 빈 로스터·필수 필드 누락을 거부한다", () => {
  assert.throws(() => buildKricLine4CollectionPlan({ lnCd: "4", stations: [] }), /roster.stations must be a non-empty array/);
  assert.throws(() => buildKricLine4CollectionPlan({ stations: [ROSTER.stations[0]] }), /roster.lnCd must be a non-empty string/);
  assert.throws(
    () => buildKricLine4CollectionPlan({ lnCd: "4", stations: [{ stinCd: "433", stinNm: "사당" }] }),
    /station.railOprIsttCd must be a non-empty string/,
  );
});
