#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
import { validateDaeguRouteMapPositionsSnapshot } from "./collect-daegu-route-map-positions.mjs";

const SOURCE_ID = "daegu-transportation-route-map-positions";
const PACK_ID = "nationwide-daegu-route-map";
const OPERATOR_ID = "daegu-transportation";
const REGION = "대구권";
const EXPECTED_STATION_COUNT = 91;
const LINE_IDS = Object.freeze(DAEGU_LINES.map(({ lineId }) => lineId));
const COMPOSITE_TOPOLOGY_SOURCE_ID = "daegu-transportation-route-map-topology-lineage";
const COMPOSITE_TOPOLOGY_SNAPSHOT_ID = "daegu-transportation-route-map-topology-lineage-20260721";

export function materializeDaeguRouteMapPositions({
  baseFixture,
  snapshot,
  snapshotSha256,
  topologySnapshots,
  inventory,
  now = new Date(),
} = {}) {
  validateDaeguRouteMapPositionsSnapshot(snapshot);
  const source = requiredSource(inventory, snapshot, snapshotSha256, topologySnapshots, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Daegu route map positions require one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  if (!pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Daegu route map positions require daegu-transportation operator pack");
  }
  for (const line of DAEGU_LINES) {
    if (!pack.sourceInventory.some(({ id }) => id === `daegu-line${line.lineNumber}-train-timetable`)) {
      throw new Error("Daegu route map positions require daegu timetable sources");
    }
  }

  validateTopologyLineages(inventory, source.routeMapAdmissionEvidence, topologySnapshots);
  const stations = canonicalStations(pack, topologySnapshots);
  const rows = [];
  for (const position of snapshot.positions) {
    const stationId = stations.get(`${position.lineId}:${position.stationCode}`);
    if (!stationId) {
      throw new Error(`Daegu route map canonical station missing: ${position.lineId}:${position.stationCode}`);
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
      sourceName: "대구교통공사_역별 출구별 위치정보",
      sourceUrl: snapshot.datasetUrls?.[0] ?? snapshot.detailUrl,
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
    throw new Error(`Daegu route map materialized row count mismatch: ${rows.length}`);
  }
  const coveredLineIds = new Set(rows.map(({ lineId }) => lineId));
  for (const lineId of LINE_IDS) {
    if (!coveredLineIds.has(lineId)) {
      throw new Error(`Daegu route map missing line coverage: ${lineId}`);
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
    contentSha256: materializedDaeguRouteMapPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedDaeguRouteMapPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function requiredSource(inventory, snapshot, snapshotSha256, topologySnapshots, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.routeMapAdmissionEvidence;
  if (!/^[a-f0-9]{64}$/.test(snapshotSha256 ?? "") || evidence?.snapshotSha256 !== snapshotSha256) {
    throw new Error("Daegu route map snapshot byte identity mismatch");
  }
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.license.commercialUseAllowed !== true || source.license.derivativeWorkAllowed !== true
    || evidence?.issue !== 2473
    || evidence.admissionKind !== "official-file-latlon"
    || evidence.materializer !== "tools/datapack/materialize-daegu-route-map-positions.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-daegu-route-map-positions.test.mjs"
    || evidence.snapshotId !== "daegu-transportation-route-map-positions-20260724"
    || evidence.snapshotPath !== "tools/datapack/sources/daegu-transportation-route-map-positions-20260724.json"
    || evidence.capturedAt !== snapshot.capturedAt
    || evidence.stationCount !== snapshot.stationCount
    || evidence.rawStationCount !== snapshot.rawStationCount
    || evidence.quarantinedCount !== snapshot.quarantinedCount
    || evidence.exitRowCount !== snapshot.exitRowCount
    || JSON.stringify(evidence.datasetIds) !== JSON.stringify(snapshot.datasetIds)
    || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.positionsSha256 !== snapshot.positionsSha256
    || evidence.observedDataUpdatedAt !== snapshot.observedDataUpdatedAt
    || JSON.stringify(evidence.lineIds) !== JSON.stringify(snapshot.lineIds)
    || JSON.stringify(evidence.lineStationCounts) !== JSON.stringify(snapshot.lineStationCounts)
    || evidence.topologySourceId !== COMPOSITE_TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== COMPOSITE_TOPOLOGY_SNAPSHOT_ID
    || JSON.stringify(evidence.topologyLineages) !== JSON.stringify(snapshot.topologyLineages)
    || evidence.topologyContentSha256 !== sha256(JSON.stringify(evidence.topologyLineages))
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["daegu"],
      operatorIds: [OPERATOR_ID],
      lineIds: [...LINE_IDS],
      sourceDomains: ["route_map_positions"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)
    || !Number.isFinite(observedNow) || observedNow < Date.parse(snapshot.capturedAt)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  validateTopologyLineages(inventory, evidence, topologySnapshots);
  return source;
}

function validateTopologyLineages(inventory, evidence, topologySnapshots) {
  if (!Array.isArray(evidence?.topologyLineages) || evidence.topologyLineages.length !== DAEGU_LINES.length) {
    throw new Error("Daegu route map topology lineages are incomplete");
  }
  for (const [index, config] of DAEGU_LINES.entries()) {
    const lineage = evidence.topologyLineages[index];
    const topologyEvidence = inventory?.sources?.find(({ id }) => id === lineage?.sourceId)
      ?.topologyAdmissionEvidence;
    const snapshot = topologySnapshots?.[config.lineNumber];
    if (lineage?.sourceId !== `daegu-line${config.lineNumber}-route-topology`
      || lineage.lineId !== config.lineId
      || lineage.snapshotId !== `${lineage.sourceId}-20260721`
      || !topologyEvidence
      || topologyEvidence.snapshotId !== lineage.snapshotId
      || topologyEvidence.contentSha256 !== lineage.contentSha256
      || snapshot?.sourceId !== lineage.sourceId
      || snapshot.contentSha256 !== lineage.contentSha256
      || snapshot.contentSha256 !== sha256(JSON.stringify({ scope: snapshot.scope, edges: snapshot.edges }))) {
      throw new Error(`Daegu route map topology lineage mismatch: ${config.lineNumber}`);
    }
  }
  if (evidence.topologySourceId !== COMPOSITE_TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== COMPOSITE_TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== sha256(JSON.stringify(evidence.topologyLineages))) {
    throw new Error("Daegu route map composite topology lineage mismatch");
  }
}

function canonicalStations(pack, topologySnapshots) {
  const expected = new Map();
  for (const config of DAEGU_LINES) {
    const topology = topologySnapshots[config.lineNumber];
    for (const station of topology.scope) {
      expected.set(`${config.lineId}:${station.stationCode}`, {
        stationName: station.stationName,
        lineSequence: station.sequence,
        topologySourceId: topology.sourceId,
      });
    }
  }
  const stations = new Map();
  for (const stationLine of pack.stationLines) {
    const key = `${stationLine.lineId}:${stationLine.stationCode}`;
    const expectedStation = expected.get(key);
    if (!expectedStation) continue;
    const station = pack.stations.find(({ id }) => id === stationLine.stationId);
    if (!station) throw new Error(`Daegu route map pack station missing: ${stationLine.stationId}`);
    stations.set(key, station.id);
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
  const expected = ["--base-fixture", "--snapshot", "--inventory", "--sources-dir", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-daegu-route-map-positions.mjs --base-fixture <json> --snapshot <json> --inventory <json> --sources-dir <dir> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

async function main(argv) {
  const args = parseArgs(argv);
  const [baseFixture, snapshotBytes, inventory] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args.snapshot),
    readFile(args.inventory, "utf8").then(JSON.parse),
  ]);
  const topologySnapshots = {};
  for (const line of DAEGU_LINES) {
    topologySnapshots[line.lineNumber] = JSON.parse(await readFile(
      path.join(args["sources-dir"], `daegu-line${line.lineNumber}-route-topology-20260721.json`),
      "utf8",
    ));
  }
  const snapshot = JSON.parse(snapshotBytes);
  const fixture = materializeDaeguRouteMapPositions({
    baseFixture,
    snapshot,
    snapshotSha256: sha256(snapshotBytes),
    topologySnapshots,
    inventory,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Daegu route map positions materialized: stations=${snapshot.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daegu route map position materialization failed");
    process.exitCode = 1;
  }
}
