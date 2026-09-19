#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateGwangjuAccessibilityTopology } from "./collect-gwangju-accessibility.mjs";

const SOURCE_ID = "gwangju-transportation-accessibility";
const TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const OPERATOR_ID = "gwangju-metropolitan-rapid-transit";
const PACK_ID = "nationwide-gwangju-accessibility";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const DATASET_IDS = Object.freeze(["15041385", "15041362"]);
const FIELDS_PROVIDED = Object.freeze([
  "elevator", "escalator", "status", "verified_at",
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

export function materializeGwangjuAccessibility({
  baseFixture,
  accessibilitySnapshot,
  topologySnapshot,
  inventory,
} = {}) {
  const rows = validateSnapshot(accessibilitySnapshot);
  const source = requiredSource(inventory, accessibilitySnapshot, topologySnapshot);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Gwangju accessibility requires one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  if (!pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Gwangju accessibility requires gwangju-metropolitan-rapid-transit operator pack");
  }
  if (!pack.sourceInventory.some(({ id }) => id === TOPOLOGY_SOURCE_ID)) {
    throw new Error("Gwangju accessibility requires gwangju topology source");
  }

  validateTopologyLineage(inventory, source.accessibilityAdmissionEvidence, topologySnapshot);
  const stations = canonicalStations(pack, topologySnapshot, accessibilitySnapshot.lineIds[0]);

  const snapshotId = source.accessibilityAdmissionEvidence.snapshotId;
  const facilities = [];
  const evidence = [];
  for (const row of rows) {
    const stationId = stations.get(`${row.lineId}:${row.stationCode}`);
    if (!stationId) {
      throw new Error(`Gwangju accessibility canonical station missing: ${row.lineId}:${row.stationCode}`);
    }
    const stationName = pack.stations.find(({ id }) => id === stationId)?.nameKo ?? row.stationName;
    for (const facilityType of FACILITY_TYPES) {
      const count = facilityType.countOf(row);
      if (count == null) continue;
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Gwangju accessibility count invalid: ${row.stationCode}:${facilityType.type}`);
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
      const id = `facility-gwangju-${row.stationCode}-${facilityType.slug}`;
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
          ? `광주교통공사 역사별 장애인 편의시설 현황 기준 ${facilityType.labelKo} ${count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `광주교통공사 역사별 장애인 편의시설 현황 기준 ${facilityType.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: SOURCE_ID,
        sourceSnapshotId: snapshotId,
        providerFacilityRef: `gwangju-accessibility-${row.stationCode}-${facilityType.slug}`,
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
  const expectedFacilities = observedFacilityCount(rows);
  if (facilities.length !== expectedFacilities || evidence.length !== expectedFacilities
    || new Set(facilities.map(({ id }) => id)).size !== expectedFacilities
    || new Set(evidence.map(({ stationId, lineId, facilityType }) => `${stationId}:${lineId}:${facilityType}`)).size
      !== expectedFacilities) {
    throw new Error("Gwangju accessibility materialized facility counts are invalid");
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
    contentSha256: materializedGwangjuAccessibilityPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function materializedGwangjuAccessibilityPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 2 || snapshot.artifactKind !== "gwangju-accessibility-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || !Number.isInteger(snapshot.stationCount) || snapshot.stationCount < 1
    || snapshot.rowCount !== snapshot.stationCount || snapshot.rows?.length !== snapshot.stationCount
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.scopeSha256 ?? "")
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || !Array.isArray(snapshot.lineIds) || snapshot.lineIds.length !== 1 || typeof snapshot.lineIds[0] !== "string"
    || JSON.stringify(snapshot.datasetIds) !== JSON.stringify(DATASET_IDS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify(FIELDS_PROVIDED)
    || !Array.isArray(snapshot.topologyLineages) || snapshot.topologyLineages.length !== 1) {
    throw new Error("invalid Gwangju accessibility snapshot");
  }
  const codes = new Set();
  for (const row of snapshot.rows) {
    if (row.lineId !== snapshot.lineIds[0] || typeof row.stationCode !== "string" || codes.has(row.stationCode)
      || row.wheelchair_lift !== null
      || [row.elevator, row.escalator].some((value) => value !== null && (!Number.isInteger(value) || value < 0))) {
      throw new Error(`invalid Gwangju accessibility row: ${row?.stationCode}`);
    }
    codes.add(row.stationCode);
  }
  if (codes.size !== snapshot.stationCount
    || JSON.stringify(snapshot.scope) !== JSON.stringify(snapshot.rows.map(({ stationCode, stationName, lineId }) => ({ stationCode, stationName, lineId })))
    || snapshot.elevatorRowCount !== snapshot.rows.reduce((sum, row) => sum + (row.elevator ?? 0), 0)
    || snapshot.escalatorRowCount !== snapshot.rows.reduce((sum, row) => sum + (row.escalator ?? 0), 0)) {
    throw new Error("invalid Gwangju accessibility snapshot scope");
  }
  return snapshot.rows;
}

function observedFacilityCount(rows) {
  return rows.reduce((sum, row) => sum + FACILITY_TYPES.filter((type) => type.countOf(row) !== null).length, 0);
}

function requiredSource(inventory, snapshot, topologySnapshot) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.accessibilityAdmissionEvidence;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.capabilities?.facility?.productionUseAllowed !== true
    || source.capabilities?.facility?.status !== "SUPPORTED"
    || evidence?.issue !== 2479
    || evidence.materializer !== "tools/datapack/materialize-gwangju-accessibility.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-gwangju-accessibility.test.mjs"
    || !/^gwangju-transportation-accessibility-[a-f0-9]{64}-\d{8}$/.test(evidence.snapshotId ?? "")
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`
    || evidence.capturedAt !== snapshot.capturedAt || evidence.freshUntil !== snapshot.freshUntil
    || evidence.stationCount !== snapshot.stationCount || evidence.rowCount !== snapshot.rowCount
    || evidence.facilityCount !== observedFacilityCount(snapshot.rows)
    || evidence.rawSha256 !== snapshot.rawSha256 || evidence.rowsSha256 !== snapshot.rowsSha256
    || evidence.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== snapshot.topologyLineages[0].snapshotId
    || JSON.stringify(evidence.datasetIds) !== JSON.stringify(DATASET_IDS)
    || !Array.isArray(evidence.topologyLineages)
    || JSON.stringify(evidence.topologyLineages) !== JSON.stringify(snapshot.topologyLineages)
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["gwangju"],
      operatorIds: [OPERATOR_ID],
      lineIds: snapshot.lineIds,
      sourceDomains: ["accessibility_facilities"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  validateTopologyLineage(inventory, evidence, topologySnapshot);
  validateGwangjuAccessibilitySnapshotIdentity(evidence.snapshotId, snapshot);
  const capturedAt = Date.parse(evidence.capturedAt);
  const freshUntil = Date.parse(evidence.freshUntil);
  if (!Number.isFinite(capturedAt) || freshUntil !== capturedAt + FRESHNESS_MILLIS) {
    throw new Error(`${SOURCE_ID} evidence freshness is invalid`);
  }
  return source;
}

function validateTopologyLineage(inventory, evidence, topologySnapshot) {
  const selected = inventory?.sources?.filter(({ id }) => id === TOPOLOGY_SOURCE_ID) ?? [];
  if (selected.length !== 1) throw new Error("Gwangju topology source selection mismatch");
  const { evidence: topologyEvidence, lineId } = validateGwangjuAccessibilityTopology(topologySnapshot, selected[0]);
  const lineage = evidence?.topologyLineages?.[0];
  if (evidence?.topologySourceId !== TOPOLOGY_SOURCE_ID
    || evidence.topologySnapshotId !== topologyEvidence.snapshotId
    || evidence.topologyContentSha256 !== topologyEvidence?.contentSha256
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologySnapshot.contentSha256 !== sha256(JSON.stringify({
      scope: topologySnapshot.scope,
      edges: topologySnapshot.edges,
    }))
    || lineage?.sourceId !== TOPOLOGY_SOURCE_ID
    || lineage.snapshotId !== topologyEvidence.snapshotId
    || lineage.contentSha256 !== topologySnapshot.contentSha256
    || lineage.lineId !== lineId) {
    throw new Error("Gwangju accessibility topology lineage mismatch");
  }
}

function canonicalStations(pack, topologySnapshot, lineId) {
  const expectedCodes = new Set(
    (topologySnapshot.scope ?? []).map(({ stationCode }) => stationCode),
  );
  if (expectedCodes.size !== topologySnapshot.scope.length) {
    throw new Error("Gwangju accessibility topology station codes mismatch");
  }
  const stations = new Map();
  for (const stationLine of pack.stationLines) {
    if (stationLine.lineId !== lineId || !expectedCodes.has(stationLine.stationCode)) continue;
    const key = `${lineId}:${stationLine.stationCode}`;
    if (stations.has(key)) throw new Error(`Gwangju accessibility duplicate canonical station: ${key}`);
    const provenanceSourceId = stationLine.fieldProvenance?.station_code?.sourceId;
    if (provenanceSourceId !== TOPOLOGY_SOURCE_ID
      || stationLine.lineSequence !== topologySnapshot.scope.findIndex(({ stationCode }) => stationCode === stationLine.stationCode) + 1) {
      throw new Error(`Gwangju accessibility topology lineage mismatch: ${key}`);
    }
    stations.set(key, stationLine.stationId);
  }
  if (stations.size !== expectedCodes.size) {
    throw new Error(`Gwangju accessibility canonical station scope mismatch: ${stations.size}`);
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

// 같은 관측일에 topology가 바뀌어도 immutable 파일이 충돌하지 않도록 전체 입력을 결속한다.
export function validateGwangjuAccessibilitySnapshotIdentity(snapshotId, snapshot) {
  const date = compactSeoulDate(snapshot.capturedAt);
  if (snapshotId?.slice(-8) !== date) {
    throw new Error(`${SOURCE_ID} snapshotId must match capturedAt Asia/Seoul date`);
  }
  if (snapshotId !== `${SOURCE_ID}-${sha256(JSON.stringify(snapshot))}-${date}`) {
    throw new Error(`${SOURCE_ID} snapshotId must match snapshot bytes`);
  }
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
    throw new Error("usage: materialize-gwangju-accessibility.mjs --base-fixture <json> --accessibility-snapshot <json> --topology-snapshot <json> --inventory <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runGwangjuAccessibilityMaterializer(argv) {
  const args = parseArgs(argv);
  const [baseFixture, accessibilitySnapshot, topologySnapshot, inventory] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["accessibility-snapshot"], "utf8").then(JSON.parse),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
  ]);
  const fixture = materializeGwangjuAccessibility({
    baseFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
  });
  fixture.fixtureClass = "TEST_ONLY";
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Gwangju accessibility materialized: stations=${accessibilitySnapshot.stationCount} facilities=${observedFacilityCount(accessibilitySnapshot.rows)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runGwangjuAccessibilityMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju accessibility materialization failed");
    process.exitCode = 1;
  }
}
