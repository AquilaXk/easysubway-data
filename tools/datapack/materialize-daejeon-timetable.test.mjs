import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { checkTimetableRideConsistency } from "./validate-timetable-ride-consistency.mjs";
import {
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";
import {
  materializeDaejeonTimetable,
  materializedPackContentHash,
} from "./materialize-daejeon-timetable.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const evidenceNow = new Date("2026-07-20T04:00:00.000Z");

async function inputs() {
  const [baseFixture, timetableSnapshot, topologySnapshot, inventory, stationMapCsv] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  return {
    baseFixture,
    timetableSnapshot,
    topologySnapshot,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(stationMapCsv),
  };
}

test("대전 공식 1628행과 topology를 460 trip·10034 stop_time으로 결정적으로 materialize한다", async () => {
  const fixture = materializeDaejeonTimetable({ ...await inputs(), now: evidenceNow });
  const pack = fixture.packs[0];
  const trips = pack.transitTrips.filter(({ sourceId }) => sourceId === "daejeon-train-timetable");
  const stopTimes = pack.transitStopTimes.filter(({ sourceId }) => sourceId === "daejeon-train-timetable");
  const calendars = pack.serviceCalendars.filter(({ sourceId }) => sourceId === "daejeon-train-timetable");

  assert.match(pack.id, /^nationwide-daejeon-schedule-[a-f0-9]{64}$/);
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260720" });
  assert.equal(calendars.length, 2);
  assert.equal(trips.length, 460);
  assert.equal(stopTimes.length, 10_034);
  assert.deepEqual(Object.fromEntries(calendars.map((row) => [row.serviceId,
    trips.filter(({ serviceId }) => serviceId === row.serviceId).length])), {
    "daejeon-weekday-2026": 242,
    "daejeon-holiday-2026": 218,
  });
  assert.equal(trips.filter(({ tripHeadsign }) => tripHeadsign === "정부청사").length, 2);
  assert.equal(new Set(trips.map(({ id }) => id)).size, trips.length);
  assert.ok(stopTimes.every(({ lineId }) => lineId === "line-7051a9c2525c"));

  const stopsByTrip = Map.groupBy(stopTimes, ({ tripId }) => tripId);
  const edgeDuration = new Map(pack.networkEdges
    .filter(({ sourceId }) => sourceId === "daejeon-station-distance-fare")
    .map((edge) => [`${edge.fromNodeId.split(":")[0]}:${edge.toNodeId.split(":")[0]}`, edge.durationSeconds]));
  for (const trip of trips) {
    const stops = stopsByTrip.get(trip.id).toSorted((left, right) => left.stopSequence - right.stopSequence);
    assert.ok(stops.length >= 2);
    assert.deepEqual(stops.map(({ stopSequence }) => stopSequence),
      Array.from({ length: stops.length }, (_, index) => index + 1));
    assert.ok(stops.every((stop, index) => index === 0
      || stop.departureSeconds >= stops[index - 1].departureSeconds));
    const previous = stops.at(-2);
    const terminal = stops.at(-1);
    assert.equal(terminal.arrivalSeconds - previous.departureSeconds,
      edgeDuration.get(`${previous.stationId}:${terminal.stationId}`));
    assert.equal(terminal.departureSeconds, terminal.arrivalSeconds);
  }

  const consistency = checkTimetableRideConsistency({
    reconstruction: { transitStopTimes: stopTimes },
    rideEdges: pack.networkEdges,
  });
  assert.deepEqual(consistency.summary, {
    rideEdgeCount: 42,
    timetableSegmentCount: 42,
    matchedCount: 42,
    violationCount: 0,
    consistent: true,
    absoluteToleranceSeconds: 60,
    relativeTolerance: 0.25,
  });
});

test("대전 시간표 admission은 snapshot·inventory·freshness·topology lineage 변조를 fail closed한다", async () => {
  const values = await inputs();
  const cases = [
    [{ ...values, timetableSnapshot: { ...values.timetableSnapshot, endpoint: "https://example.invalid" } }, /snapshot/],
    [{ ...values, timetableSnapshot: { ...values.timetableSnapshot, rowsSha256: "0".repeat(64) } }, /snapshot/],
    [{ ...values, now: new Date("2026-07-21T01:16:46.435Z") }, /stale/],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => materializeDaejeonTimetable({ ...input, now: input.now ?? evidenceNow }), expected);
  }

  const mismatchedInventory = structuredClone(values.inventory);
  mismatchedInventory.sources.find(({ id }) => id === "daejeon-train-timetable")
    .scheduleAdmissionEvidence.topologyContentSha256 = "0".repeat(64);
  assert.throws(() => materializeDaejeonTimetable({
    ...values, inventory: mismatchedInventory, now: evidenceNow,
  }), /inventory evidence/);
});

