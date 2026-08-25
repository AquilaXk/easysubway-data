import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStaticNetworkRegularFile, registerPublicStaticNetworkV2Successors } from "./register-current-static-network-successors.mjs";
import { buildPublicStaticNetworkV2Observations } from "./build-public-static-network-v2-observations.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TARGETS = Object.freeze(["seoul-metro-route-map-positions", "molit-urban-rail-full-route"]);

async function regularRoot(value, label) { const initial = await lstat(value); if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); const resolved = await realpath(value); const stat = await lstat(resolved); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); return resolved; }
async function defaultExactMain(repositoryRoot) { const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const run = promisify(execFile); const [{ stdout: head }, { stdout: originMain }, { stdout: status }] = await Promise.all([run("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }), run("git", ["rev-parse", "origin/main"], { cwd: repositoryRoot }), run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot })]); if (status !== "" || head.trim() !== originMain.trim()) throw new Error("static network repository must be exact clean main"); return head.trim(); }
// Input-only successor path. Collection and OCI publication are deliberately
// outside this transition so a supplied receipt cannot be substituted.
export async function runPublicStaticNetworkV2Transition({ repositoryRoot = ROOT, positionRawBytes, molitRawBytes, positionReceipt, molitReceipt, capturedAt, assertExactMain = defaultExactMain, produceImpl = buildPublicStaticNetworkV2Observations, registerImpl = registerPublicStaticNetworkV2Successors } = {}) {
  const root = await regularRoot(repositoryRoot, "repository root");
  const expectedMainSha = await assertExactMain(root);
  const inventoryBytes = await readFile(path.join(root, "tools/datapack/source-inventory.json"));
  let sourceInventory; try { sourceInventory = JSON.parse(inventoryBytes); } catch { throw new Error("public v2 source inventory is invalid"); }
  const topologyId = sourceInventory?.sources?.find(({ id }) => id === TARGETS[0])?.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
  if (typeof topologyId !== "string" || topologyId === "") throw new Error("public v2 topology admission is invalid");
  const admittedTopologyBytes = await readStaticNetworkRegularFile(root, `tools/datapack/sources/${topologyId}.json`, "public v2 topology");
  const producerOutput = produceImpl({ positionRawBytes, molitRawBytes, positionReceipt, molitReceipt, capturedAt, sourceInventory, admittedTopologyBytes, admittedTopologyId: topologyId });
  if (await assertExactMain(root) !== expectedMainSha) throw new Error("public v2 repository changed before registration");
  return registerImpl({ repositoryRoot: root, producerOutput, rawBytesBySource: { [TARGETS[0]]: Buffer.from(positionRawBytes), [TARGETS[1]]: Buffer.from(molitRawBytes) }, now: new Date(capturedAt) });
}
