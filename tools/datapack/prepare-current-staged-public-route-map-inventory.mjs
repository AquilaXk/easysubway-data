#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants, lstat, open, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS } from "./materialize-seoul-route-map-positions.mjs";

const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const SOURCE_ID = "seoul-metro-route-map-positions";
const LEGACY_OPERATOR_IDS = Object.freeze(["seoul-metro"]);

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readStableJson(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("staged public route-map inventory is not a regular file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("staged public route-map inventory changed while reading");
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } finally {
    await handle.close();
  }
}

async function assertStagedIdentity(repositoryRoot, stagedRoot) {
  const repository = await realpath(path.resolve(repositoryRoot));
  const staged = await realpath(path.resolve(stagedRoot));
  if (repository === staged || staged.startsWith(`${repository}${path.sep}`) || repository.startsWith(`${staged}${path.sep}`)) throw new Error("public route-map inventory preparation requires a distinct staged root");
  const info = await lstat(staged);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("staged public route-map root is not a real directory");
  return staged;
}

function preparedInventory(value) {
  if (!Array.isArray(value?.sources)) throw new Error("staged public route-map inventory sources are invalid");
  const matches = value.sources.filter(({ id }) => id === SOURCE_ID);
  if (matches.length !== 1 || !matches[0]?.coverageScope || typeof matches[0].coverageScope !== "object") throw new Error("staged public route-map source identity is invalid");
  const operatorIds = matches[0].coverageScope.operatorIds;
  if (sameArray(operatorIds, CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS)) return { value, changed: false };
  if (!sameArray(operatorIds, LEGACY_OPERATOR_IDS)) throw new Error("staged public route-map operator scope drift");
  const next = structuredClone(value);
  next.sources.find(({ id }) => id === SOURCE_ID).coverageScope.operatorIds = [...CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS];
  return { value: next, changed: true };
}

async function replaceAtomicCas(file, expected, next) {
  const current = await readStableJson(file);
  if (!current.bytes.equals(expected)) throw new Error("staged public route-map inventory atomic CAS failed");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function prepareCurrentStagedPublicRouteMapInventory({ repositoryRoot, stagedRoot } = {}) {
  if (![repositoryRoot, stagedRoot].every((value) => path.isAbsolute(value ?? ""))) throw new Error("public route-map inventory roots must be absolute");
  const staged = await assertStagedIdentity(repositoryRoot, stagedRoot);
  const file = path.join(staged, INVENTORY_PATH);
  const captured = await readStableJson(file);
  const prepared = preparedInventory(captured.value);
  if (!prepared.changed) return { inventoryPath: INVENTORY_PATH, changed: false };
  await replaceAtomicCas(file, captured.bytes, Buffer.from(`${JSON.stringify(prepared.value, null, 2)}\n`));
  return { inventoryPath: INVENTORY_PATH, changed: true };
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--source-repository-root" || argv[2] !== "--staged-root") {
    throw new Error("usage: prepare-current-staged-public-route-map-inventory.mjs --source-repository-root <absolute-path> --staged-root <absolute-path>");
  }
  return { repositoryRoot: argv[1], stagedRoot: argv[3] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareCurrentStagedPublicRouteMapInventory(parseArgs(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
