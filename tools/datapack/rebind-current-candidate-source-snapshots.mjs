#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deriveFreshness, deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { approvedGovernanceBindingTransition, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { validateKricAccessibilitySnapshotIdentity } from "./collect-kric-accessibility-snapshots.mjs";
import { requiredCredentialFreeObjectUri, validateLineage } from "./source-snapshot-policy.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { approvedLegacyGovernanceBinding } from "./legacy-source-governance.mjs";

const SOURCE_ID = "kric-station-convenience-standard";
const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";
const ACTIVE_SOURCE_IDS = Object.freeze([
  "seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility",
  SOURCE_ID, "molit-urban-rail-full-route", "seoulmetro-station-line-info",
]);
const ACTIVE_SOURCE_IDS_WITH_TRANSFER = Object.freeze([...ACTIVE_SOURCE_IDS, TRANSFER_SOURCE_ID]);
const CAPITAL_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-route-map-positions",
  "kric-subway-timetable", "seoul-metro-accessibility", SOURCE_ID, "seoul-metro-official-od-fares",
]);
const CAPITAL_ACTIVE_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-route-map-positions",
  "kric-subway-timetable", "seoul-metro-accessibility", SOURCE_ID,
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const PROJECTION_KEYS = Object.freeze([
  "snapshotId", "sourceId", "rawObjectUri", "rawSha256", "redactedRequestFingerprint",
  "schemaFingerprint", "licenseStatus", "redistributionAllowed", "adminReviewRecordHash",
  "snapshotStatus", "credentialRedacted", "freshnessExpiresAt", "rawRetentionExpiresAt",
  "governancePolicyVersion", "governancePolicySha256",
]);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PATHS = Object.freeze({
  candidate: "tools/datapack/release/candidate-build-spec.json",
  releaseRequest: "tools/datapack/release/release-request.json",
  inventory: "tools/datapack/source-inventory.json",
  snapshots: "tools/datapack/release/source-snapshots.json",
  pack: "tools/datapack/release/capital-production-canonical-pack.json",
  governance: "tools/datapack/source-governance-policy.json",
  freshness: "release/product-gates/datapack-freshness-sla.json",
  lock: "tools/datapack/.candidate-source-rebind.lock",
});

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function parse(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); }
}
function requiredSha(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be a SHA-256`);
  return value;
}
function exactlyOne(rows, predicate, label) {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label} must have exactly one match`);
  return matches[0];
}
function sameBytes(left, right) { return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right); }
function identity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode }; }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode; }

export function isActiveCandidateSourceSequence(sourceIds) {
  return Array.isArray(sourceIds)
    && [ACTIVE_SOURCE_IDS, ACTIVE_SOURCE_IDS_WITH_TRANSFER]
      .some((expected) => JSON.stringify(sourceIds) === JSON.stringify(expected));
}

