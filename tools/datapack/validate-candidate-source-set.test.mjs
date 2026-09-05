import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { readProductionSourceSet, validateCandidateSourceSet } from "./validate-candidate-source-set.mjs";

const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");

function snapshot(sourceId, snapshotId, retrievedAt) {
  return {
    sourceId, snapshotId, retrievedAt, sourceUpdatedAt: null, rowCount: 1, coverageCount: 1,
    rawSha256: sha(`${snapshotId}:raw`), schemaFingerprint: sha(`${snapshotId}:schema`),
    redactedRequestFingerprint: sha(`${snapshotId}:request`),
  };
}

function fixture({ scopeIds = ["alpha", "beta"], candidateIds = ["beta", "alpha"] } = {}) {
  const inventory = { sources: [
    ...scopeIds.map((id) => ({ id, requiredForProductionPack: true })),
    { id: "optional", requiredForProductionPack: false },
  ] };
  const ledger = [
    snapshot("alpha", "alpha-head", "2026-01-01T00:00:00.000Z"),
    snapshot("beta", "beta-head", "2026-01-02T00:00:00.000Z"),
  ];
  if (scopeIds.includes("gamma")) ledger.push(snapshot("gamma", "gamma-head", "2026-01-03T00:00:00.000Z"));
  const bySource = new Map(ledger.map((row) => [row.sourceId, row]));
  const selected = candidateIds.map((id) => bySource.get(id));
  const inventoryBytes = Buffer.from(JSON.stringify(inventory));
  const candidate = {
    sourceSnapshotIds: selected.map(({ snapshotId }) => snapshotId),
    sourceSnapshots: selected.map(({ sourceId, snapshotId }) => ({ sourceId, snapshotId })),
    sourceSnapshotSetHash: sha(JSON.stringify(ledger.filter(({ snapshotId }) =>
      selected.some((row) => row.snapshotId === snapshotId)))),
    sourceInventorySha256: sha(JSON.stringify(inventory)),
    networkEdgeEvidence: { sourceInventory: { path: INVENTORY_PATH, sha256: sha(inventoryBytes) } },
  };
  return {
    productionScopeBytes: Buffer.from(JSON.stringify({ productionSourceSet: {
      sourceInventory: INVENTORY_PATH, requiredSourceIds: scopeIds,
    } })),
    sourceInventoryBytes: inventoryBytes, candidate, ledger,
  };
}

test("scope/candidate order가 달라도 exact source set과 ledger order를 검증한다", () => {
  const input = fixture();
  const result = validateCandidateSourceSet(input);
  assert.deepEqual(result.requiredSourceIds, ["alpha", "beta"]);
  assert.deepEqual(result.selected.map(({ sourceId }) => sourceId), ["beta", "alpha"]);
  assert.deepEqual(result.headsBySource, { alpha: "alpha-head", beta: "beta-head" });
});

test("갱신 전 scope reader는 snapshot 상태를 선택하거나 전진시키지 않는다", () => {
  const input = fixture({ scopeIds: ["alpha", "beta", "gamma"] });
  const before = JSON.stringify(input);
  const result = readProductionSourceSet(input);
  assert.deepEqual(result.requiredSourceIds, ["alpha", "beta", "gamma"]);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => readProductionSourceSet({ ...input, productionScopeBytes: undefined }), /production scope/);
});

test("coherent added source는 scope, inventory, candidate가 함께 확장되면 통과한다", () => {
  const input = fixture({ scopeIds: ["alpha", "beta", "gamma"], candidateIds: ["gamma", "alpha", "beta"] });
  assert.deepEqual(validateCandidateSourceSet(input).selected.map(({ sourceId }) => sourceId), ["gamma", "alpha", "beta"]);
});

test("expanded scope/inventory에 restamp되지 않은 candidate는 거부한다", () => {
  const input = fixture();
  const expanded = fixture({ scopeIds: ["alpha", "beta", "gamma"], candidateIds: ["alpha", "beta", "gamma"] });
  assert.throws(() => validateCandidateSourceSet({ ...input, productionScopeBytes: expanded.productionScopeBytes, sourceInventoryBytes: expanded.sourceInventoryBytes }), /source set|inventory/i);
});

test("missing, extra, duplicate selection과 positional drift를 거부한다", () => {
  const cases = [
    (input) => input.candidate.sourceSnapshotIds.pop(),
    (input) => input.candidate.sourceSnapshots.push({ sourceId: "optional", snapshotId: "optional-head" }),
    (input) => { input.candidate.sourceSnapshotIds[1] = input.candidate.sourceSnapshotIds[0]; },
    (input) => { input.candidate.sourceSnapshots.reverse(); },
  ];
  for (const mutate of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => validateCandidateSourceSet(input));
  }
});

test("정합적인 projection 모양이라도 scope 밖 source와 누락 source를 거부한다", () => {
  const missing = fixture({ candidateIds: ["alpha"] });
  assert.throws(() => validateCandidateSourceSet(missing), /candidate source set mismatch/);
  const extra = fixture({ scopeIds: ["alpha", "beta", "gamma"], candidateIds: ["alpha", "beta", "gamma"] });
  const original = fixture();
  extra.productionScopeBytes = original.productionScopeBytes;
  extra.sourceInventoryBytes = original.sourceInventoryBytes;
  assert.throws(() => validateCandidateSourceSet(extra), /candidate source set mismatch/);
});

test("scope와 inventory의 중복 또는 서로 다른 required 집합을 거부한다", () => {
  const duplicateScope = fixture();
  const scope = JSON.parse(duplicateScope.productionScopeBytes);
  scope.productionSourceSet.requiredSourceIds.push("alpha");
  duplicateScope.productionScopeBytes = Buffer.from(JSON.stringify(scope));
  assert.throws(() => validateCandidateSourceSet(duplicateScope), /required source IDs must be nonempty and unique/);
  const duplicateInventory = fixture();
  const inventory = JSON.parse(duplicateInventory.sourceInventoryBytes);
  inventory.sources.push({ ...inventory.sources[0] });
  duplicateInventory.sourceInventoryBytes = Buffer.from(JSON.stringify(inventory));
  assert.throws(() => validateCandidateSourceSet(duplicateInventory), /inventory IDs must be unique/);
  const drift = fixture();
  drift.productionScopeBytes = fixture({ scopeIds: ["alpha", "beta", "gamma"] }).productionScopeBytes;
  assert.throws(() => validateCandidateSourceSet(drift), /inventory required source set mismatch/);
});

test("raw/semantic inventory hash, ledger hash, non-head selection을 거부한다", () => {
  for (const [mutate, expected] of [
    [(input) => { input.candidate.networkEdgeEvidence.sourceInventory.sha256 = "0".repeat(64); }, /raw binding mismatch/],
    [(input) => { input.candidate.sourceInventorySha256 = "0".repeat(64); }, /semantic hash mismatch/],
    [(input) => { input.candidate.sourceSnapshotSetHash = "0".repeat(64); }, /snapshot set hash mismatch/],
    [(input) => {
      const old = input.ledger[0];
      const successor = { ...old, snapshotId: "alpha-new-head", retrievedAt: "2026-02-01T00:00:00.000Z", previousSnapshotId: old.snapshotId };
      successor.diffSummary = {
        status: "NO_CHANGE", rawHashChanged: false, schemaHashChanged: false,
        requestHashChanged: false, sourceUpdatedAtChanged: false, rowDelta: 0, coverageDelta: 0,
      };
      input.ledger.push(successor);
    }, /not the active ledger head/],
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => validateCandidateSourceSet(input), expected);
  }
});
