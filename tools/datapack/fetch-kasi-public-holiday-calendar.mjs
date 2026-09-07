import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMainModule } from "../lib/is-main-module.mjs";

const ENDPOINT = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

/** 완료 manifest가 지목한 원문을 읽는다. 수집 시각을 갱신하거나 부족한 월을 보충하지 않는다. */
export async function readKasiHolidayCalendarFiles(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("absolute calendar directory required");
  const bytes = await readFile(path.join(directory, "months.json"));
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.sourceId !== "kasi-public-holiday-calendar"
    || !Array.isArray(manifest.months) || manifest.months.length === 0) throw new Error("KASI manifest is invalid");
  const months = [];
  const files = new Set();
  for (const entry of manifest.months) {
    const file = `${entry.year}-${String(entry.month).padStart(2, "0")}.xml`;
    if (!/^\d{4}-\d{2}\.xml$/.test(file) || entry.file !== file || files.has(file)
      || typeof entry.retrievedAt !== "string" || !Number.isFinite(Date.parse(entry.retrievedAt))) {
      throw new Error("KASI manifest month is invalid");
    }
    files.add(file);
    const raw = await readFile(path.join(directory, file));
    parseRetainedKasiHolidayMonth({ ...entry, raw });
    months.push({ ...entry, raw });
  }
  return { manifestSha256: createHash("sha256").update(bytes).digest("hex"), months };
}

/** 새 디렉터리만 예약한다. 실패한 수집에는 완료 manifest를 남기지 않는다. */
export async function collectKasiHolidayCalendarFiles({ outputDirectory, ...input }) {
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory)) throw new Error("absolute output directory required");
  await mkdir(outputDirectory);
  const observation = await fetchKasiPublicHolidayCalendarObservation(input);
  const months = [];
  for (const { xml, ...identity } of observation.months) {
    const file = `${identity.year}-${String(identity.month).padStart(2, "0")}.xml`;
    await writeFile(path.join(outputDirectory, file), xml, { flag: "wx", mode: 0o600 });
    months.push({ ...identity, file });
  }
  const manifest = { schemaVersion: 1, sourceId: "kasi-public-holiday-calendar", months };
  await writeFile(path.join(outputDirectory, "months.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
}

/** 보관 원문만 소비한다. 조회 월과 원문 해시는 유지하고 수집 시각은 새로 만들지 않는다. */
export function parseRetainedKasiHolidayMonth({ raw, sha256, year, month }) {
  if (!(raw instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(sha256 ?? "")
    || !Number.isInteger(year) || year < 2000 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("retained KASI month identity is invalid");
  if (createHash("sha256").update(raw).digest("hex") !== sha256) throw new Error("retained KASI digest mismatch");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const dates = parseMonth(xml, { year, month });
  return { year, month, rawSha256: sha256, rawByteLength: raw.byteLength, holidayDates: [...dates].sort(utf16Compare) };
}

export async function fetchKasiPublicHolidayCalendar(input = {}) {
  const observation = await fetchKasiPublicHolidayCalendarObservation(input);
  return observation.holidays;
}

/** 기존 요청 한 번에서 날짜 집합과 보관 가능한 월별 XML을 함께 얻는다. */
export async function fetchKasiPublicHolidayCalendarObservation({
  serviceKey,
  year,
  months,
  fetchImpl,
  httpsRequestImpl = httpsRequest,
} = {}) {
  const normalizedServiceKey = normalizeDataGoKrServiceKey(serviceKey, { label: "DATA_GO_KR_SERVICE_KEY" });
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error("KASI public holiday year is invalid");
  const requestedMonths = [...new Set(months ?? [])].sort((left, right) => left - right);
  if (requestedMonths.length === 0 || requestedMonths.some((month) => !Number.isInteger(month) || month < 1 || month > 12)) {
    throw new Error("KASI public holiday months are invalid");
  }
  const holidays = new Set();
  const observations = [];
  for (const month of requestedMonths) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("ServiceKey", normalizedServiceKey);
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("numOfRows", "100");
    url.searchParams.set("solYear", String(year));
    url.searchParams.set("solMonth", String(month).padStart(2, "0"));
    const request = fetchImpl
      ? (options) => fetchImpl(url, options)
      : (options) => nativeHttpsGet(url, options, httpsRequestImpl);
    const { response, attemptCount } = await fetchKasiMonth(request);
    const { xml, dates } = await readKasiMonthResponse(response, { year, month, attemptCount });
    for (const date of dates) holidays.add(date);
    observations.push({ year, month, xml, sha256: createHash("sha256").update(xml, "utf8").digest("hex"),
      retrievedAt: new Date().toISOString() });
  }
  return { holidays, months: observations };
}

async function readKasiMonthResponse(response, { year, month, attemptCount }) {
    if (!response?.ok) throw kasiFailure(`KASI public holiday request failed: HTTP_${safeStatus(response?.status)}`, "KASI_HTTP", attemptCount);
    let xml;
    try {
      xml = await response.text();
    } catch (error) {
      throw transportFailure(error, attemptCount);
    }
    let dates;
    try {
      dates = parseMonth(xml, { year, month });
    } catch (error) {
      throw kasiFailure(error.message, "KASI_SCHEMA", attemptCount);
    }
    return { xml, dates };
}

async function fetchKasiMonth(request) {
  const transportAttempts = [];
  for (let attemptCount = 1; attemptCount <= 2; attemptCount += 1) {
    try {
      const options = { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { accept: "application/xml, text/xml" } };
      const response = await request(options);
      return { response, attemptCount };
    } catch (error) {
      const attempt = closedTransportAttempt(error, attemptCount);
      if (attempt !== null) transportAttempts.push(attempt);
      const failure = transportFailure(error, attemptCount, transportAttempts);
      if (failure.failureCategory !== "NETWORK_CONNECT_TIMEOUT" || attemptCount !== 1) throw failure;
    }
  }
  throw new Error("KASI public holiday request did not complete");
}

function utf16Compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function nativeHttpsGet(url, { signal, headers }, httpsRequestImpl) {
  return new Promise((resolve, reject) => {
    let secureConnected = false;
    const diagnostic = {
      failurePhase: "UNKNOWN",
      ipv4AttemptCount: 0,
      ipv6AttemptCount: 0,
    };
    const request = httpsRequestImpl(url, { method: "GET", headers, signal }, (response) => {
      diagnostic.failurePhase = "RESPONSE_HEADERS";
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        resolve({ ok: false, status: response.statusCode });
        return;
      }
      const chunks = [];
      response.setEncoding("utf8");
      response.once("error", reject);
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        ok: true,
        status: response.statusCode,
        text: async () => chunks.join(""),
      }));
    });
    request.once("socket", (socket) => {
      if (socket.secureConnecting === false) {
        secureConnected = true;
        diagnostic.failurePhase = "RESPONSE_HEADERS";
        return;
      }
      diagnostic.failurePhase = "DNS_LOOKUP";
      socket.once("lookup", (error) => {
        if (error === null || error === undefined) diagnostic.failurePhase = "TCP_CONNECT";
      });
      if (typeof socket.on === "function") {
        socket.on("connectionAttempt", (_ip, _port, family) => {
          diagnostic.failurePhase = "TCP_CONNECT";
          if (family === 4) diagnostic.ipv4AttemptCount += 1;
          if (family === 6) diagnostic.ipv6AttemptCount += 1;
        });
      }
      socket.once("connect", () => { diagnostic.failurePhase = "TLS_HANDSHAKE"; });
      socket.once("secureConnect", () => {
        secureConnected = true;
        diagnostic.failurePhase = "RESPONSE_HEADERS";
      });
    });
    request.once("error", (error) => reject(nativeRequestFailure(error, secureConnected, diagnostic)));
    request.end();
  });
}

