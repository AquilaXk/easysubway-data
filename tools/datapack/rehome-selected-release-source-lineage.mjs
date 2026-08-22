#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveReleaseEvidence } from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { publishImmutableObjectPlan } from "./publish-object-storage.mjs";
import { readStableRegularFile } from "./rebind-current-candidate-source-snapshots.mjs";
import { buildSnapshotDiff, parseCredentialFreeObjectUri, validateLineage } from "./source-snapshot-policy.mjs";
import { requireOciParBaseUrl } from "./lib/kric-raw-object-storage.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SHA256 = /^[a-f0-9]{64}$/u;
const OUTPUTS = Object.freeze([
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
]);
const SUPPORT = Object.freeze({
  inventory: "tools/datapack/source-inventory.json",
  canonical: "tools/datapack/release/capital-production-canonical-pack.json",
  governance: "tools/datapack/source-governance-policy.json",
  freshness: "release/product-gates/datapack-freshness-sla.json",
});
export const SELECTED_RELEASE_SOURCE_IDS = Object.freeze([
  "seoulmetro-cyberstation-route-map",
  "seoul-metro-accessibility",
  "molit-urban-rail-full-route",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function parse(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); }
}
function safeRelative(value, label) {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value)
    || value.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}
function contained(root, relative) {
  const resolved = path.resolve(root, safeRelative(relative, "path"));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("path escapes repository root");
  return resolved;
}
function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function assertSafeDirectoryPath(root, directory, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (!isWithin(resolvedRoot, resolvedDirectory)) throw new Error(`${label} escapes its root`);
  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`${label} root must be a regular directory`);
  let current = resolvedRoot;
  for (const component of path.relative(resolvedRoot, resolvedDirectory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} parent is unsafe`);
  }
  return resolvedDirectory;
}

async function safeParent(target, label = "selected source OCI rehome target") {
  const parent = path.dirname(target);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} parent is unsafe`);
  return parent;
}

async function stableAbsoluteBytes(target, label) {
  await safeParent(target, label);
  return (await readStableRegularFile(target, label)).bytes;
}

async function assertExternalOperationRoot(repositoryRoot, operationRoot) {
  const repository = path.resolve(repositoryRoot);
  const operation = path.resolve(operationRoot);
  const parent = await safeParent(operation, "rehome operation root");
  const operationInfo = await lstat(operation);
  if (!operationInfo.isDirectory() || operationInfo.isSymbolicLink()) {
    throw new Error("rehome operation root must be a regular directory");
  }
  const [realRepository, realParent, realOperation] = await Promise.all([
    realpath(repository), realpath(parent), realpath(operation),
  ]);
  if (isWithin(realRepository, realParent) || isWithin(realRepository, realOperation)) {
    throw new Error("rehome operation root must be outside repository");
  }
}

async function externalRegularBytes(root, relative, label) {
  const target = contained(root, relative);
  await assertSafeDirectoryPath(root, path.dirname(target), "rehome operation path");
  return stableAbsoluteBytes(target, label);
}

async function regularBytes(root, relative, label) {
  const target = contained(root, relative);
  try {
    await assertSafeDirectoryPath(root, path.dirname(target), "selected source OCI rehome repository path");
    return await stableAbsoluteBytes(target, label);
  } catch (error) {
    if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) throw new Error(`${label} has an invalid closed schema`);
}

