import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { buildNationwideRequirementOwnershipLedger } from "./build-nationwide-requirement-ownership-ledger.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const PRODUCTION_SCOPE_PATH = "release/product-gates/production-datapack-scope.json";
const TARGETS_PATH = "tools/datapack/nationwide-coverage-targets.json";
const INPUT_PATHS = Object.freeze({
  targets: TARGETS_PATH,
  tally: "tools/datapack/reports/nationwide-coverage-tally.json",
  ownership: "tools/datapack/release/nationwide-requirement-ownership.json",
  inventory: INVENTORY_PATH,
  sourceSnapshots: "tools/datapack/release/source-snapshots.json",
  fanIn: "tools/datapack/release/current-five-region-source-fan-in.json",
  ownershipLedger: "tools/datapack/reports/nationwide-requirement-ownership-ledger.json",
});

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

function requireSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error(`${label} must be sha256`);
  return value;
}

function requireCandidateFileBinding(candidate, field, path, bytes, label) {
  const binding = candidate?.[field];
  if (binding?.path !== path || requireSha256(binding?.sha256, `${label} sha256`) !== sha256(bytes)) {
    throw new Error(`${label} raw binding mismatch`);
  }
}

function sameRegions(value, expected, label) {
  const regions = uniqueStrings(value?.regionIds, `${label} regions`);
  if (!sameSet(new Set(regions), new Set(expected))) {
    throw new Error(`${label} region set mismatch`);
  }
}

// 후보 생성 전의 release 경계에서만 fan-in, 원본 ledger, scope를 함께 고정한다.
export function validateNationwideCandidateSourceSet({ candidate, inputBytes }) {
  const bytes = inputBytes ?? {};
  const required = ["targets", "tally", "ownership", "inventory", "sourceSnapshots", "fanIn", "ownershipLedger", "productionScope"];
  if (required.some((name) => !Buffer.isBuffer(bytes[name]))) {
    throw new Error("nationwide candidate input bytes are required");
  }
  const inputs = Object.fromEntries(required.map((name) => [name, parseExactBytes(bytes[name], name)]));
  requireCandidateFileBinding(candidate, "productionScope", PRODUCTION_SCOPE_PATH, bytes.productionScope, "production scope");
  requireCandidateFileBinding(candidate, "productionScopePolicy", TARGETS_PATH, bytes.targets, "production scope policy");

  const sourceSet = validateCandidateSourceSet({
    productionScopeBytes: bytes.productionScope,
    sourceInventoryBytes: bytes.inventory,
    candidate,
    ledger: inputs.sourceSnapshots,
  });
  const rebuiltLedger = buildNationwideRequirementOwnershipLedger({
    targets: inputs.targets,
    tally: inputs.tally,
    ownership: inputs.ownership,
    inventory: inputs.inventory,
    sourceSnapshots: inputs.sourceSnapshots,
    fanIn: inputs.fanIn,
    inputBytes: Object.fromEntries(["targets", "tally", "ownership", "inventory", "sourceSnapshots", "fanIn"]
      .map((name) => [name, bytes[name]])),
  });
  if (!isDeepStrictEqual(rebuiltLedger, inputs.ownershipLedger)) {
    throw new Error("nationwide ownership ledger binding mismatch");
  }
  if (rebuiltLedger.summary.nationwideEligibility !== "GO") {
    throw new Error("nationwide ownership ledger must be GO");
  }

  const fanInRegions = inputs.fanIn.scope?.regionIds;
  sameRegions(inputs.productionScope.verifiedAccessibilityScope, fanInRegions, "verified accessibility scope");
  sameRegions(inputs.productionScope.supportScope, fanInRegions, "support scope");
  sameRegions(inputs.productionScope.routingLaunchScope, fanInRegions, "routing launch scope");
  if (inputs.productionScope.nationwideRoadmapScope?.blocksRoutingLaunch !== true
    || inputs.productionScope.nationwideRoadmapScope.launchRequiredCount
      !== rebuiltLedger.summary.launchRequired.totalCount) {
    throw new Error("nationwide roadmap scope binding mismatch");
  }
  if (candidate?.productionScopeId !== inputs.productionScope.routingLaunchScope?.id) {
    throw new Error("candidate production scope ID mismatch");
  }

  const publishedAt = requiredUtcInstant(candidate?.publishedAt, "candidate publishedAt");
  const evaluatedAt = requiredUtcInstant(inputs.fanIn.evaluatedAt, "fan-in evaluatedAt");
  if (publishedAt < evaluatedAt) throw new Error("candidate publishedAt precedes fan-in evaluation");
  const fanInBySource = new Map(inputs.fanIn.selectedSources.map((head) => [head.sourceId, head]));
  if (sourceSet.selected.length !== fanInBySource.size) {
    throw new Error("candidate source head set mismatch");
  }
  for (const projection of candidate.sourceSnapshots) {
    const head = fanInBySource.get(projection.sourceId);
    if (!head || projection.snapshotId !== head.snapshotId
      || projection.rawSha256 !== head.rawSha256
      || projection.freshnessExpiresAt !== head.freshnessExpiresAt) {
      throw new Error("candidate source head binding mismatch");
    }
    if (requiredUtcInstant(head.freshnessExpiresAt, "fan-in head freshness") <= publishedAt) {
      throw new Error("candidate source head freshness expired");
    }
  }
  return {
    sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
    fanInSha256: inputs.fanIn.fanInSha256,
    ownershipLedgerSha256: sha256(bytes.ownershipLedger),
    productionScopeSha256: sha256(bytes.productionScope),
    targetSha256: sha256(bytes.targets),
  };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || !args.includes("--build-spec") || !args.includes("--scope")) {
    throw new Error("candidate source set arguments mismatch");
  }
  const candidatePath = argValue(args, "--build-spec");
  const scopePath = argValue(args, "--scope");
  if (!candidatePath || !scopePath) throw new Error("candidate source set arguments mismatch");
  const records = await Promise.all(Object.entries(INPUT_PATHS).map(async ([name, inputPath]) =>
    [name, await readFile(inputPath)]));
  const inputBytes = Object.fromEntries(records);
  inputBytes.productionScope = await readFile(scopePath);
  const candidate = parseExactBytes(await readFile(candidatePath), "build spec");
  process.stdout.write(`${JSON.stringify(validateNationwideCandidateSourceSet({ candidate, inputBytes }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
