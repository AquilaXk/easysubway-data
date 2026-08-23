#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCurrentCapitalRouteEdgeInput, canonicalCurrentCapitalRouteEdgeInputJson } from "./build-current-capital-route-edge-input.mjs";
import { buildCurrentCapitalStationLineInput, canonicalCurrentCapitalStationLineInputJson, readCurrentCapitalInputs } from "./build-current-capital-station-line-input.mjs";
import { projectCandidateFixtureForAccessibilityAuthority } from "./build-datapack.mjs";
import { atomicReplace, readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUTPUTS = Object.freeze([
  "tools/datapack/release/current-capital-accessibility-full/station-line-input.json",
  "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json",
]);
const JOURNAL = "tools/datapack/.current-capital-accessibility-refresh-transaction.json";
const LOCK = "tools/datapack/.current-capital-accessibility-refresh.lock";
const LOCK_OWNER = "owner.json";
const SEOUL = "seoul-metro-accessibility";
const TRANSFER = "seoul-metro-transfer-distance-duration";
const STATIC_SUCCESSOR = "STATIC_NETWORK_SUCCESSOR_REFRESH";
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

function buildRefreshProof({ candidateFile, ledgerFile, requestFile, hashesFile, stationFile, routeFile }) {
  const candidate = parse(candidateFile.bytes, "current candidate"); const ledger = parse(ledgerFile.bytes, "source snapshot ledger");
  const request = parse(requestFile.bytes, "release request"); const hashes = parse(hashesFile.bytes, "hash evidence");
  const station = parse(stationFile.bytes, "activated station input"); const route = parse(routeFile.bytes, "activated route input");
  if (!Array.isArray(candidate.sourceSnapshotIds) || !Array.isArray(candidate.sourceSnapshots) || candidate.sourceSnapshotIds.length !== 7
    || candidate.sourceSnapshotIds.length !== candidate.sourceSnapshots.length
    || candidate.sourceSnapshots.at(-1)?.sourceId !== TRANSFER
    || candidate.sourceSnapshotSetHash !== request.sourceSnapshotSetHash
    || candidate.sourceSnapshotSetHash !== hashes.sourceSnapshotSetHash?.value) throw new Error("current candidate/request/hash binding mismatch");
  const selected = candidate.sourceSnapshotIds.map((snapshotId) => requireOne(ledger, (row) => row?.snapshotId === snapshotId, "current candidate ledger"));
  const selectedIds = new Set(candidate.sourceSnapshotIds);
  const selectedLedgerOrder = ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  if (selectedIds.size !== 7 || selectedLedgerOrder.length !== 7 || sha(JSON.stringify(selectedLedgerOrder)) !== candidate.sourceSnapshotSetHash) throw new Error("current candidate source-set mismatch");
  const staticSuccessors = selected.filter(({ projectionMigration }) =>
    projectionMigration?.migrationKind === "CROSS_SOURCE_CANONICAL_REPLACEMENT");
  let successorIndex;
  let previousSnapshotId;
  let transitionIdentity;
  if (staticSuccessors.length === 1) {
    const successor = staticSuccessors[0];
    const migration = successor.projectionMigration;
    successorIndex = selected.indexOf(successor);
    previousSnapshotId = migration.replacedSnapshotId;
    if (successor.sourceId !== migration.sourceId
      || migration.candidateSlotSourceId !== migration.replacedSourceId
      || typeof previousSnapshotId !== "string"
      || previousSnapshotId === successor.snapshotId
      || ledger.filter(({ snapshotId, sourceId }) =>
        snapshotId === previousSnapshotId && sourceId === migration.replacedSourceId).length !== 1) {
      throw new Error("current static-network predecessor mismatch");
    }
    transitionIdentity = {
      kind: STATIC_SUCCESSOR,
      successorSourceId: successor.sourceId,
      predecessorSourceId: migration.replacedSourceId,
    };
  } else {
    const seoulIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === SEOUL);
    if (staticSuccessors.length !== 0
      || seoulIndex < 0
      || candidate.sourceSnapshots.filter(({ sourceId }) => sourceId === SEOUL).length !== 1
      || candidate.sourceSnapshots.at(-1)?.sourceId !== TRANSFER) {
      throw new Error("current successor candidate shape mismatch");
    }
    const currentSeoul = selected[seoulIndex];
    successorIndex = seoulIndex;
    previousSnapshotId = currentSeoul?.previousSnapshotId;
    if (typeof previousSnapshotId !== "string" || previousSnapshotId === currentSeoul.snapshotId) {
      throw new Error("current Seoul predecessor mismatch");
    }
    transitionIdentity = { kind: "SEOUL_ACCESSIBILITY_SUCCESSOR_REFRESH" };
  }
  const predecessorIds = candidate.sourceSnapshotIds.map((snapshotId, index) =>
    index === successorIndex ? previousSnapshotId : snapshotId);
  const predecessorIdSet = new Set(predecessorIds); const predecessor = ledger.filter(({ snapshotId }) => predecessorIdSet.has(snapshotId));
  const predecessorHash = sha(JSON.stringify(predecessor));
  const currentSeoul = selected.filter(({ sourceId }) => sourceId === SEOUL);
  const previousSeoulSnapshotId = currentSeoul[0]?.previousSnapshotId;
  if (currentSeoul.length !== 1
    || typeof previousSeoulSnapshotId !== "string"
    || ledger.filter(({ snapshotId, sourceId }) =>
      snapshotId === previousSeoulSnapshotId && sourceId === SEOUL).length !== 1) {
    throw new Error("current Seoul evidence predecessor mismatch");
  }
  const evidenceIds = new Set(predecessorIds.flatMap((snapshotId, index) => {
    const sourceId = candidate.sourceSnapshots[index].sourceId;
    if (sourceId === TRANSFER) return [];
    return [sourceId === SEOUL ? previousSeoulSnapshotId : snapshotId];
  }));
  const evidence = ledger.filter(({ snapshotId }) => evidenceIds.has(snapshotId));
  const evidenceHash = sha(JSON.stringify(evidence));
  const activatedSourceSet = station.candidate?.sourceSetSha256;
  if (predecessorIdSet.size !== 7 || predecessor.length !== 7
    || evidenceIds.size !== 6 || evidence.length !== 6
    || activatedSourceSet !== route.candidate?.sourceSetSha256 || ![predecessorHash, candidate.sourceSnapshotSetHash].includes(activatedSourceSet)
    || station.candidate?.candidateId !== candidate.candidateId || route.candidate?.candidateId !== candidate.candidateId) {
    throw new Error("activated predecessor source-set mismatch");
  }
  return {
    currentCandidateBytesSha256: sha(candidateFile.bytes), currentCandidateSourceSetSha256: candidate.sourceSnapshotSetHash,
    evidenceSourceSetSha256: evidenceHash, facilityAdmissionBytesSha256: null,
    ...transitionIdentity,
    predecessorCandidateSourceSetSha256: predecessorHash, previousSnapshotId,
    alreadyCurrent: activatedSourceSet === candidate.sourceSnapshotSetHash,
  };
}

