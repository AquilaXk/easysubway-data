#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ID = "gwangju-transportation-timetable";
const ENDPOINT = "https://apis.data.go.kr/B551232/grtcTimetable/timetable";
const DETAIL_URL = "https://www.data.go.kr/data/15111298/openapi.do";
const OUTPUT_FIELDS = Object.freeze([
  "day", "endCord", "direction", "time", "subwayCord", "updateDt", "subwayLine", "endName", "subwayName",
]);
const XML_CONTENT_TYPES = new Set(["application/xml", "text/xml"]);
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;

export async function collectGwangjuTimetable({
  serviceKey,
  fetchImpl = fetch,
  now = new Date(),
  sleepImpl = sleep,
  concurrency = 4,
} = {}) {
  const capturedAt = validDate(now, "now");
  const key = decodedServiceKey(requiredText(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("concurrency is invalid");
  const first = await collectPage({ pageNo: 1, key, fetchImpl, sleepImpl });
  const pageCount = Math.ceil(first.totalCount / first.numOfRows);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) {
    throw new Error(`Gwangju timetable schema mismatch: pageCount=${safeToken(String(pageCount))}`);
  }
  const pages = new Array(pageCount);
  pages[0] = first;
  let nextPageNo = 2;
  let failure;
  const worker = async () => {
    while (!failure && nextPageNo <= pageCount) {
      const pageNo = nextPageNo;
      nextPageNo += 1;
      try {
        pages[pageNo - 1] = await collectPage({ pageNo, key, fetchImpl, sleepImpl });
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pageCount - 1) }, () => worker()));
  if (failure) throw failure;
  for (const page of pages) {
    if (page.totalCount !== first.totalCount || page.numOfRows !== first.numOfRows) {
      throw new Error("Gwangju timetable schema mismatch: pagination metadata drift");
    }
  }
  const rows = pages.flatMap((page) => page.rows).sort(compareRows);
  if (rows.length !== first.totalCount) {
    throw new Error(`Gwangju timetable schema mismatch: truncated items; items=${rows.length}; `
      + `totalCount=${first.totalCount}`);
  }
  validateRows(rows);
  const rawSha256 = sha256(JSON.stringify(pages.map(({ pageNo, rawSha256: pageSha256 }) => ({
    pageNo,
    rawSha256: pageSha256,
  }))));
  const responseEncodings = [...new Set(pages.map(({ responseEncoding }) => responseEncoding))].sort(compareText);
  return {
    schemaVersion: 1,
    artifactKind: "gwangju-timetable-snapshot",
    sourceId: SOURCE_ID,
    detailUrl: DETAIL_URL,
    endpoint: ENDPOINT,
    capturedAt: capturedAt.toISOString(),
    freshUntil: new Date(capturedAt.getTime() + FRESHNESS_MILLIS).toISOString(),
    httpStatus: 200,
    providerResultCode: "00",
    schemaStatus: "EXPECTED",
    official: true,
    fixture: false,
    credentialRedacted: true,
    requestCount: pages.length,
    rowCount: rows.length,
    dayTypes: [...new Set(rows.map(({ day }) => day))].sort(compareText),
    directions: [...new Set(rows.map(({ direction }) => direction))].sort(compareText),
    stationCodes: [...new Set(rows.map(({ subwayCord }) => subwayCord))].sort(compareText),
    outputFields: [...OUTPUT_FIELDS],
    fieldsProvided: ["service_calendar", "trip", "stop_time"],
    responseEncodings,
    license: {
      type: "UNRESTRICTED",
      attribution: "광주교통공사, 공공데이터포털",
      redistributionAllowed: true,
      evidenceUrl: DETAIL_URL,
    },
    rawSha256,
    rowsSha256: sha256(JSON.stringify(rows)),
    rows,
  };
}

