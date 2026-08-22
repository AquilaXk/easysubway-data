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
    for (const key of ["provider", "sourceUpdatedAt", "rowCount", "coverageCount", "redactedRequestFingerprint", "schemaFingerprint", "licenseStatus", "redistributionAllowed", "snapshotStatus", "credentialRedacted"]) {
      if (key === "coverageCount" && current[key] == null) continue;
      if (JSON.stringify(successor[key]) !== JSON.stringify(current[key])) throw new Error("rehome semantic evidence drift");
    }
    const locator = parseCredentialFreeObjectUri(successor.rawObjectUri, "rehome OCI object URI");
    if (!successor.rawObjectUri.startsWith("oci://")) throw new Error("rehome object URI must be OCI");
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
  /* c8 ignore next */
  const inventoryBySource = new Map(inventory.sources.map((entry) => [entry.id, entry]));
  const capital = canonical.packs?.find(({ id }) => id === "capital");
  if (!capital) throw new Error("canonical capital pack is missing");
  const heads = validateLineage(snapshots).headsBySource;
  const activeIds = new Set((capital.sourceInventory ?? []).map(({ id }) => id));
  const releaseSnapshots = snapshots.filter((snapshot) => activeIds.has(snapshot.sourceId) && heads[snapshot.sourceId] === snapshot.snapshotId);
  const nextSpec = structuredClone(spec);
  nextSpec.sourceSnapshotIds = releaseSnapshots.map(({ snapshotId }) => snapshotId);
  nextSpec.sourceSnapshots = releaseSnapshots.map((snapshot) => {
    const source = inventoryBySource.get(snapshot.sourceId);
    const adminReviewRecordHash = source?.admissionEvidence?.adminReviewRecordHash;
    const sourceClass = freshness.sourceClasses?.find(({ sourceIds }) => sourceIds.includes(snapshot.sourceId));
    if (!SHA256.test(adminReviewRecordHash ?? "") || !sourceClass) throw new Error("release source admission or freshness evidence is missing");
    let expires = addCadence(Date.parse(snapshot[sourceClass.basisField]), sourceClass.reverificationCadence ?? sourceClass.maximumReverificationCadence);
    if (sourceClass.providerValidityEndField) expires = Math.min(expires, Date.parse(snapshot[sourceClass.providerValidityEndField]));
    return {
      snapshotId: snapshot.snapshotId, sourceId: snapshot.sourceId, rawObjectUri: snapshot.rawObjectUri,
      rawSha256: snapshot.rawSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
      schemaFingerprint: snapshot.schemaFingerprint, licenseStatus: snapshot.licenseStatus,
      redistributionAllowed: snapshot.redistributionAllowed, adminReviewRecordHash, snapshotStatus: snapshot.snapshotStatus,
      credentialRedacted: snapshot.credentialRedacted, freshnessExpiresAt: new Date(expires).toISOString(),
      rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governance, sourceId: snapshot.sourceId, retrievedAt: snapshot.retrievedAt }),
      governancePolicyVersion: governance.policyVersion, governancePolicySha256: sha256(governanceBytes),
    };
  });
  nextSpec.sourceSnapshotSetHash = sha256(JSON.stringify(releaseSnapshots));
  nextSpec.sourceInventorySha256 = sha256(JSON.stringify(inventory));
  nextSpec.itxTopologyEvidenceSha256 = sha256(itxBytes);
  nextSpec.networkEdgeEvidence.sourceInventory.sha256 = sha256(inventoryBytes);
  const specBytes = jsonBytes(nextSpec);
  const nextRequest = structuredClone(request);
  nextRequest.buildSpecSha256 = sha256(specBytes);
  nextRequest.sourceSnapshotSetHash = nextSpec.sourceSnapshotSetHash;
  const nextHashes = structuredClone(hashes);
  nextHashes.sourceSnapshotSetHash.value = nextSpec.sourceSnapshotSetHash;
  nextHashes.sourceSnapshotSetHash.contract = `source별 head ${releaseSnapshots.length}종의 byte-ordered JSON hash와 build spec·release request가 일치해야 한다.`;
  nextHashes.sourceInventorySha256.value = nextSpec.sourceInventorySha256;
  nextHashes.fixturePath.sha256 = sha256(canonicalBytes);
  nextHashes.sourceSnapshots.order = `release snapshot 순서: ${releaseSnapshots.map(({ sourceId }) => sourceId).join(" → ")}`;
  nextHashes.perSourceEvidence = releaseSnapshots.map((snapshot) => ({ sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256, adminReviewRecordHash: inventoryBySource.get(snapshot.sourceId).admissionEvidence.adminReviewRecordHash, perSourceSnapshotSetHash: sha256(JSON.stringify([snapshot])) }));
  return [
    { relativePath: OUTPUTS[0], bytes: jsonBytes(snapshots) },
    { relativePath: OUTPUTS[1], bytes: specBytes },
    { relativePath: OUTPUTS[2], bytes: jsonBytes(nextRequest) },
    { relativePath: OUTPUTS[3], bytes: jsonBytes(nextHashes) },
  ];
}

async function atomicReplace(target, bytes) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
}

const JOURNAL = "tools/datapack/.selected-release-source-oci-rehome-transaction.json";
const transactionIdPattern = /^[a-f0-9-]{36}$/u;

