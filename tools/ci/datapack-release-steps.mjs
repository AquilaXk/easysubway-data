import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { buildLaunchDenominatorReport } from "../datapack/build-launch-denominator-report.mjs";
import { buildMapCatalogSignedCurrentPublication } from "../datapack/build-map-catalog-signed-current-publication.mjs";
import { validateServerRouteBundlePublicationDescriptor } from "../datapack/build-server-route-bundle-publication-descriptor.mjs";
import {
  bindAuthoritativeLaunchEvidence,
  buildLaunchCandidateBinding,
} from "../datapack/launch-candidate-binding.mjs";
import { rsaSha256Signature, signingPrivateKey } from "../datapack/lib/manifest-signing.mjs";
import {
  canonicalJson,
  selectEffectiveDataPack,
  signingPublicKey,
  stagedPackPath,
  verifyRsaSha256Signature,
} from "../datapack/lib/manifest-validation.mjs";
import { readCredentialFreeObject } from "../datapack/publish-server-route-bundle.mjs";
import { sha256 } from "../lib/hash.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { isObject } from "../lib/is-object.mjs";

const GIT_EXECUTABLE = "/usr/bin/git";
const hashFile = (file) => sha256(fs.readFileSync(file));

export const MODE_ARGS_KEYS = Object.freeze([
  "buildSpecPath",
  "releaseRequestId",
  "releaseRequestPath",
  "androidEvidencePath",
  "strictRouteRegressionPath",
  "allowGaps",
  "rollbackTargetSequence",
  "rollbackFailedSequence",
  "rollbackPublishedAt",
  "rollbackExpiresAt",
  "rolloutPercentage",
  "rolloutTargetSequence",
  "sourceGovernanceEvaluationAt",
  "candidateRunId",
  "promotionRunId",
]);

export function parseModeArgs({
  modeArgsInput = process.env.MODE_ARGS_INPUT,
  githubOutputPath = process.env.GITHUB_OUTPUT,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(modeArgsInput || "{}");
  } catch (error) {
    throw new Error(`modeArgs must be a JSON object: ${error.message}`);
  }
  if (!isObject(parsed)) {
    throw new Error("modeArgs must be a JSON object");
  }
  const out = [];
  for (const key of MODE_ARGS_KEYS) {
    const value = String(parsed[key] ?? "");
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error(`modeArgs.${key} must not contain newlines`);
    }
    out.push(`${key}=${value}`);
  }
  fs.appendFileSync(githubOutputPath, `${out.join("\n")}\n`);
}

export function assertReleaseBuildSpecContent(buildSpecPath = process.env.BUILD_SPEC_PATH) {
  let buildSpec;
  try {
    buildSpec = JSON.parse(fs.readFileSync(buildSpecPath, "utf8"));
  } catch {
    throw new Error(`release build spec is not valid JSON: ${buildSpecPath}`);
  }
  const fixturePath = buildSpec.fixturePath;
  if (
    typeof fixturePath === "string" &&
    (/(fixture|debug|demo|sample)/i.test(fixturePath) ||
      /(^|[\\/])fixtures([\\/]|$)/i.test(fixturePath))
  ) {
    throw new Error("release mode cannot use fixture input");
  }
}

export function readScheduledReleaseRequestId(file = process.env.RELEASE_REQUEST_FILE) {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`scheduled release request is not valid JSON: ${file}`);
  }
  if (typeof request.approvalId !== "string" || request.approvalId === "") {
    throw new Error("scheduled release request approvalId is required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(request.approvalId)) {
    throw new Error("scheduled release request approvalId must be a single [A-Za-z0-9._-] token");
  }
  return request.approvalId;
}

function requireSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ""))) {
    throw new Error(`${label} must be sha256`);
  }
}

function validateBuildSpecRawPurgeEvidence(buildSpec, sourceGovernanceEvaluationAt, eventName) {
  if (!buildSpec.sourceRawPurgeReportPath) {
    return;
  }
  if (eventName === "schedule") {
    throw new Error("scheduled production publish requires a fresh protection evidence pipeline");
  }
  if (
    !sourceGovernanceEvaluationAt ||
    !Number.isFinite(Date.parse(sourceGovernanceEvaluationAt))
  ) {
    throw new Error("sourceGovernanceEvaluationAt is required with sourceRawPurgeReportPath");
  }
  for (const [pathField, hashField] of [
    ["sourceRawPurgeReportPath", "sourceRawPurgeReportSha256"],
    ["sourceRawPurgeJournalPath", "sourceRawPurgeJournalSha256"],
    ["sourceRawPurgeLedgerPath", "sourceRawPurgeLedgerSha256"],
    ["sourceRawPurgeAttestationPublicKeyPath", "sourceRawPurgeAttestationPublicKeySha256"],
  ]) {
    if (!buildSpec[pathField] || typeof buildSpec[pathField] !== "string") {
      throw new Error(`buildSpec.${pathField} is required with sourceRawPurgeReportPath`);
    }
    requireSha256(buildSpec[hashField], `buildSpec.${hashField}`);
  }
}

