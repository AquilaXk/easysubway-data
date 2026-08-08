import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import { buildServerTimetableSnapshot } from "./build-server-timetable-snapshot.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const contractPath = path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json");
const topologyEvidencePath = path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json");
const subwayRosterPath = path.join(root, "tools/datapack/sources/kric-line4-route-roster-20260706.json");
const reviewedPackPath = path.join(root, "tools/datapack/release/capital-production-reviewed-pack.json");
const sourceSnapshotsPath = path.join(root, "tools/datapack/release/source-snapshots.json");
const buildNow = new Date("2026-07-16T00:00:00.000Z");
const stationCatalogPackIdentity = Object.freeze({
  artifactKind: "station-catalog-pack",
  manifestVersion: 1,
  catalogPackId: "station-catalog-test",
  stationSetSha256: "1".repeat(64),
  payloadSha256: "2".repeat(64),
  manifestSha256: "3".repeat(64),
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function testStationId(station) {
  if (station.stinCd === "433") return "station-sadang";
  if (station.stinCd === "448") return "station-sangnoksu";
  return `station-line4-${station.stinCd}`;
}

function subwayBaselineSql() {
  const statements = [
    "INSERT INTO transit_feed_info (id, feed_end_date) VALUES (1, '20261231');",
    "INSERT INTO service_calendars (service_id, start_date, end_date, timezone, monday, tuesday, wednesday, thursday, friday, saturday, sunday) VALUES ('weekday-kric', '20260101', '20261231', 'Asia/Seoul', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE);",
    "INSERT INTO service_calendars (service_id, start_date, end_date, timezone, monday, tuesday, wednesday, thursday, friday, saturday, sunday) VALUES ('holiday-kric', '20260101', '20261231', 'Asia/Seoul', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, TRUE);",
    "INSERT INTO transit_routes (id, timezone, line_id, route_short_name, route_long_name, direction_name) VALUES ('route-seoul-4-down', 'Asia/Seoul', 'seoul-4', '4', '수도권 4호선', '하행');",
    "INSERT INTO transit_routes (id, timezone, line_id, route_short_name, route_long_name, direction_name) VALUES ('route-seoul-4-up', 'Asia/Seoul', 'seoul-4', '4', '수도권 4호선', '상행');",
    "INSERT INTO transit_trips (id, route_id, service_id, service_pattern, service_day_start_seconds, trip_headsign, direction_id) VALUES ('route-seoul-4-down-4100-8', 'route-seoul-4-down', 'weekday-kric', 'LOCAL', 0, '사당', 'down');",
    "INSERT INTO transit_trips (id, route_id, service_id, service_pattern, service_day_start_seconds, trip_headsign, direction_id) VALUES ('route-seoul-4-up-4227-8', 'route-seoul-4-up', 'weekday-kric', 'LOCAL', 0, '상록수', 'up');",
    "INSERT INTO transit_trips (id, route_id, service_id, service_pattern, service_day_start_seconds, trip_headsign, direction_id) VALUES ('route-seoul-4-up-S4123-8', 'route-seoul-4-up', 'weekday-kric', 'LOCAL', 0, '상록수', 'up');",
  ];
  for (const [tripId, start] of [
    ["route-seoul-4-down-4100-8", 28800],
    ["route-seoul-4-up-4227-8", 30000],
    ["route-seoul-4-up-S4123-8", 31200],
  ]) {
    statements.push(
      `INSERT INTO transit_stop_times (trip_id, stop_sequence, station_id, line_id, pickup_type, drop_off_type, arrival_seconds, departure_seconds) VALUES ('${tripId}', 1, 'station-seoul-4-448', 'seoul-4', 0, 0, ${start}, ${start});`,
      `INSERT INTO transit_stop_times (trip_id, stop_sequence, station_id, line_id, pickup_type, drop_off_type, arrival_seconds, departure_seconds) VALUES ('${tripId}', 2, 'station-seoul-4-433', 'seoul-4', 0, 0, ${start + 600}, ${start + 600});`,
    );
  }
  return `${statements.join("\n")}\n`;
}

let serverFixturePromise;
async function selfContainedServerFixture(subwayRosterBytes) {
  serverFixturePromise ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "server-snapshot-fixture-"));
    const sqlitePath = path.join(directory, "capital.sqlite");
    try {
      const roster = JSON.parse(subwayRosterBytes);
      const schema = await readFile(path.join(root, "tools/datapack/schema/catalog-schema.sql"), "utf8");
      const database = new DatabaseSync(sqlitePath);
      try {
        database.exec(schema);
        database.prepare("INSERT INTO operators (id, name_ko) VALUES ('operator-test', '테스트 운영기관')").run();
        database.prepare("INSERT INTO lines (id, operator_id, name_ko) VALUES ('seoul-4', 'operator-test', '수도권 4호선')").run();
        const insertStation = database.prepare(
          "INSERT INTO stations (id, name_ko, normalized_name, region) VALUES (?, ?, ?, '수도권')",
        );
        const insertMembership = database.prepare(
          "INSERT INTO station_lines (station_id, line_id, line_sequence) VALUES (?, 'seoul-4', ?)",
        );
        for (const station of roster.stations) {
          const stationId = testStationId(station);
          const stationName = station.stinNm === "능길" ? "신길온천" : station.stinNm;
          insertStation.run(stationId, stationName, stationName);
          insertMembership.run(stationId, station.stinConsOrdr);
        }
        database.prepare(`
          INSERT INTO official_od_fare_quotes (
            origin_station_id, destination_station_id, source_id, snapshot_id,
            mapping_ledger_hash, gnrl_card_fare, gnrl_cash_fare,
            yung_card_fare, yung_cash_fare, child_card_fare, child_cash_fare
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "station-sangnoksu", "station-sadang", "seoul-metro-official-od-fares",
          "seoul-metro-official-od-fares-20260712", "4".repeat(64),
          1600, 1700, 1000, 1100, 800, 900,
        );
      } finally {
        database.close();
      }
      const sqliteBytes = await readFile(sqlitePath);
      return {
        baselineGzipBytes: gzipSync(Buffer.from(subwayBaselineSql()), { level: 9, mtime: 0 }),
        canonicalPackGzipBytes: gzipSync(sqliteBytes, { level: 9, mtime: 0 }),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  return serverFixturePromise;
}

async function inputs({ withTopologyEvidence = true } = {}) {
  const subwayRosterBytes = await readFile(subwayRosterPath);
  const { baselineGzipBytes, canonicalPackGzipBytes } =
    await selfContainedServerFixture(subwayRosterBytes);
  const contract = JSON.parse(await readFile(contractPath));
  const source = JSON.parse(await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath)));
  const completeness = JSON.parse(await readFile(path.join(
    root,
    contract.sourceTimetableArtifact.completenessEvidencePath,
  )));
  delete contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity;
  contract.officialEvidence.korailCompletenessAdmission.stationCatalogPackIdentity = stationCatalogPackIdentity;
  contract.sourceTimetableArtifact.promotion.mode = "CURRENT_CANDIDATE_OWNER_APPROVED";
  delete source.canonicalPackIdentity;
  source.stationCatalogPackIdentity = stationCatalogPackIdentity;
  completeness.stationCatalogPackIdentity = stationCatalogPackIdentity;
  const { evidenceHash: _oldCompletenessHash, ...completenessWithoutHash } = completeness;
  completeness.evidenceHash = sha256(Buffer.from(JSON.stringify(completenessWithoutHash)));
  const completenessBytes = Buffer.from(`${JSON.stringify(completeness, null, 2)}\n`);
  source.completenessEvidenceSha256 = sha256(completenessBytes);
  const { evidenceHash: _oldSourceHash, ...sourceWithoutHash } = source;
  source.evidenceHash = sha256(Buffer.from(JSON.stringify(sourceWithoutHash)));
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
  contract.sourceTimetableArtifact.completenessEvidenceSha256 = sha256(completenessBytes);
  const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
  const topologyEvidence = JSON.parse(await readFile(topologyEvidencePath));
  delete topologyEvidence.readmissions;
  topologyEvidence.stationCatalogPackIdentity = stationCatalogPackIdentity;
  topologyEvidence.sourceArtifact = {
    id: source.artifactId,
    sha256: sha256(sourceBytes),
    completenessEvidenceSha256: sha256(completenessBytes),
    freshUntil: source.freshUntil,
    stationCatalogPackIdentity,
  };
  Object.assign(topologyEvidence.pack, {
    outputSha256: sha256(canonicalPackGzipBytes),
    outputSqliteSha256: sha256(gunzipSync(canonicalPackGzipBytes)),
    byteSize: canonicalPackGzipBytes.length,
    byteSizeDelta: canonicalPackGzipBytes.length - topologyEvidence.pack.inputByteSize,
  });
  const topologyEvidenceBytes = withTopologyEvidence
    ? Buffer.from(`${JSON.stringify(topologyEvidence, null, 2)}\n`)
    : null;
  const reviewedPackBytes = await readFile(reviewedPackPath);
  const sourceSnapshotsBytes = await readFile(sourceSnapshotsPath);
  return {
    baselineGzipBytes,
    contractBytes,
    sourceBytes,
    completenessBytes,
    canonicalPackGzipBytes,
    topologyEvidenceBytes,
    subwayRosterBytes,
    reviewedPackBytes,
    sourceSnapshotsBytes,
  };
}

async function writeCurrentCliInputs(directory) {
  const value = await inputs();
  const contract = JSON.parse(value.contractBytes);
  const sourcePath = path.join(directory, "source.json");
  const completenessPath = path.join(directory, "completeness.json");
  const contractFilePath = path.join(directory, "contract.json");
  const topologyEvidenceFilePath = path.join(directory, "topology-evidence.json");
  const baselineFilePath = path.join(directory, "subway-baseline.sql.gz");
  const topologyPackFilePath = path.join(directory, "capital.sqlite.gz");
  contract.sourceTimetableArtifact.artifactPath = sourcePath;
  contract.sourceTimetableArtifact.completenessEvidencePath = completenessPath;
  await Promise.all([
    writeFile(sourcePath, value.sourceBytes),
    writeFile(completenessPath, value.completenessBytes),
    writeFile(contractFilePath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(topologyEvidenceFilePath, value.topologyEvidenceBytes),
    writeFile(baselineFilePath, value.baselineGzipBytes),
    writeFile(topologyPackFilePath, value.canonicalPackGzipBytes),
  ]);
  return { contractFilePath, topologyEvidenceFilePath, baselineFilePath, topologyPackFilePath };
}

test("snapshot builder의 모든 sort는 type-safe comparator를 명시한다", async () => {
  const source = await readFile(
    path.join(root, "tools/datapack/build-server-timetable-snapshot.mjs"),
    "utf8",
  );

  assert.doesNotMatch(source, /\.sort\(\)/);
});

test("#2135 ADMITTED source와 subway seed를 deterministic complete server snapshot으로 만든다", async () => {
  const value = await inputs();
  const first = buildServerTimetableSnapshot({ ...value, buildNow });
  const second = buildServerTimetableSnapshot({ ...value, buildNow });
  const contract = JSON.parse(value.contractBytes);
  const source = JSON.parse(value.sourceBytes);

  assert.deepEqual(second, first);
  assert.equal(gunzipSync(first.gzipBytes).toString("utf8"), first.sql);
  assert.equal(first.evidence.snapshotSha256, sha256(Buffer.from(first.sql)));
  assert.equal(first.evidence.sourceArtifact.id, contract.sourceTimetableArtifact.artifactId);
  assert.equal(first.evidence.sourceArtifact.sha256, sha256(value.sourceBytes));
  assert.equal(first.evidence.sourceArtifact.completenessEvidenceSha256, sha256(value.completenessBytes));
  assert.equal(first.evidence.freshUntil, source.freshUntil);
  assert.deepEqual(first.evidence.canonicalPackIdentity, {
    id: "capital",
    sha256: sha256(value.canonicalPackGzipBytes),
    sqliteSha256: sha256(gunzipSync(value.canonicalPackGzipBytes)),
  });
  assert.deepEqual(first.evidence.stationCatalogPackIdentity, stationCatalogPackIdentity);
  const topologyEvidence = JSON.parse(value.topologyEvidenceBytes);
  assert.deepEqual(first.evidence.canonicalPackLineage, {
    topologyEvidenceSha256: sha256(value.topologyEvidenceBytes),
    topologySha256: topologyEvidence.topology.sha256,
    topologyInputSha256: topologyEvidence.pack.inputSha256,
    topologyInputSqliteSha256: topologyEvidence.pack.inputSqliteSha256,
  });
  assert.deepEqual(first.evidence.serviceIdentity, {
    serviceId: "ITX_CHEONGCHUN",
    canonicalLineId: contract.canonicalLineId,
    servicePattern: "EXPRESS",
    timezone: "Asia/Seoul",
  });
  assert.equal(first.evidence.rowCounts.itxTrips, source.transitTrips.length);
  assert.equal(first.evidence.rowCounts.itxStopTimes, source.transitStopTimes.length);
  assert.ok(first.evidence.rowCounts.officialFares > 0);
  assert.match(
    first.sql,
    /UPDATE transit_trips SET train_no = '2002' WHERE id = 'route-line-54a7b980b7c3-down-2002-8';/,
  );
  assert.match(
    first.sql,
    /UPDATE transit_trips SET train_no = '4227' WHERE id = 'route-seoul-4-up-4227-8';/,
  );
  assert.match(
    first.sql,
    /UPDATE transit_trips SET train_no = '4123' WHERE id = 'route-seoul-4-up-S4123-8';/,
  );
  assert.match(
    first.sql,
    /INSERT INTO transit_trip_official_fares \([^\n]+\) VALUES \('route-line-54a7b980b7c3-[^']+-\d+-8', '[^']+', '[^']+', \d+, 'KRW', 'tago-train-schedule-fares', 'itx-cheongchun-source-timetable-[^']+'\);/,
  );
  assert.match(
    first.sql,
    /INSERT INTO transit_trip_official_fares \([^\n]+\) VALUES \('[^']+', 'station-sangnoksu', 'station-sadang', \d+, 'KRW', 'seoul-metro-official-od-fares', '[^']+'\);/,
  );
  assert.ok(first.evidence.rowCounts.subwayTrips > 0);
  assert.ok(first.evidence.rowCounts.subwayStopTimes > first.evidence.rowCounts.subwayTrips);
  assert.equal(first.evidence.rowCounts.stationPathwayNodes, 4);
  assert.equal(first.evidence.rowCounts.stationPathwayEdges, 4);
  assert.equal(first.evidence.rowCounts.transferRules, 0);
  assert.equal(first.evidence.rowCounts.routeEdgeEvidence, 4);
  assert.equal((first.sql.match(/INSERT INTO station_pathway_nodes/g) ?? []).length, 4);
  assert.equal((first.sql.match(/INSERT INTO station_pathway_edges/g) ?? []).length, 4);
  assert.equal((first.sql.match(/INSERT INTO transfer_rules/g) ?? []).length, 0);
  assert.equal((first.sql.match(/INSERT INTO route_edge_evidence/g) ?? []).length, 4);
  assert.match(first.sql, /'edge-entry-sadang-seoul-4', 'ENTRY', 'seoul-metro-accessibility', 'seoul-metro-accessibility-20260728', 'OFFICIAL_SOURCE', 'UNKNOWN'/);
  assert.doesNotMatch(first.sql, /route_edge_evidence[^;]+'NOT_VERIFIED'/);
  assert.match(first.sql, /'ITX_CHEONGCHUN'/);
  assert.match(first.sql, /, 2135\);/);
  assert.equal((first.sql.match(/INSERT INTO transit_feed_info/g) ?? []).length, 1);
  assert.equal((first.sql.match(/VALUES \('weekday-kric'/g) ?? []).length, 1);
  assert.equal((first.sql.match(/VALUES \('holiday-kric'/g) ?? []).length, 1);
  assert.match(first.sql, /VALUES \('itx-cheongchun-weekday-kric', '20260727', '20260802', 'Asia\/Seoul', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE\)/);
  assert.match(first.sql, /VALUES \('itx-cheongchun-saturday-kric', '20260727', '20260802', 'Asia\/Seoul', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE\)/);
  assert.match(first.sql, /VALUES \('itx-cheongchun-holiday-kric', '20260727', '20260802', 'Asia\/Seoul', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE\)/);
  for (const [sourceServiceId, namespacedServiceId] of [
    ["weekday-kric", "itx-cheongchun-weekday-kric"],
    ["saturday-kric", "itx-cheongchun-saturday-kric"],
    ["holiday-kric", "itx-cheongchun-holiday-kric"],
  ]) {
    const expectedTrips = source.transitTrips.filter(({ serviceId }) => serviceId === sourceServiceId).length;
    assert.equal(
      (first.sql.match(new RegExp(`INSERT INTO transit_trips \\([^\\n]+, '${namespacedServiceId}',`, "g")) ?? []).length,
      expectedTrips,
    );
  }
  assert.doesNotMatch(first.sql, /'station-seoul-4-/);
  assert.match(first.sql, /'station-sadang'/);
  assert.match(first.sql, /'station-sangnoksu'/);
  const localPattern = first.evidence.servicePatternEvidence.representativeLocal;
  const expressPattern = first.evidence.servicePatternEvidence.representativeExpress;
  assert.ok(localPattern.stopStationIds.length > 1);
  assert.deepEqual(localPattern.passThroughStationIds, []);
  assert.ok(expressPattern.stopStationIds.length > 1);
  assert.ok(expressPattern.passThroughStationIds.length > 0);
  assert.ok(expressPattern.passThroughStationIds.every(
    (stationId) => !expressPattern.stopStationIds.includes(stationId),
  ));
  assert.ok(first.evidence.servicePatternEvidence.localTripCount > 0);
  assert.ok(first.evidence.servicePatternEvidence.expressTripCount > 0);
});

test("접근성 source snapshot의 lineage와 governance 값을 그대로 materialize한다", async () => {
  const value = await inputs();
  const reviewedPack = JSON.parse(value.reviewedPackBytes);
  const snapshots = JSON.parse(value.sourceSnapshotsBytes);
  const parent = snapshots.find(
    ({ snapshotId }) => snapshotId === "seoul-metro-accessibility-20260728",
  );
  const child = {
    ...parent,
    snapshotId: "seoul-metro-accessibility-20260729",
    retrievedAt: "2026-07-29T00:00:00Z",
    sourceUpdatedAt: null,
    rowCount: 9,
    coverageCount: 2,
    previousSnapshotId: parent.snapshotId,
    diffSummary: { status: "CHANGED", rowDelta: 8, coverageDelta: 1 },
    governancePolicyVersion: "2026-07-15",
    governancePolicySha256: "a".repeat(64),
  };
  for (const pack of reviewedPack.packs) {
    for (const edge of pack.networkEdges ?? []) {
      if (["ENTRY", "EXIT"].includes(edge.edgeType) && edge.sourceSnapshotId === parent.snapshotId) {
        edge.sourceSnapshotId = child.snapshotId;
      }
    }
  }

  const result = buildServerTimetableSnapshot({
    ...value,
    reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
    sourceSnapshotsBytes: Buffer.from(JSON.stringify([...snapshots, child])),
    buildNow,
  });
  const parentOffset = result.sql.indexOf(`SELECT '${parent.snapshotId}'`);
  const childStatement = result.sql.split("\n")
    .find((line) => line.includes(`SELECT '${child.snapshotId}'`));
  const childGovernanceUpdate = result.sql.split("\n")
    .find((line) => line.startsWith("UPDATE data_source_snapshots SET ")
      && line.includes(`snapshot_id IS NOT DISTINCT FROM '${child.snapshotId}'`));

  assert.ok(parentOffset >= 0);
  assert.ok(childStatement);
  assert.ok(parentOffset < result.sql.indexOf(childStatement));
  assert.match(childStatement, /, NULL, NULL, NULL, 9, 2, /);
  assert.match(childStatement, new RegExp(`, '${parent.snapshotId}', 'CHANGED', `));
  assert.match(childStatement, /'\{"status":"CHANGED","rowDelta":8,"coverageDelta":1\}'/);
  assert.match(childStatement, /, '2026-07-15', 'a{64}' WHERE/);
  assert.ok(childGovernanceUpdate);
  assert.match(childGovernanceUpdate, /SET governance_policy_version = '2026-07-15', governance_policy_sha256 = 'a{64}' WHERE/);
  const existingRowPredicate = childStatement.slice(childStatement.indexOf("WHERE NOT EXISTS"));
  const insertColumns = childStatement.match(/data_source_snapshots \(([^)]+)\)/)[1].split(", ");
  assert.doesNotMatch(existingRowPredicate, /governance_policy_(version|sha256)/);
  for (const column of insertColumns.filter(
    (column) => !["governance_policy_version", "governance_policy_sha256"].includes(column),
  )) {
    assert.match(existingRowPredicate, new RegExp(`${column} IS NOT DISTINCT FROM`));
    assert.match(childGovernanceUpdate, new RegExp(`${column} IS NOT DISTINCT FROM`));
  }
  const parentStatement = result.sql.split("\n")
    .find((line) => line.includes(`SELECT '${parent.snapshotId}'`));
  assert.match(parentStatement, /, '2026-07-15', '[a-f0-9]{64}' WHERE/);
});

test("접근성 evidence identity는 실제 materialization 입력에만 결합한다", async () => {
  const value = await inputs();
  const baseline = buildServerTimetableSnapshot({ ...value, buildNow });
  const reviewedPack = JSON.parse(value.reviewedPackBytes);
  reviewedPack.unrelatedMetadata = "changed";
  const snapshots = JSON.parse(value.sourceSnapshotsBytes);
  snapshots.push({ snapshotId: "unrelated-snapshot" });

  const unrelatedChange = buildServerTimetableSnapshot({
    ...value,
    reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
    sourceSnapshotsBytes: Buffer.from(JSON.stringify(snapshots)),
    buildNow,
  });

  assert.equal(unrelatedChange.sql, baseline.sql);
  assert.deepEqual(unrelatedChange.evidence, baseline.evidence);
  const accessibilityOffset = Math.min(
    ...[
      baseline.sql.indexOf("UPDATE data_source_snapshots SET "),
      baseline.sql.indexOf("INSERT INTO data_source_snapshots "),
    ].filter((offset) => offset >= 0),
  );
  const accessSql = baseline.sql.slice(accessibilityOffset);
  assert.equal(
    baseline.evidence.accessibilitySource.materializedSqlSha256,
    sha256(Buffer.from(accessSql)),
  );
});

test("접근성 edge의 계단 여부가 boolean이 아니면 strict materialization을 거부한다", async () => {
  const value = await inputs();
  const reviewedPack = JSON.parse(value.reviewedPackBytes);
  reviewedPack.packs[0].networkEdges[0].includesStairs = "true";

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
      buildNow,
    }),
    /canonical accessibility edge includesStairs is invalid/,
  );
});

test("접근성 source snapshot의 정책 값이 boolean이 아니면 materialization을 거부한다", async () => {
  const value = await inputs();

  for (const field of ["redistributionAllowed", "credentialRedacted"]) {
    const snapshots = JSON.parse(value.sourceSnapshotsBytes);
    const snapshot = snapshots.find(
      ({ snapshotId }) => snapshotId === "seoul-metro-accessibility-capital-admission-20260712",
    );
    snapshot[field] = "false";

    assert.throws(
      () => buildServerTimetableSnapshot({
        ...value,
        sourceSnapshotsBytes: Buffer.from(JSON.stringify(snapshots)),
        buildNow,
      }),
      /canonical accessibility source snapshot policy boolean is invalid/,
    );
  }
});

test("접근성 source와 edge의 숫자 값이 유효한 정수가 아니면 materialization을 거부한다", async () => {
  const value = await inputs();
  const snapshots = JSON.parse(value.sourceSnapshotsBytes);
  const snapshot = snapshots.find(
    ({ snapshotId }) => snapshotId === "seoul-metro-accessibility-capital-admission-20260712",
  );
  snapshot.rowCount = "1";
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      sourceSnapshotsBytes: Buffer.from(JSON.stringify(snapshots)),
      buildNow,
    }),
    /snapshot rowCount is invalid/,
  );

  for (const [field, invalidValue, message] of [
    ["durationSeconds", 1.5, "pathway duration"],
    ["distanceMeters", -1, "pathway distance"],
    ["reliabilityScore", 101, "pathway reliability"],
  ]) {
    const reviewedPack = JSON.parse(value.reviewedPackBytes);
    reviewedPack.packs[0].networkEdges[0][field] = invalidValue;
    assert.throws(
      () => buildServerTimetableSnapshot({
        ...value,
        reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
        buildNow,
      }),
      new RegExp(`${message} is invalid`),
    );
  }
});

test("접근성 edge endpoint 형식이 잘못되면 명시적인 build error로 거부한다", async () => {
  const value = await inputs();
  const reviewedPack = JSON.parse(value.reviewedPackBytes);
  reviewedPack.packs[0].networkEdges[0].toNodeId = null;

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      reviewedPackBytes: Buffer.from(JSON.stringify(reviewedPack)),
      buildNow,
    }),
    /canonical accessibility edge endpoints are invalid/,
  );
});

test("complete snapshot은 source·completeness identity와 freshness를 fail closed한다", async () => {
  const value = await inputs();
  const source = JSON.parse(value.sourceBytes);
  source.transitStopTimes[0].arrivalSeconds += 1;
  const tamperedSourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);

  assert.throws(
    () => buildServerTimetableSnapshot({ ...value, sourceBytes: tamperedSourceBytes, buildNow }),
    /source artifact SHA-256 mismatch/,
  );
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      buildNow: new Date("2026-08-02T15:00:00.000Z"),
    }),
    /source artifact is stale/,
  );
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      canonicalPackGzipBytes: Buffer.concat([value.canonicalPackGzipBytes, Buffer.from("tampered")]),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
  const legacyReadmission = JSON.parse(value.topologyEvidenceBytes);
  legacyReadmission.readmissions = [{ previousPack: { sha256: "0".repeat(64) } }];
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      topologyEvidenceBytes: Buffer.from(JSON.stringify(legacyReadmission)),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
  const mixedTopologyIdentity = JSON.parse(value.topologyEvidenceBytes);
  mixedTopologyIdentity.canonicalPackIdentity = { id: "legacy-capital" };
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      topologyEvidenceBytes: Buffer.from(JSON.stringify(mixedTopologyIdentity)),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
  const mixedContractIdentity = JSON.parse(value.contractBytes);
  mixedContractIdentity.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity = {
    id: "legacy-capital",
  };
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      contractBytes: Buffer.from(JSON.stringify(mixedContractIdentity)),
      buildNow,
    }),
    /station catalog identity mismatch/,
  );
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      topologyEvidenceBytes: null,
      buildNow,
    }),
    /topology evidence is required/,
  );
  const topologyEvidence = JSON.parse(value.topologyEvidenceBytes);
  topologyEvidence.pack.outputSha256 = "0".repeat(64);
  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      topologyEvidenceBytes: Buffer.from(`${JSON.stringify(topologyEvidence, null, 2)}\n`),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
});

test("현재 8컬럼 subway trip INSERT에서도 direction과 terminal evidence를 보존한다", async () => {
  const value = await inputs();
  const currentSchemaSql = gunzipSync(value.baselineGzipBytes).toString("utf8")
    .replaceAll(
      "service_pattern, service_day_start_seconds",
      "service_pattern, service_class, service_day_start_seconds",
    )
    .replace(
      /^(INSERT INTO transit_trips .*?'(?:LOCAL|EXPRESS)')(?=, )/gm,
      "$1, 'SUBWAY'",
    );

  const result = buildServerTimetableSnapshot({
    ...value,
    baselineGzipBytes: gzipSync(Buffer.from(currentSchemaSql), { level: 9, mtime: 0 }),
    buildNow,
  });
  const local = result.evidence.servicePatternEvidence.representativeLocal;

  assert.equal(local.directionId, "down");
  assert.equal(local.terminalStationId, local.stopStationIds.at(-1));
});

test("canonical gzip transport는 zlib encoder가 달라도 normalized SQL identity에 결합한다", async () => {
  const value = await inputs();
  const generated = buildServerTimetableSnapshot({ ...value, buildNow });
  const canonicalGzipBytes = gzipSync(Buffer.from(generated.sql), { level: 0, mtime: 0 });

  const canonical = buildServerTimetableSnapshot({
    ...value,
    buildNow,
    canonicalGzipBytes,
  });

  assert.equal(sha256(canonical.gzipBytes), sha256(canonicalGzipBytes));
  assert.equal(canonical.evidence.snapshotSha256, generated.evidence.snapshotSha256);
  assert.equal(canonical.evidence.snapshotGzipSha256, sha256(canonicalGzipBytes));
  assert.equal(canonical.evidence.snapshotGzipByteSize, canonicalGzipBytes.length);
});

test("CLI는 current station-catalog admission으로 snapshot/evidence를 생성하고 --check에서 byte identity를 검증한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "server-timetable-snapshot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "snapshot.sql.gz");
  const evidencePath = path.join(directory, "evidence.json");
  const runtimeEvidencePath = path.join(directory, "runtime-evidence.json");
  const { contractFilePath, topologyEvidenceFilePath, baselineFilePath, topologyPackFilePath } =
    await writeCurrentCliInputs(directory);
  const args = [
    "tools/datapack/build-server-timetable-snapshot.mjs",
    "--baseline", baselineFilePath,
    "--topology-pack", topologyPackFilePath,
    "--contract", contractFilePath,
    "--topology-evidence", topologyEvidenceFilePath,
    "--output", outputPath,
    "--evidence", evidencePath,
    "--runtime-evidence", runtimeEvidencePath,
  ];
  const env = { ...process.env, EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW: buildNow.toISOString() };

  await execFileAsync(process.execPath, args, { cwd: root, env });
  const before = await Promise.all([
    readFile(outputPath),
    readFile(evidencePath),
    readFile(runtimeEvidencePath),
  ]);
  assert.deepEqual(before[2], before[1]);
  await execFileAsync(process.execPath, [...args, "--check"], { cwd: root, env });
  assert.deepEqual(await Promise.all([
    readFile(outputPath),
    readFile(evidencePath),
    readFile(runtimeEvidencePath),
  ]), before);

  const value = await inputs();
  const canonicalGzipBytes = gzipSync(gunzipSync(before[0]), { level: 0, mtime: 0 });
  const canonical = buildServerTimetableSnapshot({
    ...value,
    buildNow,
    canonicalGzipBytes,
  });
  await Promise.all([
    writeFile(outputPath, canonicalGzipBytes),
    writeFile(evidencePath, canonical.evidenceBytes),
    writeFile(runtimeEvidencePath, canonical.evidenceBytes),
  ]);
  await execFileAsync(process.execPath, [...args, "--check"], { cwd: root, env });

  await writeFile(outputPath, Buffer.concat([before[0], Buffer.from("tampered")]));
  await assert.rejects(
    execFileAsync(process.execPath, [...args, "--check"], { cwd: root, env }),
    /canonical gzip transport does not match normalized SQL/,
  );
});

test("CLI --check는 current station-catalog input과 생성 snapshot/evidence의 최신성을 검증한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "server-timetable-snapshot-check-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { contractFilePath, topologyEvidenceFilePath, baselineFilePath, topologyPackFilePath } =
    await writeCurrentCliInputs(directory);
  const args = [
    "tools/datapack/build-server-timetable-snapshot.mjs",
    "--baseline", baselineFilePath,
    "--contract", contractFilePath,
    "--topology-pack", topologyPackFilePath,
    "--topology-evidence", topologyEvidenceFilePath,
    "--output", path.join(directory, "snapshot.sql.gz"),
    "--evidence", path.join(directory, "evidence.json"),
    "--runtime-evidence", path.join(directory, "runtime-evidence.json"),
  ];
  const env = { ...process.env, EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW: buildNow.toISOString() };
  await execFileAsync(process.execPath, args, { cwd: root, env });
  await execFileAsync(process.execPath, [...args, "--check"], { cwd: root, env });
});

// 현재 station-catalog admission과 topology evidence가 동일 identity를 전달하는 양성 fixture다.
function consistentFreshnessInputs(value) {
  const measuredGzipSha = sha256(value.canonicalPackGzipBytes);
  const measuredSqliteSha = sha256(gunzipSync(value.canonicalPackGzipBytes));
  return {
    contractBytes: value.contractBytes,
    sourceBytes: value.sourceBytes,
    topologyEvidenceBytes: value.topologyEvidenceBytes,
    measuredGzipSha,
    measuredSqliteSha,
  };
}

function staleCanonicalInputs(value) {
  const source = JSON.parse(value.sourceBytes);
  source.stationCatalogPackIdentity = {
    ...source.stationCatalogPackIdentity,
    payloadSha256: "0".repeat(64),
  };
  const { evidenceHash: _drop, ...sourceWithoutHash } = source;
  source.evidenceHash = sha256(Buffer.from(JSON.stringify(sourceWithoutHash)));
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  const contract = JSON.parse(value.contractBytes);
  contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
  return { contract, sourceBytes };
}

test("current topology evidence 경로는 station-catalog와 topology pack identity를 evidence에 기록한다", async () => {
  const value = await inputs({ withTopologyEvidence: true });
  const { contractBytes, sourceBytes, measuredGzipSha, measuredSqliteSha } = consistentFreshnessInputs(value);

  const result = buildServerTimetableSnapshot({
    ...value, contractBytes, sourceBytes, buildNow,
  });

  assert.deepEqual(result.evidence.canonicalPackIdentity, {
    id: "capital", sha256: measuredGzipSha, sqliteSha256: measuredSqliteSha,
  });
  assert.deepEqual(result.evidence.stationCatalogPackIdentity, stationCatalogPackIdentity);
  assert.equal(result.evidence.canonicalPackLineage.topologyEvidenceSha256, sha256(value.topologyEvidenceBytes));
  assert.match(
    result.sql,
    new RegExp(`'ITX_CHEONGCHUN', '[^']+', '[^']+', 'station-catalog-pack', 1, 'station-catalog-test', '${stationCatalogPackIdentity.stationSetSha256}', '${stationCatalogPackIdentity.payloadSha256}', '${stationCatalogPackIdentity.manifestSha256}', 'ADMITTED'`),
  );
});

test("current 경로는 source와 contract station-catalog identity가 불일치하면 fail closed 한다", async () => {
  const value = await inputs();
  const { contract, sourceBytes } = staleCanonicalInputs(value);

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      contractBytes: Buffer.from(`${JSON.stringify(contract, null, 2)}\n`),
      sourceBytes,
      buildNow,
    }),
    /station catalog identity mismatch/,
  );
});

test("current 경로는 contract station-catalog manifest identity만 어긋나도 fail closed 한다", async () => {
  const value = await inputs({ withTopologyEvidence: true });
  const { contractBytes, sourceBytes } = consistentFreshnessInputs(value);
  const contract = JSON.parse(contractBytes);
  contract.officialEvidence.korailCompletenessAdmission.stationCatalogPackIdentity = {
    ...contract.officialEvidence.korailCompletenessAdmission.stationCatalogPackIdentity,
    manifestSha256: "9".repeat(64),
  };
  const tamperedContractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value, contractBytes: tamperedContractBytes, sourceBytes, buildNow,
    }),
    /station catalog identity mismatch/,
  );
});

test("current 경로는 legacy ITX readmission chain을 거부한다", async () => {
  const value = await inputs();
  const evidence = JSON.parse(value.topologyEvidenceBytes);
  evidence.readmissions = [{ itxSubgraph: { edgesSha256: "0".repeat(64) } }];

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      topologyEvidenceBytes: Buffer.from(`${JSON.stringify(evidence)}\n`),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
});

test("current topology evidence 경로는 topology pack gzip이 파손되면 fail closed 한다", async () => {
  const value = await inputs({ withTopologyEvidence: true });
  const { contractBytes, sourceBytes } = consistentFreshnessInputs(value);

  assert.throws(
    () => buildServerTimetableSnapshot({
      ...value,
      contractBytes,
      sourceBytes,
      canonicalPackGzipBytes: Buffer.from("corrupt-not-a-gzip"),
      buildNow,
    }),
    /canonical topology pack identity mismatch/,
  );
});

test("동일 current station-catalog와 topology evidence 입력은 byte-identical snapshot을 낸다", async () => {
  const value = await inputs({ withTopologyEvidence: true });
  const { contractBytes, sourceBytes, topologyEvidenceBytes } = consistentFreshnessInputs(value);

  const first = buildServerTimetableSnapshot({
    ...value, contractBytes, sourceBytes, topologyEvidenceBytes, buildNow,
  });
  const second = buildServerTimetableSnapshot({
    ...value, contractBytes, sourceBytes, topologyEvidenceBytes, buildNow,
  });

  assert.equal(first.sql, second.sql);
  assert.equal(first.evidence.snapshotSha256, second.evidence.snapshotSha256);
  assert.deepEqual(first.evidence.stationCatalogPackIdentity, second.evidence.stationCatalogPackIdentity);
  assert.ok(first.evidence.canonicalPackLineage.topologyEvidenceSha256);
});

test("CLI는 source와 contract station-catalog identity 불일치를 fail closed 한다", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "server-timetable-snapshot-freshness-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const value = await inputs();
  const { contract, sourceBytes } = staleCanonicalInputs(value);
  const staleContractPath = path.join(directory, "contract.json");
  const staleSourcePath = path.join(directory, "source.json");
  const completenessPath = path.join(directory, "completeness.json");
  const topologyEvidenceFilePath = path.join(directory, "topology-evidence.json");
  const baselineFilePath = path.join(directory, "subway-baseline.sql.gz");
  const topologyPackFilePath = path.join(directory, "capital.sqlite.gz");
  contract.sourceTimetableArtifact.artifactPath = staleSourcePath;
  contract.sourceTimetableArtifact.completenessEvidencePath = completenessPath;
  await Promise.all([
    writeFile(staleContractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(staleSourcePath, sourceBytes),
    writeFile(completenessPath, value.completenessBytes),
    writeFile(topologyEvidenceFilePath, value.topologyEvidenceBytes),
    writeFile(baselineFilePath, value.baselineGzipBytes),
    writeFile(topologyPackFilePath, value.canonicalPackGzipBytes),
  ]);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-server-timetable-snapshot.mjs",
      "--baseline", baselineFilePath,
      "--contract", staleContractPath,
      "--topology-pack", topologyPackFilePath,
      "--topology-evidence", topologyEvidenceFilePath,
      "--output", path.join(directory, "snapshot.sql.gz"),
      "--evidence", path.join(directory, "evidence.json"),
      "--runtime-evidence", path.join(directory, "runtime-evidence.json"),
    ], {
      cwd: root,
      env: { ...process.env, EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW: buildNow.toISOString() },
    }),
    /station catalog identity mismatch/,
  );
});

test("CLI는 topology evidence 생략 옵션을 명시적으로 거부한다", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-server-timetable-snapshot.mjs",
      "--without-topology-evidence",
    ], {
      cwd: root,
      env: { ...process.env, EASYSUBWAY_TIMETABLE_SNAPSHOT_BUILD_NOW: buildNow.toISOString() },
    }),
    /invalid argument: --without-topology-evidence/,
  );
});
