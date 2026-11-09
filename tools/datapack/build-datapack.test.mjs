import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";
import { sha256 } from "../lib/hash.mjs";
import {
  productionEnv,
  buildCurrentProductionArtifact,
  representativeRouteRegressionPayload,
} from "./test-fixtures/datapack-tools-production-build.mjs";
import {
  TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
  sourceIngestInput,
  productionSourceIngestInput,
  importTestOnlyAccessibilityFixture,
  capitalPilotProductionSourceInput,
} from "./test-fixtures/datapack-tools-source-ingest.mjs";
import {
  makeProductionSourceFixtureStrictCoverageValid,
  addApprovedMovementPathwayEvidence,
} from "./test-fixtures/datapack-tools-production-pack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
stageLocalMobileFixture({ repositoryRoot: root });

const CATALOG_FIXTURE_PATH = "tools/datapack/fixtures/catalog-fixture.json";
const writeJson = (filePath, value) => writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
const readCatalogFixture = () => readJson(path.join(root, CATALOG_FIXTURE_PATH));

const runBuildDatapack = (fixturePath, outputDir, { env = productionEnv, extraArgs = [] } = {}) =>
  execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, ...extraArgs, "--output", outputDir],
    { cwd: root, env },
  );

const runValidateDatapack = (
  outputDir,
  { manifestPath = path.join(outputDir, "current.json"), env = productionEnv, extraArgs = [] } = {},
) =>
  execFileAsync(
    process.execPath,
    ["tools/datapack/validate-datapack.mjs", "--manifest", manifestPath, "--root", outputDir, ...extraArgs],
    { cwd: root, env },
  );

async function withSqlite(sqlitePath, fn, options = { readOnly: true }) {
  const database = new DatabaseSync(sqlitePath, options);
  try {
    return await fn(database);
  } finally {
    database.close();
  }
}

