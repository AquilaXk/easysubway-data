#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "../lib/is-main-module.mjs";
import { syncCanonicalFixture } from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { applySchedule } from "./apply-kric-line4-pilot-schedule.mjs";
import { buildCapitalTopologyReverificationEvidence } from "./collect-capital-route-topology.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { withCurrentCapitalTopologyAdmissions } from "./rebind-capital-route-map-admissions.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const MAX_BUFFER = 64 * 1024 * 1024;

export const CURRENT_PRODUCTION_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info",
  "seoulmetro-cyberstation-route-map", "kric-subway-timetable",
  "seoul-metro-accessibility", "kric-station-convenience-standard",
  "seoul-metro-official-od-fares",
]);

export const CURRENT_SOURCE_HANDOFF = Object.freeze({
  hubCommit: "9251acdcc563975e8757d61f03e398d10c935d8b",
  rawSizeBytes: 12_657_973,
  rawSha256: "d8ee1a9351ade3465a955ffabeade294eaccf65449fc1fc1998240fdba87e064",
  rawObjectUri: "oci://easysubway-datapacks/source-raw/kric-subway-timetable/20260809/d8ee1a9351ade3465a955ffabeade294eaccf65449fc1fc1998240fdba87e064.json",
  snapshotId: "kric-subway-timetable-line4-pilot-20260809",
  previousSnapshotId: "kric-subway-timetable-line4-pilot-20260709",
  collectedAt: "2026-08-09T12:04:20.479Z",
  serviceEffectiveUntil: "2026-12-31T00:00:00Z",
  rowCount: 466,
  coverageCount: 1,
  freshnessExpiresAt: "2026-09-08T12:04:20.479Z",
  rawRetentionExpiresAt: "2026-11-07T12:04:20.479Z",
  redactedRequestFingerprint: "bb6302775c0afecf0b5e6d3c7e4bf89cdec4a2cfef01fbb80d2ea5ace234f0f7",
  schemaFingerprint: "44585c58909db0d14ed103ecf357291e4f337fc432e9e8938043a39097d904ff",
  governancePolicyVersion: "2026-07-15",
  governancePolicySha256: "96fb678f2ec5da7f555d81d9d2009ac838e6145cc48ed2ae4757bce42c90ef70",
  topologySnapshotId: "capital-route-topology-20260809",
  topologyFileSha256: "23761f7230c01971c07d7a6340286404a9eedcc0fee224f3080f16a0cbe224d5",
  topologyContentSha256: "811e87798345422217f518fbac669f0fc248c88aab4a1bae13e0eb0d1e80d4b1",
});

export const CURRENT_SOURCE_ACTIVATION_OUTPUTS = Object.freeze([
  "tools/datapack/sources/capital-route-topology-20260809.json", "tools/datapack/release/capital-topology-reverification-20260809.json",
  "tools/datapack/release/source-snapshots.json", "tools/datapack/source-inventory.json", "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "tools/datapack/release/capital-production-reviewed-pack.json", "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json",
]);
const allowedOutputPaths = new Set(CURRENT_SOURCE_ACTIVATION_OUTPUTS);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireOne(rows, predicate, label) {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label} must have exactly one match`);
  return matches[0];
}

function validateHandoff(handoff, rawArtifact, rawArtifactBytes) {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)
    || !/^[0-9a-f]{40}$/u.test(handoff.hubCommit ?? "")
    || !Number.isSafeInteger(handoff.rawSizeBytes) || handoff.rawSizeBytes <= 0
    || !SHA256.test(handoff.rawSha256 ?? "")
    || !SHA256.test(handoff.schemaFingerprint ?? "")
    || !SHA256.test(handoff.redactedRequestFingerprint ?? "")
    || !SHA256.test(handoff.governancePolicySha256 ?? "")
    || !SHA256.test(handoff.topologyFileSha256 ?? "")
    || !SHA256.test(handoff.topologyContentSha256 ?? "")
    || typeof handoff.rawObjectUri !== "string"
    || handoff.rawObjectUri !== `oci://easysubway-datapacks/source-raw/kric-subway-timetable/20260809/${handoff.rawSha256}.json`
    || !/^kric-subway-timetable-line4-pilot-[0-9]{8}$/u.test(handoff.snapshotId ?? "")
    || typeof handoff.previousSnapshotId !== "string"
    || !/^capital-route-topology-[0-9]{8}$/u.test(handoff.topologySnapshotId ?? "")
    || !Number.isSafeInteger(handoff.rowCount) || handoff.rowCount <= 0
    || !Number.isSafeInteger(handoff.coverageCount) || handoff.coverageCount <= 0
    || typeof handoff.governancePolicyVersion !== "string") {
    throw new Error("current source handoff identity is invalid");
  }
  for (const [label, value] of [
    ["collectedAt", handoff.collectedAt],
    ["serviceEffectiveUntil", handoff.serviceEffectiveUntil],
    ["freshnessExpiresAt", handoff.freshnessExpiresAt],
    ["rawRetentionExpiresAt", handoff.rawRetentionExpiresAt],
  ]) {
    try {
      requiredUtcInstant(value, `current source handoff ${label}`);
    } catch {
      throw new Error(`current source handoff ${label} is invalid`);
    }
  }
  if (!Buffer.isBuffer(rawArtifactBytes)
    || rawArtifactBytes.length !== handoff.rawSizeBytes
    || sha256(rawArtifactBytes) !== handoff.rawSha256) {
    throw new Error("current source raw artifact byte identity mismatch");
  }
  if (rawArtifact?.collectedAt !== handoff.collectedAt) {
    throw new Error("current source raw artifact collection identity mismatch");
  }
}

