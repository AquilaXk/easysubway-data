import { gzipSync, gunzipSync } from "node:zlib";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sortJson } from "./run-source-admission-pipeline.mjs";
import { bindCurrentProductionScopePolicy } from "./test-fixtures/current-public-route-map-successor.mjs";
import { bindBuildSpecToCurrentItx } from "./test-fixtures/current-itx-bound-build-spec.mjs";
import {
  admittedIncheonTopologyEvidence,
  admittedRegisteredIncheonAccessibilityEvidence,
  normalizeUnverifiedNetworkEdgeStates,
  projectCapitalTopologyIntoCanonicalFixture,
} from "./build-datapack.mjs";
import {
  materializeIncheonAccessibility,
  validateProductionIncheonAccessibilityFixture,
} from "./materialize-incheon-accessibility.mjs";
// 정준 직렬화는 검증 대상 구현을 그대로 쓴다. 테스트가 규칙을 복제하면 3언어
// 분열(이슈 #2528)을 구조적으로 검출할 수 없다.
import { canonicalJson, validateManifest, withoutSignature } from "./lib/manifest-validation.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { routeServiceEvidenceSnapshot } from "./lib/route-service-evidence-preservation.mjs";
import {
  buildCapitalTopologyReverificationEvidence,
  projectCapitalTopologyOwnership,
} from "./collect-capital-route-topology.mjs";
import {
  deriveTopology as deriveItxTopology,
  projectItxTopologyIntoCanonicalFixture,
} from "./apply-itx-topology-to-bundled-pack.mjs";
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";
import { sha256 } from "../lib/hash.mjs";
import { testPrivateKeyPem, testPublicKeyPem, rsaSha256Signature } from "./test-fixtures/datapack-tools-signing.mjs";
import {
  productionEnv,
  currentCandidateRoot,
  readCandidateFile,
  runDatapackInRepository,
} from "./test-fixtures/datapack-tools-production-build.mjs";
import {
  TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
  TEST_ACCESSIBILITY_SNAPSHOT_ID,
  sourceIngestInput,
  productionSourceIngestInput,
  importOfficialSourceInput,
  importTestOnlyAccessibilityFixture,
  testOnlyInventoryPath,
  capitalPilotProductionSourceInput,
  withTestProductionAccessibility,
} from "./test-fixtures/datapack-tools-source-ingest.mjs";
import {
  completeCoverageInventory,
  completeCoverageProvenance,
  writeCoverageCandidate,
} from "./test-fixtures/datapack-tools-coverage-inventory.mjs";
import { makeProductionSourceFixtureStrictCoverageValid } from "./test-fixtures/datapack-tools-production-pack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
stageLocalMobileFixture({ repositoryRoot: root });

test("route service evidence preservation은 table별 정확히 하나의 ITX row만 snapshot한다", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE route_service_artifact_evidence (service_class TEXT);
      CREATE TABLE route_service_station_catalog_evidence (service_class TEXT);
    `);
    const snapshot = () => routeServiceEvidenceSnapshot(database);
    assert.throws(snapshot, /exactly one ITX_CHEONGCHUN row/);

    database.exec("INSERT INTO route_service_artifact_evidence VALUES ('ITX_CHEONGCHUN')");
    database.exec("INSERT INTO route_service_station_catalog_evidence VALUES ('NOT_ITX')");
    assert.throws(snapshot, /exactly one ITX_CHEONGCHUN row/);

    database.exec("DELETE FROM route_service_station_catalog_evidence");
    database.exec("INSERT INTO route_service_station_catalog_evidence VALUES ('ITX_CHEONGCHUN')");
    assert.doesNotThrow(snapshot);

    database.exec("INSERT INTO route_service_artifact_evidence VALUES ('ITX_CHEONGCHUN')");
    assert.throws(snapshot, /exactly one ITX_CHEONGCHUN row/);
  } finally {
    database.close();
  }
});

test("exploratory fixture 빌드 manifest는 fixture build spec이 선언한 releaseSequence를 fixture 산출물로 싣는다", async (context) => {
  const workDir = await mkdtemp(path.join(tmpdir(), "easysubway-exploratory-release-sequence-"));
  context.after(() => rm(workDir, { recursive: true, force: true }));
  const buildSpec = JSON.parse(await readFile("tools/datapack/fixtures/candidate-build-spec.json", "utf8"));
  assert.equal(buildSpec.fixturePath, "tools/datapack/fixtures/catalog-fixture.json");
  assert.equal(buildSpec.releaseSequence, 1);

  // datapack-release.yml exploratory 경로와 같은 순서: admin review override 적용 후 --fixture 빌드
  const reviewedFixturePath = path.join(workDir, "reviewed-catalog-fixture.json");
  const outputDir = path.join(workDir, "output");
  await execFileAsync(process.execPath, [
    "tools/datapack/apply-admin-review-overrides.mjs",
    "--fixture",
    buildSpec.fixturePath,
    "--overrides",
    "tools/datapack/fixtures/admin-review-overrides.json",
    "--output",
    reviewedFixturePath,
  ], { cwd: root });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs",
    "--fixture",
    reviewedFixturePath,
    "--output",
    outputDir,
  ], { cwd: root });

  const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
  assert.equal(manifest.releaseSequence, 1);
  assert.equal(manifest.manifestVersion, undefined);
  assert.equal(manifest.signature, undefined);
  assert.deepEqual(manifest.packs.map(({ artifactKind }) => artifactKind), ["fixture"]);
  await execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs",
    "--manifest",
    path.join(outputDir, "current.json"),
    "--root",
    outputDir,
  ], { cwd: root });

  const invalidFixturePath = path.join(workDir, "invalid-release-sequence-fixture.json");
  const invalidFixture = JSON.parse(await readFile(reviewedFixturePath, "utf8"));
  invalidFixture.manifest.releaseSequence = 0;
  await writeFile(invalidFixturePath, `${JSON.stringify(invalidFixture)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      invalidFixturePath,
      "--output",
      path.join(workDir, "invalid-output"),
    ], { cwd: root }),
    /manifest\.releaseSequence/,
  );
});

test("원격 데이터팩 검증 wrapper는 manifest와 pack을 내려받아 기존 validator를 실행한다", async () => {
  const packOutputDir = path.join(tmpdir(), `easysubway-remote-datapack-source-${Date.now()}`);
  const downloadDir = path.join(tmpdir(), `easysubway-remote-datapack-download-${Date.now()}`);
  await rm(packOutputDir, { recursive: true, force: true });
  await rm(downloadDir, { recursive: true, force: true });
  await mkdir(packOutputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const server = await startObjectStorageServer({ requireAuthorization: false, basePath: "/catalog" });
  try {
    const manifestBytes = await readFile(path.join(packOutputDir, "current.json"));
    const packBytes = await readFile(path.join(packOutputDir, "catalog", "capital-v1.sqlite.gz"));
    server.objects.set("current.json", {
      body: manifestBytes,
      sha256: sha256(manifestBytes),
      sizeBytes: manifestBytes.length,
    });
    server.objects.set("capital-v1.sqlite.gz", {
      body: packBytes,
      sha256: sha256(packBytes),
      sizeBytes: packBytes.length,
    });

    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-remote-datapack-artifact.mjs",
        "--manifest-url",
        `${server.origin}/catalog/current.json`,
        "--output",
        downloadDir,
      ],
      { cwd: root, env: productionEnv },
    );

    const summary = JSON.parse(
      await readFile(path.join(downloadDir, "remote-datapack-validation-summary.json"), "utf8"),
    );
    assert.equal(summary.manifestVersion, 1);
    assert.equal(summary.validation.exitCode, 0);
    assert.equal(summary.packs[0].id, "capital");
    assert.equal(summary.packs[0].download.sizeBytesMatchesManifest, true);
    assert.equal(summary.packs[0].download.sha256MatchesManifest, true);
    assert.equal(summary.packs[0].download.sqliteSha256MatchesManifest, true);
    assert.match(summary.manifestSha256, /^[0-9a-f]{64}$/);
  } finally {
    await server.close();
    await rm(packOutputDir, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("원격 데이터팩 검증 wrapper는 validator 실패도 summary에 기록한다", async () => {
  const packOutputDir = path.join(tmpdir(), `easysubway-remote-datapack-source-invalid-${Date.now()}`);
  const downloadDir = path.join(tmpdir(), `easysubway-remote-datapack-download-invalid-${Date.now()}`);
  await rm(packOutputDir, { recursive: true, force: true });
  await rm(downloadDir, { recursive: true, force: true });
  await mkdir(packOutputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const server = await startObjectStorageServer({ requireAuthorization: false, basePath: "/catalog" });
  try {
    const manifestBytes = await readFile(path.join(packOutputDir, "current.json"));
    const corruptPackBytes = Buffer.from("not a gzip datapack");
    server.objects.set("current.json", {
      body: manifestBytes,
      sha256: sha256(manifestBytes),
      sizeBytes: manifestBytes.length,
    });
    server.objects.set("capital-v1.sqlite.gz", {
      body: corruptPackBytes,
      sha256: sha256(corruptPackBytes),
      sizeBytes: corruptPackBytes.length,
    });

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/validate-remote-datapack-artifact.mjs",
          "--manifest-url",
          `${server.origin}/catalog/current.json`,
          "--output",
          downloadDir,
        ],
        { cwd: root, env: productionEnv },
      ),
    );

    const summary = JSON.parse(
      await readFile(path.join(downloadDir, "remote-datapack-validation-summary.json"), "utf8"),
    );
    assert.notEqual(summary.validation.exitCode, 0);
    assert.equal(summary.validation.signal, null);
    assert.equal(summary.packs[0].download.sizeBytesMatchesManifest, false);
    assert.equal(summary.packs[0].download.sha256MatchesManifest, false);
    assert.equal(summary.packs[0].download.sqliteSha256MatchesManifest, false);
    assert.match(summary.packs[0].download.sqliteDecompressionError, /incorrect header check|not in gzip format/);
    assert.match(summary.validation.stderr, /sizeBytes mismatch/);
  } finally {
    await server.close();
    await rm(packOutputDir, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 buildSpec 요청으로 candidate provenance를 남긴다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const outputDir = path.join(workspace, "output");
  try {
    await runCandidateBuild({
      buildSpecPath: path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"),
      output: outputDir,
      repositoryRoot,
    });

    const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
    const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
    assert.equal(manifest.packs[0].id, "capital");
    assert.equal(provenance.candidateBuild.candidateId, "capital-pilot-candidate-fixture");
    assert.equal(provenance.candidateBuild.productionScopeId, "capital_pilot_android_v1");
    assert.equal(provenance.candidateBuild.artifactKind, "datapack-candidate-build-spec");
    assert.match(provenance.candidateBuild.buildSpecSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(provenance.candidateBuild.sourceSnapshotIds, [
      "snapshot-molit-urban-rail-full-route-fixture",
      "snapshot-seoulmetro-station-line-info-fixture",
    ]);
    assert.deepEqual(
      provenance.candidateBuild.sourceSnapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        sourceId: snapshot.sourceId,
        snapshotStatus: snapshot.snapshotStatus,
        credentialRedacted: snapshot.credentialRedacted,
      })),
      [
        {
          snapshotId: "snapshot-molit-urban-rail-full-route-fixture",
          sourceId: "molit-urban-rail-full-route",
          snapshotStatus: "LOCKED",
          credentialRedacted: true,
        },
        {
          snapshotId: "snapshot-seoulmetro-station-line-info-fixture",
          sourceId: "seoulmetro-station-line-info",
          snapshotStatus: "LOCKED",
          credentialRedacted: true,
        },
      ],
    );
    assert.equal(
      provenance.candidateBuild.approvedAliasLedgerHash,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 만료된 source snapshot buildSpec을 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-expired-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const outputDir = path.join(workspace, "output");
  const buildSpecDir = path.join(repositoryRoot, "tmp");
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.expired.json");
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"), "utf8"));
  buildSpec.sourceSnapshots[0].freshnessExpiresAt = "2026-06-30T00:00:00Z";
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await assert.rejects(
      runCandidateBuild({
        buildSpecPath,
        output: outputDir,
        repositoryRoot,
        env: { ...productionEnv, EASYSUBWAY_DATAPACK_BUILD_NOW: "2026-06-30T01:00:00Z" },
      }),
      /buildSpec\.sourceSnapshots\[0\]\.freshnessExpiresAt must be in the future/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 admin review 없는 source snapshot buildSpec을 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-admin-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const outputDir = path.join(workspace, "output");
  const buildSpecDir = path.join(repositoryRoot, "tmp");
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.missing-admin.json");
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"), "utf8"));
  delete buildSpec.sourceSnapshots[0].adminReviewRecordHash;
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await assert.rejects(
      runCandidateBuild({ buildSpecPath, output: outputDir, repositoryRoot }),
      /buildSpec\.sourceSnapshots\[0\] must contain exactly one admission projection/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("source snapshot command는 raw token을 저장 전에 거부한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-token-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  const outputPath = path.join(workDir, "snapshot.json");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "station\nSadang\nserviceKey=secret-token\n");

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-source-snapshot.mjs",
          "--input",
          rawPath,
          "--output",
          outputPath,
          "--snapshot-id",
          "snapshot-kric-token",
          "--source-id",
          "kric-station-elevator",
          "--coverage-count",
          "1",
          "--provider",
          "국가철도공단",
          "--source-class-id",
          "static_accessibility_facility",
          "--retrieved-at",
          "2026-06-30T03:00:00Z",
          "--raw-object-uri",
          "s3://easysubway-datapack-sources/kric-station-elevator/snapshot-kric-token.json",
          "--freshness-expires-at",
          "2026-07-07T03:00:00Z",
          "--raw-retention-expires-at",
          "2026-09-30T03:00:00Z",
        ],
        { cwd: root },
      ),
      /raw snapshot contains credential-like token/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 credential URI와 만료 retention metadata를 거부한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-policy-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "station\nSadang\n");
  const baseArgs = [
    "tools/datapack/build-source-snapshot.mjs",
    "--input",
    rawPath,
    "--output",
    path.join(workDir, "snapshot.json"),
    "--snapshot-id",
    "snapshot-kric-policy",
    "--source-id",
    "kric-station-elevator",
    "--coverage-count",
    "1",
    "--provider",
    "국가철도공단",
    "--source-class-id",
    "static_accessibility_facility",
    "--retrieved-at",
    "2026-06-30T03:00:00Z",
    "--freshness-expires-at",
    "2026-09-28T03:00:00Z",
  ];

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          ...baseArgs,
          "--raw-object-uri",
          "s3://bucket/snapshot.json?serviceKey=secret",
          "--raw-retention-expires-at",
          "2026-09-30T03:00:00Z",
        ],
        { cwd: root },
      ),
      /--raw-object-uri must be a credential-free object storage URI/,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          ...baseArgs,
          "--raw-object-uri",
          "s3://bucket/snapshot.json",
          "--raw-retention-expires-at",
          "2026-01-01T00:00:00Z",
        ],
        { cwd: root },
      ),
      /rawRetentionExpiresAt must be after retrievedAt/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 raw CSV를 LOCKED snapshot metadata로 canonicalize한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-ok-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  const canonicalRawPath = path.join(workDir, "canonical.csv");
  const outputPath = path.join(workDir, "snapshot.json");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "station,line\nSadang,2\nSangnoksu,4\n");

  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-source-snapshot.mjs",
        "--input",
        rawPath,
        "--raw-output",
        canonicalRawPath,
        "--output",
        outputPath,
        "--snapshot-id",
        "snapshot-kric-station-elevator-20260630",
        "--source-id",
        "kric-station-elevator",
        "--coverage-count",
        "2",
        "--provider",
        "국가철도공단",
        "--source-class-id",
        "static_accessibility_facility",
        "--retrieved-at",
        "2026-06-30T03:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-station-elevator/snapshot-kric-station-elevator-20260630.csv",
        "--freshness-expires-at",
        "2026-09-28T03:00:00Z",
        "--raw-retention-expires-at",
        "2026-09-30T03:00:00Z",
      ],
      { cwd: root },
    );

    const snapshot = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(snapshot.snapshotStatus, "LOCKED");
    assert.equal(snapshot.credentialRedacted, true);
    assert.equal(snapshot.rowCount, 2);
    assert.match(snapshot.rawSha256, /^[0-9a-f]{64}$/);
    assert.match(snapshot.schemaFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(snapshot.providerRecordHashes.length, 2);
    assert.equal(await readFile(canonicalRawPath, "utf8"), "station,line\nSadang,2\nSangnoksu,4\n");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 policy에서 파생되지 않은 임의 만료 시각을 거부한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-freshness-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "station\nSadang\n");

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-source-snapshot.mjs",
          "--input", rawPath,
          "--output", path.join(workDir, "snapshot.json"),
          "--snapshot-id", "snapshot-kric-arbitrary-expiry",
          "--source-id", "kric-station-elevator",
          "--coverage-count", "1",
          "--provider", "국가철도공단",
          "--source-class-id", "static_accessibility_facility",
          "--retrieved-at", "2026-06-30T03:00:00Z",
          "--raw-object-uri", "s3://bucket/snapshot.json",
          "--freshness-expires-at", "2099-01-01T00:00:00Z",
          "--raw-retention-expires-at", "2099-02-01T00:00:00Z",
        ],
        { cwd: root },
      ),
      /SOURCE_FRESHNESS_DERIVATION_MISMATCH/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 source가 속하지 않은 freshness class를 거부한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-class-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "station\nSadang\n");

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-source-snapshot.mjs",
          "--input", rawPath,
          "--output", path.join(workDir, "snapshot.json"),
          "--snapshot-id", "snapshot-kric-wrong-class",
          "--source-id", "kric-station-elevator",
          "--coverage-count", "1",
          "--provider", "국가철도공단",
          "--source-class-id", "static_network_metadata",
          "--retrieved-at", "2026-06-30T03:00:00Z",
          "--raw-object-uri", "s3://bucket/snapshot.json",
          "--freshness-expires-at", "2026-07-30T03:00:00Z",
          "--raw-retention-expires-at", "2026-09-30T03:00:00Z",
        ],
        { cwd: root },
      ),
      /SOURCE_FRESHNESS_POLICY_MISSING: kric-station-elevator source class/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 정책 basis와 provider validity 필드를 보존한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-planned-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  const outputPath = path.join(workDir, "snapshot.json");
  const policyPath = path.join(workDir, "policy.json");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "trip\nA\n");
  await writeFile(policyPath, JSON.stringify({
    clockSkewSeconds: 300,
    sourceClasses: [{
      id: "planned_timetable",
      sourceIds: ["planned-a"],
      basisField: "serviceEffectiveAt",
      maximumReverificationCadence: "P30D",
      providerValidityEndField: "serviceEffectiveUntil",
    }],
  }));

  try {
    await execFileAsync(process.execPath, [
      "tools/datapack/build-source-snapshot.mjs",
      "--input", rawPath,
      "--output", outputPath,
      "--snapshot-id", "snapshot-planned-a",
      "--source-id", "planned-a",
      "--coverage-count", "1",
      "--provider", "provider-a",
      "--source-class-id", "planned_timetable",
      "--freshness-policy", policyPath,
      "--retrieved-at", "2026-07-02T00:00:00Z",
      "--freshness-basis-at", "2026-07-01T00:00:00Z",
      "--provider-valid-until", "2026-07-20T00:00:00Z",
      "--raw-object-uri", "s3://bucket/snapshot-planned-a.csv",
      "--freshness-expires-at", "2026-07-20T00:00:00Z",
      "--raw-retention-expires-at", "2026-10-01T00:00:00Z",
    ], { cwd: root });

    const snapshot = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(snapshot.serviceEffectiveAt, "2026-07-01T00:00:00Z");
    assert.equal(snapshot.serviceEffectiveUntil, "2026-07-20T00:00:00Z");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 정책상 필수인 provider validity가 없으면 차단한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-validity-required-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  const policyPath = path.join(workDir, "policy.json");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "trip\nA\n");
  await writeFile(policyPath, JSON.stringify({
    clockSkewSeconds: 300,
    sourceClasses: [{
      id: "planned_timetable",
      sourceIds: ["planned-a"],
      basisField: "serviceEffectiveAt",
      maximumReverificationCadence: "P30D",
      providerValidityEndField: "serviceEffectiveUntil",
    }],
  }));

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/build-source-snapshot.mjs",
        "--input", rawPath,
        "--output", path.join(workDir, "snapshot.json"),
        "--snapshot-id", "snapshot-planned-a",
        "--source-id", "planned-a",
        "--coverage-count", "1",
        "--provider", "provider-a",
        "--source-class-id", "planned_timetable",
        "--freshness-policy", policyPath,
        "--retrieved-at", "2026-07-02T00:00:00Z",
        "--freshness-basis-at", "2026-07-01T00:00:00Z",
        "--raw-object-uri", "s3://bucket/snapshot-planned-a.csv",
        "--freshness-expires-at", "2026-07-31T00:00:00Z",
        "--raw-retention-expires-at", "2026-10-01T00:00:00Z",
      ], { cwd: root }),
      /--provider-valid-until is required/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 같은 buildSpec에서 candidate artifact hash를 재현한다", async () => {
  const outputRoot = path.join(tmpdir(), `easysubway-datapack-deterministic-${process.pid}-${Date.now()}`);
  await rm(outputRoot, { recursive: true, force: true });
  const repositoryRoot = await writeTransitionFreeCandidateRoot(outputRoot);
  const firstOutputDir = path.join(outputRoot, "first");
  const secondOutputDir = path.join(outputRoot, "second");

  try {
    for (const outputDir of [firstOutputDir, secondOutputDir]) {
      await runCandidateBuild({
        buildSpecPath: path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"),
        output: outputDir,
        repositoryRoot,
      });
    }

    const firstManifest = JSON.parse(await readFile(path.join(firstOutputDir, "current.json"), "utf8"));
    const secondManifest = JSON.parse(await readFile(path.join(secondOutputDir, "current.json"), "utf8"));
    const firstProvenance = JSON.parse(await readFile(path.join(firstOutputDir, "current.provenance.json"), "utf8"));
    const secondProvenance = JSON.parse(await readFile(path.join(secondOutputDir, "current.provenance.json"), "utf8"));

    assert.equal(firstManifest.packs[0].sqliteSha256, secondManifest.packs[0].sqliteSha256);
    assert.equal(firstManifest.packs[0].sha256, secondManifest.packs[0].sha256);
    assert.equal(
      firstProvenance.packs[0].normalizedSourceInventorySha256,
      secondProvenance.packs[0].normalizedSourceInventorySha256,
    );
    assert.equal(
      firstProvenance.packs[0].normalizedSourceInventorySha256,
      sha256(Buffer.from(JSON.stringify(firstManifest.packs[0].sourceInventory))),
    );
    assert.match(firstProvenance.packs[0].normalizedSourceInventorySha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 전체 identity chain이 없는 ITX topology evidence를 거부한다", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-itx-evidence-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workDir);
  const fixturePath = path.join(workDir, "fixture.json");
  const buildSpecPath = path.join(workDir, "build-spec.json");
  const evidencePath = path.join(workDir, "itx-evidence.json");
  const outputDir = path.join(workDir, "output");
  try {
    const fixture = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/catalog-fixture.json"), "utf8"));
    const edge = {
      id: "itx-cheongchun:test-edge",
      fromNodeId: "station-sangnoksu:seoul-4:EXPRESS",
      toNodeId: "station-sadang:seoul-4:EXPRESS",
      durationSeconds: 0,
      distanceMeters: 0,
      edgeType: "RIDE",
      servicePattern: "EXPRESS",
      serviceClass: "ITX_CHEONGCHUN",
    };
    const routeEvidence = {
      serviceClass: "ITX_CHEONGCHUN",
      timetableArtifactId: "itx-test",
      timetableArtifactSha256: "a".repeat(64),
      canonicalPackId: "capital",
      canonicalPackSha256: "b".repeat(64),
      canonicalPackSqliteSha256: "c".repeat(64),
      admissionStatus: "ADMITTED",
      admissionEligible: true,
      freshUntil: "2026-08-31T00:00:00.000Z",
      sourceIssue: 2135,
    };
    fixture.packs[0].networkEdges.push(edge);
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

    const edgeProjection = [{
      id: edge.id,
      from_node_id: edge.fromNodeId,
      to_node_id: edge.toNodeId,
      duration_seconds: edge.durationSeconds,
      distance_meters: edge.distanceMeters,
      edge_type: edge.edgeType,
      service_pattern: edge.servicePattern,
      service_class: edge.serviceClass,
    }];
    const evidenceProjection = [{
      service_class: routeEvidence.serviceClass,
      timetable_artifact_id: routeEvidence.timetableArtifactId,
      timetable_artifact_sha256: routeEvidence.timetableArtifactSha256,
      canonical_pack_id: routeEvidence.canonicalPackId,
      canonical_pack_sha256: routeEvidence.canonicalPackSha256,
      canonical_pack_sqlite_sha256: routeEvidence.canonicalPackSqliteSha256,
      admission_status: routeEvidence.admissionStatus,
      admission_eligible: 1,
      fresh_until: routeEvidence.freshUntil,
      source_issue: routeEvidence.sourceIssue,
    }];
    const evidence = {
      schemaVersion: 1,
      artifactKind: "itx-cheongchun-mobile-topology-evidence",
      serviceId: "ITX_CHEONGCHUN",
      sourceIssue: 2135,
      readmissions: [{
        itxSubgraph: {
          unchanged: true,
          edgeCount: 1,
          edgesSha256: sha256(JSON.stringify(edgeProjection)),
          evidenceSha256: sha256(JSON.stringify(evidenceProjection)),
        },
      }],
    };
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(evidencePath, evidenceBytes);

    const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"), "utf8"));
    buildSpec.fixturePath = fixturePath;
    buildSpec.itxTopologyEvidencePath = evidencePath;
    buildSpec.itxTopologyEvidenceSha256 = sha256(evidenceBytes);
    await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

    await assert.rejects(
      runCandidateBuild({ buildSpecPath, output: outputDir, repositoryRoot }),
      /ITX topology evidence\.readmissions is not allowed/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 temp buildSpec이 생성 fixture를 참조할 수 있다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-temp-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const outputDir = path.join(workspace, "output");
  const buildSpecDir = path.join(workspace, "build-spec");
  const fixturePath = path.join(buildSpecDir, "catalog-fixture.json");
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.json");
  await mkdir(buildSpecDir, { recursive: true });

  try {
    const fixtureBytes = await readFile(path.join(
      repositoryRoot,
      "tools/datapack/fixtures/catalog-fixture.json",
    ));
    await writeFile(fixturePath, fixtureBytes);
    const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"), "utf8"));
    buildSpec.fixturePath = fixturePath;
    buildSpec.fixtureSha256 = sha256(fixtureBytes);
    await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

    await runCandidateBuild({ buildSpecPath, output: outputDir, repositoryRoot });

    const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
    assert.equal(provenance.candidateBuild.candidateId, "capital-pilot-candidate-fixture");

    await writeFile(fixturePath, Buffer.concat([fixtureBytes, Buffer.from("\n")]));
    await assert.rejects(
      runCandidateBuild({
        buildSpecPath,
        output: path.join(workspace, "changed-output"),
        repositoryRoot,
      }),
      /buildSpec\.fixtureSha256 must match source fixture bytes/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 buildSpec hash provenance를 lowercase hex로 정규화한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-normalized-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const outputDir = path.join(workspace, "output");
  const buildSpecDir = path.join(repositoryRoot, "tmp");
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.normalized.json");
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"), "utf8"));
  buildSpec.artifactKind = " datapack-candidate-build-spec ";
  buildSpec.sourceSnapshotSetHash = ` ${"A".repeat(64)} `;
  buildSpec.approvedAliasLedgerHash = ` ${"B".repeat(64)} `;
  buildSpec.facilityEvidenceLedgerHash = ` ${"C".repeat(64)} `;
  buildSpec.routeEvidenceLedgerHash = ` ${"D".repeat(64)} `;
  buildSpec.approvedOverrideSetHash = ` ${"E".repeat(64)} `;
  buildSpec.sourceInventorySha256 = ` ${"F".repeat(64)} `;
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await runCandidateBuild({ buildSpecPath, output: outputDir, repositoryRoot });

    const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
    assert.equal(provenance.candidateBuild.artifactKind, "datapack-candidate-build-spec");
    assert.equal(provenance.candidateBuild.sourceSnapshotSetHash, "a".repeat(64));
    assert.equal(provenance.candidateBuild.approvedAliasLedgerHash, "b".repeat(64));
    assert.equal(provenance.candidateBuild.facilityEvidenceLedgerHash, "c".repeat(64));
    assert.equal(provenance.candidateBuild.routeEvidenceLedgerHash, "d".repeat(64));
    assert.equal(provenance.candidateBuild.approvedOverrideSetHash, "e".repeat(64));
    assert.equal(provenance.candidateBuild.sourceInventorySha256, "f".repeat(64));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 buildSpec과 fixture 동시 입력을 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-conflict-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  try {
    await assert.rejects(
      runDatapackInRepository({
        argv: [
          "--fixture", "tools/datapack/fixtures/catalog-fixture.json",
          "--build-spec", "tools/datapack/fixtures/candidate-build-spec.json",
          "--output", path.join(workspace, "output"),
        ],
        repositoryRoot,
      }),
      /exactly one of --fixture or --build-spec is required/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 invalid buildSpec hash를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-invalid-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const outputDir = path.join(workspace, "output");
  const buildSpecDir = path.join(repositoryRoot, "tmp");
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.invalid.json");
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"), "utf8"));
  buildSpec.approvedAliasLedgerHash = "not-a-sha";
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await assert.rejects(
      runCandidateBuild({ buildSpecPath, output: outputDir, repositoryRoot }),
      /buildSpec.approvedAliasLedgerHash must be a sha256 hex string/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 repo와 temp 밖 buildSpec fixturePath를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-path-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const outputDir = path.join(workspace, "output");
  const buildSpecDir = path.join(repositoryRoot, "tmp");
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.invalid-path.json");
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"), "utf8"));
  buildSpec.fixturePath = path.resolve(path.parse(root).root, "etc", "hosts");
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await assert.rejects(
      runCandidateBuild({ buildSpecPath, output: outputDir, repositoryRoot }),
      /buildSpec.fixturePath must stay inside repository or temp directory/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 repo 내부 symlink가 temp 밖 fixture를 가리키면 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-build-spec-symlink-"));
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const outputDir = path.join(workspace, "output");
  const buildSpecDir = path.join(repositoryRoot, "tmp");
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.symlink.json");
  const symlinkPath = path.join(buildSpecDir, "catalog-fixture.symlink.json");
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json"), "utf8"));
  buildSpec.fixturePath = symlinkPath;
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);
  await symlink(path.resolve(path.parse(root).root, "etc", "hosts"), symlinkPath);

  try {
    await assert.rejects(
      runCandidateBuild({ buildSpecPath, output: outputDir, repositoryRoot }),
      /buildSpec.fixturePath must stay inside repository or temp directory/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("데이터팩 publish preflight plan은 pack 검증 후 manifest publish를 마지막 단계로 고정한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-publish-plan-${Date.now()}`);
  const stageDir = path.join(tmpdir(), `easysubway-datapack-publish-stage-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "catalog"), { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pack = manifest.packs[0];
  await copyFile(path.join(outputDir, pack.url), path.join(stageDir, pack.url));
  const stagedManifestPath = path.join(stageDir, "catalog", "current.json");
  await copyFile(manifestPath, stagedManifestPath);

  const publishPlanPath = path.join(stageDir, "publish-plan.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/create-publish-plan.mjs",
      "--manifest",
      stagedManifestPath,
      "--root",
      stageDir,
      "--output",
      publishPlanPath,
    ],
    { cwd: root },
  );

  const plan = JSON.parse(await readFile(publishPlanPath, "utf8"));
  // catalog fixture manifest는 fixture build spec의 releaseSequence 1을 싣으므로 immutable release manifest 단계가 포함된다.
  assert.equal(manifest.releaseSequence, 1);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.manifestObjectKey, "catalog/current.json");
  assert.deepEqual(plan.steps.map((step) => step.type), [
    "put-pack-object",
    "verify-pack-object",
    "put-release-manifest-object",
    "verify-release-manifest-object",
    "put-manifest-object",
    "verify-manifest-object",
  ]);
  assert.deepEqual(plan.steps[0], {
    type: "put-pack-object",
    packId: "capital",
    packVersion: "1",
    sourcePath: "catalog/capital-v1.sqlite.gz",
    objectKey: "catalog/capital-v1.sqlite.gz",
    sha256: pack.sha256,
    sizeBytes: pack.sizeBytes,
  });
  assert.deepEqual(plan.steps[1], {
    type: "verify-pack-object",
    packId: "capital",
    packVersion: "1",
    objectKey: "catalog/capital-v1.sqlite.gz",
    sha256: pack.sha256,
    sizeBytes: pack.sizeBytes,
  });
  assert.equal(plan.steps[2].objectKey, "catalog/releases/1.json");
  assert.equal(plan.steps[2].sha256, sha256(await readFile(stagedManifestPath)));
  assert.equal(plan.steps[3].objectKey, "catalog/releases/1.json");
  assert.equal(plan.steps[4].type, "put-manifest-object");
  assert.equal(plan.steps[4].sourcePath, "catalog/current.json");
  assert.equal(plan.steps[4].objectKey, "catalog/current.json");
  assert.equal(plan.steps[4].packCount, 1);
  assert.equal(plan.steps[4].sha256, sha256(await readFile(stagedManifestPath)));
  assert.equal(plan.steps[5].type, "verify-manifest-object");
  assert.equal(plan.steps[5].objectKey, "catalog/current.json");
  assert.equal(plan.steps[5].sha256, sha256(await readFile(stagedManifestPath)));

  const customPackBytes = Buffer.from("custom relative pack bytes");
  const customPackPath = path.join(stageDir, "packs", "custom-capital.sqlite.gz");
  await mkdir(path.dirname(customPackPath), { recursive: true });
  await writeFile(customPackPath, customPackBytes);
  await writeFile(
    stagedManifestPath,
    `${JSON.stringify(
      {
        packs: [
          {
            id: "capital",
            version: "1",
            url: "packs/custom-capital.sqlite.gz",
            sha256: sha256(customPackBytes),
            sizeBytes: customPackBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/create-publish-plan.mjs",
      "--manifest",
      stagedManifestPath,
      "--root",
      stageDir,
      "--output",
      publishPlanPath,
    ],
    { cwd: root },
  );
  const customPlan = JSON.parse(await readFile(publishPlanPath, "utf8"));
  assert.equal(customPlan.schemaVersion, 1);
  assert.deepEqual(customPlan.steps.map((step) => step.type), [
    "put-pack-object",
    "verify-pack-object",
    "put-manifest-object",
    "verify-manifest-object",
  ]);
  assert.equal(customPlan.steps[0].sourcePath, "packs/custom-capital.sqlite.gz");
  assert.equal(customPlan.steps[0].objectKey, "packs/custom-capital.sqlite.gz");

  await writeFile(path.join(stageDir, pack.url), "corrupt pack bytes");
  await copyFile(manifestPath, stagedManifestPath);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/create-publish-plan.mjs",
        "--manifest",
        stagedManifestPath,
        "--root",
        stageDir,
        "--output",
        publishPlanPath,
      ],
      { cwd: root },
    ),
    /capital@1 sizeBytes mismatch/,
  );
});

test("데이터팩 object storage publisher는 pack 검증 후 manifest를 마지막에 PUT한다", async () => {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-object-publish-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "catalog"), { recursive: true });

  const packBytes = Buffer.from("pack payload");
  const manifestBytes = Buffer.from('{"packs":[{"id":"capital","version":"1"}]}\n');
  await writeFile(path.join(stageDir, "catalog", "capital-v1.sqlite.gz"), packBytes);
  await writeFile(path.join(stageDir, "catalog", "current.json"), manifestBytes);
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        steps: [
          {
            type: "put-pack-object",
            sourcePath: "catalog/capital-v1.sqlite.gz",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "verify-pack-object",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "put-manifest-object",
            sourcePath: "catalog/current.json",
            objectKey: "catalog/current.json",
            sha256: sha256(manifestBytes),
            sizeBytes: manifestBytes.length,
          },
          {
            type: "verify-manifest-object",
            objectKey: "catalog/current.json",
            sha256: sha256(manifestBytes),
            sizeBytes: manifestBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const server = await startObjectStorageServer();
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/publish-object-storage.mjs",
        "--plan",
        planPath,
        "--root",
        stageDir,
      ],
      {
        cwd: root,
        env: objectStorageEnv(server.origin),
      },
    );

    assert.deepEqual(
      server.requests.map((request) => `${request.method} ${request.path}`),
      [
        "PUT /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        "PUT /easysubway-datapacks/catalog/current.json",
        "HEAD /easysubway-datapacks/catalog/current.json",
      ],
    );
    assert.ok(
      server.requests.every((request) => request.authorization?.startsWith("AWS4-HMAC-SHA256 ")),
      "publisher must sign every object storage request",
    );
    assert.equal(server.objects.get("catalog/capital-v1.sqlite.gz").sha256, sha256(packBytes));
    assert.equal(server.objects.get("catalog/current.json").sha256, sha256(manifestBytes));

    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/publish-object-storage.mjs",
        "--plan",
        planPath,
        "--root",
        stageDir,
        "--verify-only",
      ],
      {
        cwd: root,
        env: objectStorageEnv(server.origin),
      },
    );
    assert.deepEqual(
      server.requests.slice(-2).map((request) => `${request.method} ${request.path}`),
      [
        "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        "HEAD /easysubway-datapacks/catalog/current.json",
      ],
    );
  } finally {
    await server.close();
  }
});

test("데이터팩 object storage publisher는 PDF와 SVG content type을 보존한다", async () => {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-map-asset-publish-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "maps"), { recursive: true });

  const pdfBytes = Buffer.from("%PDF-1.6\n");
  const svgBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" />\n");
  await writeFile(path.join(stageDir, "maps", "seoul.pdf"), pdfBytes);
  await writeFile(path.join(stageDir, "maps", "gwangju.svg"), svgBytes);
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify({
      schemaVersion: 1,
      steps: [
        {
          type: "put-pack-object",
          sourcePath: "maps/seoul.pdf",
          objectKey: "maps/seoul.pdf",
          sha256: sha256(pdfBytes),
          sizeBytes: pdfBytes.length,
        },
        {
          type: "verify-pack-object",
          objectKey: "maps/seoul.pdf",
          sha256: sha256(pdfBytes),
          sizeBytes: pdfBytes.length,
        },
        {
          type: "put-pack-object",
          sourcePath: "maps/gwangju.svg",
          objectKey: "maps/gwangju.svg",
          sha256: sha256(svgBytes),
          sizeBytes: svgBytes.length,
        },
        {
          type: "verify-pack-object",
          objectKey: "maps/gwangju.svg",
          sha256: sha256(svgBytes),
          sizeBytes: svgBytes.length,
        },
      ],
    })}\n`,
  );

  const server = await startObjectStorageServer();
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/publish-object-storage.mjs",
        "--plan",
        planPath,
        "--root",
        stageDir,
      ],
      {
        cwd: root,
        env: objectStorageEnv(server.origin),
      },
    );

    assert.equal(server.objects.get("maps/seoul.pdf").contentType, "application/pdf");
    assert.equal(server.objects.get("maps/gwangju.svg").contentType, "image/svg+xml");
  } finally {
    await server.close();
  }
});

test("데이터팩 object storage publisher는 PAR URL로 pack 검증 후 manifest를 마지막에 PUT한다", async () => {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-par-publish-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "catalog"), { recursive: true });

  const packBytes = Buffer.from("pack payload");
  const manifestBytes = Buffer.from('{"packs":[{"id":"capital","version":"1"}]}\n');
  await writeFile(path.join(stageDir, "catalog", "capital-v1.sqlite.gz"), packBytes);
  await writeFile(path.join(stageDir, "catalog", "current.json"), manifestBytes);
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        steps: [
          {
            type: "put-pack-object",
            sourcePath: "catalog/capital-v1.sqlite.gz",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "verify-pack-object",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "put-manifest-object",
            sourcePath: "catalog/current.json",
            objectKey: "catalog/current.json",
            sha256: sha256(manifestBytes),
            sizeBytes: manifestBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const server = await startObjectStorageServer({ requireAuthorization: false, basePath: "/p/par-token/n/ns/b/bucket/o" });
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/publish-object-storage.mjs",
        "--plan",
        planPath,
        "--root",
        stageDir,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: `${server.origin}/p/par-token/n/ns/b/bucket/o/`,
        },
      },
    );

    assert.deepEqual(
      server.requests.map((request) => `${request.method} ${request.path}`),
      [
        "PUT /p/par-token/n/ns/b/bucket/o/catalog/capital-v1.sqlite.gz",
        "GET /p/par-token/n/ns/b/bucket/o/catalog/capital-v1.sqlite.gz",
        "PUT /p/par-token/n/ns/b/bucket/o/catalog/current.json",
      ],
    );
    assert.ok(
      server.requests.every((request) => request.authorization === undefined),
      "PAR publisher must not send S3 authorization headers",
    );
    assert.equal(server.objects.get("catalog/capital-v1.sqlite.gz").sha256, sha256(packBytes));
    assert.equal(server.objects.get("catalog/current.json").sha256, sha256(manifestBytes));
  } finally {
    await server.close();
  }
});

test("데이터팩 object storage publisher는 pack 검증 실패 시 manifest를 게시하지 않는다", async () => {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-object-publish-fail-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "catalog"), { recursive: true });

  const packBytes = Buffer.from("pack payload");
  const manifestBytes = Buffer.from('{"packs":[{"id":"capital","version":"1"}]}\n');
  await writeFile(path.join(stageDir, "catalog", "capital-v1.sqlite.gz"), packBytes);
  await writeFile(path.join(stageDir, "catalog", "current.json"), manifestBytes);
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        steps: [
          {
            type: "put-pack-object",
            sourcePath: "catalog/capital-v1.sqlite.gz",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "verify-pack-object",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: "0".repeat(64),
            sizeBytes: packBytes.length,
          },
          {
            type: "put-manifest-object",
            sourcePath: "catalog/current.json",
            objectKey: "catalog/current.json",
            sha256: sha256(manifestBytes),
            sizeBytes: manifestBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const server = await startObjectStorageServer();
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/publish-object-storage.mjs",
          "--plan",
          planPath,
          "--root",
          stageDir,
        ],
        {
          cwd: root,
          env: objectStorageEnv(server.origin),
        },
      ),
      /catalog\/capital-v1\.sqlite\.gz uploaded checksum mismatch/,
    );

    assert.deepEqual(
      server.requests.map((request) => `${request.method} ${request.path}`),
      [
        "PUT /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
      ],
    );
    assert.equal(server.objects.has("catalog/current.json"), false);
  } finally {
    await server.close();
  }
});

test("데이터팩 remote publish env exporter는 object storage와 signing 값을 GitHub env로 내보낸다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-env-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=https://cdn.example.com/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=https://object-storage.example.com",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key\\nline",
      "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key\\nline",
      "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1",
      "EASYSUBWAY_ADMIN_PASSWORD=admin-password-must-not-export",
      "",
    ].join("\n"),
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/export-publish-env.mjs",
      "--env-file",
      envFile,
      "--github-env",
      githubEnvFile,
      "--github-output",
      path.join(dir, "github-output.txt"),
    ],
    { cwd: root },
  );

  const exported = await readFile(githubEnvFile, "utf8");
  assert.match(stdout, /^::add-mask::access-key$/m);
  assert.match(stdout, /^::add-mask::secret-key$/m);
  assert.match(stdout, /^::add-mask::private-key\\nline$/m);
  assert.match(stdout, /^::add-mask::private-key%0Aline$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=enabled$/m);
  assert.match(exported, /^EASYSUBWAY_DATA_PACK_BASE_URL=https:\/\/cdn\.example\.com\/easysubway-datapacks$/m);
  assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=https:\/\/object-storage\.example\.com$/m);
  assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key$/m);
  assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key$/m);
  assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks$/m);
  assert.match(exported, /EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM<<EASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM_EOF\nprivate-key\nline\nEASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM_EOF/);
  assert.match(exported, /EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM<<EASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM_EOF\npublic-key\nline\nEASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM_EOF/);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1$/m);
  assert.doesNotMatch(exported, /ADMIN_PASSWORD/);
});

test("데이터팩 remote publish env exporter는 PAR URL을 secret publish target으로 내보낸다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-par-env-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=https://cdn.example.com/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL=https://objectstorage.example.com/p/token/n/ns/b/bucket/o/",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key-must-not-export",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key-must-not-export",
      "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key-pem",
      "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key-pem",
      "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1",
      "",
    ].join("\n"),
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/export-publish-env.mjs",
      "--env-file",
      envFile,
      "--github-env",
      githubEnvFile,
      "--github-output",
      path.join(dir, "github-output.txt"),
    ],
    { cwd: root },
  );

  const exported = await readFile(githubEnvFile, "utf8");
  assert.match(stdout, /^::add-mask::https:\/\/objectstorage\.example\.com\/p\/token\/n\/ns\/b\/bucket\/o\/$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=enabled$/m);
  assert.match(exported, /^EASYSUBWAY_DATA_PACK_BASE_URL=https:\/\/cdn\.example\.com\/easysubway-datapacks$/m);
  assert.match(
    exported,
    /^EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL=https:\/\/objectstorage\.example\.com\/p\/token\/n\/ns\/b\/bucket\/o\/$/m,
  );
  assert.doesNotMatch(exported, /ACCESS_KEY/);
  assert.doesNotMatch(exported, /SECRET_KEY/);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key-pem$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key-pem$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1$/m);
});

test("데이터팩 remote publish env exporter는 opt-in이 없으면 원격 publish를 비활성화한다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-env-disabled-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  const githubOutputFile = path.join(dir, "github-output.txt");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=http://localhost:9000/easysubway-datapacks",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=http://localhost:9000",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "",
    ].join("\n"),
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/export-publish-env.mjs",
      "--env-file",
      envFile,
      "--github-env",
      githubEnvFile,
      "--github-output",
      githubOutputFile,
    ],
    { cwd: root },
  );

  assert.match(await readFile(githubEnvFile, "utf8"), /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=disabled$/m);
  assert.match(await readFile(githubOutputFile, "utf8"), /^enabled=false$/m);
});

test("데이터팩 remote publish env exporter는 opt-in된 로컬 placeholder publish 대상을 거부한다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-env-local-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=http://localhost:9000/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=http://localhost:9000",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "",
    ].join("\n"),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/export-publish-env.mjs",
        "--env-file",
        envFile,
        "--github-env",
        githubEnvFile,
        "--github-output",
        path.join(dir, "github-output.txt"),
      ],
      { cwd: root },
    ),
    /EASYSUBWAY_DATA_PACK_BASE_URL must be an HTTPS public URL/,
  );
});

test("데이터팩 remote publish env exporter는 허용된 workflow에서 invalid publish env를 skip 처리한다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-env-invalid-skip-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  const githubOutputFile = path.join(dir, "github-output.txt");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=http://localhost:9000/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=http://localhost:9000",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "",
    ].join("\n"),
  );

  const { stderr } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/export-publish-env.mjs",
      "--env-file",
      envFile,
      "--github-env",
      githubEnvFile,
      "--github-output",
      githubOutputFile,
      "--allow-invalid-disabled",
    ],
    { cwd: root },
  );

  assert.match(stderr, /remote publish disabled: EASYSUBWAY_DATA_PACK_BASE_URL must be an HTTPS public URL/);
  assert.match(await readFile(githubEnvFile, "utf8"), /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=disabled$/m);
  assert.match(await readFile(githubOutputFile, "utf8"), /^enabled=false$/m);
  assert.match(await readFile(githubOutputFile, "utf8"), /^invalid=true$/m);
});

test("데이터팩 생성기는 production 시설 status 의미와 검증 근거 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-production-facility-provenance-${Date.now()}`);
  const input = productionSourceIngestInput();
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const inventoryPath = await testOnlyInventoryPath(outputDir);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      inventoryPath,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  delete fixture.packs[0].facilities[0].statusMeaning;
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        outputPath,
        "--output",
        path.join(outputDir, "pack"),
      ],
      { cwd: root, env: productionEnv },
    ),
    /production facilities\.statusMeaning must be a non-empty string/,
  );
});

