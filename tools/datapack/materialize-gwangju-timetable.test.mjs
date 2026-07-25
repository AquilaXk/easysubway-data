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
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import { materializeBusanRouteTopology, parseCanonicalBusanStationMappings } from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import {
  materializeGwangjuTimetable,
  runGwangjuTimetableMaterializer,
} from "./materialize-gwangju-timetable.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const now = new Date("2026-07-20T13:09:00.000Z");
const execFileAsync = promisify(execFile);

test("광주 공식 topology·시간표를 20역·38 edge·810 trip·14171 stop_time으로 materialize한다", async () => {
  const values = await inputs();
  const pack = values.fixture.packs[0];
  const timetableSourceId = "gwangju-transportation-cyberstation-timetable";
  const topologySourceId = "gwangju-transportation-route-topology";
  const trips = pack.transitTrips.filter(({ sourceId }) => sourceId === timetableSourceId);
  const stopTimes = pack.transitStopTimes.filter(({ sourceId }) => sourceId === timetableSourceId);
  const calendars = pack.serviceCalendars.filter(({ sourceId }) => sourceId === timetableSourceId);
  const edges = pack.networkEdges.filter(({ sourceId }) => sourceId === topologySourceId);

  assert.match(pack.id, /^nationwide-gwangju-schedule-[a-f0-9]{64}$/);
  assert.deepEqual(values.fixture.manifest.activePack, { id: pack.id, version: "20260720" });
  assert.equal(pack.stationLines.filter(({ lineId }) => lineId === "line-e57a361e8892").length, 20);
  assert.equal(edges.length, 38);
  assert.equal(calendars.length, 4);
  assert.equal(trips.length, 810);
  assert.equal(stopTimes.length, 14_171);
  assert.equal(stopTimes.filter(({ derivationKind }) => derivationKind === "OFFICIAL").length, 13_360);
  assert.equal(stopTimes.filter(({ derivationKind }) => derivationKind === "GENERATED").length, 811);
  assert.deepEqual(Object.fromEntries(calendars.map(({ serviceId }) => [serviceId,
    trips.filter((trip) => trip.serviceId === serviceId).length])), {
    "gwangju-weekday-2026": 240,
    "gwangju-saturday-2026": 206,
    "gwangju-holiday-2026": 162,
    "gwangju-sunday-2026": 202,
  });
  const correctedHolidayDates = new Set(["20260301", "20260501", "20260524", "20260717"]);
  assert.deepEqual(pack.serviceCalendarDates
    .filter(({ date }) => correctedHolidayDates.has(date))
    .map(({ serviceId, date, exceptionType }) => ({ serviceId, date, exceptionType }))
    .sort((left, right) => `${left.date}:${left.serviceId}`.localeCompare(`${right.date}:${right.serviceId}`, "en")), [
    { serviceId: "gwangju-holiday-2026", date: "20260301", exceptionType: 1 },
    { serviceId: "gwangju-sunday-2026", date: "20260301", exceptionType: 2 },
    { serviceId: "gwangju-holiday-2026", date: "20260501", exceptionType: 1 },
    { serviceId: "gwangju-weekday-2026", date: "20260501", exceptionType: 2 },
    { serviceId: "gwangju-holiday-2026", date: "20260524", exceptionType: 1 },
    { serviceId: "gwangju-sunday-2026", date: "20260524", exceptionType: 2 },
    { serviceId: "gwangju-holiday-2026", date: "20260717", exceptionType: 1 },
    { serviceId: "gwangju-weekday-2026", date: "20260717", exceptionType: 2 },
  ]);
  const repaired = stopTimes.filter(({ repairReason }) => repairReason === "OFFICIAL_ADJACENT_TIMES_AND_TOPOLOGY");
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].arrivalSeconds, 75_570);
  assert.equal(repaired[0].stationId,
    values.gwangjuMappings.find(({ stationNumber }) => stationNumber === "105").stationId);
  assert.ok(edges.every(({ sourceSnapshotId, evidenceHash }) =>
    sourceSnapshotId === "gwangju-transportation-route-topology-20260720"
      && evidenceHash === values.gwangjuTopology.contentSha256));
  assert.ok(pack.stationLines.filter(({ lineId }) => lineId === "line-e57a361e8892")
    .every(({ fieldProvenance }) =>
      fieldProvenance.station_code.sourceId === "gwangju-transportation-route-topology"
      && fieldProvenance.station_code.sourceSnapshotId === "gwangju-transportation-route-topology-20260720"
      && fieldProvenance.station_code.evidenceHash === values.gwangjuTopology.contentSha256));
  assert.deepEqual(values.inventory.sources.find(({ id }) => id === topologySourceId).membershipAdmissionEvidence,
    values.inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route-gwangju-membership")
      .membershipAdmissionEvidence);
});

