#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildLaunchDenominatorReport,
  canonicalScopeHash,
} from "./build-launch-denominator-report.mjs";
import {
  bindAuthoritativeLaunchEvidence,
  buildLaunchCandidateBinding,
} from "./launch-candidate-binding.mjs";
import {
  canonicalJson,
  signingPublicKey,
  validateArtifactComponentManifest,
  validateManifest,
  verifyRsaSha256Signature,
  withoutSignature,
} from "./lib/manifest-validation.mjs";
import { validateServerRouteBundleFinal } from "./lib/server-route-bundle-final.mjs";

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
const CANDIDATE_EVIDENCE_PATHS = Object.freeze({
  eligibility: "server-route-bundle-evidence/route-accessibility-eligibility.json",
  final: "server-route-bundle-evidence/server-route-bundle-final.json",
});
const ROUTE_COMPONENTS = Object.freeze(["accessibility", "fare", "timetable", "topology"]);
const SIGNED_ROUTE_PATHS = Object.freeze([
  "compatibility.json", "manifest.json", "manifest.signing-input.json",
  ...ROUTE_COMPONENTS.map((component) => `payload/${component}.sqlite.zst`),
  "provenance.json",
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
  nationwideTargetsSha256,
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
  if (bundle.nationwideTargetsSha256 !== nationwideTargetsSha256) {
    throw new Error("nationwide targets sha256 must match canonical targets bytes");
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
    const candidateManifest = JSON.parse(candidateArtifactRaw.manifestRaw);
    if (bundle.releaseSequence !== candidateManifest.releaseSequence) {
      throw new Error("release evidence bundle releaseSequence must match current candidate manifest");
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

function validateCandidateServerRouteEvidenceBinding(bundle) {
  if (bundle?.schemaVersion !== 1 || bundle?.artifactKind !== "datapack-release-evidence-bundle") {
    throw new Error("candidate server route release evidence identity mismatch");
  }
  const value = bundle.candidateServerRouteEvidence;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !sameKeys(value, ["buildSpecSha256", "candidateId", "eligibility", "final", "manifestSha256", "sourceSnapshotSetHash"])) {
    throw new Error("candidate server route evidence shape mismatch");
  }
  for (const field of ["buildSpecSha256", "manifestSha256", "sourceSnapshotSetHash"]) {
    if (!SHA256.test(value[field] ?? "")) throw new Error(`candidate server route evidence ${field} must be sha256`);
  }
  if (typeof bundle.buildCandidateId !== "string" || bundle.buildCandidateId.length === 0
    || typeof value.candidateId !== "string" || value.candidateId.length === 0) {
    throw new Error("candidate ID must be a non-empty string");
  }
  if (value.candidateId !== bundle.buildCandidateId
    || value.sourceSnapshotSetHash !== bundle.sourceSnapshotSetHash
    || value.buildSpecSha256 !== bundle.buildSpecSha256
    || value.manifestSha256 !== bundle.manifestSha256) {
    throw new Error("candidate server route evidence candidate identity mismatch");
  }
  for (const [name, expectedPath] of Object.entries(CANDIDATE_EVIDENCE_PATHS)) {
    const file = value[name];
    if (!file || typeof file !== "object" || Array.isArray(file)
      || !sameKeys(file, ["path", "sha256"])
      || file.path !== expectedPath || !SHA256.test(file.sha256 ?? "")) {
      throw new Error(`candidate server route evidence ${name} binding mismatch`);
    }
  }
  return value;
}

export async function validateCandidateServerRouteEvidence({
  candidateRoot,
  binding,
  candidateArtifactInventory,
  candidateComponentManifest,
}) {
  const root = await realDirectory(candidateRoot, "candidate server route root");
  await validateCandidateEvidenceDirectory(root);
  const eligibility = await canonicalCandidateEvidence(root, binding.eligibility, "eligibility");
  const final = await canonicalCandidateEvidence(root, binding.final, "FINAL");
  const finalValue = validateServerRouteBundleFinal(final.value);
  const eligibilityValue = eligibility.value;
  const eligibilityPayload = { ...eligibilityValue };
  delete eligibilityPayload.eligibilitySha256;
  if (eligibilityValue.schemaVersion !== 1
    || eligibilityValue.artifactKind !== "route-accessibility-eligibility"
    || eligibilityValue.decision !== "ELIGIBLE"
    || !Array.isArray(eligibilityValue.blockers)
    || eligibilityValue.blockers.length !== 0
    || eligibilityValue.eligibilitySha256 !== hashBytes(Buffer.from(canonicalJson(eligibilityPayload)))
    || !isDeepStrictEqual(eligibilityValue.candidate, finalValue.candidate)
    || finalValue.candidate.sourceSnapshotSetHash !== binding.sourceSnapshotSetHash
    || finalValue.gates.routeAccessibilityEligibility.state !== "PASS"
    || finalValue.gates.routeAccessibilityEligibility.evidenceSha256 !== binding.eligibility.sha256
    || !SHA256.test(finalValue.candidate.signedManifestRawSha256 ?? "")
    || !SHA256.test(finalValue.candidate.componentInventorySha256 ?? "")
    || Object.values(finalValue.candidate.componentDigests).some((value) => !SHA256.test(value ?? ""))) {
    throw new Error("candidate server route evidence artifact binding mismatch");
  }
  await validateCandidateSignedRouteBundle(root, finalValue.candidate);
  if ((candidateArtifactInventory === undefined) !== (candidateComponentManifest === undefined)) {
    throw new Error("candidate server route inventory and component manifest must be supplied together");
  }
  if (candidateArtifactInventory === undefined) return { eligibility: eligibilityValue, final: finalValue };
  const inventoryPath = await canonicalCandidateMetadataPath(root, candidateArtifactInventory, "data-artifact-inventory.json");
  const componentPath = await canonicalCandidateMetadataPath(root, candidateComponentManifest, "data-component-manifest.json");
  const { inventory, inventoryRaw } = await candidateInventory(inventoryPath);
  await validateCandidateInventoryFiles(root, inventory);
  validateInventoryEvidenceEntries(inventory, eligibility, final);
  const component = await candidateComponent(componentPath);
  if (component.gitSha !== finalValue.candidate.gitSha
    || component.releaseSequence !== finalValue.candidate.releaseSequence) {
    throw new Error("candidate server route component identity mismatch");
  }
  if (component.manifestSha256 !== binding.manifestSha256
    || component.provenance.sourceSnapshotSetHash !== binding.sourceSnapshotSetHash
    || component.artifactInventorySha256 !== hashBytes(inventoryRaw)) {
    throw new Error("candidate server route component artifactInventorySha256 mismatch");
  }
  return { eligibility: eligibilityValue, final: finalValue, inventory, component };
}

async function validateCandidateSignedRouteBundle(root, candidate) {
  const routeRoot = path.join(root, "server-route-bundle");
  const actualPaths = await exactRegularTree(routeRoot, "candidate signed route bundle");
  if (!isDeepStrictEqual(actualPaths, [...SIGNED_ROUTE_PATHS].sort(compareBytes))) {
    throw new Error("candidate signed route bundle paths mismatch");
  }
  const [manifest, signingInput, provenance, compatibility] = await Promise.all([
    canonicalRouteJson(path.join(routeRoot, "manifest.json"), "signed manifest"),
    canonicalRouteJson(path.join(routeRoot, "manifest.signing-input.json"), "manifest signing input"),
    canonicalRouteJson(path.join(routeRoot, "provenance.json"), "route provenance"),
    canonicalRouteJson(path.join(routeRoot, "compatibility.json"), "route compatibility"),
  ]);
  validateArtifactComponentManifest(manifest.value, candidate.stationSetSha256);
  if (!verifyRsaSha256Signature(signingPublicKey(), signingInput.bytes, manifest.value.signature.value)) {
    throw new Error("candidate signed route signature mismatch");
  }
  if (candidate.signedManifestRawSha256 !== hashBytes(manifest.bytes)
    || candidate.signingInputSha256 !== hashBytes(signingInput.bytes)
    || !Buffer.from(canonicalJson(withoutSignature(manifest.value))).equals(signingInput.bytes)) {
    throw new Error("candidate signed route manifest raw binding mismatch");
  }
  for (const [field, expected] of [
    ["bundleId", candidate.bundleId],
    ["releaseSequence", candidate.releaseSequence],
    ["stationSetSha256", candidate.stationSetSha256],
    ["activeFrom", candidate.activeFrom],
    ["freshUntil", candidate.freshUntil],
    ["keyId", candidate.keyId],
  ]) {
    if (manifest.value[field] !== expected || signingInput.value[field] !== expected) {
      throw new Error(`candidate signed route ${field} mismatch`);
    }
  }
  const componentEntries = await Promise.all(ROUTE_COMPONENTS.map(async (component) => {
    const relative = `payload/${component}.sqlite.zst`;
    const bytes = await regularFile(path.join(routeRoot, relative), `route ${component} payload`);
    return { path: relative, sizeBytes: bytes.length, sha256: hashBytes(bytes) };
  }));
  componentEntries.sort((left, right) => compareBytes(left.path, right.path));
  const componentInventorySha256 = hashBytes(Buffer.from(canonicalJson(componentEntries)));
  if (candidate.componentInventorySha256 !== componentInventorySha256
    || candidate.payloadRootSha256 !== componentInventorySha256
    || manifest.value.payloadSha256 !== componentInventorySha256
    || signingInput.value.payloadSha256 !== componentInventorySha256) {
    throw new Error("candidate signed route component inventory mismatch");
  }
  for (const entry of componentEntries) {
    const component = path.posix.basename(entry.path, ".sqlite.zst");
    if (candidate.componentDigests[component] !== entry.sha256
      || manifest.value[`${component}Sha256`] !== entry.sha256
      || signingInput.value[`${component}Sha256`] !== entry.sha256) {
      throw new Error(`candidate signed route ${component} digest mismatch`);
    }
  }
  if (provenance.value.sourceSnapshotSetHash !== candidate.sourceSnapshotSetHash
    || manifest.value.provenanceSha256 !== hashBytes(provenance.bytes)
    || signingInput.value.provenanceSha256 !== hashBytes(provenance.bytes)
    || manifest.value.compatibilitySha256 !== hashBytes(compatibility.bytes)
    || signingInput.value.compatibilitySha256 !== hashBytes(compatibility.bytes)) {
    throw new Error("candidate signed route metadata binding mismatch");
  }
}

async function exactRegularTree(root, label) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const paths = [];
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} must not contain symlinks`);
      if (entry.isDirectory()) await walk(target, relative);
      else if (entry.isFile()) paths.push(relative);
      else throw new Error(`${label} must contain only regular files`);
    }
  }
  await walk(root);
  return paths.sort(compareBytes);
}

async function canonicalRouteJson(target, label) {
  const bytes = await regularFile(target, label);
  let value;
  try { value = JSON.parse(bytes); } catch { throw new Error(`${label} must be JSON`); }
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) throw new Error(`${label} must be canonical JSON`);
  return { bytes, value };
}

async function canonicalCandidateMetadataPath(root, supplied, basename) {
  const expected = path.join(root, basename);
  const suppliedPath = path.resolve(supplied);
  if (path.basename(suppliedPath) !== basename || await realpath(path.dirname(suppliedPath)) !== root) {
    throw new Error(`candidate server route ${basename} path mismatch`);
  }
  return expected;
}

async function validateCandidateEvidenceDirectory(root) {
  const directory = path.join(root, "server-route-bundle-evidence");
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("candidate server route evidence directory must be real");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort(compareBytes);
  const expected = ["route-accessibility-eligibility.json", "server-route-bundle-final.json"];
  if (!isDeepStrictEqual(actual, expected)) throw new Error("candidate server route evidence paths mismatch");
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("candidate server route evidence paths mismatch");
    }
  }
}

async function canonicalCandidateEvidence(root, binding, label) {
  const target = path.resolve(root, binding.path);
  if (!inside(root, target)) throw new Error(`candidate server route ${label} path traversal`);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`candidate server route ${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`candidate server route ${label} must be regular`);
  }
  const bytes = await readFile(target);
  if (hashBytes(bytes) !== binding.sha256) throw new Error(`candidate server route ${label} sha256 mismatch`);
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error(`candidate server route ${label} must be JSON`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) {
    throw new Error(`candidate server route ${label} must be canonical JSON`);
  }
  return { bytes, value };
}

