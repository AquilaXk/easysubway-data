import assert from "node:assert/strict";
import test from "node:test";

import { assertNoRetiredTransitReferences, projectRetiredTransitLines } from "./project-retired-transit-lines.mjs";

const lineId = "line-cbe75f5287a1";
const retiredPolicy = [{
  lineId,
  operatorIds: ["maglev"],
  stationIds: ["orphan", "station-fce26411d581"],
  preservedStationIds: ["station-fce26411d581"],
  status: "OUT_OF_ACTIVE_SCOPE",
  serviceLifecycle: "RETIRED",
  evidenceRef: "source:incheon-maglev-track-facility-20251017",
}];

test("retired production transit는 line·membership·RIDE와 orphan station을 함께 제거한다", () => {
  const fixture = {
    coverageLineOperatorScopes: [{ regionId: "capital", operatorId: "maglev", lineId }],
    providerLineScopes: [{ regionId: "capital", operatorId: "maglev", lineId }],
    packs: [{
      id: "capital",
      coverageLineOperatorScopes: [{ regionId: "capital", operatorId: "maglev", lineId }],
      operators: [{ id: "maglev" }, { id: "airport" }],
      lines: [{ id: lineId, operatorId: "maglev" }, { id: "airport-line", operatorId: "airport" }],
      stations: [{ id: "orphan" }, { id: "station-fce26411d581" }],
      stationLines: [
        { stationId: "orphan", lineId },
        { stationId: "station-fce26411d581", lineId },
        { stationId: "station-fce26411d581", lineId: "airport-line" },
      ],
      networkEdges: [{ id: "ride", fromNodeId: `orphan:${lineId}`, toNodeId: `station-fce26411d581:${lineId}`, edgeType: "RIDE" }],
      routeMapPositions: [{ stationId: "orphan", lineId }, { stationId: "station-fce26411d581", lineId }],
      sourceInventory: [{ id: "shared-source", coverageLineOperatorScopes: [{ lineId }, { lineId: "airport-line" }] }],
    }],
  };

  const projected = projectRetiredTransitLines(fixture, retiredPolicy);
  const pack = projected.packs[0];
  assert.equal(pack.lines.some((line) => line.id === lineId), false);
  assert.equal(pack.stationLines.some((row) => row.lineId === lineId), false);
  assert.equal(pack.networkEdges.some((edge) => edge.id === "ride"), false);
  assert.equal(pack.stations.some((station) => station.id === "orphan"), false);
  assert.equal(pack.stations.some((station) => station.id === "station-fce26411d581"), true);
  assert.equal(pack.operators.some((operator) => operator.id === "maglev"), false);
  assert.equal(pack.sourceInventory.some((source) => source.id === "shared-source"), true);
  assert.deepEqual(pack.sourceInventory[0].coverageLineOperatorScopes, [{ lineId: "airport-line" }]);
  pack.stations.push({ id: "orphan" });
  pack.facilities = [{ stationId: "orphan" }];
  pack.operators.push({ id: "maglev" });
  projected.coverageLineOperatorScopes.push({ lineId });
  assert.throws(() => assertNoRetiredTransitReferences(projected, retiredPolicy), /retired transit remains/);
});

test("retired operator는 다른 active line이 참조하면 보존하고 dangling orphan은 fail closed한다", () => {
  const fixture = { packs: [{
    operators: [{ id: "maglev" }],
    lines: [{ id: lineId, operatorId: "maglev" }, { id: "shared-line", operatorId: "maglev" }],
    stations: [{ id: "orphan" }, { id: "station-fce26411d581" }],
    stationLines: [{ stationId: "orphan", lineId }, { stationId: "station-fce26411d581", lineId }, { stationId: "station-fce26411d581", lineId: "shared-line" }], networkEdges: [],
  }] };
  const projected = projectRetiredTransitLines(fixture, retiredPolicy);
  assert.equal(projected.packs[0].operators.some(({ id }) => id === "maglev"), true);
  projected.packs[0].sourceInventory = [{ unknownLineId: lineId }];
  assert.throws(() => assertNoRetiredTransitReferences(projected, retiredPolicy), /retired transit remains/);
});

test("partial reviewed pack은 retired reference가 없으면 보존하고 dangling ref는 거부한다", () => {
  const partial = { packs: [{ id: "capital", operators: [], lines: [], stations: [{ id: "station-fce26411d581" }], stationLines: [] }] };
  assert.deepEqual(projectRetiredTransitLines(partial, retiredPolicy), partial);
  const dangling = structuredClone(partial);
  dangling.packs[0].stations.push({ id: "orphan" });
  assert.throws(() => projectRetiredTransitLines(dangling, retiredPolicy), /projection input identity is invalid/);
});
