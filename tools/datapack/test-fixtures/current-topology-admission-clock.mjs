import { readFile } from "node:fs/promises";
import path from "node:path";

export async function currentTopologyAdmissionClock(repositoryRoot) {
  const inventory = await readFile(
    path.join(repositoryRoot, "tools/datapack/source-inventory.json"),
    "utf8",
  ).then(JSON.parse);
  const admissions = inventory.sources
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.currentTopologyAdmission)
    .filter((admission) => admission?.topologySnapshotId != null);
  const admission = admissions[0];
  if (admission == null
    || admissions.some(({ topologySnapshotId, reviewedAt, freshUntil }) => topologySnapshotId !== admission.topologySnapshotId
      || reviewedAt !== admission.reviewedAt || freshUntil !== admission.freshUntil)) {
    throw new Error("current topology admission clock fixture is invalid");
  }
  const staticSourceIds = new Set(["seoul-metro-route-map-positions", "molit-urban-rail-full-route"]);
  const selected = inventory.sources.filter(({ id }) => staticSourceIds.has(id));
  if (selected.length !== 2 || new Set(selected.map(({ id }) => id)).size !== 2) {
    throw new Error("current topology admission clock fixture is invalid");
  }
  const staticBasisAt = Math.max(...selected.flatMap(({ retrievedAt, observedDataUpdatedAt }) => [Date.parse(retrievedAt), Date.parse(observedDataUpdatedAt)]));
  const capturedAt = Date.parse(admission.reviewedAt);
  const freshUntil = Date.parse(admission.freshUntil);
  const clockAt = Math.max(capturedAt, staticBasisAt) + 1_000;
  if (!Number.isFinite(capturedAt) || !Number.isFinite(staticBasisAt) || !Number.isFinite(freshUntil) || freshUntil <= clockAt) {
    throw new Error("current topology admission clock fixture is invalid");
  }
  return {
    inWindow: new Date(clockAt),
    expiredAt: new Date(freshUntil),
  };
}
