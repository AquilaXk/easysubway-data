#!/usr/bin/env node
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readAdmittedItxRideEdgeSetSha256 } from "./apply-itx-topology-to-bundled-pack.mjs";
import { canonicalRideEdgeSetSha256, routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";

export const CURRENT_ROUTE_EDGE_INPUT =
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json";
const SHA = /^[a-f0-9]{64}$/u;

export function syncCurrentRouteEdgePolicy(input, policy, admittedItxRideEdgeSetSha256) {
  if (!input || typeof input !== "object" || !input.candidate || !Array.isArray(input.routeEdges)
    || typeof input.candidate.policyVersion !== "string" || input.candidate.policyVersion !== policy?.policyVersion
    || !SHA.test(admittedItxRideEdgeSetSha256 ?? "")) {
    throw new Error("route edge policy identity mismatch");
  }
  const ids = new Set();
  const local = [];
  const itx = [];
  for (const edge of input.routeEdges) {
    if (!edge || typeof edge.edgeId !== "string" || ids.has(edge.edgeId)
      || edge.edgeSha256 !== routeEdgeSha256(Object.fromEntries(Object.entries(edge).filter(([key]) => key !== "edgeSha256")))) {
      throw new Error("route edge hash mismatch");
    }
    ids.add(edge.edgeId);
    if (edge.edgeType !== "RIDE") continue;
    if (edge.serviceClass === "SUBWAY" && edge.servicePattern === "LOCAL") local.push(edge);
    else if (edge.serviceClass === "ITX_CHEONGCHUN" && edge.servicePattern === "EXPRESS") itx.push(edge);
    else throw new Error("RIDE partition is invalid");
  }
  if (local.length + itx.length !== input.routeEdges.filter(({ edgeType }) => edgeType === "RIDE").length
    || !policy.rideInvariant?.subwayLocal || !policy.rideInvariant?.itxCheongchunExpress) {
    throw new Error("RIDE partition is invalid");
  }
  if (canonicalRideEdgeSetSha256(itx) !== admittedItxRideEdgeSetSha256) {
    throw new Error("ITX EXPRESS edge set identity mismatch");
  }
  const next = structuredClone(policy);
  next.rideInvariant.subwayLocal.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256(local);
  next.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256 = admittedItxRideEdgeSetSha256;
  return next;
}

export async function syncCurrentRouteEdgePolicyFile({
  repositoryRoot,
  inputPath,
  policyPath,
  outputPath = policyPath,
  readAdmittedItxRideEdgeSetSha256Impl = readAdmittedItxRideEdgeSetSha256,
}) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw new Error("repository root must be absolute");
  }
  if (path.resolve(policyPath) !== path.resolve(outputPath)) throw new Error("policy output path must match input path");
  const [inputMetadata, policyMetadata] = await Promise.all([lstat(inputPath), lstat(policyPath)]);
  if (!inputMetadata.isFile() || inputMetadata.isSymbolicLink() || !policyMetadata.isFile() || policyMetadata.isSymbolicLink()) {
    throw new Error("route edge policy paths must be regular non-symlink files");
  }
  const [inputBytes, policyBytes] = await Promise.all([readFile(inputPath), readFile(policyPath)]);
  const admittedItxRideEdgeSetSha256 = await readAdmittedItxRideEdgeSetSha256Impl(repositoryRoot);
  const next = syncCurrentRouteEdgePolicy(
    JSON.parse(inputBytes),
    JSON.parse(policyBytes),
    admittedItxRideEdgeSetSha256,
  );
  const previous = JSON.parse(policyBytes);
  const replacements = [
    [previous.rideInvariant.subwayLocal.admittedEdgeSetSha256, next.rideInvariant.subwayLocal.admittedEdgeSetSha256],
    [previous.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256, next.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256],
  ];
  let outputBytes = policyBytes.toString("utf8");
  for (const [before, after] of replacements) {
    if ((outputBytes.match(new RegExp(before, "g")) ?? []).length !== 1) throw new Error("route edge policy digest location is invalid");
    outputBytes = outputBytes.replace(before, after);
  }
  const temporaryRoot = await mkdtemp(path.join(path.dirname(path.resolve(outputPath)), ".sync-current-route-edge-policy-"));
  const temporary = path.join(temporaryRoot, "policy.json");
  try {
    await writeFile(temporary, outputBytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, outputPath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("sync-current-route-edge-policy accepts no arguments");
  await syncCurrentRouteEdgePolicyFile({
    repositoryRoot: path.resolve(import.meta.dirname, "../.."),
    inputPath: CURRENT_ROUTE_EDGE_INPUT,
    policyPath: "release/product-gates/route-edge-evaluation-policy.json",
  });
}
