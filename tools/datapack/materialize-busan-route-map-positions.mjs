#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateBusanRouteMapPositionsSnapshot } from "./collect-busan-route-map-positions.mjs";
import { busanRouteTopologyContentHash } from "./collect-busan-route-topology.mjs";
import { assertRouteMapAdmissionFreshness } from "./lib/route-map-admission-freshness.mjs";

const SOURCE_ID = "busan-transportation-route-map-positions";
const TOPOLOGY_SOURCE_ID = "busan-transportation-route-topology";
const PACK_ID = "nationwide-busan-route-map";
const OPERATOR_ID = "busan-transportation";

export function materializeBusanRouteMapPositions({
  baseFixture,
  snapshot,
  snapshotSha256,
  topologySnapshot,
  inventory,
  now = new Date(),
}) {
  validateBusanRouteMapPositionsSnapshot(snapshot);
  const source = requiredSource(inventory, snapshot, snapshotSha256, topologySnapshot, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Busan route map positions require one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) throw new Error(`${SOURCE_ID} already exists`);
  const stations = canonicalStations(pack, topologySnapshot);
  validateTopologyLineage(pack, snapshot, topologySnapshot, stations);
  const byLine = Map.groupBy(snapshot.positions, ({ lineId }) => lineId);
  const connectors = new Map(snapshot.connectors.map((connector) => [
    `${connector.lineId}:${connector.fromStationCode}:${connector.toStationCode}`,
    connector,
  ]));
  const rows = [];
  const tracks = [];
  for (const lineId of snapshot.lineIds) {
    const linePositions = [...(byLine.get(lineId) ?? [])].sort(
      (left, right) => Number(left.stationCode) - Number(right.stationCode),
    );
    const line = pack.lines.find(({ id }) => id === lineId);
    if (!line || linePositions.length < 2) throw new Error(`Busan route map line geometry missing: ${lineId}`);
    tracks.push({
      region: "부산권",
      lineId,
      trackIndex: 0,
      path: connectorTrackPath(snapshot, lineId),
      svgColor: line.color,
      sourceId: SOURCE_ID,
      sourceName: "부산교통공사 사이버스테이션 노선도",
      sourceUrl: snapshot.sourceUrl,
      license: source.license.name,
      licenseStatus: "redistributable",
      commercialUseAllowed: true,
      attributionRequired: false,
      sourceSnapshotId: source.routeMapAdmissionEvidence.snapshotId,
      providerRecordHash: sha256(JSON.stringify(
        snapshot.connectors.filter((connector) => connector.lineId === lineId),
      )),
      evidenceHash: snapshot.connectorsSha256,
      provenanceKind: "OFFICIAL_SOURCE",
      derivationKind: "OFFICIAL",
      updatedAt: snapshot.capturedAt,
    });
    for (let index = 0; index < linePositions.length; index += 1) {
      const position = linePositions[index];
      const stationId = stations.get(`${lineId}:${position.stationCode}`);
      if (!stationId) throw new Error(`Busan route map canonical station scope missing: ${lineId}:${position.stationCode}`);
      const previous = linePositions[index - 1];
      const next = linePositions[index + 1];
      const previousConnector = previous
        ? connectors.get(`${lineId}:${previous.stationCode}:${position.stationCode}`)
        : undefined;
      const nextConnector = next
        ? connectors.get(`${lineId}:${position.stationCode}:${next.stationCode}`)
        : undefined;
      if ((previous && !previousConnector) || (next && !nextConnector)) {
        throw new Error(`Busan route map connector missing: ${lineId}:${position.stationCode}`);
      }
      rows.push({
        stationId,
        lineId,
        region: "부산권",
        x: position.x,
        y: position.y,
        labelDx: position.labelDx,
        labelDy: position.labelDy,
        labelPolygon: structuredClone(position.labelPolygon),
        upPath: nextConnector ? reversePath(nextConnector.path) : "",
        downPath: previousConnector?.path ?? "",
        sourceId: SOURCE_ID,
        sourceName: "부산교통공사 사이버스테이션 노선도",
        sourceUrl: snapshot.sourceUrl,
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
  }
  if (rows.length !== 114 || new Set(rows.map(({ stationId, lineId }) => `${stationId}:${lineId}`)).size !== 114) {
    throw new Error("Busan route map materialized row count mismatch");
  }

  pack.sourceInventory.push(packSource(source, snapshot));
  pack.routeMapPositions.push(...rows);
  pack.routeMapLineTracks = [...(pack.routeMapLineTracks ?? []), ...tracks];
  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    route_map_positions: pack.routeMapPositions.length,
    route_map_line_tracks: pack.routeMapLineTracks.length,
  };
  const version = source.routeMapAdmissionEvidence.snapshotId.slice(-8);
  pack.id = `${PACK_ID}-${materializedBusanRouteMapPackContentHash(pack, version)}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedBusanRouteMapPackContentHash(pack, version) {
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
    throw new Error("Busan route map snapshot byte identity mismatch");
  }
  const observedNow = assertRouteMapAdmissionFreshness(evidence, now, SOURCE_ID);
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license.commercialUseAllowed !== true || source.license.derivativeWorkAllowed !== true
    || evidence?.issue !== 2379
    || evidence.materializer !== "tools/datapack/materialize-busan-route-map-positions.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-busan-route-map-positions.test.mjs"
    || evidence.snapshotId !== "busan-transportation-route-map-positions-20260720"
    || evidence.snapshotPath !== "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json"
    || evidence.capturedAt !== snapshot.capturedAt || evidence.stationCount !== snapshot.stationCount
    || evidence.htmlSha256 !== snapshot.htmlSha256 || evidence.cssSha256 !== snapshot.cssSha256
    || evidence.connectorEvidencePath !== "tools/datapack/sources/busan-transportation-route-map-connectors-20260720.json"
    || evidence.connectorEvidenceSha256 !== snapshot.connectorEvidenceSha256
    || evidence.connectorAssetSetSha256 !== snapshot.connectorAssetSetSha256
    || evidence.rawSha256 !== snapshot.rawSha256 || evidence.positionsSha256 !== snapshot.positionsSha256
    || evidence.connectorsSha256 !== snapshot.connectorsSha256
    || evidence.connectorCount !== snapshot.connectorCount
    || evidence.connectorAssetCount !== snapshot.connectorAssetCount
    || evidence.topologySourceId !== snapshot.topologySourceId
    || evidence.topologySnapshotId !== snapshot.topologySnapshotId
    || evidence.topologyContentSha256 !== snapshot.topologyContentSha256
    || !Number.isFinite(observedNow) || observedNow < Date.parse(snapshot.capturedAt)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  if (topologySnapshot?.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.contentSha256 !== snapshot.topologyContentSha256
    || topologySnapshot.stationCount !== snapshot.stationCount
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["busan"],
      operatorIds: [OPERATOR_ID],
      lineIds: snapshot.lineIds,
      sourceDomains: ["route_map_positions"],
    }) || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)) {
    throw new Error(`${SOURCE_ID} topology or coverage scope mismatch`);
  }
  return source;
}

function validateTopologyLineage(pack, snapshot, topologySnapshot, stations) {
  const actual = pack.networkEdges.filter(({ sourceId }) => sourceId === TOPOLOGY_SOURCE_ID)
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const expected = topologySnapshot.edges.map((edge) => ({
    id: `edge-${edge.edgeId.replaceAll(":", "-")}`,
    fromNodeId: `${stations.get(`${edge.lineId}:${edge.fromStationCode}`)}:${edge.lineId}`,
    toNodeId: `${stations.get(`${edge.lineId}:${edge.toStationCode}`)}:${edge.lineId}`,
    durationSeconds: edge.durationSeconds + edge.stoppingSeconds,
    distanceMeters: edge.distanceMeters,
    sourceSnapshotId: snapshot.topologySnapshotId,
    providerRecordHash: sha256(JSON.stringify(edge)),
    evidenceHash: topologySnapshot.contentSha256,
  })).sort((left, right) => left.id.localeCompare(right.id, "en"));
  const comparable = actual.map((edge) => Object.fromEntries(
    Object.keys(expected[0]).map((key) => [key, edge[key]]),
  ));
  if (!pack.sourceInventory.some(({ id }) => id === TOPOLOGY_SOURCE_ID)
    || topologySnapshot.contentSha256 !== snapshot.topologyContentSha256
    || topologySnapshot.contentSha256 !== busanRouteTopologyContentHash(
      topologySnapshot.edges,
      topologySnapshot.scope,
    )
    || actual.length !== expected.length || JSON.stringify(comparable) !== JSON.stringify(expected)) {
    throw new Error("Busan route map topology lineage mismatch");
  }
}

function canonicalStations(pack, topologySnapshot) {
  const expected = new Map();
  for (const lineId of topologySnapshot.lineIds) {
    topologySnapshot.scope.filter((station) => station.lineId === lineId)
      .sort((left, right) => Number(left.stationCode) - Number(right.stationCode))
      .forEach((station, index) => expected.set(`${lineId}:${station.stationCode}`, {
        stationName: station.stationName,
        lineSequence: index + 1,
      }));
  }
  const stationNames = new Map(pack.stations.map(({ id, nameKo }) => [id, nameKo]));
  const stations = new Map();
  for (const stationLine of pack.stationLines) {
    const key = `${stationLine.lineId}:${stationLine.stationCode}`;
    const expectedStation = expected.get(key);
    if (!expectedStation) continue;
    if (stations.has(key)) throw new Error(`Busan route map duplicate canonical station: ${key}`);
    if (stationLine.sourceId !== TOPOLOGY_SOURCE_ID
      || stationLine.lineSequence !== expectedStation.lineSequence
      || stationNames.get(stationLine.stationId)?.normalize("NFKC") !== expectedStation.stationName.normalize("NFKC")) {
      throw new Error(`Busan route map topology lineage mismatch: ${key}`);
    }
    stations.set(key, stationLine.stationId);
  }
  if (stations.size !== 114) throw new Error(`Busan route map canonical station scope mismatch: ${stations.size}`);
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

export function connectorTrackPath(snapshot, lineId) {
  const positions = snapshot.positions.filter((position) => position.lineId === lineId)
    .sort((left, right) => Number(left.stationCode) - Number(right.stationCode));
  const connectors = snapshot.connectors.filter((connector) => connector.lineId === lineId)
    .sort((left, right) => Number(left.fromStationCode) - Number(right.fromStationCode));
  if (positions.length < 2 || connectors.length !== positions.length - 1) {
    throw new Error(`Busan route map connector count mismatch: ${lineId}`);
  }
  const points = [];
  for (let index = 0; index < connectors.length; index += 1) {
    const connector = connectors[index];
    const from = positions[index];
    const to = positions[index + 1];
    const connectorPoints = pathPoints(connector.path);
    if (connector.fromStationCode !== from.stationCode || connector.toStationCode !== to.stationCode
      || connectorPoints[0].x !== from.x || connectorPoints[0].y !== from.y
      || connectorPoints.at(-1).x !== to.x || connectorPoints.at(-1).y !== to.y) {
      throw new Error(`Busan route map connector lineage mismatch: ${lineId}:${connector.fromStationCode}`);
    }
    points.push(...connectorPoints.slice(index === 0 ? 0 : 1));
  }
  return serializePath(points);
}

function reversePath(pathValue) {
  return serializePath(pathPoints(pathValue).reverse());
}

function pathPoints(pathValue) {
  const matches = [...pathValue.matchAll(/(?:M|L) (\d+) (\d+)/g)];
  if (matches.length < 2 || matches.map((match) => match[0]).join(" ") !== pathValue) {
    throw new Error("invalid Busan route map connector path");
  }
  return matches.map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

function serializePath(points) {
  return points.map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const expected = ["--base-fixture", "--snapshot", "--topology-snapshot", "--inventory", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-busan-route-map-positions.mjs --base-fixture <json> --snapshot <json> --topology-snapshot <json> --inventory <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

async function main(argv) {
  const args = parseArgs(argv);
  const [baseFixture, snapshotBytes, topologySnapshot, inventory] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args.snapshot),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
  ]);
  const snapshot = JSON.parse(snapshotBytes);
  const fixture = materializeBusanRouteMapPositions({
    baseFixture,
    snapshot,
    snapshotSha256: sha256(snapshotBytes),
    topologySnapshot,
    inventory,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Busan route map positions materialized: stations=${snapshot.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Busan route map position materialization failed");
    process.exitCode = 1;
  }
}
