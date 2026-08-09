import assert from "node:assert/strict";
import test from "node:test";

import { projectRegionalMaterializeFixture } from "./materialize-test-fixture.mjs";

function fixture() {
  return {
    packs: [{
      minimumTableRows: {
        network_edges: 2,
        service_calendars: 2,
        service_calendar_dates: 2,
        transit_routes: 2,
        transit_trips: 2,
        transit_stop_times: 2,
      },
      routeServiceArtifactEvidence: [{ serviceClass: "ITX_CHEONGCHUN" }],
      transitRoutes: [
        { id: "route-itx", serviceClass: "ITX_CHEONGCHUN" },
        { id: "route-local", serviceClass: "URBAN_RAIL" },
      ],
      transitTrips: [
        { id: "trip-itx", routeId: "route-itx", serviceId: "itx-calendar" },
        { id: "trip-local", routeId: "route-local", serviceId: "local-calendar" },
      ],
      transitStopTimes: [
        { tripId: "trip-itx" },
        { tripId: "trip-local" },
      ],
      networkEdges: [
        { id: "edge-itx", serviceClass: "ITX_CHEONGCHUN" },
        { id: "edge-local", serviceClass: "URBAN_RAIL" },
      ],
      serviceCalendars: [
        { serviceId: "itx-calendar" },
        { serviceId: "local-calendar" },
      ],
      serviceCalendarDates: [
        { serviceId: "itx-calendar" },
        { serviceId: "local-calendar" },
      ],
    }],
  };
}

test("regional projection deep-clones and removes legacy ITX-linked rows", () => {
  const input = fixture();
  const originalBytes = JSON.stringify(input);
  const projected = projectRegionalMaterializeFixture(input);
  const pack = projected.packs[0];

  assert.equal(JSON.stringify(input), originalBytes);
  assert.notEqual(projected, input);
  assert.deepEqual(pack.routeServiceArtifactEvidence, []);
  assert.deepEqual(pack.transitRoutes.map(({ id }) => id), ["route-local"]);
  assert.deepEqual(pack.transitTrips.map(({ id }) => id), ["trip-local"]);
  assert.deepEqual(pack.transitStopTimes.map(({ tripId }) => tripId), ["trip-local"]);
  assert.deepEqual(pack.networkEdges.map(({ id }) => id), ["edge-local"]);
  assert.deepEqual(pack.serviceCalendars.map(({ serviceId }) => serviceId), ["local-calendar"]);
  assert.deepEqual(pack.serviceCalendarDates.map(({ serviceId }) => serviceId), ["local-calendar"]);
  assert.deepEqual(pack.minimumTableRows, {
    network_edges: 1,
    service_calendars: 1,
    service_calendar_dates: 1,
    transit_routes: 1,
    transit_trips: 1,
    transit_stop_times: 1,
  });
});

test("regional projection fails closed for an unrecognized ITX reference", () => {
  const input = fixture();
  input.packs[0].transitRoutes.push({ id: "route-unknown", serviceClass: "ITX_CHEONGCHUN_V2" });

  assert.throws(
    () => projectRegionalMaterializeFixture(input),
    /unrecognized ITX_CHEONGCHUN reference/,
  );
});
