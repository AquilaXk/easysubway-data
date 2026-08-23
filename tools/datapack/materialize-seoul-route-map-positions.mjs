#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalSeoulRouteMapStationName,
  validateSeoulRouteMapPositionsSnapshot,
} from "./collect-seoul-route-map-positions.mjs";
import { assertRouteMapAdmissionFreshness } from "./lib/route-map-admission-freshness.mjs";

const SOURCE_ID = "seoul-metro-route-map-positions";
const PACK_ID = "nationwide-seoul-route-map";
const OPERATOR_ID = "seoul-metro";
const REGION = "수도권";
export const CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS = Object.freeze([
  "incheon-transit", "korail", "operator-07a9e77a02b6", "seoul-metro",
]);
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
export const CURRENT_SEOUL_PUBLIC_ROUTE_MAP_COVERAGE = Object.freeze({
  regionId: "capital",
  operatorId: OPERATOR_ID,
  sourceDomain: "route_map_positions",
  sourceIds: [SOURCE_ID],
  evidence: "승인된 공공 좌표 snapshot과 versioned deterministic layout",
});

export function materializeSeoulRouteMapPositions({
  baseFixture,
  snapshot,
  routeMapLayoutArtifact = snapshot,
  snapshotSha256,
  topologySnapshotBytes,
  inventory,
  now = new Date(),
  rewritePackIdentity = true,
  successorProviderRecordHashes = null,
  requireSuccessorProviderRecordHashes = false,
} = {}) {
  if (typeof rewritePackIdentity !== "boolean"
    || typeof requireSuccessorProviderRecordHashes !== "boolean") {
    throw new Error("Seoul route map pack identity rewrite mode is invalid");
  }
  const observation = snapshot;
  routeMapLayoutArtifact = observation?.routeMapLayoutArtifact ?? routeMapLayoutArtifact;
  const layoutArtifactSha256 = sha256(Buffer.from(`${JSON.stringify(routeMapLayoutArtifact)}\n`));
  validateSeoulRouteMapPositionsSnapshot(routeMapLayoutArtifact, { topologySnapshotBytes });
  const source = requiredSource(inventory, routeMapLayoutArtifact, snapshotSha256, layoutArtifactSha256, now);
  const providerRecordHashes = requiredProviderRecordHashes(
    routeMapLayoutArtifact.rawPositions,
    successorProviderRecordHashes,
    requireSuccessorProviderRecordHashes,
  );
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Seoul route map positions require one cumulative production pack");
  }
  if (!pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Seoul route map positions require seoul-metro operator pack");
  }
  ensureLines(pack);
  const layoutByKey = new Map(routeMapLayoutArtifact.layoutPositions.map((row) => [`${row.lineId}:${row.stationCode}`, row]));
  if (layoutByKey.size !== routeMapLayoutArtifact.rawPositions.length) throw new Error("Seoul route map layout position identity mismatch");
  const stations = ensureStationsAndMembership(pack, routeMapLayoutArtifact, layoutByKey);
  const replacementKeys = new Set(routeMapLayoutArtifact.rawPositions.map((position) => {
    const stationId = stations.get(`${position.lineId}:${position.stationCode}`);
    return `${stationId}:${position.lineId}:${REGION}`;
  }));
  const rows = [];
  for (const [index, position] of routeMapLayoutArtifact.rawPositions.entries()) {
    const stationId = stations.get(`${position.lineId}:${position.stationCode}`);
    if (!stationId) {
      throw new Error(`Seoul route map canonical station missing: ${position.lineId}:${position.stationCode}`);
    }
    const key = `${stationId}:${position.lineId}:${REGION}`;
    const layout = layoutByKey.get(`${position.lineId}:${position.stationCode}`);
    if (!layout) throw new Error(`Seoul route map layout missing raw position: ${position.lineId}:${position.stationCode}`);
    rows.push({
      stationId,
      lineId: position.lineId,
      region: REGION,
      x: layout.canvasX, y: layout.canvasY,
      labelDx: layout.labelDx, labelDy: layout.labelDy, labelPolygon: structuredClone(layout.labelPolygon),
      upPath: "",
      downPath: "",
      sourceId: SOURCE_ID,
      sourceName: "서울교통공사_1_8호선 역사 좌표(위경도) 정보",
      sourceUrl: routeMapLayoutArtifact.datasetUrl,
      sourceSha256: routeMapLayoutArtifact.rawSha256,
      license: source.license.name,
      licenseStatus: "redistributable",
      commercialUseAllowed: true,
      attributionRequired: false,
      derivationKind: "GENERATED",
      provenanceKind: "OFFICIAL_SOURCE",
      sourceSnapshotId: source.routeMapAdmissionEvidence.currentLayoutAdmission.positionSnapshotId,
      providerRecordHash: providerRecordHashes?.[index] ?? sha256(JSON.stringify(position)),
      evidenceHash: source.routeMapAdmissionEvidence.currentLayoutAdmission.layoutArtifactSha256,
      sourceLabel: position.stationName,
      reviewedAt: routeMapLayoutArtifact.capturedAt, updatedAt: routeMapLayoutArtifact.capturedAt,
    });
  }
  const materializedCount = rows.length;
  const coveredLineIds = new Set(rows.map(({ lineId }) => lineId));
  for (const lineId of LINE_IDS) {
    if (!coveredLineIds.has(lineId)) {
      throw new Error(`Seoul route map missing line coverage: ${lineId}`);
    }
  }

  pack.sourceInventory = (pack.sourceInventory ?? []).filter(({ id }) => id !== SOURCE_ID && id !== "seoulmetro-cyberstation-route-map");
  pack.sourceInventory.push(packSource(source, routeMapLayoutArtifact));
  pack.routeMapPositions = (pack.routeMapPositions ?? []).filter((row) => !replacementKeys.has(`${row.stationId}:${row.lineId}:${row.region}`) && row.sourceId !== "seoulmetro-cyberstation-route-map").concat(rows);
  const tracks = materializeTracks(routeMapLayoutArtifact, source);
  pack.routeMapLineTracks = (pack.routeMapLineTracks ?? []).filter((row) => !(row.region === REGION && LINE_IDS.includes(row.lineId))).concat(tracks);
  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    route_map_positions: pack.routeMapPositions.length,
    route_map_line_tracks: pack.routeMapLineTracks.length,
  };
  if (rewritePackIdentity) {
    const version = routeMapLayoutArtifact.capturedAt.slice(0, 10).replaceAll("-", "");
    const composition = sha256(JSON.stringify({
      previousPackId: pack.id,
      snapshotId: source.routeMapAdmissionEvidence.currentLayoutAdmission.positionSnapshotId,
      rawPositionsSha256: routeMapLayoutArtifact.rawPositionsSha256,
      layoutPositionsSha256: routeMapLayoutArtifact.layoutPositionsSha256,
      layoutTracksSha256: routeMapLayoutArtifact.layoutTracksSha256,
      lineOrderSha256: routeMapLayoutArtifact.lineOrderSha256,
      topologySnapshotSha256: routeMapLayoutArtifact.topologySnapshotSha256,
      aliasLedgerSha256: routeMapLayoutArtifact.aliasLedgerSha256,
      semanticInputSha256: routeMapLayoutArtifact.semanticInputSha256,
      semanticOutputSha256: routeMapLayoutArtifact.semanticOutputSha256,
      materializedCount,
      source,
      contentSha256: materializedSeoulRouteMapPackContentHash(pack, version),
    }));
    pack.id = `${PACK_ID}-${composition}`;
    pack.version = version;
    pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
    fixture.manifest.activePack = { id: pack.id, version };
  }
  return fixture;
}

