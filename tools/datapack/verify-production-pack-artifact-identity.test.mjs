import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { normalizeUnverifiedNetworkEdgeStates } from "./build-datapack.mjs";
import { verifyProductionPackArtifactIdentity } from "./verify-production-pack-artifact-identity.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const candidateReplayAt = JSON.parse(await readFile(
  path.join(root, "tools/datapack/release/candidate-build-spec.json"),
  "utf8",
)).publishedAt;
const env = {
  ...process.env,
  EASYSUBWAY_DATAPACK_BUILD_SPEC_VALIDATION_ONLY: "true",
  EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }),
  EASYSUBWAY_DATAPACK_BUILD_NOW: candidateReplayAt,
};
const verifierEnv = { ...process.env };
delete verifierEnv.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const DEPLOYED_ASSET_PATH = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
const DEPLOYED_INDEX_PATH = path.join(root, "apps/mobile/assets/datapacks/index.json");
const DEPLOYED_EVIDENCE_PATH = path.join(root, "tools/datapack/itx-cheongchun-topology-evidence.json");

function currentCapitalRouteMapTopologyAdmission(inventory, spec) {
  const snapshotId = spec.networkEdgeEvidence.capitalTopologyCandidate.snapshotId;
  const source = inventory.sources.find(({ routeMapAdmissionEvidence }) =>
    routeMapAdmissionEvidence?.currentTopologyAdmission?.topologySnapshotId === snapshotId);
  assert.ok(source, `current route-map admission is required for ${snapshotId}`);
  return source.routeMapAdmissionEvidence.currentTopologyAdmission;
}

async function loadFixtureBoundCandidate(workspace) {
  const spec = JSON.parse(await readFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
  const inventoryInput = spec.networkEdgeEvidence.sourceInventory;
  const inventoryBytes = await readFile(inventoryInput.path);
  const inventoryPath = path.join(workspace, "source-inventory.json");
  await writeFile(inventoryPath, inventoryBytes);
  spec.networkEdgeEvidence.sourceInventory = {
    ...inventoryInput,
    path: inventoryPath,
    sha256: sha256(inventoryBytes),
  };
  spec.sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(JSON.parse(inventoryBytes))));
  return spec;
}

test("reviewed accessibility edge identity is bound to its status probe", () => {
  const providerRecordHash = "a".repeat(64);
  const edge = {
    id: "edge-entry-sadang-seoul-4",
    fromNodeId: "station-sadang",
    toNodeId: "station-sadang:seoul-4",
    edgeType: "ENTRY",
    sourceId: "seoul-metro-accessibility",
    sourceSnapshotId: "seoul-metro-accessibility-20260728",
    providerRecordHash,
    evidenceHash: sha256(JSON.stringify({
      edgeId: "edge-entry-sadang-seoul-4",
      sourceSnapshotId: "seoul-metro-accessibility-20260728",
      providerRecordHash,
    })),
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "NOT_VERIFIED",
    accessibilityStatus: "NO_OFFICIAL_FEED",
    stairAccessState: "UNKNOWN",
    lastVerifiedAt: "2026-07-28T15:35:25.704Z",
  };
  const pack = { stationFacilityEvidence: [{
    stationId: "station-sadang",
    lineId: "seoul-4",
    facilityType: "ACCESSIBILITY_STATUS_PROBE",
    evidenceKind: "NOT_EXISTS",
    sourceId: edge.sourceId,
    sourceSnapshotId: edge.sourceSnapshotId,
    providerRecordHash,
    evidenceHash: sha256(JSON.stringify({
      snapshotId: edge.sourceSnapshotId,
      stationId: "station-sadang",
      lineId: "seoul-4",
      providerRecordHash,
    })),
  }] };

  const valid = { ...structuredClone(pack), networkEdges: [structuredClone(edge)] };
  normalizeUnverifiedNetworkEdgeStates(valid);
  assert.equal(valid.networkEdges[0].accessibilityStatus, "NO_OFFICIAL_FEED");
  for (const field of ["providerRecordHash", "evidenceHash"]) {
    const tampered = { ...structuredClone(pack), networkEdges: [{ ...edge, [field]: "b".repeat(64) }] };
    normalizeUnverifiedNetworkEdgeStates(tampered);
    assert.equal(tampered.networkEdges[0].accessibilityStatus, "UNKNOWN");
  }
});

test("production producer는 미승격 network edge와 역외 환승 link 상태를 UNKNOWN으로 내린다", () => {
  const verified = { verificationStatus: "VERIFIED", accessibilityStatus: "AVAILABLE", stairAccessState: "STEP_FREE" };
  const officialFeedAbsence = {
    id: "edge-entry-sadang-seoul-4",
    fromNodeId: "station-sadang",
    toNodeId: "station-sadang:seoul-4",
    edgeType: "ENTRY",
    sourceId: "seoul-metro-accessibility",
    sourceSnapshotId: "seoul-metro-accessibility-20260728",
    providerRecordHash: "a".repeat(64),
    evidenceHash: sha256(JSON.stringify({
      edgeId: "edge-entry-sadang-seoul-4",
      sourceSnapshotId: "seoul-metro-accessibility-20260728",
      providerRecordHash: "a".repeat(64),
    })),
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "NOT_VERIFIED",
    accessibilityStatus: "NO_OFFICIAL_FEED",
    stairAccessState: "UNKNOWN",
    lastVerifiedAt: "2026-07-28T15:35:25.704Z",
  };
  const expectedOfficialFeedAbsence = structuredClone(officialFeedAbsence);
  const pack = {
    networkEdges: [
      { verificationStatus: "UNKNOWN", accessibilityStatus: "AVAILABLE", stairAccessState: "STEP_FREE" },
      verified,
      officialFeedAbsence,
    ],
    stationFacilityEvidence: [{
      stationId: "station-sadang",
      lineId: "seoul-4",
      facilityType: "ACCESSIBILITY_STATUS_PROBE",
      evidenceKind: "NOT_EXISTS",
      sourceId: officialFeedAbsence.sourceId,
      sourceSnapshotId: officialFeedAbsence.sourceSnapshotId,
      providerRecordHash: officialFeedAbsence.providerRecordHash,
      evidenceHash: sha256(JSON.stringify({
        snapshotId: officialFeedAbsence.sourceSnapshotId,
        stationId: "station-sadang",
        lineId: "seoul-4",
        providerRecordHash: officialFeedAbsence.providerRecordHash,
      })),
    }],
    outOfStationTransferLinks: [{ accessibilityStatus: "AVAILABLE", stairAccessState: "STEP_FREE" }],
  };

  normalizeUnverifiedNetworkEdgeStates(pack);

  assert.deepEqual(pack.networkEdges[0], {
    verificationStatus: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    stairAccessState: "UNKNOWN",
  });
  assert.equal(pack.networkEdges[1], verified);
  assert.deepEqual(pack.networkEdges[2], expectedOfficialFeedAbsence);
  assert.deepEqual(pack.outOfStationTransferLinks[0], {
    accessibilityStatus: "UNKNOWN",
    stairAccessState: "UNKNOWN",
  });
});