function currentKricSnapshot(previous, handoff) {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: handoff.snapshotId,
    sourceId: "kric-subway-timetable",
    provider: "국가철도공단",
    retrievedAt: handoff.collectedAt,
    sourceUpdatedAt: handoff.collectedAt,
    serviceEffectiveAt: handoff.collectedAt,
    serviceEffectiveUntil: handoff.serviceEffectiveUntil,
    rowCount: handoff.rowCount,
    coverageCount: handoff.coverageCount,
    rawSha256: handoff.rawSha256,
    rawObjectUri: handoff.rawObjectUri,
    redactedRequestFingerprint: handoff.redactedRequestFingerprint,
    schemaFingerprint: handoff.schemaFingerprint,
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    previousSnapshotId: previous.snapshotId,
    diffSummary: null,
    freshnessExpiresAt: handoff.freshnessExpiresAt,
    rawRetentionExpiresAt: handoff.rawRetentionExpiresAt,
    governancePolicyVersion: handoff.governancePolicyVersion,
    governancePolicySha256: handoff.governancePolicySha256,
  };
  snapshot.diffSummary = buildSnapshotDiff(previous, snapshot);
  return snapshot;
}

function activateInventory(sourceInventory, handoff) {
  if (sourceInventory?.schemaVersion !== 1
    || sourceInventory.artifactKind !== "production-source-inventory"
    || !Array.isArray(sourceInventory.sources)) {
    throw new Error("current source inventory identity is invalid");
  }
  const next = structuredClone(sourceInventory);
  for (const sourceId of CURRENT_PRODUCTION_SOURCE_IDS) {
    requireOne(next.sources, ({ id }) => id === sourceId, `current source inventory ${sourceId}`);
  }
  const timetable = requireOne(
    next.sources,
    ({ id }) => id === "kric-subway-timetable",
    "current timetable source",
  );
  if (!timetable.admissionEvidence || typeof timetable.admissionEvidence !== "object") {
    throw new Error("current timetable source admission evidence is missing");
  }
  timetable.observedDataUpdatedAt = handoff.collectedAt.slice(0, 10);
  timetable.retrievedAt = handoff.collectedAt.slice(0, 10);
  timetable.admissionEvidence.snapshotId = handoff.snapshotId;
  timetable.admissionEvidence.rawSha256 = handoff.rawSha256;
  timetable.admissionEvidence.schemaFingerprint = handoff.schemaFingerprint;

  const convenience = requireOne(
    next.sources,
    ({ id }) => id === "kric-station-convenience-standard",
    "current convenience source",
  );
  convenience.requiredForProductionPack = true;
  convenience.productionUseAllowed = true;
  if (convenience.admissionEvidence && typeof convenience.admissionEvidence === "object") {
    convenience.admissionEvidence.productionUseNoteKo =
      "fresh exhaustive snapshot과 reviewed accessibility evidence에 결속된 static facility rows만 production use를 허용한다.";
  }
  return next;
}

