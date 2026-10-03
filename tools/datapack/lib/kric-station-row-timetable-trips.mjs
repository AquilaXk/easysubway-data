import { createHash } from "node:crypto";
import { codepointCompare } from "../../lib/codepoint-compare.mjs";

// KRIC 전국 도시철도 운행정보 파일(id=900)의 코레일 행은 "열차 × 정차역" 한 행이며 정차 순서 열이 없다.
// 열차번호+요일구분으로 묶고 원천 행 순서를 정차 순서로 쓰되, 시각 순서(자정 넘김 포함)와 일치할 때만
// 채택한다. 둘이 어긋나면 그 열차는 quarantine한다. 정차 순서나 시각을 추정·보정하지 않는다.
// 급행 행은 통과역 시각까지 담고 있어 정차·통과를 구분할 수 없으므로 적재하지 않는다(#902에서 보강).

export const EXPRESS_STOP_PATTERN_UNRESOLVED = "EXPRESS_STOP_PATTERN_UNRESOLVED";
export const EXPRESS_QUARANTINE_NOTE = "급행 정차·통과 구분 불가, #902에서 보강";
export const LOCAL_QUARANTINE_RATIO_LIMIT = 0.05;
export const HOLIDAY_INCLUDES_SATURDAY_POLICY = "QA 확정 정책(2026-10-03): KRIC dayCd 9 '휴일' = 토·일·공휴일. dayCd 7(토) 무응답 기관은 휴일 시간표 적용";

const SECONDS_PER_DAY = 86_400;
const HALF_DAY = SECONDS_PER_DAY / 2;
const SERIAL_TOLERANCE_SECONDS = 1e-3;
const DAY_FRACTION = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const SERVICE_DAY_KIND_BY_WEEKDAY_TYPE = Object.freeze({ "평일": "WEEKDAY", "휴일": "SATURDAY_SUNDAY_HOLIDAY" });
const SERVICE_PATTERN_BY_TYPE = Object.freeze({ "일반": "LOCAL", "급행": "EXPRESS" });

const KRIC_ABBREVIATION = "KRIC 파일 900 코레일 행의 역명 칸 축약 표기";

/**
 * 원천 노선번호 → 팩 노선 고정 바인딩. alias는 원천 역명 → 같은 노선 팩 역명이며 1:1이다.
 * 근거: 2026-10-03 실측(파일 sha 218f76…)에서 각 노선의 미매칭 원천 역명과 원천에 없는 팩 소속 역명이
 * 정확히 같은 개수로 남았고, 아래 대응 외의 조합은 없었다. 대응을 적용한 전 일반열차가 팩 RIDE 간선상
 * 인접역 정차 검증(validateStationRowTripsAgainstPack)을 통과했다.
 */
