import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  admittedTopologySource,
  isUnchangedRefresh,
} from "./apply-itx-topology-to-bundled-pack.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const freshBuildEnv = {
  ...process.env,
  EASYSUBWAY_DATAPACK_BUILD_NOW: "2026-07-16T00:00:00.000Z",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function rejectedMutatedSource(context, mutate, expected) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-topology-reject-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  const contractPath = path.join(directory, "contract.json");
  const sourcePath = path.join(directory, "source.json");
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const source = JSON.parse(await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));
  const packBytes = await readFile(packPath);
  source.canonicalPackIdentity.sha256 = sha256(packBytes);
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256 = sha256(packBytes);
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = sha256(gunzipSync(packBytes));
  mutate(source);
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  await writeFile(sourcePath, sourceBytes);
  contract.sourceTimetableArtifact.artifactPath = sourcePath;
  contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  return assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--contract", contractPath,
    "--evidence", evidencePath,
  ], { cwd: root, env: freshBuildEnv }), expected);
}

async function rejectedMutatedAdmissionDocuments(context, mutate, expected) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-topology-admission-reject-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  const contractPath = path.join(directory, "contract.json");
  const sourcePath = path.join(directory, "source.json");
  const completenessPath = path.join(directory, "completeness.json");
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const source = JSON.parse(await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));
  const completeness = JSON.parse(await readFile(
    path.join(root, contract.sourceTimetableArtifact.completenessEvidencePath), "utf8"));
  const packBytes = await readFile(packPath);
  Object.assign(source.canonicalPackIdentity, {
    sha256: sha256(packBytes),
  });
  Object.assign(contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity, {
    sha256: sha256(packBytes),
    sqliteSha256: sha256(gunzipSync(packBytes)),
  });
  mutate({ contract, source, completeness });
  const completenessBytes = Buffer.from(`${JSON.stringify(completeness, null, 2)}\n`);
  await writeFile(completenessPath, completenessBytes);
  source.completenessEvidenceSha256 = sha256(completenessBytes);
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  await writeFile(sourcePath, sourceBytes);
  Object.assign(contract.sourceTimetableArtifact, {
    artifactPath: sourcePath,
    sha256: sha256(sourceBytes),
    completenessEvidencePath: completenessPath,
    completenessEvidenceSha256: sha256(completenessBytes),
  });
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  return assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--contract", contractPath,
    "--evidence", evidencePath,
  ], { cwd: root, env: freshBuildEnv }), expected);
}

async function rejectedTamperedEvidence(context, mutate) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-topology-stale-evidence-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
  const evidence = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json"), "utf8"));
  mutate(evidence);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--evidence", evidencePath,
    "--check",
  ], { cwd: root, env: freshBuildEnv }), /evidence or bundled pack index is stale/);
}

