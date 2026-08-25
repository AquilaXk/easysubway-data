#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectPublicStaticNetworkV2 } from "./collect-public-static-network-v2.mjs";
import { projectMolit, projectPositions } from "./collect-current-static-network-successors.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { publishStaticNetworkSourceRaw } from "./publish-static-network-source-raw.mjs";
import { runPublicStaticNetworkV2Transition } from "./run-current-static-network-successors.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TARGETS = Object.freeze([
  ["seoul-metro-route-map-positions", "positions.raw.json"],
  ["molit-urban-rail-full-route", "molit.raw.csv"],
]);

async function regularDirectory(value, label) {
  const first = await lstat(value);
  if (!first.isDirectory() || first.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  const resolved = await realpath(value); const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  return resolved;
}

async function writeExclusive(directory, relative, value) {
  const target = path.join(directory, relative);
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}

async function exactMain(repositoryRoot) {
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const run = promisify(execFile);
  const [{ stdout: head }, { stdout: main }, { stdout: status }] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }), run("git", ["rev-parse", "origin/main"], { cwd: repositoryRoot }), run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot }),
  ]);
  if (status !== "" || head.trim() !== main.trim()) throw new Error("public static v2 repository must be exact clean main");
  return head.trim();
}

export async function runPublicStaticNetworkV2Operation({ repositoryRoot = ROOT, operationRoot, now = new Date(), fetchImpl = fetch, serviceKey = process.env.DATA_GO_KR_SERVICE_KEY, env = process.env, client = null, assertExactMain = exactMain, collectImpl = collectPublicStaticNetworkV2, publishImpl = publishStaticNetworkSourceRaw, transitionImpl = runPublicStaticNetworkV2Transition } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("public static v2 operation now is invalid");
  if (typeof env?.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL !== "string" || env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL.trim() === "") {
    throw new Error("public static v2 operation requires OCI PAR URL");
  }
  let normalizedServiceKey;
  try { normalizedServiceKey = normalizeDataGoKrServiceKey(serviceKey); } catch { throw new Error("PUBLIC_STATIC_NETWORK_V2_ARGUMENT"); }
  const root = await regularDirectory(repositoryRoot, "repository root"); const operation = await regularDirectory(operationRoot, "operation root");
  if (operation === root || operation.startsWith(`${root}${path.sep}`)) throw new Error("public static v2 operation root must be outside repository");
  const expectedMainSha = await assertExactMain(root);
  const collected = await collectImpl({ fetchImpl, capturedAt: now.toISOString(), serviceKey: normalizedServiceKey });
  if (collected?.capturedAt !== now.toISOString() || !Buffer.isBuffer(collected.positionRawBytes) || !Buffer.isBuffer(collected.molitRawBytes)) throw new Error("public static v2 collection is invalid");
  try { projectPositions(collected.positionRawBytes, collected.capturedAt); } catch { throw new Error("PUBLIC_STATIC_NETWORK_V2_POSITIONS_SCHEMA"); }
  try { projectMolit(collected.molitRawBytes); } catch { throw new Error("PUBLIC_STATIC_NETWORK_V2_MOLIT_SCHEMA"); }
  await writeExclusive(operation, TARGETS[0][1], collected.positionRawBytes);
  await writeExclusive(operation, TARGETS[1][1], collected.molitRawBytes);
  const receipts = [];
  for (const [sourceId, rawRelativePath] of TARGETS) {
    receipts.push(await publishImpl({ repositoryRoot: root, expectedMainSha, operationRoot: operation, sourceId, snapshotId: `${sourceId}-current-${collected.capturedAt.replaceAll(/[-:.]/gu, "")}`, capturedAt: collected.capturedAt, rawRelativePath, env, client, now }));
  }
  if (await assertExactMain(root) !== expectedMainSha) throw new Error("PUBLIC_STATIC_NETWORK_V2_REPOSITORY_CHANGED");
  const result = await transitionImpl({ repositoryRoot: root, positionRawBytes: collected.positionRawBytes, molitRawBytes: collected.molitRawBytes, positionReceipt: receipts[0], molitReceipt: receipts[1], capturedAt: collected.capturedAt, assertExactMain });
  if (!Array.isArray(result?.outputs) || result.outputs.length !== 5) throw new Error("public static v2 transition outputs are invalid");
  return result;
}

async function main(argv) {
  if (argv.length !== 1 || !path.isAbsolute(argv[0])) throw new Error("public static v2 operation requires an absolute operation root");
  process.stdout.write(`${JSON.stringify(await runPublicStaticNetworkV2Operation({ operationRoot: argv[0] }))}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
