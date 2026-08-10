import { createHash } from "node:crypto";

const CANDIDATE_KEYS = [
  "candidateId",
  "stationSetSha256",
  "stationLineSetSha256",
  "stationLineMappingSha256",
  "providerMappingSha256",
  "topologySha256",
];
const STATION_LINE_KEYS = [
  "stationId", "stationName", "stationAliases", "regionId",
  "lineId", "lineName", "operatorId", "operatorName",
];
const PROVIDER_MAPPING_KEYS = [
  "stationId", "lineId", "providerOperatorId", "providerLineId", "providerStationId",
];
const ROUTE_EDGE_KEYS = [
  "routeEdgeId", "fromStationId", "toStationId", "lineId",
  "edgeType", "servicePattern", "serviceClass",
];
const OUTPUT_KEYS = [
  "schemaVersion", "artifactKind", "candidate", "providerMappings", "routeEdges",
  "queryPlan", "stationLineQueries", "queryPlanSha256", "collectionPlanDigest",
];

export function planKricExitPathCollection(input) {
  assertKeys(input, ["candidate", "providerMappings", "routeEdges", "stationLines"], "EXIT collection input keys");
  const candidate = validateCandidate(input.candidate);
  const stationLines = validateStationLines(input.stationLines, candidate);
  const stationLineByKey = new Map(stationLines.map((line) => [stationLineKey(line), line]));
  const providerMappings = validateProviderMappings(input.providerMappings, stationLineByKey, candidate.providerMappingSha256);
  const mappingByKey = new Map(providerMappings.map((mapping) => [stationLineKey(mapping), mapping]));
  const routeEdges = validateRouteEdges(input.routeEdges, stationLineByKey, candidate.topologySha256);
  const queriesByStationLine = new Map(stationLines.map((line) => [stationLineKey(line), []]));

  for (const edge of routeEdges) {
    addDirectedQuery({
      edge,
      stationLine: stationLineByKey.get(`${edge.fromStationId}:${edge.lineId}`),
      nextMapping: mappingByKey.get(`${edge.toStationId}:${edge.lineId}`),
      mapping: mappingByKey.get(`${edge.fromStationId}:${edge.lineId}`),
      queriesByStationLine,
    });
  }

  const isolated = [...queriesByStationLine.entries()]
    .filter(([, queries]) => queries.length === 0)
    .map(([key]) => key)
    .sort(compareBytes);
  if (isolated.length > 0) throw new Error(`isolated EXIT station-line: ${isolated.join(",")}`);

  const queryPlan = [...queriesByStationLine.values()].flat().sort(compareQueries);
  const queryIds = new Set();
  const providerQueryTuples = new Set();
  for (const query of queryPlan) {
    if (queryIds.has(query.queryId)) throw new Error("duplicate EXIT provider query");
    queryIds.add(query.queryId);
    const providerQueryTuple = [
      query.providerOperatorId,
      query.providerLineId,
      query.providerStationId,
      query.providerNextStationId,
    ].join("\0");
    if (providerQueryTuples.has(providerQueryTuple)) {
      throw new Error("duplicate EXIT provider query tuple");
    }
    providerQueryTuples.add(providerQueryTuple);
  }
  const stationLineQueries = [...queriesByStationLine.entries()]
    .sort(([left], [right]) => compareBytes(left, right))
    .map(([stationLineId, queries]) => canonicalObject({
      stationLineId,
      queryIds: queries.sort(compareQueries).map(({ queryId }) => queryId),
    }));
  const queryPlanSha256 = sha256(canonicalJson(queryPlan));
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "kric-exit-path-collection-plan",
    candidate,
    providerMappings,
    routeEdges,
    queryPlan,
    stationLineQueries,
    queryPlanSha256,
  });
  return canonicalObject({ ...payload, collectionPlanDigest: sha256(canonicalJson(payload)) });
}

export function canonicalKricExitPathCollectionPlanJson(result) {
  assertKeys(result, OUTPUT_KEYS, "EXIT collection output keys");
  const { collectionPlanDigest, queryPlanSha256, queryPlan, ...rest } = result;
  assertSha256(collectionPlanDigest, "EXIT collection plan digest");
  assertSha256(queryPlanSha256, "EXIT query plan sha256");
  if (sha256(canonicalJson(queryPlan)) !== queryPlanSha256) throw new Error("EXIT query plan digest mismatch");
  const payload = canonicalObject({ ...rest, queryPlan, queryPlanSha256 });
  if (sha256(canonicalJson(payload)) !== collectionPlanDigest) throw new Error("EXIT collection plan digest mismatch");
  return canonicalJson(result);
}

function validateCandidate(value) {
  assertKeys(value, CANDIDATE_KEYS, "EXIT collection candidate keys");
  assertNonBlank(value.candidateId, "candidateId");
  for (const key of CANDIDATE_KEYS.slice(1)) assertSha256(value[key], key);
  return canonicalObject(value);
}

