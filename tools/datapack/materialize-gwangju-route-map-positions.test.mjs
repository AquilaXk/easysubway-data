import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { collectGwangjuRouteMapPositions } from "./collect-gwangju-route-map-positions.mjs";
import { promisify } from "node:util";
import {
  loadRegionalGwangjuAccessibilityPrefix,
  materializeRegionalProductionCandidate,
  projectHistoricalRegionalMaterializeInventory,
  projectRegionalFixtureSourceBindings,
  projectRegionalMaterializeFixture,
} from "./materialize-test-fixture.mjs";

import {
  materializeGwangjuRouteMapPositions,
  materializedGwangjuRouteMapPackContentHash,
} from "./materialize-gwangju-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const topologyNow = new Date("2026-07-19T18:14:03.004Z");
const timetableNow = new Date("2026-07-20T13:09:00.000Z");
const accessibilityNow = new Date("2026-07-24T03:00:00.000Z");
const routeMapNow = new Date("2026-07-25T02:00:00.000Z");
const execFileAsync = promisify(execFile);
const SOURCE_ID = "gwangju-transportation-route-map-positions";
const LINE_ID = "line-e57a361e8892";
const OPERATOR_ID = "gwangju-metropolitan-rapid-transit";

test("materialize a changed topology roster and snapshot identity without production pins", () => {
  const topologyId = "gwangju-topology-successor";
  const scope = [
    { providerStationId: "3", stationCode: "105", stationName: "가" },
    { providerStationId: "9", stationCode: "109", stationName: "나" },
  ];
  const topologySnapshot = { sourceId: "gwangju-transportation-route-topology", stationCount: scope.length, scope, edges: [] };
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  topologySnapshot.contentSha256 = digest(JSON.stringify({ scope, edges: [] }));
  const csvBytes = Buffer.from("역번호,역사명,노선번호,노선명,역위도,역경도,데이터기준일자\n105,가,S2901,1호선,35.11,126.81,2022-12-02\n109,나,S2901,1호선,35.12,126.82,2022-12-02\n");
  const schematicCanvas = scope.map((row, index) => ({ stationName: row.stationName,
    canvasSourceId: "owner-self-drawn-sma-schematic", x: 400 + index * 100, y: 400, labelDx: 0, labelDy: 0,
    labelPolygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }));
  const now = new Date("2025-01-01T00:00:00.000Z");
  const snapshot = collectGwangjuRouteMapPositions({ csvBytes, topologySnapshot, topologySnapshotId: topologyId, schematicCanvas, now });
  const snapshotSha256 = digest(JSON.stringify(snapshot));
  const evidence = { ...snapshot, issue: 2494, admissionKind: "official-file-latlon",
    materializer: "tools/datapack/materialize-gwangju-route-map-positions.mjs",
    verificationTest: "tools/datapack/materialize-gwangju-route-map-positions.test.mjs",
    snapshotId: "gwangju-map-successor", snapshotPath: "tools/datapack/sources/gwangju-map-successor.json",
    snapshotSha256, freshUntil: "2026-01-01T00:00:00.000Z" };
  const inventory = { sources: [
    { id: topologySnapshot.sourceId, topologyAdmissionEvidence: { snapshotId: topologyId, contentSha256: topologySnapshot.contentSha256 } },
    { id: SOURCE_ID, productionUseAllowed: true, fieldsProvided: snapshot.fieldsProvided,
      license: { type: "PUBLIC_DATA_FREE_USE", redistributionAllowed: true, commercialUseAllowed: true, derivativeWorkAllowed: true, name: "test license" },
      coverageScope: { regionIds: ["gwangju"], operatorIds: [OPERATOR_ID], lineIds: [LINE_ID], sourceDomains: ["route_map_positions"] },
      routeMapAdmissionEvidence: evidence },
  ] };
  const baseFixture = { manifest: {}, packs: [{ id: "base", artifactKind: "production",
    operators: [{ id: OPERATOR_ID }], sourceInventory: [{ id: topologySnapshot.sourceId }],
    stationLines: scope.map((row, index) => ({ stationId: `station-${index}`, stationCode: row.stationCode,
      lineId: LINE_ID, lineSequence: index + 1, fieldProvenance: { station_code: { sourceId: topologySnapshot.sourceId } } })) }] };
  const result = materializeGwangjuRouteMapPositions({ baseFixture, snapshot, snapshotSha256, topologySnapshot, inventory, now });
  assert.deepEqual(result.packs[0].routeMapPositions.map(({ stationId, sourceSnapshotId }) => ({ stationId, sourceSnapshotId })),
    scope.map((_, index) => ({ stationId: `station-${index}`, sourceSnapshotId: evidence.snapshotId })));
  inventory.sources[0].topologyAdmissionEvidence.snapshotId = "different-topology";
  assert.throws(() => materializeGwangjuRouteMapPositions({ baseFixture, snapshot, snapshotSha256, topologySnapshot, inventory, now }), /does not match|lineage mismatch/);
});

