#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export const CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND = "CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN";
export const CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH = "tools/datapack/release/current-capital-live-chain-fan-in.json";
export const CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS = Object.freeze({
  candidateBuildSpec: "tools/datapack/release/candidate-build-spec.json",
  facilityAdmission: "tools/datapack/release/current-capital-facility-source-admission.json",
  transferMetrics: "tools/datapack/release/current-transfer-topology-metrics.json",
  transferApplicability: "tools/datapack/release/current-capital-transfer-topology-applicability.json",
  sourceInventory: "tools/datapack/source-inventory.json",
  sourceSnapshotLedger: "tools/datapack/release/source-snapshots.json",
  exitNormalized: "tools/datapack/release/current-exit-admission-v2/exit-path-normalized-source-snapshot.json",
  exitAdmission: "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json",
  exitAdmissionOciReceipt: "tools/datapack/release/current-exit-admission-v2/exit-path-admission-oci-receipt.json",
});

const SHA256 = /^[a-f0-9]{64}$/u;
const COMPONENT_NAMES = Object.freeze(Object.keys(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS));
const FORBIDDEN_METADATA = /(?:predecessor|transition|previous|stale|legacy|fallback)/iu;

export function buildCurrentCapitalLiveChainFanInBoundary(components) {
  const normalized = normalizeComponents(components);
  const candidate = normalized.candidateBuildSpec.value;
  const ledger = normalized.sourceSnapshotLedger.value;
  const sourceSetSha256 = validateCurrentIdentity(normalized, candidate, ledger);
  return canonicalObject({
    artifactKind: "current-capital-live-chain-fan-in",
    components: Object.fromEntries(COMPONENT_NAMES.map((name) => [name, {
      path: CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS[name], sha256: sha256(normalized[name].bytes),
    }])),
    currentCandidateSourceSetSha256: sourceSetSha256,
    evidenceSourceSetSha256: sourceSetSha256,
    kind: CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND,
    schemaVersion: 1,
  });
}

export function canonicalCurrentCapitalLiveChainFanInBoundaryJson(value) {
  validateCurrentCapitalLiveChainFanInBoundary(value);
  return canonicalJson(value);
}

export function validateCurrentCapitalLiveChainFanInBoundary(value) {
  assertKeys(value, ["artifactKind", "components", "currentCandidateSourceSetSha256", "evidenceSourceSetSha256", "kind", "schemaVersion"], "current live-chain fan-in boundary");
  if (value.schemaVersion !== 1 || value.artifactKind !== "current-capital-live-chain-fan-in" || value.kind !== CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_KIND
    || !SHA256.test(value.currentCandidateSourceSetSha256 ?? "") || value.evidenceSourceSetSha256 !== value.currentCandidateSourceSetSha256) {
    throw new Error("current live-chain fan-in identity mismatch");
  }
  assertKeys(value.components, COMPONENT_NAMES, "current live-chain fan-in components");
  for (const name of COMPONENT_NAMES) {
    const entry = value.components[name];
    assertKeys(entry, ["path", "sha256"], `current live-chain ${name} component`);
    if (entry.path !== CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS[name] || !SHA256.test(entry.sha256 ?? "")) {
      throw new Error(`current live-chain ${name} component mismatch`);
    }
  }
  rejectForbiddenMetadata(value, "current live-chain fan-in boundary");
  return value;
}

export function verifyCurrentCapitalLiveChainFanInComponents(boundary, components) {
  validateCurrentCapitalLiveChainFanInBoundary(boundary);
  const normalized = normalizeComponents(components);
  for (const name of COMPONENT_NAMES) {
    if (boundary.components[name].sha256 !== sha256(normalized[name].bytes)) throw new Error(`current live-chain ${name} byte binding mismatch`);
  }
  const sourceSetSha256 = validateCurrentIdentity(normalized, normalized.candidateBuildSpec.value, normalized.sourceSnapshotLedger.value);
  if (boundary.currentCandidateSourceSetSha256 !== sourceSetSha256 || boundary.evidenceSourceSetSha256 !== sourceSetSha256) {
    throw new Error("current live-chain fan-in source-set mismatch");
  }
  return boundary;
}

