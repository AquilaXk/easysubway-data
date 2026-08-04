#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectTagoItxCheongchunOd,
  providerFailureEvidence,
} from "./collect-tago-itx-cheongchun-od.mjs";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_PATH = "tools/datapack/release/tago-provider-failure-20260804.json";
const ITX_PATH = "tools/datapack/itx-cheongchun-coverage-contract.json";
const TOPOLOGY_PATH = "tools/datapack/sources/capital-route-topology-20260724.json";
const REVERIFICATION_PATH = "tools/datapack/release/capital-topology-reverification-20260804.json";
const BUILD_SPEC_PATH = "tools/datapack/release/candidate-build-spec.json";
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function prepareTagoNetworkAdmission({ collectFresh, createEmergency, observedAt } = {}) {
  try {
    return { mode: "FRESH", freshArtifact: await collectFresh() };
  } catch (error) {
    const failureEvidence = providerFailureEvidence(error, { observedAt });
    return {
      mode: "EMERGENCY_REVALIDATED",
      failureEvidence,
      emergencyReadmission: await createEmergency(failureEvidence),
    };
  }
}

export function createTagoEmergencyReadmission({
  failureEvidenceBytes,
  itxCoverageContractBytes,
  capitalTopologyBytes,
  capitalReverificationBytes,
  capitalTopologyAdmission,
  admittedAt,
} = {}) {
  const failure = parseJson(failureEvidenceBytes, "TAGO failure evidence");
  validateFailureEvidence(failure);
  const admittedEpoch = utcTimestamp(admittedAt, "admittedAt");
  if (utcTimestamp(failure.observedAt, "failure observedAt") !== admittedEpoch) {
    throw new Error("failure observedAt must equal admittedAt");
  }

  const itx = parseJson(itxCoverageContractBytes, "ITX coverage contract");
  const source = requiredObject(itx.sourceTimetableArtifact, "ITX source timetable artifact");
  timestamp(source.freshUntil, "ITX source freshUntil");
  const topology = parseJson(capitalTopologyBytes, "capital topology");
  const reverification = parseJson(capitalReverificationBytes, "capital topology reverification");
  validateCapitalSources(topology, reverification, capitalTopologyAdmission, admittedEpoch);

  return {
    schemaVersion: 1,
    artifactKind: "tago-emergency-readmission-decision",
    status: "EMERGENCY_REVALIDATED",
    reasonCode: "TAGO_PROVIDER_OUTAGE",
    decisionBasis: "DIRECT_PROVIDER_INQUIRY",
    dataIssue: 60,
    hubIssue: 2649,
    admittedAt,
    expiresAt: new Date(admittedEpoch + SEVEN_DAYS_MS).toISOString(),
    failureEvidence: {
      path: FAILURE_PATH,
      sha256: sha256(failureEvidenceBytes),
      fingerprint: failure.failureFingerprint,
    },
    itx: {
      path: ITX_PATH,
      contractSha256: sha256(itxCoverageContractBytes),
      artifactId: requiredString(source.artifactId, "ITX artifactId"),
      artifactPath: requiredString(source.artifactPath, "ITX artifactPath"),
      artifactSha256: sha256Hex(source.sha256, "ITX artifact SHA-256"),
      sourceFreshUntil: source.freshUntil,
    },
    capitalTopology: {
      path: TOPOLOGY_PATH,
      sha256: sha256(capitalTopologyBytes),
      snapshotId: capitalTopologyAdmission.snapshotId,
      contentSha256: topology.contentSha256,
      sourceFreshUntil: topology.freshUntil,
    },
    capitalReverification: {
      path: REVERIFICATION_PATH,
      sha256: sha256(capitalReverificationBytes),
      candidateContentSha256: reverification.candidate.contentSha256,
      normalizedLineSetSha256: reverification.candidate.normalizedLineSetSha256,
      sourceFreshUntil: reverification.candidate.freshUntil,
    },
    capitalAdmission: {
      reviewedAt: capitalTopologyAdmission.reviewedAt,
      sourceFreshUntil: capitalTopologyAdmission.freshUntil,
    },
    launchDenominatorDecision: "NO_GO",
  };
}

