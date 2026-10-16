import { gzipSync } from "node:zlib";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
// 정준 직렬화는 검증 대상 구현을 그대로 쓴다. 테스트가 규칙을 복제하면 3언어
// 분열(이슈 #2528)을 구조적으로 검출할 수 없다.
import { canonicalJson, validateManifest, withoutSignature } from "./lib/manifest-validation.mjs";
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
import { execFileAsync, sha256 } from "./test-fixtures/datapack-tools-support.mjs";
import { rsaSha256Signature } from "./test-fixtures/datapack-tools-signing.mjs";
import {
  productionEnv,
  cloneCurrentProductionArtifact,
  representativeRouteRegressionPayload,
} from "./test-fixtures/datapack-tools-production-build.mjs";

const root = path.resolve(import.meta.dirname, "../..");
stageLocalMobileFixture({ repositoryRoot: root });

function currentProductionValidationArgs({ output, routeCoverageAuthority }) {
  return [
    "--manifest", path.join(output, "current.json"),
    "--root", output,
    "--require-production",
    "--server-route-coverage-evidence", routeCoverageAuthority,
    "--server-route-coverage-provenance", path.join(output, "current.provenance.json"),
  ];
}

async function mutateCurrentProductionManifest(artifact, mutate) {
  const manifestPath = path.join(artifact.output, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await mutate(manifest);
  resignProductionManifest(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

async function mutateCurrentProductionSqlite(artifact, mutate) {
  const manifestPath = path.join(artifact.output, "current.json");
  const provenancePath = path.join(artifact.output, "current.provenance.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pack = manifest.packs[0];
  const gzipPath = path.join(artifact.output, "catalog", `${pack.id}-v${pack.version}.sqlite.gz`);
  const sqlitePath = gzipPath.replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath);
  try {
    await mutate({ database, manifest, pack });
  } finally {
    database.close();
  }
  const sqliteBytes = await readFile(sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes);
  await writeFile(gzipPath, gzipBytes);
  pack.sizeBytes = gzipBytes.length;
  pack.sha256 = sha256(gzipBytes);
  pack.sqliteSha256 = sha256(sqliteBytes);
  resignProductionManifest(manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.manifestSha256 = sha256(manifestBytes);
  provenance.packs.find(({ id, version }) => id === pack.id && version === pack.version).sqliteSha256 = pack.sqliteSha256;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}

function qualityRatio(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function materializeCurrentAvailableEntryEvidence(database, pack, {
  sourceSupportsAccessibility = true,
  strictFacilityEvidence = false,
  stationStatusProbeEvidence = false,
  pathwayEdgeType = null,
} = {}) {
  const source = stationStatusProbeEvidence
    ? pack.sourceInventory.find(({ id }) => id === "seoul-metro-accessibility")
    : pack.sourceInventory.find(({ coverageScope }) => {
    const domains = coverageScope?.sourceDomains ?? [];
    return sourceSupportsAccessibility
      ? domains.includes("accessibility_facilities")
      : domains.includes("station_line_membership") && !domains.includes("accessibility_facilities");
    });
  assert.ok(source, "current production artifact requires the selected source domain");
  // #873: 전국 승강장 기준 팩에는 역 단위 ENTRY/EXIT 간선이 없다. validate-datapack에 남아 있는 legacy ENTRY/EXIT
  // 검증 규칙(PR-D(#866)에서 정리)을 확인하려고 exact UNKNOWN legacy ENTRY 간선 하나를 넣은 뒤 같은 변조를 한다.
  const legacyLine = database.prepare("SELECT station_id, line_id FROM station_lines ORDER BY station_id, line_id LIMIT 1").get();
  assert.ok(legacyLine, "current production artifact requires one station-line");
  database.prepare(`
    INSERT INTO network_edges (id, from_node_id, to_node_id, edge_type)
    VALUES (?, ?, ?, 'ENTRY')
  `).run(`entry-${legacyLine.station_id}-${legacyLine.line_id}`, legacyLine.station_id, `${legacyLine.station_id}:${legacyLine.line_id}`);
  const edge = database.prepare(`
    SELECT id, to_node_id
    FROM network_edges
    WHERE edge_type = 'ENTRY' AND accessibility_status = 'UNKNOWN'
    ORDER BY id
    LIMIT 1
  `).get();
  assert.ok(edge, "current production artifact requires one UNKNOWN ENTRY edge");
  const [stationId, lineId] = edge.to_node_id.split(":");
  assert.ok(stationId && lineId, "current production ENTRY requires a canonical station-line endpoint");
  const verifiedAt = Math.floor(Date.parse(source.updatedAt) / 1_000);
  assert.ok(Number.isInteger(verifiedAt) && verifiedAt > 0, "current source requires updatedAt");
  const snapshotId = `${source.id}-test-current-snapshot`;
  const update = database.prepare(`
    UPDATE network_edges
    SET accessibility_status = 'AVAILABLE', stair_access_state = 'STEP_FREE',
        includes_stairs = 0, reliability_score = 100, source_id = ?, source_snapshot_id = ?,
        provider_record_hash = ?, provenance_kind = 'OFFICIAL_SOURCE', verification_status = 'VERIFIED',
        last_verified_at = ?, evidence_hash = ?
    WHERE id = ?
  `).run(
    source.id,
    snapshotId,
    sha256(`provider:${edge.id}:${source.id}`),
    verifiedAt,
    sha256(`evidence:${edge.id}:${source.id}:${source.updatedAt}`),
    edge.id,
  );
  assert.equal(update.changes, 1, "current production artifact requires one mutable ENTRY edge");
  if (strictFacilityEvidence) {
    database.prepare(`
      INSERT OR REPLACE INTO station_facility_evidence (
        station_id, line_id, facility_type, evidence_kind, source_id, source_snapshot_id,
        provider_record_hash, evidence_hash, provenance_kind, installation_status,
        operational_status, status_meaning, confidence, verified_at, retrieved_at,
        strict_route_eligible, strict_route_eligible_reason
      ) VALUES (?, ?, 'ELEVATOR', 'EXISTS', ?, ?, ?, ?, 'OFFICIAL_SOURCE', 'INSTALLED',
                'AVAILABLE', 'OPERATOR_CONFIRMED', 100, ?, ?, 1, 'FACILITY_OPERATION_VERIFIED')
    `).run(
      stationId,
      lineId,
      source.id,
      snapshotId,
      sha256(`provider:${stationId}:${lineId}:ELEVATOR:${source.id}`),
      sha256(`evidence:${stationId}:${lineId}:ELEVATOR:${source.id}:${source.updatedAt}`),
      verifiedAt,
      verifiedAt,
    );
  }

  if (stationStatusProbeEvidence) {
    database.prepare(`
      INSERT OR REPLACE INTO station_facility_evidence (
        station_id, line_id, facility_type, evidence_kind, source_id, source_snapshot_id,
        provider_record_hash, evidence_hash, provenance_kind, installation_status,
        operational_status, status_meaning, confidence, verified_at, retrieved_at,
        strict_route_eligible, strict_route_eligible_reason
      ) VALUES (?, ?, 'ACCESSIBILITY_STATUS_PROBE', 'EXISTS', ?, ?, ?, ?, 'OFFICIAL_SOURCE',
                'INSTALLED', 'AVAILABLE', 'REALTIME_OPERATION', 100, ?, ?, 0,
                'STATUS_PROBE_NOT_ROUTE_EVIDENCE')
    `).run(
      stationId,
      lineId,
      source.id,
      snapshotId,
      sha256(`provider:${stationId}:${lineId}:STATUS_PROBE:${source.id}`),
      sha256(`evidence:${stationId}:${lineId}:STATUS_PROBE:${source.id}:${source.updatedAt}`),
      verifiedAt,
      verifiedAt,
    );
  }

  if (pathwayEdgeType !== null) {
    const surfaceNodeId = `${edge.id}:surface`;
    const platformNodeId = `${edge.id}:platform`;
    database.prepare(`
      INSERT INTO station_pathway_nodes (id, station_id, line_id, node_type, label)
      VALUES (?, ?, NULL, 'ENTRANCE', '테스트 출입구'), (?, ?, ?, 'PLATFORM', '테스트 승강장')
    `).run(surfaceNodeId, stationId, platformNodeId, stationId, lineId);
    database.prepare(`
      INSERT INTO station_pathway_edges (
        id, from_node_id, to_node_id, edge_type, duration_seconds, distance_meters,
        bidirectional, includes_stairs, reliability_score, accessibility_status,
        source_id, source_snapshot_id, provider_record_hash, provenance_kind,
        verification_status, last_verified_at, evidence_hash, instruction
      ) VALUES (?, ?, ?, ?, 60, 20, 1, ?, 100, 'AVAILABLE', ?, ?, ?, 'OFFICIAL_SOURCE',
                'VERIFIED', ?, ?, '테스트 접근성 이동 경로')
    `).run(
      `${edge.id}:pathway`,
      surfaceNodeId,
      platformNodeId,
      pathwayEdgeType,
      pathwayEdgeType === "STAIR" ? 1 : 0,
      source.id,
      snapshotId,
      sha256(`provider:${edge.id}:pathway:${source.id}`),
      verifiedAt,
      sha256(`evidence:${edge.id}:pathway:${source.id}:${source.updatedAt}`),
    );
  }

  const edgeCount = database.prepare("SELECT COUNT(*) AS count FROM network_edges").get().count;
  const unknownCount = database.prepare(`
    SELECT COUNT(*) AS count FROM network_edges WHERE accessibility_status = 'UNKNOWN'
  `).get().count;
  const unknownAccessibilityRatio = qualityRatio(unknownCount, edgeCount);
  pack.regionalQualityMetrics.unknownAccessibilityRatio = unknownAccessibilityRatio;
  pack.regionalQualityMetrics.unknownEdgeRatioByProfile = {
    wheelchair: unknownAccessibilityRatio,
    stroller: unknownAccessibilityRatio,
    lowMobility: unknownAccessibilityRatio,
  };
  if (strictFacilityEvidence || stationStatusProbeEvidence) {
    const evidence = database.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN strict_route_eligible = 1 THEN 1 ELSE 0 END) AS strict_count,
             SUM(CASE WHEN operational_status != '' AND UPPER(operational_status) != 'UNKNOWN' THEN 1 ELSE 0 END) AS operational_known_count,
             SUM(CASE WHEN verified_at > 0 OR retrieved_at > 0 THEN 1 ELSE 0 END) AS fresh_count
      FROM station_facility_evidence
    `).get();
    const evidenceKeyCount = database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT DISTINCT station_id, line_id, facility_type FROM station_facility_evidence
      )
    `).get().count;
    const stationLineCount = database.prepare("SELECT COUNT(*) AS count FROM station_lines").get().count;
    const facilityTypeCount = database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT facility_type AS type FROM station_facility_evidence
        UNION
        SELECT type FROM facilities
      )
    `).get().count;
    pack.regionalQualityMetrics.requiredFacilityEvidenceCoverageRatio = qualityRatio(
      evidenceKeyCount,
      stationLineCount * facilityTypeCount,
    );
    pack.regionalQualityMetrics.strictRouteEligibleFacilityRatio = qualityRatio(evidence.strict_count, evidence.total);
    pack.regionalQualityMetrics.operationalKnownRatio = qualityRatio(evidence.operational_known_count, evidence.total);
    pack.regionalQualityMetrics.freshnessValidRatio = qualityRatio(evidence.fresh_count, evidence.total);
  }
  if (pathwayEdgeType !== null) {
    const pathways = database.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN provenance_kind IN ('FIELD_SURVEY', 'OPERATOR_CONFIRMED') THEN 1 ELSE 0 END) AS field_verified_count
      FROM station_pathway_edges
    `).get();
    pack.regionalQualityMetrics.fieldVerifiedPathwayRatio = qualityRatio(
      pathways.field_verified_count,
      pathways.total,
    );
  }
  return edge.id;
}

// #918: 원천이 00:00~02:59로 적은 시각은 전날 운행일의 24시 이후 초로 SQLite에 싣는다(인천만이 아니라 모든 기관).
async function buildFixtureWithStopTimes(name, times) {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-service-day-${name}-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const rows = fixture.packs[0].transitStopTimes
    .filter(({ tripId }) => tripId === "trip-seoul-4-local-0805")
    .sort((left, right) => left.stopSequence - right.stopSequence);
  assert.equal(rows.length, times.length);
  rows.forEach((row, index) => Object.assign(row, times[index]));
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );
  return outputDir;
}