async function inputFiles(root) {
  const files = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json", "tools/datapack/release/current-capital-facility-source-admission.json", ...OUTPUTS,
  ].map(async (relative) => [relative, await readStableRegularFile(target(root, relative), relative)]));
  return Object.fromEntries(files);
}

function assertNarrowDelta({ stationBefore, routeBefore, stationAfter, routeAfter }) {
  if (!equalJson(stationBefore.stationLines, stationAfter.stationLines) || !equalJson(routeBefore.stationLines, routeAfter.stationLines)
    || !equalJson(routeBefore.routeEdges, routeAfter.routeEdges)) throw new Error("current-capital refresh topology delta mismatch");
  const stripStation = (value) => ({ ...value, candidate: { ...value.candidate, sourceSetSha256: "" }, evidenceRows: value.evidenceRows.map(({ sourceSetSha256: _ignored, ...row }) => row) });
  if (!equalJson(stripStation(stationBefore), stripStation(stationAfter))) throw new Error("current-capital refresh evidence delta mismatch");
}

export async function buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot = ROOT } = {}) {
  const root = path.resolve(repositoryRoot); const files = await inputFiles(root);
  const proof = buildRefreshProof({ candidateFile: files["tools/datapack/release/candidate-build-spec.json"], ledgerFile: files["tools/datapack/release/source-snapshots.json"], requestFile: files["tools/datapack/release/release-request.json"], hashesFile: files["tools/datapack/release/hash-evidence.json"], stationFile: files[OUTPUTS[0]], routeFile: files[OUTPUTS[1]] });
  const { alreadyCurrent, ...transition } = proof;
  const input = await readCurrentCapitalInputs(root, { readTransitionBoundaryImpl: async () => ({ ...transition, facilityAdmissionBytesSha256: sha(files["tools/datapack/release/current-capital-facility-source-admission.json"].bytes) }) });
  const projected = await projectCandidateFixtureForAccessibilityAuthority({ buildSpec: input.candidateBuildSpec, sourceFixture: input.canonicalPack, repositoryRoot: root });
  const refreshed = { ...input, canonicalPack: projected };
  const stationBytes = Buffer.from(canonicalCurrentCapitalStationLineInputJson(buildCurrentCapitalStationLineInput(refreshed)));
  const routeBytes = Buffer.from(canonicalCurrentCapitalRouteEdgeInputJson(buildCurrentCapitalRouteEdgeInput(refreshed)));
  const stationAfter = parse(stationBytes, "refreshed station input"); const routeAfter = parse(routeBytes, "refreshed route input");
  if (alreadyCurrent && (!stationBytes.equals(files[OUTPUTS[0]].bytes) || !routeBytes.equals(files[OUTPUTS[1]].bytes))) throw new Error("current-capital refresh current output bytes mismatch");
  assertNarrowDelta({ stationBefore: parse(files[OUTPUTS[0]].bytes, "activated station input"), routeBefore: parse(files[OUTPUTS[1]].bytes, "activated route input"), stationAfter, routeAfter });
  return OUTPUTS.map((relative, index) => ({ relative, bytes: index === 0 ? stationBytes : routeBytes, prestate: files[relative], inputs: Object.values(files) }));
}