export function validateSelectedReleaseSourceRehomeManifest({ manifest, snapshots, inputs }) {
  exactKeys(manifest, ["schemaVersion", "artifactKind", "sources"], "rehome manifest");
  if (manifest.schemaVersion !== 1 || manifest.artifactKind !== "selected-release-source-oci-rehome-manifest"
    || !Array.isArray(manifest.sources) || manifest.sources.length !== SELECTED_RELEASE_SOURCE_IDS.length) {
    throw new Error("rehome manifest identity mismatch");
  }
  if (JSON.stringify(manifest.sources.map(({ sourceId }) => sourceId)) !== JSON.stringify(SELECTED_RELEASE_SOURCE_IDS)) {
    throw new Error("rehome manifest must contain the exact selected source order");
  }
  const heads = validateLineage(snapshots).headsBySource;
  const successors = [];
  for (const entry of manifest.sources) {
    exactKeys(entry, ["sourceId", "currentSnapshotId", "snapshotPath", "receiptPath", "rawPath"], "rehome source entry");
    for (const key of ["snapshotPath", "receiptPath", "rawPath"]) safeRelative(entry[key], `rehome ${key}`);
    const current = snapshots.find((snapshot) => snapshot.snapshotId === entry.currentSnapshotId);
    if (!current || current.sourceId !== entry.sourceId || heads[entry.sourceId] !== entry.currentSnapshotId) {
      throw new Error("rehome current source head is invalid");
    }
    const successor = parse(inputs.get(entry.snapshotPath), "rehome successor snapshot");
    const raw = inputs.get(entry.rawPath);
    if (!Buffer.isBuffer(raw) || raw.length === 0 || successor?.sourceId !== entry.sourceId
      || successor.previousSnapshotId !== current.snapshotId || successor.snapshotId === current.snapshotId
      || successor.rawObjectUri?.startsWith("oci://") !== true || successor.rawSha256 !== sha256(raw)
      || current.rawSha256 !== successor.rawSha256
      || !SHA256.test(successor.rawSha256) || JSON.stringify(successor.diffSummary) !== JSON.stringify(buildSnapshotDiff(current, successor))) {
      throw new Error("rehome successor lineage or OCI bytes are invalid");
    }
    const allowedChanges = new Set(["snapshotId", "previousSnapshotId", "rawObjectUri", "retrievedAt", "freshnessExpiresAt", "rawRetentionExpiresAt", "diffSummary"]);
    const legacyCoverageNormalization = current.coverageCount == null && successor.coverageCount === 0;
    const successorKeys = Object.keys(successor).filter((key) => !(legacyCoverageNormalization && key === "coverageCount")).sort();
    if (JSON.stringify(successorKeys) !== JSON.stringify(Object.keys(current).sort())) throw new Error("rehome successor schema drift");
    for (const key of Object.keys(current)) if (!allowedChanges.has(key) && JSON.stringify(successor[key]) !== JSON.stringify(current[key])) throw new Error("rehome semantic evidence drift");
    const plusOneMillisecond = (value) => new Date(Date.parse(value) + 1).toISOString();
    if (successor.retrievedAt !== plusOneMillisecond(current.retrievedAt)
      || successor.freshnessExpiresAt !== plusOneMillisecond(current.freshnessExpiresAt)
      || successor.rawRetentionExpiresAt !== plusOneMillisecond(current.rawRetentionExpiresAt)) {
      throw new Error("rehome successor freshness projection drift");
    }
    const retrievedAt = new Date(successor.retrievedAt);
    const day = Number.isFinite(retrievedAt.valueOf())
      ? retrievedAt.toISOString().slice(0, 10).replaceAll("-", "") : null;
    const expectedUri = `oci://easysubway-datapacks/source-raw/${entry.sourceId}/${day}/${current.rawSha256}.json`;
    if (!current.rawObjectUri?.startsWith("s3://") || successor.rawObjectUri !== expectedUri) {
      throw new Error("rehome successor lineage or OCI bytes are invalid");
    }
    const locator = parseCredentialFreeObjectUri(successor.rawObjectUri, "rehome OCI object URI");
    successors.push({ entry, successor, raw, objectKey: locator.objectKey });
  }
  return successors;
}

function deriveOutputs({ snapshots, inventory, canonical, governance, freshness, spec, request, hashes, canonicalBytes, inventoryBytes, governanceBytes, itxBytes }) {
  const derived = deriveReleaseEvidence({ snapshots, inventory, canonical, governance, freshness, spec, request, hashes, canonicalBytes, inventoryBytes, governanceBytes, itxBytes });
  return [
    { relativePath: OUTPUTS[0], bytes: jsonBytes(snapshots) },
    { relativePath: OUTPUTS[1], bytes: derived.specBytes },
    { relativePath: OUTPUTS[2], bytes: derived.requestBytes },
    { relativePath: OUTPUTS[3], bytes: derived.hashBytes },
  ];
}

const JOURNAL = "tools/datapack/.selected-release-source-oci-rehome-transaction.json";
const LOCK = "tools/datapack/.selected-release-source-oci-rehome.lock";
const PUBLICATION_JOURNAL = ".selected-release-source-oci-rehome-publication.json";
const transactionIdPattern = /^[a-f0-9-]{36}$/u;