function validateStationLines(value, candidate) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("stationLines must be a non-empty array");
  const stationLines = value.map((line) => {
    assertKeys(line, STATION_LINE_KEYS, "EXIT collection station-line keys");
    for (const key of STATION_LINE_KEYS.filter((field) => field !== "stationAliases")) {
      assertNonBlank(line[key], `station-line ${key}`);
    }
    if (!Array.isArray(line.stationAliases) || line.stationAliases.some((alias) => typeof alias !== "string" || alias.trim() === "")) {
      throw new Error("station-line aliases must be non-blank strings");
    }
    return canonicalObject({ ...line, stationAliases: [...new Set(line.stationAliases)].sort(compareBytes) });
  }).sort(compareStationLines);
  const keys = stationLines.map(stationLineKey);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate EXIT station-line");
  const stationSet = [...new Set(stationLines.map(({ stationId }) => stationId))].sort(compareBytes);
  if (sha256(canonicalJson(stationSet)) !== candidate.stationSetSha256) throw new Error("station set identity mismatch");
  const stationLineSet = stationLines.map(({ stationId, lineId, operatorId }) => canonicalObject({
    stationId, lineId, operatorId,
  }));
  if (sha256(canonicalJson(stationLineSet)) !== candidate.stationLineSetSha256) {
    throw new Error("station-line set identity mismatch");
  }
  if (sha256(canonicalJson(stationLines)) !== candidate.stationLineMappingSha256) {
    throw new Error("station-line mapping identity mismatch");
  }
  return stationLines;
}

function validateProviderMappings(value, stationLineByKey, expectedSha256) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("providerMappings must be a non-empty array");
  const seen = new Set();
  const providerTuples = new Set();
  const mappings = value.map((mapping) => {
    assertKeys(mapping, PROVIDER_MAPPING_KEYS, "EXIT provider mapping keys");
    for (const key of PROVIDER_MAPPING_KEYS) assertNonBlank(mapping[key], `provider mapping ${key}`);
    const key = stationLineKey(mapping);
    if (seen.has(key)) throw new Error("duplicate EXIT provider mapping");
    seen.add(key);
    const providerTuple = [
      mapping.providerOperatorId, mapping.providerLineId, mapping.providerStationId,
    ].join("\0");
    if (providerTuples.has(providerTuple)) throw new Error("ambiguous EXIT provider mapping tuple");
    providerTuples.add(providerTuple);
    return canonicalObject(mapping);
  }).sort(compareProviderMappings);
  const expectedKeys = [...stationLineByKey.keys()].sort(compareBytes);
  const actualKeys = mappings.map(stationLineKey).sort(compareBytes);
  if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) throw new Error("provider mapping denominator mismatch");
  if (sha256(canonicalJson(mappings)) !== expectedSha256) throw new Error("provider mapping identity mismatch");
  return mappings;
}

function validateRouteEdges(value, stationLineByKey, expectedSha256) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("routeEdges must be a non-empty array");
  const edgeIds = new Set();
  const adjacencies = new Set();
  const edges = value.map((edge) => {
    assertKeys(edge, ROUTE_EDGE_KEYS, "EXIT route edge keys");
    for (const key of ROUTE_EDGE_KEYS) assertNonBlank(edge[key], `route edge ${key}`);
    if (edge.edgeType !== "RIDE" || edge.servicePattern !== "LOCAL" || edge.serviceClass !== "SUBWAY") {
      throw new Error("route edge contract mismatch");
    }
    if (edge.fromStationId === edge.toStationId
      || !stationLineByKey.has(`${edge.fromStationId}:${edge.lineId}`)
      || !stationLineByKey.has(`${edge.toStationId}:${edge.lineId}`)) {
      throw new Error("route edge station-line mismatch");
    }
    if (edgeIds.has(edge.routeEdgeId)) throw new Error("duplicate EXIT route edge id");
    edgeIds.add(edge.routeEdgeId);
    const pair = [edge.fromStationId, edge.toStationId, edge.lineId].join("\0");
    if (adjacencies.has(pair)) throw new Error("duplicate EXIT route adjacency");
    adjacencies.add(pair);
    return canonicalObject(edge);
  }).sort(compareRouteEdges);
  if (sha256(canonicalJson(edges)) !== expectedSha256) throw new Error("topology identity mismatch");
  return edges;
}

function addDirectedQuery({ edge, stationLine, mapping, nextMapping, queriesByStationLine }) {
  if (mapping.providerLineId !== nextMapping.providerLineId) {
    throw new Error("EXIT provider next-station line mismatch");
  }
  const identity = canonicalObject({
    providerLineId: mapping.providerLineId,
    providerNextStationId: nextMapping.providerStationId,
    providerOperatorId: mapping.providerOperatorId,
    providerStationId: mapping.providerStationId,
    routeEdgeId: edge.routeEdgeId,
  });
  const query = canonicalObject({
    queryId: sha256(canonicalJson(identity)),
    routeEdgeId: edge.routeEdgeId,
    providerOperatorId: mapping.providerOperatorId,
    providerLineId: mapping.providerLineId,
    providerStationId: mapping.providerStationId,
    providerNextStationId: nextMapping.providerStationId,
    operatorName: stationLine.operatorName,
    lineName: stationLine.lineName,
    stationName: stationLine.stationName,
    regionId: stationLine.regionId,
  });
  queriesByStationLine.get(stationLineKey(stationLine)).push(query);
}

function assertKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} mismatch`);
  const actual = Object.keys(value).sort(compareBytes);
  const expected = [...keys].sort(compareBytes);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} mismatch`);
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be non-blank`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be lowercase sha256`);
}

function stationLineKey(value) {
  return `${value.stationId}:${value.lineId}`;
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

function compareQueries(left, right) {
  return compareBytes(left.providerStationId, right.providerStationId)
    || compareBytes(left.providerNextStationId, right.providerNextStationId)
    || compareBytes(left.routeEdgeId, right.routeEdgeId)
    || compareBytes(left.queryId, right.queryId);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
