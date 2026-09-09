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
  loadRegionalGwangjuTimetablePrefix,
  materializeRegionalProductionCandidate,
  projectHistoricalDaeguMaterializeInventory,
  projectHistoricalRegionalMaterializeInventory,
  projectRegionalMaterializeFixture,
} from "./materialize-test-fixture.mjs";

import {
  parseMolitDaeguStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { DAEGU_LINES, daeguSourceSnapshotIdentity } from "./collect-daegu-datapack-sources.mjs";
import { materializeDaeguTimetable } from "./materialize-daegu-timetable.mjs";
import {
  materializeDaeguAccessibility,
  materializedDaeguAccessibilityPackContentHash,
  daeguAccessibilityTopologyLineageIdentity,
} from "./materialize-daegu-accessibility.mjs";

const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const timetableNow = new Date("2026-07-20T16:00:00.000Z");
const execFileAsync = promisify(execFile);
const SOURCE_ID = "daegu-transportation-accessibility";
const LINE_IDS = Object.freeze(DAEGU_LINES.map(({ lineId }) => lineId));
const ACCESSIBILITY_FIELDS = Object.freeze([
  "elevator", "escalator", "wheelchair_lift", "status", "verified_at",
]);

async function inputs() {
  const [regional, accessibilitySnapshot] = await Promise.all([
    loadRegionalGwangjuTimetablePrefix({
      baseFixturePromise: readJson("tools/datapack/release/capital-production-reviewed-pack.json").then(projectRegionalMaterializeFixture),
      inventoryPromise: readJson("tools/datapack/source-inventory.json").then(projectHistoricalRegionalMaterializeInventory),
      readJson,
      topologyNow: new Date("2026-07-19T18:14:03.004Z"),
      timetableNow,
    }),
    readJson("tools/datapack/sources/daegu-transportation-accessibility-20260724.json"),
  ]);
  const { gwangjuFixture, molitStationMapCsv: molitMap } = regional;
  const topologySnapshots = {};
  const timetableSnapshots = {};
  const mappings = {};
  for (const config of DAEGU_LINES) {
    topologySnapshots[config.lineNumber] = await readJson(
      `tools/datapack/sources/daegu-line${config.lineNumber}-route-topology-20260721.json`,
    );
    timetableSnapshots[config.lineNumber] = await readJson(
      `tools/datapack/sources/daegu-line${config.lineNumber}-train-timetable-20260721.json`,
    );
    mappings[config.lineNumber] = parseMolitDaeguStationMappings(molitMap, config.lineName);
  }
  const inventory = projectHistoricalDaeguMaterializeInventory({
    inventory: regional.inventory, topologySnapshots, timetableSnapshots, mappings,
  });
  const topologyLineages = DAEGU_LINES.map((config) => ({
    sourceId: topologySnapshots[config.lineNumber].sourceId,
    snapshotId: daeguSourceSnapshotIdentity(topologySnapshots[config.lineNumber]),
    contentSha256: topologySnapshots[config.lineNumber].contentSha256,
    lineId: config.lineId,
  }));
  accessibilitySnapshot.topologyLineages = topologyLineages;
  const admission = inventory.sources.find(({ id }) => id === SOURCE_ID).accessibilityAdmissionEvidence;
  Object.assign(admission, {
    topologyLineages,
    topologySnapshotId: daeguAccessibilityTopologyLineageIdentity(topologyLineages),
    topologyContentSha256: createHash("sha256").update(JSON.stringify(topologyLineages)).digest("hex"),
  });
  const daeguFixture = materializeDaeguTimetable({
    baseFixture: gwangjuFixture, topologySnapshots, timetableSnapshots, inventory,
    canonicalStationMappings: mappings, now: timetableNow,
  });
  return {
    daeguFixture,
    topologySnapshots,
    accessibilitySnapshot,
    inventory,
  };
}

test("대구 공식 94역 편의시설을 facility·evidence 282건으로 materialize한다", async () => {
  const { daeguFixture, topologySnapshots, accessibilitySnapshot, inventory } = await inputs();
  const fixture = materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot,
    topologySnapshots,
    inventory,
  });
  const pack = fixture.packs[0];
  const facilities = pack.facilities.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const evidence = pack.stationFacilityEvidence.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  assert.equal(facilities.length, 282);
  assert.equal(evidence.length, 282);
  assert.equal(new Set(facilities.map(({ id }) => id)).size, 282);
  assert.equal(new Set(evidence.map(({ stationId, lineId, facilityType }) =>
    `${stationId}:${lineId}:${facilityType}`)).size, 282);
  assert.deepEqual([...new Set(facilities.map(({ type }) => type))].sort(), [
    "ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT",
  ]);
  assert.equal(new Set(facilities.map(({ lineId }) => lineId)).size, 3);
  assert.deepEqual([...new Set(facilities.map(({ lineId }) => lineId))].sort(), [...LINE_IDS].sort());
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
  assert.deepEqual(source.coverageScope.lineIds, [...LINE_IDS]);
  assert.equal(pack.minimumTableRows.facilities, pack.facilities.length);
  assert.equal(pack.minimumTableRows.station_facility_evidence, pack.stationFacilityEvidence.length);
  assert.match(pack.id, /^nationwide-daegu-accessibility-[a-f0-9]{64}$/);
  assert.match(materializedDaeguAccessibilityPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260724");
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260724" });
});

