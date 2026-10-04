import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SERVICE_DAY_BOUNDARY_SECONDS,
  serviceDaySeconds,
  serviceDayStopTimes,
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

test("자정 이후 시발 열차(인천 1호선 1305형)는 정차 시각 전체가 86400초 이상이 되고, 자정을 넘는 열차는 그대로다", () => {
  const rows = [
    // 1301: 수집기가 이미 자정 이후 정차를 86400초 이상으로 이어 둔 열차
    { tripId: "trip-1301", stopSequence: 1, arrivalSeconds: 85_590, departureSeconds: 85_590 },
    { tripId: "trip-1301", stopSequence: 2, arrivalSeconds: 86_430, departureSeconds: 86_430 },
    // 1305: 원천 FILE이 00:09:30 시발로 적은 막차
    { tripId: "trip-1305", stopSequence: 2, arrivalSeconds: 1_410, departureSeconds: 1_410 },
    { tripId: "trip-1305", stopSequence: 1, arrivalSeconds: 570, departureSeconds: 570 },
    { tripId: "trip-first", stopSequence: 1, arrivalSeconds: 19_800, departureSeconds: 19_800 },
    { tripId: "trip-first", stopSequence: 2, arrivalSeconds: 19_920, departureSeconds: 19_950 },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(serviceDayStopTimes(rows).map(({ tripId, stopSequence, arrivalSeconds, departureSeconds }) =>
    [tripId, stopSequence, arrivalSeconds, departureSeconds]), [
    ["trip-1301", 1, 85_590, 85_590],
    ["trip-1301", 2, 86_430, 86_430],
    ["trip-1305", 2, 87_810, 87_810],
    ["trip-1305", 1, 86_970, 86_970],
    ["trip-first", 1, 19_800, 19_800],
    ["trip-first", 2, 19_920, 19_950],
  ]);
  assert.deepEqual(rows, before);
});