async function candidateInventory(target) {
  const inventoryRaw = await regularFile(target, "candidate artifact inventory");
  let inventory;
  try {
    inventory = JSON.parse(inventoryRaw);
  } catch {
    throw new Error("candidate artifact inventory must be JSON");
  }
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)
    || !sameKeys(inventory, ["artifactKind", "entries", "schemaVersion"])
    || inventory.schemaVersion !== 1
    || inventory.artifactKind !== "datapack-candidate-inventory"
    || !Array.isArray(inventory.entries)) {
    throw new Error("candidate artifact inventory mismatch");
  }
  const previous = new Set();
  let lastPath = null;
  for (const entry of inventory.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !sameKeys(entry, ["path", "sha256", "sizeBytes"])
      || !safeInventoryPath(entry.path)
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0
      || !SHA256.test(entry.sha256 ?? "")
      || previous.has(entry.path)
      || (lastPath !== null && compareBytes(lastPath, entry.path) >= 0)) {
      throw new Error("candidate artifact inventory entries must be unique and ordered");
    }
    previous.add(entry.path);
    lastPath = entry.path;
  }
  return { inventory, inventoryRaw };
}

async function validateCandidateInventoryFiles(root, inventory) {
  const excluded = new Set(["data-artifact-inventory.json", "data-component-manifest.json"]);
  const actualPaths = (await exactRegularTree(root, "candidate stage"))
    .filter((relative) => !excluded.has(relative));
  const inventoryPaths = inventory.entries.map((entry) => entry.path);
  if (!isDeepStrictEqual(actualPaths, inventoryPaths)) {
    throw new Error("candidate artifact inventory paths mismatch");
  }
  for (const entry of inventory.entries) {
    const bytes = await regularFile(path.join(root, entry.path), `candidate artifact ${entry.path}`);
    if (entry.sizeBytes !== bytes.length || entry.sha256 !== hashBytes(bytes)) {
      throw new Error("candidate artifact inventory file binding mismatch");
    }
  }
}

