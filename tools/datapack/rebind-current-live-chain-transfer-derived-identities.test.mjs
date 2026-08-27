import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  currentLiveChainTransferOutputPaths,
  currentLiveChainTransferPerSourceEvidence,
  currentReleaseSnapshots,
  assertRebuiltCurrentLiveChainTransferCandidateIdentity,
  assertCurrentLiveChainTransferIdentity,
  commitCurrentLiveChainTransferDerivedIdentityOutputs,
  currentLiveChainTransferStageInputs,
  deriveCurrentOnlyProjection,
} from "./rebind-current-live-chain-transfer-derived-identities.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("candidate-selected versioned ITX topology evidence is the only TRANSFER stage input", () => {
  const path = "tools/datapack/itx-cheongchun-topology-evidence-20260824170958799.json";
  const inputs = currentLiveChainTransferStageInputs({ itxTopologyEvidencePath: path }, ROOT);
  assert.ok(inputs.includes(path));
  assert.equal(inputs.includes("tools/datapack/itx-cheongchun-topology-evidence.json"), false);
  assert.throws(
    () => currentLiveChainTransferStageInputs({ itxTopologyEvidencePath: "../outside.json" }, ROOT),
    /candidate ITX topology evidence path is not versioned exactly/,
  );
});

test("current live-chain TRANSFER producer derives exactly the eight bundle outputs from the selected descriptor", () => {
  assert.deepEqual(currentLiveChainTransferOutputPaths("tools/datapack/sources/seoul-metro-transfer-distance-duration-20991231T235959999Z.json"), [
    "tools/datapack/release/current-transfer-topology-metrics.json",
    "tools/datapack/release/current-capital-transfer-topology-applicability.json",
    "tools/datapack/sources/seoul-metro-transfer-distance-duration-20991231T235959999Z.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/hash-evidence.json",
  ]);
});

test("rebuilt TRANSFER candidate keeps identity and selected IDs while deriving its snapshot-set hash from rebuilt ledger order", () => {
  const previous = { candidateId: "capital-current", sourceSnapshotIds: ["transfer", "first"], sourceSnapshotSetHash: "stale" };
  const snapshots = [{ snapshotId: "first", transferTopology: { revision: 1 } }, { snapshotId: "transfer", transferTopology: { revision: 2 } }];
  const rebuilt = { candidateId: previous.candidateId, sourceSnapshotIds: [...previous.sourceSnapshotIds], sourceSnapshotSetHash: createHash("sha256").update(JSON.stringify(snapshots)).digest("hex") };
  assert.doesNotThrow(() => assertRebuiltCurrentLiveChainTransferCandidateIdentity(previous, rebuilt, snapshots));
  for (const mutate of [
    () => ({ ...rebuilt, candidateId: "other" }),
    () => ({ ...rebuilt, sourceSnapshotIds: ["first", "transfer"] }),
    () => ({ ...rebuilt, sourceSnapshotIds: ["first", "first"] }),
    () => ({ ...rebuilt, sourceSnapshotSetHash: previous.sourceSnapshotSetHash }),
    () => ({ ...rebuilt, sourceSnapshotSetHash: createHash("sha256").update(JSON.stringify([...snapshots].reverse())).digest("hex") }),
  ]) assert.throws(() => assertRebuiltCurrentLiveChainTransferCandidateIdentity(previous, mutate(), snapshots), /rebuilt TRANSFER candidate identity mismatch/);
  assert.throws(() => assertRebuiltCurrentLiveChainTransferCandidateIdentity(previous, rebuilt, [snapshots[0]]), /rebuilt TRANSFER candidate identity mismatch/);
  assert.throws(() => assertRebuiltCurrentLiveChainTransferCandidateIdentity(previous, rebuilt, [...snapshots, { ...snapshots[0] }]), /rebuilt TRANSFER candidate identity mismatch/);
  const unknown = { candidateId: "capital-current", sourceSnapshotIds: ["first", "unknown"], sourceSnapshotSetHash: "stale" };
  assert.throws(() => assertRebuiltCurrentLiveChainTransferCandidateIdentity(unknown, { ...unknown }, snapshots), /rebuilt TRANSFER candidate identity mismatch/);
});

