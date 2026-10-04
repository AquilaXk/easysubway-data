import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SERVICE_DAY_BOUNDARY_SECONDS,
  serviceDayBoundaryViolations,
  serviceDaySeconds,
} from "./service-day-seconds.mjs";

// #918: 원천이 24시 미만으로 적은 00:00~02:59 시각은 전날 운행일의 심야 시각이다.
// 운행일 경계는 03:00이고, 그 앞의 시각은 86400초 이상으로 표현한다.

test("운행일 경계(03:00) 앞 시각은 같은 운행일의 24시 이후 초로 옮기고, 경계 이후 시각은 그대로 둔다", () => {
  assert.equal(SERVICE_DAY_BOUNDARY_SECONDS, 10_800);
  assert.equal(serviceDaySeconds(0), 86_400);
  assert.equal(serviceDaySeconds(570), 86_970);
  assert.equal(serviceDaySeconds(10_799), 97_199);
  assert.equal(serviceDaySeconds(10_800), 10_800);
  assert.equal(serviceDaySeconds(20_100), 20_100);
  assert.equal(serviceDaySeconds(86_430), 86_430);
  assert.equal(serviceDaySeconds(null), null);
});

test("시각이 정수 초가 아니면 운행일 시각으로 바꾸지 않고 실패한다", () => {
  for (const value of [-1, 1.5, "570", undefined, Number.NaN]) {
    assert.throws(() => serviceDaySeconds(value), /SERVICE_DAY_SECONDS_INVALID/u);
  }
});

test("운행일 경계 앞 정차 시각이 남은 stop_time을 모두 찾는다", () => {
  const violations = serviceDayBoundaryViolations([
    { tripId: "trip-a", stopSequence: 1, arrivalSeconds: 86_430, departureSeconds: 86_430 },
    { tripId: "trip-b", stopSequence: 1, arrivalSeconds: 570, departureSeconds: 570 },
    { tripId: "trip-b", stopSequence: 2, arrivalSeconds: 10_790, departureSeconds: 10_800 },
    { tripId: "trip-c", stopSequence: 1, arrivalSeconds: 19_800, departureSeconds: 19_800 },
  ]);
  assert.deepEqual(violations, [
    { tripId: "trip-b", stopSequence: 1, arrivalSeconds: 570, departureSeconds: 570 },
    { tripId: "trip-b", stopSequence: 2, arrivalSeconds: 10_790, departureSeconds: 10_800 },
  ]);
  assert.deepEqual(serviceDayBoundaryViolations([]), []);
});