test("광주 materializer는 완결되지 않은 일요일 0756 열차 2행만 exact tuple로 격리한다", async () => {
  const values = await inputs({ materialize: false });
  assert.deepEqual(values.gwangjuTimetable.rows.filter(({ dayCode, direction, stationCode, time }) =>
    dayCode === "DAYOFF" && direction === "st"
      && ((stationCode === "119" && time === "0756") || (stationCode === "118" && time === "0759")))
    .map(({ dayCode, direction, stationCode, time }) => ({ dayCode, direction, stationCode, time })), [
    { dayCode: "DAYOFF", direction: "st", stationCode: "119", time: "0756" },
    { dayCode: "DAYOFF", direction: "st", stationCode: "118", time: "0759" },
  ]);

  const mutated = structuredClone(values.gwangjuTimetable);
  mutated.rows.find((row) => row.dayCode === "DAYOFF" && row.direction === "st"
    && row.stationCode === "118" && row.time === "0759").time = "0800";
  mutated.rowsSha256 = createHash("sha256").update(JSON.stringify(mutated.rows)).digest("hex");
  mutated.contentSha256 = createHash("sha256").update(JSON.stringify({
    fragments: mutated.fragments.map(({ stationId, rawSha256 }) => ({ stationId, rawSha256 })),
    rowsSha256: mutated.rowsSha256,
  })).digest("hex");
  const inventory = structuredClone(values.inventory);
  const evidence = inventory.sources.find(({ id }) => id === "gwangju-transportation-cyberstation-timetable")
    .scheduleAdmissionEvidence;
  evidence.rowsSha256 = mutated.rowsSha256;
  evidence.contentSha256 = mutated.contentSha256;
  assert.throws(() => materializeGwangjuTimetable({
    baseFixture: values.baseFixture,
    timetableSnapshot: mutated,
    topologySnapshot: values.gwangjuTopology,
    inventory,
    canonicalStationMappings: values.gwangjuMappings,
    now,
  }), /quarantine tuple/);
});

test("광주 materializer는 snapshot·inventory·freshness·topology lineage 변조를 fail closed한다", async () => {
  const values = await inputs({ materialize: false });
  const badTopology = structuredClone(values.gwangjuTopology);
  badTopology.edges[0].durationSeconds += 60;
  assert.throws(() => materializeGwangjuTimetable({
    baseFixture: values.baseFixture,
    timetableSnapshot: values.gwangjuTimetable,
    topologySnapshot: badTopology,
    inventory: values.inventory,
    canonicalStationMappings: values.gwangjuMappings,
    now,
  }), /topology snapshot/);
  assert.throws(() => materializeGwangjuTimetable({
    baseFixture: values.baseFixture,
    timetableSnapshot: values.gwangjuTimetable,
    topologySnapshot: values.gwangjuTopology,
    inventory: values.inventory,
    canonicalStationMappings: values.gwangjuMappings,
    now: new Date("2026-07-21T13:08:47.161Z"),
  }), /stale/);
});