test("#918 수도권 4호선 trip의 00시대 정차도 데이터팩 SQLite에는 86400초 이상으로 싣고 검증을 통과한다", async (context) => {
  const outputDir = await buildFixtureWithStopTimes("after-midnight", [
    { arrivalSeconds: 600, departureSeconds: 600 },
    { arrivalSeconds: 1_320, departureSeconds: 1_440 },
  ]);
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const database = new DatabaseSync(path.join(outputDir, "catalog", "capital-v1.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(database.prepare(`
      SELECT stop_sequence, arrival_seconds, departure_seconds FROM transit_stop_times
      WHERE trip_id = 'trip-seoul-4-local-0805' ORDER BY stop_sequence
    `).all().map((row) => ({ ...row })), [
      { stop_sequence: 1, arrival_seconds: 87_000, departure_seconds: 87_000 },
      { stop_sequence: 2, arrival_seconds: 87_720, departure_seconds: 87_840 },
    ]);
  } finally {
    database.close();
  }
  await execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs", "--manifest", path.join(outputDir, "current.json"), "--root", outputDir,
  ], { cwd: root, env: productionEnv });
});

// #918 불변식: 컴파일된 SQLite에 03:00(운행일 경계) 전 정차 시각이 남으면 어느 기관이든 팩을 거부한다.
// 빌드는 이미 변환하므로, 다른 기록 경로를 흉내 내 SQLite를 직접 0시대로 되돌린다(4호선, 인천 아님).
test("#918 데이터팩 검증기는 운행일 경계(03:00) 전 정차 시각이 남은 비인천 trip을 거부한다", async (context) => {
  const output = await buildFixtureWithStopTimes("pre-boundary", [
    { arrivalSeconds: 600, departureSeconds: 600 },
    { arrivalSeconds: 1_320, departureSeconds: 1_440 },
  ]);
  context.after(() => rm(output, { recursive: true, force: true }));
  const manifestPath = path.join(output, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(output, "catalog", "capital-v1.sqlite");
  const database = new DatabaseSync(sqlitePath);
  try {
    const update = database.prepare(`
      UPDATE transit_stop_times
      SET arrival_seconds = arrival_seconds - 86400, departure_seconds = departure_seconds - 86400
      WHERE trip_id = 'trip-seoul-4-local-0805'
    `).run();
    assert.equal(update.changes, 2);
  } finally {
    database.close();
  }
  const sqliteBytes = await readFile(sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes);
  await writeFile(`${sqlitePath}.gz`, gzipBytes);
  const pack = manifest.packs[0];
  Object.assign(pack, { sizeBytes: gzipBytes.length, sha256: sha256(gzipBytes), sqliteSha256: sha256(sqliteBytes) });
  // fixture 팩 서명은 payload의 sha256이다(production 팩만 RSA 서명).
  const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
  pack.signature.value = sha256(Buffer.from(fixturePayload));
  pack.representativeRouteRegressionSignature.value = sha256(Buffer.from(
    `${fixturePayload}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`));
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  const provenancePath = path.join(output, "current.provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.manifestSha256 = sha256(manifestBytes);
  provenance.packs.find(({ id }) => id === pack.id).sqliteSha256 = pack.sqliteSha256;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-datapack.mjs", "--manifest", path.join(output, "current.json"), "--root", output,
    ], { cwd: root, env: productionEnv }),
    /transit_stop_times must not precede the 03:00 service-day boundary: trip-seoul-4-local-0805/,
  );
});

test("#918 운행일 경계(03:00)를 가로지르는 trip은 변환 뒤 시각이 역행해 검증기가 거부한다", async (context) => {
  const outputDir = await buildFixtureWithStopTimes("straddle", [
    { arrivalSeconds: 10_500, departureSeconds: 10_500 },
    { arrivalSeconds: 11_100, departureSeconds: 11_220 },
  ]);
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-datapack.mjs", "--manifest", path.join(outputDir, "current.json"), "--root", outputDir,
    ], { cwd: root, env: productionEnv }),
    /transit_stop_times must be monotonic: trip-seoul-4-local-0805/,
  );
});

test("데이터팩 검증기는 근거 없는 시설 operationalStatus AVAILABLE을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database }) => {
    const facility = database.prepare("SELECT id FROM facilities ORDER BY id LIMIT 1").get();
    assert.ok(facility, "current production artifact requires one facility");
    const update = database.prepare(`
      UPDATE facilities
      SET status = 'UNKNOWN', operational_status = 'AVAILABLE', status_meaning = 'OFFICIAL_SOURCE'
      WHERE id = ?
    `).run(facility.id);
    assert.equal(update.changes, 1, "current production artifact requires one mutable facility");
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /facilities positive status requires verified operation evidence/,
  );
});

test("데이터팩 검증기는 UNKNOWN 운행상태 시설의 strict route eligibility를 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    const evidence = database.prepare(`
      SELECT station_id, line_id, facility_type
      FROM station_facility_evidence
      WHERE evidence_kind = 'EXISTS' AND facility_type != 'ACCESSIBILITY_STATUS_PROBE'
      ORDER BY station_id, line_id, facility_type
      LIMIT 1
    `).get();
    assert.ok(evidence, "current production artifact requires one existing facility evidence row");
    const update = database.prepare(`
      UPDATE station_facility_evidence
      SET operational_status = 'UNKNOWN', status_meaning = 'STATIC_LOCATION',
          strict_route_eligible = 1, strict_route_eligible_reason = 'FACILITY_EXISTS_AND_PROVENANCE_VERIFIED'
      WHERE station_id = ? AND line_id = ? AND facility_type = ?
    `).run(evidence.station_id, evidence.line_id, evidence.facility_type);
    assert.equal(update.changes, 1, "current production artifact requires one mutable evidence row");
    const counts = database.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN strict_route_eligible = 1 THEN 1 ELSE 0 END) AS strict_count,
             SUM(CASE WHEN operational_status != '' AND UPPER(operational_status) != 'UNKNOWN' THEN 1 ELSE 0 END) AS known
      FROM station_facility_evidence
    `).get();
    pack.regionalQualityMetrics.strictRouteEligibleFacilityRatio = qualityRatio(counts.strict_count, counts.total);
    pack.regionalQualityMetrics.operationalKnownRatio = qualityRatio(counts.known, counts.total);
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /station_facility_evidence strict route eligibility requires available operation status/,
  );
});

