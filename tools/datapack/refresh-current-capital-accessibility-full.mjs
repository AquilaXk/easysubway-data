#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCurrentCapitalRouteEdgeInput, canonicalCurrentCapitalRouteEdgeInputJson } from "./build-current-capital-route-edge-input.mjs";
import {
  buildAuthenticatedCurrentCapitalFacilityEvidenceRows,
  buildCurrentCapitalStationLineInput,
  buildValidatedCurrentCapitalTransferEvidenceRows,
  canonicalCurrentCapitalStationLineInputJson,
  readCurrentCapitalInputs,
} from "./build-current-capital-station-line-input.mjs";
import {
  buildCurrentCapitalLiveChainFanInBoundary,
  canonicalCurrentCapitalLiveChainFanInBoundaryJson,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
  readCurrentCapitalLiveChainFanInBoundary,
} from "./build-current-capital-live-chain-boundary.mjs";
import { CURRENT_CAPITAL_LIVE_CHAIN_FIXED_OUTPUT_PATHS } from "./validate-current-capital-live-chain-materialization.mjs";
import { CURRENT_TOPOLOGY_REFRESH_OUTPUTS } from "./activate-current-source-set.mjs";
import { validateCurrentCapitalAccessibilitySourceHandoff } from "./current-capital-accessibility-source-handoff.mjs";
import { readCurrentCapitalAccessibilityTransitionBoundary, readEffectiveCurrentCapitalAccessibilityTransition } from "./current-capital-accessibility-transition.mjs";
import { projectCandidateFixtureForAccessibilityAuthority } from "./build-datapack.mjs";
import { atomicReplace, readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import {
  assertCurrentLiveChainTransferIdentity,
  assertRebuiltCurrentLiveChainTransferCandidateIdentity,
  CURRENT_LIVE_CHAIN_TRANSFER_FIXED_OUTPUTS,
  currentLiveChainTransferOutputPaths,
} from "./rebind-current-live-chain-transfer-derived-identities.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUTPUTS = Object.freeze([
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
]);
const FAN_IN_OUTPUT = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH;
const TRANSACTION_OUTPUTS = Object.freeze([...OUTPUTS, FAN_IN_OUTPUT]);
const JOURNAL = "tools/datapack/.current-capital-accessibility-refresh-transaction.json";
const TERMINAL_JOURNAL = "tools/datapack/.current-capital-terminal-transaction.json";
const LOCK = "tools/datapack/.current-capital-accessibility-refresh.lock";
const LOCK_OWNER = "owner.json";
const CANDIDATE_BUILD_SPEC = "tools/datapack/release/candidate-build-spec.json";
const TRANSITION = "tools/datapack/release/current-capital-accessibility-transition.json";
const SUCCESSOR = "tools/datapack/release/current-capital-accessibility-transition-successor.json";
const ACTIVATED_CURRENT_OUTPUT = "ACTIVATED_CURRENT_OUTPUT";
const PRE_APPROVAL_CURRENT_CANDIDATE = "PRE_APPROVAL_CURRENT_CANDIDATE";
const SEOUL = "seoul-metro-accessibility";
const TRANSFER = "seoul-metro-transfer-distance-duration";
const MOLIT = "molit-urban-rail-full-route";
const PUBLIC_STATIC_NETWORK_V2_SUCCESSOR = "PUBLIC_STATIC_NETWORK_V2_SUCCESSOR_REFRESH";
const sha = (value) => createHash("sha256").update(value).digest("hex");

const TERMINAL_MARKERS = Object.freeze([TRANSITION, SUCCESSOR]);
const TERMINAL_TOPOLOGY_INPUT_PATTERNS = Object.freeze([
  /^tools\/datapack\/sources\/capital-route-topology-[0-9]{8}\.json$/u,
  /^tools\/datapack\/sources\/incheon-transit-station-info-[0-9]{8}\.json$/u,
  /^tools\/datapack\/sources\/incheon-line1-train-timetable-[0-9]{8}\.json$/u,
  /^tools\/datapack\/sources\/incheon-line2-train-timetable-[0-9]{8}\.json$/u,
]);
const TERMINAL_TOPOLOGY_REVERIFICATION = /^tools\/datapack\/release\/capital-topology-reverification-[0-9]{8}\.json$/u;
const TERMINAL_TRANSFER_DESCRIPTOR = /^tools\/datapack\/sources\/seoul-metro-transfer-distance-duration-[0-9]{8}T[0-9]{9}Z\.json$/u;

function target(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("current-capital refresh path is invalid");
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("current-capital refresh path escapes repository");
  return resolved;
}
function exactPathSet(actual, expected, label) {
  if (!Array.isArray(actual) || new Set(actual).size !== actual.length
    || JSON.stringify([...actual].sort(codepointCompare)) !== JSON.stringify([...expected].sort(codepointCompare))) {
    throw new Error(`${label} mismatch`);
  }
}
function terminalTopologyInputs(paths) {
  if (!Array.isArray(paths) || paths.length !== TERMINAL_TOPOLOGY_INPUT_PATTERNS.length
    || new Set(paths).size !== paths.length
    || TERMINAL_TOPOLOGY_INPUT_PATTERNS.some((pattern) => paths.filter((entry) => pattern.test(entry)).length !== 1)) {
    throw new Error("current-capital terminal topology input manifest mismatch");
  }
}
function terminalTopologyOutputs(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length
    || paths.filter((entry) => TERMINAL_TOPOLOGY_REVERIFICATION.test(entry)).length !== 1
    || paths.some((entry) => !CURRENT_TOPOLOGY_REFRESH_OUTPUTS.includes(entry)
      && !TERMINAL_TOPOLOGY_REVERIFICATION.test(entry))) {
    throw new Error("current-capital terminal topology output manifest mismatch");
  }
}
function terminalLiveChainOutputs(paths) {
  if (!Array.isArray(paths) || paths.length !== CURRENT_CAPITAL_LIVE_CHAIN_FIXED_OUTPUT_PATHS.length + 1
    || new Set(paths).size !== paths.length
    || paths.filter((entry) => TERMINAL_TRANSFER_DESCRIPTOR.test(entry)).length !== 1) {
    throw new Error("current-capital terminal live-chain manifest mismatch");
  }
  exactPathSet(paths.filter((entry) => !TERMINAL_TRANSFER_DESCRIPTOR.test(entry)), CURRENT_CAPITAL_LIVE_CHAIN_FIXED_OUTPUT_PATHS,
    "current-capital terminal live-chain manifest");
}
function terminalMaterializationReceipt(receipt, liveChainOutputs, fanInPath) {
  const keys = ["entries", "fanIn", "operationId", "repository", "repositorySha"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || JSON.stringify(Object.keys(receipt).sort(codepointCompare)) !== JSON.stringify(keys)
    || receipt.repository !== "AquilaXk/easysubway-data" || !/^[a-f0-9]{40}$/u.test(receipt.repositorySha ?? "")
    || typeof receipt.operationId !== "string" || !Array.isArray(receipt.entries)
    || !receipt.fanIn || typeof receipt.fanIn !== "object") {
    throw new Error("current-capital terminal materialization receipt mismatch");
  }
  const entries = receipt.entries.map(({ path: relative, sha256: digest }) => ({ relative, digest }));
  if (entries.length !== liveChainOutputs.length || new Set(entries.map(({ relative }) => relative)).size !== entries.length
    || entries.some(({ relative, digest }) => typeof relative !== "string" || !/^[a-f0-9]{64}$/u.test(digest ?? ""))
    || JSON.stringify(entries.map(({ relative }) => relative)) !== JSON.stringify([...liveChainOutputs].sort(codepointCompare))
    || receipt.fanIn.path !== fanInPath || !/^[a-f0-9]{64}$/u.test(receipt.fanIn.sha256 ?? "")) {
    throw new Error("current-capital terminal materialization receipt mismatch");
  }
  return new Map([...entries, { relative: receipt.fanIn.path, digest: receipt.fanIn.sha256 }].map(({ relative, digest }) => [relative, digest]));
}
function terminalVerifierProof(proof) {
  const keys = ["artifactKind", "builderGitSha", "facilityHeadGitSha", "markerState", "replacementPrestates", "retainedOutputs", "schemaVersion", "sourceMainGitSha", "topologyInputs", "topologyOutputs", "transition"];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)
    || JSON.stringify(Object.keys(proof).sort(codepointCompare)) !== JSON.stringify(keys)
    || proof.schemaVersion !== 2 || proof.artifactKind !== "current-capital-terminal-lineage"
    || !["PRESENT", "DERIVED_ABSENT"].includes(proof.markerState)
    || ![proof.sourceMainGitSha, proof.facilityHeadGitSha, proof.builderGitSha].every((value) => /^[a-f0-9]{40}$/u.test(value ?? ""))
    || !proof.transition || ![proof.transition.baseSha256, proof.transition.successorSha256,
      proof.transition.sourceMainCandidateSha256, proof.transition.sourceMainFacilitySha256].every((value) => /^[a-f0-9]{64}$/u.test(value ?? ""))
    || !Array.isArray(proof.retainedOutputs) || !Array.isArray(proof.topologyInputs)
    || !Array.isArray(proof.topologyOutputs) || !Array.isArray(proof.replacementPrestates)) {
    throw new Error("current-capital terminal lineage proof mismatch");
  }
  const retained = new Map(proof.retainedOutputs.map(({ relative, sha256: digest }) => [relative, digest]));
  const inputs = new Map(proof.topologyInputs.map(({ relativePath, sha256: digest }) => [relativePath, digest]));
  const outputs = new Map(proof.topologyOutputs.map(({ relativePath, beforeSha256, generatedSha256 }) => [relativePath, { beforeSha256, generatedSha256 }]));
  const replacementPrestates = new Map(proof.replacementPrestates.map(({ relativePath, sha256: digest }) => [relativePath, digest]));
  if (retained.size !== proof.retainedOutputs.length || inputs.size !== proof.topologyInputs.length
    || outputs.size !== proof.topologyOutputs.length || replacementPrestates.size !== proof.replacementPrestates.length
    || proof.retainedOutputs.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort(codepointCompare)) !== JSON.stringify(["relative", "sha256"]))
    || proof.topologyInputs.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort(codepointCompare)) !== JSON.stringify(["relativePath", "sha256"]))
    || proof.topologyOutputs.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort(codepointCompare)) !== JSON.stringify(["beforeSha256", "generatedSha256", "relativePath"]))
    || proof.replacementPrestates.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || JSON.stringify(Object.keys(entry).sort(codepointCompare)) !== JSON.stringify(["relativePath", "sha256"]))
    || [...retained].some(([relative, digest]) => typeof relative !== "string" || !/^[a-f0-9]{64}$/u.test(digest ?? ""))
    || [...inputs].some(([relative, digest]) => typeof relative !== "string" || !/^[a-f0-9]{64}$/u.test(digest ?? ""))
    || [...outputs].some(([relative, value]) => typeof relative !== "string"
      || (value.beforeSha256 != null && !/^[a-f0-9]{64}$/u.test(value.beforeSha256))
      || !/^[a-f0-9]{64}$/u.test(value.generatedSha256 ?? ""))
    || [...replacementPrestates].some(([relative, digest]) => typeof relative !== "string" || !/^[a-f0-9]{64}$/u.test(digest ?? ""))) {
    throw new Error("current-capital terminal lineage proof mismatch");
  }
  return { markerState: proof.markerState, retained, inputs, outputs, replacementPrestates };
}