function nativeRequestFailure(error, secureConnected, diagnostic) {
  const transportDiagnostic = Object.freeze({ ...diagnostic });
  if (!isNativeAbortError(error)) {
    return Object.assign(new Error("KASI native HTTPS request failed"), {
      cause: error,
      transportDiagnostic,
    });
  }
  const failure = new Error(secureConnected
    ? "KASI native HTTPS request timed out"
    : "KASI native HTTPS connect timed out");
  failure.name = secureConnected ? "AbortError" : "Error";
  failure.code = secureConnected ? "ABORT_ERR" : "UND_ERR_CONNECT_TIMEOUT";
  failure.cause = error;
  failure.transportDiagnostic = transportDiagnostic;
  return failure;
}

function closedTransportAttempt(error, attemptCount) {
  const diagnostic = error?.transportDiagnostic;
  if (diagnostic === null || typeof diagnostic !== "object") return null;
  const phases = new Set(["DNS_LOOKUP", "TCP_CONNECT", "TLS_HANDSHAKE", "RESPONSE_HEADERS", "UNKNOWN"]);
  return Object.freeze({
    attemptCount,
    failurePhase: phases.has(diagnostic.failurePhase) ? diagnostic.failurePhase : "UNKNOWN",
    ipv4AttemptCount: safeFamilyAttemptCount(diagnostic.ipv4AttemptCount),
    ipv6AttemptCount: safeFamilyAttemptCount(diagnostic.ipv6AttemptCount),
  });
}

function safeFamilyAttemptCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 0;
}

function isNativeAbortError(error) {
  const details = transportDetails(error);
  return details !== null && (details.name === "AbortError" || details.code === "ABORT_ERR");
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

function transportFailure(error, attemptCount = 1, transportAttempts = []) {
  const category = transportCategory(error);
  return kasiFailure(`KASI public holiday request failed: ${category}`, category, attemptCount, transportAttempts);
}

function kasiFailure(message, failureCategory, attemptCount, transportAttempts = []) {
  const error = new Error(message);
  error.failureCategory = failureCategory;
  error.attemptCount = attemptCount;
  if (transportAttempts.length > 0) error.transportAttempts = transportAttempts.map((attempt) => ({ ...attempt }));
  return error;
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

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 6 || args[0] !== "--year" || args[2] !== "--months" || args[4] !== "--output-directory"
      || !/^\d{4}$/.test(args[1]) || !/^\d{1,2}(,\d{1,2})*$/.test(args[3])) {
      throw new Error("usage: --year YYYY --months M,M --output-directory <new-absolute-directory>");
    }
    await collectKasiHolidayCalendarFiles({ year: Number(args[1]), months: args[3].split(",").map(Number),
      outputDirectory: args[5], serviceKey: process.env.DATA_GO_KR_SERVICE_KEY });
    console.log("KASI monthly evidence written");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