function validateReleaseRequestAgainstBuildSpec({
  releaseRequestPath,
  releaseRequestId,
  targetChannel,
  mode,
  buildSpecPath,
  buildSpec,
}) {
  const request = JSON.parse(fs.readFileSync(releaseRequestPath, "utf8"));
  if (request.artifactKind !== "datapack-release-request") {
    throw new Error("release request artifactKind must be datapack-release-request");
  }
  if (request.approvalId !== releaseRequestId) {
    throw new Error("releaseRequestId must match approvalId");
  }
  if (
    !request.requestedBy ||
    !request.approvedBy ||
    request.requestedBy === request.approvedBy
  ) {
    throw new Error("release request approver must differ from requester");
  }
  if (request.targetChannel !== targetChannel) {
    throw new Error("release request targetChannel mismatch");
  }
  if (request.buildSpecSha256 !== hashFile(buildSpecPath)) {
    throw new Error("release request buildSpecSha256 mismatch");
  }
  if (request.sourceSnapshotSetHash !== buildSpec.sourceSnapshotSetHash) {
    throw new Error("release request sourceSnapshotSetHash mismatch");
  }
  if (request.approvedLedgerHash !== buildSpec.approvedAliasLedgerHash) {
    throw new Error("release request approvedLedgerHash mismatch");
  }
  if (mode === "production-publish" && targetChannel !== "production") {
    throw new Error("production-publish requires targetChannel=production");
  }
}

export function validateReleaseBuildSpecAndRequest({
  buildSpecPath,
  releaseRequestId,
  releaseRequestPath,
  targetChannel,
  mode,
  sourceGovernanceEvaluationAt,
  eventName = process.env.GITHUB_EVENT_NAME,
}) {
  const buildSpec = JSON.parse(fs.readFileSync(buildSpecPath, "utf8"));
  if (buildSpec.artifactKind !== "datapack-candidate-build-spec") {
    throw new Error("buildSpec.artifactKind must be datapack-candidate-build-spec");
  }
  if (!Array.isArray(buildSpec.sourceSnapshotIds) || buildSpec.sourceSnapshotIds.length === 0) {
    throw new Error("buildSpec.sourceSnapshotIds must not be empty");
  }
  for (const field of [
    "sourceSnapshotSetHash",
    "approvedAliasLedgerHash",
    "facilityEvidenceLedgerHash",
    "routeEvidenceLedgerHash",
    "approvedOverrideSetHash",
    "sourceInventorySha256",
  ]) {
    requireSha256(buildSpec[field], `buildSpec.${field}`);
  }
  validateBuildSpecRawPurgeEvidence(buildSpec, sourceGovernanceEvaluationAt, eventName);
  if (releaseRequestPath) {
    validateReleaseRequestAgainstBuildSpec({
      releaseRequestPath,
      releaseRequestId,
      targetChannel,
      mode,
      buildSpecPath,
      buildSpec,
    });
  }
}

function resolveGateStatus(passed, releaseLike) {
  if (passed) {
    return "PASS";
  }
  return releaseLike ? "FAIL" : "BLOCKED_EXTERNAL";
}

