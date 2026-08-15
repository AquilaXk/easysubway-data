#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { validateKricAccessibilitySnapshotIdentity } from "./collect-kric-accessibility-snapshots.mjs";
import { validateSeoulAccessibilitySnapshotIdentity } from "./collect-seoul-accessibility-evidence.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { materializeAccessibilitySourceInput } from "./materialize-accessibility-source-input.mjs";
import { deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { buildSnapshotDiff, requiredCredentialFreeObjectUri, validateLineage } from "./source-snapshot-policy.mjs";
import { validateCurrentCapitalFacilityPlanAndCanonicalPack } from "./build-current-capital-facility-source-admission.mjs";
import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";

const SOURCE_ID = "kric-station-convenience-standard";
const SEOUL_SOURCE_ID = "seoul-metro-accessibility";
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function syncedWrite(file, bytes) {
  const handle = await open(file, "w");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function atomicReplace(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await syncedWrite(temporary, bytes);
  await rename(temporary, target);
  const directory = await open(path.dirname(target), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function syncDirectory(directoryPath) { const handle = await open(directoryPath, "r"); try { await handle.sync(); } finally { await handle.close(); } }

function contained(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("transaction path is invalid");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("transaction path escapes repository");
  return target;
}

function transactionPaths(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  return { root, journal: path.join(root, "tools/datapack/.kric-standard-registration-transaction.json") };
}

async function readRecoveryEntry(journal) {
  try {
    return JSON.parse(await readFile(journal, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("RECOVERY_REQUIRED");
  }
}

function validateRecoveryEntry(entry, root) {
  if (!["PREPARED", "COMMITTED"].includes(entry?.state) || !Array.isArray(entry.records) || entry.records.length === 0
    || typeof entry.transactionDirectory !== "string"
    || !/^\.kric-standard-registration-[0-9a-f-]{36}$/.test(path.basename(entry.transactionDirectory))) {
    throw new Error("journal");
  }
  return contained(root, entry.transactionDirectory);
}

async function recoverJournalRecord({ entry, record, root, directory, seen, atomicReplaceImpl, syncDirectoryImpl }) {
  const allowed = new Set([
    "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json",
    "tools/datapack/inputs/capital-pilot-production-source-input.json",
  ]);
  if (!record || typeof record.target !== "string" || typeof record.backup !== "string"
    || typeof record.existed !== "boolean" || !SHA256.test(record.expected ?? "") || seen.has(record.target)) {
    throw new Error("journal");
  }
  seen.add(record.target);
  if (!allowed.has(record.target)
    && !/^tools\/datapack\/sources\/(?:kric-station-convenience-standard|seoul-metro-accessibility)-[A-Za-z0-9]+\.json$/.test(record.target)) {
    throw new Error("journal");
  }
  const target = contained(root, record.target);
  if (record.existed && path.dirname(contained(root, record.backup)) !== directory) throw new Error("journal");
  if (entry.state === "COMMITTED") {
    if (sha256(await readFile(target)) !== record.expected) throw new Error("journal");
    return;
  }
  if (record.existed) {
    await atomicReplaceImpl(target, await readFile(contained(root, record.backup)), "recovery");
    return;
  }
  await rm(target, { force: true });
  await syncDirectoryImpl(path.dirname(target));
}

async function acquireRegistrationLock(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const lockDirectory = path.join(root, "tools/datapack/.kric-standard-registration.lock");
  await mkdir(path.dirname(lockDirectory), { recursive: true });
  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("KRIC standard registration is already in progress");
    throw error;
  }
  const ownerPath = path.join(lockDirectory, `.owner-${randomUUID()}`);
  const lockRecoveryRequired = () => new Error("KRIC registration lock RECOVERY_REQUIRED");
  const release = async () => {
    let ownerMissing = false;
    try { await rm(ownerPath); } catch (error) {
      if (error?.code === "ENOENT") ownerMissing = true;
      else throw lockRecoveryRequired();
    }
    try { await syncDirectory(lockDirectory); } catch (error) {
      if (ownerMissing && error?.code === "ENOENT") return;
      throw lockRecoveryRequired();
    }
    try {
      await rmdir(lockDirectory);
    } catch (error) {
      if (error?.code === "ENOTEMPTY" || error?.code === "ENOENT") return;
      throw lockRecoveryRequired();
    }
    try { await syncDirectory(path.dirname(lockDirectory)); } catch { throw lockRecoveryRequired(); }
  };
  try {
    await syncedWrite(ownerPath, `${process.pid}\n`);
    await syncDirectory(lockDirectory);
  } catch (error) {
    await release();
    throw error;
  }
  return async () => {
    await release();
  };
}

async function recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot = REPOSITORY_ROOT, atomicReplaceImpl = atomicReplace, cleanupTransactionDirectoryImpl = (directory) => rm(directory, { recursive: true, force: true }), syncDirectoryImpl = syncDirectory } = {}) {
  const { root, journal } = transactionPaths(repositoryRoot);
  const entry = await readRecoveryEntry(journal);
  if (entry === undefined) return false;
  let outcome;
  let directory;
  try {
    directory = validateRecoveryEntry(entry, root);
    const seen = new Set();
    for (const record of entry.records) {
      await recoverJournalRecord({ entry, record, root, directory, seen, atomicReplaceImpl, syncDirectoryImpl });
    }
    await rm(journal, { force: true });
    await syncDirectory(path.dirname(journal));
    outcome = entry.state;
  } catch {
    throw new Error("RECOVERY_REQUIRED");
  }
  try { await cleanupTransactionDirectoryImpl(directory); } catch { /* journal is finalized; orphan is harmless */ }
  return outcome;
}

async function stageTransactionOutputs({ root, directory, outputs }) {
  const records = [];
  try {
    for (const [index, output] of outputs.entries()) {
      contained(root, path.relative(root, output.target));
      const relative = path.relative(root, output.target);
      const backup = path.relative(root, path.join(directory, `backup-${index}`));
      let original = null;
      try { original = await readFile(output.target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (original != null) await syncedWrite(contained(root, backup), original);
      await syncedWrite(path.join(directory, `staged-${index}`), output.bytes);
      records.push({ target: relative, existed: original != null, backup, expected: sha256(output.bytes) });
    }
    return records;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function publishPreparedTransaction({ root, journal, entry, records, outputs, atomicReplaceImpl, commitJournalReplaceImpl }) {
  for (const [index, output] of outputs.entries()) await atomicReplaceImpl(output.target, output.bytes, index + 1);
  for (const record of records) {
    if (sha256(await readFile(contained(root, record.target))) !== record.expected) throw new Error("transaction hash mismatch");
  }
  await commitJournalReplaceImpl(journal, Buffer.from(JSON.stringify({ ...entry, state: "COMMITTED" }), "utf8"), "COMMITTED");
  await syncDirectory(path.dirname(journal));
}

async function recoverFailedCommit({ root, rollbackAtomicReplaceImpl }) {
  try {
    return await recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot: root, atomicReplaceImpl: rollbackAtomicReplaceImpl });
  } catch {
    throw new Error("RECOVERY_REQUIRED");
  }
}

async function commitTransaction({ repositoryRoot, outputs, atomicReplaceImpl = atomicReplace, rollbackAtomicReplaceImpl = atomicReplace, commitJournalReplaceImpl = atomicReplace, cleanupTransactionDirectoryImpl = (directory) => rm(directory, { recursive: true, force: true }), syncTransactionDirectoryImpl = syncDirectory }) {
  const { root, journal } = transactionPaths(repositoryRoot);
  await recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot: root });
  const directory = path.join(root, "tools/datapack", `.kric-standard-registration-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const records = await stageTransactionOutputs({ root, directory, outputs });
  await syncTransactionDirectoryImpl(directory);
  const entry = { state: "PREPARED", transactionDirectory: path.relative(root, directory), records };
  await atomicReplace(journal, Buffer.from(JSON.stringify(entry)));
  try {
    await publishPreparedTransaction({ root, journal, entry, records, outputs, atomicReplaceImpl, commitJournalReplaceImpl });
  } catch (error) {
    const recovery = await recoverFailedCommit({ root, rollbackAtomicReplaceImpl });
    if (recovery === "COMMITTED") return;
    throw error;
  }
  try { await rm(journal, { force: true }); await syncDirectory(path.dirname(journal)); } catch { /* COMMITTED journal is durable recovery authority */ }
  try { await cleanupTransactionDirectoryImpl(directory); } catch { /* committed journal is absent or durable; orphan is harmless */ }
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function requiredSha256(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be SHA-256`);
  return value;
}

function readStagedSnapshot(bytes, expectedSha256) {
  requiredSha256(expectedSha256, "snapshot file SHA-256");
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("snapshot file SHA-256 mismatch");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(bytes);
  } catch {
    throw new Error("snapshot file is invalid JSON");
  }
  return validateKricAccessibilitySnapshotIdentity(snapshot);
}

function readStagedSeoulSnapshot(bytes, expectedSha256) {
  requiredSha256(expectedSha256, "Seoul snapshot file SHA-256");
  if (sha256(bytes) !== expectedSha256) throw new Error("Seoul snapshot file SHA-256 mismatch");
  try {
    return validateSeoulAccessibilitySnapshotIdentity(JSON.parse(bytes));
  } catch {
    throw new Error("Seoul snapshot file is invalid");
  }
}

function validateReceipt(snapshot, receipt, now) {
  const capturedAt = Date.parse(snapshot.capturedAt);
  const freshUntil = Date.parse(snapshot.freshUntil);
  if (!Number.isFinite(capturedAt) || capturedAt > now.getTime()
    || !Number.isFinite(freshUntil) || freshUntil <= now.getTime() || freshUntil !== capturedAt + 86_400_000) {
    throw new Error("snapshot.freshUntil must be fresh");
  }
  requiredCredentialFreeObjectUri(receipt?.rawObjectUri, "raw receipt URI");
  requiredSha256(receipt?.rawObjectSha256, "raw receipt SHA-256");
  if (receipt?.sourceId !== snapshot.sourceId || receipt?.snapshotId !== snapshot.snapshotId
    || receipt?.snapshotRawSha256 !== snapshot.rawSha256 || receipt?.capturedAt !== snapshot.capturedAt
    || receipt?.snapshotFileSha256 == null) {
    throw new Error("raw receipt snapshot binding is invalid");
  }
  if (!Number.isInteger(receipt?.byteSize) || receipt.byteSize < 1) throw new Error("raw receipt byteSize is invalid");
  const storedAt = Date.parse(requiredText(receipt?.storedAt, "raw receipt storedAt"));
  if (!Number.isFinite(storedAt) || storedAt > now.getTime()) {
    throw new Error("raw receipt storedAt is invalid");
  }
  if (storedAt < capturedAt) {
    throw new Error("raw receipt storedAt precedes snapshot capture");
  }
  const rawRetentionExpiresAt = Date.parse(requiredText(receipt?.rawRetentionExpiresAt, "raw receipt rawRetentionExpiresAt"));
  if (!Number.isFinite(rawRetentionExpiresAt)
    || rawRetentionExpiresAt <= freshUntil || rawRetentionExpiresAt <= storedAt) {
    throw new Error("raw receipt rawRetentionExpiresAt is invalid");
  }
}

async function validateAdmittedSeoulSnapshot({ inventory, snapshots, input, seoulSnapshot, repositoryRoot, now }) {
  const sources = inventory?.sources?.filter(({ id }) => id === SEOUL_SOURCE_ID) ?? [];
  if (sources.length !== 1) throw new Error("Seoul snapshot admission is invalid");
  const source = sources[0];
  const evidence = source.accessibilityAdmissionEvidence;
  const expected = {
    schemaVersion: 1,
    artifactKind: "seoul-accessibility-snapshot",
    sourceId: SEOUL_SOURCE_ID,
    snapshotId: evidence?.snapshotId,
    capturedAt: evidence?.capturedAt,
    observedAt: evidence?.observedAt,
    freshUntil: evidence?.freshUntil,
    absenceEvidenceMode: evidence?.absenceEvidenceMode,
    rawSha256: evidence?.rawSha256,
    contentSha256: evidence?.contentSha256,
    schemaFingerprint: evidence?.schemaFingerprint,
  };
  if (Object.values(expected).some((value) => value === undefined)
    || !Object.entries(expected).every(([field, value]) => seoulSnapshot?.[field] === value)
    || !SHA256.test(evidence?.snapshotFileSha256 ?? "")
    || sha256(JSON.stringify(seoulSnapshot?.stations)) !== evidence.contentSha256) {
    throw new Error("Seoul snapshot admission is invalid");
  }
  const capturedAt = Date.parse(evidence.capturedAt);
  const freshUntil = Date.parse(evidence.freshUntil);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(freshUntil)
    || freshUntil !== capturedAt + 86_400_000 || freshUntil <= now.getTime()) {
    throw new Error("Seoul snapshot admission freshness is invalid");
  }
  let admitted;
  let bytes;
  try {
    bytes = await readFile(contained(path.resolve(repositoryRoot), requiredText(evidence?.snapshotPath, "Seoul snapshot path")));
    admitted = JSON.parse(bytes);
  } catch {
    throw new Error("Seoul snapshot admission is invalid");
  }
  if (sha256(bytes) !== evidence.snapshotFileSha256 || !isDeepStrictEqual(seoulSnapshot, admitted)) {
    throw new Error("Seoul snapshot admission is invalid");
  }
  const ledger = snapshots?.filter(({ sourceId, snapshotId }) =>
    sourceId === SEOUL_SOURCE_ID && snapshotId === evidence.snapshotId) ?? [];
  if (ledger.length !== 1 || ledger[0].retrievedAt !== seoulSnapshot.capturedAt
    || ledger[0].sourceUpdatedAt !== seoulSnapshot.observedAt
    || source.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || evidence.decision !== "APPROVED" || evidence.productionUseAllowed !== true
    || !["LOCKED", "SUCCESS", "PASS", "PASS"].every((value, index) =>
      [ledger[0].snapshotStatus, ledger[0].fetchStatus, ledger[0].schemaStatus, ledger[0].licenseStatus][index] === value)
    || ledger[0].redistributionAllowed !== true
    || !Number.isFinite(Date.parse(ledger[0].freshnessExpiresAt)) || Date.parse(ledger[0].freshnessExpiresAt) <= now.getTime()) {
    throw new Error("Seoul snapshot admission is invalid");
  }
  return input;
}

function rosterTuple(value) {
  if (!value || !["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd"].every((field) =>
    typeof value[field] === "string" && value[field] !== "")) {
    throw new Error("KRIC accessibility roster is invalid");
  }
  return Object.fromEntries(["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd"].map((field) => [field, value[field]]));
}

function rosterKey(tuple) { return [tuple.stationId, tuple.lineId, tuple.railOprIsttCd, tuple.lnCd, tuple.stinCd].join("\0"); }

function sortedUniqueRoster(values) {
  const roster = values.map(rosterTuple);
  const keys = new Set(roster.map(rosterKey));
  if (keys.size !== roster.length) throw new Error("KRIC accessibility roster is invalid");
  return roster.sort((left, right) => rosterKey(left) < rosterKey(right) ? -1 : rosterKey(left) > rosterKey(right) ? 1 : 0);
}

function deriveKricAccessibilityRoster(input) {
  const mappings = new Map((input.stationMappings ?? []).map((mapping) => [
    [mapping.sourceId, mapping.sourceStationCode, mapping.lineId].join("\0"), mapping.stationId,
  ]));
  const tuples = (input.facilityRows ?? [])
    .filter(({ sourceId }) => sourceId === SOURCE_ID)
    .map((row) => {
      const [railOprIsttCd, lnCd, stinCd] = String(row.providerFacilityRef ?? "").split(":");
      return {
        stationId: mappings.get([row.station?.sourceId, row.station?.sourceStationCode, row.station?.lineId].join("\0")),
        lineId: row.station?.lineId,
        railOprIsttCd,
        lnCd,
        stinCd,
      };
    });
  return sortedUniqueRoster([...new Map(tuples.map((tuple) => [rosterKey(tuple), tuple])).values()]);
}

function validateKricAccessibilityCoverage(snapshot, input) {
  const roster = Array.isArray(input.kricStandardAccessibilityRoster)
    ? sortedUniqueRoster(input.kricStandardAccessibilityRoster)
    : deriveKricAccessibilityRoster(input);
  const includedStations = new Set(input.supportedV1Scope?.includedStationIds);
  const includedLines = new Set(input.supportedV1Scope?.includedLineIds);
  const mappings = new Map((input.stationMappings ?? []).map((mapping) => [
    [mapping.sourceId, mapping.sourceStationCode, mapping.lineId].join("\0"), mapping.stationId,
  ]));
  const supported = new Set();
  for (const row of input.stationLineRows ?? []) {
    const station = row.station ?? row;
    const lineId = station?.lineId;
    const mappedStationId = mappings.get([station?.sourceId, station?.sourceStationCode, lineId].join("\0"));
    if (includedLines.has(lineId) && (typeof mappedStationId !== "string" || mappedStationId === "")) {
      throw new Error("KRIC accessibility scope mapping is invalid");
    }
    if (!includedLines.has(lineId) || !includedStations.has(mappedStationId)) continue;
    supported.add(`${mappedStationId}\0${lineId}`);
  }
  const rosterStations = new Set(roster.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  const supportedStationProjection = new Set([...supported].map((stationLine) => stationLine.split("\0")[0]));
  const supportedLineProjection = new Set([...supported].map((stationLine) => stationLine.split("\0")[1]));
  if (supported.size === 0 || supported.size !== rosterStations.size
    || [...supported].some((stationLine) => !rosterStations.has(stationLine))
    || supportedStationProjection.size !== includedStations.size || [...includedStations].some((stationId) => !supportedStationProjection.has(stationId))
    || supportedLineProjection.size !== includedLines.size || [...includedLines].some((lineId) => !supportedLineProjection.has(lineId))) {
    throw new Error("KRIC accessibility roster coverage is invalid");
  }
  const queryRoster = sortedUniqueRoster(snapshot.queries ?? []);
  const rosterKeys = new Set(roster.map(rosterKey));
  if (roster.some((tuple) => !queryRoster.some((query) => rosterKey(query) === rosterKey(tuple)))
    || queryRoster.some((tuple) => rosterStations.has(`${tuple.stationId}\0${tuple.lineId}`) && !rosterKeys.has(rosterKey(tuple)))) {
    throw new Error("KRIC accessibility snapshot coverage is invalid");
  }
  return roster;
}

function ledgerRawReceipt(receipt) {
  return {
    sourceId: receipt.sourceId,
    snapshotId: receipt.snapshotId,
    snapshotRawSha256: receipt.snapshotRawSha256,
    capturedAt: receipt.capturedAt,
    snapshotFileSha256: receipt.snapshotFileSha256,
    rawObjectSha256: receipt.rawObjectSha256,
    byteSize: receipt.byteSize,
    storedAt: receipt.storedAt,
  };
}

function buildSeoulRegistration({
  inventory, snapshots, snapshot, snapshotPath, snapshotFileSha256, rawReceipt,
  freshnessExpiresAt, governancePolicySha256, governancePolicyVersion,
}) {
  const source = inventory?.sources?.find(({ id }) => id === SEOUL_SOURCE_ID);
  if (!source) throw new Error("Seoul production source inventory entry is missing");
  const previousId = validateLineage(snapshots).headsBySource[SEOUL_SOURCE_ID];
  const previous = snapshots.find(({ snapshotId }) => snapshotId === previousId);
  if (!previous || snapshot.previousSnapshotId !== previous.snapshotId) {
    throw new Error("Seoul snapshot lineage is invalid");
  }
  const nextLedger = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: snapshot.snapshotId,
    sourceId: SEOUL_SOURCE_ID,
    provider: source.provider,
    retrievedAt: snapshot.capturedAt,
    sourceUpdatedAt: snapshot.observedAt,
    rowCount: snapshot.stations.length,
    coverageCount: snapshot.stations.length,
    rawSha256: rawReceipt.rawObjectSha256,
    rawObjectUri: rawReceipt.rawObjectUri,
    rawReceipt: ledgerRawReceipt(rawReceipt),
    contentSha256: snapshot.contentSha256,
    redactedRequestFingerprint: previous.redactedRequestFingerprint,
    schemaFingerprint: snapshot.schemaFingerprint,
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    previousSnapshotId: previous.snapshotId,
    freshnessExpiresAt,
    rawRetentionExpiresAt: rawReceipt.rawRetentionExpiresAt,
    providerRecordHashes: snapshot.stations.map((station) => sha256(JSON.stringify(station))),
    governancePolicyVersion,
    governancePolicySha256,
  };
  nextLedger.diffSummary = buildSnapshotDiff(previous, nextLedger);
  const nextSource = inventory.sources.find(({ id }) => id === SEOUL_SOURCE_ID);
  nextSource.productionUseAllowed = true;
  nextSource.retrievedAt = snapshot.capturedAt.slice(0, 10);
  nextSource.observedDataUpdatedAt = snapshot.observedAt.slice(0, 10);
  nextSource.accessibilityAdmissionEvidence = {
    ...nextSource.accessibilityAdmissionEvidence,
    productionUseAllowed: true,
    snapshotId: snapshot.snapshotId,
    snapshotPath,
    capturedAt: snapshot.capturedAt,
    observedAt: snapshot.observedAt,
    freshUntil: snapshot.freshUntil,
    absenceEvidenceMode: snapshot.absenceEvidenceMode,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
    schemaFingerprint: snapshot.schemaFingerprint,
    snapshotFileSha256,
  };
  nextSource.admissionEvidence = {
    ...nextSource.admissionEvidence,
    productionUseNoteKo: `fresh Seoul accessibility snapshot ${snapshot.snapshotId} registration verified.`,
  };
  return nextLedger;
}

function stageRegistries({ inventory, snapshots, input, snapshot, snapshotPath, snapshotFileSha256, rawReceipt, seoulSnapshot, seoulRegistration, kricAccessibilityRoster, freshnessExpiresAt, governancePolicySha256, governancePolicyVersion, now }) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  if (!source) throw new Error("production source inventory entry is missing");
  const previousId = validateLineage(snapshots).headsBySource[SOURCE_ID];
  if (!previousId) throw new Error("source snapshot lineage is missing");
  const previous = snapshots.find(({ snapshotId }) => snapshotId === previousId);
  const nextLedger = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    snapshotId: snapshot.snapshotId,
    sourceId: SOURCE_ID,
    provider: source.provider,
    retrievedAt: snapshot.capturedAt,
    sourceUpdatedAt: snapshot.observedAt,
    rowCount: snapshot.rowCount,
    coverageCount: snapshot.queryCount,
    rawSha256: rawReceipt.rawObjectSha256,
    rawObjectUri: rawReceipt.rawObjectUri,
    rawReceipt: ledgerRawReceipt(rawReceipt),
    contentSha256: snapshot.contentSha256,
    redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
    schemaFingerprint: snapshot.schemaFingerprint,
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    previousSnapshotId: previous.snapshotId,
    freshnessExpiresAt,
    rawRetentionExpiresAt: rawReceipt.rawRetentionExpiresAt,
    adminReviewRecordHash: source.admissionEvidence?.adminReviewRecordHash,
    governancePolicySha256,
    governancePolicyVersion,
  };
  nextLedger.diffSummary = buildSnapshotDiff(previous, nextLedger);
  const nextInventory = structuredClone(inventory);
  const nextSource = nextInventory.sources.find(({ id }) => id === SOURCE_ID);
  nextSource.productionUseAllowed = true;
  nextSource.retrievedAt = snapshot.capturedAt.slice(0, 10);
  nextSource.observedDataUpdatedAt = snapshot.observedAt.slice(0, 10);
  nextSource.accessibilityAdmissionEvidence = {
    ...nextSource.accessibilityAdmissionEvidence,
    productionUseAllowed: true,
    snapshotId: snapshot.snapshotId,
    snapshotPath,
    capturedAt: snapshot.capturedAt,
    observedAt: snapshot.observedAt,
    freshUntil: snapshot.freshUntil,
    absenceEvidenceMode: snapshot.absenceEvidenceMode,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
    schemaFingerprint: snapshot.schemaFingerprint,
    snapshotFileSha256,
  };
  if (nextSource.accessibilityAdmissionEvidence.absenceEvidenceMode !== snapshot.absenceEvidenceMode) {
    throw new Error("KRIC accessibility evidence mode mismatch");
  }
  nextSource.admissionEvidence = {
    ...nextSource.admissionEvidence,
    productionUseNoteKo: `fresh KRIC standard snapshot ${snapshot.snapshotId} registration verified.`,
  };
  const seoulLedger = seoulRegistration == null ? null : buildSeoulRegistration({
    inventory: nextInventory,
    snapshots,
    snapshot: seoulSnapshot,
    ...seoulRegistration,
    governancePolicySha256,
    governancePolicyVersion,
  });
  const nextSnapshots = [...snapshots, ...(seoulLedger == null ? [] : [seoulLedger]), nextLedger];
  validateLineage(nextSnapshots);
  if (input == null) return [nextInventory, nextSnapshots].map((value) => `${JSON.stringify(value, null, 2)}\n`);
  const nextInput = materializeAccessibilitySourceInput({
    input: { ...structuredClone(input), kricStandardAccessibilityRoster: kricAccessibilityRoster },
    kricSnapshot: snapshot, seoulSnapshot,
  });
  nextInput.kricStandardAccessibilitySnapshot = {
    snapshotId: snapshot.snapshotId,
    contentSha256: snapshot.contentSha256,
    freshUntil: snapshot.freshUntil,
  };
  nextInput.kricStandardAccessibilityRoster = kricAccessibilityRoster;
  const kricRows = nextInput.facilityRows.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const kricStatus = nextInput.accessibilityStatusEvidence.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const seoulStatus = nextInput.accessibilityStatusEvidence.filter(({ sourceId }) => sourceId === SEOUL_SOURCE_ID);
  if (kricRows.length === 0
    || [...kricRows, ...kricStatus].some(({ sourceSnapshotId }) => sourceSnapshotId !== snapshot.snapshotId)
    || seoulStatus.length === 0
    || seoulStatus.some(({ sourceSnapshotId }) => sourceSnapshotId !== seoulSnapshot.snapshotId)) {
    throw new Error("materialized KRIC snapshot identity is invalid");
  }
  return [nextInventory, nextSnapshots, nextInput].map((value) => `${JSON.stringify(value, null, 2)}\n`);
}

