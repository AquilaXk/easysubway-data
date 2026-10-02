import { createHash } from "node:crypto";
import { codepointCompare } from "../../lib/codepoint-compare.mjs";
import { HOLIDAY_INCLUDES_SATURDAY_POLICY, LOCAL_QUARANTINE_RATIO_LIMIT } from "./kric-station-row-timetable-trips.mjs";

export { HOLIDAY_INCLUDES_SATURDAY_POLICY };

// KRIC OpenAPI trainUseInfo/subwayTimetable(카탈로그 provider:kric-subway-timetable)의 역별 응답으로 trip을 재구성한다.
// 응답 행은 "역 × 열차" 단위이며 정차 순서가 없다. (노선, 열차번호, 요일코드)로 묶고 시각순으로 정렬하되,
// 다음 조건을 모두 만족할 때만 채택한다. 하나라도 어기면 그 열차는 quarantine한다(추정·보정 없음).
//   - 시발역은 도착 없이 출발만, 종착역은 출발 없이 도착만, 중간역은 도착·출발이 모두 있다.
//   - 정렬 후 시각이 엄격히 증가한다(동시각이면 순서를 정할 수 없어 quarantine).
//   - 연속 정차가 같은 구간(segment)의 인접역이고 방향이 한쪽으로 일정하다. 응답 행에 방향 필드가 없으므로
//     방향(구간 순서 기준 ASC/DESC)은 이 검증으로 정하고 trip 키에 넣는다. 같은 열차번호가 다른 운행에 다시 쓰여
//     한 그룹으로 섞이면 끝점·인접 조건을 어겨 quarantine된다(혼합 trip을 만들지 않는다).
// 노선 소속·인접 정차는 validateStationRowTripsAgainstPack으로 팩 기준 검증한다.

const SECONDS_PER_DAY = 86_400;
const HALF_DAY = SECONDS_PER_DAY / 2;
const API_CLOCK = /^([01]\d|2[0-3])([0-5]\d)([0-5]\d)$/u;
const SATURDAY_DAY_CD = "7";
const DAY_CDS = Object.freeze(["7", "8", "9"]);
const ALIAS_REASON = "KRIC 역사 roster 역명의 부역명 괄호 표기; 팩 역명은 주역명";

function apiBinding(mreaWideCd, lnCd, lineId, stations, segments = [stations.map(([, stinCd]) => stinCd)]) {
  const aliases = Object.fromEntries(stations.map(([, , name]) => name).filter((name) => /\(.+\)$/u.test(name))
    .map((name) => [name, name.replace(/\(.+\)$/u, "")]));
  return Object.freeze({
    mreaWideCd, lnCd, lineId, routeIdPrefix: `route-kric-api-${lnCd.toLowerCase()}`,
    stations: Object.freeze(stations.map((station) => Object.freeze(station))),
    // 운행 구간별 역 순서(물리 인접 순). roster 순서가 곧 노선 순서인 노선은 한 구간이다.
    segments: Object.freeze(segments.map((segment) => Object.freeze([...segment]))),
    stationAliases: Object.freeze(aliases),
    aliasEvidence: Object.freeze(Object.fromEntries(Object.entries(aliases).map(([from, to]) => [from, `${ALIAS_REASON} '${to}'`]))),
  });
}

