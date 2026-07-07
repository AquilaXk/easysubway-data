import assert from "node:assert/strict";
import test from "node:test";
import { denseHubs } from "./densify-hubs.mjs";

test("denseHubs는 threshold 미만 쌍을 연결 성분(허브)으로 묶는다", () => {
  const stations = [
    { stationId: "a", x: 0, y: 0 }, { stationId: "b", x: 5, y: 0 }, { stationId: "c", x: 8, y: 0 },
    { stationId: "d", x: 500, y: 500 },
  ];
  const hubs = denseHubs(stations, 26);
  assert.equal(hubs.length, 1);
  assert.deepEqual([...hubs[0]].sort(), ["a", "b", "c"]);
});

test("denseHubs는 threshold 이상만 있으면 빈 배열", () => {
  assert.deepEqual(denseHubs([{ stationId: "a", x: 0, y: 0 }, { stationId: "b", x: 100, y: 0 }], 26), []);
});