export function writeReleaseEvidenceBundle() {
  const zeroHash = "0".repeat(64);
  const stage = process.env.EASYSUBWAY_DATAPACK_STAGE;
  const manifestPath = path.join(stage, "catalog", "current.json");
  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const pack = manifest.packs?.[0] ?? {};
  const buildSpecPath = process.env.EASYSUBWAY_DATAPACK_BUILD_SPEC_PATH;
  const buildSpecRaw = fs.readFileSync(buildSpecPath, "utf8");
  const buildSpec = JSON.parse(buildSpecRaw);
  const productionScope = JSON.parse(
    fs.readFileSync(process.env.EASYSUBWAY_DATAPACK_SCOPE_POLICY, "utf8"),
  );
  const catalogDir = path.join(stage, "catalog");
  const gzipFile = fs.readdirSync(catalogDir).find((name) => name.endsWith(".sqlite.gz"));
  const releaseMode = process.env.EASYSUBWAY_DATAPACK_RELEASE_MODE;
  const releaseLike = /^(release-candidate|production-publish)$/.test(releaseMode);
  const strictEvidence = process.env.EASYSUBWAY_STRICT_ROUTE_REGRESSION_PATH || "";
  const androidEvidence = process.env.EASYSUBWAY_ANDROID_EVIDENCE_PATH || "";
  const sourceEvidencePath = `${process.env.EASYSUBWAY_DATAPACK_OUTPUT}/current.provenance.json`;
  const optionalRaw = (file) =>
    file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const accessibilitySourceCoverageRaw = optionalRaw(
    process.env.EASYSUBWAY_ACCESSIBILITY_SOURCE_COVERAGE_REPORT,
  );
  const accessibilitySourceCoverage = accessibilitySourceCoverageRaw
    ? JSON.parse(accessibilitySourceCoverageRaw)
    : null;
  const launchEvidenceRaw = {
    buildSpecRaw,
    manifestRaw,
    sourceEvidenceRaw: optionalRaw(sourceEvidencePath),
    serverEvidenceRaw: optionalRaw(strictEvidence),
    mobileEvidenceRaw: optionalRaw(androidEvidence),
  };
  const candidateBinding = buildLaunchCandidateBinding(launchEvidenceRaw);
  const evaluatorInput = bindAuthoritativeLaunchEvidence({
    ...launchEvidenceRaw,
    candidateBinding,
  });
  const launchReport = buildLaunchDenominatorReport(productionScope, evaluatorInput);
  const launchDenominatorReportRaw = Buffer.from(`${JSON.stringify(launchReport, null, 2)}\n`);
  fs.writeFileSync(process.env.EASYSUBWAY_LAUNCH_DENOMINATOR_REPORT, launchDenominatorReportRaw);
  const externalStatus = (file) =>
    resolveGateStatus(Boolean(file && fs.existsSync(file)), releaseLike);
  const releaseHash = (field) => {
    const value = releaseLike ? buildSpec[field] : pack[field] ?? zeroHash;
    const normalized = String(value ?? "").trim().toLowerCase();
    if (releaseLike && !/^[a-f0-9]{64}$/.test(normalized)) {
      throw new Error(`buildSpec.${field} must be sha256`);
    }
    return normalized || zeroHash;
  };
  const topologyReport = JSON.parse(
    fs.readFileSync(process.env.EASYSUBWAY_ROUTE_GRAPH_TOPOLOGY_REPORT, "utf8"),
  );
  const headwayReport = JSON.parse(fs.readFileSync(process.env.EASYSUBWAY_HEADWAY_REPORT, "utf8"));
  const routeGraphTopologyViolationCount = [
    "localRideAdjacencyViolationCount",
    "nonAdjacentExpressRideViolationCount",
    "rideSpeedViolationCount",
    "disconnectedNodeCount",
    "unreachableDirectedPairCount",
  ].reduce((sum, field) => sum + Number(topologyReport.summary?.[field] ?? 0), 0);
  // topology 위반은 releaseLike에서 즉시 실패하고, exploratory에서는 외부 차단으로 기록한다.
  const routeGraphTopologyStatus = resolveGateStatus(
    routeGraphTopologyViolationCount === 0,
    releaseLike,
  );
  const headwayEvidenceCount =
    Number(headwayReport.summary?.observedHeadwayGroupCount ?? 0) +
    Number(headwayReport.summary?.declaredFrequencyCount ?? 0);
  const headwayReportStatus = headwayEvidenceCount > 0 ? "PASS" : "DEFERRED";
  const candidateServerRouteEvidence =
    releaseMode === "release-candidate"
      ? {
          candidateId: candidateBinding.buildCandidateId,
          sourceSnapshotSetHash: buildSpec.sourceSnapshotSetHash,
          buildSpecSha256: candidateBinding.buildSpecSha256,
          manifestSha256: candidateBinding.manifestSha256,
          eligibility: {
            path: "server-route-bundle-evidence/route-accessibility-eligibility.json",
            sha256: hashFile(
              path.join(
                stage,
                "server-route-bundle-evidence",
                "route-accessibility-eligibility.json",
              ),
            ),
          },
          final: {
            path: "server-route-bundle-evidence/server-route-bundle-final.json",
            sha256: hashFile(
              path.join(stage, "server-route-bundle-evidence", "server-route-bundle-final.json"),
            ),
          },
        }
      : null;

  const bundle = {
    schemaVersion: 1,
    artifactKind: "datapack-release-evidence-bundle",
    releaseMode,
    candidateId: candidateBinding.packCandidateId,
    buildCandidateId: candidateBinding.buildCandidateId,
    candidateBuilderGitSha: candidateBinding.candidateBuilderGitSha,
    scopeId: launchReport.scopes.verifiedAccessibilityScope.id,
    verifiedAccessibilityScopeId: launchReport.scopes.verifiedAccessibilityScope.id,
    verifiedAccessibilityScopeSha256: launchReport.scopes.verifiedAccessibilityScope.sha256,
    launchScopeId: launchReport.scopes.routingLaunchScope.id,
    launchScopeSha256: launchReport.scopes.routingLaunchScope.sha256,
    nationwideRoadmapScopeId: launchReport.scopes.nationwideRoadmapScope.id,
    nationwideRoadmapScopeSha256: launchReport.scopes.nationwideRoadmapScope.sha256,
    nationwideTargetsSha256: hashFile("tools/datapack/nationwide-coverage-targets.json"),
    identityLinkageMatrixSha256: launchReport.identityLinkage.matrixSha256,
    launchDenominatorDecision: launchReport.decision,
    launchDenominatorReportSha256: sha256(launchDenominatorReportRaw),
    releaseRequestId: process.env.EASYSUBWAY_DATAPACK_RELEASE_REQUEST_ID,
    builderGitSha: process.env.GITHUB_SHA,
    buildSpecSha256: candidateBinding.buildSpecSha256,
    supportedDenominatorSha256: hashFile(process.env.EASYSUBWAY_DATAPACK_SCOPE_POLICY),
    sourceSnapshotSetHash: releaseHash("sourceSnapshotSetHash"),
    approvedAliasLedgerHash: releaseHash("approvedAliasLedgerHash"),
    facilityEvidenceLedgerHash: releaseHash("facilityEvidenceLedgerHash"),
    routeEvidenceLedgerHash: releaseHash("routeEvidenceLedgerHash"),
    approvedOverrideSetHash: releaseHash("approvedOverrideSetHash"),
    normalizedSourceInventorySha256: candidateBinding.sourceEvidence.sha256 ?? zeroHash,
    sqliteSha256: pack.sqliteSha256 ?? pack.sha256 ?? zeroHash,
    gzipSha256: gzipFile ? hashFile(path.join(catalogDir, gzipFile)) : zeroHash,
    manifestSha256: candidateBinding.manifestSha256,
    releaseSequence: manifest.releaseSequence,
    coverageSummarySha256: hashFile(process.env.EASYSUBWAY_COVERAGE_GAP_REPORT),
    accessibilitySourceCoverageSha256: accessibilitySourceCoverageRaw
      ? sha256(accessibilitySourceCoverageRaw)
      : zeroHash,
    accessibilitySourceCoverageDecision: accessibilitySourceCoverage?.decision ?? "NOT_EVALUATED",
    itxCheongchunCoverageSha256: hashFile("tools/datapack/itx-cheongchun-coverage-contract.json"),
    routeMapPositionCoverageSha256: hashFile(process.env.EASYSUBWAY_ROUTE_MAP_AUDIT_REPORT),
    routeGraphTopologySha256: hashFile(process.env.EASYSUBWAY_ROUTE_GRAPH_TOPOLOGY_REPORT),
    headwayReportSha256: hashFile(process.env.EASYSUBWAY_HEADWAY_REPORT),
    strictRouteRegressionSha256: candidateBinding.serverEvidence.sha256 ?? zeroHash,
    androidEvidenceSha256: candidateBinding.mobileEvidence.sha256 ?? zeroHash,
    ...(candidateServerRouteEvidence ? { candidateServerRouteEvidence } : {}),
    validatorStatus: "PASS",
    coverageStatus: releaseLike ? "PASS" : "BLOCKED_EXTERNAL",
    routeMapPositionCoverageStatus: "PASS",
    routeGraphTopologyStatus,
    routeGraphTopologyViolationCount,
    headwayReportStatus,
    strictRouteRegressionStatus: externalStatus(strictEvidence),
    manifestSignatureStatus: "PASS",
    androidEvidenceStatus: externalStatus(androidEvidence),
    createdAt: new Date().toISOString(),
    workflowRunUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  };
  fs.writeFileSync(
    process.env.EASYSUBWAY_RELEASE_EVIDENCE_BUNDLE,
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
}

export function assertExecutableProductionDecision(decisionPath) {
  const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
  const executable =
    decision.outcome === "NO_CHANGE_VALID" ||
    (decision.outcome === "PUBLISH_REQUIRED" && decision.productionWriteAllowed === true);
  if (!executable) {
    throw new Error(
      `production decision did not authorize executable run: ${decision.outcome} reasonCodes=${decision.reasonCodes.join(",") || "NONE"}`,
    );
  }
}

export function writePublishedReleaseOutputs({
  stageDir = process.env.EASYSUBWAY_DATAPACK_STAGE,
  evidenceBundlePath = process.env.EASYSUBWAY_RELEASE_EVIDENCE_BUNDLE,
  githubOutputPath = process.env.GITHUB_OUTPUT,
} = {}) {
  const bundle = JSON.parse(fs.readFileSync(evidenceBundlePath, "utf8"));
  const evidenceBundleSha256 = hashFile(evidenceBundlePath);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(stageDir, "catalog", "current.json"), "utf8"),
  );
  fs.appendFileSync(
    githubOutputPath,
    `${[
      `releaseSequence=${manifest.releaseSequence}`,
      `manifestSha256=${bundle.manifestSha256}`,
      `sqliteSha256=${bundle.sqliteSha256}`,
      `gzipSha256=${bundle.gzipSha256}`,
      `evidenceBundleSha256=${evidenceBundleSha256}`,
      `validatorStatus=${bundle.validatorStatus}`,
      `routeRegressionStatus=${bundle.strictRouteRegressionStatus}`,
    ].join("\n")}\n`,
  );
}