test("#2135 ADMITTED source를 Mobile topology-only edge와 evidence로 materialize한다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-topology-pack-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  const secondPackPath = path.join(directory, "capital-second.sqlite.gz");
  const secondIndexPath = path.join(directory, "index-second.json");
  const secondEvidencePath = path.join(directory, "evidence-second.json");
  const contractPath = path.join(directory, "contract.json");
  const sourcePath = path.join(directory, "source.json");
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
  await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const source = JSON.parse(await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));
  const packBytes = await readFile(packPath);
  source.canonicalPackIdentity.sha256 = sha256(packBytes);
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256 = sha256(packBytes);
  contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = sha256(gunzipSync(packBytes));
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  await writeFile(sourcePath, sourceBytes);
  contract.sourceTimetableArtifact.artifactPath = sourcePath;
  contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await copyFile(packPath, secondPackPath);
  await copyFile(indexPath, secondIndexPath);

  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--contract", contractPath,
    "--evidence", evidencePath,
  ], { cwd: root, env: freshBuildEnv });
  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", secondPackPath,
    "--index", secondIndexPath,
    "--contract", contractPath,
    "--evidence", secondEvidencePath,
  ], { cwd: root, env: freshBuildEnv });
  assert.deepEqual(
    await Promise.all([readFile(secondPackPath), readFile(secondIndexPath), readFile(secondEvidencePath)]),
    await Promise.all([readFile(packPath), readFile(indexPath), readFile(evidencePath)]),
  );

  const sqlitePath = path.join(directory, "capital.sqlite");
  await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
  const database = new DatabaseSync(sqlitePath);
  try {
    const edges = database.prepare(`
      SELECT id, from_node_id, to_node_id, duration_seconds, service_pattern, service_class
      FROM network_edges
      WHERE service_class = 'ITX_CHEONGCHUN'
    `).all();
    assert.equal(edges.length, 48);
    assert.equal(new Set(edges.map(({ id }) => id)).size, 48);
    assert.equal(new Set(edges.map(({ from_node_id, to_node_id }) =>
      `${from_node_id}->${to_node_id}`)).size, 48);
    assert.ok(edges.every((edge) => edge.duration_seconds === 0));
    assert.ok(edges.every((edge) => edge.service_pattern === "EXPRESS"));
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM transit_trips WHERE service_class = 'ITX_CHEONGCHUN'
    `).get().count, 0);
    assert.deepEqual({ ...database.prepare(`
      SELECT service_class AS serviceClass, timetable_artifact_id AS timetableArtifactId,
             timetable_artifact_sha256 AS timetableArtifactSha256,
             canonical_pack_id AS canonicalPackId, canonical_pack_sha256 AS canonicalPackSha256,
             canonical_pack_sqlite_sha256 AS canonicalPackSqliteSha256,
             admission_status AS admissionStatus, admission_eligible AS admissionEligible,
             fresh_until AS freshUntil, source_issue AS sourceIssue
      FROM route_service_artifact_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'
    `).get() }, {
      serviceClass: "ITX_CHEONGCHUN",
      timetableArtifactId: contract.sourceTimetableArtifact.artifactId,
      timetableArtifactSha256: contract.sourceTimetableArtifact.sha256,
      canonicalPackId: contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.id,
      canonicalPackSha256: contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256,
      canonicalPackSqliteSha256:
        contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256,
      admissionStatus: "ADMITTED",
      admissionEligible: 1,
      freshUntil: contract.sourceTimetableArtifact.freshUntil,
      sourceIssue: 2135,
    });
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 18);
  } finally {
    database.close();
  }

  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.sourceIssue, 2135);
  assert.equal(evidence.serviceId, "ITX_CHEONGCHUN");
  assert.equal(evidence.topology.stationMembershipCount, 18);
  assert.equal(evidence.topology.servedStationCount, 14);
  assert.equal(evidence.topology.edgeCount, 48);
  assert.equal(evidence.topology.durationSecondsEmbedded, false);
  assert.equal(evidence.topology.fareEmbedded, false);
  assert.match(evidence.topology.sha256, /^[a-f0-9]{64}$/);

  const beforeCheck = await Promise.all([
    readFile(packPath), readFile(indexPath), readFile(evidencePath),
  ]);
  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--contract", contractPath,
    "--evidence", evidencePath,
    "--check",
  ], { cwd: root, env: freshBuildEnv });
  const afterCheck = await Promise.all([
    readFile(packPath), readFile(indexPath), readFile(evidencePath),
  ]);
  assert.deepEqual(afterCheck, beforeCheck);
  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--contract", contractPath,
    "--evidence", evidencePath,
  ], { cwd: root, env: freshBuildEnv });
  assert.deepEqual(await Promise.all([
    readFile(packPath), readFile(indexPath), readFile(evidencePath),
  ]), beforeCheck);
});

test("tracked production ITX topology evidence와 bundled pack은 --check를 통과한다", async () => {
  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--check",
  ], { cwd: root, env: freshBuildEnv });
});

test("UNCHANGED_AUTO historical fallback은 immediate previous source 변경을 거부한다", async () => {
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const source = JSON.parse(await readFile(
    path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));
  const previous = JSON.parse(await readFile(
    path.join(root, contract.sourceTimetableArtifact.promotion.previousArtifactPath), "utf8"));
  previous.normalizedSnapshotSets[0].sets.stationSet.push("station-diverged-from-current");

  assert.equal(isUnchangedRefresh(contract.sourceTimetableArtifact, source, previous), false);
});

test("historical fallback은 admitted SQLite identity 변조를 거부한다", async () => {
  const contractPath = path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const source = JSON.parse(await readFile(
    path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));
  const evidence = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json"), "utf8"));
  evidence.pack.inputSqliteSha256 = "0".repeat(64);

  await assert.rejects(
    admittedTopologySource(contract.sourceTimetableArtifact, source, evidence, contractPath),
    /admitted canonical input identity mismatch/,
  );
});

test("--check는 hash가 갱신된 bundled pack의 foreign key 손상도 거부한다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-topology-corrupt-pack-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const sqlitePath = path.join(directory, "capital.sqlite");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  const contractPath = path.join(directory, "contract.json");
  const packBytes = await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  await writeFile(sqlitePath, gunzipSync(packBytes));
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    UPDATE transit_stop_times
    SET station_id = 'station-missing-itx-check'
    WHERE rowid = (SELECT MIN(rowid) FROM transit_stop_times);
  `);
  database.close();

  const sqliteBytes = await readFile(sqlitePath);
  const corruptedPackBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  await writeFile(packPath, corruptedPackBytes);
  const index = JSON.parse(await readFile(
    path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"));
  Object.assign(index.packs.find(({ id }) => id === "capital"), {
    sha256: sha256(corruptedPackBytes),
    sqliteSha256: sha256(sqliteBytes),
    byteSize: corruptedPackBytes.length,
  });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const evidence = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json"), "utf8"));
  const historicalSourcePath = `tools/datapack/sources/${evidence.sourceArtifact.id}.json`;
  const historicalSource = JSON.parse(await readFile(path.join(root, historicalSourcePath), "utf8"));
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  Object.assign(contract.sourceTimetableArtifact, {
    artifactId: evidence.sourceArtifact.id,
    artifactPath: historicalSourcePath,
    sha256: evidence.sourceArtifact.sha256,
    completenessEvidencePath: historicalSourcePath.replace(/\.json$/, "-completeness-evidence.json"),
    completenessEvidenceSha256: evidence.sourceArtifact.completenessEvidenceSha256,
    freshUntil: evidence.sourceArtifact.freshUntil,
  });
  Object.assign(contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity, {
    id: evidence.pack.id,
    sha256: historicalSource.canonicalPackIdentity.sha256,
    sqliteSha256: evidence.pack.inputSqliteSha256,
  });
  Object.assign(evidence.pack, {
    outputSha256: sha256(corruptedPackBytes),
    outputSqliteSha256: sha256(sqliteBytes),
    byteSize: corruptedPackBytes.length,
    byteSizeDelta: corruptedPackBytes.length - evidence.pack.inputByteSize,
  });
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--contract", contractPath,
    "--evidence", evidencePath,
    "--check",
  ], { cwd: root, env: freshBuildEnv }), /foreign_key_check failed/);
});

