import { createHash } from "node:crypto";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { buildKorailScheduleIds } from "./register-korail-timetable.mjs";

const SOURCE_ID = "korail-metropolitan-planned-timetable";
const SOURCE_FAMILY_ID = "korail-metropolitan-timetable-file";
const TABLE_KEYS = ["serviceCalendars", "serviceCalendarDates", "transitRoutes", "transitTrips", "transitStopTimes", "holidayCalendarSources"];
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** 현재 admission의 한 노선 시간표만 교체하고 다른 source의 행은 보존한다. */
export function materializeKorailTimetable({ pack, snapshot, inventory, ledger, now = new Date() } = {}) {
  const source = requiredSource(inventory, snapshot);
  validateSnapshot(snapshot, inventory, ledger, now);
  const result = structuredClone(pack);
  validatePack(result, snapshot.originalSelection.lineId);
  validateTables(snapshot.tables, snapshot.originalSelection.lineId);
  assertCanonicalStops(result, snapshot.tables, snapshot.originalSelection.lineId);
  const owned = ownedPartition(snapshot);
  assertForeignPartition(result, snapshot.originalSelection.lineId, owned);
  removeOwnedPartition(result, owned);
  assertNoCollisions(result, snapshot.tables);
  const provenance = { sourceId: SOURCE_ID, sourceSnapshotId: snapshot.snapshotId,
    providerRecordHash: snapshot.rowsSha256, provenanceKind: "OFFICIAL_SOURCE", verificationStatus: "VERIFIED",
    lastVerifiedAt: snapshot.originalCapturedAt, evidenceHash: snapshot.contentSha256 };
  result.sourceInventory = result.sourceInventory.filter(({ id }) => id !== SOURCE_ID);
  result.sourceInventory.push({ id: source.id, owner: source.owner, url: source.datasetUrl, license: source.license.name,
    licenseStatus: "redistributable", redistributionAllowed: true, updateFrequency: source.updateFrequency,
    updatedAt: snapshot.originalCapturedAt, fields: structuredClone(source.fieldsProvided), coverageScope: structuredClone(source.coverageScope) });
  result.serviceCalendars.push(...snapshot.tables.serviceCalendars.map((row) => ({ ...row, ...provenance })));
  result.serviceCalendarDates.push(...snapshot.tables.serviceCalendarDates.map((row) => ({ ...row, ...provenance })));
  result.transitRoutes.push(...snapshot.tables.transitRoutes.map((row) => ({ ...row, ...provenance })));
  result.transitTrips.push(...snapshot.tables.transitTrips.map((row) => ({ ...row, ...provenance })));
  result.transitStopTimes.push(...snapshot.tables.transitStopTimes.map((row) => ({ ...row, ...provenance })));
  result.minimumTableRows = { ...result.minimumTableRows,
    service_calendars: result.serviceCalendars.length, service_calendar_dates: result.serviceCalendarDates.length,
    transit_routes: result.transitRoutes.length, transit_trips: result.transitTrips.length,
    transit_stop_times: result.transitStopTimes.length };
  return result;
}

function requiredSource(inventory, snapshot) {
  const sources = inventory?.sources?.filter((entry) => entry?.id === SOURCE_ID) ?? [];
  const source = sources[0], evidence = source?.scheduleAdmissionEvidence;
  if (sources.length !== 1 || source.requiredForProductionPack !== true || source.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true || source.capabilities?.schedule?.productionUseAllowed !== true
    || !["service_calendar", "trip", "stop_time"].every((field) => source.fieldsProvided?.includes(field))
    || !source.coverageScope?.lineIds?.includes(snapshot?.originalSelection?.lineId)
    || evidence?.snapshotId !== snapshot?.snapshotId || evidence.contentSha256 !== snapshot?.contentSha256
    || evidence.tripsSha256 !== snapshot?.tripsSha256 || evidence.topologySourceId !== SOURCE_FAMILY_ID
    || evidence.topologySnapshotId !== snapshot?.topology?.snapshotId
    || evidence.topologyContentSha256 !== snapshot?.topology?.contentSha256
    || evidence.rawSha256 !== snapshot?.raw?.rawSha256 || evidence.freshUntil !== snapshot?.derivedFreshUntil
    || evidence.capturedAt !== snapshot?.originalCapturedAt || evidence.rowsSha256 !== snapshot?.rowsSha256
    || evidence.rowCount !== snapshot?.tables?.transitStopTimes?.length
    || evidence.stopTimeCount !== snapshot?.tables?.transitStopTimes?.length
    || evidence.tripCount !== snapshot?.tables?.transitTrips?.length
    || evidence.departureCount !== snapshot?.tables?.transitStopTimes?.filter(({ departureSeconds }) => Number.isSafeInteger(departureSeconds)).length) fail("SOURCE");
  return source;
}

