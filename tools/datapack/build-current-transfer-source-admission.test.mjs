import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import {
  validateProductionTransferArtifacts,
  validateTransferAdmissionEvidence,
} from "./validate-source-inventory.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TRANSFER_SOURCE_ID = "seoul-metro-transfer-distance-duration";

test("active Seoul TRANSFER source handoff는 exact current identity와 production artifact binding을 요구한다", async () => {
  const input = await activeTransferInputs();

  assert.doesNotThrow(() => validateTransferAdmissionEvidence(input.source));
  await assert.doesNotReject(validateProductionTransferArtifacts(input.inventory, {
    repositoryRoot: REPOSITORY_ROOT,
  }));

  assert.equal(input.candidate.sourceSnapshots.find(({ sourceId }) => sourceId === TRANSFER_SOURCE_ID)?.sourceId, TRANSFER_SOURCE_ID);
  assert.equal(input.source.requiredForProductionPack, true);
  assert.equal(input.candidate.sourceSnapshots.some(({ sourceId }) =>
    sourceId === "molit-railway-transfer-movement"), false);
  assert.equal(input.inventory.sources.some(({ id, requiredForProductionPack }) =>
    id === "molit-railway-transfer-movement" && requiredForProductionPack === true), false);
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
  // #872 S2: 분모는 서울교통공사 1~8호선과 상대 노선 19개의 역-노선 전체다.
  assert.equal(regenerated.cells.length, 698);
  assert.deepEqual(regenerated.stateSummary, {
    APPLICABLE_TRANSFER_ENDPOINT: 160,
    NOT_APPLICABLE_IN_CANONICAL_PAIR_SET: 538,
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
  const projection = candidate.sourceSnapshots?.find(({ sourceId }) => sourceId === TRANSFER_SOURCE_ID);
  const snapshot = snapshots.find(({ snapshotId }) => snapshotId === projection?.snapshotId);
  const source = inventory.sources?.find(({ id }) => id === TRANSFER_SOURCE_ID);
  assert.ok(projection && snapshot && source, "active Seoul TRANSFER handoff is required");
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
  };
}