test("데이터팩 quality metric report는 denominator 기반 metric과 freshness를 산출한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-quality-report-${Date.now()}`);
  const reportPath = path.join(outputDir, "artifacts/datapack-quality-metrics.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-quality-metric-report.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--output",
      reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.artifactKind, "datapack-quality-metric-report");
  assert.equal(report.summary.packCount, 1);
  assert.equal(report.summary.worstRequiredFacilityEvidenceCoverageRatio, 0.1852);
  assert.equal(report.summary.worstFreshnessValidRatio, 0);
  assert.equal(report.packs[0].denominatorPolicy, "station_line_x_required_facility_type");
  assert.equal(report.packs[0].metrics.requiredFacilityEvidenceCoverageRatio, 0.1852);
  assert.equal(report.packs[0].metrics.freshnessValidRatio, 0);
});

test("데이터팩 headway report는 stop_times와 frequencies에서 대기시간 근거를 산출한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-headway-report-${Date.now()}`);
  const reportPath = path.join(outputDir, "artifacts/datapack-headways.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-headway-report.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.artifactKind, "datapack-headway-report");
  assert.equal(report.summary.packCount, 1);
  assert.equal(report.summary.declaredFrequencyCount, 1);
  assert.equal(report.packs[0].declaredFrequencies[0].headwaySeconds, 600);
  const sangnoksu = report.packs[0].observedHeadways.find(
    (row) =>
      row.stationId === "station-sangnoksu" &&
      row.stationLineId === "seoul-4" &&
      row.servicePattern === "LOCAL",
  );
  assert.deepEqual(sangnoksu.departures, [29100, 90300]);
  assert.equal(sangnoksu.minHeadwaySeconds, 61200);

  const defaultLocalFixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  delete defaultLocalFixture.packs[0].transitTrips.find(
    (row) => row.id === "trip-seoul-4-local-2505",
  ).servicePattern;
  const defaultLocalFixturePath = path.join(outputDir, "default-local-fixture.json");
  const defaultLocalReportPath = path.join(outputDir, "artifacts/datapack-headways-default-local.json");
  await writeFile(defaultLocalFixturePath, `${JSON.stringify(defaultLocalFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-headway-report.mjs",
      "--fixture",
      defaultLocalFixturePath,
      "--output",
      defaultLocalReportPath,
    ],
    { cwd: root },
  );
  const defaultLocalReport = JSON.parse(await readFile(defaultLocalReportPath, "utf8"));
  const defaultLocalSangnoksu = defaultLocalReport.packs[0].observedHeadways.find(
    (row) =>
      row.stationId === "station-sangnoksu" &&
      row.stationLineId === "seoul-4" &&
      row.servicePattern === "LOCAL",
  );
  assert.deepEqual(defaultLocalSangnoksu.departures, [29100, 90300]);

  const frequencyTemplateFixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  frequencyTemplateFixture.packs[0].transitTrips.push({
    id: "trip-seoul-2-local-0830",
    routeId: "route-seoul-2-inner",
    serviceId: "weekday-2026",
    tripHeadsign: "내선순환",
    directionId: "inner",
    servicePattern: "LOCAL",
    serviceDayStartSeconds: 0,
  });
  frequencyTemplateFixture.packs[0].transitStopTimes.push({
    tripId: "trip-seoul-2-local-0830",
    stopSequence: 1,
    stationId: "station-sadang",
    lineId: "seoul-2",
    arrivalSeconds: 30600,
    departureSeconds: 30600,
  });
  frequencyTemplateFixture.packs[0].transitFrequencies.push({
    tripId: "trip-seoul-2-local-0830",
    startTimeSeconds: 30600,
    endTimeSeconds: 33600,
    headwaySeconds: 600,
    exactTimes: false,
  });
  const frequencyTemplateFixturePath = path.join(outputDir, "frequency-template-fixture.json");
  const frequencyTemplateReportPath = path.join(outputDir, "artifacts/datapack-headways-frequency-template.json");
  await writeFile(frequencyTemplateFixturePath, `${JSON.stringify(frequencyTemplateFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-headway-report.mjs",
      "--fixture",
      frequencyTemplateFixturePath,
      "--output",
      frequencyTemplateReportPath,
    ],
    { cwd: root },
  );
  const frequencyTemplateReport = JSON.parse(await readFile(frequencyTemplateReportPath, "utf8"));
  assert.equal(
    frequencyTemplateReport.packs[0].observedHeadways.some((row) => row.lineId === "seoul-2"),
    false,
  );

  const noPickupFixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  noPickupFixture.packs[0].transitStopTimes.find(
    (row) => row.tripId === "trip-seoul-4-local-2505" && row.stationId === "station-sangnoksu",
  ).pickupType = 1;
  const noPickupFixturePath = path.join(outputDir, "no-pickup-fixture.json");
  const noPickupReportPath = path.join(outputDir, "artifacts/datapack-headways-no-pickup.json");
  await writeFile(noPickupFixturePath, `${JSON.stringify(noPickupFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-headway-report.mjs",
      "--fixture",
      noPickupFixturePath,
      "--output",
      noPickupReportPath,
    ],
    { cwd: root },
  );
  const noPickupReport = JSON.parse(await readFile(noPickupReportPath, "utf8"));
  assert.equal(
    noPickupReport.packs[0].observedHeadways.some(
      (row) =>
        row.stationId === "station-sangnoksu" &&
        row.stationLineId === "seoul-4" &&
        row.servicePattern === "LOCAL",
    ),
    false,
  );
});

test("데이터팩 quality metric report는 freshness metric 누락 manifest를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-quality-report-invalid-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.packs[0].regionalQualityMetrics.freshnessValidRatio;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-quality-metric-report.mjs",
        "--manifest",
        manifestPath,
      ],
      { cwd: root },
    ),
    /freshnessValidRatio must be a ratio/,
  );
});

test("source candidate sample 검증기는 KRIC live evidence metadata를 허용한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-sample-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const sample = {
    candidateId: "kric-subway-route-info",
    endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayRouteInfo",
    format: "json",
    fields: [
      "lnCd",
      "mreaWideCd",
      "railOprIsttCd",
      "routCd",
      "routNm",
      "stinCd",
      "stinConsOrdr",
      "stinNm",
    ],
    rowCount: 1,
    rawSha256: sha256("kric-subway-route-info raw sample"),
    schemaFingerprint: sha256(JSON.stringify([
      "lnCd",
      "mreaWideCd",
      "railOprIsttCd",
      "routCd",
      "routNm",
      "stinCd",
      "stinConsOrdr",
      "stinNm",
    ])),
    credentialRedacted: true,
    providerRecordHashes: [sha256("kric-subway-route-info row")],
  };
  sample.evidenceHash = sha256(JSON.stringify(sample));
  await writeFile(
    samplePath,
    `${JSON.stringify(sample, null, 2)}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-subway-route-info",
      "--sample",
      samplePath,
    ],
    { cwd: root },
  );

  assert.match(stdout, /source candidate sample evidence valid: kric-subway-route-info/);
});

test("KRIC route graph 수집 계획은 검증된 XML live sample을 재취득 없이 그대로 계획한다", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/plan-kric-route-graph-collection.mjs",
    ],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);

  assert.equal(plan.artifactKind, "kric-route-graph-membership-collection-plan");
  assert.equal(plan.serviceKeyEnv, "KRIC_SERVICE_KEY");
  assert.equal(plan.productionUseAllowed, false);
  assert.equal("remainingAdmissionBlocker" in plan, false);
  assert.deepEqual(
    plan.requests.map((request) => request.candidateId),
    ["kric-subway-route-info", "kric-station-info"],
  );
  for (const request of plan.requests) {
    const url = new URL(request.url);
    const serviceKeyEntries = [...url.searchParams.entries()].filter(
      ([name]) => name.toLowerCase() === "servicekey",
    );
    assert.deepEqual(serviceKeyEntries, [["serviceKey", "[서비스키값]"]]);
    assert.match(request.url, /[?&]serviceKey=\[서비스키값\](?:&|$)/);
    assert.equal(url.searchParams.get("format"), "xml");
    assert.equal(request.sampleEvidenceStatus, "validated_live_sample");
    assert.equal(request.plannedSampleFormat, "xml");
    assert.equal(request.validatedLiveSampleFormat, "xml");
    assert.equal(request.sampleAcquisitionRequired, false);
    assert.equal("remainingAdmissionBlocker" in request, false);
    assert.equal(request.productionUseAllowed, false);
    assert.equal(request.automaticRouteGraphEdgeAllowed, false);
    assert.deepEqual(request.capabilities, {
      schedule: false,
      realtime: false,
      facility: false,
    });
  }
  assert.equal(plan.requests[0].priority, 1);
  assert.deepEqual(plan.requests[0].remainingAdmissionBlockers, [
    "credentialFreeRawArchive",
    "licenseCommercialRedistributionEvidence",
    "line4RouteStationOrderCoverage",
    "providerTermsOrQuotaApproval",
    "rawObjectUri",
  ]);
  assert.deepEqual(plan.requests[1].remainingAdmissionBlockers, [
    "credentialFreeRawArchive",
    "licenseCommercialRedistributionEvidence",
    "kricStandardStationFileComparison",
    "line4StationCoverage",
    "providerTermsOrQuotaApproval",
    "rawObjectUri",
  ]);
  assert.deepEqual(plan.requests[0].expectedFields, [
    "lnCd",
    "mreaWideCd",
    "railOprIsttCd",
    "routCd",
    "routNm",
    "stinCd",
    "stinConsOrdr",
    "stinNm",
  ]);
});

test("KRIC route graph 수집 계획은 pending 후보의 sample acquisition lifecycle을 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-pending-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  candidate.sampleEvidenceStatus = "sample_url_documented_key_required";
  delete candidate.evidence.liveSampleFormat;
  candidate.evidence.missingEvidence = ["sampleResponse"];
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/plan-kric-route-graph-collection.mjs",
      "--candidates",
      candidatesPath,
      "--candidate",
      "kric-subway-route-info",
    ],
    { cwd: root },
  );
  const [request] = JSON.parse(stdout).requests;

  assert.equal(request.sampleEvidenceStatus, "sample_url_documented_key_required");
  assert.equal(request.plannedSampleFormat, "json");
  assert.equal(request.validatedLiveSampleFormat, null);
  assert.equal(request.sampleAcquisitionRequired, true);
  assert.equal("remainingAdmissionBlocker" in request, false);
  assert.deepEqual(request.remainingAdmissionBlockers, ["sampleResponse"]);
  assert.equal(request.productionUseAllowed, false);
  assert.equal(request.automaticRouteGraphEdgeAllowed, false);
});

test("KRIC route graph 수집 계획은 live sample format 누락 또는 미지원 값을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-live-format-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  const runPlanner = () => execFileAsync(
    process.execPath,
    ["tools/datapack/plan-kric-route-graph-collection.mjs", "--candidates", candidatesPath, "--candidate", candidate.id],
    { cwd: root },
  );

  delete candidate.evidence.liveSampleFormat;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /liveSampleFormat is required/);

  candidate.evidence.liveSampleFormat = "csv";
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /liveSampleFormat must be JSON or XML/);
});

test("KRIC route graph 수집 계획은 validated live sample provenance 누락·invalid·field mismatch를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-live-provenance-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  const runPlanner = () => execFileAsync(
    process.execPath,
    ["tools/datapack/plan-kric-route-graph-collection.mjs", "--candidates", candidatesPath, "--candidate", candidate.id],
    { cwd: root },
  );
  const invalidValues = {
    liveSampleRawSha256: "A".repeat(64),
    liveSampleSchemaFingerprint: "invalid",
    liveSampleEvidenceHash: "0".repeat(63),
    liveSampleRetrievedAt: "2026-07-11T09:58:45+09:00",
    liveSampleRowCount: 0,
    liveSampleFields: ["lnCd", "lnCd"],
  };

  for (const [field, invalidValue] of Object.entries(invalidValues)) {
    const invalidCandidates = structuredClone(candidates);
    const invalidCandidate = invalidCandidates.candidates.find((entry) => entry.id === candidate.id);
    delete invalidCandidate.evidence[field];
    await writeFile(candidatesPath, `${JSON.stringify(invalidCandidates, null, 2)}\n`);
    await assert.rejects(runPlanner(), new RegExp(`${field}.*required`));

    invalidCandidate.evidence[field] = invalidValue;
    await writeFile(candidatesPath, `${JSON.stringify(invalidCandidates, null, 2)}\n`);
    await assert.rejects(runPlanner(), new RegExp(field));
  }

  const mismatchedCandidates = structuredClone(candidates);
  const mismatchedCandidate = mismatchedCandidates.candidates.find((entry) => entry.id === candidate.id);
  mismatchedCandidate.evidence.liveSampleFields = mismatchedCandidate.evidence.liveSampleFields.slice(1);
  await writeFile(candidatesPath, `${JSON.stringify(mismatchedCandidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /liveSampleFields must match outputFields/);

  for (const outputFields of ["lnCd", [], ["lnCd", "lnCd"]]) {
    const invalidCandidates = structuredClone(candidates);
    const invalidCandidate = invalidCandidates.candidates.find((entry) => entry.id === candidate.id);
    invalidCandidate.evidence.outputFields = outputFields;
    invalidCandidate.evidence.liveSampleFields = ["lnCd"];
    await writeFile(candidatesPath, `${JSON.stringify(invalidCandidates, null, 2)}\n`);
    await assert.rejects(runPlanner(), /outputFields must be non-empty unique strings/);
  }
});

test("KRIC route graph 수집 계획은 지원하지 않는 KRIC 후보를 거부한다", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/plan-kric-route-graph-collection.mjs", "--candidate", "kric-station-platform"],
      { cwd: root },
    ),
    /unsupported KRIC route graph candidate: kric-station-platform/,
  );
});

test("KRIC route graph 수집 계획은 case-insensitive format 변형을 validated XML format 하나로 정규화한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-format-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  candidate.evidence.sampleUrl = candidate.evidence.sampleUrl.replace(
    "format=xml",
    "Format=xml&format=xml",
  );
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/plan-kric-route-graph-collection.mjs",
      "--candidates",
      candidatesPath,
      "--candidate",
      "kric-subway-route-info",
    ],
    { cwd: root },
  );
  const [request] = JSON.parse(stdout).requests;
  const formatEntries = [...new URL(request.url).searchParams.entries()].filter(
    ([name]) => name.toLowerCase() === "format",
  );

  assert.deepEqual(formatEntries, [["format", "xml"]]);
  assert.match(request.url, /[?&]format=xml(?:&|$)/);
});

test("KRIC route graph 수집 계획은 provenance 전용이 아닌 admission 또는 production/automatic edge가 열린 후보를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-state-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  const runPlanner = () => execFileAsync(
    process.execPath,
    [
      "tools/datapack/plan-kric-route-graph-collection.mjs",
      "--candidates",
      candidatesPath,
      "--candidate",
      "kric-subway-route-info",
    ],
    { cwd: root },
  );

  candidate.admissionStatus = "admitted_to_production_inventory";
  candidate.productionInventoryRelationship = "production_runtime_source";
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /admissionStatus must be pending admin review or inventory provenance only/);

  candidate.admissionStatus = "evidence_recorded_admin_review_required";
  candidate.automaticRouteGraphEdgeAllowed = true;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /automatic route graph edge must stay disabled/);

  candidate.automaticRouteGraphEdgeAllowed = false;
  candidate.capabilities.schedule.productionUseAllowed = true;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /production capability must stay disabled: schedule/);
});

test("KRIC route graph 수집 계획은 실제 serviceKey가 섞인 후보를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-secret-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  const originalSampleUrl = candidate.evidence.sampleUrl;
  candidate.evidence.sampleUrl = candidate.evidence.sampleUrl.replace("[서비스키값]", "real-secret-key");
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/plan-kric-route-graph-collection.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-subway-route-info",
      ],
      { cwd: root },
    ),
    /sampleUrl must keep exactly one redacted serviceKey/,
  );

  candidate.evidence.sampleUrl = `${originalSampleUrl}&serviceKey=real-secret-key`;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/plan-kric-route-graph-collection.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-subway-route-info",
      ],
      { cwd: root },
    ),
    /sampleUrl must keep exactly one redacted serviceKey/,
  );

  candidate.evidence.sampleUrl = `${originalSampleUrl}&ServiceKey=real-secret-key`;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/plan-kric-route-graph-collection.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-subway-route-info",
      ],
      { cwd: root },
    ),
    /sampleUrl must keep exactly one redacted serviceKey/,
  );
});

test("source candidate sample 검증기는 evidence hash metadata 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-sample-hash-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-subway-route-info",
        endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayRouteInfo",
        format: "json",
        fields: [
          "lnCd",
          "mreaWideCd",
          "railOprIsttCd",
          "routCd",
          "routNm",
          "stinCd",
          "stinConsOrdr",
          "stinNm",
        ],
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-subway-route-info",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /rawSha256 must be a sha256 hex string/,
  );
});

test("source candidate sample 검증기는 hand-edited evidence hash를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-stale-hash-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const sample = {
    candidateId: "kric-train-operation-organ",
    endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan",
    format: "json",
    fields: ["railOprIsttCd", "railOprIsttNm"],
    rowCount: 1,
    rawSha256: sha256("raw"),
    schemaFingerprint: sha256(JSON.stringify(["railOprIsttCd", "railOprIsttNm"])),
    credentialRedacted: true,
    providerRecordHashes: [sha256("row")],
  };
  sample.evidenceHash = sha256(JSON.stringify(sample));
  sample.fields.push("unexpectedField");
  await writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /output field missing|schemaFingerprint does not match fields/,
  );
});

test("source candidate sample 검증기는 endpoint mismatch를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-endpoint-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-subway-route-info",
        endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationInfo",
        format: "json",
        fields: [
          "lnCd",
          "mreaWideCd",
          "railOprIsttCd",
          "routCd",
          "routNm",
          "stinCd",
          "stinConsOrdr",
          "stinNm",
        ],
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-subway-route-info",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /endpoint mismatch/,
  );
});

async function writeFieldDiagnosticFixture(outputDir, { outputFields, fields }) {
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(candidatesPath, `${JSON.stringify({
    candidates: [{
      id: "field-diagnostic-test",
      evidence: {
        endpoint: "https://provider.invalid/field-diagnostic",
        formats: ["JSON"],
        outputFields,
      },
    }],
  }, null, 2)}\n`);
  await writeFile(samplePath, `${JSON.stringify({
    candidateId: "field-diagnostic-test",
    endpoint: "https://provider.invalid/field-diagnostic",
    format: "json",
    fields,
  }, null, 2)}\n`);
  return { candidatesPath, samplePath };
}

test("source candidate sample 검증기는 control과 delimiter field name을 한 줄 JSON string으로 escape한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-field-control-${Date.now()}`);
  const { candidatesPath, samplePath } = await writeFieldDiagnosticFixture(outputDir, {
    outputFields: ["expected"],
    fields: ["line\nbreak", "\u001b[31mred\u001b[0m", "nul\u0000field", "comma,name;next"],
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "field-diagnostic-test",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      const diagnostic = error.stderr.trimEnd();
      assert.equal(
        diagnostic,
        "output field missing: \"expected\"; available fields: \"\\u001b[31mred\\u001b[0m\", \"comma,name;next\", \"line\\nbreak\", \"nul\\u0000field\"",
      );
      assert.equal(diagnostic.split("\n").length, 1);
      assert.doesNotMatch(diagnostic, /\u001b|\u0000/);
      return true;
    },
  );
});

test("source candidate sample 검증기는 credential-like field name을 generic 오류로 차단한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-field-credential-${Date.now()}`);
  const credentialLikeField = "https://provider.invalid/sample?serviceKey=credential-like-field-secret";
  const { candidatesPath, samplePath } = await writeFieldDiagnosticFixture(outputDir, {
    outputFields: ["expected"],
    fields: ["safeField", credentialLikeField],
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "field-diagnostic-test",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(error.stderr.trim(), "sample field names must not contain credentials");
      assert.doesNotMatch(error.stderr, /credential-like-field-secret/);
      assert.equal(error.stderr.includes(credentialLikeField), false);
      return true;
    },
  );
});

test("source candidate sample 검증기는 ambiguous 첫 field에서 missing 진단을 즉시 확정한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-field-ambiguous-${Date.now()}`);
  const { candidatesPath, samplePath } = await writeFieldDiagnosticFixture(outputDir, {
    outputFields: ["foo", "bar"],
    fields: ["FOO", "Foo", "BAR"],
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "field-diagnostic-test",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(
        error.stderr.trim(),
        "output field missing: \"foo\"; available fields: \"BAR\", \"FOO\", \"Foo\"",
      );
      return true;
    },
  );
});

test("source candidate sample 검증기는 output field 대소문자 불일치를 field name만으로 진단한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-field-${Date.now()}`);
  const { candidatesPath, samplePath } = await writeFieldDiagnosticFixture(outputDir, {
    outputFields: ["updnDvcd"],
    fields: ["updnDvCd"],
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "field-diagnostic-test",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(
        error.stderr.trim(),
        "output field case mismatch: expected \"updnDvcd\"; actual \"updnDvCd\"",
      );
      return true;
    },
  );
});

test("source candidate sample 검증기는 true missing field를 sorted field name만으로 진단한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-missing-field-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-station-platform",
        endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stPlf",
        format: "json",
        fields: [
          "zProviderField",
          "stinFlor",
          "stinCd",
          "sfFotExt",
          "scrCharExt",
          "runDirTmnStinCd",
          "railOprIsttCd",
          "plfTpNm",
          "plfTpCd",
          "plfNo",
          "plfCplFlg",
          "lnCd",
          "grndDvCd",
          "aProviderField",
        ],
        providerSample: { updnDvCd: "SENTINEL_SAMPLE_VALUE" },
        observedUrl: "https://provider.invalid/sample?serviceKey=credential-like-secret",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-station-platform",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(
        error.stderr.trim(),
        "output field missing: \"updnDvCd\"; available fields: \"aProviderField\", \"grndDvCd\", \"lnCd\", \"plfCplFlg\", \"plfNo\", \"plfTpCd\", \"plfTpNm\", \"railOprIsttCd\", \"runDirTmnStinCd\", \"scrCharExt\", \"sfFotExt\", \"stinCd\", \"stinFlor\", \"zProviderField\"",
      );
      assert.doesNotMatch(error.stderr, /SENTINEL_SAMPLE_VALUE/);
      assert.doesNotMatch(error.stderr, /credential-like-secret/);
      return true;
    },
  );
});

test("source candidate sample 검증기는 KRIC 이동동선 route graph 자동 승격을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-route-edge-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-transfer-movement-standard",
        endpoint: "https://openapi.kric.go.kr/openapi/handicapped/transferMovement",
        format: "json",
        fields: [
          "chtnMvTpOrdr",
          "edMovePath",
          "elvtSttCd",
          "elvtTpCd",
          "imgPath",
          "mvContDtl",
          "mvPathMgNo",
          "stMovePath",
          "https://provider.invalid/sample?serviceKey=route-graph-secret",
        ],
        routeGraphEdgeAdmission: "allowed",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-transfer-movement-standard",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(
        error.stderr.trim(),
        "route graph edge admission requires confirmed fields: distanceMeters, durationSeconds",
      );
      assert.doesNotMatch(error.stderr, /route-graph-secret/);
      return true;
    },
  );
});

test("source candidate sample 검증기는 serviceKey credential 포함을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-secret-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-train-operation-organ",
        endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan",
        format: "json",
        fields: ["railOprIsttCd", "railOprIsttNm"],
        observedUrl: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan?serviceKey=actual-secret",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /sample evidence must not contain serviceKey credentials: observedUrl/,
  );
});

test("source candidate sample 검증기는 TOPIS path serviceKey credential 포함을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-topis-secret-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "seoul-topis-realtime-station-arrival",
        endpoint: "http://swopenapi.seoul.go.kr/api/subway/{serviceKey}/json/realtimeStationArrival",
        format: "json",
        fields: [
          "arvlCd",
          "arvlMsg2",
          "arvlMsg3",
          "barvlDt",
          "bstatnNm",
          "btrainNo",
          "recptnDt",
          "statnId",
          "statnNm",
          "subwayId",
          "trainLineNm",
          "updnLine",
        ],
        observedUrl: "http://swopenapi.seoul.go.kr/api/subway/actual-secret/json/realtimeStationArrival/0/5/서울",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "seoul-topis-realtime-station-arrival",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /sample evidence must not contain serviceKey credentials: observedUrl/,
  );
});

test("source candidate sample evidence builder는 raw JSON response를 validator 입력으로 변환한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-json-evidence-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.json");
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify([
      {
        railOprIsttCd: "S1",
      },
      {
        railOprIsttNm: "서울교통공사",
      },
    ])}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--response",
      responsePath,
    ],
    { cwd: root },
  );
  await writeFile(evidencePath, stdout);
  const evidence = JSON.parse(stdout);
  assert.match(evidence.rawSha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(evidence.credentialRedacted, true);
  assert.equal(evidence.rowCount, 2);
  assert.equal(evidence.providerRecordHashes.length, 2);
  assert.match(evidence.evidenceHash, /^[0-9a-f]{64}$/);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--sample",
      evidencePath,
    ],
    { cwd: root },
  );
});

test("KRIC 역사별 승강장 live JSON은 tracked candidate metadata로 builder와 validator를 통과한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-station-platform-live-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.json");
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify([{
      grndDvCd: "G",
      lnCd: "1",
      plfCplFlg: "Y",
      plfNo: "1",
      plfTpCd: "1",
      plfTpNm: "상대식",
      railOprIsttCd: "S1",
      runDirTmnStinCd: "0152",
      scrCharExt: "10",
      sfFotExt: "200",
      stinCd: "0152",
      stinFlor: "B2",
      updnDvCd: "U",
    }])}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-station-platform",
      "--response",
      responsePath,
    ],
    { cwd: root },
  );
  await writeFile(evidencePath, stdout);
  const evidence = JSON.parse(stdout);
  assert.ok(evidence.fields.includes("updnDvCd"));
  assert.ok(!evidence.fields.includes("updnDvcd"));

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-station-platform",
      "--sample",
      evidencePath,
    ],
    { cwd: root },
  );
});

test("source candidate sample builder와 validator는 code-unit field 정렬을 공유한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-field-sort-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.json");
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify([{
      stinCd: "312",
      stLocCont: "3호선 승강장",
      railOprIsttCd: "S1",
      lnCd: "3",
      clsLocCont: "환승 통로",
      chtnLn: "4",
      chtnDst: "120",
    }])}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-station-transfer-info",
      "--response",
      responsePath,
    ],
    { cwd: root },
  );
  await writeFile(evidencePath, stdout);
  const evidence = JSON.parse(stdout);
  assert.deepEqual(evidence.fields, [
    "chtnDst",
    "chtnLn",
    "clsLocCont",
    "lnCd",
    "railOprIsttCd",
    "stLocCont",
    "stinCd",
  ]);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-station-transfer-info",
      "--sample",
      evidencePath,
    ],
    { cwd: root },
  );
});

