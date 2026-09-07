import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMainModule } from "../lib/is-main-module.mjs";

import { parseRetainedKasiHolidayMonth, readKasiHolidayCalendarFiles } from "./fetch-kasi-public-holiday-calendar.mjs";
import { buildRetainedGwangjuServiceCalendars, projectRetainedGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { prepareRetainedKricTimetablePublication } from "./prepare-retained-kric-timetable-publication.mjs";
import { parseMolitGwangjuStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { selectRetainedKricTimetable } from "./build-kric-retained-file-pending-handoff.mjs";

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

// workflow는 보관 입력의 위치만 넘긴다. candidate와 topology는 실행 checkout의 inventory에서 선택한다.
export async function runRetainedGwangjuContractPreparation(argv, {
  repositoryRoot = path.resolve(import.meta.dirname, "../.."), now = new Date(),
} = {}) {
  if (argv.length !== 4 || argv[0] !== "--input" || argv[2] !== "--output"
    || !path.isAbsolute(argv[1]) || !path.isAbsolute(argv[3])) {
    throw new Error("usage: --input <absolute.json> --output <new-absolute.json>");
  }
  const readJson = async file => JSON.parse(await readFile(file, "utf8"));
  const input = await readJson(argv[1]);
  const keys = ["observationPath", "receiptPath", "canonicalStationMappingsPath", "holidayDirectory", "providerValidUntil"];
  if (!input || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(keys.sort())
    || keys.filter(key => key.endsWith("Path") || key.endsWith("Directory")).some(key => !path.isAbsolute(input[key] ?? ""))) {
    throw new Error("retained Gwangju preparation input is invalid");
  }
  const candidates = await readJson(path.join(repositoryRoot, "tools/datapack/source-candidates.json"));
  const candidate = candidates.candidates.find(row => row.id === "kric-nationwide-timetable-file");
  const inventory = await readJson(path.join(repositoryRoot, "tools/datapack/source-inventory.json"));
  const evidence = inventory.sources.find(row => row.id === "gwangju-transportation-route-topology")?.topologyAdmissionEvidence;
  if (!evidence || !/^gwangju-transportation-route-topology-[A-Za-z0-9-]+$/u.test(evidence.snapshotId ?? "")
    || evidence.snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`) {
    throw new Error("retained Gwangju topology selection is invalid");
  }
  const topologySnapshot = await readJson(path.join(repositoryRoot, evidence.snapshotPath));
  const observationBytes = await readFile(input.observationPath);
  const receipt = await readJson(input.receiptPath);
  const routePolicy = retainedRoutePolicy(candidate);
  const { records } = selectRetainedKricTimetable({
    observation: JSON.parse(observationBytes.toString("utf8")), receipt, routeNumber: routePolicy.routeNumber,
  });
  const canonicalMappings = parseMolitGwangjuStationMappings(
    await readFile(input.canonicalStationMappingsPath), topologySnapshot,
  );
  const stationBindings = deriveStationBindings({ records, canonicalMappings, routePolicy });
  const result = prepareRetainedGwangjuContract({ candidate, observationBytes,
    receipt, routeNumber: routePolicy.routeNumber,
    stationBindings, excludedEndpointLabels: routePolicy.excludedEndpointLabels,
    topologySnapshot,
    holidayCalendar: await readKasiHolidayCalendarFiles(input.holidayDirectory),
    evaluationAt: now.toISOString(), providerValidUntil: input.providerValidUntil });
  await writeFile(argv[3], `${JSON.stringify(result.contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { contractSha256: result.contractSha256 };
}

function retainedRoutePolicy(candidate) {
  const policy = candidate?.retainedRoutePolicy;
  const aliases = policy?.stationAliases;
  if (!policy || JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify([
    "excludedEndpointLabels", "routeNumber", "stationAliases",
  ]) || typeof policy.routeNumber !== "string" || policy.routeNumber.trim() === ""
    || !aliases || typeof aliases !== "object" || Array.isArray(aliases)
    || !Array.isArray(policy.excludedEndpointLabels)) {
    throw new Error("retained Gwangju route policy is invalid");
  }
  const aliasEntries = Object.entries(aliases);
  if (aliasEntries.length === 0 || aliasEntries.some(([label, stationName]) =>
    typeof label !== "string" || label.trim() === "" || typeof stationName !== "string" || stationName.trim() === "")
    || policy.excludedEndpointLabels.some((label) => typeof label !== "string" || label.trim() === "")
    || new Set(policy.excludedEndpointLabels).size !== policy.excludedEndpointLabels.length) {
    throw new Error("retained Gwangju route policy is invalid");
  }
  if (new Set(aliasEntries.map(([, stationName]) => stationName)).size !== aliasEntries.length) {
    throw new Error("retained Gwangju route policy has duplicate aliases");
  }
  return policy;
}

function deriveStationBindings({ records, canonicalMappings, routePolicy }) {
  const labels = new Set(records.map(({ stationName }) => stationName));
  const canonicalByName = new Map();
  for (const mapping of canonicalMappings) {
    const matches = canonicalByName.get(mapping.stationName) ?? [];
    matches.push(mapping);
    canonicalByName.set(mapping.stationName, matches);
  }
  const aliases = new Map(Object.entries(routePolicy.stationAliases));
  const bindings = [];
  for (const label of labels) {
    if (routePolicy.excludedEndpointLabels.includes(label)) {
      if (canonicalByName.has(label) || aliases.has(label)) {
        throw new Error(`retained Gwangju excluded endpoint overlaps passenger station: ${label}`);
      }
      continue;
    }
    const canonicalName = aliases.get(label) ?? label;
    const matches = canonicalByName.get(canonicalName) ?? [];
    if (matches.length !== 1) throw new Error(`retained Gwangju station mapping is ambiguous: ${label}`);
    if (routePolicy.excludedEndpointLabels.includes(label) || routePolicy.excludedEndpointLabels.includes(canonicalName)) {
      throw new Error(`retained Gwangju excluded endpoint overlaps passenger station: ${label}`);
    }
    bindings.push({ sourceLabel: label, stationId: matches[0].stationId, stationCode: matches[0].stationNumber });
  }
  if (new Set(bindings.map(({ stationId }) => stationId)).size !== bindings.length) {
    throw new Error("retained Gwangju route policy has duplicate aliases");
  }
  return bindings.sort((left, right) => utf16Compare(left.sourceLabel, right.sourceLabel));
}

if (isMainModule(import.meta.url)) {
  try { console.log(JSON.stringify(await runRetainedGwangjuContractPreparation(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
