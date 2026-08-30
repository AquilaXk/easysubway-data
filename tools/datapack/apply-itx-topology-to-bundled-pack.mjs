#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { validateItxCurrentTopologyAdmission } from "./build-datapack.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const CATALOG_VERSION = 19;
const MAX_GZIP_DELTA_BYTES = 64 * 1024;
const ADMITTED_TOPOLOGY_INPUTS = new Map([
  [
    "e3c4f942a02712904d44d642627eb909523d55189efce96296a0d2b96e3ea4ad",
    {
      gzipSha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
      sqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
      byteSize: 354980,
    },
  ],
  [
    "e2894d7ce6decb08fc9fec982394e77151799c34d099b83948481080e56d780e",
    {
      gzipSha256: "7bb4bb68f0642e45377d98b083e93cd8c1c92aaa58dd353f32189e3f325a1562",
      sqliteSha256: "ed84a649952cd2ccbb238b3a63265f2bd3144497ae8fd36fab5181ad776542fc",
      byteSize: 359319,
    },
  ],
  [
    "2a11bb723310744d6f3ffc084b5a5219367ae209a6c7e65289dab8a5520f9a26",
    {
      gzipSha256: "7bb4bb68f0642e45377d98b083e93cd8c1c92aaa58dd353f32189e3f325a1562",
      sqliteSha256: "ed84a649952cd2ccbb238b3a63265f2bd3144497ae8fd36fab5181ad776542fc",
      byteSize: 359319,
    },
  ],
  [
    "f3f00e6f99862ddf1c6964d09a220169f29a85181f420f30e20428f2bee835ab",
    {
      gzipSha256: "f328fbedff014be18a0e8341e0bdbfe9b0dd774fa7e9ae7692aa869e831707b3",
      sqliteSha256: "a581c5d2a78f765b859e7e7b7d62d3bf0d9b573bcebd246ab4c6f0cd62fddfc5",
      byteSize: 1463745,
    },
  ],
]);
const ROUTE_SERVICE_ARTIFACT_EVIDENCE_COLUMNS = `
  service_class TEXT NOT NULL PRIMARY KEY,
  timetable_artifact_id TEXT NOT NULL,
  timetable_artifact_sha256 TEXT NOT NULL,
  canonical_pack_id TEXT NOT NULL,
  canonical_pack_sha256 TEXT NOT NULL,
  canonical_pack_sqlite_sha256 TEXT NOT NULL,
  admission_status TEXT NOT NULL,
  admission_eligible INTEGER NOT NULL,
  fresh_until TEXT,
  source_issue INTEGER NOT NULL,
  CHECK (service_class = 'ITX_CHEONGCHUN'),
  CHECK (length(timetable_artifact_sha256) = 64 AND timetable_artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(canonical_pack_id) > 0),
  CHECK (length(canonical_pack_sha256) = 64 AND canonical_pack_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(canonical_pack_sqlite_sha256) = 64 AND canonical_pack_sqlite_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (admission_status = 'ADMITTED'),
  CHECK (admission_eligible = 1),
  CHECK (fresh_until IS NOT NULL),
  CHECK (source_issue IN (2116, 2135))
`;
const ROUTE_SERVICE_STATION_CATALOG_EVIDENCE_COLUMNS = `
  service_class TEXT NOT NULL PRIMARY KEY,
  station_catalog_artifact_kind TEXT NOT NULL,
  station_catalog_manifest_version INTEGER NOT NULL,
  station_catalog_pack_id TEXT NOT NULL,
  station_catalog_station_set_sha256 TEXT NOT NULL,
  station_catalog_payload_sha256 TEXT NOT NULL,
  station_catalog_manifest_sha256 TEXT NOT NULL,
  admission_status TEXT NOT NULL,
  admission_eligible INTEGER NOT NULL,
  fresh_until TEXT NOT NULL,
  source_issue INTEGER NOT NULL,
  CHECK (service_class = 'ITX_CHEONGCHUN'),
  CHECK (station_catalog_artifact_kind = 'station-catalog-pack'),
  CHECK (station_catalog_manifest_version = 1),
  CHECK (length(station_catalog_pack_id) > 0),
  CHECK (length(station_catalog_station_set_sha256) = 64 AND station_catalog_station_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(station_catalog_payload_sha256) = 64 AND station_catalog_payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(station_catalog_manifest_sha256) = 64 AND station_catalog_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (admission_status = 'ADMITTED'),
  CHECK (admission_eligible = 1),
  CHECK (fresh_until IS NOT NULL),
  CHECK (source_issue = 2649)
`;
const ROUTE_SERVICE_ARTIFACT_EVIDENCE_COLUMN_NAMES = Object.freeze([
  "service_class",
  "timetable_artifact_id",
  "timetable_artifact_sha256",
  "canonical_pack_id",
  "canonical_pack_sha256",
  "canonical_pack_sqlite_sha256",
  "admission_status",
  "admission_eligible",
  "fresh_until",
  "source_issue",
]);
const ROUTE_SERVICE_STATION_CATALOG_EVIDENCE_COLUMN_NAMES = Object.freeze([
  "service_class",
  "station_catalog_artifact_kind",
  "station_catalog_manifest_version",
  "station_catalog_pack_id",
  "station_catalog_station_set_sha256",
  "station_catalog_payload_sha256",
  "station_catalog_manifest_sha256",
  "admission_status",
  "admission_eligible",
  "fresh_until",
  "source_issue",
]);
const ROUTE_SERVICE_ARTIFACT_EVIDENCE_LAYOUT = Object.freeze([
  ["service_class", "TEXT", 1, 1], ["timetable_artifact_id", "TEXT", 1, 0],
  ["timetable_artifact_sha256", "TEXT", 1, 0], ["canonical_pack_id", "TEXT", 1, 0],
  ["canonical_pack_sha256", "TEXT", 1, 0], ["canonical_pack_sqlite_sha256", "TEXT", 1, 0],
  ["admission_status", "TEXT", 1, 0], ["admission_eligible", "INTEGER", 1, 0],
  ["fresh_until", "TEXT", 0, 0], ["source_issue", "INTEGER", 1, 0],
]);
const ROUTE_SERVICE_STATION_CATALOG_EVIDENCE_LAYOUT = Object.freeze([
  ["service_class", "TEXT", 1, 1], ["station_catalog_artifact_kind", "TEXT", 1, 0],
  ["station_catalog_manifest_version", "INTEGER", 1, 0], ["station_catalog_pack_id", "TEXT", 1, 0],
  ["station_catalog_station_set_sha256", "TEXT", 1, 0], ["station_catalog_payload_sha256", "TEXT", 1, 0],
  ["station_catalog_manifest_sha256", "TEXT", 1, 0], ["admission_status", "TEXT", 1, 0],
  ["admission_eligible", "INTEGER", 1, 0], ["fresh_until", "TEXT", 1, 0],
  ["source_issue", "INTEGER", 1, 0],
]);
const ROUTE_SERVICE_V18_MIXED_EVIDENCE_LAYOUT = Object.freeze([
  ["service_class", "TEXT", 1, 1], ["timetable_artifact_id", "TEXT", 1, 0],
  ["timetable_artifact_sha256", "TEXT", 1, 0], ["station_catalog_artifact_kind", "TEXT", 1, 0],
  ["station_catalog_manifest_version", "INTEGER", 1, 0], ["station_catalog_pack_id", "TEXT", 1, 0],
  ["station_catalog_station_set_sha256", "TEXT", 1, 0], ["station_catalog_payload_sha256", "TEXT", 1, 0],
  ["station_catalog_manifest_sha256", "TEXT", 1, 0], ["admission_status", "TEXT", 1, 0],
  ["admission_eligible", "INTEGER", 1, 0], ["fresh_until", "TEXT", 0, 0],
  ["source_issue", "INTEGER", 1, 0],
]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryPath(value) {
  return path.resolve(root, value);
}

function candidateBuildNow() {
  const value = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  const buildNow = value == null ? new Date() : new Date(value);
  if (Number.isNaN(buildNow.getTime()) || (value != null && !value.endsWith("Z"))) {
    throw new Error("EASYSUBWAY_DATAPACK_BUILD_NOW must be UTC ISO-8601");
  }
  return buildNow;
}

async function admittedSource(contractPath, currentAdmissionPath = null) {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const reference = contract?.sourceTimetableArtifact;
  const currentAdmission = currentAdmissionPath == null
    ? null
    : JSON.parse(await readFile(currentAdmissionPath, "utf8"));
  validateAdmittedSourceReference(contract, reference, { currentAdmission });
  const sourceBytes = await readFile(repositoryPath(reference.artifactPath));
  const completenessBytes = await readFile(repositoryPath(reference.completenessEvidencePath));
  const { source, completeness } = parseAuthenticatedAdmittedSourceDocuments(
    reference,
    sourceBytes,
    completenessBytes,
  );
  const currentProjection = validateAdmittedSourceDocuments(
    contract,
    reference,
    source,
    completeness,
    sha256(sourceBytes),
    sha256(completenessBytes),
    { currentAdmission },
  );
  return { contract, reference, source, sourceBytes, currentAdmission, currentProjection };
}

function validateAdmittedSourceReference(contract, reference, { currentAdmission = null } = {}) {
  const artifactId = reference?.artifactId;
  const sourcePath = `tools/datapack/sources/${artifactId}.json`;
  const completenessPath = `tools/datapack/sources/${artifactId}-completeness-evidence.json`;
  if (contract?.schemaVersion !== 2
    || contract?.artifactKind !== "itx-cheongchun-coverage-contract"
    || contract?.serviceId !== "ITX_CHEONGCHUN"
    || reference?.schemaVersion !== 1
    || reference?.status !== "ADMITTED" || reference?.admissionEligible !== true
    || !/^itx-cheongchun-source-timetable-\d+$/.test(artifactId ?? "")
    || reference.artifactPath !== sourcePath
    || reference.completenessEvidencePath !== completenessPath
    || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(reference.completenessEvidenceSha256 ?? "")) {
    throw new Error("ITX topology requires #2135 ADMITTED source contract");
  }
  if (currentAdmission == null) validateCurrentApprovalIdentity(reference);
  else validateCurrentTopologyAdmissionBinding(reference);
}

function validateCurrentApprovalIdentity(reference) {
  const promotion = reference?.promotion;
  if (promotion?.mode !== "CURRENT_CANDIDATE_OWNER_APPROVED"
    || !/^https:\/\/github\.com\/AquilaXk\/easysubway-data\/issues\/96#issuecomment-[1-9][0-9]*$/u
      .test(promotion.approvalUrl ?? "")
    || promotion.approvedArtifactSha256 !== reference.sha256) {
    throw new Error("ITX topology approval identity is invalid");
  }
}

function validateCurrentTopologyAdmissionBinding(reference) {
  const promotion = reference?.promotion;
  if (!hasExactKeys(promotion, [
    "mode", "previousArtifactSha256", "previousArtifactPath", "approvalUrl",
    "approvedArtifactSha256",
  ])
    || promotion.mode !== "UNCHANGED_AUTO"
    || promotion.previousArtifactSha256 !== reference.sha256
    || promotion.previousArtifactPath !== reference.artifactPath
    || promotion.approvalUrl !== null
    || promotion.approvedArtifactSha256 !== null) {
    throw new Error("ITX current topology admission binding is invalid");
  }
}

export function parseAuthenticatedAdmittedSourceDocuments(reference, sourceBytes, completenessBytes) {
  if (sha256(sourceBytes) !== reference.sha256
    || sha256(completenessBytes) !== reference.completenessEvidenceSha256) {
    throw new Error("ITX topology source bytes do not match the coverage contract");
  }
  return { source: JSON.parse(sourceBytes), completeness: JSON.parse(completenessBytes) };
}

export function validateAdmittedSourceDocuments(
  contract,
  reference,
  source,
  completeness,
  sourceSha256,
  completenessSha256,
  { currentAdmission = null } = {},
) {
  validateAdmittedSourceReference(contract, reference, { currentAdmission });
  if (sourceSha256 !== reference.sha256
    || completenessSha256 !== reference.completenessEvidenceSha256) {
    throw new Error("ITX topology source bytes do not match the coverage contract");
  }
  const now = candidateBuildNow();
  const freshUntilMillis = Date.parse(reference.freshUntil);
  if (!Number.isFinite(freshUntilMillis)
    || (currentAdmission == null && freshUntilMillis <= now.getTime())) {
    throw new Error("ITX topology source artifact is expired");
  }
  const admission = contract?.officialEvidence?.korailCompletenessAdmission;
  if (Object.hasOwn(source ?? {}, "canonicalPackIdentity")
    || Object.hasOwn(source ?? {}, "readmissions")
    || Object.hasOwn(completeness ?? {}, "canonicalPackIdentity")
    || Object.hasOwn(completeness ?? {}, "readmissions")
    || Object.hasOwn(admission ?? {}, "canonicalPackIdentity")) {
    throw new Error("ITX topology legacy admission is forbidden");
  }
  const contractIdentity = stationCatalogIdentity(
    admission?.stationCatalogPackIdentity,
    "ITX coverage station catalog identity",
  );
  const sourceIdentity = stationCatalogIdentity(
    source?.stationCatalogPackIdentity,
    "ITX topology station catalog identity",
  );
  const completenessIdentity = stationCatalogIdentity(
    completeness?.stationCatalogPackIdentity,
    "ITX completeness station catalog identity",
  );
  if (JSON.stringify(contractIdentity) !== JSON.stringify(sourceIdentity)
    || JSON.stringify(contractIdentity) !== JSON.stringify(completenessIdentity)) {
    throw new Error("ITX topology station catalog identity mismatch");
  }
  if (source?.schemaVersion !== 1
    || source?.artifactKind !== "itx-cheongchun-source-timetable"
    || source?.artifactId !== reference.artifactId || source?.serviceId !== "ITX_CHEONGCHUN"
    || source?.validationStatus !== "SUPPORTED" || source?.freshUntil !== reference.freshUntil
    || source?.completenessEvidenceSha256 !== reference.completenessEvidenceSha256
    || completeness?.schemaVersion !== 2
    || completeness?.artifactKind !== "korail-itx-cheongchun-completeness-evidence"
    || completeness?.serviceId !== "ITX_CHEONGCHUN"
    || completeness?.validationMode !== "ADMISSION"
    || completeness?.validationStatus !== "SUPPORTED"
    || completeness?.materialization?.status !== "SUPPORTED"
    || completeness?.admissionStatus !== source.promotionStatus
    || !isUtcInstant(source?.observedAt)
    || !isUtcInstant(completeness?.observedAt)
    || completeness?.observedAt !== source.observedAt
    || completeness?.sourceTimetableArtifact?.status !== source.promotionStatus
    || !["SUPPORTED", "BOOTSTRAP_REVIEW_REQUIRED", "CHANGE_REVIEW_REQUIRED"]
      .includes(source.promotionStatus)
    || completeness?.sourceTimetableArtifact?.artifactId !== reference.artifactId
    || completeness?.sourceTimetableArtifact?.policyVersion !== source.policyVersion
    || completeness?.sourceTimetableArtifact?.freshUntil !== reference.freshUntil
    || JSON.stringify(completeness?.selectedServiceDates) !== JSON.stringify(source.selectedServiceDates)
    || !completeness?.allowedConsumerIssues?.includes("#1400")
    || completeness?.credentialRedacted !== true) {
    throw new Error("ITX topology source identity is invalid");
  }
  if (currentAdmission != null) {
    return validateItxCurrentTopologyAdmission(currentAdmission, {
      previousArtifactSha256: reference.sha256,
      stationSequences: source.stationSequences,
      now,
    });
  }
  return {
    sourceId: source.artifactKind,
    sourceSnapshotId: source.artifactId,
    evidenceHash: source.evidenceHash,
    verifiedAt: source.observedAt,
    freshUntil: reference.freshUntil,
  };
}

function isUtcInstant(value) {
  try {
    requiredUtcInstant(value, "ITX observation timestamp");
    return true;
  } catch {
    return false;
  }
}

function stationCatalogIdentity(value, label) {
  const keys = ["artifactKind", "manifestVersion", "catalogPackId", "stationSetSha256", "payloadSha256", "manifestSha256"];
  if (value == null
    || Object.keys(value).sort((left, right) => left.localeCompare(right)).join(",")
      !== [...keys].sort((left, right) => left.localeCompare(right)).join(",")
    || value.artifactKind !== "station-catalog-pack"
    || value.manifestVersion !== 1
    || typeof value.catalogPackId !== "string" || value.catalogPackId.length === 0
    || ![value.stationSetSha256, value.payloadSha256, value.manifestSha256]
      .every((digest) => /^[a-f0-9]{64}$/.test(digest ?? ""))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function topologyInputPackIdentity(value, label) {
  const keys = ["id", "sha256", "sqliteSha256", "byteSize"];
  if (!hasExactKeys(value, keys)
    || value.id !== "capital"
    || ![value.sha256, value.sqliteSha256]
      .every((digest) => /^[a-f0-9]{64}$/.test(digest ?? ""))
    || !Number.isSafeInteger(value.byteSize)
    || value.byteSize <= 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function hasExactKeys(value, keys) {
  return value != null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort((left, right) => left.localeCompare(right)).join(",")
      === [...keys].sort((left, right) => left.localeCompare(right)).join(",");
}

export async function admittedTopologySource(reference, source, currentAdmission = null) {
  if (Object.hasOwn(source, "canonicalPackIdentity")
    || Object.hasOwn(source, "readmissions")
    || (currentAdmission == null
      ? reference?.promotion?.mode !== "CURRENT_CANDIDATE_OWNER_APPROVED"
      : reference?.promotion?.mode !== "UNCHANGED_AUTO")) {
    throw new Error("ITX topology legacy admission is forbidden");
  }
  const identity = stationCatalogIdentity(source?.stationCatalogPackIdentity, "ITX topology station catalog identity");
  const admittedInput = ADMITTED_TOPOLOGY_INPUTS.get(reference?.sha256);
  if (admittedInput == null) {
    throw new Error("ITX topology current source identity is not admitted");
  }
  return { reference, source, stationCatalogPackIdentity: identity, ...admittedInput };
}

export function validateTopologyEvidence({
  contract,
  reference,
  source,
  topology,
  evidence,
  index,
  inputGzipBytes,
  admittedInput,
}) {
  const pack = index.packs?.find(({ id }) => id === "capital");
  const inputSqliteBytes = gunzipSync(inputGzipBytes);
  const sourceIdentity = stationCatalogIdentity(
    source?.stationCatalogPackIdentity,
    "ITX topology station catalog identity",
  );
  const contractIdentity = stationCatalogIdentity(
    contract?.officialEvidence?.korailCompletenessAdmission?.stationCatalogPackIdentity,
    "ITX coverage station catalog identity",
  );
  const evidenceIdentity = stationCatalogIdentity(
    evidence?.stationCatalogPackIdentity,
    "ITX topology evidence station catalog identity",
  );
  const contractInput = topologyInputPackIdentity(
    contract?.officialEvidence?.korailCompletenessAdmission?.topologyInputPackIdentity,
    "ITX topology input pack identity",
  );
  if (!hasExactKeys(evidence, [
    "schemaVersion", "artifactKind", "serviceId", "sourceIssue",
    "stationCatalogPackIdentity", "sourceArtifact", "topology", "pack",
  ])
    || Object.hasOwn(source, "canonicalPackIdentity")
    || Object.hasOwn(source, "readmissions")
    || reference?.promotion?.mode !== "CURRENT_CANDIDATE_OWNER_APPROVED"
    || JSON.stringify(contractIdentity) !== JSON.stringify(sourceIdentity)
    || JSON.stringify(evidenceIdentity) !== JSON.stringify(sourceIdentity)
    || JSON.stringify(evidence?.sourceArtifact?.stationCatalogPackIdentity)
      !== JSON.stringify(sourceIdentity)
    || contractInput.sha256 !== admittedInput.gzipSha256
    || contractInput.sqliteSha256 !== admittedInput.sqliteSha256
    || contractInput.byteSize !== admittedInput.byteSize
    || evidence?.schemaVersion !== 1
    || evidence?.artifactKind !== "itx-cheongchun-mobile-topology-evidence"
    || evidence?.sourceIssue !== 2135
    || evidence?.serviceId !== "ITX_CHEONGCHUN"
    || evidence?.sourceArtifact?.id !== reference.artifactId
    || evidence?.sourceArtifact?.sha256 !== reference.sha256
    || evidence?.sourceArtifact?.completenessEvidenceSha256 !== reference.completenessEvidenceSha256
    || evidence?.sourceArtifact?.freshUntil !== reference.freshUntil
    || evidence?.topology?.stationMembershipCount !== topology.stations.length
    || evidence?.topology?.servedStationCount !== topology.servedStations.length
    || evidence?.pack?.inputSha256 !== admittedInput.gzipSha256
    || evidence?.pack?.inputSqliteSha256 !== admittedInput.sqliteSha256
    || evidence?.pack?.inputByteSize !== admittedInput.byteSize
    || evidence?.topology?.sha256 !== topology.sha256
    || evidence?.topology?.edgeCount !== topology.edges.length
    || JSON.stringify(evidence?.topology?.directions) !== JSON.stringify(["up", "down"])
    || evidence?.topology?.connectedComponentCount !== 1
    || evidence?.topology?.isolatedServedStationCount !== 0
    || evidence?.topology?.durationSecondsEmbedded !== false
    || evidence?.topology?.fareEmbedded !== false
    || evidence?.pack?.id !== "capital"
    || evidence?.pack?.outputSha256 !== sha256(inputGzipBytes)
    || evidence?.pack?.byteSize !== inputGzipBytes.length
    || evidence?.pack?.byteSizeDelta !== inputGzipBytes.length - evidence.pack.inputByteSize
    || evidence.pack.byteSizeDelta > MAX_GZIP_DELTA_BYTES
    || pack?.sha256 !== sha256(inputGzipBytes)
    || pack?.sqliteSha256 !== evidence?.pack?.outputSqliteSha256
    || pack?.byteSize !== inputGzipBytes.length) {
    throw new Error("ITX topology evidence or bundled pack index is stale");
  }
  return { inputSqliteBytes };
}

function routeServiceEvidence(contract, reference, source, canonicalPackIdentity, currentProjection) {
  const identity = stationCatalogIdentity(
    contract?.officialEvidence?.korailCompletenessAdmission?.stationCatalogPackIdentity,
    "ITX coverage station catalog identity",
  );
  if (JSON.stringify(identity) !== JSON.stringify(source?.stationCatalogPackIdentity)) {
    throw new Error("ITX coverage and source station catalog identity mismatch");
  }
  return {
    artifactEvidence: {
      serviceClass: "ITX_CHEONGCHUN",
      timetableArtifactId: reference.artifactId,
      timetableArtifactSha256: reference.sha256,
      canonicalPackId: canonicalPackIdentity.id,
      canonicalPackSha256: canonicalPackIdentity.sha256,
      canonicalPackSqliteSha256: canonicalPackIdentity.sqliteSha256,
      admissionStatus: "ADMITTED",
      admissionEligible: 1,
      freshUntil: currentProjection.freshUntil,
      sourceIssue: 2135,
    },
    stationCatalogEvidence: {
      serviceClass: "ITX_CHEONGCHUN",
      stationCatalogArtifactKind: identity.artifactKind,
      stationCatalogManifestVersion: identity.manifestVersion,
      stationCatalogPackId: identity.catalogPackId,
      stationCatalogStationSetSha256: identity.stationSetSha256,
      stationCatalogPayloadSha256: identity.payloadSha256,
      stationCatalogManifestSha256: identity.manifestSha256,
      admissionStatus: "ADMITTED",
      admissionEligible: 1,
      freshUntil: currentProjection.freshUntil,
      sourceIssue: 2649,
    },
  };
}

export function deriveTopology(source) {
  if (!Array.isArray(source?.stationSequences) || source.stationSequences.length === 0) {
    throw new Error("ITX topology stationSequences must be non-empty");
  }
  const rosterStations = (source.stationRosters ?? [])
    .flatMap(({ stations }) => stations ?? []);
  const stations = new Map(rosterStations
    .map(({ canonicalStationId, lineId }) => [
      `${canonicalStationId}:${lineId}`,
      { stationId: canonicalStationId, lineId },
    ]));
  const corridorSequences = new Map(rosterStations.map((station) => [
    `${station.canonicalStationId}:${station.lineId}`,
    station.corridorSequence,
  ]));
  if (stations.size === 0) throw new Error("ITX topology canonical station roster is empty");
  const servedStations = new Map();
  const edges = new Map();
  const adjacency = new Map();
  const directions = new Set();
  for (const sequence of source.stationSequences) {
    if (!Array.isArray(sequence.stops) || sequence.stops.length < 2) {
      throw new Error(`ITX topology sequence needs at least two stops: ${sequence.trainNumber ?? "unknown"}`);
    }
    directions.add(sequence.directionId);
    for (const stop of sequence.stops) {
      if (typeof stop.stationId !== "string" || typeof stop.lineId !== "string") {
        throw new Error("ITX topology stop identity is invalid");
      }
      servedStations.set(`${stop.stationId}:${stop.lineId}`, {
        stationId: stop.stationId,
        lineId: stop.lineId,
      });
    }
    for (let index = 1; index < sequence.stops.length; index += 1) {
      const from = sequence.stops[index - 1];
      const to = sequence.stops[index];
      const fromNodeId = `${from.stationId}:${from.lineId}:EXPRESS`;
      const toNodeId = `${to.stationId}:${to.lineId}:EXPRESS`;
      const fromKey = `${from.stationId}:${from.lineId}`;
      const toKey = `${to.stationId}:${to.lineId}`;
      const fromSequence = corridorSequences.get(fromKey);
      const toSequence = corridorSequences.get(toKey);
      const increasing = sequence.directionId === "up" && fromSequence < toSequence;
      const decreasing = sequence.directionId === "down" && fromSequence > toSequence;
      if (!Number.isInteger(fromSequence) || !Number.isInteger(toSequence)
        || from.corridorSequence !== fromSequence || to.corridorSequence !== toSequence
        || (!increasing && !decreasing)) {
        throw new Error(`ITX topology direction is invalid: ${sequence.trainNumber ?? "unknown"}`);
      }
      if (!adjacency.has(fromKey)) adjacency.set(fromKey, new Set());
      if (!adjacency.has(toKey)) adjacency.set(toKey, new Set());
      adjacency.get(fromKey).add(toKey);
      adjacency.get(toKey).add(fromKey);
      const key = `${fromNodeId}->${toNodeId}`;
      edges.set(key, {
        id: `itx-cheongchun:${sha256(key).slice(0, 20)}`,
        fromNodeId,
        toNodeId,
        durationSeconds: 0,
        distanceMeters: 0,
        edgeType: "RIDE",
        servicePattern: "EXPRESS",
        serviceClass: "ITX_CHEONGCHUN",
      });
    }
  }
  if (directions.size !== 2 || !directions.has("up") || !directions.has("down")) {
    throw new Error("ITX topology requires U/D station sequences");
  }
  const expectedServedStationKeys = new Set((source.transitStopTimes ?? [])
    .map(({ stationId, lineId }) => `${stationId}:${lineId}`));
  if (expectedServedStationKeys.size === 0
    || expectedServedStationKeys.size !== servedStations.size
    || [...expectedServedStationKeys].some((key) => !servedStations.has(key))
    || [...servedStations.keys()].some((key) => !stations.has(key))) {
    throw new Error("ITX topology must cover the admitted service stop set");
  }
  const [firstServedStation] = expectedServedStationKeys;
  const visited = new Set([firstServedStation]);
  const pending = [firstServedStation];
  while (pending.length > 0) {
    for (const neighbor of adjacency.get(pending.pop()) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  if (visited.size !== expectedServedStationKeys.size) {
    throw new Error("ITX topology service stop graph must be connected");
  }
  const topology = {
    stations: [...stations.values()].sort((left, right) => codepointCompare(left.stationId, right.stationId)
      || codepointCompare(left.lineId, right.lineId)),
    servedStations: [...servedStations.values()].sort((left, right) => codepointCompare(left.stationId, right.stationId)
      || codepointCompare(left.lineId, right.lineId)),
    edges: [...edges.values()].sort((left, right) => codepointCompare(left.id, right.id)),
  };
  const normalizedBytes = Buffer.from(`${JSON.stringify(topology)}\n`);
  return { ...topology, normalizedBytes, sha256: sha256(normalizedBytes) };
}

export function projectItxTopologyIntoCanonicalFixture(fixture, topology) {
  const packs = fixture?.packs?.filter(({ id }) => id === "capital") ?? [];
  if (fixture?.manifest?.channel !== "production"
    || packs.length !== 1
    || packs[0].artifactKind !== "production"
    || !Array.isArray(packs[0].networkEdges)
    || !Array.isArray(packs[0].stationLines)) {
    throw new Error("ITX topology canonical fixture is invalid");
  }
  const pack = packs[0];
  const memberships = new Set(pack.stationLines.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  const projected = topology.edges.map((edge) => {
    const [fromStationId, fromLineId] = String(edge.fromNodeId).split(":");
    const [toStationId, toLineId] = String(edge.toNodeId).split(":");
    if (!memberships.has(`${fromStationId}\0${fromLineId}`)
      || !memberships.has(`${toStationId}\0${toLineId}`)) {
      throw new Error("ITX topology canonical fixture station membership is missing");
    }
    return {
      ...edge,
      includesStairs: false,
      stairAccessState: "UNKNOWN",
      accessibilityStatus: "UNKNOWN",
      reliabilityScore: 100,
      facilityId: null,
    };
  });
  const retained = pack.networkEdges.filter(({ serviceClass }) => serviceClass !== "ITX_CHEONGCHUN");
  pack.networkEdges = [...retained, ...projected]
    .sort((left, right) => codepointCompare(left.id, right.id));
  if (pack.minimumTableRows && typeof pack.minimumTableRows === "object"
    && Object.hasOwn(pack.minimumTableRows, "network_edges")) {
    pack.minimumTableRows.network_edges = pack.networkEdges.length;
  }
  return { edgeCount: projected.length, topologySha256: topology.sha256 };
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
}

function writeRouteServiceEvidence(database, admissionEvidence) {
  const { artifactEvidence, stationCatalogEvidence } = admissionEvidence;
  database.prepare("DELETE FROM route_service_artifact_evidence WHERE service_class = 'ITX_CHEONGCHUN'").run();
  database.prepare("DELETE FROM route_service_station_catalog_evidence WHERE service_class = 'ITX_CHEONGCHUN'").run();
  database.prepare(`
    INSERT INTO route_service_artifact_evidence (
      service_class, timetable_artifact_id, timetable_artifact_sha256,
      canonical_pack_id, canonical_pack_sha256, canonical_pack_sqlite_sha256,
      admission_status, admission_eligible, fresh_until, source_issue
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactEvidence.serviceClass,
    artifactEvidence.timetableArtifactId,
    artifactEvidence.timetableArtifactSha256,
    artifactEvidence.canonicalPackId,
    artifactEvidence.canonicalPackSha256,
    artifactEvidence.canonicalPackSqliteSha256,
    artifactEvidence.admissionStatus,
    artifactEvidence.admissionEligible,
    artifactEvidence.freshUntil,
    artifactEvidence.sourceIssue,
  );
  database.prepare(`
    INSERT INTO route_service_station_catalog_evidence (
      service_class, station_catalog_artifact_kind, station_catalog_manifest_version,
      station_catalog_pack_id, station_catalog_station_set_sha256,
      station_catalog_payload_sha256, station_catalog_manifest_sha256,
      admission_status, admission_eligible, fresh_until, source_issue
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stationCatalogEvidence.serviceClass,
    stationCatalogEvidence.stationCatalogArtifactKind,
    stationCatalogEvidence.stationCatalogManifestVersion,
    stationCatalogEvidence.stationCatalogPackId,
    stationCatalogEvidence.stationCatalogStationSetSha256,
    stationCatalogEvidence.stationCatalogPayloadSha256,
    stationCatalogEvidence.stationCatalogManifestSha256,
    stationCatalogEvidence.admissionStatus,
    stationCatalogEvidence.admissionEligible,
    stationCatalogEvidence.freshUntil,
    stationCatalogEvidence.sourceIssue,
  );
}

function normalizedSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

function tableHasExactLayout(database, table, expectedLayout, requiredConstraints) {
  const tableRow = database.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table);
  if (tableRow == null) return false;
  const columns = database.prepare(`PRAGMA table_info(${table})`).all()
    .map(({ name, type, notnull, pk }) => [name, type, notnull, pk]);
  const schema = normalizedSql(tableRow.sql);
  return JSON.stringify(columns) === JSON.stringify(expectedLayout)
    && requiredConstraints.every((constraint) => schema.includes(normalizedSql(constraint)));
}

function tableExists(database, table) {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) != null;
}

function routeServiceEvidenceLayout(database) {
  const artifactExists = tableExists(database, "route_service_artifact_evidence");
  const stationExists = tableExists(database, "route_service_station_catalog_evidence");
  const artifactCurrent = tableHasExactLayout(database, "route_service_artifact_evidence", ROUTE_SERVICE_ARTIFACT_EVIDENCE_LAYOUT, [
    "CHECK (service_class = 'ITX_CHEONGCHUN')",
    "CHECK (length(timetable_artifact_sha256) = 64 AND timetable_artifact_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (length(canonical_pack_id) > 0)",
    "CHECK (length(canonical_pack_sha256) = 64 AND canonical_pack_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (length(canonical_pack_sqlite_sha256) = 64 AND canonical_pack_sqlite_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (admission_status = 'ADMITTED')", "CHECK (admission_eligible = 1)",
    "CHECK (fresh_until IS NOT NULL)", "CHECK (source_issue IN (2116, 2135))",
  ]);
  const stationCurrent = tableHasExactLayout(database, "route_service_station_catalog_evidence", ROUTE_SERVICE_STATION_CATALOG_EVIDENCE_LAYOUT, [
    "CHECK (service_class = 'ITX_CHEONGCHUN')", "CHECK (station_catalog_artifact_kind = 'station-catalog-pack')",
    "CHECK (station_catalog_manifest_version = 1)", "CHECK (length(station_catalog_pack_id) > 0)",
    "CHECK (length(station_catalog_station_set_sha256) = 64 AND station_catalog_station_set_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (length(station_catalog_payload_sha256) = 64 AND station_catalog_payload_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (length(station_catalog_manifest_sha256) = 64 AND station_catalog_manifest_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (admission_status = 'ADMITTED')", "CHECK (admission_eligible = 1)",
    "CHECK (fresh_until IS NOT NULL)", "CHECK (source_issue = 2649)",
  ]);
  const legacyV18 = !stationExists && tableHasExactLayout(database, "route_service_artifact_evidence", ROUTE_SERVICE_V18_MIXED_EVIDENCE_LAYOUT, [
    "CHECK (service_class = 'ITX_CHEONGCHUN')",
    "CHECK (length(timetable_artifact_sha256) = 64 AND timetable_artifact_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (station_catalog_artifact_kind = 'station-catalog-pack')", "CHECK (station_catalog_manifest_version = 1)",
    "CHECK (length(station_catalog_pack_id) > 0)",
    "CHECK (length(station_catalog_station_set_sha256) = 64 AND station_catalog_station_set_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (length(station_catalog_payload_sha256) = 64 AND station_catalog_payload_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (length(station_catalog_manifest_sha256) = 64 AND station_catalog_manifest_sha256 NOT GLOB '*[^0-9a-f]*')",
    "CHECK (admission_status = 'ADMITTED')", "CHECK (admission_eligible = 1)", "CHECK (fresh_until IS NOT NULL)",
    "CHECK (source_issue IN (2116, 2135))",
  ]);
  const legacyV18Artifact = !artifactCurrent && !stationExists && tableHasExactLayout(database,
    "route_service_artifact_evidence", ROUTE_SERVICE_ARTIFACT_EVIDENCE_LAYOUT, [
      "CHECK (service_class = 'ITX_CHEONGCHUN')",
      "CHECK (length(timetable_artifact_sha256) = 64 AND timetable_artifact_sha256 NOT GLOB '*[^0-9a-f]*')",
      "CHECK (length(canonical_pack_sha256) = 64 AND canonical_pack_sha256 NOT GLOB '*[^0-9a-f]*')",
      "CHECK (length(canonical_pack_sqlite_sha256) = 64 AND canonical_pack_sqlite_sha256 NOT GLOB '*[^0-9a-f]*')",
      "CHECK (admission_status IN ('MISSING', 'ADMITTED'))", "CHECK (admission_eligible IN (0, 1))",
      "CHECK (source_issue IN (2116, 2135))",
    ]);
  return { artifactExists, stationExists, artifactCurrent, stationCurrent, legacyV18: legacyV18 || legacyV18Artifact };
}

function requireExactRouteServiceEvidenceLayout(database, currentVersion) {
  const layout = routeServiceEvidenceLayout(database);
  if (currentVersion === 19) {
    if (!layout.artifactCurrent || !layout.stationCurrent) {
      throw new Error("v19 route service evidence schema is malformed or partial");
    }
    const artifactCount = database.prepare("SELECT count(*) AS count FROM route_service_artifact_evidence").get().count;
    const stationCount = database.prepare("SELECT count(*) AS count FROM route_service_station_catalog_evidence").get().count;
    if (artifactCount !== 1 || stationCount !== 1) {
      throw new Error("v19 route service evidence requires exactly one row in each domain");
    }
    return "v19";
  }
  if (currentVersion === 18) {
    if (!layout.legacyV18) throw new Error("v18 route service evidence schema is malformed or partial");
    return "v18";
  }
  if ((currentVersion === 16 || currentVersion === 17)
    && !layout.artifactExists && !layout.stationExists
    && tableExists(database, "transit_trips") && tableExists(database, "network_edges")) {
    return "legacy";
  }
  throw new Error(`ITX topology does not support route service evidence layout at user_version ${currentVersion}`);
}

function validateRouteServiceEvidence(admissionEvidence) {
  const artifact = admissionEvidence?.artifactEvidence;
  const station = admissionEvidence?.stationCatalogEvidence;
  const artifactKeys = [
    "serviceClass", "timetableArtifactId", "timetableArtifactSha256", "canonicalPackId",
    "canonicalPackSha256", "canonicalPackSqliteSha256", "admissionStatus", "admissionEligible",
    "freshUntil", "sourceIssue",
  ];
  const stationKeys = [
    "serviceClass", "stationCatalogArtifactKind", "stationCatalogManifestVersion", "stationCatalogPackId",
    "stationCatalogStationSetSha256", "stationCatalogPayloadSha256", "stationCatalogManifestSha256",
    "admissionStatus", "admissionEligible", "freshUntil", "sourceIssue",
  ];
  if (!hasExactKeys(admissionEvidence, ["artifactEvidence", "stationCatalogEvidence"])
    || !hasExactKeys(artifact, artifactKeys) || !hasExactKeys(station, stationKeys)
    || artifact.serviceClass !== "ITX_CHEONGCHUN" || station.serviceClass !== "ITX_CHEONGCHUN"
    || artifact.admissionStatus !== "ADMITTED" || station.admissionStatus !== "ADMITTED"
    || artifact.admissionEligible !== 1 || station.admissionEligible !== 1
    || artifact.sourceIssue !== 2135 || station.sourceIssue !== 2649
    || typeof artifact.timetableArtifactId !== "string" || artifact.timetableArtifactId.length === 0
    || typeof artifact.canonicalPackId !== "string" || artifact.canonicalPackId.length === 0
    || typeof station.stationCatalogPackId !== "string" || station.stationCatalogPackId.length === 0
    || station.stationCatalogArtifactKind !== "station-catalog-pack"
    || station.stationCatalogManifestVersion !== 1
    || artifact.freshUntil !== station.freshUntil || Number.isNaN(Date.parse(artifact.freshUntil ?? ""))
    || ![
      artifact.timetableArtifactSha256, artifact.canonicalPackSha256, artifact.canonicalPackSqliteSha256,
      station.stationCatalogStationSetSha256, station.stationCatalogPayloadSha256,
      station.stationCatalogManifestSha256,
    ].every((digest) => /^[a-f0-9]{64}$/.test(digest ?? ""))) {
    throw new Error("ITX topology requires independent current route service evidence");
  }
}

function ensureRouteServiceEvidenceSchemas(database, admissionEvidence, layout) {
  if (layout === "v18") database.exec("ALTER TABLE route_service_artifact_evidence RENAME TO route_service_artifact_evidence_v18");
  if (layout !== "v19") {
    database.exec(`CREATE TABLE route_service_artifact_evidence (${ROUTE_SERVICE_ARTIFACT_EVIDENCE_COLUMNS})`);
    database.exec(`CREATE TABLE route_service_station_catalog_evidence (${ROUTE_SERVICE_STATION_CATALOG_EVIDENCE_COLUMNS})`);
  }
  writeRouteServiceEvidence(database, admissionEvidence);
  assertStoredRouteServiceEvidence(database, admissionEvidence);
  if (layout === "v18") database.exec("DROP TABLE route_service_artifact_evidence_v18");
}

function assertStoredRouteServiceEvidence(database, admissionEvidence) {
  const artifactEvidence = database.prepare(`
    SELECT service_class AS serviceClass, timetable_artifact_id AS timetableArtifactId,
           timetable_artifact_sha256 AS timetableArtifactSha256,
           canonical_pack_id AS canonicalPackId, canonical_pack_sha256 AS canonicalPackSha256,
           canonical_pack_sqlite_sha256 AS canonicalPackSqliteSha256,
           admission_status AS admissionStatus, admission_eligible AS admissionEligible,
           fresh_until AS freshUntil, source_issue AS sourceIssue
    FROM route_service_artifact_evidence WHERE service_class = 'ITX_CHEONGCHUN'
  `).get();
  const stationCatalogEvidence = database.prepare(`
    SELECT service_class AS serviceClass,
           station_catalog_artifact_kind AS stationCatalogArtifactKind,
           station_catalog_manifest_version AS stationCatalogManifestVersion,
           station_catalog_pack_id AS stationCatalogPackId,
           station_catalog_station_set_sha256 AS stationCatalogStationSetSha256,
           station_catalog_payload_sha256 AS stationCatalogPayloadSha256,
           station_catalog_manifest_sha256 AS stationCatalogManifestSha256,
           admission_status AS admissionStatus, admission_eligible AS admissionEligible,
           fresh_until AS freshUntil, source_issue AS sourceIssue
    FROM route_service_station_catalog_evidence WHERE service_class = 'ITX_CHEONGCHUN'
  `).get();
  const artifactCount = database.prepare("SELECT count(*) AS count FROM route_service_artifact_evidence").get().count;
  const stationCount = database.prepare("SELECT count(*) AS count FROM route_service_station_catalog_evidence").get().count;
  if (artifactCount !== 1 || stationCount !== 1
    || JSON.stringify({ artifactEvidence, stationCatalogEvidence }) !== JSON.stringify(admissionEvidence)) {
    throw new Error("current route service evidence replacement is incomplete");
  }
}

function ensureVersion19(database, admissionEvidence) {
  const currentVersion = database.prepare("PRAGMA user_version").get().user_version;
  if (currentVersion !== CATALOG_VERSION) {
    throw new Error(`ITX topology requires current catalog user_version ${CATALOG_VERSION}; found ${currentVersion}`);
  }
  const evidenceLayout = requireExactRouteServiceEvidenceLayout(database, currentVersion);
  ensureRouteServiceEvidenceSchemas(database, admissionEvidence, evidenceLayout);
}

export function applyTopology(sqlitePath, topology, admissionEvidence) {
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      validateRouteServiceEvidence(admissionEvidence);
      ensureVersion19(database, admissionEvidence);
      for (const station of topology.stations) {
        const exists = database.prepare(`
          SELECT EXISTS(
            SELECT 1 FROM station_lines sl
            JOIN route_map_positions rm
              ON rm.station_id = sl.station_id AND rm.line_id = sl.line_id
            WHERE sl.station_id = ? AND sl.line_id = ?
          ) AS present
        `).get(station.stationId, station.lineId).present;
        if (exists !== 1) {
          throw new Error(`ITX topology canonical station membership is missing: ${station.stationId}:${station.lineId}`);
        }
      }
      database.exec("DELETE FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN'");
      const insert = database.prepare(`
        INSERT INTO network_edges (
          id, from_node_id, to_node_id, duration_seconds, distance_meters,
          edge_type, service_pattern, service_class
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const edge of topology.edges) {
        insert.run(edge.id, edge.fromNodeId, edge.toNodeId, edge.durationSeconds,
          edge.distanceMeters, edge.edgeType, edge.servicePattern, edge.serviceClass);
      }
      writeRouteServiceEvidence(database, admissionEvidence);
      const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeys.length !== 0) throw new Error("ITX topology foreign_key_check failed");
      const integrity = database.prepare("PRAGMA integrity_check").get();
      if (integrity.integrity_check !== "ok") throw new Error("ITX topology integrity_check failed");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function assertStoredTopology(sqlitePath, topology, admissionEvidence) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) throw new Error("ITX topology foreign_key_check failed");
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") throw new Error("ITX topology integrity_check failed");
    if (database.prepare("PRAGMA user_version").get().user_version !== CATALOG_VERSION
      || !hasColumn(database, "network_edges", "service_class")) {
      throw new Error("ITX topology bundled schema is stale");
    }
    const stored = database.prepare(`
      SELECT id, from_node_id AS fromNodeId, to_node_id AS toNodeId,
             duration_seconds AS durationSeconds, distance_meters AS distanceMeters,
             edge_type AS edgeType, service_pattern AS servicePattern,
             service_class AS serviceClass
      FROM network_edges
      WHERE service_class = 'ITX_CHEONGCHUN'
      ORDER BY id
    `).all().map((row) => ({ ...row }));
    if (JSON.stringify(stored) !== JSON.stringify(topology.edges)) {
      throw new Error("ITX topology bundled edges are stale");
    }
    const timetableRows = database.prepare(`
      SELECT COUNT(*) AS count FROM transit_trips WHERE service_class = 'ITX_CHEONGCHUN'
    `).get().count;
    if (timetableRows !== 0) throw new Error("Mobile pack must not contain ITX timetable rows");
    const storedArtifactEvidence = database.prepare(`
      SELECT service_class AS serviceClass, timetable_artifact_id AS timetableArtifactId,
             timetable_artifact_sha256 AS timetableArtifactSha256,
             canonical_pack_id AS canonicalPackId, canonical_pack_sha256 AS canonicalPackSha256,
             canonical_pack_sqlite_sha256 AS canonicalPackSqliteSha256,
             admission_status AS admissionStatus, admission_eligible AS admissionEligible,
             fresh_until AS freshUntil, source_issue AS sourceIssue
      FROM route_service_artifact_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'
    `).get();
    const storedStationCatalogEvidence = database.prepare(`
      SELECT service_class AS serviceClass,
             station_catalog_artifact_kind AS stationCatalogArtifactKind,
             station_catalog_manifest_version AS stationCatalogManifestVersion,
             station_catalog_pack_id AS stationCatalogPackId,
             station_catalog_station_set_sha256 AS stationCatalogStationSetSha256,
             station_catalog_payload_sha256 AS stationCatalogPayloadSha256,
             station_catalog_manifest_sha256 AS stationCatalogManifestSha256,
             admission_status AS admissionStatus, admission_eligible AS admissionEligible,
             fresh_until AS freshUntil, source_issue AS sourceIssue
      FROM route_service_station_catalog_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'
    `).get();
    if (JSON.stringify({ artifactEvidence: storedArtifactEvidence, stationCatalogEvidence: storedStationCatalogEvidence })
      !== JSON.stringify(admissionEvidence)) {
      throw new Error("ITX topology route service admission evidence is stale");
    }
  } finally {
    database.close();
  }
}

async function main() {
  const packPath = path.resolve(root, option("--pack", "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  const indexPath = path.resolve(root, option("--index", "apps/mobile/assets/datapacks/index.json"));
  const contractPath = path.resolve(root, option("--contract", "tools/datapack/itx-cheongchun-coverage-contract.json"));
  const evidencePath = path.resolve(root, option("--evidence", "tools/datapack/itx-cheongchun-topology-evidence.json"));
  const currentAdmissionOption = option("--current-admission", null);
  const currentAdmissionPath = currentAdmissionOption == null ? null : path.resolve(root, currentAdmissionOption);
  const fixtureProjectionPath = option("--project-fixture", null);
  const check = process.argv.includes("--check");
  const migrateCurrentV18Requested = process.argv.includes("--migrate-current-v18");
  if ([check, migrateCurrentV18Requested, fixtureProjectionPath != null].filter(Boolean).length > 1) {
    throw new Error("--check, --migrate-current-v18 and --project-fixture are mutually exclusive");
  }
  if (migrateCurrentV18Requested) {
    throw new Error("--migrate-current-v18 is forbidden by the current-only datapack contract");
  }
  if (check) {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    if (Object.hasOwn(evidence, "migration")) {
      throw new Error("ITX topology migration evidence is forbidden by the current-only datapack contract");
    }
  }
  const { contract, reference, source, sourceBytes, currentAdmission, currentProjection } =
    await admittedSource(contractPath, currentAdmissionPath);
  const topologySource = await admittedTopologySource(reference, source, currentAdmission);
  const topology = deriveTopology(source);
  if (fixtureProjectionPath != null) {
    const fixturePath = path.resolve(root, fixtureProjectionPath);
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    projectItxTopologyIntoCanonicalFixture(fixture, topology);
    await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);
    return;
  }
  const admittedInputPack = topologyInputPackIdentity(
    contract?.officialEvidence?.korailCompletenessAdmission?.topologyInputPackIdentity,
    "ITX topology input pack identity",
  );
  const admissionEvidence = routeServiceEvidence(
    contract,
    reference,
    source,
    admittedInputPack,
    currentProjection,
  );
  if (admittedInputPack.sha256 !== topologySource.gzipSha256
    || admittedInputPack.sqliteSha256 !== topologySource.sqliteSha256
    || admittedInputPack.byteSize !== topologySource.byteSize) {
    throw new Error("ITX topology input pack identity does not match the admitted current source");
  }
  const inputGzipBytes = await readFile(packPath);
  if (check) {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const { inputSqliteBytes } = validateTopologyEvidence({
      contract,
      reference,
      source,
      topology,
      evidence,
      index,
      inputGzipBytes,
      admittedInput: topologySource,
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), `itx-topology-check-${randomUUID()}-`));
    try {
      const sqlitePath = path.join(directory, "capital.sqlite");
      if (sha256(inputSqliteBytes) !== evidence.pack.outputSqliteSha256) {
        throw new Error("ITX topology bundled SQLite identity is stale");
      }
      await writeFile(sqlitePath, inputSqliteBytes);
      assertStoredTopology(sqlitePath, topology, admissionEvidence);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), `itx-topology-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    const inputSqliteBytes = gunzipSync(inputGzipBytes);
    if (admittedInputPack.sha256 !== sha256(inputGzipBytes)
      || admittedInputPack.sqliteSha256 !== sha256(inputSqliteBytes)
      || admittedInputPack.byteSize !== inputGzipBytes.length) {
      throw new Error("ITX topology input pack does not match the coverage contract");
    }
    await writeFile(sqlitePath, inputSqliteBytes);
    applyTopology(sqlitePath, topology, admissionEvidence);
    const outputSqliteBytes = await readFile(sqlitePath);
    const outputGzipBytes = gzipSync(outputSqliteBytes, { level: 9, mtime: 0 });
    if (outputGzipBytes.length - inputGzipBytes.length > MAX_GZIP_DELTA_BYTES) {
      throw new Error("ITX topology exceeds the 64 KiB compressed size budget");
    }
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const pack = index.packs?.find(({ id }) => id === "capital");
    if (!pack || pack.sha256 !== sha256(inputGzipBytes)) {
      throw new Error("ITX topology bundled pack index is stale");
    }
    Object.assign(pack, {
      sha256: sha256(outputGzipBytes),
      sqliteSha256: sha256(outputSqliteBytes),
      byteSize: outputGzipBytes.length,
    });
    const evidence = {
      schemaVersion: 1,
      artifactKind: "itx-cheongchun-mobile-topology-evidence",
      serviceId: "ITX_CHEONGCHUN",
      sourceIssue: 2135,
      stationCatalogPackIdentity: source.stationCatalogPackIdentity,
      sourceArtifact: {
        id: reference.artifactId,
        sha256: sha256(sourceBytes),
        completenessEvidenceSha256: reference.completenessEvidenceSha256,
        freshUntil: reference.freshUntil,
        stationCatalogPackIdentity: source.stationCatalogPackIdentity,
      },
      topology: {
        stationMembershipCount: topology.stations.length,
        servedStationCount: topology.servedStations.length,
        edgeCount: topology.edges.length,
        directions: ["up", "down"],
        connectedComponentCount: 1,
        isolatedServedStationCount: 0,
        sha256: topology.sha256,
        durationSecondsEmbedded: false,
        fareEmbedded: false,
      },
      pack: {
        id: "capital",
        inputSha256: sha256(inputGzipBytes),
        inputSqliteSha256: sha256(inputSqliteBytes),
        inputByteSize: inputGzipBytes.length,
        outputSha256: sha256(outputGzipBytes),
        outputSqliteSha256: sha256(outputSqliteBytes),
        byteSize: outputGzipBytes.length,
        byteSizeDelta: outputGzipBytes.length - inputGzipBytes.length,
      },
    };
    await writeFile(packPath, outputGzipBytes);
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
