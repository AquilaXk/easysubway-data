#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  buildLaunchDenominatorReport,
  canonicalScopeHash,
} from "./build-launch-denominator-report.mjs";
import {
  bindAuthoritativeLaunchEvidence,
  buildLaunchCandidateBinding,
} from "./launch-candidate-binding.mjs";
import { validateManifest } from "./lib/manifest-validation.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED_EXTERNAL"]);
// 필드별 허용 status set의 단일 소스. DEFERRED가 포함된 필드는 곧 deferred 허용 필드다
// (headway는 evidence 미도래, route_graph_topology는 capital pilot의 deferred domain — pilot targets의
// knownSourceDomains에만 존재). deferred domain 위반은 게시를 차단하지 않고 DEFERRED로 정직 기록하되,
// 위반 수치는 routeGraphTopologyViolationCount와 topology report SHA로 evidence에 전량 남긴다(은폐 금지).
// 이 맵 하나에서 allowedStatusesFor와 DEFERRED 허용 여부를 함께 파생한다(중복 상수 제거).
const DEFERRABLE_STATUSES = new Set([...STATUSES, "DEFERRED"]);
const FIELD_STATUS_SETS = new Map([
  ["headwayReportStatus", DEFERRABLE_STATUSES],
  ["routeGraphTopologyStatus", DEFERRABLE_STATUSES],
]);

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireField(bundle, field) {
  if (bundle[field] === undefined || bundle[field] === "") {
    throw new Error(`release evidence bundle missing ${field}`);
  }
  return bundle[field];
}

function validateSha(bundle, field) {
  const value = requireField(bundle, field);
  if (!SHA256.test(value)) {
    throw new Error(`${field} must be sha256`);
  }
}

function allowedStatusesFor(field) {
  return FIELD_STATUS_SETS.get(field) ?? STATUSES;
}

function validateStatus(bundle, field, requirePass) {
  const value = requireField(bundle, field);
  const allowedStatuses = allowedStatusesFor(field);
  if (!allowedStatuses.has(value)) {
    throw new Error(`${field} must be a release gate status`);
  }
  if (requirePass && value !== "PASS" && !(allowedStatuses.has("DEFERRED") && value === "DEFERRED")) {
    throw new Error(`${field} must be PASS for publish`);
  }
}