/** roster 스냅샷 kric-nationwide-route-rosters-20261001T050420765Z.json의 역 목록을 그대로 고정한다. */
export const KRIC_API_STATION_TIMETABLE_BINDINGS = Object.freeze([
  apiBinding("01", "A", "line-8604048b6430", [["GX", "X108", "수서"], ["GX", "X109", "성남"], ["GX", "X110", "구성"], ["SR", "X111", "동탄"], ["GX", "X106", "서울역"], ["GX", "X105", "연신내"], ["GX", "X103", "대곡"], ["GX", "X102", "킨텍스"], ["GX", "X101", "운정중앙"]],
  // GTX-A는 운정중앙–서울역, 수서–동탄 두 구간으로 따로 운행한다(창릉·삼성 미개통, roster에 없음).
  [["X101", "X102", "X103", "X105", "X106"], ["X108", "X109", "X110", "X111"]]),
  apiBinding("01", "E1", "line-828f04afc588", [["EV", "Y110", "기흥(백남준아트센터)"], ["EV", "Y111", "강남대"], ["EV", "Y112", "지석"], ["EV", "Y113", "어정"], ["EV", "Y114", "동백"], ["EV", "Y115", "초당"], ["EV", "Y116", "삼가"], ["EV", "Y117", "시청.용인대"], ["EV", "Y118", "명지대"], ["EV", "Y119", "김량장"], ["EV", "Y120", "용인중앙시장(용인예술과학대)"], ["EV", "Y121", "고진"], ["EV", "Y122", "보평"], ["EV", "Y123", "둔전"], ["EV", "Y124", "전대.에버랜드"]]),
  apiBinding("01", "U1", "line-62096860ab09", [["UL", "0110", "발곡"], ["UL", "0111", "회룡"], ["UL", "0112", "범골"], ["UL", "0113", "경전철의정부"], ["UL", "0114", "의정부시청"], ["UL", "0115", "흥선"], ["UL", "0117", "의정부중앙"], ["UL", "0118", "동오"], ["UL", "0119", "새말"], ["UL", "0120", "경기도청북부청사"], ["UL", "0121", "효자"], ["UL", "0122", "곤제"], ["UL", "0123", "어룡(용현산업단지)"], ["UL", "0124", "송산"], ["UL", "0125", "탑석"]]),
  apiBinding("01", "G1", "line-5500c1600f71", [["GM", "G100", "양촌"], ["GM", "G101", "구래"], ["GM", "G102", "마산"], ["GM", "G103", "장기"], ["GM", "G104", "운양"], ["GM", "G105", "걸포북변"], ["GM", "G106", "사우(김포시청)"], ["GM", "G107", "풍무"], ["GM", "G108", "고촌"], ["GM", "G109", "김포공항"]]),
  apiBinding("02", "B1", "line-e4cce88f0d7f", [["BG", "0101", "사상(서부터미널)"], ["BG", "0102", "괘법르네시떼(강변공원)"], ["BG", "0103", "서부산유통지구(금호마을)"], ["BG", "0104", "공항"], ["BG", "0105", "덕두"], ["BG", "0106", "등구"], ["BG", "0107", "대저"], ["BG", "0108", "평강"], ["BG", "0109", "대사"], ["BG", "0110", "불암"], ["BG", "0111", "지내"], ["BG", "0112", "김해대학(안동)"], ["BG", "0113", "인제대(활천)"], ["BG", "0114", "김해시청"], ["BG", "0115", "부원"], ["BG", "0116", "봉황(김해여객터미널)"], ["BG", "0117", "수로왕릉(김해보건소)"], ["BG", "0118", "박물관"], ["BG", "0119", "연지공원"], ["BG", "0120", "장신대(화정)"], ["BG", "0121", "가야대(삼계)"]]),
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** KRIC API 시각(HHMMSS)을 초로 바꾼다. null은 해당 시각 없음이다. */
export function parseKricApiClock(raw) {
  if (raw === null || raw === undefined) return null;
  const match = API_CLOCK.exec(typeof raw === "string" ? raw : "");
  if (!match) throw new Error(`INVALID_API_CLOCK: ${raw}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * @param {{ responses: Array<{ railOprIsttCd, lnCd, stinCd, stinNm, dayCd, resultCode, rows }>, bindings }} input
 * @returns {{ trips, quarantine, summary }}
 */
export function buildApiStationTimetableTrips({ responses, bindings = KRIC_API_STATION_TIMETABLE_BINDINGS }) {
  if (!Array.isArray(responses) || !Array.isArray(bindings) || bindings.length === 0) throw new Error("API_STATION_INPUT_INVALID");
  const trips = [];
  const quarantine = [];
  const summary = {};
  for (const entry of bindings) {
    const lineResponses = new Map();
    for (const response of responses) {
      if (response?.lnCd !== entry.lnCd) continue;
      const key = `${response.stinCd}|${response.dayCd}`;
      if (lineResponses.has(key)) throw new Error(`STATION_RESPONSE_DUPLICATED: ${entry.lineId} ${response.stinCd} dayCd=${response.dayCd}`);
      lineResponses.set(key, response);
    }
    const saturdayCodes = new Set();
    const groups = new Map();
    const segments = entry.segments ?? [entry.stations.map(([, stinCd]) => stinCd)];
    const position = new Map(segments.flatMap((segment, segmentIndex) => segment.map((stinCd, index) => [stinCd, { segmentIndex, index }])));
    for (const [railOprIsttCd, stinCd, stinNm] of entry.stations) {
      for (const dayCd of DAY_CDS) {
        const response = lineResponses.get(`${stinCd}|${dayCd}`);
        if (!response) throw new Error(`STATION_RESPONSE_MISSING: ${entry.lineId} ${stinCd} dayCd=${dayCd}`);
        if (response.railOprIsttCd !== railOprIsttCd || response.stinNm !== stinNm) {
          throw new Error(`STATION_RESPONSE_IDENTITY_MISMATCH: ${entry.lineId} ${stinCd}`);
        }
        if (dayCd === SATURDAY_DAY_CD) {
          saturdayCodes.add(response.resultCode);
          continue;
        }
        if (response.resultCode !== "00" || !Array.isArray(response.rows) || response.rows.length === 0) {
          throw new Error(`STATION_RESPONSE_NOT_OK: ${entry.lineId} ${stinCd} dayCd=${dayCd} code=${response.resultCode}`);
        }
        for (const row of response.rows) {
          if (row?.stinCd !== stinCd || row.lnCd !== entry.lnCd || row.dayCd !== dayCd || row.railOprIsttCd !== railOprIsttCd
            || typeof row.trnNo !== "string" || row.trnNo.trim() === "") {
            throw new Error(`ROW_REQUEST_MISMATCH: ${entry.lineId} ${stinCd}`);
          }
          const key = `${entry.lnCd}|${row.trnNo}|${dayCd}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push({ stinCd, stinNm, arvTm: row.arvTm, dptTm: row.dptTm,
            arrival: parseKricApiClock(row.arvTm), departure: parseKricApiClock(row.dptTm) });
        }
      }
    }
    // 토요일 코드 7이 전 역에서 '데이터 없음'(03)일 때만 휴일(9) 시간표를 토·일·공휴일에 적용한다(QA 확정 정책).
    if (saturdayCodes.size !== 1) throw new Error(`SATURDAY_COVERAGE_INCONSISTENT: ${entry.lineId}`);
    if (!saturdayCodes.has("03")) throw new Error(`SATURDAY_TIMETABLE_UNSUPPORTED: ${entry.lineId}`);
    const serviceDayKindByDayCd = { "8": "WEEKDAY", "9": "SATURDAY_SUNDAY_HOLIDAY" };

    let built = 0;
    let bad = 0;
    for (const [key, stops] of groups) {
      const outcome = reconstructApiTrip(stops, position);
      if (outcome.reason) {
        bad += 1;
        quarantine.push({ lineId: entry.lineId, providerTripKey: key, reason: outcome.reason,
          stationCodes: stops.map(({ stinCd }) => stinCd) });
        continue;
      }
      built += 1;
      const [, trainNumber, dayCd] = key.split("|");
      const providerTripKey = `${key}|${outcome.direction}`;
      const terminal = outcome.stops.at(-1).stinNm;
      const canonicalRows = outcome.stops.map(({ stinCd, arvTm, dptTm }) => ({ stinCd, arvTm, dptTm }));
      trips.push({
        lineId: entry.lineId, providerTripKey, serviceDayKind: serviceDayKindByDayCd[dayCd], servicePattern: "LOCAL",
        headsign: entry.stationAliases[terminal] ?? terminal,
        sourceRowSha256: sha256(JSON.stringify(canonicalRows)),
        stops: outcome.stops.map(({ stinNm, arrivalSeconds, departureSeconds }) => ({ stationName: stinNm, arrivalSeconds, departureSeconds })),
        provenance: { lnCd: entry.lnCd, trainNumber, dayCd, direction: outcome.direction, segmentIndex: outcome.segmentIndex,
          stopOrderBasis: "TIME_ORDER_WITH_ENDPOINT_NULL_PATTERN_AND_SEGMENT_ADJACENCY",
          stationCodes: outcome.stops.map(({ stinCd }) => stinCd), saturdayDayCdResult: "03",
          ...(dayCd === "9" ? { serviceDayPolicy: HOLIDAY_INCLUDES_SATURDAY_POLICY } : {}) },
      });
    }
    if (built === 0) throw new Error(`NO_TRIPS: ${entry.lineId}`);
    if (bad / (built + bad) > LOCAL_QUARANTINE_RATIO_LIMIT) throw new Error(`LOCAL_QUARANTINE_RATIO_EXCEEDED: ${entry.lineId} ${bad}/${built + bad}`);
    summary[entry.lineId] = { lnCd: entry.lnCd, trips: built, quarantined: bad };
  }
  const order = (left, right) => codepointCompare(left.lineId, right.lineId) || codepointCompare(left.providerTripKey, right.providerTripKey);
  return { trips: trips.sort(order), quarantine: quarantine.sort(order), summary };
}