export const KORAIL_STATION_ROW_BINDINGS = Object.freeze([
  binding("I41WS", "서해선", "line-051552e50435", {
    "부천종": ["부천종합운동장", "앞 3자 축약"], "시흥능": ["시흥능곡", "앞 3자 축약"], "시흥대": ["시흥대야", "앞 3자 축약"],
    "시흥청": ["시흥시청", "'시흥'+'청' 축약"], "신김포": ["김포공항", "서해선 승강장을 구분하는 '신' 접두와 '김포' 축약; 서해선 김포공항역"],
    "신소사": ["소사", "서해선 승강장을 구분하는 '신' 접두"], "신신천": ["신천", "서해선 승강장을 구분하는 '신' 접두"],
    "신신현": ["신현", "서해선 승강장을 구분하는 '신' 접두"], "신초지": ["초지", "서해선 승강장을 구분하는 '신' 접두"],
  }, { rowCount: 0, rowSetSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" }),
  binding("I41K2", "경춘선", "line-54a7b980b7c3", {
    "평내호": ["평내호평", "앞 3자 축약"],
  }, { rowCount: 120, rowSetSha256: "187ca005afaf3701d9d11bf16f3bced26af0522312bc31d3320ea3273cd408bc" }),
  binding("I28K1", "수인분당선", "line-558d0bd8312d", {
    "강남구": ["강남구청", "앞 3자 축약"], "구룡역": ["구룡", "'역' 접미 포함 표기"], "대모산": ["대모산입구", "앞 3자 축약"],
    "로데오": ["압구정로데오", "뒤 3자 축약"], "매탄권": ["매탄권선", "앞 3자 축약"], "수원시": ["수원시청", "앞 3자 축약"],
    "신수원": ["수원", "수인분당선 승강장을 구분하는 '신' 접두"], "신길온": ["신길온천", "앞 3자 축약"],
    "남동인": ["남동인더스파크", "앞 3자 축약"], "소래포": ["소래포구", "앞 3자 축약"],
    "신인천": ["인천", "수인분당선 승강장을 구분하는 '신' 접두"], "인천논": ["인천논현", "앞 3자 축약"],
  }, { rowCount: 632, rowSetSha256: "aff75517f52e3672492587602eed5a110728d42875e1b2dfd032f649223c3b19" }),
  binding("I4108", "경의중앙선", "line-6e39be0cb6e2", {
    "디엠시": ["디지털미디어시티", "영문 약칭(DMC) 한글 표기"], "서울": ["서울역", "경의선 서울역 정차; 팩 역명은 '서울역'"],
    "항공대": ["한국항공대", "앞 '한국' 생략"], "1양원": ["양원", "동명 역 구분 숫자 접두"], "1양정": ["양정", "동명 역 구분 숫자 접두"],
    "홍대입": ["홍대입구", "앞 3자 축약"], "효창공": ["효창공원앞", "앞 3자 축약"],
  }, { rowCount: 905, rowSetSha256: "bc89dc3eb6a43095cc24d399215224fb60ef84eee8e14e8e838c64c317b1a4ee" }),
  binding("I41K5", "경강선", "line-e4939a4b4713", {
    "경광주": ["경기광주", "'경기' 축약"], "도예촌": ["신둔도예촌", "뒤 3자 축약"], "세종릉": ["세종대왕릉", "'대왕' 생략 축약"],
    "신이매": ["이매", "경강선 승강장을 구분하는 '신' 접두"], "신판교": ["판교", "경강선 승강장을 구분하는 '신' 접두"],
  }, { rowCount: 0, rowSetSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" }),
  binding("I26K6", "동해선", "line-f52eb59d8497", {
    "거제해": ["거제해맞이", "앞 3자 축약"], "부교대": ["교대", "부산 지역 동명 역 구분 '부' 접두"],
    "부산원": ["부산원동", "앞 3자 축약"], "신해운": ["신해운대", "앞 3자 축약"], "오시리": ["오시리아", "앞 3자 축약"],
  }, { rowCount: 0, rowSetSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" }),
]);

function binding(routeNumber, routeName, lineId, aliases, expressQuarantine) {
  return Object.freeze({
    routeNumber, routeName, lineId, routeIdPrefix: `route-kric-${routeNumber.toLowerCase()}`,
    stationAliases: Object.freeze(Object.fromEntries(Object.entries(aliases).map(([from, [to]]) => [from, to]))),
    aliasEvidence: Object.freeze(Object.fromEntries(Object.entries(aliases).map(([from, [, reason]]) => [from, `${KRIC_ABBREVIATION}: ${reason}`]))),
    expressQuarantine: Object.freeze(expressQuarantine),
  });
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** 고정 대상 행 집합의 결정적 해시. 행 내용 해시를 정렬해 묶는다. */
export function rowSetSha256(records) {
  return sha256(JSON.stringify(records.map(({ sourceRowSha256 }) => sourceRowSha256).sort(codepointCompare)));
}

/** 원천 시각 칸(Excel 일 분수)을 초로 바꾼다. 빈 칸은 null이며, 초 단위가 아닌 값은 거부한다. */
export function parseKricDayFractionSeconds(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return null;
  if (!DAY_FRACTION.test(text)) throw new Error(`INVALID_DAY_FRACTION: ${raw}`);
  const scaled = Number(text) * SECONDS_PER_DAY;
  const seconds = Math.round(scaled);
  if (!Number.isFinite(scaled) || scaled < 0 || seconds >= SECONDS_PER_DAY
    || Math.abs(scaled - seconds) > SERIAL_TOLERANCE_SECONDS) throw new Error(`INVALID_DAY_FRACTION: ${raw}`);
  return seconds;
}

function excelSerialDate(raw) {
  const serial = Number(raw);
  if (!Number.isSafeInteger(serial) || serial <= 0) throw new Error(`INVALID_DATA_REFERENCE_DATE: ${raw}`);
  return new Date(Date.UTC(1899, 11, 30) + serial * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
}

/**
 * 바인딩된 노선번호의 행만 정규화 trip으로 재구성한다. 바인딩되지 않은 노선번호 행은 쓰지 않는다.
 * @returns {{ trips, quarantine, expressQuarantine, summary }}
 */
export function buildKorailStationRowTrips({ records, bindings = KORAIL_STATION_ROW_BINDINGS }) {
  if (!Array.isArray(records) || !Array.isArray(bindings) || bindings.length === 0) throw new Error("STATION_ROW_INPUT_INVALID");
  const byRoute = new Map(bindings.map((entry) => [entry.routeNumber, entry]));
  if (byRoute.size !== bindings.length || new Set(bindings.map(({ lineId }) => lineId)).size !== bindings.length) {
    throw new Error("STATION_ROW_BINDINGS_DUPLICATED");
  }
  const groups = new Map();
  for (const record of records) {
    const entry = byRoute.get(record?.routeNumber);
    if (!entry) continue;
    if (record.routeName !== entry.routeName) throw new Error(`ROUTE_NAME_MISMATCH: ${record.routeNumber} ${record.routeName}`);
    if (!Object.hasOwn(SERVICE_DAY_KIND_BY_WEEKDAY_TYPE, record.weekdayType)) throw new Error(`UNSUPPORTED_WEEKDAY_TYPE: ${record.weekdayType}`);
    if (!Object.hasOwn(SERVICE_PATTERN_BY_TYPE, record.serviceType)) throw new Error(`UNSUPPORTED_SERVICE_TYPE: ${record.serviceType}`);
    if (!Number.isSafeInteger(record.sourceRowNumber) || !/^[a-f0-9]{64}$/u.test(record.sourceRowSha256 ?? "")) {
      throw new Error(`SOURCE_ROW_EVIDENCE_INVALID: ${record.routeNumber} ${record.trainNumber}`);
    }
    const key = `${record.routeNumber}|${record.trainNumber}|${record.weekdayType}`;
    if (!groups.has(key)) groups.set(key, { entry, key, rows: [] });
    groups.get(key).rows.push(record);
  }

  const trips = [];
  const quarantine = [];
  const expressRows = new Map(bindings.map(({ lineId }) => [lineId, []]));
  const expressTrips = new Map(bindings.map(({ lineId }) => [lineId, 0]));
  const expressTripRows = [];
  for (const { entry, key, rows } of groups.values()) {
    const ordered = [...rows].sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
    if (ordered.some((row) => row.serviceType !== ordered[0].serviceType)) {
      quarantine.push(quarantined(entry, key, ordered, "TRIP_ATTRIBUTES_INCONSISTENT"));
      continue;
    }
    if (ordered[0].serviceType === "급행") {
      expressRows.get(entry.lineId).push(...ordered);
      expressTrips.set(entry.lineId, expressTrips.get(entry.lineId) + 1);
      expressTripRows.push(quarantined(entry, key, ordered, EXPRESS_STOP_PATTERN_UNRESOLVED));
      continue;
    }
    const outcome = reconstructTrip(entry, key, ordered);
    if (outcome.reason) quarantine.push(quarantined(entry, key, ordered, outcome.reason));
    else trips.push(outcome.trip);
  }

  const summary = {};
  const expressQuarantine = {};
  for (const entry of bindings) {
    const localTrips = trips.filter(({ lineId }) => lineId === entry.lineId).length;
    const localQuarantined = quarantine.filter(({ lineId }) => lineId === entry.lineId).length;
    const express = expressRows.get(entry.lineId);
    const pinned = entry.expressQuarantine;
    const observedSha = rowSetSha256(express);
    if (pinned?.rowCount !== express.length || pinned.rowSetSha256 !== observedSha) {
      throw new Error(`EXPRESS_QUARANTINE_ROW_SET_CHANGED: ${entry.routeNumber} rows=${express.length} sha=${observedSha}`);
    }
    if (localTrips === 0) throw new Error(`NO_TRIPS: ${entry.lineId}`);
    const total = localTrips + localQuarantined;
    if (localQuarantined / total > LOCAL_QUARANTINE_RATIO_LIMIT) {
      throw new Error(`LOCAL_QUARANTINE_RATIO_EXCEEDED: ${entry.lineId} ${localQuarantined}/${total}`);
    }
    expressQuarantine[entry.lineId] = { reason: EXPRESS_STOP_PATTERN_UNRESOLVED, note: EXPRESS_QUARANTINE_NOTE,
      rowCount: express.length, tripCount: expressTrips.get(entry.lineId), rowSetSha256: observedSha };
    summary[entry.lineId] = { routeNumber: entry.routeNumber, localTrips, localQuarantined,
      expressRows: express.length, expressTrips: expressTrips.get(entry.lineId), expressReason: EXPRESS_STOP_PATTERN_UNRESOLVED };
  }
  const order = (left, right) => codepointCompare(left.lineId, right.lineId) || codepointCompare(left.providerTripKey, right.providerTripKey);
  return { trips: trips.sort(order), quarantine: quarantine.sort(order), expressQuarantine,
    expressTrips: expressTripRows.sort(order), summary };
}

function quarantined(entry, providerTripKey, rows, reason) {
  return { lineId: entry.lineId, providerTripKey, reason,
    sourceRowNumbers: rows.map(({ sourceRowNumber }) => sourceRowNumber),
    sourceRowSha256: sha256(JSON.stringify(rows.map(({ sourceRowSha256 }) => sourceRowSha256))) };
}

function reconstructTrip(entry, key, rows) {
  const first = rows[0];
  for (const field of ["originStationName", "destinationStationName", "weekdayType", "trainNumber"]) {
    if (rows.some((row) => row[field] !== first[field])) return { reason: "TRIP_ATTRIBUTES_INCONSISTENT" };
  }
  if (rows.some((row) => row.dataReferenceDate?.value !== first.dataReferenceDate?.value)) return { reason: "TRIP_ATTRIBUTES_INCONSISTENT" };
  if (rows.length < 2) return { reason: "SINGLE_STOP_TRIP" };
  if (rows.some((row, index) => index > 0 && row.sourceRowNumber !== rows[index - 1].sourceRowNumber + 1)) {
    return { reason: "ROWS_NOT_CONTIGUOUS" };
  }
  if (new Set(rows.map(({ stationName }) => stationName)).size !== rows.length) return { reason: "DUPLICATE_STATION" };
  if (rows[0].stationName !== first.originStationName || rows.at(-1).stationName !== first.destinationStationName) {
    return { reason: "ENDPOINT_MISMATCH" };
  }
  const clocks = rows.map((row) => ({
    arrival: parseKricDayFractionSeconds(row.arrivalTime?.value),
    departure: parseKricDayFractionSeconds(row.departureTime?.value),
  }));
  if (clocks.some(({ arrival, departure }) => arrival === null && departure === null)) return { reason: "MISSING_STOP_TIME" };
  // 원천 행 순서로 시각을 펼친다. 반나절 이상 되감길 때만 자정 넘김으로 본다. 그 밖의 역전은 순서 충돌이다.
  let offset = 0;
  let previous = -1;
  let start = null;
  const unwrap = (value) => {
    if (value === null) return { value: null };
    let seconds = value + offset;
    if (seconds < previous && previous - seconds > HALF_DAY) {
      offset += SECONDS_PER_DAY;
      seconds += SECONDS_PER_DAY;
    }
    if (seconds < previous) return { conflict: true };
    previous = seconds;
    start ??= seconds;
    return { value: seconds };
  };
  const stops = [];
  for (const [index, { arrival, departure }] of clocks.entries()) {
    const arrived = unwrap(arrival);
    const departed = unwrap(departure);
    if (arrived.conflict || departed.conflict) return { reason: "TIME_ORDER_CONFLICTS_WITH_ROW_ORDER" };
    stops.push({ stationName: rows[index].stationName, arrivalSeconds: arrived.value, departureSeconds: departed.value });
  }
  if (previous - start > HALF_DAY) return { reason: "TRIP_SPAN_EXCEEDS_HALF_DAY" };
  const rowShas = rows.map(({ sourceRowSha256 }) => sourceRowSha256);
  return { trip: {
    lineId: entry.lineId,
    providerTripKey: key,
    serviceDayKind: SERVICE_DAY_KIND_BY_WEEKDAY_TYPE[first.weekdayType],
    servicePattern: SERVICE_PATTERN_BY_TYPE[first.serviceType],
    headsign: entry.stationAliases[first.destinationStationName] ?? first.destinationStationName,
    sourceRowSha256: sha256(JSON.stringify(rowShas)),
    stops,
    provenance: {
      routeNumber: entry.routeNumber, trainNumber: first.trainNumber, weekdayType: first.weekdayType,
      stopOrderBasis: "SOURCE_ROW_ORDER_CONFIRMED_BY_TIME_ORDER",
      sourceRowNumbers: rows.map(({ sourceRowNumber }) => sourceRowNumber), sourceRowSha256s: rowShas,
      dataReferenceDate: excelSerialDate(first.dataReferenceDate?.value),
      ...(first.weekdayType === "휴일" ? { serviceDayPolicy: HOLIDAY_INCLUDES_SATURDAY_POLICY } : {}),
    },
  } };
}

/** 팩 기준 노선 소속·인접 정차 검증. 위반은 해당 노선 전체 실패다(추정 매핑 없음). */
export function validateStationRowTripsAgainstPack({ trips, pack, bindings = KORAIL_STATION_ROW_BINDINGS }) {
  const stationNames = new Map((pack?.stations ?? []).map(({ id, nameKo }) => [id, nameKo]));
  const result = {};
  for (const entry of bindings) {
    const idByName = new Map();
    for (const { stationId, lineId } of pack?.stationLines ?? []) {
      if (lineId !== entry.lineId) continue;
      const name = stationNames.get(stationId);
      if (!name || idByName.has(name)) throw new Error(`LINE_STATION_NAME_AMBIGUOUS: ${entry.lineId} ${name}`);
      idByName.set(name, stationId);
    }
    for (const [from, to] of Object.entries(entry.stationAliases)) {
      if (!idByName.has(to)) throw new Error(`ALIAS_TARGET_NOT_ON_LINE: ${entry.lineId} ${from}->${to}`);
      if (idByName.has(from)) throw new Error(`ALIAS_SOURCE_SHADOWS_LINE_STATION: ${entry.lineId} ${from}`);
    }
    const adjacent = new Set();
    for (const edge of pack?.networkEdges ?? []) {
      if (edge.edgeType !== "RIDE" || !edge.fromNodeId.endsWith(`:${entry.lineId}`) || !edge.toNodeId.endsWith(`:${entry.lineId}`)) continue;
      const a = edge.fromNodeId.slice(0, -entry.lineId.length - 1);
      const b = edge.toNodeId.slice(0, -entry.lineId.length - 1);
      adjacent.add(`${a}|${b}`).add(`${b}|${a}`);
    }
    const lineTrips = trips.filter(({ lineId }) => lineId === entry.lineId);
    let stops = 0;
    for (const trip of lineTrips) {
      const ids = trip.stops.map(({ stationName }) => {
        const id = idByName.get(entry.stationAliases[stationName] ?? stationName);
        if (!id) throw new Error(`STATION_NOT_ON_LINE: ${entry.lineId} ${stationName}`);
        return id;
      });
      if (trip.servicePattern === "LOCAL") {
        for (let index = 1; index < ids.length; index += 1) {
          if (!adjacent.has(`${ids[index - 1]}|${ids[index]}`)) {
            throw new Error(`LOCAL_STOP_NOT_ADJACENT: ${trip.providerTripKey} ${trip.stops[index - 1].stationName}->${trip.stops[index].stationName}`);
          }
        }
      }
      stops += ids.length;
    }
    result[entry.lineId] = { trips: lineTrips.length, stops };
  }
  return result;
}
