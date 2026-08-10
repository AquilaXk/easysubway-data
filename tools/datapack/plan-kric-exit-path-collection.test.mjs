import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalKricExitPathCollectionPlanJson,
  planKricExitPathCollection,
} from "./plan-kric-exit-path-collection.mjs";

test("candidate directed LOCAL RIDE edge를 합성 reverse 없이 next-station query로 전개한다", () => {
  const input = validInput();

  const result = planKricExitPathCollection(input);

  assert.equal(result.queryPlan.length, 4);
  assert.deepEqual(result.stationLineQueries, [{
    stationLineId: "station-a:line-1",
    queryIds: result.queryPlan.filter(({ stationName }) => stationName === "가역").map(({ queryId }) => queryId),
  }, {
    stationLineId: "station-b:line-1",
    queryIds: result.queryPlan.filter(({ stationName }) => stationName === "나역").map(({ queryId }) => queryId),
  }, {
    stationLineId: "station-c:line-1",
    queryIds: result.queryPlan.filter(({ stationName }) => stationName === "다역").map(({ queryId }) => queryId),
  }]);
  assert.deepEqual(result.queryPlan.map((query) => [
    query.providerStationId,
    query.providerNextStationId,
    query.routeEdgeId,
  ]), [
    ["S1", "S2", "edge-a-b"],
    ["S1", "S3", "edge-a-c"],
    ["S2", "S1", "edge-b-a"],
    ["S3", "S1", "edge-c-a"],
  ]);
  assert.deepEqual(Object.keys(result.queryPlan[0]).sort(compareBytes), [
    "lineName", "operatorName", "providerLineId", "providerNextStationId",
    "providerOperatorId", "providerStationId", "queryId", "regionId",
    "routeEdgeId", "stationName",
  ].sort(compareBytes));
  assert.match(result.queryPlanSha256, /^[a-f0-9]{64}$/);
  assert.match(result.collectionPlanDigest, /^[a-f0-9]{64}$/);
});

test("input ordering과 input object mutation에 독립적인 canonical plan을 만든다", () => {
  const first = validInput();
  const second = validInput();
  const original = JSON.stringify(first);
  second.stationLines.reverse();
  second.providerMappings.reverse();
  second.routeEdges.reverse();

  const firstResult = planKricExitPathCollection(first);
  const secondResult = planKricExitPathCollection(second);

  assert.equal(JSON.stringify(first), original);
  assert.equal(
    canonicalKricExitPathCollectionPlanJson(firstResult),
    canonicalKricExitPathCollectionPlanJson(secondResult),
  );
});

test("missing·duplicate·extra provider mapping은 query 전에 fail closed한다", () => {
  const missing = validInput();
  missing.providerMappings.pop();
  refreshBindings(missing);
  assert.throws(() => planKricExitPathCollection(missing), /provider mapping denominator mismatch/);

  const duplicate = validInput();
  duplicate.providerMappings.push({ ...duplicate.providerMappings[0] });
  refreshBindings(duplicate);
  assert.throws(() => planKricExitPathCollection(duplicate), /duplicate EXIT provider mapping/);

  const extra = validInput();
  extra.providerMappings.push({
    stationId: "station-z",
    lineId: "line-1",
    providerOperatorId: "OP",
    providerLineId: "L1",
    providerStationId: "SZ",
  });
  refreshBindings(extra);
  assert.throws(() => planKricExitPathCollection(extra), /provider mapping denominator mismatch/);

  const ambiguous = validInput();
  ambiguous.providerMappings[1] = {
    ...ambiguous.providerMappings[1],
    providerStationId: ambiguous.providerMappings[0].providerStationId,
  };
  refreshBindings(ambiguous);
  assert.throws(() => planKricExitPathCollection(ambiguous), /ambiguous EXIT provider mapping tuple/);
});

test("서로 다른 route edge가 같은 실제 KRIC 요청 tuple로 축약되면 fail closed한다", () => {
  const duplicateQuery = validInput();
  duplicateQuery.providerMappings[2] = {
    ...duplicateQuery.providerMappings[2],
    providerOperatorId: "OP-C",
    providerStationId: "S2",
  };
  refreshBindings(duplicateQuery);

  assert.throws(
    () => planKricExitPathCollection(duplicateQuery),
    /duplicate EXIT provider query tuple/,
  );
});

