#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseAdmittedMolitGwangjuStationMappings } from "./build-molit-nationwide-fixture.mjs";

const TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const MEMBERSHIP_SOURCE_ID = "molit-urban-rail-full-route-gwangju-membership";
const MEMBERSHIP_RAW_SOURCE_ID = "molit-urban-rail-full-route";
const OPERATOR_ID = "gwangju-metropolitan-rapid-transit";
const LINE_ID = "line-e57a361e8892";
const PACK_ID = "nationwide-gwangju-topology";
const MATERIALIZER = "tools/datapack/materialize-gwangju-route-topology.mjs";
const MATERIALIZER_TEST = "tools/datapack/materialize-gwangju-route-topology.test.mjs";

export const GWANGJU_LINES = Object.freeze([
  Object.freeze({ lineNumber: 1, lineId: LINE_ID }),
]);

export function materializeGwangjuRouteTopology({
  baseFixture,
  topologySnapshot,
  inventory,
  canonicalStationMappings,
  now = new Date(),
}) {
  const topology = validateTopologySnapshot(topologySnapshot);
  const sources = requiredSources(inventory, topologySnapshot, canonicalStationMappings, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Gwangju topology requires one cumulative production pack");
  }
  for (const id of [TOPOLOGY_SOURCE_ID, MEMBERSHIP_SOURCE_ID]) {
    if (pack.sourceInventory.some((source) => source.id === id)) throw new Error(`${id} already exists`);
  }
  if (pack.lines.some(({ id }) => id === LINE_ID)
    || pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Gwangju line already exists in base fixture");
  }

  pack.sourceInventory.push(
    packSource(sources.membership, sources.membership.membershipAdmissionEvidence.verifiedAt),
    packSource(sources.topology, topologySnapshot.capturedAt),
  );
  pack.operators.push({ id: OPERATOR_ID, nameKo: "광주교통공사", nameEn: "" });
  pack.lines.push({
    id: LINE_ID,
    operatorId: OPERATOR_ID,
    nameKo: "광주 1호선",
    nameEn: "",
    color: "#009088",
  });
  addStationsAndTopology(pack, topology, canonicalStationMappings, sources);

  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    stations: pack.stations.length,
    station_lines: pack.stationLines.length,
    network_edges: pack.networkEdges.length,
  };
  const version = compactSeoulDate(topologySnapshot.capturedAt);
  const composition = sha256(JSON.stringify({
    previousPackId: pack.id,
    topologySnapshotId: sources.topology.topologyAdmissionEvidence.snapshotId,
    topologyContentSha256: topologySnapshot.contentSha256,
    sourceEvidence: sources,
    packContentSha256: materializedPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function validateTopologySnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "gwangju-route-topology-snapshot"
    || snapshot.sourceId !== TOPOLOGY_SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || !Array.isArray(snapshot.scope) || snapshot.scope.length === 0
    || !Array.isArray(snapshot.edges) || snapshot.edges.length === 0
    || snapshot.requestCount !== snapshot.scope.length || snapshot.stationCount !== snapshot.scope.length
    || snapshot.odRowCount !== snapshot.scope.length * (snapshot.scope.length - 1)
    || snapshot.edgeCount !== snapshot.edges.length
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || snapshot.edgesSha256 !== sha256(JSON.stringify(snapshot.edges))
    || snapshot.contentSha256 !== sha256(JSON.stringify({ scope: snapshot.scope, edges: snapshot.edges }))) {
    throw new Error("invalid Gwangju topology snapshot");
  }
  const scopeCodes = new Set(snapshot.scope.map(({ stationCode }) => stationCode));
  if (scopeCodes.size !== snapshot.scope.length
    || snapshot.scope.some(({ stationCode, stationName }) => !nonBlank(stationCode) || !nonBlank(stationName))) {
    throw new Error("invalid Gwangju topology snapshot scope");
  }
  const pairs = new Set();
  const coveredCodes = new Set();
  for (const edge of snapshot.edges) {
    const key = `${edge.fromStationCode}\0${edge.toStationCode}`;
    if (!scopeCodes.has(edge.fromStationCode) || !scopeCodes.has(edge.toStationCode)
      || edge.fromStationCode === edge.toStationCode
      || !Number.isInteger(edge.distanceMeters) || edge.distanceMeters <= 0
      || !Number.isInteger(edge.durationSeconds) || edge.durationSeconds <= 0 || pairs.has(key)) {
      throw new Error(`invalid Gwangju topology edge: ${key}`);
    }
    pairs.add(key);
    coveredCodes.add(edge.fromStationCode);
    coveredCodes.add(edge.toStationCode);
  }
  if (!equalSets(scopeCodes, coveredCodes)
    || [...pairs].some((key) => {
      const [from, to] = key.split("\0");
      return !pairs.has(`${to}\0${from}`);
    })) {
    throw new Error("invalid Gwangju topology edge set");
  }
  return { scopeCodes, scope: snapshot.scope, edges: snapshot.edges };
}

function requiredSources(inventory, topologySnapshot, mappings, now) {
  const topology = exactlyOne(inventory?.sources, ({ id }) => id === TOPOLOGY_SOURCE_ID,
    "Gwangju topology source");
  const membership = exactlyOne(inventory?.sources, ({ id }) => id === MEMBERSHIP_SOURCE_ID,
    "Gwangju membership source");
  const rawMembership = exactlyOne(inventory?.sources, ({ id }) => id === MEMBERSHIP_RAW_SOURCE_ID,
    "Gwangju membership raw source");
  const topologyEvidence = topology.topologyAdmissionEvidence;
  const membershipEvidence = membership.membershipAdmissionEvidence;
  const mappingSha256 = sha256(JSON.stringify(mappings));
  const stationCodesSha256 = sha256(JSON.stringify(mappings?.map(({ stationNumber }) => stationNumber)));
  const topologyScope = topology.coverageScope;
  if (topology.productionUseAllowed !== true || !usableLicense(topology.license)
    || !Array.isArray(topologyScope?.lineIds) || !equalSets(new Set(topologyScope.lineIds), new Set([LINE_ID]))
    || !topologyScope.sourceDomains?.includes("route_graph_topology")
    || topologyEvidence?.materializer !== MATERIALIZER
    || topologyEvidence.verificationTest !== MATERIALIZER_TEST
    || topologyEvidence.capturedAt !== topologySnapshot.capturedAt
    || topologyEvidence.freshUntil !== topologySnapshot.freshUntil
    || topologyEvidence.stationCount !== topologySnapshot.scope.length
    || topologyEvidence.edgeCount !== topologySnapshot.edges.length
    || topologyEvidence.rawSha256 !== topologySnapshot.rawSha256
    || topologyEvidence.contentSha256 !== topologySnapshot.contentSha256) {
    throw new Error(`${TOPOLOGY_SOURCE_ID} inventory evidence does not match topology snapshot`);
  }
  if (!Array.isArray(mappings) || mappings.length === 0
    || new Set(mappings.map(({ stationId }) => stationId)).size !== mappings.length
    || new Set(mappings.map(({ stationNumber }) => stationNumber)).size !== mappings.length
    || membership.productionUseAllowed !== true || !usableLicense(membership.license)
    || rawMembership.admissionEvidence?.decision !== "APPROVED"
    || membershipEvidence?.materializer !== MATERIALIZER
    || membershipEvidence.verificationTest !== MATERIALIZER_TEST
    || !equalSets(new Set(membershipEvidence.lineIds ?? []), new Set([LINE_ID]))
    || membershipEvidence.stationCount !== mappings.length
    || membershipEvidence.mappingSha256 !== mappingSha256
    || membershipEvidence.stationCodesSha256 !== stationCodesSha256
    || membershipEvidence.membershipSourceId !== MEMBERSHIP_RAW_SOURCE_ID
    || membershipEvidence.membershipSourceRawSha256 !== rawMembership.admissionEvidence.rawSha256
    || membershipEvidence.membershipSourceSnapshotSha256 !== mappings.sourceRawSha256
    || membershipEvidence.stationCodeSourceId !== TOPOLOGY_SOURCE_ID
    || membershipEvidence.stationCodeSnapshotId !== topologyEvidence.snapshotId
    || membershipEvidence.stationCodeContentSha256 !== topologySnapshot.contentSha256) {
    throw new Error(`${MEMBERSHIP_SOURCE_ID} membership evidence is invalid`);
  }
  const capturedAt = instant(topologyEvidence.capturedAt, "Gwangju topology capturedAt");
  const freshUntil = instant(topologyEvidence.freshUntil, "Gwangju topology freshUntil");
  instant(membershipEvidence.verifiedAt, "Gwangju membership verifiedAt");
  const evaluatedAt = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(evaluatedAt) || evaluatedAt < capturedAt || evaluatedAt >= freshUntil) {
    throw new Error(`${TOPOLOGY_SOURCE_ID} evidence is stale or future-dated`);
  }
  return { topology, membership };
}

