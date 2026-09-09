#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseMolitGwangjuStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { selectRetainedKricTimetable } from "./build-kric-retained-file-pending-handoff.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";
const TOPOLOGY_SOURCE_ID = "gwangju-transportation-route-topology";
const MEMBERSHIP_SOURCE_ID = "molit-urban-rail-full-route-gwangju-membership";
const MEMBERSHIP_RAW_SOURCE_ID = "molit-urban-rail-full-route";
const OPERATOR_ID = "gwangju-metropolitan-rapid-transit";
const LINE_ID = "line-e57a361e8892";
export const GWANGJU_LINES = Object.freeze([
  Object.freeze({ lineNumber: 1, lineId: LINE_ID }),
]);
const PACK_ID = "nationwide-gwangju-schedule";
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;

export function materializeGwangjuTimetable({
  baseFixture,
  retainedTimetable,
  topologySnapshot,
  inventory,
  canonicalStationMappings,
}) {
  validateTopologySnapshot(topologySnapshot);
  const retained = validateRetainedTimetable(retainedTimetable, topologySnapshot, canonicalStationMappings);
  const sources = requiredSources(inventory, retained, topologySnapshot, canonicalStationMappings);
  const fixture = structuredClone(baseFixture);
  const pack = fixture.packs?.[0];
  if (!pack || fixture.packs.length !== 1 || pack.artifactKind !== "production") {
    throw new Error("Gwangju timetable requires one cumulative production pack");
  }
  for (const id of [SOURCE_ID, TOPOLOGY_SOURCE_ID, MEMBERSHIP_SOURCE_ID]) {
    if (pack.sourceInventory.some((source) => source.id === id)) throw new Error(`${id} already exists`);
  }
  const generatedTopology = { stations: [], stationLines: [], networkEdges: [] };
  addStationsAndTopology(generatedTopology, topologySnapshot, canonicalStationMappings, sources);
  bindCumulativeGwangjuTopology(pack, generatedTopology);

  pack.sourceInventory.push(
    packSource(sources.membership, sources.membership.membershipAdmissionEvidence.verifiedAt),
    packSource(sources.topology, topologySnapshot.capturedAt),
    packSource(sources.timetable, retained.projection.source.observedAt),
  );
  if (!pack.operators.some(({ id }) => id === OPERATOR_ID)) {
    pack.operators.push({ id: OPERATOR_ID, nameKo: "광주교통공사", nameEn: "" });
  }
  if (!pack.lines.some(({ id }) => id === LINE_ID)) {
    pack.lines.push({ id: LINE_ID, operatorId: OPERATOR_ID, nameKo: "광주 1호선", nameEn: "", color: "#009088" });
  }
  const scheduleProvenance = provenanceForRetainedSchedule(sources.timetable, retained.projection, retained.retainedContractSha256);
  const tables = buildRetainedGwangjuTransitTables({ projection: retained.projection, lineId: LINE_ID,
    routeBindings: retainedTimetable.routeBindings, serviceIds: retainedTimetable.serviceIds,
    servicePatterns: retainedTimetable.servicePatterns, serviceDayStartSeconds: retainedTimetable.serviceDayStartSeconds,
    provenance: scheduleProvenance });
  const calendars = buildRetainedGwangjuServiceCalendars({ ...retainedTimetable.calendar,
    serviceIds: retainedTimetable.serviceIds,
    publicHolidayDates: new Set(retainedTimetable.calendar.publicHolidayDates) });
  addRetainedRoutes(pack, retainedTimetable.routeBindings, scheduleProvenance);
  pack.transitTrips.push(...tables.transitTrips);
  pack.transitStopTimes.push(...tables.transitStopTimes);
  pack.serviceCalendars.push(...calendars.serviceCalendars.map((row) => withProvenance(row, scheduleProvenance)));
  pack.serviceCalendarDates.push(...calendars.serviceCalendarDates.map((row) => withProvenance(row, scheduleProvenance, "GENERATED")));

  pack.minimumTableRows = {
    ...pack.minimumTableRows,
    stations: pack.stations.length,
    station_lines: pack.stationLines.length,
    network_edges: pack.networkEdges.length,
    service_calendars: pack.serviceCalendars.length,
    service_calendar_dates: pack.serviceCalendarDates.length,
    transit_routes: pack.transitRoutes.length,
    transit_trips: pack.transitTrips.length,
    transit_stop_times: pack.transitStopTimes.length,
    transit_feed_info: pack.transitFeedInfo.length,
  };
  const version = compactSeoulDate(retained.projection.source.observedAt);
  const composition = sha256(JSON.stringify({
    previousPackId: pack.id,
    timetableSnapshotId: sources.timetable.retainedScheduleAdmissionEvidence.snapshotId,
    topologySnapshotId: sources.topology.topologyAdmissionEvidence.snapshotId,
    timetableRowsSha256: retained.projection.source.recordsSha256,
    topologyContentSha256: topologySnapshot.contentSha256,
    sourceEvidence: sources,
    packContentSha256: materializedPackContentHash(pack, version),
  }));
  pack.id = `${PACK_ID}-${composition}`;
  pack.version = version;
  pack.url = `https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/${pack.id}-v${version}.sqlite.gz`;
  fixture.manifest.activePack = { id: pack.id, version };
  return fixture;
}

export function buildRetainedGwangjuServiceCalendars({
  startDate, endDate, serviceIds, publicHolidayDates,
}) {
  validateCalendarInput({ startDate, endDate, serviceIds, publicHolidayDates });
  const baseByDay = ["명절", "평일", "평일", "평일", "평일", "평일", "명절"];
  // 승인된 주말 선택 규칙이다. 서로 다른 원문 서비스 ID는 보존하되 중복 활성화하지 않는다.
  const serviceCalendars = [
    calendar(serviceIds["평일"], startDate, endDate, [true, true, true, true, true, false, false]),
    calendar(serviceIds["토요일"], startDate, endDate, [false, false, false, false, false, false, false]),
    calendar(serviceIds["휴일"], startDate, endDate, [false, false, false, false, false, false, false]),
    calendar(serviceIds["명절"], startDate, endDate, [false, false, false, false, false, true, true]),
  ];
  const serviceCalendarDates = [];
  for (const date of [...publicHolidayDates].sort(utf16Compare)) {
    if (date < startDate || date > endDate) continue;
    const ordinary = baseByDay[utcDay(date)];
    const selected = "명절";
    if (ordinary !== selected) {
      serviceCalendarDates.push({ serviceId: serviceIds[ordinary], date, exceptionType: 2 });
      serviceCalendarDates.push({ serviceId: serviceIds[selected], date, exceptionType: 1 });
    }
  }
  return { serviceCalendars, serviceCalendarDates };
}

