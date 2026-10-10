#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { scanXmlStructure } from "./lib/source-candidate-evidence-collector.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { isTransientStatus, unwrapTransientRetryFailure, withTransientRetry } from "./lib/transient-retry.mjs";

export const DAEJEON_COVERAGE_OPERATIONS = Object.freeze({
  "daejeon-train-timetable": Object.freeze({
    endpoint: "https://apis.data.go.kr/B554695/TimeTableSVC/getAllTimeTable",
    expectedFields: ["dayType", "drctType", "stNum", "tmList", "tmZone"],
    captureRows: true,
    validateItem: validateTimetableItem,
  }),
  "daejeon-station-distance-fare": Object.freeze({
    endpoint: "https://apis.data.go.kr/B554695/TimeDistSVC/getTimeDist01",
    query: { strstnno: "111", endstnno: "120" },
    expectedFields: ["distfloat", "fee", "min", "sec"],
    validateItem: validateDistanceFareItem,
  }),
});

export async function probeDaejeonCoverageApi({
  sourceId,
  serviceKey,
  query,
  captureRows = false,
  fetchImpl = fetch,
  sleepImpl,
  retryBudget,
  now = new Date(),
} = {}) {
  const operation = DAEJEON_COVERAGE_OPERATIONS[sourceId];
  if (!operation) throw new Error(`unsupported Daejeon coverage source: ${sourceId ?? "missing"}`);
  const key = normalizeDataGoKrServiceKey(serviceKey);
  const url = new URL(operation.endpoint);
  url.searchParams.set("serviceKey", key);
  const requestQuery = query ?? operation.query ?? {};
  validateOperationQuery(sourceId, requestQuery, query !== undefined);
  for (const [name, value] of Object.entries(requestQuery)) url.searchParams.set(name, value);

  const { response, responseBytes } = await fetchWithRetry(url, fetchImpl, { sleepImpl, retryBudget });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const raw = responseBytes.toString("utf8");
  if (!response.ok) {
    throw new Error(`Daejeon coverage API HTTP ${response.status}; observedAt=${now.toISOString()}; `
      + `contentType=${contentType || "missing"}; rawBytes=${Buffer.byteLength(raw)}; rawSha256=${sha256(raw)}`);
  }
  let parsed;
  try {
    parsed = parseXmlEvidence(raw, operation.expectedFields, operation.validateItem);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daejeon coverage API parse failure";
    throw new Error(`${message}; observedAt=${now.toISOString()}; httpStatus=${response.status}; `
      + `contentType=${contentType || "missing"}; rawBytes=${Buffer.byteLength(raw)}; rawSha256=${sha256(raw)}`);
  }
  if (!new Set(["application/xml", "text/xml"]).has(contentType)) {
    throw new Error(`Daejeon coverage API schema mismatch: content-type ${contentType || "missing"}; `
      + `observedAt=${now.toISOString()}; httpStatus=${response.status}; `
      + `rawBytes=${Buffer.byteLength(raw)}; rawSha256=${sha256(raw)}`);
  }
  return {
    schemaVersion: 1,
    artifactKind: "daejeon-coverage-api-probe-evidence",
    sourceId,
    observedAt: now.toISOString(),
    endpoint: operation.endpoint,
    httpStatus: response.status,
    providerResultCode: parsed.providerResultCode,
    schemaStatus: "EXPECTED",
    rowCount: parsed.rowCount,
    outputFields: parsed.outputFields,
    ...((captureRows || operation.captureRows) ? {
      rows: parsed.rows,
      rowsSha256: sha256(JSON.stringify(parsed.rows)),
    } : {}),
    ...(Object.keys(requestQuery).length > 0 ? { query: requestQuery } : {}),
    // 등록 단계는 같은 원문을 재수집하지 않고 보존 바이트와 해시를 소비한다.
    rawResponseBase64: responseBytes.toString("base64"),
    rawBytes: responseBytes.length,
    rawSha256: sha256(responseBytes),
    credentialRedacted: true,
  };
}

// data.go.kr 공통 오류 envelope의 resultCode 99(UNKNOWN_ERROR)는 TAGO와 같은 일시 오류다. 다른 resultCode(22·23 쿼터, 30 인증 등)는 재시도하지 않는다.
const TRANSIENT_PROVIDER_RESULT_CODE = "99";

// 요청과 본문 읽기를 한 번의 시도로 묶어 일시 오류(HTTP 408·5xx, resultCode 99, 연결·요청·본문 timeout, 소켓 끊김)면 같은 요청을 다시 보낸다(#1099).
// 인증·쿼터·형식 오류는 재시도하지 않는다. 한도를 다 쓰면 마지막 응답(HTTP 오류·provider 오류)이나 전송 오류를 기존 오류와 원문 해시 진단으로 드러낸다.
async function fetchWithRetry(url, fetchImpl, { sleepImpl, retryBudget }) {
  try {
    return await withTransientRetry(async () => {
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/xml,text/xml" },
      });
      return { response, responseBytes: Buffer.from(await response.arrayBuffer()) };
    }, {
      isTransientResult: ({ response, responseBytes }) => isTransientStatus(response.status)
        || (response.ok && xmlScalar(responseBytes.toString("utf8"), "resultCode") === TRANSIENT_PROVIDER_RESULT_CODE),
      sleep: sleepImpl,
      budget: retryBudget,
    });
  } catch (error) {
    throw new Error("Daejeon coverage API transport failure", { cause: unwrapTransientRetryFailure(error) });
  }
}

