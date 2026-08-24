#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "../lib/is-main-module.mjs";
import { syncCanonicalFixture } from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { assertNoRetiredTransitReferences, projectRetiredTransitLines } from "./project-retired-transit-lines.mjs";
import { projectCanonicalRouteMapProvenance } from "./project-canonical-route-map-provenance.mjs";
import { applySchedule } from "./apply-kric-line4-pilot-schedule.mjs";
import {
  CAPITAL_MAP_LINE_IDS,
  buildCapitalTopologyReverificationEvidence,
  projectCapitalTopologyOwnership,
} from "./collect-capital-route-topology.mjs";
import {
  requireCurrentIncheonStationCodeDerivations,
  validateIncheonStationInfoSnapshot,
} from "./collect-incheon-station-info.mjs";
import {
  admittedCapitalLineEvidence,
  projectCapitalTopologyIntoCanonicalFixture,
} from "./build-datapack.mjs";
import { loadCapitalRouteTopologySnapshot } from "./apply-capital-route-topology-to-bundled-pack.mjs";
import { addCadence } from "./freshness-policy.mjs";
import { ROUTE_MAP_REVERIFICATION_CADENCE } from "./lib/route-map-admission-freshness.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import {
  CURRENT_MOLIT_FULL_ROUTE_ROW_COUNT,
  CURRENT_SEOUL_PUBLIC_POSITION_COUNT,
} from "./lib/static-network-successor-completeness.mjs";
import {
  CURRENT_SEOUL_PUBLIC_ROUTE_MAP_COVERAGE,
  CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS,
  materializeSeoulRouteMapPositions,
  verifyCurrentCapitalPublicRouteMapDocument,
} from "./materialize-seoul-route-map-positions.mjs";
import {
  requiresCurrentCapitalTopologyAdmission,
  withCurrentCapitalTopologyAdmissions,
} from "./rebind-capital-route-map-admissions.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const STATIC_REVALIDATION_SOURCE_IDS = Object.freeze([
  "seoulmetro-station-line-info",
]);
const STATIC_REVALIDATION_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "contractVersion", "sourceId", "previousSnapshotId",
  "observedAt", "operation", "rowCount", "canonicalRawSha256", "schemaFingerprint",
  "providerRecordHashesSha256", "responseSha256", "outcome", "credentialRedacted",
  "evidenceSha256",
]);
const STATIC_CHANGE_ADMISSION_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "contractVersion", "sourceId", "previousSnapshotId",
  "observedAt", "operation", "rowCount", "canonicalRawSha256", "schemaFingerprint",
  "redactedRequestFingerprint", "providerRecordHashesSha256", "responseSha256",
  "canonicalPackSha256", "canonicalMembershipSha256", "rawObjectUri", "outcome",
  "credentialRedacted", "evidenceSha256",
]);
const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const MAX_BUFFER = 64 * 1024 * 1024;

export const CURRENT_SOURCE_INVENTORY_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info",
  "seoul-metro-route-map-positions", "kric-subway-timetable",
  "seoul-metro-accessibility", "kric-station-convenience-standard",
  "seoul-metro-official-od-fares",
]);
export const CURRENT_PRODUCTION_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info",
  "kric-subway-timetable", "seoul-metro-accessibility",
  "kric-station-convenience-standard", "seoul-metro-official-od-fares",
]);

export const CURRENT_SOURCE_HANDOFF = Object.freeze({
  hubCommit: "9251acdcc563975e8757d61f03e398d10c935d8b",
  rawSizeBytes: 12_657_973,
  rawSha256: "d8ee1a9351ade3465a955ffabeade294eaccf65449fc1fc1998240fdba87e064",
  rawObjectUri: "oci://easysubway-datapacks/source-raw/kric-subway-timetable/20260809/d8ee1a9351ade3465a955ffabeade294eaccf65449fc1fc1998240fdba87e064.json",
  snapshotId: "kric-subway-timetable-line4-pilot-20260809",
  previousSnapshotId: "kric-subway-timetable-line4-pilot-20260709",
  collectedAt: "2026-08-09T12:04:20.479Z",
  serviceEffectiveUntil: "2026-12-31T00:00:00Z",
  rowCount: 466,
  coverageCount: 1,
  freshnessExpiresAt: "2026-09-08T12:04:20.479Z",
  rawRetentionExpiresAt: "2026-11-07T12:04:20.479Z",
  redactedRequestFingerprint: "bb6302775c0afecf0b5e6d3c7e4bf89cdec4a2cfef01fbb80d2ea5ace234f0f7",
  schemaFingerprint: "44585c58909db0d14ed103ecf357291e4f337fc432e9e8938043a39097d904ff",
  governancePolicyVersion: "2026-07-15",
  governancePolicySha256: "96fb678f2ec5da7f555d81d9d2009ac838e6145cc48ed2ae4757bce42c90ef70",
});

export const CURRENT_SOURCE_ACTIVATION_OUTPUTS = Object.freeze([
  "tools/datapack/release/source-snapshots.json", "tools/datapack/source-inventory.json", "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "tools/datapack/release/capital-production-reviewed-pack.json", "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json",
]);
export const CURRENT_TOPOLOGY_REFRESH_OUTPUTS = Object.freeze([
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
]);
const allowedOutputPaths = new Set(CURRENT_SOURCE_ACTIVATION_OUTPUTS);
const CURRENT_SOURCE_DOWNSTREAM_OUTPUTS = Object.freeze([
  "tools/datapack/reports/nationwide-coverage-tally.json",
  "tools/datapack/release/strict-route-regression-report.json",
]);

function isAllowedActivationOutput(relativePath) {
  return allowedOutputPaths.has(relativePath)
    || /^tools\/datapack\/release\/capital-topology-reverification-[0-9]{8}\.json$/u
      .test(relativePath ?? "");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJsonSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(value)}\n`));
}

function requireOne(rows, predicate, label) {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label} must have exactly one match`);
  return matches[0];
}

function requireCurrentSuccessorReceipt(snapshot, extension, contentType) {
  const date = snapshot.retrievedAt?.slice(0, 10).replaceAll("-", "");
  const objectKey = date == null
    ? null
    : `source-raw/${snapshot.sourceId}/${date}/${snapshot.rawSha256}.${extension}`;
  const receipt = snapshot.rawReceipt;
  const expectedUri = objectKey == null
    ? null
    : `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`;
  if (!SHA256.test(snapshot.rawSha256 ?? "")
    || snapshot.rawObjectUri !== expectedUri
    || receipt?.schemaVersion !== 1
    || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== snapshot.sourceId
    || receipt.snapshotId !== snapshot.snapshotId
    || receipt.capturedAt !== snapshot.retrievedAt
    || receipt.rawObjectSha256 !== snapshot.rawSha256
    || receipt.rawObjectUri !== snapshot.rawObjectUri
    || receipt.ociNamespace !== "axvym6vk8g7i"
    || receipt.bucket !== "easysubway-datapacks"
    || receipt.objectKey !== objectKey
    || receipt.contentType !== contentType
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 1) {
    throw new Error("current successor OCI receipt binding is invalid");
  }
}

function requireCurrentInventoryHead(sourceInventory, snapshot) {
  const source = requireOne(
    sourceInventory.sources,
    ({ id }) => id === snapshot.sourceId,
    `current successor inventory ${snapshot.sourceId}`,
  );
  const admission = source.admissionEvidence;
  if (admission?.snapshotId !== snapshot.snapshotId
    || admission.rawSha256 !== snapshot.rawSha256
    || admission.schemaFingerprint !== snapshot.schemaFingerprint) {
    throw new Error("current successor inventory head binding is invalid");
  }
  return source;
}

// The static five-record sample is not an activation authority.  The successor
// transaction is the only way the full national membership and public Seoul
// coordinate heads become current.
export function verifyCurrentStaticNetworkSuccessorHeads({ sourceSnapshots, sourceInventory }) {
  if (!Array.isArray(sourceSnapshots)
    || sourceInventory?.schemaVersion !== 1
    || sourceInventory.artifactKind !== "production-source-inventory"
    || !Array.isArray(sourceInventory.sources)) {
    throw new Error("current successor inputs are invalid");
  }
  const heads = validateLineage(sourceSnapshots).headsBySource;
  const headFor = (sourceId) => requireOne(
    sourceSnapshots,
    ({ snapshotId }) => snapshotId === heads[sourceId],
    `current successor head ${sourceId}`,
  );
  const molit = headFor("molit-urban-rail-full-route");
  const molitPrevious = requireOne(
    sourceSnapshots,
    ({ snapshotId }) => snapshotId === molit.previousSnapshotId,
    "current full route predecessor",
  );
  const migration = molit.projectionMigration;
  if (molit.sourceId !== "molit-urban-rail-full-route"
    || !Array.isArray(molit.providerRecordHashes)
    || molit.rowCount !== CURRENT_MOLIT_FULL_ROUTE_ROW_COUNT
    || molit.coverageCount !== molit.rowCount
    || molit.providerRecordHashes.length !== molit.rowCount
    || molit.providerRecordHashes.some((value) => !SHA256.test(value ?? ""))
    || !SHA256.test(molit.contentSha256 ?? "")
    || !SHA256.test(molit.schemaFingerprint ?? "")
    || migration?.migrationKind !== "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS"
    || migration.sourceId !== molit.sourceId
    || migration.legacySnapshotId !== molitPrevious.snapshotId
    || migration.legacyRawSha256 !== molitPrevious.rawSha256
    || migration.legacySchemaFingerprint !== molitPrevious.schemaFingerprint
    || JSON.stringify(migration.legacyProviderRecordHashes) !== JSON.stringify(molitPrevious.providerRecordHashes)
    || migration.fullProjectionSha256 !== molit.contentSha256
    || migration.fullProjectionSchemaFingerprint !== molit.schemaFingerprint
    || migration.fullProjectionRowCount !== molit.rowCount
    || migration.newSnapshotId !== molit.snapshotId) {
    throw new Error("current full route successor binding is invalid");
  }
  requireCurrentSuccessorReceipt(molit, "csv", "text/csv; charset=euc-kr");
  requireCurrentInventoryHead(sourceInventory, molit);

  const positions = headFor("seoul-metro-route-map-positions");
  const replacement = positions.projectionMigration;
  const replaced = requireOne(
    sourceSnapshots,
    ({ snapshotId }) => snapshotId === replacement?.replacedSnapshotId,
    "current public route map predecessor",
  );
  if (positions.sourceId !== "seoul-metro-route-map-positions"
    || positions.previousSnapshotId !== null
    || positions.diffSummary !== null
    || positions.rowCount !== CURRENT_SEOUL_PUBLIC_POSITION_COUNT
    || !Array.isArray(positions.providerRecordHashes)
    || positions.providerRecordHashes.length !== positions.rowCount
    || positions.providerRecordHashes.some((value) => !SHA256.test(value ?? ""))
    || replacement?.migrationKind !== "CROSS_SOURCE_CANONICAL_REPLACEMENT"
    || replacement.sourceId !== positions.sourceId
    || replacement.replacedSourceId !== "seoulmetro-cyberstation-route-map"
    || replacement.replacedSnapshotId !== replaced.snapshotId
    || replacement.replacedRawSha256 !== replaced.rawSha256
    || replacement.replacedSchemaFingerprint !== replaced.schemaFingerprint
    || replacement.candidateSlotSourceId !== replacement.replacedSourceId) {
    throw new Error("current public route map successor binding is invalid");
  }
  requireCurrentSuccessorReceipt(positions, "json", "application/json");
  const positionSource = requireCurrentInventoryHead(sourceInventory, positions);
  const layout = positions.routeMapLayoutEvidence;
  const artifact = positions.routeMapLayoutArtifact;
  const currentLayout = positionSource.routeMapAdmissionEvidence?.currentLayoutAdmission;
  const layoutKeys = [
    "layoutAlgorithmVersion", "topologySnapshotId", "topologySnapshotSha256",
    "topologySnapshotIdentity", "lineOrderSha256", "aliasLedgerVersion", "aliasLedgerSha256",
    "rawPositionsSha256", "layoutPositionsSha256", "layoutTracksSha256", "semanticInputSha256",
    "semanticOutputSha256", "outputSchemaSha256", "layoutArtifactSha256",
  ];
  if (!layout || !artifact || artifact.rawSha256 !== positions.rawSha256
    || layout.layoutArtifactSha256 !== canonicalJsonSha256(artifact)
    || layoutKeys.some((key) => key !== "layoutArtifactSha256"
      && (layout[key] == null || layout[key] !== artifact[key]))
    || positionSource.requiredForProductionPack !== true
    || positionSource.productionUseAllowed !== true
    || currentLayout?.schemaVersion !== 2
    || currentLayout.artifactKind !== "seoul-public-route-map-layout-admission"
    || currentLayout.status !== "ADMITTED"
    || currentLayout.positionSnapshotId !== positions.snapshotId
    || currentLayout.snapshotPath !== `tools/datapack/sources/${positions.snapshotId}.json`
    || currentLayout.snapshotSha256 !== positions.normalizedObservationSha256
    || currentLayout.rawSha256 !== positions.rawSha256
    || currentLayout.contentSha256 !== positions.contentSha256
    || layoutKeys.some((key) => currentLayout[key] !== layout[key])) {
    throw new Error("current public route map layout admission binding is invalid");
  }
  const cyber = sourceInventory.sources.filter(({ id }) => id === "seoulmetro-cyberstation-route-map");
  if (cyber.length > 1 || cyber.some(({ requiredForProductionPack, productionUseAllowed }) =>
    requiredForProductionPack === true || productionUseAllowed === true)) {
    throw new Error("legacy route map source cannot be current production");
  }
  return { molit, positions };
}