test("동일 시간표 행의 다음날 refresh도 새 immutable pack identity를 만든다", async () => {
  const values = await inputs();
  const initial = materializeDaejeonTimetable({ ...values, now: evidenceNow });
  const refreshed = structuredClone(values);
  refreshed.timetableSnapshot.observedAt = "2026-07-20T22:00:00.000Z";
  const evidence = refreshed.inventory.sources.find(({ id }) => id === "daejeon-train-timetable")
    .scheduleAdmissionEvidence;
  evidence.snapshotId = "daejeon-train-timetable-20260721";
  evidence.capturedAt = refreshed.timetableSnapshot.observedAt;
  evidence.freshUntil = "2026-07-21T22:00:00.000Z";

  const next = materializeDaejeonTimetable({
    ...refreshed,
    now: new Date("2026-07-20T22:01:00.000Z"),
  });

  assert.notDeepEqual(next.manifest.activePack, initial.manifest.activePack);
  assert.equal(next.manifest.activePack.version, "20260721");
});

test("materialized pack 내용 전체가 immutable pack identity에 반영된다", () => {
  const pack = { id: "base-pack", version: "1", url: "https://example.test/base", serviceCalendars: [{ serviceId: "weekday" }] };
  const changed = structuredClone(pack);
  changed.serviceCalendars[0].endDate = "20261231";

  assert.notEqual(materializedPackContentHash(pack, "20260720"), materializedPackContentHash(changed, "20260720"));
});

test("공식 휴일 근거가 없는 연도의 timetable refresh는 fail closed한다", async () => {
  const refreshed = structuredClone(await inputs());
  refreshed.timetableSnapshot.observedAt = "2027-01-01T00:00:00.000Z";
  const evidence = refreshed.inventory.sources.find(({ id }) => id === "daejeon-train-timetable")
    .scheduleAdmissionEvidence;
  evidence.capturedAt = refreshed.timetableSnapshot.observedAt;
  evidence.freshUntil = "2027-01-02T00:00:00.000Z";

  assert.throws(() => materializeDaejeonTimetable({
    ...refreshed,
    now: new Date("2027-01-01T00:01:00.000Z"),
  }), /capturedAt Asia\/Seoul date/);

  evidence.snapshotId = "daejeon-train-timetable-20270101";
  assert.throws(() => materializeDaejeonTimetable({
    ...refreshed,
    now: new Date("2027-01-01T00:01:00.000Z"),
  }), /supported service calendar year/);
});

