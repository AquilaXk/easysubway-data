#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { validateKricAccessibilitySnapshotIdentity } from "./collect-kric-accessibility-snapshots.mjs";
import { materializeAccessibilitySourceInput } from "./materialize-accessibility-source-input.mjs";
import { buildSnapshotDiff, requiredCredentialFreeObjectUri, validateLineage } from "./source-snapshot-policy.mjs";

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

export async function recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot = REPOSITORY_ROOT, atomicReplaceImpl = atomicReplace, cleanupTransactionDirectoryImpl = (directory) => rm(directory, { recursive: true, force: true }), syncDirectoryImpl = syncDirectory } = {}) {
  const { root, journal } = transactionPaths(repositoryRoot);
  let entry;
  try { entry = JSON.parse(await readFile(journal, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("RECOVERY_REQUIRED");
  }
  let outcome;
  let directory;
  try {
    if (!['PREPARED', 'COMMITTED'].includes(entry?.state) || !Array.isArray(entry.records) || entry.records.length === 0
      || typeof entry.transactionDirectory !== "string"
      || !/^\.kric-standard-registration-[0-9a-f-]{36}$/.test(path.basename(entry.transactionDirectory))) throw new Error("journal");
    directory = contained(root, entry.transactionDirectory);
    const allowed = new Set([
      "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json",
      "tools/datapack/inputs/capital-pilot-production-source-input.json",
    ]);
    const seen = new Set();
    for (const record of entry.records) {
      if (!record || typeof record.target !== "string" || typeof record.backup !== "string"
        || typeof record.existed !== "boolean" || !SHA256.test(record.expected ?? "") || seen.has(record.target)) throw new Error("journal");
      seen.add(record.target);
      if (!allowed.has(record.target) && !/^tools\/datapack\/sources\/kric-station-convenience-standard-[A-Za-z0-9]+\.json$/.test(record.target)) throw new Error("journal");
      const target = contained(root, record.target);
      if (record.existed && path.dirname(contained(root, record.backup)) !== directory) throw new Error("journal");
      if (entry.state === 'COMMITTED') {
        if (sha256(await readFile(target)) !== record.expected) throw new Error("journal");
      } else if (record.existed) {
        const backup = contained(root, record.backup);
        await atomicReplaceImpl(target, await readFile(backup), "recovery");
      } else {
        await rm(target, { force: true });
        await syncDirectoryImpl(path.dirname(target));
      }
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

async function commitTransaction({ repositoryRoot, outputs, atomicReplaceImpl = atomicReplace, rollbackAtomicReplaceImpl = atomicReplace, commitJournalReplaceImpl = atomicReplace, cleanupTransactionDirectoryImpl = (directory) => rm(directory, { recursive: true, force: true }), syncTransactionDirectoryImpl = syncDirectory }) {
  const { root, journal } = transactionPaths(repositoryRoot);
  await recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot: root });
  const directory = path.join(root, "tools/datapack", `.kric-standard-registration-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const records = [];
  try { for (const [index, output] of outputs.entries()) {
    contained(root, path.relative(root, output.target));
    const relative = path.relative(root, output.target);
    const backup = path.relative(root, path.join(directory, `backup-${index}`));
    let original = null;
    try { original = await readFile(output.target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (original != null) await syncedWrite(contained(root, backup), original);
    await syncedWrite(path.join(directory, `staged-${index}`), output.bytes);
    records.push({ target: relative, existed: original != null, backup, expected: sha256(output.bytes) });
  } } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  await syncTransactionDirectoryImpl(directory);
  const entry = { state: "PREPARED", transactionDirectory: path.relative(root, directory), records };
  await atomicReplace(journal, Buffer.from(JSON.stringify(entry)));
  try {
    for (const [index, output] of outputs.entries()) await atomicReplaceImpl(output.target, output.bytes, index + 1);
    for (const record of records) if (sha256(await readFile(contained(root, record.target))) !== record.expected) throw new Error("transaction hash mismatch");
    await commitJournalReplaceImpl(journal, Buffer.from(JSON.stringify({ ...entry, state: "COMMITTED" }), "utf8"), "COMMITTED");
    await syncDirectory(path.dirname(journal));
  } catch (error) {
    let recovery;
    try { recovery = await recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot: root, atomicReplaceImpl: rollbackAtomicReplaceImpl }); }
    catch { throw new Error("RECOVERY_REQUIRED"); }
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
  if (!Number.isFinite(Date.parse(requiredText(receipt?.storedAt, "raw receipt storedAt")))) {
    throw new Error("raw receipt storedAt is invalid");
  }
  if (Date.parse(receipt.storedAt) < Date.parse(snapshot.capturedAt)) {
    throw new Error("raw receipt storedAt precedes snapshot capture");
  }
  if (!Number.isFinite(Date.parse(requiredText(receipt?.rawRetentionExpiresAt, "raw receipt rawRetentionExpiresAt")))
    || Date.parse(receipt.rawRetentionExpiresAt) <= Date.parse(snapshot.freshUntil)) {
    throw new Error("raw receipt rawRetentionExpiresAt is invalid");
  }
}

async function validateAdmittedSeoulSnapshot({ inventory, snapshots, input, seoulSnapshot, repositoryRoot, now }) {
  const sources = inventory?.sources?.filter(({ id }) => id === SEOUL_SOURCE_ID) ?? [];
  if (sources.length !== 1) throw new Error("Seoul snapshot admission is invalid");
  const evidence = sources[0].accessibilityAdmissionEvidence;
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
  if (!Object.entries(expected).every(([field, value]) => seoulSnapshot?.[field] === value)
    || !SHA256.test(evidence?.snapshotFileSha256 ?? "")
    || sha256(JSON.stringify(seoulSnapshot?.stations)) !== evidence.contentSha256) {
    throw new Error("Seoul snapshot admission is invalid");
  }
  if (!Number.isFinite(Date.parse(evidence.freshUntil)) || Date.parse(evidence.freshUntil) <= now.getTime()) {
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
    || ledger[0].sourceUpdatedAt !== seoulSnapshot.observedAt) {
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
  const supported = new Set((input.stationMappings ?? [])
    .filter(({ stationId, lineId }) => input.supportedV1Scope?.includedStationIds?.includes(stationId)
      && input.supportedV1Scope?.includedLineIds?.includes(lineId))
    .map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  const rosterStations = new Set(roster.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  if (supported.size === 0 || supported.size !== rosterStations.size
    || [...supported].some((stationLine) => !rosterStations.has(stationLine))) {
    throw new Error("KRIC accessibility roster coverage is invalid");
  }
  const queryRoster = sortedUniqueRoster(snapshot.queries ?? []);
  if (queryRoster.length !== roster.length || queryRoster.some((tuple, index) => rosterKey(tuple) !== rosterKey(roster[index]))) {
    throw new Error("KRIC accessibility snapshot coverage is invalid");
  }
  return roster;
}

function stageRegistries({ inventory, snapshots, input, snapshot, snapshotPath, snapshotFileSha256, rawReceipt, seoulSnapshot, kricAccessibilityRoster, now }) {
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
    rawReceipt: {
      sourceId: rawReceipt.sourceId,
      snapshotId: rawReceipt.snapshotId,
      snapshotRawSha256: rawReceipt.snapshotRawSha256,
      capturedAt: rawReceipt.capturedAt,
      snapshotFileSha256: rawReceipt.snapshotFileSha256,
      rawObjectSha256: rawReceipt.rawObjectSha256,
      byteSize: rawReceipt.byteSize,
      storedAt: rawReceipt.storedAt,
    },
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
    freshnessExpiresAt: snapshot.freshUntil,
    rawRetentionExpiresAt: rawReceipt.rawRetentionExpiresAt,
  };
  nextLedger.diffSummary = buildSnapshotDiff(previous, nextLedger);
  const nextInventory = structuredClone(inventory);
  const nextSource = nextInventory.sources.find(({ id }) => id === SOURCE_ID);
  nextSource.productionUseAllowed = true;
  nextSource.accessibilityAdmissionEvidence = {
    ...nextSource.accessibilityAdmissionEvidence,
    productionUseAllowed: true,
    snapshotId: snapshot.snapshotId,
    snapshotPath,
    capturedAt: snapshot.capturedAt,
    observedAt: snapshot.observedAt,
    freshUntil: snapshot.freshUntil,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
    schemaFingerprint: snapshot.schemaFingerprint,
    snapshotFileSha256,
  };
  nextSource.admissionEvidence = {
    ...nextSource.admissionEvidence,
    productionUseNoteKo: `fresh KRIC standard snapshot ${snapshot.snapshotId} registration verified.`,
  };
  const nextSnapshots = [...snapshots, nextLedger];
  validateLineage(nextSnapshots);
  const nextInput = materializeAccessibilitySourceInput({
    input: structuredClone(input), kricSnapshot: snapshot, seoulSnapshot,
  });
  nextInput.kricStandardAccessibilitySnapshot = {
    snapshotId: snapshot.snapshotId,
    contentSha256: snapshot.contentSha256,
    freshUntil: snapshot.freshUntil,
  };
  nextInput.kricStandardAccessibilityRoster = kricAccessibilityRoster;
  const kricRows = nextInput.facilityRows.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const kricStatus = nextInput.accessibilityStatusEvidence.filter(({ sourceId }) => sourceId === SOURCE_ID);
  if (kricRows.length === 0
    || [...kricRows, ...kricStatus].some(({ sourceSnapshotId }) => sourceSnapshotId !== snapshot.snapshotId)) {
    throw new Error("materialized KRIC snapshot identity is invalid");
  }
  return [nextInventory, nextSnapshots, nextInput].map((value) => `${JSON.stringify(value, null, 2)}\n`);
}

export async function registerKricStandardAccessibilitySnapshot({
  snapshotFilePath,
  snapshotFileSha256,
  snapshotTargetPath,
  rawReceipt,
  seoulSnapshot,
  registryPaths,
  repositoryRoot = REPOSITORY_ROOT,
  now = new Date(),
  atomicReplaceImpl = atomicReplace,
  rollbackAtomicReplaceImpl = atomicReplace,
  commitJournalReplaceImpl,
  cleanupTransactionDirectoryImpl,
  syncTransactionDirectoryImpl,
} = {}) {
  const paths = [
    registryPaths?.["tools/datapack/source-inventory.json"],
    registryPaths?.["tools/datapack/release/source-snapshots.json"],
    registryPaths?.["tools/datapack/inputs/capital-pilot-production-source-input.json"],
  ].map((file) => requiredText(file, "registry path"));
  const expectedPaths = [
    path.join(path.resolve(repositoryRoot), "tools/datapack/source-inventory.json"),
    path.join(path.resolve(repositoryRoot), "tools/datapack/release/source-snapshots.json"),
    path.join(path.resolve(repositoryRoot), "tools/datapack/inputs/capital-pilot-production-source-input.json"),
  ];
  if (paths.some((file, index) => path.resolve(file) !== expectedPaths[index])) throw new Error("registry path is invalid");
  await recoverKricStandardAccessibilitySnapshotTransaction({ repositoryRoot });
  const [snapshotBytes, ...original] = await Promise.all([
    readFile(requiredText(snapshotFilePath, "snapshot file path")),
    ...paths.map((file) => readFile(file)),
  ]);
  const snapshot = readStagedSnapshot(snapshotBytes, snapshotFileSha256);
  if (rawReceipt?.snapshotFileSha256 !== snapshotFileSha256) throw new Error("raw receipt snapshot binding is invalid");
  validateReceipt(snapshot, rawReceipt, now);
  const snapshotPath = `tools/datapack/sources/${snapshot.snapshotId}.json`;
  const expectedSnapshotTargetPath = path.join(path.resolve(repositoryRoot), snapshotPath);
  if (!path.isAbsolute(requiredText(snapshotTargetPath, "snapshot target path"))
    || path.resolve(snapshotTargetPath) !== expectedSnapshotTargetPath) {
    throw new Error("snapshot target path is invalid");
  }
  const [inventory, snapshots, input] = original.map((bytes) => JSON.parse(bytes));
  await validateAdmittedSeoulSnapshot({ inventory, snapshots, input, seoulSnapshot, repositoryRoot, now });
  const kricAccessibilityRoster = validateKricAccessibilityCoverage(snapshot, input);
  const staged = stageRegistries({
    inventory, snapshots, input,
    snapshot, snapshotPath, snapshotFileSha256, rawReceipt, seoulSnapshot, kricAccessibilityRoster, now,
  });
  let targetBytes = null;
  try { targetBytes = await readFile(snapshotTargetPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (targetBytes != null && !targetBytes.equals(snapshotBytes)) throw new Error("snapshot target already exists with different bytes");
  await commitTransaction({
    repositoryRoot,
    atomicReplaceImpl,
    rollbackAtomicReplaceImpl,
    commitJournalReplaceImpl,
    cleanupTransactionDirectoryImpl,
    syncTransactionDirectoryImpl,
    outputs: [
      ...(targetBytes == null ? [{ target: snapshotTargetPath, bytes: snapshotBytes }] : []),
      ...paths.map((target, index) => ({ target, bytes: Buffer.from(staged[index]) })),
    ],
  });
}