async function syncParent(target) {
  const parent = await open(await safeParent(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

async function durableCreate(target, bytes) {
  await safeParent(target);
  const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncParent(target);
}

async function durableUnlink(target) {
  await unlink(target);
  await syncParent(target);
}

async function assertExpectedBytes(target, expected) {
  const actual = await stableAbsoluteBytes(target, "selected source OCI rehome target");
  if (!actual.equals(expected)) throw new Error("selected source OCI rehome preserves foreign replacement");
}

async function atomicReplace(target, bytes, expected = undefined, { beforePublish = async () => {} } = {}) {
  const parent = await safeParent(target);
  if (expected !== undefined) await assertExpectedBytes(target, expected);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    temporaryCreated = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await beforePublish({ target, bytes, expected });
    if (expected !== undefined) await assertExpectedBytes(target, expected);
    await rename(temporary, target);
    temporaryCreated = false;
    await syncParent(target);
    await assertExpectedBytes(target, bytes);
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => {});
  }
}

function validateJournal(journal) {
  if (!journal || journal.schemaVersion !== 1 || !["PREPARED", "COMMITTED"].includes(journal.state)
    || !transactionIdPattern.test(journal.transactionId ?? "") || !Array.isArray(journal.records)
    || JSON.stringify(journal.records.map(({ relativePath }) => relativePath)) !== JSON.stringify(OUTPUTS)) {
    throw new Error("selected source OCI rehome transaction journal is invalid");
  }
  for (const record of journal.records) {
    if (!record || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["relativePath", "beforeSha256", "afterSha256"].sort())
      || !SHA256.test(record.beforeSha256 ?? "") || !SHA256.test(record.afterSha256 ?? "")) {
      throw new Error("selected source OCI rehome transaction journal is invalid");
    }
  }
}

async function validatedRecoveryRecords(root, journal) {
  validateJournal(journal);
  const directory = path.join(root, "tools/datapack", `.selected-release-source-oci-rehome-${journal.transactionId}`);
  const records = [];
  for (const [index, record] of journal.records.entries()) {
    const before = await regularBytes(root, path.relative(root, path.join(directory, `${index}.before`)), "selected source OCI rehome backup");
    const current = await regularBytes(root, record.relativePath, "selected source OCI rehome output");
    if (sha256(before) !== record.beforeSha256) throw new Error("selected source OCI rehome backup checksum mismatch");
    const currentSha = sha256(current);
    if (journal.state === "PREPARED" && ![record.beforeSha256, record.afterSha256].includes(currentSha)) {
      throw new Error("selected source OCI rehome output drift");
    }
    if (journal.state === "COMMITTED" && currentSha !== record.afterSha256) {
      throw new Error("selected source OCI rehome committed output drift");
    }
    records.push({ ...record, before, current, currentSha });
  }
  return { directory, records };
}

async function cleanupTransaction(root, journal, directory) {
  await durableUnlink(contained(root, JOURNAL));
  await rm(directory, { recursive: true });
  await syncParent(directory);
}

async function recoverTransaction(root, journal, { beforeRecoveryReplace = async () => {} } = {}) {
  const { directory, records } = await validatedRecoveryRecords(root, journal);
  if (journal.state === "PREPARED") {
    for (const record of records) {
      if (record.currentSha !== record.beforeSha256) {
        const target = contained(root, record.relativePath);
        await beforeRecoveryReplace({ record, target, expected: record.current, next: record.before });
        await atomicReplace(target, record.before, record.current);
      }
    }
  }
  await cleanupTransaction(root, journal, directory);
}

async function readJournal(root) {
  try { return parse(await regularBytes(root, JOURNAL, "selected source OCI rehome transaction journal"), "selected source OCI rehome transaction journal"); }
  catch (error) { if (/ is missing$/u.test(error.message)) return null; throw error; }
}

async function acquireLock(root) {
  const lock = contained(root, LOCK);
  const claim = async () => {
    await safeParent(lock);
    const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(jsonBytes({ pid: process.pid, token: randomUUID() })); await handle.sync(); } finally { await handle.close(); }
    await syncParent(lock);
  };
  try { await claim(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let prior;
    try { prior = parse(await regularBytes(root, LOCK, "selected source OCI rehome lock"), "selected source OCI rehome lock"); }
    catch { throw new Error("selected source OCI rehome is already running or needs recovery"); }
    if (!Number.isInteger(prior?.pid) || prior.pid <= 0) throw new Error("selected source OCI rehome is already running or needs recovery");
    try { process.kill(prior.pid, 0); throw new Error("selected source OCI rehome is already running or needs recovery"); }
    catch (probe) {
      if (probe?.code !== "ESRCH") throw probe;
    }
    await durableUnlink(lock);
    await claim();
  }
  return async () => { await durableUnlink(lock).catch(() => {}); };
}

