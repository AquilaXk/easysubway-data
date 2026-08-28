#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateIncheonStationInfoSnapshot } from "./collect-incheon-station-info.mjs";

const SOURCE_ID = "incheon-transit-accessibility";
const TOPOLOGY_SOURCE_ID = "incheon-transit-station-info";
const OPERATOR_ID = "incheon-transit";
const PACK_ID = "nationwide-incheon-accessibility";
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE7 = "line-15b3b8a93259";
const LINE_IDS = Object.freeze([LINE2, LINE1, LINE7]);
const TOPOLOGY_LINE_IDS = Object.freeze([LINE2, LINE1]);
const MEMBERSHIP_LINE_IDS = Object.freeze([LINE7]);
const EXPECTED_STATION_COUNT = 71;
const EXPECTED_FACILITY_COUNT = EXPECTED_STATION_COUNT * 3;
const EXPECTED_ELEVATOR_ROWS = 265;
const EXPECTED_ESCALATOR_ROWS = 653;
const EXPECTED_WHEELCHAIR_ROWS = 3;
const EXPECTED_TOPOLOGY_LINEAGE_COUNT = TOPOLOGY_LINE_IDS.length;
const EXPECTED_MEMBERSHIP_LINEAGE_COUNT = MEMBERSHIP_LINE_IDS.length;
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;
const DATASET_IDS = Object.freeze(["15083478", "15010199", "15146049"]);
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

