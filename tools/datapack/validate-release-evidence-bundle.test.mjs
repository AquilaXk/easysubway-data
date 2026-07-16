import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildLaunchDenominatorReport,
  canonicalScopeHash,
} from "./build-launch-denominator-report.mjs";
import {
  bindAuthoritativeLaunchEvidence,
  buildLaunchCandidateBinding,
} from "./launch-candidate-binding.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const previousPublicKey = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = publicKeyPem;

test.after(() => {
  if (previousPublicKey === undefined) delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  else process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = previousPublicKey;
});

test("release evidence bundle validator는 publish gate status와 deferred headway 예외를 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-release-evidence-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const bundlePath = path.join(outputDir, "release-evidence-bundle.json");
  const hash = "a".repeat(64);
  const scopeRaw = await readFile(path.join(root, "apps/mobile/release/production-datapack-scope.json"), "utf8");
  const scope = JSON.parse(scopeRaw);
  const sha256 = (raw) => createHash("sha256").update(raw).digest("hex");
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const scopeArgs = ["--scope", "apps/mobile/release/production-datapack-scope.json"];
  const launchReportPath = path.join(outputDir, "launch-denominator-go.json");
  const currentLaunchReportPath = "tools/datapack/reports/android-v1-launch-denominator-20260715.json";
  const identity = {
    canonicalStationVersion: "station-catalog-v18",
    corridorId: "capital-gyeongchun-v1",
    serviceId: "ITX_CHEONGCHUN",
    lineageId: "launch-lineage-v1",
    schemaVersion: 1,
  };
  const admittedStationIds = [
    ...scope.routingLaunchScope.baseRoutingStationIds,
    ...scope.routingLaunchScope.requiredTransferStationIds,
  ];
  const sourceDerivedConnectionEdgeIds = ["source-edge-a"];
  const buildSpecRaw = json({
    candidateId: "candidate-a",
    builderGitSha: "abcdef1",
    sourceSnapshots: [{ freshnessExpiresAt: "2099-08-01T00:00:00Z" }],
  });
  const manifestRaw = json({ packs: [{ id: "capital", version: "1" }] });
  const candidateIdentity = {
    candidateId: "candidate-a",
    buildSpecSha256: sha256(buildSpecRaw),
    manifestSha256: sha256(manifestRaw),
  };
  const sourceEvidenceRaw = json({
    manifestSha256: candidateIdentity.manifestSha256,
    candidateBuild: {
      ...candidateIdentity,
      builderGitSha: "abcdef1",
      sourceSnapshots: [{ freshnessExpiresAt: "2099-08-01T00:00:00Z" }],
    },
    launchDenominatorEvidence: {
      pilot: {
        coveredRowIds: scope.verifiedAccessibilityScope.includedStationIds.flatMap((stationId) =>
          scope.verifiedAccessibilityScope.requiredFacilityTypes.map((facilityType) =>
            `${stationId}|${scope.verifiedAccessibilityScope.includedLineIds[0]}|${facilityType}`)),
      },
      routing: {
        regionIds: [...scope.routingLaunchScope.regionIds],
        operatorIds: [...scope.routingLaunchScope.operatorIds],
        lineIds: [...scope.routingLaunchScope.lineIds],
        baseStationIds: [...scope.routingLaunchScope.baseRoutingStationIds],
        admittedStationIds,
        materializedStationIds: [...admittedStationIds],
        transferStationIds: [...scope.routingLaunchScope.requiredTransferStationIds],
        baseEdgeIds: [...scope.routingLaunchScope.requiredBaseEdgeIds],
        transferEdgeIds: [...scope.routingLaunchScope.requiredTransferEdgeIds],
        sourceDerivedConnectionEdgeIds: { status: "ADMITTED", ids: sourceDerivedConnectionEdgeIds },
        serviceIds: [...scope.routingLaunchScope.serviceIds],
      },
      source: {
        status: "ADMITTED",
        freshness: "FRESH",
        routingScopeHash: canonicalScopeHash(scope.routingLaunchScope),
        admittedStationIds,
        sourceDerivedConnectionEdgeIds,
        identity,
      },
      safety: { signatureValid: true, rollbackVerified: true, freshness: "FRESH", lineage: "VERIFIED" },
      forbiddenEvidence: [],
      forbiddenEvidenceStatus: "VERIFIED",
    },
  });
  const serverEvidenceRaw = json({
    candidateBinding: candidateIdentity,
    freshnessExpiresAt: "2099-08-01T00:00:00Z",
    launchDenominatorEvidence: {
      server: { status: "ACTIVE", routingReady: true, identity },
    },
  });
  const mobileEvidenceRaw = json({
    candidateBinding: candidateIdentity,
    freshnessExpiresAt: "2099-08-01T00:00:00Z",
    launchDenominatorEvidence: {
      mobile: { status: "READY", topologyReady: true, identity },
    },
  });
  const artifactPaths = {
    buildSpec: path.join(outputDir, "build-spec.json"),
    manifest: path.join(outputDir, "manifest.json"),
    source: path.join(outputDir, "source-evidence.json"),
    server: path.join(outputDir, "server-evidence.json"),
    mobile: path.join(outputDir, "mobile-evidence.json"),
  };
  await Promise.all([
    writeFile(artifactPaths.buildSpec, buildSpecRaw),
    writeFile(artifactPaths.manifest, manifestRaw),
    writeFile(artifactPaths.source, sourceEvidenceRaw),
    writeFile(artifactPaths.server, serverEvidenceRaw),
    writeFile(artifactPaths.mobile, mobileEvidenceRaw),
  ]);
  const candidateBinding = {
    status: "BOUND",
    buildCandidateId: "candidate-a",
    packCandidateId: "capital@1",
    candidateBuilderGitSha: "abcdef1",
    buildSpecSha256: candidateIdentity.buildSpecSha256,
    manifestSha256: candidateIdentity.manifestSha256,
    sourceEvidence: { status: "FRESH", sha256: sha256(sourceEvidenceRaw), freshUntil: "2099-08-01T00:00:00Z" },
    serverEvidence: { status: "FRESH", sha256: sha256(serverEvidenceRaw), freshUntil: "2099-08-01T00:00:00Z" },
    mobileEvidence: { status: "FRESH", sha256: sha256(mobileEvidenceRaw), freshUntil: "2099-08-01T00:00:00Z" },
  };
  const goReport = buildLaunchDenominatorReport(scope, {
    pilot: {
      coveredRowIds: scope.verifiedAccessibilityScope.includedStationIds.flatMap((stationId) =>
        scope.verifiedAccessibilityScope.requiredFacilityTypes.map((facilityType) =>
          `${stationId}|${scope.verifiedAccessibilityScope.includedLineIds[0]}|${facilityType}`)),
    },
    routing: {
      regionIds: [...scope.routingLaunchScope.regionIds],
      operatorIds: [...scope.routingLaunchScope.operatorIds],
      lineIds: [...scope.routingLaunchScope.lineIds],
      baseStationIds: [...scope.routingLaunchScope.baseRoutingStationIds],
      admittedStationIds,
      materializedStationIds: [...admittedStationIds],
      transferStationIds: [...scope.routingLaunchScope.requiredTransferStationIds],
      baseEdgeIds: [...scope.routingLaunchScope.requiredBaseEdgeIds],
      transferEdgeIds: [...scope.routingLaunchScope.requiredTransferEdgeIds],
      sourceDerivedConnectionEdgeIds: { status: "ADMITTED", ids: sourceDerivedConnectionEdgeIds },
      serviceIds: [...scope.routingLaunchScope.serviceIds],
    },
    source: {
      status: "ADMITTED",
      freshness: "FRESH",
      routingScopeHash: canonicalScopeHash(scope.routingLaunchScope),
      admittedStationIds,
      sourceDerivedConnectionEdgeIds,
      artifactHash: candidateBinding.sourceEvidence.sha256,
      identity,
    },
    server: { status: "ACTIVE", routingReady: true, artifactHash: candidateBinding.serverEvidence.sha256, identity },
    mobile: { status: "READY", topologyReady: true, artifactHash: candidateBinding.mobileEvidence.sha256, identity },
    safety: { signatureValid: true, rollbackVerified: true, freshness: "FRESH", lineage: "VERIFIED" },
    claims: {
      accessibilityScopeId: scope.verifiedAccessibilityScope.id,
      routingScopeId: scope.routingLaunchScope.id,
      serviceIds: [...scope.routingLaunchScope.serviceIds],
    },
    forbiddenEvidence: [],
    forbiddenEvidenceStatus: "VERIFIED",
    nationwide: { missingCount: 270 },
    candidateBinding,
  });
  assert.equal(goReport.decision, "GO");
  const goReportRaw = `${JSON.stringify(goReport, null, 2)}\n`;
  await writeFile(launchReportPath, goReportRaw);
  const reportArgs = ["--launch-report", launchReportPath];
  const candidateArgs = [
    "--build-spec", artifactPaths.buildSpec,
    "--manifest", artifactPaths.manifest,
    "--source-evidence", artifactPaths.source,
    "--server-evidence", artifactPaths.server,
    "--mobile-evidence", artifactPaths.mobile,
  ];
  const validatorCommand = [
    "tools/datapack/validate-release-evidence-bundle.mjs",
    "--bundle",
    bundlePath,
    ...reportArgs,
    ...candidateArgs,
  ];
  const bindLaunchReport = (target, report, raw) => Object.assign(target, {
    scopeId: report.scopes.verifiedAccessibilityScope.id,
    verifiedAccessibilityScopeId: report.scopes.verifiedAccessibilityScope.id,
    verifiedAccessibilityScopeSha256: report.scopes.verifiedAccessibilityScope.sha256,
    launchScopeId: report.scopes.routingLaunchScope.id,
    launchScopeSha256: report.scopes.routingLaunchScope.sha256,
    nationwideRoadmapScopeId: report.scopes.nationwideRoadmapScope.id,
    nationwideRoadmapScopeSha256: report.scopes.nationwideRoadmapScope.sha256,
    identityLinkageMatrixSha256: report.identityLinkage.matrixSha256,
    launchDenominatorDecision: report.decision,
    launchDenominatorReportSha256: createHash("sha256").update(raw).digest("hex"),
  });
  const bundle = {
    schemaVersion: 1,
    artifactKind: "datapack-release-evidence-bundle",
    candidateId: "capital@1",
    buildCandidateId: "candidate-a",
    candidateBuilderGitSha: "abcdef1",
    scopeId: "capital_pilot_android_v1",
    releaseRequestId: "release-request-1",
    builderGitSha: "abcdef1",
    buildSpecSha256: candidateBinding.buildSpecSha256,
    supportedDenominatorSha256: sha256(scopeRaw),
    sourceSnapshotSetHash: hash,
    approvedAliasLedgerHash: hash,
    facilityEvidenceLedgerHash: hash,
    routeEvidenceLedgerHash: hash,
    approvedOverrideSetHash: hash,
    normalizedSourceInventorySha256: candidateBinding.sourceEvidence.sha256,
    sqliteSha256: hash,
    gzipSha256: hash,
    manifestSha256: candidateBinding.manifestSha256,
    coverageSummarySha256: hash,
    itxCheongchunCoverageSha256: hash,
    routeMapPositionCoverageSha256: hash,
    routeGraphTopologySha256: hash,
    headwayReportSha256: hash,
    strictRouteRegressionSha256: candidateBinding.serverEvidence.sha256,
    androidEvidenceSha256: candidateBinding.mobileEvidence.sha256,
    validatorStatus: "PASS",
    coverageStatus: "PASS",
    routeMapPositionCoverageStatus: "PASS",
    routeGraphTopologyStatus: "PASS",
    routeGraphTopologyViolationCount: 0,
    headwayReportStatus: "PASS",
    strictRouteRegressionStatus: "PASS",
    manifestSignatureStatus: "PASS",
    androidEvidenceStatus: "PASS",
    createdAt: "2026-06-30T00:00:00.000Z",
    workflowRunUrl: "https://github.com/AquilaXk/easysubway/actions/runs/1",
  };
  bindLaunchReport(bundle, goReport, goReportRaw);

  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle",
      bundlePath,
      ...scopeArgs,
      ...reportArgs,
      ...candidateArgs,
      "--require-pass",
    ],
    { cwd: root },
  );

  bundle.rollbackRescue = {
    evidenceSha256: hash,
    releaseRequestId: bundle.releaseRequestId,
    rollbackApprovalEventId: "release-channel-event-1",
    rcCandidateId: bundle.candidateId,
    rcManifestSha256: bundle.manifestSha256,
    currentReleaseSequence: 115,
    failedReleaseSequence: 115,
    knownGoodReleaseSequence: 114,
    rescueReleaseSequence: 116,
    knownGoodPackSha256: hash,
    knownGoodSqliteSha256: hash,
    rescueManifestSha256: hash,
    recoveryDurationSeconds: 42,
    validatorStatus: "PASS",
    manifestLastStatus: "PASS",
    executionEnvironment: "LOCAL_FIXTURE",
    productionExecuted: false,
  };
  const rollbackEvidencePath = path.join(outputDir, "rollback-evidence.json");
  const rollbackEvidence = {
    schemaVersion: 1,
    artifactKind: "datapack-rollback-rescue-evidence",
    rollbackApprovalEventId: bundle.rollbackRescue.rollbackApprovalEventId,
    approvedByRole: "admin.datapack.rollback",
    approvedAt: "2026-07-15T00:30:00.000Z",
    reasonCode: "ADMIN_APPROVED_ROLLBACK",
    from: { releaseSequence: 115, manifestSha256: bundle.manifestSha256 },
    failed: { releaseSequence: 115, manifestSha256: bundle.manifestSha256 },
    knownGood: {
      releaseSequence: 114,
      manifestSha256: hash,
      packs: [{ id: "capital", version: "1", sha256: hash, sqliteSha256: hash }],
    },
    rescue: { releaseSequence: 116, manifestSha256: hash },
    status: "PASS",
    validatorStatus: "PASS",
    manifestLastStatus: "PASS",
    recoveryDurationSeconds: 42,
    executionEnvironment: "LOCAL_FIXTURE",
    productionExecuted: false,
  };
  const rollbackManifestPath = path.join(outputDir, "rollback-manifest.json");
  const rollbackManifestRaw = json(signedRescueManifest({
    releaseSequence: 116,
    failedManifestSha256: bundle.manifestSha256,
    knownGoodManifestSha256: hash,
    rollbackApprovalEventId: bundle.rollbackRescue.rollbackApprovalEventId,
    packSha256: hash,
    sqliteSha256: hash,
  }));
  bundle.rollbackRescue.rescueManifestSha256 = sha256(rollbackManifestRaw);
  rollbackEvidence.rescue.manifestSha256 = bundle.rollbackRescue.rescueManifestSha256;
  const boundRollbackEvidenceRaw = json(rollbackEvidence);
  bundle.rollbackRescue.evidenceSha256 = sha256(boundRollbackEvidenceRaw);
  await writeFile(rollbackEvidencePath, boundRollbackEvidenceRaw);
  await writeFile(rollbackManifestPath, rollbackManifestRaw);
  await writeFile(bundlePath, json(bundle));
  const rollbackValidatorCommand = [
    ...validatorCommand,
    "--rollback-evidence", rollbackEvidencePath,
    "--rollback-manifest", rollbackManifestPath,
  ];
  await execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root });

  for (const [field, tampered] of [
    ["approvedByRole", "admin.datapack.other"],
    ["approvedAt", "2026-07-15T00:31:00.000Z"],
    ["reasonCode", "OTHER_REASON"],
  ]) {
    const original = rollbackEvidence[field];
    rollbackEvidence[field] = tampered;
    const tamperedEvidenceRaw = json(rollbackEvidence);
    bundle.rollbackRescue.evidenceSha256 = sha256(tamperedEvidenceRaw);
    await writeFile(rollbackEvidencePath, tamperedEvidenceRaw);
    await writeFile(bundlePath, json(bundle));
    await assert.rejects(
      execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
      new RegExp(`rollbackProvenance ${field} mismatch`),
    );
    rollbackEvidence[field] = original;
  }
  bundle.rollbackRescue.evidenceSha256 = sha256(boundRollbackEvidenceRaw);
  await writeFile(rollbackEvidencePath, boundRollbackEvidenceRaw);
  await writeFile(bundlePath, json(bundle));

  const unsignedManifest = JSON.parse(rollbackManifestRaw);
  delete unsignedManifest.signature;
  const unsignedManifestRaw = json(unsignedManifest);
  bundle.rollbackRescue.rescueManifestSha256 = sha256(unsignedManifestRaw);
  rollbackEvidence.rescue.manifestSha256 = bundle.rollbackRescue.rescueManifestSha256;
  const unsignedEvidenceRaw = json(rollbackEvidence);
  bundle.rollbackRescue.evidenceSha256 = sha256(unsignedEvidenceRaw);
  await writeFile(rollbackManifestPath, unsignedManifestRaw);
  await writeFile(rollbackEvidencePath, unsignedEvidenceRaw);
  await writeFile(bundlePath, json(bundle));
  await assert.rejects(
    execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
    /manifest/,
  );
  bundle.rollbackRescue.rescueManifestSha256 = sha256(rollbackManifestRaw);
  rollbackEvidence.rescue.manifestSha256 = bundle.rollbackRescue.rescueManifestSha256;
  bundle.rollbackRescue.evidenceSha256 = sha256(boundRollbackEvidenceRaw);
  await writeFile(rollbackManifestPath, rollbackManifestRaw);
  await writeFile(rollbackEvidencePath, boundRollbackEvidenceRaw);
  await writeFile(bundlePath, json(bundle));

  const tamperedProvenance = JSON.parse(rollbackManifestRaw);
  tamperedProvenance.rollbackProvenance.failedManifestSha256 = "f".repeat(64);
  resignManifest(tamperedProvenance);
  const tamperedProvenanceRaw = json(tamperedProvenance);
  bundle.rollbackRescue.rescueManifestSha256 = sha256(tamperedProvenanceRaw);
  rollbackEvidence.rescue.manifestSha256 = bundle.rollbackRescue.rescueManifestSha256;
  const tamperedProvenanceEvidenceRaw = json(rollbackEvidence);
  bundle.rollbackRescue.evidenceSha256 = sha256(tamperedProvenanceEvidenceRaw);
  await writeFile(rollbackManifestPath, tamperedProvenanceRaw);
  await writeFile(rollbackEvidencePath, tamperedProvenanceEvidenceRaw);
  await writeFile(bundlePath, json(bundle));
  await assert.rejects(
    execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
    /rollbackProvenance failedManifestSha256 mismatch/,
  );
  bundle.rollbackRescue.rescueManifestSha256 = sha256(rollbackManifestRaw);
  rollbackEvidence.rescue.manifestSha256 = bundle.rollbackRescue.rescueManifestSha256;
  bundle.rollbackRescue.evidenceSha256 = sha256(boundRollbackEvidenceRaw);
  await writeFile(rollbackManifestPath, rollbackManifestRaw);
  await writeFile(rollbackEvidencePath, boundRollbackEvidenceRaw);
  await writeFile(bundlePath, json(bundle));

  const tamperedPack = JSON.parse(rollbackManifestRaw);
  tamperedPack.packs[0].sha256 = "f".repeat(64);
  resignManifest(tamperedPack);
  const tamperedPackRaw = json(tamperedPack);
  bundle.rollbackRescue.rescueManifestSha256 = sha256(tamperedPackRaw);
  rollbackEvidence.rescue.manifestSha256 = bundle.rollbackRescue.rescueManifestSha256;
  const tamperedPackEvidenceRaw = json(rollbackEvidence);
  bundle.rollbackRescue.evidenceSha256 = sha256(tamperedPackEvidenceRaw);
  await writeFile(rollbackManifestPath, tamperedPackRaw);
  await writeFile(rollbackEvidencePath, tamperedPackEvidenceRaw);
  await writeFile(bundlePath, json(bundle));
  await assert.rejects(
    execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
    /manifest known-good pack identity mismatch/,
  );
  bundle.rollbackRescue.rescueManifestSha256 = sha256(rollbackManifestRaw);
  rollbackEvidence.rescue.manifestSha256 = bundle.rollbackRescue.rescueManifestSha256;
  bundle.rollbackRescue.evidenceSha256 = sha256(boundRollbackEvidenceRaw);
  await writeFile(rollbackManifestPath, rollbackManifestRaw);
  await writeFile(rollbackEvidencePath, boundRollbackEvidenceRaw);
  await writeFile(bundlePath, json(bundle));

  rollbackEvidence.failed.manifestSha256 = "f".repeat(64);
  const tamperedFailedEvidenceRaw = json(rollbackEvidence);
  bundle.rollbackRescue.evidenceSha256 = sha256(tamperedFailedEvidenceRaw);
  await writeFile(rollbackEvidencePath, tamperedFailedEvidenceRaw);
  await writeFile(bundlePath, json(bundle));
  await assert.rejects(
    execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
    /failed manifest evidence mismatch/,
  );
  rollbackEvidence.failed.manifestSha256 = bundle.manifestSha256;
  bundle.rollbackRescue.evidenceSha256 = sha256(boundRollbackEvidenceRaw);
  await writeFile(rollbackEvidencePath, boundRollbackEvidenceRaw);
  await writeFile(bundlePath, json(bundle));

  bundle.rollbackRescue.executionEnvironment = "DRY_RUN";
  rollbackEvidence.executionEnvironment = "DRY_RUN";
  const dryRunEvidenceRaw = json(rollbackEvidence);
  bundle.rollbackRescue.evidenceSha256 = sha256(dryRunEvidenceRaw);
  await writeFile(rollbackEvidencePath, dryRunEvidenceRaw);
  await writeFile(bundlePath, json(bundle));
  await execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root });
  bundle.rollbackRescue.executionEnvironment = "LOCAL_FIXTURE";
  rollbackEvidence.executionEnvironment = "LOCAL_FIXTURE";
  bundle.rollbackRescue.evidenceSha256 = sha256(boundRollbackEvidenceRaw);
  await writeFile(rollbackEvidencePath, boundRollbackEvidenceRaw);
  await writeFile(bundlePath, json(bundle));

  for (const [field, value, expected] of [
    ["rescueReleaseSequence", 115, /knownGood < failed = current < rescue/],
    ["rcManifestSha256", "f".repeat(64), /rollbackRescue rcManifestSha256 must match bundle manifestSha256/],
    ["manifestLastStatus", "FAIL", /rollbackRescue manifestLastStatus evidence mismatch/],
  ]) {
    const original = bundle.rollbackRescue[field];
    bundle.rollbackRescue[field] = value;
    await writeFile(bundlePath, json(bundle));
    await assert.rejects(
      execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
      expected,
    );
    bundle.rollbackRescue[field] = original;
  }
  await writeFile(bundlePath, json(bundle));
  await assert.rejects(
    execFileAsync(process.execPath, [...validatorCommand, "--require-pass"], { cwd: root }),
    /rollbackRescue requires --rollback-evidence/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [...validatorCommand, "--rollback-evidence", rollbackEvidencePath, "--require-pass"], { cwd: root }),
    /rollbackRescue requires --rollback-manifest/,
  );

  await writeFile(rollbackManifestPath, json({ manifestVersion: 2, releaseSequence: 117, marker: "tampered" }));
  await assert.rejects(
    execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
    /rollbackRescue manifest sha256 mismatch/,
  );
  await writeFile(rollbackManifestPath, rollbackManifestRaw);

  rollbackEvidence.knownGood.packs[0].sha256 = "f".repeat(64);
  const tamperedRollbackEvidenceRaw = json(rollbackEvidence);
  await writeFile(rollbackEvidencePath, tamperedRollbackEvidenceRaw);
  await assert.rejects(
    execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
    /rollbackRescue evidence sha256 mismatch/,
  );
  bundle.rollbackRescue.evidenceSha256 = sha256(tamperedRollbackEvidenceRaw);
  await writeFile(bundlePath, json(bundle));
  await assert.rejects(
    execFileAsync(process.execPath, [...rollbackValidatorCommand, "--require-pass"], { cwd: root }),
    /rollbackRescue known-good pack evidence mismatch/,
  );
  await writeFile(rollbackEvidencePath, boundRollbackEvidenceRaw);
  rollbackEvidence.knownGood.packs[0].sha256 = hash;
  delete bundle.rollbackRescue;
  await writeFile(bundlePath, json(bundle));

  bundle.supportedDenominatorSha256 = "f".repeat(64);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [...validatorCommand]),
    /supportedDenominatorSha256 must match raw production scope bytes/,
  );
  bundle.supportedDenominatorSha256 = sha256(scopeRaw);

  const replayedBuildSpecPath = path.join(outputDir, "replayed-build-spec.json");
  await writeFile(replayedBuildSpecPath, json({
    candidateId: "candidate-b",
    builderGitSha: "abcdef2",
    sourceSnapshots: [{ freshnessExpiresAt: "2099-08-01T00:00:00Z" }],
  }));
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle", bundlePath,
      ...scopeArgs,
      ...reportArgs,
      "--build-spec", replayedBuildSpecPath,
      "--manifest", artifactPaths.manifest,
      "--source-evidence", artifactPaths.source,
      "--server-evidence", artifactPaths.server,
      "--mobile-evidence", artifactPaths.mobile,
      "--require-pass",
    ], { cwd: root }),
    /launch denominator candidate binding must match current artifacts/,
  );

  const emptyServerRaw = json({
    candidateBinding: candidateIdentity,
    freshnessExpiresAt: "2099-08-01T00:00:00Z",
  });
  const emptyServerPath = path.join(outputDir, "empty-server-evidence.json");
  await writeFile(emptyServerPath, emptyServerRaw);
  const emptySource = JSON.parse(sourceEvidenceRaw);
  delete emptySource.launchDenominatorEvidence;
  const emptyMobile = JSON.parse(mobileEvidenceRaw);
  delete emptyMobile.launchDenominatorEvidence;
  const emptySourceRaw = json(emptySource);
  const emptyMobileRaw = json(emptyMobile);
  const emptyPayloadBinding = buildLaunchCandidateBinding({
    buildSpecRaw,
    manifestRaw,
    sourceEvidenceRaw: emptySourceRaw,
    serverEvidenceRaw: emptyServerRaw,
    mobileEvidenceRaw: emptyMobileRaw,
    now: new Date("2026-07-15T00:00:00Z"),
  });
  assert.equal(emptyPayloadBinding.status, "BOUND", "candidate bytes alone remain bound");
  const emptyPayloadInput = bindAuthoritativeLaunchEvidence(goReport.evaluatorInput, {
    sourceEvidenceRaw: emptySourceRaw,
    serverEvidenceRaw: emptyServerRaw,
    mobileEvidenceRaw: emptyMobileRaw,
    candidateBinding: emptyPayloadBinding,
  });
  const emptyPayloadReport = buildLaunchDenominatorReport(scope, emptyPayloadInput);
  assert.equal(emptyPayloadReport.decision, "NO_GO");
  for (const blocker of ["PILOT_ROW_GAP", "SOURCE_NOT_ADMITTED", "SIGNATURE_INVALID", "FORBIDDEN_EVIDENCE_UNVERIFIED"]) {
    assert.ok(emptyPayloadReport.blockers.includes(blocker), `${blocker} must fail closed without launch payload`);
  }
  const emptyServerBinding = buildLaunchCandidateBinding({
    buildSpecRaw,
    manifestRaw,
    sourceEvidenceRaw,
    serverEvidenceRaw: emptyServerRaw,
    mobileEvidenceRaw,
    now: new Date("2026-07-15T00:00:00Z"),
  });
  const forgedTemplateInput = structuredClone(goReport.evaluatorInput);
  forgedTemplateInput.candidateBinding = emptyServerBinding;
  forgedTemplateInput.server.artifactHash = emptyServerBinding.serverEvidence.sha256;
  const forgedTemplateReport = buildLaunchDenominatorReport(scope, forgedTemplateInput);
  assert.equal(forgedTemplateReport.decision, "GO", "forged template is internally canonical without raw evidence check");
  const forgedTemplateRaw = json(forgedTemplateReport);
  const forgedTemplatePath = path.join(outputDir, "forged-template-go.json");
  await writeFile(forgedTemplatePath, forgedTemplateRaw);
  bindLaunchReport(bundle, forgedTemplateReport, forgedTemplateRaw);
  bundle.strictRouteRegressionSha256 = emptyServerBinding.serverEvidence.sha256;
  await writeFile(bundlePath, json(bundle));
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle", bundlePath,
      ...scopeArgs,
      "--launch-report", forgedTemplatePath,
      "--build-spec", artifactPaths.buildSpec,
      "--manifest", artifactPaths.manifest,
      "--source-evidence", artifactPaths.source,
      "--server-evidence", emptyServerPath,
      "--mobile-evidence", artifactPaths.mobile,
      "--require-pass",
    ], { cwd: root }),
    /launch denominator evaluator input must match current authoritative evidence/,
  );
  bindLaunchReport(bundle, goReport, goReportRaw);
  bundle.strictRouteRegressionSha256 = candidateBinding.serverEvidence.sha256;

  const currentLaunchReportRaw = await readFile(path.join(root, currentLaunchReportPath), "utf8");
  const currentLaunchReport = JSON.parse(currentLaunchReportRaw);
  bindLaunchReport(bundle, currentLaunchReport, currentLaunchReportRaw);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(process.execPath, [
    "tools/datapack/validate-release-evidence-bundle.mjs",
    "--bundle",
    bundlePath,
    ...scopeArgs,
    "--launch-report",
    currentLaunchReportPath,
  ], { cwd: root });
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle",
      bundlePath,
      ...scopeArgs,
      "--launch-report",
      currentLaunchReportPath,
      "--require-pass",
    ], { cwd: root }),
    /publish validation requires current build spec, manifest, and source evidence/,
  );

  bundle.launchDenominatorDecision = "GO";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle",
      bundlePath,
      ...scopeArgs,
      "--launch-report",
      currentLaunchReportPath,
    ], { cwd: root }),
    /launch denominator report decision must match bundle/,
  );

  bindLaunchReport(bundle, currentLaunchReport, currentLaunchReportRaw);
  bundle.launchDenominatorReportSha256 = "f".repeat(64);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle",
      bundlePath,
      ...scopeArgs,
      "--launch-report",
      currentLaunchReportPath,
    ], { cwd: root }),
    /launch denominator report sha256 mismatch/,
  );

  const forgedGoReport = structuredClone(currentLaunchReport);
  forgedGoReport.decision = "GO";
  forgedGoReport.blockers = [];
  const forgedGoReportRaw = `${JSON.stringify(forgedGoReport, null, 2)}\n`;
  const forgedGoReportPath = path.join(outputDir, "launch-denominator-forged-go.json");
  await writeFile(forgedGoReportPath, forgedGoReportRaw);
  bindLaunchReport(bundle, forgedGoReport, forgedGoReportRaw);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle",
      bundlePath,
      ...scopeArgs,
      "--launch-report",
      forgedGoReportPath,
      ...candidateArgs,
      "--require-pass",
    ], { cwd: root }),
    /launch denominator report must match canonical evaluator output/,
  );

  const forgedEmptyIdentityReport = structuredClone(goReport);
  for (const consumer of ["source", "server", "mobile"]) {
    for (const field of ["canonicalStationVersion", "corridorId", "serviceId", "lineageId", "schemaVersion"]) {
      forgedEmptyIdentityReport.evaluatorInput[consumer].identity[field] = "";
    }
  }
  for (const field of ["canonicalStationVersion", "corridorId", "serviceId", "lineageId", "schemaVersion"]) {
    forgedEmptyIdentityReport.identityLinkage.shared[field] = "";
  }
  const forgedEmptyIdentityRaw = `${JSON.stringify(forgedEmptyIdentityReport, null, 2)}\n`;
  const forgedEmptyIdentityPath = path.join(outputDir, "launch-denominator-forged-empty-identity.json");
  await writeFile(forgedEmptyIdentityPath, forgedEmptyIdentityRaw);
  bindLaunchReport(bundle, forgedEmptyIdentityReport, forgedEmptyIdentityRaw);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle",
      bundlePath,
      ...scopeArgs,
      "--launch-report",
      forgedEmptyIdentityPath,
      ...candidateArgs,
      "--require-pass",
    ], { cwd: root }),
    /launch denominator report must match canonical evaluator output/,
  );

  const mismatchedReport = structuredClone(currentLaunchReport);
  mismatchedReport.scopes.routingLaunchScope.sha256 = "f".repeat(64);
  const mismatchedReportRaw = `${JSON.stringify(mismatchedReport, null, 2)}\n`;
  const mismatchedReportPath = path.join(outputDir, "launch-denominator-mismatched.json");
  await writeFile(mismatchedReportPath, mismatchedReportRaw);
  bindLaunchReport(bundle, mismatchedReport, mismatchedReportRaw);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle",
      bundlePath,
      ...scopeArgs,
      "--launch-report",
      mismatchedReportPath,
    ], { cwd: root }),
    /launch denominator report routing scope identity mismatch/,
  );

  bindLaunchReport(bundle, goReport, goReportRaw);

  bundle.launchScopeSha256 = "f".repeat(64);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/validate-release-evidence-bundle.mjs",
      "--bundle",
      bundlePath,
      ...scopeArgs,
      ...reportArgs,
    ], { cwd: root }),
    /launch denominator report routing scope binding mismatch/,
  );
  bundle.launchScopeSha256 = goReport.scopes.routingLaunchScope.sha256;

  bundle.androidEvidenceStatus = "FAIL";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...validatorCommand, "--require-pass"],
      { cwd: root },
    ),
    /androidEvidenceStatus must be PASS for publish/,
  );

  bundle.androidEvidenceStatus = "PASS";
  bundle.headwayReportStatus = "DEFERRED";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [...validatorCommand, "--require-pass"],
    { cwd: root },
  );

  bundle.headwayReportStatus = "PASS";
  // route_graph_topology는 capital pilot deferred domain이므로 위반 기록 시 DEFERRED가 publish gate를 통과한다.
  bundle.routeGraphTopologyStatus = "DEFERRED";
  bundle.routeGraphTopologyViolationCount = 4;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [...validatorCommand, "--require-pass"],
    { cwd: root },
  );

  // deferred가 아닌 다른 게이트(예: routeMapPositionCoverageStatus)는 DEFERRED를 허용하지 않는다.
  bundle.routeGraphTopologyStatus = "PASS";
  bundle.routeGraphTopologyViolationCount = 0;
  bundle.routeMapPositionCoverageStatus = "DEFERRED";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...validatorCommand, "--require-pass"],
      { cwd: root },
    ),
    /routeMapPositionCoverageStatus must be a release gate status/,
  );

  bundle.routeMapPositionCoverageStatus = "PASS";
  bundle.validatorStatus = "DEFERRED";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, validatorCommand, {
      cwd: root,
    }),
    /validatorStatus must be a release gate status/,
  );

  // route_graph_topology status와 위반 수치의 정합을 런타임에서 강제한다.
  bundle.validatorStatus = "PASS";
  // DEFERRED인데 위반 0 → 위반 은폐 모순, 거부.
  bundle.routeGraphTopologyStatus = "DEFERRED";
  bundle.routeGraphTopologyViolationCount = 0;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...validatorCommand, "--require-pass"],
      { cwd: root },
    ),
    /routeGraphTopologyStatus DEFERRED requires routeGraphTopologyViolationCount > 0/,
  );

  // PASS인데 위반 수치가 0이 아님 → 모순, 거부.
  bundle.routeGraphTopologyStatus = "PASS";
  bundle.routeGraphTopologyViolationCount = 4;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...validatorCommand, "--require-pass"],
      { cwd: root },
    ),
    /routeGraphTopologyStatus PASS requires routeGraphTopologyViolationCount 0/,
  );

  // 음수 위반 수치 거부.
  bundle.routeGraphTopologyStatus = "PASS";
  bundle.routeGraphTopologyViolationCount = -1;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...validatorCommand, "--require-pass"],
      { cwd: root },
    ),
    /routeGraphTopologyViolationCount must be a non-negative integer/,
  );

  // 위반 수치 누락 거부.
  bundle.routeGraphTopologyViolationCount = 0;
  delete bundle.routeGraphTopologyViolationCount;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [...validatorCommand, "--require-pass"],
      { cwd: root },
    ),
    /release evidence bundle missing routeGraphTopologyViolationCount/,
  );

  // 실데이터 경로(위반 4, DEFERRED) 정합 → 통과 유지.
  bundle.routeGraphTopologyStatus = "DEFERRED";
  bundle.routeGraphTopologyViolationCount = 4;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [...validatorCommand, "--require-pass"],
    { cwd: root },
  );
});

