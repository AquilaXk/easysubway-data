#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const CATALOG_VERSION = 18;
const EXPECTED_EDGE_COUNT = 48;
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
]);
const ROUTE_SERVICE_EVIDENCE_COLUMNS = `
  service_class TEXT NOT NULL PRIMARY KEY,
  timetable_artifact_id TEXT NOT NULL,
  timetable_artifact_sha256 TEXT NOT NULL,
  station_catalog_artifact_kind TEXT NOT NULL,
  station_catalog_manifest_version INTEGER NOT NULL,
  station_catalog_pack_id TEXT NOT NULL,
  station_catalog_station_set_sha256 TEXT NOT NULL,
  station_catalog_payload_sha256 TEXT NOT NULL,
  station_catalog_manifest_sha256 TEXT NOT NULL,
  admission_status TEXT NOT NULL,
  admission_eligible INTEGER NOT NULL,
  fresh_until TEXT,
  source_issue INTEGER NOT NULL,
  CHECK (service_class = 'ITX_CHEONGCHUN'),
  CHECK (length(timetable_artifact_sha256) = 64 AND timetable_artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (station_catalog_artifact_kind = 'station-catalog-pack'),
  CHECK (station_catalog_manifest_version = 1),
  CHECK (length(station_catalog_pack_id) > 0),
  CHECK (length(station_catalog_station_set_sha256) = 64 AND station_catalog_station_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(station_catalog_payload_sha256) = 64 AND station_catalog_payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(station_catalog_manifest_sha256) = 64 AND station_catalog_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (admission_status = 'ADMITTED'),
  CHECK (admission_eligible = 1),
  CHECK (fresh_until IS NOT NULL),
  CHECK (source_issue IN (2116, 2135))
`;
const ROUTE_SERVICE_EVIDENCE_COLUMN_NAMES = Object.freeze([
  "service_class",
  "timetable_artifact_id",
  "timetable_artifact_sha256",
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
  if (value == null || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    || value.artifactKind !== "station-catalog-pack"
    || value.manifestVersion !== 1
    || typeof value.catalogPackId !== "string" || value.catalogPackId.length === 0
    || ![value.stationSetSha256, value.payloadSha256, value.manifestSha256]
      .every((digest) => /^[a-f0-9]{64}$/.test(digest ?? ""))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function hasExactKeys(value, keys) {
  return value != null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export async function admittedTopologySource(reference, source) {
  const identity = stationCatalogIdentity(source?.stationCatalogPackIdentity, "ITX topology station catalog identity");
  if (Object.hasOwn(source, "canonicalPackIdentity")
    || Object.hasOwn(source, "readmissions")
    || reference?.promotion?.mode !== "CURRENT_CANDIDATE_OWNER_APPROVED") {
    throw new Error("ITX topology legacy admission is forbidden");
  }
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

function routeServiceEvidence(contract, reference, source) {
  const identity = stationCatalogIdentity(
    contract?.officialEvidence?.korailCompletenessAdmission?.stationCatalogPackIdentity,
    "ITX coverage station catalog identity",
  );
  if (JSON.stringify(identity) !== JSON.stringify(source?.stationCatalogPackIdentity)) {
    throw new Error("ITX coverage and source station catalog identity mismatch");
  }
  return {
    serviceClass: "ITX_CHEONGCHUN",
    timetableArtifactId: reference.artifactId,
    timetableArtifactSha256: reference.sha256,
    stationCatalogArtifactKind: identity.artifactKind,
    stationCatalogManifestVersion: identity.manifestVersion,
    stationCatalogPackId: identity.catalogPackId,
    stationCatalogStationSetSha256: identity.stationSetSha256,
    stationCatalogPayloadSha256: identity.payloadSha256,
    stationCatalogManifestSha256: identity.manifestSha256,
    admissionStatus: "ADMITTED",
    admissionEligible: 1,
    freshUntil: reference.freshUntil,
    sourceIssue: 2135,
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
  database.prepare("DELETE FROM route_service_artifact_evidence WHERE service_class = 'ITX_CHEONGCHUN'").run();
  database.prepare(`
    INSERT INTO route_service_artifact_evidence (
      service_class, timetable_artifact_id, timetable_artifact_sha256,
      station_catalog_artifact_kind, station_catalog_manifest_version,
      station_catalog_pack_id, station_catalog_station_set_sha256,
      station_catalog_payload_sha256, station_catalog_manifest_sha256,
      admission_status, admission_eligible, fresh_until, source_issue
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    admissionEvidence.serviceClass,
    admissionEvidence.timetableArtifactId,
    admissionEvidence.timetableArtifactSha256,
    admissionEvidence.stationCatalogArtifactKind,
    admissionEvidence.stationCatalogManifestVersion,
    admissionEvidence.stationCatalogPackId,
    admissionEvidence.stationCatalogStationSetSha256,
    admissionEvidence.stationCatalogPayloadSha256,
    admissionEvidence.stationCatalogManifestSha256,
    admissionEvidence.admissionStatus,
    admissionEvidence.admissionEligible,
    admissionEvidence.freshUntil,
    admissionEvidence.sourceIssue,
  );
}

function ensureRouteServiceEvidenceSchema(database, admissionEvidence) {
  const table = database.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'route_service_artifact_evidence'
  `).get();
  if (table == null) {
    database.exec(`CREATE TABLE route_service_artifact_evidence (${ROUTE_SERVICE_EVIDENCE_COLUMNS})`);
    return;
  }
  const columns = database.prepare("PRAGMA table_info(route_service_artifact_evidence)")
    .all()
    .map(({ name }) => name);
  if (JSON.stringify(columns) === JSON.stringify(ROUTE_SERVICE_EVIDENCE_COLUMN_NAMES)
    && table.sql.includes("station_catalog_manifest_sha256")
    && !table.sql.includes("canonical_pack_")) return;
  database.exec(`
    ALTER TABLE route_service_artifact_evidence
      RENAME TO route_service_artifact_evidence_replaced;
    CREATE TABLE route_service_artifact_evidence (${ROUTE_SERVICE_EVIDENCE_COLUMNS});
  `);
  writeRouteServiceEvidence(database, admissionEvidence);
  const replacement = database.prepare(`
    SELECT timetable_artifact_sha256 AS timetableArtifactSha256,
           station_catalog_manifest_sha256 AS stationCatalogManifestSha256
    FROM route_service_artifact_evidence WHERE service_class = 'ITX_CHEONGCHUN'
  `).get();
  if (replacement?.timetableArtifactSha256 !== admissionEvidence.timetableArtifactSha256
    || replacement?.stationCatalogManifestSha256 !== admissionEvidence.stationCatalogManifestSha256) {
    throw new Error("current route service evidence replacement is incomplete");
  }
  database.exec("DROP TABLE route_service_artifact_evidence_replaced");
}

function ensureVersion18(database, admissionEvidence) {
  const currentVersion = database.prepare("PRAGMA user_version").get().user_version;
  if (currentVersion < 16 || currentVersion > CATALOG_VERSION) {
    throw new Error(`ITX topology does not support catalog user_version ${currentVersion}`);
  }
  if (!hasColumn(database, "transit_trips", "service_class")) {
    database.exec("ALTER TABLE transit_trips ADD COLUMN service_class TEXT NOT NULL DEFAULT 'SUBWAY'");
  }
  if (!hasColumn(database, "network_edges", "service_class")) {
    database.exec("ALTER TABLE network_edges ADD COLUMN service_class TEXT NOT NULL DEFAULT 'SUBWAY'");
  }
  ensureRouteServiceEvidenceSchema(database, admissionEvidence);
  database.exec(`PRAGMA user_version = ${CATALOG_VERSION}`);
}

export function applyTopology(sqlitePath, topology, admissionEvidence) {
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      ensureVersion18(database, admissionEvidence);
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
    const storedEvidence = database.prepare(`
      SELECT service_class AS serviceClass, timetable_artifact_id AS timetableArtifactId,
             timetable_artifact_sha256 AS timetableArtifactSha256,
             station_catalog_artifact_kind AS stationCatalogArtifactKind,
             station_catalog_manifest_version AS stationCatalogManifestVersion,
             station_catalog_pack_id AS stationCatalogPackId,
             station_catalog_station_set_sha256 AS stationCatalogStationSetSha256,
             station_catalog_payload_sha256 AS stationCatalogPayloadSha256,
             station_catalog_manifest_sha256 AS stationCatalogManifestSha256,
             admission_status AS admissionStatus, admission_eligible AS admissionEligible,
             fresh_until AS freshUntil, source_issue AS sourceIssue
      FROM route_service_artifact_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'
    `).get();
    if (JSON.stringify(storedEvidence) !== JSON.stringify(admissionEvidence)) {
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
  let check = process.argv.includes("--check");
  const { contract, reference, source, sourceBytes } = await admittedSource(contractPath);
  const topologySource = await admittedTopologySource(reference, source);
  const topology = deriveTopology(source);
  const admissionEvidence = routeServiceEvidence(contract, reference, source);
  const inputGzipBytes = await readFile(packPath);
  if (!check) {
    try {
      const existingEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
      check = existingEvidence?.pack?.outputSha256 === sha256(inputGzipBytes);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
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
    if (topologySource.gzipSha256 !== sha256(inputGzipBytes)
      || topologySource.sqliteSha256 !== sha256(inputSqliteBytes)
      || topologySource.byteSize !== inputGzipBytes.length) {
      throw new Error("ITX topology input pack does not match the admitted current source");
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