export function rebindCandidateSourceSnapshots({
  candidateBuildSpec, candidateBuildSpecBytes, releaseRequest, sourceInventory, sourceInventoryBytes, sourceSnapshots, canonicalPack, governancePolicy, governancePolicyBytes,
  freshnessPolicy, kricSnapshotBytes,
  now = new Date(),
}) {
  const nowMillis = requiredUtcInstant(now.toISOString(), "now");
  const authenticatedCandidate = parse(candidateBuildSpecBytes, "candidate");
  const authenticatedInventory = parse(sourceInventoryBytes, "source inventory");
  const authenticatedGovernance = parse(governancePolicyBytes, "source governance policy");
  if (!isDeepStrictEqual(candidateBuildSpec, authenticatedCandidate)
    || !isDeepStrictEqual(sourceInventory, authenticatedInventory)
    || !isDeepStrictEqual(governancePolicy, authenticatedGovernance)) {
    throw new Error("parsed source objects are not bound to their authenticated bytes");
  }
  candidateBuildSpec = authenticatedCandidate;
  sourceInventory = authenticatedInventory;
  governancePolicy = authenticatedGovernance;
  validateCandidate(candidateBuildSpec);
  if (!Buffer.isBuffer(candidateBuildSpecBytes) || releaseRequest?.buildSpecSha256 !== sha256(candidateBuildSpecBytes)) {
    throw new Error("release request is not bound to original candidate bytes");
  }
  if (!Buffer.isBuffer(sourceInventoryBytes)
    || candidateBuildSpec.networkEdgeEvidence?.sourceInventory?.path !== PATHS.inventory
    || !SHA256.test(candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 ?? "")) {
    throw new Error("candidate source inventory binding mismatch");
  }
  validateCapitalPack(canonicalPack, sourceInventory);
  validateSourceGovernancePolicy({ policy: governancePolicy, inventory: sourceInventory, freshnessPolicy });
  const candidate = structuredClone(candidateBuildSpec);
  const projections = candidate.sourceSnapshots;
  const ids = candidate.sourceSnapshotIds;
  const sourceIds = projections.map(({ sourceId }) => sourceId);
  if (new Set(ids).size !== ids.length || new Set(sourceIds).size !== sourceIds.length
    || projections.some((projection, index) => projection?.snapshotId !== ids[index])
    || !isActiveCandidateSourceSequence(sourceIds)) {
    throw new Error("candidate source identity is not one-to-one");
  }
  const bySnapshotId = new Map();
  for (const snapshot of sourceSnapshots ?? []) {
    if (bySnapshotId.has(snapshot?.snapshotId)) throw new Error("source snapshot ledger has duplicate snapshot ID");
    bySnapshotId.set(snapshot?.snapshotId, snapshot);
  }
  const selected = ids.map((snapshotId) => {
    const snapshot = bySnapshotId.get(snapshotId);
    if (!snapshot) throw new Error("candidate snapshot is absent from source ledger");
    return snapshot;
  });
  if (sha256(JSON.stringify(selectLedgerOrderedSnapshots(sourceSnapshots, ids))) !== candidate.sourceSnapshotSetHash) {
    throw new Error("candidate source snapshot set hash mismatch");
  }
  const lineage = validateLineage(sourceSnapshots);
  validateCapitalReleaseHeads(canonicalPack, lineage, sourceSnapshots, selected);
  const oldIndex = sourceIds.indexOf(SOURCE_ID);
  if (oldIndex < 0) throw new Error("candidate KRIC source is missing");
  const oldSnapshot = selected[oldIndex];
  const nextSnapshotId = lineage.headsBySource[SOURCE_ID];
  const next = bySnapshotId.get(nextSnapshotId);
  if (!next || next.snapshotId === oldSnapshot.snapshotId || next.previousSnapshotId !== oldSnapshot.snapshotId) {
    throw new Error("KRIC standard accessibility head must advance exactly once");
  }
  for (const [index, sourceId] of sourceIds.entries()) {
    if (sourceId === SOURCE_ID) continue;
    if (lineage.headsBySource[sourceId] !== selected[index].snapshotId) {
      throw new Error("non-KRIC candidate source is not the active head");
    }
  }
  for (const [index, snapshot] of selected.entries()) {
    const expected = deriveReleaseProjection({
      snapshot, sourceInventory, governancePolicy, governancePolicyBytes, freshnessPolicy, nowMillis,
    });
    assertProjectionEqual(projections[index], expected, "candidate projection");
  }
  validateNewKricHead({ next, sourceInventory, governancePolicy, governancePolicyBytes, freshnessPolicy, kricSnapshotBytes, nowMillis });
  const source = exactlyOne(sourceInventory.sources ?? [], ({ id }) => id === SOURCE_ID, "KRIC source inventory");
  const evidence = source.accessibilityAdmissionEvidence;
  if (source.requiredForProductionPack !== true || source.productionUseAllowed !== true
    || source.capabilities?.facility?.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true
    || evidence?.snapshotId !== next.snapshotId || evidence.rawSha256 !== next.rawReceipt.snapshotRawSha256
    || evidence.contentSha256 !== next.contentSha256 || evidence.schemaFingerprint !== next.schemaFingerprint
    || source.admissionEvidence?.adminReviewRecordHash !== next.adminReviewRecordHash) {
    throw new Error("KRIC inventory admission does not bind the new head");
  }
  const oldProjection = projections[oldIndex];
  const nextProjection = deriveReleaseProjection({
    snapshot: next, sourceInventory, governancePolicy, governancePolicyBytes, freshnessPolicy, nowMillis,
  });
  ids[oldIndex] = next.snapshotId;
  projections[oldIndex] = nextProjection;
  candidate.sourceSnapshotSetHash = sha256(JSON.stringify(selectLedgerOrderedSnapshots(sourceSnapshots, ids)));
  candidate.sourceInventorySha256 = sha256(JSON.stringify(sourceInventory));
  candidate.networkEdgeEvidence.sourceInventory.sha256 = sha256(sourceInventoryBytes);
  assertOnlyAllowedCandidateChanges(candidateBuildSpec, candidate, oldProjection, nextProjection);
  return candidate;
}