test("production SQLite·field provenance가 대전 schedule requirement와 런타임 artifact identity를 함께 고정한다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-daejeon-schedule-pack-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  const fixture = materializeDaejeonTimetable({ ...await inputs(), now: evidenceNow });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
  });
  const manifestPath = path.join(packOutput, "current.json");
  const manifest = await readJsonAbsolute(manifestPath);
  await execFileAsync(process.execPath, [
    "tools/datapack/validate-datapack.mjs", "--manifest", manifestPath, "--root", packOutput, "--require-production",
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey },
  });
  assert.deepEqual(manifest.activePack, fixture.manifest.activePack);

  const sqlitePath = path.join(packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/")).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM transit_trips
    WHERE id LIKE 'trip-daejeon-%'
  `).get().count, 460);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM transit_stop_times st
    JOIN transit_trips t ON t.id = st.trip_id
    WHERE t.id LIKE 'trip-daejeon-%'
  `).get().count, 10_034);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM transit_stop_times st
    JOIN transit_trips t ON t.id = st.trip_id
    JOIN service_calendars c ON c.service_id = t.service_id
    WHERE st.line_id = 'line-7051a9c2525c'
  `).get().count, 10_034);
  database.close();

  await execFileAsync(process.execPath, [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets", "tools/datapack/nationwide-coverage-targets.json",
    "--inventory", "tools/datapack/source-inventory.json",
    "--manifest", manifestPath,
    "--provenance", path.join(packOutput, "current.provenance.json"),
    "--output", reportPath,
    "--allow-gaps",
  ], { cwd: root });
  const report = await readJsonAbsolute(reportPath);
  assert.deepEqual(report.requirements
    .filter(({ operatorId, status }) => operatorId === "daejeon-transportation" && status === "SUPPORTED")
    .map(({ lineId, sourceDomain }) => ({ lineId, sourceDomain })), [
    { lineId: "line-7051a9c2525c", sourceDomain: "station_line_membership" },
    { lineId: "line-7051a9c2525c", sourceDomain: "route_graph_topology" },
    { lineId: "line-7051a9c2525c", sourceDomain: "schedule_timetable" },
  ]);
  const schedule = report.requirements.find(({ operatorId, sourceDomain }) =>
    operatorId === "daejeon-transportation" && sourceDomain === "schedule_timetable");
  assert.deepEqual(schedule.missingFields, []);
  assert.deepEqual(schedule.sourceIds, ["daejeon-train-timetable"]);
});

test("병합된 부산·대전 admission과 공식 미지원 evidence를 83/270 terminal 기준선으로 누적한다", async (context) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-nationwide-cumulative-baseline-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const values = await inputs();
  const [busanSnapshot, busanStationMapCsv] = await Promise.all([
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
  ]);
  const busanFixture = materializeBusanRouteTopology({
    baseFixture: values.baseFixture,
    snapshot: busanSnapshot,
    inventory: values.inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(busanStationMapCsv),
    now: evidenceNow,
  });
  const fixture = materializeDaejeonTimetable({
    ...values,
    baseFixture: busanFixture,
    now: evidenceNow,
  });
  const fixturePath = path.join(outputDir, "fixture.json");
  const packOutput = path.join(outputDir, "pack");
  const reportPath = path.join(outputDir, "coverage.json");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await mkdir(packOutput, { recursive: true });

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await execFileAsync(process.execPath, [
    "tools/datapack/build-datapack.mjs", "--fixture", fixturePath, "--output", packOutput,
  ], {
    cwd: root,
    env: { ...process.env, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey },
  });
  const manifest = await readJsonAbsolute(path.join(packOutput, "current.json"));
  const sqlitePath = path.join(packOutput,
    new URL(manifest.packs[0].url).pathname.split("/").slice(-2).join("/")).replace(/\.gz$/, "");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE source_id = ?")
    .get("busan-transportation-route-topology").count, 220);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE source_id = ?")
    .get("daejeon-station-distance-fare").count, 42);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM transit_trips WHERE id LIKE 'trip-daejeon-%'")
    .get().count, 460);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM transit_stop_times st
    JOIN transit_trips t ON t.id = st.trip_id
    WHERE t.id LIKE 'trip-daejeon-%'
  `).get().count, 10_034);
  database.close();
  await execFileAsync(process.execPath, [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets", "tools/datapack/nationwide-coverage-targets.json",
    "--inventory", "tools/datapack/source-inventory.json",
    "--manifest", path.join(packOutput, "current.json"),
    "--provenance", path.join(packOutput, "current.provenance.json"),
    "--resolution-plan", "tools/datapack/release/nationwide-public-api-coverage-search-plan-20260720.json",
    "--resolutions", "tools/datapack/release/nationwide-public-api-coverage-resolutions-20260720.json",
    "--output", reportPath,
    "--allow-gaps",
  ], { cwd: root });

  const report = await readJsonAbsolute(reportPath);
  assert.deepEqual(report.summary.launchRequired, {
    totalCount: 270,
    supportedCount: 7,
    explicitlyUnsupportedCount: 76,
    missingCount: 187,
    supportedRatio: 0.0259,
    terminalResolutionRatio: 0.3074,
    completionReady: false,
  });
  assert.deepEqual(report.requirements
    .filter(({ status }) => status === "SUPPORTED")
    .map(({ regionId, operatorId, lineId, sourceDomain }) =>
      `${regionId}:${operatorId}:${lineId}:${sourceDomain}`)
    .sort(), [
    "busan:busan-transportation:line-ab1a041f6266:route_graph_topology",
    "busan:busan-transportation:line-d74614a04530:route_graph_topology",
    "busan:busan-transportation:line-d812a5bc1e5f:route_graph_topology",
    "busan:busan-transportation:line-eb7b47920390:route_graph_topology",
    "daejeon:daejeon-transportation:line-7051a9c2525c:route_graph_topology",
    "daejeon:daejeon-transportation:line-7051a9c2525c:schedule_timetable",
    "daejeon:daejeon-transportation:line-7051a9c2525c:station_line_membership",
  ]);
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function readJsonAbsolute(absolutePath) {
  return JSON.parse(await readFile(absolutePath, "utf8"));
}
