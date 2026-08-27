#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCurrentCapitalStationLineInput, canonicalCurrentCapitalStationLineInputJson, readCurrentCapitalInputs } from "./build-current-capital-station-line-input.mjs";
import { canonicalRideEdgeSetSha256, routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";

const OUTPUT_DIRECTORY = "tools/datapack/release/current-capital-accessibility-full";
const ROUTE_STATION_LINE_COUNT = 1102;

export function buildCurrentCapitalRouteEdgeInput(input) {
  validateFixtureEdgeCounts(input.canonicalPack, { RIDE: 2208 }, "projected");
  const station = buildCurrentCapitalStationLineInput(input);
  const pack = input.canonicalPack.packs.find(({ id }) => id === "capital");
  const stationLines = routeStationLines(pack, station.stationLines);
  const rides = (pack.networkEdges ?? [])
    .filter(({ edgeType }) => edgeType === "RIDE")
    .map(normalizeRide);
  if (rides.length !== 2208 || new Set(rides.map(({ edgeId }) => edgeId)).size !== 2208) throw new Error("full-capital RIDE denominator mismatch");
  const entries = station.stationLines.map((line) => edge({ edgeId: `edge-entry-${line.stationId}-${line.lineId}`, edgeType: "ENTRY", fromNodeId: line.stationId, toNodeId: `${line.stationId}:${line.lineId}`, durationSeconds: 90, distanceMeters: 0 }));
  const exits = station.stationLines.map((line) => edge({ edgeId: `edge-exit-${line.stationId}-${line.lineId}`, edgeType: "EXIT", fromNodeId: `${line.stationId}:${line.lineId}`, toNodeId: line.stationId, durationSeconds: 60, distanceMeters: 0 }));
  // TRANSFER runtime cost is request-owned walking pace; the source duration remains metrics-only reference evidence.
  const transfers = input.transferMetrics.metrics.map((metric) => edge({ edgeId: `edge-transfer-${metric.stationId}-${metric.fromLineId}-${metric.toLineId}`, edgeType: "IN_STATION_TRANSFER", fromNodeId: `${metric.stationId}:${metric.fromLineId}`, toNodeId: `${metric.stationId}:${metric.toLineId}`, durationSeconds: 0, distanceMeters: metric.distanceMeters }));
  const routeEdges = [...rides, ...entries, ...exits, ...transfers].sort((left, right) => compareBytes(left.edgeId, right.edgeId));
  if (routeEdges.length !== 2664 || new Set(routeEdges.map(({ edgeId }) => edgeId)).size !== 2664 || entries.length !== 213 || exits.length !== 213 || transfers.length !== 30) throw new Error("full-capital route denominator mismatch");
  validateRouteEdgeEndpoints(routeEdges, stationLines);
  const candidate = { candidateId: station.candidate.candidateId, evaluatorVersion: "1", policyVersion: input.policy.policyVersion, sourceSetSha256: station.candidate.sourceSetSha256, stationSetSha256: station.candidate.stationSetSha256, topologySha256: canonicalRideEdgeSetSha256(rides) };
  return canonicalObject({ candidate, stationLines, routeEdges });
}

export function canonicalCurrentCapitalRouteEdgeInputJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compareBytes)) !== canonicalJson(["candidate", "routeEdges", "stationLines"])) throw new Error("full-capital route output keys mismatch");
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.routeEdges)) throw new Error("full-capital route arrays are required");
  return canonicalJson(value);
}

export async function main(argv = process.argv.slice(2), { repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)), log = console.log, readTransitionBoundaryImpl, readCurrentFanInBoundaryImpl, projectFixtureImpl = defaultProjectFixture } = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error("full-capital route arguments mismatch");
  const root = path.resolve(repositoryRoot); const output = path.join(root, OUTPUT_DIRECTORY);
  await outputMustBeAbsent(output);
  const input = await readCurrentCapitalInputs(root, { readTransitionBoundaryImpl, readCurrentFanInBoundaryImpl });
  validateFixtureEdgeCounts(input.canonicalPack, { RIDE: 2200 }, "raw");
  const projectedFixture = await projectFixtureImpl({
    buildSpec: input.candidateBuildSpec,
    sourceFixture: input.canonicalPack,
    repositoryRoot: root,
  });
  validateFixtureEdgeCounts(projectedFixture, { RIDE: 2208 }, "projected");
  const projectedInput = { ...input, canonicalPack: projectedFixture };
  const station = buildCurrentCapitalStationLineInput(projectedInput);
  const route = buildCurrentCapitalRouteEdgeInput(projectedInput);
  await publish(output, canonicalCurrentCapitalStationLineInputJson(station), canonicalCurrentCapitalRouteEdgeInputJson(route));
  log(JSON.stringify({ stationLineCount: station.stationLines.length, routeEdgeCount: route.routeEdges.length }));
  return { station, route };
}

async function defaultProjectFixture({ buildSpec, sourceFixture, repositoryRoot }) {
  const { projectCandidateFixtureForAccessibilityAuthority } = await import("./build-datapack.mjs");
  return projectCandidateFixtureForAccessibilityAuthority({
    buildSpec,
    sourceFixture,
    repositoryRoot,
  });
}

