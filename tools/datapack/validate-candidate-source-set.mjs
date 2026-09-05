import { createHash } from "node:crypto";

import { validateLineage } from "./source-snapshot-policy.mjs";

const INVENTORY_PATH = "tools/datapack/source-inventory.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseExactBytes(value, label) {
  if (!Buffer.isBuffer(value)) throw new Error(`${label} must be a Buffer`);
  try {
    return JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is required`);
  return value;
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry === "")
    || new Set(value).size !== value.length) {
    throw new Error(`${label} must be nonempty and unique`);
  }
  return value;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function readProductionScopeSourceIds(productionScopeBytes) {
  const productionScope = parseExactBytes(productionScopeBytes, "production scope");
  const sourceSet = productionScope?.productionSourceSet;
  if (sourceSet?.sourceInventory !== INVENTORY_PATH) {
    throw new Error("production source inventory path is invalid");
  }
  return uniqueStrings(sourceSet.requiredSourceIds, "production required source IDs");
}

// 갱신 전후가 공유하는 scope/inventory 계약이다. snapshot 전환 검증을 대신하지 않는다.
export function readProductionSourceSet({ productionScopeBytes, sourceInventoryBytes }) {
  const requiredSourceIds = readProductionScopeSourceIds(productionScopeBytes);
  const sourceInventory = parseExactBytes(sourceInventoryBytes, "source inventory");
  const requiredSourceIdSet = new Set(requiredSourceIds);

  const inventorySources = sourceInventory?.sources;
  if (!Array.isArray(inventorySources) || inventorySources.length === 0) {
    throw new Error("source inventory sources are required");
  }
  const inventoryIds = inventorySources.map((source) => requiredString(source?.id, "source inventory ID"));
  if (new Set(inventoryIds).size !== inventoryIds.length) throw new Error("source inventory IDs must be unique");
  const inventoryRequiredIds = new Set(inventorySources
    .filter((source) => source.requiredForProductionPack === true).map(({ id }) => id));
  if (!sameSet(inventoryRequiredIds, requiredSourceIdSet)) {
    throw new Error("source inventory required source set mismatch");
  }
  return { requiredSourceIds, sourceInventory };
}

// 현재 전체 후보의 source 집합만 검증한다. 갱신 전 predecessor는 별도 전환 계약을 따른다.
// 전체 projection·scope 승인·freshness/license·보호된 전환 검증은 호출부 책임이며,
// 이 검사만 통과했다고 후보를 발행할 수는 없다.
export function validateCandidateSourceSet({ productionScopeBytes, sourceInventoryBytes, candidate, ledger }) {
  const { requiredSourceIds, sourceInventory } = readProductionSourceSet({ productionScopeBytes, sourceInventoryBytes });
  const requiredSourceIdSet = new Set(requiredSourceIds);

  const ids = uniqueStrings(candidate?.sourceSnapshotIds, "candidate source snapshot IDs");
  const projections = candidate?.sourceSnapshots;
  if (!Array.isArray(projections) || projections.length !== ids.length) {
    throw new Error("candidate source snapshot projection mismatch");
  }
  const candidateSourceIds = projections.map((projection, index) => {
    if (!projection || projection.snapshotId !== ids[index]) {
      throw new Error("candidate source snapshot projection position mismatch");
    }
    return requiredString(projection.sourceId, "candidate source ID");
  });
  if (new Set(candidateSourceIds).size !== candidateSourceIds.length
    || !sameSet(new Set(candidateSourceIds), requiredSourceIdSet)) {
    throw new Error("candidate source set mismatch");
  }

  const lineage = validateLineage(ledger);
  const selected = ids.map((snapshotId, index) => {
    const rows = ledger.filter((row) => row.snapshotId === snapshotId);
    if (rows.length !== 1) throw new Error("candidate ledger selection mismatch");
    const row = rows[0];
    if (row.sourceId !== candidateSourceIds[index]) {
      throw new Error("candidate ledger projection position mismatch");
    }
    if (lineage.headsBySource[row.sourceId] !== snapshotId) {
      throw new Error("candidate source is not the active ledger head");
    }
    return row;
  });

  const selectedIds = new Set(ids);
  const selectedInLedgerOrder = ledger.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  if (selectedInLedgerOrder.length !== selected.length
    || candidate.sourceSnapshotSetHash !== sha256(JSON.stringify(selectedInLedgerOrder))) {
    throw new Error("candidate source snapshot set hash mismatch");
  }
  if (candidate.sourceInventorySha256 !== sha256(JSON.stringify(sourceInventory))) {
    throw new Error("candidate source inventory semantic hash mismatch");
  }
  if (candidate?.networkEdgeEvidence?.sourceInventory?.path !== INVENTORY_PATH
    || candidate.networkEdgeEvidence.sourceInventory.sha256 !== sha256(sourceInventoryBytes)) {
    throw new Error("candidate source inventory raw binding mismatch");
  }
  return { selected, requiredSourceIds, headsBySource: lineage.headsBySource };
}
