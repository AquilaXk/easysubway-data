import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import {
  materializeRegionalProductionCandidate,
  projectHistoricalRegionalMaterializeInventory,
  projectRegionalMaterializeFixture,
} from "./materialize-test-fixture.mjs";

import {
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import {
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuAccessibility } from "./materialize-gwangju-accessibility.mjs";
import { materializeGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import {
  admittedIncheonAccessibilityEvidence,
  materializeIncheonAccessibility,
  materializedIncheonAccessibilityPackContentHash,
  validateProductionIncheonAccessibilityFixture,
} from "./materialize-incheon-accessibility.mjs";
import { materializeIncheonStationInfo } from "./materialize-incheon-station-info.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T13:09:00.000Z");
const gwangjuAccessibilityNow = new Date("2026-07-24T03:00:00.000Z");
const SOURCE_ID = "incheon-transit-accessibility";
const OPERATOR_ID = "incheon-transit";
const LINE1 = "line-98718184f016";
const LINE2 = "line-42b5805f3b5a";
const LINE7 = "line-15b3b8a93259";
const ACCESSIBILITY_FIELDS = Object.freeze([
  "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
]);
// incheon station-info 누적 fixture coverage baseline(실측): supportedCount=31 → accessibility +3 = 34.
const INCHEON_STATION_INFO_BASELINE_SUPPORTED_COUNT = 31;
const ACCESSIBILITY_SUPPORTED_COUNT = INCHEON_STATION_INFO_BASELINE_SUPPORTED_COUNT + 3;

async function inputs({ materializeIncheon = true } = {}) {
  const currentInventory = await readJson("tools/datapack/source-inventory.json");
  const incheonSources = currentInventory.sources.filter(
    ({ id }) => id === "incheon-transit-station-info",
  );
  assert.equal(incheonSources.length, 1, "current Incheon source identity");
  const incheonAdmission = incheonSources[0].topologyAdmissionEvidence;
  const accessibilitySources = currentInventory.sources.filter(
    ({ id }) => id === SOURCE_ID,
  );
  assert.equal(accessibilitySources.length, 1, "current Incheon accessibility source identity");
  const accessibilityAdmission = accessibilitySources[0].admissionEvidence;
  assert.equal(typeof incheonAdmission?.snapshotPath, "string");
  assert.equal(typeof incheonAdmission?.capturedAt, "string");
  assert.ok(Number.isFinite(Date.parse(incheonAdmission.capturedAt)));
  assert.equal(typeof accessibilityAdmission?.snapshotId, "string");
  const [
    baseFixture,
    busanTopology,
    busanTimetable,
    busanRouteMapBytes,
    daejeonTopology,
    daejeonTimetable,
    gwangjuTopology,
    gwangjuTimetable,
    gwangjuAccessibilitySnapshot,
    incheonBytes,
    accessibilityBytes,
    inventory,
    stationMapCsv,
    molitStationMapCsv,
  ] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json").then(projectRegionalMaterializeFixture),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-accessibility-20260724.json"),
    readFile(path.join(root, incheonAdmission.snapshotPath)),
    readFile(path.join(root, `tools/datapack/sources/${accessibilityAdmission.snapshotId}.json`)),
    Promise.resolve(projectHistoricalRegionalMaterializeInventory(currentInventory)),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const busanTopologyFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot: busanTopology,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(stationMapCsv),
    now: topologyNow,
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: busanTopologyFixture,
    timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitStationMapCsv),
    now: timetableNow,
  });
  const busanTimetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture,
    timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology,
    inventory,
    now: timetableNow,
  });
  const routeMapFixture = materializeBusanRouteMapPositions({
    baseFixture: busanTimetableFixture,
    snapshot: JSON.parse(busanRouteMapBytes),
    snapshotSha256: createHash("sha256").update(busanRouteMapBytes).digest("hex"),
    topologySnapshot: busanTopology,
    inventory,
    now: timetableNow,
  });
  const gwangjuFixture = materializeGwangjuTimetable({
    baseFixture: routeMapFixture,
    timetableSnapshot: gwangjuTimetable,
    topologySnapshot: gwangjuTopology,
    inventory,
    canonicalStationMappings: parseMolitGwangjuStationMappings(molitStationMapCsv),
    now: timetableNow,
  });
  const gwangjuAccessibilityFixture = materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot: gwangjuAccessibilitySnapshot,
    topologySnapshot: gwangjuTopology,
    inventory,
    now: gwangjuAccessibilityNow,
  });
  const incheonSnapshot = JSON.parse(incheonBytes.toString("utf8"));
  const accessibilitySnapshot = JSON.parse(accessibilityBytes.toString("utf8"));
  const incheonFixture = materializeIncheon
    ? materializeIncheonStationInfo({
      baseFixture: gwangjuAccessibilityFixture,
      snapshot: incheonSnapshot,
      snapshotSha256: createHash("sha256").update(incheonBytes).digest("hex"),
      inventory,
      now: new Date(incheonAdmission.capturedAt),
    })
    : null;
  return {
    regionalFixture: gwangjuAccessibilityFixture,
    incheonFixture,
    topologySnapshot: incheonSnapshot,
    accessibilitySnapshot,
    accessibilityBytes,
    accessibilityAdmission,
    accessibilityNow: new Date(accessibilitySnapshot.capturedAt),
    inventory,
  };
}