function selectLedgerOrderedSnapshots(sourceSnapshots, snapshotIds) {
  const selectedIds = new Set(snapshotIds);
  const selected = sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  if (selectedIds.size !== snapshotIds.length || selected.length !== snapshotIds.length) {
    throw new Error("candidate source snapshot set hash mismatch");
  }
  return selected;
}

function validateCandidate(candidate) {
  if (candidate?.schemaVersion !== 1 || candidate.artifactKind !== "datapack-candidate-build-spec"
    || !Array.isArray(candidate.sourceSnapshotIds) || !Array.isArray(candidate.sourceSnapshots)
    || candidate.sourceSnapshotIds.length === 0 || candidate.sourceSnapshotIds.length !== candidate.sourceSnapshots.length
    || typeof candidate.candidateId !== "string" || candidate.candidateId === ""
    || !requiredSha(candidate.sourceSnapshotSetHash, "candidate source snapshot set hash")
    || !requiredSha(candidate.sourceInventorySha256, "candidate source inventory hash")) {
    throw new Error("candidate build spec identity mismatch");
  }
}

function validateCapitalPack(pack, sourceInventory) {
  const capital = pack?.packs?.length === 1 ? pack.packs[0] : null;
  if (pack?.manifest?.channel !== "production" || pack.manifest?.activePack?.id !== "capital"
    || capital?.id !== "capital" || capital.version !== "1") {
    throw new Error("capital canonical pack identity mismatch");
  }
  const seoulMetroLines = new Set((capital.lines ?? [])
    .filter(({ operatorId }) => operatorId === "seoul-metro").map(({ id }) => id));
  const stationIds = new Set((capital.stations ?? []).map(({ id }) => id));
  const lineIds = new Set((capital.lines ?? []).map(({ id }) => id));
  const membership = (capital.stationLines ?? []).filter(({ lineId }) => seoulMetroLines.has(lineId));
  const keys = new Set(membership.map(({ stationId, lineId }) => `${stationId}\0${lineId}`));
  if (membership.length !== 213 || keys.size !== 213
    || membership.some(({ stationId, lineId }) => !stationIds.has(stationId) || !lineIds.has(lineId))
    || new Set(membership.map(({ stationId }) => stationId)).size !== 199) {
    throw new Error("capital canonical 213 station-line scope mismatch");
  }
  if (JSON.stringify((capital.sourceInventory ?? []).map(({ id }) => id)) !== JSON.stringify(CAPITAL_SOURCE_IDS)) {
    throw new Error("capital canonical source identity drift");
  }
  const inventoryIds = new Set((sourceInventory?.sources ?? []).map(({ id }) => id));
  if (ACTIVE_SOURCE_IDS.some((sourceId) => !inventoryIds.has(sourceId))) {
    throw new Error("current source inventory does not cover candidate sources");
  }
}

