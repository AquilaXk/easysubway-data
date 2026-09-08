import assert from "node:assert/strict";
import test from "node:test";

import { buildKorailScheduleIds, buildKorailScheduleSnapshot } from "./register-korail-timetable.mjs";
import { materializeKorailTimetable } from "./materialize-korail-timetable.mjs";

const sourceId = "korail-metropolitan-planned-timetable";
const familyId = "korail-metropolitan-timetable-file";
const lineId = "line-test";

test("materializes only receipt-bound Korail routes, trips, and stop times", () => {
  const snapshot = scheduleSnapshot();
  const result = materializeKorailTimetable({ pack: basePack(), snapshot, inventory: inventory(snapshot), ledger: ledger(snapshot), now: new Date("2040-01-02T00:00:00.000Z") });
  assert.deepEqual(result.transitRoutes.map(({ id }) => id), snapshot.tables.transitRoutes.map(({ id }) => id));
  assert.deepEqual(result.transitTrips.map(({ routeId, serviceId }) => [routeId, serviceId]), [
    [snapshot.tables.transitRoutes[0].id, snapshot.tables.serviceCalendars[0].serviceId],
  ]);
  assert.deepEqual(result.transitStopTimes.map(({ tripId, stationId }) => [tripId, stationId]), [
    [snapshot.tables.transitTrips[0].id, "station-a"], [snapshot.tables.transitTrips[0].id, "station-b"],
  ]);
  assert.equal(result.sourceInventory.at(-1).id, sourceId);
});

test("rejects foreign routes, trip foreign keys, and selected-line collisions", () => {
  const snapshot = scheduleSnapshot();
  const args = { pack: basePack(), snapshot, inventory: inventory(snapshot), ledger: ledger(snapshot), now: new Date("2040-01-02T00:00:00.000Z") };
  const foreignRoute = structuredClone(snapshot); foreignRoute.tables.transitRoutes[0].lineId = "line-other";
  const foreignRouteSnapshot = reseal(foreignRoute);
  assert.throws(() => materializeKorailTimetable({ ...args, snapshot: foreignRouteSnapshot, inventory: inventory(foreignRouteSnapshot), ledger: ledger(foreignRouteSnapshot) }), /KORAIL_TIMETABLE_MATERIALIZER_TABLES/);
  const foreignTrip = structuredClone(snapshot); foreignTrip.tables.transitTrips[0].routeId = "route-other";
  const foreignTripSnapshot = reseal(foreignTrip);
  assert.throws(() => materializeKorailTimetable({ ...args, snapshot: foreignTripSnapshot, inventory: inventory(foreignTripSnapshot), ledger: ledger(foreignTripSnapshot) }), /KORAIL_TIMETABLE_MATERIALIZER_TABLES/);
  const colliding = basePack(); colliding.transitRoutes.push({ ...structuredClone(snapshot.tables.transitRoutes[0]), id: "foreign-selected-line-route" });
  assert.throws(() => materializeKorailTimetable({ ...args, pack: colliding }), /KORAIL_TIMETABLE_MATERIALIZER_SOURCE_PARTITION_CONFLICT/);
});

test("replaces the owned timetable partition while preserving unrelated pack rows", () => {
  const snapshot = scheduleSnapshot();
  const pack = basePack();
  pack.serviceCalendars.push({ serviceId: "other-service" });
  pack.transitRoutes.push({ id: "other-route", lineId: "other-line" });
  pack.transitTrips.push({ id: "other-trip", routeId: "other-route", serviceId: "other-service" });
  pack.transitStopTimes.push({ tripId: "other-trip", stopSequence: 1, stationId: "other-station" });
  pack.sourceInventory.push({ id: "other-source" });
  const original = structuredClone(pack);
  const args = { snapshot, inventory: inventory(snapshot), ledger: ledger(snapshot), now: new Date("2040-01-02T00:00:00.000Z") };
  const first = materializeKorailTimetable({ ...args, pack });
  assert.deepEqual(materializeKorailTimetable({ ...args, pack: first }), first);
  const changed = structuredClone(snapshot);
  changed.tables.transitStopTimes[1].arrivalSeconds += 60;
  changed.tables.transitStopTimes[1].departureSeconds += 60;
  const successor = reseal(changed);
  const result = materializeKorailTimetable({ ...args, pack: first, snapshot: successor,
    inventory: inventory(successor), ledger: ledger(successor) });
  for (const key of ["serviceCalendars", "transitRoutes", "transitTrips", "transitStopTimes", "sourceInventory"]) {
    assert.deepEqual(result[key][0], original[key][0]);
    assert.equal(result[key].length, first[key].length);
  }
  assert.equal(result.transitStopTimes.at(-1).arrivalSeconds, 660);
  assert.equal(result.transitStopTimes.at(-1).sourceSnapshotId, successor.snapshotId);
  assert.deepEqual(result.stations, original.stations);
  assert.deepEqual(result.stationLines, original.stationLines);
  assert.deepEqual(pack, original);
});