async function transaction(root, outputs, expectedBefore, hooks = {}) {
  if (!Array.isArray(expectedBefore) || expectedBefore.length !== OUTPUTS.length || expectedBefore.some((bytes) => !Buffer.isBuffer(bytes))) {
    throw new Error("selected source OCI rehome transaction prestate is invalid");
  }
  const release = await acquireLock(root);
  let journal;
  let committed = false;
  try {
    const assertExpectedPrestate = async () => {
      for (const [index, relativePath] of OUTPUTS.entries()) {
        const current = await regularBytes(root, relativePath, "release transaction input");
        if (!current.equals(expectedBefore[index])) throw new Error("selected source OCI rehome preserves foreign replacement");
      }
    };
    await assertExpectedPrestate();
    const prior = await readJournal(root);
    if (prior) await recoverTransaction(root, prior, hooks);
    await assertExpectedPrestate();
    const transactionId = randomUUID();
    const directory = path.join(root, "tools/datapack", `.selected-release-source-oci-rehome-${transactionId}`);
    await mkdir(directory, { recursive: false });
    await syncParent(directory);
    const records = [];
    for (const [index, output] of outputs.entries()) {
      const before = expectedBefore[index];
      const backup = path.join(directory, `${index}.before`);
      await durableCreate(backup, before);
      records.push({ relativePath: output.relativePath, beforeSha256: sha256(before), afterSha256: sha256(output.bytes) });
    }
    journal = { schemaVersion: 1, state: "PREPARED", transactionId, records };
    await durableCreate(contained(root, JOURNAL), jsonBytes(journal));
    for (const [index, output] of outputs.entries()) {
      const target = contained(root, output.relativePath);
      const before = expectedBefore[index];
      await atomicReplace(target, output.bytes, before, {
        beforePublish: () => hooks.beforeReplace?.({ index, target, before, next: output.bytes }),
      });
      if (hooks.failAfterReplace === index) throw new Error("injected transaction failure");
      if (hooks.leavePreparedAfterReplace === index) throw Object.assign(new Error("injected prepared residue"), { leavePrepared: true });
    }
    journal = { ...journal, state: "COMMITTED" };
    await atomicReplace(contained(root, JOURNAL), jsonBytes(journal), jsonBytes({ ...journal, state: "PREPARED" }));
    committed = true;
    if (hooks.leaveCommittedResidue) throw Object.assign(new Error("injected committed residue"), { leaveCommitted: true });
    await recoverTransaction(root, journal, hooks);
  } catch (error) {
    if (!committed && journal && !error.leavePrepared) {
      try { await recoverTransaction(root, journal, hooks); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "selected source OCI rehome rollback failed"); }
    }
    throw error;
  } finally {
    await release();
  }
}

async function recoverExistingTransaction(root, hooks = {}) {
  const release = await acquireLock(root);
  try {
    const journal = await readJournal(root);
    if (!journal) return null;
    await recoverTransaction(root, journal, hooks);
    return journal.state;
  } finally {
    await release();
  }
}

function sanitizedPublicationError() { return new Error("OCI source publication failed"); }

function exactReceipt({ successor, raw, storedAt }) {
  return {
    schemaVersion: 1,
    artifactKind: "selected-release-source-oci-raw-receipt",
    sourceId: successor.sourceId,
    snapshotId: successor.snapshotId,
    rawObjectUri: successor.rawObjectUri,
    rawObjectSha256: successor.rawSha256,
    byteSize: raw.length,
    storedAt,
  };
}

async function existingReceipt(target) {
  try {
    return parse(await stableAbsoluteBytes(target, "rehome receipt"), "rehome receipt");
  } catch (error) {
    if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return false;
    throw error;
  }
}

