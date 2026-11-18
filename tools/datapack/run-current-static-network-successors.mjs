import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStaticNetworkRegularFile, registerPublicStaticNetworkV2Successors } from "./register-current-static-network-successors.mjs";
import { buildPublicStaticNetworkV2Observations } from "./build-public-static-network-v2-observations.mjs";
import { assertSelectedHeadPreflight } from "./publish-seoul-transfer-raw.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TARGETS = Object.freeze(["seoul-metro-route-map-positions", "molit-urban-rail-full-route"]);

async function regularRoot(value, label) { const initial = await lstat(value); if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); const resolved = await realpath(value); const stat = await lstat(resolved); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`); return resolved; }
// #862: 명시한 origin/main의 clean 후손 HEAD에서만 등록한다(FACILITY와 같은 가드).
async function defaultSelectedHead({ repositoryRoot, expectedMainSha, expectedHeadSha }) { return (await assertSelectedHeadPreflight({ repositoryRoot, expectedMainSha, expectedHeadSha })).head; }
// Input-only successor path. Collection and OCI publication are deliberately
// outside this transition so a supplied receipt cannot be substituted.
export async function runPublicStaticNetworkV2Transition({ repositoryRoot = ROOT, positionRawBytes, molitRawBytes, positionReceipt, molitReceipt, capturedAt, expectedMainSha, expectedHeadSha, assertSelectedHead = defaultSelectedHead, produceImpl = buildPublicStaticNetworkV2Observations, registerImpl = registerPublicStaticNetworkV2Successors } = {}) {
  const root = await regularRoot(repositoryRoot, "repository root");
  const selectedHeadSha = await assertSelectedHead({ repositoryRoot: root, expectedMainSha, expectedHeadSha });
  const inventoryBytes = await readFile(path.join(root, "tools/datapack/source-inventory.json"));
  let sourceInventory; try { sourceInventory = JSON.parse(inventoryBytes); } catch { throw new Error("public v2 source inventory is invalid"); }
  const topologyId = sourceInventory?.sources?.find(({ id }) => id === TARGETS[0])?.routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId;
  if (typeof topologyId !== "string" || topologyId === "") throw new Error("public v2 topology admission is invalid");
  const admittedTopologyBytes = await readStaticNetworkRegularFile(root, `tools/datapack/sources/${topologyId}.json`, "public v2 topology");
  const producerOutput = produceImpl({ positionRawBytes, molitRawBytes, positionReceipt, molitReceipt, capturedAt, sourceInventory, admittedTopologyBytes, admittedTopologyId: topologyId });
  if (await assertSelectedHead({ repositoryRoot: root, expectedMainSha, expectedHeadSha }) !== selectedHeadSha) throw new Error("public v2 repository changed before registration");
  return registerImpl({ repositoryRoot: root, producerOutput, rawBytesBySource: { [TARGETS[0]]: Buffer.from(positionRawBytes), [TARGETS[1]]: Buffer.from(molitRawBytes) }, now: new Date(capturedAt) });
}