function validateHandoff(handoff, rawArtifact, rawArtifactBytes) {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)
    || !/^[0-9a-f]{40}$/u.test(handoff.hubCommit ?? "")
    || !Number.isSafeInteger(handoff.rawSizeBytes) || handoff.rawSizeBytes <= 0
    || !SHA256.test(handoff.rawSha256 ?? "")
    || !SHA256.test(handoff.schemaFingerprint ?? "")
    || !SHA256.test(handoff.redactedRequestFingerprint ?? "")
    || !SHA256.test(handoff.governancePolicySha256 ?? "")
    || typeof handoff.rawObjectUri !== "string"
    || handoff.rawObjectUri !== `oci://easysubway-datapacks/source-raw/kric-subway-timetable/20260809/${handoff.rawSha256}.json`
    || !/^kric-subway-timetable-line4-pilot-[0-9]{8}$/u.test(handoff.snapshotId ?? "")
    || typeof handoff.previousSnapshotId !== "string"
    || !Number.isSafeInteger(handoff.rowCount) || handoff.rowCount <= 0
    || !Number.isSafeInteger(handoff.coverageCount) || handoff.coverageCount <= 0
    || typeof handoff.governancePolicyVersion !== "string") {
    throw new Error("current source handoff identity is invalid");
  }
  for (const [label, value] of [
    ["collectedAt", handoff.collectedAt],
    ["serviceEffectiveUntil", handoff.serviceEffectiveUntil],
    ["freshnessExpiresAt", handoff.freshnessExpiresAt],
    ["rawRetentionExpiresAt", handoff.rawRetentionExpiresAt],
  ]) {
    try {
      requiredUtcInstant(value, `current source handoff ${label}`);
    } catch {
      throw new Error(`current source handoff ${label} is invalid`);
    }
  }
  if (!Buffer.isBuffer(rawArtifactBytes)
    || rawArtifactBytes.length !== handoff.rawSizeBytes
    || sha256(rawArtifactBytes) !== handoff.rawSha256) {
    throw new Error("current source raw artifact byte identity mismatch");
  }
  if (rawArtifact?.collectedAt !== handoff.collectedAt) {
    throw new Error("current source raw artifact collection identity mismatch");
  }
}

function currentKricSnapshot(previous, handoff) {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: handoff.snapshotId,
    sourceId: "kric-subway-timetable",
    provider: "국가철도공단",
    retrievedAt: handoff.collectedAt,
    sourceUpdatedAt: handoff.collectedAt,
    serviceEffectiveAt: handoff.collectedAt,
    serviceEffectiveUntil: handoff.serviceEffectiveUntil,
    rowCount: handoff.rowCount,
    coverageCount: handoff.coverageCount,
    rawSha256: handoff.rawSha256,
    rawObjectUri: handoff.rawObjectUri,
    redactedRequestFingerprint: handoff.redactedRequestFingerprint,
    schemaFingerprint: handoff.schemaFingerprint,
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    previousSnapshotId: previous.snapshotId,
    diffSummary: null,
    freshnessExpiresAt: handoff.freshnessExpiresAt,
    rawRetentionExpiresAt: handoff.rawRetentionExpiresAt,
    governancePolicyVersion: handoff.governancePolicyVersion,
    governancePolicySha256: handoff.governancePolicySha256,
  };
  snapshot.diffSummary = buildSnapshotDiff(previous, snapshot);
  return snapshot;
}

function activateInventory(sourceInventory, handoff) {
  if (sourceInventory?.schemaVersion !== 1
    || sourceInventory.artifactKind !== "production-source-inventory"
    || !Array.isArray(sourceInventory.sources)) {
    throw new Error("current source inventory identity is invalid");
  }
  const next = structuredClone(sourceInventory);
  for (const sourceId of CURRENT_SOURCE_INVENTORY_IDS) {
    requireOne(next.sources, ({ id }) => id === sourceId, `current source inventory ${sourceId}`);
  }
  const timetable = requireOne(
    next.sources,
    ({ id }) => id === "kric-subway-timetable",
    "current timetable source",
  );
  if (!timetable.admissionEvidence || typeof timetable.admissionEvidence !== "object") {
    throw new Error("current timetable source admission evidence is missing");
  }
  timetable.observedDataUpdatedAt = handoff.collectedAt.slice(0, 10);
  timetable.retrievedAt = handoff.collectedAt.slice(0, 10);
  timetable.admissionEvidence.snapshotId = handoff.snapshotId;
  timetable.admissionEvidence.rawSha256 = handoff.rawSha256;
  timetable.admissionEvidence.schemaFingerprint = handoff.schemaFingerprint;

  const routeMapPositions = requireOne(
    next.sources,
    ({ id }) => id === "seoul-metro-route-map-positions",
    "current public route-map source",
  );
  routeMapPositions.coverageScope = {
    ...routeMapPositions.coverageScope,
    operatorIds: [...CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS],
  };

  const convenience = requireOne(
    next.sources,
    ({ id }) => id === "kric-station-convenience-standard",
    "current convenience source",
  );
  convenience.requiredForProductionPack = true;
  convenience.productionUseAllowed = true;
  if (convenience.admissionEvidence && typeof convenience.admissionEvidence === "object") {
    convenience.admissionEvidence.productionUseNoteKo =
      "fresh exhaustive snapshot과 reviewed accessibility evidence에 결속된 static facility rows만 production use를 허용한다.";
  }
  return next;
}

function exactObjectKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((key, index) => key === expected[index]);
}

export function verifyCurrentSeoulCanonicalMembership(canonicalPackBytes, snapshot) {
  if (!Buffer.isBuffer(canonicalPackBytes) || canonicalPackBytes.length === 0
    || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || !SHA256.test(snapshot.rawSha256 ?? "")
    || !Array.isArray(snapshot.providerRecordHashes)
    || snapshot.providerRecordHashes.length !== 5
    || new Set(snapshot.providerRecordHashes).size !== snapshot.providerRecordHashes.length
    || snapshot.providerRecordHashes.some((value) => !SHA256.test(value ?? ""))) {
    throw new Error("current Seoul canonical membership mismatch");
  }

  let document;
  try {
    document = JSON.parse(canonicalPackBytes.toString("utf8"));
  } catch {
    throw new Error("current Seoul canonical membership mismatch");
  }
  if (!Array.isArray(document?.packs)) {
    throw new Error("current Seoul canonical membership mismatch");
  }
  const capitalPacks = document.packs.filter(({ id }) => id === "capital");
  if (capitalPacks.length !== 1
    || !Array.isArray(capitalPacks[0].stations)
    || !Array.isArray(capitalPacks[0].stationLines)) {
    throw new Error("current Seoul canonical membership mismatch");
  }

  const capital = capitalPacks[0];
  const stationsById = new Map();
  for (const station of capital.stations) {
    if (typeof station?.id !== "string" || station.id.length === 0
      || typeof station.nameKo !== "string" || station.nameKo.length === 0
      || stationsById.has(station.id)) {
      throw new Error("current Seoul canonical membership mismatch");
    }
    stationsById.set(station.id, station);
  }

  const lineStationIds = [];
  const seenLineStationIds = new Set();
  for (const stationLine of capital.stationLines) {
    if (stationLine?.lineId !== "seoul-4") continue;
    if (typeof stationLine.stationId !== "string"
      || seenLineStationIds.has(stationLine.stationId)
      || !stationsById.has(stationLine.stationId)) {
      throw new Error("current Seoul canonical membership mismatch");
    }
    seenLineStationIds.add(stationLine.stationId);
    lineStationIds.push(stationLine.stationId);
  }
  if (lineStationIds.length === 0) {
    throw new Error("current Seoul canonical membership mismatch");
  }

  const targetHashes = new Set(snapshot.providerRecordHashes);
  const matches = new Map();
  for (const stationId of lineStationIds) {
    const station = stationsById.get(stationId);
    for (let code = 0; code <= 9_999; code += 1) {
      const record = {
        line: "04호선",
        station_code: String(code).padStart(4, "0"),
        station_name: station.nameKo,
      };
      const recordHash = sha256(JSON.stringify(record));
      if (!targetHashes.has(recordHash)) continue;
      if (matches.has(recordHash)) {
        throw new Error("current Seoul canonical membership mismatch");
      }
      matches.set(recordHash, { record, stationId });
    }
  }
  if (matches.size !== snapshot.providerRecordHashes.length) {
    throw new Error("current Seoul canonical membership mismatch");
  }

  const orderedMatches = snapshot.providerRecordHashes.map((recordHash) => matches.get(recordHash));
  const records = orderedMatches.map(({ record }) => record);
  if (sha256(Buffer.from(`${JSON.stringify(records)}\n`)) !== snapshot.rawSha256) {
    throw new Error("current Seoul canonical membership mismatch");
  }
  return sha256(JSON.stringify(orderedMatches.map(({ record, stationId }) => ({
    stationCode: record.station_code,
    stationName: record.station_name,
    canonicalStationId: stationId,
    canonicalLineId: "seoul-4",
  }))));
}

