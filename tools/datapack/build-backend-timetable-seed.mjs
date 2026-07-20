#!/usr/bin/env node
// 재구성 artifact(collect-kric-line4-timetables 산출물) → 백엔드 Flyway DB용 timetable seed SQL.
// 백엔드 RAPTOR 플래너(JdbcRouteTimetableRepository)가 읽는 transit_routes/service_calendars/
// transit_trips/transit_stop_times를 채운다. station_lines·station 행은 백엔드 스키마에 없어 불필요.
//
// 실행: node build-backend-timetable-seed.mjs --input <artifact.json> --line-id seoul-4 --output <seed.sql>
//
// 출력 SQL은 H2(PostgreSQL 모드)·실제 postgresql 양립. 지금은 백엔드 테스트 리소스, 나중에 Flyway
// 데이터 마이그레이션 본체로 재활용(dual-use). FK 순서: calendars→routes→trips→stop_times.
//
// 전체 재생성(4호선 51역 전량):
//   KRIC_SERVICE_KEY=... node collect-kric-line4-timetables.mjs \
//     --roster sources/kric-line4-route-roster-20260706.json --line-id seoul-4 --output <artifact.json>
//   node build-backend-timetable-seed.mjs --input <artifact.json> --line-id seoul-4 --output <seed.sql>
// 실증(2026-07-06): 895 trip·33,062 stop_times가 V29 제약을 전량 통과, H2 적재 후 RAPTOR PLANNED 산출.
// 전량 seed는 **prod-게이트 런타임 로더**(TimetableSeedLoader, @Profile prod + @ConditionalOnProperty
// easysubway.timetable.seed.enabled)가 startup(Flyway 이후)에 TransactionTemplate으로 all-or-nothing 적재한다.
// Flyway 데이터 마이그레이션을 쓰지 않는 이유: 배포 시 자동 적용이라 flag 게이트가 불가하고 ~67개 @SpringBootTest DB를
// 오염시키며 버전 번호 경합이 있다. feed_end_date는 seed에 포함(--feed-end-date, 기본=--end-date; STALE 안전장치).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const SECONDS_LIMIT_EXCLUSIVE = 108000; // V29 CHECK: arrival/departure BETWEEN 0 AND 107999

