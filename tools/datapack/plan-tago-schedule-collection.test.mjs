import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTagoScheduleCollectionPlan } from "./validate-tago-schedule-sample.mjs";

test("TAGO 시간표 수집 plan은 daily limit과 checkpoint resume을 적용한다", () => {
  const plan = buildTagoScheduleCollectionPlan(
    {
      stationLineRows: [
        { stationCode: "448", lineId: "seoul-4" },
        { stationCode: "433", lineId: "seoul-4" },
      ],
    },
    { completedRequestKeys: ["MTRKR4448|01|U"] },
    3,
  );
  assert.equal(plan.artifactKind, "tago-schedule-collection-plan");
  assert.equal(plan.dailyLimit, 3);
  assert.equal(plan.totalRequestCount, 12);
  assert.equal(plan.completedRequestCount, 1);
  assert.deepEqual(
    plan.batches.map((batch) => batch.requests.length),
    [3, 3, 3, 2],
  );
  assert.equal(plan.batches[0].requests[0].requestKey, "MTRKR4448|01|D");
  assert.ok(plan.batches.every((batch) => batch.requests.length <= 3));
});

test("TAGO 시간표 수집 plan은 파일럿 매핑 대상이 아닌 lineId를 거부한다", () => {
  assert.throws(
    () =>
      buildTagoScheduleCollectionPlan({
        stationLineRows: [{ stationCode: "113", lineId: "busan-1" }],
      }),
    /Unsupported lineId for pilot mapping: busan-1/,
  );
});
