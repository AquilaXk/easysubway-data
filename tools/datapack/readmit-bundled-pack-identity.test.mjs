import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const TOOL = "tools/datapack/readmit-bundled-pack-identity.mjs";
const ITX_EDGE_COUNT = 48;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function itxEdgeRow(index) {
  return {
    id: `itx-edge-${index}`,
    from_node_id: `station-a${index}:line-itx:EXPRESS`,
    to_node_id: `station-b${index}:line-itx:EXPRESS`,
    duration_seconds: 60,
    distance_meters: 1000,
    edge_type: "RIDE",
    service_pattern: "EXPRESS",
    service_class: "ITX_CHEONGCHUN",
  };
}

// 최소 스키마(도구가 실제로 건드리는 테이블만)로 gzip sqlite pack을 만든다.
// unrelatedValue로 "ITX와 무관한" 변경을 주입해 재승인 대상 diff를 만든다.
function buildFixturePack({ unrelatedValue = "v1", edgeOverride = null } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "readmit-fixture-"));
  const sqlitePath = path.join(directory, "capital.sqlite");
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    PRAGMA user_version = 18;
    CREATE TABLE network_edges (
      id TEXT PRIMARY KEY, from_node_id TEXT, to_node_id TEXT, duration_seconds INTEGER,
      distance_meters INTEGER, edge_type TEXT, service_pattern TEXT, service_class TEXT
    );
    CREATE TABLE route_service_artifact_evidence (
      service_class TEXT PRIMARY KEY, timetable_artifact_id TEXT, timetable_artifact_sha256 TEXT,
      canonical_pack_id TEXT, canonical_pack_sha256 TEXT, canonical_pack_sqlite_sha256 TEXT,
      admission_status TEXT, admission_eligible INTEGER, fresh_until TEXT, source_issue INTEGER
    );
    CREATE TABLE station_lines (station_id TEXT, line_id TEXT, PRIMARY KEY(station_id, line_id));
    CREATE TABLE route_map_positions (station_id TEXT, line_id TEXT, x REAL, y REAL, PRIMARY KEY(station_id, line_id));
    CREATE TABLE unrelated_table (id TEXT PRIMARY KEY, value TEXT);
  `);
  const insertEdge = database.prepare(`
    INSERT INTO network_edges (id, from_node_id, to_node_id, duration_seconds, distance_meters, edge_type, service_pattern, service_class)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStationLine = database.prepare("INSERT INTO station_lines (station_id, line_id) VALUES (?, ?)");
  const insertPosition = database.prepare("INSERT INTO route_map_positions (station_id, line_id, x, y) VALUES (?, ?, ?, ?)");
  for (let index = 0; index < ITX_EDGE_COUNT; index += 1) {
    const row = (edgeOverride && edgeOverride.index === index) ? { ...itxEdgeRow(index), ...edgeOverride.patch } : itxEdgeRow(index);
    insertEdge.run(row.id, row.from_node_id, row.to_node_id, row.duration_seconds, row.distance_meters, row.edge_type, row.service_pattern, row.service_class);
    for (const nodeId of [row.from_node_id, row.to_node_id]) {
      const [stationId, lineId] = nodeId.split(":");
      insertStationLine.run(stationId, lineId);
      insertPosition.run(stationId, lineId, 0, 0);
    }
  }
  database.prepare(`
    INSERT INTO route_service_artifact_evidence (
      service_class, timetable_artifact_id, timetable_artifact_sha256, canonical_pack_id,
      canonical_pack_sha256, canonical_pack_sqlite_sha256, admission_status, admission_eligible,
      fresh_until, source_issue
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ITX_CHEONGCHUN", "artifact-1", "a".repeat(64), "capital", "b".repeat(64), "c".repeat(64),
    "ADMITTED", 1, "2999-01-01T00:00:00.000Z", 2135,
  );
  database.prepare("INSERT INTO unrelated_table (id, value) VALUES ('row-1', ?)").run(unrelatedValue);
  database.close();
  return { directory, sqlitePath };
}

async function packToGzipFile(sqlitePath, targetPath) {
  const sqliteBytes = await readFile(sqlitePath);
  const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  await writeFile(targetPath, gzipBytes);
  return { gzipBytes, sqliteBytes };
}

function identityOf(gzipBytes, sqliteBytes) {
  return { sha256: sha256(gzipBytes), sqliteSha256: sha256(sqliteBytes), byteSize: gzipBytes.length };
}

function baseEvidence(previousIdentity) {
  return {
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-mobile-topology-evidence",
    serviceId: "ITX_CHEONGCHUN",
    sourceIssue: 2135,
    sourceArtifact: { id: "src", sha256: "a".repeat(64), completenessEvidenceSha256: "b".repeat(64), freshUntil: "2999-01-01T00:00:00.000Z" },
    topology: {
      stationMembershipCount: 1, servedStationCount: 1, edgeCount: 48, directions: ["up", "down"],
      connectedComponentCount: 1, isolatedServedStationCount: 0, sha256: "c".repeat(64),
      durationSecondsEmbedded: false, fareEmbedded: false,
    },
    pack: {
      id: "capital",
      inputSha256: "d".repeat(64), inputSqliteSha256: "e".repeat(64), inputByteSize: 1000,
      outputSha256: previousIdentity.sha256, outputSqliteSha256: previousIdentity.sqliteSha256,
      byteSize: previousIdentity.byteSize, byteSizeDelta: previousIdentity.byteSize - 1000,
    },
  };
}

async function setupChainStart(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "readmit-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const previous = buildFixturePack({ unrelatedValue: "before" });
  context.after(() => rm(previous.directory, { recursive: true, force: true }));
  const previousPackPath = path.join(directory, "previous.sqlite.gz");
  const { gzipBytes: previousGzip, sqliteBytes: previousSqlite } = await packToGzipFile(previous.sqlitePath, previousPackPath);
  const previousIdentity = identityOf(previousGzip, previousSqlite);
  const evidencePath = path.join(directory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(baseEvidence(previousIdentity), null, 2)}\n`);
  return { directory, previousPackPath, previousIdentity, evidencePath };
}

