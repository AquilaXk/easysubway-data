#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCurrentCapitalRouteEdgeInput, canonicalCurrentCapitalRouteEdgeInputJson } from "./build-current-capital-route-edge-input.mjs";
import { buildCurrentCapitalStationLineInput, canonicalCurrentCapitalStationLineInputJson, readCurrentCapitalInputs } from "./build-current-capital-station-line-input.mjs";
import {
  buildCurrentCapitalLiveChainFanInBoundary,
  canonicalCurrentCapitalLiveChainFanInBoundaryJson,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS,
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH,
  readCurrentCapitalLiveChainFanInBoundary,
} from "./build-current-capital-live-chain-boundary.mjs";
import { readCurrentCapitalAccessibilityTransitionBoundary, readEffectiveCurrentCapitalAccessibilityTransition } from "./current-capital-accessibility-transition.mjs";
import { projectCandidateFixtureForAccessibilityAuthority } from "./build-datapack.mjs";
import { atomicReplace, readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUTPUTS = Object.freeze([
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
]);
const FAN_IN_OUTPUT = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_PATH;
const TRANSACTION_OUTPUTS = Object.freeze([...OUTPUTS, FAN_IN_OUTPUT]);
const JOURNAL = "tools/datapack/.current-capital-accessibility-refresh-transaction.json";
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
const CURRENT_CAPITAL_SOURCE_ROSTER = Object.freeze([
  "seoul-metro-route-map-positions",
  "kric-subway-timetable",
  SEOUL,
  "kric-station-convenience-standard",
  MOLIT,
  "seoulmetro-station-line-info",
  "incheon-transit-accessibility",
  TRANSFER,
]);
const PREDECESSOR_SOURCE_ROSTER = Object.freeze(CURRENT_CAPITAL_SOURCE_ROSTER.slice(0, -1));
const sha = (value) => createHash("sha256").update(value).digest("hex");

function target(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("current-capital refresh path is invalid");
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("current-capital refresh path escapes repository");
  return resolved;
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

function buildRefreshProof({ phase, candidateFile, ledgerFile, requestFile, hashesFile, facilityFile, exitFile, stationFile, routeFile }) {
  const candidate = parse(candidateFile.bytes, "current candidate"); const ledger = parse(ledgerFile.bytes, "source snapshot ledger");
  const station = parse(stationFile.bytes, "activated station input"); const route = parse(routeFile.bytes, "activated route input");
  if (!Array.isArray(candidate.sourceSnapshotIds) || !Array.isArray(candidate.sourceSnapshots) || candidate.sourceSnapshotIds.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length
    || candidate.sourceSnapshotIds.length !== candidate.sourceSnapshots.length
    || candidate.sourceSnapshots.some(({ sourceId }, index) => sourceId !== CURRENT_CAPITAL_SOURCE_ROSTER[index])) throw new Error("current candidate source-set mismatch");
  if (phase === ACTIVATED_CURRENT_OUTPUT) {
    const request = parse(requestFile.bytes, "release request"); const hashes = parse(hashesFile.bytes, "hash evidence");
    if (candidate.sourceSnapshotSetHash !== request.sourceSnapshotSetHash
      || candidate.sourceSnapshotSetHash !== hashes.sourceSnapshotSetHash?.value) {
      throw new Error("current candidate/request/hash binding mismatch");
    }
  }
  const selected = candidate.sourceSnapshotIds.map((snapshotId, index) => {
    const row = requireOne(ledger, (entry) => entry?.snapshotId === snapshotId, "current candidate ledger");
    if (row.sourceId !== candidate.sourceSnapshots[index]?.sourceId) throw new Error("current candidate source identity mismatch");
    return row;
  });
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  const selectedLedgerOrder = ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  if (selectedIds.size !== CURRENT_CAPITAL_SOURCE_ROSTER.length || selectedLedgerOrder.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length || sha(JSON.stringify(selectedLedgerOrder)) !== candidate.sourceSnapshotSetHash) throw new Error("current candidate source-set mismatch");
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
  const terminalPredecessorIds = new Set(candidate.sourceSnapshotIds.slice(0, -1));
  const terminalPredecessor = ledger.filter(({ snapshotId }) => terminalPredecessorIds.has(snapshotId));
  if (terminalPredecessorIds.size !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1
    || terminalPredecessor.length !== CURRENT_CAPITAL_SOURCE_ROSTER.length - 1) {
    throw new Error("current accessibility terminal predecessor mismatch");
  }
  const terminalPredecessorHash = sha(JSON.stringify(terminalPredecessor));
  const transitionIdentity = { kind: PUBLIC_STATIC_NETWORK_V2_SUCCESSOR };
  const predecessorIds = candidate.sourceSnapshotIds.slice(0, -1).map((snapshotId, index) => {
    if (index === positionIndex) return position.previousSnapshotId;
    if (index === molitIndex) return molit.previousSnapshotId;
    return snapshotId;
  });
  const predecessorIdSet = new Set(predecessorIds); const predecessor = ledger.filter(({ snapshotId }) => predecessorIdSet.has(snapshotId));
  const predecessorHash = sha(JSON.stringify(predecessor));
  const evidenceIds = new Set(predecessorIds.flatMap((snapshotId, index) => {
    const sourceId = candidate.sourceSnapshots[index].sourceId;
    return [sourceId === SEOUL ? previousSeoulSnapshotId : snapshotId];
  }));
  const evidence = ledger.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  const evidenceHash = sha(JSON.stringify(evidence));
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
  if (predecessorIdSet.size !== PREDECESSOR_SOURCE_ROSTER.length || predecessor.length !== PREDECESSOR_SOURCE_ROSTER.length
    || evidenceIds.size !== PREDECESSOR_SOURCE_ROSTER.length || evidence.length !== PREDECESSOR_SOURCE_ROSTER.length
    || activatedSourceSet !== route.candidate?.sourceSetSha256 || ![predecessorHash, candidate.sourceSnapshotSetHash].includes(activatedSourceSet)
    || station.candidate?.candidateId !== candidate.candidateId || route.candidate?.candidateId !== candidate.candidateId) {
    throw new Error("activated predecessor source-set mismatch");
  }
  return {
    currentCandidateBytesSha256: sha(candidateFile.bytes), currentCandidateSourceSetSha256: candidate.sourceSnapshotSetHash,
    evidenceSourceSetSha256: evidenceHash, facilityAdmissionBytesSha256: null,
    ...transitionIdentity,
    predecessorCandidateSourceSetSha256: predecessorHash,
    positionPreviousSnapshotId: position.previousSnapshotId,
    molitPreviousSnapshotId: molit.previousSnapshotId,
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
    CANDIDATE_BUILD_SPEC, "tools/datapack/release/source-snapshots.json",
    "tools/datapack/release/current-capital-facility-source-admission.json",
    "tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json", ...OUTPUTS,
  ];
  if (phase === ACTIVATED_CURRENT_OUTPUT) relatives.splice(2, 0, "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json");
  for (const relative of [FAN_IN_OUTPUT, ...Object.values(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS)]) {
    if (!relatives.includes(relative)) relatives.push(relative);
  }
  const files = Object.fromEntries(await Promise.all(relatives.map(async (relative) =>
    [relative, await readStableRegularFile(target(root, relative), relative)])));
  if (phase === ACTIVATED_CURRENT_OUTPUT) {
    try {
      files[TRANSITION] = await readStableRegularFile(target(root, TRANSITION), TRANSITION);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.cause?.code !== "ENOENT") throw error;
    }
    if (files[TRANSITION]) files[SUCCESSOR] = await readStableRegularFile(target(root, SUCCESSOR), SUCCESSOR);
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

function assertPendingMarkerProducerBoundary({ marker, facility, exit, station, route }) {
  const next = marker?.nextCandidate; const previous = marker?.previousCandidate;
  if (next?.candidateId == null || next?.sourceSnapshotSetHash == null
    || previous?.candidateId == null || previous?.sourceSnapshotSetHash == null
    || facility?.candidate?.candidateId !== next.candidateId
    || facility.candidate?.sourceSnapshotSetHash !== next.sourceSnapshotSetHash
    || exit?.candidate?.candidateId !== next.candidateId
    || exit.candidate?.sourceSetSha256 !== previous.sourceSnapshotSetHash
    || station?.candidate?.candidateId !== previous.candidateId
    || station.candidate?.sourceSetSha256 !== previous.sourceSnapshotSetHash
    || route?.candidate?.candidateId !== previous.candidateId
    || route.candidate?.sourceSetSha256 !== previous.sourceSnapshotSetHash) {
    throw new Error("current-capital refresh pending marker producer boundary mismatch");
  }
}

function assertNarrowDelta({ stationBefore, routeBefore, stationAfter, routeAfter, allowCandidateIdentityTransition = false }) {
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
  if (stationBefore.evidenceRows.length !== stationAfter.evidenceRows.length) throw new Error("current-capital refresh evidence delta mismatch");
  for (const [index, before] of stationBefore.evidenceRows.entries()) {
    assertEvidenceDelta(before, stationAfter.evidenceRows[index], allowCandidateIdentityTransition);
  }
}

function assertEvidenceDelta(before, after, allowCandidateIdentityTransition) {
  const domain = before?.domain;
  if (domain !== after?.domain) throw new Error("current-capital refresh evidence delta mismatch");
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
} = {}) {
  requirePhase(phase);
  const root = path.resolve(repositoryRoot); const files = await inputFiles(root, phase);
  const marker = files[TRANSITION]; const effectiveMarker = files[SUCCESSOR];
  const proof = marker ? { alreadyCurrent: false } : buildRefreshProof({ phase, candidateFile: files[CANDIDATE_BUILD_SPEC], ledgerFile: files["tools/datapack/release/source-snapshots.json"], requestFile: files["tools/datapack/release/release-request.json"], hashesFile: files["tools/datapack/release/hash-evidence.json"], facilityFile: files["tools/datapack/release/current-capital-facility-source-admission.json"], exitFile: files["tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json"], stationFile: files[OUTPUTS[0]], routeFile: files[OUTPUTS[1]] });
  const { alreadyCurrent, ...transition } = proof;
  if (marker) {
    await readCurrentCapitalAccessibilityTransitionBoundary({ repositoryRoot: root });
    await readEffectiveCurrentCapitalAccessibilityTransition({ repositoryRoot: root });
    const currentMarker = await readStableRegularFile(target(root, TRANSITION), TRANSITION);
    if (!currentMarker.bytes.equals(marker.bytes)) throw new Error("current-capital refresh transition marker changed during validation");
    const currentSuccessor = await readStableRegularFile(target(root, SUCCESSOR), SUCCESSOR);
    if (!currentSuccessor.bytes.equals(files[SUCCESSOR].bytes)) throw new Error("current-capital refresh transition successor changed during validation");
    assertPendingMarkerProducerBoundary({
      marker: parse(effectiveMarker.bytes, "current-capital refresh transition marker"),
      facility: parse(files["tools/datapack/release/current-capital-facility-source-admission.json"].bytes, "FACILITY admission"),
      exit: parse(files["tools/datapack/release/current-exit-admission-v2/exit-path-source-admission.json"].bytes, "EXIT admission"),
      station: parse(files[OUTPUTS[0]].bytes, "activated station input"),
      route: parse(files[OUTPUTS[1]].bytes, "activated route input"),
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
  assertNarrowDelta({ stationBefore: parse(files[OUTPUTS[0]].bytes, "activated station input"), routeBefore: parse(files[OUTPUTS[1]].bytes, "activated route input"), stationAfter, routeAfter, allowCandidateIdentityTransition: Boolean(marker) });
  const outputs = OUTPUTS.map((relative, index) => ({ relative, bytes: index === 0 ? stationBytes : routeBytes, prestate: files[relative], inputs: Object.values(files) }));
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
export async function refreshCurrentCapitalAccessibilityFull({ repositoryRoot = ROOT, beforeCommit = async () => {} } = {}) {
  const root = path.resolve(repositoryRoot); const release = await acquireLock(root);
  try {
    await recover(root);
    const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
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