test("deployed pack verifier는 current topology evidence와 pack identity를 검증한다", async () => {
  const evidence = JSON.parse(await readFile(DEPLOYED_EVIDENCE_PATH, "utf8"));
  assert.equal(Object.hasOwn(evidence, "readmissions"), false);
  const report = await verifyProductionPackArtifactIdentity({
    evidencePath: DEPLOYED_EVIDENCE_PATH,
    assetPath: DEPLOYED_ASSET_PATH,
    indexPath: DEPLOYED_INDEX_PATH,
    packId: "capital",
  });
  assert.equal(report.packId, "capital");
  assert.equal(report.gzipSha256, evidence.pack.outputSha256);
  assert.equal(report.sqliteSha256, evidence.pack.outputSqliteSha256);
  assert.equal(report.byteSize, evidence.pack.byteSize);
  assert.equal(report.rowCounts.network_edges, report.networkEdgeCounts.total);
});

test("deployed pack verifier는 readmission과 invalid current evidence를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-current-topology-evidence-"));
  const trackedEvidence = JSON.parse(await readFile(DEPLOYED_EVIDENCE_PATH, "utf8"));
  const cases = [
    ["empty-readmissions", (evidence) => ({ ...evidence, readmissions: [] })],
    ["nonempty-readmissions", (evidence) => ({ ...evidence, readmissions: [{}] })],
    ["invalid-schema-version", (evidence) => ({ ...evidence, schemaVersion: 2 })],
    ["invalid-artifact-kind", (evidence) => ({ ...evidence, artifactKind: "replacement-evidence" })],
  ];
  try {
    for (const [name, mutate] of cases) {
      const evidencePath = path.join(workspace, `${name}.json`);
      await writeFile(evidencePath, `${JSON.stringify(mutate(structuredClone(trackedEvidence)), null, 2)}\n`);
      await assert.rejects(
        verifyProductionPackArtifactIdentity({
          evidencePath,
          assetPath: DEPLOYED_ASSET_PATH,
          indexPath: DEPLOYED_INDEX_PATH,
          packId: "capital",
        }),
        /deployed current topology evidence contract mismatch/,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deployed pack과 bundled asset/index의 artifact identity를 exact-match한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-production-pack-identity-"));
  const assetPath = DEPLOYED_ASSET_PATH;
  const indexPath = path.join(workspace, "index.json");
  const evidencePath = path.join(workspace, "itx-cheongchun-topology-evidence.json");
  try {
    const buildSpec = JSON.parse(await readFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
    const hashEvidence = JSON.parse(await readFile("tools/datapack/release/hash-evidence.json", "utf8"));
    assert.equal(hashEvidence.fixturePath.value, buildSpec.fixturePath);
    const canonicalFixtureBytes = await readFile(buildSpec.fixturePath);
    assert.equal(hashEvidence.fixturePath.sha256, sha256(canonicalFixtureBytes));
    await Promise.all([
      copyFile(DEPLOYED_INDEX_PATH, indexPath),
      copyFile(DEPLOYED_EVIDENCE_PATH, evidencePath),
    ]);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const gzipBytes = await readFile(assetPath);
    const sqliteBytes = gunzipSync(gzipBytes);
    const sqlitePath = path.join(workspace, "capital.sqlite");
    await writeFile(sqlitePath, sqliteBytes);
    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    let expectedNetworkEdgeCounts;
    try {
      assert.deepEqual(database.prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'sqlite_stat%' ORDER BY name",
      ).all(), []);
      const provenance = database.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(verification_status = 'UNKNOWN') AS unknownCount,
          SUM(
            source_id != '' AND source_snapshot_id != ''
            AND length(provider_record_hash) = 64
            AND provider_record_hash NOT GLOB '*[^0-9a-f]*'
            AND length(evidence_hash) = 64
            AND evidence_hash NOT GLOB '*[^0-9a-f]*'
            AND provenance_kind != 'UNKNOWN'
            AND verification_status != 'UNKNOWN'
            AND last_verified_at IS NOT NULL
          ) AS provenanceComplete,
          SUM(
            source_id != '' AND source_snapshot_id != ''
            AND length(provider_record_hash) = 64
            AND provider_record_hash NOT GLOB '*[^0-9a-f]*'
            AND length(evidence_hash) = 64
            AND evidence_hash NOT GLOB '*[^0-9a-f]*'
            AND provenance_kind IN ('OFFICIAL_SOURCE', 'OPERATOR_CONFIRMED', 'FIELD_SURVEY')
            AND verification_status = 'VERIFIED'
            AND last_verified_at IS NOT NULL
            AND evidence_hash NOT IN (${Array.from({ length: 16 }, (_, value) => `'${value.toString(16).repeat(64)}'`).join(", ")})
          ) AS strictEligible,
          SUM(
            verification_status = 'VERIFIED'
            AND (
              source_id = '' OR source_snapshot_id = '' OR provider_record_hash = ''
              OR provenance_kind != 'OFFICIAL_SOURCE' OR last_verified_at IS NULL
              OR evidence_hash = ''
            )
          ) AS incompleteVerifiedCount,
          SUM(
            verification_status = 'UNKNOWN'
            AND (accessibility_status != 'UNKNOWN' OR stair_access_state != 'UNKNOWN')
          ) AS unsafeUnknownCount,
          SUM(
            service_class = 'ITX_CHEONGCHUN'
            AND verification_status = 'VERIFIED'
          ) AS verifiedItxCount
        FROM network_edges
      `).get();
      assert.ok(provenance.unknownCount > 0);
      assert.equal(provenance.incompleteVerifiedCount, 0);
      assert.equal(provenance.unsafeUnknownCount, 0);
      assert.equal(provenance.verifiedItxCount, evidence.topology.edgeCount);
      expectedNetworkEdgeCounts = {
        total: provenance.total,
        provenanceComplete: provenance.provenanceComplete,
        strictEligible: provenance.strictEligible,
      };
      assert.deepEqual(database.prepare(`
        SELECT DISTINCT source_id AS sourceId
        FROM network_edges
        WHERE service_class = 'ITX_CHEONGCHUN'
      `).all().map(({ sourceId }) => sourceId), ["itx-cheongchun-source-timetable"]);
      const unsupportedCapitalLine = database.prepare(`
        SELECT COUNT(*) AS edgeCount,
               SUM(verification_status = 'VERIFIED') AS verifiedCount
        FROM network_edges
        WHERE from_node_id GLOB '*:line-472a81add377'
      `).get();
      assert.ok(unsupportedCapitalLine.edgeCount > 0);
      assert.equal(unsupportedCapitalLine.verifiedCount, 0);
    } finally {
      database.close();
    }
    const { stdout } = await execFileAsync(process.execPath, [
      "tools/datapack/verify-production-pack-artifact-identity.mjs",
      "--evidence", evidencePath,
      "--asset", assetPath,
      "--index", indexPath,
      "--pack-id", "capital",
    ], { cwd: root, env: verifierEnv });
    const report = JSON.parse(stdout);
    assert.equal(report.gzipSha256, evidence.pack.outputSha256);
    assert.equal(report.sqliteSha256, evidence.pack.outputSqliteSha256);
    assert.equal(report.byteSize, evidence.pack.byteSize);
    assert.ok(report.rowCounts.stations > 0);
    assert.deepEqual(report.networkEdgeCounts, expectedNetworkEdgeCounts);
    assert.deepEqual(await verifyProductionPackArtifactIdentity({
      evidencePath,
      assetPath,
      indexPath,
      packId: "capital",
    }), report);

    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const capitalIndex = index.packs.find(({ id }) => id === "capital");
    capitalIndex.asset = "assets/datapacks/core.sqlite.gz";
    await writeFile(indexPath, `${JSON.stringify(index)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/verify-production-pack-artifact-identity.mjs",
        "--evidence", evidencePath,
        "--asset", assetPath,
        "--index", indexPath,
        "--pack-id", "capital",
      ], { cwd: root, env: verifierEnv }),
      /index asset mismatch/,
    );
    capitalIndex.asset = "assets/datapacks/capital.sqlite.gz";
    capitalIndex.sha256 = "f".repeat(64);
    await writeFile(indexPath, `${JSON.stringify(index)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/verify-production-pack-artifact-identity.mjs",
        "--evidence", evidencePath,
        "--asset", assetPath,
        "--index", indexPath,
        "--pack-id", "capital",
      ], { cwd: root, env: verifierEnv }),
      /ITX topology evidence or bundled pack index is stale/,
    );
    evidence.pack.outputSha256 = "e".repeat(64);
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await assert.rejects(
      verifyProductionPackArtifactIdentity({ evidencePath, assetPath, indexPath: DEPLOYED_INDEX_PATH, packId: "capital" }),
      /ITX topology evidence or bundled pack index is stale/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unchanged candidate는 현재 source inventory 결속을 그대로 검증한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-current-source-inventory-binding-"));
  try {
    const spec = JSON.parse(await readFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
    const inventoryBytes = await readFile(spec.networkEdgeEvidence.sourceInventory.path);
    const rawInventoryBound = spec.networkEdgeEvidence.sourceInventory.sha256 === sha256(inventoryBytes);
    const semanticInventoryBound = spec.sourceInventorySha256
      === sha256(Buffer.from(JSON.stringify(JSON.parse(inventoryBytes))));
    const specPath = path.join(workspace, "unchanged-candidate-build-spec.json");
    await copyFile("tools/datapack/release/candidate-build-spec.json", specPath);

    let failure;
    try {
      await execFileAsync(process.execPath, [
        "tools/datapack/build-datapack.mjs",
        "--build-spec", specPath,
        "--output", path.join(workspace, "output"),
      ], { cwd: root, env });
    } catch (error) {
      failure = error;
    }
    const output = `${failure?.stderr ?? ""}${failure?.stdout ?? ""}`;
    if (!rawInventoryBound) {
      assert.ok(failure, "unbound raw inventory must be rejected");
      assert.match(output, /sourceInventory\.sha256 must match tracked input bytes/);
    } else if (!semanticInventoryBound) {
      assert.ok(failure, "unbound semantic inventory must be rejected");
      assert.match(output, /network edge source inventory must match buildSpec\.sourceInventorySha256/);
    } else {
      assert.doesNotMatch(output,
        /sourceInventory\.sha256 must match tracked input bytes|network edge source inventory must match buildSpec\.sourceInventorySha256/);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("capital topology reverification은 24시간을 넘는 freshness를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-topology-reverification-freshness-"));
  try {
    const spec = await loadFixtureBoundCandidate(workspace);
    const evidence = JSON.parse(await readFile(
      spec.networkEdgeEvidence.capitalTopologyReverification.path,
      "utf8",
    ));
    evidence.candidate.freshUntil = new Date(
      Date.parse(evidence.candidate.capturedAt) + 24 * 60 * 60 * 1000 + 1,
    ).toISOString();
    const candidate = JSON.parse(await readFile(
      spec.networkEdgeEvidence.capitalTopologyCandidate.path,
      "utf8",
    ));
    candidate.freshUntil = evidence.candidate.freshUntil;
    const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
    const candidatePath = path.join(workspace, "capital-route-topology.json");
    await writeFile(candidatePath, candidateBytes);
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    const evidencePath = path.join(workspace, "capital-topology-reverification.json");
    await writeFile(evidencePath, evidenceBytes);
    spec.networkEdgeEvidence.capitalTopologyReverification = {
      path: evidencePath,
      sha256: sha256(evidenceBytes),
    };
    spec.networkEdgeEvidence.capitalTopologyCandidate = {
      ...spec.networkEdgeEvidence.capitalTopologyCandidate,
      path: candidatePath,
      sha256: sha256(candidateBytes),
    };
    spec.networkEdgeEvidence.capitalTopologyAdmission.freshUntil = evidence.candidate.freshUntil;
    const specPath = path.join(workspace, "candidate-build-spec.json");
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--build-spec", specPath,
      "--output", path.join(workspace, "output"),
    ], {
      cwd: root,
      env,
    }), /capital topology reverification freshness is invalid/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("capital topology reverification은 candidate line identity repin 변조를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-topology-reverification-identity-"));
  try {
    const spec = await loadFixtureBoundCandidate(workspace);
    const evidence = JSON.parse(await readFile(
      spec.networkEdgeEvidence.capitalTopologyReverification.path,
      "utf8",
    ));
    evidence.candidate.lines[0].rawSha256 = "b".repeat(64);
    evidence.candidate.contentSha256 = "c".repeat(64);
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    const evidencePath = path.join(workspace, "capital-topology-reverification.json");
    await writeFile(evidencePath, evidenceBytes);
    spec.networkEdgeEvidence.capitalTopologyReverification = {
      path: evidencePath,
      sha256: sha256(evidenceBytes),
    };
    const specPath = path.join(workspace, "candidate-build-spec.json");
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--build-spec", specPath,
      "--output", path.join(workspace, "output"),
    ], {
      cwd: root,
      env,
    }), /capital topology reverification candidate snapshot mismatch/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("capital topology reverification은 independently pinned candidate와 다른 self-attested repin을 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-topology-reverification-candidate-"));
  try {
    const spec = await loadFixtureBoundCandidate(workspace);
    const candidatePath = spec.networkEdgeEvidence.capitalTopologyCandidate.path;
    const candidateBytes = await readFile(candidatePath);
    const candidate = JSON.parse(candidateBytes);
    const evidence = JSON.parse(await readFile(
      spec.networkEdgeEvidence.capitalTopologyReverification.path,
      "utf8",
    ));
    candidate.lines[0].rawSha256 = "b".repeat(64);
    evidence.candidate.lines[0].rawSha256 = candidate.lines[0].rawSha256;
    evidence.candidate.contentSha256 = sha256(Buffer.from(JSON.stringify({
      lines: candidate.lines.map(({
        lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId,
      }) => ({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId })),
      topologyGaps: candidate.topologyGaps,
    })));
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    const evidencePath = path.join(workspace, "capital-topology-reverification.json");
    await writeFile(evidencePath, evidenceBytes);
    spec.networkEdgeEvidence.capitalTopologyCandidate = {
      ...spec.networkEdgeEvidence.capitalTopologyCandidate,
      path: candidatePath,
      sha256: sha256(candidateBytes),
    };
    spec.networkEdgeEvidence.capitalTopologyReverification = {
      path: evidencePath,
      sha256: sha256(evidenceBytes),
    };
    const specPath = path.join(workspace, "candidate-build-spec.json");
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--build-spec", specPath,
      "--output", path.join(workspace, "output"),
    ], {
      cwd: root,
      env,
    }), /capital topology reverification candidate snapshot mismatch/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("capital topology reverification은 candidate line capture clock repin을 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-topology-reverification-line-clock-"));
  try {
    const spec = await loadFixtureBoundCandidate(workspace);
    const candidate = JSON.parse(await readFile(
      spec.networkEdgeEvidence.capitalTopologyCandidate.path,
      "utf8",
    ));
    candidate.lines[0].capturedAt = "2026-08-03T17:30:34.901Z";
    const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
    const candidatePath = path.join(workspace, "capital-route-topology.json");
    await writeFile(candidatePath, candidateBytes);
    spec.networkEdgeEvidence.capitalTopologyCandidate = {
      ...spec.networkEdgeEvidence.capitalTopologyCandidate,
      path: candidatePath,
      sha256: sha256(candidateBytes),
    };
    const specPath = path.join(workspace, "candidate-build-spec.json");
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--build-spec", specPath,
      "--output", path.join(workspace, "output"),
    ], {
      cwd: root,
      env,
    }), /capital topology reverification candidate snapshot mismatch/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("capital topology reverification은 production eligibility repin을 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-topology-reverification-eligibility-"));
  try {
    const mutations = [
      ["unofficial", (candidate) => { candidate.official = false; }],
      ["fixture", (candidate) => { candidate.fixture = true; }],
      ["credential", (candidate) => { candidate.credentialRequired = true; }],
      ["redaction", (candidate) => { candidate.credentialRedacted = false; }],
      ["missing-redaction", (candidate) => { delete candidate.credentialRedacted; }],
      ["redistribution", (candidate) => { candidate.license.redistributionAllowed = false; }],
    ];
    for (const [name, mutate] of mutations) {
      const spec = await loadFixtureBoundCandidate(workspace);
      const candidate = JSON.parse(await readFile(
        spec.networkEdgeEvidence.capitalTopologyCandidate.path,
        "utf8",
      ));
      mutate(candidate);
      const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
      const candidatePath = path.join(workspace, `${name}.json`);
      await writeFile(candidatePath, candidateBytes);
      spec.networkEdgeEvidence.capitalTopologyCandidate = {
        ...spec.networkEdgeEvidence.capitalTopologyCandidate,
        path: candidatePath,
        sha256: sha256(candidateBytes),
      };
      const specPath = path.join(workspace, `${name}-build-spec.json`);
      await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

      await assert.rejects(execFileAsync(process.execPath, [
        "tools/datapack/build-datapack.mjs",
        "--build-spec", specPath,
        "--output", path.join(workspace, `${name}-output`),
      ], {
        cwd: root,
        env,
      }), /capital topology reverification candidate snapshot mismatch/);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unchanged capital topology reverification은 content review와 fresh review 시각을 분리한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-topology-reverification-review-clock-"));
  try {
    const spec = JSON.parse(await readFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
    spec.networkEdgeEvidence.capitalTopologyAdmission.reviewedAt = "2026-07-27T21:38:29.000Z";
    spec.networkEdgeEvidence.capitalTopologyAdmission.reverifiedAt = spec.publishedAt;
    const specPath = path.join(workspace, "candidate-build-spec.json");
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    try {
      await execFileAsync(process.execPath, [
        "tools/datapack/build-datapack.mjs",
        "--build-spec", specPath,
        "--output", path.join(workspace, "output"),
      ], {
        cwd: root,
        env,
      });
    } catch (error) {
      assert.doesNotMatch(
        `${error.stderr ?? ""}${error.stdout ?? ""}`,
        /capital topology reverification/,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("network edge evidence는 pinned bytes·freshness·fixture projection mismatch를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-network-edge-evidence-"));
  const outputDir = path.join(workspace, "output");
  const spec = await loadFixtureBoundCandidate(workspace);
  const inventory = JSON.parse(await readFile(spec.networkEdgeEvidence.sourceInventory.path, "utf8"));
  const currentAccessibilityAdmissions = new Map(inventory.sources
    .filter(({ id }) => ["kric-station-convenience-standard", "seoul-metro-accessibility"].includes(id))
    .map(({ id, accessibilityAdmissionEvidence }) => [id, accessibilityAdmissionEvidence]));
  assert.equal(currentAccessibilityAdmissions.size, 2);
  const currentAccessibilityFixture = JSON.parse(await readFile(spec.fixturePath, "utf8"));
  for (const pack of currentAccessibilityFixture.packs.filter(({ artifactKind }) => artifactKind === "production")) {
    const kricTuplesByStationLine = new Map((pack.facilities ?? [])
      .filter(({ sourceId }) => sourceId === "kric-station-convenience-standard")
      .map((row) => {
        const [railOprIsttCd, lnCd, stinCd] = row.providerFacilityRef.split(":");
        return [`${row.stationId}\0${row.lineId}`, { railOprIsttCd, lnCd, stinCd }];
      }));
    const rows = [
      ...(pack.facilities ?? []),
      ...(pack.stationFacilityEvidence ?? []),
      ...(pack.networkEdges ?? []).filter(({ edgeType }) => ["ENTRY", "EXIT"].includes(edgeType)),
    ];
    for (const row of rows) {
      const admission = currentAccessibilityAdmissions.get(row.sourceId);
      if (!admission || row.sourceSnapshotId === admission.snapshotId) continue;
      row.sourceSnapshotId = admission.snapshotId;
      if (Object.hasOwn(row, "verifiedAt")) row.verifiedAt = admission.observedAt;
      if (Object.hasOwn(row, "retrievedAt")) row.retrievedAt = admission.capturedAt;
      if (Object.hasOwn(row, "lastVerifiedAt")) row.lastVerifiedAt = admission.observedAt;
      if (row.sourceId === "kric-station-convenience-standard") {
        const query = kricTuplesByStationLine.get(`${row.stationId}\0${row.lineId}`);
        assert.ok(query);
        row.evidenceHash = row.evidenceKind === "NOT_EXISTS"
          ? sha256(JSON.stringify({
              snapshotId: admission.snapshotId,
              query,
              type: row.facilityType,
              evidenceKind: "NOT_EXISTS",
            }))
          : sha256(JSON.stringify({
              snapshotId: admission.snapshotId,
              query,
              providerRecordHash: row.providerRecordHash,
            }));
      } else if (row.facilityType === "ACCESSIBILITY_STATUS_PROBE") {
        row.evidenceHash = sha256(JSON.stringify({
          snapshotId: admission.snapshotId,
          stationId: row.stationId,
          lineId: row.lineId,
          providerRecordHash: row.providerRecordHash,
        }));
      } else if (["ENTRY", "EXIT"].includes(row.edgeType)) {
        row.evidenceHash = sha256(JSON.stringify({
          edgeId: row.id,
          sourceSnapshotId: admission.snapshotId,
          providerRecordHash: row.providerRecordHash,
        }));
      } else {
        throw new Error(`unsupported accessibility fixture rebind: ${row.sourceId}`);
      }
    }
  }
  const currentAccessibilityFixturePath = path.join(workspace, "current-accessibility-fixture.json");
  await writeFile(currentAccessibilityFixturePath, `${JSON.stringify(currentAccessibilityFixture)}\n`);
  spec.fixturePath = currentAccessibilityFixturePath;
  const runRejectedBuild = async (candidate, pattern) => {
    const specPath = path.join(workspace, `spec-${Date.now()}.json`);
    await writeFile(specPath, `${JSON.stringify(candidate, null, 2)}\n`);
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--build-spec", specPath,
      "--output", outputDir,
    ], { cwd: root, env }), pattern);
  };
  const runRejectedContractBuild = async (label, mutate, pattern) => {
    const contract = JSON.parse(await readFile("tools/datapack/itx-cheongchun-coverage-contract.json", "utf8"));
    mutate(contract);
    const bytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
    const contractPath = path.join(workspace, `${label}.json`);
    await writeFile(contractPath, bytes);
    const candidate = structuredClone(spec);
    candidate.networkEdgeEvidence.itxCoverageContract = { path: contractPath, sha256: sha256(bytes) };
    await runRejectedBuild(candidate, pattern);
  };
  const runRejectedCompletenessBuild = async (label, mutate, pattern) => {
    const contract = JSON.parse(await readFile("tools/datapack/itx-cheongchun-coverage-contract.json", "utf8"));
    const source = JSON.parse(await readFile(contract.sourceTimetableArtifact.artifactPath, "utf8"));
    const completeness = JSON.parse(await readFile(contract.sourceTimetableArtifact.completenessEvidencePath, "utf8"));
    mutate({ source, completeness, reference: contract.sourceTimetableArtifact });
    const { evidenceHash: ignored, ...withoutEvidenceHash } = completeness;
    completeness.evidenceHash = sha256(Buffer.from(JSON.stringify(withoutEvidenceHash)));
    const completenessBytes = Buffer.from(`${JSON.stringify(completeness, null, 2)}\n`);
    const completenessPath = path.join(workspace, `${label}-completeness.json`);
    await writeFile(completenessPath, completenessBytes);
    source.completenessEvidenceSha256 = sha256(completenessBytes);
    const { evidenceHash: ignoredSourceHash, ...sourceWithoutEvidenceHash } = source;
    source.evidenceHash = sha256(Buffer.from(JSON.stringify(sourceWithoutEvidenceHash)));
    const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
    const sourcePath = path.join(workspace, `${label}-source.json`);
    await writeFile(sourcePath, sourceBytes);
    contract.sourceTimetableArtifact.artifactPath = sourcePath;
    contract.sourceTimetableArtifact.sha256 = sha256(sourceBytes);
    contract.sourceTimetableArtifact.completenessEvidencePath = completenessPath;
    contract.sourceTimetableArtifact.completenessEvidenceSha256 = sha256(completenessBytes);
    const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
    const contractPath = path.join(workspace, `${label}-contract.json`);
    await writeFile(contractPath, contractBytes);
    const candidate = structuredClone(spec);
    candidate.networkEdgeEvidence.itxCoverageContract = { path: contractPath, sha256: sha256(contractBytes) };
    await runRejectedBuild(candidate, pattern);
  };
  try {
    const missingEvidence = structuredClone(spec);
    delete missingEvidence.networkEdgeEvidence;
    await runRejectedBuild(missingEvidence, /production build requires network edge evidence/);

    const tampered = structuredClone(spec);
    tampered.networkEdgeEvidence.sourceInventory.sha256 = "f".repeat(64);
    await runRejectedBuild(tampered, /sourceInventory\.sha256 must match tracked input bytes/);

    const overclaimedTopology = JSON.parse(await readFile(
      "tools/datapack/sources/capital-route-topology-20260724.json",
      "utf8",
    ));
    overclaimedTopology.fieldsProvided.push("duration_seconds");
    const overclaimedTopologyBytes = Buffer.from(`${JSON.stringify(overclaimedTopology)}\n`);
    const overclaimedTopologyPath = path.join(workspace, "overclaimed-capital-topology.json");
    await writeFile(overclaimedTopologyPath, overclaimedTopologyBytes);
    const overclaimed = structuredClone(spec);
    overclaimed.networkEdgeEvidence.capitalTopology.path = overclaimedTopologyPath;
    overclaimed.networkEdgeEvidence.capitalTopology.sha256 = sha256(overclaimedTopologyBytes);
    await runRejectedBuild(overclaimed, /capital topology fieldsProvided is invalid/);

    const ungovernedInventory = JSON.parse(await readFile("tools/datapack/source-inventory.json", "utf8"));
    ungovernedInventory.reviewProbe = true;
    const ungovernedBytes = Buffer.from(`${JSON.stringify(ungovernedInventory, null, 2)}\n`);
    const ungovernedPath = path.join(workspace, "ungoverned-source-inventory.json");
    await writeFile(ungovernedPath, ungovernedBytes);
    const ungoverned = structuredClone(spec);
    ungoverned.networkEdgeEvidence.sourceInventory = {
      path: ungovernedPath,
      sha256: sha256(ungovernedBytes),
    };
    await runRejectedBuild(ungoverned, /network edge source inventory must match buildSpec.sourceInventorySha256/);

    const staleInventory = JSON.parse(await readFile("tools/datapack/source-inventory.json", "utf8"));
    currentCapitalRouteMapTopologyAdmission(staleInventory, spec).freshUntil =
      new Date(Date.parse(spec.publishedAt) - 1).toISOString();
    const staleBytes = Buffer.from(`${JSON.stringify(staleInventory, null, 2)}\n`);
    const stalePath = path.join(workspace, "stale-source-inventory.json");
    await writeFile(stalePath, staleBytes);
    const stale = structuredClone(spec);
    stale.networkEdgeEvidence.sourceInventory = { path: stalePath, sha256: sha256(staleBytes) };
    stale.sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(staleInventory)));
    await runRejectedBuild(stale, /capital current topology admission is stale/);

    const futureInventory = JSON.parse(await readFile("tools/datapack/source-inventory.json", "utf8"));
    const futureReviewedAt = new Date(Date.parse(spec.publishedAt) + 1).toISOString();
    currentCapitalRouteMapTopologyAdmission(futureInventory, spec).reviewedAt = futureReviewedAt;
    const futureInventoryBytes = Buffer.from(`${JSON.stringify(futureInventory, null, 2)}\n`);
    const futureInventoryPath = path.join(workspace, "future-source-inventory.json");
    await writeFile(futureInventoryPath, futureInventoryBytes);
    const futureInventorySpec = structuredClone(spec);
    futureInventorySpec.networkEdgeEvidence.sourceInventory = {
      path: futureInventoryPath,
      sha256: sha256(futureInventoryBytes),
    };
    futureInventorySpec.networkEdgeEvidence.capitalTopologyAdmission.reviewedAt = futureReviewedAt;
    futureInventorySpec.networkEdgeEvidence.capitalTopologyAdmission.reverifiedAt = futureReviewedAt;
    futureInventorySpec.sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(futureInventory)));
    await runRejectedBuild(futureInventorySpec, /capital topology edge admission is future-dated/);

    const earlyInventory = JSON.parse(await readFile("tools/datapack/source-inventory.json", "utf8"));
    currentCapitalRouteMapTopologyAdmission(earlyInventory, spec).freshUntil = new Date(
      Date.parse(spec.publishedAt) + 30 * 60 * 1000,
    ).toISOString();
    const earlyBytes = Buffer.from(`${JSON.stringify(earlyInventory, null, 2)}\n`);
    const earlyPath = path.join(workspace, "early-source-inventory.json");
    await writeFile(earlyPath, earlyBytes);
    const early = structuredClone(spec);
    early.networkEdgeEvidence.sourceInventory = { path: earlyPath, sha256: sha256(earlyBytes) };
    early.sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(earlyInventory)));
    const earlySpecPath = path.join(workspace, "early-spec.json");
    const earlyOutputDir = path.join(workspace, "early-output");
    await writeFile(earlySpecPath, `${JSON.stringify(early, null, 2)}\n`);
    await execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--build-spec", earlySpecPath,
      "--output", earlyOutputDir,
    ], { cwd: root, env });
    const earlyManifest = JSON.parse(await readFile(path.join(earlyOutputDir, "current.json"), "utf8"));
    assert.equal(earlyManifest.expiresAt, new Date(Date.parse(spec.publishedAt) + 30 * 60 * 1000).toISOString());

    const missingEdgeAdmission = structuredClone(spec);
    delete missingEdgeAdmission.networkEdgeEvidence.capitalTopologyAdmission;
    await runRejectedBuild(missingEdgeAdmission, /production build requires capital topology edge admission/);

    const staleEdgeAdmission = structuredClone(spec);
    staleEdgeAdmission.networkEdgeEvidence.capitalTopologyAdmission = {
      ...staleEdgeAdmission.networkEdgeEvidence.capitalTopologyAdmission,
      freshUntil: "2026-07-27T21:38:30.000Z",
    };
    await runRejectedBuild(staleEdgeAdmission, /capital topology edge admission is stale/);

    await runRejectedContractBuild("missing-itx-topology-admission", (contract) => {
      contract.coverageStates.route_graph_topology = "MISSING";
      contract.allowedConsumerIssues.push("#2649");
    }, /ITX network edge topology is not admitted for #2649/);

    await runRejectedContractBuild("unauthorized-itx-topology-consumer", (contract) => {
      contract.coverageStates.route_graph_topology = "SUPPORTED";
      contract.allowedConsumerIssues = contract.allowedConsumerIssues.filter((issue) => issue !== "#2649");
    }, /ITX network edge topology is not admitted for #2649/);

    await runRejectedContractBuild("supported-itx-timetable-claim", (contract) => {
      contract.coverageStates.schedule_timetable = "SUPPORTED";
    }, /ITX network edge claim boundary is invalid/);

    await runRejectedContractBuild("go-itx-claim", (contract) => {
      contract.claimGate.currentStatus = "GO";
    }, /ITX network edge claim boundary is invalid/);

    await runRejectedContractBuild("allowed-itx-claim", (contract) => {
      contract.claimGate.supportClaimAllowed = true;
    }, /ITX network edge claim boundary is invalid/);

    await runRejectedCompletenessBuild("missing-itx-nested-admission", ({ completeness }) => {
      completeness.sourceTimetableArtifact.status = "MISSING";
    }, /ITX network edge topology is not admitted for #2649/);

    await runRejectedCompletenessBuild("drifted-itx-service-dates", ({ completeness }) => {
      completeness.selectedServiceDates["7"] = "20260808";
    }, /ITX network edge topology is not admitted for #2649/);

    await runRejectedCompletenessBuild("noncanonical-itx-policy", ({ source, completeness, reference }) => {
      source.policyVersion = "review-probe-v1";
      completeness.sourceTimetableArtifact.policyVersion = source.policyVersion;
      reference.policyVersion = source.policyVersion;
    }, /ITX network edge topology is not admitted for #2649/);

    await runRejectedCompletenessBuild("shifted-itx-service-dates", ({ source, completeness, reference }) => {
      source.observedAt = "2026-08-03T07:18:53.886Z";
      completeness.observedAt = source.observedAt;
      source.selectedServiceDates = { "7": "20260808", "8": "20260803", "9": "20260809" };
      completeness.selectedServiceDates = structuredClone(source.selectedServiceDates);
      source.freshUntil = "2026-08-10T00:00:00+09:00";
      completeness.sourceTimetableArtifact.freshUntil = source.freshUntil;
      reference.freshUntil = source.freshUntil;
    }, /ITX network edge topology is not admitted for #2649/);

    await runRejectedCompletenessBuild("unbound-itx-freshness", ({ source, completeness, reference }) => {
      source.freshUntil = "2026-08-04T00:00:00+09:00";
      completeness.sourceTimetableArtifact.freshUntil = source.freshUntil;
      reference.freshUntil = source.freshUntil;
    }, /ITX network edge topology is not admitted for #2649/);

    await runRejectedCompletenessBuild("unredacted-itx-source", ({ source }) => {
      source.credentialRedacted = false;
    }, /ITX network edge topology is not admitted for #2649/);

    const preverifiedFixture = structuredClone(currentAccessibilityFixture);
    Object.assign(preverifiedFixture.packs[0].networkEdges.find(({ fromNodeId }) =>
      fromNodeId.endsWith(":line-472a81add377")
    ), {
      sourceId: "capital-route-topology",
      sourceSnapshotId: "capital-route-topology-20260724",
      providerRecordHash: "f".repeat(64),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: "2026-07-27T21:38:29.000Z",
      evidenceHash: "e".repeat(64),
    });
    const preverifiedPath = path.join(workspace, "preverified-fixture.json");
    await writeFile(preverifiedPath, `${JSON.stringify(preverifiedFixture)}\n`);
    const preverified = structuredClone(spec);
    preverified.fixturePath = preverifiedPath;
    await runRejectedBuild(preverified, /production network edge fixture must not contain provenance/);

    const nestedProvenanceFixture = structuredClone(currentAccessibilityFixture);
    nestedProvenanceFixture.packs[0].networkEdges.find(({ id }) =>
      id.startsWith("edge-line-051552e50435-")
    ).fieldProvenance = {
      network_edges: {
        sourceId: "capital-route-topology",
        sourceSnapshotId: "capital-route-topology-20260724",
        providerRecordHash: "f".repeat(64),
        evidenceHash: "e".repeat(64),
        verifiedAt: "2026-07-27T21:38:29.000Z",
      },
    };
    const nestedProvenancePath = path.join(workspace, "nested-provenance-fixture.json");
    await writeFile(nestedProvenancePath, `${JSON.stringify(nestedProvenanceFixture)}\n`);
    const nestedProvenance = structuredClone(spec);
    nestedProvenance.fixturePath = nestedProvenancePath;
    await runRejectedBuild(nestedProvenance, /production network edge fixture must not contain provenance/);

    const preverifiedTransferFixture = structuredClone(currentAccessibilityFixture);
    preverifiedTransferFixture.packs[0].outOfStationTransferLinks = [{
      id: "review-probe-transfer",
      fromStationId: "station-00089f8f97de",
      fromLineId: "line-558d0bd8312d",
      toStationId: "station-007e4c97db14",
      toLineId: "line-e9e9a5b520a4",
      bidirectional: false,
      sourceId: "capital-route-topology",
      sourceSnapshotId: "capital-route-topology-20260724",
      providerRecordHash: "f".repeat(64),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: "2026-07-27T21:38:29.000Z",
      evidenceHash: "e".repeat(64),
    }];
    const preverifiedTransferPath = path.join(workspace, "preverified-transfer-fixture.json");
    await writeFile(preverifiedTransferPath, `${JSON.stringify(preverifiedTransferFixture)}\n`);
    const preverifiedTransfer = structuredClone(spec);
    preverifiedTransfer.fixturePath = preverifiedTransferPath;
    await runRejectedBuild(preverifiedTransfer, /production network edge fixture must not contain provenance/);

    const partialFixture = structuredClone(currentAccessibilityFixture);

    const extraEdgeFixture = structuredClone(partialFixture);
    const extraEdge = extraEdgeFixture.packs[0].networkEdges.find(({ id }) =>
      id.startsWith("edge-line-051552e50435-")
    );
    extraEdgeFixture.packs[0].networkEdges.push({ ...extraEdge, id: `${extraEdge.id}-review-extra` });
    const extraEdgePath = path.join(workspace, "extra-edge-fixture.json");
    await writeFile(extraEdgePath, `${JSON.stringify(extraEdgeFixture)}\n`);
    const extraEdgeSpec = structuredClone(spec);
    extraEdgeSpec.fixturePath = extraEdgePath;
    await runRejectedBuild(extraEdgeSpec, /capital topology fixture projection is not exact/);

    const defaultedExtraEdgeFixture = structuredClone(partialFixture);
    const defaultedExtraEdge = { ...defaultedExtraEdgeFixture.packs[0].networkEdges.find(({ id }) =>
      id.startsWith("edge-line-051552e50435-")
    ) };
    delete defaultedExtraEdge.serviceClass;
    defaultedExtraEdge.id = `${defaultedExtraEdge.id}-review-defaulted-extra`;
    defaultedExtraEdgeFixture.packs[0].networkEdges.push(defaultedExtraEdge);
    const defaultedExtraEdgePath = path.join(workspace, "defaulted-extra-edge-fixture.json");
    await writeFile(defaultedExtraEdgePath, `${JSON.stringify(defaultedExtraEdgeFixture)}\n`);
    const defaultedExtraEdgeSpec = structuredClone(spec);
    defaultedExtraEdgeSpec.fixturePath = defaultedExtraEdgePath;
    await runRejectedBuild(defaultedExtraEdgeSpec, /capital topology fixture projection is not exact/);

    partialFixture.packs[0].networkEdges.find(({ id }) =>
      id.startsWith("edge-line-051552e50435-")
    ).distanceMeters += 1;
    const partialPath = path.join(workspace, "partial-fixture.json");
    await writeFile(partialPath, `${JSON.stringify(partialFixture)}\n`);
    const partial = structuredClone(spec);
    partial.fixturePath = partialPath;
    await runRejectedBuild(partial, /capital topology fixture projection mismatch/);

    const missingInventoryFixture = structuredClone(partialFixture);
    delete missingInventoryFixture.packs[0].sourceInventory;
    const missingInventoryPath = path.join(workspace, "missing-inventory-fixture.json");
    await writeFile(missingInventoryPath, `${JSON.stringify(missingInventoryFixture)}\n`);
    const missingInventory = structuredClone(spec);
    missingInventory.fixturePath = missingInventoryPath;
    await runRejectedBuild(missingInventory, /network edge evidence requires pack.sourceInventory/);

    const changedSource = JSON.parse(await readFile(
      "tools/datapack/sources/itx-cheongchun-source-timetable-20260727071853886.json",
      "utf8",
    ));
    changedSource.normalizedSnapshotSets[0].sets.stationSet.push("station-tampered");
    const { evidenceHash: ignored, ...changedSourceWithoutEvidenceHash } = changedSource;
    changedSource.evidenceHash = sha256(Buffer.from(JSON.stringify(changedSourceWithoutEvidenceHash)));
    const changedSourceBytes = Buffer.from(`${JSON.stringify(changedSource, null, 2)}\n`);
    const changedSourcePath = path.join(workspace, "changed-itx-source.json");
    await writeFile(changedSourcePath, changedSourceBytes);
    const changedContract = JSON.parse(await readFile(
      "tools/datapack/itx-cheongchun-coverage-contract.json",
      "utf8",
    ));
    changedContract.sourceTimetableArtifact.artifactPath = changedSourcePath;
    changedContract.sourceTimetableArtifact.sha256 = sha256(changedSourceBytes);
    const changedContractBytes = Buffer.from(`${JSON.stringify(changedContract, null, 2)}\n`);
    const changedContractPath = path.join(workspace, "changed-itx-contract.json");
    await writeFile(changedContractPath, changedContractBytes);
    const changed = structuredClone(spec);
    changed.networkEdgeEvidence.itxCoverageContract = {
      path: changedContractPath,
      sha256: sha256(changedContractBytes),
    };
    await runRejectedBuild(changed, /ITX network edge topology is not admitted for #2649/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