function validateCapitalReleaseHeads(pack, lineage, snapshots, selected) {
  const capital = pack.packs[0];
  const capitalIds = new Set(capital.sourceInventory.map(({ id }) => id));
  const byId = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  const releaseHeads = ACTIVE_SOURCE_IDS.map((sourceId) => byId.get(lineage.headsBySource[sourceId]));
  const actualCapitalHeadIds = capital.sourceInventory.map(({ id }) => id)
    .filter((sourceId) => lineage.headsBySource[sourceId] != null);
  if (JSON.stringify(actualCapitalHeadIds) !== JSON.stringify(CAPITAL_ACTIVE_SOURCE_IDS)
    || ACTIVE_SOURCE_IDS.some((sourceId) => !capitalIds.has(sourceId))
    || releaseHeads.some((snapshot, index) => snapshot?.sourceId !== ACTIVE_SOURCE_IDS[index])
    || selected.filter(({ sourceId }) => ACTIVE_SOURCE_IDS.includes(sourceId)).length !== releaseHeads.length) {
    throw new Error("capital active source head identity drift");
  }
}

function validateNewKricHead({ next, sourceInventory, governancePolicy, governancePolicyBytes, freshnessPolicy, kricSnapshotBytes, nowMillis }) {
  if (next?.sourceId !== SOURCE_ID || next.artifactKind !== "official-source-snapshot"
    || next.schemaVersion !== 1 || next.snapshotStatus !== "LOCKED" || next.fetchStatus !== "SUCCESS"
    || next.schemaStatus !== "PASS" || next.licenseStatus !== "PASS" || next.redistributionAllowed !== true
    || next.credentialRedacted !== true || next.coverageCount !== 213 || !Number.isSafeInteger(next.rowCount) || next.rowCount < 0
    || !requiredSha(next.rawSha256, "KRIC raw hash") || !requiredSha(next.schemaFingerprint, "KRIC schema fingerprint")
    || !requiredSha(next.redactedRequestFingerprint, "KRIC request fingerprint")
    || !requiredSha(next.governancePolicySha256, "KRIC governance hash")
    || next.governancePolicyVersion !== governancePolicy.policyVersion
    || next.governancePolicySha256 !== requiredSha(sha256(governancePolicyBytes), "governance policy bytes hash")) {
    throw new Error("KRIC new head identity or canonical 213 scope mismatch");
  }
  const receipt = next.rawReceipt;
  if (receipt?.sourceId !== SOURCE_ID || receipt.snapshotId !== next.snapshotId
    || !SHA256.test(receipt.snapshotRawSha256 ?? "") || receipt.rawObjectSha256 !== next.rawSha256
    || !SHA256.test(receipt.snapshotFileSha256 ?? "") || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize <= 0) {
    throw new Error("KRIC immutable receipt mismatch");
  }
  let snapshot;
  try { snapshot = validateKricAccessibilitySnapshotIdentity(JSON.parse(kricSnapshotBytes?.toString("utf8"))); }
  catch { throw new Error("KRIC snapshot evidence file is invalid"); }
  if (snapshot.sourceId !== SOURCE_ID || snapshot.snapshotId !== next.snapshotId || snapshot.queryCount !== 213
    || snapshot.rowCount !== next.rowCount || snapshot.rawSha256 !== receipt.snapshotRawSha256
    || snapshot.contentSha256 !== next.contentSha256 || snapshot.schemaFingerprint !== next.schemaFingerprint
    || snapshot.redactedRequestFingerprint !== next.redactedRequestFingerprint
    || snapshot.capturedAt !== next.retrievedAt || snapshot.observedAt !== next.sourceUpdatedAt
    || requiredUtcInstant(snapshot.freshUntil, "KRIC snapshot freshness") !== requiredUtcInstant(snapshot.capturedAt, "KRIC snapshot capture") + 86_400_000) {
    throw new Error("KRIC snapshot evidence/ledger binding mismatch");
  }
  if (!Buffer.isBuffer(kricSnapshotBytes) || typeof next.rawObjectUri !== "string" || next.rawObjectUri === "" || typeof next.adminReviewRecordHash !== "string"
    || !SHA256.test(next.adminReviewRecordHash)) {
    throw new Error("KRIC receipt or policy binding mismatch");
  }
  const policySource = governancePolicy.sources?.find(({ sourceId }) => sourceId === SOURCE_ID);
  if (!policySource || policySource.sourceClassId == null) throw new Error("KRIC governance source is missing");
  const freshness = deriveFreshness({
    policy: freshnessPolicy,
    sourceClassId: policySource.sourceClassId,
    basisAt: next.retrievedAt,
    storedExpiresAt: next.freshnessExpiresAt,
    evaluationAt: new Date(nowMillis).toISOString(),
  });
  if (freshness.status !== "FRESH" || requiredUtcInstant(next.rawRetentionExpiresAt, "KRIC retention") <= nowMillis) {
    throw new Error("KRIC new head is stale or retention-expired");
  }
  if (next.diffSummary == null || next.previousSnapshotId == null) {
    throw new Error("KRIC head lineage is missing");
  }
  const inventory = exactlyOne(sourceInventory.sources ?? [], ({ id }) => id === SOURCE_ID, "KRIC source inventory");
  const evidence = inventory.accessibilityAdmissionEvidence;
  const review = policySource.licenseReview;
  const reviewedAt = Date.parse(review?.reviewedAt);
  const nextReviewAt = Date.parse(review?.nextReviewAt);
  if (inventory.provider !== next.provider || inventory.admissionEvidence?.decision !== "APPROVED"
    || inventory.admissionEvidence?.adminReviewRecordHash !== next.adminReviewRecordHash
    || inventory.capabilities?.facility?.status !== "SUPPORTED" || inventory.capabilities.facility.productionUseAllowed !== true
    || inventory.license?.commercialUseAllowed !== true || inventory.license?.derivativeWorkAllowed !== true
    || inventory.license?.redistributionAllowed !== true
    || review?.status !== "APPROVED" || review.termsHash !== inventory.admissionEvidence?.licenseEvidenceHash
    || review.reviewedProvider !== inventory.provider || review.reviewedDatasetUrl !== inventory.datasetUrl
    || review.approvedByRole !== policySource.approvalRole || !review.redistributionScopes?.includes("DERIVED_DATAPACK")
    || !Number.isFinite(reviewedAt) || !Number.isFinite(nextReviewAt) || reviewedAt > nowMillis || nextReviewAt <= nowMillis
    || evidence?.decision !== "APPROVED" || evidence.productionUseAllowed !== true || evidence.absenceEvidenceMode !== snapshot.absenceEvidenceMode
    || evidence.snapshotId !== next.snapshotId || evidence.snapshotPath !== `tools/datapack/sources/${next.snapshotId}.json`
    || evidence.rawSha256 !== receipt.snapshotRawSha256 || evidence.contentSha256 !== next.contentSha256
    || evidence.schemaFingerprint !== next.schemaFingerprint || evidence.snapshotFileSha256 !== sha256(kricSnapshotBytes)
    || receipt.snapshotFileSha256 !== sha256(kricSnapshotBytes)
    || evidence.capturedAt !== snapshot.capturedAt || evidence.observedAt !== snapshot.observedAt || evidence.freshUntil !== snapshot.freshUntil
    || requiredUtcInstant(evidence.freshUntil, "KRIC evidence freshness") <= nowMillis
    || requiredUtcInstant(receipt.storedAt, "KRIC receipt storedAt") < requiredUtcInstant(evidence.capturedAt, "KRIC evidence capture")
    || requiredUtcInstant(receipt.storedAt, "KRIC receipt storedAt") > nowMillis
    || evidence.licenseEvidenceHash !== inventory.admissionEvidence?.licenseEvidenceHash || evidence.licenseEvidenceHash == null
    || typeof inventory.license?.attribution !== "string" || inventory.license.attribution.trim() === ""
    || receipt.capturedAt !== snapshot.capturedAt || receipt.capturedAt !== next.retrievedAt
    || next.rawRetentionExpiresAt !== deriveRawRetentionExpiresAt({ policy: governancePolicy, sourceId: SOURCE_ID, retrievedAt: next.retrievedAt })
    || requiredUtcInstant(next.rawRetentionExpiresAt, "KRIC retention") <= requiredUtcInstant(receipt.storedAt, "KRIC receipt storedAt")) {
    throw new Error("KRIC inventory provenance mismatch");
  }
  requiredCredentialFreeObjectUri(next.rawObjectUri, "KRIC raw object URI");
}

