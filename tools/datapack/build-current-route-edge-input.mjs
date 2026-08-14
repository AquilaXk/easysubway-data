#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";
import { canonicalCurrentStationLineInputJson } from "./build-current-station-line-accessibility.mjs";
import { applyCandidateNetworkEdgeProjection } from "./build-datapack.mjs";
import { canonicalStationLineAccessibilityJson } from "./materialize-station-line-accessibility.mjs";

const BUILD_SPEC_FILE = "tools/datapack/release/candidate-build-spec.json";
const CANONICAL_PACK_FILE = "tools/datapack/release/capital-production-canonical-pack.json";
const STATION_LINE_INPUT_FILE = "tools/datapack/release/current-station-line-accessibility/station-line-input.json";
const MATERIALIZATION_FILE = "tools/datapack/release/current-station-line-accessibility/station-line-accessibility.json";
const POLICY_FILE = "release/product-gates/route-edge-evaluation-policy.json";
const OUTPUT_DIRECTORY = "tools/datapack/release/current-route-edge-evaluation";
const OUTPUT_FILE = "route-edge-input.json";

export function buildCurrentRouteEdgeInput({ canonicalPack, buildSpec, stationLineInput, materialization, policy }) {
  const pack = canonicalCapitalPack(canonicalPack, buildSpec);
  const stationLines = projectStationLines(pack);
  const routeEdges = projectRouteEdges(pack);
  const candidate = {
    candidateId: buildSpec.candidateId,
    stationSetSha256: sha256(canonicalJson([...new Set(pack.stations.map(({ id }) => id))].sort(compareBytes))),
    sourceSetSha256: buildSpec.sourceSnapshotSetHash,
    policyVersion: policy?.policyVersion,
    evaluatorVersion: "1",
  };
  validateMaterialization({ stationLineInput, materialization, policy, candidate, stationLines, routeEdges });
  return canonicalObject({ candidate, stationLines, routeEdges });
}

export async function buildCurrentSourceRouteEdgeInput(input) {
  const canonicalPack = structuredClone(input.canonicalPack);
  await applyCandidateNetworkEdgeProjection(input.buildSpec, canonicalPack);
  return buildCurrentRouteEdgeInput({ ...input, canonicalPack });
}

export function canonicalCurrentRouteEdgeInputJson(value) {
  assertKeys(value, ["candidate", "stationLines", "routeEdges"], "current route-edge input keys");
  assertKeys(value.candidate, ["candidateId", "evaluatorVersion", "policyVersion", "sourceSetSha256", "stationSetSha256"], "current route-edge candidate keys");
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.routeEdges)) throw new Error("current route-edge arrays are required");
  return canonicalJson(value);
}

export async function main(argv, { repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)), log = console.log } = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error("current route-edge input arguments mismatch");
  const root = path.resolve(repositoryRoot);
  const output = path.join(root, OUTPUT_DIRECTORY);
  await outputMustBeAbsent(output);
  const [canonicalPack, buildSpec, stationLineInput, materialization, policy] = await Promise.all([
    readJson(path.join(root, CANONICAL_PACK_FILE)),
    readJson(path.join(root, BUILD_SPEC_FILE)),
    readCanonicalJson(path.join(root, STATION_LINE_INPUT_FILE), "station-line input", canonicalCurrentStationLineInputJson),
    readCanonicalJson(path.join(root, MATERIALIZATION_FILE), "station-line materialization", canonicalStationLineAccessibilityJson),
    readJson(path.join(root, POLICY_FILE)),
  ]);
  const result = await buildCurrentSourceRouteEdgeInput({
    canonicalPack,
    buildSpec,
    stationLineInput,
    materialization,
    policy,
  });
  const bytes = canonicalCurrentRouteEdgeInputJson(result);
  await publish(output, bytes);
  log(JSON.stringify({ stationLineCount: result.stationLines.length, routeEdgeCount: result.routeEdges.length, routeEdgeInputSha256: sha256(bytes) }));
  return result;
}

function canonicalCapitalPack(fixture, buildSpec) {
  if (buildSpec?.fixturePath !== CANONICAL_PACK_FILE || typeof buildSpec.candidateId !== "string" || !sha(buildSpec.sourceSnapshotSetHash)) throw new Error("current route-edge build identity mismatch");
  const packs = fixture?.packs?.filter(({ id }) => id === "capital") ?? [];
  if (packs.length !== 1 || !Array.isArray(packs[0].stations) || !Array.isArray(packs[0].lines) || !Array.isArray(packs[0].stationLines) || !Array.isArray(packs[0].networkEdges)) throw new Error("current route-edge canonical pack mismatch");
  return packs[0];
}

function projectStationLines(pack) {
  const operators = new Map(pack.lines.map((line) => [line.id, line.operatorId]));
  const result = pack.stationLines.map(({ stationId, lineId, lineSequence }) => {
    const operatorId = operators.get(lineId);
    if (![stationId, lineId, operatorId].every(nonBlank) || !Number.isSafeInteger(lineSequence) || lineSequence < 0) throw new Error("current route-edge station-line identity mismatch");
    return { stationId, lineId, operatorId, lineSequence };
  }).sort(compareStationLines);
  if (new Set(result.map(({ stationId, lineId }) => `${stationId}\u0000${lineId}`)).size !== result.length) throw new Error("current route-edge station-line identity mismatch");
  return result;
}

