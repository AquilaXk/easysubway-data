import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import {
  materializeBusanRouteTopology,
  parseCanonicalBusanStationMappings,
} from "./materialize-busan-route-topology.mjs";
import {
  materializeBusanTimetable,
  runBusanTimetableMaterializer,
} from "./materialize-busan-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const now = new Date("2026-07-20T09:00:00.000Z");
const execFileAsync = promisify(execFile);

test("부산 공식 109140행을 3833 trip·109140 stop_time으로 materialize한다", async () => {
  const { fixture } = await inputs();
  const pack = fixture.packs[0];
  const trips = pack.transitTrips.filter(({ sourceId }) => sourceId === "busan-transportation-timetable");
  const stopTimes = pack.transitStopTimes.filter(({ sourceId }) => sourceId === "busan-transportation-timetable");
  const calendars = pack.serviceCalendars.filter(({ sourceId }) => sourceId === "busan-transportation-timetable");

  assert.match(pack.id, /^nationwide-busan-schedule-[a-f0-9]{64}$/);
  assert.deepEqual(fixture.manifest.activePack, { id: pack.id, version: "20260720" });
  assert.equal(calendars.length, 3);
  assert.equal(trips.length, 3_833);
  assert.equal(stopTimes.length, 109_140);
  assert.equal(new Set(trips.map(({ id }) => id)).size, trips.length);
  assert.ok(stopTimes.every(({ arrivalSeconds, departureSeconds }) => arrivalSeconds === departureSeconds));
  assert.ok(stopTimes.every(({ sourceSnapshotId }) =>
    sourceSnapshotId === "busan-transportation-timetable-20260720"));
  assert.deepEqual(Object.fromEntries(calendars.map(({ serviceId }) => [serviceId,
    trips.filter((trip) => trip.serviceId === serviceId).length])), {
    "busan-weekday-2026": 1_354,
    "busan-saturday-2026": 1_277,
    "busan-holiday-2026": 1_202,
  });
});

test("부산 timetable admission은 snapshot·inventory·freshness·topology lineage 변조를 fail closed한다", async () => {
  const values = await inputs({ materialize: false });
  const badSnapshot = structuredClone(values.busanTimetable);
  badSnapshot.rowsSha256 = "0".repeat(64);
  assert.throws(() => materializeBusanTimetable({
    baseFixture: values.cumulativeFixture,
    timetableSnapshot: badSnapshot,
    topologySnapshot: values.busanTopology,
    inventory: values.inventory,
    now,
  }), /snapshot/);

  assert.throws(() => materializeBusanTimetable({
    baseFixture: values.cumulativeFixture,
    timetableSnapshot: values.busanTimetable,
    topologySnapshot: values.busanTopology,
    inventory: values.inventory,
    now: new Date("2026-07-21T08:37:16.931Z"),
  }), /freshness/);

  const badInventory = structuredClone(values.inventory);
  badInventory.sources.find(({ id }) => id === "busan-transportation-timetable")
    .scheduleAdmissionEvidence.topologyContentSha256 = "0".repeat(64);
  assert.throws(() => materializeBusanTimetable({
    baseFixture: values.cumulativeFixture,
    timetableSnapshot: values.busanTimetable,
    topologySnapshot: values.busanTopology,
    inventory: badInventory,
    now,
  }), /topology lineage/);

  const badFixture = structuredClone(values.cumulativeFixture);
  badFixture.packs[0].networkEdges.find(({ sourceId }) => sourceId === "busan-transportation-route-topology")
    .durationSeconds += 1;
  assert.throws(() => materializeBusanTimetable({
    baseFixture: badFixture,
    timetableSnapshot: values.busanTimetable,
    topologySnapshot: values.busanTopology,
    inventory: values.inventory,
    now,
  }), /topology/);

  const badTimetable = structuredClone(values.busanTimetable);
  const tripRows = badTimetable.rows.filter((row) => row.line === "2" && row.day === "1"
    && row.trainno === "2001" && row.updown === "0" && row.endcode === "201")
    .sort((left, right) => Number(left.hour) * 60 + Number(left.time)
      - (Number(right.hour) * 60 + Number(right.time)));
  [tripRows[2].scode, tripRows[10].scode] = [tripRows[10].scode, tripRows[2].scode];
  badTimetable.rowsSha256 = createHash("sha256").update(JSON.stringify(badTimetable.rows)).digest("hex");
  const badTimetableInventory = structuredClone(values.inventory);
  badTimetableInventory.sources.find(({ id }) => id === "busan-transportation-timetable")
    .scheduleAdmissionEvidence.rowsSha256 = badTimetable.rowsSha256;
  assert.throws(() => materializeBusanTimetable({
    baseFixture: values.cumulativeFixture,
    timetableSnapshot: badTimetable,
    topologySnapshot: values.busanTopology,
    inventory: badTimetableInventory,
    now,
  }), /topology adjacency/);
});

