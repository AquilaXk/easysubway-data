#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_FIVE_REGION_SOURCE_FAN_IN_PATH =
  "tools/datapack/release/current-five-region-source-fan-in.json";

const INPUT_PATHS = Object.freeze({
  targets: "tools/datapack/nationwide-coverage-targets.json",
  tally: "tools/datapack/reports/nationwide-coverage-tally.json",
  ownership: "tools/datapack/release/nationwide-requirement-ownership.json",
  inventory: "tools/datapack/source-inventory.json",
  sourceSnapshots: "tools/datapack/release/source-snapshots.json",
});
const SHA256 = /^[a-f0-9]{64}$/u;

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compare)
    .map((key) => [key, canonicalObject(value[key])]));
}

function canonical(value) {
  return JSON.stringify(canonicalObject(value));
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} mismatch`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} mismatch`);
  return value;
}

function instant(value, label) {
  const milliseconds = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value) throw new Error(`${label} mismatch`);
  return milliseconds;
}

function parseInput(name, suppliedValue, inputBytes) {
  const bytes = Buffer.isBuffer(inputBytes?.[name])
    ? inputBytes[name]
    : typeof inputBytes?.[name] === "string" ? Buffer.from(inputBytes[name]) : null;
  if (!bytes || bytes.length === 0) throw new Error(`${name} input bytes mismatch`);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${name} input JSON mismatch`); }
  if (canonical(parsed) !== canonical(suppliedValue)) throw new Error(`${name} input bytes mismatch`);
  return { bytes, value: parsed };
}

function pk(row) {
  return [row.regionId, row.operatorId, row.lineId, row.sourceDomain].join(":");
}

function requiredRows(targets, tally) {
  if (!Array.isArray(targets.activeLineScopes) || targets.activeLineScopes.length === 0
    || !Array.isArray(targets.requiredSourceDomains) || targets.requiredSourceDomains.length === 0
    || !Array.isArray(tally.launchRequired?.requirements)
    || !Array.isArray(tally.enhancement?.requirements)) {
    throw new Error("five-region target or tally shape mismatch");
  }
  const domainTier = new Map(targets.requiredSourceDomains.map((domain) => [domain.id, domain.releaseTier]));
  if (domainTier.size !== targets.requiredSourceDomains.length) throw new Error("target source domain mismatch");
  const expected = new Set(targets.activeLineScopes.flatMap((scope) => targets.requiredSourceDomains
    .map((domain) => [scope.regionId, scope.operatorId, scope.lineId, domain.id].join(":"))));
  const rows = [...tally.launchRequired.requirements, ...tally.enhancement.requirements];
  const actual = new Set();
  for (const row of rows) {
    const key = pk(row);
    if (!expected.has(key) || actual.has(key) || domainTier.get(row.sourceDomain) !== row.releaseTier) {
      throw new Error("five-region tally PK mismatch");
    }
    actual.add(key);
  }
  if (actual.size !== expected.size) throw new Error("five-region tally PK mismatch");
  return rows;
}

function admittedEvidence(source) {
  return Object.entries(source).filter(([key, value]) =>
    (key === "admissionEvidence" || key.endsWith("AdmissionEvidence"))
    && value && typeof value === "object" && !Array.isArray(value));
}

function terminalHead(sourceId, sourceSnapshots) {
  const snapshots = sourceSnapshots.filter((snapshot) => snapshot?.sourceId === sourceId);
  if (snapshots.length === 0) throw new Error(`terminal snapshot head missing for ${sourceId}`);
  const byId = new Map();
  for (const snapshot of snapshots) {
    const snapshotId = string(snapshot.snapshotId, "snapshot ID");
    if (byId.has(snapshotId)) throw new Error(`terminal snapshot head mismatch for ${sourceId}`);
    byId.set(snapshotId, snapshot);
  }
  for (const snapshot of snapshots) {
    if (snapshot.previousSnapshotId !== null
      && (typeof snapshot.previousSnapshotId !== "string" || !byId.has(snapshot.previousSnapshotId))) {
      throw new Error(`snapshot lineage mismatch for ${sourceId}`);
    }
    const visited = new Set();
    let cursor = snapshot;
    while (cursor.previousSnapshotId !== null) {
      if (visited.has(cursor.snapshotId)) throw new Error(`snapshot lineage mismatch for ${sourceId}`);
      visited.add(cursor.snapshotId);
      cursor = byId.get(cursor.previousSnapshotId);
    }
  }
  const predecessors = new Set(snapshots.map(({ previousSnapshotId }) => previousSnapshotId).filter(Boolean));
  const heads = snapshots.filter(({ snapshotId }) => !predecessors.has(snapshotId));
  if (heads.length !== 1) throw new Error(`terminal snapshot head mismatch for ${sourceId}`);
  return heads[0];
}

function selectedSources(rows, inventory, sourceSnapshots, evaluatedAt) {
  if (!Array.isArray(inventory.sources) || !Array.isArray(sourceSnapshots)) {
    throw new Error("source inventory or snapshot ledger mismatch");
  }
  const inventoryById = new Map();
  for (const source of inventory.sources) {
    if (typeof source?.id !== "string" || source.id.length === 0 || inventoryById.has(source.id)) {
      throw new Error("source inventory identity mismatch");
    }
    inventoryById.set(source.id, source);
  }
  const admittedIds = new Set();
  for (const row of rows) {
    const ids = row.admittedSourceIds ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0)
      || (row.status === "INVENTORY_ADMITTED" && ids.length === 0)
      || (row.status !== "INVENTORY_ADMITTED" && ids.length !== 0)) {
      throw new Error(`admitted source binding mismatch for ${pk(row)}`);
    }
    ids.forEach((id) => admittedIds.add(id));
  }
  return [...admittedIds].sort(compare).map((sourceId) => {
    const source = inventoryById.get(sourceId);
    if (!source) throw new Error(`inventory source missing for ${sourceId}`);
    if (source.productionUseAllowed !== true || typeof source.provider !== "string" || source.provider.length === 0
      || (!source.license && !source.licenseReview)
      || !admittedEvidence(source).some(([, evidence]) => evidence.decision === "APPROVED")) {
      throw new Error(`inventory source admission mismatch for ${sourceId}`);
    }
    const snapshot = terminalHead(sourceId, sourceSnapshots);
    if (snapshot.provider !== source.provider || !SHA256.test(snapshot.rawSha256 ?? "")
      || typeof snapshot.rawObjectUri !== "string" || !snapshot.rawObjectUri.startsWith("oci://")
      || snapshot.snapshotStatus !== "LOCKED" || snapshot.schemaStatus !== "PASS"
      || snapshot.licenseStatus !== "PASS" || snapshot.fetchStatus !== "SUCCESS"
      || snapshot.redistributionAllowed !== true) {
      throw new Error(`immutable OCI snapshot mismatch for ${sourceId}`);
    }
    if (instant(snapshot.freshnessExpiresAt, "snapshot freshness") <= evaluatedAt) {
      throw new Error(`snapshot freshness mismatch for ${sourceId}`);
    }
    return {
      sourceId,
      provider: source.provider,
      snapshotId: snapshot.snapshotId,
      rawSha256: snapshot.rawSha256,
      rawObjectUri: snapshot.rawObjectUri,
      freshnessExpiresAt: snapshot.freshnessExpiresAt,
      inventoryRecordSha256: sha256(Buffer.from(canonical(source))),
      snapshotRecordSha256: sha256(Buffer.from(canonical(snapshot))),
    };
  });
}

export function canonicalCurrentFiveRegionSourceFanInJson(value) {
  return canonical(value);
}

export function buildCurrentFiveRegionSourceFanIn(input = {}) {
  const records = Object.fromEntries(Object.keys(INPUT_PATHS).map((name) => [
    name,
    parseInput(name, input[name], input.inputBytes),
  ]));
  const values = Object.fromEntries(Object.entries(records).map(([name, record]) => [name, record.value]));
  const { targets, tally, ownership, inventory, sourceSnapshots } = values;
  const targetVersion = string(targets.targetVersion, "target version");
  if (tally.targetVersion !== targetVersion || ownership.targetVersion !== targetVersion) {
    throw new Error("target version mismatch");
  }
  const evaluatedAt = instant(input.evaluatedAt, "fan-in evaluation instant");
  const rows = requiredRows(targets, tally);
  const regionIds = [...new Set(targets.activeLineScopes.map(({ regionId }) => string(regionId, "region ID")))]
    .sort(compare);
  const sources = selectedSources(rows, inventory, sourceSnapshots, evaluatedAt);
  const scope = {
    targetVersion,
    regionIds,
    activeLineScopes: [...targets.activeLineScopes].sort((left, right) => compare(pk({ ...left, sourceDomain: "" }), pk({ ...right, sourceDomain: "" }))),
    requiredSourceDomains: [...targets.requiredSourceDomains].sort((left, right) => compare(left.id, right.id)),
  };
  const sourceSet = sources.map(({ sourceId, snapshotId, rawSha256, rawObjectUri, freshnessExpiresAt }) =>
    ({ sourceId, snapshotId, rawSha256, rawObjectUri, freshnessExpiresAt }));
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-five-region-source-fan-in",
    targetVersion,
    evaluatedAt: input.evaluatedAt,
    regionIds,
    inputs: Object.fromEntries(Object.entries(INPUT_PATHS).map(([name, inputPath]) => [name, {
      path: inputPath,
      sha256: sha256(records[name].bytes),
    }])),
    scopeSha256: sha256(Buffer.from(canonical(scope))),
    sourceSetSha256: sha256(Buffer.from(canonical(sourceSet))),
    selectedSources: sources,
  };
  return { ...payload, fanInSha256: sha256(Buffer.from(canonical(payload))) };
}

function argumentsFrom(argv) {
  const names = ["targets", "tally", "ownership", "inventory", "source-snapshots", "evaluated-at", "output"];
  if (argv.length !== names.length * 2) throw new Error("five-region fan-in arguments mismatch");
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.slice(2);
    const value = argv[index + 1];
    if (!names.includes(name) || Object.hasOwn(result, name) || typeof value !== "string" || value.length === 0) {
      throw new Error("five-region fan-in arguments mismatch");
    }
    result[name] = value;
  }
  if (!names.every((name) => Object.hasOwn(result, name))) throw new Error("five-region fan-in arguments mismatch");
  return result;
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const cliPaths = {
    targets: args.targets,
    tally: args.tally,
    ownership: args.ownership,
    inventory: args.inventory,
    sourceSnapshots: args["source-snapshots"],
  };
  const records = await Promise.all(Object.entries(cliPaths).map(async ([name, inputPath]) => {
    const inputBytes = await readFile(path.resolve(inputPath));
    return [name, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes)), inputBytes];
  }));
  const input = {
    ...Object.fromEntries(records.map(([name, value]) => [name, value])),
    inputBytes: Object.fromEntries(records.map(([name, , inputBytes]) => [name, inputBytes])),
    evaluatedAt: args["evaluated-at"],
  };
  const fanIn = buildCurrentFiveRegionSourceFanIn(input);
  await writeFile(path.resolve(args.output), `${canonicalCurrentFiveRegionSourceFanInJson(fanIn)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "five-region source fan-in failed");
    process.exitCode = 1;
  });
}
