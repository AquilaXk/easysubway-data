#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
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
import { canonicalCurrentCapitalRouteEdgeInputJson } from "./build-current-capital-route-edge-input.mjs";
import {
  canonicalCurrentCapitalStationLineInputJson,
  deriveCurrentReleaseCandidateObservedAt,
} from "./current-capital-station-line-contract.mjs";
import { buildCurrentCapitalAccessibilityRefreshOutputs } from "./refresh-current-capital-accessibility-full.mjs";

const CURRENT_STATION_INPUT = "tools/datapack/release/current-capital-accessibility-full/station-line-input.json";
const CURRENT_ROUTE_INPUT = "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json";
const REJECTED_INPUT_PATH_TOKEN = /fixture|debug|demo|sample/iu;

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
const ROUTE_EDGE_TYPES = new Set(["ENTRY", "EXIT", "IN_STATION_TRANSFER", "RIDE"]);
const AUTHORITY_EDGE_TYPES = new Set(["ENTRY", "EXIT", "IN_STATION_TRANSFER"]);
const MATERIALIZATION_DOMAINS = ["FACILITY", "EXIT", "TRANSFER"];

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
  const routeStationIndex = validateCandidateIdentity(
    buildSpec,
    stationLineInput,
    route,
    projectedPack,
  );
  const routeEdges = validateRoute(route, stationLineInput, routeStationIndex);
  validateRideFixtureEdges(sourcePack.networkEdges, routeEdges, "source fixture");
  const projectedRides = validateProjectedFixtureEdges(projectedPack.networkEdges, routeEdges);
  const observedAt = deriveCurrentReleaseCandidateObservedAt(stationLineInput.evidenceRows);
  const materialization = materializeStationLineAccessibility({ ...stationLineInput, observedAt });
  validateMaterialization(materialization, stationLineInput.stationLines);

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
  const rides = rideOnlyFixtureEdges(pack.networkEdges, "projected fixture");
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