export function deriveReleaseProjection({ snapshot, sourceInventory, governancePolicy, governancePolicyBytes, freshnessPolicy, nowMillis }) {
  const source = exactlyOne(sourceInventory?.sources ?? [], ({ id }) => id === snapshot.sourceId, `source inventory ${snapshot.sourceId}`);
  const adminReviewRecordHash = requiredSha(source.admissionEvidence?.adminReviewRecordHash, `${snapshot.sourceId} admin review hash`);
  const sourceClass = freshnessPolicy?.sourceClasses?.find(({ sourceIds }) => sourceIds?.includes(snapshot.sourceId));
  if (!sourceClass) throw new Error(`freshness class missing: ${snapshot.sourceId}`);
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: freshnessPolicy, sourceClassId: sourceClass.id, basisAt: snapshot[sourceClass.basisField],
    providerValidUntil: sourceClass.providerValidityEndField ? snapshot[sourceClass.providerValidityEndField] : undefined,
    evaluationAt: new Date(nowMillis).toISOString(),
  });
  const governanceSnapshot = snapshot.governancePolicyVersion == null && snapshot.governancePolicySha256 == null
    ? { ...snapshot, ...approvedLegacyGovernanceBinding(snapshot) }
    : snapshot;
  const governanceBinding = approvedGovernanceBindingTransition({
    snapshot: governanceSnapshot,
    currentPolicyVersion: governancePolicy.policyVersion,
    currentPolicySha256: sha256(governancePolicyBytes),
  });
  return {
    snapshotId: snapshot.snapshotId, sourceId: snapshot.sourceId, rawObjectUri: snapshot.rawObjectUri,
    rawSha256: snapshot.rawSha256, redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
    schemaFingerprint: snapshot.schemaFingerprint, licenseStatus: snapshot.licenseStatus,
    redistributionAllowed: snapshot.redistributionAllowed, adminReviewRecordHash, snapshotStatus: snapshot.snapshotStatus,
    credentialRedacted: snapshot.credentialRedacted, freshnessExpiresAt,
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governancePolicy, sourceId: snapshot.sourceId, retrievedAt: snapshot.retrievedAt }),
    ...governanceBinding,
  };
}