test("대구 accessibility admission은 freshness·hash·scope·중복을 fail closed한다", async () => {
  const { daeguFixture, topologySnapshots, accessibilitySnapshot, inventory } = await inputs();

  const invalidWindow = structuredClone(accessibilitySnapshot);
  invalidWindow.freshUntil = invalidWindow.capturedAt;
  const invalidWindowInventory = structuredClone(inventory);
  invalidWindowInventory.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.freshUntil = invalidWindow.capturedAt;
  assert.throws(() => materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot: invalidWindow,
    topologySnapshots,
    inventory: invalidWindowInventory,
  }), /freshness/);

  const badHash = structuredClone(accessibilitySnapshot);
  badHash.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot: badHash,
    topologySnapshots,
    inventory,
  }), /snapshot/);

  const badSource = structuredClone(accessibilitySnapshot);
  badSource.sourceId = "wrong-source";
  assert.throws(() => materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot: badSource,
    topologySnapshots,
    inventory,
  }), /snapshot/);

  const badScope = structuredClone(accessibilitySnapshot);
  badScope.rows = badScope.rows.slice(0, 93);
  badScope.rowCount = 93;
  badScope.stationCount = 93;
  badScope.rowsSha256 = createHash("sha256").update(JSON.stringify(badScope.rows)).digest("hex");
  const badScopeInventory = structuredClone(inventory);
  Object.assign(
    badScopeInventory.sources.find(({ id }) => id === SOURCE_ID).accessibilityAdmissionEvidence,
    { rowCount: 93, stationCount: 93, facilityCount: 279, rowsSha256: badScope.rowsSha256 },
  );
  assert.throws(() => materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot: badScope,
    topologySnapshots: topologySnapshots,
    inventory: badScopeInventory,
  }), /snapshot/);

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot,
    topologySnapshots,
    inventory: mismatchedInventory,
  }), /inventory evidence/);

  const badLineage = structuredClone(inventory);
  badLineage.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.topologyLineages[0].contentSha256 = "0".repeat(64);
  assert.throws(() => materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot,
    topologySnapshots,
    inventory: badLineage,
  }), /inventory evidence|topology lineage/);

  const admitted = materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot,
    topologySnapshots,
    inventory,
  });
  assert.throws(() => materializeDaeguAccessibility({
    baseFixture: admitted,
    accessibilitySnapshot,
    topologySnapshots,
    inventory,
  }), /already exists/);
});

test("materialized SQLite와 provenance가 대구 accessibility_facilities 3건을 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-daegu-accessibility-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { daeguFixture, topologySnapshots, accessibilitySnapshot, inventory } = await inputs();
  const fixture = materializeDaeguAccessibility({
    baseFixture: daeguFixture,
    accessibilitySnapshot,
    topologySnapshots,
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
    .get(SOURCE_ID).count, 282);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_facility_evidence WHERE source_id = ?")
    .get(SOURCE_ID).count, 282);
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
      [...LINE_IDS].sort(),
    );
    assert.ok(fieldRecords.every((record) => (
      record.sourceSnapshotId === "daegu-transportation-accessibility-20260724"
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
    ({ operatorId, sourceDomain }) => operatorId === "daegu-transportation"
      && sourceDomain === "accessibility_facilities",
  );
  assert.equal(accessibilityRequirements.length, 3);
  assert.ok(accessibilityRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(
    accessibilityRequirements.map(({ lineId }) => lineId).sort(),
    [...LINE_IDS].sort(),
  );
  assert.equal(report.summary.launchRequired.completionReady, false);
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
