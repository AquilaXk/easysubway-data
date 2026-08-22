#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveReleaseEvidence } from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { publishImmutableObjectPlan } from "./publish-object-storage.mjs";
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
async function regularBytes(root, relative, label) {
  const target = contained(root, relative);
  let stat;
  try { stat = await lstat(target); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink`);
  return readFile(target);
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

async function atomicReplace(target, bytes) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
  const parent = await open(path.dirname(target), constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
}

const JOURNAL = "tools/datapack/.selected-release-source-oci-rehome-transaction.json";
const LOCK = "tools/datapack/.selected-release-source-oci-rehome.lock";
const transactionIdPattern = /^[a-f0-9-]{36}$/u;

async function syncParent(target) {
  const parent = await open(path.dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await parent.sync(); } finally { await parent.close(); }
}

async function durableCreate(target, bytes) {
  const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncParent(target);
}

async function durableUnlink(target) {
  await unlink(target);
  await syncParent(target);
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
    records.push({ ...record, before, currentSha });
  }
  return { directory, records };
}

async function cleanupTransaction(root, journal, directory) {
  await durableUnlink(contained(root, JOURNAL));
  await rm(directory, { recursive: true });
  await syncParent(directory);
}

async function recoverTransaction(root, journal) {
  const { directory, records } = await validatedRecoveryRecords(root, journal);
  if (journal.state === "PREPARED") {
    for (const record of records) {
      if (record.currentSha !== record.beforeSha256) await atomicReplace(contained(root, record.relativePath), record.before);
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
    const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
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

async function transaction(root, outputs, hooks = {}) {
  const release = await acquireLock(root);
  let journal;
  let committed = false;
  try {
    const prior = await readJournal(root);
    if (prior) await recoverTransaction(root, prior);
    const transactionId = randomUUID();
    const directory = path.join(root, "tools/datapack", `.selected-release-source-oci-rehome-${transactionId}`);
    await mkdir(directory, { recursive: false });
    await syncParent(directory);
    const records = [];
    for (const [index, output] of outputs.entries()) {
      const before = await regularBytes(root, output.relativePath, "release transaction input");
      const backup = path.join(directory, `${index}.before`);
      await durableCreate(backup, before);
      records.push({ relativePath: output.relativePath, beforeSha256: sha256(before), afterSha256: sha256(output.bytes) });
    }
    journal = { schemaVersion: 1, state: "PREPARED", transactionId, records };
    await durableCreate(contained(root, JOURNAL), jsonBytes(journal));
    for (const [index, output] of outputs.entries()) {
      await atomicReplace(contained(root, output.relativePath), output.bytes);
      if (hooks.failAfterReplace === index) throw new Error("injected transaction failure");
      if (hooks.leavePreparedAfterReplace === index) throw Object.assign(new Error("injected prepared residue"), { leavePrepared: true });
    }
    journal = { ...journal, state: "COMMITTED" };
    await atomicReplace(contained(root, JOURNAL), jsonBytes(journal));
    committed = true;
    if (hooks.leaveCommittedResidue) throw Object.assign(new Error("injected committed residue"), { leaveCommitted: true });
    await recoverTransaction(root, journal);
  } catch (error) {
    if (!committed && journal && !error.leavePrepared) {
      try { await recoverTransaction(root, journal); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "selected source OCI rehome rollback failed"); }
    }
    throw error;
  } finally {
    await release();
  }
}

async function recoverExistingTransaction(root) {
  const release = await acquireLock(root);
  try {
    const journal = await readJournal(root);
    if (!journal) return null;
    await recoverTransaction(root, journal);
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
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("rehome receipt must be a regular non-symlink");
    return parse(await readFile(target), "rehome receipt");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function rehomeSelectedReleaseSourceLineage({ repositoryRoot = ROOT, manifestPath, publishImmutableObjectPlanImpl = publishImmutableObjectPlan, client = null, env = process.env, now = () => new Date(), transactionHooks = {} }) {
  const root = path.resolve(repositoryRoot);
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) throw new Error("rehome manifest path is invalid");
  const operationRoot = path.dirname(path.resolve(manifestPath));
  if (isWithin(root, operationRoot)) throw new Error("rehome operation root must be outside repository");
  const recoveredState = await recoverExistingTransaction(root);
  if (recoveredState === "COMMITTED") return { sourceIds: SELECTED_RELEASE_SOURCE_IDS, outputPaths: OUTPUTS, recovered: true };
  requireOciParBaseUrl(env);
  const manifestBytes = await regularBytes(operationRoot, path.basename(manifestPath), "rehome manifest");
  const [snapshotBytes, specBytes, requestBytes, hashBytes, inventoryBytes, canonicalBytes, governanceBytes, freshnessBytes] = await Promise.all([
    ...OUTPUTS.map((relative) => regularBytes(root, relative, "release transaction input")),
    regularBytes(root, SUPPORT.inventory, "source inventory"), regularBytes(root, SUPPORT.canonical, "canonical pack"),
    regularBytes(root, SUPPORT.governance, "source governance policy"), regularBytes(root, SUPPORT.freshness, "freshness policy"),
  ]);
  const manifest = parse(manifestBytes, "rehome manifest");
  const inputs = new Map();
  for (const entry of manifest.sources ?? []) for (const key of ["snapshotPath", "rawPath"]) {
    if (typeof entry?.[key] === "string" && !inputs.has(entry[key])) inputs.set(entry[key], await regularBytes(operationRoot, entry[key], `rehome ${key}`));
  }
  const snapshots = parse(snapshotBytes, "source snapshot ledger");
  const successors = validateSelectedReleaseSourceRehomeManifest({ manifest, snapshots, inputs });
  const storedAtDate = now();
  if (!(storedAtDate instanceof Date) || !Number.isFinite(storedAtDate.valueOf())) throw new Error("rehome receipt time is invalid");
  const storedAt = storedAtDate.toISOString();
  for (const { entry, successor, raw, objectKey } of successors) {
    const receiptTarget = contained(operationRoot, entry.receiptPath);
    const receipt = exactReceipt({ successor, raw, storedAt });
    const priorReceipt = await existingReceipt(receiptTarget);
    if (priorReceipt) {
      const { storedAt: priorStoredAt, ...priorIdentity } = priorReceipt;
      const { storedAt: expectedStoredAt, ...expectedIdentity } = receipt;
      if (recoveredState !== "PREPARED" || !Number.isFinite(Date.parse(priorStoredAt))
        || JSON.stringify(priorIdentity) !== JSON.stringify(expectedIdentity)) {
        throw new Error("rehome receipt already exists");
      }
      continue;
    }
    try { await lstat(receiptTarget); throw new Error("rehome receipt already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { await publishImmutableObjectPlanImpl({
      root: operationRoot, client, env, sourceId: entry.sourceId,
      plan: { schemaVersion: 1, steps: [
        { type: "put-immutable-bundle-object", objectKey, sourcePath: entry.rawPath, sha256: successor.rawSha256, sizeBytes: raw.length },
        { type: "verify-immutable-bundle-object", objectKey, sourcePath: entry.rawPath, sha256: successor.rawSha256, sizeBytes: raw.length },
      ] },
    }); } catch { throw sanitizedPublicationError(); }
    await writeFile(receiptTarget, jsonBytes(receipt), { flag: "wx", mode: 0o600 });
  }
  snapshots.push(...successors.map(({ successor }) => successor));
  validateLineage(snapshots);
  const spec = parse(specBytes, "candidate build spec");
  const itxBytes = await regularBytes(root, safeRelative(spec.itxTopologyEvidencePath, "ITX topology evidence path"), "ITX topology evidence");
  const outputs = deriveOutputs({ snapshots, inventory: parse(inventoryBytes, "source inventory"), canonical: parse(canonicalBytes, "canonical pack"), governance: parse(governanceBytes, "source governance policy"), freshness: parse(freshnessBytes, "freshness policy"), spec, request: parse(requestBytes, "release request"), hashes: parse(hashBytes, "hash evidence"), canonicalBytes, inventoryBytes, governanceBytes, itxBytes });
  await transaction(root, outputs, transactionHooks);
  return { sourceIds: SELECTED_RELEASE_SOURCE_IDS, outputPaths: OUTPUTS };
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
