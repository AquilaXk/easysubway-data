#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  signingKeyId,
  signingPublicKey,
  verifyRsaSha256Signature,
  withoutSignature,
} from "./lib/manifest-validation.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const CALLBACK_RECONCILIATION_SOURCE_ISSUE = 2057;
const CANONICAL_CHECKS = [
  "boundedRetryConverged",
  "independentReconciliationConverged",
  "duplicateSingleApply",
  "concurrentSingleApply",
  "identityMismatchDeadLetter",
  "invalidSignatureDeadLetter",
  "missingRequestDeadLetter",
  "rolloutCappedUntilConfirmed",
  "secretRedactionVerified",
  "manualRepairAudited",
];

const JUNIT_EXPECTATIONS = {
  rehearsal: "callback backend unavailable publish가 10분에 수렴하고 catalog 장애는 70분에 dead-letter된다",
  duplicate: "동일 payload 10회는 delivery와 release 상태를 한 번만 적용한다",
  concurrent: "동시 claim은 delivery 한 건을 한 worker에게만 준다",
  identityMismatch: "catalog identity 불일치는 각각의 sanitized reason으로 DEAD_LETTER다",
  invalidSignature: "catalog signature mismatch는 자동 apply 없이 DEAD_LETTER다",
  missingRequest: "존재하지 않는 release request callback은 자동 적용 없이 DEAD_LETTER로 보존한다",
  redaction: "목록은 sanitized callback delivery와 reconciliation blocker를 렌더한다",
  manualRepair: "production approve 관리자는 dead letter를 repair하고 before/after·identity hash를 감사한다",
};

const JUNIT_FILES = {
  rehearsal: "TEST-com.easysubway.datapack.application.service.DatapackCallbackReconciliationRehearsalTest.xml",
  duplicate: "TEST-com.easysubway.datapack.application.service.DatapackReleaseCallbackServiceTest.xml",
  concurrent: "TEST-com.easysubway.datapack.adapter.out.persistence.JdbcDatapackReleaseDeliveryRepositoryTest.xml",
  identityMismatch: "TEST-com.easysubway.datapack.application.service.DatapackReleaseReconciliationServiceTest.xml",
  invalidSignature: "TEST-com.easysubway.datapack.application.service.DatapackReleaseReconciliationServiceTest.xml",
  missingRequest: "TEST-com.easysubway.datapack.application.service.DatapackReleaseCallbackServiceTest.xml",
  redaction: "TEST-com.easysubway.datapack.adapter.in.web.DatapackReleaseRequestAdminPageControllerTest.xml",
  manualRepair: "TEST-com.easysubway.datapack.adapter.in.web.DatapackReleaseRequestAdminPageControllerTest.xml",
};

const CHECK_SOURCES = {
  boundedRetryConverged: "rehearsal",
  independentReconciliationConverged: "rehearsal",
  duplicateSingleApply: "duplicate",
  concurrentSingleApply: "concurrent",
  identityMismatchDeadLetter: "identityMismatch",
  invalidSignatureDeadLetter: "invalidSignature",
  missingRequestDeadLetter: "missingRequest",
  secretRedactionVerified: "redaction",
  manualRepairAudited: "manualRepair",
};

export function buildCallbackReconciliationEvidence({
  raw,
  junitXmlByCheck,
  workflow,
  expectedIdentity,
}) {
  validateRawRehearsal(raw, expectedIdentity);
  const tests = {};
  for (const [key, expectedName] of Object.entries(JUNIT_EXPECTATIONS)) {
    assertPassingJUnit(junitXmlByCheck?.[key], expectedName, key);
    tests[key] = { testName: expectedName, status: "PASS" };
  }
  if (!/ROLLOUT_PERCENTAGE\s*>\s*10\b/.test(workflow)
    || !/CALLBACK_RECONCILIATION_REQUIRED/.test(workflow)) {
    throw new Error("rollout cap contract missing");
  }

  const checks = Object.fromEntries(CANONICAL_CHECKS.map((check) => [check, true]));
  const attestation = {
    schemaVersion: 1,
    environment: raw.environment,
    tests,
    workflowContract: {
      path: ".github/workflows/datapack-release.yml",
      rolloutMaximumPercentageUntilConfirmed: 10,
      status: "PASS",
    },
  };
  const rawBytes = jsonBytes(raw);
  const attestationBytes = jsonBytes(attestation);
  const evidence = {
    schemaVersion: 1,
    deliveryIdentity: raw.deliveryIdentity,
    metrics: raw.metrics,
    checks,
    evidenceReferences: [
      { artifactId: "callback-reconciliation-raw-rehearsal", sha256: sha256(rawBytes) },
      { artifactId: "callback-reconciliation-test-attestation", sha256: sha256(attestationBytes) },
    ],
  };
  validateCallbackReconciliationEvidence(evidence);
  return { evidence, attestation, rawArtifact: raw, rawBytes, attestationBytes };
}

