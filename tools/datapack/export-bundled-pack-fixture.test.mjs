import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { extractBundledPackFixture } from "./export-bundled-pack-fixture.mjs";

test("legacy bundled pack을 provenance 추론 없이 builder fixture로 옮긴다", (context) => {
  const database = new DatabaseSync(":memory:");
  const expectedDatabase = new DatabaseSync(":memory:");
  context.after(() => {
    database.close();
    expectedDatabase.close();
  });
  database.exec(`
    CREATE TABLE operators (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL, name_en TEXT NOT NULL);
    CREATE TABLE lines (
      id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, name_ko TEXT NOT NULL,
      name_en TEXT NOT NULL, color TEXT NOT NULL
    );
    CREATE TABLE stations (
      id TEXT PRIMARY KEY, name_ko TEXT NOT NULL, name_en TEXT NOT NULL,
      name_sub TEXT NOT NULL, normalized_name TEXT NOT NULL, region TEXT NOT NULL,
      latitude REAL, longitude REAL, data_quality_level TEXT NOT NULL,
      data_source_type TEXT NOT NULL, last_verified_at INTEGER
    );
    CREATE TABLE station_lines (
      station_id TEXT NOT NULL, line_id TEXT NOT NULL, station_code TEXT NOT NULL,
      line_sequence INTEGER NOT NULL, platform_info TEXT NOT NULL,
      PRIMARY KEY (station_id, line_id)
    );
    CREATE TABLE fare_rules (
      id TEXT PRIMARY KEY, zone_id TEXT NOT NULL, base_card_fare INTEGER NOT NULL,
      base_cash_fare INTEGER NOT NULL, base_distance_meters INTEGER NOT NULL,
      additional_steps_json TEXT NOT NULL
    );
    CREATE TABLE network_edges (
      id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL, distance_meters INTEGER NOT NULL,
      edge_type TEXT NOT NULL, service_pattern TEXT NOT NULL,
      service_class TEXT NOT NULL, includes_stairs INTEGER NOT NULL,
      stair_access_state TEXT NOT NULL, accessibility_status TEXT NOT NULL,
      reliability_score INTEGER NOT NULL, facility_id TEXT, last_verified_at INTEGER
    );
    CREATE TABLE facilities (
      id TEXT PRIMARY KEY, station_id TEXT NOT NULL, exit_id TEXT, type TEXT NOT NULL,
      name TEXT NOT NULL, status TEXT NOT NULL, floor_from TEXT NOT NULL,
      floor_to TEXT NOT NULL, description TEXT NOT NULL
    );
    CREATE TABLE route_map_positions (
      station_id TEXT NOT NULL, line_id TEXT NOT NULL, region TEXT NOT NULL,
      x INTEGER NOT NULL, y INTEGER NOT NULL, label_dx INTEGER NOT NULL,
      label_dy INTEGER NOT NULL, label_polygon TEXT NOT NULL, up_path TEXT NOT NULL,
      down_path TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT NOT NULL,
      source_url TEXT NOT NULL, license TEXT NOT NULL, license_status TEXT NOT NULL,
      commercial_use_allowed INTEGER NOT NULL, attribution_required INTEGER NOT NULL,
      reviewed_at INTEGER, updated_at INTEGER,
      PRIMARY KEY (station_id, line_id, region)
    );
    INSERT INTO operators VALUES ('operator-a', '운영사', 'Operator');
    INSERT INTO lines VALUES ('line-a', 'operator-a', '1호선', 'Line 1', '#123456');
    INSERT INTO stations VALUES (
      'station-a', '역', 'Station', '', '역', '수도권', 37.5, 127.0,
      'LEVEL_2', 'OFFICIAL_FILE', 1785196800
    );
    INSERT INTO station_lines VALUES ('station-a', 'line-a', '101', 1, '');
    INSERT INTO fare_rules VALUES ('fare-a', 'zone-a', 1400, 1500, 10000, '[{"distanceMeters":5000,"cardFare":100,"cashFare":100}]');
    INSERT INTO network_edges VALUES (
      'edge-a', 'station-a:line-a', 'station-b:line-a', 120, 900,
      'RIDE', 'LOCAL', 'SUBWAY', 0, 'UNKNOWN', 'UNKNOWN', 100, NULL, 1785196800
    );
    INSERT INTO facilities VALUES (
      'legacy-facility', 'station-a', NULL, 'ELEVATOR', 'legacy', 'NORMAL', 'B1', '1F', ''
    );
    INSERT INTO facilities VALUES (
      'facility-sangnoksu-accessible-toilet-1', 'station-sangnoksu', NULL,
      'ACCESSIBLE_TOILET', 'legacy toilet', 'UNKNOWN', 'B1', 'B1', 'legacy compatibility'
    );
    INSERT INTO route_map_positions VALUES (
      'station-a', 'line-a', '수도권', 1, 2, 0, 0, '', '', '',
      'source-a', 'source', 'https://example.com', 'license', 'redistributable',
      1, 1, '2026-07-28T00:00:00.000Z', 1785196800
    );
  `);
  expectedDatabase.exec(`
    CREATE TABLE operators (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL, name_en TEXT NOT NULL);
    CREATE TABLE lines (id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, name_ko TEXT NOT NULL, name_en TEXT NOT NULL, color TEXT NOT NULL);
    CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT NOT NULL, name_en TEXT NOT NULL, name_sub TEXT NOT NULL, normalized_name TEXT NOT NULL, region TEXT NOT NULL, latitude REAL, longitude REAL, data_quality_level TEXT NOT NULL, data_source_type TEXT NOT NULL, last_verified_at INTEGER);
    CREATE TABLE station_lines (station_id TEXT NOT NULL, line_id TEXT NOT NULL, station_code TEXT NOT NULL, line_sequence INTEGER NOT NULL, platform_info TEXT NOT NULL, PRIMARY KEY (station_id, line_id));
    CREATE TABLE fare_rules (id TEXT PRIMARY KEY, zone_id TEXT NOT NULL, base_card_fare INTEGER NOT NULL, base_cash_fare INTEGER NOT NULL, base_distance_meters INTEGER NOT NULL, additional_steps_json TEXT NOT NULL);
    CREATE TABLE network_edges (id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, duration_seconds INTEGER NOT NULL, distance_meters INTEGER NOT NULL, edge_type TEXT NOT NULL, service_pattern TEXT NOT NULL, service_class TEXT NOT NULL, includes_stairs INTEGER NOT NULL, stair_access_state TEXT NOT NULL, accessibility_status TEXT NOT NULL, reliability_score INTEGER NOT NULL, source_id TEXT NOT NULL, source_snapshot_id TEXT NOT NULL, provider_record_hash TEXT NOT NULL, provenance_kind TEXT NOT NULL, verification_status TEXT NOT NULL, facility_id TEXT, last_verified_at INTEGER, evidence_hash TEXT NOT NULL);
    CREATE TABLE facilities (id TEXT PRIMARY KEY, station_id TEXT NOT NULL, exit_id TEXT, type TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, floor_from TEXT NOT NULL, floor_to TEXT NOT NULL, description TEXT NOT NULL, source_id TEXT NOT NULL, source_snapshot_id TEXT NOT NULL, provider_facility_ref TEXT NOT NULL, provider_record_hash TEXT NOT NULL, provenance_kind TEXT NOT NULL, verified_at INTEGER NOT NULL, retrieved_at INTEGER NOT NULL, evidence_hash TEXT NOT NULL, status_meaning TEXT NOT NULL, operational_status TEXT NOT NULL, installation_status TEXT NOT NULL, confidence INTEGER NOT NULL);
    CREATE TABLE station_facility_evidence (station_id TEXT NOT NULL, line_id TEXT NOT NULL, facility_type TEXT NOT NULL, PRIMARY KEY (station_id, line_id, facility_type));
    CREATE TABLE route_map_positions (station_id TEXT NOT NULL, line_id TEXT NOT NULL, region TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, label_dx INTEGER NOT NULL, label_dy INTEGER NOT NULL, label_polygon TEXT NOT NULL, up_path TEXT NOT NULL, down_path TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT NOT NULL, source_url TEXT NOT NULL, license TEXT NOT NULL, license_status TEXT NOT NULL, commercial_use_allowed INTEGER NOT NULL, attribution_required INTEGER NOT NULL, reviewed_at INTEGER, updated_at INTEGER, PRIMARY KEY (station_id, line_id, region));
  `);

  const template = {
    manifest: { manifestVersion: 2, channel: "production", ttlSeconds: 3600 },
    packs: [{
      id: "capital",
      version: "1",
      artifactKind: "production",
      sourceInventory: [{ id: "source-a" }],
      requiredTables: ["operators", "lines", "stations", "station_lines", "network_edges"],
      minimumTableRows: {},
      facilities: [{
        id: "reviewed-facility",
        stationId: "station-a",
        type: "ELEVATOR",
        sourceId: "source-a",
      }],
      stationFacilityEvidence: [{ stationId: "station-a", lineId: "line-a", facilityType: "ELEVATOR" }],
    }],
  };

  const fixture = extractBundledPackFixture({
    database,
    expectedDatabase,
    template,
    gzipSha256: "a".repeat(64),
    sqliteSha256: "b".repeat(64),
  });

  assert.deepEqual(fixture.migrationSourceArtifact, {
    gzipSha256: "a".repeat(64),
    sqliteSha256: "b".repeat(64),
  });
  assert.deepEqual(fixture.packs[0].operators, [
    { id: "operator-a", nameKo: "운영사", nameEn: "Operator" },
  ]);
  assert.deepEqual(fixture.packs[0].stations, [{
    id: "station-a",
    nameKo: "역",
    nameEn: "Station",
    nameSub: "",
    normalizedName: "역",
    region: "수도권",
    latitude: 37.5,
    longitude: 127,
    dataQualityLevel: "LEVEL_2",
    dataSourceType: "OFFICIAL_FILE",
    lastVerifiedAt: "2026-07-28T00:00:00.000Z",
  }]);
  assert.deepEqual(fixture.packs[0].fareRules[0].additionalSteps, [
    { distanceMeters: 5000, cardFare: 100, cashFare: 100 },
  ]);
  assert.deepEqual(fixture.packs[0].networkEdges, [{
    id: "edge-a",
    fromNodeId: "station-a:line-a",
    toNodeId: "station-b:line-a",
    durationSeconds: 120,
    distanceMeters: 900,
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
    includesStairs: false,
    stairAccessState: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 100,
    sourceId: "",
    sourceSnapshotId: "",
    providerRecordHash: "",
    provenanceKind: "UNKNOWN",
    verificationStatus: "UNKNOWN",
    facilityId: null,
    lastVerifiedAt: "2026-07-28T00:00:00.000Z",
    evidenceHash: "",
  }]);
  assert.deepEqual(fixture.packs[0].facilities, [{
    id: "legacy-facility",
    stationId: "station-a",
    type: "ELEVATOR",
    sourceId: "source-a",
  }, {
    id: "facility-sangnoksu-accessible-toilet-1",
    stationId: "station-sangnoksu",
    lineId: "seoul-4",
    exitId: null,
    type: "ACCESSIBLE_TOILET",
    name: "legacy toilet",
    status: "UNKNOWN",
    floorFrom: "B1",
    floorTo: "B1",
    description: "legacy compatibility",
    sourceId: "seoul-metro-accessibility",
    sourceSnapshotId: "seoul-metro-accessibility-capital-admission-20260712",
    providerFacilityRef: "facility-sangnoksu-accessible-toilet-1",
    providerRecordHash: "b".repeat(64),
    provenanceKind: "MIGRATION_COMPATIBILITY",
    verifiedAt: "2025-06-01T00:00:00.000Z",
    retrievedAt: "2026-07-12T00:00:00.000Z",
    evidenceHash: "a".repeat(64),
    statusMeaning: "COMPATIBILITY_REFERENCE_ONLY",
    operationalStatus: "UNKNOWN",
    installationStatus: "UNKNOWN",
    confidence: 0,
    derivationKind: "GENERATED",
  }]);
  assert.deepEqual(fixture.packs[0].stationFacilityEvidence, [
    { stationId: "station-a", lineId: "line-a", facilityType: "ELEVATOR" },
  ]);
  assert.equal(fixture.packs[0].routeMapPositions[0].reviewedAt, "2026-07-28T00:00:00.000Z");
  assert.equal(fixture.packs[0].routeMapPositions[0].updatedAt, "2026-07-28T00:00:00.000Z");
  assert.deepEqual(fixture.packs[0].minimumTableRows, {
    operators: 1,
    lines: 1,
    stations: 1,
    station_lines: 1,
    network_edges: 1,
  });
});

