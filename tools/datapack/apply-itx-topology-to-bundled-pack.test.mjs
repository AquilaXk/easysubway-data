import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  admittedTopologySource,
  applyTopology,
  assertStoredTopology,
  deriveTopology,
  parseAuthenticatedAdmittedSourceDocuments,
  validateAdmittedSourceDocuments,
  validateTopologyEvidence,
} from "./apply-itx-topology-to-bundled-pack.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const buildNow = "2026-07-16T00:00:00.000Z";
const mobileRevision = "d85742f14cbf97c526a6b94dd55bbf863e1d1346";
const currentV18GzipSha256 = "f328fbedff014be18a0e8341e0bdbfe9b0dd774fa7e9ae7692aa869e831707b3";
const currentV18SqliteSha256 = "a581c5d2a78f765b859e7e7b7d62d3bf0d9b573bcebd246ab4c6f0cd62fddfc5";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const stationCatalogPackIdentity = Object.freeze({
  artifactKind: "station-catalog-pack",
  manifestVersion: 1,
  catalogPackId: "station-catalog-test",
  stationSetSha256: "1".repeat(64),
  payloadSha256: "2".repeat(64),
  manifestSha256: "3".repeat(64),
});

const admittedTopologyInputs = new Map([
  ["e3c4f942a02712904d44d642627eb909523d55189efce96296a0d2b96e3ea4ad", {
    id: "capital",
    sha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
    sqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
    byteSize: 354980,
  }],
  ["e2894d7ce6decb08fc9fec982394e77151799c34d099b83948481080e56d780e", {
    id: "capital",
    sha256: "7bb4bb68f0642e45377d98b083e93cd8c1c92aaa58dd353f32189e3f325a1562",
    sqliteSha256: "ed84a649952cd2ccbb238b3a63265f2bd3144497ae8fd36fab5181ad776542fc",
    byteSize: 359319,
  }],
]);

