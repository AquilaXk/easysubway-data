#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH, canonicalCurrentCapitalLiveChainFanInBoundaryJson, deriveCurrentLiveChainTransferDescriptorIdentity, validateCurrentCapitalLiveChainFanInBoundary } from "./build-current-capital-live-chain-boundary.mjs";
import { canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { canonicalExitPathAdmissionJson } from "./build-exit-path-admission.mjs";
import { canonicalRouteEdgeEvaluationJson, evaluateRouteAccessibilityEdges } from "./evaluate-route-accessibility-edges.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";
import { validateCurrentCapitalLiveChainMaterialization } from "./validate-current-capital-live-chain-materialization.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
export const CURRENT_CAPITAL_LIVE_CHAIN_FIXED_OUTPUT_PATHS = Object.freeze([
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json",
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
  "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
  "tools/datapack/release/current-transfer-topology-metrics.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
  "release/product-gates/route-edge-evaluation-policy.json",
]);
export const CURRENT_CAPITAL_LIVE_CHAIN_PROVIDER_RECEIPT_PATH = "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireRelative(value, label) {
  if (typeof value !== "string" || value === "" || path.posix.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`${label} must be a safe relative path`);
  return value;
}
function requireIdentity({ repository, repositorySha, operationId }) {
  if (repository !== REPOSITORY || !SHA1.test(repositorySha ?? "") || typeof operationId !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(operationId)) throw new Error("live-chain identity mismatch");
}
export function currentCapitalLiveChainOutputPaths({ candidate, sourceInventory, sourceSnapshotLedger }) {
  const transfer = deriveCurrentLiveChainTransferDescriptorIdentity({ candidate, sourceInventory, sourceSnapshotLedger });
  return Object.freeze([...CURRENT_CAPITAL_LIVE_CHAIN_FIXED_OUTPUT_PATHS, transfer.relativePath].map((entry) => requireRelative(entry, "output path")).sort((left, right) => left.localeCompare(right)));
}
function strictBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) throw new Error("live-chain entry base64 mismatch");
  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - paddingLength;
  if ((paddingLength === 0 ? value.includes("=") : value.indexOf("=") !== contentLength)) throw new Error("live-chain entry base64 mismatch");
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) throw new Error("live-chain entry base64 mismatch");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) throw new Error("live-chain entry base64 mismatch");
  return bytes;
}
async function regularBytes(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("output path escapes root");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("live-chain output must be a regular file");
  return readFile(target);
}

export async function buildCurrentCapitalLiveChainBundle({ root, outputDirectory, repository, repositorySha, operationId, boundaryBytes, boundaryRelativePath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH }) {
  requireIdentity({ repository, repositorySha, operationId });
  const { outputPaths: allowlist } = await validateCurrentCapitalLiveChainMaterialization({
    outputDirectory, repository, repositorySha, operationId, boundaryBytes, boundaryRelativePath,
  });
  const receipt = CURRENT_CAPITAL_LIVE_CHAIN_PROVIDER_RECEIPT_PATH;
  const boundary = readCanonicalBoundary(boundaryBytes, boundaryRelativePath);
  if (!allowlist.includes(receipt)) throw new Error("provider receipt is not allowlisted");
  const entries = await Promise.all(allowlist.map(async (relative) => {
    const bytes = await regularBytes(outputDirectory, relative);
    return { path: relative, sha256: sha256(bytes), bytesBase64: bytes.toString("base64") };
  }));
  const manifest = { schemaVersion: 1, artifactKind: "current-capital-live-chain-composite", repository, repositorySha, operationId, providerReceiptRelativePath: receipt, providerReceiptSha256: entries.find((entry) => entry.path === receipt).sha256, boundary: { path: boundary.relativePath, sha256: sha256(boundary.bytes) }, entries: entries.map(({ path: entryPath, sha256: digest }) => ({ path: entryPath, sha256: digest })) };
  const manifestJson = `${canonical(manifest)}\n`;
  const payload = { ...manifest, manifestSha256: sha256(Buffer.from(manifestJson)), boundaryBytesBase64: boundary.bytes.toString("base64"), entries };
  return Buffer.from(`${canonical({ ...payload, bundleSha256: sha256(Buffer.from(canonical(payload))) })}\n`);
}