test("데이터팩 검증기는 production verified edge coverage report를 출력한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      ...currentProductionValidationArgs(artifact),
    ],
    { cwd: root, env: productionEnv },
  );
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(report.type, "datapack_verified_edge_coverage");
  // #873: 역 단위 ENTRY/EXIT는 coverage 분모가 아니다. 환승 coverage만 보고한다.
  assert.equal(Object.hasOwn(report, "entry"), false);
  assert.equal(Object.hasOwn(report, "exit"), false);
  assert.equal(report.transfer.missingCount, 30);
  assert.equal(report.generatedConnectorGapCount, 30);
});

test("#873 데이터팩 검증기는 current production 팩에서 환승 간선이 authority와 어긋나면 TRANSFER coverage gap으로 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    const result = database.prepare(`
      DELETE FROM network_edges
      WHERE id = (SELECT id FROM network_edges WHERE edge_type = 'IN_STATION_TRANSFER' ORDER BY id LIMIT 1)
    `).run();
    assert.equal(result.changes, 1, "current production artifact requires one IN_STATION_TRANSFER edge");
    pack.regionalQualityMetrics.edgeCount -= 1;
  });
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    ...currentProductionValidationArgs(artifact),
  ], { cwd: root, env: productionEnv }), /verified TRANSFER coverage gap: 30\/30/);
});

test("데이터팩 검증기는 UNKNOWN accessibility edge를 strict coverage에서 제외한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  const { stdout } = await execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    ...currentProductionValidationArgs(artifact),
  ], { cwd: root, env: productionEnv });
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(report.transfer.missingCount, 30);
  assert.deepEqual(report.unverifiedAccessibilityCoverageEdges, []);
});

test("데이터팩 검증기는 current production RIDE의 비현실적 속도를 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database }) => {
    const result = database.prepare(`
      UPDATE network_edges
      SET distance_meters = 18600, duration_seconds = 420
      WHERE id = (SELECT id FROM network_edges WHERE edge_type = 'RIDE' ORDER BY id LIMIT 1)
    `).run();
    assert.equal(result.changes, 1, "current production artifact requires one RIDE edge");
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /network_edges ride speed is outside production bounds/,
  );
});

test("데이터팩 검증기는 strict coverage gap 뒤의 production provenance 오류를 숨기지 않는다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    const station = database.prepare("SELECT id FROM stations ORDER BY id LIMIT 1").get();
    const sourceId = pack.sourceInventory[0].id;
    assert.ok(station && sourceId, "current production artifact requires a station and source inventory");
    database.prepare("INSERT INTO internal_route_nodes (id, station_id, label, node_type) VALUES (?, ?, ?, ?)")
      .run("test-production-internal-from", station.id, "테스트 내부 출발", "CONCOURSE");
    database.prepare("INSERT INTO internal_route_nodes (id, station_id, label, node_type) VALUES (?, ?, ?, ?)")
      .run("test-production-internal-to", station.id, "테스트 내부 도착", "EXIT");
    database.prepare(`
      INSERT INTO internal_route_edges (
        id, from_node_id, to_node_id, edge_type, distance_meters, duration_seconds,
        includes_stairs, requires_elevator, requires_escalator, slope_level, width_level,
        reliability_score, accessibility_status, source_id, source_snapshot_id,
        provider_record_hash, provenance_kind, verification_status, last_verified_at,
        evidence_hash, instruction
      ) VALUES (?, ?, ?, 'WALK', 1, 1, 0, 0, 0, 1, 1, 100, 'AVAILABLE', ?, ?, ?, 'OFFICIAL_SOURCE', 'PENDING_ADMIN_REVIEW', 1781568000, ?, ?)
    `).run(
      "test-production-internal-pending",
      "test-production-internal-from",
      "test-production-internal-to",
      sourceId,
      "test-production-internal-snapshot",
      sha256("test-production-internal-provider"),
      sha256("test-production-internal-evidence"),
      "테스트 내부 이동",
    );
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /internal_route_edges verification_status must be VERIFIED: test-production-internal-pending/,
  );
});

test("데이터팩 검증기는 production pathway edge 증거 누락을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    const station = database.prepare("SELECT id FROM stations ORDER BY id LIMIT 1").get();
    const sourceId = pack.sourceInventory[0].id;
    assert.ok(station && sourceId, "current production artifact requires a station and source inventory");
    database.prepare(`
      INSERT INTO station_pathway_nodes (id, station_id, line_id, node_type, label, level)
      VALUES (?, ?, NULL, 'ENTRANCE', ?, ''), (?, ?, NULL, 'EXIT', ?, '')
    `).run(
      "test-production-pathway-from", station.id, "테스트 출입구",
      "test-production-pathway-to", station.id, "테스트 출구",
    );
    database.prepare(`
      INSERT INTO station_pathway_edges (
        id, from_node_id, to_node_id, edge_type, duration_seconds, distance_meters,
        bidirectional, includes_stairs, requires_elevator, requires_escalator,
        accessibility_status, source_id, source_snapshot_id, provider_record_hash,
        provenance_kind, verification_status, last_verified_at, evidence_hash, instruction
      ) VALUES (?, ?, ?, 'WALK', 1, 1, 1, 0, 0, 0, 'AVAILABLE', ?, ?, '', 'OFFICIAL_SOURCE', 'VERIFIED', 1781568000, ?, ?)
    `).run(
      "test-production-pathway-missing-provider",
      "test-production-pathway-from",
      "test-production-pathway-to",
      sourceId,
      "test-production-pathway-snapshot",
      sha256("test-production-pathway-evidence"),
      "테스트 경로",
    );
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /station_pathway_edges\.test-production-pathway-missing-provider\.provider_record_hash/,
  );
});

test("데이터팩 검증기는 검증된 상태 accessibility edge의 미검증 provenance를 거부한다", async (context) => {
  // #1996: 검증된 상태(AVAILABLE/UNDER_MAINTENANCE/NO_OFFICIAL_FEED) edge는 provenance 요건(VERIFIED 등)을
  // 여전히 강제한다. verification_status가 PENDING이면 거부한다. (UNKNOWN은 provenance 후보가 아니라 coverage
  // gap 경로로 차단된다.)
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    const source = pack.sourceInventory.find(({ coverageScope }) => (
      coverageScope?.sourceDomains?.includes("accessibility_facilities")
    ));
    assert.ok(source, "current production artifact requires an accessibility facility source");
    const result = database.prepare(`
      UPDATE network_edges
      SET accessibility_status = 'AVAILABLE', stair_access_state = 'STEP_FREE',
          verification_status = 'PENDING_ADMIN_REVIEW', source_id = ?, source_snapshot_id = ?,
          provider_record_hash = ?, provenance_kind = 'OFFICIAL_SOURCE',
          last_verified_at = 1781568000, evidence_hash = ?
      WHERE id = (SELECT id FROM network_edges WHERE edge_type = 'IN_STATION_TRANSFER' ORDER BY id LIMIT 1)
    `).run(
      source.id,
      "test-production-entry-snapshot",
      sha256("test-production-entry-provider"),
      sha256("test-production-entry-evidence"),
    );
    // #873: 전국 승강장 기준 팩에는 ENTRY가 없으므로 같은 접근성 간선 규칙을 역 안 환승 간선으로 확인한다.
    assert.equal(result.changes, 1, "current production artifact requires one IN_STATION_TRANSFER edge");
    pack.regionalQualityMetrics.unknownAccessibilityRatio = 0.9996;
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /network_edges accessibility edge verification_status must be VERIFIED:/,
  );
});

test("데이터팩 검증기는 출처 없는 production positive edge를 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database }) => {
    const result = database.prepare(`
      UPDATE network_edges
      SET source_id = ''
      WHERE id = (SELECT id FROM network_edges WHERE edge_type = 'RIDE' ORDER BY id LIMIT 1)
    `).run();
    assert.equal(result.changes, 1, "current production artifact requires one RIDE edge");
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /network_edges\..*\.source_id must be a non-empty string/,
  );
});

test("데이터팩 검증기는 exact UNKNOWN edge만 provenance 예외로 허용한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    ...currentProductionValidationArgs(artifact),
  ], { cwd: root, env: productionEnv });
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    const sourceId = pack.sourceInventory[0].id;
    const result = database.prepare(`
      UPDATE network_edges
      SET source_id = ?
      WHERE id = (
        SELECT id FROM network_edges
        WHERE edge_type = 'IN_STATION_TRANSFER' AND source_id = '' AND source_snapshot_id = ''
          AND provider_record_hash = '' AND provenance_kind = 'UNKNOWN'
          AND verification_status = 'UNKNOWN' AND evidence_hash = ''
        ORDER BY id LIMIT 1
      )
    `).run(sourceId);
    // #873: 전국 승강장 기준 팩에는 ENTRY가 없으므로 exact UNKNOWN 예외를 역 안 환승 간선으로 확인한다.
    assert.equal(result.changes, 1, "current production artifact requires one exact UNKNOWN transfer edge");
  });
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    ...currentProductionValidationArgs(artifact),
  ], { cwd: root, env: productionEnv }), /source_snapshot_id must be a non-empty string/);
});

test("데이터팩 검증기는 production manifest의 최소 row 기준 누락을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionManifest(artifact, (manifest) => {
    delete manifest.packs[0].minimumTableRows;
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /nationwide@1 production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence/,
  );
});

test("데이터팩 검증기는 production manifest의 0 row 기준을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionManifest(artifact, (manifest) => {
    manifest.packs[0].minimumTableRows = {
      stations: 0,
      station_lines: 0,
      network_edges: 0,
      facilities: 0,
      station_facility_evidence: 0,
    };
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /nationwide@1 production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence/,
  );
});

test("데이터팩 검증기는 production sourceInventory coverageScope 누락을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionManifest(artifact, (manifest) => {
    delete manifest.packs[0].sourceInventory[0].coverageScope;
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /nationwide@1 production sourceInventory.coverageScope must be an object/,
  );
});

test("데이터팩 검증기는 sourceInventory coverageScope.lineIds 중복을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionManifest(artifact, (manifest) => {
    const source = manifest.packs[0].sourceInventory.find(({ coverageScope }) => coverageScope?.lineIds?.length);
    assert.ok(source, "current production artifact requires a line-scoped source");
    source.coverageScope.lineIds = [source.coverageScope.lineIds[0], source.coverageScope.lineIds[0]];
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory\.coverageScope\.lineIds must not contain duplicates/,
  );
});

test("데이터팩 검증기는 production pack의 realtime payload table을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database }) => {
    database.exec(`
      CREATE TABLE realtime_station_arrivals (
        provider_id TEXT NOT NULL,
        station_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    database.exec("INSERT INTO realtime_station_arrivals VALUES ('topis', 'station-sadang', '{}')");
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /nationwide@1 realtime payload table is not allowed in production datapack: realtime_station_arrivals/,
  );
});

