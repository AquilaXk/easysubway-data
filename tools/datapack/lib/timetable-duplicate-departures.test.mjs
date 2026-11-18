import assert from "node:assert/strict";
import { test } from "node:test";

import { duplicateDepartureGroups } from "./timetable-duplicate-departures.mjs";

// #920: 같은 달력 안에서 (노선, 역, 출발 시각, 다음 역, 종착역)이 같은 trip이 둘 이상이면 같은 열차를 두 번 실은 것이다.
const trip = (id, serviceId, stops, lineId = "line-1") => ({
  trip: { id, routeId: `route-${lineId}`, serviceId },
  stopTimes: stops.map(([stationId, seconds], index) => ({
    tripId: id, stopSequence: index + 1, stationId, lineId, arrivalSeconds: seconds, departureSeconds: seconds,
  })),
});
const pack = (...items) => ({
  transitTrips: items.map(({ trip: row }) => row),
  transitStopTimes: items.flatMap(({ stopTimes }) => stopTimes),
});

test("같은 달력·노선에서 출발 시각·다음 역·종착역이 같은 trip 묶음을 찾는다", () => {
  const groups = duplicateDepartureGroups(pack(
    trip("a", "weekend", [["s1", 100], ["s2", 200], ["s3", 300]]),
    trip("b", "weekend", [["s1", 100], ["s2", 200], ["s3", 300]]),
    trip("c", "weekday", [["s1", 100], ["s2", 200], ["s3", 300]]),
  ));
  assert.deepEqual(groups, [
    { serviceId: "weekend", lineId: "line-1", stationId: "s1", departureSeconds: 100, nextStationId: "s2", terminalStationId: "s3", tripIds: ["a", "b"] },
    { serviceId: "weekend", lineId: "line-1", stationId: "s2", departureSeconds: 200, nextStationId: "s3", terminalStationId: "s3", tripIds: ["a", "b"] },
  ]);
});

test("종착역·다음 역·달력·노선이 다르면 같은 시각 출발도 다른 열차다", () => {
  assert.deepEqual(duplicateDepartureGroups(pack(
    trip("to-gwangmyeong", "weekend", [["s1", 100], ["s2", 200], ["g", 300]]),
    trip("to-incheon", "weekend", [["s1", 100], ["s2", 200], ["i", 300]]),
    trip("other-line", "weekend", [["s1", 100], ["s2", 200], ["g", 300]], "line-2"),
    trip("weekday", "weekday", [["s1", 100], ["s2", 200], ["g", 300]]),
  )), []);
});