function validateCalendarInput({ startDate, endDate, serviceIds, publicHolidayDates }) {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate
    || !(publicHolidayDates instanceof Set)
    || !serviceIds || JSON.stringify(Object.keys(serviceIds).sort(utf16Compare)) !== JSON.stringify(["평일", "토요일", "휴일", "명절"].sort(utf16Compare))
    || Object.values(serviceIds).some((value) => typeof value !== "string" || value.trim() === "")
    || new Set(Object.values(serviceIds)).size !== 4
    || [...publicHolidayDates].some((date) => !validDate(date))) {
    throw new Error("retained Gwangju service calendar input is invalid");
  }
}

function calendar(serviceId, startDate, endDate, [monday, tuesday, wednesday, thursday, friday, saturday, sunday]) {
  return { serviceId, monday, tuesday, wednesday, thursday, friday, saturday, sunday, startDate, endDate, timezone: "Asia/Seoul" };
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{8}$/u.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === iso;
}
function utcDay(date) { return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`).getUTCDay(); }
function utf16Compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

const RETAINED_TRIP_GROUP_FIELDS = Object.freeze([
  "trainNumber", "routeNumber", "routeName", "originStationName", "destinationStationName",
  "serviceType", "weekdayType",
]);

/** 수집 근거와 행 투영을 결속한다. 운영 admission과 달력 승인을 대신하지 않는다. */
export function projectRetainedGwangjuTimetable({
  observation, receipt, routeNumber, stationBindings, directedEdges, excludedEndpointLabels,
}) {
  const { summary, records } = selectRetainedKricTimetable({ observation, receipt, routeNumber });
  return { source: summary, ...projectRetainedGwangjuTrips({
    records, stationBindings, directedEdges, excludedEndpointLabels,
  }) };
}

export function projectRetainedGwangjuTrips({
  records, stationBindings, directedEdges, excludedEndpointLabels,
}) {
  validateRetainedTripInput(records, stationBindings, directedEdges, excludedEndpointLabels);
  const context = retainedTripContext(stationBindings, directedEdges, excludedEndpointLabels);
  const groups = groupedRetainedRecords(records);
  const trips = [], nonRoutableGroups = [];
  for (const group of groups.values()) addProjectedRetainedGroup(group, context, trips, nonRoutableGroups);
  return { trips, nonRoutableGroups };
}

function validateRetainedTripInput(records, stationBindings, directedEdges, excludedEndpointLabels) {
  if (!Array.isArray(records) || !Array.isArray(stationBindings) || !Array.isArray(directedEdges)
    || !Array.isArray(excludedEndpointLabels) || excludedEndpointLabels.some((label) => typeof label !== "string")) {
    throw new Error("retained Gwangju trip input is invalid");
  }
}

function retainedTripContext(stationBindings, directedEdges, excludedEndpointLabels) {
  const bindings = retainedStationBindings(stationBindings);
  const edges = retainedDirectedEdges(directedEdges);
  const excluded = new Set(excludedEndpointLabels);
  if ([...excluded].some((label) => bindings.has(label))) {
    throw new Error("retained Gwangju endpoint classification is ambiguous");
  }
  return { bindings, edges, excluded };
}

function retainedStationBindings(stationBindings) {
  const bindings = new Map();
  for (const binding of stationBindings) {
    if (!binding || typeof binding.sourceLabel !== "string" || binding.sourceLabel.trim() === ""
      || typeof binding.stationId !== "string" || binding.stationId.trim() === ""
      || typeof binding.stationCode !== "string" || binding.stationCode.trim() === ""
      || bindings.has(binding.sourceLabel)) {
      throw new Error("retained Gwangju station bindings are ambiguous");
    }
    bindings.set(binding.sourceLabel, binding);
  }
  return bindings;
}

function retainedDirectedEdges(directedEdges) {
  const edges = new Set();
  for (const edge of directedEdges) {
    if (!edge || typeof edge.fromStationCode !== "string" || edge.fromStationCode.trim() === ""
      || typeof edge.toStationCode !== "string" || edge.toStationCode.trim() === "") {
      throw new Error("retained Gwangju directed edge is invalid");
    }
    edges.add(`${edge.fromStationCode}:${edge.toStationCode}`);
  }
  return edges;
}

function groupedRetainedRecords(records) {
  const ordered = records.map((record) => retainedNativeRecord(record)).sort((left, right) =>
    left.sourceRowNumber - right.sourceRowNumber);
  for (const [index, record] of ordered.entries()) {
    if (index > 0 && record.sourceRowNumber === ordered[index - 1].sourceRowNumber) {
      throw new Error("retained Gwangju source row order is ambiguous");
    }
  }
  const groups = new Map();
  const seenGroups = new Set();
  let previousGroupKey;
  for (const record of ordered) {
    const key = JSON.stringify(RETAINED_TRIP_GROUP_FIELDS.map((field) => record[field]));
    if (key !== previousGroupKey) {
      if (seenGroups.has(key)) throw new Error("retained Gwangju trip group is discontiguous");
      seenGroups.add(key);
      groups.set(key, { identity: retainedTripIdentity(record), records: [] });
      previousGroupKey = key;
    }
    groups.get(key).records.push(record);
  }
  return groups;
}

function addProjectedRetainedGroup(group, context, trips, nonRoutableGroups) {
  const nativeRows = group.records.map((record) => projectRetainedNativeRow(record));
  validateRetainedNativeRowTimes(nativeRows);
  const { stops, excludedEndpoints } = partitionRetainedTripRows(nativeRows, context);
  validateRetainedStops(stops, context.edges);
  const projection = { identity: group.identity, records: nativeRows, excludedEndpoints };
  // 승객 정류장이 둘 미만인 원문 그룹은 누락시키지 않고 비운행 근거로 남긴다.
  if (stops.length < 2) {
    nonRoutableGroups.push({ ...projection, reason: "PASSENGER_STOP_COUNT_LT_2" });
  } else {
    trips.push({ ...projection, stops });
  }
}

function validateRetainedNativeRowTimes(nativeRows) {
  for (const [index, row] of nativeRows.entries()) {
    if (row.arrival.seconds > row.departure.seconds) {
      throw new Error("retained Gwangju trip arrival is after departure");
    }
    if (index > 0 && nativeRows[index - 1].departure.seconds > row.arrival.seconds) {
      throw new Error("retained Gwangju trip time order is invalid");
    }
  }
}

function partitionRetainedTripRows(nativeRows, { bindings, excluded }) {
  const passengerIndexes = nativeRows.flatMap((row, index) =>
    bindings.has(row.record.stationName) ? [index] : []);
  const firstPassenger = passengerIndexes[0], lastPassenger = passengerIndexes.at(-1);
  const excludedEndpoints = [];
  for (const [index, row] of nativeRows.entries()) {
    if (bindings.has(row.record.stationName)) continue;
    if (!excluded.has(row.record.stationName)) throw new Error("retained Gwangju trip station binding is missing");
    if (firstPassenger !== undefined && index > firstPassenger && index < lastPassenger) {
      throw new Error("retained Gwangju trip endpoint exclusion is interior");
    }
    excludedEndpoints.push(row);
  }
  const stops = nativeRows.filter((row) => bindings.has(row.record.stationName)).map((row) => ({
      ...row,
      stationId: bindings.get(row.record.stationName).stationId,
      stationCode: bindings.get(row.record.stationName).stationCode,
  }));
  return { stops, excludedEndpoints };
}

function validateRetainedStops(stops, edges) {
  const stationIds = new Set();
  for (const stop of stops) {
    if (stationIds.has(stop.stationId)) throw new Error("retained Gwangju trip station repeats");
    stationIds.add(stop.stationId);
  }
  for (const [index, stop] of stops.entries()) {
    if (index > 0 && !edges.has(`${stops[index - 1].stationCode}:${stop.stationCode}`)) {
      throw new Error("retained Gwangju trip directed edge is missing");
    }
  }
}

/** native projection의 순서와 원문 행 근거를 바꾸지 않고 transit 표 행으로 옮긴다. */
export function buildRetainedGwangjuTransitTables({
  projection, lineId, routeBindings, serviceIds, servicePatterns, serviceDayStartSeconds, provenance,
}) {
  validateRetainedTransitTableInput({ projection, lineId, routeBindings, serviceIds, servicePatterns, serviceDayStartSeconds, provenance });
  const routes = routeBindingsByEndpoint(routeBindings);
  const transitTrips = [], transitStopTimes = [], tripIds = new Set();
  for (const trip of projection.trips) {
    addRetainedTransitTrip({ trip, routes, serviceIds, servicePatterns, lineId, serviceDayStartSeconds, provenance,
      tripIds, transitTrips, transitStopTimes });
  }
  return { transitTrips, transitStopTimes };
}

function validateRetainedTransitTableInput({
  projection, lineId, routeBindings, serviceIds, servicePatterns, serviceDayStartSeconds, provenance,
}) {
  if (!projection || !Array.isArray(projection.trips) || !Array.isArray(projection.nonRoutableGroups)
    || typeof lineId !== "string" || lineId.trim() === "" || !Number.isSafeInteger(serviceDayStartSeconds)
    || serviceDayStartSeconds < 0 || !Array.isArray(routeBindings) || !serviceIds || !servicePatterns
    || !validProvenance(provenance)) throw new Error("retained Gwangju transit table input is invalid");
}

function addRetainedTransitTrip({
  trip, routes, serviceIds, servicePatterns, lineId, serviceDayStartSeconds, provenance,
  tripIds, transitTrips, transitStopTimes,
}) {
  const { identity, route, serviceId, servicePattern } = retainedTransitMapping(trip, routes, serviceIds, servicePatterns);
  if (!Array.isArray(trip.records) || !Array.isArray(trip.stops) || trip.stops.length < 2) {
    throw new Error("retained Gwangju projected trip is invalid");
  }
  const id = retainedTransitTripId(lineId, identity, tripIds);
  const providerRecordHash = sha256(JSON.stringify(trip.records.map((row) => row.sourceRowSha256)));
  transitTrips.push(withProvenance({ id, routeId: route.routeId, serviceId, tripHeadsign: route.tripHeadsign,
    directionId: route.directionId, trainNo: identity.trainNumber, servicePattern, serviceClass: "SUBWAY",
    serviceDayStartSeconds }, { ...provenance, providerRecordHash }));
  addRetainedTransitStopTimes(trip.stops, id, lineId, provenance, transitStopTimes);
}

function retainedTransitMapping(trip, routes, serviceIds, servicePatterns) {
  const identity = trip?.identity;
  if (!identity || RETAINED_TRIP_GROUP_FIELDS.some((field) => typeof identity[field] !== "string" || identity[field].trim() === "")) {
    throw new Error("retained Gwangju trip identity is invalid");
  }
  const candidates = routes.get(JSON.stringify([identity.originStationName, identity.destinationStationName])) ?? [];
  const route = candidates.filter((binding) => bindingContainsTripStops(binding, trip.stops));
  const serviceId = serviceIds[identity.weekdayType], servicePattern = servicePatterns[identity.serviceType];
  if (route.length === 0 || typeof serviceId !== "string" || serviceId.trim() === "" || !["LOCAL", "EXPRESS"].includes(servicePattern)) {
    throw new Error("retained Gwangju trip mapping is missing");
  }
  if (route.length > 1) throw new Error("retained Gwangju trip route binding is ambiguous");
  return { identity, route: route[0], serviceId, servicePattern };
}

function retainedTransitTripId(lineId, identity, tripIds) {
  const nativeIdentity = [lineId, ...RETAINED_TRIP_GROUP_FIELDS.map((field) => identity[field])];
  const id = `trip-gwangju-${sha256(JSON.stringify(nativeIdentity))}`;
  if (tripIds.has(id)) throw new Error("retained Gwangju trip identity is duplicate");
  tripIds.add(id);
  return id;
}

function addRetainedTransitStopTimes(stops, tripId, lineId, provenance, transitStopTimes) {
  for (const [index, stop] of stops.entries()) {
    if (!stop?.record || !/^[a-f0-9]{64}$/u.test(stop.record.sourceRowSha256 ?? "")) throw new Error("retained Gwangju stop evidence is invalid");
    transitStopTimes.push(withProvenance({ tripId, stopSequence: index + 1, stationId: stop.stationId,
      lineId, arrivalSeconds: stop.arrival.seconds, departureSeconds: stop.departure.seconds,
      pickupType: index === stops.length - 1 ? 1 : 0, dropOffType: index === 0 ? 1 : 0 },
    { ...provenance, providerRecordHash: stop.record.sourceRowSha256 }));
  }
}

function routeBindingsByEndpoint(routeBindings, directedEdges) {
  const routes = new Map(), routeIds = new Set(), bindings = new Set();
  for (const binding of routeBindings) {
    if (!binding || [binding.originStationName, binding.destinationStationName, binding.routeId, binding.directionId, binding.tripHeadsign]
      .some((value) => typeof value !== "string" || value.trim() === "")
      || !Array.isArray(binding.stationCodes) || binding.stationCodes.length < 2
      || binding.stationCodes.some((code) => typeof code !== "string" || code.trim() === "")
      || new Set(binding.stationCodes).size !== binding.stationCodes.length) {
      throw new Error("retained Gwangju route binding is invalid");
    }
    if (routeIds.has(binding.routeId)) throw new Error("retained Gwangju route binding routeId is ambiguous");
    const identity = JSON.stringify([binding.originStationName, binding.destinationStationName, binding.routeId,
      binding.directionId, binding.tripHeadsign, binding.stationCodes]);
    if (bindings.has(identity)) throw new Error("retained Gwangju route binding is ambiguous");
    if (directedEdges && binding.stationCodes.some((code, index) => index > 0
      && !directedEdges.has(`${binding.stationCodes[index - 1]}:${code}`))) {
      throw new Error("retained Gwangju route binding directed edge is missing");
    }
    routeIds.add(binding.routeId);
    bindings.add(identity);
    const endpoint = JSON.stringify([binding.originStationName, binding.destinationStationName]);
    const grouped = routes.get(endpoint) ?? [];
    grouped.push(binding);
    routes.set(endpoint, grouped);
  }
  return routes;
}

function bindingContainsTripStops(binding, stops) {
  const stopCodes = stops.map(({ stationCode }) => stationCode);
  return binding.stationCodes.some((code, index) => code === stopCodes[0]
    && stopCodes.every((stopCode, offset) => binding.stationCodes[index + offset] === stopCode));
}

function validProvenance(value) {
  return value && [value.sourceId, value.sourceSnapshotId, value.evidenceHash, value.updatedAt]
    .every((entry) => typeof entry === "string" && entry.trim() !== "");
}

function retainedNativeRecord(record) {
  if (!record || typeof record !== "object" || record.routeNumber !== "S2901"
    || !Number.isSafeInteger(record.sourceRowNumber) || record.sourceRowNumber <= 0
    || !/^[a-f0-9]{64}$/u.test(record.sourceRowSha256 ?? "")) {
    throw new Error("retained Gwangju native record is invalid");
  }
  for (const field of [...RETAINED_TRIP_GROUP_FIELDS, "stationName"]) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      throw new Error(`retained Gwangju native record ${field} is invalid`);
    }
  }
  return record;
}

function retainedTripIdentity(record) {
  return Object.fromEntries(RETAINED_TRIP_GROUP_FIELDS.map((field) => [field, record[field]]));
}

function projectRetainedNativeRow(record) {
  return {
    sourceRowNumber: record.sourceRowNumber,
    sourceRowSha256: record.sourceRowSha256,
    arrival: retainedServiceTime(record.arrivalTime, "arrivalTime"),
    departure: retainedServiceTime(record.departureTime, "departureTime"),
    record: structuredClone(record),
  };
}

function retainedServiceTime(cell, field) {
  if (!cell || typeof cell.value !== "string" || !/^(\d{2,}):[0-5]\d:[0-5]\d$/u.test(cell.value)) {
    throw new Error(`retained Gwangju ${field} is invalid`);
  }
  const [hours, minutes, seconds] = cell.value.split(":").map(Number);
  const total = hours * 3_600 + minutes * 60 + seconds;
  if (!Number.isSafeInteger(total)) throw new Error(`retained Gwangju ${field} is invalid`);
  return { value: cell.value, seconds: total };
}

export function materializedPackContentHash(pack, version) {
  const content = { ...pack };
  delete content.id;
  delete content.version;
  delete content.url;
  return sha256(JSON.stringify({ version, content }));
}

function validateTopologySnapshot(snapshot) {
  const scopeCodes = snapshot?.scope?.map(({ stationCode }) => stationCode);
  const stationCount = scopeCodes?.length;
  const expectedEdgeCount = Number.isInteger(stationCount) ? 2 * (stationCount - 1) : Number.NaN;
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "gwangju-route-topology-snapshot"
    || snapshot.sourceId !== TOPOLOGY_SOURCE_ID || snapshot.official !== true || snapshot.fixture !== false
    || snapshot.credentialRequired !== false || snapshot.credentialRedacted !== true
    || !Number.isInteger(stationCount) || stationCount < 2 || new Set(scopeCodes).size !== stationCount
    || scopeCodes.some((code) => typeof code !== "string" || code.trim() === "")
    || snapshot.requestCount !== stationCount || snapshot.stationCount !== stationCount
    || snapshot.odRowCount !== stationCount * (stationCount - 1)
    || snapshot.edgeCount !== expectedEdgeCount || snapshot.edges?.length !== expectedEdgeCount
    || snapshot.scopeSha256 !== sha256(JSON.stringify(snapshot.scope))
    || snapshot.edgesSha256 !== sha256(JSON.stringify(snapshot.edges))
    || snapshot.contentSha256 !== sha256(JSON.stringify({ scope: snapshot.scope, edges: snapshot.edges }))) {
    throw new Error("invalid Gwangju topology snapshot");
  }
  const expectedPairs = new Set();
  for (let index = 1; index < scopeCodes.length; index += 1) {
    expectedPairs.add(`${scopeCodes[index - 1]}:${scopeCodes[index]}`);
    expectedPairs.add(`${scopeCodes[index]}:${scopeCodes[index - 1]}`);
  }
  const pairs = new Set();
  for (const edge of snapshot.edges) {
    const key = `${edge.fromStationCode}:${edge.toStationCode}`;
    if (!expectedPairs.has(key)
      || !Number.isInteger(edge.distanceMeters) || edge.distanceMeters <= 0
      || !Number.isInteger(edge.durationSeconds) || edge.durationSeconds <= 0 || pairs.has(key)) {
      throw new Error(`invalid Gwangju topology edge: ${key}`);
    }
    pairs.add(key);
  }
  if (pairs.size !== expectedPairs.size) throw new Error("invalid Gwangju topology snapshot");
}

// Source 등록은 시간표 의미만 증명한다. 실제 pack의 freshness·membership 검증은 위 materializer가 소유한다.
export function validateRetainedGwangjuSource({
  retainedTimetable, topologySnapshot, canonicalStationMappings, source,
}) {
  validateTopologySnapshot(topologySnapshot);
  const retained = validateRetainedTimetable(retainedTimetable, topologySnapshot, canonicalStationMappings);
  const provenance = provenanceForRetainedSchedule(source, retained.projection, retained.retainedContractSha256);
  const tables = buildRetainedGwangjuTransitTables({
    projection: retained.projection, lineId: LINE_ID,
    routeBindings: retainedTimetable.routeBindings, serviceIds: retainedTimetable.serviceIds,
    servicePatterns: retainedTimetable.servicePatterns,
    serviceDayStartSeconds: retainedTimetable.serviceDayStartSeconds, provenance,
  });
  buildRetainedGwangjuServiceCalendars({
    ...retainedTimetable.calendar, serviceIds: retainedTimetable.serviceIds,
    publicHolidayDates: new Set(retainedTimetable.calendar.publicHolidayDates),
  });
  return { ...retained, tables };
}

function validateRetainedTimetable(value, topologySnapshot, canonicalStationMappings) {
  if (!value || typeof value !== "object" || !value.observation || !value.receipt
    || !Array.isArray(value.stationBindings) || !Array.isArray(value.excludedEndpointLabels)
    || !Array.isArray(value.calendar?.publicHolidayDates)) {
    throw new Error("retained Gwangju timetable input is invalid");
  }
  const stationIdsByCode = new Map(canonicalStationMappings?.map((row) => [row.stationNumber, row.stationId]));
  for (const binding of value.stationBindings) {
    if (!stationIdsByCode.has(binding.stationCode) || stationIdsByCode.get(binding.stationCode) !== binding.stationId) {
      throw new Error("retained Gwangju station binding does not match canonical membership");
    }
  }
  routeBindingsByEndpoint(value.routeBindings, new Set(topologySnapshot.edges.map(({ fromStationCode, toStationCode }) =>
    `${fromStationCode}:${toStationCode}`)));
  const projection = projectRetainedGwangjuTimetable({ observation: value.observation, receipt: value.receipt,
    routeNumber: value.routeNumber, stationBindings: value.stationBindings,
    directedEdges: topologySnapshot.edges.map(({ fromStationCode, toStationCode }) => ({ fromStationCode, toStationCode })),
    excludedEndpointLabels: value.excludedEndpointLabels });
  const contract = { ...value };
  delete contract.observation;
  delete contract.receipt;
  return { projection, retainedContractSha256: sha256(canonicalJson(contract)) };
}

function requiredSources(inventory, retained, topologySnapshot, mappings) {
  const timetable = inventory?.sources?.find(({ id }) => id === SOURCE_ID);
  const topology = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID);
  const membership = inventory?.sources?.find(({ id }) => id === MEMBERSHIP_SOURCE_ID);
  const rawMembership = inventory?.sources?.find(({ id }) => id === MEMBERSHIP_RAW_SOURCE_ID);
  const schedule = timetable?.retainedScheduleAdmissionEvidence;
  const topologyEvidence = topology?.topologyAdmissionEvidence;
  const membershipEvidence = membership?.membershipAdmissionEvidence;
  const membershipVerifiedAt = Date.parse(membershipEvidence?.verifiedAt ?? "");
  const mappingSha256 = sha256(JSON.stringify(mappings));
  const stationCodesSha256 = sha256(JSON.stringify(mappings?.map(({ stationNumber }) => stationNumber)));
  if (timetable?.productionUseAllowed !== true || timetable.license?.redistributionAllowed !== true
    || timetable.capabilities?.schedule?.productionUseAllowed !== true
    || timetable.scheduleAdmissionEvidence !== undefined || typeof schedule?.snapshotId !== "string" || !schedule.snapshotId
    || schedule.rawSha256 !== retained.projection.source.rawSha256
    || schedule.recordsSha256 !== retained.projection.source.recordsSha256
    || schedule.observedAt !== retained.projection.source.observedAt
    || schedule.observationIdentitySha256 !== retained.projection.source.observationIdentitySha256
    || schedule.receiptSha256 !== retained.projection.source.receiptSha256
    || schedule.retainedContractSha256 !== retained.retainedContractSha256
    || schedule.topologySourceId !== TOPOLOGY_SOURCE_ID
    || schedule.topologySnapshotId !== topologyEvidence?.snapshotId
    || schedule.topologyContentSha256 !== topologySnapshot.contentSha256) {
    throw new Error(`${SOURCE_ID} inventory evidence does not match snapshot`);
  }
  if (topology?.productionUseAllowed !== true || topology.license?.redistributionAllowed !== true
    || topologyEvidence?.issue !== 2383
    || topologyEvidence.materializer !== "tools/datapack/materialize-gwangju-timetable.mjs"
    || topologyEvidence.verificationTest !== "tools/datapack/materialize-gwangju-timetable.test.mjs"
    || typeof topologyEvidence.snapshotId !== "string" || !topologyEvidence.snapshotId.startsWith("gwangju-transportation-route-topology-")
    || topologyEvidence.snapshotPath !== `tools/datapack/sources/${topologyEvidence.snapshotId}.json`
    || topologyEvidence.capturedAt !== topologySnapshot.capturedAt
    || topologyEvidence.freshUntil !== topologySnapshot.freshUntil
    || topologyEvidence.stationCount !== topologySnapshot.stationCount || topologyEvidence.excludedTransferCount !== 0
    || topologyEvidence.edgeCount !== topologySnapshot.edgeCount || topologyEvidence.rawSha256 !== topologySnapshot.rawSha256
    || topologyEvidence.contentSha256 !== topologySnapshot.contentSha256
    || JSON.stringify(topology.membershipAdmissionEvidence) !== JSON.stringify(membershipEvidence)) {
    throw new Error(`${TOPOLOGY_SOURCE_ID} inventory evidence does not match snapshot`);
  }
  if (!Array.isArray(mappings) || mappings.length !== topologySnapshot.scope.length
    || mappings.some((mapping, index) => mapping.stationNumber !== topologySnapshot.scope[index].stationCode)
    || membership?.productionUseAllowed !== true || membership.license?.redistributionAllowed !== true
    || rawMembership?.admissionEvidence?.decision !== "APPROVED"
    || membershipEvidence?.issue !== 2383
    || membershipEvidence.materializer !== "tools/datapack/materialize-gwangju-timetable.mjs"
    || membershipEvidence.verificationTest !== "tools/datapack/materialize-gwangju-timetable.test.mjs"
    || membershipEvidence.stationCount !== mappings.length || membershipEvidence.mappingSha256 !== mappingSha256
    || membershipEvidence.stationCodesSha256 !== stationCodesSha256
    || membershipEvidence.membershipSourceId !== MEMBERSHIP_RAW_SOURCE_ID
    || membershipEvidence.membershipSourceRawSha256 !== rawMembership.admissionEvidence.rawSha256
    || membershipEvidence.membershipSourceSnapshotSha256 !== mappings.sourceRawSha256
    || membershipEvidence.stationCodeSourceId !== TOPOLOGY_SOURCE_ID
    || membershipEvidence.stationCodeSnapshotId !== topologyEvidence.snapshotId
    || membershipEvidence.stationCodeContentSha256 !== topologySnapshot.contentSha256
    || !Number.isFinite(membershipVerifiedAt)
    || new Date(membershipVerifiedAt).toISOString() !== membershipEvidence.verifiedAt) {
    throw new Error(`${MEMBERSHIP_SOURCE_ID} membership evidence is invalid`);
  }
  for (const [label, capturedAt, freshUntil] of [
    [TOPOLOGY_SOURCE_ID, topologyEvidence.capturedAt, topologyEvidence.freshUntil],
  ]) {
    const captured = Date.parse(capturedAt);
    const fresh = Date.parse(freshUntil);
    if (!Number.isFinite(captured) || fresh !== captured + FRESHNESS_MILLIS) {
      throw new Error(`${label} evidence freshness relationship is invalid`);
    }
  }
  return { timetable, topology, membership };
}

function bindCumulativeGwangjuTopology(pack, generated) {
  const existingOperator = pack.operators.filter(({ id }) => id === OPERATOR_ID);
  const existingLine = pack.lines.filter(({ id }) => id === LINE_ID);
  if (existingOperator.length > 1 || existingLine.length > 1
    || existingLine.some(({ operatorId }) => operatorId !== OPERATOR_ID)) {
    throw new Error("Gwangju cumulative line identity mismatch");
  }
  const hasExistingTopology = existingOperator.length === 1 || existingLine.length === 1;
  const timetableRows = [
    ...pack.transitRoutes.filter(({ lineId }) => lineId === LINE_ID),
    ...pack.transitStopTimes.filter(({ lineId }) => lineId === LINE_ID),
  ];
  if (timetableRows.length > 0 || pack.transitTrips.some(({ routeId }) =>
    pack.transitRoutes.some((route) => route.id === routeId && route.lineId === LINE_ID))) {
    throw new Error("Gwangju cumulative timetable already exists");
  }
  const expectedMembership = new Map(generated.stationLines.map((row) => [
    `${row.stationId}\0${row.lineSequence}`, row,
  ]));
  const actualMembership = pack.stationLines.filter(({ lineId }) => lineId === LINE_ID);
  const edgeKey = ({ fromNodeId, toNodeId }) => `${fromNodeId}\0${toNodeId}`;
  const expectedEdges = new Map(generated.networkEdges.map((row) => [edgeKey(row), row]));
  const actualEdges = pack.networkEdges.filter((row) => row.edgeType === "RIDE" && expectedEdges.has(edgeKey(row)));
  const lineRideEdges = pack.networkEdges.filter((row) => row.edgeType === "RIDE"
    && (row.fromNodeId?.endsWith(`:${LINE_ID}`) || row.toNodeId?.endsWith(`:${LINE_ID}`)));
  if (hasExistingTopology && (actualMembership.length === 0 || lineRideEdges.length === 0)) {
    throw new Error("Gwangju cumulative topology is partial");
  }
  adoptGwangjuMembership(pack, generated.stationLines, actualMembership, expectedMembership);
  adoptGwangjuStations(pack, generated.stations);
  adoptGwangjuRideEdges(pack, generated.networkEdges, actualEdges, lineRideEdges, expectedEdges, edgeKey);
}

function adoptGwangjuMembership(pack, generated, actual, expected) {
  if (actual.length === 0) {
    pack.stationLines.push(...generated);
    return;
  }
  const actualKeys = new Set(actual.map(({ stationId, lineSequence }) => `${stationId}\0${lineSequence}`));
  if (actualKeys.size !== actual.length || actualKeys.size !== expected.size
    || [...actualKeys].some((key) => !expected.has(key))) {
    throw new Error("Gwangju cumulative membership mismatch");
  }
  for (const row of actual) {
    if (hasExistingAuthority(row)) {
      throw new Error("Gwangju cumulative membership source mismatch");
    }
    const expectedRow = expected.get(`${row.stationId}\0${row.lineSequence}`);
    row.stationCode = expectedRow.stationCode;
    assignAuthorityFields(row, expectedRow);
  }
}

function adoptGwangjuStations(pack, generated) {
  const expected = new Map(generated.map((row) => [row.id, row]));
  const actual = pack.stations.filter(({ id }) => expected.has(id));
  if (actual.length > 0 && (actual.length !== expected.size
    || new Set(actual.map(({ id }) => id)).size !== actual.length)) {
    throw new Error("Gwangju cumulative station mismatch");
  }
  if (actual.length === 0) {
    pack.stations.push(...generated);
    return;
  }
  for (const row of actual) {
    const expectedRow = expected.get(row.id);
    if (normalizedName(row.nameKo) !== normalizedName(expectedRow.nameKo)) {
      throw new Error("Gwangju cumulative station name mismatch");
    }
    if (hasExistingAuthority(row)) {
      throw new Error("Gwangju cumulative station source mismatch");
    }
    assignAuthorityFields(row, expectedRow);
  }
}

function adoptGwangjuRideEdges(pack, generated, actual, lineEdges, expected, edgeKey) {
  if (lineEdges.length === 0) {
    pack.networkEdges.push(...generated);
    return;
  }
  const actualKeys = new Set(actual.map((row) => edgeKey(row)));
  if (actual.length !== lineEdges.length || actualKeys.size !== actual.length
    || actualKeys.size !== expected.size || [...actualKeys].some((key) => !expected.has(key))) {
    throw new Error("Gwangju cumulative RIDE topology mismatch");
  }
  for (const row of actual) {
    if (hasExistingAuthority(row)) {
      throw new Error("Gwangju cumulative RIDE source mismatch");
    }
    const id = row.id;
    Object.assign(row, structuredClone(expected.get(edgeKey(row))), { id });
  }
}

function assignAuthorityFields(target, source) {
  for (const key of [
    "sourceId", "sourceSnapshotId", "providerRecordHash", "evidenceHash", "provenanceKind",
    "derivationKind", "verificationStatus", "lastVerifiedAt", "fieldProvenance",
  ]) {
    if (Object.hasOwn(source, key)) target[key] = structuredClone(source[key]);
  }
}

function hasExistingAuthority(row) {
  return row.sourceId !== undefined || row.sourceSnapshotId !== undefined || row.providerRecordHash !== undefined
    || row.evidenceHash !== undefined || row.fieldProvenance !== undefined || row.provenanceKind !== undefined
    || row.derivationKind !== undefined || row.verificationStatus !== undefined;
}

function addStationsAndTopology(pack, snapshot, mappings, sources) {
  const scopeByCode = new Map(snapshot.scope.map((row) => [row.stationCode, row]));
  const stations = new Map();
  const membershipEvidence = sources.membership.membershipAdmissionEvidence;
  const topologyEvidence = sources.topology.topologyAdmissionEvidence;
  for (const [index, mapping] of mappings.entries()) {
    const scope = scopeByCode.get(mapping.stationNumber);
    if (!scope || normalizedName(mapping.stationName) !== normalizedName(scope.stationName)) {
      throw new Error(`Gwangju canonical station mapping mismatch: ${mapping.stationNumber}`);
    }
    const membershipHash = sha256(JSON.stringify({
      lineId: LINE_ID, stationName: mapping.stationName, stationSequence: index + 1,
    }));
    pack.stations.push({
      id: mapping.stationId,
      nameKo: mapping.stationName,
      nameEn: "",
      normalizedName: mapping.stationName.normalize("NFKC"),
      region: "광주권",
      latitude: null,
      longitude: null,
      dataQualityLevel: "LEVEL_2",
      dataSourceType: "OFFICIAL_FILE",
      sourceId: MEMBERSHIP_SOURCE_ID,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipHash,
      evidenceHash: membershipEvidence.mappingSha256,
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
    pack.stationLines.push({
      stationId: mapping.stationId,
      lineId: LINE_ID,
      stationCode: mapping.stationNumber,
      lineSequence: index + 1,
      platformInfo: "",
      sourceId: MEMBERSHIP_SOURCE_ID,
      sourceSnapshotId: membershipEvidence.snapshotId,
      providerRecordHash: membershipHash,
      evidenceHash: membershipEvidence.mappingSha256,
      fieldProvenance: {
        station_code: {
          sourceId: TOPOLOGY_SOURCE_ID,
          sourceSnapshotId: topologyEvidence.snapshotId,
          providerRecordHash: sha256(JSON.stringify(scope)),
          evidenceHash: snapshot.contentSha256,
          derivationKind: "OFFICIAL",
          verifiedAt: snapshot.capturedAt,
        },
      },
      derivationKind: "OFFICIAL",
      lastVerifiedAt: membershipEvidence.verifiedAt,
    });
    stations.set(mapping.stationNumber, mapping);
  }
  for (const edge of snapshot.edges) {
    const from = stations.get(edge.fromStationCode);
    const to = stations.get(edge.toStationCode);
    pack.networkEdges.push({
      id: `edge-gwangju-${edge.fromStationCode}-${edge.toStationCode}`,
      fromNodeId: `${from.stationId}:${LINE_ID}`,
      toNodeId: `${to.stationId}:${LINE_ID}`,
      durationSeconds: edge.durationSeconds,
      distanceMeters: edge.distanceMeters,
      edgeType: "RIDE",
      servicePattern: "LOCAL",
      serviceClass: "SUBWAY",
      includesStairs: false,
      stairAccessState: "UNKNOWN",
      accessibilityStatus: "UNKNOWN",
      reliabilityScore: 100,
      sourceId: TOPOLOGY_SOURCE_ID,
      sourceSnapshotId: topologyEvidence.snapshotId,
      providerRecordHash: sha256(JSON.stringify(edge)),
      provenanceKind: "OFFICIAL_SOURCE",
      derivationKind: "OFFICIAL",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: snapshot.capturedAt,
      evidenceHash: snapshot.contentSha256,
    });
  }
  return stations;
}

function addRetainedRoutes(pack, routeBindings, provenance) {
  if (!Array.isArray(routeBindings)) throw new Error("retained Gwangju route bindings are invalid");
  routeBindingsByEndpoint(routeBindings);
  for (const binding of routeBindings) {
    pack.transitRoutes.push(withProvenance({
      id: binding.routeId,
      lineId: LINE_ID,
      routeShortName: "1",
      routeLongName: `광주 1호선 ${binding.tripHeadsign} 방면`,
      directionName: `${binding.tripHeadsign} 방면`,
    }, provenance));
  }
}

function provenanceForRetainedSchedule(source, projection, retainedContractSha256) {
  return {
    sourceId: SOURCE_ID,
    sourceSnapshotId: source.retainedScheduleAdmissionEvidence.snapshotId,
    providerRecordHash: projection.source.recordsSha256,
    evidenceHash: retainedContractSha256,
    updatedAt: projection.source.observedAt,
  };
}

function withProvenance(row, provenance, derivationKind = "OFFICIAL") {
  return {
    ...row,
    sourceId: provenance.sourceId,
    sourceSnapshotId: provenance.sourceSnapshotId,
    providerRecordHash: provenance.providerRecordHash,
    evidenceHash: provenance.evidenceHash,
    provenanceKind: "OFFICIAL_SOURCE",
    derivationKind,
    updatedAt: provenance.updatedAt,
  };
}

function packSource(source, updatedAt) {
  return {
    id: source.id,
    owner: source.owner,
    url: source.datasetUrl,
    license: source.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: source.updateFrequency,
    updatedAt,
    fields: [...source.fieldsProvided],
    coverageScope: structuredClone(source.coverageScope),
  };
}

function normalizedName(value) {
  return String(value).normalize("NFKC").replace(/\([^)]*\)/g, "").replace(/[\s/.·]/g, "").replace(/역$/u, "");
}
function compactSeoulDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

// 등록 시 보존한 contract를 사용해야 달력 재조회로 admission identity가 바뀌지 않는다.
export function restoreAdmittedGwangjuTimetable({ observationBytes, inventory, snapshots }) {
  const sources = inventory?.sources?.filter(({ id }) => id === SOURCE_ID) ?? [];
  const evidence = sources.length === 1 ? sources[0].retainedScheduleAdmissionEvidence : null;
  const rows = Array.isArray(snapshots) ? snapshots.filter((row) => row.sourceId === SOURCE_ID
    && row.snapshotId === evidence?.snapshotId) : [];
  const row = rows.length === 1 ? rows[0] : null;
  const inputs = row?.retainedTimetableInputs;
  if (!evidence || !inputs?.contract || !inputs.collectionReceipt
    || sha256(canonicalJson(inputs.contract)) !== evidence.retainedContractSha256
    || sha256(observationBytes) !== row.rawObjectSha256) {
    throw new Error("retained Gwangju persisted input binding is invalid");
  }
  const observation = JSON.parse(observationBytes);
  const { summary } = selectRetainedKricTimetable({ observation, receipt: inputs.collectionReceipt,
    routeNumber: inputs.contract.routeNumber });
  if (summary.observationIdentitySha256 !== row.contentSha256
    || summary.observationIdentitySha256 !== evidence.observationIdentitySha256
    || summary.receiptSha256 !== evidence.receiptSha256 || summary.rawSha256 !== evidence.rawSha256
    || summary.recordsSha256 !== evidence.recordsSha256 || summary.observedAt !== evidence.observedAt) {
    throw new Error("retained Gwangju persisted observation binding is invalid");
  }
  return { ...inputs.contract, observation, receipt: inputs.collectionReceipt };
}

function parseArgs(argv) {
  const expected = ["--base-fixture", "--retained-observation", "--snapshots", "--inventory", "--station-map", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: materialize-gwangju-timetable.mjs --base-fixture <json> --retained-observation <json> --snapshots <json> --inventory <json> --station-map <csv> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

function resolveTopologySnapshotPath(inventory, repositoryRoot) {
  const evidence = inventory?.sources?.find(({ id }) => id === TOPOLOGY_SOURCE_ID)?.topologyAdmissionEvidence;
  const snapshotPath = evidence?.snapshotPath;
  if (typeof evidence?.snapshotId !== "string" || !evidence.snapshotId.startsWith("gwangju-transportation-route-topology-")
    || typeof snapshotPath !== "string" || !/^tools\/datapack\/sources\/[^/]+\.json$/u.test(snapshotPath)
    || snapshotPath !== `tools/datapack/sources/${evidence.snapshotId}.json`) {
    throw new Error("Gwangju topology snapshot path is invalid");
  }
  const root = path.resolve(repositoryRoot);
  const sourcesRoot = path.resolve(root, "tools/datapack/sources");
  const resolved = path.resolve(root, snapshotPath);
  if (!resolved.startsWith(`${sourcesRoot}${path.sep}`)) throw new Error("Gwangju topology snapshot path is invalid");
  return resolved;
}

export async function runGwangjuTimetableMaterializer(argv, {
  repositoryRoot = path.resolve(import.meta.dirname, "../.."),
} = {}) {
  const args = parseArgs(argv);
  const inventory = JSON.parse(await readFile(args.inventory, "utf8"));
  const topologyPath = resolveTopologySnapshotPath(inventory, repositoryRoot);
  const [baseFixture, observationBytes, snapshots, topologySnapshot, stationMap] = await Promise.all([
    readFile(args["base-fixture"], "utf8").then(JSON.parse),
    readFile(args["retained-observation"]),
    readFile(args.snapshots, "utf8").then(JSON.parse),
    readFile(topologyPath, "utf8").then(JSON.parse),
    readFile(args["station-map"]),
  ]);
  const fixture = materializeGwangjuTimetable({
    baseFixture,
    retainedTimetable: restoreAdmittedGwangjuTimetable({ observationBytes, inventory, snapshots }),
    topologySnapshot,
    inventory,
    canonicalStationMappings: parseMolitGwangjuStationMappings(stationMap, topologySnapshot),
  });
  fixture.fixtureClass = "TEST_ONLY";
  await writeFile(args.output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Gwangju timetable materialized: trips=${fixture.packs[0].transitTrips.length} stopTimes=${fixture.packs[0].transitStopTimes.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runGwangjuTimetableMaterializer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju timetable materialization failed");
    process.exitCode = 1;
  }
}