export function validateTagoEmergencyReadmission(options = {}) {
  const decision = parseJson(options.admissionBytes, "TAGO emergency decision");
  exactKeys(decision, [
    "schemaVersion", "artifactKind", "status", "reasonCode", "decisionBasis", "dataIssue", "hubIssue",
    "admittedAt", "expiresAt", "failureEvidence", "itx", "capitalTopology", "capitalReverification",
    "capitalAdmission", "launchDenominatorDecision",
  ], "decision");
  const admittedEpoch = utcTimestamp(decision.admittedAt, "decision admittedAt");
  const expiresEpoch = utcTimestamp(decision.expiresAt, "decision expiresAt");
  if (expiresEpoch - admittedEpoch !== SEVEN_DAYS_MS) {
    throw new Error("emergency TAGO readmission must be exactly seven days");
  }
  const now = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now);
  if (!Number.isFinite(now)) throw new Error("now must be a valid timestamp");
  if (now < admittedEpoch) throw new Error("emergency TAGO readmission is not active");
  if (now >= expiresEpoch) throw new Error("emergency TAGO readmission is expired");

  const expected = createTagoEmergencyReadmission({ ...options, admittedAt: decision.admittedAt });
  if (decision.failureEvidence.sha256 !== expected.failureEvidence.sha256) {
    throw new Error("TAGO failure evidence SHA-256 must match exact bytes");
  }
  if (decision.itx.contractSha256 !== expected.itx.contractSha256) {
    throw new Error("ITX coverage contract SHA-256 must match exact bytes");
  }
  if (decision.capitalTopology.sha256 !== expected.capitalTopology.sha256) {
    throw new Error("capital topology SHA-256 must match exact bytes");
  }
  if (decision.capitalReverification.sha256 !== expected.capitalReverification.sha256) {
    throw new Error("capital topology reverification SHA-256 must match exact bytes");
  }
  if (JSON.stringify(decision) !== JSON.stringify(expected)) {
    throw new Error("TAGO emergency decision must match exact source identities");
  }
  return {
    status: decision.status,
    sourceFreshUntil: decision.itx.sourceFreshUntil,
    expiresAt: decision.expiresAt,
    decisionSha256: sha256(options.admissionBytes),
  };
}

export async function runTagoEmergencyReadmissionCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  decisionNow = () => new Date(),
  repositoryRoot = DEFAULT_ROOT,
  collectFreshImpl = collectTagoItxCheongchunOd,
} = {}) {
  const args = parseArgs(argv);
  if (args.validate === true) return validateCli(args, repositoryRoot, now);
  requiredString(env.DATA_GO_KR_SERVICE_KEY, "DATA_GO_KR_SERVICE_KEY");
  const date = departureDate(args.date, "--date");
  const kricServiceDayCode = requiredString(args["kric-day-cd"], "--kric-day-cd");
  if (!["7", "8", "9"].includes(kricServiceDayCode)) throw new Error("--kric-day-cd must be 7, 8, or 9");
  const failurePath = exactOutput(args["failure-output"], repositoryRoot, FAILURE_PATH, "--failure-output");
  const decisionPath = exactOutput(args["decision-output"], repositoryRoot, "tools/datapack/release/tago-emergency-readmission-20260804.json", "--decision-output");
  const buildSpecPath = exactRepositoryPath(args["build-spec"], repositoryRoot, BUILD_SPEC_PATH, "--build-spec");
  if (args["update-build-spec"] !== true) throw new Error("--update-build-spec is required");
  if (Object.hasOwn(args, "admitted-at")) throw new Error("--admitted-at is not supported");

  try {
    const freshArtifact = await collectFreshImpl({
      serviceKey: env.DATA_GO_KR_SERVICE_KEY,
      departureDate: date,
      kricServiceDayCode,
      now,
    });
    const temporaryOutputDirectory = await mkdtemp(path.join(tmpdir(), "easysubway-tago-fresh-"));
    const freshOutput = path.join(temporaryOutputDirectory, "tago-itx-od.json");
    await writeFile(freshOutput, jsonBytes(freshArtifact), { flag: "wx", mode: 0o600 });
    return { mode: "FRESH_PROVIDER_AVAILABLE", freshArtifact, freshOutput, temporaryOutputDirectory };
  } catch (providerError) {
    const admittedAt = decisionNow().toISOString();
    utcTimestamp(admittedAt, "admittedAt");
    const failure = providerFailureEvidence(providerError, { observedAt: admittedAt });
    const [itxCoverageContractBytes, capitalTopologyBytes, capitalReverificationBytes, buildSpecBytes] = await Promise.all([
      readFile(path.join(repositoryRoot, ITX_PATH)),
      readFile(path.join(repositoryRoot, TOPOLOGY_PATH)),
      readFile(path.join(repositoryRoot, REVERIFICATION_PATH)),
      readFile(buildSpecPath),
    ]);
    const buildSpec = parseJson(buildSpecBytes, "candidate build spec");
    const failureEvidenceBytes = jsonBytes(failure);
    const decision = createTagoEmergencyReadmission({
      failureEvidenceBytes,
      itxCoverageContractBytes,
      capitalTopologyBytes,
      capitalReverificationBytes,
      capitalTopologyAdmission: buildSpec.networkEdgeEvidence?.capitalTopologyAdmission,
      admittedAt,
    });
    const admissionBytes = jsonBytes(decision);
    validateTagoEmergencyReadmission({
      admissionBytes,
      failureEvidenceBytes,
      itxCoverageContractBytes,
      capitalTopologyBytes,
      capitalReverificationBytes,
      capitalTopologyAdmission: buildSpec.networkEdgeEvidence?.capitalTopologyAdmission,
      now: new Date(admittedAt),
    });
    buildSpec.networkEdgeEvidence.emergencyReadmission = {
      path: "tools/datapack/release/tago-emergency-readmission-20260804.json",
      sha256: sha256(admissionBytes),
    };
    await writeEmergencyTransaction({
      failurePath,
      failureEvidenceBytes,
      decisionPath,
      admissionBytes,
      buildSpecPath,
      buildSpecBytes: jsonBytes(buildSpec),
    });
    return { mode: "EMERGENCY_REVALIDATED", failure, decision };
  }
}

async function validateCli(args, repositoryRoot, now) {
  const failurePath = exactOutput(args.failure, repositoryRoot, FAILURE_PATH, "--failure");
  const decisionPath = exactOutput(args.decision, repositoryRoot, "tools/datapack/release/tago-emergency-readmission-20260804.json", "--decision");
  const buildSpecPath = exactRepositoryPath(args["build-spec"], repositoryRoot, BUILD_SPEC_PATH, "--build-spec");
  const [failureEvidenceBytes, admissionBytes, itxCoverageContractBytes, capitalTopologyBytes,
    capitalReverificationBytes, buildSpecBytes] = await Promise.all([
    readFile(failurePath),
    readFile(decisionPath),
    readFile(path.join(repositoryRoot, ITX_PATH)),
    readFile(path.join(repositoryRoot, TOPOLOGY_PATH)),
    readFile(path.join(repositoryRoot, REVERIFICATION_PATH)),
    readFile(buildSpecPath),
  ]);
  const buildSpec = parseJson(buildSpecBytes, "candidate build spec");
  const pin = buildSpec.networkEdgeEvidence?.emergencyReadmission;
  if (pin?.path !== "tools/datapack/release/tago-emergency-readmission-20260804.json"
    || pin.sha256 !== sha256(admissionBytes)) {
    throw new Error("candidate build spec emergencyReadmission must match decision bytes");
  }
  return validateTagoEmergencyReadmission({
    admissionBytes,
    failureEvidenceBytes,
    itxCoverageContractBytes,
    capitalTopologyBytes,
    capitalReverificationBytes,
    capitalTopologyAdmission: buildSpec.networkEdgeEvidence?.capitalTopologyAdmission,
    now: args.now === undefined ? now : new Date(requiredString(args.now, "--now")),
  });
}

