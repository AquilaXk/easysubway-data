import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";

const ENDPOINT = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

export async function fetchKasiPublicHolidayCalendar({
  serviceKey,
  year,
  months,
  fetchImpl = fetch,
} = {}) {
  const normalizedServiceKey = normalizeDataGoKrServiceKey(serviceKey, { label: "DATA_GO_KR_SERVICE_KEY" });
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error("KASI public holiday year is invalid");
  const requestedMonths = [...new Set(months ?? [])].sort((left, right) => left - right);
  if (requestedMonths.length === 0 || requestedMonths.some((month) => !Number.isInteger(month) || month < 1 || month > 12)) {
    throw new Error("KASI public holiday months are invalid");
  }
  const holidays = new Set();
  for (const month of requestedMonths) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("ServiceKey", normalizedServiceKey);
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("numOfRows", "100");
    url.searchParams.set("solYear", String(year));
    url.searchParams.set("solMonth", String(month).padStart(2, "0"));
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/xml, text/xml" },
      });
    } catch (error) {
      throw transportFailure(error);
    }
    if (!response?.ok) throw new Error(`KASI public holiday request failed: HTTP_${safeStatus(response?.status)}`);
    let xml;
    try {
      xml = await response.text();
    } catch (error) {
      throw transportFailure(error);
    }
    const dates = parseMonth(xml, { year, month });
    for (const date of dates) holidays.add(date);
  }
  return holidays;
}

function parseMonth(xml, { year, month }) {
  if (typeof xml !== "string" || !/<response\b[^>]*>/i.test(xml)) throw new Error("KASI public holiday response schema is invalid");
  const header = singleElement(xml, "header");
  const resultCode = scalar(header, "resultCode");
  if (resultCode !== "00") throw new Error(`KASI public holiday provider resultCode ${safeToken(resultCode)}`);
  const body = singleElement(xml, "body");
  const items = itemsElement(body);
  const totalCount = nonnegativeInteger(scalar(body, "totalCount"));
  const itemBlocks = [...items.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (itemBlocks.length !== totalCount) throw new Error("KASI public holiday response month coverage is invalid");
  const prefix = `${year}${String(month).padStart(2, "0")}`;
  const holidays = new Set();
  for (const item of itemBlocks) {
    const locdate = scalar(item, "locdate");
    const isHoliday = scalar(item, "isHoliday");
    if (!/^\d{8}$/.test(locdate) || !locdate.startsWith(prefix) || !["Y", "N"].includes(isHoliday)) {
      throw new Error("KASI public holiday response month coverage is invalid");
    }
    if (isHoliday === "Y") holidays.add(locdate);
  }
  return holidays;
}

function itemsElement(xml) {
  const paired = [...xml.matchAll(/<items\b[^>]*>([\s\S]*?)<\/items>/gi)];
  const empty = [...xml.matchAll(/<items\b[^>]*\/>/gi)];
  if (paired.length + empty.length !== 1) throw new Error("KASI public holiday response schema is invalid");
  return paired.length === 1 ? paired[0][1] : "";
}

function singleElement(xml, tag) {
  const matches = [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))];
  if (matches.length !== 1) throw new Error("KASI public holiday response schema is invalid");
  return matches[0][1];
}

function scalar(xml, tag) {
  const matches = [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>\\s*([^<]*?)\\s*<\\/${tag}>`, "gi"))];
  if (matches.length !== 1 || matches[0][1] === "") throw new Error("KASI public holiday response schema is invalid");
  return decodeXml(matches[0][1]);
}

function nonnegativeInteger(value) {
  if (!/^\d+$/.test(value)) throw new Error("KASI public holiday response schema is invalid");
  return Number(value);
}

function transportFailure(error) {
  return new Error(`KASI public holiday request failed: ${transportCategory(error)}`);
}

function transportCategory(error) {
  const seen = new Set();
  let current = error;
  let category = "NETWORK_UNKNOWN";
  for (let depth = 0; depth <= 4; depth += 1) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null || seen.has(current)) return "NETWORK_UNKNOWN";
    seen.add(current);
    const details = transportDetails(current);
    if (details === null) return "NETWORK_UNKNOWN";
    category = category === "NETWORK_UNKNOWN" ? categoryFor(details) : category;
    if (details.cause === undefined || details.cause === null) return category;
    if (depth === 4) return "NETWORK_UNKNOWN";
    current = details.cause;
  }
  return "NETWORK_UNKNOWN";
}

function transportDetails(error) {
  try {
    return {
      name: typeof error.name === "string" ? error.name : "",
      code: typeof error.code === "string" ? error.code : "",
      cause: error.cause,
    };
  } catch {
    return null;
  }
}

function categoryFor({ name, code }) {
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "NETWORK_DNS";
  if ([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "ERR_SSL_WRONG_VERSION_NUMBER",
    "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
    "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  ].includes(code)) return "NETWORK_TLS";
  if (code === "UND_ERR_CONNECT_TIMEOUT") return "NETWORK_CONNECT_TIMEOUT";
  if (["TimeoutError", "AbortError"].includes(name) || ["ABORT_ERR", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) {
    return "NETWORK_REQUEST_TIMEOUT";
  }
  if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(code)) return "NETWORK_SOCKET";
  return "NETWORK_UNKNOWN";
}

function decodeXml(value) { return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'"); }
function safeStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599 ? value : "UNKNOWN"; }
function safeToken(value) { return /^[A-Za-z0-9._-]{1,32}$/.test(value ?? "") ? value : "UNKNOWN"; }
