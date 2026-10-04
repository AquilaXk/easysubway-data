import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { holidayCalendarViolations, holidayExceptionRows, integrateRegionalTimetables } from "./regional-timetable-integrator.mjs";
import { HOLIDAYS_2026 } from "../materialize-incheon-timetable.mjs";
import { checkNoSyntheticScheduleLoops } from "../../ci/guard-datapack-anti-cheat.mjs";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

test("integrateRegionalTimetables integrates all 4 regional authorities with authentic schedules", async () => {
  const readJson = async (rel) => JSON.parse(await readFile(path.join(root, rel), "utf8"));

  const [
    baseFixture,
    busanTimetable,
    busanAccessibility,
    daeguTimetable1,
    daeguTimetable2,
    daeguTimetable3,
    daeguAccessibility,
    daejeonTimetable,
    daejeonAccessibility,
    gwangjuTimetable,
    gwangjuAccessibility,
  ] = await Promise.all([
    readJson("tools/datapack/release/capital-production-canonical-pack.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260909.json"),
    readJson("tools/datapack/sources/busan-transportation-accessibility-3854af12545fc002afaae3204784bf5e9a786a328223c531702b635cf9c47a78-20260909.json"),
    readJson("tools/datapack/sources/daegu-line1-train-timetable-f923a86097012cd0d0b76e59599790fb4ec4756269fb0afd293ac9683c31f77c.json"),
    readJson("tools/datapack/sources/daegu-line2-train-timetable-798b98f01d9803c2dbe148c6864a876ef991401f19105f711722740a8e5f8215.json"),
    readJson("tools/datapack/sources/daegu-line3-train-timetable-9763cdb46b4b2a7ab6ae24f607bba79206763a7329a68b86d16d12f2622d3100.json"),
    readJson("tools/datapack/sources/daegu-transportation-accessibility-25276f4f6e48ab8c6ffca6af833af14ad33fd86777af9d3376eed4b6a77fef9e-20260909.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260909.json"),
    readJson("tools/datapack/sources/daejeon-transportation-accessibility-31ef85c5ac5d279d7322c028e05f7be16e6c5a794aa313aef314eef076b61426-20260909.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-accessibility-a39793ed95d7f0075fa0fd58378e651823d9c1ed752ac310a86c853f8853f521-20260909.json"),
  ]);

  const initialPack = baseFixture.packs[0];
  const initialRouteCount = initialPack.transitRoutes.length;
  const initialTripCount = initialPack.transitTrips.length;
  const initialStopCount = initialPack.transitStopTimes.length;
  const initialCalendarCount = initialPack.serviceCalendars.length;

  const integrated = integrateRegionalTimetables({
    finalPack: initialPack,
    holidayDates: HOLIDAYS_2026,
    busanTimetable,
    busanAccessibility,
    daeguTimetable1,
    daeguTimetable2,
    daeguTimetable3,
    daeguAccessibility,
    daejeonTimetable,
    daejeonAccessibility,
    gwangjuTimetable,
    gwangjuAccessibility,
  });

  // 1. Routes: Exactly 9 regional routes added (4 Busan + 3 Daegu + 1 Daejeon + 1 Gwangju)
  assert.strictEqual(integrated.transitRoutes.length, initialRouteCount + 9);
  const routeIds = new Set(integrated.transitRoutes.map((r) => r.id));
  assert.ok(routeIds.has("route-busan-line-1"));
  assert.ok(routeIds.has("route-busan-line-2"));
  assert.ok(routeIds.has("route-busan-line-3"));
  assert.ok(routeIds.has("route-busan-line-4"));
  assert.ok(routeIds.has("route-daegu-line-1"));
  assert.ok(routeIds.has("route-daegu-line-2"));
  assert.ok(routeIds.has("route-daegu-line-3"));
  assert.ok(routeIds.has("route-daejeon-line-1"));
  assert.ok(routeIds.has("route-gwangju-line-1"));

  // 2. Service Calendars: Exactly 16 regional calendars added (3 Busan + 9 Daegu + 2 Daejeon + 2 Gwangju)
  assert.strictEqual(integrated.serviceCalendars.length, initialCalendarCount + 16);

  // 3. Trips and StopTimes: Significant increase from genuine scheduled records
  const isRegional = (id) => id.startsWith("trip-busan-") || id.startsWith("trip-daegu-") || id.startsWith("trip-daejeon-") || id.startsWith("trip-gwangju-");
  const regionalTrips = integrated.transitTrips.filter((t) => isRegional(t.id));
  const regionalStopTimes = integrated.transitStopTimes.filter((st) => isRegional(st.tripId));

  const busanTrips = regionalTrips.filter((t) => t.id.startsWith("trip-busan-"));
  const daeguTrips = regionalTrips.filter((t) => t.id.startsWith("trip-daegu-"));
  const daejeonTrips = regionalTrips.filter((t) => t.id.startsWith("trip-daejeon-"));
  const gwangjuTrips = regionalTrips.filter((t) => t.id.startsWith("trip-gwangju-"));

  assert.strictEqual(busanTrips.length, 3733);
  assert.strictEqual(daeguTrips.length, 2540);
  assert.strictEqual(daejeonTrips.length, 460); // 121 weekday dn + 121 weekday up + 109 holiday dn + 109 holiday up
  // #855: 원천 정차 하나뿐인 녹동 출발 38건(평일 21·휴일 17)은 추정 종착역을 붙이지 않아 열차가 되지 않고 격리된다.
  assert.strictEqual(gwangjuTrips.length, 400); // 215 weekday + 185 holiday
  assert.strictEqual(integrated.regionalTimetableQuarantine.length, 38);

  // #855: 대전 460·광주 438개 추정 종착역 정차와 격리된 녹동 출발 38개가 빠진다(202,495 - 936).
  assert.strictEqual(regionalTrips.length, 7133);
  assert.strictEqual(regionalStopTimes.length, 201559);
  assert.strictEqual(integrated.transitTrips.length, initialTripCount + 7133);
  assert.strictEqual(integrated.transitStopTimes.length, initialStopCount + 201559);

  // Deep Parity Check: Gwangju weekday schedule must NOT be empty (resolves issue where 'WEEK' was wrongly checked as 'WEEKDAY')
  const gwangjuWeekdayTrips = gwangjuTrips.filter((t) => t.serviceId === "gwangju-weekday-2026");
  const gwangjuHolidayTrips = gwangjuTrips.filter((t) => t.serviceId === "gwangju-holiday-2026");
  assert.strictEqual(gwangjuWeekdayTrips.length, 215);
  assert.strictEqual(gwangjuHolidayTrips.length, 185);

  // Deep Parity Check: Gwangju Songjeong Station (117) must be resolved and present in stop times
  const songjeongStationId = initialPack.stations.find((s) => s.nameKo === "광주송정역")?.id;
  assert.ok(songjeongStationId, "Gwangju Songjeong station must exist in candidate stations");
  const songjeongStops = regionalStopTimes.filter((st) => st.stationId === songjeongStationId);
  assert.ok(songjeongStops.length > 0, "Gwangju Songjeong station must have scheduled stop times (not dropped)");

  // Deep Parity Check: Daegu Seongseo Industrial Complex Station (221) must be resolved and present
  const seongseoStationId = initialPack.stations.find((s) => s.nameKo === "성서산업단지")?.id;
  assert.ok(seongseoStationId, "Daegu Seongseo station must exist in candidate stations");
  const seongseoStops = regionalStopTimes.filter((st) => st.stationId === seongseoStationId);
  assert.ok(seongseoStops.length > 0, "Daegu Seongseo station must have scheduled stop times (not dropped)");

  // Deep Parity Check: Daejeon both directions (0 and 1) must be present
  const daejeonDir0 = daejeonTrips.filter((t) => t.directionId === 0);
  const daejeonDir1 = daejeonTrips.filter((t) => t.directionId === 1);
  assert.strictEqual(daejeonDir0.length, 230);
  assert.strictEqual(daejeonDir1.length, 230);

  // 4. Anti-Cheat: No synthetic loop patterns anywhere in generated trips
  const violations = checkNoSyntheticScheduleLoops({ transitTrips: integrated.transitTrips });
  assert.strictEqual(violations.length, 0, "No synthetic loops must exist in integrated trips");

  // 5. Every stop sequence starts at 1 and increases monotonically
  const tripStopMap = new Map();
  for (const st of integrated.transitStopTimes) {
    if (!tripStopMap.has(st.tripId)) tripStopMap.set(st.tripId, []);
    tripStopMap.get(st.tripId).push(st);
  }

  for (const [tripId, stops] of tripStopMap) {
    assert.ok(stops.length >= 2, `Trip ${tripId} must have at least 2 stops`);
    for (let i = 0; i < stops.length; i++) {
      assert.strictEqual(stops[i].stopSequence, i + 1, `Stop sequence for ${tripId} at index ${i} must be ${i + 1}`);
      if (i > 0) {
        const curArr = stops[i].arrivalSeconds;
        const prevDep = stops[i - 1].departureSeconds;
        assert.ok(
          curArr >= prevDep,
          `Monotonic time violation in ${tripId} between stop ${i - 1} (${prevDep}) and ${i} (${curArr})`
        );
      }
    }
  }
});

