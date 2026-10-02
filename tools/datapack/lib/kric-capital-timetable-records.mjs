import { createHash } from "node:crypto";

import { codepointCompare } from "../../lib/codepoint-compare.mjs";

// #899: KRIC 전체_도시철도운행정보(파일 id 900)에서 정차 순서를 열차별로 명시한 수도권 노선만 읽는다.
// 이 모듈은 원천 행을 원천 중립 정규화 trip(lib/official-line-timetable.mjs 입력)으로 바꾼다.
// 시각·정차·순서를 추정하지 않는다. 문법이 다르거나 시각이 역전된 행은 사유와 함께 격리한다.

export const KRIC_CAPITAL_TIMETABLE_SOURCE_ID = "kric-nationwide-timetable-file";
export const KRIC_CAPITAL_TIMETABLE_SNAPSHOT_KIND = "kric-capital-timetable-snapshot";

const SERVICE_DAY = Object.freeze({
  WEEKDAY: "WEEKDAY",
  SATURDAY: "SATURDAY",
  SUNDAY_HOLIDAY: "SUNDAY_HOLIDAY",
  WEEKEND_HOLIDAY: "WEEKEND_HOLIDAY",
});

// 원천 요일구분 문자열 → 운행일 종류. 노선마다 원천 표기가 달라 노선별로 고정한다(표에 없는 값은 실패).
const SEOUL_DAYS = Object.freeze({ 평일: SERVICE_DAY.WEEKDAY, "토요일+공휴일": SERVICE_DAY.WEEKEND_HOLIDAY });
const WEEKDAY_HOLIDAY_DAYS = Object.freeze({ 평일: SERVICE_DAY.WEEKDAY, 휴일: SERVICE_DAY.WEEKEND_HOLIDAY });

// 원천 운행유형 → 팩 service_pattern. 표에 없는 값은 실패한다.
const SERVICE_PATTERNS = Object.freeze({ 일반: "LOCAL", 급행: "EXPRESS", 직통: "EXPRESS" });

// 시각 칸 문법. kv: "001-05:30" 토큰을 "+"로 잇는다. pairs: "001+05:30+002+05:35"처럼 키와 시각을 번갈아 둔다.
const GRAMMAR = Object.freeze({ KV_PLUS: "kv-plus", PAIRS_PLUS: "pairs-plus" });

// stopKeys: SEQUENCE는 정차 키가 001..N 순번이다. CELL_ORDER는 정차 키가 원천 역 코드이고 정차 순서는
// 원천 역명 칸에 적힌 토큰 순서다(9호선·신분당선). 두 경우 모두 순서를 원천이 명시하며 추정하지 않는다.
const STOP_KEYS = Object.freeze({ SEQUENCE: "SEQUENCE", CELL_ORDER: "CELL_ORDER" });