/**
 * Validate the only manifest shape permitted to retire the two protected
 * current-capital transition markers.  This is intentionally not a general
 * file transaction API: every class, cardinality, and deletion target is part
 * of the executable #673 contract.
 */
export function validateCurrentCapitalTerminalManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || JSON.stringify(Object.keys(manifest).sort(codepointCompare)) !== JSON.stringify([
      "accessibilitySourceHandoff", "fanInPath", "liveChainOutputs", "markerPaths", "markerState", "materialization", "proof", "replacementPaths", "topologyInputs", "topologyOutputs",
    ])) {
    throw new Error("current-capital terminal manifest mismatch");
  }
  const accessibilitySourceHandoff = validateCurrentCapitalAccessibilitySourceHandoff(manifest.accessibilitySourceHandoff);
  const accessibilityOutputs = new Map(accessibilitySourceHandoff.outputs.map((entry) => [entry.relativePath, entry]));
  terminalTopologyInputs(manifest.topologyInputs);
  terminalTopologyOutputs(manifest.topologyOutputs);
  terminalLiveChainOutputs(manifest.liveChainOutputs);
  const materializationProof = terminalMaterializationReceipt(manifest.materialization, manifest.liveChainOutputs, manifest.fanInPath);
  const proof = terminalVerifierProof(manifest.proof);
  if (manifest.fanInPath !== FAN_IN_OUTPUT) throw new Error("current-capital terminal fan-in manifest mismatch");
  exactPathSet(manifest.markerPaths, TERMINAL_MARKERS, "current-capital terminal marker manifest");
  if (manifest.markerState !== proof.markerState) throw new Error("current-capital terminal marker state mismatch");
  const classPaths = [
    ...accessibilityOutputs.keys(),
    ...manifest.topologyInputs,
    ...manifest.topologyOutputs,
    ...manifest.liveChainOutputs,
    manifest.fanInPath,
  ];
  if (!Array.isArray(manifest.replacementPaths) || new Set(manifest.replacementPaths).size !== manifest.replacementPaths.length
    || JSON.stringify([...manifest.replacementPaths].sort(codepointCompare))
      !== JSON.stringify([...new Set(classPaths)].sort(codepointCompare))) {
    throw new Error("current-capital terminal replacement manifest mismatch");
  }
  exactPathSet(manifest.topologyInputs, [...proof.inputs.keys()], "current-capital terminal verifier topology inputs");
  exactPathSet(manifest.topologyOutputs, [...proof.outputs.keys()], "current-capital terminal verifier topology outputs");
  const createOncePaths = [...manifest.topologyInputs,
    ...manifest.topologyOutputs.filter((relative) => TERMINAL_TOPOLOGY_REVERIFICATION.test(relative)),
    ...[...accessibilityOutputs.values()].filter(({ operation }) => operation === "create").map(({ relativePath }) => relativePath),
  ].sort(codepointCompare);
  const proofReplacementPaths = [...new Set([
    ...manifest.topologyOutputs,
    ...manifest.liveChainOutputs,
    manifest.fanInPath,
  ])].filter((relative) => !createOncePaths.includes(relative));
  exactPathSet(proofReplacementPaths, [...proof.replacementPrestates.keys()], "current-capital terminal replacement prestates");
  for (const output of accessibilityOutputs.values()) {
    const proofPrestate = proof.replacementPrestates.get(output.relativePath);
    if (output.operation === "replace" && proofPrestate != null && proofPrestate !== output.beforeSha256) {
      throw new Error("current-capital terminal accessibility replacement prestate mismatch");
    }
  }
  const replacementPrestatePaths = manifest.replacementPaths.filter((relative) => !createOncePaths.includes(relative));
  if (replacementPrestatePaths.some((relative) => proof.replacementPrestates.get(relative) == null
    && accessibilityOutputs.get(relative)?.beforeSha256 == null)) {
    throw new Error("current-capital terminal replacement prestate mismatch");
  }
  for (const [relative, topology] of proof.outputs) {
    if (createOncePaths.includes(relative)) {
      if (topology.beforeSha256 != null) throw new Error("current-capital terminal topology create-once prestate mismatch");
    } else if (topology.beforeSha256 !== proof.replacementPrestates.get(relative)) {
      throw new Error("current-capital terminal topology replacement prestate mismatch");
    }
  }
  return Object.freeze({
    topologyInputs: Object.freeze([...manifest.topologyInputs]),
    topologyOutputs: Object.freeze([...manifest.topologyOutputs]),
    liveChainOutputs: Object.freeze([...manifest.liveChainOutputs]),
    fanInPath: manifest.fanInPath,
    markerPaths: Object.freeze([...TERMINAL_MARKERS]),
    markerState: manifest.markerState,
    proof: manifest.proof,
    retainedProof: proof.retained,
    topologyInputProof: proof.inputs,
    topologyOutputProof: proof.outputs,
    accessibilitySourceHandoff,
    accessibilityOutputProof: accessibilityOutputs,
    replacementPrestateProof: proof.replacementPrestates,
    materializationProof,
    createOncePaths: Object.freeze(createOncePaths),
    replacements: Object.freeze([...manifest.replacementPaths]),
  });
}
function parse(bytes, label) { try { return JSON.parse(bytes); } catch { throw new Error(`${label} is invalid JSON`); } }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort(codepointCompare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function equalJson(left, right) { return canonical(left) === canonical(right); }
function requireOne(rows, predicate, label) { const matches = rows.filter(predicate); if (matches.length !== 1) throw new Error(`${label} mismatch`); return matches[0]; }
function requireNoLegacyMetadata(value, label) {
  const visit = (current) => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (["projectionMigration", "migration", "historicalPredecessorAudit", "rootSupersession"].includes(key)) {
        throw new Error(`${label} legacy metadata mismatch`);
      }
      visit(child);
    }
  };
  visit(value);
}

function requireCurrentPublicV2Head(selected, ledger, sourceId) {
  const head = requireOne(selected, ({ sourceId: actual }) => actual === sourceId, `current ${sourceId} head`);
  const previousSnapshotId = head?.previousSnapshotId;
  const observation = head?.publicStaticNetworkV2Observation;
  requireNoLegacyMetadata(head, `current ${sourceId} head`);
  if (observation?.schemaVersion !== 2
    || observation.artifactKind !== "public-static-network-v2-observation"
    || observation.sourceId !== sourceId
    || observation.snapshotId !== head.snapshotId
    || typeof previousSnapshotId !== "string"
    || previousSnapshotId === head.snapshotId
    || ledger.filter(({ snapshotId, sourceId: actual }) =>
      snapshotId === previousSnapshotId && actual === sourceId).length !== 1) {
    throw new Error(`current ${sourceId} v2 predecessor mismatch`);
  }
  return { head, previousSnapshotId };
}