// KRIC dayCd 매핑(collect-kric의 SERVICE_ID_BY_DAY_CD와 정합). 토요일→휴일: 4호선은 dayCd=7(토) 무응답이라
// 토요일 다이어가 휴일(holiday-kric)로 흡수된다 → holiday-kric에 saturday=true.
const SERVICE_CALENDAR_DAY_MAP = {
  "weekday-kric": { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
  "saturday-kric": { monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: false },
  "holiday-kric": { monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: true },
};

const DEFAULT_START_DATE = "20260101";
const DEFAULT_END_DATE = "20261231";
const DEFAULT_TIMEZONE = "Asia/Seoul";

export function buildBackendTimetableSeed(artifact, options = {}) {
  const trips = artifact?.transitTrips ?? [];
  const stopTimes = artifact?.transitStopTimes ?? [];
  const lineId = options.lineId ?? null;
  const startDate = options.startDate ?? DEFAULT_START_DATE;
  const endDate = options.endDate ?? DEFAULT_END_DATE;
  const feedEndDate = options.feedEndDate ?? endDate;
  if (!/^\d{8}$/.test(feedEndDate)) {
    throw new Error(`feed_end_date must be 8-digit YYYYMMDD (transit_feed_info VARCHAR(8)): ${feedEndDate}`);
  }
  const dayMap = options.serviceCalendarDayMap ?? SERVICE_CALENDAR_DAY_MAP;
  const excludedServiceCalendarIds = new Set(options.excludeServiceCalendarIds ?? []);

  const tripsById = validateTrips(trips);
  validateStopTimes(stopTimes, tripsById);
  const evidence = validateRouteServiceEvidence(
    artifact?.routeServiceArtifactEvidence ?? [],
    trips,
    options.buildNow ?? new Date(),
    options.timetableArtifactSha256,
    options.canonicalPackIdentity,
  );

  const calendars = deriveCalendars(trips, dayMap, startDate, endDate)
    .filter(({ serviceId }) => !excludedServiceCalendarIds.has(serviceId));
  const routes = deriveRoutes(trips, lineId, artifact?.transitRoutes);

  const statements = [
    ...(options.includeFeedInfo === false ? [] : [feedInfoInsert(feedEndDate)]),
    ...evidence.map(routeServiceEvidenceInsert),
    ...calendars.map(calendarInsert),
    ...routes.map(routeInsert),
    ...trips.map(tripInsert),
    ...stopTimes.map(stopTimeInsert),
  ];
  const sql = `${statements.join("\n")}\n`;

  return { sql, statements, calendars, routes, tripCount: trips.length, stopTimeCount: stopTimes.length };
}

const ALLOWED_SERVICE_PATTERNS = new Set(["LOCAL", "EXPRESS"]);
const ALLOWED_SERVICE_CLASSES = new Set(["SUBWAY", "ITX_CHEONGCHUN"]);
const OFFSET_ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

// trip 행이 V29 제약(id PK 유일, service_pattern CHECK, service_day_start_seconds 범위)을 만족하는지
// 생성 단계에서 검증한다(로드-시점 FK/CHECK 실패를 앞당김). trip id 집합을 stop_times FK 검증용으로 반환.
function validateTrips(trips) {
  const byId = new Map();
  for (const trip of trips) {
    const id = requireString(trip.id, "transitTrips.id");
    if (byId.has(id)) {
      throw new Error(`transit_trips duplicate id (PK): ${id}`);
    }
    requireString(trip.routeId, "transitTrips.routeId");
    requireString(trip.serviceId, "transitTrips.serviceId");
    requireString(trip.tripHeadsign, "transitTrips.tripHeadsign");
    requireString(trip.directionId, "transitTrips.directionId");
    const pattern = trip.servicePattern;
    if (!ALLOWED_SERVICE_PATTERNS.has(pattern)) {
      throw new Error(`transit_trips service_pattern must be explicitly LOCAL or EXPRESS: ${id}:${pattern}`);
    }
    const serviceClass = trip.serviceClass ?? "SUBWAY";
    if (!ALLOWED_SERVICE_CLASSES.has(serviceClass)) {
      throw new Error(`transit_trips service_class must be SUBWAY or ITX_CHEONGCHUN: ${id}:${serviceClass}`);
    }
    if (serviceClass === "ITX_CHEONGCHUN" && pattern !== "EXPRESS") {
      throw new Error(`ITX_CHEONGCHUN trips must use EXPRESS service_pattern: ${id}:${pattern}`);
    }
    const dayStart = trip.serviceDayStartSeconds ?? 0;
    if (!Number.isInteger(dayStart) || dayStart < 0 || dayStart >= SECONDS_LIMIT_EXCLUSIVE) {
      throw new Error(`transit_trips service_day_start_seconds out of range [0,${SECONDS_LIMIT_EXCLUSIVE}): ${id}:${dayStart}`);
    }
    byId.set(id, { serviceClass, servicePattern: pattern });
  }
  return byId;
}

function validateRouteServiceEvidence(
  rows,
  trips,
  buildNow,
  timetableArtifactSha256,
  canonicalPackIdentity,
) {
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("routeServiceArtifactEvidence must contain at most one row");
  }
  const hasItxTrips = trips.some(({ serviceClass }) => serviceClass === "ITX_CHEONGCHUN");
  if (!hasItxTrips) {
    const evidence = rows[0];
    if (evidence && (
      evidence.serviceClass !== "ITX_CHEONGCHUN"
      || evidence.admissionStatus !== "MISSING"
      || evidence.admissionEligible !== false
    )) {
      throw new Error("ADMITTED evidence requires ITX_CHEONGCHUN trips");
    }
    if (evidence) {
      validateCanonicalPackIdentity(evidence, canonicalPackIdentity);
    }
    return rows;
  }
  const evidence = rows[0];
  if (
    evidence?.serviceClass !== "ITX_CHEONGCHUN"
    || evidence.admissionStatus !== "ADMITTED"
    || evidence.admissionEligible !== true
  ) {
    throw new Error("ITX_CHEONGCHUN seed requires ADMITTED route service evidence");
  }
  if (typeof evidence.freshUntil !== "string" || !OFFSET_ISO_8601.test(evidence.freshUntil)) {
    throw new Error("ITX_CHEONGCHUN freshUntil must be offset ISO-8601");
  }
  const freshUntil = new Date(evidence.freshUntil);
  if (Number.isNaN(freshUntil.getTime()) || freshUntil <= buildNow) {
    throw new Error("ITX_CHEONGCHUN route service evidence must be fresh");
  }
  if (
    typeof timetableArtifactSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(timetableArtifactSha256)
    || evidence.timetableArtifactSha256 !== timetableArtifactSha256
  ) {
    throw new Error("ITX_CHEONGCHUN timetable artifact SHA-256 identity mismatch");
  }
  validateCanonicalPackIdentity(evidence, canonicalPackIdentity);
  return rows;
}

