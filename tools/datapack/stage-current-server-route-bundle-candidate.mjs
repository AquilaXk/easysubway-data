#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

import { prepareCurrentServerRouteBundleFinal } from "./prepare-current-server-route-bundle-final.mjs";
import { deriveCurrentReleaseCandidateObservedAt } from "./current-capital-station-line-contract.mjs";
import { parseArgs, requiredArg } from "./lib/cli-args.mjs";
import { canonicalJson, selectEffectiveDataPack, sha256, stagedPackPath } from "./lib/manifest-validation.mjs";
import { validateServerRouteBundleFinal } from "./lib/server-route-bundle-final.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const REQUIRED_ARGS = ["datapack-root", "build-spec", "station-line-input", "route-edge-input", "repository-git-sha", "key-id", "output"];
const SIGNED_PATHS = ["compatibility.json", "manifest.json", "manifest.signing-input.json", "payload/accessibility.sqlite.zst", "payload/fare.sqlite.zst", "payload/timetable.sqlite.zst", "payload/topology.sqlite.zst", "provenance.json"];
const EVIDENCE_PATHS = ["route-accessibility-eligibility.json", "server-route-bundle-final.json"];
const BOUND_SUPPORT = [
  ["artifact-inventory.json", "artifactInventory"],
  ["route-edge-evaluation.json", "routeEdgeEvaluation"],
  ["source-freshness.json", "sourceFreshness"],
  ["station-line-accessibility.json", "stationLineAccessibility"],
];
const BOUND_EVIDENCE_PATHS = [...BOUND_SUPPORT.map(([file]) => file), EVIDENCE_PATHS[1]];
const CANONICAL_INPUT_PATHS = [
  ["build-spec.json", "buildSpecPath"],
  ["station-line-input.json", "stationLineInputPath"],
  ["route-edge-input.json", "routeEdgeInputPath"],
];