function validateCurrentCandidateSourceSet({ candidate, inventory, inventoryFile }) {
  const inventorySources = inventory?.sources;
  const requiredSourceIds = Array.isArray(inventorySources)
    ? inventorySources.filter(({ requiredForProductionPack }) => requiredForProductionPack === true).map(({ id }) => id)
    : [];
  const candidateSourceIds = Array.isArray(candidate.sourceSnapshots)
    ? candidate.sourceSnapshots.map(({ sourceId }) => sourceId)
    : [];
  const transferIndex = candidateSourceIds.indexOf(TRANSFER);
  if (!Array.isArray(candidate.sourceSnapshotIds) || !Array.isArray(candidate.sourceSnapshots)
    || candidate.sourceSnapshotIds.length === 0 || candidate.sourceSnapshotIds.length !== candidate.sourceSnapshots.length
    || !Array.isArray(inventorySources) || requiredSourceIds.length === 0
    || inventorySources.some(({ id }) => typeof id !== "string" || id.length === 0)
    || new Set(inventorySources.map(({ id }) => id)).size !== inventorySources.length
    || candidateSourceIds.some((sourceId) => typeof sourceId !== "string" || sourceId.length === 0)
    || new Set(candidate.sourceSnapshotIds).size !== candidate.sourceSnapshotIds.length
    || new Set(candidateSourceIds).size !== candidateSourceIds.length
    || requiredSourceIds.length !== candidateSourceIds.length
    || requiredSourceIds.some((sourceId) => !candidateSourceIds.includes(sourceId))
    || transferIndex !== candidateSourceIds.length - 1
    || candidate.sourceInventorySha256 !== sha(JSON.stringify(inventory))
    || candidate.networkEdgeEvidence?.sourceInventory?.path !== "tools/datapack/source-inventory.json"
    || candidate.networkEdgeEvidence.sourceInventory.sha256 !== sha(inventoryFile.bytes)) {
    throw new Error("current candidate source-set mismatch");
  }
}

function deriveRefreshSourceProof({ candidate, ledger }) {
  const selected = candidate.sourceSnapshotIds.map((snapshotId, index) => {
    const row = requireOne(ledger, (entry) => entry?.snapshotId === snapshotId, "current candidate ledger");
    if (row.sourceId !== candidate.sourceSnapshots[index]?.sourceId) throw new Error("current candidate source identity mismatch");
    return row;
  });
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  const selectedLedgerOrder = ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  if (selectedLedgerOrder.length !== candidate.sourceSnapshotIds.length
    || sha(JSON.stringify(selectedLedgerOrder)) !== candidate.sourceSnapshotSetHash) throw new Error("current candidate source-set mismatch");
  const position = requireCurrentPublicV2Head(selected, ledger, "seoul-metro-route-map-positions");
  const molit = requireCurrentPublicV2Head(selected, ledger, MOLIT);
  const positionIndex = selected.indexOf(position.head);
  const molitIndex = selected.indexOf(molit.head);
  if (positionIndex < 0 || molitIndex < 0 || positionIndex === molitIndex) {
    throw new Error("current public static-network selected head mismatch");
  }
  const currentSeoul = requireOne(selected, ({ sourceId }) => sourceId === SEOUL, "current Seoul head");
  const previousSeoulSnapshotId = currentSeoul?.previousSnapshotId;
  if (typeof previousSeoulSnapshotId !== "string"
    || previousSeoulSnapshotId === currentSeoul.snapshotId
    || ledger.filter(({ snapshotId, sourceId }) =>
      snapshotId === previousSeoulSnapshotId && sourceId === SEOUL).length !== 1) {
    throw new Error("current Seoul evidence predecessor mismatch");
  }
  const predecessorProjections = candidate.sourceSnapshots.map((projection, index) => ({
    projection,
    index,
    snapshotId: candidate.sourceSnapshotIds[index],
  })).filter(({ projection }) => projection.sourceId !== TRANSFER);
  const terminalPredecessorIds = new Set(predecessorProjections.map(({ snapshotId }) => snapshotId));
  const terminalPredecessor = ledger.filter(({ snapshotId }) => terminalPredecessorIds.has(snapshotId));
  if (terminalPredecessorIds.size !== predecessorProjections.length
    || terminalPredecessor.length !== predecessorProjections.length) {
    throw new Error("current accessibility terminal predecessor mismatch");
  }
  const predecessorIds = predecessorProjections.map(({ snapshotId, index }) => {
    if (index === positionIndex) return position.previousSnapshotId;
    if (index === molitIndex) return molit.previousSnapshotId;
    return snapshotId;
  });
  const predecessorIdSet = new Set(predecessorIds);
  const predecessor = ledger.filter(({ snapshotId }) => predecessorIdSet.has(snapshotId));
  const evidenceIds = new Set(predecessorIds.map((snapshotId, index) => {
    const sourceId = predecessorProjections[index].projection.sourceId;
    return sourceId === SEOUL ? previousSeoulSnapshotId : snapshotId;
  }));
  const evidence = ledger.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  return {
    evidenceHash: sha(JSON.stringify(evidence)),
    molitPreviousSnapshotId: molit.previousSnapshotId,
    positionPreviousSnapshotId: position.previousSnapshotId,
    predecessorComplete: predecessorIdSet.size === predecessorProjections.length
      && predecessor.length === predecessorProjections.length
      && evidenceIds.size === predecessorProjections.length
      && evidence.length === predecessorProjections.length,
    predecessorHash: sha(JSON.stringify(predecessor)),
    terminalPredecessorHash: sha(JSON.stringify(terminalPredecessor)),
  };
}

function buildRefreshProof({ phase, candidateFile, inventoryFile, ledgerFile, requestFile, hashesFile, facilityFile, exitFile, stationFile, routeFile }) {
  const candidate = parse(candidateFile.bytes, "current candidate"); const inventory = parse(inventoryFile.bytes, "source inventory"); const ledger = parse(ledgerFile.bytes, "source snapshot ledger");
  const station = parse(stationFile.bytes, "activated station input"); const route = parse(routeFile.bytes, "activated route input");
  validateCurrentCandidateSourceSet({ candidate, inventory, inventoryFile });
  if (phase === ACTIVATED_CURRENT_OUTPUT) {
    const request = parse(requestFile.bytes, "release request"); const hashes = parse(hashesFile.bytes, "hash evidence");
    if (candidate.sourceSnapshotSetHash !== request.sourceSnapshotSetHash
      || candidate.sourceSnapshotSetHash !== hashes.sourceSnapshotSetHash?.value) {
      throw new Error("current candidate/request/hash binding mismatch");
    }
  }
  const {
    evidenceHash,
    molitPreviousSnapshotId,
    positionPreviousSnapshotId,
    predecessorComplete,
    predecessorHash,
    terminalPredecessorHash,
  } = deriveRefreshSourceProof({ candidate, ledger });
  const transitionIdentity = { kind: PUBLIC_STATIC_NETWORK_V2_SUCCESSOR };
  const activatedSourceSet = station.candidate?.sourceSetSha256;
  if (phase === ACTIVATED_CURRENT_OUTPUT || phase === PRE_APPROVAL_CURRENT_CANDIDATE) {
    const facility = parse(facilityFile.bytes, "FACILITY admission");
    const exit = parse(exitFile.bytes, "EXIT admission");
    const outputsCurrent = activatedSourceSet === candidate.sourceSnapshotSetHash
      && activatedSourceSet === route.candidate?.sourceSetSha256
      && station.candidate?.candidateId === candidate.candidateId
      && route.candidate?.candidateId === candidate.candidateId;
    const facilityCurrent = facility.candidate?.candidateId === candidate.candidateId
      && facility.candidate?.sourceSnapshotSetHash === candidate.sourceSnapshotSetHash;
    const exitTerminal = exit.candidate?.candidateId === candidate.candidateId
      && exit.candidate?.sourceSetSha256 === terminalPredecessorHash;
    if (outputsCurrent && facilityCurrent && exitTerminal) return { alreadyCurrent: true };
    const facilityTransition = facility.candidate?.candidateId === candidate.candidateId
      && facility.candidate?.sourceSnapshotSetHash === evidenceHash;
    const exitTransition = exit.candidate?.candidateId === candidate.candidateId
      && exit.candidate?.sourceSetSha256 === evidenceHash;
    if (!facilityTransition || !exitTransition) {
      throw new Error("activated producer boundary mismatch");
    }
  }
  if (!predecessorComplete || activatedSourceSet !== route.candidate?.sourceSetSha256
    || ![predecessorHash, candidate.sourceSnapshotSetHash].includes(activatedSourceSet)
    || station.candidate?.candidateId !== candidate.candidateId || route.candidate?.candidateId !== candidate.candidateId) {
    throw new Error("activated predecessor source-set mismatch");
  }
  return {
    currentCandidateBytesSha256: sha(candidateFile.bytes), currentCandidateSourceSetSha256: candidate.sourceSnapshotSetHash,
    evidenceSourceSetSha256: evidenceHash, facilityAdmissionBytesSha256: null,
    ...transitionIdentity,
    predecessorCandidateSourceSetSha256: predecessorHash,
    positionPreviousSnapshotId,
    molitPreviousSnapshotId,
  };
}

function requirePhase(phase) {
  if (![ACTIVATED_CURRENT_OUTPUT, PRE_APPROVAL_CURRENT_CANDIDATE].includes(phase)) {
    throw new Error("current-capital refresh phase mismatch");
  }
}

function candidateFixturePath(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || typeof candidate.fixturePath !== "string" || candidate.fixturePath.length === 0) {
    throw new Error("current-capital refresh canonical fixture path mismatch");
  }
  return candidate.fixturePath;
}

