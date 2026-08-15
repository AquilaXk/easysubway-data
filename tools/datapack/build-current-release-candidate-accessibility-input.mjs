#!/usr/bin/env node
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { canonicalStationLineAccessibilityPayloadJson } from "./materialize-station-line-accessibility.mjs";
import { routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";

const CANDIDATE_KEYS = ["candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion"];
const ROW_KEYS = ["candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion", "stationId", "lineId", "operatorId", "domain", "state", "sourceId", "sourceSnapshotId", "evidenceRawSha256", "providerRecordHash", "capturedAt", "freshUntil", "provenanceId", "licenseId", "evidenceKind", "evidenceReason"];
const EDGE_KEYS = ["edgeId", "edgeType", "fromNodeId", "toNodeId", "durationSeconds", "distanceMeters", "servicePattern", "serviceClass", "edgeSha256"];

export function buildCurrentReleaseCandidateAccessibilityAuthority({ canonicalPack, buildSpec, materialization, route }) {
  if (buildSpec?.candidate !== undefined) throw new Error("candidate build spec identity mismatch");
  const candidate = { candidateId: buildSpec?.candidateId, sourceSetSha256: buildSpec?.sourceSnapshotSetHash };
  const edges = validateRoute(route, candidate);
  validateMaterialization(materialization, candidate, edges);
  const packEdges = canonicalPack.networkEdges ?? canonicalPack.packs?.find(({ id }) => id === "capital")?.networkEdges;
  if (!Array.isArray(packEdges)) throw new Error("canonical pack edges missing");
  const authorityEdges = edges.map((edge) => {
    const matches = packEdges.filter(({ id }) => id === edge.edgeId);
    const pack = matches[0];
    if (matches.length !== 1 || !pack || pack.edgeType !== edge.edgeType || pack.fromNodeId !== edge.fromNodeId || pack.toNodeId !== edge.toNodeId || pack.durationSeconds !== edge.durationSeconds || pack.distanceMeters !== edge.distanceMeters
      || pack.verificationStatus !== "NOT_VERIFIED" || pack.stairAccessState !== "UNKNOWN" || !["UNKNOWN", "NO_OFFICIAL_FEED"].includes(pack.accessibilityStatus)) throw new Error("canonical route edge mismatch");
    const [stationId, lineId] = (edge.edgeType === "ENTRY" ? edge.toNodeId : edge.fromNodeId).split(":");
    const domain = edge.edgeType === "ENTRY" ? "FACILITY" : "EXIT";
    const rowMatches = materialization.rows.filter((row) => `${row.stationId}\u0000${row.lineId}\u0000${row.domain}` === `${stationId}\u0000${lineId}\u0000${domain}`);
    if (rowMatches.length !== 1 || rowMatches[0].state !== "VERIFIED_PRESENT") throw new Error("terminal accessibility evidence required");
    return { edgeId: edge.edgeId, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId, edgeType: edge.edgeType, durationSeconds: edge.durationSeconds, distanceMeters: edge.distanceMeters, domain };
  });
  const payload = { schemaVersion: 1, artifactKind: "server-route-coverage-authority", candidate, edges: authorityEdges };
  return { ...payload, authoritySha256: sha256(Buffer.from(canonicalJson(payload))) };
}

function validateMaterialization(value, buildCandidate, edges) {
  exact(value, ["candidate", "rows", "stateSummary", "materializationDigest"], "materialization");
  exact(value.candidate, CANDIDATE_KEYS, "materialization candidate");
  if (value.candidate.candidateId !== buildCandidate.candidateId || value.candidate.sourceSetSha256 !== buildCandidate.sourceSetSha256) throw new Error("candidate identity mismatch");
  if (!Array.isArray(value.rows)) throw new Error("materialization rows are invalid");
  const targets = new Map(edges.map((edge) => {
    const [stationId, lineId] = (edge.edgeType === "ENTRY" ? edge.toNodeId : edge.fromNodeId).split(":");
    return [`${stationId}\0${lineId}`, { stationId, lineId }];
  }));
  if (targets.size !== 2 || value.rows.length !== 6) throw new Error("materialization denominator mismatch");
  const expected = new Set([...targets.values()].flatMap(({ stationId, lineId }) => ["FACILITY", "EXIT", "TRANSFER"].map((domain) => `${stationId}\0${lineId}\0${domain}`)));
  const seen = new Set();
  const summary = { VERIFIED_PRESENT: 0, VERIFIED_ABSENT: 0, NOT_APPLICABLE: 0, UNKNOWN: 0, MISSING: 0, STALE: 0 };
  for (const row of value.rows) {
    exact(row, ROW_KEYS, "materialization row");
    if (CANDIDATE_KEYS.some((key) => row[key] !== value.candidate[key])) throw new Error("materialization row identity mismatch");
    const key = `${row.stationId}\0${row.lineId}\0${row.domain}`;
    if (!expected.has(key) || seen.has(key) || !Object.hasOwn(summary, row.state)) throw new Error("materialization denominator mismatch");
    seen.add(key); summary[row.state] += 1;
  }
  if (seen.size !== expected.size || canonicalJson(summary) !== canonicalJson(value.stateSummary)
    || value.materializationDigest !== sha256(canonicalStationLineAccessibilityPayloadJson(value))) throw new Error("materialization digest mismatch");
}

function validateRoute(value, buildCandidate) {
  exact(value, ["candidate", "stationLines", "routeEdges"], "route seed");
  exact(value.candidate, ["candidateId", "stationSetSha256", "sourceSetSha256", "policyVersion", "evaluatorVersion"], "route candidate");
  if (value.candidate.candidateId !== buildCandidate.candidateId || value.candidate.sourceSetSha256 !== buildCandidate.sourceSetSha256 || !Array.isArray(value.routeEdges)) throw new Error("candidate identity mismatch");
  const ids = new Set();
  for (const edge of value.routeEdges) {
    exact(edge, EDGE_KEYS, "route edge");
    if (ids.has(edge.edgeId) || edge.edgeSha256 !== routeEdgeSha256(Object.fromEntries(EDGE_KEYS.filter((key) => key !== "edgeSha256").map((key) => [key, edge[key]])))) throw new Error("route edge hash mismatch");
    ids.add(edge.edgeId);
  }
  const nonRide = value.routeEdges.filter((edge) => edge.edgeType !== "RIDE");
  if (nonRide.length !== 4 || nonRide.filter((edge) => edge.edgeType === "ENTRY").length !== 2 || nonRide.filter((edge) => edge.edgeType === "EXIT").length !== 2) throw new Error("route edge coverage mismatch");
  return nonRide;
}

function exact(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} shape mismatch`); }

async function main(argv) {
  if (argv.length !== 10) throw new Error("CLI arguments mismatch");
  const args = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [argv[i * 2]?.replace(/^--/, ""), argv[(i * 2) + 1]]));
  if (["fixture", "build-spec", "station-line-input", "route-edge-input", "output"].some((key) => !args[key])) throw new Error("CLI arguments mismatch");
  const output = path.resolve(args.output); try { await lstat(output); throw new Error("output must be absent"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const [canonicalPack, buildSpec, materialization, route] = await Promise.all([args.fixture, args["build-spec"], args["station-line-input"], args["route-edge-input"]].map(async (file) => JSON.parse(await readFile(path.resolve(file), "utf8"))));
  await writeFile(output, Buffer.from(canonicalJson(buildCurrentReleaseCandidateAccessibilityAuthority({ canonicalPack, buildSpec, materialization, route }))), { flag: "wx", mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
