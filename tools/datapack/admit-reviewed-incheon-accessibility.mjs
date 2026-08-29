#!/usr/bin/env node
// Pure admission producer.  Approval facts are supplied as canonical input;
// this command never discovers, invents, or persists an approval decision.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sortJson } from "./lib/ledger-admission-cli.mjs";
import { validateQuotaEvidence } from "./lib/quota-evidence.mjs";
import { validateIncheonAccessibilitySnapshotIdentity } from "./collect-incheon-accessibility.mjs";
import { validateSourceGovernancePolicy } from "./source-governance-policy.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonicalHash = (value) => sha(JSON.stringify(sortJson(value)));
const isHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const same = (left, right) => JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};
const exactKeys = (value, fields, label) => {
  if (!same(Object.keys(value).sort(compareStrings), [...fields].sort(compareStrings))) throw new Error(`${label} has unknown or missing fields`);
};

const canonicalInventoryPath = "tools/datapack/source-inventory.json";
// These hashes seal the owner-recorded #622 admission decision and its matching
// admin review. They intentionally cover canonical JSON, never input whitespace.
const sealedOwnerDecisionHash = "7180304ef6d3e6c270f9d3d7a76e349a16b605f37a114ca749d358dce467aa43";
const sealedAdminReviewHash = "3c705c2f2d65bd171d2cd4125266c63d0c3dee506cd76405e727573955f580f4";
const incheonAccessibilitySourceId = "incheon-transit-accessibility";
const incheonAccessibilitySnapshotId = "incheon-transit-accessibility-20260828T043356000Z";
const candidateAnchorFields = [
  ["aliasLedgerHash", "approvedAliasLedgerHash"],
  ["facilityEvidenceLedgerHash", "facilityEvidenceLedgerHash"],
  ["routeEvidenceLedgerHash", "routeEvidenceLedgerHash"],
  ["overrideHash", "approvedOverrideSetHash"],
];
const admissionHashFields = ["aliasLedgerHash", "operatorMappingLedgerHash", "facilityEvidenceLedgerHash", "routeEvidenceLedgerHash", "overrideHash"];
const bytes = (value, label) => {
  if (!(typeof value === "string" || Buffer.isBuffer(value))) throw new Error(`${label} bytes are required`);
  return value;
};
const parsedBytesMatch = (value, raw, label) => {
  try { if (!same(value, JSON.parse(raw.toString()))) throw new Error(`${label} bytes mismatch`); }
  catch (error) { if (error.message === `${label} bytes mismatch`) throw error; throw new Error(`${label} bytes are invalid`); }
};

