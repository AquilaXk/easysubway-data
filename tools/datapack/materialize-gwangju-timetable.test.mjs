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
  materializeRegionalProductionCandidate,
  projectHistoricalRegionalMaterializeInventory,
  projectRegionalMaterializeFixture,
} from "./materialize-test-fixture.mjs";

import {
  parseMolitDaejeonStationMappings,
  parseMolitGwangjuStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { materializeBusanRouteMapPositions } from "./materialize-busan-route-map-positions.mjs";
import { materializeBusanRouteTopology, parseCanonicalBusanStationMappings } from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import {
  buildRetainedGwangjuServiceCalendars,
  buildRetainedGwangjuTransitTables,
  materializeGwangjuTimetable,
  projectRetainedGwangjuTrips,
  runGwangjuTimetableMaterializer,
} from "./materialize-gwangju-timetable.mjs";

const retainedServices = { "평일": "weekday", "토요일": "saturday", "휴일": "holiday", "명절": "special" };

test("retained Gwangju calendars select weekday, Saturday, Sunday, and public-holiday exceptions", () => {
  const result = buildRetainedGwangjuServiceCalendars({ startDate: "20400105", endDate: "20400108", serviceIds: retainedServices,
    publicHolidayDates: new Set(["20400105", "20400108"]), specialServiceDates: new Set() });
  assert.deepEqual(result.serviceCalendars.map(({ serviceId, monday, tuesday, wednesday, thursday, friday, saturday, sunday }) =>
    ({ serviceId, monday, tuesday, wednesday, thursday, friday, saturday, sunday })), [
    { serviceId: "weekday", monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
    { serviceId: "saturday", monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: false },
    { serviceId: "holiday", monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: true },
    { serviceId: "special", monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: false },
  ]);
  assert.deepEqual(result.serviceCalendarDates, [
    { serviceId: "weekday", date: "20400105", exceptionType: 2 }, { serviceId: "holiday", date: "20400105", exceptionType: 1 },
  ]);
});

test("retained Gwangju special dates take precedence and valid out-of-range dates are ignored", () => {
  const result = buildRetainedGwangjuServiceCalendars({ startDate: "20400106", endDate: "20400107", serviceIds: retainedServices,
    publicHolidayDates: new Set(["20400106", "20400105"]), specialServiceDates: new Set(["20400106", "20400107", "20400108"]) });
  assert.deepEqual(result.serviceCalendarDates, [
    { serviceId: "weekday", date: "20400106", exceptionType: 2 }, { serviceId: "special", date: "20400106", exceptionType: 1 },
    { serviceId: "saturday", date: "20400107", exceptionType: 2 }, { serviceId: "special", date: "20400107", exceptionType: 1 },
  ]);
});

test("retained Gwangju calendars reject missing sets, invalid dates, and duplicate service identities", () => {
  const valid = { startDate: "20400101", endDate: "20400102", serviceIds: retainedServices, publicHolidayDates: new Set(), specialServiceDates: new Set() };
  for (const input of [{ ...valid, publicHolidayDates: [] }, { ...valid, specialServiceDates: undefined },
    { ...valid, specialServiceDates: new Set(["20400230"]) },
    { ...valid, serviceIds: { ...retainedServices, "명절": "holiday" } }]) {
    assert.throws(() => buildRetainedGwangjuServiceCalendars(input), /calendar input/);
  }
});

const root = path.resolve(import.meta.dirname, "../..");
process.env.EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY = "true";
const now = new Date("2026-07-20T13:09:00.000Z");
const execFileAsync = promisify(execFile);

function retainedNativeRecord(sourceRowNumber, stationName, overrides = {}) {
  const record = {
    trainNumber: "1001", routeNumber: "S2901", routeName: "광주 1호선",
    originStationName: "A", destinationStationName: "B", serviceType: "LOCAL", weekdayType: "WEEKDAY",
    stationName, arrivalTime: { value: "24:00:00" }, departureTime: { value: "24:00:30" },
    sourceRowNumber, sourceRowSha256: "a".repeat(64), nativeMarker: `native-${sourceRowNumber}`,
    ...overrides,
  };
  return record;
}

const retainedBindings = Object.freeze([
  { sourceLabel: "A", stationId: "station-a", stationCode: "A" },
  { sourceLabel: "B", stationId: "station-b", stationCode: "B" },
]);
const retainedEdges = Object.freeze([{ fromStationCode: "A", toStationCode: "B" }]);
const retainedProjection = (records, overrides = {}) => projectRetainedGwangjuTrips({
  records, stationBindings: retainedBindings, directedEdges: retainedEdges, excludedEndpointLabels: ["외부"], ...overrides,
});

test("retained Gwangju transit tables preserve native identities, clocks, row order, and provenance", () => {
  const records = [
    retainedNativeRecord(1, "A", { arrivalTime: { value: "24:00:00" }, departureTime: { value: "24:00:30" } }),
    retainedNativeRecord(2, "B", { arrivalTime: { value: "24:00:30" }, departureTime: { value: "25:01:30" }, sourceRowSha256: "b".repeat(64) }),
    retainedNativeRecord(3, "A", { routeName: "other", arrivalTime: { value: "26:00:00" }, departureTime: { value: "26:00:00" } }),
    retainedNativeRecord(4, "B", { routeName: "other", arrivalTime: { value: "26:01:00" }, departureTime: { value: "26:01:10" } }),
  ];
  const projection = retainedProjection(records), before = structuredClone(projection);
  const tables = buildRetainedGwangjuTransitTables({ projection, lineId: "line-test",
    routeBindings: [{ originStationName: "A", destinationStationName: "B", routeId: "route-a", directionId: "up", tripHeadsign: "B" }],
    serviceIds: { WEEKDAY: "weekday" }, servicePatterns: { LOCAL: "LOCAL" }, serviceDayStartSeconds: 10,
    provenance: { sourceId: "source", sourceSnapshotId: "snapshot", evidenceHash: "e".repeat(64), updatedAt: "2040-01-01T00:00:00.000Z" } });
  assert.deepEqual(projection, before);
  assert.equal(tables.transitTrips.length, 2);
  assert.notEqual(tables.transitTrips[0].id, tables.transitTrips[1].id);
  assert.deepEqual(tables.transitStopTimes.map(({ stopSequence, arrivalSeconds, departureSeconds, pickupType, dropOffType }) =>
    ({ stopSequence, arrivalSeconds, departureSeconds, pickupType, dropOffType })), [
    { stopSequence: 1, arrivalSeconds: 86400, departureSeconds: 86430, pickupType: 0, dropOffType: 1 },
    { stopSequence: 2, arrivalSeconds: 86430, departureSeconds: 90090, pickupType: 1, dropOffType: 0 },
    { stopSequence: 1, arrivalSeconds: 93600, departureSeconds: 93600, pickupType: 0, dropOffType: 1 },
    { stopSequence: 2, arrivalSeconds: 93660, departureSeconds: 93670, pickupType: 1, dropOffType: 0 },
  ]);
  assert.equal(tables.transitStopTimes[0].providerRecordHash, records[0].sourceRowSha256);
  assert.equal(tables.transitStopTimes[1].providerRecordHash, records[1].sourceRowSha256);
  assert.equal(tables.transitTrips[0].providerRecordHash,
    createHash("sha256").update(JSON.stringify(records.slice(0, 2).map((row) => row.sourceRowSha256))).digest("hex"));
  assert.deepEqual(tables.transitStopTimes.slice(0, 2).map((row) => row.stationId), ["station-a", "station-b"]);
  assert.equal(tables.transitTrips[0].sourceSnapshotId, "snapshot");
});

test("retained Gwangju transit tables reject a missing route mapping", () => {
  const projection = retainedProjection([retainedNativeRecord(1, "A"), retainedNativeRecord(2, "B", {
    arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:30" },
  })]);
  assert.throws(() => buildRetainedGwangjuTransitTables({ projection, lineId: "line", routeBindings: [],
    serviceIds: { WEEKDAY: "weekday" }, servicePatterns: { LOCAL: "LOCAL" }, serviceDayStartSeconds: 0,
    provenance: { sourceId: "source", sourceSnapshotId: "snapshot", evidenceHash: "e", updatedAt: "2040-01-01T00:00:00.000Z" } }), /mapping is missing/);
});

test("retained native trip projection은 source 행 순서와 24시 이후 시각·원문 근거를 보존한다", () => {
  const first = [
    retainedNativeRecord(1, "외부", { arrivalTime: { value: "24:00:00" }, departureTime: { value: "24:00:00" } }),
    retainedNativeRecord(2, "A", { arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:30" } }),
    retainedNativeRecord(3, "B", { arrivalTime: { value: "24:02:00" }, departureTime: { value: "24:02:00" } }),
  ];
  const second = [
    retainedNativeRecord(4, "A", {
      trainNumber: "1002", weekdayType: "SATURDAY", arrivalTime: { value: "25:00:00" }, departureTime: { value: "25:00:30" },
    }),
    retainedNativeRecord(5, "B", {
      trainNumber: "1002", weekdayType: "SATURDAY", arrivalTime: { value: "25:01:00" }, departureTime: { value: "25:01:00" },
    }),
  ];

  const projected = retainedProjection([second[1], first[2], second[0], first[0], first[1]]);

  assert.deepEqual(projected.trips.map(({ identity }) => [identity.trainNumber, identity.weekdayType]), [
    ["1001", "WEEKDAY"], ["1002", "SATURDAY"],
  ]);
  assert.deepEqual(projected.trips[0].stops.map(({ sourceRowNumber, stationCode, arrival, departure }) => ({
    sourceRowNumber, stationCode, arrival, departure,
  })), [
    { sourceRowNumber: 2, stationCode: "A", arrival: { value: "24:01:00", seconds: 86_460 }, departure: { value: "24:01:30", seconds: 86_490 } },
    { sourceRowNumber: 3, stationCode: "B", arrival: { value: "24:02:00", seconds: 86_520 }, departure: { value: "24:02:00", seconds: 86_520 } },
  ]);
  assert.equal(projected.trips[0].excludedEndpoints.length, 1);
  assert.equal(projected.trips[0].excludedEndpoints[0].record.stationName, "외부");
  assert.equal(projected.trips[0].stops.some(({ stationId }) => stationId === "station-외부"), false);
  assert.deepEqual(projected.trips[0].stops[0].record, first[1]);
  assert.equal(projected.nonRoutableGroups.length, 0);
  assert.equal(JSON.stringify(projected).includes("tripId"), false);
  assert.equal(JSON.stringify(projected).includes("freshUntil"), false);
});

test("retained native trip projection은 binding·edge·순서 계약 위반을 거부한다", () => {
  const records = [
    retainedNativeRecord(1, "A"),
    retainedNativeRecord(2, "B", { arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:00" } }),
  ];
  const cases = [
    ["ambiguous exclusion", () => retainedProjection(records, { excludedEndpointLabels: ["A"] }), /classification is ambiguous/],
    ["unknown", () => retainedProjection([{ ...records[0], stationName: "UNKNOWN" }, records[1]]), /station binding is missing/],
    ["edge", () => retainedProjection(records, { directedEdges: [] }), /directed edge is missing/],
    ["interior exclusion", () => retainedProjection([
      records[0], retainedNativeRecord(2, "외부", { arrivalTime: { value: "24:00:40" }, departureTime: { value: "24:00:40" } }),
      { ...records[1], sourceRowNumber: 3 },
    ]), /endpoint exclusion is interior/],
    ["time", () => retainedProjection([
      { ...records[0], departureTime: { value: "25:00:00" } }, records[1],
    ]), /time order is invalid/],
    ["duplicate", () => retainedProjection([{ ...records[0] }, { ...records[1], stationName: "A" }]), /station repeats/],
    ["discontiguous", () => retainedProjection([
      records[0], retainedNativeRecord(2, "A", { trainNumber: "1002" }),
      { ...records[1], sourceRowNumber: 3 },
    ]), /group is discontiguous/],
    ["ambiguous bindings", () => retainedProjection(records, {
      stationBindings: [...retainedBindings, { sourceLabel: "A", stationId: "station-other", stationCode: "C" }],
    }), /station bindings are ambiguous/],
  ];
  for (const [name, invoke, pattern] of cases) assert.throws(invoke, pattern, name);
});

test("retained native trip projection은 한 승객 정류장 그룹을 비운행 근거로 보존한다", () => {
  const projected = retainedProjection([
    retainedNativeRecord(1, "외부"),
    retainedNativeRecord(2, "A", { arrivalTime: { value: "24:01:00" }, departureTime: { value: "24:01:00" } }),
  ]);

  assert.equal(projected.trips.length, 0);
  assert.equal(projected.nonRoutableGroups.length, 1);
  assert.equal(projected.nonRoutableGroups[0].reason, "PASSENGER_STOP_COUNT_LT_2");
  assert.deepEqual(projected.nonRoutableGroups[0].records.map(({ sourceRowNumber }) => sourceRowNumber), [1, 2]);
  assert.equal(projected.nonRoutableGroups[0].excludedEndpoints[0].record.stationName, "외부");
});

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

test("광주 materializer는 evaluation instant 이후 membership verification을 거부한다", async () => {
  const values = await inputs({ materialize: false });
  const inventory = structuredClone(values.inventory);
  const verifiedAt = new Date(now.getTime() + 1).toISOString();
  inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route-gwangju-membership")
    .membershipAdmissionEvidence.verifiedAt = verifiedAt;
  inventory.sources.find(({ id }) => id === "gwangju-transportation-route-topology")
    .membershipAdmissionEvidence.verifiedAt = verifiedAt;

  assert.throws(() => materializeGwangjuTimetable({
    baseFixture: values.baseFixture,
    timetableSnapshot: values.gwangjuTimetable,
    topologySnapshot: values.gwangjuTopology,
    inventory,
    canonicalStationMappings: values.gwangjuMappings,
    now,
  }), /molit-urban-rail-full-route-gwangju-membership membership evidence is future-dated/);
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
  await materializeRegionalProductionCandidate({ outputDir: packOutput, privateKey });
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
    readJson("tools/datapack/release/capital-production-reviewed-pack.json").then(projectRegionalMaterializeFixture),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readFile(path.join(root, "tools/datapack/sources/busan-transportation-route-map-positions-20260720.json")),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/gwangju-transportation-cyberstation-timetable-20260720.json"),
    readJson("tools/datapack/source-inventory.json").then(projectHistoricalRegionalMaterializeInventory),
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
