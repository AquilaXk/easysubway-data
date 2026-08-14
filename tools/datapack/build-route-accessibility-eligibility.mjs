#!/usr/bin/env node
import { lstat, link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { parseArgs, requiredArg } from "./lib/cli-args.mjs";
import { validateServerRouteBundleFinal } from "./lib/server-route-bundle-final.mjs";

const FILES = [
  "server-route-bundle-final.json",
  "station-line-accessibility.json",
  "route-edge-evaluation.json",
];
const OWNER_GATES = ["sourceFreshness", "stationLineAccessibility", "routeEdgeEvaluation", "artifactInventory"];
const STATION_UNRESOLVED = ["UNKNOWN", "MISSING", "STALE"];
const ROUTE_UNRESOLVED = ["UNKNOWN", "MISSING", "STALE", "NOT_EVALUATED"];
const STATION_STATES = ["VERIFIED_PRESENT", "VERIFIED_ABSENT", "NOT_APPLICABLE", ...STATION_UNRESOLVED];
const DOMAINS = ["FACILITY", "EXIT", "TRANSFER"];
const STATION_CANDIDATE_KEYS = ["candidateId", "stationSetSha256", "sourceSetSha256", "mappingContractVersion", "materializerVersion"];
const STATION_ROW_KEYS = [
  ...STATION_CANDIDATE_KEYS, "stationId", "lineId", "operatorId", "domain", "state", "sourceId", "sourceSnapshotId",
  "evidenceRawSha256", "providerRecordHash", "capturedAt", "freshUntil", "provenanceId", "licenseId", "evidenceKind", "evidenceReason",
];
const ROUTE_CANDIDATE_KEYS = ["candidateId", "stationSetSha256", "sourceSetSha256", "topologySha256", "policyVersion", "evaluatorVersion"];
const ROUTE_RESULT_KEYS = [
  "edgeId", "edgeType", "from", "to", "servicePattern", "serviceClass", "requiredDomains", "state", "reason", "rawEdgeSha256",
  "materializationDigest", "materializationCells", "topologySha256", "policyVersion", "evaluatorVersion", "evaluationAt", "evidenceSha256",
];

export async function buildRouteAccessibilityEligibility({ prepublicationRoot, output }) {
  const root = await realDirectory(prepublicationRoot, "prepublication root");
  const outputPath = path.resolve(required(output, "output"));
  await requireAbsent(outputPath);
  await realDirectory(path.dirname(outputPath), "output parent");

  const evidence = Object.fromEntries(await Promise.all(FILES.map(async (name) => {
    const bytes = await readCanonicalRegular(path.join(root, name), name);
    return [name, { bytes, value: JSON.parse(bytes) }];
  })));
  const final = validateFinal(evidence["server-route-bundle-final.json"]);
  const station = validateStation(evidence["station-line-accessibility.json"], final);
  const route = validateRoute(evidence["route-edge-evaluation.json"], final, station);

  const blockers = [
    ...OWNER_GATES.filter((gate) => final.gates[gate].state !== "PASS").map((gate) => `${gate}:${final.gates[gate].state}`),
    ...STATION_UNRESOLVED.filter((state) => station.stateSummary[state] !== 0).map((state) => `stationLineAccessibility:${state}`),
    ...ROUTE_UNRESOLVED.filter((state) => route.stateSummary[state] !== 0).map((state) => `routeEdgeEvaluation:${state}`),
    ...(route.eligible ? [] : ["routeEdgeEvaluation:INELIGIBLE"]),
  ].sort(bytewise);
  const payload = {
    schemaVersion: 1,
    artifactKind: "route-accessibility-eligibility",
    decision: blockers.length === 0 ? "ELIGIBLE" : "INELIGIBLE",
    candidate: final.candidate,
    stationLineAccessibility: {
      rowCount: station.rows.length,
      stateSummary: station.stateSummary,
      materializationDigest: station.materializationDigest,
      evidenceSha256: sha256(evidence["station-line-accessibility.json"].bytes),
    },
    routeEdgeEvaluation: {
      edgeCount: route.results.length,
      stateSummary: route.stateSummary,
      evaluationDigest: route.evaluationDigest,
      evidenceSha256: sha256(evidence["route-edge-evaluation.json"].bytes),
    },
    blockers: [...new Set(blockers)],
  };
  const report = { ...payload, eligibilitySha256: sha256(Buffer.from(canonicalJson(payload))) };
  await writeNewAtomic(outputPath, Buffer.from(canonicalJson(report)));
  return report;
}

function validateFinal(entry) {
  const value = entry.value;
  if (!entry.bytes.equals(Buffer.from(canonicalJson(value)))) throw new Error("server-route-bundle-final.json must be canonical JSON");
  const final = validateServerRouteBundleFinal(value);
  for (const gate of OWNER_GATES) {
    if (final.gates[gate].evidenceSha256 === null) throw new Error(`${gate} evidence is missing`);
  }
  return final;
}

function validateStation(entry, final) {
  const value = entry.value;
  if (!entry.bytes.equals(Buffer.from(canonicalJson(value)))) throw new Error("station-line-accessibility.json must be canonical JSON");
  exactKeys(value, ["candidate", "rows", "stateSummary", "materializationDigest"], "station line accessibility");
  exactKeys(value.candidate, STATION_CANDIDATE_KEYS, "station line accessibility candidate");
  if (!Array.isArray(value.rows) || value.rows.length !== 6) throw new Error("station line accessibility row count mismatch");
  if (sha256(Buffer.from(canonicalJson({ candidate: value.candidate, rows: value.rows, stateSummary: value.stateSummary }))) !== value.materializationDigest) {
    throw new Error("station line accessibility digest mismatch");
  }
  if (sha256(entry.bytes) !== final.gates.stationLineAccessibility.evidenceSha256) throw new Error("station line accessibility raw digest mismatch");
  if (value.candidate?.candidateId !== final.candidate.bundleId || value.candidate?.sourceSetSha256 !== final.candidate.sourceSnapshotSetHash) {
    throw new Error("station line accessibility candidate mismatch");
  }
  const stateSummary = exactSummary(value.rows, value.stateSummary, STATION_STATES, "station line accessibility");
  const cells = new Set();
  const lines = new Set();
  let previous = null;
  for (const row of value.rows) {
    exactKeys(row, STATION_ROW_KEYS, "station line accessibility row");
    for (const key of STATION_CANDIDATE_KEYS) {
      if (row[key] !== value.candidate[key]) throw new Error("station line accessibility row identity mismatch");
    }
    for (const key of ["sourceId", "sourceSnapshotId", "evidenceRawSha256", "providerRecordHash", "provenanceId"]) {
      if (row.state === "MISSING" ? row[key] !== null : typeof row[key] !== "string" || row[key].trim() === "") {
        throw new Error("station line accessibility lineage mismatch");
      }
    }
    const cell = stationCellKey(row);
    if (cells.has(cell)) throw new Error("duplicate station line accessibility cell");
    if (previous !== null && bytewise(previous, cell) >= 0) throw new Error("station line accessibility row order mismatch");
    cells.add(cell);
    lines.add(`${row.stationId}\u0000${row.lineId}\u0000${row.operatorId}`);
    previous = cell;
    if (row.candidateId !== value.candidate.candidateId || row.stationSetSha256 !== value.candidate.stationSetSha256 || row.sourceSetSha256 !== value.candidate.sourceSetSha256) {
      throw new Error("station line accessibility row identity mismatch");
    }
  }
  if (lines.size !== 2 || cells.size !== 6 || [...lines].some((line) => DOMAINS.some((domain) => !cells.has(`${line}\u0000${domain}`)))) {
    throw new Error("station line accessibility canonical cell denominator mismatch");
  }
  const scopedStationSet = sha256(Buffer.from(canonicalJson(value.rows.map((row) => row.stationId).filter((id, index, ids) => ids.indexOf(id) === index).sort(bytewise))));
  if (value.candidate.stationSetSha256 !== scopedStationSet) throw new Error("station line accessibility scoped station set mismatch");
  return { ...value, stateSummary, cells: new Map(value.rows.map((row) => [stationCellKey(row), row])) };
}

function validateRoute(entry, final, station) {
  const value = entry.value;
  if (!entry.bytes.equals(Buffer.from(canonicalJson(value)))) throw new Error("route-edge-evaluation.json must be canonical JSON");
  exactKeys(value, ["candidate", "evaluationAt", "denominator", "results", "stateSummary", "eligible", "evaluationDigest"], "route edge evaluation");
  exactKeys(value.candidate, ROUTE_CANDIDATE_KEYS, "route edge evaluation candidate");
  if (!Array.isArray(value.results) || value.results.length !== 2224 || value.denominator?.edgeCount !== 2224) throw new Error("route edge evaluation denominator mismatch");
  if (sha256(Buffer.from(canonicalJson({ candidate: value.candidate, evaluationAt: value.evaluationAt, denominator: value.denominator, results: value.results, stateSummary: value.stateSummary, eligible: value.eligible }))) !== value.evaluationDigest) {
    throw new Error("route edge evaluation digest mismatch");
  }
  if (sha256(entry.bytes) !== final.gates.routeEdgeEvaluation.evidenceSha256) throw new Error("route edge evaluation raw digest mismatch");
  if (value.candidate?.candidateId !== final.candidate.bundleId
    || value.candidate?.sourceSetSha256 !== final.candidate.sourceSnapshotSetHash
    || value.candidate?.stationSetSha256 !== final.candidate.stationSetSha256
    || value.candidate?.topologySha256 !== final.candidate.componentDigests.topology) {
    throw new Error("route edge evaluation candidate mismatch");
  }
  const stateSummary = exactSummary(value.results, value.stateSummary, ["PASS", "BLOCKED", "NOT_APPLICABLE", ...ROUTE_UNRESOLVED], "route edge evaluation");
  if (typeof value.eligible !== "boolean" || !isSha(value.denominator.digest)) throw new Error("route edge evaluation shape mismatch");
  const edgeIds = new Set();
  let previous = null;
  for (const result of value.results) {
    exactKeys(result, ROUTE_RESULT_KEYS, "route edge evaluation result");
    if (typeof result.edgeId !== "string" || result.edgeId.trim() === "" || edgeIds.has(result.edgeId)) throw new Error("route edge evaluation edge identity mismatch");
    if (previous !== null && bytewise(previous, result.edgeId) >= 0) throw new Error("route edge evaluation result order mismatch");
    if (!isSha(result.rawEdgeSha256) || !isSha(result.evidenceSha256) || result.materializationDigest !== station.materializationDigest
      || result.topologySha256 !== value.candidate.topologySha256 || result.policyVersion !== value.candidate.policyVersion
      || result.evaluatorVersion !== value.candidate.evaluatorVersion || result.evaluationAt !== value.evaluationAt) {
      throw new Error("route edge evaluation result identity mismatch");
    }
    if (!Array.isArray(result.materializationCells)) throw new Error("route edge evaluation cells mismatch");
    for (const cell of result.materializationCells) {
      const key = stationCellKey(cell);
      exactKeys(cell, [...STATION_ROW_KEYS, "effectiveState"], "route edge evaluation materialization cell");
      const stationRow = station.cells.get(key);
      const effectiveState = cell.effectiveState;
      if (!stationRow || canonicalJson(Object.fromEntries(Object.entries(cell).filter(([key]) => key !== "effectiveState"))) !== canonicalJson(stationRow)
        || !STATION_STATES.includes(effectiveState)
        || (effectiveState !== cell.state && effectiveState !== "STALE")) {
        throw new Error("route edge evaluation materialization cell mismatch");
      }
    }
    const withoutEvidence = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "evidenceSha256"));
    if (sha256(Buffer.from(canonicalJson(withoutEvidence))) !== result.evidenceSha256) throw new Error("route edge evaluation evidence digest mismatch");
    edgeIds.add(result.edgeId);
    previous = result.edgeId;
  }
  const denominatorDigest = sha256(Buffer.from(canonicalJson(value.results.map((result) => ({ edgeId: result.edgeId, edgeSha256: result.rawEdgeSha256 })) )));
  if (denominatorDigest !== value.denominator.digest) throw new Error("route edge evaluation denominator digest mismatch");
  const expectedEligible = ROUTE_UNRESOLVED.every((state) => stateSummary[state] === 0);
  if (value.eligible !== expectedEligible) throw new Error("route edge evaluation eligible mismatch");
  return { ...value, stateSummary };
}