async function restoreTransaction(root, journal) {
  if (!journal || journal.schemaVersion !== 1 || journal.state !== "PREPARED"
    || !transactionIdPattern.test(journal.transactionId ?? "") || !Array.isArray(journal.records)
    || JSON.stringify(journal.records.map(({ relativePath }) => relativePath)) !== JSON.stringify(OUTPUTS)) {
    throw new Error("selected source OCI rehome transaction journal is invalid");
  }
  const directory = path.join(root, "tools/datapack", `.selected-release-source-oci-rehome-${journal.transactionId}`);
  for (const [index, record] of journal.records.entries()) {
    if (!SHA256.test(record.beforeSha256 ?? "")) throw new Error("selected source OCI rehome transaction journal is invalid");
    const before = await regularBytes(root, path.relative(root, path.join(directory, `${index}.before`)), "selected source OCI rehome backup");
    if (sha256(before) !== record.beforeSha256) throw new Error("selected source OCI rehome backup checksum mismatch");
    await atomicReplace(contained(root, record.relativePath), before);
  }
  await rm(directory, { recursive: true, force: true });
  await unlink(contained(root, JOURNAL));
}

async function transaction(root, outputs) {
  const lock = path.join(root, "tools/datapack/.selected-release-source-oci-rehome.lock");
  const journalPath = contained(root, JOURNAL);
  let handle;
  try { handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch { throw new Error("selected source OCI rehome is already running or needs recovery"); }
  let journal;
  try {
    try {
      const prior = await regularBytes(root, JOURNAL, "selected source OCI rehome transaction journal");
      await restoreTransaction(root, parse(prior, "selected source OCI rehome transaction journal"));
    } catch (error) {
      if (!/is missing$/u.test(error.message)) throw error;
    }
    const transactionId = randomUUID();
    const directory = path.join(root, "tools/datapack", `.selected-release-source-oci-rehome-${transactionId}`);
    await mkdir(directory, { recursive: false });
    const records = [];
    for (const [index, output] of outputs.entries()) {
      const before = await regularBytes(root, output.relativePath, "release transaction input");
      const backup = path.join(directory, `${index}.before`);
      await writeFile(backup, before, { flag: "wx", mode: 0o600 });
      records.push({ relativePath: output.relativePath, beforeSha256: sha256(before) });
    }
    journal = { schemaVersion: 1, state: "PREPARED", transactionId, records };
    await writeFile(journalPath, jsonBytes(journal), { flag: "wx", mode: 0o600 });
    for (const output of outputs) await atomicReplace(contained(root, output.relativePath), output.bytes);
    await unlink(journalPath);
    await rm(directory, { recursive: true });
  } catch (error) {
    if (journal) {
      try { await restoreTransaction(root, journal); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "selected source OCI rehome rollback failed"); }
    }
    throw error;
  } finally {
    await handle.close(); await unlink(lock).catch(() => {});
  }
}

function sanitizedPublicationError() { return new Error("OCI source publication failed"); }

export async function rehomeSelectedReleaseSourceLineage({ repositoryRoot = ROOT, manifestPath, publishImmutableObjectPlanImpl = publishImmutableObjectPlan, client = null, env = process.env }) {
  const root = path.resolve(repositoryRoot);
  requireOciParBaseUrl(env);
  const operationRoot = path.dirname(path.resolve(manifestPath));
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
  for (const { entry, successor, raw, objectKey } of successors) {
    const receiptTarget = contained(operationRoot, entry.receiptPath);
    try { await lstat(receiptTarget); throw new Error("rehome receipt already exists"); } catch (error) { if (!/ENOENT/u.test(error.code ?? "")) throw error; }
    try { await publishImmutableObjectPlanImpl({
      root: operationRoot, client, env, sourceId: entry.sourceId,
      plan: { schemaVersion: 1, steps: [
        { type: "put-immutable-bundle-object", objectKey, sourcePath: entry.rawPath, sha256: successor.rawSha256, sizeBytes: raw.length },
        { type: "verify-immutable-bundle-object", objectKey, sourcePath: entry.rawPath, sha256: successor.rawSha256, sizeBytes: raw.length },
      ] },
    }); } catch { throw sanitizedPublicationError(); }
    const receipt = { schemaVersion: 1, artifactKind: "selected-release-source-oci-raw-receipt", sourceId: successor.sourceId, snapshotId: successor.snapshotId, rawObjectUri: successor.rawObjectUri, rawObjectSha256: successor.rawSha256, byteSize: raw.length };
    await writeFile(receiptTarget, jsonBytes(receipt), { flag: "wx", mode: 0o600 });
  }
  snapshots.push(...successors.map(({ successor }) => successor));
  validateLineage(snapshots);
  const spec = parse(specBytes, "candidate build spec");
  const itxBytes = await regularBytes(root, safeRelative(spec.itxTopologyEvidencePath, "ITX topology evidence path"), "ITX topology evidence");
  const outputs = deriveOutputs({ snapshots, inventory: parse(inventoryBytes, "source inventory"), canonical: parse(canonicalBytes, "canonical pack"), governance: parse(governanceBytes, "source governance policy"), freshness: parse(freshnessBytes, "freshness policy"), spec, request: parse(requestBytes, "release request"), hashes: parse(hashBytes, "hash evidence"), canonicalBytes, inventoryBytes, governanceBytes, itxBytes });
  await transaction(root, outputs);
  return { sourceIds: SELECTED_RELEASE_SOURCE_IDS, outputPaths: OUTPUTS };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--manifest");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--manifest is required");
  await rehomeSelectedReleaseSourceLineage({ manifestPath: path.resolve(process.argv[index + 1]) });
  process.stdout.write("REHOMED_SELECTED_SOURCE_LINEAGE\n");
}
