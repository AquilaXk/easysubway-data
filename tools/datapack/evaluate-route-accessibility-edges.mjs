import { createHash } from "node:crypto";

import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { canonicalStationLineAccessibilityPayloadJson } from "./materialize-station-line-accessibility.mjs";

const INPUT_KEYS = ["candidate", "evaluationAt", "stationLines", "routeEdges", "materialization"];
const CANDIDATE_KEYS = [
  "candidateId", "stationSetSha256", "sourceSetSha256", "topologySha256", "policyVersion", "evaluatorVersion",
];
const STATION_LINE_KEYS = ["stationId", "lineId", "operatorId", "lineSequence"];
const EDGE_KEYS = [
  "edgeId", "edgeType", "fromNodeId", "toNodeId", "durationSeconds", "distanceMeters",
  "servicePattern", "serviceClass", "edgeSha256",
];
const MATERIALIZATION_ROW_KEYS = [
  "candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion",
  "stationId", "lineId", "operatorId", "domain", "state", "sourceId", "sourceSnapshotId",
  "evidenceRawSha256", "providerRecordHash", "capturedAt", "freshUntil", "provenanceId", "licenseId",
  "evidenceKind", "evidenceReason",
];
const TERMINAL_MATERIALIZATION_ROW_KEYS = [...MATERIALIZATION_ROW_KEYS, "terminalPolicy", "providerResultCode", "providerResponseSha256"];
const MATERIALIZATION_STATES = [
  "VERIFIED_PRESENT", "VERIFIED_ABSENT", "NOT_APPLICABLE", "UNKNOWN", "MISSING", "STALE",
];
const DOMAINS = ["FACILITY", "EXIT", "TRANSFER"];
const RESULT_STATES = ["PASS", "BLOCKED", "NOT_APPLICABLE", "UNKNOWN", "MISSING", "STALE", "NOT_EVALUATED"];
const POLICY_EDGE_TYPES = [
  "ENTRY", "EXIT", "IN_STATION_TRANSFER", "OUT_OF_STATION_TRANSFER", "LEGACY_TRANSFER",
  "WALKWAY", "ELEVATOR", "RAMP", "STAIR", "ESCALATOR", "FACILITY_CONNECTOR", "RIDE",
];
const LINEAGE_FIELDS = [
  "sourceId", "sourceSnapshotId", "evidenceRawSha256", "providerRecordHash", "capturedAt", "freshUntil",
  "provenanceId", "licenseId", "evidenceKind", "evidenceReason",
];
const TERMINAL_FACILITY_REASON = "시설 존재·부재가 검증되지 않아 경로를 차단했습니다.";
const TERMINAL_EXIT_REASON = "출구 이동경로가 검증되지 않아 경로를 차단했습니다.";

export function evaluateRouteAccessibilityEdges(input, policy) {
  const validatedPolicy = validatePolicy(policy);
  assertKeys(input, INPUT_KEYS, "input keys");
  const candidate = validateCandidate(input.candidate, validatedPolicy);
  const evaluationAtMillis = requiredUtcInstant(input.evaluationAt, "evaluationAt");
  const evaluationAt = new Date(evaluationAtMillis).toISOString();
  const stationLineIndex = validateStationLines(input.stationLines);
  const edges = validateEdges(input.routeEdges, stationLineIndex);
  validateRideEdgeSet(edges, validatedPolicy);
  const materialization = validateMaterialization(
    input.materialization, candidate, stationLineIndex, evaluationAtMillis, edges, validatedPolicy,
  );

  const materializationRows = new Map(materialization.rows.map((row) => [materializationCellKey(row), row]));
  const results = edges.map((edge) => evaluateEdge({
    edge,
    candidate,
    evaluationAt,
    evaluationAtMillis,
    materialization,
    materializationRows,
    policy: validatedPolicy,
    stationLineIndex,
  }));
  const stateSummary = Object.fromEntries(RESULT_STATES.map((state) => [state, 0]));
  for (const result of results) stateSummary[result.state] += 1;
  const denominator = canonicalObject({
    edgeCount: edges.length,
    digest: sha256(canonicalJson(edges.map(({ edgeId, edgeSha256 }) => ({ edgeId, edgeSha256 })))),
  });
  const eligible = validatedPolicy.unresolvedStatePrecedence.every((state) => stateSummary[state] === 0)
    && stateSummary.NOT_EVALUATED === 0;
  const payload = canonicalObject({ candidate, evaluationAt, denominator, results, stateSummary, eligible });
  return canonicalObject({ ...payload, evaluationDigest: sha256(canonicalJson(payload)) });
}