export function readCurrentCapitalLiveChainBundle(bytes, { repository, repositorySha, operationId }) {
  requireIdentity({ repository, repositorySha, operationId });
  let bundle; try { bundle = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("live-chain bundle must be JSON"); }
  const required = ["schemaVersion", "artifactKind", "repository", "repositorySha", "operationId", "providerReceiptRelativePath", "providerReceiptSha256", "boundary", "boundaryBytesBase64", "entries", "manifestSha256", "bundleSha256"];
  if (!bundle || typeof bundle !== "object" || Object.keys(bundle).length !== required.length || required.some((key) => !(key in bundle)) || bundle.schemaVersion !== 1 || bundle.artifactKind !== "current-capital-live-chain-composite") throw new Error("live-chain bundle shape mismatch");
  if (bundle.repository !== repository || bundle.repositorySha !== repositorySha || bundle.operationId !== operationId) throw new Error("live-chain identity mismatch");
  const receipt = requireRelative(bundle.providerReceiptRelativePath, "provider receipt path");
  if (!SHA256.test(bundle.providerReceiptSha256 ?? "") || !SHA256.test(bundle.manifestSha256 ?? "") || !SHA256.test(bundle.bundleSha256 ?? "") || !Array.isArray(bundle.entries)
    || bundle.entries.length !== CURRENT_CAPITAL_LIVE_CHAIN_FIXED_OUTPUT_PATHS.length + 1) throw new Error("live-chain bundle digest mismatch");
  const entries = [...bundle.entries].sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of entries) {
    if (!entry || Object.keys(entry).length !== 3 || requireRelative(entry.path, "bundle entry") !== entry.path || !SHA256.test(entry.sha256 ?? "") || sha256(strictBase64(entry.bytesBase64)) !== entry.sha256) throw new Error("live-chain entry integrity mismatch");
  }
  if (new Set(entries.map(({ path: entryPath }) => entryPath)).size !== entries.length) throw new Error("live-chain output allowlist mismatch");
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const allowlist = currentCapitalLiveChainOutputPaths({
    candidate: entryJson(byPath, "tools/datapack/release/candidate-build-spec.json"),
    sourceInventory: entryJson(byPath, "tools/datapack/source-inventory.json"),
    sourceSnapshotLedger: entryJson(byPath, "tools/datapack/release/source-snapshots.json"),
  });
  if (JSON.stringify(entries.map(({ path: entryPath }) => entryPath)) !== JSON.stringify(allowlist)) throw new Error("live-chain output allowlist mismatch");
  const boundary = readCanonicalBoundary(strictBase64(bundle.boundaryBytesBase64), bundle.boundary?.path);
  if (!bundle.boundary || Object.keys(bundle.boundary).length !== 2 || bundle.boundary.path !== boundary.relativePath || bundle.boundary.sha256 !== sha256(boundary.bytes)) throw new Error("live-chain boundary digest mismatch");
  correlateBoundaryComponents(boundary.value, entries);
  validateRouteEdgeEvaluationEntries(byPath, { repository, repositorySha, operationId, boundary: boundary.value });
  const manifest = { schemaVersion: bundle.schemaVersion, artifactKind: bundle.artifactKind, repository: bundle.repository, repositorySha: bundle.repositorySha, operationId: bundle.operationId, providerReceiptRelativePath: receipt, providerReceiptSha256: bundle.providerReceiptSha256, boundary: bundle.boundary, entries: entries.map(({ path: entryPath, sha256: digest }) => ({ path: entryPath, sha256: digest })) };
  if (sha256(Buffer.from(`${canonical(manifest)}\n`)) !== bundle.manifestSha256 || sha256(Buffer.from(canonical({ ...manifest, manifestSha256: bundle.manifestSha256, boundaryBytesBase64: bundle.boundaryBytesBase64, entries }))) !== bundle.bundleSha256 || entries.find((entry) => entry.path === receipt)?.sha256 !== bundle.providerReceiptSha256) throw new Error("live-chain bundle identity mismatch");
  return { ...bundle, entries };
}

async function outputPathsFromDirectory(outputDirectory) {
  const [candidate, sourceInventory, sourceSnapshotLedger] = await Promise.all([
    regularJson(outputDirectory, "tools/datapack/release/candidate-build-spec.json"),
    regularJson(outputDirectory, "tools/datapack/source-inventory.json"),
    regularJson(outputDirectory, "tools/datapack/release/source-snapshots.json"),
  ]);
  return currentCapitalLiveChainOutputPaths({ candidate, sourceInventory, sourceSnapshotLedger });
}

async function regularJson(root, relative) {
  const bytes = await regularBytes(root, relative);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`live-chain ${relative} must be UTF-8 JSON`); }
}

function entryJson(byPath, relative) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entryBytes(byPath, relative))); }
  catch { throw new Error(`live-chain ${relative} must be UTF-8 JSON`); }
}

