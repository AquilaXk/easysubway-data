import { createHash } from "node:crypto";

import { codepointCompare } from "../../lib/codepoint-compare.mjs";

// #899: 공식 원천 시간표를 노선 단위로 팩에 적재하는 원천 중립 적재기.
// provider(원천별 parser)가 정규화 trip을 넘기면, 이 모듈이 팩 역 정체성·노선 위상과 대조해
// routes·trips·stop_times·calendars를 만든다. 시각·정차·순서를 만들거나 고치지 않는다.
//
// 정규화 trip:
//   { lineId, routeKey, providerTripKey, trainNumber, serviceDayKind, servicePattern("LOCAL"|"EXPRESS"),
//     headsign, sourceRowSha256, stops: [{ stationName, arrivalSeconds|null, departureSeconds|null }] }
// provider:
//   { sourceId, sourceSnapshotId, rawSha256, recordsSha256, observedAt, dataReferenceDateByLine, trips, quarantine }
// lineBindings:
//   [{ lineId, routeKey, routeName, stationAliases: { 원천역명: { nameKo, reason } },
//      quarantineAllowance?: { reason, rowCount, rowSetSha256, note } }]
//   quarantineAllowance는 실측으로 확인한 원천 손상 행 집합을 노선별로 고정한다. 사유·건수·행 집합 해시
//   (정렬한 sourceRowSha256을 줄바꿈으로 이은 값의 sha256) 중 하나라도 다르면 실패한다. 고정 집합 밖의
//   격리 행은 다른 노선과 같은 maxQuarantineRatio를 적용한다.
//
// 실패 규칙(명시적 오류, 대체 없음):
// - 노선 역명이 팩 역(별칭 표 포함)에 없으면 실패한다.
// - 노선에 적재된 trip이 0이거나, 원천에 있는 운행일 종류 중 적재 trip이 0인 종류가 있으면 실패한다.
// - 노선 격리 비율이 maxQuarantineRatio를 넘으면 실패한다.
// 행 격리(사유 기록): 시각 역전·문법 오류(provider), 일반열차의 비인접 정차·도달 불가 정차 쌍(이 모듈).