export function canonicalRouteEdgeEvaluationJson(result) {
  assertKeys(
    result,
    ["candidate", "evaluationAt", "denominator", "results", "stateSummary", "eligible", "evaluationDigest"],
    "route edge evaluation keys",
  );
  return canonicalJson(result);
}

export function routeEdgeSha256(edge) {
  assertKeys(edge, EDGE_KEYS.filter((key) => key !== "edgeSha256"), "route edge hash input keys");
  return sha256(canonicalJson(edge));
}

export function canonicalRideEdgeSetSha256(edges) {
  if (!Array.isArray(edges)) throw new Error("RIDE edge set must be an array");
  const rows = [...edges]
    .sort((left, right) => compareBytes(left.edgeId, right.edgeId))
    .map((edge) => ({
      id: edge.edgeId,
      from_node_id: edge.fromNodeId,
      to_node_id: edge.toNodeId,
      edge_type: edge.edgeType,
      service_pattern: edge.servicePattern,
      service_class: edge.serviceClass,
      duration_seconds: edge.durationSeconds,
      distance_meters: edge.distanceMeters,
    }));
  return sha256(JSON.stringify(rows));
}

function validatePolicy(policy) {
  assertKeys(
    policy,
    ["schemaVersion", "artifactKind", "policyVersion", "states", "unresolvedStatePrecedence", "edgeDomainMap", "rideInvariant"],
    "policy keys",
  );
  if (policy.schemaVersion !== 1 || policy.artifactKind !== "route-edge-evaluation-policy") {
    throw new Error("route edge evaluation policy identity mismatch");
  }
  assertNonBlank(policy.policyVersion, "policyVersion");
  assertExactArray(policy.states, RESULT_STATES, "policy states");
  assertExactArray(policy.unresolvedStatePrecedence, ["STALE", "MISSING", "UNKNOWN"], "unresolved state precedence");
  assertKeys(policy.edgeDomainMap, POLICY_EDGE_TYPES, "policy edge domain map keys");
  const expectedMappings = {
    ENTRY: ["TO", ["FACILITY"]],
    EXIT: ["FROM", ["EXIT"]],
    IN_STATION_TRANSFER: ["BOTH", ["TRANSFER"]],
    OUT_OF_STATION_TRANSFER: ["BOTH", ["TRANSFER"]],
    LEGACY_TRANSFER: ["BOTH", ["TRANSFER"]],
    WALKWAY: ["BOTH", ["FACILITY"]],
    ELEVATOR: ["BOTH", ["FACILITY"]],
    RAMP: ["BOTH", ["FACILITY"]],
    STAIR: ["BOTH", ["FACILITY"]],
    ESCALATOR: ["BOTH", ["FACILITY"]],
    FACILITY_CONNECTOR: ["BOTH", ["FACILITY"]],
    RIDE: ["NONE", []],
  };
  for (const edgeType of POLICY_EDGE_TYPES) {
    const mapping = policy.edgeDomainMap[edgeType];
    assertKeys(mapping, ["endpointTarget", "domains"], `policy ${edgeType} mapping keys`);
    const [endpointTarget, domains] = expectedMappings[edgeType];
    if (mapping.endpointTarget !== endpointTarget) throw new Error(`policy ${edgeType} endpoint target mismatch`);
    assertExactArray(mapping.domains, domains, `policy ${edgeType} domains`);
  }
  validateRidePolicy(policy.rideInvariant);
  return structuredClone(policy);
}

