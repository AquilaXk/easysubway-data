import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { projectRegionalMaterializeFixture } from "./materialize-test-fixture.mjs";

const legacyEvidence = {
  serviceClass: "ITX_CHEONGCHUN",
  timetableArtifactId: "itx-cheongchun-completeness-admission-20260714T083544292Z",
  timetableArtifactSha256: "347aec507ec951dde65c10a1c4bff9f94454f762d76a5a74064a40662008336c",
  canonicalPackId: "capital",
  canonicalPackSha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
  canonicalPackSqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
  admissionStatus: "MISSING",
  admissionEligible: false,
  freshUntil: "2026-07-20T00:00:00.000Z",
  sourceIssue: 2116,
};
const root = path.resolve(import.meta.dirname, "../..");

function fixture() {
  return {
    manifest: { activePack: { id: "capital", version: "1" } },
    packs: [{
      id: "capital",
      version: "1",
      artifactKind: "production",
      routeServiceArtifactEvidence: [structuredClone(legacyEvidence)],
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
  const { routeServiceArtifactEvidence: inputLegacyEvidence, ...inputPack } = input.packs[0];

  assert.equal(JSON.stringify(input), originalBytes);
  assert.notEqual(projected, input);
  assert.equal(routeServiceArtifactEvidence, undefined);
  assert.deepEqual(projectedPack, inputPack);
  assert.deepEqual(inputLegacyEvidence, [legacyEvidence]);
});

test("regional projection fails closed when a current table or relationship references ITX", () => {
  const input = fixture();
  input.packs[0].transitTrips.push({ id: "trip-itx", routeId: "ITX_route", serviceId: "local-calendar" });

  assert.throws(
    () => projectRegionalMaterializeFixture(input),
    /contains an unexpected ITX reference/,
  );
});

test("regional projection rejects lowercase ITX identifiers", () => {
  const input = fixture();
  input.packs[0].networkEdges.push({ id: "itx-edge", serviceClass: "URBAN_RAIL" });

  assert.throws(
    () => projectRegionalMaterializeFixture(input),
    /contains an unexpected ITX reference/,
  );
});

test("regional projection rejects embedded ITX tokens and mutated legacy evidence", () => {
  const embeddedItx = fixture();
  embeddedItx.packs[0].transitRoutes[0].id = "KORAIL_ITX_CHEONGCHUN";
  assert.throws(
    () => projectRegionalMaterializeFixture(embeddedItx),
    /contains an unexpected ITX reference/,
  );

  const arbitrarySubstring = fixture();
  arbitrarySubstring.packs[0].transitRoutes[0].id = "station-itxpress-local";
  assert.doesNotThrow(() => projectRegionalMaterializeFixture(arbitrarySubstring));

  const mutatedEvidence = fixture();
  mutatedEvidence.packs[0].routeServiceArtifactEvidence[0].snapshotId = "unexpected";
  assert.throws(
    () => projectRegionalMaterializeFixture(mutatedEvidence),
    /must match the exact known contract/,
  );

  const manifestItx = fixture();
  manifestItx.manifest.note = "ITX_CHEONGCHUN";
  assert.throws(
    () => projectRegionalMaterializeFixture(manifestItx),
    /contains an unexpected ITX reference/,
  );

  const rootSibling = fixture();
  rootSibling.hidden = "ITX_CHEONGCHUN";
  assert.throws(() => projectRegionalMaterializeFixture(rootSibling));
});

test("regional projection preserves the tracked fixture except its sole legacy evidence", async () => {
  const fixturePath = path.join(root, "tools/datapack/release/capital-production-reviewed-pack.json");
  const bytes = await readFile(fixturePath);
  const input = JSON.parse(bytes);
  const original = structuredClone(input);
  const projected = projectRegionalMaterializeFixture(input);
  assert.deepEqual(await readFile(fixturePath), bytes);
  assert.deepEqual(input, original);
  assert.deepEqual(projected.manifest, original.manifest);
  const expectedPack = structuredClone(original.packs[0]);
  delete expectedPack.routeServiceArtifactEvidence;
  assert.deepEqual(projected.packs[0], expectedPack);
});
