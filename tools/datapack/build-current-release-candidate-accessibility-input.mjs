#!/usr/bin/env node
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import {
  canonicalStationLineAccessibilityPayloadJson,
  materializeStationLineAccessibility,
} from "./materialize-station-line-accessibility.mjs";
import {
  canonicalRideEdgeSetSha256,
  routeEdgeSha256,
} from "./evaluate-route-accessibility-edges.mjs";

const CLOSED_STATES = new Set([
  "VERIFIED_PRESENT",
  "VERIFIED_ABSENT",
  "NOT_APPLICABLE",
  "UNVERIFIED_EVIDENCE_BLOCKED",
]);
const ROUTE_EDGE_KEYS = [
  "edgeId", "edgeType", "fromNodeId", "toNodeId", "durationSeconds",
  "distanceMeters", "servicePattern", "serviceClass", "edgeSha256",
];
const ROUTE_CANDIDATE_KEYS = [
  "candidateId", "evaluatorVersion", "policyVersion", "sourceSetSha256",
  "stationSetSha256", "topologySha256",
];
const STATION_CANDIDATE_KEYS = [
  "candidateId", "mappingContractVersion", "materializerVersion",
  "sourceSetSha256", "stationSetSha256",
];
const COUNTS = Object.freeze({
  ENTRY: 213,
  EXIT: 213,
  IN_STATION_TRANSFER: 30,
  RIDE: 2218,
});

export function buildCurrentReleaseCandidateAccessibilityAuthority(input) {
  validateInputBytes(input);
  const sourceFixture = parseBoundJson(input.sourceFixtureBytes, null, "source fixture");
  const buildSpec = parseBoundJson(input.buildSpecBytes, input.buildSpec, "build spec");
  const stationLineInput = parseBoundJson(
    input.stationLineInputBytes,
    input.stationLineInput,
    "station-line input",
  );
  const route = parseBoundJson(input.routeBytes, input.route, "route-edge input");
  const sourcePack = capitalPack(sourceFixture, "source fixture");
  const projectedPack = capitalPack(input.projectedFixture, "projected fixture");
  validateSourceFixtureEdges(sourcePack.networkEdges);
  validateCandidateIdentity(buildSpec, stationLineInput, route);
  const routeEdges = validateRoute(route, stationLineInput);
  const projectedRides = validateProjectedFixtureEdges(projectedPack.networkEdges, routeEdges);
  const observedAt = deriveObservedAt(stationLineInput.evidenceRows);
  const materialization = materializeStationLineAccessibility({ ...stationLineInput, observedAt });
  validateMaterialization(materialization);

  const candidateFixture = candidateFixtureFrom(input.projectedFixture, projectedRides, routeEdges);
  const candidateFixtureBytes = Buffer.from(canonicalCurrentReleaseCandidateFixtureJson(candidateFixture));
  const rows = materializationRowIndex(materialization);
  const authorityEdges = routeEdges
    .filter(({ edgeType }) => edgeType !== "RIDE")
    .map((edge) => authorityEdge(edge, rows));
  const edgeCounts = countAuthorityEdges(authorityEdges);
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "server-route-coverage-authority",
    candidate: stationLineInput.candidate,
    buildInput: {
      buildSpecSha256: sha256(input.buildSpecBytes),
      sourceFixtureSha256: sha256(input.sourceFixtureBytes),
      candidateFixtureSha256: sha256(candidateFixtureBytes),
      stationLineInputSha256: sha256(input.stationLineInputBytes),
      routeEdgeInputSha256: sha256(input.routeBytes),
      materializationDigest: materialization.materializationDigest,
      observedAt,
    },
    edgeCounts,
    edges: authorityEdges,
  });
  const authority = canonicalObject({
    ...payload,
    authoritySha256: sha256(Buffer.from(canonicalJson(payload))),
  });
  return { candidateFixture, authority };
}

export function canonicalCurrentReleaseCandidateFixtureJson(value) {
  capitalPack(value, "candidate fixture");
  return canonicalJson(value);
}