test("부산 2026 토요일 공휴일은 휴일 운행을 추가하고 토요일 운행을 제거한다", async () => {
  const { fixture } = await inputs();
  const dates = fixture.packs[0].serviceCalendarDates
    .filter(({ sourceId }) => sourceId === "busan-transportation-timetable");
  for (const date of ["20260606", "20260815", "20260926", "20261003"]) {
    assert.ok(dates.some((row) => row.date === date
      && row.serviceId === "busan-holiday-2026" && row.exceptionType === 1));
    assert.ok(dates.some((row) => row.date === date
      && row.serviceId === "busan-saturday-2026" && row.exceptionType === 2));
  }
});

test("부산 timetable은 다음 날짜의 fresh snapshot ID를 허용한다", async () => {
  const values = await inputs({ materialize: false });
  const timetableSnapshot = structuredClone(values.busanTimetable);
  timetableSnapshot.capturedAt = "2026-07-21T00:01:00.000Z";
  timetableSnapshot.freshUntil = "2026-07-22T00:01:00.000Z";
  const inventory = structuredClone(values.inventory);
  const evidence = inventory.sources.find(({ id }) => id === "busan-transportation-timetable")
    .scheduleAdmissionEvidence;
  evidence.snapshotId = "busan-transportation-timetable-20260721";
  evidence.capturedAt = timetableSnapshot.capturedAt;
  evidence.freshUntil = timetableSnapshot.freshUntil;
  const fixture = materializeBusanTimetable({
    baseFixture: values.cumulativeFixture,
    timetableSnapshot,
    topologySnapshot: values.busanTopology,
    inventory,
    now: new Date("2026-07-21T00:02:00.000Z"),
  });
  assert.equal(fixture.manifest.activePack.version, "20260721");
});

test("부산 timetable materializer CLI가 cumulative fixture를 출력한다", async () => {
  const values = await inputs({ materialize: false });
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-busan-schedule-pack-"));
  try {
    const baseFixture = path.join(directory, "base.json");
    const inventory = path.join(directory, "inventory.json");
    const output = path.join(directory, "output.json");
    await Promise.all([
      writeFile(baseFixture, JSON.stringify(values.cumulativeFixture)),
      writeFile(inventory, JSON.stringify(values.inventory)),
    ]);
    await runBusanTimetableMaterializer([
      "--base-fixture", baseFixture,
      "--timetable-snapshot", path.join(root, "tools/datapack/sources/busan-transportation-timetable-20260720.json"),
      "--topology-snapshot", path.join(root, "tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
      "--inventory", inventory,
      "--output", output,
    ], { now });
    const fixture = JSON.parse(await readFile(output, "utf8"));
    assert.equal(fixture.packs[0].transitTrips.filter(({ sourceId }) =>
      sourceId === "busan-transportation-timetable").length, 3_833);
    await assert.rejects(execFileAsync(process.execPath, [
      path.join(root, "tools/datapack/materialize-busan-timetable.mjs"),
    ]), (error) => {
      assert.match(error.stderr, /usage: materialize-busan-timetable/);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function inputs({ materialize = true } = {}) {
  const [baseFixture, busanTopology, busanTimetable, daejeonTimetable, daejeonTopology,
    inventory, busanMap, daejeonMap] = await Promise.all([
    readJson("tools/datapack/release/capital-production-reviewed-pack.json"),
    readJson("tools/datapack/sources/busan-transportation-route-topology-20260720.json"),
    readJson("tools/datapack/sources/busan-transportation-timetable-20260720.json"),
    readJson("tools/datapack/sources/daejeon-train-timetable-20260720.json"),
    readJson("tools/datapack/sources/daejeon-route-topology-20260720.json"),
    readJson("tools/datapack/source-inventory.json"),
    readFile(path.join(root, "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv"), "utf8"),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const busanFixture = materializeBusanRouteTopology({
    baseFixture,
    snapshot: busanTopology,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(busanMap),
    now,
  });
  const cumulativeFixture = materializeDaejeonTimetable({
    baseFixture: busanFixture,
    timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology,
    inventory,
    canonicalStationMappings: parseMolitDaejeonStationMappings(daejeonMap),
    now,
  });
  const fixture = materialize ? materializeBusanTimetable({
    baseFixture: cumulativeFixture,
    timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology,
    inventory,
    now,
  }) : undefined;
  return { busanTimetable, busanTopology, cumulativeFixture, fixture, inventory };
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
