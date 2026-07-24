#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";

const SOURCE_ID = "daegu-transportation-accessibility";
const PACK_ID = "nationwide-daegu-accessibility";
const COMPOSITE_TOPOLOGY_SOURCE_ID = "daegu-transportation-accessibility-topology-lineage";
const COMPOSITE_TOPOLOGY_SNAPSHOT_ID = "daegu-transportation-accessibility-topology-lineage-20260721";
const EXPECTED_STATION_COUNT = 94;
const EXPECTED_FACILITY_COUNT = EXPECTED_STATION_COUNT * 3;
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const LINE_IDS = Object.freeze(DAEGU_LINES.map(({ lineId }) => lineId));
const FIELDS_PROVIDED = Object.freeze([
  "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
]);
const FACILITY_TYPES = Object.freeze([
  {
    type: "ELEVATOR",
    field: "elevator",
    slug: "elevator",
    labelKo: "엘리베이터",
    countOf: (row) => row.elevator,
  },
  {
    type: "ESCALATOR",
    field: "escalator",
    slug: "escalator",
    labelKo: "에스컬레이터",
    countOf: (row) => row.escalator,
  },
  {
    type: "WHEELCHAIR_LIFT",
    field: "wheelchair_lift",
    slug: "wheelchair-lift",
    labelKo: "휠체어리프트",
    countOf: (row) => row.wheelchair_lift,
  },
]);

