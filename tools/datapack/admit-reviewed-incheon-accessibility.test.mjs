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

async function input() {
  const [elevatorBytes, escalatorBytes, wheelchairBytes, topology, freshnessPolicy, inventory, candidates, policy] = await Promise.all([
    readFile(path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv")),
    readFile(path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv")),
    readFile(path.join(root, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv")),
    readFile(path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260828.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/source-governance-policy.json"), "utf8").then(JSON.parse),
  ]);
  const topologySnapshot = { ...topology, snapshotId: "incheon-transit-station-info-20260828" };
  const snapshot = collectIncheonAccessibility({ elevatorBytes, escalatorBytes, wheelchairBytes, topologySnapshot, freshnessPolicy, now: new Date("2026-08-28T04:33:56.000Z") });
  const source = structuredClone(inventory.sources.find(({ id }) => id === "incheon-transit-accessibility"));
  source.requiredForProductionPack = false;
  source.productionUseAllowed = false;
  source.capabilities.facility.productionUseAllowed = false;
  source.admissionEvidence = { quotaEvidence: { defaultDailyLimit: "unlimited", portal: "data.go.kr", productionUseAllowed: true, unlockStatus: "not_required" } };
  const hashFields = ["aliasLedgerHash", "operatorMappingLedgerHash", "facilityEvidenceLedgerHash", "routeEvidenceLedgerHash", "overrideHash"];
  const admitted = inventory.sources.filter(({ admissionEvidence }) => admissionEvidence?.decision === "APPROVED");
  const existing = admitted[0];
  const matching = admitted.filter(({ admissionEvidence }) => hashFields.every((field) => admissionEvidence[field] === existing.admissionEvidence[field])).slice(0, 2);
  if (matching.length !== 2) throw new Error("test requires two shared-ledger admissions");
  inventory.sources = [...matching].filter(({ id }) => id !== source.id);
  policy.sources = policy.sources.filter(({ sourceId }) => inventory.sources.some(({ id }) => id === sourceId));
  inventory.sources.push(source);
  const candidate = candidates.candidates.find(({ id }) => id === source.id);
  if (!candidate) throw new Error("test requires current Incheon candidate");
  policy.sources = policy.sources.filter(({ sourceId }) => sourceId !== source.id);
  const licenseEvidenceHash = sha(JSON.stringify(sortJson(source.license)));
  const first = matching[0];
  const adminReview = {
    schemaVersion: 1, artifactKind: "source-admission-admin-review", candidateId: source.id, sourceId: source.id,
    snapshotId: snapshot.snapshotId, sampleEvidenceHash: snapshot.rowsSha256, decision: "APPROVED", approvedBy: "AquilaXk",
    approvedAt: "2026-08-29T03:41:13.000Z", licenseEvidenceHash,
    aliasLedgerHash: first.admissionEvidence.aliasLedgerHash, operatorMappingLedgerHash: first.admissionEvidence.operatorMappingLedgerHash,
    facilityEvidenceLedgerHash: first.admissionEvidence.facilityEvidenceLedgerHash, routeEvidenceLedgerHash: first.admissionEvidence.routeEvidenceLedgerHash,
    overrideHash: first.admissionEvidence.overrideHash, quotaEvidence: structuredClone(source.admissionEvidence.quotaEvidence), productionSource: structuredClone(source),
  };
  const ownerDecision = {
    schemaVersion: 1, artifactKind: "source-admission-owner-decision", policyVersion: policy.policyVersion, issue: 622,
    candidateId: source.id, sourceId: source.id, snapshotId: snapshot.snapshotId, decision: "APPROVED", approvedBy: "AquilaXk",
    approvedAt: adminReview.approvedAt, productionUseAllowed: true,
    policyEntry: { sourceId: source.id, sourceClassId: "static_accessibility_facility", retentionClassId: "standard-90d", ownerRole: "datapack-source-owner", stewardRole: "datapack-data-steward", approvalRole: "datapack-release-approver", escalationHours: 4, alertRoute: "github:area-datapack", licenseReview: { status: "APPROVED", termsHash: licenseEvidenceHash, reviewedAt: "2026-08-29T03:41:13.000Z", nextReviewAt: "2027-08-29T03:41:13.000Z", termsUrl: source.datasetUrl, reviewedProvider: source.provider, reviewedDatasetUrl: source.datasetUrl, redistributionScopes: ["DERIVED_DATAPACK"], approvedByRole: "datapack-release-approver" } },
  };
  return { ownerDecision, adminReview, snapshot, topologySnapshot, inventory, candidates, policy, freshnessPolicy };
}

test("producer admits a canonical collected snapshot and preserves staged inventory validity", async () => {
  const value = await input();
  const result = produceAdmission(value);
  assert.equal(result.inventory.sources.find(({ id }) => id === value.ownerDecision.sourceId).requiredForProductionPack, false);
  assert.match(result.adminReviewRecordHash, /^[a-f0-9]{64}$/u);
  const candidate = result.candidates.candidates.find(({ id }) => id === value.ownerDecision.candidateId);
  assert.equal("evidenceArtifact" in candidate.evidence, false);
  assert.equal("liveValidation" in candidate.evidence, false);
  assert.equal("coverageAssessment" in candidate.evidence, false);
  assert.equal("nextAction" in candidate, false);
  validateSourceGovernancePolicy({ policy: result.policy, inventory: result.inventory, freshnessPolicy: value.freshnessPolicy });
});

test("producer rejects tampered component, claim, topology, license, freshness, shared hashes, quota and self-hash inputs", async () => {
  const mutations = [
    (x) => { x.snapshot.elevatorRawSha256 = "0".repeat(64); },
    (x) => { x.snapshot.claimBindings[0].stationCode = "wrong"; x.snapshot.claimBindingsSha256 = sha(JSON.stringify(x.snapshot.claimBindings)); },
    (x) => {
      const forged = x.snapshot.claimTopology[0];
      const originalStationId = forged.stationId;
      forged.stationId = "station-forged";
      for (const binding of x.snapshot.claimBindings) {
        if (binding.stationId === originalStationId && binding.sourceLineId === forged.lineId && binding.stationCode === forged.stationCode) {
          binding.stationId = forged.stationId;
        }
      }
      x.snapshot.claimBindingsSha256 = sha(JSON.stringify(x.snapshot.claimBindings));
    },
    (x) => { x.adminReview.licenseEvidenceHash = "0".repeat(64); },
    (x) => { x.ownerDecision.policyEntry.sourceClassId = "static_network_metadata"; },
    (x) => { x.adminReview.aliasLedgerHash = "0".repeat(64); },
    (x) => { for (const source of x.inventory.sources.filter(({ admissionEvidence }) => admissionEvidence?.decision === "APPROVED")) source.admissionEvidence.aliasLedgerHash = null; },
    (x) => { x.adminReview.quotaEvidence.productionUseAllowed = false; },
    (x) => { x.snapshot.rowsSha256 = "0".repeat(64); },
  ];
  for (const mutate of mutations) {
    const value = await input();
    mutate(value);
    assert.throws(() => produceAdmission(value));
  }
});

test("producer CLI rejects unknown or duplicate flags, symlinked parents, and partial outputs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incheon-admission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = await input();
  const values = { "--owner-decision": value.ownerDecision, "--admin-review": value.adminReview, "--snapshot": value.snapshot, "--topology-snapshot": value.topologySnapshot, "--inventory": value.inventory, "--candidates": value.candidates, "--policy": value.policy };
  const args = [];
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
