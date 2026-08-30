#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { canonicalCurrentCapitalStationLineInputJson } from "./current-capital-station-line-contract.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import {
  CURRENT_FULL_CANDIDATE_SOURCE_IDS,
  CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS,
} from "./rebind-current-candidate-source-snapshots.mjs";

const FILES = Object.freeze({
  candidate: "tools/datapack/release/candidate-build-spec.json",
  previous: "tools/datapack/release/current-station-line-accessibility/station-line-input.json",
  facility: "tools/datapack/release/current-capital-facility-source-admission.json",
  inventory: "tools/datapack/source-inventory.json",
  snapshots: "tools/datapack/release/source-snapshots.json",
  transition: "tools/datapack/release/current-capital-accessibility-transition.json",
});
const SHA = /^[a-f0-9]{64}$/u;
const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
const PROJECTION_KEYS = Object.freeze([
  "snapshotId", "sourceId", "rawObjectUri", "rawSha256", "redactedRequestFingerprint",
  "schemaFingerprint", "licenseStatus", "redistributionAllowed", "adminReviewRecordHash",
  "snapshotStatus", "credentialRedacted", "freshnessExpiresAt", "rawRetentionExpiresAt",
  "governancePolicyVersion", "governancePolicySha256",
]);
const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "state", "nextCandidate", "previousCandidate", "previousProduction",
  "facilityAdmission", "pendingPrerequisites", "transitionSha256",
]);

export function buildCurrentCapitalAccessibilityTransition(input) {
  const candidateBytes = requiredBytes(input?.candidateBytes, "candidate build spec");
  const previousBytes = requiredBytes(input?.previousBytes, "previous production station-line input");
  const facilityBytes = requiredBytes(input?.facilityBytes, "current FACILITY admission");
  const ledgerBytes = requiredBytes(input?.ledgerBytes, "source snapshot ledger");
  const inventoryBytes = requiredBytes(input?.inventoryBytes, "source inventory");
  const candidate = bindParsed(input?.candidate, candidateBytes, "candidate build spec");
  const previous = bindParsed(input?.previous, previousBytes, "previous production station-line input");
  const facility = bindParsed(input?.facilityAdmission, facilityBytes, "current FACILITY admission");
  const ledger = bindParsed(input?.ledger, ledgerBytes, "source snapshot ledger");
  const inventory = bindParsed(input?.inventory, inventoryBytes, "source inventory");
  assertExactTransitionCandidate(candidate);
  const candidateId = requiredString(candidate.candidateId, "candidateId");
  const nextSourceSet = requiredSha(candidate.sourceSnapshotSetHash, "candidate source snapshot set");
  const predecessor = derivePreviousCandidate({ candidate, inventory, inventoryBytes, ledger });
  const predecessorBytes = candidateBytesFor(predecessor);
  return finalizeTransitionPayload(buildTransitionPayload({
    nextCandidate: {
      path: FILES.candidate,
      sha256: sha256(candidateBytes),
      candidateId,
      sourceSnapshotSetHash: nextSourceSet,
    },
    previousCandidate: {
      canonicalCandidate: predecessor,
      sha256: sha256(predecessorBytes),
      candidateId: predecessor.candidateId,
      sourceSnapshotSetHash: predecessor.sourceSnapshotSetHash,
    },
    previous,
    previousBytes,
    facility,
    facilityBytes,
  }));
}

export function canonicalCurrentCapitalAccessibilityTransitionJson(value) {
  validateTransition(value);
  return `${canonicalJson(value)}\n`;
}

export async function readCurrentCapitalAccessibilityTransitionBoundary({ repositoryRoot }) {
  const boundary = await inspectCurrentCapitalAccessibilityTransition({ repositoryRoot, allowMissing: false });
  if (boundary.currentCandidateSourceSetSha256 === boundary.evidenceSourceSetSha256) {
    throw new Error("full fan-in transition append required");
  }
  return boundary;
}

export async function assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot }) {
  const boundary = await inspectCurrentCapitalAccessibilityTransition({ repositoryRoot, allowMissing: true });
  if (!boundary) return;
  throw new Error("CURRENT_ACCESSIBILITY_TRANSITION_BLOCKED");
}

