#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 서울 열린데이터 공식 endpoint는 HTTPS를 지원하지 않는다. path service key가 평문 transport로
// 전송되므로 이 tracked runner는 offline evidence 수집에만 사용하고 mobile/runtime에 포함하지 않는다.
export const SEOUL_OPEN_DATA_APIS = Object.freeze({
  "seoul-topis-realtime-station-arrival": Object.freeze({
    endpoint: "http://swopenapi.seoul.go.kr/api/subway/{serviceKey}/json/realtimeStationArrival", // NOSONAR -- 공식 HTTP-only provider, offline evidence 전용
    suffix: ["0", "5", "서울"],
    rows: "realtimeArrivalList",
    fields: ["arvlCd", "arvlMsg2", "arvlMsg3", "barvlDt", "bstatnNm", "btrainNo", "recptnDt", "statnId", "statnNm", "subwayId", "trainLineNm", "updnLine"],
    keyEnv: "EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY",
  }),
  "seoul-topis-realtime-train-position": Object.freeze({
    endpoint: "http://swopenapi.seoul.go.kr/api/subway/{serviceKey}/json/realtimePosition", // NOSONAR -- 공식 HTTP-only provider, offline evidence 전용
    suffix: ["0", "5", "1호선"],
    rows: "realtimePositionList",
    fields: ["directAt", "lastRecptnDt", "recptnDt", "statnId", "statnNm", "statnTid", "statnTnm", "subwayId", "subwayNm", "trainNo", "trainSttus", "updnLine"],
    keyEnv: "EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY",
  }),
  "seoulmetro-station-line-info": Object.freeze({
    endpoint: "http://openapi.seoul.go.kr:8088/{serviceKey}/json/SearchSTNBySubwayLineInfo", // NOSONAR -- 공식 HTTP-only provider, offline evidence 전용
    suffix: ["1", "5", "", "", "4호선"],
    envelope: "SearchSTNBySubwayLineInfo",
    fields: ["STATION_CD", "STATION_NM", "STATION_NM_ENG", "LINE_NUM", "FR_CODE", "STATION_NM_CHN", "STATION_NM_JPN"],
    keyEnv: "SEOUL_OPENAPI_KEY",
  }),
});

export async function probeSeoulOpenDataApi({ sourceId, serviceKey, fetchImpl = fetch, sleepImpl = delay } = {}) {
  const operation = SEOUL_OPEN_DATA_APIS[sourceId];
  if (!operation) throw new Error(`unsupported Seoul open data source: ${safeToken(sourceId)}`);
  const key = requiredString(serviceKey, operation.keyEnv);
  const url = new URL(`${operation.endpoint.replace("{serviceKey}", encodeURIComponent(key))}/${operation.suffix.map(encodeURIComponent).join("/")}`);
  const response = await fetchWithRetry(url, fetchImpl, sleepImpl);
  if (!response.ok) throw new Error(`Seoul open data API HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error(`Seoul open data API schema mismatch: content-type ${safeToken(contentType)}`);
  const raw = await response.text();
  const parsed = parsePayload(raw, operation);
  return {
    schemaVersion: 1,
    artifactKind: "seoul-open-data-api-probe-evidence",
    sourceId,
    endpoint: operation.endpoint,
    httpStatus: response.status,
    providerResultCode: parsed.resultCode,
    schemaStatus: "EXPECTED",
    rowCount: parsed.rows.length,
    outputFields: operation.fields,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    credentialRedacted: true,
  };
}

async function fetchWithRetry(url, fetchImpl, sleepImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
      const retryable = [408, 429].includes(response.status) || response.status >= 500;
      if (!retryable || attempt === 1) return response;
      await response.body?.cancel().catch(() => {});
      await sleepImpl(500);
    } catch (error) {
      if (attempt === 1) throw new Error("Seoul open data API transport failure", { cause: error });
      await sleepImpl(500);
    }
  }
  throw new Error("Seoul open data API transport failure");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parsePayload(raw, operation) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error("Seoul open data API schema mismatch: invalid JSON");
  }
  const envelope = operation.envelope ? document?.[operation.envelope] : document;
  const resultCode = safeToken(operation.envelope
    ? envelope?.RESULT?.CODE ?? document?.RESULT?.CODE
    : envelope?.errorMessage?.code);
  if (resultCode !== "INFO-000") throw new Error(`Seoul open data API provider resultCode ${resultCode}`);
  const rows = operation.envelope ? envelope?.row : envelope?.[operation.rows];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Seoul open data API returned zero rows");
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Seoul open data API schema mismatch: item[${index}]`);
    const missing = operation.fields.filter((field) => !Object.hasOwn(row, field));
    if (missing.length > 0) throw new Error(`Seoul open data API schema mismatch: item[${index}] fields missing=${missing.join(",")}`);
  }
  return { resultCode, rows };
}

function safeToken(value) {
  const text = String(value ?? "UNKNOWN");
  return /^[A-Za-z0-9._/+:-]{1,64}$/.test(text) ? text : "UNKNOWN";
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

async function main() {
  const sourceId = requiredString(process.env.SEOUL_OPEN_DATA_API_SOURCE_ID, "SEOUL_OPEN_DATA_API_SOURCE_ID");
  const operation = SEOUL_OPEN_DATA_APIS[sourceId];
  if (!operation) throw new Error(`unsupported Seoul open data source: ${safeToken(sourceId)}`);
  const output = requiredString(process.env.SEOUL_OPEN_DATA_API_OUTPUT, "SEOUL_OPEN_DATA_API_OUTPUT");
  if (!path.isAbsolute(output)) throw new Error("SEOUL_OPEN_DATA_API_OUTPUT must be absolute");
  const evidence = await probeSeoulOpenDataApi({ sourceId, serviceKey: process.env[operation.keyEnv] });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitized Seoul open data API evidence ready: ${sourceId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Seoul open data API probe failed");
    process.exitCode = 1;
  }
}