test("지원하지 않는 schema table 행은 무음 유실 대신 거부한다", () => {
  const database = new DatabaseSync(":memory:");
  const expectedDatabase = new DatabaseSync(":memory:");
  try {
    const schema = "CREATE TABLE facility_status_snapshots (id TEXT PRIMARY KEY)";
    database.exec(`${schema}; INSERT INTO facility_status_snapshots VALUES ('snapshot-a')`);
    expectedDatabase.exec(schema);

    assert.throws(() => extractBundledPackFixture({
      database,
      expectedDatabase,
      template: {
        packs: [{ artifactKind: "production", requiredTables: [] }],
      },
      gzipSha256: "a".repeat(64),
      sqliteSha256: "b".repeat(64),
    }), /non-empty unsupported table: facility_status_snapshots/);
  } finally {
    database.close();
    expectedDatabase.close();
  }
});

test("legacy internal route edge의 결측 provenance는 UNKNOWN으로 보존한다", () => {
  const database = new DatabaseSync(":memory:");
  const expectedDatabase = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE internal_route_edges (
        id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL,
        instruction TEXT NOT NULL
      );
      INSERT INTO internal_route_edges VALUES ('edge-a', 'node-a', 'node-b', '이동');
    `);
    expectedDatabase.exec(`
      CREATE TABLE internal_route_edges (
        id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL,
        source_id TEXT NOT NULL, source_snapshot_id TEXT NOT NULL,
        provider_record_hash TEXT NOT NULL, provenance_kind TEXT NOT NULL,
        verification_status TEXT NOT NULL, facility_id TEXT,
        last_verified_at INTEGER NOT NULL, evidence_hash TEXT NOT NULL,
        instruction TEXT NOT NULL
      );
    `);

    const fixture = extractBundledPackFixture({
      database,
      expectedDatabase,
      template: { packs: [{ artifactKind: "production", requiredTables: [], internalRouteEdges: [] }] },
      gzipSha256: "a".repeat(64),
      sqliteSha256: "b".repeat(64),
    });

    assert.deepEqual(fixture.packs[0].internalRouteEdges, [{
      id: "edge-a",
      fromNodeId: "node-a",
      toNodeId: "node-b",
      instruction: "이동",
      sourceId: "",
      sourceSnapshotId: "",
      providerRecordHash: "",
      provenanceKind: "UNKNOWN",
      verificationStatus: "UNKNOWN",
      facilityId: null,
      lastVerifiedAt: null,
      evidenceHash: "",
    }]);
  } finally {
    database.close();
    expectedDatabase.close();
  }
});

test("명시적 legacy 기본값이 없는 결측 컬럼은 거부한다", () => {
  const database = new DatabaseSync(":memory:");
  const expectedDatabase = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE lines (
        id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, name_ko TEXT NOT NULL, name_en TEXT NOT NULL
      )
    `);
    expectedDatabase.exec(`
      CREATE TABLE lines (
        id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, name_ko TEXT NOT NULL,
        name_en TEXT NOT NULL, color TEXT NOT NULL
      )
    `);

    assert.throws(() => extractBundledPackFixture({
      database,
      expectedDatabase,
      template: { packs: [{ artifactKind: "production", requiredTables: [] }] },
      gzipSha256: "a".repeat(64),
      sqliteSha256: "b".repeat(64),
    }), /missing lines columns: color/);
  } finally {
    database.close();
    expectedDatabase.close();
  }
});

