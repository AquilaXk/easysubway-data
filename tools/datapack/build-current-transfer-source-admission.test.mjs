import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { main } from "./build-current-transfer-source-admission.mjs";
import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import { assertCurrentLiveChainTransferIdentity } from "./rebind-current-live-chain-transfer-derived-identities.mjs";
import {
  validateProductionTransferArtifacts,
  validateTransferAdmissionEvidence,
} from "./validate-source-inventory.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";

test("retired MOLIT TRANSFER CLI는 staged transition을 입력보다 먼저 차단한다", async () => {
  const source = await readFile(new URL("./build-current-transfer-source-admission.mjs", import.meta.url), "utf8");
  const guard = source.indexOf("await assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: root });");
  const inputRead = source.indexOf("const [\n    candidateBuildSpec, facilityAdmission");
  assert.ok(guard >= 0, "staged transition guard가 필요하다");
  assert.ok(guard < inputRead, "staged transition guard는 retired 입력보다 먼저 실행돼야 한다");
  assert.equal(typeof main, "function");
});

test("active Seoul TRANSFER source handoff는 exact current identity와 production artifact binding을 요구한다", async () => {
  const input = await activeTransferInputs();

  assertCurrentLiveChainTransferIdentity(
    input.candidate,
    input.inventory,
    input.snapshots,
    input.descriptor,
    input.descriptorBytes,
    input.snapshot.rawReceipt,
  );
  assert.doesNotThrow(() => validateTransferAdmissionEvidence(input.source));
  await assert.doesNotReject(validateProductionTransferArtifacts(input.inventory, {
    repositoryRoot: REPOSITORY_ROOT,
  }));

  assert.equal(input.candidate.sourceSnapshots.at(-1).sourceId, TRANSFER_SOURCE_ID);
  assert.equal(input.source.requiredForProductionPack, true);
  assert.equal(input.candidate.sourceSnapshots.some(({ sourceId }) =>
    sourceId === "molit-railway-transfer-movement"), false);
  assert.equal(input.inventory.sources.some(({ id, requiredForProductionPack }) =>
    id === "molit-railway-transfer-movement" && requiredForProductionPack === true), false);
});

test("active Seoul TRANSFER handoff는 projection 또는 OCI receipt drift를 fail closed한다", async () => {
  const input = await activeTransferInputs();
  const projectionDrift = structuredClone(input.candidate);
  projectionDrift.sourceSnapshots.at(-1).rawSha256 = "0".repeat(64);
  assert.throws(() => assertCurrentLiveChainTransferIdentity(
    projectionDrift,
    input.inventory,
    input.snapshots,
    input.descriptor,
    input.descriptorBytes,
    input.snapshot.rawReceipt,
  ), /current TRANSFER source identity is not exact/);

  const receiptDrift = structuredClone(input.snapshot.rawReceipt);
  receiptDrift.snapshotRawSha256 = "0".repeat(64);
  assert.throws(() => assertCurrentLiveChainTransferIdentity(
    input.candidate,
    input.inventory,
    input.snapshots,
    input.descriptor,
    input.descriptorBytes,
    receiptDrift,
  ), /current TRANSFER source identity is not exact/);
});

test("active Seoul TRANSFER metrics와 applicability는 current pre-candidate contract를 재생성한다", async () => {
  const input = await activeTransferInputs();
  const regenerated = buildApplicability({
    canonicalPack: input.canonicalPack,
    canonicalPackBytes: input.canonicalPackBytes,
    transferTopologyMetrics: input.metrics,
    metricsBytes: input.metricsBytes,
  });

  assert.deepEqual(regenerated, input.applicability);
  assert.equal(regenerated.artifactKind, "current-capital-transfer-topology-applicability-pre-candidate");
  assert.equal(regenerated.productionUseAllowed, false);
  assert.equal(regenerated.candidateBinding, null);
  assert.equal(regenerated.cells.length, 213);
  assert.deepEqual(regenerated.stateSummary, {
    APPLICABLE_TRANSFER_ENDPOINT: 27,
    NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 186,
  });
});

async function activeTransferInputs() {
  const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
  const [candidate, inventory, snapshots, canonicalPack, canonicalPackBytes, metrics, metricsBytes, applicability] = await Promise.all([
    readJson("./release/candidate-build-spec.json"),
    readJson("./source-inventory.json"),
    readJson("./release/source-snapshots.json"),
    readJson("./release/capital-production-canonical-pack.json"),
    readFile(new URL("./release/capital-production-canonical-pack.json", import.meta.url)),
    readJson("./release/current-transfer-topology-metrics.json"),
    readFile(new URL("./release/current-transfer-topology-metrics.json", import.meta.url)),
    readJson("./release/current-capital-transfer-topology-applicability.json"),
  ]);
  const projection = candidate.sourceSnapshots?.at(-1);
  const snapshot = snapshots.find(({ snapshotId }) => snapshotId === projection?.snapshotId);
  const source = inventory.sources?.find(({ id }) => id === TRANSFER_SOURCE_ID);
  assert.ok(projection && snapshot && source, "active Seoul TRANSFER handoff is required");
  const descriptorPath = `./sources/${snapshot.snapshotId}.json`;
  const descriptorBytes = await readFile(new URL(descriptorPath, import.meta.url));
  return {
    candidate,
    inventory,
    snapshots,
    canonicalPack,
    canonicalPackBytes,
    metrics,
    metricsBytes,
    applicability,
    source,
    snapshot,
    descriptor: JSON.parse(descriptorBytes),
    descriptorBytes,
  };
}