test("MOLIT 광주 station mapping과 materializer CLI를 고정한다", async () => {
  const values = await inputs({ materialize: false });
  assert.equal(values.gwangjuMappings.length, 20);
  assert.deepEqual(values.gwangjuMappings.slice(0, 2).map(({ stationName, stationNumber }) =>
    ({ stationName, stationNumber })), [
    { stationName: "녹동", stationNumber: "100" },
    { stationName: "소태", stationNumber: "101" },
  ]);
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-gwangju-pack-"));
  try {
    const baseFixturePath = path.join(directory, "base.json");
    const inventoryPath = path.join(directory, "inventory.json");
    const outputPath = path.join(directory, "output.json");
    await Promise.all([
      writeFile(baseFixturePath, JSON.stringify(values.baseFixture)),
      writeFile(inventoryPath, JSON.stringify(values.inventory)),
    ]);
    await runGwangjuTimetableMaterializer([
      "--base-fixture", baseFixturePath,
      "--timetable-snapshot", path.join(root, "tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
      "--topology-snapshot", path.join(root, "tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
      "--inventory", inventoryPath,
      "--station-map", path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"),
      "--output", outputPath,
    ], { now });
    const fixture = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(fixture.packs[0].transitTrips.filter(({ sourceId }) =>
      sourceId === "gwangju-transportation-cyberstation-timetable").length, 810);
    await assert.rejects(execFileAsync(process.execPath, [
      path.join(root, "tools/datapack/materialize-gwangju-timetable.mjs"),
    ]), (error) => {
      assert.match(error.stderr, /usage: materialize-gwangju-timetable/);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("materialized SQLite·provenance가 광주 membership·topology·schedule 3건을 SUPPORTED로 만든다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-gwangju-runtime-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const { fixture } = await inputs();
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
  const sqlitePath = path.join(packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/")).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE source_id = ?")
    .get("gwangju-transportation-route-topology").count, 38);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_trips WHERE id LIKE 'trip-gwangju-%'")
    .get().count, 810);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM transit_stop_times st
    JOIN transit_trips t ON t.id = st.trip_id WHERE t.id LIKE 'trip-gwangju-%'
  `).get().count, 14_171);
  database.close();

  const provenance = JSON.parse(await readFile(path.join(packOutput, "current.provenance.json"), "utf8"));
  const records = provenance.packs.flatMap(({ records: rows }) => rows);
  assert.ok(records.some(({ sourceId, field }) =>
    sourceId === "gwangju-transportation-route-topology" && field === "network_edges"));
  assert.ok(records.some(({ sourceId, field }) =>
    sourceId === "gwangju-transportation-cyberstation-timetable" && field === "trip"));
  assert.ok(records.some(({ sourceId, field }) =>
    sourceId === "gwangju-transportation-cyberstation-timetable" && field === "stop_time"));

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
  const gwangjuRequirements = report.requirements.filter(({ regionId, operatorId, lineId }) =>
    regionId === "gwangju" && operatorId === "gwangju-metropolitan-rapid-transit"
      && lineId === "line-e57a361e8892");
  assert.deepEqual(gwangjuRequirements.filter(({ status }) => status === "SUPPORTED")
    .map(({ sourceDomain }) => sourceDomain), [
    "station_line_membership", "route_graph_topology", "schedule_timetable",
  ], JSON.stringify(gwangjuRequirements, null, 2));
  const membership = gwangjuRequirements.find(({ sourceDomain }) => sourceDomain === "station_line_membership");
  assert.deepEqual(Object.fromEntries(membership.fieldCoverage.map(({ field, sourceIds }) => [field, sourceIds])), {
    line: ["molit-urban-rail-full-route-gwangju-membership"],
    station_name: ["molit-urban-rail-full-route-gwangju-membership"],
    station_code: ["gwangju-transportation-route-topology"],
  });
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: 22,
    explicitlyUnsupportedCount: 4,
    missingCount: 244,
    supportedRatio: 0.0815,
    terminalResolutionRatio: 0.0963,
    completionReady: false,
  });
});

async function inputs({ materialize = true } = {}) {
  const [base, busanTopology, busanTimetable, busanRouteMapBytes, daejeonTopology, daejeonTimetable,
    gwangjuTopology, gwangjuTimetable, inventory, regionalMap, molitMap] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const busanTopologyFixture = materializeBusanRouteTopology({
    baseFixture: base, snapshot: busanTopology, inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(regionalMap),
    now: new Date("2026-07-19T18:14:03.004Z"),
  });
  const daejeonFixture = materializeDaejeonTimetable({
    baseFixture: busanTopologyFixture, timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology, inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(molitMap), now,
  });
  const busanTimetableFixture = materializeBusanTimetable({
    baseFixture: daejeonFixture, timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology, inventory, now,
  });
  const baseFixture = materializeBusanRouteMapPositions({
    baseFixture: busanTimetableFixture,
    snapshot: JSON.parse(busanRouteMapBytes),
    snapshotSha256: createHash("sha256").update(busanRouteMapBytes).digest("hex"),
    topologySnapshot: busanTopology,
    inventory,
    now,
  });
  const gwangjuMappings = parseMolitGwangjuStationMappings(molitMap);
  const fixture = materialize ? materializeGwangjuTimetable({
    baseFixture, timetableSnapshot: gwangjuTimetable, topologySnapshot: gwangjuTopology,
    inventory, canonicalStationMappings: gwangjuMappings, now,
  }) : undefined;
  return { baseFixture, fixture, gwangjuMappings, gwangjuTimetable, gwangjuTopology, inventory };
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
