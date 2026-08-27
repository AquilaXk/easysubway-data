#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readCurrentCapitalLiveChainBundle } from "./build-current-capital-live-chain-bundle.mjs";
import {
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
  canonicalCurrentCapitalLiveChainFanInBoundaryJson,
  validateCurrentCapitalLiveChainFanInBoundary,
  verifyCurrentCapitalLiveChainFanInComponents,
} from "./build-current-capital-live-chain-boundary.mjs";
import { OCI_BUCKET, OCI_NAMESPACE } from "./build-current-capital-live-chain-oci-plan.mjs";
import { canonicalCurrentCapitalLiveChainOciReceiptJson } from "./build-current-capital-live-chain-oci-receipt.mjs";
import { canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const COMPONENT_NAMES = Object.freeze(Object.keys(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS));
const RELEASE_REQUEST_COMPONENT_PATH = "tools/datapack/release/release-request.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
}
function canonical(value) {
  return JSON.stringify(canonicalObject(value));
}
function assertKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonical(Object.keys(value).sort(compareBytes)) !== canonical([...keys].sort(compareBytes))) {
    throw new Error(`${label} shape mismatch`);
  }
}
function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} mismatch`);
  return value;
}
function requireIdentity({ sourceRepositorySha, producerSha, operationId }) {
  if (!SHA1.test(sourceRepositorySha ?? "") || !SHA1.test(producerSha ?? "") || !OPERATION.test(operationId ?? "")) throw new Error("source-set handoff identity mismatch");
}
function parseCanonical(bytes, canonicalizer, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error(`${label} bytes mismatch`);
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} JSON mismatch`); }
  if (!bytes.equals(Buffer.from(`${canonicalizer(value)}\n`))) throw new Error(`${label} must be canonical bytes`);
  return value;
}
function strictEntryBytes(entry, label) {
  if (!entry || typeof entry.bytesBase64 !== "string") throw new Error(`${label} entry mismatch`);
  const bytes = Buffer.from(entry.bytesBase64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== entry.bytesBase64 || sha256(bytes) !== entry.sha256) throw new Error(`${label} entry mismatch`);
  return bytes;
}
function parseComponent(entry, label) {
  const bytes = strictEntryBytes(entry, label);
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} must be UTF-8 JSON`); }
  return { bytes, value };
}
function parseReleaseRequest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("release request bytes mismatch");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("release request JSON mismatch"); }
}
function verifyReleaseRequest({ compositeReleaseRequestBytes, releaseRequestBytes, candidateBytes, candidate, expectedApprovalId }) {
  if (typeof expectedApprovalId !== "string" || expectedApprovalId.length === 0) throw new Error("expected approval ID mismatch");
  if (!Buffer.isBuffer(releaseRequestBytes) || !releaseRequestBytes.equals(compositeReleaseRequestBytes)) {
    throw new Error("release request bytes mismatch");
  }
  const releaseRequest = parseReleaseRequest(releaseRequestBytes);
  const violations = releaseRequestBindingViolations({
    buildSpec: candidate,
    buildSpecSha256: sha256(candidateBytes),
    releaseRequest,
    expectedApprovalId,
  });
  if (violations.length > 0) throw new Error(`release request binding mismatch: ${violations.join("; ")}`);
  return releaseRequest;
}
function expectedObjectUri(objectKey) {
  return `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${objectKey}`;
}
function validateExternalReceipt({ receipt, compositeBytes, sourceRepositorySha, operationId }) {
  if (receipt.repository !== REPOSITORY || receipt.mainSha !== sourceRepositorySha || receipt.operationId !== operationId) throw new Error("composite receipt identity mismatch");
  const compositeSha256 = sha256(compositeBytes);
  const compositeKey = `operations/current-capital-live-chain/v1/heads/${sourceRepositorySha}/operations/${operationId}/bundles/${compositeSha256}.json`;
  if (receipt.compositeObject.objectKey !== compositeKey || receipt.compositeObject.ociUri !== expectedObjectUri(compositeKey)
    || receipt.compositeObject.sha256 !== compositeSha256 || receipt.compositeObject.sizeBytes !== compositeBytes.length) {
    throw new Error("composite receipt object binding mismatch");
  }
  const providerPrefix = `operations/current-capital-live-chain/v1/heads/${sourceRepositorySha}/operations/${operationId}/provider-collections/`;
  if (!receipt.providerObject.objectKey.startsWith(providerPrefix)
    || !new RegExp(`^\\d{8}-${receipt.providerObject.sha256}\\.json$`, "u").test(receipt.providerObject.objectKey.slice(providerPrefix.length))
    || receipt.providerObject.ociUri !== expectedObjectUri(receipt.providerObject.objectKey)) {
    throw new Error("composite receipt provider binding mismatch");
  }
}
function readVerifiedComponents(bundle) {
  const entries = new Map(bundle.entries.map((entry) => [entry.path, entry]));
  const boundaryBytes = Buffer.from(bundle.boundaryBytesBase64, "base64");
  let boundary;
  try { boundary = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(boundaryBytes)); }
  catch { throw new Error("source-set fan-in JSON mismatch"); }
  validateCurrentCapitalLiveChainFanInBoundary(boundary);
  const components = Object.fromEntries(COMPONENT_NAMES.map((name) => {
    const relative = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS[name];
    return [name, parseComponent(entries.get(relative), `source-set ${name}`)];
  }));
  const releaseRequest = parseComponent(entries.get(RELEASE_REQUEST_COMPONENT_PATH), "source-set release request");
  verifyCurrentCapitalLiveChainFanInComponents(boundary, components);
  return { boundary, boundaryBytes, components, entries, releaseRequest };
}
function verifyEmbeddedExitReceipt({ components, externalReceipt, sourceRepositorySha, operationId }) {
  const receiptBytes = components.exitAdmissionOciReceipt.bytes;
  const exitReceipt = parseCanonical(receiptBytes, canonicalCurrentExitAdmissionOciReceiptJson, "embedded EXIT receipt");
  if (exitReceipt.repository !== REPOSITORY || exitReceipt.mainSha !== sourceRepositorySha || exitReceipt.operationId !== operationId
    || exitReceipt.providerObjectKey !== externalReceipt.providerObject.objectKey
    || exitReceipt.providerObjectUri !== externalReceipt.providerObject.ociUri
    || exitReceipt.providerCollectionBundleSha256 !== externalReceipt.providerObject.sha256
    || exitReceipt.providerCollectionBundleByteSize !== externalReceipt.providerObject.sizeBytes
    || exitReceipt.normalizedSnapshotSha256 !== sha256(components.exitNormalized.bytes)
    || exitReceipt.admissionSha256 !== sha256(components.exitAdmission.bytes)) {
    throw new Error("embedded EXIT receipt binding mismatch");
  }
  return exitReceipt;
}

export function buildCurrentSourceSetHandoff({ compositeReceiptBytes, compositeBytes, expectedApprovalId, releaseRequestBytes, sourceRepositorySha, producerSha, operationId }) {
  requireIdentity({ sourceRepositorySha, producerSha, operationId });
  const receipt = parseCanonical(compositeReceiptBytes, canonicalCurrentCapitalLiveChainOciReceiptJson, "composite receipt");
  validateExternalReceipt({ receipt, compositeBytes, sourceRepositorySha, operationId });
  const bundle = readCurrentCapitalLiveChainBundle(compositeBytes, { repository: REPOSITORY, repositorySha: sourceRepositorySha, operationId });
  const { boundary, boundaryBytes, components, releaseRequest: compositeReleaseRequest } = readVerifiedComponents(bundle);
  verifyEmbeddedExitReceipt({ components, externalReceipt: receipt, sourceRepositorySha, operationId });

  const candidate = components.candidateBuildSpec.value;
  const releaseRequest = verifyReleaseRequest({
    compositeReleaseRequestBytes: compositeReleaseRequest.bytes,
    releaseRequestBytes,
    candidateBytes: components.candidateBuildSpec.bytes,
    candidate,
    expectedApprovalId,
  });
  const facility = components.facilityAdmission.value;
  const transferMetrics = components.transferMetrics.value;
  const transferApplicability = components.transferApplicability.value;
  const exitAdmission = components.exitAdmission.value;
  const payload = canonicalObject({
    artifactKind: "current-source-set-handoff",
    candidate: {
      candidateId: requiredString(candidate.candidateId, "candidate ID"),
      sourceSnapshotSetHash: requiredString(candidate.sourceSnapshotSetHash, "candidate source-set hash"),
      sourceSnapshots: candidate.sourceSnapshots.map(({ sourceId, snapshotId }) => ({
        snapshotId: requiredString(snapshotId, "candidate snapshot ID"),
        sourceId: requiredString(sourceId, "candidate source ID"),
      })),
    },
    composite: {
      bundleSha256: bundle.bundleSha256,
      manifestSha256: bundle.manifestSha256,
      object: receipt.compositeObject,
      planSha256: receipt.planSha256,
      providerObject: receipt.providerObject,
      receiptIdentitySha256: receipt.receiptSha256,
      receiptSha256: sha256(compositeReceiptBytes),
    },
    evidence: {
      exit: {
        admissionReceiptSha256: boundary.components.exitAdmissionOciReceipt.sha256,
        admissionSha256: boundary.components.exitAdmission.sha256,
        candidateId: requiredString(exitAdmission.candidate?.candidateId, "EXIT candidate ID"),
        normalizedSha256: boundary.components.exitNormalized.sha256,
        snapshotId: requiredString(exitAdmission.sourceIdentity?.snapshotId, "EXIT snapshot ID"),
        sourceId: requiredString(exitAdmission.sourceIdentity?.sourceId, "EXIT source ID"),
        sourceSnapshotSetHash: requiredString(exitAdmission.candidate?.sourceSetSha256, "EXIT source-set hash"),
      },
      facility: {
        admissionSha256: boundary.components.facilityAdmission.sha256,
        candidateId: requiredString(facility.candidate?.candidateId, "FACILITY candidate ID"),
        sourceSnapshotSetHash: requiredString(facility.candidate?.sourceSnapshotSetHash, "FACILITY source-set hash"),
      },
      transfer: {
        applicabilityArtifactSha256: requiredString(transferApplicability.artifactSha256, "TRANSFER applicability artifact hash"),
        applicabilitySha256: boundary.components.transferApplicability.sha256,
        metricsArtifactSha256: requiredString(transferMetrics.artifactSha256, "TRANSFER metrics artifact hash"),
        metricsSha256: boundary.components.transferMetrics.sha256,
        rawSha256: requiredString(transferMetrics.sourceIdentity?.rawSha256, "TRANSFER raw hash"),
        sourceId: requiredString(transferMetrics.sourceIdentity?.sourceId, "TRANSFER source ID"),
      },
    },
    fanIn: {
      components: boundary.components,
      kind: boundary.kind,
      path: bundle.boundary.path,
      sha256: sha256(boundaryBytes),
      sourceSetSha256: boundary.currentCandidateSourceSetSha256,
    },
    operationId,
    producerSha,
    repository: REPOSITORY,
    releaseRequest: {
      approvalId: releaseRequest.approvalId,
      candidateId: releaseRequest.candidateId,
      sha256: sha256(releaseRequestBytes),
    },
    schemaVersion: 1,
    sourceRepositorySha,
  });
  validateHandoffPayload(payload, { sourceRepositorySha, producerSha, operationId });
  return Buffer.from(`${canonical({ ...payload, handoffSha256: sha256(Buffer.from(canonical(payload))) })}\n`);
}

export function readCurrentSourceSetHandoff(bytes, { sourceRepositorySha, producerSha, operationId }) {
  requireIdentity({ sourceRepositorySha, producerSha, operationId });
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("source-set handoff bytes mismatch");
  let handoff;
  try { handoff = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("source-set handoff JSON mismatch"); }
  assertKeys(handoff, ["artifactKind", "candidate", "composite", "evidence", "fanIn", "handoffSha256", "operationId", "producerSha", "repository", "releaseRequest", "schemaVersion", "sourceRepositorySha"], "source-set handoff");
  const { handoffSha256, ...payload } = handoff;
  if (!SHA256.test(handoffSha256 ?? "") || sha256(Buffer.from(canonical(payload))) !== handoffSha256) throw new Error("source-set handoff hash mismatch");
  validateHandoffPayload(payload, { sourceRepositorySha, producerSha, operationId });
  if (!bytes.equals(Buffer.from(`${canonical(handoff)}\n`))) throw new Error("source-set handoff must be canonical bytes");
  return handoff;
}

function validateHandoffPayload(payload, { sourceRepositorySha, producerSha, operationId }) {
  assertKeys(payload, ["artifactKind", "candidate", "composite", "evidence", "fanIn", "operationId", "producerSha", "repository", "releaseRequest", "schemaVersion", "sourceRepositorySha"], "source-set handoff payload");
  if (payload.schemaVersion !== 1 || payload.artifactKind !== "current-source-set-handoff" || payload.repository !== REPOSITORY
    || payload.sourceRepositorySha !== sourceRepositorySha || payload.producerSha !== producerSha || payload.operationId !== operationId) throw new Error("source-set handoff identity mismatch");
  assertKeys(payload.releaseRequest, ["approvalId", "candidateId", "sha256"], "source-set release request");
  if (requiredString(payload.releaseRequest.approvalId, "release request approval ID") !== payload.releaseRequest.approvalId
    || payload.releaseRequest.candidateId !== payload.candidate.candidateId
    || !SHA256.test(payload.releaseRequest.sha256 ?? "")) throw new Error("source-set release request mismatch");
  assertKeys(payload.composite, ["bundleSha256", "manifestSha256", "object", "planSha256", "providerObject", "receiptIdentitySha256", "receiptSha256"], "source-set composite");
  for (const digest of [payload.composite.bundleSha256, payload.composite.manifestSha256, payload.composite.planSha256, payload.composite.receiptIdentitySha256, payload.composite.receiptSha256]) {
    if (!SHA256.test(digest ?? "")) throw new Error("source-set composite digest mismatch");
  }
  validateHandoffObject(payload.composite.object, sourceRepositorySha, operationId, "bundles", "source-set composite object");
  validateHandoffObject(payload.composite.providerObject, sourceRepositorySha, operationId, "provider-collections", "source-set provider object");
  assertKeys(payload.fanIn, ["components", "kind", "path", "sha256", "sourceSetSha256"], "source-set fan-in");
  if (payload.fanIn.kind !== CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND || payload.fanIn.path !== CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH
    || !SHA256.test(payload.fanIn.sha256 ?? "") || !SHA256.test(payload.fanIn.sourceSetSha256 ?? "")) throw new Error("source-set fan-in digest mismatch");
  validateCurrentCapitalLiveChainFanInBoundary({
    artifactKind: "current-capital-live-chain-fan-in",
    components: payload.fanIn.components,
    currentCandidateSourceSetSha256: payload.fanIn.sourceSetSha256,
    evidenceSourceSetSha256: payload.fanIn.sourceSetSha256,
    kind: payload.fanIn.kind,
    schemaVersion: 1,
  });
  const reconstructedFanInBytes = Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson({
    artifactKind: "current-capital-live-chain-fan-in",
    components: payload.fanIn.components,
    currentCandidateSourceSetSha256: payload.fanIn.sourceSetSha256,
    evidenceSourceSetSha256: payload.fanIn.sourceSetSha256,
    kind: payload.fanIn.kind,
    schemaVersion: 1,
  }));
  if (payload.fanIn.sha256 !== sha256(reconstructedFanInBytes)) throw new Error("source-set fan-in sha256 mismatch");
  assertKeys(payload.candidate, ["candidateId", "sourceSnapshotSetHash", "sourceSnapshots"], "source-set candidate");
  if (requiredString(payload.candidate.candidateId, "candidate ID") !== payload.candidate.candidateId
    || !SHA256.test(payload.candidate.sourceSnapshotSetHash ?? "") || payload.candidate.sourceSnapshotSetHash !== payload.fanIn.sourceSetSha256
    || !Array.isArray(payload.candidate.sourceSnapshots) || payload.candidate.sourceSnapshots.length === 0) throw new Error("source-set candidate mismatch");
  const sourceIds = new Set(); const snapshotIds = new Set();
  for (const source of payload.candidate.sourceSnapshots) {
    assertKeys(source, ["snapshotId", "sourceId"], "source-set candidate source");
    sourceIds.add(requiredString(source.sourceId, "candidate source ID"));
    snapshotIds.add(requiredString(source.snapshotId, "candidate snapshot ID"));
  }
  if (sourceIds.size !== payload.candidate.sourceSnapshots.length || snapshotIds.size !== payload.candidate.sourceSnapshots.length) throw new Error("source-set candidate source mismatch");
  validateEvidence(payload.evidence, payload);
}

function validateHandoffObject(object, repositorySha, operationId, segment, label) {
  assertKeys(object, ["objectKey", "ociUri", "sha256", "sizeBytes"], label);
  const prefix = `operations/current-capital-live-chain/v1/heads/${repositorySha}/operations/${operationId}/${segment}/`;
  const suffix = object.objectKey.slice(prefix.length);
  if (!object.objectKey.startsWith(prefix) || object.ociUri !== expectedObjectUri(object.objectKey) || !SHA256.test(object.sha256 ?? "")
    || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1
    || (segment === "bundles" ? suffix !== `${object.sha256}.json` : !new RegExp(`^\\d{8}-${object.sha256}\\.json$`, "u").test(suffix))) throw new Error(`${label} mismatch`);
}

function validateEvidence(evidence, payload) {
  assertKeys(evidence, ["exit", "facility", "transfer"], "source-set evidence");
  assertKeys(evidence.facility, ["admissionSha256", "candidateId", "sourceSnapshotSetHash"], "source-set FACILITY evidence");
  if (evidence.facility.admissionSha256 !== payload.fanIn.components.facilityAdmission.sha256
    || evidence.facility.candidateId !== payload.candidate.candidateId || evidence.facility.sourceSnapshotSetHash !== payload.candidate.sourceSnapshotSetHash) throw new Error("source-set FACILITY evidence mismatch");
  assertKeys(evidence.transfer, ["applicabilityArtifactSha256", "applicabilitySha256", "metricsArtifactSha256", "metricsSha256", "rawSha256", "sourceId"], "source-set TRANSFER evidence");
  if (evidence.transfer.applicabilitySha256 !== payload.fanIn.components.transferApplicability.sha256
    || evidence.transfer.metricsSha256 !== payload.fanIn.components.transferMetrics.sha256
    || !SHA256.test(evidence.transfer.applicabilityArtifactSha256 ?? "") || !SHA256.test(evidence.transfer.metricsArtifactSha256 ?? "")
    || !SHA256.test(evidence.transfer.rawSha256 ?? "") || typeof evidence.transfer.sourceId !== "string" || evidence.transfer.sourceId === "") throw new Error("source-set TRANSFER evidence mismatch");
  assertKeys(evidence.exit, ["admissionReceiptSha256", "admissionSha256", "candidateId", "normalizedSha256", "snapshotId", "sourceId", "sourceSnapshotSetHash"], "source-set EXIT evidence");
  if (evidence.exit.admissionReceiptSha256 !== payload.fanIn.components.exitAdmissionOciReceipt.sha256
    || evidence.exit.admissionSha256 !== payload.fanIn.components.exitAdmission.sha256 || evidence.exit.normalizedSha256 !== payload.fanIn.components.exitNormalized.sha256
    || evidence.exit.candidateId !== payload.candidate.candidateId || evidence.exit.sourceSnapshotSetHash !== payload.candidate.sourceSnapshotSetHash
    || typeof evidence.exit.sourceId !== "string" || evidence.exit.sourceId === "" || typeof evidence.exit.snapshotId !== "string" || evidence.exit.snapshotId === "") throw new Error("source-set EXIT evidence mismatch");
}

export function parseArgs(args) {
  if (args.length !== 16 || args[0] !== "--composite-receipt" || args[2] !== "--composite" || args[4] !== "--release-request" || args[6] !== "--expected-approval-id"
    || args[8] !== "--source-repository-sha" || args[10] !== "--producer-sha" || args[12] !== "--operation-id" || args[14] !== "--output"
    || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3]) || !path.isAbsolute(args[5]) || args[7].length === 0 || !path.isAbsolute(args[15])) {
    throw new Error("current source-set handoff arguments mismatch");
  }
  requireIdentity({ sourceRepositorySha: args[9], producerSha: args[11], operationId: args[13] });
  return { compositeReceiptPath: args[1], compositePath: args[3], releaseRequestPath: args[5], expectedApprovalId: args[7], sourceRepositorySha: args[9], producerSha: args[11], operationId: args[13], outputPath: args[15] };
}

async function readStableBytes(filePath, label) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(`${label} cannot enforce O_NOFOLLOW`);
  let handle;
  try { handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`${label} must be a regular non-symlink file`, { cause: error }); }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const bound = await lstat(filePath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.dev !== bound.dev || before.ino !== bound.ino || bound.isSymbolicLink()) throw new Error(`${label} changed while reading`);
    return bytes;
  } finally { await handle.close(); }
}

async function writeImmutable(outputPath, bytes) {
  const parent = path.dirname(outputPath);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("source-set handoff output parent mismatch");
  await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = parseArgs(process.argv.slice(2));
  const [compositeReceiptBytes, compositeBytes, releaseRequestBytes] = await Promise.all([
    readStableBytes(input.compositeReceiptPath, "composite receipt"),
    readStableBytes(input.compositePath, "composite"),
    readStableBytes(input.releaseRequestPath, "release request"),
  ]);
  const output = buildCurrentSourceSetHandoff({ ...input, compositeReceiptBytes, compositeBytes, releaseRequestBytes });
  await writeImmutable(input.outputPath, output);
}
