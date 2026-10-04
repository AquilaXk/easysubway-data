// #918: 운행일 경계. 시간표 원천은 자정 이후 시각을 24시 미만(00:00~02:59)으로 적는다.
// 그 시각은 전날 운행일의 심야 시각이므로 86400초 이상으로 표현한다.
// 근거(2026-10-04 실측): 인천 1·2호선 공식 FILE 8개는 00시대 시발 행을 모두 파일 끝(23시대 시발 뒤)에 두고
// 02~04시 시각이 하나도 없다. KRIC 역별 API(GTX-A·의정부·에버라인·김포골드·부산김해)도 01~04시 시발 열차가 없다.
// normalize-kric-timetable.mjs(03:00)와 같은 경계를 쓴다.
export const SERVICE_DAY_BOUNDARY_SECONDS = 3 * 3_600;
const SECONDS_PER_DAY = 86_400;

/** 원천 시각(초)을 운행일 시각(초)으로 바꾼다. null은 시각 없음이다. */
export function serviceDaySeconds(seconds) {
  if (seconds === null) return null;
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(`SERVICE_DAY_SECONDS_INVALID: ${seconds}`);
  return seconds < SERVICE_DAY_BOUNDARY_SECONDS ? seconds + SECONDS_PER_DAY : seconds;
}

/** 운행일 경계 앞 시각이 남은 stop_time 행을 돌려준다. 비어 있어야 팩을 만들 수 있다. */
export function serviceDayBoundaryViolations(stopTimes) {
  const early = (seconds) => typeof seconds === "number" && seconds < SERVICE_DAY_BOUNDARY_SECONDS;
  return stopTimes.filter(({ arrivalSeconds, departureSeconds }) => early(arrivalSeconds) || early(departureSeconds));
}
