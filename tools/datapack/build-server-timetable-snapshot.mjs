#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { buildBackendTimetableSeed } from "./build-backend-timetable-seed.mjs";
import { approvedLegacyGovernanceBinding } from "./legacy-source-governance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT_KIND = "server-timetable-snapshot-evidence";
const SCHEMA_IDENTITY = "backend-timetable-snapshot-v1";
const ITX_SERVICE_ID_BY_SOURCE = {
  "weekday-kric": "itx-cheongchun-weekday-kric",
  "saturday-kric": "itx-cheongchun-saturday-kric",
  "holiday-kric": "itx-cheongchun-holiday-kric",
};
const ITX_SERVICE_CALENDAR_DAY_MAP = {
  "itx-cheongchun-weekday-kric": {
    monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false,
  },
  "itx-cheongchun-saturday-kric": {
    monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: false,
  },
  "itx-cheongchun-holiday-kric": {
    monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: true,
  },
};

export function buildServerTimetableSnapshot({
  baselineGzipBytes,
  contractBytes,
  sourceBytes,
  completenessBytes,
  canonicalPackGzipBytes,
  topologyEvidenceBytes,
  subwayRosterBytes,
  reviewedPackBytes,
  sourceSnapshotsBytes,
  canonicalGzipBytes,
  buildNow = new Date(),
}) {
  const rawBaselineSql = normalizeBaselineSql(baselineGzipBytes);
  const contract = parseJson(contractBytes, "coverage contract");
  const source = parseJson(sourceBytes, "source artifact");
  const completeness = parseJson(completenessBytes, "completeness evidence");
  const topologyEvidence = topologyEvidenceBytes == null
    ? null
    : parseJson(topologyEvidenceBytes, "topology evidence");
  const subwayRoster = parseJson(subwayRosterBytes, "subway roster");
  const admittedCanonicalPackIdentity = validateAdmission({
    contract,
    source,
    sourceBytes,
    completeness,
    completenessBytes,
    buildNow,
  });
  // 순수 freshness 리프레시(topology 불변)는 apply-itx가 산출하는 topology evidence 없이
  // 이미 admit된 pack identity를 재사용한다. topology가 실제로 바뀌는 리프레시는 기존 경로.
  const { canonicalPackIdentity, canonicalPackLineage } = topologyEvidenceBytes == null
    ? admittedCanonicalPack({ canonicalPackGzipBytes, admittedCanonicalPackIdentity })
    : validateCanonicalTopologyPack({
      contract,
      source,
      sourceBytes,
      topologyEvidence,
      topologyEvidenceBytes,
      canonicalPackGzipBytes,
      admittedCanonicalPackIdentity,
    });
  const baselineSql = normalizeSubwayStationIds(
    rawBaselineSql,
    canonicalPackGzipBytes,
    subwayRoster,
  );
  const existingCalendarIds = insertedIds(baselineSql, "service_calendars");
  const sortedTrips = [...source.transitTrips]
    .map((trip) => ({
      ...trip,
      serviceId: namespacedItxServiceId(trip.serviceId),
      serviceClass: "ITX_CHEONGCHUN",
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sortedStopTimes = [...source.transitStopTimes]
    .sort((left, right) => left.tripId.localeCompare(right.tripId)
      || left.stopSequence - right.stopSequence);
  const routeServiceArtifactEvidence = [{
    serviceClass: "ITX_CHEONGCHUN",
    timetableArtifactId: source.artifactId,
    timetableArtifactSha256: sha256(sourceBytes),
    canonicalPackId: canonicalPackIdentity.id,
    canonicalPackSha256: canonicalPackIdentity.sha256,
    canonicalPackSqliteSha256: canonicalPackIdentity.sqliteSha256,
    admissionStatus: "ADMITTED",
    admissionEligible: true,
    freshUntil: source.freshUntil,
    sourceIssue: 2135,
  }];
  const itxSeed = buildBackendTimetableSeed({
    ...source,
    transitTrips: sortedTrips,
    transitStopTimes: sortedStopTimes,
    routeServiceArtifactEvidence,
  }, {
    includeFeedInfo: false,
    excludeServiceCalendarIds: existingCalendarIds,
    serviceCalendarDayMap: ITX_SERVICE_CALENDAR_DAY_MAP,
    startDate: earliestServiceDate(source.selectedServiceDates),
    endDate: latestServiceDate(source.selectedServiceDates),
    buildNow,
    timetableArtifactSha256: sha256(sourceBytes),
    canonicalPackIdentity,
  });
  assertNoIdentityCollisions(baselineSql, itxSeed);
  const plannerIdentity = plannerIdentitySql(source, completeness);
  const subwayTrainIdentity = subwayTrainIdentitySql(baselineSql);
  const subwayFares = officialSubwayFareSql(canonicalPackGzipBytes, baselineSql);
  const accessibility = canonicalAccessibilitySql(reviewedPackBytes, sourceSnapshotsBytes, canonicalPackIdentity);
  const sql = `${baselineSql}${itxSeed.sql}${plannerIdentity.sql}${subwayTrainIdentity}${subwayFares.sql}${accessibility.sql}`;
  const sqlBytes = Buffer.from(sql);
  const gzipBytes = canonicalGzipBytes ?? gzipSync(sqlBytes, { level: 9, mtime: 0 });
  if (canonicalGzipBytes != null) {
    let canonicalSqlBytes;
    try {
      canonicalSqlBytes = gunzipSync(canonicalGzipBytes);
    } catch {
      throw new Error("canonical gzip transport does not match normalized SQL");
    }
    if (!canonicalSqlBytes.equals(sqlBytes)) {
      throw new Error("canonical gzip transport does not match normalized SQL");
    }
  }
  const snapshotSha256 = sha256(sqlBytes);
  const canonicalStationIds = canonicalStationSet(source);
  const canonicalStationSetHash = sha256(Buffer.from(JSON.stringify(canonicalStationIds)));
  const baselineCounts = statementCounts(baselineSql);
  const servicePatternEvidence = representativeServicePatternEvidence(baselineSql, source);
  const evidenceWithoutHash = {
    schemaVersion: 1,
    artifactKind: ARTIFACT_KIND,
    schemaIdentity: SCHEMA_IDENTITY,
    snapshotId: `server-timetable-snapshot-${snapshotSha256.slice(0, 16)}`,
    snapshotSha256,
    snapshotSqlByteSize: sqlBytes.length,
    snapshotGzipSha256: sha256(gzipBytes),
    snapshotGzipByteSize: gzipBytes.length,
    freshUntil: source.freshUntil,
    serviceIdentity: {
      serviceId: contract.serviceId,
      canonicalLineId: contract.canonicalLineId,
      servicePattern: contract.servicePattern,
      timezone: contract.timezone,
    },
    sourceArtifact: {
      id: source.artifactId,
      sha256: sha256(sourceBytes),
      completenessEvidenceSha256: sha256(completenessBytes),
    },
    canonicalPackIdentity,
    canonicalPackLineage,
    accessibilitySource: accessibility.source,
    canonicalStationSet: {
      version: `sha256:${canonicalStationSetHash}`,
      sha256: canonicalStationSetHash,
      memberCount: canonicalStationIds.length,
    },
    sourceLineageSha256: sha256(Buffer.from(JSON.stringify(
      [...source.sourceLineage].sort((left, right) => left.dayCd.localeCompare(right.dayCd)),
    ))),
    servicePatternEvidence,
    rowCounts: {
      calendars: baselineCounts.calendars + itxSeed.calendars.length,
      routes: baselineCounts.routes + itxSeed.routes.length,
      trips: baselineCounts.trips + itxSeed.tripCount,
      stopTimes: baselineCounts.stopTimes + itxSeed.stopTimeCount,
      subwayTrips: baselineCounts.trips,
      subwayStopTimes: baselineCounts.stopTimes,
      itxTrips: itxSeed.tripCount,
      itxStopTimes: itxSeed.stopTimeCount,
      officialFares: plannerIdentity.fareCount + subwayFares.fareCount,
      routeServiceEvidence: 1,
      stationPathwayNodes: accessibility.nodeCount,
      stationPathwayEdges: accessibility.edgeCount,
      transferRules: accessibility.transferRuleCount,
      routeEdgeEvidence: accessibility.evidenceCount,
    },
  };
  const evidence = {
    ...evidenceWithoutHash,
    evidenceHash: sha256(Buffer.from(JSON.stringify(evidenceWithoutHash))),
  };
  return {
    sql,
    gzipBytes,
    evidence,
    evidenceBytes: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
  };
}

function canonicalAccessibilitySql(reviewedPackBytes, sourceSnapshotsBytes, canonicalPackIdentity) {
  const fixture = parseJson(reviewedPackBytes, "reviewed production pack");
  const sourceSnapshots = parseJson(sourceSnapshotsBytes, "source snapshots");
  const pack = fixture?.packs?.find(({ id }) => id === canonicalPackIdentity.id);
  if (!pack || !Array.isArray(pack.networkEdges) || !Array.isArray(sourceSnapshots)) {
    throw new Error("canonical accessibility source is invalid");
  }
  const edges = pack.networkEdges
    .filter(({ edgeType }) => edgeType === "ENTRY" || edgeType === "EXIT")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (edges.length === 0) throw new Error("canonical accessibility source has no entry or exit edges");
  const snapshotsById = new Map(sourceSnapshots.map((row) => [row.snapshotId, row]));
  const nodes = new Map();
  const usedSnapshots = new Map();
  for (const edge of edges) {
    if (typeof edge.includesStairs !== "boolean") {
      throw new Error(`canonical accessibility edge includesStairs is invalid: ${edge.id}`);
    }
    const endpoint = accessEdgeEndpoint(edge);
    addAccessNode(nodes, endpoint.stationId, null, edge.edgeType === "ENTRY" ? edge.fromNodeId : edge.toNodeId);
    addAccessNode(nodes, endpoint.stationId, endpoint.lineId, edge.edgeType === "ENTRY" ? edge.toNodeId : edge.fromNodeId);
    const snapshot = snapshotsById.get(edge.sourceSnapshotId);
    if (!snapshot || snapshot.sourceId !== edge.sourceId) {
      throw new Error(`canonical accessibility source snapshot is missing: ${edge.id}`);
    }
    addSourceSnapshotLineage(snapshot, snapshotsById, usedSnapshots, new Set());
  }
  const snapshotStatements = [...usedSnapshots.values()]
    .map(sourceSnapshotInsert);
  const nodeStatements = [...nodes.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(accessNodeInsert);
  const edgeStatements = edges.map(accessEdgeInsert);
  const evidenceStatements = edges.map((edge) => routeEdgeEvidenceInsert(edge, accessEdgeEndpoint(edge)));
  const sql = `${[...snapshotStatements, ...nodeStatements, ...edgeStatements, ...evidenceStatements].join("\n")}\n`;
  return {
    sql,
    source: {
      materializedSqlSha256: sha256(Buffer.from(sql)),
    },
    nodeCount: nodes.size,
    edgeCount: edges.length,
    transferRuleCount: 0,
    evidenceCount: evidenceStatements.length,
  };
}

function addSourceSnapshotLineage(snapshot, snapshotsById, usedSnapshots, visiting) {
  if (usedSnapshots.has(snapshot.snapshotId)) return;
  if (visiting.has(snapshot.snapshotId)) throw new Error("canonical accessibility source snapshot lineage cycles");
  visiting.add(snapshot.snapshotId);
  if (snapshot.previousSnapshotId != null) {
    const previous = snapshotsById.get(snapshot.previousSnapshotId);
    if (!previous || previous.sourceId !== snapshot.sourceId) {
      throw new Error(`canonical accessibility source snapshot ancestor is missing: ${snapshot.snapshotId}`);
    }
    addSourceSnapshotLineage(previous, snapshotsById, usedSnapshots, visiting);
  }
  visiting.delete(snapshot.snapshotId);
  usedSnapshots.set(snapshot.snapshotId, snapshot);
}

function accessEdgeEndpoint(edge) {
  const platformNodeId = edge.edgeType === "ENTRY" ? edge.toNodeId : edge.fromNodeId;
  const stationNodeId = edge.edgeType === "ENTRY" ? edge.fromNodeId : edge.toNodeId;
  if (typeof platformNodeId !== "string" || typeof stationNodeId !== "string") {
    throw new Error(`canonical accessibility edge endpoints are invalid: ${edge.id}`);
  }
  const separator = platformNodeId.lastIndexOf(":");
  const stationId = platformNodeId.slice(0, separator);
  const lineId = platformNodeId.slice(separator + 1);
  if (separator < 1 || stationNodeId !== stationId || !lineId) {
    throw new Error(`canonical accessibility edge endpoints are invalid: ${edge.id}`);
  }
  return { stationId, lineId };
}

function addAccessNode(nodes, stationId, lineId, id) {
  const node = { id, stationId, lineId, nodeType: lineId == null ? "CONCOURSE" : "PLATFORM" };
  const existing = nodes.get(id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(node)) {
    throw new Error(`canonical accessibility node identity collision: ${id}`);
  }
  nodes.set(id, node);
}

function sourceSnapshotInsert(row) {
  if (typeof row.redistributionAllowed !== "boolean" || typeof row.credentialRedacted !== "boolean") {
    throw new Error(`canonical accessibility source snapshot policy boolean is invalid: ${row.snapshotId}`);
  }
  const rowCount = sqlInteger(row.rowCount, "snapshot rowCount");
  const coverageCount = sourceSnapshotCoverageCount(row, rowCount);
  const legacyGovernance = approvedLegacyGovernanceBinding(row);
  const diffSummary = row.diffSummary == null
    ? null
    : (typeof row.diffSummary === "string" ? row.diffSummary : row.diffSummary.status);
  const values = [
    sqlText(row.snapshotId, "snapshot id"), sqlText(row.sourceId, "snapshot source id"),
    sqlText(row.provider, "snapshot provider"), sqlTimestamp(row.retrievedAt, "snapshot retrievedAt"),
    sqlNullableTimestamp(row.sourceUpdatedAt, "snapshot sourceUpdatedAt"),
    sqlNullableTimestamp(row.freshnessBasisAt, "snapshot freshnessBasisAt"),
    sqlNullableTimestamp(row.providerValidUntil, "snapshot providerValidUntil"),
    rowCount, coverageCount,
    sqlText(row.rawSha256, "snapshot rawSha256"), sqlText(row.rawObjectUri, "snapshot rawObjectUri"),
    sqlText(row.redactedRequestFingerprint, "snapshot request fingerprint"),
    sqlText(row.schemaFingerprint, "snapshot schema fingerprint"), sqlText(row.snapshotStatus, "snapshot status"),
    sqlText(row.schemaStatus, "snapshot schema status"), sqlText(row.licenseStatus, "snapshot license status"),
    sqlText(row.fetchStatus, "snapshot fetch status"), row.redistributionAllowed ? "TRUE" : "FALSE",
    row.credentialRedacted ? "TRUE" : "FALSE",
    sqlNullableText(row.previousSnapshotId, "snapshot previous id"),
    sqlNullableText(diffSummary, "snapshot diff summary"),
    row.diffSummary == null ? "NULL" : sqlText(JSON.stringify(row.diffSummary), "snapshot diff summary JSON"),
    sqlTimestamp(row.freshnessExpiresAt, "snapshot freshnessExpiresAt"),
    sqlTimestamp(row.rawRetentionExpiresAt, "snapshot rawRetentionExpiresAt"),
    sqlNullableText(row.governancePolicyVersion ?? legacyGovernance?.governancePolicyVersion,
      "snapshot governance policy version"),
    sqlNullableText(row.governancePolicySha256 ?? legacyGovernance?.governancePolicySha256,
      "snapshot governance policy hash"),
  ];
  const columns = [
    "snapshot_id", "source_id", "provider", "retrieved_at", "source_updated_at", "freshness_basis_at",
    "provider_valid_until", "row_count", "coverage_count", "raw_sha256", "raw_object_uri",
    "redacted_request_fingerprint", "schema_fingerprint", "snapshot_status", "schema_status",
    "license_status", "fetch_status", "redistribution_allowed", "credential_redacted", "previous_snapshot_id",
    "diff_summary", "diff_summary_json", "freshness_expires_at", "raw_retention_expires_at",
    "governance_policy_version", "governance_policy_sha256",
  ];
  const exactIdentity = columns
    .map((column, index) => `${column} IS NOT DISTINCT FROM ${values[index]}`)
    .join(" AND ");
  return `INSERT INTO data_source_snapshots (${columns.join(", ")}) `
    + `SELECT ${values.join(", ")} WHERE NOT EXISTS (SELECT 1 FROM data_source_snapshots WHERE ${exactIdentity});`;
}

function sourceSnapshotCoverageCount(row, rowCount) {
  if (Number.isInteger(row.coverageCount) && row.coverageCount >= 0) return row.coverageCount;
  if (row.previousSnapshotId == null && row.diffSummary == null
    && approvedLegacyGovernanceBinding(row) != null) return rowCount;
  throw new Error(`canonical accessibility source snapshot coverage is missing: ${row.snapshotId}`);
}

function accessNodeInsert(node) {
  return "INSERT INTO station_pathway_nodes (id, station_id, line_id, node_type, label) VALUES ("
    + `${sqlText(node.id, "pathway node id")}, ${sqlText(node.stationId, "pathway station id")}, `
    + `${node.lineId == null ? "NULL" : sqlText(node.lineId, "pathway line id")}, `
    + `${sqlText(node.nodeType, "pathway node type")}, ${sqlText(node.id, "pathway node label")});`;
}

function accessEdgeInsert(edge) {
  return "INSERT INTO station_pathway_edges (id, from_node_id, to_node_id, edge_type, duration_seconds, distance_meters, bidirectional, includes_stairs, reliability_score, accessibility_status, source_id, source_snapshot_id, provider_record_hash, provenance_kind, verification_status, last_verified_at, evidence_hash, instruction, legacy_internal_route_edge_id) VALUES ("
    + `${sqlText(edge.id, "pathway edge id")}, ${sqlText(edge.fromNodeId, "pathway from node")}, `
    + `${sqlText(edge.toNodeId, "pathway to node")}, ${sqlText(edge.edgeType, "pathway edge type")}, `
    + `${sqlInteger(edge.durationSeconds, "pathway duration")}, `
    + `${sqlInteger(edge.distanceMeters, "pathway distance")}, FALSE, ${edge.includesStairs ? "TRUE" : "FALSE"}, `
    + `${sqlInteger(edge.reliabilityScore, "pathway reliability", 100)}, `
    + `${sqlText(edge.accessibilityStatus, "pathway accessibility status")}, `
    + `${sqlText(edge.sourceId, "pathway source id")}, ${sqlText(edge.sourceSnapshotId, "pathway source snapshot id")}, `
    + `${sqlText(edge.providerRecordHash, "pathway provider hash")}, ${sqlText(edge.provenanceKind, "pathway provenance")}, `
    + `${sqlText(edge.verificationStatus, "pathway verification")}, ${sqlTimestamp(edge.lastVerifiedAt, "pathway verifiedAt")}, `
    + `${sqlText(edge.evidenceHash, "pathway evidence hash")}, '', ${sqlText(edge.id, "legacy pathway edge id")});`;
}

function routeEdgeEvidenceInsert(edge, endpoint) {
  const strictEligible = edge.accessibilityStatus === "AVAILABLE"
    && edge.verificationStatus === "VERIFIED"
    && ["OFFICIAL_SOURCE", "OPERATOR_CONFIRMED", "FIELD_VERIFIED"].includes(edge.provenanceKind)
    && edge.includesStairs === false;
  return "INSERT INTO route_edge_evidence (id, station_id, line_id, edge_id, edge_type, source_id, source_snapshot_id, provenance_kind, verification_status, last_verified_at, evidence_hash, strict_route_eligible, blocker_reason, created_at) VALUES ("
    + `${sqlText(`route-evidence-${edge.id}`, "route evidence id")}, ${sqlText(endpoint.stationId, "route evidence station")}, `
    + `${sqlText(endpoint.lineId, "route evidence line")}, ${sqlText(edge.id, "route evidence edge")}, `
    + `${sqlText(edge.edgeType, "route evidence type")}, ${sqlText(edge.sourceId, "route evidence source")}, `
    + `${sqlText(edge.sourceSnapshotId, "route evidence snapshot")}, ${sqlText(edge.provenanceKind, "route evidence provenance")}, `
    + `${sqlText(edge.verificationStatus, "route evidence verification")}, ${sqlTimestamp(edge.lastVerifiedAt, "route evidence verifiedAt")}, `
    + `${sqlText(edge.evidenceHash, "route evidence hash")}, ${strictEligible ? "TRUE" : "FALSE"}, `
    + `${strictEligible ? "NULL" : sqlText(edge.accessibilityStatus, "route evidence blocker")}, `
    + `${sqlTimestamp(edge.lastVerifiedAt, "route evidence createdAt")});`;
}

function sqlTimestamp(value, label) {
  const date = new Date(requiredText(value, label));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return `'${date.toISOString().slice(0, 19).replace("T", " ")}'`;
}

function sqlInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sqlNullableTimestamp(value, label) {
  return value == null ? "NULL" : sqlTimestamp(value, label);
}

function sqlNullableText(value, label) {
  return value == null ? "NULL" : sqlText(value, label);
}

function plannerIdentitySql(source, completeness) {
  const tripByServiceDayAndTrain = new Map();
  const trainUpdates = source.transitTrips.map((trip) => {
    const match = trip.id.match(/-(\d+)-([789])$/);
    if (!match) throw new Error(`ITX trip train identity is invalid: ${trip.id}`);
    const [, trainNumber, dayCd] = match;
    const key = `${dayCd}:${trainNumber}`;
    if (tripByServiceDayAndTrain.has(key)) {
      throw new Error(`duplicate ITX trip train identity: ${key}`);
    }
    tripByServiceDayAndTrain.set(key, trip.id);
    return `UPDATE transit_trips SET train_no = ${sqlText(trainNumber, "train number")} WHERE id = ${sqlText(trip.id, "trip id")};`;
  }).sort((left, right) => left.localeCompare(right));

  const fares = new Map();
  for (const serviceDay of completeness.serviceDays ?? []) {
    if (!/[789]/.test(serviceDay?.dayCd) || !Array.isArray(serviceDay?.roster?.itineraries)) {
      throw new Error("complete timetable fare evidence is invalid");
    }
    for (const itinerary of serviceDay.roster.itineraries) {
      const tripId = tripByServiceDayAndTrain.get(`${serviceDay.dayCd}:${itinerary.trainNumber}`);
      const adultFareWon = Number(itinerary.adultFareWon);
      if (!tripId || !Number.isInteger(adultFareWon) || adultFareWon <= 0) {
        throw new Error("complete timetable fare evidence is invalid");
      }
      const originStationId = requiredText(itinerary.departureStationId, "fare origin station");
      const destinationStationId = requiredText(itinerary.arrivalStationId, "fare destination station");
      const key = `${tripId}\0${originStationId}\0${destinationStationId}`;
      const row = { tripId, originStationId, destinationStationId, adultFareWon };
      const existing = fares.get(key);
      if (existing && existing.adultFareWon !== adultFareWon) {
        throw new Error("conflicting official fare for trip OD");
      }
      fares.set(key, row);
    }
  }
  const fareRows = [...fares.values()].sort((left, right) => left.tripId.localeCompare(right.tripId)
    || left.originStationId.localeCompare(right.originStationId)
    || left.destinationStationId.localeCompare(right.destinationStationId));
  if (fareRows.length === 0) throw new Error("complete timetable official fares are required");
  const fareStatements = fareRows.map((fare) => (
    "INSERT INTO transit_trip_official_fares "
      + "(trip_id, origin_station_id, destination_station_id, adult_fare_won, currency, source_id, source_snapshot_id) "
      + `VALUES (${sqlText(fare.tripId, "fare trip id")}, ${sqlText(fare.originStationId, "fare origin")}, `
      + `${sqlText(fare.destinationStationId, "fare destination")}, ${fare.adultFareWon}, 'KRW', `
      + `'tago-train-schedule-fares', ${sqlText(source.artifactId, "fare snapshot id")});`
  ));
  return { sql: `${[...trainUpdates, ...fareStatements].join("\n")}\n`, fareCount: fareRows.length };
}

function subwayTrainIdentitySql(baselineSql) {
  const statements = baselineSql.split("\n")
    .filter((line) => line.startsWith("INSERT INTO transit_trips "))
    .map((line) => requiredSqlColumn(valuesByColumn(line, "transit_trips"), "id"))
    .map((tripId) => {
      const match = /^route-seoul-4-(?:up|down)-([A-Z]?\d+)-[789]$/.exec(tripId);
      if (!match) throw new Error(`subway trip train identity is invalid: ${tripId}`);
      const providerTrainNo = match[1].replace(/^[A-Z](?=\d+$)/, "");
      return `UPDATE transit_trips SET train_no = ${sqlText(providerTrainNo, "subway train number")} WHERE id = ${sqlText(tripId, "subway trip id")};`;
    })
    .sort((left, right) => left.localeCompare(right));
  if (statements.length === 0) throw new Error("subway trip train identity is missing");
  return `${statements.join("\n")}\n`;
}

function officialSubwayFareSql(canonicalPackGzipBytes, baselineSql) {
  const directory = mkdtempSync(path.join(tmpdir(), "server-snapshot-fares-"));
  const sqlitePath = path.join(directory, "capital.sqlite");
  let db;
  try {
    writeFileSync(sqlitePath, gunzipSync(canonicalPackGzipBytes));
    db = new DatabaseSync(sqlitePath, { readOnly: true });
    const quotes = db.prepare(`
      SELECT origin_station_id, destination_station_id, gnrl_card_fare, source_id, snapshot_id
      FROM official_od_fare_quotes
      WHERE gnrl_card_fare > 0
      ORDER BY origin_station_id, destination_station_id
    `).all();
    const stopsByTrip = new Map();
    for (const line of baselineSql.split("\n").filter((value) => value.startsWith("INSERT INTO transit_stop_times "))) {
      const [tripId, stopSequence, stationId] = values(line);
      const stops = stopsByTrip.get(tripId) ?? [];
      stops.push({ sequence: Number(stopSequence), stationId });
      stopsByTrip.set(tripId, stops);
    }
    const rows = [];
    for (const [tripId, stops] of [...stopsByTrip].sort(([left], [right]) => left.localeCompare(right))) {
      const stationIds = orderedStationIds(stops);
      for (const quote of quotes) {
        const originIndex = stationIds.indexOf(quote.origin_station_id);
        const destinationIndex = stationIds.indexOf(quote.destination_station_id);
        if (originIndex < 0 || destinationIndex <= originIndex) continue;
        rows.push(
          "INSERT INTO transit_trip_official_fares "
            + "(trip_id, origin_station_id, destination_station_id, adult_fare_won, currency, source_id, source_snapshot_id) "
            + `VALUES (${sqlText(tripId, "fare trip id")}, ${sqlText(quote.origin_station_id, "fare origin")}, `
            + `${sqlText(quote.destination_station_id, "fare destination")}, ${Number(quote.gnrl_card_fare)}, 'KRW', `
            + `${sqlText(quote.source_id, "fare source")}, ${sqlText(quote.snapshot_id, "fare snapshot id")});`,
        );
      }
    }
    return { sql: rows.length === 0 ? "" : `${rows.join("\n")}\n`, fareCount: rows.length };
  } catch (error) {
    throw new Error("canonical official subway fare materialization failed", { cause: error });
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sqlText(value, label) {
  return `'${requiredText(value, label).replaceAll("'", "''")}'`;
}

function namespacedItxServiceId(sourceServiceId) {
  const serviceId = ITX_SERVICE_ID_BY_SOURCE[sourceServiceId];
  if (!serviceId) throw new Error(`unsupported ITX service calendar: ${sourceServiceId}`);
  return serviceId;
}

function admittedCanonicalPack({ canonicalPackGzipBytes, admittedCanonicalPackIdentity }) {
  let canonicalPackSqliteBytes;
  try {
    canonicalPackSqliteBytes = gunzipSync(canonicalPackGzipBytes);
  } catch {
    throw new Error("canonical topology pack identity mismatch");
  }
  const outputSha256 = sha256(canonicalPackGzipBytes);
  const outputSqliteSha256 = sha256(canonicalPackSqliteBytes);
  // coverage contract가 이미 admit한 identity를 evidence에 그대로 기록하되, 실제 번들 pack
  // 파일의 실측 해시와 어긋나면 스테일 pin 위에 조용히 쌓지 않도록 fail closed 한다.
  if (admittedCanonicalPackIdentity.sha256 !== outputSha256
    || admittedCanonicalPackIdentity.sqliteSha256 !== outputSqliteSha256) {
    throw new Error("canonical topology pack identity mismatch");
  }
  return {
    canonicalPackIdentity: {
      id: admittedCanonicalPackIdentity.id,
      sha256: outputSha256,
      sqliteSha256: outputSqliteSha256,
    },
    canonicalPackLineage: {
      provenance: "coverage-contract-admission",
      admittedInputSha256: admittedCanonicalPackIdentity.sha256,
      admittedInputSqliteSha256: admittedCanonicalPackIdentity.sqliteSha256,
    },
  };
}

function validateCanonicalTopologyPack({
  contract,
  source,
  sourceBytes,
  topologyEvidence,
  topologyEvidenceBytes,
  canonicalPackGzipBytes,
  admittedCanonicalPackIdentity,
}) {
  let canonicalPackSqliteBytes;
  try {
    canonicalPackSqliteBytes = gunzipSync(canonicalPackGzipBytes);
  } catch {
    throw new Error("canonical topology pack identity mismatch");
  }
  const outputSha256 = sha256(canonicalPackGzipBytes);
  const outputSqliteSha256 = sha256(canonicalPackSqliteBytes);
  if (source.canonicalPackIdentity?.path !== "apps/mobile/assets/datapacks/capital.sqlite.gz"
    || topologyEvidence?.schemaVersion !== 1
    || topologyEvidence.artifactKind !== "itx-cheongchun-mobile-topology-evidence"
    || topologyEvidence.serviceId !== "ITX_CHEONGCHUN"
    || topologyEvidence.sourceIssue !== 2135
    || topologyEvidence.sourceArtifact?.id !== source.artifactId
    || topologyEvidence.sourceArtifact?.sha256 !== sha256(sourceBytes)
    || topologyEvidence.sourceArtifact?.completenessEvidenceSha256
      !== source.completenessEvidenceSha256
    || topologyEvidence.sourceArtifact?.freshUntil !== source.freshUntil
    || topologyEvidence.pack?.id !== "capital"
    || topologyEvidence.pack.inputSha256 !== admittedCanonicalPackIdentity.sha256
    || topologyEvidence.pack.inputSqliteSha256 !== admittedCanonicalPackIdentity.sqliteSha256
    || topologyEvidence.pack.outputSha256 !== outputSha256
    || topologyEvidence.pack.outputSqliteSha256 !== outputSqliteSha256
    || topologyEvidence.pack.byteSize !== canonicalPackGzipBytes.length
    || topologyEvidence.topology?.stationMembershipCount <= 0
    || topologyEvidence.topology?.connectedComponentCount !== 1
    || topologyEvidence.topology?.isolatedServedStationCount !== 0
    || !lowercaseSha(topologyEvidence.topology?.sha256)
    || !contract.allowedConsumerIssues?.includes("#1400")) {
    throw new Error("canonical topology pack identity mismatch");
  }
  return {
    canonicalPackIdentity: {
      id: topologyEvidence.pack.id,
      sha256: outputSha256,
      sqliteSha256: outputSqliteSha256,
    },
    canonicalPackLineage: {
      topologyEvidenceSha256: sha256(topologyEvidenceBytes),
      topologySha256: topologyEvidence.topology.sha256,
      admittedInputSha256: admittedCanonicalPackIdentity.sha256,
      admittedInputSqliteSha256: admittedCanonicalPackIdentity.sqliteSha256,
    },
  };
}

function normalizeSubwayStationIds(sql, canonicalPackGzipBytes, subwayRoster) {
  const stationMapping = canonicalSubwayStationMapping(canonicalPackGzipBytes, subwayRoster);
  let normalized = sql;
  for (const [sourceStationId, canonicalStationId] of stationMapping) {
    normalized = normalized.replaceAll(`'${sourceStationId}'`, `'${canonicalStationId}'`);
  }
  const unresolved = normalized.split("\n")
    .filter((line) => line.startsWith("INSERT INTO transit_stop_times "))
    .map((line) => values(line)[2])
    .filter((stationId) => stationId.startsWith("station-seoul-4-"));
  if (unresolved.length > 0) {
    throw new Error(`subway baseline has unmapped canonical stations: ${unresolved[0]}`);
  }
  return normalized;
}

function canonicalSubwayStationMapping(canonicalPackGzipBytes, subwayRoster) {
  if (!Array.isArray(subwayRoster?.stations) || subwayRoster.stations.length === 0) {
    throw new Error("subway roster stations are required for canonical mapping");
  }
  const directory = mkdtempSync(path.join(tmpdir(), "server-snapshot-canonical-"));
  const sqlitePath = path.join(directory, "capital.sqlite");
  let db;
  try {
    writeFileSync(sqlitePath, gunzipSync(canonicalPackGzipBytes));
    db = new DatabaseSync(sqlitePath, { readOnly: true });
    const canonicalStations = db.prepare(`
      SELECT stations.id, stations.name_ko, station_lines.line_sequence
      FROM station_lines
      JOIN stations ON stations.id = station_lines.station_id
      WHERE station_lines.line_id = 'seoul-4'
      ORDER BY station_lines.line_sequence, stations.id
    `).all();
    if (canonicalStations.length !== subwayRoster.stations.length) {
      throw new Error("subway roster and canonical pack station counts differ");
    }
    const canonicalBySequence = new Map(canonicalStations.map((station) => [
      Number(station.line_sequence),
      station,
    ]));
    const mapping = new Map();
    for (const station of subwayRoster.stations) {
      const canonical = canonicalBySequence.get(Number(station.stinConsOrdr));
      const sourceName = canonicalSubwayStationName(station.stinNm);
      if (!canonical || sourceName !== normalizeStationName(canonical.name_ko)) {
        throw new Error(`subway roster canonical station mismatch: ${station.stinCd}`);
      }
      const sourceStationId = `station-seoul-4-${station.stinCd}`;
      if (mapping.has(sourceStationId)) {
        throw new Error(`subway roster duplicate station identity: ${sourceStationId}`);
      }
      mapping.set(sourceStationId, canonical.id);
    }
    return mapping;
  } catch (error) {
    if (error?.message?.startsWith("subway roster")) throw error;
    throw new Error("canonical topology pack SQLite mapping is invalid", { cause: error });
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function canonicalSubwayStationName(value) {
  const normalized = normalizeStationName(value);
  return normalized === "능길" ? "신길온천" : normalized;
}

function normalizeStationName(value) {
  return String(value ?? "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase("ko-KR");
}

function representativeServicePatternEvidence(sql, source) {
  const trips = sql.split("\n")
    .filter((line) => line.startsWith("INSERT INTO transit_trips "))
    .map((line) => {
      const row = valuesByColumn(line, "transit_trips");
      return {
        id: requiredSqlColumn(row, "id"),
        routeId: requiredSqlColumn(row, "route_id"),
        servicePattern: requiredSqlColumn(row, "service_pattern"),
        directionId: requiredSqlColumn(row, "direction_id"),
      };
    });
  const stopsByTrip = new Map();
  for (const line of sql.split("\n").filter((value) => value.startsWith("INSERT INTO transit_stop_times "))) {
    const row = values(line);
    const stops = stopsByTrip.get(row[0]) ?? [];
    stops.push({ sequence: Number(row[1]), stationId: row[2] });
    stopsByTrip.set(row[0], stops);
  }
  const localTrips = trips.filter(({ servicePattern }) => servicePattern === "LOCAL");
  const expressTrips = trips.filter(({ servicePattern }) => servicePattern === "EXPRESS");
  const local = localTrips.sort((left, right) => left.id.localeCompare(right.id))
    .find((candidate) => orderedStationIds(stopsByTrip.get(candidate.id)).length > 1);
  const express = representativeItxExpressPattern(source);
  if (!local || !express) {
    throw new Error("complete snapshot must contain representative LOCAL and EXPRESS stop patterns");
  }
  return {
    localTripCount: localTrips.length,
    expressTripCount: expressTrips.length + source.transitTrips.length,
    representativeLocal: tripPatternSummary(local, stopsByTrip),
    representativeExpress: express,
  };
}

function representativeItxExpressPattern(source) {
  const stopTimesByTrip = new Map();
  for (const stop of source.transitStopTimes) {
    const stops = stopTimesByTrip.get(stop.tripId) ?? [];
    stops.push({ sequence: stop.stopSequence, stationId: stop.stationId });
    stopTimesByTrip.set(stop.tripId, stops);
  }
  for (const trip of [...source.transitTrips].sort((left, right) => left.id.localeCompare(right.id))) {
    const stopStationIds = orderedStationIds(stopTimesByTrip.get(trip.id));
    const dayCd = trip.id.split("-").at(-1);
    const roster = source.stationRosters.find((candidate) => candidate.dayCd === dayCd);
    const corridor = [...new Map([...(roster?.stations ?? [])]
      .sort((left, right) => left.corridorSequence - right.corridorSequence)
      .map((station) => [station.canonicalStationId, station])).values()]
      .map(({ canonicalStationId }) => canonicalStationId);
    const first = corridor.indexOf(stopStationIds[0]);
    const last = corridor.indexOf(stopStationIds.at(-1));
    if (first < 0 || last < 0) continue;
    const start = Math.min(first, last);
    const end = Math.max(first, last);
    const passThroughStationIds = corridor.slice(start, end + 1)
      .filter((stationId) => !stopStationIds.includes(stationId));
    if (passThroughStationIds.length === 0) continue;
    return {
      tripId: trip.id,
      routeId: trip.routeId,
      directionId: trip.directionId,
      terminalStationId: stopStationIds.at(-1),
      stopStationIds,
      passThroughStationIds,
      stopPatternSha256: sha256(Buffer.from(JSON.stringify(stopStationIds))),
    };
  }
  return null;
}

function tripPatternSummary(trip, stopsByTrip) {
  const stopStationIds = orderedStationIds(stopsByTrip.get(trip.id));
  return {
    tripId: trip.id,
    routeId: trip.routeId,
    directionId: trip.directionId,
    terminalStationId: stopStationIds.at(-1),
    stopStationIds,
    passThroughStationIds: [],
    stopPatternSha256: sha256(Buffer.from(JSON.stringify(stopStationIds))),
  };
}

function orderedStationIds(stops = []) {
  return [...stops]
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ stationId }) => stationId);
}

function validateAdmission({
  contract,
  source,
  sourceBytes,
  completeness,
  completenessBytes,
  buildNow,
}) {
  const reference = contract?.sourceTimetableArtifact;
  if (contract?.schemaVersion !== 2
    || contract.artifactKind !== "itx-cheongchun-coverage-contract"
    || contract.serviceId !== "ITX_CHEONGCHUN"
    || !contract.allowedConsumerIssues?.includes("#2145")
    || reference?.status !== "ADMITTED"
    || reference.admissionEligible !== true
    || reference.schemaVersion !== 1) {
    throw new Error("#2145 requires the canonical #2135 ADMITTED source contract");
  }
  if (reference.sha256 !== sha256(sourceBytes)) {
    throw new Error("source artifact SHA-256 mismatch");
  }
  if (reference.completenessEvidenceSha256 !== sha256(completenessBytes)) {
    throw new Error("completeness evidence SHA-256 mismatch");
  }
  const { evidenceHash: sourceEvidenceHash, ...sourceWithoutEvidenceHash } = source;
  const { evidenceHash: completenessEvidenceHash, ...completenessWithoutEvidenceHash } = completeness;
  if (source?.schemaVersion !== 1
    || source.artifactKind !== "itx-cheongchun-source-timetable"
    || source.artifactId !== reference.artifactId
    || source.serviceId !== "ITX_CHEONGCHUN"
    || source.validationStatus !== "SUPPORTED"
    || source.freshUntil !== reference.freshUntil
    || source.completenessEvidenceSha256 !== reference.completenessEvidenceSha256
    || sourceEvidenceHash !== sha256(Buffer.from(JSON.stringify(sourceWithoutEvidenceHash)))) {
    throw new Error("source artifact schema or lineage mismatch");
  }
  if (completeness?.schemaVersion !== 2
    || completeness.artifactKind !== "korail-itx-cheongchun-completeness-evidence"
    || completeness.serviceId !== "ITX_CHEONGCHUN"
    || completeness.validationStatus !== "SUPPORTED"
    || completeness.materialization?.status !== "SUPPORTED"
    || completeness.credentialRedacted !== true
    || completenessEvidenceHash !== sha256(Buffer.from(JSON.stringify(completenessWithoutEvidenceHash)))) {
    throw new Error("completeness evidence schema or lineage mismatch");
  }
  const freshUntil = Date.parse(source.freshUntil);
  if (!Number.isFinite(freshUntil) || freshUntil <= buildNow.getTime()) {
    throw new Error("source artifact is stale");
  }
  if (!Array.isArray(source.transitTrips) || source.transitTrips.length === 0
    || !Array.isArray(source.transitStopTimes) || source.transitStopTimes.length === 0
    || !Array.isArray(source.sourceLineage) || source.sourceLineage.length !== 3) {
    throw new Error("source artifact must contain complete timetable and lineage rows");
  }
  const canonical = contract?.officialEvidence?.korailCompletenessAdmission?.canonicalPackIdentity;
  if (canonical?.id !== "capital"
    || !lowercaseSha(canonical.sha256)
    || !lowercaseSha(canonical.sqliteSha256)
    || source.canonicalPackIdentity?.sha256 !== canonical.sha256) {
    throw new Error("canonical pack identity mismatch");
  }
  return { id: canonical.id, sha256: canonical.sha256, sqliteSha256: canonical.sqliteSha256 };
}

function normalizeBaselineSql(baselineGzipBytes) {
  let sql;
  try {
    sql = gunzipSync(baselineGzipBytes).toString("utf8");
  } catch {
    throw new Error("subway baseline must be gzip-compressed SQL");
  }
  const statements = sql.lines ? sql.lines() : sql.split(/\r?\n/);
  const normalized = statements.map((line) => line.trim()).filter(Boolean);
  if (normalized.length === 0 || normalized.some((line) => !line.endsWith(";"))) {
    throw new Error("subway baseline must contain one complete SQL statement per line");
  }
  const value = `${normalized.join("\n")}\n`;
  const tripPatterns = normalized
    .filter((line) => line.startsWith("INSERT INTO transit_trips "))
    .map((line) => values(line)[3]);
  if (tripPatterns.length === 0 || tripPatterns.some((pattern) => !["LOCAL", "EXPRESS"].includes(pattern))) {
    throw new Error("subway baseline trips must explicitly declare LOCAL or EXPRESS service_pattern");
  }
  if (/ITX_CHEONGCHUN|route_service_artifact_evidence/.test(value)) {
    throw new Error("subway baseline must not contain additive ITX rows or evidence");
  }
  return value;
}

function assertNoIdentityCollisions(baselineSql, itxSeed) {
  const baselineRoutes = insertedIds(baselineSql, "transit_routes");
  const baselineTrips = insertedIds(baselineSql, "transit_trips");
  for (const route of itxSeed.routes) {
    if (baselineRoutes.has(route.id)) throw new Error(`complete seed duplicate route id: ${route.id}`);
  }
  for (const statement of itxSeed.statements.filter((value) => value.startsWith("INSERT INTO transit_trips"))) {
    const [tripId] = values(statement);
    if (baselineTrips.has(tripId)) throw new Error(`complete seed duplicate trip id: ${tripId}`);
  }
}

function statementCounts(sql) {
  const count = (table) => (sql.match(new RegExp(`INSERT INTO ${table} \\(`, "g")) ?? []).length;
  return {
    calendars: count("service_calendars"),
    routes: count("transit_routes"),
    trips: count("transit_trips"),
    stopTimes: count("transit_stop_times"),
  };
}

function insertedIds(sql, table) {
  const ids = new Set();
  for (const line of sql.split("\n").filter((value) => value.startsWith(`INSERT INTO ${table} `))) {
    ids.add(values(line)[0]);
  }
  return ids;
}

function values(statement) {
  const marker = " VALUES (";
  const start = statement.indexOf(marker);
  if (start < 0 || !statement.endsWith(");")) throw new Error("unsupported seed statement shape");
  const input = statement.slice(start + marker.length, -2);
  const result = [];
  let token = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "'") {
      if (quoted && input[index + 1] === "'") {
        token += "'";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      result.push(token.trim());
      token = "";
    } else {
      token += character;
    }
  }
  if (quoted) throw new Error("unterminated SQL string");
  result.push(token.trim());
  return result;
}

function valuesByColumn(statement, table) {
  const prefix = `INSERT INTO ${table} (`;
  const marker = ") VALUES (";
  const end = statement.indexOf(marker);
  if (!statement.startsWith(prefix) || end < 0) throw new Error("unsupported seed statement shape");
  const columns = statement.slice(prefix.length, end).split(",").map((column) => column.trim());
  const row = values(statement);
  if (columns.length !== row.length) throw new Error("seed statement column/value count mismatch");
  return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
}

function requiredSqlColumn(row, column) {
  const value = row[column];
  if (value == null || value === "") throw new Error(`seed statement column is missing: ${column}`);
  return value;
}

function canonicalStationSet(source) {
  return [...new Set(source.stationRosters.flatMap(({ stations }) => stations)
    .map(({ canonicalStationId, lineId }) => `${canonicalStationId}:${lineId}`))]
    .sort((left, right) => left.localeCompare(right));
}

function earliestServiceDate(selectedServiceDates) {
  return Object.values(selectedServiceDates).sort((left, right) => left.localeCompare(right))[0];
}

function latestServiceDate(selectedServiceDates) {
  return Object.values(selectedServiceDates).sort((left, right) => left.localeCompare(right)).at(-1);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
}

function lowercaseSha(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselinePath = path.resolve(root, args.baseline
    ?? "backend/src/main/resources/timetable/line4-subway-timetable-seed.sql.gz");
  const contractPath = path.resolve(root, args.contract
    ?? "tools/datapack/itx-cheongchun-coverage-contract.json");
  const outputPath = path.resolve(root, args.output
    ?? "backend/src/main/resources/timetable/line4-timetable-seed.sql.gz");
  const evidencePath = path.resolve(root, args.evidence
    ?? "tools/datapack/server-timetable-snapshot-evidence.json");
  const runtimeEvidencePath = path.resolve(root, args["runtime-evidence"]
    ?? "backend/src/main/resources/timetable/server-timetable-snapshot-evidence.json");
  const canonicalPackPath = path.resolve(root, args["canonical-pack"]
    ?? "apps/mobile/assets/datapacks/capital.sqlite.gz");
  const topologyEvidencePath = path.resolve(root, args["topology-evidence"]
    ?? "tools/datapack/itx-cheongchun-topology-evidence.json");
  // --without-topology-evidence: topology 불변 순수 freshness 리프레시. apply-itx 산출물
  // (topology evidence) 없이 admit된 pack identity를 재사용한다.
  const withoutTopologyEvidence = args["without-topology-evidence"] === true;
  const subwayRosterPath = path.resolve(root, args["subway-roster"]
    ?? "tools/datapack/sources/kric-line4-route-roster-20260706.json");
  const reviewedPackPath = path.resolve(root, args["reviewed-pack"]
    ?? "tools/datapack/release/capital-production-reviewed-pack.json");
  const sourceSnapshotsPath = path.resolve(root, args["source-snapshots"]
    ?? "tools/datapack/release/source-snapshots.json");
  const canonicalGzipBytes = args.check ? await readFile(outputPath) : undefined;
  const contractBytes = await readFile(contractPath);
  const contract = parseJson(contractBytes, "coverage contract");
  const result = buildServerTimetableSnapshot({
    baselineGzipBytes: await readFile(baselinePath),
    contractBytes,
    sourceBytes: await readFile(path.resolve(root, contract.sourceTimetableArtifact.artifactPath)),
    completenessBytes: await readFile(path.resolve(
      root,
      contract.sourceTimetableArtifact.completenessEvidencePath,
    )),
    canonicalPackGzipBytes: await readFile(canonicalPackPath),
    topologyEvidenceBytes: withoutTopologyEvidence ? null : await readFile(topologyEvidencePath),
    subwayRosterBytes: await readFile(subwayRosterPath),
    reviewedPackBytes: await readFile(reviewedPackPath),
    sourceSnapshotsBytes: await readFile(sourceSnapshotsPath),
    canonicalGzipBytes,
    buildNow: buildClock(),
  });
  if (args.check) {
    const [storedSnapshot, storedEvidence, storedRuntimeEvidence] = await Promise.all([
      readFile(outputPath),
      readFile(evidencePath),
      readFile(runtimeEvidencePath),
    ]);
    if (!storedSnapshot.equals(result.gzipBytes)
      || !storedEvidence.equals(result.evidenceBytes)
      || !storedRuntimeEvidence.equals(result.evidenceBytes)) {
      throw new Error("server timetable snapshot is stale");
    }
  } else {
    await Promise.all([
      writeFile(outputPath, result.gzipBytes),
      writeFile(evidencePath, result.evidenceBytes),
      writeFile(runtimeEvidencePath, result.evidenceBytes),
    ]);
  }
  process.stdout.write(`${JSON.stringify({
    snapshotId: result.evidence.snapshotId,
    snapshotSha256: result.evidence.snapshotSha256,
    rowCounts: result.evidence.rowCounts,
  }, null, 2)}\n`);
}

function buildClock() {
  const value = process.env.EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW;
  if (value == null) return new Date();
  if (!value.endsWith("Z")) throw new Error("EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW must be UTC ISO-8601");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW must be UTC ISO-8601");
  return date;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      args.check = true;
      continue;
    }
    if (flag === "--without-topology-evidence") {
      args["without-topology-evidence"] = true;
      continue;
    }
    if (!flag.startsWith("--") || argv[index + 1] == null || argv[index + 1].startsWith("--")) {
      throw new Error(`invalid argument: ${flag}`);
    }
    args[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