test("ITX topology check는 self-consistent input size evidence 변조를 거부한다", async (context) => {
  await rejectedTamperedEvidence(context, (evidence) => {
    evidence.pack.inputByteSize = evidence.pack.byteSize;
    evidence.pack.byteSizeDelta = 0;
  });
});

test("ITX topology는 freshUntil 경계부터 ADMITTED source를 거부한다", async () => {
  const command = [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--check",
  ];
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const boundary = Date.parse(contract.sourceTimetableArtifact.freshUntil);
  await execFileAsync(process.execPath, command, {
    cwd: root,
    env: {
      ...process.env,
      EASYSUBWAY_DATAPACK_BUILD_NOW: new Date(boundary - 1).toISOString(),
    },
  });
  await assert.rejects(execFileAsync(process.execPath, command, {
    cwd: root,
    env: {
      ...process.env,
      EASYSUBWAY_DATAPACK_BUILD_NOW: new Date(boundary).toISOString(),
    },
  }), /ITX topology source artifact is expired/);
});

test("ITX topology는 admission document schema identity 변조를 거부한다", async (context) => {
  const cases = [
    ["contract", ({ contract }) => { contract.schemaVersion = 999; }],
    ["source", ({ source }) => { source.schemaVersion = 999; }],
    ["completeness", ({ completeness }) => { completeness.schemaVersion = 999; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async (childContext) => {
      await rejectedMutatedAdmissionDocuments(
        childContext,
        mutate,
        /ADMITTED source contract|source identity is invalid/,
      );
    });
  }
});

test("ITX topology는 contract canonical gzip identity 변조를 거부한다", async (context) => {
  await rejectedMutatedAdmissionDocuments(context, ({ contract }) => {
    contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sha256 = "0".repeat(64);
  }, /canonical input pack identity mismatch/);
});

test("ITX topology는 contract canonical SQLite identity 변조를 거부한다", async (context) => {
  await rejectedMutatedAdmissionDocuments(context, ({ contract }) => {
    contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity.sqliteSha256 = "0".repeat(64);
  }, /canonical input pack identity mismatch/);
});

test("기존 source_issue=2116 제약의 v18 pack을 2135 admission schema로 migration한다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-topology-v18-evidence-migration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const sqlitePath = path.join(directory, "capital.sqlite");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  const contractPath = path.join(directory, "contract.json");
  const sourcePath = path.join(directory, "source.json");
  await writeFile(sqlitePath, gunzipSync(await readFile(
    path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))));
  const database = new DatabaseSync(sqlitePath);
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
      source_issue INTEGER NOT NULL,
      CHECK (source_issue = 2116)
    );
    PRAGMA user_version = 18;
  `);
  database.close();
  const inputSqliteBytes = await readFile(sqlitePath);
  const inputPackBytes = gzipSync(inputSqliteBytes, { level: 9, mtime: 0 });
  await writeFile(packPath, inputPackBytes);
  const index = JSON.parse(await readFile(
    path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"));
  Object.assign(index.packs.find(({ id }) => id === "capital"), {
    sha256: sha256(inputPackBytes),
    sqliteSha256: sha256(inputSqliteBytes),
    byteSize: inputPackBytes.length,
  });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const source = JSON.parse(await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));
  Object.assign(source.canonicalPackIdentity, { sha256: sha256(inputPackBytes) });
  Object.assign(contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity, {
    sha256: sha256(inputPackBytes),
    sqliteSha256: sha256(inputSqliteBytes),
  });
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  await writeFile(sourcePath, sourceBytes);
  Object.assign(contract.sourceTimetableArtifact, {
    artifactPath: sourcePath,
    sha256: sha256(sourceBytes),
  });
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--contract", contractPath,
    "--evidence", evidencePath,
  ], { cwd: root, env: freshBuildEnv });

  await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
  const migrated = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    assert.equal(migrated.prepare(`
      SELECT source_issue FROM route_service_artifact_evidence
      WHERE service_class = 'ITX_CHEONGCHUN'
    `).get().source_issue, 2135);
    assert.match(migrated.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'route_service_artifact_evidence'
    `).get().sql, /source_issue IN \(2116, 2135\)/);
  } finally {
    migrated.close();
  }
});

