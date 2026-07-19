import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildBackendTimetableSeed } from "./build-backend-timetable-seed.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

// 재구성 artifact(수집기 산출물) 축약 — up/down 각 1 trip, weekday/holiday 각 1.
const ARTIFACT = {
  transitTrips: [
    {
      id: "route-seoul-4-up-4719-8",
      routeId: "route-seoul-4-up",
      serviceId: "weekday-kric",
      tripHeadsign: "station-seoul-4-433",
      directionId: "up",
      servicePattern: "LOCAL",
      trainNo: "4719",
    },
    {
      id: "route-seoul-4-down-4108-9",
      routeId: "route-seoul-4-down",
      serviceId: "holiday-kric",
      tripHeadsign: "station-seoul-4-456",
      directionId: "down",
      servicePattern: "LOCAL",
      trainNo: "4108",
    },
  ],
  transitStopTimes: [
    { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 30000, departureSeconds: 30030 },
    { tripId: "route-seoul-4-up-4719-8", stopSequence: 2, stationId: "station-seoul-4-433", lineId: "seoul-4", arrivalSeconds: 30900, departureSeconds: 30930 },
    { tripId: "route-seoul-4-down-4108-9", stopSequence: 1, stationId: "station-seoul-4-433", lineId: "seoul-4", arrivalSeconds: 40000, departureSeconds: 40030 },
  ],
};

const OPTIONS = {
  lineId: "seoul-4",
  startDate: "20260101",
  endDate: "20261231",
  buildNow: new Date("2026-07-14T00:00:00.000Z"),
};

test("service_calendar는 토요일을 휴일 다이어로 매핑한다 (holiday-kric=토·일, weekday-kric=월~금)", () => {
  const seed = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  const byId = Object.fromEntries(seed.calendars.map((c) => [c.serviceId, c]));

  assert.deepEqual(
    { mon: byId["weekday-kric"].monday, fri: byId["weekday-kric"].friday, sat: byId["weekday-kric"].saturday, sun: byId["weekday-kric"].sunday },
    { mon: true, fri: true, sat: false, sun: false },
  );
  assert.deepEqual(
    { mon: byId["holiday-kric"].monday, fri: byId["holiday-kric"].friday, sat: byId["holiday-kric"].saturday, sun: byId["holiday-kric"].sunday },
    { mon: false, fri: false, sat: true, sun: true },
  );
  assert.equal(byId["weekday-kric"].startDate, "20260101");
  assert.equal(byId["weekday-kric"].endDate, "20261231");
});

test("transit_routes를 distinct routeId에서 line_id·direction으로 파생한다", () => {
  const seed = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  const byId = Object.fromEntries(seed.routes.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ["route-seoul-4-down", "route-seoul-4-up"]);
  assert.equal(byId["route-seoul-4-up"].lineId, "seoul-4");
  assert.equal(byId["route-seoul-4-up"].directionName, "up");
  assert.equal(byId["route-seoul-4-down"].directionName, "down");
});

test("SQL은 FK 순서(calendars→routes→trips→stop_times)로 INSERT를 낸다", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  const iCal = sql.indexOf("INSERT INTO service_calendars");
  const iRoute = sql.indexOf("INSERT INTO transit_routes");
  const iTrip = sql.indexOf("INSERT INTO transit_trips");
  const iStop = sql.indexOf("INSERT INTO transit_stop_times");
  assert.ok(iCal >= 0 && iRoute > iCal && iTrip > iRoute && iStop > iTrip, `순서 위반: ${[iCal, iRoute, iTrip, iStop]}`);
});

test("trip seed는 service_class·exact train_no를 명시하고 기본 SUBWAY를 보존한다", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  assert.match(
    sql,
    /INSERT INTO transit_trips \(id, route_id, service_id, service_pattern, service_class, train_no, service_day_start_seconds, trip_headsign, direction_id\)/,
  );
  assert.match(sql, /'LOCAL', 'SUBWAY', '4719', 0/);
});