export function assertProjectionEqual(projection, expected, label) {
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) throw new Error(`${label} is invalid`);
  const keys = Object.keys(projection).sort((left, right) => left.localeCompare(right, "en"));
  if (keys.length !== PROJECTION_KEYS.length || keys.some((key, index) => key !== [...PROJECTION_KEYS].sort((left, right) => left.localeCompare(right, "en"))[index])
    || PROJECTION_KEYS.some((key) => projection[key] !== expected[key])) {
    throw new Error(`${label} fields are not closed`);
  }
}

// #350 registration is the only operation allowed to grow the source set.  It
// leaves the six authenticated projections untouched and always appends TRANSFER.
export function appendTransferCandidateSourceSnapshot({ candidateBuildSpec, transferSnapshot, transferProjection }) {
  const ids = candidateBuildSpec?.sourceSnapshotIds;
  const projections = candidateBuildSpec?.sourceSnapshots;
  if (!Array.isArray(ids) || !Array.isArray(projections)
    || JSON.stringify(projections.map(({ sourceId }) => sourceId)) !== JSON.stringify(ACTIVE_SOURCE_IDS)
    || ids.length !== ACTIVE_SOURCE_IDS.length || projections.some((row, index) => row.snapshotId !== ids[index])
    || transferSnapshot?.sourceId !== TRANSFER_SOURCE_ID || typeof transferSnapshot.snapshotId !== "string"
    || transferProjection?.sourceId !== TRANSFER_SOURCE_ID || transferProjection.snapshotId !== transferSnapshot.snapshotId) {
    throw new Error("candidate transfer append identity mismatch");
  }
  const candidate = structuredClone(candidateBuildSpec);
  candidate.sourceSnapshotIds.push(transferSnapshot.snapshotId);
  candidate.sourceSnapshots.push(structuredClone(transferProjection));
  if (JSON.stringify(candidate.sourceSnapshots.slice(0, ACTIVE_SOURCE_IDS.length)) !== JSON.stringify(projections)
    || JSON.stringify(candidate.sourceSnapshots.map(({ sourceId }) => sourceId)) !== JSON.stringify(ACTIVE_SOURCE_IDS_WITH_TRANSFER)) {
    throw new Error("candidate transfer append projection drift");
  }
  return candidate;
}