function validateStaticSourceChangeAdmission(
  previous,
  snapshot,
  evidence,
  sourceId,
  canonicalPackSha256,
  canonicalMembershipSha256,
) {
  if (!exactObjectKeys(evidence, STATIC_CHANGE_ADMISSION_EVIDENCE_KEYS)) {
    throw new Error("static revalidation evidence shape mismatch");
  }
  const { evidenceSha256, ...payload } = evidence;
  const observedMillis = requiredUtcInstant(evidence.observedAt, "static revalidation observedAt");
  const expectedDate = evidence.observedAt.slice(0, 10).replaceAll("-", "");
  const expectedRawObjectUri =
    `oci://easysubway-datapacks/source-raw/${sourceId}/${expectedDate}/${snapshot.rawSha256}.json`;
  const expectedDiff = buildSnapshotDiff(previous, snapshot);
  if (sourceId !== "seoulmetro-station-line-info"
    || evidence.schemaVersion !== 1
    || evidence.artifactKind !== "current-static-source-change-admission-evidence"
    || evidence.contractVersion !== "1.0.0"
    || evidence.sourceId !== sourceId
    || evidence.previousSnapshotId !== previous.snapshotId
    || evidence.observedAt !== snapshot.retrievedAt
    || evidence.operation !== "seoulmetro-line4-stations-one-to-five"
    || evidence.rowCount !== 5
    || evidence.canonicalRawSha256 !== snapshot.rawSha256
    || evidence.schemaFingerprint !== snapshot.schemaFingerprint
    || evidence.redactedRequestFingerprint !== snapshot.redactedRequestFingerprint
    || evidence.providerRecordHashesSha256 !== sha256(JSON.stringify(snapshot.providerRecordHashes))
    || !SHA256.test(evidence.responseSha256 ?? "")
    || !SHA256.test(evidence.canonicalPackSha256 ?? "")
    || !SHA256.test(canonicalPackSha256 ?? "")
    || !SHA256.test(evidence.canonicalMembershipSha256 ?? "")
    || !SHA256.test(canonicalMembershipSha256 ?? "")
    || evidence.canonicalMembershipSha256 !== canonicalMembershipSha256
    || evidence.rawObjectUri !== snapshot.rawObjectUri
    || evidence.outcome !== "CONTENT_CHANGE_ADMITTED"
    || evidence.credentialRedacted !== true
    || evidenceSha256 !== sha256(JSON.stringify(payload))
    || snapshot.sourceId !== sourceId
    || snapshot.snapshotId !== `${sourceId}-change-admitted-${expectedDate}`
    || snapshot.previousSnapshotId !== previous.snapshotId
    || snapshot.rawObjectUri !== expectedRawObjectUri
    || snapshot.provider !== previous.provider
    || snapshot.sourceUpdatedAt !== previous.sourceUpdatedAt
    || snapshot.rowCount !== previous.rowCount
    || snapshot.coverageCount !== (previous.coverageCount ?? previous.rowCount)
    || snapshot.schemaFingerprint !== previous.schemaFingerprint
    || snapshot.rawSha256 === previous.rawSha256
    || snapshot.redactedRequestFingerprint === previous.redactedRequestFingerprint
    || !Array.isArray(snapshot.providerRecordHashes)
    || snapshot.providerRecordHashes.length !== 5
    || snapshot.providerRecordHashes.some((value) => !SHA256.test(value ?? ""))
    || snapshot.freshnessExpiresAt
      !== new Date(observedMillis + 30 * 24 * 60 * 60 * 1000).toISOString()
    || snapshot.rawRetentionExpiresAt
      !== new Date(observedMillis + 90 * 24 * 60 * 60 * 1000).toISOString()
    || snapshot.revalidationEvidenceSha256 !== evidenceSha256
    || JSON.stringify(snapshot.diffSummary) !== JSON.stringify(expectedDiff)
    || JSON.stringify(expectedDiff) !== JSON.stringify({
      status: "CHANGED",
      rawHashChanged: true,
      schemaHashChanged: false,
      requestHashChanged: true,
      sourceUpdatedAtChanged: false,
      rowDelta: 0,
      coverageDelta: 0,
    })) {
    throw new Error("static revalidation evidence identity mismatch");
  }
}

function validateStaticRevalidation(
  previous,
  snapshot,
  evidence,
  sourceId,
  canonicalPackSha256,
  canonicalMembershipSha256,
) {
  if (evidence?.artifactKind === "current-static-source-change-admission-evidence") {
    validateStaticSourceChangeAdmission(
      previous,
      snapshot,
      evidence,
      sourceId,
      canonicalPackSha256,
      canonicalMembershipSha256,
    );
    return;
  }
  if (!exactObjectKeys(evidence, STATIC_REVALIDATION_EVIDENCE_KEYS)) {
    throw new Error("static revalidation evidence shape mismatch");
  }
  const { evidenceSha256, ...payload } = evidence;
  const observedMillis = requiredUtcInstant(evidence.observedAt, "static revalidation observedAt");
  const expectedDate = evidence.observedAt.slice(0, 10).replaceAll("-", "");
  const expectedOperation = "seoulmetro-line4-stations-one-to-five";
  if (evidence.schemaVersion !== 1
    || evidence.artifactKind !== "current-static-source-revalidation-evidence"
    || evidence.contractVersion !== "1.0.0"
    || evidence.sourceId !== sourceId
    || evidence.previousSnapshotId !== previous.snapshotId
    || evidence.observedAt !== snapshot.retrievedAt
    || evidence.operation !== expectedOperation
    || evidence.rowCount !== 5
    || evidence.canonicalRawSha256 !== snapshot.rawSha256
    || evidence.schemaFingerprint !== snapshot.schemaFingerprint
    || evidence.providerRecordHashesSha256 !== sha256(JSON.stringify(snapshot.providerRecordHashes))
    || !SHA256.test(evidence.responseSha256 ?? "")
    || evidence.outcome !== "NO_CHANGE_REVALIDATED"
    || evidence.credentialRedacted !== true
    || evidenceSha256 !== sha256(JSON.stringify(payload))
    || snapshot.sourceId !== sourceId
    || snapshot.snapshotId !== `${sourceId}-revalidated-${expectedDate}`
    || snapshot.previousSnapshotId !== previous.snapshotId
    || snapshot.rawObjectUri !== previous.rawObjectUri
    || snapshot.provider !== previous.provider
    || JSON.stringify(snapshot.providerRecordHashes) !== JSON.stringify(previous.providerRecordHashes)
    || snapshot.freshnessExpiresAt !== new Date(observedMillis + 30 * 24 * 60 * 60 * 1000).toISOString()
    || snapshot.rawRetentionExpiresAt !== new Date(observedMillis + 90 * 24 * 60 * 60 * 1000).toISOString()
    || snapshot.revalidationEvidenceSha256 !== evidenceSha256
    || snapshot.diffSummary?.status !== "NO_CHANGE") {
    throw new Error("static revalidation evidence identity mismatch");
  }
}

export function activateStaticSourceRevalidations({
  sourceSnapshots,
  sourceInventory,
  revalidations,
  governancePolicyBinding,
  canonicalPackSha256 = null,
  canonicalMembershipSha256 = null,
  buildNow,
  observationDate,
}) {
  if (!Array.isArray(sourceSnapshots)
    || !Array.isArray(revalidations)
    || revalidations.length !== STATIC_REVALIDATION_SOURCE_IDS.length
    || sourceInventory?.schemaVersion !== 1
    || sourceInventory.artifactKind !== "production-source-inventory"
    || !Array.isArray(sourceInventory.sources)) {
    throw new Error("static revalidation inputs are invalid");
  }
  if (typeof governancePolicyBinding?.governancePolicyVersion !== "string"
    || governancePolicyBinding.governancePolicyVersion.length === 0
    || !SHA256.test(governancePolicyBinding.governancePolicySha256 ?? "")) {
    throw new Error("static revalidation governance policy binding is invalid");
  }
  const buildMillis = requiredUtcInstant(buildNow, "static revalidation buildNow");
  if (!/^[0-9]{8}$/u.test(observationDate ?? "")) {
    throw new Error("static revalidation observation date mismatch");
  }
  const heads = validateLineage(sourceSnapshots).headsBySource;
  const nextSnapshots = structuredClone(sourceSnapshots);
  const nextInventory = structuredClone(sourceInventory);
  for (const [index, sourceId] of STATIC_REVALIDATION_SOURCE_IDS.entries()) {
    const revalidation = revalidations[index];
    if (revalidation?.snapshot?.sourceId !== sourceId || revalidation?.evidence?.sourceId !== sourceId) {
      throw new Error("static revalidation source order mismatch");
    }
    const head = requireOne(sourceSnapshots, ({ snapshotId }) => snapshotId === heads[sourceId], `static revalidation head ${sourceId}`);
    const reusesCurrentHead = revalidation.snapshot.snapshotId === head.snapshotId;
    const previous = reusesCurrentHead
      ? requireOne(sourceSnapshots, ({ snapshotId }) => snapshotId === head.previousSnapshotId, `static revalidation predecessor ${sourceId}`)
      : head;
    validateStaticRevalidation(
      previous,
      revalidation.snapshot,
      revalidation.evidence,
      sourceId,
      canonicalPackSha256,
      canonicalMembershipSha256,
    );
    const observedMillis = requiredUtcInstant(
      revalidation.snapshot.retrievedAt,
      "static revalidation retrievedAt",
    );
    const freshnessMillis = requiredUtcInstant(
      revalidation.snapshot.freshnessExpiresAt,
      "static revalidation freshnessExpiresAt",
    );
    if (revalidation.snapshot.retrievedAt.slice(0, 10).replaceAll("-", "") !== observationDate) {
      throw new Error("static revalidation observation date mismatch");
    }
    if (observedMillis > buildMillis || buildMillis >= freshnessMillis) {
      throw new Error("static revalidation is outside build time");
    }
    if ((revalidation.snapshot.governancePolicyVersion != null
        && revalidation.snapshot.governancePolicyVersion
          !== governancePolicyBinding.governancePolicyVersion)
      || (revalidation.snapshot.governancePolicySha256 != null
        && revalidation.snapshot.governancePolicySha256
          !== governancePolicyBinding.governancePolicySha256)) {
      throw new Error("static revalidation governance policy binding mismatch");
    }
    const source = requireOne(nextInventory.sources, ({ id }) => id === sourceId, sourceId);
    if (!source.admissionEvidence || typeof source.admissionEvidence !== "object") {
      throw new Error("static revalidation inventory admission evidence is missing");
    }
    if (reusesCurrentHead) {
      const expectedSnapshot = { ...structuredClone(revalidation.snapshot), ...governancePolicyBinding };
      const expectedSource = structuredClone(source);
      applyStaticRevalidationToInventory(expectedSource, revalidation);
      if (JSON.stringify(head) !== JSON.stringify(expectedSnapshot)
        || source.retrievedAt !== expectedSource.retrievedAt
        || JSON.stringify(source.admissionEvidence) !== JSON.stringify(expectedSource.admissionEvidence)) {
        throw new Error("static revalidation current head reuse identity mismatch");
      }
    } else {
      nextSnapshots.push({ ...structuredClone(revalidation.snapshot), ...governancePolicyBinding });
      applyStaticRevalidationToInventory(source, revalidation);
    }
  }
  validateLineage(nextSnapshots);
  return { sourceSnapshots: nextSnapshots, sourceInventory: nextInventory };
}

function applyStaticRevalidationToInventory(source, revalidation) {
  source.retrievedAt = revalidation.snapshot.retrievedAt.slice(0, 10);
  source.admissionEvidence.snapshotId = revalidation.snapshot.snapshotId;
  source.admissionEvidence.revalidationEvidenceSha256 = revalidation.evidence.evidenceSha256;
  source.admissionEvidence.revalidationResponseSha256 = revalidation.evidence.responseSha256;
  source.admissionEvidence.revalidatedAt = revalidation.snapshot.retrievedAt;
  if (revalidation.evidence.outcome === "CONTENT_CHANGE_ADMITTED") {
    source.admissionEvidence.rawSha256 = revalidation.snapshot.rawSha256;
    source.admissionEvidence.schemaFingerprint = revalidation.snapshot.schemaFingerprint;
    source.admissionEvidence.rawObjectUri = revalidation.snapshot.rawObjectUri;
  }
}