export function canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(
  value,
  { payloadOnly = false } = {},
) {
  exact(value, [
    "schemaVersion", "artifactKind", "candidate", "buildInput", "edgeCounts",
    "edges", "authoritySha256",
  ], "authority");
  if (value.schemaVersion !== 1 || value.artifactKind !== "server-route-coverage-authority") {
    throw new Error("authority identity mismatch");
  }
  const { authoritySha256, ...payload } = value;
  validateAuthorityPayload(payload);
  const payloadBytes = Buffer.from(canonicalJson(payload));
  if (!/^[a-f0-9]{64}$/u.test(authoritySha256)
    || authoritySha256 !== sha256(payloadBytes)) {
    throw new Error("authority hash mismatch");
  }
  return canonicalJson(payloadOnly ? payload : value);
}

export function rebuildCurrentReleaseCandidateFixture({ projectedFixture, authority }) {
  canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(authority);
  const pack = capitalPack(projectedFixture, "projected fixture");
  const counts = edgeTypeCounts(pack.networkEdges);
  if (pack.networkEdges.length !== 2222 || counts.RIDE !== 2218
    || counts.ENTRY !== 2 || counts.EXIT !== 2 || Object.keys(counts).length !== 3) {
    throw new Error("projected fixture legacy non-RIDE denominator mismatch");
  }
  const rides = pack.networkEdges.filter(({ edgeType }) => edgeType === "RIDE");
  const routeEdges = authority.edges.map((edge) => ({
    edgeId: edge.edgeId,
    edgeType: edge.edgeType,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    durationSeconds: edge.durationSeconds,
    distanceMeters: edge.distanceMeters,
    servicePattern: "",
    serviceClass: "SUBWAY",
    edgeSha256: edge.routeEdgeSha256,
  }));
  return candidateFixtureFrom(projectedFixture, rides, routeEdges);
}

function validateAuthorityPayload(payload) {
  exact(payload, [
    "schemaVersion", "artifactKind", "candidate", "buildInput", "edgeCounts", "edges",
  ], "authority payload");
  exact(payload.candidate, STATION_CANDIDATE_KEYS, "authority candidate");
  exact(payload.buildInput, [
    "buildSpecSha256", "sourceFixtureSha256", "candidateFixtureSha256",
    "stationLineInputSha256", "routeEdgeInputSha256", "materializationDigest", "observedAt",
  ], "authority build input");
  exact(payload.edgeCounts, ["ENTRY", "EXIT", "IN_STATION_TRANSFER", "total"], "authority edge counts");
  for (const key of [
    "buildSpecSha256", "sourceFixtureSha256", "candidateFixtureSha256",
    "stationLineInputSha256", "routeEdgeInputSha256", "materializationDigest",
  ]) {
    if (!/^[a-f0-9]{64}$/u.test(payload.buildInput[key])) throw new Error("authority input hash mismatch");
  }
  if (!Number.isFinite(Date.parse(payload.buildInput.observedAt))
    || payload.buildInput.observedAt !== new Date(payload.buildInput.observedAt).toISOString()) {
    throw new Error("authority observedAt mismatch");
  }
  if (canonicalJson(payload.edgeCounts) !== canonicalJson({
    ENTRY: 213, EXIT: 213, IN_STATION_TRANSFER: 30, total: 456,
  }) || !Array.isArray(payload.edges) || payload.edges.length !== 456) {
    throw new Error("authority edge denominator mismatch");
  }
  const ids = new Set();
  let previous = null;
  for (const edge of payload.edges) {
    exact(edge, [
      "edgeId", "edgeType", "fromNodeId", "toNodeId", "durationSeconds",
      "distanceMeters", "routeEdgeSha256", "requiredCells",
    ], "authority edge");
    if (typeof edge.edgeId !== "string" || edge.edgeId.length === 0
      || !["ENTRY", "EXIT", "IN_STATION_TRANSFER"].includes(edge.edgeType)
      || ids.has(edge.edgeId) || !/^[a-f0-9]{64}$/u.test(edge.routeEdgeSha256)
      || !Number.isSafeInteger(edge.durationSeconds) || edge.durationSeconds < 0
      || !Number.isSafeInteger(edge.distanceMeters) || edge.distanceMeters < 0
      || (previous !== null && compareBytes(previous, edge.edgeId) >= 0)) {
      throw new Error("authority edge identity mismatch");
    }
    ids.add(edge.edgeId);
    previous = edge.edgeId;
    const routePayload = {
      edgeId: edge.edgeId,
      edgeType: edge.edgeType,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      durationSeconds: edge.durationSeconds,
      distanceMeters: edge.distanceMeters,
      servicePattern: "",
      serviceClass: "SUBWAY",
    };
    if (edge.routeEdgeSha256 !== routeEdgeSha256(routePayload)) {
      throw new Error("authority route edge hash mismatch");
    }
    const requiredCount = edge.edgeType === "IN_STATION_TRANSFER" ? 2 : 1;
    if (!Array.isArray(edge.requiredCells) || edge.requiredCells.length !== requiredCount) {
      throw new Error("authority required cell denominator mismatch");
    }
    const cells = new Set();
    for (const cell of edge.requiredCells) {
      exact(cell, ["stationId", "lineId", "domain", "state", "rowSha256"], "authority cell");
      const key = `${cell.stationId}:${cell.lineId}:${cell.domain}`;
      if (cells.has(key) || !["FACILITY", "EXIT", "TRANSFER"].includes(cell.domain)
        || !CLOSED_STATES.has(cell.state) || !/^[a-f0-9]{64}$/u.test(cell.rowSha256)) {
        throw new Error("authority required cell mismatch");
      }
      cells.add(key);
    }
    validateAuthorityEdgeCells(edge);
  }
}

