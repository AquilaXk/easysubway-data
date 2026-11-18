#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectPublicStaticNetworkV2 } from "./collect-public-static-network-v2.mjs";
import { projectMolit, projectPositions } from "./collect-current-static-network-successors.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { publishStaticNetworkSourceRaw } from "./publish-static-network-source-raw.mjs";
import { assertSelectedHeadPreflight } from "./publish-seoul-transfer-raw.mjs";
import { assertCurrentStaticNetworkTopologyAdmission } from "./register-current-static-network-successors.mjs";
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

// #862: 명시한 origin/main의 clean 후손 HEAD에서만 수집·게시·등록한다(FACILITY와 같은 가드).
async function selectedHead({ repositoryRoot, expectedMainSha, expectedHeadSha }) {
  return (await assertSelectedHeadPreflight({ repositoryRoot, expectedMainSha, expectedHeadSha })).head;
}

export async function runPublicStaticNetworkV2Operation({ repositoryRoot = ROOT, operationRoot, now = new Date(), fetchImpl = fetch, serviceKey = process.env.DATA_GO_KR_SERVICE_KEY, env = process.env, client = null, expectedMainSha, expectedHeadSha, assertSelectedHead = selectedHead, collectImpl = collectPublicStaticNetworkV2, publishImpl = publishStaticNetworkSourceRaw, transitionImpl = runPublicStaticNetworkV2Transition } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("public static v2 operation now is invalid");
  if (typeof env?.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL !== "string" || env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL.trim() === "") {
    throw new Error("public static v2 operation requires OCI PAR URL");
  }
  let normalizedServiceKey;
  try { normalizedServiceKey = normalizeDataGoKrServiceKey(serviceKey); } catch { throw new Error("PUBLIC_STATIC_NETWORK_V2_ARGUMENT"); }
  const root = await regularDirectory(repositoryRoot, "repository root"); const operation = await regularDirectory(operationRoot, "operation root");
  if (operation === root || operation.startsWith(`${root}${path.sep}`)) throw new Error("public static v2 operation root must be outside repository");
  const selectedHeadSha = await assertSelectedHead({ repositoryRoot: root, expectedMainSha, expectedHeadSha });
  await assertCurrentStaticNetworkTopologyAdmission({ repositoryRoot: root, now });
  const collected = await collectImpl({ fetchImpl, capturedAt: now.toISOString(), serviceKey: normalizedServiceKey });
  if (collected?.capturedAt !== now.toISOString() || !Buffer.isBuffer(collected.positionRawBytes) || !Buffer.isBuffer(collected.molitRawBytes)) throw new Error("public static v2 collection is invalid");
  try { projectPositions(collected.positionRawBytes, collected.capturedAt); } catch { throw new Error("PUBLIC_STATIC_NETWORK_V2_POSITIONS_SCHEMA"); }
  try { projectMolit(collected.molitRawBytes); } catch { throw new Error("PUBLIC_STATIC_NETWORK_V2_MOLIT_SCHEMA"); }
  await writeExclusive(operation, TARGETS[0][1], collected.positionRawBytes);
  await writeExclusive(operation, TARGETS[1][1], collected.molitRawBytes);
  const receipts = [];
  for (const [sourceId, rawRelativePath] of TARGETS) {
    receipts.push(await publishImpl({ repositoryRoot: root, expectedMainSha, expectedHeadSha, operationRoot: operation, sourceId, snapshotId: `${sourceId}-current-${collected.capturedAt.replaceAll(/[-:.]/gu, "")}`, capturedAt: collected.capturedAt, rawRelativePath, env, client, now }));
  }
  if (await assertSelectedHead({ repositoryRoot: root, expectedMainSha, expectedHeadSha }) !== selectedHeadSha) throw new Error("PUBLIC_STATIC_NETWORK_V2_REPOSITORY_CHANGED");
  const result = await transitionImpl({ repositoryRoot: root, positionRawBytes: collected.positionRawBytes, molitRawBytes: collected.molitRawBytes, positionReceipt: receipts[0], molitReceipt: receipts[1], capturedAt: collected.capturedAt, expectedMainSha, expectedHeadSha, assertSelectedHead });
  if (!Array.isArray(result?.outputs) || result.outputs.length !== 4) throw new Error("public static v2 transition outputs are invalid");
  return result;
}

export function parsePublicStaticNetworkV2OperationArgs(argv) {
  const names = ["operation-root", "expected-main-sha", "expected-head-sha"];
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith("--") ? argv[index].slice(2) : null;
    if (!names.includes(name) || Object.hasOwn(args, name) || typeof argv[index + 1] !== "string" || argv[index + 1].startsWith("--")) throw new Error("public static v2 operation arguments are invalid");
    args[name] = argv[index + 1];
  }
  if (names.some((name) => !Object.hasOwn(args, name)) || !path.isAbsolute(args["operation-root"])) throw new Error("public static v2 operation requires --operation-root <absolute>, --expected-main-sha and --expected-head-sha");
  return args;
}

async function main(argv) {
  const args = parsePublicStaticNetworkV2OperationArgs(argv);
  process.stdout.write(`${JSON.stringify(await runPublicStaticNetworkV2Operation({ operationRoot: args["operation-root"], expectedMainSha: args["expected-main-sha"], expectedHeadSha: args["expected-head-sha"] }))}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