async function inspectCurrentCapitalAccessibilityTransition({ repositoryRoot, allowMissing }) {
  const root = path.resolve(repositoryRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
  const transitionPath = path.join(root, FILES.transition);
  let transition;
  try {
    transition = await readStableRegular(transitionPath, "current accessibility transition");
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    throw error;
  }
  const [candidateBytes, previousBytes, facilityBytes, ledgerBytes, inventoryBytes] = await Promise.all([
    readStableRegular(path.join(root, FILES.candidate), "candidate build spec"),
    readStableRegular(path.join(root, FILES.previous), "previous production station-line input"),
    readStableRegular(path.join(root, FILES.facility), "current FACILITY admission"),
    readStableRegular(path.join(root, FILES.snapshots), "source snapshot ledger"),
    readStableRegular(path.join(root, FILES.inventory), "source inventory"),
  ]);
  const parsed = parse(transition, "current accessibility transition");
  if (canonicalCurrentCapitalAccessibilityTransitionJson(parsed) !== transition.toString("utf8")) {
    throw new Error("transition candidate binding mismatch");
  }
  const candidate = parse(candidateBytes, "candidate build spec");
  const previous = parse(previousBytes, "previous production station-line input");
  const facility = parse(facilityBytes, "current FACILITY admission");
  try {
    const rebuilt = buildCurrentCapitalAccessibilityTransition({
      candidate,
      candidateBytes,
      previous,
      previousBytes,
      facilityAdmission: facility,
      facilityBytes,
      ledger: parse(ledgerBytes, "source snapshot ledger"),
      ledgerBytes,
      inventory: parse(inventoryBytes, "source inventory"),
      inventoryBytes,
    });
    if (canonicalJson(parsed) !== canonicalJson(rebuilt)) {
      throw new Error("stored transition mismatch");
    }
  } catch {
    throw new Error("transition candidate binding mismatch");
  }
  return {
    currentCandidateBytesSha256: sha256(candidateBytes),
    currentCandidateSourceSetSha256: requiredSha(candidate.sourceSnapshotSetHash, "current candidate source snapshot set"),
    facilityAdmissionBytesSha256: sha256(facilityBytes),
    evidenceSourceSetSha256: requiredSha(parsed.previousCandidate.sourceSnapshotSetHash, "transition evidence source snapshot set"),
  };
}

function buildTransitionPayload({ nextCandidate, previousCandidate, previous, previousBytes, facility, facilityBytes }) {
  if (canonicalCurrentCapitalStationLineInputJson(previous) !== previousBytes.toString("utf8")) {
    throw new Error("previous production station-line bytes are not canonical");
  }
  if (canonicalCurrentCapitalFacilitySourceAdmissionJson(facility) !== facilityBytes.toString("utf8")) {
    throw new Error("current FACILITY admission bytes are not canonical");
  }
  const candidateId = requiredString(nextCandidate.candidateId, "candidateId");
  const previousCandidateId = requiredString(previous.candidate?.candidateId, "previous production candidateId");
  const nextSourceSet = requiredSha(nextCandidate.sourceSnapshotSetHash, "candidate source snapshot set");
  const previousSourceSet = requiredSha(previous.candidate?.sourceSetSha256, "previous production source snapshot set");
  if (previousCandidateId === candidateId || previousSourceSet === nextSourceSet) {
    throw new Error("transition source-set boundary mismatch");
  }
  assertFacilityBinding(facility, candidateId, nextSourceSet);
  return {
    schemaVersion: 2,
    artifactKind: "current-capital-accessibility-transition",
    state: "PENDING_FULL_FAN_IN",
    nextCandidate,
    previousCandidate,
    previousProduction: {
      path: FILES.previous,
      sha256: sha256(previousBytes),
      candidateId: previousCandidateId,
      sourceSnapshotSetHash: previousSourceSet,
    },
    facilityAdmission: {
      path: FILES.facility,
      sha256: sha256(facilityBytes),
      admissionDigest: requiredSha(facility.admissionDigest, "FACILITY admission digest"),
      snapshotId: requiredString(facility.sourceIdentity?.snapshotId, "FACILITY snapshotId"),
    },
    pendingPrerequisites: {
      exitAdmissionDirectory: "tools/datapack/release/current-exit-admission-v2",
      transferSourceId: "seoul-metro-transfer-distance-duration",
      fullCapitalInputDirectory: "tools/datapack/release/current-capital-accessibility-full",
      authorityEdgeCount: 456,
    },
  };
}

function assertExactTransitionCandidate(candidate) {
  const sourceIds = candidate?.sourceSnapshots?.map(({ sourceId }) => sourceId);
  if (candidate?.schemaVersion !== 1 || candidate.artifactKind !== "datapack-candidate-build-spec"
    || !Array.isArray(candidate.sourceSnapshotIds) || !Array.isArray(candidate.sourceSnapshots)
    || candidate.sourceSnapshotIds.length !== candidate.sourceSnapshots.length
    || candidate.sourceSnapshotIds.length !== CURRENT_FULL_CANDIDATE_SOURCE_IDS.length
    || JSON.stringify(sourceIds) !== JSON.stringify(CURRENT_FULL_CANDIDATE_SOURCE_IDS)) {
    throw new Error("transition candidate source-set mismatch");
  }
  if (new Set(candidate.sourceSnapshotIds).size !== candidate.sourceSnapshotIds.length
    || candidate.sourceSnapshots.some((projection, index) =>
      projection?.snapshotId !== candidate.sourceSnapshotIds[index])) {
    throw new Error("transition candidate projection mismatch");
  }
}

function finalizeTransitionPayload(payload) {
  return { ...payload, transitionSha256: sha256(Buffer.from(canonicalJson(payload))) };
}

function assertFacilityBinding(facility, candidateId, sourceSnapshotSetHash) {
  if (facility.decision !== "GO" || facility.candidate?.candidateId !== candidateId
    || facility.candidate?.sourceSnapshotSetHash !== sourceSnapshotSetHash
    || facility.cellStateSummary?.ADMITTED_FACILITY_UNVERIFIED_BLOCKED !== 1
    || facility.cells?.filter(({ state }) => state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED").length !== 1) {
    throw new Error("transition FACILITY admission binding mismatch");
  }
  const blocked = facility.cells.find(({ state }) => state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED");
  if (blocked.stationId !== "station-b35616704ce3" || blocked.lineId !== "seoul-2") {
    throw new Error("transition FACILITY blocked identity mismatch");
  }
}

function derivePreviousCandidate({ candidate, inventory, inventoryBytes, ledger }) {
  assertExactTransitionCandidate(candidate);
  if (!Array.isArray(ledger)) throw new Error("transition append ledger mismatch");
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  if (selectedIds.size !== CURRENT_FULL_CANDIDATE_SOURCE_IDS.length) {
    throw new Error("transition append projection mismatch");
  }
  for (const [index, snapshotId] of candidate.sourceSnapshotIds.entries()) {
    const matches = ledger.filter((entry) => entry?.snapshotId === snapshotId);
    const projection = candidate.sourceSnapshots[index];
    const sources = inventory?.sources?.filter(({ id }) => id === projection.sourceId) ?? [];
    const expected = matches.length === 1 && sources.length === 1
      ? Object.fromEntries(PROJECTION_KEYS.map((key) => [
        key,
        key === "adminReviewRecordHash"
          ? sources[0].admissionEvidence?.adminReviewRecordHash
          : matches[0][key],
      ]))
      : null;
    if (matches.length !== 1 || matches[0].sourceId !== projection.sourceId
      || sources.length !== 1 || canonicalJson(projection) !== canonicalJson(expected)) {
      throw new Error("transition append ledger mismatch");
    }
  }
  const selected = ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const predecessorIds = new Set(candidate.sourceSnapshotIds.slice(0, -1));
  const predecessorLedger = ledger.filter(({ snapshotId }) => predecessorIds.has(snapshotId));
  if (selected.length !== CURRENT_FULL_CANDIDATE_SOURCE_IDS.length
    || predecessorLedger.length !== CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS.length
    || sha256(Buffer.from(JSON.stringify(selected))) !== candidate.sourceSnapshotSetHash) {
    throw new Error("transition append source-set mismatch");
  }
  const predecessorInventory = reverseTransferInventoryActivation({
    candidate,
    inventory,
    inventoryBytes,
    transferSnapshotId: candidate.sourceSnapshotIds.at(-1),
  });
  const predecessor = structuredClone(candidate);
  predecessor.sourceSnapshotIds = candidate.sourceSnapshotIds.slice(0, -1);
  predecessor.sourceSnapshots = candidate.sourceSnapshots.slice(0, -1);
  predecessor.sourceSnapshotSetHash = sha256(Buffer.from(JSON.stringify(predecessorLedger)));
  predecessor.sourceInventorySha256 = predecessorInventory.semanticSha256;
  predecessor.networkEdgeEvidence.sourceInventory.sha256 = predecessorInventory.bytesSha256;
  predecessor.candidateId = derivePreviousCandidateId(candidate.candidateId, predecessor.sourceSnapshotSetHash, predecessor.sourceSnapshotIds);
  return predecessor;
}

function derivePreviousCandidateId(nextCandidateId, sourceSnapshotSetHash, sourceSnapshotIds) {
  return `capital-accessibility-predecessor-${sha256(Buffer.from(canonicalJson({
    nextCandidateId: requiredString(nextCandidateId, "next candidateId"),
    sourceSnapshotSetHash: requiredSha(sourceSnapshotSetHash, "predecessor source snapshot set"),
    sourceSnapshotIds,
  })))}`;
}

function candidateBytesFor(candidate) {
  return Buffer.from(canonicalJson(candidate));
}

function reverseTransferInventoryActivation({ candidate, inventory, inventoryBytes, transferSnapshotId }) {
  if (!Buffer.isBuffer(inventoryBytes)
    || inventoryBytes.toString("utf8") !== `${JSON.stringify(inventory, null, 2)}\n`
    || candidate.networkEdgeEvidence?.sourceInventory?.path !== FILES.inventory
    || candidate.networkEdgeEvidence.sourceInventory.sha256 !== sha256(inventoryBytes)
    || candidate.sourceInventorySha256 !== sha256(Buffer.from(JSON.stringify(inventory)))) {
    throw new Error("transition append inventory binding mismatch");
  }
  const matches = inventory?.sources?.filter(({ id }) => id === TRANSFER_SOURCE_ID) ?? [];
  const source = matches.length === 1 ? matches[0] : null;
  if (source?.requiredForProductionPack !== true
    || source.capabilities?.transfer?.status !== "SUPPORTED"
    || source.capabilities.transfer.productionUseAllowed !== true
    || source.capabilities.transfer.coverageStatus !== "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS"
    || source.transferAdmissionEvidence?.decision !== "APPROVED"
    || source.transferAdmissionEvidence.productionUseAllowed !== true
    || source.transferAdmissionEvidence.snapshotId !== transferSnapshotId) {
    throw new Error("transition append inventory activation mismatch");
  }
  const predecessor = structuredClone(inventory);
  const predecessorSource = predecessor.sources.find(({ id }) => id === TRANSFER_SOURCE_ID);
  predecessorSource.requiredForProductionPack = false;
  delete predecessorSource.capabilities.transfer;
  delete predecessorSource.transferAdmissionEvidence;
  return {
    bytesSha256: sha256(Buffer.from(`${JSON.stringify(predecessor, null, 2)}\n`)),
    semanticSha256: sha256(Buffer.from(JSON.stringify(predecessor))),
  };
}

export async function main(argv = process.argv.slice(2), {
  repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)),
  log = console.log,
  beforePublish = async () => {},
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error("current accessibility transition arguments mismatch");
  const root = path.resolve(repositoryRoot);
  const [candidateBytes, previousBytes, facilityBytes, ledgerBytes, inventoryBytes] = await Promise.all([
    readStableRegular(path.join(root, FILES.candidate), "candidate build spec"),
    readStableRegular(path.join(root, FILES.previous), "previous production station-line input"),
    readStableRegular(path.join(root, FILES.facility), "current FACILITY admission"),
    readStableRegular(path.join(root, FILES.snapshots), "source snapshot ledger"),
    readStableRegular(path.join(root, FILES.inventory), "source inventory"),
  ]);
  const result = buildCurrentCapitalAccessibilityTransition({
    candidate: parse(candidateBytes, "candidate build spec"),
    candidateBytes,
    previous: parse(previousBytes, "previous production station-line input"),
    previousBytes,
    facilityAdmission: parse(facilityBytes, "current FACILITY admission"),
    facilityBytes,
    ledger: parse(ledgerBytes, "source snapshot ledger"),
    ledgerBytes,
    inventory: parse(inventoryBytes, "source inventory"),
    inventoryBytes,
  });
  const boundInputs = [
    { target: path.join(root, FILES.candidate), label: "candidate build spec", bytes: candidateBytes },
    { target: path.join(root, FILES.previous), label: "previous production station-line input", bytes: previousBytes },
    { target: path.join(root, FILES.facility), label: "current FACILITY admission", bytes: facilityBytes },
    { target: path.join(root, FILES.snapshots), label: "source snapshot ledger", bytes: ledgerBytes },
    { target: path.join(root, FILES.inventory), label: "source inventory", bytes: inventoryBytes },
  ];
  await beforePublish();
  await publish(
    path.join(root, FILES.transition),
    Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(result)),
    () => assertBoundInputsUnchanged(boundInputs),
  );
  log(JSON.stringify({ state: result.state, transitionSha256: result.transitionSha256 }));
  return result;
}

function validateTransition(value) {
  assertKeys(value, TOP_LEVEL_KEYS, "current accessibility transition");
  if (value.schemaVersion !== 2 || value.artifactKind !== "current-capital-accessibility-transition" || value.state !== "PENDING_FULL_FAN_IN") {
    throw new Error("current accessibility transition schema mismatch");
  }
  assertKeys(value.nextCandidate, ["path", "sha256", "candidateId", "sourceSnapshotSetHash"], "transition next candidate");
  assertKeys(value.previousCandidate, ["canonicalCandidate", "sha256", "candidateId", "sourceSnapshotSetHash"], "transition previous candidate");
  assertKeys(value.previousProduction, ["path", "sha256", "candidateId", "sourceSnapshotSetHash"], "transition previous production");
  assertKeys(value.facilityAdmission, ["path", "sha256", "admissionDigest", "snapshotId"], "transition FACILITY admission");
  assertKeys(value.pendingPrerequisites, ["exitAdmissionDirectory", "transferSourceId", "fullCapitalInputDirectory", "authorityEdgeCount"], "transition prerequisites");
  const nextCandidateId = requiredString(value.nextCandidate.candidateId, "transition next candidateId");
  const previousCandidateId = requiredString(value.previousCandidate.candidateId, "transition previous candidateId");
  const previousProductionCandidateId = requiredString(value.previousProduction.candidateId, "transition previous production candidateId");
  assertEmbeddedPreviousCandidate(value.previousCandidate.canonicalCandidate);
  if (previousCandidateId === nextCandidateId || previousProductionCandidateId === nextCandidateId) {
    throw new Error("transition candidate identity mismatch");
  }
  if (value.nextCandidate.path !== FILES.candidate || value.previousProduction.path !== FILES.previous || value.facilityAdmission.path !== FILES.facility
    || ![value.nextCandidate.sha256, value.nextCandidate.sourceSnapshotSetHash, value.previousCandidate.sha256, value.previousCandidate.sourceSnapshotSetHash, value.previousProduction.sha256, value.previousProduction.sourceSnapshotSetHash,
      value.facilityAdmission.sha256, value.facilityAdmission.admissionDigest, value.transitionSha256].every((entry) => SHA.test(entry ?? ""))
    || !requiredString(value.facilityAdmission.snapshotId, "transition FACILITY snapshotId")
    || value.previousCandidate.sourceSnapshotSetHash === value.nextCandidate.sourceSnapshotSetHash
    || value.previousCandidate.canonicalCandidate?.candidateId !== previousCandidateId
    || value.previousCandidate.canonicalCandidate?.sourceSnapshotSetHash !== value.previousCandidate.sourceSnapshotSetHash
    || sha256(candidateBytesFor(value.previousCandidate.canonicalCandidate)) !== value.previousCandidate.sha256
    || value.previousProduction.sourceSnapshotSetHash === value.nextCandidate.sourceSnapshotSetHash
    || value.pendingPrerequisites.exitAdmissionDirectory !== "tools/datapack/release/current-exit-admission-v2"
    || value.pendingPrerequisites.transferSourceId !== "seoul-metro-transfer-distance-duration"
    || value.pendingPrerequisites.fullCapitalInputDirectory !== "tools/datapack/release/current-capital-accessibility-full"
    || value.pendingPrerequisites.authorityEdgeCount !== 456) {
    throw new Error("current accessibility transition identity mismatch");
  }
  const { transitionSha256, ...payload } = value;
  if (sha256(Buffer.from(canonicalJson(payload))) !== transitionSha256) throw new Error("current accessibility transition self-hash mismatch");
}

function assertEmbeddedPreviousCandidate(candidate) {
  if (candidate?.schemaVersion !== 1 || candidate.artifactKind !== "datapack-candidate-build-spec"
    || !Array.isArray(candidate.sourceSnapshotIds) || !Array.isArray(candidate.sourceSnapshots)
    || candidate.sourceSnapshotIds.length !== CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS.length
    || candidate.sourceSnapshots.length !== CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS.length
    || new Set(candidate.sourceSnapshotIds).size !== CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS.length
    || JSON.stringify(candidate.sourceSnapshots.map(({ sourceId }) => sourceId)) !== JSON.stringify(CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS)
    || candidate.sourceSnapshots.some((projection, index) => projection?.snapshotId !== candidate.sourceSnapshotIds[index])
    || !SHA.test(candidate.sourceSnapshotSetHash ?? "")
    || !requiredString(candidate.candidateId, "embedded previous candidateId")) {
    throw new Error("transition previous candidate shape mismatch");
  }
}

async function readStableRegular(target, label) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(`${label} cannot enforce O_NOFOLLOW`);
  const beforePath = await lstat(target);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new Error(`${label} is invalid`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.dev !== afterPath.dev || before.ino !== afterPath.ino || bytes.length !== before.size) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertBoundInputsUnchanged(bindings) {
  const currentBytes = await Promise.all(bindings.map(({ target, label }) => readStableRegular(target, label)));
  if (currentBytes.some((bytes, index) => !bytes.equals(bindings[index].bytes))) {
    throw new Error("transition bound input changed");
  }
}

async function publish(output, bytes, assertInputsStable) {
  const parent = path.dirname(output);
  const parentBefore = await lstat(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) throw new Error("transition output parent mismatch");
  try {
    await lstat(output);
    throw new Error("transition output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.current-capital-accessibility-transition-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const parentAfter = await lstat(parent);
    if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()) {
      throw new Error("transition output parent changed");
    }
    try {
      await lstat(output);
      throw new Error("transition output already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await assertInputsStable();
    await link(temporary, output);
    const parentHandle = await open(parent, constants.O_RDONLY);
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    await unlink(temporary);
    const cleanupParentHandle = await open(parent, constants.O_RDONLY);
    try { await cleanupParentHandle.sync(); } finally { await cleanupParentHandle.close(); }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function bindParsed(value, bytes, label) {
  const parsed = parse(bytes, label);
  if (canonicalJson(parsed) !== canonicalJson(value)) throw new Error(`${label} object/bytes mismatch`);
  return parsed;
}
function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
function requiredBytes(value, label) { if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error(`${label} bytes are required`); return Buffer.from(value); }
function requiredString(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value; }
function requiredSha(value, label) { if (!SHA.test(value ?? "")) throw new Error(`${label} is invalid`); return value; }
function assertKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort((left, right) => left.localeCompare(right))) !== canonicalJson([...keys].sort((left, right) => left.localeCompare(right)))) throw new Error(`${label} keys mismatch`); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`current-capital-accessibility-transition: ${error.message}`); process.exitCode = 1; });
}