function validateNonNegativeInteger(bundle, field) {
  const value = requireField(bundle, field);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

// route_graph_topology의 status와 위반 수치는 워크플로에서 함께 파생된다:
// violationCount === 0 이면 PASS, 위반이 있으면 deferred scope에서 DEFERRED(그 외 FAIL/BLOCKED_EXTERNAL).
// 손 조립 bundle에서 이 정합이 깨진 조합(예: DEFERRED + violationCount 0 → 위반 은폐)을 런타임에서 차단한다.
function validateRouteGraphTopologyIntegrity(bundle) {
  const violationCount = validateNonNegativeInteger(bundle, "routeGraphTopologyViolationCount");
  const status = bundle.routeGraphTopologyStatus;
  if (status === "DEFERRED" && violationCount === 0) {
    throw new Error(
      "routeGraphTopologyStatus DEFERRED requires routeGraphTopologyViolationCount > 0 (위반 은폐 차단)",
    );
  }
  if (status === "PASS" && violationCount !== 0) {
    throw new Error("routeGraphTopologyStatus PASS requires routeGraphTopologyViolationCount 0");
  }
}

function validateRollbackRescue(bundle, requirePass, evidenceRaw, evidence, manifestRaw) {
  const rescue = bundle.rollbackRescue;
  if (rescue === undefined) return;
  if (!rescue || typeof rescue !== "object" || Array.isArray(rescue)) {
    throw new Error("rollbackRescue must be an object");
  }
  if (!evidenceRaw || !evidence) throw new Error("rollbackRescue requires --rollback-evidence");
  if (!manifestRaw) throw new Error("rollbackRescue requires --rollback-manifest");
  validateRollbackShape(rescue);
  validateRollbackBundleBinding(rescue, bundle);
  validateRollbackArtifactBinding(rescue, evidenceRaw, evidence, manifestRaw);
  if (requirePass && rescue.validatorStatus !== "PASS") {
    throw new Error("rollbackRescue validatorStatus must be PASS");
  }
  if (requirePass && rescue.manifestLastStatus !== "PASS") {
    throw new Error("rollbackRescue manifestLastStatus must be PASS");
  }
}

function validateRollbackShape(rescue) {
  for (const field of [
    "evidenceSha256",
    "rcManifestSha256",
    "knownGoodPackSha256",
    "knownGoodSqliteSha256",
    "rescueManifestSha256",
  ]) {
    if (!SHA256.test(rescue[field] ?? "")) throw new Error(`rollbackRescue ${field} must be sha256`);
  }
  for (const field of ["releaseRequestId", "rollbackApprovalEventId", "rcCandidateId"]) {
    if (typeof rescue[field] !== "string" || rescue[field].length === 0) {
      throw new Error(`rollbackRescue ${field} must be a non-empty string`);
    }
  }
  for (const field of [
    "currentReleaseSequence",
    "failedReleaseSequence",
    "knownGoodReleaseSequence",
    "rescueReleaseSequence",
  ]) {
    if (!Number.isInteger(rescue[field]) || rescue[field] < 1) {
      throw new Error(`rollbackRescue ${field} must be a positive integer`);
    }
  }
  if (!(
    rescue.knownGoodReleaseSequence < rescue.failedReleaseSequence
    && rescue.failedReleaseSequence === rescue.currentReleaseSequence
    && rescue.currentReleaseSequence < rescue.rescueReleaseSequence
  )) {
    throw new Error("rollbackRescue sequences must satisfy knownGood < failed = current < rescue");
  }
  if (!Number.isInteger(rescue.recoveryDurationSeconds) || rescue.recoveryDurationSeconds < 0) {
    throw new Error("rollbackRescue recoveryDurationSeconds must be a non-negative integer");
  }
  if (!new Set(["PASS", "FAIL"]).has(rescue.validatorStatus)) {
    throw new Error("rollbackRescue validatorStatus must be PASS or FAIL");
  }
  if (!new Set(["PASS", "FAIL", "NOT_EXECUTED"]).has(rescue.manifestLastStatus)) {
    throw new Error("rollbackRescue manifestLastStatus is invalid");
  }
  if (!new Set(["DRY_RUN", "LOCAL_FIXTURE", "NON_PRODUCTION", "PRODUCTION"]).has(rescue.executionEnvironment)) {
    throw new Error("rollbackRescue executionEnvironment is invalid");
  }
  if (typeof rescue.productionExecuted !== "boolean") {
    throw new TypeError("rollbackRescue productionExecuted must be boolean");
  }
  if ((rescue.executionEnvironment === "PRODUCTION") !== rescue.productionExecuted) {
    throw new Error("rollbackRescue productionExecuted must match executionEnvironment");
  }
}

function validateRollbackBundleBinding(rescue, bundle) {
  if (rescue.releaseRequestId !== bundle.releaseRequestId) {
    throw new Error("rollbackRescue releaseRequestId must match bundle releaseRequestId");
  }
  if (rescue.rcCandidateId !== bundle.candidateId) {
    throw new Error("rollbackRescue rcCandidateId must match bundle candidateId");
  }
  if (rescue.rcManifestSha256 !== bundle.manifestSha256) {
    throw new Error("rollbackRescue rcManifestSha256 must match bundle manifestSha256");
  }
}

function validateRollbackArtifactBinding(rescue, evidenceRaw, evidence, manifestRaw) {
  if (rescue.evidenceSha256 !== createHash("sha256").update(evidenceRaw).digest("hex")) {
    throw new Error("rollbackRescue evidence sha256 mismatch");
  }
  if (rescue.rescueManifestSha256 !== createHash("sha256").update(manifestRaw).digest("hex")) {
    throw new Error("rollbackRescue manifest sha256 mismatch");
  }
  const manifest = JSON.parse(manifestRaw);
  validateManifest(manifest, { requireProduction: true, releasesTarget: true });
  if (manifest.releaseSequence !== rescue.rescueReleaseSequence) {
    throw new Error("rollbackRescue manifest releaseSequence mismatch");
  }
  if (evidence.schemaVersion !== 1 || evidence.artifactKind !== "datapack-rollback-rescue-evidence") {
    throw new Error("rollbackRescue evidence identity mismatch");
  }
  for (const [field, actual] of [
    ["rollbackApprovalEventId", evidence.rollbackApprovalEventId],
    ["currentReleaseSequence", evidence.from?.releaseSequence],
    ["failedReleaseSequence", evidence.failed?.releaseSequence],
    ["knownGoodReleaseSequence", evidence.knownGood?.releaseSequence],
    ["rescueReleaseSequence", evidence.rescue?.releaseSequence],
    ["rescueManifestSha256", evidence.rescue?.manifestSha256],
    ["recoveryDurationSeconds", evidence.recoveryDurationSeconds],
    ["validatorStatus", evidence.validatorStatus],
    ["manifestLastStatus", evidence.manifestLastStatus],
    ["executionEnvironment", evidence.executionEnvironment],
    ["productionExecuted", evidence.productionExecuted],
  ]) {
    if (rescue[field] !== actual) throw new Error(`rollbackRescue ${field} evidence mismatch`);
  }
  const provenance = manifest.rollbackProvenance;
  for (const [field, expected] of [
    ["currentReleaseSequence", rescue.currentReleaseSequence],
    ["failedReleaseSequence", rescue.failedReleaseSequence],
    ["knownGoodReleaseSequence", rescue.knownGoodReleaseSequence],
    ["failedManifestSha256", rescue.rcManifestSha256],
    ["knownGoodManifestSha256", evidence.knownGood?.manifestSha256],
    ["rollbackApprovalEventId", rescue.rollbackApprovalEventId],
    ["approvedByRole", evidence.approvedByRole],
    ["approvedAt", evidence.approvedAt],
    ["reasonCode", evidence.reasonCode],
  ]) {
    if (provenance?.[field] !== expected) {
      throw new Error(`rollbackRescue manifest rollbackProvenance ${field} mismatch`);
    }
  }
  if (evidence.failed?.manifestSha256 !== rescue.rcManifestSha256) {
    throw new Error("rollbackRescue failed manifest evidence mismatch");
  }
  const knownGoodPack = evidence.knownGood?.packs?.find((pack) =>
    pack.sha256 === rescue.knownGoodPackSha256
    && pack.sqliteSha256 === rescue.knownGoodSqliteSha256);
  if (!knownGoodPack) {
    throw new Error("rollbackRescue known-good pack evidence mismatch");
  }
  if (!manifest.packs.some((pack) =>
    pack.id === knownGoodPack.id
    && pack.version === knownGoodPack.version
    && pack.sha256 === knownGoodPack.sha256
    && pack.sqliteSha256 === knownGoodPack.sqliteSha256)) {
    throw new Error("rollbackRescue manifest known-good pack identity mismatch");
  }
}

function validateLaunchDenominatorReport(
  bundle,
  report,
  reportRaw,
  scope,
  requirePass,
  candidateBinding,
  candidateArtifactRaw,
) {
  const scopeBindings = [
    [
      "verified accessibility",
      report.scopes?.verifiedAccessibilityScope,
      scope.verifiedAccessibilityScope,
      "verifiedAccessibilityScopeId",
      "verifiedAccessibilityScopeSha256",
    ],
    [
      "routing",
      report.scopes?.routingLaunchScope,
      scope.routingLaunchScope,
      "launchScopeId",
      "launchScopeSha256",
    ],
    [
      "nationwide roadmap",
      report.scopes?.nationwideRoadmapScope,
      scope.nationwideRoadmapScope,
      "nationwideRoadmapScopeId",
      "nationwideRoadmapScopeSha256",
    ],
  ];
  for (const [label, reportScope, canonicalScope, idField, hashField] of scopeBindings) {
    if (
      reportScope?.id !== canonicalScope?.id
      || reportScope?.sha256 !== canonicalScopeHash(canonicalScope)
    ) {
      throw new Error(`launch denominator report ${label} scope identity mismatch`);
    }
    if (bundle[idField] !== reportScope.id || bundle[hashField] !== reportScope.sha256) {
      throw new Error(`launch denominator report ${label} scope binding mismatch`);
    }
  }
  if (bundle.scopeId !== report.scopes.verifiedAccessibilityScope.id) {
    throw new Error("scopeId must match launch denominator verified accessibility scope");
  }
  const matrixSha256 = canonicalScopeHash(scope.identityMatrix);
  if (
    report.identityLinkage?.matrixSha256 !== matrixSha256
    || bundle.identityLinkageMatrixSha256 !== report.identityLinkage.matrixSha256
  ) {
    throw new Error("launch denominator report identity linkage matrix mismatch");
  }
  if (
    report.nationwideBlocksV1 !== false
    || report.coverage?.nationwide?.blocksV1 !== false
    || scope.nationwideRoadmapScope?.blocksRoutingLaunch !== false
  ) {
    throw new Error("nationwide roadmap must remain nonblocking for v1 launch");
  }
  const canonicalReport = buildLaunchDenominatorReport(scope, report.evaluatorInput);
  if (!isDeepStrictEqual(report, canonicalReport)) {
    throw new Error("launch denominator report must match canonical evaluator output");
  }
  if (candidateBinding && !isDeepStrictEqual(report.evaluatorInput?.candidateBinding, candidateBinding)) {
    throw new Error("launch denominator candidate binding must match current artifacts");
  }
  if (candidateBinding) {
    const authoritativeInput = bindAuthoritativeLaunchEvidence(report.evaluatorInput, {
      ...candidateArtifactRaw,
      candidateBinding,
    });
    const authoritativeReport = buildLaunchDenominatorReport(scope, authoritativeInput);
    if (!isDeepStrictEqual(report.evaluatorInput, authoritativeReport.evaluatorInput)) {
      throw new Error("launch denominator evaluator input must match current authoritative evidence");
    }
  }
  if (candidateBinding) {
    for (const [field, expected] of [
      ["candidateId", candidateBinding.packCandidateId],
      ["buildCandidateId", candidateBinding.buildCandidateId],
      ["candidateBuilderGitSha", candidateBinding.candidateBuilderGitSha],
      ["buildSpecSha256", candidateBinding.buildSpecSha256],
      ["manifestSha256", candidateBinding.manifestSha256],
      ["normalizedSourceInventorySha256", candidateBinding.sourceEvidence.sha256 ?? "0".repeat(64)],
      ["strictRouteRegressionSha256", candidateBinding.serverEvidence.sha256 ?? "0".repeat(64)],
      ["androidEvidenceSha256", candidateBinding.mobileEvidence.sha256 ?? "0".repeat(64)],
    ]) {
      if (bundle[field] !== expected) {
        throw new Error(`release evidence bundle ${field} must match current candidate binding`);
      }
    }
  }
  if (bundle.launchDenominatorDecision !== report.decision) {
    throw new Error("launch denominator report decision must match bundle");
  }
  const reportSha256 = createHash("sha256").update(reportRaw).digest("hex");
  if (bundle.launchDenominatorReportSha256 !== reportSha256) {
    throw new Error("launch denominator report sha256 mismatch");
  }
  if (requirePass && report.decision !== "GO") {
    throw new Error("launch denominator decision must be GO for publish");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const bundlePath = argValue(args, "--bundle");
  const scopePath = argValue(args, "--scope") ?? "apps/mobile/release/production-datapack-scope.json";
  const launchReportPath = argValue(args, "--launch-report")
    ?? "tools/datapack/reports/android-v1-launch-denominator-20260715.json";
  const accessibilitySourceCoveragePath = argValue(args, "--accessibility-source-coverage");
  const candidatePaths = {
    buildSpec: argValue(args, "--build-spec"),
    manifest: argValue(args, "--manifest"),
    source: argValue(args, "--source-evidence"),
    server: argValue(args, "--server-evidence"),
    mobile: argValue(args, "--mobile-evidence"),
  };
  const requirePass = args.includes("--require-pass");
  if (!bundlePath) {
    throw new Error("--bundle is required");
  }

  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const rollbackEvidencePath = argValue(args, "--rollback-evidence");
  const rollbackEvidenceRaw = rollbackEvidencePath
    ? await readFile(rollbackEvidencePath, "utf8")
    : null;
  const rollbackEvidence = rollbackEvidenceRaw ? JSON.parse(rollbackEvidenceRaw) : null;
  const rollbackManifestPath = argValue(args, "--rollback-manifest");
  const rollbackManifestRaw = rollbackManifestPath
    ? await readFile(rollbackManifestPath, "utf8")
    : null;
  const scopeRaw = await readFile(scopePath, "utf8");
  const scope = JSON.parse(scopeRaw);
  const launchReportRaw = await readFile(launchReportPath, "utf8");
  const launchReport = JSON.parse(launchReportRaw);
  const accessibilitySourceCoverageRaw = accessibilitySourceCoveragePath
    ? await readFile(accessibilitySourceCoveragePath, "utf8")
    : null;
  const requiredCandidatePaths = ["buildSpec", "manifest", "source"];
  if (requirePass && requiredCandidatePaths.some((key) => !candidatePaths[key])) {
    throw new Error("publish validation requires current build spec, manifest, and source evidence");
  }
  if (requirePass && !accessibilitySourceCoveragePath) {
    throw new Error("publish validation requires accessibility source coverage evidence");
  }
  const hasCandidatePaths = Object.values(candidatePaths).some(Boolean);
  if (hasCandidatePaths && requiredCandidatePaths.some((key) => !candidatePaths[key])) {
    throw new Error("candidate validation requires build spec, manifest, and source evidence together");
  }
  const readOptional = async (file) => file ? readFile(file, "utf8") : null;
  const candidateArtifactRaw = hasCandidatePaths ? {
    buildSpecRaw: await readOptional(candidatePaths.buildSpec),
    manifestRaw: await readOptional(candidatePaths.manifest),
    sourceEvidenceRaw: await readOptional(candidatePaths.source),
    serverEvidenceRaw: await readOptional(candidatePaths.server),
    mobileEvidenceRaw: await readOptional(candidatePaths.mobile),
  } : null;
  const candidateBinding = candidateArtifactRaw
    ? buildLaunchCandidateBinding(candidateArtifactRaw)
    : null;
  for (const [field, expected] of [
    ["schemaVersion", 1],
    ["artifactKind", "datapack-release-evidence-bundle"],
  ]) {
    if (bundle[field] !== expected) {
      throw new Error(`${field} must be ${expected}`);
    }
  }

  for (const field of [
    "candidateId",
    "buildCandidateId",
    "candidateBuilderGitSha",
    "scopeId",
    "verifiedAccessibilityScopeId",
    "launchScopeId",
    "nationwideRoadmapScopeId",
    "launchDenominatorDecision",
    "releaseRequestId",
    "builderGitSha",
    "createdAt",
    "workflowRunUrl",
  ]) {
    requireField(bundle, field);
  }
  const rawScopeSha256 = createHash("sha256").update(scopeRaw).digest("hex");
  if (bundle.supportedDenominatorSha256 !== rawScopeSha256) {
    throw new Error("supportedDenominatorSha256 must match raw production scope bytes");
  }
  validateLaunchDenominatorReport(
    bundle,
    launchReport,
    launchReportRaw,
    scope,
    requirePass,
    candidateBinding,
    candidateArtifactRaw,
  );
  for (const field of [
    "verifiedAccessibilityScopeSha256",
    "launchScopeSha256",
    "nationwideRoadmapScopeSha256",
    "identityLinkageMatrixSha256",
    "launchDenominatorReportSha256",
    "buildSpecSha256",
    "supportedDenominatorSha256",
    "sourceSnapshotSetHash",
    "approvedAliasLedgerHash",
    "facilityEvidenceLedgerHash",
    "routeEvidenceLedgerHash",
    "approvedOverrideSetHash",
    "normalizedSourceInventorySha256",
    "sqliteSha256",
    "gzipSha256",
    "manifestSha256",
    "coverageSummarySha256",
    "accessibilitySourceCoverageSha256",
    "itxCheongchunCoverageSha256",
    "routeMapPositionCoverageSha256",
    "routeGraphTopologySha256",
    "headwayReportSha256",
    "strictRouteRegressionSha256",
    "androidEvidenceSha256",
  ]) {
    validateSha(bundle, field);
  }
  if (!["GO", "NO_GO", "NOT_EVALUATED"].includes(bundle.accessibilitySourceCoverageDecision)) {
    throw new Error("accessibilitySourceCoverageDecision must be GO, NO_GO, or NOT_EVALUATED");
  }
  if (accessibilitySourceCoverageRaw != null) {
    const report = JSON.parse(accessibilitySourceCoverageRaw);
    if (bundle.accessibilitySourceCoverageSha256
      !== createHash("sha256").update(accessibilitySourceCoverageRaw).digest("hex")) {
      throw new Error("accessibility source coverage sha256 mismatch");
    }
    if (bundle.accessibilitySourceCoverageDecision !== report.decision) {
      throw new Error("accessibility source coverage decision must match bundle");
    }
  }
  if (requirePass && bundle.accessibilitySourceCoverageDecision !== "GO") {
    throw new Error("accessibility source coverage decision must be GO for publish");
  }
  for (const field of [
    "validatorStatus",
    "coverageStatus",
    "routeMapPositionCoverageStatus",
    "routeGraphTopologyStatus",
    "headwayReportStatus",
    "strictRouteRegressionStatus",
    "manifestSignatureStatus",
    "androidEvidenceStatus",
  ]) {
    validateStatus(bundle, field, requirePass);
  }

  validateRouteGraphTopologyIntegrity(bundle);
  validateRollbackRescue(bundle, requirePass, rollbackEvidenceRaw, rollbackEvidence, rollbackManifestRaw);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
