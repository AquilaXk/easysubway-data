import { createHash } from "node:crypto";

import { collectDaejeonAccessibility } from "../collect-daejeon-accessibility.mjs";
import { collectDaejeonRouteMapPositions } from "../collect-daejeon-route-map-positions.mjs";

const ACCESSIBILITY_SOURCE_ID = "daejeon-transportation-accessibility";
const MAP_SOURCE_ID = "daejeon-transportation-route-map-positions";
const TIMETABLE_SOURCE_ID = "daejeon-train-timetable";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function selectedSource(inventory, sourceId, evidenceKey) {
  const matches = inventory?.sources?.filter(({ id }) => id === sourceId) ?? [];
  if (matches.length !== 1 || !matches[0][evidenceKey]) {
    throw new Error(`Daejeon ${sourceId} admission evidence is required`);
  }
  return matches[0];
}

function snapshotPathIsSafe(relative) {
  return typeof relative === "string" && /^tools\/datapack\/sources\/[^/]+\.json$/u.test(relative);
}

function contentAddressedSnapshot(sourceId, snapshot) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const snapshotId = `${sourceId}-${sha256(bytes)}`;
  return {
    sourceId,
    bytes,
    snapshotId,
    relative: `tools/datapack/sources/${snapshotId}.json`,
  };
}

function replaceSource(inventory, sourceId, source) {
  inventory.sources = inventory.sources.map((row) => row.id === sourceId ? source : row);
}

function observedFacilityCount(rows) {
  return rows.reduce((count, row) => count
    + Number(row.elevator !== null)
    + Number(row.escalator !== null)
    + Number(row.wheelchair_lift !== null), 0);
}

function rebindTimetable({ inventory, topologySource, topologySnapshot, timetableSnapshotBytes }) {
  const source = selectedSource(inventory, TIMETABLE_SOURCE_ID, "scheduleAdmissionEvidence");
  const evidence = source.scheduleAdmissionEvidence;
  let snapshot;
  try {
    snapshot = JSON.parse(timetableSnapshotBytes);
  } catch {
    throw new Error("Daejeon timetable retained snapshot is invalid JSON");
  }
  if (!snapshotPathIsSafe(evidence.snapshotPath)
    || snapshot?.sourceId !== TIMETABLE_SOURCE_ID
    || snapshot.observedAt !== evidence.capturedAt
    || snapshot.rawSha256 !== evidence.rawSha256
    || snapshot.rowsSha256 !== evidence.rowsSha256
    || snapshot.rowCount !== evidence.rowCount) {
    throw new Error("Daejeon timetable retained snapshot binding changed");
  }
  replaceSource(inventory, TIMETABLE_SOURCE_ID, {
    ...source,
    scheduleAdmissionEvidence: {
      ...evidence,
      topologySourceId: topologySource.id,
      topologySnapshotId: topologySource.topologyAdmissionEvidence.snapshotId,
      topologyContentSha256: topologySnapshot.contentSha256,
    },
  });
  return { relative: evidence.snapshotPath, bytes: Buffer.from(timetableSnapshotBytes) };
}

export function buildDaejeonTopologyDependents({
  inventory,
  topologySnapshot,
  topologySource,
  mapXlsxBytes,
  schematicCanvas,
  elevatorBytes,
  escalatorBytes,
  canonicalStationMappings,
  timetableSnapshotBytes,
} = {}) {
  const nextInventory = structuredClone(inventory);
  const mapSource = selectedSource(nextInventory, MAP_SOURCE_ID, "routeMapAdmissionEvidence");
  const accessibilitySource = selectedSource(
    nextInventory,
    ACCESSIBILITY_SOURCE_ID,
    "accessibilityAdmissionEvidence",
  );
  const mapEvidence = mapSource.routeMapAdmissionEvidence;
  const accessibilityEvidence = accessibilitySource.accessibilityAdmissionEvidence;

  const mapSnapshot = collectDaejeonRouteMapPositions({
    xlsxBytes: mapXlsxBytes,
    topologySnapshot,
    topologySource,
    schematicCanvas,
    now: new Date(mapEvidence.capturedAt),
  });
  if (!snapshotPathIsSafe(mapEvidence.snapshotPath)
    || mapSnapshot.rawSha256 !== mapEvidence.rawSha256
    || mapSnapshot.capturedAt !== mapEvidence.capturedAt) {
    throw new Error("Daejeon route map raw bytes or observation changed");
  }

  const accessibilitySnapshot = collectDaejeonAccessibility({
    elevatorBytes,
    escalatorBytes,
    topologySnapshot,
    topologySource,
    canonicalStationMappings,
    now: new Date(accessibilityEvidence.capturedAt),
  });
  if (!snapshotPathIsSafe(accessibilityEvidence.snapshotPath)
    || accessibilitySnapshot.rawSha256 !== accessibilityEvidence.rawSha256
    || accessibilitySnapshot.capturedAt !== accessibilityEvidence.capturedAt
    || accessibilitySnapshot.freshUntil !== accessibilityEvidence.freshUntil) {
    throw new Error("Daejeon accessibility raw bytes or freshness changed");
  }

  const mapBinding = contentAddressedSnapshot(MAP_SOURCE_ID, mapSnapshot);
  const accessibilityBinding = contentAddressedSnapshot(ACCESSIBILITY_SOURCE_ID, accessibilitySnapshot);
  const topologyEvidence = topologySource.topologyAdmissionEvidence;
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
      observedDataUpdatedAt: mapSnapshot.observedDataUpdatedAt,
      topologySourceId: topologySource.id,
      topologySnapshotId: topologyEvidence.snapshotId,
      topologyContentSha256: topologySnapshot.contentSha256,
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

  const timetableInput = rebindTimetable({
    inventory: nextInventory,
    topologySource,
    topologySnapshot,
    timetableSnapshotBytes,
  });
  return {
    inventory: nextInventory,
    snapshots: [mapBinding, accessibilityBinding],
    timetableInput,
  };
}