function validateRidePolicy(value) {
  assertKeys(value, ["subwayLocal", "itxCheongchunExpress"], "RIDE invariant keys");
  assertKeys(
    value.subwayLocal,
    ["serviceClass", "servicePattern", "sameLine", "measuredSpeedKmhMinimum", "measuredSpeedKmhMaximum", "admittedEdgeSetSha256", "digestShape"],
    "SUBWAY LOCAL invariant keys",
  );
  if (value.subwayLocal.serviceClass !== "SUBWAY"
    || value.subwayLocal.servicePattern !== "LOCAL"
    || value.subwayLocal.sameLine !== true
    || value.subwayLocal.measuredSpeedKmhMinimum !== 15
    || value.subwayLocal.measuredSpeedKmhMaximum !== 110
    || value.subwayLocal.digestShape !== "sqlite-route-graph-v1") {
    throw new Error("SUBWAY LOCAL RIDE policy mismatch");
  }
  assertKeys(
    value.itxCheongchunExpress,
    ["serviceClass", "servicePattern", "admittedEdgeSetSha256", "digestShape"],
    "ITX EXPRESS invariant keys",
  );
  if (value.itxCheongchunExpress.serviceClass !== "ITX_CHEONGCHUN"
    || value.itxCheongchunExpress.servicePattern !== "EXPRESS"
    || value.itxCheongchunExpress.digestShape !== "sqlite-route-graph-v1") {
    throw new Error("ITX EXPRESS RIDE policy mismatch");
  }
  assertSha256(value.subwayLocal.admittedEdgeSetSha256, "SUBWAY LOCAL admitted edge set");
  assertSha256(value.itxCheongchunExpress.admittedEdgeSetSha256, "ITX admitted edge set");
}

function validateCandidate(value, policy) {
  assertKeys(value, CANDIDATE_KEYS, "candidate keys");
  for (const key of CANDIDATE_KEYS) assertNonBlank(value[key], `candidate ${key}`);
  for (const key of ["stationSetSha256", "sourceSetSha256", "topologySha256"]) assertSha256(value[key], `candidate ${key}`);
  if (value.policyVersion !== policy.policyVersion) throw new Error("candidate policy identity mismatch");
  return canonicalObject(value);
}

function validateStationLines(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("stationLines must be a non-empty array");
  const rows = values.map((value) => {
    assertKeys(value, STATION_LINE_KEYS, "station line keys");
    for (const key of ["stationId", "lineId", "operatorId"]) assertNonBlank(value[key], `station line ${key}`);
    if (!Number.isSafeInteger(value.lineSequence) || value.lineSequence < 0) throw new Error("station line sequence is invalid");
    return canonicalObject(value);
  }).sort(compareStationLines);
  const byKey = new Map();
  const operatorByLine = new Map();
  const stationIds = new Set();
  for (const row of rows) {
    const key = stationLineKey(row);
    if (byKey.has(key)) throw new Error("duplicate canonical station line");
    const existingOperator = operatorByLine.get(row.lineId);
    if (existingOperator && existingOperator !== row.operatorId) throw new Error("station line operator identity mismatch");
    operatorByLine.set(row.lineId, row.operatorId);
    stationIds.add(row.stationId);
    byKey.set(key, row);
  }
  return { rows, byKey, stationIds };
}

