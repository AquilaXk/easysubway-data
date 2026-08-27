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
import { buildCanonicalCurrentKricExitCollectionBundle } from "./test-fixtures/current-live-chain-artifacts.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REPOSITORY = "AquilaXk/easysubway-data";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function canonicalInputFixture(root) {
  const repositorySha = "d".repeat(40);
  const producerSha = "e".repeat(40);
  const operationId = "current-source-set-28";
  const provider = await buildCanonicalCurrentKricExitCollectionBundle({ repositorySha, operationId });
  const providerSha256 = sha256(provider.bytes);
  const day = provider.snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const providerObjectKey = `operations/current-capital-live-chain/v1/heads/${repositorySha}/operations/${operationId}/provider-collections/${day}-${providerSha256}.json`;
  const candidatePath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.candidateBuildSpec;
  const facilityPath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.facilityAdmission;
  const normalizedPath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitNormalized;
  const admissionPath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitAdmission;
  const exitReceiptPath = CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS.exitAdmissionOciReceipt;
  const [candidateBytes, facilityInputBytes, normalizedBytes, admissionInputBytes] = await Promise.all([
    readFile(path.join(ROOT, candidatePath)),
    readFile(path.join(ROOT, facilityPath)),
    readFile(path.join(ROOT, normalizedPath)),
    readFile(path.join(ROOT, admissionPath)),
  ]);
  const candidateValue = JSON.parse(candidateBytes);
  const facilityValue = JSON.parse(facilityInputBytes);
  facilityValue.candidate = { candidateId: candidateValue.candidateId, sourceSnapshotSetHash: candidateValue.sourceSnapshotSetHash };
  const admissionValue = JSON.parse(admissionInputBytes);
  admissionValue.candidate.candidateId = candidateValue.candidateId;
  admissionValue.candidate.sourceSetSha256 = candidateValue.sourceSnapshotSetHash;
  const facilityBytes = Buffer.from(`${JSON.stringify(facilityValue)}\n`);
  const admissionBytes = Buffer.from(`${JSON.stringify(admissionValue)}\n`);
  const exitReceipt = buildCurrentExitAdmissionOciReceipt({
    repository: REPOSITORY,
    mainSha: repositorySha,
    operationId,
    providerCapturedAt: provider.snapshot.capturedAt,
    providerCollectionBundleBytes: provider.bytes,
    providerObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${providerObjectKey}`,
    providerObjectSha256: providerSha256,
    providerObjectByteSize: provider.bytes.length,
    normalizedBytes,
    admissionBytes,
  });
  const exitReceiptBytes = Buffer.from(`${canonicalCurrentExitAdmissionOciReceiptJson(exitReceipt)}\n`);
  const overrides = new Map([[facilityPath, facilityBytes], [admissionPath, admissionBytes], [exitReceiptPath, exitReceiptBytes]]);
  const componentBytes = {};
  for (const [name, relative] of Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS)) {
    componentBytes[name] = overrides.get(relative) ?? await readFile(path.join(ROOT, relative));
  }
  const components = Object.fromEntries(Object.entries(componentBytes).map(([name, bytes]) => [name, {
    bytes,
    value: JSON.parse(bytes.toString("utf8")),
  }]));
  const boundary = buildCurrentCapitalLiveChainFanInBoundary(components);
  const boundaryBytes = Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson(boundary));

  const candidate = components.candidateBuildSpec.value;
  const sourceInventory = components.sourceInventory.value;
  const sourceSnapshotLedger = components.sourceSnapshotLedger.value;
  const outputDirectory = path.join(root, "out");
  const outputPaths = currentCapitalLiveChainOutputPaths({ candidate, sourceInventory, sourceSnapshotLedger });
  for (const relative of outputPaths) {
    const target = path.join(outputDirectory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    if (overrides.has(relative)) await writeFile(target, overrides.get(relative));
    else await cp(path.join(ROOT, relative), target);
  }
  const compositeBytes = await buildCurrentCapitalLiveChainBundle({
    root,
    outputDirectory,
    repository: REPOSITORY,
    repositorySha,
    operationId,
    boundaryBytes,
  });
  const plan = buildCurrentCapitalLiveChainOciPlan({
    mainSha: repositorySha,
    operationId,
    providerCollectionBundleBytes: provider.bytes,
    providerCapturedAt: provider.snapshot.capturedAt,
    compositeBundleBytes: compositeBytes,
  });
  const planBytes = Buffer.from(`${canonicalCurrentCapitalLiveChainOciPlanJson(plan)}\n`);
  const receipt = buildCurrentCapitalLiveChainOciReceipt({ planBytes });
  const compositeReceiptBytes = Buffer.from(`${canonicalCurrentCapitalLiveChainOciReceiptJson(receipt, { planBytes })}\n`);
  return { boundary, candidate, compositeBytes, compositeReceiptBytes, operationId, producerSha, sourceRepositorySha: repositorySha };
}

test("current source-set handoff binds the exact verified live-chain and fails closed on drift", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "current-source-set-handoff-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const input = await canonicalInputFixture(temporary);
  const handoffBytes = buildCurrentSourceSetHandoff(input);
  const handoff = readCurrentSourceSetHandoff(handoffBytes, input);

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

  const receiptPath = path.join(temporary, "receipt.json");
  const compositePath = path.join(temporary, "composite.json");
  const outputPath = path.join(temporary, "handoff.json");
  await writeFile(receiptPath, input.compositeReceiptBytes);
  await writeFile(compositePath, input.compositeBytes);
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, "tools/datapack/build-current-source-set-handoff.mjs"),
    "--composite-receipt", receiptPath,
    "--composite", compositePath,
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
    "--source-repository-sha", input.sourceRepositorySha,
    "--producer-sha", input.producerSha,
    "--operation-id", input.operationId,
    "--output", rejectedOutput,
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  await assert.rejects(stat(rejectedOutput), { code: "ENOENT" });
});