function validateCanonicalPackIdentity(evidence, canonicalPackIdentity) {
  if (
    typeof canonicalPackIdentity?.id !== "string"
    || !/^[a-f0-9]{64}$/.test(canonicalPackIdentity?.sha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(canonicalPackIdentity?.sqliteSha256 ?? "")
    || evidence.canonicalPackId !== canonicalPackIdentity.id
    || evidence.canonicalPackSha256 !== canonicalPackIdentity.sha256
    || evidence.canonicalPackSqliteSha256 !== canonicalPackIdentity.sqliteSha256
  ) {
    throw new Error("ITX_CHEONGCHUN canonical pack identity mismatch");
  }
}

function validateStopTimes(stopTimes, tripsById) {
  const seenKeys = new Set();
  const byTrip = new Map();
  for (const row of stopTimes) {
    const tripId = requireString(row.tripId, "transitStopTimes.tripId");
    const stopSequence = requireInteger(row.stopSequence, "stopSequence");
    const arrival = requireInteger(row.arrivalSeconds, "arrivalSeconds");
    const departure = requireInteger(row.departureSeconds, "departureSeconds");
    const trip = tripsById.get(tripId);
    if (!trip) {
      throw new Error(`transit_stop_times trip_id not found in transitTrips (FK): ${tripId}:${stopSequence}`);
    }
    requireString(row.stationId, "transitStopTimes.stationId");
    requireString(row.lineId, "transitStopTimes.lineId");
    const pickupType = row.pickupType ?? 0;
    const dropOffType = row.dropOffType ?? 0;
    if (![0, 1].includes(pickupType) || ![0, 1].includes(dropOffType)) {
      throw new Error(`transit_stop_times pickup_type/drop_off_type must be 0 or 1: ${tripId}:${stopSequence}`);
    }
    if (trip.servicePattern === "EXPRESS" && pickupType !== dropOffType) {
      throw new Error(
        `EXPRESS pass-through rows must set pickup_type=1 and drop_off_type=1 together: ${tripId}:${stopSequence}`,
      );
    }
    if (arrival < 0 || arrival >= SECONDS_LIMIT_EXCLUSIVE || departure < 0 || departure >= SECONDS_LIMIT_EXCLUSIVE) {
      throw new Error(`transit_stop_times seconds out of range [0,${SECONDS_LIMIT_EXCLUSIVE}): ${tripId}:${stopSequence}`);
    }
    if (arrival > departure) {
      throw new Error(`transit_stop_times arrival must be <= departure: ${tripId}:${stopSequence}`);
    }
    if (stopSequence < 1) {
      throw new Error(`transit_stop_times stop_sequence must be >= 1: ${tripId}`);
    }
    const key = `${tripId}:${stopSequence}`;
    if (seenKeys.has(key)) {
      throw new Error(`transit_stop_times duplicate (trip_id, stop_sequence) (PK): ${key}`);
    }
    seenKeys.add(key);
    const rows = byTrip.get(tripId) ?? [];
    rows.push({ stopSequence, arrival, departure });
    byTrip.set(tripId, rows);
  }
  // intra-trip 시각 단조성: stopSequence 순서로 departure[N] <= arrival[N+1] (음/영 소요시간 방지, RAPTOR 전제).
  for (const [tripId, rows] of byTrip) {
    rows.sort((left, right) => left.stopSequence - right.stopSequence);
    if (rows.some((row, index) => row.stopSequence !== index + 1)) {
      throw new Error(`transit_stop_times stop_sequence must be contiguous from 1: ${tripId}`);
    }
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index - 1].departure > rows[index].arrival) {
        throw new Error(
          `transit_stop_times departure must be <= next arrival (monotonic order): ${tripId}:${rows[index - 1].stopSequence}->${rows[index].stopSequence}`,
        );
      }
    }
  }
  for (const tripId of tripsById.keys()) {
    if (!byTrip.has(tripId)) {
      throw new Error(`transit_trips must contain at least one stop pattern row: ${tripId}`);
    }
  }
}