export async function readCurrentCapitalLiveChainFanInBoundary({ repositoryRoot, relativePath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH } = {}) {
  const root = path.resolve(repositoryRoot ?? "");
  const boundaryRelativePath = requireRelative(relativePath, "current live-chain fan-in path");
  const boundaryFile = await readStableJson(root, boundaryRelativePath, "current live-chain fan-in boundary");
  if (boundaryFile.bytes.toString("utf8") !== canonicalCurrentCapitalLiveChainFanInBoundaryJson(boundaryFile.value)) {
    throw new Error("current live-chain fan-in boundary bytes are not canonical");
  }
  const components = Object.fromEntries(await Promise.all(COMPONENT_NAMES.map(async (name) => [name, await readStableJson(root, CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS[name], `current live-chain ${name}`)])));
  verifyCurrentCapitalLiveChainFanInComponents(boundaryFile.value, components);
  return { boundary: boundaryFile.value, bytes: boundaryFile.bytes, components };
}

function normalizeComponents(components) {
  assertKeys(components, COMPONENT_NAMES, "current live-chain component inputs");
  const normalized = {};
  for (const name of COMPONENT_NAMES) {
    const component = components[name];
    assertKeys(component, ["bytes", "value"], `current live-chain ${name} input`);
    if (!Buffer.isBuffer(component.bytes)) throw new Error(`current live-chain ${name} bytes are required`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(component.bytes)); }
    catch { throw new Error(`current live-chain ${name} bytes must be UTF-8 JSON`); }
    if (canonicalJson(parsed) !== canonicalJson(component.value)) throw new Error(`current live-chain ${name} semantic byte mismatch`);
    normalized[name] = { bytes: component.bytes, value: component.value };
  }
  return normalized;
}

export function deriveCurrentLiveChainTransferDescriptorIdentity({ candidate, sourceInventory, sourceSnapshotLedger: ledger }) {
  if (!candidate || typeof candidate.candidateId !== "string" || candidate.candidateId === "" || !Array.isArray(candidate.sourceSnapshotIds)
    || !Array.isArray(candidate.sourceSnapshots) || candidate.sourceSnapshotIds.length !== candidate.sourceSnapshots.length
    || candidate.sourceSnapshotIds.length === 0 || !SHA256.test(candidate.sourceSnapshotSetHash ?? "") || !Array.isArray(ledger)) {
    throw new Error("current live-chain candidate shape mismatch");
  }
  const inventorySources = sourceInventory?.sources ?? [];
  const requiredSources = inventorySources.filter(({ requiredForProductionPack }) => requiredForProductionPack === true);
  const requiredSourceIds = new Set(requiredSources.map(({ id }) => id));
  const candidateSourceIds = new Set(candidate.sourceSnapshots.map(({ sourceId }) => sourceId));
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  if (requiredSources.length === 0 || requiredSourceIds.size !== requiredSources.length
    || candidateSourceIds.size !== candidate.sourceSnapshots.length || selectedIds.size !== candidate.sourceSnapshotIds.length
    || requiredSourceIds.size !== candidateSourceIds.size || [...requiredSourceIds].some((sourceId) => !candidateSourceIds.has(sourceId))) {
    throw new Error("current live-chain candidate source identity mismatch");
  }
  const selected = candidate.sourceSnapshotIds.map((snapshotId, index) => {
    const rows = ledger.filter((entry) => entry?.snapshotId === snapshotId);
    if (rows.length !== 1 || rows[0].sourceId !== candidate.sourceSnapshots[index]?.sourceId || rows[0].snapshotId !== candidate.sourceSnapshots[index]?.snapshotId) throw new Error("current live-chain candidate ledger mismatch");
    return rows[0];
  });
  const selectedInLedgerOrder = ledger.filter((entry) => selectedIds.has(entry?.snapshotId));
  if (selectedInLedgerOrder.length !== selectedIds.size || sha256(JSON.stringify(selectedInLedgerOrder)) !== candidate.sourceSnapshotSetHash) {
    throw new Error("current live-chain candidate source-set mismatch");
  }
  const source = exactlyOne(requiredSources, (entry) => entry?.transferAdmissionEvidence, "current live-chain transfer source");
  const transferIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === source.id);
  const transfer = selected[transferIndex];
  const transferProjection = candidate.sourceSnapshots[transferIndex];
  if (transferIndex < 0 || transfer?.snapshotStatus !== "LOCKED" || transferProjection?.snapshotId !== transfer.snapshotId) {
    throw new Error("current live-chain transfer must be selected and active");
  }
  const admission = source.transferAdmissionEvidence;
  const relativePath = `tools/datapack/sources/${transfer.snapshotId}.json`;
  if (admission?.decision !== "APPROVED" || admission.snapshotId !== transfer.snapshotId || admission.snapshotPath !== relativePath
    || admission.rawSha256 !== transfer.rawSha256 || admission.schemaFingerprint !== transfer.schemaFingerprint
    || transfer.rawReceipt?.snapshotId !== transfer.snapshotId || transfer.rawReceipt?.snapshotRawSha256 !== transfer.rawSha256
    || transfer.rawReceipt?.rawObjectSha256 !== transfer.rawSha256 || transfer.rawReceipt?.rawObjectUri !== transfer.rawObjectUri
    || transferProjection.rawSha256 !== transfer.rawSha256
    || transferProjection.schemaFingerprint !== transfer.schemaFingerprint || transferProjection.rawObjectUri !== transfer.rawObjectUri) {
    throw new Error("current live-chain transfer identity mismatch");
  }
  return { sourceId: source.id, snapshotId: transfer.snapshotId, relativePath, row: transfer, projection: transferProjection, source, sourceSetSha256: candidate.sourceSnapshotSetHash };
}

