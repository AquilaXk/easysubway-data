import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildArtifactSemanticProfile,
  evaluateArtifactSemanticDrift,
} from "./evaluate-artifact-semantic-drift.mjs";

function createValidSnapshotFixture({ targetVersion = "2026-11-10" } = {}) {
  const stations = [
    { station_id: "st-1", name: "서울역", lat: 37.5546, lng: 126.9706 },
    { station_id: "st-2", name: "시청", lat: 37.5647, lng: 126.9771 },
    { station_id: "st-3", name: "종각", lat: 37.5702, lng: 126.9829 },
    { station_id: "st-4", name: "종로3가", lat: 37.5716, lng: 126.9918 },
    { station_id: "st-5", name: "을지로3가", lat: 37.5663, lng: 126.9919 },
  ];
  const lines = [
    { line_id: "line-1", name: "1호선" },
    { line_id: "line-2", name: "2호선" },
  ];
  const station_lines = [
    { station_id: "st-1", line_id: "line-1" },
    { station_id: "st-2", line_id: "line-1" },
    { station_id: "st-2", line_id: "line-2" },
    { station_id: "st-3", line_id: "line-1" },
    { station_id: "st-4", line_id: "line-1" },
    { station_id: "st-5", line_id: "line-2" },
  ];
  const edges = [
    { edge_id: "e-1", from_station_id: "st-1", to_station_id: "st-2", line_id: "line-1", travel_seconds: 110 },
    { edge_id: "e-2", from_station_id: "st-2", to_station_id: "st-3", line_id: "line-1", travel_seconds: 120 },
    { edge_id: "e-3", from_station_id: "st-3", to_station_id: "st-4", line_id: "line-1", travel_seconds: 130 },
    { edge_id: "e-4", from_station_id: "st-2", to_station_id: "st-5", line_id: "line-2", travel_seconds: 140 },
    { edge_id: "e-5", from_station_id: "st-5", to_station_id: "st-4", line_id: "line-2", travel_seconds: 150 },
  ];
  const transfers = [
    {
      transfer_id: "tr-1",
      from_station_id: "st-2",
      to_station_id: "st-2",
      from_line_id: "line-1",
      to_line_id: "line-2",
      transfer_walk_distance_m: 80,
    },
    {
      transfer_id: "tr-2",
      from_station_id: "st-4",
      to_station_id: "st-5",
      from_line_id: "line-1",
      to_line_id: "line-2",
      transfer_walk_distance_m: 120,
    },
  ];
  const timetables = [
    {
      timetable_id: "tt-1",
      station_id: "st-1",
      line_id: "line-1",
      day_type: "WEEKDAY",
      direction_id: "UP",
      first_departure_sec: 19800,
      last_departure_sec: 86100,
      headway_seconds: 240,
    },
    {
      timetable_id: "tt-2",
      station_id: "st-2",
      line_id: "line-1",
      day_type: "WEEKDAY",
      direction_id: "UP",
      first_departure_sec: 19920,
      last_departure_sec: 86220,
      headway_seconds: 240,
    },
    {
      timetable_id: "tt-3",
      station_id: "st-2",
      line_id: "line-2",
      day_type: "WEEKDAY",
      direction_id: "INNER",
      first_departure_sec: 20000,
      last_departure_sec: 86300,
      headway_seconds: 300,
    },
  ];
  const fares = [
    { fare_id: "f-1", from_station_id: "st-1", to_station_id: "st-2", fare_krw: 1400 },
    { fare_id: "f-2", from_station_id: "st-1", to_station_id: "st-3", fare_krw: 1400 },
    { fare_id: "f-3", from_station_id: "st-1", to_station_id: "st-4", fare_krw: 1500 },
    { fare_id: "f-4", from_station_id: "st-1", to_station_id: "st-5", fare_krw: 1600 },
  ];
  const facilities = [
    { facility_id: "fac-1", station_id: "st-1", facility_type: "ELEVATOR" },
    { facility_id: "fac-2", station_id: "st-2", facility_type: "ELEVATOR" },
    { facility_id: "fac-3", station_id: "st-4", facility_type: "WHEELCHAIR_LIFT" },
  ];
  const stationIds = stations.map((row) => row.station_id);
  const lineIds = lines.map((row) => row.line_id);
  const artifacts = {
    datapack: { targetVersion, stationIds, lineIds },
    "server-route-bundle": { targetVersion, stationIds: [...stationIds], lineIds: [...lineIds] },
    "map-catalog": { targetVersion, stationIds: [...stationIds], lineIds: [...lineIds] },
  };
  return {
    targetVersion,
    tables: {
      stations,
      lines,
      station_lines,
      edges,
      transfers,
      timetables,
      fares,
      facilities,
    },
    artifacts,
  };
}