export const OFFICIAL_SERVICE_DAY_KINDS = Object.freeze({
  WEEKDAY: Object.freeze({ slug: "weekday", code: "w", days: [1, 1, 1, 1, 1, 0, 0], holiday: "REMOVE" }),
  SATURDAY: Object.freeze({ slug: "saturday", code: "s", days: [0, 0, 0, 0, 0, 1, 0], holiday: "REMOVE" }),
  SUNDAY_HOLIDAY: Object.freeze({ slug: "sunday-holiday", code: "h", days: [0, 0, 0, 0, 0, 0, 1], holiday: "ADD" }),
  WEEKEND_HOLIDAY: Object.freeze({ slug: "weekend-holiday", code: "e", days: [0, 0, 0, 0, 0, 1, 1], holiday: "ADD" }),
});
const WEEKDAY_FIELDS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SERVICE_PATTERNS = new Set(["LOCAL", "EXPRESS"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, detail = "") => { throw new Error(`OFFICIAL_LINE_TIMETABLE_${code}${detail ? `: ${detail}` : ""}`); };

/**
 * @param {object} args
 * @param {object} args.pack 누적 production 팩(stations·stationLines·networkEdges·transit* 표)
 * @param {object} args.provider 원천 provider
 * @param {object[]} args.lineBindings 노선 결속 표
 * @param {string} args.serviceIdPrefix 운행일 serviceId 접두(원천마다 고유)
 * @param {string} args.tripIdPrefix trip_id 접두(원천마다 고유, 영소문자·숫자 1~8자)
 * @param {string[]} args.holidayDates 공휴일(YYYYMMDD). 평일·토요일 운행에서 빼고 일·공휴일 운행에 더한다.
 * @param {string} args.startDate 운행 달력 시작(YYYYMMDD)
 * @param {string} args.endDate 운행 달력 끝(YYYYMMDD)
 * @param {number} args.maxQuarantineRatio 노선별 허용 격리 비율(0~1)
 */
export function materializeOfficialLineTimetables({
  pack, provider, lineBindings, serviceIdPrefix, tripIdPrefix, holidayDates, startDate, endDate, maxQuarantineRatio,
}) {
  validateArguments({ pack, provider, lineBindings, serviceIdPrefix, tripIdPrefix, holidayDates, startDate, endDate, maxQuarantineRatio });
  const stationsById = new Map(pack.stations.map((station) => [station.id, station]));
  const bindingByRouteKey = new Map();
  const resolvers = new Map();
  for (const binding of lineBindings) {
    if (bindingByRouteKey.has(binding.routeKey)) fail("BINDING_DUPLICATE", binding.routeKey);
    bindingByRouteKey.set(binding.routeKey, binding);
    resolvers.set(binding.routeKey, lineStationResolver(pack, stationsById, binding));
  }
  const adjacency = new Map(lineBindings.map(({ lineId }) => [lineId, rideAdjacency(pack, lineId)]));

  const unmatched = new Map();
  const admitted = [];
  const quarantine = [...provider.quarantine];
  for (const trip of provider.trips) {
    const binding = bindingByRouteKey.get(trip.routeKey);
    if (!binding || binding.lineId !== trip.lineId) fail("TRIP_BINDING", trip.providerTripKey);
    if (!OFFICIAL_SERVICE_DAY_KINDS[trip.serviceDayKind]) fail("SERVICE_DAY_KIND", trip.providerTripKey);
    if (!SERVICE_PATTERNS.has(trip.servicePattern)) fail("SERVICE_PATTERN", trip.providerTripKey);
    const resolver = resolvers.get(trip.routeKey);
    const stationIds = trip.stops.map(({ stationName }) => {
      const stationId = resolver(stationName);
      if (!stationId) {
        const names = unmatched.get(binding.lineId) ?? new Set();
        names.add(stationName);
        unmatched.set(binding.lineId, names);
      }
      return stationId;
    });
    if (stationIds.some((stationId) => !stationId)) continue;
    const reason = stopPairReason(stationIds, trip.servicePattern, adjacency.get(binding.lineId));
    if (reason) {
      quarantine.push({
        sourceId: provider.sourceId, lineId: binding.lineId, routeKey: trip.routeKey, trainNumber: trip.trainNumber,
        serviceDayKind: trip.serviceDayKind, sourceDayKey: trip.sourceDayKey ?? null, sourceRowNumber: trip.sourceRowNumber ?? null,
        sourceRowSha256: trip.sourceRowSha256, reason,
      });
      continue;
    }
    admitted.push({ trip, binding, stationIds });
  }
  if (unmatched.size > 0) {
    fail("STATION_UNMATCHED", [...unmatched].map(([lineId, names]) => `${lineId}=[${[...names].sort(codepointCompare).join(",")}]`).join(" "));
  }

  const lineSummaries = summarizeLines({ provider, lineBindings, admitted, quarantine, maxQuarantineRatio });
  const tables = buildTables({ provider, lineBindings, admitted, serviceIdPrefix, tripIdPrefix, holidayDates, startDate, endDate });
  return { ...tables, quarantine: quarantine.sort(compareQuarantine), lineSummaries };
}

function validateArguments({ pack, provider, lineBindings, serviceIdPrefix, tripIdPrefix, holidayDates, startDate, endDate, maxQuarantineRatio }) {
  if (!Array.isArray(pack?.stations) || !Array.isArray(pack?.stationLines) || !Array.isArray(pack?.networkEdges)) fail("PACK");
  if (typeof provider?.sourceId !== "string" || typeof provider.sourceSnapshotId !== "string"
    || !/^[a-f0-9]{64}$/u.test(provider.recordsSha256 ?? "") || !Number.isFinite(Date.parse(provider.observedAt))
    || !Array.isArray(provider.trips) || !Array.isArray(provider.quarantine)) fail("PROVIDER");
  if (!Array.isArray(lineBindings) || lineBindings.length === 0) fail("BINDINGS");
  if (!/^[a-z0-9-]+$/u.test(serviceIdPrefix ?? "")) fail("SERVICE_ID_PREFIX");
  if (!/^[a-z0-9]{1,8}$/u.test(tripIdPrefix ?? "")) fail("TRIP_ID_PREFIX");
  if (!Array.isArray(holidayDates) || holidayDates.some((date) => !/^\d{8}$/u.test(date))) fail("HOLIDAYS");
  if (!/^\d{8}$/u.test(startDate ?? "") || !/^\d{8}$/u.test(endDate ?? "") || startDate > endDate) fail("CALENDAR_RANGE");
  if (typeof maxQuarantineRatio !== "number" || !(maxQuarantineRatio >= 0 && maxQuarantineRatio < 1)) fail("QUARANTINE_RATIO");
}

function lineStationResolver(pack, stationsById, binding) {
  const byName = new Map();
  for (const stationLine of pack.stationLines.filter(({ lineId }) => lineId === binding.lineId)) {
    const station = stationsById.get(stationLine.stationId);
    if (!station) fail("STATION_MISSING", stationLine.stationId);
    if (byName.has(station.nameKo) && byName.get(station.nameKo) !== station.id) fail("STATION_NAME_AMBIGUOUS", `${binding.lineId} ${station.nameKo}`);
    byName.set(station.nameKo, station.id);
  }
  if (byName.size === 0) fail("LINE_HAS_NO_STATIONS", binding.lineId);
  const aliases = new Map();
  for (const [sourceName, alias] of Object.entries(binding.stationAliases ?? {})) {
    if (typeof alias?.nameKo !== "string" || typeof alias.reason !== "string" || alias.reason.length === 0) fail("ALIAS", sourceName);
    if (byName.has(sourceName)) fail("ALIAS_SHADOWS_STATION", `${binding.lineId} ${sourceName}`);
    if (!byName.has(alias.nameKo)) fail("ALIAS_TARGET_MISSING", `${binding.lineId} ${sourceName}->${alias.nameKo}`);
    aliases.set(sourceName, byName.get(alias.nameKo));
  }
  return (stationName) => byName.get(stationName) ?? aliases.get(stationName) ?? null;
}

function rideAdjacency(pack, lineId) {
  const suffix = `:${lineId}`;
  const adjacency = new Map();
  for (const edge of pack.networkEdges) {
    if (edge.edgeType !== "RIDE" || !edge.fromNodeId.endsWith(suffix) || !edge.toNodeId.endsWith(suffix)) continue;
    const from = edge.fromNodeId.slice(0, -suffix.length);
    const to = edge.toNodeId.slice(0, -suffix.length);
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  }
  if (adjacency.size === 0) fail("LINE_HAS_NO_RIDE_EDGES", lineId);
  return adjacency;
}

// 일반열차는 연속 정차가 같은 노선 RIDE 간선으로 바로 이어져야 한다. 급행·직통은 노선 위상에서 도달 가능해야 한다.
function stopPairReason(stationIds, servicePattern, adjacency) {
  for (let index = 1; index < stationIds.length; index += 1) {
    const from = stationIds[index - 1];
    const to = stationIds[index];
    if (from === to) return "REPEATED_CONSECUTIVE_STOP";
    if (adjacency.get(from)?.has(to)) continue;
    if (servicePattern === "LOCAL") return "NON_ADJACENT_LOCAL_STOP";
    if (!reachable(adjacency, from, to)) return "UNREACHABLE_STOP_PAIR";
  }
  return null;
}

function reachable(adjacency, from, to) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of adjacency.get(current) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return false;
}

