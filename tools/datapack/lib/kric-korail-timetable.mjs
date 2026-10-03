import { createHash } from "node:crypto";

import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import {
  EXPRESS_QUARANTINE_NOTE,
  EXPRESS_STOP_PATTERN_UNRESOLVED,
  KORAIL_STATION_ROW_BINDINGS,
  buildKorailStationRowTrips,
} from "./kric-station-row-timetable-trips.mjs";

// #903: KRIC 전체_도시철도운행정보(파일 id 900)의 코레일 역별 행(서해·경춘·수인분당·경의중앙·경강·동해)을
// 수도권 projection과 같은 수집 실행에서 별도 snapshot으로 커밋하고, 공용 적재기(materializeOfficialLineTimetables)
// 입력으로 바꾼다. 재구성 규칙(행 순서 = 시각 순서일 때만 채택, 급행 미적재)은 kric-station-row-timetable-trips가 정한다.

export const KORAIL_TIMETABLE_SOURCE_ID = "kric-nationwide-timetable-file";
export const KORAIL_TIMETABLE_EVIDENCE_KEY = "korailScheduleAdmissionEvidence";
export const KORAIL_TIMETABLE_SNAPSHOT_KIND = "kric-korail-timetable-snapshot";
export const KORAIL_TIMETABLE_SERVICE_ID_PREFIX = "kric-korail";
export const KORAIL_TIMETABLE_TRIP_ID_PREFIX = "kk";

// 공용 적재기 형식의 급행 고정 집합(trip 단위, quarantineRowSetSha256). 2026-10-03 실측(원천 sha256 218f76dd…).
// 원천이 바뀌어 건수·집합이 달라지면 적재기가 QUARANTINE_ALLOWANCE_MISMATCH로 실패한다.
export const KORAIL_EXPRESS_ALLOWANCE = Object.freeze({
  I41K2: Object.freeze({ rowCount: 5, rowSetSha256: "5934643bec13e0cd32aeb7c2ce8300478699abaa6a55da1fd49960a0da0b30a3" }),
  I28K1: Object.freeze({ rowCount: 22, rowSetSha256: "e21e4cd62f74db32c0fa2b01813fe18f671d08ffc2cba86c2eb3c3e88f5e9f79" }),
  I4108: Object.freeze({ rowCount: 28, rowSetSha256: "f4efb4e31fc9ebb2cb7c3e0ef14292b52ca8addbde5589ca99e5fc5d2755dee9" }),
});

