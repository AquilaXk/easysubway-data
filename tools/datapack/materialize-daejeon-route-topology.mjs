#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { DAEJEON_TOPOLOGY_ENDPOINT } from "./collect-daejeon-route-topology.mjs";

const SOURCE_ID = "daejeon-station-distance-fare";
const MEMBERSHIP_SOURCE_ID = "molit-urban-rail-full-route-daejeon-membership";
const MEMBERSHIP_RAW_SOURCE_ID = "molit-urban-rail-full-route";
const OPERATOR_ID = "daejeon-transportation";
const LINE_ID = "line-7051a9c2525c";
export const DAEJEON_LINES = Object.freeze([
  Object.freeze({ lineNumber: 1, lineId: LINE_ID }),
]);
const PACK_ID = "nationwide-daejeon-topology";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const STATION_NUMBERS = Object.freeze(Array.from({ length: 22 }, (_, index) => String(101 + index)));

export function materializeDaejeonRouteTopology({
  baseFixture,
  snapshot,
  inventory,
  canonicalStationMappings,
  now = new Date(),
}) {
  validateSnapshot(snapshot);
  const source = requiredSource(inventory, snapshot, now);
  const mappings = requiredMappings(canonicalStationMappings);
  const membershipSource = requiredMembershipSource(inventory, snapshot, mappings, now);
  const compositionSha256 = sha256(JSON.stringify({ baseFixture, snapshot, source, membershipSource, mappings }));
  const fixture = structuredClone(baseFixture);
  if (!Array.isArray(fixture.packs) || fixture.packs.length !== 1 || fixture.packs[0].artifactKind !== "production") {
    throw new Error("base fixture must contain exactly one production pack");
  }

  const pack = fixture.packs[0];
  const version = /-(\d{8})$/.exec(source.topologyAdmissionEvidence.snapshotId)?.[1];
  if (!version) throw new Error(`${SOURCE_ID} snapshotId must end with YYYYMMDD`);
  pack.id = `${PACK_ID}-${compositionSha256}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version: pack.version };

  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists in base fixture`);
  }
  pack.sourceInventory.push(packSource(source, snapshot));
  if (pack.sourceInventory.some(({ id }) => id === MEMBERSHIP_SOURCE_ID)) {
    throw new Error(`${MEMBERSHIP_SOURCE_ID} already exists in base fixture`);
  }
  pack.sourceInventory.push(packMembershipSource(membershipSource));
  pack.operators.push({ id: OPERATOR_ID, nameKo: "대전교통공사", nameEn: "" });
  pack.lines.push({ id: LINE_ID, operatorId: OPERATOR_ID, nameKo: "대전 1호선", nameEn: "", color: "#007448" });

  const byStationNumber = new Map(mappings.map((mapping) => [mapping.stationNumber, mapping]));
  const canonicalSource = pack.sourceInventory.find(({ id }) => id === MEMBERSHIP_RAW_SOURCE_ID);
  if (!canonicalSource?.fields?.includes("station_name") || !canonicalSource.fields.includes("station_sequence")) {
    throw new Error("MOLIT canonical station mapping source is missing from base fixture");
  }
  const membershipEvidence = source.membershipAdmissionEvidence;
  for (const [index, mapping] of mappings.entries()) {
    const membershipRecordHash = sha256(JSON.stringify({
      lineId: LINE_ID,
      stationName: mapping.stationName,
      stationSequence: index + 1,
    }));
    const stationCodeRecordHash = sha256(JSON.stringify({
      stationNumber: mapping.stationNumber,
      adjacentRows: snapshot.rows.filter(({ fromStationNumber, toStationNumber }) =>
        fromStationNumber === mapping.stationNumber || toStationNumber === mapping.stationNumber),
    }));
    pack.stations.push({
      id: mapping.stationId,
      nameKo: mapping.stationName,
      nameEn: "",
      normalizedName: mapping.stationName.normalize("NFKC"),
      region: "대전권",
      latitude: null,
      longitude: null,
      dataQualityLevel: "LEVEL_2",
      dataSourceType: "OFFICIAL_FILE",
      sourceId: membershipSource.id,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipRecordHash,
      evidenceHash: membershipEvidence.mappingSha256,
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
    pack.stationLines.push({
      stationId: mapping.stationId,
      lineId: LINE_ID,
      stationCode: mapping.stationNumber,
      lineSequence: Number(mapping.stationNumber) - 100,
      platformInfo: "",
      sourceId: membershipSource.id,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipRecordHash,
      evidenceHash: membershipEvidence.mappingSha256,
      fieldProvenance: {
        station_code: {
          sourceId: SOURCE_ID,
          sourceSnapshotId: source.topologyAdmissionEvidence.snapshotId,
          providerRecordHash: stationCodeRecordHash,
          evidenceHash: snapshot.contentSha256,
          derivationKind: "OFFICIAL",
          verifiedAt: snapshot.observedAt,
        },
      },
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
  }

  const snapshotId = source.topologyAdmissionEvidence.snapshotId;
  for (const row of snapshot.rows) {
    const from = byStationNumber.get(row.fromStationNumber);
    const to = byStationNumber.get(row.toStationNumber);
    if (!from || !to) throw new Error(`Daejeon edge station mapping missing: ${row.fromStationNumber}:${row.toStationNumber}`);
    pack.networkEdges.push({
      id: `edge-daejeon-${row.fromStationNumber}-${row.toStationNumber}`,
      fromNodeId: `${from.stationId}:${LINE_ID}`,
      toNodeId: `${to.stationId}:${LINE_ID}`,
      durationSeconds: row.travelTimeSeconds,
      distanceMeters: Math.round(row.distanceKilometers * 1_000),
      edgeType: "RIDE",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      includesStairs: false,
      stairAccessState: "UNKNOWN",
      accessibilityStatus: "UNKNOWN",
      reliabilityScore: 100,
      sourceId: SOURCE_ID,
      sourceSnapshotId: snapshotId,
      providerRecordHash: sha256(JSON.stringify(row)),
      provenanceKind: "OFFICIAL_SOURCE",
      derivationKind: "OFFICIAL",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: snapshot.observedAt,
      evidenceHash: snapshot.rowsSha256,
    });
  }

  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    stations: pack.stations.length,
    station_lines: pack.stationLines.length,
    network_edges: pack.networkEdges.length,
  };
  return fixture;
}

function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "daejeon-route-topology-collection"
    || snapshot.sourceId !== SOURCE_ID || snapshot.endpoint !== DAEJEON_TOPOLOGY_ENDPOINT
    || snapshot.providerResultCode !== "00" || snapshot.schemaStatus !== "EXPECTED"
    || snapshot.credentialRedacted !== true || snapshot.rowCount !== 42 || snapshot.rows?.length !== 42
    || JSON.stringify(snapshot.stationNumbers) !== JSON.stringify(STATION_NUMBERS)
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || snapshot.contentSha256 !== snapshot.rowsSha256 || snapshot.excludedTransferCount !== 0
    || snapshot.rawSha256 !== sha256(JSON.stringify(snapshot.rows.map(({ responseSha256 }) => responseSha256)))) {
    throw new Error("invalid Daejeon route topology snapshot");
  }
  const seen = new Set();
  for (const row of snapshot.rows) {
    const from = Number(row.fromStationNumber);
    const to = Number(row.toStationNumber);
    const key = `${row.fromStationNumber}:${row.toStationNumber}`;
    if (!Number.isInteger(from) || !Number.isInteger(to) || Math.abs(from - to) !== 1 || seen.has(key)
      || !Number.isFinite(row.distanceKilometers) || row.distanceKilometers <= 0
      || !Number.isInteger(row.travelTimeSeconds) || row.travelTimeSeconds <= 0
      || !Number.isInteger(row.fareWon) || row.fareWon < 0
      || !/^[a-f0-9]{64}$/.test(row.responseSha256 ?? "")) {
      throw new Error(`invalid Daejeon route topology row: ${key}`);
    }
    seen.add(key);
  }
  for (let station = 101; station < 122; station += 1) {
    if (!seen.has(`${station}:${station + 1}`) || !seen.has(`${station + 1}:${station}`)) {
      throw new Error(`Daejeon adjacent topology is incomplete: ${station}:${station + 1}`);
    }
  }
}