function assertOnlyAllowedCandidateChanges(before, after, oldProjection, nextProjection) {
  const allowed = new Set(["sourceSnapshotIds", "sourceSnapshots", "sourceSnapshotSetHash", "sourceInventorySha256", "networkEdgeEvidence"]);
  const beforeKeys = Object.keys(before);
  if (beforeKeys.length !== Object.keys(after).length || beforeKeys.some((key) => !(key in after))) {
    throw new Error("candidate top-level shape changed");
  }
  for (const key of beforeKeys) {
    if (!allowed.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`candidate field changed outside rebind allowlist: ${key}`);
    }
  }
  const edgeBefore = structuredClone(before.networkEdgeEvidence);
  const edgeAfter = structuredClone(after.networkEdgeEvidence);
  edgeBefore.sourceInventory = undefined;
  edgeAfter.sourceInventory = undefined;
  if (JSON.stringify(edgeBefore) !== JSON.stringify(edgeAfter)
    || JSON.stringify(before.networkEdgeEvidence?.sourceInventory?.path) !== JSON.stringify(after.networkEdgeEvidence?.sourceInventory?.path)) {
    throw new Error("candidate network edge evidence changed outside allowlist");
  }
  if (oldProjection.sourceId !== SOURCE_ID || nextProjection.sourceId !== SOURCE_ID) {
    throw new Error("candidate KRIC source projection mismatch");
  }
}

export async function readStableRegularFile(target, label, { openImpl = open } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(`${label} cannot enforce O_NOFOLLOW`);
  let handle;
  try { handle = await openImpl(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`${label} must be a regular non-symlink file`, { cause: error }); }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(identity(before), identity(after)) || bytes.length !== after.size) throw new Error(`${label} changed during read`);
    return { target, label, bytes, identity: identity(after) };
  } finally { await handle.close(); }
}

async function assertStable(snapshot) {
  const current = await lstat(snapshot.target);
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(snapshot.identity, identity(current))) {
    throw new Error(`${snapshot.label} changed during rebind`);
  }
  const reread = await readStableRegularFile(snapshot.target, snapshot.label);
  if (!sameBytes(snapshot.bytes, reread.bytes)) throw new Error(`${snapshot.label} bytes changed during rebind`);
}