test("uses the canonical terminal station name as the trip headsign and rejects an unresolved terminal", () => {
  const snapshot = scheduleSnapshot();
  const args = { inventory: inventory(snapshot), ledger: ledger(snapshot), now: new Date("2040-01-02T00:00:00.000Z") };
  const pack = basePack();
  pack.stations = [{ id: "station-a", name: "가역" }, { id: "station-b", name: "나역" }];

  const result = materializeKorailTimetable({ ...args, pack, snapshot });
  assert.equal(result.transitTrips[0].tripHeadsign, "나역");

  const unresolved = structuredClone(snapshot);
  unresolved.tables.transitTrips[0].tripHeadsign = "station-missing";
  const unresolvedSnapshot = reseal(unresolved);
  assert.throws(
    () => materializeKorailTimetable({ ...args, pack: basePack(), snapshot: unresolvedSnapshot,
      inventory: inventory(unresolvedSnapshot), ledger: ledger(unresolvedSnapshot) }),
    /KORAIL_TIMETABLE_MATERIALIZER_TERMINAL/,
  );
});

function scheduleSnapshot() {
  const { routes: routeIds, services: serviceIds } = buildKorailScheduleIds({ lineId });
  const tables = {
    serviceCalendars: [
      { serviceId: serviceIds["평일"], monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false, startDate: "20400101", endDate: "20401231", timezone: "Asia/Seoul" },
      { serviceId: serviceIds["휴일"], monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: true, startDate: "20400101", endDate: "20401231", timezone: "Asia/Seoul" },
    ], serviceCalendarDates: [],
    transitRoutes: [{ id: routeIds.up, lineId, routeShortName: "대경선", routeLongName: "대경선 B 방면", directionName: "B 방면", timezone: "Asia/Seoul" }],
    transitTrips: [{ id: "route-up-1001-평일", routeId: routeIds.up, serviceId: serviceIds["평일"], tripHeadsign: "station-b", directionId: "up", servicePattern: "LOCAL", trainNo: "1001" }],
    transitStopTimes: [
      { tripId: "route-up-1001-평일", stopSequence: 1, stationId: "station-a", lineId, arrivalSeconds: 0, departureSeconds: 0, pickupType: 0, dropOffType: 1 },
      { tripId: "route-up-1001-평일", stopSequence: 2, stationId: "station-b", lineId, arrivalSeconds: 600, departureSeconds: 600, pickupType: 1, dropOffType: 0 },
    ], holidayCalendarSources: [],
  };
  return buildKorailScheduleSnapshot({ sourceFamilyId: familyId, originalCapturedAt: "2040-01-01T00:00:00.000Z", derivedFreshUntil: "2040-02-01T00:00:00.000Z", serviceEffectiveAt: "2039-12-31T15:00:00.000Z", serviceEffectiveUntil: null, calendarWindow: { startDate: "20400101", endDate: "20401231" }, originalSelection: { lineId, operatorName: "한국철도공사", lineName: "대경선" }, topology: { sourceId: familyId, snapshotId: "topology-1", contentSha256: "a".repeat(64) }, raw: { sourceId: familyId, rawSha256: "b".repeat(64), byteSize: 10, collectionReceiptSha256: "c".repeat(64), publicationReceiptSha256: "d".repeat(64), rawObjectUri: "oci://bucket/raw" }, calendar: { manifestSha256: "e".repeat(64), months: [{ year: 2040, month: 1, sha256: "f".repeat(64) }] }, tables });
}