function validateAuthorityEdgeCells(edge) {
  if (edge.edgeType === "ENTRY") {
    const endpoint = stationLineNode(edge.toNodeId);
    assertAuthorityCell(edge.requiredCells[0], endpoint, "FACILITY");
    return;
  }
  if (edge.edgeType === "EXIT") {
    const endpoint = stationLineNode(edge.fromNodeId);
    assertAuthorityCell(edge.requiredCells[0], endpoint, "EXIT");
    return;
  }
  const from = stationLineNode(edge.fromNodeId);
  const to = stationLineNode(edge.toNodeId);
  if (from.stationId !== to.stationId || from.lineId === to.lineId) {
    throw new Error("authority transfer endpoint mismatch");
  }
  assertAuthorityCell(edge.requiredCells[0], from, "TRANSFER");
  assertAuthorityCell(edge.requiredCells[1], to, "TRANSFER");
}

function assertAuthorityCell(cell, endpoint, domain) {
  if (cell.stationId !== endpoint.stationId || cell.lineId !== endpoint.lineId
    || cell.domain !== domain) {
    throw new Error("authority required cell endpoint mismatch");
  }
}

function validateInputBytes(input) {
  exact(input, [
    "buildSpec", "buildSpecBytes", "projectedFixture", "route", "routeBytes",
    "sourceFixtureBytes", "stationLineInput", "stationLineInputBytes",
  ], "authority input");
  for (const key of [
    "buildSpecBytes", "routeBytes", "sourceFixtureBytes", "stationLineInputBytes",
  ]) {
    if (!Buffer.isBuffer(input[key])) throw new Error(`${key} must be bytes`);
  }
}