function deriveCalendars(trips, dayMap, startDate, endDate) {
  const serviceIds = [...new Set(trips.map((trip) => requireString(trip.serviceId, "transitTrips.serviceId")))].sort(
    (left, right) => codepointCompare(left, right),
  );
  return serviceIds.map((serviceId) => {
    const days = dayMap[serviceId];
    if (!days) {
      throw new Error(`service_calendar mapping missing for serviceId: ${serviceId}`);
    }
    return { serviceId, startDate, endDate, timezone: DEFAULT_TIMEZONE, ...days };
  });
}

function deriveRoutes(trips, lineId, routeRows) {
  if (routeRows !== undefined && !Array.isArray(routeRows)) {
    throw new Error("transitRoutes must be an array");
  }
  const declaredRoutes = new Map();
  for (const row of routeRows ?? []) {
    const id = requireString(row.id, "transitRoutes.id");
    if (declaredRoutes.has(id)) {
      throw new Error(`transitRoutes duplicate id: ${id}`);
    }
    declaredRoutes.set(id, row);
  }
  const byId = new Map();
  for (const trip of trips) {
    const id = requireString(trip.routeId, "transitTrips.routeId");
    const declared = declaredRoutes.get(id);
    if (routeRows !== undefined && !declared) {
      throw new Error(`transitTrips routeId is missing from transitRoutes: ${id}`);
    }
    if (!byId.has(id)) {
      const declaredLineId = declared ? requireString(declared.lineId, `transitRoutes.${id}.lineId`) : null;
      if (lineId && declaredLineId && lineId !== declaredLineId) {
        throw new Error(`transitRoutes lineId does not match --line-id: ${id}`);
      }
      byId.set(id, {
        id,
        lineId: lineId ?? declaredLineId ?? deriveLineIdFromRouteId(id),
        directionName: optionalString(declared?.directionName, `transitRoutes.${id}.directionName`, trip.directionId ?? ""),
        shortName: optionalString(declared?.routeShortName, `transitRoutes.${id}.routeShortName`),
        longName: optionalString(declared?.routeLongName, `transitRoutes.${id}.routeLongName`),
        timezone: optionalString(declared?.timezone, `transitRoutes.${id}.timezone`, DEFAULT_TIMEZONE),
      });
    }
  }
  return [...byId.values()].sort((left, right) => codepointCompare(left.id, right.id));
}