function activateProductionInput({ productionInput, officialOdFareQuotes, handoff, rawArtifact, rawArtifactBytes, applyScheduleImpl }) {
  if (!productionInput || typeof productionInput !== "object" || Array.isArray(productionInput)) {
    throw new Error("current production input identity is invalid");
  }
  if (!Array.isArray(officialOdFareQuotes)
    || officialOdFareQuotes.length !== 2
    || officialOdFareQuotes.some(({ sourceId }) => sourceId !== "seoul-metro-official-od-fares")) {
    throw new Error("current official OD fare input must contain the exact two Seoul quotes");
  }
  const scheduled = applyScheduleImpl(structuredClone(productionInput), rawArtifact, rawArtifactBytes);
  if (scheduled?.scheduleProvenance?.sourceId !== "kric-subway-timetable"
    || scheduled.scheduleProvenance.sourceSnapshotId !== handoff.snapshotId
    || scheduled.scheduleProvenance.providerRecordHash !== handoff.rawSha256
    || scheduled.scheduleProvenance.retrievedAt !== handoff.collectedAt
    || !Array.isArray(scheduled.transitRoutes) || scheduled.transitRoutes.length === 0
    || !Array.isArray(scheduled.transitTrips) || scheduled.transitTrips.length === 0
    || !Array.isArray(scheduled.transitStopTimes) || scheduled.transitStopTimes.length === 0) {
    throw new Error("current timetable materialization identity is invalid");
  }
  const fareCoverage = {
    regionId: "capital",
    operatorId: "seoul-metro",
    sourceDomain: "official_od_fares",
    sourceIds: ["seoul-metro-official-od-fares"],
    evidence: "승인된 서울교통공사 양방향 OD fare snapshot",
  };
  const coverageEvidence = (scheduled.coverageEvidence ?? [])
    .filter(({ sourceDomain }) => sourceDomain !== "official_od_fares");
  return {
    ...scheduled,
    sourceIds: [...CURRENT_PRODUCTION_SOURCE_IDS],
    coverageEvidence: [...coverageEvidence, fareCoverage],
    officialOdFareQuotes: structuredClone(officialOdFareQuotes),
    routeServiceArtifactEvidence: [],
    movementPathCandidates: [],
  };
}

export function buildCurrentSourcePrimaryOutputs({
  handoff = CURRENT_SOURCE_HANDOFF,
  rawArtifact,
  rawArtifactBytes,
  sourceSnapshots,
  sourceInventory,
  productionInput,
  officialOdFareQuotes,
  baselineTopology,
  currentTopology,
  snapshotBytesByPath,
  applyScheduleImpl = applySchedule,
  rebindTopologyAdmissionsImpl = withCurrentCapitalTopologyAdmissions,
  buildTopologyReverificationImpl = buildCapitalTopologyReverificationEvidence,
}) {
  validateHandoff(handoff, rawArtifact, rawArtifactBytes);
  if (!Array.isArray(sourceSnapshots)) throw new Error("current source snapshots are required");
  const previous = requireOne(
    sourceSnapshots,
    ({ snapshotId }) => snapshotId === handoff.previousSnapshotId,
    "previous KRIC source snapshot",
  );
  if (sourceSnapshots.some(({ snapshotId }) => snapshotId === handoff.snapshotId)) {
    throw new Error("current KRIC source snapshot is already present");
  }
  const nextSnapshots = [...structuredClone(sourceSnapshots), currentKricSnapshot(previous, handoff)];
  validateLineage(nextSnapshots);

  const inventory = activateInventory(sourceInventory, handoff);
  const reboundInventory = rebindTopologyAdmissionsImpl({
    inventory,
    topology: currentTopology,
    topologySnapshotId: handoff.topologySnapshotId,
    reviewedAt: handoff.collectedAt,
    snapshotBytesByPath,
  });
  const nextInput = activateProductionInput({
    productionInput,
    officialOdFareQuotes,
    handoff,
    rawArtifact,
    rawArtifactBytes,
    applyScheduleImpl,
  });
  return {
    sourceSnapshots: nextSnapshots,
    sourceInventory: reboundInventory,
    productionInput: nextInput,
    topologyReverification: buildTopologyReverificationImpl(baselineTopology, currentTopology),
  };
}