test("생성 모드: ITX와 무관한 테이블만 바뀐 재승인은 evidence·row diff를 남기고 성공한다", async (context) => {
  const { directory, previousPackPath, evidencePath } = await setupChainStart(context);
  const next = buildFixturePack({ unrelatedValue: "after" });
  context.after(() => rm(next.directory, { recursive: true, force: true }));
  const newPackPath = path.join(directory, "new.sqlite.gz");
  await packToGzipFile(next.sqlitePath, newPackPath);

  await execFileAsync(process.execPath, [
    TOOL,
    "--pack", newPackPath,
    "--previous-pack", previousPackPath,
    "--evidence", evidencePath,
    "--provenance", "test 재승인",
  ], { cwd: root });

  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.readmissions.length, 1);
  const entry = evidence.readmissions[0];
  assert.equal(entry.provenance, "test 재승인");
  assert.equal(entry.itxSubgraph.unchanged, true);
  assert.equal(entry.itxSubgraph.edgeCount, ITX_EDGE_COUNT);
  const unrelatedDiff = entry.rowDiff.find((diff) => diff.table === "unrelated_table");
  assert.equal(unrelatedDiff.rowsChanged, 1);
  assert.equal(unrelatedDiff.detail.changed[0].previous.value, "before");
  assert.equal(unrelatedDiff.detail.changed[0].new.value, "after");
  assert.equal(evidence.pack.outputSha256, sha256(await readFile(newPackPath)));

  await execFileAsync(process.execPath, [
    TOOL, "--check", "--pack", newPackPath, "--evidence", evidencePath, "--genesis-pack", previousPackPath,
  ], { cwd: root });
});

test("생성 모드: --previous-pack이 tracked evidence의 output과 다르면 거부한다", async (context) => {
  const { directory, evidencePath } = await setupChainStart(context);
  const other = buildFixturePack({ unrelatedValue: "not-the-chain-start" });
  context.after(() => rm(other.directory, { recursive: true, force: true }));
  const wrongPreviousPath = path.join(directory, "wrong-previous.sqlite.gz");
  await packToGzipFile(other.sqlitePath, wrongPreviousPath);
  const newPackPath = path.join(directory, "new.sqlite.gz");
  await packToGzipFile(other.sqlitePath, newPackPath);

  await assert.rejects(execFileAsync(process.execPath, [
    TOOL, "--pack", newPackPath, "--previous-pack", wrongPreviousPath,
    "--evidence", evidencePath, "--provenance", "test",
  ], { cwd: root }), /--previous-pack does not match the currently tracked evidence/);
});

test("생성 모드: 새 pack이 직전 pack과 byte-identical이면 거부한다(무의미한 재승인)", async (context) => {
  const { previousPackPath, evidencePath } = await setupChainStart(context);
  await assert.rejects(execFileAsync(process.execPath, [
    TOOL, "--pack", previousPackPath, "--previous-pack", previousPackPath,
    "--evidence", evidencePath, "--provenance", "test",
  ], { cwd: root }), /nothing to readmit/);
});

test("생성 모드: ITX_CHEONGCHUN network_edges가 하나라도 바뀌면 거부한다(ITX 위상 변조는 재승인 대상이 아니다)", async (context) => {
  const { directory, previousPackPath, evidencePath } = await setupChainStart(context);
  const tampered = buildFixturePack({
    unrelatedValue: "after",
    edgeOverride: { index: 0, patch: { duration_seconds: 999999 } },
  });
  context.after(() => rm(tampered.directory, { recursive: true, force: true }));
  const newPackPath = path.join(directory, "new.sqlite.gz");
  await packToGzipFile(tampered.sqlitePath, newPackPath);

  await assert.rejects(execFileAsync(process.execPath, [
    TOOL, "--pack", newPackPath, "--previous-pack", previousPackPath,
    "--evidence", evidencePath, "--provenance", "test",
  ], { cwd: root }), /ITX_CHEONGCHUN network_edges differ/);
});

