import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildApplicability } from "./build-current-capital-transfer-topology-applicability.mjs";
import { candidatePinnedReader } from "./test-fixtures/candidate-pinned-inputs.mjs";
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

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// #1038: applicability는 pack과 지표에서 다시 만들 수 있어야 한다. 어떤 pack·지표에서 만들었는지는 applicability가 스스로 선언한다.
// 원천 갱신 PR은 pack만 바꾸므로 applicability가 후보가 고정한 옛 pack·지표를 선언하고, 재결속 PR은 pack·지표·applicability를 함께 새 바이트로
// 다시 쓰므로 작업 트리 바이트를 선언한다(#954: 둘을 섞지 않는다). 선언한 sha와 맞는 바이트를 고르고, 어느 쪽과도 맞지 않으면 실패한다.
async function declaredBytes({ label, relative, readPinned, workingTree, matches }) {
  for (const read of [() => workingTree(relative), () => readPinned(relative)]) {
    const bytes = await read();
    if (matches(bytes)) return bytes;
  }
  throw new assert.AssertionError({ message: `applicability가 선언한 ${label}와 맞는 바이트가 후보 고정 입력에도 작업 트리에도 없다: ${relative}` });
}

test("#1038 applicability가 선언한 바이트는 작업 트리 또는 후보 고정 입력에서 고르고, 어느 쪽과도 맞지 않으면 실패한다", async () => {
  const working = Buffer.from("working");
  const pinned = Buffer.from("pinned");
  const pick = (target, calls = []) => declaredBytes({
    label: "fixture", relative: "x.json",
    readPinned: async () => { calls.push("pinned"); return pinned; },
    workingTree: async () => { calls.push("working"); return working; },
    matches: (bytes) => sha256(bytes) === sha256(target),
  });
  const workingCalls = [];
  assert.deepEqual(await pick(working, workingCalls), working);
  assert.deepEqual(workingCalls, ["working"], "재결속 PR: 작업 트리 바이트가 선언과 맞으면 고정 입력을 받지 않는다");
  const pinnedCalls = [];
  assert.deepEqual(await pick(pinned, pinnedCalls), pinned);
  assert.deepEqual(pinnedCalls, ["working", "pinned"], "원천 갱신 PR: 작업 트리가 다르면 후보 고정 바이트를 쓴다");
  await assert.rejects(pick(Buffer.from("other")), /applicability가 선언한 fixture와 맞는 바이트가 후보 고정 입력에도 작업 트리에도 없다/u);
});

async function activeTransferInputs() {
  const workingTree = (relative) => readFile(new URL(`../../${relative}`, import.meta.url));
  const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
  const readPinned = await candidatePinnedReader();
  const [candidate, inventory, snapshots, applicability] = await Promise.all([
    readJson("./release/candidate-build-spec.json"),
    readJson("./source-inventory.json"),
    readJson("./release/source-snapshots.json"),
    readJson("./release/current-capital-transfer-topology-applicability.json"),
  ]);
  const canonicalPackBytes = await declaredBytes({
    label: "canonical pack sha256", relative: "tools/datapack/release/capital-production-canonical-pack.json", readPinned, workingTree,
    matches: (bytes) => sha256(bytes) === applicability.canonicalIdentity?.canonicalPackSha256,
  });
  const metricsBytes = await declaredBytes({
    label: "transfer topology metrics artifactSha256", relative: "tools/datapack/release/current-transfer-topology-metrics.json", readPinned, workingTree,
    matches: (bytes) => JSON.parse(bytes).artifactSha256 === applicability.transferTopologyMetricsIdentity?.artifactSha256,
  });
  const canonicalPack = JSON.parse(canonicalPackBytes);
  const metrics = JSON.parse(metricsBytes);
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