export function materializeIncheonAccessibility({
  baseFixture,
  accessibilitySnapshot,
  topologySnapshot,
  inventory,
  now = new Date(),
} = {}) {
  const admission = admittedIncheonAccessibilityEvidence({
    sourceInventory: inventory,
    snapshot: accessibilitySnapshot,
    topologySnapshot,
    now,
  });
  const { rows, source } = admission;
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Incheon accessibility requires one cumulative production pack");
  }
  if (pack.sourceInventory.some(({ id }) => id === SOURCE_ID)) {
    throw new Error(`${SOURCE_ID} already exists`);
  }
  if (!pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    throw new Error("Incheon accessibility requires incheon-transit operator pack");
  }
  if (!pack.sourceInventory.some(({ id }) => id === TOPOLOGY_SOURCE_ID)) {
    throw new Error("Incheon accessibility requires incheon-transit-station-info source");
  }

  validateTopologyLineage(inventory, source.accessibilityAdmissionEvidence, topologySnapshot);
  const stations = canonicalStations(pack, topologySnapshot);

  const snapshotId = admission.snapshotId;
  const facilities = [];
  const evidence = [];
  for (const row of rows) {
    const stationId = stations.get(`${row.lineId}:${row.stationCode}`);
    if (!stationId) {
      throw new Error(`Incheon accessibility canonical station missing: ${row.lineId}:${row.stationCode}`);
    }
    const stationName = pack.stations.find(({ id }) => id === stationId)?.nameKo ?? row.stationName;
    for (const facilityType of FACILITY_TYPES) {
      const count = facilityType.countOf(row);
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Incheon accessibility count invalid: ${row.stationCode}:${facilityType.type}`);
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
      const id = `facility-incheon-${row.stationCode}-${facilityType.slug}`;
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
          ? `인천교통공사 역사별 장애인 편의시설 현황 기준 ${facilityType.labelKo} ${count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `인천교통공사 역사별 장애인 편의시설 현황 기준 ${facilityType.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: SOURCE_ID,
        sourceSnapshotId: snapshotId,
        providerFacilityRef: `incheon-accessibility-${row.stationCode}-${facilityType.slug}`,
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
    throw new Error("Incheon accessibility materialized facility counts are invalid");
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
    contentSha256: materializedIncheonAccessibilityPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function admittedIncheonAccessibilityEvidence({
  sourceInventory,
  snapshot,
  topologySnapshot,
  now = new Date(),
} = {}) {
  const rows = validateSnapshot(snapshot);
  const source = requiredSource(sourceInventory, snapshot, topologySnapshot, now);
  const evidence = source.accessibilityAdmissionEvidence;
  const topologyMembership = exactTopologyMembership(rows, topologySnapshot);
  const fixtureIdentities = expectedFixtureIdentities(rows, topologyMembership);
  if (fixtureIdentities.facilities.length !== evidence.facilityCount
    || fixtureIdentities.evidence.length !== evidence.facilityCount) {
    throw new Error("Incheon accessibility admission fixture counts are invalid");
  }
  return {
    source: structuredClone(source),
    rows: structuredClone(rows),
    topologyMembership,
    fixtureIdentities,
    snapshotId: evidence.snapshotId,
    snapshotPath: evidence.snapshotPath,
    evidenceHash: evidence.rowsSha256,
    freshUntil: evidence.freshUntil,
    facilityCount: evidence.facilityCount,
  };
}

export function validateProductionIncheonAccessibilityFixture(packs, admission) {
  if (!Array.isArray(packs) || admission?.source?.id !== SOURCE_ID
    || !Number.isSafeInteger(admission.facilityCount) || admission.facilityCount <= 0
    || !/^incheon-transit-accessibility-\d{8}$/u.test(admission.snapshotId ?? "")
    || !/^[a-f0-9]{64}$/u.test(admission.evidenceHash ?? "")) {
    throw new TypeError("Incheon accessibility production admission is invalid");
  }
  const expected = expectedFixtureIdentities(admission.rows, admission.topologyMembership);
  if (expected.facilities.length !== admission.facilityCount
    || expected.evidence.length !== admission.facilityCount
    || JSON.stringify(admission.fixtureIdentities) !== JSON.stringify(expected)) {
    throw new Error("Incheon accessibility production admission identity is invalid");
  }
  const facilities = packs.flatMap((pack) => pack?.facilities ?? [])
    .filter(({ sourceId }) => sourceId === SOURCE_ID);
  const evidence = packs.flatMap((pack) => pack?.stationFacilityEvidence ?? [])
    .filter(({ sourceId }) => sourceId === SOURCE_ID);
  const expectedFacilities = new Map(expected.facilities.map((row) => [row.id, row]));
  const expectedEvidence = new Set(expected.evidence.map(evidenceIdentity));
  const facilityIds = new Set(facilities.map(({ id }) => id));
  const evidenceIds = new Set(evidence.map(evidenceIdentity));
  if (facilities.length !== admission.facilityCount
    || evidence.length !== admission.facilityCount
    || facilityIds.size !== admission.facilityCount
    || evidenceIds.size !== admission.facilityCount
    || facilities.some((row) => typeof row.id !== "string"
      || row.sourceSnapshotId !== admission.snapshotId
      || row.evidenceHash !== admission.evidenceHash
      || !sameFacilityIdentity(row, expectedFacilities.get(row.id)))
    || evidence.some((row) => typeof row.stationId !== "string"
      || typeof row.lineId !== "string"
      || typeof row.facilityType !== "string"
      || row.sourceSnapshotId !== admission.snapshotId
      || row.evidenceHash !== admission.evidenceHash
      || !expectedEvidence.has(evidenceIdentity(row)))) {
    throw new Error("production Incheon accessibility fixture does not match pinned admission");
  }
  return admission.freshUntil;
}

function exactTopologyMembership(rows, topologySnapshot) {
  const topology = validateIncheonStationInfoSnapshot(topologySnapshot);
  const membership = topology.scope
    .filter(({ lineId }) => LINE_IDS.includes(lineId))
    .map(({ stationId, lineId, stationCode }) => ({ stationId, lineId, stationCode }));
  const bySourceKey = new Map(membership.map((row) => [membershipIdentity(row), row]));
  const sourceKeys = new Set(rows.map(membershipIdentity));
  if (membership.length !== rows.length
    || bySourceKey.size !== rows.length
    || sourceKeys.size !== rows.length
    || [...sourceKeys].some((key) => !bySourceKey.has(key))) {
    throw new Error("Incheon accessibility topology membership identity mismatch");
  }
  return structuredClone(membership);
}

function expectedFixtureIdentities(rows, topologyMembership) {
  if (!Array.isArray(rows) || !Array.isArray(topologyMembership)) {
    throw new TypeError("Incheon accessibility fixture identity inputs are invalid");
  }
  const membershipBySourceKey = new Map(topologyMembership.map((row) => [membershipIdentity(row), row]));
  const facilities = [];
  const evidence = [];
  for (const row of rows) {
    const member = membershipBySourceKey.get(membershipIdentity(row));
    if (!member) throw new Error("Incheon accessibility fixture membership is missing");
    for (const { type, slug } of FACILITY_TYPES) {
      facilities.push({
        id: `facility-incheon-${member.stationCode}-${slug}`,
        stationId: member.stationId,
        lineId: member.lineId,
        type,
      });
      evidence.push({ stationId: member.stationId, lineId: member.lineId, facilityType: type });
    }
  }
  const facilityIds = new Set(facilities.map(({ id }) => id));
  const evidenceIds = new Set(evidence.map(evidenceIdentity));
  if (facilityIds.size !== facilities.length || evidenceIds.size !== evidence.length) {
    throw new Error("Incheon accessibility fixture identities are not unique");
  }
  return { facilities, evidence };
}

function membershipIdentity({ lineId, stationCode }) {
  return `${lineId}:${stationCode}`;
}

function evidenceIdentity({ stationId, lineId, facilityType }) {
  return `${stationId}:${lineId}:${facilityType}`;
}

function sameFacilityIdentity(actual, expected) {
  return expected != null
    && actual.stationId === expected.stationId
    && actual.lineId === expected.lineId
    && actual.type === expected.type;
}

export function materializedIncheonAccessibilityPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "incheon-accessibility-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || snapshot.stationCount !== EXPECTED_STATION_COUNT || snapshot.rowCount !== EXPECTED_STATION_COUNT
    || snapshot.rows?.length !== EXPECTED_STATION_COUNT
    || snapshot.elevatorRowCount !== EXPECTED_ELEVATOR_ROWS
    || snapshot.escalatorRowCount !== EXPECTED_ESCALATOR_ROWS
    || snapshot.wheelchairRowCount !== EXPECTED_WHEELCHAIR_ROWS
    || snapshot.rowsSha256 !== sha256(JSON.stringify(snapshot.rows))
    || !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(snapshot.scopeSha256 ?? "")
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || JSON.stringify(snapshot.lineIds) !== JSON.stringify([...LINE_IDS])
    || JSON.stringify(snapshot.datasetIds) !== JSON.stringify(DATASET_IDS)
    || JSON.stringify(snapshot.fieldsProvided) !== JSON.stringify(FIELDS_PROVIDED)
    || !Array.isArray(snapshot.topologyLineages)
    || snapshot.topologyLineages.length !== EXPECTED_TOPOLOGY_LINEAGE_COUNT
    || JSON.stringify(snapshot.topologyLineages.map(({ lineId }) => lineId))
      !== JSON.stringify([...TOPOLOGY_LINE_IDS])
    || !Array.isArray(snapshot.membershipLineages)
    || snapshot.membershipLineages.length !== EXPECTED_MEMBERSHIP_LINEAGE_COUNT
    || JSON.stringify(snapshot.membershipLineages.map(({ lineId }) => lineId))
      !== JSON.stringify([...MEMBERSHIP_LINE_IDS])) {
    throw new Error("invalid Incheon accessibility snapshot");
  }
  const codes = new Set();
  for (const row of snapshot.rows) {
    if (!LINE_IDS.includes(row.lineId) || typeof row.stationCode !== "string" || codes.has(row.stationCode)
      || !Number.isInteger(row.wheelchair_lift) || !Number.isInteger(row.elevator) || !Number.isInteger(row.escalator)
      || row.wheelchair_lift < 0 || row.elevator < 0 || row.escalator < 0) {
      throw new Error(`invalid Incheon accessibility row: ${row?.stationCode}`);
    }
    codes.add(row.stationCode);
  }
  if (codes.size !== EXPECTED_STATION_COUNT
    || snapshot.rows.reduce((sum, row) => sum + row.elevator, 0) !== EXPECTED_ELEVATOR_ROWS
    || snapshot.rows.reduce((sum, row) => sum + row.escalator, 0) !== EXPECTED_ESCALATOR_ROWS
    || snapshot.rows.reduce((sum, row) => sum + row.wheelchair_lift, 0) !== EXPECTED_WHEELCHAIR_ROWS) {
    throw new Error("invalid Incheon accessibility snapshot scope");
  }
  return snapshot.rows;
}

function requiredSource(inventory, snapshot, topologySnapshot, now) {
  const source = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const evidence = source?.accessibilityAdmissionEvidence;
  const topologySnapshotId = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID)
    ?.topologyAdmissionEvidence?.snapshotId;
  if (source?.requiredForProductionPack !== false || source.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true
    || source.license?.type !== "PUBLIC_DATA_FREE_USE"
    || source.capabilities?.facility?.productionUseAllowed !== true
    || source.capabilities?.facility?.status !== "SUPPORTED"
    || evidence?.issue !== 2492
    || evidence.materializer !== "tools/datapack/materialize-incheon-accessibility.mjs"
    || evidence.verificationTest !== "tools/datapack/materialize-incheon-accessibility.test.mjs"
    || !/^incheon-transit-accessibility-\d{8}$/.test(evidence.snapshotId ?? "")
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`
    || evidence.capturedAt !== snapshot.capturedAt || evidence.freshUntil !== snapshot.freshUntil
    || evidence.stationCount !== EXPECTED_STATION_COUNT || evidence.rowCount !== EXPECTED_STATION_COUNT
    || evidence.facilityCount !== EXPECTED_FACILITY_COUNT
    || evidence.rawSha256 !== snapshot.rawSha256 || evidence.rowsSha256 !== snapshot.rowsSha256
    || evidence.topologySourceId !== TOPOLOGY_SOURCE_ID
    || !/^incheon-transit-station-info-\d{8}$/u.test(topologySnapshotId ?? "")
    || evidence.topologySnapshotId !== topologySnapshotId
    || JSON.stringify(evidence.datasetIds) !== JSON.stringify(DATASET_IDS)
    || !Array.isArray(evidence.topologyLineages)
    || evidence.topologyLineages.length !== EXPECTED_TOPOLOGY_LINEAGE_COUNT
    || !Array.isArray(evidence.membershipLineages)
    || evidence.membershipLineages.length !== EXPECTED_MEMBERSHIP_LINEAGE_COUNT
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || JSON.stringify(source.coverageScope) !== JSON.stringify({
      regionIds: ["capital"],
      operatorIds: [OPERATOR_ID],
      lineIds: [...LINE_IDS],
      sourceDomains: ["accessibility_facilities"],
    })
    || JSON.stringify(source.fieldsProvided) !== JSON.stringify(snapshot.fieldsProvided)) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  validateCapturedSnapshotLineage(snapshot, topologySnapshot);
  validateTopologyLineage(inventory, evidence, topologySnapshot);
  validateMembershipLineage(evidence, topologySnapshot, topologySnapshotId);
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

function validateCapturedSnapshotLineage(snapshot, topologySnapshot) {
  const topologySnapshotId = activeTopologySnapshotId(topologySnapshot);
  const lineages = [...snapshot.topologyLineages, ...snapshot.membershipLineages];
  if (lineages.some((lineage) => (
      lineage.sourceId !== TOPOLOGY_SOURCE_ID
        || lineage.snapshotId !== topologySnapshotId
        || lineage.contentSha256 !== topologySnapshot.contentSha256
        || !LINE_IDS.includes(lineage.lineId)
  ))) {
    throw new Error("Incheon accessibility captured topology lineage mismatch");
  }
}

function validateTopologyLineage(inventory, evidence, topologySnapshot) {
  validateIncheonStationInfoSnapshot(topologySnapshot);
  const topologyEvidence = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID)
    ?.topologyAdmissionEvidence;
  const topologySnapshotId = topologyEvidence?.snapshotId;
  const expectedSnapshotId = activeTopologySnapshotId(topologySnapshot);
  if (evidence?.topologySourceId !== TOPOLOGY_SOURCE_ID
    || !/^incheon-transit-station-info-\d{8}$/u.test(topologySnapshotId ?? "")
    || topologySnapshotId !== expectedSnapshotId
    || topologyEvidence.snapshotPath !== `tools/datapack/sources/${expectedSnapshotId}.json`
    || evidence.topologySnapshotId !== topologySnapshotId
    || evidence.topologyContentSha256 !== topologyEvidence?.contentSha256
    || evidence.topologyContentSha256 !== topologySnapshot.contentSha256
    || topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologyEvidence?.snapshotId !== topologySnapshotId
    || !Array.isArray(evidence.topologyLineages)
    || evidence.topologyLineages.length !== EXPECTED_TOPOLOGY_LINEAGE_COUNT
    || JSON.stringify(evidence.topologyLineages.map(({ lineId }) => lineId))
      !== JSON.stringify([...TOPOLOGY_LINE_IDS])
    || evidence.topologyLineages.some((lineage) => (
      lineage.sourceId !== TOPOLOGY_SOURCE_ID
        || lineage.snapshotId !== topologySnapshotId
        || lineage.contentSha256 !== topologySnapshot.contentSha256
        || !TOPOLOGY_LINE_IDS.includes(lineage.lineId)
    ))) {
    throw new Error("Incheon accessibility topology lineage mismatch");
  }
}

function activeTopologySnapshotId(snapshot) {
  const capturedDate = /^\d{4}-\d{2}-\d{2}T/u.test(snapshot?.capturedAt ?? "")
    ? snapshot.capturedAt.slice(0, 10).replaceAll("-", "")
    : "";
  const expected = `${TOPOLOGY_SOURCE_ID}-${capturedDate}`;
  if (capturedDate.length !== 8
    || (snapshot.snapshotId != null && snapshot.snapshotId !== expected)) {
    throw new Error("Incheon accessibility active topology identity mismatch");
  }
  return expected;
}

function validateMembershipLineage(evidence, topologySnapshot, topologySnapshotId) {
  if (!Array.isArray(evidence?.membershipLineages)
    || evidence.membershipLineages.length !== EXPECTED_MEMBERSHIP_LINEAGE_COUNT
    || JSON.stringify(evidence.membershipLineages.map(({ lineId }) => lineId))
      !== JSON.stringify([...MEMBERSHIP_LINE_IDS])
    || evidence.membershipLineages.some((lineage) => (
      lineage.sourceId !== TOPOLOGY_SOURCE_ID
        || lineage.snapshotId !== topologySnapshotId
        || lineage.contentSha256 !== topologySnapshot.contentSha256
        || !MEMBERSHIP_LINE_IDS.includes(lineage.lineId)
        || TOPOLOGY_LINE_IDS.includes(lineage.lineId)
    ))) {
    throw new Error("Incheon accessibility membership lineage mismatch");
  }
}

function canonicalStations(pack, topologySnapshot) {
  const expected = new Map();
  for (const lineId of LINE_IDS) {
    topologySnapshot.scope.filter((station) => station.lineId === lineId)
      .forEach((station) => expected.set(`${lineId}:${station.stationCode}`, {
        stationName: station.stationName,
        lineSequence: station.lineSequence,
      }));
  }
  if (expected.size !== EXPECTED_STATION_COUNT) {
    throw new Error("Incheon accessibility topology station codes mismatch");
  }
  const stationNames = new Map(pack.stations.map(({ id, nameKo }) => [id, nameKo]));
  const stations = new Map();
  for (const stationLine of pack.stationLines) {
    const key = `${stationLine.lineId}:${stationLine.stationCode}`;
    const expectedStation = expected.get(key);
    if (!expectedStation) continue;
    if (stations.has(key)) throw new Error(`Incheon accessibility duplicate canonical station: ${key}`);
    if (stationLine.sourceId !== TOPOLOGY_SOURCE_ID
      || stationLine.lineSequence !== expectedStation.lineSequence
      || stationNames.get(stationLine.stationId)?.normalize("NFKC") !== expectedStation.stationName.normalize("NFKC")) {
      throw new Error(`Incheon accessibility topology lineage mismatch: ${key}`);
    }
    stations.set(key, stationLine.stationId);
  }
  if (stations.size !== EXPECTED_STATION_COUNT) {
    throw new Error(`Incheon accessibility canonical station scope mismatch: ${stations.size}`);
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
    throw new Error("usage: materialize-incheon-accessibility.mjs --base-fixture <json> --accessibility-snapshot <json> --topology-snapshot <json> --inventory <json> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

export async function runIncheonAccessibilityMaterializer(argv, { now = new Date() } = {}) {
  const args = parseArgs(argv);
  const [baseFixture, accessibilitySnapshot, topologySnapshot, inventory] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["accessibility-snapshot"], "utf8").then(JSON.parse),
    readFile(args["topology-snapshot"], "utf8").then(JSON.parse),
    readFile(args.inventory, "utf8").then(JSON.parse),
  ]);
  const fixture = materializeIncheonAccessibility({
    baseFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now,
  });
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Incheon accessibility materialized: stations=${EXPECTED_STATION_COUNT} facilities=${EXPECTED_FACILITY_COUNT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runIncheonAccessibilityMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Incheon accessibility materialization failed");
    process.exitCode = 1;
  }
}