// stationAliases: 원천 역명 → 팩 역명(stations.nameKo). 근거는 같은 노선 팩 역 목록에 원천 표기가 없고
// 괄호 부역명·"역" 접미사·가운뎃점 표기만 다른 경우다. 표에 없는 미매칭 역명은 노선 적재를 실패시킨다.
export const KRIC_CAPITAL_ROUTE_PROFILES = Object.freeze([
  profile("S1101", "서울 도시철도 1호선", "line-472a81add377", SEOUL_DAYS, [GRAMMAR.KV_PLUS], {}, STOP_KEYS.SEQUENCE, {
    // 2026-10-03 실측(원천 sha256 218f76dd…): 이 453행은 역명 순서가 섞이고 도착 칸이 00:00 자리표시라 시각이
    // 역전된다. 복원하려면 추정이 필요하므로 적재하지 않는다. 원천 운행유형 표기는 모두 "일반"이라 필드로는
    // 가를 수 없어 행 집합을 고정한다. 원천이 바뀌어 건수·행 집합이 달라지면 적재가 실패한다(QA 승인 2026-10-03).
    reason: "TIME_NOT_MONOTONIC",
    rowCount: 453,
    rowSetSha256: "b4e52aa34d7c7d9c1be37edf2f7ce18e3ffc9265de03a51beb542eaf7864f06d",
    note: "1호선 원천 손상 행 453건 미적재(원천 운행유형 표기는 '일반', 기종점 패턴상 급행 계열로 판단), #902에서 보강",
  }),
  profile("S1102", "서울 도시철도 2호선", "seoul-2", SEOUL_DAYS, [GRAMMAR.KV_PLUS], {}),
  profile("S1103", "서울 도시철도 3호선", "line-41a8c75ec9d8", SEOUL_DAYS, [GRAMMAR.KV_PLUS], {}),
  profile("S1104", "서울 도시철도 4호선", "seoul-4", SEOUL_DAYS, [GRAMMAR.KV_PLUS], {}),
  profile("S1105", "서울 도시철도 5호선", "line-80fc4d5350d4", SEOUL_DAYS, [GRAMMAR.KV_PLUS], {
    하남검단산: { nameKo: "하남검단산역", reason: "팩 역명에 '역' 접미사가 붙은 같은 역(5호선 종착)" },
  }),
  profile("S1106", "서울 도시철도 6호선", "line-3f41718e0833", SEOUL_DAYS, [GRAMMAR.KV_PLUS], {}),
  profile("S1107", "서울 도시철도 7호선", "line-15b3b8a93259", SEOUL_DAYS, [GRAMMAR.KV_PLUS], {
    석남: { nameKo: "석남(거북시장)", reason: "팩 역명이 부역명 괄호를 포함한 같은 역(7호선 종착)" },
    이수: { nameKo: "총신대입구", reason: "7호선 이수역의 팩 역명(4호선 총신대입구와 같은 환승역)" },
  }),
  profile("S1108", "서울 도시철도 8호선", "line-2b2d9eaa53d0", SEOUL_DAYS, [GRAMMAR.KV_PLUS], {}),
  profile("S1109", "서울 도시철도 9호선", "line-f0e747248a31", WEEKDAY_HOLIDAY_DAYS, [GRAMMAR.KV_PLUS], {
    "마곡나루(서울식물원)": { nameKo: "마곡나루", reason: "원천 표기가 부역명 괄호를 포함한 같은 역" },
    "동작(현충원)": { nameKo: "동작", reason: "원천 표기가 부역명 괄호를 포함한 같은 역" },
    "흑석(중앙대입구)": { nameKo: "흑석", reason: "원천 표기가 부역명 괄호를 포함한 같은 역" },
  }, STOP_KEYS.CELL_ORDER),
  profile("I11D1", "신분당선", "shinbundang", Object.freeze({
    평일: SERVICE_DAY.WEEKDAY, 토요일: SERVICE_DAY.SATURDAY, 공휴일: SERVICE_DAY.SUNDAY_HOLIDAY,
  }), [GRAMMAR.KV_PLUS], {}, STOP_KEYS.CELL_ORDER),
  profile("L11UI", "수도권 경량도시철도 우이신설선", "line-30886152e4f8", Object.freeze({
    평일: SERVICE_DAY.WEEKDAY, "토요일+휴일": SERVICE_DAY.WEEKEND_HOLIDAY,
  }), [GRAMMAR.KV_PLUS], {}),
  profile("L11SL", "수도권 경량도시철도 신림선", "line-aefa08ccc0a9", Object.freeze({
    평일: SERVICE_DAY.WEEKDAY, "주말+공휴일": SERVICE_DAY.WEEKEND_HOLIDAY,
  }), [GRAMMAR.KV_PLUS], {
    샛강역: { nameKo: "샛강", reason: "원천 표기에 '역' 접미사가 붙은 같은 역(신림선 기점)" },
  }),
  profile("I28A1", "인천국제공항선", "line-e9e9a5b520a4", WEEKDAY_HOLIDAY_DAYS, [GRAMMAR.PAIRS_PLUS], {
    서울: { nameKo: "서울역", reason: "공항철도 서울역의 원천 표기('역' 접미사 없음)" },
  }),
]);

