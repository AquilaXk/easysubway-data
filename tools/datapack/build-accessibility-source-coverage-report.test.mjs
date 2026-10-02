import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  buildAccessibilitySourceCoverageReport,
  partitionMolitTransferTuples,
  loadAccessibilityAdmissionSnapshots,
  loadMolitTransferSnapshot,
  loadSelectableAccessibilityArtifacts,
  manifestAssetRoot,
} from "./build-accessibility-source-coverage-report.mjs";

const EVALUATED_AT = "2026-07-28T00:00:00.000Z";

test("selectable artifact의 모든 claim이 fresh official snapshot에 결속되면 GO다", () => {
  const input = validInput();

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "GO");
  assert.deepEqual(report.artifacts, [
    { artifactId: "bundled-capital", sqliteSha256: hash("sqlite-a"), searchableStationCount: 1, claimCount: 1 },
    { artifactId: "remote-capital", sqliteSha256: hash("sqlite-b"), searchableStationCount: 1, claimCount: 1 },
  ]);
  assert.deepEqual(report.providerDomainMatrix, [{
    sourceId: "official-accessibility",
    domain: "STATION_FACILITY_EVIDENCE",
    artifactIds: ["bundled-capital", "remote-capital"],
    claimCount: 2,
    status: "ADMITTED",
  }]);
  assert.deepEqual(report.violations, emptyViolations());
});

test("registered accessibility source binds admission, tracked bytes, and ledger policy without legacy evidence", () => {
  const input = validInput();
  const source = input.inventory.sources[0];
  const snapshot = input.snapshots[0];
  const policy = input.sourceSnapshotPolicies[0];
  const rawObjectSha256 = hash("registered-oci-object");
  const adminReviewRecordHash = hash("registered-review");
  source.admissionEvidence = { decision: "APPROVED", adminReviewRecordHash };
  source.registrationEvidence = {
    sourceId: source.id,
    snapshotId: snapshot.snapshotId,
    snapshotFileSha256: snapshot.snapshotFileSha256,
    snapshotRawSha256: snapshot.rawSha256,
    rawObjectUri: "oci://fixture/registered-accessibility.json",
    rawObjectSha256,
    contentSha256: snapshot.contentSha256,
    normalizedSchemaFingerprint: snapshot.schemaFingerprint,
    claimBindingsSha256: hash(JSON.stringify(snapshot.claimBindings)),
    rowCount: 2,
    coverageCount: 2,
    claimBindingCount: snapshot.claimBindings.length,
    adminReviewRecordHash,
  };
  snapshot.rowCount = 2;
  snapshot.stationCount = 2;
  snapshot.claimBindingsSha256 = source.registrationEvidence.claimBindingsSha256;
  delete source.accessibilityAdmissionEvidence;
  Object.assign(policy, {
    rawObjectUri: source.registrationEvidence.rawObjectUri,
    rawSha256: rawObjectSha256,
    contentSha256: snapshot.contentSha256,
    schemaFingerprint: snapshot.schemaFingerprint,
    claimBindingsSha256: snapshot.claimBindingsSha256,
    adminReviewRecordHash,
    redistributionAllowed: true,
    credentialRedacted: true,
    freshnessExpiresAt: snapshot.freshUntil,
    rawReceipt: {
      snapshotFileSha256: snapshot.snapshotFileSha256,
      snapshotRawSha256: snapshot.rawSha256,
    },
  });

  assert.equal(buildAccessibilitySourceCoverageReport(input).decision, "GO");
  source.registrationEvidence.rawObjectSha256 = "0".repeat(64);
  assert.equal(buildAccessibilitySourceCoverageReport(input).decision, "NO_GO");
});

test("미승인 source는 provider-domain matrix에서도 BLOCKED다", () => {
  const input = validInput();
  input.inventory.sources[0].accessibilityAdmissionEvidence.decision = "PENDING";

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.equal(report.providerDomainMatrix[0].status, "BLOCKED");
});

test("station domain source matrix는 실제 station-line 분모의 미평가 cell을 NO_GO로 남긴다", () => {
  const input = validInput();
  input.artifacts = [input.artifacts[0]];
  input.artifacts[0].stationLines = [{
    stationId: "station-a",
    stationName: "사당",
    stationAliases: [],
    regionId: "capital",
    lineId: "line-a",
    lineName: "수도권 4호선",
    operatorId: "seoul-metro",
    operatorName: "서울교통공사",
  }];
  input.molitTransferSnapshot = {
    sourceId: "molit-railway-transfer-movement",
    snapshotId: "molit-railway-transfer-movement-20250811",
    rawSha256: hash("transfer-raw"),
    gzipSha256: hash("transfer-gzip"),
    metadataFileSha256: hash("transfer-metadata"),
    sourceInventoryFileSha256: hash("inventory-file"),
    sourceInventorySha256: hash("inventory-canonical"),
    candidateBuildSpecSourceInventorySha256: hash("inventory-canonical"),
    rowCount: 1,
    rows: [{
      RAIL_OPR_ISTT_CD: "S1(서울교통공사)",
      LN_NM: "4호선",
      STIN_NM: "사당",
    }],
  };
  input.providerCodeCatalog = {
    providerLines: [{ railOprIsttCd: "S1", operatorName: "서울교통공사", lnCd: "4", lineName: "4호선" }],
  };
  input.inventory.sources[0].coverageScope = {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    lineIds: ["line-a"],
    sourceDomains: ["accessibility_facilities"],
  };

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.deepEqual(report.stationDomainSourceGate.matrix, [{
    operatorId: "seoul-metro",
    operatorName: "서울교통공사",
    domain: "EXIT",
    stationLineCount: 1,
    evaluatedStationLineCount: 0,
    missingStationLineCount: 1,
    artifacts: [{
      artifactId: "bundled-capital",
      stationLineCount: 1,
      evaluatedStationLineCount: 0,
      missingStationLineCount: 1,
    }],
    sourceIds: [],
    blockingReasons: ["NO_ADMITTED_SOURCE", "STATION_LINE_COVERAGE_INCOMPLETE"],
    requiredEvidence: "OFFICIAL_EXHAUSTIVE_EXIT_PATH_SNAPSHOT_OR_EXPLICIT_ZERO",
    status: "BLOCKED",
  }, {
    operatorId: "seoul-metro",
    operatorName: "서울교통공사",
    domain: "FACILITY",
    stationLineCount: 1,
    evaluatedStationLineCount: 1,
    missingStationLineCount: 0,
    artifacts: [{
      artifactId: "bundled-capital",
      stationLineCount: 1,
      evaluatedStationLineCount: 1,
      missingStationLineCount: 0,
    }],
    sourceIds: ["official-accessibility"],
    blockingReasons: [],
    requiredEvidence: "OFFICIAL_EXHAUSTIVE_FACILITY_SNAPSHOT_OR_EXPLICIT_ZERO",
    status: "ADMITTED",
  }, {
    operatorId: "seoul-metro",
    operatorName: "서울교통공사",
    domain: "TRANSFER",
    stationLineCount: 1,
    evaluatedStationLineCount: 0,
    missingStationLineCount: 1,
    artifacts: [{
      artifactId: "bundled-capital",
      stationLineCount: 1,
      evaluatedStationLineCount: 0,
      missingStationLineCount: 1,
    }],
    sourceIds: [],
    blockingReasons: ["NO_ADMITTED_SOURCE", "STATION_LINE_COVERAGE_INCOMPLETE"],
    requiredEvidence: "OFFICIAL_TRANSFER_TOPOLOGY_AND_ACCESSIBILITY_SNAPSHOT",
    status: "BLOCKED",
  }]);
  assert.equal(report.stationDomainSourceGate.transferTuplePartition.joined.length, 1);
  assert.equal(report.stationDomainSourceGate.transferTuplePartition.unmatched.length, 0);
  assert.equal(report.stationDomainSourceGate.transferTuplePartition.ambiguous.length, 0);
  assert.deepEqual(report.stationDomainSourceGate.transferTuplePartition.identity, {
    sourceId: "molit-railway-transfer-movement",
    snapshotId: "molit-railway-transfer-movement-20250811",
    rawSha256: hash("transfer-raw"),
    gzipSha256: hash("transfer-gzip"),
    metadataFileSha256: hash("transfer-metadata"),
    sourceInventoryFileSha256: hash("inventory-file"),
    sourceInventorySha256: hash("inventory-canonical"),
    candidateBuildSpecSourceInventorySha256: hash("inventory-canonical"),
    rowCount: 1,
  });

  delete input.inventory.sources[0].accessibilityAdmissionEvidence.absenceEvidenceMode;
  assert.equal(buildAccessibilitySourceCoverageReport(input)
    .stationDomainSourceGate.matrix.find(({ domain }) => domain === "FACILITY").status, "BLOCKED");

  input.inventory.sources[0].accessibilityAdmissionEvidence.absenceEvidenceMode = "EXPLICIT_ZERO";
  input.inventory.sources[0].coverageScope.operatorIds = ["korail"];
  assert.equal(buildAccessibilitySourceCoverageReport(input)
    .stationDomainSourceGate.matrix.find(({ domain }) => domain === "FACILITY").status, "BLOCKED");

  input.inventory.sources[0].coverageScope.operatorIds = ["seoul-metro"];
  input.inventory.sources[0].coverageScope.sourceDomains = ["indoor_movement_paths"];
  assert.equal(buildAccessibilitySourceCoverageReport(input)
    .stationDomainSourceGate.matrix.find(({ domain }) => domain === "FACILITY").status, "BLOCKED");

  input.inventory.sources[0].coverageScope.sourceDomains = ["accessibility_facilities"];
  input.inventory.sources[0].coverageScope.regionIds = ["busan"];
  assert.equal(buildAccessibilitySourceCoverageReport(input)
    .stationDomainSourceGate.matrix.find(({ domain }) => domain === "FACILITY").status, "BLOCKED");

  input.inventory.sources[0].coverageScope.regionIds = ["capital"];
  input.inventory.sources[0].coverageScope.lineIds = ["line-b"];
  assert.equal(buildAccessibilitySourceCoverageReport(input)
    .stationDomainSourceGate.matrix.find(({ domain }) => domain === "FACILITY").status, "BLOCKED");

  input.inventory.sources[0].coverageScope.lineIds = ["line-a"];
  input.molitTransferSnapshot.rawSha256 = "invalid";
  assert.throws(() => buildAccessibilitySourceCoverageReport(input), /identity is invalid/);

  input.molitTransferSnapshot.rawSha256 = hash("transfer-raw");
  input.artifacts.push({
    artifactId: "remote-core",
    sqliteSha256: hash("sqlite-core"),
    searchableStationIds: ["station-a"],
    claims: [],
  });
  assert.throws(() => buildAccessibilitySourceCoverageReport(input), /station-lines for every artifact/);
});