export async function stageCurrentServerRouteBundleCandidate(input) {
  const datapackRoot = await directory(input.datapackRoot, "datapack root");
  const output = await directory(input.output, "output");
  const routeOutput = path.join(output, "server-route-bundle");
  const evidenceOutput = path.join(output, "server-route-bundle-evidence");
  const inputsOutput = path.join(output, "server-route-bundle-inputs");
  await Promise.all([absent(routeOutput), absent(evidenceOutput), absent(inputsOutput)]);
  if (input.keyId !== "production-v1") {
    throw new Error("key id must be production-v1");
  }
  const [manifest, buildSpecBytes, stationLineBytes, routeBytes, provenanceBytes] = await Promise.all([
    jsonFile(path.join(datapackRoot, "current.json"), "current manifest"),
    regular(input.buildSpecPath, "build spec"),
    regular(input.stationLineInputPath, "station-line input"),
    regular(input.routeEdgeInputPath, "route-edge input"),
    regular(path.join(datapackRoot, "current.provenance.json"), "current provenance"),
  ]);
  const buildSpec = JSON.parse(buildSpecBytes.toString("utf8"));
  const stationLine = JSON.parse(stationLineBytes.toString("utf8"));
  const route = JSON.parse(routeBytes.toString("utf8"));
  const provenanceValue = JSON.parse(provenanceBytes.toString("utf8"));
  const canonicalInputBytes = {
    buildSpecPath: buildSpecBytes,
    stationLineInputPath: stationLineBytes,
    routeEdgeInputPath: routeBytes,
  };
  const active = selectEffectiveDataPack(manifest);
  if (!active || active.id !== "capital" || active.version !== "1" || active.artifactKind !== "production") {
    throw new Error("current manifest must select production capital@1");
  }
  const publishedAt = new Date(requiredUtcInstant(buildSpec.publishedAt, "build spec publishedAt"));
  const expiresAt = new Date(requiredUtcInstant(manifest.expiresAt, "current manifest expiresAt"));
  if (publishedAt.getTime() >= expiresAt.getTime()) {
    throw new Error("current manifest expiresAt must be after build spec publishedAt");
  }
  const candidate = candidateIdentity(buildSpec, "build spec");
  const provenanceCandidate = candidateIdentity(provenanceValue?.candidateBuild, "current provenance");
  if (provenanceCandidate.candidateId !== candidate.candidateId
    || provenanceCandidate.sourceSetSha256 !== candidate.sourceSetSha256
    || provenanceValue.candidateBuild.buildSpecSha256 !== sha256(buildSpecBytes)) {
    throw new Error("current provenance build identity mismatch");
  }
  for (const [name, value] of [["station-line input", stationLine], ["route-edge input", route]]) {
    const observed = candidateIdentity(value?.candidate, name);
    if (observed.candidateId !== candidate.candidateId || observed.sourceSetSha256 !== candidate.sourceSetSha256) {
      throw new Error(`${name} candidate identity mismatch`);
    }
  }
  const compressed = await regular(path.join(datapackRoot, stagedPackPath(active)), "active production pack");
  if (!Number.isSafeInteger(active.sizeBytes) || active.sizeBytes !== compressed.length || active.sha256 !== sha256(compressed)) {
    throw new Error("active production pack compressed identity mismatch");
  }
  let sqlite;
  try { sqlite = gunzipSync(compressed); } catch { throw new Error("active production pack is not valid gzip"); }
  if (sqlite.length === 0 || active.sqliteSha256 !== sha256(sqlite)) {
    throw new Error("active production pack sqlite identity mismatch");
  }
  const provenance = path.join(datapackRoot, "current.provenance.json");
  const releaseSequence = positiveInteger(buildSpec.releaseSequence, "build spec releaseSequence");
  const stagedFreshUntil = kstInstant(expiresAt);
  const evaluationAt = deriveCurrentReleaseCandidateObservedAt(stationLine.evidenceRows);
  if (new Date(evaluationAt).getTime() >= expiresAt.getTime()) {
    throw new Error("current manifest expiresAt must be after evidence observation time");
  }
  const temp = await mkdtemp(path.join(output, ".route-candidate-"));
  try {
    const sourceSqlite = path.join(temp, "source.sqlite");
    const prepared = path.join(temp, "prepared");
    await writeFile(sourceSqlite, sqlite, { flag: "wx", mode: 0o600 });
    const canonicalInputPaths = {};
    for (const [target, field] of CANONICAL_INPUT_PATHS) {
      const snapshotPath = path.join(temp, target);
      await writeFile(snapshotPath, canonicalInputBytes[field], { flag: "wx", mode: 0o600 });
      canonicalInputPaths[field] = snapshotPath;
    }
    const prepare = input.stages?.prepare ?? prepareCurrentServerRouteBundleFinal;
    await prepare({
      output: prepared,
      repositoryGitSha: requiredSha(input.repositoryGitSha, "repository git sha"),
      evaluationAt,
      stationLineInputPath: canonicalInputPaths.stationLineInputPath,
      routeEdgeInputPath: canonicalInputPaths.routeEdgeInputPath,
      emitterInputs: {
        sourceSqlite,
        sourceProvenance: provenance,
        buildSpec: "tools/datapack/release/candidate-build-spec.json",
        buildSpecSnapshotBytes: canonicalInputBytes.buildSpecPath,
        mapPackId: "capital-map-1",
        catalogPackId: "capital-catalog-1",
        bundleId: "capital-route-bundle-1",
        releaseSequence,
        activeFrom: kstInstant(publishedAt),
        freshUntil: stagedFreshUntil,
        builtAt: buildSpec.publishedAt,
        keyId: input.keyId,
      },
    });
    const signed = path.join(prepared, "signed-server-route-bundle");
    await assertSignedInventory(signed);
    const evidence = await validatedEvidence(prepared, candidate, stagedFreshUntil);
    const staged = path.join(temp, "stage");
    await mkdir(path.join(staged, "server-route-bundle", "payload"), { recursive: true });
    for (const relative of SIGNED_PATHS) {
      await copyFile(path.join(signed, relative), path.join(staged, "server-route-bundle", relative), 0);
    }
    const stagedEvidence = path.join(staged, "server-route-bundle-evidence");
    await mkdir(stagedEvidence);
    await copyFile(evidence.eligibilityPath, path.join(stagedEvidence, EVIDENCE_PATHS[0]), 0);
    await copyFile(evidence.finalPath, path.join(stagedEvidence, EVIDENCE_PATHS[1]), 0);
    const stagedInputs = path.join(staged, "server-route-bundle-inputs");
    await mkdir(stagedInputs);
    for (const [target, field] of CANONICAL_INPUT_PATHS) {
      await copyFile(canonicalInputPaths[field], path.join(stagedInputs, target), 0);
    }
    await assertCandidateInventory(staged);
    await Promise.all([absent(routeOutput), absent(evidenceOutput), absent(inputsOutput)]);
    const move = input.stages?.rename ?? rename;
    if (typeof move !== "function") throw new Error("rename stage must be a function");
    let routePublished = false;
    let evidencePublished = false;
    let inputsPublished = false;
    try {
      await move(path.join(staged, "server-route-bundle"), routeOutput);
      routePublished = true;
      await move(path.join(staged, "server-route-bundle-evidence"), evidenceOutput);
      evidencePublished = true;
      await move(path.join(staged, "server-route-bundle-inputs"), inputsOutput);
      inputsPublished = true;
    } catch (error) {
      if (!inputsPublished && await published(path.join(staged, "server-route-bundle-inputs"), inputsOutput)) {
        inputsPublished = true;
      }
      if (inputsPublished) await rm(inputsOutput, { recursive: true, force: true });
      if (evidencePublished) await rm(evidenceOutput, { recursive: true, force: true });
      if (routePublished) await rm(routeOutput, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return output;
}

function candidateIdentity(value, label) {
  const sourceSnapshotSetHash = value?.sourceSnapshotSetHash;
  const sourceSetSha256 = value?.sourceSetSha256;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.candidateId !== "string" || value.candidateId.length === 0
    || (sourceSnapshotSetHash !== undefined && sourceSetSha256 !== undefined && sourceSnapshotSetHash !== sourceSetSha256)
    || !/^[a-f0-9]{64}$/.test(sourceSnapshotSetHash ?? sourceSetSha256)) {
    throw new Error(`${label} candidate identity is invalid`);
  }
  return { candidateId: value.candidateId, sourceSetSha256: sourceSnapshotSetHash ?? sourceSetSha256 };
}

async function assertSignedInventory(root) {
  const actual = await regularTree(root);
  if (!same(actual, SIGNED_PATHS)) throw new Error("prepared signed route bundle inventory mismatch");
}
async function assertCandidateInventory(root) {
  const actual = await regularTree(root);
  if (!same(actual, [
    ...SIGNED_PATHS.map((relative) => `server-route-bundle/${relative}`),
    ...EVIDENCE_PATHS.map((relative) => `server-route-bundle-evidence/${relative}`),
    ...CANONICAL_INPUT_PATHS.map(([relative]) => `server-route-bundle-inputs/${relative}`),
  ])) throw new Error("candidate route bundle inventory mismatch");
}
async function validatedEvidence(prepared, candidate, freshUntil) {
  const eligibilityPath = path.join(prepared, EVIDENCE_PATHS[0]);
  const bound = path.join(prepared, "bound");
  if (!same(await regularTree(bound), BOUND_EVIDENCE_PATHS)) {
    throw new Error("prepared bound route evidence inventory mismatch");
  }
  const finalPath = path.join(bound, EVIDENCE_PATHS[1]);
  const [eligibility, final, ...support] = await Promise.all([
    canonicalJsonFile(eligibilityPath, "route accessibility eligibility"),
    canonicalJsonFile(finalPath, "server route bundle FINAL"),
    ...BOUND_SUPPORT.map(([file]) => regular(path.join(bound, file), `bound ${file}`)),
  ]);
  if (eligibility.value?.artifactKind !== "route-accessibility-eligibility") {
    throw new Error("route accessibility eligibility artifact kind mismatch");
  }
  const { eligibilitySha256, ...eligibilityPayload } = eligibility.value;
  const finalValue = validateServerRouteBundleFinal(final.value);
  for (const [index, [, gate]] of BOUND_SUPPORT.entries()) {
    const bytes = support[index];
    if (finalValue.gates[gate].state !== "PASS" || finalValue.gates[gate].evidenceSha256 !== sha256(bytes)) {
      throw new Error("prepared bound route evidence binding mismatch");
    }
  }
  if (finalValue.candidate.freshUntil !== freshUntil) {
    throw new Error("prepared route evidence freshUntil mismatch");
  }
  if (eligibility.value.schemaVersion !== 1
    || eligibility.value.decision !== "ELIGIBLE"
    || eligibilitySha256 !== sha256(Buffer.from(canonicalJson(eligibilityPayload)))
    || canonicalJson(eligibility.value.candidate) !== canonicalJson(finalValue.candidate)
    || finalValue.candidate.sourceSnapshotSetHash !== candidate.sourceSetSha256
    || finalValue.gates.routeAccessibilityEligibility.state !== "PASS"
    || finalValue.gates.routeAccessibilityEligibility.evidenceSha256 !== sha256(eligibility.bytes)) {
    throw new Error("prepared route evidence eligibility binding mismatch");
  }
  return { eligibilityPath, finalPath };
}
async function canonicalJsonFile(target, label) {
  const bytes = await regular(target, label);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} must be canonical JSON`); }
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) throw new Error(`${label} must be canonical JSON`);
  return { bytes, value };
}
async function regularTree(root, prefix = "") {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("route bundle root must be a real directory");
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`route bundle must not contain symlink: ${relative}`);
    if (entry.isDirectory()) paths.push(...await regularTree(target, relative));
    else if (entry.isFile() && (await lstat(target)).size > 0) paths.push(relative);
    else throw new Error(`route bundle must contain non-empty regular files: ${relative}`);
  }
  return paths.sort((left, right) => left.localeCompare(right));
}
function same(left, right) {
  const sortedRight = [...right].sort((first, second) => first.localeCompare(second));
  return left.length === sortedRight.length && left.every((value, index) => value === sortedRight[index]);
}
async function jsonFile(target, label) { return JSON.parse((await regular(target, label)).toString("utf8")); }
async function regular(target, label) {
  const file = path.resolve(required(target, label));
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink`);
  }
  return readFile(file);
}
async function directory(target, label) {
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
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output must be absent");
}
async function published(source, destination) {
  try {
    await lstat(source);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await lstat(destination);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function required(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}
function requiredSha(value, label) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) {
    throw new Error(`${label} must be a lowercase git sha`);
  }
  return value;
}
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}
function kstInstant(value) { return new Date(value.getTime() + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00"); }

export function parseStageCurrentServerRouteBundleCandidateArgs(argv) {
  const args = parseArgs(argv);
  if (args.size !== REQUIRED_ARGS.length || REQUIRED_ARGS.some((name) => !args.has(name))) throw new Error("CLI arguments mismatch");
  return { datapackRoot: requiredArg(args, "datapack-root"), buildSpecPath: requiredArg(args, "build-spec"), stationLineInputPath: requiredArg(args, "station-line-input"), routeEdgeInputPath: requiredArg(args, "route-edge-input"), repositoryGitSha: requiredArg(args, "repository-git-sha"), keyId: requiredArg(args, "key-id"), output: requiredArg(args, "output") };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) stageCurrentServerRouteBundleCandidate(parseStageCurrentServerRouteBundleCandidateArgs(process.argv.slice(2))).catch((error) => { process.stderr.write(`stage-current-server-route-bundle-candidate: ${error.message}\n`); process.exitCode = 1; });
