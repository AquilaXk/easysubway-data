import { createHash } from "node:crypto";

import { collectGwangjuAccessibility } from "../collect-gwangju-accessibility.mjs";
import { collectGwangjuRouteMapPositions } from "../collect-gwangju-route-map-positions.mjs";

const ACCESSIBILITY_SOURCE_ID = "gwangju-transportation-accessibility";
const MAP_SOURCE_ID = "gwangju-transportation-route-map-positions";
const TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotBinding(sourceId, snapshot) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const date = sourceId === ACCESSIBILITY_SOURCE_ID
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(snapshot.capturedAt)).replaceAll("-", "")
    : null;
  const snapshotId = `${sourceId}-${sha256(bytes)}${date ? `-${date}` : ""}`;
  return {
    snapshotId,
    relative: `tools/datapack/sources/${snapshotId}.json`,
    bytes,
  };
}

function requiredSource(inventory, sourceId, evidenceKey) {
  const matches = inventory?.sources?.filter((source) => source?.id === sourceId) ?? [];
  if (matches.length !== 1 || !matches[0][evidenceKey]) {
    throw new Error(`missing Gwangju ${sourceId} admission evidence`);
  }
  return matches[0];
}

function replaceSource(inventory, sourceId, nextSource) {
  inventory.sources = inventory.sources.map((source) => (
    source.id === sourceId ? nextSource : source
  ));
}

function observedFacilityCount(rows) {
  return rows.reduce((count, row) => count
    + Number(row.elevator !== null)
    + Number(row.escalator !== null), 0);
}

// 새 topology를 이미 admission한 뒤, 원본 bytes가 같은 의존 snapshot만 다시 결속한다.
export function buildGwangjuTopologyDependents({
  inventory,
  topologySnapshot,
  topologySource,
  mapCsvBytes,
  schematicCanvas,
  elevatorBytes,
  escalatorBytes,
} = {}) {
  const topologyEvidence = topologySource?.topologyAdmissionEvidence;
  if (topologySource?.id !== TOPOLOGY_SOURCE_ID
    || typeof topologyEvidence?.snapshotId !== "string" || !topologyEvidence.snapshotId
    || topologyEvidence.snapshotPath !== `tools/datapack/sources/${topologyEvidence.snapshotId}.json`
    || topologyEvidence.contentSha256 !== topologySnapshot?.contentSha256) {
    throw new Error("Gwangju topology source is not admission-bound");
  }

  const nextInventory = structuredClone(inventory);
  const mapSource = requiredSource(nextInventory, MAP_SOURCE_ID, "routeMapAdmissionEvidence");
  const accessibilitySource = requiredSource(
    nextInventory,
    ACCESSIBILITY_SOURCE_ID,
    "accessibilityAdmissionEvidence",
  );
  const mapEvidence = mapSource.routeMapAdmissionEvidence;
  const accessibilityEvidence = accessibilitySource.accessibilityAdmissionEvidence;

  const mapSnapshot = collectGwangjuRouteMapPositions({
    csvBytes: mapCsvBytes,
    topologySnapshot,
    topologySnapshotId: topologyEvidence.snapshotId,
    schematicCanvas,
    now: new Date(mapEvidence.capturedAt),
  });
  if (mapSnapshot.rawSha256 !== mapEvidence.rawSha256) {
    throw new Error("Gwangju route map raw bytes changed");
  }
  const accessibilitySnapshot = collectGwangjuAccessibility({
    elevatorBytes,
    escalatorBytes,
    topologySnapshot,
    topologySource,
    now: new Date(accessibilityEvidence.capturedAt),
  });
  if (accessibilitySnapshot.rawSha256 !== accessibilityEvidence.rawSha256
    || accessibilitySnapshot.freshUntil !== accessibilityEvidence.freshUntil) {
    throw new Error("Gwangju accessibility admission freshness or raw bytes changed");
  }

  const mapBinding = snapshotBinding(MAP_SOURCE_ID, mapSnapshot);
  const accessibilityBinding = snapshotBinding(ACCESSIBILITY_SOURCE_ID, accessibilitySnapshot);
  replaceSource(nextInventory, MAP_SOURCE_ID, {
    ...mapSource,
    routeMapAdmissionEvidence: {
      ...mapEvidence,
      snapshotId: mapBinding.snapshotId,
      snapshotPath: mapBinding.relative,
      snapshotSha256: sha256(mapBinding.bytes),
      capturedAt: mapSnapshot.capturedAt,
      stationCount: mapSnapshot.stationCount,
      rawStationCount: mapSnapshot.rawStationCount,
      quarantinedCount: mapSnapshot.quarantinedCount,
      rawSha256: mapSnapshot.rawSha256,
      positionsSha256: mapSnapshot.positionsSha256,
      lineIds: mapSnapshot.lineIds,
      lineStationCounts: mapSnapshot.lineStationCounts,
      topologySourceId: mapSnapshot.topologySourceId,
      topologySnapshotId: mapSnapshot.topologySnapshotId,
      topologyContentSha256: mapSnapshot.topologyContentSha256,
      topologyLineages: mapSnapshot.topologyLineages,
    },
  });
  replaceSource(nextInventory, ACCESSIBILITY_SOURCE_ID, {
    ...accessibilitySource,
    fieldsProvided: accessibilitySnapshot.fieldsProvided,
    accessibilityAdmissionEvidence: {
      ...accessibilityEvidence,
      snapshotId: accessibilityBinding.snapshotId,
      snapshotPath: accessibilityBinding.relative,
      capturedAt: accessibilitySnapshot.capturedAt,
      freshUntil: accessibilitySnapshot.freshUntil,
      stationCount: accessibilitySnapshot.stationCount,
      rowCount: accessibilitySnapshot.rowCount,
      facilityCount: observedFacilityCount(accessibilitySnapshot.rows),
      rawSha256: accessibilitySnapshot.rawSha256,
      rowsSha256: accessibilitySnapshot.rowsSha256,
      datasetIds: accessibilitySnapshot.datasetIds,
      topologySourceId: topologySource.id,
      topologySnapshotId: topologyEvidence.snapshotId,
      topologyContentSha256: topologySnapshot.contentSha256,
      topologyLineages: accessibilitySnapshot.topologyLineages,
    },
  });

  return {
    inventory: nextInventory,
    snapshots: [
      { relative: mapBinding.relative, bytes: mapBinding.bytes },
      { relative: accessibilityBinding.relative, bytes: accessibilityBinding.bytes },
    ],
  };
}