async function inputFiles(root, phase) {
  const relatives = [
    CANDIDATE_BUILD_SPEC, "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json",
    "tools/datapack/release/current-capital-facility-source-admission.json",
    "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json", ...OUTPUTS,
  ];
  if (phase === ACTIVATED_CURRENT_OUTPUT) relatives.splice(2, 0, "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json");
  for (const relative of [FAN_IN_OUTPUT, ...Object.values(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS)]) {
    if (!relatives.includes(relative)) relatives.push(relative);
  }
  const files = Object.fromEntries(await Promise.all(relatives.map(async (relative) =>
    [relative, await readStableRegularFile(target(root, relative), relative)])));
  try {
    files[TRANSITION] = await readStableRegularFile(target(root, TRANSITION), TRANSITION);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.cause?.code !== "ENOENT") throw error;
  }
  if (files[TRANSITION]) {
    files[SUCCESSOR] = await readStableRegularFile(target(root, SUCCESSOR), SUCCESSOR);
    const successor = parse(files[SUCCESSOR].bytes, "current-capital refresh transition successor");
    const previousFacilityBytes = Buffer.from(successor?.previousFacilityAdmissionBase64 ?? "", "base64");
    if (!previousFacilityBytes.length
      || previousFacilityBytes.toString("base64") !== successor.previousFacilityAdmissionBase64) {
      throw new Error("current-capital refresh previous FACILITY admission mismatch");
    }
    const previousFacility = parse(previousFacilityBytes, "current-capital refresh previous FACILITY admission");
    const snapshotId = previousFacility?.sourceIdentity?.snapshotId;
    const snapshotPath = previousFacility?.sourceIdentity?.snapshotPath;
    if (snapshotPath !== `tools/datapack/sources/${snapshotId}.json`) {
      throw new Error("current-capital refresh previous FACILITY snapshot path mismatch");
    }
    files[snapshotPath] = await readStableRegularFile(target(root, snapshotPath), snapshotPath);
  }
  if (phase === PRE_APPROVAL_CURRENT_CANDIDATE) {
    const fixturePath = candidateFixturePath(parse(files[CANDIDATE_BUILD_SPEC].bytes, "current candidate"));
    files[fixturePath] = await readStableRegularFile(target(root, fixturePath), fixturePath);
  }
  return files;
}

function fanInComponents(files) {
  return Object.fromEntries(Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(([name, relative]) => {
    const file = files[relative];
    if (!file) throw new Error(`current-capital refresh fan-in component is missing: ${name}`);
    return [name, { bytes: file.bytes, value: parse(file.bytes, `current-capital refresh ${name}`) }];
  }));
}

export function assertPendingMarkerProducerBoundary({ baseMarker, effectiveMarker, candidate, facility, exit, station, route }) {
  const basePrevious = baseMarker?.previousCandidate;
  const next = effectiveMarker?.nextCandidate; const effectivePrevious = effectiveMarker?.previousCandidate;
  if (next?.candidateId == null || next?.sourceSnapshotSetHash == null
    || basePrevious?.candidateId == null || basePrevious?.sourceSnapshotSetHash == null
    || effectivePrevious?.candidateId == null || effectivePrevious?.sourceSnapshotSetHash == null
    || candidate?.candidateId == null || candidate?.sourceSnapshotSetHash == null
    || next.candidateId !== candidate.candidateId
    || facility?.candidate?.candidateId !== candidate.candidateId
    || facility.candidate?.sourceSnapshotSetHash !== candidate.sourceSnapshotSetHash
    || exit?.candidate?.candidateId !== next.candidateId
    || exit.candidate?.sourceSetSha256 !== effectivePrevious.sourceSnapshotSetHash
    || station?.candidate?.candidateId !== basePrevious.candidateId
    || station.candidate?.sourceSetSha256 !== basePrevious.sourceSnapshotSetHash
    || route?.candidate?.candidateId !== basePrevious.candidateId
    || route.candidate?.sourceSetSha256 !== basePrevious.sourceSnapshotSetHash) {
    throw new Error("current-capital refresh pending marker producer boundary mismatch");
  }
}

function assertNarrowDelta({
  stationBefore,
  routeBefore,
  stationAfter,
  routeAfter,
  allowCandidateIdentityTransition = false,
  expectedExitEvidenceRows = null,
  expectedBeforeFacilityRows = null,
  expectedAfterFacilityRows = null,
  expectedBeforeTransferRows = null,
  expectedAfterTransferRows = null,
}) {
  if (!equalJson(stationBefore.stationLines, stationAfter.stationLines)
    || !equalJson(routeBefore.stationLines, routeAfter.stationLines)
    || !equalJson(routeBefore.routeEdges, routeAfter.routeEdges)) throw new Error("current-capital refresh topology delta mismatch");
  const stripStation = (value) => ({
    ...value,
    candidate: { ...value.candidate, sourceSetSha256: "", ...(allowCandidateIdentityTransition ? { candidateId: "" } : {}) },
    evidenceRows: [],
  });
  const stripRoute = (value) => ({
    ...value,
    candidate: { ...value.candidate, sourceSetSha256: "", ...(allowCandidateIdentityTransition ? { candidateId: "" } : {}) },
  });
  if (!equalJson(stripStation(stationBefore), stripStation(stationAfter)) || !equalJson(stripRoute(routeBefore), stripRoute(routeAfter))) {
    throw new Error("current-capital refresh evidence delta mismatch");
  }
  const exactFacilityTransition = expectedBeforeFacilityRows !== null || expectedAfterFacilityRows !== null;
  if (exactFacilityTransition) {
    assertExactCurrentCapitalFacilityEvidenceTransition({
      beforeRows: stationBefore.evidenceRows.filter(({ domain }) => domain === "FACILITY"),
      afterRows: stationAfter.evidenceRows.filter(({ domain }) => domain === "FACILITY"),
      expectedBeforeRows: expectedBeforeFacilityRows,
      expectedAfterRows: expectedAfterFacilityRows,
    });
  }
  const exactTransferTransition = expectedBeforeTransferRows !== null || expectedAfterTransferRows !== null;
  if (exactTransferTransition) {
    assertExactCurrentCapitalTransferEvidenceTransition({
      beforeRows: stationBefore.evidenceRows.filter(({ domain }) => domain === "TRANSFER"),
      afterRows: stationAfter.evidenceRows.filter(({ domain }) => domain === "TRANSFER"),
      expectedBeforeRows: expectedBeforeTransferRows,
      expectedAfterRows: expectedAfterTransferRows,
    });
  }
  if (stationBefore.evidenceRows.length !== stationAfter.evidenceRows.length) throw new Error("current-capital refresh evidence delta mismatch");
  for (const [index, before] of stationBefore.evidenceRows.entries()) {
    assertEvidenceDelta(before, stationAfter.evidenceRows[index], allowCandidateIdentityTransition, expectedExitEvidenceRows, exactFacilityTransition, exactTransferTransition);
  }
}

export function assertExactCurrentCapitalFacilityEvidenceTransition({
  beforeRows,
  afterRows,
  expectedBeforeRows,
  expectedAfterRows,
}) {
  if (![beforeRows, afterRows, expectedBeforeRows, expectedAfterRows].every((rows) =>
    Array.isArray(rows) && rows.length > 0 && rows.every(({ domain }) => domain === "FACILITY"))
    || !equalJson(beforeRows, expectedBeforeRows)
    || !equalJson(afterRows, expectedAfterRows)) {
    throw new Error("current-capital refresh FACILITY evidence projection mismatch");
  }
}

export function assertExactCurrentCapitalTransferEvidenceTransition({
  beforeRows,
  afterRows,
  expectedBeforeRows,
  expectedAfterRows,
}) {
  if (![beforeRows, afterRows, expectedBeforeRows, expectedAfterRows].every((rows) =>
    Array.isArray(rows) && rows.length > 0 && rows.every(({ domain }) => domain === "TRANSFER")
      && new Set(rows.map(({ stationId, lineId }) => `${stationId}\0${lineId}`)).size === rows.length)
    || !equalJson(beforeRows, expectedBeforeRows)
    || !equalJson(afterRows, expectedAfterRows)) {
    throw new Error("current-capital refresh TRANSFER evidence projection mismatch");
  }
}

