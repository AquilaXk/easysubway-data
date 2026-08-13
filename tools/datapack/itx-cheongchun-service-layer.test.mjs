import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const schema = await readFile(new URL("./schema/catalog-schema.sql", import.meta.url), "utf8");
const root = path.resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const stationCatalogPackIdentity = Object.freeze({
  artifactKind: "station-catalog-pack",
  manifestVersion: 1,
  catalogPackId: "station-catalog-test-only",
  stationSetSha256: "1".repeat(64),
  payloadSha256: "2".repeat(64),
  manifestSha256: "3".repeat(64),
});
const missingItxEvidence = () => ({
  serviceClass: "ITX_CHEONGCHUN",
  timetableArtifactId: "itx-cheongchun-completeness-admission-20260714T083544292Z",
  timetableArtifactSha256: "347aec507ec951dde65c10a1c4bff9f94454f762d76a5a74064a40662008336c",
  canonicalPackId: "capital",
  canonicalPackSha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
  canonicalPackSqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
  admissionStatus: "MISSING",
  admissionEligible: false,
  freshUntil: "2026-07-20T00:00:00.000Z",
  sourceIssue: 2116,
});

test("current reviewed pack은 legacy admission input과 current ITX row를 포함하지 않는다", async () => {
  const production = JSON.parse(await readFile(
    new URL("./release/capital-production-reviewed-pack.json", import.meta.url),
    "utf8",
  ));
  const pack = production.packs.find(({ id }) => id === "capital");
  assert.deepEqual(pack.routeServiceArtifactEvidence, []);
  assert.equal((pack.transitTrips ?? []).filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN").length, 0);
  assert.equal((pack.networkEdges ?? []).filter(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN").length, 0);
});

test("catalog schema는 service class와 admission evidence identity를 보존한다", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(schema);

    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 19);
    for (const table of ["transit_trips", "network_edges"]) {
      const serviceClass = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .find(({ name }) => name === "service_class");
      assert.deepEqual(
        { notNull: serviceClass?.notnull, defaultValue: serviceClass?.dflt_value },
        { notNull: 1, defaultValue: "'SUBWAY'" },
      );
    }

    const evidenceColumns = database
      .prepare("PRAGMA table_info(route_service_artifact_evidence)")
      .all()
      .map(({ name }) => name);
    assert.deepEqual(evidenceColumns, [
      "service_class",
      "timetable_artifact_id",
      "timetable_artifact_sha256",
      "canonical_pack_id",
      "canonical_pack_sha256",
      "canonical_pack_sqlite_sha256",
      "admission_status",
      "admission_eligible",
      "fresh_until",
      "source_issue",
    ]);
    assert.deepEqual(database.prepare("PRAGMA table_info(route_service_station_catalog_evidence)")
      .all().map(({ name }) => name), [
      "service_class",
      "station_catalog_artifact_kind",
      "station_catalog_manifest_version",
      "station_catalog_pack_id",
      "station_catalog_station_set_sha256",
      "station_catalog_payload_sha256",
      "station_catalog_manifest_sha256",
      "admission_status",
      "admission_eligible",
      "fresh_until",
      "source_issue",
    ]);
    assert.throws(() => database.prepare(`
      INSERT INTO route_service_artifact_evidence (
        service_class, timetable_artifact_id, timetable_artifact_sha256,
        canonical_pack_id, canonical_pack_sha256, canonical_pack_sqlite_sha256,
        admission_status, admission_eligible, fresh_until, source_issue
      ) VALUES ('ITX_CHEONGCHUN', 'test', ?, 'capital', ?, ?, 'ADMITTED', 1, NULL, 2116)
    `).run("a".repeat(64), "b".repeat(64), "c".repeat(64)));
  } finally {
    database.close();
  }
});

test("self-declared legacy ADMITTED evidence는 current materializer에 진입할 수 없다", async (context) => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-admitted-without-rows-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL("./fixtures/catalog-fixture.json", import.meta.url), "utf8"));
  fixture.packs[0].routeServiceArtifactEvidence = [{
    ...missingItxEvidence(),
    admissionStatus: "ADMITTED",
    admissionEligible: true,
    freshUntil: "2099-01-01T00:00:00.000Z",
  }];
  const fixturePath = path.join(temporaryDir, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--fixture", fixturePath,
      "--output", path.join(temporaryDir, "output"),
    ], { cwd: root }),
    /routeServiceArtifactEvidence input is legacy/,
  );
});

test("중복 legacy ITX service evidence도 current materializer에 진입할 수 없다", async (context) => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-duplicate-evidence-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL("./fixtures/catalog-fixture.json", import.meta.url), "utf8"));
  fixture.packs[0].routeServiceArtifactEvidence = [missingItxEvidence(), missingItxEvidence()];
  const fixturePath = path.join(temporaryDir, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--fixture", fixturePath,
      "--output", path.join(temporaryDir, "output"),
    ], { cwd: root }),
    /routeServiceArtifactEvidence input is legacy/,
  );
});

