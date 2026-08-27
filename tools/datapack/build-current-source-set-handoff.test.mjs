import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildCurrentCapitalLiveChainBundle,
  currentCapitalLiveChainOutputPaths,
} from "./build-current-capital-live-chain-bundle.mjs";
import {
  CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS,
  buildCurrentCapitalLiveChainFanInBoundary,
  canonicalCurrentCapitalLiveChainFanInBoundaryJson,
} from "./build-current-capital-live-chain-boundary.mjs";
import {
  buildCurrentCapitalLiveChainOciPlan,
  canonicalCurrentCapitalLiveChainOciPlanJson,
} from "./build-current-capital-live-chain-oci-plan.mjs";
import {
  buildCurrentCapitalLiveChainOciReceipt,
  canonicalCurrentCapitalLiveChainOciReceiptJson,
} from "./build-current-capital-live-chain-oci-receipt.mjs";
import {
  buildCurrentExitAdmissionOciReceipt,
  canonicalCurrentExitAdmissionOciReceiptJson,
} from "./build-current-exit-admission-oci-receipt.mjs";
import {
  buildCurrentSourceSetHandoff,
  readCurrentSourceSetHandoff,
} from "./build-current-source-set-handoff.mjs";
import { canonicalCurrentSourceSetHandoffInput } from "./test-fixtures/current-source-set-handoff.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REPOSITORY = "AquilaXk/easysubway-data";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalObject(value[key])]));
}
function canonical(value) {
  return JSON.stringify(canonicalObject(value));
}
function rehashHandoff(handoff) {
  const { handoffSha256: _handoffSha256, ...payload } = handoff;
  return {
    ...payload,
    handoffSha256: sha256(Buffer.from(canonical(payload))),
  };
}

