import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { collectGwangjuAccessibility } from "./collect-gwangju-accessibility.mjs";
import {
  loadRegionalGwangjuAccessibilityPrefix,
  materializeRegionalProductionCandidate,
  projectHistoricalRegionalMaterializeInventory,
  projectRegionalMaterializeFixture,
} from "./materialize-test-fixture.mjs";

import {
  materializeGwangjuAccessibility,
  materializedGwangjuAccessibilityPackContentHash,
} from "./materialize-gwangju-accessibility.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T13:09:00.000Z");
const accessibilityNow = new Date("2026-07-24T03:00:00.000Z");
const SOURCE_ID = "gwangju-transportation-accessibility";
const LINE_ID = "line-e57a361e8892";
const OPERATOR_ID = "gwangju-metropolitan-rapid-transit";
const ACCESSIBILITY_FIELDS = Object.freeze([
  "elevator", "escalator", "status", "verified_at",
]);

test("schema2 미관측 시설은 materialized 부재 evidence가 되지 않는다", async () => {
  const { accessibilityFixture, accessibilitySnapshot, gwangjuFixture, gwangjuTopology, inventory } = await loadRegionalGwangjuAccessibilityPrefix({
    baseFixturePromise: readJson("tools/datapack/release/capital-production-reviewed-pack.json").then(projectRegionalMaterializeFixture),
    inventoryPromise: readJson("tools/datapack/source-inventory.json").then(projectHistoricalRegionalMaterializeInventory),
    readJson, topologyNow, timetableNow, gwangjuAccessibilityNow: accessibilityNow,
  });
  const pack = accessibilityFixture.packs[0];
  const facilities = pack.facilities.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const evidence = pack.stationFacilityEvidence.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const expected = accessibilitySnapshot.rows.reduce((sum, row) => sum
    + [row.elevator, row.escalator].filter((count) => count !== null).length, 0);
  assert.equal(facilities.length, expected);
  assert.equal(evidence.length, expected);
  assert.ok(facilities.every(({ type, installationStatus }) =>
    type !== "WHEELCHAIR_LIFT" && installationStatus !== "NOT_INSTALLED"));
  assert.ok(evidence.every(({ operationalStatus, strictRouteEligible }) =>
    operationalStatus === "UNKNOWN" && strictRouteEligible === false));
  const elevatorBytes = await readFile(path.join(root, "tools/datapack/fixtures/gwangju-accessibility-raw/data-go-15041385.csv"));
  const escalatorBytes = await readFile(path.join(root, "tools/datapack/fixtures/gwangju-accessibility-raw/data-go-15041362.csv"));
  // 자체 hash가 유효해도 admission 원문과 다르면 소비할 수 없다.
  // 행 수가 같은 원문 변경과 잘린 원문을 모두 실제 collector로 재생성한다.
  for (const alteredBytes of [
    Buffer.concat([elevatorBytes, Buffer.from("\n")]),
    Buffer.from(elevatorBytes.toString("utf8").split(/\r?\n/).slice(0, 2).join("\n")),
  ]) {
    const altered = collectGwangjuAccessibility({
      elevatorBytes: alteredBytes, escalatorBytes, topologySnapshot: gwangjuTopology,
      topologySource: inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology"),
      now: accessibilityNow,
    });
    assert.notEqual(altered.rawSha256, accessibilitySnapshot.rawSha256);
    assert.throws(() => materializeGwangjuAccessibility({
      baseFixture: gwangjuFixture, accessibilitySnapshot: altered,
      topologySnapshot: gwangjuTopology, inventory, now: accessibilityNow,
    }), /inventory evidence does not match snapshot/);
  }
});

async function inputs() {
  const regional = await loadRegionalGwangjuAccessibilityPrefix({
      baseFixturePromise: readJson("tools/datapack/release/capital-production-reviewed-pack.json").then(projectRegionalMaterializeFixture),
      inventoryPromise: readJson("tools/datapack/source-inventory.json").then(projectHistoricalRegionalMaterializeInventory),
      readJson,
      topologyNow,
      timetableNow,
      gwangjuAccessibilityNow: accessibilityNow,
    });
  const { gwangjuFixture, gwangjuTopology: topologySnapshot, inventory, accessibilitySnapshot } = regional;
  return {
    gwangjuFixture,
    topologySnapshot,
    accessibilitySnapshot,
    inventory,
  };
}

test("광주 공식 관측 시설만 facility·evidence로 materialize한다", async () => {
  const { gwangjuFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();
  gwangjuFixture.packs[0].sourceInventory = gwangjuFixture.packs[0].sourceInventory
    .filter(({ id }) => id !== "kric-nationwide-timetable-file");
  const missingTopology = structuredClone(gwangjuFixture);
  missingTopology.packs[0].sourceInventory = missingTopology.packs[0].sourceInventory
    .filter(({ id }) => id !== "gwangju-transportation-route-topology");
  assert.throws(() => materializeGwangjuAccessibility({
    baseFixture: missingTopology, accessibilitySnapshot, topologySnapshot, inventory, now: accessibilityNow,
  }), /requires gwangju topology source/);
  const fixture = materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  });
  const pack = fixture.packs[0];
  const facilities = pack.facilities.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const evidence = pack.stationFacilityEvidence.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  const expectedCount = accessibilitySnapshot.rows.reduce((sum, row) => sum
    + [row.elevator, row.escalator].filter((count) => count !== null).length, 0);
  assert.equal(facilities.length, expectedCount);
  assert.equal(evidence.length, expectedCount);
  assert.equal(new Set(facilities.map(({ id }) => id)).size, expectedCount);
  assert.equal(new Set(evidence.map(({ stationId, lineId, facilityType }) =>
    `${stationId}:${lineId}:${facilityType}`)).size, expectedCount);
  assert.deepEqual([...new Set(facilities.map(({ type }) => type))].sort(), [
    "ELEVATOR", "ESCALATOR",
  ]);
  assert.equal(new Set(facilities.map(({ lineId }) => lineId)).size, 1);
  assert.deepEqual([...new Set(facilities.map(({ lineId }) => lineId))], [LINE_ID]);
  assert.equal(facilities.filter(({ type }) => type === "WHEELCHAIR_LIFT").length, 0);
  assert.ok(facilities.every(({ installationStatus }) => installationStatus !== "NOT_INSTALLED"));
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
  assert.deepEqual(source.coverageScope.operatorIds, [OPERATOR_ID]);
  assert.equal(pack.minimumTableRows.facilities, pack.facilities.length);
  assert.equal(pack.minimumTableRows.station_facility_evidence, pack.stationFacilityEvidence.length);
  assert.match(pack.id, /^nationwide-gwangju-accessibility-[a-f0-9]{64}$/);
  assert.match(materializedGwangjuAccessibilityPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260724");
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260724" });
});