test("current admission이 없는 pack은 ITX row와 route evidence를 모두 0건으로 유지한다", async (context) => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-missing-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL("./fixtures/catalog-fixture.json", import.meta.url), "utf8"));
  fixture.packs[0].routeServiceArtifactEvidence = [];
  const fixturePath = path.join(temporaryDir, "fixture.json");
  const outputDir = path.join(temporaryDir, "output");
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);

  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs",
    "--fixture",
    fixturePath,
    "--output",
    outputDir,
  ], { cwd: root });

  const sqlitePath = path.join(temporaryDir, "capital.sqlite");
  await writeFile(sqlitePath, gunzipSync(await readFile(path.join(outputDir, "catalog/capital-v1.sqlite.gz"))));
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT count(*) AS count FROM transit_trips WHERE service_class = 'ITX_CHEONGCHUN'").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN'").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM route_service_artifact_evidence").get().count, 0);
  } finally {
    database.close();
  }
});

test("검증된 current station-catalog admission 없이 ITX data row가 섞이면 build를 거부한다", async (context) => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-missing-row-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL("./fixtures/catalog-fixture.json", import.meta.url), "utf8"));
  fixture.packs[0].routeServiceArtifactEvidence = [];
  fixture.packs[0].transitTrips[0].serviceClass = "ITX_CHEONGCHUN";
  const fixturePath = path.join(temporaryDir, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      path.join(temporaryDir, "output"),
    ], { cwd: root }),
    /ITX_CHEONGCHUN rows require a verified current station catalog identity/,
  );
});

test("self-declared ADMITTED evidence가 있는 직접 ITX row도 검증된 artifact materializer 없이는 거부한다", async (context) => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-self-declared-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL("./fixtures/catalog-fixture.json", import.meta.url), "utf8"));
  fixture.packs[0].routeServiceArtifactEvidence = [{
    ...missingItxEvidence(),
    admissionStatus: "ADMITTED",
    admissionEligible: true,
  }];
  fixture.packs[0].transitTrips[0].serviceClass = "ITX_CHEONGCHUN";
  const fixturePath = path.join(temporaryDir, "fixture.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--fixture",
      fixturePath,
      "--output",
      path.join(temporaryDir, "output"),
    ], { cwd: root }),
    /routeServiceArtifactEvidence input is legacy/,
  );
});

test("test-only admission도 legacy canonical pack identity를 거부한다", async (context) => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-legacy-test-only-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const fixturePath = path.join(temporaryDir, "fixture.json");
  const admissionPath = path.join(temporaryDir, "admission.json");
  await writeFile(fixturePath, await readFile(new URL("./fixtures/catalog-fixture.json", import.meta.url)));
  await writeFile(admissionPath, await readFile(
    new URL("./fixtures/test-only-itx-cheongchun-admitted.json", import.meta.url),
  ));

  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-datapack.mjs",
      "--fixture", fixturePath,
      "--test-only-itx-admission", admissionPath,
      "--output", path.join(temporaryDir, "output"),
    ], {
      cwd: root,
      env: { ...process.env, EASYSUBWAY_DATAPACK_BUILD_NOW: "2026-07-14T00:00:00.000Z" },
    }),
    /test-only ITX legacy canonical pack identity is forbidden/,
  );
});

test("test-only ADMITTED timetable은 independent Hub #2135 canonical tuple 없이 v19 writer를 거부한다", async (context) => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-admitted-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL("./fixtures/catalog-fixture.json", import.meta.url), "utf8"));
  const pack = fixture.packs[0];
  pack.lines.push({
    id: "line-54a7b980b7c3",
    operatorId: "korail",
    nameKo: "경춘선",
    nameEn: "Gyeongchun Line",
    color: "#00A3E0",
  });
  pack.stations.push(
    {
      id: "station-b819702fa7d9",
      nameKo: "청량리",
      nameEn: "Cheongnyangni",
      normalizedName: "청량리",
      region: "수도권",
    },
    {
      id: "station-dd14cfb89cbc",
      nameKo: "춘천",
      nameEn: "Chuncheon",
      normalizedName: "춘천",
      region: "수도권",
    },
  );
  pack.stationLines.push(
    { stationId: "station-b819702fa7d9", lineId: "line-54a7b980b7c3", stationCode: "P117", lineSequence: 1 },
    { stationId: "station-dd14cfb89cbc", lineId: "line-54a7b980b7c3", stationCode: "P140", lineSequence: 2 },
  );
  const routeMapTemplate = pack.routeMapPositions[0];
  pack.routeMapPositions.push(
    { ...routeMapTemplate, stationId: "station-b819702fa7d9", lineId: "line-54a7b980b7c3", region: "수도권", x: 100, y: 100 },
    { ...routeMapTemplate, stationId: "station-dd14cfb89cbc", lineId: "line-54a7b980b7c3", region: "수도권", x: 200, y: 200 },
  );
  const fixturePath = path.join(temporaryDir, "fixture.json");
  const admissionPath = path.join(temporaryDir, "admission.json");
  const outputDir = path.join(temporaryDir, "output");
  const admission = JSON.parse(await readFile(
    new URL("./fixtures/test-only-itx-cheongchun-admitted.json", import.meta.url),
    "utf8",
  ));
  delete admission.canonicalPackIdentity;
  admission.stationCatalogPackIdentity = stationCatalogPackIdentity;
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`);
  await writeFile(admissionPath, `${JSON.stringify(admission, null, 2)}\n`);

  await assert.rejects(execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs",
    "--fixture", fixturePath,
    "--test-only-itx-admission", admissionPath,
    "--output", outputDir,
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_BUILD_NOW: "2026-07-14T00:00:00.000Z" },
  }), /cannot create v19 route service evidence without an independently verified #2135 canonical tuple/);
  await assert.rejects(readFile(path.join(outputDir, "catalog/capital-v1.sqlite.gz")), { code: "ENOENT" });
});
