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
const env = {
  ...process.env,
  EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }),
};
const verifierEnv = { ...process.env };
delete verifierEnv.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("production producer는 미승격 network edge와 역외 환승 link 상태를 UNKNOWN으로 내린다", () => {
  const verified = { verificationStatus: "VERIFIED", accessibilityStatus: "AVAILABLE", stairAccessState: "STEP_FREE" };
  const pack = {
    networkEdges: [{ verificationStatus: "UNKNOWN", accessibilityStatus: "AVAILABLE", stairAccessState: "STEP_FREE" }, verified],
    outOfStationTransferLinks: [{ accessibilityStatus: "AVAILABLE", stairAccessState: "STEP_FREE" }],
  };

  normalizeUnverifiedNetworkEdgeStates(pack);

  assert.deepEqual(pack.networkEdges[0], {
    verificationStatus: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    stairAccessState: "UNKNOWN",
  });
  assert.equal(pack.networkEdges[1], verified);
  assert.deepEqual(pack.outOfStationTransferLinks[0], {
    accessibilityStatus: "UNKNOWN",
    stairAccessState: "UNKNOWN",
  });
});

test("production build와 bundled asset/index의 artifact identity를 exact-match한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-production-pack-identity-"));
  const baselineDir = path.join(workspace, "baseline");
  const assetPath = path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz");
  const indexPath = path.join(workspace, "index.json");
  try {
    await execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--build-spec", "tools/datapack/release/candidate-build-spec.json",
      "--output", baselineDir,
    ], { cwd: root, env });
    const manifest = JSON.parse(await readFile(path.join(baselineDir, "current.json"), "utf8"));
    const buildSpec = JSON.parse(await readFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
    const hashEvidence = JSON.parse(await readFile("tools/datapack/release/hash-evidence.json", "utf8"));
    assert.equal(hashEvidence.fixturePath.value, buildSpec.fixturePath);
    const canonicalFixtureBytes = await readFile(buildSpec.fixturePath);
    assert.equal(hashEvidence.fixturePath.sha256, sha256(canonicalFixtureBytes));
    const bundledIndex = JSON.parse(await readFile(
      path.join(root, "apps/mobile/assets/datapacks/index.json"),
      "utf8",
    ));
    assert.equal(manifest.expiresAt, "2026-08-02T15:00:00.000Z");
    assert.equal(bundledIndex.freshnessExpiresAt, manifest.expiresAt);
    const pack = manifest.packs.find(({ id }) => id === "capital");
    const topologySource = pack.sourceInventory.find(({ id }) => id === "capital-route-topology");
    assert.ok(topologySource);
    assert.ok(topologySource.fields.includes("network_edges"));
    assert.ok(!topologySource.fields.includes("duration_seconds"));
    const itxSource = pack.sourceInventory.find(({ id }) => id === "itx-cheongchun-source-timetable");
    assert.ok(itxSource);
    assert.deepEqual(itxSource.fields, ["network_edges"]);
    const fieldProvenance = JSON.parse(await readFile(
      path.join(baselineDir, "current.provenance.json"),
      "utf8",
    ));
    const capitalDurationRecords = fieldProvenance.packs
      .flatMap(({ records }) => records)
      .filter(({ sourceId, field }) => sourceId === "capital-route-topology" && field === "duration_seconds");
    assert.ok(capitalDurationRecords.length > 0);
    assert.ok(capitalDurationRecords.every(({ derivationKind }) => derivationKind === "GENERATED"));
    const capitalDistanceRecords = fieldProvenance.packs
      .flatMap(({ records }) => records)
      .filter(({ sourceId, field }) => sourceId === "capital-route-topology" && field === "distance_meters");
    assert.equal(capitalDistanceRecords.filter(({ derivationKind }) => derivationKind === "GENERATED").length, 62);
    assert.equal(capitalDistanceRecords.filter(({ derivationKind }) => derivationKind === "OFFICIAL").length, 542);
    const itxPlaceholderRecords = fieldProvenance.packs
      .flatMap(({ records }) => records)
      .filter(({ sourceId, field }) => sourceId === "itx-cheongchun-source-timetable"
        && ["duration_seconds", "distance_meters"].includes(field));
    assert.equal(new Set(itxPlaceholderRecords.map(({ entityId, field }) => `${entityId}\0${field}`)).size, 96);
    assert.ok(itxPlaceholderRecords.every(({ derivationKind }) => derivationKind === "GENERATED"));
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
    const gzipBytes = await readFile(assetPath);
    assert.equal(gzipBytes[9], 255);
    const sqliteBytes = gunzipSync(gzipBytes);
    assert.equal(sqliteBytes.readUInt32BE(96), 3_053_000);
    const sqlitePath = path.join(workspace, "capital.sqlite");
    await writeFile(sqlitePath, sqliteBytes);
    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      assert.deepEqual(database.prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'sqlite_stat%' ORDER BY name",
      ).all(), []);
      const provenance = database.prepare(`
        SELECT
          SUM(verification_status = 'VERIFIED') AS verifiedCount,
          SUM(verification_status = 'UNKNOWN') AS unknownCount,
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
          SUM(service_class = 'ITX_CHEONGCHUN' AND verification_status = 'VERIFIED') AS verifiedItxCount
        FROM network_edges
      `).get();
      assert.equal(provenance.verifiedCount, 652);
      assert.ok(provenance.unknownCount > 0);
      assert.equal(provenance.incompleteVerifiedCount, 0);
      assert.equal(provenance.unsafeUnknownCount, 0);
      assert.equal(provenance.verifiedItxCount, 48);
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
      "--build-spec", "tools/datapack/release/candidate-build-spec.json",
      "--asset", assetPath,
      "--index", indexPath,
      "--pack-id", "capital",
    ], { cwd: root, env: verifierEnv });
    const report = JSON.parse(stdout);
    assert.equal(report.gzipSha256, pack.sha256);
    assert.equal(report.sqliteSha256, pack.sqliteSha256);
    assert.equal(report.byteSize, pack.sizeBytes);
    assert.ok(report.rowCounts.stations > 0);
    assert.deepEqual(report.networkEdgeCounts, {
      total: 2178,
      provenanceComplete: 652,
      strictEligible: 652,
    });
    assert.deepEqual(await verifyProductionPackArtifactIdentity({
      buildSpecPath: "tools/datapack/release/candidate-build-spec.json",
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
        "--build-spec", "tools/datapack/release/candidate-build-spec.json",
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
        "--build-spec", "tools/datapack/release/candidate-build-spec.json",
        "--asset", assetPath,
        "--index", indexPath,
        "--pack-id", "capital",
      ], { cwd: root, env: verifierEnv }),
      /index sha256 mismatch/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("network edge evidence는 pinned bytes·freshness·fixture projection mismatch를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-network-edge-evidence-"));
  const outputDir = path.join(workspace, "output");
  const spec = JSON.parse(await readFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
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
    staleInventory.sources.find(({ routeMapAdmissionEvidence }) =>
      routeMapAdmissionEvidence?.topologySnapshotId === "capital-route-topology-20260724"
    ).routeMapAdmissionEvidence.freshUntil = "2026-07-27T00:00:00.000Z";
    const staleBytes = Buffer.from(`${JSON.stringify(staleInventory, null, 2)}\n`);
    const stalePath = path.join(workspace, "stale-source-inventory.json");
    await writeFile(stalePath, staleBytes);
    const stale = structuredClone(spec);
    stale.networkEdgeEvidence.sourceInventory = { path: stalePath, sha256: sha256(staleBytes) };
    stale.sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(staleInventory)));
    await runRejectedBuild(stale, /capital topology admission is stale/);

    const futureInventory = JSON.parse(await readFile("tools/datapack/source-inventory.json", "utf8"));
    futureInventory.sources.find(({ routeMapAdmissionEvidence }) =>
      routeMapAdmissionEvidence?.topologySnapshotId === "capital-route-topology-20260724"
    ).routeMapAdmissionEvidence.capturedAt = "2026-07-27T21:38:30.000Z";
    const futureInventoryBytes = Buffer.from(`${JSON.stringify(futureInventory, null, 2)}\n`);
    const futureInventoryPath = path.join(workspace, "future-source-inventory.json");
    await writeFile(futureInventoryPath, futureInventoryBytes);
    const futureInventorySpec = structuredClone(spec);
    futureInventorySpec.networkEdgeEvidence.sourceInventory = {
      path: futureInventoryPath,
      sha256: sha256(futureInventoryBytes),
    };
    futureInventorySpec.sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(futureInventory)));
    await runRejectedBuild(futureInventorySpec, /capital topology admission is future-dated/);

    const earlyInventory = JSON.parse(await readFile("tools/datapack/source-inventory.json", "utf8"));
    earlyInventory.sources.find(({ id, routeMapAdmissionEvidence }) =>
      id === "kric-everline-route-map-positions"
      && routeMapAdmissionEvidence?.topologySnapshotId === "capital-route-topology-20260724"
    ).routeMapAdmissionEvidence.freshUntil = "2026-08-01T00:00:00.000Z";
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
    assert.equal(earlyManifest.expiresAt, "2026-08-01T00:00:00.000Z");

    const missingEdgeAdmission = structuredClone(spec);
    delete missingEdgeAdmission.networkEdgeEvidence.capitalTopologyAdmission;
    await runRejectedBuild(missingEdgeAdmission, /production build requires capital topology edge admission/);

    const staleEdgeAdmission = structuredClone(spec);
    staleEdgeAdmission.networkEdgeEvidence.capitalTopologyAdmission = {
      schemaVersion: 1,
      artifactKind: "capital-network-edge-admission",
      issue: 2649,
      status: "ADMITTED",
      snapshotId: "capital-route-topology-20260724",
      contentSha256: "0492df28ff51dc4262508363e960ed1a5fed847d3aa5f593ea62ad0fd3d773f3",
      reviewedAt: "2026-07-27T21:38:29.000Z",
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
    }, /ITX network edge admission evidence mismatch/);

    await runRejectedCompletenessBuild("drifted-itx-service-dates", ({ completeness }) => {
      completeness.selectedServiceDates["7"] = "20260808";
    }, /ITX network edge admission evidence mismatch/);

    await runRejectedCompletenessBuild("noncanonical-itx-policy", ({ source, completeness, reference }) => {
      source.policyVersion = "review-probe-v1";
      completeness.sourceTimetableArtifact.policyVersion = source.policyVersion;
      reference.policyVersion = source.policyVersion;
    }, /ITX network edge admission evidence mismatch/);

    await runRejectedCompletenessBuild("shifted-itx-service-dates", ({ source, completeness, reference }) => {
      source.observedAt = "2026-08-03T07:18:53.886Z";
      completeness.observedAt = source.observedAt;
      source.selectedServiceDates = { "7": "20260808", "8": "20260803", "9": "20260809" };
      completeness.selectedServiceDates = structuredClone(source.selectedServiceDates);
      source.freshUntil = "2026-08-10T00:00:00+09:00";
      completeness.sourceTimetableArtifact.freshUntil = source.freshUntil;
      reference.freshUntil = source.freshUntil;
    }, /ITX network edge admission evidence mismatch/);

    await runRejectedCompletenessBuild("unbound-itx-freshness", ({ source, completeness, reference }) => {
      source.freshUntil = "2026-08-04T00:00:00+09:00";
      completeness.sourceTimetableArtifact.freshUntil = source.freshUntil;
      reference.freshUntil = source.freshUntil;
    }, /ITX network edge admission evidence mismatch/);

    await runRejectedCompletenessBuild("unredacted-itx-source", ({ source }) => {
      source.credentialRedacted = false;
    }, /ITX network edge admission evidence mismatch/);

    const preverifiedFixture = JSON.parse(await readFile(
      "tools/datapack/release/capital-production-canonical-pack.json",
      "utf8",
    ));
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

    const nestedProvenanceFixture = JSON.parse(await readFile(
      "tools/datapack/release/capital-production-canonical-pack.json",
      "utf8",
    ));
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

    const preverifiedTransferFixture = JSON.parse(await readFile(
      "tools/datapack/release/capital-production-canonical-pack.json",
      "utf8",
    ));
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

    const partialFixture = JSON.parse(await readFile(
      "tools/datapack/release/capital-production-canonical-pack.json",
      "utf8",
    ));

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
    await runRejectedBuild(changed, /ITX network edge unchanged admission is invalid/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
