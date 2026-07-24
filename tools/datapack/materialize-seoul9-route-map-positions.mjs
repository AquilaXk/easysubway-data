#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateSeoul9RouteMapPositionsSnapshot } from "./collect-seoul9-route-map-positions.mjs";

const SOURCE_ID = "seoul-metro-line9-23-route-map-positions";
const TOPOLOGY_SOURCE_ID = "capital-route-topology";
const TOPOLOGY_SNAPSHOT_ID = "capital-route-topology-20260724";
const PACK_ID = "nationwide-seoul9-route-map";
const FILE_OPERATOR_ID = "seoul-metro";
const FILE_OPERATOR_NAME_KO = "서울교통공사";
const LINE_OPERATOR_ID = "operator-936e454d0bfb";
const LINE_OPERATOR_NAME_KO = "서울시메트로9호선";
const COVERAGE_OPERATOR_IDS = Object.freeze([FILE_OPERATOR_ID, LINE_OPERATOR_ID]);
const REGION = "수도권";
const LINE_ID = "line-f0e747248a31";
const LINE_NUMBER = "9";
const LINE_COLOR = "#B7A156";
const LINE_NAME_KO = "수도권 9호선";
const LINE_NAME_EN = "Seoul Subway Line 9";
const LINE_IDS = Object.freeze([LINE_ID]);
const EXPECTED_STATION_COUNT = 13;
const FILE_STATION_CODES = Object.freeze(
  Array.from({ length: EXPECTED_STATION_COUNT }, (_, index) => String(926 + index)),
);
const CANONICAL_STATION_NAMES = Object.freeze([
  "언주",
  "선정릉",
  "삼성중앙",
  "봉은사",
  "종합운동장",
  "삼전",
  "석촌고분",
  "석촌",
  "송파나루",
  "한성백제",
  "올림픽공원",
  "둔촌오륜",
  "중앙보훈병원",
]);
const SNAPSHOT_ID = "seoul-metro-line9-23-route-map-positions-20260725";
const SNAPSHOT_PATH = "tools/datapack/sources/seoul-metro-line9-23-route-map-positions-20260725.json";
const SOURCE_NAME = "서울교통공사_9호선 2·3단계 역사 좌표(위경도) 정보";

