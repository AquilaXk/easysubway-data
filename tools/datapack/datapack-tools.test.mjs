import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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
  assert.equal(pack.regionalQualityMetrics.facilityCoverageRatio, 0.1667);
  assert.equal(pack.regionalQualityMetrics.edgeCount, 15);
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
    "network_edges",
    "station_exits",
    "facilities",
  ]);
  assert.equal(pack.minimumTableRows.stations, 6);
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
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(database.prepare("SELECT value FROM catalog_metadata WHERE key = 'schemaVersion'").get().value, "1");
    assert.equal(database.prepare("SELECT updated_at FROM catalog_metadata WHERE key = 'schemaVersion'").get().updated_at, 1781827200);
    assert.equal(database.prepare("SELECT last_verified_at FROM stations WHERE id = 'station-sangnoksu'").get().last_verified_at, 1781827200);
    assert.equal(database.prepare("SELECT checked_at FROM data_quality_records WHERE id = 'quality-station-sangnoksu'").get().checked_at, 1781827200);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM stations").get().count, 6);
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
    assert.equal(networkEdges.length, 15);
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
        edge_type: "TRANSFER",
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
  } finally {
    database.close();
  }
});

test("데이터팩 생성기는 production pack의 source metadata와 HTTPS URL을 강제한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-gate-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].artifactKind = "production";
  fixture.packs[0].url = "catalog/capital-v1.sqlite.gz";
  fixture.packs[0].sourceInventory = [
    {
      id: "capital-official-stations",
      owner: "수도권 운영기관",
      url: "https://example.invalid/capital/stations",
      license: "공공데이터 이용허락",
      licenseStatus: "redistributable",
      redistributionAllowed: true,
      updateFrequency: "daily",
      updatedAt: "2026-06-19T00:00:00.000Z",
      fields: ["stations"],
    },
  ];
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

test("데이터팩 검증기는 production HTTPS URL과 staged artifact path 불일치를 거부한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-production-path-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  fixture.packs[0].artifactKind = "production";
  fixture.packs[0].url = "https://CDN.easysubway.example/easysubway-datapacks/catalog/capital-v1.sqlite.gz";
  fixture.packs[0].sourceInventory = [
    {
      id: "capital-official-stations",
      owner: "수도권 운영기관",
      url: "https://example.invalid/capital/stations",
      license: "공공데이터 이용허락",
      licenseStatus: "redistributable",
      redistributionAllowed: true,
      updateFrequency: "daily",
      updatedAt: "2026-06-19T00:00:00.000Z",
      fields: ["stations"],
    },
  ];
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

  manifest.packs[0].url = "https://cdn.easysubway.example/packs/capital-v1.sqlite.gz";
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

test("데이터팩 검증기는 WALK edge를 route graph 연결성으로 인정하지 않는다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-datapack-walk-only-route-${Date.now()}`);
  const fixturePath = path.join(outputDir, "fixture.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const fixture = JSON.parse(await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"));
  for (const edge of fixture.packs[0].networkEdges) {
    edge.edgeType = "WALK";
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
