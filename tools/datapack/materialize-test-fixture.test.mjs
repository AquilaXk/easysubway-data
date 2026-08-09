import assert from "node:assert/strict";
import test from "node:test";

import { projectRegionalMaterializeFixture } from "./materialize-test-fixture.mjs";

function fixture() {
  return {
    packs: [{
      id: "capital",
      version: "1",
      routeServiceArtifactEvidence: [{ serviceClass: "ITX_CHEONGCHUN" }],
      minimumTableRows: {
        network_edges: 1,
        transit_routes: 1,
        transit_trips: 1,
        transit_stop_times: 1,
      },
      transitRoutes: [{ id: "route-local", serviceClass: "URBAN_RAIL" }],
      transitTrips: [{ id: "trip-local", routeId: "route-local", serviceId: "local-calendar" }],
      transitStopTimes: [{ tripId: "trip-local" }],
      networkEdges: [{ id: "edge-local", serviceClass: "URBAN_RAIL" }],
      serviceCalendars: [{ serviceId: "local-calendar" }],
      serviceCalendarDates: [{ serviceId: "local-calendar" }],
    }],
  };
}

test("regional projection clones only capital@1 and removes its sole legacy evidence", () => {
  const input = fixture();
  const originalBytes = JSON.stringify(input);
  const projected = projectRegionalMaterializeFixture(input);
  const { routeServiceArtifactEvidence, ...projectedPack } = projected.packs[0];
  const { routeServiceArtifactEvidence: legacyEvidence, ...inputPack } = input.packs[0];

  assert.equal(JSON.stringify(input), originalBytes);
  assert.notEqual(projected, input);
  assert.equal(routeServiceArtifactEvidence, undefined);
  assert.deepEqual(projectedPack, inputPack);
  assert.deepEqual(legacyEvidence, [{ serviceClass: "ITX_CHEONGCHUN" }]);
});

test("regional projection fails closed when a current table or relationship references ITX", () => {
  const input = fixture();
  input.packs[0].transitTrips.push({ id: "trip-itx", routeId: "ITX_route", serviceId: "local-calendar" });

  assert.throws(
    () => projectRegionalMaterializeFixture(input),
    /contains an unexpected ITX reference/,
  );
});