function deriveLineIdFromRouteId(routeId) {
  // route-<lineId>-<direction> 관례에서 lineId 도출(옵션 미지정 시 방어적).
  const match = /^route-(.+)-(up|down)$/.exec(routeId);
  return match ? match[1] : routeId;
}

function calendarInsert(c) {
  return (
    "INSERT INTO service_calendars (service_id, start_date, end_date, timezone, monday, tuesday, wednesday, thursday, friday, saturday, sunday) VALUES (" +
    `${quote(c.serviceId)}, ${quote(c.startDate)}, ${quote(c.endDate)}, ${quote(c.timezone)}, ` +
    `${bool(c.monday)}, ${bool(c.tuesday)}, ${bool(c.wednesday)}, ${bool(c.thursday)}, ${bool(c.friday)}, ${bool(c.saturday)}, ${bool(c.sunday)});`
  );
}

function routeInsert(r) {
  return (
    "INSERT INTO transit_routes (id, timezone, line_id, route_short_name, route_long_name, direction_name) VALUES (" +
    `${quote(r.id)}, ${quote(r.timezone)}, ${quote(r.lineId)}, ${quote(r.shortName)}, ${quote(r.longName)}, ${quote(r.directionName)});`
  );
}

function tripInsert(t) {
  return (
    "INSERT INTO transit_trips (id, route_id, service_id, service_pattern, service_class, train_no, service_day_start_seconds, trip_headsign, direction_id) VALUES (" +
    `${quote(requireString(t.id, "transitTrips.id"))}, ${quote(requireString(t.routeId, "transitTrips.routeId"))}, ` +
    `${quote(requireString(t.serviceId, "transitTrips.serviceId"))}, ${quote(t.servicePattern)}, ` +
    `${quote(t.serviceClass ?? "SUBWAY")}, ${nullableQuote(t.trainNo)}, ${t.serviceDayStartSeconds ?? 0}, ` +
    `${quote(t.tripHeadsign ?? "")}, ${quote(t.directionId ?? "")});`
  );
}

function routeServiceEvidenceInsert(row) {
  const hashes = [
    [row.timetableArtifactSha256, "timetableArtifactSha256"],
    [row.canonicalPackSha256, "canonicalPackSha256"],
    [row.canonicalPackSqliteSha256, "canonicalPackSqliteSha256"],
  ];
  for (const [value, label] of hashes) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`routeServiceArtifactEvidence.${label} must be a lowercase sha256`);
    }
  }
  if (![2116, 2135].includes(row.sourceIssue)) {
    throw new Error("routeServiceArtifactEvidence.sourceIssue must be 2116 or 2135");
  }
  return (
    "INSERT INTO route_service_artifact_evidence (service_class, timetable_artifact_id, timetable_artifact_sha256, canonical_pack_id, canonical_pack_sha256, canonical_pack_sqlite_sha256, admission_status, admission_eligible, fresh_until, source_issue) VALUES (" +
    `${quote(requireString(row.serviceClass, "routeServiceArtifactEvidence.serviceClass"))}, ` +
    `${quote(requireString(row.timetableArtifactId, "routeServiceArtifactEvidence.timetableArtifactId"))}, ` +
    `${quote(row.timetableArtifactSha256)}, ${quote(requireString(row.canonicalPackId, "routeServiceArtifactEvidence.canonicalPackId"))}, ` +
    `${quote(row.canonicalPackSha256)}, ${quote(row.canonicalPackSqliteSha256)}, ${quote(row.admissionStatus)}, ` +
    `${bool(row.admissionEligible)}, ${row.freshUntil == null ? "NULL" : quote(row.freshUntil)}, ${row.sourceIssue});`
  );
}