async function buildAuthenticatedCurrentCapitalTransferEvidenceTransition({
  repositoryRoot,
  outputs,
  beforeStation,
  afterStation,
}) {
  if (!Array.isArray(outputs)) throw new Error("current-capital refresh TRANSFER rebind outputs mismatch");
  const descriptorOutputs = outputs.filter(({ relative } = {}) =>
    typeof relative === "string" && !CURRENT_LIVE_CHAIN_TRANSFER_FIXED_OUTPUTS.includes(relative));
  if (descriptorOutputs.length !== 1) throw new Error("current-capital refresh TRANSFER rebind outputs mismatch");
  const expectedPaths = currentLiveChainTransferOutputPaths(descriptorOutputs[0].relative);
  if (outputs.length !== expectedPaths.length
    || JSON.stringify(outputs.map(({ relative }) => relative)) !== JSON.stringify(expectedPaths)
    || outputs.some((output) => !output || typeof output !== "object" || Array.isArray(output)
      || JSON.stringify(Object.keys(output).sort(codepointCompare)) !== JSON.stringify(["bytes", "prestate", "relative"])
      || !Buffer.isBuffer(output.bytes) || !Buffer.isBuffer(output.prestate))) {
    throw new Error("current-capital refresh TRANSFER rebind outputs mismatch");
  }
  const currentInputs = await Promise.all(outputs.map(async ({ relative, bytes }) => {
    const current = await readStableRegularFile(target(repositoryRoot, relative), `current TRANSFER rebind ${relative}`);
    if (!current.bytes.equals(bytes)) throw new Error("current-capital refresh TRANSFER rebind output drift");
    return current;
  }));
  const byPath = new Map(outputs.map((output) => [output.relative, output]));
  const rows = (side, station) => {
    const bytes = (relative) => byPath.get(relative)[side];
    const candidateBytes = bytes("tools/datapack/release/candidate-build-spec.json");
    const inventoryBytes = bytes("tools/datapack/source-inventory.json");
    const snapshotsBytes = bytes("tools/datapack/release/source-snapshots.json");
    const candidate = parse(candidateBytes, `current-capital refresh ${side} TRANSFER candidate`);
    const inventory = parse(inventoryBytes, `current-capital refresh ${side} TRANSFER inventory`);
    const snapshots = parse(snapshotsBytes, `current-capital refresh ${side} TRANSFER snapshots`);
    const descriptorBytes = bytes(descriptorOutputs[0].relative);
    const descriptor = parse(descriptorBytes, `current-capital refresh ${side} TRANSFER descriptor`);
    const transferProjection = candidate.sourceSnapshots?.find(({ sourceId }) => sourceId === TRANSFER);
    const selected = snapshots.find(({ snapshotId, sourceId }) =>
      snapshotId === transferProjection?.snapshotId && sourceId === TRANSFER);
    assertRebuiltCurrentLiveChainTransferCandidateIdentity(candidate, candidate, snapshots);
    if (candidate.sourceInventorySha256 !== sha(JSON.stringify(inventory))
      || candidate.networkEdgeEvidence?.sourceInventory?.path !== "tools/datapack/source-inventory.json"
      || candidate.networkEdgeEvidence.sourceInventory.sha256 !== sha(inventoryBytes)) {
      throw new Error("current-capital refresh TRANSFER inventory binding mismatch");
    }
    assertCurrentLiveChainTransferIdentity(
      candidate,
      inventory,
      snapshots,
      descriptor,
      descriptorBytes,
      selected?.rawReceipt,
    );
    return buildValidatedCurrentCapitalTransferEvidenceRows({
      transferMetrics: parse(bytes("tools/datapack/release/current-transfer-topology-metrics.json"), `current-capital refresh ${side} TRANSFER metrics`),
      transferApplicability: parse(bytes("tools/datapack/release/current-capital-transfer-topology-applicability.json"), `current-capital refresh ${side} TRANSFER applicability`),
      sourceInventory: inventory,
      stationLines: station.stationLines,
      candidate: station.candidate,
    });
  };
  return {
    beforeRows: rows("prestate", beforeStation),
    afterRows: rows("bytes", afterStation),
    inputs: currentInputs,
  };
}

function assertEvidenceDelta(before, after, allowCandidateIdentityTransition, expectedExitEvidenceRows, exactFacilityTransition, exactTransferTransition) {
  const domain = before?.domain;
  if (domain !== after?.domain) throw new Error("current-capital refresh evidence delta mismatch");
  if (exactFacilityTransition && domain === "FACILITY") return;
  if (exactTransferTransition && domain === "TRANSFER") return;
  if (allowCandidateIdentityTransition && domain === "EXIT") {
    const identity = `${after.stationId}\0${after.lineId}`;
    const expected = expectedExitEvidenceRows?.get(identity);
    if (!expected || before.stationId !== after.stationId || before.lineId !== after.lineId
      || before.operatorId !== after.operatorId || !equalJson(expected, after)) {
      throw new Error("current-capital refresh EXIT evidence projection mismatch");
    }
    return;
  }
  const allowed = new Set(["sourceSetSha256"]);
  if (allowCandidateIdentityTransition) allowed.add("candidateId");
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (!allowed.has(key) && !equalJson(before?.[key], after?.[key])) {
      throw new Error(`current-capital refresh evidence delta mismatch: ${domain}.${key}`);
    }
  }
}

export async function buildCurrentCapitalAccessibilityRefreshOutputs({
  repositoryRoot = ROOT,
  phase = ACTIVATED_CURRENT_OUTPUT,
  candidateBuildSpec = undefined,
  canonicalPack = undefined,
  transferRebindOutputs = undefined,
} = {}) {
  requirePhase(phase);
  const root = path.resolve(repositoryRoot); const files = await inputFiles(root, phase);
  const marker = files[TRANSITION]; const effectiveMarker = files[SUCCESSOR];
  const baseMarker = marker ? parse(marker.bytes, "current-capital refresh base transition marker") : null;
  const effectiveMarkerValue = effectiveMarker ? parse(effectiveMarker.bytes, "current-capital refresh effective transition marker") : null;
  const stationBefore = parse(files[OUTPUTS[0]].bytes, "activated station input");
  const routeBefore = parse(files[OUTPUTS[1]].bytes, "activated route input");
  const proof = marker ? { alreadyCurrent: false } : buildRefreshProof({ phase, candidateFile: files[CANDIDATE_BUILD_SPEC], inventoryFile: files["tools/datapack/source-inventory.json"], ledgerFile: files["tools/datapack/release/source-snapshots.json"], requestFile: files["tools/datapack/release/release-request.json"], hashesFile: files["tools/datapack/release/hash-evidence.json"], facilityFile: files["tools/datapack/release/current-capital-facility-source-admission.json"], exitFile: files["tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json"], stationFile: files[OUTPUTS[0]], routeFile: files[OUTPUTS[1]] });
  const { alreadyCurrent, ...transition } = proof;
  if (marker) {
    await readCurrentCapitalAccessibilityTransitionBoundary({ repositoryRoot: root });
    await readEffectiveCurrentCapitalAccessibilityTransition({ repositoryRoot: root });
    const currentMarker = await readStableRegularFile(target(root, TRANSITION), TRANSITION);
    if (!currentMarker.bytes.equals(marker.bytes)) throw new Error("current-capital refresh transition marker changed during validation");
    const currentSuccessor = await readStableRegularFile(target(root, SUCCESSOR), SUCCESSOR);
    if (!currentSuccessor.bytes.equals(files[SUCCESSOR].bytes)) throw new Error("current-capital refresh transition successor changed during validation");
    assertPendingMarkerProducerBoundary({
      baseMarker,
      effectiveMarker: effectiveMarkerValue,
      candidate: parse(files[CANDIDATE_BUILD_SPEC].bytes, "current candidate"),
      facility: parse(files["tools/datapack/release/current-capital-facility-source-admission.json"].bytes, "FACILITY admission"),
      exit: parse(files["tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json"].bytes, "EXIT admission"),
      station: stationBefore,
      route: routeBefore,
    });
  }
  const input = await readCurrentCapitalInputs(root, marker
    ? undefined
    : alreadyCurrent
      ? { readCurrentFanInBoundaryImpl: readCurrentCapitalLiveChainFanInBoundary }
      : { readTransitionBoundaryImpl: async () => ({ ...transition, facilityAdmissionBytesSha256: sha(files["tools/datapack/release/current-capital-facility-source-admission.json"].bytes) }) });
  const hasOverride = candidateBuildSpec !== undefined || canonicalPack !== undefined;
  if (phase === ACTIVATED_CURRENT_OUTPUT && hasOverride) {
    throw new Error("current-capital refresh activated override mismatch");
  }
  if (phase === PRE_APPROVAL_CURRENT_CANDIDATE && (!candidateBuildSpec || typeof candidateBuildSpec !== "object"
    || !canonicalPack || typeof canonicalPack !== "object")) {
    throw new Error("current-capital refresh per-run input mismatch");
  }
  if (phase === PRE_APPROVAL_CURRENT_CANDIDATE) {
    const trackedCandidate = parse(files[CANDIDATE_BUILD_SPEC].bytes, "current candidate");
    const fixturePath = candidateFixturePath(trackedCandidate);
    const trackedCanonicalPack = parse(files[fixturePath].bytes, "current canonical fixture");
    if (!equalJson(candidateBuildSpec, trackedCandidate) || !equalJson(input.candidateBuildSpec, trackedCandidate)) {
      throw new Error("current-capital refresh candidate override mismatch");
    }
    if (!equalJson(canonicalPack, trackedCanonicalPack) || !equalJson(input.canonicalPack, trackedCanonicalPack)) {
      throw new Error("current-capital refresh canonical override mismatch");
    }
  }
  const selectedInput = phase === PRE_APPROVAL_CURRENT_CANDIDATE ? { ...input, candidateBuildSpec, canonicalPack } : input;
  const projected = await projectCandidateFixtureForAccessibilityAuthority({
    buildSpec: selectedInput.candidateBuildSpec,
    sourceFixture: selectedInput.canonicalPack,
    repositoryRoot: root,
  });
  const refreshed = { ...selectedInput, canonicalPack: projected };
  const stationBytes = Buffer.from(canonicalCurrentCapitalStationLineInputJson(buildCurrentCapitalStationLineInput(refreshed)));
  const routeBytes = Buffer.from(canonicalCurrentCapitalRouteEdgeInputJson(buildCurrentCapitalRouteEdgeInput(refreshed)));
  const fanInBytes = Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson(
    buildCurrentCapitalLiveChainFanInBoundary(fanInComponents(files)),
  ));
  const stationAfter = parse(stationBytes, "refreshed station input"); const routeAfter = parse(routeBytes, "refreshed route input");
  if (alreadyCurrent && (!stationBytes.equals(files[OUTPUTS[0]].bytes)
    || !routeBytes.equals(files[OUTPUTS[1]].bytes)
    || !fanInBytes.equals(files[FAN_IN_OUTPUT].bytes))) throw new Error("current-capital refresh current output bytes mismatch");
  const expectedExitEvidenceRows = marker ? new Map(selectedInput.exitAdmission.materializerEvidenceRows.map((row) => [
    `${row.stationId}\0${row.lineId}`,
    {
      ...row,
      candidateId: selectedInput.candidateBuildSpec.candidateId,
      stationSetSha256: selectedInput.exitAdmission.candidate.stationSetSha256,
      sourceSetSha256: selectedInput.candidateBuildSpec.sourceSnapshotSetHash,
      mappingContractVersion: selectedInput.exitAdmission.candidate.mappingContractVersion,
      materializerVersion: selectedInput.exitAdmission.candidate.materializerVersion,
    },
  ])) : null;
  if (marker && expectedExitEvidenceRows.size !== selectedInput.exitAdmission.materializerEvidenceRows.length) {
    throw new Error("current-capital refresh EXIT evidence projection mismatch");
  }
  let expectedBeforeFacilityRows = null;
  let expectedAfterFacilityRows = null;
  let expectedBeforeTransferRows = null;
  let expectedAfterTransferRows = null;
  let transferRebindInputs = [];
  if (marker) {
    const previousFacilityBytes = Buffer.from(effectiveMarkerValue.previousFacilityAdmissionBase64, "base64");
    const previousFacility = parse(previousFacilityBytes, "current-capital refresh previous FACILITY admission");
    const previousSnapshot = files[previousFacility.sourceIdentity.snapshotPath];
    if (!previousSnapshot) throw new Error("current-capital refresh previous FACILITY snapshot is missing");
    expectedBeforeFacilityRows = buildAuthenticatedCurrentCapitalFacilityEvidenceRows({
      facilityAdmission: previousFacility,
      facilitySnapshotBytes: previousSnapshot.bytes,
      stationLines: stationBefore.stationLines,
      admissionCandidate: baseMarker.nextCandidate,
      outputCandidate: stationBefore.candidate,
      candidatePublishedAt: Date.parse(baseMarker.previousCandidate.canonicalCandidate?.publishedAt ?? ""),
    });
    expectedAfterFacilityRows = buildAuthenticatedCurrentCapitalFacilityEvidenceRows({
      facilityAdmission: selectedInput.facilityAdmission,
      facilitySnapshotBytes: selectedInput.facilitySnapshotBytes,
      stationLines: stationAfter.stationLines,
      admissionCandidate: effectiveMarkerValue.nextCandidate,
      outputCandidate: stationAfter.candidate,
      candidatePublishedAt: Date.parse(selectedInput.candidateBuildSpec.publishedAt ?? ""),
    });
    if (transferRebindOutputs !== undefined) {
      const transferTransition = await buildAuthenticatedCurrentCapitalTransferEvidenceTransition({
        repositoryRoot: root,
        outputs: transferRebindOutputs,
        beforeStation: stationBefore,
        afterStation: stationAfter,
      });
      expectedBeforeTransferRows = transferTransition.beforeRows;
      expectedAfterTransferRows = transferTransition.afterRows;
      transferRebindInputs = transferTransition.inputs;
    }
  } else if (transferRebindOutputs !== undefined) {
    throw new Error("current-capital refresh TRANSFER evidence transition requires pending markers");
  }
  assertNarrowDelta({
    stationBefore,
    routeBefore,
    stationAfter,
    routeAfter,
    allowCandidateIdentityTransition: Boolean(marker),
    expectedExitEvidenceRows,
    expectedBeforeFacilityRows,
    expectedAfterFacilityRows,
    expectedBeforeTransferRows,
    expectedAfterTransferRows,
  });
  const outputs = OUTPUTS.map((relative, index) => ({
    relative,
    bytes: index === 0 ? stationBytes : routeBytes,
    prestate: files[relative],
    inputs: [...Object.values(files), ...transferRebindInputs],
  }));
  outputs[0].fanIn = { relative: FAN_IN_OUTPUT, bytes: fanInBytes, prestate: files[FAN_IN_OUTPUT], inputs: Object.values(files) };
  return outputs;
}

