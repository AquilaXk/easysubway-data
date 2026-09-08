import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseCurrentMolitGwangjuStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const GWANGJU_TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const GWANGJU_MEMBERSHIP_SOURCE_ID = "molit-urban-rail-full-route-gwangju-membership";
const SHA256 = /^[a-f0-9]{64}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Resolves the one admitted current MOLIT observation from its inventory
 * identity and ledger head. The returned bytes are the exact frozen input a
 * consumer must retain with any derived registration.
 */
export async function loadCurrentMolitObservation({
  repositoryRoot = path.resolve(import.meta.dirname, "../.."),
  inventory: suppliedInventory = null,
  inventoryBytes: suppliedInventoryBytes = null,
  snapshots: suppliedSnapshots = null,
  snapshotsBytes: suppliedSnapshotsBytes = null,
  readTracked = null,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const read = readTracked ?? ((relativePath) => readFile(path.join(root, relativePath)));
  const inventoryPath = "tools/datapack/source-inventory.json";
  const snapshotsPath = "tools/datapack/release/source-snapshots.json";
  const inventoryBytes = suppliedInventoryBytes ?? (suppliedInventory == null ? await read(inventoryPath) : null);
  const snapshotsBytes = suppliedSnapshotsBytes ?? (suppliedSnapshots == null ? await read(snapshotsPath) : null);
  const inventory = suppliedInventory ?? parse(inventoryBytes, "inventory");
  const snapshots = suppliedSnapshots ?? parse(snapshotsBytes, "snapshot ledger");
  const source = inventory?.sources?.find(({ id }) => id === MOLIT_SOURCE_ID);
  const admission = source?.admissionEvidence;
  if (!source || !admission || admission.sourceId !== MOLIT_SOURCE_ID
    || admission.decision !== "APPROVED" || typeof admission.snapshotId !== "string"
    || !SHA256.test(admission.rawSha256 ?? "")) {
    throw new Error("current MOLIT inventory admission is invalid");
  }
  const lineage = validateLineage(snapshots);
  if (lineage.headsBySource[MOLIT_SOURCE_ID] !== admission.snapshotId) {
    throw new Error("current MOLIT inventory admission is not the ledger head");
  }
  const matches = snapshots.filter(({ sourceId, snapshotId }) =>
    sourceId === MOLIT_SOURCE_ID && snapshotId === admission.snapshotId);
  if (matches.length !== 1 || matches[0].rawSha256 !== admission.rawSha256
    || !SHA256.test(matches[0].contentSha256 ?? "")
    || !SHA256.test(matches[0].normalizedObservationSha256 ?? "")
    || matches[0].snapshotStatus !== "LOCKED" || matches[0].fetchStatus !== "SUCCESS"
    || matches[0].schemaStatus !== "PASS" || matches[0].licenseStatus !== "PASS"
    || matches[0].redistributionAllowed !== true || matches[0].credentialRedacted !== true) {
    throw new Error("current MOLIT source snapshot binding is invalid");
  }
  const observationPath = `tools/datapack/sources/${admission.snapshotId}.json`;
  const observationBytes = await read(observationPath);
  const observation = parse(observationBytes, "normalized observation");
  assertCurrentMolitObservation({ observation, observationBytes, current: matches[0] });
  return {
    source,
    current: matches[0],
    observation,
    observationBytes,
    observationPath,
    inputBytes: { inventoryBytes, snapshotsBytes, observationBytes },
  };
}

export function assertCurrentMolitObservation({ observation, observationBytes, current }) {
  if (!(Buffer.isBuffer(observationBytes) || observationBytes instanceof Uint8Array)
    || sha256(observationBytes) !== current.normalizedObservationSha256
    || observation?.sourceId !== MOLIT_SOURCE_ID || observation.snapshotId !== current.snapshotId
    || observation.capturedAt !== current.retrievedAt
    || observation.rawSha256 !== current.rawSha256 || observation.contentSha256 !== current.contentSha256
    || observation.schemaFingerprint !== current.schemaFingerprint
    || observation.rowCount !== current.rowCount || !Array.isArray(observation.normalizedProjection)
    || sha256(Buffer.from(`${JSON.stringify(observation.normalizedProjection)}\n`)) !== current.contentSha256
    || JSON.stringify(observation.providerRecordHashes) !== JSON.stringify(current.providerRecordHashes)
    || JSON.stringify(observation.providerRecordHashes) !== JSON.stringify(
      observation.normalizedProjection.map((record) => sha256(JSON.stringify(record))),
    )) {
    throw new Error("current MOLIT normalized observation binding is invalid");
  }
}

/**
 * Resolves only the admitted Gwangju MOLIT membership join. It deliberately
 * does not inspect other regional membership contracts.
 */
export async function loadCurrentMolitGwangjuStationMappings(options = {}) {
  const currentMolit = await loadCurrentMolitObservation(options);
  const root = path.resolve(options.repositoryRoot ?? path.resolve(import.meta.dirname, "../.."));
  const read = options.readTracked ?? ((relativePath) => readFile(path.join(root, relativePath)));
  const inventory = options.inventory ?? parse(currentMolit.inputBytes.inventoryBytes, "inventory");
  const topologySource = inventory.sources?.find(({ id }) => id === GWANGJU_TOPOLOGY_SOURCE_ID);
  const topologyPath = topologySource?.topologyAdmissionEvidence?.snapshotPath;
  if (typeof topologyPath !== "string" || !topologyPath.startsWith("tools/datapack/sources/")) {
    throw new Error("current MOLIT Gwangju topology selection is invalid");
  }
  const topologyBytes = options.topologyBytes ?? await read(topologyPath);
  const topologySnapshot = options.topologySnapshot ?? parse(topologyBytes, "Gwangju topology snapshot");
  const mappings = parseCurrentMolitGwangjuStationMappings(
    currentMolit.observation.normalizedProjection, currentMolit.current.rawSha256, topologySnapshot, currentMolit.current,
  );
  assertCurrentMolitGwangjuMembershipAdmission({
    inventory,
    mappings, current: currentMolit.current, topology: topologySource,
  });
  return { ...currentMolit, mappings, topologySource, topologySnapshot, topologyPath, topologyBytes };
}

export function assertCurrentMolitGwangjuMembershipAdmission({ inventory, mappings, current, topology }) {
  const expectedSourceIds = [GWANGJU_TOPOLOGY_SOURCE_ID, GWANGJU_MEMBERSHIP_SOURCE_ID];
  const matches = inventory?.sources?.filter(({ membershipAdmissionEvidence: evidence }) =>
    evidence?.membershipSourceId === MOLIT_SOURCE_ID
      && JSON.stringify(evidence.lineIds) === JSON.stringify(["line-e57a361e8892"])) ?? [];
  const mappingSha256 = sha256(JSON.stringify(mappings));
  const stationCodesSha256 = sha256(JSON.stringify(mappings.map(({ stationNumber }) => stationNumber)));
  if (matches.length !== expectedSourceIds.length
    || JSON.stringify(matches.map(({ id }) => id).sort(compare)) !== JSON.stringify(expectedSourceIds.sort(compare))) {
    throw new Error("current MOLIT Gwangju membership admission is incomplete");
  }
  for (const { membershipAdmissionEvidence: evidence } of matches) {
    if (evidence.stationCount !== mappings.length
      || evidence.membershipSourceRawSha256 !== current.rawSha256
      || evidence.membershipSourceSnapshotSha256 !== current.rawSha256
      || evidence.mappingSha256 !== mappingSha256 || evidence.stationCodesSha256 !== stationCodesSha256
      || evidence.stationCodeSourceId !== GWANGJU_TOPOLOGY_SOURCE_ID
      || evidence.stationCodeSnapshotId !== topology?.topologyAdmissionEvidence?.snapshotId) {
      throw new Error("current MOLIT Gwangju membership admission is invalid");
    }
  }
}

function parse(bytes, label) {
  try { return JSON.parse(bytes); } catch { throw new Error(`current MOLIT ${label} is invalid`); }
}
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
