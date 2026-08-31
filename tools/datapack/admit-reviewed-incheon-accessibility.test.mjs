import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { produceAdmission } from "./admit-reviewed-incheon-accessibility.mjs";
import { collectIncheonAccessibility } from "./collect-incheon-accessibility.mjs";
import { sortJson } from "./lib/ledger-admission-cli.mjs";
import { validateSourceGovernancePolicy } from "./source-governance-policy.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");

function sealedProductionSource(source, snapshot, topologySnapshot) {
  const productionSource = structuredClone(source);
  productionSource.requiredForProductionPack = false;
  productionSource.observedDataUpdatedAt = "2026-07-24";
  productionSource.accessibilityAdmissionEvidence = {
    issue: 2492,
    materializer: "tools/datapack/materialize-incheon-accessibility.mjs",
    verificationTest: "tools/datapack/materialize-incheon-accessibility.test.mjs",
    snapshotId: "incheon-transit-accessibility-20260828",
    snapshotPath: "tools/datapack/sources/incheon-transit-accessibility-20260828.json",
    capturedAt: snapshot.capturedAt,
    freshUntil: new Date(Date.parse(snapshot.capturedAt) + 86_400_000).toISOString(),
    stationCount: snapshot.stationCount,
    rowCount: snapshot.rowCount,
    facilityCount: snapshot.rowCount * 3,
    rawSha256: snapshot.rawSha256,
    rowsSha256: snapshot.rowsSha256,
    datasetIds: snapshot.datasetIds,
    topologySourceId: topologySnapshot.sourceId,
    topologySnapshotId: topologySnapshot.snapshotId,
    topologyContentSha256: topologySnapshot.contentSha256,
    topologyLineages: snapshot.topologyLineages,
    membershipLineages: snapshot.membershipLineages,
  };
  delete productionSource.registrationEvidence;
  productionSource.admissionEvidence = {
    quotaEvidence: structuredClone(source.admissionEvidence.quotaEvidence),
  };
  return productionSource;
}

async function input() {
  const [elevatorBytes, escalatorBytes, wheelchairBytes, topology, freshnessPolicy, inventoryBytes, candidates, policy, candidateBuildSpecBytes, releaseRequestBytes, hashEvidenceBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv")),
    readFile(path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv")),
    readFile(path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv")),
    readFile(path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260828.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-inventory.json")),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-governance-policy.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json")),
    readFile(path.join(root, "tools/datapack/release/release-request.json")),
    readFile(path.join(root, "tools/datapack/release/hash-evidence.json")),
  ]);
  const inventory = JSON.parse(inventoryBytes);
  const candidateBuildSpec = JSON.parse(candidateBuildSpecBytes);
  const releaseRequest = JSON.parse(releaseRequestBytes);
  const hashEvidence = JSON.parse(hashEvidenceBytes);
  const topologySnapshot = { ...topology, snapshotId: "incheon-transit-station-info-20260828" };
  const snapshot = collectIncheonAccessibility({ elevatorBytes, escalatorBytes, wheelchairBytes, topologySnapshot, freshnessPolicy, now: new Date("2026-08-28T04:33:56.000Z") });
  const source = inventory.sources.find(({ id }) => id === "incheon-transit-accessibility");
  if (!source) throw new Error("test requires current Incheon inventory source");
  const candidate = candidates.candidates.find(({ id }) => id === source.id);
  if (!candidate) throw new Error("test requires current Incheon candidate");
  policy.sources = policy.sources.filter(({ sourceId }) => sourceId !== source.id);
  const licenseEvidenceHash = sha(JSON.stringify(sortJson(source.license)));
  const selected = candidateBuildSpec.sourceSnapshots.map(({ sourceId }) => inventory.sources.find(({ id }) => id === sourceId)).filter((item) => item?.admissionEvidence?.decision === "APPROVED");
  const anchors = Object.fromEntries([
    ["aliasLedgerHash", candidateBuildSpec.approvedAliasLedgerHash],
    ["facilityEvidenceLedgerHash", candidateBuildSpec.facilityEvidenceLedgerHash],
    ["routeEvidenceLedgerHash", candidateBuildSpec.routeEvidenceLedgerHash],
    ["overrideHash", candidateBuildSpec.approvedOverrideSetHash],
  ]);
  const cohort = selected.filter((item) => Object.entries(anchors).every(([field, value]) => item.admissionEvidence[field] === value));
  if (cohort.length === 0) throw new Error("test requires candidate-bound consensus cohort");
  const first = cohort[0];
  const adminReview = {
    schemaVersion: 1, artifactKind: "source-admission-admin-review", candidateId: source.id, sourceId: source.id,
    snapshotId: snapshot.snapshotId, sampleEvidenceHash: snapshot.rowsSha256, decision: "APPROVED", approvedBy: "AquilaXk",
    approvedAt: "2026-08-29T04:49:49.000Z", licenseEvidenceHash,
    aliasLedgerHash: first.admissionEvidence.aliasLedgerHash, operatorMappingLedgerHash: first.admissionEvidence.operatorMappingLedgerHash,
    facilityEvidenceLedgerHash: first.admissionEvidence.facilityEvidenceLedgerHash, routeEvidenceLedgerHash: first.admissionEvidence.routeEvidenceLedgerHash,
    overrideHash: first.admissionEvidence.overrideHash, quotaEvidence: { defaultDailyLimit: "unlimited", portal: "data.go.kr", productionUseAllowed: true, unlockStatus: "not_required" }, productionSource: sealedProductionSource(source, snapshot, topologySnapshot),
  };
  const ownerDecision = {
    schemaVersion: 1, artifactKind: "source-admission-owner-decision", policyVersion: policy.policyVersion, issue: 622,
    candidateId: source.id, sourceId: source.id, snapshotId: snapshot.snapshotId, decision: "APPROVED", approvedBy: "AquilaXk",
    approvedAt: adminReview.approvedAt, productionUseAllowed: true,
    policyEntry: { sourceId: source.id, sourceClassId: "static_accessibility_facility", retentionClassId: "standard-90d", ownerRole: "datapack-source-owner", stewardRole: "datapack-data-steward", approvalRole: "datapack-release-approver", escalationHours: 4, alertRoute: "github:area-datapack", licenseReview: { status: "APPROVED", termsHash: licenseEvidenceHash, reviewedAt: "2026-08-29T04:49:49.000Z", nextReviewAt: "2027-08-29T04:49:49.000Z", termsUrl: source.datasetUrl, reviewedProvider: source.provider, reviewedDatasetUrl: source.datasetUrl, redistributionScopes: ["DERIVED_DATAPACK"], approvedByRole: "datapack-release-approver" } },
  };
  const result = { ownerDecision, adminReview, snapshot, topologySnapshot, inventory, inventoryBytes, candidates, policy, freshnessPolicy, candidateBuildSpec, candidateBuildSpecBytes, releaseRequest, releaseRequestBytes, hashEvidence, hashEvidenceBytes };
  rebind(result, { inventory: true });
  return result;
}

