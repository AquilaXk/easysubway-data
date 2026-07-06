// KRIC trainUseInfo/subwayTimetable 응답 → 재구성 코어의 provider-중립 중간 행 계약으로 변환하는
// 얇은 normalizer(가드레일 1). 라이브 스파이크로 확정한 스키마 기준:
//   { railOprIsttCd, trnNo, dayCd, dayNm, stinCd, lnCd, arvTm, dptTm }
//   - arvTm/dptTm은 HHMMSS(6자리) 또는 null(시발역 arvTm·종착역 dptTm).
//   - 한쪽이 null이면 있는 쪽으로 대체(도착=출발), 둘 다 null이면 무의미 행이라 버린다.
//   - stinCd/lnCd/railOprIsttCd는 canonical stationId/lineId로 매핑(context 제공).
//   - dayCd(8/7/9)는 그대로 전달 — serviceId 매핑은 적재 시 context.serviceIdByDayCd가 담당.

const DEFAULT_SERVICE_PATTERN = "LOCAL";
const SERVICE_DAY_CUTOFF_SECONDS = 3 * 3600;
const DAY_SECONDS = 24 * 3600;

export function normalizeKricSubwayTimetable(kricRows, context) {
  const stationIdByProviderStation = asLookup(context?.stationIdByProviderStation, "stationIdByProviderStation");
  const lineIdByProviderLine = asLookup(context?.lineIdByProviderLine, "lineIdByProviderLine");
  const fallbackServicePattern = context?.servicePattern ?? DEFAULT_SERVICE_PATTERN;

  const rows = [];
  for (const kric of kricRows ?? []) {
    const arrivalSeconds = parseKricTime(kric.arvTm);
    const departureSeconds = parseKricTime(kric.dptTm);
    if (arrivalSeconds === null && departureSeconds === null) {
      continue; // 시각 정보가 전혀 없는 행은 버린다(재구성 입력으로 무의미).
    }
    const providerStationKey = `${kric.railOprIsttCd}|${kric.lnCd}|${kric.stinCd}`;
    const stationId = requireMapping(stationIdByProviderStation, providerStationKey, "canonical station");
    const lineId = requireMapping(lineIdByProviderLine, `${kric.railOprIsttCd}|${kric.lnCd}`, "canonical line");
    rows.push({
      stationId,
      lineId,
      trnNo: requireText(kric.trnNo, "trnNo"),
      dayCd: requireText(kric.dayCd, "dayCd"),
      arrivalSeconds: arrivalSeconds ?? departureSeconds,
      departureSeconds: departureSeconds ?? arrivalSeconds,
      // subwayTimetableExp의 exptCd(급행 표시)를 row별로 반영. null/빈값이면 일반(fallback).
      servicePattern: isExpressCode(kric.exptCd) ? "EXPRESS" : fallbackServicePattern,
    });
  }
  return rows;
}

function isExpressCode(exptCd) {
  // KRIC subwayTimetableExp의 exptCd: 일반 열차는 null, 급행류는 코드값(예: "1"). 비어있지 않으면 급행으로 본다.
  return exptCd != null && exptCd !== "" && exptCd !== "0";
}

function parseKricTime(value) {
  if (value == null) {
    return null;
  }
  // KRIC은 미제공 시각을 null·빈문자·공백(" ")으로 섞어 반환한다(예: 불암산 K4534 dptTm=" "). 모두 미제공으로 본다.
  const text = String(value).trim();
  if (text === "") {
    return null;
  }
  if (!/^\d{6}$/.test(text)) {
    throw new TypeError(`normalize-kric: time must be HHMMSS: ${JSON.stringify(value)}`);
  }
  const hours = Number(text.slice(0, 2));
  const minutes = Number(text.slice(2, 4));
  const seconds = Number(text.slice(4, 6));
  if (hours > 29 || minutes > 59 || seconds > 59) {
    throw new RangeError(`normalize-kric: time out of range: ${value}`);
  }
  const raw = hours * 3600 + minutes * 60 + seconds;
  // KRIC은 심야(자정 넘김) 열차 시각을 24:00~이 아니라 실제 시계(00:xx)로 반환한다. 지하철 서비스데이는
  // ~03시에 끊기고(planner cutoff 동일) 03~05시 운행이 없으므로, 3시 미만 시각은 전 서비스데이 심야분(+24h)이다.
  // 이 정규화가 없으면 23:59 도착→00:00 출발 같은 자정 넘김에서 도착>출발이 된다.
  return raw < SERVICE_DAY_CUTOFF_SECONDS ? raw + DAY_SECONDS : raw;
}

function requireMapping(lookup, key, label) {
  const value = lookup[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`normalize-kric: no ${label} for ${key}`);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`normalize-kric: ${label} must be a non-empty string`);
  }
  return value;
}

function asLookup(value, label) {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  if (value && typeof value === "object") {
    return value;
  }
  throw new Error(`normalize-kric: context.${label} is required`);
}