function validateFixtureEdgeCounts(fixture, expected, label) {
  const packs = fixture?.packs?.filter(({ id }) => id === "capital") ?? [];
  if (fixture?.manifest?.channel !== "production"
    || fixture.manifest?.activePack?.id !== "capital"
    || packs.length !== 1
    || !Array.isArray(packs[0].networkEdges)) {
    throw new Error(`full-capital ${label} fixture mismatch`);
  }
  const counts = Object.create(null);
  for (const { edgeType } of packs[0].networkEdges) {
    counts[edgeType] = (counts[edgeType] ?? 0) + 1;
  }
  const total = Object.values(expected).reduce((sum, count) => sum + count, 0);
  if (packs[0].networkEdges.length !== total
    || Object.keys(counts).length !== Object.keys(expected).length
    || Object.entries(expected).some(([type, count]) => counts[type] !== count)) {
    throw new Error(`full-capital ${label} edge denominator mismatch`);
  }
}

function normalizeRide(value) { if (value?.edgeType !== "RIDE" || ![value.id, value.fromNodeId, value.toNodeId].every(nonBlank) || !Number.isSafeInteger(value.durationSeconds) || value.durationSeconds < 0 || !Number.isSafeInteger(value.distanceMeters) || value.distanceMeters < 0) throw new Error("full-capital RIDE schema mismatch"); return edge({ edgeId: value.id, edgeType: value.edgeType, fromNodeId: value.fromNodeId, toNodeId: value.toNodeId, durationSeconds: value.durationSeconds, distanceMeters: value.distanceMeters, serviceClass: value.serviceClass ?? "SUBWAY", servicePattern: value.servicePattern ?? "LOCAL" }); }

function routeStationLines(pack, inputLines) {
  const operatorByLine = new Map();
  for (const line of pack?.lines ?? []) {
    if (!nonBlank(line?.id) || !nonBlank(line.operatorId) || operatorByLine.has(line.id)) {
      throw new Error("full-capital route line identity mismatch");
    }
    operatorByLine.set(line.id, line.operatorId);
  }
  const indexed = new Map();
  const result = (pack?.stationLines ?? []).map(({ stationId, lineId, lineSequence }) => {
    const key = `${stationId}\0${lineId}`;
    const operatorId = operatorByLine.get(lineId);
    if (!nonBlank(stationId) || !nonBlank(lineId) || !nonBlank(operatorId)
      || !Number.isSafeInteger(lineSequence) || lineSequence < 0 || indexed.has(key)) {
      throw new Error("full-capital route station-line mismatch");
    }
    const normalized = { stationId, lineId, operatorId, lineSequence };
    indexed.set(key, normalized);
    return normalized;
  });
  if (result.length !== ROUTE_STATION_LINE_COUNT || indexed.size !== ROUTE_STATION_LINE_COUNT) {
    throw new Error("full-capital route station-line denominator mismatch");
  }
  for (const line of inputLines) {
    const routeLine = indexed.get(`${line.stationId}\0${line.lineId}`);
    if (routeLine?.operatorId !== line.operatorId) {
      throw new Error("full-capital accessibility station-line subset mismatch");
    }
  }
  return result.sort(compareStationLines);
}

function validateRouteEdgeEndpoints(routeEdges, stationLines) {
  const stationIds = new Set(stationLines.map(({ stationId }) => stationId));
  const stationLineKeys = new Set(stationLines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  for (const edgeValue of routeEdges) {
    for (const nodeId of [edgeValue.fromNodeId, edgeValue.toNodeId]) {
      const segments = String(nodeId).split(":");
      const isItxExpress = segments.length === 3
        && segments[2] === "EXPRESS"
        && edgeValue.edgeType === "RIDE"
        && edgeValue.serviceClass === "ITX_CHEONGCHUN"
        && edgeValue.servicePattern === "EXPRESS";
      if (segments.includes("")
        || segments.length > 3
        || (segments.length === 3 && !isItxExpress)
        || (segments.length === 1 && !stationIds.has(segments[0]))
        || (segments.length >= 2 && !stationLineKeys.has(`${segments[0]}\0${segments[1]}`))) {
        throw new Error("full-capital route endpoint mismatch");
      }
    }
  }
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId) || compareBytes(left.lineId, right.lineId);
}
function edge(value) { const normalized = { edgeId: value.edgeId, edgeType: value.edgeType, fromNodeId: value.fromNodeId, toNodeId: value.toNodeId, durationSeconds: value.durationSeconds, distanceMeters: value.distanceMeters, servicePattern: value.servicePattern ?? "", serviceClass: value.serviceClass ?? "SUBWAY" }; return { ...normalized, edgeSha256: routeEdgeSha256(normalized) }; }
async function publish(output, stationBytes, routeBytes) { const parent = path.dirname(output); const parentStat = await lstat(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("full-capital output parent mismatch"); const staging = await mkdtemp(path.join(parent, ".current-capital-accessibility-full-")); try { await writeFile(path.join(staging, "station-line-input.json"), stationBytes, { flag: "wx", mode: 0o600 }); await writeFile(path.join(staging, "route-edge-input.json"), routeBytes, { flag: "wx", mode: 0o600 }); await outputMustBeAbsent(output); const finalParent = await lstat(parent); if (parentStat.dev !== finalParent.dev || parentStat.ino !== finalParent.ino || !finalParent.isDirectory() || finalParent.isSymbolicLink()) throw new Error("full-capital output parent changed"); await rename(staging, output); } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; } }
async function outputMustBeAbsent(target) { try { await lstat(target); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error("full-capital output directory must be absent"); }
function canonicalObject(value) { if (Array.isArray(value)) return value.map(canonicalObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])])); }
function canonicalJson(value) { return JSON.stringify(canonicalObject(value)); }
function compareBytes(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function nonBlank(value) { return typeof value === "string" && value.trim() !== ""; }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