function exactPublicationJournal(journal) {
  const baseKeys = ["artifactKind", "manifestSha256", "schemaVersion", "sources", "state", "storedAt"];
  const expectedKeys = [...baseKeys, "outputs"];
  if (!journal || journal.schemaVersion !== 1 || journal.artifactKind !== "selected-release-source-oci-rehome-publication"
    || !["PREPARED", "VERIFIED", "COMMITTED"].includes(journal.state)
    || !SHA256.test(journal.manifestSha256 ?? "") || !Array.isArray(journal.sources)
    || !Number.isFinite(Date.parse(journal.storedAt ?? "")) || new Date(journal.storedAt).toISOString() !== journal.storedAt
    || JSON.stringify(Object.keys(journal).sort()) !== JSON.stringify(expectedKeys.sort())) {
    throw new Error("selected source OCI rehome publication journal is invalid");
  }
  if (journal.sources.length !== SELECTED_RELEASE_SOURCE_IDS.length
    || JSON.stringify(journal.sources.map(({ sourceId }) => sourceId)) !== JSON.stringify(SELECTED_RELEASE_SOURCE_IDS)) {
    throw new Error("selected source OCI rehome publication journal is invalid");
  }
  for (const source of journal.sources) {
    if (JSON.stringify(Object.keys(source).sort()) !== JSON.stringify([
      "rawByteSize", "rawObjectSha256", "rawObjectUri", "rawPath", "receiptPath", "receiptSha256",
      "snapshotId", "snapshotPath", "snapshotSha256", "sourceId",
    ].sort()) || !SHA256.test(source.rawObjectSha256 ?? "") || !SHA256.test(source.receiptSha256 ?? "")
      || !SHA256.test(source.snapshotSha256 ?? "") || !Number.isInteger(source.rawByteSize) || source.rawByteSize < 1
      || typeof source.snapshotId !== "string" || typeof source.rawObjectUri !== "string") {
      throw new Error("selected source OCI rehome publication journal is invalid");
    }
    for (const key of ["snapshotPath", "rawPath", "receiptPath"]) safeRelative(source[key], "publication journal path");
  }
  if (!Array.isArray(journal.outputs) || JSON.stringify(journal.outputs.map(({ relativePath }) => relativePath)) !== JSON.stringify(OUTPUTS)) {
    throw new Error("selected source OCI rehome publication journal is invalid");
  }
  for (const output of journal.outputs) {
    const outputKeys = journal.state === "PREPARED"
      ? ["beforeSha256", "relativePath"]
      : ["afterSha256", "beforeSha256", "relativePath"];
    if (JSON.stringify(Object.keys(output).sort()) !== JSON.stringify(outputKeys.sort())
      || !SHA256.test(output.beforeSha256 ?? "")
      || (journal.state !== "PREPARED" && !SHA256.test(output.afterSha256 ?? ""))) {
      throw new Error("selected source OCI rehome publication journal is invalid");
    }
  }
}

function outputBeforeRecords(bytes) {
  return OUTPUTS.map((relativePath, index) => ({ relativePath, beforeSha256: sha256(bytes[index]) }));
}

function assertOutputBeforeBytes(bytes, outputs) {
  if (!Array.isArray(bytes) || bytes.length !== OUTPUTS.length
    || bytes.some((value, index) => !Buffer.isBuffer(value) || sha256(value) !== outputs[index]?.beforeSha256)) {
    throw new Error("selected source OCI rehome preserves foreign replacement");
  }
}

function publicationSources({ sources, inputs, storedAt }) {
  return sources.map(({ entry, successor, raw }) => {
    const receipt = exactReceipt({ successor, raw, storedAt });
    return {
      sourceId: successor.sourceId,
      snapshotId: successor.snapshotId,
      snapshotPath: entry.snapshotPath,
      snapshotSha256: sha256(inputs.get(entry.snapshotPath)),
      rawPath: entry.rawPath,
      rawObjectUri: successor.rawObjectUri,
      rawObjectSha256: successor.rawSha256,
      rawByteSize: raw.length,
      receiptPath: entry.receiptPath,
      receiptSha256: sha256(jsonBytes(receipt)),
    };
  });
}

function validatePublicationJournal({ journal, manifestBytes, sources, inputs }) {
  exactPublicationJournal(journal);
  if (journal.manifestSha256 !== sha256(manifestBytes)) throw new Error("selected source OCI rehome publication journal input drift");
  const expectedSources = publicationSources({ sources, inputs, storedAt: journal.storedAt });
  if (JSON.stringify(journal.sources) !== JSON.stringify(expectedSources)) {
    throw new Error("selected source OCI rehome publication journal input drift");
  }
}