export function activateIncheonTopologyAdmission({
  sourceInventory,
  snapshot,
  snapshotBytes,
  snapshotPath,
  now,
}) {
  const incheon = validateIncheonStationInfoSnapshot(snapshot);
  requireCurrentIncheonStationCodeDerivations(incheon);
  if (!Buffer.isBuffer(snapshotBytes)
    || !snapshotBytes.equals(Buffer.from(`${JSON.stringify(snapshot)}\n`))
    || !(now instanceof Date)
    || Number.isNaN(now.getTime())) {
    throw new Error("current Incheon topology snapshot byte identity mismatch");
  }
  const pathMatch = /^tools\/datapack\/sources\/(incheon-transit-station-info-([0-9]{8}))\.json$/u
    .exec(snapshotPath ?? "");
  const capturedDate = incheon.capturedAt.slice(0, 10).replaceAll("-", "");
  if (pathMatch == null || pathMatch[2] !== capturedDate) {
    throw new Error("current Incheon topology snapshot path identity mismatch");
  }
  const capturedAt = requiredUtcInstant(incheon.capturedAt, "current Incheon topology capturedAt");
  const freshUntil = requiredUtcInstant(incheon.freshUntil, "current Incheon topology freshUntil");
  if (capturedAt > now.getTime()) throw new Error("current Incheon topology snapshot is future-dated");
  if (freshUntil <= now.getTime()) throw new Error("current Incheon topology snapshot is stale");

  const next = structuredClone(sourceInventory);
  if (next?.schemaVersion !== 1
    || next.artifactKind !== "production-source-inventory"
    || !Array.isArray(next.sources)) {
    throw new Error("current Incheon topology source inventory identity is invalid");
  }
  const source = requireOne(
    next.sources,
    ({ id }) => id === "incheon-transit-station-info",
    "current Incheon topology source",
  );
  const accessibilitySource = requireOne(
    next.sources,
    ({ id }) => id === "incheon-transit-accessibility",
    "current Incheon accessibility source",
  );
  const timetableSources = ["incheon-line1-train-timetable", "incheon-line2-train-timetable"]
    .map((sourceId) => requireOne(
      next.sources,
      ({ id }) => id === sourceId,
      `current ${sourceId} source`,
    ));
  const topology = source.topologyAdmissionEvidence;
  const membership = source.membershipAdmissionEvidence;
  const routeMap = source.routeMapAdmissionEvidence;
  const accessibility = accessibilitySource.accessibilityAdmissionEvidence;
  const schedules = timetableSources.map(({ scheduleAdmissionEvidence }) => scheduleAdmissionEvidence);
  if (source.requiredForProductionPack !== false
    || source.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true
    || topology?.issue !== 2481
    || topology.materializer !== "tools/datapack/materialize-incheon-station-info.mjs"
    || topology.verificationTest !== "tools/datapack/materialize-incheon-station-info.test.mjs"
    || membership?.issue !== 2490
    || membership.materializer !== topology.materializer
    || membership.verificationTest !== topology.verificationTest
    || routeMap?.issue !== 2490
    || routeMap.materializer !== topology.materializer
    || routeMap.verificationTest !== topology.verificationTest) {
    throw new Error("current Incheon topology source contract is invalid");
  }
  const snapshotId = pathMatch[1];
  const mappingSha256 = sha256(Buffer.from(JSON.stringify(incheon.scope.map((station) => ({
    stationId: station.stationId,
    lineId: station.lineId,
    stationCode: station.stationCode,
    stationName: station.stationName,
  })))));
  const stationCodesSha256 = sha256(Buffer.from(JSON.stringify(
    incheon.scope.map(({ stationCode }) => stationCode),
  )));
  if (topology.contentSha256 !== incheon.contentSha256) {
    throw new Error("current Incheon topology content changed; re-admission required");
  }
  if (accessibility?.topologySourceId !== source.id
    || accessibility.topologyContentSha256 !== incheon.contentSha256
    || !Array.isArray(accessibility.topologyLineages)
    || accessibility.topologyLineages.length !== 2
    || !Array.isArray(accessibility.membershipLineages)
    || accessibility.membershipLineages.length !== 1
    || [...accessibility.topologyLineages, ...accessibility.membershipLineages].some((lineage) => (
      lineage.sourceId !== source.id
        || lineage.snapshotId !== accessibility.topologySnapshotId
        || lineage.contentSha256 !== incheon.contentSha256
    ))) {
    throw new Error("current Incheon accessibility lineage contract is invalid");
  }
  if (schedules.some((schedule) => (
    schedule?.topologySourceId !== source.id
      || !/^incheon-transit-station-info-\d{8}$/u.test(schedule.topologySnapshotId ?? "")
      || schedule.topologyContentSha256 !== incheon.contentSha256
  ))) {
    throw new Error("current Incheon timetable lineage contract is invalid");
  }
  source.observedDataUpdatedAt = incheon.observedDataUpdatedAt;
  source.retrievedAt = incheon.capturedAt.slice(0, 10);
  Object.assign(topology, {
    snapshotId,
    snapshotPath,
    capturedAt: incheon.capturedAt,
    freshUntil: incheon.freshUntil,
    stationCount: 60,
    edgeCount: incheon.edgeCount,
    excludedTransferCount: incheon.excludedTransferCount,
    rawSha256: incheon.rawSha256,
    contentSha256: incheon.contentSha256,
  });
  Object.assign(membership, {
    snapshotId,
    lineIds: [...incheon.lineIds],
    verifiedAt: incheon.capturedAt,
    stationCount: incheon.stationCount,
    membershipSourceId: incheon.sourceId,
    membershipSourceRawSha256: incheon.rawSha256,
    membershipSourceSnapshotSha256: incheon.scopeSha256,
    mappingSha256,
    stationCodesSha256,
    stationCodeSourceId: incheon.sourceId,
    stationCodeSnapshotId: snapshotId,
    stationCodeContentSha256: incheon.contentSha256,
  });
  Object.assign(routeMap, {
    snapshotId,
    snapshotPath,
    snapshotSha256: sha256(snapshotBytes),
    capturedAt: incheon.capturedAt,
    stationCount: incheon.positionCount,
    datasetId: incheon.datasetId,
    rawSha256: incheon.rawSha256,
    positionsSha256: incheon.positionsSha256,
    lineIds: [...incheon.lineIds],
    lineStationCounts: structuredClone(incheon.lineStationCounts),
    observedDataUpdatedAt: incheon.observedDataUpdatedAt,
    topologySourceId: incheon.sourceId,
    topologySnapshotId: snapshotId,
    topologyContentSha256: incheon.contentSha256,
    freshUntil: new Date(addCadence(capturedAt, ROUTE_MAP_REVERIFICATION_CADENCE)).toISOString(),
  });
  accessibility.topologySnapshotId = snapshotId;
  for (const lineage of [...accessibility.topologyLineages, ...accessibility.membershipLineages]) {
    lineage.snapshotId = snapshotId;
  }
  for (const schedule of schedules) schedule.topologySnapshotId = snapshotId;
  return next;
}

function withCurrentCapitalPublicRouteMapCoverage(document) {
  const pack = document?.packs?.find(({ id }) => id === "capital");
  if (!pack?.metadata || typeof pack.metadata.productionCoverageEvidence !== "string") {
    throw new Error("current public route map coverage metadata is invalid");
  }
  let coverageEvidence;
  try { coverageEvidence = JSON.parse(pack.metadata.productionCoverageEvidence); } catch {
    throw new Error("current public route map coverage metadata is invalid");
  }
  if (!Array.isArray(coverageEvidence)
    || coverageEvidence.some(({ sourceIds }) => !Array.isArray(sourceIds))
    || coverageEvidence.some(({ sourceDomain, sourceIds }) =>
      sourceDomain !== "route_map_positions" && sourceIds.includes("seoulmetro-cyberstation-route-map"))) {
    throw new Error("current public route map coverage metadata is invalid");
  }
  pack.metadata.productionCoverageEvidence = JSON.stringify([
    ...coverageEvidence.filter(({ sourceDomain }) => sourceDomain !== "route_map_positions"),
    CURRENT_SEOUL_PUBLIC_ROUTE_MAP_COVERAGE,
  ]);
  return document;
}

function activateProductionInput({ productionInput, officialOdFareQuotes, handoff, rawArtifact, rawArtifactBytes, applyScheduleImpl }) {
  if (!productionInput || typeof productionInput !== "object" || Array.isArray(productionInput)) {
    throw new Error("current production input identity is invalid");
  }
  if (!Array.isArray(officialOdFareQuotes)
    || officialOdFareQuotes.length !== 2
    || officialOdFareQuotes.some(({ sourceId }) => sourceId !== "seoul-metro-official-od-fares")) {
    throw new Error("current official OD fare input must contain the exact two Seoul quotes");
  }
  const scheduled = applyScheduleImpl(structuredClone(productionInput), rawArtifact, rawArtifactBytes);
  if (scheduled?.scheduleProvenance?.sourceId !== "kric-subway-timetable"
    || scheduled.scheduleProvenance.sourceSnapshotId !== handoff.snapshotId
    || scheduled.scheduleProvenance.providerRecordHash !== handoff.rawSha256
    || scheduled.scheduleProvenance.retrievedAt !== handoff.collectedAt
    || !Array.isArray(scheduled.transitRoutes) || scheduled.transitRoutes.length === 0
    || !Array.isArray(scheduled.transitTrips) || scheduled.transitTrips.length === 0
    || !Array.isArray(scheduled.transitStopTimes) || scheduled.transitStopTimes.length === 0) {
    throw new Error("current timetable materialization identity is invalid");
  }
  const fareCoverage = {
    regionId: "capital",
    operatorId: "seoul-metro",
    sourceDomain: "official_od_fares",
    sourceIds: ["seoul-metro-official-od-fares"],
    evidence: "승인된 서울교통공사 양방향 OD fare snapshot",
  };
  const coverageEvidence = (scheduled.coverageEvidence ?? [])
    .filter(({ sourceDomain }) => !["official_od_fares", "route_map_positions"].includes(sourceDomain));
  return {
    ...scheduled,
    sourceIds: [...CURRENT_PRODUCTION_SOURCE_IDS],
    coverageEvidence: [...coverageEvidence, fareCoverage],
    routeMapPositions: [],
    officialOdFareQuotes: structuredClone(officialOdFareQuotes),
    routeServiceArtifactEvidence: [],
    movementPathCandidates: [],
  };
}

export function buildCurrentSourcePrimaryOutputs({
  handoff = CURRENT_SOURCE_HANDOFF,
  rawArtifact,
  rawArtifactBytes,
  sourceSnapshots,
  sourceInventory,
  staticRevalidations,
  staticRevalidationDate,
  canonicalPackBytes = null,
  productionInput,
  officialOdFareQuotes,
  baselineTopology,
  currentTopology,
  currentTopologyBytes,
  currentTopologyPath,
  currentIncheonTopology,
  currentIncheonTopologyBytes,
  currentIncheonTopologyPath,
  buildNow,
  snapshotBytesByPath,
  verifySuccessorHeadsImpl = verifyCurrentStaticNetworkSuccessorHeads,
  applyScheduleImpl = applySchedule,
  rebindTopologyAdmissionsImpl = withCurrentCapitalTopologyAdmissions,
  activateIncheonTopologyAdmissionImpl = activateIncheonTopologyAdmission,
  buildTopologyReverificationImpl = buildCapitalTopologyReverificationEvidence,
}) {
  validateHandoff(handoff, rawArtifact, rawArtifactBytes);
  if (!Array.isArray(sourceSnapshots)) throw new Error("current source snapshots are required");
  verifySuccessorHeadsImpl({ sourceSnapshots, sourceInventory });
  const changeAdmission = staticRevalidations?.find(
    ({ evidence }) => evidence?.artifactKind === "current-static-source-change-admission-evidence",
  );
  const canonicalMembershipSha256 = changeAdmission == null || canonicalPackBytes == null
    ? null
    : verifyCurrentSeoulCanonicalMembership(canonicalPackBytes, changeAdmission.snapshot);
  const staticSources = staticRevalidations == null
    ? { sourceSnapshots: structuredClone(sourceSnapshots), sourceInventory: structuredClone(sourceInventory) }
    : activateStaticSourceRevalidations({
      sourceSnapshots,
      sourceInventory,
      revalidations: staticRevalidations,
      governancePolicyBinding: {
        governancePolicyVersion: handoff.governancePolicyVersion,
        governancePolicySha256: handoff.governancePolicySha256,
      },
      canonicalPackSha256: canonicalPackBytes == null ? null : sha256(canonicalPackBytes),
      canonicalMembershipSha256,
      buildNow,
      observationDate: staticRevalidationDate,
    });
  const previous = requireOne(
    staticSources.sourceSnapshots,
    ({ snapshotId }) => snapshotId === handoff.previousSnapshotId,
    "previous KRIC source snapshot",
  );
  const expectedCurrentKric = currentKricSnapshot(previous, handoff);
  const existingCurrentKric = staticSources.sourceSnapshots.filter(
    ({ snapshotId }) => snapshotId === handoff.snapshotId,
  );
  if (existingCurrentKric.length > 1
    || existingCurrentKric.length === 1
      && JSON.stringify(existingCurrentKric[0]) !== JSON.stringify(expectedCurrentKric)) {
    throw new Error("current KRIC source snapshot identity mismatch");
  }
  const nextSnapshots = existingCurrentKric.length === 1
    ? [...staticSources.sourceSnapshots]
    : [...staticSources.sourceSnapshots, expectedCurrentKric];
  validateLineage(nextSnapshots);

  const fullCapital = loadCapitalRouteTopologySnapshot(currentTopology);
  const capitalSnapshotId = exactCurrentTopologySnapshotIdentity({
    snapshot: fullCapital,
    snapshotBytes: currentTopologyBytes,
    snapshotPath: currentTopologyPath,
    prefix: "capital-route-topology",
  });
  const capital = projectCurrentCapitalTopologyOwnership(fullCapital);
  validateCurrentCapitalTopologyOwnership(capital);
  const activationNow = new Date(requiredUtcInstant(validateBuildNow(buildNow, handoff), "buildNow"));
  if (Date.parse(capital.capturedAt) > activationNow.getTime()
    || Date.parse(capital.freshUntil) <= activationNow.getTime()) {
    throw new Error("current capital topology snapshot is not active at buildNow");
  }

  const inventory = activateInventory(staticSources.sourceInventory, handoff);
  const capitalInventory = rebindTopologyAdmissionsImpl({
    inventory,
    topology: capital,
    topologySnapshotId: capitalSnapshotId,
    reviewedAt: capital.capturedAt,
    snapshotBytesByPath,
  });
  const reboundInventory = activateIncheonTopologyAdmissionImpl({
    sourceInventory: capitalInventory,
    snapshot: currentIncheonTopology,
    snapshotBytes: currentIncheonTopologyBytes,
    snapshotPath: currentIncheonTopologyPath,
    now: activationNow,
  });
  const nextInput = activateProductionInput({
    productionInput,
    officialOdFareQuotes,
    handoff,
    rawArtifact,
    rawArtifactBytes,
    applyScheduleImpl,
  });
  return {
    sourceSnapshots: nextSnapshots,
    sourceInventory: reboundInventory,
    productionInput: nextInput,
    topologyReverification: buildTopologyReverificationImpl(
      projectCapitalTopologyOwnership(baselineTopology),
      capital,
    ),
  };
}