test("v16 bundled pack 변환은 ITX topology 외 timetable·calendar·fare row를 바꾸지 않는다", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "itx-topology-v16-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const sqlitePath = path.join(directory, "capital.sqlite");
  const indexPath = path.join(directory, "index.json");
  const evidencePath = path.join(directory, "evidence.json");
  const contractPath = path.join(directory, "contract.json");
  const sourcePath = path.join(directory, "source.json");
  await writeFile(sqlitePath, gunzipSync(await readFile(
    path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))));
  const inputDatabase = new DatabaseSync(sqlitePath);
  const preservedTables = [
    "official_od_fare_quotes",
    "service_calendar_dates",
    "service_calendars",
    "transit_feed_info",
    "transit_frequencies",
    "transit_routes",
    "transit_stop_times",
    "transit_trips",
  ];
  inputDatabase.exec(`
    DELETE FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN';
    DROP TABLE route_service_artifact_evidence;
    ALTER TABLE network_edges DROP COLUMN service_class;
    ALTER TABLE transit_trips DROP COLUMN service_class;
    PRAGMA user_version = 16;
  `);
  const beforeRows = Object.fromEntries(preservedTables.map((table) => [
    table,
    JSON.parse(JSON.stringify(inputDatabase.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),
  ]));
  inputDatabase.close();
  const inputSqliteBytes = await readFile(sqlitePath);
  const inputPackBytes = gzipSync(inputSqliteBytes, { level: 9, mtime: 0 });
  await writeFile(packPath, inputPackBytes);

  const index = JSON.parse(await readFile(
    path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"));
  Object.assign(index.packs.find(({ id }) => id === "capital"), {
    sha256: sha256(inputPackBytes),
    sqliteSha256: sha256(inputSqliteBytes),
    byteSize: inputPackBytes.length,
  });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const contract = JSON.parse(await readFile(
    path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
  const source = JSON.parse(await readFile(path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));
  Object.assign(source.canonicalPackIdentity, {
    sha256: sha256(inputPackBytes),
    sqliteSha256: sha256(inputSqliteBytes),
  });
  Object.assign(contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity, {
    sha256: sha256(inputPackBytes),
    sqliteSha256: sha256(inputSqliteBytes),
  });
  const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
  await writeFile(sourcePath, sourceBytes);
  Object.assign(contract.sourceTimetableArtifact, {
    artifactPath: sourcePath,
    sha256: sha256(sourceBytes),
  });
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  await execFileAsync(process.execPath, [
    "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
    "--pack", packPath,
    "--index", indexPath,
    "--contract", contractPath,
    "--evidence", evidencePath,
  ], { cwd: root, env: freshBuildEnv });

  await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
  const outputDatabase = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    assert.equal(outputDatabase.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(outputDatabase.prepare(`
      SELECT COUNT(*) AS count FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN'
    `).get().count, 48);
    for (const table of preservedTables) {
      const afterRows = outputDatabase.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
        .map((row) => {
          if (table !== "transit_trips") return row;
          const { service_class: _serviceClass, ...unchanged } = row;
          return unchanged;
        });
      assert.deepEqual(
        JSON.parse(JSON.stringify(afterRows)),
        beforeRows[table],
        `${table} rows must stay unchanged`,
      );
    }
  } finally {
    outputDatabase.close();
  }
});

test("ITX topology materializer는 지원 범위 밖 catalog version을 변경 없이 거부한다", async (context) => {
  for (const version of [15, 19]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `itx-topology-v${version}-`));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const packPath = path.join(directory, "capital.sqlite.gz");
    const sqlitePath = path.join(directory, "capital.sqlite");
    const indexPath = path.join(directory, "index.json");
    const evidencePath = path.join(directory, "evidence.json");
    const contractPath = path.join(directory, "contract.json");
    const sourcePath = path.join(directory, "source.json");
    await writeFile(sqlitePath, gunzipSync(await readFile(
      path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))));
    const database = new DatabaseSync(sqlitePath);
    database.exec(`PRAGMA user_version = ${version}`);
    database.close();
    const sqliteBytes = await readFile(sqlitePath);
    const packBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    await writeFile(packPath, packBytes);
    const index = JSON.parse(await readFile(
      path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"));
    Object.assign(index.packs.find(({ id }) => id === "capital"), {
      sha256: sha256(packBytes),
      sqliteSha256: sha256(sqliteBytes),
      byteSize: packBytes.length,
    });
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    const contract = JSON.parse(await readFile(
      path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"), "utf8"));
    const source = JSON.parse(await readFile(
      path.join(root, contract.sourceTimetableArtifact.artifactPath), "utf8"));
    Object.assign(source.canonicalPackIdentity, {
      sha256: sha256(packBytes),
      sqliteSha256: sha256(sqliteBytes),
    });
    Object.assign(contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity, {
      sha256: sha256(packBytes),
      sqliteSha256: sha256(sqliteBytes),
    });
    const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
    await writeFile(sourcePath, sourceBytes);
    Object.assign(contract.sourceTimetableArtifact, {
      artifactPath: sourcePath,
      sha256: sha256(sourceBytes),
    });
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/apply-itx-topology-to-bundled-pack.mjs",
      "--pack", packPath,
      "--index", indexPath,
      "--contract", contractPath,
      "--evidence", evidencePath,
    ], { cwd: root, env: freshBuildEnv }), /does not support catalog user_version/);
    assert.equal(sha256(await readFile(packPath)), sha256(packBytes));
  }
});

test("--check는 topology evidence의 파생 count 변조를 거부한다", async (context) => {
  await rejectedTamperedEvidence(context, (evidence) => {
    evidence.topology.stationMembershipCount += 1;
  });
});

test("--check는 일관되게 조작된 size budget evidence도 거부한다", async (context) => {
  await rejectedTamperedEvidence(context, (evidence) => {
    evidence.pack.inputByteSize = 0;
    evidence.pack.byteSizeDelta = evidence.pack.byteSize;
  });
});

test("--check는 topology evidence schema identity 변조를 거부한다", async (context) => {
  await rejectedTamperedEvidence(context, (evidence) => {
    evidence.schemaVersion = 999;
    evidence.artifactKind = "unrelated-artifact";
  });
});

test("ITX topology는 canonical station/line endpoint가 bundled route map에 있어야 한다", async (context) => {
  await rejectedMutatedSource(context, (source) => {
    const station = source.stationRosters[0].stations[0];
    const originalId = station.canonicalStationId;
    station.canonicalStationId = "station-missing-itx-endpoint";
    for (const stop of source.stationSequences.flatMap(({ stops }) => stops)) {
      if (stop.stationId === originalId) stop.stationId = station.canonicalStationId;
    }
    for (const stopTime of source.transitStopTimes) {
      if (stopTime.stationId === originalId) stopTime.stationId = station.canonicalStationId;
    }
  }, /canonical station membership is missing/);
});

test("ITX topology는 source와 completeness evidence의 exact 결합을 요구한다", async (context) => {
  await rejectedMutatedSource(context, (source) => {
    source.completenessEvidenceSha256 = "0".repeat(64);
  }, /source identity is invalid/);
});

test("ITX topology는 down sequence가 up과 같은 방향이면 거부한다", async (context) => {
  await rejectedMutatedSource(context, (source) => {
    for (const sequence of source.stationSequences.filter(({ directionId }) => directionId === "down")) {
      sequence.stops.reverse();
    }
  }, /direction is invalid/);
});

test("ITX topology는 U/D 양방향 station sequence가 모두 있어야 한다", async (context) => {
  await rejectedMutatedSource(context, (source) => {
    source.stationSequences = source.stationSequences.filter(({ directionId }) => directionId === "up");
  }, /requires U\/D station sequences/);
});

test("ITX topology는 admitted service stop 전체를 보존해야 한다", async (context) => {
  await rejectedMutatedSource(context, (source) => {
    source.stationSequences = [
      source.stationSequences.find(({ directionId }) => directionId === "up"),
      source.stationSequences.find(({ directionId }) => directionId === "down"),
    ];
  }, /cover the admitted service stop set/);
});

test("ITX topology는 service stop을 두 개의 고립 component로 나누지 않는다", async (context) => {
  await rejectedMutatedSource(context, (source) => {
    const stops = [...new Map(source.stationSequences
      .flatMap(({ stops: sequenceStops }) => sequenceStops)
      .map((stop) => [`${stop.stationId}:${stop.lineId}`, stop])).values()]
      .sort((left, right) => left.corridorSequence - right.corridorSequence);
    const middle = Math.ceil(stops.length / 2);
    const groups = [stops.slice(0, middle), stops.slice(middle)];
    source.stationSequences = groups.flatMap((group, index) => [
      { trainNumber: `up-${index}`, directionId: "up", stops: group },
      { trainNumber: `down-${index}`, directionId: "down", stops: [...group].reverse() },
    ]);
  }, /service stop graph must be connected/);
});