function validateSnapshot(snapshot, inventory, ledger, now) {
  const { snapshotId, contentSha256, ...content } = snapshot ?? {};
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "korail-metropolitan-timetable-snapshot"
    || snapshot.sourceId !== SOURCE_ID || snapshot.sourceFamilyId !== SOURCE_FAMILY_ID
    || snapshot.snapshotId !== `${SOURCE_ID}-${snapshot.contentSha256}`
    || sha(canonicalJson(content)) !== snapshot.contentSha256 || !validInstant(snapshot.originalCapturedAt)
    || !validInstant(snapshot.derivedFreshUntil) || !validInstant(snapshot.serviceEffectiveAt)
    || !(snapshot.serviceEffectiveUntil === null || validInstant(snapshot.serviceEffectiveUntil))
    || Date.parse(snapshot.serviceEffectiveAt) > Date.parse(snapshot.derivedFreshUntil)
    || (snapshot.serviceEffectiveUntil !== null && Date.parse(snapshot.serviceEffectiveUntil) < Date.parse(snapshot.serviceEffectiveAt))
    || !validWindow(snapshot.calendarWindow) || !windowInsideEffective(snapshot) || !validTopology(snapshot.topology)
    || !validRaw(snapshot.raw) || !validCalendar(snapshot.calendar) || !validTablesHash(snapshot)) fail("SNAPSHOT");
  const rows = ledger?.filter((entry) => entry?.sourceId === SOURCE_ID) ?? [];
  const entry = rows.filter((row) => row.snapshotId === snapshot.snapshotId);
  if (entry.length !== 1 || entry[0].contentSha256 !== snapshot.contentSha256 || entry[0].rawSha256 !== snapshot.raw.rawSha256
    || entry[0].freshnessExpiresAt !== snapshot.derivedFreshUntil || entry[0].snapshotStatus !== "LOCKED"
    || entry[0].schemaStatus !== "PASS" || entry[0].licenseStatus !== "PASS" || entry[0].fetchStatus !== "SUCCESS"
    || entry[0].redistributionAllowed !== true || !(now instanceof Date) || Number.isNaN(now.valueOf())
    || now.valueOf() >= Date.parse(snapshot.derivedFreshUntil)) fail("LEDGER");
  validateParentAuthority(snapshot, inventory, ledger, now);
}

function validatePack(pack, lineId) {
  if (!pack || !Array.isArray(pack.sourceInventory) || !Array.isArray(pack.lines) || !Array.isArray(pack.stations)
    || !Array.isArray(pack.stationLines) || !["serviceCalendars", "serviceCalendarDates", "transitRoutes", "transitTrips", "transitStopTimes"].every((key) => Array.isArray(pack[key]))
    || pack.sourceInventory.filter(({ id }) => id === SOURCE_ID).length > 1
    || pack.lines.filter(({ id }) => id === lineId).length !== 1) fail("PACK");
}

