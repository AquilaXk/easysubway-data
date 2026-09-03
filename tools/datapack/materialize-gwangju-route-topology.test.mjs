import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  materializeGwangjuRouteTopology,
} from "./materialize-gwangju-route-topology.mjs";
import { parseAdmittedMolitGwangjuStationMappings } from "./build-molit-nationwide-fixture.mjs";
import {
  projectRegionalMaterializeFixture,
} from "./materialize-test-fixture.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const lineId = "line-e57a361e8892";
const topologySourceId = "gwangju-transportation-route-topology";
const membershipSourceId = "molit-urban-rail-full-route-gwangju-membership";
const rejectedTimetableSourceId = "gwangju-transportation-cyberstation-timetable";

test("#504 materializes only the admitted Gwangju topology and membership sets", async () => {
  const input = await fixture();
  assert.equal(input.inventory.sources.some(({ id }) => id === rejectedTimetableSourceId), false);

  const result = materializeGwangjuRouteTopology(input);
  const pack = result.packs[0];
  const mappingByCode = new Map(input.canonicalStationMappings
    .map((mapping) => [mapping.stationNumber, mapping]));
  const expectedStationLines = new Set(input.canonicalStationMappings
    .map(({ stationId }) => `${stationId}\0${lineId}`));
  const expectedEdges = new Set(input.topologySnapshot.edges.map((edge) => [
    mappingByCode.get(edge.fromStationCode)?.stationId,
    mappingByCode.get(edge.toStationCode)?.stationId,
    edge.durationSeconds,
    edge.distanceMeters,
  ].join("\0")));

  assert.deepEqual(new Set(pack.stationLines.filter(({ lineId: id }) => id === lineId)
    .map(({ stationId, lineId: id }) => `${stationId}\0${id}`)), expectedStationLines);
  assert.deepEqual(new Set(pack.networkEdges.filter(({ sourceId }) => sourceId === topologySourceId)
    .map(({ fromNodeId, toNodeId, durationSeconds, distanceMeters }) => [
      fromNodeId.slice(0, -lineId.length - 1),
      toNodeId.slice(0, -lineId.length - 1),
      durationSeconds,
      distanceMeters,
    ].join("\0"))), expectedEdges);
  assert.deepEqual(pack.sourceInventory.filter(({ id }) =>
    [membershipSourceId, topologySourceId, rejectedTimetableSourceId].includes(id))
    .map(({ id }) => id), [membershipSourceId, topologySourceId]);
  for (const table of ["serviceCalendars", "serviceCalendarDates", "transitRoutes",
    "transitTrips", "transitStopTimes"]) {
    assert.equal(pack[table].some(({ sourceId }) => sourceId === rejectedTimetableSourceId), false);
  }
});

test("#504 rejects stale, malformed, or unbound Gwangju topology inputs", async () => {
  const stale = await fixture();
  stale.now = new Date(stale.inventory.sources.find(({ id }) => id === topologySourceId)
    .topologyAdmissionEvidence.freshUntil);
  assert.throws(() => materializeGwangjuRouteTopology(stale), /stale|future/i);

  const malformed = await fixture();
  malformed.topologySnapshot.edges[0].durationSeconds += 1;
  assert.throws(() => materializeGwangjuRouteTopology(malformed), /topology snapshot/i);

  const unbound = await fixture();
  unbound.canonicalStationMappings = unbound.canonicalStationMappings.slice(1);
  assert.throws(() => materializeGwangjuRouteTopology(unbound), /membership|mapping/i);
});

async function fixture() {
  const [baseFixture, topologySnapshot, inventory] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json")
      .then(projectRegionalMaterializeFixture),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
  ]);
  const rawMembership = inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route");
  const membership = inventory.sources.find(({ id }) => id === membershipSourceId);
  const observation = await readJson(
    `tools/datapack/sources/${rawMembership.admissionEvidence.snapshotId}.json`,
  );
  return {
    baseFixture,
    topologySnapshot,
    inventory,
    canonicalStationMappings: parseAdmittedMolitGwangjuStationMappings(
      observation.normalizedProjection,
      observation.rawSha256,
      membership.membershipAdmissionEvidence.stationCount,
    ),
    now: new Date(inventory.sources.find(({ id }) => id === topologySourceId)
      .topologyAdmissionEvidence.capturedAt),
  };
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