function rebind(value, { inventory = false, buildSpec = false, releaseRequest = false, hashEvidence = false } = {}) {
  if (inventory) {
    value.inventoryBytes = Buffer.from(JSON.stringify(value.inventory));
    value.candidateBuildSpec.sourceInventorySha256 = sha(JSON.stringify(value.inventory));
    value.candidateBuildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha(value.inventoryBytes);
    value.hashEvidence.sourceInventorySha256.value = value.candidateBuildSpec.sourceInventorySha256;
    buildSpec = true; hashEvidence = true;
  }
  if (buildSpec) { value.candidateBuildSpecBytes = Buffer.from(JSON.stringify(value.candidateBuildSpec)); value.releaseRequest.buildSpecSha256 = sha(value.candidateBuildSpecBytes); releaseRequest = true; }
  if (releaseRequest) value.releaseRequestBytes = Buffer.from(JSON.stringify(value.releaseRequest));
  if (hashEvidence) value.hashEvidenceBytes = Buffer.from(JSON.stringify(value.hashEvidence));
}

test("producer admits a canonical official snapshot without mutating candidate input", async () => {
  const value = await input();
  const candidatesBefore = structuredClone(value.candidates);
  const result = produceAdmission(value);
  assert.equal(result.inventory.sources.find(({ id }) => id === value.ownerDecision.sourceId).requiredForProductionPack, false);
  assert.match(result.adminReviewRecordHash, /^[a-f0-9]{64}$/u);
  assert.equal("candidates" in result, false);
  assert.deepEqual(value.candidates, candidatesBefore);
  validateSourceGovernancePolicy({ policy: result.policy, inventory: result.inventory, freshnessPolicy: value.freshnessPolicy });
});

test("producer rejects a self-consistent substituted approval through sealed authority identity", async () => {
  const value = await input();
  const approvedAt = "2026-08-30T04:49:49.000Z";
  for (const record of [value.ownerDecision, value.adminReview]) {
    record.approvedBy = "substituted-approver";
    record.approvedAt = approvedAt;
  }
  value.ownerDecision.policyEntry.licenseReview.reviewedAt = approvedAt;
  value.ownerDecision.policyEntry.licenseReview.nextReviewAt = "2027-08-30T04:49:49.000Z";
  assert.throws(() => produceAdmission(value), /owner decision authority identity mismatch/);
});