async function trackedLegacyDocuments() {
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

async function admittedDocuments() {
  const { contract, source, completeness } = await trackedLegacyDocuments();
  const topologyInputPackIdentity = admittedTopologyInputs.get(
    contract.sourceTimetableArtifact.promotion.previousArtifactSha256,
  );
  assert.ok(topologyInputPackIdentity, "fixture predecessor must have an exact static topology input admission");
  delete contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity;
  contract.officialEvidence.korailCompletenessAdmission.stationCatalogPackIdentity =
    structuredClone(stationCatalogPackIdentity);
  contract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity =
    structuredClone(topologyInputPackIdentity);
  contract.sourceTimetableArtifact.promotion.mode = "CURRENT_CANDIDATE_OWNER_APPROVED";
  delete source.canonicalPackIdentity;
  source.stationCatalogPackIdentity = structuredClone(stationCatalogPackIdentity);
  completeness.stationCatalogPackIdentity = structuredClone(stationCatalogPackIdentity);
  const completenessBytes = Buffer.from(JSON.stringify(completeness));
  contract.sourceTimetableArtifact.completenessEvidenceSha256 = sha256(completenessBytes);
  source.completenessEvidenceSha256 = contract.sourceTimetableArtifact.completenessEvidenceSha256;
  const sourceBytes = Buffer.from(JSON.stringify(source));
  contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
  const reference = contract.sourceTimetableArtifact;
  return {
    contract,
    reference,
    source,
    completeness,
    sourceBytes,
    completenessBytes,
  };
}

function rebindAdmissionDocuments(documents) {
  const { evidenceHash: _completenessEvidenceHash, ...completenessWithoutEvidenceHash } =
    documents.completeness;
  documents.completeness.evidenceHash = sha256(JSON.stringify(completenessWithoutEvidenceHash));
  documents.completenessBytes = Buffer.from(`${JSON.stringify(documents.completeness, null, 2)}\n`);
  documents.reference.completenessEvidenceSha256 = sha256(documents.completenessBytes);
  documents.source.completenessEvidenceSha256 = documents.reference.completenessEvidenceSha256;
  const { evidenceHash: _sourceEvidenceHash, ...sourceWithoutEvidenceHash } = documents.source;
  documents.source.evidenceHash = sha256(JSON.stringify(sourceWithoutEvidenceHash));
  documents.sourceBytes = Buffer.from(`${JSON.stringify(documents.source, null, 2)}\n`);
  documents.reference.sha256 = sha256(documents.sourceBytes);
  return documents;
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
  const station = contract.officialEvidence.korailCompletenessAdmission.stationCatalogPackIdentity;
  const canonical = contract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity;
  const reference = contract.sourceTimetableArtifact;
  return {
    artifactEvidence: {
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
    },
    stationCatalogEvidence: {
      serviceClass: "ITX_CHEONGCHUN",
      stationCatalogArtifactKind: station.artifactKind,
      stationCatalogManifestVersion: station.manifestVersion,
      stationCatalogPackId: station.catalogPackId,
      stationCatalogStationSetSha256: station.stationSetSha256,
      stationCatalogPayloadSha256: station.payloadSha256,
      stationCatalogManifestSha256: station.manifestSha256,
      admissionStatus: "ADMITTED",
      admissionEligible: 1,
      freshUntil: reference.freshUntil,
      sourceIssue: 2649,
    },
  };
}

async function createFixture(context, { version = 19, legacyEvidence = false } = {}) {
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
        DROP TABLE route_service_station_catalog_evidence;
        CREATE TABLE route_service_artifact_evidence (
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
        );
      `);
    }
    if (version === 16) {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("DROP TABLE route_service_artifact_evidence");
      database.exec("DROP TABLE route_service_station_catalog_evidence");
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
    if (version === 19 && !legacyEvidence) {
      const evidence = admissionEvidenceFrom(contract);
      database.prepare(`INSERT INTO route_service_artifact_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        evidence.artifactEvidence.serviceClass, evidence.artifactEvidence.timetableArtifactId,
        evidence.artifactEvidence.timetableArtifactSha256, evidence.artifactEvidence.canonicalPackId,
        evidence.artifactEvidence.canonicalPackSha256, evidence.artifactEvidence.canonicalPackSqliteSha256,
        evidence.artifactEvidence.admissionStatus, evidence.artifactEvidence.admissionEligible,
        evidence.artifactEvidence.freshUntil, evidence.artifactEvidence.sourceIssue,
      );
      database.prepare(`INSERT INTO route_service_station_catalog_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        evidence.stationCatalogEvidence.serviceClass, evidence.stationCatalogEvidence.stationCatalogArtifactKind,
        evidence.stationCatalogEvidence.stationCatalogManifestVersion, evidence.stationCatalogEvidence.stationCatalogPackId,
        evidence.stationCatalogEvidence.stationCatalogStationSetSha256, evidence.stationCatalogEvidence.stationCatalogPayloadSha256,
        evidence.stationCatalogEvidence.stationCatalogManifestSha256, evidence.stationCatalogEvidence.admissionStatus,
        evidence.stationCatalogEvidence.admissionEligible, evidence.stationCatalogEvidence.freshUntil,
        evidence.stationCatalogEvidence.sourceIssue,
      );
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
  localContract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity = {
    id: "capital",
    sha256: gzipSha,
    sqliteSha256: sqliteSha,
    byteSize: gzipBytes.length,
  };
  return {
    contract: localContract,
    source: localSource,
    evidence: {
      schemaVersion: 1,
      artifactKind: "itx-cheongchun-mobile-topology-evidence",
      sourceIssue: 2135,
      serviceId: "ITX_CHEONGCHUN",
      stationCatalogPackIdentity: structuredClone(localSource.stationCatalogPackIdentity),
      sourceArtifact: {
        id: reference.artifactId,
        sha256: reference.sha256,
        completenessEvidenceSha256: reference.completenessEvidenceSha256,
        freshUntil: reference.freshUntil,
        stationCatalogPackIdentity: structuredClone(localSource.stationCatalogPackIdentity),
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
      gzipSha256: candidate.contract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity.sha256,
      sqliteSha256: candidate.contract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity.sqliteSha256,
      byteSize: inputByteSize,
    },
  });
}

async function verifyImmutableMobileRepository(repository, runGit) {
  const stat = await lstat(repository).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("immutable Mobile checkout must be a real directory");
  }
  const inside = await runGit(repository, ["rev-parse", "--is-inside-work-tree"]);
  const revision = await runGit(repository, ["rev-parse", "--verify", `${mobileRevision}^{commit}`]);
  if (inside.trim() !== "true" || revision.trim() !== mobileRevision) {
    throw new Error("immutable Mobile checkout does not contain the expected d857 commit");
  }
  return repository;
}

export async function resolveImmutableMobileRepository({
  repositoryRoot = root,
  runGit = async (repository, args) => (await execFileAsync("git", ["-C", repository, ...args])).stdout,
} = {}) {
  const ciCheckout = path.join(repositoryRoot, ".external", "mobile");
  if (await lstat(ciCheckout).then(() => true).catch(() => false)) {
    return verifyImmutableMobileRepository(ciCheckout, runGit);
  }
  return verifyImmutableMobileRepository(path.resolve(repositoryRoot, "../easysubway-mobile"), runGit);
}

async function immutableCurrentV18Bytes(relativePath) {
  const mobileRoot = await resolveImmutableMobileRepository();
  const { stdout } = await execFileAsync("git", [
    "-C", mobileRoot, "show", `${mobileRevision}:apps/mobile/assets/datapacks/${relativePath}`,
  ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

test("immutable v18 output resolver는 CI checkout을 sibling보다 우선한다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-mobile-resolver-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const ciCheckout = path.join(directory, ".external", "mobile");
  await mkdir(ciCheckout, { recursive: true });
  const calls = [];
  const resolved = await resolveImmutableMobileRepository({
    repositoryRoot: directory,
    runGit: async (repository, args) => {
      calls.push([repository, args]);
      return args.includes("--is-inside-work-tree") ? "true\n" : `${mobileRevision}\n`;
    },
  });
  assert.equal(resolved, ciCheckout);
  assert.deepEqual(calls, [
    [ciCheckout, ["rev-parse", "--is-inside-work-tree"]],
    [ciCheckout, ["rev-parse", "--verify", `${mobileRevision}^{commit}`]],
  ]);
});

test("immutable v18 output은 explicit migration으로만 v19 two-domain evidence로 이행한다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-current-v18-output-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  const stationCatalogPackPath = path.join(directory, "station-catalog-pack");
  await writeFile(packPath, await immutableCurrentV18Bytes("capital.sqlite.gz"));
  await writeFile(indexPath, await immutableCurrentV18Bytes("index.json"));
  await writeFile(evidencePath, await readFile(path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json")));
  const before = await Promise.all([readFile(packPath), readFile(indexPath), readFile(evidencePath)]);
  assert.equal(sha256(before[0]), currentV18GzipSha256);
  assert.equal(sha256(gunzipSync(before[0])), currentV18SqliteSha256);
  await execFileAsync(process.execPath, [
    "tools/datapack/emit-station-catalog-from-bundled-pack.mjs", "--input", packPath,
    "--output", stationCatalogPackPath,
  ], { cwd: root });
  for (const surface of ["2", "3"]) {
    await context.test(`surface ${surface} rename failure restores every original output`, async () => {
      const failure = path.join(directory, `failure-${surface}`);
      await (await import("node:fs/promises")).mkdir(failure);
      const paths = {
        pack: path.join(failure, "capital.sqlite.gz"), index: path.join(failure, "index.json"),
        evidence: path.join(failure, "evidence.json"), catalog: path.join(failure, "station-catalog-pack"),
      };
      await Promise.all([writeFile(paths.pack, before[0]), writeFile(paths.index, before[1]), writeFile(paths.evidence, before[2])]);
      await execFileAsync(process.execPath, ["tools/datapack/emit-station-catalog-from-bundled-pack.mjs", "--input", paths.pack, "--output", paths.catalog], { cwd: root });
      await assert.rejects(execFileAsync(process.execPath, [
        "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--migrate-current-v18",
        "--pack", paths.pack, "--index", paths.index, "--evidence", paths.evidence,
        "--station-catalog-pack", paths.catalog,
      ], { cwd: root, env: { ...process.env, EASYSUBWAY_TEST_MIGRATION_FAIL_AFTER_SURFACE: surface } }), new RegExp(`injected migration surface failure ${surface}`));
      assert.deepEqual(await Promise.all([readFile(paths.pack), readFile(paths.index), readFile(paths.evidence)]), before);
      assert.deepEqual((await readdir(failure)).sort(), ["capital.sqlite.gz", "evidence.json", "index.json", "station-catalog-pack"]);
    });
  }
  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--migrate-current-v18",
    "--pack", packPath, "--index", indexPath, "--evidence", evidencePath,
    "--station-catalog-pack", stationCatalogPackPath,
  ], { cwd: root, env: { ...process.env, EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } });
  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--check",
    "--pack", packPath, "--index", indexPath, "--evidence", evidencePath,
  ], { cwd: root, env: { ...process.env, EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } });
  const [packBytes, indexBytes, evidenceBytes] = await Promise.all([
    readFile(packPath), readFile(indexPath), readFile(evidencePath),
  ]);
  const index = JSON.parse(indexBytes);
  const evidence = JSON.parse(evidenceBytes);
  await writeFile(path.join(directory, "output.sqlite"), gunzipSync(packBytes));
  const verified = new DatabaseSync(path.join(directory, "output.sqlite"), { readOnly: true });
  try {
    assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 19);
    assert.equal(verified.prepare("SELECT count(*) AS count FROM route_service_artifact_evidence").get().count, 1);
    assert.equal(verified.prepare("SELECT count(*) AS count FROM route_service_station_catalog_evidence").get().count, 1);
    assert.equal(verified.prepare("SELECT count(*) AS count FROM transit_trips WHERE service_class = 'ITX_CHEONGCHUN'").get().count, 0);
  } finally { verified.close(); }
  assert.deepEqual(evidence.migration, {
    fromCatalogVersion: 18, toCatalogVersion: 19,
    inputPack: { id: "capital", sha256: currentV18GzipSha256, sqliteSha256: currentV18SqliteSha256, byteSize: 1463745 },
  });
  const capital = index.packs.find(({ id }) => id === "capital");
  assert.equal(capital.sha256, sha256(packBytes));
  assert.equal(capital.sqliteSha256, sha256(gunzipSync(packBytes)));
  assert.equal(capital.byteSize, packBytes.length);
  await context.test("explicit check binds the stored artifact evidence to the pinned source artifact", async () => {
    const check = path.join(directory, "check-source-artifact-binding");
    await mkdir(check);
    const sqlitePath = path.join(check, "capital.sqlite");
    await writeFile(sqlitePath, gunzipSync(packBytes));
    const database = new DatabaseSync(sqlitePath);
    try {
      database.prepare(`UPDATE route_service_artifact_evidence
        SET timetable_artifact_id = ?, timetable_artifact_sha256 = ?, fresh_until = ?
        WHERE service_class = 'ITX_CHEONGCHUN'`).run(
        "forged-timetable-artifact", "f".repeat(64), "2026-08-01T00:00:00+09:00",
      );
      database.prepare(`UPDATE route_service_station_catalog_evidence SET fresh_until = ?
        WHERE service_class = 'ITX_CHEONGCHUN'`).run("2026-08-01T00:00:00+09:00");
    } finally { database.close(); }
    const candidateSqlite = await readFile(sqlitePath);
    const candidatePackBytes = gzipSync(candidateSqlite, { level: 9, mtime: 0 });
    const candidateEvidence = structuredClone(evidence);
    candidateEvidence.routeServiceEvidence.artifactEvidence.timetableArtifactId = "forged-timetable-artifact";
    candidateEvidence.routeServiceEvidence.artifactEvidence.timetableArtifactSha256 = "f".repeat(64);
    candidateEvidence.routeServiceEvidence.artifactEvidence.freshUntil = "2026-08-01T00:00:00+09:00";
    candidateEvidence.routeServiceEvidence.stationCatalogEvidence.freshUntil = "2026-08-01T00:00:00+09:00";
    candidateEvidence.pack.outputSha256 = sha256(candidatePackBytes);
    candidateEvidence.pack.outputSqliteSha256 = sha256(candidateSqlite);
    candidateEvidence.pack.byteSize = candidatePackBytes.length;
    candidateEvidence.pack.byteSizeDelta = candidatePackBytes.length - candidateEvidence.pack.inputByteSize;
    const candidateIndex = structuredClone(index);
    Object.assign(candidateIndex.packs.find(({ id }) => id === "capital"), {
      sha256: sha256(candidatePackBytes), sqliteSha256: sha256(candidateSqlite), byteSize: candidatePackBytes.length,
    });
    const candidatePack = path.join(check, "capital.sqlite.gz");
    const candidateIndexPath = path.join(check, "index.json");
    const candidateEvidencePath = path.join(check, "evidence.json");
    await Promise.all([
      writeFile(candidatePack, candidatePackBytes), writeFile(candidateIndexPath, JSON.stringify(candidateIndex)),
      writeFile(candidateEvidencePath, JSON.stringify(candidateEvidence)),
    ]);
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--check",
      "--pack", candidatePack, "--index", candidateIndexPath, "--evidence", candidateEvidencePath,
    ], { cwd: root }), /migrated v19 evidence or index is stale/);
  });
  await context.test("explicit check rejects a non-capital pack identity", async () => {
    const check = path.join(directory, "check-pack-id");
    await mkdir(check);
    const candidateEvidence = structuredClone(evidence);
    candidateEvidence.pack.id = "other";
    const candidatePack = path.join(check, "capital.sqlite.gz");
    const candidateIndexPath = path.join(check, "index.json");
    const candidateEvidencePath = path.join(check, "evidence.json");
    await Promise.all([
      writeFile(candidatePack, packBytes), writeFile(candidateIndexPath, indexBytes),
      writeFile(candidateEvidencePath, JSON.stringify(candidateEvidence)),
    ]);
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--check",
      "--pack", candidatePack, "--index", candidateIndexPath, "--evidence", candidateEvidencePath,
    ], { cwd: root }), /migrated v19 evidence or index is stale/);
  });
  await context.test("explicit check rejects an oversized recompressed migration output", async () => {
    const check = path.join(directory, "check-gzip-delta");
    await mkdir(check);
    const candidateSqlite = gunzipSync(packBytes);
    const candidatePackBytes = gzipSync(candidateSqlite, { level: 0, mtime: 0 });
    assert.ok(candidatePackBytes.length - evidence.pack.inputByteSize > 64 * 1024);
    const candidateEvidence = structuredClone(evidence);
    candidateEvidence.pack.outputSha256 = sha256(candidatePackBytes);
    candidateEvidence.pack.byteSize = candidatePackBytes.length;
    candidateEvidence.pack.byteSizeDelta = candidatePackBytes.length - candidateEvidence.pack.inputByteSize;
    const candidateIndex = structuredClone(index);
    Object.assign(candidateIndex.packs.find(({ id }) => id === "capital"), {
      sha256: sha256(candidatePackBytes), byteSize: candidatePackBytes.length,
    });
    const candidatePack = path.join(check, "capital.sqlite.gz");
    const candidateIndexPath = path.join(check, "index.json");
    const candidateEvidencePath = path.join(check, "evidence.json");
    await Promise.all([
      writeFile(candidatePack, candidatePackBytes), writeFile(candidateIndexPath, JSON.stringify(candidateIndex)),
      writeFile(candidateEvidencePath, JSON.stringify(candidateEvidence)),
    ]);
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--check",
      "--pack", candidatePack, "--index", candidateIndexPath, "--evidence", candidateEvidencePath,
    ], { cwd: root }), /migrated v19 evidence or index is stale/);
  });
  for (const [name, mutateEvidence, mutateIndex] of [
    ["topology", (value) => { value.topology.edgeCount += 1; }],
    ["input identity", (value) => { value.pack.inputSqliteSha256 = "0".repeat(64); }],
    ["input byte size", (value) => { value.pack.inputByteSize -= 1; }],
    ["byte delta", (value) => { value.pack.byteSizeDelta += 1; }],
    ["lineage", (value) => { value.migration.toCatalogVersion = 18; }],
    ["index sqlite", undefined, (value) => { value.packs.find(({ id }) => id === "capital").sqliteSha256 = "0".repeat(64); }],
    ["index size", undefined, (value) => { value.packs.find(({ id }) => id === "capital").byteSize -= 1; }],
  ]) {
    await context.test(`explicit check rejects ${name} semantic tamper`, async () => {
      const check = path.join(directory, `check-${name.replaceAll(" ", "-")}`);
      await (await import("node:fs/promises")).mkdir(check);
      const candidateEvidence = JSON.parse(evidenceBytes);
      const candidateIndex = JSON.parse(indexBytes);
      mutateEvidence?.(candidateEvidence); mutateIndex?.(candidateIndex);
      const candidatePack = path.join(check, "capital.sqlite.gz");
      const candidateIndexPath = path.join(check, "index.json");
      const candidateEvidencePath = path.join(check, "evidence.json");
      await Promise.all([
        writeFile(candidatePack, packBytes), writeFile(candidateIndexPath, JSON.stringify(candidateIndex)),
        writeFile(candidateEvidencePath, JSON.stringify(candidateEvidence)),
      ]);
      await assert.rejects(execFileAsync(process.execPath, [
        "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--check",
        "--pack", candidatePack, "--index", candidateIndexPath, "--evidence", candidateEvidencePath,
      ], { cwd: root }), /migrated v19 evidence or index is stale/);
    });
  }
});

test("custom contract는 legacy tracked source를 승인하지 않고 sentinel 산출물을 변경하지 않는다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-current-admission-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { contract } = await trackedLegacyDocuments();
  const contractPath = path.join(directory, "contract.json");
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  await writeFile(contractPath, JSON.stringify(contract));
  await writeFile(packPath, "sentinel-pack");
  await writeFile(indexPath, "sentinel-index");
  await writeFile(evidencePath, "sentinel-evidence");
  const before = await Promise.all([readFile(packPath), readFile(indexPath), readFile(evidencePath)]);
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs", "--contract", contractPath,
    "--pack", packPath, "--index", indexPath, "--evidence", evidencePath,
  ], { cwd: root, env: { ...process.env, EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } }),
  /legacy admission is forbidden/);
  assert.deepEqual(await Promise.all([readFile(packPath), readFile(indexPath), readFile(evidencePath)]), before);
});

test("admission은 mismatched pinned hash의 invalid JSON을 parse 전에 거부한다", () => {
  const parserToken = "parser-token-must-not-appear";
  let error;
  try {
    parseAuthenticatedAdmittedSourceDocuments(
      { sha256: "0".repeat(64), completenessEvidenceSha256: "1".repeat(64) },
      Buffer.from(`{${parserToken}`),
      Buffer.from(`{${parserToken}`),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /source bytes do not match the coverage contract/);
  assert.doesNotMatch(error.message, new RegExp(parserToken));
});

test("admission은 traversal 또는 redirect source path를 dereference 전에 거부한다", async () => {
  const documents = await admittedDocuments();
  const reference = structuredClone(documents.reference);
  reference.artifactPath = "../outside-source.json";
  reference.completenessEvidencePath = "tools/datapack/sources/redirected-evidence.json";
  withBuildNow(() => assert.throws(() => validateAdmittedSourceDocuments(
    documents.contract, reference, documents.source, documents.completeness,
    sha256(documents.sourceBytes), sha256(documents.completenessBytes),
  ), /ADMITTED source contract/));
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

test("self-consistent topology input contract도 static admission과 다르면 거부한다", async (context) => {
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
  candidate.contract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity = {
    id: "capital",
    sha256: admittedInput.gzipSha256,
    sqliteSha256: mutatedSqliteSha,
    byteSize: admittedInput.byteSize,
  };
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

test("admission document와 station/topology input identity는 exact binding을 요구한다", async (context) => {
  const { contract, reference, source, completeness, sourceBytes, completenessBytes } =
    await admittedDocuments();
  withBuildNow(() => assert.doesNotThrow(() => validateAdmittedSourceDocuments(
    contract, reference, source, completeness, sha256(sourceBytes), sha256(completenessBytes),
  )));
  const invalidCompleteness = structuredClone(completeness);
  invalidCompleteness.validationStatus = "UNSUPPORTED";
  withBuildNow(() => assert.throws(() => validateAdmittedSourceDocuments(
    contract, reference, source, invalidCompleteness, sha256(sourceBytes), sha256(completenessBytes),
  ), /source identity is invalid/));
  const invalidStationSource = structuredClone(source);
  invalidStationSource.stationCatalogPackIdentity.extra = true;
  await assert.rejects(admittedTopologySource(reference, invalidStationSource),
    /station catalog identity is invalid/);
});

test("authenticated completeness도 exact station identity와 no-legacy를 요구한다", async (context) => {
  const cases = [
    ["missing", (completeness) => { delete completeness.stationCatalogPackIdentity; }],
    ["extra", (completeness) => { completeness.stationCatalogPackIdentity.extra = true; }],
    ["mismatch", (completeness) => {
      completeness.stationCatalogPackIdentity.payloadSha256 = "9".repeat(64);
    }],
    ["canonical", (completeness) => { completeness.canonicalPackIdentity = {}; }],
    ["readmissions", (completeness) => { completeness.readmissions = []; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const documents = await admittedDocuments();
      mutate(documents.completeness);
      rebindAdmissionDocuments(documents);
      withBuildNow(() => assert.throws(() => validateAdmittedSourceDocuments(
        documents.contract,
        documents.reference,
        documents.source,
        documents.completeness,
        sha256(documents.sourceBytes),
        sha256(documents.completenessBytes),
      ), /legacy admission is forbidden|station catalog identity/));
    });
  }
});

test("v18 legacy evidence schema는 v19 two-domain admission schema로 migration한다", async (context) => {
  const fixture = await createFixture(context, { version: 18, legacyEvidence: true });
  applyTopology(fixture.sqlitePath, fixture.topology, admissionEvidenceFrom(fixture.contract));
  const database = new DatabaseSync(fixture.sqlitePath, { readOnly: true });
  try {
    assert.equal(database.prepare(`SELECT source_issue FROM route_service_artifact_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'`).get().source_issue, 2135);
    const columns = database.prepare("PRAGMA table_info(route_service_artifact_evidence)")
      .all().map(({ name }) => name);
    assert.deepEqual(columns.filter((name) => name.startsWith("canonical_pack_")), [
      "canonical_pack_id", "canonical_pack_sha256", "canonical_pack_sqlite_sha256",
    ]);
    assert.equal(database.prepare(`SELECT source_issue FROM route_service_station_catalog_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'`).get().source_issue, 2649);
  } finally { database.close(); }
});

test("route service evidence domain split은 v18 mixed row를 v19의 두 독립 table로 원자적으로 교체한다", async (context) => {
  const fixture = await createFixture(context, { version: 18, legacyEvidence: true });
  applyTopology(fixture.sqlitePath, fixture.topology, admissionEvidenceFrom(fixture.contract));
  const database = new DatabaseSync(fixture.sqlitePath, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 19);
    assert.deepEqual(database.prepare("PRAGMA table_info(route_service_artifact_evidence)")
      .all().map(({ name }) => name), [
      "service_class", "timetable_artifact_id", "timetable_artifact_sha256",
      "canonical_pack_id", "canonical_pack_sha256", "canonical_pack_sqlite_sha256",
      "admission_status", "admission_eligible", "fresh_until", "source_issue",
    ]);
    assert.deepEqual(database.prepare("PRAGMA table_info(route_service_station_catalog_evidence)")
      .all().map(({ name }) => name), [
      "service_class", "station_catalog_artifact_kind", "station_catalog_manifest_version",
      "station_catalog_pack_id", "station_catalog_station_set_sha256",
      "station_catalog_payload_sha256", "station_catalog_manifest_sha256",
      "admission_status", "admission_eligible", "fresh_until", "source_issue",
    ]);
  } finally { database.close(); }
});