test("생성 모드: route_service_artifact_evidence(ITX)가 바뀌면 거부한다", async (context) => {
  const { directory, previousPackPath, evidencePath } = await setupChainStart(context);
  const next = buildFixturePack({ unrelatedValue: "after" });
  context.after(() => rm(next.directory, { recursive: true, force: true }));
  const database = new DatabaseSync(next.sqlitePath);
  database.exec("UPDATE route_service_artifact_evidence SET admission_eligible = 0 WHERE service_class = 'ITX_CHEONGCHUN'");
  database.close();
  const newPackPath = path.join(directory, "new.sqlite.gz");
  await packToGzipFile(next.sqlitePath, newPackPath);

  await assert.rejects(execFileAsync(process.execPath, [
    TOOL, "--pack", newPackPath, "--previous-pack", previousPackPath,
    "--evidence", evidencePath, "--provenance", "test",
  ], { cwd: root }), /route_service_artifact_evidence differs/);
});

test("생성 모드: ITX edge가 참조하는 station_id:line_id가 새 pack에서 사라지면 거부한다", async (context) => {
  const { directory, previousPackPath, evidencePath } = await setupChainStart(context);
  const next = buildFixturePack({ unrelatedValue: "after" });
  context.after(() => rm(next.directory, { recursive: true, force: true }));
  const database = new DatabaseSync(next.sqlitePath);
  database.exec("DELETE FROM route_map_positions WHERE station_id = 'station-a0'");
  database.close();
  const newPackPath = path.join(directory, "new.sqlite.gz");
  await packToGzipFile(next.sqlitePath, newPackPath);

  await assert.rejects(execFileAsync(process.execPath, [
    TOOL, "--pack", newPackPath, "--previous-pack", previousPackPath,
    "--evidence", evidencePath, "--provenance", "test",
  ], { cwd: root }), /ITX station membership missing/);
});

test("검증 모드: 재승인 없이 pack 바이트만 직접 바꾸면(무단 변조) --check가 거부한다", async (context) => {
  const { directory, previousPackPath, evidencePath } = await setupChainStart(context);
  // previousPackPath 자체를 evidence가 pin한 "현재 output"으로 삼아 --check.
  // 그 파일을 재승인 없이 직접 한 바이트 바꿔서 라이브 pack으로 제시한다.
  const tamperedLivePath = path.join(directory, "tampered-live.sqlite.gz");
  const original = await readFile(previousPackPath);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0xff;
  await writeFile(tamperedLivePath, tampered);

  await assert.rejects(execFileAsync(process.execPath, [
    TOOL, "--check", "--pack", tamperedLivePath, "--evidence", evidencePath,
  ], { cwd: root }), /does not match the live pack file/);
});

test("검증 모드: readmissions 체인 링크가 끊기면 거부한다", async (context) => {
  const { directory, previousPackPath, evidencePath } = await setupChainStart(context);
  const next = buildFixturePack({ unrelatedValue: "after" });
  context.after(() => rm(next.directory, { recursive: true, force: true }));
  const newPackPath = path.join(directory, "new.sqlite.gz");
  await packToGzipFile(next.sqlitePath, newPackPath);
  await execFileAsync(process.execPath, [
    TOOL, "--pack", newPackPath, "--previous-pack", previousPackPath,
    "--evidence", evidencePath, "--provenance", "test",
  ], { cwd: root });

  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.readmissions[0].previousPack.sha256 = "f".repeat(64);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  await assert.rejects(execFileAsync(process.execPath, [
    TOOL, "--check", "--pack", newPackPath, "--evidence", evidencePath, "--genesis-pack", previousPackPath,
  ], { cwd: root }), /breaks the identity chain/);
});

test("검증 모드: 마지막 readmission의 newPack이 pack.output*과 다르면 거부한다", async (context) => {
  const { directory, previousPackPath, evidencePath } = await setupChainStart(context);
  const next = buildFixturePack({ unrelatedValue: "after" });
  context.after(() => rm(next.directory, { recursive: true, force: true }));
  const newPackPath = path.join(directory, "new.sqlite.gz");
  await packToGzipFile(next.sqlitePath, newPackPath);
  await execFileAsync(process.execPath, [
    TOOL, "--pack", newPackPath, "--previous-pack", previousPackPath,
    "--evidence", evidencePath, "--provenance", "test",
  ], { cwd: root });

  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.pack.byteSize += 1;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  await assert.rejects(execFileAsync(process.execPath, [
    TOOL, "--check", "--pack", newPackPath, "--evidence", evidencePath, "--genesis-pack", previousPackPath,
  ], { cwd: root }), /does not match the last readmission/);
});

test("--help는 사용법을 출력하고 성공 종료한다", async () => {
  const { stdout } = await execFileAsync(process.execPath, [TOOL, "--help"], { cwd: root });
  assert.match(stdout, /생성 모드/);
  assert.match(stdout, /검증 모드/);
});

test("tracked production evidence·bundled pack은 --check를 통과한다", async () => {
  await execFileAsync(process.execPath, [TOOL, "--check"], { cwd: root });
});