test("source candidate sample evidence builder는 raw XML response를 validator 입력으로 변환한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-xml-evidence-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.xml");
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `<response><body><items><item>
      <railOprIsttCd>S1</railOprIsttCd>
    </item><item>
      <railOprIsttCd>S2</railOprIsttCd>
      <railOprIsttNm/>
    </item></items></body></response>\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--response",
      responsePath,
    ],
    { cwd: root },
  );
  await writeFile(evidencePath, stdout);
  const evidence = JSON.parse(stdout);
  assert.match(evidence.rawSha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(evidence.credentialRedacted, true);
  assert.equal(evidence.rowCount, 2);
  assert.equal(evidence.providerRecordHashes.length, 2);
  assert.match(evidence.evidenceHash, /^[0-9a-f]{64}$/);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--sample",
      evidencePath,
    ],
    { cwd: root },
  );
});

test("source candidate sample evidence builder는 raw response의 serviceKey credential을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-raw-secret-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.xml");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify({ response: { body: { serviceKey: "actual-secret" } } })}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-source-candidate-sample-evidence.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--response",
        responsePath,
      ],
      { cwd: root },
    ),
    /raw sample response must not contain serviceKey credentials/,
  );
});

test("source candidate sample evidence builder는 raw response의 TOPIS path serviceKey credential을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-raw-topis-secret-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify({
      response: {
        url: "http://swopenapi.seoul.go.kr/api/subway/actual-secret/json/realtimePosition/0/5/1호선",
        body: {
          statnNm: "서울",
        },
      },
    })}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-source-candidate-sample-evidence.mjs",
        "--candidate",
        "seoul-topis-realtime-train-position",
        "--response",
        responsePath,
      ],
      { cwd: root },
    ),
    /raw sample response must not contain serviceKey credentials/,
  );
});

test("source admission pipeline은 admin 승인 record로 inventory admission evidence를 만든다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-${Date.now()}`);
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  const seedSamplePath = path.join(outputDir, "seed-sample.json");
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  const outputInventoryPath = path.join(outputDir, "source-inventory.admitted.json");
  const summaryPath = path.join(outputDir, "admission-summary.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidatesPath = await writePendingCandidateFixture(outputDir, "kric-train-operation-organ");
  await writeFile(rawPath, `${JSON.stringify([{ railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" }])}\n`);

  const { stdout: sampleStdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--response",
      rawPath,
    ],
    { cwd: root },
  );
  await writeFile(seedSamplePath, sampleStdout);
  const sample = JSON.parse(sampleStdout);
  const productionSource = {
    id: "kric-train-operation-organ",
    displayName: "열차운영기관정보",
    userDisplayName: "열차운영기관정보",
    owner: "국가철도공단",
    provider: "국가철도공단",
    sourceSystem: "KRIC OpenAPI",
    datasetUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266&service=convenientInfo&operation=trainOperationOrgan&page=3",
    requiredForProductionPack: false,
    updateFrequency: "provider-documented",
    observedDataUpdatedAt: "2026-07-02",
    retrievedAt: "2026-07-02",
    license: {
      type: "KOGL-1",
      name: "공공누리 1유형",
      attribution: "공공누리 제1유형: 출처표시",
      commercialUseAllowed: true,
      derivativeWorkAllowed: true,
      redistributionAllowed: true,
      evidenceUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266&service=convenientInfo&operation=trainOperationOrgan&page=3",
    },
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["seoul-metro"],
      sourceDomains: ["station_line_membership"],
    },
    fieldsProvided: ["railOprIsttCd", "railOprIsttNm"],
    capabilities: {
      schedule: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide scheduled timetable data",
      },
      realtime: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        liveEtaEligible: false,
        rateLimitStatus: "NOT_APPLICABLE",
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide realtime arrival data",
      },
      facility: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide accessibility facility records",
      },
    },
  };
  const adminReview = {
    schemaVersion: 1,
    artifactKind: "source-admission-admin-review",
    candidateId: "kric-train-operation-organ",
    sourceId: "kric-train-operation-organ",
    snapshotId: "kric-train-operation-organ-snapshot-20260702",
    sampleEvidenceHash: sample.evidenceHash,
    decision: "APPROVED",
    approvedBy: "qa-admin",
    approvedAt: "2026-07-02T00:10:00Z",
    licenseEvidenceHash: sha256("license-evidence"),
    aliasLedgerHash: sha256("alias-ledger"),
    operatorMappingLedgerHash: sha256("operator-mapping-ledger"),
    facilityEvidenceLedgerHash: sha256("facility-evidence-ledger"),
    routeEvidenceLedgerHash: sha256("route-evidence-ledger"),
    overrideHash: sha256("override-ledger"),
    quotaEvidence: {
      portal: "KRIC 레일포털",
      defaultDailyLimit: "unlimited",
      unlockStatus: "not_required",
      productionUseAllowed: true,
    },
    productionSource,
  };
  await writeFile(adminReviewPath, `${JSON.stringify(adminReview, null, 2)}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/run-source-admission-pipeline.mjs",
      "--candidates",
      candidatesPath,
      "--candidate",
      "kric-train-operation-organ",
      "--raw-input",
      rawPath,
      "--evidence-dir",
      outputDir,
      "--snapshot-id",
      "kric-train-operation-organ-snapshot-20260702",
      "--source-id",
      "kric-train-operation-organ",
      "--provider",
      "국가철도공단",
      "--source-class-id",
      "static_network_metadata",
      "--retrieved-at",
      "2026-07-02T00:00:00Z",
      "--source-updated-at",
      "2026-07-02T00:00:00Z",
      "--raw-object-uri",
      "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
      "--freshness-expires-at",
      "2026-08-01T00:00:00Z",
      "--admin-review",
      adminReviewPath,
      "--output-inventory",
      outputInventoryPath,
      "--output",
      summaryPath,
    ],
    { cwd: root },
  );

  assert.match(stdout, /source admission pipeline evidence written/);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  assert.equal(summary.artifactKind, "source-admission-pipeline-evidence");
  assert.equal(summary.candidateId, "kric-train-operation-organ");
  assert.match(summary.sourceSnapshotSetHash, /^[0-9a-f]{64}$/);
  assert.equal(summary.adminReviewRecordHash, sha256(JSON.stringify(sortJson(adminReview))));
  assert.equal(summary.licenseEvidenceHash, adminReview.licenseEvidenceHash);
  const outputInventory = JSON.parse(await readFile(outputInventoryPath, "utf8"));
  const admittedSource = outputInventory.sources.find((source) => source.id === "kric-train-operation-organ");
  assert.equal(admittedSource.admissionEvidence.licenseEvidenceHash, adminReview.licenseEvidenceHash);

  const mismatchedAdminReview = JSON.parse(JSON.stringify(adminReview));
  mismatchedAdminReview.productionSource.admissionEvidence = {
    quotaEvidence: {
      portal: "KRIC 레일포털",
      defaultDailyLimit: "unlimited",
      unlockStatus: "not_required",
      productionUseAllowed: false,
    },
  };
  await writeFile(adminReviewPath, `${JSON.stringify(mismatchedAdminReview, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--source-class-id",
        "static_network_metadata",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--source-updated-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-09-30T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.mismatched-quota.json"),
        "--output",
        path.join(outputDir, "admission-summary-mismatched-quota.json"),
      ],
      { cwd: root },
    ),
    /adminReview\.productionSource\.admissionEvidence\.quotaEvidence must match adminReview\.quotaEvidence/,
  );

  const unsanitizedAdminReview = JSON.parse(JSON.stringify(adminReview));
  unsanitizedAdminReview.quotaEvidence.providerAccountMemo = "local-only quota account detail";
  await writeFile(adminReviewPath, `${JSON.stringify(unsanitizedAdminReview, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--source-class-id",
        "static_network_metadata",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--source-updated-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-09-30T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.unsanitized-quota.json"),
        "--output",
        path.join(outputDir, "admission-summary-unsanitized-quota.json"),
      ],
      { cwd: root },
    ),
    /adminReview\.quotaEvidence must include defaultDailyLimit, portal, productionUseAllowed, unlockStatus and only optional documentedMonthlyLimit, runtimeDailyHardLimit, runtimePerMinuteHardLimit, sharedQuotaStore/,
  );
});

test("source admission pipeline은 custom candidates를 최종 inventory 검증에 전달한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-candidates-${Date.now()}`);
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  const seedSamplePath = path.join(outputDir, "seed-sample.json");
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  const outputInventoryPath = path.join(outputDir, "source-inventory.admitted.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(rawPath, `${JSON.stringify([{ railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" }])}\n`);

  const { stdout: sampleStdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--response",
      rawPath,
    ],
    { cwd: root },
  );
  await writeFile(seedSamplePath, sampleStdout);
  const sample = JSON.parse(sampleStdout);

  const stagedCandidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  resetCandidateForAdmissionTest(stagedCandidates, "kric-train-operation-organ");
  const tagoCandidate = stagedCandidates.candidates.find((entry) => entry.id === "molit-tago-subway-info");
  tagoCandidate.evidence.liveSampleEvidenceHash = sha256("staged-candidate-hash-mismatch");
  await writeFile(candidatesPath, `${JSON.stringify(stagedCandidates, null, 2)}\n`);

  const productionSource = {
    id: "kric-train-operation-organ",
    displayName: "열차운영기관정보",
    userDisplayName: "열차운영기관정보",
    owner: "국가철도공단",
    provider: "국가철도공단",
    sourceSystem: "KRIC OpenAPI",
    datasetUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266&service=convenientInfo&operation=trainOperationOrgan&page=3",
    requiredForProductionPack: false,
    updateFrequency: "provider-documented",
    observedDataUpdatedAt: "2026-07-02",
    retrievedAt: "2026-07-02",
    license: {
      type: "KOGL-1",
      name: "공공누리 1유형",
      attribution: "공공누리 제1유형: 출처표시",
      commercialUseAllowed: true,
      derivativeWorkAllowed: true,
      redistributionAllowed: true,
      evidenceUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266&service=convenientInfo&operation=trainOperationOrgan&page=3",
    },
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["seoul-metro"],
      sourceDomains: ["station_line_membership"],
    },
    fieldsProvided: ["railOprIsttCd", "railOprIsttNm"],
    capabilities: {
      schedule: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide scheduled timetable data",
      },
      realtime: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        liveEtaEligible: false,
        rateLimitStatus: "NOT_APPLICABLE",
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide realtime arrival data",
      },
      facility: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide accessibility facility records",
      },
    },
  };
  const adminReview = {
    schemaVersion: 1,
    artifactKind: "source-admission-admin-review",
    candidateId: "kric-train-operation-organ",
    sourceId: "kric-train-operation-organ",
    snapshotId: "kric-train-operation-organ-snapshot-20260702",
    sampleEvidenceHash: sample.evidenceHash,
    decision: "APPROVED",
    approvedBy: "qa-admin",
    approvedAt: "2026-07-02T00:10:00Z",
    licenseEvidenceHash: sha256("license-evidence"),
    aliasLedgerHash: sha256("alias-ledger"),
    operatorMappingLedgerHash: sha256("operator-mapping-ledger"),
    facilityEvidenceLedgerHash: sha256("facility-evidence-ledger"),
    routeEvidenceLedgerHash: sha256("route-evidence-ledger"),
    overrideHash: sha256("override-ledger"),
    quotaEvidence: {
      portal: "KRIC 레일포털",
      defaultDailyLimit: "unlimited",
      unlockStatus: "not_required",
      productionUseAllowed: true,
    },
    productionSource,
  };
  await writeFile(adminReviewPath, `${JSON.stringify(adminReview, null, 2)}\n`);
  await writeFile(outputInventoryPath, "preserved-final-inventory\n");

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--source-class-id",
        "static_network_metadata",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--source-updated-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-09-30T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        outputInventoryPath,
        "--output",
        path.join(outputDir, "admission-summary.json"),
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.admissionEvidence\.sampleEvidenceHash must be/,
  );
  assert.equal(await readFile(outputInventoryPath, "utf8"), "preserved-final-inventory\n");
  assert.deepEqual(
    (await readdir(outputDir)).filter((name) => name.startsWith(".source-inventory.admitted.json.")),
    [],
  );
});

test("source admission pipeline은 JSON credential raw response를 저장 전에 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-secret-${Date.now()}`);
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(rawPath, JSON.stringify({ response: { body: { serviceKey: "actual-secret" } } }));
  await writeFile(
    adminReviewPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "source-admission-admin-review",
        decision: "APPROVED",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--source-class-id",
        "static_network_metadata",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-09-30T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.admitted.json"),
        "--output",
        path.join(outputDir, "admission-summary.json"),
      ],
      { cwd: root },
    ),
    /source admission raw response contains credential-like token/,
  );
});

test("source admission pipeline은 live fetch 실패 메시지에서 service key를 숨긴다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-fetch-secret-${Date.now()}`);
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    adminReviewPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "source-admission-admin-review",
        decision: "APPROVED",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--url-template",
        "http://127.0.0.1:1/source?serviceKey={serviceKey}",
        "--service-key-env",
        "EASYSUBWAY_TEST_SERVICE_KEY",
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--source-class-id",
        "static_network_metadata",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-09-30T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.admitted.json"),
        "--output",
        path.join(outputDir, "admission-summary.json"),
      ],
      { cwd: root, env: { ...process.env, EASYSUBWAY_TEST_SERVICE_KEY: "actual-secret-value" } },
    ),
    (error) => {
      assert.match(error.stderr, /source live fetch failed before response/);
      assert.doesNotMatch(error.stderr, /actual-secret-value/);
      return true;
    },
  );
});

test("source admission pipeline은 admin 승인 없는 inventory admission을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-negative-${Date.now()}`);
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(rawPath, `${JSON.stringify([{ railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" }])}\n`);
  await writeFile(
    adminReviewPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "source-admission-admin-review",
        candidateId: "kric-train-operation-organ",
        sourceId: "kric-train-operation-organ",
        snapshotId: "kric-train-operation-organ-snapshot-20260702",
        sampleEvidenceHash: sha256("not-used"),
        decision: "PENDING",
        approvedBy: "qa-admin",
        approvedAt: "2026-07-02T00:10:00Z",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--source-class-id",
        "static_network_metadata",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-09-30T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.admitted.json"),
        "--output",
        path.join(outputDir, "admission-summary.json"),
      ],
      { cwd: root },
    ),
    /adminReview\.decision must be APPROVED/,
  );
});

test("전국 coverage target은 공식 snapshot의 현재 catalog 노선과 정확히 일치한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-target-lines-${Date.now()}`);
  const fixturePath = path.join(outputDir, "nationwide-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-molit-nationwide-fixture.mjs",
      "--csv", "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
      "--svg-csv", "tools/datapack/sources/molit-rail-station-svg-route-20250811.csv",
      "--kric-code-catalog", "tools/datapack/sources/kric-provider-code-catalog-20260228.json",
      "--seoulmetro-js", "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js",
      "--humetro-html", "tools/datapack/sources/humetro-cyberstation-map-20260623.html",
      "--humetro-css", "tools/datapack/sources/humetro-cyber-station-20250310c.css",
      "--grtc-html", "tools/datapack/sources/grtc-cyber-simple-20260623.html",
      "--dtro-html", "tools/datapack/sources/dtro-cyberstation-20260623.html",
      "--djtc-html", "tools/datapack/sources/djtc-cyberstation-20260623.html",
      "--djtc-css", "tools/datapack/sources/djtc-content-20260623.css",
      "--output", fixturePath,
    ],
    { cwd: root },
  );

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  for (const pack of fixture.packs) {
    const kricCodeCatalog = pack.sourceInventory.find(
      ({ id }) => id === "kric-provider-code-catalog-20260228",
    );
    assert.ok(kricCodeCatalog, `${pack.packId} KRIC provider code catalog source missing`);
    assert.equal(kricCodeCatalog.licenseStatus, "review-required");
    assert.equal(kricCodeCatalog.redistributionAllowed, false);
  }
  const compareCoverageLineScopes = (left, right) =>
    codepointCompare(`${left.regionId}:${left.operatorId}:${left.lineId}`, `${right.regionId}:${right.operatorId}:${right.lineId}`);
  assert.ok(Array.isArray(fixture.coverageLineOperatorScopes));
  assert.equal(fixture.coverageLineOperatorScopeSemantics, "UNION_OF_PACK_SCOPES");
  const packScopeUnion = [...new Map(
    fixture.packs
      .flatMap((pack) => pack.coverageLineOperatorScopes ?? [])
      .map((scope) => [`${scope.regionId}:${scope.operatorId}:${scope.lineId}`, scope]),
  ).values()].sort(compareCoverageLineScopes);
  assert.deepEqual(fixture.coverageLineOperatorScopes, packScopeUnion);
  assert.deepEqual(targets.inactiveLineExclusions, [
    {
      lineId: "line-cbe75f5287a1",
      operatorIds: ["operator-145e4415ee1f"],
      stationIds: ["station-04529af2869a", "station-4404e10fdfef", "station-ae2b5b5f2ea5", "station-bdd848e7e432", "station-f311bc307610", "station-fce26411d581"],
      preservedStationIds: ["station-fce26411d581"],
      status: "OUT_OF_ACTIVE_SCOPE",
      serviceLifecycle: "RETIRED",
      effectiveFrom: "2025-10-17",
      verifiedAt: "2026-07-13T00:00:00.000Z",
      reasonKo: "인천공항 자기부상철도는 도시철도 폐업 후 전용궤도시설로 전환되어 ACTIVE 도시철도 coverage 분모에서 제외한다.",
      evidenceRef: "source:incheon-maglev-track-facility-20251017",
    },
  ]);
  assert.deepEqual(targets.evidenceSources, [
    {
      id: "incheon-maglev-track-facility-20251017",
      publisher: "인천광역시",
      title: "3년의 멈춤을 넘어, 다시 달리는 인천공항 자기부상열차",
      publishedAt: "2025-10-17",
      url: "https://www.incheon.go.kr/IC010205/view?repSeq=DOM_0000000013303245",
    },
  ]);
  const inactiveLineIds = new Set(targets.inactiveLineExclusions.map(({ lineId }) => lineId));
  const expected = packScopeUnion
    .filter(({ lineId }) => !inactiveLineIds.has(lineId))
    .map(({ lineId, operatorId, regionId }) => ({ lineId, operatorId, regionId }))
    .sort(compareCoverageLineScopes);
  assert.equal(targets.schemaVersion, 2);
  assert.deepEqual(targets.railProductScope, {
    routeMapAndRouting: [
      {
        serviceId: "GTX_A",
        lineId: "line-8604048b6430",
        servicePattern: "LOCAL",
        representation: "ACTIVE_CAPITAL_LINE",
      },
      {
        serviceId: "ITX_CHEONGCHUN",
        lineId: "line-54a7b980b7c3",
        servicePattern: "EXPRESS",
        representation: "SERVICE_PATTERN_ON_EXISTING_LINE",
        operatingRoute: "GYEONGCHUN_LINE_ONLY",
        legacyDaejeonData: "REJECT",
        metropolitanRouteSearchCoverage: "CANONICAL_OD_STATIONS_IN_CAPITAL_METROPOLITAN_NETWORK",
        coverageContract: "tools/datapack/itx-cheongchun-coverage-contract.json",
        coverageStates: {
          station_line_membership: "SUPPORTED",
          route_graph_topology: "SUPPORTED",
          schedule_timetable: "MISSING",
        },
        supportClaimAllowed: false,
      },
    ],
    trainSearchOnly: {
      trackingIssue: 2094,
      routeMapProvided: false,
      exclusionContract: "release/product-gates/train-search-itx-exclusion-gate.json",
      services: ["KTX", "KTX_SANCHEON", "SRT", "ITX_MAUM", "ITX_SAEMAEUL", "SAEMAEUL", "MUGUNGHWA", "NURIRO"],
    },
  });
  assert.ok(Array.isArray(targets.activeLineScopes));
  const actual = targets.activeLineScopes
    .map(({ lineId, operatorId, regionId }) => ({ lineId, operatorId, regionId }))
    .sort(compareCoverageLineScopes);

  assert.ok(actual.every(({ lineId }) => !inactiveLineIds.has(lineId)));
  assert.equal(new Set(actual.map(({ lineId }) => lineId)).size, 36);
  assert.equal(actual.length, 45);
  assert.deepEqual(actual, expected);

  const providerScopes = fixture.providerLineScopes
    .filter(({ lineId }) => !inactiveLineIds.has(lineId))
    .map(({ lineId, operatorId, regionId }) => ({ lineId, operatorId, regionId }))
    .sort(compareCoverageLineScopes);
  assert.equal(fixture.providerLineScopes.length, 45);
  assert.deepEqual(providerScopes, expected);
  assert.deepEqual(
    fixture.providerLineScopes.find(({ lineId, operatorId }) => (
      lineId === "line-ab1a041f6266" && operatorId === "busan-transportation"
    )),
    {
      regionId: "busan",
      operatorId: "busan-transportation",
      lineId: "line-ab1a041f6266",
      mreaWideCd: "02",
      lnCd: "1",
      railOprIsttCd: "BS",
    },
  );
});

test("전국 coverage v2는 파일 경로를 공식 evidenceRef로 허용하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-invalid-evidence-ref-${Date.now()}`);
  const targetsPath = path.join(outputDir, "nationwide-coverage-targets.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  targets.inactiveLineExclusions[0].evidenceRef = "tools/route-map/route-map-single-source.test.mjs";
  await writeFile(targetsPath, `${JSON.stringify(targets, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", targetsPath,
        "--inventory", "tools/datapack/source-inventory.json",
        "--output", reportPath,
        "--allow-gaps",
      ],
      { cwd: root },
    ),
    /inactiveLineExclusions\.evidenceRef must use source:<id>/,
  );
});

test("공식 source ingest adapter는 stable id mapping으로 catalog fixture pack을 만든다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const generated = JSON.parse(await readFile(outputPath, "utf8"));
  const pack = generated.packs[0];
  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const facilityStatusRecord = provenance.packs[0].records.find(
    (record) => record.entityType === "facility" && record.field === "status",
  );
  assert.ok(facilityStatusRecord);
  const seoulMetroSource = pack.sourceInventory.find((source) => source.id === "seoulmetro-station-line-info");
  assert.equal(pack.artifactKind, "fixture");
  assert.equal(pack.sourceInventory.length, 2);
  assert.ok(seoulMetroSource);
  assert.equal(seoulMetroSource.licenseStatus, "redistributable");
  assert.deepEqual(seoulMetroSource.coverageScope, {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    sourceDomains: ["station_line_membership"],
  });
  assert.match(seoulMetroSource.updatedAt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00\.000Z$/);
  assert.deepEqual(
    pack.stations.map((station) => station.id),
    ["station-sangnoksu", "station-sadang"],
  );
  assert.deepEqual(
    pack.stationLines.map((stationLine) => `${stationLine.stationId}:${stationLine.lineId}`),
    ["station-sangnoksu:seoul-4", "station-sadang:seoul-4"],
  );
  assert.deepEqual(pack.networkEdges[0], {
    id: "edge-sangnoksu-sadang-seoul-4",
    fromNodeId: "station-sangnoksu:seoul-4",
    toNodeId: "station-sadang:seoul-4",
    durationSeconds: 1860,
    distanceMeters: 18600,
    edgeType: "RIDE",
    servicePattern: "EXPRESS",
    includesStairs: false,
    stairAccessState: "STEP_FREE",
    accessibilityStatus: "AVAILABLE",
    reliabilityScore: 90,
    sourceId: "seoulmetro-station-line-info",
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    lastVerifiedAt: "2026-06-21T00:00:00.000Z",
  });
  assert.deepEqual(pack.facilities[0], {
    id: "facility-sangnoksu-elevator-1",
    stationId: "station-sangnoksu",
    lineId: "seoul-4",
    exitId: null,
    type: "ELEVATOR",
    name: "상록수역 1번 승강기",
    status: "NORMAL",
    floorFrom: "B2",
    floorTo: "1F",
    description: "상록수역 승강장과 지상을 연결합니다.",
    sourceId: "seoulmetro-station-line-info",
    providerFacilityRef: "facility-sangnoksu-elevator-1",
    provenanceKind: "OFFICIAL_SOURCE",
    operationalStatus: "UNKNOWN",
    installationStatus: "UNKNOWN",
    derivationKind: "OFFICIAL",
  });
  assert.equal(facilityStatusRecord.derivationKind, "GENERATED");
});

test("공식 source ingest와 build provenance는 lineIds를 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-line-scope-provenance-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const fixturePath = path.join(outputDir, "catalog-fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  for (const source of inventory.sources.filter(({ id }) =>
    ["seoulmetro-station-line-info", "seoul-realtime-arrival-station-info"].includes(id))) {
    source.coverageScope.lineIds = ["seoul-4"];
  }
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory", inventoryPath,
      "--input", inputPath,
      "--output", fixturePath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const stationSource = fixture.packs[0].sourceInventory.find(
    ({ id }) => id === "seoulmetro-station-line-info",
  );
  assert.deepEqual(stationSource.coverageScope.lineIds, ["seoul-4"]);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );
  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const lineRecord = provenance.packs[0].records.find(
    (record) => record.entityType === "station_line" && record.field === "line",
  );
  assert.deepEqual(lineRecord.coverageScope.lineIds, ["seoul-4"]);
});

test("데이터팩 생성기는 line-scoped source와 행 노선이 불일치하면 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-line-scope-mismatch-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const fixturePath = path.join(outputDir, "catalog-fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory", "tools/datapack/source-inventory.json",
      "--input", inputPath,
      "--output", fixturePath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  fixture.packs[0].sourceInventory.find(
    ({ id }) => id === "seoulmetro-station-line-info",
  ).coverageScope.lineIds = ["seoul-2"];
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
      { cwd: root, env: productionEnv },
    ),
    /source coverageScope lineIds do not include record lineIds/,
  );
});

test("데이터팩 생성기는 SUBWAY EXPRESS edge provenance scope를 canonical station-line operator로 제한한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-provenance-service-pattern-scope-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  const pack = fixture.packs[0];
  pack.sourceInventory.find((source) => source.id === "seoulmetro-station-line-info").coverageScope.operatorIds = [
    "seoul-metro",
    "korail",
  ];
  assert.deepEqual({
    servicePattern: pack.networkEdges[0].servicePattern,
    fromNodeId: pack.networkEdges[0].fromNodeId,
    toNodeId: pack.networkEdges[0].toNodeId,
  }, {
    servicePattern: "EXPRESS",
    fromNodeId: "station-sangnoksu:seoul-4",
    toNodeId: "station-sadang:seoul-4",
  });
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const edgeRecord = provenance.packs[0].records.find(
    (record) =>
      record.entityType === "network_edge" &&
      record.entityId === "edge-sangnoksu-sadang-seoul-4" &&
      record.field === "network_edges",
  );
  assert.ok(edgeRecord);
  assert.deepEqual(edgeRecord.coverageScope.operatorIds, ["seoul-metro"]);
});

test("공식 source ingest adapter는 production schedule pass-through를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-schedule-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.serviceCalendars = [
    {
      serviceId: "weekday-2026",
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
      startDate: "20260701",
      endDate: "20261231",
    },
  ];

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /production transit schedule import requires sourced schedule provenance/,
  );
});

test("KRIC 4호선 pilot 시간표 transformer는 상록수-사당 stop_times를 production input에 주입한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-line4-pilot-schedule-${Date.now()}`);
  const artifactPath = path.join(outputDir, "kric-artifact.json");
  const outputPath = path.join(outputDir, "production-input.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const fixtureTrips = Array.from({ length: 458 }, (_, index) => {
    const isUp = index % 2 === 0;
    return {
      id: `route-seoul-4-${isUp ? "up" : "down"}-fixture-${index}`,
      routeId: isUp ? "route-seoul-4-up" : "route-seoul-4-down",
      serviceId: index < 250 ? "weekday-kric" : "holiday-kric",
      tripHeadsign: isUp ? "station-seoul-4-448" : "station-seoul-4-433",
      directionId: isUp ? "up" : "down",
      servicePattern: "LOCAL",
    };
  });
  const fixtureStopTimes = fixtureTrips.flatMap((trip, index) => {
    const isUp = trip.directionId === "up";
    const firstArrivalSeconds = 18000 + index * 60;
    return [
      {
        tripId: trip.id,
        stopSequence: 1,
        stationId: isUp ? "station-seoul-4-433" : "station-seoul-4-448",
        lineId: "seoul-4",
        arrivalSeconds: firstArrivalSeconds,
        departureSeconds: firstArrivalSeconds,
      },
      {
        tripId: trip.id,
        stopSequence: 2,
        stationId: isUp ? "station-seoul-4-448" : "station-seoul-4-433",
        lineId: "seoul-4",
        arrivalSeconds: firstArrivalSeconds + 2400,
        departureSeconds: firstArrivalSeconds + 2400,
      },
    ];
  });
  const fillerStopTimes = Array.from({ length: 21645 - fixtureStopTimes.length }, (_, index) => ({
    tripId: fixtureTrips[index % fixtureTrips.length].id,
    stopSequence: index + 1,
    stationId: `station-seoul-4-filler-${index}`,
    lineId: "seoul-4",
    arrivalSeconds: 18000 + index,
    departureSeconds: 18000 + index,
  }));
  const rawResponses = Array.from({ length: 153 }, (_, index) => {
    const bytes = Buffer.from(`response-${index}`);
    return {
      requestKey: `subwayTimetableExp|fixture-${index}`,
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      bodyBase64: bytes.toString("base64"),
    };
  });
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      artifactKind: "kric-line4-timetable-collection",
      sourceId: "kric-subway-timetable",
      lineId: "seoul-4",
      operation: "subwayTimetableExp",
      collectedAt: "2026-08-09T12:04:20.479Z",
      capturedAt: "2026-08-09",
      requestCount: 153,
      failedRequestCount: 0,
      expectedNoDataRequestCount: 51,
      intermediateRowCount: 32677,
      excludedOutsidePilotGroupCount: 415,
      excludedOutsidePilotGroups: Array.from({ length: 415 }, (_, index) => ({ reason: "OUTSIDE_PILOT_CORRIDOR", index })),
      excludedNonStopRowCount: 42,
      excludedNonStopRows: Array.from({ length: 42 }, (_, index) => ({ reason: "EXPRESS_NO_ARRIVAL", index })),
      reconstructionRowCount: 21645,
      transitTripCount: 458,
      transitStopTimeCount: 21645,
      rawResponseInventory: {
        responseCount: rawResponses.length,
        inventorySha256: createHash("sha256").update(JSON.stringify(rawResponses)).digest("hex"),
        responses: rawResponses,
      },
      transitTrips: fixtureTrips,
      transitStopTimes: [...fixtureStopTimes, ...fillerStopTimes],
    }, null, 2)}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-kric-line4-pilot-schedule.mjs",
      "--input",
      "tools/datapack/inputs/capital-pilot-production-source-input.json",
      "--artifact",
      artifactPath,
      "--output",
      outputPath,
    ],
    { cwd: root, env: productionEnv },
  );

  const transformed = JSON.parse(await readFile(outputPath, "utf8"));
  assert.ok(transformed.sourceIds.includes("kric-subway-timetable"));
  assert.equal(transformed.transitTrips.length, 458);
  assert.equal(transformed.transitStopTimes.length, 916);
  assert.deepEqual(
    transformed.transitStopTimes
      .filter((row) => row.tripId === "route-seoul-4-up-fixture-0")
      .map((row) => row.stationId),
    ["station-sadang", "station-sangnoksu"],
  );
  assert.deepEqual(
    transformed.transitStopTimes
      .filter((row) => row.tripId === "route-seoul-4-down-fixture-1")
      .map((row) => row.stationId),
    ["station-sangnoksu", "station-sadang"],
  );
  assert.deepEqual(transformed.transitFeedInfo, [{ feedEndDate: "20261231" }]);
  assert.deepEqual(
    transformed.serviceCalendars.find((calendar) => calendar.serviceId === "holiday-kric"),
    {
      serviceId: "holiday-kric",
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: true,
      sunday: true,
      startDate: "20260101",
      endDate: "20261231",
    },
  );
  assert.equal(transformed.scheduleProvenance.sourceId, "kric-subway-timetable");
  assert.match(transformed.scheduleProvenance.providerRecordHash, /^[a-f0-9]{64}$/);
  assert.equal(transformed.serviceCalendarDates.length, 28);
  assert.deepEqual(
    transformed.serviceCalendarDates.filter((row) => row.date === "20261225"),
    [
      { serviceId: "holiday-kric", date: "20261225", exceptionType: 1 },
      { serviceId: "weekday-kric", date: "20261225", exceptionType: 2 },
    ],
  );
});

test("KRIC 4호선 pilot 시간표 transformer는 summary counter만 복사된 부분 artifact를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-line4-truncated-schedule-${Date.now()}`);
  const artifactPath = path.join(outputDir, "kric-artifact.json");
  const outputPath = path.join(outputDir, "production-input.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      artifactKind: "kric-line4-timetable-collection",
      sourceId: "kric-subway-timetable",
      lineId: "seoul-4",
      operation: "subwayTimetableExp",
      capturedAt: "2026-07-09",
      requestCount: 153,
      failedRequestCount: 0,
      expectedNoDataRequestCount: 51,
      intermediateRowCount: 32677,
      excludedOutsidePilotGroupCount: 415,
      excludedNonStopRowCount: 42,
      reconstructionRowCount: 21645,
      transitTripCount: 458,
      transitStopTimeCount: 21645,
      transitTrips: [],
      transitStopTimes: [],
    }, null, 2)}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-kric-line4-pilot-schedule.mjs",
        "--input",
        "tools/datapack/inputs/capital-pilot-production-source-input.json",
        "--artifact",
        artifactPath,
        "--output",
        outputPath,
      ],
      { cwd: root, env: productionEnv },
    ),
    /KRIC pilot artifact transitTrips\.length mismatch: 0 !== 458/,
  );
});

test("KRIC 4호선 pilot 시간표 transformer는 부분 수집 artifact를 production input으로 승격하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-line4-partial-schedule-${Date.now()}`);
  const artifactPath = path.join(outputDir, "kric-artifact.json");
  const outputPath = path.join(outputDir, "production-input.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      artifactKind: "kric-line4-timetable-collection",
      sourceId: "kric-subway-timetable",
      lineId: "seoul-4",
      operation: "subwayTimetableExp",
      capturedAt: "2026-07-09",
      requestCount: 153,
      failedRequestCount: 1,
      intermediateRowCount: 33062,
      transitTripCount: 895,
      transitStopTimeCount: 33062,
      transitTrips: [],
      transitStopTimes: [],
    }, null, 2)}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-kric-line4-pilot-schedule.mjs",
        "--input",
        "tools/datapack/inputs/capital-pilot-production-source-input.json",
        "--artifact",
        artifactPath,
        "--output",
        outputPath,
      ],
      { cwd: root, env: productionEnv },
    ),
    /KRIC pilot artifact failedRequestCount mismatch: 1 !== 0/,
  );
});

test("공식 source ingest adapter는 명시한 lineSequence 경계 wrap만 허용한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-stop-times-wrap-${Date.now()}`);
  const input = sourceIngestInput();
  addSourceIngestStation(input, {
    sourceStationCode: "410",
    stationId: "station-loop-min",
    stationNameKo: "순환최소",
    stationCode: "410",
    lineSequence: 10,
  });
  addSourceIngestStation(input, {
    sourceStationCode: "420",
    stationId: "station-loop-next",
    stationNameKo: "순환다음",
    stationCode: "420",
    lineSequence: 20,
  });
  input.transitStopTimes = [
    {
      tripId: "trip-seoul-4-loop-wrap",
      stopSequence: 1,
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
      arrivalSeconds: 28800,
      departureSeconds: 28800,
    },
    {
      tripId: "trip-seoul-4-loop-wrap",
      stopSequence: 2,
      stationId: "station-loop-min",
      lineId: "seoul-4",
      arrivalSeconds: 29400,
      departureSeconds: 29400,
    },
    {
      tripId: "trip-seoul-4-loop-wrap",
      stopSequence: 3,
      stationId: "station-loop-next",
      lineId: "seoul-4",
      arrivalSeconds: 30000,
      departureSeconds: 30000,
    },
  ];

  await assert.rejects(
    importOfficialSourceInput(path.join(outputDir, "blocked"), input),
    /transit_stop_times stop_sequence must follow station lineSequence order: trip-seoul-4-loop-wrap/,
  );

  input.lines[0].lineSequenceWrapAllowed = true;
  const generated = await importTestOnlyAccessibilityFixture(outputDir, input);
  assert.equal(generated.packs[0].minimumTableRows.transit_stop_times, 3);
});

test("공식 source ingest adapter는 cross-line trip의 lineSequence를 노선 구간별로 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-cross-line-stop-times-${Date.now()}`);
  const input = sourceIngestInput();
  input.lines.push({
    ...input.lines[0],
    id: "line-branch",
    nameKo: "분기 노선",
    nameEn: "Branch Line",
  });
  for (const station of [
    { sourceStationCode: "501", stationId: "station-branch-1", stationNameKo: "분기1", lineSequence: 1 },
    { sourceStationCode: "502", stationId: "station-branch-2", stationNameKo: "분기2", lineSequence: 12 },
  ]) {
    input.stationMappings.push({
      sourceId: "seoulmetro-station-line-info",
      sourceStationCode: station.sourceStationCode,
      lineId: "line-branch",
      stationId: station.stationId,
      stationLineId: `${station.stationId}:line-branch`,
      mappingStatus: "active",
    });
    input.stationLineRows.push({
      ...input.stationLineRows[0],
      sourceStationCode: station.sourceStationCode,
      lineId: "line-branch",
      stationNameKo: station.stationNameKo,
      stationNameEn: station.stationNameKo,
      normalizedName: station.stationNameKo,
      stationCode: station.sourceStationCode,
      lineSequence: station.lineSequence,
    });
  }
  input.transitStopTimes = [
    { tripId: "trip-cross-line", stopSequence: 1, stationId: "station-sadang", lineId: "seoul-4", arrivalSeconds: 28800, departureSeconds: 28800 },
    { tripId: "trip-cross-line", stopSequence: 2, stationId: "station-sangnoksu", lineId: "seoul-4", arrivalSeconds: 29400, departureSeconds: 29400 },
    { tripId: "trip-cross-line", stopSequence: 3, stationId: "station-branch-1", lineId: "line-branch", arrivalSeconds: 30000, departureSeconds: 30000 },
    { tripId: "trip-cross-line", stopSequence: 4, stationId: "station-branch-2", lineId: "line-branch", arrivalSeconds: 30600, departureSeconds: 30600 },
  ];

  const generated = await importTestOnlyAccessibilityFixture(outputDir, input);
  assert.equal(generated.packs[0].minimumTableRows.transit_stop_times, 4);
});

test("공식 source ingest adapter는 cross-line EXPRESS summary edge도 격리 정책을 요구한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-cross-line-express-policy-${Date.now()}`);
  const input = productionSourceIngestInput();
  addSeoul2ProductionScope(input);
  addMolitStationMapping(input, {
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationId: "station-sadang",
  });
  addStationLineRow(input, {
    baseSourceStationCode: "MOLIT-SEOUL-4-433",
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationCode: "226",
    lineSequence: 29,
  });
  input.routeEdges = [
    {
      ...productionSummaryRideEdges()[0],
      id: "edge-cross-line-express-summary",
      sourceId: "molit-urban-rail-full-route",
      from: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
      },
      to: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-2-226",
        lineId: "seoul-2",
      },
      servicePattern: "EXPRESS",
      sourceSnapshotId: "molit-urban-rail-full-route-snapshot-20260621",
      providerRecordHash: sha256("provider:edge-cross-line-express-summary:molit-urban-rail-full-route"),
      evidenceHash: sha256("evidence:edge-cross-line-express-summary:molit-urban-rail-full-route:2026-06-21T00:00:00.000Z"),
    },
  ];
  delete input.routeGraphTopologyPolicy;

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /production routeEdges non-adjacent EXPRESS summary edge is fixture-only/,
  );
});

test("공식 source ingest adapter는 stop_times 순서가 lineSequence와 뒤섞이면 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-stop-times-sequence-${Date.now()}`);
  const input = sourceIngestInput();
  addSourceIngestStation(input, {
    sourceStationCode: "450",
    stationId: "station-jungang",
    stationNameKo: "중앙",
    stationCode: "450",
    lineSequence: 50,
  });
  addSourceIngestStation(input, {
    sourceStationCode: "451",
    stationId: "station-extra",
    stationNameKo: "추가",
    stationCode: "451",
    lineSequence: 60,
  });
  input.transitStopTimes = [
    {
      tripId: "trip-seoul-4-zigzag",
      stopSequence: 1,
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
      arrivalSeconds: 28800,
      departureSeconds: 28800,
    },
    {
      tripId: "trip-seoul-4-zigzag",
      stopSequence: 2,
      stationId: "station-sadang",
      lineId: "seoul-4",
      arrivalSeconds: 29400,
      departureSeconds: 29400,
    },
    {
      tripId: "trip-seoul-4-zigzag",
      stopSequence: 3,
      stationId: "station-jungang",
      lineId: "seoul-4",
      arrivalSeconds: 30000,
      departureSeconds: 30000,
    },
  ];

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /transit_stop_times stop_sequence must follow station lineSequence order: trip-seoul-4-zigzag/,
  );
});

