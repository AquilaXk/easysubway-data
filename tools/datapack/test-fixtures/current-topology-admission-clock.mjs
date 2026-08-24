import { readFile } from "node:fs/promises";
import path from "node:path";

export async function currentTopologyAdmissionClock(repositoryRoot) {
  const [inventory, candidate, snapshots] = await Promise.all([
    readFile(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const admissions = inventory.sources
    .map(({ routeMapAdmissionEvidence }) => routeMapAdmissionEvidence?.currentTopologyAdmission)
    .filter((admission) => admission?.topologySnapshotId != null);
  const admission = admissions[0];
  if (admission == null
    || admissions.some(({ topologySnapshotId, reviewedAt, freshUntil }) => topologySnapshotId !== admission.topologySnapshotId
      || reviewedAt !== admission.reviewedAt || freshUntil !== admission.freshUntil)) {
    throw new Error("current topology admission clock fixture is invalid");
  }
  const capturedAt = Date.parse(admission.reviewedAt);
  const freshUntil = Date.parse(admission.freshUntil);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(freshUntil) || freshUntil <= capturedAt + 1_000) {
    throw new Error("current topology admission clock fixture is invalid");
  }
  const staticSources = snapshots.filter(({ snapshotId, sourceId }) => candidate.sourceSnapshotIds?.includes(snapshotId)
    && ["molit-urban-rail-full-route", "seoul-metro-route-map-positions"].includes(sourceId));
  const staticSourceBasisAt = Math.max(...staticSources.flatMap(({ retrievedAt, sourceUpdatedAt }) => [retrievedAt, sourceUpdatedAt])
    .filter((value) => typeof value === "string")
    .map((value) => Date.parse(value)));
  if (staticSources.length !== 2 || !Number.isFinite(staticSourceBasisAt)) {
    throw new Error("current static source clock fixture is invalid");
  }
  const inWindowAt = Math.max(capturedAt, staticSourceBasisAt) + 1_000;
  if (inWindowAt >= freshUntil) throw new Error("current topology admission clock fixture is invalid");
  return {
    inWindow: new Date(inWindowAt),
    expiredAt: new Date(freshUntil),
  };
}