export function produceAdmission({ ownerDecision, adminReview, snapshot, topologySnapshot, inventory, inventoryBytes, candidates, policy, freshnessPolicy, candidateBuildSpec, candidateBuildSpecBytes, releaseRequest, releaseRequestBytes, hashEvidence, hashEvidenceBytes }) {
  object(candidateBuildSpec, "candidate build spec"); object(releaseRequest, "release request"); object(hashEvidence, "hash evidence");
  const buildSpecBytes = bytes(candidateBuildSpecBytes, "candidate build spec"); const requestBytes = bytes(releaseRequestBytes, "release request"); const evidenceBytes = bytes(hashEvidenceBytes, "hash evidence"); const sourceInventoryBytes = bytes(inventoryBytes, "inventory");
  parsedBytesMatch(candidateBuildSpec, buildSpecBytes, "candidate build spec"); parsedBytesMatch(releaseRequest, requestBytes, "release request"); parsedBytesMatch(hashEvidence, evidenceBytes, "hash evidence"); parsedBytesMatch(inventory, sourceInventoryBytes, "inventory");
  const sourceInventoryEvidence = object(object(candidateBuildSpec.networkEdgeEvidence, "candidate build spec network edge evidence").sourceInventory, "candidate build spec source inventory evidence");
  const evidenceIdentifiers = object(hashEvidence.identifiers, "hash evidence identifiers");
  const evidenceSnapshotSet = object(hashEvidence.sourceSnapshotSetHash, "hash evidence source snapshot set");
  const evidenceInventory = object(hashEvidence.sourceInventorySha256, "hash evidence source inventory");
  const evidenceLedgers = object(hashEvidence.ledgerHashes, "hash evidence ledgers");
  if (candidateBuildSpec.schemaVersion !== 1 || candidateBuildSpec.artifactKind !== "datapack-candidate-build-spec"
    || releaseRequest.schemaVersion !== 1 || releaseRequest.artifactKind !== "datapack-release-request"
    || hashEvidence.schemaVersion !== 1 || hashEvidence.artifactKind !== "datapack-build-spec-hash-evidence") throw new Error("canonical release artifact schema mismatch");
  if (!isHash(releaseRequest.buildSpecSha256) || sha(buildSpecBytes) !== releaseRequest.buildSpecSha256) throw new Error("release request build spec binding mismatch");
  if (candidateBuildSpec.candidateId !== releaseRequest.candidateId || candidateBuildSpec.candidateId !== evidenceIdentifiers.candidateId?.value
    || candidateBuildSpec.productionScopeId !== releaseRequest.scopeId || candidateBuildSpec.productionScopeId !== hashEvidence.productionScopeId
    || candidateBuildSpec.sourceSnapshotSetHash !== releaseRequest.sourceSnapshotSetHash || candidateBuildSpec.sourceSnapshotSetHash !== evidenceSnapshotSet.value
    || candidateBuildSpec.builderGitSha !== hashEvidence.builderGitSha || candidateBuildSpec.builderVersion !== hashEvidence.builderVersion) throw new Error("canonical candidate identity mismatch");
  if (typeof releaseRequest.approvalId !== "string" || releaseRequest.approvalId.length === 0
    || releaseRequest.approvalId !== evidenceIdentifiers.approvalId?.value
    || !releaseRequest.approvalId.startsWith(`release-request-${candidateBuildSpec.candidateId}-`)) throw new Error("release approval binding mismatch");
  if (releaseRequest.approvedLedgerHash !== candidateBuildSpec.approvedAliasLedgerHash || releaseRequest.approvedLedgerHash !== evidenceLedgers.approvedAliasLedgerHash?.value) throw new Error("approved ledger binding mismatch");
  for (const [admissionField, buildSpecField] of candidateAnchorFields) {
    const expected = candidateBuildSpec[buildSpecField]; const evidenceField = buildSpecField === "approvedOverrideSetHash" ? "approvedOverrideSetHash" : buildSpecField;
    if (!isHash(expected) || evidenceLedgers[evidenceField]?.value !== expected) throw new Error(`candidate ${admissionField} anchor mismatch`);
  }
  if (sha(JSON.stringify(inventory)) !== candidateBuildSpec.sourceInventorySha256 || candidateBuildSpec.sourceInventorySha256 !== evidenceInventory.value) throw new Error("parsed inventory binding mismatch");
  if (sourceInventoryEvidence.path !== canonicalInventoryPath || !isHash(sourceInventoryEvidence.sha256) || sha(sourceInventoryBytes) !== sourceInventoryEvidence.sha256) throw new Error("inventory byte binding mismatch");
  if (!Array.isArray(candidateBuildSpec.sourceSnapshotIds) || !Array.isArray(candidateBuildSpec.sourceSnapshots)
    || candidateBuildSpec.sourceSnapshotIds.length === 0 || candidateBuildSpec.sourceSnapshotIds.length !== candidateBuildSpec.sourceSnapshots.length
    || candidateBuildSpec.sourceSnapshotIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(candidateBuildSpec.sourceSnapshotIds).size !== candidateBuildSpec.sourceSnapshotIds.length) throw new Error("candidate source snapshots are invalid");
  const selectedSourceIds = candidateBuildSpec.sourceSnapshots.map((entry, index) => {
    object(entry, `candidate source snapshot ${index}`);
    if (entry.snapshotId !== candidateBuildSpec.sourceSnapshotIds[index] || typeof entry.sourceId !== "string" || entry.sourceId.length === 0) throw new Error("candidate source snapshot identity mismatch");
    return entry.sourceId;
  });
  if (new Set(selectedSourceIds).size !== selectedSourceIds.length) throw new Error("candidate source IDs are not unique");
  const inventorySources = object(inventory, "inventory").sources;
  if (!Array.isArray(inventorySources) || new Set(inventorySources.map(({ id }) => id)).size !== inventorySources.length) throw new Error("inventory source identities are invalid");
  const selectedSources = selectedSourceIds.map((sourceId) => {
    const source = inventorySources.find(({ id }) => id === sourceId);
    if (!source) throw new Error("candidate selected source is missing from inventory");
    return source;
  });
  const perSourceEvidence = hashEvidence.perSourceEvidence;
  if (!Array.isArray(perSourceEvidence) || perSourceEvidence.length !== selectedSources.length) throw new Error("candidate per-source evidence is incomplete");
  for (let index = 0; index < selectedSources.length; index += 1) {
    const source = selectedSources[index]; const projection = candidateBuildSpec.sourceSnapshots[index]; const reviewHash = source.admissionEvidence?.adminReviewRecordHash;
    if (!isHash(reviewHash) || projection.adminReviewRecordHash !== reviewHash) throw new Error("candidate projection review binding mismatch");
    const records = perSourceEvidence.filter(({ sourceId }) => sourceId === source.id);
    if (records.length !== 1 || records[0]?.snapshotId !== projection.snapshotId || records[0].adminReviewRecordHash !== reviewHash) throw new Error("candidate per-source review evidence mismatch");
    const anchorMatches = candidateAnchorFields.filter(([field, buildSpecField]) => source.admissionEvidence?.[field] === candidateBuildSpec[buildSpecField]).length;
    if (admissionHashFields.every((field) => isHash(source.admissionEvidence?.[field])) && anchorMatches > 0 && anchorMatches < candidateAnchorFields.length) throw new Error("candidate selected source anchor drift");
  }
  const cohort = selectedSources.filter((source) => source.admissionEvidence?.decision === "APPROVED" && admissionHashFields.every((field) => isHash(source.admissionEvidence?.[field]))
    && candidateAnchorFields.every(([admissionField, buildSpecField]) => source.admissionEvidence[admissionField] === candidateBuildSpec[buildSpecField]));
  if (cohort.length === 0) throw new Error("candidate admission cohort is empty");
  for (const field of admissionHashFields) {
    const values = cohort.map((source) => source.admissionEvidence[field]);
    if (new Set(values).size !== 1 || !isHash(values[0])) throw new Error(`candidate admission cohort ${field} consensus mismatch`);
    if ((field !== "operatorMappingLedgerHash" && values[0] !== candidateBuildSpec[candidateAnchorFields.find(([name]) => name === field)?.[1]])) throw new Error(`candidate admission cohort ${field} anchor mismatch`);
  }
  object(ownerDecision, "owner decision");
  exactKeys(ownerDecision, ["schemaVersion", "artifactKind", "policyVersion", "issue", "candidateId", "sourceId", "snapshotId", "decision", "approvedBy", "approvedAt", "productionUseAllowed", "policyEntry"], "owner decision");
  if (ownerDecision.schemaVersion !== 1 || ownerDecision.artifactKind !== "source-admission-owner-decision" || ownerDecision.policyVersion !== policy.policyVersion) throw new Error("owner decision identity mismatch");
  if (ownerDecision.issue !== 622 || ownerDecision.candidateId !== incheonAccessibilitySourceId || ownerDecision.sourceId !== incheonAccessibilitySourceId || ownerDecision.snapshotId !== incheonAccessibilitySnapshotId) throw new Error("owner decision authority scope mismatch");
  if (canonicalHash(ownerDecision) !== sealedOwnerDecisionHash) throw new Error("owner decision authority identity mismatch");
  object(adminReview, "admin review");
  exactKeys(adminReview, ["schemaVersion", "artifactKind", "candidateId", "sourceId", "snapshotId", "sampleEvidenceHash", "decision", "approvedBy", "approvedAt", "licenseEvidenceHash", "aliasLedgerHash", "operatorMappingLedgerHash", "facilityEvidenceLedgerHash", "routeEvidenceLedgerHash", "overrideHash", "quotaEvidence", "productionSource"], "admin review");
  if (adminReview.schemaVersion !== 1 || adminReview.artifactKind !== "source-admission-admin-review") throw new Error("admin review identity mismatch");
  if (canonicalHash(adminReview) !== sealedAdminReviewHash) throw new Error("admin review authority identity mismatch");
  for (const field of ["candidateId", "sourceId", "snapshotId", "decision", "approvedBy", "approvedAt"]) if (adminReview[field] !== ownerDecision[field]) throw new Error(`owner decision ${field} mismatch`);
  if (ownerDecision.decision !== "APPROVED" || ownerDecision.productionUseAllowed !== true) throw new Error("owner decision is not production approved");
  validateIncheonAccessibilitySnapshotIdentity(snapshot, freshnessPolicy, topologySnapshot);
  const candidate = object(candidates, "candidates").candidates?.find(({ id }) => id === ownerDecision.candidateId);
  const current = inventorySources.find(({ id }) => id === ownerDecision.sourceId);
  if (!candidate || !current) throw new Error("candidate or source missing");
  if (snapshot.sourceId !== ownerDecision.sourceId || snapshot.snapshotId !== ownerDecision.snapshotId) throw new Error("snapshot identity mismatch");
  if (snapshot.official !== true) throw new Error("snapshot is not official");
  if (adminReview.sampleEvidenceHash !== snapshot.rowsSha256 || !isHash(snapshot.rawSha256) || !isHash(snapshot.schemaFingerprint)) throw new Error("snapshot evidence mismatch");
  const source = object(adminReview.productionSource, "production source");
  for (const field of ["id", "provider", "datasetUrl", "coverage", "coverageScope", "fieldsProvided", "capabilities", "license"]) if (!same(source[field], current[field])) throw new Error(`production source ${field} mismatch`);
  validateQuotaEvidence(adminReview.quotaEvidence, "admin review quota");
  if (adminReview.quotaEvidence.productionUseAllowed !== true) throw new Error("admin review quota is not production approved");
  if (source.admissionEvidence?.quotaEvidence && !same(adminReview.quotaEvidence, source.admissionEvidence.quotaEvidence)) throw new Error("production source quota mismatch");
  if (adminReview.licenseEvidenceHash !== sha(JSON.stringify(sortJson(current.license)))) throw new Error("admin review license mismatch");
  for (const field of admissionHashFields) {
    const value = cohort[0].admissionEvidence[field];
    if (!isHash(adminReview[field]) || adminReview[field] !== value) throw new Error(`admin review ${field} consensus mismatch`);
  }
  const policyEntry = object(ownerDecision.policyEntry, "policy entry");
  exactKeys(policyEntry, ["sourceId", "sourceClassId", "retentionClassId", "ownerRole", "stewardRole", "approvalRole", "escalationHours", "alertRoute", "licenseReview"], "policy entry");
  if (policyEntry.sourceId !== ownerDecision.sourceId || policy.sources?.some(({ sourceId }) => sourceId === policyEntry.sourceId)) throw new Error("policy entry identity mismatch");
  if (policyEntry.sourceClassId !== "static_accessibility_facility" || !policy.retentionClasses?.some(({ id }) => id === policyEntry.retentionClassId) || !same(policyEntry.licenseReview?.termsHash, adminReview.licenseEvidenceHash) || policyEntry.licenseReview?.reviewedProvider !== current.provider || policyEntry.licenseReview?.reviewedDatasetUrl !== current.datasetUrl || policyEntry.licenseReview?.status !== "APPROVED") throw new Error("policy review binding mismatch");
  const adminReviewRecordHash = canonicalHash(adminReview);
  const nextInventory = structuredClone(inventory); const nextSource = nextInventory.sources.find(({ id }) => id === ownerDecision.sourceId);
  nextSource.requiredForProductionPack = false; nextSource.productionUseAllowed = ownerDecision.productionUseAllowed; nextSource.capabilities.facility.productionUseAllowed = ownerDecision.productionUseAllowed;
  const preSummary = structuredClone(nextInventory); delete preSummary.sources.find(({ id }) => id === ownerDecision.sourceId).admissionEvidence;
  const evidence = { artifactKind: "source-admission-pipeline-evidence-summary", issue: ownerDecision.issue, candidateId: ownerDecision.candidateId, sourceId: ownerDecision.sourceId, snapshotId: snapshot.snapshotId, decision: ownerDecision.decision, approvedBy: ownerDecision.approvedBy, approvedAt: ownerDecision.approvedAt, sampleEvidenceHash: adminReview.sampleEvidenceHash, rawSha256: snapshot.rawSha256, schemaFingerprint: snapshot.schemaFingerprint, sourceSnapshotSetHash: sha(JSON.stringify([{ sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, schemaFingerprint: snapshot.schemaFingerprint }])), sourceInventorySha256: sha(JSON.stringify(sortJson(preSummary))), adminReviewRecordHash, licenseEvidenceHash: adminReview.licenseEvidenceHash, aliasLedgerHash: adminReview.aliasLedgerHash, operatorMappingLedgerHash: adminReview.operatorMappingLedgerHash, facilityEvidenceLedgerHash: adminReview.facilityEvidenceLedgerHash, routeEvidenceLedgerHash: adminReview.routeEvidenceLedgerHash, overrideHash: adminReview.overrideHash, admissionDurationSeconds: 0, quotaEvidence: structuredClone(adminReview.quotaEvidence) };
  nextSource.admissionEvidence = evidence; delete evidence.sourceInventorySha256; evidence.sourceInventorySha256 = sha(JSON.stringify(sortJson(nextInventory)));
  const nextPolicy = structuredClone(policy); nextPolicy.sources.push(structuredClone(policyEntry)); nextPolicy.sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  validateSourceGovernancePolicy({ policy: nextPolicy, inventory: nextInventory, freshnessPolicy });
  return { inventory: nextInventory, policy: nextPolicy, adminReviewRecordHash };
}