test("station domain gate 입력은 둘 중 하나만 있으면 fail-closed다", () => {
  const input = validInput();
  input.molitTransferSnapshot = {};

  assert.throws(() => buildAccessibilitySourceCoverageReport(input), /inputs must be provided together/);
});

test("MOLIT transfer tuple partition은 unmatched와 ambiguous를 추정 없이 보존한다", () => {
  const row = (stationName) => ({
    RAIL_OPR_ISTT_CD: "S1(서울교통공사)",
    LN_NM: "4호선",
    STIN_NM: stationName,
  });
  const artifacts = [{
    artifactId: "capital",
    stationLines: ["station-a", "station-b"].map((stationId) => ({
      stationId,
      stationName: "중앙",
      stationAliases: [],
      lineId: "line-a",
      lineName: "수도권 4호선",
      operatorId: "seoul-metro",
      operatorName: "서울교통공사",
    })),
  }];

  const partition = partitionMolitTransferTuples({
    artifacts,
    rows: [row("중앙"), row("중앙"), row("없는역")],
    providerCodeCatalog: {
      providerLines: [{ railOprIsttCd: "S1", operatorName: "서울교통공사", lnCd: "4", lineName: "4호선" }],
    },
  });

  assert.deepEqual(partition.summary, {
    rowCount: 3,
    tupleCount: 2,
    joinedTupleCount: 0,
    joinedRowCount: 0,
    unmatchedTupleCount: 1,
    unmatchedRowCount: 1,
    ambiguousTupleCount: 1,
    ambiguousRowCount: 2,
  });
  assert.equal(partition.unmatched[0].reason, "CANONICAL_STATION_UNMATCHED");
  assert.equal(partition.ambiguous[0].reason, "CANONICAL_STATION_AMBIGUOUS");
});

for (const { name, artifacts, providerLines, expectedKind, expectedReason } of [
  {
    name: "provider line 미등록",
    artifacts: [],
    providerLines: [],
    expectedKind: "unmatched",
    expectedReason: "PROVIDER_LINE_SCOPE_UNMAPPED",
  },
  {
    name: "provider line 중복",
    artifacts: [],
    providerLines: [
      { railOprIsttCd: "S1", operatorName: "서울교통공사", lineName: "4호선" },
      { railOprIsttCd: "S1", operatorName: "서울교통공사", lineName: "4호선" },
    ],
    expectedKind: "ambiguous",
    expectedReason: "PROVIDER_LINE_SCOPE_AMBIGUOUS",
  },
  {
    name: "canonical line 미등록",
    artifacts: [],
    providerLines: [{ railOprIsttCd: "S1", operatorName: "서울교통공사", lineName: "4호선" }],
    expectedKind: "unmatched",
    expectedReason: "CANONICAL_LINE_SCOPE_UNMATCHED",
  },
]) {
  test(`MOLIT transfer tuple partition은 ${name} 사유를 보존한다`, () => {
    const partition = partitionMolitTransferTuples({
      artifacts,
      rows: [{ RAIL_OPR_ISTT_CD: "S1(서울교통공사)", LN_NM: "4호선", STIN_NM: "사당" }],
      providerCodeCatalog: { providerLines },
    });

    assert.equal(partition[expectedKind][0].reason, expectedReason);
    assert.equal(partition.summary[`${expectedKind}TupleCount`], 1);
    assert.equal(partition.summary[`${expectedKind}RowCount`], 1);
  });
}

test("MOLIT transfer tuple partition은 raw 운영사명 대신 검증된 catalog scope를 사용한다", () => {
  const partition = partitionMolitTransferTuples({
    artifacts: [{
      artifactId: "capital",
      stationLines: [{
        stationId: "station-a",
        stationName: "사당",
        lineId: "line-a",
        lineName: "4호선",
        operatorId: "operator-a",
        operatorName: "위조운영사",
      }],
    }],
    rows: [{ RAIL_OPR_ISTT_CD: "S1(위조운영사)", LN_NM: "4호선", STIN_NM: "사당" }],
    providerCodeCatalog: {
      providerLines: [{ railOprIsttCd: "S1", operatorName: "서울교통공사", lineName: "4호선" }],
    },
  });

  assert.equal(partition.unmatched[0].reason, "PROVIDER_OPERATOR_IDENTITY_MISMATCH");
  assert.equal(partition.unmatched[0].catalogOperatorName, "서울교통공사");
  assert.equal(partition.joined.length, 0);
});

test("MOLIT transfer tuple partition snapshot binding은 inventory와 build spec hash를 강제한다", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const inventoryPath = path.join(import.meta.dirname, "source-inventory.json");
  const inventoryBytes = await readFile(inventoryPath);
  const inventory = JSON.parse(inventoryBytes);
  const trackedCandidateBuildSpec = JSON.parse(await readFile(
    path.join(import.meta.dirname, "release/candidate-build-spec.json"),
  ));
  const candidateBuildSpec = {
    ...trackedCandidateBuildSpec,
    sourceInventorySha256: hash(JSON.stringify(inventory)),
  };
  const metadataPath = path.join(
    repositoryRoot,
    inventory.sources.find(({ id }) => id === "molit-railway-transfer-movement").rawSnapshotAdmission.metadataPath,
  );
  // #862: 시계는 커밋된 판의 metadata(capturedAt·freshUntil)에서 유도한다.
  const boundMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const freshEvaluatedAt = new Date(Date.parse(boundMetadata.capturedAt) + 60_000).toISOString();
  const futureEvaluatedAt = new Date(Date.parse(boundMetadata.capturedAt) - 1).toISOString();

  const snapshot = await loadMolitTransferSnapshot({
    metadataPath,
    inventory,
    inventoryBytes,
    candidateBuildSpec,
    repositoryRoot,
    evaluatedAt: freshEvaluatedAt,
  });

  assert.equal(snapshot.rowCount, boundMetadata.rowCount);
  assert.equal(snapshot.rows.length, boundMetadata.rowCount);
  assert.equal(snapshot.sourceInventorySha256, candidateBuildSpec.sourceInventorySha256);
  await assert.rejects(loadMolitTransferSnapshot({
    metadataPath,
    inventory,
    inventoryBytes,
    candidateBuildSpec,
    repositoryRoot,
    evaluatedAt: futureEvaluatedAt,
  }), /snapshot is future-dated/);
  await assert.rejects(loadMolitTransferSnapshot({
    metadataPath,
    inventory: {
      ...inventory,
      sources: inventory.sources.map((source) => source.id === "molit-railway-transfer-movement"
        ? { ...source, rawSnapshotAdmission: { ...source.rawSnapshotAdmission, rawSha256: hash("tampered") } }
        : source),
    },
    inventoryBytes,
    candidateBuildSpec,
    repositoryRoot,
    evaluatedAt: freshEvaluatedAt,
  }), /snapshot binding mismatch/);
  await assert.rejects(loadMolitTransferSnapshot({
    metadataPath,
    inventory,
    inventoryBytes,
    candidateBuildSpec,
    repositoryRoot,
    evaluatedAt: boundMetadata.freshUntil,
  }), /snapshot is stale/);
});