async function inputs() {
  const [
    regional,
    gwangjuSnapshotBytes,
  ] = await Promise.all([
    loadRegionalGwangjuAccessibilityPrefix({
      baseFixturePromise: readJson("tools/datapack/release/capital-production-reviewed-pack.json").then(projectRegionalMaterializeFixture),
      inventoryPromise: readJson("tools/datapack/source-inventory.json").then(projectHistoricalRegionalMaterializeInventory),
      readJson,
      topologyNow,
      timetableNow,
      gwangjuAccessibilityNow: accessibilityNow,
    }),
    readFile(path.join(root, "tools/datapack/sources/gwangju-transportation-route-map-positions-20260725.json")),
  ]);
  const { accessibilityFixture, gwangjuTopology } = regional;
  const gwangjuSnapshot = JSON.parse(gwangjuSnapshotBytes);
  const inventory = projectRegionalFixtureSourceBindings({
    inventory: regional.inventory, gwangjuTopology,
    molitStationMapCsv: regional.molitStationMapCsv,
    gwangjuRouteMapSnapshot: gwangjuSnapshot,
    gwangjuRouteMapSnapshotBytes: gwangjuSnapshotBytes,
  });
  return {
    baseFixture: accessibilityFixture,
    gwangjuSnapshot,
    gwangjuSnapshotSha256: createHash("sha256").update(gwangjuSnapshotBytes).digest("hex"),
    topologySnapshot: gwangjuTopology,
    inventory,
  };
}