function publicationSourcesFromJournal({ manifest, inputs, journal }) {
  const sources = journal.sources.map((record) => {
    const entry = manifest.sources?.find(({ sourceId }) => sourceId === record.sourceId);
    const snapshotBytes = entry && inputs.get(entry.snapshotPath);
    const raw = entry && inputs.get(entry.rawPath);
    const successor = Buffer.isBuffer(snapshotBytes) ? parse(snapshotBytes, "rehome successor snapshot") : null;
    if (!entry || !Buffer.isBuffer(raw) || !successor || successor.sourceId !== record.sourceId
      || successor.snapshotId !== record.snapshotId || successor.rawObjectUri !== record.rawObjectUri
      || successor.rawSha256 !== record.rawObjectSha256 || raw.length !== record.rawByteSize
      || sha256(snapshotBytes) !== record.snapshotSha256 || sha256(raw) !== record.rawObjectSha256) {
      throw new Error("selected source OCI rehome publication journal input drift");
    }
    const locator = parseCredentialFreeObjectUri(successor.rawObjectUri, "rehome OCI object URI");
    return { entry, successor, raw, objectKey: locator.objectKey };
  });
  validatePublicationJournal({ journal, manifestBytes: inputs.get("__manifest__"), sources, inputs });
  return sources;
}

async function readPublicationJournal(operationRoot) {
  const target = contained(operationRoot, PUBLICATION_JOURNAL);
  try { return { target, bytes: await externalRegularBytes(operationRoot, PUBLICATION_JOURNAL, "selected source OCI rehome publication journal") }; }
  catch (error) { if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return { target, bytes: null }; throw error; }
}

async function verifyPublishedObject({ operationRoot, source, publishImmutableObjectPlanImpl, client, env }) {
  try {
    await publishImmutableObjectPlanImpl({
      root: operationRoot,
      client,
      env,
      sourceId: source.entry.sourceId,
      plan: { schemaVersion: 1, steps: [
        { type: "verify-immutable-bundle-object", objectKey: source.objectKey, sourcePath: source.entry.rawPath, sha256: source.successor.rawSha256, sizeBytes: source.raw.length },
      ] },
    });
  } catch { throw sanitizedPublicationError(); }
}

async function publishAndVerifyObject({ operationRoot, source, publishImmutableObjectPlanImpl, client, env }) {
  try {
    await publishImmutableObjectPlanImpl({
      root: operationRoot,
      client,
      env,
      sourceId: source.entry.sourceId,
      plan: { schemaVersion: 1, steps: [
        { type: "put-immutable-bundle-object", objectKey: source.objectKey, sourcePath: source.entry.rawPath, sha256: source.successor.rawSha256, sizeBytes: source.raw.length },
        { type: "verify-immutable-bundle-object", objectKey: source.objectKey, sourcePath: source.entry.rawPath, sha256: source.successor.rawSha256, sizeBytes: source.raw.length },
      ] },
    });
  } catch { throw sanitizedPublicationError(); }
}

