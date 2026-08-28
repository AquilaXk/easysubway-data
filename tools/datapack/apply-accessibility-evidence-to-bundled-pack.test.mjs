import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

import {
  accessibilityIndexMetadata,
  applyEvidenceIfStale,
  assertAccessibilityEdges,
  normalizeUnprovenInternalRouteEdges,
  stripLegacyCoreClaims,
  syncAccessibilityEdges,
  activeReleaseSnapshots,
  currentCandidateReleaseSnapshots,
  overlayReviewedSourcesOnCanonicalRoster,
  syncReleaseEvidence,
  syncCanonicalFixture,
} from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { copySyntheticCurrentPublicRouteMapRepository } from "./test-fixtures/current-public-route-map-successor.mjs";

const execFileAsync = promisify(execFile);

test("unproven internal route availability fails check and normalizes to unknown", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE internal_route_edges (
      id TEXT PRIMARY KEY, accessibility_status TEXT, source_id TEXT,
      source_snapshot_id TEXT, provider_record_hash TEXT, evidence_hash TEXT
    );
    INSERT INTO internal_route_edges VALUES
      ('stale', 'AVAILABLE', '', '', '', ''),
      ('unknown', 'UNKNOWN', '', '', '', ''),
      ('proven', 'AVAILABLE', 'kric-station-elevator-movement', 'snapshot', '${"a".repeat(64)}', '${"b".repeat(64)}'),
      ('static-facility', 'AVAILABLE', 'kric-station-convenience-standard', 'snapshot', '${"c".repeat(64)}', '${"d".repeat(64)}');
  `);

  assert.throws(
    () => normalizeUnprovenInternalRouteEdges(database, { check: true }),
    /bundled internal route accessibility evidence is stale/,
  );
  assert.equal(normalizeUnprovenInternalRouteEdges(database, { check: false }), true);
  assert.deepEqual(
    database.prepare("SELECT id, accessibility_status AS status FROM internal_route_edges ORDER BY id").all()
      .map((row) => ({ ...row })),
    [
      { id: "proven", status: "AVAILABLE" },
      { id: "stale", status: "UNKNOWN" },
      { id: "static-facility", status: "UNKNOWN" },
      { id: "unknown", status: "UNKNOWN" },
    ],
  );
  assert.doesNotThrow(() => normalizeUnprovenInternalRouteEdges(database, { check: true }));
  database.close();

  const legacy = new DatabaseSync(":memory:");
  legacy.exec(`
    CREATE TABLE internal_route_edges (id TEXT PRIMARY KEY, accessibility_status TEXT);
    INSERT INTO internal_route_edges VALUES ('legacy', 'AVAILABLE');
  `);
  assert.equal(normalizeUnprovenInternalRouteEdges(legacy, { check: false }), true);
  assert.equal(
    legacy.prepare("SELECT accessibility_status AS status FROM internal_route_edges").get().status,
    "UNKNOWN",
  );
  legacy.close();
});

test("core-only strips facility quality targets and dependent pathway claims", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE facilities (id TEXT PRIMARY KEY);
    CREATE TABLE data_quality_records (id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT);
    CREATE TABLE station_exits (
      id TEXT PRIMARY KEY,
      has_elevator_connection INTEGER,
      source_id TEXT,
      source_snapshot_id TEXT
    );
    CREATE TABLE station_pathway_edges (
      id TEXT PRIMARY KEY,
      requires_facility_id TEXT REFERENCES facilities(id),
      accessibility_status TEXT,
      source_id TEXT,
      source_snapshot_id TEXT,
      provider_record_hash TEXT,
      evidence_hash TEXT
    );
    CREATE TABLE out_of_station_transfer_links (
      id TEXT PRIMARY KEY,
      accessibility_status TEXT,
      source_id TEXT,
      source_snapshot_id TEXT,
      provider_record_hash TEXT,
      evidence_hash TEXT
    );
    INSERT INTO facilities VALUES ('legacy-facility');
    INSERT INTO data_quality_records VALUES
      ('facility-quality', 'facility', 'legacy-facility'),
      ('exit-quality', 'station_exit', 'exit-1');
    INSERT INTO station_exits VALUES
      ('exit-1', 1, 'fixture-capital-catalog', 'fixture-capital-catalog-20260619');
    INSERT INTO station_pathway_edges VALUES
      ('legacy-pathway', 'legacy-facility', 'AVAILABLE', '', '', '', ''),
      ('null-provenance-pathway', NULL, 'AVAILABLE', NULL, 'snapshot',
       '${"c".repeat(64)}', '${"d".repeat(64)}'),
      ('static-facility-pathway', NULL, 'AVAILABLE', 'kric-station-convenience-standard',
       'snapshot', '${"a".repeat(64)}', '${"b".repeat(64)}');
    INSERT INTO out_of_station_transfer_links VALUES
      ('legacy-outside-transfer', 'LIMITED', '', '', '', ''),
      ('null-provenance-transfer', 'AVAILABLE', NULL, 'snapshot',
       '${"c".repeat(64)}', '${"d".repeat(64)}');
  `);

  assert.throws(
    () => stripLegacyCoreClaims(database, { check: true }),
    /bundled station exit elevator claim is stale/,
  );
  assert.equal(stripLegacyCoreClaims(database, { check: false }), true);
  assert.deepEqual(
    database.prepare("SELECT target_type AS targetType FROM data_quality_records").all()
      .map((row) => ({ ...row })),
    [{ targetType: "station_exit" }],
  );
  assert.deepEqual(
    database.prepare(`
      SELECT id, requires_facility_id AS requiresFacilityId, accessibility_status AS accessibilityStatus
      FROM station_pathway_edges ORDER BY id
    `).all().map((row) => ({ ...row })),
    [
      { id: "legacy-pathway", requiresFacilityId: null, accessibilityStatus: "UNKNOWN" },
      { id: "null-provenance-pathway", requiresFacilityId: null, accessibilityStatus: "UNKNOWN" },
      { id: "static-facility-pathway", requiresFacilityId: null, accessibilityStatus: "UNKNOWN" },
    ],
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    database.prepare(`
      SELECT id, accessibility_status AS status FROM out_of_station_transfer_links ORDER BY id
    `).all().map((row) => ({ ...row })),
    [
      { id: "legacy-outside-transfer", status: "UNKNOWN" },
      { id: "null-provenance-transfer", status: "UNKNOWN" },
    ],
  );
  assert.equal(
    database.prepare("SELECT has_elevator_connection AS hasElevatorConnection FROM station_exits").get()
      .hasElevatorConnection,
    0,
  );
  assert.doesNotThrow(() => stripLegacyCoreClaims(database, { check: true }));

  database.prepare("INSERT INTO data_quality_records VALUES ('dangling', 'facility', 'missing')").run();
  assert.throws(() => stripLegacyCoreClaims(database, { check: true }), /legacy core accessibility claims are stale/);
  database.close();
});

