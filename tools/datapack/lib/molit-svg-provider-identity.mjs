const PROVIDER_LINE_NAME_ALIASES = new Map([
  ["경의중앙선", "경의중앙"],
  ["경춘선", "경춘"],
  ["수인분당선", "수인분당"],
  ["신분당선", "신분당"],
  ["공항철도", "공항"],
  ["용인경전철", "에버라인"],
  ["용인에버라인", "에버라인"],
  ["우이신설경전철", "우이신설"],
  ["의정부경전철", "의정부"],
]);

export function parseMolitSvgProviderIdentity(svgFileName, providerLabel) {
  const fileMatch = /^subway_a(\d{2})_l([A-Za-z0-9]+)$/.exec(svgFileName);
  const providerMatch = /^([A-Z0-9]+)\((.+)\)$/.exec(providerLabel);
  if (!fileMatch || !providerMatch) return null;

  const rawLineCode = fileMatch[2];
  return {
    mreaWideCd: fileMatch[1],
    lnCd: /^\d+$/.test(rawLineCode) ? String(Number(rawLineCode)) : rawLineCode.toUpperCase(),
    railOprIsttCd: providerMatch[1],
    operatorName: providerMatch[2].trim(),
  };
}

export function normalizeMolitProviderLineName(value) {
  const normalized = String(value)
    .replace(/^(수도권|부산|대구|광주|대전)\s+/, "")
    .replaceAll("·", "")
    .trim();
  return PROVIDER_LINE_NAME_ALIASES.get(normalized) ?? normalized;
}