function validateTables(tables, lineId) {
  if (!tables || JSON.stringify(Object.keys(tables).sort()) !== JSON.stringify([...TABLE_KEYS].sort())
    || TABLE_KEYS.some((key) => !Array.isArray(tables[key]))) fail("TABLES");
  const routeIds = new Set(), serviceIds = new Set(), tripIds = new Set(), calendarDateKeys = new Set();
  for (const row of tables.serviceCalendars) {
    if (!text(row.serviceId) || serviceIds.has(row.serviceId) || !validWindow({ startDate: row.startDate, endDate: row.endDate })) fail("TABLES");
    serviceIds.add(row.serviceId);
  }
  for (const row of tables.serviceCalendarDates) {
    const key = `${row.serviceId}:${row.date}`;
    if (!serviceIds.has(row.serviceId) || !validDate(row.date) || ![1, 2].includes(row.exceptionType) || calendarDateKeys.has(key)) fail("TABLES");
    calendarDateKeys.add(key);
  }
  for (const row of tables.transitRoutes) {
    if (!text(row.id) || routeIds.has(row.id) || row.lineId !== lineId) fail("TABLES"); routeIds.add(row.id);
  }
  for (const row of tables.transitTrips) {
    if (!text(row.id) || tripIds.has(row.id) || !routeIds.has(row.routeId) || !serviceIds.has(row.serviceId)) fail("TABLES"); tripIds.add(row.id);
  }
  const stopsByTrip = new Map();
  for (const row of tables.transitStopTimes) {
    if (!tripIds.has(row.tripId) || row.lineId !== lineId || !text(row.stationId) || !Number.isSafeInteger(row.stopSequence) || row.stopSequence < 1
      || !Number.isSafeInteger(row.arrivalSeconds) || !Number.isSafeInteger(row.departureSeconds) || row.arrivalSeconds > row.departureSeconds) fail("TABLES");
    if (!stopsByTrip.has(row.tripId)) stopsByTrip.set(row.tripId, []); stopsByTrip.get(row.tripId).push(row);
  }
  if (stopsByTrip.size !== tripIds.size) fail("TABLES");
  for (const rows of stopsByTrip.values()) {
    const ordered = [...rows].sort((a, b) => a.stopSequence - b.stopSequence);
    if (ordered.some((row, index) => row.stopSequence !== index + 1 || (index && ordered[index - 1].departureSeconds > row.arrivalSeconds))) fail("TABLES");
  }
}

function assertNoCollisions(pack, tables) {
  const existing = new Set([
    ...pack.serviceCalendars.map(({ serviceId }) => `service:${serviceId}`),
    ...pack.serviceCalendarDates.map(({ serviceId, date }) => `calendar-date:${serviceId}:${date}`),
    ...pack.transitRoutes.map(({ id }) => `route:${id}`),
    ...pack.transitTrips.map(({ id }) => `trip:${id}`),
    ...pack.transitStopTimes.map(({ tripId, stopSequence }) => `stop:${tripId}:${stopSequence}`),
  ]);
  const generated = [
    ...tables.serviceCalendars.map(({ serviceId }) => `service:${serviceId}`),
    ...tables.serviceCalendarDates.map(({ serviceId, date }) => `calendar-date:${serviceId}:${date}`),
    ...tables.transitRoutes.map(({ id }) => `route:${id}`),
    ...tables.transitTrips.map(({ id }) => `trip:${id}`),
    ...tables.transitStopTimes.map(({ tripId, stopSequence }) => `stop:${tripId}:${stopSequence}`),
  ];
  if (generated.some((key) => existing.has(key)) || new Set(generated).size !== generated.length) fail("COLLISION");
}

function ownedPartition(snapshot) {
  const ids = buildKorailScheduleIds({ lineId: snapshot.originalSelection.lineId });
  const routeIds = new Set(Object.values(ids.routes)), serviceIds = new Set(Object.values(ids.services));
  if (snapshot.tables.transitRoutes.some(({ id }) => !routeIds.has(id))
    || snapshot.tables.serviceCalendars.some(({ serviceId }) => !serviceIds.has(serviceId))) fail("TABLES");
  return { routeIds, serviceIds };
}

function assertForeignPartition(pack, lineId, owned) {
  if (pack.transitRoutes.some(({ id, lineId: existingLineId }) => existingLineId === lineId && !owned.routeIds.has(id))) fail("SOURCE_PARTITION_CONFLICT");
  if (pack.transitTrips.some(({ routeId, serviceId }) => !owned.routeIds.has(routeId) && owned.serviceIds.has(serviceId))) fail("SOURCE_PARTITION_CONFLICT");
}

function removeOwnedPartition(pack, owned) {
  const removedTripIds = new Set(pack.transitTrips.filter(({ routeId }) => owned.routeIds.has(routeId)).map(({ id }) => id));
  pack.transitRoutes = pack.transitRoutes.filter(({ id }) => !owned.routeIds.has(id));
  pack.transitTrips = pack.transitTrips.filter(({ id }) => !removedTripIds.has(id));
  pack.transitStopTimes = pack.transitStopTimes.filter(({ tripId }) => !removedTripIds.has(tripId));
  pack.serviceCalendars = pack.serviceCalendars.filter(({ serviceId }) => !owned.serviceIds.has(serviceId));
  pack.serviceCalendarDates = pack.serviceCalendarDates.filter(({ serviceId }) => !owned.serviceIds.has(serviceId));
}