async function prepareProducerNeutralFullRegistration({ repositoryRoot, snapshotFilePath, snapshotFileSha256, snapshotTargetPath, rawReceipt, capitalFacilityPlanPath, capitalCanonicalPackPath, now }) {
  await recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot });
  const [snapshotFile, planFile, canonicalFile, inventoryBytes, ledgerBytes] = await Promise.all([
    readRegularSnapshot(snapshotFilePath, "snapshot file"),
    readRegularSnapshot(capitalFacilityPlanPath, "capital FACILITY plan"),
    readRegularSnapshot(capitalCanonicalPackPath, "capital canonical pack"),
    readRegularSnapshot(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "source inventory"),
    readRegularSnapshot(path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json"), "source snapshot ledger"),
  ]);
  const { bytes: snapshotBytes } = snapshotFile;
  const { bytes: planBytes } = planFile;
  const { bytes: canonicalBytes } = canonicalFile;
  const snapshot = readStagedSnapshot(snapshotBytes, snapshotFileSha256);
  if (snapshot.sourceId !== SOURCE_ID) throw new Error("capital FACILITY snapshot source is invalid");
  let plan;
  try {
    plan = JSON.parse(planBytes);
  } catch {
    throw new Error("capital FACILITY plan is invalid JSON");
  }
  let canonicalPack;
  try {
    canonicalPack = JSON.parse(canonicalBytes);
  } catch {
    throw new Error("capital canonical pack is invalid JSON");
  }
  let mappings;
  try {
    mappings = validateCurrentCapitalFacilityPlanAndCanonicalPack({
      plan, planBytes, pack: canonicalPack, canonicalPackBytes: canonicalBytes,
    });
  } catch (error) {
    throw new Error("capital FACILITY full registration identity mismatch", { cause: error });
  }
  if (snapshot.queryCount !== 213) {
    throw new Error("capital FACILITY full registration identity mismatch");
  }
  const expected = new Set(mappings.map((mapping) => [
    mapping.stationId, mapping.lineId, mapping.providerOperatorId, mapping.providerLineId, mapping.providerStationId,
  ].join("\0")));
  const actual = new Set(snapshot.queries.map((query) => [
    query.stationId, query.lineId, query.railOprIsttCd, query.lnCd, query.stinCd,
  ].join("\0")));
  if (expected.size !== 213 || actual.size !== 213 || [...expected].some((key) => !actual.has(key))) {
    throw new Error("capital FACILITY snapshot tuple coverage mismatch");
  }
  if (rawReceipt?.snapshotFileSha256 !== snapshotFileSha256) {
    throw new Error("raw receipt snapshot binding is invalid");
  }
  validateReceipt(snapshot, rawReceipt, now);
  const governance = await readGovernancePolicy(repositoryRoot, snapshot, rawReceipt);
  const freshness = await readFreshnessPolicy(repositoryRoot);
  const inventory = JSON.parse(inventoryBytes.bytes);
  const snapshots = JSON.parse(ledgerBytes.bytes);
  const { policySources } = validateSourceGovernancePolicy({
    policy: governance.policy,
    inventory,
    freshnessPolicy: freshness.policy,
  });
  validateLicenseGovernance({ inventory, policySources, sourceId: SOURCE_ID, label: "KRIC", now });
  requiredSha256(inventory.sources.find(({ id }) => id === SOURCE_ID)?.admissionEvidence?.adminReviewRecordHash, "KRIC admin review record hash");
  const relative = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  if (path.resolve(snapshotTargetPath) !== path.join(path.resolve(repositoryRoot), relative)) {
    throw new Error("snapshot target path is invalid");
  }
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: freshness.policy,
    sourceClassId: policySources.get(SOURCE_ID).sourceClassId,
    basisAt: snapshot.capturedAt,
    evaluationAt: now.toISOString(),
  });
  const staged = stageRegistries({
    inventory,
    snapshots,
    input: null,
    snapshot,
    snapshotPath: relative,
    snapshotFileSha256,
    rawReceipt,
    freshnessExpiresAt,
    governancePolicySha256: sha256(governance.bytes),
    governancePolicyVersion: governance.version,
    now,
  });
  const existing = await readOptionalRegularSnapshot(snapshotTargetPath, "snapshot target");
  if (existing && !existing.bytes.equals(snapshotBytes)) {
    throw new Error("snapshot target already exists with different bytes");
  }
  const rechecked = await Promise.all([
    readRegularSnapshot(snapshotFilePath, "snapshot file"),
    readRegularSnapshot(capitalFacilityPlanPath, "capital FACILITY plan"),
    readRegularSnapshot(capitalCanonicalPackPath, "capital canonical pack"),
    readRegularSnapshot(path.join(repositoryRoot, "tools/datapack/source-inventory.json"), "source inventory"),
    readRegularSnapshot(path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json"), "source snapshot ledger"),
    readRegularSnapshot(path.join(repositoryRoot, "tools/datapack/source-governance-policy.json"), "source governance policy"),
    readRegularSnapshot(path.join(repositoryRoot, "release/product-gates/datapack-freshness-sla.json"), "datapack freshness SLA"),
  ]);
  if (![snapshotBytes, planBytes, canonicalBytes, inventoryBytes.bytes, ledgerBytes.bytes, governance.bytes, freshness.bytes]
    .every((bytes, index) => bytes.equals(rechecked[index].bytes))) {
    throw new Error("capital FACILITY full registration input changed during preparation");
  }
  if (existing) {
    const recheckedTarget = await readRegularSnapshot(snapshotTargetPath, "snapshot target");
    if (!existing.bytes.equals(recheckedTarget.bytes)) {
      throw new Error("snapshot target changed during preparation");
    }
  }
  return [
    ...(!existing ? [{ target: snapshotTargetPath, bytes: snapshotBytes }] : []),
    { target: path.join(repositoryRoot, "tools/datapack/source-inventory.json"), bytes: Buffer.from(staged[0]) },
    { target: path.join(repositoryRoot, "tools/datapack/release/source-snapshots.json"), bytes: Buffer.from(staged[1]) },
  ];
}