test("current release selection preserves candidate order while exposing rebuilt ledger order solely for the set hash", async () => {
  const [candidate, snapshots] = await Promise.all([
    readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const selected = candidate.sourceSnapshotIds.map((snapshotId) => ({
    ...snapshots.find((snapshot) => snapshot.snapshotId === snapshotId),
    governancePolicyVersion: "test", governancePolicySha256: "a".repeat(64),
  }));
  const reversedLedger = [...selected].reverse();
  const result = currentReleaseSnapshots(candidate, reversedLedger);
  assert.deepEqual(result.orderedRows.map(({ snapshotId }) => snapshotId), candidate.sourceSnapshotIds);
  assert.deepEqual(result.ledgerOrderedRows.map(({ snapshotId }) => snapshotId), reversedLedger.map(({ snapshotId }) => snapshotId));
  const rebuilt = { candidateId: candidate.candidateId, sourceSnapshotIds: result.orderedRows.map(({ snapshotId }) => snapshotId), sourceSnapshotSetHash: createHash("sha256").update(JSON.stringify(result.ledgerOrderedRows)).digest("hex") };
  assert.doesNotThrow(() => assertRebuiltCurrentLiveChainTransferCandidateIdentity(candidate, rebuilt, reversedLedger));
  const evidence = currentLiveChainTransferPerSourceEvidence(result.ledgerOrderedRows, { sources: reversedLedger.map((snapshot) => ({ id: snapshot.sourceId, admissionEvidence: { adminReviewRecordHash: `review-${snapshot.sourceId}` } })) });
  assert.deepEqual(evidence.map(({ snapshotId }) => snapshotId), reversedLedger.map(({ snapshotId }) => snapshotId));
});

test("current live-chain TRANSFER producer has no predecessor or station/transition dependency", async () => {
  const source = await readFile(path.join(ROOT, "tools/datapack/rebind-current-live-chain-transfer-derived-identities.mjs"), "utf8");
  for (const forbidden of [
    "current-station-line-accessibility",
    "current-capital-accessibility-transition",
    "current-capital-accessibility-full",
    "previous/", "stale/", "legacy/", "fallback",
  ]) assert.equal(source.includes(forbidden), false, `forbidden dependency: ${forbidden}`);
});

test("current live-chain TRANSFER identity binds regenerated descriptor bytes and rejects raw, URI, content, or schema drift", async () => {
  const [candidate, inventory, snapshots, descriptor] = await Promise.all([
    readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "tools/datapack/sources/seoul-metro-transfer-distance-duration-20260815T094038817Z.json")),
  ]);
  const descriptorValue = JSON.parse(descriptor);
  const row = snapshots.find(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration");
  const receipt = structuredClone(row.rawReceipt);
  const trackedTransfer = inventory.sources.find(({ id }) => id === "seoul-metro-transfer-distance-duration");
  assert.equal(
    trackedTransfer.transferAdmissionEvidence.snapshotFileSha256,
    createHash("sha256").update(descriptor).digest("hex"),
  );
  assert.doesNotThrow(() => assertCurrentLiveChainTransferIdentity(candidate, inventory, snapshots, descriptorValue, descriptor, receipt));
  for (const mutate of [
    () => { structuredClone(candidate).sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration").rawObjectUri = "oci://changed/object"; },
    () => { structuredClone(inventory).sources.find(({ id }) => id === "seoul-metro-transfer-distance-duration").transferAdmissionEvidence.contentSha256 = "0".repeat(64); },
    () => { structuredClone(inventory).sources.find(({ id }) => id === "seoul-metro-transfer-distance-duration").transferAdmissionEvidence.schemaFingerprint = "1".repeat(64); },
    () => { structuredClone(receipt).rawObjectUri = "oci://changed/object"; },
  ]) {
    const nextCandidate = structuredClone(candidate); const nextInventory = structuredClone(inventory); const nextReceipt = structuredClone(receipt);
    const target = { candidate: nextCandidate, inventory: nextInventory, receipt: nextReceipt };
    const text = mutate.toString();
    if (text.includes("candidate")) target.candidate.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration").rawObjectUri = "oci://changed/object";
    else if (text.includes("contentSha256")) target.inventory.sources.find(({ id }) => id === "seoul-metro-transfer-distance-duration").transferAdmissionEvidence.contentSha256 = "0".repeat(64);
    else if (text.includes("schemaFingerprint")) target.inventory.sources.find(({ id }) => id === "seoul-metro-transfer-distance-duration").transferAdmissionEvidence.schemaFingerprint = "1".repeat(64);
    else target.receipt.rawObjectUri = "oci://changed/object";
    assert.throws(() => assertCurrentLiveChainTransferIdentity(target.candidate, target.inventory, snapshots, descriptorValue, descriptor, target.receipt), /identity is not exact/);
  }
});

test("current-only projections preserve sealed governance without a historical binding", async () => {
  const [candidate, inventory, snapshots, governanceBytes, freshness] = await Promise.all([
    readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "tools/datapack/source-governance-policy.json")),
    readFile(path.join(ROOT, "release/product-gates/datapack-freshness-sla.json"), "utf8").then(JSON.parse),
  ]);
  const governance = JSON.parse(governanceBytes);
  const governancePolicySha256 = createHash("sha256").update(governanceBytes).digest("hex");
  const sealedSnapshots = snapshots.map((snapshot) => ({
    ...snapshot,
    governancePolicyVersion: governance.policyVersion,
    governancePolicySha256,
  }));
  const sealedProjections = candidate.sourceSnapshots.map((projection) => ({
    ...projection,
    governancePolicyVersion: governance.policyVersion,
    governancePolicySha256,
  }));
  for (const expected of sealedProjections) {
    const snapshot = sealedSnapshots.find(({ snapshotId }) => snapshotId === expected.snapshotId);
    assert.deepEqual(deriveCurrentOnlyProjection({ snapshot, inventory, governance, governanceBytes, freshness }), expected);
  }
  const noBinding = structuredClone(sealedSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration"));
  delete noBinding.governancePolicyVersion; delete noBinding.governancePolicySha256;
  assert.throws(() => deriveCurrentOnlyProjection({ snapshot: noBinding, inventory, governance, governanceBytes, freshness }), /unsealed governance binding/);
});

test("current live-chain TRANSFER commit rolls every output back before reporting failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-transfer-test-"));
  try {
    const outputPaths = currentLiveChainTransferOutputPaths("tools/datapack/sources/seoul-metro-transfer-distance-duration-20991231T235959999Z.json");
    const outputs = await Promise.all(outputPaths.map(async (relative, index) => {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      const prestate = Buffer.from(`before-${index}\n`);
      await writeFile(file, prestate);
      return { relative, prestate, bytes: Buffer.from(`after-${index}\n`) };
    }));
    await assert.rejects(
      commitCurrentLiveChainTransferDerivedIdentityOutputs({ repositoryRoot: root, outputs, failAfter: 3 }),
      /injected TRANSFER commit failure/,
    );
    await Promise.all(outputs.map(async ({ relative, prestate }) => {
      assert.deepEqual(await readFile(path.join(root, relative)), prestate);
    }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current live-chain TRANSFER retains recovery journal and lock when rollback fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-live-chain-transfer-recovery-test-"));
  try {
    const outputPaths = currentLiveChainTransferOutputPaths("tools/datapack/sources/seoul-metro-transfer-distance-duration-20991231T235959999Z.json");
    const outputs = await Promise.all(outputPaths.map(async (relative, index) => {
      const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true });
      const prestate = Buffer.from(`before-${index}\n`); await writeFile(file, prestate);
      return { relative, prestate, bytes: Buffer.from(`after-${index}\n`) };
    }));
    await assert.rejects(
      commitCurrentLiveChainTransferDerivedIdentityOutputs({ repositoryRoot: root, outputs, failAfter: 3, failRollbackAt: 2 }),
      /injected TRANSFER rollback failure/,
    );
    assert.equal((await stat(path.join(root, "tools/datapack/.current-live-chain-transfer-derived-identities.json"))).isFile(), true);
    assert.equal((await stat(path.join(root, "tools/datapack/.current-live-chain-transfer-derived-identities.lock"))).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