function validateMaterialization(value, candidate, stationLineIndex, evaluationAtMillis, edges, policy) {
  assertKeys(value, ["candidate", "rows", "stateSummary", "materializationDigest"], "materialization keys");
  assertKeys(
    value.candidate,
    ["candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion"],
    "materialization candidate keys",
  );
  for (const [key, label] of [
    ["candidateId", "candidate"], ["stationSetSha256", "station set"], ["sourceSetSha256", "source set"],
  ]) {
    if (key !== "stationSetSha256" && value.candidate[key] !== candidate[key]) throw new Error(`materialization ${label} identity mismatch`);
  }
  assertNonBlank(value.candidate.mappingContractVersion, "materialization mapping contract version");
  assertNonBlank(value.candidate.materializerVersion, "materialization version");
  if (!Array.isArray(value.rows)) {
    throw new Error("materialization denominator mismatch");
  }
  const rows = value.rows.map((row) => validateMaterializationRow(
    row,
    value.candidate,
    stationLineIndex,
    evaluationAtMillis,
  ));
  const sortedRows = [...rows].sort(compareCells);
  if (rows.some((row, index) => canonicalJson(row) !== canonicalJson(sortedRows[index]))) {
    throw new Error("materialization row order is not canonical");
  }
  const keys = new Set();
  for (const row of rows) {
    const key = materializationCellKey(row);
    if (keys.has(key)) throw new Error("duplicate materialization cell");
    keys.add(key);
  }
  const targets = new Map();
  for (const edge of edges) {
    const mapping = policy.edgeDomainMap[edge.edgeType];
    if (!mapping || edge.edgeType === "RIDE") continue;
    validateKnownEndpointShape(edge, mapping.endpointTarget);
    for (const target of targetStationLines(edge, mapping.endpointTarget)) {
      targets.set(stationLineKey(target), target);
    }
  }
  const targetRows = [...targets.values()];
  const scopedHash = sha256(canonicalJson([...new Set(targetRows.map(({ stationId }) => stationId))].sort(compareBytes)));
  if (value.candidate.stationSetSha256 !== scopedHash) throw new Error("materialization scoped station set identity mismatch");
  const expected = new Set(targetRows.flatMap((line) => DOMAINS.map((domain) => materializationCellKey({ ...line, domain }))));
  if (keys.size !== expected.size || [...expected].some((key) => !keys.has(key))) throw new Error("materialization policy target denominator mismatch");
  const summary = Object.fromEntries([...MATERIALIZATION_STATES, ...(rows.some(({ state }) => state === "UNVERIFIED_EVIDENCE_BLOCKED") ? ["UNVERIFIED_EVIDENCE_BLOCKED"] : [])].map((state) => [state, 0]));
  for (const row of rows) summary[row.state] += 1;
  if (canonicalJson(summary) !== canonicalJson(value.stateSummary)) throw new Error("materialization state summary mismatch");
  const expectedDigest = sha256(canonicalStationLineAccessibilityPayloadJson(value));
  if (value.materializationDigest !== expectedDigest) throw new Error("materialization digest mismatch");
  return canonicalObject({ candidate: value.candidate, rows, stateSummary: summary, materializationDigest: value.materializationDigest });
}

function validateMaterializationRow(row, materializationCandidate, stationLineIndex, evaluationAtMillis) {
  const terminal = row?.evidenceKind === "UNVERIFIED_EVIDENCE_BLOCKED";
  assertKeys(row, terminal ? TERMINAL_MATERIALIZATION_ROW_KEYS : MATERIALIZATION_ROW_KEYS, "materialization row keys");
  for (const key of ["candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion"]) {
    if (row[key] !== materializationCandidate[key]) throw new Error(`materialization row ${key} mismatch`);
  }
  const line = stationLineIndex.byKey.get(stationLineKey(row));
  if (!line || line.operatorId !== row.operatorId) throw new Error("unmapped materialization row");
  if (!DOMAINS.includes(row.domain) || (!MATERIALIZATION_STATES.includes(row.state) && row.state !== "UNVERIFIED_EVIDENCE_BLOCKED")) throw new Error("materialization row state/domain mismatch");
  if (row.state === "MISSING") {
    if (LINEAGE_FIELDS.some((field) => row[field] !== null)) throw new Error("MISSING materialization lineage must be null");
    return canonicalObject(row);
  }
  for (const field of ["sourceId", "sourceSnapshotId", "provenanceId", "licenseId", "evidenceKind", "evidenceReason"]) {
    assertNonBlank(row[field], `materialization ${field}`);
  }
  const allowedKinds = {
    VERIFIED_PRESENT: ["OBSERVED"],
    VERIFIED_ABSENT: ["EXHAUSTIVE_LIST", "EXPLICIT_ZERO"],
    NOT_APPLICABLE: ["CURRENT_APPLICABILITY_RULE"],
    UNKNOWN: ["BLANK", "NULL", "DEFAULT", "PROVIDER_NO_DATA", "UNSUPPORTED"],
    UNVERIFIED_EVIDENCE_BLOCKED: ["UNVERIFIED_EVIDENCE_BLOCKED"],
    STALE: [
      "OBSERVED", "EXHAUSTIVE_LIST", "EXPLICIT_ZERO", "CURRENT_APPLICABILITY_RULE",
      "BLANK", "NULL", "DEFAULT", "PROVIDER_NO_DATA", "UNSUPPORTED", "UNVERIFIED_EVIDENCE_BLOCKED",
    ],
  };
  if (!allowedKinds[row.state]?.includes(row.evidenceKind)) {
    throw new Error("materialization evidence kind mismatch");
  }
  assertSha256(row.evidenceRawSha256, "materialization evidenceRawSha256");
  if (terminal) {
    const facilityContract = row.domain === "FACILITY"
      && row.terminalPolicy === "EXACT_TUPLE_PROVIDER_RESULT_03"
      && row.stationId === "station-b35616704ce3" && row.lineId === "seoul-2"
      && row.operatorId === "seoul-metro" && row.sourceId === "kric-station-convenience-standard"
      && row.evidenceReason === TERMINAL_FACILITY_REASON;
    const exitContract = row.domain === "EXIT"
      && row.terminalPolicy === "PROVIDER_NO_DATA_RESULT_03_BLOCKED"
      && row.sourceId === "kric-station-movement-standard"
      && row.evidenceReason === TERMINAL_EXIT_REASON;
    if (row.providerRecordHash !== null || row.providerResultCode !== "03"
      || !/^[a-f0-9]{64}$/.test(row.providerResponseSha256)
      || (!facilityContract && !exitContract)) {
      throw new Error("terminal materialization contract mismatch");
    }
  } else {
    if ([row.terminalPolicy, row.providerResultCode, row.providerResponseSha256].some((value) => value !== undefined && value !== null)) {
      throw new Error("non-terminal materialization terminal fields must be null");
    }
    assertSha256(row.providerRecordHash, "materialization providerRecordHash");
  }
  const capturedAt = requiredUtcInstant(row.capturedAt, "materialization capturedAt");
  const freshUntil = requiredUtcInstant(row.freshUntil, "materialization freshUntil");
  if (freshUntil <= capturedAt) throw new Error("materialization freshUntil must be after capturedAt");
  if (capturedAt > evaluationAtMillis) throw new Error("materialization capturedAt is after evaluationAt");
  if (row.state === "STALE" && freshUntil > evaluationAtMillis) {
    throw new Error("STALE materialization freshness mismatch");
  }
  return canonicalObject(row);
}