function signedRescueManifest({
  releaseSequence,
  failedManifestSha256,
  knownGoodManifestSha256,
  rollbackApprovalEventId,
  packSha256,
  sqliteSha256,
}) {
  const pack = {
    id: "capital",
    version: "1",
    artifactKind: "production",
    url: "https://cdn.example.com/catalog/capital-v1.sqlite.gz",
    sha256: packSha256,
    sqliteSha256,
    sizeBytes: 1,
    signature: { algorithm: "rsa-sha256-pack-manifest-v2", value: sign("pack") },
    schemaVersion: "1",
    sourceInventory: [{
      id: "source",
      owner: "owner",
      url: "https://data.example.com/source",
      license: "CC-BY-4.0",
      licenseStatus: "redistributable",
      redistributionAllowed: true,
      updateFrequency: "daily",
      updatedAt: "2026-07-14T00:00:00.000Z",
      fields: ["stations"],
      coverageScope: { regionIds: ["seoul"], operatorIds: ["metro"], sourceDomains: ["stations"] },
    }],
    regionalQualityMetrics: {
      stationCount: 1,
      facilityCoverageRatio: 1,
      requiredFacilityEvidenceCoverageRatio: 1,
      strictRouteEligibleFacilityRatio: 1,
      operationalKnownRatio: 1,
      freshnessValidRatio: 1,
      fieldVerifiedPathwayRatio: 1,
      edgeCount: 1,
      unknownAccessibilityRatio: 0,
      unknownEdgeRatioByProfile: { wheelchair: 0, stroller: 0, lowMobility: 0 },
    },
    representativeRouteRegressions: [],
    representativeRouteRegressionSignature: {
      algorithm: "rsa-sha256-route-regression-v1",
      value: sign("routes"),
    },
    requiredTables: ["stations"],
    minimumTableRows: {
      stations: 1,
      station_lines: 1,
      network_edges: 1,
      facilities: 1,
      station_facility_evidence: 1,
    },
  };
  const unsigned = {
    manifestVersion: 2,
    channel: "production",
    releaseSequence,
    publishedAt: "2026-07-15T01:00:00.000Z",
    expiresAt: "2026-07-16T01:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    packs: [pack],
    rollbackProvenance: {
      kind: "MONOTONIC_RESCUE",
      currentReleaseSequence: 115,
      failedReleaseSequence: 115,
      failedManifestSha256,
      knownGoodReleaseSequence: 114,
      knownGoodManifestSha256,
      rollbackApprovalEventId,
      approvedByRole: "admin.datapack.rollback",
      approvedAt: "2026-07-15T00:30:00.000Z",
      reasonCode: "ADMIN_APPROVED_ROLLBACK",
    },
  };
  return {
    ...unsigned,
    signature: { algorithm: "rsa-sha256-manifest-v2", value: sign(canonicalJson(unsigned)) },
  };
}

function sign(value) {
  return createSign("RSA-SHA256").update(value).sign(privateKeyPem).toString("base64url");
}

function resignManifest(value) {
  const { signature: _signature, ...unsigned } = value;
  value.signature = { algorithm: "rsa-sha256-manifest-v2", value: sign(canonicalJson(unsigned)) };
}
