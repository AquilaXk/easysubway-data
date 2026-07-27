#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ISSUE,
  getCapitalWideRailRouteMapPositionLine,
  validateCapitalWideRailRouteMapPositionsSnapshot,
} from "./collect-kric-capital-wide-rail-route-map-positions.mjs";
import { assertRouteMapAdmissionFreshness } from "./lib/route-map-admission-freshness.mjs";

const TOPOLOGY_SOURCE_ID = "capital-route-topology";
const TOPOLOGY_SNAPSHOT_ID = "capital-route-topology-20260724";
const PACK_ID_PREFIX = "nationwide-capital-wide-rail-route-map";
const REGION = "수도권";
const MATERIALIZER = "tools/datapack/materialize-kric-capital-wide-rail-route-map-positions.mjs";
const VERIFICATION_TEST = "tools/datapack/materialize-kric-capital-wide-rail-route-map-positions.test.mjs";

export function materializeCapitalWideRailRouteMapPositions({
  baseFixture,
  snapshot,
  snapshotSha256,
  topologySnapshot,
  inventory,
  now = new Date(),
} = {}) {
  validateCapitalWideRailRouteMapPositionsSnapshot(snapshot);
  const line = getCapitalWideRailRouteMapPositionLine(snapshot.sourceId);
  const source = requiredSource(inventory, snapshot, snapshotSha256, topologySnapshot, line, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("capital-wide rail route map positions require one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === line.sourceId)) {
    throw new Error(`${line.sourceId} already exists`);
  }

  validateTopologyLineage(source.routeMapAdmissionEvidence, topologySnapshot, line);
  for (const { operatorId, nameKo } of coverageOperators(line)) {
    ensureOperator(pack, operatorId, nameKo);
  }
  ensureLine(pack, line);
  ensureCoverageLineOperatorScopes(fixture, pack, line);
  const stations = ensureStationsAndMembership(pack, snapshot, line);
  const rows = [];
  for (const position of snapshot.positions) {
    const stationId = stations.get(position.stationId);
    if (!stationId) {
      throw new Error(`${line.sourceId} canonical station missing: ${position.stationId}`);
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
      sourceId: line.sourceId,
      sourceName: source.displayName,
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
  if (rows.length !== line.expectedStationCount) {
    throw new Error(`${line.sourceId} materialized row count mismatch: ${rows.length}`);
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
    contentSha256: materializedCapitalWideRailRouteMapPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID_PREFIX}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedCapitalWideRailRouteMapPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

// 이 노선을 덮는 운영기관 집합(저장소 정본). 노선 자체의 운영기관이 항상 첫 항목이며, 노선을 나눠
// 운영하는 두 번째 사업자가 있으면 카탈로그가 additionalCoverageOperators로 등재한다. 이 집합은
// admission 정본(coverageScope.operatorIds)과 순서까지 전량 대조되고 pack coverage scope 선언에도 같이
// 쓰이므로, 카탈로그가 임의 운영기관을 주장하면 정본 대조에서 그대로 거부된다.
function coverageOperators(line) {
  const additional = line.additionalCoverageOperators ?? [];
  const operators = [{ operatorId: line.operatorId, nameKo: line.operatorNameKo }, ...additional];
  const operatorIds = operators.map(({ operatorId }) => operatorId);
  if (new Set(operatorIds).size !== operatorIds.length
    || operators.some(({ operatorId, nameKo }) => typeof operatorId !== "string" || operatorId.trim() === ""
      || typeof nameKo !== "string" || nameKo.trim() === "")) {
    throw new Error(`${line.sourceId} coverage operators are invalid`);
  }
  return operators;
}

function requiredSource(inventory, snapshot, snapshotSha256, topologySnapshot, line, now) {
  const source = inventory?.sources?.find(({ id }) => id === line.sourceId);
  const evidence = source?.routeMapAdmissionEvidence;
  const snapshotId = `${line.sourceId}-20260725`;
  const snapshotPath = `tools/datapack/sources/${snapshotId}.json`;
  if (!/^[a-f0-9]{64}$/.test(snapshotSha256 ?? "") || evidence?.snapshotSha256 !== snapshotSha256) {
    throw new Error(`${line.sourceId} snapshot byte identity mismatch`);
  }
  const observedNow = assertRouteMapAdmissionFreshness(evidence, now, line.sourceId);
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.license.commercialUseAllowed !== true || source.license.derivativeWorkAllowed !== true
    || evidence?.issue !== ISSUE
    || evidence.admissionKind !== "official-file-latlon"
    || evidence.materializer !== MATERIALIZER
    || evidence.verificationTest !== VERIFICATION_TEST
    || evidence.snapshotId !== snapshotId
    || evidence.snapshotPath !== snapshotPath
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
      regionIds: ["capital"],
      operatorIds: coverageOperators(line).map(({ operatorId }) => operatorId),
      lineIds: [line.lineId],
      sourceDomains: ["route_map_positions"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)
    || !Number.isFinite(observedNow) || observedNow < Date.parse(snapshot.capturedAt)) {
    throw new Error(`${line.sourceId} inventory evidence does not match snapshot`);
  }
  validateTopologyLineage(evidence, topologySnapshot, line);
  return source;
}

function validateTopologyLineage(evidence, topologySnapshot, line) {
  const lineage = evidence?.topologyLineages?.[0];
  const topologyLine = Array.isArray(topologySnapshot?.lines)
    ? topologySnapshot.lines.find(({ lineId }) => lineId === line.lineId)
    : null;
  const topologyNames = new Set();
  for (const entry of topologyLine?.scope ?? []) {
    topologyNames.add(normalizeStationName(entry.stationName));
  }
  for (const branch of topologyLine?.branchSequences ?? []) {
    for (const stationName of branch.stationNames ?? []) {
      topologyNames.add(normalizeStationName(stationName));
    }
  }
  if (evidence?.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== topologySnapshot?.contentSha256
    || topologySnapshot?.sourceId !== TOPOLOGY_SOURCE_ID
    || !/^[a-f0-9]{64}$/.test(topologySnapshot?.contentSha256 ?? "")
    || !topologyLine
    || !Array.isArray(topologyLine.scope)
    || lineage?.sourceId !== TOPOLOGY_SOURCE_ID
    || lineage.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || lineage.contentSha256 !== topologySnapshot.contentSha256
    || lineage.lineId !== line.lineId) {
    throw new Error(`${line.sourceId} topology lineage mismatch`);
  }
}

function ensureOperator(pack, operatorId, nameKo) {
  if (!Array.isArray(pack.operators)) pack.operators = [];
  if (pack.operators.some(({ id }) => id === operatorId)) return;
  pack.operators.push({
    id: operatorId,
    nameKo,
    nameEn: "",
  });
  pack.operators.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function ensureLine(pack, line) {
  if (!Array.isArray(pack.lines)) pack.lines = [];
  if (pack.lines.some(({ id }) => id === line.lineId)) return;
  pack.lines.push({
    id: line.lineId,
    operatorId: line.operatorId,
    nameKo: line.lineNameKo,
    nameEn: line.lineNameEn,
    color: line.lineColor,
  });
  pack.lines.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function ensureCoverageLineOperatorScopes(fixture, pack, line) {
  const scopes = coverageOperators(line).map(({ operatorId }) => ({
    regionId: "capital",
    operatorId,
    lineId: line.lineId,
  }));
  const packScopes = [...(pack.coverageLineOperatorScopes ?? [])];
  for (const scope of scopes) {
    if (!packScopes.some((entry) => (
      entry.regionId === scope.regionId
        && entry.operatorId === scope.operatorId
        && entry.lineId === scope.lineId
    ))) {
      packScopes.push(scope);
    }
  }
  packScopes.sort((left, right) => (
    `${left.regionId}:${left.operatorId}:${left.lineId}`
      .localeCompare(`${right.regionId}:${right.operatorId}:${right.lineId}`, "en")
  ));
  pack.coverageLineOperatorScopes = packScopes;
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

function ensureStationsAndMembership(pack, snapshot, line) {
  if (!Array.isArray(pack.stations)) pack.stations = [];
  if (!Array.isArray(pack.stationLines)) pack.stationLines = [];
  const stationsById = new Map(pack.stations.map((station) => [station.id, station]));
  const stationLineByKey = new Map(
    pack.stationLines.map((row) => [`${row.stationId}:${row.lineId}`, row]),
  );
  const mapping = new Map();
  for (const position of snapshot.positions) {
    if (position.lineId !== line.lineId) {
      throw new Error(`${line.sourceId} unexpected position line: ${position.lineId}`);
    }
    const packCode = String(position.stationCode);
    let station = stationsById.get(position.stationId);
    if (!station) {
      station = {
        id: position.stationId,
        nameKo: position.stationName,
        nameEn: "",
        normalizedName: normalizeStationName(position.stationName),
        region: REGION,
        latitude: position.latitude,
        longitude: position.longitude,
        dataQualityLevel: "LEVEL_2",
        dataSourceType: "OFFICIAL_FILE",
        sourceId: line.sourceId,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: snapshot.capturedAt,
      };
      pack.stations.push(station);
      stationsById.set(station.id, station);
    } else if (station.latitude == null || station.longitude == null) {
      station.latitude = position.latitude;
      station.longitude = position.longitude;
    }
    const membershipKey = `${station.id}:${line.lineId}`;
    let membership = stationLineByKey.get(membershipKey);
    if (!membership) {
      membership = {
        stationId: station.id,
        lineId: line.lineId,
        stationCode: packCode,
        lineSequence: Number(packCode),
        platformInfo: "",
        sourceId: line.sourceId,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: snapshot.capturedAt,
      };
      pack.stationLines.push(membership);
      stationLineByKey.set(membershipKey, membership);
    } else {
      const provenanceSourceId = membership.fieldProvenance?.station_code?.sourceId;
      if (provenanceSourceId != null
        && provenanceSourceId !== line.sourceId
        && provenanceSourceId !== TOPOLOGY_SOURCE_ID) {
        throw new Error(`${line.sourceId} station_code provenance mismatch: ${membershipKey}`);
      }
      if (String(membership.stationCode) !== packCode) {
        throw new Error(`${line.sourceId} pack station code mismatch: ${membershipKey}`);
      }
    }
    mapping.set(position.stationId, station.id);
  }
  if (mapping.size !== line.expectedStationCount) {
    throw new Error(`${line.sourceId} station mapping size mismatch: ${mapping.size}`);
  }
  return mapping;
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

function normalizeStationName(value) {
  return String(value).normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/\([^()]*\)$/, "")
    .replace(/역$/, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const expected = ["--base-fixture", "--snapshot", "--inventory", "--topology", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-kric-capital-wide-rail-route-map-positions.mjs --base-fixture <json> --snapshot <json> --inventory <json> --topology <json> --output <absolute.json>");
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
  const fixture = materializeCapitalWideRailRouteMapPositions({
    baseFixture,
    snapshot,
    snapshotSha256: sha256(snapshotBytes),
    topologySnapshot,
    inventory,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${snapshot.sourceId} materialized: stations=${snapshot.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "capital-wide rail route map position materialization failed");
    process.exitCode = 1;
  }
}
