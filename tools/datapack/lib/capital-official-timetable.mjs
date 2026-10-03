import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import {
  KRIC_CAPITAL_TIMETABLE_SOURCE_ID,
  kricCapitalOfficialTimetable,
} from "./kric-capital-timetable-records.mjs";
import { materializeOfficialLineTimetables } from "./official-line-timetable.mjs";

// #899: 전국 후보에 수도권 공식 시간표를 싣는다(KRIC 전체_도시철도운행정보, 정차 순서를 명시한 노선).
// 입력은 inventory kric-nationwide-timetable-file.capitalScheduleAdmissionEvidence가 가리키는 snapshot이다.

export const CAPITAL_TIMETABLE_SOURCE_ID = KRIC_CAPITAL_TIMETABLE_SOURCE_ID;
export const CAPITAL_TIMETABLE_EVIDENCE_KEY = "capitalScheduleAdmissionEvidence";
export const CAPITAL_TIMETABLE_REPORT_PATH = "tools/datapack/release/nationwide-capital-timetable-report.json";
export const CAPITAL_TIMETABLE_SERVICE_ID_PREFIX = "kric-capital";
export const CAPITAL_TIMETABLE_TRIP_ID_PREFIX = "kc";
// 노선별 격리 상한. 2026-10-03 실측 최대값은 신림선 4.74%(33/696)다(1호선 고정 집합 제외).
export const CAPITAL_TIMETABLE_MAX_QUARANTINE_RATIO = 0.05;
const CALENDAR_START = "20260101";
const CALENDAR_END = "20261231";

// 4호선 pilot(kric-subway-timetable, 상록수·사당 2정차)은 공식 전 노선 시간표로 교체한다(QA 승인 2026-10-03).
const LINE4_PILOT_SOURCE_ID = "kric-subway-timetable";
const LINE4_PILOT_ROUTE_PREFIX = "route-seoul-4-";
const LINE4_PILOT_SERVICE_IDS = new Set(["weekday-kric", "saturday-kric", "holiday-kric"]);

/** base 팩에서 4호선 pilot 시간표 행과 그 원천 항목을 뺀다. 다른 행이 pilot 달력을 쓰면 실패한다. */
export function removeLine4PilotTimetable(pack) {
  const pilotTripIds = new Set(pack.transitTrips.filter(({ routeId }) => routeId.startsWith(LINE4_PILOT_ROUTE_PREFIX)).map(({ id }) => id));
  const remainingTrips = pack.transitTrips.filter(({ id }) => !pilotTripIds.has(id));
  if (remainingTrips.some(({ serviceId }) => LINE4_PILOT_SERVICE_IDS.has(serviceId))) {
    throw new Error("capital timetable: line 4 pilot calendar is used by a non-pilot trip");
  }
  return {
    ...pack,
    sourceInventory: pack.sourceInventory.filter(({ id }) => id !== LINE4_PILOT_SOURCE_ID),
    serviceCalendars: pack.serviceCalendars.filter(({ serviceId }) => !LINE4_PILOT_SERVICE_IDS.has(serviceId)),
    serviceCalendarDates: pack.serviceCalendarDates.filter(({ serviceId }) => !LINE4_PILOT_SERVICE_IDS.has(serviceId)),
    transitRoutes: pack.transitRoutes.filter(({ id }) => !id.startsWith(LINE4_PILOT_ROUTE_PREFIX)),
    transitTrips: remainingTrips,
    transitStopTimes: pack.transitStopTimes.filter(({ tripId }) => !pilotTripIds.has(tripId)),
  };
}

const REVERIFICATION_KEYS = Object.freeze(["observedAt", "rawSha256", "collectionReceiptSha256"]);
const fail = (code) => { throw new Error(`CAPITAL_TIMETABLE_${code}`); };
const utcInstant = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/**
 * #870: snapshot은 관측 시각과 무관하다. 신선도 기준 관측 시각은 evidence.reverifications(append-only)의
 * 마지막 항목이고 evidence.observedAt과 같아야 한다. 이력은 관측 시각 오름차순이고 마지막 항목은 현재 원본이다.
 */
export function resolveCapitalTimetableObservation({ evidence, snapshot }) {
  if (evidence?.snapshotId !== snapshot?.snapshotId || evidence.rawSha256 !== snapshot.rawSha256
    || evidence.recordsSha256 !== snapshot.recordsSha256) fail("SNAPSHOT");
  validateReverificationHistory(evidence.reverifications);
  const last = evidence.reverifications.at(-1);
  if (last.rawSha256 !== evidence.rawSha256) fail("REVERIFICATIONS");
  if (!utcInstant(evidence.observedAt) || evidence.observedAt !== last.observedAt) fail("OBSERVATION");
  return evidence.observedAt;
}