test("final seed는 모든 trip의 explicit LOCAL/EXPRESS servicePattern을 요구한다", () => {
  for (const servicePattern of [undefined, null, "", " ", "RAPID", "UNKNOWN"]) {
    const trip = { ...ARTIFACT.transitTrips[0], servicePattern };
    assert.throws(
      () => buildBackendTimetableSeed({
        transitTrips: [trip],
        transitStopTimes: [ARTIFACT.transitStopTimes[0]],
      }, OPTIONS),
      /service_pattern must be explicitly LOCAL or EXPRESS/,
    );
  }
});

test("serviceClass/servicePattern 조합은 SUBWAY LOCAL·EXPRESS와 ITX EXPRESS만 허용한다", () => {
  const subwayExpress = {
    ...ARTIFACT,
    transitTrips: ARTIFACT.transitTrips.map((trip) => ({ ...trip, servicePattern: "EXPRESS" })),
  };
  assert.match(buildBackendTimetableSeed(subwayExpress, OPTIONS).sql, /'EXPRESS', 'SUBWAY'/);

  assert.throws(
    () => buildBackendTimetableSeed({
      transitTrips: [{
        ...ARTIFACT.transitTrips[0],
        serviceClass: "ITX_CHEONGCHUN",
        servicePattern: "LOCAL",
      }],
      transitStopTimes: [ARTIFACT.transitStopTimes[0]],
    }, OPTIONS),
    /ITX_CHEONGCHUN.*EXPRESS/,
  );
});

test("EXPRESS 통과역 row는 pickup/drop-off를 모두 금지하고 실제 정차역만 승하차 가능하게 보존한다", () => {
  const trip = { ...ARTIFACT.transitTrips[0], servicePattern: "EXPRESS" };
  const passThrough = {
    tripId: trip.id,
    stopSequence: 2,
    stationId: "station-pass-through",
    lineId: "seoul-4",
    pickupType: 1,
    dropOffType: 1,
    arrivalSeconds: 30500,
    departureSeconds: 30500,
  };
  const terminal = { ...ARTIFACT.transitStopTimes[1], stopSequence: 3 };
  const { sql } = buildBackendTimetableSeed({
    transitTrips: [trip],
    transitStopTimes: [ARTIFACT.transitStopTimes[0], passThrough, terminal],
  }, OPTIONS);

  assert.match(sql, /'station-pass-through', 'seoul-4', 1, 1, 30500, 30500/);
  assert.throws(
    () => buildBackendTimetableSeed({
      transitTrips: [trip],
      transitStopTimes: [
        ARTIFACT.transitStopTimes[0],
        { ...passThrough, pickupType: 1, dropOffType: 0 },
        terminal,
      ],
    }, OPTIONS),
    /EXPRESS.*pickup_type=1.*drop_off_type=1/,
  );
});

test("ITX seed는 test-only timetable·canonical pack identity evidence를 같은 SQL에 고정한다", async () => {
  const artifactBytes = await readFile(new URL("./fixtures/test-only-itx-cheongchun-admitted.json", import.meta.url));
  const artifact = JSON.parse(artifactBytes);
  artifact.routeServiceArtifactEvidence = [{
    serviceClass: "ITX_CHEONGCHUN",
    timetableArtifactId: artifact.timetableArtifactIdentity.id,
    timetableArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    canonicalPackId: artifact.canonicalPackIdentity.id,
    canonicalPackSha256: artifact.canonicalPackIdentity.sha256,
    canonicalPackSqliteSha256: artifact.canonicalPackIdentity.sqliteSha256,
    admissionStatus: "ADMITTED",
    admissionEligible: true,
    freshUntil: artifact.freshness.freshUntil,
    sourceIssue: 2116,
  }];
  const { sql } = buildBackendTimetableSeed(artifact, {
    ...OPTIONS,
    lineId: artifact.canonicalLineId,
    timetableArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    canonicalPackIdentity: artifact.canonicalPackIdentity,
    serviceCalendarDayMap: Object.fromEntries(artifact.serviceCalendars.map((calendar) => [
      calendar.serviceId,
      calendar,
    ])),
  });

  assert.match(sql, /INSERT INTO route_service_artifact_evidence/);
  assert.match(sql, new RegExp(artifact.routeServiceArtifactEvidence[0].timetableArtifactSha256));
  assert.match(sql, new RegExp(artifact.canonicalPackIdentity.sha256));
  assert.match(sql, new RegExp(artifact.canonicalPackIdentity.sqliteSha256));
  assert.match(sql, /'EXPRESS', 'ITX_CHEONGCHUN', '2001', 0/);
  assert.match(sql, /'ITX-청춘'/);
  assert.match(sql, /'청량리 → 춘천'/);
  assert.throws(
    () => buildBackendTimetableSeed({ ...artifact, transitRoutes: [] }, {
      ...OPTIONS,
      lineId: artifact.canonicalLineId,
      timetableArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
      canonicalPackIdentity: artifact.canonicalPackIdentity,
      serviceCalendarDayMap: Object.fromEntries(artifact.serviceCalendars.map((calendar) => [
        calendar.serviceId,
        calendar,
      ])),
    }),
    /routeId is missing from transitRoutes/,
  );
});

