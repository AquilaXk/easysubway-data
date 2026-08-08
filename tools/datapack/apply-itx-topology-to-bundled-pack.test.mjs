import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  admittedTopologySource,
  applyTopology,
  assertCanonicalInputIdentity,
  assertStoredTopology,
  deriveTopology,
  isUnchangedRefresh,
  validateAdmittedSourceDocuments,
  validateTopologyEvidence,
} from "./apply-itx-topology-to-bundled-pack.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const buildNow = "2026-07-16T00:00:00.000Z";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function admittedDocuments() {
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const reference = contract.sourceTimetableArtifact;
  const sourceBytes = await readFile(path.join(root, reference.artifactPath));
  const completenessBytes = await readFile(path.join(root, reference.completenessEvidencePath));
  return {
    contract,
    reference,
    source: JSON.parse(sourceBytes),
    completeness: JSON.parse(completenessBytes),
    sourceBytes,
    completenessBytes,
  };
}

function withBuildNow(callback) {
  const previous = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = buildNow;
  try {
    return callback();
  } finally {
    if (previous == null) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previous;
  }
}

function admissionEvidenceFrom(contract) {
  const canonical = contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity;
  const reference = contract.sourceTimetableArtifact;
  return {
    serviceClass: "ITX_CHEONGCHUN",
    timetableArtifactId: reference.artifactId,
    timetableArtifactSha256: reference.sha256,
    canonicalPackId: canonical.id,
    canonicalPackSha256: canonical.sha256,
    canonicalPackSqliteSha256: canonical.sqliteSha256,
    admissionStatus: "ADMITTED",
    admissionEligible: 1,
    freshUntil: reference.freshUntil,
    sourceIssue: 2135,
  };
}

