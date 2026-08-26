import assert from "node:assert/strict";
import test from "node:test";

import { coverageNodeId, stationLineNodeFromEdgeEndpoint } from "./validate-datapack.mjs";

const itxExpressRide = {
  edge_type: "RIDE",
  service_class: "ITX_CHEONGCHUN",
  service_pattern: "EXPRESS",
};

test("network edge endpoints accept only exact station-line nodes except ITX EXPRESS RIDE", () => {
  assert.equal(
    stationLineNodeFromEdgeEndpoint("station-a:line-1", { edge_type: "RIDE", service_class: "SUBWAY", service_pattern: "LOCAL" }),
    "station-a:line-1",
  );
  assert.equal(stationLineNodeFromEdgeEndpoint("station-a:line-k:EXPRESS", itxExpressRide), "station-a:line-k");
  assert.equal(coverageNodeId("station-a:line-1"), "station-a:line-1");
  assert.equal(coverageNodeId("station-a:line-k:EXPRESS"), "station-a:line-k:EXPRESS");
  assert.equal(coverageNodeId("station-a:line-k:LOCAL"), "station-a:line-k:LOCAL");

  for (const [suffix, edge] of [
    ["LOCAL", { edge_type: "RIDE", service_class: "SUBWAY", service_pattern: "LOCAL" }],
    ["EXPRESS", { edge_type: "RIDE", service_class: "SUBWAY", service_pattern: "EXPRESS" }],
    ["LOCAL", { edge_type: "TRANSFER", service_class: "SUBWAY", service_pattern: "LOCAL" }],
    ["EXPRESS", { edge_type: "TRANSFER", service_class: "SUBWAY", service_pattern: "EXPRESS" }],
    ["LOCAL", { edge_type: "RIDE", service_class: "ITX_CHEONGCHUN", service_pattern: "EXPRESS" }],
    ["EXPRESS", { edge_type: "RIDE", service_class: "ITX_CHEONGCHUN", service_pattern: "LOCAL" }],
  ]) {
    assert.equal(stationLineNodeFromEdgeEndpoint(`station-a:line-1:${suffix}`, edge), null);
  }
});
