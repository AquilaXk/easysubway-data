import { createHash } from "node:crypto";

import { parseRetainedKasiHolidayMonth } from "./fetch-kasi-public-holiday-calendar.mjs";
import { buildRetainedGwangjuServiceCalendars, projectRetainedGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { prepareRetainedKricTimetablePublication } from "./prepare-retained-kric-timetable-publication.mjs";

const SEOUL_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
});
const SERVICE_LABELS = Object.freeze(["평일", "토요일", "휴일", "명절"]);

/**
 * 보관 입력에서 광주 시간표 계약을 생성한다.
 * 관측 시각을 갱신하지 않으며 발행·등록·네트워크 호출은 수행하지 않는다.
 */
export function prepareRetainedGwangjuContract({
  candidate, observationBytes, receipt, routeNumber, stationBindings, excludedEndpointLabels,
  topologySnapshot, holidayCalendar, evaluationAt, providerValidUntil,
}) {
  const prepared = prepareRetainedKricTimetablePublication({
    candidate, observationBytes, receipt, routeNumber, sourcePath: "timetable-observation.json",
    evaluationAt, providerValidUntil,
  });
  const observation = JSON.parse(observationBytes.toString("utf8"));
  const { calendar, holidayCalendarEvidence } = prepareCalendar({ holidayCalendar, observedAt: receipt.capturedAt,
    freshnessExpiresAt: prepared.freshnessExpiresAt });
  const serviceIds = Object.fromEntries(SERVICE_LABELS.map((label) => [label, `service-${routeNumber}-${label}`]));
  buildRetainedGwangjuServiceCalendars({ ...calendar, serviceIds,
    publicHolidayDates: new Set(calendar.publicHolidayDates) });

  const projection = projectRetainedGwangjuTimetable({
    observation, receipt, routeNumber, stationBindings,
    directedEdges: topologyEdges(topologySnapshot), excludedEndpointLabels,
  });
  const routeBindings = prepareRouteBindings({ projection, topologySnapshot, routeNumber });
  const contract = {
    routeNumber, stationBindings, excludedEndpointLabels, routeBindings, serviceIds,
    servicePatterns: { "일반": "LOCAL" }, serviceDayStartSeconds: 0, calendar,
    confirmationWindow: { observedAt: receipt.capturedAt, expiresAt: prepared.freshnessExpiresAt },
    holidayCalendarEvidence,
  };
  return { contract, contractSha256: sha256(canonicalJson(contract)) };
}

function prepareCalendar({ holidayCalendar, observedAt, freshnessExpiresAt }) {
  if (!holidayCalendar || !/^[a-f0-9]{64}$/u.test(holidayCalendar.manifestSha256 ?? "")
    || !Array.isArray(holidayCalendar.months)) {
    throw new Error("retained Gwangju holiday calendar is invalid");
  }
  const months = holidayCalendar.months.map((entry) => {
    if (typeof entry?.retrievedAt !== "string" || !Number.isFinite(Date.parse(entry.retrievedAt))) {
      throw new Error("retained Gwangju holiday calendar month is invalid");
    }
    return { ...parseRetainedKasiHolidayMonth(entry), retrievedAt: entry.retrievedAt };
  }).sort((left, right) => left.year - right.year || left.month - right.month);
  const monthKeys = new Set(months.map(({ year, month }) => year * 12 + month - 1));
  if (monthKeys.size !== months.length) throw new Error("duplicate holiday month");
  const startDate = seoulDate(observedAt);
  const endDate = seoulDate(Date.parse(freshnessExpiresAt) - 1);
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error("retained Gwangju confirmation window is invalid");
  }
  for (let key = monthKey(startDate); key <= monthKey(endDate); key += 1) {
    if (!monthKeys.has(key)) throw new Error("missing official holiday month");
  }
  return {
    calendar: { startDate, endDate,
      publicHolidayDates: [...new Set(months.flatMap(({ holidayDates }) => holidayDates))].sort(utf16Compare) },
    holidayCalendarEvidence: { manifestSha256: holidayCalendar.manifestSha256, months },
  };
}

function prepareRouteBindings({ projection, topologySnapshot, routeNumber }) {
  const scope = topologySnapshot?.scope;
  if (!Array.isArray(scope) || scope.length < 2
    || scope.some(({ stationCode }) => typeof stationCode !== "string" || stationCode.trim() === "")
    || new Set(scope.map(({ stationCode }) => stationCode)).size !== scope.length) {
    throw new Error("retained Gwangju topology scope is invalid");
  }
  const orderedCodes = new Map(scope.map(({ stationCode }, index) => [stationCode, index]));
  const routes = new Map();
  for (const trip of projection.trips) {
    const { originStationName, destinationStationName } = trip.identity;
    const delta = orderedCodes.get(trip.stops[1].stationCode) - orderedCodes.get(trip.stops[0].stationCode);
    if (!Number.isInteger(delta) || Math.abs(delta) !== 1) throw new Error("unbound route direction");
    const directionId = delta > 0 ? "forward" : "reverse";
    const key = JSON.stringify([originStationName, destinationStationName, directionId]);
    const stationCodes = scope.map(({ stationCode }) => stationCode);
    if (delta < 0) stationCodes.reverse();
    routes.set(key, { originStationName, destinationStationName,
      routeId: `route-${routeNumber}-${sha256(key)}`, directionId,
      tripHeadsign: destinationStationName, stationCodes });
  }
  return [...routes.entries()].sort(([left], [right]) => utf16Compare(left, right)).map(([, route]) => route);
}

function topologyEdges(snapshot) {
  if (!Array.isArray(snapshot?.edges)) throw new Error("retained Gwangju topology edges are invalid");
  return snapshot.edges.map(({ fromStationCode, toStationCode }) => ({ fromStationCode, toStationCode }));
}

function seoulDate(instant) {
  const parts = Object.fromEntries(SEOUL_DATE_FORMATTER.formatToParts(new Date(instant))
    .map(({ type, value }) => [type, value]));
  return parts.year + parts.month + parts.day;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{8}$/u.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === iso;
}
function monthKey(date) { return Number(date.slice(0, 4)) * 12 + Number(date.slice(4, 6)) - 1; }
function utf16Compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