function profile(routeNumber, routeName, lineId, serviceDays, grammars, stationAliases, stopKeys = STOP_KEYS.SEQUENCE, quarantineAllowance = null) {
  return Object.freeze({
    routeNumber, routeName, lineId, serviceDays, stopKeys, grammars: Object.freeze([...grammars]),
    quarantineAllowance: quarantineAllowance ? Object.freeze({ ...quarantineAllowance }) : null,
    stationAliases: Object.freeze(Object.fromEntries(Object.entries(stationAliases)
      .map(([sourceName, alias]) => [sourceName, Object.freeze({ ...alias })]))),
  });
}

const PROFILE_BY_KEY = new Map(KRIC_CAPITAL_ROUTE_PROFILES.map((entry) => [profileKey(entry.routeNumber, entry.routeName), entry]));
function profileKey(routeNumber, routeName) { return `${routeNumber}\u0000${routeName}`; }

const SHA256 = /^[a-f0-9]{64}$/u;
const STOP_KEY = /^\d{3}$/u;
const CODE_KEY = /^[A-Za-z0-9]{1,8}$/u;
const ABSENT_TIME = /^ *: *$/u;
const TIME = /^(\d{1,2}):(\d{2})$/u;
// 원천 운행일은 첫차(04시 이후)부터다. 24시 미만으로 적은 00~03시 시각은 전날 운행일의 심야 시각이다.
const SERVICE_DAY_START_HOUR = 4;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, detail = "") => { throw new Error(`KRIC_CAPITAL_TIMETABLE_${code}${detail ? `: ${detail}` : ""}`); };

const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "rawByteLength", "rawSha256", "observationRecordsSha256",
  "routes", "recordCount", "recordsSha256", "records",
]);
const SNAPSHOT_RECORD_FIELDS = Object.freeze([
  "trainNumber", "routeNumber", "routeName", "originStationName", "destinationStationName", "serviceType",
  "weekdayType", "stationName", "arrivalTime", "departureTime", "dataReferenceDate", "sourceRowNumber", "sourceRowSha256",
]);

/**
 * buildKricNationwideTimetableObservation 결과에서 수도권 대상 노선 행만 골라 커밋할 snapshot을 만든다.
 * 셀 값은 원문 그대로 둔다(문자열 셀 value만, 숫자 셀은 cellType과 함께).
 * #870: snapshot은 원본 내용만 담고 관측 시각·수집 파일명과 무관하다. 같은 원본을 다시 관측하면 같은 바이트다.
 * 관측 시각은 inventory evidence의 append-only 재확인 이력(reverifications)이 정한다.
 */