test("inventory에 없는 source는 provider-domain matrix에서도 BLOCKED다", () => {
  const input = validInput();
  input.artifacts[0].claims[0].sourceId = "unknown-source";

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.equal(
    report.providerDomainMatrix.find(({ sourceId }) => sourceId === "unknown-source").status,
    "BLOCKED",
  );
});

test("accessibility 승인 license hash는 source governance 검토 hash와 일치해야 한다", () => {
  const input = validInput();
  input.inventory.sources[0].accessibilityAdmissionEvidence.licenseEvidenceHash = hash("stale-license");

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.deepEqual(report.violations.license, ["official-accessibility:LICENSE_EVIDENCE_MISMATCH"]);
});

test("tracked snapshot bytes와 inventory file SHA가 일치해야 한다", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-snapshot-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const snapshotPath = "official-accessibility-20260728.json";
  const snapshot = {
    sourceId: "official-accessibility",
    snapshotId: "official-accessibility-20260728",
    capturedAt: "2026-07-27T23:00:00.000Z",
    observedAt: "2026-07-27T23:00:00.000Z",
    freshUntil: "2026-07-29T23:00:00.000Z",
    rawSha256: hash("raw"),
    contentSha256: hash("content"),
    schemaFingerprint: hash("schema"),
  };
  const bytes = `${JSON.stringify(snapshot)}\n`;
  await writeFile(path.join(repositoryRoot, snapshotPath), bytes);
  const sources = [{
    id: snapshot.sourceId,
    accessibilityAdmissionEvidence: { snapshotPath, snapshotFileSha256: hashBytes(bytes) },
  }];

  const [loaded] = await loadAccessibilityAdmissionSnapshots({
    sources,
    referencedSourceIds: new Set([snapshot.sourceId]),
    repositoryRoot,
  });

  assert.equal(loaded.snapshotFileSha256, hashBytes(bytes));
  assert.equal(loaded.snapshotId, snapshot.snapshotId);
});