test("legacy facilities의 알 수 없는 컬럼을 무음 유실하지 않는다", () => {
  const database = new DatabaseSync(":memory:");
  const expectedDatabase = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE facilities (
        id TEXT PRIMARY KEY, station_id TEXT, exit_id TEXT, type TEXT, name TEXT,
        status TEXT, floor_from TEXT, floor_to TEXT, description TEXT, future_value TEXT
      );
      INSERT INTO facilities VALUES (
        'legacy-facility', 'station-a', NULL, 'ELEVATOR', '엘리베이터',
        'UNKNOWN', 'B1', '1F', '', 'must-not-be-dropped'
      );
    `);
    expectedDatabase.exec(`
      CREATE TABLE facilities (
        id TEXT PRIMARY KEY, station_id TEXT, exit_id TEXT, type TEXT, name TEXT,
        status TEXT, floor_from TEXT, floor_to TEXT, description TEXT,
        source_id TEXT, source_snapshot_id TEXT, provider_facility_ref TEXT,
        provider_record_hash TEXT, provenance_kind TEXT, verified_at INTEGER,
        retrieved_at INTEGER, evidence_hash TEXT, status_meaning TEXT,
        operational_status TEXT, installation_status TEXT, confidence INTEGER
      );
    `);

    assert.throws(() => extractBundledPackFixture({
      database,
      expectedDatabase,
      template: {
        packs: [{
          artifactKind: "production",
          requiredTables: [],
          facilities: [{ id: "reviewed", stationId: "station-a", type: "ELEVATOR" }],
        }],
      },
      gzipSha256: "a".repeat(64),
      sqliteSha256: "b".repeat(64),
    }), /unknown facilities columns: future_value/);
  } finally {
    database.close();
    expectedDatabase.close();
  }
});