test("route service evidence domain split은 ready v19의 stale row도 두 domain exact tuple로 교체한다", async (context) => {
  const fixture = await createFixture(context);
  const evidence = admissionEvidenceFrom(fixture.contract);
  applyTopology(fixture.sqlitePath, fixture.topology, evidence);
  const database = new DatabaseSync(fixture.sqlitePath);
  try {
    database.prepare(`UPDATE route_service_artifact_evidence
      SET canonical_pack_sha256 = ? WHERE service_class = 'ITX_CHEONGCHUN'`).run("f".repeat(64));
  } finally { database.close(); }
  applyTopology(fixture.sqlitePath, fixture.topology, evidence);
  const output = new DatabaseSync(fixture.sqlitePath, { readOnly: true });
  try {
    assert.equal(output.prepare(`SELECT canonical_pack_sha256 AS canonicalPackSha256
      FROM route_service_artifact_evidence WHERE service_class = 'ITX_CHEONGCHUN'`).get().canonicalPackSha256,
    evidence.artifactEvidence.canonicalPackSha256);
    assert.equal(output.prepare("PRAGMA user_version").get().user_version, 19);
  } finally { output.close(); }
});

test("route service evidence domain split은 one-domain missing 또는 freshness mismatch input에서 database mutation 없이 실패한다", async (context) => {
  const fixture = await createFixture(context);
  const before = sha256(await readFile(fixture.sqlitePath));
  const evidence = admissionEvidenceFrom(fixture.contract);
  const missingStation = structuredClone(evidence);
  delete missingStation.stationCatalogEvidence;
  assert.throws(() => applyTopology(fixture.sqlitePath, fixture.topology, missingStation),
    /independent current route service evidence/);
  assert.equal(sha256(await readFile(fixture.sqlitePath)), before);
  const mismatchedFreshness = structuredClone(evidence);
  mismatchedFreshness.stationCatalogEvidence.freshUntil = "2099-01-02T00:00:00.000Z";
  assert.throws(() => applyTopology(fixture.sqlitePath, fixture.topology, mismatchedFreshness),
    /independent current route service evidence/);
  assert.equal(sha256(await readFile(fixture.sqlitePath)), before);
});