export function projectKricCapitalTimetableSnapshot(observation) {
  if (observation?.artifactKind !== "kric-nationwide-timetable-observation"
    || observation.sourceId !== KRIC_CAPITAL_TIMETABLE_SOURCE_ID
    || !SHA256.test(observation.rawSha256 ?? "") || !SHA256.test(observation.recordsSha256 ?? "")
    || !Number.isFinite(Date.parse(observation.observedAt)) || !Array.isArray(observation.records)) {
    fail("OBSERVATION");
  }
  const records = observation.records
    .filter((record) => PROFILE_BY_KEY.has(profileKey(record.routeNumber, record.routeName)))
    .map((record) => Object.fromEntries(SNAPSHOT_RECORD_FIELDS.map((field) => [field, projectedField(record, field)])))
    .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
  for (const entry of KRIC_CAPITAL_ROUTE_PROFILES) {
    if (!records.some((record) => record.routeNumber === entry.routeNumber && record.routeName === entry.routeName)) {
      fail("ROUTE_MISSING", `${entry.routeNumber} ${entry.routeName}`);
    }
  }
  const recordsSha256 = sha256(Buffer.from(`${JSON.stringify(records)}\n`));
  return {
    schemaVersion: 2,
    artifactKind: KRIC_CAPITAL_TIMETABLE_SNAPSHOT_KIND,
    sourceId: KRIC_CAPITAL_TIMETABLE_SOURCE_ID,
    snapshotId: `${KRIC_CAPITAL_TIMETABLE_SOURCE_ID}-capital-${recordsSha256}`,
    rawByteLength: observation.rawByteLength,
    rawSha256: observation.rawSha256,
    observationRecordsSha256: observation.recordsSha256,
    routes: KRIC_CAPITAL_ROUTE_PROFILES.map(({ routeNumber, routeName, lineId }) => ({ routeNumber, routeName, lineId })),
    recordCount: records.length,
    recordsSha256,
    records,
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
  if (field === "arrivalTime" || field === "departureTime") {
    // 빈 시각 칸(공항철도·의정부 도착 등)은 관측 행에서 cellType "n"·빈 문자열이다.
    if (value?.cellType === "n" && value.value === "") return "";
    if (value?.cellType !== "s" || typeof value.value !== "string" || value.value === "") fail("RECORD", field);
    return value.value;
  }
  if (field === "dataReferenceDate") {
    if (!value || typeof value.value !== "string" || !["s", "n"].includes(value.cellType)) fail("RECORD", field);
    return { cellType: value.cellType, value: value.value };
  }
  if (typeof value !== "string" || value.length === 0) fail("RECORD", field);
  return value;
}

/** 커밋된 snapshot이 자기 식별자·해시와 맞는지 확인한다. */
export function validateKricCapitalTimetableSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 2 || snapshot.artifactKind !== KRIC_CAPITAL_TIMETABLE_SNAPSHOT_KIND
    || JSON.stringify(Object.keys(snapshot)) !== JSON.stringify(SNAPSHOT_KEYS)
    || snapshot.sourceId !== KRIC_CAPITAL_TIMETABLE_SOURCE_ID || !Array.isArray(snapshot.records)
    || !SHA256.test(snapshot.rawSha256 ?? "") || !Number.isSafeInteger(snapshot.rawByteLength) || snapshot.rawByteLength <= 0) {
    fail("SNAPSHOT");
  }
  const recordsSha256 = sha256(Buffer.from(`${JSON.stringify(snapshot.records)}\n`));
  if (snapshot.recordsSha256 !== recordsSha256 || snapshot.recordCount !== snapshot.records.length
    || snapshot.snapshotId !== `${KRIC_CAPITAL_TIMETABLE_SOURCE_ID}-capital-${recordsSha256}`) {
    fail("SNAPSHOT_HASH");
  }
  const expectedRoutes = KRIC_CAPITAL_ROUTE_PROFILES.map(({ routeNumber, routeName, lineId }) => ({ routeNumber, routeName, lineId }));
  if (JSON.stringify(snapshot.routes) !== JSON.stringify(expectedRoutes)) fail("SNAPSHOT_ROUTES");
  return snapshot;
}

/**
 * snapshot 행을 정규화 trip으로 바꾼다. 문법·시각 검증에 실패한 행은 trip을 만들지 않고 quarantine에 남긴다.
 * 반환: { provider, lineBindings }. provider/lineBindings는 materializeOfficialLineTimetables 입력이다.
 */