async function createFixture(context, { version = 18, legacyEvidence = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-topology-fixture-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, "capital.sqlite");
  const schema = await readFile(path.join(root, "tools/datapack/schema/catalog-schema.sql"), "utf8");
  const { contract, source } = await admittedDocuments();
  const topology = deriveTopology(source);
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec(schema);
    database.exec("PRAGMA foreign_keys = ON");
    const operators = new Set(topology.stations.map(({ lineId }) => `operator-${lineId}`));
    const insertOperator = database.prepare("INSERT INTO operators (id, name_ko) VALUES (?, ?)");
    for (const operator of operators) insertOperator.run(operator, operator);
    const insertLine = database.prepare("INSERT INTO lines (id, operator_id, name_ko) VALUES (?, ?, ?)");
    for (const lineId of new Set(topology.stations.map(({ lineId }) => lineId))) {
      insertLine.run(lineId, `operator-${lineId}`, lineId);
    }
    const insertStation = database.prepare(`
      INSERT INTO stations (id, name_ko, normalized_name) VALUES (?, ?, ?)
    `);
    const insertMembership = database.prepare(`
      INSERT INTO station_lines (station_id, line_id, line_sequence) VALUES (?, ?, ?)
    `);
    const insertPosition = database.prepare(`
      INSERT INTO route_map_positions (
        station_id, line_id, region, x, y, source_id, source_name, source_url, license, license_status
      ) VALUES (?, ?, 'fixture', 0, 0, 'fixture', 'fixture', 'https://example.invalid', 'fixture', 'APPROVED')
    `);
    const stationIds = new Set();
    for (const [index, station] of topology.stations.entries()) {
      if (!stationIds.has(station.stationId)) {
        insertStation.run(station.stationId, station.stationId, station.stationId);
        stationIds.add(station.stationId);
      }
      insertMembership.run(station.stationId, station.lineId, index);
      insertPosition.run(station.stationId, station.lineId);
    }
    database.exec(`
      INSERT INTO service_calendars (
        service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date
      ) VALUES ('fixture-service', 1, 1, 1, 1, 1, 1, 1, '20260101', '20261231');
      INSERT INTO transit_routes (id, line_id) VALUES ('fixture-route', '${topology.stations[0].lineId}');
      INSERT INTO transit_trips (id, route_id, service_id) VALUES ('fixture-trip', 'fixture-route', 'fixture-service');
      INSERT INTO fare_zones (id, name_ko, region) VALUES ('fixture-zone', 'fixture', 'fixture');
      INSERT INTO fare_rules (id, zone_id, base_card_fare, base_cash_fare, base_distance_meters)
      VALUES ('fixture-fare', 'fixture-zone', 0, 0, 0);
    `);
    if (legacyEvidence) {
      database.exec(`
        DROP TABLE route_service_artifact_evidence;
        CREATE TABLE route_service_artifact_evidence (
          service_class TEXT NOT NULL PRIMARY KEY,
          timetable_artifact_id TEXT NOT NULL,
          timetable_artifact_sha256 TEXT NOT NULL,
          canonical_pack_id TEXT NOT NULL,
          canonical_pack_sha256 TEXT NOT NULL,
          canonical_pack_sqlite_sha256 TEXT NOT NULL,
          admission_status TEXT NOT NULL,
          admission_eligible INTEGER NOT NULL,
          fresh_until TEXT,
          source_issue INTEGER NOT NULL CHECK (source_issue = 2116)
        );
      `);
    }
    if (version === 16) {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("DROP TABLE route_service_artifact_evidence");
      for (const table of ["network_edges", "transit_trips"]) {
        const columns = database.prepare(`PRAGMA table_info(${table})`).all()
          .map(({ name }) => name)
          .filter((name) => name !== "service_class")
          .join(", ");
        const legacySchema = database.prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
        ).get(table).sql
          .replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_v16`)
          .replace("  service_class TEXT NOT NULL DEFAULT 'SUBWAY',\n", "")
          .replace("  CHECK (service_class IN ('SUBWAY', 'ITX_CHEONGCHUN')),\n", "")
          .replace("  CHECK (service_class IN ('SUBWAY', 'ITX_CHEONGCHUN'))\n", "")
          .replace(",\n)", "\n)");
        database.exec(`
          ${legacySchema};
          INSERT INTO ${table}_v16 (${columns}) SELECT ${columns} FROM ${table};
          DROP TABLE ${table};
          ALTER TABLE ${table}_v16 RENAME TO ${table};
        `);
      }
      database.exec(`
        CREATE INDEX idx_transit_trips_route_service_pattern
          ON transit_trips(route_id, service_id, service_pattern);
        CREATE INDEX idx_network_edges_from_node ON network_edges(from_node_id);
      `);
      database.exec("PRAGMA foreign_keys = ON");
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    }
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
  return { sqlitePath, contract, source, topology };
}

function canonicalRows(sqlitePath) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT id, from_node_id, to_node_id, duration_seconds, distance_meters, edge_type,
             service_pattern, service_class
      FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN' ORDER BY id
    `).all().map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

function selfConsistentEvidence(contract, source, topology, gzipBytes, sqliteBytes) {
  const reference = contract.sourceTimetableArtifact;
  const gzipSha = sha256(gzipBytes);
  const sqliteSha = sha256(sqliteBytes);
  const localContract = structuredClone(contract);
  const localSource = structuredClone(source);
  localSource.canonicalPackIdentity.sha256 = gzipSha;
  localContract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256 = gzipSha;
  localContract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = sqliteSha;
  return {
    contract: localContract,
    source: localSource,
    evidence: {
      schemaVersion: 1,
      artifactKind: "itx-cheongchun-mobile-topology-evidence",
      sourceIssue: 2135,
      serviceId: "ITX_CHEONGCHUN",
      sourceArtifact: {
        id: reference.artifactId,
        sha256: reference.sha256,
        completenessEvidenceSha256: reference.completenessEvidenceSha256,
        freshUntil: reference.freshUntil,
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
        id: "capital", inputSha256: gzipSha, inputSqliteSha256: sqliteSha,
        inputByteSize: gzipBytes.length, outputSha256: gzipSha, outputSqliteSha256: sqliteSha,
        byteSize: gzipBytes.length, byteSizeDelta: 0,
      },
    },
    index: { packs: [{ id: "capital", sha256: gzipSha, sqliteSha256: sqliteSha, byteSize: gzipBytes.length }] },
  };
}

async function assertRejectedMutatedTopology(context, mutate, expected) {
  const fixture = await createFixture(context);
  const source = structuredClone(fixture.source);
  mutate(source);
  assert.throws(() => applyTopology(
    fixture.sqlitePath, deriveTopology(source), admissionEvidenceFrom(fixture.contract),
  ), expected);
}

function validateEvidenceCandidate(candidate, topology, gzipBytes, inputByteSize = gzipBytes.length) {
  return () => validateTopologyEvidence({
    contract: candidate.contract, reference: candidate.contract.sourceTimetableArtifact,
    source: candidate.source, topology, evidence: candidate.evidence, index: candidate.index,
    inputGzipBytes: gzipBytes,
    admittedInput: {
      gzipSha256: candidate.source.canonicalPackIdentity.sha256,
      sqliteSha256: candidate.contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256,
      byteSize: inputByteSize,
    },
  });
}

test("미등록 current source는 custom contract와 sentinel 산출물을 변경하지 않고 거부한다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-current-admission-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { contract, sourceBytes, completenessBytes } = await admittedDocuments();
  const contractPath = path.join(directory, "contract.json");
  const sourcePath = path.join(directory, "source.json");
  const completenessPath = path.join(directory, "completeness.json");
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  await writeFile(sourcePath, sourceBytes);
  await writeFile(completenessPath, completenessBytes);
  contract.sourceTimetableArtifact.artifactPath = sourcePath;
  contract.sourceTimetableArtifact.completenessEvidencePath = completenessPath;
  contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
  contract.sourceTimetableArtifact.completenessEvidenceSha256 = sha256(completenessBytes);
  await writeFile(contractPath, JSON.stringify(contract));
  await writeFile(packPath, "sentinel-pack");
  await writeFile(indexPath, "sentinel-index");
  await writeFile(evidencePath, "sentinel-evidence");
  const before = await Promise.all([readFile(packPath), readFile(indexPath), readFile(evidencePath)]);
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--contract", contractPath,
    "--pack", packPath, "--index", indexPath, "--evidence", evidencePath,
  ], { cwd: root, env: { ...process.env, EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } }),
  /current source identity is not admitted/);
  assert.deepEqual(await Promise.all([readFile(packPath), readFile(indexPath), readFile(evidencePath)]), before);
});