function validateJournal(value) {
  const deletionPaths = value?.records?.slice(TRANSACTION_OUTPUTS.length).map(({ relative }) => relative);
  if (!value || value.schemaVersion !== 2 || !["PREPARED", "COMMITTED"].includes(value.state) || !Array.isArray(value.records)
    || deletionPaths?.length !== 2
    || JSON.stringify(value.records.slice(0, TRANSACTION_OUTPUTS.length).map(({ relative }) => relative)) !== JSON.stringify(TRANSACTION_OUTPUTS)
    || JSON.stringify(deletionPaths) !== JSON.stringify([TRANSITION, SUCCESSOR])) throw new Error("current-capital refresh recovery required");
  for (const record of value.records.slice(0, 3)) {
    if (record.operation !== "replace" || typeof record.before !== "string" || typeof record.after !== "string"
      || sha(Buffer.from(record.before, "base64")) !== record.beforeSha256 || sha(Buffer.from(record.after, "base64")) !== record.afterSha256) throw new Error("current-capital refresh recovery required");
  }
  for (const marker of value.records.slice(TRANSACTION_OUTPUTS.length)) if (marker.operation !== "delete" || typeof marker.before !== "string" || sha(Buffer.from(marker.before, "base64")) !== marker.beforeSha256) throw new Error("current-capital refresh recovery required");
}
async function writeNewJournal(file, bytes) {
  const parent = path.dirname(file); const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("current-capital refresh journal parent is unsafe");
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncParent(file);
}
async function syncParent(file) {
  const handle = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function recover(root) {
  const journalPath = target(root, JOURNAL); let journalFile;
  try { journalFile = await readStableRegularFile(journalPath, "current-capital refresh journal"); } catch (error) { if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return; throw error; }
  const journal = parse(journalFile.bytes, "current-capital refresh journal"); validateJournal(journal);
  for (const record of journal.records) {
    const file = target(root, record.relative); const before = Buffer.from(record.before, "base64");
    if (record.operation === "delete") {
      if (journal.state === "PREPARED") await restoreDeletedFile(file, before);
      else await deleteExpectedFile(file, before);
      continue;
    }
    const current = await readStableRegularFile(file, "current-capital refresh target"); const after = Buffer.from(record.after, "base64");
    if (journal.state === "PREPARED" && current.bytes.equals(after)) await atomicReplace(file, before, { original: current });
    else if (journal.state === "COMMITTED" && current.bytes.equals(before)) await atomicReplace(file, after, { original: current });
    else if (!(journal.state === "PREPARED" ? current.bytes.equals(before) : current.bytes.equals(after))) throw new Error("current-capital refresh preserves foreign replacement");
  }
  await unlink(journalPath); await syncParent(journalPath);
}
async function readOptionalStable(file, label) {
  try { return await readStableRegularFile(file, label); }
  catch (error) { if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return null; throw error; }
}
async function restoreDeletedFile(file, before) {
  const current = await readOptionalStable(file, "current-capital refresh marker");
  if (current) {
    if (!current.bytes.equals(before)) throw new Error("current-capital refresh preserves foreign replacement");
    return;
  }
  const parent = path.dirname(file); const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("current-capital refresh marker parent is unsafe");
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(before); await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") {
      const raced = await readStableRegularFile(file, "current-capital refresh marker");
      if (raced.bytes.equals(before)) return;
      throw new Error("current-capital refresh preserves foreign replacement");
    }
    throw error;
  } finally { await handle?.close(); }
  await syncParent(file);
}
async function deleteExpectedFile(file, before) {
  const current = await readOptionalStable(file, "current-capital refresh marker");
  if (current == null) return;
  if (!current.bytes.equals(before)) throw new Error("current-capital refresh preserves foreign replacement");
  await unlink(file); await syncParent(file);
}
async function createExpectedFile(file, bytes) {
  const parent = path.dirname(file); const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("current-capital terminal create parent is unsafe");
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes); await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("current-capital terminal create-once target exists");
    throw error;
  } finally { await handle?.close(); }
  await syncParent(file);
}
async function createTerminalOutput(root, manifest, relative, bytes) {
  if (!manifest.createOncePaths.includes(relative)) throw new Error("current-capital terminal create-once class mismatch");
  await createExpectedFile(target(root, relative), bytes);
}
function parseLockLease(bytes) {
  let lease;
  try { lease = JSON.parse(bytes); } catch { throw new Error("current-capital refresh lock lease is invalid"); }
  if (!lease || typeof lease !== "object" || Array.isArray(lease)
    || JSON.stringify(Object.keys(lease).sort(codepointCompare)) !== JSON.stringify(["pid", "schemaVersion", "token"])
    || lease.schemaVersion !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid <= 0
    || typeof lease.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lease.token)) throw new Error("current-capital refresh lock lease is invalid");
  return lease;
}
async function readLockLease(lock) {
  const info = await lstat(lock);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("current-capital refresh lock is unsafe");
  const entries = await readdir(lock);
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER) throw new Error("current-capital refresh lock has foreign contents");
  const ownerPath = path.join(lock, LOCK_OWNER); const owner = await readStableRegularFile(ownerPath, "current-capital refresh lock lease");
  return { ownerPath, bytes: owner.bytes, lease: parseLockLease(owner.bytes) };
}
async function ownerIsDead(lease) {
  try { process.kill(lease.pid, 0); return false; } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw new Error("current-capital refresh lock owner cannot be verified");
  }
}
async function writeLockLease(lock, lease) {
  const ownerPath = path.join(lock, LOCK_OWNER); const bytes = Buffer.from(JSON.stringify(lease));
  const handle = await open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncParent(ownerPath);
  return { ownerPath, bytes };
}
async function reclaimDeadLock(lock) {
  const owner = await readLockLease(lock);
  if (!await ownerIsDead(owner.lease)) throw new Error("current-capital refresh lock is active");
  const current = await readStableRegularFile(owner.ownerPath, "current-capital refresh lock lease");
  if (!current.bytes.equals(owner.bytes)) throw new Error("current-capital refresh lock changed during reclaim");
  await unlink(owner.ownerPath); await syncParent(owner.ownerPath);
  await rmdir(lock); await syncParent(lock);
}
async function acquireLock(root) {
  const file = target(root, LOCK);
  try { await mkdir(file, { mode: 0o700 }); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await reclaimDeadLock(file);
    try { await mkdir(file, { mode: 0o700 }); } catch (retry) { if (retry?.code === "EEXIST") throw new Error("current-capital refresh lock changed during reclaim"); throw retry; }
  }
  const lease = { schemaVersion: 1, token: randomUUID(), pid: process.pid }; const owner = await writeLockLease(file, lease);
  return async () => {
    const current = await readLockLease(file);
    if (!current.bytes.equals(owner.bytes) || current.lease.token !== lease.token) throw new Error("current-capital refresh lock ownership lost");
    await unlink(owner.ownerPath); await syncParent(owner.ownerPath);
    await rmdir(file); await syncParent(file);
  };
}
async function assertInputsStable(inputs) {
  for (const snapshot of inputs) {
    const current = await readStableRegularFile(snapshot.target, "current-capital refresh input");
    if (!current.bytes.equals(snapshot.bytes)) throw new Error("current-capital refresh input changed during refresh");
  }
}
async function commitUnlocked({ root, outputs, marker, successor, failAfter = null, beforeCommit = async () => {} }) {
  await beforeCommit(); await assertInputsStable(outputs.flatMap(({ inputs = [] }) => inputs));
  let prepared = false;
  try {
    for (const output of outputs) {
      const current = await readStableRegularFile(target(root, output.relative), "current-capital refresh target");
      if (!current.bytes.equals(output.prestate.bytes)) throw new Error("current-capital refresh preserves foreign replacement");
    }
    const currentMarker = await readStableRegularFile(target(root, TRANSITION), TRANSITION);
    if (!currentMarker.bytes.equals(marker.bytes)) throw new Error("current-capital refresh preserves foreign replacement");
    const currentSuccessor = await readStableRegularFile(target(root, SUCCESSOR), SUCCESSOR);
    if (!currentSuccessor.bytes.equals(successor.bytes)) throw new Error("current-capital refresh preserves foreign replacement");
    const records = [
      ...outputs.map(({ relative, bytes, prestate }) => ({ operation: "replace", relative, before: prestate.bytes.toString("base64"), beforeSha256: sha(prestate.bytes), after: bytes.toString("base64"), afterSha256: sha(bytes) })),
      { operation: "delete", relative: TRANSITION, before: marker.bytes.toString("base64"), beforeSha256: sha(marker.bytes) },
      { operation: "delete", relative: SUCCESSOR, before: successor.bytes.toString("base64"), beforeSha256: sha(successor.bytes) },
    ];
    const journalPath = target(root, JOURNAL); await writeNewJournal(journalPath, Buffer.from(JSON.stringify({ schemaVersion: 2, state: "PREPARED", records }))); prepared = true;
    for (const [index, output] of outputs.entries()) { await atomicReplace(target(root, output.relative), output.bytes, { original: output.prestate }); if (failAfter === index) throw new Error("injected refresh failure"); }
    for (const output of outputs) {
      const current = await readStableRegularFile(target(root, output.relative), "current-capital refresh final target");
      if (!current.bytes.equals(output.bytes)) throw new Error("current-capital refresh final byte mismatch");
    }
    await deleteExpectedFile(target(root, TRANSITION), marker.bytes); if (failAfter === outputs.length) throw new Error("injected refresh failure");
    await deleteExpectedFile(target(root, SUCCESSOR), successor.bytes);
    const journal = await readStableRegularFile(journalPath, "current-capital refresh journal"); await atomicReplace(journalPath, Buffer.from(JSON.stringify({ schemaVersion: 2, state: "COMMITTED", records })), { original: journal });
    await recover(root); prepared = false;
    for (const output of outputs) {
      const current = await readStableRegularFile(target(root, output.relative), "current-capital refresh final target");
      if (!current.bytes.equals(output.bytes)) throw new Error("current-capital refresh final byte mismatch");
    }
    if (await readOptionalStable(target(root, TRANSITION), TRANSITION) || await readOptionalStable(target(root, SUCCESSOR), SUCCESSOR)) throw new Error("current-capital refresh final marker mismatch");
  } catch (error) { if (prepared) await recover(root); throw error; }
}
async function commitCurrentCapitalAccessibilityRefresh({ repositoryRoot = ROOT, outputs, marker, successor, failAfter = null, beforeCommit = async () => {} } = {}) {
  const root = path.resolve(repositoryRoot);
  if (!Array.isArray(outputs) || JSON.stringify(outputs.map(({ relative }) => relative)) !== JSON.stringify(TRANSACTION_OUTPUTS) || outputs.some(({ bytes, prestate }) => !Buffer.isBuffer(bytes) || !prestate?.bytes)) throw new Error("current-capital refresh output allowlist mismatch");
  if (!marker?.bytes || !Buffer.isBuffer(marker.bytes)) throw new Error("current-capital refresh transition marker is required");
  if (!successor?.bytes || !Buffer.isBuffer(successor.bytes)) throw new Error("current-capital refresh transition successor is required");
  const release = await acquireLock(root);
  try {
    await recover(root);
    await commitUnlocked({ root, outputs, marker, successor, failAfter, beforeCommit });
  } finally { await release(); }
}