function validateCurrentIdentity(components, candidate, ledger) {
  const identity = deriveCurrentLiveChainTransferDescriptorIdentity({
    candidate,
    sourceInventory: components.sourceInventory.value,
    sourceSnapshotLedger: ledger,
  });
  const { row: transfer, source, sourceSetSha256 } = identity;
  const admission = source.transferAdmissionEvidence;
  const metrics = components.transferMetrics.value;
  const applicability = components.transferApplicability.value;
  if (metrics?.artifactKind !== "current-transfer-topology-metrics" || metrics.sourceIdentity?.sourceId !== transfer.sourceId || metrics.sourceIdentity?.rawSha256 !== transfer.rawSha256
    || applicability?.artifactKind !== "current-capital-transfer-topology-applicability-pre-candidate" || applicability.transferTopologyMetricsIdentity?.artifactSha256 !== metrics.artifactSha256
    || admission.metricsArtifactSha256 !== metrics.artifactSha256 || admission.applicabilityArtifactSha256 !== applicability.artifactSha256) {
    throw new Error("current live-chain transfer identity mismatch");
  }
  const facility = components.facilityAdmission.value;
  if (facility?.decision !== "GO" || facility.candidate?.candidateId !== candidate.candidateId || facility.candidate?.sourceSnapshotSetHash !== candidate.sourceSnapshotSetHash) {
    throw new Error("current live-chain FACILITY candidate mismatch");
  }
  const exit = components.exitAdmission.value;
  const normalized = components.exitNormalized.value;
  const receipt = components.exitAdmissionOciReceipt.value;
  if (exit?.decision !== "GO" || exit.candidate?.candidateId !== candidate.candidateId || exit.candidate?.sourceSetSha256 !== candidate.sourceSnapshotSetHash
    || normalized?.sourceId !== exit.sourceIdentity?.sourceId || normalized?.snapshotId !== exit.sourceIdentity?.snapshotId
    || receipt?.normalizedSnapshotSha256 !== sha256(components.exitNormalized.bytes) || receipt?.admissionSha256 !== sha256(components.exitAdmission.bytes)) {
    throw new Error("current live-chain EXIT candidate mismatch");
  }
  return sourceSetSha256;
}

function rejectForbiddenMetadata(value, label) {
  const visit = (current) => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_METADATA.test(key)) throw new Error(`${label} forbidden historical metadata`);
      visit(child);
    }
  };
  visit(value);
}

async function readStableJson(root, relative, label) {
  const safe = requireRelative(relative, label);
  const target = path.resolve(root, safe);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path escapes repository root`);
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(`${label} cannot enforce O_NOFOLLOW`);
  let handle;
  try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`${label} must be a regular non-symlink file`, { cause: error }); }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const bound = await lstat(target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.dev !== bound.dev || before.ino !== bound.ino || bound.isSymbolicLink()) {
      throw new Error(`${label} changed while reading`);
    }
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error(`${label} must be UTF-8 JSON`); }
    return { bytes, value };
  } finally { await handle.close(); }
}

function requireRelative(value, label) {
  if (typeof value !== "string" || value === "" || path.posix.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`${label} must be a safe relative path`);
  return value;
}
function assertKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compareBytes)) !== canonicalJson([...keys].sort(compareBytes))) throw new Error(`${label} keys mismatch`); }
function exactlyOne(rows, predicate, label) { const matches = rows.filter(predicate); if (matches.length !== 1) throw new Error(`${label} must be exactly one`); return matches[0]; }
function canonicalObject(value) { if (Array.isArray(value)) return value.map(canonicalObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])])); }
function canonicalJson(value) { return JSON.stringify(canonicalObject(value)); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function compareBytes(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