test("topology direct seam은 shape, FK, admission evidence를 materialize하고 deterministic하다", async (context) => {
  const first = await createFixture(context);
  const second = await createFixture(context);
  const evidence = admissionEvidenceFrom(first.contract);
  applyTopology(first.sqlitePath, first.topology, evidence);
  applyTopology(second.sqlitePath, second.topology, evidence);
  assertStoredTopology(first.sqlitePath, first.topology, evidence);
  assert.deepEqual(canonicalRows(first.sqlitePath), canonicalRows(second.sqlitePath));
  assert.equal(canonicalRows(first.sqlitePath).length, 48);
});

test("topology evidence seam은 self-consistent fixture를 통과하고 파생 count 변조를 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const sqliteBytes = await readFile(fixture.sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
  assert.doesNotThrow(validateEvidenceCandidate(candidate, fixture.topology, gzipBytes));
  candidate.evidence.topology.edgeCount += 1;
  assert.throws(validateEvidenceCandidate(candidate, fixture.topology, gzipBytes),
    /evidence or bundled pack index is stale/);
});

test("self-consistent custom canonical SQLite/evidence도 static admission과 다르면 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const sqliteBytes = await readFile(fixture.sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
  const admittedInput = {
    gzipSha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
    sqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
    byteSize: 354980,
  };
  const mutatedSqliteSha = "0".repeat(64);
  candidate.source.canonicalPackIdentity.sha256 = admittedInput.gzipSha256;
  candidate.contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256 = admittedInput.gzipSha256;
  candidate.contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = mutatedSqliteSha;
  candidate.evidence.pack.inputSha256 = admittedInput.gzipSha256;
  candidate.evidence.pack.inputSqliteSha256 = mutatedSqliteSha;
  candidate.evidence.pack.inputByteSize = admittedInput.byteSize;
  candidate.evidence.pack.byteSizeDelta = gzipBytes.length - admittedInput.byteSize;
  assert.throws(() => validateTopologyEvidence({
    contract: candidate.contract, reference: candidate.contract.sourceTimetableArtifact,
    source: candidate.source, topology: fixture.topology, evidence: candidate.evidence,
    index: candidate.index, inputGzipBytes: gzipBytes, admittedInput,
  }), /evidence or bundled pack index is stale/);
});

