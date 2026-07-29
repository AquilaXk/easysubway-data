#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync, constants as zlibConstants } from "node:zlib";

import { addCadence } from "./freshness-policy.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const stationIds = ["station-sadang", "station-sangnoksu"];
const facilityTypes = ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT", "ACCESSIBILITY_STATUS_PROBE"];
const accessibilityRouteSourceId = "seoul-metro-accessibility";
const directRouteEvidenceSourceIds = new Set([
  "kric-station-elevator-movement",
  "kric-wheelchair-lift-movement",
]);
const replacedSourceIds = new Set([
  "kric-station-elevator",
  "kric-station-escalator",
  "kric-wheelchair-lift-location",
  "seoul-metro-accessibility",
]);

class StaleAccessibilityEvidenceError extends Error {}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function epoch(value) { return Math.floor(Date.parse(value) / 1000); }

function applyEvidence(sqlitePath, pack) {
  const database = new DatabaseSync(sqlitePath);
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    const placeholders = stationIds.map(() => "?").join(",");
    database.prepare(`DELETE FROM facilities WHERE station_id IN (${placeholders}) AND (type IN ('ELEVATOR','ESCALATOR','WHEELCHAIR_LIFT') OR source_id IN (${[...replacedSourceIds].map(() => "?").join(",")}))`).run(...stationIds, ...replacedSourceIds);
    const insertFacility = database.prepare(`
      INSERT INTO facilities (
        id, station_id, exit_id, type, name, status, floor_from, floor_to, description,
        source_id, source_snapshot_id, provider_facility_ref, provider_record_hash,
        provenance_kind, verified_at, retrieved_at, evidence_hash, status_meaning,
        operational_status, installation_status, confidence
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const row of pack.facilities) insertFacility.run(
      row.id, row.stationId, row.exitId, row.type, row.name, row.status, row.floorFrom, row.floorTo,
      row.description, row.sourceId, row.sourceSnapshotId, row.providerFacilityRef, row.providerRecordHash,
      row.provenanceKind, epoch(row.verifiedAt), epoch(row.retrievedAt), row.evidenceHash, row.statusMeaning,
      row.operationalStatus, row.installationStatus, row.confidence,
    );
    database.prepare(`
      DELETE FROM data_quality_records
      WHERE target_type = 'facility'
        AND NOT EXISTS (SELECT 1 FROM facilities WHERE facilities.id = data_quality_records.target_id)
    `).run();

    database.prepare(`DELETE FROM station_facility_evidence WHERE station_id IN (${placeholders}) AND facility_type IN (${facilityTypes.map(() => "?").join(",")})`).run(...stationIds, ...facilityTypes);
    const insertEvidence = database.prepare(`
      INSERT INTO station_facility_evidence (
        station_id, line_id, facility_type, evidence_kind, source_id, source_snapshot_id,
        provider_record_hash, evidence_hash, provenance_kind, installation_status,
        operational_status, status_meaning, confidence, verified_at, retrieved_at,
        strict_route_eligible, strict_route_eligible_reason
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const row of pack.stationFacilityEvidence) insertEvidence.run(
      row.stationId, row.lineId, row.facilityType, row.evidenceKind, row.sourceId,
      row.sourceSnapshotId, row.providerRecordHash, row.evidenceHash, row.provenanceKind,
      row.installationStatus, row.operationalStatus, row.statusMeaning, row.confidence,
      epoch(row.verifiedAt), epoch(row.retrievedAt), row.strictRouteEligible ? 1 : 0,
      row.strictRouteEligibleReason,
    );
    syncAccessibilityEdges(database, pack);
    normalizeUnprovenInternalRouteEdges(database, { check: false });
    normalizeUnprovenStationExitElevatorClaims(database, { check: false });

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function assertEvidence(sqlitePath, pack) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (database.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("bundled datapack integrity_check failed");
    const facilities = database.prepare(`
      SELECT id, station_id AS stationId, exit_id AS exitId, type, name, status,
        floor_from AS floorFrom, floor_to AS floorTo, description, source_id AS sourceId,
        source_snapshot_id AS sourceSnapshotId, provider_facility_ref AS providerFacilityRef,
        provider_record_hash AS providerRecordHash, provenance_kind AS provenanceKind,
        verified_at AS verifiedAt, retrieved_at AS retrievedAt, evidence_hash AS evidenceHash,
        status_meaning AS statusMeaning, operational_status AS operationalStatus,
        installation_status AS installationStatus, confidence
      FROM facilities
      WHERE station_id IN (?,?) AND type IN ('ELEVATOR','ESCALATOR','WHEELCHAIR_LIFT')
      ORDER BY id
    `).all(...stationIds).map((row) => ({ ...row }));
    const expectedFacilities = pack.facilities.map((row) => ({
      id: row.id,
      stationId: row.stationId,
      exitId: row.exitId ?? null,
      type: row.type,
      name: row.name,
      status: row.status,
      floorFrom: row.floorFrom,
      floorTo: row.floorTo,
      description: row.description,
      sourceId: row.sourceId,
      sourceSnapshotId: row.sourceSnapshotId,
      providerFacilityRef: row.providerFacilityRef,
      providerRecordHash: row.providerRecordHash,
      provenanceKind: row.provenanceKind,
      verifiedAt: epoch(row.verifiedAt),
      retrievedAt: epoch(row.retrievedAt),
      evidenceHash: row.evidenceHash,
      statusMeaning: row.statusMeaning,
      operationalStatus: row.operationalStatus,
      installationStatus: row.installationStatus,
      confidence: row.confidence,
    })).sort((left, right) => codepointCompare(left.id, right.id));
    if (JSON.stringify(facilities) !== JSON.stringify(expectedFacilities)) {
      throw new StaleAccessibilityEvidenceError("bundled accessibility facilities are stale");
    }
    const evidence = database.prepare(`
      SELECT station_id AS stationId, line_id AS lineId, facility_type AS facilityType,
        evidence_kind AS evidenceKind, source_id AS sourceId, source_snapshot_id AS sourceSnapshotId,
        provider_record_hash AS providerRecordHash, evidence_hash AS evidenceHash,
        provenance_kind AS provenanceKind, installation_status AS installationStatus,
        operational_status AS operationalStatus, status_meaning AS statusMeaning, confidence,
        verified_at AS verifiedAt, retrieved_at AS retrievedAt,
        strict_route_eligible AS strictRouteEligible,
        strict_route_eligible_reason AS strictRouteEligibleReason
      FROM station_facility_evidence
      WHERE station_id IN (?,?) AND facility_type IN (${facilityTypes.map(() => "?").join(",")})
      ORDER BY station_id, line_id, facility_type
    `).all(...stationIds, ...facilityTypes).map((row) => ({ ...row }));
    const expectedEvidence = pack.stationFacilityEvidence.map((row) => ({
      stationId: row.stationId,
      lineId: row.lineId,
      facilityType: row.facilityType,
      evidenceKind: row.evidenceKind,
      sourceId: row.sourceId,
      sourceSnapshotId: row.sourceSnapshotId,
      providerRecordHash: row.providerRecordHash,
      evidenceHash: row.evidenceHash,
      provenanceKind: row.provenanceKind,
      installationStatus: row.installationStatus,
      operationalStatus: row.operationalStatus,
      statusMeaning: row.statusMeaning,
      confidence: row.confidence,
      verifiedAt: epoch(row.verifiedAt),
      retrievedAt: epoch(row.retrievedAt),
      strictRouteEligible: row.strictRouteEligible ? 1 : 0,
      strictRouteEligibleReason: row.strictRouteEligibleReason,
    })).sort((left, right) => codepointCompare(
      `${left.stationId}:${left.lineId}:${left.facilityType}`,
      `${right.stationId}:${right.lineId}:${right.facilityType}`,
    ));
    if (JSON.stringify(evidence) !== JSON.stringify(expectedEvidence)) {
      throw new StaleAccessibilityEvidenceError("bundled accessibility facility evidence is stale");
    }
    const snapshotIds = [...new Set(pack.stationFacilityEvidence.map(({ sourceSnapshotId }) => sourceSnapshotId))];
    const stale = database.prepare(`SELECT count(*) AS count FROM station_facility_evidence WHERE station_id IN (?,?) AND source_snapshot_id NOT IN (${snapshotIds.map(() => "?").join(",")})`).get(...stationIds, ...snapshotIds).count;
    if (stale !== 0) throw new StaleAccessibilityEvidenceError("bundled accessibility source snapshot is stale");
    const staleFacility = database.prepare(`SELECT count(*) AS count FROM facilities WHERE station_id IN (?,?) AND source_id IN (${[...replacedSourceIds].map(() => "?").join(",")})`).get(...stationIds, ...replacedSourceIds).count;
    if (staleFacility !== 0) throw new StaleAccessibilityEvidenceError("bundled accessibility facility source is stale");
    const danglingQuality = database.prepare(`
      SELECT count(*) AS count
      FROM data_quality_records
      WHERE target_type = 'facility'
        AND NOT EXISTS (SELECT 1 FROM facilities WHERE facilities.id = data_quality_records.target_id)
    `).get().count;
    if (danglingQuality !== 0) {
      throw new StaleAccessibilityEvidenceError("bundled facility quality record is stale");
    }
    assertAccessibilityEdges(database, pack);
    normalizeUnprovenInternalRouteEdges(database, { check: true });
    normalizeUnprovenStationExitElevatorClaims(database, { check: true });
  } finally {
    database.close();
  }
}

export function applyEvidenceIfStale(sqlitePath, pack) {
  try {
    assertEvidence(sqlitePath, pack);
  } catch (error) {
    if (!(error instanceof StaleAccessibilityEvidenceError)) throw error;
    applyEvidence(sqlitePath, pack);
  }
}

export function syncCanonicalFixture(canonical, reviewedPack) {
  const pack = canonical.packs?.find(({ id }) => id === "capital");
  if (!pack) throw new Error("canonical capital pack is missing");
  const retainedFacilities = (pack.facilities ?? []).filter(({ stationId, type, sourceId }) => !stationIds.includes(stationId)
      || (!facilityTypes.includes(type)
        && !replacedSourceIds.has(sourceId)
        && sourceId !== "kric-station-convenience-standard"));
  pack.facilities = retainedFacilities.concat(reviewedPack.facilities);
  const facilityIds = new Set(pack.facilities.map(({ id }) => id));
  pack.dataQualityRecords = (pack.dataQualityRecords ?? []).filter(({ targetType, targetId }) =>
    targetType !== "facility" || facilityIds.has(targetId));
  pack.stationFacilityEvidence = (pack.stationFacilityEvidence ?? [])
    .filter(({ stationId, facilityType }) => !stationIds.includes(stationId) || !facilityTypes.includes(facilityType))
    .concat(reviewedPack.stationFacilityEvidence);
  pack.networkEdges = (pack.networkEdges ?? [])
    .filter((edge) => !isAccessibilityRouteEdge(edge))
    .concat(accessibilityRouteEdges(reviewedPack));
  pack.internalRouteEdges = (pack.internalRouteEdges ?? []).map((edge) =>
    edge.accessibilityStatus !== "UNKNOWN" && !completeInternalRouteEdgeProvenance(edge)
      ? { ...edge, accessibilityStatus: "UNKNOWN" }
      : edge);
  pack.stationExits = (pack.stationExits ?? []).map((exit) =>
    exit.hasElevatorConnection ? { ...exit, hasElevatorConnection: false } : exit);
  const freshSources = reviewedPack.sourceInventory.filter(({ id }) =>
    ["kric-station-convenience-standard", "seoul-metro-accessibility"].includes(id));
  pack.sourceInventory = pack.sourceInventory
    .filter(({ id }) => !replacedSourceIds.has(id) && id !== "kric-station-convenience-standard")
    .concat(freshSources);
  pack.metadata.productionCoverageEvidence = reviewedPack.metadata.productionCoverageEvidence;
  pack.minimumTableRows.facilities = pack.facilities.length;
  pack.minimumTableRows.station_facility_evidence = pack.stationFacilityEvidence.length;
  return canonical;
}

function isAccessibilityRouteEdge(edge) {
  return edge.sourceId === accessibilityRouteSourceId && ["ENTRY", "EXIT"].includes(edge.edgeType);
}

function accessibilityRouteEdges(pack) {
  return (pack.networkEdges ?? []).filter(isAccessibilityRouteEdge);
}

export function syncAccessibilityEdges(database, pack) {
  database.prepare("DELETE FROM network_edges WHERE source_id = ? AND edge_type IN ('ENTRY','EXIT')")
    .run(accessibilityRouteSourceId);
  const insert = database.prepare(`
    INSERT INTO network_edges (
      id, from_node_id, to_node_id, duration_seconds, distance_meters, edge_type,
      service_pattern, service_class, includes_stairs, stair_access_state,
      accessibility_status, reliability_score, source_id, source_snapshot_id,
      provider_record_hash, provenance_kind, verification_status, facility_id,
      last_verified_at, evidence_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const row of accessibilityRouteEdges(pack)) insert.run(
    row.id, row.fromNodeId, row.toNodeId, row.durationSeconds, row.distanceMeters,
    row.edgeType, row.servicePattern, row.serviceClass ?? "SUBWAY", row.includesStairs ? 1 : 0,
    row.stairAccessState, row.accessibilityStatus, row.reliabilityScore, row.sourceId,
    row.sourceSnapshotId, row.providerRecordHash, row.provenanceKind, row.verificationStatus,
    row.facilityId ?? null, epoch(row.lastVerifiedAt), row.evidenceHash,
  );
}

export function assertAccessibilityEdges(database, pack) {
  const actual = database.prepare(`
    SELECT id, from_node_id AS fromNodeId, to_node_id AS toNodeId,
      duration_seconds AS durationSeconds, distance_meters AS distanceMeters,
      edge_type AS edgeType, service_pattern AS servicePattern, service_class AS serviceClass,
      includes_stairs AS includesStairs, stair_access_state AS stairAccessState,
      accessibility_status AS accessibilityStatus, reliability_score AS reliabilityScore,
      source_id AS sourceId, source_snapshot_id AS sourceSnapshotId,
      provider_record_hash AS providerRecordHash, provenance_kind AS provenanceKind,
      verification_status AS verificationStatus, facility_id AS facilityId,
      last_verified_at AS lastVerifiedAt, evidence_hash AS evidenceHash
    FROM network_edges
    WHERE source_id = ? AND edge_type IN ('ENTRY','EXIT')
    ORDER BY id
  `).all(accessibilityRouteSourceId);
  const expected = accessibilityRouteEdges(pack).map((row) => ({
    id: row.id,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    durationSeconds: row.durationSeconds,
    distanceMeters: row.distanceMeters,
    edgeType: row.edgeType,
    servicePattern: row.servicePattern,
    serviceClass: row.serviceClass ?? "SUBWAY",
    includesStairs: row.includesStairs ? 1 : 0,
    stairAccessState: row.stairAccessState,
    accessibilityStatus: row.accessibilityStatus,
    reliabilityScore: row.reliabilityScore,
    sourceId: row.sourceId,
    sourceSnapshotId: row.sourceSnapshotId,
    providerRecordHash: row.providerRecordHash,
    provenanceKind: row.provenanceKind,
    verificationStatus: row.verificationStatus,
    facilityId: row.facilityId ?? null,
    lastVerifiedAt: epoch(row.lastVerifiedAt),
    evidenceHash: row.evidenceHash,
  })).sort((left, right) => codepointCompare(left.id, right.id));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new StaleAccessibilityEvidenceError("bundled accessibility edge is stale");
  }
}

function assertCanonicalFixture(canonical, reviewedPack) {
  const expected = syncCanonicalFixture(structuredClone(canonical), reviewedPack);
  if (JSON.stringify(expected) !== JSON.stringify(canonical)) {
    throw new Error("canonical accessibility fixture is stale");
  }
}

export function stripLegacyCoreClaims(database, { check }) {
  const facilityCount = database.prepare("SELECT count(*) AS count FROM facilities").get().count;
  const qualityCount = database.prepare(`
    SELECT count(*) AS count
    FROM data_quality_records
    WHERE target_type = 'facility'
  `).get().count;
  const pathwayColumns = new Set(
    database.prepare("PRAGMA table_info(station_pathway_edges)").all().map(({ name }) => name),
  );
  const outsideTransferColumns = new Set(
    database.prepare("PRAGMA table_info(out_of_station_transfer_links)").all().map(({ name }) => name),
  );
  const pathwayIncomplete = incompleteRouteProvenanceSql(pathwayColumns);
  const outsideTransferIncomplete = incompleteRouteProvenanceSql(outsideTransferColumns);
  const stalePathwayCount = pathwayColumns.has("requires_facility_id")
    ? database.prepare(`
        SELECT count(*) AS count FROM station_pathway_edges
        WHERE requires_facility_id IS NOT NULL
          OR (accessibility_status <> 'UNKNOWN' AND (${pathwayIncomplete}))
      `).get().count
    : 0;
  const staleOutsideTransferCount = outsideTransferColumns.has("accessibility_status")
    ? database.prepare(`
        SELECT count(*) AS count FROM out_of_station_transfer_links
        WHERE accessibility_status <> 'UNKNOWN' AND (${outsideTransferIncomplete})
      `).get().count
    : 0;
  const staleExit = normalizeUnprovenStationExitElevatorClaims(database, { check });
  const stale = facilityCount !== 0
    || qualityCount !== 0
    || stalePathwayCount !== 0
    || staleOutsideTransferCount !== 0
    || staleExit;
  if (check && stale) throw new Error("legacy core accessibility claims are stale");
  if (!check && stale) {
    const pathwayCleanup = pathwayColumns.has("requires_facility_id") ? `
      UPDATE station_pathway_edges
      SET accessibility_status = CASE
            WHEN requires_facility_id IS NOT NULL OR (${pathwayIncomplete}) THEN 'UNKNOWN'
            ELSE accessibility_status
          END,
          requires_facility_id = NULL;
    ` : "";
    const outsideTransferCleanup = outsideTransferColumns.has("accessibility_status") ? `
      UPDATE out_of_station_transfer_links
      SET accessibility_status = 'UNKNOWN'
      WHERE accessibility_status <> 'UNKNOWN' AND (${outsideTransferIncomplete});
    ` : "";
    database.exec(`
      ${pathwayCleanup}
      ${outsideTransferCleanup}
      DELETE FROM data_quality_records WHERE target_type = 'facility';
      DELETE FROM facilities;
      VACUUM;
    `);
  }
  return stale;
}

export function normalizeUnprovenStationExitElevatorClaims(database, { check }) {
  const columns = new Set(
    database.prepare("PRAGMA table_info(station_exits)").all().map(({ name }) => name),
  );
  if (!columns.has("has_elevator_connection")) return false;
  const incomplete = incompleteProvenanceSql(columns);
  const stale = database.prepare(`
    SELECT count(*) AS count FROM station_exits
    WHERE has_elevator_connection = 1 AND (${incomplete})
  `).get().count !== 0;
  if (check && stale) {
    throw new StaleAccessibilityEvidenceError("bundled station exit elevator claim is stale");
  }
  if (stale) database.exec(`
    UPDATE station_exits
    SET has_elevator_connection = 0
    WHERE has_elevator_connection = 1 AND (${incomplete});
  `);
  return stale;
}

function incompleteRouteProvenanceSql(columns) {
  const incomplete = incompleteProvenanceSql(columns);
  if (incomplete === "1") return incomplete;
  const allowedSources = [...directRouteEvidenceSourceIds].map((sourceId) => `'${sourceId}'`).join(",");
  return `(${incomplete}) OR source_id NOT IN (${allowedSources})`;
}

function incompleteProvenanceSql(columns) {
  if (!["source_id", "source_snapshot_id", "provider_record_hash", "evidence_hash"]
    .every((name) => columns.has(name))) return "1";
  return `COALESCE(source_id, '') = '' OR COALESCE(source_snapshot_id, '') = ''
    OR length(COALESCE(provider_record_hash, '')) <> 64
    OR COALESCE(provider_record_hash, '') GLOB '*[^0-9a-f]*'
    OR length(COALESCE(evidence_hash, '')) <> 64
    OR COALESCE(evidence_hash, '') GLOB '*[^0-9a-f]*'`;
}

export function normalizeUnprovenInternalRouteEdges(database, { check }) {
  const columns = new Set(database.prepare("PRAGMA table_info(internal_route_edges)").all().map(({ name }) => name));
  const hasProvenance = ["source_id", "source_snapshot_id", "provider_record_hash", "evidence_hash"]
    .every((name) => columns.has(name));
  const stale = database.prepare(hasProvenance ? `
      SELECT id, source_id AS sourceId, source_snapshot_id AS sourceSnapshotId,
             provider_record_hash AS providerRecordHash, evidence_hash AS evidenceHash
      FROM internal_route_edges
      WHERE accessibility_status <> 'UNKNOWN'
    ` : `
      SELECT id, '' AS sourceId, '' AS sourceSnapshotId, '' AS providerRecordHash, '' AS evidenceHash
      FROM internal_route_edges
      WHERE accessibility_status <> 'UNKNOWN'
    `).all().filter((row) => !completeInternalRouteEdgeProvenance(row));
  if (check && stale.length > 0) {
    throw new StaleAccessibilityEvidenceError("bundled internal route accessibility evidence is stale");
  }
  if (!check) {
    const update = database.prepare("UPDATE internal_route_edges SET accessibility_status = 'UNKNOWN' WHERE id = ?");
    for (const { id } of stale) update.run(id);
  }
  return stale.length > 0;
}

function completeInternalRouteEdgeProvenance(edge) {
  return directRouteEvidenceSourceIds.has(edge.sourceId)
    && Boolean(edge.sourceSnapshotId)
    && /^[0-9a-f]{64}$/.test(edge.providerRecordHash ?? "")
    && /^[0-9a-f]{64}$/.test(edge.evidenceHash ?? "");
}

async function stripLegacyCore({ check }) {
  const packPath = path.join(root, "apps/mobile/assets/datapacks/core.sqlite.gz");
  const indexPath = path.join(root, "apps/mobile/assets/datapacks/index.json");
  const directory = await mkdtemp(path.join(os.tmpdir(), `accessibility-core-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "core.sqlite");
    const currentGzipBytes = await readFile(packPath);
    await writeFile(sqlitePath, gunzipSync(currentGzipBytes));
    const database = new DatabaseSync(sqlitePath);
    let stale;
    try {
      const claimsStale = stripLegacyCoreClaims(database, { check });
      const edgeStale = normalizeUnprovenInternalRouteEdges(database, { check });
      stale = claimsStale || edgeStale;
    } finally {
      database.close();
    }
    if (!check && !stale) return;
    const sqliteBytes = await readFile(sqlitePath);
    if (check) {
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      const entry = index.packs.find(({ id }) => id === "core");
      if (!entry) throw new Error("core pack index entry is missing");
      if (entry.sha256 !== sha256(currentGzipBytes)
        || entry.sqliteSha256 !== sha256(sqliteBytes)
        || entry.byteSize !== currentGzipBytes.length) {
        throw new Error("core pack index identity is stale");
      }
      return;
    }
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    gzipBytes[9] = 255;
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const entry = index.packs.find(({ id }) => id === "core");
    if (!entry) throw new Error("core pack index entry is missing");
    Object.assign(entry, { sha256: sha256(gzipBytes), sqliteSha256: sha256(sqliteBytes), byteSize: gzipBytes.length });
    await Promise.all([
      writeFile(packPath, gzipBytes),
      writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function syncReleaseEvidence({ check }) {
  const paths = {
    spec: path.join(root, "tools/datapack/release/candidate-build-spec.json"),
    snapshots: path.join(root, "tools/datapack/release/source-snapshots.json"),
    inventory: path.join(root, "tools/datapack/source-inventory.json"),
    request: path.join(root, "tools/datapack/release/release-request.json"),
    hashes: path.join(root, "tools/datapack/release/hash-evidence.json"),
    canonical: path.join(root, "tools/datapack/release/capital-production-canonical-pack.json"),
    governance: path.join(root, "tools/datapack/source-governance-policy.json"),
    freshness: path.join(root, "apps/mobile/release/datapack-freshness-sla.json"),
  };
  const [specBytes, snapshotBytes, inventoryBytes, requestBytes, hashBytes, canonicalBytes, governanceBytes, freshnessBytes] = await Promise.all(
    Object.values(paths).map((file) => readFile(file)),
  );
  const spec = JSON.parse(specBytes);
  const snapshots = JSON.parse(snapshotBytes);
  const inventory = JSON.parse(inventoryBytes);
  const request = JSON.parse(requestBytes);
  const hashes = JSON.parse(hashBytes);
  const governance = JSON.parse(governanceBytes);
  const freshness = JSON.parse(freshnessBytes);
  const inventoryBySource = new Map(inventory.sources.map((entry) => [entry.id, entry]));
  const { headsBySource } = validateLineage(snapshots);
  const releaseSnapshots = snapshots.filter((snapshot) => headsBySource[snapshot.sourceId] === snapshot.snapshotId);
  spec.sourceSnapshotIds = releaseSnapshots.map(({ snapshotId }) => snapshotId);
  spec.sourceSnapshots = releaseSnapshots.map((snapshot) => {
    const source = inventoryBySource.get(snapshot.sourceId);
    const adminReviewRecordHash = source?.admissionEvidence?.adminReviewRecordHash;
    if (!/^[0-9a-f]{64}$/.test(adminReviewRecordHash ?? "")) throw new Error(`admin review hash missing: ${snapshot.sourceId}`);
    const sourceClass = freshness.sourceClasses.find(({ sourceIds }) => sourceIds.includes(snapshot.sourceId));
    if (!sourceClass) throw new Error(`freshness class missing: ${snapshot.sourceId}`);
    const basisAt = snapshot[sourceClass.basisField];
    let freshnessExpiresAt = addCadence(
      Date.parse(basisAt),
      sourceClass.reverificationCadence ?? sourceClass.maximumReverificationCadence,
    );
    if (sourceClass.providerValidityEndField) {
      freshnessExpiresAt = Math.min(freshnessExpiresAt, Date.parse(snapshot[sourceClass.providerValidityEndField]));
    }
    return {
      snapshotId: snapshot.snapshotId,
      sourceId: snapshot.sourceId,
      rawObjectUri: snapshot.rawObjectUri,
      rawSha256: snapshot.rawSha256,
      redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
      schemaFingerprint: snapshot.schemaFingerprint,
      licenseStatus: snapshot.licenseStatus,
      redistributionAllowed: snapshot.redistributionAllowed,
      adminReviewRecordHash,
      snapshotStatus: snapshot.snapshotStatus,
      credentialRedacted: snapshot.credentialRedacted,
      freshnessExpiresAt: new Date(freshnessExpiresAt).toISOString(),
      rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
        policy: governance,
        sourceId: snapshot.sourceId,
        retrievedAt: snapshot.retrievedAt,
      }),
      governancePolicyVersion: governance.policyVersion,
      governancePolicySha256: sha256(governanceBytes),
    };
  });
  spec.sourceSnapshotSetHash = sha256(JSON.stringify(releaseSnapshots));
  spec.sourceInventorySha256 = sha256(JSON.stringify(inventory));
  spec.itxTopologyEvidenceSha256 = sha256(await readFile(path.resolve(root, spec.itxTopologyEvidencePath)));
  spec.networkEdgeEvidence.sourceInventory.sha256 = sha256(inventoryBytes);
  const nextSpecBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
  request.buildSpecSha256 = sha256(nextSpecBytes);
  request.sourceSnapshotSetHash = spec.sourceSnapshotSetHash;
  hashes.truthfulnessRule = "모든 값은 tracked canonical fixture·inventory·official snapshot에서 결정적으로 재산출한다. 2026-07-28 신규 KRIC standard·서울 snapshot을 소비 claim에 결속하고 route 가용성은 추론하지 않는다.";
  hashes.sourceSnapshotSetHash.value = spec.sourceSnapshotSetHash;
  hashes.sourceSnapshotSetHash.contract = `source별 head ${releaseSnapshots.length}종의 byte-ordered JSON hash와 build spec·release request가 일치해야 한다.`;
  hashes.sourceSnapshotSetHash.reproductionCommand = "node -e \"import('./tools/datapack/source-snapshot-policy.mjs').then(({validateLineage})=>{const c=require('crypto'),s=require('./tools/datapack/release/source-snapshots.json'),h=validateLineage(s).headsBySource,r=s.filter(n=>h[n.sourceId]===n.snapshotId);console.log(c.createHash('sha256').update(JSON.stringify(r)).digest('hex'))})\"";
  hashes.sourceInventorySha256.value = spec.sourceInventorySha256;
  hashes.fixturePath.sha256 = sha256(canonicalBytes);
  hashes.sourceSnapshots.note = "기존 release source 중 movement·timetable·network identity는 유지하고, detailed location 3종을 KRIC stationCnvFacl standard로 교체했다. 서울 accessibility는 2026-07-28 full snapshot으로 교체했다.";
  hashes.sourceSnapshots.order = `release snapshot 순서: ${releaseSnapshots.map(({ sourceId }) => sourceId).join(" → ")}`;
  hashes.sourceSnapshots.committedVerificationCommand = "node -e \"import('./tools/datapack/source-snapshot-policy.mjs').then(({validateLineage})=>{const c=require('crypto'),s=require('./tools/datapack/release/source-snapshots.json'),h=validateLineage(s).headsBySource,e=require('./tools/datapack/release/hash-evidence.json');for(const n of s.filter(x=>h[x.sourceId]===x.snapshotId)){const p=e.perSourceEvidence.find(x=>x.snapshotId===n.snapshotId);if(!p||c.createHash('sha256').update(JSON.stringify([n])).digest('hex')!==p.perSourceSnapshotSetHash)throw new Error('source snapshot evidence mismatch: '+n.sourceId)}})\"";
  hashes.perSourceEvidence = releaseSnapshots.map((snapshot) => ({
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    rawSha256: snapshot.rawSha256,
    adminReviewRecordHash: inventoryBySource.get(snapshot.sourceId).admissionEvidence.adminReviewRecordHash,
    perSourceSnapshotSetHash: sha256(JSON.stringify([snapshot])),
  }));
  const nextRequestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
  const nextHashBytes = Buffer.from(`${JSON.stringify(hashes, null, 2)}\n`);
  if (check) {
    for (const [label, actual, expected] of [
      ["candidate build spec", specBytes, nextSpecBytes],
      ["release request", requestBytes, nextRequestBytes],
      ["hash evidence", hashBytes, nextHashBytes],
    ]) if (!actual.equals(expected)) throw new Error(`${label} is stale`);
    return { spec, inventory };
  }
  await Promise.all([
    writeFile(paths.spec, nextSpecBytes),
    writeFile(paths.request, nextRequestBytes),
    writeFile(paths.hashes, nextHashBytes),
  ]);
  return { spec, inventory };
}

export function accessibilityIndexMetadata(pack, spec, inventory, currentFreshnessExpiresAt) {
  const evidenceBySource = new Map(inventory.sources.map((source) => [source.id, source.accessibilityAdmissionEvidence]));
  const snapshotBySource = new Map(spec.sourceSnapshots.map((snapshot) => [snapshot.sourceId, snapshot]));
  const consumed = new Map();
  for (const { sourceId, sourceSnapshotId } of [
    ...pack.facilities,
    ...pack.stationFacilityEvidence,
    ...accessibilityRouteEdges(pack),
  ]) {
    if (consumed.has(sourceId) && consumed.get(sourceId) !== sourceSnapshotId) {
      throw new Error(`accessibility snapshot mismatch: ${sourceId}`);
    }
    consumed.set(sourceId, sourceSnapshotId);
  }
  const accessibilityFreshnessExpiresAt = [...consumed].map(([sourceId, snapshotId]) => {
    const evidence = evidenceBySource.get(sourceId);
    if (evidence?.snapshotId !== snapshotId
      || !Number.isFinite(Date.parse(evidence.observedAt))
      || !Number.isFinite(Date.parse(evidence.freshUntil))) {
      throw new Error(`accessibility admission evidence missing: ${sourceId}`);
    }
    const snapshot = snapshotBySource.get(sourceId);
    if (snapshot?.snapshotId !== snapshotId) throw new Error(`accessibility snapshot mismatch: ${sourceId}`);
    if (!Number.isFinite(Date.parse(snapshot.freshnessExpiresAt))) {
      throw new Error(`accessibility snapshot freshness missing: ${sourceId}`);
    }
    return snapshot.freshnessExpiresAt;
  }).sort((left, right) => Date.parse(left) - Date.parse(right)).at(0);
  const qualityAsOf = [...consumed.keys()].map((sourceId) => evidenceBySource.get(sourceId).observedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
  const currentFreshnessMillis = Date.parse(currentFreshnessExpiresAt);
  const accessibilityFreshnessMillis = Date.parse(accessibilityFreshnessExpiresAt);
  if (!Number.isFinite(currentFreshnessMillis)) throw new Error("bundled pack freshness missing");
  if (!Number.isFinite(accessibilityFreshnessMillis)) throw new Error("accessibility snapshot freshness missing");
  return {
    builtAt: candidateBuildNow().toISOString(),
    qualityAsOf,
    // ponytail: accessibility refresh may tighten, never extend another domain's pack expiry; the identity test owns extension.
    freshnessExpiresAt: new Date(Math.min(currentFreshnessMillis, accessibilityFreshnessMillis)).toISOString(),
    sourceSnapshotSetHash: spec.sourceSnapshotSetHash,
  };
}

async function main() {
  if (process.argv.includes("--core-only")) {
    await stripLegacyCore({ check: process.argv.includes("--check") });
    return;
  }
  if (process.argv.includes("--release-evidence-only")) {
    await syncReleaseEvidence({ check: process.argv.includes("--check") });
    return;
  }
  const packPath = path.resolve(root, option("--pack", "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  const indexPath = path.resolve(root, option("--index", "apps/mobile/assets/datapacks/index.json"));
  const fixturePath = path.resolve(root, option("--fixture", "tools/datapack/release/capital-production-reviewed-pack.json"));
  const canonicalPath = path.resolve(root, option("--canonical-fixture", "tools/datapack/release/capital-production-canonical-pack.json"));
  const pack = JSON.parse(await readFile(fixturePath, "utf8")).packs?.find(({ id }) => id === "capital");
  if (!pack || pack.facilities?.length !== 4 || pack.stationFacilityEvidence?.length !== 8) {
    throw new Error("reviewed capital accessibility evidence must contain 4 facilities and 8 evidence rows");
  }
  const canonical = JSON.parse(await readFile(canonicalPath, "utf8"));
  if (process.argv.includes("--check")) assertCanonicalFixture(canonical, pack);
  else await writeFile(canonicalPath, `${JSON.stringify(syncCanonicalFixture(canonical, pack))}\n`);
  const releaseEvidence = await syncReleaseEvidence({ check: process.argv.includes("--check") });
  const directory = await mkdtemp(path.join(os.tmpdir(), `accessibility-pack-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    const currentGzipBytes = await readFile(packPath);
    await writeFile(sqlitePath, gunzipSync(currentGzipBytes));
    if (process.argv.includes("--check")) {
      assertEvidence(sqlitePath, pack);
      const sqliteBytes = await readFile(sqlitePath);
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      const entry = index.packs.find(({ id }) => id === "capital");
      if (!entry || entry.sha256 !== sha256(currentGzipBytes) || entry.sqliteSha256 !== sha256(sqliteBytes) || entry.byteSize !== currentGzipBytes.length) {
        throw new Error("bundled accessibility pack index is stale");
      }
      const metadata = accessibilityIndexMetadata(
        pack,
        releaseEvidence.spec,
        releaseEvidence.inventory,
        index.freshnessExpiresAt,
      );
      if (index.qualityAsOf !== metadata.qualityAsOf
        || index.freshnessExpiresAt !== metadata.freshnessExpiresAt
        || index.sourceSnapshotSetHash !== metadata.sourceSnapshotSetHash
        || Date.parse(index.builtAt) < Date.parse(metadata.qualityAsOf)) {
        throw new Error("bundled accessibility pack metadata is stale");
      }
      return;
    }
    applyEvidenceIfStale(sqlitePath, pack);
    assertEvidence(sqlitePath, pack);
    const sqliteBytes = await readFile(sqlitePath);
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0, strategy: zlibConstants.Z_RLE });
    gzipBytes[9] = 255;
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const entry = index.packs.find(({ id }) => id === "capital");
    if (!entry) throw new Error("capital pack index entry is missing");
    Object.assign(entry, { sha256: sha256(gzipBytes), sqliteSha256: sha256(sqliteBytes), byteSize: gzipBytes.length });
    Object.assign(index, accessibilityIndexMetadata(
      pack,
      releaseEvidence.spec,
      releaseEvidence.inventory,
      index.freshnessExpiresAt,
    ));
    await writeFile(packPath, gzipBytes);
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function candidateBuildNow() {
  const value = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  const date = value ? new Date(value) : new Date();
  if ((value && !value.endsWith("Z")) || !Number.isFinite(date.getTime())) {
    throw new Error("EASYSUBWAY_DATAPACK_BUILD_NOW must be UTC ISO-8601");
  }
  return date;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