const SERVICE_DAY_KIND = Object.freeze({ WEEKDAY: "WEEKDAY", SATURDAY_SUNDAY_HOLIDAY: "WEEKEND_HOLIDAY" });
// 격리 행은 원천 요일구분 칸으로 운행일을 정한다. 평일·휴일(토·일·공휴일, QA 확정 정책)만 받고 그 밖의 값은 실패한다.
const SERVICE_DAY_KIND_BY_WEEKDAY_TYPE = Object.freeze({ "평일": "WEEKDAY", "휴일": "WEEKEND_HOLIDAY" });
const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "rawByteLength", "rawSha256", "observationRecordsSha256",
  "routes", "recordCount", "recordsSha256", "records",
]);
const RECORD_FIELDS = Object.freeze([
  "trainNumber", "routeNumber", "routeName", "originStationName", "destinationStationName", "serviceType",
  "weekdayType", "stationName", "arrivalTime", "departureTime", "dataReferenceDate", "sourceRowNumber", "sourceRowSha256",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, detail = "") => { throw new Error(`KRIC_KORAIL_TIMETABLE_${code}${detail ? `: ${detail}` : ""}`); };
const routes = () => KORAIL_STATION_ROW_BINDINGS.map(({ routeNumber, routeName, lineId }) => ({ routeNumber, routeName, lineId }));

/** 관측에서 코레일 6개 노선 행만 원문 그대로 골라 snapshot을 만든다. 관측 시각과 무관한 결정적 바이트다. */
export function projectKricKorailTimetableSnapshot(observation) {
  if (observation?.artifactKind !== "kric-nationwide-timetable-observation" || observation.sourceId !== KORAIL_TIMETABLE_SOURCE_ID
    || !SHA256.test(observation.rawSha256 ?? "") || !SHA256.test(observation.recordsSha256 ?? "") || !Array.isArray(observation.records)) {
    fail("OBSERVATION");
  }
  const bound = new Map(KORAIL_STATION_ROW_BINDINGS.map((entry) => [entry.routeNumber, entry]));
  const records = observation.records
    .filter((record) => bound.get(record.routeNumber)?.routeName === record.routeName)
    .map((record) => Object.fromEntries(RECORD_FIELDS.map((field) => [field, projectedField(record, field)])))
    .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
  for (const { routeNumber } of KORAIL_STATION_ROW_BINDINGS) {
    if (!records.some((record) => record.routeNumber === routeNumber)) fail("ROUTE_MISSING", routeNumber);
  }
  const recordsSha256 = sha256(Buffer.from(`${JSON.stringify(records)}\n`));
  return {
    schemaVersion: 1, artifactKind: KORAIL_TIMETABLE_SNAPSHOT_KIND, sourceId: KORAIL_TIMETABLE_SOURCE_ID,
    snapshotId: `${KORAIL_TIMETABLE_SOURCE_ID}-korail-${recordsSha256}`, rawByteLength: observation.rawByteLength,
    rawSha256: observation.rawSha256, observationRecordsSha256: observation.recordsSha256, routes: routes(),
    recordCount: records.length, recordsSha256, records,
  };
}

function projectedField(record, field) {
  const value = record[field];
  if (field === "sourceRowNumber") {
    if (!Number.isSafeInteger(value) || value <= 1) fail("RECORD", field);
    return value;
  }
  if (field === "sourceRowSha256") {
    if (!SHA256.test(value ?? "")) fail("RECORD", field);
    return value;
  }
  if (["arrivalTime", "departureTime", "dataReferenceDate"].includes(field)) {
    // 시각 칸은 Excel 일 분수(숫자 셀) 원문이다. 셀 종류와 원문 값만 남긴다.
    if (!value || typeof value.value !== "string" || !["s", "n"].includes(value.cellType)) fail("RECORD", field);
    return { cellType: value.cellType, value: value.value };
  }
  if (typeof value !== "string" || value.length === 0) fail("RECORD", field);
  return value;
}

export function validateKricKorailTimetableSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.artifactKind !== KORAIL_TIMETABLE_SNAPSHOT_KIND
    || JSON.stringify(Object.keys(snapshot)) !== JSON.stringify(SNAPSHOT_KEYS) || snapshot.sourceId !== KORAIL_TIMETABLE_SOURCE_ID
    || !Array.isArray(snapshot.records) || !SHA256.test(snapshot.rawSha256 ?? "")
    || !Number.isSafeInteger(snapshot.rawByteLength) || snapshot.rawByteLength <= 0) fail("SNAPSHOT");
  const recordsSha256 = sha256(Buffer.from(`${JSON.stringify(snapshot.records)}\n`));
  if (snapshot.recordsSha256 !== recordsSha256 || snapshot.recordCount !== snapshot.records.length
    || snapshot.snapshotId !== `${KORAIL_TIMETABLE_SOURCE_ID}-korail-${recordsSha256}`) fail("SNAPSHOT_HASH");
  if (JSON.stringify(snapshot.routes) !== JSON.stringify(routes())) fail("SNAPSHOT_ROUTES");
  return snapshot;
}

/** 격리 행 집합 해시(공용 적재기와 같은 규칙: 정렬한 sourceRowSha256을 줄바꿈으로 이어 sha256). */
function rowSetSha256(rows) {
  return sha256(`${rows.map(({ sourceRowSha256 }) => sourceRowSha256).sort(codepointCompare).join("\n")}\n`);
}

/**
 * snapshot → 공용 적재기 입력 { provider, lineBindings }. 관측 시각은 inventory evidence의 최신 재확인이 준다.
 * 급행 trip은 quarantine 행(EXPRESS_STOP_PATTERN_UNRESOLVED)으로 넘기고 노선별 고정 집합(allowance)으로 결속한다.
 */