function exactSummary(rows, summary, states, label) {
  exactKeys(summary, states, `${label} state summary`);
  const expected = Object.fromEntries(states.map((state) => [state, 0]));
  for (const row of rows) {
    if (!Object.hasOwn(expected, row.state)) throw new Error(`${label} state mismatch`);
    expected[row.state] += 1;
  }
  if (canonicalJson(expected) !== canonicalJson(summary)) throw new Error(`${label} state summary mismatch`);
  return summary;
}

async function readCanonicalRegular(target, label) {
  let stat;
  try { stat = await lstat(target); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`${label} must be a non-empty regular non-symlink`);
  return readFile(target);
}

async function realDirectory(target, label) {
  const resolved = path.resolve(required(target, label));
  let stat;
  try { stat = await lstat(resolved); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return resolved;
}

async function requireAbsent(target) {
  try { await lstat(target); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output must not already exist");
}

async function writeNewAtomic(target, bytes) {
  const temp = await mkdtemp(path.join(path.dirname(target), ".route-accessibility-eligibility-"));
  const staged = path.join(temp, "report.json");
  try {
    await writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
    await link(staged, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(bytewise)) !== canonicalJson([...keys].sort(bytewise))) {
    throw new Error(`${label} keys mismatch`);
  }
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function bytewise(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function stationCellKey(value) { return `${value.stationId}\u0000${value.lineId}\u0000${value.operatorId}\u0000${value.domain}`; }
function isSha(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.size !== 2 || !args.has("prepublication-root") || !args.has("output")) throw new Error("CLI arguments mismatch");
  await buildRouteAccessibilityEligibility({
    prepublicationRoot: requiredArg(args, "prepublication-root"),
    output: requiredArg(args, "output"),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