test("데이터팩 검증기는 production HTTPS URL과 staged artifact path 불일치를 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  const outputDir = artifact.output;
  const manifestPath = path.join(outputDir, "current.json");
  const pristineManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const originalUrl = pristineManifest.packs[0].url;
  assert.match(originalUrl, /^https:\/\//);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      ...currentProductionValidationArgs(artifact),
    ],
    { cwd: root, env: productionEnv },
  );

  const validateManifest = () => execFileAsync(
    process.execPath,
    ["tools/datapack/validate-datapack.mjs", "--manifest", manifestPath, "--root", outputDir],
    { cwd: root, env: productionEnv },
  );
  const expectPristineBoundaryRejection = async ({ mutate, expected, resign = true }) => {
    const manifest = structuredClone(pristineManifest);
    mutate(manifest);
    if (resign) resignProductionManifest(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(validateManifest(), expected);
  };

  await expectPristineBoundaryRejection({
    mutate: (manifest) => {
      manifest.packs[0].url = new URL(originalUrl).toString().replace(new URL(originalUrl).host, "mirror.easysubway.example");
    },
    expected: /manifest signature mismatch/,
    resign: false,
  });

  const sqlitePath = path.join(outputDir, "catalog", `${pristineManifest.packs[0].id}-v${pristineManifest.packs[0].version}.sqlite`);
  const packFile = `${pristineManifest.packs[0].id}-v${pristineManifest.packs[0].version}.sqlite.gz`;
  const database = new DatabaseSync(sqlitePath);
  let ride;
  try {
    ride = database.prepare(`
      SELECT id, from_node_id, to_node_id
      FROM network_edges WHERE edge_type = 'RIDE' ORDER BY id LIMIT 1
    `).get();
  } finally {
    database.close();
  }
  assert.ok(ride, "current production artifact requires one RIDE edge for signature payload binding");
  await expectPristineBoundaryRejection({
    mutate: (manifest) => {
      manifest.packs[0].representativeRouteRegressions = [{
        id: "test-representative-route", pattern: "DIRECT", fromNodeId: ride.from_node_id,
        toNodeId: ride.to_node_id, requiredEdgeIds: [ride.id],
      }];
      manifest.packs[0].routeRegressionScope = {
        mode: "DIRECT_ONLY", excludedPatterns: ["TRANSFER", "MULTI_TRANSFER", "LOOP_BRANCH", "EXPRESS_LOCAL"],
        claim: "test signature binding",
      };
      resignProductionManifest(manifest);
      manifest.packs[0].representativeRouteRegressionSignature.value =
        pristineManifest.packs[0].representativeRouteRegressionSignature.value;
      resignManifestEnvelopeOnly(manifest);
    },
    expected: /nationwide@1 representativeRouteRegressionSignature mismatch/,
    resign: false,
  });

  await expectPristineBoundaryRejection({
    mutate: (manifest) => { manifest.packs[0].url = `https://cdn.easysubway.example/packs/${packFile}`; },
    expected: new RegExp(`pack.url absolute HTTPS URL path must end with catalog/${packFile.replaceAll(".", "\\.")}`),
  });
  for (const url of [
    `https://easysubway.local/easysubway-datapacks/catalog/${packFile}`,
    `https://localhost./easysubway-datapacks/catalog/${packFile}`,
    `https://[::1]/easysubway-datapacks/catalog/${packFile}`,
    `https://[::ffff:127.0.0.1]/easysubway-datapacks/catalog/${packFile}`,
    `https://[2001:db8::1]/easysubway-datapacks/catalog/${packFile}`,
    `https://[::127.0.0.1]/easysubway-datapacks/catalog/${packFile}`,
  ]) {
    await expectPristineBoundaryRejection({
      mutate: (manifest) => { manifest.packs[0].url = url; },
      expected: /production pack url must not use a local placeholder host/,
    });
  }
  await expectPristineBoundaryRejection({
    mutate: (manifest) => { manifest.packs[0].sourceInventory[0].url = "https://"; },
    expected: /production sourceInventory.url must be HTTPS/,
  });
  for (const url of [
    "https://easysubway.local/fixtures/catalog-fixture.json",
    "https://easysubway.local./fixtures/catalog-fixture.json",
    "https://192.168.0.2/fixtures/catalog-fixture.json",
    "https://[::10.0.0.1]/fixtures/catalog-fixture.json",
    "https://[ff02::1]/fixtures/catalog-fixture.json",
  ]) {
    await expectPristineBoundaryRejection({
      mutate: (manifest) => { manifest.packs[0].sourceInventory[0].url = url; },
      expected: /production sourceInventory.url must not use a local placeholder host/,
    });
  }
});