function summarizeLines({ provider, lineBindings, admitted, quarantine, maxQuarantineRatio }) {
  const summaries = [];
  for (const binding of lineBindings) {
    const lineAdmitted = admitted.filter(({ binding: candidate }) => candidate.routeKey === binding.routeKey);
    const lineQuarantine = quarantine.filter(({ routeKey }) => routeKey === binding.routeKey);
    const sourceTripCount = lineAdmitted.length + lineQuarantine.length;
    if (lineAdmitted.length === 0) fail("LINE_HAS_NO_TRIPS", `${binding.lineId} ${binding.routeKey}`);
    const sourceKinds = new Set(provider.trips.filter(({ routeKey }) => routeKey === binding.routeKey).map(({ serviceDayKind }) => serviceDayKind));
    for (const row of lineQuarantine) if (OFFICIAL_SERVICE_DAY_KINDS[row.serviceDayKind]) sourceKinds.add(row.serviceDayKind);
    const tripsByKind = {};
    for (const { trip } of lineAdmitted) tripsByKind[trip.serviceDayKind] = (tripsByKind[trip.serviceDayKind] ?? 0) + 1;
    for (const kind of sourceKinds) {
      if (!tripsByKind[kind]) fail("SERVICE_DAY_HAS_NO_TRIPS", `${binding.lineId} ${kind}`);
    }
    const allowed = allowedQuarantine(binding, lineQuarantine);
    const unallowed = lineQuarantine.filter((row) => !allowed.has(row));
    const quarantineRatio = lineQuarantine.length / sourceTripCount;
    const unallowedRatio = unallowed.length / (sourceTripCount - allowed.size);
    const byReason = {};
    for (const { reason } of lineQuarantine) byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (unallowedRatio > maxQuarantineRatio) {
      fail("LINE_QUARANTINE_RATIO_EXCEEDED", `${binding.lineId} ${binding.routeKey} ${unallowed.length}/${sourceTripCount - allowed.size} > ${maxQuarantineRatio} ${JSON.stringify(byReason)}`);
    }
    summaries.push({
      lineId: binding.lineId,
      routeKey: binding.routeKey,
      routeName: binding.routeName,
      sourceTripCount,
      admittedTripCount: lineAdmitted.length,
      admittedStopTimeCount: lineAdmitted.reduce((total, { stationIds }) => total + stationIds.length, 0),
      tripsByServiceDayKind: Object.fromEntries(Object.entries(tripsByKind).sort(([left], [right]) => codepointCompare(left, right))),
      quarantinedTripCount: lineQuarantine.length,
      quarantineRatio: Number(quarantineRatio.toFixed(4)),
      quarantineByReason: Object.fromEntries(Object.entries(byReason).sort(([left], [right]) => codepointCompare(left, right))),
      pinnedQuarantine: binding.quarantineAllowance ? {
        reason: binding.quarantineAllowance.reason,
        rowCount: allowed.size,
        rowSetSha256: binding.quarantineAllowance.rowSetSha256,
        note: binding.quarantineAllowance.note,
      } : null,
      dataReferenceDates: provider.dataReferenceDateByLine?.[binding.lineId] ?? [],
    });
  }
  return summaries;
}

