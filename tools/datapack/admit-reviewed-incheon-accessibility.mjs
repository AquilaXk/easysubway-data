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
const isHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const same = (left, right) => JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};
const exactKeys = (value, fields, label) => {
  if (!same(Object.keys(value).sort(), [...fields].sort())) throw new Error(`${label} has unknown or missing fields`);
};

export function produceAdmission({ ownerDecision, adminReview, snapshot, topologySnapshot, inventory, candidates, policy, freshnessPolicy }) {
  object(ownerDecision, "owner decision");
  exactKeys(ownerDecision, ["schemaVersion", "artifactKind", "policyVersion", "issue", "candidateId", "sourceId", "snapshotId", "decision", "approvedBy", "approvedAt", "productionUseAllowed", "policyEntry"], "owner decision");
  if (ownerDecision.schemaVersion !== 1 || ownerDecision.artifactKind !== "source-admission-owner-decision" || ownerDecision.policyVersion !== policy.policyVersion) throw new Error("owner decision identity mismatch");
  object(adminReview, "admin review");
  exactKeys(adminReview, ["schemaVersion", "artifactKind", "candidateId", "sourceId", "snapshotId", "sampleEvidenceHash", "decision", "approvedBy", "approvedAt", "licenseEvidenceHash", "aliasLedgerHash", "operatorMappingLedgerHash", "facilityEvidenceLedgerHash", "routeEvidenceLedgerHash", "overrideHash", "quotaEvidence", "productionSource"], "admin review");
  if (adminReview.schemaVersion !== 1 || adminReview.artifactKind !== "source-admission-admin-review") throw new Error("admin review identity mismatch");
  for (const field of ["candidateId", "sourceId", "snapshotId", "decision", "approvedBy", "approvedAt"]) if (adminReview[field] !== ownerDecision[field]) throw new Error(`owner decision ${field} mismatch`);
  if (ownerDecision.decision !== "APPROVED" || ownerDecision.productionUseAllowed !== true) throw new Error("owner decision is not production approved");
  validateIncheonAccessibilitySnapshotIdentity(snapshot, freshnessPolicy, topologySnapshot);
  const candidate = object(candidates, "candidates").candidates?.find(({ id }) => id === ownerDecision.candidateId);
  const current = object(inventory, "inventory").sources?.find(({ id }) => id === ownerDecision.sourceId);
  if (!candidate || !current) throw new Error("candidate or source missing");
  if (snapshot.sourceId !== ownerDecision.sourceId || snapshot.snapshotId !== ownerDecision.snapshotId) throw new Error("snapshot identity mismatch");
  if (adminReview.sampleEvidenceHash !== snapshot.rowsSha256 || !isHash(snapshot.rawSha256) || !isHash(snapshot.schemaFingerprint)) throw new Error("snapshot evidence mismatch");
  const source = object(adminReview.productionSource, "production source");
  for (const field of ["id", "provider", "datasetUrl", "coverage", "coverageScope", "fieldsProvided", "capabilities", "license"]) if (!same(source[field], current[field])) throw new Error(`production source ${field} mismatch`);
  validateQuotaEvidence(adminReview.quotaEvidence, "admin review quota");
  if (!same(adminReview.quotaEvidence, source.admissionEvidence?.quotaEvidence)) throw new Error("production source quota mismatch");
  if (adminReview.licenseEvidenceHash !== sha(JSON.stringify(sortJson(current.license)))) throw new Error("admin review license mismatch");
  const admitted = inventory.sources.filter((item) => item.id !== ownerDecision.sourceId && item.admissionEvidence?.decision === "APPROVED");
  for (const field of ["aliasLedgerHash", "operatorMappingLedgerHash", "facilityEvidenceLedgerHash", "routeEvidenceLedgerHash", "overrideHash"]) {
    const values = admitted.map((item) => item.admissionEvidence?.[field]);
    if (values.length === 0 || values.some((value) => !isHash(value))
      || new Set(values).size !== 1 || !isHash(adminReview[field])
      || adminReview[field] !== values[0]) throw new Error(`admin review ${field} consensus mismatch`);
  }
  const policyEntry = object(ownerDecision.policyEntry, "policy entry");
  exactKeys(policyEntry, ["sourceId", "sourceClassId", "retentionClassId", "ownerRole", "stewardRole", "approvalRole", "escalationHours", "alertRoute", "licenseReview"], "policy entry");
  if (policyEntry.sourceId !== ownerDecision.sourceId || policy.sources?.some(({ sourceId }) => sourceId === policyEntry.sourceId)) throw new Error("policy entry identity mismatch");
  if (policyEntry.sourceClassId !== "static_accessibility_facility" || !policy.retentionClasses?.some(({ id }) => id === policyEntry.retentionClassId) || !same(policyEntry.licenseReview?.termsHash, adminReview.licenseEvidenceHash) || policyEntry.licenseReview?.reviewedProvider !== current.provider || policyEntry.licenseReview?.reviewedDatasetUrl !== current.datasetUrl || policyEntry.licenseReview?.status !== "APPROVED") throw new Error("policy review binding mismatch");
  const adminReviewRecordHash = sha(JSON.stringify(sortJson(adminReview)));
  const nextInventory = structuredClone(inventory); const nextSource = nextInventory.sources.find(({ id }) => id === ownerDecision.sourceId);
  nextSource.requiredForProductionPack = false; nextSource.productionUseAllowed = ownerDecision.productionUseAllowed; nextSource.capabilities.facility.productionUseAllowed = ownerDecision.productionUseAllowed;
  const preSummary = structuredClone(nextInventory); delete preSummary.sources.find(({ id }) => id === ownerDecision.sourceId).admissionEvidence;
  const evidence = { artifactKind: "source-admission-pipeline-evidence-summary", issue: ownerDecision.issue, candidateId: ownerDecision.candidateId, sourceId: ownerDecision.sourceId, snapshotId: snapshot.snapshotId, decision: ownerDecision.decision, approvedBy: ownerDecision.approvedBy, approvedAt: ownerDecision.approvedAt, sampleEvidenceHash: adminReview.sampleEvidenceHash, rawSha256: snapshot.rawSha256, schemaFingerprint: snapshot.schemaFingerprint, sourceSnapshotSetHash: sha(JSON.stringify([{ sourceId: snapshot.sourceId, snapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, schemaFingerprint: snapshot.schemaFingerprint }])), sourceInventorySha256: sha(JSON.stringify(sortJson(preSummary))), adminReviewRecordHash, licenseEvidenceHash: adminReview.licenseEvidenceHash, aliasLedgerHash: adminReview.aliasLedgerHash, operatorMappingLedgerHash: adminReview.operatorMappingLedgerHash, facilityEvidenceLedgerHash: adminReview.facilityEvidenceLedgerHash, routeEvidenceLedgerHash: adminReview.routeEvidenceLedgerHash, overrideHash: adminReview.overrideHash, admissionDurationSeconds: 0, quotaEvidence: structuredClone(adminReview.quotaEvidence) };
  nextSource.admissionEvidence = evidence; delete evidence.sourceInventorySha256; evidence.sourceInventorySha256 = sha(JSON.stringify(sortJson(nextInventory)));
  const nextCandidates = structuredClone(candidates); const nextCandidate = nextCandidates.candidates.find(({ id }) => id === ownerDecision.candidateId);
  nextCandidate.admissionStatus = "admitted_to_production_inventory"; nextCandidate.productionInventoryReferenceId = ownerDecision.sourceId;
  nextCandidate.evidence = { official: nextCandidate.evidence?.official === true, detailUrl: current.datasetUrl, license: structuredClone(current.license), liveSampleEvidenceHash: snapshot.rowsSha256, liveSampleRawSha256: snapshot.rawSha256, liveSampleSchemaFingerprint: snapshot.schemaFingerprint, snapshotId: snapshot.snapshotId, adminReview: { artifactKind: "source-admission-admin-review-summary", decision: ownerDecision.decision, approvedBy: ownerDecision.approvedBy, approvedAt: ownerDecision.approvedAt, adminReviewRecordHash } };
  delete nextCandidate.nextAction;
  const nextPolicy = structuredClone(policy); nextPolicy.sources.push(structuredClone(policyEntry)); nextPolicy.sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  validateSourceGovernancePolicy({ policy: nextPolicy, inventory: nextInventory, freshnessPolicy });
  return { inventory: nextInventory, candidates: nextCandidates, policy: nextPolicy, adminReviewRecordHash };
}