test("광주 accessibility admission은 freshness·hash·scope·중복을 fail closed한다", async () => {
  const { gwangjuFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();

  assert.throws(() => materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: new Date("2026-07-25T03:00:00.000Z"),
  }), /freshness/);

  const badHash = structuredClone(accessibilitySnapshot);
  badHash.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot: badHash,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /snapshot/);

  const badSource = structuredClone(accessibilitySnapshot);
  badSource.sourceId = "wrong-source";
  assert.throws(() => materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot: badSource,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /snapshot/);

  const badScope = structuredClone(accessibilitySnapshot);
  badScope.rows = badScope.rows.slice(0, 19);
  badScope.rowCount = 19;
  badScope.stationCount = 19;
  badScope.rowsSha256 = createHash("sha256").update(JSON.stringify(badScope.rows)).digest("hex");
  const badScopeInventory = structuredClone(inventory);
  Object.assign(
    badScopeInventory.sources.find(({ id }) => id === SOURCE_ID).accessibilityAdmissionEvidence,
    { rowCount: 19, stationCount: 19, facilityCount: 57, rowsSha256: badScope.rowsSha256 },
  );
  assert.throws(() => materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot: badScope,
    topologySnapshot,
    inventory: badScopeInventory,
    now: accessibilityNow,
  }), /snapshot/);

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory: mismatchedInventory,
    now: accessibilityNow,
  }), /inventory evidence/);

  const badLineage = structuredClone(inventory);
  badLineage.sources.find(({ id }) => id === SOURCE_ID)
    .accessibilityAdmissionEvidence.topologyLineages[0].contentSha256 = "0".repeat(64);
  assert.throws(() => materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory: badLineage,
    now: accessibilityNow,
  }), /inventory evidence|topology lineage/);

  const admitted = materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  });
  assert.throws(() => materializeGwangjuAccessibility({
    baseFixture: admitted,
    accessibilitySnapshot,
    topologySnapshot,
    inventory,
    now: accessibilityNow,
  }), /already exists/);
});

test("materialized SQLite와 provenance는 미제공 광주 시설 필드를 MISSING으로 유지한다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-gwangju-accessibility-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { gwangjuFixture, topologySnapshot, accessibilitySnapshot, inventory } = await inputs();
  const fixture = materializeGwangjuAccessibility({
    baseFixture: gwangjuFixture,
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
  await materializeRegionalProductionCandidate({ outputDir: packOutput, privateKey });

  const manifestPath = path.join(packOutput, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlitePath = path.join(
    packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/"),
  ).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  const expectedCount = accessibilitySnapshot.rows.reduce((sum, row) => sum
    + [row.elevator, row.escalator].filter((count) => count !== null).length, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM facilities WHERE source_id = ?")
    .get(SOURCE_ID).count, expectedCount);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_facility_evidence WHERE source_id = ?")
    .get(SOURCE_ID).count, expectedCount);
  assert.equal(database.prepare(`
    SELECT COUNT(DISTINCT facility_type) AS count
    FROM station_facility_evidence
    WHERE source_id = ?
  `).get(SOURCE_ID).count, 2);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  const facilityRecords = provenance.packs.flatMap(({ records }) => records).filter(
    ({ sourceId, entityType }) => sourceId === SOURCE_ID && entityType === "facility",
  );
  for (const field of ACCESSIBILITY_FIELDS) {
    const fieldRecords = facilityRecords.filter((record) => record.field === field);
    assert.ok(fieldRecords.length > 0, `provenance missing field: ${field}`);
    assert.deepEqual(
      [...new Set(fieldRecords.flatMap(({ coverageScope }) => coverageScope?.lineIds ?? []))],
      [LINE_ID],
    );
    assert.ok(fieldRecords.every((record) => (
      record.sourceSnapshotId === "gwangju-transportation-accessibility-20260724"
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
    ({ operatorId, sourceDomain }) => operatorId === OPERATOR_ID
      && sourceDomain === "accessibility_facilities",
  );
  assert.equal(accessibilityRequirements.length, 1);
  assert.equal(accessibilityRequirements[0].status, "MISSING");
  assert.deepEqual(accessibilityRequirements[0].missingFields, ["wheelchair_lift"]);
  assert.deepEqual(
    accessibilityRequirements.map(({ lineId }) => lineId),
    [LINE_ID],
  );
  assert.equal(report.summary.launchRequired.completionReady, false);
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