function validateInventoryEvidenceEntries(inventory, eligibility, final) {
  const byPath = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  for (const [pathName, bytes] of [
    [CANDIDATE_EVIDENCE_PATHS.eligibility, eligibility.bytes],
    [CANDIDATE_EVIDENCE_PATHS.final, final.bytes],
  ]) {
    const entry = byPath.get(pathName);
    if (!entry || entry.sizeBytes !== bytes.length || entry.sha256 !== hashBytes(bytes)) {
      throw new Error("candidate artifact inventory evidence binding mismatch");
    }
  }
}

async function candidateComponent(target) {
  const raw = await regularFile(target, "candidate component manifest");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("candidate component manifest must be JSON");
  }
  const expected = [
    "artifactInventorySha256", "component", "contractVersion", "dataVersion", "gitSha", "issueRef",
    "manifestSha256", "provenance", "releaseSequence", "repository", "schemaVersion", "workflowRunId",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !sameKeys(value, expected)
    || value.schemaVersion !== 1 || value.component !== "data"
    || value.repository !== "AquilaXk/easysubway-data"
    || !SHA256.test(value.manifestSha256 ?? "")
    || !SHA256.test(value.artifactInventorySha256 ?? "")
    || !value.provenance || typeof value.provenance !== "object" || Array.isArray(value.provenance)
    || !sameKeys(value.provenance, ["sourceSnapshotSetHash"])
    || !SHA256.test(value.provenance.sourceSnapshotSetHash ?? "")) {
    throw new Error("candidate component manifest mismatch");
  }
  return value;
}