function validateEdges(values, stationLineIndex) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("routeEdges must be a non-empty array");
  const edges = values.map((value) => validateEdge(value, stationLineIndex))
    .sort((left, right) => compareBytes(left.edgeId, right.edgeId));
  for (let index = 1; index < edges.length; index += 1) {
    if (edges[index - 1].edgeId === edges[index].edgeId) throw new Error("duplicate route edge");
  }
  return edges;
}

function validateEdge(value, stationLineIndex) {
  assertKeys(value, EDGE_KEYS, "route edge keys");
  for (const key of ["edgeId", "edgeType", "fromNodeId", "toNodeId", "serviceClass"]) assertNonBlank(value[key], `route edge ${key}`);
  if (typeof value.servicePattern !== "string") throw new Error("route edge servicePattern must be a string");
  for (const key of ["durationSeconds", "distanceMeters"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`route edge ${key} is invalid`);
  }
  assertSha256(value.edgeSha256, "route edge sha256");
  const withoutHash = Object.fromEntries(EDGE_KEYS.filter((key) => key !== "edgeSha256").map((key) => [key, value[key]]));
  if (value.edgeSha256 !== routeEdgeSha256(withoutHash)) throw new Error("route edge sha256 mismatch");
  const from = routeEndpoint(value.fromNodeId, stationLineIndex, value);
  const to = routeEndpoint(value.toNodeId, stationLineIndex, value);
  return canonicalObject({ ...value, from, to });
}

function routeEndpoint(nodeId, stationLineIndex, edge) {
  const segments = String(nodeId).split(":");
  if (segments.some((segment) => segment === "")) throw new Error("route edge endpoint is invalid");
  const isTrackedItxExpressEndpoint = segments.length === 3
    && segments[2] === "EXPRESS"
    && edge.edgeType === "RIDE"
    && edge.serviceClass === "ITX_CHEONGCHUN"
    && edge.servicePattern === "EXPRESS";
  if (segments.length > 2 && !isTrackedItxExpressEndpoint) {
    throw new Error("route edge endpoint suffix is invalid");
  }
  if (segments.length === 1) {
    if (!stationLineIndex.stationIds.has(segments[0])) throw new Error("unmapped route edge endpoint");
    return canonicalObject({ stationId: segments[0], lineId: null, operatorId: null, lineSequence: null });
  }
  const line = stationLineIndex.byKey.get(`${segments[0]}\u0000${segments[1]}`);
  if (!line) throw new Error("unmapped route edge endpoint");
  return canonicalObject(line);
}

