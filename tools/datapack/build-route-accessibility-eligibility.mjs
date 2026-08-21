#!/usr/bin/env node
import { lstat, link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildServerRouteBundleFinalEvidence } from "./build-server-route-bundle-final.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { parseArgs, requiredArg } from "./lib/cli-args.mjs";
import { validateServerRouteBundleFinal } from "./lib/server-route-bundle-final.mjs";

const PREPUBLICATION_FILES = [
  "artifact-inventory.json",
  "route-edge-evaluation.json",
  "server-route-bundle-final.json",
  "source-freshness.json",
  "station-line-accessibility.json",
];
const OWNER_GATES = ["sourceFreshness", "stationLineAccessibility", "routeEdgeEvaluation", "artifactInventory"];
const STATION_UNRESOLVED = ["UNKNOWN", "MISSING", "STALE"];
const ROUTE_UNRESOLVED = ["UNKNOWN", "MISSING", "STALE", "NOT_EVALUATED"];

export async function buildRouteAccessibilityEligibility(input) {
  const prepublicationRoot = await realDirectory(input.prepublicationRoot, "prepublication root");
  const artifactRoot = await realDirectory(input.artifactRoot, "artifact root");
  const output = path.resolve(required(input.output, "output"));
  await requireAbsent(output);
  const outputParent = await realDirectory(path.dirname(output), "output parent");
  const stationLineInput = await readCanonicalRegular(input.stationLineInput, "station line input");
  const routeEdgeInput = await readCanonicalRegular(input.routeEdgeInput, "route edge input");
  const supplied = Object.fromEntries(await Promise.all(PREPUBLICATION_FILES.map(async (name) => [
    name,
    await readCanonicalRegular(path.join(prepublicationRoot, name), name),
  ])));

  const temporaryRoot = await mkdtemp(path.join(outputParent, ".route-accessibility-reprojection-"));
  try {
    const reprojectionRoot = path.join(temporaryRoot, "prepublication");
    await buildServerRouteBundleFinalEvidence({
      repositoryRoot: input.repositoryRoot ?? process.cwd(),
      artifactRoot,
      stationLineInput: JSON.parse(stationLineInput),
      routeEdgeInput: JSON.parse(routeEdgeInput),
      repositoryGitSha: required(input.repositoryGitSha, "repository git sha"),
      evaluationAt: required(input.evaluationAt, "evaluation at"),
      output: reprojectionRoot,
    });
    const reproduced = Object.fromEntries(await Promise.all(PREPUBLICATION_FILES.map(async (name) => [
      name,
      await readCanonicalRegular(path.join(reprojectionRoot, name), `reprojected ${name}`),
    ])));
    for (const name of PREPUBLICATION_FILES) {
      if (!supplied[name].equals(reproduced[name])) throw new Error(`prepublication ${name} mismatch`);
    }
    const final = validateServerRouteBundleFinal(JSON.parse(supplied["server-route-bundle-final.json"]));
    const station = JSON.parse(supplied["station-line-accessibility.json"]);
    const route = JSON.parse(supplied["route-edge-evaluation.json"]);
    const report = deriveAccessibilityEligibility({
      final,
      station,
      route,
      stationEvidenceBytes: supplied["station-line-accessibility.json"],
      routeEvidenceBytes: supplied["route-edge-evaluation.json"],
    });
    await writeNewAtomic(output, Buffer.from(canonicalJson(report)));
    return report;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function deriveAccessibilityEligibility({ final, station, route, stationEvidenceBytes, routeEvidenceBytes }) {
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
        evidenceSha256: sha256(stationEvidenceBytes),
      },
      routeEdgeEvaluation: {
        edgeCount: route.results.length,
        stateSummary: route.stateSummary,
        evaluationDigest: route.evaluationDigest,
        evidenceSha256: sha256(routeEvidenceBytes),
      },
      blockers: [...new Set(blockers)],
    };
  return { ...payload, eligibilitySha256: sha256(Buffer.from(canonicalJson(payload))) };
}

async function readCanonicalRegular(target, label) {
  let stat;
  try { stat = await lstat(target); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`${label} must be a non-empty regular non-symlink`);
  const bytes = await readFile(target);
  if (!bytes.equals(Buffer.from(canonicalJson(JSON.parse(bytes))))) throw new Error(`${label} must be canonical JSON`);
  return bytes;
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

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function bytewise(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expected = ["prepublication-root", "artifact-root", "station-line-input", "route-edge-input", "repository-git-sha", "evaluation-at", "output"];
  if (args.size !== expected.length || expected.some((name) => !args.has(name))) throw new Error("CLI arguments mismatch");
  await buildRouteAccessibilityEligibility({
    prepublicationRoot: requiredArg(args, "prepublication-root"),
    artifactRoot: requiredArg(args, "artifact-root"),
    stationLineInput: requiredArg(args, "station-line-input"),
    routeEdgeInput: requiredArg(args, "route-edge-input"),
    repositoryGitSha: requiredArg(args, "repository-git-sha"),
    evaluationAt: requiredArg(args, "evaluation-at"),
    output: requiredArg(args, "output"),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
