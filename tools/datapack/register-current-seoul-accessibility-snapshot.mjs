#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateSeoulAccessibilitySnapshotIdentity } from "./collect-seoul-accessibility-evidence.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { materializeAccessibilitySourceInput } from "./materialize-accessibility-source-input.mjs";
import { deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { buildSnapshotDiff, requiredCredentialFreeObjectUri, validateLineage } from "./source-snapshot-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_ID = "seoul-metro-accessibility";
const KRIC_SOURCE_ID = "kric-station-convenience-standard";
const SHA256 = /^[a-f0-9]{64}$/u;
const FIXED_OUTPUTS = Object.freeze([
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
]);
const SUPPORT = Object.freeze([
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
]);
const JOURNAL = "tools/datapack/.seoul-accessibility-registration-transaction.json";
const LOCK = "tools/datapack/.seoul-accessibility-registration.lock";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function parse(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); }
}
function contained(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("registration path is invalid");
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("registration path escapes repository");
  return target;
}
function within(root, candidate) { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }
async function repositoryRootInfo(repositoryRoot) {
  const lexical = path.resolve(repositoryRoot); const stat = await lstat(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("repository root must be a regular directory");
  return { lexical, real: await realpath(lexical) };
}
async function noSymlinkComponents(from, target, label) {
  const relative = path.relative(from, path.dirname(target));
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === "..") throw new Error(`${label} escapes its root`);
  let current = from;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} has a symlinked parent`);
  }
}
async function assertRepositoryTarget(root, target, label) {
  if (!within(root.lexical, target)) throw new Error(`${label} escapes repository`);
  await noSymlinkComponents(root.lexical, target, label);
  if (!within(root.real, await realpath(path.dirname(target)))) throw new Error(`${label} escapes repository`);
}
async function assertExternalTarget(root, target, label) {
  const lexical = path.resolve(target); const temporary = path.resolve(tmpdir()); const anchor = within(temporary, lexical) ? temporary : path.parse(lexical).root;
  await noSymlinkComponents(anchor, lexical, label);
  if (within(root.real, await realpath(path.dirname(lexical)))) throw new Error(`${label} must stay outside repository`);
}
async function safeParent(target) {
  const parent = path.dirname(target); const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("registration target parent is unsafe");
  return parent;
}
async function syncParent(target) {
  const handle = await open(await safeParent(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function stableBytes(target, label, confinement = null) {
  if (confinement) await confinement(target, label);
  await safeParent(target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error(`${label} changed during read`);
    return bytes;
  } finally { await handle.close(); }
}
async function optionalBytes(target, label) {
  try { return await stableBytes(target, label); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function requiredSha(value, label) { if (!SHA256.test(value ?? "")) throw new Error(`${label} must be SHA-256`); return value; }
function sameInstant(value, label) { const millis = Date.parse(value); if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) throw new Error(`${label} is invalid`); return millis; }
function exactReceipt({ receipt, snapshot, governance, now }) {
  const keys = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "snapshotRawSha256", "capturedAt", "snapshotFileSha256", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt"];
  if (!receipt || JSON.stringify(Object.keys(receipt)) !== JSON.stringify(keys)
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "seoul-accessibility-raw-object-receipt"
    || receipt.sourceId !== SOURCE_ID || receipt.snapshotId !== snapshot.snapshotId
    || receipt.snapshotRawSha256 !== snapshot.rawSha256 || receipt.capturedAt !== snapshot.capturedAt
    || !SHA256.test(receipt.snapshotFileSha256 ?? "")
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize <= 0) throw new Error("Seoul OCI receipt binding is invalid");
  requiredCredentialFreeObjectUri(receipt.rawObjectUri, "Seoul OCI receipt URI");
  const rawSha = requiredSha(receipt.rawObjectSha256, "Seoul OCI receipt raw hash");
  const day = snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  if (receipt.rawObjectUri !== `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/${SOURCE_ID}/${day}/${rawSha}.json`) throw new Error("Seoul OCI receipt URI is invalid");
  const captured = sameInstant(snapshot.capturedAt, "Seoul snapshot capturedAt");
  const stored = sameInstant(receipt.storedAt, "Seoul OCI receipt storedAt");
  if (stored < captured || stored > now.getTime()) throw new Error("Seoul OCI receipt storage time is invalid");
  const retention = deriveRawRetentionExpiresAt({ policy: governance, sourceId: SOURCE_ID, retrievedAt: snapshot.capturedAt });
  if (receipt.rawRetentionExpiresAt !== retention || sameInstant(retention, "Seoul raw retention") <= stored) throw new Error("Seoul OCI receipt retention is invalid");
}
function sourceById(inventory, sourceId) {
  const sources = inventory?.sources?.filter(({ id }) => id === sourceId) ?? [];
  if (sources.length !== 1) throw new Error(`source inventory ${sourceId} is invalid`);
  return sources[0];
}
function validateGovernance({ inventory, governance, freshness, snapshot, receipt, now }) {
  const { policySources } = validateSourceGovernancePolicy({ policy: governance, inventory, freshnessPolicy: freshness });
  const source = sourceById(inventory, SOURCE_ID); const policy = policySources.get(SOURCE_ID); const review = policy?.licenseReview;
  if (!policy || source.requiredForProductionPack !== true || source.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true || source.license?.commercialUseAllowed !== true
    || source.license?.derivativeWorkAllowed !== true || review?.status !== "APPROVED"
    || review.termsHash !== source.admissionEvidence?.licenseEvidenceHash || review.reviewedProvider !== source.provider
    || review.reviewedDatasetUrl !== source.datasetUrl || !review.redistributionScopes?.includes("DERIVED_DATAPACK")
    || Date.parse(review.reviewedAt) > now.getTime() || Date.parse(review.nextReviewAt) <= now.getTime()) throw new Error("Seoul governance identity is invalid");
  exactReceipt({ receipt, snapshot, governance, now });
  const expires = deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: policy.sourceClassId, basisAt: snapshot.capturedAt, evaluationAt: now.toISOString() });
  if (sameInstant(expires, "Seoul freshness") <= now.getTime() || sameInstant(snapshot.freshUntil, "Seoul observation freshness") <= now.getTime()) throw new Error("Seoul snapshot is stale");
  return { source, policy, freshnessExpiresAt: expires };
}
function ledgerReceipt(receipt) {
  return { sourceId: receipt.sourceId, snapshotId: receipt.snapshotId, snapshotRawSha256: receipt.snapshotRawSha256, capturedAt: receipt.capturedAt, snapshotFileSha256: receipt.snapshotFileSha256, rawObjectSha256: receipt.rawObjectSha256, byteSize: receipt.byteSize, storedAt: receipt.storedAt };
}
function buildLedger({ snapshots, inventory, snapshot, receipt, governance, governanceBytes, freshness, now }) {
  const heads = validateLineage(snapshots).headsBySource; const previous = snapshots.find(({ snapshotId }) => snapshotId === heads[SOURCE_ID]);
  if (!previous || snapshot.previousSnapshotId !== previous.snapshotId || sameInstant(snapshot.capturedAt, "Seoul snapshot capturedAt") <= sameInstant(previous.retrievedAt, "current Seoul retrievedAt")) throw new Error("Seoul snapshot is not the direct current successor");
  const { source, freshnessExpiresAt } = validateGovernance({ inventory, governance, freshness, snapshot, receipt, now });
  const next = {
    schemaVersion: 1, artifactKind: "official-source-snapshot", snapshotId: snapshot.snapshotId, sourceId: SOURCE_ID,
    provider: source.provider, retrievedAt: snapshot.capturedAt, sourceUpdatedAt: snapshot.observedAt,
    rowCount: snapshot.stations.length, coverageCount: snapshot.stations.length, rawSha256: receipt.rawObjectSha256,
    rawObjectUri: receipt.rawObjectUri, rawReceipt: ledgerReceipt(receipt), contentSha256: snapshot.contentSha256,
    redactedRequestFingerprint: previous.redactedRequestFingerprint, schemaFingerprint: snapshot.schemaFingerprint,
    snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS",
    redistributionAllowed: true, credentialRedacted: true, previousSnapshotId: previous.snapshotId,
    freshnessExpiresAt, rawRetentionExpiresAt: receipt.rawRetentionExpiresAt,
    providerRecordHashes: snapshot.stations.map((station) => sha(JSON.stringify(station))),
    governancePolicyVersion: governance.policyVersion, governancePolicySha256: sha(governanceBytes),
  };
  next.diffSummary = buildSnapshotDiff(previous, next);
  return next;
}
function deriveReleaseEvidence({ snapshots, inventory, canonical, governance, freshness, spec, request, hashes, canonicalBytes, inventoryBytes, governanceBytes, itxBytes }) {
  const heads = validateLineage(snapshots).headsBySource; const capital = canonical.packs?.find(({ id }) => id === "capital");
  if (!capital) throw new Error("canonical capital pack is missing");
  const releaseSnapshots = snapshots.filter((snapshot) => capital.sourceInventory.some(({ id }) => id === snapshot.sourceId) && heads[snapshot.sourceId] === snapshot.snapshotId);
  const bySource = new Map(inventory.sources.map((source) => [source.id, source])); const nextSpec = structuredClone(spec);
  nextSpec.sourceSnapshotIds = releaseSnapshots.map(({ snapshotId }) => snapshotId);
  nextSpec.sourceSnapshots = releaseSnapshots.map((snapshot) => {
    const source = bySource.get(snapshot.sourceId); const review = source?.admissionEvidence?.adminReviewRecordHash;
    const sourceClass = freshness.sourceClasses.find(({ sourceIds }) => sourceIds.includes(snapshot.sourceId));
    if (!SHA256.test(review ?? "") || !sourceClass) throw new Error(`release source projection is invalid: ${snapshot.sourceId}`);
    const expires = deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: sourceClass.id, basisAt: snapshot[sourceClass.basisField], providerValidUntil: sourceClass.providerValidityEndField == null ? undefined : snapshot[sourceClass.providerValidityEndField], evaluationAt: snapshot.retrievedAt });
    return { snapshotId: snapshot.snapshotId, sourceId: snapshot.sourceId, rawObjectUri: snapshot.rawObjectUri, rawSha256: snapshot.rawSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint, schemaFingerprint: snapshot.schemaFingerprint, licenseStatus: snapshot.licenseStatus, redistributionAllowed: snapshot.redistributionAllowed, adminReviewRecordHash: review, snapshotStatus: snapshot.snapshotStatus, credentialRedacted: snapshot.credentialRedacted, freshnessExpiresAt: expires, rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governance, sourceId: snapshot.sourceId, retrievedAt: snapshot.retrievedAt }), governancePolicyVersion: governance.policyVersion, governancePolicySha256: sha(governanceBytes) };
  });
  nextSpec.sourceSnapshotSetHash = sha(JSON.stringify(releaseSnapshots)); nextSpec.sourceInventorySha256 = sha(JSON.stringify(inventory)); nextSpec.itxTopologyEvidenceSha256 = sha(itxBytes); nextSpec.networkEdgeEvidence.sourceInventory.sha256 = sha(inventoryBytes);
  const specBytes = jsonBytes(nextSpec); const nextRequest = structuredClone(request); nextRequest.buildSpecSha256 = sha(specBytes); nextRequest.sourceSnapshotSetHash = nextSpec.sourceSnapshotSetHash;
  const nextHashes = structuredClone(hashes); nextHashes.sourceSnapshotSetHash.value = nextSpec.sourceSnapshotSetHash; nextHashes.sourceInventorySha256.value = nextSpec.sourceInventorySha256; nextHashes.fixturePath.sha256 = sha(canonicalBytes);
  nextHashes.sourceSnapshots.order = `release snapshot 순서: ${releaseSnapshots.map(({ sourceId }) => sourceId).join(" → ")}`;
  nextHashes.perSourceEvidence = releaseSnapshots.map((snapshot) => ({ sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256, adminReviewRecordHash: bySource.get(snapshot.sourceId).admissionEvidence.adminReviewRecordHash, perSourceSnapshotSetHash: sha(JSON.stringify([snapshot])) }));
  return { specBytes, requestBytes: jsonBytes(nextRequest), hashBytes: jsonBytes(nextHashes) };
}

export async function buildCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot = ROOT, snapshotPath, receiptPath, now = new Date() } = {}) {
  const root = await repositoryRootInfo(repositoryRoot); if (!path.isAbsolute(snapshotPath ?? "") || !path.isAbsolute(receiptPath ?? "")) throw new Error("external Seoul observation and receipt paths are required");
  const external = (target, label) => assertExternalTarget(root, target, label);
  const repository = (relative, label) => { const target = contained(root.lexical, relative); return { target, checked: assertRepositoryTarget(root, target, label) }; };
  await Promise.all([external(snapshotPath, "external Seoul snapshot"), external(receiptPath, "external Seoul OCI receipt")]);
  const readRepository = async (relative, label) => { const item = repository(relative, label); await item.checked; return stableBytes(item.target, label); };
  const [snapshotBytes, receiptBytes, inventoryBytes, ledgerBytes, inputBytes, specBytes, requestBytes, hashBytes, ...support] = await Promise.all([
    stableBytes(snapshotPath, "external Seoul snapshot", external), stableBytes(receiptPath, "external Seoul OCI receipt", external),
    readRepository("tools/datapack/source-inventory.json", "source inventory"), readRepository("tools/datapack/release/source-snapshots.json", "source ledger"), readRepository("tools/datapack/inputs/capital-pilot-production-source-input.json", "capital source input"), readRepository("tools/datapack/release/candidate-build-spec.json", "candidate build spec"), readRepository("tools/datapack/release/release-request.json", "release request"), readRepository("tools/datapack/release/hash-evidence.json", "hash evidence"), ...SUPPORT.map((relative) => readRepository(relative, relative)),
  ]);
  const snapshot = validateSeoulAccessibilitySnapshotIdentity(parse(snapshotBytes, "external Seoul snapshot")); const receipt = parse(receiptBytes, "external Seoul OCI receipt");
  if (receipt.snapshotFileSha256 !== sha(snapshotBytes)) throw new Error("Seoul OCI receipt snapshot bytes mismatch");
  const inventory = parse(inventoryBytes, "source inventory"); const snapshots = parse(ledgerBytes, "source ledger"); const input = parse(inputBytes, "capital source input");
  const [canonicalBytes, governanceBytes, freshnessBytes] = support; const governance = parse(governanceBytes, "source governance policy"); const freshness = parse(freshnessBytes, "freshness policy");
  const nextLedger = buildLedger({ snapshots, inventory, snapshot, receipt, governance, governanceBytes, freshness, now });
  const nextInventory = structuredClone(inventory); const source = sourceById(nextInventory, SOURCE_ID);
  source.retrievedAt = snapshot.capturedAt.slice(0, 10); source.observedDataUpdatedAt = snapshot.observedAt.slice(0, 10);
  source.accessibilityAdmissionEvidence = { ...source.accessibilityAdmissionEvidence, productionUseAllowed: true, snapshotId: snapshot.snapshotId, snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`, capturedAt: snapshot.capturedAt, observedAt: snapshot.observedAt, freshUntil: snapshot.freshUntil, absenceEvidenceMode: snapshot.absenceEvidenceMode, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, schemaFingerprint: snapshot.schemaFingerprint, snapshotFileSha256: sha(snapshotBytes) };
  const kricEvidence = sourceById(inventory, KRIC_SOURCE_ID).accessibilityAdmissionEvidence;
  const currentHeads = validateLineage(snapshots).headsBySource;
  const currentCandidate = parse(specBytes, "candidate build spec");
  if (currentHeads[KRIC_SOURCE_ID] !== kricEvidence?.snapshotId
    || currentCandidate.sourceSnapshots?.find(({ sourceId }) => sourceId === KRIC_SOURCE_ID)?.snapshotId !== kricEvidence.snapshotId) {
    throw new Error("current KRIC accessibility input is not the active head");
  }
  const kricBytes = await readRepository(kricEvidence.snapshotPath, "current KRIC accessibility snapshot");
  const nextInput = materializeAccessibilitySourceInput({ input: structuredClone(input), kricSnapshot: parse(kricBytes, "current KRIC accessibility snapshot"), seoulSnapshot: snapshot });
  const nextSnapshots = [...snapshots, nextLedger]; validateLineage(nextSnapshots);
  const nextInventoryBytes = jsonBytes(nextInventory); const derived = deriveReleaseEvidence({ snapshots: nextSnapshots, inventory: nextInventory, canonical: parse(canonicalBytes, "canonical pack"), governance, freshness, spec: currentCandidate, request: parse(requestBytes, "release request"), hashes: parse(hashBytes, "hash evidence"), canonicalBytes, inventoryBytes: nextInventoryBytes, governanceBytes, itxBytes: await readRepository(currentCandidate.itxTopologyEvidencePath, "ITX evidence") });
  const allDerivedCandidate = parse(derived.specBytes, "derived candidate build spec");
  const nextCandidate = structuredClone(currentCandidate);
  const seoulIndex = nextCandidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === SOURCE_ID);
  const derivedSeoulProjection = allDerivedCandidate.sourceSnapshots.find(({ sourceId }) => sourceId === SOURCE_ID);
  if (seoulIndex < 0 || !derivedSeoulProjection) throw new Error("current Seoul candidate projection is missing");
  nextCandidate.sourceSnapshotIds[seoulIndex] = nextLedger.snapshotId;
  nextCandidate.sourceSnapshots[seoulIndex] = derivedSeoulProjection;
  nextCandidate.sourceSnapshotSetHash = allDerivedCandidate.sourceSnapshotSetHash;
  nextCandidate.sourceInventorySha256 = allDerivedCandidate.sourceInventorySha256;
  nextCandidate.networkEdgeEvidence.sourceInventory.sha256 = allDerivedCandidate.networkEdgeEvidence.sourceInventory.sha256;
  const nextRequest = parse(derived.requestBytes, "derived release request");
  const nextHashEvidence = parse(derived.hashBytes, "derived hash evidence");
  for (const projection of currentCandidate.sourceSnapshots) {
    if (projection.sourceId !== SOURCE_ID
      && canonicalJson(nextCandidate.sourceSnapshots.find(({ sourceId }) => sourceId === projection.sourceId)) !== canonicalJson(projection)) {
      throw new Error("non-Seoul active candidate projection changed");
    }
  }
  const finalSelected = nextSnapshots.filter(({ snapshotId }) => nextCandidate.sourceSnapshotIds.includes(snapshotId));
  if (finalSelected.length !== nextCandidate.sourceSnapshotIds.length
    || JSON.stringify(finalSelected.map(({ snapshotId }) => snapshotId).sort((left, right) => left.localeCompare(right)))
      !== JSON.stringify([...nextCandidate.sourceSnapshotIds].sort((left, right) => left.localeCompare(right)))) {
    throw new Error("final candidate selected source IDs are invalid");
  }
  nextCandidate.sourceSnapshotSetHash = sha(JSON.stringify(finalSelected));
  nextRequest.sourceSnapshotSetHash = nextCandidate.sourceSnapshotSetHash;
  nextHashEvidence.sourceSnapshotSetHash.value = nextCandidate.sourceSnapshotSetHash;
  nextHashEvidence.sourceSnapshotSetHash.contract = `source별 head ${finalSelected.length}종의 byte-ordered JSON hash와 build spec·release request가 일치해야 한다.`;
  nextHashEvidence.sourceSnapshots.order = `release snapshot 순서: ${finalSelected.map(({ sourceId }) => sourceId).join(" → ")}`;
  nextHashEvidence.perSourceEvidence = finalSelected.map((entry) => ({ sourceId: entry.sourceId, snapshotId: entry.snapshotId, rawSha256: entry.rawSha256, adminReviewRecordHash: nextInventory.sources.find(({ id }) => id === entry.sourceId).admissionEvidence.adminReviewRecordHash, perSourceSnapshotSetHash: sha(JSON.stringify([entry])) }));
  const nextCandidateFinalBytes = jsonBytes(nextCandidate);
  nextRequest.buildSpecSha256 = sha(nextCandidateFinalBytes);
  const snapshotRelative = `tools/datapack/sources/${snapshot.snapshotId}.json`; const snapshotTarget = repository(snapshotRelative, "Seoul snapshot target"); await snapshotTarget.checked;
  const existingSnapshot = await optionalBytes(snapshotTarget.target, "Seoul snapshot target");
  if (existingSnapshot != null && !existingSnapshot.equals(snapshotBytes)) throw new Error("Seoul snapshot target immutable collision");
  return [
    { relative: snapshotRelative, bytes: snapshotBytes, prestateBytes: existingSnapshot },
    { relative: "tools/datapack/source-inventory.json", bytes: nextInventoryBytes, prestateBytes: inventoryBytes },
    { relative: "tools/datapack/release/source-snapshots.json", bytes: jsonBytes(nextSnapshots), prestateBytes: ledgerBytes },
    { relative: "tools/datapack/inputs/capital-pilot-production-source-input.json", bytes: jsonBytes(nextInput), prestateBytes: inputBytes },
    { relative: "tools/datapack/release/candidate-build-spec.json", bytes: nextCandidateFinalBytes, prestateBytes: specBytes },
    { relative: "tools/datapack/release/release-request.json", bytes: jsonBytes(nextRequest), prestateBytes: requestBytes },
    { relative: "tools/datapack/release/hash-evidence.json", bytes: jsonBytes(nextHashEvidence), prestateBytes: hashBytes },
  ];
}

function assertOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length !== 7 || !outputs.every(({ relative, bytes, prestateBytes }) => typeof relative === "string" && Buffer.isBuffer(bytes) && (prestateBytes === null || Buffer.isBuffer(prestateBytes)))) throw new Error("Seoul registration must stage exactly seven outputs");
  if (!/^tools\/datapack\/sources\/seoul-metro-accessibility-[0-9TZ]+\.json$/u.test(outputs[0].relative) || JSON.stringify(outputs.slice(1).map(({ relative }) => relative)) !== JSON.stringify(FIXED_OUTPUTS)) throw new Error("Seoul registration output allowlist mismatch");
}
async function currentBytes(target) { return optionalBytes(target, "Seoul registration target"); }
async function assertExpected(target, expected) { const actual = await currentBytes(target); if ((actual == null) !== (expected == null) || actual?.equals(expected) === false) throw new Error("Seoul registration preserves foreign replacement"); }
async function writeAtomic(target, bytes, expected) {
  await safeParent(target); await assertExpected(target, expected); const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try { const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await assertExpected(target, expected); if (expected === null) { await rename(temporary, target); } else await rename(temporary, target); await syncParent(target); await assertExpected(target, bytes); } finally { await unlink(temporary).catch(() => {}); }
}
async function lease(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    const fail = (error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", fail); resolve(); };
    server.once("error", fail); server.once("listening", ready); server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
  return server;
}
async function closeLease(server) { if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function lockBytes(server) {
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || !Number.isInteger(address.port) || address.port < 1) throw new Error("Seoul registration lock lease is invalid");
  return jsonBytes({ schemaVersion: 1, host: "127.0.0.1", port: address.port, pid: process.pid, token: randomUUID() });
}
async function createLock(lock, bytes) {
  const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncParent(lock);
}
function parseLock(bytes) {
  let value;
  try { value = parse(bytes, "Seoul registration lock"); } catch { throw new Error("Seoul registration lock residue exists"); }
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(["schemaVersion", "host", "port", "pid", "token"])
    || value.schemaVersion !== 1 || value.host !== "127.0.0.1" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || !Number.isInteger(value.pid) || value.pid <= 0
    || typeof value.token !== "string" || !/^[a-f0-9-]{36}$/u.test(value.token)) {
    throw new Error("Seoul registration lock residue exists");
  }
  return value;
}
async function acquireLock(root, hooks = {}) {
  const lock = contained(root.lexical, LOCK); await assertRepositoryTarget(root, lock, "Seoul registration lock"); let server = await lease(); let bytes = lockBytes(server);
  try {
    await createLock(lock, bytes);
  } catch (error) {
    if (error?.code !== "EEXIST") { await closeLease(server); throw error; }
    await closeLease(server); server = null;
    const expected = await stableBytes(lock, "Seoul registration lock", (target, label) => assertRepositoryTarget(root, target, label));
    const stale = parseLock(expected); await hooks.afterStaleLockRead?.();
    try { server = await lease(stale.port); } catch (leaseError) { throw new Error("Seoul registration lock residue exists", { cause: leaseError }); }
    bytes = lockBytes(server);
    try { await writeAtomic(lock, bytes, expected); } catch (reclaimError) { await closeLease(server); throw new Error("Seoul registration lock residue exists", { cause: reclaimError }); }
  }
  const release = async () => {
    try { const current = await stableBytes(lock, "Seoul registration lock", (target, label) => assertRepositoryTarget(root, target, label)); if (!current.equals(bytes)) return; await unlink(lock); await syncParent(lock); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    finally { await closeLease(server); }
  };
  try { await hooks.afterLockAcquired?.(); } catch (error) { await release(); throw error; }
  return release;
}
function journalRecords(outputs) { return outputs.map(({ relative, bytes, prestateBytes }) => ({ relative, before: prestateBytes?.toString("base64") ?? null, after: bytes.toString("base64"), beforeSha256: prestateBytes == null ? null : sha(prestateBytes), afterSha256: sha(bytes) })); }
async function recover(root, journal) {
  if (!journal || !["PREPARED", "COMMITTED"].includes(journal.state) || !Array.isArray(journal.records) || journal.records.length !== 7) throw new Error("Seoul registration recovery required");
  for (const record of journal.records) { const target = contained(root.lexical, record.relative); await assertRepositoryTarget(root, target, "Seoul registration recovery target"); const before = record.before == null ? null : Buffer.from(record.before, "base64"); const after = Buffer.from(record.after, "base64"); if (sha(after) !== record.afterSha256 || (before != null && sha(before) !== record.beforeSha256)) throw new Error("Seoul registration recovery required"); const current = await currentBytes(target); if (journal.state === "COMMITTED") { if (!current?.equals(after)) throw new Error("Seoul registration preserves foreign replacement"); continue; } if ((before != null && current?.equals(before)) || (current == null && before == null)) continue; if (!current?.equals(after)) throw new Error("Seoul registration preserves foreign replacement"); if (before == null) { await unlink(target); await syncParent(target); } else await writeAtomic(target, before, after); }
  const journalTarget = contained(root.lexical, JOURNAL); await unlink(journalTarget); await syncParent(journalTarget);
}
export async function commitCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot = ROOT, outputs, failAfter = null, failCommittedJournalWrite = false, lockHooks = {} } = {}) {
  assertOutputs(outputs); const root = await repositoryRootInfo(repositoryRoot); const target = async (relative, label) => { const value = contained(root.lexical, relative); await assertRepositoryTarget(root, value, label); return value; }; const release = await acquireLock(root, lockHooks); let journal;
  try {
    const journalTarget = await target(JOURNAL, "Seoul registration journal"); const existing = await optionalBytes(journalTarget, "Seoul registration journal"); if (existing) await recover(root, parse(existing, "Seoul registration journal"));
    for (const output of outputs) await assertExpected(await target(output.relative, "Seoul registration output"), output.prestateBytes);
    journal = { state: "PREPARED", records: journalRecords(outputs) }; await writeAtomic(journalTarget, jsonBytes(journal), null);
    for (const [index, output] of outputs.entries()) { await writeAtomic(await target(output.relative, "Seoul registration output"), output.bytes, output.prestateBytes); if (index === failAfter) throw new Error("injected transaction failure"); }
    const committedJournal = { ...journal, state: "COMMITTED" }; if (failCommittedJournalWrite) throw new Error("injected COMMITTED journal persistence failure"); await writeAtomic(journalTarget, jsonBytes(committedJournal), jsonBytes(journal)); journal = committedJournal; await recover(root, journal);
  } catch (error) { if (journal) { try { await recover(root, journal); } catch (recovery) { throw new AggregateError([error, recovery], "Seoul registration rollback failed"); } } throw error; }
  finally { await release(); }
}
export async function registerCurrentSeoulAccessibilitySnapshot(options = {}) { const outputs = await buildCurrentSeoulAccessibilityRegistrationOutputs(options); await commitCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: options.repositoryRoot, outputs }); return { outputs: outputs.map(({ relative }) => relative) }; }

async function main(argv) { if (argv.length !== 4 || argv[0] !== "--snapshot" || argv[2] !== "--receipt") throw new Error("usage: --snapshot <absolute> --receipt <absolute>"); const result = await registerCurrentSeoulAccessibilitySnapshot({ snapshotPath: argv[1], receiptPath: argv[3] }); process.stdout.write(`${JSON.stringify({ status: "PASS", outputs: result.outputs })}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