function reconstructApiTrip(rows, position) {
  if (rows.length < 2) return { reason: "SINGLE_STOP_TRIP" };
  if (new Set(rows.map(({ stinCd }) => stinCd)).size !== rows.length) return { reason: "DUPLICATE_STATION" };
  const values = rows.flatMap(({ arrival, departure }) => [arrival, departure]).filter((value) => value !== null);
  // 반나절 이상 벌어지면 자정을 넘는 열차로 보고 이른 시각을 다음날로 옮긴다.
  const wraps = Math.max(...values) - Math.min(...values) > HALF_DAY;
  const shift = (value) => value !== null && wraps && value < HALF_DAY ? value + SECONDS_PER_DAY : value;
  const stops = rows.map((row) => ({ ...row, arrivalSeconds: shift(row.arrival), departureSeconds: shift(row.departure) }))
    .sort((left, right) => (left.departureSeconds ?? left.arrivalSeconds) - (right.departureSeconds ?? right.arrivalSeconds));
  if (stops[0].arrivalSeconds !== null || stops[0].departureSeconds === null
    || stops.at(-1).departureSeconds !== null || stops.at(-1).arrivalSeconds === null) return { reason: "ENDPOINT_TIME_PATTERN_INVALID" };
  if (stops.slice(1, -1).some(({ arrivalSeconds, departureSeconds }) => arrivalSeconds === null || departureSeconds === null)) {
    return { reason: "INNER_STOP_TIME_MISSING" };
  }
  let previousDeparture = -1;
  for (const { arrivalSeconds, departureSeconds } of stops) {
    if (arrivalSeconds !== null && arrivalSeconds <= previousDeparture) return { reason: "TIME_ORDER_AMBIGUOUS" };
    if (arrivalSeconds !== null && departureSeconds !== null && departureSeconds < arrivalSeconds) return { reason: "DWELL_NEGATIVE" };
    previousDeparture = departureSeconds ?? previousDeparture;
  }
  const places = stops.map(({ stinCd }) => position.get(stinCd));
  const step = places[1].index - places[0].index;
  if (places.some((place) => place.segmentIndex !== places[0].segmentIndex) || Math.abs(step) !== 1
    || places.some((place, index) => index > 0 && place.index - places[index - 1].index !== step)) {
    return { reason: "STOP_SEQUENCE_NOT_ADJACENT" };
  }
  const first = stops[0].departureSeconds;
  const last = stops.at(-1).arrivalSeconds;
  if (last - first > HALF_DAY) return { reason: "TRIP_SPAN_EXCEEDS_HALF_DAY" };
  return { stops, direction: step > 0 ? "ASC" : "DESC", segmentIndex: places[0].segmentIndex };
}