export function prepareNoChangeReleaseIdentity({
  currentManifestPath = process.env.EASYSUBWAY_DATAPACK_CURRENT_MANIFEST,
  evidenceBundlePath = process.env.EASYSUBWAY_RELEASE_EVIDENCE_BUNDLE,
  githubOutputPath = process.env.GITHUB_OUTPUT,
} = {}) {
  const currentBytes = fs.readFileSync(currentManifestPath);
  const current = JSON.parse(currentBytes);
  const bundleBytes = fs.readFileSync(evidenceBundlePath);
  const bundle = JSON.parse(bundleBytes);
  if (!Number.isSafeInteger(current.releaseSequence) || current.releaseSequence < 1) {
    throw new Error("current releaseSequence must be a positive safe integer");
  }
  for (const [name, value] of [
    ["sqliteSha256", bundle.sqliteSha256],
    ["gzipSha256", bundle.gzipSha256],
  ]) {
    if (!/^[a-f0-9]{64}$/.test(value ?? "")) {
      throw new Error(`${name} must be lowercase sha256`);
    }
  }
  if (bundle.validatorStatus !== "PASS" || bundle.strictRouteRegressionStatus !== "PASS") {
    throw new Error("no-change release evidence must remain PASS");
  }
  fs.appendFileSync(
    githubOutputPath,
    `${[
      `releaseSequence=${current.releaseSequence}`,
      `manifestSha256=${sha256(currentBytes)}`,
      `sqliteSha256=${bundle.sqliteSha256}`,
      `gzipSha256=${bundle.gzipSha256}`,
      `evidenceBundleSha256=${sha256(bundleBytes)}`,
      `validatorStatus=${bundle.validatorStatus}`,
      `routeRegressionStatus=${bundle.strictRouteRegressionStatus}`,
    ].join("\n")}\n`,
  );
}