function requiredProviderRecordHashes(rawPositions, hashes, required) {
  if (hashes == null && !required) return null;
  if (!Array.isArray(hashes)
    || hashes.length !== rawPositions.length
    || new Set(hashes).size !== hashes.length
    || hashes.some((value) => !/^[a-f0-9]{64}$/u.test(value ?? ""))) {
    throw new Error("Seoul route map successor provider record hashes are invalid");
  }
  return hashes;
}

function materializeTracks(artifact, source) {
  const nextIndex = new Map();
  return artifact.layoutTracks.map((track) => {
    const trackIndex = nextIndex.get(track.lineId) ?? 0; nextIndex.set(track.lineId, trackIndex + 1);
    if (!LINE_META[track.lineId] || !Array.isArray(track.points) || track.points.length < 2) throw new Error("Seoul route map layout track is invalid");
    return { lineId: track.lineId, region: REGION, trackIndex, path: `M ${track.points.map(({ x, y }) => `${x},${y}`).join(" L ")}`,
      svgColor: LINE_META[track.lineId].color, sourceId: SOURCE_ID, sourceUrl: artifact.datasetUrl, sourceSha256: artifact.rawSha256,
      sourceName: "서울교통공사_1_8호선 역사 좌표(위경도) 정보", license: source.license.name, licenseStatus: "redistributable",
      commercialUseAllowed: true, attributionRequired: false, derivationKind: "GENERATED", provenanceKind: "OFFICIAL_SOURCE", evidenceHash: artifact.semanticOutputSha256,
      reviewedAt: artifact.capturedAt, updatedAt: artifact.capturedAt };
  });
}

export function materializedSeoulRouteMapPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

export function verifyCurrentCapitalPublicRouteMapDocument(document, successor, label) {
  const artifact = successor?.routeMapLayoutArtifact ?? successor;
  const pack = document?.packs?.find(({ id }) => id === "capital");
  const publicRows = pack?.routeMapPositions?.filter(({ sourceId }) => sourceId === SOURCE_ID) ?? [];
  const publicTracks = pack?.routeMapLineTracks?.filter(({ sourceId }) => sourceId === SOURCE_ID) ?? [];
  const rawPositions = artifact?.rawPositions;
  const layoutPositions = artifact?.layoutPositions;
  const layoutTracks = artifact?.layoutTracks;
  let coverageEvidence;
  try { coverageEvidence = JSON.parse(pack?.metadata?.productionCoverageEvidence ?? ""); } catch {
    coverageEvidence = null;
  }
  const routeMapCoverage = coverageEvidence?.filter(({ sourceDomain }) =>
    sourceDomain === "route_map_positions") ?? [];
  if (pack?.id !== "capital"
    || document.manifest?.activePack?.id !== "capital"
    || document.manifest.activePack?.version !== pack.version
    || !Array.isArray(rawPositions)
    || !Array.isArray(layoutPositions)
    || !Array.isArray(layoutTracks)
    || publicRows.length !== rawPositions.length
    || publicTracks.length !== layoutTracks.length
    || new Set(publicRows.map(({ lineId }) => lineId)).size !== LINE_IDS.length
    || new Set(publicTracks.map(({ lineId }) => lineId)).size !== LINE_IDS.length
    || routeMapCoverage.length !== 1
    || JSON.stringify(routeMapCoverage[0]) !== JSON.stringify(CURRENT_SEOUL_PUBLIC_ROUTE_MAP_COVERAGE)
    || coverageEvidence?.some(({ sourceIds }) =>
      Array.isArray(sourceIds) && sourceIds.includes("seoulmetro-cyberstation-route-map")) !== false
    || pack.routeMapPositions.some(({ sourceId }) => sourceId === "seoulmetro-cyberstation-route-map")
    || pack.sourceInventory?.filter(({ id }) => id === SOURCE_ID).length !== 1
    || pack.sourceInventory?.some(({ id }) => id === "seoulmetro-cyberstation-route-map")) {
    throw new Error(`${label} must contain the complete current public Seoul route map`);
  }

  const rawByKey = new Map(rawPositions.map((row) => [`${row.lineId}:${row.stationCode}`, row]));
  const layoutByKey = new Map(layoutPositions.map((row) => [`${row.lineId}:${row.stationCode}`, row]));
  const rowByKey = new Map(publicRows.map((row) => [`${row.lineId}:${row.sourceLabel}`, row]));
  const providerRecordHashes = successor?.providerRecordHashes;
  const layoutArtifactSha256 = successor?.routeMapLayoutEvidence?.layoutArtifactSha256
    ?? sha256(Buffer.from(`${JSON.stringify(artifact)}\n`));
  const stationIds = new Set(pack.stations.map(({ id }) => id));
  const memberships = new Set(pack.stationLines.map(({ stationId, lineId }) => `${stationId}:${lineId}`));
  if (rawByKey.size !== rawPositions.length
    || layoutByKey.size !== layoutPositions.length
    || rowByKey.size !== publicRows.length
    || providerRecordHashes != null && providerRecordHashes.length !== rawPositions.length) {
    throw new Error(`${label} must contain the complete current public Seoul route map`);
  }
  for (const [index, raw] of rawPositions.entries()) {
    const layout = layoutByKey.get(`${raw.lineId}:${raw.stationCode}`);
    const row = rowByKey.get(`${raw.lineId}:${raw.stationName}`);
    const expectedProviderHash = providerRecordHashes?.[index] ?? sha256(JSON.stringify(raw));
    if (!layout || !row
      || !stationIds.has(row.stationId)
      || !memberships.has(`${row.stationId}:${row.lineId}`)
      || row.x !== layout.canvasX || row.y !== layout.canvasY
      || row.labelDx !== layout.labelDx || row.labelDy !== layout.labelDy
      || JSON.stringify(row.labelPolygon) !== JSON.stringify(layout.labelPolygon)
      || row.sourceSha256 !== artifact.rawSha256
      || row.providerRecordHash !== expectedProviderHash
      || row.evidenceHash !== layoutArtifactSha256
      || successor?.snapshotId != null && row.sourceSnapshotId !== successor.snapshotId) {
      throw new Error(`${label} must contain the complete current public Seoul route map`);
    }
  }

  const trackIndex = new Map();
  for (const artifactTrack of layoutTracks) {
    const index = trackIndex.get(artifactTrack.lineId) ?? 0;
    trackIndex.set(artifactTrack.lineId, index + 1);
    const matches = publicTracks.filter(({ lineId, trackIndex: actualIndex }) =>
      lineId === artifactTrack.lineId && actualIndex === index);
    const expectedPath = `M ${artifactTrack.points.map(({ x, y }) => `${x},${y}`).join(" L ")}`;
    if (matches.length !== 1
      || matches[0].region !== REGION
      || matches[0].path !== expectedPath
      || matches[0].sourceSha256 !== artifact.rawSha256
      || matches[0].evidenceHash !== artifact.semanticOutputSha256) {
      throw new Error(`${label} must contain the complete current public Seoul route map`);
    }
  }
  return document;
}

