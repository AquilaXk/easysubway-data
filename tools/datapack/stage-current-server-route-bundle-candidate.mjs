#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

import { prepareCurrentServerRouteBundleFinal } from "./prepare-current-server-route-bundle-final.mjs";
import { parseArgs, requiredArg } from "./lib/cli-args.mjs";
import { selectEffectiveDataPack, sha256, stagedPackPath } from "./lib/manifest-validation.mjs";

const REQUIRED_ARGS = ["datapack-root", "build-spec", "station-line-input", "route-edge-input", "repository-git-sha", "key-id", "output"];
const SIGNED_PATHS = ["compatibility.json", "manifest.json", "manifest.signing-input.json", "payload/accessibility.sqlite.zst", "payload/fare.sqlite.zst", "payload/timetable.sqlite.zst", "payload/topology.sqlite.zst", "provenance.json"];

export async function stageCurrentServerRouteBundleCandidate(input) {
  const datapackRoot = await directory(input.datapackRoot, "datapack root");
  const output = path.resolve(required(input.output, "output"));
  await absent(output);
  if (input.keyId !== "production-v1") {
    throw new Error("key id must be production-v1");
  }
  const outputParent = await directory(path.dirname(output), "output parent");
  const [manifest, buildSpecBytes, stationLine, route, provenanceBytes] = await Promise.all([
    jsonFile(path.join(datapackRoot, "current.json"), "current manifest"),
    regular(input.buildSpecPath, "build spec"),
    jsonFile(input.stationLineInputPath, "station-line input"),
    jsonFile(input.routeEdgeInputPath, "route-edge input"),
    regular(path.join(datapackRoot, "current.provenance.json"), "current provenance"),
  ]);
  const buildSpec = JSON.parse(buildSpecBytes.toString("utf8"));
  const provenanceValue = JSON.parse(provenanceBytes.toString("utf8"));
  const active = selectEffectiveDataPack(manifest);
  if (!active || active.id !== "capital" || active.version !== "1" || active.artifactKind !== "production") {
    throw new Error("current manifest must select production capital@1");
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
  const publishedAt = requiredInstant(buildSpec.publishedAt, "build spec publishedAt");
  const releaseSequence = positiveInteger(buildSpec.releaseSequence, "build spec releaseSequence");
  const temp = await mkdtemp(path.join(outputParent, ".route-candidate-"));
  try {
    const sourceSqlite = path.join(temp, "source.sqlite");
    const prepared = path.join(temp, "prepared");
    await writeFile(sourceSqlite, sqlite, { flag: "wx", mode: 0o600 });
    const prepare = input.stages?.prepare ?? prepareCurrentServerRouteBundleFinal;
    await prepare({
      output: prepared,
      repositoryGitSha: requiredSha(input.repositoryGitSha, "repository git sha"),
      evaluationAt: buildSpec.publishedAt,
      stationLineInputPath: path.resolve(input.stationLineInputPath),
      routeEdgeInputPath: path.resolve(input.routeEdgeInputPath),
      emitterInputs: {
        sourceSqlite,
        sourceProvenance: provenance,
        buildSpec: path.resolve(input.buildSpecPath),
        mapPackId: "capital-map-1",
        catalogPackId: "capital-catalog-1",
        bundleId: "capital-route-bundle-1",
        releaseSequence,
        activeFrom: kstInstant(publishedAt),
        freshUntil: kstInstant(new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000)),
        builtAt: buildSpec.publishedAt,
        keyId: input.keyId,
      },
    });
    const signed = path.join(prepared, "signed-server-route-bundle");
    await assertSignedInventory(signed);
    const staged = path.join(temp, "stage");
    await mkdir(path.join(staged, "server-route-bundle", "payload"), { recursive: true });
    for (const relative of SIGNED_PATHS) {
      await copyFile(path.join(signed, relative), path.join(staged, "server-route-bundle", relative), 0);
    }
    await assertCandidateInventory(staged);
    await rename(staged, output);
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
  if (!same(actual, SIGNED_PATHS.map((relative) => `server-route-bundle/${relative}`))) throw new Error("candidate route bundle inventory mismatch");
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
  return paths.sort();
}
function same(left, right) { return left.length === right.length && left.every((value, index) => value === [...right].sort()[index]); }
async function jsonFile(target, label) { return JSON.parse((await regular(target, label)).toString("utf8")); }
async function regular(target, label) { const file = path.resolve(required(target, label)); const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`${label} must be a non-empty regular non-symlink`); return readFile(file); }
async function directory(target, label) { const resolved = path.resolve(required(target, label)); const stat = await lstat(resolved); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`); return resolved; }
async function absent(target) { try { await lstat(target); } catch (error) { if (error.code === "ENOENT") return; throw error; } throw new Error("output must be absent"); }
function required(value, label) { if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`); return value; }
function requiredSha(value, label) { if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error(`${label} must be a lowercase git sha`); return value; }
function positiveInteger(value, label) { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`); return value; }
function requiredInstant(value, label) { const parsed = new Date(value); if (typeof value !== "string" || Number.isNaN(parsed.getTime()) || !value.endsWith("Z")) throw new Error(`${label} must be UTC instant`); return parsed; }
function kstInstant(value) { return new Date(value.getTime() + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00"); }

export function parseStageCurrentServerRouteBundleCandidateArgs(argv) {
  const args = parseArgs(argv);
  if (args.size !== REQUIRED_ARGS.length || REQUIRED_ARGS.some((name) => !args.has(name))) throw new Error("CLI arguments mismatch");
  return { datapackRoot: requiredArg(args, "datapack-root"), buildSpecPath: requiredArg(args, "build-spec"), stationLineInputPath: requiredArg(args, "station-line-input"), routeEdgeInputPath: requiredArg(args, "route-edge-input"), repositoryGitSha: requiredArg(args, "repository-git-sha"), keyId: requiredArg(args, "key-id"), output: requiredArg(args, "output") };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) stageCurrentServerRouteBundleCandidate(parseStageCurrentServerRouteBundleCandidateArgs(process.argv.slice(2))).catch((error) => { process.stderr.write(`stage-current-server-route-bundle-candidate: ${error.message}\n`); process.exitCode = 1; });
