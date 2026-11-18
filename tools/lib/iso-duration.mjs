// 시·분·초 ISO 8601 duration(PT[nH][nM][nS])을 양의 밀리초 정수로 변환한다.
export const ISO_HMS_DURATION_PATTERN = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u;

export function parseIsoDurationMs(value, label = "duration") {
  const match = typeof value === "string" ? ISO_HMS_DURATION_PATTERN.exec(value) : null;
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    throw new Error(`${label} must be a positive ISO-8601 duration`);
  }
  const total = ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1_000;
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error(`${label} must be a positive ISO-8601 duration`);
  }
  return total;
}
