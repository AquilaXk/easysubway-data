#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT = "http://data.humetro.busan.kr/voc/api/open_api_convenience.tnn"; // NOSONAR -- provider contract is HTTP-only
const DETAIL_URL = "https://www.data.go.kr/data/15001020/openapi.do";
const COUNT_FIELDS = Object.freeze([
  "wl_i", "wl_o", "el_i", "el_o", "es", "blindroad", "ourbridge", "helptake", "toilet",
]);
const RESPONSE_FIELDS = Object.freeze(["sname", ...COUNT_FIELDS, "toilet_gubun"]);
const LINE_IDS = Object.freeze([
  "line-ab1a041f6266", "line-d74614a04530", "line-d812a5bc1e5f", "line-eb7b47920390",
]);
const XML_CONTENT_TYPES = new Set(["application/xml", "text/xml"]);
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;

export async function collectBusanAccessibility({
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
  const responses = new Array(scope.length);
  let next = 0;
  let failure;
  const worker = async () => {
    while (!failure && next < scope.length) {
      const index = next;
      next += 1;
      try {
        responses[index] = await collectResponse({ station: scope[index], key, fetchImpl, sleepImpl });
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, scope.length) }, () => worker()));
  if (failure) throw failure;
  const rows = responses.map(({ row }) => row).sort((left, right) => left.stationCode.localeCompare(right.stationCode, "en"));
  if (rows.length !== 114 || new Set(rows.map(({ stationCode }) => stationCode)).size !== 114) {
    throw new Error("Busan accessibility station scope incomplete");
  }
  return {
    schemaVersion: 1,
    artifactKind: "busan-accessibility-snapshot",
    sourceId: "busan-transportation-accessibility",
    detailUrl: DETAIL_URL,
    endpoint: ENDPOINT,
    capturedAt: capturedAt.toISOString(),
    freshUntil: new Date(capturedAt.getTime() + FRESHNESS_MILLIS).toISOString(),
    official: true,
    fixture: false,
    credentialRedacted: true,
    requestCount: scope.length,
    stationCount: scope.length,
    rowCount: rows.length,
    lineIds: [...LINE_IDS],
    outputFields: [...RESPONSE_FIELDS],
    fieldsProvided: ["elevator", "escalator", "wheelchair_lift", "status", "verified_at"],
    responseEncodings: [...new Set(responses.map(({ responseEncoding }) => responseEncoding))]
      .sort((left, right) => left.localeCompare(right, "en")),
    license: {
      type: "PUBLIC-DOMAIN",
      attribution: "부산교통공사",
      redistributionAllowed: true,
      evidenceUrl: DETAIL_URL,
    },
    scope,
    scopeSha256: sha256(JSON.stringify(scope)),
    rawSha256: sha256(JSON.stringify(responses.map(({ rawSha256 }, index) => ({
      stationCode: scope[index].stationCode,
      rawSha256,
    })))),
    rowsSha256: sha256(JSON.stringify(rows)),
    rows,
  };
}

async function collectResponse({ station, key, fetchImpl, sleepImpl }) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("act", "xml");
  url.searchParams.set("scode", station.stationCode);
  const response = await fetchWithRetry(url, fetchImpl, sleepImpl);
  const bytes = Buffer.from(await response.arrayBuffer());
  const rawSha256 = sha256(bytes);
  if (!response.ok) {
    throw new Error(`Busan accessibility HTTP ${response.status}; rawBytes=${bytes.length}; rawSha256=${rawSha256}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!XML_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Busan accessibility schema mismatch: content-type ${contentType || "missing"}; rawSha256=${rawSha256}`);
  }
  const { raw, responseEncoding } = decodeXml(bytes);
  const resultCode = scalar(raw, "resultCode");
  if (resultCode !== "00") {
    throw new Error(`Busan accessibility provider resultCode ${safeToken(resultCode ?? "missing")}; rawSha256=${rawSha256}`);
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1];
  if (body == null) throw new Error(`Busan accessibility schema mismatch: response body; rawSha256=${rawSha256}`);
  const values = Object.fromEntries(RESPONSE_FIELDS.map((field) => [field, scalar(body, field)]));
  const missing = RESPONSE_FIELDS.filter((field) => values[field] == null);
  if (missing.length > 0) throw new Error(`Busan accessibility schema mismatch: fields=${missing.join(",")}`);
  // 공식 API는 시설 없음 역에서 count 필드를 빈 문자열로 내려준다(2026-07-24 114역 실측: 9역).
  // 태그 자체 누락(null)과 구분하고, 빈 문자열만 0으로 정규화한다.
  for (const field of COUNT_FIELDS) {
    if (values[field] === "") values[field] = "0";
  }
  const invalid = [];
  for (const field of COUNT_FIELDS) {
    if (!/^\d{1,4}$/.test(values[field])) invalid.push(field);
  }
  if (values.sname.trim() === "" || values.sname.length > 100) invalid.push("sname");
  if (values.toilet_gubun.trim() === "" || values.toilet_gubun.length > 20) invalid.push("toilet_gubun");
  if (invalid.length > 0) throw new Error(`Busan accessibility schema mismatch: values=${invalid.join(",")}`);
  return {
    rawSha256,
    responseEncoding,
    row: {
      stationCode: station.stationCode,
      stationName: values.sname,
      lineId: station.lineId,
      ...Object.fromEntries(COUNT_FIELDS.map((field) => [field, Number(values[field])])),
      toilet_gubun: values.toilet_gubun,
    },
  };
}

function validateScope(scope) {
  if (!Array.isArray(scope) || scope.length !== 114) throw new Error("Busan accessibility scope must contain 114 stations");
  const codes = new Set();
  const normalized = scope.map((entry) => {
    const stationCode = requiredText(entry?.stationCode, "scope.stationCode");
    const stationName = requiredText(entry?.stationName, `scope ${stationCode}.stationName`);
    const lineId = requiredText(entry?.lineId, `scope ${stationCode}.lineId`);
    if (!/^\d{2,3}$/.test(stationCode) || !LINE_IDS.includes(lineId) || codes.has(stationCode)) {
      throw new Error(`Busan accessibility scope is invalid: ${stationCode}`);
    }
    codes.add(stationCode);
    return { stationCode, stationName, lineId };
  }).sort((left, right) => left.stationCode.localeCompare(right.stationCode, "en"));
  if (JSON.stringify([...new Set(normalized.map(({ lineId }) => lineId))].sort()) !== JSON.stringify(LINE_IDS)) {
    throw new Error("Busan accessibility scope line set is incomplete");
  }
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
        throw new Error(`Busan accessibility transport failure; code=${safeToken(String(code))}`);
      }
    }
  }
  throw new Error("Busan accessibility transport failure");
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

function safeToken(value) { return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "UNKNOWN"; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function main(args = process.argv.slice(2)) {
  const expected = ["--scope-snapshot", "--output"];
  if (args.length !== 4 || expected.some((flag, index) => args[index * 2] !== flag) || !path.isAbsolute(args[3])) {
    throw new Error("usage: collect-busan-accessibility.mjs --scope-snapshot <json> --output <absolute.json>");
  }
  const topology = JSON.parse(await readFile(args[1], "utf8"));
  const snapshot = await collectBusanAccessibility({
    serviceKey: process.env.DATA_GO_KR_SERVICE_KEY,
    stationScopes: topology.scope,
  });
  await writeFile(args[3], `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  console.log(`sanitized Busan accessibility snapshot ready: rows=${snapshot.rowCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Busan accessibility collection failed");
    process.exitCode = 1;
  }
}
