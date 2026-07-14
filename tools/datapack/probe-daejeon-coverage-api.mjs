#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { scanXmlStructure } from "./lib/source-candidate-evidence-collector.mjs";

export const DAEJEON_COVERAGE_OPERATIONS = Object.freeze({
  "daejeon-train-timetable": Object.freeze({
    endpoint: "https://apis.data.go.kr/B554695/TimeTableSVC/getAllTimeTable",
    expectedFields: ["dayType", "drctType", "stNum", "tmList", "tmZone"],
  }),
  "daejeon-station-distance-fare": Object.freeze({
    endpoint: "https://apis.data.go.kr/B554695/TimeDistSVC/getTimeDist01",
    query: { strstnno: "111", endstnno: "120" },
    expectedFields: ["distfloat", "fee", "min", "sec"],
    validateItem: validateDistanceFareItem,
  }),
});

export async function probeDaejeonCoverageApi({ sourceId, serviceKey, fetchImpl = fetch, now = new Date() } = {}) {
  const operation = DAEJEON_COVERAGE_OPERATIONS[sourceId];
  if (!operation) throw new Error(`unsupported Daejeon coverage source: ${sourceId ?? "missing"}`);
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  const url = new URL(operation.endpoint);
  url.searchParams.set("serviceKey", key);
  for (const [name, value] of Object.entries(operation.query ?? {})) url.searchParams.set(name, value);

  const response = await fetchWithRetry(url, fetchImpl);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const raw = await response.text();
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
    rawBytes: Buffer.byteLength(raw),
    rawSha256: sha256(raw),
    credentialRedacted: true,
  };
}

async function fetchWithRetry(url, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/xml,text/xml" },
      });
    } catch (error) {
      if (attempt === 1) throw new Error("Daejeon coverage API transport failure", { cause: error });
    }
  }
  throw new Error("Daejeon coverage API transport failure");
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
  for (const item of items) {
    const values = Object.fromEntries(expectedFields.map((field) => [field, xmlScalar(item, field)]));
    if (Object.values(values).some((value) => value == null)) {
      throw new Error("Daejeon coverage API schema mismatch: XML item fields");
    }
    validateItem?.(values);
  }
  return { providerResultCode: "00", rowCount: items.length, outputFields: [...expectedFields] };
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

function xmlScalar(raw, field) {
  const match = new RegExp(`<${field}\\b[^>]*>([^<]{0,64})<\\/${field}>`, "i").exec(raw);
  return match?.[1].trim() ?? null;
}

function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