test("공식 source ingest adapter는 admission 전 schedule provenance도 production 적재하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-schedule-candidate-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.sourceIds.push("molit-tago-subway-info");
  input.scheduleProvenance = {
    sourceId: "molit-tago-subway-info",
    sourceSnapshotId: "molit-tago-subway-info-snapshot-20260702",
    providerRecordHash: sha256("provider:molit-tago-subway-info:schedule:20260702"),
    evidenceHash: sha256("evidence:molit-tago-subway-info:schedule:20260702"),
    retrievedAt: "2026-07-02T00:00:00.000Z",
  };
  input.serviceCalendars = [
    {
      serviceId: "weekday-2026",
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
      startDate: "20260701",
      endDate: "20261231",
    },
  ];

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /scheduleProvenance source is not a schedule_timetable source: molit-tago-subway-info/,
  );
});

test("공식 source ingest adapter는 quota 미승인 schedule source를 production 적재하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-schedule-quota-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.sourceIds.push("molit-tago-subway-info");
  input.stationMappings.push({
    sourceId: "molit-tago-subway-info",
    sourceStationCode: "448",
    lineId: "seoul-4",
    stationId: "station-sangnoksu",
    stationLineId: "station-sangnoksu:seoul-4",
    mappingStatus: "active",
  });
  input.stationLineRows.push({
    ...input.stationLineRows[0],
    sourceId: "molit-tago-subway-info",
    sourceStationCode: "448",
  });
  input.coverageEvidence.push({
    regionId: "capital",
    operatorId: "seoul-metro",
    sourceDomain: "schedule_timetable",
    sourceIds: ["molit-tago-subway-info"],
    evidence: "TAGO schedule admission quota gate regression",
  });
  input.scheduleProvenance = {
    sourceId: "molit-tago-subway-info",
    sourceSnapshotId: "molit-tago-subway-info-snapshot-20260704",
    providerRecordHash: sha256("provider:molit-tago-subway-info:schedule:20260704"),
    evidenceHash: sha256("evidence:molit-tago-subway-info:schedule:20260704"),
    retrievedAt: "2026-07-04T00:00:00.000Z",
  };
  input.serviceCalendars = [
    {
      serviceId: "weekday-2026",
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
      startDate: "20260701",
      endDate: "20261231",
    },
  ];

  const inventoryPath = path.join(tmpdir(), `easysubway-source-inventory-schedule-quota-${Date.now()}.json`);
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const tago = inventory.sources.find((source) => source.id === "molit-tago-subway-info");
  tago.coverageScope.sourceDomains.push("schedule_timetable");
  tago.capabilities.schedule.status = "SUPPORTED";
  tago.capabilities.schedule.productionUseAllowed = true;
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  inventory.sources.push(JSON.parse(await readFile(await testOnlyInventoryPath(outputDir), "utf8")).sources.find(
    ({ id }) => id === TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
  ));
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    importOfficialSourceInput(outputDir, input, inventoryPath),
    /scheduleProvenance source quota does not allow production schedule use: molit-tago-subway-info/,
  );
});

test("TAGO 시간표 sample validator는 station-level row shape만 검증하고 production 승격은 막는다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-sample-${Date.now()}.json`);
  const rawSample = `${JSON.stringify({
    response: {
      body: {
        items: {
          item: [
            {
              endSubwayStationNm: "당고개",
              subwayRouteId: "MTRKR4",
              subwayStationId: "MTRKR4448",
              subwayStationNm: "상록수",
              dailyTypeCode: "01",
              upDownTypeCode: "U",
              depTime: "080500",
              arrTime: "080500",
              endSubwayStationId: "MTRKR4409",
            },
            {
              endSubwayStationNm: "당고개",
              subwayRouteId: "MTRKR4",
              subwayStationId: "MTRKR4448",
              subwayStationNm: "상록수",
              dailyTypeCode: "01",
              upDownTypeCode: "U",
              depTime: "081200",
              arrTime: "081200",
              endSubwayStationId: "MTRKR4409",
            },
          ],
        },
      },
    },
  })}\n`;
  await writeFile(samplePath, rawSample);

  const { stdout } = await execFileAsync(
    process.execPath,
    ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
    { cwd: root, env: productionEnv },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.candidateId, "molit-tago-subway-info");
  assert.equal(report.rowCount, 2);
  assert.equal(report.stationLevelOnly, true);
  assert.equal(report.productionUseAllowed, false);
  assert.equal(report.rawSha256, sha256(rawSample));
  assert.equal(report.remainingAdmissionBlocker, "line_wide_trip_stop_sequence_validation_required");
  assert.deepEqual(
    report.departures.map((departure) => departure.departureSeconds),
    [29100, 29520],
  );
});

test("TAGO 시간표 sample validator는 잘못된 시간 row를 거부한다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-invalid-${Date.now()}.json`);
  await writeFile(samplePath, JSON.stringify({
    response: {
      body: {
        items: {
          item: {
            endSubwayStationNm: "당고개",
            subwayRouteId: "MTRKR4",
            subwayStationId: "MTRKR4448",
            subwayStationNm: "상록수",
            dailyTypeCode: "01",
            upDownTypeCode: "U",
            depTime: "080500",
            arrTime: "080700",
            endSubwayStationId: "MTRKR4409",
          },
        },
      },
    },
  }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
      { cwd: root, env: productionEnv },
    ),
    /arrival must be <= departure/,
  );
});

test("TAGO 시간표 sample validator는 JSON serviceKey credential을 거부한다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-secret-${Date.now()}.json`);
  await writeFile(samplePath, JSON.stringify({
    serviceKey: "secret",
    response: {
      body: {
        items: {
          item: {
            endSubwayStationNm: "당고개",
            subwayRouteId: "MTRKR4",
            subwayStationId: "MTRKR4448",
            subwayStationNm: "상록수",
            dailyTypeCode: "01",
            upDownTypeCode: "U",
            depTime: "080500",
            arrTime: "080500",
            endSubwayStationId: "MTRKR4409",
          },
        },
      },
    },
  }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
      { cwd: root, env: productionEnv },
    ),
    /serviceKey credentials/,
  );
});

test("TAGO 시간표 sample validator는 destination field가 sample 전체에서 사라지면 거부한다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-missing-destination-${Date.now()}.json`);
  await writeFile(samplePath, JSON.stringify({
    response: {
      body: {
        items: {
          item: {
            subwayRouteId: "MTRKR4",
            subwayStationId: "MTRKR4448",
            subwayStationNm: "상록수",
            dailyTypeCode: "01",
            upDownTypeCode: "U",
            depTime: "080500",
            arrTime: "080500",
          },
        },
      },
    },
  }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
      { cwd: root, env: productionEnv },
    ),
    /missing observed field: endSubwayStationNm/,
  );
});

test("TAGO 시간표 sample validator는 함수 import만으로 CLI를 실행하지 않는다", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { validateTagoScheduleSample } from './tools/datapack/validate-tago-schedule-sample.mjs'; console.log(typeof validateTagoScheduleSample);",
    ],
    { cwd: root, env: productionEnv },
  );
  assert.equal(stdout.trim(), "function");
});

test("TAGO 시간표 sample validator는 duplicate serviceKey credential을 거부한다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-duplicate-secret-${Date.now()}.json`);
  await writeFile(
    samplePath,
    `{
      "serviceKey": "actual-secret",
      "serviceKey": "[서비스키값]",
      "response": {
        "body": {
          "items": {
            "item": {
              "endSubwayStationNm": "당고개",
              "subwayRouteId": "MTRKR4",
              "subwayStationId": "MTRKR4448",
              "subwayStationNm": "상록수",
              "dailyTypeCode": "01",
              "upDownTypeCode": "U",
              "depTime": "080500",
              "arrTime": "080500",
              "endSubwayStationId": "MTRKR4409"
            }
          }
        }
      }
    }`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
      { cwd: root, env: productionEnv },
    ),
    /serviceKey credentials/,
  );
});

test("공식 source ingest adapter는 station-line 단위 facility evidence coverage를 요구한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-facility-line-coverage-${Date.now()}`);
  const input = productionSourceIngestInput();
  addSeoul2ProductionScope(input);
  addMolitStationMapping(input, {
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationId: "station-sadang",
  });
  addStationLineRow(input, {
    baseSourceStationCode: "MOLIT-SEOUL-4-433",
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationCode: "226",
    lineSequence: 26,
    platformInfo: "내선순환 / 외선순환",
  });

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /production facility evidence missing: station-sadang:seoul-2:ELEVATOR/,
  );
});

test("공식 source ingest adapter는 동일 station-line-type 시설을 evidence row 하나로 집계한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-duplicate-facility-evidence-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.facilityRows.push({
    ...input.facilityRows.find((row) => row.id === "facility-sadang-elevator-kric-1"),
    id: "facility-sadang-elevator-kric-2",
    name: "사당 엘리베이터 설치 정보 2",
    providerFacilityRef: "facility-sadang-elevator-kric-2",
    providerRecordHash: sha256(`provider:facility-sadang-elevator-kric-2:${TEST_PRODUCTION_ACCESSIBILITY_SOURCE}`),
    evidenceHash: sha256(`evidence:facility-sadang-elevator-kric-2:${TEST_PRODUCTION_ACCESSIBILITY_SOURCE}:2026-06-22T00:00:00.000Z`),
  });

  const generated = await importTestOnlyAccessibilityFixture(outputDir, input);
  assert.equal(generated.packs[0].facilities.length, 7);
  assert.equal(generated.packs[0].stationFacilityEvidence.length, 6);
  assert.deepEqual(
    generated.packs[0].stationFacilityEvidence
      .filter(
        (row) =>
          row.stationId === "station-sadang" &&
          row.lineId === "seoul-4" &&
          row.facilityType === "ELEVATOR",
      )
      .map(({ stationId, lineId, facilityType, sourceId, strictRouteEligible, strictRouteEligibleReason }) => ({
        stationId,
        lineId,
        facilityType,
        sourceId,
        strictRouteEligible,
        strictRouteEligibleReason,
      })),
    [
      {
        stationId: "station-sadang",
        lineId: "seoul-4",
        facilityType: "ELEVATOR",
        sourceId: TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
        strictRouteEligible: false,
        strictRouteEligibleReason: "OPERATION_STATUS_UNKNOWN",
      },
    ],
  );
});

test("공식 source ingest adapter는 stationLineRows 없는 facility evidence mapping을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-facility-missing-station-line-${Date.now()}`);
  const input = productionSourceIngestInput();
  addSeoul2ProductionScope(input);
  addMolitStationMapping(input, {
    sourceStationCode: "MOLIT-SEOUL-2-999",
    stationId: "station-sangnoksu",
  });
  addMolitStationMapping(input, {
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationId: "station-sadang",
  });
  addStationLineRow(input, {
    baseSourceStationCode: "MOLIT-SEOUL-4-448",
    sourceStationCode: "MOLIT-SEOUL-2-999",
    stationCode: "999",
    lineSequence: 99,
  });
  addRequiredFacilityRowsForStationLine(input, {
    baseSourceStationCode: "MOLIT-SEOUL-4-448",
    sourceStationCode: "MOLIT-SEOUL-2-999",
    idPrefix: "facility-sangnoksu-seoul-2",
  });
  input.facilityRows.push({
    ...input.facilityRows.find((row) => row.id === "facility-sadang-elevator-kric-1"),
    id: "facility-sadang-seoul-2-elevator",
    station: {
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-2-226",
      lineId: "seoul-2",
    },
    providerFacilityRef: "facility-sadang-seoul-2-elevator",
    providerRecordHash: sha256("provider:facility-sadang-seoul-2-elevator:kric-station-elevator"),
    evidenceHash: sha256("evidence:facility-sadang-seoul-2-elevator:kric-station-elevator:2026-06-22T00:00:00.000Z"),
  });

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /production facility evidence station-line missing: station-sadang:seoul-2:ELEVATOR:facility-sadang-seoul-2-elevator/,
  );
});

test("AVAILABLE ENTRY edge rejects station-line source provenance", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-station-source-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  // AVAILABLE ENTRY edge가 accessibility_facilities 미지원 source(역-노선 정보)면 거부된다.
  const availableEntry = input.routeEdges.find((edge) => edge.id === "edge-entry-sadang-seoul-4");
  availableEntry.accessibilityStatus = "AVAILABLE";
  availableEntry.sourceId = "seoulmetro-station-line-info";
  availableEntry.sourceSnapshotId = "seoulmetro-station-line-info-snapshot-20260621";

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /AVAILABLE ENTRY\/EXIT edge requires accessibility_facilities source/,
  );
});

test("AVAILABLE ENTRY edge rejects missing strict operational facility evidence", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-facility-evidence-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  useAccessibilitySourceForAvailableEdge(input, "edge-entry-sadang-seoul-4");

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /AVAILABLE ENTRY\/EXIT edge requires strict-eligible operational facility evidence/,
  );
});

test("AVAILABLE ENTRY edge rejects missing approved movement pathway", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-approved-pathway-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  useAccessibilitySourceForAvailableEdge(input, "edge-entry-sadang-seoul-4");
  const facility = input.facilityRows.find((row) =>
    row.station.sourceStationCode === "MOLIT-SEOUL-4-433" && row.type === "ELEVATOR");
  assert.ok(facility);
  facility.status = "NORMAL";
  facility.operationalStatus = "AVAILABLE";
  facility.statusMeaning = "OPERATOR_CONFIRMED";

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /AVAILABLE ENTRY\/EXIT edge requires approved movement pathway/,
  );
});

test("UNDER_MAINTENANCE ENTRY edge는 실측 보수중 시설 증거 없이는 거부된다 (#1996)", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-maintenance-missing-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  for (const edge of input.routeEdges.filter((row) => row.id.includes("sadang-seoul-4"))) {
    edge.accessibilityStatus = "UNDER_MAINTENANCE";
    edge.stairAccessState = "STEP_FREE";
    edge.verificationStatus = "VERIFIED";
  }
  input.accessibilityStatusEvidence = input.accessibilityStatusEvidence.filter(
    (row) => row.stationId !== "station-sadang" || row.facilityType !== "ACCESSIBILITY_STATUS_PROBE",
  );

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /UNDER_MAINTENANCE ENTRY\/EXIT edge requires field-verified maintenance facility evidence/,
  );
});

test("NO_OFFICIAL_FEED ENTRY edge는 피드 부재 기록 증거 없이는 거부된다 (#1996)", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-nofeed-missing-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  for (const edge of input.routeEdges.filter((row) => row.id.includes("sangnoksu-seoul-4"))) {
    edge.accessibilityStatus = "NO_OFFICIAL_FEED";
    edge.stairAccessState = "STEP_FREE";
    edge.verificationStatus = "VERIFIED";
  }
  input.accessibilityStatusEvidence = input.accessibilityStatusEvidence.filter(
    (row) => row.stationId !== "station-sangnoksu" || row.facilityType !== "ACCESSIBILITY_STATUS_PROBE",
  );

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /NO_OFFICIAL_FEED ENTRY\/EXIT edge requires recorded absence-of-feed evidence/,
  );
});

test("NO_OFFICIAL_FEED ENTRY edge는 NOT_EXISTS이나 statusMeaning이 FEED_ABSENCE_RECORD가 아니면 거부된다 (#1998)", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-nofeed-statusmeaning-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  // 상록수 NO_OFFICIAL_FEED probe는 NOT_EXISTS로 남기되 statusMeaning을 피드 부재 기록이 아닌 값(시설 물리
  // 부재)으로 변조 → 임의 NOT_EXISTS로는 피드 부재 커버리지를 채울 수 없어야 하므로 검증 실패해야 한다.
  for (const edge of input.routeEdges.filter((row) => row.id.includes("sangnoksu-seoul-4"))) {
    edge.accessibilityStatus = "NO_OFFICIAL_FEED";
    edge.stairAccessState = "STEP_FREE";
    edge.verificationStatus = "VERIFIED";
  }
  const probe = input.accessibilityStatusEvidence.find(
    (row) => row.stationId === "station-sangnoksu" && row.facilityType === "ACCESSIBILITY_STATUS_PROBE",
  );
  assert.equal(probe.evidenceKind, "NOT_EXISTS");
  probe.statusMeaning = "FACILITY_PHYSICALLY_ABSENT";
  probe.operationalStatus = "NOT_INSTALLED";

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /NO_OFFICIAL_FEED ENTRY\/EXIT edge requires recorded absence-of-feed evidence/,
  );
});

test("공식 source ingest adapter는 임의 strict route reason을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-strict-reason-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  input.accessibilityStatusEvidence[0].strictRouteEligibleReason = "ARBITRARY_REASON";

  await assert.rejects(
    importTestOnlyAccessibilityFixture(outputDir, input),
    /accessibilityStatusEvidence.strictRouteEligibleReason is not allowed: ARBITRARY_REASON/,
  );
});

test("NO_OFFICIAL_FEED edge는 EXISTS status probe와 결합되면 UNKNOWN으로 정규화된다 (#2609)", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-contradictory-feed-${Date.now()}`);
  const fixture = await importTestOnlyAccessibilityFixture(outputDir, await capitalPilotProductionSourceInput());
  const probe = fixture.packs[0].stationFacilityEvidence.find(
    (row) => row.stationId === "station-sangnoksu" && row.facilityType === "ACCESSIBILITY_STATUS_PROBE",
  );
  assert.equal(probe.evidenceKind, "NOT_EXISTS");
  probe.evidenceKind = "EXISTS";
  normalizeUnverifiedNetworkEdgeStates(fixture.packs[0]);
  assert.equal(
    fixture.packs[0].networkEdges.find(({ id }) => id === "edge-entry-sangnoksu-seoul-4").accessibilityStatus,
    "UNKNOWN",
  );
});

// #979: 작업 트리의 승격 원천을 읽는 route graph 검사는 현재 contract 기준으로 ITX pin을 다시 계산한 임시 spec을 쓴다(커밋된 spec은 건드리지 않는다).
async function writeCurrentItxBoundBuildSpec(directory) {
  const committed = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  const specPath = path.join(directory, "current-itx-bound-build-spec.json");
  await writeFile(specPath, `${JSON.stringify(await bindBuildSpecToCurrentItx(committed, root), null, 2)}\n`);
  return specPath;
}

test("수도권 pilot fixture는 source import를 검증하지만 production route coverage로 승격하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-capital-pilot-production-source-${Date.now()}`);
  const inputPath = "tools/datapack/inputs/capital-pilot-production-source-input.json";
  const importedFixturePath = path.join(outputDir, "capital-pilot-production.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const inventoryPath = await testOnlyInventoryPath(outputDir);
  const input = withTestProductionAccessibility(JSON.parse(await readFile(path.join(root, inputPath), "utf8")));
  assert.equal(input.manifest.releaseSequence, undefined);
  assert.equal(input.manifest.publishedAt, undefined);
  assert.equal(input.manifest.expiresAt, undefined);
  assert.deepEqual(input.routeEdges.filter((edge) => edge.edgeType === "RIDE"), []);
  assert.equal(input.routeGraphTopologyPolicy, undefined);
  const adjacencySafeInput = input;
  const adjacencySafeInputPath = path.join(outputDir, "capital-pilot-production-adjacency-safe.json");
  await writeFile(adjacencySafeInputPath, `${JSON.stringify(adjacencySafeInput, null, 2)}\n`);

  const summaryRideFixtureOnlyInput = withProductionSummaryRideEdges(input);
  const summaryRideFixtureOnlyInputPath = path.join(outputDir, "summary-ride-fixture-only.json");
  await writeFile(summaryRideFixtureOnlyInputPath, `${JSON.stringify(summaryRideFixtureOnlyInput, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        summaryRideFixtureOnlyInputPath,
        "--output",
        path.join(outputDir, "summary-ride-fixture-only-output.json"),
      ],
      { cwd: root },
    ),
    /production routeEdges non-adjacent EXPRESS summary edge is fixture-only/,
  );

  const lowercaseRideEdgeInput = JSON.parse(JSON.stringify(withProductionSummaryRideEdges(input)));
  lowercaseRideEdgeInput.routeEdges = lowercaseRideEdgeInput.routeEdges.map((edge) =>
    edge.edgeType === "RIDE" ? { ...edge, edgeType: "ride" } : edge,
  );
  const lowercaseRideEdgeInputPath = path.join(outputDir, "lowercase-ride-summary-policy.json");
  await writeFile(lowercaseRideEdgeInputPath, `${JSON.stringify(lowercaseRideEdgeInput, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        lowercaseRideEdgeInputPath,
        "--output",
        path.join(outputDir, "lowercase-ride-summary-policy-fixture.json"),
      ],
      { cwd: root },
    ),
    /production routeEdges non-adjacent EXPRESS summary edge is fixture-only/,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      inventoryPath,
      "--input",
      adjacencySafeInputPath,
      "--output",
      importedFixturePath,
    ],
    { cwd: root },
  );
  const importedFixture = JSON.parse(await readFile(importedFixturePath, "utf8"));
  assert.equal(importedFixture.packs[0].requiredTables.includes("route_map_positions"), false);
  assert.equal(Object.hasOwn(importedFixture.packs[0].minimumTableRows, "route_map_positions"), false);
  assert.deepEqual(importedFixture.packs[0].routeMapPositions, []);
  assert.equal(importedFixture.packs[0].sourceInventory.some(
    ({ id }) => id === "seoulmetro-cyberstation-route-map"), false);
  const scheduleScopeFixture = JSON.parse(JSON.stringify(importedFixture));
  scheduleScopeFixture.packs[0].sourceInventory.find(
    (source) => source.id === "kric-subway-timetable",
  ).coverageScope.operatorIds = ["seoul-metro", "korail"];
  const scheduleScopeFixturePath = path.join(outputDir, "schedule-scope-fixture.json");
  const scheduleScopePackDir = path.join(outputDir, "schedule-scope-pack");
  await writeFile(scheduleScopeFixturePath, `${JSON.stringify(scheduleScopeFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      scheduleScopeFixturePath,
      "--output",
      scheduleScopePackDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const scheduleScopeProvenance = JSON.parse(
    await readFile(path.join(scheduleScopePackDir, "current.provenance.json"), "utf8"),
  );
  const serviceCalendarRecord = scheduleScopeProvenance.packs[0].records.find(
    (record) =>
      record.sourceId === "kric-subway-timetable" &&
      record.entityType === "service_calendar" &&
      record.field === "service_calendar",
  );
  assert.ok(serviceCalendarRecord);
  assert.deepEqual(serviceCalendarRecord.coverageScope.operatorIds, ["seoul-metro"]);

  const scheduleExtrasInput = JSON.parse(JSON.stringify(adjacencySafeInput));
  scheduleExtrasInput.serviceCalendarDates = [
    {
      serviceId: "holiday-kric",
      date: "20260101",
      exceptionType: 1,
    },
  ];
  scheduleExtrasInput.transitFrequencies = [
    {
      tripId: scheduleExtrasInput.transitTrips[0].id,
      startTimeSeconds: 18000,
      endTimeSeconds: 21600,
      headwaySeconds: 600,
      exactTimes: false,
    },
  ];
  const scheduleExtrasInputPath = path.join(outputDir, "schedule-extras-input.json");
  const scheduleExtrasFixturePath = path.join(outputDir, "schedule-extras-fixture.json");
  const scheduleExtrasPackDir = path.join(outputDir, "schedule-extras-pack");
  await writeFile(scheduleExtrasInputPath, `${JSON.stringify(scheduleExtrasInput, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      inventoryPath,
      "--input",
      scheduleExtrasInputPath,
      "--output",
      scheduleExtrasFixturePath,
    ],
    { cwd: root },
  );
  const scheduleExtrasFixture = JSON.parse(await readFile(scheduleExtrasFixturePath, "utf8"));
  assert.equal(scheduleExtrasFixture.packs[0].serviceCalendarDates[0].sourceId, "kric-subway-timetable");
  assert.equal(scheduleExtrasFixture.packs[0].transitFrequencies[0].sourceId, "kric-subway-timetable");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      scheduleExtrasFixturePath,
      "--output",
      scheduleExtrasPackDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const scheduleExtrasProvenance = JSON.parse(
    await readFile(path.join(scheduleExtrasPackDir, "current.provenance.json"), "utf8"),
  );
  const scheduleExtraKricRecords = scheduleExtrasProvenance.packs[0].records.filter(
    (record) => record.sourceId === "kric-subway-timetable",
  );
  assert.ok(
    scheduleExtraKricRecords.some(
      (record) => record.entityType === "service_calendar_date" && record.field === "calendar_date",
    ),
  );
  assert.ok(
    scheduleExtraKricRecords.some(
      (record) => record.entityType === "transit_frequency" && record.field === "frequency",
    ),
  );
  for (const testCase of [
    {
      name: "string-label-dx",
      mutate(position) {
        position.labelDx = "0";
      },
      expected: /routeMapPositions\.labelDx must be an integer/,
    },
    {
      name: "number-up-path",
      mutate(position) {
        position.upPath = 1;
      },
      expected: /routeMapPositions\.upPath must be a string/,
    },
  ]) {
    const invalidRouteMapPositionInput = sourceIngestInput();
    invalidRouteMapPositionInput.sourceIds.push("seoul-metro-route-map-positions");
    invalidRouteMapPositionInput.routeMapPositions = [testPublicRouteMapPosition()];
    testCase.mutate(invalidRouteMapPositionInput.routeMapPositions[0]);
    const invalidRouteMapPositionInputPath = path.join(outputDir, `${testCase.name}-input.json`);
    const invalidRouteMapPositionOutputPath = path.join(outputDir, `${testCase.name}-fixture.json`);
    await writeFile(invalidRouteMapPositionInputPath, `${JSON.stringify(invalidRouteMapPositionInput, null, 2)}\n`);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        invalidRouteMapPositionInputPath,
          "--output",
          invalidRouteMapPositionOutputPath,
        ],
        { cwd: root },
      ),
      testCase.expected,
    );
  }

  const nonAdjacentInput = {
    ...input,
    routeEdges: [...productionSummaryRideEdges("LOCAL"), ...input.routeEdges],
  };
  const nonAdjacentInputPath = path.join(outputDir, "non-adjacent-local-ride-input.json");
  const nonAdjacentFixturePath = path.join(outputDir, "non-adjacent-local-ride.json");
  await writeFile(nonAdjacentInputPath, `${JSON.stringify(nonAdjacentInput, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        nonAdjacentInputPath,
        "--output",
        nonAdjacentFixturePath,
      ],
      { cwd: root },
    ),
    /production routeEdges LOCAL RIDE edge must connect adjacent station-line sequences/,
  );

  const missingFacilityInputPath = path.join(outputDir, "capital-pilot-production-missing-facility.json");
  await writeFile(
    missingFacilityInputPath,
    `${JSON.stringify(
      {
        ...adjacencySafeInput,
        facilityRows: [],
      },
      null,
      2,
    )}\n`,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      inventoryPath,
      "--input",
      missingFacilityInputPath,
        "--output",
        path.join(outputDir, "missing-facility.json"),
      ],
      { cwd: root },
    ),
    /selected production source has no row provenance: test-only-capital-accessibility-fixture/,
  );

  const missingWheelchairLiftEvidenceInputPath = path.join(
    outputDir,
    "capital-pilot-production-missing-wheelchair-lift-evidence.json",
  );
  await writeFile(
    missingWheelchairLiftEvidenceInputPath,
    `${JSON.stringify(
      {
        ...adjacencySafeInput,
        accessibilityStatusEvidence: adjacencySafeInput.accessibilityStatusEvidence.filter((row) =>
          row.stationId !== "station-sadang" || row.facilityType !== "WHEELCHAIR_LIFT"),
      },
      null,
      2,
    )}\n`,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      inventoryPath,
      "--input",
      missingWheelchairLiftEvidenceInputPath,
        "--output",
        path.join(outputDir, "missing-wheelchair-lift-evidence.json"),
      ],
      { cwd: root },
    ),
    /production facility evidence missing: station-sadang:seoul-4:WHEELCHAIR_LIFT/,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      importedFixturePath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const routeGraphTopologyReportPath = path.join(outputDir, "route-graph-topology-report.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-route-graph-topology-report.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
      "--build-spec",
      await writeCurrentItxBoundBuildSpec(outputDir),
      "--output",
      routeGraphTopologyReportPath,
    ],
    { cwd: root },
  );
  const routeGraphTopologyReport = JSON.parse(await readFile(routeGraphTopologyReportPath, "utf8"));
  assert.equal(routeGraphTopologyReport.artifactKind, "route-graph-topology-report");
  assert.equal(routeGraphTopologyReport.channel, "dev");
  assert.equal(routeGraphTopologyReport.packs[0].artifactKind, "fixture");
  assert.equal(routeGraphTopologyReport.summary.disconnectedNodeCount, 2);
  assert.equal(routeGraphTopologyReport.summary.unreachableDirectedPairCount, 2);

  // #2609 source governance 완료만으로 route availability를 추정하지 않는다. #2611 전수 평가와 #2612 strict
  // fail-closed가 닫힐 때까지 production route coverage는 명시적으로 NO_GO다.
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--root",
        packOutputDir,
        "--require-production",
        "--legacy-fixture-production", // #873: fixture 빌드 legacy 팩(후보 provenance 없음). PR-D(#866)에서 제거
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 remote publish requires production artifactKind/,
  );

  const coverageReportPath = path.join(outputDir, "capital-pilot-coverage-summary.json");
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/capital-pilot-coverage-targets.json",
        "--inventory",
        path.join(outputDir, "test-only-source-inventory.json"),
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--provenance",
        path.join(packOutputDir, "current.provenance.json"),
        "--output",
        coverageReportPath,
        "--allow-gaps",
      ],
      { cwd: root },
    ),
    /capital@1 active field provenance pack must be production/,
  );

  const manifest = JSON.parse(await readFile(path.join(packOutputDir, "current.json"), "utf8"));
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.channel, "dev");
  assert.equal(manifest.keyId, "production-v1");
  assert.deepEqual(manifest.activePack, { id: "capital", version: "1" });
  assert.equal(Number.isInteger(manifest.releaseSequence), true);
  assert.ok(Date.parse(manifest.expiresAt) > Date.parse(manifest.publishedAt));
  assert.equal(manifest.signature.algorithm, "sha256-manifest-v2");
  assert.equal(manifest.packs[0].artifactKind, "fixture");
  assert.equal(manifest.packs[0].signature.algorithm, "sha256-pack-manifest-v2");
  assert.equal(manifest.packs[0].routeRegressionScope, undefined);
  assert.deepEqual(manifest.packs[0].representativeRouteRegressions, []);
  const database = new DatabaseSync(path.join(packOutputDir, "catalog", "capital-v1.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare(`
          SELECT id, accessibility_status
          FROM network_edges
          WHERE edge_type IN ('ENTRY', 'EXIT')
          ORDER BY id
        `)
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: "edge-entry-sadang-seoul-4",
          accessibility_status: "UNKNOWN",
        },
        {
          id: "edge-entry-sangnoksu-seoul-4",
          accessibility_status: "NO_OFFICIAL_FEED",
        },
        {
          id: "edge-exit-sadang-seoul-4",
          accessibility_status: "UNKNOWN",
        },
        {
          id: "edge-exit-sangnoksu-seoul-4",
          accessibility_status: "NO_OFFICIAL_FEED",
        },
      ],
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM service_calendars").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM service_calendar_dates").get().count, 28);
    // #862: 4호선 pilot 운행·정차 수는 QA 승인(2026-10-01) 시각표를 반영한 production 입력에서 유도한다.
    const pilotProductionInput = JSON.parse(await readFile(path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json"), "utf8"));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_trips").get().count, pilotProductionInput.transitTrips.length);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_stop_times").get().count, pilotProductionInput.transitStopTimes.length);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_feed_info").get().count, 1);
  } finally {
    database.close();
  }

  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const retiredRouteMapRecords = provenance.packs[0].records.filter(
    (record) => record.sourceId === "seoulmetro-cyberstation-route-map",
  );
  assert.equal(retiredRouteMapRecords.length, 0);
  assert.equal(
    provenance.packs[0].records.filter(
      (record) => record.entityType === "facility" && record.field === "status",
    ).length,
    4,
  );
  assert.deepEqual(
    [...new Set(
      provenance.packs[0].records
        .filter((record) => record.sourceId === "kric-subway-timetable")
        .map((record) => record.field),
    )].sort(),
    ["calendar_date", "feed_info", "route", "service_calendar", "stop_time", "trip"],
  );

  const coverageCandidateDir = path.join(outputDir, "coverage-contract-candidate");
  await mkdir(coverageCandidateDir, { recursive: true });
  const nationwideCoverageTargets = JSON.parse(
    await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"),
  );
  const coverageInventory = completeCoverageInventory(nationwideCoverageTargets);
  coverageInventory.sources = coverageInventory.sources.filter(
    ({ coverageScope }) => !(
      coverageScope.regionIds.includes("capital")
      && coverageScope.operatorIds.includes("seoul-metro")
      && coverageScope.lineIds?.includes("seoul-4")
      && coverageScope.sourceDomains.includes("route_map_positions")
    ),
  );
  const coverageInventoryPath = path.join(coverageCandidateDir, "source-inventory.json");
  await writeFile(coverageInventoryPath, `${JSON.stringify(coverageInventory, null, 2)}\n`);
  await writeCoverageCandidate(coverageCandidateDir, completeCoverageProvenance(coverageInventory));
  const coverageCandidateManifestPath = path.join(coverageCandidateDir, "current.json");
  const coverageCandidateProvenancePath = path.join(coverageCandidateDir, "current.provenance.json");

  const coverageGapReportPath = path.join(outputDir, "coverage-gap-report.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      coverageInventoryPath,
      "--manifest",
      coverageCandidateManifestPath,
      "--provenance",
      coverageCandidateProvenancePath,
      "--output",
      coverageGapReportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );
  const coverageGapReport = JSON.parse(await readFile(coverageGapReportPath, "utf8"));
  const capitalRouteMapCoverage = coverageGapReport.requirements.find(
    (entry) =>
      entry.regionId === "capital" &&
      entry.operatorId === "seoul-metro" &&
      entry.lineId === "seoul-4" &&
      entry.sourceDomain === "route_map_positions",
  );
  // historical diagnostic source는 더 이상 active line scope를 claim하지 않는다. 공공 관측의 v2 admission
  // 전에는 서울 4호선도 다른 서울 1~8호선과 같이 MISSING으로 남아야 한다.
  assert.equal(capitalRouteMapCoverage.status, "MISSING");
  assert.deepEqual(capitalRouteMapCoverage.missingFields, ["route_map_position", "route_map_label_polygon"]);
  assert.deepEqual(capitalRouteMapCoverage.sourceIds, []);

  // #1999: release-scope 평가 모드는 게시 차단을 게시 범위(capital·seoul-metro × capitalPilotTargets domains) 내 gap만
  // 기준으로 판정한다. 현행 인벤토리는 전국 gap 다수 + scope 내 gap 0이므로, --allow-gaps 없이도 exit 0으로 통과하되
  // 전국 gap 수치는 은폐 없이 그대로 기록해야 한다.
  const capitalPilotReleaseScope = {
    verifiedAccessibilityScope: {
      id: "capital_pilot_android_v1",
      regionIds: ["capital"],
      includedOperatorIds: ["seoul-metro"],
      includedLineIds: ["seoul-4"],
    },
  };
  const capitalPilotReleaseScopePath = path.join(outputDir, "capital-pilot-release-scope.json");
  await writeFile(capitalPilotReleaseScopePath, `${JSON.stringify(capitalPilotReleaseScope, null, 2)}\n`);

  const releaseScopeReportPath = path.join(outputDir, "release-scope-coverage-gap-report.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      coverageInventoryPath,
      "--manifest",
      coverageCandidateManifestPath,
      "--provenance",
      coverageCandidateProvenancePath,
      "--release-scope",
      capitalPilotReleaseScopePath,
      "--output",
      releaseScopeReportPath,
    ],
    { cwd: root },
  );
  const releaseScopeReport = JSON.parse(await readFile(releaseScopeReportPath, "utf8"));
  // 게시 범위(in-scope) gap은 0 → 게시 게이트 통과.
  assert.equal(releaseScopeReport.summary.releaseScope.coverageComplete, true);
  assert.equal(releaseScopeReport.summary.releaseScope.missingRequirements, 0);
  assert.equal(releaseScopeReport.summary.releaseScope.scopeId, "capital_pilot_android_v1");
  assert.deepEqual(releaseScopeReport.summary.releaseScope.regionIds, ["capital"]);
  assert.deepEqual(releaseScopeReport.summary.releaseScope.operatorIds, ["seoul-metro"]);
  assert.deepEqual(releaseScopeReport.summary.releaseScope.sourceDomains, [
    "accessibility_facilities",
    "schedule_timetable",
    "station_line_membership",
  ]);
  // 전국 gap은 은폐 금지 — nationwide 수치가 그대로 기록되고 여전히 다수의 gap이 존재한다.
  assert.ok(releaseScopeReport.summary.missingRequirements > 0);
  assert.equal(
    releaseScopeReport.summary.nationwide.missingRequirements,
    releaseScopeReport.summary.missingRequirements,
  );
  // in-scope requirement는 정확히 3개(capital·seoul-metro × 3 pilot domain)로 태깅된다.
  const inScopeRequirements = releaseScopeReport.releaseScopeRequirements;
  assert.equal(inScopeRequirements.length, 3);
  assert.ok(inScopeRequirements.every((entry) => entry.inReleaseScope === true));
  assert.ok(inScopeRequirements.every((entry) => entry.status === "covered"));

  // Negative 증명: 워크플로와 동일하게 provenance-backed 상태에서 scope 내 gap을 주입한다. 게시 pack의 provenance에서
  // station_line_membership OFFICIAL 레코드를 제거하면 in-scope gap이 생겨 release-scope 게이트가 exit 1로 실패한다.
  const scopeGapProvenance = JSON.parse(
    await readFile(coverageCandidateProvenancePath, "utf8"),
  );
  for (const pack of scopeGapProvenance.packs) {
    pack.records = pack.records.filter(
      (record) => !["line", "station_name", "station_code"].includes(record.field),
    );
  }
  const scopeGapProvenancePath = path.join(outputDir, "scope-gap-provenance.json");
  await writeFile(scopeGapProvenancePath, `${JSON.stringify(scopeGapProvenance, null, 2)}\n`);
  const scopeGapReportPath = path.join(outputDir, "scope-gap-coverage-gap-report.json");
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/nationwide-coverage-targets.json",
        "--inventory",
        coverageInventoryPath,
        "--manifest",
        coverageCandidateManifestPath,
        "--provenance",
        scopeGapProvenancePath,
        "--release-scope",
        capitalPilotReleaseScopePath,
        "--output",
        scopeGapReportPath,
      ],
      { cwd: root },
    ),
    /in-scope coverage gaps remain/,
  );
  const scopeGapReport = JSON.parse(await readFile(scopeGapReportPath, "utf8"));
  assert.ok(scopeGapReport.summary.releaseScope.missingRequirements > 0);
  assert.equal(scopeGapReport.summary.releaseScope.coverageComplete, false);
  // 주입한 station_line_membership gap이 in-scope requirement로 정확히 missing 처리된다.
  const injectedGap = scopeGapReport.releaseScopeRequirements.find(
    (entry) =>
      entry.regionId === "capital" &&
      entry.operatorId === "seoul-metro" &&
      entry.sourceDomain === "station_line_membership",
  );
  assert.equal(injectedGap.inReleaseScope, true);
  assert.equal(injectedGap.status, "missing");

  // #2000: scope의 region/operator id가 pilot targets와 하나도 매칭되지 않으면 in-scope requirement가 0개가 되어
  // missingRequirements === 0으로 공허 통과할 위험이 있다. fail closed — 존재하지 않는 regionId scope는 exit 1로 실패한다.
  const emptyScope = JSON.parse(await readFile("release/product-gates/production-datapack-scope.json", "utf8"));
  emptyScope.verifiedAccessibilityScope.regionIds = ["nonexistent-region"];
  const emptyScopePath = path.join(outputDir, "empty-release-scope.json");
  await writeFile(emptyScopePath, `${JSON.stringify(emptyScope, null, 2)}\n`);
  const emptyScopeReportPath = path.join(outputDir, "empty-scope-coverage-gap-report.json");
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/nationwide-coverage-targets.json",
        "--inventory",
        coverageInventoryPath,
        "--manifest",
        coverageCandidateManifestPath,
        "--provenance",
        coverageCandidateProvenancePath,
        "--release-scope",
        emptyScopePath,
        "--output",
        emptyScopeReportPath,
      ],
      { cwd: root },
    ),
    /release scope matched zero coverage requirements/,
  );
});

test("관리자 검수 NORMAL override는 production 시설 provenance와 validator를 통과한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-production-admin-normal-override-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const importedFixturePath = path.join(outputDir, "catalog-fixture.imported.json");
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const reviewedFixturePath = path.join(outputDir, "catalog-fixture.reviewed.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(productionSourceIngestInput(), null, 2)}\n`);
  const inventoryPath = await testOnlyInventoryPath(outputDir);
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-22T01:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-recovered-kric-elevator",
            facilityId: "facility-sangnoksu-elevator-kric-1",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-22T00:30:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      inventoryPath,
      "--input",
      inputPath,
      "--output",
      importedFixturePath,
    ],
    { cwd: root },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      importedFixturePath,
      "--overrides",
      overridePath,
      "--output",
      reviewedFixturePath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(reviewedFixturePath, "utf8"));
  const reviewedFacility = reviewedFixture.packs[0].facilities.find(
    (facility) => facility.id === "facility-sangnoksu-elevator-kric-1",
  );
  assert.equal(reviewedFacility.status, "NORMAL");
  assert.equal(reviewedFacility.statusMeaning, "REALTIME_OPERATION");
  assert.equal(reviewedFacility.operationalStatus, "AVAILABLE");
  assert.equal(reviewedFacility.verifiedAt, "2026-06-22T00:30:00.000Z");
  assert.equal(reviewedFacility.retrievedAt, "2026-06-22T01:00:00.000Z");
  makeProductionSourceFixtureStrictCoverageValid(reviewedFixture);
  await writeFile(reviewedFixturePath, `${JSON.stringify(reviewedFixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      reviewedFixturePath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
});

test("승인된 관리자 검수 결과는 다음 data pack fixture 시설 상태에 반영된다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-${Date.now()}`);
  const inputPath = path.join(outputDir, "catalog-fixture.json");
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile("tools/datapack/fixtures/catalog-fixture.json", inputPath);
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-broken-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      inputPath,
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedFacility = reviewedFixture.packs[0].facilities.find(
    (facility) => facility.id === "facility-sangnoksu-elevator-1",
  );
  const reviewedInternalRouteEdge = reviewedFixture.packs[0].internalRouteEdges.find(
    (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
  );
  const reviewedSummary = reviewedFixture.packs[0].stationAccessibilitySummaries.find(
    (summary) => summary.stationId === "station-sangnoksu",
  );
  assert.equal(reviewedFacility.status, "BROKEN");
  assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "UNAVAILABLE");
  assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 제한");
  assert.equal(reviewedSummary.warning, "1번 출구 엘리베이터 고장으로 우회가 필요합니다.");
  assert.equal(reviewedFixture.packs[0].metadata.adminReviewOverrideCount, "1");
  assert.equal(reviewedFixture.packs[0].metadata.adminReviewOverrideSource, "facility-report-admin-review");

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const database = new DatabaseSync(path.join(packOutputDir, "catalog", "capital-v1.sqlite"), { readOnly: true });
  try {
    const row = database
      .prepare("SELECT status FROM facilities WHERE id = ?")
      .get("facility-sangnoksu-elevator-1");
    assert.equal(row.status, "BROKEN");
    const routeEdge = database
      .prepare("SELECT accessibility_status FROM internal_route_edges WHERE id = ?")
      .get("edge-sangnoksu-concourse-exit-1");
    assert.equal(routeEdge.accessibility_status, "UNAVAILABLE");
    const summary = database
      .prepare("SELECT summary, warning FROM station_accessibility_summaries WHERE station_id = ?")
      .get("station-sangnoksu");
    assert.equal(summary.summary, "1번 출구 엘리베이터 이용 제한");
    assert.equal(summary.warning, "1번 출구 엘리베이터 고장으로 우회가 필요합니다.");
  } finally {
    database.close();
  }
});

