#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateIncheonStationInfoSnapshot,
} from "./collect-incheon-station-info.mjs";

const SOURCE_ID = "incheon-transit-station-info";
const OPERATOR_ID = "incheon-transit";
const PACK_ID = "nationwide-incheon-station-info";
const REGION = "수도권";
const REGION_ID = "capital";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE7 = "line-15b3b8a93259";
const OWNED_LINE_IDS = Object.freeze([LINE2, LINE1]);
const LINE_IDS = Object.freeze([LINE2, LINE1, LINE7]);
const TOPOLOGY_LINE_IDS = Object.freeze([LINE2, LINE1]);
const LINE_METADATA = Object.freeze({
  [LINE1]: { nameKo: "인천 1호선", color: "#7ca8d5" },
  [LINE2]: { nameKo: "인천 2호선", color: "#ed8b00" },
  [LINE7]: { nameKo: "수도권 7호선", color: "#657931" },
});
const EXPECTED_STATION_COUNT = 71;
const EXPECTED_UNIQUE_STATION_COUNT = 69;
const EXPECTED_TOPOLOGY_STATION_COUNT = 60;
const EXPECTED_LINE7_COUNT = 11;
const EXPECTED_EDGE_COUNT = 116;
const EXPECTED_POSITION_COUNT = 71;
const FIELDS_PROVIDED = Object.freeze([
  "line",
  "station_name",
  "station_code",
  "network_edges",
  "duration_seconds",
  "distance_meters",
  "route_map_position",
  "route_map_label_polygon",
]);