function terminalJournalError() { throw new Error("current-capital terminal recovery required"); }
function validateCurrentCapitalTerminalJournal(journal) {
  if (!journal || journal.schemaVersion !== 1 || !["PREPARED", "COMMITTED"].includes(journal.state)
    || !Array.isArray(journal.records)) terminalJournalError();
  const manifest = validateCurrentCapitalTerminalManifest(journal.manifest);
  const markerRecords = manifest.markerState === "PRESENT" ? 2 : 0;
  if (journal.records.length !== manifest.replacements.length + markerRecords
    || JSON.stringify(journal.records.slice(0, manifest.replacements.length).map(({ relative }) => relative))
      !== JSON.stringify(manifest.replacements)
    || (markerRecords !== 0 && JSON.stringify(journal.records.slice(-markerRecords).map(({ relative }) => relative))
      !== JSON.stringify(manifest.markerPaths))) terminalJournalError();
  for (const [index, record] of journal.records.slice(0, manifest.replacements.length).entries()) {
    const create = manifest.createOncePaths.includes(record.relative);
    if (record.operation !== (create ? "create" : "replace") || typeof record.after !== "string"
      || sha(Buffer.from(record.after, "base64")) !== record.afterSha256) terminalJournalError();
    if (create ? record.before !== null || record.beforeSha256 !== null
      : typeof record.before !== "string" || sha(Buffer.from(record.before, "base64")) !== record.beforeSha256) terminalJournalError();
    if (record.relative !== manifest.replacements[index]) terminalJournalError();
  }
  for (const marker of journal.records.slice(manifest.replacements.length)) {
    if (marker.operation !== "delete" || typeof marker.before !== "string"
      || sha(Buffer.from(marker.before, "base64")) !== marker.beforeSha256) terminalJournalError();
  }
  return manifest;
}
async function recoverCurrentCapitalTerminalTransaction(root) {
  const journalPath = target(root, TERMINAL_JOURNAL); let journalFile;
  try { journalFile = await readStableRegularFile(journalPath, "current-capital terminal journal"); }
  catch (error) { if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") return; throw error; }
  const journal = parse(journalFile.bytes, "current-capital terminal journal");
  const manifest = validateCurrentCapitalTerminalJournal(journal);
  if (manifest.markerState === "DERIVED_ABSENT"
    && (await readOptionalStable(target(root, TRANSITION), TRANSITION)
      || await readOptionalStable(target(root, SUCCESSOR), SUCCESSOR))) {
    throw new Error("current-capital terminal marker resurrection");
  }
  for (const record of journal.records) {
    const file = target(root, record.relative);
    if (record.operation === "delete") {
      if (journal.state === "PREPARED") await restoreDeletedFile(file, Buffer.from(record.before, "base64"));
      else await deleteExpectedFile(file, Buffer.from(record.before, "base64"));
      continue;
    }
    const after = Buffer.from(record.after, "base64");
    const current = record.operation === "create"
      ? await readOptionalStable(file, "current-capital terminal target")
      : await readStableRegularFile(file, "current-capital terminal target");
    if (record.operation === "create") {
      if (journal.state === "PREPARED") {
        if (current == null) continue;
        if (!current.bytes.equals(after)) throw new Error("current-capital terminal preserves foreign replacement");
        await unlink(file); await syncParent(file);
      } else if (current == null) await createTerminalOutput(root, validateCurrentCapitalTerminalManifest(journal.manifest), record.relative, after);
      else if (!current.bytes.equals(after)) throw new Error("current-capital terminal preserves foreign replacement");
      continue;
    }
    const before = Buffer.from(record.before, "base64");
    if (journal.state === "PREPARED" && current.bytes.equals(after)) await atomicReplace(file, before, { original: current });
    else if (journal.state === "COMMITTED" && current.bytes.equals(before)) await atomicReplace(file, after, { original: current });
    else if (!(journal.state === "PREPARED" ? current.bytes.equals(before) : current.bytes.equals(after))) {
      throw new Error("current-capital terminal preserves foreign replacement");
    }
  }
  if (manifest.markerState === "DERIVED_ABSENT"
    && (await readOptionalStable(target(root, TRANSITION), TRANSITION)
      || await readOptionalStable(target(root, SUCCESSOR), SUCCESSOR))) {
    throw new Error("current-capital terminal marker resurrection");
  }
  await unlink(journalPath); await syncParent(journalPath);
}

/**
 * Commit the exact #673 terminal manifest.  The caller supplies generated
 * bytes only after the topology/FACILITY/EXIT lineage has been proven in its
 * isolated staging root; this boundary performs no derivation and cannot
 * target paths outside that closed manifest.
 */
export async function commitCurrentCapitalTerminalManifest({
  repositoryRoot = ROOT,
  manifest,
  outputs,
  marker,
  successor,
  beforeCommit = async () => {},
} = {}) {
  const root = path.resolve(repositoryRoot);
  const checkedManifest = validateCurrentCapitalTerminalManifest(manifest);
  if (!Array.isArray(outputs) || JSON.stringify(outputs.map(({ relative }) => relative))
    !== JSON.stringify(checkedManifest.replacements)
    || outputs.some(({ relative, bytes, prestate }) => !Buffer.isBuffer(bytes)
      || (checkedManifest.createOncePaths.includes(relative) ? prestate != null : !prestate?.bytes))) {
    throw new Error("current-capital terminal output manifest mismatch");
  }
  if (!marker?.bytes || !successor?.bytes || !Buffer.isBuffer(marker.bytes) || !Buffer.isBuffer(successor.bytes)) {
    throw new Error("current-capital terminal markers are required");
  }
  if (sha(marker.bytes) !== checkedManifest.proof.transition.baseSha256
    || sha(successor.bytes) !== checkedManifest.proof.transition.successorSha256) {
    throw new Error("current-capital terminal lineage marker mismatch");
  }
  for (const output of outputs) {
    const topology = checkedManifest.topologyOutputProof.get(output.relative);
    const retained = checkedManifest.retainedProof.get(output.relative);
    const input = checkedManifest.topologyInputProof.get(output.relative);
    const materialized = checkedManifest.materializationProof.get(output.relative);
    const accessibility = checkedManifest.accessibilityOutputProof.get(output.relative);
    const expectedAfter = materialized ?? topology?.generatedSha256 ?? input ?? accessibility?.afterSha256 ?? retained;
    const expectedBefore = checkedManifest.replacementPrestateProof.get(output.relative) ?? accessibility?.beforeSha256;
    if (!expectedAfter || sha(output.bytes) !== expectedAfter
      || (checkedManifest.createOncePaths.includes(output.relative)
        ? expectedBefore != null
        : !output.prestate?.bytes || !expectedBefore || sha(output.prestate.bytes) !== expectedBefore)) {
      throw new Error("current-capital terminal verifier output mismatch");
    }
  }
  const release = await acquireLock(root);
  let prepared = false;
  try {
    await recover(root); await recoverCurrentCapitalTerminalTransaction(root);
    await beforeCommit(); await assertInputsStable(outputs.flatMap(({ inputs = [] }) => inputs));
    const authenticatedPrestates = new Map();
    for (const output of outputs) {
      const current = await readOptionalStable(target(root, output.relative), "current-capital terminal target");
      if (checkedManifest.createOncePaths.includes(output.relative)) {
        if (current != null) throw new Error("current-capital terminal create-once target exists");
      } else if (current == null || !current.bytes.equals(output.prestate.bytes)) {
        throw new Error("current-capital terminal preserves foreign replacement");
      } else {
        authenticatedPrestates.set(output.relative, current);
      }
    }
    if (checkedManifest.markerState === "PRESENT") {
      const currentMarker = await readStableRegularFile(target(root, TRANSITION), TRANSITION);
      const currentSuccessor = await readStableRegularFile(target(root, SUCCESSOR), SUCCESSOR);
      if (!currentMarker.bytes.equals(marker.bytes) || !currentSuccessor.bytes.equals(successor.bytes)) {
        throw new Error("current-capital terminal preserves foreign replacement");
      }
    } else if (await readOptionalStable(target(root, TRANSITION), TRANSITION)
      || await readOptionalStable(target(root, SUCCESSOR), SUCCESSOR)) {
      throw new Error("current-capital terminal marker resurrection");
    }
    const records = [
      ...outputs.map(({ relative, bytes, prestate }) => checkedManifest.createOncePaths.includes(relative)
        ? { operation: "create", relative, before: null, beforeSha256: null, after: bytes.toString("base64"), afterSha256: sha(bytes) }
        : { operation: "replace", relative, before: prestate.bytes.toString("base64"), beforeSha256: sha(prestate.bytes), after: bytes.toString("base64"), afterSha256: sha(bytes) }),
      ...(checkedManifest.markerState === "PRESENT" ? [
        { operation: "delete", relative: TRANSITION, before: marker.bytes.toString("base64"), beforeSha256: sha(marker.bytes) },
        { operation: "delete", relative: SUCCESSOR, before: successor.bytes.toString("base64"), beforeSha256: sha(successor.bytes) },
      ] : []),
    ];
    const journalPath = target(root, TERMINAL_JOURNAL);
    const journal = { schemaVersion: 1, state: "PREPARED", manifest, records };
    validateCurrentCapitalTerminalJournal(journal);
    await writeNewJournal(journalPath, Buffer.from(JSON.stringify(journal))); prepared = true;
    for (const output of outputs) {
      const file = target(root, output.relative);
      if (checkedManifest.createOncePaths.includes(output.relative)) await createTerminalOutput(root, checkedManifest, output.relative, output.bytes);
      else await atomicReplace(file, output.bytes, { original: authenticatedPrestates.get(output.relative) });
      const current = await readStableRegularFile(file, "current-capital terminal final target");
      if (!current.bytes.equals(output.bytes)) throw new Error("current-capital terminal final byte mismatch");
    }
    if (checkedManifest.markerState === "PRESENT") {
      await deleteExpectedFile(target(root, TRANSITION), marker.bytes);
      await deleteExpectedFile(target(root, SUCCESSOR), successor.bytes);
    }
    const currentJournal = await readStableRegularFile(journalPath, "current-capital terminal journal");
    await atomicReplace(journalPath, Buffer.from(JSON.stringify({ ...journal, state: "COMMITTED" })), { original: currentJournal });
    await recoverCurrentCapitalTerminalTransaction(root); prepared = false;
    if (await readOptionalStable(target(root, TRANSITION), TRANSITION)
      || await readOptionalStable(target(root, SUCCESSOR), SUCCESSOR)) {
      throw new Error("current-capital terminal final marker mismatch");
    }
  } catch (error) {
    if (prepared) await recoverCurrentCapitalTerminalTransaction(root);
    throw error;
  } finally { await release(); }
}
export async function refreshCurrentCapitalAccessibilityFull({ repositoryRoot = ROOT, beforeCommit = async () => {}, transferRebindOutputs = undefined } = {}) {
  const root = path.resolve(repositoryRoot); const release = await acquireLock(root);
  try {
    await recover(root);
    const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root, transferRebindOutputs });
    await assertInputsStable(outputs.flatMap(({ inputs = [] }) => inputs));
    const marker = outputs[0]?.inputs?.find(({ target: inputTarget }) => inputTarget === target(root, TRANSITION));
    const transactionOutputs = [...outputs, outputs[0].fanIn];
    if (!transactionOutputs.every(({ bytes, prestate }) => bytes.equals(prestate.bytes)) || marker) {
      if (!marker) throw new Error("current-capital refresh transition marker is required");
      const successor = outputs[0]?.inputs?.find(({ target: inputTarget }) => inputTarget === target(root, SUCCESSOR));
      if (!successor) throw new Error("current-capital refresh transition successor is required");
      await commitUnlocked({ root, outputs: transactionOutputs, marker, successor, beforeCommit });
    }
    return { outputs: TRANSACTION_OUTPUTS };
  } finally { await release(); }
}

async function main(argv) { if (argv.length !== 0) throw new Error("current-capital refresh arguments mismatch"); const result = await refreshCurrentCapitalAccessibilityFull(); process.stdout.write(`${JSON.stringify(result)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
