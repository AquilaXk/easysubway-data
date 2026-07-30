#!/usr/bin/env node
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectEffectiveDataPack, stagedPackPath, validateManifest } from "./lib/manifest-validation.mjs";

const requiredArguments = new Set([
  "root", "manifest", "provenance", "repository", "git-sha", "workflow-run-id",
  "contract-version", "issue-ref", "inventory-output", "output",
]);

export async function buildDataComponentManifest(input) {
  const root = await directory(input.root, "--root");
  const manifestPath = containedFile(root, input.manifest, "--manifest");
  const provenancePath = containedFile(root, input.provenance, "--provenance");
  const inventoryOutput = containedFile(root, input.inventoryOutput, "--inventory-output");
  const output = containedFile(root, input.output, "--output");
  if (inventoryOutput === output) throw new Error("metadata outputs must be distinct");

  const repository = exact(input.repository, "--repository", "AquilaXk/easysubway");
  const gitSha = matched(input.gitSha, "--git-sha", /^[a-f0-9]{40}$/);
  const workflowRunId = matched(input.workflowRunId, "--workflow-run-id", /^[1-9][0-9]*$/);
  const contractVersion = exact(input.contractVersion, "--contract-version", "datapack-contract-v3");
  const issueRef = exact(input.issueRef, "--issue-ref", "AquilaXk/easysubway#2699");
  const manifestBytes = await regularFileBytes(manifestPath, "--manifest");
  const provenanceBytes = await regularFileBytes(provenancePath, "--provenance");
  const manifest = parseJson(manifestBytes, "--manifest");
  validateManifest(manifest);
  if (manifest.manifestVersion !== 2) throw new Error("--manifest must be manifestVersion 2");
  const activePack = selectEffectiveDataPack(manifest);
  if (!activePack) throw new Error("--manifest must select one active pack");
  const provenance = parseJson(provenanceBytes, "--provenance");
  const sourceSnapshotSetHash = provenance?.candidateBuild?.sourceSnapshotSetHash;
  if (typeof sourceSnapshotSetHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceSnapshotSetHash)) {
    throw new Error("--provenance candidateBuild.sourceSnapshotSetHash must be a lowercase sha256 hex string");
  }

  const inventory = {
    schemaVersion: 1,
    artifactKind: "datapack-candidate-inventory",
    entries: await inventoryEntries(root, new Set([inventoryOutput, output])),
  };
  const declaredPackPaths = new Set(manifest.packs.map(stagedPackPath));
  const inventoryPackPaths = new Set(
    inventory.entries.filter((entry) => entry.path.endsWith(".sqlite.gz")).map((entry) => entry.path),
  );
  for (const declaredPath of declaredPackPaths) {
    if (!inventoryPackPaths.has(declaredPath)) {
      throw new Error(`candidate stage is missing manifest-declared pack: ${declaredPath}`);
    }
  }
  for (const inventoryPath of inventoryPackPaths) {
    if (!declaredPackPaths.has(inventoryPath)) {
      throw new Error(`candidate stage contains undeclared pack: ${inventoryPath}`);
    }
  }
  const inventoryBytes = jsonBytes(inventory);
  const componentManifest = {
    schemaVersion: 1,
    component: "data",
    repository,
    gitSha,
    workflowRunId,
    dataVersion: activePack.version,
    releaseSequence: manifest.releaseSequence,
    manifestSha256: sha256(manifestBytes),
    provenance: { sourceSnapshotSetHash },
    artifactInventorySha256: sha256(inventoryBytes),
    contractVersion,
    issueRef,
  };
  await assertAbsent(inventoryOutput, "--inventory-output");
  await assertAbsent(output, "--output");
  await writeOutputs(root, inventoryOutput, inventoryBytes, output, jsonBytes(componentManifest));
  return { inventory, componentManifest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await buildDataComponentManifest({
    root: args.get("root"),
    manifest: args.get("manifest"),
    provenance: args.get("provenance"),
    repository: args.get("repository"),
    gitSha: args.get("git-sha"),
    workflowRunId: args.get("workflow-run-id"),
    contractVersion: args.get("contract-version"),
    issueRef: args.get("issue-ref"),
    inventoryOutput: args.get("inventory-output"),
    output: args.get("output"),
  });
}

function parseArgs(argv) {
  if (argv.length !== requiredArguments.size * 2) throw new Error("exactly the required arguments are required");
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    const name = key.slice(2);
    if (!requiredArguments.has(name) || args.has(name)) throw new Error(`invalid argument: ${key}`);
    args.set(name, value);
  }
  return args;
}

async function inventoryEntries(root, excluded) {
  const entries = [];
  await walk(root, root, excluded, entries);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return entries;
}

async function walk(root, directoryPath, excluded, entries) {
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const target = path.resolve(directoryPath, entry.name);
    if (!isContained(root, target)) throw new Error("candidate stage contains an unsafe path");
    if (entry.isSymbolicLink()) throw new Error(`candidate stage must not contain symlinks: ${relativePath(root, target)}`);
    if (entry.isDirectory()) {
      await walk(root, target, excluded, entries);
      continue;
    }
    if (!entry.isFile()) throw new Error(`candidate stage must contain only regular files: ${relativePath(root, target)}`);
    if (excluded.has(target)) continue;
    const bytes = await readFile(target);
    if (bytes.length <= 0) throw new Error(`candidate artifact must not be empty: ${relativePath(root, target)}`);
    entries.push({ path: relativePath(root, target), sizeBytes: bytes.length, sha256: sha256(bytes) });
  }
}

async function directory(value, label) {
  const target = path.resolve(nonEmpty(value, label));
  const stats = await lstat(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return target;
}

function containedFile(root, value, label) {
  const target = path.resolve(nonEmpty(value, label));
  if (!isContained(root, target)) throw new Error(`${label} must be inside --root`);
  return target;
}

async function regularFileBytes(target, label) {
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return readFile(target);
}

async function assertAbsent(target, label) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must not already exist`);
}

async function writeOutputs(root, inventoryOutput, inventoryBytes, output, outputBytes) {
  await Promise.all([mkdir(path.dirname(inventoryOutput), { recursive: true }), mkdir(path.dirname(output), { recursive: true })]);
  const temporaryDirectory = await mkdtemp(path.join(root, ".data-component-manifest-"));
  const temporaryInventory = path.join(temporaryDirectory, "inventory.json");
  const temporaryOutput = path.join(temporaryDirectory, "component-manifest.json");
  let inventoryPublished = false;
  let outputPublished = false;
  try {
    await writeFile(temporaryInventory, inventoryBytes, { flag: "wx" });
    await writeFile(temporaryOutput, outputBytes, { flag: "wx" });
    await link(temporaryInventory, inventoryOutput);
    inventoryPublished = true;
    await link(temporaryOutput, output);
    outputPublished = true;
  } catch (error) {
    if (outputPublished) await rm(output, { force: true });
    if (inventoryPublished) await rm(inventoryOutput, { force: true });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function relativePath(root, target) {
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative)) throw new Error("candidate stage contains an unsafe path");
  return relative;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain JSON`);
  }
}

function exact(value, label, expected) {
  const text = nonEmpty(value, label);
  if (text !== expected) throw new Error(`${label} must be ${expected}`);
  return text;
}

function matched(value, label, pattern) {
  const text = nonEmpty(value, label);
  if (!pattern.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`build-data-component-manifest: ${error.message}\n`);
    process.exitCode = 1;
  });
}
