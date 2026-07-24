#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ID = "daejeon-transportation-accessibility";
const TOPOLOGY_SOURCE_ID = "daejeon-station-distance-fare";
const TOPOLOGY_SNAPSHOT_ID = "daejeon-station-distance-fare-topology-20260720";
const TIMETABLE_SOURCE_ID = "daejeon-train-timetable";
const PACK_ID = "nationwide-daejeon-accessibility";
const LINE_ID = "line-7051a9c2525c";
const EXPECTED_STATION_COUNT = 22;
const EXPECTED_FACILITY_COUNT = EXPECTED_STATION_COUNT * 3;
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const DATASET_IDS = Object.freeze(["15041384", "15041361"]);
const STATION_NUMBERS = Object.freeze(Array.from({ length: EXPECTED_STATION_COUNT }, (_, index) => String(101 + index)));
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

export function materializeDaejeonAccessibility({
  baseFixture,
  accessibilitySnapshot,
  topologySnapshot,
  inventory,
  now = new Date(),
} = {}) {
  const rows = validateSnapshot(accessibilitySnapshot);
  const source = requiredSource(inventory, accessibilitySnapshot, topologySnapshot, now);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Daejeon accessibility requires one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  if (!pack.operators.some(({ id }) => id === "daejeon-transportation")) {
    throw new Error("Daejeon accessibility requires daejeon-transportation operator pack");
  }
  if (!pack.sourceInventory.some(({ id }) => id === TIMETABLE_SOURCE_ID)) {
    throw new Error("Daejeon accessibility requires daejeon timetable source");
  }

  validateTopologyLineage(inventory, source.accessibilityAdmissionEvidence, topologySnapshot);
  const stations = canonicalStations(pack, topologySnapshot);

  const snapshotId = source.accessibilityAdmissionEvidence.snapshotId;
  const facilities = [];
  const evidence = [];
  for (const row of rows) {
    const stationId = stations.get(`${row.lineId}:${row.stationCode}`);
    if (!stationId) {
      throw new Error(`Daejeon accessibility canonical station missing: ${row.lineId}:${row.stationCode}`);
    }
    const stationName = pack.stations.find(({ id }) => id === stationId)?.nameKo ?? row.stationName;
    for (const facilityType of FACILITY_TYPES) {
      const count = facilityType.countOf(row);
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Daejeon accessibility count invalid: ${row.stationCode}:${facilityType.type}`);
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
      const id = `facility-daejeon-${row.stationCode}-${facilityType.slug}`;
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
          ? `대전교통공사 역사별 장애인 편의시설 현황 기준 ${facilityType.labelKo} ${count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `대전교통공사 역사별 장애인 편의시설 현황 기준 ${facilityType.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: SOURCE_ID,
        sourceSnapshotId: snapshotId,
        providerFacilityRef: `daejeon-accessibility-${row.stationCode}-${facilityType.slug}`,
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
    throw new Error("Daejeon accessibility materialized facility counts are invalid");
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
    contentSha256: materializedDaejeonAccessibilityPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedDaejeonAccessibilityPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "daejeon-accessibility-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || snapshot.stationCount !== EXPECTED_STATION_COUNT || snapshot.rowCount !== EXPECTED_STATION_COUNT
    || snapshot.rows?.length !== EXPECTED_STATION_COUNT
    || snapshot.elevatorRowCount !== 76 || snapshot.escalatorRowCount !== 168
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.scopeSha256 ?? "")
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify([LINE_ID])
    || JSON.stringify(snapshot.datasetIds) !== JSON.stringify(DATASET_IDS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify(FIELDS_PROVIDED)
    || !Array.isArray(snapshot.topologyLineages) || snapshot.topologyLineages.length !== 1) {
    throw new Error("invalid Daejeon accessibility snapshot");
  }
  const codes = new Set();
  for (const row of snapshot.rows) {
    if (row.lineId !== LINE_ID || typeof row.stationCode !== "string" || codes.has(row.stationCode)
      || !Number.isInteger(row.wheelchair_lift) || !Number.isInteger(row.elevator) || !Number.isInteger(row.escalator)
      || row.wheelchair_lift !== 0 || row.elevator < 1 || row.escalator < 1) {
      throw new Error(`invalid Daejeon accessibility row: ${row?.stationCode}`);
    }
    codes.add(row.stationCode);
  }
  if (codes.size !== EXPECTED_STATION_COUNT
    || STATION_NUMBERS.some((code) => !codes.has(code))) {
    throw new Error("invalid Daejeon accessibility snapshot scope");
  }
  return snapshot.rows;
}

function requiredSource(inventory, snapshot, topologySnapshot, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.accessibilityAdmissionEvidence;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.capabilities?.facility?.productionUseAllowed !== true
    || source.capabilities?.facility?.status !== "SUPPORTED"
    || evidence?.issue !== 2476
    || evidence.materializer !== "tools/datapack/materialize-daejeon-accessibility.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-daejeon-accessibility.test.mjs"
    || !/^daejeon-transportation-accessibility-\d{8}$/.test(evidence.snapshotId ?? "")
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`
    || evidence.capturedAt !== snapshot.capturedAt || evidence.freshUntil !== snapshot.freshUntil
    || evidence.stationCount !== EXPECTED_STATION_COUNT || evidence.rowCount !== EXPECTED_STATION_COUNT
    || evidence.facilityCount !== EXPECTED_FACILITY_COUNT
    || evidence.rawSha256 !== snapshot.rawSha256 || evidence.rowsSha256 !== snapshot.rowsSha256
    || evidence.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || JSON.stringify(evidence.datasetIds) !== JSON.stringify(DATASET_IDS)
    || !Array.isArray(evidence.topologyLineages)
    || JSON.stringify(evidence.topologyLineages) !== JSON.stringify(snapshot.topologyLineages)
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["daejeon"],
      operatorIds: ["daejeon-transportation"],
      lineIds: [LINE_ID],
      sourceDomains: ["accessibility_facilities"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  validateTopologyLineage(inventory, evidence, topologySnapshot);
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

function validateTopologyLineage(inventory, evidence, topologySnapshot) {
  const topologyEvidence = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID)
    ?.topologyAdmissionEvidence;
  const lineage = evidence?.topologyLineages?.[0];
  if (evidence?.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== TOPOLOGY_SNAPSHOT_ID
    || evidence.topologyContentSha256 !== topologyEvidence?.contentSha256
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.contentSha256 !== sha256(JSON.stringify(topologySnapshot.rows))
    || lineage?.sourceId !== TOPOLOGY_SOURCE_ID
    || lineage.snapshotId !== TOPOLOGY_SNAPSHOT_ID
    || lineage.contentSha256 !== topologySnapshot.contentSha256
    || lineage.lineId !== LINE_ID
    || topologyEvidence?.snapshotId !== TOPOLOGY_SNAPSHOT_ID) {
    throw new Error("Daejeon accessibility topology lineage mismatch");
  }
}

function canonicalStations(pack, topologySnapshot) {
  const expectedCodes = new Set(topologySnapshot.stationNumbers);
  if (JSON.stringify([...expectedCodes].sort()) !== JSON.stringify([...STATION_NUMBERS].sort())) {
    throw new Error("Daejeon accessibility topology station numbers mismatch");
  }
  const stations = new Map();
  for (const stationLine of pack.stationLines) {
    if (stationLine.lineId !== LINE_ID || !expectedCodes.has(stationLine.stationCode)) continue;
    const key = `${LINE_ID}:${stationLine.stationCode}`;
    if (stations.has(key)) throw new Error(`Daejeon accessibility duplicate canonical station: ${key}`);
    const provenanceSourceId = stationLine.fieldProvenance?.station_code?.sourceId;
    if (provenanceSourceId !== TOPOLOGY_SOURCE_ID
      || stationLine.lineSequence !== Number(stationLine.stationCode) - 100) {
      throw new Error(`Daejeon accessibility topology lineage mismatch: ${key}`);
    }
    stations.set(key, stationLine.stationId);
  }
  if (stations.size !== EXPECTED_STATION_COUNT) {
    throw new Error(`Daejeon accessibility canonical station scope mismatch: ${stations.size}`);
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
    "--topology-snapshot",
    "--inventory",
    "--output",
  ];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-daejeon-accessibility.mjs --base-fixture <json> --accessibility-snapshot <json> --topology-snapshot <json> --inventory <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runDaejeonAccessibilityMaterializer(argv, { now = new Date() } = {}) {
  const args = parseArgs(argv);
  const [baseFixture, accessibilitySnapshot, topologySnapshot, inventory] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["accessibility-snapshot"], "utf8").then(JSON.parse),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
  ]);
  const fixture = materializeDaejeonAccessibility({
    baseFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Daejeon accessibility materialized: stations=${EXPECTED_STATION_COUNT} facilities=${EXPECTED_FACILITY_COUNT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDaejeonAccessibilityMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daejeon accessibility materialization failed");
    process.exitCode = 1;
  }
}