export function materializeSeoul9RouteMapPositions({
  baseFixture,
  snapshot,
  snapshotSha256,
  topologySnapshot,
  inventory,
  now = new Date(),
} = {}) {
  validateSeoul9RouteMapPositionsSnapshot(snapshot);
  const source = requiredSource(inventory, snapshot, snapshotSha256, topologySnapshot, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Seoul9 route map positions require one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }

  validateTopologyLineage(source.routeMapAdmissionEvidence, topologySnapshot);
  ensureOperator(pack, FILE_OPERATOR_ID, FILE_OPERATOR_NAME_KO);
  ensureOperator(pack, LINE_OPERATOR_ID, LINE_OPERATOR_NAME_KO);
  ensureLine(pack);
  ensureCoverageLineOperatorScopes(fixture, pack);
  const stations = ensureStationsAndMembership(pack, snapshot);
  const rows = [];
  for (const position of snapshot.positions) {
    const stationId = stations.get(position.stationId);
    if (!stationId) {
      throw new Error(`Seoul9 route map canonical station missing: ${position.stationId}`);
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
      sourceName: SOURCE_NAME,
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
    throw new Error(`Seoul9 route map materialized row count mismatch: ${rows.length}`);
  }
  const coveredLineIds = new Set(rows.map(({ lineId }) => lineId));
  for (const lineId of LINE_IDS) {
    if (!coveredLineIds.has(lineId)) {
      throw new Error(`Seoul9 route map missing line coverage: ${lineId}`);
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
    contentSha256: materializedSeoul9RouteMapPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedSeoul9RouteMapPackContentHash(pack, version) {
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
    throw new Error("Seoul9 route map snapshot byte identity mismatch");
  }
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.license.commercialUseAllowed !== true || source.license.derivativeWorkAllowed !== true
    || evidence?.issue !== 2498
    || evidence.admissionKind !== "official-file-latlon"
    || evidence.materializer !== "tools/datapack/materialize-seoul9-route-map-positions.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-seoul9-route-map-positions.test.mjs"
    || evidence.snapshotId !== SNAPSHOT_ID
    || evidence.snapshotPath !== SNAPSHOT_PATH
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
      operatorIds: [...COVERAGE_OPERATOR_IDS],
      lineIds: [...LINE_IDS],
      sourceDomains: ["route_map_positions"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)
    || !Number.isFinite(observedNow) || observedNow < Date.parse(snapshot.capturedAt)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  validateTopologyLineage(evidence, topologySnapshot);
  return source;
}

function validateTopologyLineage(evidence, topologySnapshot) {
  // capital-route-topology는 inventory 필수 항목이 아니다(대형 capital topology admission 분리).
  const lineage = evidence?.topologyLineages?.[0];
  const line = Array.isArray(topologySnapshot?.lines)
    ? topologySnapshot.lines.find(({ lineId }) => lineId === LINE_ID)
    : null;
  const scopeNames = new Set(
    (line?.scope ?? []).map(({ stationName }) => normalizeStationName(stationName)),
  );
  const hasCanonicalNames = CANONICAL_STATION_NAMES.every((name) =>
    scopeNames.has(normalizeStationName(name)));
  if (evidence?.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== topologySnapshot?.contentSha256
    || topologySnapshot?.sourceId !== TOPOLOGY_SOURCE_ID
    || !/^[a-f0-9]{64}$/.test(topologySnapshot?.contentSha256 ?? "")
    || !line
    || !Array.isArray(line.scope)
    || line.stationCount !== 38
    || !hasCanonicalNames
    || lineage?.sourceId !== TOPOLOGY_SOURCE_ID
    || lineage.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || lineage.contentSha256 !== topologySnapshot.contentSha256
    || lineage.lineId !== LINE_ID) {
    throw new Error("Seoul9 route map topology lineage mismatch");
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

function ensureLine(pack) {
  if (!Array.isArray(pack.lines)) pack.lines = [];
  if (pack.lines.some(({ id }) => id === LINE_ID)) return;
  pack.lines.push({
    id: LINE_ID,
    operatorId: LINE_OPERATOR_ID,
    nameKo: LINE_NAME_KO,
    nameEn: LINE_NAME_EN,
    color: LINE_COLOR,
  });
  pack.lines.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function ensureCoverageLineOperatorScopes(fixture, pack) {
  const scopes = COVERAGE_OPERATOR_IDS.map((operatorId) => ({
    regionId: "capital",
    operatorId,
    lineId: LINE_ID,
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

function ensureStationsAndMembership(pack, snapshot) {
  if (!Array.isArray(pack.stations)) pack.stations = [];
  if (!Array.isArray(pack.stationLines)) pack.stationLines = [];
  const stationsById = new Map(pack.stations.map((station) => [station.id, station]));
  const stationLineByKey = new Map(
    pack.stationLines.map((row) => [`${row.stationId}:${row.lineId}`, row]),
  );
  const mapping = new Map();
  for (const position of snapshot.positions) {
    if (position.lineId !== LINE_ID || !FILE_STATION_CODES.includes(position.stationCode)) {
      throw new Error(`Seoul9 route map unexpected position: ${position.stationCode}`);
    }
    const packCode = String(Number(position.stationCode) - 900);
    if (!/^(2[6-9]|3[0-8])$/.test(packCode)) {
      throw new Error(`Seoul9 route map pack station code out of range: ${packCode}`);
    }
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
        sourceId: SOURCE_ID,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: snapshot.capturedAt,
      };
      pack.stations.push(station);
      stationsById.set(station.id, station);
    } else if (station.latitude == null || station.longitude == null) {
      station.latitude = position.latitude;
      station.longitude = position.longitude;
    }
    const membershipKey = `${station.id}:${LINE_ID}`;
    let membership = stationLineByKey.get(membershipKey);
    if (!membership) {
      membership = {
        stationId: station.id,
        lineId: LINE_ID,
        stationCode: packCode,
        lineSequence: Number(packCode),
        platformInfo: "",
        sourceId: SOURCE_ID,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: snapshot.capturedAt,
      };
      pack.stationLines.push(membership);
      stationLineByKey.set(membershipKey, membership);
    } else {
      const provenanceSourceId = membership.fieldProvenance?.station_code?.sourceId;
      if (provenanceSourceId != null
        && provenanceSourceId !== SOURCE_ID
        && provenanceSourceId !== TOPOLOGY_SOURCE_ID) {
        throw new Error(`Seoul9 route map station_code provenance mismatch: ${membershipKey}`);
      }
      if (String(membership.stationCode) !== packCode) {
        throw new Error(`Seoul9 route map pack station code mismatch: ${membershipKey}`);
      }
      if (membership.lineSequence !== Number(packCode)) {
        throw new Error(`Seoul9 route map lineSequence mismatch: ${membershipKey}`);
      }
    }
    mapping.set(position.stationId, station.id);
  }
  if (mapping.size !== EXPECTED_STATION_COUNT) {
    throw new Error(`Seoul9 route map station mapping size mismatch: ${mapping.size}`);
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
    throw new Error("usage: materialize-seoul9-route-map-positions.mjs --base-fixture <json> --snapshot <json> --inventory <json> --topology <json> --output <absolute.json>");
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
  const fixture = materializeSeoul9RouteMapPositions({
    baseFixture,
    snapshot,
    snapshotSha256: sha256(snapshotBytes),
    topologySnapshot,
    inventory,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Seoul9 route map positions materialized: stations=${snapshot.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Seoul9 route map position materialization failed");
    process.exitCode = 1;
  }
}
