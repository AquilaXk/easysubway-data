#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { publishCapitalRouteTopologyRaw } from "./publish-capital-route-topology-raw.mjs";
import {
  readCurrentCapitalRouteTopologyAdmission,
  registerCurrentCapitalRouteTopology,
} from "./register-current-capital-route-topology.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RAW = "capital-route-topology.raw.json";
const RECEIPT = "capital-route-topology.raw-receipt.json";
const MARKERS = [
  "tools/datapack/release/current-capital-accessibility-transition.json",
  "tools/datapack/release/current-capital-accessibility-transition-successor.json",
];
const TARGETS = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
];
const SHA = /^[a-f0-9]{40}$/u;

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}
async function regularFileAbsent(file, label) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
    throw new Error(`${label} must be absent`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}
async function privateExternalOperationRoot(repositoryRoot, operationRoot) {
  const repository = await realpath(absolute(repositoryRoot, "repositoryRoot"));
  const requested = absolute(operationRoot, "operationRoot");
  const parent = await realpath(path.dirname(requested));
  const operation = path.join(parent, path.basename(requested));
  if (operation === repository || operation.startsWith(repository + path.sep)) throw new Error("operationRoot must be external to repositoryRoot");
  await mkdir(operation, { mode: 0o700 });
  const stat = await lstat(operation);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("operationRoot must be a private regular directory");
  return { repository, operation };
}
async function createOnce(file, bytes) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function exactTargets(targets) {
  if (!Array.isArray(targets) || JSON.stringify(targets) !== JSON.stringify(TARGETS)) throw new Error("capital topology registrar targets are invalid");
  return targets;
}

export function parseArgs(argv) {
  if (argv.length !== 6 || argv[0] !== "--repository-root" || argv[2] !== "--operation-root" || argv[4] !== "--expected-main-sha") {
    throw new Error("usage: --repository-root <absolute-directory> --operation-root <absolute-directory> --expected-main-sha <40-lowercase-hex>");
  }
  if (!SHA.test(argv[5])) throw new Error("expectedMainSha must be lowercase SHA");
  return { repositoryRoot: argv[1], operationRoot: argv[3], expectedMainSha: argv[5] };
}

export async function runCurrentCapitalRouteTopologyRegistration({
  repositoryRoot = ROOT,
  operationRoot,
  expectedMainSha,
  readAdmission = readCurrentCapitalRouteTopologyAdmission,
  publish = publishCapitalRouteTopologyRaw,
  register = registerCurrentCapitalRouteTopology,
  env = process.env,
  now = new Date(),
} = {}) {
  if (!SHA.test(expectedMainSha ?? "") || !(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("capital topology registration arguments are invalid");
  const { repository, operation } = await privateExternalOperationRoot(repositoryRoot, operationRoot);
  await Promise.all(MARKERS.map((relative) => regularFileAbsent(path.join(repository, relative), "current-capital terminal marker")));
  const admission = await readAdmission({ repositoryRoot: repository, now });
  if (!Buffer.isBuffer(admission?.topologyBytes)) throw new Error("capital topology protected admission is invalid");
  const rawPath = path.join(operation, RAW);
  const receiptPath = path.join(operation, RECEIPT);
  await createOnce(rawPath, admission.topologyBytes);
  const receipt = await publish({ repositoryRoot: repository, expectedMainSha, operationRoot: operation, rawRelativePath: RAW, env, now });
  await createOnce(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`));
  const registered = await register({ repositoryRoot: repository, receiptPath, now });
  const targets = exactTargets(registered?.targets);
  return { status: "PASS", sourceId: admission.sourceId, snapshotId: admission.snapshotId, targets };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runCurrentCapitalRouteTopologyRegistration(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