export function validateCallbackReconciliationEvidence(evidence) {
  if (evidence?.schemaVersion !== 1) {
    throw new Error("callback evidence schemaVersion must be 1");
  }
  const identity = evidence.deliveryIdentity;
  if (typeof identity?.releaseRequestId !== "string" || identity.releaseRequestId.length === 0
    || !Number.isSafeInteger(identity.releaseSequence) || identity.releaseSequence < 1
    || !SHA256.test(identity.manifestSha256 ?? "")
    || !SHA256.test(identity.idempotencyKeySha256 ?? "")) {
    throw new Error("callback evidence delivery identity is invalid");
  }
  const expectedIdempotencyHash = sha256(Buffer.from(
    `${identity.releaseRequestId}:${identity.releaseSequence}:${identity.manifestSha256}`));
  if (identity.idempotencyKeySha256 !== expectedIdempotencyHash) {
    throw new Error("callback evidence idempotency identity mismatch");
  }
  validateMetrics(evidence.metrics);
  const suppliedChecks = evidence.checks && typeof evidence.checks === "object"
    ? Object.keys(evidence.checks).sort(compareAscii)
    : [];
  if (suppliedChecks.join(",") !== [...CANONICAL_CHECKS].sort(compareAscii).join(",")
    || CANONICAL_CHECKS.some((check) => evidence.checks[check] !== true)) {
    throw new Error("callback evidence requires every canonical checks value to be true");
  }
  if (!Array.isArray(evidence.evidenceReferences) || evidence.evidenceReferences.length < 2
    || evidence.evidenceReferences.some((reference) =>
      !reference || typeof reference.artifactId !== "string" || reference.artifactId.length === 0
      || !SHA256.test(reference.sha256 ?? "")
      || Object.keys(reference).sort(compareAscii).join(",") !== "artifactId,sha256")) {
    throw new Error("callback evidence reference is invalid");
  }
  return evidence;
}

export function wrapCallbackReconciliationGateEvidence({ result, rcManifest, evaluatedAt }) {
  validateCallbackReconciliationEvidence(result);
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const gate = Array.isArray(rcManifest?.datapackGates)
    ? rcManifest.datapackGates.find((entry) => entry?.id === "callback_reconciliation")
    : null;
  const rcIdentity = gate?.rcIdentity;
  if (rcManifest?.schemaVersion !== 1 || rcManifest.phase !== "FINAL"
    || !rcIdentity || typeof rcIdentity !== "object" || Array.isArray(rcIdentity)
    || rcIdentity.gitSha !== rcManifest.gitSha
    || !Number.isFinite(evaluatedAtMs)) {
    throw new Error("#2056 final RC manifest is invalid");
  }
  if (gate.sourceIssue !== CALLBACK_RECONCILIATION_SOURCE_ISSUE) {
    throw new Error("#2056 final callback gate source issue mismatch");
  }
  if (rcIdentity.dataPackManifestSha256 !== result.deliveryIdentity.manifestSha256
    || String(rcIdentity.releaseSequence) !== String(result.deliveryIdentity.releaseSequence)) {
    throw new Error("#2056 final RC identity mismatch");
  }
  return {
    schemaVersion: 1,
    gateId: "callback_reconciliation",
    sourceIssue: CALLBACK_RECONCILIATION_SOURCE_ISSUE,
    status: "SATISFIED",
    reasonCodes: [],
    rcIdentity,
    evidenceValidity: {
      evaluatedAt: new Date(evaluatedAtMs).toISOString(),
      expiresAt: new Date(evaluatedAtMs + 14 * 24 * 60 * 60 * 1_000).toISOString(),
    },
    result,
  };
}

