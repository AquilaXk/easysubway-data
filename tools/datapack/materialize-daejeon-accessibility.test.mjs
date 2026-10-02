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
  loadRegionalBusanTimetablePrefix,
  materializeRegionalProductionCandidate,
  projectRegionalFixtureSourceBindings,
} from "./materialize-test-fixture.mjs";

import {
  materializeDaejeonAccessibility,
  materializedDaejeonAccessibilityPackContentHash,
} from "./materialize-daejeon-accessibility.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T11:13:18.000Z");
const SOURCE_ID = "daejeon-transportation-accessibility";
const LINE_ID = "line-7051a9c2525c";
const ACCESSIBILITY_FIELDS = Object.freeze([
  "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
]);

async function inputs() {
  const [
    regional,
    currentInventory,
  ] = await Promise.all([
    loadRegionalBusanTimetablePrefix({
      baseFixturePromise: readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
      inventoryPromise: readJson("tools/datapack/source-inventory.json"),
      readJson,
      topologyNow,
      timetableNow,
    }),
    readJson("tools/datapack/source-inventory.json"),
  ]);
  const topologySource = currentInventory.sources.find(({ id }) => id === "daejeon-station-distance-fare");
  const accessibilitySource = currentInventory.sources.find(({ id }) => id === SOURCE_ID);
  const [topologySnapshot, accessibilitySnapshotBytes] = await Promise.all([
    readJson(topologySource.topologyAdmissionEvidence.snapshotPath),
    readFile(path.join(root, accessibilitySource.accessibilityAdmissionEvidence.snapshotPath)),
  ]);
  const accessibilitySnapshot = JSON.parse(accessibilitySnapshotBytes);
  const inventory = projectRegionalFixtureSourceBindings({
    inventory: regional.inventory,
    daejeonTopology: topologySnapshot,
    molitMappings: regional.molitMappings,
    daejeonAccessibilitySnapshot: accessibilitySnapshot,
    daejeonAccessibilitySnapshotBytes: accessibilitySnapshotBytes,
  });
  const { busanTimetableFixture: timetableFixture } = regional;
  return {
    timetableFixture,
    topologySnapshot,
    accessibilitySnapshot,
    inventory,
  };
}

test("대전 공식 22역 편의시설을 원천이 제공하는 엘리베이터·에스컬레이터 44건으로만 materialize한다", async () => {
  const { timetableFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();
  const fixture = materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
  });
  const pack = fixture.packs[0];
  const facilities = pack.facilities.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const evidence = pack.stationFacilityEvidence.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  assert.equal(facilities.length, 44);
  assert.equal(evidence.length, 44);
  assert.equal(new Set(facilities.map(({ id }) => id)).size, 44);
  assert.equal(new Set(evidence.map(({ stationId, lineId, facilityType }) =>
    `${stationId}:${lineId}:${facilityType}`)).size, 44);
  assert.deepEqual([...new Set(facilities.map(({ type }) => type))].sort(), [
    "ELEVATOR", "ESCALATOR",
  ]);
  assert.equal(new Set(facilities.map(({ lineId }) => lineId)).size, 1);
  assert.deepEqual([...new Set(facilities.map(({ lineId }) => lineId))], [LINE_ID]);
  // 대전 원천(엘리베이터·에스컬레이터 파일)에는 휠체어리프트 열이 없다. 근거 없는 부재 claim·문구를 만들지 않는다.
  assert.equal(evidence.filter(({ facilityType }) => facilityType === "WHEELCHAIR_LIFT").length, 0);
  assert.equal(evidence.filter(({ evidenceKind }) => evidenceKind === "NOT_EXISTS").length, 0);
  assert.ok(facilities.every(({ name, description }) => !`${name}${description}`.includes("휠체어리프트")));
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
  assert.deepEqual(source.coverageScope.lineIds, [LINE_ID]);
  assert.equal(pack.minimumTableRows.facilities, pack.facilities.length);
  assert.equal(pack.minimumTableRows.station_facility_evidence, pack.stationFacilityEvidence.length);
  assert.match(pack.id, /^nationwide-daejeon-accessibility-[a-f0-9]{64}$/);
  assert.match(materializedDaejeonAccessibilityPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  // #862: 판 날짜는 고정 상수가 아니라 inventory admission snapshot id의 수집 날짜(-YYYYMMDD)다.
  const admittedSnapshotId = (await readJson("tools/datapack/source-inventory.json")).sources
    .find(({ id }) => id === SOURCE_ID).accessibilityAdmissionEvidence.snapshotId;
  const expectedVersion = /-([0-9]{8})$/u.exec(admittedSnapshotId)?.[1];
  assert.match(expectedVersion ?? "", /^[0-9]{8}$/u);
  assert.equal(pack.version, expectedVersion);
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: expectedVersion });
});

