import { createHash } from "node:crypto";

import {
  SEOUL_POSITION_SCHEMA_FINGERPRINT,
  projectMolit,
  projectPositions,
} from "./collect-current-static-network-successors.mjs";
import {
  buildSeoulRouteMapPositions,
  validateSeoulRouteMapPositionsSnapshot,
} from "./collect-seoul-route-map-positions.mjs";

const POSITION_SOURCE_ID = "seoul-metro-route-map-positions";
const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const SOURCE_ORDER = Object.freeze([POSITION_SOURCE_ID, MOLIT_SOURCE_ID]);
const LAYOUT_ALGORITHM_VERSION = "seoul-public-latlon-line-order-layout-v2";
const MOLIT_FIELDS = Object.freeze([
  "region_code", "region_name", "operator_name", "line_name", "station_sequence", "station_name",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_SELECTED_PATH = /(?:cyber|\.js(?:\b|$)|s3:\/\/|amazonaws\.com)/iu;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const snapshotId = (sourceId, capturedAt) => `${sourceId}-current-${capturedAt.replaceAll(/[-:.]/gu, "")}`;
const fail = (code) => { throw new Error(`V2_${code}`); };

function requireCapturedAt(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || Number.isNaN(Date.parse(value))) fail("CAPTURED_AT");
  return value;
}

function requireBytes(value, code) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) fail(code);
  return Buffer.from(value);
}

function exactlyOneSource(inventory, sourceId) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)
    || !Array.isArray(inventory.sources)) fail("SOURCE_INVENTORY");
  const sources = inventory.sources.filter((source) => source?.id === sourceId);
  if (sources.length !== 1) fail("SOURCE_INVENTORY");
  const source = sources[0];
  if (source.admissionEvidence?.sourceId !== sourceId
    || source.admissionEvidence?.decision !== "APPROVED") fail("SOURCE_INVENTORY");
  return source;
}