test("producer rejects tampered component, claim, topology, license, freshness, shared hashes, quota and self-hash inputs", async () => {
  const mutations = [
    ["component", (x) => { x.snapshot.elevatorRawSha256 = "0".repeat(64); }],
    ["claim", (x) => { x.snapshot.claimBindings[0].stationCode = "wrong"; x.snapshot.claimBindingsSha256 = sha(JSON.stringify(x.snapshot.claimBindings)); }],
    ["topology", (x) => {
      const forged = x.snapshot.claimTopology[0];
      const originalStationId = forged.stationId;
      forged.stationId = "station-forged";
      for (const binding of x.snapshot.claimBindings) {
        if (binding.stationId === originalStationId && binding.sourceLineId === forged.lineId && binding.stationCode === forged.stationCode) {
          binding.stationId = forged.stationId;
        }
      }
      x.snapshot.claimBindingsSha256 = sha(JSON.stringify(x.snapshot.claimBindings));
    }],
    ["license", (x) => { x.adminReview.licenseEvidenceHash = "0".repeat(64); }],
    ["policy", (x) => { x.ownerDecision.policyEntry.sourceClassId = "static_network_metadata"; }],
    ["admin consensus", (x) => { x.adminReview.aliasLedgerHash = "0".repeat(64); }],
    ["cohort", (x) => { for (const source of x.inventory.sources.filter(({ admissionEvidence }) => admissionEvidence?.decision === "APPROVED")) source.admissionEvidence.aliasLedgerHash = null; rebind(x, { inventory: true }); }],
    ["quota", (x) => { x.adminReview.quotaEvidence.productionUseAllowed = false; }],
    ["official snapshot", (x) => { x.snapshot.official = false; }],
    ["self hash", (x) => { x.snapshot.rowsSha256 = "0".repeat(64); }],
  ];
  for (const [label, mutate] of mutations) {
    const value = await input();
    mutate(value);
    assert.throws(() => produceAdmission(value), label);
  }
});