// #919: 공휴일은 KASI 특일 정보 기준(HOLIDAYS_2026, fetch-kasi 테스트가 원문과 같음을 고정한다).
// 휴일 = 토·일·공휴일. 토요일 시간표가 있는 부산·대구는 토요일 공휴일에 휴일 시간표를 쓰고,
// 토요일 시간표가 없는 대전은 휴일 달력이 토요일을 이미 포함한다. 세 기관 원천에는 명절 시간표가 없다(휴일 시간표).
test("#919 부산·대구·대전 달력은 공휴일에 평일·토요일 달력을 빼고(2) 휴일 달력을 더한다(1)", async () => {
  const integrated = integrateRegionalTimetables({
    finalPack: { stations: [], stationLines: [], serviceCalendars: [], serviceCalendarDates: [] },
    holidayDates: HOLIDAYS_2026,
  });
  const rows = integrated.serviceCalendarDates;
  const on = (date) => rows.filter((row) => row.date === date)
    .map(({ serviceId, exceptionType }) => `${serviceId}:${exceptionType}`).sort();
  const lines = (pattern) => ["daegu-line1", "daegu-line2", "daegu-line3"].map((prefix) => pattern.replace("daegu", prefix));
  // 2026-10-09(금, 한글날)
  assert.deepEqual(on("20261009"), [
    "busan-holiday-2026:1", "busan-weekday-2026:2",
    ...lines("daegu-holiday-2026:1"), ...lines("daegu-weekday-2026:2"),
    "daejeon-holiday-2026:1", "daejeon-weekday-2026:2",
  ].sort());
  // 2026-10-03(토, 개천절): 토요일 시간표가 있는 기관만 토요일→휴일. 대전 휴일 달력은 토요일에 이미 운행한다.
  assert.deepEqual(on("20261003"), [
    "busan-holiday-2026:1", "busan-saturday-2026:2",
    ...lines("daegu-holiday-2026:1"), ...lines("daegu-saturday-2026:2"),
  ].sort());
  // 2026-03-01(일, 삼일절): 일요일은 이미 휴일 달력이다.
  assert.deepEqual(on("20260301"), []);
  // 기관별 행 수: 부산·대구 노선당 평일 공휴일 16 + 토요일 공휴일 4 + 휴일 추가 20, 대전 평일 16 + 휴일 16
  const count = (prefix) => rows.filter(({ serviceId }) => serviceId.startsWith(prefix)).length;
  assert.deepEqual([count("busan-"), count("daegu-line1-"), count("daegu-line2-"), count("daegu-line3-"), count("daejeon-")],
    [40, 40, 40, 40, 32]);
  assert.equal(rows.length, 192);
  assert.ok(rows.every((row) => Object.keys(row).sort().join() === "date,exceptionType,serviceId"));
});