function suppliedCurrentTopology(values) {
  const snapshot = structuredClone(values.topologySnapshot);
  snapshot.capturedAt = "2026-08-28T03:47:35.000Z";
  snapshot.freshUntil = "2026-08-29T03:47:35.000Z";
  snapshot.snapshotId = "incheon-transit-station-info-20260828";
  for (const entry of [...snapshot.scope, ...snapshot.positions]) {
    if (entry.lineId === LINE2 && entry.stationCode === "3210") entry.stationName = "서해구청";
  }
  const scope = snapshot.scope.find(({ lineId, stationCode }) => lineId === LINE2 && stationCode === "3210");
  scope.nameEn = "Seohae-gu Office";
  snapshot.scopeSha256 = createHash("sha256").update(JSON.stringify(snapshot.scope)).digest("hex");
  snapshot.positionsSha256 = createHash("sha256").update(JSON.stringify(snapshot.positions)).digest("hex");
  snapshot.contentSha256 = createHash("sha256").update(JSON.stringify({
    scope: snapshot.scope, edges: snapshot.edges, positions: snapshot.positions,
  })).digest("hex");
  return snapshot;
}

function rebindSuppliedTopologyInventory(inventory, snapshot) {
  const next = structuredClone(inventory);
  const stationInfo = next.sources.find(({ id }) => id === "incheon-transit-station-info");
  const topology = stationInfo.topologyAdmissionEvidence;
  const membership = stationInfo.membershipAdmissionEvidence;
  const routeMap = stationInfo.routeMapAdmissionEvidence;
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  Object.assign(topology, {
    snapshotId: snapshot.snapshotId,
    snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`,
    capturedAt: snapshot.capturedAt,
    freshUntil: snapshot.freshUntil,
    contentSha256: snapshot.contentSha256,
  });
  Object.assign(membership, {
    snapshotId: snapshot.snapshotId,
    verifiedAt: snapshot.capturedAt,
    membershipSourceSnapshotSha256: snapshot.scopeSha256,
    mappingSha256: createHash("sha256").update(JSON.stringify(snapshot.scope.map((station) => ({
      stationId: station.stationId, lineId: station.lineId, stationCode: station.stationCode,
      stationName: station.stationName,
    })))).digest("hex"),
    stationCodeContentSha256: snapshot.contentSha256,
    stationCodeSnapshotId: snapshot.snapshotId,
  });
  Object.assign(routeMap, {
    snapshotId: snapshot.snapshotId,
    snapshotPath: topology.snapshotPath,
    snapshotSha256: createHash("sha256").update(snapshotBytes).digest("hex"),
    capturedAt: snapshot.capturedAt,
    freshUntil: "2027-08-28T03:47:35.000Z",
    positionsSha256: snapshot.positionsSha256,
    topologySnapshotId: snapshot.snapshotId,
    topologyContentSha256: snapshot.contentSha256,
  });
  return next;
}

function receiptBoundTopologySuccessor(snapshot) {
  const successor = structuredClone(snapshot);
  successor.capturedAt = "2026-08-29T04:30:44.000Z";
  successor.freshUntil = "2026-08-30T04:30:44.000Z";
  successor.snapshotId = "incheon-transit-station-info-20260829";
  return successor;
}

test("인천 공식 71 membership 편의시설을 facility·evidence 213건으로 materialize한다", async () => {
  const {
    incheonFixture, topologySnapshot, accessibilitySnapshot, accessibilityBytes, accessibilityAdmission,
    accessibilityNow, inventory,
  } = await inputs();
  const fixture = materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  });
  const pack = fixture.packs[0];
  const facilities = pack.facilities.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const evidence = pack.stationFacilityEvidence.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);
  const admission = admittedIncheonAccessibilityEvidence({
    sourceInventory: inventory,
    snapshot: accessibilitySnapshot,
    snapshotBytes: accessibilityBytes,
    topologySnapshot,
    now: accessibilityNow,
  });

  assert.equal(facilities.length, 213);
  assert.equal(evidence.length, 213);
  assert.equal(new Set(facilities.map(({ id }) => id)).size, 213);
  assert.equal(new Set(evidence.map(({ stationId, lineId, facilityType }) =>
    `${stationId}:${lineId}:${facilityType}`)).size, 213);
  assert.deepEqual([...new Set(facilities.map(({ type }) => type))].sort(), [
    "ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT",
  ]);
  assert.deepEqual(
    [...new Set(facilities.map(({ lineId }) => lineId))].sort(),
    [LINE2, LINE1, LINE7].sort(),
  );
  assert.equal(facilities.filter(({ lineId }) => lineId === LINE1).length, 99);
  assert.equal(facilities.filter(({ lineId }) => lineId === LINE2).length, 81);
  assert.equal(facilities.filter(({ lineId }) => lineId === LINE7).length, 33);
  assert.equal(facilities.filter(({ type, installationStatus }) =>
    type === "WHEELCHAIR_LIFT" && installationStatus === "INSTALLED").length, 2);
  assert.ok(facilities.some(({ type, installationStatus }) =>
    type === "ESCALATOR" && installationStatus === "NOT_INSTALLED"));
  assert.ok(facilities.every(({ status, statusMeaning, provenanceKind, derivationKind, operationalStatus }) => (
    status === "UNKNOWN"
      && statusMeaning === "STATIC_LOCATION"
      && provenanceKind === "OFFICIAL_SOURCE"
      && derivationKind === "OFFICIAL"
      && operationalStatus === "UNKNOWN"
  )));
  assert.ok(evidence.every(({ provenanceKind, operationalStatus, statusMeaning, strictRouteEligible }) => (
    provenanceKind === "OFFICIAL_SOURCE"
      && operationalStatus === "UNKNOWN"
      && statusMeaning === "STATIC_LOCATION"
      && strictRouteEligible === false
  )));
  assert.equal(source.license, "공공데이터포털 이용허락범위 제한 없음");
  assert.deepEqual(source.coverageScope.lineIds, [LINE2, LINE1, LINE7]);
  assert.deepEqual(source.coverageScope.operatorIds, [OPERATOR_ID]);
  assert.equal(pack.minimumTableRows.facilities, pack.facilities.length);
  assert.equal(pack.minimumTableRows.station_facility_evidence, pack.stationFacilityEvidence.length);
  assert.match(pack.id, /^nationwide-incheon-accessibility-[a-f0-9]{64}$/);
  assert.match(materializedIncheonAccessibilityPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  const version = accessibilityAdmission.snapshotId.slice(SOURCE_ID.length + 1, SOURCE_ID.length + 9);
  assert.equal(pack.version, version);
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version });
  assert.doesNotThrow(() => validateProductionIncheonAccessibilityFixture([pack], admission));
  const semanticDrift = structuredClone(pack);
  semanticDrift.stationFacilityEvidence.find(({ sourceId }) => sourceId === SOURCE_ID)
    .strictRouteEligible = true;
  assert.throws(
    () => validateProductionIncheonAccessibilityFixture([semanticDrift], admission),
    /does not match pinned admission/,
  );
});

test("receipt-bound Incheon accessibility admits only an exact semantic topology successor", async () => {
  const values = await inputs({ materializeIncheon: false });
  const topologySnapshot = receiptBoundTopologySuccessor(values.topologySnapshot);
  const inventory = rebindSuppliedTopologyInventory(values.inventory, topologySnapshot);
  const admit = ({ sourceInventory = inventory, snapshot = values.accessibilitySnapshot,
    snapshotBytes = values.accessibilityBytes, topology = topologySnapshot } = {}) =>
    admittedIncheonAccessibilityEvidence({
      sourceInventory,
      snapshot,
      snapshotBytes,
      topologySnapshot: topology,
      now: new Date(topologySnapshot.capturedAt),
      topologyMode: "registered-topology-successor",
    });

  const admission = admit();
  assert.equal(admission.snapshotId, values.accessibilitySnapshot.snapshotId);
  assert.equal(admission.facilityCount, 213);
  assert.equal(Object.hasOwn(admission.source, "accessibilityAdmissionEvidence"), false);
  assert.throws(() => admittedIncheonAccessibilityEvidence({
    sourceInventory: inventory,
    snapshot: values.accessibilitySnapshot,
    snapshotBytes: values.accessibilityBytes,
    topologySnapshot,
    now: new Date(topologySnapshot.capturedAt),
  }), /registered topology binding mismatch/);

  const contentMismatchInventory = structuredClone(inventory);
  contentMismatchInventory.sources.find(({ id }) => id === "incheon-transit-station-info")
    .topologyAdmissionEvidence.contentSha256 = "0".repeat(64);
  assert.throws(() => admit({ sourceInventory: contentMismatchInventory }), /topology lineage/);

  const olderTopology = structuredClone(values.topologySnapshot);
  const olderCapturedAt = new Date(Date.parse(olderTopology.capturedAt) - 24 * 60 * 60 * 1000);
  olderTopology.capturedAt = olderCapturedAt.toISOString();
  olderTopology.freshUntil = new Date(olderCapturedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
  olderTopology.snapshotId = `incheon-transit-station-info-${olderTopology.capturedAt
    .slice(0, 10).replaceAll("-", "")}`;
  const olderInventory = rebindSuppliedTopologyInventory(values.inventory, olderTopology);
  assert.throws(() => admit({
    sourceInventory: olderInventory,
    topology: olderTopology,
  }), /registered topology binding mismatch/);

  const claimMismatch = structuredClone(values.accessibilitySnapshot);
  claimMismatch.claimTopology[0].stationCode = "0000";
  const claimMismatchBytes = Buffer.from(`${JSON.stringify(claimMismatch, null, 2)}\n`);
  const claimMismatchInventory = structuredClone(inventory);
  claimMismatchInventory.sources.find(({ id }) => id === SOURCE_ID)
    .registrationEvidence.snapshotFileSha256 = createHash("sha256").update(claimMismatchBytes).digest("hex");
  assert.throws(() => admit({
    sourceInventory: claimMismatchInventory,
    snapshot: claimMismatch,
    snapshotBytes: claimMismatchBytes,
  }), /registered topology binding|claim topology/);

  const lineageIdMismatch = structuredClone(values.accessibilitySnapshot);
  lineageIdMismatch.topologyLineages[0].snapshotId = "incheon-transit-station-info-20260827";
  const lineageIdMismatchBytes = Buffer.from(`${JSON.stringify(lineageIdMismatch, null, 2)}\n`);
  const lineageIdMismatchInventory = structuredClone(inventory);
  lineageIdMismatchInventory.sources.find(({ id }) => id === SOURCE_ID)
    .registrationEvidence.snapshotFileSha256 = createHash("sha256").update(lineageIdMismatchBytes).digest("hex");
  assert.throws(() => admit({
    sourceInventory: lineageIdMismatchInventory,
    snapshot: lineageIdMismatch,
    snapshotBytes: lineageIdMismatchBytes,
  }), /registered topology binding|captured topology lineage/);
});

test("인천 accessibility admission은 freshness·hash·scope·중복을 fail closed한다", async () => {
  const {
    incheonFixture, topologySnapshot, accessibilitySnapshot, accessibilityBytes, accessibilityAdmission,
    accessibilityNow, inventory,
  } = await inputs();

  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: new Date(accessibilitySnapshot.freshUntil),
  }), /freshness/);

  const badHash = structuredClone(accessibilitySnapshot);
  badHash.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot: badHash,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /snapshot/);

  const badSource = structuredClone(accessibilitySnapshot);
  badSource.sourceId = "wrong-source";
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot: badSource,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /snapshot/);

  const badScope = structuredClone(accessibilitySnapshot);
  badScope.rows = badScope.rows.slice(0, 70);
  badScope.rowCount = 70;
  badScope.stationCount = 70;
  badScope.rowsSha256 = createHash("sha256").update(JSON.stringify(badScope.rows)).digest("hex");
  const badScopeInventory = structuredClone(inventory);
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot: badScope,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory: badScopeInventory,
    now: accessibilityNow,
  }), /snapshot/);

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .admissionEvidence.sampleEvidenceHash = "0".repeat(64);
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory: mismatchedInventory,
    now: accessibilityNow,
  }), /inventory evidence/);

  for (const [label, mutate] of [
    ["approval-time schema", (source) => { source.admissionEvidence.schemaFingerprint = "0".repeat(64); }],
    ["approval-time source snapshot set", (source) => { source.admissionEvidence.sourceSnapshotSetHash = "0".repeat(64); }],
    ["registered normalized schema", (source) => { source.registrationEvidence.normalizedSchemaFingerprint = "0".repeat(64); }],
    ["registered snapshot bytes", (source) => { source.registrationEvidence.snapshotFileSha256 = "0".repeat(64); }],
    ["registered claim bindings", (source) => { source.registrationEvidence.claimBindingsSha256 = "0".repeat(64); }],
    ["registered admin review", (source) => { source.registrationEvidence.adminReviewRecordHash = "0".repeat(64); }],
  ]) {
    const invalidInventory = structuredClone(inventory);
    mutate(invalidInventory.sources.find(({ id }) => id === SOURCE_ID));
    assert.throws(() => materializeIncheonAccessibility({
      baseFixture: incheonFixture,
      accessibilitySnapshot,
      accessibilitySnapshotBytes: accessibilityBytes,
      topologySnapshot,
      inventory: invalidInventory,
      now: accessibilityNow,
    }), /inventory evidence|registration evidence/, label);
  }

  const badLineage = structuredClone(accessibilitySnapshot);
  badLineage.topologyLineages[0].contentSha256 = "0".repeat(64);
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot: badLineage,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /inventory evidence|registered topology binding|topology lineage/);

  const badCapturedLineage = structuredClone(accessibilitySnapshot);
  badCapturedLineage.topologyLineages[0].snapshotId =
    "incheon-transit-station-info-20260813";
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot: badCapturedLineage,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /registered topology binding|captured topology lineage/);

  const badActiveLineage = structuredClone(inventory);
  badActiveLineage.sources.find(({ id }) => id === "incheon-transit-station-info")
    .topologyAdmissionEvidence.snapshotPath =
      "tools/datapack/sources/incheon-transit-station-info-20260724.json";
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory: badActiveLineage,
    now: accessibilityNow,
  }), /topology lineage/);

  const admitted = materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  });
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: admitted,
    accessibilitySnapshot,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /already exists/);
});

test("인천 accessibility materializer는 supplied current topology rename lineage만 admit한다", async () => {
  const values = await inputs({ materializeIncheon: false });
  const topologySnapshot = suppliedCurrentTopology(values);
  const inventory = rebindSuppliedTopologyInventory(values.inventory, topologySnapshot);
  const topologyBytes = Buffer.from(`${JSON.stringify(topologySnapshot)}\n`);
  const incheonFixture = materializeIncheonStationInfo({
    baseFixture: values.regionalFixture,
    snapshot: topologySnapshot,
    snapshotSha256: createHash("sha256").update(topologyBytes).digest("hex"),
    inventory,
    now: new Date("2026-08-28T04:00:00.000Z"),
  });
  assert.equal(incheonFixture.packs[0].stations.find(({ id }) => id === "station-b1a5f63faf69")?.nameKo, "서해구청");
  const accessibilitySnapshot = structuredClone(values.accessibilitySnapshot);
  for (const lineage of [...accessibilitySnapshot.topologyLineages, ...accessibilitySnapshot.membershipLineages]) {
    lineage.snapshotId = topologySnapshot.snapshotId;
    lineage.contentSha256 = topologySnapshot.contentSha256;
  }
  const accessibilitySnapshotBytes = Buffer.from(`${JSON.stringify(accessibilitySnapshot, null, 2)}\n`);
  inventory.sources.find(({ id }) => id === SOURCE_ID).registrationEvidence.snapshotFileSha256 =
    createHash("sha256").update(accessibilitySnapshotBytes).digest("hex");
  const admitted = materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot,
    accessibilitySnapshotBytes,
    topologySnapshot,
    inventory,
    now: values.accessibilityNow,
  });
  assert.equal(admitted.packs[0].facilities.filter(({ sourceId }) => sourceId === SOURCE_ID).length, 213);

  const predecessorTopology = await readJson(
    "tools/datapack/sources/incheon-transit-station-info-20260813.json",
  );
  assert.notEqual(predecessorTopology.contentSha256, topologySnapshot.contentSha256);
  const predecessor = structuredClone(accessibilitySnapshot);
  predecessor.topologyLineages[0].contentSha256 = predecessorTopology.contentSha256;
  assert.throws(() => materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot: predecessor,
    accessibilitySnapshotBytes,
    topologySnapshot,
    inventory,
    now: values.accessibilityNow,
  }), /registered topology binding|captured topology lineage/);
});

test("materialized SQLite와 provenance가 인천 accessibility_facilities 3건을 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-incheon-accessibility-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const {
    incheonFixture, topologySnapshot, accessibilitySnapshot, accessibilityBytes, accessibilityAdmission,
    accessibilityNow, inventory,
  } = await inputs();
  const fixture = materializeIncheonAccessibility({
    baseFixture: incheonFixture,
    accessibilitySnapshot,
    accessibilitySnapshotBytes: accessibilityBytes,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], { cwd: root, env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey } });
  await materializeRegionalProductionCandidate({ outputDir: packOutput, privateKey });

  const manifestPath = path.join(packOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(
    packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/"),
  ).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM facilities WHERE source_id = ?")
    .get(SOURCE_ID).count, 213);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_facility_evidence WHERE source_id = ?")
    .get(SOURCE_ID).count, 213);
  assert.equal(database.prepare(`
    SELECT COUNT(DISTINCT facility_type) AS count
    FROM station_facility_evidence
    WHERE source_id = ?
  `).get(SOURCE_ID).count, 3);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  const facilityRecords = provenance.packs.flatMap(({ records }) => records).filter(
    ({ sourceId, entityType }) => sourceId === SOURCE_ID && entityType === "facility",
  );
  for (const field of ACCESSIBILITY_FIELDS) {
    const fieldRecords = facilityRecords.filter((record) => record.field === field);
    assert.ok(fieldRecords.length > 0, `provenance missing field: ${field}`);
    assert.deepEqual(
      [...new Set(fieldRecords.flatMap(({ coverageScope }) => coverageScope?.lineIds ?? []))].sort(),
      [LINE2, LINE1, LINE7].sort(),
    );
    assert.ok(fieldRecords.every((record) => (
      record.sourceSnapshotId === accessibilityAdmission.snapshotId
        && record.evidenceHash === accessibilitySnapshot.rowsSha256
        && /^[a-f0-9]{64}$/.test(record.providerRecordHash)
        && record.derivationKind === "OFFICIAL"
    )));
  }

  await execFileAsync(process.execPath, [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets", "tools/datapack/nationwide-coverage-targets.json",
    "--inventory", "tools/datapack/source-inventory.json",
    "--manifest", manifestPath,
    "--provenance", path.join(packOutput, "current.provenance.json"),
    "--resolution-plan", "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json",
    "--resolutions", "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json",
    "--output", reportPath,
    "--allow-gaps",
  ], { cwd: root });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const accessibilityRequirements = report.requirements.filter(
    ({ operatorId, sourceDomain, lineId }) => operatorId === OPERATOR_ID
      && sourceDomain === "accessibility_facilities"
      && [LINE1, LINE2, LINE7].includes(lineId),
  );
  assert.equal(accessibilityRequirements.length, 3);
  assert.ok(accessibilityRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(
    accessibilityRequirements.map(({ lineId }) => lineId).sort(),
    [LINE2, LINE1, LINE7].sort(),
  );
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: ACCESSIBILITY_SUPPORTED_COUNT,
    explicitlyUnsupportedCount: 4,
    missingCount: 270 - ACCESSIBILITY_SUPPORTED_COUNT - 4,
    supportedRatio: Number((ACCESSIBILITY_SUPPORTED_COUNT / 270).toFixed(4)),
    terminalResolutionRatio: Number(((ACCESSIBILITY_SUPPORTED_COUNT + 4) / 270).toFixed(4)),
    completionReady: false,
  });
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