test("stale refresh does not mask structural SQLite errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-structural-"));
  const sqlitePath = path.join(directory, "malformed.sqlite");
  const database = new DatabaseSync(sqlitePath);
  database.exec("CREATE TABLE facilities (id TEXT, station_id TEXT)");
  database.close();
  try {
    assert.throws(
      () => applyEvidenceIfStale(sqlitePath, { facilities: [], stationFacilityEvidence: [], networkEdges: [] }),
      /no such column: exit_id/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const reviewedEdge = {
  id: "edge-entry-sadang-seoul-4",
  fromNodeId: "station-sadang",
  toNodeId: "station-sadang:seoul-4",
  durationSeconds: 90,
  distanceMeters: 0,
  edgeType: "ENTRY",
  servicePattern: "",
  includesStairs: false,
  stairAccessState: "UNKNOWN",
  accessibilityStatus: "UNKNOWN",
  reliabilityScore: 90,
  sourceId: "seoul-metro-accessibility",
  sourceSnapshotId: "seoul-metro-accessibility-20260728",
  providerRecordHash: "a".repeat(64),
  provenanceKind: "OFFICIAL_SOURCE",
  verificationStatus: "NOT_VERIFIED",
  lastVerifiedAt: "2026-07-28T15:35:25.704Z",
  evidenceHash: "b".repeat(64),
};

test("canonical and SQLite refresh the reviewed ENTRY/EXIT identity together", () => {
  const reviewedPack = {
    networkEdges: [reviewedEdge],
    movementPathCandidates: [
      { id: "retired-elevator", sourceId: "kric-station-elevator-movement" },
      { id: "retired-lift", sourceId: "kric-wheelchair-lift-movement" },
      { id: "active-seoul", sourceId: "seoul-metro-accessibility" },
      { id: "active-unrelated", sourceId: "seoulmetro-station-line-info" },
      { id: "missing-unrelated", sourceId: "unregistered-source" },
    ],
    metadata: { productionCoverageEvidence: JSON.stringify([
      {
        sourceDomain: "accessibility_facilities",
        sourceIds: ["kric-station-elevator-movement", "kric-wheelchair-lift-movement", "seoul-metro-accessibility"],
      },
      { sourceDomain: "station_line_membership", sourceIds: ["seoulmetro-station-line-info"] },
    ]) },
  };
  const officialOdFareQuotes = [{
    originStationId: "station-sadang",
    destinationStationId: "station-sangnoksu",
    sourceId: "unrelated-official-fares",
  }];
  const routeServiceArtifactEvidence = [{ serviceClass: "ITX_CHEONGCHUN", admissionStatus: "MISSING" }];
  const canonical = { packs: [{
    id: "capital",
    facilities: [
      { id: "legacy-elevator", stationId: "station-sadang", type: "ELEVATOR", sourceId: "kric-station-elevator" },
      { id: "surviving-toilet", stationId: "station-sadang", type: "ACCESSIBLE_TOILET", sourceId: "other" },
    ],
    dataQualityRecords: [
      { targetType: "facility", targetId: "legacy-elevator", qualityLevel: "FIELD_VERIFIED" },
      { targetType: "facility", targetId: "surviving-toilet", qualityLevel: "FIELD_STALE" },
      { targetType: "station_exit", targetId: "exit-sadang-1", qualityLevel: "FIELD_VERIFIED" },
    ],
    networkEdges: [{ ...reviewedEdge, sourceSnapshotId: "stale" }],
    internalRouteEdges: [{
      id: "unproven-internal-edge",
      accessibilityStatus: "AVAILABLE",
      sourceId: "",
      sourceSnapshotId: "",
      providerRecordHash: "",
      evidenceHash: "",
    }],
    stationExits: [{
      id: "exit-sadang-1",
      hasElevatorConnection: true,
      sourceId: "baseline-exit-source-capital",
      sourceSnapshotId: "baseline-exit-source-capital-20260619",
    }],
    sourceInventory: [
      { id: "seoulmetro-station-line-info" },
      { id: "unrelated-official-fares" },
      { id: "kric-station-elevator-movement" },
      { id: "kric-wheelchair-lift-movement" },
    ],
    officialOdFareQuotes,
    routeServiceArtifactEvidence,
    metadata: { productionCoverageEvidence: "retired-accessibility-sources" },
    minimumTableRows: {},
  }] };
  const synced = syncCanonicalFixture(structuredClone(canonical), {
    ...reviewedPack,
    facilities: [],
    stationFacilityEvidence: [],
    sourceInventory: [
      { id: "kric-station-convenience-standard" },
      { id: "seoul-metro-accessibility" },
    ],
  });
  assert.deepEqual(synced.packs[0].networkEdges, [reviewedEdge]);
  assert.deepEqual(synced.packs[0].internalRouteEdges, []);
  assert.equal(synced.packs[0].stationExits[0].hasElevatorConnection, false);
  assert.deepEqual(synced.packs[0].officialOdFareQuotes, officialOdFareQuotes);
  assert.deepEqual(synced.packs[0].routeServiceArtifactEvidence, []);
  assert.deepEqual(synced.packs[0].sourceInventory, [
    { id: "seoulmetro-station-line-info" },
    { id: "unrelated-official-fares" },
    { id: "kric-station-convenience-standard" },
    { id: "seoul-metro-accessibility" },
  ]);
  assert.deepEqual(synced.packs[0].dataQualityRecords, [
    { targetType: "facility", targetId: "surviving-toilet", qualityLevel: "FIELD_STALE" },
    { targetType: "station_exit", targetId: "exit-sadang-1", qualityLevel: "FIELD_VERIFIED" },
  ]);
  const coverageEvidence = JSON.parse(synced.packs[0].metadata.productionCoverageEvidence);
  assert.deepEqual(coverageEvidence, [
    { sourceDomain: "accessibility_facilities", sourceIds: ["seoul-metro-accessibility"] },
    { sourceDomain: "station_line_membership", sourceIds: ["seoulmetro-station-line-info"] },
  ]);
  assert.ok(coverageEvidence.flatMap(({ sourceIds }) => sourceIds)
    .every((sourceId) => synced.packs[0].sourceInventory.some(({ id }) => id === sourceId)));
  assert.deepEqual(synced.packs[0].movementPathCandidates, [
    { id: "active-seoul", sourceId: "seoul-metro-accessibility" },
    { id: "active-unrelated", sourceId: "seoulmetro-station-line-info" },
  ]);
  assert.ok(synced.packs[0].movementPathCandidates
    .every(({ sourceId }) => synced.packs[0].sourceInventory.some(({ id }) => id === sourceId)));

  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE network_edges (
      id TEXT PRIMARY KEY, from_node_id TEXT, to_node_id TEXT, duration_seconds INTEGER,
      distance_meters INTEGER, edge_type TEXT, service_pattern TEXT, service_class TEXT,
      includes_stairs INTEGER, stair_access_state TEXT, accessibility_status TEXT,
      reliability_score INTEGER, source_id TEXT, source_snapshot_id TEXT,
      provider_record_hash TEXT, provenance_kind TEXT, verification_status TEXT,
      facility_id TEXT, last_verified_at INTEGER, evidence_hash TEXT
    );
    INSERT INTO network_edges VALUES (
      'stale-edge', 'station-sadang', 'station-sadang:seoul-4', 1, 1, 'ENTRY', '', 'SUBWAY',
      0, 'UNKNOWN', 'UNKNOWN', 1, 'seoul-metro-accessibility', 'stale', '',
      'OFFICIAL_SOURCE', 'NOT_VERIFIED', NULL, 1, ''
    );
  `);
  syncAccessibilityEdges(database, reviewedPack);
  assert.doesNotThrow(() => assertAccessibilityEdges(database, reviewedPack));
  assert.deepEqual(
    database.prepare("SELECT id, source_snapshot_id AS sourceSnapshotId, evidence_hash AS evidenceHash FROM network_edges")
      .all().map((row) => ({ ...row })),
    [{ id: reviewedEdge.id, sourceSnapshotId: reviewedEdge.sourceSnapshotId, evidenceHash: reviewedEdge.evidenceHash }],
  );
  database.prepare("UPDATE network_edges SET source_snapshot_id = 'stale'").run();
  assert.throws(() => assertAccessibilityEdges(database, reviewedPack), /bundled accessibility edge is stale/);
  database.close();
});

test("canonical sync는 reviewed 필수 계약과 fare table minimum을 함께 닫는다", () => {
  const canonical = () => ({ packs: [{ id: "capital", facilities: [], metadata: {},
    sourceInventory: [{ id: "seoul-metro-accessibility" }],
    officialOdFareQuotes: [{ sourceId: "seoul-metro-accessibility" }],
    requiredTables: ["stations", "official_od_fare_quotes"], minimumTableRows: { official_od_fare_quotes: 1 } }] });
  const reviewed = {
    facilities: [], stationFacilityEvidence: [], sourceInventory: [], metadata: { productionCoverageEvidence: "[]" },
  };
  assert.throws(() => syncCanonicalFixture(canonical(), { ...reviewed, sourceInventory: undefined }),
    /reviewedPack.sourceInventory must be an array/);
  assert.throws(() => syncCanonicalFixture(canonical(), { ...reviewed, metadata: {} }),
    /reviewedPack.metadata.productionCoverageEvidence must be a string/);
  const synced = syncCanonicalFixture(canonical(), reviewed).packs[0];
  assert.deepEqual(synced.requiredTables, ["stations"]);
  assert.equal("official_od_fare_quotes" in synced.minimumTableRows, false);
});

test("active canonical source inventory excludes retired movement snapshot heads", () => {
  const snapshots = [
    { sourceId: "active-source", snapshotId: "active-old", supersededBy: "active-head" },
    { sourceId: "active-source", snapshotId: "active-head" },
    { sourceId: "kric-station-elevator-movement", snapshotId: "elevator-movement-head" },
    { sourceId: "kric-wheelchair-lift-movement", snapshotId: "lift-movement-head" },
  ];
  const canonical = { packs: [{
    id: "capital",
    sourceInventory: [{ id: "active-source" }],
  }] };

  assert.deepEqual(activeReleaseSnapshots(snapshots, canonical, {
    "active-source": "active-head",
    "kric-station-elevator-movement": "elevator-movement-head",
    "kric-wheelchair-lift-movement": "lift-movement-head",
  }), [
    { sourceId: "active-source", snapshotId: "active-head" },
  ]);
});

test("current candidate selects its signed ledger from canonical provenance inventory", () => {
  const canonicalSourceIds = [
    "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-route-map-positions",
    "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard",
    "seoul-metro-official-od-fares", "seoul-metro-transfer-distance-duration",
    "incheon-transit-station-info",
  ];
  const candidateSourceIds = [
    "seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility",
    "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info",
    "seoul-metro-transfer-distance-duration",
  ];
  const snapshots = canonicalSourceIds.map((sourceId) => ({ sourceId, snapshotId: `${sourceId}-head` }));
  const headsBySource = Object.fromEntries(snapshots.map(({ sourceId, snapshotId }) => [sourceId, snapshotId]));
  const canonical = { packs: [{
    id: "capital",
    sourceInventory: canonicalSourceIds.map((id) => ({ id })),
    stationExits: [{ sourceId: "incheon-transit-station-info" }],
  }] };

  assert.deepEqual(
    currentCandidateReleaseSnapshots(snapshots, canonical, headsBySource).map(({ sourceId }) => sourceId),
    candidateSourceIds,
  );
  for (const invalidCanonical of [
    { ...canonical.packs[0], sourceInventory: canonicalSourceIds.filter((_, index) => index !== 2).map((id) => ({ id })) },
    { ...canonical.packs[0], sourceInventory: [canonicalSourceIds[1], canonicalSourceIds[0], ...canonicalSourceIds.slice(2)].map((id) => ({ id })) },
    { ...canonical.packs[0], sourceInventory: [...canonicalSourceIds, "incheon-transit-station-info"].map((id) => ({ id })) },
    { ...canonical.packs[0], sourceInventory: [...canonicalSourceIds, "unknown-provenance-source"].map((id) => ({ id })) },
    { ...canonical.packs[0], sourceInventory: [...canonicalSourceIds, "seoul-metro-route-map-positions"].map((id) => ({ id })) },
  ]) {
    assert.throws(
      () => currentCandidateReleaseSnapshots(snapshots, { packs: [invalidCanonical] }, headsBySource),
      /capital canonical active source identity drift/,
    );
  }
  assert.throws(
    () => currentCandidateReleaseSnapshots(snapshots.filter(({ sourceId }) => sourceId !== "seoul-metro-transfer-distance-duration"), canonical, headsBySource),
    /current candidate source head is missing: seoul-metro-transfer-distance-duration/,
  );
});

test("reviewed accessibility fixture must preserve the complete current canonical source authority", () => {
  const ids = [
    "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-route-map-positions",
    "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard",
    "seoul-metro-official-od-fares", "seoul-metro-transfer-distance-duration", "regional-source",
  ];
  const canonical = () => ({ packs: [{
    id: "capital", sourceInventory: ids.map((id) => ({ id })), stations: [{ sourceId: "regional-source" }],
    facilities: [], stationFacilityEvidence: [], metadata: { productionCoverageEvidence: "[]" }, minimumTableRows: {},
  }] });
  const reviewed = (sourceInventory) => ({
    sourceInventory, facilities: [], stationFacilityEvidence: [], metadata: { productionCoverageEvidence: "[]" },
  });
  for (const sourceInventory of [
    ids.slice(0, -1).map((id) => ({ id })),
    [ids[1], ids[0], ...ids.slice(2)].map((id) => ({ id })),
    [...ids, ids.at(-1)].map((id) => ({ id })),
    [...ids, "unknown-source"].map((id) => ({ id })),
  ]) {
    assert.throws(
      () => syncCanonicalFixture(canonical(), reviewed(sourceInventory)),
      /reviewed source inventory cannot replace current canonical source authority/,
    );
  }
  assert.doesNotThrow(() => syncCanonicalFixture(
    canonical(),
    reviewed(ids.map((id) => ({ id }))),
  ));
  const overlaid = overlayReviewedSourcesOnCanonicalRoster(canonical(), reviewed([
    { id: ids[0], refreshed: true },
    { id: ids[3], refreshed: true },
  ]));
  assert.deepEqual(overlaid.sourceInventory.map(({ id }) => id), ids);
  assert.equal(overlaid.sourceInventory[0].refreshed, true);
  assert.equal(overlaid.sourceInventory[3].refreshed, true);
  assert.equal(overlaid.sourceInventory.at(-1).refreshed, undefined);
  for (const sourceInventory of [
    [{ id: ids[0] }, { id: ids[0] }],
    [{ id: "unknown-source" }],
  ]) {
    assert.throws(
      () => overlayReviewedSourcesOnCanonicalRoster(canonical(), reviewed(sourceInventory)),
      /reviewed source inventory contains (duplicate or invalid|unknown canonical) source ID/,
    );
  }
});

test("candidate-fixtures-only sync succeeds without reading mobile pack paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-candidate-fixtures-"));
  const repository = path.resolve(import.meta.dirname, "../..");
  const candidateBuildSpecPath = "tools/datapack/release/candidate-build-spec.json";
  const candidateBuildSpec = JSON.parse(
    await readFile(path.join(repository, candidateBuildSpecPath), "utf8"),
  );
  const topologyEvidencePath = candidateBuildSpec.itxTopologyEvidencePath;
  assert.equal(typeof topologyEvidencePath, "string");
  assert.equal(path.isAbsolute(topologyEvidencePath), false);
  assert.equal(topologyEvidencePath.split("/").includes(".."), false);
  assert.equal(
    path.resolve(repository, topologyEvidencePath).startsWith(`${repository}${path.sep}`),
    true,
  );
  try {
    await copySyntheticCurrentPublicRouteMapRepository(repository, directory, {
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    await execFileAsync(process.execPath, [
      "tools/datapack/apply-accessibility-evidence-to-bundled-pack.mjs",
      "--candidate-fixtures-only",
      "--release-root", directory,
      "--fixture", path.join(directory, "tools/datapack/release/capital-production-reviewed-pack.json"),
      "--canonical-fixture", path.join(directory, "tools/datapack/release/capital-production-canonical-pack.json"),
      "--pack", path.join(directory, "missing.sqlite.gz"),
      "--index", path.join(directory, "missing-index.json"),
    ], { cwd: repository });
    const [syncedSpec, syncedRequest] = await Promise.all([
      readFile(path.join(directory, candidateBuildSpecPath), "utf8").then(JSON.parse),
      readFile(path.join(directory, "tools/datapack/release/release-request.json"), "utf8").then(JSON.parse),
    ]);
    assert.equal(syncedRequest.candidateId, syncedSpec.candidateId);
    await assert.rejects(readFile(path.join(directory, "missing.sqlite.gz")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(directory, "missing-index.json")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated hash-evidence commands use and enforce the exact candidate snapshot set", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-hash-evidence-command-"));
  const repository = path.resolve(import.meta.dirname, "../..");
  try {
    await copySyntheticCurrentPublicRouteMapRepository(repository, directory, {
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    await mkdir(path.join(directory, "tools/datapack/lib"), { recursive: true });
    await Promise.all([
      "tools/datapack/source-snapshot-policy.mjs",
      "tools/datapack/legacy-source-governance.mjs",
      "tools/datapack/lib/utc-instant.mjs",
    ].map(async (relativePath) => writeFile(
      path.join(directory, relativePath),
      await readFile(path.join(repository, relativePath)),
    )));
    await syncReleaseEvidence({ releaseRoot: directory });
    const [spec, request, hashes, sourceSnapshotLedger] = await Promise.all([
      readFile(path.join(directory, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
      readFile(path.join(directory, "tools/datapack/release/release-request.json"), "utf8").then(JSON.parse),
      readFile(path.join(directory, "tools/datapack/release/hash-evidence.json"), "utf8").then(JSON.parse),
      readFile(path.join(directory, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
    ]);
    assert.equal(hashes.builderGitSha, spec.builderGitSha);
    assert.equal(hashes.identifiers.candidateId.value, spec.candidateId);
    assert.equal(request.candidateId, spec.candidateId);
    const selectedIds = new Set(spec.sourceSnapshotIds);
    const selectedInLedgerOrder = sourceSnapshotLedger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
    assert.equal(spec.sourceSnapshotSetHash, createHash("sha256").update(JSON.stringify(selectedInLedgerOrder)).digest("hex"));
    const reproduction = await execFileAsync(hashes.sourceSnapshotSetHash.reproductionCommand.split(" ")[0], [
      "-e", hashes.sourceSnapshotSetHash.reproductionCommand.match(/-e "(.*)"$/)[1],
    ], { cwd: directory });
    assert.equal(reproduction.stdout.trim(), spec.sourceSnapshotSetHash);
    await execFileAsync("node", ["-e", hashes.sourceSnapshots.committedVerificationCommand.match(/-e "(.*)"$/)[1]], { cwd: directory });

    const extraEvidence = structuredClone(hashes);
    extraEvidence.perSourceEvidence.push({ ...extraEvidence.perSourceEvidence[0] });
    await writeFile(path.join(directory, "tools/datapack/release/hash-evidence.json"), `${JSON.stringify(extraEvidence)}\n`);
    await assert.rejects(
      execFileAsync("node", ["-e", hashes.sourceSnapshots.committedVerificationCommand.match(/-e "(.*)"$/)[1]], { cwd: directory }),
      /source snapshot evidence count mismatch/,
    );

    const reorderedEvidence = structuredClone(hashes);
    reorderedEvidence.perSourceEvidence.reverse();
    await writeFile(path.join(directory, "tools/datapack/release/hash-evidence.json"), `${JSON.stringify(reorderedEvidence)}\n`);
    await assert.rejects(
      execFileAsync("node", ["-e", hashes.sourceSnapshots.committedVerificationCommand.match(/-e "(.*)"$/)[1]], { cwd: directory }),
      /source snapshot evidence order or identity mismatch/,
    );

    await writeFile(path.join(directory, "tools/datapack/release/hash-evidence.json"), `${JSON.stringify(hashes)}\n`);
    const missingCandidate = structuredClone(spec);
    missingCandidate.sourceSnapshotIds.pop();
    await writeFile(path.join(directory, "tools/datapack/release/candidate-build-spec.json"), `${JSON.stringify(missingCandidate)}\n`);
    await assert.rejects(
      execFileAsync("node", ["-e", hashes.sourceSnapshots.committedVerificationCommand.match(/-e "(.*)"$/)[1]], { cwd: directory }),
      /candidate source projection mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects simultaneous bounded modes before I/O", async () => {
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/apply-accessibility-evidence-to-bundled-pack.mjs",
    "--core-only",
    "--candidate-fixtures-only",
  ], { cwd: path.resolve(import.meta.dirname, "../..") }),
  /mutually exclusive/);
});

test("metadata requires admission for facilities-only sources and uses the build clock hook", (t) => {
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = "2026-07-28T16:00:00.000Z";
  t.after(() => {
    if (previousBuildNow === undefined) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  });
  const pack = {
    facilities: [{ sourceId: "facility-source", sourceSnapshotId: "facility-snapshot" }],
    stationFacilityEvidence: [{ sourceId: "status-source", sourceSnapshotId: "status-snapshot" }],
  };
  const spec = { sourceSnapshotSetHash: "a".repeat(64), sourceSnapshots: [
    { sourceId: "facility-source", snapshotId: "facility-snapshot", freshnessExpiresAt: "2026-08-10T00:00:00.000Z" },
    { sourceId: "status-source", snapshotId: "status-snapshot", freshnessExpiresAt: "2026-08-09T00:00:00.000Z" },
  ] };
  const inventory = { sources: [
    { id: "facility-source", accessibilityAdmissionEvidence: { snapshotId: "facility-snapshot", observedAt: "2026-07-28T14:00:00.000Z", freshUntil: "2026-07-29T14:00:00.000Z" } },
    { id: "status-source", accessibilityAdmissionEvidence: { snapshotId: "status-snapshot", observedAt: "2026-07-28T15:00:00.000Z", freshUntil: "2026-07-29T15:00:00.000Z" } },
  ] };

  assert.deepEqual(accessibilityIndexMetadata(pack, spec, inventory, "2026-08-08T00:00:00.000Z"), {
    builtAt: "2026-07-28T16:00:00.000Z",
    qualityAsOf: "2026-07-28T15:00:00.000Z",
    freshnessExpiresAt: "2026-08-08T00:00:00.000Z",
    sourceSnapshotSetHash: "a".repeat(64),
  });
});

test("metadata fails closed when a consumed source lacks admission evidence", () => {
  assert.throws(() => accessibilityIndexMetadata(
    { facilities: [{ sourceId: "missing", sourceSnapshotId: "snapshot" }], stationFacilityEvidence: [] },
    { sourceSnapshotSetHash: "a".repeat(64), sourceSnapshots: [{ sourceId: "missing", snapshotId: "snapshot", freshnessExpiresAt: "2026-08-01T00:00:00.000Z" }] },
    { sources: [] },
    "2026-08-01T00:00:00.000Z",
  ), /accessibility admission evidence missing: missing/);

  assert.throws(() => accessibilityIndexMetadata(
    { facilities: [{ sourceId: "source", sourceSnapshotId: "snapshot" }], stationFacilityEvidence: [] },
    { sourceSnapshotSetHash: "a".repeat(64), sourceSnapshots: [{ sourceId: "source", snapshotId: "snapshot", freshnessExpiresAt: "2026-08-01T00:00:00.000Z" }] },
    { sources: [{ id: "source", accessibilityAdmissionEvidence: { snapshotId: "snapshot", observedAt: "2026-07-28T00:00:00.000Z", freshUntil: "2026-07-29T00:00:00.000Z" } }] },
    undefined,
  ), /bundled pack freshness missing/);
});
