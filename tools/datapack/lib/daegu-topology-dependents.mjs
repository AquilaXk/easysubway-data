import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { DAEGU_LINES, daeguSourceSnapshotIdentity } from "../collect-daegu-datapack-sources.mjs";
import {
  collectDaeguRouteMapPositions,
  validateDaeguRouteMapPositionsSnapshot,
} from "../collect-daegu-route-map-positions.mjs";
import { daeguRouteMapTopologyLineageIdentity } from "../materialize-daegu-route-map-positions.mjs";

const MAP_SOURCE_ID = "daegu-transportation-route-map-positions";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function source(inventory, sourceId, evidenceKey) {
  const matches = inventory?.sources?.filter(({ id }) => id === sourceId) ?? [];
  if (matches.length !== 1 || !matches[0][evidenceKey]) {
    throw new Error(`Daegu ${sourceId} admission evidence is required`);
  }
  return matches[0];
}

function safeSnapshotPath(relative) {
  return typeof relative === "string" && /^tools\/datapack\/sources\/[^/]+\.json$/u.test(relative);
}

function replaceSource(inventory, sourceId, nextSource) {
  inventory.sources = inventory.sources.map((entry) => entry.id === sourceId ? nextSource : entry);
}

function parsedMapSnapshot(bytes) {
  try {
    return validateDaeguRouteMapPositionsSnapshot(JSON.parse(bytes));
  } catch {
    throw new Error("Daegu retained route map snapshot is invalid");
  }
}

function topologyLineages({ inventory, topologySnapshots, topologyInputs }) {
  if (!Array.isArray(topologyInputs) || topologyInputs.length !== DAEGU_LINES.length) {
    throw new Error("Daegu selected topology inputs are incomplete");
  }
  return DAEGU_LINES.map((config, index) => {
    const snapshot = topologySnapshots?.[config.lineNumber];
    const input = topologyInputs[index];
    const sourceId = `daegu-line${config.lineNumber}-route-topology`;
    const topologySource = source(inventory, sourceId, "topologyAdmissionEvidence");
    const evidence = topologySource.topologyAdmissionEvidence;
    const snapshotId = daeguSourceSnapshotIdentity(snapshot);
    let parsed;
    try { parsed = JSON.parse(input?.bytes); } catch { throw new Error(`Daegu topology input is invalid: ${config.lineNumber}`); }
    if (input?.sourceId !== sourceId || !Buffer.isBuffer(input.bytes)
      || !safeSnapshotPath(evidence.snapshotPath)
      || evidence.snapshotId !== snapshotId
      || evidence.snapshotPath !== `tools/datapack/sources/${snapshotId}.json`
      || evidence.contentSha256 !== snapshot?.contentSha256
      || !isDeepStrictEqual(parsed, snapshot)
      || input.absolute == null) {
      throw new Error(`Daegu selected topology binding changed: ${config.lineNumber}`);
    }
    return {
      sourceId,
      snapshotId,
      contentSha256: snapshot.contentSha256,
      lineId: config.lineId,
    };
  });
}

function nonLineageSnapshot(snapshot) {
  const copy = structuredClone(snapshot);
  delete copy.topologyLineages;
  return copy;
}

/**
 * 새로 admission된 topology에만 기존 공식 CSV map snapshot을 다시 결속한다.
 * 원문·관측시각·좌표 결과는 모두 동일해야 하며 lineage 외 차이는 허용하지 않는다.
 */
export function buildDaeguTopologyDependents({
  inventory,
  topologySnapshots,
  topologyInputs,
  mapSnapshotBytes,
  mapSnapshotAbsolute,
  csvInputs,
} = {}) {
  const nextInventory = structuredClone(inventory);
  const mapSource = source(nextInventory, MAP_SOURCE_ID, "routeMapAdmissionEvidence");
  const evidence = mapSource.routeMapAdmissionEvidence;
  if (!Buffer.isBuffer(mapSnapshotBytes) || typeof mapSnapshotAbsolute !== "string"
    || !safeSnapshotPath(evidence.snapshotPath)
    || evidence.snapshotSha256 !== sha256(mapSnapshotBytes)) {
    throw new Error("Daegu retained route map snapshot binding changed");
  }
  const retainedSnapshot = parsedMapSnapshot(mapSnapshotBytes);
  if (retainedSnapshot.sourceId !== MAP_SOURCE_ID
    || retainedSnapshot.capturedAt !== evidence.capturedAt
    || retainedSnapshot.rawSha256 !== evidence.rawSha256
    || retainedSnapshot.positionsSha256 !== evidence.positionsSha256
    || retainedSnapshot.observedDataUpdatedAt !== evidence.observedDataUpdatedAt) {
    throw new Error("Daegu retained route map admission changed");
  }
  if (!Array.isArray(csvInputs) || csvInputs.length !== DAEGU_LINES.length) {
    throw new Error("Daegu route map CSV inputs are incomplete");
  }
  const csvByDatasetId = {};
  for (const [index] of DAEGU_LINES.entries()) {
    const input = csvInputs[index];
    const datasetId = evidence.datasetIds?.[index];
    if (input?.datasetId !== datasetId || !Buffer.isBuffer(input.bytes) || typeof input.absolute !== "string") {
      throw new Error(`Daegu route map CSV input is invalid: ${datasetId}`);
    }
    csvByDatasetId[datasetId] = input.bytes;
  }
  const lineages = topologyLineages({ inventory: nextInventory, topologySnapshots, topologyInputs });
  const snapshot = collectDaeguRouteMapPositions({
    csvByDatasetId,
    topologySnapshots,
    now: new Date(evidence.capturedAt),
  });
  if (!isDeepStrictEqual(nonLineageSnapshot(snapshot), nonLineageSnapshot(retainedSnapshot))) {
    throw new Error("Daegu route map non-lineage snapshot changed");
  }
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const snapshotSha256 = sha256(bytes);
  const snapshotId = `${MAP_SOURCE_ID}-${snapshotSha256}`;
  const relative = `tools/datapack/sources/${snapshotId}.json`;
  const topologyContentSha256 = sha256(JSON.stringify(lineages));
  replaceSource(nextInventory, MAP_SOURCE_ID, {
    ...mapSource,
    routeMapAdmissionEvidence: {
      ...evidence,
      snapshotId,
      snapshotPath: relative,
      snapshotSha256,
      topologySnapshotId: daeguRouteMapTopologyLineageIdentity(lineages),
      topologyContentSha256,
      topologyLineages: lineages,
    },
  });
  return {
    inventory: nextInventory,
    snapshot: { relative, bytes, snapshotId, snapshotSha256 },
    inputs: [
      { absolute: mapSnapshotAbsolute, bytes: mapSnapshotBytes },
      ...csvInputs.map(({ absolute, bytes }) => ({ absolute, bytes })),
      ...topologyInputs.map(({ absolute, bytes }) => ({ absolute, bytes })),
    ],
  };
}