function requiredSource(inventory, snapshot, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true) {
    throw new Error(`${SOURCE_ID} is not admitted for production use`);
  }
  const evidence = source.topologyAdmissionEvidence;
  if (!evidence || evidence.capturedAt !== snapshot.observedAt || evidence.stationCount !== snapshot.stationNumbers.length
    || evidence.edgeCount !== snapshot.rowCount || evidence.excludedTransferCount !== snapshot.excludedTransferCount
    || evidence.rawSha256 !== snapshot.rawSha256 || evidence.contentSha256 !== snapshot.contentSha256) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  const freshUntil = Date.parse(evidence.freshUntil);
  if (!Number.isFinite(freshUntil)) throw new Error(`${SOURCE_ID} topology evidence freshUntil is invalid`);
  const capturedAt = Date.parse(evidence.capturedAt);
  if (!Number.isFinite(capturedAt)) throw new Error(`${SOURCE_ID} topology evidence capturedAt is invalid`);
  if (freshUntil !== capturedAt + FRESHNESS_MILLIS) {
    throw new Error(`${SOURCE_ID} topology evidence freshness contract is invalid`);
  }
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(observedNow)) throw new Error("materialization time is invalid");
  if (observedNow < capturedAt) throw new Error(`${SOURCE_ID} topology evidence is future-dated`);
  if (observedNow >= freshUntil) throw new Error(`${SOURCE_ID} topology evidence is stale`);
  return source;
}

function requiredMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length !== 22
    || mappings.some((mapping, index) => mapping.stationNumber !== STATION_NUMBERS[index])) {
    throw new Error("canonical Daejeon station mappings must contain stations 101 through 122 in order");
  }
  return mappings;
}

function requiredMembershipSource(inventory, snapshot, mappings, now) {
  const source = inventory?.sources?.find(({ id }) => id === MEMBERSHIP_SOURCE_ID);
  const rawSource = inventory?.sources?.find(({ id }) => id === MEMBERSHIP_RAW_SOURCE_ID);
  const stationCodeSource = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = stationCodeSource?.membershipAdmissionEvidence;
  const scope = source?.coverageScope;
  const mappingSha256 = sha256(JSON.stringify(mappings));
  const stationCodesSha256 = sha256(JSON.stringify(mappings.map(({ stationNumber }) => stationNumber)));
  const verifiedAt = Date.parse(evidence?.verifiedAt ?? "");
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || rawSource?.admissionEvidence?.decision !== "APPROVED"
    || !source.fieldsProvided?.includes("line") || !source.fieldsProvided.includes("station_name")
    || !scope?.regionIds?.includes("daejeon") || !scope.operatorIds?.includes(OPERATOR_ID)
    || JSON.stringify(scope.lineIds) !== JSON.stringify([LINE_ID])
    || !scope.sourceDomains?.includes("station_line_membership")
    || evidence?.issue !== 2346 || JSON.stringify(evidence.lineIds) !== JSON.stringify([LINE_ID])
    || evidence.stationCount !== mappings.length
    || JSON.stringify(source.membershipAdmissionEvidence) !== JSON.stringify(evidence)
    || evidence.membershipSourceId !== MEMBERSHIP_RAW_SOURCE_ID
    || evidence.mappingSha256 !== mappingSha256 || evidence.stationCodesSha256 !== stationCodesSha256
    || evidence.stationCodeSourceId !== SOURCE_ID
    || evidence.stationCodeSnapshotId !== stationCodeSource?.topologyAdmissionEvidence?.snapshotId
    || evidence.stationCodeContentSha256 !== snapshot.contentSha256
    || evidence.membershipSourceRawSha256 !== rawSource.admissionEvidence.rawSha256
    || evidence.membershipSourceSnapshotSha256 !== mappings.sourceRawSha256
    || !Number.isFinite(verifiedAt) || new Date(verifiedAt).toISOString() !== evidence.verifiedAt) {
    throw new Error(`${MEMBERSHIP_SOURCE_ID} Daejeon membership evidence is invalid`);
  }
  if (now.getTime() < verifiedAt) {
    throw new Error(`${MEMBERSHIP_SOURCE_ID} membership evidence is future-dated`);
  }
  return source;
}

function packMembershipSource(source) {
  return {
    id: source.id,
    owner: source.owner,
    url: source.datasetUrl,
    license: source.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: source.updateFrequency,
    updatedAt: source.membershipAdmissionEvidence.verifiedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function packSource(source, snapshot) {
  return {
    id: source.id,
    owner: source.owner,
    url: source.datasetUrl,
    license: source.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: source.updateFrequency,
    updatedAt: snapshot.observedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  if (argv.length !== 10 || argv[0] !== "--base-fixture" || argv[2] !== "--snapshot"
    || argv[4] !== "--inventory" || argv[6] !== "--station-map" || argv[8] !== "--output"
    || !path.isAbsolute(argv[9])) {
    throw new Error("usage: materialize-daejeon-route-topology.mjs --base-fixture <json> --snapshot <json> --inventory <json> --station-map <csv> --output <absolute.json>");
  }
  return { baseFixture: argv[1], snapshot: argv[3], inventory: argv[5], stationMap: argv[7], output: argv[9] };
}

async function main(argv) {
  const args = parseArgs(argv);
  const [baseFixture, snapshot, inventory, stationMapCsv] = await Promise.all([
    readFile(args.baseFixture, "utf8").then(JSON.parse),
    readFile(args.snapshot, "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
    readFile(args.stationMap),
  ]);
  const fixture = materializeDaejeonRouteTopology({
    baseFixture,
    snapshot,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(stationMapCsv),
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Daejeon route topology materialized: stations=${snapshot.stationNumbers.length} edges=${snapshot.rowCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daejeon route topology materialization failed");
    process.exitCode = 1;
  }
}