function addStationsAndTopology(pack, topology, mappings, sources) {
  const scopeByCode = new Map(topologySnapshotScope(topology, mappings)
    .map((row) => [row.stationCode, row]));
  const mappingsByCode = new Map(mappings.map((mapping) => [mapping.stationNumber, mapping]));
  const membershipEvidence = sources.membership.membershipAdmissionEvidence;
  const topologyEvidence = sources.topology.topologyAdmissionEvidence;
  for (const [index, mapping] of mappings.entries()) {
    const scope = scopeByCode.get(mapping.stationNumber);
    const membershipHash = sha256(JSON.stringify({
      lineId: LINE_ID,
      stationName: mapping.stationName,
      stationSequence: index + 1,
    }));
    pack.stations.push({
      id: mapping.stationId,
      nameKo: mapping.stationName,
      nameEn: "",
      normalizedName: mapping.stationName.normalize("NFKC"),
      region: "광주권",
      latitude: null,
      longitude: null,
      dataQualityLevel: "LEVEL_2",
      dataSourceType: "OFFICIAL_FILE",
      sourceId: MEMBERSHIP_SOURCE_ID,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipHash,
      evidenceHash: membershipEvidence.mappingSha256,
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
    pack.stationLines.push({
      stationId: mapping.stationId,
      lineId: LINE_ID,
      stationCode: mapping.stationNumber,
      lineSequence: index + 1,
      platformInfo: "",
      sourceId: MEMBERSHIP_SOURCE_ID,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipHash,
      evidenceHash: membershipEvidence.mappingSha256,
      fieldProvenance: {
        station_code: {
          sourceId: TOPOLOGY_SOURCE_ID,
          sourceSnapshotId: topologyEvidence.snapshotId,
          providerRecordHash: sha256(JSON.stringify(scope)),
          evidenceHash: topologyEvidence.contentSha256,
          derivationKind: "OFFICIAL",
          verifiedAt: topologyEvidence.capturedAt,
        },
      },
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
  }
  for (const edge of topology.edges) {
    const from = mappingsByCode.get(edge.fromStationCode);
    const to = mappingsByCode.get(edge.toStationCode);
    pack.networkEdges.push({
      id: `edge-gwangju-${edge.fromStationCode}-${edge.toStationCode}`,
      fromNodeId: `${from.stationId}:${LINE_ID}`,
      toNodeId: `${to.stationId}:${LINE_ID}`,
      durationSeconds: edge.durationSeconds,
      distanceMeters: edge.distanceMeters,
      edgeType: "RIDE",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      includesStairs: false,
      stairAccessState: "UNKNOWN",
      accessibilityStatus: "UNKNOWN",
      reliabilityScore: 100,
      sourceId: TOPOLOGY_SOURCE_ID,
      sourceSnapshotId: topologyEvidence.snapshotId,
      providerRecordHash: sha256(JSON.stringify(edge)),
      provenanceKind: "OFFICIAL_SOURCE",
      derivationKind: "OFFICIAL",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: topologyEvidence.capturedAt,
      evidenceHash: topologyEvidence.contentSha256,
    });
  }
}

function topologySnapshotScope(topology, mappings) {
  const mappingCodes = new Set(mappings.map(({ stationNumber }) => stationNumber));
  if (!equalSets(topology.scopeCodes, mappingCodes)) {
    throw new Error(`${MEMBERSHIP_SOURCE_ID} mapping does not match topology scope`);
  }
  const mappingsByCode = new Map(mappings.map((mapping) => [mapping.stationNumber, mapping]));
  if (topology.scope.some(({ stationCode, stationName }) =>
    normalizedName(stationName) !== normalizedName(mappingsByCode.get(stationCode)?.stationName))) {
    throw new Error(`${MEMBERSHIP_SOURCE_ID} mapping does not match topology names`);
  }
  return topology.scope;
}

function packSource(source, updatedAt) {
  return {
    id: source.id,
    owner: source.owner,
    url: source.datasetUrl,
    license: source.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: source.updateFrequency,
    updatedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function usableLicense(license) {
  return license?.commercialUseAllowed === true && license.derivativeWorkAllowed === true
    && license.redistributionAllowed === true;
}

function exactlyOne(values, predicate, label) {
  if (!Array.isArray(values)) throw new Error(`${label} is missing`);
  const matches = values.filter(predicate);
  if (matches.length !== 1) throw new Error(`${label} must be exactly one`);
  return matches[0];
}

function equalSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function nonBlank(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizedName(value) {
  return String(value).normalize("NFKC").replace(/\([^)]*\)/gu, "")
    .replace(/[\s/.·]/gu, "").replace(/역$/u, "");
}

function instant(value, label) {
  const milliseconds = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value) throw new Error(`${label} is invalid`);
  return milliseconds;
}

function compactSeoulDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const expected = ["--base-fixture", "--topology-snapshot", "--inventory",
    "--membership-observation", "--output"];
  if (argv.length !== expected.length * 2
    || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-gwangju-route-topology.mjs --base-fixture <json> --topology-snapshot <json> --inventory <json> --membership-observation <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runGwangjuRouteTopologyMaterializer(argv, { now = new Date() } = {}) {
  const args = parseArgs(argv);
  const [baseFixture, topologySnapshot, inventory, observation] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
    readFile(args["membership-observation"], "utf8").then(JSON.parse),
  ]);
  const fixture = materializeGwangjuRouteTopology({
    baseFixture,
    topologySnapshot,
    inventory,
    canonicalStationMappings: parseAdmittedMolitGwangjuStationMappings(
      observation.normalizedProjection,
      observation.rawSha256,
      inventory.sources.find(({ id }) => id === MEMBERSHIP_SOURCE_ID)
        ?.membershipAdmissionEvidence?.stationCount,
    ),
    now,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runGwangjuRouteTopologyMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju topology materialization failed");
    process.exitCode = 1;
  }
}