async function writeEmergencyTransaction({
  failurePath,
  failureEvidenceBytes,
  decisionPath,
  admissionBytes,
  buildSpecPath,
  buildSpecBytes,
}) {
  const temporarySpec = `${buildSpecPath}.${process.pid}.tmp`;
  let failureWritten = false;
  let decisionWritten = false;
  try {
    await writeFile(failurePath, failureEvidenceBytes, { flag: "wx", mode: 0o600 });
    failureWritten = true;
    await writeFile(decisionPath, admissionBytes, { flag: "wx", mode: 0o600 });
    decisionWritten = true;
    await writeFile(temporarySpec, buildSpecBytes, { flag: "wx", mode: 0o600 });
    await rename(temporarySpec, buildSpecPath);
  } catch (error) {
    await rm(temporarySpec, { force: true });
    if (decisionWritten) await rm(decisionPath, { force: true });
    if (failureWritten) await rm(failurePath, { force: true });
    throw error;
  }
}

function validateFailureEvidence(failure) {
  exactKeys(failure, [
    "schemaVersion", "artifactKind", "observedAt", "providerBoundary", "credentialPresent",
    "credentialRedacted", "failureFingerprint",
  ], "failure evidence");
  exactKeys(failure.providerBoundary, [
    "operation", "transportStatus", "httpStatus", "schemaStatus", "resultCode",
  ], "provider boundary");
  const boundary = failure.providerBoundary;
  if (failure.schemaVersion !== 1 || failure.artifactKind !== "tago-provider-failure-evidence") {
    throw new Error("TAGO failure evidence contract mismatch");
  }
  if (boundary.operation !== "GetVhcleKndList") throw new Error("TAGO operation must be GetVhcleKndList");
  if (boundary.transportStatus !== "HTTP_SUCCESS") throw new Error("TAGO transport status must be HTTP_SUCCESS");
  if (boundary.httpStatus !== 200) throw new Error("TAGO HTTP status must be 200");
  if (boundary.schemaStatus !== "PROVIDER_ERROR_HEADER_ONLY") {
    throw new Error("TAGO schema status must be PROVIDER_ERROR_HEADER_ONLY");
  }
  if (boundary.resultCode !== "01") throw new Error("TAGO resultCode must be 01");
  if (failure.credentialPresent !== true || failure.credentialRedacted !== true) {
    throw new Error("TAGO credential evidence must be present and redacted");
  }
  utcTimestamp(failure.observedAt, "failure observedAt");
  const unsigned = {
    schemaVersion: failure.schemaVersion,
    artifactKind: failure.artifactKind,
    observedAt: failure.observedAt,
    providerBoundary: failure.providerBoundary,
    credentialPresent: failure.credentialPresent,
    credentialRedacted: failure.credentialRedacted,
  };
  if (failure.failureFingerprint !== sha256(JSON.stringify(unsigned))) {
    throw new Error("failureFingerprint must match sanitized evidence");
  }
}