test("대전 accessibility admission은 freshness·hash·scope·중복을 fail closed한다", async () => {
  const { timetableFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();

  const invalidWindow = structuredClone(accessibilitySnapshot);
  invalidWindow.freshUntil = invalidWindow.capturedAt;
  const invalidWindowInventory = structuredClone(inventory);
  invalidWindowInventory.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.freshUntil = invalidWindow.capturedAt;
  assert.throws(() => materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot: invalidWindow,
    topologySnapshot,
    inventory: invalidWindowInventory,
  }), /freshness/);

  const badHash = structuredClone(accessibilitySnapshot);
  badHash.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot: badHash,
    topologySnapshot,
    inventory,
  }), /snapshot/);

  const badSource = structuredClone(accessibilitySnapshot);
  badSource.sourceId = "wrong-source";
  assert.throws(() => materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot: badSource,
    topologySnapshot,
    inventory,
  }), /snapshot/);

  const badScope = structuredClone(accessibilitySnapshot);
  badScope.rows = badScope.rows.slice(0, 21);
  badScope.rowCount = 21;
  badScope.stationCount = 21;
  badScope.rowsSha256 = createHash("sha256").update(JSON.stringify(badScope.rows)).digest("hex");
  const badScopeInventory = structuredClone(inventory);
  Object.assign(
    badScopeInventory.sources.find(({ id }) => id === SOURCE_ID).accessibilityAdmissionEvidence,
    { rowCount: 21, stationCount: 21, facilityCount: 63, rowsSha256: badScope.rowsSha256 },
  );
  assert.throws(() => materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot: badScope,
    topologySnapshot,
    inventory: badScopeInventory,
  }), /snapshot/);

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory: mismatchedInventory,
  }), /inventory evidence/);

  const badLineage = structuredClone(inventory);
  badLineage.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.topologyLineages[0].contentSha256 = "0".repeat(64);
  assert.throws(() => materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory: badLineage,
  }), /inventory evidence|topology lineage/);

  const admitted = materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
  });
  assert.throws(() => materializeDaejeonAccessibility({
    baseFixture: admitted,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
  }), /already exists/);
});

test("materialized SQLite와 provenance는 대전 휠체어리프트 미제공을 wheelchair_lift gap으로 드러낸다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-daejeon-accessibility-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { timetableFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();
  const fixture = materializeDaejeonAccessibility({
    baseFixture: timetableFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
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
    .get(SOURCE_ID).count, 44);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_facility_evidence WHERE source_id = ?")
    .get(SOURCE_ID).count, 44);
  assert.equal(database.prepare(`
    SELECT COUNT(DISTINCT facility_type) AS count
    FROM station_facility_evidence
    WHERE source_id = ?
  `).get(SOURCE_ID).count, 2);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  const sourceSnapshotId = inventory.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.snapshotId;
  const facilityRecords = provenance.packs.flatMap(({ records }) => records).filter(
    ({ sourceId, entityType }) => sourceId === SOURCE_ID && entityType === "facility",
  );
  // 원천이 휠체어리프트를 공표하지 않으므로 wheelchair_lift 필드 provenance가 없다. 이 공백은 지어낸 0으로
  // 메우지 않고 LAUNCH_REQUIRED gap(MISSING)으로 드러낸다(QA 결정 2026-10-02).
  assert.equal(facilityRecords.filter((record) => record.field === "wheelchair_lift").length, 0);
  for (const field of ACCESSIBILITY_FIELDS.filter((name) => name !== "wheelchair_lift")) {
    const fieldRecords = facilityRecords.filter((record) => record.field === field);
    assert.ok(fieldRecords.length > 0, `provenance missing field: ${field}`);
    assert.deepEqual(
      [...new Set(fieldRecords.flatMap(({ coverageScope }) => coverageScope?.lineIds ?? []))],
      [LINE_ID],
    );
    assert.ok(fieldRecords.every((record) => (
      record.sourceSnapshotId === sourceSnapshotId
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
    ({ operatorId, sourceDomain }) => operatorId === "daejeon-transportation"
      && sourceDomain === "accessibility_facilities",
  );
  assert.equal(accessibilityRequirements.length, 1);
  assert.ok(accessibilityRequirements.every(({ status, missingFields }) => status === "MISSING"
    && JSON.stringify(missingFields) === JSON.stringify(["wheelchair_lift"])));
  assert.deepEqual(
    accessibilityRequirements.map(({ lineId }) => lineId),
    [LINE_ID],
  );
  assert.equal(report.summary.launchRequired.completionReady, false);
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
