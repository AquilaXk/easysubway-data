#!/usr/bin/env node
import { readFile } from "node:fs/promises";

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

async function main() {
  const args = process.argv.slice(2);
  const bundlePath = argValue(args, "--bundle");
  const requirePass = args.includes("--require-pass");
  if (!bundlePath) {
    throw new Error("--bundle is required");
  }

  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
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
    "scopeId",
    "releaseRequestId",
    "builderGitSha",
    "createdAt",
    "workflowRunUrl",
  ]) {
    requireField(bundle, field);
  }
  for (const field of [
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
    "routeMapPositionCoverageSha256",
    "routeGraphTopologySha256",
    "headwayReportSha256",
    "strictRouteRegressionSha256",
    "androidEvidenceSha256",
  ]) {
    validateSha(bundle, field);
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
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
