#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH, canonicalCurrentCapitalLiveChainFanInBoundaryJson, deriveCurrentLiveChainTransferDescriptorIdentity, validateCurrentCapitalLiveChainFanInBoundary } from "./build-current-capital-live-chain-boundary.mjs";
import { canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { canonicalExitPathAdmissionJson } from "./build-exit-path-admission.mjs";
import { canonicalRouteEdgeEvaluationJson, evaluateRouteAccessibilityEdges } from "./evaluate-route-accessibility-edges.mjs";
import { materializeStationLineAccessibility } from "./materialize-station-line-accessibility.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const SHA1 = /^[a-f0-9]{40}$/u;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
async function regularBytes(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, requireRelative(relative, "output path"));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("output path escapes root");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("live-chain output must be a regular file");
  return readFile(target);
}
async function regularJson(root, relative) {
  const bytes = await regularBytes(root, relative);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`live-chain ${relative} must be UTF-8 JSON`); }
}
function entryJson(byPath, relative) {
  const bytes = byPath.get(relative);
  if (!bytes) throw new Error("live-chain output allowlist mismatch");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`live-chain ${relative} must be UTF-8 JSON`); }
}
function entryBytes(byPath, relative) {
  const bytes = byPath.get(relative);
  if (!bytes) throw new Error("live-chain output allowlist mismatch");
  return bytes;
}
function readCanonicalBoundary(bytes, relativePath) {
  const safeRelativePath = requireRelative(relativePath, "live-chain boundary path");
  if (safeRelativePath !== CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH || !Buffer.isBuffer(bytes)) throw new Error("live-chain boundary identity mismatch");
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("live-chain boundary must be JSON"); }
  if (bytes.toString("utf8") !== canonicalCurrentCapitalLiveChainFanInBoundaryJson(value)) throw new Error("live-chain boundary bytes are not canonical");
  validateCurrentCapitalLiveChainFanInBoundary(value);
  return { bytes, relativePath: safeRelativePath, value };
}
function correlateBoundaryComponents(boundary, byPath) {
  for (const [name, component] of Object.entries(boundary.components)) {
    const bytes = byPath.get(component.path);
    if (!bytes || sha256(bytes) !== component.sha256) throw new Error(`live-chain boundary ${name} output binding mismatch`);
  }
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
  const receiptHeadSha = receipt.schemaVersion === 1 ? receipt.mainSha : receipt.candidateHeadSha;
  const receiptOperationId = receipt.schemaVersion === 1 ? receipt.operationId : receipt.candidateOperationId;
  if (admission.decision !== "GO" || receipt.admissionSha256 !== sha256(admissionBytes)
    || receipt.admissionDigest !== admission.admissionDigest
    || receipt.repository !== repository || receiptHeadSha !== repositorySha || receiptOperationId !== operationId) {
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

/**
 * Validate the canonical 17 output bytes and the separate fan-in boundary.
 * This performs no publication, persistence, or composite construction.
 */
export async function validateCurrentCapitalLiveChainMaterialization({ outputDirectory, repository, repositorySha, operationId, boundaryBytes, boundaryRelativePath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH }) {
  requireIdentity({ repository, repositorySha, operationId });
  const [candidate, sourceInventory, sourceSnapshotLedger] = await Promise.all([
    regularJson(outputDirectory, "tools/datapack/release/candidate-build-spec.json"),
    regularJson(outputDirectory, "tools/datapack/source-inventory.json"),
    regularJson(outputDirectory, "tools/datapack/release/source-snapshots.json"),
  ]);
  const outputPaths = currentCapitalLiveChainOutputPaths({ candidate, sourceInventory, sourceSnapshotLedger });
  if (outputPaths.length !== CURRENT_CAPITAL_LIVE_CHAIN_FIXED_OUTPUT_PATHS.length + 1) throw new Error("live-chain output allowlist mismatch");
  const entries = await Promise.all(outputPaths.map(async (relative) => [relative, await regularBytes(outputDirectory, relative)]));
  const byPath = new Map(entries);
  const boundary = readCanonicalBoundary(boundaryBytes, boundaryRelativePath);
  correlateBoundaryComponents(boundary.value, byPath);
  validateRouteEdgeEvaluationEntries(byPath, { repository, repositorySha, operationId, boundary: boundary.value });
  return Object.freeze({ outputPaths, boundary });
}
