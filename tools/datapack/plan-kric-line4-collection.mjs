// KRIC 4호선 시각표 수집 계획기 (③b).
// 로스터(subwayRouteInfo 캡처)를 입력으로, 각 역을 소유 운영기관으로 subwayTimetable(+급행 Exp)에
// dayCd(8 평일/7 토/9 휴일)별 조회하는 요청 목록을 만든다. 각 역을 자기 소유기관으로 조회하면
// 직결 열차(다른 기관 소속)도 함께 반환됨은 ①스파이크에서 확인(S1@사당이 KR 직결 열차 포함).
// KRIC quota 무제한이지만 요청 수는 계측한다.

const DAY_CODES = ["8", "7", "9"]; // 평일/토/휴일

// subwayTimetableExp(급행 표시)는 subwayTimetable(일반)의 상위집합이다 — 같은 열차 전량 + row별 exptCd
// (급행 표시). 따라서 이 endpoint 하나만 수집하면 일반·급행이 한 번에 잡히고 중복이 없다.
const COLLECTION_OPERATION = "subwayTimetableExp";
const OPERATION_SERVICE = Object.freeze({
  subwayTimetableExp: "trainUseInfo",
  stationTimetable: "convenientInfo",
});

export function buildKricLine4CollectionPlan(roster, options = {}) {
  const stations = roster?.stations;
  if (!Array.isArray(stations) || stations.length === 0) {
    throw new Error("plan-kric: roster.stations must be a non-empty array");
  }
  const dayCds = options.dayCds ?? DAY_CODES;
  const lnCd = requireText(roster.lnCd, "roster.lnCd");

  const operation = options.operation ?? COLLECTION_OPERATION;
  if (!OPERATION_SERVICE[operation]) throw new Error(`plan-kric: unsupported operation ${operation}`);
  const requests = [];
  for (const station of stations) {
    const stinCd = requireText(station.stinCd, "station.stinCd");
    const railOprIsttCd = requireText(station.railOprIsttCd, "station.railOprIsttCd");
    for (const dayCd of dayCds) {
      requests.push(request(operation, { railOprIsttCd, lnCd, stinCd, dayCd }));
    }
  }
  return {
    artifactKind: "kric-line4-collection-plan",
    sourceId: "kric-subway-route-info",
    lnCd,
    stationCount: stations.length,
    dayCds,
    operation,
    requestCount: requests.length,
    requests,
  };
}

function request(operation, params) {
  return {
    operation,
    endpoint: `https://openapi.kric.go.kr/openapi/${OPERATION_SERVICE[operation]}/${operation}`,
    requestKey: `${operation}|${params.railOprIsttCd}|${params.stinCd}|${params.dayCd}`,
    params,
  };
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`plan-kric: ${label} must be a non-empty string`);
  }
  return value;
}