function validateJournal(value) {
  if (!value || value.schemaVersion !== 1 || !["PREPARED", "COMMITTED"].includes(value.state) || !Array.isArray(value.records) || value.records.length !== 2
    || JSON.stringify(value.records.map(({ relative }) => relative)) !== JSON.stringify(OUTPUTS)) throw new Error("current-capital refresh recovery required");
  for (const record of value.records) {
    if (typeof record.before !== "string" || typeof record.after !== "string" || sha(Buffer.from(record.before, "base64")) !== record.beforeSha256 || sha(Buffer.from(record.after, "base64")) !== record.afterSha256) throw new Error("current-capital refresh recovery required");
  }
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
    const file = target(root, record.relative); const current = await readStableRegularFile(file, "current-capital refresh target");
    const before = Buffer.from(record.before, "base64"); const after = Buffer.from(record.after, "base64");
    if (journal.state === "PREPARED" && current.bytes.equals(after)) await atomicReplace(file, before, { original: current });
    else if (journal.state === "COMMITTED" && current.bytes.equals(before)) await atomicReplace(file, after, { original: current });
    else if (!(journal.state === "PREPARED" ? current.bytes.equals(before) : current.bytes.equals(after))) throw new Error("current-capital refresh preserves foreign replacement");
  }
  await unlink(journalPath); await syncParent(journalPath);
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
async function commitUnlocked({ root, outputs, failAfter = null, beforeCommit = async () => {} }) {
  await beforeCommit(); await assertInputsStable(outputs.flatMap(({ inputs = [] }) => inputs));
  let prepared = false;
  try {
    for (const output of outputs) {
      const current = await readStableRegularFile(target(root, output.relative), "current-capital refresh target");
      if (!current.bytes.equals(output.prestate.bytes)) throw new Error("current-capital refresh preserves foreign replacement");
    }
    const records = outputs.map(({ relative, bytes, prestate }) => ({ relative, before: prestate.bytes.toString("base64"), beforeSha256: sha(prestate.bytes), after: bytes.toString("base64"), afterSha256: sha(bytes) }));
    const journalPath = target(root, JOURNAL); await writeNewJournal(journalPath, Buffer.from(JSON.stringify({ schemaVersion: 1, state: "PREPARED", records }))); prepared = true;
    for (const [index, output] of outputs.entries()) { await atomicReplace(target(root, output.relative), output.bytes, { original: output.prestate }); if (failAfter === index) throw new Error("injected refresh failure"); }
    const journal = await readStableRegularFile(journalPath, "current-capital refresh journal"); await atomicReplace(journalPath, Buffer.from(JSON.stringify({ schemaVersion: 1, state: "COMMITTED", records })), { original: journal });
    await recover(root); prepared = false;
    for (const output of outputs) {
      const current = await readStableRegularFile(target(root, output.relative), "current-capital refresh final target");
      if (!current.bytes.equals(output.bytes)) throw new Error("current-capital refresh final byte mismatch");
    }
  } catch (error) { if (prepared) await recover(root); throw error; }
}
export async function commitCurrentCapitalAccessibilityRefresh({ repositoryRoot = ROOT, outputs, failAfter = null, beforeCommit = async () => {} } = {}) {
  const root = path.resolve(repositoryRoot);
  if (!Array.isArray(outputs) || JSON.stringify(outputs.map(({ relative }) => relative)) !== JSON.stringify(OUTPUTS) || outputs.some(({ bytes, prestate }) => !Buffer.isBuffer(bytes) || !prestate?.bytes)) throw new Error("current-capital refresh output allowlist mismatch");
  const release = await acquireLock(root);
  try {
    await recover(root);
    await commitUnlocked({ root, outputs, failAfter, beforeCommit });
  } finally { await release(); }
}
export async function refreshCurrentCapitalAccessibilityFull({ repositoryRoot = ROOT, beforeCommit = async () => {} } = {}) {
  const root = path.resolve(repositoryRoot); const release = await acquireLock(root);
  try {
    await recover(root);
    const outputs = await buildCurrentCapitalAccessibilityRefreshOutputs({ repositoryRoot: root });
    await assertInputsStable(outputs.flatMap(({ inputs = [] }) => inputs));
    if (!outputs.every(({ bytes, prestate }) => bytes.equals(prestate.bytes))) await commitUnlocked({ root, outputs, beforeCommit });
    return { outputs: OUTPUTS };
  } finally { await release(); }
}

async function main(argv) { if (argv.length !== 0) throw new Error("current-capital refresh arguments mismatch"); const result = await refreshCurrentCapitalAccessibilityFull(); process.stdout.write(`${JSON.stringify(result)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