function resolveRegistryPaths(repositoryRoot, registryPaths) {
  const root = path.resolve(repositoryRoot);
  const paths = [
    registryPaths?.["tools/datapack/source-inventory.json"],
    registryPaths?.["tools/datapack/release/source-snapshots.json"],
    registryPaths?.["tools/datapack/inputs/capital-pilot-production-source-input.json"],
  ].map((file) => requiredText(file, "registry path"));
  const expectedPaths = [
    path.join(root, "tools/datapack/source-inventory.json"),
    path.join(root, "tools/datapack/release/source-snapshots.json"),
    path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json"),
  ];
  if (paths.some((file, index) => path.resolve(file) !== expectedPaths[index])) throw new Error("registry path is invalid");
  return paths;
}

async function readGovernancePolicy(repositoryRoot, snapshot, rawReceipt) {
  const { bytes } = await readRegularSnapshot(path.join(path.resolve(repositoryRoot), "tools/datapack/source-governance-policy.json"), "source governance policy");
  let policy;
  try { policy = JSON.parse(bytes); } catch { throw new Error("source governance policy is invalid"); }
  const expectedRawRetentionExpiresAt = deriveRawRetentionExpiresAt({
    policy,
    sourceId: SOURCE_ID,
    retrievedAt: snapshot.capturedAt,
  });
  if (rawReceipt.rawRetentionExpiresAt !== expectedRawRetentionExpiresAt) {
    throw new Error("raw receipt rawRetentionExpiresAt does not match governance policy");
  }
  return { bytes, policy, version: requiredText(policy.policyVersion, "governance policy version") };
}