function assertNoForbiddenSelectedPath(value) {
  const visit = (current) => {
    if (typeof current === "string") {
      if (FORBIDDEN_SELECTED_PATH.test(current)) fail("SELECTED_PATH");
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
}

function validateTopology({ source, admittedTopologyBytes, admittedTopologyId }) {
  const admission = source.routeMapAdmissionEvidence?.currentTopologyAdmission;
  if (!admission || admission.schemaVersion !== 1
    || admission.artifactKind !== "capital-route-map-current-topology-admission"
    || admission.status !== "ADMITTED" || admission.topologySnapshotId !== admittedTopologyId
    || !Array.isArray(admission.topologyLineages) || admission.topologyLineages.length !== 8) {
    fail("TOPOLOGY");
  }
  let topology;
  try { topology = JSON.parse(admittedTopologyBytes.toString("utf8")); } catch { fail("TOPOLOGY"); }
  if (topology?.sourceId !== "capital-route-topology"
    || topology.artifactKind !== "capital-route-topology-snapshot"
    || topology.official !== true || topology.fixture !== false
    || topology.contentSha256 !== admission.topologyContentSha256
    || !SHA256.test(topology.contentSha256 ?? "")) fail("TOPOLOGY");
  for (const lineage of admission.topologyLineages) {
    if (lineage?.sourceId !== "capital-route-topology" || lineage.snapshotId !== admittedTopologyId
      || lineage.contentSha256 !== topology.contentSha256 || typeof lineage.lineId !== "string") {
      fail("TOPOLOGY");
    }
  }
  return topology;
}

function validateReceipt({ receipt, sourceId, id, capturedAt, rawBytes, extension, contentType }) {
  const rawSha256 = sha(rawBytes); const date = capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${sourceId}/${date}/${rawSha256}.${extension}`;
  if (!receipt || receipt.schemaVersion !== 1
    || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== sourceId || receipt.snapshotId !== id || receipt.capturedAt !== capturedAt
    || receipt.rawObjectSha256 !== rawSha256 || receipt.byteSize !== rawBytes.byteLength
    || receipt.contentType !== contentType || receipt.objectKey !== objectKey
    || typeof receipt.ociNamespace !== "string" || receipt.ociNamespace === ""
    || typeof receipt.bucket !== "string" || receipt.bucket === ""
    || receipt.rawObjectUri !== `oci://${receipt.ociNamespace}/${receipt.bucket}/${objectKey}`
    || !Number.isFinite(Date.parse(receipt.storedAt))
    || !Number.isFinite(Date.parse(receipt.rawRetentionExpiresAt))
    || Date.parse(receipt.storedAt) < Date.parse(capturedAt)
    || Date.parse(receipt.rawRetentionExpiresAt) <= Date.parse(receipt.storedAt)) fail("RECEIPT");
  return rawSha256;
}

function providerRecordHashes(records) {
  return records.map((record) => sha(JSON.stringify(record)));
}

function validateMolitProjection(records) {
  if (!Array.isArray(records) || records.length === 0
    || JSON.stringify(Object.keys(records[0] ?? {})) !== JSON.stringify(MOLIT_FIELDS)) {
    fail("MOLIT_SCHEMA");
  }
  return records;
}

function layoutEvidence(artifact) {
  const keys = [
    "layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256", "topologySnapshotIdentity",
    "lineOrderSha256", "aliasLedgerVersion", "aliasLedgerSha256", "rawPositionsSha256",
    "layoutPositionsSha256", "layoutTracksSha256", "semanticInputSha256", "semanticOutputSha256",
    "outputSchemaSha256",
  ];
  if (!artifact || artifact.layoutAlgorithmVersion !== LAYOUT_ALGORITHM_VERSION
    || keys.filter((key) => key.endsWith("Sha256")).some((key) => !SHA256.test(artifact[key] ?? ""))
    || typeof artifact.aliasLedgerVersion !== "string" || artifact.aliasLedgerVersion === ""
    || artifact.topologySnapshotIdentity !== `${artifact.topologySnapshotId}:${artifact.topologySnapshotSha256}`) {
    fail("LAYOUT");
  }
  return { ...Object.fromEntries(keys.map((key) => [key, artifact[key]])), layoutArtifactSha256: sha(canonicalBytes(artifact)) };
}

function observation({ sourceId, id, capturedAt, rawSha256, records, schemaFingerprint, receipt, layout = null }) {
  const value = {
    schemaVersion: 2,
    artifactKind: "public-static-network-v2-observation",
    sourceId,
    snapshotId: id,
    capturedAt,
    rawSha256,
    contentSha256: sha(canonicalBytes(records)),
    schemaFingerprint,
    rowCount: records.length,
    providerRecordHashes: providerRecordHashes(records),
    normalizedProjection: records,
    ...(layout == null ? {} : {
      routeMapLayoutEvidence: layout.evidence,
      routeMapLayoutArtifact: layout.artifact,
    }),
    rawReceipt: structuredClone(receipt),
  };
  return value;
}

// Pure producer: all external bytes and OCI receipts must be supplied by a
// tracked caller. It neither discovers nor persists any external state.
export function buildPublicStaticNetworkV2Observations({
  positionRawBytes,
  molitRawBytes,
  capturedAt,
  admittedTopologyBytes,
  admittedTopologyId,
  positionReceipt,
  molitReceipt,
  sourceInventory,
} = {}) {
  const captured = requireCapturedAt(capturedAt);
  const positionsBytes = requireBytes(positionRawBytes, "POSITIONS_RAW");
  const molitBytes = requireBytes(molitRawBytes, "MOLIT_RAW");
  const topologyBytes = requireBytes(admittedTopologyBytes, "TOPOLOGY");
  if (typeof admittedTopologyId !== "string" || admittedTopologyId === "") fail("TOPOLOGY");

  const positionSource = exactlyOneSource(sourceInventory, POSITION_SOURCE_ID);
  const molitSource = exactlyOneSource(sourceInventory, MOLIT_SOURCE_ID);
  if (positionSource.requiredForProductionPack !== true || positionSource.productionUseAllowed !== true
    || molitSource.requiredForProductionPack !== true) fail("SOURCE_INVENTORY");
  if ([positionSource, molitSource].some((source) => [
    "historicalPredecessorAudit", "projectionMigration", "migration", "rootSupersession",
  ].some((key) => Object.hasOwn(source, key)))) fail("HISTORICAL_PREDECESSOR");
  assertNoForbiddenSelectedPath(positionSource);
  assertNoForbiddenSelectedPath(molitSource);
  validateTopology({ source: positionSource, admittedTopologyBytes: topologyBytes, admittedTopologyId });

  const positions = projectPositions(positionsBytes, captured);
  const molit = validateMolitProjection(projectMolit(molitBytes));
  const positionId = snapshotId(POSITION_SOURCE_ID, captured);
  const molitId = snapshotId(MOLIT_SOURCE_ID, captured);
  const positionRawSha256 = validateReceipt({ receipt: positionReceipt, sourceId: POSITION_SOURCE_ID, id: positionId, capturedAt: captured, rawBytes: positionsBytes, extension: "json", contentType: "application/json" });
  const molitRawSha256 = validateReceipt({ receipt: molitReceipt, sourceId: MOLIT_SOURCE_ID, id: molitId, capturedAt: captured, rawBytes: molitBytes, extension: "csv", contentType: "text/csv; charset=euc-kr" });

  let artifact;
  try {
    artifact = buildSeoulRouteMapPositions({
      records: positions,
      topologySnapshotBytes: topologyBytes,
      topologySnapshotId: admittedTopologyId,
      rawSha256: positionRawSha256,
      now: new Date(captured),
    });
    validateSeoulRouteMapPositionsSnapshot(artifact, { topologySnapshotBytes: topologyBytes });
  } catch { fail("LAYOUT"); }
  const evidence = layoutEvidence(artifact);
  const positionObservation = observation({
    sourceId: POSITION_SOURCE_ID,
    id: positionId,
    capturedAt: captured,
    rawSha256: positionRawSha256,
    records: positions,
    schemaFingerprint: SEOUL_POSITION_SCHEMA_FINGERPRINT,
    receipt: positionReceipt,
    layout: { evidence, artifact },
  });
  const molitObservation = observation({
    sourceId: MOLIT_SOURCE_ID,
    id: molitId,
    capturedAt: captured,
    rawSha256: molitRawSha256,
    records: molit,
    schemaFingerprint: sha(JSON.stringify(MOLIT_FIELDS)),
    receipt: molitReceipt,
  });
  const currentLayoutAdmission = {
    schemaVersion: 2,
    artifactKind: "seoul-public-route-map-layout-admission",
    status: "ADMITTED",
    positionSnapshotId: positionId,
    snapshotPath: `tools/datapack/sources/${positionId}.json`,
    snapshotSha256: sha(canonicalBytes(positionObservation)),
    rawSha256: positionRawSha256,
    contentSha256: positionObservation.contentSha256,
    ...evidence,
  };
  if (currentLayoutAdmission.layoutAlgorithmVersion !== LAYOUT_ALGORITHM_VERSION
    || currentLayoutAdmission.snapshotSha256 !== sha(canonicalBytes(positionObservation))
    || currentLayoutAdmission.rawSha256 !== positionObservation.rawSha256
    || currentLayoutAdmission.contentSha256 !== positionObservation.contentSha256) fail("CURRENT_LAYOUT");
  const output = { sourceOrder: [...SOURCE_ORDER], observations: [positionObservation, molitObservation], currentLayoutAdmission };
  assertNoForbiddenSelectedPath(output);
  return output;
}