test("current source-set handoff binds the exact verified live-chain and fails closed on drift", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-source-set-handoff-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const input = await canonicalCurrentSourceSetHandoffInput(temporary);
  const handoffBytes = buildCurrentSourceSetHandoff(input);
  const handoff = readCurrentSourceSetHandoff(handoffBytes, input);

  assert.equal(handoff.schemaVersion, 2);
  assert.equal(handoff.repository, REPOSITORY);
  assert.equal(handoff.producerSha, input.producerSha);
  assert.equal(handoff.sourceRepositorySha, input.sourceRepositorySha);
  assert.equal(handoff.operationId, input.operationId);
  assert.equal(handoff.composite.object.sha256, sha256(input.compositeBytes));
  assert.equal(handoff.fanIn.sha256, sha256(Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson(input.boundary))));
  assert.equal(handoff.fanIn.sourceSetSha256, input.candidate.sourceSnapshotSetHash);
  assert.deepEqual(handoff.candidate.sourceSnapshots, input.candidate.sourceSnapshots.map(({ sourceId, snapshotId }) => ({ sourceId, snapshotId })));
  assert.equal(handoff.evidence.facility.sourceSnapshotSetHash, handoff.candidate.sourceSnapshotSetHash);
  assert.equal(handoff.evidence.exit.sourceSnapshotSetHash, handoff.candidate.sourceSnapshotSetHash);
  assert.deepEqual(handoff.releaseRequest, {
    approvalId: JSON.parse(input.releaseRequestBytes).approvalId,
    candidateId: handoff.candidate.candidateId,
    sha256: sha256(input.releaseRequestBytes),
  });
  const protectedBytes = new Map(handoff.protectedOutputs.map((entry) => [entry.path, Buffer.from(entry.bytesBase64, "base64")]));
  assert.deepEqual([...protectedBytes.keys()].sort(), [
    "tools/datapack/inputs/capital-pilot-production-source-input.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/capital-production-canonical-pack.json",
    "tools/datapack/release/capital-production-reviewed-pack.json",
    "tools/datapack/release/hash-evidence.json",
    "tools/datapack/release/release-request.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-inventory.json",
  ]);
  assert.deepEqual(protectedBytes.get("tools/datapack/inputs/capital-pilot-production-source-input.json"), input.productionInputBytes);
  assert.deepEqual(protectedBytes.get("tools/datapack/release/capital-production-reviewed-pack.json"), input.reviewedPackBytes);
  assert.deepEqual(Buffer.from(handoff.itx.topologyEvidence.bytesBase64, "base64"), input.itxTopologyEvidenceBytes);
  assert.deepEqual(Buffer.from(handoff.itx.coverageContract.bytesBase64, "base64"), input.coverageContractBytes);
  assert.equal(handoff.itx.topologyEvidence.path, input.candidate.itxTopologyEvidencePath);
  assert.equal(handoff.itx.coverageContract.path, input.candidate.networkEdgeEvidence.itxCoverageContract.path);
  assert.deepEqual(Buffer.from(handoff.verifiedInputs.compositeReceipt.bytesBase64, "base64"), input.compositeReceiptBytes);
  assert.deepEqual(Buffer.from(handoff.verifiedInputs.composite.bytesBase64, "base64"), input.compositeBytes);
  assert.equal(handoff.mobile.profile, "mobile-v19");
  assert.equal(handoff.mobile.gzipSha256, sha256(input.mobilePackBytes));
  assert.equal(handoff.mobile.repositoryRevision, JSON.parse(input.ownershipBytes).fixtures.mobile.profileCommit["mobile-v19"]);
  assert.deepEqual(Buffer.from(handoff.mobile.gzip.bytesBase64, "base64"), input.mobilePackBytes);
  assert.deepEqual(Buffer.from(handoff.ownership.bytesBase64, "base64"), input.ownershipBytes);
  assert.equal(input.mobilePackPath, path.join(process.env.EASYSUBWAY_MOBILE_FIXTURE_ROOT ?? path.join(ROOT, ".external/mobile"), "apps/mobile/assets/datapacks/capital.sqlite.gz"));

  const receiptPath = path.join(temporary, "receipt.json");
  const compositePath = path.join(temporary, "composite.json");
  const outputPath = path.join(temporary, "handoff.json");
  await writeFile(receiptPath, input.compositeReceiptBytes);
  await writeFile(compositePath, input.compositeBytes);
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, "tools/datapack/build-current-source-set-handoff.mjs"),
    "--composite-receipt", receiptPath,
    "--composite", compositePath,
    "--release-request", input.releaseRequestPath,
    "--production-input", input.productionInputPath,
    "--reviewed-pack", input.reviewedPackPath,
    "--itx-topology-evidence", input.itxTopologyEvidencePath,
    "--coverage-contract", input.coverageContractPath,
    "--ownership", input.ownershipPath,
    "--mobile-pack", input.mobilePackPath,
    "--mobile-profile", input.mobileProfile,
    "--expected-approval-id", input.expectedApprovalId,
    "--source-repository-sha", input.sourceRepositorySha,
    "--producer-sha", input.producerSha,
    "--operation-id", input.operationId,
    "--output", outputPath,
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(await readFile(outputPath), handoffBytes);

  const drifted = Buffer.from(input.compositeReceiptBytes);
  drifted[drifted.length - 2] ^= 1;
  assert.throws(() => buildCurrentSourceSetHandoff({ ...input, compositeReceiptBytes: drifted }), /receipt/);
  assert.equal((await stat(outputPath)).isFile(), true);
  const rejectedOutput = path.join(temporary, "rejected.json");
  const rejectedReceipt = path.join(temporary, "rejected-receipt.json");
  await writeFile(rejectedReceipt, drifted);
  const rejected = spawnSync(process.execPath, [
    path.join(ROOT, "tools/datapack/build-current-source-set-handoff.mjs"),
    "--composite-receipt", rejectedReceipt,
    "--composite", compositePath,
    "--release-request", input.releaseRequestPath,
    "--production-input", input.productionInputPath,
    "--reviewed-pack", input.reviewedPackPath,
    "--itx-topology-evidence", input.itxTopologyEvidencePath,
    "--coverage-contract", input.coverageContractPath,
    "--ownership", input.ownershipPath,
    "--mobile-pack", input.mobilePackPath,
    "--mobile-profile", input.mobileProfile,
    "--expected-approval-id", input.expectedApprovalId,
    "--source-repository-sha", input.sourceRepositorySha,
    "--producer-sha", input.producerSha,
    "--operation-id", input.operationId,
    "--output", rejectedOutput,
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  await assert.rejects(stat(rejectedOutput), { code: "ENOENT" });

  for (const [label, fileName, mutate] of [
    ["candidate ID", "candidate-id", (request) => { request.candidateId = "different-candidate"; }],
    ["source-set hash", "source-set-hash", (request) => { request.sourceSnapshotSetHash = "0".repeat(64); }],
    ["build-spec SHA", "build-spec-sha", (request) => { request.buildSpecSha256 = "0".repeat(64); }],
    ["approved ledger hash", "approved-ledger-hash", (request) => { request.approvedLedgerHash = "0".repeat(64); }],
  ]) {
    const releaseRequest = JSON.parse(input.releaseRequestBytes);
    mutate(releaseRequest);
    const driftedReleaseRequestBytes = Buffer.from(JSON.stringify(releaseRequest));
    assert.throws(
      () => buildCurrentSourceSetHandoff({ ...input, releaseRequestBytes: driftedReleaseRequestBytes }),
      /release request bytes mismatch/,
      label,
    );
    const driftedRequestPath = path.join(temporary, `${fileName}.json`);
    const driftedOutputPath = path.join(temporary, `${fileName}-handoff.json`);
    await writeFile(driftedRequestPath, driftedReleaseRequestBytes);
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "tools/datapack/build-current-source-set-handoff.mjs"),
      "--composite-receipt", receiptPath,
      "--composite", compositePath,
      "--release-request", driftedRequestPath,
      "--production-input", input.productionInputPath,
      "--reviewed-pack", input.reviewedPackPath,
      "--itx-topology-evidence", input.itxTopologyEvidencePath,
      "--coverage-contract", input.coverageContractPath,
      "--ownership", input.ownershipPath,
      "--mobile-pack", input.mobilePackPath,
      "--mobile-profile", input.mobileProfile,
      "--expected-approval-id", input.expectedApprovalId,
      "--source-repository-sha", input.sourceRepositorySha,
      "--producer-sha", input.producerSha,
      "--operation-id", input.operationId,
      "--output", driftedOutputPath,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0, label);
    await assert.rejects(stat(driftedOutputPath), { code: "ENOENT" }, label);
  }

  const wrongApprovalOutputPath = path.join(temporary, "wrong-approval-handoff.json");
  assert.throws(
    () => buildCurrentSourceSetHandoff({ ...input, expectedApprovalId: "release-request-other" }),
    /release request binding mismatch/,
  );
  const wrongApproval = spawnSync(process.execPath, [
    path.join(ROOT, "tools/datapack/build-current-source-set-handoff.mjs"),
    "--composite-receipt", receiptPath,
    "--composite", compositePath,
    "--release-request", input.releaseRequestPath,
    "--production-input", input.productionInputPath,
    "--reviewed-pack", input.reviewedPackPath,
    "--itx-topology-evidence", input.itxTopologyEvidencePath,
    "--coverage-contract", input.coverageContractPath,
    "--ownership", input.ownershipPath,
    "--mobile-pack", input.mobilePackPath,
    "--mobile-profile", input.mobileProfile,
    "--expected-approval-id", "release-request-other",
    "--source-repository-sha", input.sourceRepositorySha,
    "--producer-sha", input.producerSha,
    "--operation-id", input.operationId,
    "--output", wrongApprovalOutputPath,
  ], { encoding: "utf8" });
  assert.notEqual(wrongApproval.status, 0);
  await assert.rejects(stat(wrongApprovalOutputPath), { code: "ENOENT" });

  const scopeDrift = JSON.parse(input.releaseRequestBytes);
  scopeDrift.scopeId = "different-scope";
  const scopeDriftBytes = Buffer.from(JSON.stringify(scopeDrift));
  assert.throws(
    () => buildCurrentSourceSetHandoff({ ...input, releaseRequestBytes: scopeDriftBytes }),
    /release request bytes mismatch/,
  );
  const scopeDriftPath = path.join(temporary, "scope-drift.json");
  const scopeDriftOutputPath = path.join(temporary, "scope-drift-handoff.json");
  await writeFile(scopeDriftPath, scopeDriftBytes);
  const scopeDriftResult = spawnSync(process.execPath, [
    path.join(ROOT, "tools/datapack/build-current-source-set-handoff.mjs"),
    "--composite-receipt", receiptPath,
    "--composite", compositePath,
    "--release-request", scopeDriftPath,
    "--production-input", input.productionInputPath,
    "--reviewed-pack", input.reviewedPackPath,
    "--itx-topology-evidence", input.itxTopologyEvidencePath,
    "--coverage-contract", input.coverageContractPath,
    "--ownership", input.ownershipPath,
    "--mobile-pack", input.mobilePackPath,
    "--mobile-profile", input.mobileProfile,
    "--expected-approval-id", input.expectedApprovalId,
    "--source-repository-sha", input.sourceRepositorySha,
    "--producer-sha", input.producerSha,
    "--operation-id", input.operationId,
    "--output", scopeDriftOutputPath,
  ], { encoding: "utf8" });
  assert.notEqual(scopeDriftResult.status, 0);
  await assert.rejects(stat(scopeDriftOutputPath), { code: "ENOENT" });

  const tamperedFanIn = rehashHandoff({
    ...handoff,
    fanIn: { ...handoff.fanIn, sha256: "0".repeat(64) },
  });
  assert.throws(
    () => readCurrentSourceSetHandoff(Buffer.from(`${canonical(tamperedFanIn)}\n`), input),
    /fan-in/,
  );

  const tamperedProjection = rehashHandoff({
    ...handoff,
    composite: { ...handoff.composite, planSha256: "0".repeat(64) },
  });
  assert.throws(
    () => readCurrentSourceSetHandoff(Buffer.from(`${canonical(tamperedProjection)}\n`), input),
    /embedded composite projection mismatch/,
  );

  const tamperedProtected = rehashHandoff({
    ...handoff,
    protectedOutputs: handoff.protectedOutputs.map((entry) => entry.path === "tools/datapack/release/hash-evidence.json"
      ? { ...entry, sha256: "0".repeat(64) } : entry),
  });
  assert.throws(
    () => readCurrentSourceSetHandoff(Buffer.from(`${canonical(tamperedProtected)}\n`), input),
    /protected hash-evidence entry mismatch/,
  );
  const tamperedItxPath = rehashHandoff({
    ...handoff,
    itx: { ...handoff.itx, topologyEvidence: { ...handoff.itx.topologyEvidence, path: "tools/datapack/itx-cheongchun-topology-evidence.json" } },
  });
  assert.throws(
    () => readCurrentSourceSetHandoff(Buffer.from(`${canonical(tamperedItxPath)}\n`), input),
    /ITX handoff identity mismatch/,
  );

  for (const [label, key, inputKey, protectedPath] of [
    ["production input", "productionInputBytes", "productionInputBytes", "tools/datapack/inputs/capital-pilot-production-source-input.json"],
    ["reviewed pack", "reviewedPackBytes", "reviewedPackBytes", "tools/datapack/release/capital-production-reviewed-pack.json"],
    ["ownership", "ownershipBytes", "ownershipBytes", "tools/ci/data-test-ownership.json"],
  ]) {
    const driftedBytes = Buffer.from(input[inputKey]);
    driftedBytes[0] ^= 1;
    assert.throws(
      () => buildCurrentSourceSetHandoff({ ...input, [key]: driftedBytes }),
      /retained source input identity mismatch/,
      label,
    );
    const tamperedRetained = rehashHandoff({
      ...handoff,
      ...(protectedPath === "tools/ci/data-test-ownership.json" ? {
        ownership: { ...handoff.ownership, bytesBase64: driftedBytes.toString("base64"), sha256: sha256(driftedBytes) },
      } : {
        protectedOutputs: handoff.protectedOutputs.map((entry) => entry.path === protectedPath
          ? { ...entry, bytesBase64: driftedBytes.toString("base64"), sha256: sha256(driftedBytes) } : entry),
      }),
    });
    assert.throws(
      () => readCurrentSourceSetHandoff(Buffer.from(`${canonical(tamperedRetained)}\n`), input),
      /retained source input identity mismatch/,
      label,
    );
  }

});
