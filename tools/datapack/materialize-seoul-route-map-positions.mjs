#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateSeoulRouteMapPositionsSnapshot } from "./collect-seoul-route-map-positions.mjs";

const SOURCE_ID = "seoul-metro-route-map-positions";
const CYBERSTATION_SOURCE_ID = "seoulmetro-cyberstation-route-map";
const PACK_ID = "nationwide-seoul-route-map";
const OPERATOR_ID = "seoul-metro";
const REGION = "수도권";
const EXPECTED_STATION_COUNT = 274;
const LINE_META = Object.freeze({
  "line-472a81add377": { nameKo: "수도권 1호선", nameEn: "Seoul Subway Line 1", color: "#052f93", line: "1" },
  "seoul-2": { nameKo: "수도권 2호선", nameEn: "Seoul Subway Line 2", color: "#10a643", line: "2" },
  "line-41a8c75ec9d8": { nameKo: "수도권 3호선", nameEn: "Seoul Subway Line 3", color: "#de6d00", line: "3" },
  "seoul-4": { nameKo: "수도권 4호선", nameEn: "Seoul Subway Line 4", color: "#00A5DE", line: "4" },
  "line-80fc4d5350d4": { nameKo: "수도권 5호선", nameEn: "Seoul Subway Line 5", color: "#a95094", line: "5" },
  "line-3f41718e0833": { nameKo: "수도권 6호선", nameEn: "Seoul Subway Line 6", color: "#d08d1a", line: "6" },
  "line-15b3b8a93259": { nameKo: "수도권 7호선", nameEn: "Seoul Subway Line 7", color: "#657931", line: "7" },
  "line-2b2d9eaa53d0": { nameKo: "수도권 8호선", nameEn: "Seoul Subway Line 8", color: "#e74e6d", line: "8" },
});
const LINE_IDS = Object.freeze(Object.keys(LINE_META));