function populateSqliteFromSnapshot(snapshot) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE stations (station_id TEXT, name TEXT, lat REAL, lng REAL);
    CREATE TABLE lines (line_id TEXT, name TEXT);
    CREATE TABLE station_lines (station_id TEXT, line_id TEXT);
    CREATE TABLE edges (edge_id TEXT, from_station_id TEXT, to_station_id TEXT, line_id TEXT, travel_seconds REAL);
    CREATE TABLE transfers (
      transfer_id TEXT,
      from_station_id TEXT,
      to_station_id TEXT,
      from_line_id TEXT,
      to_line_id TEXT,
      transfer_walk_distance_m REAL
    );
    CREATE TABLE timetables (
      timetable_id TEXT,
      station_id TEXT,
      line_id TEXT,
      day_type TEXT,
      direction_id TEXT,
      first_departure_sec INTEGER,
      last_departure_sec INTEGER,
      headway_seconds INTEGER
    );
    CREATE TABLE fares (fare_id TEXT, from_station_id TEXT, to_station_id TEXT, fare_krw INTEGER);
    CREATE TABLE facilities (facility_id TEXT, station_id TEXT, facility_type TEXT);
  `);

  const insertStation = db.prepare("INSERT INTO stations VALUES (?, ?, ?, ?)");
  for (const row of snapshot.tables.stations) insertStation.run(row.station_id, row.name, row.lat, row.lng);

  const insertLine = db.prepare("INSERT INTO lines VALUES (?, ?)");
  for (const row of snapshot.tables.lines) insertLine.run(row.line_id, row.name);

  const insertStationLine = db.prepare("INSERT INTO station_lines VALUES (?, ?)");
  for (const row of snapshot.tables.station_lines) insertStationLine.run(row.station_id, row.line_id);

  const insertEdge = db.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, ?)");
  for (const row of snapshot.tables.edges) {
    insertEdge.run(row.edge_id, row.from_station_id, row.to_station_id, row.line_id, row.travel_seconds);
  }

  const insertTransfer = db.prepare("INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of snapshot.tables.transfers) {
    insertTransfer.run(
      row.transfer_id,
      row.from_station_id,
      row.to_station_id,
      row.from_line_id,
      row.to_line_id,
      row.transfer_walk_distance_m,
    );
  }

  const insertTimetable = db.prepare("INSERT INTO timetables VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of snapshot.tables.timetables) {
    insertTimetable.run(
      row.timetable_id,
      row.station_id,
      row.line_id,
      row.day_type,
      row.direction_id,
      row.first_departure_sec,
      row.last_departure_sec,
      row.headway_seconds,
    );
  }

  const insertFare = db.prepare("INSERT INTO fares VALUES (?, ?, ?, ?)");
  for (const row of snapshot.tables.fares) {
    insertFare.run(row.fare_id, row.from_station_id, row.to_station_id, row.fare_krw);
  }

  const insertFacility = db.prepare("INSERT INTO facilities VALUES (?, ?, ?)");
  for (const row of snapshot.tables.facilities) {
    insertFacility.run(row.facility_id, row.station_id, row.facility_type);
  }

  return db;
}

test("#87 builds identical canonical semantic profiles from SQLite DatabaseSync and table snapshots", () => {
  const snapshot = createValidSnapshotFixture();
  const db = populateSqliteFromSnapshot(snapshot);
  try {
    const fromSnapshot = buildArtifactSemanticProfile(snapshot);
    const fromSqlite = buildArtifactSemanticProfile(db, {
      targetVersion: snapshot.targetVersion,
      artifacts: snapshot.artifacts,
    });

    assert.equal(fromSnapshot.artifactKind, "datapack-semantic-profile");
    assert.equal(fromSnapshot.tables.stations.rowCount, 5);
    assert.equal(fromSnapshot.tables.stations.keyCardinality, 5);
    assert.equal(fromSnapshot.tables.edges.rowCount, 5);
    assert.equal(fromSnapshot.distributions.travel_seconds.min, 110);
    assert.equal(fromSnapshot.distributions.travel_seconds.p50, 130);
    assert.equal(fromSnapshot.distributions.travel_seconds.p95, 148);
    assert.equal(fromSnapshot.distributions.travel_seconds.max, 150);
    assert.equal(fromSnapshot.distributions.fare_krw.min, 1400);
    assert.equal(fromSnapshot.distributions.fare_krw.max, 1600);
    assert.equal(fromSnapshot.domainInvariants.totalViolationCount, 0);
    assert.equal(fromSnapshot.artifactParity.aligned, true);
    assert.match(fromSnapshot.profileSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(fromSqlite, fromSnapshot);
  } finally {
    db.close();
  }
});

test("#87 counts domain invariants, null/duplicate/orphan FKs, and 3-artifact parity mismatches", () => {
  const corrupted = createValidSnapshotFixture();
  // 1. Duplicate station PK + out-of-Korea coordinates + isolated station
  corrupted.tables.stations.push(
    { station_id: "st-1", name: "서울역중복", lat: 37.5546, lng: 126.9706 },
    { station_id: "st-isolated-oob", name: "고립해외역", lat: 10.5, lng: 140.2 },
    { station_id: "st-null-name", name: "", lat: 37.55, lng: 126.97 },
  );
  // 2. Self-loop edge + negative travel_seconds + orphan station FK
  corrupted.tables.edges.push(
    { edge_id: "e-loop", from_station_id: "st-1", to_station_id: "st-1", line_id: "line-1", travel_seconds: 60 },
    { edge_id: "e-orphan", from_station_id: "st-1", to_station_id: "st-missing", line_id: "line-999", travel_seconds: -15 },
  );
  // 3. Inverted first/last train + negative headway
  corrupted.tables.timetables.push({
    timetable_id: "tt-inverted",
    station_id: "st-1",
    line_id: "line-1",
    day_type: "WEEKDAY",
    direction_id: "DOWN",
    first_departure_sec: 80000,
    last_departure_sec: 20000,
    headway_seconds: -60,
  });
  // 4. Orphan facility & orphan transfer + zero fare
  corrupted.tables.facilities.push({
    facility_id: "fac-orphan",
    station_id: "st-no-such-station",
    facility_type: "ELEVATOR",
  });
  corrupted.tables.transfers.push({
    transfer_id: "tr-orphan",
    from_station_id: "st-2",
    to_station_id: "st-ghost",
    from_line_id: "line-1",
    to_line_id: "line-2",
    transfer_walk_distance_m: 0,
  });
  corrupted.tables.fares.push({
    fare_id: "f-zero",
    from_station_id: "st-1",
    to_station_id: "st-2",
    fare_krw: 0,
  });
  // 5. 3-artifact mismatch on server-route-bundle and map-catalog
  corrupted.artifacts["server-route-bundle"].targetVersion = "2026-11-09";
  corrupted.artifacts["map-catalog"].stationIds = ["st-1", "st-2"];
  corrupted.artifacts["map-catalog"].lineIds = ["line-1"];

  const profile = buildArtifactSemanticProfile(corrupted);
  assert.equal(profile.tables.stations.duplicateKeyCount, 1);
  assert.equal(profile.tables.stations.nullOrEmptyCount, 1);
  assert.equal(profile.tables.edges.orphanFkCount, 1);
  assert.equal(profile.distributions.travel_seconds.negativeCount, 1);
  assert.equal(profile.distributions.transfer_walk_distance_m.zeroCount, 1);
  assert.equal(profile.distributions.fare_krw.zeroCount, 1);
  assert.equal(profile.domainInvariants.selfLoopEdgeCount, 1);
  assert.equal(profile.domainInvariants.isolatedStationCount, 2);
  assert.equal(profile.domainInvariants.outOfKoreaBoundsCoordCount, 1);
  assert.equal(profile.domainInvariants.invertedTimetableOrNegativeIntervalCount, 1);
  assert.equal(profile.domainInvariants.orphanFacilityStationCount, 1);
  assert.equal(profile.domainInvariants.orphanTransferStationCount, 1);
  assert.equal(profile.artifactParity.targetVersionAligned, false);
  assert.equal(profile.artifactParity.aligned, false);
  assert.ok(profile.artifactParity.stationIdDiffCount > 0);
  assert.ok(profile.artifactParity.lineIdDiffCount > 0);
});

test("#87 passes release-diff gate when candidate matches baseline within thresholds", () => {
  const baseline = buildArtifactSemanticProfile(createValidSnapshotFixture({ targetVersion: "2026-11-09" }));
  const candidate = buildArtifactSemanticProfile(createValidSnapshotFixture({ targetVersion: "2026-11-10" }));

  const result = evaluateArtifactSemanticDrift({
    baseline,
    candidate,
    evaluatedAt: "2026-11-10T00:00:00.000Z",
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.blocking, false);
  assert.deepEqual(result.findings, []);
  assert.match(result.evaluationSha256, /^[a-f0-9]{64}$/);
});

test("#87 blocks unwaived row drop/spike and distribution shift, and allows valid non-expired waivers on distribution drift", () => {
  const baselineSnapshot = createValidSnapshotFixture({ targetVersion: "2026-11-09" });
  const candidateSnapshot = createValidSnapshotFixture({ targetVersion: "2026-11-10" });

  // Drop 2 of 4 fares (50% drop > 5% maxRowDropRatio) and shift travel_seconds p50/p95 by +50%
  candidateSnapshot.tables.fares = candidateSnapshot.tables.fares.slice(0, 2);
  for (const edge of candidateSnapshot.tables.edges) {
    edge.travel_seconds = edge.travel_seconds * 1.5;
  }

  const unwaived = evaluateArtifactSemanticDrift({
    baseline: baselineSnapshot,
    candidate: candidateSnapshot,
    evaluatedAt: "2026-11-10T00:00:00.000Z",
  });
  assert.equal(unwaived.status, "FAIL");
  assert.equal(unwaived.blocking, true);
  assert.ok(unwaived.findings.some((f) => f.ruleId === "TABLE_ROW_DROP" && f.metricKey === "table:fares:rowCount" && f.disposition === "BLOCKED"));
  assert.ok(unwaived.findings.some((f) => f.ruleId === "DISTRIBUTION_P50_SHIFT" && f.metricKey === "distribution:travel_seconds:p50" && f.disposition === "BLOCKED"));
  assert.ok(unwaived.findings.some((f) => f.ruleId === "DISTRIBUTION_P95_SHIFT" && f.metricKey === "distribution:travel_seconds:p95" && f.disposition === "BLOCKED"));

  // Expired waiver must still fail closed
  const expiredWaiverResult = evaluateArtifactSemanticDrift({
    baseline: baselineSnapshot,
    candidate: candidateSnapshot,
    evaluatedAt: "2026-11-10T00:00:00.000Z",
    waivers: [
      {
        ruleId: "TABLE_ROW_DROP",
        metricKey: "table:fares:rowCount",
        ownerIssue: 87,
        reason: "구간 요금 테이블 통합",
        expiresAt: "2026-11-09T23:59:59.000Z",
      },
    ],
  });
  assert.equal(expiredWaiverResult.status, "FAIL");
  assert.equal(expiredWaiverResult.blocking, true);

  // Valid, non-expired waivers on all three drift findings classify as WAIVED_WITH_EVIDENCE
  const waivedResult = evaluateArtifactSemanticDrift({
    baseline: baselineSnapshot,
    candidate: candidateSnapshot,
    evaluatedAt: "2026-11-10T00:00:00.000Z",
    waivers: [
      {
        ruleId: "TABLE_ROW_DROP",
        metricKey: "table:fares:rowCount",
        ownerIssue: 87,
        reason: "중복 OD 요금 레코드 정규화",
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
      {
        ruleId: "DISTRIBUTION_P50_SHIFT",
        metricKey: "distribution:travel_seconds:p50",
        ownerIssue: 87,
        reason: "신규 급행 정차시간 재산정 반영",
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
      {
        ruleId: "DISTRIBUTION_P95_SHIFT",
        metricKey: "distribution:travel_seconds:p95",
        ownerIssue: 87,
        reason: "신규 급행 정차시간 재산정 반영",
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
    ],
  });
  assert.equal(waivedResult.status, "WAIVED_WITH_EVIDENCE");
  assert.equal(waivedResult.blocking, false);
  assert.ok(waivedResult.findings.every((f) => f.disposition === "WAIVED_WITH_EVIDENCE"));
});

test("#87 forbids waivers from bypassing domain invariants, orphan FKs, negative metrics, or 3-artifact mismatches", () => {
  const baselineSnapshot = createValidSnapshotFixture({ targetVersion: "2026-11-09" });
  const candidateSnapshot = createValidSnapshotFixture({ targetVersion: "2026-11-10" });

  // Inject unwaivable violations: orphan facility FK, negative travel_seconds, out-of-bounds coord, and 3-artifact mismatch
  candidateSnapshot.tables.facilities.push({
    facility_id: "fac-bad",
    station_id: "st-nonexistent",
    facility_type: "ELEVATOR",
  });
  candidateSnapshot.tables.edges[0].travel_seconds = -30;
  candidateSnapshot.tables.stations[0].lat = 51.5074;
  candidateSnapshot.artifacts["map-catalog"].targetVersion = "2026-01-01";

  const result = evaluateArtifactSemanticDrift({
    baseline: baselineSnapshot,
    candidate: candidateSnapshot,
    evaluatedAt: "2026-11-10T00:00:00.000Z",
    waivers: [
      {
        ruleId: "ORPHAN_FOREIGN_KEY",
        metricKey: "table:facilities:orphanFkCount",
        ownerIssue: 87,
        reason: "불변식 우회 시도",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
      {
        ruleId: "DOMAIN_ORPHAN_FACILITY_STATION",
        metricKey: "invariant:orphanFacilityStationCount",
        ownerIssue: 87,
        reason: "불변식 우회 시도",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
      {
        ruleId: "METRIC_ZERO_OR_NEGATIVE",
        metricKey: "distribution:travel_seconds:zeroOrNegativeCount",
        ownerIssue: 87,
        reason: "음수 시간 우회 시도",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
      {
        ruleId: "DOMAIN_COORD_OUT_OF_KOREA_BOUNDS",
        metricKey: "invariant:outOfKoreaBoundsCoordCount",
        ownerIssue: 87,
        reason: "좌표 경계 우회 시도",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
      {
        ruleId: "THREE_ARTIFACT_PARITY_MISMATCH",
        metricKey: "artifactParity:aligned",
        ownerIssue: 87,
        reason: "3-아티팩트 불일치 우회 시도",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
    ],
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.blocking, true);
  const blockedInvariantIds = new Set(
    result.findings.filter((f) => f.disposition === "BLOCKED" && f.waivable === false).map((f) => f.ruleId),
  );
  assert.equal(blockedInvariantIds.has("ORPHAN_FOREIGN_KEY"), true);
  assert.equal(blockedInvariantIds.has("DOMAIN_ORPHAN_FACILITY_STATION"), true);
  assert.equal(blockedInvariantIds.has("METRIC_ZERO_OR_NEGATIVE"), true);
  assert.equal(blockedInvariantIds.has("DOMAIN_COORD_OUT_OF_KOREA_BOUNDS"), true);
  assert.equal(blockedInvariantIds.has("THREE_ARTIFACT_PARITY_MISMATCH"), true);
  assert.ok(
    result.findings
      .filter((f) => f.waivable === false)
      .every((f) => f.waiverRejectedReason === "UNWAIVABLE_INVARIANT"),
  );
});