function entryBytes(byPath, relative) {
  const entry = byPath.get(relative);
  if (!entry) throw new Error("live-chain output allowlist mismatch");
  return strictBase64(entry.bytesBase64);
}

function validateRouteEdgeEvaluationEntries(byPath, { repository, repositorySha, operationId, boundary }) {
  const candidateBuildSpec = entryJson(byPath, "tools/datapack/release/candidate-build-spec.json");
  const routeEdgeInput = entryJson(byPath, "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json");
  const stationLineInput = entryJson(byPath, "tools/datapack/release/current-capital-accessibility-full/station-line-input.json");
  const policy = entryJson(byPath, "release/product-gates/route-edge-evaluation-policy.json");
  const evaluation = entryJson(byPath, "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json");
  const admissionBytes = entryBytes(byPath, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json");
  const receiptBytes = entryBytes(byPath, CURRENT_CAPITAL_LIVE_CHAIN_PROVIDER_RECEIPT_PATH);
  const admission = entryJson(byPath, "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json");
  const receipt = entryJson(byPath, CURRENT_CAPITAL_LIVE_CHAIN_PROVIDER_RECEIPT_PATH);
  if (admissionBytes.toString("utf8") !== canonicalExitPathAdmissionJson(admission)
    || receiptBytes.toString("utf8") !== `${canonicalCurrentExitAdmissionOciReceiptJson(receipt)}\n`) {
    throw new Error("live-chain EXIT bytes are not canonical");
  }
  if (admission.decision !== "GO" || receipt.admissionSha256 !== sha256(admissionBytes)
    || receipt.admissionDigest !== admission.admissionDigest
    || receipt.repository !== repository || receipt.mainSha !== repositorySha || receipt.operationId !== operationId) {
    throw new Error("live-chain EXIT identity mismatch");
  }
  const currentCandidates = [routeEdgeInput.candidate, stationLineInput.candidate];
  if (boundary.currentCandidateSourceSetSha256 !== candidateBuildSpec.sourceSnapshotSetHash
    || boundary.evidenceSourceSetSha256 === boundary.currentCandidateSourceSetSha256
    || currentCandidates.some(({ candidateId }) => candidateId !== candidateBuildSpec.candidateId)
    || currentCandidates.some(({ sourceSetSha256 }) => sourceSetSha256 !== boundary.currentCandidateSourceSetSha256)
    || admission.candidate?.candidateId !== candidateBuildSpec.candidateId
    || admission.candidate?.sourceSetSha256 !== boundary.evidenceSourceSetSha256
    || [...currentCandidates, admission.candidate].some(({ stationSetSha256 }) => stationSetSha256 !== routeEdgeInput.candidate.stationSetSha256)
    || stationLineInput.candidate.mappingContractVersion !== admission.candidate.mappingContractVersion
    || stationLineInput.candidate.materializerVersion !== admission.candidate.materializerVersion
    || routeEdgeInput.candidate.policyVersion !== policy.policyVersion
    || evaluation.evaluationAt !== admission.sourceIdentity?.approvedAt) {
    throw new Error("live-chain route evaluation identity mismatch");
  }
  const materialization = materializeStationLineAccessibility({ ...stationLineInput, observedAt: evaluation.evaluationAt });
  const expected = Buffer.from(canonicalRouteEdgeEvaluationJson(evaluateRouteAccessibilityEdges(
    { ...routeEdgeInput, evaluationAt: evaluation.evaluationAt, materialization }, policy,
  )));
  if (!entryBytes(byPath, "tools/datapack/release/current-capital-accessibility-full/route-edge-evaluation.json").equals(expected)) {
    throw new Error("live-chain route edge evaluation mismatch");
  }
}

function readCanonicalBoundary(bytes, relativePath) {
  const safeRelativePath = requireRelative(relativePath, "live-chain boundary path");
  if (safeRelativePath !== CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH || !Buffer.isBuffer(bytes)) throw new Error("live-chain boundary identity mismatch");
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("live-chain boundary must be JSON"); }
  if (bytes.toString("utf8") !== canonicalCurrentCapitalLiveChainFanInBoundaryJson(value)) throw new Error("live-chain boundary bytes are not canonical");
  validateCurrentCapitalLiveChainFanInBoundary(value);
  return { bytes, relativePath: safeRelativePath, value };
}

function correlateBoundaryComponents(boundary, entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const [name, component] of Object.entries(boundary.components)) {
    const entry = byPath.get(component.path);
    if (!entry || entry.sha256 !== component.sha256) throw new Error(`live-chain boundary ${name} output binding mismatch`);
  }
}
