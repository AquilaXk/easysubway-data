import { gzipSync, gunzipSync } from "node:zlib";
import { createHash, createSign } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { sortJson } from "./run-source-admission-pipeline.mjs";
import { validateManifest } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCK00Egf8XIduo4
1d7/Pws3NZ6ziuHe94jj/xFjvqtvuidqYD5YOgmW8XK8Eb6KEE6Xsu2BbWtXniEI
sfP3lUUuabTbz62WX1OEPNKzcG73JyEQP6bS+fLXq0rxmAHqB/uwmSMYEmfwwsNq
JVahW8PlMSO/jfd/+8wUiWN01QpkLZd/SodiVi/Xx0DBskcp46yYmSTLXcc1WfjQ
e4SfkVYQm8UjmqpWCkn6TVXeKnf2Brb4STlI5UcAvpTjjKmNJdSOjs0IpWm5BHA3
uECe+Vi61cN2sRDo5reJS1tAkiCSX5mZPA2RgcIQiF39ksH2f8QQd2/IkCZQoK0A
otfkU5r3AgMBAAECggEAERi5MY5qxihW6g70uoyCDheNZuEYtgPYGPQFqToHFOhh
CEm4A9eJ7MvpbF3nEEu30hjYBRN7n7u6p756pCf+8BtWiaeG4jj1KRjwfea/07I+
8ShVnC/qB0NyJFSrD65SAcqqNsG1iUIDHORiSdbqRiSKGYIbU+inlnPhCrdd4z5H
tLZtN/IZD5YfgJbPU7ADW1VPAIEaCLNcfmBS1NfML9DLuAmHZxfvoXI9oSEYvUOc
YCIF4mNkwmpJCylP8mADNhyHNj+7r5SKijhfTRL7xeHJxa4F8ctM3UAg7zpG6Njk
F5hDukO/GvsqQi+EqPp0sJfrdDTxyZ2zwtI8FPXKWQKBgQC/XM7IBSAoJgAF60PV
1oiqP6lzT4ydVGXkqtESHxx70TnpwMnU2aRlOu61SBHWxqvFhRId8WFko2/rKYtM
hbZ/TTlBHtsu5YiwE4BZcwU+kTp3sZCHOtD1G9aOk63Qz9mVqXBVlJEeNv9C6KGA
0fsU5exJyzLjxsEFprbRY7fWJQKBgQC5t4Y/nzUL7EsEcxRFB+Lr6VRbb/N3RzOK
j4QoDZ2UAN2bCNKQgpqmcLY7O+XB4BRhhQdGVs79LDSjp3huY5QTf7N0aro2ybT3
h5BBFFiPPWGUS5651aFU6vdxMBrEkzzPnhPeOUkHGwaTmdmY7HfRKrbrHbx6oX0H
aPTo3wG76wKBgEmHgbT9szN6FnwvwCsEehLgz12NbXxul5BbymXqKmmxJU2aVHND
BZYYJOznOmOKhyooTaPPwhqHalOz7OCEaHFV3PAWySWl8PWnKKQ2PAekihC/28b6
ZJwqDDFQsXMQyoxlRNK9eV1gyIiPFq+G/7Ex/68DMxSupDBltM2UQWk5AoGASkmO
Cs79YhqP22TI+9/utl0sIDNE2TaC+G719yuTF8vM2SILUEDd6av2SPVpr0aaAHQ8
97brrzvKhpgLxWRRrAcN2oiCmj3PBKCWZGHmFs3/xVkGUeGRWi1u8zjBzFX1Ijti
SSby/kOiOtJ0xwX325RRfPT1GryUDa2/IZNq1ycCgYEAo/3pD6aluZrJAJYb5WqY
zvnAVLCVuMUi2zkCNQr9v5L/jW/f3ZQ4ojV5WYCNLE5wcEBwDle0xuUyCN6mQ6sd
o35vd3fdGgjXdRONSb0iXcqjem8PNsDixTRtlmr2iVW54/AdUz3ME40/osRFW+nQ
xdXms0N7qyLs62EdiaOxJy8=
-----END PRIVATE KEY-----`;
const testPublicKeyPem = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAitNBIH/FyHbqONXe/z8L
NzWes4rh3veI4/8RY76rb7onamA+WDoJlvFyvBG+ihBOl7LtgW1rV54hCLHz95VF
Lmm028+tll9ThDzSs3Bu9ychED+m0vny16tK8ZgB6gf7sJkjGBJn8MLDaiVWoVvD
5TEjv433f/vMFIljdNUKZC2Xf0qHYlYv18dAwbJHKeOsmJkky13HNVn40HuEn5FW
EJvFI5qqVgpJ+k1V3ip39ga2+Ek5SOVHAL6U44ypjSXUjo7NCKVpuQRwN7hAnvlY
utXDdrEQ6Oa3iUtbQJIgkl+ZmTwNkYHCEIhd/ZLB9n/EEHdvyJAmUKCtAKLX5FOa
9wIDAQAB
-----END PUBLIC KEY-----`;
const productionEnv = {
  ...process.env,
  EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: testPrivateKeyPem,
  EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: testPublicKeyPem,
};

test("데이터팩 생성기는 TEST_ONLY admission fixture를 build input으로 거부한다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-test-only-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        "tools/datapack/fixtures/test-only-itx-cheongchun-admitted.json",
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /TEST_ONLY artifact cannot be used as datapack build input/,
  );
});

test("데이터팩 생성기는 fixture로 원격 manifest와 gzip SQLite pack을 만든다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
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

  const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
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

  const sqlitePath = path.join(outputDir, "catalog", "capital-v1.sqlite");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 18);
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
        // #1701: 사당 환승소요시간을 서울교통공사 공식 baseline(환승역거리 소요시간, 74m/01:02=62초)으로
        // 교체했다. 기존 수기값 210초는 공식값 62초로 갱신됨(공식값 우선). pathway edge 리치 구조는 보존.
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
        from_node_id: "station-sangnoksu:seoul-4:EXPRESS",
        to_node_id: "station-sadang:seoul-4:EXPRESS",
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
  } finally {
    database.close();
  }
});

test("데이터팩 검증기는 공개 채널 user_version 상한을 넘는 pack을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-public-user-version-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
        "--max-public-catalog-user-version",
        "14",
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 catalog user_version 18 exceeds public compatibility maximum 14/,
  );
});

test("데이터팩 생성기는 transit_feed_info feed_end_date를 적재하고 검증을 통과한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-feed-info-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.packs[0].transitFeedInfo = [{ feedEndDate: "20261231" }];
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    ["tools/datapack/validate-datapack.mjs", "--manifest", path.join(outputDir, "current.json"), "--root", outputDir],
    { cwd: root, env: productionEnv },
  );

  const database = new DatabaseSync(path.join(outputDir, "catalog", "capital-v1.sqlite"), { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 18);
    assert.equal(
      database.prepare("SELECT feed_end_date FROM transit_feed_info").get().feed_end_date,
      "20261231",
    );
  } finally {
    database.close();
  }
});

test("데이터팩 검증기는 fare zone이 일부 station-line에만 매핑되면 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-fare-zone-missing-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.packs[0].stationFareZones = fixture.packs[0].stationFareZones.filter(
    (row) => row.stationId !== "station-sangnoksu",
  );
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-datapack.mjs", "--manifest", path.join(outputDir, "current.json"), "--root", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /fare zone mapping missing: station-sangnoksu\/seoul-4/,
  );
});

test("데이터팩 생성기는 transit_feed_info가 2개 이상이면 단일 행 제약으로 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-feed-info-multi-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.packs[0].transitFeedInfo = [{ feedEndDate: "20261231" }, { feedEndDate: "20270101" }];
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /transit_feed_info/,
  );
});

test("데이터팩 검증기는 trip별 stop_time 시간이 역행하면 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-stop-time-invalid-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const row = fixture.packs[0].transitStopTimes.find(
    (stopTime) =>
      stopTime.tripId === "trip-seoul-4-local-0805" &&
      stopTime.stationId === "station-sadang",
  );
  row.arrivalSeconds = 8 * 3600 + 3 * 60;
  row.departureSeconds = 8 * 3600 + 3 * 60;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /transit_stop_times must be monotonic/,
  );
});

test("원격 데이터팩 검증 wrapper는 manifest와 pack을 내려받아 기존 validator를 실행한다", async () => {
  const packOutputDir = path.join(tmpdir(), `easysubway-remote-datapack-source-${Date.now()}`);
  const downloadDir = path.join(tmpdir(), `easysubway-remote-datapack-download-${Date.now()}`);
  await rm(packOutputDir, { recursive: true, force: true });
  await rm(downloadDir, { recursive: true, force: true });
  await mkdir(packOutputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const server = await startObjectStorageServer({ requireAuthorization: false, basePath: "/catalog" });
  try {
    const manifestBytes = await readFile(path.join(packOutputDir, "current.json"));
    const packBytes = await readFile(path.join(packOutputDir, "catalog", "capital-v1.sqlite.gz"));
    server.objects.set("current.json", {
      body: manifestBytes,
      sha256: sha256(manifestBytes),
      sizeBytes: manifestBytes.length,
    });
    server.objects.set("capital-v1.sqlite.gz", {
      body: packBytes,
      sha256: sha256(packBytes),
      sizeBytes: packBytes.length,
    });

    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-remote-datapack-artifact.mjs",
        "--manifest-url",
        `${server.origin}/catalog/current.json`,
        "--output",
        downloadDir,
      ],
      { cwd: root, env: productionEnv },
    );

    const summary = JSON.parse(
      await readFile(path.join(downloadDir, "remote-datapack-validation-summary.json"), "utf8"),
    );
    assert.equal(summary.manifestVersion, 1);
    assert.equal(summary.validation.exitCode, 0);
    assert.equal(summary.packs[0].id, "capital");
    assert.equal(summary.packs[0].download.sizeBytesMatchesManifest, true);
    assert.equal(summary.packs[0].download.sha256MatchesManifest, true);
    assert.equal(summary.packs[0].download.sqliteSha256MatchesManifest, true);
    assert.match(summary.manifestSha256, /^[0-9a-f]{64}$/);
  } finally {
    await server.close();
    await rm(packOutputDir, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("원격 데이터팩 검증 wrapper는 validator 실패도 summary에 기록한다", async () => {
  const packOutputDir = path.join(tmpdir(), `easysubway-remote-datapack-source-invalid-${Date.now()}`);
  const downloadDir = path.join(tmpdir(), `easysubway-remote-datapack-download-invalid-${Date.now()}`);
  await rm(packOutputDir, { recursive: true, force: true });
  await rm(downloadDir, { recursive: true, force: true });
  await mkdir(packOutputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const server = await startObjectStorageServer({ requireAuthorization: false, basePath: "/catalog" });
  try {
    const manifestBytes = await readFile(path.join(packOutputDir, "current.json"));
    const corruptPackBytes = Buffer.from("not a gzip datapack");
    server.objects.set("current.json", {
      body: manifestBytes,
      sha256: sha256(manifestBytes),
      sizeBytes: manifestBytes.length,
    });
    server.objects.set("capital-v1.sqlite.gz", {
      body: corruptPackBytes,
      sha256: sha256(corruptPackBytes),
      sizeBytes: corruptPackBytes.length,
    });

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/validate-remote-datapack-artifact.mjs",
          "--manifest-url",
          `${server.origin}/catalog/current.json`,
          "--output",
          downloadDir,
        ],
        { cwd: root, env: productionEnv },
      ),
    );

    const summary = JSON.parse(
      await readFile(path.join(downloadDir, "remote-datapack-validation-summary.json"), "utf8"),
    );
    assert.notEqual(summary.validation.exitCode, 0);
    assert.equal(summary.validation.signal, null);
    assert.equal(summary.packs[0].download.sizeBytesMatchesManifest, false);
    assert.equal(summary.packs[0].download.sha256MatchesManifest, false);
    assert.equal(summary.packs[0].download.sqliteSha256MatchesManifest, false);
    assert.match(summary.packs[0].download.sqliteDecompressionError, /incorrect header check|not in gzip format/);
    assert.match(summary.validation.stderr, /sizeBytes mismatch/);
  } finally {
    await server.close();
    await rm(packOutputDir, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
});

test("데이터팩 검증기는 strict step-free transfer가 계단 pathway를 가리키면 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-strict-pathway-invalid-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.packs[0].transferRules[0].strictStepFreePathwayEdgeId = "path-edge-sadang-4-to-2-fast";
  delete fixture.packs[0].stationPathwayEdges.find(
    (edge) => edge.id === "path-edge-sadang-4-to-2-fast",
  ).includesStairs;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /transfer_rules strict step-free edge is not step-free/,
  );
});

test("데이터팩 검증기는 transfer rule pathway endpoint mismatch를 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-transfer-pathway-mismatch-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.packs[0].transferRules[0].pathwayEdgeId = "path-edge-sangnoksu-entry-platform-elevator";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /transfer_rules pathway edge does not match endpoints/,
  );
});

test("데이터팩 검증기는 unavailable strict step-free pathway를 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-strict-pathway-unavailable-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.packs[0].stationPathwayEdges.find(
    (edge) => edge.id === "path-edge-sadang-4-to-2-step-free",
  ).accessibilityStatus = "UNAVAILABLE";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /transfer_rules strict step-free edge is unavailable/,
  );
});

test("데이터팩 검증기는 UNKNOWN 시설을 요구하는 AVAILABLE pathway를 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-pathway-unknown-facility-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const facility = fixture.packs[0].facilities.find(
    (row) => row.id === "facility-sadang-transfer-elevator-1",
  );
  facility.status = "UNKNOWN";
  facility.operationalStatus = "UNKNOWN";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /station_pathway_edges unavailable facility cannot be AVAILABLE/,
  );
});

test("데이터팩 검증기는 escalator 요구 strict step-free pathway를 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-strict-pathway-escalator-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const strictPathwayEdge = fixture.packs[0].stationPathwayEdges.find(
    (edge) => edge.id === "path-edge-sadang-4-to-2-step-free",
  );
  strictPathwayEdge.edgeType = "WALK";
  strictPathwayEdge.requiresEscalator = true;
  strictPathwayEdge.requiresElevator = true;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /transfer_rules strict step-free edge is not step-free/,
  );
});

test("데이터팩 검증기는 legacy internal route mapping mismatch를 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-pathway-legacy-mismatch-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.packs[0].stationPathwayEdges.find(
    (edge) => edge.id === "path-edge-sangnoksu-concourse-exit-1",
  ).accessibilityStatus = "LIMITED";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /station_pathway_edges legacy mapping mismatch/,
  );
});

test("데이터팩 검증기는 missing legacy internal route mapping을 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-pathway-legacy-missing-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.packs[0].stationPathwayEdges.find(
    (edge) => edge.id === "path-edge-sangnoksu-concourse-exit-1",
  ).legacyInternalRouteEdgeId = "missing-legacy-edge";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /station_pathway_edges legacy mapping is missing/,
  );
});

test("데이터팩 검증기는 calendar date 추가 운행만 있는 trip도 active로 인정한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-calendar-date-only-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const calendar = fixture.packs[0].serviceCalendars[0];
  calendar.monday = false;
  calendar.tuesday = false;
  calendar.wednesday = false;
  calendar.thursday = false;
  calendar.friday = false;
  calendar.saturday = false;
  calendar.sunday = false;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );
});

test("데이터팩 생성기는 buildSpec 요청으로 candidate provenance를 남긴다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--build-spec",
      "tools/datapack/fixtures/candidate-build-spec.json",
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
  const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
  assert.equal(manifest.packs[0].id, "capital");
  assert.equal(provenance.candidateBuild.candidateId, "capital-pilot-candidate-fixture");
  assert.equal(provenance.candidateBuild.productionScopeId, "capital_pilot_android_v1");
  assert.equal(provenance.candidateBuild.artifactKind, "datapack-candidate-build-spec");
  assert.match(provenance.candidateBuild.buildSpecSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(provenance.candidateBuild.sourceSnapshotIds, [
    "snapshot-molit-urban-rail-full-route-fixture",
    "snapshot-seoulmetro-station-line-info-fixture",
  ]);
  assert.deepEqual(
    provenance.candidateBuild.sourceSnapshots.map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      sourceId: snapshot.sourceId,
      snapshotStatus: snapshot.snapshotStatus,
      credentialRedacted: snapshot.credentialRedacted,
    })),
    [
      {
        snapshotId: "snapshot-molit-urban-rail-full-route-fixture",
        sourceId: "molit-urban-rail-full-route",
        snapshotStatus: "LOCKED",
        credentialRedacted: true,
      },
      {
        snapshotId: "snapshot-seoulmetro-station-line-info-fixture",
        sourceId: "seoulmetro-station-line-info",
        snapshotStatus: "LOCKED",
        credentialRedacted: true,
      },
    ],
  );
  assert.equal(
    provenance.candidateBuild.approvedAliasLedgerHash,
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
});

test("데이터팩 생성기는 만료된 source snapshot buildSpec을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-expired-output-${Date.now()}`);
  const buildSpecDir = path.join(root, "tmp", `easysubway-datapack-build-spec-expired-${process.pid}-${Date.now()}`);
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.expired.json");
  await rm(outputDir, { recursive: true, force: true });
  await rm(buildSpecDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile("tools/datapack/fixtures/candidate-build-spec.json", "utf8"));
  buildSpec.sourceSnapshots[0].freshnessExpiresAt = "2026-06-30T00:00:00Z";
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-datapack.mjs",
          "--build-spec",
          buildSpecPath,
          "--output",
          outputDir,
        ],
        {
          cwd: root,
          env: {
            ...productionEnv,
            EASYSUBWAY_DATAPACK_BUILD_NOW: "2026-06-30T01:00:00Z",
          },
        },
      ),
      /buildSpec\.sourceSnapshots\[0\]\.freshnessExpiresAt must be in the future/,
    );
  } finally {
    await rm(buildSpecDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 admin review 없는 source snapshot buildSpec을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-admin-output-${Date.now()}`);
  const buildSpecDir = path.join(root, "tmp", `easysubway-datapack-build-spec-admin-${process.pid}-${Date.now()}`);
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.missing-admin.json");
  await rm(outputDir, { recursive: true, force: true });
  await rm(buildSpecDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile("tools/datapack/fixtures/candidate-build-spec.json", "utf8"));
  delete buildSpec.sourceSnapshots[0].adminReviewRecordHash;
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-datapack.mjs",
          "--build-spec",
          buildSpecPath,
          "--output",
          outputDir,
        ],
        { cwd: root, env: productionEnv },
      ),
      /buildSpec\.sourceSnapshots\[0\]\.adminReviewRecordHash must be a non-empty string/,
    );
  } finally {
    await rm(buildSpecDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 raw token을 저장 전에 거부한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-token-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  const outputPath = path.join(workDir, "snapshot.json");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "station\nSadang\nserviceKey=secret-token\n");

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-source-snapshot.mjs",
          "--input",
          rawPath,
          "--output",
          outputPath,
          "--snapshot-id",
          "snapshot-kric-token",
          "--source-id",
          "kric-station-elevator",
          "--provider",
          "국가철도공단",
          "--retrieved-at",
          "2026-06-30T03:00:00Z",
          "--raw-object-uri",
          "s3://easysubway-datapack-sources/kric-station-elevator/snapshot-kric-token.json",
          "--freshness-expires-at",
          "2026-07-07T03:00:00Z",
          "--raw-retention-expires-at",
          "2026-09-30T03:00:00Z",
        ],
        { cwd: root },
      ),
      /raw snapshot contains credential-like token/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 credential URI와 만료 retention metadata를 거부한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-policy-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "station\nSadang\n");
  const baseArgs = [
    "tools/datapack/build-source-snapshot.mjs",
    "--input",
    rawPath,
    "--output",
    path.join(workDir, "snapshot.json"),
    "--snapshot-id",
    "snapshot-kric-policy",
    "--source-id",
    "kric-station-elevator",
    "--provider",
    "국가철도공단",
    "--retrieved-at",
    "2026-06-30T03:00:00Z",
    "--freshness-expires-at",
    "2026-07-07T03:00:00Z",
  ];

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          ...baseArgs,
          "--raw-object-uri",
          "s3://bucket/snapshot.json?serviceKey=secret",
          "--raw-retention-expires-at",
          "2026-09-30T03:00:00Z",
        ],
        { cwd: root },
      ),
      /--raw-object-uri must be a credential-free object storage URI/,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          ...baseArgs,
          "--raw-object-uri",
          "s3://bucket/snapshot.json",
          "--raw-retention-expires-at",
          "2026-01-01T00:00:00Z",
        ],
        { cwd: root },
      ),
      /rawRetentionExpiresAt must be after retrievedAt/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("source snapshot command는 raw CSV를 LOCKED snapshot metadata로 canonicalize한다", async () => {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-ok-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  const canonicalRawPath = path.join(workDir, "canonical.csv");
  const outputPath = path.join(workDir, "snapshot.json");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, "station,line\nSadang,2\nSangnoksu,4\n");

  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-source-snapshot.mjs",
        "--input",
        rawPath,
        "--raw-output",
        canonicalRawPath,
        "--output",
        outputPath,
        "--snapshot-id",
        "snapshot-kric-station-elevator-20260630",
        "--source-id",
        "kric-station-elevator",
        "--provider",
        "국가철도공단",
        "--retrieved-at",
        "2026-06-30T03:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-station-elevator/snapshot-kric-station-elevator-20260630.csv",
        "--freshness-expires-at",
        "2026-07-07T03:00:00Z",
        "--raw-retention-expires-at",
        "2026-09-30T03:00:00Z",
      ],
      { cwd: root },
    );

    const snapshot = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(snapshot.snapshotStatus, "LOCKED");
    assert.equal(snapshot.credentialRedacted, true);
    assert.equal(snapshot.rowCount, 2);
    assert.match(snapshot.rawSha256, /^[0-9a-f]{64}$/);
    assert.match(snapshot.schemaFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(snapshot.providerRecordHashes.length, 2);
    assert.equal(await readFile(canonicalRawPath, "utf8"), "station,line\nSadang,2\nSangnoksu,4\n");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 같은 buildSpec에서 candidate artifact hash를 재현한다", async () => {
  const outputRoot = path.join(tmpdir(), `easysubway-datapack-deterministic-${process.pid}-${Date.now()}`);
  const firstOutputDir = path.join(outputRoot, "first");
  const secondOutputDir = path.join(outputRoot, "second");
  await rm(outputRoot, { recursive: true, force: true });

  try {
    for (const outputDir of [firstOutputDir, secondOutputDir]) {
      await execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-datapack.mjs",
          "--build-spec",
          "tools/datapack/fixtures/candidate-build-spec.json",
          "--output",
          outputDir,
        ],
        { cwd: root, env: productionEnv },
      );
    }

    const firstManifest = JSON.parse(await readFile(path.join(firstOutputDir, "current.json"), "utf8"));
    const secondManifest = JSON.parse(await readFile(path.join(secondOutputDir, "current.json"), "utf8"));
    const firstProvenance = JSON.parse(await readFile(path.join(firstOutputDir, "current.provenance.json"), "utf8"));
    const secondProvenance = JSON.parse(await readFile(path.join(secondOutputDir, "current.provenance.json"), "utf8"));

    assert.equal(firstManifest.packs[0].sqliteSha256, secondManifest.packs[0].sqliteSha256);
    assert.equal(firstManifest.packs[0].sha256, secondManifest.packs[0].sha256);
    assert.equal(
      firstProvenance.packs[0].normalizedSourceInventorySha256,
      secondProvenance.packs[0].normalizedSourceInventorySha256,
    );
    assert.equal(
      firstProvenance.packs[0].normalizedSourceInventorySha256,
      sha256(Buffer.from(JSON.stringify(firstManifest.packs[0].sourceInventory))),
    );
    assert.match(firstProvenance.packs[0].normalizedSourceInventorySha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 temp buildSpec이 생성 fixture를 참조할 수 있다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-temp-output-${Date.now()}`);
  const buildSpecDir = path.join(tmpdir(), `easysubway-datapack-build-spec-temp-${process.pid}-${Date.now()}`);
  const fixturePath = path.join(buildSpecDir, "catalog-fixture.json");
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.json");
  await rm(outputDir, { recursive: true, force: true });
  await rm(buildSpecDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildSpecDir, { recursive: true });

  try {
    await copyFile("tools/datapack/fixtures/catalog-fixture.json", fixturePath);
    const buildSpec = JSON.parse(await readFile("tools/datapack/fixtures/candidate-build-spec.json", "utf8"));
    buildSpec.fixturePath = fixturePath;
    await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--build-spec",
        buildSpecPath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    );

    const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
    assert.equal(provenance.candidateBuild.candidateId, "capital-pilot-candidate-fixture");
  } finally {
    await rm(buildSpecDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 buildSpec hash provenance를 lowercase hex로 정규화한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-normalized-output-${Date.now()}`);
  const buildSpecDir = path.join(root, "tmp", `easysubway-datapack-build-spec-normalized-${process.pid}-${Date.now()}`);
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.normalized.json");
  await rm(outputDir, { recursive: true, force: true });
  await rm(buildSpecDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile("tools/datapack/fixtures/candidate-build-spec.json", "utf8"));
  buildSpec.artifactKind = " datapack-candidate-build-spec ";
  buildSpec.sourceSnapshotSetHash = ` ${"A".repeat(64)} `;
  buildSpec.approvedAliasLedgerHash = ` ${"B".repeat(64)} `;
  buildSpec.facilityEvidenceLedgerHash = ` ${"C".repeat(64)} `;
  buildSpec.routeEvidenceLedgerHash = ` ${"D".repeat(64)} `;
  buildSpec.approvedOverrideSetHash = ` ${"E".repeat(64)} `;
  buildSpec.sourceInventorySha256 = ` ${"F".repeat(64)} `;
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--build-spec",
        buildSpecPath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    );

    const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
    assert.equal(provenance.candidateBuild.artifactKind, "datapack-candidate-build-spec");
    assert.equal(provenance.candidateBuild.sourceSnapshotSetHash, "a".repeat(64));
    assert.equal(provenance.candidateBuild.approvedAliasLedgerHash, "b".repeat(64));
    assert.equal(provenance.candidateBuild.facilityEvidenceLedgerHash, "c".repeat(64));
    assert.equal(provenance.candidateBuild.routeEvidenceLedgerHash, "d".repeat(64));
    assert.equal(provenance.candidateBuild.approvedOverrideSetHash, "e".repeat(64));
    assert.equal(provenance.candidateBuild.sourceInventorySha256, "f".repeat(64));
  } finally {
    await rm(buildSpecDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 buildSpec과 fixture 동시 입력을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-conflict-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--build-spec",
        "tools/datapack/fixtures/candidate-build-spec.json",
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /exactly one of --fixture or --build-spec is required/,
  );
});

test("데이터팩 생성기는 invalid buildSpec hash를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-invalid-${Date.now()}`);
  const buildSpecDir = path.join(root, "tmp", `easysubway-datapack-build-spec-invalid-${process.pid}-${Date.now()}`);
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.invalid.json");
  await rm(outputDir, { recursive: true, force: true });
  await rm(buildSpecDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile("tools/datapack/fixtures/candidate-build-spec.json", "utf8"));
  buildSpec.approvedAliasLedgerHash = "not-a-sha";
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-datapack.mjs",
          "--build-spec",
          buildSpecPath,
          "--output",
          outputDir,
        ],
        { cwd: root, env: productionEnv },
      ),
      /buildSpec.approvedAliasLedgerHash must be a sha256 hex string/,
    );
  } finally {
    await rm(buildSpecDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 repo와 temp 밖 buildSpec fixturePath를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-path-${Date.now()}`);
  const buildSpecDir = path.join(root, "tmp", `easysubway-datapack-build-spec-path-${process.pid}-${Date.now()}`);
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.invalid-path.json");
  await rm(outputDir, { recursive: true, force: true });
  await rm(buildSpecDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile("tools/datapack/fixtures/candidate-build-spec.json", "utf8"));
  buildSpec.fixturePath = path.resolve(path.parse(root).root, "etc", "hosts");
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-datapack.mjs",
          "--build-spec",
          buildSpecPath,
          "--output",
          outputDir,
        ],
        { cwd: root, env: productionEnv },
      ),
      /buildSpec.fixturePath must stay inside repository or temp directory/,
    );
  } finally {
    await rm(buildSpecDir, { recursive: true, force: true });
  }
});

test("데이터팩 생성기는 repo 내부 symlink가 temp 밖 fixture를 가리키면 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-build-spec-symlink-${Date.now()}`);
  const buildSpecDir = path.join(root, "tmp", `easysubway-datapack-build-spec-symlink-${process.pid}-${Date.now()}`);
  const buildSpecPath = path.join(buildSpecDir, "candidate-build-spec.symlink.json");
  const symlinkPath = path.join(buildSpecDir, "catalog-fixture.symlink.json");
  await rm(outputDir, { recursive: true, force: true });
  await rm(buildSpecDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(buildSpecDir, { recursive: true });
  const buildSpec = JSON.parse(await readFile("tools/datapack/fixtures/candidate-build-spec.json", "utf8"));
  buildSpec.fixturePath = symlinkPath;
  await writeFile(buildSpecPath, `${JSON.stringify(buildSpec, null, 2)}\n`);
  await symlink(path.resolve(path.parse(root).root, "etc", "hosts"), symlinkPath);

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-datapack.mjs",
          "--build-spec",
          buildSpecPath,
          "--output",
          outputDir,
        ],
        { cwd: root, env: productionEnv },
      ),
      /buildSpec.fixturePath must stay inside repository or temp directory/,
    );
  } finally {
    await rm(buildSpecDir, { recursive: true, force: true });
  }
});

test("데이터팩 검증기는 원격 publish 전 fixture pack을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-fixture-publish-gate-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
        "--require-production",
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 remote publish requires production artifactKind/,
  );
});

test("데이터팩 생성기는 route map label polygon 좌표 계약을 검증한다", async () => {
  const cases = [
    {
      name: "too-few-points",
      labelPolygon: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
      expected: /routeMapPositions\.labelPolygon must be a polygon with at least three points/,
    },
    {
      name: "negative-point",
      labelPolygon: [{ x: 1, y: 1 }, { x: -2, y: 2 }, { x: 3, y: 3 }],
      expected: /routeMapPositions\.labelPolygon\[1\]\.x must be a non-negative number/,
    },
    {
      name: "non-number-point",
      labelPolygon: [{ x: 1, y: 1 }, { x: 2, y: "2" }, { x: 3, y: 3 }],
      expected: /routeMapPositions\.labelPolygon\[1\]\.y must be a finite number/,
    },
  ];

  for (const testCase of cases) {
    const outputDir = path.join(tmpdir(), `easysubway-datapack-label-polygon-${testCase.name}-${Date.now()}`);
    const fixturePath = path.join(outputDir, "fixture.json");
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    const fixture = JSON.parse(await readFile(path.join(root, "tools/datapack/fixtures/catalog-fixture.json"), "utf8"));
    fixture.packs[0].routeMapPositions[0].labelPolygon = testCase.labelPolygon;
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/build-datapack.mjs",
          "--fixture",
          fixturePath,
          "--output",
          outputDir,
        ],
        { cwd: root, env: productionEnv },
      ),
      testCase.expected,
    );
  }
});

test("데이터팩 생성기와 검증기는 v2 manifest envelope signature를 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-v2-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture-v2.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const fixture = JSON.parse(await readFile(path.join(root, "tools/datapack/fixtures/catalog-fixture.json"), "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.releaseSequence, 7);
  assert.equal("activePack" in manifest, false);
  assert.equal(manifest.signature.algorithm, "sha256-manifest-v2");
  assert.equal(manifest.packs[0].signature.algorithm, "sha256-pack-manifest-v2");

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      manifestPath,
      "--root",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  manifest.ttlSeconds = 7200;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /manifest signature mismatch/,
  );
});

test("데이터팩 생성기는 잘못된 manifestVersion fixture를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-invalid-version-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture-invalid-version.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const fixture = JSON.parse(await readFile(path.join(root, "tools/datapack/fixtures/catalog-fixture.json"), "utf8"));
  fixture.manifest = {
    ...fixture.manifest,
    manifestVersion: "2",
  };
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /manifest\.manifestVersion must be 1 or 2/,
  );
});

test("데이터팩 검증기는 v2 manifest channel pattern을 앱 parser와 동일하게 강제한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-v2-channel-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture-v2-channel.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const fixture = JSON.parse(await readFile(path.join(root, "tools/datapack/fixtures/catalog-fixture.json"), "utf8"));
  fixture.manifest = {
    ...fixture.manifest,
    manifestVersion: 2,
    channel: "prod/eu",
    releaseSequence: 8,
    publishedAt: "2026-06-25T00:00:00.000Z",
    expiresAt: "2026-06-26T00:00:00.000Z",
    keyId: "fixture-key",
  };
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /manifest.channel must match/,
  );
});

test("데이터팩 도구는 v2 manifest timestamp timezone 계약을 앱 parser와 동일하게 강제한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-v2-timestamp-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture-v2-timestamp.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const fixture = JSON.parse(await readFile(path.join(root, "tools/datapack/fixtures/catalog-fixture.json"), "utf8"));
  fixture.manifest = {
    ...fixture.manifest,
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 9,
    publishedAt: "2026-06-25T00:00:00",
    expiresAt: "2026-06-26T00:00:00.000Z",
    keyId: "fixture-key",
  };
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /manifest.publishedAt must include timezone offset/,
  );

  fixture.manifest.publishedAt = "2026-06-25T00:00:00.000Z";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.publishedAt = "2026-06-25T00:00:00";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /manifest.publishedAt must include timezone offset/,
  );
});

test("데이터팩 publish preflight plan은 pack 검증 후 manifest publish를 마지막 단계로 고정한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-publish-plan-${Date.now()}`);
  const stageDir = path.join(tmpdir(), `easysubway-datapack-publish-stage-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "catalog"), { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pack = manifest.packs[0];
  await copyFile(path.join(outputDir, pack.url), path.join(stageDir, pack.url));
  const stagedManifestPath = path.join(stageDir, "catalog", "current.json");
  await copyFile(manifestPath, stagedManifestPath);

  const publishPlanPath = path.join(stageDir, "publish-plan.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/create-publish-plan.mjs",
      "--manifest",
      stagedManifestPath,
      "--root",
      stageDir,
      "--output",
      publishPlanPath,
    ],
    { cwd: root },
  );

  const plan = JSON.parse(await readFile(publishPlanPath, "utf8"));
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.manifestObjectKey, "catalog/current.json");
  assert.deepEqual(plan.steps.map((step) => step.type), [
    "put-pack-object",
    "verify-pack-object",
    "put-manifest-object",
    "verify-manifest-object",
  ]);
  assert.deepEqual(plan.steps[0], {
    type: "put-pack-object",
    packId: "capital",
    packVersion: "1",
    sourcePath: "catalog/capital-v1.sqlite.gz",
    objectKey: "catalog/capital-v1.sqlite.gz",
    sha256: pack.sha256,
    sizeBytes: pack.sizeBytes,
  });
  assert.deepEqual(plan.steps[1], {
    type: "verify-pack-object",
    packId: "capital",
    packVersion: "1",
    objectKey: "catalog/capital-v1.sqlite.gz",
    sha256: pack.sha256,
    sizeBytes: pack.sizeBytes,
  });
  assert.equal(plan.steps[2].type, "put-manifest-object");
  assert.equal(plan.steps[2].sourcePath, "catalog/current.json");
  assert.equal(plan.steps[2].objectKey, "catalog/current.json");
  assert.equal(plan.steps[2].packCount, 1);
  assert.equal(plan.steps[2].sha256, sha256(await readFile(stagedManifestPath)));
  assert.equal(plan.steps[3].type, "verify-manifest-object");
  assert.equal(plan.steps[3].objectKey, "catalog/current.json");
  assert.equal(plan.steps[3].sha256, sha256(await readFile(stagedManifestPath)));

  const customPackBytes = Buffer.from("custom relative pack bytes");
  const customPackPath = path.join(stageDir, "packs", "custom-capital.sqlite.gz");
  await mkdir(path.dirname(customPackPath), { recursive: true });
  await writeFile(customPackPath, customPackBytes);
  await writeFile(
    stagedManifestPath,
    `${JSON.stringify(
      {
        packs: [
          {
            id: "capital",
            version: "1",
            url: "packs/custom-capital.sqlite.gz",
            sha256: sha256(customPackBytes),
            sizeBytes: customPackBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/create-publish-plan.mjs",
      "--manifest",
      stagedManifestPath,
      "--root",
      stageDir,
      "--output",
      publishPlanPath,
    ],
    { cwd: root },
  );
  const customPlan = JSON.parse(await readFile(publishPlanPath, "utf8"));
  assert.equal(customPlan.steps[0].sourcePath, "packs/custom-capital.sqlite.gz");
  assert.equal(customPlan.steps[0].objectKey, "packs/custom-capital.sqlite.gz");

  await writeFile(path.join(stageDir, pack.url), "corrupt pack bytes");
  await copyFile(manifestPath, stagedManifestPath);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/create-publish-plan.mjs",
        "--manifest",
        stagedManifestPath,
        "--root",
        stageDir,
        "--output",
        publishPlanPath,
      ],
      { cwd: root },
    ),
    /capital@1 sizeBytes mismatch/,
  );
});

test("데이터팩 object storage publisher는 pack 검증 후 manifest를 마지막에 PUT한다", async () => {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-object-publish-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "catalog"), { recursive: true });

  const packBytes = Buffer.from("pack payload");
  const manifestBytes = Buffer.from('{"packs":[{"id":"capital","version":"1"}]}\n');
  await writeFile(path.join(stageDir, "catalog", "capital-v1.sqlite.gz"), packBytes);
  await writeFile(path.join(stageDir, "catalog", "current.json"), manifestBytes);
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        steps: [
          {
            type: "put-pack-object",
            sourcePath: "catalog/capital-v1.sqlite.gz",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "verify-pack-object",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "put-manifest-object",
            sourcePath: "catalog/current.json",
            objectKey: "catalog/current.json",
            sha256: sha256(manifestBytes),
            sizeBytes: manifestBytes.length,
          },
          {
            type: "verify-manifest-object",
            objectKey: "catalog/current.json",
            sha256: sha256(manifestBytes),
            sizeBytes: manifestBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const server = await startObjectStorageServer();
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/publish-object-storage.mjs",
        "--plan",
        planPath,
        "--root",
        stageDir,
      ],
      {
        cwd: root,
        env: objectStorageEnv(server.origin),
      },
    );

    assert.deepEqual(
      server.requests.map((request) => `${request.method} ${request.path}`),
      [
        "PUT /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        "PUT /easysubway-datapacks/catalog/current.json",
        "HEAD /easysubway-datapacks/catalog/current.json",
      ],
    );
    assert.ok(
      server.requests.every((request) => request.authorization?.startsWith("AWS4-HMAC-SHA256 ")),
      "publisher must sign every object storage request",
    );
    assert.equal(server.objects.get("catalog/capital-v1.sqlite.gz").sha256, sha256(packBytes));
    assert.equal(server.objects.get("catalog/current.json").sha256, sha256(manifestBytes));

    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/publish-object-storage.mjs",
        "--plan",
        planPath,
        "--root",
        stageDir,
        "--verify-only",
      ],
      {
        cwd: root,
        env: objectStorageEnv(server.origin),
      },
    );
    assert.deepEqual(
      server.requests.slice(-2).map((request) => `${request.method} ${request.path}`),
      [
        "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        "HEAD /easysubway-datapacks/catalog/current.json",
      ],
    );
  } finally {
    await server.close();
  }
});

test("데이터팩 object storage publisher는 PDF와 SVG content type을 보존한다", async () => {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-map-asset-publish-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "maps"), { recursive: true });

  const pdfBytes = Buffer.from("%PDF-1.6\n");
  const svgBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" />\n");
  await writeFile(path.join(stageDir, "maps", "seoul.pdf"), pdfBytes);
  await writeFile(path.join(stageDir, "maps", "gwangju.svg"), svgBytes);
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify({
      schemaVersion: 1,
      steps: [
        {
          type: "put-pack-object",
          sourcePath: "maps/seoul.pdf",
          objectKey: "maps/seoul.pdf",
          sha256: sha256(pdfBytes),
          sizeBytes: pdfBytes.length,
        },
        {
          type: "verify-pack-object",
          objectKey: "maps/seoul.pdf",
          sha256: sha256(pdfBytes),
          sizeBytes: pdfBytes.length,
        },
        {
          type: "put-pack-object",
          sourcePath: "maps/gwangju.svg",
          objectKey: "maps/gwangju.svg",
          sha256: sha256(svgBytes),
          sizeBytes: svgBytes.length,
        },
        {
          type: "verify-pack-object",
          objectKey: "maps/gwangju.svg",
          sha256: sha256(svgBytes),
          sizeBytes: svgBytes.length,
        },
      ],
    })}\n`,
  );

  const server = await startObjectStorageServer();
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/publish-object-storage.mjs",
        "--plan",
        planPath,
        "--root",
        stageDir,
      ],
      {
        cwd: root,
        env: objectStorageEnv(server.origin),
      },
    );

    assert.equal(server.objects.get("maps/seoul.pdf").contentType, "application/pdf");
    assert.equal(server.objects.get("maps/gwangju.svg").contentType, "image/svg+xml");
  } finally {
    await server.close();
  }
});

test("데이터팩 object storage publisher는 PAR URL로 pack 검증 후 manifest를 마지막에 PUT한다", async () => {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-par-publish-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "catalog"), { recursive: true });

  const packBytes = Buffer.from("pack payload");
  const manifestBytes = Buffer.from('{"packs":[{"id":"capital","version":"1"}]}\n');
  await writeFile(path.join(stageDir, "catalog", "capital-v1.sqlite.gz"), packBytes);
  await writeFile(path.join(stageDir, "catalog", "current.json"), manifestBytes);
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        steps: [
          {
            type: "put-pack-object",
            sourcePath: "catalog/capital-v1.sqlite.gz",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "verify-pack-object",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "put-manifest-object",
            sourcePath: "catalog/current.json",
            objectKey: "catalog/current.json",
            sha256: sha256(manifestBytes),
            sizeBytes: manifestBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const server = await startObjectStorageServer({ requireAuthorization: false, basePath: "/p/par-token/n/ns/b/bucket/o" });
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/publish-object-storage.mjs",
        "--plan",
        planPath,
        "--root",
        stageDir,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: `${server.origin}/p/par-token/n/ns/b/bucket/o/`,
        },
      },
    );

    assert.deepEqual(
      server.requests.map((request) => `${request.method} ${request.path}`),
      [
        "PUT /p/par-token/n/ns/b/bucket/o/catalog/capital-v1.sqlite.gz",
        "GET /p/par-token/n/ns/b/bucket/o/catalog/capital-v1.sqlite.gz",
        "PUT /p/par-token/n/ns/b/bucket/o/catalog/current.json",
      ],
    );
    assert.ok(
      server.requests.every((request) => request.authorization === undefined),
      "PAR publisher must not send S3 authorization headers",
    );
    assert.equal(server.objects.get("catalog/capital-v1.sqlite.gz").sha256, sha256(packBytes));
    assert.equal(server.objects.get("catalog/current.json").sha256, sha256(manifestBytes));
  } finally {
    await server.close();
  }
});

test("데이터팩 object storage publisher는 pack 검증 실패 시 manifest를 게시하지 않는다", async () => {
  const stageDir = path.join(tmpdir(), `easysubway-datapack-object-publish-fail-${Date.now()}`);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, "catalog"), { recursive: true });

  const packBytes = Buffer.from("pack payload");
  const manifestBytes = Buffer.from('{"packs":[{"id":"capital","version":"1"}]}\n');
  await writeFile(path.join(stageDir, "catalog", "capital-v1.sqlite.gz"), packBytes);
  await writeFile(path.join(stageDir, "catalog", "current.json"), manifestBytes);
  const planPath = path.join(stageDir, "publish-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        steps: [
          {
            type: "put-pack-object",
            sourcePath: "catalog/capital-v1.sqlite.gz",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: sha256(packBytes),
            sizeBytes: packBytes.length,
          },
          {
            type: "verify-pack-object",
            objectKey: "catalog/capital-v1.sqlite.gz",
            sha256: "0".repeat(64),
            sizeBytes: packBytes.length,
          },
          {
            type: "put-manifest-object",
            sourcePath: "catalog/current.json",
            objectKey: "catalog/current.json",
            sha256: sha256(manifestBytes),
            sizeBytes: manifestBytes.length,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const server = await startObjectStorageServer();
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/publish-object-storage.mjs",
          "--plan",
          planPath,
          "--root",
          stageDir,
        ],
        {
          cwd: root,
          env: objectStorageEnv(server.origin),
        },
      ),
      /catalog\/capital-v1\.sqlite\.gz uploaded checksum mismatch/,
    );

    assert.deepEqual(
      server.requests.map((request) => `${request.method} ${request.path}`),
      [
        "PUT /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
        "HEAD /easysubway-datapacks/catalog/capital-v1.sqlite.gz",
      ],
    );
    assert.equal(server.objects.has("catalog/current.json"), false);
  } finally {
    await server.close();
  }
});

test("데이터팩 remote publish env exporter는 object storage와 signing 값을 GitHub env로 내보낸다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-env-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=https://cdn.example.com/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=https://object-storage.example.com",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key\\nline",
      "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key\\nline",
      "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1",
      "EASYSUBWAY_ADMIN_PASSWORD=admin-password-must-not-export",
      "",
    ].join("\n"),
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/export-publish-env.mjs",
      "--env-file",
      envFile,
      "--github-env",
      githubEnvFile,
      "--github-output",
      path.join(dir, "github-output.txt"),
    ],
    { cwd: root },
  );

  const exported = await readFile(githubEnvFile, "utf8");
  assert.match(stdout, /^::add-mask::access-key$/m);
  assert.match(stdout, /^::add-mask::secret-key$/m);
  assert.match(stdout, /^::add-mask::private-key\\nline$/m);
  assert.match(stdout, /^::add-mask::private-key%0Aline$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=enabled$/m);
  assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=https:\/\/object-storage\.example\.com$/m);
  assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key$/m);
  assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key$/m);
  assert.match(exported, /^EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks$/m);
  assert.match(exported, /EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM<<EASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM_EOF\nprivate-key\nline\nEASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM_EOF/);
  assert.match(exported, /EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM<<EASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM_EOF\npublic-key\nline\nEASYSUBWAY_EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM_EOF/);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1$/m);
  assert.doesNotMatch(exported, /ADMIN_PASSWORD/);
});

test("데이터팩 remote publish env exporter는 PAR URL을 secret publish target으로 내보낸다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-par-env-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=https://cdn.example.com/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL=https://objectstorage.example.com/p/token/n/ns/b/bucket/o/",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key-must-not-export",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key-must-not-export",
      "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key-pem",
      "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key-pem",
      "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1",
      "",
    ].join("\n"),
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/export-publish-env.mjs",
      "--env-file",
      envFile,
      "--github-env",
      githubEnvFile,
      "--github-output",
      path.join(dir, "github-output.txt"),
    ],
    { cwd: root },
  );

  const exported = await readFile(githubEnvFile, "utf8");
  assert.match(stdout, /^::add-mask::https:\/\/objectstorage\.example\.com\/p\/token\/n\/ns\/b\/bucket\/o\/$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=enabled$/m);
  assert.match(
    exported,
    /^EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL=https:\/\/objectstorage\.example\.com\/p\/token\/n\/ns\/b\/bucket\/o\/$/m,
  );
  assert.doesNotMatch(exported, /ACCESS_KEY/);
  assert.doesNotMatch(exported, /SECRET_KEY/);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM=private-key-pem$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=public-key-pem$/m);
  assert.match(exported, /^EASYSUBWAY_DATAPACK_SIGNING_KEY_ID=production-v1$/m);
});

test("데이터팩 remote publish env exporter는 opt-in이 없으면 원격 publish를 비활성화한다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-env-disabled-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  const githubOutputFile = path.join(dir, "github-output.txt");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=http://localhost:9000/easysubway-datapacks",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=http://localhost:9000",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "",
    ].join("\n"),
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/export-publish-env.mjs",
      "--env-file",
      envFile,
      "--github-env",
      githubEnvFile,
      "--github-output",
      githubOutputFile,
    ],
    { cwd: root },
  );

  assert.match(await readFile(githubEnvFile, "utf8"), /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=disabled$/m);
  assert.match(await readFile(githubOutputFile, "utf8"), /^enabled=false$/m);
});

test("데이터팩 remote publish env exporter는 opt-in된 로컬 placeholder publish 대상을 거부한다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-env-local-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=http://localhost:9000/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=http://localhost:9000",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "",
    ].join("\n"),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/export-publish-env.mjs",
        "--env-file",
        envFile,
        "--github-env",
        githubEnvFile,
        "--github-output",
        path.join(dir, "github-output.txt"),
      ],
      { cwd: root },
    ),
    /EASYSUBWAY_DATA_PACK_BASE_URL must be an HTTPS public URL/,
  );
});

test("데이터팩 remote publish env exporter는 허용된 workflow에서 invalid publish env를 skip 처리한다", async () => {
  const dir = path.join(tmpdir(), `easysubway-datapack-publish-env-invalid-skip-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const envFile = path.join(dir, "deploy.env");
  const githubEnvFile = path.join(dir, "github.env");
  const githubOutputFile = path.join(dir, "github-output.txt");
  await writeFile(
    envFile,
    [
      "EASYSUBWAY_DATA_PACK_BASE_URL=http://localhost:9000/easysubway-datapacks",
      "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED=true",
      "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT=http://localhost:9000",
      "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY=access-key",
      "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY=secret-key",
      "EASYSUBWAY_OBJECT_STORAGE_REGION=ap-northeast-2",
      "EASYSUBWAY_DATAPACK_BUCKET=easysubway-datapacks",
      "",
    ].join("\n"),
  );

  const { stderr } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/export-publish-env.mjs",
      "--env-file",
      envFile,
      "--github-env",
      githubEnvFile,
      "--github-output",
      githubOutputFile,
      "--allow-invalid-disabled",
    ],
    { cwd: root },
  );

  assert.match(stderr, /remote publish disabled: EASYSUBWAY_DATA_PACK_BASE_URL must be an HTTPS public URL/);
  assert.match(await readFile(githubEnvFile, "utf8"), /^EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=disabled$/m);
  assert.match(await readFile(githubOutputFile, "utf8"), /^enabled=false$/m);
  assert.match(await readFile(githubOutputFile, "utf8"), /^invalid=true$/m);
});

test("데이터팩 생성기는 schema v2 실시간 provider mapping을 SQLite에 보존한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-realtime-mapping-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.manifest.activePack.version = "2";
  const pack = fixture.packs[0];
  pack.version = "2";
  pack.schemaVersion = "2";
  pack.url = "catalog/capital-v2.sqlite.gz";
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
  pack.realtimeProviderLineMappings = [
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
  ];
  pack.realtimeProviderStationMappings = [
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
  ];

  const fixturePath = path.join(outputDir, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const database = new DatabaseSync(path.join(outputDir, "catalog", "capital-v2.sqlite"), { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 18);
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
  } finally {
    database.close();
  }
});

test("데이터팩 생성기는 내부 station-line 없는 실시간 provider station mapping을 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-realtime-mapping-invalid-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.manifest.activePack.version = "2";
  const pack = fixture.packs[0];
  pack.version = "2";
  pack.schemaVersion = "2";
  pack.url = "catalog/capital-v2.sqlite.gz";
  pack.realtimeProviderLineMappings = [
    {
      providerId: "seoul-topis",
      providerLineId: "1004",
      lineId: "seoul-4",
      sourceId: "seoul-topis-realtime-station-arrival",
    },
  ];
  pack.realtimeProviderStationMappings = [
    {
      providerId: "seoul-topis",
      providerLineId: "1004",
      providerStationId: "missing",
      stationId: "station-sangnoksu",
      lineId: "seoul-2",
      sourceId: "seoul-topis-realtime-station-arrival",
    },
  ];

  const fixturePath = path.join(outputDir, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /FOREIGN KEY constraint failed/,
  );
});

test("데이터팩 생성기는 provider line과 station mapping line 불일치를 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-realtime-mapping-line-mismatch-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.manifest.activePack.version = "2";
  const pack = fixture.packs[0];
  pack.version = "2";
  pack.schemaVersion = "2";
  pack.url = "catalog/capital-v2.sqlite.gz";
  pack.realtimeProviderLineMappings = [
    {
      providerId: "seoul-topis",
      providerLineId: "1004",
      lineId: "seoul-4",
      sourceId: "seoul-topis-realtime-station-arrival",
    },
  ];
  pack.realtimeProviderStationMappings = [
    {
      providerId: "seoul-topis",
      providerLineId: "1004",
      providerStationId: "2000222",
      stationId: "station-sadang",
      lineId: "seoul-2",
      sourceId: "seoul-topis-realtime-station-arrival",
    },
  ];

  const fixturePath = path.join(outputDir, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /FOREIGN KEY constraint failed/,
  );
});

test("데이터팩 생성기는 실시간 provider capability flag의 문자열 값을 거부한다", async () => {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-realtime-mapping-bool-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  fixture.manifest.activePack.version = "2";
  const pack = fixture.packs[0];
  pack.version = "2";
  pack.schemaVersion = "2";
  pack.url = "catalog/capital-v2.sqlite.gz";
  pack.realtimeProviderLineMappings = [
    {
      providerId: "seoul-topis",
      providerLineId: "1004",
      lineId: "seoul-4",
      sourceId: "seoul-topis-realtime-station-arrival",
      supportsArrivals: "false",
    },
  ];

  const fixturePath = path.join(outputDir, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /realtimeProviderLineMappings\.supportsArrivals must be a boolean/,
  );
});

test("데이터팩 생성기는 대표 route regression 문자열을 앱 서명 기준으로 정규화한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-route-canonical-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].representativeRouteRegressions[0] = {
    ...fixture.packs[0].representativeRouteRegressions[0],
    id: " direct-local-sangnoksu-sadang ",
    pattern: " DIRECT ",
    fromNodeId: " station-sangnoksu:seoul-4:LOCAL ",
    toNodeId: " station-sadang:seoul-4:LOCAL ",
    requiredEdgeIds: [" edge-sangnoksu-sadang-seoul-4 "],
  };
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
  const route = manifest.packs[0].representativeRouteRegressions[0];
  assert.deepEqual(route, {
    id: "direct-local-sangnoksu-sadang",
    pattern: "DIRECT",
    fromNodeId: "station-sangnoksu:seoul-4:LOCAL",
    toNodeId: "station-sadang:seoul-4:LOCAL",
    requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
  });
  assert.deepEqual(manifest.packs[0].representativeRouteRegressionSignature, {
    algorithm: "sha256-route-regression-v1",
    value: sha256(Buffer.from(packSignaturePayload(manifest.packs[0]))),
  });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root },
  );
});

test("데이터팩 생성기는 production pack의 source metadata와 HTTPS URL을 강제한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-gate-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  fixture.packs[0].url = "catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production pack url must be an absolute HTTPS URL/,
  );

  fixture.packs[0].url = "https://cdn.easysubway.example/packs/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /pack.url absolute HTTPS URL path must end with catalog\/capital-v1\.sqlite\.gz/,
  );

  fixture.packs[0].url = "https://easysubway.local/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production pack url must not use a local placeholder host/,
  );

  fixture.packs[0].url = "https://easysubway.local./easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production pack url must not use a local placeholder host/,
  );

  fixture.packs[0].url = "https://127.0.0.1/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production pack url must not use a local placeholder host/,
  );

  fixture.packs[0].url = "https://100.64.0.1/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production pack url must not use a local placeholder host/,
  );

  fixture.packs[0].url = "https://[2001:db8::1]/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production pack url must not use a local placeholder host/,
  );

  fixture.packs[0].url = "https://[::127.0.0.1]/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production pack url must not use a local placeholder host/,
  );

  fixture.packs[0].url = "https://cdn.easysubway.example/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  fixture.packs[0].sourceInventory[0].updatedAt = "";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /sourceInventory.updatedAt must be a non-empty string/,
  );

  fixture.packs[0].sourceInventory[0].updatedAt = "2026-06-19T00:00:00.000Z";
  fixture.packs[0].sourceInventory[0].url = "https://";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production sourceInventory.url must be HTTPS/,
  );

  fixture.packs[0].sourceInventory[0].url = "https://easysubway.local/fixtures/catalog-fixture.json";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  fixture.packs[0].sourceInventory[0].url = "https://foo.localhost./fixtures/catalog-fixture.json";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  fixture.packs[0].sourceInventory[0].url = "https://10.0.0.5/fixtures/catalog-fixture.json";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  fixture.packs[0].sourceInventory[0].url = "https://198.18.0.1/fixtures/catalog-fixture.json";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  fixture.packs[0].sourceInventory[0].url = "https://[ff02::1]/fixtures/catalog-fixture.json";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  fixture.packs[0].sourceInventory[0].url = "https://[::10.0.0.1]/fixtures/catalog-fixture.json";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  fixture.packs[0].sourceInventory[0].url = "https://example.invalid/capital/stations";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: { ...productionEnv, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: "" } },
    ),
    /EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM is required for production data pack signatures/,
  );
});

test("데이터팩 생성기는 production sourceInventory coverageScope 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-source-coverage-scope-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  delete fixture.packs[0].sourceInventory[0].coverageScope;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory.coverageScope must be an object/,
  );
});

test("데이터팩 생성기는 sourceInventory coverageScope.lineIds 형식을 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-source-line-scope-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  fixture.packs[0].sourceInventory[0].coverageScope.lineIds = "seoul-4";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory\.coverageScope\.lineIds must be a non-empty string array/,
  );
});

test("데이터팩 생성기는 production sourceInventory 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-source-inventory-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  delete fixture.packs[0].sourceInventory;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /pack.sourceInventory must be a non-empty array/,
  );
});

test("데이터팩 생성기는 production 시설 status 의미와 검증 근거 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-production-facility-provenance-${Date.now()}`);
  const input = productionSourceIngestInput();
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  delete fixture.packs[0].facilities[0].statusMeaning;
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        outputPath,
        "--output",
        path.join(outputDir, "pack"),
      ],
      { cwd: root, env: productionEnv },
    ),
    /production facilities\.statusMeaning must be a non-empty string/,
  );
});

test("데이터팩 검증기는 현장·운영기관 확인 시설 AVAILABLE 근거를 허용한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-production-facility-positive-evidence-${Date.now()}`);
  const fixturePath = path.join(outputDir, "catalog-fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = await importOfficialSourceInput(outputDir, productionSourceIngestInput());
  makeProductionSourceFixtureStrictCoverageValid(fixture);
  for (const [index, statusMeaning] of ["FIELD_SURVEY", "OPERATOR_CONFIRMED"].entries()) {
    fixture.packs[0].facilities[index].status = "NORMAL";
    fixture.packs[0].facilities[index].operationalStatus = "AVAILABLE";
    fixture.packs[0].facilities[index].statusMeaning = statusMeaning;
    fixture.packs[0].facilities[index].provenanceKind = statusMeaning;
  }
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
});

test("데이터팩 검증기는 근거 없는 시설 operationalStatus AVAILABLE을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-production-facility-operational-evidence-${Date.now()}`);
  const fixturePath = path.join(outputDir, "catalog-fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = await importOfficialSourceInput(outputDir, productionSourceIngestInput());
  makeProductionSourceFixtureStrictCoverageValid(fixture);
  fixture.packs[0].facilities[0].status = "UNKNOWN";
  fixture.packs[0].facilities[0].operationalStatus = "AVAILABLE";
  fixture.packs[0].facilities[0].statusMeaning = "OFFICIAL_SOURCE";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--root",
        packOutputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /facilities positive status requires verified operation evidence/,
  );
});

test("데이터팩 검증기는 UNKNOWN 운행상태 시설의 strict route eligibility를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-production-facility-strict-unknown-${Date.now()}`);
  const fixturePath = path.join(outputDir, "catalog-fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = await importOfficialSourceInput(outputDir, productionSourceIngestInput());
  makeProductionSourceFixtureStrictCoverageValid(fixture);
  fixture.packs[0].stationFacilityEvidence[0].operationalStatus = "UNKNOWN";
  fixture.packs[0].stationFacilityEvidence[0].statusMeaning = "STATIC_LOCATION";
  fixture.packs[0].stationFacilityEvidence[0].strictRouteEligible = true;
  fixture.packs[0].stationFacilityEvidence[0].strictRouteEligibleReason = "FACILITY_EXISTS_AND_PROVENANCE_VERIFIED";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--root",
        packOutputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /station_facility_evidence strict route eligibility requires available operation status/,
  );
});

test("데이터팩 검증기는 production verified edge coverage report를 출력한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-edge-report-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(report.type, "datapack_verified_edge_coverage");
  assert.equal(report.entry.ratio, 1);
  assert.equal(report.exit.ratio, 1);
  assert.equal(report.transfer.ratio, 1);
  assert.equal(report.generatedConnectorGapCount, 0);
});

test("데이터팩 검증기는 UNKNOWN accessibility edge를 strict coverage에서 제외한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-edge-unknown-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  const entry = fixture.packs[0].networkEdges.find((edge) => edge.id === "entry-sangnoksu-seoul-4");
  entry.accessibilityStatus = "UNKNOWN";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  let failure;
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    );
  } catch (error) {
    failure = error;
  }

  assert(failure);
  assert.match(failure.message, /capital@1 verified ENTRY coverage gap: 1\/9/);
  const report = JSON.parse(failure.stdout.trim().split("\n").at(-1));
  assert.deepEqual(report.unverifiedAccessibilityCoverageEdges, ["entry-sangnoksu-seoul-4"]);
});

test("데이터팩 검증기는 strict coverage gap 뒤의 production provenance 오류를 숨기지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-edge-late-validation-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  const entry = fixture.packs[0].networkEdges.find((edge) => edge.id === "entry-sangnoksu-seoul-4");
  entry.accessibilityStatus = "UNKNOWN";
  fixture.packs[0].internalRouteEdges[0].verificationStatus = "PENDING_ADMIN_REVIEW";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /internal_route_edges verification_status must be VERIFIED: edge-sangnoksu-concourse-exit-1/,
  );
});

test("데이터팩 검증기는 production pathway edge 증거 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-pathway-provenance-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  fixture.packs[0].stationPathwayEdges[0].providerRecordHash = "";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /station_pathway_edges\.path-edge-sangnoksu-entry-platform-elevator\.provider_record_hash/,
  );
});

test("데이터팩 검증기는 검증된 상태 accessibility edge의 미검증 provenance를 거부한다", async () => {
  // #1996: 검증된 상태(AVAILABLE/UNDER_MAINTENANCE/NO_OFFICIAL_FEED) edge는 provenance 요건(VERIFIED 등)을
  // 여전히 강제한다. verification_status가 PENDING이면 거부한다. (UNKNOWN은 provenance 후보가 아니라 coverage
  // gap 경로로 차단된다.)
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-edge-unknown-provenance-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  const entry = fixture.packs[0].networkEdges.find((edge) => edge.id === "entry-sangnoksu-seoul-4");
  fixture.packs[0].networkEdges.push({
    ...entry,
    id: "entry-sangnoksu-seoul-4-unknown-duplicate",
    accessibilityStatus: "UNDER_MAINTENANCE",
    verificationStatus: "PENDING_ADMIN_REVIEW",
  });
  fixture.packs[0].minimumTableRows.network_edges += 1;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /network_edges accessibility edge verification_status must be VERIFIED: entry-sangnoksu-seoul-4-unknown-duplicate/,
  );
});

test("데이터팩 검증기는 production coverage에서 service pattern endpoint를 canonical station-line으로 계산한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-edge-service-pattern-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  const pack = fixture.packs[0];
  const entry = pack.networkEdges.find((edge) => edge.id === "entry-sangnoksu-seoul-4");
  const exit = pack.networkEdges.find((edge) => edge.id === "exit-sangnoksu-seoul-4");
  const transfer = pack.networkEdges.find((edge) => edge.id === "edge-sadang-line4-line2-transfer");
  entry.toNodeId = "station-sangnoksu:seoul-4:LOCAL";
  entry.servicePattern = "LOCAL";
  exit.fromNodeId = "station-sangnoksu:seoul-4:LOCAL";
  exit.servicePattern = "LOCAL";
  transfer.fromNodeId = "station-sadang:seoul-4:LOCAL";
  transfer.toNodeId = "station-sadang:seoul-2:LOCAL";
  transfer.servicePattern = "LOCAL";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(report.entry.missingCount, 0);
  assert.equal(report.exit.missingCount, 0);
  assert.equal(report.transfer.missingCount, 0);
});

test("데이터팩 검증기는 출처 없는 production positive edge를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-edge-provenance-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  delete fixture.packs[0].networkEdges[0].sourceId;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /network_edges\.edge-sangnoksu-sadang-seoul-4\.source_id must be a non-empty string/,
  );
});

test("데이터팩 생성기는 production pack의 최소 row 기준 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-minimum-rows-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  delete fixture.packs[0].minimumTableRows;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence/,
  );
});

test("데이터팩 생성기는 production pack의 0 row 기준을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-zero-minimum-rows-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  fixture.packs[0].minimumTableRows = {
    stations: 0,
    station_lines: 0,
    network_edges: 0,
    facilities: 0,
    station_facility_evidence: 0,
  };
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence/,
  );
});

test("데이터팩 검증기는 production manifest의 최소 row 기준 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-manifest-minimum-rows-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.packs[0].minimumTableRows;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence/,
  );
});

test("데이터팩 검증기는 production manifest의 0 row 기준을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-manifest-zero-minimum-rows-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs[0].minimumTableRows = {
    stations: 0,
    station_lines: 0,
    network_edges: 0,
    facilities: 0,
    station_facility_evidence: 0,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 production minimumTableRows must define positive stations, station_lines, network_edges, facilities, and station_facility_evidence/,
  );
});

test("데이터팩 검증기는 production sourceInventory coverageScope 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-validate-source-coverage-scope-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.packs[0].sourceInventory[0].coverageScope;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 production sourceInventory.coverageScope must be an object/,
  );
});

test("데이터팩 검증기는 sourceInventory coverageScope.lineIds 중복을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-validate-source-line-scope-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs[0].sourceInventory[0].coverageScope.lineIds = ["seoul-4", "seoul-4"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory\.coverageScope\.lineIds must not contain duplicates/,
  );
});

test("데이터팩 검증기는 production pack의 realtime payload table을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-realtime-payload-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pack = manifest.packs[0];
  const sqlitePath = path.join(outputDir, "catalog", "capital-v1.sqlite");
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE realtime_station_arrivals (
        provider_id TEXT NOT NULL,
        station_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    database.exec("INSERT INTO realtime_station_arrivals VALUES ('topis', 'station-sadang', '{}')");
  } finally {
    database.close();
  }

  const sqliteBytes = await readFile(sqlitePath);
  const compressedBytes = gzipSync(sqliteBytes);
  await writeFile(path.join(outputDir, "catalog", "capital-v1.sqlite.gz"), compressedBytes);
  pack.sizeBytes = compressedBytes.length;
  pack.sha256 = sha256(compressedBytes);
  pack.sqliteSha256 = sha256(sqliteBytes);
  resignProductionManifest(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 realtime payload table is not allowed in production datapack: realtime_station_arrivals/,
  );
});

test("데이터팩 검증기는 production HTTPS URL과 staged artifact path 불일치를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-path-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  markFixturePackProduction(fixture);
  fixture.packs[0].url = "https://CDN.easysubway.example/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(
    manifest.packs[0].url,
    "https://CDN.easysubway.example/easysubway-datapacks/catalog/capital-v1.sqlite.gz",
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      manifestPath,
      "--root",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  manifest.packs[0].url = "https://mirror.easysubway.example/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 signature mismatch/,
  );

  manifest.packs[0].url = "https://CDN.easysubway.example/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  manifest.packs[0].representativeRouteRegressions[0].requiredEdgeIds = ["edge-sangnoksu-sadang-local"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /capital@1 representativeRouteRegressionSignature mismatch/,
  );

  manifest.packs[0].url = "https://cdn.easysubway.example/packs/capital-v1.sqlite.gz";
  manifest.packs[0].representativeRouteRegressions =
    JSON.parse(JSON.stringify(fixture.packs[0].representativeRouteRegressions));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /pack.url absolute HTTPS URL path must end with catalog\/capital-v1\.sqlite\.gz/,
  );

  manifest.packs[0].url = "https://easysubway.local/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production pack url must not use a local placeholder host/,
  );

  manifest.packs[0].url = "https://localhost./easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production pack url must not use a local placeholder host/,
  );

  manifest.packs[0].url = "https://[::1]/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production pack url must not use a local placeholder host/,
  );

  manifest.packs[0].url = "https://[::ffff:127.0.0.1]/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production pack url must not use a local placeholder host/,
  );

  manifest.packs[0].url = "https://[2001:db8::1]/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production pack url must not use a local placeholder host/,
  );

  manifest.packs[0].url = "https://[::127.0.0.1]/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production pack url must not use a local placeholder host/,
  );

  manifest.packs[0].url = "https://CDN.easysubway.example/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  manifest.packs[0].sourceInventory[0].url = "https://";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory.url must be HTTPS/,
  );

  manifest.packs[0].sourceInventory[0].url = "https://easysubway.local/fixtures/catalog-fixture.json";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  manifest.packs[0].sourceInventory[0].url = "https://easysubway.local./fixtures/catalog-fixture.json";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  manifest.packs[0].sourceInventory[0].url = "https://192.168.0.2/fixtures/catalog-fixture.json";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  manifest.packs[0].sourceInventory[0].url = "https://[::10.0.0.1]/fixtures/catalog-fixture.json";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );

  manifest.packs[0].sourceInventory[0].url = "https://[ff02::1]/fixtures/catalog-fixture.json";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /production sourceInventory.url must not use a local placeholder host/,
  );
});

test("데이터팩 도구는 relative pack URL의 경로 이탈을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-url-boundary-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].url = "../capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /pack.url must be a safe relative path or absolute HTTPS URL/,
  );

  fixture.packs[0].url = "catalog/../catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /pack.url must be a safe relative path or absolute HTTPS URL/,
  );

  fixture.packs[0].url = "catalog/%2e%2e/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /pack.url must be a safe relative path or absolute HTTPS URL/,
  );

  fixture.packs[0].url = "catalog/capital-v1.sqlite.gz";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs[0].url = "//example.invalid/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /pack.url must be a safe relative path or absolute HTTPS URL/,
  );

  manifest.packs[0].url = "catalog/../catalog/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /pack.url must be a safe relative path or absolute HTTPS URL/,
  );

  manifest.packs[0].url = "catalog/%2e%2e/capital-v1.sqlite.gz";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /pack.url must be a safe relative path or absolute HTTPS URL/,
  );
});

test("데이터팩 도구는 sourceInventory boolean 계약을 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-source-bool-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].sourceInventory[0].redistributionAllowed = "false";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        fixturePath,
        "--output",
        outputDir,
      ],
      { cwd: root },
    ),
    /sourceInventory.redistributionAllowed must be a boolean/,
  );

  fixture.packs[0].sourceInventory[0].redistributionAllowed = false;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs[0].sourceInventory[0].redistributionAllowed = "false";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /sourceInventory.redistributionAllowed must be a boolean/,
  );
});

test("데이터팩 생성기는 시설 coverage를 시설이 있는 역 비율로 계산한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-coverage-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const secondStationFacility = {
    ...fixture.packs[0].facilities[0],
    id: "facility-sadang-elevator",
    stationId: "station-sadang",
    name: "사당역 엘리베이터",
  };
  delete secondStationFacility.exitId;
  fixture.packs[0].facilities.push(secondStationFacility);
  fixture.packs[0].minimumTableRows.facilities = 2;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
  assert.equal(manifest.packs[0].regionalQualityMetrics.stationCount, 6);
  assert.equal(manifest.packs[0].regionalQualityMetrics.facilityCoverageRatio, 0.3333);
  assert.equal(manifest.packs[0].regionalQualityMetrics.freshnessValidRatio, 0);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root },
  );
});

test("데이터팩 quality metric report는 denominator 기반 metric과 freshness를 산출한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-quality-report-${Date.now()}`);
  const reportPath = path.join(outputDir, "artifacts/datapack-quality-metrics.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-quality-metric-report.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--output",
      reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.artifactKind, "datapack-quality-metric-report");
  assert.equal(report.summary.packCount, 1);
  assert.equal(report.summary.worstRequiredFacilityEvidenceCoverageRatio, 0.1852);
  assert.equal(report.summary.worstFreshnessValidRatio, 0);
  assert.equal(report.packs[0].denominatorPolicy, "station_line_x_required_facility_type");
  assert.equal(report.packs[0].metrics.requiredFacilityEvidenceCoverageRatio, 0.1852);
  assert.equal(report.packs[0].metrics.freshnessValidRatio, 0);
});

test("데이터팩 headway report는 stop_times와 frequencies에서 대기시간 근거를 산출한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-headway-report-${Date.now()}`);
  const reportPath = path.join(outputDir, "artifacts/datapack-headways.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-headway-report.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.artifactKind, "datapack-headway-report");
  assert.equal(report.summary.packCount, 1);
  assert.equal(report.summary.declaredFrequencyCount, 1);
  assert.equal(report.packs[0].declaredFrequencies[0].headwaySeconds, 600);
  const sangnoksu = report.packs[0].observedHeadways.find(
    (row) =>
      row.stationId === "station-sangnoksu" &&
      row.stationLineId === "seoul-4" &&
      row.servicePattern === "LOCAL",
  );
  assert.deepEqual(sangnoksu.departures, [29100, 90300]);
  assert.equal(sangnoksu.minHeadwaySeconds, 61200);

  const defaultLocalFixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  delete defaultLocalFixture.packs[0].transitTrips.find(
    (row) => row.id === "trip-seoul-4-local-2505",
  ).servicePattern;
  const defaultLocalFixturePath = path.join(outputDir, "default-local-fixture.json");
  const defaultLocalReportPath = path.join(outputDir, "artifacts/datapack-headways-default-local.json");
  await writeFile(defaultLocalFixturePath, `${JSON.stringify(defaultLocalFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-headway-report.mjs",
      "--fixture",
      defaultLocalFixturePath,
      "--output",
      defaultLocalReportPath,
    ],
    { cwd: root },
  );
  const defaultLocalReport = JSON.parse(await readFile(defaultLocalReportPath, "utf8"));
  const defaultLocalSangnoksu = defaultLocalReport.packs[0].observedHeadways.find(
    (row) =>
      row.stationId === "station-sangnoksu" &&
      row.stationLineId === "seoul-4" &&
      row.servicePattern === "LOCAL",
  );
  assert.deepEqual(defaultLocalSangnoksu.departures, [29100, 90300]);

  const frequencyTemplateFixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  frequencyTemplateFixture.packs[0].transitTrips.push({
    id: "trip-seoul-2-local-0830",
    routeId: "route-seoul-2-inner",
    serviceId: "weekday-2026",
    tripHeadsign: "내선순환",
    directionId: "inner",
    servicePattern: "LOCAL",
    serviceDayStartSeconds: 0,
  });
  frequencyTemplateFixture.packs[0].transitStopTimes.push({
    tripId: "trip-seoul-2-local-0830",
    stopSequence: 1,
    stationId: "station-sadang",
    lineId: "seoul-2",
    arrivalSeconds: 30600,
    departureSeconds: 30600,
  });
  frequencyTemplateFixture.packs[0].transitFrequencies.push({
    tripId: "trip-seoul-2-local-0830",
    startTimeSeconds: 30600,
    endTimeSeconds: 33600,
    headwaySeconds: 600,
    exactTimes: false,
  });
  const frequencyTemplateFixturePath = path.join(outputDir, "frequency-template-fixture.json");
  const frequencyTemplateReportPath = path.join(outputDir, "artifacts/datapack-headways-frequency-template.json");
  await writeFile(frequencyTemplateFixturePath, `${JSON.stringify(frequencyTemplateFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-headway-report.mjs",
      "--fixture",
      frequencyTemplateFixturePath,
      "--output",
      frequencyTemplateReportPath,
    ],
    { cwd: root },
  );
  const frequencyTemplateReport = JSON.parse(await readFile(frequencyTemplateReportPath, "utf8"));
  assert.equal(
    frequencyTemplateReport.packs[0].observedHeadways.some((row) => row.lineId === "seoul-2"),
    false,
  );

  const noPickupFixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  noPickupFixture.packs[0].transitStopTimes.find(
    (row) => row.tripId === "trip-seoul-4-local-2505" && row.stationId === "station-sangnoksu",
  ).pickupType = 1;
  const noPickupFixturePath = path.join(outputDir, "no-pickup-fixture.json");
  const noPickupReportPath = path.join(outputDir, "artifacts/datapack-headways-no-pickup.json");
  await writeFile(noPickupFixturePath, `${JSON.stringify(noPickupFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-headway-report.mjs",
      "--fixture",
      noPickupFixturePath,
      "--output",
      noPickupReportPath,
    ],
    { cwd: root },
  );
  const noPickupReport = JSON.parse(await readFile(noPickupReportPath, "utf8"));
  assert.equal(
    noPickupReport.packs[0].observedHeadways.some(
      (row) =>
        row.stationId === "station-sangnoksu" &&
        row.stationLineId === "seoul-4" &&
        row.servicePattern === "LOCAL",
    ),
    false,
  );
});

test("데이터팩 quality metric report는 freshness metric 누락 manifest를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-quality-report-invalid-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.packs[0].regionalQualityMetrics.freshnessValidRatio;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-quality-metric-report.mjs",
        "--manifest",
        manifestPath,
      ],
      { cwd: root },
    ),
    /freshnessValidRatio must be a ratio/,
  );
});

test("데이터팩 생성기는 accessibilityStatus 대소문자를 정규화해 산출물을 검증 가능하게 만든다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-accessibility-status-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges[0].accessibilityStatus = "unknown";
  fixture.packs[0].internalRouteEdges[0].accessibilityStatus = "unknown";
  fixture.packs[0].stationPathwayEdges.find(
    (edge) => edge.id === "path-edge-sangnoksu-concourse-exit-1",
  ).accessibilityStatus = "unknown";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
  assert.equal(manifest.packs[0].regionalQualityMetrics.unknownAccessibilityRatio, 0.05);

  const database = new DatabaseSync(path.join(outputDir, "catalog/capital-v1.sqlite"));
  try {
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
  } finally {
    database.close();
  }

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root },
  );
});

test("데이터팩 검증기는 manifest regional quality metrics와 SQLite 내용을 대조한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-quality-mismatch-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs[0].regionalQualityMetrics.edgeCount = 1;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /regionalQualityMetrics mismatch/,
  );
});

test("데이터팩 생성기는 stairAccessState 누락 edge를 미확인 상태로 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-stair-state-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  delete fixture.packs[0].networkEdges[0].stairAccessState;
  fixture.packs[0].networkEdges[0].includesStairs = false;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const database = new DatabaseSync(path.join(outputDir, "catalog/capital-v1.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      database
        .prepare("SELECT stair_access_state FROM network_edges WHERE id = ?")
        .get("edge-sangnoksu-sadang-seoul-4").stair_access_state,
      "UNKNOWN",
    );
  } finally {
    database.close();
  }
});

test("데이터팩 검증기는 존재하지 않는 facility edge 참조를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-invalid-facility-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges[0].facilityId = "facility-does-not-exist";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /network_edges facility_id references missing facility/,
  );
});

test("데이터팩 검증기는 존재하지 않는 station-line endpoint를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-invalid-endpoint-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges[0].fromNodeId = "station-does-not-exist:seoul-4";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /network_edges endpoint references missing station-line/,
  );
});

test("데이터팩 검증기는 route graph에서 고립된 station-line node를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-isolated-node-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /station-line node is isolated from route graph/,
  );
});

test("데이터팩 검증기는 빈 route regression pack도 명시 route edge가 있으면 route graph를 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-empty-regression-route-graph-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].representativeRouteRegressions = [];
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /station-line node is isolated from route graph/,
  );
});

test("데이터팩 검증기는 분리된 route graph component를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-disconnected-graph-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
      region: "capital",
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
      region: "capital",
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /route graph has disconnected component/,
  );
});

test("데이터팩 검증기는 역방향 route edge 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-one-way-route-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges = fixture.packs[0].networkEdges.filter(
    (edge) =>
      edge.id !== "edge-sadang-sangnoksu-seoul-4" &&
      edge.id !== "edge-sadang-sangnoksu-seoul-4-express",
  );
  fixture.packs[0].minimumTableRows.network_edges = 13;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /route graph has unreachable directed path/,
  );
});

test("데이터팩 검증기는 WALKWAY edge를 route graph 연결성으로 인정하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-walkway-only-route-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  for (const edge of fixture.packs[0].networkEdges) {
    if (edge.edgeType !== "ENTRY" && edge.edgeType !== "EXIT") {
      edge.edgeType = "WALKWAY";
    }
  }
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /station-line node is isolated from route graph/,
  );
});

test("데이터팩 검증기는 ITX edge를 SUBWAY representative route 연결성으로 인정하지 않는다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-datapack-itx-only-route-"));
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--output",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    );

    const manifestPath = path.join(outputDir, "current.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const pack = manifest.packs[0];
    const sqlitePath = path.join(outputDir, "catalog", "capital-v1.sqlite");
    const database = new DatabaseSync(sqlitePath);
    try {
      database.prepare("UPDATE network_edges SET service_class = 'ITX_CHEONGCHUN' WHERE edge_type = 'RIDE'").run();
    } finally {
      database.close();
    }
    const sqliteBytes = await readFile(sqlitePath);
    const compressedBytes = gzipSync(sqliteBytes);
    await writeFile(path.join(outputDir, "catalog", "capital-v1.sqlite.gz"), compressedBytes);
    pack.sizeBytes = compressedBytes.length;
    pack.sha256 = sha256(compressedBytes);
    pack.sqliteSha256 = sha256(sqliteBytes);
    const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
    pack.signature.value = sha256(Buffer.from(fixturePayload));
    pack.representativeRouteRegressionSignature.value = sha256(
      Buffer.from(`${fixturePayload}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`),
    );
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["tools/datapack/validate-datapack.mjs", "--manifest", manifestPath, "--root", outputDir],
        { cwd: root, env: productionEnv },
      ),
      /representativeRouteRegressions required edge missing|station-line node is isolated from route graph|route graph has unreachable directed path/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("데이터팩 검증기는 unknown network edge_type을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-unknown-edge-type-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges[0].edgeType = "SKY_BRIDGE";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /network_edges edge_type is not allowed/,
  );
});

test("데이터팩 생성기는 누락된 network edge_type을 허용된 WALKWAY로 채운다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-default-edge-type-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root },
  );

  const database = new DatabaseSync(path.join(outputDir, "catalog", "capital-v1.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      database
        .prepare("SELECT edge_type FROM network_edges WHERE id = ?")
        .get("walkway-default-edge-type").edge_type,
      "WALKWAY",
    );
  } finally {
    database.close();
  }
});

test("데이터팩 검증기는 app처럼 transfer route를 양방향으로 평가한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-transfer-bidirectional-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root },
  );
});

test("데이터팩 검증기는 대표 route regression 필수 pattern 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-missing-route-pattern-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs[0].representativeRouteRegressions =
    manifest.packs[0].representativeRouteRegressions.filter(
      (route) => route.pattern !== "MULTI_TRANSFER",
    );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /representativeRouteRegressions missing required pattern/,
  );
});

test("데이터팩 검증기는 대표 route regression route shape 재사용을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-duplicate-route-shape-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const direct = manifest.packs[0].representativeRouteRegressions.find((route) => route.pattern === "DIRECT");
  const transfer = manifest.packs[0].representativeRouteRegressions.find((route) => route.pattern === "TRANSFER");
  transfer.fromNodeId = direct.fromNodeId;
  transfer.toNodeId = direct.toNodeId;
  transfer.requiredEdgeIds = direct.requiredEdgeIds;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /representativeRouteRegressions duplicate route shape across patterns/,
  );
});

test("데이터팩 검증기는 대표 route regression required edge 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-missing-route-edge-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges = fixture.packs[0].networkEdges.filter(
    (edge) => edge.id !== "edge-sangnoksu-sadang-seoul-4-express",
  );
  fixture.packs[0].minimumTableRows.network_edges = 14;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /representativeRouteRegressions required edge missing/,
  );
});

test("데이터팩 검증기는 대표 route regression required edge 경로 이탈을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-route-edge-drift-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const expressEdge = fixture.packs[0].networkEdges.find(
    (edge) => edge.id === "edge-sangnoksu-sadang-seoul-4-express",
  );
  expressEdge.fromNodeId = "station-sangnoksu:seoul-4";
  expressEdge.toNodeId = "station-sadang:seoul-4";
  expressEdge.servicePattern = "LOCAL";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root, env: productionEnv },
    ),
    /representativeRouteRegressions required edge not on route/,
  );
});

test("데이터팩 검증기는 station-to-station access edge를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-station-access-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /network_edges access edge must connect station and station-line/,
  );
});

test("데이터팩 검증기는 다른 station으로 이어지는 access edge를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-cross-station-access-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /network_edges access edge station mismatch/,
  );
});

test("데이터팩 검증기는 빈 service-pattern suffix route node를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-empty-pattern-node-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(outputDir, "current.json"),
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /network_edges endpoint references missing station-line/,
  );
});

test("데이터팩 검증기는 access edge와 service pattern station-line endpoint를 허용한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-service-pattern-endpoints-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges.push(
    {
      id: "entry-sangnoksu-line4-local",
      fromNodeId: "station-sangnoksu",
      toNodeId: "station-sangnoksu:seoul-4:LOCAL",
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
      fromNodeId: "station-sangnoksu:seoul-4:LOCAL",
      toNodeId: "station-sadang:seoul-4:LOCAL",
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
      fromNodeId: "station-sadang:seoul-4:LOCAL",
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(outputDir, "current.json"),
      "--root",
      outputDir,
    ],
    { cwd: root },
  );
});

test("데이터팩 생성기는 stairAccessState 계단 전용 값을 legacy flag에 반영한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-stair-legacy-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges[0].stairAccessState = "STAIR_ONLY";
  fixture.packs[0].networkEdges[0].includesStairs = false;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const database = new DatabaseSync(path.join(outputDir, "catalog/capital-v1.sqlite"), {
    readOnly: true,
  });
  try {
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
  } finally {
    database.close();
  }
});

test("데이터팩 생성기는 stairAccessState 계단 없음 값을 legacy flag에 반영한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-step-free-legacy-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].networkEdges[0].stairAccessState = "STEP_FREE";
  fixture.packs[0].networkEdges[0].includesStairs = true;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const database = new DatabaseSync(path.join(outputDir, "catalog/capital-v1.sqlite"), {
    readOnly: true,
  });
  try {
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
  } finally {
    database.close();
  }
});

test("데이터팩 검증기는 manifest checksum 불일치를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-invalid-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packs[0].sha256 = "0".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /compressed checksum mismatch/,
  );
});

test("데이터팩 검증기는 packs에 없는 activePack을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-active-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.activePack = { id: "capital", version: "999" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /activePack must match one of manifest packs/,
  );
});

test("데이터팩 검증기는 invalid emergencyOverride를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-override-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--output",
      outputDir,
    ],
    { cwd: root },
  );

  const manifestPath = path.join(outputDir, "current.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.emergencyOverride = { id: "capital", version: "1" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        manifestPath,
        "--root",
        outputDir,
      ],
      { cwd: root },
    ),
    /emergencyOverride.reason must be a non-empty string/,
  );
});

test("source inventory 검증기는 required source의 라이선스와 갱신일 누락을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  invalidInventory.sources[0].license.type = "";
  invalidInventory.sources[1].observedDataUpdatedAt = "";

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /license.type is required|observedDataUpdatedAt is required/,
  );
});

test("source inventory 검증기는 알 수 없는 라이선스 유형을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  invalidInventory.sources[0].license.type = "UNKNOWN";

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-unknown-license-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /license.type must be KOGL-1/,
  );
});

test("source inventory 검증기는 공공데이터포털 이용허락범위 제한 없음 source를 허용한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const freeUseInventory = structuredClone(sourceInventory);
  freeUseInventory.sources[0].license = {
    type: "PUBLIC_DATA_FREE_USE",
    name: "공공데이터포털 이용허락범위 제한 없음",
    attribution: "공공데이터포털 이용허락범위 제한 없음",
    commercialUseAllowed: true,
    derivativeWorkAllowed: true,
    redistributionAllowed: true,
    evidenceUrl: "https://www.data.go.kr/data/15098554/openapi.do",
  };

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-free-use-license-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(freeUseInventory, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-inventory.mjs",
      "--inventory",
      inventoryPath,
    ],
    { cwd: root },
  );
});

test("source inventory 검증기는 coverageScope 누락을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  delete invalidInventory.sources[0].coverageScope;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-coverage-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /coverageScope must be an object/,
  );
});

test("source inventory 검증기는 중복 lineIds를 거부한다", async () => {
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  inventory.sources[0].coverageScope.lineIds = ["seoul-4", "seoul-4"];
  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-line-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath],
      { cwd: root },
    ),
    /coverageScope\.lineIds must not contain duplicates/,
  );
});

test("source inventory 검증기는 schedule/realtime/facility capability 누락을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  delete invalidInventory.sources[0].capabilities;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-capabilities-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /capabilities must be an object/,
  );
});

test("source inventory 검증기는 provider 조건이 막힌 live ETA 승격을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  const realtimeSource = invalidInventory.sources.find((source) => source.id === "seoul-realtime-arrival-station-info");
  realtimeSource.capabilities = {
    schedule: {
      status: "UNSUPPORTED",
      productionUseAllowed: false,
      coverageStatus: "NOT_PROVIDED_BY_SOURCE",
      updateFrequency: realtimeSource.updateFrequency,
      unsupportedNotes: "realtime arrival source does not provide scheduled timetable data",
    },
    realtime: {
      status: "CANDIDATE",
      productionUseAllowed: false,
      liveEtaEligible: false,
      rateLimitStatus: "BLOCKED_PENDING_PROVIDER_TERMS_OR_QUOTA",
      coverageStatus: "SOURCE_INVENTORY_COVERED",
      updateFrequency: realtimeSource.updateFrequency,
      unsupportedNotes: "provider terms and rate limits are not approved for production live ETA",
    },
    facility: {
      status: "UNSUPPORTED",
      productionUseAllowed: false,
      coverageStatus: "NOT_PROVIDED_BY_SOURCE",
      updateFrequency: realtimeSource.updateFrequency,
      unsupportedNotes: "realtime arrival source does not provide facility data",
    },
  };
  realtimeSource.capabilities.realtime.liveEtaEligible = true;
  realtimeSource.capabilities.realtime.rateLimitStatus = "BLOCKED_PENDING_PROVIDER_TERMS_OR_QUOTA";

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-live-eta-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /live ETA requires compatible provider terms and rate limits/,
  );
});

test("source inventory 검증기는 candidate capability의 production 사용 승격을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  const scheduleSource = invalidInventory.sources.find((source) => source.id === "molit-tago-subway-info");
  scheduleSource.capabilities.schedule.productionUseAllowed = true;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-candidate-production-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /productionUseAllowed requires SUPPORTED status/,
  );
});

test("source inventory 검증기는 admitted candidate의 admission evidence 누락을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  const source = invalidInventory.sources.find((entry) => entry.id === "molit-tago-subway-info");
  delete source.admissionEvidence;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-admission-evidence-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.admissionEvidence must be an object/,
  );
});

test("source inventory 검증기는 admitted candidate sample evidence hash 불일치를 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  const source = invalidInventory.sources.find((entry) => entry.id === "molit-tago-subway-info");
  source.admissionEvidence.sampleEvidenceHash = sha256("wrong-sample-evidence");

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-admission-hash-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.admissionEvidence\.sampleEvidenceHash must be/,
  );
});

test("source inventory 검증기는 admitted candidate live sample evidence hash 누락을 거부한다", async () => {
  const sourceCandidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  const invalidCandidates = structuredClone(sourceCandidates);
  const candidate = invalidCandidates.candidates.find((entry) => entry.id === "molit-tago-subway-info");
  delete candidate.evidence.liveSampleEvidenceHash;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-candidate-admission-hash-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(candidatesPath, `${JSON.stringify(invalidCandidates, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--candidates",
        candidatesPath,
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.evidence\.liveSampleEvidenceHash is required/,
  );
});

test("source inventory 검증기는 v1 optional source가 production 필수로 남는 것을 거부한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const invalidInventory = structuredClone(sourceInventory);
  invalidInventory.sources.find((source) => source.id === "kric-disabled-toilet").requiredForProductionPack = true;

  const outputDir = path.join(tmpdir(), `easysubway-source-inventory-optional-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(invalidInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
        "--scope",
        "apps/mobile/release/production-datapack-scope.json",
      ],
      { cwd: root },
    ),
    /optional source .* must not be requiredForProductionPack/,
  );
});

test("source candidate sample 검증기는 KRIC live evidence metadata를 허용한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-sample-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const sample = {
    candidateId: "kric-subway-route-info",
    endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayRouteInfo",
    format: "json",
    fields: [
      "lnCd",
      "mreaWideCd",
      "railOprIsttCd",
      "routCd",
      "routNm",
      "stinCd",
      "stinConsOrdr",
      "stinNm",
    ],
    rowCount: 1,
    rawSha256: sha256("kric-subway-route-info raw sample"),
    schemaFingerprint: sha256(JSON.stringify([
      "lnCd",
      "mreaWideCd",
      "railOprIsttCd",
      "routCd",
      "routNm",
      "stinCd",
      "stinConsOrdr",
      "stinNm",
    ])),
    credentialRedacted: true,
    providerRecordHashes: [sha256("kric-subway-route-info row")],
  };
  sample.evidenceHash = sha256(JSON.stringify(sample));
  await writeFile(
    samplePath,
    `${JSON.stringify(sample, null, 2)}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-subway-route-info",
      "--sample",
      samplePath,
    ],
    { cwd: root },
  );

  assert.match(stdout, /source candidate sample evidence valid: kric-subway-route-info/);
});

test("KRIC route graph 수집 계획은 검증된 XML live sample을 재취득 없이 그대로 계획한다", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/plan-kric-route-graph-collection.mjs",
    ],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);

  assert.equal(plan.artifactKind, "kric-route-graph-membership-collection-plan");
  assert.equal(plan.serviceKeyEnv, "KRIC_SERVICE_KEY");
  assert.equal(plan.productionUseAllowed, false);
  assert.equal("remainingAdmissionBlocker" in plan, false);
  assert.deepEqual(
    plan.requests.map((request) => request.candidateId),
    ["kric-subway-route-info", "kric-station-info"],
  );
  for (const request of plan.requests) {
    const url = new URL(request.url);
    const serviceKeyEntries = [...url.searchParams.entries()].filter(
      ([name]) => name.toLowerCase() === "servicekey",
    );
    assert.deepEqual(serviceKeyEntries, [["serviceKey", "[서비스키값]"]]);
    assert.match(request.url, /[?&]serviceKey=\[서비스키값\](?:&|$)/);
    assert.equal(url.searchParams.get("format"), "xml");
    assert.equal(request.sampleEvidenceStatus, "validated_live_sample");
    assert.equal(request.plannedSampleFormat, "xml");
    assert.equal(request.validatedLiveSampleFormat, "xml");
    assert.equal(request.sampleAcquisitionRequired, false);
    assert.equal("remainingAdmissionBlocker" in request, false);
    assert.equal(request.productionUseAllowed, false);
    assert.equal(request.automaticRouteGraphEdgeAllowed, false);
    assert.deepEqual(request.capabilities, {
      schedule: false,
      realtime: false,
      facility: false,
    });
  }
  assert.equal(plan.requests[0].priority, 1);
  assert.deepEqual(plan.requests[0].remainingAdmissionBlockers, [
    "credentialFreeRawArchive",
    "licenseCommercialRedistributionEvidence",
    "line4RouteStationOrderCoverage",
    "providerTermsOrQuotaApproval",
    "rawObjectUri",
  ]);
  assert.deepEqual(plan.requests[1].remainingAdmissionBlockers, [
    "credentialFreeRawArchive",
    "licenseCommercialRedistributionEvidence",
    "kricStandardStationFileComparison",
    "line4StationCoverage",
    "providerTermsOrQuotaApproval",
    "rawObjectUri",
  ]);
  assert.deepEqual(plan.requests[0].expectedFields, [
    "lnCd",
    "mreaWideCd",
    "railOprIsttCd",
    "routCd",
    "routNm",
    "stinCd",
    "stinConsOrdr",
    "stinNm",
  ]);
});

test("KRIC route graph 수집 계획은 pending 후보의 sample acquisition lifecycle을 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-pending-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  candidate.sampleEvidenceStatus = "sample_url_documented_key_required";
  delete candidate.evidence.liveSampleFormat;
  candidate.evidence.missingEvidence = ["sampleResponse"];
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/plan-kric-route-graph-collection.mjs",
      "--candidates",
      candidatesPath,
      "--candidate",
      "kric-subway-route-info",
    ],
    { cwd: root },
  );
  const [request] = JSON.parse(stdout).requests;

  assert.equal(request.sampleEvidenceStatus, "sample_url_documented_key_required");
  assert.equal(request.plannedSampleFormat, "json");
  assert.equal(request.validatedLiveSampleFormat, null);
  assert.equal(request.sampleAcquisitionRequired, true);
  assert.equal("remainingAdmissionBlocker" in request, false);
  assert.deepEqual(request.remainingAdmissionBlockers, ["sampleResponse"]);
  assert.equal(request.productionUseAllowed, false);
  assert.equal(request.automaticRouteGraphEdgeAllowed, false);
});

test("KRIC route graph 수집 계획은 live sample format 누락 또는 미지원 값을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-live-format-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  const runPlanner = () => execFileAsync(
    process.execPath,
    ["tools/datapack/plan-kric-route-graph-collection.mjs", "--candidates", candidatesPath, "--candidate", candidate.id],
    { cwd: root },
  );

  delete candidate.evidence.liveSampleFormat;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /liveSampleFormat is required/);

  candidate.evidence.liveSampleFormat = "csv";
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /liveSampleFormat must be JSON or XML/);
});

test("KRIC route graph 수집 계획은 validated live sample provenance 누락·invalid·field mismatch를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-live-provenance-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  const runPlanner = () => execFileAsync(
    process.execPath,
    ["tools/datapack/plan-kric-route-graph-collection.mjs", "--candidates", candidatesPath, "--candidate", candidate.id],
    { cwd: root },
  );
  const invalidValues = {
    liveSampleRawSha256: "A".repeat(64),
    liveSampleSchemaFingerprint: "invalid",
    liveSampleEvidenceHash: "0".repeat(63),
    liveSampleRetrievedAt: "2026-07-11T09:58:45+09:00",
    liveSampleRowCount: 0,
    liveSampleFields: ["lnCd", "lnCd"],
  };

  for (const [field, invalidValue] of Object.entries(invalidValues)) {
    const invalidCandidates = structuredClone(candidates);
    const invalidCandidate = invalidCandidates.candidates.find((entry) => entry.id === candidate.id);
    delete invalidCandidate.evidence[field];
    await writeFile(candidatesPath, `${JSON.stringify(invalidCandidates, null, 2)}\n`);
    await assert.rejects(runPlanner(), new RegExp(`${field}.*required`));

    invalidCandidate.evidence[field] = invalidValue;
    await writeFile(candidatesPath, `${JSON.stringify(invalidCandidates, null, 2)}\n`);
    await assert.rejects(runPlanner(), new RegExp(field));
  }

  const mismatchedCandidates = structuredClone(candidates);
  const mismatchedCandidate = mismatchedCandidates.candidates.find((entry) => entry.id === candidate.id);
  mismatchedCandidate.evidence.liveSampleFields = mismatchedCandidate.evidence.liveSampleFields.slice(1);
  await writeFile(candidatesPath, `${JSON.stringify(mismatchedCandidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /liveSampleFields must match outputFields/);

  for (const outputFields of ["lnCd", [], ["lnCd", "lnCd"]]) {
    const invalidCandidates = structuredClone(candidates);
    const invalidCandidate = invalidCandidates.candidates.find((entry) => entry.id === candidate.id);
    invalidCandidate.evidence.outputFields = outputFields;
    invalidCandidate.evidence.liveSampleFields = ["lnCd"];
    await writeFile(candidatesPath, `${JSON.stringify(invalidCandidates, null, 2)}\n`);
    await assert.rejects(runPlanner(), /outputFields must be non-empty unique strings/);
  }
});

test("KRIC route graph 수집 계획은 지원하지 않는 KRIC 후보를 거부한다", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/plan-kric-route-graph-collection.mjs", "--candidate", "kric-station-platform"],
      { cwd: root },
    ),
    /unsupported KRIC route graph candidate: kric-station-platform/,
  );
});

test("KRIC route graph 수집 계획은 case-insensitive format 변형을 validated XML format 하나로 정규화한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-format-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  candidate.evidence.sampleUrl = candidate.evidence.sampleUrl.replace(
    "format=xml",
    "Format=xml&format=xml",
  );
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/plan-kric-route-graph-collection.mjs",
      "--candidates",
      candidatesPath,
      "--candidate",
      "kric-subway-route-info",
    ],
    { cwd: root },
  );
  const [request] = JSON.parse(stdout).requests;
  const formatEntries = [...new URL(request.url).searchParams.entries()].filter(
    ([name]) => name.toLowerCase() === "format",
  );

  assert.deepEqual(formatEntries, [["format", "xml"]]);
  assert.match(request.url, /[?&]format=xml(?:&|$)/);
});

test("KRIC route graph 수집 계획은 provenance 전용이 아닌 admission 또는 production/automatic edge가 열린 후보를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-state-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  const runPlanner = () => execFileAsync(
    process.execPath,
    [
      "tools/datapack/plan-kric-route-graph-collection.mjs",
      "--candidates",
      candidatesPath,
      "--candidate",
      "kric-subway-route-info",
    ],
    { cwd: root },
  );

  candidate.admissionStatus = "admitted_to_production_inventory";
  candidate.productionInventoryRelationship = "production_runtime_source";
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /admissionStatus must be pending admin review or inventory provenance only/);

  candidate.admissionStatus = "evidence_recorded_admin_review_required";
  candidate.automaticRouteGraphEdgeAllowed = true;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /automatic route graph edge must stay disabled/);

  candidate.automaticRouteGraphEdgeAllowed = false;
  candidate.capabilities.schedule.productionUseAllowed = true;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(runPlanner(), /production capability must stay disabled: schedule/);
});

test("KRIC route graph 수집 계획은 실제 serviceKey가 섞인 후보를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-plan-secret-${Date.now()}`);
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidates = JSON.parse(await readFile("tools/datapack/source-candidates.json", "utf8"));
  const candidate = candidates.candidates.find((entry) => entry.id === "kric-subway-route-info");
  const originalSampleUrl = candidate.evidence.sampleUrl;
  candidate.evidence.sampleUrl = candidate.evidence.sampleUrl.replace("[서비스키값]", "real-secret-key");
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/plan-kric-route-graph-collection.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-subway-route-info",
      ],
      { cwd: root },
    ),
    /sampleUrl must keep exactly one redacted serviceKey/,
  );

  candidate.evidence.sampleUrl = `${originalSampleUrl}&serviceKey=real-secret-key`;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/plan-kric-route-graph-collection.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-subway-route-info",
      ],
      { cwd: root },
    ),
    /sampleUrl must keep exactly one redacted serviceKey/,
  );

  candidate.evidence.sampleUrl = `${originalSampleUrl}&ServiceKey=real-secret-key`;
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/plan-kric-route-graph-collection.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-subway-route-info",
      ],
      { cwd: root },
    ),
    /sampleUrl must keep exactly one redacted serviceKey/,
  );
});

test("source candidate sample 검증기는 evidence hash metadata 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-sample-hash-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-subway-route-info",
        endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayRouteInfo",
        format: "json",
        fields: [
          "lnCd",
          "mreaWideCd",
          "railOprIsttCd",
          "routCd",
          "routNm",
          "stinCd",
          "stinConsOrdr",
          "stinNm",
        ],
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-subway-route-info",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /rawSha256 must be a sha256 hex string/,
  );
});

test("source candidate sample 검증기는 hand-edited evidence hash를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-stale-hash-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const sample = {
    candidateId: "kric-train-operation-organ",
    endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan",
    format: "json",
    fields: ["railOprIsttCd", "railOprIsttNm"],
    rowCount: 1,
    rawSha256: sha256("raw"),
    schemaFingerprint: sha256(JSON.stringify(["railOprIsttCd", "railOprIsttNm"])),
    credentialRedacted: true,
    providerRecordHashes: [sha256("row")],
  };
  sample.evidenceHash = sha256(JSON.stringify(sample));
  sample.fields.push("unexpectedField");
  await writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /output field missing|schemaFingerprint does not match fields/,
  );
});

test("source candidate sample 검증기는 endpoint mismatch를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-endpoint-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-subway-route-info",
        endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationInfo",
        format: "json",
        fields: [
          "lnCd",
          "mreaWideCd",
          "railOprIsttCd",
          "routCd",
          "routNm",
          "stinCd",
          "stinConsOrdr",
          "stinNm",
        ],
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-subway-route-info",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /endpoint mismatch/,
  );
});

async function writeFieldDiagnosticFixture(outputDir, { outputFields, fields }) {
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(candidatesPath, `${JSON.stringify({
    candidates: [{
      id: "field-diagnostic-test",
      evidence: {
        endpoint: "https://provider.invalid/field-diagnostic",
        formats: ["JSON"],
        outputFields,
      },
    }],
  }, null, 2)}\n`);
  await writeFile(samplePath, `${JSON.stringify({
    candidateId: "field-diagnostic-test",
    endpoint: "https://provider.invalid/field-diagnostic",
    format: "json",
    fields,
  }, null, 2)}\n`);
  return { candidatesPath, samplePath };
}

test("source candidate sample 검증기는 control과 delimiter field name을 한 줄 JSON string으로 escape한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-field-control-${Date.now()}`);
  const { candidatesPath, samplePath } = await writeFieldDiagnosticFixture(outputDir, {
    outputFields: ["expected"],
    fields: ["line\nbreak", "\u001b[31mred\u001b[0m", "nul\u0000field", "comma,name;next"],
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "field-diagnostic-test",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      const diagnostic = error.stderr.trimEnd();
      assert.equal(
        diagnostic,
        "output field missing: \"expected\"; available fields: \"\\u001b[31mred\\u001b[0m\", \"comma,name;next\", \"line\\nbreak\", \"nul\\u0000field\"",
      );
      assert.equal(diagnostic.split("\n").length, 1);
      assert.doesNotMatch(diagnostic, /\u001b|\u0000/);
      return true;
    },
  );
});

test("source candidate sample 검증기는 credential-like field name을 generic 오류로 차단한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-field-credential-${Date.now()}`);
  const credentialLikeField = "https://provider.invalid/sample?serviceKey=credential-like-field-secret";
  const { candidatesPath, samplePath } = await writeFieldDiagnosticFixture(outputDir, {
    outputFields: ["expected"],
    fields: ["safeField", credentialLikeField],
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "field-diagnostic-test",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(error.stderr.trim(), "sample field names must not contain credentials");
      assert.doesNotMatch(error.stderr, /credential-like-field-secret/);
      assert.equal(error.stderr.includes(credentialLikeField), false);
      return true;
    },
  );
});

test("source candidate sample 검증기는 ambiguous 첫 field에서 missing 진단을 즉시 확정한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-field-ambiguous-${Date.now()}`);
  const { candidatesPath, samplePath } = await writeFieldDiagnosticFixture(outputDir, {
    outputFields: ["foo", "bar"],
    fields: ["FOO", "Foo", "BAR"],
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "field-diagnostic-test",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(
        error.stderr.trim(),
        "output field missing: \"foo\"; available fields: \"BAR\", \"FOO\", \"Foo\"",
      );
      return true;
    },
  );
});

test("source candidate sample 검증기는 output field 대소문자 불일치를 field name만으로 진단한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-field-${Date.now()}`);
  const { candidatesPath, samplePath } = await writeFieldDiagnosticFixture(outputDir, {
    outputFields: ["updnDvcd"],
    fields: ["updnDvCd"],
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "field-diagnostic-test",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(
        error.stderr.trim(),
        "output field case mismatch: expected \"updnDvcd\"; actual \"updnDvCd\"",
      );
      return true;
    },
  );
});

test("source candidate sample 검증기는 true missing field를 sorted field name만으로 진단한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-missing-field-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-station-platform",
        endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stPlf",
        format: "json",
        fields: [
          "zProviderField",
          "stinFlor",
          "stinCd",
          "sfFotExt",
          "scrCharExt",
          "runDirTmnStinCd",
          "railOprIsttCd",
          "plfTpNm",
          "plfTpCd",
          "plfNo",
          "plfCplFlg",
          "lnCd",
          "grndDvCd",
          "aProviderField",
        ],
        providerSample: { updnDvCd: "SENTINEL_SAMPLE_VALUE" },
        observedUrl: "https://provider.invalid/sample?serviceKey=credential-like-secret",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-station-platform",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(
        error.stderr.trim(),
        "output field missing: \"updnDvCd\"; available fields: \"aProviderField\", \"grndDvCd\", \"lnCd\", \"plfCplFlg\", \"plfNo\", \"plfTpCd\", \"plfTpNm\", \"railOprIsttCd\", \"runDirTmnStinCd\", \"scrCharExt\", \"sfFotExt\", \"stinCd\", \"stinFlor\", \"zProviderField\"",
      );
      assert.doesNotMatch(error.stderr, /SENTINEL_SAMPLE_VALUE/);
      assert.doesNotMatch(error.stderr, /credential-like-secret/);
      return true;
    },
  );
});

test("source candidate sample 검증기는 KRIC 이동동선 route graph 자동 승격을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-route-edge-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-transfer-movement-standard",
        endpoint: "https://openapi.kric.go.kr/openapi/handicapped/transferMovement",
        format: "json",
        fields: [
          "chtnMvTpOrdr",
          "edMovePath",
          "elvtSttCd",
          "elvtTpCd",
          "imgPath",
          "mvContDtl",
          "mvPathMgNo",
          "stMovePath",
          "https://provider.invalid/sample?serviceKey=route-graph-secret",
        ],
        routeGraphEdgeAdmission: "allowed",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-transfer-movement-standard",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    (error) => {
      assert.equal(
        error.stderr.trim(),
        "route graph edge admission requires confirmed fields: distanceMeters, durationSeconds",
      );
      assert.doesNotMatch(error.stderr, /route-graph-secret/);
      return true;
    },
  );
});

test("source candidate sample 검증기는 serviceKey credential 포함을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-secret-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "kric-train-operation-organ",
        endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan",
        format: "json",
        fields: ["railOprIsttCd", "railOprIsttNm"],
        observedUrl: "https://openapi.kric.go.kr/openapi/convenientInfo/trainOperationOrgan?serviceKey=actual-secret",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /sample evidence must not contain serviceKey credentials: observedUrl/,
  );
});

test("source candidate sample 검증기는 TOPIS path serviceKey credential 포함을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-topis-secret-${Date.now()}`);
  const samplePath = path.join(outputDir, "sample.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        candidateId: "seoul-topis-realtime-station-arrival",
        endpoint: "http://swopenapi.seoul.go.kr/api/subway/{serviceKey}/json/realtimeStationArrival",
        format: "json",
        fields: [
          "arvlCd",
          "arvlMsg2",
          "arvlMsg3",
          "barvlDt",
          "bstatnNm",
          "btrainNo",
          "recptnDt",
          "statnId",
          "statnNm",
          "subwayId",
          "trainLineNm",
          "updnLine",
        ],
        observedUrl: "http://swopenapi.seoul.go.kr/api/subway/actual-secret/json/realtimeStationArrival/0/5/서울",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-candidate-sample.mjs",
        "--candidate",
        "seoul-topis-realtime-station-arrival",
        "--sample",
        samplePath,
      ],
      { cwd: root },
    ),
    /sample evidence must not contain serviceKey credentials: observedUrl/,
  );
});

test("source candidate sample evidence builder는 raw JSON response를 validator 입력으로 변환한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-json-evidence-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.json");
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify([
      {
        railOprIsttCd: "S1",
      },
      {
        railOprIsttNm: "서울교통공사",
      },
    ])}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--response",
      responsePath,
    ],
    { cwd: root },
  );
  await writeFile(evidencePath, stdout);
  const evidence = JSON.parse(stdout);
  assert.match(evidence.rawSha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(evidence.credentialRedacted, true);
  assert.equal(evidence.rowCount, 2);
  assert.equal(evidence.providerRecordHashes.length, 2);
  assert.match(evidence.evidenceHash, /^[0-9a-f]{64}$/);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--sample",
      evidencePath,
    ],
    { cwd: root },
  );
});

test("KRIC 역사별 승강장 live JSON은 tracked candidate metadata로 builder와 validator를 통과한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-station-platform-live-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.json");
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify([{
      grndDvCd: "G",
      lnCd: "1",
      plfCplFlg: "Y",
      plfNo: "1",
      plfTpCd: "1",
      plfTpNm: "상대식",
      railOprIsttCd: "S1",
      runDirTmnStinCd: "0152",
      scrCharExt: "10",
      sfFotExt: "200",
      stinCd: "0152",
      stinFlor: "B2",
      updnDvCd: "U",
    }])}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-station-platform",
      "--response",
      responsePath,
    ],
    { cwd: root },
  );
  await writeFile(evidencePath, stdout);
  const evidence = JSON.parse(stdout);
  assert.ok(evidence.fields.includes("updnDvCd"));
  assert.ok(!evidence.fields.includes("updnDvcd"));

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-station-platform",
      "--sample",
      evidencePath,
    ],
    { cwd: root },
  );
});

test("source candidate sample builder와 validator는 code-unit field 정렬을 공유한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-field-sort-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.json");
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify([{
      stinCd: "312",
      stLocCont: "3호선 승강장",
      railOprIsttCd: "S1",
      lnCd: "3",
      clsLocCont: "환승 통로",
      chtnLn: "4",
      chtnDst: "120",
    }])}\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-station-transfer-info",
      "--response",
      responsePath,
    ],
    { cwd: root },
  );
  await writeFile(evidencePath, stdout);
  const evidence = JSON.parse(stdout);
  assert.deepEqual(evidence.fields, [
    "chtnDst",
    "chtnLn",
    "clsLocCont",
    "lnCd",
    "railOprIsttCd",
    "stLocCont",
    "stinCd",
  ]);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-station-transfer-info",
      "--sample",
      evidencePath,
    ],
    { cwd: root },
  );
});

test("source candidate sample evidence builder는 raw XML response를 validator 입력으로 변환한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-xml-evidence-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.xml");
  const evidencePath = path.join(outputDir, "evidence.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `<response><body><items><item>
      <railOprIsttCd>S1</railOprIsttCd>
    </item><item>
      <railOprIsttCd>S2</railOprIsttCd>
      <railOprIsttNm/>
    </item></items></body></response>\n`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--response",
      responsePath,
    ],
    { cwd: root },
  );
  await writeFile(evidencePath, stdout);
  const evidence = JSON.parse(stdout);
  assert.match(evidence.rawSha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(evidence.credentialRedacted, true);
  assert.equal(evidence.rowCount, 2);
  assert.equal(evidence.providerRecordHashes.length, 2);
  assert.match(evidence.evidenceHash, /^[0-9a-f]{64}$/);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-source-candidate-sample.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--sample",
      evidencePath,
    ],
    { cwd: root },
  );
});

test("source candidate sample evidence builder는 raw response의 serviceKey credential을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-raw-secret-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.xml");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify({ response: { body: { serviceKey: "actual-secret" } } })}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-source-candidate-sample-evidence.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--response",
        responsePath,
      ],
      { cwd: root },
    ),
    /raw sample response must not contain serviceKey credentials/,
  );
});

test("source candidate sample evidence builder는 raw response의 TOPIS path serviceKey credential을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-raw-topis-secret-${Date.now()}`);
  const responsePath = path.join(outputDir, "response.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    responsePath,
    `${JSON.stringify({
      response: {
        url: "http://swopenapi.seoul.go.kr/api/subway/actual-secret/json/realtimePosition/0/5/1호선",
        body: {
          statnNm: "서울",
        },
      },
    })}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-source-candidate-sample-evidence.mjs",
        "--candidate",
        "seoul-topis-realtime-train-position",
        "--response",
        responsePath,
      ],
      { cwd: root },
    ),
    /raw sample response must not contain serviceKey credentials/,
  );
});

test("source admission pipeline은 admin 승인 record로 inventory admission evidence를 만든다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-${Date.now()}`);
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  const seedSamplePath = path.join(outputDir, "seed-sample.json");
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  const outputInventoryPath = path.join(outputDir, "source-inventory.admitted.json");
  const summaryPath = path.join(outputDir, "admission-summary.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidatesPath = await writePendingCandidateFixture(outputDir, "kric-train-operation-organ");
  await writeFile(rawPath, `${JSON.stringify([{ railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" }])}\n`);

  const { stdout: sampleStdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--response",
      rawPath,
    ],
    { cwd: root },
  );
  await writeFile(seedSamplePath, sampleStdout);
  const sample = JSON.parse(sampleStdout);
  const productionSource = {
    id: "kric-train-operation-organ",
    displayName: "열차운영기관정보",
    owner: "국가철도공단",
    provider: "국가철도공단",
    sourceSystem: "KRIC OpenAPI",
    datasetUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266&service=convenientInfo&operation=trainOperationOrgan&page=3",
    requiredForProductionPack: false,
    updateFrequency: "provider-documented",
    observedDataUpdatedAt: "2026-07-02",
    retrievedAt: "2026-07-02",
    license: {
      type: "KOGL-1",
      name: "공공누리 1유형",
      attribution: "공공누리 제1유형: 출처표시",
      commercialUseAllowed: true,
      derivativeWorkAllowed: true,
      redistributionAllowed: true,
      evidenceUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266&service=convenientInfo&operation=trainOperationOrgan&page=3",
    },
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["seoul-metro"],
      sourceDomains: ["station_line_membership"],
    },
    fieldsProvided: ["railOprIsttCd", "railOprIsttNm"],
    capabilities: {
      schedule: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide scheduled timetable data",
      },
      realtime: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        liveEtaEligible: false,
        rateLimitStatus: "NOT_APPLICABLE",
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide realtime arrival data",
      },
      facility: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide accessibility facility records",
      },
    },
  };
  const adminReview = {
    schemaVersion: 1,
    artifactKind: "source-admission-admin-review",
    candidateId: "kric-train-operation-organ",
    sourceId: "kric-train-operation-organ",
    snapshotId: "kric-train-operation-organ-snapshot-20260702",
    sampleEvidenceHash: sample.evidenceHash,
    decision: "APPROVED",
    approvedBy: "qa-admin",
    approvedAt: "2026-07-02T00:10:00Z",
    licenseEvidenceHash: sha256("license-evidence"),
    aliasLedgerHash: sha256("alias-ledger"),
    operatorMappingLedgerHash: sha256("operator-mapping-ledger"),
    facilityEvidenceLedgerHash: sha256("facility-evidence-ledger"),
    routeEvidenceLedgerHash: sha256("route-evidence-ledger"),
    overrideHash: sha256("override-ledger"),
    quotaEvidence: {
      portal: "KRIC 레일포털",
      defaultDailyLimit: "unlimited",
      unlockStatus: "not_required",
      productionUseAllowed: true,
    },
    productionSource,
  };
  await writeFile(adminReviewPath, `${JSON.stringify(adminReview, null, 2)}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/run-source-admission-pipeline.mjs",
      "--candidates",
      candidatesPath,
      "--candidate",
      "kric-train-operation-organ",
      "--raw-input",
      rawPath,
      "--evidence-dir",
      outputDir,
      "--snapshot-id",
      "kric-train-operation-organ-snapshot-20260702",
      "--source-id",
      "kric-train-operation-organ",
      "--provider",
      "국가철도공단",
      "--retrieved-at",
      "2026-07-02T00:00:00Z",
      "--source-updated-at",
      "2026-07-02T00:00:00Z",
      "--raw-object-uri",
      "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
      "--freshness-expires-at",
      "2026-08-01T00:00:00Z",
      "--raw-retention-expires-at",
      "2026-10-01T00:00:00Z",
      "--admin-review",
      adminReviewPath,
      "--output-inventory",
      outputInventoryPath,
      "--output",
      summaryPath,
    ],
    { cwd: root },
  );

  assert.match(stdout, /source admission pipeline evidence written/);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  assert.equal(summary.artifactKind, "source-admission-pipeline-evidence");
  assert.equal(summary.candidateId, "kric-train-operation-organ");
  assert.match(summary.sourceSnapshotSetHash, /^[0-9a-f]{64}$/);
  assert.equal(summary.adminReviewRecordHash, sha256(JSON.stringify(sortJson(adminReview))));
  assert.equal(summary.licenseEvidenceHash, adminReview.licenseEvidenceHash);
  const outputInventory = JSON.parse(await readFile(outputInventoryPath, "utf8"));
  assert.ok(outputInventory.sources.some((source) => source.id === "kric-train-operation-organ"));

  const mismatchedAdminReview = JSON.parse(JSON.stringify(adminReview));
  mismatchedAdminReview.productionSource.admissionEvidence = {
    quotaEvidence: {
      portal: "KRIC 레일포털",
      defaultDailyLimit: "unlimited",
      unlockStatus: "not_required",
      productionUseAllowed: false,
    },
  };
  await writeFile(adminReviewPath, `${JSON.stringify(mismatchedAdminReview, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--source-updated-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-10-01T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.mismatched-quota.json"),
        "--output",
        path.join(outputDir, "admission-summary-mismatched-quota.json"),
      ],
      { cwd: root },
    ),
    /adminReview\.productionSource\.admissionEvidence\.quotaEvidence must match adminReview\.quotaEvidence/,
  );

  const unsanitizedAdminReview = JSON.parse(JSON.stringify(adminReview));
  unsanitizedAdminReview.quotaEvidence.providerAccountMemo = "local-only quota account detail";
  await writeFile(adminReviewPath, `${JSON.stringify(unsanitizedAdminReview, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--source-updated-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-10-01T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.unsanitized-quota.json"),
        "--output",
        path.join(outputDir, "admission-summary-unsanitized-quota.json"),
      ],
      { cwd: root },
    ),
    /adminReview\.quotaEvidence must include defaultDailyLimit, portal, productionUseAllowed, unlockStatus and only optional documentedMonthlyLimit, runtimeDailyHardLimit, runtimePerMinuteHardLimit, sharedQuotaStore/,
  );
});

test("source admission pipeline은 custom candidates를 최종 inventory 검증에 전달한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-candidates-${Date.now()}`);
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  const seedSamplePath = path.join(outputDir, "seed-sample.json");
  const candidatesPath = path.join(outputDir, "source-candidates.json");
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(rawPath, `${JSON.stringify([{ railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" }])}\n`);

  const { stdout: sampleStdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-source-candidate-sample-evidence.mjs",
      "--candidate",
      "kric-train-operation-organ",
      "--response",
      rawPath,
    ],
    { cwd: root },
  );
  await writeFile(seedSamplePath, sampleStdout);
  const sample = JSON.parse(sampleStdout);

  const stagedCandidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  resetCandidateForAdmissionTest(stagedCandidates, "kric-train-operation-organ");
  const tagoCandidate = stagedCandidates.candidates.find((entry) => entry.id === "molit-tago-subway-info");
  tagoCandidate.evidence.liveSampleEvidenceHash = sha256("staged-candidate-hash-mismatch");
  await writeFile(candidatesPath, `${JSON.stringify(stagedCandidates, null, 2)}\n`);

  const productionSource = {
    id: "kric-train-operation-organ",
    displayName: "열차운영기관정보",
    owner: "국가철도공단",
    provider: "국가철도공단",
    sourceSystem: "KRIC OpenAPI",
    datasetUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266&service=convenientInfo&operation=trainOperationOrgan&page=3",
    requiredForProductionPack: false,
    updateFrequency: "provider-documented",
    observedDataUpdatedAt: "2026-07-02",
    retrievedAt: "2026-07-02",
    license: {
      type: "KOGL-1",
      name: "공공누리 1유형",
      attribution: "공공누리 제1유형: 출처표시",
      commercialUseAllowed: true,
      derivativeWorkAllowed: true,
      redistributionAllowed: true,
      evidenceUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266&service=convenientInfo&operation=trainOperationOrgan&page=3",
    },
    coverageScope: {
      regionIds: ["capital"],
      operatorIds: ["seoul-metro"],
      sourceDomains: ["station_line_membership"],
    },
    fieldsProvided: ["railOprIsttCd", "railOprIsttNm"],
    capabilities: {
      schedule: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide scheduled timetable data",
      },
      realtime: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        liveEtaEligible: false,
        rateLimitStatus: "NOT_APPLICABLE",
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide realtime arrival data",
      },
      facility: {
        status: "UNSUPPORTED",
        productionUseAllowed: false,
        coverageStatus: "NOT_PROVIDED_BY_SOURCE",
        updateFrequency: "provider-documented",
        unsupportedNotes: "candidate does not provide accessibility facility records",
      },
    },
  };
  const adminReview = {
    schemaVersion: 1,
    artifactKind: "source-admission-admin-review",
    candidateId: "kric-train-operation-organ",
    sourceId: "kric-train-operation-organ",
    snapshotId: "kric-train-operation-organ-snapshot-20260702",
    sampleEvidenceHash: sample.evidenceHash,
    decision: "APPROVED",
    approvedBy: "qa-admin",
    approvedAt: "2026-07-02T00:10:00Z",
    licenseEvidenceHash: sha256("license-evidence"),
    aliasLedgerHash: sha256("alias-ledger"),
    operatorMappingLedgerHash: sha256("operator-mapping-ledger"),
    facilityEvidenceLedgerHash: sha256("facility-evidence-ledger"),
    routeEvidenceLedgerHash: sha256("route-evidence-ledger"),
    overrideHash: sha256("override-ledger"),
    quotaEvidence: {
      portal: "KRIC 레일포털",
      defaultDailyLimit: "unlimited",
      unlockStatus: "not_required",
      productionUseAllowed: true,
    },
    productionSource,
  };
  await writeFile(adminReviewPath, `${JSON.stringify(adminReview, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidates",
        candidatesPath,
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--source-updated-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-10-01T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.admitted.json"),
        "--output",
        path.join(outputDir, "admission-summary.json"),
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.admissionEvidence\.sampleEvidenceHash must be/,
  );
});

test("source inventory 검증기는 admitted candidate의 quota evidence 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-quota-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const promotedInventoryPath = path.join(outputDir, "source-inventory.quota-blocked-production.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const source = inventory.sources.find((entry) => entry.id === "seoul-realtime-arrival-station-info");
  delete source.admissionEvidence.quotaEvidence;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        inventoryPath,
      ],
      { cwd: root },
    ),
    /seoul-realtime-arrival-station-info\.admissionEvidence\.quotaEvidence must be an object/,
  );

  const promotedInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const promotedSource = promotedInventory.sources.find((entry) => entry.id === "molit-tago-subway-info");
  promotedSource.capabilities.schedule.status = "SUPPORTED";
  promotedSource.capabilities.schedule.productionUseAllowed = true;
  await writeFile(promotedInventoryPath, `${JSON.stringify(promotedInventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-source-inventory.mjs",
        "--inventory",
        promotedInventoryPath,
      ],
      { cwd: root },
    ),
    /molit-tago-subway-info\.admissionEvidence\.quotaEvidence\.productionUseAllowed must be true when source has production capability/,
  );
});

test("source inventory 검증기는 같은 shared quota store의 hard limit 불일치를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-shared-quota-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const trainPosition = inventory.sources.find((entry) => entry.id === "seoul-topis-realtime-train-position");
  trainPosition.admissionEvidence.quotaEvidence.runtimeDailyHardLimit = 799;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath],
      { cwd: root },
    ),
    /shared quota store realtime_provider_call_quota_state must use identical runtime hard limits/,
  );
});

test("source inventory 검증기는 guarded realtime quota의 shared store 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-guarded-quota-store-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const arrival = inventory.sources.find((entry) => entry.id === "seoul-realtime-arrival-station-info");
  delete arrival.admissionEvidence.quotaEvidence.sharedQuotaStore;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-source-inventory.mjs", "--inventory", inventoryPath],
      { cwd: root },
    ),
    /seoul-realtime-arrival-station-info\.guarded realtime requires sharedQuotaStore/,
  );
});

test("source admission pipeline은 JSON credential raw response를 저장 전에 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-secret-${Date.now()}`);
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(rawPath, JSON.stringify({ response: { body: { serviceKey: "actual-secret" } } }));
  await writeFile(
    adminReviewPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "source-admission-admin-review",
        decision: "APPROVED",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-10-01T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.admitted.json"),
        "--output",
        path.join(outputDir, "admission-summary.json"),
      ],
      { cwd: root },
    ),
    /source admission raw response contains credential-like token/,
  );
});

test("source admission pipeline은 live fetch 실패 메시지에서 service key를 숨긴다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-fetch-secret-${Date.now()}`);
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    adminReviewPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "source-admission-admin-review",
        decision: "APPROVED",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--url-template",
        "http://127.0.0.1:1/source?serviceKey={serviceKey}",
        "--service-key-env",
        "EASYSUBWAY_TEST_SERVICE_KEY",
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-10-01T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.admitted.json"),
        "--output",
        path.join(outputDir, "admission-summary.json"),
      ],
      { cwd: root, env: { ...process.env, EASYSUBWAY_TEST_SERVICE_KEY: "actual-secret-value" } },
    ),
    (error) => {
      assert.match(error.stderr, /source live fetch failed before response/);
      assert.doesNotMatch(error.stderr, /actual-secret-value/);
      return true;
    },
  );
});

test("source admission pipeline은 admin 승인 없는 inventory admission을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-admission-negative-${Date.now()}`);
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(rawPath, `${JSON.stringify([{ railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" }])}\n`);
  await writeFile(
    adminReviewPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "source-admission-admin-review",
        candidateId: "kric-train-operation-organ",
        sourceId: "kric-train-operation-organ",
        snapshotId: "kric-train-operation-organ-snapshot-20260702",
        sampleEvidenceHash: sha256("not-used"),
        decision: "PENDING",
        approvedBy: "qa-admin",
        approvedAt: "2026-07-02T00:10:00Z",
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/run-source-admission-pipeline.mjs",
        "--candidate",
        "kric-train-operation-organ",
        "--raw-input",
        rawPath,
        "--evidence-dir",
        outputDir,
        "--snapshot-id",
        "kric-train-operation-organ-snapshot-20260702",
        "--source-id",
        "kric-train-operation-organ",
        "--provider",
        "국가철도공단",
        "--retrieved-at",
        "2026-07-02T00:00:00Z",
        "--raw-object-uri",
        "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
        "--freshness-expires-at",
        "2026-08-01T00:00:00Z",
        "--raw-retention-expires-at",
        "2026-10-01T00:00:00Z",
        "--admin-review",
        adminReviewPath,
        "--output-inventory",
        path.join(outputDir, "source-inventory.admitted.json"),
        "--output",
        path.join(outputDir, "admission-summary.json"),
      ],
      { cwd: root },
    ),
    /adminReview\.decision must be APPROVED/,
  );
});

test("전국 coverage target은 공식 snapshot의 현재 catalog 노선과 정확히 일치한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-target-lines-${Date.now()}`);
  const fixturePath = path.join(outputDir, "nationwide-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-molit-nationwide-fixture.mjs",
      "--csv", "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
      "--svg-csv", "tools/datapack/sources/molit-rail-station-svg-route-20250811.csv",
      "--seoulmetro-js", "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js",
      "--humetro-html", "tools/datapack/sources/humetro-cyberstation-map-20260623.html",
      "--humetro-css", "tools/datapack/sources/humetro-cyber-station-20250310c.css",
      "--grtc-html", "tools/datapack/sources/grtc-cyber-simple-20260623.html",
      "--dtro-html", "tools/datapack/sources/dtro-cyberstation-20260623.html",
      "--djtc-html", "tools/datapack/sources/djtc-cyberstation-20260623.html",
      "--djtc-css", "tools/datapack/sources/djtc-content-20260623.css",
      "--output", fixturePath,
    ],
    { cwd: root },
  );

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const compareCoverageLineScopes = (left, right) =>
    `${left.regionId}:${left.operatorId}:${left.lineId}`.localeCompare(
      `${right.regionId}:${right.operatorId}:${right.lineId}`,
    );
  assert.ok(Array.isArray(fixture.coverageLineOperatorScopes));
  assert.equal(fixture.coverageLineOperatorScopeSemantics, "UNION_OF_PACK_SCOPES");
  const packScopeUnion = [...new Map(
    fixture.packs
      .flatMap((pack) => pack.coverageLineOperatorScopes ?? [])
      .map((scope) => [`${scope.regionId}:${scope.operatorId}:${scope.lineId}`, scope]),
  ).values()].sort(compareCoverageLineScopes);
  assert.deepEqual(fixture.coverageLineOperatorScopes, packScopeUnion);
  assert.deepEqual(targets.inactiveLineExclusions, [
    {
      lineId: "line-cbe75f5287a1",
      status: "OUT_OF_ACTIVE_SCOPE",
      serviceLifecycle: "RETIRED",
      effectiveFrom: "2025-10-17",
      verifiedAt: "2026-07-13T00:00:00.000Z",
      reasonKo: "인천공항 자기부상철도는 도시철도 폐업 후 전용궤도시설로 전환되어 ACTIVE 도시철도 coverage 분모에서 제외한다.",
      evidenceRef: "source:incheon-maglev-track-facility-20251017",
    },
  ]);
  assert.deepEqual(targets.evidenceSources, [
    {
      id: "incheon-maglev-track-facility-20251017",
      publisher: "인천광역시",
      title: "3년의 멈춤을 넘어, 다시 달리는 인천공항 자기부상열차",
      publishedAt: "2025-10-17",
      url: "https://www.incheon.go.kr/IC010205/view?repSeq=DOM_0000000013303245",
    },
  ]);
  const inactiveLineIds = new Set(targets.inactiveLineExclusions.map(({ lineId }) => lineId));
  const expected = packScopeUnion
    .filter(({ lineId }) => !inactiveLineIds.has(lineId))
    .map(({ lineId, operatorId, regionId }) => ({ lineId, operatorId, regionId }))
    .sort(compareCoverageLineScopes);
  assert.equal(targets.schemaVersion, 2);
  assert.deepEqual(targets.railProductScope, {
    routeMapAndRouting: [
      {
        serviceId: "GTX_A",
        lineId: "line-8604048b6430",
        servicePattern: "LOCAL",
        representation: "ACTIVE_CAPITAL_LINE",
      },
      {
        serviceId: "ITX_CHEONGCHUN",
        lineId: "line-54a7b980b7c3",
        servicePattern: "EXPRESS",
        representation: "SERVICE_PATTERN_ON_EXISTING_LINE",
        operatingRoute: "GYEONGCHUN_LINE_ONLY",
        legacyDaejeonData: "REJECT",
        metropolitanRouteSearchCoverage: "CANONICAL_OD_STATIONS_IN_CAPITAL_METROPOLITAN_NETWORK",
        coverageContract: "tools/datapack/itx-cheongchun-coverage-contract.json",
        coverageStates: {
          station_line_membership: "SUPPORTED",
          route_graph_topology: "MISSING",
          schedule_timetable: "MISSING",
        },
        supportClaimAllowed: false,
      },
    ],
    trainSearchOnly: {
      trackingIssue: 2094,
      routeMapProvided: false,
      services: ["KTX", "KTX_SANCHEON", "SRT", "ITX_MAUM", "ITX_SAEMAEUL", "SAEMAEUL", "MUGUNGHWA", "NURIRO"],
    },
  });
  assert.ok(Array.isArray(targets.activeLineScopes));
  const actual = targets.activeLineScopes
    .map(({ lineId, operatorId, regionId }) => ({ lineId, operatorId, regionId }))
    .sort(compareCoverageLineScopes);

  assert.ok(actual.every(({ lineId }) => !inactiveLineIds.has(lineId)));
  assert.equal(new Set(actual.map(({ lineId }) => lineId)).size, 36);
  assert.equal(actual.length, 45);
  assert.deepEqual(actual, expected);
});

test("전국 coverage target은 train-search-only 열차를 route scope에 섞으면 거부한다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-rail-product-scope-"));
  const targetsPath = path.join(outputDir, "targets.json");
  const reportPath = path.join(outputDir, "report.json");
  const targets = JSON.parse(await readFile("tools/datapack/nationwide-coverage-targets.json", "utf8"));
  targets.railProductScope.routeMapAndRouting.push({
    serviceId: "KTX",
    lineId: "line-54a7b980b7c3",
    servicePattern: "EXPRESS",
    representation: "SERVICE_PATTERN_ON_EXISTING_LINE",
  });
  await writeFile(targetsPath, `${JSON.stringify(targets, null, 2)}\n`);

  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets", targetsPath,
    "--inventory", "tools/datapack/source-inventory.json",
    "--output", reportPath,
    "--allow-gaps",
  ], { cwd: root }), /routeMapAndRouting must contain GTX-A and ITX-청춘 only/);
});

test("데이터팩 생성기는 top-level 노선 scope를 여러 pack scope의 합집합으로 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-scope-union-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const scope = { regionId: "capital", operatorId: "seoul-metro", lineId: "seoul-4" };
  fixture.coverageLineOperatorScopeSemantics = "UNION_OF_PACK_SCOPES";
  fixture.coverageLineOperatorScopes = [scope];
  fixture.packs[0].coverageLineOperatorScopes = [scope];
  const secondPack = structuredClone(fixture.packs[0]);
  secondPack.id = "capital-copy";
  secondPack.version = "2";
  secondPack.url = "catalog/capital-copy-v2.sqlite.gz";
  fixture.packs.push(secondPack);
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root },
  );

  const manifest = JSON.parse(await readFile(path.join(packOutputDir, "current.json"), "utf8"));
  assert.deepEqual(manifest.packs.map(({ id }) => id), ["capital", "capital-copy"]);
});

test("데이터팩 생성기는 Unicode 정규화 형태가 다른 operator scope 집합을 순서와 무관하게 비교한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-scope-unicode-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root },
  );
});

test("전국 coverage report는 운행 노선 launch와 enhancement 분모를 분리한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-tier-report-${Date.now()}`);
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", "tools/datapack/source-inventory.json",
      "--output", reportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.summary.scope, { activeLineCount: 36, activeLineOperatorScopeCount: 45 });
  assert.equal(report.summary.launchRequiredCompletionRatio, 0);
  assert.equal(report.summary.enhancementProgressRatio, 0);
  assert.equal(report.summary.activeScopeCount, 45);
  assert.equal(report.summary.plannedScopeCount, 0);
  assert.equal(report.summary.launchRequired.totalCount, 270);
  assert.equal(report.summary.launchRequired.supportedCount, 0);
  assert.equal(report.summary.launchRequired.missingCount, 270);
  assert.equal(report.summary.launchRequired.completionReady, false);
  assert.equal(report.summary.enhancement.totalCount, 45);
  assert.equal(report.summary.enhancement.supportedCount, 0);
  assert.ok(report.requirements.every(({ lineId }) => typeof lineId === "string" && lineId.length > 0));
  assert.ok(report.requirements.every(({ serviceLifecycle }) => serviceLifecycle === "ACTIVE"));
  assert.ok(report.requirements.every(({ effectiveFrom }) => effectiveFrom === "2026-04-02"));
  assert.ok(report.requirements.every(({ verifiedAt }) => verifiedAt === "2026-07-13T00:00:00.000Z"));
  assert.ok(report.requirements.every(({ evidenceRef }) => evidenceRef === "source:molit-urban-rail-full-route"));
});

function coverageResolutionSearchPlan(entry, publicApiQueries) {
  return {
    schemaVersion: 1,
    artifactKind: "nationwide-public-api-coverage-search-plan",
    targetVersion: "2026-07-13",
    entries: [{
      regionId: entry.regionId,
      operatorId: entry.operatorId,
      lineId: entry.lineId,
      sourceDomain: entry.sourceDomain,
      fallback: entry.fallback,
      userMessageKo: entry.userMessageKo,
      queries: publicApiQueries.map(({ providerId, endpoint, operation, query, matchAnyTerms, matchTermGroups, captureFields }) => ({
        providerId,
        endpoint,
        operation,
        query,
        ...(matchAnyTerms ? { matchAnyTerms } : {}),
        ...(matchTermGroups ? { matchTermGroups } : {}),
        ...(captureFields ? { captureFields } : {}),
      })),
    }],
  };
}

test("전국 coverage report는 공공기관 API 실제 부재만 공식 미지원 terminal 상태로 집계한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-resolution-${Date.now()}`);
  const resolutionsPath = path.join(outputDir, "nationwide-coverage-resolutions.json");
  const resolutionPlanPath = path.join(outputDir, "nationwide-coverage-search-plan.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const publicApiQueries = [{
    providerId: "kric",
    endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable",
    operation: "subwayTimetable",
    query: { railOprIsttCd: "B1", lnCd: "1" },
    httpStatus: 200,
    providerResultCode: "00",
    schemaStatus: "EXPECTED",
    matchCount: 0,
    responseSha256: "a".repeat(64),
  }];
  const resolutionEntry = {
    regionId: "busan",
    operatorId: "busan-transportation",
    lineId: "line-ab1a041f6266",
    sourceDomain: "schedule_timetable",
    state: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
    reasonCode: "PUBLIC_API_NO_DATA",
    userMessageKo: "공공기관 API에서 시간표 데이터를 제공하지 않습니다.",
    fallback: "STATIC_LOCAL",
    checkedAt: "2026-07-13T00:00:00.000Z",
    reviewedAt: "2026-07-13T00:00:00.000Z",
    reviewerRole: "DATA_STEWARD",
    nextReviewAt: "2099-07-13T00:00:00.000Z",
    requiredProviderIds: ["kric"],
    publicApiQueries,
    evidenceHash: sha256(JSON.stringify(publicApiQueries)),
  };
  const resolutionPlan = coverageResolutionSearchPlan(resolutionEntry, publicApiQueries);
  await writeFile(resolutionPlanPath, `${JSON.stringify(resolutionPlan, null, 2)}\n`);
  await writeFile(resolutionsPath, `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "nationwide-coverage-resolutions",
    targetVersion: "2026-07-13",
    searchPlanSha256: sha256(JSON.stringify(resolutionPlan)),
    entries: [resolutionEntry],
  }, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", "tools/datapack/source-inventory.json",
      "--resolutions", resolutionsPath,
      "--resolution-plan", resolutionPlanPath,
      "--output", reportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const requirement = report.requirements.find((entry) =>
    entry.regionId === "busan" &&
    entry.operatorId === "busan-transportation" &&
    entry.lineId === "line-ab1a041f6266" &&
    entry.sourceDomain === "schedule_timetable");
  assert.equal(requirement.status, "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE");
  assert.equal(requirement.capabilityFallback, "STATIC_LOCAL");
  assert.equal(report.summary.launchRequired.supportedCount, 0);
  assert.equal(report.summary.launchRequired.explicitlyUnsupportedCount, 1);
  assert.equal(report.summary.launchRequired.missingCount, 269);
  assert.equal(report.summary.launchRequired.supportedRatio, 0);
  assert.equal(report.summary.launchRequired.terminalResolutionRatio, Number((1 / 270).toFixed(4)));
  assert.equal(report.summary.launchRequired.completionReady, false);
  assert.deepEqual(report.transitions, [{
    requirementKey: "busan:busan-transportation:line-ab1a041f6266:schedule_timetable",
    before: "MISSING",
    after: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
    reasonCode: "PUBLIC_API_NO_DATA",
    evidenceHash: sha256(JSON.stringify(publicApiQueries)),
    reviewedAt: "2026-07-13T00:00:00.000Z",
  }]);
});

test("전국 coverage report는 불완전하거나 만료된 공공 API 미지원 evidence를 fail closed한다", async (context) => {
  const publicApiQueries = [{
    providerId: "kric",
    endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable",
    operation: "subwayTimetable",
    query: { railOprIsttCd: "B1", lnCd: "1" },
    httpStatus: 200,
    providerResultCode: "00",
    schemaStatus: "EXPECTED",
    matchCount: 0,
    responseSha256: "b".repeat(64),
  }];
  const baseEntry = {
    regionId: "busan",
    operatorId: "busan-transportation",
    lineId: "line-ab1a041f6266",
    sourceDomain: "schedule_timetable",
    state: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
    reasonCode: "PUBLIC_API_NO_DATA",
    userMessageKo: "공공기관 API에서 시간표 데이터를 제공하지 않습니다.",
    fallback: "STATIC_LOCAL",
    checkedAt: "2026-07-13T00:00:00.000Z",
    reviewedAt: "2026-07-13T00:00:00.000Z",
    reviewerRole: "DATA_STEWARD",
    nextReviewAt: "2099-07-13T00:00:00.000Z",
    requiredProviderIds: ["kric"],
    publicApiQueries,
    evidenceHash: sha256(JSON.stringify(publicApiQueries)),
  };
  const resolutionPlan = coverageResolutionSearchPlan(baseEntry, publicApiQueries);
  const cases = [
    ["duplicate", [baseEntry, baseEntry], /duplicate coverage resolution/],
    ["unknown key", [{ ...baseEntry, lineId: "unknown-line" }], /unknown coverage resolution requirement/],
    ["unknown state", [{ ...baseEntry, state: "UNSUPPORTED" }], /coverage resolution state is invalid/],
    ["non-public endpoint", [{
      ...baseEntry,
      publicApiQueries: [{ ...publicApiQueries[0], endpoint: "https://example.com/blog" }],
      evidenceHash: sha256(JSON.stringify([{ ...publicApiQueries[0], endpoint: "https://example.com/blog" }])),
    }], /public API origin is not allowed/],
    ["credential query endpoint", [{
      ...baseEntry,
      publicApiQueries: [{ ...publicApiQueries[0], endpoint: `${publicApiQueries[0].endpoint}?serviceKey=secret` }],
      evidenceHash: sha256(JSON.stringify([{
        ...publicApiQueries[0], endpoint: `${publicApiQueries[0].endpoint}?serviceKey=secret`,
      }])),
    }], /endpoint must not contain credentials/],
    ["provider failure", [{
      ...baseEntry,
      publicApiQueries: [{ ...publicApiQueries[0], providerResultCode: "99" }],
      evidenceHash: sha256(JSON.stringify([{ ...publicApiQueries[0], providerResultCode: "99" }])),
    }], /providerResultCode must be 00/],
    ["schema mismatch", [{
      ...baseEntry,
      publicApiQueries: [{ ...publicApiQueries[0], schemaStatus: "MISMATCH" }],
      evidenceHash: sha256(JSON.stringify([{ ...publicApiQueries[0], schemaStatus: "MISMATCH" }])),
    }], /schemaStatus must be EXPECTED/],
    ["different line query", [{
      ...baseEntry,
      publicApiQueries: [{ ...publicApiQueries[0], query: { railOprIsttCd: "B1", lnCd: "2" } }],
      evidenceHash: sha256(JSON.stringify([{
        ...publicApiQueries[0], query: { railOprIsttCd: "B1", lnCd: "2" },
      }])),
    }], /search plan query mismatch/],
  ];

  for (const [label, entries, expected] of cases) {
    await context.test(label, async () => {
      const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-coverage-resolution-invalid-"));
      const resolutionsPath = path.join(outputDir, "resolutions.json");
      const resolutionPlanPath = path.join(outputDir, "resolution-plan.json");
      await writeFile(resolutionPlanPath, `${JSON.stringify(resolutionPlan)}\n`);
      await writeFile(resolutionsPath, `${JSON.stringify({
        schemaVersion: 1,
        artifactKind: "nationwide-coverage-resolutions",
        targetVersion: "2026-07-13",
        searchPlanSha256: sha256(JSON.stringify(resolutionPlan)),
        entries,
      })}\n`);
      await assert.rejects(execFileAsync(
        process.execPath,
        [
          "tools/datapack/report-coverage-gaps.mjs",
          "--targets", "tools/datapack/nationwide-coverage-targets.json",
          "--inventory", "tools/datapack/source-inventory.json",
          "--resolutions", resolutionsPath,
          "--resolution-plan", resolutionPlanPath,
          "--output", path.join(outputDir, "report.json"),
          "--allow-gaps",
        ],
        { cwd: root },
      ), expected);
    });
  }

  await context.test("expired evidence returns to MISSING", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-coverage-resolution-expired-"));
    const resolutionsPath = path.join(outputDir, "resolutions.json");
    const resolutionPlanPath = path.join(outputDir, "resolution-plan.json");
    const reportPath = path.join(outputDir, "report.json");
    await writeFile(resolutionPlanPath, `${JSON.stringify(resolutionPlan)}\n`);
    await writeFile(resolutionsPath, `${JSON.stringify({
      schemaVersion: 1,
      artifactKind: "nationwide-coverage-resolutions",
      targetVersion: "2026-07-13",
      searchPlanSha256: sha256(JSON.stringify(resolutionPlan)),
      entries: [{ ...baseEntry, nextReviewAt: "2026-07-12T00:00:00.000Z" }],
    })}\n`);
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", "tools/datapack/source-inventory.json",
        "--resolutions", resolutionsPath,
        "--resolution-plan", resolutionPlanPath,
        "--output", reportPath,
        "--allow-gaps",
      ],
      { cwd: root },
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const requirement = report.requirements.find((entry) =>
      entry.regionId === baseEntry.regionId &&
      entry.operatorId === baseEntry.operatorId &&
      entry.lineId === baseEntry.lineId &&
      entry.sourceDomain === baseEntry.sourceDomain);
    assert.equal(requirement.status, "MISSING");
    assert.equal(requirement.resolutionReviewStatus, "EXPIRED");
  });
});

test("전국 coverage v2는 파일 경로를 공식 evidenceRef로 허용하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-invalid-evidence-ref-${Date.now()}`);
  const targetsPath = path.join(outputDir, "nationwide-coverage-targets.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  targets.inactiveLineExclusions[0].evidenceRef = "tools/route-map/route-map-single-source.test.mjs";
  await writeFile(targetsPath, `${JSON.stringify(targets, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", targetsPath,
        "--inventory", "tools/datapack/source-inventory.json",
        "--output", reportPath,
        "--allow-gaps",
      ],
      { cwd: root },
    ),
    /inactiveLineExclusions\.evidenceRef must use source:<id>/,
  );
});

test("전국 coverage v2는 LAUNCH_REQUIRED domain이 없는 target을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-no-launch-domain-${Date.now()}`);
  const targetsPath = path.join(outputDir, "nationwide-coverage-targets.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  for (const domain of targets.requiredSourceDomains) {
    domain.releaseTier = "ENHANCEMENT";
  }
  await writeFile(targetsPath, `${JSON.stringify(targets, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", targetsPath,
        "--inventory", "tools/datapack/source-inventory.json",
        "--output", reportPath,
        "--allow-gaps",
      ],
      { cwd: root },
    ),
    /schemaVersion 2 targets must include at least one LAUNCH_REQUIRED domain/,
  );
});

test("전국 coverage v2는 line-scoped inventory만으로 지원 완료를 선언하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-provenance-required-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  await writeFile(inventoryPath, `${JSON.stringify(completeCoverageInventory(targets), null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /nationwide coverage gaps remain/,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.launchRequired.supportedCount, 0);
  assert.equal(report.summary.launchRequired.missingCount, report.summary.launchRequired.totalCount);
});

test("전국 coverage gap report는 현재 source inventory의 누락 coverage를 실패로 노출한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-fail-${Date.now()}`);
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/nationwide-coverage-targets.json",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--output",
        reportPath,
      ],
      { cwd: root },
    ),
    /nationwide coverage gaps remain/,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.artifactKind, "nationwide-coverage-gap-report");
  assert.equal(report.summary.coverageComplete, false);
  assert.ok(report.summary.missingRequirements > 0);
});

test("전국 coverage gap report는 allow-gaps 모드에서 감사 가능한 report를 생성한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-report-${Date.now()}`);
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--output",
      reportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.coverageComplete, false);
  assert.equal(report.summary.coveredRequirements, 0);
  assert.ok(report.requirements.every((entry) => entry.status === "MISSING"));
  assert.ok(report.requirements.every((entry) => Array.isArray(entry.sourceIds)));
});

test("전국 coverage gap report는 operator-wide source를 노선 coverage로 승격하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-official-source-${Date.now()}`);
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--output",
      reportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.totalRequirements, 270);
  assert.equal(report.summary.coveredRequirements, 0);
  assert.equal(report.summary.missingRequirements, 270);

  const busanStationMembership = report.requirements.find(
    (entry) =>
      entry.regionId === "busan" &&
      entry.operatorId === "busan-transportation" &&
      entry.lineId === "line-ab1a041f6266" &&
      entry.sourceDomain === "station_line_membership",
  );
  assert.deepEqual(busanStationMembership?.sourceIds, []);
  assert.deepEqual(busanStationMembership?.missingFields, ["line", "station_name", "station_code"]);

  const capitalAccessibilityFacilities = report.requirements.find(
    (entry) =>
      entry.regionId === "capital" &&
      entry.operatorId === "seoul-metro" &&
      entry.lineId === "seoul-4" &&
      entry.sourceDomain === "accessibility_facilities",
  );
  assert.deepEqual(capitalAccessibilityFacilities?.sourceIds, []);
  assert.deepEqual(capitalAccessibilityFacilities?.missingFields, [
    "elevator",
    "escalator",
    "wheelchair_lift",
    "status",
    "verified_at",
  ]);
});

test("전국 coverage gap report는 targets에 없는 coverageScope domain을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-invalid-domain-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  inventory.sources[0].coverageScope.sourceDomains = ["unknown_domain"];
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/nationwide-coverage-targets.json",
        "--inventory",
        inventoryPath,
        "--output",
        reportPath,
        "--allow-gaps",
      ],
      { cwd: root },
    ),
    /undefined source domain: unknown_domain/,
  );
});

test("전국 coverage gap report는 target coverage가 모두 충족되면 성공한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-complete-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, completeCoverageProvenance(inventory));

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      inventoryPath,
      "--manifest",
      path.join(outputDir, "current.json"),
      "--provenance",
      provenancePath,
      "--output",
      reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.coverageComplete, true);
  assert.equal(report.summary.missingRequirements, 0);
  assert.equal(report.summary.coverageRatio, 1);
});

test("전국 coverage gap report는 여러 노선과 운영기관을 곱집합으로 해석할 provenance를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-ambiguous-pair-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const provenance = completeCoverageProvenance(inventory);
  provenance.packs[0].records[0].coverageScope = {
    ...provenance.packs[0].records[0].coverageScope,
    operatorIds: ["seoul-metro", "korail"],
    lineIds: ["seoul-4", "line-31e4cf10b52b"],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, provenance);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", path.join(outputDir, "current.json"),
        "--provenance", provenancePath,
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /line-scoped field provenance must identify exactly one operator-line pair/,
  );
});

test("전국 coverage gap report는 inactive 노선 source metadata를 허용하되 출시 분모에서 제외한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-inactive-line-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = {
    schemaVersion: 1,
    retrievedAt: "2026-07-13",
    sources: [
      {
        id: "inactive-maglev-metadata",
        coverageScope: {
          regionIds: ["capital"],
          operatorIds: ["airport-railroad"],
          lineIds: ["line-cbe75f5287a1"],
          sourceDomains: ["station_line_membership"],
        },
        fieldsProvided: ["line", "station_name", "station_code"],
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", inventoryPath,
      "--output", reportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.scope.activeLineCount, 36);
  assert.ok(report.requirements.every(({ lineId }) => lineId !== "line-cbe75f5287a1"));
});

test("전국 coverage gap report는 candidate field provenance와 manifest hash를 evidence로 결합한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-provenance-complete-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, completeCoverageProvenance(inventory));

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      inventoryPath,
      "--manifest",
      path.join(outputDir, "current.json"),
      "--provenance",
      provenancePath,
      "--output",
      reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.coverageComplete, true);
  assert.equal(
    report.candidate.manifestSha256,
    sha256(await readFile(path.join(outputDir, "current.json"))),
  );
  assert.deepEqual(report.candidate.packs.map(({ id, version, sqliteSha256 }) => ({ id, version, sqliteSha256 })), [
    { id: "nationwide", version: "1", sqliteSha256: "b".repeat(64) },
  ]);
  assert.ok(report.requirements.every((entry) => entry.fieldCoverage.every((field) => field.status === "covered")));
});

test("전국 coverage gap report는 provenance를 현재 manifest bytes에 결합한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-manifest-binding-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const manifestPath = path.join(outputDir, "current.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const provenance = completeCoverageProvenance(inventory);
  const manifestJson = `${JSON.stringify({
    activePack: { id: "nationwide", version: "1" },
    packs: [{ id: "nationwide", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) }],
  }, null, 2)}\n`;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(manifestPath, manifestJson);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", manifestPath,
        "--provenance", provenancePath,
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /field provenance manifestSha256 does not match --manifest/,
  );
});

test("전국 coverage gap report는 fixture manifest를 production provenance로 승격하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-artifact-kind-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const manifestPath = path.join(outputDir, "current.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const provenance = completeCoverageProvenance(inventory);
  const manifestJson = `${JSON.stringify({
    activePack: { id: "nationwide", version: "1" },
    packs: [{ id: "nationwide", version: "1", artifactKind: "fixture", sqliteSha256: "b".repeat(64) }],
  }, null, 2)}\n`;
  provenance.manifestSha256 = sha256(Buffer.from(manifestJson));
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(manifestPath, manifestJson);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", manifestPath,
        "--provenance", provenancePath,
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /field provenance artifactKind does not match --manifest/,
  );
});

test("전국 coverage gap report는 실제 active pack 밖 dependency provenance를 집계하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-active-closure-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const manifestPath = path.join(outputDir, "current.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const records = completeCoverageProvenance(inventory).packs[0].records;
  const manifest = {
    activePack: { id: "active", version: "1" },
    packs: [
      {
        id: "active",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "a".repeat(64),
        dependencies: [{ id: "dependency", version: "1" }],
      },
      { id: "dependency", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) },
      { id: "inactive", version: "1", artifactKind: "production", sqliteSha256: "c".repeat(64) },
    ],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const provenance = {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: sha256(Buffer.from(manifestJson)),
    packs: [
      {
        id: "active",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "a".repeat(64),
        records: [],
      },
      {
        id: "dependency",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "b".repeat(64),
        records,
      },
      {
        id: "inactive",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "c".repeat(64),
        records: [],
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(manifestPath, manifestJson);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", manifestPath,
        "--provenance", provenancePath,
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /nationwide coverage gaps remain: 270 missing requirements/,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.candidate.packs.map(({ id }) => id), ["active"]);
});

test("전국 coverage gap report는 emergency override pack의 provenance를 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-emergency-override-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const manifestPath = path.join(outputDir, "current.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const records = completeCoverageProvenance(inventory).packs[0].records;
  const manifest = {
    activePack: { id: "active", version: "1" },
    emergencyOverride: { id: "override", version: "1", reason: "긴급 안전 보정" },
    packs: [
      { id: "active", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64) },
      { id: "override", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) },
    ],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const provenance = {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: sha256(Buffer.from(manifestJson)),
    packs: [
      {
        id: "active",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "a".repeat(64),
        records,
      },
      {
        id: "override",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "b".repeat(64),
        records: [],
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(manifestPath, manifestJson);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", manifestPath,
        "--provenance", provenancePath,
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /nationwide coverage gaps remain: 270 missing requirements/,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.candidate.packs.map(({ id }) => id), ["active", "override"]);
});

test("전국 coverage gap report는 emergency override 실패 시 fallback active pack provenance도 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-emergency-fallback-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const manifestPath = path.join(outputDir, "current.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const records = completeCoverageProvenance(inventory).packs[0].records;
  const manifest = {
    activePack: { id: "active", version: "1" },
    emergencyOverride: { id: "override", version: "1", reason: "긴급 안전 보정" },
    packs: [
      { id: "active", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64) },
      { id: "override", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) },
    ],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const provenance = {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: sha256(Buffer.from(manifestJson)),
    packs: [
      {
        id: "active",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "a".repeat(64),
        records: [],
      },
      {
        id: "override",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "b".repeat(64),
        records,
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(manifestPath, manifestJson);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", manifestPath,
        "--provenance", provenancePath,
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /nationwide coverage gaps remain: 270 missing requirements/,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.candidate.packs.map(({ id }) => id), ["active", "override"]);
});

test("전국 coverage gap report는 activePack 생략 시 기본 capital pack을 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-default-active-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const manifestPath = path.join(outputDir, "current.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const records = completeCoverageProvenance(inventory).packs[0].records;
  const manifest = {
    packs: [
      { id: "capital", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64) },
      { id: "inactive", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) },
    ],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const provenance = {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: sha256(Buffer.from(manifestJson)),
    packs: [
      {
        id: "capital",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "a".repeat(64),
        records,
      },
      {
        id: "inactive",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "b".repeat(64),
        records: [],
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(manifestPath, manifestJson);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", inventoryPath,
      "--manifest", manifestPath,
      "--provenance", provenancePath,
      "--output", reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.coverageComplete, true);
  assert.deepEqual(report.candidate.packs.map(({ id }) => id), ["capital"]);
});

test("전국 coverage gap report는 safe integer를 넘는 기본 capital pack 버전을 정확히 비교한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-large-default-version-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const manifestPath = path.join(outputDir, "current.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const records = completeCoverageProvenance(inventory).packs[0].records;
  const oldVersion = "9007199254740992";
  const newVersion = "9007199254740993";
  const manifest = {
    packs: [
      { id: "capital", version: oldVersion, artifactKind: "production", sqliteSha256: "a".repeat(64) },
      { id: "capital", version: newVersion, artifactKind: "production", sqliteSha256: "b".repeat(64) },
    ],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const provenance = {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: sha256(Buffer.from(manifestJson)),
    packs: [
      {
        ...manifest.packs[0],
        records: [],
      },
      {
        ...manifest.packs[1],
        records,
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(manifestPath, manifestJson);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", inventoryPath,
      "--manifest", manifestPath,
      "--provenance", provenancePath,
      "--output", reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.coverageComplete, true);
  assert.deepEqual(report.candidate.packs.map(({ version }) => version), [newVersion]);
});

test("v1 pilot release gate는 line-scoped inventory와 provenance를 포함 노선으로 평가한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-pilot-line-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, completeCoverageProvenance(inventory));

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", inventoryPath,
      "--manifest", path.join(outputDir, "current.json"),
      "--provenance", provenancePath,
      "--release-scope", "apps/mobile/release/production-datapack-scope.json",
      "--output", reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.releaseScope.coverageComplete, true);
  assert.equal(report.releaseScopeRequirements.length, 3);
  assert.ok(report.releaseScopeRequirements.every(({ lineId }) => lineId === "seoul-4"));
});

test("v1 pilot release gate는 다른 노선의 line-scoped provenance를 재사용하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-pilot-wrong-line-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const stationSource = inventory.sources.find(
    (source) =>
      source.coverageScope.operatorIds.includes("seoul-metro") &&
      source.coverageScope.lineIds?.includes("seoul-4") &&
      source.coverageScope.sourceDomains.includes("station_line_membership"),
  );
  stationSource.coverageScope.lineIds = ["seoul-2", "seoul-4"];
  const provenance = completeCoverageProvenance(inventory);
  for (const record of provenance.packs[0].records.filter(({ sourceId }) => sourceId === stationSource.id)) {
    record.coverageScope = { ...record.coverageScope, lineIds: ["seoul-2"] };
  }
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, provenance);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", path.join(outputDir, "current.json"),
        "--provenance", provenancePath,
        "--release-scope", "apps/mobile/release/production-datapack-scope.json",
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /in-scope coverage gaps remain: 1 missing requirements/,
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const stationRequirement = report.releaseScopeRequirements.find(
    ({ sourceDomain }) => sourceDomain === "station_line_membership",
  );
  assert.equal(stationRequirement.status, "missing");
  assert.deepEqual(stationRequirement.sourceIds, []);
});

test("v1 pilot release gate는 line-scoped source의 노선 없는 provenance를 재사용하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-pilot-unscoped-provenance-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const stationSource = inventory.sources.find(
    (source) =>
      source.coverageScope.operatorIds.includes("seoul-metro") &&
      source.coverageScope.lineIds?.includes("seoul-4") &&
      source.coverageScope.sourceDomains.includes("station_line_membership"),
  );
  const provenance = completeCoverageProvenance(inventory);
  for (const record of provenance.packs[0].records.filter(({ sourceId }) => sourceId === stationSource.id)) {
    record.coverageScope = { ...record.coverageScope };
    delete record.coverageScope.lineIds;
  }
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, provenance);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", path.join(outputDir, "current.json"),
        "--provenance", provenancePath,
        "--release-scope", "apps/mobile/release/production-datapack-scope.json",
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /in-scope coverage gaps remain: 1 missing requirements/,
  );
});

test("v1 release gate는 active 노선-운영기관 pair만 평가한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-release-pairs-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const releaseScopePath = path.join(outputDir, "release-scope.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const releaseScope = JSON.parse(
    await readFile(path.join(root, "apps/mobile/release/production-datapack-scope.json"), "utf8"),
  );
  releaseScope.supportScope.includedOperatorIds = ["seoul-metro", "operator-28e01fb8509d"];
  releaseScope.supportScope.includedLineIds = ["seoul-4", "shinbundang"];
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, completeCoverageProvenance(inventory));
  await writeFile(releaseScopePath, `${JSON.stringify(releaseScope, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", inventoryPath,
      "--manifest", path.join(outputDir, "current.json"),
      "--provenance", provenancePath,
      "--release-scope", releaseScopePath,
      "--output", reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.releaseScope.coverageComplete, true);
  assert.equal(report.releaseScopeRequirements.length, 6);
  assert.deepEqual(
    [...new Set(report.releaseScopeRequirements.map(({ lineId, operatorId }) => `${lineId}:${operatorId}`))].sort(),
    ["seoul-4:seoul-metro", "shinbundang:operator-28e01fb8509d"],
  );
});

test("release gate는 일부만 active pair에 매칭되는 scope를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-release-partial-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const releaseScopePath = path.join(outputDir, "release-scope.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const releaseScope = JSON.parse(
    await readFile(path.join(root, "apps/mobile/release/production-datapack-scope.json"), "utf8"),
  );
  releaseScope.supportScope.includedLineIds.push("unknown-line");
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, completeCoverageProvenance(inventory));
  await writeFile(releaseScopePath, `${JSON.stringify(releaseScope, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", path.join(outputDir, "current.json"),
        "--provenance", provenancePath,
        "--release-scope", releaseScopePath,
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /release scope lineId has no matching active coverage pair: unknown-line/,
  );
});

test("schema v1 direct target은 line-scoped provenance를 operator requirement로 집계한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-v1-line-provenance-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/capital-pilot-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  for (const source of inventory.sources) {
    source.coverageScope.lineIds = ["seoul-4"];
  }
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, completeCoverageProvenance(inventory));

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/capital-pilot-coverage-targets.json",
      "--inventory", inventoryPath,
      "--manifest", path.join(outputDir, "current.json"),
      "--provenance", provenancePath,
      "--output", reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.coverageComplete, true);
  assert.equal(report.summary.missingRequirements, 0);
});

test("release gate는 schema v2 release target의 SUPPORTED requirement를 집계한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-release-v2-target-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const provenance = completeCoverageProvenance(inventory);
  provenance.packs[0].records = provenance.packs[0].records.filter(
    (record) => !record.coverageScope.sourceDomains.includes("demand_reference"),
  );
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, provenance);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
      "--inventory", inventoryPath,
      "--manifest", path.join(outputDir, "current.json"),
      "--provenance", provenancePath,
      "--release-scope", "apps/mobile/release/production-datapack-scope.json",
      "--release-targets", "tools/datapack/nationwide-coverage-targets.json",
      "--output", reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.releaseScope.coverageComplete, true);
  assert.equal(report.summary.releaseScope.coveredRequirements, 6);
  assert.equal(report.summary.releaseScope.missingRequirements, 0);
  assert.ok(
    report.releaseScopeRequirements.some(
      ({ releaseTier, sourceDomain, status }) =>
        releaseTier === "ENHANCEMENT" && sourceDomain === "demand_reference" && status === "MISSING",
    ),
  );
});

test("release gate는 schema v2 release target에서 operator-wide provenance로 line scope를 우회하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-release-v2-strict-line-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const stationSource = inventory.sources.find(
    (source) =>
      source.coverageScope.operatorIds.includes("seoul-metro") &&
      source.coverageScope.lineIds?.includes("seoul-4") &&
      source.coverageScope.sourceDomains.includes("station_line_membership"),
  );
  delete stationSource.coverageScope.lineIds;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, completeCoverageProvenance(inventory));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets", "tools/datapack/nationwide-coverage-targets.json",
        "--inventory", inventoryPath,
        "--manifest", path.join(outputDir, "current.json"),
        "--provenance", provenancePath,
        "--release-scope", "apps/mobile/release/production-datapack-scope.json",
        "--release-targets", "tools/datapack/nationwide-coverage-targets.json",
        "--output", reportPath,
      ],
      { cwd: root },
    ),
    /in-scope coverage gaps remain: 1 missing requirements/,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const stationRequirement = report.releaseScopeRequirements.find(
    ({ sourceDomain }) => sourceDomain === "station_line_membership",
  );
  assert.equal(stationRequirement.status, "MISSING");
  assert.deepEqual(stationRequirement.sourceIds, []);
});

test("전국 coverage gap report는 multi-region source의 provenance scope를 requirement별로 제한한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-provenance-scope-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const stationMembership = targets.requiredSourceDomains.find((domain) => domain.id === "station_line_membership");
  const multiRegionSource = {
    id: "multi-region-station-source",
    coverageScope: {
      regionIds: ["capital", "busan"],
      operatorIds: ["seoul-metro", "busan-transportation"],
      lineIds: ["seoul-4", "line-ab1a041f6266"],
      sourceDomains: ["station_line_membership"],
    },
    fieldsProvided: stationMembership.requiredFields,
  };
  const inventory = {
    schemaVersion: 1,
    retrievedAt: "2026-06-22",
    sources: [multiRegionSource],
  };
  const provenance = {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: "a".repeat(64),
    packs: [
      {
        id: "nationwide",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "b".repeat(64),
        records: stationMembership.requiredFields.map((field) => ({
          entityType: "station_line",
          entityId: `capital-seoul-metro:${field}`,
          field,
          sourceId: multiRegionSource.id,
          coverageScope: {
            regionIds: ["capital"],
            operatorIds: ["seoul-metro"],
            lineIds: ["seoul-4"],
            sourceDomains: ["station_line_membership"],
          },
          derivationKind: "OFFICIAL",
          verifiedAt: "2026-06-22T00:00:00.000Z",
        })),
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, provenance);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      inventoryPath,
      "--manifest",
      path.join(outputDir, "current.json"),
      "--provenance",
      provenancePath,
      "--output",
      reportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const capitalRequirement = report.requirements.find(
    (entry) =>
      entry.regionId === "capital" &&
      entry.operatorId === "seoul-metro" &&
      entry.lineId === "seoul-4" &&
      entry.sourceDomain === "station_line_membership",
  );
  const busanRequirement = report.requirements.find(
    (entry) =>
      entry.regionId === "busan" &&
      entry.operatorId === "busan-transportation" &&
      entry.lineId === "line-ab1a041f6266" &&
      entry.sourceDomain === "station_line_membership",
  );
  assert.equal(capitalRequirement.status, "SUPPORTED");
  assert.deepEqual(capitalRequirement.missingFields, []);
  assert.equal(busanRequirement.status, "MISSING");
  assert.deepEqual(busanRequirement.sourceIds, []);
  assert.deepEqual(busanRequirement.missingFields, stationMembership.requiredFields);
});

test("전국 coverage gap report는 provenance 모드에서 source-native field명을 target field gate로 쓰지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-provenance-normalized-field-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = {
    schemaVersion: 1,
    retrievedAt: "2026-06-22",
    sources: [
      {
        id: "kric-station-elevator",
        coverageScope: {
          regionIds: ["capital"],
          operatorIds: ["seoul-metro"],
          lineIds: ["seoul-4"],
          sourceDomains: ["accessibility_facilities"],
        },
        fieldsProvided: ["station_code", "station_name", "location", "floor_from", "floor_to"],
      },
    ],
  };
  const provenance = {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: "a".repeat(64),
    packs: [
      {
        id: "capital",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "b".repeat(64),
        records: [
          {
            entityType: "facility",
            entityId: "facility-sangnoksu-elevator-kric-1",
            field: "elevator",
            sourceId: "kric-station-elevator",
            coverageScope: {
              regionIds: ["capital"],
              operatorIds: ["seoul-metro"],
              lineIds: ["seoul-4"],
              sourceDomains: ["accessibility_facilities"],
            },
            derivationKind: "OFFICIAL",
            verifiedAt: "2026-06-22T00:00:00.000Z",
          },
        ],
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, provenance);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      inventoryPath,
      "--manifest",
      path.join(outputDir, "current.json"),
      "--provenance",
      provenancePath,
      "--output",
      reportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const accessibilityRequirement = report.requirements.find(
    (entry) =>
      entry.regionId === "capital" &&
      entry.operatorId === "seoul-metro" &&
      entry.lineId === "seoul-4" &&
      entry.sourceDomain === "accessibility_facilities",
  );
  const elevatorCoverage = accessibilityRequirement.fieldCoverage.find((entry) => entry.field === "elevator");
  assert.equal(elevatorCoverage.status, "covered");
  assert.deepEqual(elevatorCoverage.sourceIds, ["kric-station-elevator"]);
  assert.ok(accessibilityRequirement.missingFields.includes("status"));
});

test("전국 coverage gap report는 generated fixture manual provenance를 official coverage에서 제외한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-coverage-gap-provenance-generated-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const provenancePath = path.join(outputDir, "current.provenance.json");
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  const provenance = completeCoverageProvenance(inventory);
  provenance.packs[0].records.find((record) => record.field === "line").derivationKind = "GENERATED";
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeCoverageCandidate(outputDir, provenance);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/nationwide-coverage-targets.json",
        "--inventory",
        inventoryPath,
        "--manifest",
        path.join(outputDir, "current.json"),
        "--provenance",
        provenancePath,
        "--output",
        reportPath,
      ],
      { cwd: root },
    ),
    /nationwide coverage gaps remain/,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.coverageComplete, false);
  assert.ok(report.requirements.some((entry) => entry.missingFields.includes("line")));
});

test("공식 source ingest adapter는 stable id mapping으로 catalog fixture pack을 만든다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const generated = JSON.parse(await readFile(outputPath, "utf8"));
  const pack = generated.packs[0];
  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const facilityStatusRecord = provenance.packs[0].records.find(
    (record) => record.entityType === "facility" && record.field === "status",
  );
  assert.ok(facilityStatusRecord);
  const seoulMetroSource = pack.sourceInventory.find((source) => source.id === "seoulmetro-station-line-info");
  assert.equal(pack.artifactKind, "fixture");
  assert.equal(pack.sourceInventory.length, 2);
  assert.ok(seoulMetroSource);
  assert.equal(seoulMetroSource.licenseStatus, "redistributable");
  assert.deepEqual(seoulMetroSource.coverageScope, {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    sourceDomains: ["station_line_membership"],
  });
  assert.match(seoulMetroSource.updatedAt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00\.000Z$/);
  assert.deepEqual(
    pack.stations.map((station) => station.id),
    ["station-sangnoksu", "station-sadang"],
  );
  assert.deepEqual(
    pack.stationLines.map((stationLine) => `${stationLine.stationId}:${stationLine.lineId}`),
    ["station-sangnoksu:seoul-4", "station-sadang:seoul-4"],
  );
  assert.deepEqual(pack.networkEdges[0], {
    id: "edge-sangnoksu-sadang-seoul-4",
    fromNodeId: "station-sangnoksu:seoul-4",
    toNodeId: "station-sadang:seoul-4",
    durationSeconds: 1860,
    distanceMeters: 18600,
    edgeType: "RIDE",
    servicePattern: "EXPRESS",
    includesStairs: false,
    stairAccessState: "STEP_FREE",
    accessibilityStatus: "AVAILABLE",
    reliabilityScore: 90,
    sourceId: "seoulmetro-station-line-info",
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    lastVerifiedAt: "2026-06-21T00:00:00.000Z",
  });
  assert.deepEqual(pack.facilities[0], {
    id: "facility-sangnoksu-elevator-1",
    stationId: "station-sangnoksu",
    lineId: "seoul-4",
    exitId: null,
    type: "ELEVATOR",
    name: "상록수역 1번 승강기",
    status: "NORMAL",
    floorFrom: "B2",
    floorTo: "1F",
    description: "상록수역 승강장과 지상을 연결합니다.",
    sourceId: "seoulmetro-station-line-info",
    providerFacilityRef: "facility-sangnoksu-elevator-1",
    provenanceKind: "OFFICIAL_SOURCE",
    operationalStatus: "UNKNOWN",
    installationStatus: "UNKNOWN",
    derivationKind: "OFFICIAL",
  });
  assert.equal(facilityStatusRecord.derivationKind, "GENERATED");
});

test("공식 source ingest와 build provenance는 lineIds를 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-line-scope-provenance-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const fixturePath = path.join(outputDir, "catalog-fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  for (const source of inventory.sources.filter(({ id }) =>
    ["seoulmetro-station-line-info", "seoul-realtime-arrival-station-info"].includes(id))) {
    source.coverageScope.lineIds = ["seoul-4"];
  }
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory", inventoryPath,
      "--input", inputPath,
      "--output", fixturePath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const stationSource = fixture.packs[0].sourceInventory.find(
    ({ id }) => id === "seoulmetro-station-line-info",
  );
  assert.deepEqual(stationSource.coverageScope.lineIds, ["seoul-4"]);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );
  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const lineRecord = provenance.packs[0].records.find(
    (record) => record.entityType === "station_line" && record.field === "line",
  );
  assert.deepEqual(lineRecord.coverageScope.lineIds, ["seoul-4"]);
});

test("데이터팩 생성기는 line-scoped source와 행 노선이 불일치하면 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-line-scope-mismatch-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const fixturePath = path.join(outputDir, "catalog-fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory", "tools/datapack/source-inventory.json",
      "--input", inputPath,
      "--output", fixturePath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  fixture.packs[0].sourceInventory.find(
    ({ id }) => id === "seoulmetro-station-line-info",
  ).coverageScope.lineIds = ["seoul-2"];
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
      { cwd: root, env: productionEnv },
    ),
    /source coverageScope lineIds do not include record lineIds/,
  );
});

test("데이터팩 생성기는 여러 노선 service provenance를 실제 운영기관-노선 pair로 분할한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-service-provenance-pairs-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );

  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const scopes = provenance.packs[0].records
    .filter((record) => record.entityType === "service_calendar" && record.field === "service_calendar")
    .map(({ coverageScope }) => coverageScope)
    .sort((left, right) => left.lineIds[0].localeCompare(right.lineIds[0]));
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
});

test("데이터팩 생성기는 공동 운영 노선 provenance에 공식 operator-line pair를 모두 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-shared-line-provenance-pairs-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
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
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );

  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const pairs = provenance.packs[0].records
    .filter((record) => record.entityType === "service_calendar" && record.field === "service_calendar")
    .map(({ coverageScope }) => `${coverageScope.lineIds[0]}:${coverageScope.operatorIds[0]}`)
    .sort();
  assert.deepEqual(pairs, ["seoul-4:korail", "seoul-4:seoul-metro"]);
});

test("데이터팩 생성기는 service pattern route node의 edge provenance scope를 canonical station-line operator로 제한한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-provenance-service-pattern-scope-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  const pack = fixture.packs[0];
  pack.sourceInventory.find((source) => source.id === "seoulmetro-station-line-info").coverageScope.operatorIds = [
    "seoul-metro",
    "korail",
  ];
  pack.networkEdges[0].fromNodeId = "station-sangnoksu:seoul-4:EXPRESS";
  pack.networkEdges[0].toNodeId = "station-sadang:seoul-4:EXPRESS";
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const edgeRecord = provenance.packs[0].records.find(
    (record) =>
      record.entityType === "network_edge" &&
      record.entityId === "edge-sangnoksu-sadang-seoul-4" &&
      record.field === "network_edges",
  );
  assert.ok(edgeRecord);
  assert.deepEqual(edgeRecord.coverageScope.operatorIds, ["seoul-metro"]);
});

test("공식 source ingest adapter는 전국 마스터 source를 canonical 역·노선 row로 병합한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-nationwide-master-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(nationwideMasterSourceIngestInput(), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const generated = JSON.parse(await readFile(outputPath, "utf8"));
  const pack = generated.packs[0];
  assert.deepEqual(
    pack.sourceInventory.map((source) => source.id),
    [
      "molit-urban-rail-full-route",
      "molit-tago-subway-info",
      "kric-metropolitan-rail-station-info",
    ],
  );
  assert.deepEqual(
    pack.stations.map((station) => station.id),
    ["station-sangnoksu", "station-busan-station"],
  );
  assert.deepEqual(
    pack.stationLines.map((stationLine) => ({
      stationId: stationLine.stationId,
      lineId: stationLine.lineId,
      stationCode: stationLine.stationCode,
      lineSequence: stationLine.lineSequence,
    })),
    [
      {
        stationId: "station-sangnoksu",
        lineId: "seoul-4",
        stationCode: "448",
        lineSequence: 43,
      },
      {
        stationId: "station-busan-station",
        lineId: "busan-1",
        stationCode: "113",
        lineSequence: 13,
      },
    ],
  );
});

test("공식 source ingest adapter는 production pack의 최소 coverage 기준 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-missing-${Date.now()}`);
  const input = productionSourceIngestInput();
  delete input.minimumProductionCoverage;
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /minimumProductionCoverage must be an object for production pack/,
  );
});

test("공식 source ingest adapter는 production pack의 coverage evidence 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-evidence-missing-${Date.now()}`);
  const input = productionSourceIngestInput();
  delete input.coverageEvidence;
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /coverageEvidence must be a non-empty array for production pack/,
  );
});

test("공식 source ingest adapter는 source inventory가 뒷받침하지 않는 coverage evidence를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-evidence-unsupported-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.coverageEvidence[0].operatorId = "busan-transportation";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /coverage evidence unsupported by source inventory: capital:busan-transportation:station_line_membership/,
  );
});

test("공식 source ingest adapter는 provenance 전용 source를 production row source로 선택하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-provenance-only-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.sourceIds.push("kric-station-info");
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /kric-station-info source inventory is provenance-only and cannot be selected for production rows/,
  );
});

test("공식 source ingest adapter는 selected source가 claim한 coverage evidence 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-evidence-claim-missing-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.coverageEvidence = input.coverageEvidence.filter((entry) => entry.sourceDomain !== "accessibility_facilities");
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /production coverage evidence missing: capital:seoul-metro:accessibility_facilities/,
  );
});

test("공식 source ingest adapter는 production pack의 최소 coverage 미달을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-small-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.minimumProductionCoverage.stations = 100;
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /production coverage stations 2 is below required minimum 100/,
  );
});

test("공식 source ingest adapter는 production coverage 기준을 manifest 최소 row 기준으로 전파한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-coverage-pass-${Date.now()}`);
  const input = productionSourceIngestInput();
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const generated = JSON.parse(await readFile(outputPath, "utf8"));
  makeProductionSourceFixtureStrictCoverageValid(generated);
  await writeFile(outputPath, `${JSON.stringify(generated, null, 2)}\n`);
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
        id: "kric-station-elevator",
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
          sourceDomains: ["accessibility_facilities"],
        },
      },
      {
        id: "kric-station-elevator-movement",
        coverageScope: generated.packs[0].sourceInventory[2].coverageScope,
      },
      {
        id: "kric-station-escalator",
        coverageScope: generated.packs[0].sourceInventory[2].coverageScope,
      },
      {
        id: "kric-wheelchair-lift-location",
        coverageScope: generated.packs[0].sourceInventory[2].coverageScope,
      },
      {
        id: "kric-wheelchair-lift-movement",
        coverageScope: generated.packs[0].sourceInventory[2].coverageScope,
      },
    ],
  );
  assert.deepEqual(JSON.parse(generated.packs[0].metadata.productionCoverageEvidence), [
    {
      regionId: "capital",
      operatorId: "seoul-metro",
      sourceDomain: "accessibility_facilities",
      sourceIds: [
        "kric-station-elevator",
        "kric-station-elevator-movement",
        "kric-station-escalator",
        "kric-wheelchair-lift-location",
        "kric-wheelchair-lift-movement",
      ],
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
      {
        stationId: "station-sadang",
        lineId: "seoul-4",
        facilityType: "ELEVATOR",
        evidenceKind: "EXISTS",
      },
      {
        stationId: "station-sadang",
        lineId: "seoul-4",
        facilityType: "ESCALATOR",
        evidenceKind: "EXISTS",
      },
      {
        stationId: "station-sadang",
        lineId: "seoul-4",
        facilityType: "WHEELCHAIR_LIFT",
        evidenceKind: "EXISTS",
      },
      {
        stationId: "station-sangnoksu",
        lineId: "seoul-4",
        facilityType: "ELEVATOR",
        evidenceKind: "EXISTS",
      },
      {
        stationId: "station-sangnoksu",
        lineId: "seoul-4",
        facilityType: "ESCALATOR",
        evidenceKind: "EXISTS",
      },
      {
        stationId: "station-sangnoksu",
        lineId: "seoul-4",
        facilityType: "WHEELCHAIR_LIFT",
        evidenceKind: "EXISTS",
      },
    ],
  );

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
});

test("공식 source ingest adapter는 canonical transit schedule rows를 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-schedule-${Date.now()}`);
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

  const generated = await importOfficialSourceInput(outputDir, input);
  assert.equal(generated.packs[0].requiredTables.includes("transit_stop_times"), true);
  assert.equal(generated.packs[0].minimumTableRows.transit_stop_times, 2);
  assert.equal(generated.packs[0].transitStopTimes[0].tripId, "trip-seoul-4-local-0805");

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      path.join(outputDir, "catalog-fixture.json"),
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
});

test("공식 source ingest adapter는 production schedule pass-through를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-schedule-${Date.now()}`);
  const input = productionSourceIngestInput();
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

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /production transit schedule import requires sourced schedule provenance/,
  );
});

test("KRIC 4호선 pilot 시간표 transformer는 상록수-사당 stop_times를 production input에 주입한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-line4-pilot-schedule-${Date.now()}`);
  const artifactPath = path.join(outputDir, "kric-artifact.json");
  const outputPath = path.join(outputDir, "production-input.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const fixtureTrips = Array.from({ length: 466 }, (_, index) => {
    const isUp = index % 2 === 0;
    return {
      id: `route-seoul-4-${isUp ? "up" : "down"}-fixture-${index}`,
      routeId: isUp ? "route-seoul-4-up" : "route-seoul-4-down",
      serviceId: index < 250 ? "weekday-kric" : "holiday-kric",
      tripHeadsign: isUp ? "station-seoul-4-448" : "station-seoul-4-433",
      directionId: isUp ? "up" : "down",
      servicePattern: "LOCAL",
    };
  });
  const fixtureStopTimes = fixtureTrips.flatMap((trip, index) => {
    const isUp = trip.directionId === "up";
    const firstArrivalSeconds = 18000 + index * 60;
    return [
      {
        tripId: trip.id,
        stopSequence: 1,
        stationId: isUp ? "station-seoul-4-433" : "station-seoul-4-448",
        lineId: "seoul-4",
        arrivalSeconds: firstArrivalSeconds,
        departureSeconds: firstArrivalSeconds,
      },
      {
        tripId: trip.id,
        stopSequence: 2,
        stationId: isUp ? "station-seoul-4-448" : "station-seoul-4-433",
        lineId: "seoul-4",
        arrivalSeconds: firstArrivalSeconds + 2400,
        departureSeconds: firstArrivalSeconds + 2400,
      },
    ];
  });
  const fillerTrips = Array.from({ length: 895 - fixtureTrips.length }, (_, index) => ({
    id: `route-seoul-4-filler-${index}`,
    routeId: index % 2 === 0 ? "route-seoul-4-up" : "route-seoul-4-down",
    serviceId: "weekday-kric",
    tripHeadsign: "station-seoul-4-456",
    directionId: index % 2 === 0 ? "up" : "down",
    servicePattern: "LOCAL",
  }));
  const fillerStopTimes = Array.from({ length: 33062 - fixtureStopTimes.length }, (_, index) => ({
    tripId: fillerTrips[index % fillerTrips.length].id,
    stopSequence: index + 1,
    stationId: `station-seoul-4-filler-${index}`,
    lineId: "seoul-4",
    arrivalSeconds: 18000 + index,
    departureSeconds: 18000 + index,
  }));
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      artifactKind: "kric-line4-timetable-collection",
      sourceId: "kric-subway-timetable",
      lineId: "seoul-4",
      capturedAt: "2026-07-09",
      requestCount: 153,
      failedRequestCount: 0,
      intermediateRowCount: 33062,
      transitTripCount: 895,
      transitStopTimeCount: 33062,
      transitTrips: [...fixtureTrips, ...fillerTrips],
      transitStopTimes: [...fixtureStopTimes, ...fillerStopTimes],
    }, null, 2)}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-kric-line4-pilot-schedule.mjs",
      "--input",
      "tools/datapack/inputs/capital-pilot-production-source-input.json",
      "--artifact",
      artifactPath,
      "--output",
      outputPath,
    ],
    { cwd: root, env: productionEnv },
  );

  const transformed = JSON.parse(await readFile(outputPath, "utf8"));
  assert.ok(transformed.sourceIds.includes("kric-subway-timetable"));
  assert.equal(transformed.transitTrips.length, 466);
  assert.equal(transformed.transitStopTimes.length, 932);
  assert.deepEqual(
    transformed.transitStopTimes
      .filter((row) => row.tripId === "route-seoul-4-up-fixture-0")
      .map((row) => row.stationId),
    ["station-sadang", "station-sangnoksu"],
  );
  assert.deepEqual(
    transformed.transitStopTimes
      .filter((row) => row.tripId === "route-seoul-4-down-fixture-1")
      .map((row) => row.stationId),
    ["station-sangnoksu", "station-sadang"],
  );
  assert.deepEqual(transformed.transitFeedInfo, [{ feedEndDate: "20261231" }]);
  assert.deepEqual(
    transformed.serviceCalendars.find((calendar) => calendar.serviceId === "holiday-kric"),
    {
      serviceId: "holiday-kric",
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: true,
      sunday: true,
      startDate: "20260101",
      endDate: "20261231",
    },
  );
  assert.equal(transformed.scheduleProvenance.sourceId, "kric-subway-timetable");
  assert.match(transformed.scheduleProvenance.providerRecordHash, /^[a-f0-9]{64}$/);
  assert.equal(transformed.serviceCalendarDates.length, 28);
  assert.deepEqual(
    transformed.serviceCalendarDates.filter((row) => row.date === "20261225"),
    [
      { serviceId: "holiday-kric", date: "20261225", exceptionType: 1 },
      { serviceId: "weekday-kric", date: "20261225", exceptionType: 2 },
    ],
  );
});

test("KRIC 4호선 pilot 시간표 transformer는 summary counter만 복사된 부분 artifact를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-line4-truncated-schedule-${Date.now()}`);
  const artifactPath = path.join(outputDir, "kric-artifact.json");
  const outputPath = path.join(outputDir, "production-input.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      artifactKind: "kric-line4-timetable-collection",
      sourceId: "kric-subway-timetable",
      lineId: "seoul-4",
      capturedAt: "2026-07-09",
      requestCount: 153,
      failedRequestCount: 0,
      intermediateRowCount: 33062,
      transitTripCount: 895,
      transitStopTimeCount: 33062,
      transitTrips: [],
      transitStopTimes: [],
    }, null, 2)}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-kric-line4-pilot-schedule.mjs",
        "--input",
        "tools/datapack/inputs/capital-pilot-production-source-input.json",
        "--artifact",
        artifactPath,
        "--output",
        outputPath,
      ],
      { cwd: root, env: productionEnv },
    ),
    /KRIC pilot artifact transitTrips\.length mismatch: 0 !== 895/,
  );
});

test("KRIC 4호선 pilot 시간표 transformer는 부분 수집 artifact를 production input으로 승격하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-line4-partial-schedule-${Date.now()}`);
  const artifactPath = path.join(outputDir, "kric-artifact.json");
  const outputPath = path.join(outputDir, "production-input.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      artifactKind: "kric-line4-timetable-collection",
      sourceId: "kric-subway-timetable",
      lineId: "seoul-4",
      capturedAt: "2026-07-09",
      requestCount: 153,
      failedRequestCount: 1,
      intermediateRowCount: 33062,
      transitTripCount: 895,
      transitStopTimeCount: 33062,
      transitTrips: [],
      transitStopTimes: [],
    }, null, 2)}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-kric-line4-pilot-schedule.mjs",
        "--input",
        "tools/datapack/inputs/capital-pilot-production-source-input.json",
        "--artifact",
        artifactPath,
        "--output",
        outputPath,
      ],
      { cwd: root, env: productionEnv },
    ),
    /KRIC pilot artifact failedRequestCount mismatch: 1 !== 0/,
  );
});

test("공식 source ingest adapter는 명시한 lineSequence 경계 wrap만 허용한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-stop-times-wrap-${Date.now()}`);
  const input = sourceIngestInput();
  addSourceIngestStation(input, {
    sourceStationCode: "410",
    stationId: "station-loop-min",
    stationNameKo: "순환최소",
    stationCode: "410",
    lineSequence: 10,
  });
  addSourceIngestStation(input, {
    sourceStationCode: "420",
    stationId: "station-loop-next",
    stationNameKo: "순환다음",
    stationCode: "420",
    lineSequence: 20,
  });
  input.transitStopTimes = [
    {
      tripId: "trip-seoul-4-loop-wrap",
      stopSequence: 1,
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
      arrivalSeconds: 28800,
      departureSeconds: 28800,
    },
    {
      tripId: "trip-seoul-4-loop-wrap",
      stopSequence: 2,
      stationId: "station-loop-min",
      lineId: "seoul-4",
      arrivalSeconds: 29400,
      departureSeconds: 29400,
    },
    {
      tripId: "trip-seoul-4-loop-wrap",
      stopSequence: 3,
      stationId: "station-loop-next",
      lineId: "seoul-4",
      arrivalSeconds: 30000,
      departureSeconds: 30000,
    },
  ];

  await assert.rejects(
    importOfficialSourceInput(path.join(outputDir, "blocked"), input),
    /transit_stop_times stop_sequence must follow station lineSequence order: trip-seoul-4-loop-wrap/,
  );

  input.lines[0].lineSequenceWrapAllowed = true;
  const generated = await importOfficialSourceInput(outputDir, input);
  assert.equal(generated.packs[0].minimumTableRows.transit_stop_times, 3);
});

test("공식 source ingest adapter는 cross-line trip의 lineSequence를 노선 구간별로 검증한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-cross-line-stop-times-${Date.now()}`);
  const input = sourceIngestInput();
  input.lines.push({
    ...input.lines[0],
    id: "line-branch",
    nameKo: "분기 노선",
    nameEn: "Branch Line",
  });
  for (const station of [
    { sourceStationCode: "501", stationId: "station-branch-1", stationNameKo: "분기1", lineSequence: 1 },
    { sourceStationCode: "502", stationId: "station-branch-2", stationNameKo: "분기2", lineSequence: 12 },
  ]) {
    input.stationMappings.push({
      sourceId: "seoulmetro-station-line-info",
      sourceStationCode: station.sourceStationCode,
      lineId: "line-branch",
      stationId: station.stationId,
      stationLineId: `${station.stationId}:line-branch`,
      mappingStatus: "active",
    });
    input.stationLineRows.push({
      ...input.stationLineRows[0],
      sourceStationCode: station.sourceStationCode,
      lineId: "line-branch",
      stationNameKo: station.stationNameKo,
      stationNameEn: station.stationNameKo,
      normalizedName: station.stationNameKo,
      stationCode: station.sourceStationCode,
      lineSequence: station.lineSequence,
    });
  }
  input.transitStopTimes = [
    { tripId: "trip-cross-line", stopSequence: 1, stationId: "station-sadang", lineId: "seoul-4", arrivalSeconds: 28800, departureSeconds: 28800 },
    { tripId: "trip-cross-line", stopSequence: 2, stationId: "station-sangnoksu", lineId: "seoul-4", arrivalSeconds: 29400, departureSeconds: 29400 },
    { tripId: "trip-cross-line", stopSequence: 3, stationId: "station-branch-1", lineId: "line-branch", arrivalSeconds: 30000, departureSeconds: 30000 },
    { tripId: "trip-cross-line", stopSequence: 4, stationId: "station-branch-2", lineId: "line-branch", arrivalSeconds: 30600, departureSeconds: 30600 },
  ];

  const generated = await importOfficialSourceInput(outputDir, input);
  assert.equal(generated.packs[0].minimumTableRows.transit_stop_times, 4);
});

test("공식 source ingest adapter는 cross-line EXPRESS summary edge도 격리 정책을 요구한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-cross-line-express-policy-${Date.now()}`);
  const input = productionSourceIngestInput();
  addSeoul2ProductionScope(input);
  addMolitStationMapping(input, {
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationId: "station-sadang",
  });
  addStationLineRow(input, {
    baseSourceStationCode: "MOLIT-SEOUL-4-433",
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationCode: "226",
    lineSequence: 29,
  });
  input.routeEdges = [
    {
      ...productionSummaryRideEdges()[0],
      id: "edge-cross-line-express-summary",
      sourceId: "molit-urban-rail-full-route",
      from: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
      },
      to: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-2-226",
        lineId: "seoul-2",
      },
      servicePattern: "EXPRESS",
      sourceSnapshotId: "molit-urban-rail-full-route-snapshot-20260621",
      providerRecordHash: sha256("provider:edge-cross-line-express-summary:molit-urban-rail-full-route"),
      evidenceHash: sha256("evidence:edge-cross-line-express-summary:molit-urban-rail-full-route:2026-06-21T00:00:00.000Z"),
    },
  ];
  delete input.routeGraphTopologyPolicy;

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /production routeEdges non-adjacent EXPRESS summary edge is fixture-only/,
  );
});

test("공식 source ingest adapter는 stop_times 순서가 lineSequence와 뒤섞이면 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-stop-times-sequence-${Date.now()}`);
  const input = sourceIngestInput();
  addSourceIngestStation(input, {
    sourceStationCode: "450",
    stationId: "station-jungang",
    stationNameKo: "중앙",
    stationCode: "450",
    lineSequence: 50,
  });
  addSourceIngestStation(input, {
    sourceStationCode: "451",
    stationId: "station-extra",
    stationNameKo: "추가",
    stationCode: "451",
    lineSequence: 60,
  });
  input.transitStopTimes = [
    {
      tripId: "trip-seoul-4-zigzag",
      stopSequence: 1,
      stationId: "station-sangnoksu",
      lineId: "seoul-4",
      arrivalSeconds: 28800,
      departureSeconds: 28800,
    },
    {
      tripId: "trip-seoul-4-zigzag",
      stopSequence: 2,
      stationId: "station-sadang",
      lineId: "seoul-4",
      arrivalSeconds: 29400,
      departureSeconds: 29400,
    },
    {
      tripId: "trip-seoul-4-zigzag",
      stopSequence: 3,
      stationId: "station-jungang",
      lineId: "seoul-4",
      arrivalSeconds: 30000,
      departureSeconds: 30000,
    },
  ];

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /transit_stop_times stop_sequence must follow station lineSequence order: trip-seoul-4-zigzag/,
  );
});

test("공식 source ingest adapter는 admission 전 schedule provenance도 production 적재하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-schedule-candidate-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.sourceIds.push("molit-tago-subway-info");
  input.scheduleProvenance = {
    sourceId: "molit-tago-subway-info",
    sourceSnapshotId: "molit-tago-subway-info-snapshot-20260702",
    providerRecordHash: sha256("provider:molit-tago-subway-info:schedule:20260702"),
    evidenceHash: sha256("evidence:molit-tago-subway-info:schedule:20260702"),
    retrievedAt: "2026-07-02T00:00:00.000Z",
  };
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

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /scheduleProvenance source is not a schedule_timetable source: molit-tago-subway-info/,
  );
});

test("공식 source ingest adapter는 quota 미승인 schedule source를 production 적재하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-production-schedule-quota-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.sourceIds.push("molit-tago-subway-info");
  input.stationMappings.push({
    sourceId: "molit-tago-subway-info",
    sourceStationCode: "448",
    lineId: "seoul-4",
    stationId: "station-sangnoksu",
    stationLineId: "station-sangnoksu:seoul-4",
    mappingStatus: "active",
  });
  input.stationLineRows.push({
    ...input.stationLineRows[0],
    sourceId: "molit-tago-subway-info",
    sourceStationCode: "448",
  });
  input.coverageEvidence.push({
    regionId: "capital",
    operatorId: "seoul-metro",
    sourceDomain: "schedule_timetable",
    sourceIds: ["molit-tago-subway-info"],
    evidence: "TAGO schedule admission quota gate regression",
  });
  input.scheduleProvenance = {
    sourceId: "molit-tago-subway-info",
    sourceSnapshotId: "molit-tago-subway-info-snapshot-20260704",
    providerRecordHash: sha256("provider:molit-tago-subway-info:schedule:20260704"),
    evidenceHash: sha256("evidence:molit-tago-subway-info:schedule:20260704"),
    retrievedAt: "2026-07-04T00:00:00.000Z",
  };
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

  const inventoryPath = path.join(tmpdir(), `easysubway-source-inventory-schedule-quota-${Date.now()}.json`);
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const tago = inventory.sources.find((source) => source.id === "molit-tago-subway-info");
  tago.coverageScope.sourceDomains.push("schedule_timetable");
  tago.capabilities.schedule.status = "SUPPORTED";
  tago.capabilities.schedule.productionUseAllowed = true;
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await assert.rejects(
    importOfficialSourceInput(outputDir, input, inventoryPath),
    /scheduleProvenance source quota does not allow production schedule use: molit-tago-subway-info/,
  );
});

test("TAGO 시간표 sample validator는 station-level row shape만 검증하고 production 승격은 막는다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-sample-${Date.now()}.json`);
  const rawSample = `${JSON.stringify({
    response: {
      body: {
        items: {
          item: [
            {
              endSubwayStationNm: "당고개",
              subwayRouteId: "MTRKR4",
              subwayStationId: "MTRKR4448",
              subwayStationNm: "상록수",
              dailyTypeCode: "01",
              upDownTypeCode: "U",
              depTime: "080500",
              arrTime: "080500",
              endSubwayStationId: "MTRKR4409",
            },
            {
              endSubwayStationNm: "당고개",
              subwayRouteId: "MTRKR4",
              subwayStationId: "MTRKR4448",
              subwayStationNm: "상록수",
              dailyTypeCode: "01",
              upDownTypeCode: "U",
              depTime: "081200",
              arrTime: "081200",
              endSubwayStationId: "MTRKR4409",
            },
          ],
        },
      },
    },
  })}\n`;
  await writeFile(samplePath, rawSample);

  const { stdout } = await execFileAsync(
    process.execPath,
    ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
    { cwd: root, env: productionEnv },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.candidateId, "molit-tago-subway-info");
  assert.equal(report.rowCount, 2);
  assert.equal(report.stationLevelOnly, true);
  assert.equal(report.productionUseAllowed, false);
  assert.equal(report.rawSha256, sha256(rawSample));
  assert.equal(report.remainingAdmissionBlocker, "line_wide_trip_stop_sequence_validation_required");
  assert.deepEqual(
    report.departures.map((departure) => departure.departureSeconds),
    [29100, 29520],
  );
});

test("TAGO 시간표 sample validator는 잘못된 시간 row를 거부한다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-invalid-${Date.now()}.json`);
  await writeFile(samplePath, JSON.stringify({
    response: {
      body: {
        items: {
          item: {
            endSubwayStationNm: "당고개",
            subwayRouteId: "MTRKR4",
            subwayStationId: "MTRKR4448",
            subwayStationNm: "상록수",
            dailyTypeCode: "01",
            upDownTypeCode: "U",
            depTime: "080500",
            arrTime: "080700",
            endSubwayStationId: "MTRKR4409",
          },
        },
      },
    },
  }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
      { cwd: root, env: productionEnv },
    ),
    /arrival must be <= departure/,
  );
});

test("TAGO 시간표 sample validator는 JSON serviceKey credential을 거부한다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-secret-${Date.now()}.json`);
  await writeFile(samplePath, JSON.stringify({
    serviceKey: "secret",
    response: {
      body: {
        items: {
          item: {
            endSubwayStationNm: "당고개",
            subwayRouteId: "MTRKR4",
            subwayStationId: "MTRKR4448",
            subwayStationNm: "상록수",
            dailyTypeCode: "01",
            upDownTypeCode: "U",
            depTime: "080500",
            arrTime: "080500",
            endSubwayStationId: "MTRKR4409",
          },
        },
      },
    },
  }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
      { cwd: root, env: productionEnv },
    ),
    /serviceKey credentials/,
  );
});

test("TAGO 시간표 sample validator는 destination field가 sample 전체에서 사라지면 거부한다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-missing-destination-${Date.now()}.json`);
  await writeFile(samplePath, JSON.stringify({
    response: {
      body: {
        items: {
          item: {
            subwayRouteId: "MTRKR4",
            subwayStationId: "MTRKR4448",
            subwayStationNm: "상록수",
            dailyTypeCode: "01",
            upDownTypeCode: "U",
            depTime: "080500",
            arrTime: "080500",
          },
        },
      },
    },
  }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
      { cwd: root, env: productionEnv },
    ),
    /missing observed field: endSubwayStationNm/,
  );
});

test("TAGO 시간표 sample validator는 함수 import만으로 CLI를 실행하지 않는다", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { validateTagoScheduleSample } from './tools/datapack/validate-tago-schedule-sample.mjs'; console.log(typeof validateTagoScheduleSample);",
    ],
    { cwd: root, env: productionEnv },
  );
  assert.equal(stdout.trim(), "function");
});

test("TAGO 시간표 sample validator는 duplicate serviceKey credential을 거부한다", async () => {
  const samplePath = path.join(tmpdir(), `easysubway-tago-schedule-duplicate-secret-${Date.now()}.json`);
  await writeFile(
    samplePath,
    `{
      "serviceKey": "actual-secret",
      "serviceKey": "[서비스키값]",
      "response": {
        "body": {
          "items": {
            "item": {
              "endSubwayStationNm": "당고개",
              "subwayRouteId": "MTRKR4",
              "subwayStationId": "MTRKR4448",
              "subwayStationNm": "상록수",
              "dailyTypeCode": "01",
              "upDownTypeCode": "U",
              "depTime": "080500",
              "arrTime": "080500",
              "endSubwayStationId": "MTRKR4409"
            }
          }
        }
      }
    }`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-tago-schedule-sample.mjs", "--sample", samplePath],
      { cwd: root, env: productionEnv },
    ),
    /serviceKey credentials/,
  );
});

test("공식 source ingest adapter는 station-line 단위 facility evidence coverage를 요구한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-facility-line-coverage-${Date.now()}`);
  const input = productionSourceIngestInput();
  addSeoul2ProductionScope(input);
  addMolitStationMapping(input, {
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationId: "station-sadang",
  });
  addStationLineRow(input, {
    baseSourceStationCode: "MOLIT-SEOUL-4-433",
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationCode: "226",
    lineSequence: 26,
    platformInfo: "내선순환 / 외선순환",
  });

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /production facility evidence missing: station-sadang:seoul-2:ELEVATOR/,
  );
});

test("공식 source ingest adapter는 동일 station-line-type 시설을 evidence row 하나로 집계한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-duplicate-facility-evidence-${Date.now()}`);
  const input = productionSourceIngestInput();
  input.facilityRows.push({
    ...input.facilityRows.find((row) => row.id === "facility-sadang-elevator-kric-1"),
    id: "facility-sadang-elevator-kric-2",
    name: "사당 엘리베이터 설치 정보 2",
    providerFacilityRef: "facility-sadang-elevator-kric-2",
    providerRecordHash: sha256("provider:facility-sadang-elevator-kric-2:kric-station-elevator"),
    evidenceHash: sha256("evidence:facility-sadang-elevator-kric-2:kric-station-elevator:2026-06-22T00:00:00.000Z"),
  });

  const generated = await importOfficialSourceInput(outputDir, input);
  assert.equal(generated.packs[0].facilities.length, 7);
  assert.equal(generated.packs[0].stationFacilityEvidence.length, 6);
  assert.deepEqual(
    generated.packs[0].stationFacilityEvidence
      .filter(
        (row) =>
          row.stationId === "station-sadang" &&
          row.lineId === "seoul-4" &&
          row.facilityType === "ELEVATOR",
      )
      .map(({ stationId, lineId, facilityType, sourceId, strictRouteEligible, strictRouteEligibleReason }) => ({
        stationId,
        lineId,
        facilityType,
        sourceId,
        strictRouteEligible,
        strictRouteEligibleReason,
      })),
    [
      {
        stationId: "station-sadang",
        lineId: "seoul-4",
        facilityType: "ELEVATOR",
        sourceId: "kric-station-elevator",
        strictRouteEligible: false,
        strictRouteEligibleReason: "OPERATION_STATUS_UNKNOWN",
      },
    ],
  );
});

test("공식 source ingest adapter는 stationLineRows 없는 facility evidence mapping을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-facility-missing-station-line-${Date.now()}`);
  const input = productionSourceIngestInput();
  addSeoul2ProductionScope(input);
  addMolitStationMapping(input, {
    sourceStationCode: "MOLIT-SEOUL-2-999",
    stationId: "station-sangnoksu",
  });
  addMolitStationMapping(input, {
    sourceStationCode: "MOLIT-SEOUL-2-226",
    stationId: "station-sadang",
  });
  addStationLineRow(input, {
    baseSourceStationCode: "MOLIT-SEOUL-4-448",
    sourceStationCode: "MOLIT-SEOUL-2-999",
    stationCode: "999",
    lineSequence: 99,
  });
  addRequiredFacilityRowsForStationLine(input, {
    baseSourceStationCode: "MOLIT-SEOUL-4-448",
    sourceStationCode: "MOLIT-SEOUL-2-999",
    idPrefix: "facility-sangnoksu-seoul-2",
  });
  input.facilityRows.push({
    ...input.facilityRows.find((row) => row.id === "facility-sadang-elevator-kric-1"),
    id: "facility-sadang-seoul-2-elevator",
    station: {
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-2-226",
      lineId: "seoul-2",
    },
    providerFacilityRef: "facility-sadang-seoul-2-elevator",
    providerRecordHash: sha256("provider:facility-sadang-seoul-2-elevator:kric-station-elevator"),
    evidenceHash: sha256("evidence:facility-sadang-seoul-2-elevator:kric-station-elevator:2026-06-22T00:00:00.000Z"),
  });

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /production facility evidence station-line missing: station-sadang:seoul-2:ELEVATOR:facility-sadang-seoul-2-elevator/,
  );
});

test("AVAILABLE ENTRY edge rejects station-line source provenance", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-station-source-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  // AVAILABLE ENTRY edge가 accessibility_facilities 미지원 source(역-노선 정보)면 거부된다.
  const availableEntry = input.routeEdges.find((edge) => edge.id === "edge-entry-sadang-seoul-4");
  availableEntry.accessibilityStatus = "AVAILABLE";
  availableEntry.sourceId = "seoulmetro-station-line-info";
  availableEntry.sourceSnapshotId = "seoulmetro-station-line-info-snapshot-20260621";

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /AVAILABLE ENTRY\/EXIT edge requires accessibility_facilities source/,
  );
});

test("AVAILABLE ENTRY edge rejects missing strict operational facility evidence", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-facility-evidence-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  useAccessibilitySourceForAvailableEdge(input, "edge-entry-sadang-seoul-4");

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /AVAILABLE ENTRY\/EXIT edge requires strict-eligible operational facility evidence/,
  );
});

test("AVAILABLE ENTRY edge rejects missing approved movement pathway", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-approved-pathway-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  useAccessibilitySourceForAvailableEdge(input, "edge-entry-sadang-seoul-4");
  const facility = input.facilityRows.find((row) => row.id === "facility-sadang-elevator-kric-1");
  facility.status = "NORMAL";
  facility.operationalStatus = "AVAILABLE";
  facility.statusMeaning = "OPERATOR_CONFIRMED";

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /AVAILABLE ENTRY\/EXIT edge requires approved movement pathway/,
  );
});

test("데이터팩 검증기는 AVAILABLE accessibility edge의 station-line source 우회를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-validator-source-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  const fixture = await importOfficialSourceInput(outputDir, await capitalPilotProductionSourceInput());
  // 빌드 후 edge를 AVAILABLE로 바꾸고 source를 accessibility_facilities 미지원(역-노선)으로 우회 → validator 거부.
  const builtEntry = fixture.packs[0].networkEdges.find((edge) => edge.id === "edge-entry-sadang-seoul-4");
  builtEntry.accessibilityStatus = "AVAILABLE";
  builtEntry.sourceId = "seoulmetro-station-line-info";
  builtEntry.sourceSnapshotId = "seoulmetro-station-line-info-snapshot-20260621";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--root",
        packOutputDir,
        "--require-production",
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires accessibility_facilities source/,
  );
});

test("데이터팩 검증기는 AVAILABLE accessibility edge의 station-line operational evidence 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-validator-facility-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  const fixture = await importOfficialSourceInput(outputDir, await capitalPilotProductionSourceInput());
  const edge = fixture.packs[0].networkEdges.find((row) => row.id === "edge-entry-sadang-seoul-4");
  edge.accessibilityStatus = "AVAILABLE";
  edge.sourceId = "kric-station-elevator";
  edge.sourceSnapshotId = "kric-station-elevator-snapshot-20260622";
  edge.providerRecordHash = sha256(`provider:${edge.id}:kric-station-elevator`);
  edge.evidenceHash = sha256(`evidence:${edge.id}:kric-station-elevator:2026-06-22T00:00:00.000Z`);
  edge.lastVerifiedAt = "2026-06-22T00:00:00.000Z";
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--root",
        packOutputDir,
        "--require-production",
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires strict-eligible operational facility evidence/,
  );
});

test("UNDER_MAINTENANCE ENTRY edge는 실측 보수중 시설 증거 없이는 거부된다 (#1996)", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-maintenance-missing-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  // 사당 UNDER_MAINTENANCE edge는 유지되나 보수중 상태 증거(probe)를 제거 → 검증 실패.
  input.accessibilityStatusEvidence = input.accessibilityStatusEvidence.filter(
    (row) => row.stationId !== "station-sadang",
  );

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /UNDER_MAINTENANCE ENTRY\/EXIT edge requires field-verified maintenance facility evidence/,
  );
});

test("NO_OFFICIAL_FEED ENTRY edge는 피드 부재 기록 증거 없이는 거부된다 (#1996)", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-nofeed-missing-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  // 상록수 NO_OFFICIAL_FEED edge는 유지되나 부재 기록(NOT_EXISTS probe)을 제거 → 검증 실패.
  input.accessibilityStatusEvidence = input.accessibilityStatusEvidence.filter(
    (row) => row.stationId !== "station-sangnoksu",
  );

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /NO_OFFICIAL_FEED ENTRY\/EXIT edge requires recorded absence-of-feed evidence/,
  );
});

test("NO_OFFICIAL_FEED ENTRY edge는 NOT_EXISTS이나 statusMeaning이 FEED_ABSENCE_RECORD가 아니면 거부된다 (#1998)", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-nofeed-statusmeaning-${Date.now()}`);
  const input = await capitalPilotProductionSourceInput();
  // 상록수 NO_OFFICIAL_FEED probe는 NOT_EXISTS로 남기되 statusMeaning을 피드 부재 기록이 아닌 값(시설 물리
  // 부재)으로 변조 → 임의 NOT_EXISTS로는 피드 부재 커버리지를 채울 수 없어야 하므로 검증 실패해야 한다.
  const probe = input.accessibilityStatusEvidence.find((row) => row.stationId === "station-sangnoksu");
  assert.equal(probe.evidenceKind, "NOT_EXISTS");
  probe.statusMeaning = "FACILITY_PHYSICALLY_ABSENT";
  probe.operationalStatus = "NOT_INSTALLED";

  await assert.rejects(
    importOfficialSourceInput(outputDir, input),
    /NO_OFFICIAL_FEED ENTRY\/EXIT edge requires recorded absence-of-feed evidence/,
  );
});

test("검증된 상태 3분류(AVAILABLE/UNDER_MAINTENANCE/NO_OFFICIAL_FEED) edge는 게시 게이트를 통과하고 UNKNOWN만 unverified로 남는다 (#1996)", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-verified-states-${Date.now()}`);
  const packOutputDir = path.join(outputDir, "pack");
  const fixture = await importOfficialSourceInput(outputDir, await capitalPilotProductionSourceInput());
  const fixturePath = path.join(outputDir, "fixture.json");
  // 사당 UNDER_MAINTENANCE·상록수 NO_OFFICIAL_FEED edge는 strict_route_eligible 대상이 아니다.
  const sadangEntry = fixture.packs[0].networkEdges.find((e) => e.id === "edge-entry-sadang-seoul-4");
  const sangnoksuEntry = fixture.packs[0].networkEdges.find((e) => e.id === "edge-entry-sangnoksu-seoul-4");
  assert.equal(sadangEntry.accessibilityStatus, "UNDER_MAINTENANCE");
  assert.equal(sangnoksuEntry.accessibilityStatus, "NO_OFFICIAL_FEED");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );
  const gate = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
      "--require-production",
    ],
    { cwd: root, env: productionEnv },
  );
  const report = JSON.parse(gate.stdout.trim().split("\n").at(-1));
  assert.deepEqual(report.unverifiedAccessibilityCoverageEdges, []);
  assert.equal(report.generatedConnectorGapCount, 0);
});

test("데이터팩 검증기는 AVAILABLE accessibility edge의 승인된 이동 경로 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-validator-pathway-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  const fixture = await importOfficialSourceInput(outputDir, productionSourceIngestInput());
  makeProductionSourceFixtureStrictCoverageValid(fixture);
  fixture.packs[0].stationPathwayNodes = [];
  fixture.packs[0].stationPathwayEdges = [];
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--root",
        packOutputDir,
        "--require-production",
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires approved movement pathway/,
  );
});

test("데이터팩 검증기는 STAIR pathway를 승인된 접근성 이동 경로로 인정하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-accessibility-edge-validator-stair-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutputDir = path.join(outputDir, "pack");
  const fixture = await importOfficialSourceInput(outputDir, productionSourceIngestInput());
  makeProductionSourceFixtureStrictCoverageValid(fixture);
  for (const edge of fixture.packs[0].stationPathwayEdges) {
    edge.edgeType = "STAIR";
    edge.includesStairs = false;
  }
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutputDir],
    { cwd: root, env: productionEnv },
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--root",
        packOutputDir,
        "--require-production",
      ],
      { cwd: root, env: productionEnv },
    ),
    /AVAILABLE ENTRY\/EXIT edge requires approved movement pathway/,
  );
});

test("수도권 pilot production source input은 검증된 접근성 상태로 게시 게이트를 통과한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-capital-pilot-production-source-${Date.now()}`);
  const inputPath = "tools/datapack/inputs/capital-pilot-production-source-input.json";
  const importedFixturePath = path.join(outputDir, "capital-pilot-production.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const input = JSON.parse(await readFile(path.join(root, inputPath), "utf8"));
  assert.equal(input.manifest.releaseSequence, undefined);
  assert.equal(input.manifest.publishedAt, undefined);
  assert.equal(input.manifest.expiresAt, undefined);
  assert.deepEqual(input.routeEdges.filter((edge) => edge.edgeType === "RIDE"), []);
  assert.equal(input.routeGraphTopologyPolicy, undefined);
  const adjacencySafeInput = input;
  const adjacencySafeInputPath = path.join(outputDir, "capital-pilot-production-adjacency-safe.json");
  await writeFile(adjacencySafeInputPath, `${JSON.stringify(adjacencySafeInput, null, 2)}\n`);

  const summaryRideFixtureOnlyInput = withProductionSummaryRideEdges(input);
  const summaryRideFixtureOnlyInputPath = path.join(outputDir, "summary-ride-fixture-only.json");
  await writeFile(summaryRideFixtureOnlyInputPath, `${JSON.stringify(summaryRideFixtureOnlyInput, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        summaryRideFixtureOnlyInputPath,
        "--output",
        path.join(outputDir, "summary-ride-fixture-only-output.json"),
      ],
      { cwd: root },
    ),
    /production routeEdges non-adjacent EXPRESS summary edge is fixture-only/,
  );

  const lowercaseRideEdgeInput = JSON.parse(JSON.stringify(withProductionSummaryRideEdges(input)));
  lowercaseRideEdgeInput.routeEdges = lowercaseRideEdgeInput.routeEdges.map((edge) =>
    edge.edgeType === "RIDE" ? { ...edge, edgeType: "ride" } : edge,
  );
  const lowercaseRideEdgeInputPath = path.join(outputDir, "lowercase-ride-summary-policy.json");
  await writeFile(lowercaseRideEdgeInputPath, `${JSON.stringify(lowercaseRideEdgeInput, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        lowercaseRideEdgeInputPath,
        "--output",
        path.join(outputDir, "lowercase-ride-summary-policy-fixture.json"),
      ],
      { cwd: root },
    ),
    /production routeEdges non-adjacent EXPRESS summary edge is fixture-only/,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      adjacencySafeInputPath,
      "--output",
      importedFixturePath,
    ],
    { cwd: root },
  );
  const importedFixture = JSON.parse(await readFile(importedFixturePath, "utf8"));
  assert.equal(importedFixture.packs[0].requiredTables.includes("route_map_positions"), true);
  assert.equal(importedFixture.packs[0].minimumTableRows.route_map_positions, 2);
  assert.equal(importedFixture.packs[0].routeMapPositions.length, 2);
  assert.deepEqual(
    importedFixture.packs[0].routeMapPositions.map((position) => ({
      stationId: position.stationId,
      lineId: position.lineId,
      sourceId: position.sourceId,
      sourceSha256: position.sourceSha256,
      labelPolygonCount: position.labelPolygon.length,
      updatedAt: position.updatedAt,
    })),
    [
      {
        stationId: "station-sangnoksu",
        lineId: "seoul-4",
        sourceId: "seoulmetro-cyberstation-route-map",
        sourceSha256: "7370b4db2d2f398f46c55314b71d7335c77ec6745fd388793804874447cd25e0",
        labelPolygonCount: 4,
        updatedAt: "2026-06-28T00:00:00.000Z",
      },
      {
        stationId: "station-sadang",
        lineId: "seoul-4",
        sourceId: "seoulmetro-cyberstation-route-map",
        sourceSha256: "7370b4db2d2f398f46c55314b71d7335c77ec6745fd388793804874447cd25e0",
        labelPolygonCount: 4,
        updatedAt: "2026-06-28T00:00:00.000Z",
      },
    ],
  );
  const scheduleScopeFixture = JSON.parse(JSON.stringify(importedFixture));
  scheduleScopeFixture.packs[0].sourceInventory.find(
    (source) => source.id === "kric-subway-timetable",
  ).coverageScope.operatorIds = ["seoul-metro", "korail"];
  const scheduleScopeFixturePath = path.join(outputDir, "schedule-scope-fixture.json");
  const scheduleScopePackDir = path.join(outputDir, "schedule-scope-pack");
  await writeFile(scheduleScopeFixturePath, `${JSON.stringify(scheduleScopeFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      scheduleScopeFixturePath,
      "--output",
      scheduleScopePackDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const scheduleScopeProvenance = JSON.parse(
    await readFile(path.join(scheduleScopePackDir, "current.provenance.json"), "utf8"),
  );
  const serviceCalendarRecord = scheduleScopeProvenance.packs[0].records.find(
    (record) =>
      record.sourceId === "kric-subway-timetable" &&
      record.entityType === "service_calendar" &&
      record.field === "service_calendar",
  );
  assert.ok(serviceCalendarRecord);
  assert.deepEqual(serviceCalendarRecord.coverageScope.operatorIds, ["seoul-metro"]);

  const scheduleExtrasInput = JSON.parse(JSON.stringify(adjacencySafeInput));
  scheduleExtrasInput.serviceCalendarDates = [
    {
      serviceId: "holiday-kric",
      date: "20260101",
      exceptionType: 1,
    },
  ];
  scheduleExtrasInput.transitFrequencies = [
    {
      tripId: scheduleExtrasInput.transitTrips[0].id,
      startTimeSeconds: 18000,
      endTimeSeconds: 21600,
      headwaySeconds: 600,
      exactTimes: false,
    },
  ];
  const scheduleExtrasInputPath = path.join(outputDir, "schedule-extras-input.json");
  const scheduleExtrasFixturePath = path.join(outputDir, "schedule-extras-fixture.json");
  const scheduleExtrasPackDir = path.join(outputDir, "schedule-extras-pack");
  await writeFile(scheduleExtrasInputPath, `${JSON.stringify(scheduleExtrasInput, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      scheduleExtrasInputPath,
      "--output",
      scheduleExtrasFixturePath,
    ],
    { cwd: root },
  );
  const scheduleExtrasFixture = JSON.parse(await readFile(scheduleExtrasFixturePath, "utf8"));
  assert.equal(scheduleExtrasFixture.packs[0].serviceCalendarDates[0].sourceId, "kric-subway-timetable");
  assert.equal(scheduleExtrasFixture.packs[0].transitFrequencies[0].sourceId, "kric-subway-timetable");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      scheduleExtrasFixturePath,
      "--output",
      scheduleExtrasPackDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const scheduleExtrasProvenance = JSON.parse(
    await readFile(path.join(scheduleExtrasPackDir, "current.provenance.json"), "utf8"),
  );
  const scheduleExtraKricRecords = scheduleExtrasProvenance.packs[0].records.filter(
    (record) => record.sourceId === "kric-subway-timetable",
  );
  assert.ok(
    scheduleExtraKricRecords.some(
      (record) => record.entityType === "service_calendar_date" && record.field === "calendar_date",
    ),
  );
  assert.ok(
    scheduleExtraKricRecords.some(
      (record) => record.entityType === "transit_frequency" && record.field === "frequency",
    ),
  );
  for (const testCase of [
    {
      name: "string-label-dx",
      mutate(position) {
        position.labelDx = "0";
      },
      expected: /routeMapPositions\.labelDx must be an integer/,
    },
    {
      name: "number-up-path",
      mutate(position) {
        position.upPath = 1;
      },
      expected: /routeMapPositions\.upPath must be a string/,
    },
  ]) {
    const invalidRouteMapPositionInput = JSON.parse(JSON.stringify(adjacencySafeInput));
    testCase.mutate(invalidRouteMapPositionInput.routeMapPositions[0]);
    const invalidRouteMapPositionInputPath = path.join(outputDir, `${testCase.name}-input.json`);
    const invalidRouteMapPositionOutputPath = path.join(outputDir, `${testCase.name}-fixture.json`);
    await writeFile(invalidRouteMapPositionInputPath, `${JSON.stringify(invalidRouteMapPositionInput, null, 2)}\n`);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/datapack/import-official-sources.mjs",
          "--inventory",
          "tools/datapack/source-inventory.json",
          "--input",
          invalidRouteMapPositionInputPath,
          "--output",
          invalidRouteMapPositionOutputPath,
        ],
        { cwd: root },
      ),
      testCase.expected,
    );
  }

  const validatorBypassFixture = JSON.parse(JSON.stringify(importedFixture));
  validatorBypassFixture.packs[0].networkEdges.push(
    ...productionSummaryRideEdges("LOCAL").map((edge) => ({
      id: edge.id,
      fromNodeId:
        edge.from.sourceStationCode === "448"
          ? "station-sangnoksu:seoul-4:LOCAL"
          : "station-sadang:seoul-4:LOCAL",
      toNodeId:
        edge.to.sourceStationCode === "433"
          ? "station-sadang:seoul-4:LOCAL"
          : "station-sangnoksu:seoul-4:LOCAL",
      durationSeconds: edge.durationSeconds,
      distanceMeters: edge.distanceMeters,
      edgeType: edge.edgeType,
      servicePattern: edge.servicePattern,
      includesStairs: edge.includesStairs,
      stairAccessState: edge.stairAccessState,
      accessibilityStatus: edge.accessibilityStatus,
      reliabilityScore: edge.reliabilityScore,
      sourceId: edge.sourceId,
      sourceSnapshotId: edge.sourceSnapshotId,
      providerRecordHash: edge.providerRecordHash,
      provenanceKind: edge.provenanceKind,
      verificationStatus: edge.verificationStatus,
      lastVerifiedAt: edge.lastVerifiedAt,
      evidenceHash: edge.evidenceHash,
    })),
  );
  const validatorBypassFixturePath = path.join(outputDir, "validator-bypass-local-ride.json");
  const validatorBypassPackDir = path.join(outputDir, "validator-bypass-local-ride-pack");
  await writeFile(validatorBypassFixturePath, `${JSON.stringify(validatorBypassFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      validatorBypassFixturePath,
      "--output",
      validatorBypassPackDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(validatorBypassPackDir, "current.json"),
        "--root",
        validatorBypassPackDir,
        "--require-production",
      ],
      { cwd: root, env: productionEnv },
    ),
    /network_edges LOCAL RIDE edge must connect adjacent station-line sequences/,
  );

  const nonAdjacentInput = {
    ...input,
    routeEdges: [...productionSummaryRideEdges("LOCAL"), ...input.routeEdges],
  };
  const nonAdjacentInputPath = path.join(outputDir, "non-adjacent-local-ride-input.json");
  const nonAdjacentFixturePath = path.join(outputDir, "non-adjacent-local-ride.json");
  await writeFile(nonAdjacentInputPath, `${JSON.stringify(nonAdjacentInput, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        nonAdjacentInputPath,
        "--output",
        nonAdjacentFixturePath,
      ],
      { cwd: root },
    ),
    /production routeEdges LOCAL RIDE edge must connect adjacent station-line sequences/,
  );

  const missingFacilityInputPath = path.join(outputDir, "capital-pilot-production-missing-facility.json");
  await writeFile(
    missingFacilityInputPath,
    `${JSON.stringify(
      {
        ...adjacencySafeInput,
        facilityRows: [],
      },
      null,
      2,
    )}\n`,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        missingFacilityInputPath,
        "--output",
        path.join(outputDir, "missing-facility.json"),
      ],
      { cwd: root },
    ),
    /selected production source has no row provenance: kric-station-elevator/,
  );

  const missingWheelchairLiftEvidenceInputPath = path.join(
    outputDir,
    "capital-pilot-production-missing-wheelchair-lift-evidence.json",
  );
  await writeFile(
    missingWheelchairLiftEvidenceInputPath,
    `${JSON.stringify(
      {
        ...adjacencySafeInput,
        facilityRows: adjacencySafeInput.facilityRows.filter((row) => row.id !== "facility-sadang-wheelchair-lift-kric-1"),
      },
      null,
      2,
    )}\n`,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        missingWheelchairLiftEvidenceInputPath,
        "--output",
        path.join(outputDir, "missing-wheelchair-lift-evidence.json"),
      ],
      { cwd: root },
    ),
    /production facility evidence missing: station-sadang:seoul-4:WHEELCHAIR_LIFT/,
  );

  const unrealisticRideSpeedFixture = JSON.parse(JSON.stringify(importedFixture));
  unrealisticRideSpeedFixture.packs[0].networkEdges.push(
    ...productionSummaryNetworkEdges("EXPRESS").map((edge) => ({
      ...edge,
      durationSeconds: 420,
    })),
  );
  const unrealisticRideSpeedFixturePath = path.join(outputDir, "unrealistic-ride-speed.json");
  const unrealisticRideSpeedPackDir = path.join(outputDir, "unrealistic-ride-speed-pack");
  await writeFile(unrealisticRideSpeedFixturePath, `${JSON.stringify(unrealisticRideSpeedFixture, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      unrealisticRideSpeedFixturePath,
      "--output",
      unrealisticRideSpeedPackDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest",
        path.join(unrealisticRideSpeedPackDir, "current.json"),
        "--root",
        unrealisticRideSpeedPackDir,
        "--require-production",
      ],
      { cwd: root, env: productionEnv },
    ),
    /network_edges ride speed is outside production bounds/,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      importedFixturePath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  const routeGraphTopologyReportPath = path.join(outputDir, "route-graph-topology-report.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-route-graph-topology-report.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
      "--output",
      routeGraphTopologyReportPath,
    ],
    { cwd: root },
  );
  const routeGraphTopologyReport = JSON.parse(await readFile(routeGraphTopologyReportPath, "utf8"));
  assert.equal(routeGraphTopologyReport.summary.nonAdjacentExpressRideViolationCount, 0);
  assert.deepEqual(
    routeGraphTopologyReport.packs[0].violations.nonAdjacentExpressRide.map((violation) => violation.edgeId),
    [],
  );

  // #1996: 게이트 재설계 후 사당·상록수 4호선 ENTRY/EXIT edge는 검증된 상태(UNDER_MAINTENANCE/NO_OFFICIAL_FEED)로
  // 실측 기록돼 게시 게이트를 exit 0으로 통과한다. 미검증(UNKNOWN) edge가 남아있지 않으므로 coverage gap이 없다.
  const productionGate = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
      "--require-production",
    ],
    { cwd: root, env: productionEnv },
  );
  const strictCoverageReport = JSON.parse(productionGate.stdout.trim().split("\n").at(-1));
  assert.deepEqual(strictCoverageReport.unverifiedAccessibilityCoverageEdges, []);
  assert.equal(strictCoverageReport.entry.missingCount, 0);
  assert.equal(strictCoverageReport.exit.missingCount, 0);
  assert.equal(strictCoverageReport.entry.verified, 2);
  assert.equal(strictCoverageReport.exit.verified, 2);
  assert.equal(strictCoverageReport.generatedConnectorGapCount, 0);

  const coverageReportPath = path.join(outputDir, "capital-pilot-coverage-summary.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/capital-pilot-coverage-targets.json",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--provenance",
      path.join(packOutputDir, "current.provenance.json"),
      "--output",
      coverageReportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );
  const coverageReport = JSON.parse(await readFile(coverageReportPath, "utf8"));
  assert.equal(coverageReport.summary.coverageComplete, true);
  assert.equal(coverageReport.summary.missingRequirements, 0);
  assert.equal(coverageReport.summary.coverageRatio, 1);
  const scheduleCoverage = coverageReport.requirements.find(
    (requirement) => requirement.sourceDomain === "schedule_timetable",
  );
  assert.equal(scheduleCoverage.status, "covered");
  assert.deepEqual(scheduleCoverage.sourceIds, ["kric-subway-timetable"]);
  assert.deepEqual(scheduleCoverage.missingFields, []);

  const manifest = JSON.parse(await readFile(path.join(packOutputDir, "current.json"), "utf8"));
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.channel, "production");
  assert.equal(manifest.keyId, "production-v1");
  assert.deepEqual(manifest.activePack, { id: "capital", version: "1" });
  assert.equal(Number.isInteger(manifest.releaseSequence), true);
  assert.ok(Date.parse(manifest.expiresAt) > Date.parse(manifest.publishedAt));
  assert.equal(manifest.signature.algorithm, "rsa-sha256-manifest-v2");
  assert.equal(manifest.packs[0].artifactKind, "production");
  assert.equal(manifest.packs[0].signature.algorithm, "rsa-sha256-pack-manifest-v2");
  assert.equal(manifest.packs[0].routeRegressionScope, undefined);
  assert.deepEqual(manifest.packs[0].representativeRouteRegressions, []);
  const database = new DatabaseSync(path.join(packOutputDir, "catalog", "capital-v1.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare(`
          SELECT id, accessibility_status
          FROM network_edges
          WHERE edge_type IN ('ENTRY', 'EXIT')
          ORDER BY id
        `)
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: "edge-entry-sadang-seoul-4",
          accessibility_status: "UNDER_MAINTENANCE",
        },
        {
          id: "edge-entry-sangnoksu-seoul-4",
          accessibility_status: "NO_OFFICIAL_FEED",
        },
        {
          id: "edge-exit-sadang-seoul-4",
          accessibility_status: "UNDER_MAINTENANCE",
        },
        {
          id: "edge-exit-sangnoksu-seoul-4",
          accessibility_status: "NO_OFFICIAL_FEED",
        },
      ],
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM service_calendars").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM service_calendar_dates").get().count, 28);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_trips").get().count, 466);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_stop_times").get().count, 932);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_feed_info").get().count, 1);
  } finally {
    database.close();
  }

  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const routeMapRecords = provenance.packs[0].records.filter(
    (record) => record.sourceId === "seoulmetro-cyberstation-route-map",
  );
  assert.equal(routeMapRecords.length, 4);
  assert.equal(
    provenance.packs[0].records.filter(
      (record) => record.entityType === "facility" && record.field === "status",
    ).length,
    6,
  );
  assert.deepEqual(
    [...new Set(
      provenance.packs[0].records
        .filter((record) => record.sourceId === "kric-subway-timetable")
        .map((record) => record.field),
    )].sort(),
    ["calendar_date", "feed_info", "route", "service_calendar", "stop_time", "trip"],
  );

  const coverageGapReportPath = path.join(outputDir, "coverage-gap-report.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--provenance",
      path.join(packOutputDir, "current.provenance.json"),
      "--output",
      coverageGapReportPath,
      "--allow-gaps",
    ],
    { cwd: root },
  );
  const coverageGapReport = JSON.parse(await readFile(coverageGapReportPath, "utf8"));
  const capitalRouteMapCoverage = coverageGapReport.requirements.find(
    (entry) =>
      entry.regionId === "capital" &&
      entry.operatorId === "seoul-metro" &&
      entry.lineId === "seoul-4" &&
      entry.sourceDomain === "route_map_positions",
  );
  assert.equal(capitalRouteMapCoverage.status, "MISSING");
  assert.deepEqual(capitalRouteMapCoverage.missingFields, ["route_map_position", "route_map_label_polygon"]);

  // #1999: release-scope 평가 모드는 게시 차단을 게시 범위(capital·seoul-metro × capitalPilotTargets domains) 내 gap만
  // 기준으로 판정한다. 현행 인벤토리는 전국 gap 다수 + scope 내 gap 0이므로, --allow-gaps 없이도 exit 0으로 통과하되
  // 전국 gap 수치는 은폐 없이 그대로 기록해야 한다.
  const releaseScopeReportPath = path.join(outputDir, "release-scope-coverage-gap-report.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--provenance",
      path.join(packOutputDir, "current.provenance.json"),
      "--release-scope",
      "apps/mobile/release/production-datapack-scope.json",
      "--output",
      releaseScopeReportPath,
    ],
    { cwd: root },
  );
  const releaseScopeReport = JSON.parse(await readFile(releaseScopeReportPath, "utf8"));
  // 게시 범위(in-scope) gap은 0 → 게시 게이트 통과.
  assert.equal(releaseScopeReport.summary.releaseScope.coverageComplete, true);
  assert.equal(releaseScopeReport.summary.releaseScope.missingRequirements, 0);
  assert.equal(releaseScopeReport.summary.releaseScope.scopeId, "capital_pilot_android_v1");
  assert.deepEqual(releaseScopeReport.summary.releaseScope.regionIds, ["capital"]);
  assert.deepEqual(releaseScopeReport.summary.releaseScope.operatorIds, ["seoul-metro"]);
  assert.deepEqual(releaseScopeReport.summary.releaseScope.sourceDomains, [
    "accessibility_facilities",
    "schedule_timetable",
    "station_line_membership",
  ]);
  // 전국 gap은 은폐 금지 — nationwide 수치가 그대로 기록되고 여전히 다수의 gap이 존재한다.
  assert.ok(releaseScopeReport.summary.missingRequirements > 0);
  assert.equal(
    releaseScopeReport.summary.nationwide.missingRequirements,
    releaseScopeReport.summary.missingRequirements,
  );
  // in-scope requirement는 정확히 3개(capital·seoul-metro × 3 pilot domain)로 태깅된다.
  const inScopeRequirements = releaseScopeReport.releaseScopeRequirements;
  assert.equal(inScopeRequirements.length, 3);
  assert.ok(inScopeRequirements.every((entry) => entry.inReleaseScope === true));
  assert.ok(inScopeRequirements.every((entry) => entry.status === "covered"));

  // Negative 증명: 워크플로와 동일하게 provenance-backed 상태에서 scope 내 gap을 주입한다. 게시 pack의 provenance에서
  // station_line_membership OFFICIAL 레코드를 제거하면 in-scope gap이 생겨 release-scope 게이트가 exit 1로 실패한다.
  const scopeGapProvenance = JSON.parse(
    await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"),
  );
  for (const pack of scopeGapProvenance.packs) {
    pack.records = pack.records.filter(
      (record) => !["line", "station_name", "station_code"].includes(record.field),
    );
  }
  const scopeGapProvenancePath = path.join(outputDir, "scope-gap-provenance.json");
  await writeFile(scopeGapProvenancePath, `${JSON.stringify(scopeGapProvenance, null, 2)}\n`);
  const scopeGapReportPath = path.join(outputDir, "scope-gap-coverage-gap-report.json");
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/nationwide-coverage-targets.json",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--provenance",
        scopeGapProvenancePath,
        "--release-scope",
        "apps/mobile/release/production-datapack-scope.json",
        "--output",
        scopeGapReportPath,
      ],
      { cwd: root },
    ),
    /in-scope coverage gaps remain/,
  );
  const scopeGapReport = JSON.parse(await readFile(scopeGapReportPath, "utf8"));
  assert.ok(scopeGapReport.summary.releaseScope.missingRequirements > 0);
  assert.equal(scopeGapReport.summary.releaseScope.coverageComplete, false);
  // 주입한 station_line_membership gap이 in-scope requirement로 정확히 missing 처리된다.
  const injectedGap = scopeGapReport.releaseScopeRequirements.find(
    (entry) =>
      entry.regionId === "capital" &&
      entry.operatorId === "seoul-metro" &&
      entry.sourceDomain === "station_line_membership",
  );
  assert.equal(injectedGap.inReleaseScope, true);
  assert.equal(injectedGap.status, "missing");

  // #2000: scope의 region/operator id가 pilot targets와 하나도 매칭되지 않으면 in-scope requirement가 0개가 되어
  // missingRequirements === 0으로 공허 통과할 위험이 있다. fail closed — 존재하지 않는 regionId scope는 exit 1로 실패한다.
  const emptyScope = JSON.parse(await readFile("apps/mobile/release/production-datapack-scope.json", "utf8"));
  emptyScope.supportScope.regionIds = ["nonexistent-region"];
  const emptyScopePath = path.join(outputDir, "empty-release-scope.json");
  await writeFile(emptyScopePath, `${JSON.stringify(emptyScope, null, 2)}\n`);
  const emptyScopeReportPath = path.join(outputDir, "empty-scope-coverage-gap-report.json");
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/nationwide-coverage-targets.json",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--manifest",
        path.join(packOutputDir, "current.json"),
        "--provenance",
        path.join(packOutputDir, "current.provenance.json"),
        "--release-scope",
        emptyScopePath,
        "--output",
        emptyScopeReportPath,
      ],
      { cwd: root },
    ),
    /release scope matched zero coverage requirements/,
  );
});

test("관리자 검수 NORMAL override는 production 시설 provenance와 validator를 통과한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-production-admin-normal-override-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const importedFixturePath = path.join(outputDir, "catalog-fixture.imported.json");
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const reviewedFixturePath = path.join(outputDir, "catalog-fixture.reviewed.json");
  const packOutputDir = path.join(outputDir, "pack");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(productionSourceIngestInput(), null, 2)}\n`);
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-22T01:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-recovered-kric-elevator",
            facilityId: "facility-sangnoksu-elevator-kric-1",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-22T00:30:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      importedFixturePath,
    ],
    { cwd: root },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      importedFixturePath,
      "--overrides",
      overridePath,
      "--output",
      reviewedFixturePath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(reviewedFixturePath, "utf8"));
  const reviewedFacility = reviewedFixture.packs[0].facilities.find(
    (facility) => facility.id === "facility-sangnoksu-elevator-kric-1",
  );
  assert.equal(reviewedFacility.status, "NORMAL");
  assert.equal(reviewedFacility.statusMeaning, "REALTIME_OPERATION");
  assert.equal(reviewedFacility.operationalStatus, "AVAILABLE");
  assert.equal(reviewedFacility.verifiedAt, "2026-06-22T00:30:00.000Z");
  assert.equal(reviewedFacility.retrievedAt, "2026-06-22T01:00:00.000Z");
  makeProductionSourceFixtureStrictCoverageValid(reviewedFixture);
  await writeFile(reviewedFixturePath, `${JSON.stringify(reviewedFixture, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      reviewedFixturePath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
});

test("승인된 관리자 검수 결과는 다음 data pack fixture 시설 상태에 반영된다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-${Date.now()}`);
  const inputPath = path.join(outputDir, "catalog-fixture.json");
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile("tools/datapack/fixtures/catalog-fixture.json", inputPath);
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-broken-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      inputPath,
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedFacility = reviewedFixture.packs[0].facilities.find(
    (facility) => facility.id === "facility-sangnoksu-elevator-1",
  );
  const reviewedInternalRouteEdge = reviewedFixture.packs[0].internalRouteEdges.find(
    (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
  );
  const reviewedSummary = reviewedFixture.packs[0].stationAccessibilitySummaries.find(
    (summary) => summary.stationId === "station-sangnoksu",
  );
  assert.equal(reviewedFacility.status, "BROKEN");
  assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "UNAVAILABLE");
  assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 제한");
  assert.equal(reviewedSummary.warning, "1번 출구 엘리베이터 고장으로 우회가 필요합니다.");
  assert.equal(reviewedFixture.packs[0].metadata.adminReviewOverrideCount, "1");
  assert.equal(reviewedFixture.packs[0].metadata.adminReviewOverrideSource, "facility-report-admin-review");

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );

  const database = new DatabaseSync(path.join(packOutputDir, "catalog", "capital-v1.sqlite"), { readOnly: true });
  try {
    const row = database
      .prepare("SELECT status FROM facilities WHERE id = ?")
      .get("facility-sangnoksu-elevator-1");
    assert.equal(row.status, "BROKEN");
    const routeEdge = database
      .prepare("SELECT accessibility_status FROM internal_route_edges WHERE id = ?")
      .get("edge-sangnoksu-concourse-exit-1");
    assert.equal(routeEdge.accessibility_status, "UNAVAILABLE");
    const summary = database
      .prepare("SELECT summary, warning FROM station_accessibility_summaries WHERE station_id = ?")
      .get("station-sangnoksu");
    assert.equal(summary.summary, "1번 출구 엘리베이터 이용 제한");
    assert.equal(summary.warning, "1번 출구 엘리베이터 고장으로 우회가 필요합니다.");
  } finally {
    database.close();
  }
});

test("관리자 검수 override는 unavailable strict step-free transfer reference를 비운다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-pathway-transfer-${Date.now()}`);
  const inputPath = path.join(outputDir, "catalog-fixture.json");
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile("tools/datapack/fixtures/catalog-fixture.json", inputPath);
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-broken-transfer-elevator",
            facilityId: "facility-sadang-transfer-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      inputPath,
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedPathwayEdge = reviewedFixture.packs[0].stationPathwayEdges.find(
    (edge) => edge.id === "path-edge-sadang-4-to-2-step-free",
  );
  const reviewedTransferRule = reviewedFixture.packs[0].transferRules.find(
    (rule) => rule.id === "transfer-sadang-seoul-4-to-seoul-2",
  );
  assert.equal(reviewedPathwayEdge.accessibilityStatus, "UNAVAILABLE");
  assert.equal(reviewedTransferRule.strictStepFreePathwayEdgeId, null);

  const packOutputDir = path.join(outputDir, "pack");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      outputPath,
      "--output",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/validate-datapack.mjs",
      "--manifest",
      path.join(packOutputDir, "current.json"),
      "--root",
      packOutputDir,
    ],
    { cwd: root, env: productionEnv },
  );
});

test("관리자 검수 override는 fixture에 없는 시설 id를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-missing-facility-${Date.now()}`);
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-missing-facility",
            facilityId: "facility-missing",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-admin-review-overrides.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--overrides",
        overridePath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /facilityStatusUpdates\.facilityId was not found in fixture: facility-missing/,
  );
});

test("production 관리자 검수 override는 legacy transit_master_overrides 입력을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-legacy-${Date.now()}`);
  const overridePath = path.join(outputDir, "legacy-transit-master-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "transit-master-overrides",
        schemaVersion: 1,
        ledgerSource: "transit_master_overrides",
        source: "transit_master_overrides",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "legacy-effective-master-row",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-admin-review-overrides.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--overrides",
        overridePath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /transit_master_overrides.*manual_overrides ledger/s,
  );
});

test("관리자 검수 override는 복구 상태를 route 접근성에 다시 반영한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-recovered-${Date.now()}`);
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-broken-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
          {
            reportId: "report-admin-approved-recovered-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:10:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedFacility = reviewedFixture.packs[0].facilities.find(
    (facility) => facility.id === "facility-sangnoksu-elevator-1",
  );
  const reviewedInternalRouteEdge = reviewedFixture.packs[0].internalRouteEdges.find(
    (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
  );
  const reviewedSummary = reviewedFixture.packs[0].stationAccessibilitySummaries.find(
    (summary) => summary.stationId === "station-sangnoksu",
  );
  assert.equal(reviewedFacility.status, "NORMAL");
  assert.equal(reviewedFacility.statusMeaning, "REALTIME_OPERATION");
  assert.equal(reviewedFacility.operationalStatus, "AVAILABLE");
  assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "AVAILABLE");
  assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 가능");
  assert.equal(reviewedSummary.warning, "");
});

test("관리자 검수 override는 같은 시설의 최신 reviewedAt 결과만 적용한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-latest-${Date.now()}`);
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-recovered-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:10:00.000Z",
          },
          {
            reportId: "report-admin-approved-older-broken-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedFacility = reviewedFixture.packs[0].facilities.find(
    (facility) => facility.id === "facility-sangnoksu-elevator-1",
  );
  const reviewedInternalRouteEdge = reviewedFixture.packs[0].internalRouteEdges.find(
    (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
  );
  const reviewedSummary = reviewedFixture.packs[0].stationAccessibilitySummaries.find(
    (summary) => summary.stationId === "station-sangnoksu",
  );
  assert.equal(reviewedFacility.status, "NORMAL");
  assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "AVAILABLE");
  assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 가능");
  assert.equal(reviewedSummary.warning, "");
  assert.equal(reviewedFixture.packs[0].metadata.adminReviewOverrideCount, "1");
});

test("관리자 검수 override는 같은 역의 제한 시설 상태를 정상 시설로 지우지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-station-summary-${Date.now()}`);
  const inputPath = path.join(outputDir, "catalog-fixture.json");
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].facilities.push({
    id: "facility-sangnoksu-elevator-2",
    stationId: "station-sangnoksu",
    exitId: "exit-sangnoksu-1",
    type: "ELEVATOR",
    name: "2번 출구 엘리베이터",
    status: "NORMAL",
    floorFrom: "B1",
    floorTo: "1F",
    description: "대합실과 1번 출구 지상을 연결",
  });
  await writeFile(inputPath, `${JSON.stringify(fixture, null, 2)}\n`);
  await writeFile(
    overridePath,
    `${JSON.stringify(
      {
        artifactKind: "datapack-manual-override-ledger",
        schemaVersion: 1,
        ledgerSource: "manual_overrides",
        source: "facility-report-admin-review",
        exportedAt: "2026-06-21T00:00:00.000Z",
        facilityStatusUpdates: [
          {
            reportId: "report-admin-approved-broken-elevator",
            facilityId: "facility-sangnoksu-elevator-1",
            status: "BROKEN",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:00:00.000Z",
          },
          {
            reportId: "report-admin-approved-normal-second-elevator",
            facilityId: "facility-sangnoksu-elevator-2",
            status: "NORMAL",
            reviewedBy: "admin-user",
            reviewedAt: "2026-06-21T00:01:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/apply-admin-review-overrides.mjs",
      "--fixture",
      inputPath,
      "--overrides",
      overridePath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
  const reviewedSummary = reviewedFixture.packs[0].stationAccessibilitySummaries.find(
    (summary) => summary.stationId === "station-sangnoksu",
  );
  const reviewedInternalRouteEdge = reviewedFixture.packs[0].internalRouteEdges.find(
    (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
  );
  assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "UNAVAILABLE");
  assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 제한");
  assert.equal(reviewedSummary.warning, "1번 출구 엘리베이터 고장으로 우회가 필요합니다.");
  assert.equal(reviewedFixture.packs[0].metadata.adminReviewOverrideCount, "2");
});

test("공식 source ingest adapter는 mapping 없는 source row를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-missing-mapping-${Date.now()}`);
  const input = sourceIngestInput();
  input.stationLineRows[0].sourceStationCode = "missing-code";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /source mapping missing: seoulmetro-station-line-info:missing-code:seoul-4/,
  );
});

test("공식 source ingest adapter는 retired station id 재사용을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-retired-id-${Date.now()}`);
  const input = sourceIngestInput();
  input.stationMappings[0].stationId = "station-retired-demo";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /station id reuse is forbidden: station-retired-demo/,
  );
});

test("공식 source ingest adapter는 같은 stable station-line의 상충 row를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-station-line-conflict-${Date.now()}`);
  const input = sourceIngestInput();
  input.stationLineRows[1].platformInfo = "충돌 승강장";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /station line mapping conflict: station-sangnoksu:seoul-4.platformInfo/,
  );
});

test("공식 source ingest adapter는 inventory header가 input과 다르면 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-inventory-header-${Date.now()}`);
  const inventoryPath = path.join(outputDir, "source-inventory.json");
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  inventory.region = "busan";
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        inventoryPath,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /inventory\.region must match input\.region: busan !== capital/,
  );
});

test("공식 source ingest adapter는 facility row의 mapping 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-facility-mapping-${Date.now()}`);
  const input = sourceIngestInput();
  input.facilityRows[0].station.sourceStationCode = "missing-code";
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /source mapping missing: seoulmetro-station-line-info:missing-code:seoul-4/,
  );
});

test("공식 source ingest adapter는 KRIC 접근성 facility row를 stable station에 연결한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-facility-ingest-${Date.now()}`);
  const input = kricAccessibilityFacilitySourceIngestInput();
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(
    fixture.packs[0].sourceInventory.map((source) => source.id).sort(),
    [
      "kric-disabled-toilet",
      "kric-station-elevator",
      "kric-station-escalator",
      "kric-wheelchair-lift-location",
      "molit-urban-rail-full-route",
    ],
  );
  assert.deepEqual(
    fixture.packs[0].facilities.map(({ id, stationId, type, status }) => ({ id, stationId, type, status })),
    [
      {
        id: "facility-sangnoksu-elevator-kric-1",
        stationId: "station-sangnoksu",
        type: "ELEVATOR",
        status: "UNKNOWN",
      },
      {
        id: "facility-sangnoksu-escalator-kric-1",
        stationId: "station-sangnoksu",
        type: "ESCALATOR",
        status: "UNKNOWN",
      },
      {
        id: "facility-sangnoksu-wheelchair-lift-kric-1",
        stationId: "station-sangnoksu",
        type: "WHEELCHAIR_LIFT",
        status: "UNKNOWN",
      },
      {
        id: "facility-sangnoksu-accessible-toilet-kric-1",
        stationId: "station-sangnoksu",
        type: "ACCESSIBLE_TOILET",
        status: "UNKNOWN",
      },
    ],
  );
  assert.equal(fixture.packs[0].networkEdges.length, 0);
});

test("공식 source ingest adapter는 KRIC 이동동선을 확정 edge가 아닌 검수 후보로 보존한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-kric-movement-candidate-ingest-${Date.now()}`);
  const input = kricMovementCandidateSourceIngestInput();
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(
    fixture.packs[0].sourceInventory.map((source) => source.id).sort(),
    ["kric-station-elevator-movement", "kric-wheelchair-lift-movement", "molit-urban-rail-full-route"],
  );
  assert.deepEqual(
    fixture.packs[0].movementPathCandidates.map(({ id, sourceId, stationId, reviewStatus }) => ({
      id,
      sourceId,
      stationId,
      reviewStatus,
    })),
    [
      {
        id: "movement-sangnoksu-elevator-kric-1",
        sourceId: "kric-station-elevator-movement",
        stationId: "station-sangnoksu",
        reviewStatus: "PENDING_ADMIN_REVIEW",
      },
      {
        id: "movement-sangnoksu-wheelchair-lift-kric-1",
        sourceId: "kric-wheelchair-lift-movement",
        stationId: "station-sangnoksu",
        reviewStatus: "PENDING_ADMIN_REVIEW",
      },
    ],
  );
  assert.equal(fixture.packs[0].networkEdges.length, 0);
  assert.equal((fixture.packs[0].internalRouteEdges ?? []).length, 0);
});

test("공식 source ingest adapter는 중복 CLI 인자를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-ingest-duplicate-arg-${Date.now()}`);
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(sourceIngestInput(), null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/import-official-sources.mjs",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--inventory",
        "tools/datapack/source-inventory.json",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    ),
    /duplicate argument: --inventory/,
  );
});

test("emergency datapack drill은 rollback, patch, route regression 증거를 묶는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-emergency-datapack-drill-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const inputPath = path.join(outputDir, "drill-input.json");
  const outputPath = path.join(outputDir, "drill-evidence.json");
  const knownGoodManifestSha256 = "a".repeat(64);
  const badManifestSha256 = "b".repeat(64);
  const fixedManifestSha256 = "c".repeat(64);

  await writeFile(
    inputPath,
    `${JSON.stringify(
      {
        channel: "production",
        previousKnownGoodManifest: {
          url: "https://cdn.easysubway.example/datapacks/current-42.json",
          sha256: knownGoodManifestSha256,
        },
        badManifest: {
          url: "https://cdn.easysubway.example/datapacks/current-43.json",
          sha256: badManifestSha256,
        },
        fixedManifest: {
          url: "https://cdn.easysubway.example/datapacks/current-44.json",
          sha256: fixedManifestSha256,
        },
        rollback: {
          startedAt: "2026-07-01T10:00:00.000Z",
          completedAt: "2026-07-01T10:03:20.000Z",
        },
        emergencyPatch: {
          auditId: "patch-route-edge-1",
          rows: [
            { table: "network_edges", id: "edge-sangnoksu-sadang-local" },
            { table: "facilities", id: "facility-sangnoksu-elevator" },
            { table: "transit_stop_times", id: "stop-trip-seoul-4-local-0805-sangnoksu" },
          ],
        },
        routeRegressionReplay: {
          command: "node -e 'process.stdout.write(JSON.stringify({failures:[],sampleSize:100}))'",
          before: { blocked: true, blocker: "bad network edge" },
          after: { blocked: false },
        },
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/run-emergency-datapack-drill.mjs",
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );

  const evidence = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(evidence.artifactKind, "emergency-datapack-release-drill");
  assert.equal(evidence.channel, "production");
  assert.equal(evidence.rollback.previousKnownGoodManifestSha256, knownGoodManifestSha256);
  assert.equal(evidence.rollback.badManifestSha256, badManifestSha256);
  assert.equal(evidence.rollback.rollbackTimeSeconds, 200);
  assert.equal(evidence.emergencyPatch.auditId, "patch-route-edge-1");
  assert.deepEqual(
    evidence.emergencyPatch.correctedTables,
    ["facilities", "network_edges", "transit_stop_times"],
  );
  assert.equal(evidence.fixedPromotion.fixedManifestSha256, fixedManifestSha256);
  assert.equal(evidence.routeRegressionReplay.before.blocked, true);
  assert.equal(evidence.routeRegressionReplay.after.blocked, false);
  assert.equal(evidence.verification.commandOutputSha256, sha256('{"failures":[],"sampleSize":100}'));
});

test("데이터팩 만료 알림 evidence는 SLA 임박 manifest를 FIRING으로 기록한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-expiry-alert-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "current.json");
  const outputPath = path.join(outputDir, "expiry-alert-evidence.json");

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        manifestVersion: 2,
        channel: "production",
        releaseSequence: 42,
        publishedAt: "2026-07-01T18:00:00.000Z",
        expiresAt: "2026-07-02T05:30:00.000Z",
        activePack: { id: "capital", version: "1" },
        packs: [],
      },
      null,
      2,
    )}\n`,
  );

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/check-datapack-expiry-alert.mjs",
      "--manifest",
      manifestPath,
      "--output",
      outputPath,
      "--now",
      "2026-07-02T00:00:00.000Z",
    ],
    { cwd: root },
  );

  const evidence = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(evidence.artifactKind, "datapack-expiry-alert-evidence");
  assert.equal(evidence.policy.alertBeforePackExpiry, "PT6H");
  assert.equal(evidence.manifest.channel, "production");
  assert.equal(evidence.manifest.releaseSequence, 42);
  assert.equal(evidence.alert.status, "FIRING");
  assert.equal(evidence.alert.severity, "warning");
  assert.equal(evidence.alert.secondsUntilExpiry, 19800);
});

// TODO: --current-manifest 발산 경로 (currentManifestBytes !== manifestBytes)는 #1692로 의도적 미연기 → 미커버
test("게시 plan은 schemaVersion 2에서 releases/<seq>.json 불변 스텝을 manifest 스텝보다 먼저 넣는다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "publish-plan-"));
  try {
    // manifestVersion 2 + releaseSequence 3 매니페스트와 pack 하나를 스테이징한다.
    const packBytes = gzipSync(Buffer.from("fixture-pack"));
    await mkdir(path.join(workspace, "catalog"), { recursive: true });
    await writeFile(path.join(workspace, "catalog", "capital-v1.sqlite.gz"), packBytes);
    const manifest = {
      manifestVersion: 2,
      channel: "staging",
      releaseSequence: 3,
      publishedAt: "2026-07-06T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
      keyId: "test-key",
      ttlSeconds: 3600,
      signature: { algorithm: "rsa-sha256-manifest-v2", value: "AA" },
      packs: [{ id: "capital", version: "1", sizeBytes: packBytes.length, sha256: sha256(packBytes) }],
    };
    const manifestPath = path.join(workspace, "catalog", "current.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const outputPath = path.join(workspace, "plan.json");

    await execFileAsync("node", [
      path.join(root, "tools/datapack/create-publish-plan.mjs"),
      "--manifest", manifestPath,
      "--root", workspace,
      "--output", outputPath,
    ]);

    const plan = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(plan.schemaVersion, 2);
    const types = plan.steps.map((step) => step.type);
    assert.deepEqual(types, [
      "put-pack-object", "verify-pack-object",
      "put-release-manifest-object", "verify-release-manifest-object",
      "put-manifest-object", "verify-manifest-object",
    ]);
    const releasePut = plan.steps.find((s) => s.type === "put-release-manifest-object");
    assert.equal(releasePut.objectKey, "catalog/releases/3.json");
    assert.equal(releasePut.immutable, true);
    assert.equal(releasePut.sourcePath, "catalog/current.json");
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    assert.equal(releasePut.sha256, sha256(manifestBytes));
    assert.equal(releasePut.sizeBytes, manifestBytes.length);
    assert.equal(releasePut.packCount, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writePendingCandidateFixture(outputDir, candidateId) {
  const candidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  resetCandidateForAdmissionTest(candidates, candidateId);
  const candidatesPath = path.join(outputDir, "source-candidates.pending.json");
  await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  return candidatesPath;
}

function resetCandidateForAdmissionTest(candidates, candidateId) {
  const candidate = candidates.candidates.find(({ id }) => id === candidateId);
  candidate.admissionStatus = "evidence_recorded_admin_review_required";
  delete candidate.productionInventoryReferenceId;
  delete candidate.productionInventoryRelationship;
  delete candidate.evidence.adminReview;
  candidate.evidence.missingEvidence = [
    ...new Set([...(candidate.evidence.missingEvidence ?? []), "adminAdmissionEvidence"]),
  ];
}

function objectStorageEnv(origin) {
  return {
    ...process.env,
    EASYSUBWAY_OBJECT_STORAGE_ENDPOINT: origin,
    EASYSUBWAY_DATAPACK_BUCKET: "easysubway-datapacks",
    EASYSUBWAY_OBJECT_STORAGE_REGION: "ap-northeast-2",
    EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY: "test-access-key",
    EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY: "test-secret-key",
  };
}

async function startObjectStorageServer({ requireAuthorization = true, basePath = "/easysubway-datapacks" } = {}) {
  const requests = [];
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://127.0.0.1");
      const normalizedBasePath = basePath.replace(/\/+$/, "");
      const key = decodeURIComponent(url.pathname.replace(new RegExp(`^${escapeRegExp(normalizedBasePath)}\\/?`), ""));
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.authorization,
        contentSha256: request.headers["x-amz-content-sha256"],
      });

      if (requireAuthorization && !request.headers.authorization) {
        response.writeHead(403);
        response.end("missing authorization");
        return;
      }

      if (request.method === "PUT") {
        objects.set(key, {
          body,
          sha256: sha256(body),
          sizeBytes: body.length,
          contentType: request.headers["content-type"],
          metadataSha256: request.headers["x-amz-meta-sha256"],
          cacheControl: request.headers["cache-control"],
        });
        response.writeHead(200, { etag: `"${sha256(body).slice(0, 32)}"` });
        response.end();
        return;
      }

      if (request.method === "HEAD") {
        const object = objects.get(key);
        if (!object) {
          response.writeHead(404);
          response.end();
          return;
        }
        const headers = {
          "content-length": String(object.sizeBytes),
          "x-amz-meta-sha256": object.metadataSha256,
        };
        if (object.cacheControl !== undefined) {
          headers["cache-control"] = object.cacheControl;
        }
        response.writeHead(200, headers);
        response.end();
        return;
      }

      if (request.method === "GET") {
        const object = objects.get(key);
        if (!object) {
          response.writeHead(404);
          response.end();
          return;
        }
        const headers = { "content-length": String(object.sizeBytes) };
        if (object.cacheControl !== undefined) {
          headers["cache-control"] = object.cacheControl;
        }
        response.writeHead(200, headers);
        response.end(object.body);
        return;
      }

      response.writeHead(405);
      response.end("method not allowed");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    objects,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceIngestInput() {
  return {
    schemaVersion: 1,
    region: "capital",
    pack: {
      id: "capital",
      version: "1",
      schemaVersion: "1",
      artifactKind: "fixture",
      url: "catalog/capital-v1.sqlite.gz",
    },
    manifest: {
      ttlSeconds: 3600,
      activePack: {
        id: "capital",
        version: "1",
      },
    },
    sourceIds: [
      "seoulmetro-station-line-info",
      "seoul-realtime-arrival-station-info",
    ],
    retiredStationIds: [
      {
        stationId: "station-retired-demo",
        reason: "closed",
        replacementStationId: "station-sadang",
      },
    ],
    operators: [
      {
        id: "seoul-metro",
        nameKo: "서울교통공사",
        nameEn: "Seoul Metro",
      },
    ],
    lines: [
      {
        id: "seoul-4",
        operatorId: "seoul-metro",
        nameKo: "수도권 4호선",
        nameEn: "Seoul Subway Line 4",
        color: "#00A5DE",
      },
    ],
    stationMappings: [
      {
        sourceId: "seoulmetro-station-line-info",
        sourceStationCode: "448",
        lineId: "seoul-4",
        stationId: "station-sangnoksu",
        stationLineId: "station-sangnoksu:seoul-4",
        mappingStatus: "active",
      },
      {
        sourceId: "seoul-realtime-arrival-station-info",
        sourceStationCode: "448",
        lineId: "seoul-4",
        stationId: "station-sangnoksu",
        stationLineId: "station-sangnoksu:seoul-4",
        mappingStatus: "active",
      },
      {
        sourceId: "seoulmetro-station-line-info",
        sourceStationCode: "433",
        lineId: "seoul-4",
        stationId: "station-sadang",
        stationLineId: "station-sadang:seoul-4",
        mappingStatus: "renamed",
        previousNames: ["총신대입구"],
      },
    ],
    stationLineRows: [
      {
        sourceId: "seoulmetro-station-line-info",
        sourceStationCode: "448",
        lineId: "seoul-4",
        stationNameKo: "상록수",
        stationNameEn: "Sangnoksu",
        normalizedName: "상록수",
        region: "수도권",
        latitude: 37.3028,
        longitude: 126.8666,
        stationCode: "448",
        lineSequence: 43,
        platformInfo: "당고개 방면 / 오이도 방면",
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
      {
        sourceId: "seoul-realtime-arrival-station-info",
        sourceStationCode: "448",
        lineId: "seoul-4",
        stationNameKo: "상록수",
        stationNameEn: "Sangnoksu",
        normalizedName: "상록수",
        region: "수도권",
        latitude: 37.3028,
        longitude: 126.8666,
        stationCode: "448",
        lineSequence: 43,
        platformInfo: "당고개 방면 / 오이도 방면",
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
      {
        sourceId: "seoulmetro-station-line-info",
        sourceStationCode: "433",
        lineId: "seoul-4",
        stationNameKo: "사당",
        stationNameEn: "Sadang",
        normalizedName: "사당",
        region: "수도권",
        latitude: 37.4766,
        longitude: 126.9816,
        stationCode: "433",
        lineSequence: 28,
        platformInfo: "당고개 방면 / 오이도 방면",
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
    ],
    routeEdges: [
      {
        id: "edge-sangnoksu-sadang-seoul-4",
        sourceId: "seoulmetro-station-line-info",
        from: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "448",
          lineId: "seoul-4",
        },
        to: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "433",
          lineId: "seoul-4",
        },
        durationSeconds: 1860,
        distanceMeters: 18600,
        edgeType: "RIDE",
        servicePattern: "EXPRESS",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 90,
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
      {
        id: "edge-sadang-sangnoksu-seoul-4",
        sourceId: "seoulmetro-station-line-info",
        from: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "433",
          lineId: "seoul-4",
        },
        to: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "448",
          lineId: "seoul-4",
        },
        durationSeconds: 1860,
        distanceMeters: 18600,
        edgeType: "RIDE",
        servicePattern: "EXPRESS",
        includesStairs: false,
        stairAccessState: "STEP_FREE",
        accessibilityStatus: "AVAILABLE",
        reliabilityScore: 90,
        lastVerifiedAt: "2026-06-21T00:00:00.000Z",
      },
    ],
    facilityRows: [
      {
        id: "facility-sangnoksu-elevator-1",
        station: {
          sourceId: "seoulmetro-station-line-info",
          sourceStationCode: "448",
          lineId: "seoul-4",
        },
        type: "ELEVATOR",
        name: "상록수역 1번 승강기",
        status: "NORMAL",
        floorFrom: "B2",
        floorTo: "1F",
        description: "상록수역 승강장과 지상을 연결합니다.",
      },
    ],
    routeRegressionScope: {
      mode: "DIRECT_ONLY",
      excludedPatterns: ["TRANSFER", "MULTI_TRANSFER", "LOOP_BRANCH", "EXPRESS_LOCAL"],
      claim: "capital pilot Android v1 direct regression only; current summary RIDE edge is release-blocking and not ETA evidence until adjacent-station route graph evidence exists",
    },
    representativeRouteRegressions: [
      {
        id: "direct-local-capital",
        pattern: "DIRECT",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
      },
    ],
  };
}

function addSourceIngestStation(input, { sourceStationCode, stationId, stationNameKo, stationCode, lineSequence }) {
  input.stationMappings.push({
    sourceId: "seoulmetro-station-line-info",
    sourceStationCode,
    lineId: "seoul-4",
    stationId,
    stationLineId: `${stationId}:seoul-4`,
    mappingStatus: "active",
  });
  input.stationLineRows.push({
    sourceId: "seoulmetro-station-line-info",
    sourceStationCode,
    lineId: "seoul-4",
    stationNameKo,
    stationNameEn: stationNameKo,
    normalizedName: stationNameKo,
    region: "수도권",
    latitude: 37.3159,
    longitude: 126.8385,
    stationCode,
    lineSequence,
    platformInfo: "당고개 방면 / 오이도 방면",
    lastVerifiedAt: "2026-06-21T00:00:00.000Z",
  });
}

function nationwideMasterSourceIngestInput() {
  const stationSources = [
    ["molit-urban-rail-full-route", "MOLIT-SEOUL-4-448", "seoul-4", "station-sangnoksu", "448", 43, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
    ["molit-tago-subway-info", "448", "seoul-4", "station-sangnoksu", "448", 43, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
    ["kric-metropolitan-rail-station-info", "KRIC-SEOUL-4-448", "seoul-4", "station-sangnoksu", "448", 43, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
    ["molit-urban-rail-full-route", "MOLIT-BUSAN-1-113", "busan-1", "station-busan-station", "113", 13, "부산역", "Busan Station", "부산권", 35.1152, 129.0422],
    ["kric-metropolitan-rail-station-info", "KRIC-BUSAN-1-113", "busan-1", "station-busan-station", "113", 13, "부산역", "Busan Station", "부산권", 35.1152, 129.0422],
  ];
  return {
    schemaVersion: 1,
    region: "nationwide",
    pack: {
      id: "nationwide",
      version: "1",
      schemaVersion: "1",
      artifactKind: "fixture",
      url: "catalog/nationwide-v1.sqlite.gz",
    },
    manifest: {
      ttlSeconds: 3600,
      activePack: {
        id: "nationwide",
        version: "1",
      },
    },
    sourceIds: [
      "molit-urban-rail-full-route",
      "molit-tago-subway-info",
      "kric-metropolitan-rail-station-info",
    ],
    operators: [
      {
        id: "seoul-metro",
        nameKo: "서울교통공사",
        nameEn: "Seoul Metro",
      },
      {
        id: "busan-transportation",
        nameKo: "부산교통공사",
        nameEn: "Busan Transportation Corporation",
      },
    ],
    lines: [
      {
        id: "seoul-4",
        operatorId: "seoul-metro",
        nameKo: "수도권 4호선",
        nameEn: "Seoul Subway Line 4",
        color: "#00A5DE",
      },
      {
        id: "busan-1",
        operatorId: "busan-transportation",
        nameKo: "부산 1호선",
        nameEn: "Busan Metro Line 1",
        color: "#F06A00",
      },
    ],
    stationMappings: stationSources.map(([sourceId, sourceStationCode, lineId, stationId]) => ({
      sourceId,
      sourceStationCode,
      lineId,
      stationId,
      stationLineId: `${stationId}:${lineId}`,
      mappingStatus: "active",
    })),
    stationLineRows: stationSources.map(nationwideMasterStationLineRow),
    representativeRouteRegressions: [],
  };
}

function nationwideMasterStationLineRow([
  sourceId,
  sourceStationCode,
  lineId,
  ,
  stationCode,
  lineSequence,
  stationNameKo,
  stationNameEn,
  region,
  latitude,
  longitude,
]) {
  return {
    sourceId,
    sourceStationCode,
    lineId,
    stationNameKo,
    stationNameEn,
    normalizedName: stationNameKo,
    region,
    latitude,
    longitude,
    stationCode,
    lineSequence,
    platformInfo: "마스터 병합 검증용",
    lastVerifiedAt: "2026-06-22T00:00:00.000Z",
  };
}

function kricAccessibilityFacilitySourceIngestInput() {
  return {
    ...nationwideMasterSourceIngestInput(),
    sourceIds: [
      "molit-urban-rail-full-route",
      "kric-station-elevator",
      "kric-station-escalator",
      "kric-wheelchair-lift-location",
      "kric-disabled-toilet",
    ],
    stationMappings: [
      {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
        stationId: "station-sangnoksu",
        stationLineId: "station-sangnoksu:seoul-4",
        mappingStatus: "active",
      },
    ],
    stationLineRows: [
      nationwideMasterStationLineRow([
        "molit-urban-rail-full-route",
        "MOLIT-SEOUL-4-448",
        "seoul-4",
        "station-sangnoksu",
        "448",
        48,
        "상록수",
        "Sangnoksu",
        "수도권",
        37.3028,
        126.8666,
      ]),
    ],
    facilityRows: [
      ["kric-station-elevator", "facility-sangnoksu-elevator-kric-1", "ELEVATOR", "상록수역 1번 엘리베이터"],
      ["kric-station-escalator", "facility-sangnoksu-escalator-kric-1", "ESCALATOR", "상록수역 1번 에스컬레이터"],
      [
        "kric-wheelchair-lift-location",
        "facility-sangnoksu-wheelchair-lift-kric-1",
        "WHEELCHAIR_LIFT",
        "상록수역 휠체어리프트",
      ],
      ["kric-disabled-toilet", "facility-sangnoksu-accessible-toilet-kric-1", "ACCESSIBLE_TOILET", "상록수역 장애인 화장실"],
    ].map(([sourceId, id, type, name]) => ({
      sourceId,
      id,
      station: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
      },
      type,
      name,
      status: "UNKNOWN",
      description: "KRIC 접근성 시설 source ingest 검증용",
    })),
    routeEdges: [],
    representativeRouteRegressions: [],
  };
}

function kricMovementCandidateSourceIngestInput() {
  return {
    ...nationwideMasterSourceIngestInput(),
    sourceIds: ["molit-urban-rail-full-route", "kric-station-elevator-movement", "kric-wheelchair-lift-movement"],
    stationMappings: [
      {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
        stationId: "station-sangnoksu",
        stationLineId: "station-sangnoksu:seoul-4",
        mappingStatus: "active",
      },
    ],
    stationLineRows: [
      nationwideMasterStationLineRow([
        "molit-urban-rail-full-route",
        "MOLIT-SEOUL-4-448",
        "seoul-4",
        "station-sangnoksu",
        "448",
        48,
        "상록수",
        "Sangnoksu",
        "수도권",
        37.3028,
        126.8666,
      ]),
    ],
    movementPathCandidates: [
      {
        sourceId: "kric-station-elevator-movement",
        id: "movement-sangnoksu-elevator-kric-1",
        station: {
          sourceId: "molit-urban-rail-full-route",
          sourceStationCode: "MOLIT-SEOUL-4-448",
          lineId: "seoul-4",
        },
        facilityType: "ELEVATOR",
        fromLabel: "1번 출입구",
        toLabel: "승강장",
        movementOrder: 1,
        instruction: "1번 출입구에서 엘리베이터를 이용해 승강장으로 이동",
        sourceImageUrl: "https://www.data.go.kr/kric/elevator-movement/example.png",
      },
      {
        sourceId: "kric-wheelchair-lift-movement",
        id: "movement-sangnoksu-wheelchair-lift-kric-1",
        station: {
          sourceId: "molit-urban-rail-full-route",
          sourceStationCode: "MOLIT-SEOUL-4-448",
          lineId: "seoul-4",
        },
        facilityType: "WHEELCHAIR_LIFT",
        fromLabel: "대합실",
        toLabel: "승강장",
        movementOrder: 2,
        instruction: "대합실에서 휠체어리프트 위치까지 이동 후 승강장으로 이동",
        sourceImageUrl: "https://www.data.go.kr/kric/wheelchair-lift-movement/example.png",
      },
    ],
    routeEdges: [],
    internalRouteEdges: [],
    representativeRouteRegressions: [],
  };
}

function productionSourceIngestInput() {
  const input = sourceIngestInput();
  input.pack.artifactKind = "production";
  input.pack.url = "https://datapack.example.com/easysubway/catalog/capital-v1.sqlite.gz";
  input.sourceIds = [
    "molit-urban-rail-full-route",
    "seoulmetro-station-line-info",
    "kric-station-elevator",
    "kric-station-elevator-movement",
    "kric-station-escalator",
    "kric-wheelchair-lift-location",
    "kric-wheelchair-lift-movement",
  ];
  input.supportedV1Scope = {
    scopeId: "capital_pilot_android_v1",
    includedRegionIds: ["capital"],
    includedOperatorIds: ["seoul-metro"],
    includedLineIds: ["seoul-4"],
    includedStationIds: ["station-sangnoksu", "station-sadang"],
    facilityCoverageDenominator: {
      kind: "station_line_x_required_facility_type",
      expectedRows: 6,
    },
    requiredFacilityTypes: ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"],
  };
  input.stationMappings.unshift(
    {
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-4-448",
      lineId: "seoul-4",
      stationId: "station-sangnoksu",
      stationLineId: "station-sangnoksu:seoul-4",
      mappingStatus: "active",
    },
    {
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-4-433",
      lineId: "seoul-4",
      stationId: "station-sadang",
      stationLineId: "station-sadang:seoul-4",
      mappingStatus: "active",
    },
  );
  input.stationLineRows.unshift(
    {
      ...input.stationLineRows[0],
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-4-448",
    },
    {
      ...input.stationLineRows[2],
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode: "MOLIT-SEOUL-4-433",
    },
  );
  input.stationMappings = input.stationMappings.filter(
    (mapping) => mapping.sourceId !== "seoul-realtime-arrival-station-info",
  );
  input.stationLineRows = input.stationLineRows.filter(
    (row) => row.sourceId !== "seoul-realtime-arrival-station-info",
  );
  input.routeEdges = [];
  input.representativeRouteRegressions = [];
  delete input.routeRegressionScope;
  input.facilityRows = [
    [
      "kric-station-elevator",
      "facility-sangnoksu-elevator-kric-1",
      "ELEVATOR",
      "상록수 엘리베이터 설치 정보",
      "MOLIT-SEOUL-4-448",
    ],
    [
      "kric-station-escalator",
      "facility-sangnoksu-escalator-kric-1",
      "ESCALATOR",
      "상록수 에스컬레이터 설치 정보",
      "MOLIT-SEOUL-4-448",
    ],
    [
      "kric-wheelchair-lift-location",
      "facility-sangnoksu-wheelchair-lift-kric-1",
      "WHEELCHAIR_LIFT",
      "상록수 휠체어리프트 설치 정보",
      "MOLIT-SEOUL-4-448",
    ],
    [
      "kric-station-elevator",
      "facility-sadang-elevator-kric-1",
      "ELEVATOR",
      "사당 엘리베이터 설치 정보",
      "MOLIT-SEOUL-4-433",
    ],
    [
      "kric-station-escalator",
      "facility-sadang-escalator-kric-1",
      "ESCALATOR",
      "사당 에스컬레이터 설치 정보",
      "MOLIT-SEOUL-4-433",
    ],
    [
      "kric-wheelchair-lift-location",
      "facility-sadang-wheelchair-lift-kric-1",
      "WHEELCHAIR_LIFT",
      "사당 휠체어리프트 설치 정보",
      "MOLIT-SEOUL-4-433",
    ],
  ].map(([sourceId, id, type, name, sourceStationCode], index) => ({
    sourceId,
    id,
    station: {
      sourceId: "molit-urban-rail-full-route",
      sourceStationCode,
      lineId: "seoul-4",
    },
    type,
    name,
    status: "UNKNOWN",
    statusMeaning: "STATIC_LOCATION",
    operationalStatus: "UNKNOWN",
    installationStatus: "INSTALLED",
    providerFacilityRef: id,
    provenanceKind: "OFFICIAL_SOURCE",
    description: "KRIC 위치 source 기준 설치 정보이며 실시간 운행 상태가 아닙니다.",
    verifiedAt: "2026-06-22T00:00:00.000Z",
    retrievedAt: "2026-06-22T00:00:00.000Z",
    sourceSnapshotId: `${sourceId}-snapshot-20260622`,
    providerRecordHash: sha256(`provider:${id}:${sourceId}`),
    evidenceHash: sha256(`evidence:${id}:${sourceId}:2026-06-22T00:00:00.000Z`),
    confidence: 80,
  }));
  input.movementPathCandidates = [
    {
      sourceId: "kric-station-elevator-movement",
      id: "movement-sangnoksu-elevator-kric-1",
      station: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
      },
      facilityType: "ELEVATOR",
      fromLabel: "출입구",
      toLabel: "승강장",
      movementOrder: 1,
      instruction: "KRIC 엘리베이터 이동동선 후보",
    },
    {
      sourceId: "kric-wheelchair-lift-movement",
      id: "movement-sangnoksu-wheelchair-lift-kric-1",
      station: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode: "MOLIT-SEOUL-4-448",
        lineId: "seoul-4",
      },
      facilityType: "WHEELCHAIR_LIFT",
      fromLabel: "대합실",
      toLabel: "승강장",
      movementOrder: 2,
      instruction: "KRIC 휠체어리프트 이동동선 후보",
    },
  ].map((row) => ({
    ...row,
    sourceSnapshotId: `${row.sourceId}-snapshot-20260622`,
    providerRecordHash: sha256(`provider:${row.id}:${row.sourceId}`),
    evidenceHash: sha256(`evidence:${row.id}:${row.sourceId}:2026-06-22T00:00:00.000Z`),
  }));
  input.minimumProductionCoverage = {
    stations: 2,
    stationLines: 2,
    routeEdges: 4,
    facilities: 6,
  };
  input.routeEdges.push(
    productionSourceAccessRouteEdge({
      id: "edge-entry-sangnoksu-seoul-4",
      sourceStationCode: "448",
      edgeType: "ENTRY",
      stationToLine: true,
    }),
    productionSourceAccessRouteEdge({
      id: "edge-exit-sangnoksu-seoul-4",
      sourceStationCode: "448",
      edgeType: "EXIT",
      stationToLine: false,
    }),
    productionSourceAccessRouteEdge({
      id: "edge-entry-sadang-seoul-4",
      sourceStationCode: "433",
      edgeType: "ENTRY",
      stationToLine: true,
    }),
    productionSourceAccessRouteEdge({
      id: "edge-exit-sadang-seoul-4",
      sourceStationCode: "433",
      edgeType: "EXIT",
      stationToLine: false,
    }),
  );
  input.coverageEvidence = [
    {
      regionId: "capital",
      operatorId: "seoul-metro",
      sourceDomain: "station_line_membership",
      sourceIds: ["molit-urban-rail-full-route", "seoulmetro-station-line-info"],
      evidence: "서울교통공사 노선별 지하철역 정보 source inventory coverageScope",
    },
    {
      regionId: "capital",
      operatorId: "seoul-metro",
      sourceDomain: "accessibility_facilities",
      sourceIds: [
        "kric-station-elevator",
        "kric-station-elevator-movement",
        "kric-station-escalator",
        "kric-wheelchair-lift-location",
        "kric-wheelchair-lift-movement",
      ],
      evidence: "국가철도공단 접근성 시설 위치와 이동동선 source inventory coverageScope",
    },
  ];
  return input;
}

async function importOfficialSourceInput(outputDir, input, inventoryPath = "tools/datapack/source-inventory.json") {
  const inputPath = path.join(outputDir, "official-source-input.json");
  const outputPath = path.join(outputDir, "catalog-fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/import-official-sources.mjs",
      "--inventory",
      inventoryPath,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    { cwd: root },
  );
  return JSON.parse(await readFile(outputPath, "utf8"));
}

async function capitalPilotProductionSourceInput() {
  return JSON.parse(
    await readFile(path.join(root, "tools/datapack/inputs/capital-pilot-production-source-input.json"), "utf8"),
  );
}

function useAccessibilitySourceForAvailableEdge(input, edgeId) {
  const edge = input.routeEdges.find((row) => row.id === edgeId);
  edge.accessibilityStatus = "AVAILABLE";
  edge.sourceId = "kric-station-elevator";
  edge.sourceSnapshotId = "kric-station-elevator-snapshot-20260622";
  edge.providerRecordHash = sha256(`provider:${edge.id}:kric-station-elevator`);
  edge.evidenceHash = sha256(`evidence:${edge.id}:kric-station-elevator:2026-06-22T00:00:00.000Z`);
  edge.lastVerifiedAt = "2026-06-22T00:00:00.000Z";
}

function addSeoul2ProductionScope(input) {
  input.lines.push({
    ...input.lines[0],
    id: "seoul-2",
    nameKo: "수도권 2호선",
    nameEn: "Seoul Subway Line 2",
    color: "#00A84D",
  });
  input.supportedV1Scope.includedLineIds.push("seoul-2");
  input.supportedV1Scope.facilityCoverageDenominator.expectedRows = 9;
}

function addMolitStationMapping(input, { sourceStationCode, stationId }) {
  input.stationMappings.push({
    sourceId: "molit-urban-rail-full-route",
    sourceStationCode,
    lineId: "seoul-2",
    stationId,
    stationLineId: `${stationId}:seoul-2`,
    mappingStatus: "active",
  });
}

function addStationLineRow(input, { baseSourceStationCode, sourceStationCode, stationCode, lineSequence, platformInfo }) {
  const base = input.stationLineRows.find((row) => row.sourceStationCode === baseSourceStationCode);
  input.stationLineRows.push({
    ...base,
    sourceStationCode,
    lineId: "seoul-2",
    stationCode,
    lineSequence,
    platformInfo: platformInfo ?? base.platformInfo,
  });
}

function addRequiredFacilityRowsForStationLine(input, { baseSourceStationCode, sourceStationCode, idPrefix }) {
  for (const facilityType of input.supportedV1Scope.requiredFacilityTypes) {
    const base = input.facilityRows.find(
      (row) => row.station.sourceStationCode === baseSourceStationCode && row.type === facilityType,
    );
    const id = `${idPrefix}-${facilityType.toLowerCase()}`;
    input.facilityRows.push({
      ...base,
      id,
      station: {
        sourceId: "molit-urban-rail-full-route",
        sourceStationCode,
        lineId: "seoul-2",
      },
      providerFacilityRef: id,
      providerRecordHash: sha256(`provider:${id}:${base.sourceId}`),
      evidenceHash: sha256(`evidence:${id}:${base.sourceId}:2026-06-22T00:00:00.000Z`),
    });
  }
}

function productionSourceAccessRouteEdge({ id, sourceStationCode, edgeType, stationToLine }) {
  const stationEndpoint = {
    sourceId: "seoulmetro-station-line-info",
    sourceStationCode,
    lineId: "seoul-4",
    nodeKind: "STATION",
  };
  const stationLineEndpoint = {
    sourceId: "seoulmetro-station-line-info",
    sourceStationCode,
    lineId: "seoul-4",
  };
  return {
    id,
    sourceId: "seoulmetro-station-line-info",
    from: stationToLine ? stationEndpoint : stationLineEndpoint,
    to: stationToLine ? stationLineEndpoint : stationEndpoint,
    durationSeconds: stationToLine ? 90 : 60,
    distanceMeters: 0,
    edgeType,
    servicePattern: "",
    includesStairs: false,
    stairAccessState: "STEP_FREE",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 90,
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    lastVerifiedAt: "2026-06-21T00:00:00.000Z",
    sourceSnapshotId: "seoulmetro-station-line-info-snapshot-20260621",
    providerRecordHash: sha256(`provider:${id}:seoulmetro-station-line-info`),
    evidenceHash: sha256(`evidence:${id}:seoulmetro-station-line-info:2026-06-21T00:00:00.000Z`),
  };
}

function withProductionSummaryRideEdges(input, servicePattern = "EXPRESS") {
  return {
    ...input,
    routeEdges: [...productionSummaryRideEdges(servicePattern), ...input.routeEdges],
    routeGraphTopologyPolicy: {
      summaryRideEdges: "fixture-only",
    },
  };
}

function productionSummaryRideEdges(servicePattern = "EXPRESS") {
  return sourceIngestInput().routeEdges.map((edge) => ({
    ...edge,
    servicePattern,
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    sourceSnapshotId: `${edge.sourceId}-snapshot-20260621`,
    providerRecordHash: sha256(`provider:${edge.id}:${edge.sourceId}`),
    evidenceHash: sha256(`evidence:${edge.id}:${edge.sourceId}:${edge.lastVerifiedAt}`),
  }));
}

function productionSummaryNetworkEdges(servicePattern = "EXPRESS") {
  return productionSummaryRideEdges(servicePattern).map((edge) => ({
    id: edge.id,
    fromNodeId:
      edge.from.sourceStationCode === "448"
        ? "station-sangnoksu:seoul-4:LOCAL"
        : "station-sadang:seoul-4:LOCAL",
    toNodeId:
      edge.to.sourceStationCode === "433"
        ? "station-sadang:seoul-4:LOCAL"
        : "station-sangnoksu:seoul-4:LOCAL",
    durationSeconds: edge.durationSeconds,
    distanceMeters: edge.distanceMeters,
    edgeType: edge.edgeType,
    servicePattern: edge.servicePattern,
    includesStairs: edge.includesStairs,
    stairAccessState: edge.stairAccessState,
    accessibilityStatus: edge.accessibilityStatus,
    reliabilityScore: edge.reliabilityScore,
    sourceId: edge.sourceId,
    sourceSnapshotId: edge.sourceSnapshotId,
    providerRecordHash: edge.providerRecordHash,
    provenanceKind: edge.provenanceKind,
    verificationStatus: edge.verificationStatus,
    lastVerifiedAt: edge.lastVerifiedAt,
    evidenceHash: edge.evidenceHash,
  }));
}

function completeCoverageInventory(targets) {
  const scopes = targets.schemaVersion === 2
    ? targets.activeLineScopes
    : targets.regions.flatMap((region) =>
        region.operatorIds.map((operatorId) => ({ regionId: region.id, operatorId, lineId: null })),
      );
  const regionNames = new Map(targets.regions.map((region) => [region.id, region.displayName]));
  return {
    schemaVersion: 1,
    region: "nationwide",
    artifactKind: "production-source-inventory",
    retrievedAt: "2026-06-22",
    sources: scopes.flatMap((scope) =>
        targets.requiredSourceDomains.map((domain) => ({
          id: `${scope.regionId}-${scope.operatorId}-${scope.lineId ?? "operator"}-${domain.id}`,
          displayName: `${regionNames.get(scope.regionId)} ${scope.operatorId} ${scope.lineId ?? "operator"} ${domain.id}`,
          owner: "테스트 운영기관",
          provider: "테스트 운영기관",
          providerDepartment: "테스트",
          sourceSystem: "테스트",
          datasetUrl: `https://example.invalid/${scope.regionId}/${scope.operatorId}/${scope.lineId ?? "operator"}/${domain.id}`,
          datasetKind: "fixture-only",
          coverageScope: {
            regionIds: [scope.regionId],
            operatorIds: [scope.operatorId],
            ...(scope.lineId ? { lineIds: [scope.lineId] } : {}),
            sourceDomains: [domain.id],
          },
          requiredForProductionPack: true,
          updateFrequency: "daily",
          observedDataUpdatedAt: "2026-06-22",
          retrievedAt: "2026-06-22",
          license: {
            type: "KOGL-1",
            name: "공공누리 1유형",
            attribution: "테스트",
            commercialUseAllowed: true,
            derivativeWorkAllowed: true,
            redistributionAllowed: true,
            evidenceUrl: "https://example.invalid/license",
          },
          capabilities: sourceCapabilityFixture(domain.id),
          fieldsProvided: domain.requiredFields,
        })),
    ),
  };
}

function sourceCapabilityFixture(domainId) {
  const supportedFacility = domainId === "accessibility_facilities";
  const realtimeCandidate = domainId === "realtime_arrivals";
  const updateFrequency = "daily";
  return {
    schedule: {
      status: "UNSUPPORTED",
      productionUseAllowed: false,
      coverageStatus: "NOT_PROVIDED_BY_SOURCE",
      updateFrequency,
      unsupportedNotes: "fixture source does not provide scheduled timetable data",
    },
    realtime: realtimeCandidate
      ? {
          status: "CANDIDATE",
          productionUseAllowed: false,
          liveEtaEligible: false,
          rateLimitStatus: "BLOCKED_PENDING_PROVIDER_TERMS_OR_QUOTA",
          coverageStatus: "SOURCE_INVENTORY_COVERED",
          updateFrequency,
          unsupportedNotes: "fixture realtime source is not approved for production live ETA",
        }
      : {
          status: "UNSUPPORTED",
          productionUseAllowed: false,
          liveEtaEligible: false,
          rateLimitStatus: "NOT_APPLICABLE",
          coverageStatus: "NOT_PROVIDED_BY_SOURCE",
          updateFrequency,
          unsupportedNotes: "fixture source does not provide realtime arrival data",
        },
    facility: supportedFacility
      ? {
          status: "SUPPORTED",
          productionUseAllowed: true,
          coverageStatus: "SOURCE_INVENTORY_COVERED",
          updateFrequency,
          unsupportedNotes: "fixture source supports official accessibility facility evidence only",
        }
      : {
          status: "UNSUPPORTED",
          productionUseAllowed: false,
          coverageStatus: "NOT_PROVIDED_BY_SOURCE",
          updateFrequency,
          unsupportedNotes: "fixture source does not provide accessibility facility records",
        },
  };
}

function completeCoverageProvenance(inventory) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: "a".repeat(64),
    packs: [
      {
        id: "nationwide",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "b".repeat(64),
        records: inventory.sources.flatMap((source) =>
          source.fieldsProvided.map((field) => ({
            entityType: "source-field",
            entityId: `${source.id}:${field}`,
            field,
            sourceId: source.id,
            coverageScope: source.coverageScope,
            derivationKind: "OFFICIAL",
            verifiedAt: "2026-06-22T00:00:00.000Z",
          })),
        ),
      },
    ],
  };
}

async function writeCoverageCandidate(outputDir, provenance) {
  const packs = provenance.packs.map(({ id, version, artifactKind, sqliteSha256 }) => ({
    id,
    version,
    artifactKind,
    sqliteSha256,
  }));
  const manifestJson = `${JSON.stringify({
    activePack: { id: packs[0].id, version: packs[0].version },
    packs,
  }, null, 2)}\n`;
  provenance.manifestSha256 = sha256(Buffer.from(manifestJson));
  await writeFile(path.join(outputDir, "current.json"), manifestJson);
  await writeFile(
    path.join(outputDir, "current.provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
}

function markFixturePackProduction(fixture) {
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
      coverageScope: productionSourceCoverageScope(),
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
    edge.sourceId = "capital-official-stations";
    edge.sourceSnapshotId = "capital-official-stations-snapshot-20260619";
    edge.providerRecordHash = edge.providerRecordHash ?? sha256(`provider:${edge.id}:capital-official-stations`);
    edge.provenanceKind = "OFFICIAL_SOURCE";
    edge.verificationStatus = "VERIFIED";
    edge.lastVerifiedAt = edge.lastVerifiedAt ?? "2026-06-19T00:00:00Z";
    edge.evidenceHash = edge.evidenceHash ?? sha256(`evidence:${edge.id}:capital-official-stations:${edge.lastVerifiedAt}`);
  }
  for (const link of pack.outOfStationTransferLinks ?? []) {
    link.sourceId = "capital-official-stations";
    link.sourceSnapshotId = "capital-official-stations-snapshot-20260619";
    link.providerRecordHash = link.providerRecordHash ?? sha256(`provider:${link.id}:capital-official-stations`);
    link.provenanceKind = "OFFICIAL_SOURCE";
    link.verificationStatus = "VERIFIED";
    link.lastVerifiedAt = link.lastVerifiedAt ?? "2026-06-19T00:00:00Z";
    link.evidenceHash = link.evidenceHash ?? sha256(`evidence:${link.id}:capital-official-stations:${link.lastVerifiedAt}`);
  }
  for (const edge of pack.internalRouteEdges ?? []) {
    edge.sourceId = "capital-official-stations";
    edge.sourceSnapshotId = "capital-official-stations-snapshot-20260619";
    edge.providerRecordHash = edge.providerRecordHash ?? sha256(`provider:${edge.id}:capital-official-stations`);
    edge.provenanceKind = "OFFICIAL_SOURCE";
    edge.verificationStatus = "VERIFIED";
    edge.lastVerifiedAt = edge.lastVerifiedAt ?? "2026-06-19T00:00:00Z";
    edge.evidenceHash = edge.evidenceHash ?? sha256(`evidence:${edge.id}:capital-official-stations:${edge.lastVerifiedAt}`);
  }
  for (const edge of pack.stationPathwayEdges ?? []) {
    edge.sourceId = "capital-official-stations";
    edge.sourceSnapshotId = "capital-official-stations-snapshot-20260619";
    edge.providerRecordHash = edge.providerRecordHash ?? sha256(`provider:${edge.id}:capital-official-stations`);
    edge.provenanceKind = "OFFICIAL_SOURCE";
    edge.verificationStatus = "VERIFIED";
    edge.lastVerifiedAt = edge.lastVerifiedAt ?? "2026-06-19T00:00:00Z";
    edge.evidenceHash = edge.evidenceHash ?? sha256(`evidence:${edge.id}:capital-official-stations:${edge.lastVerifiedAt}`);
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
  return {
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
    sourceId: "capital-official-stations",
    sourceSnapshotId: "capital-official-stations-snapshot-20260619",
    providerRecordHash: sha256(`provider:${id}:capital-official-stations`),
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    lastVerifiedAt: "2026-06-19T00:00:00Z",
    evidenceHash: sha256(`evidence:${id}:capital-official-stations:2026-06-19T00:00:00Z`),
  };
}

function productionSourceCoverageScope() {
  return {
    regionIds: ["capital"],
    operatorIds: ["seoul-metro"],
    sourceDomains: ["station_line_membership", "accessibility_facilities"],
  };
}

function makeProductionSourceFixtureStrictCoverageValid(fixture) {
  const pack = fixture.packs[0];
  for (const edge of pack.networkEdges.filter((row) => ["ENTRY", "EXIT"].includes(row.edgeType))) {
    edge.accessibilityStatus = "AVAILABLE";
    edge.sourceId = "kric-station-elevator";
    edge.sourceSnapshotId = "kric-station-elevator-snapshot-20260622";
    edge.providerRecordHash = sha256(`provider:${edge.id}:kric-station-elevator`);
    edge.evidenceHash = sha256(`evidence:${edge.id}:kric-station-elevator:2026-06-22T00:00:00.000Z`);
    edge.lastVerifiedAt = "2026-06-22T00:00:00.000Z";
  }
  for (const evidence of pack.stationFacilityEvidence) {
    evidence.operationalStatus = "AVAILABLE";
    evidence.statusMeaning = "OPERATOR_CONFIRMED";
    evidence.strictRouteEligible = true;
    evidence.strictRouteEligibleReason = "FACILITY_OPERATION_VERIFIED";
  }
  addApprovedMovementPathwayEvidence(pack, {
    sourceId: "kric-station-elevator-movement",
    sourceSnapshotId: "kric-station-elevator-movement-snapshot-20260622",
    verifiedAt: "2026-06-22T00:00:00.000Z",
  });
}

function addApprovedMovementPathwayEvidence(pack, { sourceId, sourceSnapshotId, verifiedAt }) {
  pack.stationPathwayNodes ??= [];
  pack.stationPathwayEdges ??= [];
  for (const { stationId, lineId } of pack.stationLines) {
    const surfaceNodeId = `test-approved-path-node-${stationId}-${lineId}-surface`;
    const platformNodeId = `test-approved-path-node-${stationId}-${lineId}-platform`;
    const pathwayEdgeId = `test-approved-path-edge-${stationId}-${lineId}`;
    pack.stationPathwayNodes.push(
      {
        id: surfaceNodeId,
        stationId,
        nodeType: "ENTRANCE",
        label: `${stationId} 출입구`,
      },
      {
        id: platformNodeId,
        stationId,
        lineId,
        nodeType: "PLATFORM",
        label: `${stationId} ${lineId} 승강장`,
      },
    );
    pack.stationPathwayEdges.push({
      id: pathwayEdgeId,
      fromNodeId: surfaceNodeId,
      toNodeId: platformNodeId,
      edgeType: "WALK",
      bidirectional: true,
      accessibilityStatus: "AVAILABLE",
      reliabilityScore: 90,
      sourceId,
      sourceSnapshotId,
      providerRecordHash: sha256(`provider:${pathwayEdgeId}:${sourceId}`),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: verifiedAt,
      evidenceHash: sha256(`evidence:${pathwayEdgeId}:${sourceId}:${verifiedAt}`),
    });
  }
}

function packSignaturePayload(pack) {
  return `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`;
}

function resignProductionManifest(manifest) {
  const pack = manifest.packs[0];
  const packUrl = new URL(pack.url).toString();
  const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
  pack.signature.value = rsaSha256Signature(`${fixturePayload}:${packUrl}`);
  pack.representativeRouteRegressionSignature.value = rsaSha256Signature(
    `${fixturePayload}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}:${packUrl}`,
  );
  if (manifest.signature) {
    manifest.signature.value = rsaSha256Signature(canonicalJson(withoutSignature(manifest)));
  }
}

function rsaSha256Signature(value) {
  return createSign("RSA-SHA256").update(value).sign(testPrivateKeyPem).toString("base64url");
}

function withoutSignature(value) {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function representativeRouteRegressionPayload(routes) {
  return JSON.stringify(
    routes.map((route) => ({
      id: route.id,
      pattern: route.pattern,
      fromNodeId: route.fromNodeId,
      toNodeId: route.toNodeId,
      requiredEdgeIds: route.requiredEdgeIds,
    })),
  );
}

// rollout 검증 단위 테스트용 최소 유효 v1 fixture 매니페스트 생성 헬퍼
function minimalFixtureManifest() {
  const hex64 = "a".repeat(64);
  return {
    ttlSeconds: 3600,
    packs: [
      {
        id: "test",
        version: "1",
        artifactKind: "fixture",
        url: "catalog/test-v1.sqlite.gz",
        sha256: hex64,
        sqliteSha256: hex64,
        sizeBytes: 1,
        signature: { algorithm: "sha256-pack-manifest-v1", value: hex64 },
        schemaVersion: "1",
        sourceInventory: [
          {
            id: "src",
            owner: "test",
            url: "https://example.com",
            license: "fixture",
            licenseStatus: "fixture-only",
            redistributionAllowed: false,
            updateFrequency: "manual",
            updatedAt: "2026-01-01",
            fields: ["test"],
          },
        ],
        regionalQualityMetrics: {
          stationCount: 0,
          facilityCoverageRatio: 0,
          requiredFacilityEvidenceCoverageRatio: 0,
          strictRouteEligibleFacilityRatio: 0,
          operationalKnownRatio: 0,
          freshnessValidRatio: 0,
          fieldVerifiedPathwayRatio: 0,
          edgeCount: 0,
          unknownAccessibilityRatio: 0,
          unknownEdgeRatioByProfile: { wheelchair: 0, stroller: 0, lowMobility: 0 },
        },
        representativeRouteRegressions: [],
        representativeRouteRegressionSignature: {
          algorithm: "sha256-route-regression-v1",
          value: hex64,
        },
        requiredTables: ["catalog_metadata"],
      },
    ],
  };
}

test("매니페스트 rollout은 percentage 0~100·seed hex32만 허용한다", () => {
  const base = minimalFixtureManifest();
  const ok = { ...base, rollout: { percentage: 10, seed: "a".repeat(32) } };
  assert.doesNotThrow(() => validateManifest(ok));
  assert.throws(
    () => validateManifest({ ...base, rollout: { percentage: 101, seed: "a".repeat(32) } }),
    /rollout.*percentage/,
  );
  assert.throws(
    () => validateManifest({ ...base, rollout: { percentage: 10, seed: "zz" } }),
    /rollout.*seed/,
  );
});

test("releases 게시 대상 매니페스트에 rollout이 있으면 거부한다", () => {
  const base = minimalFixtureManifest();
  const withRollout = { ...base, rollout: { percentage: 10, seed: "a".repeat(32) } };
  assert.throws(
    () => validateManifest(withRollout, { releasesTarget: true }),
    /releases.*rollout/i,
  );
});

test("manifest-signing: rsaSha256Signature는 base64url 서명을 반환하고 공개키로 검증된다", async () => {
  const { rsaSha256Signature } = await import("./lib/manifest-signing.mjs");
  const { verifyRsaSha256Signature } = await import("./lib/manifest-validation.mjs");
  const value = "manifest-signing-unit-test-fixture-payload";
  const sig = rsaSha256Signature(testPrivateKeyPem, value);
  assert.ok(typeof sig === "string", "서명은 문자열이어야 함");
  assert.ok(/^[A-Za-z0-9_-]+$/.test(sig), "base64url 형식이어야 함");
  assert.ok(verifyRsaSha256Signature(testPublicKeyPem, value, sig), "공개키로 검증되어야 함");
});

test("manifest-signing: signingPrivateKey는 env 미설정 시 throw, 설정 시 PEM 반환", async () => {
  const { signingPrivateKey } = await import("./lib/manifest-signing.mjs");
  const savedKey = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  try {
    delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
    assert.throws(() => signingPrivateKey(), /EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM/);
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = testPrivateKeyPem;
    assert.equal(signingPrivateKey(), testPrivateKeyPem.trim());
  } finally {
    if (savedKey !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedKey;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  }
});

test("manifest-signing: manifestSignatureValue는 canonicalJson(withoutSignature) 기반 RSA 서명을 반환한다", async () => {
  const { manifestSignatureValue } = await import("./lib/manifest-signing.mjs");
  const { verifyRsaSha256Signature, canonicalJson, withoutSignature } = await import("./lib/manifest-validation.mjs");
  const manifest = {
    manifestVersion: 2,
    channel: "test",
    releaseSequence: 1,
    publishedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    keyId: "test-key",
    ttlSeconds: 3600,
    packs: [],
    signature: { algorithm: "rsa-sha256-manifest-v2", value: "PLACEHOLDER" },
  };
  const savedKey = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  try {
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = testPrivateKeyPem;
    const sigValue = manifestSignatureValue(manifest);
    const canonical = canonicalJson(withoutSignature(manifest));
    assert.ok(/^[A-Za-z0-9_-]+$/.test(sigValue), "base64url 형식이어야 함");
    assert.ok(verifyRsaSha256Signature(testPublicKeyPem, canonical, sigValue), "서명 검증 통과해야 함");
  } finally {
    if (savedKey !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedKey;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  }
});

// ─── buildRolloutManifest 단위 테스트 (#1692) ──────────────────────────────────
// production releases 픽스처 생성 헬퍼 (keyId="production-v1", RSA-SHA256 서명 계산)

function _rolloutCanonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(_rolloutCanonicalValue);
  return Object.fromEntries(
    Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, _rolloutCanonicalValue(value[k])]),
  );
}

function _rolloutCanonicalJson(value) {
  return JSON.stringify(_rolloutCanonicalValue(value));
}

function _rolloutSign(data) {
  return createSign("RSA-SHA256").update(data).sign(testPrivateKeyPem).toString("base64url");
}

function buildProductionReleasesManifest(overrides = {}) {
  const hex64 = "a".repeat(64);
  const base = {
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 5,
    publishedAt: "2026-07-07T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    signature: { algorithm: "rsa-sha256-manifest-v2", value: "placeholder" },
    packs: [
      {
        id: "capital",
        version: "1",
        artifactKind: "production",
        url: "https://cdn.example.com/catalog/capital-v1.sqlite.gz",
        sha256: hex64,
        sqliteSha256: hex64,
        sizeBytes: 1000,
        signature: {
          algorithm: "rsa-sha256-pack-manifest-v2",
          value: _rolloutSign("pack-payload"),
        },
        schemaVersion: "1",
        sourceInventory: [
          {
            id: "src1",
            owner: "test-owner",
            url: "https://data.example.com/catalog",
            license: "CC-BY-4.0",
            licenseStatus: "redistributable",
            redistributionAllowed: true,
            updateFrequency: "daily",
            updatedAt: "2026-07-07T00:00:00.000Z",
            fields: ["stations"],
            coverageScope: {
              regionIds: ["seoul"],
              operatorIds: ["seoulmetro"],
              sourceDomains: ["station_map"],
            },
          },
        ],
        regionalQualityMetrics: {
          stationCount: 100,
          edgeCount: 200,
          facilityCoverageRatio: 0.5,
          requiredFacilityEvidenceCoverageRatio: 0.5,
          strictRouteEligibleFacilityRatio: 0.5,
          operationalKnownRatio: 1.0,
          freshnessValidRatio: 0.8,
          fieldVerifiedPathwayRatio: 0.3,
          unknownAccessibilityRatio: 0.2,
          unknownEdgeRatioByProfile: { wheelchair: 0.1, stroller: 0.1, lowMobility: 0.1 },
        },
        representativeRouteRegressions: [],
        representativeRouteRegressionSignature: {
          algorithm: "rsa-sha256-route-regression-v1",
          value: _rolloutSign("regression-payload"),
        },
        requiredTables: ["stations"],
        minimumTableRows: {
          stations: 1,
          station_lines: 1,
          network_edges: 1,
          facilities: 1,
          station_facility_evidence: 1,
        },
      },
    ],
    ...overrides,
  };
  const { signature: _dropSig, ...unsigned } = base;
  base.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: _rolloutSign(_rolloutCanonicalJson(unsigned)),
  };
  return base;
}

test("buildRolloutManifest (a): percentage 50 → rollout{50,seed hex32} + validateManifest 통과(재서명 유효)", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const { verifyRsaSha256Signature, canonicalJson, withoutSignature } = await import("./lib/manifest-validation.mjs");
  const releases = buildProductionReleasesManifest();
  const savedPriv = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  const savedPub = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  try {
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = testPrivateKeyPem;
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = testPublicKeyPem;
    const result = buildRolloutManifest({ releases, current: null, targetSequence: 5, percentage: 50 });
    assert.ok(result.rollout, "rollout 필드 있어야 함");
    assert.equal(result.rollout.percentage, 50);
    assert.match(result.rollout.seed, /^[a-f0-9]{32}$/, "seed hex32 이어야 함");
    assert.ok(
      verifyRsaSha256Signature(testPublicKeyPem, canonicalJson(withoutSignature(result)), result.signature.value),
      "재서명이 공개키로 검증되어야 함",
    );
    assert.doesNotThrow(() => validateManifest(result, { requireProduction: true }), "validateManifest 통과해야 함");
  } finally {
    if (savedPriv !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedPriv;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
    if (savedPub !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = savedPub;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  }
});

test("buildRolloutManifest (b): percentage 100 → rollout 없음, releases에서 rollout 제거한 구조와 deepStrictEqual", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const releases = buildProductionReleasesManifest();
  const { rollout: _dropRollout, ...releasesWithoutRollout } = releases;
  const result = buildRolloutManifest({ releases, current: null, targetSequence: releases.releaseSequence, percentage: 100 });
  assert.deepStrictEqual(result, releasesWithoutRollout);
});

test("buildRolloutManifest (c): current.rollout.seed 존재 → 신규 percentage 결과 seed 계승", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const releases = buildProductionReleasesManifest();
  const existingSeed = "b".repeat(32);
  const current = { ...releases, rollout: { percentage: 30, seed: existingSeed } };
  const savedPriv = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
  const savedPub = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  try {
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = testPrivateKeyPem;
    process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = testPublicKeyPem;
    const result = buildRolloutManifest({ releases, current, targetSequence: releases.releaseSequence, percentage: 70 });
    assert.equal(result.rollout.seed, existingSeed, "seed 계승해야 함");
    assert.equal(result.rollout.percentage, 70);
  } finally {
    if (savedPriv !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = savedPriv;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM;
    if (savedPub !== undefined) process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = savedPub;
    else delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  }
});

test("buildRolloutManifest (d): targetSequence ≠ releases.releaseSequence → throws /sequence mismatch/", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const releases = buildProductionReleasesManifest();
  assert.throws(
    () => buildRolloutManifest({ releases, current: null, targetSequence: 999, percentage: 50 }),
    /sequence mismatch/,
  );
});

test("buildRolloutManifest (e): current.releaseSequence ≠ targetSequence → throws /다른 릴리즈/", async () => {
  const { buildRolloutManifest } = await import("./update-rollout.mjs");
  const releases = buildProductionReleasesManifest();
  const staleRelease = buildProductionReleasesManifest({ releaseSequence: 3 });
  assert.throws(
    () => buildRolloutManifest({ releases, current: staleRelease, targetSequence: releases.releaseSequence, percentage: 50 }),
    /다른 릴리즈/,
  );
});

// ─── publish-rollout CLI 테스트 (#1692) ────────────────────────────────────────
// rollback-manifest.test.mjs의 startStorage·패턴을 재사용해 mock 객체스토리지를 구성.

const ROLLOUT_PACK_BYTES = Buffer.from("rollout-test-pack-bytes");
const ROLLOUT_PACK_SHA = createHash("sha256").update(ROLLOUT_PACK_BYTES).digest("hex");

function buildRolloutTestReleasesManifest(overrides = {}) {
  const sqliteSha = "a".repeat(64);
  const base = {
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 10,
    publishedAt: "2026-07-07T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    signature: { algorithm: "rsa-sha256-manifest-v2", value: "placeholder" },
    packs: [
      {
        id: "capital",
        version: "1",
        artifactKind: "production",
        url: "https://cdn.example.com/catalog/capital-v1.sqlite.gz",
        sha256: ROLLOUT_PACK_SHA,
        sqliteSha256: sqliteSha,
        sizeBytes: ROLLOUT_PACK_BYTES.length,
        signature: {
          algorithm: "rsa-sha256-pack-manifest-v2",
          value: _rolloutSign("rollout-pack-payload"),
        },
        schemaVersion: "1",
        sourceInventory: [
          {
            id: "src1",
            owner: "test-owner",
            url: "https://data.example.com/catalog",
            license: "CC-BY-4.0",
            licenseStatus: "redistributable",
            redistributionAllowed: true,
            updateFrequency: "daily",
            updatedAt: "2026-07-07T00:00:00.000Z",
            fields: ["stations"],
            coverageScope: {
              regionIds: ["seoul"],
              operatorIds: ["seoulmetro"],
              sourceDomains: ["station_map"],
            },
          },
        ],
        regionalQualityMetrics: {
          stationCount: 100,
          edgeCount: 200,
          facilityCoverageRatio: 0.5,
          requiredFacilityEvidenceCoverageRatio: 0.5,
          strictRouteEligibleFacilityRatio: 0.5,
          operationalKnownRatio: 1.0,
          freshnessValidRatio: 0.8,
          fieldVerifiedPathwayRatio: 0.3,
          unknownAccessibilityRatio: 0.2,
          unknownEdgeRatioByProfile: { wheelchair: 0.1, stroller: 0.1, lowMobility: 0.1 },
        },
        representativeRouteRegressions: [],
        representativeRouteRegressionSignature: {
          algorithm: "rsa-sha256-route-regression-v1",
          value: _rolloutSign("rollout-regression-payload"),
        },
        requiredTables: ["stations"],
        minimumTableRows: {
          stations: 1,
          station_lines: 1,
          network_edges: 1,
          facilities: 1,
          station_facility_evidence: 1,
        },
      },
    ],
    ...overrides,
  };
  const { signature: _dropSig, ...unsigned } = base;
  base.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: _rolloutSign(_rolloutCanonicalJson(unsigned)),
  };
  return base;
}

async function startRolloutTestStorage(seed) {
  const objects = new Map(seed);
  const server = createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\//, ""));
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        objects.set(key, { body: Buffer.concat(chunks) });
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    const found = objects.get(key);
    if (!found) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-length", String(found.body.length));
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : found.body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, objects, port: server.address().port })));
}

const rolloutTestEnv = {
  ...process.env,
  EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: testPublicKeyPem,
  EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: testPrivateKeyPem,
};

async function runPublishRollout(args, baseUrl) {
  return execFileAsync(
    "node",
    [path.join(root, "tools/datapack/publish-rollout.mjs"), "--base-url", baseUrl, ...args],
    { env: rolloutTestEnv },
  );
}

test("publish-rollout (①): --percentage 30 → current.json에 rollout{30,seed hex32}+서명 유효+참조 pack sha 검증 통과", async () => {
  const manifest = buildRolloutTestReleasesManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const oldCurrentBytes = Buffer.from(JSON.stringify({ ...manifest, rollout: { percentage: 10, seed: "c".repeat(32) } }));

  const storage = await startRolloutTestStorage([
    ["catalog/releases/10.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: ROLLOUT_PACK_BYTES }],
    ["catalog/current.json", { body: oldCurrentBytes }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    const { stdout } = await runPublishRollout(
      ["--target-sequence", "10", "--percentage", "30"],
      baseUrl,
    );
    const report = JSON.parse(stdout);
    assert.equal(report.targetSequence, 10);
    assert.equal(report.percentage, 30);
    assert.equal(report.channel, "production");

    // PUT된 current.json 검증
    const currentBytes = storage.objects.get("catalog/current.json").body;
    const current = JSON.parse(currentBytes.toString("utf8"));
    assert.ok(current.rollout, "rollout 필드 있어야 함");
    assert.equal(current.rollout.percentage, 30);
    assert.match(current.rollout.seed, /^[a-f0-9]{32}$/, "seed hex32 이어야 함");

    // 서명 재검증 — 재서명된 manifest 서명이 공개키로 검증되어야 한다
    const { verifyRsaSha256Signature, canonicalJson, withoutSignature } = await import("./lib/manifest-validation.mjs");
    assert.ok(
      verifyRsaSha256Signature(testPublicKeyPem, canonicalJson(withoutSignature(current)), current.signature.value),
      "재서명이 공개키로 검증되어야 함",
    );

    // 리포트 newCurrentSha256이 저장된 bytes와 일치
    const storedSha = createHash("sha256").update(currentBytes).digest("hex");
    assert.equal(report.newCurrentSha256, storedSha);
  } finally {
    storage.server.close();
  }
});

test("publish-rollout (②): 참조 팩 sha256 불일치 → PUT 없이 throw (fail-closed)", async () => {
  const manifest = buildRolloutTestReleasesManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  // current.json에는 releases와 동일한 매니페스트를 넣어 buildRolloutManifest가 통과하도록 한다.
  // 팩 sha256 불일치만이 fail-closed의 트리거가 되어야 한다.
  const originalCurrentBytes = Buffer.from(JSON.stringify(manifest));

  const storage = await startRolloutTestStorage([
    ["catalog/releases/10.json", { body: manifestBytes }],
    // 훼손된 팩 바이트 — sha256 불일치
    ["catalog/capital-v1.sqlite.gz", { body: Buffer.from("tampered-pack-bytes") }],
    ["catalog/current.json", { body: originalCurrentBytes }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    await assert.rejects(
      runPublishRollout(["--target-sequence", "10", "--percentage", "30"], baseUrl),
      /sha256 mismatch/,
    );
    // fail-closed: current.json은 원본 그대로 보존되어야 한다
    assert.deepEqual(storage.objects.get("catalog/current.json").body, originalCurrentBytes);
  } finally {
    storage.server.close();
  }
});

test("publish-rollout (③): --dry-run → current.json 수정 없이 exit 0 + 리포트 반환", async () => {
  const manifest = buildRolloutTestReleasesManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const originalCurrentBytes = Buffer.from(JSON.stringify(manifest));

  const storage = await startRolloutTestStorage([
    ["catalog/releases/10.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: ROLLOUT_PACK_BYTES }],
    ["catalog/current.json", { body: originalCurrentBytes }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    const { stdout } = await runPublishRollout(
      ["--dry-run", "--target-sequence", "10", "--percentage", "50"],
      baseUrl,
    );
    const report = JSON.parse(stdout);
    assert.equal(report.percentage, 50);
    // current.json은 원본 그대로 (PUT 미수행)
    assert.deepEqual(storage.objects.get("catalog/current.json").body, originalCurrentBytes);
  } finally {
    storage.server.close();
  }
});

// --- #1397 원장 해시 exporter + admin review record 생성기 ---

async function runLedgerExporter(args) {
  return execFileAsync(process.execPath, ["tools/datapack/export-ledger-hashes.mjs", ...args], { cwd: root });
}

async function runAdminReviewBuilder(args) {
  return execFileAsync(process.execPath, ["tools/datapack/build-admin-review-record.mjs", ...args], { cwd: root });
}

const catalogFixtureArg = "tools/datapack/fixtures/catalog-fixture.json";
const overrideLedgerArg = "tools/datapack/fixtures/admin-review-overrides.json";

async function runOfficialOdFareAdmissionBuilder(args) {
  return execFileAsync(process.execPath, ["tools/datapack/build-official-od-fare-admission.mjs", ...args], { cwd: root });
}

function officialOdFareEvidenceFixture() {
  const fares = {
    childCardFare: 750,
    childCashFare: 750,
    gnrlCardFare: 1950,
    gnrlCashFare: 2050,
    yungCardFare: 1220,
    yungCashFare: 2050,
  };
  return {
    schemaVersion: 1,
    artifactKind: "official-od-fare-probe-evidence",
    mappingAvailability: "AVAILABLE",
    mappingField: "dptreStnCd/arvlStnCd",
    providerId: "data-go-kr-b553766-fare2",
    equivalence: {
      cityHallLine1: { fareResponseStationCode: "0151", fareCode: "0151", verified: true },
      seoulStationLine4: { fareResponseStationCode: "0150", fareCode: "0150", verified: true },
    },
    providerMappings: [
      { stationId: "station-sangnoksu", lineId: "seoul-4", stationName: "상록수", fareStationCode: "1754" },
      { stationId: "station-sadang", lineId: "seoul-4", stationName: "사당", fareStationCode: "0433" },
      { stationId: "station-2af75c3d707b", lineId: "seoul-4", stationName: "서울역", fareStationCode: "0150" },
      { stationId: "station-a2d54a5d63d2", lineId: "line-472a81add377", stationName: "시청", fareStationCode: "0151" },
    ],
    quotes: [
      { originStationId: "station-sangnoksu", destinationStationId: "station-sadang", fares },
      { originStationId: "station-sadang", destinationStationId: "station-sangnoksu", fares },
      {
        originStationId: "station-2af75c3d707b",
        destinationStationId: "station-a2d54a5d63d2",
        fares: {
          childCardFare: 550,
          childCashFare: 550,
          gnrlCardFare: 1550,
          gnrlCashFare: 1650,
          yungCardFare: 900,
          yungCashFare: 1650,
        },
      },
    ],
    fieldNames: Object.keys(fares).sort(),
    attemptCounts: {
      "station-sadang→station-sangnoksu": 1,
      "station-sangnoksu→station-sadang": 1,
      "station-2af75c3d707b→station-a2d54a5d63d2": 1,
    },
  };
}

function busanOfficialOdFareEvidenceFixture() {
  return {
    schemaVersion: 1,
    artifactKind: "official-od-fare-probe-evidence",
    mappingAvailability: "AVAILABLE",
    mappingField: "mo_scode_s/mo_scode_e",
    providerId: "busan-transportation-cyberstation",
    equivalence: {
      routeForm: {
        cyberKinds: "1",
        destinationField: "mo_scode_e",
        originField: "mo_scode_s",
        verified: true,
      },
    },
    providerMappings: [
      { stationId: "station-fcb7a21e5606", lineId: "line-ab1a041f6266", stationName: "하단", fareStationCode: "102" },
      { stationId: "station-dd45c69d3e40", lineId: "line-ab1a041f6266", stationName: "당리", fareStationCode: "103" },
      { stationId: "station-1fc7a7c971c8", lineId: "line-ab1a041f6266", stationName: "서면", fareStationCode: "119" },
      { stationId: "station-6b611916f76a", lineId: "line-eb7b47920390", stationName: "장산", fareStationCode: "201" },
    ],
    quotes: [
      {
        originStationId: "station-fcb7a21e5606",
        destinationStationId: "station-dd45c69d3e40",
        fares: {
          childCardFare: 0,
          childCashFare: 700,
          gnrlCardFare: 1600,
          gnrlCashFare: 1700,
          yungCardFare: 1050,
          yungCashFare: 1150,
        },
      },
      {
        originStationId: "station-fcb7a21e5606",
        destinationStationId: "station-6b611916f76a",
        fares: {
          childCardFare: 0,
          childCashFare: 800,
          gnrlCardFare: 1800,
          gnrlCashFare: 1900,
          yungCardFare: 1200,
          yungCashFare: 1300,
        },
      },
      {
        originStationId: "station-1fc7a7c971c8",
        destinationStationId: "station-6b611916f76a",
        fares: {
          childCardFare: 0,
          childCashFare: 800,
          gnrlCardFare: 1800,
          gnrlCashFare: 1900,
          yungCardFare: 1200,
          yungCashFare: 1300,
        },
      },
    ],
    fieldNames: [
      "childCardFare",
      "childCashFare",
      "gnrlCardFare",
      "gnrlCashFare",
      "yungCardFare",
      "yungCashFare",
    ],
    attemptCounts: {
      officialFareTable: 1,
      "station-fcb7a21e5606→station-dd45c69d3e40": 1,
      "station-fcb7a21e5606→station-6b611916f76a": 1,
      "station-1fc7a7c971c8→station-6b611916f76a": 1,
    },
  };
}

test("fare station-line mapping 원장은 probe mapping만 canonical hash로 산출한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "fare-station-line-ledger-"));
  try {
    const evidence = officialOdFareEvidenceFixture();
    const evidencePath = path.join(workspace, "evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence));
    const args = [
      "--kind", "fare-station-line-mapping",
      "--evidence", path.relative(root, evidencePath),
      "--source-id", "seoul-metro-official-od-fares",
    ];
    const baseline = JSON.parse((await runLedgerExporter(args)).stdout);
    const operator = JSON.parse((await runLedgerExporter([
      "--kind", "operator-mapping", "--fixture", catalogFixtureArg,
    ])).stdout);
    assert.equal(baseline.kind, "fare-station-line-mapping");
    assert.equal(baseline.rowCount, 4);
    assert.notEqual(baseline.ledgerHash, operator.ledgerHash);

    const reordered = structuredClone(evidence);
    reordered.providerMappings.reverse();
    const reorderedPath = path.join(workspace, "reordered.json");
    await writeFile(reorderedPath, JSON.stringify(reordered));
    const reorderedHash = JSON.parse((await runLedgerExporter([
      "--kind", "fare-station-line-mapping",
      "--evidence", path.relative(root, reorderedPath),
      "--source-id", "seoul-metro-official-od-fares",
    ])).stdout);
    assert.equal(reorderedHash.ledgerHash, baseline.ledgerHash);

    const changed = structuredClone(evidence);
    changed.providerMappings[0].fareStationCode = "1755";
    const changedPath = path.join(workspace, "changed.json");
    await writeFile(changedPath, JSON.stringify(changed));
    const changedHash = JSON.parse((await runLedgerExporter([
      "--kind", "fare-station-line-mapping",
      "--evidence", path.relative(root, changedPath),
      "--source-id", "seoul-metro-official-od-fares",
    ])).stdout);
    assert.notEqual(changedHash.ledgerHash, baseline.ledgerHash);

    const duplicate = structuredClone(evidence);
    duplicate.providerMappings[1].fareStationCode = duplicate.providerMappings[0].fareStationCode;
    const duplicatePath = path.join(workspace, "duplicate.json");
    await writeFile(duplicatePath, JSON.stringify(duplicate));
    await assert.rejects(
      runLedgerExporter([
        "--kind", "fare-station-line-mapping",
        "--evidence", path.relative(root, duplicatePath),
        "--source-id", "seoul-metro-official-od-fares",
      ]),
      /duplicate provider station code/,
    );

    const duplicateStation = structuredClone(evidence);
    duplicateStation.providerMappings[1].stationId = duplicateStation.providerMappings[0].stationId;
    const duplicateStationPath = path.join(workspace, "duplicate-station.json");
    await writeFile(duplicateStationPath, JSON.stringify(duplicateStation));
    await assert.rejects(
      runLedgerExporter([
        "--kind", "fare-station-line-mapping",
        "--evidence", path.relative(root, duplicateStationPath),
        "--source-id", "seoul-metro-official-od-fares",
      ]),
      /duplicate station and line mapping/,
    );

    const wrongLine = structuredClone(evidence);
    wrongLine.providerMappings[0].lineId = "seoul-2";
    const wrongLinePath = path.join(workspace, "wrong-line.json");
    await writeFile(wrongLinePath, JSON.stringify(wrongLine));
    await assert.rejects(
      runLedgerExporter([
        "--kind", "fare-station-line-mapping",
        "--evidence", path.relative(root, wrongLinePath),
        "--source-id", "seoul-metro-official-od-fares",
      ]),
      /providerMappings must match fixed targets/,
    );

    const unsafeEvidence = structuredClone(evidence);
    unsafeEvidence.providerMappings[0].rawPath = "/tmp/provider.json";
    const unsafeEvidencePath = path.join(workspace, "unsafe-evidence.json");
    await writeFile(unsafeEvidencePath, JSON.stringify(unsafeEvidence));
    await assert.rejects(
      runLedgerExporter([
        "--kind", "fare-station-line-mapping",
        "--evidence", path.relative(root, unsafeEvidencePath),
        "--source-id", "seoul-metro-official-od-fares",
      ]),
      /rawPath is not allowed/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fare station-line mapping admission은 이미 읽은 evidence 객체로 ledger를 계산한다", async () => {
  const { buildFareStationLineMappingLedger } = await import("./export-ledger-hashes.mjs");
  assert.equal(typeof buildFareStationLineMappingLedger, "function");
  const evidence = officialOdFareEvidenceFixture();
  const ledger = buildFareStationLineMappingLedger(evidence, "seoul-metro-official-od-fares");
  assert.equal(ledger.kind, "fare-station-line-mapping");
  assert.equal(ledger.rowCount, 4);
  assert.match(ledger.ledgerHash, /^[0-9a-f]{64}$/);
});

test("official OD fare admission bundle은 source별 승인만 선택한다", async () => {
  const { officialOdFareAdmissionsBySource } = await import("./lib/official-od-fare-evidence.mjs");
  const trackedBundle = JSON.parse(
    await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"), "utf8"),
  );
  const admission = trackedBundle.admissions.find(
    ({ sourceId }) => sourceId === "seoul-metro-official-od-fares",
  );
  assert.ok(admission);
  const busan = {
    ...admission,
    sourceId: "busan-transportation-official-od-fares",
    snapshotId: "busan-transportation-official-od-fares-20260713",
    evidenceHash: "1".repeat(64),
    quoteSetHash: "2".repeat(64),
    fareStationLineMappingLedgerHash: "3".repeat(64),
    quoteCount: 3,
  };
  const bundle = {
    schemaVersion: 1,
    artifactKind: "official-od-fare-admission-bundle",
    admissions: [admission, busan],
  };

  const admissions = officialOdFareAdmissionsBySource(bundle);
  assert.equal(admissions.size, 2);
  assert.equal(admissions.get(admission.sourceId), admission);
  assert.equal(admissions.get(busan.sourceId), busan);
  assert.throws(
    () => officialOdFareAdmissionsBySource({ ...bundle, admissions: [admission, admission] }),
    /duplicate official OD fare admission sourceId/,
  );
  assert.throws(
    () => officialOdFareAdmissionsBySource({ ...bundle, unexpected: true }),
    /official OD fare admission bundle/,
  );
});

test("official OD fare admin review는 sanitized admission만 생성한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-admission-"));
  try {
    const evidence = officialOdFareEvidenceFixture();
    const evidencePath = path.join(workspace, "evidence.json");
    const evidenceBytes = JSON.stringify(evidence);
    await writeFile(evidencePath, evidenceBytes);
    const review = {
      schemaVersion: 1,
      artifactKind: "official-od-fare-admin-review",
      evidenceHash: sha256(evidenceBytes),
      decision: "APPROVED",
      approvedBy: "owner",
      approvedAt: "2026-07-12T00:00:00.000Z",
      sourceId: "seoul-metro-official-od-fares",
      snapshotId: "seoul-metro-official-od-fares-20260712",
    };
    const reviewPath = path.join(workspace, "review.json");
    await writeFile(reviewPath, JSON.stringify(review));
    const trackedBundle = JSON.parse(
      await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"), "utf8"),
    );
    const preservedAdmission = trackedBundle.admissions.find(
      ({ sourceId }) => sourceId === "busan-transportation-official-od-fares",
    );
    const bundlePath = path.join(workspace, "bundle.json");
    await writeFile(bundlePath, JSON.stringify(trackedBundle));
    const { stdout } = await runOfficialOdFareAdmissionBuilder([
      "--evidence", path.relative(root, evidencePath),
      "--admin-review", path.relative(root, reviewPath),
      "--bundle", path.relative(root, bundlePath),
    ]);
    const bundle = JSON.parse(stdout);
    assert.equal(bundle.artifactKind, "official-od-fare-admission-bundle");
    assert.equal(bundle.schemaVersion, 1);
    assert.deepEqual(
      bundle.admissions.find(({ sourceId }) => sourceId === preservedAdmission.sourceId),
      preservedAdmission,
    );
    const admission = bundle.admissions.find(({ sourceId }) => sourceId === review.sourceId);
    assert.deepEqual(Object.keys(admission).sort(), [
      "approvedAt", "approvedBy", "artifactKind", "decision", "evidenceHash",
      "fareStationLineMappingLedgerHash", "quoteCount", "quoteSetHash", "schemaVersion", "snapshotId", "sourceId",
    ].sort());
    assert.equal(admission.artifactKind, "official-od-fare-admission");
    assert.equal(admission.quoteCount, 2);
    assert.match(admission.quoteSetHash, /^[0-9a-f]{64}$/);
    assert.match(admission.fareStationLineMappingLedgerHash, /^[0-9a-f]{64}$/);
    const generatedBundlePath = path.join(workspace, "generated-bundle.json");
    await writeFile(generatedBundlePath, stdout);
    await execFileAsync(process.execPath, [
      "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
      "--admission", generatedBundlePath,
      "--check",
    ], { cwd: root });

    const unsafeReview = { ...review, rawPath: "/tmp/provider.json" };
    const unsafeReviewPath = path.join(workspace, "unsafe-review.json");
    await writeFile(unsafeReviewPath, JSON.stringify(unsafeReview));
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder([
        "--evidence", path.relative(root, evidencePath),
        "--admin-review", path.relative(root, unsafeReviewPath),
      ]),
      /raw.*not allowed/,
    );

    const mismatchedEvidence = structuredClone(evidence);
    mismatchedEvidence.quotes[0].destinationStationId = "station-unknown";
    const mismatchedPath = path.join(workspace, "mismatched-evidence.json");
    await writeFile(mismatchedPath, JSON.stringify(mismatchedEvidence));
    const mismatchedReview = { ...review, evidenceHash: sha256(JSON.stringify(mismatchedEvidence)) };
    const mismatchedReviewPath = path.join(workspace, "mismatched-review.json");
    await writeFile(mismatchedReviewPath, JSON.stringify(mismatchedReview));
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder([
        "--evidence", path.relative(root, mismatchedPath),
        "--admin-review", path.relative(root, mismatchedReviewPath),
      ]),
      /quote endpoints must match provider mappings/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("부산 official OD fare admission은 공식 운임표 시도 횟수를 보존한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "busan-official-od-fare-admission-"));
  try {
    const evidence = busanOfficialOdFareEvidenceFixture();
    const evidencePath = path.join(workspace, "evidence.json");
    const evidenceBytes = JSON.stringify(evidence);
    await writeFile(evidencePath, evidenceBytes);
    const review = {
      schemaVersion: 1,
      artifactKind: "official-od-fare-admin-review",
      evidenceHash: sha256(evidenceBytes),
      decision: "APPROVED",
      approvedBy: "owner",
      approvedAt: "2026-07-13T00:00:00.000Z",
      sourceId: "busan-transportation-official-od-fares",
      snapshotId: "busan-transportation-official-od-fares-20260713",
    };
    const reviewPath = path.join(workspace, "review.json");
    await writeFile(reviewPath, JSON.stringify(review));

    const { stdout } = await runOfficialOdFareAdmissionBuilder([
      "--evidence", path.relative(root, evidencePath),
      "--admin-review", path.relative(root, reviewPath),
    ]);
    const bundle = JSON.parse(stdout);
    const admission = bundle.admissions.find(({ sourceId }) => sourceId === review.sourceId);
    assert.equal(admission.quoteCount, 3);
    assert.equal(admission.snapshotId, review.snapshotId);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("official OD fare admission은 probe 내부 계약과 hash binding을 강제한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-contract-"));
  try {
    const writeCase = async (name, evidence, reviewOverrides = {}) => {
      const evidencePath = path.join(workspace, `${name}-evidence.json`);
      const evidenceBytes = JSON.stringify(evidence);
      await writeFile(evidencePath, evidenceBytes);
      const review = {
        schemaVersion: 1,
        artifactKind: "official-od-fare-admin-review",
        evidenceHash: sha256(evidenceBytes),
        decision: "APPROVED",
        approvedBy: "owner",
        approvedAt: "2026-07-12T00:00:00.000Z",
        sourceId: "seoul-metro-official-od-fares",
        snapshotId: "seoul-metro-official-od-fares-20260712",
        ...reviewOverrides,
      };
      const reviewPath = path.join(workspace, `${name}-review.json`);
      await writeFile(reviewPath, JSON.stringify(review));
      return [
        "--evidence", path.relative(root, evidencePath),
        "--admin-review", path.relative(root, reviewPath),
      ];
    };

    for (const key of ["payload", "raw", "rawObjectUri", "rawPath", "requestUrl"]) {
      const evidence = officialOdFareEvidenceFixture();
      evidence.providerMappings[0][key] = "unsafe";
      await assert.rejects(
        runOfficialOdFareAdmissionBuilder(await writeCase(`unsafe-${key}`, evidence)),
        new RegExp(`${key} is not allowed`),
      );
    }

    const invalidEquivalence = officialOdFareEvidenceFixture();
    invalidEquivalence.equivalence.seoulStationLine4.verified = false;
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder(await writeCase("invalid-equivalence", invalidEquivalence)),
      /equivalence/,
    );

    const invalidAttempts = officialOdFareEvidenceFixture();
    invalidAttempts.attemptCounts["station-sangnoksu→station-sadang"] = 3;
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder(await writeCase("invalid-attempts", invalidAttempts)),
      /attemptCounts/,
    );

    const wrongTarget = officialOdFareEvidenceFixture();
    wrongTarget.providerMappings[0].stationId = "station-unknown";
    wrongTarget.providerMappings[0].stationName = "미확인역";
    wrongTarget.quotes[0].originStationId = "station-unknown";
    wrongTarget.quotes[1].destinationStationId = "station-unknown";
    delete wrongTarget.attemptCounts["station-sangnoksu→station-sadang"];
    delete wrongTarget.attemptCounts["station-sadang→station-sangnoksu"];
    wrongTarget.attemptCounts["station-unknown→station-sadang"] = 1;
    wrongTarget.attemptCounts["station-sadang→station-unknown"] = 1;
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder(await writeCase("wrong-target", wrongTarget)),
      /providerMappings must match fixed targets/,
    );

    const hashMismatch = officialOdFareEvidenceFixture();
    await assert.rejects(
      runOfficialOdFareAdmissionBuilder(await writeCase("hash-mismatch", hashMismatch, {
        evidenceHash: "f".repeat(64),
      })),
      /evidenceHash must match/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("source inventory는 official OD fare admission hash 쌍을 함께 요구한다", async () => {
  const sourceInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const validInventory = structuredClone(sourceInventory);
  const fareSource = validInventory.sources.find(({ id }) => id === "seoul-metro-official-od-fares");
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-inventory-"));
  try {
    const validPath = path.join(workspace, "valid.json");
    await writeFile(validPath, JSON.stringify(validInventory));
    await execFileAsync(process.execPath, [
      "tools/datapack/validate-source-inventory.mjs", "--inventory", validPath,
    ], { cwd: root });

    const invalidInventory = structuredClone(validInventory);
    delete invalidInventory.sources.find(({ id }) => id === fareSource.id).fareStationLineMappingLedgerHash;
    const invalidPath = path.join(workspace, "invalid.json");
    await writeFile(invalidPath, JSON.stringify(invalidInventory));
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/validate-source-inventory.mjs", "--inventory", invalidPath,
      ], { cwd: root }),
      /fareStationLineMappingLedgerHash must be a sha256 hex string/,
    );

    const nonFareInventory = structuredClone(sourceInventory);
    const nonFareSource = nonFareInventory.sources.find(({ id }) => id === "kric-disabled-toilet");
    nonFareSource.officialOdFareAdmissionHash = "a".repeat(64);
    nonFareSource.fareStationLineMappingLedgerHash = "b".repeat(64);
    const nonFarePath = path.join(workspace, "non-fare.json");
    await writeFile(nonFarePath, JSON.stringify(nonFareInventory));
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/validate-source-inventory.mjs", "--inventory", nonFarePath,
      ], { cwd: root }),
      /official OD fare references require all six official fare fields/,
    );

    const partialFareInventory = structuredClone(nonFareInventory);
    partialFareInventory.sources.find(({ id }) => id === "kric-disabled-toilet").fieldsProvided.push("gnrlCardFare");
    const partialFarePath = path.join(workspace, "partial-fare.json");
    await writeFile(partialFarePath, JSON.stringify(partialFareInventory));
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/validate-source-inventory.mjs", "--inventory", partialFarePath,
      ], { cwd: root }),
      /official OD fare references require all six official fare fields/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("official OD fare candidate admission은 inventory hash 쌍과 일치해야 한다", async () => {
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"));
  const candidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json"), "utf8"));
  const source = inventory.sources.find(({ id }) => id === "seoul-metro-official-od-fares");
  const candidate = candidates.candidates.find(({ id }) => id === "seoul-metro-official-od-fares");
  const admissionBundle = JSON.parse(
    await readFile(path.join(root, "tools/datapack/official-od-fare-admission.json"), "utf8"),
  );
  const admission = admissionBundle.admissions.find(
    ({ sourceId }) => sourceId === "seoul-metro-official-od-fares",
  );

  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-candidate-"));
  try {
    const inventoryPath = path.join(workspace, "inventory.json");
    const candidatesPath = path.join(workspace, "candidates.json");
    const admissionPath = path.join(workspace, "admission.json");
    const validate = () => execFileAsync(process.execPath, [
      "tools/datapack/validate-source-inventory.mjs",
      "--inventory", inventoryPath,
      "--candidates", candidatesPath,
      "--official-od-fare-admission", admissionPath,
    ], { cwd: root });
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await writeFile(admissionPath, JSON.stringify(admissionBundle, null, 2) + "\n");
    await validate();

    candidate.evidence.fareStationLineMappingLedgerHash = "c".repeat(64);
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(validate(), /fareStationLineMappingLedgerHash must match/);

    candidate.evidence.fareStationLineMappingLedgerHash = source.fareStationLineMappingLedgerHash;
    candidate.domain = "accessibility_facilities";
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(validate(), /candidate domain must be "official_od_fares"/);

    candidate.domain = "official_od_fares";
    source.coverageScope.sourceDomains = ["accessibility_facilities"];
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(validate(), /source domain must be official_od_fares/);

    source.coverageScope.sourceDomains = ["official_od_fares"];
    candidate.admissionStatus = "evidence_recorded_admin_review_required";
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await assert.rejects(validate(), /official OD fare source requires an admitted candidate/);

    candidate.admissionStatus = "official_od_fare_admitted_to_production_inventory";
    admission.decision = "REJECTED";
    const rejectedBytes = JSON.stringify(admissionBundle, null, 2) + "\n";
    source.officialOdFareAdmissionHash = sha256(rejectedBytes);
    candidate.evidence.officialOdFareAdmissionHash = source.officialOdFareAdmissionHash;
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(candidatesPath, JSON.stringify(candidates));
    await writeFile(admissionPath, rejectedBytes);
    await assert.rejects(validate(), /admission decision must be "APPROVED"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("official OD fare 두 방향은 승인 artifact와 일치하는 SQLite row로 저장된다", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, "tools/datapack/fixtures/catalog-fixture.json"), "utf8"));
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

  const outputDir = await mkdtemp(path.join(tmpdir(), "official-od-fare-pack-"));
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture", "tools/datapack/fixtures/catalog-fixture.json",
        "--output", outputDir,
      ],
      { cwd: root, env: productionEnv },
    );
    const compressed = await readFile(path.join(outputDir, "catalog/capital-v1.sqlite.gz"));
    const databasePath = path.join(outputDir, "capital-v1.sqlite");
    await writeFile(databasePath, gunzipSync(compressed));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
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
        left.originStationId.localeCompare(right.originStationId)
          || left.destinationStationId.localeCompare(right.destinationStationId)));
    } finally {
      database.close();
    }
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/validate-datapack.mjs",
        "--manifest", path.join(outputDir, "current.json"),
        "--root", outputDir,
      ],
      { cwd: root, env: productionEnv },
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("전국 bundled datapack은 수도권·부산 대표 공식 OD를 각 3건 포함한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-fares-"));
  const databasePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      databasePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT origin_station_id AS originStationId,
               destination_station_id AS destinationStationId,
               source_id AS sourceId,
               snapshot_id AS snapshotId
        FROM official_od_fare_quotes
        ORDER BY source_id, origin_station_id, destination_station_id
      `).all().map((row) => ({ ...row }));
      const capitalRows = rows.filter(({ sourceId }) => sourceId.startsWith("seoul-metro-official-od-fare"));
      const busanRows = rows.filter(({ sourceId }) => sourceId === "busan-transportation-official-od-fares");
      assert.equal(capitalRows.length, 3);
      assert.equal(busanRows.length, 3);
      for (const row of rows) {
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM stations WHERE id IN (?, ?)")
          .get(row.originStationId, row.destinationStationId).count, 2);
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote 적용은 admission 일부 source가 빠진 입력을 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-partial-source-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const quotesPath = path.join(directory, "quotes.json");
  try {
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
    const quotes = JSON.parse(
      await readFile(path.join(root, "tools/datapack/official-od-fare-quotes.json"), "utf8"),
    );
    quotes.quotes = quotes.quotes.filter(
      ({ sourceId }) => sourceId === "seoul-metro-official-od-fares",
    );
    await writeFile(quotesPath, JSON.stringify(quotes));
    const originalPackHash = sha256(await readFile(packPath));

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
        "--quotes", quotesPath,
      ], { cwd: root }),
      /quote source set must match admission source set/,
    );
    assert.equal(sha256(await readFile(packPath)), originalPackHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote 재적용은 SQLite와 gzip hash를 변경하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-idempotent-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  try {
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
    const apply = () => execFileAsync(process.execPath, [
      "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
      "--pack", packPath,
      "--index", indexPath,
    ], { cwd: root });

    await apply();
    const firstPack = await readFile(packPath);
    const firstIndex = await readFile(indexPath);
    await apply();

    assert.equal(sha256(await readFile(packPath)), sha256(firstPack));
    assert.equal(sha256(await readFile(indexPath)), sha256(firstIndex));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote check는 catalog user_version 16을 요구한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-check-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 15");
    database.close();
    const sqliteBytes = await readFile(sqlitePath);
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    await writeFile(packPath, gzipBytes);
    const index = JSON.parse(
      await readFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"),
    );
    Object.assign(index.packs.find(({ id }) => id === "capital"), {
      sha256: sha256(gzipBytes),
      sqliteSha256: sha256(sqliteBytes),
      byteSize: gzipBytes.length,
    });
    await writeFile(indexPath, JSON.stringify(index));

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
        "--check",
      ], { cwd: root }),
      /bundled catalog user_version must be 16/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote no-op도 catalog user_version 16을 강제한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-user-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 15");
    database.close();
    await writeFile(packPath, gzipSync(await readFile(sqlitePath), { level: 9, mtime: 0 }));
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);

    await execFileAsync(process.execPath, [
      "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
      "--pack", packPath,
      "--index", indexPath,
    ], { cwd: root });

    await writeFile(sqlitePath, gunzipSync(await readFile(packPath)));
    const updated = new DatabaseSync(sqlitePath, { readOnly: true });
    assert.equal(updated.prepare("PRAGMA user_version").get().user_version, 16);
    updated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 공식 OD quote 후처리기는 v18 catalog를 v16으로 낮추지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-official-od-newer-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 18");
    database.close();
    const inputPack = gzipSync(await readFile(sqlitePath), { level: 9, mtime: 0 });
    await writeFile(packPath, inputPack);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-official-od-fares-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
      ], { cwd: root }),
      /does not support catalog user_version 18 newer than 16/,
    );

    assert.equal(sha256(await readFile(packPath)), sha256(inputPack));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("수도권 bundled datapack은 빠른하차 차량·출입문 힌트 35건을 포함한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-"));
  const databasePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      databasePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM station_car_door_hints").get().count, 35);
      const distribution = database.prepare(`
        SELECT station_id AS stationId, line_id AS lineId, COUNT(*) AS count
        FROM station_car_door_hints
        GROUP BY station_id, line_id
        ORDER BY station_id, line_id
      `).all().map((row) => ({ ...row }));
      assert.deepEqual(distribution, [
        { stationId: "station-gangnam", lineId: "seoul-2", count: 10 },
        { stationId: "station-sadang", lineId: "seoul-2", count: 13 },
        { stationId: "station-sadang", lineId: "seoul-4", count: 8 },
        { stationId: "station-seongsu", lineId: "seoul-2", count: 4 },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 차량·출입문 힌트 재적용은 SQLite와 gzip hash를 변경하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-idempotent-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  try {
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"), packPath);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);
    const apply = () => execFileAsync(process.execPath, [
      "tools/datapack/apply-car-door-hints-to-bundled-pack.mjs",
      "--pack", packPath,
      "--index", indexPath,
    ], { cwd: root });

    await apply();
    const firstPack = await readFile(packPath);
    const firstIndex = await readFile(indexPath);
    await apply();

    assert.equal(sha256(await readFile(packPath)), sha256(firstPack));
    assert.equal(sha256(await readFile(indexPath)), sha256(firstIndex));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 차량·출입문 힌트 check는 catalog user_version 16을 요구한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-check-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 15");
    database.close();
    const sqliteBytes = await readFile(sqlitePath);
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    await writeFile(packPath, gzipBytes);
    const index = JSON.parse(
      await readFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), "utf8"),
    );
    Object.assign(index.packs.find(({ id }) => id === "capital"), {
      sha256: sha256(gzipBytes),
      sqliteSha256: sha256(sqliteBytes),
      byteSize: gzipBytes.length,
    });
    await writeFile(indexPath, JSON.stringify(index));

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-car-door-hints-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
        "--check",
      ], { cwd: root }),
      /bundled catalog user_version must be 16/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundled 차량·출입문 힌트 후처리기는 v18 catalog를 v16으로 낮추지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundled-car-door-hints-newer-version-"));
  const packPath = path.join(directory, "capital.sqlite.gz");
  const indexPath = path.join(directory, "index.json");
  const sqlitePath = path.join(directory, "capital.sqlite");
  try {
    await writeFile(
      sqlitePath,
      gunzipSync(await readFile(path.join(root, "apps/mobile/assets/datapacks/capital.sqlite.gz"))),
    );
    const database = new DatabaseSync(sqlitePath);
    database.exec("PRAGMA user_version = 18");
    database.close();
    const inputPack = gzipSync(await readFile(sqlitePath), { level: 9, mtime: 0 });
    await writeFile(packPath, inputPack);
    await copyFile(path.join(root, "apps/mobile/assets/datapacks/index.json"), indexPath);

    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/apply-car-door-hints-to-bundled-pack.mjs",
        "--pack", packPath,
        "--index", indexPath,
      ], { cwd: root }),
      /does not support catalog user_version 18 newer than 16/,
    );

    assert.equal(sha256(await readFile(packPath)), sha256(inputPack));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("official OD fare builder는 malformed·미승인·formula-shaped row를 거부한다", async () => {
  const baseline = JSON.parse(await readFile(path.join(root, "tools/datapack/fixtures/catalog-fixture.json"), "utf8"));
  const cases = [
    ["missing-fare", (quote) => delete quote.gnrlCardFare, /officialOdFareQuotes.*gnrlCardFare/],
    ["wrong-hash", (quote) => { quote.mappingLedgerHash = "f".repeat(64); }, /mappingLedgerHash must match/],
    ["same-endpoint", (quote) => { quote.destinationStationId = quote.originStationId; }, /endpoints must be distinct/],
    ["formula-shaped", (quote) => { quote.baseCardFare = 1550; }, /baseCardFare is not allowed/],
    ["changed-approved-fare", (quote) => { quote.gnrlCardFare += 1; }, /quote set hash must match admission/],
    ["unsafe-integer", (quote) => { quote.gnrlCardFare = Number.MAX_SAFE_INTEGER + 1; }, /safe integer/],
  ];

  for (const [name, mutate, expected] of cases) {
    const workspace = await mkdtemp(path.join(tmpdir(), `official-od-fare-${name}-`));
    try {
      const fixture = structuredClone(baseline);
      mutate(fixture.packs[0].officialOdFareQuotes[0]);
      const fixturePath = path.join(workspace, "fixture.json");
      await writeFile(fixturePath, JSON.stringify(fixture));
      await assert.rejects(
        execFileAsync(
          process.execPath,
          ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", path.join(workspace, "out")],
          { cwd: root, env: productionEnv },
        ),
        expected,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test("official OD fare validator는 signed pack 내부의 admission hash 변조를 거부한다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "official-od-fare-tampered-pack-"));
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture", "tools/datapack/fixtures/catalog-fixture.json",
        "--output", outputDir,
      ],
      { cwd: root, env: productionEnv },
    );
    const manifestPath = path.join(outputDir, "current.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const pack = manifest.packs[0];
    const sqlitePath = path.join(outputDir, "catalog/capital-v1.sqlite");
    const database = new DatabaseSync(sqlitePath);
    try {
      database.prepare("UPDATE official_od_fare_quotes SET mapping_ledger_hash = ?").run("f".repeat(64));
    } finally {
      database.close();
    }
    const sqliteBytes = await readFile(sqlitePath);
    const compressedBytes = gzipSync(sqliteBytes);
    await writeFile(path.join(outputDir, "catalog/capital-v1.sqlite.gz"), compressedBytes);
    pack.sizeBytes = compressedBytes.length;
    pack.sha256 = sha256(compressedBytes);
    pack.sqliteSha256 = sha256(sqliteBytes);
    const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
    pack.signature.value = sha256(Buffer.from(fixturePayload));
    pack.representativeRouteRegressionSignature.value = sha256(
      Buffer.from(`${fixturePayload}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`),
    );
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["tools/datapack/validate-datapack.mjs", "--manifest", manifestPath, "--root", outputDir],
        { cwd: root, env: productionEnv },
      ),
      /official OD fare mapping_ledger_hash must match admission/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("official OD fare validator는 signed pack 내부의 승인 요금 변조를 거부한다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "official-od-fare-tampered-value-pack-"));
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture", "tools/datapack/fixtures/catalog-fixture.json",
        "--output", outputDir,
      ],
      { cwd: root, env: productionEnv },
    );
    const manifestPath = path.join(outputDir, "current.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const pack = manifest.packs[0];
    const sqlitePath = path.join(outputDir, "catalog/capital-v1.sqlite");
    const database = new DatabaseSync(sqlitePath);
    try {
      database.prepare("UPDATE official_od_fare_quotes SET gnrl_card_fare = gnrl_card_fare + 1").run();
    } finally {
      database.close();
    }
    const sqliteBytes = await readFile(sqlitePath);
    const compressedBytes = gzipSync(sqliteBytes);
    await writeFile(path.join(outputDir, "catalog/capital-v1.sqlite.gz"), compressedBytes);
    pack.sizeBytes = compressedBytes.length;
    pack.sha256 = sha256(compressedBytes);
    pack.sqliteSha256 = sha256(sqliteBytes);
    const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
    pack.signature.value = sha256(Buffer.from(fixturePayload));
    pack.representativeRouteRegressionSignature.value = sha256(
      Buffer.from(`${fixturePayload}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`),
    );
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["tools/datapack/validate-datapack.mjs", "--manifest", manifestPath, "--root", outputDir],
        { cwd: root, env: productionEnv },
      ),
      /official OD fare quote set hash must match admission/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("official OD fare validator는 pack inventory에 없는 source를 거부한다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "official-od-fare-missing-source-"));
  try {
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-datapack.mjs",
        "--fixture", "tools/datapack/fixtures/catalog-fixture.json",
        "--output", outputDir,
      ],
      { cwd: root, env: productionEnv },
    );
    const manifestPath = path.join(outputDir, "current.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.packs[0].sourceInventory = manifest.packs[0].sourceInventory.filter(
      (source) => source.id !== "seoul-metro-official-od-fares",
    );
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["tools/datapack/validate-datapack.mjs", "--manifest", manifestPath, "--root", outputDir],
        { cwd: root, env: productionEnv },
      ),
      /official OD fare source_id is not in sourceInventory/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("official OD fare release candidate는 승인된 두 방향 quote와 provenance를 SQLite에 남긴다", async () => {
  const approvedEvidence = JSON.parse(await readFile(path.join(root, "tools/datapack/release/hash-evidence.json"), "utf8")).officialOdFareEvidence;
  const candidateFixture = JSON.parse(await readFile(path.join(root, "tools/datapack/release/capital-production-reviewed-pack.json"), "utf8"));
  assert.deepEqual(candidateFixture.packs[0].officialOdFareQuotes, approvedEvidence.quotes);
  assert.equal(candidateFixture.packs[0].officialOdFareQuotes.length, 2);
  assert.ok(candidateFixture.packs[0].sourceInventory.some(
    (source) => source.id === approvedEvidence.sourceId
      && source.coverageScope.sourceDomains.includes("official_od_fares"),
  ));

  const outputDir = await mkdtemp(path.join(tmpdir(), "official-od-fare-release-candidate-"));
  try {
    await execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--build-spec", "tools/datapack/release/candidate-build-spec.json", "--output", outputDir],
      { cwd: root, env: productionEnv },
    );
    const database = new DatabaseSync(path.join(outputDir, "catalog/capital-v1.sqlite"));
    let rows;
    try {
      rows = database.prepare(`SELECT origin_station_id AS originStationId,
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
                               ORDER BY rowid`).all();
    } finally {
      database.close();
    }
    assert.deepEqual(rows.map((row) => ({ ...row })), approvedEvidence.quotes);
    const manifest = JSON.parse(await readFile(path.join(outputDir, "current.json"), "utf8"));
    assert.ok(manifest.packs[0].sourceInventory.some(
      (source) => source.id === approvedEvidence.sourceId,
    ));
    const provenance = JSON.parse(await readFile(path.join(outputDir, "current.provenance.json"), "utf8"));
    assert.deepEqual(provenance.candidateBuild.officialOdFareEvidence, approvedEvidence);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("official OD fare release candidate는 admission과 다른 quote set evidence를 거부한다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "official-od-fare-release-mismatch-"));
  try {
    const buildSpec = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
    buildSpec.officialOdFareEvidence.quoteSetHash = "f".repeat(64);
    const buildSpecPath = path.join(workspace, "candidate-build-spec.json");
    await writeFile(buildSpecPath, JSON.stringify(buildSpec));
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["tools/datapack/build-datapack.mjs", "--build-spec", buildSpecPath, "--output", path.join(workspace, "output")],
        { cwd: root, env: productionEnv },
      ),
      /officialOdFareEvidence.quoteSetHash must match admission/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("원장 해시 exporter는 fixture 원장 5종 + license를 sha256으로 산출한다", async () => {
  const kinds = [
    ["alias", ["--fixture", catalogFixtureArg]],
    ["operator-mapping", ["--fixture", catalogFixtureArg]],
    ["facility-evidence", ["--fixture", catalogFixtureArg]],
    ["route-evidence", ["--fixture", catalogFixtureArg]],
    ["override", ["--overrides", overrideLedgerArg]],
    ["license", ["--source-id", "seoulmetro-station-line-info"]],
  ];
  for (const [kind, extra] of kinds) {
    const { stdout } = await runLedgerExporter(["--kind", kind, ...extra]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, kind, `${kind} kind`);
    assert.match(parsed.ledgerHash, /^[0-9a-f]{64}$/, `${kind} ledgerHash`);
    assert.equal(parsed.schemaVersion, 1);
  }
});

test("원장 해시 exporter는 결정적이다 (같은 입력 = 같은 해시)", async () => {
  const first = JSON.parse((await runLedgerExporter(["--kind", "alias", "--fixture", catalogFixtureArg])).stdout);
  const second = JSON.parse((await runLedgerExporter(["--kind", "alias", "--fixture", catalogFixtureArg])).stdout);
  assert.equal(first.ledgerHash, second.ledgerHash);
});

test("원장 해시 exporter는 레코드 순서가 바뀌어도 같은 해시를 낸다", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, catalogFixtureArg), "utf8"));
  const baseline = JSON.parse((await runLedgerExporter(["--kind", "alias", "--fixture", catalogFixtureArg])).stdout);

  const workspace = await mkdtemp(path.join(tmpdir(), "ledger-order-"));
  try {
    const reordered = structuredClone(fixture);
    reordered.packs[0].stationAliases.reverse();
    const reorderedPath = path.join(workspace, "reordered-fixture.json");
    await writeFile(reorderedPath, JSON.stringify(reordered));
    const { stdout } = await runLedgerExporter([
      "--kind",
      "alias",
      "--fixture",
      path.relative(root, reorderedPath),
    ]);
    assert.equal(JSON.parse(stdout).ledgerHash, baseline.ledgerHash);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("원장 해시 exporter는 알 수 없는 kind를 거부한다", async () => {
  await assert.rejects(runLedgerExporter(["--kind", "unknown", "--fixture", catalogFixtureArg]));
});

test("원장 해시 exporter는 license source-id가 inventory에 없으면 거부한다", async () => {
  await assert.rejects(runLedgerExporter(["--kind", "license", "--source-id", "does-not-exist"]));
});

test("원장 해시 exporter는 stationFacilityEvidence primary 분기를 쓰고 evidenceSource를 표기한다", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, catalogFixtureArg), "utf8"));
  const evidenceRows = [
    {
      stationId: "station-b",
      lineId: "line-2",
      facilityType: "ELEVATOR",
      evidenceHash: "b".repeat(64),
      providerRecordHash: "2".repeat(64),
    },
    {
      stationId: "station-a",
      lineId: "line-1",
      facilityType: "ESCALATOR",
      evidenceHash: "a".repeat(64),
      providerRecordHash: "1".repeat(64),
    },
  ];

  const workspace = await mkdtemp(path.join(tmpdir(), "ledger-evidence-"));
  try {
    const primary = structuredClone(fixture);
    primary.packs[0].stationFacilityEvidence = structuredClone(evidenceRows);
    const primaryPath = path.join(workspace, "primary-fixture.json");
    await writeFile(primaryPath, JSON.stringify(primary));

    const primaryArgs = ["--kind", "facility-evidence", "--fixture", path.relative(root, primaryPath)];
    const primaryOut = JSON.parse((await runLedgerExporter(primaryArgs)).stdout);
    assert.equal(primaryOut.evidenceSource, "stationFacilityEvidence");
    assert.match(primaryOut.ledgerHash, /^[0-9a-f]{64}$/);
    assert.equal(primaryOut.rowCount, evidenceRows.length);

    const primaryRepeat = JSON.parse((await runLedgerExporter(primaryArgs)).stdout);
    assert.equal(primaryRepeat.ledgerHash, primaryOut.ledgerHash);

    const fallback = structuredClone(primary);
    delete fallback.packs[0].stationFacilityEvidence;
    const fallbackPath = path.join(workspace, "fallback-fixture.json");
    await writeFile(fallbackPath, JSON.stringify(fallback));
    const fallbackOut = JSON.parse(
      (await runLedgerExporter(["--kind", "facility-evidence", "--fixture", path.relative(root, fallbackPath)])).stdout,
    );
    assert.equal(fallbackOut.evidenceSource, "facilities");
    assert.notEqual(fallbackOut.ledgerHash, primaryOut.ledgerHash);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("원장 해시 exporter는 facility-evidence source 혼합을 거부한다", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, catalogFixtureArg), "utf8"));
  const workspace = await mkdtemp(path.join(tmpdir(), "ledger-mixed-"));
  try {
    const mixed = structuredClone(fixture);
    mixed.packs[0].stationFacilityEvidence = [
      {
        stationId: "station-a",
        lineId: "line-1",
        facilityType: "ELEVATOR",
        evidenceHash: "a".repeat(64),
        providerRecordHash: "1".repeat(64),
      },
    ];
    // 두 번째 pack은 stationFacilityEvidence 없이 facilities만 → facilities 폴백 source.
    mixed.packs.push(structuredClone(fixture.packs[0]));
    const mixedPath = path.join(workspace, "mixed-fixture.json");
    await writeFile(mixedPath, JSON.stringify(mixed));
    await assert.rejects(
      runLedgerExporter(["--kind", "facility-evidence", "--fixture", path.relative(root, mixedPath)]),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("override 해시는 facilityStatusUpdates 배열 순서에 민감하다", async () => {
  const overrides = JSON.parse(await readFile(path.join(root, overrideLedgerArg), "utf8"));
  const base = structuredClone(overrides);
  if (!Array.isArray(base.facilityStatusUpdates)) {
    base.facilityStatusUpdates = [];
  }
  while (base.facilityStatusUpdates.length < 2) {
    base.facilityStatusUpdates.push({ facilityId: `facility-${base.facilityStatusUpdates.length}` });
  }

  const workspace = await mkdtemp(path.join(tmpdir(), "ledger-override-order-"));
  try {
    const baselinePath = path.join(workspace, "baseline-overrides.json");
    await writeFile(baselinePath, JSON.stringify(base));
    const hash1 = JSON.parse(
      (await runLedgerExporter(["--kind", "override", "--overrides", path.relative(root, baselinePath)])).stdout,
    ).ledgerHash;

    const reversed = structuredClone(base);
    reversed.facilityStatusUpdates.reverse();
    const reversedPath = path.join(workspace, "reversed-overrides.json");
    await writeFile(reversedPath, JSON.stringify(reversed));
    const hash2 = JSON.parse(
      (await runLedgerExporter(["--kind", "override", "--overrides", path.relative(root, reversedPath)])).stdout,
    ).ledgerHash;

    assert.notEqual(hash1, hash2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("admin review record 생성기는 runbook 필수 필드를 exporter 해시로 채운다", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "admin-review-"));
  try {
    const files = {};
    for (const [name, kind, extra] of [
      ["license", "license", ["--source-id", "seoulmetro-station-line-info"]],
      ["alias", "alias", ["--fixture", catalogFixtureArg]],
      ["operator", "operator-mapping", ["--fixture", catalogFixtureArg]],
      ["facility", "facility-evidence", ["--fixture", catalogFixtureArg]],
      ["route", "route-evidence", ["--fixture", catalogFixtureArg]],
      ["override", "override", ["--overrides", overrideLedgerArg]],
    ]) {
      const { stdout } = await runLedgerExporter(["--kind", kind, ...extra]);
      files[name] = path.join(workspace, `${name}.json`);
      await writeFile(files[name], stdout);
    }
    const sampleEvidenceHash = "a".repeat(64);
    const samplePath = path.join(workspace, "sample.json");
    await writeFile(samplePath, JSON.stringify({ evidenceHash: sampleEvidenceHash }));
    const quotaPath = path.join(workspace, "quota.json");
    const quota = {
      defaultDailyLimit: 1000,
      portal: "data.seoul.go.kr",
      productionUseAllowed: true,
      unlockStatus: "granted",
    };
    await writeFile(quotaPath, JSON.stringify(quota));
    const prodPath = path.join(workspace, "prod.json");
    await writeFile(prodPath, JSON.stringify({ id: "seoulmetro-station-line-info", displayName: "테스트" }));

    const { stdout } = await runAdminReviewBuilder([
      "--candidate", "seoulmetro-station-line-info",
      "--source-id", "seoulmetro-station-line-info",
      "--snapshot-id", "snap-1",
      "--decision", "APPROVED",
      "--approved-by", "owner",
      "--approved-at", "2026-07-12T00:00:00Z",
      "--sample-evidence", path.relative(root, samplePath),
      "--license-hash", path.relative(root, files.license),
      "--alias-hash", path.relative(root, files.alias),
      "--operator-mapping-hash", path.relative(root, files.operator),
      "--facility-evidence-hash", path.relative(root, files.facility),
      "--route-evidence-hash", path.relative(root, files.route),
      "--override-hash", path.relative(root, files.override),
      "--quota-evidence", path.relative(root, quotaPath),
      "--production-source", path.relative(root, prodPath),
    ]);
    const record = JSON.parse(stdout);
    assert.equal(record.artifactKind, "source-admission-admin-review");
    assert.equal(record.decision, "APPROVED");
    assert.equal(record.sampleEvidenceHash, sampleEvidenceHash);
    for (const field of [
      "licenseEvidenceHash",
      "aliasLedgerHash",
      "operatorMappingLedgerHash",
      "facilityEvidenceLedgerHash",
      "routeEvidenceLedgerHash",
      "overrideHash",
    ]) {
      assert.match(record[field], /^[0-9a-f]{64}$/, field);
    }
    // exporter 산출 해시와 record 값이 일치 (위조 불가 경로 확인)
    assert.equal(record.aliasLedgerHash, JSON.parse(await readFile(files.alias, "utf8")).ledgerHash);
    assert.equal(record.overrideHash, JSON.parse(await readFile(files.override, "utf8")).ledgerHash);
    // runbook requiredAdminReviewFields 전수 존재
    const runbook = JSON.parse(
      await readFile(path.join(root, "tools/datapack/source-admission-runbook.json"), "utf8"),
    );
    for (const field of runbook.requiredAdminReviewFields) {
      assert.ok(field in record, `record missing runbook field: ${field}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("admin review record 생성기는 kind가 틀린 해시 파일을 거부한다 (위조 방지)", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "admin-review-forge-"));
  try {
    // alias 자리에 override 산출물을 넣어 손으로 갈아끼우려는 시도 → kind mismatch 거부
    const { stdout: overrideOut } = await runLedgerExporter(["--kind", "override", "--overrides", overrideLedgerArg]);
    const forgedAlias = path.join(workspace, "forged-alias.json");
    await writeFile(forgedAlias, overrideOut);

    const files = {};
    for (const [name, kind, extra] of [
      ["license", "license", ["--source-id", "seoulmetro-station-line-info"]],
      ["operator", "operator-mapping", ["--fixture", catalogFixtureArg]],
      ["facility", "facility-evidence", ["--fixture", catalogFixtureArg]],
      ["route", "route-evidence", ["--fixture", catalogFixtureArg]],
      ["override", "override", ["--overrides", overrideLedgerArg]],
    ]) {
      const { stdout } = await runLedgerExporter(["--kind", kind, ...extra]);
      files[name] = path.join(workspace, `${name}.json`);
      await writeFile(files[name], stdout);
    }
    const samplePath = path.join(workspace, "sample.json");
    await writeFile(samplePath, JSON.stringify({ evidenceHash: "a".repeat(64) }));
    const quotaPath = path.join(workspace, "quota.json");
    await writeFile(
      quotaPath,
      JSON.stringify({ defaultDailyLimit: 1000, portal: "p", productionUseAllowed: true, unlockStatus: "granted" }),
    );
    const prodPath = path.join(workspace, "prod.json");
    await writeFile(prodPath, JSON.stringify({ id: "seoulmetro-station-line-info" }));

    await assert.rejects(
      runAdminReviewBuilder([
        "--candidate", "seoulmetro-station-line-info",
        "--source-id", "seoulmetro-station-line-info",
        "--snapshot-id", "snap-1",
        "--decision", "APPROVED",
        "--approved-by", "owner",
        "--approved-at", "2026-07-12T00:00:00Z",
        "--sample-evidence", path.relative(root, samplePath),
        "--license-hash", path.relative(root, files.license),
        "--alias-hash", path.relative(root, forgedAlias),
        "--operator-mapping-hash", path.relative(root, files.operator),
        "--facility-evidence-hash", path.relative(root, files.facility),
        "--route-evidence-hash", path.relative(root, files.route),
        "--override-hash", path.relative(root, files.override),
        "--quota-evidence", path.relative(root, quotaPath),
        "--production-source", path.relative(root, prodPath),
      ]),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("admin review record 생성기는 APPROVED가 아닌 decision을 거부한다", async () => {
  await assert.rejects(
    runAdminReviewBuilder([
      "--candidate", "x", "--source-id", "x", "--snapshot-id", "s",
      "--decision", "REJECTED", "--approved-by", "o", "--approved-at", "t",
      "--sample-evidence", "x", "--license-hash", "x", "--alias-hash", "x",
      "--operator-mapping-hash", "x", "--facility-evidence-hash", "x",
      "--route-evidence-hash", "x", "--override-hash", "x",
      "--quota-evidence", "x", "--production-source", "x",
    ]),
  );
});

test("build-admin-review-record 산출물은 run-source-admission-pipeline을 그대로 통과한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-ledger-e2e-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const candidatesPath = await writePendingCandidateFixture(outputDir, "kric-train-operation-organ");
  const rawPath = path.join(outputDir, "kric-train-operation-organ.raw.json");
  await writeFile(rawPath, `${JSON.stringify([{ railOprIsttCd: "S1", railOprIsttNm: "서울교통공사" }])}\n`);

  // sample evidence는 pipeline이 소비하는 것과 동일하게 실 도구로 생성
  const { stdout: sampleStdout } = await execFileAsync(
    process.execPath,
    ["tools/datapack/build-source-candidate-sample-evidence.mjs", "--candidate", "kric-train-operation-organ", "--response", rawPath],
    { cwd: root },
  );
  const samplePath = path.join(outputDir, "sample.json");
  await writeFile(samplePath, sampleStdout);

  // 6종 원장 해시를 exporter로 산출
  const ledgerFiles = {};
  for (const [name, kind, extra] of [
    ["license", "license", ["--source-id", "seoulmetro-station-line-info"]],
    ["alias", "alias", ["--fixture", catalogFixtureArg]],
    ["operator", "operator-mapping", ["--fixture", catalogFixtureArg]],
    ["facility", "facility-evidence", ["--fixture", catalogFixtureArg]],
    ["route", "route-evidence", ["--fixture", catalogFixtureArg]],
    ["override", "override", ["--overrides", overrideLedgerArg]],
  ]) {
    const { stdout } = await runLedgerExporter(["--kind", kind, ...extra]);
    ledgerFiles[name] = path.join(outputDir, `${name}.json`);
    await writeFile(ledgerFiles[name], stdout);
  }

  const quotaPath = path.join(outputDir, "quota.json");
  await writeFile(
    quotaPath,
    JSON.stringify({ defaultDailyLimit: "unlimited", portal: "KRIC 레일포털", productionUseAllowed: true, unlockStatus: "not_required" }),
  );
  const prodPath = path.join(outputDir, "prod.json");
  await writeFile(
    prodPath,
    JSON.stringify({
      id: "kric-train-operation-organ",
      displayName: "열차운영기관정보",
      owner: "국가철도공단",
      provider: "국가철도공단",
      sourceSystem: "KRIC OpenAPI",
      datasetUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266",
      requiredForProductionPack: false,
      updateFrequency: "provider-documented",
      observedDataUpdatedAt: "2026-07-02",
      retrievedAt: "2026-07-02",
      license: {
        type: "KOGL-1",
        name: "공공누리 1유형",
        attribution: "공공누리 제1유형: 출처표시",
        commercialUseAllowed: true,
        derivativeWorkAllowed: true,
        redistributionAllowed: true,
        evidenceUrl: "https://data.kric.go.kr/rips/M_01_02/detail.do?id=266",
      },
      coverageScope: { regionIds: ["capital"], operatorIds: ["seoul-metro"], sourceDomains: ["station_line_membership"] },
      fieldsProvided: ["railOprIsttCd", "railOprIsttNm"],
      capabilities: {
        schedule: { status: "UNSUPPORTED", productionUseAllowed: false, coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "provider-documented", unsupportedNotes: "x" },
        realtime: { status: "UNSUPPORTED", productionUseAllowed: false, liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE", coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "provider-documented", unsupportedNotes: "x" },
        facility: { status: "UNSUPPORTED", productionUseAllowed: false, coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "provider-documented", unsupportedNotes: "x" },
      },
    }),
  );

  // 생성기로 admin review record 작성
  const { stdout: recordStdout } = await runAdminReviewBuilder([
    "--candidate", "kric-train-operation-organ",
    "--source-id", "kric-train-operation-organ",
    "--snapshot-id", "kric-train-operation-organ-snapshot-20260702",
    "--decision", "APPROVED",
    "--approved-by", "owner",
    "--approved-at", "2026-07-12T00:00:00Z",
    "--sample-evidence", path.relative(root, samplePath),
    "--license-hash", path.relative(root, ledgerFiles.license),
    "--alias-hash", path.relative(root, ledgerFiles.alias),
    "--operator-mapping-hash", path.relative(root, ledgerFiles.operator),
    "--facility-evidence-hash", path.relative(root, ledgerFiles.facility),
    "--route-evidence-hash", path.relative(root, ledgerFiles.route),
    "--override-hash", path.relative(root, ledgerFiles.override),
    "--quota-evidence", path.relative(root, quotaPath),
    "--production-source", path.relative(root, prodPath),
  ]);
  const adminReviewPath = path.join(outputDir, "admin-review.json");
  await writeFile(adminReviewPath, recordStdout);

  const summaryPath = path.join(outputDir, "admission-summary.json");
  const outputInventoryPath = path.join(outputDir, "source-inventory.admitted.json");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/datapack/run-source-admission-pipeline.mjs",
      "--candidates", candidatesPath,
      "--candidate", "kric-train-operation-organ",
      "--raw-input", rawPath,
      "--evidence-dir", outputDir,
      "--snapshot-id", "kric-train-operation-organ-snapshot-20260702",
      "--source-id", "kric-train-operation-organ",
      "--provider", "국가철도공단",
      "--retrieved-at", "2026-07-02T00:00:00Z",
      "--source-updated-at", "2026-07-02T00:00:00Z",
      "--raw-object-uri", "s3://easysubway-datapack-sources/kric-train-operation-organ/20260702.json",
      "--freshness-expires-at", "2099-08-01T00:00:00Z",
      "--raw-retention-expires-at", "2099-10-01T00:00:00Z",
      "--admin-review", adminReviewPath,
      "--output-inventory", outputInventoryPath,
      "--output", summaryPath,
    ],
    { cwd: root },
  );
  assert.match(stdout, /source admission pipeline evidence written/);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  // pipeline summary가 exporter 산출 원장 해시를 그대로 옮겨야 한다
  assert.equal(summary.aliasLedgerHash, JSON.parse(await readFile(ledgerFiles.alias, "utf8")).ledgerHash);
  assert.equal(summary.overrideHash, JSON.parse(await readFile(ledgerFiles.override, "utf8")).ledgerHash);
  assert.equal(summary.licenseEvidenceHash, JSON.parse(await readFile(ledgerFiles.license, "utf8")).ledgerHash);
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

async function prepareCarDoorHintFixture(label, hintOverrides) {
  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  const outputDir = path.join(tmpdir(), `easysubway-datapack-${label}-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  fixture.packs[0].stationCarDoorHints = [baseCarDoorHint(hintOverrides)];
  fixture.packs[0].minimumTableRows.station_car_door_hints = 1;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  return { outputDir, fixturePath };
}

test("데이터팩 생성기·검증기는 유효한 station_car_door_hints를 적재하고 통과시킨다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-valid", {});

  await execFileAsync(
    process.execPath,
    ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
    { cwd: root, env: productionEnv },
  );
  await execFileAsync(
    process.execPath,
    ["tools/datapack/validate-datapack.mjs", "--manifest", path.join(outputDir, "current.json"), "--root", outputDir],
    { cwd: root, env: productionEnv },
  );

  const packBytes = await readFile(path.join(outputDir, "catalog", "capital-v1.sqlite.gz"));
  const sqlitePath = path.join(outputDir, "capital-v1.sqlite");
  await writeFile(sqlitePath, gunzipSync(packBytes));
  const readback = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = readback
      .prepare("SELECT car_number, door_number, target_facility_type FROM station_car_door_hints")
      .get();
    assert.equal(row.car_number, 3);
    assert.equal(row.door_number, 2);
    assert.equal(row.target_facility_type, "STAIR");
  } finally {
    readback.close();
  }
});

test("데이터팩 생성기는 car_number 0을 CHECK 위반으로 거부한다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-car0", { carNumber: 0 });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /CHECK constraint failed|car_number/,
  );
});

test("데이터팩 생성기는 OFFICIAL car-door hint의 빈 sourceSnapshotId를 거부한다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-official-snapshot", {
    provenanceKind: "OFFICIAL",
    sourceId: "official-source",
    sourceSnapshotId: "",
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /stationCarDoorHints\.sourceSnapshotId/,
  );
});

test("데이터팩 생성기는 공백 포함 OFFICIAL provenance를 정규화하고 빈 sourceId를 거부한다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-official-source", {
    provenanceKind: " OFFICIAL ",
    sourceId: " ",
    sourceSnapshotId: "snapshot",
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /stationCarDoorHints\.sourceId/,
  );
});

test("데이터팩 생성기는 OFFICIAL car-door hint의 빈 providerRecordHash를 거부한다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-official-provider-hash", {
    provenanceKind: "OFFICIAL",
    sourceId: "official-source",
    sourceSnapshotId: "official-snapshot",
    providerRecordHash: "",
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /stationCarDoorHints\.providerRecordHash/,
  );
});

test("데이터팩 생성기는 car_number 11을 CHECK 위반으로 거부한다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-car11", { carNumber: 11 });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /CHECK constraint failed|car_number/,
  );
});

test("데이터팩 생성기는 door_number 0을 CHECK 위반으로 거부한다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-door0", { doorNumber: 0 });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /CHECK constraint failed|door_number/,
  );
});

test("데이터팩 생성기는 door_number 5를 CHECK 위반으로 거부한다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-door5", { doorNumber: 5 });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /CHECK constraint failed|door_number/,
  );
});

test("데이터팩 생성기는 허용 밖 target_facility_type을 CHECK 위반으로 거부한다", async () => {
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-facility", {
    targetFacilityType: "ESCALATOR_BROKEN",
  });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /CHECK constraint failed|target_facility_type/,
  );
});

test("데이터팩 생성기는 station_lines에 없는 station_car_door_hints FK를 거부한다", async () => {
  // build-datapack.mjs는 PRAGMA foreign_keys=ON으로 적재하므로 station_lines에 없는
  // (station_id, line_id) 참조는 build 단계에서 이미 거부된다(validator의 방어적 FK
  // 검증까지 도달하지 못한다).
  const { outputDir, fixturePath } = await prepareCarDoorHintFixture("car-door-fk", {
    stationId: "station-does-not-exist",
  });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", outputDir],
      { cwd: root, env: productionEnv },
    ),
    /FOREIGN KEY constraint failed/,
  );
});
