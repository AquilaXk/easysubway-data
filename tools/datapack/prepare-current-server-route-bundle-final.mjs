#!/usr/bin/env node
import { lstat, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emitArtifactComponents } from "./emit-artifact-components.mjs";
import { signServerRouteBundle } from "./sign-server-route-bundle.mjs";
import { buildServerRouteBundleFinalEvidence } from "./build-server-route-bundle-final.mjs";
import { buildRouteAccessibilityEligibility } from "./build-route-accessibility-eligibility.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { parseArgs, requiredArg } from "./lib/cli-args.mjs";

const OUTPUTS = ["components", "signed-server-route-bundle", "provisional", "route-accessibility-eligibility.json", "bound"];

export async function prepareCurrentServerRouteBundleFinal(input) {
  const output = path.resolve(required(input.output, "output"));
  await absent(output);
  const parent = await realDirectory(path.dirname(output), "output parent");
  const stationLineInput = await canonicalInput(input.stationLineInputPath, "station-line input");
  const routeEdgeInput = await canonicalInput(input.routeEdgeInputPath, "route-edge input");
  const stages = { emit: emitArtifactComponents, sign: signServerRouteBundle, final: buildServerRouteBundleFinalEvidence, eligibility: buildRouteAccessibilityEligibility, ...input.stages };
  for (const name of ["emit", "sign", "final", "eligibility"]) {
    if (typeof stages[name] !== "function") {
      throw new Error(`${name} stage is required`);
    }
  }
  const temp = await mkdtemp(path.join(parent, ".current-server-route-final-"));
  const paths = Object.fromEntries(OUTPUTS.map((name) => [name, path.join(temp, name)]));
  try {
    await stages.emit({ ...input.emitterInputs, repositoryRoot: input.repositoryRoot ?? process.cwd(), stationLineInput, routeEdgeInput, output: paths.components });
    await stages.sign({ input: path.join(paths.components, "server-route-bundle"), output: paths["signed-server-route-bundle"] });
    const finalInput = {
      repositoryRoot: input.repositoryRoot ?? process.cwd(), repositoryGitSha: required(input.repositoryGitSha, "repository git sha"),
      artifactRoot: paths["signed-server-route-bundle"], stationLineInput, routeEdgeInput,
      evaluationAt: required(input.evaluationAt, "evaluation at"),
    };
    await stages.final({ ...finalInput, output: paths.provisional });
    await stages.eligibility({
      repositoryRoot: finalInput.repositoryRoot, prepublicationRoot: paths.provisional, artifactRoot: paths["signed-server-route-bundle"],
      stationLineInput: path.resolve(input.stationLineInputPath), routeEdgeInput: path.resolve(input.routeEdgeInputPath),
      repositoryGitSha: finalInput.repositoryGitSha, evaluationAt: finalInput.evaluationAt, output: paths["route-accessibility-eligibility.json"],
    });
    await stages.final({ ...finalInput, eligibilityReportPath: paths["route-accessibility-eligibility.json"], output: paths.bound });
    await assertInventory(temp);
    await rename(temp, output);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return output;
}

async function canonicalInput(target, label) {
  const bytes = await regular(target, label);
  const value = JSON.parse(bytes);
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) {
    throw new Error(`${label} must be canonical JSON`);
  }
  return value;
}

async function assertInventory(root) {
  const actual = (await readdir(root)).sort(bytewise);
  if (canonicalJson(actual) !== canonicalJson([...OUTPUTS].sort(bytewise))) {
    throw new Error("prepared output inventory mismatch");
  }
}

async function regular(target, label) {
  const resolved = path.resolve(required(target, label));
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} is missing`);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink`);
  }
  return readFile(resolved);
}
async function realDirectory(target, label) {
  const resolved = path.resolve(required(target, label));
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return resolved;
}
async function absent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("output must not already exist");
}
function required(value, label) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}
function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function parsePrepareCurrentServerRouteBundleFinalArgs(argv) {
  const args = parseArgs(argv);
  const keys = ["source-sqlite", "source-provenance", "build-spec", "output", "map-pack-id", "catalog-pack-id", "bundle-id", "release-sequence", "active-from", "fresh-until", "built-at", "key-id", "evaluation-at", "station-line-input", "route-edge-input", "repository-git-sha"];
  if (args.size !== keys.length || keys.some((key) => !args.has(key))) {
    throw new Error("CLI arguments mismatch");
  }
  return {
    output: requiredArg(args, "output"), repositoryGitSha: requiredArg(args, "repository-git-sha"), evaluationAt: requiredArg(args, "evaluation-at"),
    stationLineInputPath: requiredArg(args, "station-line-input"), routeEdgeInputPath: requiredArg(args, "route-edge-input"),
    emitterInputs: {
      sourceSqlite: requiredArg(args, "source-sqlite"), sourceProvenance: requiredArg(args, "source-provenance"), buildSpec: requiredArg(args, "build-spec"),
      mapPackId: requiredArg(args, "map-pack-id"), catalogPackId: requiredArg(args, "catalog-pack-id"), bundleId: requiredArg(args, "bundle-id"),
      releaseSequence: Number(requiredArg(args, "release-sequence")), activeFrom: requiredArg(args, "active-from"), freshUntil: requiredArg(args, "fresh-until"),
      builtAt: requiredArg(args, "built-at"), keyId: requiredArg(args, "key-id"), evaluationAt: requiredArg(args, "evaluation-at"),
    },
  };
}

async function main(argv) {
  await prepareCurrentServerRouteBundleFinal(parsePrepareCurrentServerRouteBundleFinalArgs(argv));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`prepare-current-server-route-bundle-final: ${error.message}\n`);
    process.exitCode = 1;
  }
}