test("admission document와 canonical input identity는 exact binding을 요구한다", async (context) => {
  const { contract, reference, source, completeness, sourceBytes, completenessBytes } = await admittedDocuments();
  withBuildNow(() => assert.doesNotThrow(() => validateAdmittedSourceDocuments(
    contract, reference, source, completeness, sha256(sourceBytes), sha256(completenessBytes),
  )));
  const invalidCompleteness = structuredClone(completeness);
  invalidCompleteness.validationStatus = "UNSUPPORTED";
  withBuildNow(() => assert.throws(() => validateAdmittedSourceDocuments(
    contract, reference, source, invalidCompleteness, sha256(sourceBytes), sha256(completenessBytes),
  ), /source identity is invalid/));
  const fixture = await createFixture(context);
  const sqliteBytes = await readFile(fixture.sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
  candidate.contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = "0".repeat(64);
  assert.throws(() => assertCanonicalInputIdentity(
    candidate.contract, candidate.source, sha256(gzipBytes), sha256(sqliteBytes),
  ),
    /canonical input pack identity mismatch/);
});

test("v18 legacy evidence schema는 2135 admission schema로 migration한다", async (context) => {
  const fixture = await createFixture(context, { legacyEvidence: true });
  applyTopology(fixture.sqlitePath, fixture.topology, admissionEvidenceFrom(fixture.contract));
  const database = new DatabaseSync(fixture.sqlitePath, { readOnly: true });
  try {
    assert.equal(database.prepare(`SELECT source_issue FROM route_service_artifact_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'`).get().source_issue, 2135);
  } finally { database.close(); }
});

test("actual v16 conversion은 8개 preserved table과 index를 보존하고 idempotent하다", async (context) => {
  const fixture = await createFixture(context, { version: 16 });
  const database = new DatabaseSync(fixture.sqlitePath);
  const preservedTables = [
    "official_od_fare_quotes", "service_calendar_dates", "service_calendars", "transit_feed_info",
    "transit_frequencies", "transit_routes", "transit_stop_times", "transit_trips",
  ];
  const before = preservedTables.map((table) =>
    [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
  assert.deepEqual(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (
      'idx_network_edges_from_node', 'idx_transit_trips_route_service_pattern'
    ) ORDER BY name
  `).all().map(({ name }) => name), [
    "idx_network_edges_from_node", "idx_transit_trips_route_service_pattern",
  ]);
  database.close();
  const evidence = admissionEvidenceFrom(fixture.contract);
  applyTopology(fixture.sqlitePath, fixture.topology, evidence);
  applyTopology(fixture.sqlitePath, fixture.topology, evidence);
  const output = new DatabaseSync(fixture.sqlitePath, { readOnly: true });
  try {
    assert.equal(output.prepare("PRAGMA user_version").get().user_version, 18);
    for (const [table, rows] of before) {
      const actual = output.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => {
        if (table !== "transit_trips") return row;
        const { service_class: _serviceClass, ...legacyRow } = row;
        return legacyRow;
      });
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(rows)));
    }
    assert.deepEqual(output.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (
        'idx_network_edges_from_node', 'idx_transit_trips_route_service_pattern'
      ) ORDER BY name
    `).all().map(({ name }) => name), [
      "idx_network_edges_from_node", "idx_transit_trips_route_service_pattern",
    ]);
  } finally { output.close(); }
  assertStoredTopology(fixture.sqlitePath, fixture.topology, evidence);
  const sqliteBytes = await readFile(fixture.sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
  assert.doesNotThrow(validateEvidenceCandidate(candidate, fixture.topology, gzipBytes));
});

test("unsupported catalog version은 fixture를 변경하지 않고 거부한다", async (context) => {
  const fixture = await createFixture(context, { version: 19 });
  const before = sha256(await readFile(fixture.sqlitePath));
  assert.throws(() => applyTopology(fixture.sqlitePath, fixture.topology, admissionEvidenceFrom(fixture.contract)),
    /does not support catalog user_version/);
  assert.equal(sha256(await readFile(fixture.sqlitePath)), before);
});

test("current source admission은 historical evidence, path, previous artifact를 받지 않는다", async () => {
  const { reference, source } = await admittedDocuments();
  assert.throws(() => admittedTopologySource(reference, source), /current source identity is not admitted/);
});

test("serialization-only readmission 없는 64 KiB 초과 gzip은 evidence seam에서 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const payload = randomBytes(100_000);
  const gzipBytes = gzipSync(payload, { level: 9, mtime: 0 });
  assert.ok(gzipBytes.length > 64 * 1024);
  const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, payload);
  candidate.evidence.pack.inputByteSize = 1;
  candidate.evidence.pack.byteSizeDelta = gzipBytes.length - 1;
  assert.throws(validateEvidenceCandidate(candidate, fixture.topology, gzipBytes, 1),
    /evidence or bundled pack index is stale/);
});

