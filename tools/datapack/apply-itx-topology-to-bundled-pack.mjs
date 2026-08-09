#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { emitStationCatalogFromBundledPack } from "./emit-station-catalog-from-bundled-pack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const CATALOG_VERSION = 19;
const EXPECTED_EDGE_COUNT = 48;
const MAX_GZIP_DELTA_BYTES = 64 * 1024;
const CURRENT_V18_MIGRATION_INPUT = Object.freeze({
  id: "capital",
  sha256: "f328fbedff014be18a0e8341e0bdbfe9b0dd774fa7e9ae7692aa869e831707b3",
  sqliteSha256: "a581c5d2a78f765b859e7e7b7d62d3bf0d9b573bcebd246ab4c6f0cd62fddfc5",
  byteSize: 1463745,
});

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

async function admittedSource(contractPath) {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const reference = contract?.sourceTimetableArtifact;
  validateAdmittedSourceReference(contract, reference);
  const sourceBytes = await readFile(repositoryPath(reference.artifactPath));
  const completenessBytes = await readFile(repositoryPath(reference.completenessEvidencePath));
  const { source, completeness } = parseAuthenticatedAdmittedSourceDocuments(
    reference,
    sourceBytes,
    completenessBytes,
  );
  validateAdmittedSourceDocuments(
    contract,
    reference,
    source,
    completeness,
    sha256(sourceBytes),
    sha256(completenessBytes),
  );
  return { contract, reference, source, sourceBytes };
}

