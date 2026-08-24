import { readFile } from "node:fs/promises";
import path from "node:path";

export async function currentTopologyAdmissionClock(repositoryRoot) {
  const inventory = JSON.parse(await readFile(
    path.join(repositoryRoot, "tools/datapack/source-inventory.json"),
    "utf8",
  ));
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
  return {
    inWindow: new Date(capturedAt + 1_000),
    expiredAt: new Date(freshUntil),
  };
}