async function readFreshnessPolicy(repositoryRoot) {
  const { bytes } = await readRegularSnapshot(path.join(path.resolve(repositoryRoot), "release/product-gates/datapack-freshness-sla.json"), "datapack freshness SLA");
  try { return { bytes, policy: JSON.parse(bytes) }; } catch { throw new Error("datapack freshness SLA is invalid"); }
}

function validateLicenseGovernance({ inventory, policySources, sourceId, label, now }) {
  const source = inventory?.sources?.find(({ id }) => id === sourceId);
  const entry = policySources.get(sourceId);
  const review = entry?.licenseReview;
  const reviewedAt = Date.parse(review?.reviewedAt);
  const nextReviewAt = Date.parse(review?.nextReviewAt);
  if (!source || review?.status !== "APPROVED"
    || review.termsHash !== source.admissionEvidence?.licenseEvidenceHash
    || review.reviewedProvider !== source.provider || review.reviewedDatasetUrl !== source.datasetUrl
    || review.approvedByRole !== entry?.approvalRole
    || !Number.isFinite(reviewedAt) || !Number.isFinite(nextReviewAt) || reviewedAt > now.getTime() || nextReviewAt <= now.getTime()
    || source.license?.redistributionAllowed !== true || !review.redistributionScopes?.includes("DERIVED_DATAPACK")) {
    throw new Error(`${label} license governance is invalid`);
  }
}