test("데이터팩 검증기는 AVAILABLE accessibility edge의 station-line source 우회를 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    materializeCurrentAvailableEntryEvidence(database, pack, { sourceSupportsAccessibility: false });
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires accessibility_facilities source/,
  );
});

test("데이터팩 검증기는 AVAILABLE accessibility edge의 station-line operational evidence 누락을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    materializeCurrentAvailableEntryEvidence(database, pack);
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires strict-eligible operational facility evidence/,
  );
});

test("station status probe는 production strict route evidence로 승격되지 않는다 (#2609)", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    materializeCurrentAvailableEntryEvidence(database, pack, {
      stationStatusProbeEvidence: true,
      pathwayEdgeType: "WALK",
    });
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires strict-eligible operational facility evidence:/,
  );
});

test("데이터팩 검증기는 AVAILABLE accessibility edge의 승인된 이동 경로 누락을 거부한다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    materializeCurrentAvailableEntryEvidence(database, pack, { strictFacilityEvidence: true });
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires approved movement pathway/,
  );
});

test("데이터팩 검증기는 STAIR pathway를 승인된 접근성 이동 경로로 인정하지 않는다", async (context) => {
  const artifact = await cloneCurrentProductionArtifact(context);
  await mutateCurrentProductionSqlite(artifact, ({ database, pack }) => {
    materializeCurrentAvailableEntryEvidence(database, pack, {
      strictFacilityEvidence: true,
      pathwayEdgeType: "STAIR",
    });
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        ...currentProductionValidationArgs(artifact),
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires approved movement pathway/,
  );
});

function resignProductionManifest(manifest) {
  const pack = manifest.packs[0];
  const packUrl = new URL(pack.url).toString();
  const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
  pack.signature.value = rsaSha256Signature(`${fixturePayload}:${packUrl}`);
  pack.representativeRouteRegressionSignature.value = rsaSha256Signature(
    `${fixturePayload}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}:${packUrl}`,
  );
  if (manifest.signature) {
    manifest.signature.value = rsaSha256Signature(canonicalJson(withoutSignature(manifest)));
  }
}

function resignManifestEnvelopeOnly(manifest) {
  if (manifest.signature) {
    manifest.signature.value = rsaSha256Signature(canonicalJson(withoutSignature(manifest)));
  }
}