async function main() {
  const argv = process.argv.slice(2); const names = ["--owner-decision", "--admin-review", "--snapshot", "--topology-snapshot", "--inventory", "--candidates", "--policy", "--output-directory"]; if (argv.length !== names.length * 2 || new Set(argv.filter((_, i) => i % 2 === 0)).size !== names.length || argv.filter((_, i) => i % 2 === 0).some((name) => !names.includes(name))) throw new Error("invalid arguments"); const file = (name) => { const index = argv.indexOf(name); if (index < 0 || !argv[index + 1]) throw new Error(`${name} is required`); return path.resolve(root, argv[index + 1]); };
  const inventoryPath = file("--inventory"); if (inventoryPath !== path.join(root, canonicalInventoryPath)) throw new Error("inventory path must be canonical");
  const output = file("--output-directory"); const parent = path.dirname(output);
  try {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("output parent is invalid");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try { await lstat(output); throw new Error("output already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const [ownerDecision, adminReview, snapshot, topologySnapshot, inventoryBytes, candidates, policy, candidateBuildSpecBytes, releaseRequestBytes, hashEvidenceBytes] = await Promise.all(["--owner-decision", "--admin-review", "--snapshot", "--topology-snapshot", "--inventory", "--candidates", "--policy"].map((name) => readFile(file(name))).concat([
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")), readFile(path.join(root, "tools/datapack/release/release-request.json")), readFile(path.join(root, "tools/datapack/release/hash-evidence.json")),
  ]));
  const [parsedOwnerDecision, parsedAdminReview, parsedSnapshot, parsedTopologySnapshot, parsedInventory, parsedCandidates, parsedPolicy, candidateBuildSpec, releaseRequest, hashEvidence] = [ownerDecision, adminReview, snapshot, topologySnapshot, inventoryBytes, candidates, policy, candidateBuildSpecBytes, releaseRequestBytes, hashEvidenceBytes].map((value) => JSON.parse(value));
  const freshnessPolicy = JSON.parse(await readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json"), "utf8"));
  const result = produceAdmission({ ownerDecision: parsedOwnerDecision, adminReview: parsedAdminReview, snapshot: parsedSnapshot, topologySnapshot: parsedTopologySnapshot, inventory: parsedInventory, inventoryBytes, candidates: parsedCandidates, policy: parsedPolicy, freshnessPolicy, candidateBuildSpec, candidateBuildSpecBytes, releaseRequest, releaseRequestBytes, hashEvidence, hashEvidenceBytes });
  let parentStat;
  try { parentStat = await lstat(parent); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    parentStat = await lstat(parent);
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("output parent is invalid");
  const finalOutput = path.join(await realpath(parent), path.basename(output));
  try { await mkdir(finalOutput, { mode: 0o700 }); } catch (error) { if (error?.code === "EEXIST") throw new Error("output already exists"); throw error; }
  try {
    for (const [name, value] of [["source-inventory.json", result.inventory], ["source-governance-policy.json", result.policy]]) await writeFile(path.join(finalOutput, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) { await rm(finalOutput, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