test("관리자 검수 override는 unavailable strict step-free transfer reference를 비운다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-pathway-transfer-${Date.now()}`);
  const inputPath = path.join(outputDir, "catalog-fixture.json");
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile("tools/datapack/fixtures/catalog-fixture.json", inputPath);
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-broken-transfer-elevator",
            facilityId: "facility-sadang-transfer-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      inputPath,
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedPathwayEdge = reviewedFixture.packs[0].stationPathwayEdges.find(
    (edge) => edge.id === "path-edge-sadang-4-to-2-step-free",
  );
  const reviewedTransferRule = reviewedFixture.packs[0].transferRules.find(
    (rule) => rule.id === "transfer-sadang-seoul-4-to-seoul-2",
  );
  assert.equal(reviewedPathwayEdge.accessibilityStatus, "UNAVAILABLE");
  assert.equal(reviewedTransferRule.strictStepFreePathwayEdgeId, null);

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
});

test("관리자 검수 override는 fixture에 없는 시설 id를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-missing-facility-${Date.now()}`);
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-missing-facility",
            facilityId: "facility-missing",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-admin-review-overrides.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--overrides",
        overridePath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /facilityStatusUpdates\.facilityId was not found in fixture: facility-missing/,
  );
});

test("production 관리자 검수 override는 legacy transit_master_overrides 입력을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-legacy-${Date.now()}`);
  const overridePath = path.join(outputDir, "legacy-transit-master-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "transit-master-overrides",
        schemaVersion: 1,
        ledgerSource: "transit_master_overrides",
        source: "transit_master_overrides",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "legacy-effective-master-row",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-admin-review-overrides.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--overrides",
        overridePath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /transit_master_overrides.*manual_overrides ledger/s,
  );
});

test("관리자 검수 override는 복구 상태를 route 접근성에 다시 반영한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-recovered-${Date.now()}`);
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-broken-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
          {
            reportId: "report-admin-approved-recovered-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:10:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedFacility = reviewedFixture.packs[0].facilities.find(
    (facility) => facility.id === "facility-sangnoksu-elevator-1",
  );
  const reviewedInternalRouteEdge = reviewedFixture.packs[0].internalRouteEdges.find(
    (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
  );
  const reviewedSummary = reviewedFixture.packs[0].stationAccessibilitySummaries.find(
    (summary) => summary.stationId === "station-sangnoksu",
  );
  assert.equal(reviewedFacility.status, "NORMAL");
  assert.equal(reviewedFacility.statusMeaning, "REALTIME_OPERATION");
  assert.equal(reviewedFacility.operationalStatus, "AVAILABLE");
  assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "AVAILABLE");
  assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 가능");
  assert.equal(reviewedSummary.warning, "");
});

test("관리자 검수 override는 같은 시설의 최신 reviewedAt 결과만 적용한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-latest-${Date.now()}`);
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-recovered-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:10:00.000Z",
          },
          {
            reportId: "report-admin-approved-older-broken-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedFacility = reviewedFixture.packs[0].facilities.find(
    (facility) => facility.id === "facility-sangnoksu-elevator-1",
  );
  const reviewedInternalRouteEdge = reviewedFixture.packs[0].internalRouteEdges.find(
    (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
  );
  const reviewedSummary = reviewedFixture.packs[0].stationAccessibilitySummaries.find(
    (summary) => summary.stationId === "station-sangnoksu",
  );
  assert.equal(reviewedFacility.status, "NORMAL");
  assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "AVAILABLE");
  assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 가능");
  assert.equal(reviewedSummary.warning, "");
  assert.equal(reviewedFixture.packs[0].metadata.adminReviewOverrideCount, "1");
});

test("관리자 검수 override는 같은 역의 제한 시설 상태를 정상 시설로 지우지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-station-summary-${Date.now()}`);
  const inputPath = path.join(outputDir, "catalog-fixture.json");
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].facilities.push({
    id: "facility-sangnoksu-elevator-2",
    stationId: "station-sangnoksu",
    exitId: "exit-sangnoksu-1",
    type: "ELEVATOR",
    name: "2번 출구 엘리베이터",
    status: "NORMAL",
    floorFrom: "B1",
    floorTo: "1F",
    description: "대합실과 1번 출구 지상을 연결",
  });
  await writeFile(inputPath, `${JSON.stringify(fixture, null, 2)}\n`);
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-broken-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
          {
            reportId: "report-admin-approved-normal-second-elevator",
            facilityId: "facility-sangnoksu-elevator-2",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:01:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      inputPath,
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedSummary = reviewedFixture.packs[0].stationAccessibilitySummaries.find(
    (summary) => summary.stationId === "station-sangnoksu",
  );
  const reviewedInternalRouteEdge = reviewedFixture.packs[0].internalRouteEdges.find(
    (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
  );
  assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "UNAVAILABLE");
  assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 제한");
  assert.equal(reviewedSummary.warning, "1번 출구 엘리베이터 고장으로 우회가 필요합니다.");
  assert.equal(reviewedFixture.packs[0].metadata.adminReviewOverrideCount, "2");
});

