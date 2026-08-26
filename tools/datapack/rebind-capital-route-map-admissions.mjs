#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadCapitalRouteTopologySnapshot } from "./apply-capital-route-topology-to-bundled-pack.mjs";
import { normalizeStationName } from "./collect-capital-route-topology.mjs";
import { replaceFileAtomically } from "./refresh-route-map-admission-freshness.mjs";
import {
  buildSeoulRouteMapPositions,
  validateSeoulRouteMapPositionsSnapshot,
} from "./collect-seoul-route-map-positions.mjs";
import { requirePublicStaticNetworkV2Admission } from "./public-static-network-v2-admission.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const LAYOUT_EVIDENCE_FIELDS = Object.freeze([
  "aliasLedgerSha256", "aliasLedgerVersion", "layoutAlgorithmVersion", "layoutArtifactSha256",
  "layoutPositionsSha256", "layoutTracksSha256", "lineOrderSha256", "outputSchemaSha256",
  "rawPositionsSha256", "semanticInputSha256", "semanticOutputSha256", "topologySnapshotId",
  "topologySnapshotIdentity", "topologySnapshotSha256",
]);
const CURRENT_LAYOUT_ADMISSION_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "status", "positionSnapshotId", "snapshotPath",
  "snapshotSha256", "rawSha256", "contentSha256", ...LAYOUT_EVIDENCE_FIELDS,
]);
const IMMUTABLE_LAYOUT_REVERIFICATION_FIELDS = Object.freeze([
  "rawSha256", "layoutPositionsSha256", "layoutTracksSha256",
  "semanticOutputSha256", "outputSchemaSha256",
]);
const STATION_ALIASES = Object.freeze({
  당고개: "불암산",
  능길: "신길온천",
  김포공항역: "김포공항",
  부천종합운동장역: "부천종합운동장",
  서울: "서울역",
  뚝섬유원지: "자양",
  하남검단산: "하남검단산역",
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
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function currentLayoutSnapshot(source, evidence) {
  const admission = evidence?.currentLayoutAdmission;
  if (source.id !== "seoul-metro-route-map-positions" || admission == null) return null;
  if (admission.schemaVersion !== 2
    || admission.artifactKind !== "seoul-public-route-map-layout-admission"
    || admission.status !== "ADMITTED"
    || !same(Object.keys(admission).sort(compareStrings), [...CURRENT_LAYOUT_ADMISSION_FIELDS].sort(compareStrings))
    || typeof admission.positionSnapshotId !== "string"
    || admission.positionSnapshotId.length === 0
    || admission.snapshotPath !== `tools/datapack/sources/${admission.positionSnapshotId}.json`
    || CURRENT_LAYOUT_ADMISSION_FIELDS.filter((field) => field.endsWith("Sha256"))
      .some((field) => !SHA256.test(admission[field] ?? ""))) {
    throw new Error("Seoul current layout admission is invalid");
  }
  return admission;
}
function validateCurrentLayoutObservation({ source, admission, bytes, topologyBytes }) {
  if (sha256(bytes) !== admission.snapshotSha256) throw new Error("Seoul current layout observation byte identity mismatch");
  if (sha256(topologyBytes) !== admission.topologySnapshotSha256) {
    throw new Error("Seoul current layout historical topology byte identity mismatch");
  }
  const observation = parseSnapshot(bytes, "Seoul current layout observation");
  const artifact = observation?.routeMapLayoutArtifact;
  if (!artifact) throw new Error("Seoul current layout observation identity is invalid");
  const { layout } = requirePublicStaticNetworkV2Admission({
    positions: {
      sourceId: observation.sourceId,
      snapshotId: observation.snapshotId,
      retrievedAt: observation.capturedAt,
      rawSha256: observation.rawSha256,
      contentSha256: observation.contentSha256,
      rowCount: observation.rowCount,
      normalizedObservationSha256: sha256(bytes),
      routeMapLayoutEvidence: observation.routeMapLayoutEvidence,
      routeMapLayoutArtifact: artifact,
      publicStaticNetworkV2Observation: observation,
    },
    positionSource: source,
  });
  validateSeoulRouteMapPositionsSnapshot(artifact, { topologySnapshotBytes: topologyBytes });
  const expectedLayout = Object.fromEntries(LAYOUT_EVIDENCE_FIELDS.map((field) => [
    field,
    field === "layoutArtifactSha256" ? sha256(canonicalBytes(artifact)) : artifact[field],
  ]));
  const expectedAdmission = {
    schemaVersion: 2,
    artifactKind: "seoul-public-route-map-layout-admission",
    status: "ADMITTED",
    positionSnapshotId: observation?.snapshotId,
    snapshotPath: `tools/datapack/sources/${observation?.snapshotId}.json`,
    snapshotSha256: sha256(bytes),
    rawSha256: observation?.rawSha256,
    contentSha256: observation?.contentSha256,
    ...expectedLayout,
  };
  if (observation?.sourceId !== source.id
    || observation.schemaVersion !== 2
    || observation.artifactKind !== "public-static-network-v2-observation"
    || observation.snapshotId !== admission.positionSnapshotId
    || observation.capturedAt !== artifact.capturedAt
    || artifact.rawSha256 !== observation.rawSha256
    || observation.contentSha256 !== sha256(canonicalBytes(observation.normalizedProjection))
    || observation.rowCount !== observation.normalizedProjection?.length
    || !same(Object.keys(layout ?? {}).sort(compareStrings), [...LAYOUT_EVIDENCE_FIELDS].sort(compareStrings))
    || LAYOUT_EVIDENCE_FIELDS.some((field) => layout[field] !== expectedLayout[field])
    || CURRENT_LAYOUT_ADMISSION_FIELDS.some((field) => admission[field] !== expectedAdmission[field])) {
    throw new Error("Seoul current layout observation identity is invalid");
  }
  const providerRows = observation.normalizedProjection?.map(({
    line, stationCode, stationName, latitude, longitude, basisDate,
  }) => ({ line, stationCode, stationName, latitude, longitude, basisDate }));
  const rawRows = artifact.rawPositions.map(({
    line, stationCode, stationName, latitude, longitude, basisDate,
  }) => ({ line, stationCode, stationName, latitude, longitude, basisDate }));
  if (!Array.isArray(providerRows)
    || !same(providerRows, rawRows)
    || artifact.rawPositions.length !== artifact.rawStationCount
    || artifact.layoutPositions.length !== artifact.rawPositions.length) {
    throw new Error("Seoul current layout artifact mismatch");
  }
  return { artifact, observation };
}

function reverifyImmutableCurrentLayout({ artifact, topologyBytes, topologySnapshotId }) {
  const rematerialized = buildSeoulRouteMapPositions({
    records: artifact.rawPositions,
    rawSha256: artifact.rawSha256,
    topologySnapshotBytes: topologyBytes,
    topologySnapshotId,
    now: new Date(artifact.capturedAt),
  });
  if (!same(rematerialized.rawPositions, artifact.rawPositions)
    || IMMUTABLE_LAYOUT_REVERIFICATION_FIELDS.some((field) => rematerialized[field] !== artifact[field])) {
    throw new Error("Seoul current layout topology reverification drift");
  }
  return rematerialized;
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

function currentCapitalTopologyBinding(source, evidence, topologySourceId) {
  if (source.id !== "seoul-metro-route-map-positions") {
    return evidence?.topologySourceId === topologySourceId ? "historical" : null;
  }
  const currentAdmission = evidence?.currentTopologyAdmission;
  const initialAdmission = [
    evidence?.topologySourceId,
    evidence?.topologySnapshotId,
    evidence?.topologyContentSha256,
    evidence?.topologyLineages,
    currentAdmission,
  ].every((value) => value === undefined);
  const recurrentAdmission = currentAdmission != null
    && evidence.topologySourceId === topologySourceId
    && [evidence.topologySnapshotId, evidence.topologyContentSha256, evidence.topologyLineages]
      .every((value) => value === undefined)
    && same(Object.keys(currentAdmission), [
      "schemaVersion", "artifactKind", "issue", "status", "topologySnapshotId",
      "topologyContentSha256", "positionSnapshotSha256", "reviewedAt", "freshUntil",
      "topologyLineages",
    ])
    && currentAdmission.schemaVersion === 1
    && currentAdmission.artifactKind === "capital-route-map-current-topology-admission"
    && currentAdmission.issue === 2776
    && currentAdmission.status === "ADMITTED"
    && /^capital-route-topology-[0-9]{8}$/u.test(currentAdmission.topologySnapshotId ?? "")
    && SHA256.test(currentAdmission.topologyContentSha256 ?? "")
    && currentAdmission.positionSnapshotSha256
      === (evidence.currentLayoutAdmission?.snapshotSha256 ?? evidence.snapshotSha256)
    && Number.isFinite(Date.parse(currentAdmission.reviewedAt))
    && new Date(currentAdmission.reviewedAt).toISOString() === currentAdmission.reviewedAt
    && Number.isFinite(Date.parse(currentAdmission.freshUntil))
    && new Date(currentAdmission.freshUntil).toISOString() === currentAdmission.freshUntil
    && Date.parse(currentAdmission.reviewedAt) < Date.parse(currentAdmission.freshUntil)
    && Array.isArray(evidence.lineIds)
    && same(currentAdmission.topologyLineages, [...evidence.lineIds].sort(compareStrings).map((lineId) => ({
      sourceId: topologySourceId,
      snapshotId: currentAdmission.topologySnapshotId,
      contentSha256: currentAdmission.topologyContentSha256,
      lineId,
    })));
  if (source.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true
    || evidence?.issue !== 2470
    || evidence.admissionKind !== "official-file-latlon"
    || evidence.materializer !== "tools/datapack/materialize-seoul-route-map-positions.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-seoul-route-map-positions.test.mjs"
    || !initialAdmission && !recurrentAdmission) {
    throw new Error("Seoul route-map position source contract is invalid");
  }
  return "current-official";
}

export function requiresCurrentCapitalTopologyAdmission(
  source,
  topologySourceId = "capital-route-topology",
) {
  return currentCapitalTopologyBinding(
    source,
    source?.routeMapAdmissionEvidence,
    topologySourceId,
  ) != null;
}

export function withCurrentCapitalTopologyAdmissions({
  inventory,
  topology,
  topologySnapshotId,
  reviewedAt,
  snapshotBytesByPath,
  topologySnapshotBytes = null,
  layoutTopologySnapshotBytesById = null,
}) {
  if (inventory?.schemaVersion !== 1
    || inventory.artifactKind !== "production-source-inventory"
    || !Array.isArray(inventory.sources)) {
    throw new Error("production source inventory identity is invalid");
  }
  const validatedTopology = loadCapitalRouteTopologySnapshot(topology);
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

  const stationsByLine = topologyStationsByLine(validatedTopology);
  const topologyBytes = topologySnapshotBytes == null ? canonicalBytes(topology) : Buffer.from(topologySnapshotBytes);
  const next = structuredClone(inventory);
  let admissionCount = 0;
  for (const source of next.sources) {
    const evidence = source.routeMapAdmissionEvidence;
    const binding = currentCapitalTopologyBinding(source, evidence, topology.sourceId);
    if (binding == null) continue;
    const layoutAdmission = currentLayoutSnapshot(source, evidence);
    const snapshotPath = layoutAdmission?.snapshotPath ?? evidence.snapshotPath;
    const snapshotBytes = snapshotBytesByPath.get(snapshotPath);
    if (snapshotBytes == null
      || sha256(snapshotBytes) !== requiredSha256(layoutAdmission?.snapshotSha256 ?? evidence.snapshotSha256, `${source.id} snapshotSha256`)) {
      throw new Error(`${source.id} position snapshot byte identity mismatch`);
    }
    const snapshot = parseSnapshot(snapshotBytes, `${source.id} position snapshot`);
    let currentLayout = null;
    if (layoutAdmission != null) {
      if (topologySnapshotBytes == null) {
        throw new Error("Seoul current layout current topology bytes are required");
      }
      if (!(layoutTopologySnapshotBytesById instanceof Map)) {
        throw new Error("Seoul current layout historical topology bytes map is required");
      }
      const historicalTopologyBytes = layoutTopologySnapshotBytesById.get(layoutAdmission.topologySnapshotId);
      if (historicalTopologyBytes == null) {
        throw new Error("Seoul current layout historical topology snapshot bytes are missing");
      }
      currentLayout = validateCurrentLayoutObservation({
        source,
        admission: layoutAdmission,
        bytes: snapshotBytes,
        topologyBytes: Buffer.from(historicalTopologyBytes),
      });
      reverifyImmutableCurrentLayout({
        artifact: currentLayout.artifact,
        topologyBytes,
        topologySnapshotId,
      });
    }
    const positions = currentLayout?.artifact.rawPositions ?? snapshot.positions;
    if (snapshot.sourceId !== source.id
      || !Array.isArray(positions)
      || (currentLayout == null && (!same(snapshot.lineIds, evidence.lineIds) || snapshot.stationCount !== evidence.stationCount || positions.length !== evidence.stationCount))) {
      throw new Error(`${source.id} historical position admission mismatch`);
    }
    if (binding === "historical") {
      if (snapshot.topologySourceId !== evidence.topologySourceId
        || snapshot.topologySnapshotId !== evidence.topologySnapshotId
        || snapshot.topologyContentSha256 !== evidence.topologyContentSha256
        || !same(snapshot.topologyLineages, evidence.topologyLineages)) {
        throw new Error(`${source.id} historical position admission mismatch`);
      }
    } else if (currentLayout == null && (snapshot.positionsSha256 !== evidence.positionsSha256
      || snapshot.rawSha256 !== evidence.rawSha256
      || [
        snapshot.topologySourceId,
        snapshot.topologySnapshotId,
        snapshot.topologyContentSha256,
        snapshot.topologyLineages,
      ].some((value) => value !== undefined))) {
      throw new Error("Seoul route-map position snapshot identity is invalid");
    }
    if (new Set(evidence.lineIds).size !== evidence.lineIds.length || evidence.lineIds.length === 0) {
      throw new Error(`${source.id} admitted line set is invalid`);
    }
    if (currentLayout != null) {
      if (!same([...currentLayout.artifact.lineIds].sort(compareStrings), [...evidence.lineIds].sort(compareStrings))) {
        throw new Error(`${source.id} position line coverage mismatch`);
      }
    } else {
      const observedStationsByLine = new Map();
      const observedPositionKeys = new Set();
      for (const position of positions) {
        const stations = stationsByLine.get(position.lineId);
        const stationName = canonicalStationName(position.stationName);
        if (!evidence.lineIds.includes(position.lineId)
          || !stations?.has(stationName)) {
          throw new Error(`${source.id} station membership mismatch: ${position.lineId}:${position.stationName}`);
        }
        const positionKey = `${position.lineId}\0${stationName}`;
        if (observedPositionKeys.has(positionKey)) {
          throw new Error(`${source.id} duplicate position: ${position.lineId}:${position.stationName}`);
        }
        observedPositionKeys.add(positionKey);
        const observed = observedStationsByLine.get(position.lineId) ?? new Set();
        observed.add(stationName);
        observedStationsByLine.set(position.lineId, observed);
      }
      if (!same([...observedStationsByLine.keys()].sort(compareStrings), [...evidence.lineIds].sort(compareStrings))) {
        throw new Error(`${source.id} position line coverage mismatch`);
      }
    }
    if (binding === "current-official") evidence.topologySourceId = topology.sourceId;
    evidence.currentTopologyAdmission = {
      schemaVersion: 1,
      artifactKind: "capital-route-map-current-topology-admission",
      issue: 2776,
      status: "ADMITTED",
      topologySnapshotId,
      topologyContentSha256: topology.contentSha256,
      positionSnapshotSha256: layoutAdmission?.snapshotSha256 ?? evidence.snapshotSha256,
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
  const layoutTopologySnapshotBytesById = new Map();
  for (const source of inventory.sources ?? []) {
    const evidence = source.routeMapAdmissionEvidence;
    if (evidence?.topologySourceId !== topology.sourceId) continue;
    const snapshotPath = evidence.currentLayoutAdmission?.snapshotPath ?? evidence.snapshotPath;
    const snapshot = await regularFile(snapshotPath, `${source.id} position snapshot`);
    snapshotBytesByPath.set(snapshotPath, snapshot.bytes);
  }
  for (const source of inventory.sources ?? []) {
    const admission = source.routeMapAdmissionEvidence?.currentLayoutAdmission;
    if (admission == null) continue;
    if (!/^capital-route-topology-[0-9]{8}$/u.test(admission.topologySnapshotId ?? "")) {
      throw new Error("Seoul current layout topology snapshot id is invalid");
    }
    const relativePath = `tools/datapack/sources/${admission.topologySnapshotId}.json`;
    if (!layoutTopologySnapshotBytesById.has(admission.topologySnapshotId)) {
      const topologySnapshot = await regularFile(relativePath, "Seoul current layout historical topology snapshot");
      layoutTopologySnapshotBytesById.set(admission.topologySnapshotId, topologySnapshot.bytes);
    }
  }
  const next = withCurrentCapitalTopologyAdmissions({
    inventory,
    topology,
    topologySnapshotId: args.topology_snapshot_id,
    reviewedAt: args.reviewed_at,
    snapshotBytesByPath,
    topologySnapshotBytes: topologyFile.bytes,
    layoutTopologySnapshotBytesById,
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