function validateRideEdgeSet(edges, policy) {
  const localEdges = edges.filter(({ edgeType, serviceClass, servicePattern }) => edgeType === "RIDE" && serviceClass === "SUBWAY" && servicePattern === "LOCAL");
  if (canonicalRideEdgeSetSha256(localEdges) !== policy.rideInvariant.subwayLocal.admittedEdgeSetSha256) throw new Error("SUBWAY LOCAL edge set identity mismatch");
  const itxEdges = edges.filter(({ edgeType, serviceClass }) => edgeType === "RIDE" && serviceClass === "ITX_CHEONGCHUN");
  if (canonicalRideEdgeSetSha256(itxEdges) !== policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256) {
    throw new Error("ITX EXPRESS edge set identity mismatch");
  }
}

function evaluateEdge(context) {
  const mapping = context.policy.edgeDomainMap[context.edge.edgeType];
  if (!mapping) return resultFor(context, [], [], "NOT_EVALUATED", "edge type is not mapped by current policy");
  validateKnownEndpointShape(context.edge, mapping.endpointTarget);
  if (context.edge.edgeType === "RIDE") {
    validateRideInvariant(context.edge, context.policy);
    return resultFor(context, [], [], "PASS", "RIDE topology and service invariant passed");
  }
  const targets = targetStationLines(context.edge, mapping.endpointTarget);
  const cells = targets.flatMap((target) => mapping.domains.map((domain) => {
    const cell = context.materializationRows.get(materializationCellKey({ ...target, domain }));
    if (!cell) throw new Error("materialization denominator mismatch");
    return cellWithEffectiveState(cell, context.evaluationAtMillis);
  })).sort(compareCells);
  const state = aggregateCellState(cells, context.policy.unresolvedStatePrecedence);
  const reasons = {
    STALE: "required materialization is stale",
    MISSING: "required materialization is missing",
    UNKNOWN: "required materialization is unknown",
    BLOCKED: "verified absence blocks required transition",
    NOT_APPLICABLE: "all required domains are not applicable",
    PASS: "all required materialization cells are terminal",
  };
  if (state === "BLOCKED" && cells.some(({ effectiveState }) => effectiveState === "UNVERIFIED_EVIDENCE_BLOCKED")) {
    const terminalCell = cells.find(({ effectiveState }) => effectiveState === "UNVERIFIED_EVIDENCE_BLOCKED");
    return resultFor(context, mapping.domains, cells, state,
      terminalCell.domain === "EXIT" ? TERMINAL_EXIT_REASON : TERMINAL_FACILITY_REASON);
  }
  return resultFor(context, mapping.domains, cells, state, reasons[state]);
}

function validateKnownEndpointShape(edge, endpointTarget) {
  const fromIsStationLine = edge.from.lineId !== null;
  const toIsStationLine = edge.to.lineId !== null;
  if (edge.edgeType === "ENTRY") {
    if (fromIsStationLine || !toIsStationLine || edge.from.stationId !== edge.to.stationId) {
      throw new Error("ENTRY route edge endpoint identity mismatch");
    }
    return;
  }
  if (edge.edgeType === "EXIT") {
    if (!fromIsStationLine || toIsStationLine || edge.from.stationId !== edge.to.stationId) {
      throw new Error("EXIT route edge endpoint identity mismatch");
    }
    return;
  }
  if (edge.edgeType === "IN_STATION_TRANSFER" && edge.from.stationId !== edge.to.stationId) {
    throw new Error("IN_STATION_TRANSFER station identity mismatch");
  }
  if (endpointTarget === "BOTH" || edge.edgeType === "RIDE") {
    if (!fromIsStationLine || !toIsStationLine) throw new Error("route edge station-line endpoint is required");
  }
}

