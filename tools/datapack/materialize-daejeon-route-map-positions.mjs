#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateDaejeonRouteMapPositionsSnapshot } from "./collect-daejeon-route-map-positions.mjs";
import { assertRouteMapAdmissionFreshness } from "./lib/route-map-admission-freshness.mjs";

const SOURCE_ID = "daejeon-transportation-route-map-positions";
const TOPOLOGY_SOURCE_ID = "daejeon-station-distance-fare";
const TOPOLOGY_SNAPSHOT_ID = "daejeon-station-distance-fare-topology-20260720";
const TIMETABLE_SOURCE_ID = "daejeon-train-timetable";
const PACK_ID = "nationwide-daejeon-route-map";
const OPERATOR_ID = "daejeon-transportation";
const REGION = "대전권";
const LINE_ID = "line-7051a9c2525c";
const LINE_IDS = Object.freeze([LINE_ID]);
const EXPECTED_STATION_COUNT = 22;
const STATION_CODES = Object.freeze(
  Array.from({ length: EXPECTED_STATION_COUNT }, (_, index) => String(101 + index)),
);

export function materializeDaejeonRouteMapPositions({
  baseFixture,
  snapshot,
  snapshotSha256,
  topologySnapshot,
  inventory,
  now = new Date(),
} = {}) {
  validateDaejeonRouteMapPositionsSnapshot(snapshot);
  const source = requiredSource(inventory, snapshot, snapshotSha256, topologySnapshot, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Daejeon route map positions require one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  if (!pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Daejeon route map positions require daejeon-transportation operator pack");
  }
  if (!pack.sourceInventory.some(({ id }) => id === TIMETABLE_SOURCE_ID)) {
    throw new Error("Daejeon route map positions require daejeon timetable source");
  }

  validateTopologyLineage(inventory, source.routeMapAdmissionEvidence, topologySnapshot);
  const stations = canonicalStations(pack, topologySnapshot);
  const rows = [];
  for (const position of snapshot.positions) {
    const stationId = stations.get(`${position.lineId}:${position.stationCode}`);
    if (!stationId) {
      throw new Error(`Daejeon route map canonical station missing: ${position.lineId}:${position.stationCode}`);
    }
    rows.push({
      stationId,
      lineId: position.lineId,
      region: REGION,
      x: position.x,
      y: position.y,
      labelDx: position.labelDx,
      labelDy: position.labelDy,
      labelPolygon: structuredClone(position.labelPolygon),
      upPath: "",
      downPath: "",
      sourceId: SOURCE_ID,
      sourceName: "국가철도공단_전체_도시철도역사정보(대전교통공사)",
      sourceUrl: snapshot.datasetUrl ?? snapshot.detailUrl,
      sourceSha256: snapshot.rawSha256,
      license: source.license.name,
      licenseStatus: "redistributable",
      commercialUseAllowed: true,
      attributionRequired: false,
      derivationKind: "OFFICIAL",
      provenanceKind: "OFFICIAL_SOURCE",
      sourceSnapshotId: source.routeMapAdmissionEvidence.snapshotId,
      providerRecordHash: sha256(JSON.stringify(position)),
      evidenceHash: snapshot.positionsSha256,
      sourceLabel: position.stationName,
      reviewedAt: snapshot.capturedAt,
      updatedAt: snapshot.capturedAt,
    });
  }
  if (rows.length !== EXPECTED_STATION_COUNT) {
    throw new Error(`Daejeon route map materialized row count mismatch: ${rows.length}`);
  }
  const coveredLineIds = new Set(rows.map(({ lineId }) => lineId));
  for (const lineId of LINE_IDS) {
    if (!coveredLineIds.has(lineId)) {
      throw new Error(`Daejeon route map missing line coverage: ${lineId}`);
    }
  }

  pack.sourceInventory.push(packSource(source, snapshot));
  pack.routeMapPositions = [...(pack.routeMapPositions ?? []), ...rows];
  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    route_map_positions: pack.routeMapPositions.length,
  };
  const version = source.routeMapAdmissionEvidence.snapshotId.slice(-8);
  const composition = sha256(JSON.stringify({
    previousPackId: pack.id,
    snapshotId: source.routeMapAdmissionEvidence.snapshotId,
    positionsSha256: snapshot.positionsSha256,
    materializedCount: rows.length,
    source,
    contentSha256: materializedDaejeonRouteMapPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedDaejeonRouteMapPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function requiredSource(inventory, snapshot, snapshotSha256, topologySnapshot, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.routeMapAdmissionEvidence;
  if (!/^[a-f0-9]{64}$/.test(snapshotSha256 ?? "") || evidence?.snapshotSha256 !== snapshotSha256) {
    throw new Error("Daejeon route map snapshot byte identity mismatch");
  }
  const observedNow = assertRouteMapAdmissionFreshness(evidence, now, SOURCE_ID);
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.license.commercialUseAllowed !== true || source.license.derivativeWorkAllowed !== true
    || evidence?.issue !== 2496
    || evidence.admissionKind !== "official-file-latlon"
    || evidence.materializer !== "tools/datapack/materialize-daejeon-route-map-positions.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-daejeon-route-map-positions.test.mjs"
    || evidence.snapshotId !== "daejeon-transportation-route-map-positions-20260725"
    || evidence.snapshotPath !== "tools/datapack/sources/daejeon-transportation-route-map-positions-20260725.json"
    || evidence.capturedAt !== snapshot.capturedAt
    || evidence.stationCount !== snapshot.stationCount
    || evidence.rawStationCount !== snapshot.rawStationCount
    || evidence.quarantinedCount !== snapshot.quarantinedCount
    || evidence.datasetId !== snapshot.datasetId
    || JSON.stringify(evidence.datasetIds) !== JSON.stringify(snapshot.datasetIds)
    || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.positionsSha256 !== snapshot.positionsSha256
    || evidence.observedDataUpdatedAt !== snapshot.observedDataUpdatedAt
    || JSON.stringify(evidence.lineIds) !== JSON.stringify(snapshot.lineIds)
    || JSON.stringify(evidence.lineStationCounts) !== JSON.stringify(snapshot.lineStationCounts)
    || evidence.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== snapshot.topologyContentSha256
    || JSON.stringify(evidence.topologyLineages) !== JSON.stringify(snapshot.topologyLineages)
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["daejeon"],
      operatorIds: [OPERATOR_ID],
      lineIds: [...LINE_IDS],
      sourceDomains: ["route_map_positions"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)
    || !Number.isFinite(observedNow) || observedNow < Date.parse(snapshot.capturedAt)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  validateTopologyLineage(inventory, evidence, topologySnapshot);
  return source;
}

function validateTopologyLineage(inventory, evidence, topologySnapshot) {
  const topologyEvidence = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID)
    ?.topologyAdmissionEvidence;
  const lineage = evidence?.topologyLineages?.[0];
  if (evidence?.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== topologyEvidence?.contentSha256
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.contentSha256 !== sha256(JSON.stringify(topologySnapshot.rows))
    || lineage?.sourceId !== TOPOLOGY_SOURCE_ID
    || lineage.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || lineage.contentSha256 !== topologySnapshot.contentSha256
    || lineage.lineId !== LINE_ID
    || topologyEvidence?.snapshotId !== TOPOLOGY_SNAPSHOT_ID) {
    throw new Error("Daejeon route map topology lineage mismatch");
  }
}

function canonicalStations(pack, topologySnapshot) {
  const expectedCodes = new Set(topologySnapshot.stationNumbers ?? []);
  if (JSON.stringify([...expectedCodes].sort()) !== JSON.stringify([...STATION_CODES].sort())) {
    throw new Error("Daejeon route map topology station codes mismatch");
  }
  const stations = new Map();
  for (const stationLine of pack.stationLines) {
    if (stationLine.lineId !== LINE_ID || !expectedCodes.has(stationLine.stationCode)) continue;
    const key = `${LINE_ID}:${stationLine.stationCode}`;
    if (stations.has(key)) throw new Error(`Daejeon route map duplicate canonical station: ${key}`);
    const provenanceSourceId = stationLine.fieldProvenance?.station_code?.sourceId;
    if (provenanceSourceId !== TOPOLOGY_SOURCE_ID
      || stationLine.lineSequence !== Number(stationLine.stationCode) - 100) {
      throw new Error(`Daejeon route map topology lineage mismatch: ${key}`);
    }
    stations.set(key, stationLine.stationId);
  }
  if (stations.size !== EXPECTED_STATION_COUNT) {
    throw new Error(`Daejeon route map canonical station scope mismatch: ${stations.size}`);
  }
  return stations;
}

function packSource(source, snapshot) {
  return {
    id: source.id,
    owner: source.owner,
    url: source.datasetUrl,
    sourceSha256: snapshot.rawSha256,
    license: source.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: source.updateFrequency,
    updatedAt: snapshot.capturedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const expected = ["--base-fixture", "--snapshot", "--inventory", "--topology", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-daejeon-route-map-positions.mjs --base-fixture <json> --snapshot <json> --inventory <json> --topology <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

async function main(argv) {
  const args = parseArgs(argv);
  const [baseFixture, snapshotBytes, inventory, topologySnapshot] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args.snapshot),
    readFile(args.inventory, "utf8").then(JSON.parse),
    readFile(args.topology, "utf8").then(JSON.parse),
  ]);
  const snapshot = JSON.parse(snapshotBytes);
  const fixture = materializeDaejeonRouteMapPositions({
    baseFixture,
    snapshot,
    snapshotSha256: sha256(snapshotBytes),
    topologySnapshot,
    inventory,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Daejeon route map positions materialized: stations=${snapshot.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daejeon route map position materialization failed");
    process.exitCode = 1;
  }
}