function projectRouteEdges(pack) {
  const result = pack.networkEdges.map((edge) => {
    const value = {
      edgeId: edge.id, edgeType: edge.edgeType, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId,
      durationSeconds: edge.durationSeconds, distanceMeters: edge.distanceMeters,
      servicePattern: edge.servicePattern ?? "", serviceClass: edge.serviceClass ?? "SUBWAY",
    };
    if (![value.edgeId, value.edgeType, value.fromNodeId, value.toNodeId, value.serviceClass].every(nonBlank)
      || !Number.isSafeInteger(value.durationSeconds) || value.durationSeconds < 0
      || !Number.isSafeInteger(value.distanceMeters) || value.distanceMeters < 0) throw new Error("current route-edge topology identity mismatch");
    return { ...value, edgeSha256: routeEdgeSha256(value) };
  }).sort((left, right) => compareBytes(left.edgeId, right.edgeId));
  if (new Set(result.map(({ edgeId }) => edgeId)).size !== result.length) throw new Error("current route-edge topology identity mismatch");
  return result;
}

function validateMaterialization({ stationLineInput, materialization, policy, candidate, stationLines, routeEdges }) {
  canonicalCurrentStationLineInputJson(stationLineInput);
  canonicalStationLineAccessibilityJson(materialization);
  if (canonicalJson(materialization.candidate) !== canonicalJson({ ...stationLineInput.candidate })
    || !["candidateId", "sourceSetSha256"].every((key) => materialization.candidate[key] === candidate[key])) throw new Error("current route-edge materialization candidate identity mismatch");
  const sourceLines = new Map(stationLines.map((line) => [`${line.stationId}\u0000${line.lineId}`, line]));
  const required = new Map();
  for (const edge of routeEdges) {
    const rule = policy?.edgeDomainMap?.[edge.edgeType];
    if (!rule || !Array.isArray(rule.domains)) throw new Error("current route-edge policy mismatch");
    if (edge.edgeType === "RIDE") {
      if (rule.endpointTarget !== "NONE" || rule.domains.length !== 0) throw new Error("current route-edge RIDE policy mismatch");
      continue;
    }
    for (const node of endpointNodes(edge, rule.endpointTarget)) {
      const line = sourceLines.get(nodeKey(node));
      if (!line) throw new Error("current route-edge endpoint identity mismatch");
      for (const domain of ["FACILITY", "EXIT", "TRANSFER"]) required.set(`${line.stationId}\u0000${line.lineId}\u0000${line.operatorId}\u0000${domain}`, { ...line, domain });
    }
  }
  const inputLines = stationLineInput.stationLines.map(({ stationId, lineId, operatorId }) => ({ stationId, lineId, operatorId })).sort(compareStationLines);
  const requiredLines = [...new Map([...required.values()].map(({ stationId, lineId, operatorId }) => [`${stationId}\u0000${lineId}`, { stationId, lineId, operatorId }])).values()].sort(compareStationLines);
  if (canonicalJson(inputLines) !== canonicalJson(requiredLines)) throw new Error("current route-edge materialization subset mismatch");
  const scopedStationSetSha256 = sha256(canonicalJson([...new Set(requiredLines.map(({ stationId }) => stationId))].sort(compareBytes)));
  if (stationLineInput.candidate.stationSetSha256 !== scopedStationSetSha256) throw new Error("current route-edge materialization station-set identity mismatch");
  const actual = new Map(materialization.rows.map((row) => [`${row.stationId}\u0000${row.lineId}\u0000${row.operatorId}\u0000${row.domain}`, row]));
  if (actual.size !== required.size || [...required.keys()].some((key) => !actual.has(key))) throw new Error("current route-edge materialization subset mismatch");
}

function endpointNodes(edge, target) {
  if (target === "TO") return [edge.toNodeId];
  if (target === "FROM") return [edge.fromNodeId];
  if (target === "BOTH") return [edge.fromNodeId, edge.toNodeId];
  throw new Error("current route-edge policy endpoint mismatch");
}
function nodeKey(nodeId) { const index = nodeId.lastIndexOf(":"); if (index <= 0) throw new Error("current route-edge endpoint identity mismatch"); return `${nodeId.slice(0, index)}\u0000${nodeId.slice(index + 1)}`; }
async function publish(output, bytes) { const parent = path.dirname(output); const directory = await lstat(parent); if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("route-edge output parent must be a directory"); const staging = await mkdtemp(path.join(parent, ".current-route-edge-")); try { await writeFile(path.join(staging, OUTPUT_FILE), bytes, { flag: "wx", mode: 0o600 }); await outputMustBeAbsent(output); await rename(staging, output); } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; } }
async function outputMustBeAbsent(file) { try { await lstat(file); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error("route-edge output must be absent"); }
async function readCanonicalJson(file, label, canonicalize = canonicalJson) { const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file)); const value = JSON.parse(source); if (source !== canonicalize(value)) throw new Error(`${label} bytes are not canonical`); return value; }
async function readJson(file) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file))); }
function assertKeys(value, expected, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some((key) => !(key in value))) throw new Error(`${label} mismatch`); }
function canonicalObject(value) { if (Array.isArray(value)) return value.map(canonicalObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])])); }
function canonicalJson(value) { return JSON.stringify(canonicalObject(value)); }
function compareBytes(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function compareStationLines(left, right) { return compareBytes(left.stationId, right.stationId) || compareBytes(left.lineId, right.lineId) || compareBytes(left.operatorId, right.operatorId); }
function nonBlank(value) { return typeof value === "string" && value.trim() !== ""; }
function sha(value) { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsScript) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