test("remote manifest URL과 bundled index가 같은 gzip SQLite를 가리키면 artifact 하나로 읽는다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-accessibility-source-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, "capital.sqlite");
  const gzipPath = path.join(directory, "catalog", "capital.sqlite.gz");
  await mkdir(path.dirname(gzipPath));
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    CREATE TABLE stations (id TEXT PRIMARY KEY);
    CREATE TABLE operators (id TEXT PRIMARY KEY);
    CREATE TABLE lines (id TEXT PRIMARY KEY);
    CREATE TABLE station_lines (station_id TEXT, line_id TEXT);
    CREATE TABLE station_facility_evidence (
      station_id TEXT, line_id TEXT, facility_type TEXT, evidence_kind TEXT,
      source_id TEXT, source_snapshot_id TEXT, provider_record_hash TEXT, evidence_hash TEXT
    );
    CREATE TABLE facilities (
      id TEXT, station_id TEXT, type TEXT, source_id TEXT, source_snapshot_id TEXT,
      provider_record_hash TEXT, evidence_hash TEXT
    );
    CREATE TABLE station_exits (
      id TEXT, station_id TEXT, has_elevator_connection INTEGER,
      source_id TEXT, source_snapshot_id TEXT
    );
    CREATE TABLE network_edges (
      id TEXT, from_node_id TEXT, to_node_id TEXT, edge_type TEXT,
      accessibility_status TEXT, stair_access_state TEXT, source_id TEXT,
      source_snapshot_id TEXT, provider_record_hash TEXT, evidence_hash TEXT
    );
    CREATE TABLE internal_route_edges (
      id TEXT, from_node_id TEXT, to_node_id TEXT, edge_type TEXT,
      accessibility_status TEXT, source_id TEXT, source_snapshot_id TEXT,
      provider_record_hash TEXT, evidence_hash TEXT
    );
    CREATE TABLE station_pathway_nodes (id TEXT, station_id TEXT, line_id TEXT);
    CREATE TABLE station_pathway_edges (
      id TEXT, from_node_id TEXT, to_node_id TEXT, edge_type TEXT,
      accessibility_status TEXT, source_id TEXT, source_snapshot_id TEXT,
      provider_record_hash TEXT, evidence_hash TEXT
    );
    CREATE TABLE out_of_station_transfer_links (
      id TEXT, from_station_id TEXT, from_line_id TEXT, to_station_id TEXT, to_line_id TEXT,
      accessibility_status TEXT, source_id TEXT, source_snapshot_id TEXT,
      provider_record_hash TEXT, evidence_hash TEXT
    );
  `);
  database.prepare("INSERT INTO stations VALUES (?)").run("station-a");
  database.prepare("INSERT INTO station_lines VALUES (?, ?)").run("station-a", "line-a");
  database.prepare("INSERT INTO station_facility_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "station-a", "line-a", "ELEVATOR", "VERIFIED_PRESENT", "official-accessibility",
    "official-accessibility-20260728", hash("record"), hash("evidence"),
  );
  database.prepare("INSERT INTO facilities VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "facility-a", "station-a", "ELEVATOR", "official-accessibility",
    "official-accessibility-20260728", hash("facility-record"), hash("facility-evidence"),
  );
  database.prepare("INSERT INTO facilities VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "facility-without-provenance", "station-a", "ESCALATOR", "", "", "", "",
  );
  database.prepare("INSERT INTO station_exits VALUES (?, ?, ?, ?, ?)").run(
    "exit-a", "station-a", 1, "fixture-capital-catalog", "fixture-capital-catalog-20260619",
  );
  database.prepare("INSERT INTO network_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "edge-entry-a", "station-a", "station-a:line-a", "ENTRY", "UNKNOWN", "UNKNOWN",
    "official-accessibility", "official-accessibility-20260728", hash("edge-record"), hash("edge-evidence"),
  );
  database.prepare("INSERT INTO network_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "edge-without-provenance", "station-a", "station-a:line-a", "EXIT", "AVAILABLE", "UNKNOWN",
    "", "", "", "",
  );
  database.prepare("INSERT INTO internal_route_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "internal-edge-without-provenance", "station-a", "station-a:line-a", "WALK", "AVAILABLE",
    "", "", "", "",
  );
  database.prepare("INSERT INTO internal_route_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "internal-edge-unknown", "station-a", "station-a:line-a", "WALK", "UNKNOWN",
    "", "", "", "",
  );
  database.prepare("INSERT INTO station_pathway_nodes VALUES (?, ?, ?)").run(
    "path-node-a", "station-a", "line-a",
  );
  database.prepare("INSERT INTO station_pathway_nodes VALUES (?, ?, ?)").run(
    "path-node-b", "station-a", "line-a",
  );
  database.prepare("INSERT INTO station_pathway_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "path-edge-a", "path-node-a", "path-node-b", "ELEVATOR", "AVAILABLE", "", "", "", "",
  );
  database.prepare("INSERT INTO station_pathway_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "broken-path-edge", "missing-node", "path-node-b", "WALK", "AVAILABLE", "", "", "", "",
  );
  database.prepare("INSERT INTO out_of_station_transfer_links VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "outside-transfer-a", "station-a", "line-a", "station-a", "line-a", "LIMITED", "", "", "", "",
  );
  database.close();
  const sqliteBytes = await readFile(sqlitePath);
  await writeFile(gzipPath, gzipSync(sqliteBytes));
  const index = {
    packs: [{
      id: "capital",
      asset: "catalog/capital.sqlite.gz",
      sqliteSha256: hashBytes(sqliteBytes),
    }],
  };
  const manifest = {
    packs: [{
      id: "capital",
      url: "https://datapack.example/catalog/capital.sqlite.gz",
      sqliteSha256: hashBytes(sqliteBytes),
    }],
  };

  const artifacts = await loadSelectableAccessibilityArtifacts({
    manifest,
    manifestRoot: directory,
    bundledIndex: index,
    bundledRoot: directory,
  });

  const networkEdgeClaims = artifacts[0].claims.filter(({ domain }) => domain === "NETWORK_EDGE");
  assert.deepEqual(networkEdgeClaims.map(({ claimId }) => claimId), [
    "edge-without-provenance",
    "internal-edge-without-provenance",
    "broken-path-edge",
    "path-edge-a",
    "outside-transfer-a",
  ]);
  assert.equal(networkEdgeClaims.some(({ claimId }) => claimId === "edge-entry-a"), false);
  const report = buildAccessibilitySourceCoverageReport({
    ...validInput(),
    artifacts: [artifacts[0]],
  });
  assert.ok(report.violations.provenance.includes(
    "bundled-capital:station-a|line-a|EXIT|NETWORK_EDGE:PROVENANCE_MISSING",
  ));

  assert.deepEqual(artifacts, [{
    artifactId: "bundled-capital",
    sqliteSha256: hashBytes(sqliteBytes),
    searchableStationIds: ["station-a"],
    claims: [{
      stationId: "station-a",
      lineId: "line-a",
      facilityType: "ELEVATOR",
      domain: "STATION_FACILITY_EVIDENCE",
      evidenceKind: "VERIFIED_PRESENT",
      sourceId: "official-accessibility",
      sourceSnapshotId: "official-accessibility-20260728",
      providerRecordHash: hash("record"),
      evidenceHash: hash("evidence"),
    }, {
      claimId: "facility-a",
      stationId: "station-a",
      lineId: "",
      facilityType: "ELEVATOR",
      domain: "FACILITY",
      evidenceKind: "EXISTS",
      sourceId: "official-accessibility",
      sourceSnapshotId: "official-accessibility-20260728",
      providerRecordHash: hash("facility-record"),
      evidenceHash: hash("facility-evidence"),
    }, {
      claimId: "facility-without-provenance",
      stationId: "station-a",
      lineId: "",
      facilityType: "ESCALATOR",
      domain: "FACILITY",
      evidenceKind: "EXISTS",
      sourceId: "",
      sourceSnapshotId: "",
      providerRecordHash: "",
      evidenceHash: "",
    }, {
      claimId: "exit-a",
      stationId: "station-a",
      lineId: "",
      facilityType: "ELEVATOR_CONNECTION",
      domain: "STATION_EXIT",
      evidenceKind: "EXISTS",
      sourceId: "fixture-capital-catalog",
      sourceSnapshotId: "fixture-capital-catalog-20260619",
      providerRecordHash: "",
      evidenceHash: "",
    }, {
      claimId: "edge-without-provenance",
      stationId: "station-a",
      lineId: "line-a",
      facilityType: "EXIT",
      domain: "NETWORK_EDGE",
      evidenceKind: "EXISTS",
      sourceId: "",
      sourceSnapshotId: "",
      providerRecordHash: "",
      evidenceHash: "",
    }, {
      claimId: "internal-edge-without-provenance",
      stationId: "station-a",
      lineId: "line-a",
      facilityType: "WALK",
      domain: "NETWORK_EDGE",
      evidenceKind: "EXISTS",
      sourceId: "",
      sourceSnapshotId: "",
      providerRecordHash: "",
      evidenceHash: "",
    }, {
      claimId: "broken-path-edge",
      stationId: "station-a",
      lineId: "line-a",
      facilityType: "WALK",
      domain: "NETWORK_EDGE",
      evidenceKind: "EXISTS",
      sourceId: "",
      sourceSnapshotId: "",
      providerRecordHash: "",
      evidenceHash: "",
    }, {
      claimId: "path-edge-a",
      stationId: "station-a",
      lineId: "line-a",
      facilityType: "ELEVATOR",
      domain: "NETWORK_EDGE",
      evidenceKind: "EXISTS",
      sourceId: "",
      sourceSnapshotId: "",
      providerRecordHash: "",
      evidenceHash: "",
    }, {
      claimId: "outside-transfer-a",
      stationId: "station-a",
      lineId: "line-a",
      facilityType: "OUT_OF_STATION_TRANSFER",
      domain: "NETWORK_EDGE",
      evidenceKind: "EXISTS",
      sourceId: "",
      sourceSnapshotId: "",
      providerRecordHash: "",
      evidenceHash: "",
    }],
  }]);
});

test("서로 다른 facility type의 위반은 고유 claim ID를 가진다", () => {
  const input = validInput();
  input.artifacts = [input.artifacts[0]];
  input.artifacts[0].claims = ["ELEVATOR", "ESCALATOR"].map((facilityType) => ({
    ...input.artifacts[0].claims[0],
    facilityType,
    sourceId: "",
  }));

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(new Set(report.violations.provenance).size, 2);
});

test("nullable Seoul line identity는 예외 대신 NO_GO로 판정한다", () => {
  const input = validInput();
  input.artifacts = [input.artifacts[0]];
  const claim = input.artifacts[0].claims[0];
  claim.lineId = null;
  claim.stationName = "사당";
  input.snapshots[0].artifactKind = "seoul-accessibility-snapshot";
  input.snapshots[0].stations = [{ stationName: "사당", lineName: "4호선", facilities: [] }];
  delete input.snapshots[0].claimBindings;

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.ok(report.violations.provenance.some((violation) => violation.endsWith("CLAIM_SNAPSHOT_BINDING_MISMATCH")));
});

test("snapshot content에서 재계산할 수 없는 임의 claim hash는 NO_GO다", () => {
  const input = validInput();
  input.artifacts[0].claims[0].evidenceHash = hash("arbitrary-but-shaped");

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.deepEqual(report.violations.provenance, [
    "bundled-capital:station-a|line-a|ELEVATOR|STATION_FACILITY_EVIDENCE:CLAIM_SNAPSHOT_BINDING_MISMATCH",
  ]);
});

test("Seoul snapshot에 존재하는 역·노선은 NOT_EXISTS로 위조할 수 없다", () => {
  const input = validInput();
  const sourceId = "seoul-metro-accessibility";
  const snapshotId = "seoul-metro-accessibility-20260728";
  const claim = input.artifacts[0].claims[0];
  input.artifacts = [input.artifacts[0]];
  Object.assign(claim, {
    stationId: "station-sadang",
    stationName: "사당",
    lineId: "seoul-4",
    evidenceKind: "NOT_EXISTS",
    sourceId,
    sourceSnapshotId: snapshotId,
  });
  claim.providerRecordHash = hash(JSON.stringify({
    stationId: claim.stationId,
    lineName: "4호선",
    status: "NOT_COVERED",
  }));
  claim.evidenceHash = hash(JSON.stringify({
    snapshotId,
    stationId: claim.stationId,
    lineId: claim.lineId,
    providerRecordHash: claim.providerRecordHash,
  }));
  Object.assign(input.inventory.sources[0], { id: sourceId });
  Object.assign(input.inventory.sources[0].accessibilityAdmissionEvidence, {
    snapshotId,
    absenceEvidenceMode: "EXHAUSTIVE_LIST",
  });
  Object.assign(input.snapshots[0], {
    artifactKind: "seoul-accessibility-snapshot",
    sourceId,
    snapshotId,
    stations: [{ stationName: "사당", lineName: "4호선", facilities: [] }],
  });
  delete input.snapshots[0].claimBindings;

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.deepEqual(report.violations.provenance, [
    "bundled-capital:station-sadang|seoul-4|ELEVATOR|STATION_FACILITY_EVIDENCE:CLAIM_SNAPSHOT_BINDING_MISMATCH",
  ]);
});

test("KRIC snapshot에 matching row가 있으면 NOT_EXISTS로 위조할 수 없다", () => {
  const input = validInput();
  input.artifacts = [input.artifacts[0]];
  const claim = input.artifacts[0].claims[0];
  const row = { gubun: "EV", dtlLoc: "승강장" };
  const query = { railOprIsttCd: "KR", lnCd: "4", stinCd: "448" };
  claim.evidenceKind = "NOT_EXISTS";
  claim.providerRecordHash = hash(JSON.stringify(row));
  claim.evidenceHash = hash(JSON.stringify({
    snapshotId: claim.sourceSnapshotId,
    query,
    providerRecordHash: claim.providerRecordHash,
  }));
  Object.assign(input.snapshots[0], {
    artifactKind: "kric-accessibility-snapshot",
    queries: [{ ...query, stationId: claim.stationId, lineId: claim.lineId, rows: [row] }],
  });
  delete input.snapshots[0].claimBindings;

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.deepEqual(report.violations.provenance, [
    "bundled-capital:station-a|line-a|ELEVATOR|STATION_FACILITY_EVIDENCE:CLAIM_SNAPSHOT_BINDING_MISMATCH",
  ]);
});

test("manifest root 기본값은 manifest 파일의 디렉터리다", () => {
  assert.equal(manifestAssetRoot("/tmp/output/current.json"), "/tmp/output");
});

for (const { name, mutate, partition, expected } of [
  {
    name: "expired snapshot",
    mutate: (input) => { input.sourceSnapshotPolicies[0].freshnessExpiresAt = EVALUATED_AT; },
    partition: "freshness",
    expected: "official-accessibility:SNAPSHOT_STALE",
  },
  {
    name: "missing redistribution permission",
    mutate: (input) => { input.inventory.sources[0].license.redistributionAllowed = false; },
    partition: "license",
    expected: "official-accessibility:LICENSE_NOT_REDISTRIBUTABLE",
  },
  {
    name: "snapshot digest mismatch",
    mutate: (input) => { input.snapshots[0].rawSha256 = hash("different-raw"); },
    partition: "snapshot",
    expected: "official-accessibility:SNAPSHOT_IDENTITY_MISMATCH",
  },
  {
    name: "snapshot file digest mismatch",
    mutate: (input) => { input.snapshots[0].snapshotFileSha256 = hash("different-file"); },
    partition: "snapshot",
    expected: "official-accessibility:SNAPSHOT_IDENTITY_MISMATCH",
  },
  {
    name: "snapshot absence evidence mode mismatch",
    mutate: (input) => { delete input.snapshots[0].absenceEvidenceMode; },
    partition: "snapshot",
    expected: "official-accessibility:SNAPSHOT_IDENTITY_MISMATCH",
  },
  {
    name: "snapshot policy identity mismatch",
    mutate: (input) => { input.sourceSnapshotPolicies[0].snapshotId = "other-snapshot"; },
    partition: "snapshot",
    expected: "official-accessibility:SNAPSHOT_POLICY_MISMATCH",
  },
  {
    name: "claim provenance missing",
    mutate: (input) => { input.artifacts[0].claims[0].sourceId = ""; },
    partition: "provenance",
    expected: "bundled-capital:station-a|line-a|ELEVATOR|STATION_FACILITY_EVIDENCE:PROVENANCE_MISSING",
  },
  {
    name: "accessibility admission not approved",
    mutate: (input) => { input.inventory.sources[0].accessibilityAdmissionEvidence.decision = "PENDING"; },
    partition: "provenance",
    expected: "official-accessibility:ACCESSIBILITY_ADMISSION_NOT_APPROVED",
  },
  {
    name: "row absence without completeness evidence",
    mutate: (input) => {
      input.artifacts[0].claims[0].evidenceKind = "NOT_EXISTS";
      delete input.inventory.sources[0].accessibilityAdmissionEvidence.absenceEvidenceMode;
    },
    partition: "absenceEvidence",
    expected: "bundled-capital:station-a|line-a|ELEVATOR|STATION_FACILITY_EVIDENCE:ABSENCE_EVIDENCE_MISSING",
  },
  {
    name: "placeholder evidence hash",
    mutate: (input) => { input.artifacts[0].claims[0].evidenceHash = "a".repeat(64); },
    partition: "placeholder",
    expected: "bundled-capital:station-a|line-a|ELEVATOR|STATION_FACILITY_EVIDENCE:EVIDENCE_HASH_PLACEHOLDER",
  },
  {
    name: "duplicate artifact identity",
    mutate: (input) => { input.artifacts[1].artifactId = "bundled-capital"; },
    partition: "artifactIdentity",
    expected: "bundled-capital:DUPLICATE_ARTIFACT_ID",
  },
]) {
  test(`${name}는 ${partition} violation으로 NO_GO다`, () => {
    const input = validInput();
    mutate(input);

    const report = buildAccessibilitySourceCoverageReport(input);

    assert.equal(report.decision, "NO_GO");
    assert.deepEqual(report.violations[partition], [expected]);
  });
}

test("expired live admission remains valid while its locked snapshot policy is fresh", () => {
  const input = validInput();
  input.inventory.sources[0].accessibilityAdmissionEvidence.freshUntil = EVALUATED_AT;
  input.snapshots[0].freshUntil = EVALUATED_AT;

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "GO");
  assert.deepEqual(report.violations.freshness, []);
});

test("EXHAUSTIVE_LIST_WITH_UNVERIFIED_EVIDENCE_BLOCKED absence evidence mode is admitted for NOT_EXISTS claims", () => {
  const input = validInput();
  input.artifacts[0].claims[0].evidenceKind = "NOT_EXISTS";
  input.inventory.sources[0].accessibilityAdmissionEvidence.absenceEvidenceMode =
    "EXHAUSTIVE_LIST_WITH_UNVERIFIED_EVIDENCE_BLOCKED";
  input.snapshots[0].absenceEvidenceMode =
    "EXHAUSTIVE_LIST_WITH_UNVERIFIED_EVIDENCE_BLOCKED";

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "GO");
  assert.deepEqual(report.violations.absenceEvidence, []);
});

function validInput() {
  const rawSha256 = hash("raw-snapshot");
  const contentSha256 = hash("normalized-snapshot");
  const schemaFingerprint = hash("schema");
  const snapshotFileSha256 = hash("snapshot-file");
  const snapshotId = "official-accessibility-20260728";
  const sourceId = "official-accessibility";
  const licenseEvidenceHash = hash("license-evidence");
  const claim = (stationId) => ({
    stationId,
    lineId: "line-a",
    facilityType: "ELEVATOR",
    domain: "STATION_FACILITY_EVIDENCE",
    evidenceKind: "VERIFIED_PRESENT",
    sourceId,
    sourceSnapshotId: snapshotId,
    providerRecordHash: hash(`${stationId}-record`),
    evidenceHash: hash(`${stationId}-evidence`),
  });
  return {
    evaluatedAt: EVALUATED_AT,
    artifacts: [
      {
        artifactId: "bundled-capital",
        sqliteSha256: hash("sqlite-a"),
        searchableStationIds: ["station-a"],
        claims: [claim("station-a")],
      },
      {
        artifactId: "remote-capital",
        sqliteSha256: hash("sqlite-b"),
        searchableStationIds: ["station-b"],
        claims: [claim("station-b")],
      },
    ],
    inventory: {
      sources: [{
        id: sourceId,
        productionUseAllowed: true,
        license: { redistributionAllowed: true, attribution: "공식 제공기관" },
        admissionEvidence: { licenseEvidenceHash },
        accessibilityAdmissionEvidence: {
          decision: "APPROVED",
          productionUseAllowed: true,
          licenseEvidenceHash,
          snapshotId,
          snapshotPath: "tools/datapack/sources/official-accessibility-20260728.json",
          capturedAt: "2026-07-27T23:00:00.000Z",
          observedAt: "2026-07-27T23:00:00.000Z",
          freshUntil: "2026-07-29T23:00:00.000Z",
          rawSha256,
          contentSha256,
          schemaFingerprint,
          snapshotFileSha256,
          absenceEvidenceMode: "EXPLICIT_ZERO",
        },
      }],
    },
    snapshots: [{
      sourceId,
      snapshotId,
      snapshotPath: "tools/datapack/sources/official-accessibility-20260728.json",
      capturedAt: "2026-07-27T23:00:00.000Z",
      observedAt: "2026-07-27T23:00:00.000Z",
      freshUntil: "2026-07-29T23:00:00.000Z",
      rawSha256,
      contentSha256,
      schemaFingerprint,
      snapshotFileSha256,
      absenceEvidenceMode: "EXPLICIT_ZERO",
      claimBindings: ["station-a", "station-b"].map((stationId) => ({
        stationId,
        lineId: "line-a",
        facilityType: "ELEVATOR",
        providerRecordHash: hash(`${stationId}-record`),
        evidenceHash: hash(`${stationId}-evidence`),
      })),
    }],
    sourceSnapshotPolicies: [{
      sourceId,
      snapshotId,
      snapshotStatus: "LOCKED",
      fetchStatus: "SUCCESS",
      schemaStatus: "PASS",
      licenseStatus: "PASS",
      redistributionAllowed: true,
      credentialRedacted: true,
      freshnessExpiresAt: "2026-10-26T23:00:00.000Z",
    }],
  };
}

function emptyViolations() {
  return {
    freshness: [],
    license: [],
    provenance: [],
    snapshot: [],
    absenceEvidence: [],
    placeholder: [],
    artifactIdentity: [],
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("지역 접근성 원천은 잠긴 snapshot policy·원문 row에 결속되면 GO다", () => {
  const input = regionalBusanInput();

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.deepEqual(report.violations, emptyViolations());
  assert.equal(report.decision, "GO");
});

test("부산 원문 빈 count 필드는 미관측이라 NOT_EXISTS claim을 결속하지 못한다", () => {
  const input = regionalBusanInput({ wheelchairRaw: "" });

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.deepEqual(report.violations.provenance, [
    "bundled-nationwide:station-busan-100|line-busan-1|WHEELCHAIR_LIFT|STATION_FACILITY_EVIDENCE:CLAIM_SNAPSHOT_BINDING_MISMATCH",
  ]);
});

test("원천에 열이 없는 대전·광주 휠체어리프트 claim은 결속되지 않는다", () => {
  for (const region of ["daejeon", "gwangju"]) {
    const input = regionalCountInput(region);
    const report = buildAccessibilitySourceCoverageReport(input);
    assert.equal(report.decision, "GO", region);

    input.artifacts[0].claims.push(regionalCountClaim(input, region, "WHEELCHAIR_LIFT", 0, "NOT_EXISTS"));
    const blocked = buildAccessibilitySourceCoverageReport(input);
    assert.equal(blocked.decision, "NO_GO", region);
    assert.ok(blocked.violations.provenance.some((value) =>
      value.includes("|WHEELCHAIR_LIFT|") && value.endsWith("CLAIM_SNAPSHOT_BINDING_MISMATCH")), region);
  }
});

test("대구 명시적 0은 EXPLICIT_ZERO 부재 claim으로 결속된다", () => {
  const input = regionalCountInput("daegu");
  input.artifacts[0].claims.push(regionalCountClaim(input, "daegu", "WHEELCHAIR_LIFT", 0, "NOT_EXISTS"));

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.deepEqual(report.violations, emptyViolations());
  assert.equal(report.decision, "GO");
});

test("지역 원천 license hash가 잠긴 policy 검토 hash와 다르면 NO_GO다", () => {
  const input = regionalBusanInput();
  input.sourceSnapshotPolicies[0].admissionEvidence.licenseEvidenceHash = hash("stale-license");

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.deepEqual(report.violations.license, ["busan-transportation-accessibility:LICENSE_EVIDENCE_MISMATCH"]);
});

test("지역 원천 row가 rowsSha256과 다르면 snapshot identity와 claim 결속이 모두 실패한다", () => {
  const input = regionalBusanInput();
  input.snapshots[0].rows[0].el_i = 9;

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.deepEqual(report.violations.snapshot, ["busan-transportation-accessibility:SNAPSHOT_IDENTITY_MISMATCH"]);
  assert.ok(report.violations.provenance.every((value) => value.endsWith("CLAIM_SNAPSHOT_BINDING_MISMATCH")));
});

test("지역 원천 snapshot 파일은 내용 hash와 관측일로 snapshot id를 유도한다", async (t) => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "easysubway-regional-accessibility-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const { snapshots: [snapshot] } = regionalCountInput("daegu");
  const { snapshotId: _snapshotId, snapshotPath: _snapshotPath, snapshotFileSha256: _fileSha256, ...fileJson } = snapshot;
  const bytes = `${JSON.stringify(fileJson, null, 2)}\n`;
  const derivedId = `daegu-transportation-accessibility-${hash(JSON.stringify(fileJson))}-20260728`;
  await writeFile(path.join(repositoryRoot, "regional.json"), bytes);

  const [loaded] = await loadAccessibilityAdmissionSnapshots({
    sources: [{
      id: "daegu-transportation-accessibility",
      accessibilityAdmissionEvidence: { snapshotId: derivedId, snapshotPath: "regional.json" },
    }],
    referencedSourceIds: new Set(["daegu-transportation-accessibility"]),
    repositoryRoot,
  });

  assert.equal(loaded.snapshotId, derivedId);
  assert.equal(loaded.snapshotFileSha256, hashBytes(bytes));
});

const REGIONAL_COUNT_KINDS = Object.freeze({
  daegu: { lineId: "line-daegu-1", row: { wheelchair_lift: 0, elevator: 4, escalator: 16 } },
  daejeon: { lineId: "line-daejeon-1", row: { wheelchair_lift: 0, elevator: 4, escalator: 2 } },
  gwangju: { lineId: "line-gwangju-1", row: { wheelchair_lift: 0, elevator: 2, escalator: 3 } },
});

function regionalSourceInput({ region, snapshotFields, rows, claims }) {
  const sourceId = `${region}-transportation-accessibility`;
  const capturedAt = "2026-07-27T23:00:00.000Z";
  const freshUntil = "2026-07-28T23:00:00.000Z";
  const rowsSha256 = hash(JSON.stringify(rows));
  const fileJson = {
    schemaVersion: 1,
    artifactKind: `${region}-accessibility-snapshot`,
    sourceId,
    capturedAt,
    freshUntil,
    stationCount: rows.length,
    rowCount: rows.length,
    ...snapshotFields,
    rowsSha256,
    rows,
  };
  const snapshotId = `${sourceId}-${hash(JSON.stringify(fileJson))}-20260728`;
  const snapshotPath = `tools/datapack/sources/${snapshotId}.json`;
  const licenseEvidenceHash = hash(`${region}-license`);
  return {
    evaluatedAt: EVALUATED_AT,
    artifacts: [{
      artifactId: "bundled-nationwide",
      sqliteSha256: hash("sqlite-nationwide"),
      searchableStationIds: [`station-${region}-100`],
      claims: claims({ sourceId, snapshotId, rowsSha256 }),
    }],
    inventory: {
      sources: [{
        id: sourceId,
        productionUseAllowed: true,
        license: { redistributionAllowed: true, attribution: "공식 제공기관" },
        admissionEvidence: { licenseEvidenceHash },
        capabilities: { facility: { status: "SUPPORTED", productionUseAllowed: true } },
        accessibilityAdmissionEvidence: {
          issue: 1,
          materializer: `tools/datapack/materialize-${region}-accessibility.mjs`,
          verificationTest: `tools/datapack/materialize-${region}-accessibility.test.mjs`,
          snapshotId,
          snapshotPath,
          capturedAt,
          freshUntil,
          stationCount: rows.length,
          rowCount: rows.length,
          rawSha256: fileJson.rawSha256,
          rowsSha256,
        },
      }],
    },
    snapshots: [{
      ...structuredClone(fileJson),
      snapshotId,
      snapshotPath,
      snapshotFileSha256: hash(`${snapshotId}-file`),
    }],
    sourceSnapshotPolicies: [{
      sourceId,
      snapshotId,
      capturedAt,
      rawSha256: fileJson.rawSha256,
      contentSha256: rowsSha256,
      snapshotStatus: "LOCKED",
      fetchStatus: "SUCCESS",
      schemaStatus: "PASS",
      licenseStatus: "PASS",
      redistributionAllowed: true,
      credentialRedacted: true,
      admissionEvidence: { licenseEvidenceHash },
      freshnessExpiresAt: "2026-10-26T23:00:00.000Z",
    }],
  };
}

function regionalCountInput(region) {
  const { lineId, row } = REGIONAL_COUNT_KINDS[region];
  const rows = [{ stationCode: "100", stationName: "역", lineId, ...row }];
  return regionalSourceInput({
    region,
    snapshotFields: { rawSha256: hash(`${region}-raw`) },
    rows,
    claims: ({ sourceId, snapshotId, rowsSha256 }) => ["ELEVATOR", "ESCALATOR"].flatMap((facilityType) => {
      const count = facilityType === "ELEVATOR" ? row.elevator : row.escalator;
      const base = regionalCountHash({ region, row: rows[0], facilityType, count });
      return [{
        stationId: `station-${region}-100`, stationName: "역", lineId, facilityType, domain: "STATION_FACILITY_EVIDENCE",
        evidenceKind: "EXISTS", sourceId, sourceSnapshotId: snapshotId, providerRecordHash: base, evidenceHash: rowsSha256,
      }, {
        claimId: `facility-${region}-100-${facilityType}`, stationId: `station-${region}-100`, stationName: "역", lineId: "", facilityType,
        domain: "FACILITY", evidenceKind: "EXISTS", sourceId, sourceSnapshotId: snapshotId,
        providerRecordHash: base, evidenceHash: rowsSha256,
      }];
    }),
  });
}

function regionalCountClaim(input, region, facilityType, count, evidenceKind) {
  const snapshot = input.snapshots[0];
  return {
    stationId: `station-${region}-100`,
    stationName: snapshot.rows[0].stationName,
    lineId: snapshot.rows[0].lineId,
    facilityType,
    domain: "STATION_FACILITY_EVIDENCE",
    evidenceKind,
    sourceId: snapshot.sourceId,
    sourceSnapshotId: snapshot.snapshotId,
    providerRecordHash: regionalCountHash({ region, row: snapshot.rows[0], facilityType, count }),
    evidenceHash: snapshot.rowsSha256,
  };
}

function regionalCountHash({ row, facilityType, count }) {
  return hash(JSON.stringify({
    stationCode: row.stationCode,
    lineId: row.lineId,
    type: facilityType,
    count,
    elevator: row.elevator,
    escalator: row.escalator,
    wheelchair_lift: row.wheelchair_lift,
  }));
}

function regionalBusanInput({ wheelchairRaw = "0" } = {}) {
  const lineId = "line-busan-1";
  const values = {
    sname: "동매", wl_i: wheelchairRaw, wl_o: wheelchairRaw, el_i: "2", el_o: "1", es: "0", blindroad: "1",
    ourbridge: "0", helptake: "0", toilet: "2", toilet_gubun: "분리",
  };
  const xml = `<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode></header><body><item>${
    Object.entries(values).map(([name, value]) => `<${name}>${value}</${name}>`).join("")
  }</item></body></response>`;
  const bytes = Buffer.from(xml);
  const rawResponses = [{ stationCode: "100", rawSha256: hashBytes(bytes), bytesBase64: bytes.toString("base64") }];
  // 잠긴 기존 snapshot은 빈 필드를 0으로 저장했다. 원문이 그 0의 근거인지 원문으로 다시 판정해야 한다.
  const rows = [{
    stationCode: "100", stationName: "동매", lineId,
    wl_i: 0, wl_o: 0, el_i: 2, el_o: 1, es: 0, blindroad: 1, ourbridge: 0, helptake: 0, toilet: 2,
    toilet_gubun: "분리",
  }];
  const busanHash = (facilityType, count) => hash(JSON.stringify({
    stationCode: "100", lineId, type: facilityType, count,
    wl_i: rows[0].wl_i, wl_o: rows[0].wl_o, el_i: rows[0].el_i, el_o: rows[0].el_o, es: rows[0].es,
  }));
  return regionalSourceInput({
    region: "busan",
    snapshotFields: {
      rawSha256: hash(JSON.stringify(rawResponses.map(({ stationCode, rawSha256 }) => ({ stationCode, rawSha256 })))),
      rawResponses,
    },
    rows,
    claims: ({ sourceId, snapshotId, rowsSha256 }) => [
      ["ELEVATOR", 3, "EXISTS"],
      ["ESCALATOR", 0, "NOT_EXISTS"],
      ["WHEELCHAIR_LIFT", 0, "NOT_EXISTS"],
    ].map(([facilityType, count, evidenceKind]) => ({
      stationId: "station-busan-100", stationName: "동매", lineId, facilityType, domain: "STATION_FACILITY_EVIDENCE", evidenceKind,
      sourceId, sourceSnapshotId: snapshotId, providerRecordHash: busanHash(facilityType, count), evidenceHash: rowsSha256,
    })),
  });
}

test("지역 claim은 원천 row의 역 이름에 결속되어 다른 역 stationId로 옮길 수 없다(F1)", () => {
  const input = regionalCountInput("daegu");
  assert.equal(buildAccessibilitySourceCoverageReport(input).decision, "GO");

  // loader는 stationId에서 정본 역 이름을 붙인다. 다른 역으로 옮기면 그 역의 이름이 따라온다.
  const moved = regionalCountInput("daegu");
  for (const claim of moved.artifacts[0].claims) Object.assign(claim, { stationId: "station-daegu-200", stationName: "다른역" });
  const movedReport = buildAccessibilitySourceCoverageReport(moved);
  assert.equal(movedReport.decision, "NO_GO");
  assert.equal(movedReport.violations.provenance.length, moved.artifacts[0].claims.length);
  assert.ok(movedReport.violations.provenance.every((value) => value.endsWith("CLAIM_SNAPSHOT_BINDING_MISMATCH")));

  // 정본 이름을 알 수 없는 claim도 결속하지 않는다.
  const unnamed = regionalCountInput("daegu");
  delete unnamed.artifacts[0].claims[0].stationName;
  assert.equal(buildAccessibilitySourceCoverageReport(unnamed).decision, "NO_GO");

  // 원천 이름의 괄호 부기·별칭은 후보 생성과 같은 규칙으로만 맞춘다.
  const annotated = regionalCountInput("daegu");
  annotated.snapshots[0].rows[0].stationName = "역(대학교)";
  annotated.snapshots[0].rowsSha256 = hash(JSON.stringify(annotated.snapshots[0].rows));
  annotated.inventory.sources[0].accessibilityAdmissionEvidence.rowsSha256 = annotated.snapshots[0].rowsSha256;
  annotated.sourceSnapshotPolicies[0].contentSha256 = annotated.snapshots[0].rowsSha256;
  for (const claim of annotated.artifacts[0].claims) claim.evidenceHash = annotated.snapshots[0].rowsSha256;
  assert.equal(buildAccessibilitySourceCoverageReport(annotated).decision, "GO");
});

test("지역 FACILITY claim은 설치 상태가 원천 count와 맞을 때만 결속된다(F2)", () => {
  const input = regionalCountInput("daegu");
  const zeroLift = regionalCountClaim(input, "daegu", "WHEELCHAIR_LIFT", 0, "NOT_EXISTS");
  const facility = { ...zeroLift, claimId: "facility-daegu-100-WHEELCHAIR_LIFT", lineId: "", domain: "FACILITY" };

  // count 0 row 위의 FACILITY 존재 주장은 지어낸 존재다.
  const fabricated = structuredClone(input);
  fabricated.artifacts[0].claims.push({ ...facility, evidenceKind: "EXISTS" });
  const fabricatedReport = buildAccessibilitySourceCoverageReport(fabricated);
  assert.equal(fabricatedReport.decision, "NO_GO");
  assert.deepEqual(fabricatedReport.violations.provenance, [
    "bundled-nationwide:station-daegu-100||WHEELCHAIR_LIFT|FACILITY:CLAIM_SNAPSHOT_BINDING_MISMATCH",
  ]);

  // 명시적 0의 미설치 시설 행은 부재로 결속된다.
  const notInstalled = structuredClone(input);
  notInstalled.artifacts[0].claims.push({ ...facility, evidenceKind: "NOT_EXISTS" });
  assert.deepEqual(buildAccessibilitySourceCoverageReport(notInstalled).violations, emptyViolations());

  // count가 양수인 row 위의 미설치 주장도 결속되지 않는다.
  const hidden = structuredClone(input);
  const elevator = hidden.artifacts[0].claims.find(({ domain, facilityType }) => domain === "FACILITY" && facilityType === "ELEVATOR");
  elevator.evidenceKind = "NOT_EXISTS";
  assert.equal(buildAccessibilitySourceCoverageReport(hidden).decision, "NO_GO");
});

test("facility 행의 설치 상태가 FACILITY claim의 evidenceKind가 된다(F2)", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-facility-installation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, "pack.sqlite");
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    CREATE TABLE stations (id TEXT, name_ko TEXT);
    CREATE TABLE station_lines (station_id TEXT, line_id TEXT);
    CREATE TABLE facilities (id TEXT, station_id TEXT, type TEXT, source_id TEXT, source_snapshot_id TEXT,
      provider_record_hash TEXT, evidence_hash TEXT, installation_status TEXT);
    INSERT INTO stations VALUES ('station-a', '역');
    INSERT INTO station_lines VALUES ('station-a', 'line-a');
    INSERT INTO facilities VALUES ('f-installed', 'station-a', 'ELEVATOR', 's', 'snap', 'h1', 'e1', 'INSTALLED');
    INSERT INTO facilities VALUES ('f-absent', 'station-a', 'WHEELCHAIR_LIFT', 's', 'snap', 'h2', 'e2', 'NOT_INSTALLED');
  `);
  database.close();
  const bytes = await readFile(sqlitePath);
  await mkdir(path.join(directory, "catalog"), { recursive: true });
  const gzipBytes = gzipSync(bytes);
  await writeFile(path.join(directory, "catalog", "pack.sqlite.gz"), gzipBytes);
  const manifest = { packs: [{
    id: "pack-a", url: "https://example.invalid/catalog/pack.sqlite.gz", sha256: hashBytes(gzipBytes), sqliteSha256: hashBytes(bytes),
  }] };
  const artifacts = await loadSelectableAccessibilityArtifacts({
    manifest, manifestRoot: directory, bundledIndex: { packs: [] }, bundledRoot: directory,
  }).catch((error) => error);
  if (artifacts instanceof Error) throw artifacts;
  const facilityClaims = artifacts.flatMap(({ claims }) => claims).filter(({ domain }) => domain === "FACILITY");
  assert.deepEqual(facilityClaims.map(({ claimId, evidenceKind }) => [claimId, evidenceKind]), [
    ["f-installed", "EXISTS"],
    ["f-absent", "NOT_EXISTS"],
  ]);
});