async function regularFile(target, label) {
  let stat;
  try {
    stat = await lstat(path.resolve(target));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`${label} must be regular`);
  }
  return readFile(target);
}

async function realDirectory(target, label) {
  const resolved = path.resolve(target);
  let inputStat;
  try {
    inputStat = await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!inputStat.isDirectory() || inputStat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const real = await realpath(resolved);
  const realStat = await lstat(real);
  if (!realStat.isDirectory() || realStat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return real;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeInventoryPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\\")
    && !value.startsWith("/")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sameKeys(value, expected) {
  return isDeepStrictEqual(Object.keys(value).sort(compareBytes), [...expected].sort(compareBytes));
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--candidate-server-route-only")) {
    await candidateServerRouteOnly(args);
    return;
  }
  const bundlePath = argValue(args, "--bundle");
  const scopePath = argValue(args, "--scope") ?? "release/product-gates/production-datapack-scope.json";
  const launchReportPath = argValue(args, "--launch-report")
    ?? "tools/datapack/reports/android-v1-launch-denominator-20260715.json";
  const accessibilitySourceCoveragePath = argValue(args, "--accessibility-source-coverage");
  const candidateServerRouteRoot = argValue(args, "--candidate-server-route-root");
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
  const nationwideTargetsPath = scope.nationwideRoadmapScope?.targets;
  if (typeof nationwideTargetsPath !== "string" || nationwideTargetsPath.length === 0) {
    throw new Error("nationwide targets path is required by the production scope");
  }
  const nationwideTargetsSha256 = createHash("sha256").update(await readFile(nationwideTargetsPath)).digest("hex");
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
  if (!["exploratory", "release-candidate", "production-publish", "rollback", "rollout-update"].includes(bundle.releaseMode)) {
    throw new Error("releaseMode is invalid");
  }
  const candidateServerRouteEvidence = bundle.candidateServerRouteEvidence === undefined
    ? null
    : validateCandidateServerRouteEvidenceBinding(bundle);
  if (bundle.releaseMode === "release-candidate" && candidateServerRouteEvidence === null) {
    throw new Error("release-candidate requires candidate server route evidence");
  }
  if (candidateServerRouteRoot) {
    if (candidateServerRouteEvidence === null) {
      throw new Error("candidate server route root requires candidate server route evidence");
    }
    await validateCandidateServerRouteEvidence({
      candidateRoot: candidateServerRouteRoot,
      binding: candidateServerRouteEvidence,
    });
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
    nationwideTargetsSha256,
  );
  for (const field of [
    "verifiedAccessibilityScopeSha256",
    "launchScopeSha256",
    "nationwideRoadmapScopeSha256",
    "nationwideTargetsSha256",
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
  if (!Number.isSafeInteger(bundle.releaseSequence) || bundle.releaseSequence < 1) {
    throw new Error("releaseSequence must be a positive safe integer");
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

async function candidateServerRouteOnly(args) {
  const required = new Set([
    "--candidate-server-route-only",
    "--bundle",
    "--candidate-server-route-root",
    "--candidate-artifact-inventory",
    "--candidate-component-manifest",
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!required.has(flag)) throw new Error("candidate server route only arguments mismatch");
    if (flag === "--candidate-server-route-only") {
      if (values.has(flag)) throw new Error("candidate server route only arguments mismatch");
      values.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--") || values.has(flag)) {
      throw new Error("candidate server route only arguments mismatch");
    }
    values.set(flag, value);
    index += 1;
  }
  if (values.size !== required.size) throw new Error("candidate server route only arguments mismatch");
  const bundleRaw = await regularFile(values.get("--bundle"), "release evidence bundle");
  let bundle;
  try {
    bundle = JSON.parse(bundleRaw);
  } catch {
    throw new Error("release evidence bundle must be JSON");
  }
  const binding = validateCandidateServerRouteEvidenceBinding(bundle);
  await validateCandidateServerRouteEvidence({
    candidateRoot: values.get("--candidate-server-route-root"),
    binding,
    candidateArtifactInventory: values.get("--candidate-artifact-inventory"),
    candidateComponentManifest: values.get("--candidate-component-manifest"),
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
