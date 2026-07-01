import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

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
  assert.equal(pack.sourceInventory.length, 1);
  assert.equal(pack.sourceInventory[0].id, "fixture-capital-catalog");
  assert.equal(pack.sourceInventory[0].licenseStatus, "fixture-only");
  assert.equal(pack.sourceInventory[0].updatedAt, "2026-06-19T00:00:00.000Z");
  assert.equal(pack.regionalQualityMetrics.stationCount, 6);
  assert.equal(pack.regionalQualityMetrics.facilityCoverageRatio, 0.3333);

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
    "transfer_rules",
    "station_pathway_nodes",
    "station_pathway_edges",
    "out_of_station_transfer_links",
    "network_edges",
    "route_map_positions",
    "station_exits",
    "facilities",
    "data_quality_records",
  ]);
  assert.equal(pack.minimumTableRows.stations, 6);
  assert.equal(pack.minimumTableRows.service_calendar_dates, 1);
  assert.equal(pack.minimumTableRows.transit_routes, 2);
  assert.equal(pack.minimumTableRows.transit_trips, 4);
  assert.equal(pack.minimumTableRows.transit_stop_times, 8);
  assert.equal(pack.minimumTableRows.transit_frequencies, 1);
  assert.equal(pack.minimumTableRows.transfer_rules, 1);
  assert.equal(pack.minimumTableRows.station_pathway_nodes, 6);
  assert.equal(pack.minimumTableRows.station_pathway_edges, 5);
  assert.equal(pack.minimumTableRows.out_of_station_transfer_links, 1);
  assert.equal(pack.minimumTableRows.route_map_positions, 9);
  assert.equal(pack.minimumTableRows.data_quality_records, 5);
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
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 11);
    assert.equal(database.prepare("SELECT value FROM catalog_metadata WHERE key = 'schemaVersion'").get().value, "1");
    assert.equal(database.prepare("SELECT updated_at FROM catalog_metadata WHERE key = 'schemaVersion'").get().updated_at, 1781827200);
    assert.equal(database.prepare("SELECT last_verified_at FROM stations WHERE id = 'station-sangnoksu'").get().last_verified_at, 1781827200);
    assert.equal(database.prepare("SELECT checked_at FROM data_quality_records WHERE id = 'quality-station-sangnoksu'").get().checked_at, 1781827200);
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
        min_transfer_seconds: 210,
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
        duration_seconds: 140,
        distance_meters: 80,
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
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 11);
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