test("emergency datapack drill은 rollback, patch, route regression 증거를 묶는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-emergency-datapack-drill-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const inputPath = path.join(outputDir, "drill-input.json");
  const outputPath = path.join(outputDir, "drill-evidence.json");
  const knownGoodManifestSha256 = "a".repeat(64);
  const badManifestSha256 = "b".repeat(64);
  const fixedManifestSha256 = "c".repeat(64);

  await writeFile(
    inputPath,
    `${JSON.stringify(
      {
        channel: "production",
        previousKnownGoodManifest: {
          url: "https://cdn.easysubway.example/datapacks/current-42.json",
          sha256: knownGoodManifestSha256,
        },
        badManifest: {
          url: "https://cdn.easysubway.example/datapacks/current-43.json",
          sha256: badManifestSha256,
        },
        fixedManifest: {
          url: "https://cdn.easysubway.example/datapacks/current-44.json",
          sha256: fixedManifestSha256,
        },
        rollback: {
          startedAt: "2026-07-01T10:00:00.000Z",
          completedAt: "2026-07-01T10:03:20.000Z",
          currentReleaseSequence: 43,
          failedReleaseSequence: 43,
          knownGoodReleaseSequence: 42,
          rescueReleaseSequence: 44,
          rescueManifestSha256: fixedManifestSha256,
          manifestLastStatus: "PASS",
          idempotentReplayStatus: "PASS",
        },
        emergencyPatch: {
          auditId: "patch-route-edge-1",
          rows: [
            { table: "network_edges", id: "edge-sangnoksu-sadang-local" },
            { table: "facilities", id: "facility-sangnoksu-elevator" },
            { table: "transit_stop_times", id: "stop-trip-seoul-4-local-0805-sangnoksu" },
          ],
        },
        routeRegressionReplay: {
          command: "node -e 'process.stdout.write(JSON.stringify({failures:[],sampleSize:100}))'",
          before: { blocked: true, blocker: "bad network edge" },
          after: { blocked: false },
        },
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/run-emergency-datapack-drill.mjs",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const evidence = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(evidence.artifactKind, "emergency-datapack-release-drill");
  assert.equal(evidence.channel, "production");
  assert.equal(evidence.rollback.previousKnownGoodManifestSha256, knownGoodManifestSha256);
  assert.equal(evidence.rollback.badManifestSha256, badManifestSha256);
  assert.equal(evidence.rollback.rollbackTimeSeconds, 200);
  assert.deepEqual(evidence.rollback.releaseSequences, {
    knownGood: 42,
    failed: 43,
    current: 43,
    rescue: 44,
  });
  assert.equal(evidence.rollback.rescueManifestSha256, fixedManifestSha256);
  assert.equal(evidence.rollback.manifestLastStatus, "PASS");
  assert.equal(evidence.rollback.idempotentReplayStatus, "PASS");
  assert.equal(evidence.emergencyPatch.auditId, "patch-route-edge-1");
  assert.deepEqual(
    evidence.emergencyPatch.correctedTables,
    ["facilities", "network_edges", "transit_stop_times"],
  );
  assert.equal(evidence.fixedPromotion.fixedManifestSha256, fixedManifestSha256);
  assert.equal(evidence.routeRegressionReplay.before.blocked, true);
  assert.equal(evidence.routeRegressionReplay.after.blocked, false);
  assert.equal(evidence.verification.commandOutputSha256, sha256('{"failures":[],"sampleSize":100}'));
});

test("데이터팩 만료 알림 evidence는 SLA 임박 manifest를 FIRING으로 기록한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-expiry-alert-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "current.json");
  const outputPath = path.join(outputDir, "expiry-alert-evidence.json");

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        manifestVersion: 2,
        channel: "production",
        releaseSequence: 42,
        publishedAt: "2026-07-01T18:00:00.000Z",
        expiresAt: "2026-07-02T05:30:00.000Z",
        activePack: { id: "capital", version: "1" },
        packs: [],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/check-datapack-expiry-alert.mjs",
      "--manifest",
      manifestPath,
      "--output",
      outputPath,
      "--now",
      "2026-07-02T00:00:00.000Z",
    ],
    { cwd: root },
  );

  const evidence = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(evidence.artifactKind, "datapack-expiry-alert-evidence");
  assert.equal(evidence.policy.alertBeforePackExpiry, "PT6H");
  assert.equal(evidence.manifest.channel, "production");
  assert.equal(evidence.manifest.releaseSequence, 42);
  assert.equal(evidence.alert.status, "FIRING");
  assert.equal(evidence.alert.severity, "warning");
  assert.equal(evidence.alert.secondsUntilExpiry, 19800);
});

// TODO: --current-manifest 발산 경로 (currentManifestBytes !== manifestBytes)는 #1692로 의도적 미연기 → 미커버
test("게시 plan은 schemaVersion 2에서 releases/<seq>.json 불변 스텝을 manifest 스텝보다 먼저 넣는다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "publish-plan-"));
  try {
    // manifestVersion 2 + releaseSequence 3 매니페스트와 pack 하나를 스테이징한다.
    const packBytes = gzipSync(Buffer.from("fixture-pack"));
    await mkdir(path.join(workspace, "catalog"), { recursive: true });
    await writeFile(path.join(workspace, "catalog", "capital-v1.sqlite.gz"), packBytes);
    const manifest = {
      manifestVersion: 2,
      channel: "staging",
      releaseSequence: 3,
      publishedAt: "2026-07-06T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
      keyId: "test-key",
      ttlSeconds: 3600,
      signature: { algorithm: "rsa-sha256-manifest-v2", value: "AA" },
      packs: [{ id: "capital", version: "1", sizeBytes: packBytes.length, sha256: sha256(packBytes) }],
    };
    const manifestPath = path.join(workspace, "catalog", "current.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const outputPath = path.join(workspace, "plan.json");

    await execFileAsync("node", [
      path.join(root, "tools/datapack/create-publish-plan.mjs"),
      "--manifest", manifestPath,
      "--root", workspace,
      "--output", outputPath,
    ]);

    const plan = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(plan.schemaVersion, 2);
    const types = plan.steps.map((step) => step.type);
    assert.deepEqual(types, [
      "put-pack-object", "verify-pack-object",
      "put-release-manifest-object", "verify-release-manifest-object",
      "put-manifest-object", "verify-manifest-object",
    ]);
    const releasePut = plan.steps.find((s) => s.type === "put-release-manifest-object");
    assert.equal(releasePut.objectKey, "catalog/releases/3.json");
    assert.equal(releasePut.immutable, true);
    assert.equal(releasePut.sourcePath, "catalog/current.json");
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    assert.equal(releasePut.sha256, sha256(manifestBytes));
    assert.equal(releasePut.sizeBytes, manifestBytes.length);
    assert.equal(releasePut.packCount, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function writePendingCandidateFixture(outputDir, candidateId) {
  const candidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  resetCandidateForAdmissionTest(candidates, candidateId);
  const candidatesPath = path.join(outputDir, "source-candidates.pending.json");
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  return candidatesPath;
}

function resetCandidateForAdmissionTest(candidates, candidateId) {
  const candidate = candidates.candidates.find(({ id }) => id === candidateId);
  candidate.admissionStatus = "evidence_recorded_admin_review_required";
  delete candidate.productionInventoryReferenceId;
  delete candidate.productionInventoryRelationship;
  delete candidate.evidence.adminReview;
  candidate.evidence.missingEvidence = [
    ...new Set([...(candidate.evidence.missingEvidence ?? []), "adminAdmissionEvidence"]),
  ];
}

function objectStorageEnv(origin) {
  return {
    ...process.env,
    EASYSUBWAY_OBJECT_STORAGE_ENDPOINT: origin,
    EASYSUBWAY_DATAPACK_BUCKET: "easysubway-datapacks",
    EASYSUBWAY_OBJECT_STORAGE_REGION: "ap-northeast-2",
    EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY: "test-access-key",
    EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY: "test-secret-key",
  };
}

async function startObjectStorageServer({ requireAuthorization = true, basePath = "/easysubway-datapacks" } = {}) {
  const requests = [];
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://127.0.0.1");
      const normalizedBasePath = basePath.replace(/\/+$/, "");
      const key = decodeURIComponent(url.pathname.replace(new RegExp(`^${escapeRegExp(normalizedBasePath)}\\/?`), ""));
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.authorization,
        contentSha256: request.headers["x-amz-content-sha256"],
      });

      if (requireAuthorization && !request.headers.authorization) {
        response.writeHead(403);
        response.end("missing authorization");
        return;
      }

      if (request.method === "PUT") {
        objects.set(key, {
          body,
          sha256: sha256(body),
          sizeBytes: body.length,
          contentType: request.headers["content-type"],
          metadataSha256: request.headers["x-amz-meta-sha256"],
          cacheControl: request.headers["cache-control"],
        });
        response.writeHead(200, { etag: `"${sha256(body).slice(0, 32)}"` });
        response.end();
        return;
      }

      if (request.method === "HEAD") {
        const object = objects.get(key);
        if (!object) {
          response.writeHead(404);
          response.end();
          return;
        }
        const headers = {
          "content-length": String(object.sizeBytes),
          "x-amz-meta-sha256": object.metadataSha256,
        };
        if (object.cacheControl !== undefined) {
          headers["cache-control"] = object.cacheControl;
        }
        response.writeHead(200, headers);
        response.end();
        return;
      }

      if (request.method === "GET") {
        const object = objects.get(key);
        if (!object) {
          response.writeHead(404);
          response.end();
          return;
        }
        const headers = { "content-length": String(object.sizeBytes) };
        if (object.cacheControl !== undefined) {
          headers["cache-control"] = object.cacheControl;
        }
        response.writeHead(200, headers);
        response.end(object.body);
        return;
      }

      response.writeHead(405);
      response.end("method not allowed");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    objects,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function testPublicRouteMapPosition() {
  return {
    sourceId: "seoul-metro-route-map-positions",
    station: {
      sourceId: "seoulmetro-station-line-info",
      sourceStationCode: "448",
      lineId: "seoul-4",
    },
    region: "수도권",
    x: 100,
    y: 200,
    labelDx: 0,
    labelDy: -14,
    labelPolygon: [
      { x: 90, y: 170 },
      { x: 110, y: 170 },
      { x: 110, y: 190 },
      { x: 90, y: 190 },
    ],
    sourceName: "공공 좌표 기반 결정론적 노선도 테스트 산출물",
    sourceUrl: "https://www.data.go.kr/data/15099316/fileData.do",
    sourceSha256: "a".repeat(64),
    license: "공공데이터 이용허락범위 제한 없음",
    licenseStatus: "redistributable-commercial-derivative",
    commercialUseAllowed: true,
    attributionRequired: true,
    sourceLabel: "상록수",
    reviewedAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

function addSourceIngestStation(input, { sourceStationCode, stationId, stationNameKo, stationCode, lineSequence }) {
  input.stationMappings.push({
    sourceId: "seoulmetro-station-line-info",
    sourceStationCode,
    lineId: "seoul-4",
    stationId,
    stationLineId: `${stationId}:seoul-4`,
    mappingStatus: "active",
  });
  input.stationLineRows.push({
    sourceId: "seoulmetro-station-line-info",
    sourceStationCode,
    lineId: "seoul-4",
    stationNameKo,
    stationNameEn: stationNameKo,
    normalizedName: stationNameKo,
    region: "수도권",
    latitude: 37.3159,
    longitude: 126.8385,
    stationCode,
    lineSequence,
    platformInfo: "당고개 방면 / 오이도 방면",
    lastVerifiedAt: "2026-06-21T00:00:00.000Z",
  });
}

test("공식 source ingest adapter는 current convenience source와 provenance 전용 source의 test-only projection을 격리한다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-test-only-accessibility-isolation-"));
  const raw = JSON.parse(await readFile(
    path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json"), "utf8",
  ));
  const trackedInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  assert.equal(trackedInventory.sources.find(({ id }) => id === "kric-station-convenience-standard").productionUseAllowed, true);
  assert.equal(trackedInventory.sources.some(({ id }) => id === TEST_PRODUCTION_ACCESSIBILITY_SOURCE), false);
  const current = await importOfficialSourceInput(path.join(outputDir, "raw"), raw);
  assert.equal(current.packs[0].artifactKind, "production");
  assert.ok(current.packs[0].sourceInventory.some(
    ({ id }) => id === "kric-station-convenience-standard",
  ));
  assert.ok(current.packs[0].facilities.some(
    ({ sourceId }) => sourceId === "kric-station-convenience-standard",
  ));
  const rawBeforeProjection = structuredClone(raw);
  const projected = withTestProductionAccessibility(raw);
  assert.deepEqual(raw, rawBeforeProjection);
  assert.deepEqual(projected.manifest, raw.manifest);
  assert.deepEqual(projected.routeEdges, raw.routeEdges);
  for (const coverage of raw.coverageEvidence.filter(({ sourceDomain }) => sourceDomain !== "accessibility_facilities")) {
    assert.deepEqual(
      projected.coverageEvidence.find(({ sourceDomain }) => sourceDomain === coverage.sourceDomain),
      coverage,
    );
  }
  const projectedStaticRows = [...projected.facilityRows, ...projected.accessibilityStatusEvidence]
    .filter((row) => row.sourceId === TEST_PRODUCTION_ACCESSIBILITY_SOURCE);
  assert.ok(projectedStaticRows.length > 0);
  for (const row of projectedStaticRows) {
    const label = row.id ?? `${row.stationId}:${row.lineId}:${row.facilityType}`;
    assert.equal(row.sourceSnapshotId, TEST_ACCESSIBILITY_SNAPSHOT_ID);
    assert.equal(JSON.stringify(row).includes("kric-station-convenience-standard"), false);
    assert.equal(row.providerFacilityRef, `test-only:${label}`);
    assert.equal(row.providerRecordHash, sha256(`test-only:${label}:provider`));
    assert.equal(row.evidenceHash, sha256(`test-only:${label}:evidence`));
  }
  assert.equal(new Set(projectedStaticRows.map((row) => row.providerRecordHash)).size, projectedStaticRows.length);
  assert.equal(new Set(projectedStaticRows.map((row) => row.evidenceHash)).size, projectedStaticRows.length);
  await assert.rejects(
    importOfficialSourceInput(path.join(outputDir, "actual"), projected),
    /source inventory missing: test-only-capital-accessibility-fixture/,
  );
  const tempOutput = path.join(outputDir, "projected");
  await mkdir(tempOutput, { recursive: true });
  const inventoryPath = await testOnlyInventoryPath(tempOutput);
  const tempInventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const testSource = tempInventory.sources.find(({ id }) => id === TEST_PRODUCTION_ACCESSIBILITY_SOURCE);
  assert.match(testSource.datasetUrl, /\.invalid/);
  assert.equal(testSource.owner, "EasySubway deterministic test");
  assert.equal(JSON.stringify(testSource.admissionEvidence).includes("seoul-metro"), false);
  assert.equal(JSON.stringify(testSource.accessibilityAdmissionEvidence).includes("seoul-metro"), false);
  const generated = await importOfficialSourceInput(tempOutput, projected, inventoryPath, false);
  assert.equal(generated.packs[0].artifactKind, "production");
});

function useAccessibilitySourceForAvailableEdge(input, edgeId) {
  if (!input.sourceIds.includes("seoul-metro-accessibility")) input.sourceIds.push("seoul-metro-accessibility");
  const coverage = input.coverageEvidence.find((row) => row.sourceDomain === "accessibility_facilities");
  if (coverage && !coverage.sourceIds.includes("seoul-metro-accessibility")) coverage.sourceIds.push("seoul-metro-accessibility");
  const edge = input.routeEdges.find((row) => row.id === edgeId);
  edge.accessibilityStatus = "AVAILABLE";
  edge.stairAccessState = "STEP_FREE";
  edge.verificationStatus = "VERIFIED";
  edge.sourceId = "seoul-metro-accessibility";
  edge.sourceSnapshotId = "seoul-metro-accessibility-20260728";
}

function addSeoul2ProductionScope(input) {
  input.lines.push({
    ...input.lines[0],
    id: "seoul-2",
    nameKo: "수도권 2호선",
    nameEn: "Seoul Subway Line 2",
    color: "#00A84D",
  });
  input.supportedV1Scope.includedLineIds.push("seoul-2");
  input.supportedV1Scope.facilityCoverageDenominator.expectedRows = 9;
}

function addMolitStationMapping(input, { sourceStationCode, stationId }) {
  input.stationMappings.push({
    sourceId: "molit-urban-rail-full-route",
    sourceStationCode,
    lineId: "seoul-2",
    stationId,
    stationLineId: `${stationId}:seoul-2`,
    mappingStatus: "active",
  });
}

function addStationLineRow(input, { baseSourceStationCode, sourceStationCode, stationCode, lineSequence, platformInfo }) {
  const base = input.stationLineRows.find((row) => row.sourceStationCode === baseSourceStationCode);
  input.stationLineRows.push({
    ...base,
    sourceStationCode,
    lineId: "seoul-2",
    stationCode,
    lineSequence,
    platformInfo: platformInfo ?? base.platformInfo,
  });
}

function addRequiredFacilityRowsForStationLine(input, { baseSourceStationCode, sourceStationCode, idPrefix }) {
  for (const facilityType of input.supportedV1Scope.requiredFacilityTypes) {
    const base = input.facilityRows.find(
      (row) => row.station.sourceStationCode === baseSourceStationCode && row.type === facilityType,
    );
    const id = `${idPrefix}-${facilityType.toLowerCase()}`;
    input.facilityRows.push({
      ...base,
      id,
      station: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode,
        lineId: "seoul-2",
      },
      providerFacilityRef: id,
      providerRecordHash: sha256(`provider:${id}:${base.sourceId}`),
      evidenceHash: sha256(`evidence:${id}:${base.sourceId}:2026-06-22T00:00:00.000Z`),
    });
  }
}

function withProductionSummaryRideEdges(input, servicePattern = "EXPRESS") {
  return {
    ...input,
    routeEdges: [...productionSummaryRideEdges(servicePattern), ...input.routeEdges],
    routeGraphTopologyPolicy: {
      summaryRideEdges: "fixture-only",
    },
  };
}

function productionSummaryRideEdges(servicePattern = "EXPRESS") {
  return sourceIngestInput().routeEdges.map((edge) => ({
    ...edge,
    servicePattern,
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    sourceSnapshotId: `${edge.sourceId}-snapshot-20260621`,
    providerRecordHash: sha256(`provider:${edge.id}:${edge.sourceId}`),
    evidenceHash: sha256(`evidence:${edge.id}:${edge.sourceId}:${edge.lastVerifiedAt}`),
  }));
}

// rollout 검증 단위 테스트용 최소 유효 v1 fixture 매니페스트 생성 헬퍼
function minimalFixtureManifest() {
  const hex64 = "a".repeat(64);
  return {
    ttlSeconds: 3600,
    packs: [
      {
        id: "test",
        version: "1",
        artifactKind: "fixture",
        url: "catalog/test-v1.sqlite.gz",
        sha256: hex64,
        sqliteSha256: hex64,
        sizeBytes: 1,
        signature: { algorithm: "sha256-pack-manifest-v1", value: hex64 },
        schemaVersion: "1",
        sourceInventory: [
          {
            id: "src",
            owner: "test",
            url: "https://example.com",
            license: "fixture",
            licenseStatus: "fixture-only",
            redistributionAllowed: false,
            updateFrequency: "manual",
            updatedAt: "2026-01-01",
            fields: ["test"],
          },
        ],
        regionalQualityMetrics: {
          stationCount: 0,
          facilityCoverageRatio: 0,
          requiredFacilityEvidenceCoverageRatio: 0,
          strictRouteEligibleFacilityRatio: 0,
          operationalKnownRatio: 0,
          freshnessValidRatio: 0,
          fieldVerifiedPathwayRatio: 0,
          edgeCount: 0,
          unknownAccessibilityRatio: 0,
          unknownEdgeRatioByProfile: { wheelchair: 0, stroller: 0, lowMobility: 0 },
        },
        representativeRouteRegressions: [],
        representativeRouteRegressionSignature: {
          algorithm: "sha256-route-regression-v1",
          value: hex64,
        },
        requiredTables: ["catalog_metadata"],
      },
    ],
  };
}

test("매니페스트 rollout은 percentage 0~100·seed hex32만 허용한다", () => {
  const base = minimalFixtureManifest();
  const ok = { ...base, rollout: { percentage: 10, seed: "a".repeat(32) } };
  assert.doesNotThrow(() => validateManifest(ok));
  assert.throws(
    () => validateManifest({ ...base, rollout: { percentage: 101, seed: "a".repeat(32) } }),
    /rollout.*percentage/,
  );
  assert.throws(
    () => validateManifest({ ...base, rollout: { percentage: 10, seed: "zz" } }),
    /rollout.*seed/,
  );
});

test("매니페스트 서명 객체는 algorithm·value 외 필드를 거부한다", () => {
  // 이슈 #2531(DP-05). 서명 객체는 서명 대상 정준 문자열 밖에 있는 유일한 자리라 그
  // 안의 값은 서명되지 않는다. 모바일 파서가 미지 키를 거부하므로 생산자도 같은
  // 규칙으로 닫는다 — 한쪽만 닫으면 파이프라인이 초록으로 내보낸 매니페스트를 단말이
  // 전량 거부한다.
  //
  // 스키마의 중첩 `additionalProperties: false`만으로는 강제되지 않는다
  // (`validateManifestJsonSchema`가 최상위 키만 훑는다). 그래서 코드 검사로 닫았고,
  // 이 테스트가 그 검사를 고정한다.
  const base = minimalFixtureManifest();
  assert.doesNotThrow(() => validateManifest(base));

  const packSignatureTrace = minimalFixtureManifest();
  packSignatureTrace.packs[0].signature.unsignedTrace = "issue-2531";
  assert.throws(() => validateManifest(packSignatureTrace), /signature additional field is unsupported: unsignedTrace/);

  const routeRegressionTrace = minimalFixtureManifest();
  routeRegressionTrace.packs[0].representativeRouteRegressionSignature.unsignedTrace = "issue-2531";
  assert.throws(
    () => validateManifest(routeRegressionTrace),
    /representativeRouteRegressionSignature additional field is unsupported: unsignedTrace/,
  );
});

test("v2 봉투 서명 객체도 algorithm·value 외 필드를 거부한다", () => {
  const manifest = {
    ...minimalFixtureManifest(),
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 42,
    publishedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-07-02T00:00:00.000Z",
    keyId: "fixture-key",
  };
  manifest.packs[0].signature = { algorithm: "sha256-pack-manifest-v2", value: "a".repeat(64) };
  manifest.signature = { algorithm: "sha256-manifest-v2", value: canonicalManifestSelfHash(manifest) };
  assert.doesNotThrow(() => validateManifest(manifest));

  manifest.signature = { ...manifest.signature, unsignedTrace: "issue-2531" };
  assert.throws(() => validateManifest(manifest), /manifest\.signature additional field is unsupported: unsignedTrace/);
});

function canonicalManifestSelfHash(manifest) {
  return createHash("sha256").update(canonicalJson(withoutSignature(manifest))).digest("hex");
}

test("releases 게시 대상 매니페스트에 rollout이 있으면 거부한다", () => {
  const base = minimalFixtureManifest();
  const withRollout = { ...base, rollout: { percentage: 10, seed: "a".repeat(32) } };
  assert.throws(
    () => validateManifest(withRollout, { releasesTarget: true }),
    /releases.*rollout/i,
  );
});

test("manifest-signing: rsaSha256Signature는 base64url 서명을 반환하고 공개키로 검증된다", async () => {
  const { rsaSha256Signature } = await import("./lib/manifest-signing.mjs");
  const { verifyRsaSha256Signature } = await import("./lib/manifest-validation.mjs");
  const value = "manifest-signing-unit-test-fixture-payload";
  const sig = rsaSha256Signature(testPrivateKeyPem, value);
  assert.ok(typeof sig === "string", "서명은 문자열이어야 함");
  assert.ok(/^[A-Za-z0-9_-]+$/.test(sig), "base64url 형식이어야 함");
  assert.ok(verifyRsaSha256Signature(testPublicKeyPem, value, sig), "공개키로 검증되어야 함");
});

test("manifest-signing: signingPrivateKey는 env 미설정 시 throw, 설정 시 PEM 반환", async () => {
  const { signingPrivateKey } = await import("./lib/manifest-signing.mjs");
  const savedKey = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  try {
    delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
    assert.throws(() => signingPrivateKey(), /EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM/);
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = testPrivateKeyPem;
    assert.equal(signingPrivateKey(), testPrivateKeyPem.trim());
  } finally {
    if (savedKey !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedKey;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  }
});

test("manifest-signing: signingPrivateKey는 RSA가 아닌 키와 PEM이 아닌 값을 키 값 노출 없이 거부한다", async () => {
  const { signingPrivateKey } = await import("./lib/manifest-signing.mjs");
  const savedKey = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  try {
    for (const [namedCurveOrType, expectedType] of [["ec", "ec"], ["ed25519", "ed25519"]]) {
      const { privateKey } = namedCurveOrType === "ec"
        ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        : generateKeyPairSync("ed25519");
      process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
      assert.throws(
        () => signingPrivateKey(),
        (error) => error.message.includes(`must be an RSA private key (got ${expectedType})`) && !error.message.includes("PRIVATE KEY"),
      );
    }
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = "not-a-pem-SECRET-MARKER";
    assert.throws(
      () => signingPrivateKey(),
      (error) => error.message.includes("is not a valid private key PEM") && !error.message.includes("SECRET-MARKER"),
    );
  } finally {
    if (savedKey !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedKey;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  }
});

test("manifest-signing: manifestSignatureValue는 canonicalJson(withoutSignature) 기반 RSA 서명을 반환한다", async () => {
  const { manifestSignatureValue } = await import("./lib/manifest-signing.mjs");
  const { verifyRsaSha256Signature, canonicalJson, withoutSignature } = await import("./lib/manifest-validation.mjs");
  const manifest = {
    manifestVersion: 2,
    channel: "test",
    releaseSequence: 1,
    publishedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    keyId: "test-key",
    ttlSeconds: 3600,
    packs: [],
    signature: { algorithm: "rsa-sha256-manifest-v2", value: "PLACEHOLDER" },
  };
  const savedKey = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  try {
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = testPrivateKeyPem;
    const sigValue = manifestSignatureValue(manifest);
    const canonical = canonicalJson(withoutSignature(manifest));
    assert.ok(/^[A-Za-z0-9_-]+$/.test(sigValue), "base64url 형식이어야 함");
    assert.ok(verifyRsaSha256Signature(testPublicKeyPem, canonical, sigValue), "서명 검증 통과해야 함");
  } finally {
    if (savedKey !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedKey;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  }
});

// ─── buildRolloutManifest 단위 테스트 (#1692) ──────────────────────────────────
// production releases 픽스처 생성 헬퍼 (keyId="production-v1", RSA-SHA256 서명 계산)

function _rolloutCanonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(_rolloutCanonicalValue);
  return Object.fromEntries(
    Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, _rolloutCanonicalValue(value[k])]),
  );
}

function _rolloutCanonicalJson(value) {
  return JSON.stringify(_rolloutCanonicalValue(value));
}

function _rolloutSign(data) {
  return createSign("RSA-SHA256").update(data).sign(testPrivateKeyPem).toString("base64url");
}

function buildProductionReleasesManifest(overrides = {}) {
  const hex64 = "a".repeat(64);
  const base = {
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 5,
    publishedAt: "2026-07-07T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    signature: { algorithm: "rsa-sha256-manifest-v2", value: "placeholder" },
    packs: [
      {
        id: "capital",
        version: "1",
        artifactKind: "production",
        url: "https://cdn.example.com/catalog/capital-v1.sqlite.gz",
        sha256: hex64,
        sqliteSha256: hex64,
        sizeBytes: 1000,
        signature: {
          algorithm: "rsa-sha256-pack-manifest-v2",
          value: _rolloutSign("pack-payload"),
        },
        schemaVersion: "1",
        sourceInventory: [
          {
            id: "src1",
            owner: "test-owner",
            url: "https://data.example.com/catalog",
            license: "CC-BY-4.0",
            licenseStatus: "redistributable",
            redistributionAllowed: true,
            updateFrequency: "daily",
            updatedAt: "2026-07-07T00:00:00.000Z",
            fields: ["stations"],
            coverageScope: {
              regionIds: ["seoul"],
              operatorIds: ["seoulmetro"],
              sourceDomains: ["station_map"],
            },
          },
        ],
        regionalQualityMetrics: {
          stationCount: 100,
          edgeCount: 200,
          facilityCoverageRatio: 0.5,
          requiredFacilityEvidenceCoverageRatio: 0.5,
          strictRouteEligibleFacilityRatio: 0.5,
          operationalKnownRatio: 1.0,
          freshnessValidRatio: 0.8,
          fieldVerifiedPathwayRatio: 0.3,
          unknownAccessibilityRatio: 0.2,
          unknownEdgeRatioByProfile: { wheelchair: 0.1, stroller: 0.1, lowMobility: 0.1 },
        },
        representativeRouteRegressions: [],
        representativeRouteRegressionSignature: {
          algorithm: "rsa-sha256-route-regression-v1",
          value: _rolloutSign("regression-payload"),
        },
        requiredTables: ["stations"],
        minimumTableRows: {
          stations: 1,
          station_lines: 1,
          network_edges: 1,
          facilities: 1,
          station_facility_evidence: 1,
        },
      },
    ],
    ...overrides,
  };
  const { signature: _dropSig, ...unsigned } = base;
  base.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: _rolloutSign(_rolloutCanonicalJson(unsigned)),
  };
  return base;
}

test("buildRolloutManifest (a): percentage 50 → rollout{50,seed hex32} + validateManifest 통과(재서명 유효)", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const { verifyRsaSha256Signature, canonicalJson, withoutSignature } = await import("./lib/manifest-validation.mjs");
  const releases = buildProductionReleasesManifest();
  const savedPriv = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  const savedPub = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  try {
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = testPrivateKeyPem;
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = testPublicKeyPem;
    const result = buildRolloutManifest({ releases, current: null, targetSequence: 5, percentage: 50 });
    assert.ok(result.rollout, "rollout 필드 있어야 함");
    assert.equal(result.rollout.percentage, 50);
    assert.match(result.rollout.seed, /^[a-f0-9]{32}$/, "seed hex32 이어야 함");
    assert.ok(
      verifyRsaSha256Signature(testPublicKeyPem, canonicalJson(withoutSignature(result)), result.signature.value),
      "재서명이 공개키로 검증되어야 함",
    );
    assert.doesNotThrow(() => validateManifest(result, { requireProduction: true }), "validateManifest 통과해야 함");
  } finally {
    if (savedPriv !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedPriv;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
    if (savedPub !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = savedPub;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  }
});

test("buildRolloutManifest (b): percentage 100 → rollout 없음, releases에서 rollout 제거한 구조와 deepStrictEqual", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const releases = buildProductionReleasesManifest();
  const { rollout: _dropRollout, ...releasesWithoutRollout } = releases;
  const result = buildRolloutManifest({ releases, current: null, targetSequence: releases.releaseSequence, percentage: 100 });
  assert.deepStrictEqual(result, releasesWithoutRollout);
});

test("buildRolloutManifest (c): current.rollout.seed 존재 → 신규 percentage 결과 seed 계승", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const releases = buildProductionReleasesManifest();
  const existingSeed = "b".repeat(32);
  const current = { ...releases, rollout: { percentage: 30, seed: existingSeed } };
  const savedPriv = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  const savedPub = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  try {
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = testPrivateKeyPem;
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = testPublicKeyPem;
    const result = buildRolloutManifest({ releases, current, targetSequence: releases.releaseSequence, percentage: 70 });
    assert.equal(result.rollout.seed, existingSeed, "seed 계승해야 함");
    assert.equal(result.rollout.percentage, 70);
  } finally {
    if (savedPriv !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedPriv;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
    if (savedPub !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = savedPub;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  }
});

test("buildRolloutManifest (d): targetSequence ≠ releases.releaseSequence → throws /sequence mismatch/", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const releases = buildProductionReleasesManifest();
  assert.throws(
    () => buildRolloutManifest({ releases, current: null, targetSequence: 999, percentage: 50 }),
    /sequence mismatch/,
  );
});

test("buildRolloutManifest (e): current.releaseSequence ≠ targetSequence → throws /다른 릴리즈/", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const releases = buildProductionReleasesManifest();
  const staleRelease = buildProductionReleasesManifest({ releaseSequence: 3 });
  assert.throws(
    () => buildRolloutManifest({ releases, current: staleRelease, targetSequence: releases.releaseSequence, percentage: 50 }),
    /다른 릴리즈/,
  );
});

// ─── publish-rollout CLI 테스트 (#1692) ────────────────────────────────────────
// rollback-manifest.test.mjs의 startStorage·패턴을 재사용해 mock 객체스토리지를 구성.

const ROLLOUT_PACK_BYTES = Buffer.from("rollout-test-pack-bytes");
const ROLLOUT_PACK_SHA = createHash("sha256").update(ROLLOUT_PACK_BYTES).digest("hex");

function buildRolloutTestReleasesManifest(overrides = {}) {
  const sqliteSha = "a".repeat(64);
  const base = {
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 10,
    publishedAt: "2026-07-07T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    signature: { algorithm: "rsa-sha256-manifest-v2", value: "placeholder" },
    packs: [
      {
        id: "capital",
        version: "1",
        artifactKind: "production",
        url: "https://cdn.example.com/catalog/capital-v1.sqlite.gz",
        sha256: ROLLOUT_PACK_SHA,
        sqliteSha256: sqliteSha,
        sizeBytes: ROLLOUT_PACK_BYTES.length,
        signature: {
          algorithm: "rsa-sha256-pack-manifest-v2",
          value: _rolloutSign("rollout-pack-payload"),
        },
        schemaVersion: "1",
        sourceInventory: [
          {
            id: "src1",
            owner: "test-owner",
            url: "https://data.example.com/catalog",
            license: "CC-BY-4.0",
            licenseStatus: "redistributable",
            redistributionAllowed: true,
            updateFrequency: "daily",
            updatedAt: "2026-07-07T00:00:00.000Z",
            fields: ["stations"],
            coverageScope: {
              regionIds: ["seoul"],
              operatorIds: ["seoulmetro"],
              sourceDomains: ["station_map"],
            },
          },
        ],
        regionalQualityMetrics: {
          stationCount: 100,
          edgeCount: 200,
          facilityCoverageRatio: 0.5,
          requiredFacilityEvidenceCoverageRatio: 0.5,
          strictRouteEligibleFacilityRatio: 0.5,
          operationalKnownRatio: 1.0,
          freshnessValidRatio: 0.8,
          fieldVerifiedPathwayRatio: 0.3,
          unknownAccessibilityRatio: 0.2,
          unknownEdgeRatioByProfile: { wheelchair: 0.1, stroller: 0.1, lowMobility: 0.1 },
        },
        representativeRouteRegressions: [],
        representativeRouteRegressionSignature: {
          algorithm: "rsa-sha256-route-regression-v1",
          value: _rolloutSign("rollout-regression-payload"),
        },
        requiredTables: ["stations"],
        minimumTableRows: {
          stations: 1,
          station_lines: 1,
          network_edges: 1,
          facilities: 1,
          station_facility_evidence: 1,
        },
      },
    ],
    ...overrides,
  };
  const { signature: _dropSig, ...unsigned } = base;
  base.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: _rolloutSign(_rolloutCanonicalJson(unsigned)),
  };
  return base;
}

async function startRolloutTestStorage(seed) {
  const objects = new Map(seed);
  const server = createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\//, ""));
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        objects.set(key, { body: Buffer.concat(chunks) });
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    const found = objects.get(key);
    if (!found) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-length", String(found.body.length));
    res.setHeader("etag", `"${createHash("sha256").update(found.body).digest("hex")}"`);
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : found.body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, objects, port: server.address().port })));
}

const rolloutTestEnv = {
  ...process.env,
  EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: testPublicKeyPem,
  EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: testPrivateKeyPem,
};

async function runPublishRollout(args, baseUrl) {
  return execFileAsync(
    "node",
    [path.join(root, "tools/datapack/publish-rollout.mjs"), "--base-url", baseUrl, ...args],
    { env: rolloutTestEnv },
  );
}

test("publish-rollout (①): --percentage 30 → current.json에 rollout{30,seed hex32}+서명 유효+참조 pack sha 검증 통과", async () => {
  const manifest = buildRolloutTestReleasesManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const oldCurrentBytes = Buffer.from(JSON.stringify({ ...manifest, rollout: { percentage: 10, seed: "c".repeat(32) } }));

  const storage = await startRolloutTestStorage([
    ["catalog/releases/10.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: ROLLOUT_PACK_BYTES }],
    ["catalog/current.json", { body: oldCurrentBytes }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    const { stdout } = await runPublishRollout(
      ["--target-sequence", "10", "--percentage", "30"],
      baseUrl,
    );
    const report = JSON.parse(stdout);
    assert.equal(report.targetSequence, 10);
    assert.equal(report.percentage, 30);
    assert.equal(report.channel, "production");

    // PUT된 current.json 검증
    const currentBytes = storage.objects.get("catalog/current.json").body;
    const current = JSON.parse(currentBytes.toString("utf8"));
    assert.ok(current.rollout, "rollout 필드 있어야 함");
    assert.equal(current.rollout.percentage, 30);
    assert.match(current.rollout.seed, /^[a-f0-9]{32}$/, "seed hex32 이어야 함");

    // 서명 재검증 — 재서명된 manifest 서명이 공개키로 검증되어야 한다
    const { verifyRsaSha256Signature, canonicalJson, withoutSignature } = await import("./lib/manifest-validation.mjs");
    assert.ok(
      verifyRsaSha256Signature(testPublicKeyPem, canonicalJson(withoutSignature(current)), current.signature.value),
      "재서명이 공개키로 검증되어야 함",
    );

    // 리포트 newCurrentSha256이 저장된 bytes와 일치
    const storedSha = createHash("sha256").update(currentBytes).digest("hex");
    assert.equal(report.newCurrentSha256, storedSha);
  } finally {
    storage.server.close();
  }
});

test("publish-rollout (②): 참조 팩 sha256 불일치 → PUT 없이 throw (fail-closed)", async () => {
  const manifest = buildRolloutTestReleasesManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  // current.json에는 releases와 동일한 매니페스트를 넣어 buildRolloutManifest가 통과하도록 한다.
  // 팩 sha256 불일치만이 fail-closed의 트리거가 되어야 한다.
  const originalCurrentBytes = Buffer.from(JSON.stringify(manifest));

  const storage = await startRolloutTestStorage([
    ["catalog/releases/10.json", { body: manifestBytes }],
    // 훼손된 팩 바이트 — sha256 불일치
    ["catalog/capital-v1.sqlite.gz", { body: Buffer.from("tampered-pack-bytes") }],
    ["catalog/current.json", { body: originalCurrentBytes }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    await assert.rejects(
      runPublishRollout(["--target-sequence", "10", "--percentage", "30"], baseUrl),
      /sha256 mismatch/,
    );
    // fail-closed: current.json은 원본 그대로 보존되어야 한다
    assert.deepEqual(storage.objects.get("catalog/current.json").body, originalCurrentBytes);
  } finally {
    storage.server.close();
  }
});

test("publish-rollout (③): --dry-run → current.json 수정 없이 exit 0 + 리포트 반환", async () => {
  const manifest = buildRolloutTestReleasesManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const originalCurrentBytes = Buffer.from(JSON.stringify(manifest));

  const storage = await startRolloutTestStorage([
    ["catalog/releases/10.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: ROLLOUT_PACK_BYTES }],
    ["catalog/current.json", { body: originalCurrentBytes }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    const { stdout } = await runPublishRollout(
      ["--dry-run", "--target-sequence", "10", "--percentage", "50"],
      baseUrl,
    );
    const report = JSON.parse(stdout);
    assert.equal(report.percentage, 50);
    // current.json은 원본 그대로 (PUT 미수행)
    assert.deepEqual(storage.objects.get("catalog/current.json").body, originalCurrentBytes);
  } finally {
    storage.server.close();
  }
});

// --- #1397 원장 해시 exporter + admin review record 생성기 ---

async function runLedgerExporter(args) {
  return execFileAsync(process.execPath, ["tools/datapack/export-ledger-hashes.mjs", ...args], { cwd: root });
}

async function runAdminReviewBuilder(args) {
  return execFileAsync(process.execPath, ["tools/datapack/build-admin-review-record.mjs", ...args], { cwd: root });
}

const catalogFixtureArg = "tools/datapack/fixtures/catalog-fixture.json";
const overrideLedgerArg = "tools/datapack/fixtures/admin-review-overrides.json";

async function runOfficialOdFareAdmissionBuilder(args) {
  return execFileAsync(process.execPath, ["tools/datapack/build-official-od-fare-admission.mjs", ...args], { cwd: root });
}

function officialOdFareEvidenceFixture() {
  const fares = {
    childCardFare: 750,
    childCashFare: 750,
    gnrlCardFare: 1950,
    gnrlCashFare: 2050,
    yungCardFare: 1220,
    yungCashFare: 2050,
  };
  return {
    schemaVersion: 1,
    artifactKind: "official-od-fare-probe-evidence",
    mappingAvailability: "AVAILABLE",
    mappingField: "dptreStnCd/arvlStnCd",
    providerId: "data-go-kr-b553766-fare2",
    equivalence: {
      cityHallLine1: { fareResponseStationCode: "0151", fareCode: "0151", verified: true },
      seoulStationLine4: { fareResponseStationCode: "0150", fareCode: "0150", verified: true },
    },
    providerMappings: [
      { stationId: "station-sangnoksu", lineId: "seoul-4", stationName: "상록수", fareStationCode: "1754" },
      { stationId: "station-sadang", lineId: "seoul-4", stationName: "사당", fareStationCode: "0433" },
      { stationId: "station-2af75c3d707b", lineId: "seoul-4", stationName: "서울역", fareStationCode: "0150" },
      { stationId: "station-a2d54a5d63d2", lineId: "line-472a81add377", stationName: "시청", fareStationCode: "0151" },
    ],
    quotes: [
      { originStationId: "station-sangnoksu", destinationStationId: "station-sadang", fares },
      { originStationId: "station-sadang", destinationStationId: "station-sangnoksu", fares },
      {
        originStationId: "station-2af75c3d707b",
        destinationStationId: "station-a2d54a5d63d2",
        fares: {
          childCardFare: 550,
          childCashFare: 550,
          gnrlCardFare: 1550,
          gnrlCashFare: 1650,
          yungCardFare: 900,
          yungCashFare: 1650,
        },
      },
    ],
    fieldNames: Object.keys(fares).sort(),
    attemptCounts: {
      "station-sadang→station-sangnoksu": 1,
      "station-sangnoksu→station-sadang": 1,
      "station-2af75c3d707b→station-a2d54a5d63d2": 1,
    },
  };
}

function busanOfficialOdFareEvidenceFixture() {
  return {
    schemaVersion: 1,
    artifactKind: "official-od-fare-probe-evidence",
    mappingAvailability: "AVAILABLE",
    mappingField: "mo_scode_s/mo_scode_e",
    providerId: "busan-transportation-cyberstation",
    equivalence: {
      routeForm: {
        cyberKinds: "1",
        destinationField: "mo_scode_e",
        originField: "mo_scode_s",
        verified: true,
      },
    },
    providerMappings: [
      { stationId: "station-fcb7a21e5606", lineId: "line-ab1a041f6266", stationName: "하단", fareStationCode: "102" },
      { stationId: "station-dd45c69d3e40", lineId: "line-ab1a041f6266", stationName: "당리", fareStationCode: "103" },
      { stationId: "station-1fc7a7c971c8", lineId: "line-ab1a041f6266", stationName: "서면", fareStationCode: "119" },
      { stationId: "station-6b611916f76a", lineId: "line-eb7b47920390", stationName: "장산", fareStationCode: "201" },
    ],
    quotes: [
      {
        originStationId: "station-fcb7a21e5606",
        destinationStationId: "station-dd45c69d3e40",
        fares: {
          childCardFare: 0,
          childCashFare: 700,
          gnrlCardFare: 1600,
          gnrlCashFare: 1700,
          yungCardFare: 1050,
          yungCashFare: 1150,
        },
      },
      {
        originStationId: "station-fcb7a21e5606",
        destinationStationId: "station-6b611916f76a",
        fares: {
          childCardFare: 0,
          childCashFare: 800,
          gnrlCardFare: 1800,
          gnrlCashFare: 1900,
          yungCardFare: 1200,
          yungCashFare: 1300,
        },
      },
      {
        originStationId: "station-1fc7a7c971c8",
        destinationStationId: "station-6b611916f76a",
        fares: {
          childCardFare: 0,
          childCashFare: 800,
          gnrlCardFare: 1800,
          gnrlCashFare: 1900,
          yungCardFare: 1200,
          yungCashFare: 1300,
        },
      },
    ],
    fieldNames: [
      "childCardFare",
      "childCashFare",
      "gnrlCardFare",
      "gnrlCashFare",
      "yungCardFare",
      "yungCashFare",
    ],
    attemptCounts: {
      officialFareTable: 1,
      "station-fcb7a21e5606→station-dd45c69d3e40": 1,
      "station-fcb7a21e5606→station-6b611916f76a": 1,
      "station-1fc7a7c971c8→station-6b611916f76a": 1,
    },
  };
}

test("fare station-line mapping 원장은 probe mapping만 canonical hash로 산출한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "fare-station-line-ledger-"));
  try {
    const evidence = officialOdFareEvidenceFixture();
    const evidencePath = path.join(workspace, "evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence));
    const args = [
      "--kind", "fare-station-line-mapping",
      "--evidence", path.relative(root, evidencePath),
      "--source-id", "seoul-metro-official-od-fares",
    ];
    const baseline = JSON.parse((await runLedgerExporter(args)).stdout);
    const operator = JSON.parse((await runLedgerExporter([
      "--kind", "operator-mapping", "--fixture", catalogFixtureArg,
    ])).stdout);
    assert.equal(baseline.kind, "fare-station-line-mapping");
    assert.equal(baseline.rowCount, 4);
    assert.notEqual(baseline.ledgerHash, operator.ledgerHash);

    const reordered = structuredClone(evidence);
    reordered.providerMappings.reverse();
    const reorderedPath = path.join(workspace, "reordered.json");
    await writeFile(reorderedPath, JSON.stringify(reordered));
    const reorderedHash = JSON.parse((await runLedgerExporter([
      "--kind", "fare-station-line-mapping",
      "--evidence", path.relative(root, reorderedPath),
      "--source-id", "seoul-metro-official-od-fares",
    ])).stdout);
    assert.equal(reorderedHash.ledgerHash, baseline.ledgerHash);

    const changed = structuredClone(evidence);
    changed.providerMappings[0].fareStationCode = "1755";
    const changedPath = path.join(workspace, "changed.json");
    await writeFile(changedPath, JSON.stringify(changed));
    const changedHash = JSON.parse((await runLedgerExporter([
      "--kind", "fare-station-line-mapping",
      "--evidence", path.relative(root, changedPath),
      "--source-id", "seoul-metro-official-od-fares",
    ])).stdout);
    assert.notEqual(changedHash.ledgerHash, baseline.ledgerHash);

    const duplicate = structuredClone(evidence);
    duplicate.providerMappings[1].fareStationCode = duplicate.providerMappings[0].fareStationCode;
    const duplicatePath = path.join(workspace, "duplicate.json");
    await writeFile(duplicatePath, JSON.stringify(duplicate));
    await assert.rejects(
      runLedgerExporter([
        "--kind", "fare-station-line-mapping",
        "--evidence", path.relative(root, duplicatePath),
        "--source-id", "seoul-metro-official-od-fares",
      ]),
      /duplicate provider station code/,
    );

    const duplicateStation = structuredClone(evidence);
    duplicateStation.providerMappings[1].stationId = duplicateStation.providerMappings[0].stationId;
    const duplicateStationPath = path.join(workspace, "duplicate-station.json");
    await writeFile(duplicateStationPath, JSON.stringify(duplicateStation));
    await assert.rejects(
      runLedgerExporter([
        "--kind", "fare-station-line-mapping",
        "--evidence", path.relative(root, duplicateStationPath),
        "--source-id", "seoul-metro-official-od-fares",
      ]),
      /duplicate station and line mapping/,
    );

    const wrongLine = structuredClone(evidence);
    wrongLine.providerMappings[0].lineId = "seoul-2";
    const wrongLinePath = path.join(workspace, "wrong-line.json");
    await writeFile(wrongLinePath, JSON.stringify(wrongLine));
    await assert.rejects(
      runLedgerExporter([
        "--kind", "fare-station-line-mapping",
        "--evidence", path.relative(root, wrongLinePath),
        "--source-id", "seoul-metro-official-od-fares",
      ]),
      /providerMappings must match fixed targets/,
    );

    const unsafeEvidence = structuredClone(evidence);
    unsafeEvidence.providerMappings[0].rawPath = "/tmp/provider.json";
    const unsafeEvidencePath = path.join(workspace, "unsafe-evidence.json");
    await writeFile(unsafeEvidencePath, JSON.stringify(unsafeEvidence));
    await assert.rejects(
      runLedgerExporter([
        "--kind", "fare-station-line-mapping",
        "--evidence", path.relative(root, unsafeEvidencePath),
        "--source-id", "seoul-metro-official-od-fares",
      ]),
      /rawPath is not allowed/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fare station-line mapping admission은 이미 읽은 evidence 객체로 ledger를 계산한다", async () => {
  const { buildFareStationLineMappingLedger } = await import("./export-ledger-hashes.mjs");
  assert.equal(typeof buildFareStationLineMappingLedger, "function");
  const evidence = officialOdFareEvidenceFixture();
  const ledger = buildFareStationLineMappingLedger(evidence, "seoul-metro-official-od-fares");
  assert.equal(ledger.kind, "fare-station-line-mapping");
  assert.equal(ledger.rowCount, 4);
  assert.match(ledger.ledgerHash, /^[0-9a-f]{64}$/);
});

test("official OD fare admission bundle은 source별 승인만 선택한다", async () => {
  const { officialOdFareAdmissionsBySource } = await import("./lib/official-od-fare-evidence.mjs");
  const trackedBundle = JSON.parse(
    await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"), "utf8"),
  );
  const admission = trackedBundle.admissions.find(
    ({ sourceId }) => sourceId === "seoul-metro-official-od-fares",
  );
  assert.ok(admission);
  const busan = {
    ...admission,
    sourceId: "busan-transportation-official-od-fares",
    snapshotId: "busan-transportation-official-od-fares-20260713",
    evidenceHash: "1".repeat(64),
    quoteSetHash: "2".repeat(64),
    fareStationLineMappingLedgerHash: "3".repeat(64),
    quoteCount: 3,
  };
  const bundle = {
    schemaVersion: 1,
    artifactKind: "official-od-fare-admission-bundle",
    admissions: [admission, busan],
  };

  const admissions = officialOdFareAdmissionsBySource(bundle);
  assert.equal(admissions.size, 2);
  assert.equal(admissions.get(admission.sourceId), admission);
  assert.equal(admissions.get(busan.sourceId), busan);
  assert.throws(
    () => officialOdFareAdmissionsBySource({ ...bundle, admissions: [admission, admission] }),
    /duplicate official OD fare admission sourceId/,
  );
  assert.throws(
    () => officialOdFareAdmissionsBySource({ ...bundle, unexpected: true }),
    /official OD fare admission bundle/,
  );
});

test("official OD fare admin review는 sanitized admission만 생성한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-admission-"));
  try {
    const evidence = officialOdFareEvidenceFixture();
    const evidencePath = path.join(workspace, "evidence.json");
    const evidenceBytes = JSON.stringify(evidence);
    await writeFile(evidencePath, evidenceBytes);
    const review = {
      schemaVersion: 1,
      artifactKind: "official-od-fare-admin-review",
      evidenceHash: sha256(evidenceBytes),
      decision: "APPROVED",
      approvedBy: "owner",
      approvedAt: "2026-07-12T00:00:00.000Z",
      sourceId: "seoul-metro-official-od-fares",
      snapshotId: "seoul-metro-official-od-fares-20260712",
    };
    const reviewPath = path.join(workspace, "review.json");
    await writeFile(reviewPath, JSON.stringify(review));
    const trackedBundle = JSON.parse(
      await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"), "utf8"),
    );
    const preservedAdmission = trackedBundle.admissions.find(
      ({ sourceId }) => sourceId === "busan-transportation-official-od-fares",
    );
    const bundlePath = path.join(workspace, "bundle.json");
    await writeFile(bundlePath, JSON.stringify(trackedBundle));
    const { stdout } = await runOfficialOdFareAdmissionBuilder([
      "--evidence", path.relative(root, evidencePath),
      "--admin-review", path.relative(root, reviewPath),
      "--bundle", path.relative(root, bundlePath),
    ]);
    const bundle = JSON.parse(stdout);
    assert.equal(bundle.artifactKind, "official-od-fare-admission-bundle");
    assert.equal(bundle.schemaVersion, 1);
    assert.deepEqual(
      bundle.admissions.find(({ sourceId }) => sourceId === preservedAdmission.sourceId),
      preservedAdmission,
    );
    const admission = bundle.admissions.find(({ sourceId }) => sourceId === review.sourceId);
    assert.deepEqual(Object.keys(admission).sort(), [
      "approvedAt", "approvedBy", "artifactKind", "decision", "evidenceHash",
      "fareStationLineMappingLedgerHash", "quoteCount", "quoteSetHash", "schemaVersion", "snapshotId", "sourceId",
    ].sort());
    assert.equal(admission.artifactKind, "official-od-fare-admission");
    assert.equal(admission.quoteCount, 2);
    assert.match(admission.quoteSetHash, /^[0-9a-f]{64}$/);
    assert.match(admission.fareStationLineMappingLedgerHash, /^[0-9a-f]{64}$/);
    const generatedBundlePath = path.join(workspace, "generated-bundle.json");
    await writeFile(generatedBundlePath, stdout);
    await execFileAsync(process.execPath, [
      "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
      "--admission", generatedBundlePath,
      "--check",
    ], { cwd: root });

    const unsafeReview = { ...review, rawPath: "/tmp/provider.json" };
    const unsafeReviewPath = path.join(workspace, "unsafe-review.json");
    await writeFile(unsafeReviewPath, JSON.stringify(unsafeReview));
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder([
        "--evidence", path.relative(root, evidencePath),
        "--admin-review", path.relative(root, unsafeReviewPath),
      ]),
      /raw.*not allowed/,
    );

    const mismatchedEvidence = structuredClone(evidence);
    mismatchedEvidence.quotes[0].destinationStationId = "station-unknown";
    const mismatchedPath = path.join(workspace, "mismatched-evidence.json");
    await writeFile(mismatchedPath, JSON.stringify(mismatchedEvidence));
    const mismatchedReview = { ...review, evidenceHash: sha256(JSON.stringify(mismatchedEvidence)) };
    const mismatchedReviewPath = path.join(workspace, "mismatched-review.json");
    await writeFile(mismatchedReviewPath, JSON.stringify(mismatchedReview));
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder([
        "--evidence", path.relative(root, mismatchedPath),
        "--admin-review", path.relative(root, mismatchedReviewPath),
      ]),
      /quote endpoints must match provider mappings/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("부산 official OD fare admission은 공식 운임표 시도 횟수를 보존한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "busan-official-od-fare-admission-"));
  try {
    const evidence = busanOfficialOdFareEvidenceFixture();
    const evidencePath = path.join(workspace, "evidence.json");
    const evidenceBytes = JSON.stringify(evidence);
    await writeFile(evidencePath, evidenceBytes);
    const review = {
      schemaVersion: 1,
      artifactKind: "official-od-fare-admin-review",
      evidenceHash: sha256(evidenceBytes),
      decision: "APPROVED",
      approvedBy: "owner",
      approvedAt: "2026-07-13T00:00:00.000Z",
      sourceId: "busan-transportation-official-od-fares",
      snapshotId: "busan-transportation-official-od-fares-20260713",
    };
    const reviewPath = path.join(workspace, "review.json");
    await writeFile(reviewPath, JSON.stringify(review));

    const { stdout } = await runOfficialOdFareAdmissionBuilder([
      "--evidence", path.relative(root, evidencePath),
      "--admin-review", path.relative(root, reviewPath),
    ]);
    const bundle = JSON.parse(stdout);
    const admission = bundle.admissions.find(({ sourceId }) => sourceId === review.sourceId);
    assert.equal(admission.quoteCount, 3);
    assert.equal(admission.snapshotId, review.snapshotId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("official OD fare admission은 probe 내부 계약과 hash binding을 강제한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-contract-"));
  try {
    const writeCase = async (name, evidence, reviewOverrides = {}) => {
      const evidencePath = path.join(workspace, `${name}-evidence.json`);
      const evidenceBytes = JSON.stringify(evidence);
      await writeFile(evidencePath, evidenceBytes);
      const review = {
        schemaVersion: 1,
        artifactKind: "official-od-fare-admin-review",
        evidenceHash: sha256(evidenceBytes),
        decision: "APPROVED",
        approvedBy: "owner",
        approvedAt: "2026-07-12T00:00:00.000Z",
        sourceId: "seoul-metro-official-od-fares",
        snapshotId: "seoul-metro-official-od-fares-20260712",
        ...reviewOverrides,
      };
      const reviewPath = path.join(workspace, `${name}-review.json`);
      await writeFile(reviewPath, JSON.stringify(review));
      return [
        "--evidence", path.relative(root, evidencePath),
        "--admin-review", path.relative(root, reviewPath),
      ];
    };

    for (const key of ["payload", "raw", "rawObjectUri", "rawPath", "requestUrl"]) {
      const evidence = officialOdFareEvidenceFixture();
      evidence.providerMappings[0][key] = "unsafe";
      await assert.rejects(
        runOfficialOdFareAdmissionBuilder(await writeCase(`unsafe-${key}`, evidence)),
        new RegExp(`${key} is not allowed`),
      );
    }

    const invalidEquivalence = officialOdFareEvidenceFixture();
    invalidEquivalence.equivalence.seoulStationLine4.verified = false;
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder(await writeCase("invalid-equivalence", invalidEquivalence)),
      /equivalence/,
    );

    const invalidAttempts = officialOdFareEvidenceFixture();
    invalidAttempts.attemptCounts["station-sangnoksu→station-sadang"] = 3;
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder(await writeCase("invalid-attempts", invalidAttempts)),
      /attemptCounts/,
    );

    const wrongTarget = officialOdFareEvidenceFixture();
    wrongTarget.providerMappings[0].stationId = "station-unknown";
    wrongTarget.providerMappings[0].stationName = "미확인역";
    wrongTarget.quotes[0].originStationId = "station-unknown";
    wrongTarget.quotes[1].destinationStationId = "station-unknown";
    delete wrongTarget.attemptCounts["station-sangnoksu→station-sadang"];
    delete wrongTarget.attemptCounts["station-sadang→station-sangnoksu"];
    wrongTarget.attemptCounts["station-unknown→station-sadang"] = 1;
    wrongTarget.attemptCounts["station-sadang→station-unknown"] = 1;
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder(await writeCase("wrong-target", wrongTarget)),
      /providerMappings must match fixed targets/,
    );

    const hashMismatch = officialOdFareEvidenceFixture();
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder(await writeCase("hash-mismatch", hashMismatch, {
        evidenceHash: "f".repeat(64),
      })),
      /evidenceHash must match/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("전국 bundled datapack은 수도권·부산 대표 공식 OD를 각 3건 포함한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-fares-"));
  const databasePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      databasePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT origin_station_id AS originStationId,
               destination_station_id AS destinationStationId,
               source_id AS sourceId,
               snapshot_id AS snapshotId
        FROM official_od_fare_quotes
        ORDER BY source_id, origin_station_id, destination_station_id
      `).all().map((row) => ({ ...row }));
      const capitalRows = rows.filter(({ sourceId }) => sourceId.startsWith("seoul-metro-official-od-fare"));
      const busanRows = rows.filter(({ sourceId }) => sourceId === "busan-transportation-official-od-fares");
      assert.equal(capitalRows.length, 3);
      assert.equal(busanRows.length, 3);
      for (const row of rows) {
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM stations WHERE id IN (?, ?)")
          .get(row.originStationId, row.destinationStationId).count, 2);
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote 적용은 admission 일부 source가 빠진 입력을 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-partial-source-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const quotesPath = path.join(directory, "quotes.json");
  try {
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
    const quotes = JSON.parse(
      await readFile(path.join(root, "tools/datapack/official-od-fare-quotes.json"), "utf8"),
    );
    quotes.quotes = quotes.quotes.filter(
      ({ sourceId }) => sourceId === "seoul-metro-official-od-fares",
    );
    await writeFile(quotesPath, JSON.stringify(quotes));
    const originalPackHash = sha256(await readFile(packPath));

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
        "--quotes", quotesPath,
      ], { cwd: root }),
      /quote source set must match admission source set/,
    );
    assert.equal(sha256(await readFile(packPath)), originalPackHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote 재적용은 SQLite와 gzip hash를 변경하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-idempotent-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  try {
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
    const apply = () => execFileAsync(process.execPath, [
      "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
      "--pack", packPath,
      "--index", indexPath,
    ], { cwd: root });

    await apply();
    const firstPack = await readFile(packPath);
    const firstIndex = await readFile(indexPath);
    await apply();

    assert.equal(sha256(await readFile(packPath)), sha256(firstPack));
    assert.equal(sha256(await readFile(indexPath)), sha256(firstIndex));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote check는 catalog user_version 19을 요구한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-check-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 15");
    database.close();
    const sqliteBytes = await readFile(sqlitePath);
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    await writeFile(packPath, gzipBytes);
    const index = JSON.parse(
      await readFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"),
    );
    Object.assign(index.packs.find(({ id }) => id === "capital"), {
      sha256: sha256(gzipBytes),
      sqliteSha256: sha256(sqliteBytes),
      byteSize: gzipBytes.length,
    });
    await writeFile(indexPath, JSON.stringify(index));

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
        "--check",
      ], { cwd: root }),
      /bundled catalog user_version must be 19/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote 후처리기는 v18 production pack을 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-user-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 18");
    database.close();
    await writeFile(packPath, gzipSync(await readFile(sqlitePath), { level: 9, mtime: 0 }));
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);

    const inputPack = await readFile(packPath);
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
      "--pack", packPath,
      "--index", indexPath,
    ], { cwd: root }), /requires catalog user_version 19, got 18/);
    assert.equal(sha256(await readFile(packPath)), sha256(inputPack));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote 후처리기는 v20 catalog를 v19로 낮추지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-newer-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 20");
    database.close();
    const inputPack = gzipSync(await readFile(sqlitePath), { level: 9, mtime: 0 });
    await writeFile(packPath, inputPack);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
      ], { cwd: root }),
      /requires catalog user_version 19, got 20/,
    );

    assert.equal(sha256(await readFile(packPath)), sha256(inputPack));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("수도권 bundled datapack은 빠른하차 차량·출입문 힌트 35건을 포함한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-"));
  const databasePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      databasePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_car_door_hints").get().count, 35);
      const distribution = database.prepare(`
        SELECT station_id AS stationId, line_id AS lineId, COUNT(*) AS count
        FROM station_car_door_hints
        GROUP BY station_id, line_id
        ORDER BY station_id, line_id
      `).all().map((row) => ({ ...row }));
      assert.deepEqual(distribution, [
        { stationId: "station-gangnam", lineId: "seoul-2", count: 10 },
        { stationId: "station-sadang", lineId: "seoul-2", count: 13 },
        { stationId: "station-sadang", lineId: "seoul-4", count: 8 },
        { stationId: "station-seongsu", lineId: "seoul-2", count: 4 },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 차량·출입문 힌트 재적용은 SQLite와 gzip hash를 변경하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-idempotent-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  try {
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
    const apply = () => execFileAsync(process.execPath, [
      "tools/datapack/apply-car-door-hints-to-bundled-pack.mjs",
      "--pack", packPath,
      "--index", indexPath,
    ], { cwd: root });

    await apply();
    const firstPack = await readFile(packPath);
    const firstIndex = await readFile(indexPath);
    await apply();

    assert.equal(sha256(await readFile(packPath)), sha256(firstPack));
    assert.equal(sha256(await readFile(indexPath)), sha256(firstIndex));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 차량·출입문 힌트 check는 catalog user_version 19을 요구한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-check-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 15");
    database.close();
    const sqliteBytes = await readFile(sqlitePath);
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    await writeFile(packPath, gzipBytes);
    const index = JSON.parse(
      await readFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"),
    );
    Object.assign(index.packs.find(({ id }) => id === "capital"), {
      sha256: sha256(gzipBytes),
      sqliteSha256: sha256(sqliteBytes),
      byteSize: gzipBytes.length,
    });
    await writeFile(indexPath, JSON.stringify(index));

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-car-door-hints-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
        "--check",
      ], { cwd: root }),
      /bundled catalog user_version must be 19/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 차량·출입문 힌트 후처리기는 v18 production pack을 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-user-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 18");
    database.close();
    await writeFile(packPath, gzipSync(await readFile(sqlitePath), { level: 9, mtime: 0 }));
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);

    const inputPack = await readFile(packPath);
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/apply-car-door-hints-to-bundled-pack.mjs",
      "--pack", packPath,
      "--index", indexPath,
    ], { cwd: root }), /requires catalog user_version 19, got 18/);
    assert.equal(sha256(await readFile(packPath)), sha256(inputPack));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 차량·출입문 힌트 후처리기는 v20 catalog를 v19로 낮추지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-newer-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 20");
    database.close();
    const inputPack = gzipSync(await readFile(sqlitePath), { level: 9, mtime: 0 });
    await writeFile(packPath, inputPack);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-car-door-hints-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
      ], { cwd: root }),
      /requires catalog user_version 19, got 20/,
    );

    assert.equal(sha256(await readFile(packPath)), sha256(inputPack));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// #1134: 관측 시각을 당기는 분기는 ITX 승격 PR의 입력에서만 실행됐다(main 입력의 관측 시각은 만료 전이다). 순수 시계 도출과 헬퍼 연결부를 직접 검증해
// main 입력에서도 분기와 경계(>=)가 항상 확인된다. 기대값은 도출 함수의 산식이 아니라 입력(고정 원천 수집 시각, 만료)에서 유도한 불변식이다.
test("합성 ITX 시계: 관측 시각이 고정 원천 만료를 넘으면 고정 원천 수집 뒤로 당기고 관측·build 시각이 모두 만료 전이다", () => {
  const expiry = Date.parse("2026-10-10T07:22:23.648Z");
  const pinnedCapture = expiry - 24 * 3_600_000; // P1D 증거: 만료는 수집 24시간 뒤
  const pinnedBuild = pinnedCapture + ITX_SYNTHETIC_CLOCK_STEP_MS; // build는 고정 원천 수집 직후
  for (const observedAfterExpiry of [0, 1, ITX_SYNTHETIC_CLOCK_STEP_MS, 8 * 3_600_000]) {
    const clock = deriveItxSyntheticClock({ observedAtMillis: expiry + observedAfterExpiry, pinnedBuildMillis: pinnedBuild, pinnedTimetableExpiryMillis: expiry });
    assert.equal(clock.rewound, true, `observed ${observedAfterExpiry}ms after expiry`);
    assert.ok(clock.observedAtMillis >= pinnedCapture && clock.observedAtMillis <= pinnedBuild, "rewound observation sits right after the pinned capture, not later");
    assert.ok(clock.observedAtMillis < clock.buildMillis, "build must follow the observation");
    assert.ok(clock.buildMillis >= pinnedBuild, "build must not precede the pinned capture step");
    assert.ok(clock.observedAtMillis < expiry && clock.buildMillis < expiry, "both must be inside the fresh interval");
  }
});