export function prepareCallbackReconciliationIdentity({
  rcManifest,
  releaseRequestId,
  releaseRequestBinding,
  expectedGitSha,
}) {
  const gate = Array.isArray(rcManifest?.datapackGates)
    ? rcManifest.datapackGates.find((entry) => entry?.id === "callback_reconciliation")
    : null;
  const rcIdentity = gate?.rcIdentity;
  if (rcManifest?.schemaVersion !== 1 || rcManifest.phase !== "FINAL"
    || !/^[a-f0-9]{40}$/.test(rcManifest.gitSha ?? "")
    || rcManifest.gitSha !== expectedGitSha
    || rcIdentity?.gitSha !== rcManifest.gitSha) {
    throw new Error("#2056 final RC manifest does not match the workflow SHA");
  }
  if (gate.sourceIssue !== CALLBACK_RECONCILIATION_SOURCE_ISSUE) {
    throw new Error("#2056 final callback gate source issue mismatch");
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(releaseRequestId ?? "")) {
    throw new Error("release request ID is invalid for rehearsal");
  }
  if (!Number.isSafeInteger(rcIdentity.releaseSequence) || rcIdentity.releaseSequence < 1
    || !SHA256.test(rcIdentity.dataPackManifestSha256 ?? "")) {
    throw new Error("#2056 final RC datapack identity is invalid");
  }
  validatePublishedReleaseRequestBinding(releaseRequestBinding, {
    releaseRequestId,
    releaseSequence: rcIdentity.releaseSequence,
    manifestSha256: rcIdentity.dataPackManifestSha256,
  });
  return {
    releaseRequestId,
    releaseSequence: rcIdentity.releaseSequence,
    manifestSha256: rcIdentity.dataPackManifestSha256,
  };
}

function validatePublishedReleaseRequestBinding(binding, expectedIdentity) {
  const signatureValue = binding?.signature?.value;
  if (binding?.schemaVersion !== 1
    || binding.artifactKind !== "datapack-release-request-binding"
    || binding.releaseRequestId !== expectedIdentity.releaseRequestId
    || binding.releaseSequence !== expectedIdentity.releaseSequence
    || binding.manifestSha256 !== expectedIdentity.manifestSha256
    || binding.channel !== "production"
    || binding.keyId !== signingKeyId()
    || !["PUBLISHED_AND_VERIFIED", "NO_CHANGE_VALID"].includes(binding.releaseOutcome)
    || binding.signature?.algorithm !== "rsa-sha256-release-request-v1"
    || typeof signatureValue !== "string" || !/^[A-Za-z0-9_-]+$/.test(signatureValue)) {
    throw new Error("published release request binding mismatch");
  }
  if (!verifyRsaSha256Signature(
    signingPublicKey(),
    canonicalJson(withoutSignature(binding)),
    signatureValue,
  )) {
    throw new Error("published release request binding signature is invalid");
  }
}