function validateAdmittedSourceReference(contract, reference) {
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
) {
  validateAdmittedSourceReference(contract, reference);
  if (sourceSha256 !== reference.sha256
    || completenessSha256 !== reference.completenessEvidenceSha256) {
    throw new Error("ITX topology source bytes do not match the coverage contract");
  }
  const freshUntilMillis = Date.parse(reference.freshUntil);
  if (!Number.isFinite(freshUntilMillis) || freshUntilMillis <= candidateBuildNow().getTime()) {
    throw new Error("ITX topology source artifact is expired");
  }
  const admission = contract?.officialEvidence?.korailCompletenessAdmission;
  if (Object.hasOwn(source ?? {}, "canonicalPackIdentity")
    || Object.hasOwn(source ?? {}, "readmissions")
    || Object.hasOwn(completeness ?? {}, "canonicalPackIdentity")
    || Object.hasOwn(completeness ?? {}, "readmissions")
    || Object.hasOwn(admission ?? {}, "canonicalPackIdentity")
    || reference?.promotion?.mode !== "CURRENT_CANDIDATE_OWNER_APPROVED") {
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
    || completeness?.sourceTimetableArtifact?.status !== "SUPPORTED"
    || completeness?.sourceTimetableArtifact?.artifactId !== reference.artifactId
    || completeness?.sourceTimetableArtifact?.policyVersion !== source.policyVersion
    || completeness?.sourceTimetableArtifact?.freshUntil !== reference.freshUntil
    || JSON.stringify(completeness?.selectedServiceDates) !== JSON.stringify(source.selectedServiceDates)
    || !completeness?.allowedConsumerIssues?.includes("#1400")
    || completeness?.credentialRedacted !== true) {
    throw new Error("ITX topology source identity is invalid");
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

export async function admittedTopologySource(reference, source) {
  if (Object.hasOwn(source, "canonicalPackIdentity")
    || Object.hasOwn(source, "readmissions")
    || reference?.promotion?.mode !== "CURRENT_CANDIDATE_OWNER_APPROVED") {
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

function validateCurrentV18MigrationInput({ reference, topology, evidence, index, inputGzipBytes }) {
  const inputSqliteBytes = gunzipSync(inputGzipBytes);
  const pack = index?.packs?.find(({ id }) => id === "capital");
  if (sha256(inputGzipBytes) !== CURRENT_V18_MIGRATION_INPUT.sha256
    || sha256(inputSqliteBytes) !== CURRENT_V18_MIGRATION_INPUT.sqliteSha256
    || inputGzipBytes.length !== CURRENT_V18_MIGRATION_INPUT.byteSize
    || !hasExactKeys(evidence, ["schemaVersion", "artifactKind", "serviceId", "sourceIssue", "sourceArtifact", "topology", "pack", "readmissions"])
    || evidence.schemaVersion !== 1
    || evidence.artifactKind !== "itx-cheongchun-mobile-topology-evidence"
    || evidence.serviceId !== "ITX_CHEONGCHUN" || evidence.sourceIssue !== 2135
    || !hasExactKeys(evidence.sourceArtifact, ["id", "sha256", "completenessEvidenceSha256", "freshUntil"])
    || evidence.sourceArtifact.id !== reference.id
    || evidence.sourceArtifact.sha256 !== reference.sha256
    || evidence.sourceArtifact.completenessEvidenceSha256 !== reference.completenessEvidenceSha256
    || evidence.sourceArtifact.freshUntil !== reference.freshUntil
    || !hasExactKeys(evidence.topology, [
      "stationMembershipCount", "servedStationCount", "edgeCount", "directions",
      "connectedComponentCount", "isolatedServedStationCount", "sha256",
      "durationSecondsEmbedded", "fareEmbedded",
    ])
    || evidence.topology.stationMembershipCount !== topology.stations.length
    || evidence.topology.servedStationCount !== topology.servedStations.length
    || evidence.topology.edgeCount !== topology.edges.length
    || evidence.topology.sha256 !== topology.sha256
    || JSON.stringify(evidence.topology.directions) !== JSON.stringify(["up", "down"])
    || evidence.topology.connectedComponentCount !== 1 || evidence.topology.isolatedServedStationCount !== 0
    || evidence.topology.durationSecondsEmbedded !== false || evidence.topology.fareEmbedded !== false
    || !Array.isArray(evidence.readmissions)
    || JSON.stringify(evidence.pack) !== JSON.stringify({
      id: "capital", inputSha256: "7bb4bb68f0642e45377d98b083e93cd8c1c92aaa58dd353f32189e3f325a1562",
      inputSqliteSha256: "ed84a649952cd2ccbb238b3a63265f2bd3144497ae8fd36fab5181ad776542fc",
      inputByteSize: 359319, outputSha256: CURRENT_V18_MIGRATION_INPUT.sha256,
      outputSqliteSha256: CURRENT_V18_MIGRATION_INPUT.sqliteSha256,
      byteSize: CURRENT_V18_MIGRATION_INPUT.byteSize, byteSizeDelta: 1104426,
    })
    || pack?.sha256 !== CURRENT_V18_MIGRATION_INPUT.sha256
    || pack?.sqliteSha256 !== CURRENT_V18_MIGRATION_INPUT.sqliteSha256
    || pack?.byteSize !== CURRENT_V18_MIGRATION_INPUT.byteSize) {
    throw new Error("ITX topology current v18 migration input is not exact");
  }
  return { inputSqliteBytes };
}

function assertStoredV18Topology(sqlitePath, topology) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const columns = database.prepare("PRAGMA table_info(route_service_artifact_evidence)").all()
      .map(({ name, type, notnull, pk }) => [name, type, notnull, pk]);
    const exactV18 = JSON.stringify(columns) === JSON.stringify(ROUTE_SERVICE_ARTIFACT_EVIDENCE_LAYOUT)
      && !tableExists(database, "route_service_station_catalog_evidence")
      && normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='route_service_artifact_evidence'").get().sql)
        .includes(normalizedSql("CHECK (admission_status IN ('MISSING', 'ADMITTED'))"));
    if (database.prepare("PRAGMA user_version").get().user_version !== 18 || !exactV18) {
      throw new Error("ITX topology current v18 schema is not exact");
    }
    const edges = database.prepare(`
      SELECT id, from_node_id AS fromNodeId, to_node_id AS toNodeId,
             duration_seconds AS durationSeconds, distance_meters AS distanceMeters,
             edge_type AS edgeType, service_pattern AS servicePattern, service_class AS serviceClass
      FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN' ORDER BY id
    `).all().map((row) => ({ ...row }));
    const itxTrips = database.prepare(`SELECT count(*) AS count FROM transit_trips
      WHERE service_class = 'ITX_CHEONGCHUN'`).get().count;
    if (JSON.stringify(edges) !== JSON.stringify(topology.edges) || itxTrips !== 0) {
      throw new Error("ITX topology current v18 topology is stale");
    }
  } finally { database.close(); }
}

async function currentV18MigrationContext(evidence) {
  const sourceArtifact = evidence?.sourceArtifact;
  const artifactId = "itx-cheongchun-source-timetable-20260719230524758";
  const artifactSha256 = "e2894d7ce6decb08fc9fec982394e77151799c34d099b83948481080e56d780e";
  if (!hasExactKeys(sourceArtifact, ["id", "sha256", "completenessEvidenceSha256", "freshUntil"])
    || sourceArtifact.id !== artifactId || sourceArtifact.sha256 !== artifactSha256
    || sourceArtifact.completenessEvidenceSha256 !== "b4a6f90490f2f6b56f396e9cc59e053d1ba02f3d3fe9cf5993b871bfc2d68201"
    || sourceArtifact.freshUntil !== "2026-07-27T00:00:00+09:00") {
    throw new Error("ITX topology current v18 source evidence is not exact");
  }
  const sourceBytes = await readFile(repositoryPath(`tools/datapack/sources/${artifactId}.json`));
  if (sha256(sourceBytes) !== artifactSha256) {
    throw new Error("ITX topology current v18 source artifact is not exact");
  }
  const source = JSON.parse(sourceBytes);
  return { sourceArtifact, topology: deriveTopology(source) };
}

function migrationAdmissionEvidence(sqlitePath, stationCatalogIdentity) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT timetable_artifact_id AS timetableArtifactId,
             timetable_artifact_sha256 AS timetableArtifactSha256,
             canonical_pack_id AS canonicalPackId, canonical_pack_sha256 AS canonicalPackSha256,
             canonical_pack_sqlite_sha256 AS canonicalPackSqliteSha256,
             admission_status AS admissionStatus, admission_eligible AS admissionEligible,
             fresh_until AS freshUntil, source_issue AS sourceIssue
      FROM route_service_artifact_evidence WHERE service_class = 'ITX_CHEONGCHUN'
    `).get();
    if (row == null || row.admissionStatus !== "ADMITTED" || row.admissionEligible !== 1
      || row.sourceIssue !== 2135 || typeof row.freshUntil !== "string"
      || ![row.timetableArtifactSha256, row.canonicalPackSha256, row.canonicalPackSqliteSha256].every((value) => /^[a-f0-9]{64}$/.test(value ?? ""))) {
      throw new Error("ITX topology current v18 evidence row is not exact");
    }
    return {
      artifactEvidence: {
        serviceClass: "ITX_CHEONGCHUN", timetableArtifactId: row.timetableArtifactId,
        timetableArtifactSha256: row.timetableArtifactSha256, canonicalPackId: row.canonicalPackId,
        canonicalPackSha256: row.canonicalPackSha256,
        canonicalPackSqliteSha256: row.canonicalPackSqliteSha256,
        admissionStatus: row.admissionStatus, admissionEligible: row.admissionEligible,
        freshUntil: row.freshUntil, sourceIssue: row.sourceIssue,
      },
      stationCatalogEvidence: {
        serviceClass: "ITX_CHEONGCHUN", stationCatalogArtifactKind: stationCatalogIdentity.artifactKind,
        stationCatalogManifestVersion: stationCatalogIdentity.manifestVersion,
        stationCatalogPackId: stationCatalogIdentity.catalogPackId,
        stationCatalogStationSetSha256: stationCatalogIdentity.stationSetSha256,
        stationCatalogPayloadSha256: stationCatalogIdentity.payloadSha256,
        stationCatalogManifestSha256: stationCatalogIdentity.manifestSha256,
        admissionStatus: row.admissionStatus, admissionEligible: row.admissionEligible,
        freshUntil: row.freshUntil, sourceIssue: 2649,
      },
    };
  } finally { database.close(); }
}

function migrationEvidence({ sourceArtifact, topology, admissionEvidence, inputGzipBytes, inputSqliteBytes, outputGzipBytes, outputSqliteBytes }) {
  return {
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-mobile-topology-evidence",
    serviceId: "ITX_CHEONGCHUN",
    sourceIssue: 2135,
    sourceArtifact,
    topology: {
      stationMembershipCount: topology.stations.length, servedStationCount: topology.servedStations.length,
      edgeCount: topology.edges.length, directions: ["up", "down"], connectedComponentCount: 1,
      isolatedServedStationCount: 0, sha256: topology.sha256, durationSecondsEmbedded: false,
      fareEmbedded: false,
    },
    migration: { fromCatalogVersion: 18, toCatalogVersion: 19, inputPack: CURRENT_V18_MIGRATION_INPUT },
    routeServiceEvidence: admissionEvidence,
    pack: {
      id: "capital", inputSha256: sha256(inputGzipBytes), inputSqliteSha256: sha256(inputSqliteBytes),
      inputByteSize: inputGzipBytes.length, outputSha256: sha256(outputGzipBytes),
      outputSqliteSha256: sha256(outputSqliteBytes), byteSize: outputGzipBytes.length,
      byteSizeDelta: outputGzipBytes.length - inputGzipBytes.length,
    },
  };
}

async function writeMigrationOutputs(outputs) {
  const suffix = `.migration-${randomUUID()}.tmp`;
  const staged = outputs.map(({ file, bytes }) => ({ file, bytes, temporary: `${file}${suffix}` }));
  try {
    await Promise.all(staged.map(({ temporary, bytes }) => writeFile(temporary, bytes)));
    for (const { file, temporary } of staged) await rename(temporary, file);
  } finally {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
  }
}

async function verifiedCurrentV18StationCatalog(packPath, artifactPath) {
  const manifestPath = path.join(artifactPath, "manifest.json");
  const payloadPath = path.join(artifactPath, "payload", "catalog.sqlite");
  const artifact = await lstat(artifactPath).catch(() => undefined);
  const manifestStat = await lstat(manifestPath).catch(() => undefined);
  const payloadStat = await lstat(payloadPath).catch(() => undefined);
  if (!artifact?.isDirectory() || artifact.isSymbolicLink() || !manifestStat?.isFile()
    || manifestStat.isSymbolicLink() || !payloadStat?.isFile() || payloadStat.isSymbolicLink()) {
    throw new Error("ITX topology station catalog artifact is not a regular artifact");
  }
  const actual = await Promise.all([manifestPath, payloadPath].map(async (file) => {
    const value = await readFile(file); return { file, value };
  }));
  const manifest = JSON.parse(actual[0].value);
  if (!hasExactKeys(manifest, ["manifestVersion", "artifactKind", "catalogPackId", "stationSetSha256", "payloadSha256"])
    || manifest.manifestVersion !== 1 || manifest.artifactKind !== "station-catalog-pack"
    || manifest.catalogPackId !== "capital-station-catalog-d85742f14cbf97c526a6b94dd55bbf863e1d1346-v1"
    || ![manifest.stationSetSha256, manifest.payloadSha256].every((value) => /^[a-f0-9]{64}$/.test(value ?? ""))) {
    throw new Error("ITX topology station catalog manifest is not exact");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), `itx-current-v18-station-catalog-${randomUUID()}-`));
  try {
    const expected = path.join(directory, "expected");
    await emitStationCatalogFromBundledPack({ input: packPath, output: expected });
    const [expectedManifest, expectedPayload] = await Promise.all([
      readFile(path.join(expected, "manifest.json")), readFile(path.join(expected, "payload", "catalog.sqlite")),
    ]);
    if (!actual[0].value.equals(expectedManifest) || !actual[1].value.equals(expectedPayload)) {
      throw new Error("ITX topology station catalog artifact does not equal the exact v18 projection");
    }
    const decoded = JSON.parse(actual[0].value);
    return {
      artifactKind: decoded.artifactKind, manifestVersion: decoded.manifestVersion,
      catalogPackId: decoded.catalogPackId, stationSetSha256: decoded.stationSetSha256,
      payloadSha256: decoded.payloadSha256, manifestSha256: sha256(actual[0].value),
    };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function routeServiceEvidence(contract, reference, source, canonicalPackIdentity) {
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
      freshUntil: reference.freshUntil,
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
      freshUntil: reference.freshUntil,
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
  const edgeKeys = new Set(edges.keys());
  if (edgeKeys.size !== EXPECTED_EDGE_COUNT
    || [...edgeKeys].some((key) => {
      const [from, to] = key.split("->");
      return !edgeKeys.has(`${to}->${from}`);
    })) {
    throw new Error(`ITX topology requires ${EXPECTED_EDGE_COUNT} paired directed edges`);
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
  const legacyV18Artifact = !stationExists && tableHasExactLayout(database,
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
  if (currentVersion < 16 || currentVersion > CATALOG_VERSION) {
    throw new Error(`ITX topology does not support catalog user_version ${currentVersion}`);
  }
  const evidenceLayout = requireExactRouteServiceEvidenceLayout(database, currentVersion);
  if (!hasColumn(database, "transit_trips", "service_class")) {
    database.exec("ALTER TABLE transit_trips ADD COLUMN service_class TEXT NOT NULL DEFAULT 'SUBWAY'");
  }
  if (!hasColumn(database, "network_edges", "service_class")) {
    database.exec("ALTER TABLE network_edges ADD COLUMN service_class TEXT NOT NULL DEFAULT 'SUBWAY'");
  }
  ensureRouteServiceEvidenceSchemas(database, admissionEvidence, evidenceLayout);
  database.exec(`PRAGMA user_version = ${CATALOG_VERSION}`);
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

async function migrateCurrentV18({ packPath, indexPath, evidencePath, stationCatalogPackPath }) {
  const [inputGzipBytes, indexBytes, evidenceBytes] = await Promise.all([
    readFile(packPath), readFile(indexPath), readFile(evidencePath),
  ]);
  const index = JSON.parse(indexBytes);
  const legacyEvidence = JSON.parse(evidenceBytes);
  const { topology, sourceArtifact } = await currentV18MigrationContext(legacyEvidence);
  const { inputSqliteBytes } = validateCurrentV18MigrationInput({
    reference: legacyEvidence.sourceArtifact, topology, evidence: legacyEvidence, index, inputGzipBytes,
  });
  const stationCatalogIdentity = await verifiedCurrentV18StationCatalog(packPath, stationCatalogPackPath);
  const directory = await mkdtemp(path.join(os.tmpdir(), `itx-current-v18-migration-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    await writeFile(sqlitePath, inputSqliteBytes);
    assertStoredV18Topology(sqlitePath, topology);
    const admissionEvidence = migrationAdmissionEvidence(sqlitePath, stationCatalogIdentity);
    applyTopology(sqlitePath, topology, admissionEvidence);
    assertStoredTopology(sqlitePath, topology, admissionEvidence);
    const outputSqliteBytes = await readFile(sqlitePath);
    const outputGzipBytes = gzipSync(outputSqliteBytes, { level: 9, mtime: 0 });
    if (outputGzipBytes.length - inputGzipBytes.length > MAX_GZIP_DELTA_BYTES) {
      throw new Error("ITX topology exceeds the 64 KiB compressed size budget");
    }
    const migratedIndex = structuredClone(index);
    const migratedPack = migratedIndex.packs.find(({ id }) => id === "capital");
    Object.assign(migratedPack, {
      sha256: sha256(outputGzipBytes), sqliteSha256: sha256(outputSqliteBytes), byteSize: outputGzipBytes.length,
    });
    const migratedEvidence = migrationEvidence({
      sourceArtifact, topology, admissionEvidence, inputGzipBytes, inputSqliteBytes,
      outputGzipBytes, outputSqliteBytes,
    });
    const outputPath = path.join(directory, "output.sqlite");
    await writeFile(outputPath, outputSqliteBytes);
    assertStoredTopology(outputPath, topology, admissionEvidence);
    await writeMigrationOutputs([
      { file: packPath, bytes: outputGzipBytes },
      { file: indexPath, bytes: `${JSON.stringify(migratedIndex, null, 2)}\n` },
      { file: evidencePath, bytes: `${JSON.stringify(migratedEvidence, null, 2)}\n` },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkMigratedCurrentV18({ packPath, indexPath, evidencePath }) {
  const [packBytes, indexBytes, evidenceBytes] = await Promise.all([readFile(packPath), readFile(indexPath), readFile(evidencePath)]);
  const evidence = JSON.parse(evidenceBytes);
  const index = JSON.parse(indexBytes);
  const { topology } = await currentV18MigrationContext(evidence);
  if (!hasExactKeys(evidence, ["schemaVersion", "artifactKind", "serviceId", "sourceIssue", "sourceArtifact", "topology", "migration", "routeServiceEvidence", "pack"])
    || evidence.schemaVersion !== 1 || evidence.artifactKind !== "itx-cheongchun-mobile-topology-evidence"
    || evidence.serviceId !== "ITX_CHEONGCHUN" || evidence.sourceIssue !== 2135
    || !hasExactKeys(evidence.migration, ["fromCatalogVersion", "toCatalogVersion", "inputPack"])
    || evidence.migration.fromCatalogVersion !== 18 || evidence.migration.toCatalogVersion !== 19
    || JSON.stringify(evidence.migration.inputPack) !== JSON.stringify(CURRENT_V18_MIGRATION_INPUT)
    || evidence.pack?.outputSha256 !== sha256(packBytes)
    || evidence.pack?.outputSqliteSha256 !== sha256(gunzipSync(packBytes))
    || evidence.pack?.byteSize !== packBytes.length
    || evidence.pack?.inputSha256 !== CURRENT_V18_MIGRATION_INPUT.sha256
    || index.packs?.find(({ id }) => id === "capital")?.sha256 !== sha256(packBytes)) {
    throw new Error("ITX topology migrated v19 evidence or index is stale");
  }
  validateRouteServiceEvidence(evidence.routeServiceEvidence);
  const directory = await mkdtemp(path.join(os.tmpdir(), `itx-current-v18-check-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    await writeFile(sqlitePath, gunzipSync(packBytes));
    assertStoredTopology(sqlitePath, topology, evidence.routeServiceEvidence);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function main() {
  const packPath = path.resolve(root, option("--pack", "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  const indexPath = path.resolve(root, option("--index", "apps/mobile/assets/datapacks/index.json"));
  const contractPath = path.resolve(root, option("--contract", "tools/datapack/itx-cheongchun-coverage-contract.json"));
  const evidencePath = path.resolve(root, option("--evidence", "tools/datapack/itx-cheongchun-topology-evidence.json"));
  const stationCatalogPackPath = option("--station-catalog-pack", null);
  const check = process.argv.includes("--check");
  const migrateCurrentV18Requested = process.argv.includes("--migrate-current-v18");
  if (check && migrateCurrentV18Requested) {
    throw new Error("--check and --migrate-current-v18 are mutually exclusive");
  }
  if (migrateCurrentV18Requested) {
    if (stationCatalogPackPath == null) throw new Error("--migrate-current-v18 requires --station-catalog-pack");
    await migrateCurrentV18({ packPath, indexPath, evidencePath, stationCatalogPackPath: path.resolve(root, stationCatalogPackPath) });
    return;
  }
  if (check) {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    if (evidence?.migration?.fromCatalogVersion === 18) {
      await checkMigratedCurrentV18({ packPath, indexPath, evidencePath });
      return;
    }
  }
  const { contract, reference, source, sourceBytes } = await admittedSource(contractPath);
  const topologySource = await admittedTopologySource(reference, source);
  const topology = deriveTopology(source);
  const admittedInputPack = topologyInputPackIdentity(
    contract?.officialEvidence?.korailCompletenessAdmission?.topologyInputPackIdentity,
    "ITX topology input pack identity",
  );
  const admissionEvidence = routeServiceEvidence(contract, reference, source, admittedInputPack);
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