test("합성 ITX 시계: 관측 시각 + 한 걸음이 만료와 같으면 당기고 1ms 전이면 그대로 둔다(경계)", () => {
  const expiry = Date.parse("2026-10-10T07:22:23.648Z");
  const pinnedBuild = expiry - 3_600_000;
  const derive = (observedAtMillis) => deriveItxSyntheticClock({ observedAtMillis, pinnedBuildMillis: pinnedBuild, pinnedTimetableExpiryMillis: expiry });
  const atBoundary = derive(expiry - ITX_SYNTHETIC_CLOCK_STEP_MS);
  assert.equal(atBoundary.rewound, true);
  assert.ok(atBoundary.observedAtMillis < expiry - ITX_SYNTHETIC_CLOCK_STEP_MS, "rewound observation moves before the boundary");
  assert.ok(atBoundary.buildMillis < expiry);
  const justBefore = derive(expiry - ITX_SYNTHETIC_CLOCK_STEP_MS - 1);
  assert.equal(justBefore.rewound, false);
  assert.equal(justBefore.observedAtMillis, expiry - ITX_SYNTHETIC_CLOCK_STEP_MS - 1, "an observation inside the interval is kept as is");
  assert.ok(justBefore.buildMillis > justBefore.observedAtMillis && justBefore.buildMillis < expiry);
  // 관측이 고정 원천 build보다 먼저면 관측은 건드리지 않고 build는 고정 원천 뒤에 둔다.
  const early = derive(pinnedBuild - 5 * ITX_SYNTHETIC_CLOCK_STEP_MS);
  assert.equal(early.rewound, false);
  assert.equal(early.observedAtMillis, pinnedBuild - 5 * ITX_SYNTHETIC_CLOCK_STEP_MS);
  assert.ok(early.buildMillis >= pinnedBuild && early.buildMillis < expiry);
});

test("합성 ITX 시계: 고정 원천 직후 build 시각도 만료 전에 둘 수 없으면 실패한다 (신선한 척하지 않는다)", () => {
  const expiry = Date.parse("2026-10-10T07:22:23.648Z");
  assert.throws(() => deriveItxSyntheticClock({ observedAtMillis: expiry + 1, pinnedBuildMillis: expiry, pinnedTimetableExpiryMillis: expiry }), /pinned timetable freshness interval/u);
  assert.throws(() => deriveItxSyntheticClock({ observedAtMillis: expiry - 10_000, pinnedBuildMillis: expiry + 5_000, pinnedTimetableExpiryMillis: expiry }), /pinned timetable freshness interval/u);
});