function requiredSource(inventory, snapshot, snapshotSha256, layoutArtifactSha256, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.routeMapAdmissionEvidence;
  const admission = evidence?.currentLayoutAdmission;
  if (!/^[a-f0-9]{64}$/.test(snapshotSha256 ?? "") || admission?.snapshotSha256 !== snapshotSha256) {
    throw new Error("Seoul route map snapshot byte identity mismatch");
  }
  const observedNow = assertRouteMapAdmissionFreshness(evidence, now, SOURCE_ID);
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.license.commercialUseAllowed !== true || source.license.derivativeWorkAllowed !== true
    || admission.schemaVersion !== 2 || admission.artifactKind !== "seoul-public-route-map-layout-admission"
    || admission.status !== "ADMITTED" || admission.snapshotPath !== `tools/datapack/sources/${admission.positionSnapshotId}.json`
    || admission.layoutArtifactSha256 !== layoutArtifactSha256
    || admission.rawPositionsSha256 !== snapshot.rawPositionsSha256 || admission.layoutPositionsSha256 !== snapshot.layoutPositionsSha256
    || admission.layoutTracksSha256 !== snapshot.layoutTracksSha256 || admission.lineOrderSha256 !== snapshot.lineOrderSha256
    || admission.topologySnapshotSha256 !== snapshot.topologySnapshotSha256 || admission.aliasLedgerSha256 !== snapshot.aliasLedgerSha256
    || admission.semanticInputSha256 !== snapshot.semanticInputSha256 || admission.semanticOutputSha256 !== snapshot.semanticOutputSha256
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["capital"],
      operatorIds: [...CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS],
      lineIds: [...LINE_IDS],
      sourceDomains: ["route_map_positions"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(["line", "station_code", "station_name", "latitude", "longitude", "basis_date"])
    || !Number.isFinite(observedNow) || observedNow < Date.parse(snapshot.capturedAt)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  return source;
}

function ensureLines(pack) {
  const existing = new Set(pack.lines.map(({ id }) => id));
  for (const lineId of LINE_IDS) {
    if (!existing.has(lineId)) throw new Error(`Seoul route map canonical line is missing: ${lineId}`);
  }
}

function ensureStationsAndMembership(pack, snapshot, layoutByKey) {
  const stationsById = new Map(pack.stations.map((station) => [station.id, station]));
  const canonicalStationIds = new Map();
  for (const membership of pack.stationLines) {
    const station = stationsById.get(membership.stationId);
    if (!station) throw new Error(`Seoul route map membership station missing: ${membership.stationId}`);
    const key = `${membership.lineId}:${normalizeStationName(station.nameKo)}`;
    const ids = canonicalStationIds.get(key) ?? [];
    ids.push(station.id);
    canonicalStationIds.set(key, ids);
  }
  const mapping = new Map();
  for (const rawPosition of snapshot.rawPositions) {
    const position = { ...rawPosition };
    const layout = layoutByKey.get(`${position.lineId}:${position.stationCode}`);
    if (!layout) throw new Error("Seoul route map layout station identity mismatch");
    const canonicalName = canonicalSeoulRouteMapStationName(position.line, position.stationName);
    const existingStationIds = canonicalStationIds.get(
      `${position.lineId}:${normalizeStationName(canonicalName)}`,
    ) ?? [];
    if (existingStationIds.length === 0) {
      throw new Error(`Seoul route map canonical station is missing: ${position.lineId}:${canonicalName}`);
    }
    if (existingStationIds.length > 1) {
      throw new Error(`Seoul route map canonical station is ambiguous: ${position.lineId}:${canonicalName}`);
    }
    position.stationId = existingStationIds[0];
    const station = stationsById.get(position.stationId);
    if (station.latitude == null || station.longitude == null) {
      station.latitude = position.latitude;
      station.longitude = position.longitude;
    }
    mapping.set(`${position.lineId}:${position.stationCode}`, station.id);
  }
  if (mapping.size !== snapshot.rawPositions.length) throw new Error("Seoul route map station mapping size mismatch");
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
  const expected = ["--base-fixture", "--snapshot", "--topology-snapshot", "--inventory", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-seoul-route-map-positions.mjs --base-fixture <json> --snapshot <json> --topology-snapshot <json> --inventory <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

async function main(argv) {
  const args = parseArgs(argv);
  const [baseFixture, snapshotBytes, topologySnapshotBytes, inventory] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args.snapshot),
    readFile(args["topology-snapshot"]),
    readFile(args.inventory, "utf8").then(JSON.parse),
  ]);
  const snapshot = JSON.parse(snapshotBytes);
  const fixture = materializeSeoulRouteMapPositions({
    baseFixture,
    snapshot,
    snapshotSha256: sha256(snapshotBytes),
    topologySnapshotBytes,
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