function jsonBytes(value, pretty = true) {
  return Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function requiredSha(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be a lowercase sha256`);
  return value;
}

export function buildCurrentCandidateSpec({
  baseSpec,
  builderGitSha,
  handoff = CURRENT_SOURCE_HANDOFF,
  sourceInventoryBytes,
  currentTopology,
  currentTopologyBytes,
  topologyReverificationBytes,
  itxCurrentTopologyAdmissionBytes,
}) {
  if (!baseSpec || baseSpec.schemaVersion !== 1
    || baseSpec.artifactKind !== "datapack-candidate-build-spec"
    || !/^[0-9a-f]{40}$/u.test(builderGitSha ?? "")) {
    throw new Error("current candidate base spec or builder identity is invalid");
  }
  if (!Buffer.isBuffer(sourceInventoryBytes)
    || !Buffer.isBuffer(currentTopologyBytes)
    || !Buffer.isBuffer(topologyReverificationBytes)
    || !Buffer.isBuffer(itxCurrentTopologyAdmissionBytes)
    || sha256(currentTopologyBytes) !== handoff.topologyFileSha256
    || currentTopology?.contentSha256 !== handoff.topologyContentSha256
    || currentTopology?.capturedAt !== handoff.collectedAt
    || currentTopology?.freshUntil !== "2026-08-10T12:04:20.479Z") {
    throw new Error("current capital topology candidate identity is invalid");
  }
  const spec = structuredClone(baseSpec);
  spec.candidateId = "capital-pilot-candidate-20260809";
  spec.builderGitSha = builderGitSha;
  spec.builderVersion = "build-datapack.mjs@25";
  spec.fixturePath = "tools/datapack/release/capital-production-canonical-pack.json";
  spec.networkEdgeEvidence = {
    ...spec.networkEdgeEvidence,
    sourceInventory: {
      path: "tools/datapack/source-inventory.json",
      sha256: sha256(sourceInventoryBytes),
    },
    capitalTopology: {
      path: "tools/datapack/sources/capital-route-topology-20260724.json",
      sha256: requiredSha(spec.networkEdgeEvidence?.capitalTopology?.sha256, "baseline topology sha256"),
      snapshotId: "capital-route-topology-20260724",
    },
    capitalTopologyCandidate: {
      path: "tools/datapack/sources/capital-route-topology-20260809.json",
      sha256: sha256(currentTopologyBytes),
      snapshotId: handoff.topologySnapshotId,
    },
    capitalTopologyReverification: {
      path: "tools/datapack/release/capital-topology-reverification-20260809.json",
      sha256: sha256(topologyReverificationBytes),
    },
    capitalTopologyAdmission: {
      schemaVersion: 1,
      artifactKind: "capital-network-edge-admission",
      issue: 2649,
      status: "ADMITTED",
      snapshotId: handoff.topologySnapshotId,
      contentSha256: handoff.topologyContentSha256,
      reviewedAt: handoff.collectedAt,
      reverifiedAt: handoff.collectedAt,
      freshUntil: currentTopology.freshUntil,
    },
    itxCurrentTopologyAdmission: {
      path: "tools/datapack/itx-current-network-edge-admission-20260810.json",
      sha256: sha256(itxCurrentTopologyAdmissionBytes),
    },
  };
  return spec;
}

async function readRegularBytes(repositoryRoot, relativePath, label = relativePath) {
  const absolutePath = contained(repositoryRoot, relativePath);
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return await readFile(absolutePath);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

async function writeTempFile(temporaryRoot, relativePath, bytes) {
  const absolutePath = contained(temporaryRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
  return absolutePath;
}

async function replaceTempFile(temporaryRoot, relativePath, bytes) {
  const absolutePath = contained(temporaryRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes, { mode: 0o600 });
  return absolutePath;
}

async function readHubTopology(hubRepository, handoff) {
  const repositoryPath = path.resolve(hubRepository);
  const metadata = await lstat(repositoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Hub repository must be a real directory");
  }
  const { stdout: commitType } = await execFileAsync(
    "git",
    ["-C", repositoryPath, "cat-file", "-t", handoff.hubCommit],
    { maxBuffer: MAX_BUFFER },
  );
  if (commitType.trim() !== "commit") throw new Error("Hub handoff commit is unavailable");
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repositoryPath, "show", `${handoff.hubCommit}:tools/datapack/sources/capital-route-topology-20260809.json`],
    { encoding: "buffer", maxBuffer: MAX_BUFFER },
  );
  const bytes = Buffer.from(stdout);
  if (sha256(bytes) !== handoff.topologyFileSha256) {
    throw new Error("Hub current topology file identity mismatch");
  }
  const topology = parseJson(bytes, "Hub current topology");
  if (topology.contentSha256 !== handoff.topologyContentSha256
    || topology.capturedAt !== handoff.collectedAt
    || topology.freshUntil !== "2026-08-10T12:04:20.479Z") {
    throw new Error("Hub current topology semantic identity mismatch");
  }
  return { bytes, topology };
}

async function runNode(script, args, options = {}) {
  return await execFileAsync(
    process.execPath,
    [path.join(root, script), ...args],
    {
      cwd: root,
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: MAX_BUFFER,
    },
  );
}

function sourceRawObjectKey(handoff) {
  const parsed = new URL(handoff.rawObjectUri);
  if (parsed.protocol !== "oci:" || parsed.hostname !== "easysubway-datapacks"
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("current source raw object URI is invalid");
  }
  return parsed.pathname.slice(1);
}

function contained(repositoryRoot, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error("activation output path must be repository-relative");
  }
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("activation output path escapes repository root");
  }
  return target;
}

async function existingMetadata(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function requireSafeTarget(repositoryRoot, relativePath) {
  const root = path.resolve(repositoryRoot);
  const target = contained(root, relativePath);
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await existingMetadata(current);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`activation output parent must be a real directory: ${relativePath}`);
    }
  }
  const metadata = await existingMetadata(target);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`activation output must be a regular non-symlink file: ${relativePath}`);
  }
  return { target, existed: metadata != null };
}

async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurably(file, bytes, flag = "wx") {
  const handle = await open(file, flag, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceAtomically(target, bytes) {
  const temporaryPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeDurably(temporaryPath, bytes);
    await rename(temporaryPath, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function acquireActivationLock(repositoryRoot) {
  const lockDirectory = path.join(repositoryRoot, "tools/datapack/.current-source-activation.lock");
  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("current source activation is already in progress");
    throw error;
  }
  return async () => {
    await rmdir(lockDirectory);
    await syncDirectory(path.dirname(lockDirectory));
  };
}

function validateOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error("activation outputs are required");
  }
  const seen = new Set();
  return outputs.map((output) => {
    if (!output || !allowedOutputPaths.has(output.relativePath) || seen.has(output.relativePath)) {
      throw new Error(`activation output is not allowed or is duplicated: ${output?.relativePath ?? ""}`);
    }
    if (!Buffer.isBuffer(output.bytes)) {
      throw new TypeError(`activation output bytes must be a Buffer: ${output.relativePath}`);
    }
    seen.add(output.relativePath);
    return output;
  });
}

async function stageOutputs(repositoryRoot, transactionDirectory, outputs) {
  const records = [];
  for (const [index, output] of outputs.entries()) {
    const { target, existed } = await requireSafeTarget(repositoryRoot, output.relativePath);
    const backupPath = path.join(transactionDirectory, `backup-${index}`);
    const stagedPath = path.join(transactionDirectory, `staged-${index}`);
    let originalSha256 = null;
    if (existed) {
      const originalBytes = await readFile(target);
      originalSha256 = sha256(originalBytes);
      await writeDurably(backupPath, originalBytes);
    }
    await writeDurably(stagedPath, output.bytes);
    records.push({
      relativePath: output.relativePath,
      existed,
      backupPath: existed ? path.relative(repositoryRoot, backupPath) : null,
      originalSha256,
      expectedSha256: sha256(output.bytes),
    });
  }
  await syncDirectory(transactionDirectory);
  return records;
}

function validateJournal(journal, outputCount) {
  if (!journal || journal.schemaVersion !== 1 || journal.state !== "PREPARED"
    || !Array.isArray(journal.records) || journal.records.length !== outputCount) {
    throw new Error("current source activation journal is invalid");
  }
  for (const record of journal.records) {
    if (!allowedOutputPaths.has(record.relativePath)
      || typeof record.existed !== "boolean"
      || !SHA256.test(record.expectedSha256 ?? "")
      || (record.existed && (!SHA256.test(record.originalSha256 ?? "") || typeof record.backupPath !== "string"))
      || (!record.existed && (record.originalSha256 !== null || record.backupPath !== null))) {
      throw new Error("current source activation journal record is invalid");
    }
  }
}

async function restorePreparedTransaction(repositoryRoot, journal) {
  for (const record of journal.records) {
    const target = contained(repositoryRoot, record.relativePath);
    if (record.existed) {
      const backupPath = contained(repositoryRoot, record.backupPath);
      const backupBytes = await readFile(backupPath);
      if (sha256(backupBytes) !== record.originalSha256) {
        throw new Error(`activation backup identity mismatch: ${record.relativePath}`);
      }
      await replaceAtomically(target, backupBytes);
    } else {
      await rm(target, { force: true });
      await syncDirectory(path.dirname(target));
    }
  }
}

export async function commitCurrentSourceActivation({
  repositoryRoot,
  outputs,
  validate,
  replace = replaceAtomically,
}) {
  const root = path.resolve(repositoryRoot);
  const checkedOutputs = validateOutputs(outputs);
  if (typeof validate !== "function") throw new TypeError("activation validation callback is required");
  const releaseLock = await acquireActivationLock(root);
  const journalPath = path.join(root, "tools/datapack/.current-source-activation-transaction.json");
  const transactionDirectory = await mkdtemp(path.join(root, "tools/datapack/.current-source-activation-"));
  let journal;
  try {
    if (await existingMetadata(journalPath)) {
      throw new Error("current source activation RECOVERY_REQUIRED");
    }
    const records = await stageOutputs(root, transactionDirectory, checkedOutputs);
    journal = {
      schemaVersion: 1,
      state: "PREPARED",
      transactionDirectory: path.relative(root, transactionDirectory),
      records,
    };
    validateJournal(journal, checkedOutputs.length);
    await writeDurably(journalPath, Buffer.from(`${JSON.stringify(journal)}\n`));
    await syncDirectory(path.dirname(journalPath));
    for (const output of checkedOutputs) {
      await replace(contained(root, output.relativePath), output.bytes);
    }
    await validate();
    const committed = Buffer.from(`${JSON.stringify({ ...journal, state: "COMMITTED" })}\n`);
    await replaceAtomically(journalPath, committed);
    await rm(journalPath);
    await syncDirectory(path.dirname(journalPath));
    await rm(transactionDirectory, { recursive: true });
  } catch (error) {
    if (journal) {
      try {
        await restorePreparedTransaction(root, journal);
        await rm(journalPath, { force: true });
        await syncDirectory(path.dirname(journalPath));
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "current source activation rollback failed");
      }
    }
    await rm(transactionDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await releaseLock();
  }
}

async function collectPositionSnapshotBytes(sourceInventory) {
  const snapshotBytesByPath = new Map();
  for (const source of sourceInventory.sources ?? []) {
    const evidence = source.routeMapAdmissionEvidence;
    if (evidence?.topologySourceId !== "capital-route-topology") continue;
    if (snapshotBytesByPath.has(evidence.snapshotPath)) {
      throw new Error(`duplicate capital position snapshot path: ${evidence.snapshotPath}`);
    }
    snapshotBytesByPath.set(
      evidence.snapshotPath,
      await readRegularBytes(root, evidence.snapshotPath, `${source.id} position snapshot`),
    );
  }
  if (snapshotBytesByPath.size === 0) throw new Error("capital position snapshots are missing");
  return snapshotBytesByPath;
}

async function fetchCurrentRawArtifact(temporaryRoot, handoff) {
  const destinationPath = "input/kric-subway-timetable-20260809.json";
  await mkdir(path.join(temporaryRoot, "input"), { recursive: true });
  const planPath = await writeTempFile(
    temporaryRoot,
    "fetch-source-raw-plan.json",
    jsonBytes({
      schemaVersion: 1,
      steps: [{
        type: "fetch-source-raw-object",
        objectKey: sourceRawObjectKey(handoff),
        destinationPath,
        sha256: handoff.rawSha256,
        sizeBytes: handoff.rawSizeBytes,
      }],
    }),
  );
  await runNode("tools/datapack/publish-object-storage.mjs", [
    "--plan", planPath,
    "--root", temporaryRoot,
  ]);
  const bytes = await readRegularBytes(temporaryRoot, destinationPath, "current KRIC raw artifact");
  if (bytes.length !== handoff.rawSizeBytes || sha256(bytes) !== handoff.rawSha256) {
    throw new Error("downloaded current KRIC raw artifact identity mismatch");
  }
  return { bytes, value: parseJson(bytes, "current KRIC raw artifact") };
}

async function prepareReleaseEvidenceRoot(temporaryRoot) {
  for (const relativePath of [
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/hash-evidence.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
    "tools/datapack/itx-cheongchun-topology-evidence.json",
  ]) {
    await writeTempFile(temporaryRoot, relativePath, await readRegularBytes(root, relativePath));
  }
}

function validationBuildSpec(spec, temporaryRoot) {
  const next = structuredClone(spec);
  next.fixturePath = path.join(
    temporaryRoot,
    "tools/datapack/release/capital-production-canonical-pack.json",
  );
  next.itxTopologyEvidencePath = path.join(
    temporaryRoot,
    "tools/datapack/itx-cheongchun-topology-evidence.json",
  );
  Object.assign(next.networkEdgeEvidence.sourceInventory, {
    path: path.join(temporaryRoot, "tools/datapack/source-inventory.json"),
  });
  Object.assign(next.networkEdgeEvidence.capitalTopology, {
    path: path.join(root, "tools/datapack/sources/capital-route-topology-20260724.json"),
  });
  Object.assign(next.networkEdgeEvidence.capitalTopologyCandidate, {
    path: path.join(temporaryRoot, "tools/datapack/sources/capital-route-topology-20260809.json"),
  });
  Object.assign(next.networkEdgeEvidence.capitalTopologyReverification, {
    path: path.join(
      temporaryRoot,
      "tools/datapack/release/capital-topology-reverification-20260809.json",
    ),
  });
  Object.assign(next.networkEdgeEvidence.itxCoverageContract, {
    path: path.join(root, "tools/datapack/itx-cheongchun-coverage-contract.json"),
  });
  Object.assign(next.networkEdgeEvidence.itxCurrentTopologyAdmission, {
    path: path.join(root, "tools/datapack/itx-current-network-edge-admission-20260810.json"),
  });
  return next;
}

async function validatePreparedCandidate({ temporaryRoot, spec, buildNow }) {
  const validationSpecPath = await writeTempFile(
    temporaryRoot,
    "validation/candidate-build-spec.json",
    jsonBytes(validationBuildSpec(spec, temporaryRoot)),
  );
  const outputPath = path.join(temporaryRoot, "validation/output");
  await runNode("tools/datapack/build-datapack.mjs", [
    "--build-spec", validationSpecPath,
    "--output", outputPath,
  ], { env: { EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } });
  await runNode("tools/datapack/validate-datapack.mjs", [
    "--manifest", path.join(outputPath, "current.json"),
    "--root", outputPath,
    "--require-production",
  ]);
}

function validateBuildNow(buildNow, handoff) {
  const millis = requiredUtcInstant(buildNow, "--build-now");
  if (millis < Date.parse(handoff.collectedAt)
    || millis >= Date.parse("2026-08-10T12:04:20.479Z")) {
    throw new Error("--build-now must be inside the current source admission window");
  }
  return buildNow;
}

export async function requireCleanBuilder(builderGitSha, {
  check = false,
  repositoryRoot = root,
  allowedDescendantPaths = CURRENT_SOURCE_ACTIVATION_OUTPUTS,
} = {}) {
  if (!/^[0-9a-f]{40}$/u.test(builderGitSha ?? "")) {
    throw new Error("--builder-git-sha must be an exact git commit");
  }
  const repositoryPath = path.resolve(repositoryRoot);
  const [{ stdout: head }, { stdout: status }, { stdout: builderType }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, maxBuffer: MAX_BUFFER }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repositoryPath,
      maxBuffer: MAX_BUFFER,
    }),
    execFileAsync("git", ["cat-file", "-t", builderGitSha], {
      cwd: repositoryPath,
      maxBuffer: MAX_BUFFER,
    }),
  ]);
  if (builderType.trim() !== "commit") throw new Error("builder git SHA must name a commit");
  if (status.trim() !== "") throw new Error("current source activation requires a clean worktree");
  if (head.trim() === builderGitSha) return;
  if (!check) throw new Error("builder git SHA does not match HEAD");
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", builderGitSha, "HEAD"], {
      cwd: repositoryPath,
      maxBuffer: MAX_BUFFER,
    });
  } catch {
    throw new Error("check-mode builder identity must be an ancestor of HEAD");
  }
  const allowed = new Set(allowedDescendantPaths);
  const { stdout: changedOutput } = await execFileAsync(
    "git",
    ["diff", "--name-only", builderGitSha, "HEAD", "--"],
    { cwd: repositoryPath, maxBuffer: MAX_BUFFER },
  );
  const changedPaths = changedOutput.split("\n").filter(Boolean);
  if (changedPaths.some((relativePath) => !allowed.has(relativePath))) {
    throw new Error("check-mode builder source or unrelated tracked path changed after generation");
  }
}

export async function generateCurrentSourceActivation({
  hubRepository,
  builderGitSha,
  buildNow,
  check = false,
  handoff = CURRENT_SOURCE_HANDOFF,
}) {
  await requireCleanBuilder(builderGitSha, { check });
  validateBuildNow(buildNow, handoff);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "current-source-activation-"));
  try {
    const [hubTopology, rawArtifact, baselineTopologyBytes, sourceSnapshotBytes,
      sourceInventoryBytes, productionInputBytes, quoteBundleBytes, baseSpecBytes,
      canonicalBytes, itxCurrentTopologyAdmissionBytes] = await Promise.all([
      readHubTopology(hubRepository, handoff),
      fetchCurrentRawArtifact(temporaryRoot, handoff),
      readRegularBytes(root, "tools/datapack/sources/capital-route-topology-20260724.json"),
      readRegularBytes(root, "tools/datapack/release/source-snapshots.json"),
      readRegularBytes(root, "tools/datapack/source-inventory.json"),
      readRegularBytes(root, "tools/datapack/inputs/capital-pilot-production-source-input.json"),
      readRegularBytes(root, "tools/datapack/official-od-fare-quotes.json"),
      readRegularBytes(root, "tools/datapack/release/candidate-build-spec.json"),
      readRegularBytes(root, "tools/datapack/release/capital-production-canonical-pack.json"),
      readRegularBytes(root, "tools/datapack/itx-current-network-edge-admission-20260810.json"),
    ]);
    const sourceInventory = parseJson(sourceInventoryBytes, "source inventory");
    const quoteBundle = parseJson(quoteBundleBytes, "official OD fare quote bundle");
    const officialOdFareQuotes = (quoteBundle.quotes ?? [])
      .filter(({ sourceId }) => sourceId === "seoul-metro-official-od-fares");
    const primary = buildCurrentSourcePrimaryOutputs({
      handoff,
      rawArtifact: rawArtifact.value,
      rawArtifactBytes: rawArtifact.bytes,
      sourceSnapshots: parseJson(sourceSnapshotBytes, "source snapshots"),
      sourceInventory,
      productionInput: parseJson(productionInputBytes, "production input"),
      officialOdFareQuotes,
      baselineTopology: parseJson(baselineTopologyBytes, "baseline capital topology"),
      currentTopology: hubTopology.topology,
      snapshotBytesByPath: await collectPositionSnapshotBytes(sourceInventory),
    });

    const primaryBytes = {
      topology: hubTopology.bytes,
      reverification: jsonBytes(primary.topologyReverification),
      snapshots: jsonBytes(primary.sourceSnapshots),
      inventory: jsonBytes(primary.sourceInventory),
      input: jsonBytes(primary.productionInput),
    };
    await Promise.all([
      writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[0], primaryBytes.topology),
      writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[1], primaryBytes.reverification),
      writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[2], primaryBytes.snapshots),
      writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[3], primaryBytes.inventory),
      writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[4], primaryBytes.input),
    ]);

    const reviewedPath = contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[5]);
    await runNode("tools/datapack/import-official-sources.mjs", [
      "--inventory", contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[3]),
      "--input", contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[4]),
      "--output", reviewedPath,
    ]);
    const reviewedBytes = await readFile(reviewedPath);
    const reviewed = parseJson(reviewedBytes, "current reviewed pack");
    const reviewedCapital = reviewed.packs?.find(({ id }) => id === "capital");
    if (!reviewedCapital) throw new Error("current reviewed capital pack is missing");
    const canonical = syncCanonicalFixture(
      parseJson(canonicalBytes, "canonical pack"),
      reviewedCapital,
    );
    const nextCanonicalBytes = jsonBytes(canonical, false);
    await writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[6], nextCanonicalBytes);

    const nextSpec = buildCurrentCandidateSpec({
      baseSpec: parseJson(baseSpecBytes, "candidate build spec"),
      builderGitSha,
      handoff,
      sourceInventoryBytes: primaryBytes.inventory,
      currentTopology: hubTopology.topology,
      currentTopologyBytes: primaryBytes.topology,
      topologyReverificationBytes: primaryBytes.reverification,
      itxCurrentTopologyAdmissionBytes,
    });
    await writeTempFile(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[7], jsonBytes(nextSpec));
    await prepareReleaseEvidenceRoot(temporaryRoot);
    await runNode("tools/datapack/apply-accessibility-evidence-to-bundled-pack.mjs", [
      "--release-evidence-only",
      "--release-root", temporaryRoot,
    ], { env: { EASYSUBWAY_DATAPACK_BUILD_NOW: buildNow } });

    const [finalSpecBytes, releaseRequestBytes, hashEvidenceBytes] = await Promise.all([
      readFile(contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[7])),
      readFile(contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[8])),
      readFile(contained(temporaryRoot, CURRENT_SOURCE_ACTIVATION_OUTPUTS[9])),
    ]);
    const finalSpec = parseJson(finalSpecBytes, "generated candidate build spec");
    await validatePreparedCandidate({ temporaryRoot, spec: finalSpec, buildNow });

    const outputs = [
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[0], bytes: primaryBytes.topology },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[1], bytes: primaryBytes.reverification },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[2], bytes: primaryBytes.snapshots },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[3], bytes: primaryBytes.inventory },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[4], bytes: primaryBytes.input },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[5], bytes: reviewedBytes },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[6], bytes: nextCanonicalBytes },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[7], bytes: finalSpecBytes },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[8], bytes: releaseRequestBytes },
      { relativePath: CURRENT_SOURCE_ACTIVATION_OUTPUTS[9], bytes: hashEvidenceBytes },
    ];
    const validateOutputBytes = async () => {
      for (const output of outputs) {
        const actual = await readRegularBytes(root, output.relativePath);
        if (!actual.equals(output.bytes)) {
          throw new Error(`current source activation output mismatch: ${output.relativePath}`);
        }
      }
    };
    if (check) {
      await validateOutputBytes();
    } else {
      await commitCurrentSourceActivation({
        repositoryRoot: root,
        outputs,
        validate: validateOutputBytes,
      });
    }
    return {
      candidateId: finalSpec.candidateId,
      sourceSnapshotSetHash: finalSpec.sourceSnapshotSetHash,
      sourceInventorySha256: finalSpec.sourceInventorySha256,
      outputCount: outputs.length,
      check,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  const args = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      args.check = true;
      continue;
    }
    if (!["--hub-repository", "--builder-git-sha", "--build-now"].includes(flag)) {
      throw new Error(`unknown activation argument: ${flag ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (args[key] != null) throw new Error(`duplicate activation argument: ${flag}`);
    args[key] = value;
    index += 1;
  }
  for (const key of ["hub_repository", "builder_git_sha", "build_now"]) {
    if (!args[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await generateCurrentSourceActivation({
    hubRepository: args.hub_repository,
    builderGitSha: args.builder_git_sha,
    buildNow: args.build_now,
    check: args.check,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
