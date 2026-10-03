import { createHash } from "node:crypto";

import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import { KRIC_API_STATION_TIMETABLE_BINDINGS } from "./kric-station-timetable-api-trips.mjs";
import { canonicalJson } from "./manifest-validation.mjs";

// #903: kric-subway-timetable-station-lines 등록기가 커밋한 파생 스냅샷(역별 KRIC API 재구성 trip)을
// 공용 적재기(materializeOfficialLineTimetables) 입력으로 바꾼다. 스냅샷 내용 해시를 다시 확인하고 trip은 바꾸지 않는다.

export const STATION_LINES_TIMETABLE_SOURCE_ID = "kric-subway-timetable-station-lines";
export const STATION_LINES_EVIDENCE_KEY = "scheduleAdmissionEvidence";
export const STATION_LINES_SERVICE_ID_PREFIX = "kric-station";
export const STATION_LINES_TRIP_ID_PREFIX = "ks";
const ROUTE_NAMES = Object.freeze({ A: "GTX-A", E1: "에버라인", U1: "의정부경전철", G1: "김포골드라인", B1: "부산김해경전철" });
const SERVICE_DAY_KIND = Object.freeze({ WEEKDAY: "WEEKDAY", SATURDAY_SUNDAY_HOLIDAY: "WEEKEND_HOLIDAY" });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, detail = "") => { throw new Error(`KRIC_STATION_LINES_TIMETABLE_${code}${detail ? `: ${detail}` : ""}`); };

/** 파생 스냅샷 자기 결속(snapshotId·contentSha256·trip 해시)과 inventory evidence 결속을 확인한다. */
export function validateStationLinesSnapshot(snapshot, evidence) {
  const { snapshotId, contentSha256, ...content } = snapshot ?? {};
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== "kric-station-timetable-snapshot"
    || snapshot.sourceId !== STATION_LINES_TIMETABLE_SOURCE_ID || !Array.isArray(snapshot.trips) || !Array.isArray(snapshot.lines)
    || sha256(canonicalJson(content)) !== contentSha256) fail("SNAPSHOT");
  if (evidence?.snapshotId !== snapshotId || evidence.contentSha256 !== contentSha256 || evidence.rawSha256 !== snapshot.raw?.rawSha256
    || evidence.tripsSha256 !== sha256(JSON.stringify(snapshot.trips)) || evidence.tripCount !== snapshot.trips.length) fail("EVIDENCE");
  return snapshot;
}

/** 스냅샷 → { provider, lineBindings }. 관측 시각은 수집 완료 시각(collectedAt)이다. */
export function kricStationLinesOfficialTimetable(snapshot, evidence, { bindings = KRIC_API_STATION_TIMETABLE_BINDINGS } = {}) {
  validateStationLinesSnapshot(snapshot, evidence);
  const lnCdOf = new Map(bindings.map(({ lineId, lnCd }) => [lineId, lnCd]));
  const trips = snapshot.trips.map((trip) => ({
    lineId: trip.lineId, routeKey: lnCdOf.get(trip.lineId) ?? fail("LINE", trip.lineId), providerTripKey: trip.providerTripKey,
    trainNumber: trip.provenance.trainNumber, serviceDayKind: SERVICE_DAY_KIND[trip.serviceDayKind] ?? fail("SERVICE_DAY", trip.providerTripKey),
    sourceDayKey: trip.provenance.dayCd, servicePattern: trip.servicePattern, headsign: trip.headsign,
    sourceRowSha256: trip.sourceRowSha256, stops: trip.stops,
  }));
  const quarantine = snapshot.quarantine.map((row) => ({
    sourceId: STATION_LINES_TIMETABLE_SOURCE_ID, lineId: row.lineId, routeKey: lnCdOf.get(row.lineId), trainNumber: row.providerTripKey.split("|")[1],
    serviceDayKind: row.providerTripKey.split("|")[2] === "8" ? "WEEKDAY" : "WEEKEND_HOLIDAY", sourceDayKey: row.providerTripKey.split("|")[2],
    sourceRowNumber: null, sourceRowSha256: sha256(JSON.stringify(row)), reason: row.reason,
  }));
  const lineBindings = bindings.map((entry) => ({
    lineId: entry.lineId, routeKey: entry.lnCd, routeName: ROUTE_NAMES[entry.lnCd] ?? fail("ROUTE_NAME", entry.lnCd),
    stationAliases: Object.fromEntries(Object.entries(entry.stationAliases).map(([source, nameKo]) => [source, { nameKo, reason: entry.aliasEvidence[source] }])),
  }));
  return {
    provider: {
      sourceId: STATION_LINES_TIMETABLE_SOURCE_ID, sourceSnapshotId: snapshot.snapshotId, rawSha256: snapshot.raw.rawSha256,
      recordsSha256: snapshot.contentSha256, observedAt: snapshot.collectedAt, dataReferenceDateByLine: {},
      trips: trips.sort((left, right) => codepointCompare(left.providerTripKey, right.providerTripKey)), quarantine,
    },
    lineBindings,
  };
}