export function kricCapitalOfficialTimetable(snapshot, { observedAt } = {}) {
  validateKricCapitalTimetableSnapshot(snapshot);
  // #870: 관측 시각은 snapshot이 아니라 호출자(inventory evidence의 최신 재확인)가 준다.
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) fail("OBSERVED_AT");
  const trips = [];
  const quarantine = [];
  const dataReferenceDates = new Map();
  for (const record of snapshot.records) {
    const entry = PROFILE_BY_KEY.get(profileKey(record.routeNumber, record.routeName));
    if (!entry) fail("ROUTE_UNKNOWN", `${record.routeNumber} ${record.routeName}`);
    const referenceDate = dataReferenceDate(record.dataReferenceDate);
    const dates = dataReferenceDates.get(entry.lineId) ?? new Set();
    dates.add(referenceDate);
    dataReferenceDates.set(entry.lineId, dates);
    const serviceDayKind = entry.serviceDays[record.weekdayType];
    if (!serviceDayKind) fail("SERVICE_DAY_UNKNOWN", `${record.routeNumber} ${record.weekdayType}`);
    const servicePattern = SERVICE_PATTERNS[record.serviceType];
    if (!servicePattern) fail("SERVICE_TYPE_UNKNOWN", `${record.routeNumber} ${record.serviceType}`);
    const parsed = parseRecordStops(record, entry);
    if (parsed.reason) {
      quarantine.push(quarantineRow(record, entry, serviceDayKind, parsed.reason));
      continue;
    }
    trips.push({
      lineId: entry.lineId,
      routeKey: record.routeNumber,
      providerTripKey: `${record.routeNumber}:${record.weekdayType}:${record.trainNumber}:${record.sourceRowSha256.slice(0, 12)}`,
      trainNumber: record.trainNumber,
      serviceDayKind,
      sourceDayKey: record.weekdayType,
      servicePattern,
      headsign: record.destinationStationName,
      sourceRowNumber: record.sourceRowNumber,
      sourceRowSha256: record.sourceRowSha256,
      stops: parsed.stops,
    });
  }
  trips.sort((left, right) => codepointCompare(left.providerTripKey, right.providerTripKey));
  return {
    provider: {
      sourceId: KRIC_CAPITAL_TIMETABLE_SOURCE_ID,
      sourceSnapshotId: snapshot.snapshotId,
      rawSha256: snapshot.rawSha256,
      recordsSha256: snapshot.recordsSha256,
      observedAt,
      dataReferenceDateByLine: Object.fromEntries([...dataReferenceDates]
        .map(([lineId, dates]) => [lineId, [...dates].sort(codepointCompare)])
        .sort(([left], [right]) => codepointCompare(left, right))),
      trips,
      quarantine,
    },
    lineBindings: KRIC_CAPITAL_ROUTE_PROFILES.map((entry) => ({
      lineId: entry.lineId,
      routeKey: entry.routeNumber,
      routeName: entry.routeName,
      stationAliases: entry.stationAliases,
      ...(entry.quarantineAllowance ? { quarantineAllowance: entry.quarantineAllowance } : {}),
    })),
  };
}

function quarantineRow(record, entry, serviceDayKind, reason) {
  return {
    sourceId: KRIC_CAPITAL_TIMETABLE_SOURCE_ID,
    lineId: entry.lineId,
    routeKey: record.routeNumber,
    trainNumber: record.trainNumber,
    serviceDayKind,
    sourceDayKey: record.weekdayType,
    sourceRowNumber: record.sourceRowNumber,
    sourceRowSha256: record.sourceRowSha256,
    reason,
  };
}

// 엑셀 날짜 일련번호(1900 체계) 또는 YYYY-MM-DD 문자열을 ISO 날짜로 바꾼다.
function dataReferenceDate(cell) {
  if (cell?.cellType === "n") {
    if (!/^\d{5}$/u.test(cell.value)) fail("REFERENCE_DATE", cell.value);
    return new Date(Date.UTC(1899, 11, 30) + Number(cell.value) * 86_400_000).toISOString().slice(0, 10);
  }
  if (cell?.cellType === "s" && /^\d{4}-\d{2}-\d{2}$/u.test(cell.value)) return cell.value;
  fail("REFERENCE_DATE", String(cell?.value));
}