export function validateCurrentReleaseCandidateAccessibilityAuthorityReplay({
  authority,
  projectedFixture,
  stationLineInputBytes,
  routeEdgeInputBytes,
}) {
  canonicalCurrentReleaseCandidateAccessibilityAuthorityJson(authority);
  if (!Buffer.isBuffer(stationLineInputBytes) || !Buffer.isBuffer(routeEdgeInputBytes)) {
    throw new TypeError("authority replay inputs must be bytes");
  }
  const stationLineInput = parseBoundJson(stationLineInputBytes, null, "station-line input");
  const route = parseBoundJson(routeEdgeInputBytes, null, "route-edge input");
  if (stationLineInputBytes.toString("utf8") !== canonicalCurrentCapitalStationLineInputJson(stationLineInput)
    || routeEdgeInputBytes.toString("utf8") !== canonicalCurrentCapitalRouteEdgeInputJson(route)
    || sha256(stationLineInputBytes) !== authority.buildInput.stationLineInputSha256
    || sha256(routeEdgeInputBytes) !== authority.buildInput.routeEdgeInputSha256) {
    throw new Error("authority replay input mismatch");
  }
  const routeStationIndex = validateReplayCandidateIdentity(authority, stationLineInput, route);
  const routeEdges = validateRoute(route, stationLineInput, routeStationIndex);
  const projectedPack = capitalPack(projectedFixture, "projected fixture");
  validateProjectedFixtureEdges(projectedPack.networkEdges, routeEdges);
  const observedAt = deriveCurrentReleaseCandidateObservedAt(stationLineInput.evidenceRows);
  const materialization = materializeStationLineAccessibility({ ...stationLineInput, observedAt });
  validateMaterialization(materialization, stationLineInput.stationLines);
  if (authority.buildInput.observedAt !== observedAt
    || authority.buildInput.materializationDigest !== materialization.materializationDigest) {
    throw new Error("authority replay input mismatch");
  }
  const expectedEdges = routeEdges
    .filter(({ edgeType }) => edgeType !== "RIDE")
    .map((edge) => authorityEdge(edge, materializationRowIndex(materialization)));
  if (canonicalJson(countAuthorityEdges(expectedEdges)) !== canonicalJson(authority.edgeCounts)
    || canonicalJson(expectedEdges) !== canonicalJson(authority.edges)) {
    throw new Error("authority replay mismatch");
  }
  return { stationLineInput, route, materialization };
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
  if (!Array.isArray(payload.edges) || payload.edges.length === 0) {
    throw new Error("authority edge denominator mismatch");
  }
  const actualCounts = edgeTypeCounts(payload.edges);
  if (!exactKeySet(actualCounts, AUTHORITY_EDGE_TYPES)
    || canonicalJson(payload.edgeCounts) !== canonicalJson({ ...actualCounts, total: payload.edges.length })) {
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

function validateRideFixtureEdges(edges, routeEdges, label) {
  const rides = new Map(rideOnlyFixtureEdges(edges, label).map((edge) => [edge.id, edge]));
  const routeRides = new Map(routeEdges
    .filter(({ edgeType }) => edgeType === "RIDE")
    .map((edge) => [edge.edgeId, edge]));
  if (rides.size !== edges.length || rides.size !== routeRides.size) {
    throw new Error(`${label} RIDE denominator mismatch`);
  }
  for (const [id, ride] of rides) {
    const route = routeRides.get(id);
    if (!route || ride.edgeType !== route.edgeType || ride.fromNodeId !== route.fromNodeId
      || ride.toNodeId !== route.toNodeId || ride.durationSeconds !== route.durationSeconds
      || ride.distanceMeters !== route.distanceMeters
      || (ride.servicePattern ?? "") !== route.servicePattern
      || (ride.serviceClass ?? "SUBWAY") !== route.serviceClass) {
      throw new Error(`${label} RIDE mismatch`);
    }
  }
  return [...rides.values()];
}

function rideOnlyFixtureEdges(edges, label) {
  const counts = edgeTypeCounts(edges);
  if (!Array.isArray(edges) || edges.length === 0 || counts.RIDE !== edges.length || !exactKeySet(counts, new Set(["RIDE"]))) {
    throw new Error(`${label} must be RIDE-only`);
  }
  if (edges.some(({ id }) => typeof id !== "string" || id.length === 0)) {
    throw new Error(`${label} RIDE identifier mismatch`);
  }
  if (new Set(edges.map(({ id }) => id)).size !== edges.length) {
    throw new Error(`${label} RIDE denominator mismatch`);
  }
  return edges;
}

function validateCandidateIdentity(buildSpec, stationLineInput, route, projectedPack) {
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
  const stationIndex = stationLineIndex(stationLines, "station-line input row");
  if (!Array.isArray(stationLineInput.evidenceRows) || stationLineInput.evidenceRows.length === 0) {
    throw new Error("station-line denominator mismatch");
  }
  const projectedStationLines = projectedRouteStationLines(projectedPack);
  if (!Array.isArray(route.stationLines)
    || canonicalJson(route.stationLines) !== canonicalJson(projectedStationLines)) {
    throw new Error("route station-line candidate mismatch");
  }
  const routeByKey = new Map(projectedStationLines.map((line) => [stationLineKey(line), line]));
  for (const line of stationIndex.values()) {
    if (routeByKey.get(stationLineKey(line))?.operatorId !== line.operatorId) {
      throw new Error("route station-line accessibility subset mismatch");
    }
  }
  return {
    byKey: routeByKey,
    stationIds: new Set(projectedStationLines.map(({ stationId }) => stationId)),
  };
}

function validateReplayCandidateIdentity(authority, stationLineInput, route) {
  exact(stationLineInput, ["candidate", "stationLines", "evidenceRows"], "station-line input");
  exact(stationLineInput.candidate, STATION_CANDIDATE_KEYS, "station-line candidate");
  exact(route, ["candidate", "stationLines", "routeEdges"], "route-edge input");
  exact(route.candidate, ROUTE_CANDIDATE_KEYS, "route candidate");
  if (canonicalJson(stationLineInput.candidate) !== canonicalJson(authority.candidate)
    || route.candidate.candidateId !== authority.candidate.candidateId
    || route.candidate.sourceSetSha256 !== authority.candidate.sourceSetSha256
    || route.candidate.stationSetSha256 !== authority.candidate.stationSetSha256) {
    throw new Error("authority replay candidate mismatch");
  }
  if (!Array.isArray(stationLineInput.evidenceRows) || stationLineInput.evidenceRows.length === 0) {
    throw new Error("authority replay denominator mismatch");
  }
  const byKey = routeStationLineIndex(route.stationLines);
  const stationIndex = stationLineIndex(stationLineInput.stationLines, "station-line input row");
  const stationIds = new Set();
  for (const line of byKey.values()) stationIds.add(line.stationId);
  for (const line of stationIndex.values()) {
    if (byKey.get(stationLineKey(line))?.operatorId !== line.operatorId) {
      throw new Error("authority replay station-line mismatch");
    }
  }
  return { byKey, stationIds };
}

function validateRoute(route, stationLineInput, routeStationIndex) {
  const routeEdges = validateRouteEdgeShapes(route.routeEdges);
  const counts = edgeTypeCounts(routeEdges);
  if (!exactKeySet(counts, ROUTE_EDGE_TYPES)) {
    throw new Error("route edge coverage mismatch");
  }
  const rides = routeEdges.filter(({ edgeType }) => edgeType === "RIDE");
  if (route.candidate.topologySha256 !== canonicalRideEdgeSetSha256(rides)) {
    throw new Error("route topology hash mismatch");
  }
  validateRouteEndpoints(routeEdges, stationLineInput.stationLines, routeStationIndex);
  validateEntryExitBijections(routeEdges, stationLineInput.stationLines);
  return routeEdges;
}

function validateRouteEdgeShapes(routeEdges) {
  if (!Array.isArray(routeEdges) || routeEdges.length === 0) {
    throw new Error("route edge denominator mismatch");
  }
  const ids = new Set();
  for (const edge of routeEdges) {
    exact(edge, ROUTE_EDGE_KEYS, "route edge");
    if (typeof edge.edgeId !== "string" || edge.edgeId.length === 0) {
      throw new Error("route edge identifier mismatch");
    }
    const payload = Object.fromEntries(ROUTE_EDGE_KEYS
      .filter((key) => key !== "edgeSha256")
      .map((key) => [key, edge[key]]));
    if (ids.has(edge.edgeId) || edge.edgeSha256 !== routeEdgeSha256(payload)) {
      throw new Error("route edge hash mismatch");
    }
    ids.add(edge.edgeId);
  }
  return routeEdges;
}

function validateRouteEndpoints(routeEdges, stationLines, routeStationIndex) {
  const stationKeys = new Set(stationLines.map(stationLineKey));
  for (const edge of routeEdges) {
    for (const node of [edge.fromNodeId, edge.toNodeId]) {
      validateRouteEndpoint(node, edge, routeStationIndex);
    }
    if (edge.edgeType === "RIDE") continue;
    const accessibilityNodes = edge.edgeType === "ENTRY"
      ? [edge.toNodeId]
      : edge.edgeType === "EXIT"
        ? [edge.fromNodeId]
        : [edge.fromNodeId, edge.toNodeId];
    if (accessibilityNodes.some((node) => !stationKeys.has(node))) {
      throw new Error("route edge endpoint mismatch");
    }
  }
}

function projectedRouteStationLines(pack) {
  const operatorByLine = new Map();
  for (const line of pack?.lines ?? []) {
    if (typeof line?.id !== "string" || line.id.length === 0
      || typeof line.operatorId !== "string" || line.operatorId.length === 0
      || operatorByLine.has(line.id)) {
      throw new Error("projected route line identity mismatch");
    }
    operatorByLine.set(line.id, line.operatorId);
  }
  const keys = new Set();
  const stationLines = (pack?.stationLines ?? []).map(({ stationId, lineId, lineSequence }) => {
    const operatorId = operatorByLine.get(lineId);
    const key = `${stationId}:${lineId}`;
    if (typeof stationId !== "string" || stationId.length === 0
      || typeof lineId !== "string" || lineId.length === 0
      || typeof operatorId !== "string" || operatorId.length === 0
      || !Number.isSafeInteger(lineSequence) || lineSequence < 0 || keys.has(key)) {
      throw new Error("projected route station-line mismatch");
    }
    keys.add(key);
    return { stationId, lineId, operatorId, lineSequence };
  }).sort(compareStationLines);
  if (stationLines.length === 0 || keys.size !== stationLines.length) {
    throw new Error("projected route station-line denominator mismatch");
  }
  return stationLines;
}

function validateRouteEndpoint(nodeId, edge, routeStationIndex) {
  const segments = String(nodeId).split(":");
  const isItxExpress = segments.length === 3
    && segments[2] === "EXPRESS"
    && edge.edgeType === "RIDE"
    && edge.serviceClass === "ITX_CHEONGCHUN"
    && edge.servicePattern === "EXPRESS";
  if (segments.includes("")
    || segments.length > 3
    || (segments.length === 3 && !isItxExpress)
    || (segments.length === 1 && !routeStationIndex.stationIds.has(segments[0]))
    || (segments.length >= 2 && !routeStationIndex.byKey.has(`${segments[0]}:${segments[1]}`))) {
    throw new Error("route edge endpoint mismatch");
  }
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId) || compareBytes(left.lineId, right.lineId);
}

function validateProjectedFixtureEdges(edges, routeEdges) {
  return validateRideFixtureEdges(edges, routeEdges, "projected fixture");
}

function validateMaterialization(value, stationLines) {
  if (!Array.isArray(value.rows)) throw new Error("full-capital materialization has unresolved evidence");
  const expected = new Set(stationLines.flatMap(({ stationId, lineId }) =>
    MATERIALIZATION_DOMAINS.map((domain) => `${stationId}:${lineId}:${domain}`)));
  const actual = new Set(value.rows.map(({ stationId, lineId, domain }) =>
    `${stationId}:${lineId}:${domain}`));
  if (!Array.isArray(value.rows) || expected.size === 0 || actual.size !== value.rows.length
    || actual.size !== expected.size || [...expected].some((key) => !actual.has(key))
    || value.stateSummary.UNKNOWN !== 0 || value.stateSummary.MISSING !== 0
    || value.stateSummary.STALE !== 0
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
  const expected = [...projectedRides, ...nonRide].sort((left, right) => compareBytes(left.id, right.id));
  if (canonicalJson(pack.networkEdges) !== canonicalJson(expected)) {
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
  if (!Array.isArray(edges) || edges.length === 0 || !exactKeySet(counts, AUTHORITY_EDGE_TYPES)) {
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

function exactKeySet(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function stationLineIndex(stationLines, label) {
  if (!Array.isArray(stationLines) || stationLines.length === 0) throw new Error("station-line denominator mismatch");
  const index = new Map();
  for (const line of stationLines) {
    exact(line, ["stationId", "lineId", "operatorId"], label);
    const key = stationLineKey(line);
    if (typeof line.stationId !== "string" || line.stationId.length === 0
      || typeof line.lineId !== "string" || line.lineId.length === 0
      || typeof line.operatorId !== "string" || line.operatorId.length === 0 || index.has(key)) {
      throw new Error("station-line denominator mismatch");
    }
    index.set(key, line);
  }
  return index;
}

function routeStationLineIndex(stationLines) {
  if (!Array.isArray(stationLines) || stationLines.length === 0) throw new Error("authority replay route station-line mismatch");
  const index = new Map(); let previous = null;
  for (const line of stationLines) {
    exact(line, ["stationId", "lineId", "operatorId", "lineSequence"], "route station-line");
    const key = stationLineKey(line);
    if (typeof line.stationId !== "string" || line.stationId.length === 0
      || typeof line.lineId !== "string" || line.lineId.length === 0
      || typeof line.operatorId !== "string" || line.operatorId.length === 0
      || !Number.isSafeInteger(line.lineSequence) || line.lineSequence < 0
      || index.has(key) || (previous !== null && compareStationLines(previous, line) >= 0)) {
      throw new Error("authority replay route station-line mismatch");
    }
    index.set(key, line); previous = line;
  }
  return index;
}

function validateEntryExitBijections(routeEdges, stationLines) {
  const expected = new Set(stationLines.map(stationLineKey));
  for (const [type, node, stationNode] of [
    ["ENTRY", "toNodeId", "fromNodeId"],
    ["EXIT", "fromNodeId", "toNodeId"],
  ]) {
    const selected = routeEdges.filter(({ edgeType }) => edgeType === type);
    if (selected.some((edge) => stationLineNode(edge[node]).stationId !== edge[stationNode])) {
      throw new Error("route edge station mismatch");
    }
    const actual = new Set(selected
      .map((edge) => stationLineKey(stationLineNode(edge[node]))));
    if (selected.length !== expected.size || actual.size !== expected.size
      || [...expected].some((key) => !actual.has(key))) {
      throw new Error("route edge coverage mismatch");
    }
  }
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} shape mismatch`);
  }
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
    buildRefreshOutputsImpl = buildCurrentCapitalAccessibilityRefreshOutputs,
  } = {},
) {
  if (argv.length !== 12) throw new Error("CLI arguments mismatch");
  const args = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    argv[index * 2]?.replace(/^--/u, ""),
    argv[(index * 2) + 1],
  ]));
  const required = [
    "fixture", "build-spec", "station-line-output", "route-edge-output",
    "fixture-output", "authority-output",
  ];
  if (required.some((key) => !args[key]) || Object.keys(args).length !== required.length) {
    throw new Error("CLI arguments mismatch");
  }
  const root = await realRepositoryRoot(repositoryRoot);
  const stationLineOutput = path.resolve(root, args["station-line-output"]);
  const routeEdgeOutput = path.resolve(root, args["route-edge-output"]);
  const fixtureOutput = path.resolve(root, args["fixture-output"]);
  const authorityOutput = path.resolve(root, args["authority-output"]);
  const outputs = [stationLineOutput, routeEdgeOutput, fixtureOutput, authorityOutput];
  if (new Set(outputs).size !== outputs.length) throw new Error("output paths must be distinct");
  const buildSpecFile = await readAuthenticatedRegularRepoFile(root, args["build-spec"], "build spec");
  const buildSpecBytes = buildSpecFile.bytes;
  const buildSpec = parseInputJson(buildSpecBytes, "build spec");
  const fixtureRelative = normalizeInputPath(args.fixture, "fixture");
  if (typeof buildSpec.fixturePath !== "string"
    || fixtureRelative !== normalizeInputPath(buildSpec.fixturePath, "fixture")) {
    throw new Error("current candidate fixture path mismatch");
  }
  const fixtureFile = await readAuthenticatedRegularRepoFile(root, fixtureRelative, "fixture");
  const sourceFixtureBytes = fixtureFile.bytes;
  const sourceFixture = parseInputJson(sourceFixtureBytes, "fixture");
  await Promise.all(outputs.map(outputMustBeAbsent));
  const refreshed = await buildRefreshOutputsImpl({
    repositoryRoot: root,
    phase: "PRE_APPROVAL_CURRENT_CANDIDATE",
    candidateBuildSpec: buildSpec,
    canonicalPack: sourceFixture,
  });
  if (!Array.isArray(refreshed) || refreshed.length !== 2) {
    throw new Error("current candidate accessibility regeneration mismatch");
  }
  const refreshedByPath = new Map(refreshed.map(({ relative, bytes }) => [relative, bytes]));
  if (refreshedByPath.size !== 2
    || !Buffer.isBuffer(refreshedByPath.get(CURRENT_STATION_INPUT))
    || !Buffer.isBuffer(refreshedByPath.get(CURRENT_ROUTE_INPUT))) {
    throw new Error("current candidate accessibility regeneration mismatch");
  }
  const stationLineInputBytes = refreshedByPath.get(CURRENT_STATION_INPUT);
  const routeBytes = refreshedByPath.get(CURRENT_ROUTE_INPUT);
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
    writeFile(stationLineOutput, stationLineInputBytes, { flag: "wx", mode: 0o600 }),
    writeFile(routeEdgeOutput, routeBytes, { flag: "wx", mode: 0o600 }),
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

async function realRepositoryRoot(repositoryRoot) {
  const supplied = path.resolve(repositoryRoot);
  const stat = await lstat(supplied);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("repository root must be a real directory");
  }
  return realpath(supplied);
}

function normalizeInputPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    throw new Error(`${label} path must be a non-empty repository-relative path`);
  }
  const parts = value.split(/[\\/]/u);
  if (parts.some((part) => part === ".." || REJECTED_INPUT_PATH_TOKEN.test(part))) {
    throw new Error(`${label} path is not an admitted production input`);
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//u, "");
  if (normalized === "." || normalized.length === 0 || normalized.startsWith("../")) {
    throw new Error(`${label} path must be a non-empty repository-relative path`);
  }
  return normalized;
}

async function readAuthenticatedRegularRepoFile(root, suppliedPath, label) {
  const relative = normalizeInputPath(suppliedPath, label);
  const target = path.resolve(root, relative);
  const rootRelative = path.relative(root, target);
  if (rootRelative.length === 0 || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) {
    throw new Error(`${label} path escapes repository root`);
  }
  await rejectSymlinkAncestors(root, target, label);
  const descriptor = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await descriptor.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat();
    if (!sameFileIdentity(before, after) || bytes.length !== after.size) {
      throw new Error(`${label} changed while being read`);
    }
    await rejectSymlinkAncestors(root, target, label);
    const pathname = await lstat(target);
    if (pathname.isSymbolicLink() || !pathname.isFile() || !sameFileIdentity(after, pathname)) {
      throw new Error(`${label} changed while being read`);
    }
    return { bytes, relative };
  } finally {
    await descriptor.close();
  }
}

async function rejectSymlinkAncestors(root, target, label) {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} path must not traverse a symlink`);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function parseInputJson(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} must be UTF-8 JSON`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