test("#919 공휴일 목록이 없거나 형식이 틀리면 달력을 추정으로 채우지 않고 실패한다", () => {
  const finalPack = { stations: [], stationLines: [], serviceCalendars: [], serviceCalendarDates: [] };
  for (const holidayDates of [undefined, [], ["2026-10-09"], ["20261309"], ["20261009", "20261009"], ["20251225"]]) {
    assert.throws(() => integrateRegionalTimetables({ finalPack, holidayDates }), /REGIONAL_TIMETABLE_HOLIDAY_DATES_INVALID/u);
  }
});

test("#919 공휴일에 평일·토요일 달력이 운행하거나 휴일 달력이 하나도 운행하지 않는 노선을 찾는다", () => {
  const calendar = (serviceId, days) => ({ serviceId, ...Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    .map((day, index) => [day, days[index] === 1])), startDate: "20260101", endDate: "20261231" });
  const serviceCalendars = [
    calendar("ok-weekday", [1, 1, 1, 1, 1, 0, 0]), calendar("ok-holiday", [0, 0, 0, 0, 0, 1, 1]),
    calendar("bad-weekday", [1, 1, 1, 1, 1, 0, 0]), calendar("bad-saturday", [0, 0, 0, 0, 0, 1, 0]), calendar("bad-holiday", [0, 0, 0, 0, 0, 0, 1]),
    calendar("festival", [0, 0, 0, 0, 0, 0, 0]), calendar("festival-holiday", [0, 0, 0, 0, 0, 0, 1]),
    calendar("saturday-only", [0, 0, 0, 0, 0, 1, 0]),
  ];
  const serviceCalendarDates = [
    { serviceId: "ok-weekday", date: "20261009", exceptionType: 2 }, { serviceId: "ok-holiday", date: "20261009", exceptionType: 1 },
    { serviceId: "festival", date: "20260925", exceptionType: 1 }, { serviceId: "festival-holiday", date: "20260925", exceptionType: 2 },
    { serviceId: "festival-holiday", date: "20261003", exceptionType: 1 }, { serviceId: "saturday-only", date: "20261003", exceptionType: 2 }, { serviceId: "festival-holiday", date: "20261009", exceptionType: 1 },
  ];
  const transitTrips = [
    { routeId: "route-ok", serviceId: "ok-weekday" }, { routeId: "route-ok", serviceId: "ok-holiday" },
    { routeId: "route-bad", serviceId: "bad-weekday" }, { routeId: "route-bad", serviceId: "bad-saturday" }, { routeId: "route-bad", serviceId: "bad-holiday" },
    { routeId: "route-festival", serviceId: "festival" }, { routeId: "route-festival", serviceId: "festival-holiday" },
    // 토요일 열차만 있는 운행 패턴 노선(광주 보관본 등)은 공휴일에 운행하지 않는 것이 맞다.
    { routeId: "route-saturday-pattern", serviceId: "saturday-only" },
  ];
  const violations = holidayCalendarViolations({ serviceCalendars, serviceCalendarDates, transitTrips, holidayDates: ["20260925", "20261003", "20261009"] });
  assert.deepEqual(violations, [
    { routeId: "route-bad", date: "20260925", serviceId: "bad-weekday", reason: "REGULAR_SERVICE_ACTIVE_ON_HOLIDAY" },
    { routeId: "route-bad", date: "20260925", serviceId: null, reason: "NO_HOLIDAY_SERVICE_ACTIVE" },
    { routeId: "route-bad", date: "20261003", serviceId: "bad-saturday", reason: "REGULAR_SERVICE_ACTIVE_ON_HOLIDAY" },
    { routeId: "route-bad", date: "20261003", serviceId: null, reason: "NO_HOLIDAY_SERVICE_ACTIVE" },
    { routeId: "route-bad", date: "20261009", serviceId: "bad-weekday", reason: "REGULAR_SERVICE_ACTIVE_ON_HOLIDAY" },
    { routeId: "route-bad", date: "20261009", serviceId: null, reason: "NO_HOLIDAY_SERVICE_ACTIVE" },
    { routeId: "route-ok", date: "20260925", serviceId: "ok-weekday", reason: "REGULAR_SERVICE_ACTIVE_ON_HOLIDAY" },
    { routeId: "route-ok", date: "20260925", serviceId: null, reason: "NO_HOLIDAY_SERVICE_ACTIVE" },
  ]);
});