export function validateReverificationHistory(history) {
  if (!Array.isArray(history) || history.length === 0) fail("REVERIFICATIONS");
  let previous = -Infinity;
  for (const entry of history) {
    if (!entry || JSON.stringify(Object.keys(entry)) !== JSON.stringify(REVERIFICATION_KEYS) || !utcInstant(entry.observedAt)
      || !/^[a-f0-9]{64}$/u.test(entry.rawSha256 ?? "") || !/^[a-f0-9]{64}$/u.test(entry.collectionReceiptSha256 ?? "")
      || Date.parse(entry.observedAt) <= previous) fail("REVERIFICATIONS");
    previous = Date.parse(entry.observedAt);
  }
}

/**
 * 수도권 공식 시간표를 팩 표에 붙일 행으로 만든다.
 * @returns {{ tables: object, report: object, packSource: object }}
 */
export function buildCapitalOfficialTimetable({ pack, snapshot, inventorySource, holidayDates }) {
  const evidence = inventorySource?.[CAPITAL_TIMETABLE_EVIDENCE_KEY];
  if (inventorySource?.id !== CAPITAL_TIMETABLE_SOURCE_ID) {
    throw new Error("capital timetable: inventory admission evidence does not match the snapshot");
  }
  const observedAt = resolveCapitalTimetableObservation({ evidence, snapshot });
  const { provider, lineBindings } = kricCapitalOfficialTimetable(snapshot, { observedAt });
  const result = materializeOfficialLineTimetables({
    pack,
    provider,
    lineBindings,
    serviceIdPrefix: CAPITAL_TIMETABLE_SERVICE_ID_PREFIX,
    tripIdPrefix: CAPITAL_TIMETABLE_TRIP_ID_PREFIX,
    holidayDates,
    startDate: CALENDAR_START,
    endDate: CALENDAR_END,
    maxQuarantineRatio: CAPITAL_TIMETABLE_MAX_QUARANTINE_RATIO,
  });
  const lineIds = lineBindings.map(({ lineId }) => lineId);
  const report = {
    schemaVersion: 1,
    artifactKind: "datapack-capital-timetable-report",
    issue: "https://github.com/AquilaXk/easysubway-data/issues/899",
    source: {
      sourceId: provider.sourceId,
      snapshotId: provider.sourceSnapshotId,
      rawSha256: provider.rawSha256,
      recordsSha256: provider.recordsSha256,
      observedAt: provider.observedAt,
    },
    contract: {
      stopOrder: "원천 역명 칸이 명시한 정차 순서(001..N 순번 또는 역 코드 토큰 순서)를 그대로 쓴다.",
      stopTime: "도착·출발 중 원천 값이 하나뿐인 정차는 그 값을 정차 시각(도착 = 출발)으로 쓰고 stop_time.timeSource에 SINGLE_PROVIDER_TIME_ARRIVAL/DEPARTURE로 표기한다(QA 결정 2026-10-03). 노선별 건수는 lines[].singleProviderTimeStopCount. 둘 다 없으면 격리한다. 기점 도착·종점 출발 00:00은 원천 자리표시라 미제공으로 본다.",
      serviceDay: "04시 전 시각(24시 미만 표기)은 전날 운행일의 심야 시각이다(+24h).",
      quarantine: `시각 역전·문법 오류·일반열차 비인접 정차 행은 적재하지 않는다. 노선별 상한 ${CAPITAL_TIMETABLE_MAX_QUARANTINE_RATIO}(고정 집합 제외), 초과 시 실패.`,
    },
    lines: result.lineSummaries,
    summary: {
      lineCount: result.lineSummaries.length,
      admittedTripCount: result.transitTrips.length,
      admittedStopTimeCount: result.transitStopTimes.length,
      quarantinedCount: result.quarantine.length,
    },
    rows: result.quarantine,
  };
  const scope = evidence.coverageScope;
  if (!Array.isArray(scope?.lineIds) || JSON.stringify([...scope.lineIds].sort(codepointCompare)) !== JSON.stringify([...lineIds].sort(codepointCompare))) {
    throw new Error("capital timetable: inventory admission evidence lineIds do not match the loaded lines");
  }
  const packSource = {
    id: CAPITAL_TIMETABLE_SOURCE_ID,
    owner: inventorySource.owner,
    url: inventorySource.datasetUrl,
    license: inventorySource.license.name,
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: inventorySource.updateFrequency,
    updatedAt: observedAt,
    fields: ["service_calendar", "trip", "stop_time"],
    coverageScope: structuredClone(scope),
  };
  const { quarantine, lineSummaries, ...tables } = result;
  return { tables, report, packSource };
}