test("고립 station-line과 invalid route edge는 exhaustive query plan으로 승인하지 않는다", () => {
  const isolated = validInput();
  isolated.routeEdges.pop();
  refreshBindings(isolated);
  assert.throws(() => planKricExitPathCollection(isolated), /isolated EXIT station-line/);

  const crossLine = validInput();
  crossLine.routeEdges[0].lineId = "line-2";
  refreshBindings(crossLine);
  assert.throws(() => planKricExitPathCollection(crossLine), /route edge station-line mismatch/);

  const express = validInput();
  express.routeEdges[0].servicePattern = "EXPRESS";
  refreshBindings(express);
  assert.throws(() => planKricExitPathCollection(express), /route edge contract mismatch/);

  const providerCrossLine = validInput();
  providerCrossLine.providerMappings[1].providerLineId = "L2";
  refreshBindings(providerCrossLine);
  assert.throws(() => planKricExitPathCollection(providerCrossLine), /provider next-station line mismatch/);
});

test("station/mapping/topology identity drift와 duplicate adjacency를 거부한다", () => {
  for (const [label, mutate, expected] of [[
    "station set",
    (input) => { input.candidate.stationSetSha256 = "0".repeat(64); },
    /station set identity mismatch/,
  ], [
    "station-line set",
    (input) => { input.candidate.stationLineSetSha256 = "0".repeat(64); },
    /station-line set identity mismatch/,
  ], [
    "station-line mapping",
    (input) => { input.candidate.stationLineMappingSha256 = "0".repeat(64); },
    /station-line mapping identity mismatch/,
  ], [
    "provider mapping",
    (input) => { input.candidate.providerMappingSha256 = "0".repeat(64); },
    /provider mapping identity mismatch/,
  ], [
    "topology",
    (input) => { input.candidate.topologySha256 = "0".repeat(64); },
    /topology identity mismatch/,
  ]]) {
    const input = validInput();
    mutate(input);
    assert.throws(() => planKricExitPathCollection(input), expected, label);
  }

  const duplicate = validInput();
  duplicate.routeEdges.push({
    ...duplicate.routeEdges[0],
    routeEdgeId: "edge-a-b-duplicate",
  });
  refreshBindings(duplicate);
  assert.throws(() => planKricExitPathCollection(duplicate), /duplicate EXIT route adjacency/);
});

function validInput() {
  const stationLines = [stationLine("station-a", "가역"), stationLine("station-b", "나역"), stationLine("station-c", "다역")];
  const providerMappings = stationLines.map(({ stationId, lineId }, index) => ({
    stationId,
    lineId,
    providerOperatorId: "OP",
    providerLineId: "L1",
    providerStationId: `S${index + 1}`,
  }));
  const routeEdges = [{
    routeEdgeId: "edge-a-b",
    fromStationId: "station-a",
    toStationId: "station-b",
    lineId: "line-1",
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
  }, {
    routeEdgeId: "edge-a-c",
    fromStationId: "station-a",
    toStationId: "station-c",
    lineId: "line-1",
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
  }, {
    routeEdgeId: "edge-b-a",
    fromStationId: "station-b",
    toStationId: "station-a",
    lineId: "line-1",
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
  }, {
    routeEdgeId: "edge-c-a",
    fromStationId: "station-c",
    toStationId: "station-a",
    lineId: "line-1",
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
  }];
  const input = {
    candidate: {
      candidateId: "candidate-capital",
      stationSetSha256: "",
      stationLineSetSha256: "",
      stationLineMappingSha256: "",
      providerMappingSha256: "",
      topologySha256: "",
    },
    stationLines,
    providerMappings,
    routeEdges,
  };
  refreshBindings(input);
  return input;
}

function stationLine(stationId, stationName) {
  return {
    stationId,
    stationName,
    stationAliases: [],
    regionId: "capital",
    lineId: "line-1",
    lineName: "1호선",
    operatorId: "operator-1",
    operatorName: "운영사",
  };
}

function refreshBindings(input) {
  input.candidate.stationSetSha256 = sha256(canonicalJson(
    [...new Set(input.stationLines.map(({ stationId }) => stationId))].sort(compareBytes),
  ));
  input.candidate.stationLineSetSha256 = sha256(canonicalJson(input.stationLines.map(({
    stationId, lineId, operatorId,
  }) => ({ stationId, lineId, operatorId })).sort(compareStationLines)));
  input.candidate.stationLineMappingSha256 = sha256(canonicalJson(input.stationLines.map((line) => ({
    ...line,
    stationAliases: [...new Set(line.stationAliases)].sort(compareBytes),
  })).sort(compareStationLines)));
  input.candidate.providerMappingSha256 = sha256(canonicalJson(
    [...input.providerMappings].sort(compareProviderMappings),
  ));
  input.candidate.topologySha256 = sha256(canonicalJson([...input.routeEdges].sort(compareRouteEdges)));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareProviderMappings(left, right) {
  return compareBytes(left.stationId, right.stationId) || compareBytes(left.lineId, right.lineId);
}

function compareRouteEdges(left, right) {
  return compareBytes(left.routeEdgeId, right.routeEdgeId);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