// 헬퍼 연결부: 당긴 관측 시각이 source, completeness 두 문서에 쓰이고 build 시계가 만료 전인지 헬퍼 전체를 호출해 확인한다.
// 관측 시각을 만료 뒤로 주입하므로 ITX 승격 PR이 아닌 main 입력에서도 연결부가 실행된다.
async function pinnedIncheonTimetableWindows() {
  const buildSpec = JSON.parse(await readCandidateFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
  const inventory = JSON.parse(await readCandidateFile(buildSpec.networkEdgeEvidence.sourceInventory.path, "utf8"));
  const windows = inventory.sources.filter(({ id }) => id === "incheon-line1-train-timetable" || id === "incheon-line2-train-timetable")
    .map(({ scheduleAdmissionEvidence }) => ({ capturedAt: Date.parse(scheduleAdmissionEvidence.capturedAt), freshUntil: Date.parse(scheduleAdmissionEvidence.freshUntil) }));
  assert.equal(windows.length, 2, "both pinned Incheon timetable sources must exist");
  assert.ok(windows.every(({ capturedAt, freshUntil }) => Number.isFinite(capturedAt) && Number.isFinite(freshUntil)));
  return { latestCapture: Math.max(...windows.map(({ capturedAt }) => capturedAt)), expiry: Math.min(...windows.map(({ freshUntil }) => freshUntil)) };
}

test("합성 ITX 입력 헬퍼: 만료를 지난 관측을 주입하면 source·completeness 관측 시각과 build 시계가 모두 고정 원천 신선 구간 안으로 당겨진다", async () => {
  const { latestCapture, expiry } = await pinnedIncheonTimetableWindows();
  const injected = new Date(expiry + 8 * 3_600_000).toISOString();
  const workspace = await mkdtemp(path.join(tmpdir(), "itx-synthetic-clock-rewind-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace, { observedAtOverride: injected });
    const fixtureDirectory = path.join(inputs.repositoryRoot, "tools/datapack/fixtures/current-itx");
    const source = JSON.parse(await readFile(path.join(fixtureDirectory, "itx-source.json"), "utf8"));
    const completeness = JSON.parse(await readFile(path.join(fixtureDirectory, "itx-completeness.json"), "utf8"));
    const buildNow = Date.parse(inputs.env.EASYSUBWAY_DATAPACK_BUILD_NOW);
    assert.notEqual(source.observedAt, injected, "the injected observation after the expiry must be rewound");
    assert.equal(completeness.observedAt, source.observedAt, "completeness and source observations must agree");
    for (const [label, value] of [["source.observedAt", Date.parse(source.observedAt)], ["completeness.observedAt", Date.parse(completeness.observedAt)]]) {
      assert.ok(value >= latestCapture && value < expiry, `${label} must be inside the pinned fresh interval`);
    }
    assert.ok(buildNow > Date.parse(source.observedAt) && buildNow < expiry, "build clock must follow the observation and precede the expiry");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("합성 ITX 입력 헬퍼: 만료 전 관측을 주입하면 당기지 않고 그대로 쓴다", async () => {
  const { latestCapture, expiry } = await pinnedIncheonTimetableWindows();
  const injected = new Date(latestCapture + 60_000).toISOString();
  assert.ok(Date.parse(injected) + ITX_SYNTHETIC_CLOCK_STEP_MS < expiry);
  const workspace = await mkdtemp(path.join(tmpdir(), "itx-synthetic-clock-kept-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace, { observedAtOverride: injected });
    const source = JSON.parse(await readFile(path.join(inputs.repositoryRoot, "tools/datapack/fixtures/current-itx/itx-source.json"), "utf8"));
    assert.equal(source.observedAt, injected);
    const buildNow = Date.parse(inputs.env.EASYSUBWAY_DATAPACK_BUILD_NOW);
    assert.ok(buildNow > Date.parse(injected) && buildNow < expiry);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// 합성 ITX 시계의 한 걸음: 관측은 직전 시각(고정 원천 수집, 관측)보다 이 간격만큼 뒤에 일어난 것으로 본다. 도출 함수와 그 테스트가 같은 값을 쓴다.
const ITX_SYNTHETIC_CLOCK_STEP_MS = 1_000;

// 합성 ITX 후보의 관측 시각과 build 시각을 정한다(#1132, #1134). 이 함수와 테스트는 합성 fixture의 위생만 지킨다(생산 동작은 검증하지 않는다).
// 관측 시각 + 한 걸음이 고정된 P1D 증거의 만료 이상이면 관측을 고정 원천 수집 직후(pinnedBuildMillis의 한 걸음 앞)로 당기고, 아니면 그대로 둔다.
// 어느 쪽이든 관측 시각, build 시각이 모두 그 만료 전이어야 하고 만들 수 없으면 실패한다.
function deriveItxSyntheticClock({ observedAtMillis, pinnedBuildMillis, pinnedTimetableExpiryMillis }) {
  const rewound = observedAtMillis + ITX_SYNTHETIC_CLOCK_STEP_MS >= pinnedTimetableExpiryMillis;
  const derivedObservedAtMillis = rewound ? pinnedBuildMillis - ITX_SYNTHETIC_CLOCK_STEP_MS : observedAtMillis;
  const buildMillis = Math.max(pinnedBuildMillis, derivedObservedAtMillis + ITX_SYNTHETIC_CLOCK_STEP_MS);
  if (buildMillis >= pinnedTimetableExpiryMillis) {
    throw new Error("fixture current build clock is not inside the pinned timetable freshness interval");
  }
  return { rewound, observedAtMillis: derivedObservedAtMillis, buildMillis };
}

async function writeCurrentItxReleaseInputs(
  workspace,
  { mutateFixture, mutateTopologyEvidence, mutateCompleteness, mutateCurrentSourceContext, observedAtOverride } = {},
) {
  const repositoryRoot = await writeTransitionFreeCandidateRoot(workspace);
  const currentIdentity = {
    artifactKind: "station-catalog-pack",
    manifestVersion: 1,
    catalogPackId: "capital",
    stationSetSha256: "1".repeat(64),
    payloadSha256: "2".repeat(64),
    manifestSha256: "3".repeat(64),
  };
  const itxFixtureDirectory = path.join(repositoryRoot, "tools/datapack/fixtures/current-itx");
  await mkdir(itxFixtureDirectory, { recursive: true });
  const fixture = JSON.parse(await readCandidateFile("tools/datapack/release/capital-production-canonical-pack.json", "utf8"));
  for (const pack of fixture.packs) delete pack.routeServiceArtifactEvidence;
  const topologyEvidence = JSON.parse(await readCandidateFile("tools/datapack/itx-cheongchun-topology-evidence.json", "utf8"));
  const sourceArtifactId = topologyEvidence.sourceArtifact?.id;
  assert.match(sourceArtifactId, /^itx-cheongchun-source-timetable-[0-9]+$/u, "current ITX source artifact identity");

  const completeness = JSON.parse(await readCandidateFile(
    `tools/datapack/sources/${sourceArtifactId}-completeness-evidence.json`,
    "utf8",
  ));
  completeness.stationCatalogPackIdentity = structuredClone(currentIdentity);
  mutateCompleteness?.(completeness);
  const { evidenceHash: _completenessEvidenceHash, ...completenessWithoutEvidenceHash } = completeness;
  completeness.evidenceHash = sha256(Buffer.from(JSON.stringify(completenessWithoutEvidenceHash)));
  const completenessPath = path.join(itxFixtureDirectory, "itx-completeness.json");
  let completenessBytes = Buffer.from(`${JSON.stringify(completeness)}\n`);
  await writeFile(completenessPath, completenessBytes);

  const source = JSON.parse(await readCandidateFile(
    `tools/datapack/sources/${sourceArtifactId}.json`,
    "utf8",
  ));
  delete source.canonicalPackIdentity;
  source.stationCatalogPackIdentity = structuredClone(currentIdentity);
  source.completenessEvidenceSha256 = sha256(completenessBytes);
  const { evidenceHash: _sourceEvidenceHash, ...sourceWithoutEvidenceHash } = source;
  source.evidenceHash = sha256(Buffer.from(JSON.stringify(sourceWithoutEvidenceHash)));
  projectItxTopologyIntoCanonicalFixture(fixture, deriveItxTopology(source));
  mutateFixture?.(fixture);
  const sourcePath = path.join(itxFixtureDirectory, "itx-source.json");
  let sourceBytes = Buffer.from(`${JSON.stringify(source)}\n`);
  await writeFile(sourcePath, sourceBytes);

  const currentAdmissionPath = path.join(workspace, "itx-current-admission.json");
  let currentAdmissionBytes;

  const contract = JSON.parse(await readCandidateFile("tools/datapack/itx-cheongchun-coverage-contract.json", "utf8"));
  const admission = contract.officialEvidence.korailCompletenessAdmission;
  delete admission.canonicalPackIdentity;
  admission.stationCatalogPackIdentity = structuredClone(currentIdentity);
  admission.topologyInputPackIdentity = {
    id: topologyEvidence.pack.id,
    sha256: topologyEvidence.pack.inputSha256,
    sqliteSha256: topologyEvidence.pack.inputSqliteSha256,
    byteSize: topologyEvidence.pack.inputByteSize,
  };
  Object.assign(contract.sourceTimetableArtifact, {
    artifactId: source.artifactId,
    artifactPath: path.relative(repositoryRoot, sourcePath),
    sha256: sha256(sourceBytes),
    completenessEvidencePath: path.relative(repositoryRoot, completenessPath),
    completenessEvidenceSha256: sha256(completenessBytes),
    freshUntil: source.freshUntil,
    policyVersion: source.policyVersion,
  });
  const contractPath = path.join(workspace, "itx-coverage-contract.json");
  let contractBytes = Buffer.from(`${JSON.stringify(contract)}\n`);
  await writeFile(contractPath, contractBytes);

  delete topologyEvidence.readmissions;
  topologyEvidence.stationCatalogPackIdentity = structuredClone(currentIdentity);
  topologyEvidence.sourceArtifact.stationCatalogPackIdentity = structuredClone(currentIdentity);
  mutateTopologyEvidence?.(topologyEvidence);
  const topologyEvidencePath = path.join(workspace, "itx-topology-evidence.json");
  let topologyEvidenceBytes = Buffer.from(`${JSON.stringify(topologyEvidence)}\n`);
  await writeFile(topologyEvidencePath, topologyEvidenceBytes);

  const fixturePath = path.join(workspace, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);
  const buildSpec = JSON.parse(await readCandidateFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
  delete buildSpec.assemblySourceIds;
  delete buildSpec.productionScope;
  buildSpec.sourceSnapshots = (buildSpec.sourceSnapshots ?? []).filter((s) => s.adminReviewRecordHash);
  buildSpec.sourceSnapshotIds = buildSpec.sourceSnapshots.map((s) => s.snapshotId);
  buildSpec.sourceSnapshotSetHash = "a1638b3df8e92c59db8525b68d687580177345cc983a22645f60833f52322fb0";
  const sourceInventory = JSON.parse(await readCandidateFile(buildSpec.networkEdgeEvidence.sourceInventory.path, "utf8"));
  const currentInventory = structuredClone(sourceInventory);
  const currentTopologySources = currentInventory.sources.filter(
    ({ id }) => id === "seoul-metro-route-map-positions",
  );
  assert.equal(currentTopologySources.length, 1, "fixture current topology source must exist once");
  const [currentTopologySource] = currentTopologySources;
  const currentTopologyAuthority =
    currentTopologySource.routeMapAdmissionEvidence?.currentTopologyAdmission;
  const { topologySnapshotId: currentTopologySnapshotId } =
    currentTopologyAuthority ?? {};
  assert.ok(currentTopologySnapshotId != null, "fixture current topology admission is required");
  const baselineTopologyBinding = buildSpec.networkEdgeEvidence.capitalTopology;
  const baselineTopologySourceBytes = await readCandidateFile(baselineTopologyBinding.path);
  assert.equal(
    sha256(baselineTopologySourceBytes),
    baselineTopologyBinding.sha256,
    "fixture baseline topology binding must match its bytes",
  );
  const baselineTopology = projectCapitalTopologyOwnership(
    JSON.parse(baselineTopologySourceBytes),
  );
  const baselineTopologyBytes = Buffer.from(`${JSON.stringify(baselineTopology)}\n`);
  const candidateTopologyBytes = await readCandidateFile(
    `tools/datapack/sources/${currentTopologySnapshotId}.json`,
  );
  const candidateTopology = JSON.parse(candidateTopologyBytes);
  assert.equal(
    candidateTopology.sourceId,
    currentTopologySource.routeMapAdmissionEvidence.topologySourceId,
    "fixture current topology authority source must match candidate",
  );
  assert.equal(
    currentTopologyAuthority.topologyContentSha256,
    candidateTopology.contentSha256,
    "fixture current topology authority content must match candidate",
  );
  assert.equal(
    currentTopologyAuthority.reviewedAt,
    candidateTopology.capturedAt,
    "fixture current topology authority review time must match candidate",
  );
  assert.equal(
    currentTopologyAuthority.freshUntil,
    candidateTopology.freshUntil,
    "fixture current topology authority freshness must match candidate",
  );
  const baselineTopologyPath = path.join(workspace, "capital-topology-baseline.json");
  const candidateTopologyPath = path.join(workspace, "capital-topology-candidate.json");
  const topologyReverificationPath = path.join(workspace, "capital-topology-reverification.json");
  const topologyReverification = buildCapitalTopologyReverificationEvidence(
    baselineTopology,
    candidateTopology,
  );
  topologyReverification.baseline.snapshotId = baselineTopologyBinding.snapshotId;
  const topologyReverificationBytes = Buffer.from(`${JSON.stringify(topologyReverification)}\n`);
  const candidateTopologyAdmissions = new Map(candidateTopology.lines.map(({ lineId }) => [lineId, {
    verifiedAt: candidateTopology.capturedAt,
    freshUntil: candidateTopology.freshUntil,
  }]));
  // observedAtOverride: 관측 시각을 주입한다. 승격 PR 입력이 아니어도 시각 당김 연결부를 실행하게 한다(#1134).
  let sourceObservedAt = observedAtOverride ?? source.observedAt;
  const sourceFreshUntil = source.freshUntil;
  const incheonSources = currentInventory.sources.filter(({ id }) => id === "incheon-transit-station-info");
  if (incheonSources.length !== 1) throw new Error("fixture current Incheon topology admission is required");
  const currentIncheonCapturedAt = incheonSources[0].topologyAdmissionEvidence?.capturedAt;
  const incheonAccessibilitySources = currentInventory.sources.filter(
    ({ id }) => id === "incheon-transit-accessibility",
  );
  if (incheonAccessibilitySources.length !== 1) throw new Error("fixture registered Incheon accessibility source is required");
  const incheonAccessibilitySource = incheonAccessibilitySources[0];
  const incheonAccessibilityRegistration = incheonAccessibilitySource.registrationEvidence;
  if (incheonAccessibilityRegistration?.sourceId !== incheonAccessibilitySource.id
    || typeof incheonAccessibilityRegistration.snapshotId !== "string"
    || typeof incheonAccessibilityRegistration.snapshotFileSha256 !== "string") {
    throw new Error("fixture registered Incheon accessibility identity is required");
  }
  const incheonAccessibilitySourcePath = `tools/datapack/sources/${incheonAccessibilityRegistration.snapshotId}.json`;
  const incheonAccessibilitySourceBytes = await readCandidateFile(incheonAccessibilitySourcePath);
  assert.equal(
    sha256(incheonAccessibilitySourceBytes),
    incheonAccessibilityRegistration.snapshotFileSha256,
    "fixture registered Incheon accessibility bytes must match registration",
  );
  const incheonAccessibilitySourceSnapshot = JSON.parse(incheonAccessibilitySourceBytes);
  if (incheonAccessibilitySourceSnapshot.sourceId !== incheonAccessibilitySource.id
    || incheonAccessibilitySourceSnapshot.snapshotId !== incheonAccessibilityRegistration.snapshotId
    || incheonAccessibilitySourceSnapshot.rawSha256 !== incheonAccessibilityRegistration.snapshotRawSha256
    || incheonAccessibilitySourceSnapshot.contentSha256 !== incheonAccessibilityRegistration.contentSha256
    || incheonAccessibilitySourceSnapshot.schemaFingerprint !== incheonAccessibilityRegistration.normalizedSchemaFingerprint
    || incheonAccessibilitySourceSnapshot.capturedAt !== incheonAccessibilityRegistration.capturedAt) {
    throw new Error("fixture registered Incheon accessibility snapshot identity is invalid");
  }
  const currentIncheonAccessibilityCapturedAt = incheonAccessibilitySourceSnapshot.capturedAt;
  const incheonTimetableSourceIds = [
    "incheon-line1-train-timetable",
    "incheon-line2-train-timetable",
  ];
  const incheonTimetableSources = currentInventory.sources.filter(
    ({ id }) => incheonTimetableSourceIds.includes(id),
  );
  assert.equal(
    incheonTimetableSources.length,
    incheonTimetableSourceIds.length,
    "fixture current Incheon timetable sources must exist exactly once",
  );
  assert.deepEqual(
    incheonTimetableSources.map(({ id }) => id).toSorted(),
    incheonTimetableSourceIds,
    "fixture current Incheon timetable source IDs must match",
  );
  const currentIncheonTimetableCapturedAts = incheonTimetableSources.map((source) => {
    const capturedAt = source.scheduleAdmissionEvidence?.capturedAt;
    const timestamp = typeof capturedAt === "string" ? Date.parse(capturedAt) : Number.NaN;
    if (Number.isNaN(timestamp)) {
      throw new Error(`fixture current ${source.id} timetable admission capture time is invalid`);
    }
    return capturedAt;
  });
  const clockMillis = (value) => {
    const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(timestamp)) throw new Error("fixture current build clock input is invalid");
    return timestamp;
  };
  const pinnedBuildMillis = Math.max(...[
    candidateTopology.capturedAt,
    currentIncheonCapturedAt,
    currentIncheonAccessibilityCapturedAt,
    ...currentIncheonTimetableCapturedAts,
  ].map(clockMillis)) + 1_000;
  // 이 합성 후보는 후보가 고정한 inventory(seq 발행 시점)에 현재 ITX 원천을 얹는다. 고정된 인천 시간표 증거는 P1D라서 만료 뒤에 build할 수 없는데,
  // 새 ITX 승격은 그 만료보다 늦게 관측될 수 있다(#1132). 그러면 관측 시각을 고정 원천 직후로 당겨 합성 관측이 고정 원천의 신선 구간 안에 머물게 한다.
  // 서비스 일자(오늘~13일)와 freshUntil은 관측 시각이 아니라 일자에서 정해지므로 그대로 유효하다. 운영 후보 재생성은 같은 시점에 P1D 증거도 함께 갱신한다.
  const pinnedTimetableExpiryMillis = Math.min(...incheonTimetableSources.map(({ id, scheduleAdmissionEvidence }) => {
    if (scheduleAdmissionEvidence?.freshUntil === undefined) throw new Error(`fixture current ${id} timetable admission freshness is invalid`);
    return clockMillis(scheduleAdmissionEvidence.freshUntil);
  }));
  const syntheticClock = deriveItxSyntheticClock({
    observedAtMillis: clockMillis(sourceObservedAt),
    pinnedBuildMillis,
    pinnedTimetableExpiryMillis,
  });
  if (syntheticClock.rewound) {
    sourceObservedAt = new Date(syntheticClock.observedAtMillis).toISOString();
    completeness.observedAt = sourceObservedAt;
  }
  const buildNow = new Date(syntheticClock.buildMillis).toISOString();
  Object.assign(completeness.sourceTimetableArtifact, {
    artifactId: sourceArtifactId,
    freshUntil: sourceFreshUntil,
  });
  const { evidenceHash: _refreshedCompletenessEvidenceHash, ...refreshedCompletenessWithoutEvidenceHash } = completeness;
  completeness.evidenceHash = sha256(Buffer.from(JSON.stringify(refreshedCompletenessWithoutEvidenceHash)));
  completenessBytes = Buffer.from(`${JSON.stringify(completeness)}\n`);
  await writeFile(completenessPath, completenessBytes);
  Object.assign(source, {
    artifactId: sourceArtifactId,
    observedAt: sourceObservedAt,
    freshUntil: sourceFreshUntil,
    completenessEvidenceSha256: sha256(completenessBytes),
  });
  const { evidenceHash: _refreshedSourceEvidenceHash, ...refreshedSourceWithoutEvidenceHash } = source;
  source.evidenceHash = sha256(Buffer.from(JSON.stringify(refreshedSourceWithoutEvidenceHash)));
  sourceBytes = Buffer.from(`${JSON.stringify(source)}\n`);
  await writeFile(sourcePath, sourceBytes);
  Object.assign(contract.sourceTimetableArtifact, {
    artifactId: source.artifactId,
    sha256: sha256(sourceBytes),
    completenessEvidenceSha256: sha256(completenessBytes),
    freshUntil: sourceFreshUntil,
    // 합성 원천은 후보가 고정한 contract의 승격 근거(승인 모드의 승인 sha 또는 게이트 모드의 영수증)를 이어받을 수 없다. 원천 바이트가 달라지기 때문이다.
    // 고정 contract가 승인 모드든 게이트 모드든(#1135 이후 후보) 같은 합성 입력이 되도록 승인 모드 근거를 직접 구성한다(#1150).
    // 게이트 모드의 영수증 재계산은 itx-promotion-authority.test.mjs가 따로 검증한다.
    promotion: {
      mode: "CURRENT_CANDIDATE_OWNER_APPROVED",
      approvalUrl: "https://github.com/AquilaXk/easysubway-data/issues/636#issuecomment-1",
      approvedArtifactSha256: sha256(sourceBytes),
    },
  });
  contract.freshness.nextReviewAt = sourceFreshUntil;
  contractBytes = Buffer.from(`${JSON.stringify(contract)}\n`);
  await writeFile(contractPath, contractBytes);
  Object.assign(topologyEvidence.sourceArtifact, {
    id: source.artifactId,
    sha256: sha256(sourceBytes),
    completenessEvidenceSha256: sha256(completenessBytes),
    freshUntil: sourceFreshUntil,
  });
  topologyEvidenceBytes = Buffer.from(`${JSON.stringify(topologyEvidence)}\n`);
  await writeFile(topologyEvidencePath, topologyEvidenceBytes);
  const currentAdmission = syntheticCurrentItxTopologyAdmission({
    source,
    previousArtifactSha256: sha256(sourceBytes),
    observedAt: sourceObservedAt,
    serviceDate: currentItxAdmissionServiceDate(source),
  });
  currentAdmissionBytes = Buffer.from(`${JSON.stringify(currentAdmission)}\n`);
  await writeFile(currentAdmissionPath, currentAdmissionBytes);
  for (const source of currentInventory.sources.filter(({ routeMapAdmissionEvidence }) =>
    routeMapAdmissionEvidence?.topologySourceId === candidateTopology.sourceId)) {
    const admission = source.routeMapAdmissionEvidence.currentTopologyAdmission;
    assert.ok(admission != null, `${source.id} current topology admission is required`);
    Object.assign(admission, {
      topologySnapshotId: currentTopologySnapshotId,
      topologyContentSha256: candidateTopology.contentSha256,
      reviewedAt: candidateTopology.capturedAt,
      freshUntil: candidateTopology.freshUntil,
    });
    admission.topologyLineages = admission.topologyLineages.map((lineage) => ({
      ...lineage,
      snapshotId: currentTopologySnapshotId,
      contentSha256: candidateTopology.contentSha256,
    }));
  }
  projectCapitalTopologyIntoCanonicalFixture(
    fixture,
    candidateTopology,
    currentTopologySnapshotId,
    candidateTopologyAdmissions,
  );
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);
  await Promise.all([
    writeFile(baselineTopologyPath, baselineTopologyBytes),
    writeFile(candidateTopologyPath, candidateTopologyBytes),
    writeFile(topologyReverificationPath, topologyReverificationBytes),
  ]);
  Object.assign(buildSpec.networkEdgeEvidence.capitalTopology, {
    path: baselineTopologyPath,
    sha256: sha256(baselineTopologyBytes),
    snapshotId: baselineTopologyBinding.snapshotId,
  });
  Object.assign(buildSpec.networkEdgeEvidence.capitalTopologyCandidate, {
    path: candidateTopologyPath,
    sha256: sha256(candidateTopologyBytes),
    snapshotId: currentTopologySnapshotId,
  });
  Object.assign(buildSpec.networkEdgeEvidence.capitalTopologyReverification, {
    path: topologyReverificationPath,
    sha256: sha256(topologyReverificationBytes),
  });
  const incheonSource = incheonSources[0];
  const incheonSnapshotPath = path.join(repositoryRoot, incheonSource.routeMapAdmissionEvidence.snapshotPath);
  const incheonSnapshotBytes = await readFile(incheonSnapshotPath);
  const incheonSnapshot = JSON.parse(incheonSnapshotBytes);
  const currentLedgerPath = path.join(
    repositoryRoot,
    "tools/datapack/release/source-snapshots.json",
  );
  const currentLedger = JSON.parse(await readFile(currentLedgerPath, "utf8"));
  mutateCurrentSourceContext?.({ buildSpec, currentInventory, currentLedger });
  await writeFile(currentLedgerPath, `${JSON.stringify(currentLedger)}\n`);
  const selectedSnapshotIds = new Set(buildSpec.sourceSnapshotIds);
  const selectedLedger = currentLedger.filter(({ snapshotId }) => selectedSnapshotIds.has(snapshotId));
  assert.equal(
    selectedLedger.length,
    selectedSnapshotIds.size,
    "fixture candidate source-set must be ledger-complete before strict Incheon validation",
  );
  buildSpec.sourceSnapshotSetHash = sha256(JSON.stringify(selectedLedger));
  const now = new Date(buildNow);
  const incheonTopologyAdmission = admittedIncheonTopologyEvidence({
    sourceInventory: currentInventory,
    snapshot: incheonSnapshot,
    snapshotBytes: incheonSnapshotBytes,
    now,
  });
  const stagedIncheonAccessibilityPath = path.join(repositoryRoot, incheonAccessibilitySourcePath);
  await mkdir(path.dirname(stagedIncheonAccessibilityPath), { recursive: true });
  await writeFile(stagedIncheonAccessibilityPath, incheonAccessibilitySourceBytes);
  const incheonTimetables = buildSpec.networkEdgeEvidence.incheonTimetables;
  assert.deepEqual(
    Object.keys(incheonTimetables ?? {}).toSorted(),
    ["line1", "line2"],
    "fixture pinned Incheon timetable evidence must have exact line keys",
  );
  for (const lineId of ["line1", "line2"]) {
    const timetableBinding = incheonTimetables[lineId];
    assert.deepEqual(
      Object.keys(timetableBinding ?? {}).toSorted(),
      ["path", "sha256", "snapshotId"],
      `fixture pinned Incheon ${lineId} timetable binding keys`,
    );
    const timetablePath = timetableBinding.path;
    assert.equal(typeof timetablePath, "string", `fixture pinned Incheon ${lineId} timetable path`);
    assert.equal(path.posix.isAbsolute(timetablePath), false, `fixture pinned Incheon ${lineId} timetable path must be relative`);
    assert.equal(timetablePath.includes("\\\\"), false, `fixture pinned Incheon ${lineId} timetable path separator`);
    assert.equal(
      timetablePath.split("/").some((part) => part === "" || part === "." || part === ".."),
      false,
      `fixture pinned Incheon ${lineId} timetable path segments`,
    );
    const timetableBytes = await readCandidateFile(timetablePath);
    assert.equal(
      sha256(timetableBytes),
      timetableBinding.sha256,
      `fixture pinned Incheon ${lineId} timetable binding must match its bytes`,
    );
    const stagedTimetablePath = path.join(repositoryRoot, timetablePath);
    await mkdir(path.dirname(stagedTimetablePath), { recursive: true });
    await writeFile(stagedTimetablePath, timetableBytes);
  }
  const incheonAccessibilityAdmission = await admittedRegisteredIncheonAccessibilityEvidence(buildSpec, {
    sourceInventory: currentInventory,
    topologySnapshot: incheonSnapshot,
    repositoryRoot,
    topologyMode: "registered-topology-successor",
    now,
  });
  const incheonAccessibilityBase = structuredClone(fixture);
  for (const pack of incheonAccessibilityBase.packs) {
    pack.sourceInventory = (pack.sourceInventory ?? []).filter(
      ({ id }) => id !== "incheon-transit-accessibility",
    );
    pack.facilities = (pack.facilities ?? []).filter(
      ({ sourceId }) => sourceId !== "incheon-transit-accessibility",
    );
    pack.stationFacilityEvidence = (pack.stationFacilityEvidence ?? []).filter(
      ({ sourceId }) => sourceId !== "incheon-transit-accessibility",
    );
  }
  Object.assign(fixture, materializeIncheonAccessibility({
    baseFixture: incheonAccessibilityBase,
    accessibilitySnapshot: incheonAccessibilitySourceSnapshot,
    accessibilitySnapshotBytes: incheonAccessibilitySourceBytes,
    topologySnapshot: incheonSnapshot,
    inventory: currentInventory,
    topologyMode: "registered-topology-successor",
    now,
  }));
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);
  await bindCandidateAccessibilityContextToFixture({
    fixture,
    buildSpec,
    currentInventory,
    repositoryRoot,
  });
  validateProductionIncheonAccessibilityFixture(fixture.packs, incheonAccessibilityAdmission.admission);
  const currentInventoryPath = path.join(workspace, "source-inventory.json");
  const currentInventoryBytes = Buffer.from(`${JSON.stringify(currentInventory)}\n`);
  await writeFile(currentInventoryPath, currentInventoryBytes);
  buildSpec.fixturePath = fixturePath;
  if (buildSpec.fixtureSha256 !== undefined) {
    buildSpec.fixtureSha256 = sha256(await readFile(fixturePath));
  }
  buildSpec.sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(currentInventory)));
  buildSpec.networkEdgeEvidence.sourceInventory = { path: currentInventoryPath, sha256: sha256(currentInventoryBytes) };
  Object.assign(buildSpec.networkEdgeEvidence.capitalTopologyAdmission, {
    snapshotId: buildSpec.networkEdgeEvidence.capitalTopologyCandidate.snapshotId,
    contentSha256: candidateTopology.contentSha256, reviewedAt: candidateTopology.capturedAt,
    reverifiedAt: candidateTopology.capturedAt, freshUntil: candidateTopology.freshUntil,
  });
  buildSpec.itxTopologyEvidencePath = topologyEvidencePath;
  buildSpec.itxTopologyEvidenceSha256 = sha256(topologyEvidenceBytes);
  buildSpec.networkEdgeEvidence.itxCoverageContract = {
    path: contractPath,
    sha256: sha256(contractBytes),
  };
  buildSpec.networkEdgeEvidence.itxCurrentTopologyAdmission = {
    path: currentAdmissionPath, sha256: sha256(currentAdmissionBytes),
  };
  const buildSpecPath = path.join(workspace, "build-spec.json");
  await writeFile(buildSpecPath, await bindCurrentProductionScopePolicy(buildSpec, repositoryRoot));
  return {
    buildSpecPath,
    env: {
      ...productionEnv,
      EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow,
    },
    repositoryRoot,
  };
}

function nextKstMidnight(serviceDate) {
  if (typeof serviceDate !== "string" || !/^\d{8}$/u.test(serviceDate)) throw new Error("synthetic ITX admission service date mismatch");
  const date = new Date(Date.UTC(Number(serviceDate.slice(0, 4)), Number(serviceDate.slice(4, 6)) - 1, Number(serviceDate.slice(6, 8))));
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T00:00:00+09:00`;
}

function currentItxAdmissionServiceDate(source) {
  const freshUntil = source.freshUntil;
  if (typeof freshUntil !== "string" || Number.isNaN(Date.parse(freshUntil))) throw new Error("synthetic ITX admission freshness mismatch");
  const matchingDates = [...new Set(Object.values(source.selectedServiceDates ?? {}))]
    .filter((serviceDate) => typeof serviceDate === "string" && /^\d{8}$/u.test(serviceDate) && nextKstMidnight(serviceDate) === freshUntil);
  if (matchingDates.length !== 1) throw new Error("synthetic ITX admission service date mismatch");
  return matchingDates[0];
}

function syntheticCurrentItxTopologyAdmission({ source, previousArtifactSha256, observedAt, serviceDate }) {
  const freshUntil = source.freshUntil;
  if (typeof freshUntil !== "string" || Number.isNaN(Date.parse(freshUntil)) || nextKstMidnight(serviceDate) !== freshUntil) throw new Error("synthetic ITX admission freshness mismatch");
  const tuples = [...new Map((source.stationSequences ?? []).flatMap(({ stops = [] }) =>
    stops.slice(1).map((to, index) => [stops[index].stationId, to.stationId, "ITX_CHEONGCHUN"])
  ).map((tuple) => [JSON.stringify(tuple), tuple])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  const stationIds = [...new Set(tuples.flatMap(([fromStationId, toStationId]) => [fromStationId, toStationId]))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const reconstructionSummary = {
    trainCount: source.stationSequences.length,
    stopCount: source.stationSequences.reduce((sum, { stops = [] }) => sum + stops.length, 0),
    conflictingTimestampCount: 0,
    missingPairCount: 0,
    duplicateOdCount: 0,
  };
  const artifact = {
    schemaVersion: 1,
    artifactKind: "itx-current-network-edge-admission",
    artifactId: `itx-current-network-edge-admission-${serviceDate}`,
    serviceId: "ITX_CHEONGCHUN",
    sourceIssue: 2776,
    status: "ADMITTED",
    scheduleAdmissionStatus: "MISSING",
    topologyMode: "UNCHANGED_AUTO_STATION_SET",
    serviceDate,
    observedAt,
    freshUntil,
    collectionSha256: sha256(Buffer.from(JSON.stringify(source))),
    previousArtifactSha256,
    stationSetHash: sha256(Buffer.from(JSON.stringify(stationIds))),
    odMatrixHash: sha256(Buffer.from(JSON.stringify(tuples))),
    operationEvidenceSha256: sha256(Buffer.from(JSON.stringify(source.stationSequences))),
    stationSequenceSha256: sha256(Buffer.from(JSON.stringify(source.stationSequences))),
    canonicalStationSetSha256: sha256(Buffer.from(JSON.stringify(stationIds))),
    observedPairSetSha256: sha256(Buffer.from(JSON.stringify(tuples))),
    admittedPairSetSha256: sha256(Buffer.from(JSON.stringify(tuples))),
    observedPairChange: {
      addedCount: 0,
      removedCount: 0,
      addedSha256: sha256(Buffer.from(JSON.stringify([]))),
      removedSha256: sha256(Buffer.from(JSON.stringify([]))),
    },
    pairHashes: tuples.map((tuple) => sha256(Buffer.from(JSON.stringify(tuple)))),
    reconstructionSummary,
    credentialRedacted: true,
  };
  artifact.evidenceHash = sha256(Buffer.from(JSON.stringify(artifact)));
  return artifact;
}

async function writeTransitionFreeCandidateRoot(workspace) {
  const repositoryRoot = path.join(workspace, "transition-free-repository");
  const currentBuildSpec = JSON.parse(await readCandidateFile("tools/datapack/release/candidate-build-spec.json", "utf8"));
  const sourceInventoryPath = currentBuildSpec.networkEdgeEvidence?.sourceInventory?.path;
  if (typeof sourceInventoryPath !== "string" || path.posix.isAbsolute(sourceInventoryPath)
    || sourceInventoryPath.includes("\\") || sourceInventoryPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("current candidate source inventory path mismatch");
  }
  const sourceInventory = JSON.parse(await readCandidateFile(sourceInventoryPath, "utf8"));
  const incheonSources = sourceInventory.sources?.filter(({ id }) => id === "incheon-transit-station-info") ?? [];
  if (incheonSources.length !== 1) throw new Error("current Incheon topology source mismatch");
  const { topologyAdmissionEvidence: topology, routeMapAdmissionEvidence: routeMap } = incheonSources[0];
  const incheonTopologyPath = topology?.snapshotPath;
  if (typeof topology?.snapshotId !== "string" || topology.snapshotId === "" || routeMap?.snapshotId !== topology.snapshotId
    || routeMap.snapshotPath !== incheonTopologyPath || routeMap.topologySnapshotId !== topology.snapshotId
    || routeMap.topologyContentSha256 !== topology.contentSha256
    || incheonTopologyPath !== `tools/datapack/sources/${topology.snapshotId}.json`
    || path.posix.isAbsolute(incheonTopologyPath) || incheonTopologyPath.includes("\\")
    || incheonTopologyPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("current Incheon topology identity mismatch");
  }
  const requiredFiles = [
    "tools/datapack/schema/catalog-schema.sql",
    "tools/datapack/official-od-fare-admission.json",
    "tools/datapack/nationwide-coverage-targets.json",
    "tools/datapack/release/source-snapshots.json",
    incheonTopologyPath,
    "tools/datapack/fixtures/candidate-build-spec.json",
    "tools/datapack/fixtures/catalog-fixture.json",
    "tools/datapack/source-candidates.json",
    "tools/datapack/sources/seoul-metro-congestion-20260930T020244Z.json",
    "tools/datapack/sources/seoul-metro-congestion-20260930T020244Z.raw.json",
    "tools/datapack/sources/seoul-station-code-membership-20260909T041501Z.json",
  ];
  for (const relativePath of requiredFiles) {
    const target = path.join(repositoryRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(await currentCandidateRoot(), relativePath), target);
  }
  const candidatePath = path.join(repositoryRoot, "tools/datapack/fixtures/candidate-build-spec.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  await writeFile(candidatePath, await bindCurrentProductionScopePolicy(candidate, repositoryRoot));
  return repositoryRoot;
}

async function bindCandidateAccessibilityContextToFixture({
  fixture,
  buildSpec,
  currentInventory,
  repositoryRoot,
}) {
  const ledger = JSON.parse(await readFile(
    path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json"),
    "utf8",
  ));
  const inventorySources = new Map(currentInventory.sources.map((source) => [source.id, source]));
  const fixtureSnapshotIds = new Map();
  for (const pack of fixture.packs) {
    for (const row of [
      ...(pack.facilities ?? []),
      ...(pack.stationFacilityEvidence ?? []),
      ...(pack.networkEdges ?? []).filter(({ edgeType }) => ["ENTRY", "EXIT"].includes(edgeType)),
    ]) {
      const source = inventorySources.get(row.sourceId);
      if (!row.sourceId || (!source?.accessibilityAdmissionEvidence && !source?.registrationEvidence)) continue;
      assert.equal(typeof row.sourceSnapshotId, "string", `${row.sourceId} fixture snapshot identity`);
      const sourceSnapshotIds = fixtureSnapshotIds.get(row.sourceId) ?? new Set();
      sourceSnapshotIds.add(row.sourceSnapshotId);
      fixtureSnapshotIds.set(row.sourceId, sourceSnapshotIds);
    }
  }

  for (const [sourceId, snapshotIds] of fixtureSnapshotIds) {
    assert.equal(snapshotIds.size, 1, `${sourceId} fixture must use one accessibility snapshot`);
    const [snapshotId] = snapshotIds;
    const source = inventorySources.get(sourceId);
    if (sourceId === "incheon-transit-accessibility") {
      assert.equal(source.registrationEvidence?.snapshotId, snapshotId,
        `${sourceId} fixture must match receipt-bound registration`);
      assert.equal(buildSpec.sourceSnapshots.filter((projection) => projection.sourceId === sourceId).length, 1,
        `${sourceId} fixture must have exactly one ledger projection`);
      assert.equal(buildSpec.sourceSnapshotIds.filter((candidateSnapshotId) =>
        candidateSnapshotId === snapshotId).length, 1,
      `${sourceId} fixture must have exactly one ledger snapshot id`);
      continue;
    }
    const snapshotMatches = ledger.filter(
      (snapshot) => snapshot.sourceId === sourceId && snapshot.snapshotId === snapshotId,
    );
    assert.equal(snapshotMatches.length, 1, `${sourceId} fixture snapshot must exist once in ledger`);
    const [ledgerSnapshot] = snapshotMatches;
    const sourceArtifactRelativePath = `tools/datapack/sources/${snapshotId}.json`;
    const sourceArtifactPath = path.join(repositoryRoot, sourceArtifactRelativePath);
    await mkdir(path.dirname(sourceArtifactPath), { recursive: true });
    await copyFile(path.join(await currentCandidateRoot(), sourceArtifactRelativePath), sourceArtifactPath);
    const sourceArtifactBytes = await readFile(sourceArtifactPath);
    const sourceArtifact = JSON.parse(sourceArtifactBytes);
    assert.equal(sourceArtifact.sourceId, sourceId, `${sourceId} fixture source artifact identity`);
    assert.equal(sourceArtifact.snapshotId, snapshotId, `${sourceId} fixture source snapshot identity`);
    for (const field of [
      "capturedAt",
      "observedAt",
      "freshUntil",
      "rawSha256",
      "contentSha256",
      "schemaFingerprint",
      "absenceEvidenceMode",
    ]) assert.ok(sourceArtifact[field], `${sourceId} fixture source ${field}`);
    Object.assign(source.accessibilityAdmissionEvidence, {
      snapshotId,
      snapshotPath: sourceArtifactRelativePath,
      capturedAt: sourceArtifact.capturedAt,
      observedAt: sourceArtifact.observedAt,
      freshUntil: sourceArtifact.freshUntil,
      rawSha256: sourceArtifact.rawSha256,
      contentSha256: sourceArtifact.contentSha256,
      schemaFingerprint: sourceArtifact.schemaFingerprint,
      snapshotFileSha256: sha256(sourceArtifactBytes),
      absenceEvidenceMode: sourceArtifact.absenceEvidenceMode,
    });

    const projectionIndex = buildSpec.sourceSnapshots.findIndex((snapshot) => snapshot.sourceId === sourceId);
    assert.notEqual(projectionIndex, -1, `${sourceId} fixture candidate source projection`);
    const currentProjection = buildSpec.sourceSnapshots[projectionIndex];
    const adminReviewRecordHash = source.admissionEvidence?.adminReviewRecordHash;
    assert.match(adminReviewRecordHash ?? "", /^[0-9a-f]{64}$/, `${sourceId} fixture admin review identity`);
    const nextProjection = {};
    for (const key of Object.keys(currentProjection)) {
      const value = key === "adminReviewRecordHash"
        ? adminReviewRecordHash
        : ledgerSnapshot[key];
      assert.notEqual(value, undefined, `${sourceId} fixture ledger projection ${key}`);
      nextProjection[key] = value;
    }
    buildSpec.sourceSnapshots[projectionIndex] = nextProjection;
    buildSpec.sourceSnapshotIds = buildSpec.sourceSnapshotIds.map(
      (candidateSnapshotId) => candidateSnapshotId === currentProjection.snapshotId
        ? snapshotId
        : candidateSnapshotId,
    );
  }

  const selectedIds = new Set(buildSpec.sourceSnapshotIds);
  const selectedLedger = ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  assert.equal(
    selectedLedger.filter(({ sourceId }) => sourceId === "incheon-transit-accessibility").length,
    1,
    "fixture selected ledger must contain exactly one registered Incheon accessibility snapshot",
  );
  assert.equal(selectedLedger.length, selectedIds.size, "fixture candidate source-set must be ledger-complete");
  buildSpec.sourceSnapshotSetHash = sha256(JSON.stringify(selectedLedger));
}

async function runCandidateBuild({ buildSpecPath, output, env = productionEnv, repositoryRoot }) {
  return runDatapackInRepository({
    argv: ["--build-spec", buildSpecPath, "--output", output],
    env,
    repositoryRoot,
  });
}

async function runCurrentItxCandidateBuild(inputs) {
  return runCandidateBuild({
    ...inputs,
    env: {
      ...inputs.env,
      EASYSUBWAY_DATAPACK_BUILD_SPEC_VALIDATION_ONLY: "true",
    },
  });
}

test("official OD fare release candidate는 승인된 두 방향 quote와 provenance를 SQLite에 남긴다", async () => {
  const approvedEvidence = JSON.parse(await readFile(path.join(root, "tools/datapack/release/hash-evidence.json"), "utf8")).officialOdFareEvidence;
  const candidateFixture = JSON.parse(await readFile(path.join(root, "tools/datapack/release/capital-production-reviewed-pack.json"), "utf8"));
  assert.deepEqual(candidateFixture.packs[0].officialOdFareQuotes, approvedEvidence.quotes);
  assert.equal(candidateFixture.packs[0].officialOdFareQuotes.length, 2);
  assert.ok(candidateFixture.packs[0].sourceInventory.some(
    (source) => source.id === approvedEvidence.sourceId
      && source.coverageScope.sourceDomains.includes("official_od_fares"),
  ));

  const outputDir = await mkdtemp(path.join(tmpdir(), "official-od-fare-release-candidate-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(outputDir);
    await runCurrentItxCandidateBuild({ ...inputs, output: outputDir });
    const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
    assert.equal(manifest.packs.length, 1, "candidate manifest must contain exactly one pack");
    const [pack] = manifest.packs;
    const database = new DatabaseSync(
      path.join(outputDir, new URL(pack.url).pathname.split("/").slice(-2).join("/")).replace(/\.gz$/, ""),
    );
    let rows;
    try {
      rows = database.prepare(`SELECT origin_station_id AS originStationId,
                                      destination_station_id AS destinationStationId,
                                      source_id AS sourceId,
                                      snapshot_id AS snapshotId,
                                      mapping_ledger_hash AS mappingLedgerHash,
                                      gnrl_card_fare AS gnrlCardFare,
                                      gnrl_cash_fare AS gnrlCashFare,
                                      yung_card_fare AS yungCardFare,
                                      yung_cash_fare AS yungCashFare,
                                      child_card_fare AS childCardFare,
                                      child_cash_fare AS childCashFare
                               FROM official_od_fare_quotes
                               WHERE source_id = ?
                               ORDER BY rowid`).all(approvedEvidence.sourceId);
    } finally {
      database.close();
    }
    const canonicalQuotes = [...approvedEvidence.quotes].sort((left, right) =>
      codepointCompare(left.originStationId, right.originStationId)
        || codepointCompare(left.destinationStationId, right.destinationStationId));
    assert.deepEqual(rows.map((row) => ({ ...row })), canonicalQuotes);
    assert.equal(manifest.channel, "dev");
    assert.ok(manifest.packs[0].sourceInventory.some(
      (source) => source.id === approvedEvidence.sourceId,
    ));
    const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
    assert.deepEqual(provenance.candidateBuild.officialOdFareEvidence, approvedEvidence);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("production candidate는 current topology snapshot binding 불일치를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "capital-topology-snapshot-binding-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace);
    const buildSpec = JSON.parse(await readFile(inputs.buildSpecPath, "utf8"));
    buildSpec.networkEdgeEvidence.capitalTopologyCandidate.snapshotId = "capital-route-topology-20260814";
    await writeFile(inputs.buildSpecPath, `${JSON.stringify(buildSpec)}\n`);

    await assert.rejects(
      runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") }),
      /capital topology edge admission does not match pinned snapshot/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("production candidate는 embedded Incheon topology를 투영하지 않고 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "capital-topology-embedded-incheon-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace);
    const buildSpec = JSON.parse(await readFile(inputs.buildSpecPath, "utf8"));
    const candidateBinding = buildSpec.networkEdgeEvidence.capitalTopologyCandidate;
    const candidate = JSON.parse(await readFile(candidateBinding.path, "utf8"));
    const sourceInventory = JSON.parse(await readFile(
      buildSpec.networkEdgeEvidence.sourceInventory.path,
      "utf8",
    ));
    const incheonSource = sourceInventory.sources.find(
      ({ id }) => id === "incheon-transit-station-info",
    );
    assert.ok(incheonSource?.topologyAdmissionEvidence?.snapshotPath);
    const incheonTopology = JSON.parse(await readFile(
      path.join(inputs.repositoryRoot, incheonSource.topologyAdmissionEvidence.snapshotPath),
      "utf8",
    ));
    const embeddedLines = incheonTopology.topologyLineIds.map((lineId, index) => ({
      ...structuredClone(candidate.lines[index]),
      lineId,
    }));
    assert.equal(candidate.lines.length, 22);
    assert.equal(embeddedLines.length, 2);
    candidate.lines.push(...embeddedLines);
    candidate.lineCount = candidate.lines.length;
    candidate.totalEdgeCount = candidate.lines.reduce((sum, { edgeCount }) => sum + edgeCount, 0);
    candidate.contentSha256 = sha256(JSON.stringify({
      lines: candidate.lines.map(({
        lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId,
      }) => ({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId })),
      topologyGaps: candidate.topologyGaps,
    }));
    const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
    await writeFile(candidateBinding.path, candidateBytes);
    candidateBinding.sha256 = sha256(candidateBytes);
    await writeFile(inputs.buildSpecPath, `${JSON.stringify(buildSpec)}\n`);
    const output = path.join(workspace, "output");

    await assert.rejects(
      runCurrentItxCandidateBuild({ ...inputs, output }),
      /topology line ownership overlap/,
    );
    await assert.rejects(readFile(path.join(output, "current.json")), { code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("staged accessibility successor에서도 official OD fare release candidate fixture source-set은 격리된다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-staged-accessibility-"));
  try {
    const successorSnapshotId = "kric-station-convenience-standard-test-successor";
    const inputs = await writeCurrentItxReleaseInputs(workspace, {
      mutateCurrentSourceContext: ({ buildSpec, currentInventory, currentLedger }) => {
        const source = currentInventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
        assert.ok(source?.accessibilityAdmissionEvidence);
        source.accessibilityAdmissionEvidence.snapshotId = successorSnapshotId;
        source.accessibilityAdmissionEvidence.freshUntil = "2026-08-22T00:00:00.000Z";
        const snapshot = buildSpec.sourceSnapshots.find(({ sourceId }) => sourceId === source.id);
        assert.ok(snapshot);
        const previousSnapshotId = snapshot.snapshotId;
        snapshot.snapshotId = successorSnapshotId;
        buildSpec.sourceSnapshotIds = buildSpec.sourceSnapshotIds.map(
          (snapshotId) => snapshotId === previousSnapshotId ? successorSnapshotId : snapshotId,
        );
        const ledgerRow = currentLedger.find(({ sourceId, snapshotId }) =>
          sourceId === source.id && snapshotId === previousSnapshotId,
        );
        assert.ok(ledgerRow, "fixture current KRIC snapshot must exist in the ledger");
        currentLedger.push({ ...structuredClone(ledgerRow), snapshotId: successorSnapshotId });
      },
    });
    await runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("staged accessibility successor fixture는 복수·미등록 snapshot identity를 거부한다", async (t) => {
  const mutateKricSnapshotIds = (fixture, mutate) => {
    const rows = fixture.packs.flatMap((pack) => [
      ...(pack.facilities ?? []),
      ...(pack.stationFacilityEvidence ?? []),
      ...(pack.networkEdges ?? []).filter(({ edgeType }) => ["ENTRY", "EXIT"].includes(edgeType)),
    ]).filter(({ sourceId }) => sourceId === "kric-station-convenience-standard");
    assert.ok(rows.length > 1);
    mutate(rows);
  };
  await t.test("multiple identities", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-multiple-accessibility-"));
    try {
      await assert.rejects(
        writeCurrentItxReleaseInputs(workspace, {
          mutateFixture: (fixture) => mutateKricSnapshotIds(
            fixture,
            ([row]) => { row.sourceSnapshotId = "kric-station-convenience-standard-untracked"; },
          ),
        }),
        /fixture must use one accessibility snapshot/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  await t.test("untracked identity", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-untracked-accessibility-"));
    try {
      await assert.rejects(
        writeCurrentItxReleaseInputs(workspace, {
          mutateFixture: (fixture) => mutateKricSnapshotIds(
            fixture,
            (rows) => rows.forEach((row) => { row.sourceSnapshotId = "seoul-metro-accessibility-20260813T213842955Z"; }),
          ),
        }),
        /fixture snapshot must exist once in ledger/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test("official OD fare release candidate는 승인 quote 순서에 의존하지 않는다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-release-order-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace, {
      mutateFixture: (fixture) => fixture.packs[0].officialOdFareQuotes.reverse(),
    });
    await runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("production candidate는 admission에 결속되지 않은 ITX timetable row를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "production-unadmitted-itx-timetable-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace, {
      mutateFixture: (fixture) => { fixture.packs[0].transitTrips[0].serviceClass = "ITX_CHEONGCHUN"; },
    });

    await assert.rejects(
      runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") }),
      /production ITX timetable rows require explicit admission/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("production candidate는 중복 ITX admission pair로 다른 pair를 대체하면 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "production-duplicate-itx-pair-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace, {
      mutateFixture: (fixture) => {
        const itxEdges = fixture.packs[0].networkEdges.filter(
          ({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN",
        );
        const [admittedPair, replacedPair] = itxEdges;
        assert.ok(replacedPair, "fixture must contain multiple admitted ITX directional pairs");
        replacedPair.fromNodeId = admittedPair.fromNodeId;
        replacedPair.toNodeId = admittedPair.toNodeId;
      },
    });

    await assert.rejects(
      runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") }),
      /ITX network edge fixture projection must contain each admitted directional pair exactly once/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("production candidate는 completeness station-catalog identity 불일치를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "production-itx-completeness-identity-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace, {
      mutateCompleteness: (completeness) => {
        completeness.stationCatalogPackIdentity.manifestSha256 = "9".repeat(64);
      },
    });
    await assert.rejects(
      runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") }),
      /topology, source, completeness, and contract station catalog identities must match exactly/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("production candidate는 contract와 다른 topology input pack identity를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "production-itx-input-pack-identity-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace, {
      mutateTopologyEvidence: (evidence) => {
        evidence.pack.inputSha256 = "9".repeat(64);
      },
    });
    await assert.rejects(
      runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") }),
      /ITX topology input pack identity does not match coverage contract admission/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("production candidate는 legacy ITX readmission projection을 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "production-rewritten-itx-projection-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace, {
      mutateTopologyEvidence: (evidence) => {
        evidence.readmissions = [{ itxSubgraph: { edgesSha256: "f".repeat(64) } }];
      },
    });

    await assert.rejects(
      runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") }),
      /ITX topology evidence\.readmissions is not allowed/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("official OD fare release candidate는 admission과 다른 quote set evidence를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-release-mismatch-"));
  try {
    const inputs = await writeCurrentItxReleaseInputs(workspace);
    const { buildSpecPath } = inputs;
    const buildSpec = JSON.parse(await readFile(buildSpecPath, "utf8"));
    buildSpec.officialOdFareEvidence.quoteSetHash = "f".repeat(64);
    await writeFile(buildSpecPath, JSON.stringify(buildSpec));
    await assert.rejects(
      runCurrentItxCandidateBuild({ ...inputs, output: path.join(workspace, "output") }),
      /officialOdFareEvidence.quoteSetHash must match admission/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("원장 해시 exporter는 fixture 원장 5종 + license를 sha256으로 산출한다", async () => {
  const kinds = [
    ["alias", ["--fixture", catalogFixtureArg]],
    ["operator-mapping", ["--fixture", catalogFixtureArg]],
    ["facility-evidence", ["--fixture", catalogFixtureArg]],
    ["route-evidence", ["--fixture", catalogFixtureArg]],
    ["override", ["--overrides", overrideLedgerArg]],
    ["license", ["--source-id", "seoulmetro-station-line-info"]],
  ];
  for (const [kind, extra] of kinds) {
    const { stdout } = await runLedgerExporter(["--kind", kind, ...extra]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, kind, `${kind} kind`);
    assert.match(parsed.ledgerHash, /^[0-9a-f]{64}$/, `${kind} ledgerHash`);
    assert.equal(parsed.schemaVersion, 1);
  }
});

test("원장 해시 exporter는 결정적이다 (같은 입력 = 같은 해시)", async () => {
  const first = JSON.parse((await runLedgerExporter(["--kind", "alias", "--fixture", catalogFixtureArg])).stdout);
  const second = JSON.parse((await runLedgerExporter(["--kind", "alias", "--fixture", catalogFixtureArg])).stdout);
  assert.equal(first.ledgerHash, second.ledgerHash);
});

test("원장 해시 exporter는 레코드 순서가 바뀌어도 같은 해시를 낸다", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, catalogFixtureArg), "utf8"));
  const baseline = JSON.parse((await runLedgerExporter(["--kind", "alias", "--fixture", catalogFixtureArg])).stdout);

  const workspace = await mkdtemp(path.join(tmpdir(), "ledger-order-"));
  try {
    const reordered = structuredClone(fixture);
    reordered.packs[0].stationAliases.reverse();
    const reorderedPath = path.join(workspace, "reordered-fixture.json");
    await writeFile(reorderedPath, JSON.stringify(reordered));
    const { stdout } = await runLedgerExporter([
      "--kind",
      "alias",
      "--fixture",
      path.relative(root, reorderedPath),
    ]);
    assert.equal(JSON.parse(stdout).ledgerHash, baseline.ledgerHash);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("원장 해시 exporter는 알 수 없는 kind를 거부한다", async () => {
  await assert.rejects(runLedgerExporter(["--kind", "unknown", "--fixture", catalogFixtureArg]));
});

test("원장 해시 exporter는 license source-id가 inventory에 없으면 거부한다", async () => {
  await assert.rejects(runLedgerExporter(["--kind", "license", "--source-id", "does-not-exist"]));
});

test("원장 해시 exporter는 stationFacilityEvidence primary 분기를 쓰고 evidenceSource를 표기한다", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, catalogFixtureArg), "utf8"));
  const evidenceRows = [
    {
      stationId: "station-b",
      lineId: "line-2",
      facilityType: "ELEVATOR",
      evidenceHash: "b".repeat(64),
      providerRecordHash: "2".repeat(64),
    },
    {
      stationId: "station-a",
      lineId: "line-1",
      facilityType: "ESCALATOR",
      evidenceHash: "a".repeat(64),
      providerRecordHash: "1".repeat(64),
    },
  ];

  const workspace = await mkdtemp(path.join(tmpdir(), "ledger-evidence-"));
  try {
    const primary = structuredClone(fixture);
    primary.packs[0].stationFacilityEvidence = structuredClone(evidenceRows);
    const primaryPath = path.join(workspace, "primary-fixture.json");
    await writeFile(primaryPath, JSON.stringify(primary));

    const primaryArgs = ["--kind", "facility-evidence", "--fixture", path.relative(root, primaryPath)];
    const primaryOut = JSON.parse((await runLedgerExporter(primaryArgs)).stdout);
    assert.equal(primaryOut.evidenceSource, "stationFacilityEvidence");
    assert.match(primaryOut.ledgerHash, /^[0-9a-f]{64}$/);
    assert.equal(primaryOut.rowCount, evidenceRows.length);

    const primaryRepeat = JSON.parse((await runLedgerExporter(primaryArgs)).stdout);
    assert.equal(primaryRepeat.ledgerHash, primaryOut.ledgerHash);

    const fallback = structuredClone(primary);
    delete fallback.packs[0].stationFacilityEvidence;
    const fallbackPath = path.join(workspace, "fallback-fixture.json");
    await writeFile(fallbackPath, JSON.stringify(fallback));
    const fallbackOut = JSON.parse(
      (await runLedgerExporter(["--kind", "facility-evidence", "--fixture", path.relative(root, fallbackPath)])).stdout,
    );
    assert.equal(fallbackOut.evidenceSource, "facilities");
    assert.notEqual(fallbackOut.ledgerHash, primaryOut.ledgerHash);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("원장 해시 exporter는 facility-evidence source 혼합을 거부한다", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, catalogFixtureArg), "utf8"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ledger-mixed-"));
  try {
    const mixed = structuredClone(fixture);
    mixed.packs[0].stationFacilityEvidence = [
      {
        stationId: "station-a",
        lineId: "line-1",
        facilityType: "ELEVATOR",
        evidenceHash: "a".repeat(64),
        providerRecordHash: "1".repeat(64),
      },
    ];
    // 두 번째 pack은 stationFacilityEvidence 없이 facilities만 → facilities 폴백 source.
    mixed.packs.push(structuredClone(fixture.packs[0]));
    const mixedPath = path.join(workspace, "mixed-fixture.json");
    await writeFile(mixedPath, JSON.stringify(mixed));
    await assert.rejects(
      runLedgerExporter(["--kind", "facility-evidence", "--fixture", path.relative(root, mixedPath)]),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("override 해시는 facilityStatusUpdates 배열 순서에 민감하다", async () => {
  const overrides = JSON.parse(await readFile(path.join(root, overrideLedgerArg), "utf8"));
  const base = structuredClone(overrides);
  if (!Array.isArray(base.facilityStatusUpdates)) {
    base.facilityStatusUpdates = [];
  }
  while (base.facilityStatusUpdates.length < 2) {
    base.facilityStatusUpdates.push({ facilityId: `facility-${base.facilityStatusUpdates.length}` });
  }

  const workspace = await mkdtemp(path.join(tmpdir(), "ledger-override-order-"));
  try {
    const baselinePath = path.join(workspace, "baseline-overrides.json");
    await writeFile(baselinePath, JSON.stringify(base));
    const hash1 = JSON.parse(
      (await runLedgerExporter(["--kind", "override", "--overrides", path.relative(root, baselinePath)])).stdout,
    ).ledgerHash;

    const reversed = structuredClone(base);
    reversed.facilityStatusUpdates.reverse();
    const reversedPath = path.join(workspace, "reversed-overrides.json");
    await writeFile(reversedPath, JSON.stringify(reversed));
    const hash2 = JSON.parse(
      (await runLedgerExporter(["--kind", "override", "--overrides", path.relative(root, reversedPath)])).stdout,
    ).ledgerHash;

    assert.notEqual(hash1, hash2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("admin review record 생성기는 runbook 필수 필드를 exporter 해시로 채운다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "admin-review-"));
  try {
    const files = {};
    for (const [name, kind, extra] of [
      ["license", "license", ["--source-id", "seoulmetro-station-line-info"]],
      ["alias", "alias", ["--fixture", catalogFixtureArg]],
      ["operator", "operator-mapping", ["--fixture", catalogFixtureArg]],
      ["facility", "facility-evidence", ["--fixture", catalogFixtureArg]],
      ["route", "route-evidence", ["--fixture", catalogFixtureArg]],
      ["override", "override", ["--overrides", overrideLedgerArg]],
    ]) {
      const { stdout } = await runLedgerExporter(["--kind", kind, ...extra]);
      files[name] = path.join(workspace, `${name}.json`);
      await writeFile(files[name], stdout);
    }
    const sampleEvidenceHash = "a".repeat(64);
    const samplePath = path.join(workspace, "sample.json");
    await writeFile(samplePath, JSON.stringify({ evidenceHash: sampleEvidenceHash }));
    const quotaPath = path.join(workspace, "quota.json");
    const quota = {
      defaultDailyLimit: 1000,
      portal: "data.seoul.go.kr",
      productionUseAllowed: true,
      unlockStatus: "granted",
    };
    await writeFile(quotaPath, JSON.stringify(quota));
    const prodPath = path.join(workspace, "prod.json");
    await writeFile(prodPath, JSON.stringify({ id: "seoulmetro-station-line-info", displayName: "테스트", userDisplayName: "테스트" }));

    const { stdout } = await runAdminReviewBuilder([
      "--candidate", "seoulmetro-station-line-info",
      "--source-id", "seoulmetro-station-line-info",
      "--snapshot-id", "snap-1",
      "--decision", "APPROVED",
      "--approved-by", "owner",
      "--approved-at", "2026-07-12T00:00:00Z",
      "--sample-evidence", path.relative(root, samplePath),
      "--license-hash", path.relative(root, files.license),
      "--alias-hash", path.relative(root, files.alias),
      "--operator-mapping-hash", path.relative(root, files.operator),
      "--facility-evidence-hash", path.relative(root, files.facility),
      "--route-evidence-hash", path.relative(root, files.route),
      "--override-hash", path.relative(root, files.override),
      "--quota-evidence", path.relative(root, quotaPath),
      "--production-source", path.relative(root, prodPath),
    ]);
    const record = JSON.parse(stdout);
    assert.equal(record.artifactKind, "source-admission-admin-review");
    assert.equal(record.decision, "APPROVED");
    assert.equal(record.sampleEvidenceHash, sampleEvidenceHash);
    for (const field of [
      "licenseEvidenceHash",
      "aliasLedgerHash",
      "operatorMappingLedgerHash",
      "facilityEvidenceLedgerHash",
      "routeEvidenceLedgerHash",
      "overrideHash",
    ]) {
      assert.match(record[field], /^[0-9a-f]{64}$/, field);
    }
    // exporter 산출 해시와 record 값이 일치 (위조 불가 경로 확인)
    assert.equal(record.aliasLedgerHash, JSON.parse(await readFile(files.alias, "utf8")).ledgerHash);
    assert.equal(record.overrideHash, JSON.parse(await readFile(files.override, "utf8")).ledgerHash);
    // runbook requiredAdminReviewFields 전수 존재
    const runbook = JSON.parse(
      await readFile(path.join(root, "tools/datapack/source-admission-runbook.json"), "utf8"),
    );
    for (const field of runbook.requiredAdminReviewFields) {
      assert.ok(field in record, `record missing runbook field: ${field}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("admin review record 생성기는 kind가 틀린 해시 파일을 거부한다 (위조 방지)", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "admin-review-forge-"));
  try {
    // alias 자리에 override 산출물을 넣어 손으로 갈아끼우려는 시도 → kind mismatch 거부
    const { stdout: overrideOut } = await runLedgerExporter(["--kind", "override", "--overrides", overrideLedgerArg]);
    const forgedAlias = path.join(workspace, "forged-alias.json");
    await writeFile(forgedAlias, overrideOut);

    const files = {};
    for (const [name, kind, extra] of [
      ["license", "license", ["--source-id", "seoulmetro-station-line-info"]],
      ["operator", "operator-mapping", ["--fixture", catalogFixtureArg]],
      ["facility", "facility-evidence", ["--fixture", catalogFixtureArg]],
      ["route", "route-evidence", ["--fixture", catalogFixtureArg]],
      ["override", "override", ["--overrides", overrideLedgerArg]],
    ]) {
      const { stdout } = await runLedgerExporter(["--kind", kind, ...extra]);
      files[name] = path.join(workspace, `${name}.json`);
      await writeFile(files[name], stdout);
    }
    const samplePath = path.join(workspace, "sample.json");
    await writeFile(samplePath, JSON.stringify({ evidenceHash: "a".repeat(64) }));
    const quotaPath = path.join(workspace, "quota.json");
    await writeFile(
      quotaPath,
      JSON.stringify({ defaultDailyLimit: 1000, portal: "p", productionUseAllowed: true, unlockStatus: "granted" }),
    );
    const prodPath = path.join(workspace, "prod.json");
    await writeFile(prodPath, JSON.stringify({ id: "seoulmetro-station-line-info" }));

    await assert.rejects(
      runAdminReviewBuilder([
        "--candidate", "seoulmetro-station-line-info",
        "--source-id", "seoulmetro-station-line-info",
        "--snapshot-id", "snap-1",
        "--decision", "APPROVED",
        "--approved-by", "owner",
        "--approved-at", "2026-07-12T00:00:00Z",
        "--sample-evidence", path.relative(root, samplePath),
        "--license-hash", path.relative(root, files.license),
        "--alias-hash", path.relative(root, forgedAlias),
        "--operator-mapping-hash", path.relative(root, files.operator),
        "--facility-evidence-hash", path.relative(root, files.facility),
        "--route-evidence-hash", path.relative(root, files.route),
        "--override-hash", path.relative(root, files.override),
        "--quota-evidence", path.relative(root, quotaPath),
        "--production-source", path.relative(root, prodPath),
      ]),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("admin review record 생성기는 APPROVED가 아닌 decision을 거부한다", async () => {
  await assert.rejects(
    runAdminReviewBuilder([
      "--candidate", "x", "--source-id", "x", "--snapshot-id", "s",
      "--decision", "REJECTED", "--approved-by", "o", "--approved-at", "t",
      "--sample-evidence", "x", "--license-hash", "x", "--alias-hash", "x",
      "--operator-mapping-hash", "x", "--facility-evidence-hash", "x",
      "--route-evidence-hash", "x", "--override-hash", "x",
      "--quota-evidence", "x", "--production-source", "x",
    ]),
  );
});

test("build-admin-review-record 산출물은 run-source-admission-pipeline을 그대로 통과한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-ledger-e2e-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidatesPath = await writePendingCandidateFixture(outputDir, "kric-train-operation-organ");
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  await writeFile(rawPath, `${JSON.stringify([{ railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" }])}\n`);

  // sample evidence는 pipeline이 소비하는 것과 동일하게 실 도구로 생성
  const { stdout: sampleStdout } = await execFileAsync(
    process.execPath,
    ["tools/datapack/build-source-candidate-sample-evidence.mjs", "--candidate", "kric-train-operation-organ", "--response", rawPath],
    { cwd: root },
  );
  const samplePath = path.join(outputDir, "sample.json");
  await writeFile(samplePath, sampleStdout);

  // 6종 원장 해시를 exporter로 산출
  const ledgerFiles = {};
  for (const [name, kind, extra] of [
    ["license", "license", ["--source-id", "seoulmetro-station-line-info"]],
    ["alias", "alias", ["--fixture", catalogFixtureArg]],
    ["operator", "operator-mapping", ["--fixture", catalogFixtureArg]],
    ["facility", "facility-evidence", ["--fixture", catalogFixtureArg]],
    ["route", "route-evidence", ["--fixture", catalogFixtureArg]],
    ["override", "override", ["--overrides", overrideLedgerArg]],
  ]) {
    const { stdout } = await runLedgerExporter(["--kind", kind, ...extra]);
    ledgerFiles[name] = path.join(outputDir, `${name}.json`);
    await writeFile(ledgerFiles[name], stdout);
  }

  const quotaPath = path.join(outputDir, "quota.json");
  await writeFile(
    quotaPath,
    JSON.stringify({ defaultDailyLimit: "unlimited", portal: "KRIC 레일포털", productionUseAllowed: true, unlockStatus: "not_required" }),
  );
  const prodPath = path.join(outputDir, "prod.json");
  await writeFile(
    prodPath,
    JSON.stringify({
      id: "kric-train-operation-organ",
      displayName: "열차운영기관정보",
      userDisplayName: "열차운영기관정보",
      owner: "국가철도공단",
      provider: "국가철도공단",
      sourceSystem: "KRIC OpenAPI",
      datasetUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266",
      requiredForProductionPack: false,
      updateFrequency: "provider-documented",
      observedDataUpdatedAt: "2026-07-02",
      retrievedAt: "2026-07-02",
      license: {
        type: "KOGL-1",
        name: "공공누리 1유형",
        attribution: "공공누리 제1유형: 출처표시",
        commercialUseAllowed: true,
        derivativeWorkAllowed: true,
        redistributionAllowed: true,
        evidenceUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266",
      },
      coverageScope: { regionIds: ["capital"], operatorIds: ["seoul-metro"], sourceDomains: ["station_line_membership"] },
      fieldsProvided: ["railOprIsttCd", "railOprIsttNm"],
      capabilities: {
        schedule: { status: "UNSUPPORTED", productionUseAllowed: false, coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "provider-documented", unsupportedNotes: "x" },
        realtime: { status: "UNSUPPORTED", productionUseAllowed: false, liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE", coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "provider-documented", unsupportedNotes: "x" },
        facility: { status: "UNSUPPORTED", productionUseAllowed: false, coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "provider-documented", unsupportedNotes: "x" },
      },
    }),
  );

  // 생성기로 admin review record 작성
  const { stdout: recordStdout } = await runAdminReviewBuilder([
    "--candidate", "kric-train-operation-organ",
    "--source-id", "kric-train-operation-organ",
    "--snapshot-id", "kric-train-operation-organ-snapshot-20260702",
    "--decision", "APPROVED",
    "--approved-by", "owner",
    "--approved-at", "2026-07-12T00:00:00Z",
    "--sample-evidence", path.relative(root, samplePath),
    "--license-hash", path.relative(root, ledgerFiles.license),
    "--alias-hash", path.relative(root, ledgerFiles.alias),
    "--operator-mapping-hash", path.relative(root, ledgerFiles.operator),
    "--facility-evidence-hash", path.relative(root, ledgerFiles.facility),
    "--route-evidence-hash", path.relative(root, ledgerFiles.route),
    "--override-hash", path.relative(root, ledgerFiles.override),
    "--quota-evidence", path.relative(root, quotaPath),
    "--production-source", path.relative(root, prodPath),
  ]);
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await writeFile(adminReviewPath, recordStdout);

  const summaryPath = path.join(outputDir, "admission-summary.json");
  const outputInventoryPath = path.join(outputDir, "source-inventory.admitted.json");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/run-source-admission-pipeline.mjs",
      "--candidates", candidatesPath,
      "--candidate", "kric-train-operation-organ",
      "--raw-input", rawPath,
      "--evidence-dir", outputDir,
      "--snapshot-id", "kric-train-operation-organ-snapshot-20260702",
      "--source-id", "kric-train-operation-organ",
      "--provider", "국가철도공단",
      "--source-class-id", "static_network_metadata",
      "--retrieved-at", "2026-07-02T00:00:00Z",
      "--source-updated-at", "2026-07-02T00:00:00Z",
      "--raw-object-uri", "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
      "--freshness-expires-at", "2026-08-01T00:00:00Z",
      "--raw-retention-expires-at", "2026-09-30T00:00:00Z",
      "--admin-review", adminReviewPath,
      "--output-inventory", outputInventoryPath,
      "--output", summaryPath,
    ],
    { cwd: root },
  );
  assert.match(stdout, /source admission pipeline evidence written/);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  // pipeline summary가 exporter 산출 원장 해시를 그대로 옮겨야 한다
  assert.equal(summary.aliasLedgerHash, JSON.parse(await readFile(ledgerFiles.alias, "utf8")).ledgerHash);
  assert.equal(summary.overrideHash, JSON.parse(await readFile(ledgerFiles.override, "utf8")).ledgerHash);
  assert.equal(summary.licenseEvidenceHash, JSON.parse(await readFile(ledgerFiles.license, "utf8")).ledgerHash);
});