function stopTimeInsert(s) {
  return (
    "INSERT INTO transit_stop_times (trip_id, stop_sequence, station_id, line_id, pickup_type, drop_off_type, arrival_seconds, departure_seconds) VALUES (" +
    `${quote(requireString(s.tripId, "transitStopTimes.tripId"))}, ${requireInteger(s.stopSequence, "stopSequence")}, ` +
    `${quote(requireString(s.stationId, "transitStopTimes.stationId"))}, ${quote(requireString(s.lineId, "transitStopTimes.lineId"))}, ` +
    `${s.pickupType ?? 0}, ${s.dropOffType ?? 0}, ${requireInteger(s.arrivalSeconds, "arrivalSeconds")}, ${requireInteger(s.departureSeconds, "departureSeconds")});`
  );
}

function feedInfoInsert(feedEndDate) {
  return `INSERT INTO transit_feed_info (id, feed_end_date) VALUES (1, ${quote(feedEndDate)});`;
}

function quote(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    // 로더는 한 줄=한 statement로 파싱하므로 값에 개행이 있으면 statement가 쪼개진다(불변식 강제).
    throw new Error(`value must not contain a newline (single-line statement invariant): ${JSON.stringify(text)}`);
  }
  return `'${text.replaceAll("'", "''")}'`;
}

function nullableQuote(value) {
  return value == null || String(value).trim() === "" ? "NULL" : quote(value);
}

function bool(value) {
  return value ? "TRUE" : "FALSE";
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, label, fallback = "") {
  if (value == null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactBytes = await readFile(args.input);
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  let canonicalPackIdentity;
  if (args["route-service-evidence"]) {
    if ((artifact.routeServiceArtifactEvidence ?? []).length > 0) {
      throw new Error("route service evidence must be separate from timetable artifact bytes");
    }
    if (!args["canonical-pack"]) {
      throw new Error("--canonical-pack is required with --route-service-evidence");
    }
    const canonicalPackBytes = await readFile(args["canonical-pack"]);
    let canonicalSqliteBytes;
    try {
      canonicalSqliteBytes = gunzipSync(canonicalPackBytes);
    } catch {
      throw new Error("--canonical-pack must be a gzip-compressed SQLite artifact");
    }
    canonicalPackIdentity = {
      id: requireString(artifact.canonicalPackIdentity?.id, "canonicalPackIdentity.id"),
      sha256: createHash("sha256").update(canonicalPackBytes).digest("hex"),
      sqliteSha256: createHash("sha256").update(canonicalSqliteBytes).digest("hex"),
    };
    if (
      artifact.canonicalPackIdentity?.sha256 !== canonicalPackIdentity.sha256
      || artifact.canonicalPackIdentity?.sqliteSha256 !== canonicalPackIdentity.sqliteSha256
    ) {
      throw new Error("timetable artifact canonical pack identity mismatch");
    }
    const sidecar = JSON.parse(await readFile(args["route-service-evidence"], "utf8"));
    artifact.routeServiceArtifactEvidence = Array.isArray(sidecar) ? sidecar : [sidecar];
  }
  const seed = buildBackendTimetableSeed(artifact, {
    lineId: args["line-id"],
    startDate: args["start-date"],
    endDate: args["end-date"],
    feedEndDate: args["feed-end-date"],
    timetableArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    canonicalPackIdentity,
    serviceCalendarDayMap: Array.isArray(artifact.serviceCalendars)
      ? Object.fromEntries(artifact.serviceCalendars.map((calendar) => [calendar.serviceId, {
        monday: calendar.monday,
        tuesday: calendar.tuesday,
        wednesday: calendar.wednesday,
        thursday: calendar.thursday,
        friday: calendar.friday,
        saturday: calendar.saturday,
        sunday: calendar.sunday,
      }]))
      : undefined,
  });
  if (args.output) {
    await writeFile(args.output, seed.sql);
  }
  process.stdout.write(
    `${JSON.stringify({ calendars: seed.calendars.length, routes: seed.routes.length, trips: seed.tripCount, stopTimes: seed.stopTimeCount }, null, 2)}\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    args[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