test("ITX seed evidence hash가 입력 timetable artifact bytes identity와 다르면 거부한다", async () => {
  const artifactBytes = await readFile(new URL("./fixtures/test-only-itx-cheongchun-admitted.json", import.meta.url));
  const artifact = JSON.parse(artifactBytes);
  artifact.routeServiceArtifactEvidence = [{
    serviceClass: "ITX_CHEONGCHUN",
    timetableArtifactId: artifact.timetableArtifactIdentity.id,
    timetableArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    canonicalPackId: artifact.canonicalPackIdentity.id,
    canonicalPackSha256: artifact.canonicalPackIdentity.sha256,
    canonicalPackSqliteSha256: artifact.canonicalPackIdentity.sqliteSha256,
    admissionStatus: "ADMITTED",
    admissionEligible: true,
    freshUntil: artifact.freshness.freshUntil,
    sourceIssue: 2116,
  }];

  assert.throws(
    () => buildBackendTimetableSeed(artifact, {
      ...OPTIONS,
      lineId: artifact.canonicalLineId,
      timetableArtifactSha256: "0".repeat(64),
      serviceCalendarDayMap: Object.fromEntries(artifact.serviceCalendars.map((calendar) => [
        calendar.serviceId,
        calendar,
      ])),
    }),
    /timetable artifact SHA-256 identity mismatch/,
  );
});