export function materializeDaeguAccessibility({
  baseFixture,
  accessibilitySnapshot,
  topologySnapshots,
  inventory,
  now = new Date(),
} = {}) {
  const rows = validateSnapshot(accessibilitySnapshot);
  const source = requiredSource(inventory, accessibilitySnapshot, topologySnapshots, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Daegu accessibility requires one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  if (!pack.operators.some(({ id }) => id === "daegu-transportation")) {
    throw new Error("Daegu accessibility requires daegu-transportation operator pack");
  }
  for (const line of DAEGU_LINES) {
    if (!pack.sourceInventory.some(({ id }) => id === `daegu-line${line.lineNumber}-train-timetable`)) {
      throw new Error("Daegu accessibility requires daegu timetable sources");
    }
  }

  validateTopologyLineages(inventory, source.accessibilityAdmissionEvidence, topologySnapshots);
  const stations = canonicalStations(pack, topologySnapshots);

  const snapshotId = source.accessibilityAdmissionEvidence.snapshotId;
  const facilities = [];
  const evidence = [];
  for (const row of rows) {
    const stationId = stations.get(`${row.lineId}:${row.stationCode}`);
    if (!stationId) {
      throw new Error(`Daegu accessibility canonical station missing: ${row.lineId}:${row.stationCode}`);
    }
    const stationName = pack.stations.find(({ id }) => id === stationId)?.nameKo ?? row.stationName;
    for (const facilityType of FACILITY_TYPES) {
      const count = facilityType.countOf(row);
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Daegu accessibility count invalid: ${row.stationCode}:${facilityType.type}`);
      }
      const exists = count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode,
        lineId: row.lineId,
        type: facilityType.type,
        count,
        elevator: row.elevator,
        escalator: row.escalator,
        wheelchair_lift: row.wheelchair_lift,
      }));
      const id = `facility-daegu-${row.stationCode}-${facilityType.slug}`;
      facilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: facilityType.type,
        name: `${stationName}역 ${facilityType.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `대구교통공사 역사별 장애인 편의시설 현황 기준 ${facilityType.labelKo} ${count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `대구교통공사 역사별 장애인 편의시설 현황 기준 ${facilityType.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: SOURCE_ID,
        sourceSnapshotId: snapshotId,
        providerFacilityRef: `daegu-accessibility-${row.stationCode}-${facilityType.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: accessibilitySnapshot.capturedAt,
        retrievedAt: accessibilitySnapshot.capturedAt,
        evidenceHash: accessibilitySnapshot.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: accessibilitySnapshot.capturedAt,
      });
      evidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: facilityType.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: SOURCE_ID,
        sourceSnapshotId: snapshotId,
        providerRecordHash,
        evidenceHash: accessibilitySnapshot.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: accessibilitySnapshot.capturedAt,
        retrievedAt: accessibilitySnapshot.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }
  if (facilities.length !== EXPECTED_FACILITY_COUNT || evidence.length !== EXPECTED_FACILITY_COUNT
    || new Set(facilities.map(({ id }) => id)).size !== EXPECTED_FACILITY_COUNT
    || new Set(evidence.map(({ stationId, lineId, facilityType }) => `${stationId}:${lineId}:${facilityType}`)).size
      !== EXPECTED_FACILITY_COUNT) {
    throw new Error("Daegu accessibility materialized facility counts are invalid");
  }

  pack.sourceInventory.push(packSource(source, accessibilitySnapshot));
  pack.facilities.push(...facilities);
  pack.stationFacilityEvidence = [...(pack.stationFacilityEvidence ?? []), ...evidence];
  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    facilities: pack.facilities.length,
    station_facility_evidence: pack.stationFacilityEvidence.length,
  };
  const version = snapshotId.slice(-8);
  const composition = sha256(JSON.stringify({
    previousPackId: pack.id,
    snapshotId,
    rowsSha256: accessibilitySnapshot.rowsSha256,
    source,
    contentSha256: materializedDaeguAccessibilityPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedDaeguAccessibilityPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "daegu-accessibility-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || snapshot.stationCount !== EXPECTED_STATION_COUNT || snapshot.rowCount !== EXPECTED_STATION_COUNT
    || snapshot.rows?.length !== EXPECTED_STATION_COUNT
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.scopeSha256 ?? "")
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify(LINE_IDS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify(FIELDS_PROVIDED)
    || !Array.isArray(snapshot.topologyLineages) || snapshot.topologyLineages.length !== 3) {
    throw new Error("invalid Daegu accessibility snapshot");
  }
  const codes = new Set();
  for (const row of snapshot.rows) {
    if (!LINE_IDS.includes(row.lineId) || typeof row.stationCode !== "string" || codes.has(`${row.lineId}:${row.stationCode}`)
      || !Number.isInteger(row.wheelchair_lift) || !Number.isInteger(row.elevator) || !Number.isInteger(row.escalator)
      || row.wheelchair_lift < 0 || row.elevator < 0 || row.escalator < 0) {
      throw new Error(`invalid Daegu accessibility row: ${row?.stationCode}`);
    }
    codes.add(`${row.lineId}:${row.stationCode}`);
  }
  if (codes.size !== EXPECTED_STATION_COUNT) throw new Error("invalid Daegu accessibility snapshot scope");
  return snapshot.rows;
}

function requiredSource(inventory, snapshot, topologySnapshots, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.accessibilityAdmissionEvidence;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.capabilities?.facility?.productionUseAllowed !== true
    || source.capabilities?.facility?.status !== "SUPPORTED"
    || evidence?.issue !== 2467
    || evidence.materializer !== "tools/datapack/materialize-daegu-accessibility.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-daegu-accessibility.test.mjs"
    || !/^daegu-transportation-accessibility-\d{8}$/.test(evidence.snapshotId ?? "")
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`
    || evidence.capturedAt !== snapshot.capturedAt || evidence.freshUntil !== snapshot.freshUntil
    || evidence.stationCount !== EXPECTED_STATION_COUNT || evidence.rowCount !== EXPECTED_STATION_COUNT
    || evidence.facilityCount !== EXPECTED_FACILITY_COUNT
    || evidence.rawSha256 !== snapshot.rawSha256 || evidence.rowsSha256 !== snapshot.rowsSha256
    || evidence.topologySourceId !== COMPOSITE_TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== COMPOSITE_TOPOLOGY_SNAPSHOT_ID
    || !Array.isArray(evidence.topologyLineages)
    || JSON.stringify(evidence.topologyLineages) !== JSON.stringify(snapshot.topologyLineages)
    || evidence.topologyContentSha256 !== sha256(JSON.stringify(evidence.topologyLineages))
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["daegu"],
      operatorIds: ["daegu-transportation"],
      lineIds: LINE_IDS,
      sourceDomains: ["accessibility_facilities"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  validateTopologyLineages(inventory, evidence, topologySnapshots);
  const version = evidence.snapshotId.slice(-8);
  if (version !== compactSeoulDate(evidence.capturedAt)) {
    throw new Error(`${SOURCE_ID} snapshotId must match capturedAt Asia/Seoul date`);
  }
  const capturedAt = Date.parse(evidence.capturedAt);
  const freshUntil = Date.parse(evidence.freshUntil);
  const observedNow = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(capturedAt) || freshUntil !== capturedAt + FRESHNESS_MILLIS
    || !Number.isFinite(observedNow) || observedNow < capturedAt || observedNow >= freshUntil) {
    throw new Error(`${SOURCE_ID} evidence freshness is invalid`);
  }
  return source;
}

function validateTopologyLineages(inventory, evidence, topologySnapshots) {
  if (!Array.isArray(evidence?.topologyLineages) || evidence.topologyLineages.length !== DAEGU_LINES.length) {
    throw new Error("Daegu accessibility topology lineages are incomplete");
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
      throw new Error(`Daegu accessibility topology lineage mismatch: ${config.lineNumber}`);
    }
  }
  if (evidence.topologySourceId !== COMPOSITE_TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== COMPOSITE_TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== sha256(JSON.stringify(evidence.topologyLineages))) {
    throw new Error("Daegu accessibility composite topology lineage mismatch");
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
    if (stations.has(key)) throw new Error(`Daegu accessibility duplicate canonical station: ${key}`);
    const provenanceSourceId = stationLine.fieldProvenance?.station_code?.sourceId;
    if (provenanceSourceId !== expectedStation.topologySourceId
      || stationLine.lineSequence !== expectedStation.lineSequence) {
      throw new Error(`Daegu accessibility topology lineage mismatch: ${key}`);
    }
    stations.set(key, stationLine.stationId);
  }
  if (stations.size !== EXPECTED_STATION_COUNT) {
    throw new Error(`Daegu accessibility canonical station scope mismatch: ${stations.size}`);
  }
  return stations;
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
    updatedAt: snapshot.capturedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function compactSeoulDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function parseArgs(argv) {
  const expected = [
    "--base-fixture",
    "--accessibility-snapshot",
    "--sources-dir",
    "--inventory",
    "--output",
  ];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-daegu-accessibility.mjs --base-fixture <json> --accessibility-snapshot <json> --sources-dir <dir> --inventory <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runDaeguAccessibilityMaterializer(argv, { now = new Date() } = {}) {
  const args = parseArgs(argv);
  const [baseFixture, accessibilitySnapshot, inventory, ...topologyBytes] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["accessibility-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
    ...DAEGU_LINES.map((line) => readFile(
      path.join(args["sources-dir"], `daegu-line${line.lineNumber}-route-topology-20260721.json`),
      "utf8",
    )),
  ]);
  const topologySnapshots = Object.fromEntries(DAEGU_LINES.map((line, index) => [
    line.lineNumber,
    JSON.parse(topologyBytes[index]),
  ]));
  const fixture = materializeDaeguAccessibility({
    baseFixture,
    accessibilitySnapshot,
    topologySnapshots,
    inventory,
    now,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Daegu accessibility materialized: stations=${EXPECTED_STATION_COUNT} facilities=${EXPECTED_FACILITY_COUNT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDaeguAccessibilityMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daegu accessibility materialization failed");
    process.exitCode = 1;
  }
}