export function buildCurrentTopologyRefreshPrimaryOutputs({
  baseSpec,
  builderGitSha,
  sourceInventory,
  currentTopology,
  currentTopologyBytes,
  currentTopologyPath,
  currentIncheonTopology,
  currentIncheonTopologyBytes,
  currentIncheonTopologyPath,
  currentItxAdmissionPath,
  currentItxAdmissionBytes,
  baselineTopology,
  canonical,
  productionScopePolicyBytes,
  buildNow,
  snapshotBytesByPath,
}) {
  const fullTopology = loadCapitalRouteTopologySnapshot(currentTopology);
  const topologySnapshotId = exactCurrentTopologySnapshotIdentity({
    snapshot: fullTopology,
    snapshotBytes: currentTopologyBytes,
    snapshotPath: currentTopologyPath,
    prefix: "capital-route-topology",
  });
  const topology = projectCurrentCapitalTopologyOwnership(fullTopology);
  validateCurrentCapitalTopologyOwnership(topology);
  const activationNow = new Date(requiredUtcInstant(buildNow, "buildNow"));
  if (activationNow < new Date(topology.capturedAt)
    || activationNow >= new Date(topology.freshUntil)) {
    throw new Error("current capital topology snapshot is not active at buildNow");
  }
  const capitalInventory = withCurrentCapitalTopologyAdmissions({
    inventory: sourceInventory,
    topology,
    topologySnapshotId,
    reviewedAt: topology.capturedAt,
    snapshotBytesByPath,
    topologySnapshotBytes: currentTopologyBytes,
  });
  const nextInventory = activateIncheonTopologyAdmission({
    sourceInventory: capitalInventory,
    snapshot: currentIncheonTopology,
    snapshotBytes: currentIncheonTopologyBytes,
    snapshotPath: currentIncheonTopologyPath,
    now: activationNow,
  });
  const topologyReverification = buildCapitalTopologyReverificationEvidence(
    projectCapitalTopologyOwnership(baselineTopology),
    topology,
  );
  const sourceInventoryBytes = jsonBytes(nextInventory);
  const topologyReverificationBytes = jsonBytes(topologyReverification);
  const capitalAdmissions = admittedCapitalLineEvidence(
    nextInventory,
    topology,
    topologySnapshotId,
    topology.capturedAt,
    activationNow,
  );
  const nextCanonical = structuredClone(canonical);
  const projection = projectCapitalTopologyIntoCanonicalFixture(
    nextCanonical,
    topology,
    topologySnapshotId,
    capitalAdmissions,
  );
  const canonicalBytes = jsonBytes(nextCanonical, false);
  const spec = buildCurrentCandidateSpec({
    baseSpec,
    builderGitSha,
    sourceInventoryBytes,
    currentTopology: fullTopology,
    currentTopologyBytes,
    currentTopologyPath,
    topologyReverificationBytes,
    productionScopePolicyBytes,
  });
  if (!/^tools\/datapack\/itx-current-network-edge-admission-[0-9]{8}\.json$/u
    .test(currentItxAdmissionPath ?? "")
    || !Buffer.isBuffer(currentItxAdmissionBytes)) {
    throw new Error("current ITX topology admission input is invalid");
  }
  spec.networkEdgeEvidence.itxCurrentTopologyAdmission = {
    path: currentItxAdmissionPath,
    sha256: sha256(currentItxAdmissionBytes),
  };
  return {
    sourceInventory: nextInventory,
    sourceInventoryBytes,
    topologyReverification,
    topologyReverificationBytes,
    canonical: nextCanonical,
    canonicalBytes,
    projectedEdgeCount: projection.edgeCount,
    spec,
  };
}

function exactCurrentTopologySnapshotIdentity({
  snapshot,
  snapshotBytes,
  snapshotPath,
  prefix,
}) {
  if (!Buffer.isBuffer(snapshotBytes)
    || !snapshotBytes.equals(Buffer.from(`${JSON.stringify(snapshot)}\n`))) {
    throw new Error(`current ${prefix} snapshot byte identity mismatch`);
  }
  const match = new RegExp(`^tools/datapack/sources/(${prefix}-([0-9]{8}))\\.json$`, "u")
    .exec(snapshotPath ?? "");
  const capturedDate = snapshot.capturedAt?.slice(0, 10).replaceAll("-", "");
  if (match == null || match[2] !== capturedDate) {
    throw new Error(`current ${prefix} snapshot path identity mismatch`);
  }
  return match[1];
}

function validateCurrentCapitalTopologyOwnership(topology) {
  const expectedLineIds = CAPITAL_MAP_LINE_IDS.filter(
    (lineId) => !["line-42b5805f3b5a", "line-98718184f016"].includes(lineId),
  );
  const expectedLineIdSet = new Set(expectedLineIds);
  const observedLineIds = topology.lines.map(({ lineId }) => lineId);
  if (observedLineIds.length !== expectedLineIds.length
    || new Set(observedLineIds).size !== observedLineIds.length
    || observedLineIds.some((lineId) => !expectedLineIdSet.has(lineId))) {
    throw new Error("current capital topology ownership projection is invalid");
  }
}

function projectCurrentCapitalTopologyOwnership(topology) {
  try {
    return projectCapitalTopologyOwnership(topology);
  } catch {
    throw new Error("current capital topology ownership projection is invalid");
  }
}

