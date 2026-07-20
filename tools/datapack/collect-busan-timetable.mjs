#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT = "http://data.humetro.busan.kr/voc/api/open_api_process.tnn"; // NOSONAR -- provider contract is HTTP-only
const DETAIL_URL = "https://www.data.go.kr/data/15000522/openapi.do";
const DAYS = Object.freeze(["1", "2", "3"]);
const RESPONSE_FIELDS = Object.freeze([
  "sname", "engname", "trainno", "hour", "time", "day", "updown", "endcode", "scode", "line",
]);
const LINE_CODES = Object.freeze({
  "line-ab1a041f6266": "1",
  "line-eb7b47920390": "2",
  "line-d74614a04530": "3",
  "line-d812a5bc1e5f": "4",
});
const EXPECTED_LINE_IDS = Object.keys(LINE_CODES).sort(compareText);
const XML_CONTENT_TYPES = new Set(["application/xml", "text/xml"]);
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1000;

export async function collectBusanTimetable({
  serviceKey,
  stationScopes,
  fetchImpl = fetch,
  now = new Date(),
  concurrency = 4,
  sleepImpl = sleep,
} = {}) {
  const capturedAt = validDate(now, "now");
  const key = decodedServiceKey(requiredText(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  const scope = validateScope(stationScopes);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("concurrency is invalid");
  const requests = scope.flatMap((station) => DAYS.map((day) => ({ station, day })));
  const responses = new Array(requests.length);
  let next = 0;
  let failure;
  const worker = async () => {
    while (!failure && next < requests.length) {
      const index = next;
      next += 1;
      try {
        responses[index] = await collectResponse({ ...requests[index], key, fetchImpl, sleepImpl, scope });
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()));
  if (failure) throw failure;
  const rows = responses.flatMap(({ rows }) => rows).sort(compareRows);
  validateCompleteRows(rows, scope);
  const rawSha256 = sha256(JSON.stringify(responses.map((response, index) => ({
    stationCode: requests[index].station.stationCode,
    day: requests[index].day,
    rawSha256: response.rawSha256,
  }))));
  return {
    schemaVersion: 1,
    artifactKind: "busan-timetable-snapshot",
    sourceId: "busan-transportation-timetable",
    detailUrl: DETAIL_URL,
    endpoint: ENDPOINT,
    capturedAt: capturedAt.toISOString(),
    freshUntil: new Date(capturedAt.getTime() + FRESHNESS_MILLIS).toISOString(),
    official: true,
    fixture: false,
    credentialRedacted: true,
    requestCount: requests.length,
    stationCount: scope.length,
    rowCount: rows.length,
    dayTypes: [...DAYS],
    lineIds: [...EXPECTED_LINE_IDS],
    outputFields: [...RESPONSE_FIELDS],
    fieldsProvided: ["service_calendar", "trip", "stop_time"],
    responseEncodings: [...new Set(responses.map(({ responseEncoding }) => responseEncoding))].sort(compareText),
    license: {
      type: "KOGL-1",
      attribution: "부산교통공사, 공공누리 제1유형(출처표시); 제3자 권리 포함 저작권 표시",
      redistributionAllowed: true,
      evidenceUrl: DETAIL_URL,
    },
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256,
    rowsSha256: sha256(JSON.stringify(rows)),
    rows,
  };
}

async function collectResponse({ station, day, key, fetchImpl, sleepImpl, scope }) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("act", "xml");
  url.searchParams.set("scode", station.stationCode);
  url.searchParams.set("day", day);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "999");
  const response = await fetchWithRetry(url, fetchImpl, sleepImpl);
  const bytes = Buffer.from(await response.arrayBuffer());
  const rawSha256 = sha256(bytes);
  if (!response.ok) throw new Error(`Busan timetable HTTP ${response.status}; rawBytes=${bytes.length}; rawSha256=${rawSha256}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!XML_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Busan timetable schema mismatch: content-type ${contentType || "missing"}; rawSha256=${rawSha256}`);
  }
  const { raw, responseEncoding } = decodeXml(bytes);
  const resultCode = scalar(raw, "resultCode");
  if (resultCode !== "00") throw new Error(`Busan timetable provider resultCode ${safeToken(resultCode ?? "missing")}; rawSha256=${rawSha256}`);
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1];
  if (body == null) throw new Error(`Busan timetable schema mismatch: response body; rawSha256=${rawSha256}`);
  const items = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (items.length === 0) throw new Error(`Busan timetable schema mismatch: empty items; rawSha256=${rawSha256}`);
  const totalCount = scalar(raw, "totalCount");
  if (totalCount != null && (!/^\d+$/.test(totalCount) || Number(totalCount) !== items.length)) {
    throw new Error(`Busan timetable schema mismatch: truncated items; items=${items.length}; `
      + `totalCount=${safeToken(totalCount)}; rawSha256=${rawSha256}`);
  }
  const byCode = new Map(scope.map((entry) => [entry.stationCode, entry]));
  const common = Object.fromEntries(["sname", "engname", "scode", "line"].map((field) => [field, scalar(body, field)]));
  const rows = items.map((item, index) => validateRow(
    Object.fromEntries(RESPONSE_FIELDS.map((field) => [field, common[field] ?? scalar(item, field)])),
    { station, day, byCode, index },
  ));
  return { rows, rawSha256, responseEncoding };
}