function validateRawRehearsal(raw, expectedIdentity) {
  rejectSensitiveFields(raw);
  if (raw?.schemaVersion !== 1 || raw.environment !== "production-like-isolated-h2"
    || raw.sensitiveMaterialStored !== false) {
    throw new Error("isolated rehearsal envelope is invalid");
  }
  const identity = raw.deliveryIdentity;
  validateCallbackReconciliationEvidence({
    schemaVersion: 1,
    deliveryIdentity: identity,
    metrics: raw.metrics,
    checks: Object.fromEntries(CANONICAL_CHECKS.map((check) => [check, true])),
    evidenceReferences: [
      { artifactId: "raw", sha256: "a".repeat(64) },
      { artifactId: "attestation", sha256: "b".repeat(64) },
    ],
  });
  if (identity.releaseRequestId !== expectedIdentity.releaseRequestId
    || identity.releaseSequence !== expectedIdentity.releaseSequence
    || identity.manifestSha256 !== expectedIdentity.manifestSha256) {
    throw new Error("final RC identity mismatch");
  }
  const timeline = raw.virtualEventTimeline;
  for (const field of ["candidatePublishedAt", "callbackBackendUnavailableAt",
    "reconciliationConvergedAt", "terminalBoundaryAt"]) {
    if (Number.isNaN(Date.parse(timeline?.[field] ?? ""))) {
      throw new TypeError(`virtual event timeline is invalid: ${field}`);
    }
  }
  if (raw.observations?.convergedState !== "DELIVERED"
    || raw.observations?.convergedHttpClass !== "RECONCILED"
    || raw.observations?.terminalState !== "DEAD_LETTER"
    || raw.observations?.terminalHttpClass !== "UNAVAILABLE"
    || raw.observations?.terminalReason !== "CATALOG_UNAVAILABLE") {
    throw new Error("isolated rehearsal observations are invalid");
  }
  const callbackDelivery = raw.observations.callbackDelivery;
  const retryDelays = raw.observations.virtualRetryDelaysSeconds;
  if (raw.observations.candidateNoChange !== false
    || callbackDelivery?.state !== "RECONCILIATION_REQUIRED"
    || !Array.isArray(callbackDelivery.attempts) || callbackDelivery.attempts.length !== 4
    || callbackDelivery.attempts.some((attempt) => attempt?.httpClass !== "5XX")
    || JSON.stringify(retryDelays) !== JSON.stringify([60, 480, 3600])) {
    throw new Error("production sender outage rehearsal is invalid");
  }
}

function validateMetrics(metrics) {
  if (!Number.isFinite(metrics?.controlPlaneConvergenceP95Ms)
    || !Number.isFinite(metrics?.terminalDispositionMaxMs)
    || metrics.controlPlaneConvergenceP95Ms < 0 || metrics.terminalDispositionMaxMs < 0) {
    throw new Error("callback evidence virtual time metric is invalid");
  }
  if (metrics.controlPlaneConvergenceP95Ms > 10 * 60 * 1_000
    || metrics.terminalDispositionMaxMs > 70 * 60 * 1_000) {
    throw new Error("callback evidence virtual time metric exceeds canonical boundary");
  }
}

function assertPassingJUnit(xml, expectedName, key) {
  if (typeof xml !== "string" || !xml.includes(expectedName)
    || !/<testsuite\b[^>]*\bfailures="0"/.test(xml)
    || !/<testsuite\b[^>]*\berrors="0"/.test(xml)
    || !/<testsuite\b[^>]*\bskipped="0"/.test(xml)) {
    throw new Error(`JUnit evidence did not pass: ${key}`);
  }
}

function rejectSensitiveFields(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveFields(item, [...pathParts, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/(authorization|bearer|secret|token|credential|header|verifier)/i.test(key)) {
        throw new Error(`sensitive field is forbidden: ${[...pathParts, key].join(".")}`);
      }
      rejectSensitiveFields(item, [...pathParts, key]);
    }
    return;
  }
  if (typeof value === "string"
    && /(authorization\s*:|bearer\s+[a-z0-9._-]+|callback[-_ ]?secret|private[-_ ]?key)/i.test(value)) {
    throw new Error(`sensitive field value is forbidden: ${pathParts.join(".")}`);
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareAscii(left, right) {
  return left.localeCompare(right, "en");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["prepare-from-rc-manifest"]) {
    return prepareIdentityCommand(args);
  }
  if (args["wrap-result"]) {
    return wrapEvidenceCommand(args);
  }
  if (args["validate-evidence"]) {
    return validateEvidenceCommand(args);
  }
  return buildEvidenceCommand(args);
}