test("isUnchangedRefresh는 immediate previous source divergence를 거부한다", async () => {
  const { reference, source } = await admittedDocuments();
  const previous = JSON.parse(await readFile(path.join(root, reference.promotion.previousArtifactPath), "utf8"));
  previous.normalizedSnapshotSets[0].sets.stationSet.push("station-diverged-from-current");
  assert.equal(isUnchangedRefresh(reference, source, previous), false);
});

test("assertStoredTopology는 foreign-key 손상을 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const evidence = admissionEvidenceFrom(fixture.contract);
  applyTopology(fixture.sqlitePath, fixture.topology, evidence);
  const database = new DatabaseSync(fixture.sqlitePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`INSERT INTO transit_stop_times (
      trip_id, stop_sequence, station_id, line_id, arrival_seconds, departure_seconds
    ) VALUES ('fixture-trip', 1, 'missing-station', '${fixture.topology.stations[0].lineId}', 0, 0)`);
  } finally { database.close(); }
  assert.throws(() => assertStoredTopology(fixture.sqlitePath, fixture.topology, evidence),
    /foreign_key_check failed/);
});

test("self-consistent inputByteSize mutation은 evidence seam에서 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const sqliteBytes = await readFile(fixture.sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
  candidate.evidence.pack.inputByteSize = gzipBytes.length - 1;
  candidate.evidence.pack.byteSizeDelta = 1;
  assert.throws(validateEvidenceCandidate(candidate, fixture.topology, gzipBytes),
    /evidence or bundled pack index is stale/);
});

test("freshUntil boundary부터 admitted source를 거부한다", async () => {
  const { contract, reference, source, completeness, sourceBytes, completenessBytes } = await admittedDocuments();
  const boundary = Date.parse(reference.freshUntil);
  const previous = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  try {
    process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = new Date(boundary - 1).toISOString();
    assert.doesNotThrow(() => validateAdmittedSourceDocuments(
      contract, reference, source, completeness, sha256(sourceBytes), sha256(completenessBytes),
    ));
    process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = new Date(boundary).toISOString();
    assert.throws(() => validateAdmittedSourceDocuments(
      contract, reference, source, completeness, sha256(sourceBytes), sha256(completenessBytes),
    ), /source artifact is expired/);
  } finally {
    if (previous == null) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previous;
  }
});

test("contract/source/completeness schema identity 변조를 각각 거부한다", async (context) => {
  const cases = [
    ["contract", (documents) => { documents.contract.schemaVersion = 999; }, /ADMITTED source contract/],
    ["source", (documents) => { documents.source.schemaVersion = 999; }, /source identity is invalid/],
    ["completeness", (documents) => { documents.completeness.schemaVersion = 999; }, /source identity is invalid/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, async () => {
      const documents = await admittedDocuments();
      mutate(documents);
      withBuildNow(() => assert.throws(() => validateAdmittedSourceDocuments(
        documents.contract, documents.reference, documents.source, documents.completeness,
        sha256(documents.sourceBytes), sha256(documents.completenessBytes),
      ), expected));
    });
  }
});

test("canonical gzip와 SQLite identity 변조를 각각 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const sqliteBytes = await readFile(fixture.sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
  await context.test("gzip", () => {
    candidate.contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256 = "0".repeat(64);
    assert.throws(() => assertCanonicalInputIdentity(candidate.contract, candidate.source, sha256(gzipBytes), sha256(sqliteBytes)),
      /canonical input pack identity mismatch/);
  });
  await context.test("sqlite", () => {
    const sqliteCandidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
    sqliteCandidate.contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = "0".repeat(64);
    assert.throws(() => assertCanonicalInputIdentity(
      sqliteCandidate.contract, sqliteCandidate.source, sha256(gzipBytes), sha256(sqliteBytes),
    ), /canonical input pack identity mismatch/);
  });
});