// 리뷰 F1(#922): 달력 창(startDate~endDate) 밖의 공휴일은 예외 행도, 운행 판정도 만들지 않는다.
const windowCalendar = (serviceId, days, startDate, endDate) => ({ serviceId,
  ...Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day, index) => [day, days[index] === 1])),
  startDate, endDate });

test("#922 달력 창 밖 공휴일(2025-12-25·2027-01-01)에는 예외 행을 만들지 않는다", () => {
  const rows = holidayExceptionRows([
    { calendar: windowCalendar("weekday", [1, 1, 1, 1, 1, 0, 0], "20260101", "20261231"), holiday: false },
    { calendar: windowCalendar("holiday", [0, 0, 0, 0, 0, 0, 1], "20260101", "20261231"), holiday: true },
  ], ["20251225", "20261009", "20270101"]);
  assert.deepEqual(rows, [
    { serviceId: "weekday", date: "20261009", exceptionType: 2 },
    { serviceId: "holiday", date: "20261009", exceptionType: 1 },
  ]);
});

test("#922 공휴일 불변식은 창 밖 달력을 운행 중으로 보지 않고, 모든 달력 창 밖 날짜는 판정하지 않는다", () => {
  const violations = holidayCalendarViolations({
    serviceCalendars: [
      windowCalendar("holiday-2026", [0, 0, 0, 0, 0, 0, 1], "20260101", "20261231"),
      windowCalendar("weekday-2027", [1, 1, 1, 1, 1, 0, 0], "20270101", "20271231"),
    ],
    serviceCalendarDates: [{ serviceId: "holiday-2026", date: "20261009", exceptionType: 1 }],
    transitTrips: [{ routeId: "route-x", serviceId: "holiday-2026" }, { routeId: "route-x", serviceId: "weekday-2027" }],
    holidayDates: ["20251225", "20261009"],
  });
  assert.deepEqual(violations, []);
});