export function materializeIncheonStationInfo({
  baseFixture,
  snapshot,
  snapshotSha256,
  inventory,
  now = new Date(),
} = {}) {
  validateIncheonStationInfoSnapshot(snapshot);
  const source = requiredSource(inventory, snapshot, snapshotSha256, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Incheon station info requires one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  if (pack.operators.some(({ id }) => id === OPERATOR_ID)
    || OWNED_LINE_IDS.some((lineId) => pack.lines.some(({ id }) => id === lineId))) {
    throw new Error("Incheon operator/lines already exist in base fixture");
  }

  const snapshotId = source.topologyAdmissionEvidence.snapshotId;
  pack.sourceInventory.push(packSource(source, snapshot));
  pack.operators.push({ id: OPERATOR_ID, nameKo: "인천교통공사", nameEn: "" });
  pack.lines.push(...OWNED_LINE_IDS.map((lineId) => ({
    id: lineId,
    operatorId: OPERATOR_ID,
    nameKo: LINE_METADATA[lineId].nameKo,
    nameEn: "",
    color: LINE_METADATA[lineId].color,
  })));
  ensureSharedLine7(pack, fixture);

  const stationsById = new Map();
  const stationLines = [];
  for (const station of snapshot.scope) {
    if (!stationsById.has(station.stationId)) {
      stationsById.set(station.stationId, {
        id: station.stationId,
        nameKo: station.stationName,
        nameEn: station.nameEn ?? "",
        normalizedName: station.stationName.normalize("NFKC"),
        region: REGION,
        latitude: station.latitude,
        longitude: station.longitude,
        dataQualityLevel: "LEVEL_2",
        dataSourceType: "OFFICIAL_FILE",
        sourceId: SOURCE_ID,
        sourceSnapshotId: snapshotId,
        providerRecordHash: sha256(JSON.stringify({
          lineId: station.lineId,
          stationCode: station.stationCode,
          stationName: station.stationName,
          latitude: station.latitude,
          longitude: station.longitude,
        })),
        evidenceHash: snapshot.scopeSha256,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: snapshot.capturedAt,
      });
    }
    stationLines.push({
      stationId: station.stationId,
      lineId: station.lineId,
      stationCode: station.stationCode,
      lineSequence: station.lineSequence,
      platformInfo: "",
      sourceId: SOURCE_ID,
      sourceSnapshotId: snapshotId,
      providerRecordHash: sha256(JSON.stringify({
        lineId: station.lineId,
        stationCode: station.stationCode,
        stationName: station.stationName,
      })),
      evidenceHash: snapshot.scopeSha256,
      derivationKind: "OFFICIAL",
      lastVerifiedAt: snapshot.capturedAt,
    });
  }
  if (stationsById.size !== EXPECTED_UNIQUE_STATION_COUNT
    || stationLines.length !== EXPECTED_STATION_COUNT) {
    throw new Error("Incheon materialized station counts are invalid");
  }
  if (stationLines.filter(({ lineId }) => lineId === LINE7).length !== EXPECTED_LINE7_COUNT) {
    throw new Error("Incheon materialized line7 membership count is invalid");
  }

  const networkEdges = snapshot.edges.map((edge) => ({
    id: `edge-incheon-${edge.fromStationCode}-${edge.toStationCode}-${edge.lineId.slice(-6)}`,
    fromNodeId: `${edge.fromStationId}:${edge.lineId}`,
    toNodeId: `${edge.toStationId}:${edge.lineId}`,
    durationSeconds: edge.durationSeconds,
    distanceMeters: edge.distanceMeters,
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    serviceClass: "SUBWAY",
    includesStairs: false,
    stairAccessState: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 100,
    sourceId: SOURCE_ID,
    sourceSnapshotId: snapshotId,
    providerRecordHash: sha256(JSON.stringify(edge)),
    provenanceKind: "OFFICIAL_SOURCE",
    derivationKind: "OFFICIAL",
    verificationStatus: "VERIFIED",
    lastVerifiedAt: snapshot.capturedAt,
    evidenceHash: snapshot.edgesSha256,
  }));
  if (networkEdges.length !== EXPECTED_EDGE_COUNT
    || new Set(networkEdges.map(({ id }) => id)).size !== EXPECTED_EDGE_COUNT
    || networkEdges.some((edge) => edge.fromNodeId.endsWith(`:${LINE7}`))) {
    throw new Error("Incheon materialized edge counts are invalid");
  }

  const routeMapPositions = snapshot.positions.map((position) => ({
    stationId: position.stationId,
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
    sourceName: "인천교통공사_도시철도역사정보",
    sourceUrl: snapshot.detailUrl,
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
  }));
  if (routeMapPositions.length !== EXPECTED_POSITION_COUNT) {
    throw new Error("Incheon materialized route map position count is invalid");
  }

  pack.stations.push(...stationsById.values());
  pack.stationLines.push(...stationLines);
  pack.networkEdges.push(...networkEdges);
  pack.routeMapPositions = [...(pack.routeMapPositions ?? []), ...routeMapPositions];
  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    stations: pack.stations.length,
    station_lines: pack.stationLines.length,
    network_edges: pack.networkEdges.length,
    route_map_positions: pack.routeMapPositions.length,
  };

  const version = snapshotId.slice(-8);
  const composition = sha256(JSON.stringify({
    previousPackId: pack.id,
    snapshotId,
    contentSha256: snapshot.contentSha256,
    source,
    packContentSha256: materializedIncheonPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedIncheonPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function ensureSharedLine7(pack, fixture) {
  if (!pack.lines.some(({ id }) => id === LINE7)) {
    pack.lines.push({
      id: LINE7,
      operatorId: OPERATOR_ID,
      nameKo: LINE_METADATA[LINE7].nameKo,
      nameEn: "",
      color: LINE_METADATA[LINE7].color,
    });
  }
  const scope = {
    regionId: REGION_ID,
    operatorId: OPERATOR_ID,
    lineId: LINE7,
  };
  const packScopes = [...(pack.coverageLineOperatorScopes ?? [])];
  if (!packScopes.some((entry) => (
    entry.regionId === scope.regionId
      && entry.operatorId === scope.operatorId
      && entry.lineId === scope.lineId
  ))) {
    packScopes.push(scope);
    packScopes.sort((left, right) => (
      `${left.regionId}:${left.operatorId}:${left.lineId}`
        .localeCompare(`${right.regionId}:${right.operatorId}:${right.lineId}`, "en")
    ));
    pack.coverageLineOperatorScopes = packScopes;
  }
  if (fixture.coverageLineOperatorScopes !== undefined
    || fixture.coverageLineOperatorScopeSemantics !== undefined
    || pack.coverageLineOperatorScopes !== undefined) {
    const union = [...new Map(
      [...(fixture.coverageLineOperatorScopes ?? []), ...(pack.coverageLineOperatorScopes ?? [])]
        .map((entry) => [`${entry.regionId}:${entry.operatorId}:${entry.lineId}`, entry]),
    ).values()].sort((left, right) => (
      `${left.regionId}:${left.operatorId}:${left.lineId}`
        .localeCompare(`${right.regionId}:${right.operatorId}:${right.lineId}`, "en")
    ));
    fixture.coverageLineOperatorScopeSemantics = "UNION_OF_PACK_SCOPES";
    fixture.coverageLineOperatorScopes = union;
    pack.coverageLineOperatorScopes = union.filter((entry) => (
      pack.operators.some(({ id }) => id === entry.operatorId)
        && pack.lines.some(({ id }) => id === entry.lineId)
    ));
  }
}

function requiredSource(inventory, snapshot, snapshotSha256, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const topology = source?.topologyAdmissionEvidence;
  const membership = source?.membershipAdmissionEvidence;
  const routeMap = source?.routeMapAdmissionEvidence;
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  const mappingSha256 = sha256(JSON.stringify(snapshot.scope.map((station) => ({
    stationId: station.stationId,
    lineId: station.lineId,
    stationCode: station.stationCode,
    stationName: station.stationName,
  }))));
  const stationCodesSha256 = sha256(JSON.stringify(
    snapshot.scope.map(({ stationCode }) => stationCode),
  ));
  if (!/^[a-f0-9]{64}$/.test(snapshotSha256 ?? "") || routeMap?.snapshotSha256 !== snapshotSha256) {
    throw new Error("Incheon station info snapshot byte identity mismatch");
  }
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || topology?.issue !== 2481
    || topology.materializer !== "tools/datapack/materialize-incheon-station-info.mjs"
    || topology.verificationTest !== "tools/datapack/materialize-incheon-station-info.test.mjs"
    || topology.snapshotId !== "incheon-transit-station-info-20260724"
    || topology.snapshotPath !== "tools/datapack/sources/incheon-transit-station-info-20260724.json"
    || topology.capturedAt !== snapshot.capturedAt
    || topology.freshUntil !== snapshot.freshUntil
    || topology.stationCount !== EXPECTED_TOPOLOGY_STATION_COUNT
    || topology.edgeCount !== EXPECTED_EDGE_COUNT
    || topology.excludedTransferCount !== snapshot.excludedTransferCount
    || topology.rawSha256 !== snapshot.rawSha256
    || topology.contentSha256 !== snapshot.contentSha256
    || membership?.issue !== 2490
    || membership.materializer !== topology.materializer
    || membership.verificationTest !== topology.verificationTest
    || membership.snapshotId !== topology.snapshotId
    || JSON.stringify(membership.lineIds) !== JSON.stringify([...LINE_IDS])
    || membership.verifiedAt !== snapshot.capturedAt
    || membership.stationCount !== EXPECTED_STATION_COUNT
    || membership.membershipSourceId !== SOURCE_ID
    || membership.membershipSourceRawSha256 !== snapshot.rawSha256
    || membership.membershipSourceSnapshotSha256 !== snapshot.scopeSha256
    || membership.mappingSha256 !== mappingSha256
    || membership.stationCodesSha256 !== stationCodesSha256
    || membership.stationCodeSourceId !== SOURCE_ID
    || membership.stationCodeSnapshotId !== topology.snapshotId
    || membership.stationCodeContentSha256 !== snapshot.contentSha256
    || routeMap?.issue !== 2490
    || routeMap.admissionKind !== "official-file-latlon"
    || routeMap.materializer !== topology.materializer
    || routeMap.verificationTest !== topology.verificationTest
    || routeMap.snapshotId !== topology.snapshotId
    || routeMap.snapshotPath !== topology.snapshotPath
    || routeMap.capturedAt !== snapshot.capturedAt
    || routeMap.stationCount !== EXPECTED_POSITION_COUNT
    || routeMap.rawSha256 !== snapshot.rawSha256
    || routeMap.positionsSha256 !== snapshot.positionsSha256
    || JSON.stringify(routeMap.lineIds) !== JSON.stringify([...LINE_IDS])
    || JSON.stringify(routeMap.lineStationCounts) !== JSON.stringify(snapshot.lineStationCounts)
    || routeMap.observedDataUpdatedAt !== snapshot.observedDataUpdatedAt
    || routeMap.datasetId !== snapshot.datasetId
    || routeMap.topologySourceId !== SOURCE_ID
    || routeMap.topologySnapshotId !== topology.snapshotId
    || routeMap.topologyContentSha256 !== snapshot.contentSha256
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: [REGION_ID],
      operatorIds: [OPERATOR_ID],
      lineIds: [...LINE_IDS],
      sourceDomains: [
        "route_graph_topology",
        "route_map_positions",
        "station_line_membership",
      ],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify([...FIELDS_PROVIDED])
    || !Number.isFinite(observedNow)
    || observedNow < Date.parse(snapshot.capturedAt)
    || observedNow >= Date.parse(snapshot.freshUntil)
    || Date.parse(snapshot.freshUntil) !== Date.parse(snapshot.capturedAt) + FRESHNESS_MILLIS) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  return source;
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
  const expected = ["--base-fixture", "--snapshot", "--inventory", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-incheon-station-info.mjs --base-fixture <json> --snapshot <json> --inventory <json> --output <absolute.json>");
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
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const fixture = materializeIncheonStationInfo({
    baseFixture,
    snapshot,
    snapshotSha256: sha256(snapshotBytes),
    inventory,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `Incheon station info materialized: stations=${snapshot.stationCount} edges=${snapshot.edgeCount} positions=${snapshot.positionCount}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Incheon station info materialization failed");
    process.exitCode = 1;
  }
}