async function readOptionalFile(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalRegularSnapshot(file, label) {
  try {
    return await readRegularSnapshot(file, label);
  } catch (error) {
    if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareSeoulRegistration({
  repositoryRoot,
  inventory,
  snapshots,
  input,
  governancePolicy,
  freshnessPolicy,
  policySources,
  seoulSnapshot,
  seoulSnapshotFilePath,
  seoulSnapshotFileSha256,
  seoulSnapshotTargetPath,
  seoulRawReceipt,
  now,
}) {
  const freshValues = [
    seoulSnapshotFilePath, seoulSnapshotFileSha256, seoulSnapshotTargetPath, seoulRawReceipt,
  ];
  const freshRequested = freshValues.every((value) => value != null);
  if (!freshRequested) {
    if (freshValues.some((value) => value != null)) throw new Error("fresh Seoul registration inputs are incomplete");
    await validateAdmittedSeoulSnapshot({ inventory, snapshots, input, seoulSnapshot, repositoryRoot, now });
    return { snapshot: seoulSnapshot, registration: null, snapshotBytes: null, targetBytes: null };
  }

  const snapshotBytes = await readFile(requiredText(seoulSnapshotFilePath, "Seoul snapshot file path"));
  const snapshot = readStagedSeoulSnapshot(snapshotBytes, seoulSnapshotFileSha256);
  if (seoulRawReceipt?.snapshotFileSha256 !== seoulSnapshotFileSha256) {
    throw new Error("Seoul raw receipt snapshot binding is invalid");
  }
  validateReceipt(snapshot, seoulRawReceipt, now);
  const snapshotPath = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  const expectedTargetPath = path.join(path.resolve(repositoryRoot), snapshotPath);
  if (!path.isAbsolute(requiredText(seoulSnapshotTargetPath, "Seoul snapshot target path"))
    || path.resolve(seoulSnapshotTargetPath) !== expectedTargetPath) {
    throw new Error("Seoul snapshot target path is invalid");
  }
  const expectedRetention = deriveRawRetentionExpiresAt({
    policy: governancePolicy.policy,
    sourceId: SEOUL_SOURCE_ID,
    retrievedAt: snapshot.capturedAt,
  });
  if (seoulRawReceipt.rawRetentionExpiresAt !== expectedRetention) {
    throw new Error("Seoul raw receipt rawRetentionExpiresAt does not match governance policy");
  }
  validateLicenseGovernance({ inventory, policySources, sourceId: SEOUL_SOURCE_ID, label: "Seoul", now });
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: freshnessPolicy,
    sourceClassId: policySources.get(SEOUL_SOURCE_ID).sourceClassId,
    basisAt: snapshot.capturedAt,
    evaluationAt: now.toISOString(),
  });
  const targetBytes = await readOptionalFile(seoulSnapshotTargetPath);
  if (targetBytes != null && !targetBytes.equals(snapshotBytes)) {
    throw new Error("Seoul snapshot target already exists with different bytes");
  }
  return {
    snapshot,
    snapshotBytes,
    targetBytes,
    registration: {
      snapshotPath,
      snapshotFileSha256: seoulSnapshotFileSha256,
      rawReceipt: seoulRawReceipt,
      freshnessExpiresAt,
    },
  };
}

async function prepareRegistration({
  repositoryRoot, paths, snapshotFilePath, snapshotFileSha256, snapshotTargetPath,
  rawReceipt, seoulSnapshot, seoulSnapshotFilePath, seoulSnapshotFileSha256,
  seoulSnapshotTargetPath, seoulRawReceipt, now,
}) {
  await recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot });
  const [snapshotBytes, ...original] = await Promise.all([
    readFile(requiredText(snapshotFilePath, "snapshot file path")),
    ...paths.map((file) => readFile(file)),
  ]);
  const snapshot = readStagedSnapshot(snapshotBytes, snapshotFileSha256);
  if (snapshot.providerResultCode === "MIXED") {
    throw new Error("mixed KRIC snapshot requires producer-neutral full registration");
  }
  if (rawReceipt?.snapshotFileSha256 !== snapshotFileSha256) throw new Error("raw receipt snapshot binding is invalid");
  validateReceipt(snapshot, rawReceipt, now);
  const governancePolicy = await readGovernancePolicy(repositoryRoot, snapshot, rawReceipt);
  const freshnessPolicy = (await readFreshnessPolicy(repositoryRoot)).policy;
  const snapshotPath = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  const expectedSnapshotTargetPath = path.join(path.resolve(repositoryRoot), snapshotPath);
  if (!path.isAbsolute(requiredText(snapshotTargetPath, "snapshot target path"))
    || path.resolve(snapshotTargetPath) !== expectedSnapshotTargetPath) {
    throw new Error("snapshot target path is invalid");
  }
  const [inventory, snapshots, input] = original.map((bytes) => JSON.parse(bytes));
  const { policySources } = validateSourceGovernancePolicy({ policy: governancePolicy.policy, inventory, freshnessPolicy });
  validateLicenseGovernance({ inventory, policySources, sourceId: SOURCE_ID, label: "KRIC", now });
  const preparedSeoul = await prepareSeoulRegistration({
    repositoryRoot,
    inventory,
    snapshots,
    input,
    governancePolicy,
    freshnessPolicy,
    policySources,
    seoulSnapshot,
    seoulSnapshotFilePath,
    seoulSnapshotFileSha256,
    seoulSnapshotTargetPath,
    seoulRawReceipt,
    now,
  });
  const kricAccessibilityRoster = validateKricAccessibilityCoverage(snapshot, input);
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: freshnessPolicy,
    sourceClassId: policySources.get(SOURCE_ID).sourceClassId,
    basisAt: snapshot.capturedAt,
    evaluationAt: now.toISOString(),
  });
  const staged = stageRegistries({
    inventory, snapshots, input,
    snapshot,
    snapshotPath,
    snapshotFileSha256,
    rawReceipt,
    seoulSnapshot: preparedSeoul.snapshot,
    seoulRegistration: preparedSeoul.registration,
    kricAccessibilityRoster,
    freshnessExpiresAt,
    governancePolicySha256: sha256(governancePolicy.bytes), governancePolicyVersion: governancePolicy.version, now,
  });
  const targetBytes = await readOptionalFile(snapshotTargetPath);
  if (targetBytes != null && !targetBytes.equals(snapshotBytes)) throw new Error("snapshot target already exists with different bytes");
  return [
    ...(preparedSeoul.registration != null && preparedSeoul.targetBytes == null
      ? [{ target: seoulSnapshotTargetPath, bytes: preparedSeoul.snapshotBytes }]
      : []),
    ...(targetBytes == null ? [{ target: snapshotTargetPath, bytes: snapshotBytes }] : []),
    ...paths.map((target, index) => ({ target, bytes: Buffer.from(staged[index]) })),
  ];
}