test("공식 광주 문화노선도 위경도 snapshot을 누적 production candidate pack에 materialize한다", async () => {
  const { baseFixture, gwangjuSnapshot, gwangjuSnapshotSha256, topologySnapshot, inventory } = await inputs();
  baseFixture.packs[0].sourceInventory = baseFixture.packs[0].sourceInventory
    .filter(({ id }) => id !== "kric-nationwide-timetable-file");
  const missingTopology = structuredClone(baseFixture);
  missingTopology.packs[0].sourceInventory = missingTopology.packs[0].sourceInventory
    .filter(({ id }) => id !== "gwangju-transportation-route-topology");
  assert.throws(() => materializeGwangjuRouteMapPositions({
    baseFixture: missingTopology, snapshot: gwangjuSnapshot, snapshotSha256: gwangjuSnapshotSha256,
    topologySnapshot, inventory, now: routeMapNow,
  }), /require gwangju topology source/);
  const fixture = materializeGwangjuRouteMapPositions({
    baseFixture,
    snapshot: gwangjuSnapshot,
    snapshotSha256: gwangjuSnapshotSha256,
    topologySnapshot,
    inventory,
    now: routeMapNow,
  });
  const pack = fixture.packs[0];
  const rows = pack.routeMapPositions.filter(({ sourceId }) => sourceId === SOURCE_ID);
  const source = pack.sourceInventory.find(({ id }) => id === SOURCE_ID);

  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map(({ lineId }) => lineId)).size, 1);
  assert.deepEqual([...new Set(rows.map(({ lineId }) => lineId))], [LINE_ID]);
  assert.ok(rows.every(({ labelPolygon, region }) => labelPolygon.length === 4 && region === "광주권"));
  // schematic canvas 범위(하이브리드 basemap). 위경도 투영(~10^4)이면 실패해야 한다.
  assert.ok(rows.every(({ x, y }) => (
    Number.isInteger(x) && Number.isInteger(y)
    && x >= 272 && x <= 1882 && y >= 284 && y <= 1667
    && x < 5000 && y < 5000
  )));
  assert.ok(gwangjuSnapshot.positions.every(({ latitude, longitude, x, y }) => (
    Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude > 35 && longitude > 126
    && Number.isInteger(x) && Number.isInteger(y)
  )));
  assert.equal(gwangjuSnapshot.schematicCanvasSourceId, "owner-self-drawn-sma-schematic");
  assert.deepEqual(source.coverageScope.lineIds, [LINE_ID]);
  assert.equal(pack.minimumTableRows.route_map_positions, pack.routeMapPositions.length);
  assert.match(pack.id, /^nationwide-gwangju-route-map-[a-f0-9]{64}$/);
  assert.match(materializedGwangjuRouteMapPackContentHash(pack, pack.version), /^[a-f0-9]{64}$/);
  assert.equal(pack.version, "20260725");
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260725" });

  const mismatchedInventory = structuredClone(inventory);
  mismatchedInventory.sources.find(({ id }) => id === SOURCE_ID)
    .routeMapAdmissionEvidence.positionsSha256 = "0".repeat(64);
  assert.throws(
    () => materializeGwangjuRouteMapPositions({
      baseFixture, snapshot: gwangjuSnapshot, snapshotSha256: gwangjuSnapshotSha256,
      topologySnapshot, inventory: mismatchedInventory, now: routeMapNow,
    }),
    /inventory evidence/,
  );
  const byteDifferentSnapshotSha256 = createHash("sha256")
    .update(`${JSON.stringify(gwangjuSnapshot, null, 2)}\n`)
    .digest("hex");
  assert.notEqual(byteDifferentSnapshotSha256, gwangjuSnapshotSha256);
  assert.throws(
    () => materializeGwangjuRouteMapPositions({
      baseFixture, snapshot: gwangjuSnapshot, snapshotSha256: byteDifferentSnapshotSha256,
      topologySnapshot, inventory, now: routeMapNow,
    }),
    /snapshot byte identity/,
  );
});

test("materialized SQLite와 provenance가 광주 1호선 route_map_positions를 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-gwangju-route-map-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { baseFixture, gwangjuSnapshot, gwangjuSnapshotSha256, topologySnapshot, inventory } = await inputs();
  const fixture = materializeGwangjuRouteMapPositions({
    baseFixture,
    snapshot: gwangjuSnapshot,
    snapshotSha256: gwangjuSnapshotSha256,
    topologySnapshot,
    inventory,
    now: routeMapNow,
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
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM route_map_positions WHERE source_id = ?")
    .get(SOURCE_ID).count, 20);
  assert.equal(database.prepare(
    "SELECT COUNT(DISTINCT line_id) AS count FROM route_map_positions WHERE source_id = ?",
  ).get(SOURCE_ID).count, 1);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  for (const field of ["route_map_position", "route_map_label_polygon"]) {
    const fieldRecords = provenance.packs.flatMap(({ records }) => records).filter(
      ({ sourceId, field: recordField }) => sourceId === SOURCE_ID && recordField === field,
    );
    assert.ok(fieldRecords.length > 0, `provenance missing field: ${field}`);
    assert.deepEqual(
      [...new Set(fieldRecords.flatMap(({ coverageScope }) => coverageScope?.lineIds ?? []))],
      [LINE_ID],
    );
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
  const routeMapRequirements = report.requirements.filter(
    ({ operatorId, sourceDomain }) => operatorId === OPERATOR_ID && sourceDomain === "route_map_positions",
  );
  assert.equal(routeMapRequirements.length, 1);
  assert.ok(routeMapRequirements.every(({ status }) => status === "SUPPORTED"));
  assert.deepEqual(routeMapRequirements.map(({ lineId }) => lineId), [LINE_ID]);
  assert.equal(report.summary.launchRequired.completionReady, false);
});

test("광주 route_map_positions materialize는 metro_map_pack·capital.sqlite.gz를 건드리지 않는다", async () => {
  const { stdout } = await execFileAsync("git", [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    "apps/mobile/assets/datapacks/metro_map_pack",
    "apps/mobile/assets/datapacks/capital.sqlite.gz",
  ], { cwd: root });
  assert.equal(stdout.trim(), "");
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