test("route service evidence domain split은 malformed v19 station table을 mutation 없이 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const database = new DatabaseSync(fixture.sqlitePath);
  try {
    const weakened = database.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'route_service_station_catalog_evidence'`).get().sql
      .replace(" AND station_catalog_payload_sha256 NOT GLOB '*[^0-9a-f]*'", "");
    database.exec("DROP TABLE route_service_station_catalog_evidence");
    database.exec(weakened);
  } finally { database.close(); }
  const before = sha256(await readFile(fixture.sqlitePath));
  assert.throws(() => applyTopology(fixture.sqlitePath, fixture.topology, admissionEvidenceFrom(fixture.contract)),
    /v19 route service evidence schema is malformed or partial/);
  assert.equal(sha256(await readFile(fixture.sqlitePath)), before);
});

test("route service evidence domain split은 v19 one-domain count mismatch를 mutation 없이 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const database = new DatabaseSync(fixture.sqlitePath);
  database.exec("DELETE FROM route_service_station_catalog_evidence");
  database.close();
  const before = sha256(await readFile(fixture.sqlitePath));
  assert.throws(() => applyTopology(fixture.sqlitePath, fixture.topology, admissionEvidenceFrom(fixture.contract)),
    /requires exactly one row in each domain/);
  assert.equal(sha256(await readFile(fixture.sqlitePath)), before);
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
    assert.equal(output.prepare("PRAGMA user_version").get().user_version, 19);
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
  const fixture = await createFixture(context, { version: 20 });
  const before = sha256(await readFile(fixture.sqlitePath));
  assert.throws(() => applyTopology(fixture.sqlitePath, fixture.topology, admissionEvidenceFrom(fixture.contract)),
    /does not support catalog user_version/);
  assert.equal(sha256(await readFile(fixture.sqlitePath)), before);
});

test("current source admission은 canonical/readmission/UNCHANGED_AUTO를 받지 않는다", async (context) => {
  const { reference, source } = await admittedDocuments();
  const cases = [
    ["canonical", (candidate) => { candidate.canonicalPackIdentity = {}; }],
    ["readmissions", (candidate) => { candidate.readmissions = []; }],
    ["unchanged", (candidate, candidateReference) => {
      candidateReference.promotion.mode = "UNCHANGED_AUTO";
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const candidate = structuredClone(source);
      const candidateReference = structuredClone(reference);
      candidateReference.sha256 = reference.promotion.previousArtifactSha256;
      mutate(candidate, candidateReference);
      await assert.rejects(admittedTopologySource(candidateReference, candidate),
        /legacy admission is forbidden/);
    });
  }
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

test("current source static admission은 exact topology input tuple을 반환한다", async () => {
  const { reference, source } = await admittedDocuments();
  reference.sha256 = reference.promotion.previousArtifactSha256;
  const admitted = await admittedTopologySource(reference, source);
  assert.deepEqual({
    id: "capital",
    sha256: admitted.gzipSha256,
    sqliteSha256: admitted.sqliteSha256,
    byteSize: admitted.byteSize,
  }, admittedTopologyInputs.get(reference.sha256));
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

test("topology input gzip와 SQLite identity 변조를 각각 거부한다", async (context) => {
  const fixture = await createFixture(context);
  const sqliteBytes = await readFile(fixture.sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const candidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
  await context.test("gzip", () => {
    candidate.contract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity.sha256 = "0".repeat(64);
    assert.throws(validateEvidenceCandidate(candidate, fixture.topology, gzipBytes),
      /evidence or bundled pack index is stale/);
  });
  await context.test("sqlite", () => {
    const sqliteCandidate = selfConsistentEvidence(fixture.contract, fixture.source, fixture.topology, gzipBytes, sqliteBytes);
    sqliteCandidate.contract.officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity.sqliteSha256 = "0".repeat(64);
    assert.throws(validateEvidenceCandidate(sqliteCandidate, fixture.topology, gzipBytes),
      /evidence or bundled pack index is stale/);
  });
});

test("versions 15와 20은 mutation 없이 거부한다", async (context) => {
  for (const version of [15, 20]) {
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