async function main() {
  const argv = process.argv.slice(2); const names = ["--owner-decision", "--admin-review", "--snapshot", "--topology-snapshot", "--inventory", "--candidates", "--policy", "--output-directory"]; if (argv.length !== names.length * 2 || new Set(argv.filter((_, i) => i % 2 === 0)).size !== names.length || argv.filter((_, i) => i % 2 === 0).some((name) => !names.includes(name))) throw new Error("invalid arguments"); const file = (name) => { const index = argv.indexOf(name); if (index < 0 || !argv[index + 1]) throw new Error(`${name} is required`); return path.resolve(root, argv[index + 1]); };
  const [ownerDecision, adminReview, snapshot, topologySnapshot, inventory, candidates, policy] = await Promise.all(["--owner-decision", "--admin-review", "--snapshot", "--topology-snapshot", "--inventory", "--candidates", "--policy"].map(async (name) => JSON.parse(await readFile(file(name), "utf8"))));
  const freshnessPolicy = JSON.parse(await readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json"), "utf8"));
  const result = produceAdmission({ ownerDecision, adminReview, snapshot, topologySnapshot, inventory, candidates, policy, freshnessPolicy });
  const output = file("--output-directory"); const parent = path.dirname(output);
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
    for (const [name, value] of [["source-inventory.json", result.inventory], ["source-candidates.json", result.candidates], ["source-governance-policy.json", result.policy]]) await writeFile(path.join(finalOutput, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) { await rm(finalOutput, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