// 고정 집합: 허용 사유를 가진 격리 행 전체가 정확히 고정한 건수·행 집합 해시와 같아야 한다.
function allowedQuarantine(binding, lineQuarantine) {
  const allowance = binding.quarantineAllowance;
  if (!allowance) return new Set();
  if (typeof allowance.reason !== "string" || !Number.isSafeInteger(allowance.rowCount) || allowance.rowCount <= 0
    || !/^[a-f0-9]{64}$/u.test(allowance.rowSetSha256 ?? "") || typeof allowance.note !== "string" || allowance.note.length === 0) {
    fail("QUARANTINE_ALLOWANCE", binding.routeKey);
  }
  const rows = lineQuarantine.filter(({ reason }) => reason === allowance.reason);
  const rowSetSha256 = quarantineRowSetSha256(rows);
  if (rows.length !== allowance.rowCount || rowSetSha256 !== allowance.rowSetSha256) {
    fail("QUARANTINE_ALLOWANCE_MISMATCH", `${binding.lineId} ${binding.routeKey} ${allowance.reason} ${rows.length}/${allowance.rowCount} ${rowSetSha256}`);
  }
  return new Set(rows);
}

/** 격리 행 집합 해시: 정렬한 sourceRowSha256을 줄바꿈으로 이어 sha256. */
export function quarantineRowSetSha256(rows) {
  return sha256(`${rows.map(({ sourceRowSha256 }) => sourceRowSha256).sort(codepointCompare).join("\n")}\n`);
}

