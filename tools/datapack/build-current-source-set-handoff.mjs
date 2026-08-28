#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
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
import { buildFixture } from "./import-official-sources.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const RETAINED_SOURCE_REPOSITORY_SHA = "befa78d0bd1dec8ce609bd1800b099d569e96734";
const RETAINED_PRODUCTION_INPUT_SHA256 = "8553d59adeea4fd90b94119fbf46ff39b28210edb9543a94fff864b5b54ba402";
const RETAINED_OWNERSHIP_SHA256 = "629663ff845920813f9c939f3521ae154bbcb25f8f71c2a03e6014ddc8a2edb8";
const COMPONENT_NAMES = Object.freeze(Object.keys(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS));
const RELEASE_REQUEST_COMPONENT_PATH = "tools/datapack/release/release-request.json";
const PROTECTED_COMPONENT_NAMES = Object.freeze([
  "candidate-build-spec", "source-snapshots", "source-inventory",
  "capital-pilot-production-source-input", "capital-production-canonical-pack",
  "capital-production-reviewed-pack", "release-request", "hash-evidence",
]);
const PROTECTED_COMPONENT_PATHS = Object.freeze({
  "candidate-build-spec": CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.candidateBuildSpec,
  "source-snapshots": CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.sourceSnapshotLedger,
  "source-inventory": CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.sourceInventory,
  "capital-pilot-production-source-input": "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "capital-production-canonical-pack": "tools/datapack/release/capital-production-canonical-pack.json",
  "capital-production-reviewed-pack": "tools/datapack/release/capital-production-reviewed-pack.json",
  "release-request": RELEASE_REQUEST_COMPONENT_PATH,
  "hash-evidence": "tools/datapack/release/hash-evidence.json",
});
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
function embeddedBytes(pathValue, bytes, label) {
  if (typeof pathValue !== "string" || (!pathValue.startsWith("tools/") && !pathValue.startsWith("apps/")) || !Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error(`${label} bytes mismatch`);
  return { bytesBase64: bytes.toString("base64"), path: pathValue, sha256: sha256(bytes) };
}
function readEmbeddedBytes(entry, label) {
  assertKeys(entry, ["bytesBase64", "path", "sha256"], label);
  return strictEntryBytes(entry, label);
}
function verifiedBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error(`${label} bytes mismatch`);
  return { bytesBase64: bytes.toString("base64"), sha256: sha256(bytes) };
}
function readVerifiedBytes(entry, label) {
  assertKeys(entry, ["bytesBase64", "sha256"], label);
  return strictEntryBytes(entry, label);
}
function parseJsonBytes(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} JSON mismatch`); }
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

function validateRetainedSourceInputs({ sourceRepositorySha, productionInputBytes, ownershipBytes }) {
  if (sourceRepositorySha !== RETAINED_SOURCE_REPOSITORY_SHA
    || sha256(productionInputBytes) !== RETAINED_PRODUCTION_INPUT_SHA256
    || sha256(ownershipBytes) !== RETAINED_OWNERSHIP_SHA256) {
    throw new Error("retained source input identity mismatch");
  }
}

function protectedOutputs({ entries, components, releaseRequest, productionInputBytes, reviewedPackBytes }) {
  const compositeBytesFor = (relative, label) => strictEntryBytes(entries.get(relative), label);
  const source = {
    "candidate-build-spec": components.candidateBuildSpec.bytes,
    "source-snapshots": compositeBytesFor(PROTECTED_COMPONENT_PATHS["source-snapshots"], "source snapshots"),
    "source-inventory": components.sourceInventory.bytes,
    "capital-production-canonical-pack": compositeBytesFor(PROTECTED_COMPONENT_PATHS["capital-production-canonical-pack"], "canonical pack"),
    "release-request": releaseRequest.bytes,
    "hash-evidence": compositeBytesFor(PROTECTED_COMPONENT_PATHS["hash-evidence"], "hash evidence"),
    "capital-pilot-production-source-input": productionInputBytes,
    "capital-production-reviewed-pack": reviewedPackBytes,
  };
  return PROTECTED_COMPONENT_NAMES.map((name) => embeddedBytes(PROTECTED_COMPONENT_PATHS[name], source[name], `protected ${name}`));
}
function validateProductionInputs({ productionInputBytes, reviewedPackBytes, sourceInventoryBytes, candidate }) {
  const input = parseJsonBytes(productionInputBytes, "production source input");
  const sourceInventory = parseJsonBytes(sourceInventoryBytes, "production source inventory");
  let expectedReviewedPackBytes;
  try {
    expectedReviewedPackBytes = Buffer.from(`${JSON.stringify(buildFixture(sourceInventory, input), null, 2)}\n`);
  } catch {
    throw new Error("production reviewed pack derivation mismatch");
  }
  if (!Buffer.isBuffer(reviewedPackBytes) || !reviewedPackBytes.equals(expectedReviewedPackBytes)) {
    throw new Error("production reviewed pack derivation mismatch");
  }
  const reviewed = parseJsonBytes(reviewedPackBytes, "reviewed production pack");
  if (!input || typeof input !== "object" || !reviewed || typeof reviewed !== "object"
    || !Array.isArray(reviewed.packs) || reviewed.packs.length !== 1
    || reviewed.manifest?.channel !== "production" || reviewed.packs[0]?.artifactKind !== "production") {
    throw new Error("production input identity mismatch");
  }
  const snapshotIds = new Set(candidate.sourceSnapshots.map(({ snapshotId }) => snapshotId));
  const reviewedPackIdentity = Object.fromEntries(Object.keys(input.pack ?? {}).map((key) => [key, reviewed.packs[0]?.[key]]));
  if (canonical(input.pack) !== canonical(reviewedPackIdentity) || canonical(input.manifest) !== canonical(reviewed.manifest)
    || !Array.isArray(input.sourceIds) || input.sourceIds.length === 0) throw new Error("production input pack mismatch");
  const reviewedSourceIds = new Set(reviewed.packs[0].sourceInventory.map(({ id }) => id));
  if (input.sourceIds.some((id) => typeof id !== "string" || !reviewedSourceIds.has(id))) throw new Error("production input source mismatch");
  for (const value of Object.values(input)) {
    if (value && typeof value === "object" && typeof value.sourceSnapshotId === "string" && !snapshotIds.has(value.sourceSnapshotId)) {
      throw new Error("production input source identity mismatch");
    }
  }
}
function validateItxEvidence({ itxTopologyEvidenceBytes, coverageContractBytes, mobilePackBytes, ownershipBytes, mobileProfile, candidate }) {
  const topology = parseJsonBytes(itxTopologyEvidenceBytes, "ITX topology evidence");
  const coverage = parseJsonBytes(coverageContractBytes, "ITX coverage contract");
  const ownership = parseJsonBytes(ownershipBytes, "data test ownership");
  if (topology.artifactKind !== "itx-cheongchun-mobile-topology-evidence" || coverage.artifactKind !== "itx-cheongchun-coverage-contract"
    || sha256(itxTopologyEvidenceBytes) !== candidate.itxTopologyEvidenceSha256
    || sha256(coverageContractBytes) !== candidate.networkEdgeEvidence?.itxCoverageContract?.sha256
    || mobileProfile !== "mobile-v19" || !ownership.executionProfiles?.[mobileProfile]) throw new Error("ITX handoff identity mismatch");
  const fixture = ownership.fixtures?.mobile;
  const revision = fixture?.profileCommit?.[mobileProfile];
  const file = fixture?.requiredFiles?.find((entry) => entry?.path === "assets/datapacks/capital.sqlite.gz");
  const gzipSha256 = file?.profileSha256?.[mobileProfile];
  if (fixture?.repository !== "AquilaXk/easysubway-mobile" || !SHA1.test(revision ?? "") || !SHA256.test(gzipSha256 ?? "") || sha256(mobilePackBytes) !== gzipSha256) throw new Error("mobile pack ownership mismatch");
  let sqlite;
  try { sqlite = gunzipSync(mobilePackBytes); } catch { throw new Error("mobile pack gzip mismatch"); }
  if (sqlite.length < 64 || sqlite.subarray(0, 16).toString("ascii") !== "SQLite format 3\u0000" || sqlite.readUInt32BE(60) !== 19
    || topology.pack?.outputSqliteSha256 !== sha256(sqlite)) throw new Error("mobile pack SQLite mismatch");
  return { coverage, ownership, revision, gzipSha256, sqliteSha256: sha256(sqlite), topology };
}

export function buildCurrentSourceSetHandoff({ compositeReceiptBytes, compositeBytes, expectedApprovalId, releaseRequestBytes, productionInputBytes, reviewedPackBytes, itxTopologyEvidenceBytes, itxTopologyEvidencePath, coverageContractBytes, coverageContractPath, ownershipBytes, mobilePackBytes, mobileProfile, sourceRepositorySha, producerSha, operationId }) {
  requireIdentity({ sourceRepositorySha, producerSha, operationId });
  const receipt = parseCanonical(compositeReceiptBytes, canonicalCurrentCapitalLiveChainOciReceiptJson, "composite receipt");
  validateExternalReceipt({ receipt, compositeBytes, sourceRepositorySha, operationId });
  const bundle = readCurrentCapitalLiveChainBundle(compositeBytes, { repository: REPOSITORY, repositorySha: sourceRepositorySha, operationId });
  const { boundary, boundaryBytes, components, entries, releaseRequest: compositeReleaseRequest } = readVerifiedComponents(bundle);
  verifyEmbeddedExitReceipt({ components, externalReceipt: receipt, sourceRepositorySha, operationId });

  const candidate = components.candidateBuildSpec.value;
  const releaseRequest = verifyReleaseRequest({
    compositeReleaseRequestBytes: compositeReleaseRequest.bytes,
    releaseRequestBytes,
    candidateBytes: components.candidateBuildSpec.bytes,
    candidate,
    expectedApprovalId,
  });
  validateRetainedSourceInputs({ sourceRepositorySha, productionInputBytes, ownershipBytes });
  validateProductionInputs({ productionInputBytes, reviewedPackBytes, sourceInventoryBytes: components.sourceInventory.bytes, candidate });
  const mobile = validateItxEvidence({ itxTopologyEvidenceBytes, coverageContractBytes, ownershipBytes, mobilePackBytes, mobileProfile, candidate });
  const outputs = protectedOutputs({ entries, components, releaseRequest: compositeReleaseRequest, productionInputBytes, reviewedPackBytes });
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
    verifiedInputs: {
      composite: verifiedBytes(compositeBytes, "composite"),
      compositeReceipt: verifiedBytes(compositeReceiptBytes, "composite receipt"),
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
    protectedOutputs: outputs,
    producerSha,
    repository: REPOSITORY,
    releaseRequest: {
      approvalId: releaseRequest.approvalId,
      candidateId: releaseRequest.candidateId,
      sha256: sha256(releaseRequestBytes),
    },
    schemaVersion: 2,
    sourceRepositorySha,
    itx: {
      coverageContract: embeddedBytes(candidate.networkEdgeEvidence.itxCoverageContract.path, coverageContractBytes, "ITX coverage contract"),
      topologyEvidence: embeddedBytes(candidate.itxTopologyEvidencePath, itxTopologyEvidenceBytes, "ITX topology evidence"),
    },
    mobile: {
      gzip: embeddedBytes("apps/mobile/assets/datapacks/capital.sqlite.gz", mobilePackBytes, "mobile pack"),
      gzipSha256: mobile.gzipSha256,
      profile: mobileProfile,
      repositoryRevision: mobile.revision,
      sqliteSha256: mobile.sqliteSha256,
    },
    ownership: embeddedBytes("tools/ci/data-test-ownership.json", ownershipBytes, "data test ownership"),
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
  assertKeys(handoff, ["artifactKind", "candidate", "composite", "evidence", "fanIn", "handoffSha256", "itx", "mobile", "operationId", "ownership", "producerSha", "protectedOutputs", "repository", "releaseRequest", "schemaVersion", "sourceRepositorySha", "verifiedInputs"], "source-set handoff");
  const { handoffSha256, ...payload } = handoff;
  if (!SHA256.test(handoffSha256 ?? "") || sha256(Buffer.from(canonical(payload))) !== handoffSha256) throw new Error("source-set handoff hash mismatch");
  validateHandoffPayload(payload, { sourceRepositorySha, producerSha, operationId });
  if (!bytes.equals(Buffer.from(`${canonical(handoff)}\n`))) throw new Error("source-set handoff must be canonical bytes");
  return handoff;
}

function validateHandoffPayload(payload, { sourceRepositorySha, producerSha, operationId }) {
  assertKeys(payload, ["artifactKind", "candidate", "composite", "evidence", "fanIn", "itx", "mobile", "operationId", "ownership", "producerSha", "protectedOutputs", "repository", "releaseRequest", "schemaVersion", "sourceRepositorySha", "verifiedInputs"], "source-set handoff payload");
  if (payload.schemaVersion !== 2 || payload.artifactKind !== "current-source-set-handoff" || payload.repository !== REPOSITORY
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
  validateEmbeddedHandoff(payload);
}

function validateEmbeddedHandoff(payload) {
  assertKeys(payload.verifiedInputs, ["composite", "compositeReceipt"], "verified inputs");
  const compositeReceiptBytes = readVerifiedBytes(payload.verifiedInputs.compositeReceipt, "embedded composite receipt");
  const compositeBytes = readVerifiedBytes(payload.verifiedInputs.composite, "embedded composite");
  const receipt = parseCanonical(compositeReceiptBytes, canonicalCurrentCapitalLiveChainOciReceiptJson, "embedded composite receipt");
  validateExternalReceipt({ receipt, compositeBytes, sourceRepositorySha: payload.sourceRepositorySha, operationId: payload.operationId });
  const bundle = readCurrentCapitalLiveChainBundle(compositeBytes, { repository: REPOSITORY, repositorySha: payload.sourceRepositorySha, operationId: payload.operationId });
  const composite = readVerifiedComponents(bundle);
  verifyEmbeddedExitReceipt({ components: composite.components, externalReceipt: receipt, sourceRepositorySha: payload.sourceRepositorySha, operationId: payload.operationId });
  const candidate = composite.components.candidateBuildSpec.value;
  const releaseRequest = composite.releaseRequest.value;
  const facility = composite.components.facilityAdmission.value;
  const transferMetrics = composite.components.transferMetrics.value;
  const transferApplicability = composite.components.transferApplicability.value;
  const exitAdmission = composite.components.exitAdmission.value;
  const expectedComposite = {
    bundleSha256: bundle.bundleSha256,
    manifestSha256: bundle.manifestSha256,
    object: receipt.compositeObject,
    planSha256: receipt.planSha256,
    providerObject: receipt.providerObject,
    receiptIdentitySha256: receipt.receiptSha256,
    receiptSha256: sha256(compositeReceiptBytes),
  };
  const expectedFanIn = {
    components: composite.boundary.components,
    kind: composite.boundary.kind,
    path: bundle.boundary.path,
    sha256: sha256(composite.boundaryBytes),
    sourceSetSha256: composite.boundary.currentCandidateSourceSetSha256,
  };
  const expectedCandidate = {
    candidateId: candidate.candidateId,
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
    sourceSnapshots: candidate.sourceSnapshots.map(({ sourceId, snapshotId }) => ({ snapshotId, sourceId })),
  };
  const expectedReleaseRequest = {
    approvalId: releaseRequest.approvalId,
    candidateId: releaseRequest.candidateId,
    sha256: sha256(composite.releaseRequest.bytes),
  };
  const expectedEvidence = {
    exit: {
      admissionReceiptSha256: composite.boundary.components.exitAdmissionOciReceipt.sha256,
      admissionSha256: composite.boundary.components.exitAdmission.sha256,
      candidateId: exitAdmission.candidate?.candidateId,
      normalizedSha256: composite.boundary.components.exitNormalized.sha256,
      snapshotId: exitAdmission.sourceIdentity?.snapshotId,
      sourceId: exitAdmission.sourceIdentity?.sourceId,
      sourceSnapshotSetHash: exitAdmission.candidate?.sourceSetSha256,
    },
    facility: {
      admissionSha256: composite.boundary.components.facilityAdmission.sha256,
      candidateId: facility.candidate?.candidateId,
      sourceSnapshotSetHash: facility.candidate?.sourceSnapshotSetHash,
    },
    transfer: {
      applicabilityArtifactSha256: transferApplicability.artifactSha256,
      applicabilitySha256: composite.boundary.components.transferApplicability.sha256,
      metricsArtifactSha256: transferMetrics.artifactSha256,
      metricsSha256: composite.boundary.components.transferMetrics.sha256,
      rawSha256: transferMetrics.sourceIdentity?.rawSha256,
      sourceId: transferMetrics.sourceIdentity?.sourceId,
    },
  };
  if (canonical(payload.composite) !== canonical(expectedComposite)
    || canonical(payload.fanIn) !== canonical(expectedFanIn)
    || canonical(payload.candidate) !== canonical(expectedCandidate)
    || canonical(payload.releaseRequest) !== canonical(expectedReleaseRequest)
    || canonical(payload.evidence) !== canonical(expectedEvidence)) {
    throw new Error("embedded composite projection mismatch");
  }
  if (!Array.isArray(payload.protectedOutputs) || payload.protectedOutputs.length !== PROTECTED_COMPONENT_NAMES.length) throw new Error("protected outputs mismatch");
  const byPath = new Map(payload.protectedOutputs.map((entry) => [entry.path, entry]));
  if (byPath.size !== PROTECTED_COMPONENT_NAMES.length) throw new Error("protected outputs duplicate path");
  for (const name of PROTECTED_COMPONENT_NAMES) {
    const entry = byPath.get(PROTECTED_COMPONENT_PATHS[name]);
    if (!entry) throw new Error("protected outputs path mismatch");
    readEmbeddedBytes(entry, `protected ${name}`);
  }
  for (const name of PROTECTED_COMPONENT_NAMES.filter((name) => !["capital-pilot-production-source-input", "capital-production-reviewed-pack"].includes(name))) {
    const outputBytes = readEmbeddedBytes(byPath.get(PROTECTED_COMPONENT_PATHS[name]), `protected ${name}`);
    const compositeEntry = composite.entries.get(PROTECTED_COMPONENT_PATHS[name]);
    if (!compositeEntry || !outputBytes.equals(strictEntryBytes(compositeEntry, `embedded composite ${name}`))) throw new Error(`protected ${name} composite mismatch`);
  }
  const candidateBytes = readEmbeddedBytes(byPath.get(PROTECTED_COMPONENT_PATHS["candidate-build-spec"]), "protected candidate");
  const protectedCandidate = parseJsonBytes(candidateBytes, "protected candidate");
  if (protectedCandidate.candidateId !== payload.candidate.candidateId || protectedCandidate.sourceSnapshotSetHash !== payload.candidate.sourceSnapshotSetHash) throw new Error("protected candidate identity mismatch");
  const requestBytes = readEmbeddedBytes(byPath.get(PROTECTED_COMPONENT_PATHS["release-request"]), "protected release request");
  if (sha256(requestBytes) !== payload.releaseRequest.sha256 || !requestBytes.equals(composite.releaseRequest.bytes)) throw new Error("protected release request mismatch");
  const productionInputBytes = readEmbeddedBytes(byPath.get(PROTECTED_COMPONENT_PATHS["capital-pilot-production-source-input"]), "protected production input");
  const reviewedPackBytes = readEmbeddedBytes(byPath.get(PROTECTED_COMPONENT_PATHS["capital-production-reviewed-pack"]), "protected reviewed pack");
  assertKeys(payload.itx, ["coverageContract", "topologyEvidence"], "ITX handoff");
  if (payload.itx.topologyEvidence?.path !== candidate.itxTopologyEvidencePath
    || payload.itx.coverageContract?.path !== candidate.networkEdgeEvidence?.itxCoverageContract?.path) throw new Error("ITX handoff identity mismatch");
  assertKeys(payload.mobile, ["gzip", "gzipSha256", "profile", "repositoryRevision", "sqliteSha256"], "mobile handoff");
  if (payload.ownership?.path !== "tools/ci/data-test-ownership.json" || payload.mobile.gzip?.path !== "apps/mobile/assets/datapacks/capital.sqlite.gz") throw new Error("mobile handoff path mismatch");
  const ownershipBytes = readEmbeddedBytes(payload.ownership, "ownership handoff");
  validateRetainedSourceInputs({ sourceRepositorySha: payload.sourceRepositorySha, productionInputBytes, ownershipBytes });
  validateProductionInputs({ productionInputBytes, reviewedPackBytes, sourceInventoryBytes: composite.components.sourceInventory.bytes, candidate: protectedCandidate });
  const mobilePackBytes = readEmbeddedBytes(payload.mobile.gzip, "mobile gzip handoff");
  const mobile = validateItxEvidence({
    itxTopologyEvidenceBytes: readEmbeddedBytes(payload.itx.topologyEvidence, "ITX topology handoff"),
    coverageContractBytes: readEmbeddedBytes(payload.itx.coverageContract, "ITX coverage handoff"),
    ownershipBytes,
    mobilePackBytes,
    mobileProfile: payload.mobile.profile,
    candidate: protectedCandidate,
  });
  if (payload.mobile.repositoryRevision !== mobile.revision || payload.mobile.gzipSha256 !== mobile.gzipSha256 || payload.mobile.sqliteSha256 !== mobile.sqliteSha256) throw new Error("mobile handoff identity mismatch");
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
  if (args.length !== 30 || args[0] !== "--composite-receipt" || args[2] !== "--composite" || args[4] !== "--release-request" || args[6] !== "--production-input" || args[8] !== "--reviewed-pack"
    || args[10] !== "--itx-topology-evidence" || args[12] !== "--coverage-contract" || args[14] !== "--ownership" || args[16] !== "--mobile-pack" || args[18] !== "--mobile-profile"
    || args[20] !== "--expected-approval-id" || args[22] !== "--source-repository-sha" || args[24] !== "--producer-sha" || args[26] !== "--operation-id" || args[28] !== "--output"
    || ![1, 3, 5, 7, 9, 11, 13, 15, 17, 29].every((index) => path.isAbsolute(args[index])) || args[19] !== "mobile-v19" || args[21].length === 0) {
    throw new Error("current source-set handoff arguments mismatch");
  }
  requireIdentity({ sourceRepositorySha: args[23], producerSha: args[25], operationId: args[27] });
  return { compositeReceiptPath: args[1], compositePath: args[3], releaseRequestPath: args[5], productionInputPath: args[7], reviewedPackPath: args[9], itxTopologyEvidencePath: args[11], coverageContractPath: args[13], ownershipPath: args[15], mobilePackPath: args[17], mobileProfile: args[19], expectedApprovalId: args[21], sourceRepositorySha: args[23], producerSha: args[25], operationId: args[27], outputPath: args[29] };
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
  const [compositeReceiptBytes, compositeBytes, releaseRequestBytes, productionInputBytes, reviewedPackBytes, itxTopologyEvidenceBytes, coverageContractBytes, ownershipBytes, mobilePackBytes] = await Promise.all([
    readStableBytes(input.compositeReceiptPath, "composite receipt"),
    readStableBytes(input.compositePath, "composite"),
    readStableBytes(input.releaseRequestPath, "release request"),
    readStableBytes(input.productionInputPath, "production input"),
    readStableBytes(input.reviewedPackPath, "reviewed pack"),
    readStableBytes(input.itxTopologyEvidencePath, "ITX topology evidence"),
    readStableBytes(input.coverageContractPath, "ITX coverage contract"),
    readStableBytes(input.ownershipPath, "data test ownership"),
    readStableBytes(input.mobilePackPath, "mobile pack"),
  ]);
  const output = buildCurrentSourceSetHandoff({ ...input, compositeReceiptBytes, compositeBytes, releaseRequestBytes, productionInputBytes, reviewedPackBytes, itxTopologyEvidenceBytes, coverageContractBytes, ownershipBytes, mobilePackBytes });
  await writeImmutable(input.outputPath, output);
}