async function prepareIdentityCommand(args) {
  requireArgs(args, ["release-request-id", "release-request-binding", "expected-git-sha", "github-env"],
    " with --prepare-from-rc-manifest");
  const identity = prepareCallbackReconciliationIdentity({
    rcManifest: JSON.parse(await readFile(args["prepare-from-rc-manifest"], "utf8")),
    releaseRequestId: args["release-request-id"],
    releaseRequestBinding: JSON.parse(await readFile(args["release-request-binding"], "utf8")),
    expectedGitSha: args["expected-git-sha"],
  });
  await writeFile(args["github-env"], [
    `EASYSUBWAY_CALLBACK_EVIDENCE_RELEASE_REQUEST_ID=${identity.releaseRequestId}`,
    `EASYSUBWAY_CALLBACK_EVIDENCE_RELEASE_SEQUENCE=${identity.releaseSequence}`,
    `EASYSUBWAY_CALLBACK_EVIDENCE_MANIFEST_SHA256=${identity.manifestSha256}`,
    "",
  ].join("\n"), { flag: "a" });
  process.stdout.write(`${JSON.stringify({ status: "PASS", releaseSequence: identity.releaseSequence })}\n`);
}

async function wrapEvidenceCommand(args) {
  requireArgs(args, ["rc-manifest", "output"], " with --wrap-result");
  const envelope = wrapCallbackReconciliationGateEvidence({
    result: JSON.parse(await readFile(args["wrap-result"], "utf8")),
    rcManifest: JSON.parse(await readFile(args["rc-manifest"], "utf8")),
    evaluatedAt: args["evaluated-at"] ?? new Date().toISOString(),
  });
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, jsonBytes(envelope));
  process.stdout.write(`${JSON.stringify({ status: "PASS", gateId: envelope.gateId, output: args.output })}\n`);
}

async function validateEvidenceCommand(args) {
  const evidence = JSON.parse(await readFile(args["validate-evidence"], "utf8"));
  validateCallbackReconciliationEvidence(evidence);
  if (args["artifact-dir"]) await verifyArtifactHashes(evidence, args["artifact-dir"]);
  process.stdout.write(`${JSON.stringify({ status: "PASS", gateId: "callback_reconciliation" })}\n`);
}

async function buildEvidenceCommand(args) {
  requireArgs(args, ["raw", "junit-dir", "workflow", "release-request-id",
    "release-sequence", "manifest-sha256", "output-dir"]);
  const junitXmlByCheck = {};
  for (const [key, file] of Object.entries(JUNIT_FILES)) {
    junitXmlByCheck[key] = await readFile(path.join(args["junit-dir"], file), "utf8");
  }
  const built = buildCallbackReconciliationEvidence({
    raw: JSON.parse(await readFile(args.raw, "utf8")),
    junitXmlByCheck,
    workflow: await readFile(args.workflow, "utf8"),
    expectedIdentity: {
      releaseRequestId: args["release-request-id"],
      releaseSequence: Number(args["release-sequence"]),
      manifestSha256: args["manifest-sha256"],
    },
  });
  await mkdir(args["output-dir"], { recursive: true });
  await writeFile(path.join(args["output-dir"], "callback-reconciliation-raw-rehearsal.json"), built.rawBytes);
  await writeFile(path.join(args["output-dir"], "callback-reconciliation-test-attestation.json"), built.attestationBytes);
  await writeFile(path.join(args["output-dir"], "callback-reconciliation-evidence.json"), jsonBytes(built.evidence));
  process.stdout.write(`${JSON.stringify({ status: "PASS", outputDir: args["output-dir"] })}\n`);
}

function requireArgs(args, requiredArgs, suffix = "") {
  for (const required of requiredArgs) {
    if (!args[required]) throw new Error(`--${required} is required${suffix}`);
  }
}

async function verifyArtifactHashes(evidence, artifactDir) {
  const fileByArtifactId = {
    "callback-reconciliation-raw-rehearsal": "callback-reconciliation-raw-rehearsal.json",
    "callback-reconciliation-test-attestation": "callback-reconciliation-test-attestation.json",
  };
  for (const reference of evidence.evidenceReferences) {
    const file = fileByArtifactId[reference.artifactId];
    if (!file) throw new Error(`unknown callback evidence artifact: ${reference.artifactId}`);
    const bytes = await readFile(path.join(artifactDir, file));
    if (sha256(bytes) !== reference.sha256) {
      throw new Error(`callback evidence artifact hash mismatch: ${reference.artifactId}`);
    }
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${flag ?? "end"}`);
    }
    result[flag.slice(2)] = value;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { CANONICAL_CHECKS, CHECK_SOURCES, JUNIT_EXPECTATIONS, JUNIT_FILES };