function targetStationLines(edge, endpointTarget) {
  const targets = endpointTarget === "FROM" ? [edge.from]
    : endpointTarget === "TO" ? [edge.to]
      : endpointTarget === "BOTH" ? [edge.from, edge.to]
        : [];
  const unique = new Map(targets.map((target) => [stationLineKey(target), target]));
  return [...unique.values()].sort(compareStationLines);
}

function validateRideInvariant(edge, policy) {
  const local = policy.rideInvariant.subwayLocal;
  const itx = policy.rideInvariant.itxCheongchunExpress;
  if (edge.serviceClass === local.serviceClass && edge.servicePattern === local.servicePattern) {
    if (edge.from.lineId !== edge.to.lineId) throw new Error("SUBWAY LOCAL RIDE must stay on one line");
    if (edge.durationSeconds > 0 && edge.distanceMeters > 0) {
      const speedKmh = (edge.distanceMeters / edge.durationSeconds) * 3.6;
      if (speedKmh < local.measuredSpeedKmhMinimum || speedKmh > local.measuredSpeedKmhMaximum) {
        throw new Error("RIDE speed is outside policy bounds");
      }
    }
    return;
  }
  if (edge.serviceClass === itx.serviceClass && edge.servicePattern === itx.servicePattern) return;
  throw new Error("RIDE service identity is not allowed by current policy");
}

function cellWithEffectiveState(cell, evaluationAtMillis) {
  if (cell.state === "MISSING") return canonicalObject({ ...cell, effectiveState: "MISSING" });
  const capturedAt = requiredUtcInstant(cell.capturedAt, "materialization capturedAt");
  const freshUntil = requiredUtcInstant(cell.freshUntil, "materialization freshUntil");
  if (capturedAt > evaluationAtMillis) throw new Error("materialization capturedAt is after evaluationAt");
  const effectiveState = cell.state === "STALE" || freshUntil <= evaluationAtMillis ? "STALE" : cell.state;
  return canonicalObject({ ...cell, effectiveState });
}

function aggregateCellState(cells, precedence) {
  for (const state of precedence) {
    if (cells.some(({ effectiveState }) => effectiveState === state)) return state;
  }
  if (cells.some(({ effectiveState }) => effectiveState === "VERIFIED_ABSENT")) return "BLOCKED";
  if (cells.some(({ effectiveState }) => effectiveState === "UNVERIFIED_EVIDENCE_BLOCKED")) return "BLOCKED";
  if (cells.every(({ effectiveState }) => effectiveState === "NOT_APPLICABLE")) return "NOT_APPLICABLE";
  if (cells.every(({ effectiveState }) => ["VERIFIED_PRESENT", "NOT_APPLICABLE"].includes(effectiveState))) return "PASS";
  return "NOT_EVALUATED";
}

function resultFor(context, requiredDomains, materializationCells, state, reason) {
  const resultWithoutEvidence = canonicalObject({
    edgeId: context.edge.edgeId,
    edgeType: context.edge.edgeType,
    from: context.edge.from,
    to: context.edge.to,
    servicePattern: context.edge.servicePattern,
    serviceClass: context.edge.serviceClass,
    requiredDomains: [...requiredDomains].sort(compareBytes),
    state,
    reason,
    rawEdgeSha256: context.edge.edgeSha256,
    materializationDigest: context.materialization.materializationDigest,
    materializationCells,
    topologySha256: context.candidate.topologySha256,
    policyVersion: context.candidate.policyVersion,
    evaluatorVersion: context.candidate.evaluatorVersion,
    evaluationAt: context.evaluationAt,
  });
  return canonicalObject({ ...resultWithoutEvidence, evidenceSha256: sha256(canonicalJson(resultWithoutEvidence)) });
}

function materializationCellKey(value) {
  return `${value.stationId}\u0000${value.lineId}\u0000${value.operatorId}\u0000${value.domain}`;
}

function stationLineKey(value) {
  return `${value.stationId}\u0000${value.lineId}`;
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareCells(left, right) {
  return compareStationLines(left, right) || compareBytes(left.domain, right.domain);
}

function assertExactArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])) throw new Error(`${label} mismatch`);
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} mismatch`);
  }
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-blank string`);
}

function assertSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be sha256`);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