function reseal(snapshot) {
  return buildKorailScheduleSnapshot({
    sourceFamilyId: snapshot.sourceFamilyId,
    originalCapturedAt: snapshot.originalCapturedAt,
    derivedFreshUntil: snapshot.derivedFreshUntil,
    serviceEffectiveAt: snapshot.serviceEffectiveAt,
    serviceEffectiveUntil: snapshot.serviceEffectiveUntil,
    calendarWindow: structuredClone(snapshot.calendarWindow),
    originalSelection: structuredClone(snapshot.originalSelection),
    topology: structuredClone(snapshot.topology),
    raw: structuredClone(snapshot.raw),
    calendar: structuredClone(snapshot.calendar),
    tables: structuredClone(snapshot.tables),
  });
}

function basePack() {
  return { sourceInventory: [], lines: [{ id: lineId, operatorId: "korail" }], stations: [{ id: "station-a", name: "가역" }, { id: "station-b", name: "나역" }], stationLines: [{ stationId: "station-a", lineId, lineSequence: 1 }, { stationId: "station-b", lineId, lineSequence: 2 }], serviceCalendars: [], serviceCalendarDates: [], transitRoutes: [], transitTrips: [], transitStopTimes: [], minimumTableRows: {} };
}

function inventory(snapshot) {
  return { sources: [{ id: familyId, coverageScope: { lineIds: [lineId] }, topologyAdmissionEvidence: { snapshotId: snapshot.topology.snapshotId, contentSha256: snapshot.topology.contentSha256 } }, { id: sourceId, owner: "한국철도공사", datasetUrl: "https://example.test", updateFrequency: "P1D", fieldsProvided: ["service_calendar", "trip", "stop_time"], coverageScope: { lineIds: [lineId], sourceDomains: ["schedule_timetable"] }, requiredForProductionPack: true, productionUseAllowed: true, license: { name: "unrestricted", redistributionAllowed: true }, capabilities: { schedule: { productionUseAllowed: true } }, scheduleAdmissionEvidence: { snapshotId: snapshot.snapshotId, contentSha256: snapshot.contentSha256, tripsSha256: snapshot.tripsSha256, topologySourceId: familyId, topologySnapshotId: snapshot.topology.snapshotId, topologyContentSha256: snapshot.topology.contentSha256, rawSha256: snapshot.raw.rawSha256, freshUntil: snapshot.derivedFreshUntil, capturedAt: snapshot.originalCapturedAt, rowCount: snapshot.tables.transitStopTimes.length, departureCount: snapshot.tables.transitStopTimes.length, tripCount: snapshot.tables.transitTrips.length, stopTimeCount: snapshot.tables.transitStopTimes.length, rowsSha256: snapshot.rowsSha256 } }] };
}

function ledger(snapshot) {
  return [{ sourceId: familyId, snapshotId: snapshot.topology.snapshotId, contentSha256: snapshot.topology.contentSha256, rawSha256: snapshot.raw.rawSha256, rawObjectSha256: snapshot.raw.rawSha256, rawObjectUri: snapshot.raw.rawObjectUri, rawReceiptSha256: snapshot.raw.publicationReceiptSha256, byteSize: snapshot.raw.byteSize, capturedAt: snapshot.originalCapturedAt, retrievedAt: snapshot.originalCapturedAt, rawRetentionExpiresAt: "2040-03-01T00:00:00.000Z" }, { sourceId, snapshotId: snapshot.snapshotId, contentSha256: snapshot.contentSha256, rawSha256: snapshot.raw.rawSha256, freshUntil: snapshot.derivedFreshUntil, freshnessExpiresAt: snapshot.derivedFreshUntil, snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS", redistributionAllowed: true }];
}