test("versions 15와 19는 mutation 없이 거부한다", async (context) => {
  for (const version of [15, 19]) {
    await context.test(String(version), async (childContext) => {
      const fixture = await createFixture(childContext, { version });
      const before = sha256(await readFile(fixture.sqlitePath));
      assert.throws(() => applyTopology(fixture.sqlitePath, fixture.topology, admissionEvidenceFrom(fixture.contract)),
        /does not support catalog user_version/);
      assert.equal(sha256(await readFile(fixture.sqlitePath)), before);
    });
  }
});

test("evidence topology count, size budget, schema identity mutation을 각각 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const sqliteBytes = await readFile(fixture.sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const cases = [
    ["topology-count", (evidence) => { evidence.topology.stationMembershipCount += 1; }],
    ["size-budget", (evidence) => { evidence.pack.inputByteSize = 0; evidence.pack.byteSizeDelta = gzipBytes.length; }],
    ["schema-identity", (evidence) => { evidence.schemaVersion = 999; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
      mutate(candidate.evidence);
      assert.throws(validateEvidenceCandidate(candidate, fixture.topology, gzipBytes),
        /evidence or bundled pack index is stale/);
    });
  }
});

test("canonical station membership missing을 거부한다", async (context) => {
  await assertRejectedMutatedTopology(context, (source) => {
    const station = source.stationRosters[0].stations[0];
    const originalId = station.canonicalStationId;
    station.canonicalStationId = "missing-fixture-station";
    for (const stop of source.stationSequences.flatMap(({ stops }) => stops)) {
      if (stop.stationId === originalId) stop.stationId = station.canonicalStationId;
    }
    for (const stopTime of source.transitStopTimes) {
      if (stopTime.stationId === originalId) stopTime.stationId = station.canonicalStationId;
    }
  }, /canonical station membership is missing/);
});

test("source와 completeness evidence exact binding을 요구한다", async () => {
  const documents = await admittedDocuments();
  const reference = structuredClone(documents.reference);
  const source = structuredClone(documents.source);
  source.completenessEvidenceSha256 = "0".repeat(64);
  const sourceBytes = Buffer.from(JSON.stringify(source));
  reference.sha256 = sha256(sourceBytes);
  withBuildNow(() => assert.throws(() => validateAdmittedSourceDocuments(
    documents.contract, reference, source, documents.completeness,
    sha256(sourceBytes), sha256(documents.completenessBytes),
  ), /source identity is invalid/));
});

test("reversed down direction, missing U/D, incomplete stops, disconnected components를 거부한다", async (context) => {
  const cases = [
    ["reversed-down", (source) => {
      for (const sequence of source.stationSequences.filter(({ directionId }) => directionId === "down")) sequence.stops.reverse();
    }, /direction is invalid/],
    ["missing-ud", (source) => { source.stationSequences = source.stationSequences.filter(({ directionId }) => directionId === "up"); }, /requires U\/D station sequences/],
    ["incomplete-stops", (source) => {
      source.stationSequences = [source.stationSequences.find(({ directionId }) => directionId === "up"), source.stationSequences.find(({ directionId }) => directionId === "down")];
    }, /cover the admitted service stop set/],
    ["disconnected", (source) => {
      const stops = [...new Map(source.stationSequences.flatMap(({ stops: entries }) => entries)
        .map((stop) => [`${stop.stationId}:${stop.lineId}`, stop])).values()]
        .sort((left, right) => left.corridorSequence - right.corridorSequence);
      const middle = Math.ceil(stops.length / 2);
      source.stationSequences = [stops.slice(0, middle), stops.slice(middle)].flatMap((group, index) => [
        { trainNumber: `up-${index}`, directionId: "up", stops: group },
        { trainNumber: `down-${index}`, directionId: "down", stops: [...group].reverse() },
      ]);
    }, /service stop graph must be connected/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, async (childContext) => assertRejectedMutatedTopology(childContext, mutate, expected));
  }
});
