#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeStationName } from "./collect-capital-route-topology.mjs";
import { replaceFileAtomically } from "./refresh-route-map-admission-freshness.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const STATION_ALIASES = Object.freeze({
  능길: "신길온천",
  김포공항역: "김포공항",
  부천종합운동장역: "부천종합운동장",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalStationName(value) {
  const normalized = normalizeStationName(value);
  return STATION_ALIASES[normalized] ?? normalized;
}

function requiredUtcInstant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an exact UTC instant`);
  }
  return value;
}

function requiredSha256(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be sha256`);
  return value;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseSnapshot(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function topologyStationsByLine(topology) {
  if (!Array.isArray(topology.lines) || topology.lines.length === 0) {
    throw new Error("capital topology lines are missing");
  }
  const result = new Map();
  for (const line of topology.lines) {
    if (typeof line?.lineId !== "string" || line.lineId.length === 0 || result.has(line.lineId)) {
      throw new Error("capital topology line identity is invalid");
    }
    const stations = new Set();
    for (const entry of line.scope ?? []) stations.add(canonicalStationName(entry.stationName));
    for (const branch of line.branchSequences ?? []) {
      for (const stationName of branch.stationNames ?? []) stations.add(canonicalStationName(stationName));
    }
    if (stations.size === 0) throw new Error(`capital topology line has no stations: ${line.lineId}`);
    result.set(line.lineId, stations);
  }
  return result;
}

export function withCurrentCapitalTopologyAdmissions({
  inventory,
  topology,
  topologySnapshotId,
  reviewedAt,
  snapshotBytesByPath,
}) {
  if (inventory?.schemaVersion !== 1
    || inventory.artifactKind !== "production-source-inventory"
    || !Array.isArray(inventory.sources)) {
    throw new Error("production source inventory identity is invalid");
  }
  if (topology?.sourceId !== "capital-route-topology") {
    throw new Error("capital topology source identity is invalid");
  }
  requiredSha256(topology.contentSha256, "capital topology contentSha256");
  requiredUtcInstant(topology.capturedAt, "capital topology capturedAt");
  requiredUtcInstant(topology.freshUntil, "capital topology freshUntil");
  requiredUtcInstant(reviewedAt, "reviewedAt");
  if (reviewedAt !== topology.capturedAt || Date.parse(topology.freshUntil) <= Date.parse(reviewedAt)) {
    throw new Error("current topology review/freshness identity is invalid");
  }
  if (typeof topologySnapshotId !== "string" || !/^capital-route-topology-[0-9]{8}$/u.test(topologySnapshotId)) {
    throw new Error("capital topology snapshotId is invalid");
  }
  if (!(snapshotBytesByPath instanceof Map)) throw new Error("snapshot bytes map is required");

  const stationsByLine = topologyStationsByLine(topology);
  const next = structuredClone(inventory);
  let admissionCount = 0;
  for (const source of next.sources) {
    const evidence = source.routeMapAdmissionEvidence;
    if (evidence?.topologySourceId !== topology.sourceId) continue;
    const snapshotBytes = snapshotBytesByPath.get(evidence.snapshotPath);
    if (snapshotBytes == null
      || sha256(snapshotBytes) !== requiredSha256(evidence.snapshotSha256, `${source.id} snapshotSha256`)) {
      throw new Error(`${source.id} position snapshot byte identity mismatch`);
    }
    const snapshot = parseSnapshot(snapshotBytes, `${source.id} position snapshot`);
    if (snapshot.sourceId !== source.id
      || snapshot.topologySourceId !== evidence.topologySourceId
      || snapshot.topologySnapshotId !== evidence.topologySnapshotId
      || snapshot.topologyContentSha256 !== evidence.topologyContentSha256
      || !same(snapshot.topologyLineages, evidence.topologyLineages)
      || !same(snapshot.lineIds, evidence.lineIds)
      || snapshot.stationCount !== evidence.stationCount
      || !Array.isArray(snapshot.positions)
      || snapshot.positions.length !== evidence.stationCount) {
      throw new Error(`${source.id} historical position admission mismatch`);
    }
    if (new Set(evidence.lineIds).size !== evidence.lineIds.length || evidence.lineIds.length === 0) {
      throw new Error(`${source.id} admitted line set is invalid`);
    }
    const observedLines = new Set();
    for (const position of snapshot.positions) {
      const stations = stationsByLine.get(position.lineId);
      if (!evidence.lineIds.includes(position.lineId)
        || !stations?.has(canonicalStationName(position.stationName))) {
        throw new Error(`${source.id} station membership mismatch: ${position.lineId}:${position.stationName}`);
      }
      observedLines.add(position.lineId);
    }
    if (!same([...observedLines].sort(compareStrings), [...evidence.lineIds].sort(compareStrings))) {
      throw new Error(`${source.id} position line coverage mismatch`);
    }
    evidence.currentTopologyAdmission = {
      schemaVersion: 1,
      artifactKind: "capital-route-map-current-topology-admission",
      issue: 2776,
      status: "ADMITTED",
      topologySnapshotId,
      topologyContentSha256: topology.contentSha256,
      positionSnapshotSha256: evidence.snapshotSha256,
      reviewedAt,
      freshUntil: topology.freshUntil,
      topologyLineages: [...evidence.lineIds].sort(compareStrings).map((lineId) => ({
        sourceId: topology.sourceId,
        snapshotId: topologySnapshotId,
        contentSha256: topology.contentSha256,
        lineId,
      })),
    };
    admissionCount += 1;
  }
  if (admissionCount === 0) throw new Error("capital route-map admissions are missing");
  return next;
}

function parseArgs(argv) {
  const values = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") values.check = true;
    else if (["--inventory", "--topology", "--topology-snapshot-id", "--reviewed-at"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      values[arg.slice(2).replaceAll("-", "_")] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ["inventory", "topology", "topology_snapshot_id", "reviewed_at"]) {
    if (!values[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  return values;
}

async function regularFile(relativePath, label) {
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes repository root`);
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return { absolutePath, bytes: await readFile(absolutePath) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inventoryFile = await regularFile(args.inventory, "inventory");
  const topologyFile = await regularFile(args.topology, "topology");
  const inventory = parseSnapshot(inventoryFile.bytes, "inventory");
  const topology = parseSnapshot(topologyFile.bytes, "topology");
  const snapshotBytesByPath = new Map();
  for (const source of inventory.sources ?? []) {
    const evidence = source.routeMapAdmissionEvidence;
    if (evidence?.topologySourceId !== topology.sourceId) continue;
    const snapshot = await regularFile(evidence.snapshotPath, `${source.id} position snapshot`);
    snapshotBytesByPath.set(evidence.snapshotPath, snapshot.bytes);
  }
  const next = withCurrentCapitalTopologyAdmissions({
    inventory,
    topology,
    topologySnapshotId: args.topology_snapshot_id,
    reviewedAt: args.reviewed_at,
    snapshotBytesByPath,
  });
  const nextBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  if (args.check) {
    if (!nextBytes.equals(inventoryFile.bytes)) throw new Error("capital route-map admission drift detected");
    return;
  }
  await replaceFileAtomically(inventoryFile.absolutePath, nextBytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