function buildTables({ provider, lineBindings, admitted, serviceIdPrefix, tripIdPrefix, holidayDates, startDate, endDate }) {
  const provenance = (providerRecordHash) => ({
    sourceId: provider.sourceId,
    sourceSnapshotId: provider.sourceSnapshotId,
    providerRecordHash,
    evidenceHash: provider.recordsSha256,
    provenanceKind: "OFFICIAL_SOURCE",
    derivationKind: "OFFICIAL",
    updatedAt: provider.observedAt,
  });
  const serviceId = (kind) => `${serviceIdPrefix}-${OFFICIAL_SERVICE_DAY_KINDS[kind].slug}`;
  const routeId = (binding) => `route-${serviceIdPrefix}-${binding.routeKey.toLowerCase()}`;

  const transitRoutes = lineBindings.map((binding) => ({
    id: routeId(binding),
    lineId: binding.lineId,
    routeShortName: binding.routeKey,
    routeLongName: binding.routeName,
    directionName: "",
    ...provenance(sha256(`${provider.sourceSnapshotId}\u0000${binding.routeKey}`)),
  }));

  // stop_time 행은 tripId FK로 trip provenance(원천 행 sha256·snapshot·evidence)를 이어받는다.
  // 행마다 provenance를 복제하지 않는다(팩·field-provenance 크기, #899).
  const transitTrips = [];
  const transitStopTimes = [];
  const usedKinds = new Set();
  const tripIds = new Set();
  for (const { trip, binding, stationIds } of admitted) {
    usedKinds.add(trip.serviceDayKind);
    // trip_id는 timetable SQLite 크기를 줄이려고 짧게 둔다: <tripIdPrefix>-<노선 키>-<운행일 코드>-<provider key sha256 앞 12자>.
    // 결정적이고, 충돌하면 실패한다. 원천 행 식별은 trip provenance(providerRecordHash)에 남는다.
    const tripId = `${tripIdPrefix}-${binding.routeKey.toLowerCase()}-${OFFICIAL_SERVICE_DAY_KINDS[trip.serviceDayKind].code}-${sha256(trip.providerTripKey).slice(0, 12)}`;
    if (tripIds.has(tripId)) fail("TRIP_ID_COLLISION", tripId);
    tripIds.add(tripId);
    transitTrips.push({
      id: tripId,
      routeId: routeId(binding),
      serviceId: serviceId(trip.serviceDayKind),
      tripHeadsign: trip.headsign,
      directionId: "",
      servicePattern: trip.servicePattern,
      serviceClass: "SUBWAY",
      serviceDayStartSeconds: 0,
      ...provenance(trip.sourceRowSha256),
    });
    trip.stops.forEach((stop, index) => {
      const arrivalSeconds = stop.arrivalSeconds ?? stop.departureSeconds;
      const departureSeconds = stop.departureSeconds ?? stop.arrivalSeconds;
      transitStopTimes.push({
        tripId,
        stopSequence: index + 1,
        stationId: stationIds[index],
        lineId: binding.lineId,
        arrivalSeconds,
        departureSeconds,
        pickupType: 0,
        dropOffType: 0,
      });
    });
  }

  const kinds = [...usedKinds].sort(codepointCompare);
  const calendarProvenance = provenance(sha256(`${provider.sourceSnapshotId}\u0000calendar`));
  const serviceCalendars = kinds.map((kind) => ({
    serviceId: serviceId(kind),
    ...Object.fromEntries(WEEKDAY_FIELDS.map((field, index) => [field, OFFICIAL_SERVICE_DAY_KINDS[kind].days[index] === 1])),
    startDate,
    endDate,
    ...calendarProvenance,
  }));
  const serviceCalendarDates = [];
  for (const date of [...holidayDates].sort(codepointCompare)) {
    if (date < startDate || date > endDate) continue;
    const weekday = (new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`).getUTCDay() + 6) % 7;
    for (const kind of kinds) {
      const spec = OFFICIAL_SERVICE_DAY_KINDS[kind];
      const runs = spec.days[weekday] === 1;
      if (spec.holiday === "REMOVE" && runs) serviceCalendarDates.push({ serviceId: serviceId(kind), date, exceptionType: 2, ...calendarProvenance });
      if (spec.holiday === "ADD" && !runs) serviceCalendarDates.push({ serviceId: serviceId(kind), date, exceptionType: 1, ...calendarProvenance });
    }
  }
  return { transitRoutes, transitTrips, transitStopTimes, serviceCalendars, serviceCalendarDates };
}

function compareQuarantine(left, right) {
  return codepointCompare(left.lineId, right.lineId) || codepointCompare(left.sourceRowSha256, right.sourceRowSha256)
    || codepointCompare(left.reason, right.reason);
}
