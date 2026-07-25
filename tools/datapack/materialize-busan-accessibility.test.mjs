import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import {
  materializeBusanAccessibility,
  materializedBusanAccessibilityPackContentHash,
} from "./materialize-busan-accessibility.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import {
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const routeMapNow = new Date("2026-07-20T11:13:18.000Z");
const accessibilityNow = new Date("2026-07-24T12:00:00.000Z");
const SOURCE_ID = "busan-transportation-accessibility";
// route-map 누적 fixture coverage baseline(실측): supportedCount=19 → accessibility +4 = 23.
const ROUTE_MAP_BASELINE_SUPPORTED_COUNT = 19;
const ACCESSIBILITY_SUPPORTED_COUNT = ROUTE_MAP_BASELINE_SUPPORTED_COUNT + 4;
const BUSAN_LINE_IDS = Object.freeze([
  "line-ab1a041f6266",
  "line-d74614a04530",
  "line-d812a5bc1e5f",
  "line-eb7b47920390",
]);
const ACCESSIBILITY_FIELDS = Object.freeze([
  "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
]);

async function inputs() {
  const [
    baseFixture,
    topologySnapshot,
    timetableSnapshot,
    routeMapSnapshotBytes,
    accessibilitySnapshot,
    daejeonTopologySnapshot,
    daejeonTimetableSnapshot,
    inventory,
    stationMapCsv,
    molitStationMapCsv,
  ] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/busan-transportation-accessibility-20260724.json"),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const topologyFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot: topologySnapshot,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(stationMapCsv),
    now: topologyNow,
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: topologyFixture,
    timetableSnapshot: daejeonTimetableSnapshot,
    topologySnapshot: daejeonTopologySnapshot,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitStationMapCsv),
    now: routeMapNow,
  });
  const timetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture,
    timetableSnapshot,
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  const routeMapSnapshot = JSON.parse(routeMapSnapshotBytes);
  const routeMapFixture = materializeBusanRouteMapPositions({
    baseFixture: timetableFixture,
    snapshot: routeMapSnapshot,
    snapshotSha256: createHash("sha256").update(routeMapSnapshotBytes).digest("hex"),
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  return {
    routeMapFixture,
    topologySnapshot,
    accessibilitySnapshot,
    inventory,
  };
}

test("부산 공식 114역 편의시설을 facility·evidence 342건으로 materialize한다", async () => {
  const { routeMapFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();
  const fixture = materializeBusanAccessibility({
    baseFixture: routeMapFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  });
  const pack = fixture.packs[0];
  const facilities = pack.facilities.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const evidence = pack.stationFacilityEvidence.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  assert.equal(facilities.length, 342);
  assert.equal(evidence.length, 342);
  assert.equal(new Set(facilities.map(({ id }) => id)).size, 342);
  assert.equal(new Set(evidence.map(({ stationId, lineId, facilityType }) =>
    `${stationId}:${lineId}:${facilityType}`)).size, 342);
  assert.deepEqual([...new Set(facilities.map(({ type }) => type))].sort(), [
    "ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT",
  ]);
  assert.equal(new Set(facilities.map(({ lineId }) => lineId)).size, 4);
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

  // wl=0 역도 wheelchair_lift NOT_EXISTS를 남겨 4개 노선 field provenance를 확보한다.
  const wheelchair = evidence.filter(({ facilityType }) => facilityType === "WHEELCHAIR_LIFT");
  assert.equal(wheelchair.length, 114);
  assert.equal(wheelchair.filter(({ evidenceKind }) => evidenceKind === "NOT_EXISTS").length, 111);
  assert.equal(wheelchair.filter(({ evidenceKind }) => evidenceKind === "EXISTS").length, 3);
  assert.deepEqual(
    [...new Set(wheelchair.map(({ lineId }) => lineId))].sort(),
    accessibilitySnapshot.lineIds,
  );

  const station219 = facilities.find(({ id }) => id === "facility-busan-219-wheelchair-lift");
  assert.equal(station219.installationStatus, "INSTALLED");
  assert.equal(
    evidence.find(({ stationId, lineId, facilityType }) =>
      stationId === station219.stationId
        && lineId === station219.lineId
        && facilityType === "WHEELCHAIR_LIFT").evidenceKind,
    "EXISTS",
  );
  const station100 = facilities.find(({ id }) => id === "facility-busan-100-wheelchair-lift");
  assert.equal(station100.installationStatus, "NOT_INSTALLED");

  assert.equal(source.license, "공공누리 제1유형");
  assert.deepEqual(source.coverageScope.lineIds, accessibilitySnapshot.lineIds);
  assert.equal(pack.minimumTableRows.facilities, pack.facilities.length);
  assert.equal(pack.minimumTableRows.station_facility_evidence, pack.stationFacilityEvidence.length);
  assert.match(pack.id, /^nationwide-busan-accessibility-[a-f0-9]{64}$/);
  assert.equal(typeof materializedBusanAccessibilityPackContentHash(pack, pack.version), "string");
  assert.match(materializedBusanAccessibilityPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260724");
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260724" });
});

test("부산 accessibility admission은 freshness·hash·scope·중복을 fail closed한다", async () => {
  const { routeMapFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();

  assert.throws(() => materializeBusanAccessibility({
    baseFixture: routeMapFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: new Date("2026-07-25T00:19:05.836Z"),
  }), /freshness/);

  const badHash = structuredClone(accessibilitySnapshot);
  badHash.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeBusanAccessibility({
    baseFixture: routeMapFixture,
    accessibilitySnapshot: badHash,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /snapshot/);

  const badSource = structuredClone(accessibilitySnapshot);
  badSource.sourceId = "wrong-source";
  assert.throws(() => materializeBusanAccessibility({
    baseFixture: routeMapFixture,
    accessibilitySnapshot: badSource,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /snapshot/);

  const badScope = structuredClone(accessibilitySnapshot);
  badScope.rows = badScope.rows.slice(0, 113);
  badScope.rowCount = 113;
  badScope.stationCount = 113;
  badScope.rowsSha256 = createHash("sha256").update(JSON.stringify(badScope.rows)).digest("hex");
  const badScopeInventory = structuredClone(inventory);
  Object.assign(
    badScopeInventory.sources.find(({ id }) => id === SOURCE_ID).accessibilityAdmissionEvidence,
    { rowCount: 113, stationCount: 113, facilityCount: 339, rowsSha256: badScope.rowsSha256 },
  );
  assert.throws(() => materializeBusanAccessibility({
    baseFixture: routeMapFixture,
    accessibilitySnapshot: badScope,
    topologySnapshot,
    inventory: badScopeInventory,
    now: accessibilityNow,
  }), /snapshot/);

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeBusanAccessibility({
    baseFixture: routeMapFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory: mismatchedInventory,
    now: accessibilityNow,
  }), /inventory evidence/);

  const admitted = materializeBusanAccessibility({
    baseFixture: routeMapFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  });
  assert.throws(() => materializeBusanAccessibility({
    baseFixture: admitted,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /already exists/);
});

test("materialized SQLite와 provenance가 부산 accessibility_facilities 4건을 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-busan-accessibility-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { routeMapFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();
  const fixture = materializeBusanAccessibility({
    baseFixture: routeMapFixture,
    accessibilitySnapshot,
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

  const manifestPath = path.join(packOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(
    packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/"),
  ).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM facilities WHERE source_id = ?")
    .get(SOURCE_ID).count, 342);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_facility_evidence WHERE source_id = ?")
    .get(SOURCE_ID).count, 342);
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
      [...BUSAN_LINE_IDS],
    );
    assert.ok(fieldRecords.every((record) => (
      record.sourceSnapshotId === "busan-transportation-accessibility-20260724"
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
    ({ operatorId, sourceDomain }) => operatorId === "busan-transportation"
      && sourceDomain === "accessibility_facilities",
  );
  assert.equal(accessibilityRequirements.length, 4);
  assert.ok(accessibilityRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(
    accessibilityRequirements.map(({ lineId }) => lineId).sort(),
    [...BUSAN_LINE_IDS],
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