// 리뷰 F3: 지역 원천 검증의 각 조건은 다른 조건이 모두 맞을 때 단독으로 깨져도 정확히 한 위반을 낸다.
for (const [name, mutate, partition, code] of [
  ["license hash 형식", (input) => {
    input.inventory.sources[0].admissionEvidence.licenseEvidenceHash = "not-a-hash";
    input.sourceSnapshotPolicies[0].admissionEvidence.licenseEvidenceHash = "not-a-hash";
  }, "license", "LICENSE_EVIDENCE_MISMATCH"],
  ["policy license hash", (input) => {
    input.sourceSnapshotPolicies[0].admissionEvidence.licenseEvidenceHash = hash("other-license");
  }, "license", "LICENSE_EVIDENCE_MISMATCH"],
  ["시설 capability 상태", (input) => {
    input.inventory.sources[0].capabilities.facility.status = "CANDIDATE";
  }, "provenance", "ACCESSIBILITY_ADMISSION_NOT_APPROVED"],
  ["시설 capability 운영 허용", (input) => {
    input.inventory.sources[0].capabilities.facility.productionUseAllowed = false;
  }, "provenance", "ACCESSIBILITY_ADMISSION_NOT_APPROVED"],
  ["capturedAt 형식", (input) => {
    for (const target of [input.snapshots[0], input.inventory.sources[0].accessibilityAdmissionEvidence, input.sourceSnapshotPolicies[0]]) {
      target.capturedAt = "not-a-time";
    }
  }, "freshness", "SNAPSHOT_TIME_INVALID"],
  ["freshUntil 형식", (input) => {
    input.snapshots[0].freshUntil = "not-a-time";
    input.inventory.sources[0].accessibilityAdmissionEvidence.freshUntil = "not-a-time";
  }, "freshness", "SNAPSHOT_TIME_INVALID"],
  ["미래 capturedAt", (input) => {
    for (const target of [input.snapshots[0], input.inventory.sources[0].accessibilityAdmissionEvidence, input.sourceSnapshotPolicies[0]]) {
      target.capturedAt = "2026-07-28T00:00:00.001Z";
    }
  }, "freshness", "SNAPSHOT_TIME_INVALID"],
  ...["snapshotPath", "capturedAt", "freshUntil", "rawSha256", "rowsSha256", "stationCount", "rowCount"].map((key) => [
    `inventory ${key}`,
    (input) => {
      const evidence = input.inventory.sources[0].accessibilityAdmissionEvidence;
      evidence[key] = typeof evidence[key] === "number" ? evidence[key] + 1 : `${evidence[key]}-x`;
      if (key === "capturedAt") evidence[key] = "2026-07-27T22:00:00.000Z";
      if (key === "freshUntil") evidence[key] = "2026-07-28T22:00:00.000Z";
      if (key === "rawSha256" || key === "rowsSha256") evidence[key] = hash(`other-${key}`);
    },
    "snapshot",
    "SNAPSHOT_IDENTITY_MISMATCH",
  ]),
  ["rawSha256 형식", (input) => {
    input.snapshots[0].rawSha256 = "raw";
    input.inventory.sources[0].accessibilityAdmissionEvidence.rawSha256 = "raw";
    input.sourceSnapshotPolicies[0].rawSha256 = "raw";
  }, "snapshot", "SNAPSHOT_IDENTITY_MISMATCH"],
  ["policy capturedAt", (input) => {
    input.sourceSnapshotPolicies[0].capturedAt = "2026-07-27T22:00:00.000Z";
  }, "snapshot", "SNAPSHOT_IDENTITY_MISMATCH"],
  ["policy rawSha256", (input) => {
    input.sourceSnapshotPolicies[0].rawSha256 = hash("other-raw");
  }, "snapshot", "SNAPSHOT_IDENTITY_MISMATCH"],
  ["policy contentSha256", (input) => {
    input.sourceSnapshotPolicies[0].contentSha256 = hash("other-content");
  }, "snapshot", "SNAPSHOT_IDENTITY_MISMATCH"],
  ...["snapshotStatus", "fetchStatus", "schemaStatus", "licenseStatus"].map((key) => [
    `policy ${key}`, (input) => { input.sourceSnapshotPolicies[0][key] = "PENDING"; }, "snapshot", "SNAPSHOT_POLICY_MISMATCH",
  ]),
  ...["redistributionAllowed", "credentialRedacted"].map((key) => [
    `policy ${key}`, (input) => { input.sourceSnapshotPolicies[0][key] = false; }, "snapshot", "SNAPSHOT_POLICY_MISMATCH",
  ]),
  ["policy freshnessExpiresAt 형식", (input) => {
    input.sourceSnapshotPolicies[0].freshnessExpiresAt = "not-a-time";
  }, "freshness", "SNAPSHOT_STALE"],
  ["policy 만료", (input) => {
    input.sourceSnapshotPolicies[0].freshnessExpiresAt = EVALUATED_AT;
  }, "freshness", "SNAPSHOT_STALE"],
]) {
  test(`지역 원천 ${name}만 깨지면 ${code} 하나만 낸다(F3)`, () => {
    const input = regionalCountInput("daegu");
    mutate(input);

    const report = buildAccessibilitySourceCoverageReport(input);

    assert.equal(report.decision, "NO_GO");
    assert.deepEqual(report.violations[partition], [`daegu-transportation-accessibility:${code}`]);
    for (const other of Object.keys(emptyViolations()).filter((key) => key !== partition && key !== "provenance")) {
      assert.deepEqual(report.violations[other], [], `${other} must stay empty`);
    }
  });
}

test("rowsSha256과 다른 지역 row는 hash 밖 필드만 바뀌어도 claim을 결속하지 못한다(F3)", () => {
  const input = regionalCountInput("daegu");
  // provider record hash에 들어가지 않는 역 이름만 바꾸고 claim도 그 이름으로 맞춘다. rowsSha256은 그대로다.
  input.snapshots[0].rows[0].stationName = "바뀐역";
  for (const claim of input.artifacts[0].claims) claim.stationName = "바뀐역";

  const report = buildAccessibilitySourceCoverageReport(input);

  assert.equal(report.decision, "NO_GO");
  assert.equal(report.violations.provenance.filter((value) => value.endsWith("CLAIM_SNAPSHOT_BINDING_MISMATCH")).length,
    input.artifacts[0].claims.length);
});