test("데이터팩 검증기는 UNKNOWN accessibility edge provenance를 검증한다", async () => {
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
    accessibilityStatus: "UNKNOWN",
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
    servicePattern: "LOCAL",
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

test("source candidate sample 검증기는 output field 누락을 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-source-candidate-field-${Date.now()}`);
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
        fields: ["lnCd", "mreaWideCd", "railOprIsttCd", "routCd", "routNm", "stinCd", "stinNm"],
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
    /output field missing: stinConsOrdr/,
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
    /route graph edge admission requires confirmed fields: distanceMeters, durationSeconds/,
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
    `${JSON.stringify({
      response: {
        body: {
          pageNo: 1,
          numOfRows: 10,
          totalCount: 1,
          items: {
            item: [
              {
                railOprIsttCd: "S1",
              },
              {
                railOprIsttNm: "서울교통공사",
              },
            ],
          },
        },
      },
    })}\n`,
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
  assert.ok(report.summary.coveredRequirements > 0);
  assert.ok(report.requirements.some((entry) => entry.status === "covered"));
  assert.ok(report.requirements.some((entry) => entry.status === "missing"));
  assert.ok(report.requirements.every((entry) => Array.isArray(entry.sourceIds)));
});

test("전국 coverage gap report는 TAGO, 국가철도공단, 부산 source inventory coverage를 반영한다", async () => {
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
  assert.equal(report.summary.totalRequirements, 42);
  assert.equal(report.summary.coveredRequirements, 4);
  assert.equal(report.summary.missingRequirements, 38);

  const busanStationMembership = report.requirements.find(
    (entry) =>
      entry.regionId === "busan" &&
      entry.operatorId === "busan-transportation" &&
      entry.sourceDomain === "station_line_membership",
  );
  assert.deepEqual(busanStationMembership?.sourceIds, [
    "busan-transportation-urban-rail-station-info",
    "kric-metropolitan-rail-station-info",
    "molit-urban-rail-full-route",
  ]);
  assert.deepEqual(busanStationMembership?.missingFields, ["line", "station_code"]);

  const capitalAccessibilityFacilities = report.requirements.find(
    (entry) =>
      entry.regionId === "capital" &&
      entry.operatorId === "seoul-metro" &&
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
  const reportPath = path.join(outputDir, "coverage-gap-report.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const targets = JSON.parse(await readFile(path.join(root, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
  const inventory = completeCoverageInventory(targets);
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      inventoryPath,
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
  await writeFile(provenancePath, `${JSON.stringify(completeCoverageProvenance(inventory), null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      inventoryPath,
      "--provenance",
      provenancePath,
      "--output",
      reportPath,
    ],
    { cwd: root },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.coverageComplete, true);
  assert.equal(report.candidate.manifestSha256, "a".repeat(64));
  assert.deepEqual(report.candidate.packs.map(({ id, version, sqliteSha256 }) => ({ id, version, sqliteSha256 })), [
    { id: "nationwide", version: "1", sqliteSha256: "b".repeat(64) },
  ]);
  assert.ok(report.requirements.every((entry) => entry.fieldCoverage.every((field) => field.status === "covered")));
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
            sourceDomains: ["station_line_membership"],
          },
          derivationKind: "OFFICIAL",
          verifiedAt: "2026-06-22T00:00:00.000Z",
        })),
      },
    ],
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      inventoryPath,
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
      entry.sourceDomain === "station_line_membership",
  );
  const busanRequirement = report.requirements.find(
    (entry) =>
      entry.regionId === "busan" &&
      entry.operatorId === "busan-transportation" &&
      entry.sourceDomain === "station_line_membership",
  );
  assert.equal(capitalRequirement.status, "covered");
  assert.deepEqual(capitalRequirement.missingFields, []);
  assert.equal(busanRequirement.status, "missing");
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
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/nationwide-coverage-targets.json",
      "--inventory",
      inventoryPath,
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
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        "tools/datapack/nationwide-coverage-targets.json",
        "--inventory",
        inventoryPath,
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
    durationSeconds: 420,
    distanceMeters: 18600,
    edgeType: "RIDE",
    servicePattern: "LOCAL",
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
        lineSequence: 48,
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
    network_edges: 6,
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
      .map(({ stationId, lineId, facilityType, sourceId, strictRouteEligible }) => ({
        stationId,
        lineId,
        facilityType,
        sourceId,
        strictRouteEligible,
      })),
    [
      {
        stationId: "station-sadang",
        lineId: "seoul-4",
        facilityType: "ELEVATOR",
        sourceId: "kric-station-elevator",
        strictRouteEligible: true,
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

test("수도권 pilot production source input은 UNKNOWN strict coverage gap을 노출한다", async () => {
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
  const importedFixture = JSON.parse(await readFile(importedFixturePath, "utf8"));
  assert.equal(importedFixture.packs[0].requiredTables.includes("route_map_positions"), false);
  assert.equal(importedFixture.packs[0].minimumTableRows.route_map_positions, undefined);

  const missingFacilityInputPath = path.join(outputDir, "capital-pilot-production-missing-facility.json");
  await writeFile(
    missingFacilityInputPath,
    `${JSON.stringify(
      {
        ...input,
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
        ...input,
        facilityRows: input.facilityRows.filter((row) => row.id !== "facility-sadang-wheelchair-lift-kric-1"),
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
  let validationFailure;
  try {
    await execFileAsync(
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
  } catch (error) {
    validationFailure = error;
  }

  assert(validationFailure);
  assert.match(validationFailure.message, /capital@1 verified ENTRY coverage gap: 2\/2/);
  const strictCoverageReport = JSON.parse(validationFailure.stdout.trim().split("\n").at(-1));
  assert.deepEqual(strictCoverageReport.unverifiedAccessibilityCoverageEdges, [
    "edge-entry-sadang-seoul-4",
    "edge-entry-sangnoksu-seoul-4",
    "edge-exit-sadang-seoul-4",
    "edge-exit-sangnoksu-seoul-4",
  ]);

  const coverageReportPath = path.join(outputDir, "capital-pilot-coverage-summary.json");
  await execFileAsync(
    process.execPath,
    [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      "tools/datapack/capital-pilot-coverage-targets.json",
      "--inventory",
      "tools/datapack/source-inventory.json",
      "--provenance",
      path.join(packOutputDir, "current.provenance.json"),
      "--output",
      coverageReportPath,
    ],
    { cwd: root },
  );
  const coverageReport = JSON.parse(await readFile(coverageReportPath, "utf8"));
  assert.equal(coverageReport.summary.coverageComplete, true);
  assert.equal(coverageReport.summary.missingRequirements, 0);
  assert.equal(coverageReport.summary.coverageRatio, 1);

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
          accessibility_status: "UNKNOWN",
        },
        {
          id: "edge-entry-sangnoksu-seoul-4",
          accessibility_status: "UNKNOWN",
        },
        {
          id: "edge-exit-sadang-seoul-4",
          accessibility_status: "UNKNOWN",
        },
        {
          id: "edge-exit-sangnoksu-seoul-4",
          accessibility_status: "UNKNOWN",
        },
      ],
    );
  } finally {
    database.close();
  }

  const provenance = JSON.parse(await readFile(path.join(packOutputDir, "current.provenance.json"), "utf8"));
  const routeMapRecords = provenance.packs[0].records.filter(
    (record) => record.sourceId === "seoulmetro-cyberstation-route-map",
  );
  assert.equal(routeMapRecords.length, 0);
  assert.equal(
    provenance.packs[0].records.filter(
      (record) => record.entityType === "facility" && record.field === "status",
    ).length,
    6,
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
      entry.sourceDomain === "route_map_positions",
  );
  assert.notEqual(capitalRouteMapCoverage.status, "covered");
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
        response.writeHead(200, {
          "content-length": String(object.sizeBytes),
          "x-amz-meta-sha256": object.metadataSha256,
        });
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
        response.writeHead(200, {
          "content-length": String(object.sizeBytes),
        });
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
        lineSequence: 48,
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
        lineSequence: 48,
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
        lineSequence: 33,
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
        durationSeconds: 420,
        distanceMeters: 18600,
        edgeType: "RIDE",
        servicePattern: "LOCAL",
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
        durationSeconds: 420,
        distanceMeters: 18600,
        edgeType: "RIDE",
        servicePattern: "LOCAL",
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
    representativeRouteRegressions: [
      {
        id: "direct-local-capital",
        pattern: "DIRECT",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
      },
      {
        id: "transfer-capital",
        pattern: "TRANSFER",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
      },
      {
        id: "multi-transfer-capital",
        pattern: "MULTI_TRANSFER",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
      },
      {
        id: "loop-branch-capital",
        pattern: "LOOP_BRANCH",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
      },
      {
        id: "express-local-capital",
        pattern: "EXPRESS_LOCAL",
        fromNodeId: "station-sangnoksu:seoul-4",
        toNodeId: "station-sadang:seoul-4",
        requiredEdgeIds: ["edge-sangnoksu-sadang-seoul-4"],
      },
    ],
  };
}

function nationwideMasterSourceIngestInput() {
  const stationSources = [
    ["molit-urban-rail-full-route", "MOLIT-SEOUL-4-448", "seoul-4", "station-sangnoksu", "448", 48, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
    ["molit-tago-subway-info", "448", "seoul-4", "station-sangnoksu", "448", 48, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
    ["kric-metropolitan-rail-station-info", "KRIC-SEOUL-4-448", "seoul-4", "station-sangnoksu", "448", 48, "상록수", "Sangnoksu", "수도권", 37.3028, 126.8666],
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
  for (const edge of input.routeEdges) {
    edge.provenanceKind = "OFFICIAL_SOURCE";
    edge.verificationStatus = "VERIFIED";
    edge.sourceSnapshotId = `${edge.sourceId}-snapshot-20260621`;
    edge.providerRecordHash = sha256(`provider:${edge.id}:${edge.sourceId}`);
    edge.evidenceHash = sha256(`evidence:${edge.id}:${edge.sourceId}:${edge.lastVerifiedAt}`);
  }
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
    routeEdges: 6,
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

async function importOfficialSourceInput(outputDir, input) {
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
  return JSON.parse(await readFile(outputPath, "utf8"));
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
    accessibilityStatus: "AVAILABLE",
    reliabilityScore: 90,
    provenanceKind: "OFFICIAL_SOURCE",
    verificationStatus: "VERIFIED",
    lastVerifiedAt: "2026-06-21T00:00:00.000Z",
    sourceSnapshotId: "seoulmetro-station-line-info-snapshot-20260621",
    providerRecordHash: sha256(`provider:${id}:seoulmetro-station-line-info`),
    evidenceHash: sha256(`evidence:${id}:seoulmetro-station-line-info:2026-06-21T00:00:00.000Z`),
  };
}

function completeCoverageInventory(targets) {
  return {
    schemaVersion: 1,
    region: "nationwide",
    artifactKind: "production-source-inventory",
    retrievedAt: "2026-06-22",
    sources: targets.regions.flatMap((region) =>
      region.operatorIds.flatMap((operatorId) =>
        targets.requiredSourceDomains.map((domain) => ({
          id: `${region.id}-${operatorId}-${domain.id}`,
          displayName: `${region.displayName} ${operatorId} ${domain.id}`,
          owner: "테스트 운영기관",
          provider: "테스트 운영기관",
          providerDepartment: "테스트",
          sourceSystem: "테스트",
          datasetUrl: `https://example.invalid/${region.id}/${operatorId}/${domain.id}`,
          datasetKind: "fixture-only",
          coverageScope: {
            regionIds: [region.id],
            operatorIds: [operatorId],
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

function markFixturePackProduction(fixture) {
  const pack = fixture.packs[0];
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
  ];
  for (const edge of pack.networkEdges) {
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
  addMissingProductionAccessEdges(pack);
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
    sourceDomains: ["station_line_membership"],
  };
}

function packSignaturePayload(pack) {
  return `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}:${representativeRouteRegressionPayload(pack.representativeRouteRegressions)}`;
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