function validateRow(values, { station, day, byCode, index }) {
  if (Object.values(values).some((value) => value == null)) {
    throw new Error(`Busan timetable schema mismatch: item[${index}] fields`);
  }
  const hour = Number(values.hour);
  const minute = Number(values.time);
  const expectedLine = LINE_CODES[station.lineId];
  const end = byCode.get(values.endcode);
  const invalid = [];
  if (values.sname.trim() === "" || values.sname.trim().length > 100) invalid.push("sname");
  if (values.engname.trim() === "" || values.engname.trim().length > 100) invalid.push("engname");
  if (!/^\d{1,8}$/.test(values.trainno)) invalid.push("trainno");
  if (!/^\d{1,2}$/.test(values.hour) || hour < 0 || hour > 29) invalid.push("hour");
  if (!/^\d{1,2}$/.test(values.time) || minute < 0 || minute > 59) invalid.push("time");
  if (values.day !== day || !DAYS.includes(values.day)) invalid.push("day");
  if (!new Set(["0", "1"]).has(values.updown)) invalid.push("updown");
  if (values.scode !== station.stationCode) invalid.push("scode");
  if (values.line !== expectedLine) invalid.push("line");
  if (!end || LINE_CODES[end.lineId] !== expectedLine) invalid.push("endcode");
  if (invalid.length > 0) throw new Error(`Busan timetable schema mismatch: item[${index}] values=${invalid.join(",")}`);
  return { ...values, hour: String(hour).padStart(2, "0"), time: String(minute).padStart(2, "0") };
}

function validateCompleteRows(rows, scope) {
  const expected = new Set(scope.flatMap(({ stationCode }) =>
    DAYS.flatMap((day) => ["0", "1"].map((updown) => `${stationCode}:${day}:${updown}`))));
  const seen = new Set();
  const keys = new Set();
  for (const row of rows) {
    seen.add(`${row.scode}:${row.day}:${row.updown}`);
    const key = RESPONSE_FIELDS.map((field) => row[field]).join(":");
    if (keys.has(key)) throw new Error("Busan timetable schema mismatch: duplicate row");
    keys.add(key);
  }
  if (seen.size !== expected.size || [...expected].some((key) => !seen.has(key))) {
    throw new Error("Busan timetable schema mismatch: station/day/direction scope incomplete");
  }
}

function validateScope(scope) {
  if (!Array.isArray(scope) || scope.length !== 114) throw new Error("Busan timetable scope must contain 114 stations");
  const codes = new Set();
  const normalized = scope.map((entry) => {
    const stationCode = requiredText(entry?.stationCode, "scope.stationCode");
    const stationName = requiredText(entry?.stationName, `scope ${stationCode}.stationName`);
    const lineId = requiredText(entry?.lineId, `scope ${stationCode}.lineId`);
    if (!/^\d{2,3}$/.test(stationCode) || !LINE_CODES[lineId] || codes.has(stationCode)) {
      throw new Error(`Busan timetable scope is invalid: ${stationCode}`);
    }
    codes.add(stationCode);
    return { stationCode, stationName, lineId };
  }).sort((left, right) => left.stationCode.localeCompare(right.stationCode, "en"));
  const lineIds = [...new Set(normalized.map(({ lineId }) => lineId))].sort(compareText);
  if (JSON.stringify(lineIds) !== JSON.stringify(EXPECTED_LINE_IDS)) throw new Error("Busan timetable scope line set is incomplete");
  return normalized;
}

async function fetchWithRetry(url, fetchImpl, sleepImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/xml,text/xml" },
      });
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await sleepImpl(250);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt === 1) {
        const code = error?.code ?? error?.cause?.code ?? "UNKNOWN";
        throw new Error(`Busan timetable transport failure; code=${safeToken(String(code))}`);
      }
    }
  }
  throw new Error("Busan timetable transport failure");
}

function decodeXml(bytes) {
  try {
    return { raw: new TextDecoder("utf-8", { fatal: true }).decode(bytes), responseEncoding: "utf-8" };
  } catch {
    return { raw: new TextDecoder("euc-kr", { fatal: true }).decode(bytes), responseEncoding: "euc-kr" };
  }
}

function scalar(raw, field) {
  const value = new RegExp(String.raw`<${field}\b[^>]*>([^<]{0,200})<\/${field}>`, "i").exec(raw)?.[1];
  return value == null ? null : decodeEntities(value.trim());
}

function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  })[entity]);
}

function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

function validDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function safeToken(value) {
  return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "UNKNOWN";
}

function compareRows(left, right) {
  return RESPONSE_FIELDS.map((field) => left[field]).join(":")
    .localeCompare(RESPONSE_FIELDS.map((field) => right[field]).join(":"), "en");
}

function compareText(left, right) { return left.localeCompare(right, "en"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function main(args = process.argv.slice(2)) {
  const expected = ["--scope-snapshot", "--output"];
  if (args.length !== 4 || args.filter((_, index) => index % 2 === 0).some((name, index) => name !== expected[index])) {
    throw new Error("usage: collect-busan-timetable.mjs --scope-snapshot <json> --output <absolute.json>");
  }
  const output = args[3];
  if (!path.isAbsolute(output)) throw new Error("output must be absolute");
  const topology = JSON.parse(await readFile(args[1], "utf8"));
  const snapshot = await collectBusanTimetable({
    serviceKey: process.env.DATA_GO_KR_SERVICE_KEY,
    stationScopes: topology.scope,
  });
  await writeFile(output, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  console.log(`sanitized Busan timetable snapshot ready: rows=${snapshot.rowCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Busan timetable collection failed");
    process.exitCode = 1;
  }
}