function validateParentAuthority(snapshot, inventory, ledger, now) {
  const parentSource = inventory?.sources?.filter(({ id }) => id === SOURCE_FAMILY_ID) ?? [];
  const parentLedger = ledger?.filter(({ sourceId, snapshotId }) => sourceId === SOURCE_FAMILY_ID && snapshotId === snapshot.topology.snapshotId) ?? [];
  const evidence = parentSource[0]?.topologyAdmissionEvidence;
  if (parentSource.length !== 1 || parentLedger.length !== 1 || evidence?.snapshotId !== snapshot.topology.snapshotId
    || evidence.contentSha256 !== snapshot.topology.contentSha256 || !parentSource[0].coverageScope?.lineIds?.includes(snapshot.originalSelection.lineId)
    || parentLedger[0].contentSha256 !== snapshot.topology.contentSha256 || parentLedger[0].rawSha256 !== snapshot.raw.rawSha256
    || parentLedger[0].rawObjectSha256 !== snapshot.raw.rawSha256 || parentLedger[0].rawObjectUri !== snapshot.raw.rawObjectUri
    || parentLedger[0].rawReceiptSha256 !== snapshot.raw.publicationReceiptSha256 || parentLedger[0].byteSize !== snapshot.raw.byteSize
    || parentLedger[0].capturedAt !== snapshot.originalCapturedAt || parentLedger[0].retrievedAt !== snapshot.originalCapturedAt
    || !validInstant(parentLedger[0].rawRetentionExpiresAt) || now.valueOf() >= Date.parse(parentLedger[0].rawRetentionExpiresAt)) fail("PARENT");
}

function assertCanonicalStops(pack, tables, lineId) {
  const stationIds = new Set(pack.stations.map(({ id }) => id));
  const membership = new Map();
  for (const row of pack.stationLines.filter((row) => row.lineId === lineId)) {
    if (!text(row.stationId) || membership.has(row.stationId)) fail("TABLES");
    membership.set(row.stationId, row);
  }
  for (const row of tables.transitStopTimes) {
    if (!stationIds.has(row.stationId) || !membership.has(row.stationId)) fail("TABLES");
  }
}

function validTablesHash(snapshot) { return /^[a-f0-9]{64}$/u.test(snapshot.rowsSha256 ?? "") && /^[a-f0-9]{64}$/u.test(snapshot.tripsSha256 ?? "") && snapshot.rowsSha256 === sha(canonicalJson(snapshot.tables)) && snapshot.tripsSha256 === sha(canonicalJson({ transitTrips: snapshot.tables?.transitTrips, transitStopTimes: snapshot.tables?.transitStopTimes })); }
function validTopology(value) { return value?.sourceId === SOURCE_FAMILY_ID && text(value.snapshotId) && hash(value.contentSha256); }
function validRaw(value) { return value?.sourceId === SOURCE_FAMILY_ID && hash(value.rawSha256) && Number.isSafeInteger(value.byteSize) && value.byteSize > 0 && hash(value.collectionReceiptSha256) && hash(value.publicationReceiptSha256) && /^oci:\/\//u.test(value.rawObjectUri ?? ""); }
function validCalendar(value) { return hash(value?.manifestSha256) && Array.isArray(value.months) && value.months.length > 0 && value.months.every((month) => Number.isSafeInteger(month.year) && Number.isSafeInteger(month.month) && month.month >= 1 && month.month <= 12 && hash(month.sha256)); }
function validWindow(value) { return validDate(value?.startDate) && validDate(value?.endDate) && value.startDate <= value.endDate; }
function windowInsideEffective(snapshot) { const start = serviceDayStart(snapshot.calendarWindow.startDate), end = serviceDayEnd(snapshot.calendarWindow.endDate); return Date.parse(snapshot.serviceEffectiveAt) <= Date.parse(start) && (snapshot.serviceEffectiveUntil === null || Date.parse(snapshot.serviceEffectiveUntil) >= Date.parse(end)); }
function serviceDayStart(value) { return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000+09:00`; }
function serviceDayEnd(value) { return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T23:59:59.999+09:00`; }
function validDate(value) { if (!/^\d{8}$/u.test(value ?? "")) return false; const day = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, instant = `${day}T00:00:00.000Z`; return Number.isFinite(Date.parse(instant)) && new Date(instant).toISOString().slice(0, 10) === day; }
function validInstant(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function hash(value) { return /^[a-f0-9]{64}$/u.test(value ?? ""); }
function text(value) { return typeof value === "string" && value.length > 0; }
function fail(code) { throw new Error(`KORAIL_TIMETABLE_MATERIALIZER_${code}`); }