async function collectPage({ pageNo, key, fetchImpl, sleepImpl }) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", "500");
  const response = await fetchWithRetry(url, fetchImpl, sleepImpl);
  const bytes = Buffer.from(await response.arrayBuffer());
  const rawSha256 = sha256(bytes);
  if (!response.ok) {
    throw new Error(`Gwangju timetable HTTP ${response.status}; rawBytes=${bytes.length}; rawSha256=${rawSha256}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!XML_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Gwangju timetable schema mismatch: content-type ${contentType || "missing"}; rawSha256=${rawSha256}`);
  }
  const { raw, responseEncoding } = decodeXml(bytes);
  const resultCode = scalar(raw, "resultCode");
  if (resultCode !== "00") {
    throw new Error(`Gwangju timetable provider resultCode ${safeToken(resultCode ?? "missing")}; rawSha256=${rawSha256}`);
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1];
  if (body == null) throw new Error(`Gwangju timetable schema mismatch: response body; rawSha256=${rawSha256}`);
  const items = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (items.length === 0) throw new Error(`Gwangju timetable schema mismatch: empty items; rawSha256=${rawSha256}`);
  const totalCount = scalar(body, "totalCount");
  const responsePageNo = scalar(body, "pageNo");
  const numOfRows = scalar(body, "numOfRows");
  if (totalCount == null || !/^\d+$/.test(totalCount) || Number(totalCount) < items.length
    || responsePageNo == null || Number(responsePageNo) !== pageNo
    || numOfRows == null || !/^\d+$/.test(numOfRows) || Number(numOfRows) < items.length
    || Number(numOfRows) < 1 || Number(numOfRows) > 500) {
    throw new Error(`Gwangju timetable schema mismatch: pagination metadata; page=${pageNo}; `
      + `items=${items.length}; totalCount=${safeToken(totalCount ?? "missing")}; rawSha256=${rawSha256}`);
  }
  const rows = items.map((item, index) => validateRow(
    Object.fromEntries(OUTPUT_FIELDS.map((field) => [field, scalar(item, field)])),
    index,
  )).sort(compareRows);
  return {
    pageNo,
    totalCount: Number(totalCount),
    numOfRows: Number(numOfRows),
    responseEncoding,
    rawSha256,
    rows,
  };
}

function validateRow(values, index) {
  const invalid = [];
  for (const field of OUTPUT_FIELDS) {
    if (values[field] == null || values[field].trim() === "" || values[field].length > 100) invalid.push(field);
  }
  if (!/^[A-Za-z0-9-]{1,20}$/.test(values.endCord ?? "")) invalid.push("endCord");
  if (!/^[A-Za-z0-9-]{1,20}$/.test(values.subwayCord ?? "")) invalid.push("subwayCord");
  if (!/^(?:(?:[01]\d|2\d):?[0-5]\d(?::?[0-5]\d)?)$/.test(values.time ?? "")) invalid.push("time");
  if (!/^(?:\d{8}|\d{4}[-./]\d{2}[-./]\d{2})$/.test(values.updateDt ?? "")) invalid.push("updateDt");
  if (!/^1(?:호선)?$/.test(values.subwayLine ?? "")) invalid.push("subwayLine");
  if (invalid.length > 0) {
    const fields = [...new Set(invalid)];
    throw new Error(`Gwangju timetable schema mismatch: item[${index}] values=${fields.join(",")}; `
      + `shapes=${fields.map((field) => `${field}:${valueShape(values[field])}`).join(",")}`);
  }
  return Object.fromEntries(OUTPUT_FIELDS.map((field) => [field, values[field].trim()]));
}

function validateRows(rows) {
  const keys = new Set();
  for (const row of rows) {
    const key = OUTPUT_FIELDS.map((field) => row[field]).join(":");
    if (keys.has(key)) throw new Error("Gwangju timetable schema mismatch: duplicate row");
    keys.add(key);
  }
  if (new Set(rows.map(({ day }) => day)).size === 0 || new Set(rows.map(({ direction }) => direction)).size === 0) {
    throw new Error("Gwangju timetable schema mismatch: day/direction scope incomplete");
  }
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
        throw new Error(`Gwangju timetable transport failure; code=${safeToken(String(code))}`);
      }
    }
  }
  throw new Error("Gwangju timetable transport failure");
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

function valueShape(value) {
  if (value == null) return "MISSING";
  if (value === "") return "EMPTY";
  if (/^\d+$/.test(value)) return `DIGITS_${value.length}`;
  if (/^[\d:./ -]+$/.test(value)) return `DATE_TIME_CHARS_LENGTH_${value.length}`;
  return `TEXT_LENGTH_${value.length}`;
}

function safeToken(value) { return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "UNKNOWN"; }
function compareRows(left, right) {
  return OUTPUT_FIELDS.map((field) => left[field]).join(":")
    .localeCompare(OUTPUT_FIELDS.map((field) => right[field]).join(":"), "en");
}
function compareText(left, right) { return left.localeCompare(right, "en"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--output") {
    throw new Error("usage: collect-gwangju-timetable.mjs --output <absolute.json>");
  }
  const output = args[1];
  if (!path.isAbsolute(output)) throw new Error("output must be absolute");
  const snapshot = await collectGwangjuTimetable({ serviceKey: process.env.DATA_GO_KR_SERVICE_KEY });
  await writeFile(output, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  console.log(`sanitized Gwangju timetable snapshot ready: rows=${snapshot.rowCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju timetable collection failed");
    process.exitCode = 1;
  }
}