test("CLI는 timetable 원본과 분리된 evidence sidecar를 실제 input bytes hash에 결합한다", async (context) => {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-itx-seed-sidecar-"));
  context.after(() => rm(temporaryDir, { recursive: true, force: true }));
  const artifactBytes = await readFile(new URL("./fixtures/test-only-itx-cheongchun-admitted.json", import.meta.url));
  const artifact = JSON.parse(artifactBytes);
  const inputPath = path.join(temporaryDir, "timetable.json");
  const evidencePath = path.join(temporaryDir, "evidence.json");
  const outputPath = path.join(temporaryDir, "seed.sql");
  const timetableArtifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  await writeFile(inputPath, artifactBytes);
  await writeFile(evidencePath, `${JSON.stringify({
    serviceClass: "ITX_CHEONGCHUN",
    timetableArtifactId: artifact.timetableArtifactIdentity.id,
    timetableArtifactSha256,
    canonicalPackId: artifact.canonicalPackIdentity.id,
    canonicalPackSha256: artifact.canonicalPackIdentity.sha256,
    canonicalPackSqliteSha256: artifact.canonicalPackIdentity.sqliteSha256,
    admissionStatus: "ADMITTED",
    admissionEligible: true,
    freshUntil: "2999-01-01T00:00:00.000Z",
    sourceIssue: 2116,
  })}\n`);

  await execFileAsync(process.execPath, [
    "tools/datapack/build-backend-timetable-seed.mjs",
    "--input", inputPath,
    "--route-service-evidence", evidencePath,
    "--canonical-pack", "apps/mobile/assets/datapacks/capital.sqlite.gz",
    "--line-id", artifact.canonicalLineId,
    "--start-date", "20300101",
    "--end-date", "20300131",
    "--feed-end-date", "20300131",
    "--output", outputPath,
  ], { cwd: root });

  const sql = await readFile(outputPath, "utf8");
  assert.match(sql, new RegExp(timetableArtifactSha256));
  assert.match(sql, /'ITX_CHEONGCHUN'/);
  assert.match(sql, /'20300101', '20300131', 'Asia\/Seoul'/);
  assert.match(sql, /transit_feed_info \(id, feed_end_date\) VALUES \(1, '20300131'\)/);

  await writeFile(evidencePath, `${JSON.stringify({
    serviceClass: "ITX_CHEONGCHUN",
    timetableArtifactId: artifact.timetableArtifactIdentity.id,
    timetableArtifactSha256,
    canonicalPackId: artifact.canonicalPackIdentity.id,
    canonicalPackSha256: "0".repeat(64),
    canonicalPackSqliteSha256: artifact.canonicalPackIdentity.sqliteSha256,
    admissionStatus: "ADMITTED",
    admissionEligible: true,
    freshUntil: "2999-01-01T00:00:00.000Z",
    sourceIssue: 2116,
  })}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "tools/datapack/build-backend-timetable-seed.mjs",
      "--input", inputPath,
      "--route-service-evidence", evidencePath,
      "--canonical-pack", "apps/mobile/assets/datapacks/capital.sqlite.gz",
      "--line-id", artifact.canonicalLineId,
      "--start-date", "20300101",
      "--end-date", "20300131",
      "--feed-end-date", "20300131",
      "--output", outputPath,
    ], { cwd: root }),
    /canonical pack identity mismatch/,
  );
});

test("stale ITX evidence는 seed 생성 단계에서 거부한다", () => {
  const artifact = {
    ...ARTIFACT,
    transitTrips: ARTIFACT.transitTrips.map((trip) => ({
      ...trip,
      serviceClass: "ITX_CHEONGCHUN",
      servicePattern: "EXPRESS",
    })),
    routeServiceArtifactEvidence: [{
      serviceClass: "ITX_CHEONGCHUN",
      admissionStatus: "ADMITTED",
      admissionEligible: true,
      freshUntil: "2026-07-13T00:00:00.000Z",
    }],
  };
  assert.throws(() => buildBackendTimetableSeed(artifact, OPTIONS), /must be fresh/);
});

test("ITX trip 0건인 seed에는 ADMITTED evidence를 기록하지 않는다", () => {
  const artifact = {
    ...ARTIFACT,
    routeServiceArtifactEvidence: [{
      serviceClass: "ITX_CHEONGCHUN",
      timetableArtifactId: "wrongly-admitted-subway-only",
      timetableArtifactSha256: "a".repeat(64),
      canonicalPackId: "capital",
      canonicalPackSha256: "b".repeat(64),
      canonicalPackSqliteSha256: "c".repeat(64),
      admissionStatus: "ADMITTED",
      admissionEligible: true,
      freshUntil: "2999-01-01T00:00:00.000Z",
      sourceIssue: 2116,
    }],
  };

  assert.throws(
    () => buildBackendTimetableSeed(artifact, {
      ...OPTIONS,
      timetableArtifactSha256: "a".repeat(64),
    }),
    /ADMITTED evidence requires ITX_CHEONGCHUN trips/,
  );
});

test("ITX evidence freshUntil은 runtime loader가 읽는 offset ISO-8601 형식이어야 한다", () => {
  const artifact = {
    ...ARTIFACT,
    transitTrips: ARTIFACT.transitTrips.map((trip) => ({
      ...trip,
      serviceClass: "ITX_CHEONGCHUN",
      servicePattern: "EXPRESS",
    })),
    routeServiceArtifactEvidence: [{
      serviceClass: "ITX_CHEONGCHUN",
      timetableArtifactId: "invalid-freshness-format",
      timetableArtifactSha256: "a".repeat(64),
      canonicalPackId: "capital",
      canonicalPackSha256: "b".repeat(64),
      canonicalPackSqliteSha256: "c".repeat(64),
      admissionStatus: "ADMITTED",
      admissionEligible: true,
      freshUntil: "2999-01-01",
      sourceIssue: 2116,
    }],
  };

  assert.throws(
    () => buildBackendTimetableSeed(artifact, {
      ...OPTIONS,
      timetableArtifactSha256: "a".repeat(64),
    }),
    /freshUntil must be offset ISO-8601/,
  );
});

test("stop_time 행을 스키마 컬럼으로 직역한다 (pickup/drop_off 기본 0)", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  assert.match(
    sql,
    /INSERT INTO transit_stop_times \(trip_id, stop_sequence, station_id, line_id, pickup_type, drop_off_type, arrival_seconds, departure_seconds\)/,
  );
  assert.match(sql, /\('route-seoul-4-up-4719-8', 1, 'station-seoul-4-448', 'seoul-4', 0, 0, 30000, 30030\)/);
});

test("V29 CHECK를 위반하는 행(arrival>departure)은 거부한다", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 500, departureSeconds: 400 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /arrival/i);
});

test("시각 범위(0~107999)를 벗어나는 행은 거부한다", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 108000, departureSeconds: 108000 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /range|108000|107999/i);
});

test("미지 serviceId(캘린더 매핑 없음)는 거부한다", () => {
  const bad = {
    transitTrips: [{ ...ARTIFACT.transitTrips[0], serviceId: "unknown-kric" }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /unknown-kric|service/i);
});

test("stop_time의 tripId가 trips에 없으면 거부한다(FK)", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-orphan", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 30000, departureSeconds: 30030 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /orphan|trip_id|tripId|references|not found/i);
});

test("(tripId, stopSequence) 중복은 거부한다(PK)", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 30000, departureSeconds: 30030 },
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-433", lineId: "seoul-4", arrivalSeconds: 30900, departureSeconds: 30930 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /duplicate|중복|stop_sequence/i);
});

test("trip.id 중복은 거부한다(PK)", () => {
  const bad = {
    transitTrips: [ARTIFACT.transitTrips[0], { ...ARTIFACT.transitTrips[0] }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /duplicate|중복|transitTrips\.id/i);
});

test("service_pattern이 LOCAL/EXPRESS가 아니면 거부한다(V29 CHECK)", () => {
  const bad = {
    transitTrips: [{ ...ARTIFACT.transitTrips[0], servicePattern: "RAPID" }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /service_pattern|LOCAL|EXPRESS|RAPID/i);
});

test("service_day_start_seconds가 범위(0~107999)를 벗어나면 거부한다(V29 CHECK)", () => {
  const bad = {
    transitTrips: [{ ...ARTIFACT.transitTrips[0], serviceDayStartSeconds: 200000 }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /service_day_start|range|107999|200000/i);
});

test("trip 내 인접 정차 시각이 단조가 아니면 거부한다(departure[N] > arrival[N+1])", () => {
  const bad = {
    transitTrips: ARTIFACT.transitTrips,
    transitStopTimes: [
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 1, stationId: "station-seoul-4-448", lineId: "seoul-4", arrivalSeconds: 30000, departureSeconds: 30030 },
      { tripId: "route-seoul-4-up-4719-8", stopSequence: 2, stationId: "station-seoul-4-433", lineId: "seoul-4", arrivalSeconds: 29000, departureSeconds: 29000 },
    ],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /monoton|단조|order|departure/i);
});

test("transit_feed_info를 feed_end_date와 함께 방출한다(기본=endDate)", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, OPTIONS);
  assert.match(sql, /INSERT INTO transit_feed_info \(id, feed_end_date\) VALUES \(1, '20261231'\);/);
});

test("--feed-end-date 명시 시 endDate와 분리된다", () => {
  const { sql } = buildBackendTimetableSeed(ARTIFACT, { ...OPTIONS, feedEndDate: "20260930" });
  assert.match(sql, /INSERT INTO transit_feed_info \(id, feed_end_date\) VALUES \(1, '20260930'\);/);
});

test("feed_end_date가 8자리 YYYYMMDD가 아니면 거부한다(transit_feed_info VARCHAR(8))", () => {
  assert.throws(() => buildBackendTimetableSeed(ARTIFACT, { ...OPTIONS, feedEndDate: "2026-12-31" }), /feed_end_date|YYYYMMDD|8/i);
});

test("값에 개행이 있으면 거부한다(한 줄=한 statement 불변식, 로더 라인 파서 전제)", () => {
  const bad = {
    transitTrips: [{ ...ARTIFACT.transitTrips[0], tripHeadsign: "사당\n방면" }],
    transitStopTimes: [ARTIFACT.transitStopTimes[0]],
  };
  assert.throws(() => buildBackendTimetableSeed(bad, OPTIONS), /newline|개행|single-line|한 줄/i);
});