export function materializeSeoulRouteMapPositions({
  baseFixture,
  snapshot,
  snapshotSha256,
  inventory,
  now = new Date(),
} = {}) {
  validateSeoulRouteMapPositionsSnapshot(snapshot);
  const source = requiredSource(inventory, snapshot, snapshotSha256, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Seoul route map positions require one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  if (!pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Seoul route map positions require seoul-metro operator pack");
  }
  // capital pilot cyberstation 자산은 유지한다(동일 station/line/region PK 충돌 시 FILE 행을 건너뛴다).
  if (!pack.sourceInventory.some(({ id }) => id === CYBERSTATION_SOURCE_ID)) {
    throw new Error("Seoul route map positions require preserved seoulmetro-cyberstation-route-map source");
  }

  ensureLines(pack);
  const stations = ensureStationsAndMembership(pack, snapshot);
  const existingKeys = new Set(
    (pack.routeMapPositions ?? []).map(({ stationId, lineId, region }) => `${stationId}:${lineId}:${region}`),
  );
  const rows = [];
  for (const position of snapshot.positions) {
    const stationId = stations.get(`${position.lineId}:${position.stationCode}`);
    if (!stationId) {
      throw new Error(`Seoul route map canonical station missing: ${position.lineId}:${position.stationCode}`);
    }
    const key = `${stationId}:${position.lineId}:${REGION}`;
    if (existingKeys.has(key)) continue;
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
      sourceName: "서울교통공사_1_8호선 역사 좌표(위경도) 정보",
      sourceUrl: snapshot.datasetUrl,
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
    existingKeys.add(key);
  }
  const materializedCount = rows.length;
  // capital cyberstation PK와 충돌하는 행만 건너뛴다. 충돌 0건이면 276 전량 허용.
  if (materializedCount < EXPECTED_STATION_COUNT - 2 || materializedCount > EXPECTED_STATION_COUNT) {
    throw new Error(`Seoul route map materialized row count mismatch: ${materializedCount}`);
  }
  const coveredLineIds = new Set([
    ...rows.map(({ lineId }) => lineId),
    ...(pack.routeMapPositions ?? [])
      .filter(({ sourceId }) => sourceId === CYBERSTATION_SOURCE_ID)
      .map(({ lineId }) => lineId),
  ]);
  for (const lineId of LINE_IDS) {
    if (!coveredLineIds.has(lineId)) {
      throw new Error(`Seoul route map missing line coverage: ${lineId}`);
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
    materializedCount,
    source,
    contentSha256: materializedSeoulRouteMapPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedSeoulRouteMapPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function requiredSource(inventory, snapshot, snapshotSha256, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.routeMapAdmissionEvidence;
  if (!/^[a-f0-9]{64}$/.test(snapshotSha256 ?? "") || evidence?.snapshotSha256 !== snapshotSha256) {
    throw new Error("Seoul route map snapshot byte identity mismatch");
  }
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.license.commercialUseAllowed !== true || source.license.derivativeWorkAllowed !== true
    || evidence?.issue !== 2470
    || evidence.admissionKind !== "official-file-latlon"
    || evidence.materializer !== "tools/datapack/materialize-seoul-route-map-positions.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-seoul-route-map-positions.test.mjs"
    || evidence.snapshotId !== "seoul-metro-route-map-positions-20260724"
    || evidence.snapshotPath !== "tools/datapack/sources/seoul-metro-route-map-positions-20260724.json"
    || evidence.capturedAt !== snapshot.capturedAt
    || evidence.stationCount !== snapshot.stationCount
    || evidence.datasetId !== snapshot.datasetId
    || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.positionsSha256 !== snapshot.positionsSha256
    || evidence.observedDataUpdatedAt !== snapshot.observedDataUpdatedAt
    || JSON.stringify(evidence.lineIds) !== JSON.stringify(snapshot.lineIds)
    || JSON.stringify(evidence.lineStationCounts) !== JSON.stringify(snapshot.lineStationCounts)
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["capital"],
      operatorIds: [OPERATOR_ID],
      lineIds: [...LINE_IDS],
      sourceDomains: ["route_map_positions"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)
    || !Number.isFinite(observedNow) || observedNow < Date.parse(snapshot.capturedAt)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  return source;
}

function ensureLines(pack) {
  const existing = new Set(pack.lines.map(({ id }) => id));
  for (const lineId of LINE_IDS) {
    if (existing.has(lineId)) continue;
    const meta = LINE_META[lineId];
    pack.lines.push({
      id: lineId,
      operatorId: OPERATOR_ID,
      nameKo: meta.nameKo,
      nameEn: meta.nameEn,
      color: meta.color,
    });
  }
  pack.lines.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function ensureStationsAndMembership(pack, snapshot) {
  const stationsById = new Map(pack.stations.map((station) => [station.id, station]));
  const stationLineKeys = new Set(pack.stationLines.map(({ stationId, lineId }) => `${stationId}:${lineId}`));
  const sequenceByLine = new Map(LINE_IDS.map((lineId) => [
    lineId,
    Math.max(0, ...pack.stationLines.filter((row) => row.lineId === lineId).map((row) => row.lineSequence)),
  ]));
  const mapping = new Map();
  for (const position of snapshot.positions) {
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
    const membershipKey = `${station.id}:${position.lineId}`;
    if (!stationLineKeys.has(membershipKey)) {
      const nextSequence = (sequenceByLine.get(position.lineId) ?? 0) + 1;
      sequenceByLine.set(position.lineId, nextSequence);
      pack.stationLines.push({
        stationId: station.id,
        lineId: position.lineId,
        stationCode: position.stationCode,
        lineSequence: nextSequence,
        platformInfo: "",
        sourceId: SOURCE_ID,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: snapshot.capturedAt,
      });
      stationLineKeys.add(membershipKey);
    }
    mapping.set(`${position.lineId}:${position.stationCode}`, station.id);
  }
  if (mapping.size !== EXPECTED_STATION_COUNT) {
    throw new Error(`Seoul route map station mapping size mismatch: ${mapping.size}`);
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
  return String(value).normalize("NFKC").replace(/\s+/g, "").replace(/\([^()]*\)$/, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const expected = ["--base-fixture", "--snapshot", "--inventory", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-seoul-route-map-positions.mjs --base-fixture <json> --snapshot <json> --inventory <json> --output <absolute.json>");
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
  const snapshot = JSON.parse(snapshotBytes);
  const fixture = materializeSeoulRouteMapPositions({
    baseFixture,
    snapshot,
    snapshotSha256: sha256(snapshotBytes),
    inventory,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Seoul route map positions materialized: stations=${snapshot.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Seoul route map position materialization failed");
    process.exitCode = 1;
  }
}