function jsonBytes(value, pretty = true) {
  return Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

export function projectCurrentCanonicalRouteMapProvenance({
  canonical,
  inactiveLineExclusions,
  basemapManifest,
  dorasanCsvBytes,
  reviewedAmbiguities,
}) {
  const projected = projectRetiredTransitLines(canonical, inactiveLineExclusions);
  assertNoRetiredTransitReferences(projected, inactiveLineExclusions);
  return projectCanonicalRouteMapProvenance({
    fixture: projected,
    basemapManifest,
    dorasanCsvBytes,
    reviewedAmbiguities,
  });
}

function requiredSha(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be a lowercase sha256`);
  return value;
}

export function buildCurrentCandidateSpec({
  baseSpec,
  builderGitSha,
  sourceInventoryBytes,
  currentTopology,
  currentTopologyBytes,
  currentTopologyPath,
  topologyReverificationBytes,
  productionScopePolicyBytes,
}) {
  if (!baseSpec || baseSpec.schemaVersion !== 1
    || baseSpec.artifactKind !== "datapack-candidate-build-spec"
    || !/^[0-9a-f]{40}$/u.test(builderGitSha ?? "")) {
    throw new Error("current candidate base spec or builder identity is invalid");
  }
  if (!Buffer.isBuffer(sourceInventoryBytes)
    || !Buffer.isBuffer(currentTopologyBytes)
    || !Buffer.isBuffer(topologyReverificationBytes)
    || !Buffer.isBuffer(productionScopePolicyBytes)) {
    throw new Error("current capital topology candidate identity is invalid");
  }
  const topologySnapshotId = exactCurrentTopologySnapshotIdentity({
    snapshot: loadCapitalRouteTopologySnapshot(currentTopology),
    snapshotBytes: currentTopologyBytes,
    snapshotPath: currentTopologyPath,
    prefix: "capital-route-topology",
  });
  const capitalTopology = projectCurrentCapitalTopologyOwnership(currentTopology);
  const snapshotDate = topologySnapshotId.slice(-8);
  const topologyReverificationPath = `tools/datapack/release/capital-topology-reverification-${snapshotDate}.json`;
  const spec = structuredClone(baseSpec);
  spec.candidateId = `capital-pilot-candidate-${snapshotDate}`;
  spec.builderGitSha = builderGitSha;
  spec.builderVersion = "build-datapack.mjs@26";
  spec.fixturePath = "tools/datapack/release/capital-production-canonical-pack.json";
  spec.productionScopePolicy = {
    path: "tools/datapack/nationwide-coverage-targets.json",
    sha256: sha256(productionScopePolicyBytes),
  };
  spec.networkEdgeEvidence = {
    ...spec.networkEdgeEvidence,
    sourceInventory: {
      path: "tools/datapack/source-inventory.json",
      sha256: sha256(sourceInventoryBytes),
    },
    capitalTopology: {
      path: "tools/datapack/sources/capital-route-topology-20260724.json",
      sha256: requiredSha(spec.networkEdgeEvidence?.capitalTopology?.sha256, "baseline topology sha256"),
      snapshotId: "capital-route-topology-20260724",
    },
    capitalTopologyCandidate: {
      path: currentTopologyPath,
      sha256: sha256(currentTopologyBytes),
      snapshotId: topologySnapshotId,
    },
    capitalTopologyReverification: {
      path: topologyReverificationPath,
      sha256: sha256(topologyReverificationBytes),
    },
    capitalTopologyAdmission: {
      schemaVersion: 1,
      artifactKind: "capital-network-edge-admission",
      issue: 2649,
      status: "ADMITTED",
      snapshotId: topologySnapshotId,
      contentSha256: capitalTopology.contentSha256,
      reviewedAt: currentTopology.capturedAt,
      reverifiedAt: currentTopology.capturedAt,
      freshUntil: currentTopology.freshUntil,
    },
  };
  return spec;
}

async function readRegularBytes(repositoryRoot, relativePath, label = relativePath) {
  const absolutePath = contained(repositoryRoot, relativePath);
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return await readFile(absolutePath);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

async function writeTempFile(temporaryRoot, relativePath, bytes) {
  const absolutePath = contained(temporaryRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
  return absolutePath;
}

async function replaceTempFile(temporaryRoot, relativePath, bytes) {
  const absolutePath = contained(temporaryRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes, { mode: 0o600 });
  return absolutePath;
}

async function runNode(script, args, options = {}) {
  return await execFileAsync(
    process.execPath,
    [path.join(root, script), ...args],
    {
      cwd: root,
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: MAX_BUFFER,
    },
  );
}

function sourceRawObjectKey(handoff) {
  const parsed = new URL(handoff.rawObjectUri);
  if (parsed.protocol !== "oci:" || parsed.hostname !== "easysubway-datapacks"
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("current source raw object URI is invalid");
  }
  return parsed.pathname.slice(1);
}

function contained(repositoryRoot, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error("activation output path must be repository-relative");
  }
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("activation output path escapes repository root");
  }
  return target;
}

async function existingMetadata(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function requireSafeTarget(repositoryRoot, relativePath) {
  const root = path.resolve(repositoryRoot);
  const target = contained(root, relativePath);
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await existingMetadata(current);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`activation output parent must be a real directory: ${relativePath}`);
    }
  }
  const metadata = await existingMetadata(target);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`activation output must be a regular non-symlink file: ${relativePath}`);
  }
  return { target, existed: metadata != null };
}

async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurably(file, bytes, flag = "wx") {
  const handle = await open(file, flag, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceAtomically(target, bytes) {
  const temporaryPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeDurably(temporaryPath, bytes);
    await rename(temporaryPath, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function acquireActivationLock(repositoryRoot) {
  const lockDirectory = path.join(repositoryRoot, "tools/datapack/.current-source-activation.lock");
  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("current source activation is already in progress");
    throw error;
  }
  return async () => {
    await rmdir(lockDirectory);
    await syncDirectory(path.dirname(lockDirectory));
  };
}

function validateOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error("activation outputs are required");
  }
  const seen = new Set();
  return outputs.map((output) => {
    if (!output || !isAllowedActivationOutput(output.relativePath) || seen.has(output.relativePath)) {
      throw new Error(`activation output is not allowed or is duplicated: ${output?.relativePath ?? ""}`);
    }
    if (!Buffer.isBuffer(output.bytes)) {
      throw new TypeError(`activation output bytes must be a Buffer: ${output.relativePath}`);
    }
    seen.add(output.relativePath);
    return output;
  });
}

async function stageOutputs(repositoryRoot, transactionDirectory, outputs) {
  const records = [];
  for (const [index, output] of outputs.entries()) {
    const { target, existed } = await requireSafeTarget(repositoryRoot, output.relativePath);
    const backupPath = path.join(transactionDirectory, `backup-${index}`);
    const stagedPath = path.join(transactionDirectory, `staged-${index}`);
    let originalSha256 = null;
    if (existed) {
      const originalBytes = await readFile(target);
      originalSha256 = sha256(originalBytes);
      await writeDurably(backupPath, originalBytes);
    }
    await writeDurably(stagedPath, output.bytes);
    records.push({
      relativePath: output.relativePath,
      existed,
      backupPath: existed ? path.relative(repositoryRoot, backupPath) : null,
      originalSha256,
      expectedSha256: sha256(output.bytes),
    });
  }
  await syncDirectory(transactionDirectory);
  return records;
}

function validateJournal(journal, outputCount) {
  if (!journal || journal.schemaVersion !== 1 || journal.state !== "PREPARED"
    || !Array.isArray(journal.records) || journal.records.length !== outputCount) {
    throw new Error("current source activation journal is invalid");
  }
  for (const record of journal.records) {
    if (!isAllowedActivationOutput(record.relativePath)
      || typeof record.existed !== "boolean"
      || !SHA256.test(record.expectedSha256 ?? "")
      || (record.existed && (!SHA256.test(record.originalSha256 ?? "") || typeof record.backupPath !== "string"))
      || (!record.existed && (record.originalSha256 !== null || record.backupPath !== null))) {
      throw new Error("current source activation journal record is invalid");
    }
  }
}

async function restorePreparedTransaction(repositoryRoot, journal) {
  for (const record of journal.records) {
    const target = contained(repositoryRoot, record.relativePath);
    if (record.existed) {
      const backupPath = contained(repositoryRoot, record.backupPath);
      const backupBytes = await readFile(backupPath);
      if (sha256(backupBytes) !== record.originalSha256) {
        throw new Error(`activation backup identity mismatch: ${record.relativePath}`);
      }
      await replaceAtomically(target, backupBytes);
    } else {
      await rm(target, { force: true });
      await syncDirectory(path.dirname(target));
    }
  }
}

export async function commitCurrentSourceActivation({
  repositoryRoot,
  outputs,
  validate,
  replace = replaceAtomically,
}) {
  const root = path.resolve(repositoryRoot);
  const checkedOutputs = validateOutputs(outputs);
  if (typeof validate !== "function") throw new TypeError("activation validation callback is required");
  const releaseLock = await acquireActivationLock(root);
  const journalPath = path.join(root, "tools/datapack/.current-source-activation-transaction.json");
  const transactionDirectory = await mkdtemp(path.join(root, "tools/datapack/.current-source-activation-"));
  let journal;
  try {
    if (await existingMetadata(journalPath)) {
      throw new Error("current source activation RECOVERY_REQUIRED");
    }
    const records = await stageOutputs(root, transactionDirectory, checkedOutputs);
    journal = {
      schemaVersion: 1,
      state: "PREPARED",
      transactionDirectory: path.relative(root, transactionDirectory),
      records,
    };
    validateJournal(journal, checkedOutputs.length);
    await writeDurably(journalPath, Buffer.from(`${JSON.stringify(journal)}\n`));
    await syncDirectory(path.dirname(journalPath));
    for (const output of checkedOutputs) {
      await replace(contained(root, output.relativePath), output.bytes);
    }
    await validate();
    const committed = Buffer.from(`${JSON.stringify({ ...journal, state: "COMMITTED" })}\n`);
    await replaceAtomically(journalPath, committed);
    await rm(journalPath);
    await syncDirectory(path.dirname(journalPath));
    await rm(transactionDirectory, { recursive: true });
  } catch (error) {
    if (journal) {
      try {
        await restorePreparedTransaction(root, journal);
        await rm(journalPath, { force: true });
        await syncDirectory(path.dirname(journalPath));
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "current source activation rollback failed");
      }
    }
    await rm(transactionDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function collectPositionSnapshotBytes(sourceInventory, repositoryRoot = root) {
  const snapshotBytesByPath = new Map();
  for (const source of sourceInventory.sources ?? []) {
    const evidence = source.routeMapAdmissionEvidence;
    if (!requiresCurrentCapitalTopologyAdmission(source)) continue;
    const snapshotPath = evidence.currentLayoutAdmission?.snapshotPath ?? evidence.snapshotPath;
    if (snapshotBytesByPath.has(snapshotPath)) {
      throw new Error(`duplicate capital position snapshot path: ${snapshotPath}`);
    }
    snapshotBytesByPath.set(
      snapshotPath,
      await readRegularBytes(repositoryRoot, snapshotPath, `${source.id} position snapshot`),
    );
  }
  if (snapshotBytesByPath.size === 0) throw new Error("capital position snapshots are missing");
  return snapshotBytesByPath;
}

async function fetchCurrentRawArtifact(temporaryRoot, handoff) {
  const destinationPath = "input/kric-subway-timetable-20260809.json";
  await mkdir(path.join(temporaryRoot, "input"), { recursive: true });
  const planPath = await writeTempFile(
    temporaryRoot,
    "fetch-source-raw-plan.json",
    jsonBytes({
      schemaVersion: 1,
      steps: [{
        type: "fetch-source-raw-object",
        objectKey: sourceRawObjectKey(handoff),
        destinationPath,
        sha256: handoff.rawSha256,
        sizeBytes: handoff.rawSizeBytes,
      }],
    }),
  );
  await runNode("tools/datapack/publish-object-storage.mjs", [
    "--plan", planPath,
    "--root", temporaryRoot,
  ]);
  const bytes = await readRegularBytes(temporaryRoot, destinationPath, "current KRIC raw artifact");
  if (bytes.length !== handoff.rawSizeBytes || sha256(bytes) !== handoff.rawSha256) {
    throw new Error("downloaded current KRIC raw artifact identity mismatch");
  }
  return { bytes, value: parseJson(bytes, "current KRIC raw artifact") };
}

function requiredItxTopologyEvidencePath(spec) {
  const relativePath = spec?.itxTopologyEvidencePath;
  if (!/^tools\/datapack\/itx-cheongchun-topology-evidence(?:-[0-9]{17})?\.json$/u
    .test(relativePath ?? "")
    || !SHA256.test(spec?.itxTopologyEvidenceSha256 ?? "")) {
    throw new Error("ITX topology evidence path is invalid");
  }
  return relativePath;
}

export async function stageValidationItxTopologyEvidence({
  spec,
  temporaryRoot,
  repositoryRoot = root,
}) {
  const relativePath = requiredItxTopologyEvidencePath(spec);
  const bytes = await readRegularBytes(repositoryRoot, relativePath, "ITX topology evidence");
  if (sha256(bytes) !== spec.itxTopologyEvidenceSha256) {
    throw new Error("ITX topology evidence identity mismatch");
  }
  await writeTempFile(temporaryRoot, relativePath, bytes);
  return relativePath;
}

async function prepareReleaseEvidenceRoot(temporaryRoot, spec, {
  repositoryRoot = root,
  readMutableInput = (relativePath) => readRegularBytes(repositoryRoot, relativePath),
} = {}) {
  for (const relativePath of [
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/hash-evidence.json",
  ]) {
    await writeTempFile(temporaryRoot, relativePath, await readMutableInput(relativePath));
  }
  for (const relativePath of [
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
  ]) {
    await writeTempFile(
      temporaryRoot,
      relativePath,
      await readRegularBytes(repositoryRoot, relativePath),
    );
  }
  await stageValidationItxTopologyEvidence({ spec, temporaryRoot, repositoryRoot });
}

function validationBuildSpec(spec, temporaryRoot) {
  const next = structuredClone(spec);
  next.fixturePath = path.join(
    temporaryRoot,
    "tools/datapack/release/capital-production-canonical-pack.json",
  );
  next.itxTopologyEvidencePath = path.join(
    temporaryRoot,
    requiredItxTopologyEvidencePath(spec),
  );
  Object.assign(next.networkEdgeEvidence.sourceInventory, {
    path: path.join(temporaryRoot, "tools/datapack/source-inventory.json"),
  });
  Object.assign(next.networkEdgeEvidence.capitalTopology, {
    path: path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json"),
  });
  Object.assign(next.networkEdgeEvidence.capitalTopologyCandidate, {
    path: path.join(root, next.networkEdgeEvidence.capitalTopologyCandidate.path),
  });
  Object.assign(next.networkEdgeEvidence.capitalTopologyReverification, {
    path: path.join(temporaryRoot, next.networkEdgeEvidence.capitalTopologyReverification.path),
  });
  Object.assign(next.networkEdgeEvidence.itxCoverageContract, {
    path: path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"),
  });
  return next;
}

export async function validatePreparedCandidate({
  temporaryRoot,
  spec,
  buildNow,
  runNodeImpl = runNode,
}) {
  const validationSpecPath = await writeTempFile(
    temporaryRoot,
    "validation/candidate-build-spec.json",
    jsonBytes(validationBuildSpec(spec, temporaryRoot)),
  );
  const outputPath = path.join(temporaryRoot, "validation/output");
  await runNodeImpl("tools/datapack/build-datapack.mjs", [
    "--build-spec", validationSpecPath,
    "--output", outputPath,
  ], { env: { EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } });
}

function validateBuildNow(buildNow, handoff) {
  const millis = requiredUtcInstant(buildNow, "--build-now");
  if (millis < Date.parse(handoff.collectedAt)
    || millis >= Date.parse(handoff.freshnessExpiresAt)) {
    throw new Error("--build-now must be inside the current source admission window");
  }
  return buildNow;
}

export async function requireCleanBuilder(builderGitSha, {
  check = false,
  repositoryRoot = root,
  allowedDescendantPaths = CURRENT_SOURCE_ACTIVATION_OUTPUTS,
} = {}) {
  if (!/^[0-9a-f]{40}$/u.test(builderGitSha ?? "")) {
    throw new Error("--builder-git-sha must be an exact git commit");
  }
  const repositoryPath = path.resolve(repositoryRoot);
  const [{ stdout: head }, { stdout: status }, { stdout: builderType }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, maxBuffer: MAX_BUFFER }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repositoryPath,
      maxBuffer: MAX_BUFFER,
    }),
    execFileAsync("git", ["cat-file", "-t", builderGitSha], {
      cwd: repositoryPath,
      maxBuffer: MAX_BUFFER,
    }),
  ]);
  if (builderType.trim() !== "commit") throw new Error("builder git SHA must name a commit");
  if (status.trim() !== "") throw new Error("current source activation requires a clean worktree");
  if (head.trim() === builderGitSha) return;
  if (!check) throw new Error("builder git SHA does not match HEAD");
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", builderGitSha, "HEAD"], {
      cwd: repositoryPath,
      maxBuffer: MAX_BUFFER,
    });
  } catch {
    throw new Error("check-mode builder identity must be an ancestor of HEAD");
  }
  const allowed = new Set(allowedDescendantPaths);
  const { stdout: changedOutput } = await execFileAsync(
    "git",
    ["diff", "--name-only", builderGitSha, "HEAD", "--"],
    { cwd: repositoryPath, maxBuffer: MAX_BUFFER },
  );
  const changedPaths = changedOutput.split("\n").filter(Boolean);
  if (changedPaths.some((relativePath) => !allowed.has(relativePath))) {
    throw new Error("check-mode builder source or unrelated tracked path changed after generation");
  }
}

export async function readBuilderBaselineBytes(
  builderGitSha,
  relativePath,
  repositoryRoot = root,
) {
  if (!/^[0-9a-f]{40}$/u.test(builderGitSha ?? "")
    || !/^[A-Za-z0-9._/-]+$/u.test(relativePath ?? "")
    || path.isAbsolute(relativePath)
    || relativePath.split("/").includes("..")) {
    throw new Error("builder baseline path identity is invalid");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["show", `${builderGitSha}:${relativePath}`],
    { cwd: path.resolve(repositoryRoot), encoding: "buffer", maxBuffer: MAX_BUFFER },
  );
  return Buffer.from(stdout);
}

export async function generateCurrentCapitalTopologyRefresh({
  capitalTopologyPath,
  incheonTopologyPath,
  itxCurrentAdmissionPath,
  builderGitSha,
  buildNow,
  check = false,
}) {
  const capitalPathMatch = /^tools\/datapack\/sources\/capital-route-topology-([0-9]{8})\.json$/u
    .exec(capitalTopologyPath ?? "");
  if (capitalPathMatch == null) {
    throw new Error("current topology input must be a tracked source snapshot path");
  }
  if (!/^tools\/datapack\/sources\/incheon-transit-station-info-[0-9]{8}\.json$/u
    .test(incheonTopologyPath ?? "")) {
    throw new Error("current Incheon topology input must be a tracked source snapshot path");
  }
  if (!/^tools\/datapack\/itx-current-network-edge-admission-[0-9]{8}\.json$/u
    .test(itxCurrentAdmissionPath ?? "")) {
    throw new Error("current ITX topology admission must be a tracked artifact path");
  }
  const topologyReverificationPath =
    `tools/datapack/release/capital-topology-reverification-${capitalPathMatch[1]}.json`;
  const allowedDescendantPaths = [
    ...CURRENT_TOPOLOGY_REFRESH_OUTPUTS,
    topologyReverificationPath,
  ];
  await requireCleanBuilder(builderGitSha, { check, allowedDescendantPaths });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "current-topology-refresh-"));
  try {
    const readMutableInput = (relativePath) => check
      ? readBuilderBaselineBytes(builderGitSha, relativePath)
      : readRegularBytes(root, relativePath);
    const [currentTopologyBytes, currentIncheonTopologyBytes, currentItxAdmissionBytes,
      baselineTopologyBytes, sourceInventoryBytes,
      baseSpecBytes, canonicalBytes, productionScopePolicyBytes, sourceSnapshotsBytes] =
      await Promise.all([
        readRegularBytes(root, capitalTopologyPath, "current capital topology"),
        readRegularBytes(root, incheonTopologyPath, "current Incheon topology"),
        readRegularBytes(root, itxCurrentAdmissionPath, "current ITX topology admission"),
        readRegularBytes(root, "tools/datapack/sources/capital-route-topology-20260724.json"),
        readMutableInput("tools/datapack/source-inventory.json"),
        readMutableInput("tools/datapack/release/candidate-build-spec.json"),
        readMutableInput("tools/datapack/release/capital-production-canonical-pack.json"),
        readRegularBytes(root, "tools/datapack/nationwide-coverage-targets.json"),
        readRegularBytes(root, "tools/datapack/release/source-snapshots.json"),
      ]);
    const sourceInventory = parseJson(sourceInventoryBytes, "source inventory");
    const primary = buildCurrentTopologyRefreshPrimaryOutputs({
      baseSpec: parseJson(baseSpecBytes, "candidate build spec"),
      builderGitSha,
      sourceInventory,
      currentTopology: parseJson(currentTopologyBytes, "current capital topology"),
      currentTopologyBytes,
      currentTopologyPath: capitalTopologyPath,
      currentIncheonTopology: parseJson(
        currentIncheonTopologyBytes,
        "current Incheon topology",
      ),
      currentIncheonTopologyBytes,
      currentIncheonTopologyPath: incheonTopologyPath,
      currentItxAdmissionPath: itxCurrentAdmissionPath,
      currentItxAdmissionBytes,
      baselineTopology: parseJson(baselineTopologyBytes, "baseline capital topology"),
      canonical: parseJson(canonicalBytes, "canonical pack"),
      productionScopePolicyBytes,
      buildNow,
      snapshotBytesByPath: await collectPositionSnapshotBytes(sourceInventory),
    });
    await Promise.all([
      writeTempFile(temporaryRoot, topologyReverificationPath, primary.topologyReverificationBytes),
      writeTempFile(temporaryRoot, "tools/datapack/source-inventory.json", primary.sourceInventoryBytes),
      writeTempFile(
        temporaryRoot,
        "tools/datapack/release/capital-production-canonical-pack.json",
        primary.canonicalBytes,
      ),
      writeTempFile(
        temporaryRoot,
        "tools/datapack/release/candidate-build-spec.json",
        jsonBytes(primary.spec),
      ),
      writeTempFile(
        temporaryRoot,
        "tools/datapack/release/source-snapshots.json",
        sourceSnapshotsBytes,
      ),
    ]);
    await prepareReleaseEvidenceRoot(temporaryRoot, primary.spec, { readMutableInput });
    await runNode("tools/datapack/apply-accessibility-evidence-to-bundled-pack.mjs", [
      "--release-evidence-only",
      "--release-root", temporaryRoot,
    ], { env: { EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } });
    const [finalSpecBytes, releaseRequestBytes, hashEvidenceBytes] = await Promise.all([
      readFile(contained(temporaryRoot, "tools/datapack/release/candidate-build-spec.json")),
      readFile(contained(temporaryRoot, "tools/datapack/release/release-request.json")),
      readFile(contained(temporaryRoot, "tools/datapack/release/hash-evidence.json")),
    ]);
    const finalSpec = parseJson(finalSpecBytes, "generated candidate build spec");
    await validatePreparedCandidate({ temporaryRoot, spec: finalSpec, buildNow });
    const outputs = [
      { relativePath: topologyReverificationPath, bytes: primary.topologyReverificationBytes },
      { relativePath: CURRENT_TOPOLOGY_REFRESH_OUTPUTS[0], bytes: primary.sourceInventoryBytes },
      { relativePath: CURRENT_TOPOLOGY_REFRESH_OUTPUTS[1], bytes: primary.canonicalBytes },
      { relativePath: CURRENT_TOPOLOGY_REFRESH_OUTPUTS[2], bytes: finalSpecBytes },
      { relativePath: CURRENT_TOPOLOGY_REFRESH_OUTPUTS[3], bytes: releaseRequestBytes },
      { relativePath: CURRENT_TOPOLOGY_REFRESH_OUTPUTS[4], bytes: hashEvidenceBytes },
    ];
    const validateOutputBytes = async () => {
      for (const output of outputs) {
        const actual = await readRegularBytes(root, output.relativePath);
        if (!actual.equals(output.bytes)) {
          throw new Error(`current topology refresh output mismatch: ${output.relativePath}`);
        }
      }
    };
    if (check) await validateOutputBytes();
    else {
      await commitCurrentSourceActivation({
        repositoryRoot: root,
        outputs,
        validate: validateOutputBytes,
      });
    }
    return {
      candidateId: finalSpec.candidateId,
      topologySnapshotId: finalSpec.networkEdgeEvidence.capitalTopologyCandidate.snapshotId,
      sourceInventorySha256: finalSpec.sourceInventorySha256,
      outputCount: outputs.length,
      check,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function generateCurrentSourceActivation({
  capitalTopologyPath,
  incheonTopologyPath,
  seoulRevalidationSnapshotPath,
  seoulRevalidationEvidencePath,
  builderGitSha,
  buildNow,
  check = false,
  handoff = CURRENT_SOURCE_HANDOFF,
}) {
  const capitalPathMatch = /^tools\/datapack\/sources\/capital-route-topology-([0-9]{8})\.json$/u
    .exec(capitalTopologyPath ?? "");
  if (capitalPathMatch == null
    || !/^tools\/datapack\/sources\/incheon-transit-station-info-[0-9]{8}\.json$/u
      .test(incheonTopologyPath ?? "")) {
    throw new Error("current topology inputs must be tracked source snapshot paths");
  }
  const revalidationPaths = [
    [seoulRevalidationSnapshotPath, /^tools\/datapack\/sources\/current-static-revalidation-[0-9]{8}\/seoulmetro-station-line-info-snapshot\.json$/u],
    [seoulRevalidationEvidencePath, /^tools\/datapack\/sources\/current-static-revalidation-[0-9]{8}\/seoulmetro-station-line-info-revalidation-evidence\.json$/u],
  ];
  if (revalidationPaths.some(([value, pattern]) => !pattern.test(value ?? ""))) {
    throw new Error("current static revalidation inputs must be tracked source evidence paths");
  }
  const revalidationDirectories = new Set(revalidationPaths.map(([value]) => path.dirname(value)));
  if (revalidationDirectories.size !== 1) {
    throw new Error("current static revalidation inputs must share one observation directory");
  }
  const revalidationDateMatch = /current-static-revalidation-([0-9]{8})$/u
    .exec([...revalidationDirectories][0]);
  if (revalidationDateMatch == null) {
    throw new Error("current static revalidation observation directory is invalid");
  }
  const topologyReverificationPath =
    `tools/datapack/release/capital-topology-reverification-${capitalPathMatch[1]}.json`;
  await requireCleanBuilder(builderGitSha, {
    check,
    allowedDescendantPaths: [
      ...CURRENT_SOURCE_ACTIVATION_OUTPUTS,
      ...CURRENT_SOURCE_DOWNSTREAM_OUTPUTS,
      topologyReverificationPath,
    ],
  });
  validateBuildNow(buildNow, handoff);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "current-source-activation-"));
  try {
    const readMutableInput = (relativePath) => check
      ? readBuilderBaselineBytes(builderGitSha, relativePath)
      : readRegularBytes(root, relativePath);
    const [capitalTopologyBytes, incheonTopologyBytes, rawArtifact, baselineTopologyBytes, sourceSnapshotBytes,
      sourceInventoryBytes, productionInputBytes, quoteBundleBytes, baseSpecBytes,
      canonicalBytes, productionScopePolicyBytes,
      seoulRevalidationSnapshotBytes, seoulRevalidationEvidenceBytes,
      basemapManifestBytes, dorasanCsvBytes, reviewedAmbiguitiesBytes] = await Promise.all([
      readRegularBytes(root, capitalTopologyPath, "current capital topology"),
      readRegularBytes(root, incheonTopologyPath, "current Incheon topology"),
      fetchCurrentRawArtifact(temporaryRoot, handoff),
      readRegularBytes(root, "tools/datapack/sources/capital-route-topology-20260724.json"),
      readMutableInput("tools/datapack/release/source-snapshots.json"),
      readMutableInput("tools/datapack/source-inventory.json"),
      readMutableInput("tools/datapack/inputs/capital-pilot-production-source-input.json"),
      readRegularBytes(root, "tools/datapack/official-od-fare-quotes.json"),
      readMutableInput("tools/datapack/release/candidate-build-spec.json"),
      readMutableInput("tools/datapack/release/capital-production-canonical-pack.json"),
      readRegularBytes(root, "tools/datapack/nationwide-coverage-targets.json", "production scope policy"),
      readRegularBytes(root, seoulRevalidationSnapshotPath, "Seoul revalidation snapshot"),
      readRegularBytes(root, seoulRevalidationEvidencePath, "Seoul revalidation evidence"),
      readRegularBytes(root, "tools/route-map/basemap-build-manifest.json", "route-map basemap manifest"),
      readRegularBytes(root, "tools/datapack/sources/seoul-wikimedia-svg-route-map-20260624.csv", "Dorasan route-map CSV"),
      readRegularBytes(root, "tools/route-map/fixtures/reviewed-ambiguities.json", "reviewed route-map ambiguities"),
    ]);
    const sourceInventory = parseJson(sourceInventoryBytes, "source inventory");
    const quoteBundle = parseJson(quoteBundleBytes, "official OD fare quote bundle");
    const capitalTopology = parseJson(capitalTopologyBytes, "current capital topology");
    const incheonTopology = parseJson(incheonTopologyBytes, "current Incheon topology");
    const officialOdFareQuotes = (quoteBundle.quotes ?? [])
      .filter(({ sourceId }) => sourceId === "seoul-metro-official-od-fares");
    const primary = buildCurrentSourcePrimaryOutputs({
      handoff,
      rawArtifact: rawArtifact.value,
      rawArtifactBytes: rawArtifact.bytes,
      sourceSnapshots: parseJson(sourceSnapshotBytes, "source snapshots"),
      sourceInventory,
      staticRevalidationDate: revalidationDateMatch[1],
      staticRevalidations: [
        {
          snapshot: parseJson(seoulRevalidationSnapshotBytes, "Seoul revalidation snapshot"),
          evidence: parseJson(seoulRevalidationEvidenceBytes, "Seoul revalidation evidence"),
        },
      ],
      canonicalPackBytes: canonicalBytes,
      productionInput: parseJson(productionInputBytes, "production input"),
      officialOdFareQuotes,
      baselineTopology: parseJson(baselineTopologyBytes, "baseline capital topology"),
      currentTopology: capitalTopology,
      currentTopologyBytes: capitalTopologyBytes,
      currentTopologyPath: capitalTopologyPath,
      currentIncheonTopology: incheonTopology,
      currentIncheonTopologyBytes: incheonTopologyBytes,
      currentIncheonTopologyPath: incheonTopologyPath,
      buildNow,
      snapshotBytesByPath: await collectPositionSnapshotBytes(sourceInventory),
    });

    const primaryBytes = {
      reverification: jsonBytes(primary.topologyReverification),
      snapshots: jsonBytes(primary.sourceSnapshots),
      inventory: jsonBytes(primary.sourceInventory),
      input: jsonBytes(primary.productionInput),
    };
    await Promise.all([
      writeTempFile(temporaryRoot, topologyReverificationPath, primaryBytes.reverification),
      writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[0], primaryBytes.snapshots),
      writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[1], primaryBytes.inventory),
      writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[2], primaryBytes.input),
    ]);

    const reviewedPath = contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[3]);
    await runNode("tools/datapack/import-official-sources.mjs", [
      "--inventory", contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[1]),
      "--input", contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[2]),
      "--output", reviewedPath,
    ]);
    const productionScopePolicy = parseJson(productionScopePolicyBytes, "production scope policy");
    const publicRouteMapSuccessor = requireOne(
      primary.sourceSnapshots,
      ({ sourceId }) => sourceId === "seoul-metro-route-map-positions",
      "current public route map successor",
    );
    const capitalTopologySnapshotId = exactCurrentTopologySnapshotIdentity({
      snapshot: capitalTopology,
      snapshotBytes: capitalTopologyBytes,
      snapshotPath: capitalTopologyPath,
      prefix: "capital-route-topology",
    });
    if (publicRouteMapSuccessor.routeMapLayoutArtifact?.topologySnapshotId !== capitalTopologySnapshotId
      || publicRouteMapSuccessor.routeMapLayoutArtifact?.topologySnapshotSha256 !== sha(capitalTopologyBytes)) {
      throw new Error("current public route map topology identity is invalid");
    }
    const capitalAdmissions = admittedCapitalLineEvidence(
      primary.sourceInventory,
      capitalTopology,
      capitalTopologySnapshotId,
      capitalTopology.capturedAt,
      new Date(buildNow),
    );
    const reviewedBase = projectRetiredTransitLines(
      parseJson(await readFile(reviewedPath), "current reviewed pack"),
      productionScopePolicy.inactiveLineExclusions,
    );
    const reviewed = reviewedBase;
    const reviewedBytes = jsonBytes(reviewed);
    await writeFile(reviewedPath, reviewedBytes);
    const reviewedCapital = reviewed.packs?.find(({ id }) => id === "capital");
    if (!reviewedCapital) throw new Error("current reviewed capital pack is missing");
    const canonical = syncCanonicalFixture(
      parseJson(canonicalBytes, "canonical pack"),
      reviewedCapital,
    );
    projectCapitalTopologyIntoCanonicalFixture(
      canonical,
      capitalTopology,
      capitalTopologySnapshotId,
      capitalAdmissions,
    );
    const canonicalWithProjectedRouteMapProvenance = projectCurrentCanonicalRouteMapProvenance({
      canonical,
      inactiveLineExclusions: productionScopePolicy.inactiveLineExclusions,
      basemapManifest: parseJson(basemapManifestBytes, "route-map basemap manifest"),
      dorasanCsvBytes,
      reviewedAmbiguities: parseJson(reviewedAmbiguitiesBytes, "reviewed route-map ambiguities"),
    });
    const canonicalWithPublicRouteMap = withCurrentCapitalPublicRouteMapCoverage(materializeSeoulRouteMapPositions({
      baseFixture: canonicalWithProjectedRouteMapProvenance,
      snapshot: publicRouteMapSuccessor.routeMapLayoutArtifact,
      snapshotSha256: publicRouteMapSuccessor.normalizedObservationSha256,
      topologySnapshotBytes: capitalTopologyBytes,
      inventory: primary.sourceInventory,
      now: new Date(buildNow),
      rewritePackIdentity: false,
      successorProviderRecordHashes: publicRouteMapSuccessor.providerRecordHashes,
      requireSuccessorProviderRecordHashes: true,
    }));
    verifyCurrentCapitalPublicRouteMapDocument(
      canonicalWithPublicRouteMap,
      publicRouteMapSuccessor,
      "current canonical pack",
    );
    const nextCanonicalBytes = jsonBytes(canonicalWithPublicRouteMap, false);
    await writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[4], nextCanonicalBytes);

    const nextSpec = buildCurrentCandidateSpec({
      baseSpec: parseJson(baseSpecBytes, "candidate build spec"),
      builderGitSha,
      sourceInventoryBytes: primaryBytes.inventory,
      currentTopology: capitalTopology,
      currentTopologyBytes: capitalTopologyBytes,
      currentTopologyPath: capitalTopologyPath,
      topologyReverificationBytes: primaryBytes.reverification,
      productionScopePolicyBytes,
    });
    await writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[5], jsonBytes(nextSpec));
    await prepareReleaseEvidenceRoot(temporaryRoot, nextSpec);
    await runNode("tools/datapack/apply-accessibility-evidence-to-bundled-pack.mjs", [
      "--release-evidence-only",
      "--release-root", temporaryRoot,
    ], { env: { EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } });

    const [finalSpecBytes, releaseRequestBytes, hashEvidenceBytes] = await Promise.all([
      readFile(contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[5])),
      readFile(contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[6])),
      readFile(contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[7])),
    ]);
    const finalSpec = parseJson(finalSpecBytes, "generated candidate build spec");
    await validatePreparedCandidate({ temporaryRoot, spec: finalSpec, buildNow });

    const outputs = [
      { relativePath: topologyReverificationPath, bytes: primaryBytes.reverification },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[0], bytes: primaryBytes.snapshots },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[1], bytes: primaryBytes.inventory },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[2], bytes: primaryBytes.input },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[3], bytes: reviewedBytes },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[4], bytes: nextCanonicalBytes },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[5], bytes: finalSpecBytes },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[6], bytes: releaseRequestBytes },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[7], bytes: hashEvidenceBytes },
    ];
    const validateOutputBytes = async () => {
      for (const output of outputs) {
        const actual = await readRegularBytes(root, output.relativePath);
        if (!actual.equals(output.bytes)) {
          throw new Error(`current source activation output mismatch: ${output.relativePath}`);
        }
      }
    };
    if (check) {
      await validateOutputBytes();
    } else {
      await commitCurrentSourceActivation({
        repositoryRoot: root,
        outputs,
        validate: validateOutputBytes,
      });
    }
    return {
      candidateId: finalSpec.candidateId,
      sourceSnapshotSetHash: finalSpec.sourceSnapshotSetHash,
      sourceInventorySha256: finalSpec.sourceInventorySha256,
      outputCount: outputs.length,
      check,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function parseCurrentSourceActivationArgs(argv) {
  const args = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      args.check = true;
      continue;
    }
    if (!["--capital-topology", "--incheon-topology",
      "--seoul-revalidation-snapshot", "--seoul-revalidation-evidence",
      "--builder-git-sha", "--build-now"].includes(flag)) {
      throw new Error(`unknown activation argument: ${flag ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (args[key] != null) throw new Error(`duplicate activation argument: ${flag}`);
    args[key] = value;
    index += 1;
  }
  for (const key of ["capital_topology", "incheon_topology",
    "seoul_revalidation_snapshot", "seoul_revalidation_evidence",
    "builder_git_sha", "build_now"]) {
    if (!args[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  return args;
}

export function parseCurrentTopologyRefreshArgs(argv) {
  const args = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      args.check = true;
      continue;
    }
    if (!["--capital-topology", "--incheon-topology", "--itx-current-admission", "--builder-git-sha", "--build-now"].includes(flag)) {
      throw new Error(`unknown topology refresh argument: ${flag ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (args[key] != null) throw new Error(`duplicate topology refresh argument: ${flag}`);
    args[key] = value;
    index += 1;
  }
  for (const key of ["capital_topology", "incheon_topology", "itx_current_admission", "builder_git_sha", "build_now"]) {
    if (!args[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const topologyOnly = argv.includes("--topology-only");
  const args = topologyOnly
    ? parseCurrentTopologyRefreshArgs(argv.filter((value) => value !== "--topology-only"))
    : parseCurrentSourceActivationArgs(argv);
  const result = topologyOnly
    ? await generateCurrentCapitalTopologyRefresh({
        capitalTopologyPath: args.capital_topology,
        incheonTopologyPath: args.incheon_topology,
        itxCurrentAdmissionPath: args.itx_current_admission,
        builderGitSha: args.builder_git_sha,
        buildNow: args.build_now,
        check: args.check,
      })
    : await generateCurrentSourceActivation({
        capitalTopologyPath: args.capital_topology,
        incheonTopologyPath: args.incheon_topology,
        seoulRevalidationSnapshotPath: args.seoul_revalidation_snapshot,
        seoulRevalidationEvidencePath: args.seoul_revalidation_evidence,
        builderGitSha: args.builder_git_sha,
        buildNow: args.build_now,
        check: args.check,
      });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