export async function rehomeSelectedReleaseSourceLineage({ repositoryRoot = ROOT, manifestPath, publishImmutableObjectPlanImpl = publishImmutableObjectPlan, client = null, env = process.env, now = () => new Date(), transactionHooks = {} }) {
  const root = path.resolve(repositoryRoot);
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) throw new Error("rehome manifest path is invalid");
  const operationRoot = path.dirname(path.resolve(manifestPath));
  await assertExternalOperationRoot(root, operationRoot);
  requireOciParBaseUrl(env);
  const manifestBytes = await externalRegularBytes(operationRoot, path.basename(manifestPath), "rehome manifest");
  const manifest = parse(manifestBytes, "rehome manifest");
  const inputs = new Map([["__manifest__", manifestBytes]]);
  for (const entry of manifest.sources ?? []) for (const key of ["snapshotPath", "rawPath"]) {
    if (typeof entry?.[key] === "string" && !inputs.has(entry[key])) inputs.set(entry[key], await externalRegularBytes(operationRoot, entry[key], `rehome ${key}`));
  }
  const publication = await readPublicationJournal(operationRoot);
  let journal;
  let journalBytes;
  let sources;
  let preparedOutputs;
  if (publication.bytes) {
    journalBytes = publication.bytes;
    journal = parse(journalBytes, "selected source OCI rehome publication journal");
    sources = publicationSourcesFromJournal({ manifest, inputs, journal });
    if (journal.state === "PREPARED") {
      preparedOutputs = await Promise.all(OUTPUTS.map((relative) => regularBytes(root, relative, "release transaction input")));
      assertOutputBeforeBytes(preparedOutputs, journal.outputs);
    }
  } else {
    const snapshotBytes = await regularBytes(root, OUTPUTS[0], "source snapshot ledger");
    const snapshots = parse(snapshotBytes, "source snapshot ledger");
    sources = validateSelectedReleaseSourceRehomeManifest({ manifest, snapshots, inputs });
    const storedAtDate = now();
    if (!(storedAtDate instanceof Date) || !Number.isFinite(storedAtDate.valueOf())) throw new Error("rehome receipt time is invalid");
    preparedOutputs = await Promise.all(OUTPUTS.map((relative) => regularBytes(root, relative, "release transaction input")));
    journal = {
      schemaVersion: 1,
      artifactKind: "selected-release-source-oci-rehome-publication",
      state: "PREPARED",
      manifestSha256: sha256(manifestBytes),
      storedAt: storedAtDate.toISOString(),
      sources: publicationSources({ sources, inputs, storedAt: storedAtDate.toISOString() }),
      outputs: outputBeforeRecords(preparedOutputs),
    };
    exactPublicationJournal(journal);
    for (const { entry } of sources) {
      const receiptTarget = contained(operationRoot, entry.receiptPath);
      await assertSafeDirectoryPath(operationRoot, path.dirname(receiptTarget), "rehome operation path");
      if (await existingReceipt(receiptTarget)) throw new Error("rehome receipt already exists");
    }
    journalBytes = jsonBytes(journal);
    await durableCreate(publication.target, journalBytes);
  }
  for (const source of sources) {
    const { entry, successor, raw } = source;
    const receiptTarget = contained(operationRoot, entry.receiptPath);
    await assertSafeDirectoryPath(operationRoot, path.dirname(receiptTarget), "rehome operation path");
    const receipt = exactReceipt({ successor, raw, storedAt: journal.storedAt });
    const priorReceipt = await existingReceipt(receiptTarget);
    if (priorReceipt) {
      if (JSON.stringify(priorReceipt) !== JSON.stringify(receipt)) {
        throw new Error("rehome receipt already exists");
      }
      await verifyPublishedObject({ operationRoot, source, publishImmutableObjectPlanImpl, client, env });
    } else {
      if (journal.state !== "PREPARED") throw new Error("selected source OCI rehome receipt is missing");
      try { await lstat(receiptTarget); throw new Error("rehome receipt already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      await publishAndVerifyObject({ operationRoot, source, publishImmutableObjectPlanImpl, client, env });
      await durableCreate(receiptTarget, jsonBytes(receipt));
    }
  }
  const postPublicationOutputs = await Promise.all(OUTPUTS.map((relative) => regularBytes(root, relative, "release transaction input")));
  if (journal.state === "PREPARED") assertOutputBeforeBytes(postPublicationOutputs, journal.outputs);
  const recoveredState = await recoverExistingTransaction(root, transactionHooks);
  const currentOutputs = await Promise.all(OUTPUTS.map((relative) => regularBytes(root, relative, "release transaction input")));
  if (journal.state === "PREPARED") {
    const preparedBytes = journalBytes;
    const [snapshotBytes, specBytes, requestBytes, hashBytes, inventoryBytes, canonicalBytes, governanceBytes, freshnessBytes] = await Promise.all([
      ...currentOutputs,
      regularBytes(root, SUPPORT.inventory, "source inventory"), regularBytes(root, SUPPORT.canonical, "canonical pack"),
      regularBytes(root, SUPPORT.governance, "source governance policy"), regularBytes(root, SUPPORT.freshness, "freshness policy"),
    ]);
    const snapshots = parse(snapshotBytes, "source snapshot ledger");
    snapshots.push(...sources.map(({ successor }) => successor));
    validateLineage(snapshots);
    const spec = parse(specBytes, "candidate build spec");
    const itxBytes = await regularBytes(root, safeRelative(spec.itxTopologyEvidencePath, "ITX topology evidence path"), "ITX topology evidence");
    const outputs = deriveOutputs({ snapshots, inventory: parse(inventoryBytes, "source inventory"), canonical: parse(canonicalBytes, "canonical pack"), governance: parse(governanceBytes, "source governance policy"), freshness: parse(freshnessBytes, "freshness policy"), spec, request: parse(requestBytes, "release request"), hashes: parse(hashBytes, "hash evidence"), canonicalBytes, inventoryBytes, governanceBytes, itxBytes });
    journal = {
      ...journal,
      state: "VERIFIED",
      outputs: outputs.map(({ relativePath, bytes }, index) => ({ ...journal.outputs[index], relativePath, afterSha256: sha256(bytes) })),
    };
    journalBytes = jsonBytes(journal);
    await atomicReplace(publication.target, journalBytes, preparedBytes);
  }
  const outputRecords = journal.outputs;
  const currentHashes = currentOutputs.map(sha256);
  const recovered = recoveredState != null || journal.state === "COMMITTED";
  const allBefore = currentHashes.every((hash, index) => hash === outputRecords[index].beforeSha256);
  const allAfter = currentHashes.every((hash, index) => hash === outputRecords[index].afterSha256);
  if (!allBefore && !allAfter) throw new Error("selected source OCI rehome output drift");
  if (journal.state === "COMMITTED") {
    if (!allAfter || recoveredState === "PREPARED") throw new Error("selected source OCI rehome committed output drift");
    return { sourceIds: SELECTED_RELEASE_SOURCE_IDS, outputPaths: OUTPUTS, recovered: true };
  }
  if (allBefore) {
    const [snapshotBytes, specBytes, requestBytes, hashBytes, inventoryBytes, canonicalBytes, governanceBytes, freshnessBytes] = await Promise.all([
      ...currentOutputs,
      regularBytes(root, SUPPORT.inventory, "source inventory"), regularBytes(root, SUPPORT.canonical, "canonical pack"),
      regularBytes(root, SUPPORT.governance, "source governance policy"), regularBytes(root, SUPPORT.freshness, "freshness policy"),
    ]);
    const snapshots = parse(snapshotBytes, "source snapshot ledger");
    snapshots.push(...sources.map(({ successor }) => successor));
    validateLineage(snapshots);
    const spec = parse(specBytes, "candidate build spec");
    const itxBytes = await regularBytes(root, safeRelative(spec.itxTopologyEvidencePath, "ITX topology evidence path"), "ITX topology evidence");
    const outputs = deriveOutputs({ snapshots, inventory: parse(inventoryBytes, "source inventory"), canonical: parse(canonicalBytes, "canonical pack"), governance: parse(governanceBytes, "source governance policy"), freshness: parse(freshnessBytes, "freshness policy"), spec, request: parse(requestBytes, "release request"), hashes: parse(hashBytes, "hash evidence"), canonicalBytes, inventoryBytes, governanceBytes, itxBytes });
    if (outputs.some(({ bytes }, index) => sha256(bytes) !== outputRecords[index].afterSha256)) throw new Error("selected source OCI rehome verified output drift");
    await transactionHooks.beforeTransaction?.({ root, expectedBefore: currentOutputs, outputs });
    await transaction(root, outputs, currentOutputs, transactionHooks);
  }
  const afterCommit = await Promise.all(OUTPUTS.map((relative) => regularBytes(root, relative, "release transaction output")));
  if (afterCommit.some((bytes, index) => sha256(bytes) !== outputRecords[index].afterSha256)) throw new Error("selected source OCI rehome committed output drift");
  journal = { ...journal, state: "COMMITTED" };
  await atomicReplace(publication.target, jsonBytes(journal), journalBytes);
  return { sourceIds: SELECTED_RELEASE_SOURCE_IDS, outputPaths: OUTPUTS, ...(recovered ? { recovered: true } : {}) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, manifestPath] = process.argv.slice(2);
  try {
    if (flag !== "--manifest" || !manifestPath || process.argv.length !== 4) throw new Error("arguments");
    await rehomeSelectedReleaseSourceLineage({ manifestPath: path.resolve(manifestPath) });
    process.stdout.write("REHOMED_SELECTED_SOURCE_LINEAGE\n");
  } catch {
    process.stderr.write("OCI_SOURCE_REHOME_FAILED\n");
    process.exitCode = 1;
  }
}