export function kricKorailOfficialTimetable(snapshot, { observedAt, allowance = KORAIL_EXPRESS_ALLOWANCE, bindings = KORAIL_STATION_ROW_BINDINGS } = {}) {
  validateKricKorailTimetableSnapshot(snapshot);
  if (typeof observedAt !== "string" || new Date(observedAt).toISOString() !== observedAt) fail("OBSERVED_AT");
  const result = buildKorailStationRowTrips({ records: snapshot.records, bindings });
  const routeKeyOf = new Map(bindings.map(({ lineId, routeNumber }) => [lineId, routeNumber]));
  const dataReferenceDates = new Map();
  const trips = result.trips.map((trip) => {
    const dates = dataReferenceDates.get(trip.lineId) ?? new Set();
    dates.add(trip.provenance.dataReferenceDate);
    dataReferenceDates.set(trip.lineId, dates);
    return {
      lineId: trip.lineId, routeKey: trip.provenance.routeNumber, providerTripKey: trip.providerTripKey,
      trainNumber: trip.provenance.trainNumber, serviceDayKind: SERVICE_DAY_KIND[trip.serviceDayKind] ?? fail("SERVICE_DAY", trip.providerTripKey),
      sourceDayKey: trip.provenance.weekdayType, servicePattern: trip.servicePattern, headsign: trip.headsign,
      sourceRowNumber: trip.provenance.sourceRowNumbers[0], sourceRowSha256: trip.sourceRowSha256, stops: trip.stops,
    };
  });
  const quarantine = [...result.quarantine, ...result.expressTrips].map((row) => {
    const [, trainNumber, weekdayType] = row.providerTripKey.split("|");
    return { sourceId: KORAIL_TIMETABLE_SOURCE_ID, lineId: row.lineId, routeKey: routeKeyOf.get(row.lineId), trainNumber,
      serviceDayKind: Object.hasOwn(SERVICE_DAY_KIND_BY_WEEKDAY_TYPE, weekdayType) ? SERVICE_DAY_KIND_BY_WEEKDAY_TYPE[weekdayType] : fail("SERVICE_DAY", row.providerTripKey),
      sourceDayKey: weekdayType,
      sourceRowNumber: row.sourceRowNumbers[0], sourceRowSha256: row.sourceRowSha256, reason: row.reason };
  });
  const lineBindings = bindings.map((entry) => {
    const pinned = allowance[entry.routeNumber];
    return {
      lineId: entry.lineId, routeKey: entry.routeNumber, routeName: entry.routeName,
      stationAliases: Object.fromEntries(Object.entries(entry.stationAliases)
        .map(([source, nameKo]) => [source, { nameKo, reason: entry.aliasEvidence[source] }])),
      ...(pinned ? { quarantineAllowance: { reason: EXPRESS_STOP_PATTERN_UNRESOLVED, rowCount: pinned.rowCount,
        rowSetSha256: pinned.rowSetSha256, note: EXPRESS_QUARANTINE_NOTE } } : {}),
    };
  });
  return {
    provider: {
      sourceId: KORAIL_TIMETABLE_SOURCE_ID, sourceSnapshotId: snapshot.snapshotId, rawSha256: snapshot.rawSha256,
      recordsSha256: snapshot.recordsSha256, observedAt,
      dataReferenceDateByLine: Object.fromEntries([...dataReferenceDates]
        .map(([lineId, dates]) => [lineId, [...dates].sort(codepointCompare)]).sort(([left], [right]) => codepointCompare(left, right))),
      trips: trips.sort((left, right) => codepointCompare(left.providerTripKey, right.providerTripKey)),
      quarantine,
    },
    lineBindings,
    expressRowSetSha256ByRoute: Object.fromEntries(bindings.map(({ lineId, routeNumber }) =>
      [routeNumber, rowSetSha256(quarantine.filter((row) => row.lineId === lineId && row.reason === EXPRESS_STOP_PATTERN_UNRESOLVED))])),
  };
}