export function verifyRemoteValidationSummary(
  summaryPath,
  expectedManifestSha256 = process.env.EXPECTED_MANIFEST_SHA256,
) {
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  if (summary.manifestSha256 !== expectedManifestSha256) {
    throw new Error("remote validation manifestSha256 mismatch");
  }
}

export function writeObservabilityMetadata({
  stageDir = process.env.EASYSUBWAY_DATAPACK_STAGE,
  githubSha = process.env.GITHUB_SHA,
  githubRef = process.env.GITHUB_REF,
  remotePublishEnabled = process.env.REMOTE_PUBLISH_ENABLED ?? "",
  remotePublishReady = process.env.REMOTE_PUBLISH_READY ?? "",
  remotePublishResult = process.env.EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_RESULT ?? "",
} = {}) {
  const manifestPath = path.join(stageDir, "catalog", "current.json");
  let packVersion = "missing";
  let sourceUpdatedAt = "missing";
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const activePack = manifest.activePack;
    if (activePack?.id && activePack?.version) {
      packVersion = `${activePack.id}@${activePack.version}`;
    } else {
      packVersion = "unselected";
    }
    const updatedAtValues = (manifest.packs ?? [])
      .flatMap((pack) => pack.sourceInventory ?? [])
      .map((source) => source.updatedAt ?? source.observedDataUpdatedAt)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    sourceUpdatedAt = updatedAtValues.at(-1) ?? "unknown";
  }
  const isMainBranch = githubRef === "refs/heads/main";
  let publishResult = "disabled-or-skipped";
  if (isMainBranch && remotePublishEnabled !== "false" && remotePublishReady !== "true") {
    publishResult = remotePublishResult || "failed";
  } else if (isMainBranch && remotePublishEnabled !== "false") {
    publishResult = remotePublishResult === "success" ? "success" : "failed";
  }
  const lines = [
    `commit=${githubSha ?? "unknown"}`,
    `pack_version=${packVersion}`,
    `source_updated_at=${sourceUpdatedAt}`,
    `remote_publish_enabled=${remotePublishEnabled || "unknown"}`,
    `remote_publish_ready=${remotePublishReady || "false"}`,
    `publish_result=${publishResult}`,
  ];
  fs.writeFileSync(path.join(stageDir, "datapack-observability.txt"), `${lines.join("\n")}\n`);
}