test("producer binds consensus to the canonical release candidate and exact inventory bytes", async () => {
  const cases = [
    ["candidate build spec schema", (x) => { x.candidateBuildSpec.schemaVersion = 2; rebind(x, { buildSpec: true }); }],
    ["release request kind", (x) => { x.releaseRequest.artifactKind = "other-request"; x.releaseRequestBytes = Buffer.from(JSON.stringify(x.releaseRequest)); }],
    ["hash evidence schema", (x) => { x.hashEvidence.schemaVersion = 2; x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["build spec raw hash", (x) => { x.releaseRequest.buildSpecSha256 = "0".repeat(64); x.releaseRequestBytes = Buffer.from(JSON.stringify(x.releaseRequest)); }],
    ["candidate identity", (x) => { x.releaseRequest.candidateId = "other-candidate"; x.releaseRequestBytes = Buffer.from(JSON.stringify(x.releaseRequest)); }],
    ["scope identity", (x) => { x.releaseRequest.scopeId = "other-scope"; x.releaseRequestBytes = Buffer.from(JSON.stringify(x.releaseRequest)); }],
    ["snapshot set identity", (x) => { x.releaseRequest.sourceSnapshotSetHash = "0".repeat(64); x.releaseRequestBytes = Buffer.from(JSON.stringify(x.releaseRequest)); }],
    ["approved ledger identity", (x) => { x.releaseRequest.approvedLedgerHash = "0".repeat(64); x.releaseRequestBytes = Buffer.from(JSON.stringify(x.releaseRequest)); }],
    ["hash evidence candidate identity", (x) => { x.hashEvidence.identifiers.candidateId.value = "other-candidate"; x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["hash evidence scope identity", (x) => { x.hashEvidence.productionScopeId = "other-scope"; x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["hash evidence snapshot set", (x) => { x.hashEvidence.sourceSnapshotSetHash.value = "0".repeat(64); x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["hash evidence approved ledger", (x) => { x.hashEvidence.ledgerHashes.approvedAliasLedgerHash.value = "0".repeat(64); x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["hash evidence candidate anchor", (x) => { x.hashEvidence.ledgerHashes.facilityEvidenceLedgerHash.value = "0".repeat(64); x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["approval identifier", (x) => { x.hashEvidence.identifiers.approvalId.value = "other-approval"; x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["builder identity", (x) => { x.hashEvidence.builderVersion = "other-builder"; x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["parsed inventory", (x) => { x.inventory.sources[0].id = "tampered"; }],
    ["inventory raw bytes", (x) => { x.inventoryBytes = Buffer.concat([x.inventoryBytes, Buffer.from(" ")]); }],
    ["inventory evidence path", (x) => { x.candidateBuildSpec.networkEdgeEvidence.sourceInventory.path = "tools/datapack/not-source-inventory.json"; rebind(x, { buildSpec: true }); }],
    ["selected duplicate snapshot", (x) => { x.candidateBuildSpec.sourceSnapshotIds[1] = x.candidateBuildSpec.sourceSnapshotIds[0]; x.candidateBuildSpec.sourceSnapshots[1].snapshotId = x.candidateBuildSpec.sourceSnapshotIds[0]; rebind(x, { buildSpec: true }); }],
    ["selected source mismatch", (x) => { x.candidateBuildSpec.sourceSnapshots[0].snapshotId = "mismatched-snapshot"; rebind(x, { buildSpec: true }); }],
    ["selected duplicate source", (x) => { x.candidateBuildSpec.sourceSnapshots[1].sourceId = x.candidateBuildSpec.sourceSnapshots[0].sourceId; rebind(x, { buildSpec: true }); }],
    ["selected missing source", (x) => { x.inventory.sources = x.inventory.sources.filter(({ id }) => id !== x.candidateBuildSpec.sourceSnapshots[0].sourceId); rebind(x, { inventory: true }); }],
    ["projection review binding", (x) => { x.candidateBuildSpec.sourceSnapshots[0].adminReviewRecordHash = "0".repeat(64); rebind(x, { buildSpec: true }); }],
    ["duplicate per-source review evidence", (x) => { x.hashEvidence.perSourceEvidence.push(structuredClone(x.hashEvidence.perSourceEvidence[0])); x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["stale per-source review evidence", (x) => { x.hashEvidence.perSourceEvidence[0].snapshotId = "stale-snapshot"; x.hashEvidenceBytes = Buffer.from(JSON.stringify(x.hashEvidence)); }],
    ["selected current-generation anchor drift", (x) => { const source = x.inventory.sources.find(({ id }) => id === "seoul-metro-accessibility"); source.admissionEvidence.facilityEvidenceLedgerHash = "0".repeat(64); rebind(x, { inventory: true }); }],
    ["cohort operator divergence", (x) => { const source = x.inventory.sources.find(({ id }) => id === "seoul-metro-accessibility"); source.admissionEvidence.operatorMappingLedgerHash = "0".repeat(64); rebind(x, { inventory: true }); }],
    ["empty cohort", (x) => { x.candidateBuildSpec.approvedAliasLedgerHash = "0".repeat(64); x.hashEvidence.ledgerHashes.approvedAliasLedgerHash.value = x.candidateBuildSpec.approvedAliasLedgerHash; rebind(x, { buildSpec: true, hashEvidence: true }); }],
    ["admin review mismatch", (x) => { x.adminReview.routeEvidenceLedgerHash = "0".repeat(64); }],
    ["self-consistent but unapproved substituted candidate", (x) => { x.candidateBuildSpec.candidateId = "arbitrary-candidate"; x.releaseRequest.candidateId = "arbitrary-candidate"; x.hashEvidence.identifiers.candidateId.value = "arbitrary-candidate"; rebind(x, { buildSpec: true, hashEvidence: true }); }],
  ];
  for (const [label, mutate] of cases) {
    const value = await input();
    mutate(value);
    assert.throws(() => produceAdmission(value), label);
  }
});

test("producer CLI rejects unknown or duplicate flags, symlinked parents, and partial outputs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incheon-admission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = await input();
  const values = { "--owner-decision": value.ownerDecision, "--admin-review": value.adminReview, "--snapshot": value.snapshot, "--topology-snapshot": value.topologySnapshot, "--candidates": value.candidates, "--policy": value.policy };
  const args = ["--inventory", path.join(root, "tools/datapack/source-inventory.json")];
  for (const [flag, body] of Object.entries(values)) { const file = path.join(directory, `${flag.slice(2)}.json`); await writeFile(file, `${JSON.stringify(body)}\n`); args.push(flag, file); }
  const script = path.join(root, "tools/datapack/admit-reviewed-incheon-accessibility.mjs");
  await assert.rejects(execFile("node", [script, ...args, "--unknown", "x", "--output-directory", path.join(directory, "out")]), /invalid arguments/);
  await assert.rejects(execFile("node", [script, ...args, "--policy", path.join(directory, "policy.json"), "--output-directory", path.join(directory, "out")]), /invalid arguments/);
  const target = path.join(directory, "target"); await writeFile(target, "sentinel\n");
  const linked = path.join(directory, "linked"); await symlink(target, linked);
  await assert.rejects(execFile("node", [script, ...args, "--output-directory", path.join(linked, "out")]), /output parent is invalid/);
  const existing = path.join(directory, "existing"); await writeFile(existing, "sentinel\n");
  await assert.rejects(execFile("node", [script, ...args, "--output-directory", existing]), /output already exists/);
  assert.equal(await readFile(existing, "utf8"), "sentinel\n");
});
