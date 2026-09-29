import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { integrateRegionalTimetables } from "./regional-timetable-integrator.mjs";
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
  assert.strictEqual(gwangjuTrips.length, 438); // 236 weekday + 202 holiday

  assert.strictEqual(regionalTrips.length, 7171);
  assert.strictEqual(regionalStopTimes.length, 202495);
  assert.strictEqual(integrated.transitTrips.length, initialTripCount + 7171);
  assert.strictEqual(integrated.transitStopTimes.length, initialStopCount + 202495);

  // Deep Parity Check: Gwangju weekday schedule must NOT be empty (resolves issue where 'WEEK' was wrongly checked as 'WEEKDAY')
  const gwangjuWeekdayTrips = gwangjuTrips.filter((t) => t.serviceId === "gwangju-weekday-2026");
  const gwangjuHolidayTrips = gwangjuTrips.filter((t) => t.serviceId === "gwangju-holiday-2026");
  assert.strictEqual(gwangjuWeekdayTrips.length, 236);
  assert.strictEqual(gwangjuHolidayTrips.length, 202);

  // Deep Parity Check: Gwangju Songjeong Station (117) must be resolved and present in stop times
  const songjeongStationId = initialPack.stations.find((s) => s.nameKo === "광주송정역")?.id;
  assert.ok(songjeongStationId, "Gwangju Songjeong station must exist in candidate stations");
  const songjeongStops = regionalStopTimes.filter((st) => st.stopId === songjeongStationId);
  assert.ok(songjeongStops.length > 0, "Gwangju Songjeong station must have scheduled stop times (not dropped)");

  // Deep Parity Check: Daegu Seongseo Industrial Complex Station (221) must be resolved and present
  const seongseoStationId = initialPack.stations.find((s) => s.nameKo === "성서산업단지")?.id;
  assert.ok(seongseoStationId, "Daegu Seongseo station must exist in candidate stations");
  const seongseoStops = regionalStopTimes.filter((st) => st.stopId === seongseoStationId);
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
        const curArr = stops[i].arrivalTimeSeconds ?? stops[i].arrivalSeconds;
        const prevDep = stops[i - 1].departureTimeSeconds ?? stops[i - 1].departureSeconds;
        assert.ok(
          curArr >= prevDep,
          `Monotonic time violation in ${tripId} between stop ${i - 1} (${prevDep}) and ${i} (${curArr})`
        );
      }
    }
  }
});