export function writeReleaseDecisionSummary(
  decisionPath,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
) {
  const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
  fs.appendFileSync(
    summaryPath,
    [
      "## Data pack release decision",
      `- outcome: \`${decision.outcome}\``,
      `- production write allowed: \`${decision.productionWriteAllowed}\``,
      `- source snapshot set: \`${decision.sourceSnapshotSetHash}\``,
      `- reasons: \`${decision.reasonCodes.join(",") || "NONE"}\``,
      "- evidence: uploaded `release-decision.json` artifact",
      "",
    ].join("\n"),
  );
}

export async function validateMapCatalogInputs() {
  const args = parseAndValidateMapCatalogModeArgs(process.env.MODE_ARGS_INPUT ?? "");
  const serverRoutePublicBaseUrl = validateServerRoutePublicBaseUrl(
    process.env.OCI_SERVER_ROUTE_PUBLIC_BASE_URL,
  );
  assertTrackedMainRegularFile("buildSpecPath", args.buildSpecPath);
  const serverRouteDescriptorUrl = `${serverRoutePublicBaseUrl}/server-route-bundle-publication-descriptors/v2/${args.serverRouteDescriptorSha256}.json`;
  const response = await readCredentialFreeObject(serverRouteDescriptorUrl, 1_048_576);
  const descriptor = parseAndValidateServerRouteDescriptor(response, args);
  const buildSpec = validateMapCatalogBuildSpec(args.buildSpecPath, descriptor);
  assertMapCatalogSigningCapability();
  writeMapCatalogEnvAndOutputs(args.buildSpecPath, descriptor, buildSpec);
}

function parseAndValidateMapCatalogModeArgs(modeArgsInput) {
  let args;
  try {
    args = JSON.parse(modeArgsInput);
  } catch {
    throw new Error("modeArgs must be JSON");
  }
  if (!isObject(args)) {
    throw new Error("modeArgs must be an object");
  }
  const allowed = ["allowGaps", "buildSpecPath", "serverRouteDescriptorSha256"];
  if (canonicalJson(Object.keys(args).sort((a, b) => a.localeCompare(b))) !== canonicalJson(allowed)) {
    throw new Error("map-catalog-publish modeArgs keys mismatch");
  }
  if (args.allowGaps !== "false") {
    throw new Error("map-catalog-publish requires allowGaps=false");
  }
  if (args.buildSpecPath !== "tools/datapack/release/candidate-build-spec.json") {
    throw new Error("map-catalog-publish buildSpecPath mismatch");
  }
  if (
    typeof args.serverRouteDescriptorSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(args.serverRouteDescriptorSha256)
  ) {
    throw new Error("serverRouteDescriptorSha256 must be lowercase SHA-256");
  }
  return args;
}

function validateServerRoutePublicBaseUrl(serverRoutePublicBaseUrl) {
  const serverRoutePublicBasePattern = /^https:\/\/objectstorage\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.oraclecloud\.com\/n\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?\/b\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?\/o$/;
  if (typeof serverRoutePublicBaseUrl !== "string" || !serverRoutePublicBasePattern.test(serverRoutePublicBaseUrl) || new URL(serverRoutePublicBaseUrl).toString() !== serverRoutePublicBaseUrl) {
    throw new Error("OCI_SERVER_ROUTE_PUBLIC_BASE_URL must be a canonical Oracle OCI public object base");
  }
  return serverRoutePublicBaseUrl;
}