async function withBuildWorkspace(fn) {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-"));
  const fixturePath = path.join(outputDir, "fixture.json");
  const manifestPath = path.join(outputDir, "current.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const sqlitePath = path.join(outputDir, "catalog", "capital-v1.sqlite");
  const build = (options = {}) => runBuildDatapack(options.fixture ?? fixturePath, options.output ?? outputDir, options);
  const validate = (options = {}) => runValidateDatapack(options.root ?? outputDir, options);
  const buildAndValidate = async (options = {}) => {
    await build(options);
    await validate(options);
  };
  const readManifest = (dir = outputDir) => readJson(path.join(dir, "current.json"));
  const readProvenance = (dir = outputDir) => readJson(path.join(dir, "current.provenance.json"));
  const withDb = (cb, file = sqlitePath, options) => withSqlite(file, cb, options);
  try {
    return await fn({
      outputDir,
      fixturePath,
      manifestPath,
      provenancePath,
      sqlitePath,
      build,
      validate,
      buildAndValidate,
      readManifest,
      readProvenance,
      withDb,
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

async function withMutatedCatalogFixture(mutate, fn, { production = false } = {}) {
  return withBuildWorkspace(async (ws) => {
    const fixture = await readCatalogFixture();
    if (production) {
      markFixturePackProduction(fixture);
    }
    await mutate(fixture, ws);
    await writeJson(ws.fixturePath, fixture);
    return fn({ ...ws, fixture });
  });
}

async function buildDefaultAndMutateManifest(mutate, fn) {
  return withBuildWorkspace(async (ws) => {
    await ws.build({ fixture: CATALOG_FIXTURE_PATH });
    const manifest = await ws.readManifest();
    await mutate(manifest, ws);
    await writeJson(ws.manifestPath, manifest);
    return fn({ ...ws, manifest });
  });
}

async function buildAndTamperCatalogSqlite(mutateDb, fn) {
  return withBuildWorkspace(async (ws) => {
    await ws.build({ fixture: CATALOG_FIXTURE_PATH });
    const manifest = await ws.readManifest();
    const pack = manifest.packs[0];
    await ws.withDb(mutateDb, ws.sqlitePath, {});
    const sqliteBytes = await readFile(ws.sqlitePath);
    const compressedBytes = gzipSync(sqliteBytes);
    await writeFile(path.join(ws.outputDir, "catalog", "capital-v1.sqlite.gz"), compressedBytes);
    pack.sizeBytes = compressedBytes.length;
    pack.sha256 = sha256(compressedBytes);
    pack.sqliteSha256 = sha256(sqliteBytes);
    const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
    pack.signature.value = sha256(Buffer.from(fixturePayload));
    pack.representativeRouteRegressionSignature.value = sha256(
      Buffer.from(`${fixturePayload}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`),
    );
    await writeFile(ws.manifestPath, JSON.stringify(manifest));
    return fn({ ...ws, manifest });
  });
}

function configureRealtimeV2Pack(fixture, lineMappings, stationMappings) {
  fixture.manifest.activePack.version = "2";
  const pack = fixture.packs[0];
  pack.version = "2";
  pack.schemaVersion = "2";
  pack.url = "catalog/capital-v2.sqlite.gz";
  pack.realtimeProviderLineMappings = lineMappings;
  if (stationMappings) {
    pack.realtimeProviderStationMappings = stationMappings;
  }
  return pack;
}

function addIsolatedStationNode(fixture) {
  fixture.packs[0].stations.push({
    id: "station-isolated",
    nameKo: "고립역",
    nameEn: "Isolated",
    normalizedName: "isolated",
    region: "capital",
    latitude: 37.1,
    longitude: 127.1,
    dataQualityLevel: "LEVEL_2",
    dataSourceType: "OFFICIAL_FILE",
    lastVerifiedAt: "2026-06-19T00:00:00.000Z",
  });
  fixture.packs[0].stationLines.push({
    stationId: "station-isolated",
    lineId: "seoul-4",
    stationCode: "499",
    lineSequence: 999,
    platformInfo: "테스트 고립 노드",
  });
  fixture.packs[0].minimumTableRows.stations = 3;
}

test(
  "데이터팩 생성기는 TEST_ONLY와 unadmitted assembly fixture를 직접 build input으로 거부한다",
  async () => {
    await withBuildWorkspace(async ({ fixturePath, build }) => {
      await assert.rejects(
        build({ fixture: "tools/datapack/fixtures/test-only-itx-cheongchun-admitted.json" }),
        /TEST_ONLY artifact cannot be used as datapack build input/,
      );

      const assemblyFixture = await readCatalogFixture();
      assemblyFixture.assemblyInputs = {};
      await writeJson(fixturePath, assemblyFixture);
      await assert.rejects(build(), /assembly inputs require --build-spec/);
    });
  },
);

test("route service evidence domain split은 legacy TEST_ONLY canonical tuple을 v19 writer 전에 거부한다", async () => {
  await withBuildWorkspace(async ({ outputDir, build }) => {
    const admissionPath = "tools/datapack/fixtures/test-only-itx-cheongchun-admitted.json";
    const beforeAdmissionBytes = await readFile(admissionPath);
    await assert.rejects(
      build({
        fixture: CATALOG_FIXTURE_PATH,
        extraArgs: ["--test-only-itx-admission", admissionPath],
      }),
      /test-only ITX legacy canonical pack identity is forbidden/,
    );
    assert.deepEqual(await readdir(outputDir), []);
    assert.deepEqual(await readFile(admissionPath), beforeAdmissionBytes);
  });
});

test("데이터팩 생성기는 fixture로 원격 manifest와 gzip SQLite pack을 만든다", async () => {
  await withBuildWorkspace(async ({ outputDir, build, validate, readManifest, readProvenance, withDb }) => {
    await build({ fixture: CATALOG_FIXTURE_PATH });

    const manifest = await readManifest();
    assert.equal(manifest.ttlSeconds, 3600);
    assert.deepEqual(manifest.activePack, { id: "capital", version: "1" });
    assert.equal(manifest.packs.length, 1);

    const pack = manifest.packs[0];
    assert.equal(pack.id, "capital");
    assert.equal(pack.version, "1");
    assert.equal(pack.artifactKind, "fixture");
    assert.equal(pack.url, "catalog/capital-v1.sqlite.gz");
    assert.equal(pack.sourceInventory.length, 4);
    assert.equal(pack.sourceInventory[0].id, "fixture-capital-catalog");
    assert.equal(pack.sourceInventory[0].licenseStatus, "fixture-only");
    assert.equal(pack.sourceInventory[0].updatedAt, "2026-06-19T00:00:00.000Z");
    const sourceIds = pack.sourceInventory.map((source) => source.id);
    assert.ok(sourceIds.includes("seoul-metro-transfer-distance-duration"));
    assert.ok(sourceIds.includes("seoul-metro-fast-exit-car-door"));
    assert.ok(sourceIds.includes("seoul-metro-official-od-fares"));
    const officialOdFareSource = pack.sourceInventory.find(
      (source) => source.id === "seoul-metro-official-od-fares",
    );
    assert.deepEqual(officialOdFareSource.coverageScope.sourceDomains, ["official_od_fares"]);
    assert.equal(pack.regionalQualityMetrics.stationCount, 6);
    assert.equal(pack.regionalQualityMetrics.facilityCoverageRatio, 0.3333);
    assert.equal(pack.regionalQualityMetrics.requiredFacilityEvidenceCoverageRatio, 0.1852);
    assert.equal(pack.regionalQualityMetrics.strictRouteEligibleFacilityRatio, 0);
    assert.equal(pack.regionalQualityMetrics.operationalKnownRatio, 1);
    assert.equal(pack.regionalQualityMetrics.freshnessValidRatio, 0);
    assert.equal(pack.regionalQualityMetrics.fieldVerifiedPathwayRatio, 0);

    const provenance = await readProvenance();
    assert.equal(provenance.artifactKind, "datapack-field-provenance");
    assert.match(provenance.manifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(provenance.packs[0].id, "capital");
    assert.equal(provenance.packs[0].version, "1");
    assert.equal(provenance.packs[0].sqliteSha256, pack.sqliteSha256);
    assert.ok(
      provenance.packs[0].records.some(
        (record) =>
          record.entityType === "network_edge" &&
          record.field === "network_edges" &&
          record.sourceId === "fixture-capital-catalog" &&
          record.derivationKind === "FIXTURE",
      ),
    );
    assert.equal(pack.regionalQualityMetrics.edgeCount, 20);
    assert.equal(pack.regionalQualityMetrics.unknownAccessibilityRatio, 0);
    assert.deepEqual(pack.regionalQualityMetrics.unknownEdgeRatioByProfile, {
      wheelchair: 0,
      stroller: 0,
      lowMobility: 0,
    });
    assert.deepEqual(
      pack.representativeRouteRegressions.map((route) => route.pattern).sort(),
      ["DIRECT", "EXPRESS_LOCAL", "LOOP_BRANCH", "MULTI_TRANSFER", "TRANSFER"],
    );
    assert.deepEqual(pack.requiredTables, [
      "catalog_metadata",
      "operators",
      "lines",
      "stations",
      "station_lines",
      "service_calendars",
      "service_calendar_dates",
      "transit_routes",
      "transit_trips",
      "transit_stop_times",
      "transit_frequencies",
      "fare_zones",
      "fare_rules",
      "fare_discounts",
      "station_fare_zones",
      "official_od_fare_quotes",
      "transfer_rules",
      "station_pathway_nodes",
      "station_pathway_edges",
      "out_of_station_transfer_links",
      "network_edges",
      "route_map_positions",
      "station_exits",
      "facilities",
      "data_quality_records",
      // #1701: 빠른하차 칸/문 힌트 테이블을 required-table 계약에 편입.
      "station_car_door_hints",
    ]);
    assert.equal(pack.minimumTableRows.stations, 6);
    assert.equal(pack.minimumTableRows.service_calendar_dates, 1);
    assert.equal(pack.minimumTableRows.transit_routes, 2);
    assert.equal(pack.minimumTableRows.transit_trips, 4);
    assert.equal(pack.minimumTableRows.transit_stop_times, 8);
    assert.equal(pack.minimumTableRows.transit_frequencies, 1);
    assert.equal(pack.minimumTableRows.fare_zones, 1);
    assert.equal(pack.minimumTableRows.fare_rules, 1);
    assert.equal(pack.minimumTableRows.fare_discounts, 3);
    assert.equal(pack.minimumTableRows.station_fare_zones, 9);
    // #1701: 사당(공식 62초 갱신) + 강남(신분당선 178초 baseline)으로 transfer_rules 2행.
    assert.equal(pack.minimumTableRows.transfer_rules, 2);
    assert.equal(pack.minimumTableRows.station_pathway_nodes, 6);
    assert.equal(pack.minimumTableRows.station_pathway_edges, 5);
    assert.equal(pack.minimumTableRows.out_of_station_transfer_links, 1);
    assert.equal(pack.minimumTableRows.route_map_positions, 9);
    assert.equal(pack.minimumTableRows.data_quality_records, 5);
    // #1701: 빠른하차 칸/문 힌트 admitted 35행을 최소 계약으로 고정한다.
    assert.equal(pack.minimumTableRows.station_car_door_hints, 35);
    assert.match(pack.sha256, /^[a-f0-9]{64}$/);
    assert.match(pack.sqliteSha256, /^[a-f0-9]{64}$/);

    const compressed = await readFile(path.join(outputDir, pack.url));
    const sqlite = gunzipSync(compressed);
    assert.equal(sha256(compressed), pack.sha256);
    assert.equal(sha256(sqlite), pack.sqliteSha256);
    assert.equal(pack.sizeBytes, compressed.length);
    assert.deepEqual(pack.signature, {
      algorithm: "sha256-pack-manifest-v1",
      value: sha256(Buffer.from(`${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`)),
    });
    assert.deepEqual(pack.representativeRouteRegressionSignature, {
      algorithm: "sha256-route-regression-v1",
      value: sha256(Buffer.from(packSignaturePayload(pack))),
    });

    await validate();

    await withDb((database) => {
      assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 19);
      assert.equal(database.prepare("SELECT value FROM catalog_metadata WHERE key = 'schemaVersion'").get().value, "1");
      assert.equal(database.prepare("SELECT updated_at FROM catalog_metadata WHERE key = 'schemaVersion'").get().updated_at, 1781827200);
      assert.equal(database.prepare("SELECT last_verified_at FROM stations WHERE id = 'station-sangnoksu'").get().last_verified_at, 1781827200);
      assert.equal(database.prepare("SELECT checked_at FROM data_quality_records WHERE id = 'quality-station-sangnoksu'").get().checked_at, 1781827200);
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
              SELECT latitude, longitude, has_elevator_connection, data_source_type, last_verified_at,
                     source_id, source_snapshot_id
              FROM station_exits
              WHERE id = 'exit-sangnoksu-1'
              `,
            )
            .get(),
        },
        {
          latitude: 37.3021,
          longitude: 126.8661,
          has_elevator_connection: 1,
          data_source_type: "OFFICIAL_FILE",
          last_verified_at: 1781827200,
          source_id: "fixture-capital-catalog",
          source_snapshot_id: "fixture-capital-catalog-20260619",
        },
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
                SELECT duration_seconds, distance_meters, source_id, source_snapshot_id, provenance_kind
                FROM station_pathway_edges
                WHERE id = ?
              `,
            )
            .get("path-edge-sadang-4-to-2-fast"),
        },
        {
          duration_seconds: 62,
          distance_meters: 74,
          source_id: "seoul-metro-transfer-distance-duration",
          source_snapshot_id: "seoul-metro-transfer-distance-duration-admission-20260713",
          provenance_kind: "OFFICIAL_SOURCE",
        },
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
                SELECT COUNT(*) AS count
                FROM station_car_door_hints
                WHERE provenance_kind = 'OFFICIAL'
                  AND source_id = ?
                  AND source_snapshot_id = ?
              `,
            )
            .get(
              "seoul-metro-fast-exit-car-door",
              "seoul-metro-fast-exit-car-door-admission-20260713",
            ),
        },
        { count: 35 },
      );
      assert.deepEqual(
        database
          .prepare(
            `
            SELECT id, name_ko, region, currency_code
            FROM fare_zones
            ORDER BY id
          `,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            id: "capital-integrated",
            name_ko: "수도권 통합요금",
            region: "수도권",
            currency_code: "KRW",
          },
        ],
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
              SELECT zone_id, base_card_fare, base_cash_fare, base_distance_meters,
                     additional_steps_json
              FROM fare_rules
              WHERE id = ?
            `,
            )
            .get("capital-integrated-standard"),
        },
        {
          zone_id: "capital-integrated",
          base_card_fare: 1550,
          base_cash_fare: 1650,
          base_distance_meters: 10000,
          additional_steps_json: '[{"distanceMeters":5000,"cardFare":100,"cashFare":100},{"distanceMeters":5000,"cardFare":100,"cashFare":100},{"distanceMeters":5000,"cardFare":100,"cashFare":100},{"distanceMeters":5000,"cardFare":100,"cashFare":100},{"distanceMeters":5000,"cardFare":100,"cashFare":100},{"distanceMeters":5000,"cardFare":100,"cashFare":100},{"distanceMeters":5000,"cardFare":100,"cashFare":100},{"distanceMeters":5000,"cardFare":100,"cashFare":100},{"distanceMeters":8000,"cardFare":100,"cashFare":100}]',
        },
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
              SELECT card_fare, cash_fare
              FROM fare_discounts
              WHERE id = ?
            `,
            )
            .get("capital-integrated-youth"),
        },
        { card_fare: 900, cash_fare: 1650 },
      );
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM station_fare_zones WHERE zone_id = ?")
          .get("capital-integrated").count,
        9,
      );
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM stations").get().count, 6);
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
                SELECT trip_id, departure_seconds
                FROM transit_stop_times
                WHERE station_id = ?
                  AND line_id = ?
                  AND departure_seconds >= ?
                ORDER BY departure_seconds
                LIMIT 1
              `,
            )
            .get("station-sangnoksu", "seoul-4", 8 * 3600 + 2 * 60),
        },
        {
          trip_id: "trip-seoul-4-local-0805",
          departure_seconds: 8 * 3600 + 5 * 60,
        },
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
                SELECT st.trip_id, st.departure_seconds
                FROM transit_stop_times st
                JOIN transit_trips t ON t.id = st.trip_id
                JOIN service_calendars c ON c.service_id = t.service_id
                LEFT JOIN service_calendar_dates d ON d.service_id = t.service_id AND d.date = ?
                WHERE st.station_id = ?
                  AND st.line_id = ?
                  AND st.departure_seconds >= ?
                  AND ? BETWEEN c.start_date AND c.end_date
                  AND (d.exception_type = 1 OR (d.exception_type IS NULL AND c.wednesday = 1))
                ORDER BY st.departure_seconds
                LIMIT 1
              `,
            )
            .get("20260701", "station-sangnoksu", "seoul-4", 8 * 3600 + 2 * 60, "20260701"),
        },
        {
          trip_id: "trip-seoul-4-local-0805",
          departure_seconds: 8 * 3600 + 5 * 60,
        },
      );
      assert.equal(
        database.prepare("SELECT service_pattern FROM transit_trips WHERE id = 'trip-seoul-4-express-0810'").get()
          .service_pattern,
        "EXPRESS",
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
                SELECT t.service_pattern, t.trip_headsign, t.direction_id,
                       group_concat(st.station_id, '>') AS stop_pattern
                FROM transit_trips t
                JOIN (
                  SELECT trip_id, station_id
                  FROM transit_stop_times
                  WHERE trip_id = ?
                  ORDER BY stop_sequence
                ) st ON st.trip_id = t.id
                WHERE t.id = ?
                GROUP BY t.id
              `,
            )
            .get("trip-seoul-4-express-0810", "trip-seoul-4-express-0810"),
        },
        {
          service_pattern: "EXPRESS",
          trip_headsign: "오이도",
          direction_id: "down",
          stop_pattern: "station-sangnoksu>station-sadang",
        },
      );
      assert.equal(
        database.prepare("SELECT MAX(departure_seconds) AS max_departure FROM transit_stop_times").get().max_departure,
        91020,
      );
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_frequencies").get().count, 1);
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
                SELECT duration_seconds, requires_elevator, accessibility_status
                FROM station_pathway_edges
                WHERE from_node_id = ? AND to_node_id = ?
              `,
            )
            .get("path-node-sangnoksu-entrance-1", "path-node-sangnoksu-platform-4"),
        },
        {
          duration_seconds: 180,
          requires_elevator: 1,
          accessibility_status: "AVAILABLE",
        },
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
                SELECT min_transfer_seconds, pathway_edge_id, strict_step_free_pathway_edge_id
                FROM transfer_rules
                WHERE from_station_id = ? AND from_line_id = ? AND to_station_id = ? AND to_line_id = ?
              `,
            )
            .get("station-sadang", "seoul-4", "station-sadang", "seoul-2"),
        },
        {
          min_transfer_seconds: 62,
          pathway_edge_id: "path-edge-sadang-4-to-2-fast",
          strict_step_free_pathway_edge_id: "path-edge-sadang-4-to-2-step-free",
        },
      );
      assert.equal(
        database
          .prepare(
            `
              SELECT MIN(duration_seconds) AS duration
              FROM station_pathway_edges
              WHERE from_node_id = ? AND to_node_id = ? AND includes_stairs = 0
            `,
          )
          .get("path-node-sadang-platform-4", "path-node-sadang-platform-2").duration,
        360,
      );
      assert.equal(
        database
          .prepare(
            `
              SELECT duration_seconds
              FROM station_pathway_edges
              WHERE from_node_id = ? AND to_node_id = ?
            `,
          )
          .get("path-node-sangnoksu-platform-4", "path-node-sangnoksu-exit-1").duration_seconds,
        170,
      );
      const routeMapPositions = database
        .prepare(`
          SELECT station_id, line_id, region, x, y, label_polygon, source_id, license_status,
                 commercial_use_allowed, attribution_required, reviewed_at
          FROM route_map_positions
          ORDER BY line_id, station_id
        `)
        .all()
        .map((row) => ({ ...row }));
      assert.equal(routeMapPositions.length, 9);
      assert.deepEqual(
        routeMapPositions.find((row) => row.station_id === "station-sangnoksu" && row.line_id === "seoul-4"),
        {
          station_id: "station-sangnoksu",
          line_id: "seoul-4",
          region: "수도권",
          x: 156,
          y: 250,
          label_polygon: '[{"x":166,"y":226},{"x":214,"y":226},{"x":214,"y":246},{"x":166,"y":246}]',
          source_id: "fixture-route-map-source-capital-review",
          license_status: "fixture-only",
          commercial_use_allowed: 0,
          attribution_required: 1,
          reviewed_at: 1781827200,
        },
      );
      const networkEdges = database
        .prepare(`
          SELECT id, from_node_id, to_node_id, duration_seconds, edge_type,
                 distance_meters, service_pattern, includes_stairs, stair_access_state,
                 accessibility_status, reliability_score, facility_id, last_verified_at
          FROM network_edges
          ORDER BY id
        `)
        .all()
        .map((row) => ({ ...row }));
      assert.equal(networkEdges.length, 20);
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
                SELECT id, from_station_id, from_line_id, to_station_id, to_line_id,
                       bidirectional, requires_fare_exit, requires_reentry
                FROM out_of_station_transfer_links
                WHERE id = ?
              `,
            )
            .get("out-transfer-sadang-gangnam"),
        },
        {
          id: "out-transfer-sadang-gangnam",
          from_station_id: "station-sadang",
          from_line_id: "seoul-2",
          to_station_id: "station-gangnam",
          to_line_id: "shinbundang",
          bidirectional: 0,
          requires_fare_exit: 1,
          requires_reentry: 1,
        },
      );
      assert.deepEqual(
        {
          ...networkEdges.find((row) => row.id === "out-transfer-sadang-gangnam"),
        },
        {
          id: "out-transfer-sadang-gangnam",
          from_node_id: "station-sadang:seoul-2",
          to_node_id: "station-gangnam:shinbundang",
          duration_seconds: 420,
          distance_meters: 520,
          edge_type: "OUT_OF_STATION_TRANSFER",
          service_pattern: "",
          includes_stairs: 0,
          stair_access_state: "STEP_FREE",
          accessibility_status: "AVAILABLE",
          reliability_score: 90,
          facility_id: null,
          last_verified_at: 1781827200,
        },
      );
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM network_edges WHERE from_node_id = ? AND to_node_id = ?")
          .get("station-gangnam:shinbundang", "station-sadang:seoul-2").count,
        0,
      );
      assert.deepEqual(
        networkEdges.find((row) => row.id === "edge-sangnoksu-sadang-seoul-4"),
        {
          id: "edge-sangnoksu-sadang-seoul-4",
          from_node_id: "station-sangnoksu:seoul-4",
          to_node_id: "station-sadang:seoul-4",
          duration_seconds: 420,
          distance_meters: 18600,
          edge_type: "RIDE",
          service_pattern: "LOCAL",
          includes_stairs: 0,
          stair_access_state: "STEP_FREE",
          accessibility_status: "AVAILABLE",
          reliability_score: 90,
          facility_id: null,
          last_verified_at: 1781827200,
        },
      );
      assert.deepEqual(
        networkEdges.find((row) => row.id === "edge-sangnoksu-sadang-seoul-4-express"),
        {
          id: "edge-sangnoksu-sadang-seoul-4-express",
          from_node_id: "station-sangnoksu:seoul-4",
          to_node_id: "station-sadang:seoul-4",
          duration_seconds: 360,
          distance_meters: 18600,
          edge_type: "RIDE",
          service_pattern: "EXPRESS",
          includes_stairs: 0,
          stair_access_state: "STEP_FREE",
          accessibility_status: "AVAILABLE",
          reliability_score: 90,
          facility_id: null,
          last_verified_at: 1781827200,
        },
      );
      assert.deepEqual(
        networkEdges.find((row) => row.id === "edge-sadang-line4-line2-transfer"),
        {
          id: "edge-sadang-line4-line2-transfer",
          from_node_id: "station-sadang:seoul-4",
          to_node_id: "station-sadang:seoul-2",
          duration_seconds: 62,
          distance_meters: 74,
          edge_type: "IN_STATION_TRANSFER",
          service_pattern: "LOCAL",
          includes_stairs: 0,
          stair_access_state: "STEP_FREE",
          accessibility_status: "AVAILABLE",
          reliability_score: 90,
          facility_id: null,
          last_verified_at: 1781827200,
        },
      );
      assert.deepEqual(
        networkEdges.find((row) => row.id === "edge-gangnam-line2-shinbundang-transfer"),
        {
          id: "edge-gangnam-line2-shinbundang-transfer",
          from_node_id: "station-gangnam:seoul-2",
          to_node_id: "station-gangnam:shinbundang",
          duration_seconds: 178,
          distance_meters: 110,
          edge_type: "IN_STATION_TRANSFER",
          service_pattern: "LOCAL",
          includes_stairs: 0,
          stair_access_state: "STEP_FREE",
          accessibility_status: "AVAILABLE",
          reliability_score: 90,
          facility_id: null,
          last_verified_at: 1781827200,
        },
      );
      assert.deepEqual(
        database
          .prepare(`
            SELECT id, edge_type, distance_meters, duration_seconds, includes_stairs,
                   requires_elevator, requires_escalator, slope_level, width_level,
                   accessibility_status, reliability_score, instruction
            FROM internal_route_edges
            ORDER BY id
          `)
          .all()
          .map((row) => ({ ...row })),
        [
          {
            id: "edge-sangnoksu-concourse-exit-1",
            edge_type: "ELEVATOR",
            distance_meters: 42,
            duration_seconds: 120,
            includes_stairs: 0,
            requires_elevator: 1,
            requires_escalator: 0,
            slope_level: 1,
            width_level: 3,
            accessibility_status: "AVAILABLE",
            reliability_score: 88,
            instruction: "엘리베이터를 이용해 1번 출구로 이동",
          },
        ],
      );
      assert.deepEqual(
        {
          ...database
            .prepare("SELECT status, operational_status FROM facilities WHERE id = ?")
            .get("facility-sangnoksu-elevator-1"),
        },
        {
          status: "NORMAL",
          operational_status: "AVAILABLE",
        },
      );
    });
  });
});

test("데이터팩 검증기는 공개 채널 user_version 상한을 넘는 pack을 거부한다", async () => {
  await withBuildWorkspace(async ({ build, validate }) => {
    await build({ fixture: CATALOG_FIXTURE_PATH });
    await assert.rejects(
      validate({ extraArgs: ["--max-public-catalog-user-version", "14"] }),
      /capital@1 catalog user_version 19 exceeds public compatibility maximum 14/,
    );
  });
});

test("데이터팩 검증기는 공개 채널 user_version 19 상한을 만족하는 pack을 승인한다", async () => {
  await withBuildWorkspace(async ({ build, validate }) => {
    await build({ fixture: CATALOG_FIXTURE_PATH });
    await validate({ extraArgs: ["--max-public-catalog-user-version", "19"] });
  });
});

test("데이터팩 생성기는 transit_feed_info feed_end_date를 적재하고 검증을 통과한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].transitFeedInfo = [{ feedEndDate: "20261231" }];
    },
    async ({ buildAndValidate, withDb }) => {
      await buildAndValidate();
      await withDb((database) => {
        assert.equal(database.prepare("PRAGMA user_version").get().user_version, 19);
        assert.equal(
          database.prepare("SELECT feed_end_date FROM transit_feed_info").get().feed_end_date,
          "20261231",
        );
      });
    },
  );
});

test("데이터팩 생성기는 foreign-key insert 실패를 table과 row identity로 진단한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].stationAliases[0].stationId = "missing-station";
    },
    async ({ build }) => {
      await assert.rejects(
        build(),
        /SQLite foreign-key insert failed: station_aliases row_sha256=[0-9a-f]{64}: FOREIGN KEY constraint failed/,
      );
    },
  );
});

test("데이터팩 검증기는 fare zone이 일부 station-line에만 매핑되면 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].stationFareZones = fixture.packs[0].stationFareZones.filter(
        (row) => row.stationId !== "station-sangnoksu",
      );
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /fare zone mapping missing: station-sangnoksu\/seoul-4/);
    },
  );
});

test("데이터팩 생성기는 transit_feed_info가 2개 이상이면 단일 행 제약으로 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].transitFeedInfo = [{ feedEndDate: "20261231" }, { feedEndDate: "20270101" }];
    },
    async ({ build }) => {
      await assert.rejects(build(), /transit_feed_info/);
    },
  );
});

test("데이터팩 검증기는 trip별 stop_time 시간이 역행하면 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const row = fixture.packs[0].transitStopTimes.find(
        (stopTime) =>
          stopTime.tripId === "trip-seoul-4-local-0805" &&
          stopTime.stationId === "station-sadang",
      );
      row.arrivalSeconds = 8 * 3600 + 3 * 60;
      row.departureSeconds = 8 * 3600 + 3 * 60;
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /transit_stop_times must be monotonic/);
    },
  );
});

test("데이터팩 검증기는 strict step-free transfer가 계단 pathway를 가리키면 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].transferRules[0].strictStepFreePathwayEdgeId = "path-edge-sadang-4-to-2-fast";
      delete fixture.packs[0].stationPathwayEdges.find(
        (edge) => edge.id === "path-edge-sadang-4-to-2-fast",
      ).includesStairs;
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /transfer_rules strict step-free edge is not step-free/);
    },
  );
});

test("데이터팩 검증기는 transfer rule pathway endpoint mismatch를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].transferRules[0].pathwayEdgeId = "path-edge-sangnoksu-entry-platform-elevator";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /transfer_rules pathway edge does not match endpoints/);
    },
  );
});

test("데이터팩 검증기는 unavailable strict step-free pathway를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].stationPathwayEdges.find(
        (edge) => edge.id === "path-edge-sadang-4-to-2-step-free",
      ).accessibilityStatus = "UNAVAILABLE";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /transfer_rules strict step-free edge is unavailable/);
    },
  );
});

test("데이터팩 검증기는 UNKNOWN 시설을 요구하는 AVAILABLE pathway를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const facility = fixture.packs[0].facilities.find(
        (row) => row.id === "facility-sadang-transfer-elevator-1",
      );
      facility.status = "UNKNOWN";
      facility.operationalStatus = "UNKNOWN";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /station_pathway_edges unavailable facility cannot be AVAILABLE/);
    },
  );
});

test("데이터팩 검증기는 escalator 요구 strict step-free pathway를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const strictPathwayEdge = fixture.packs[0].stationPathwayEdges.find(
        (edge) => edge.id === "path-edge-sadang-4-to-2-step-free",
      );
      strictPathwayEdge.edgeType = "WALK";
      strictPathwayEdge.requiresEscalator = true;
      strictPathwayEdge.requiresElevator = true;
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /transfer_rules strict step-free edge is not step-free/);
    },
  );
});

test("데이터팩 검증기는 legacy internal route mapping mismatch를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].stationPathwayEdges.find(
        (edge) => edge.id === "path-edge-sangnoksu-concourse-exit-1",
      ).accessibilityStatus = "LIMITED";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /station_pathway_edges legacy mapping mismatch/);
    },
  );
});

test("데이터팩 검증기는 missing legacy internal route mapping을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].stationPathwayEdges.find(
        (edge) => edge.id === "path-edge-sangnoksu-concourse-exit-1",
      ).legacyInternalRouteEdgeId = "missing-legacy-edge";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /station_pathway_edges legacy mapping is missing/);
    },
  );
});

test("데이터팩 검증기는 calendar date 추가 운행만 있는 trip도 active로 인정한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const calendar = fixture.packs[0].serviceCalendars[0];
      calendar.monday = false;
      calendar.tuesday = false;
      calendar.wednesday = false;
      calendar.thursday = false;
      calendar.friday = false;
      calendar.saturday = false;
      calendar.sunday = false;
    },
    async ({ buildAndValidate }) => {
      await buildAndValidate();
    },
  );
});

test("데이터팩 생성기는 일반 fixture 입력으로 production channel을 만들지 않는다", async () => {
  await withBuildWorkspace(async ({ outputDir, fixturePath, build, validate, readManifest, readProvenance }) => {
    const fixture = await readJson(path.join(root, "tools/datapack/release/capital-production-reviewed-pack.json"));
    makeProductionSourceFixtureExplicitlyUnavailable(fixture);
    for (const pack of fixture.packs) delete pack.routeServiceArtifactEvidence;
    await writeJson(fixturePath, fixture);

    await assert.rejects(
      build({
        output: path.join(outputDir, "output"),
        env: {
          ...productionEnv,
          EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY: "false",
        },
      }),
      /production fixture builds are validation-only/,
    );
    const validationOutput = path.join(outputDir, "validation-output");
    await build({
      output: validationOutput,
      env: {
        ...productionEnv,
        EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY: "true",
      },
    });
    const manifest = await readManifest(validationOutput);
    assert.equal(manifest.channel, "dev");
    assert.deepEqual(manifest.packs.map(({ artifactKind }) => artifactKind), ["fixture"]);
    const provenance = await readProvenance(validationOutput);
    assert.deepEqual(provenance.packs.map(({ artifactKind }) => artifactKind), ["fixture"]);
    await assert.rejects(
      validate({
        root: validationOutput,
        manifestPath: path.join(validationOutput, "current.json"),
        extraArgs: ["--require-production"],
      }),
      /production artifactKind/,
    );
    const fixturePack = await readCatalogFixture();
    fixturePack.manifest = {
      ...fixturePack.manifest,
      manifestVersion: 2,
      channel: " production ",
      keyId: "production-v1",
    };
    const fixturePackPath = path.join(outputDir, "fixture-pack.json");
    const fixturePackOutput = path.join(outputDir, "fixture-pack-output");
    await writeJson(fixturePackPath, fixturePack);
    await build({
      fixture: fixturePackPath,
      output: fixturePackOutput,
      env: {
        ...productionEnv,
        EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY: "false",
      },
    });
    const fixturePackManifest = await readManifest(fixturePackOutput);
    assert.equal(fixturePackManifest.channel, "dev");

    fixture.manifest.channel = "candidate";
    const candidateOutput = path.join(outputDir, "candidate-output");
    await writeJson(fixturePath, fixture);
    await build({ output: candidateOutput });
    const candidateManifest = await readManifest(candidateOutput);
    assert.equal(candidateManifest.channel, "candidate");
  });
});

test("데이터팩 검증기는 원격 publish 전 fixture pack을 거부한다", async () => {
  await withBuildWorkspace(async ({ build, validate }) => {
    await build({ fixture: CATALOG_FIXTURE_PATH });
    await assert.rejects(
      validate({ extraArgs: ["--require-production"] }),
      /capital@1 remote publish requires production artifactKind/,
    );
  });
});

test("데이터팩 생성기는 route map label polygon 좌표 계약을 검증한다", async () => {
  const cases = [
    [
      [{ x: 1, y: 1 }, { x: 2, y: 2 }],
      /routeMapPositions\.labelPolygon must be a polygon with at least three points/,
    ],
    [
      [{ x: 1, y: 1 }, { x: -2, y: 2 }, { x: 3, y: 3 }],
      /routeMapPositions\.labelPolygon\[1\]\.x must be a non-negative number/,
    ],
    [
      [{ x: 1, y: 1 }, { x: 2, y: "2" }, { x: 3, y: 3 }],
      /routeMapPositions\.labelPolygon\[1\]\.y must be a finite number/,
    ],
  ];

  for (const [labelPolygon, expected] of cases) {
    await withMutatedCatalogFixture(
      (fixture) => {
        fixture.packs[0].routeMapPositions[0].labelPolygon = labelPolygon;
      },
      async ({ build }) => {
        await assert.rejects(build(), expected);
      },
    );
  }
});

test("데이터팩 생성기는 route map 소수 좌표를 보존한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].routeMapPositions[0].x = 1492.231;
      fixture.packs[0].routeMapPositions[0].y = 753.307;
    },
    async ({ build, withDb }) => {
      await build();
      await withDb((database) => {
        assert.deepEqual({ ...database.prepare("SELECT x, y FROM route_map_positions ORDER BY rowid LIMIT 1").get() }, {
          x: 1492.231,
          y: 753.307,
        });
      });
    },
  );
});

test("데이터팩 생성기와 검증기는 v2 manifest envelope signature를 검증한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.manifest = {
        ...fixture.manifest,
        manifestVersion: 2,
        channel: "production",
        releaseSequence: 7,
        publishedAt: "2026-06-25T00:00:00.000Z",
        expiresAt: "2026-06-26T00:00:00.000Z",
        keyId: "fixture-key",
      };
      delete fixture.manifest.activePack;
    },
    async ({ manifestPath, build, validate, readManifest }) => {
      await build();
      const manifest = await readManifest();
      assert.equal(manifest.manifestVersion, 2);
      assert.equal(manifest.releaseSequence, 7);
      assert.equal("activePack" in manifest, false);
      assert.equal(manifest.signature.algorithm, "sha256-manifest-v2");
      assert.equal(manifest.packs[0].signature.algorithm, "sha256-pack-manifest-v2");

      await validate();

      manifest.ttlSeconds = 7200;
      await writeJson(manifestPath, manifest);
      await assert.rejects(validate(), /manifest signature mismatch/);
    },
  );
});

test("데이터팩 생성기는 잘못된 manifestVersion fixture를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.manifest = { ...fixture.manifest, manifestVersion: "2" };
    },
    async ({ build }) => {
      await assert.rejects(build(), /manifest\.manifestVersion must be 1 or 2/);
    },
  );
});

test("데이터팩 검증기는 v2 manifest channel pattern을 앱 parser와 동일하게 강제한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.manifest = {
        ...fixture.manifest,
        manifestVersion: 2,
        channel: "prod/eu",
        releaseSequence: 8,
        publishedAt: "2026-06-25T00:00:00.000Z",
        expiresAt: "2026-06-26T00:00:00.000Z",
        keyId: "fixture-key",
      };
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /manifest.channel must match/);
    },
  );
});

test("데이터팩 도구는 v2 manifest timestamp timezone 계약을 앱 parser와 동일하게 강제한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.manifest = {
        ...fixture.manifest,
        manifestVersion: 2,
        channel: "production",
        releaseSequence: 9,
        publishedAt: "2026-06-25T00:00:00",
        expiresAt: "2026-06-26T00:00:00.000Z",
        keyId: "fixture-key",
      };
    },
    async ({ fixture, fixturePath, manifestPath, build, validate, readManifest }) => {
      await assert.rejects(build(), /manifest.publishedAt must include timezone offset/);

      fixture.manifest.publishedAt = "2026-06-25T00:00:00.000Z";
      await writeJson(fixturePath, fixture);
      await build();

      const manifest = await readManifest();
      manifest.publishedAt = "2026-06-25T00:00:00";
      await writeJson(manifestPath, manifest);
      await assert.rejects(validate(), /manifest.publishedAt must include timezone offset/);
    },
  );
});

test("데이터팩 생성기는 schema v2 실시간 provider mapping을 SQLite에 보존한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const pack = configureRealtimeV2Pack(
        fixture,
        [
          {
            providerId: "seoul-topis",
            providerLineId: "1004",
            lineId: "seoul-4",
            sourceId: "seoul-topis-realtime-station-arrival",
            supportsArrivals: true,
            supportsTrainPositions: true,
            mappingConfidence: "OFFICIAL",
            updatedAt: "2026-06-23T00:00:00.000Z",
          },
        ],
        [
          {
            providerId: "seoul-topis",
            providerLineId: "1004",
            providerStationId: "1004000448",
            stationId: "station-sangnoksu",
            lineId: "seoul-4",
            sourceId: "seoul-topis-realtime-station-arrival",
            queryName: "상록수",
            supportsArrivals: true,
            supportsTrainPositions: true,
            mappingConfidence: "OFFICIAL",
            updatedAt: "2026-06-23T00:00:00.000Z",
          },
        ],
      );
      pack.requiredTables = [
        ...pack.requiredTables,
        "realtime_provider_line_mappings",
        "realtime_provider_station_mappings",
      ];
      pack.minimumTableRows = {
        ...pack.minimumTableRows,
        realtime_provider_line_mappings: 1,
        realtime_provider_station_mappings: 1,
      };
    },
    async ({ outputDir, buildAndValidate, withDb }) => {
      await buildAndValidate();
      await withDb((database) => {
        assert.equal(database.prepare("PRAGMA user_version").get().user_version, 19);
        assert.deepEqual(
          {
            ...database
              .prepare(
                `
                  SELECT provider_id, provider_line_id, line_id, supports_arrivals, supports_train_positions, mapping_confidence
                  FROM realtime_provider_line_mappings
                `,
              )
              .get(),
          },
          {
            provider_id: "seoul-topis",
            provider_line_id: "1004",
            line_id: "seoul-4",
            supports_arrivals: 1,
            supports_train_positions: 1,
            mapping_confidence: "OFFICIAL",
          },
        );
        assert.deepEqual(
          {
            ...database
              .prepare(
                `
                  SELECT provider_id, provider_line_id, provider_station_id, station_id, line_id, query_name
                  FROM realtime_provider_station_mappings
                `,
              )
              .get(),
          },
          {
            provider_id: "seoul-topis",
            provider_line_id: "1004",
            provider_station_id: "1004000448",
            station_id: "station-sangnoksu",
            line_id: "seoul-4",
            query_name: "상록수",
          },
        );
      }, path.join(outputDir, "catalog", "capital-v2.sqlite"));
    },
  );
});

test("데이터팩 생성기는 내부 station-line 없는 실시간 provider station mapping을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      configureRealtimeV2Pack(
        fixture,
        [
          {
            providerId: "seoul-topis",
            providerLineId: "1004",
            lineId: "seoul-4",
            sourceId: "seoul-topis-realtime-station-arrival",
          },
        ],
        [
          {
            providerId: "seoul-topis",
            providerLineId: "1004",
            providerStationId: "missing",
            stationId: "station-sangnoksu",
            lineId: "seoul-2",
            sourceId: "seoul-topis-realtime-station-arrival",
          },
        ],
      );
    },
    async ({ build }) => {
      await assert.rejects(build(), /FOREIGN KEY constraint failed/);
    },
  );
});

test("데이터팩 생성기는 provider line과 station mapping line 불일치를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      configureRealtimeV2Pack(
        fixture,
        [
          {
            providerId: "seoul-topis",
            providerLineId: "1004",
            lineId: "seoul-4",
            sourceId: "seoul-topis-realtime-station-arrival",
          },
        ],
        [
          {
            providerId: "seoul-topis",
            providerLineId: "1004",
            providerStationId: "2000222",
            stationId: "station-sadang",
            lineId: "seoul-2",
            sourceId: "seoul-topis-realtime-station-arrival",
          },
        ],
      );
    },
    async ({ build }) => {
      await assert.rejects(build(), /FOREIGN KEY constraint failed/);
    },
  );
});

test("데이터팩 생성기는 실시간 provider capability flag의 문자열 값을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      configureRealtimeV2Pack(fixture, [
        {
          providerId: "seoul-topis",
          providerLineId: "1004",
          lineId: "seoul-4",
          sourceId: "seoul-topis-realtime-station-arrival",
          supportsArrivals: "false",
        },
      ]);
    },
    async ({ build }) => {
      await assert.rejects(build(), /realtimeProviderLineMappings\.supportsArrivals must be a boolean/);
    },
  );
});

test("데이터팩 생성기는 대표 route regression 문자열을 앱 서명 기준으로 정규화한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].representativeRouteRegressions[0] = {
        ...fixture.packs[0].representativeRouteRegressions[0],
        id: " direct-local-sangnoksu-sadang ",
        pattern: " DIRECT ",
        fromNodeId: " station-sangnoksu:seoul-4 ",
        toNodeId: " station-sadang:seoul-4 ",
        requiredEdgeIds: [" edge-sangnoksu-sadang-seoul-4 "],
      };
    },
    async ({ build, validate, readManifest }) => {
      await build();
      const manifest = await readManifest();
      const route = manifest.packs[0].representativeRouteRegressions[0];
      assert.deepEqual(route, {
        id: "direct-local-sangnoksu-sadang",
        pattern: "DIRECT",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
      });
      assert.deepEqual(manifest.packs[0].representativeRouteRegressionSignature, {
        algorithm: "sha256-route-regression-v1",
        value: sha256(Buffer.from(packSignaturePayload(manifest.packs[0]))),
      });
      await validate();
    },
  );
});

test("데이터팩 생성기는 production pack의 source metadata와 HTTPS URL을 강제한다", async (context) => {
  await withMutatedCatalogFixture(
    () => {},
    async ({ fixture, fixturePath, build }) => {
      const assertBuildRejected = async (mutate, expected) => {
        mutate();
        await writeJson(fixturePath, fixture);
        await assert.rejects(build(), expected);
      };

      const invalidPackUrls = [
        ["catalog/capital-v1.sqlite.gz", /production pack url must be an absolute HTTPS URL/],
        ["https://cdn.easysubway.example/packs/capital-v1.sqlite.gz", /pack.url absolute HTTPS URL path must end with catalog\/capital-v1\.sqlite\.gz/],
        ["https://easysubway.local/easysubway-datapacks/catalog/capital-v1.sqlite.gz", /production pack url must not use a local placeholder host/],
        ["https://easysubway.local./easysubway-datapacks/catalog/capital-v1.sqlite.gz", /production pack url must not use a local placeholder host/],
        ["https://127.0.0.1/easysubway-datapacks/catalog/capital-v1.sqlite.gz", /production pack url must not use a local placeholder host/],
        ["https://100.64.0.1/easysubway-datapacks/catalog/capital-v1.sqlite.gz", /production pack url must not use a local placeholder host/],
        ["https://[2001:db8::1]/easysubway-datapacks/catalog/capital-v1.sqlite.gz", /production pack url must not use a local placeholder host/],
        ["https://[::127.0.0.1]/easysubway-datapacks/catalog/capital-v1.sqlite.gz", /production pack url must not use a local placeholder host/],
      ];
      for (const [url, expected] of invalidPackUrls) {
        await assertBuildRejected(() => {
          fixture.packs[0].url = url;
        }, expected);
      }

      fixture.packs[0].url = "https://cdn.easysubway.example/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
      await assertBuildRejected(() => {
        fixture.packs[0].sourceInventory[0].updatedAt = "";
      }, /sourceInventory.updatedAt must be a non-empty string/);

      fixture.packs[0].sourceInventory[0].updatedAt = "2026-06-19T00:00:00.000Z";
      const invalidSourceUrls = [
        ["https://", /production sourceInventory.url must be HTTPS/],
        ["https://easysubway.local/fixtures/catalog-fixture.json", /production sourceInventory.url must not use a local placeholder host/],
        ["https://foo.localhost./fixtures/catalog-fixture.json", /production sourceInventory.url must not use a local placeholder host/],
        ["https://10.0.0.5/fixtures/catalog-fixture.json", /production sourceInventory.url must not use a local placeholder host/],
        ["https://198.18.0.1/fixtures/catalog-fixture.json", /production sourceInventory.url must not use a local placeholder host/],
        ["https://[ff02::1]/fixtures/catalog-fixture.json", /production sourceInventory.url must not use a local placeholder host/],
        ["https://[::10.0.0.1]/fixtures/catalog-fixture.json", /production sourceInventory.url must not use a local placeholder host/],
      ];
      for (const [url, expected] of invalidSourceUrls) {
        await assertBuildRejected(() => {
          fixture.packs[0].sourceInventory[0].url = url;
        }, expected);
      }

      fixture.packs[0].sourceInventory[0].url = "https://example.invalid/capital/stations";
      await writeJson(fixturePath, fixture);

      await assert.rejects(
        buildCurrentProductionArtifact(context, {
          buildEnv: { EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: undefined },
        }),
        /EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM is required for production data pack signatures/,
      );
    },
    { production: true },
  );
});

test("데이터팩 생성기는 production sourceInventory coverageScope 누락을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      delete fixture.packs[0].sourceInventory[0].coverageScope;
    },
    async ({ build }) => {
      await assert.rejects(build(), /production sourceInventory.coverageScope must be an object/);
    },
    { production: true },
  );
});

test("데이터팩 생성기는 sourceInventory coverageScope.lineIds 형식을 검증한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].sourceInventory[0].coverageScope.lineIds = "seoul-4";
    },
    async ({ build }) => {
      await assert.rejects(
        build(),
        /production sourceInventory\.coverageScope\.lineIds must be a non-empty string array/,
      );
    },
    { production: true },
  );
});

test("데이터팩 생성기는 production sourceInventory 누락을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      delete fixture.packs[0].sourceInventory;
    },
    async ({ build }) => {
      await assert.rejects(build(), /pack.sourceInventory must be a non-empty array/);
    },
    { production: true },
  );
});

test("데이터팩 검증기는 현장·운영기관 확인 시설 AVAILABLE 근거를 허용한다", async () => {
  await withBuildWorkspace(async ({ outputDir, fixturePath, buildAndValidate }) => {
    const fixture = await importTestOnlyAccessibilityFixture(outputDir, productionSourceIngestInput());
    makeProductionSourceFixtureStrictCoverageValid(fixture);
    for (const [index, statusMeaning] of ["FIELD_SURVEY", "OPERATOR_CONFIRMED"].entries()) {
      fixture.packs[0].facilities[index].status = "NORMAL";
      fixture.packs[0].facilities[index].operationalStatus = "AVAILABLE";
      fixture.packs[0].facilities[index].statusMeaning = statusMeaning;
      fixture.packs[0].facilities[index].provenanceKind = statusMeaning;
    }
    await writeJson(fixturePath, fixture);
    const packOutputDir = path.join(outputDir, "pack");
    await buildAndValidate({
      output: packOutputDir,
      root: packOutputDir,
      manifestPath: path.join(packOutputDir, "current.json"),
    });
  });
});

test("데이터팩 생성기는 production pack의 최소 row 기준 누락을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      delete fixture.packs[0].minimumTableRows;
    },
    async ({ build }) => {
      await assert.rejects(
        build(),
        /production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence/,
      );
    },
    { production: true },
  );
});

test("데이터팩 생성기는 production pack의 0 row 기준을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].minimumTableRows = {
        stations: 0,
        station_lines: 0,
        network_edges: 0,
        facilities: 0,
        station_facility_evidence: 0,
      };
    },
    async ({ build }) => {
      await assert.rejects(
        build(),
        /production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence/,
      );
    },
    { production: true },
  );
});

test("데이터팩 도구는 relative pack URL의 경로 이탈을 거부한다", async () => {
  await withMutatedCatalogFixture(
    () => {},
    async ({ fixture, fixturePath, manifestPath, build, validate, readManifest }) => {
      for (const url of [
        "../capital-v1.sqlite.gz",
        "catalog/../catalog/capital-v1.sqlite.gz",
        "catalog/%2e%2e/capital-v1.sqlite.gz",
      ]) {
        fixture.packs[0].url = url;
        await writeJson(fixturePath, fixture);
        await assert.rejects(build(), /pack.url must be a safe relative path or absolute HTTPS URL/);
      }

      fixture.packs[0].url = "catalog/capital-v1.sqlite.gz";
      await writeJson(fixturePath, fixture);
      await build();

      const manifest = await readManifest();
      for (const url of [
        "//example.invalid/capital-v1.sqlite.gz",
        "catalog/../catalog/capital-v1.sqlite.gz",
        "catalog/%2e%2e/capital-v1.sqlite.gz",
      ]) {
        manifest.packs[0].url = url;
        await writeJson(manifestPath, manifest);
        await assert.rejects(validate(), /pack.url must be a safe relative path or absolute HTTPS URL/);
      }
    },
  );
});

test("데이터팩 도구는 sourceInventory boolean 계약을 검증한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].sourceInventory[0].redistributionAllowed = "false";
    },
    async ({ fixture, fixturePath, manifestPath, build, validate, readManifest }) => {
      await assert.rejects(build(), /sourceInventory.redistributionAllowed must be a boolean/);

      fixture.packs[0].sourceInventory[0].redistributionAllowed = false;
      await writeJson(fixturePath, fixture);
      await build();

      const manifest = await readManifest();
      manifest.packs[0].sourceInventory[0].redistributionAllowed = "false";
      await writeJson(manifestPath, manifest);
      await assert.rejects(validate(), /sourceInventory.redistributionAllowed must be a boolean/);
    },
  );
});

test("데이터팩 생성기는 시설 coverage를 시설이 있는 역 비율로 계산한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const secondStationFacility = {
        ...fixture.packs[0].facilities[0],
        id: "facility-sadang-elevator",
        stationId: "station-sadang",
        name: "사당역 엘리베이터",
      };
      delete secondStationFacility.exitId;
      fixture.packs[0].facilities.push(secondStationFacility);
      fixture.packs[0].minimumTableRows.facilities = 2;
    },
    async ({ build, validate, readManifest }) => {
      await build();
      const manifest = await readManifest();
      assert.equal(manifest.packs[0].regionalQualityMetrics.stationCount, 6);
      assert.equal(manifest.packs[0].regionalQualityMetrics.facilityCoverageRatio, 0.3333);
      assert.equal(manifest.packs[0].regionalQualityMetrics.freshnessValidRatio, 0);
      await validate();
    },
  );
});

test("데이터팩 생성기는 accessibilityStatus 대소문자를 정규화해 산출물을 검증 가능하게 만든다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges[0].accessibilityStatus = "unknown";
      fixture.packs[0].internalRouteEdges[0].accessibilityStatus = "unknown";
      fixture.packs[0].stationPathwayEdges.find(
        (edge) => edge.id === "path-edge-sangnoksu-concourse-exit-1",
      ).accessibilityStatus = "unknown";
    },
    async ({ build, validate, readManifest, withDb }) => {
      await build();
      const manifest = await readManifest();
      assert.equal(manifest.packs[0].regionalQualityMetrics.unknownAccessibilityRatio, 0.05);

      await withDb((database) => {
        const edge = database
          .prepare("SELECT accessibility_status FROM network_edges WHERE id = ?")
          .get("edge-sangnoksu-sadang-seoul-4");
        const internalEdge = database
          .prepare("SELECT accessibility_status FROM internal_route_edges WHERE id = ?")
          .get("edge-sangnoksu-concourse-exit-1");
        const pathwayEdge = database
          .prepare("SELECT accessibility_status FROM station_pathway_edges WHERE id = ?")
          .get("path-edge-sangnoksu-concourse-exit-1");
        assert.equal(edge.accessibility_status, "UNKNOWN");
        assert.equal(internalEdge.accessibility_status, "UNKNOWN");
        assert.equal(pathwayEdge.accessibility_status, "UNKNOWN");
      });

      await validate();
    },
  );
});

test("데이터팩 검증기는 manifest regional quality metrics와 SQLite 내용을 대조한다", async () => {
  await buildDefaultAndMutateManifest(
    (manifest) => {
      manifest.packs[0].regionalQualityMetrics.edgeCount = 1;
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /regionalQualityMetrics mismatch/);
    },
  );
});

test("데이터팩 생성기는 stairAccessState 누락 edge를 미확인 상태로 보존한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      delete fixture.packs[0].networkEdges[0].stairAccessState;
      fixture.packs[0].networkEdges[0].includesStairs = false;
    },
    async ({ build, withDb }) => {
      await build();
      await withDb((database) => {
        assert.equal(
          database
            .prepare("SELECT stair_access_state FROM network_edges WHERE id = ?")
            .get("edge-sangnoksu-sadang-seoul-4").stair_access_state,
          "UNKNOWN",
        );
      });
    },
  );
});

test("데이터팩 검증기는 존재하지 않는 facility edge 참조를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges[0].facilityId = "facility-does-not-exist";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /network_edges facility_id references missing facility/);
    },
  );
});

test("데이터팩 검증기는 존재하지 않는 station-line endpoint를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges[0].fromNodeId = "station-does-not-exist:seoul-4";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /network_edges endpoint references missing station-line/);
    },
  );
});

test("데이터팩 검증기는 route graph에서 고립된 station-line node를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      addIsolatedStationNode(fixture);
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /station-line node is isolated from route graph/);
    },
  );
});

test("데이터팩 검증기는 빈 route regression pack도 명시 route edge가 있으면 route graph를 검증한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].representativeRouteRegressions = [];
      addIsolatedStationNode(fixture);
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /station-line node is isolated from route graph/);
    },
  );
});

test("데이터팩 검증기는 분리된 route graph component를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].lines.push({
        id: "seoul-5",
        operatorId: "seoul-metro",
        nameKo: "5호선",
        nameEn: "Line 5",
        color: "#996CAC",
      });
      fixture.packs[0].stations.push(
        {
          id: "station-disconnected-a",
          nameKo: "분리A역",
          nameEn: "Disconnected A",
          normalizedName: "disconnected-a",
          region: "수도권",
          latitude: 37.2,
          longitude: 127.2,
          dataQualityLevel: "LEVEL_2",
          dataSourceType: "OFFICIAL_FILE",
          lastVerifiedAt: "2026-06-19T00:00:00.000Z",
        },
        {
          id: "station-disconnected-b",
          nameKo: "분리B역",
          nameEn: "Disconnected B",
          normalizedName: "disconnected-b",
          region: "수도권",
          latitude: 37.3,
          longitude: 127.3,
          dataQualityLevel: "LEVEL_2",
          dataSourceType: "OFFICIAL_FILE",
          lastVerifiedAt: "2026-06-19T00:00:00.000Z",
        },
      );
      fixture.packs[0].stationLines.push(
        {
          stationId: "station-disconnected-a",
          lineId: "seoul-5",
          stationCode: "501",
          lineSequence: 1,
          platformInfo: "분리된 테스트 노드 A",
        },
        {
          stationId: "station-disconnected-b",
          lineId: "seoul-5",
          stationCode: "502",
          lineSequence: 2,
          platformInfo: "분리된 테스트 노드 B",
        },
      );
      fixture.packs[0].networkEdges.push({
        id: "edge-disconnected-a-b-seoul-5",
        fromNodeId: "station-disconnected-a:seoul-5",
        toNodeId: "station-disconnected-b:seoul-5",
        durationSeconds: 180,
        distanceMeters: 700,
        edgeType: "RIDE",
        servicePattern: "EXPRESS",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 80,
        lastVerifiedAt: "2026-06-19T00:00:00.000Z",
      });
      fixture.packs[0].minimumTableRows.stations = 4;
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /route graph has disconnected component/);
    },
  );
});

test("데이터팩 검증기는 역방향 route edge 누락을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges = fixture.packs[0].networkEdges.filter(
        (edge) =>
          edge.id !== "edge-sadang-sangnoksu-seoul-4" &&
          edge.id !== "edge-sadang-sangnoksu-seoul-4-express",
      );
      fixture.packs[0].minimumTableRows.network_edges = 13;
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /route graph has unreachable directed path/);
    },
  );
});

test("데이터팩 검증기는 WALKWAY edge를 route graph 연결성으로 인정하지 않는다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      for (const edge of fixture.packs[0].networkEdges) {
        if (edge.edgeType !== "ENTRY" && edge.edgeType !== "EXIT") {
          edge.edgeType = "WALKWAY";
        }
      }
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /station-line node is isolated from route graph/);
    },
  );
});

test("데이터팩 검증기는 ITX edge를 SUBWAY representative route 연결성으로 인정하지 않는다", async () => {
  await buildAndTamperCatalogSqlite(
    (database) => {
      database.prepare("UPDATE network_edges SET service_class = 'ITX_CHEONGCHUN' WHERE edge_type = 'RIDE'").run();
    },
    async ({ validate }) => {
      await assert.rejects(
        validate(),
        /representativeRouteRegressions required edge missing|station-line node is isolated from route graph|route graph has unreachable directed path/,
      );
    },
  );
});

test("데이터팩 검증기는 unknown network edge_type을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges[0].edgeType = "SKY_BRIDGE";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /network_edges edge_type is not allowed/);
    },
  );
});

test("데이터팩 생성기는 누락된 network edge_type을 허용된 WALKWAY로 채운다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges.push({
        id: "walkway-default-edge-type",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        durationSeconds: 60,
        distanceMeters: 15,
        servicePattern: "LOCAL",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 90,
        lastVerifiedAt: "2026-06-19T00:00:00.000Z",
      });
    },
    async ({ buildAndValidate, withDb }) => {
      await buildAndValidate();
      await withDb((database) => {
        assert.equal(
          database
            .prepare("SELECT edge_type FROM network_edges WHERE id = ?")
            .get("walkway-default-edge-type").edge_type,
          "WALKWAY",
        );
      });
    },
  );
});

test("데이터팩 검증기는 app처럼 transfer route를 양방향으로 평가한다", async () => {
  await withMutatedCatalogFixture(
    () => {},
    async ({ buildAndValidate }) => {
      await buildAndValidate();
    },
  );
});

test("데이터팩 검증기는 대표 route regression 필수 pattern 누락을 거부한다", async () => {
  await buildDefaultAndMutateManifest(
    (manifest) => {
      manifest.packs[0].representativeRouteRegressions =
        manifest.packs[0].representativeRouteRegressions.filter(
          (route) => route.pattern !== "MULTI_TRANSFER",
        );
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /representativeRouteRegressions missing required pattern/);
    },
  );
});

test("데이터팩 검증기는 대표 route regression route shape 재사용을 거부한다", async () => {
  await buildDefaultAndMutateManifest(
    (manifest) => {
      const direct = manifest.packs[0].representativeRouteRegressions.find((route) => route.pattern === "DIRECT");
      const transfer = manifest.packs[0].representativeRouteRegressions.find((route) => route.pattern === "TRANSFER");
      transfer.fromNodeId = direct.fromNodeId;
      transfer.toNodeId = direct.toNodeId;
      transfer.requiredEdgeIds = direct.requiredEdgeIds;
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /representativeRouteRegressions duplicate route shape across patterns/);
    },
  );
});

test("데이터팩 검증기는 대표 route regression required edge 누락을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges = fixture.packs[0].networkEdges.filter(
        (edge) => edge.id !== "edge-sangnoksu-sadang-seoul-4-express",
      );
      fixture.packs[0].minimumTableRows.network_edges = 14;
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /representativeRouteRegressions required edge missing/);
    },
  );
});

test("데이터팩 검증기는 대표 route regression required edge 경로 이탈을 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const expressEdge = fixture.packs[0].networkEdges.find(
        (edge) => edge.id === "edge-sangnoksu-sadang-seoul-4-express",
      );
      expressEdge.fromNodeId = "station-sangnoksu:seoul-4";
      expressEdge.toNodeId = "station-gangnam:seoul-2";
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /representativeRouteRegressions required edge not on route/);
    },
  );
});

test("데이터팩 검증기는 station-to-station access edge를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges.push({
        id: "entry-station-to-station",
        fromNodeId: "station-sangnoksu",
        toNodeId: "station-sadang",
        durationSeconds: 60,
        distanceMeters: 10,
        edgeType: "ENTRY",
        servicePattern: "LOCAL",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 90,
        lastVerifiedAt: "2026-06-19T00:00:00.000Z",
      });
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /network_edges access edge must connect station and station-line/);
    },
  );
});

test("데이터팩 검증기는 다른 station으로 이어지는 access edge를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges.push({
        id: "entry-cross-station-line",
        fromNodeId: "station-sangnoksu",
        toNodeId: "station-sadang:seoul-4",
        durationSeconds: 60,
        distanceMeters: 10,
        edgeType: "ENTRY",
        servicePattern: "LOCAL",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 90,
        lastVerifiedAt: "2026-06-19T00:00:00.000Z",
      });
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /network_edges access edge station mismatch/);
    },
  );
});

test("데이터팩 검증기는 빈 service-pattern suffix route node를 거부한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges.push({
        id: "edge-empty-pattern-suffix",
        fromNodeId: "station-sangnoksu:seoul-4:",
        toNodeId: "station-sadang:seoul-4",
        durationSeconds: 420,
        distanceMeters: 18600,
        edgeType: "RIDE",
        servicePattern: "LOCAL",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 90,
        lastVerifiedAt: "2026-06-19T00:00:00.000Z",
      });
    },
    async ({ build, validate }) => {
      await build();
      await assert.rejects(validate(), /network_edges endpoint references missing station-line/);
    },
  );
});

test("데이터팩 검증기는 access edge와 canonical station-line endpoint를 허용한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].networkEdges.push(
        {
          id: "entry-sangnoksu-line4-local",
          fromNodeId: "station-sangnoksu",
          toNodeId: "station-sangnoksu:seoul-4",
          durationSeconds: 90,
          distanceMeters: 20,
          edgeType: "ENTRY",
          servicePattern: "LOCAL",
          includesStairs: false,
          stairAccessState: "STEP_FREE",
          accessibilityStatus: "AVAILABLE",
          reliabilityScore: 90,
          lastVerifiedAt: "2026-06-19T00:00:00.000Z",
        },
        {
          id: "ride-sangnoksu-sadang-line4-local",
          fromNodeId: "station-sangnoksu:seoul-4",
          toNodeId: "station-sadang:seoul-4",
          durationSeconds: 420,
          distanceMeters: 18600,
          edgeType: "RIDE",
          servicePattern: "LOCAL",
          includesStairs: false,
          stairAccessState: "STEP_FREE",
          accessibilityStatus: "AVAILABLE",
          reliabilityScore: 90,
          lastVerifiedAt: "2026-06-19T00:00:00.000Z",
        },
        {
          id: "exit-sadang-line4-local",
          fromNodeId: "station-sadang:seoul-4",
          toNodeId: "station-sadang",
          durationSeconds: 60,
          distanceMeters: 15,
          edgeType: "EXIT",
          servicePattern: "LOCAL",
          includesStairs: false,
          stairAccessState: "STEP_FREE",
          accessibilityStatus: "AVAILABLE",
          reliabilityScore: 90,
          lastVerifiedAt: "2026-06-19T00:00:00.000Z",
        },
      );
    },
    async ({ buildAndValidate }) => {
      await buildAndValidate();
    },
  );
});

test("데이터팩 생성기는 stairAccessState 계단 전용 값을 legacy flag에 반영한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      // 리뷰 F2(#923): 서버 번들과 같은 규칙. 계단 여부가 상태와 어긋나면 빌드를 거부하고, 맞으면 상태에서 flag를 유도한다.
      fixture.packs[0].networkEdges[0].stairAccessState = "STAIR_ONLY";
      fixture.packs[0].networkEdges[0].includesStairs = false;
    },
    async ({ fixture, fixturePath, build, withDb }) => {
      await assert.rejects(
        build(),
        /network edge stair state is invalid: edge-sangnoksu-sadang-seoul-4/,
      );
      fixture.packs[0].networkEdges[0].includesStairs = true;
      await writeJson(fixturePath, fixture);
      await build();

      await withDb((database) => {
        const stairStateRow = database
          .prepare("SELECT includes_stairs, stair_access_state FROM network_edges WHERE id = ?")
          .get("edge-sangnoksu-sadang-seoul-4");
        assert.deepEqual(
          { ...stairStateRow },
          {
            includes_stairs: 1,
            stair_access_state: "STAIR_ONLY",
          },
        );
      });
    },
  );
});

test("데이터팩 생성기는 stairAccessState 계단 없음 값을 legacy flag에 반영한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      // 리뷰 F2(#923): 서버 번들과 같은 규칙. 계단 여부가 상태와 어긋나면 빌드를 거부하고, 맞으면 상태에서 flag를 유도한다.
      fixture.packs[0].networkEdges[0].stairAccessState = "STEP_FREE";
      fixture.packs[0].networkEdges[0].includesStairs = true;
    },
    async ({ fixture, fixturePath, build, withDb }) => {
      await assert.rejects(
        build(),
        /network edge stair state is invalid: edge-sangnoksu-sadang-seoul-4/,
      );
      fixture.packs[0].networkEdges[0].includesStairs = false;
      await writeJson(fixturePath, fixture);
      await build();

      await withDb((database) => {
        const stairStateRow = database
          .prepare("SELECT includes_stairs, stair_access_state FROM network_edges WHERE id = ?")
          .get("edge-sangnoksu-sadang-seoul-4");
        assert.deepEqual(
          { ...stairStateRow },
          {
            includes_stairs: 0,
            stair_access_state: "STEP_FREE",
          },
        );
      });
    },
  );
});

test("데이터팩 검증기는 manifest checksum 불일치를 거부한다", async () => {
  await buildDefaultAndMutateManifest(
    (manifest) => {
      manifest.packs[0].sha256 = "0".repeat(64);
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /compressed checksum mismatch/);
    },
  );
});

test("데이터팩 검증기는 packs에 없는 activePack을 거부한다", async () => {
  await buildDefaultAndMutateManifest(
    (manifest) => {
      manifest.activePack = { id: "capital", version: "999" };
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /activePack must match one of manifest packs/);
    },
  );
});

test("데이터팩 검증기는 invalid emergencyOverride를 거부한다", async () => {
  await buildDefaultAndMutateManifest(
    (manifest) => {
      manifest.emergencyOverride = { id: "capital", version: "1" };
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /emergencyOverride.reason must be a non-empty string/);
    },
  );
});

test("데이터팩 생성기는 top-level 노선 scope를 여러 pack scope의 합집합으로 검증한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const scope = { regionId: "capital", operatorId: "seoul-metro", lineId: "seoul-4" };
      fixture.coverageLineOperatorScopeSemantics = "UNION_OF_PACK_SCOPES";
      fixture.coverageLineOperatorScopes = [scope];
      fixture.packs[0].coverageLineOperatorScopes = [scope];
      const secondPack = structuredClone(fixture.packs[0]);
      secondPack.id = "capital-copy";
      secondPack.version = "2";
      secondPack.url = "catalog/capital-copy-v2.sqlite.gz";
      fixture.packs.push(secondPack);
    },
    async ({ build, readManifest }) => {
      await build();
      const manifest = await readManifest();
      assert.deepEqual(manifest.packs.map(({ id }) => id), ["capital", "capital-copy"]);
    },
  );
});

test("데이터팩 생성기는 Unicode 정규화 형태가 다른 operator scope 집합을 순서와 무관하게 비교한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const pack = fixture.packs[0];
      pack.operators.push(
        { id: "é", nameKo: "합성형 운영기관", nameEn: "" },
        { id: "e\u0301", nameKo: "분해형 운영기관", nameEn: "" },
      );
      const scopes = [
        { regionId: "capital", operatorId: "é", lineId: "seoul-4" },
        { regionId: "capital", operatorId: "e\u0301", lineId: "seoul-4" },
        { regionId: "capital", operatorId: "seoul-metro", lineId: "seoul-4" },
      ];
      fixture.coverageLineOperatorScopeSemantics = "UNION_OF_PACK_SCOPES";
      fixture.coverageLineOperatorScopes = scopes;
      pack.coverageLineOperatorScopes = [scopes[1], scopes[0], scopes[2]];
    },
    async ({ build }) => {
      await build();
    },
  );
});

test("데이터팩 생성기는 여러 노선 service provenance를 실제 운영기관-노선 pair로 분할한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const pack = fixture.packs[0];
      pack.lines.find(({ id }) => id === "seoul-2").operatorId = "korail";
      const scheduleSource = structuredClone(pack.sourceInventory.find(({ id }) => id === "fixture-capital-catalog"));
      scheduleSource.id = "fixture-schedule-pairs";
      scheduleSource.fields = ["service_calendars"];
      scheduleSource.coverageScope = {
        regionIds: ["capital"],
        operatorIds: ["seoul-metro", "korail"],
        lineIds: ["seoul-4", "seoul-2"],
        sourceDomains: ["schedule_timetable"],
      };
      pack.sourceInventory.push(scheduleSource);
      pack.serviceCalendars[0].sourceId = scheduleSource.id;
    },
    async ({ build, readProvenance }) => {
      await build();
      const provenance = await readProvenance();
      const scopes = provenance.packs[0].records
        .filter((record) => record.entityType === "service_calendar" && record.field === "service_calendar")
        .map(({ coverageScope }) => coverageScope)
        .sort((left, right) => codepointCompare(left.lineIds[0], right.lineIds[0]));
      assert.deepEqual(scopes, [
        {
          regionIds: ["capital"],
          operatorIds: ["korail"],
          lineIds: ["seoul-2"],
          sourceDomains: ["schedule_timetable"],
        },
        {
          regionIds: ["capital"],
          operatorIds: ["seoul-metro"],
          lineIds: ["seoul-4"],
          sourceDomains: ["schedule_timetable"],
        },
      ]);
    },
  );
});

test("데이터팩 생성기는 공동 운영 노선 provenance에 공식 operator-line pair를 모두 보존한다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      const pack = fixture.packs[0];
      pack.coverageLineOperatorScopes = [
        { regionId: "capital", operatorId: "korail", lineId: "seoul-4" },
        { regionId: "capital", operatorId: "seoul-metro", lineId: "seoul-4" },
      ];
      const scheduleSource = structuredClone(pack.sourceInventory.find(({ id }) => id === "fixture-capital-catalog"));
      scheduleSource.id = "fixture-shared-line-schedule";
      scheduleSource.fields = ["service_calendars"];
      scheduleSource.coverageScope = {
        regionIds: ["capital"],
        operatorIds: ["korail", "seoul-metro"],
        lineIds: ["seoul-4"],
        sourceDomains: ["schedule_timetable"],
      };
      pack.sourceInventory.push(scheduleSource);
      pack.serviceCalendars[0].sourceId = scheduleSource.id;
    },
    async ({ build, readProvenance }) => {
      await build();
      const provenance = await readProvenance();
      const pairs = provenance.packs[0].records
        .filter((record) => record.entityType === "service_calendar" && record.field === "service_calendar")
        .map(({ coverageScope }) => `${coverageScope.lineIds[0]}:${coverageScope.operatorIds[0]}`)
        .sort();
      assert.deepEqual(pairs, ["seoul-4:korail", "seoul-4:seoul-metro"]);
    },
  );
});

test("공식 source ingest adapter는 production coverage 기준을 manifest 최소 row 기준으로 전파한다", async () => {
  await withBuildWorkspace(async ({ outputDir, fixturePath, buildAndValidate }) => {
    const generated = await importTestOnlyAccessibilityFixture(outputDir, productionSourceIngestInput());
    makeProductionSourceFixtureStrictCoverageValid(generated);
    await writeJson(fixturePath, generated);
    assert.equal(generated.packs[0].artifactKind, "production");
    assert.deepEqual(
      generated.packs[0].sourceInventory.map((source) => ({
        id: source.id,
        coverageScope: source.coverageScope,
      })),
      [
        {
          id: "molit-urban-rail-full-route",
          coverageScope: {
            regionIds: ["capital", "busan", "daegu", "gwangju", "daejeon"],
            operatorIds: [
              "seoul-metro",
              "korail",
              "incheon-transit",
              "busan-transportation",
              "daegu-transportation",
              "gwangju-metropolitan-rapid-transit",
              "daejeon-transportation",
            ],
            sourceDomains: ["station_line_membership"],
          },
        },
        {
          id: "seoulmetro-station-line-info",
          coverageScope: {
            regionIds: ["capital"],
            operatorIds: ["seoul-metro"],
            sourceDomains: ["station_line_membership"],
          },
        },
        {
          id: TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
          coverageScope: {
            regionIds: ["capital"],
            operatorIds: ["seoul-metro"],
            sourceDomains: ["accessibility_facilities"],
          },
        },
      ],
    );
    assert.deepEqual(JSON.parse(generated.packs[0].metadata.productionCoverageEvidence), [
      {
        regionId: "capital",
        operatorId: "seoul-metro",
        sourceDomain: "accessibility_facilities",
        sourceIds: [TEST_PRODUCTION_ACCESSIBILITY_SOURCE],
      },
      {
        regionId: "capital",
        operatorId: "seoul-metro",
        sourceDomain: "station_line_membership",
        sourceIds: ["molit-urban-rail-full-route", "seoulmetro-station-line-info"],
      },
    ]);
    assert.deepEqual(generated.packs[0].minimumTableRows, {
      catalog_metadata: 2,
      operators: 1,
      lines: 1,
      stations: 2,
      station_lines: 2,
      network_edges: 4,
      facilities: 6,
      station_facility_evidence: 6,
    });
    assert.deepEqual(
      generated.packs[0].stationFacilityEvidence.map(({ stationId, lineId, facilityType, evidenceKind }) => ({
        stationId,
        lineId,
        facilityType,
        evidenceKind,
      })),
      [
        { stationId: "station-sadang", lineId: "seoul-4", facilityType: "ELEVATOR", evidenceKind: "EXISTS" },
        { stationId: "station-sadang", lineId: "seoul-4", facilityType: "ESCALATOR", evidenceKind: "EXISTS" },
        { stationId: "station-sadang", lineId: "seoul-4", facilityType: "WHEELCHAIR_LIFT", evidenceKind: "EXISTS" },
        { stationId: "station-sangnoksu", lineId: "seoul-4", facilityType: "ELEVATOR", evidenceKind: "EXISTS" },
        { stationId: "station-sangnoksu", lineId: "seoul-4", facilityType: "ESCALATOR", evidenceKind: "EXISTS" },
        { stationId: "station-sangnoksu", lineId: "seoul-4", facilityType: "WHEELCHAIR_LIFT", evidenceKind: "EXISTS" },
      ],
    );

    const packOutputDir = path.join(outputDir, "pack");
    await buildAndValidate({
      output: packOutputDir,
      root: packOutputDir,
      manifestPath: path.join(packOutputDir, "current.json"),
    });
  });
});

test("공식 source ingest adapter는 canonical transit schedule rows를 보존한다", async () => {
  await withBuildWorkspace(async ({ outputDir, buildAndValidate }) => {
    const input = sourceIngestInput();
    input.serviceCalendars = [
      {
        serviceId: "weekday-2026",
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: false,
        sunday: false,
        startDate: "20260701",
        endDate: "20261231",
      },
    ];
    input.transitRoutes = [
      {
        id: "route-seoul-4-oido",
        lineId: "seoul-4",
        routeShortName: "4",
        routeLongName: "상록수-사당",
        directionName: "사당 방면",
      },
    ];
    input.transitTrips = [
      {
        id: "trip-seoul-4-local-0805",
        routeId: "route-seoul-4-oido",
        serviceId: "weekday-2026",
        tripHeadsign: "사당",
        directionId: "0",
        servicePattern: "LOCAL",
      },
    ];
    input.transitStopTimes = [
      {
        tripId: "trip-seoul-4-local-0805",
        stopSequence: 1,
        stationId: "station-sangnoksu",
        lineId: "seoul-4",
        arrivalSeconds: 29100,
        departureSeconds: 29100,
      },
      {
        tripId: "trip-seoul-4-local-0805",
        stopSequence: 2,
        stationId: "station-sadang",
        lineId: "seoul-4",
        arrivalSeconds: 33300,
        departureSeconds: 33320,
      },
    ];

    const generated = await importTestOnlyAccessibilityFixture(outputDir, input);
    assert.equal(generated.packs[0].requiredTables.includes("transit_stop_times"), true);
    assert.equal(generated.packs[0].minimumTableRows.transit_stop_times, 2);
    assert.equal(generated.packs[0].transitStopTimes[0].tripId, "trip-seoul-4-local-0805");

    const packOutputDir = path.join(outputDir, "pack");
    await buildAndValidate({
      fixture: path.join(outputDir, "catalog-fixture.json"),
      output: packOutputDir,
      root: packOutputDir,
      manifestPath: path.join(packOutputDir, "current.json"),
    });
  });
});

test("field provenance는 materialized facility와 EXISTS evidence를 중복 집계하지 않는다 (#2609)", async () => {
  await withBuildWorkspace(async ({ outputDir, fixturePath, build, readProvenance }) => {
    const packOutputDir = path.join(outputDir, "pack");
    const fixture = await importTestOnlyAccessibilityFixture(outputDir, await capitalPilotProductionSourceInput());
    await writeJson(fixturePath, fixture);
    await build({ output: packOutputDir });

    const absenceIds = new Set(fixture.packs[0].stationFacilityEvidence
      .filter(({ evidenceKind }) => evidenceKind === "NOT_EXISTS")
      .map(({ stationId, lineId, facilityType }) => `${stationId}:${lineId}:${facilityType}`));
    const provenance = await readProvenance(packOutputDir);
    const evidenceRecords = provenance.packs[0].records
      .filter(({ entityType }) => entityType === "station_facility_evidence");
    assert.ok(evidenceRecords.length > 0);
    assert.ok(evidenceRecords.every(({ entityId }) => absenceIds.has(entityId)));
  });
});

function stampOfficialSourceProvenance(record) {
  record.sourceId = "capital-official-stations";
  record.sourceSnapshotId = "capital-official-stations-snapshot-20260619";
  record.providerRecordHash = record.providerRecordHash ?? sha256(`provider:${record.id}:capital-official-stations`);
  record.provenanceKind = "OFFICIAL_SOURCE";
  record.verificationStatus = "VERIFIED";
  record.lastVerifiedAt = record.lastVerifiedAt ?? "2026-06-19T00:00:00Z";
  record.evidenceHash = record.evidenceHash ?? sha256(`evidence:${record.id}:capital-official-stations:${record.lastVerifiedAt}`);
}

function markFixturePackProduction(fixture) {
  process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
  const pack = fixture.packs[0];
  const officialOdFareSource = pack.sourceInventory.find(
    (source) => source.id === "seoul-metro-official-od-fares",
  );
  pack.artifactKind = "production";
  pack.url = "https://datapack.example.com/easysubway/catalog/capital-v1.sqlite.gz";
  pack.sourceInventory = [
    {
      id: "capital-official-stations",
      owner: "수도권 운영기관",
      url: "https://example.invalid/capital/stations",
      license: "공공데이터 이용허락",
      licenseStatus: "redistributable",
      redistributionAllowed: true,
      updateFrequency: "daily",
      updatedAt: "2026-06-19T00:00:00.000Z",
      fields: ["stations", "station_lines", "network_edges", "out_of_station_transfer_links", "facilities"],
      coverageScope: {
        regionIds: ["capital"],
        operatorIds: ["seoul-metro"],
        sourceDomains: ["station_line_membership", "accessibility_facilities"],
      },
    },
    ...(officialOdFareSource ? [officialOdFareSource] : []),
  ];
  for (const edge of pack.networkEdges) {
    if (edge.edgeType === "RIDE" && edge.distanceMeters > 0 && edge.durationSeconds > 0) {
      const speedKmh = (edge.distanceMeters / edge.durationSeconds) * 3.6;
      if (speedKmh < 15 || speedKmh > 110) {
        edge.durationSeconds = Math.ceil((edge.distanceMeters * 3.6) / 60);
      }
    }
    stampOfficialSourceProvenance(edge);
  }
  for (const collection of [
    pack.outOfStationTransferLinks ?? [],
    pack.internalRouteEdges ?? [],
    pack.stationPathwayEdges ?? [],
  ]) {
    for (const item of collection) {
      stampOfficialSourceProvenance(item);
    }
  }
  for (const facility of pack.facilities) {
    facility.sourceId = "capital-official-stations";
    facility.sourceSnapshotId = "capital-official-stations-snapshot-20260619";
    facility.providerFacilityRef = facility.providerFacilityRef ?? facility.id;
    facility.providerRecordHash = facility.providerRecordHash ?? sha256(`provider:${facility.id}:capital-official-stations`);
    facility.provenanceKind = "OFFICIAL_SOURCE";
    facility.verifiedAt = facility.verifiedAt ?? "2026-06-19T00:00:00Z";
    facility.retrievedAt = facility.retrievedAt ?? "2026-06-19T00:00:00Z";
    facility.evidenceHash = facility.evidenceHash ?? sha256(`evidence:${facility.id}:capital-official-stations:${facility.verifiedAt}`);
    facility.statusMeaning = facility.statusMeaning ?? "REALTIME_OPERATION";
    facility.operationalStatus = facility.operationalStatus ?? "AVAILABLE";
    facility.installationStatus = facility.installationStatus ?? "INSTALLED";
    facility.confidence = facility.confidence ?? 90;
  }
  pack.stationFacilityEvidence = pack.facilities.map((facility) => ({
    stationId: facility.stationId,
    lineId: "seoul-4",
    facilityType: facility.type,
    evidenceKind: "EXISTS",
    sourceId: facility.sourceId,
    sourceSnapshotId: facility.sourceSnapshotId,
    providerRecordHash: facility.providerRecordHash,
    evidenceHash: facility.evidenceHash,
    provenanceKind: facility.provenanceKind,
    installationStatus: facility.installationStatus,
    operationalStatus: facility.operationalStatus,
    statusMeaning: facility.statusMeaning,
    confidence: facility.confidence,
    verifiedAt: facility.verifiedAt,
    retrievedAt: facility.retrievedAt,
    strictRouteEligible: true,
    strictRouteEligibleReason: "FACILITY_EXISTS_AND_PROVENANCE_VERIFIED",
  }));
  const coveredStationLines = new Set(
    pack.stationFacilityEvidence.map((row) => `${row.stationId}:${row.lineId}`),
  );
  const evidenceTemplate = pack.stationFacilityEvidence[0];
  for (const stationLine of pack.stationLines) {
    const key = `${stationLine.stationId}:${stationLine.lineId}`;
    if (coveredStationLines.has(key)) {
      continue;
    }
    pack.stationFacilityEvidence.push({
      ...evidenceTemplate,
      stationId: stationLine.stationId,
      lineId: stationLine.lineId,
      providerRecordHash: sha256(`provider:${key}:capital-official-stations`),
      evidenceHash: sha256(`evidence:${key}:capital-official-stations:2026-06-19T00:00:00Z`),
    });
    coveredStationLines.add(key);
  }
  addMissingProductionAccessEdges(pack);
  addApprovedMovementPathwayEvidence(pack, {
    sourceId: "capital-official-stations",
    sourceSnapshotId: "capital-official-stations-snapshot-20260619",
    verifiedAt: "2026-06-19T00:00:00Z",
  });
  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    stations: 6,
    station_lines: 9,
    network_edges: pack.networkEdges.length,
    facilities: 3,
    station_facility_evidence: pack.stationFacilityEvidence.length,
  };
}

function addMissingProductionAccessEdges(pack) {
  const edgePairs = new Set(pack.networkEdges.map((edge) => `${edge.fromNodeId}->${edge.toNodeId}`));
  for (const stationLine of pack.stationLines) {
    const nodeId = `${stationLine.stationId}:${stationLine.lineId}`;
    const entryPair = `${stationLine.stationId}->${nodeId}`;
    if (!edgePairs.has(entryPair)) {
      pack.networkEdges.push(productionAccessEdge({
        id: `entry-${stationLine.stationId}-${stationLine.lineId}`,
        fromNodeId: stationLine.stationId,
        toNodeId: nodeId,
        edgeType: "ENTRY",
        durationSeconds: 90,
      }));
      edgePairs.add(entryPair);
    }
    const exitPair = `${nodeId}->${stationLine.stationId}`;
    if (!edgePairs.has(exitPair)) {
      pack.networkEdges.push(productionAccessEdge({
        id: `exit-${stationLine.stationId}-${stationLine.lineId}`,
        fromNodeId: nodeId,
        toNodeId: stationLine.stationId,
        edgeType: "EXIT",
        durationSeconds: 60,
      }));
      edgePairs.add(exitPair);
    }
  }
}

function productionAccessEdge({ id, fromNodeId, toNodeId, edgeType, durationSeconds }) {
  const edge = {
    id,
    fromNodeId,
    toNodeId,
    durationSeconds,
    distanceMeters: 0,
    edgeType,
    servicePattern: "",
    includesStairs: false,
    stairAccessState: "STEP_FREE",
    accessibilityStatus: "AVAILABLE",
    reliabilityScore: 90,
  };
  stampOfficialSourceProvenance(edge);
  return edge;
}

function makeProductionSourceFixtureExplicitlyUnavailable(fixture) {
  const pack = fixture.packs[0];
  for (const edge of pack.networkEdges.filter(({ edgeType }) => ["ENTRY", "EXIT"].includes(edgeType))) {
    edge.stairAccessState = "STEP_FREE";
    edge.accessibilityStatus = "NO_OFFICIAL_FEED";
    edge.verificationStatus = "VERIFIED";
  }
  for (const evidence of pack.stationFacilityEvidence.filter(
    ({ facilityType }) => facilityType === "ACCESSIBILITY_STATUS_PROBE",
  )) {
    evidence.evidenceKind = "NOT_EXISTS";
    evidence.installationStatus = "NOT_COVERED";
    evidence.operationalStatus = "NOT_COVERED";
    evidence.statusMeaning = "FEED_ABSENCE_RECORD";
    evidence.strictRouteEligible = false;
    evidence.strictRouteEligibleReason = "NO_OFFICIAL_STATUS_FEED";
  }
}

function packSignaturePayload(pack) {
  return `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`;
}

test("official OD fare 두 방향은 승인 artifact와 일치하는 SQLite row로 저장된다", async () => {
  const fixture = await readCatalogFixture();
  const admissionBundle = JSON.parse(
    await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"), "utf8"),
  );
  const admission = admissionBundle.admissions.find(
    ({ sourceId }) => sourceId === "seoul-metro-official-od-fares",
  );
  const quotes = fixture.packs[0].officialOdFareQuotes;
  assert.equal(quotes?.length, 2);
  assert.ok(quotes.every((quote) => quote.sourceId === admission.sourceId));
  assert.ok(quotes.every((quote) => quote.snapshotId === admission.snapshotId));
  assert.ok(quotes.every((quote) => quote.mappingLedgerHash === admission.fareStationLineMappingLedgerHash));

  await withBuildWorkspace(async ({ outputDir, build, validate }) => {
    await build({ fixture: CATALOG_FIXTURE_PATH });
    const compressed = await readFile(path.join(outputDir, "catalog/capital-v1.sqlite.gz"));
    const databasePath = path.join(outputDir, "capital-v1.sqlite");
    await writeFile(databasePath, gunzipSync(compressed));
    await withSqlite(databasePath, (database) => {
      const rows = database.prepare(`
        SELECT origin_station_id AS originStationId,
               destination_station_id AS destinationStationId,
               source_id AS sourceId,
               snapshot_id AS snapshotId,
               mapping_ledger_hash AS mappingLedgerHash,
               gnrl_card_fare AS gnrlCardFare,
               gnrl_cash_fare AS gnrlCashFare,
               yung_card_fare AS yungCardFare,
               yung_cash_fare AS yungCashFare,
               child_card_fare AS childCardFare,
               child_cash_fare AS childCashFare
        FROM official_od_fare_quotes
        ORDER BY origin_station_id, destination_station_id
      `).all();
      assert.deepEqual(rows.map((row) => ({ ...row })), [...quotes].sort((left, right) =>
        codepointCompare(left.originStationId, right.originStationId)
          || codepointCompare(left.destinationStationId, right.destinationStationId)));
    });
    await validate();
  });
});

test("official OD fare builder는 malformed·미승인·formula-shaped row를 거부한다", async () => {
  const baseline = await readCatalogFixture();
  const cases = [
    [(quote) => delete quote.gnrlCardFare, /officialOdFareQuotes.*gnrlCardFare/],
    [(quote) => { quote.mappingLedgerHash = "f".repeat(64); }, /mappingLedgerHash must match/],
    [(quote) => { quote.destinationStationId = quote.originStationId; }, /endpoints must be distinct/],
    [(quote) => { quote.baseCardFare = 1550; }, /baseCardFare is not allowed/],
    [(quote) => { quote.gnrlCardFare += 1; }, /quote set hash must match admission/],
    [(quote) => { quote.gnrlCardFare = Number.MAX_SAFE_INTEGER + 1; }, /safe integer/],
  ];

  for (const [mutate, expected] of cases) {
    await withBuildWorkspace(async ({ outputDir, fixturePath, build }) => {
      const fixture = structuredClone(baseline);
      mutate(fixture.packs[0].officialOdFareQuotes[0]);
      await writeFile(fixturePath, JSON.stringify(fixture));
      await assert.rejects(build({ output: path.join(outputDir, "out") }), expected);
    });
  }
});

test("official OD fare validator는 signed pack 내부의 admission hash 변조를 거부한다", async () => {
  await buildAndTamperCatalogSqlite(
    (database) => {
      database.prepare("UPDATE official_od_fare_quotes SET mapping_ledger_hash = ?").run("f".repeat(64));
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /official OD fare mapping_ledger_hash must match admission/);
    },
  );
});

test("official OD fare validator는 signed pack 내부의 승인 요금 변조를 거부한다", async () => {
  await buildAndTamperCatalogSqlite(
    (database) => {
      database.prepare("UPDATE official_od_fare_quotes SET gnrl_card_fare = gnrl_card_fare + 1").run();
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /official OD fare quote set hash must match admission/);
    },
  );
});

test("official OD fare validator는 pack inventory에 없는 source를 거부한다", async () => {
  await buildDefaultAndMutateManifest(
    (manifest) => {
      manifest.packs[0].sourceInventory = manifest.packs[0].sourceInventory.filter(
        (source) => source.id !== "seoul-metro-official-od-fares",
      );
    },
    async ({ validate }) => {
      await assert.rejects(validate(), /official OD fare source_id is not in sourceInventory/);
    },
  );
});

// station_car_door_hints(빠른하차 칸/문 힌트) 범위·enum·FK negative gate.
// 유효한 station-line은 fixture의 station-sadang/seoul-4를 사용한다.
function baseCarDoorHint(overrides = {}) {
  return {
    id: "car-door-hint-sadang-seoul-4-stair",
    stationId: "station-sadang",
    lineId: "seoul-4",
    direction: "UP",
    targetFacilityType: "STAIR",
    carNumber: 3,
    doorNumber: 2,
    ...overrides,
  };
}

const withCarDoorHintFixture = (hintOverrides, fn) =>
  withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].stationCarDoorHints = [baseCarDoorHint(hintOverrides)];
      fixture.packs[0].minimumTableRows.station_car_door_hints = 1;
    },
    fn,
  );

test("데이터팩 생성기·검증기는 유효한 station_car_door_hints(WHEELCHAIR_LIFT·빈 direction 포함)를 적재하고 통과시킨다", async () => {
  await withMutatedCatalogFixture(
    (fixture) => {
      fixture.packs[0].stationCarDoorHints = [
        baseCarDoorHint(),
        baseCarDoorHint({
          id: "car-door-hint-sadang-seoul-4-wheelchair-lift",
          direction: "",
          targetFacilityType: "WHEELCHAIR_LIFT",
          carNumber: 4,
          doorNumber: 1,
        }),
      ];
      fixture.packs[0].minimumTableRows.station_car_door_hints = 2;
    },
    async ({ outputDir, buildAndValidate }) => {
      await buildAndValidate();

      const packBytes = await readFile(path.join(outputDir, "catalog", "capital-v1.sqlite.gz"));
      const sqlitePath = path.join(outputDir, "capital-v1.sqlite");
      await writeFile(sqlitePath, gunzipSync(packBytes));
      await withSqlite(sqlitePath, (readback) => {
        const rows = readback
          .prepare("SELECT direction, car_number, door_number, target_facility_type FROM station_car_door_hints ORDER BY id")
          .all();
        assert.deepEqual(rows.map((row) => ({ ...row })), [
          { direction: "UP", car_number: 3, door_number: 2, target_facility_type: "STAIR" },
          { direction: "", car_number: 4, door_number: 1, target_facility_type: "WHEELCHAIR_LIFT" },
        ]);
      });
    },
  );
});

test("데이터팩 생성기는 car_number 0을 CHECK 위반으로 거부한다", async () => {
  await withCarDoorHintFixture({ carNumber: 0 }, async ({ build }) => {
    await assert.rejects(build(), /CHECK constraint failed|car_number/);
  });
});

test("데이터팩 생성기는 OFFICIAL car-door hint의 빈 sourceSnapshotId를 거부한다", async () => {
  await withCarDoorHintFixture(
    {
      provenanceKind: "OFFICIAL",
      sourceId: "official-source",
      sourceSnapshotId: "",
    },
    async ({ build }) => {
      await assert.rejects(build(), /stationCarDoorHints\.sourceSnapshotId/);
    },
  );
});

test("데이터팩 생성기는 공백 포함 OFFICIAL provenance를 정규화하고 빈 sourceId를 거부한다", async () => {
  await withCarDoorHintFixture(
    {
      provenanceKind: " OFFICIAL ",
      sourceId: " ",
      sourceSnapshotId: "snapshot",
    },
    async ({ build }) => {
      await assert.rejects(build(), /stationCarDoorHints\.sourceId/);
    },
  );
});

test("데이터팩 생성기는 OFFICIAL car-door hint의 빈 providerRecordHash를 거부한다", async () => {
  await withCarDoorHintFixture(
    {
      provenanceKind: "OFFICIAL",
      sourceId: "official-source",
      sourceSnapshotId: "official-snapshot",
      providerRecordHash: "",
    },
    async ({ build }) => {
      await assert.rejects(build(), /stationCarDoorHints\.providerRecordHash/);
    },
  );
});

test("데이터팩 생성기는 car_number 11을 CHECK 위반으로 거부한다", async () => {
  await withCarDoorHintFixture({ carNumber: 11 }, async ({ build }) => {
    await assert.rejects(build(), /CHECK constraint failed|car_number/);
  });
});

test("데이터팩 생성기는 door_number 0을 CHECK 위반으로 거부한다", async () => {
  await withCarDoorHintFixture({ doorNumber: 0 }, async ({ build }) => {
    await assert.rejects(build(), /CHECK constraint failed|door_number/);
  });
});

test("데이터팩 생성기는 door_number 5를 CHECK 위반으로 거부한다", async () => {
  await withCarDoorHintFixture({ doorNumber: 5 }, async ({ build }) => {
    await assert.rejects(build(), /CHECK constraint failed|door_number/);
  });
});

test("데이터팩 생성기는 허용 밖 target_facility_type을 CHECK 위반으로 거부한다", async () => {
  await withCarDoorHintFixture({ targetFacilityType: "ESCALATOR_BROKEN" }, async ({ build }) => {
    await assert.rejects(build(), /CHECK constraint failed|target_facility_type/);
  });
});

test("데이터팩 생성기는 station_lines에 없는 station_car_door_hints FK를 거부한다", async () => {
  // build-datapack.mjs는 PRAGMA foreign_keys=ON으로 적재하므로 station_lines에 없는
  // (station_id, line_id) 참조는 build 단계에서 이미 거부된다(validator의 방어적 FK
  // 검증까지 도달하지 못한다).
  await withCarDoorHintFixture({ stationId: "station-does-not-exist" }, async ({ build }) => {
    await assert.rejects(build(), /FOREIGN KEY constraint failed/);
  });
});