function asError(value, message) {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function handleReleaseFailure(registrationError, releaseError) {
  const normalizedReleaseError = asError(releaseError, "KRIC registration lock RECOVERY_REQUIRED");
  if (!registrationError) throw normalizedReleaseError;
  if (registrationError instanceof Error) {
    registrationError.cause = registrationError.cause === undefined
      ? normalizedReleaseError
      : new AggregateError([
        asError(registrationError.cause, "registration failure cause"), normalizedReleaseError,
      ], "registration and lock recovery causes");
    return;
  }
  throw new AggregateError([
    asError(registrationError, "registration failed"), normalizedReleaseError,
  ], "registration failed and KRIC registration lock RECOVERY_REQUIRED");
}

export async function registerKricStandardAccessibilitySnapshot({
  snapshotFilePath,
  snapshotFileSha256,
  snapshotTargetPath,
  rawReceipt,
  seoulSnapshot,
  seoulSnapshotFilePath,
  seoulSnapshotFileSha256,
  seoulSnapshotTargetPath,
  seoulRawReceipt,
  capitalFacilityPlanPath,
  capitalCanonicalPackPath,
  producerNeutralFullRegistration = false,
  registryPaths,
  repositoryRoot = REPOSITORY_ROOT,
  now = new Date(),
  atomicReplaceImpl = atomicReplace,
  rollbackAtomicReplaceImpl = atomicReplace,
  commitJournalReplaceImpl,
  cleanupTransactionDirectoryImpl,
  syncTransactionDirectoryImpl,
  onLockAcquired,
} = {}) {
  if (producerNeutralFullRegistration !== true && producerNeutralFullRegistration !== false) throw new Error("producer neutral full registration is invalid");
  if (producerNeutralFullRegistration && (!capitalFacilityPlanPath || !capitalCanonicalPackPath)) throw new Error("producer neutral full registration inputs are incomplete");
  if (producerNeutralFullRegistration && (seoulSnapshot != null || seoulSnapshotFilePath != null || seoulSnapshotFileSha256 != null || seoulSnapshotTargetPath != null || seoulRawReceipt != null || registryPaths != null)) throw new Error("producer neutral full registration inputs are invalid");
  const paths = producerNeutralFullRegistration ? null : resolveRegistryPaths(repositoryRoot, registryPaths);
  const releaseLock = await acquireRegistrationLock(repositoryRoot);
  let registrationError;
  try {
    await onLockAcquired?.();
    const outputs = producerNeutralFullRegistration ? await prepareProducerNeutralFullRegistration({ repositoryRoot, snapshotFilePath, snapshotFileSha256, snapshotTargetPath, rawReceipt, capitalFacilityPlanPath, capitalCanonicalPackPath, now }) : await prepareRegistration({
      repositoryRoot, paths, snapshotFilePath, snapshotFileSha256, snapshotTargetPath,
      rawReceipt,
      seoulSnapshot,
      seoulSnapshotFilePath,
      seoulSnapshotFileSha256,
      seoulSnapshotTargetPath,
      seoulRawReceipt,
      now,
    });
    await commitTransaction({
      repositoryRoot,
      atomicReplaceImpl,
      rollbackAtomicReplaceImpl,
      commitJournalReplaceImpl,
      cleanupTransactionDirectoryImpl,
      syncTransactionDirectoryImpl,
      outputs,
    });
  } catch (error) {
    registrationError = error;
    throw error;
  } finally {
    try { await releaseLock(); } catch (releaseError) {
      handleReleaseFailure(registrationError, releaseError);
    }
  }
}

export function parseKricStandardAccessibilitySnapshotRegistrationArgs(args) {
  const options = { repositoryRoot: REPOSITORY_ROOT };
  const seen = new Set();
  const names = new Map([
    ["--repository-root", "repositoryRoot"], ["--snapshot", "snapshotFilePath"],
    ["--snapshot-sha256", "snapshotFileSha256"], ["--raw-receipt", "rawReceiptPath"],
    ["--seoul-snapshot", "seoulSnapshotPath"],
    ["--seoul-snapshot-sha256", "seoulSnapshotFileSha256"],
    ["--seoul-raw-receipt", "seoulRawReceiptPath"],
    ["--capital-facility-plan", "capitalFacilityPlanPath"],
    ["--capital-canonical-pack", "capitalCanonicalPackPath"],
    ["--producer-neutral-full-registration", "producerNeutralFullRegistration"],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const key = names.get(name);
    const value = args[index + 1];
    if (!key || value == null || names.has(value) || seen.has(key)) throw new Error("registration CLI arguments are invalid");
    seen.add(key);
    options[key] = key === "producerNeutralFullRegistration" ? value === "true" : value;
  }
  const full = options.producerNeutralFullRegistration === true;
  for (const key of ["repositoryRoot", "snapshotFilePath", "snapshotFileSha256", "rawReceiptPath"]) {
    if (typeof options[key] !== "string" || options[key].trim() === "") throw new Error("registration CLI arguments are invalid");
  }
  if (full) {
    if (![options.capitalFacilityPlanPath, options.capitalCanonicalPackPath].every((value) => typeof value === "string" && value !== "")
      || [options.seoulSnapshotPath, options.seoulSnapshotFileSha256, options.seoulRawReceiptPath].some((value) => value != null)) throw new Error("registration CLI arguments are invalid");
    return options;
  }
  if (options.capitalFacilityPlanPath != null || options.capitalCanonicalPackPath != null || options.producerNeutralFullRegistration != null
    || typeof options.seoulSnapshotPath !== "string" || options.seoulSnapshotPath.trim() === "") throw new Error("registration CLI arguments are invalid");
  const freshSeoulValues = [options.seoulSnapshotFileSha256, options.seoulRawReceiptPath];
  if (!freshSeoulValues.every((value) => value == null) && !freshSeoulValues.every((value) => typeof value === "string" && value !== "")) {
    throw new Error("registration CLI arguments are invalid");
  }
  return options;
}

export async function runKricStandardAccessibilitySnapshotRegistration(args) {
  const options = parseKricStandardAccessibilitySnapshotRegistrationArgs(args);
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const snapshotBytes = await readFile(options.snapshotFilePath);
  const snapshot = readStagedSnapshot(snapshotBytes, options.snapshotFileSha256);
  if (options.producerNeutralFullRegistration === true) {
    const rawReceipt = JSON.parse((await readRegularSnapshot(options.rawReceiptPath, "raw receipt")).bytes);
    return registerKricStandardAccessibilitySnapshot({
      snapshotFilePath: options.snapshotFilePath,
      snapshotFileSha256: options.snapshotFileSha256,
      snapshotTargetPath: path.join(repositoryRoot, "tools/datapack/sources", `${snapshot.snapshotId}.json`),
      rawReceipt,
      capitalFacilityPlanPath: options.capitalFacilityPlanPath,
      capitalCanonicalPackPath: options.capitalCanonicalPackPath,
      producerNeutralFullRegistration: true,
      repositoryRoot,
    });
  }
  const seoulSnapshotBytes = await readFile(options.seoulSnapshotPath);
  const freshSeoulRequested = options.seoulSnapshotFileSha256 != null;
  const seoulSnapshot = freshSeoulRequested
    ? readStagedSeoulSnapshot(seoulSnapshotBytes, options.seoulSnapshotFileSha256)
    : JSON.parse(seoulSnapshotBytes);
  return registerKricStandardAccessibilitySnapshot({
    snapshotFilePath: options.snapshotFilePath,
    snapshotFileSha256: options.snapshotFileSha256,
    snapshotTargetPath: path.join(repositoryRoot, "tools/datapack/sources", `${snapshot.snapshotId}.json`),
    rawReceipt: JSON.parse(await readFile(options.rawReceiptPath, "utf8")),
    seoulSnapshot: freshSeoulRequested ? undefined : seoulSnapshot,
    ...(freshSeoulRequested ? {
      seoulSnapshotFilePath: options.seoulSnapshotPath,
      seoulSnapshotFileSha256: options.seoulSnapshotFileSha256,
      seoulSnapshotTargetPath: path.join(repositoryRoot, "tools/datapack/sources", `${seoulSnapshot.snapshotId}.json`),
      seoulRawReceipt: JSON.parse(await readFile(options.seoulRawReceiptPath, "utf8")),
    } : {}),
    registryPaths: Object.fromEntries([
      "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json",
      "tools/datapack/inputs/capital-pilot-production-source-input.json",
    ].map((relative) => [relative, path.join(repositoryRoot, relative)])),
    repositoryRoot,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKricStandardAccessibilitySnapshotRegistration(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