function parseRecordStops(record, entry) {
  const names = parseNameCell(record.stationName, entry.stopKeys === STOP_KEYS.SEQUENCE ? STOP_KEY : CODE_KEY);
  if (!names) return { reason: "STATION_CELL_GRAMMAR" };
  const keys = [...names.keys()];
  if (keys.length < 2) return { reason: "FEWER_THAN_TWO_STOPS" };
  if (entry.stopKeys === STOP_KEYS.SEQUENCE && keys.some((key, index) => Number(key) !== index + 1)) return { reason: "STOP_KEY_SEQUENCE" };
  const arrivals = parseTimeCell(record.arrivalTime, entry.grammars);
  const departures = parseTimeCell(record.departureTime, entry.grammars);
  if (!arrivals || !departures) return { reason: "TIME_CELL_GRAMMAR" };
  for (const key of [...arrivals.keys(), ...departures.keys()]) if (!names.has(key)) return { reason: "TIME_KEY_UNKNOWN" };
  const stops = [];
  let previous = -1;
  for (const [index, key] of keys.entries()) {
    let arrival = arrivals.get(key) ?? null;
    let departure = departures.get(key) ?? null;
    // 원천은 기점 도착·종점 출발을 00:00 자리표시로 적는다. 그 두 칸에서만 미제공으로 본다.
    if (index === 0 && arrival === "00:00") arrival = null;
    if (index === keys.length - 1 && departure === "00:00") departure = null;
    const arrivalSeconds = arrival === null ? null : serviceSeconds(arrival);
    const departureSeconds = departure === null ? null : serviceSeconds(departure);
    if (arrivalSeconds === null && departureSeconds === null) return { reason: "STOP_WITHOUT_TIME" };
    for (const seconds of [arrivalSeconds, departureSeconds]) {
      if (seconds === null) continue;
      if (seconds < previous) return { reason: "TIME_NOT_MONOTONIC" };
      previous = seconds;
    }
    stops.push({ stationName: names.get(key), arrivalSeconds, departureSeconds });
  }
  return { stops };
}

function parseNameCell(value, keyPattern) {
  if (typeof value !== "string" || value.length === 0) return null;
  const result = new Map();
  for (const token of value.split("+")) {
    const match = /^([A-Za-z0-9]+)-(.+)$/u.exec(token);
    if (!match || !keyPattern.test(match[1]) || !match[2].trim() || result.has(match[1])) return null;
    result.set(match[1], match[2]);
  }
  return result;
}

function parseTimeCell(value, grammars) {
  if (value === "") return new Map();
  if (typeof value !== "string") return null;
  for (const grammar of grammars) {
    const parsed = grammar === GRAMMAR.PAIRS_PLUS ? parsePairs(value) : parseKv(value);
    if (parsed) return parsed;
  }
  return null;
}

function parseKv(value) {
  const result = new Map();
  for (const token of value.split("+")) {
    const match = /^([A-Za-z0-9]{1,8})-(.*)$/u.exec(token);
    if (!match || result.has(match[1])) return null;
    if (ABSENT_TIME.test(match[2])) continue; // 원천의 미제공 표기(":", 공백 포함 "  :  ")
    if (!validTime(match[2])) return null;
    result.set(match[1], match[2]);
  }
  return result;
}

function parsePairs(value) {
  const tokens = value.split("+");
  if (tokens.length % 2 !== 0) return null;
  const result = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    if (!STOP_KEY.test(tokens[index]) || result.has(tokens[index]) || !validTime(tokens[index + 1])) return null;
    result.set(tokens[index], tokens[index + 1]);
  }
  return result;
}

function validTime(value) {
  const match = TIME.exec(value);
  return Boolean(match) && Number(match[2]) < 60 && Number(match[1]) < 30;
}

function serviceSeconds(value) {
  const [, hours, minutes] = TIME.exec(value);
  const hour = Number(hours);
  return (hour < SERVICE_DAY_START_HOUR ? hour + 24 : hour) * 3600 + Number(minutes) * 60;
}

export const KRIC_CAPITAL_SERVICE_DAY = SERVICE_DAY;