function parseBoundJson(bytes, value, label) {
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} must be UTF-8 JSON`); }
  if (value !== null && canonicalJson(parsed) !== canonicalJson(value)) {
    throw new Error(`${label} raw binding mismatch`);
  }
  return parsed;
}

function capitalPack(fixture, label) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)
    || fixture.manifest?.channel !== "production"
    || fixture.manifest?.activePack?.id !== "capital") {
    throw new Error(`${label} identity mismatch`);
  }
  const packs = fixture.packs?.filter(({ id }) => id === "capital") ?? [];
  if (packs.length !== 1 || !Array.isArray(packs[0].networkEdges)) {
    throw new Error(`${label} capital pack mismatch`);
  }
  return packs[0];
}

function validateSourceFixtureEdges(edges) {
  const counts = edgeTypeCounts(edges);
  if (edges.length !== 2214 || counts.RIDE !== 2210 || counts.ENTRY !== 2
    || counts.EXIT !== 2 || Object.keys(counts).length !== 3) {
    throw new Error("source fixture edge denominator mismatch");
  }
}

function validateCandidateIdentity(buildSpec, stationLineInput, route) {
  exact(stationLineInput, ["candidate", "stationLines", "evidenceRows"], "station-line input");
  exact(stationLineInput.candidate, STATION_CANDIDATE_KEYS, "station-line candidate");
  exact(route, ["candidate", "stationLines", "routeEdges"], "route-edge input");
  exact(route.candidate, ROUTE_CANDIDATE_KEYS, "route candidate");
  if (buildSpec?.candidateId !== stationLineInput.candidate.candidateId
    || buildSpec?.sourceSnapshotSetHash !== stationLineInput.candidate.sourceSetSha256
    || route.candidate.candidateId !== stationLineInput.candidate.candidateId
    || route.candidate.sourceSetSha256 !== stationLineInput.candidate.sourceSetSha256
    || route.candidate.stationSetSha256 !== stationLineInput.candidate.stationSetSha256) {
    throw new Error("candidate identity mismatch");
  }
  const stationLines = stationLineInput.stationLines;
  if (!Array.isArray(stationLines) || stationLines.length !== 213
    || !Array.isArray(stationLineInput.evidenceRows)
    || stationLineInput.evidenceRows.length !== 641) {
    throw new Error("station-line denominator mismatch");
  }
  const stationKeys = new Set(stationLines.map(stationLineKey));
  const routeKeys = new Set((route.stationLines ?? []).map(stationLineKey));
  if (stationKeys.size !== 213 || routeKeys.size !== 213 || !equalSets(stationKeys, routeKeys)) {
    throw new Error("route station-line candidate mismatch");
  }
}

function validateRoute(route, stationLineInput) {
  if (!Array.isArray(route.routeEdges) || route.routeEdges.length !== 2674) {
    throw new Error("route edge denominator mismatch");
  }
  const ids = new Set();
  for (const edge of route.routeEdges) {
    exact(edge, ROUTE_EDGE_KEYS, "route edge");
    const payload = Object.fromEntries(ROUTE_EDGE_KEYS
      .filter((key) => key !== "edgeSha256")
      .map((key) => [key, edge[key]]));
    if (ids.has(edge.edgeId) || edge.edgeSha256 !== routeEdgeSha256(payload)) {
      throw new Error("route edge hash mismatch");
    }
    ids.add(edge.edgeId);
  }
  const counts = edgeTypeCounts(route.routeEdges);
  if (Object.entries(COUNTS).some(([type, count]) => counts[type] !== count)
    || Object.keys(counts).length !== Object.keys(COUNTS).length) {
    throw new Error("route edge coverage mismatch");
  }
  const rides = route.routeEdges.filter(({ edgeType }) => edgeType === "RIDE");
  if (route.candidate.topologySha256 !== canonicalRideEdgeSetSha256(rides)) {
    throw new Error("route topology hash mismatch");
  }
  const stationKeys = new Set(stationLineInput.stationLines.map(stationLineKey));
  for (const edge of route.routeEdges.filter(({ edgeType }) => edgeType !== "RIDE")) {
    const nodes = edge.edgeType === "ENTRY"
      ? [edge.toNodeId]
      : edge.edgeType === "EXIT"
        ? [edge.fromNodeId]
        : [edge.fromNodeId, edge.toNodeId];
    if (nodes.some((node) => !stationKeys.has(node))) {
      throw new Error("route edge endpoint mismatch");
    }
  }
  return route.routeEdges;
}

function validateProjectedFixtureEdges(edges, routeEdges) {
  const counts = edgeTypeCounts(edges);
  if (edges.length !== 2222 || counts.RIDE !== 2218 || counts.ENTRY !== 2
    || counts.EXIT !== 2 || Object.keys(counts).length !== 3) {
    throw new Error("projected fixture legacy non-RIDE denominator mismatch");
  }
  const rides = edges.filter(({ edgeType }) => edgeType === "RIDE");
  const routeRides = new Map(routeEdges
    .filter(({ edgeType }) => edgeType === "RIDE")
    .map((edge) => [edge.edgeId, edge]));
  if (new Set(rides.map(({ id }) => id)).size !== 2218 || routeRides.size !== 2218) {
    throw new Error("projected fixture RIDE denominator mismatch");
  }
  for (const ride of rides) {
    const route = routeRides.get(ride.id);
    if (!route || ride.edgeType !== route.edgeType || ride.fromNodeId !== route.fromNodeId
      || ride.toNodeId !== route.toNodeId || ride.durationSeconds !== route.durationSeconds
      || ride.distanceMeters !== route.distanceMeters
      || (ride.servicePattern ?? "") !== route.servicePattern
      || (ride.serviceClass ?? "SUBWAY") !== route.serviceClass) {
      throw new Error("projected fixture RIDE mismatch");
    }
  }
  return rides;
}

function deriveObservedAt(evidenceRows) {
  const captured = evidenceRows.map(({ capturedAt, freshUntil }) => {
    const capturedMillis = Date.parse(capturedAt);
    const freshMillis = Date.parse(freshUntil);
    if (!Number.isFinite(capturedMillis) || !Number.isFinite(freshMillis)
      || freshMillis <= capturedMillis) {
      throw new Error("evidence freshness mismatch");
    }
    return { capturedMillis, freshMillis };
  });
  const observedMillis = Math.max(...captured.map(({ capturedMillis }) => capturedMillis));
  if (!Number.isFinite(observedMillis)
    || captured.some(({ freshMillis }) => freshMillis <= observedMillis)) {
    throw new Error("evidence is stale at full-capital observation time");
  }
  return new Date(observedMillis).toISOString();
}

function validateMaterialization(value) {
  if (!Array.isArray(value.rows) || value.rows.length !== 639
    || value.stateSummary.UNKNOWN !== 0 || value.stateSummary.MISSING !== 0
    || value.stateSummary.STALE !== 0
    || value.stateSummary.UNVERIFIED_EVIDENCE_BLOCKED !== 2
    || value.rows.some(({ state }) => !CLOSED_STATES.has(state))
    || value.materializationDigest !== sha256(Buffer.from(canonicalStationLineAccessibilityPayloadJson(value)))) {
    throw new Error("full-capital materialization has unresolved evidence");
  }
}

function candidateFixtureFrom(projectedFixture, projectedRides, routeEdges) {
  const candidateFixture = structuredClone(projectedFixture);
  const pack = capitalPack(candidateFixture, "candidate fixture");
  const nonRide = routeEdges
    .filter(({ edgeType }) => edgeType !== "RIDE")
    .map(canonicalUnverifiedEdge);
  pack.networkEdges = [...structuredClone(projectedRides), ...nonRide]
    .sort((left, right) => compareBytes(left.id, right.id));
  const counts = edgeTypeCounts(pack.networkEdges);
  if (pack.networkEdges.length !== 2674
    || Object.entries(COUNTS).some(([type, count]) => counts[type] !== count)) {
    throw new Error("candidate fixture edge denominator mismatch");
  }
  return canonicalObject(candidateFixture);
}

function canonicalUnverifiedEdge(edge) {
  return canonicalObject({
    id: edge.edgeId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    durationSeconds: edge.durationSeconds,
    distanceMeters: edge.distanceMeters,
    edgeType: edge.edgeType,
    servicePattern: edge.servicePattern,
    serviceClass: edge.serviceClass,
    includesStairs: false,
    stairAccessState: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 100,
    facilityId: null,
  });
}

function materializationRowIndex(materialization) {
  const rows = new Map();
  for (const row of materialization.rows) {
    const key = `${row.stationId}:${row.lineId}:${row.domain}`;
    if (rows.has(key)) throw new Error("materialization row duplicate");
    rows.set(key, row);
  }
  return rows;
}

function authorityEdge(edge, rows) {
  let required;
  if (edge.edgeType === "ENTRY") {
    const { stationId, lineId } = stationLineNode(edge.toNodeId);
    required = [requiredCell(rows, stationId, lineId, "FACILITY")];
  } else if (edge.edgeType === "EXIT") {
    const { stationId, lineId } = stationLineNode(edge.fromNodeId);
    required = [requiredCell(rows, stationId, lineId, "EXIT")];
  } else if (edge.edgeType === "IN_STATION_TRANSFER") {
    const from = stationLineNode(edge.fromNodeId);
    const to = stationLineNode(edge.toNodeId);
    if (from.stationId !== to.stationId || from.lineId === to.lineId) {
      throw new Error("transfer edge endpoint mismatch");
    }
    required = [
      requiredCell(rows, from.stationId, from.lineId, "TRANSFER"),
      requiredCell(rows, to.stationId, to.lineId, "TRANSFER"),
    ];
  } else {
    throw new Error("unsupported authority edge type");
  }
  return canonicalObject({
    edgeId: edge.edgeId,
    edgeType: edge.edgeType,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    durationSeconds: edge.durationSeconds,
    distanceMeters: edge.distanceMeters,
    routeEdgeSha256: edge.edgeSha256,
    requiredCells: required,
  });
}

function requiredCell(rows, stationId, lineId, domain) {
  const row = rows.get(`${stationId}:${lineId}:${domain}`);
  if (!row || !CLOSED_STATES.has(row.state)) {
    throw new Error("terminal accessibility evidence required");
  }
  return canonicalObject({
    stationId,
    lineId,
    domain,
    state: row.state,
    rowSha256: sha256(Buffer.from(canonicalJson(row))),
  });
}

function countAuthorityEdges(edges) {
  const counts = edgeTypeCounts(edges);
  if (edges.length !== 456 || counts.ENTRY !== 213 || counts.EXIT !== 213
    || counts.IN_STATION_TRANSFER !== 30 || Object.keys(counts).length !== 3) {
    throw new Error("authority edge denominator mismatch");
  }
  return canonicalObject({ ...counts, total: edges.length });
}

function stationLineNode(nodeId) {
  if (typeof nodeId !== "string") throw new Error("station-line node mismatch");
  const parts = nodeId.split(":");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error("station-line node mismatch");
  }
  return { stationId: parts[0], lineId: parts[1] };
}

function stationLineKey(value) {
  return `${value.stationId}:${value.lineId}`;
}

function edgeTypeCounts(edges) {
  const counts = {};
  for (const { edgeType } of edges) counts[edgeType] = (counts[edgeType] ?? 0) + 1;
  return counts;
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} shape mismatch`);
  }
}

function equalSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareBytes)
    .map((key) => [key, canonicalObject(value[key])]));
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function defaultProjectFixture({ buildSpec, sourceFixture, repositoryRoot }) {
  const { projectCandidateFixtureForAccessibilityAuthority } = await import("./build-datapack.mjs");
  return projectCandidateFixtureForAccessibilityAuthority({ buildSpec, sourceFixture, repositoryRoot });
}

export async function main(
  argv = process.argv.slice(2),
  {
    repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)),
    projectFixtureImpl = defaultProjectFixture,
  } = {},
) {
  if (argv.length !== 12) throw new Error("CLI arguments mismatch");
  const args = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    argv[index * 2]?.replace(/^--/u, ""),
    argv[(index * 2) + 1],
  ]));
  const required = [
    "fixture", "build-spec", "station-line-input", "route-edge-input",
    "fixture-output", "authority-output",
  ];
  if (required.some((key) => !args[key]) || Object.keys(args).length !== required.length) {
    throw new Error("CLI arguments mismatch");
  }
  const root = path.resolve(repositoryRoot);
  const fixtureOutput = path.resolve(root, args["fixture-output"]);
  const authorityOutput = path.resolve(root, args["authority-output"]);
  if (fixtureOutput === authorityOutput) throw new Error("output paths must be distinct");
  await Promise.all([outputMustBeAbsent(fixtureOutput), outputMustBeAbsent(authorityOutput)]);
  const sourceFixtureBytes = await readFile(path.resolve(root, args.fixture));
  const buildSpecBytes = await readFile(path.resolve(root, args["build-spec"]));
  const stationLineInputBytes = await readFile(path.resolve(root, args["station-line-input"]));
  const routeBytes = await readFile(path.resolve(root, args["route-edge-input"]));
  const sourceFixture = JSON.parse(sourceFixtureBytes.toString("utf8"));
  const buildSpec = JSON.parse(buildSpecBytes.toString("utf8"));
  const stationLineInput = JSON.parse(stationLineInputBytes.toString("utf8"));
  const route = JSON.parse(routeBytes.toString("utf8"));
  const projectedFixture = await projectFixtureImpl({ buildSpec, sourceFixture, repositoryRoot: root });
  const result = buildCurrentReleaseCandidateAccessibilityAuthority({
    buildSpec,
    buildSpecBytes,
    projectedFixture,
    route,
    routeBytes,
    sourceFixtureBytes,
    stationLineInput,
    stationLineInputBytes,
  });
  await Promise.all([
    writeFile(fixtureOutput, canonicalCurrentReleaseCandidateFixtureJson(result.candidateFixture), { flag: "wx", mode: 0o600 }),
    writeFile(authorityOutput, canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(result.authority), { flag: "wx", mode: 0o600 }),
  ]);
  return result;
}

async function outputMustBeAbsent(target) {
  try { await lstat(target); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("output must be absent");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