function parseXmlEvidence(raw, expectedFields, validateItem) {
  const parsed = scanXmlStructure(raw);
  const resultCode = xmlScalar(raw, "resultCode");
  if (resultCode !== "00") {
    const alternateCode = xmlScalar(raw, "returnReasonCode");
    const candidateCode = resultCode ?? alternateCode;
    const safeCode = /^[A-Za-z0-9._-]{1,32}$/.test(candidateCode ?? "") ? candidateCode : "UNKNOWN";
    throw new Error(`Daejeon coverage API provider resultCode ${safeCode}; tags=${parsed.tagSummary}`);
  }
  const tags = new Set(parsed.tagSummary.split(","));
  if (!["response", "header", "resultCode", "body"].every((tag) => tags.has(tag))) {
    throw new Error("Daejeon coverage API schema mismatch: XML envelope");
  }
  const items = [...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (items.length === 0 || items.length !== parsed.itemCount) {
    throw new Error("Daejeon coverage API schema mismatch: XML items");
  }
  const rows = [];
  for (const item of items) {
    const values = Object.fromEntries(expectedFields.map((field) => [field, xmlScalar(item, field)]));
    if (Object.values(values).some((value) => value == null)) {
      throw new Error("Daejeon coverage API schema mismatch: XML item fields");
    }
    validateItem?.(values);
    rows.push(values);
  }
  return { providerResultCode: "00", rowCount: items.length, outputFields: [...expectedFields], rows };
}

function validateDistanceFareItem({ distfloat, fee, min, sec }) {
  const distanceText = distfloat?.trim() ?? "";
  const fareText = fee?.trim() ?? "";
  const minutesText = min?.trim() ?? "";
  const secondsText = sec?.trim() ?? "";
  const distance = Number(distanceText);
  const fare = Number(fareText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (!/^\d+(?:\.\d+)?$/.test(distanceText)
    || !/^\d+$/.test(fareText)
    || !/^\d+$/.test(minutesText)
    || !/^\d+$/.test(secondsText)
    || !Number.isFinite(distance) || distance <= 0
    || !Number.isInteger(fare) || fare < 0
    || !Number.isInteger(minutes) || minutes < 0
    || !Number.isInteger(seconds) || seconds < 0 || seconds > 59) {
    throw new Error("Daejeon coverage API schema mismatch: distance/fare values");
  }
}

function validateOperationQuery(sourceId, query, overridden) {
  if (sourceId !== "daejeon-station-distance-fare") {
    if (overridden) throw new Error(`query override is not allowed for ${sourceId}`);
    return;
  }
  if (!query || typeof query !== "object" || Array.isArray(query)
    || Object.keys(query).sort(codepointCompare).join(",") !== "endstnno,strstnno") {
    throw new Error("Daejeon distance query is invalid");
  }
  const from = String(query.strstnno);
  const to = String(query.endstnno);
  if (!/^1(?:0[1-9]|1\d|2[0-2])$/.test(from)
    || !/^1(?:0[1-9]|1\d|2[0-2])$/.test(to) || from === to) {
    throw new Error("Daejeon distance query is invalid");
  }
}

function validateTimetableItem({ dayType, drctType, stNum, tmList, tmZone }) {
  const stationNumber = Number(stNum);
  const hour = Number(tmZone);
  const tokens = tmList.split(" ");
  const validTokens = tokens.length > 0 && tokens.every((token) => {
    const match = /^(\d{1,2})(?:\(([가-힣A-Za-z0-9.· ]{1,40})\))?$/.exec(token);
    return match && Number(match[1]) >= 0 && Number(match[1]) <= 59;
  });
  if (!new Set(["0", "1"]).has(dayType)
    || !new Set(["0", "1"]).has(drctType)
    || !/^\d{3}$/.test(stNum) || stationNumber < 101 || stationNumber > 122
    || !/^\d{1,2}$/.test(tmZone) || hour < 5 || hour > 24
    || !validTokens) {
    throw new Error("Daejeon coverage API schema mismatch: timetable values");
  }
}

function xmlScalar(raw, field) {
  const match = new RegExp(`<${field}\\b[^>]*>([^<]{0,64})<\\/${field}>`, "i").exec(raw);
  return match?.[1].trim() ?? null;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const sourceId = requiredString(process.env.DAEJEON_API_PROBE_SOURCE_ID, "DAEJEON_API_PROBE_SOURCE_ID");
  const output = requiredString(process.env.DAEJEON_API_PROBE_OUTPUT, "DAEJEON_API_PROBE_OUTPUT");
  if (!path.isAbsolute(output)) throw new Error("DAEJEON_API_PROBE_OUTPUT must be absolute");
  const evidence = await probeDaejeonCoverageApi({ sourceId, serviceKey: process.env.DATA_GO_KR_SERVICE_KEY });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitized Daejeon coverage API evidence ready: ${sourceId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Daejeon coverage API probe failed");
    process.exitCode = 1;
  });
}