function validateCapitalSources(topology, reverification, admission, admittedEpoch) {
  if (topology.artifactKind !== "capital-route-topology-snapshot") {
    throw new Error("capital topology artifactKind mismatch");
  }
  const topologyHash = sha256Hex(topology.contentSha256, "capital topology content SHA-256");
  timestamp(topology.freshUntil, "capital topology freshUntil");
  const review = requiredObject(reverification, "capital topology reverification");
  if (review.artifactKind !== "capital-topology-reverification-evidence"
    || review.sourceIssue !== 60 || review.admissionIssue !== 2649) {
    throw new Error("capital topology reverification issue binding mismatch");
  }
  const baseline = requiredObject(review.baseline, "capital topology baseline");
  const candidate = requiredObject(review.candidate, "capital topology candidate");
  if (baseline.contentSha256 !== topologyHash
    || baseline.normalizedLineSetSha256 !== candidate.normalizedLineSetSha256) {
    throw new Error("capital topology reverification identity mismatch");
  }
  sha256Hex(candidate.contentSha256, "capital topology candidate content SHA-256");
  sha256Hex(candidate.normalizedLineSetSha256, "capital topology normalized SHA-256");
  timestamp(candidate.freshUntil, "capital topology reverification freshUntil");
  const comparison = requiredObject(review.comparison, "capital topology comparison");
  if (["changedLineCount", "addedEdgeCount", "removedEdgeCount", "modifiedEdgeCount"]
    .some((key) => comparison[key] !== 0)) {
    throw new Error("capital topology reverification contains a topology change");
  }
  const currentAdmission = requiredObject(admission, "capital topology admission");
  if (currentAdmission.issue !== 2649 || currentAdmission.status !== "ADMITTED"
    || currentAdmission.snapshotId !== baseline.snapshotId || currentAdmission.contentSha256 !== topologyHash) {
    throw new Error("capital topology admission identity mismatch");
  }
  if (timestamp(currentAdmission.reviewedAt, "capital topology reviewedAt") > admittedEpoch) {
    throw new Error("capital topology reviewedAt must not follow admittedAt");
  }
  if (currentAdmission.freshUntil !== candidate.freshUntil) {
    throw new Error("capital topology admission freshUntil mismatch");
  }
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(requiredObject(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} keys mismatch`);
}

function parseJson(value, label) {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} bytes are required`);
  try {
    return requiredObject(JSON.parse(Buffer.from(value).toString("utf8")), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must be JSON`);
    throw error;
  }
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is required`);
  return value;
}

function sha256Hex(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function timestamp(value, label) {
  const epoch = Date.parse(requiredString(value, label));
  if (!Number.isFinite(epoch)) throw new Error(`${label} must be a valid timestamp`);
  return epoch;
}

function utcTimestamp(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value ?? "")) {
    throw new Error(`${label} must be UTC ISO-8601`);
  }
  return timestamp(value, label);
}

function departureDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")
    || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return value;
}

function exactOutput(value, repositoryRoot, relative, label) {
  const actual = path.resolve(requiredString(value, label));
  const expected = path.join(path.resolve(repositoryRoot), relative);
  if (actual !== expected) throw new Error(`${label} must be ${expected}`);
  return actual;
}

function exactRepositoryPath(value, repositoryRoot, relative, label) {
  const actual = path.resolve(repositoryRoot, requiredString(value, label));
  const expected = path.join(path.resolve(repositoryRoot), relative);
  if (actual !== expected) throw new Error(`${label} must be ${relative}`);
  return actual;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]?.replace(/^--/, "");
    if (!key) throw new Error("CLI arguments must use --name");
    if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) result[key] = true;
    else result[key] = argv[index += 1];
  }
  return result;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const result = await runTagoEmergencyReadmissionCli();
  if (result.mode === "FRESH_PROVIDER_AVAILABLE") {
    console.log(`TAGO network admission ready: mode=FRESH_PROVIDER_AVAILABLE, output=${result.freshOutput}`);
    return;
  }
  if (result.mode === "EMERGENCY_REVALIDATED") {
    console.log(`TAGO network admission ready: mode=EMERGENCY_REVALIDATED, expiresAt=${result.decision.expiresAt}`);
    return;
  }
  console.log(`TAGO emergency decision valid: status=${result.status}, expiresAt=${result.expiresAt}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "TAGO emergency readmission failed");
    process.exitCode = 1;
  });
}
