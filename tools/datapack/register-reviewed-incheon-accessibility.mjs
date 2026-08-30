#!/usr/bin/env node
// Registers one reviewed Incheon facility snapshot.  This is deliberately a
// registry transaction: it neither collects data nor talks to OCI.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, open, readdir, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateIncheonAccessibilityRawCollection, validateIncheonAccessibilitySnapshotIdentity } from "./collect-incheon-accessibility.mjs";
import { validateIncheonStationInfoSnapshot } from "./collect-incheon-station-info.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { sortJson } from "./lib/ledger-admission-cli.mjs";
import { deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import {
  assertProjectionEqual,
  CURRENT_FULL_CANDIDATE_SOURCE_IDS,
  CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS,
  deriveReleaseProjection,
  isActiveCandidateSourceSequence,
} from "./rebind-current-candidate-source-snapshots.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE = "incheon-transit-accessibility";
const SHA = /^[a-f0-9]{64}$/u;
const textCompare = (left, right) => String(left).localeCompare(String(right));
const JOURNAL = "tools/datapack/.incheon-accessibility-registration-transaction.json";
const LOCK = "tools/datapack/.incheon-accessibility-registration.lock";
const FIXED = ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json"];
const REBIND_FIXED = [FIXED[0], FIXED[2], FIXED[3], FIXED[4]];
const PRE_REGISTRATION_SOURCE_SEQUENCES = Object.freeze([
  CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS.filter((sourceId) => sourceId !== SOURCE),
  CURRENT_FULL_CANDIDATE_SOURCE_IDS.filter((sourceId) => sourceId !== SOURCE),
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function parse(value, label) { try { return JSON.parse(value.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
function target(root, relative) { if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("registration path is invalid"); const value = path.resolve(root, relative); if (!value.startsWith(`${root}${path.sep}`)) throw new Error("registration path escapes repository"); return value; }
async function regularDirectory(directory, label) { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`); }
async function read(targetPath, label, absent = false) {
  try {
    await regularDirectory(path.dirname(targetPath), `${label} parent`);
    const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const before = await handle.stat(); if (!before.isFile()) throw new Error(`${label} must be a regular file`); const value = await handle.readFile(); const after = await handle.stat(); if (before.ino !== after.ino || before.size !== after.size || value.length !== after.size) throw new Error(`${label} changed during read`); return value; } finally { await handle.close(); }
  } catch (error) { if (absent && error?.code === "ENOENT") return null; throw error; }
}
function instant(value, label) { const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error(`${label} is invalid`); return time; }
function one(rows, predicate, label) { const found = rows.filter(predicate); if (found.length !== 1) throw new Error(`${label} must have exactly one match`); return found[0]; }
function outputAllowlist(outputs) {
  if (!Array.isArray(outputs)) throw new Error("Incheon registration output allowlist mismatch");
  const [snapshot, ...fixed] = outputs;
  if (outputs.length === 6 && /^tools\/datapack\/sources\/incheon-transit-accessibility-20\d{6}T\d{9}Z\.json$/u.test(snapshot?.relative ?? "") && snapshot.prestateBytes === null && JSON.stringify(fixed.map(({ relative }) => relative)) === JSON.stringify(FIXED) && fixed.every(({ prestateBytes }) => Buffer.isBuffer(prestateBytes))) return;
  if (outputs.length === 4 && JSON.stringify(outputs.map(({ relative }) => relative)) === JSON.stringify(REBIND_FIXED) && outputs.every(({ prestateBytes }) => Buffer.isBuffer(prestateBytes))) return;
  throw new Error("Incheon registration output allowlist mismatch");
}
function validateReceipt(receipt, snapshot, snapshotBytes, rawArtifactBytes, governance, now) {
  const keys = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "snapshotRawSha256", "capturedAt", "snapshotFileSha256", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt"];
  const objectKey = `source-raw/${SOURCE}/${snapshot.capturedAt.slice(0, 10).replaceAll("-", "")}/${hash(rawArtifactBytes)}.json`;
  if (!receipt || JSON.stringify(Object.keys(receipt)) !== JSON.stringify(keys) || receipt.schemaVersion !== 1 || receipt.artifactKind !== "incheon-accessibility-raw-object-receipt" || receipt.sourceId !== SOURCE || receipt.snapshotId !== snapshot.snapshotId || receipt.snapshotRawSha256 !== snapshot.rawSha256 || receipt.capturedAt !== snapshot.capturedAt || receipt.snapshotFileSha256 !== hash(snapshotBytes) || receipt.rawObjectSha256 !== hash(rawArtifactBytes) || receipt.byteSize !== rawArtifactBytes.length || receipt.rawObjectUri !== `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`) throw new Error("OCI receipt binding is invalid");
  const stored = instant(receipt.storedAt, "receipt storedAt"); if (stored < instant(snapshot.capturedAt, "snapshot capturedAt") || stored > now.getTime()) throw new Error("OCI receipt storage time is invalid");
  if (receipt.rawRetentionExpiresAt !== deriveRawRetentionExpiresAt({ policy: governance, sourceId: SOURCE, retrievedAt: snapshot.capturedAt })) throw new Error("OCI receipt retention is invalid");
}
async function readObservation(observationRoot, receiptPath, freshness, topology, topologySnapshotId) {
  if (!path.isAbsolute(observationRoot ?? "") || !path.isAbsolute(receiptPath ?? "")) throw new Error("absolute observation directory and receipt are required");
  const root = path.resolve(observationRoot); const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("observation directory is unsafe");
  const manifest = parse(await read(path.join(root, "observation.json"), "observation manifest"), "observation manifest");
  const names = await readdir(root); const expected = ["observation.json", manifest?.snapshotFile, manifest?.rawArtifactFile].sort(textCompare);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.artifactKind !== "incheon-accessibility-observation" || manifest.sourceId !== SOURCE || typeof manifest.snapshotId !== "string" || manifest.snapshotFile !== `${manifest.snapshotId}.json` || manifest.rawArtifactFile !== `${manifest.snapshotId}.raw.json` || JSON.stringify(names.sort(textCompare)) !== JSON.stringify(expected)) throw new Error("Incheon accessibility observation inventory is invalid");
  const snapshotBytes = await read(path.join(root, manifest.snapshotFile), "observation snapshot"); const rawArtifactBytes = await read(path.join(root, manifest.rawArtifactFile), "observation raw artifact");
  const snapshot = parse(snapshotBytes, "observation snapshot"); const rawArtifact = parse(rawArtifactBytes, "observation raw artifact");
  if (manifest.snapshotFileSha256 !== hash(snapshotBytes) || manifest.rawObjectSha256 !== hash(rawArtifactBytes) || manifest.rawObjectByteSize !== rawArtifactBytes.length || manifest.snapshotId !== snapshot.snapshotId || manifest.snapshotRawSha256 !== snapshot.rawSha256 || manifest.capturedAt !== snapshot.capturedAt) throw new Error("Incheon accessibility observation identity is invalid");
  if (rawArtifact.topologySnapshot?.sourceId !== topology.sourceId || rawArtifact.topologySnapshotId !== topologySnapshotId || rawArtifact.topologyContentSha256 !== topology.contentSha256) throw new Error("Incheon accessibility observation topology is not the admitted topology");
  validateIncheonAccessibilitySnapshotIdentity(snapshot, freshness, topology);
  validateIncheonAccessibilityRawCollection(rawArtifact, snapshot, freshness);
  return { snapshot, snapshotBytes, rawArtifact, rawArtifactBytes, receipt: parse(await read(receiptPath, "OCI receipt"), "OCI receipt") };
}
function ledgerReceipt(receipt) { return { schemaVersion: receipt.schemaVersion, artifactKind: receipt.artifactKind, sourceId: receipt.sourceId, snapshotId: receipt.snapshotId, snapshotRawSha256: receipt.snapshotRawSha256, capturedAt: receipt.capturedAt, snapshotFileSha256: receipt.snapshotFileSha256, rawObjectUri: receipt.rawObjectUri, rawObjectSha256: receipt.rawObjectSha256, byteSize: receipt.byteSize, storedAt: receipt.storedAt, rawRetentionExpiresAt: receipt.rawRetentionExpiresAt }; }
function ledgerOrderedSnapshots(ledger, ids) {
  const selectedIds = new Set(ids); const selected = ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  if (selectedIds.size !== ids.length || selected.length !== ids.length) throw new Error("candidate source snapshots are incomplete");
  return selected;
}
function operationFingerprint(rawArtifact) {
  return hash(JSON.stringify({ sourceId: rawArtifact.sourceId, datasetIds: rawArtifact.payloads.map(({ datasetId }) => datasetId), requests: rawArtifact.payloads.map(({ detailUrl, fileName }) => ({ detailUrl, fileName })), topologySnapshotId: rawArtifact.topologySnapshotId, topologyContentSha256: rawArtifact.topologyContentSha256, freshnessPolicy: rawArtifact.freshnessPolicy }));
}
function isIncheonRegistrationPrestateSourceSequence(sourceIds) {
  return Array.isArray(sourceIds) && PRE_REGISTRATION_SOURCE_SEQUENCES
    .some((expected) => JSON.stringify(sourceIds) === JSON.stringify(expected));
}
function validateCurrentRelease({ inventory, inventoryBytes, ledger, candidate, candidateBytes, request, evidence, governance, governanceBytes, freshness }) {
  const lineage = validateLineage(ledger); const ids = candidate?.sourceSnapshotIds; const projections = candidate?.sourceSnapshots;
  if (candidate?.schemaVersion !== 1 || candidate.artifactKind !== "datapack-candidate-build-spec" || !Array.isArray(ids) || !Array.isArray(projections) || ids.length === 0 || projections.length !== ids.length || !isIncheonRegistrationPrestateSourceSequence(projections.map(({ sourceId }) => sourceId)) || new Set(ids).size !== ids.length || new Set(projections.map(({ sourceId }) => sourceId)).size !== ids.length || ids.some((id, index) => projections[index]?.snapshotId !== id) || projections.some(({ sourceId }) => sourceId === SOURCE)) throw new Error("candidate prestate is invalid");
  const selected = ids.map((snapshotId) => { const snapshot = ledger.find((row) => row.snapshotId === snapshotId); if (!snapshot || lineage.headsBySource[snapshot.sourceId] !== snapshotId) throw new Error("candidate source is not the active ledger head"); return snapshot; });
  const expectedSet = ledgerOrderedSnapshots(ledger, ids);
  if (candidate.sourceSnapshotSetHash !== hash(JSON.stringify(expectedSet)) || candidate.sourceInventorySha256 !== hash(JSON.stringify(inventory)) || candidate.networkEdgeEvidence?.sourceInventory?.path !== FIXED[0] || candidate.networkEdgeEvidence.sourceInventory.sha256 !== hash(inventoryBytes)) throw new Error("candidate prestate binding is invalid");
  for (const [index, snapshot] of selected.entries()) {
    const projection = deriveReleaseProjection({ snapshot, sourceInventory: inventory, governancePolicy: governance, governancePolicyBytes: governanceBytes, freshnessPolicy: freshness, nowMillis: instant(candidate.publishedAt, "candidate publishedAt") });
    try { assertProjectionEqual(projections[index], projection, "candidate projection prestate"); } catch { throw new Error("candidate projection prestate is invalid"); }
  }
  if (request?.schemaVersion !== 1 || request.artifactKind !== "datapack-release-request" || request.candidateId !== candidate.candidateId || request.scopeId !== candidate.productionScopeId || request.targetChannel !== "production" || typeof request.requestedBy !== "string" || request.requestedBy === "" || typeof request.approvedBy !== "string" || request.approvedBy === "" || request.requestedBy === request.approvedBy || typeof request.approvalId !== "string" || request.approvalId === "" || request.approvedLedgerHash !== candidate.approvedAliasLedgerHash || request.sourceSnapshotSetHash !== candidate.sourceSnapshotSetHash || request.buildSpecSha256 !== hash(candidateBytes) || evidence?.schemaVersion !== 1 || evidence.artifactKind !== "datapack-build-spec-hash-evidence" || evidence.productionScopeId !== candidate.productionScopeId || evidence?.ledgerHashes?.approvedAliasLedgerHash?.value !== candidate.approvedAliasLedgerHash || evidence?.sourceSnapshotSetHash?.value !== candidate.sourceSnapshotSetHash || evidence?.sourceInventorySha256?.value !== candidate.sourceInventorySha256 || evidence?.identifiers?.candidateId?.value !== candidate.candidateId || evidence?.identifiers?.approvalId?.value !== request.approvalId || !Array.isArray(evidence?.perSourceEvidence) || evidence.perSourceEvidence.length !== selected.length) throw new Error("release prestate binding is invalid");
  for (const [index, snapshot] of expectedSet.entries()) { const row = evidence.perSourceEvidence[index]; const source = one(inventory.sources, ({ id }) => id === snapshot.sourceId, "release source"); if (row?.sourceId !== snapshot.sourceId || row.snapshotId !== snapshot.snapshotId || row.rawSha256 !== snapshot.rawSha256 || row.adminReviewRecordHash !== source.admissionEvidence?.adminReviewRecordHash || row.perSourceSnapshotSetHash !== hash(JSON.stringify([snapshot]))) throw new Error("hash evidence prestate is invalid"); }
  return { lineage, selected };
}
function build({ snapshot, snapshotBytes, rawArtifact, rawArtifactBytes, receipt, inventory, inventoryBytes, ledger, governance, governanceBytes, freshness, candidate, candidateBytes, request, evidence, now, topology, topologySnapshotId }) {
  validateIncheonAccessibilitySnapshotIdentity(snapshot, freshness, topology);
  validateSourceGovernancePolicy({ policy: governance, inventory, freshnessPolicy: freshness });
  const source = one(inventory.sources ?? [], ({ id }) => id === SOURCE, "Incheon source");
  const policy = one(governance.sources ?? [], ({ sourceId }) => sourceId === SOURCE, "Incheon governance source");
  if (source.requiredForProductionPack !== false || source.productionUseAllowed !== true || source.capabilities?.facility?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true || source.admissionEvidence?.decision !== "APPROVED" || source.admissionEvidence?.issue !== 622 || source.admissionEvidence?.snapshotId !== snapshot.snapshotId || !SHA.test(source.admissionEvidence?.adminReviewRecordHash ?? "") || source.admissionEvidence?.licenseEvidenceHash !== hash(JSON.stringify(sortJson(source.license)))) throw new Error("Incheon reviewed source is not receipt-pending production admission");
  validateReceipt(receipt, snapshot, snapshotBytes, rawArtifactBytes, governance, now);
  const fresh = deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: policy.sourceClassId, basisAt: snapshot.capturedAt, evaluationAt: now.toISOString() });
  if (instant(fresh, "freshness") <= now.getTime() || instant(snapshot.freshUntil, "snapshot freshness") <= now.getTime()) throw new Error("Incheon snapshot is stale");
  const { lineage, selected: currentSnapshots } = validateCurrentRelease({ inventory, inventoryBytes, ledger, candidate, candidateBytes, request, evidence, governance, governanceBytes, freshness });
  const nowMillis = now.getTime();
  if (nowMillis < instant(candidate.publishedAt, "candidate publishedAt")
    || currentSnapshots.some((current) => nowMillis < instant(current.retrievedAt, "current snapshot retrievedAt")
      || (current.rawReceipt?.storedAt != null && nowMillis < instant(current.rawReceipt.storedAt, "current snapshot receipt storedAt")))) {
    throw new Error("registration time precedes current release evidence");
  }
  if (lineage.headsBySource[SOURCE] != null || ledger.some(({ sourceId }) => sourceId === SOURCE)) throw new Error("Incheon ledger head already exists");
  const next = { schemaVersion: 1, artifactKind: "official-source-snapshot", snapshotId: snapshot.snapshotId, sourceId: SOURCE, provider: source.provider, retrievedAt: snapshot.capturedAt, sourceUpdatedAt: snapshot.observedAt, rowCount: snapshot.rowCount, coverageCount: snapshot.stationCount, rawSha256: receipt.rawObjectSha256, rawObjectUri: receipt.rawObjectUri, rawReceipt: ledgerReceipt(receipt), contentSha256: snapshot.contentSha256, redactedRequestFingerprint: operationFingerprint(rawArtifact), schemaFingerprint: snapshot.schemaFingerprint, snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS", redistributionAllowed: true, credentialRedacted: true, previousSnapshotId: null, freshnessExpiresAt: fresh, rawRetentionExpiresAt: receipt.rawRetentionExpiresAt, providerRecordHashes: snapshot.rows.map((row) => hash(JSON.stringify(row))), claimBindingsSha256: snapshot.claimBindingsSha256, adminReviewRecordHash: source.admissionEvidence.adminReviewRecordHash, governancePolicyVersion: governance.policyVersion, governancePolicySha256: hash(governanceBytes) };
  const nextLedger = [...ledger, next]; validateLineage(nextLedger);
  const nextInventory = structuredClone(inventory); const nextSource = one(nextInventory.sources, ({ id }) => id === SOURCE, "Incheon source");
  nextSource.requiredForProductionPack = true;
  nextSource.retrievedAt = snapshot.capturedAt.slice(0, 10); nextSource.observedDataUpdatedAt = snapshot.observedAt.slice(0, 10);
  const topologyLineages = snapshot.topologyLineages; const membershipLineages = snapshot.membershipLineages;
  const topologyLineage = topologyLineages?.[0];
  if (!topologyLineage || !topologyLineages.every((lineage) => lineage.sourceId === topologyLineage.sourceId && lineage.snapshotId === topologyLineage.snapshotId && lineage.contentSha256 === topologyLineage.contentSha256) || !membershipLineages?.every((lineage) => lineage.sourceId === topologyLineage.sourceId && lineage.snapshotId === topologyLineage.snapshotId && lineage.contentSha256 === topologyLineage.contentSha256) || topologyLineage.sourceId !== topology.sourceId || topologyLineage.snapshotId !== topologySnapshotId || topologyLineage.contentSha256 !== topology.contentSha256) throw new Error("Incheon snapshot topology evidence is invalid");
  const capturedTopology = capturedTopologyBinding(snapshot, topology, topologySnapshotId);
  delete nextSource.accessibilityAdmissionEvidence;
  nextSource.registrationEvidence = registrationEvidence({ snapshot, snapshotBytes, receipt, ledger: next, adminReviewRecordHash: next.adminReviewRecordHash, capturedTopology });
  const nextInventoryBytes = bytes(nextInventory); const nextCandidate = structuredClone(candidate);
  if (nextCandidate.sourceSnapshotIds.includes(snapshot.snapshotId)
    || nextCandidate.sourceSnapshots.some(({ sourceId }) => sourceId === SOURCE)
    || Object.hasOwn(nextCandidate.networkEdgeEvidence ?? {}, "incheonAccessibility")) {
    throw new Error("candidate has incompatible Incheon source state");
  }
  const projection = deriveReleaseProjection({ snapshot: next, sourceInventory: nextInventory, governancePolicy: governance, governancePolicyBytes: governanceBytes, freshnessPolicy: freshness, nowMillis: now.getTime() });
  const transferIndex = nextCandidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration");
  if (transferIndex !== -1 && transferIndex !== nextCandidate.sourceSnapshots.length - 1) throw new Error("candidate transfer ordering is invalid");
  const insertionIndex = transferIndex === -1 ? nextCandidate.sourceSnapshots.length : transferIndex;
  nextCandidate.sourceSnapshotIds.splice(insertionIndex, 0, next.snapshotId); nextCandidate.sourceSnapshots.splice(insertionIndex, 0, projection);
  if (!isActiveCandidateSourceSequence(nextCandidate.sourceSnapshots.map(({ sourceId }) => sourceId))) throw new Error("candidate Incheon sequence is invalid");
  const selected = ledgerOrderedSnapshots(nextLedger, nextCandidate.sourceSnapshotIds);
  nextCandidate.sourceSnapshotSetHash = hash(JSON.stringify(selected)); nextCandidate.sourceInventorySha256 = hash(JSON.stringify(nextInventory)); nextCandidate.publishedAt = now.toISOString();
  if (nextCandidate.networkEdgeEvidence?.sourceInventory) nextCandidate.networkEdgeEvidence.sourceInventory.sha256 = hash(nextInventoryBytes);
  const nextCandidateBytes = bytes(nextCandidate); const nextRequest = { ...request, buildSpecSha256: hash(nextCandidateBytes), sourceSnapshotSetHash: nextCandidate.sourceSnapshotSetHash };
  const nextEvidence = structuredClone(evidence); if (!nextEvidence.sourceSnapshotSetHash || !nextEvidence.sourceInventorySha256) throw new Error("hash evidence is incompatible"); nextEvidence.sourceSnapshotSetHash.value = nextCandidate.sourceSnapshotSetHash; nextEvidence.sourceInventorySha256.value = nextCandidate.sourceInventorySha256; nextEvidence.perSourceEvidence = selected.map((item) => ({ sourceId: item.sourceId, snapshotId: item.snapshotId, rawSha256: item.rawSha256, adminReviewRecordHash: one(nextInventory.sources, ({ id }) => id === item.sourceId, "release source").admissionEvidence.adminReviewRecordHash, perSourceSnapshotSetHash: hash(JSON.stringify([item])) }));
  nextEvidence.sourceSnapshotSetHash.contract = `source별 head ${selected.length}종의 byte-ordered JSON hash와 build spec·release request가 일치해야 한다.`;
  nextEvidence.sourceSnapshots.order = `release snapshot ledger 순서: ${selected.map(({ sourceId }) => sourceId).join(" → ")}`;
  nextEvidence.sourceSnapshots.note = "historical source snapshot lineage는 유지하고 canonical capital sourceInventory의 active source만 release snapshot으로 소비한다.";
  nextEvidence.sourceSnapshots.specRowRawSha256Note = "build-spec projections use the selected official ledger rawSha256 (the OCI object hash); observation snapshot internal composite/canonical hashes remain separately bound in the tracked snapshot and admission evidence.";
  return [
    { relative: `tools/datapack/sources/${snapshot.snapshotId}.json`, bytes: snapshotBytes, prestateBytes: null },
    { relative: FIXED[0], bytes: nextInventoryBytes, prestateBytes: null }, { relative: FIXED[1], bytes: bytes(nextLedger), prestateBytes: null }, { relative: FIXED[2], bytes: nextCandidateBytes, prestateBytes: null }, { relative: FIXED[3], bytes: bytes(nextRequest), prestateBytes: null }, { relative: FIXED[4], bytes: bytes(nextEvidence), prestateBytes: null },
  ];
}
function claimTopologyHash(rows) {
  return hash(JSON.stringify([...rows]
    .map(({ stationId, lineId, stationCode }) => ({ stationId, lineId, stationCode }))
    .sort((left, right) => `${left.lineId}:${left.stationCode}:${left.stationId}`
      .localeCompare(`${right.lineId}:${right.stationCode}:${right.stationId}`))));
}

function capturedTopologyBinding(snapshot, topology, topologySnapshotId) {
  validateIncheonStationInfoSnapshot(topology);
  const lineages = [...(snapshot.topologyLineages ?? []), ...(snapshot.membershipLineages ?? [])];
  const lineage = lineages[0];
  const claimTopology = snapshot.claimTopology;
  const activeMembership = topology.scope.map(({ stationId, lineId, stationCode }) => ({
    stationId, lineId, stationCode,
  }));
  if (!lineage || !lineages.every(({ sourceId, snapshotId, contentSha256 }) =>
    sourceId === lineage.sourceId && snapshotId === lineage.snapshotId
      && contentSha256 === lineage.contentSha256)
    || lineage.sourceId !== topology.sourceId
    || lineage.snapshotId !== topologySnapshotId
    || lineage.contentSha256 !== topology.contentSha256
    || !Array.isArray(claimTopology)
    || claimTopology.length !== 71
    || claimTopologyHash(claimTopology) !== claimTopologyHash(activeMembership)) {
    throw new Error("Incheon snapshot topology evidence is invalid");
  }
  return {
    sourceId: lineage.sourceId,
    snapshotId: lineage.snapshotId,
    contentSha256: lineage.contentSha256,
    claimTopologySha256: claimTopologyHash(claimTopology),
  };
}

function registrationEvidence({ snapshot, snapshotBytes, receipt, ledger, adminReviewRecordHash,
  capturedTopology }) {
  if (ledger.sourceId !== SOURCE || ledger.snapshotId !== snapshot.snapshotId || ledger.schemaFingerprint !== snapshot.schemaFingerprint || ledger.claimBindingsSha256 !== snapshot.claimBindingsSha256 || ledger.rawObjectUri !== receipt.rawObjectUri || ledger.rawSha256 !== receipt.rawObjectSha256 || ledger.adminReviewRecordHash !== adminReviewRecordHash) throw new Error("Incheon registration evidence cannot bind the official ledger");
  if (!capturedTopology || capturedTopology.sourceId !== "incheon-transit-station-info"
    || !/^incheon-transit-station-info-\d{8}$/u.test(capturedTopology.snapshotId ?? "")
    || !SHA.test(capturedTopology.contentSha256 ?? "")
    || !SHA.test(capturedTopology.claimTopologySha256 ?? "")) {
    throw new Error("Incheon registration evidence topology binding is invalid");
  }
  return { artifactKind: "source-registration-evidence", sourceId: SOURCE, snapshotId: snapshot.snapshotId, capturedAt: receipt.capturedAt, snapshotFileSha256: hash(snapshotBytes), snapshotRawSha256: snapshot.rawSha256, rawObjectUri: receipt.rawObjectUri, rawObjectSha256: receipt.rawObjectSha256, contentSha256: snapshot.contentSha256, normalizedSchemaFingerprint: snapshot.schemaFingerprint, claimBindingsSha256: snapshot.claimBindingsSha256, capturedTopology, rowCount: snapshot.rowCount, coverageCount: snapshot.stationCount, claimBindingCount: snapshot.claimBindings.length, adminReviewRecordHash, registeredAt: receipt.storedAt };
}

function registrationEvidenceMatches({ evidence, snapshot, snapshotBytes, receipt, ledger, adminReviewRecordHash,
  capturedTopology }) {
  const expected = registrationEvidence({ snapshot, snapshotBytes, receipt, ledger, adminReviewRecordHash,
    capturedTopology });
  if (JSON.stringify(evidence) !== JSON.stringify(expected)) throw new Error("Incheon registration evidence binding is invalid");
}

export async function buildReceiptBoundRebindOutputs({ repositoryRoot = ROOT, receiptPath } = {}) {
  const root = path.resolve(repositoryRoot); await regularDirectory(root, "repository root");
  if (!path.isAbsolute(receiptPath ?? "")) throw new Error("absolute OCI receipt is required");
  const [inventoryBytes, ledgerBytes, candidateBytes, requestBytes, evidenceBytes] = await Promise.all(FIXED.map((relative) => read(target(root, relative), relative)));
  const [inventory, ledger, candidate, request, evidence] = [inventoryBytes, ledgerBytes, candidateBytes, requestBytes, evidenceBytes].map((value, index) => parse(value, FIXED[index]));
  const source = one(inventory.sources ?? [], ({ id }) => id === SOURCE, "registered Incheon source");
  if (source.requiredForProductionPack !== true || source.registrationEvidence != null || source.admissionEvidence?.decision !== "APPROVED" || !SHA.test(source.admissionEvidence?.adminReviewRecordHash ?? "")) throw new Error("Incheon receipt-bound rebind requires an unbound registered source");
  const official = one(ledger, ({ sourceId }) => sourceId === SOURCE, "registered Incheon ledger head");
  if (candidate?.sourceInventorySha256 !== hash(JSON.stringify(inventory)) || candidate?.networkEdgeEvidence?.sourceInventory?.path !== FIXED[0] || candidate.networkEdgeEvidence.sourceInventory.sha256 !== hash(inventoryBytes) || request?.buildSpecSha256 !== hash(candidateBytes) || request.sourceSnapshotSetHash !== candidate.sourceSnapshotSetHash || evidence?.sourceInventorySha256?.value !== candidate.sourceInventorySha256 || evidence?.sourceSnapshotSetHash?.value !== candidate.sourceSnapshotSetHash) throw new Error("Incheon receipt-bound rebind prestate is invalid");
  const selected = ledgerOrderedSnapshots(ledger, candidate.sourceSnapshotIds ?? []);
  if (!candidate.sourceSnapshotIds.includes(official.snapshotId) || candidate.sourceSnapshotSetHash !== hash(JSON.stringify(selected)) || !candidate.sourceSnapshots?.some(({ sourceId, snapshotId }) => sourceId === SOURCE && snapshotId === official.snapshotId)) throw new Error("Incheon receipt-bound candidate is invalid");
  const snapshotPath = target(root, `tools/datapack/sources/${official.snapshotId}.json`); const snapshotBytes = await read(snapshotPath, "registered Incheon snapshot"); const snapshot = parse(snapshotBytes, "registered Incheon snapshot");
  const topologySource = one(inventory.sources, ({ id }) => id === "incheon-transit-station-info", "registered Incheon topology source");
  const topologySnapshotId = topologySource.topologyAdmissionEvidence?.snapshotId;
  const topologyPath = topologySource.topologyAdmissionEvidence?.snapshotPath;
  if (typeof topologySnapshotId !== "string" || topologyPath !== `tools/datapack/sources/${topologySnapshotId}.json`) {
    throw new Error("registered Incheon topology binding is invalid");
  }
  const topology = parse(await read(target(root, topologyPath), "registered Incheon topology snapshot"),
    "registered Incheon topology snapshot");
  const capturedTopology = capturedTopologyBinding(snapshot, topology, topologySnapshotId);
  const receipt = parse(await read(receiptPath, "OCI receipt"), "OCI receipt");
  if (snapshot.sourceId !== SOURCE || snapshot.snapshotId !== official.snapshotId || snapshot.schemaFingerprint !== official.schemaFingerprint || snapshot.contentSha256 !== official.contentSha256 || snapshot.claimBindingsSha256 !== official.claimBindingsSha256 || snapshot.rowCount !== official.rowCount || snapshot.stationCount !== official.coverageCount || !Array.isArray(snapshot.claimBindings) || snapshot.claimBindings.length !== 426 || snapshot.rowCount !== 71 || receipt.snapshotFileSha256 !== hash(snapshotBytes) || receipt.snapshotRawSha256 !== snapshot.rawSha256 || receipt.rawObjectUri !== official.rawObjectUri || receipt.rawObjectSha256 !== official.rawSha256 || JSON.stringify(receipt) !== JSON.stringify(official.rawReceipt)) throw new Error("Incheon receipt-bound snapshot is invalid");
  const nextInventory = structuredClone(inventory); const nextSource = one(nextInventory.sources, ({ id }) => id === SOURCE, "registered Incheon source"); nextSource.registrationEvidence = registrationEvidence({ snapshot, snapshotBytes, receipt, ledger: official, adminReviewRecordHash: source.admissionEvidence.adminReviewRecordHash, capturedTopology });
  registrationEvidenceMatches({ evidence: nextSource.registrationEvidence, snapshot, snapshotBytes, receipt, ledger: official, adminReviewRecordHash: source.admissionEvidence.adminReviewRecordHash, capturedTopology });
  const nextInventoryBytes = bytes(nextInventory); const nextCandidate = structuredClone(candidate); nextCandidate.sourceInventorySha256 = hash(JSON.stringify(nextInventory)); nextCandidate.networkEdgeEvidence.sourceInventory.sha256 = hash(nextInventoryBytes);
  const nextCandidateBytes = bytes(nextCandidate); const nextRequest = { ...request, buildSpecSha256: hash(nextCandidateBytes) }; const nextEvidence = structuredClone(evidence); nextEvidence.sourceInventorySha256.value = nextCandidate.sourceInventorySha256;
  if (nextRequest.sourceSnapshotSetHash !== candidate.sourceSnapshotSetHash || nextEvidence.sourceSnapshotSetHash.value !== candidate.sourceSnapshotSetHash || JSON.stringify(nextEvidence.perSourceEvidence) !== JSON.stringify(evidence.perSourceEvidence)) throw new Error("Incheon receipt-bound rebind changed release snapshot evidence");
  return REBIND_FIXED.map((relative, index) => ({ relative, bytes: [nextInventoryBytes, nextCandidateBytes, bytes(nextRequest), bytes(nextEvidence)][index], prestateBytes: [inventoryBytes, candidateBytes, requestBytes, evidenceBytes][index] }));
}
export async function rebindReceiptBoundIncheonAccessibilityCandidate(options = {}) { const outputs = await buildReceiptBoundRebindOutputs(options); await commitReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: options.repositoryRoot, outputs }); return { outputs: outputs.map(({ relative }) => relative) }; }
export async function buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot = ROOT, observationRoot, receiptPath, now = new Date() } = {}) {
  const root = path.resolve(repositoryRoot); await regularDirectory(root, "repository root");
  const [inventoryBytes, governanceBytes, ledgerBytes, candidateBytes, requestBytes, evidenceBytes, freshnessBytes] = await Promise.all([FIXED[0], "tools/datapack/source-governance-policy.json", FIXED[1], FIXED[2], FIXED[3], FIXED[4], "release/product-gates/datapack-freshness-sla.json"].map((relative) => read(target(root, relative), relative)));
  const inventory = parse(inventoryBytes, "source inventory"); const admitted = one(inventory.sources ?? [], ({ id }) => id === SOURCE, "Incheon source");
  const topologySource = one(inventory.sources ?? [], ({ id }) => id === "incheon-transit-station-info", "Incheon topology source");
  const topologyAdmission = topologySource.topologyAdmissionEvidence;
  if (admitted.requiredForProductionPack !== false || admitted.productionUseAllowed !== true
    || admitted.admissionEvidence?.issue !== 622 || admitted.admissionEvidence?.decision !== "APPROVED"
    || typeof topologyAdmission?.snapshotId !== "string"
    || topologyAdmission.snapshotPath !== `tools/datapack/sources/${topologyAdmission.snapshotId}.json`
    || !SHA.test(topologyAdmission.contentSha256 ?? "")) throw new Error("Incheon admitted topology is invalid");
  const topologyRelative = topologyAdmission.snapshotPath;
  const topologyBytes = await read(target(root, topologyRelative), "current Incheon topology"); const topology = parse(topologyBytes, "current Incheon topology");
  if (topology.sourceId !== topologySource.id || topology.contentSha256 !== topologyAdmission.contentSha256) throw new Error("Incheon admitted topology content is invalid");
  const freshness = parse(freshnessBytes, "freshness"); const observation = await readObservation(observationRoot, receiptPath, freshness, topology, topologyAdmission.snapshotId);
  validateIncheonAccessibilitySnapshotIdentity(observation.snapshot, freshness, topology);
  const inputs = [[FIXED[0], inventoryBytes], ["tools/datapack/source-governance-policy.json", governanceBytes], [FIXED[1], ledgerBytes], [FIXED[2], candidateBytes], [FIXED[3], requestBytes], [FIXED[4], evidenceBytes], ["release/product-gates/datapack-freshness-sla.json", freshnessBytes], [topologyRelative, topologyBytes]].map(([relative, value]) => ({ relative, bytes: value }));
  const outputs = build({ snapshot: observation.snapshot, snapshotBytes: observation.snapshotBytes, rawArtifact: observation.rawArtifact, rawArtifactBytes: observation.rawArtifactBytes, receipt: observation.receipt, inventory, inventoryBytes, ledger: parse(ledgerBytes, "ledger"), governance: parse(governanceBytes, "source governance policy"), governanceBytes, freshness, candidate: parse(candidateBytes, "candidate"), candidateBytes, request: parse(requestBytes, "release request"), evidence: parse(evidenceBytes, "hash evidence"), now, topology, topologySnapshotId: topologyAdmission.snapshotId }).map((output) => ({ ...output, inputs }));
  outputs[1].prestateBytes = await read(target(root, FIXED[0]), FIXED[0]); for (let i = 2; i < outputs.length; i += 1) outputs[i].prestateBytes = await read(target(root, outputs[i].relative), outputs[i].relative); outputAllowlist(outputs); return outputs;
}
async function safeParent(file) { await regularDirectory(path.dirname(file), "Incheon registration target parent"); }
async function syncParent(file) { const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); } }
async function currentBytes(file) { return read(file, "Incheon registration target", true); }
async function expected(file, value) { const current = await currentBytes(file); if ((current == null) !== (value == null) || current != null && !current.equals(value)) throw new Error("Incheon registration preserves foreign replacement"); }
function displacedPath(file) { return path.join(path.dirname(file), `.${path.basename(file)}.incheon-accessibility.before`); }
function retiredPath(file) { return path.join(path.dirname(file), `.${path.basename(file)}.incheon-accessibility.retired`); }
function temporaryPath(file) { return path.join(path.dirname(file), `.${path.basename(file)}.incheon-accessibility.write.tmp`); }
async function restoreMovedFile(moved, file) { try { await link(moved, file); } catch (error) { if (error?.code === "EEXIST") return false; throw error; } await unlink(moved); await syncParent(file); return true; }
async function removeExpected(file, value) { await expected(file, value); const retired = retiredPath(file); if (await currentBytes(retired)) throw new Error("Incheon registration recovery required"); await rename(file, retired); try { await expected(retired, value); await unlink(retired); await syncParent(file); } catch (error) { await restoreMovedFile(retired, file).catch(() => {}); throw error; } }
async function discardExpected(file, value) { await expected(file, value); await unlink(file); await syncParent(file); }
async function atomicWrite(file, value, before) {
  await safeParent(file); await expected(file, before); const temporary = temporaryPath(file); if (await currentBytes(temporary)) throw new Error("Incheon registration recovery required");
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await expected(file, before); if (before === null) await link(temporary, file); else {
      const displaced = displacedPath(file); if (await currentBytes(displaced)) throw new Error("Incheon registration recovery required"); await rename(file, displaced);
      try { await expected(displaced, before); await link(temporary, file); await syncParent(file); await expected(file, value); await unlink(displaced); await syncParent(file); } catch (error) { await restoreMovedFile(displaced, file).catch(() => {}); throw error; }
    }
    await syncParent(file); await expected(file, value);
  } finally { await unlink(temporary).catch(() => {}); }
}
function journalRecords(outputs) { return outputs.map(({ relative, prestateBytes, bytes: after }) => ({ relative, before: prestateBytes?.toString("base64") ?? null, beforeSha256: prestateBytes == null ? null : hash(prestateBytes), after: after.toString("base64"), afterSha256: hash(after) })); }
function parseJournal(value) {
  const journal = parse(value, "Incheon registration journal");
  if (JSON.stringify(Object.keys(journal ?? {}).sort(textCompare)) !== JSON.stringify(["records", "state"]) || !["PREPARED", "COMMITTED"].includes(journal.state) || !Array.isArray(journal.records)) throw new Error("Incheon registration recovery required");
  outputAllowlist(journal.records.map((record) => ({
    relative: record.relative,
    bytes: Buffer.alloc(0),
    prestateBytes: record.before == null ? null : Buffer.alloc(0),
  })));
  for (const record of journal.records) {
    if (JSON.stringify(Object.keys(record).sort(textCompare)) !== JSON.stringify(["after", "afterSha256", "before", "beforeSha256", "relative"].sort(textCompare)) || !SHA.test(record.afterSha256 ?? "") || (record.before == null) !== (record.beforeSha256 == null) || record.beforeSha256 != null && !SHA.test(record.beforeSha256)) throw new Error("Incheon registration recovery required");
    const after = Buffer.from(record.after, "base64"); const before = record.before == null ? null : Buffer.from(record.before, "base64");
    if (after.toString("base64") !== record.after || hash(after) !== record.afterSha256 || before != null && (before.toString("base64") !== record.before || hash(before) !== record.beforeSha256)) throw new Error("Incheon registration recovery required");
  }
  return journal;
}
async function recover(root, journal, journalBytes, journalFile = target(root, JOURNAL)) {
  for (const record of journal.records) {
    const file = target(root, record.relative); const before = record.before == null ? null : Buffer.from(record.before, "base64"); const after = Buffer.from(record.after, "base64"); const temporary = await currentBytes(temporaryPath(file)); if (temporary != null) { if (!(temporary.equals(after) || before != null && temporary.equals(before))) throw new Error("Incheon registration preserves foreign replacement"); await unlink(temporaryPath(file)); await syncParent(file); } let current = await currentBytes(file); const displaced = before == null ? null : displacedPath(file); const displacedBytes = displaced == null ? null : await currentBytes(displaced); const retired = await currentBytes(retiredPath(file));
    if (displacedBytes != null && !displacedBytes.equals(before)) throw new Error("Incheon registration preserves foreign replacement");
    if (journal.state === "COMMITTED") {
      if (retired != null) throw new Error("Incheon registration recovery required");
      if (current?.equals(after)) { if (displacedBytes != null) { await unlink(displaced); await syncParent(displaced); } continue; }
      if (current == null && displacedBytes?.equals(before)) { await restoreMovedFile(displaced, file); current = before; }
      if ((current == null) !== (before == null) || current != null && !current.equals(before)) throw new Error("Incheon registration preserves foreign replacement");
      await atomicWrite(file, after, before);
    } else {
      if (retired != null) {
        if (!retired.equals(after) || current != null) throw new Error("Incheon registration preserves foreign replacement");
        if (before === null) { await discardExpected(retiredPath(file), after); continue; }
        if (displacedBytes?.equals(before)) { await restoreMovedFile(displaced, file); await discardExpected(retiredPath(file), after); continue; }
        throw new Error("Incheon registration recovery required");
      }
      if (current == null && displacedBytes?.equals(before)) { await restoreMovedFile(displaced, file); continue; }
      if (current?.equals(after) && displacedBytes?.equals(before)) { await removeExpected(file, after); await restoreMovedFile(displaced, file); continue; }
      if ((before == null && current == null) || (before != null && current?.equals(before))) { if (displacedBytes != null) await unlink(displaced); continue; }
      if (!current?.equals(after)) throw new Error("Incheon registration preserves foreign replacement");
      if (before == null) await removeExpected(file, after); else await atomicWrite(file, before, after);
    }
  }
  await removeExpected(journalFile, journalBytes);
}
async function recoverPending(root) { const journalFile = target(root, JOURNAL); const raw = await currentBytes(journalFile); if (raw == null) return; const journal = parseJournal(raw); await recover(root, journal, raw, journalFile); }
async function lease(port = 0) { const server = createServer(); await new Promise((resolve, reject) => { const ready = () => { server.off("error", fail); resolve(); }; const fail = (error) => { server.off("listening", ready); reject(error); }; server.once("listening", ready); server.once("error", fail); server.listen({ host: "127.0.0.1", port, exclusive: true }); }); return server; }
async function closeLease(server) { if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function lockValue(server) { const address = server.address(); if (!address || typeof address === "string" || address.address !== "127.0.0.1" || !Number.isInteger(address.port) || address.port < 1) throw new Error("Incheon registration lock residue exists"); return bytes({ schemaVersion: 1, host: "127.0.0.1", port: address.port, pid: process.pid, token: randomUUID() }); }
function parseLock(value) { const lock = parse(value, "Incheon registration lock"); if (JSON.stringify(Object.keys(lock)) !== JSON.stringify(["schemaVersion", "host", "port", "pid", "token"]) || lock.schemaVersion !== 1 || lock.host !== "127.0.0.1" || !Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535 || !Number.isInteger(lock.pid) || lock.pid < 1 || !/^[a-f0-9-]{36}$/u.test(lock.token ?? "")) throw new Error("Incheon registration lock residue exists"); return lock; }
async function acquire(root, { afterStaleLockRead = async () => {} } = {}) { const lock = target(root, LOCK); let server = await lease(); let mine = lockValue(server); try { await atomicWrite(lock, mine, null); } catch (error) { await closeLease(server); server = null; if (!/preserves foreign replacement/u.test(error?.message ?? "")) throw error; const stale = await currentBytes(lock); const parsed = parseLock(stale); await afterStaleLockRead(); try { server = await lease(parsed.port); } catch (cause) { throw new Error("Incheon registration lock residue exists", { cause }); } mine = lockValue(server); try { await atomicWrite(lock, mine, stale); } catch (cause) { await closeLease(server); throw new Error("Incheon registration lock residue exists", { cause }); } } return async () => { try { await removeExpected(lock, mine); } finally { await closeLease(server); } }; }
export async function commitReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot = ROOT, outputs, failAfter = null, beforeCommittedRecovery = async () => {}, afterStaleLockRead = async () => {}, acquireLease = acquire } = {}) {
  const root = path.resolve(repositoryRoot); await regularDirectory(root, "repository root"); outputAllowlist(outputs); const release = await acquireLease(root, { afterStaleLockRead }); const journalFile = target(root, JOURNAL);
  try {
    await recoverPending(root); for (const input of outputs[0].inputs ?? []) await expected(target(root, input.relative), input.bytes); for (const output of outputs) await expected(target(root, output.relative), output.prestateBytes);
    const records = journalRecords(outputs); const prepared = bytes({ state: "PREPARED", records }); await atomicWrite(journalFile, prepared, null);
    for (const [index, record] of records.entries()) { const before = record.before == null ? null : Buffer.from(record.before, "base64"); await atomicWrite(target(root, record.relative), Buffer.from(record.after, "base64"), before); if (index === failAfter) throw new Error("injected transaction failure"); }
    const committed = bytes({ state: "COMMITTED", records }); await atomicWrite(journalFile, committed, prepared); await beforeCommittedRecovery({ root, records }); await recover(root, { state: "COMMITTED", records }, committed); return { targets: records.map(({ relative }) => relative) };
  } catch (error) { await recoverPending(root); throw error; } finally { await release(); }
}
// This is intentionally limited to the registrar's own durable transaction.
// The operation runner uses it after a process interruption; it cannot create
// outputs or change an already sealed registration plan.
export async function recoverPendingReviewedIncheonAccessibilityRegistration({ repositoryRoot = ROOT, afterStaleLockRead = async () => {}, acquireLease = acquire } = {}) {
  const root = path.resolve(repositoryRoot); await regularDirectory(root, "repository root");
  const release = await acquireLease(root, { afterStaleLockRead });
  try { await recoverPending(root); } finally { await release(); }
}
export async function registerReviewedIncheonAccessibility(options = {}) { const outputs = await buildReviewedIncheonAccessibilityRegistrationOutputs(options); await commitReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: options.repositoryRoot, outputs }); return { outputs: outputs.map(({ relative }) => relative) }; }
async function main(argv) {
  if (argv.length === 2 && argv[0] === "--rebind-receipt") { const result = await rebindReceiptBoundIncheonAccessibilityCandidate({ receiptPath: argv[1] }); process.stdout.write(`${JSON.stringify({ status: "PASS", outputs: result.outputs })}\n`); return; }
  if (argv.length !== 4 || argv[0] !== "--observation" || argv[2] !== "--receipt") throw new Error("usage: --observation <absolute-directory> --receipt <absolute> | --rebind-receipt <absolute>");
  const result = await registerReviewedIncheonAccessibility({ observationRoot: argv[1], receiptPath: argv[3] }); process.stdout.write(`${JSON.stringify({ status: "PASS", outputs: result.outputs})}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