function isUnsafeRepoRelativePath(value) {
  return (
    typeof value !== "string" ||
    !value ||
    path.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function assertTrackedMainRegularFile(label, value) {
  if (isUnsafeRepoRelativePath(value)) {
    throw new Error(`${label} must be a repo-relative path`);
  }
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a tracked non-symlink regular file`);
  }
  execFileSync(GIT_EXECUTABLE, ["ls-files", "--error-unmatch", "--", value], { stdio: "ignore" });
  const currentMainBytes = execFileSync(GIT_EXECUTABLE, ["show", `${process.env.GITHUB_SHA}:${value}`]);
  if (!fs.readFileSync(value).equals(currentMainBytes)) {
    throw new Error(`${label} bytes must equal GITHUB_SHA:path`);
  }
}

function parseAndValidateServerRouteDescriptor(response, args) {
  if (response?.statusCode !== 200 || !Buffer.isBuffer(response.body)) {
    throw new Error("server route descriptor OCI GET failed");
  }
  const bytes = response.body;
  let raw;
  try {
    raw = JSON.parse(bytes);
  } catch {
    throw new Error("server route descriptor must be JSON");
  }
  if (!bytes.equals(Buffer.from(canonicalJson(raw)))) {
    throw new Error("server route descriptor must be canonical JSON");
  }
  const descriptor = validateServerRouteBundlePublicationDescriptor(raw);
  if (descriptor.descriptorSha256 !== args.serverRouteDescriptorSha256) {
    throw new Error("server route descriptor SHA mismatch");
  }
  if (descriptor.release.result !== "GO") {
    throw new Error("server route descriptor release result must be GO");
  }
  if (descriptor.producer.repository !== process.env.GITHUB_REPOSITORY) {
    throw new Error("server route descriptor producer repository mismatch");
  }
  if (descriptor.producer.gitSha === process.env.GITHUB_SHA) {
    throw new Error("server route descriptor producer SHA must precede current main");
  }
  execFileSync(GIT_EXECUTABLE, ["merge-base", "--is-ancestor", descriptor.producer.gitSha, process.env.GITHUB_SHA], {
    stdio: "ignore",
  });
  if (Date.parse(descriptor.manifest.freshUntil) <= Date.now()) {
    throw new Error("server route descriptor manifest is stale");
  }
  return descriptor;
}

function validateMapCatalogBuildSpec(buildSpecPath, descriptor) {
  const buildSpec = JSON.parse(fs.readFileSync(buildSpecPath));
  if (typeof buildSpec.publishedAt !== "string" || !Number.isFinite(Date.parse(buildSpec.publishedAt))) {
    throw new TypeError("build spec publishedAt is invalid");
  }
  if (buildSpec.releaseSequence !== descriptor.manifest.releaseSequence) {
    throw new Error("build spec releaseSequence must equal server route descriptor manifest");
  }
  if (buildSpec.sourceSnapshotSetHash !== descriptor.sourceSnapshotSetHash) {
    throw new Error("build spec sourceSnapshotSetHash must equal server route descriptor");
  }
  return buildSpec;
}

function assertMapCatalogSigningCapability() {
  const probe = "map-catalog-publication-signing-capability-v1";
  if (!verifyRsaSha256Signature(signingPublicKey(), probe, rsaSha256Signature(signingPrivateKey(), probe))) {
    throw new Error("signing capability mismatch");
  }
}

function writeMapCatalogEnvAndOutputs(buildSpecPath, descriptor, buildSpec) {
  const output = process.env.GITHUB_OUTPUT;
  const environment = process.env.GITHUB_ENV;
  const values = {
    MAP_CATALOG_BUILD_SPEC_PATH: buildSpecPath,
    MAP_CATALOG_RELEASE_SEQUENCE: String(descriptor.manifest.releaseSequence),
    MAP_CATALOG_SIGNED_FINAL_DESCRIPTOR_SHA256: descriptor.descriptorSha256,
    MAP_CATALOG_STATION_SET_SHA256: descriptor.manifest.stationSetSha256,
    MAP_CATALOG_ACTIVE_FROM: descriptor.manifest.activeFrom,
    MAP_CATALOG_FRESH_UNTIL: descriptor.manifest.freshUntil,
    MAP_CATALOG_BUNDLE_ID: descriptor.manifest.bundleId,
    MAP_CATALOG_KEY_ID: descriptor.manifest.keyId,
    MAP_CATALOG_BUILT_AT: buildSpec.publishedAt,
  };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || !value || /[\r\n]/u.test(value)) {
      throw new Error(`${key} is unsafe for GITHUB_ENV`);
    }
  }
  fs.appendFileSync(
    environment,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
  fs.appendFileSync(output, "validated=true\n");
}

export function extractMapCatalogSourceSqlite(
  datapackRoot = process.env.DATAPACK_ROOT,
  sourceSqlite = process.env.SOURCE_SQLITE,
) {
  const manifest = JSON.parse(fs.readFileSync(`${datapackRoot}/current.json`, "utf8"));
  const active = selectEffectiveDataPack(manifest);
  if (active?.id !== "nationwide" || active.version !== "1") throw new Error("current build must select nationwide@1");
  const gzip = fs.readFileSync(`${datapackRoot}/${stagedPackPath(active)}`);
  if (active.sha256 !== sha256(gzip)) {
    throw new Error("current active pack SHA mismatch");
  }
  const sqlite = gunzipSync(gzip, { maxOutputLength: 512 * 1024 * 1024 });
  if (active.sqliteSha256 !== sha256(sqlite)) {
    throw new Error("current active pack gunzip SHA mismatch");
  }
  fs.writeFileSync(sourceSqlite, sqlite, { flag: "wx", mode: 0o600 });
}

export async function buildMapCatalogSignedPublicationStep(
  artifactRoot = process.env.ARTIFACT_ROOT,
  descriptorOutput = process.env.DESCRIPTOR_OUTPUT,
) {
  const serverRoute = {
    releaseSequence: Number(process.env.MAP_CATALOG_RELEASE_SEQUENCE),
    descriptorSha256: process.env.MAP_CATALOG_SIGNED_FINAL_DESCRIPTOR_SHA256,
    stationSetSha256: process.env.MAP_CATALOG_STATION_SET_SHA256,
    freshUntil: process.env.MAP_CATALOG_FRESH_UNTIL,
  };
  const mapCatalog = await buildMapCatalogSignedCurrentPublication({
    artifactRoot,
    output: descriptorOutput,
    producerGitSha: process.env.GITHUB_SHA,
    releaseSequence: serverRoute.releaseSequence,
    signedFinalDescriptorSha256: serverRoute.descriptorSha256,
    freshUntil: serverRoute.freshUntil,
  });
  if (mapCatalog.stationSetSha256 !== serverRoute.stationSetSha256) {
    throw new Error("map catalog station set must equal server route station set");
  }
}

export function verifyMapCatalogPublicationHandoff(handoffPath = process.env.HANDOFF_PATH) {
  const lines = fs.readFileSync(handoffPath, "utf8").split("\n");
  if (lines.length !== 5 || lines[4] !== "") {
    throw new Error("publication handoff must contain exactly four lines");
  }
  const expected = ["DESCRIPTOR_SHA", "DESCRIPTOR_LOCATOR", "RECEIPT_SHA", "RECEIPT_LOCATOR"];
  for (const [index, key] of expected.entries()) {
    const [actual, value, ...rest] = lines[index].split(" ");
    if (actual !== key || !value || rest.length !== 0) {
      throw new Error("publication handoff format is invalid");
    }
  }
  if (
    !/^[a-f0-9]{64}$/.test(lines[0].slice("DESCRIPTOR_SHA ".length)) ||
    !/^[a-f0-9]{64}$/.test(lines[2].slice("RECEIPT_SHA ".length))
  ) {
    throw new Error("publication handoff SHA is invalid");
  }
  for (const line of [lines[1], lines[3]]) {
    if (!line.slice(line.indexOf(" ") + 1).startsWith("oci://")) {
      throw new Error("publication handoff locator is invalid");
    }
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "parse-mode-args":
      parseModeArgs();
      return;
    case "assert-release-build-spec-content":
      assertReleaseBuildSpecContent(rest[0]);
      return;
    case "read-scheduled-release-request-id":
      process.stdout.write(readScheduledReleaseRequestId(rest[0]));
      return;
    case "validate-release-build-spec-and-request": {
      const [
        buildSpecPath,
        releaseRequestId,
        releaseRequestPath,
        targetChannel,
        mode,
        sourceGovernanceEvaluationAt,
      ] = rest;
      validateReleaseBuildSpecAndRequest({
        buildSpecPath,
        releaseRequestId,
        releaseRequestPath,
        targetChannel,
        mode,
        sourceGovernanceEvaluationAt,
      });
      return;
    }
    case "write-release-evidence-bundle":
      writeReleaseEvidenceBundle();
      return;
    case "assert-executable-production-decision":
      assertExecutableProductionDecision(rest[0]);
      return;
    case "write-published-release-outputs":
      writePublishedReleaseOutputs();
      return;
    case "prepare-no-change-release-identity":
      prepareNoChangeReleaseIdentity();
      return;
    case "verify-remote-validation-summary":
      verifyRemoteValidationSummary(rest[0]);
      return;
    case "write-observability-metadata":
      writeObservabilityMetadata();
      return;
    case "write-release-decision-summary":
      writeReleaseDecisionSummary(rest[0]);
      return;
    case "validate-map-catalog-inputs":
      await validateMapCatalogInputs();
      return;
    case "extract-map-catalog-source-sqlite":
      extractMapCatalogSourceSqlite(rest[0], rest[1]);
      return;
    case "build-map-catalog-signed-publication":
      await buildMapCatalogSignedPublicationStep(rest[0], rest[1]);
      return;
    case "verify-map-catalog-handoff":
      verifyMapCatalogPublicationHandoff(rest[0]);
      return;
    default:
      throw new Error(`Unknown datapack-release-steps subcommand: ${subcommand ?? ""}`);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