export async function atomicReplace(target, bytes, { openImpl = open, original } = {}) {
  const parent = path.dirname(target);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("candidate target parent is unsafe");
  const authenticated = original ?? await readStableRegularFile(target, "candidate target");
  if (authenticated.target !== target) throw new Error("candidate target identity is invalid");
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let cleanupTemporary = false;
  try {
    const handle = await openImpl(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    cleanupTemporary = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await assertStable(authenticated);
    await rename(temporary, target);
    cleanupTemporary = false;
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (cleanupTemporary) await unlink(temporary).catch(() => {});
  }
}

async function acquireLock(root) {
  const lock = path.join(root, PATHS.lock);
  try { await mkdir(lock); } catch (error) {
    if (error?.code === "EEXIST") throw new Error("candidate source rebind lock residue exists");
    throw error;
  }
  return async () => { await rmdir(lock); };
}

export async function rebindCurrentCandidateSourceSnapshots({
  repositoryRoot = ROOT, now = new Date(), atomicReplaceImpl = atomicReplace, beforeReplace = async () => {},
} = {}) {
  const root = path.resolve(repositoryRoot);
  const release = await acquireLock(root);
  try {
    const entries = await Promise.all(Object.entries(PATHS).filter(([key]) => key !== "lock").map(async ([key, relative]) => {
      const target = path.join(root, relative);
      return [key, await readStableRegularFile(target, key)];
    }));
    const input = Object.fromEntries(entries);
    const sourceInventory = parse(input.inventory.bytes, "source inventory");
    const kricEvidence = exactlyOne(sourceInventory.sources ?? [], ({ id }) => id === SOURCE_ID, "KRIC source inventory")
      .accessibilityAdmissionEvidence;
    const relativeSnapshotPath = kricEvidence?.snapshotPath;
    if (typeof relativeSnapshotPath !== "string" || path.isAbsolute(relativeSnapshotPath)
      || path.resolve(root, relativeSnapshotPath) !== path.join(root, "tools/datapack/sources", `${kricEvidence?.snapshotId}.json`)) {
      throw new Error("KRIC snapshot evidence path is invalid");
    }
    input.kricSnapshot = await readStableRegularFile(path.resolve(root, relativeSnapshotPath), "KRIC snapshot evidence file");
    const result = rebindCandidateSourceSnapshots({
      candidateBuildSpec: parse(input.candidate.bytes, "candidate"),
      candidateBuildSpecBytes: input.candidate.bytes,
      releaseRequest: parse(input.releaseRequest.bytes, "release request"),
      sourceInventory,
      sourceInventoryBytes: input.inventory.bytes,
      sourceSnapshots: parse(input.snapshots.bytes, "source snapshot ledger"),
      canonicalPack: parse(input.pack.bytes, "capital canonical pack"),
      governancePolicy: parse(input.governance.bytes, "source governance policy"),
      governancePolicyBytes: input.governance.bytes,
      freshnessPolicy: parse(input.freshness.bytes, "freshness SLA"), now,
      kricSnapshotBytes: input.kricSnapshot.bytes,
    });
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    await beforeReplace({ root, input, bytes });
    for (const snapshot of Object.values(input)) await assertStable(snapshot);
    await atomicReplaceImpl(input.candidate.target, bytes, { original: input.candidate });
    const final = await readStableRegularFile(input.candidate.target, "candidate target");
    if (!sameBytes(final.bytes, bytes)) throw new Error("candidate target replacement verification failed");
    return { target: input.candidate.target, bytes, candidate: result };
  } finally { await release(); }
}

function parseArgs(argv) {
  if (argv.length !== 0) throw new Error("candidate source rebind takes no arguments");
}

async function main(argv) {
  parseArgs(argv);
  const result = await rebindCurrentCandidateSourceSnapshots();
  process.stdout.write(`${JSON.stringify({ status: "PASS", candidateId: result.candidate.candidateId, sourceSnapshotSetHash: result.candidate.sourceSnapshotSetHash })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
