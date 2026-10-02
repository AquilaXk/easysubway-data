// #903 테스트 전용: 고정 바인딩의 구간(segment)마다 평일·휴일 한 편씩, 구간 역 순서대로 2분 간격 정차하는 합성 KRIC 응답.
import { KRIC_API_STATION_TIMETABLE_BINDINGS } from "../lib/kric-station-timetable-api-trips.mjs";

export function syntheticKricStationFetch({ bindings = KRIC_API_STATION_TIMETABLE_BINDINGS, startHour = 6 } = {}) {
  return async (url) => {
    const p = Object.fromEntries(new URL(url).searchParams);
    const binding = bindings.find(({ lnCd }) => lnCd === p.lnCd);
    const segmentIndex = binding.segments.findIndex((segment) => segment.includes(p.stinCd));
    const segment = binding.segments[segmentIndex];
    const index = segment.indexOf(p.stinCd);
    const clock = (minute) => `${String(startHour).padStart(2, "0")}${String(minute).padStart(2, "0")}00`;
    const rows = p.dayCd === "7" ? [] : [{ railOprIsttCd: p.railOprIsttCd, trnNo: `Z${p.dayCd}S${segmentIndex}`, dayCd: p.dayCd, dayNm: "x",
      stinCd: p.stinCd, lnCd: p.lnCd, arvTm: index === 0 ? null : clock(index * 2), dptTm: index === segment.length - 1 ? null : clock(index * 2 + 1) }];
    return new Response(JSON.stringify({ header: { resultCode: p.dayCd === "7" ? "03" : "00" }, body: rows }), { status: 200 });
  };
}

/** 위 합성 응답에 맞는 기대값(노선별 구간 수만큼 평일·휴일 trip). */
export function syntheticExpectedObservation({ bindings = KRIC_API_STATION_TIMETABLE_BINDINGS } = {}) {
  const lines = Object.fromEntries(bindings.map(({ lnCd, lineId, segments }) => [lineId,
    { lnCd, weekdayTrips: segments.length, holidayTrips: segments.length, quarantined: 0, weekdayEqualsHoliday: false }]));
  return { totalTrips: bindings.reduce((sum, { segments }) => sum + segments.length * 2, 0), lines };
}
