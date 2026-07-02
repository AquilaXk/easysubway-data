import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildRouteGraphCoverageReport } from "./build-route-graph-coverage-report.mjs";

const execFileAsync = promisify(execFile);

test("builds generated connector and strict route-not-found coverage report", () => {
  const report = buildRouteGraphCoverageReport({
    generatedConnectors: [
      { stationId: "station-a", lineId: "line-4", edgeType: "entry", region: "수도권", operatorId: "seoul-metro", generated: true, verifiedAccessibility: false },
      { stationId: "station-a", lineId: "line-4", edgeType: "entry", region: "수도권", operatorId: "seoul-metro", generated: false, verifiedAccessibility: true },
      { stationId: "station-b", lineId: "line-2", edgeType: "inStationTransfer", region: "수도권", operatorId: "seoul-metro", generated: true, verifiedAccessibility: false },
    ],
    strictOdResults: [
      { odId: "od-1", originStationId: "station-a", destinationStationId: "station-b", found: true },
      { odId: "od-2", originStationId: "station-a", destinationStationId: "station-c", found: false, reasonCode: "GENERATED_CONNECTOR_UNVERIFIED", priority: "HIGH" },
    ],
  });

  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.generatedConnector.byStation[0], {
    stationId: "station-a",
    lineId: "line-4",
    edgeType: "entry",
    region: "수도권",
    operatorId: "seoul-metro",
    generatedCount: 1,
    explicitCount: 1,
    ratio: 0.5,
  });
  assert.deepEqual(report.generatedConnector.byRegion, [
    { region: "수도권", operatorId: "seoul-metro", generatedCount: 2, explicitCount: 1, ratio: 2 / 3 },
  ]);
  assert.equal(report.generatedConnectorVerifiedAccessibilityCount, 0);
  assert.deepEqual(report.strictRouteNotFound, {
    total: 2,
    notFoundCount: 1,
    rate: 0.5,
    byReasonCode: { GENERATED_CONNECTOR_UNVERIFIED: 1 },
  });
  assert.deepEqual(report.priorityBacklog, [
    {
      odId: "od-2",
      originStationId: "station-a",
      destinationStationId: "station-c",
      reasonCode: "GENERATED_CONNECTOR_UNVERIFIED",
    },
  ]);
});

test("writes route graph coverage report json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "route-graph-coverage-"));
  const input = path.join(dir, "coverage-input.json");
  const output = path.join(dir, "route-graph-coverage-report.json");
  await writeFile(input, JSON.stringify({ generatedConnectors: [], strictOdResults: [] }));

  await execFileAsync(process.execPath, ["tools/routes/build-route-graph-coverage-report.mjs", "--input", input, "--output", output]);

  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.strictRouteNotFound.rate, 0);
});
