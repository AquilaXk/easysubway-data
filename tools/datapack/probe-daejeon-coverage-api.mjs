#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { scanXmlStructure } from "./lib/source-candidate-evidence-collector.mjs";

export const DAEJEON_COVERAGE_OPERATIONS = Object.freeze({
  "daejeon-train-timetable": Object.freeze({
    endpoint: "https://apis.data.go.kr/B554695/TimeTableSVC/getAllTimeTable",
    format: "xml",
    expectedFields: ["dayType", "drctType", "stNum", "tmList", "tmZone"],
  }),
  "daejeon-station-distance-fare": Object.freeze({
    endpoint: "https://api.odcloud.kr/api/15082979/v1/uddi:bdfe4740-2e2b-4663-94af-b86de0e6e9de",
    format: "json",
    query: { page: "1", perPage: "100", returnType: "JSON" },
  }),
  "daejeon-braille-guide-map": Object.freeze({
    endpoint: "https://api.odcloud.kr/api/15044677/v1/uddi:6d7ceef4-f258-47ea-ab28-c3c7ef005c2c",
    format: "json",
    query: { page: "1", perPage: "100", returnType: "JSON" },
  }),
});

export async function probeDaejeonCoverageApi({ sourceId, serviceKey, fetchImpl = fetch, now = new Date() } = {}) {
  const operation = DAEJEON_COVERAGE_OPERATIONS[sourceId];
  if (!operation) throw new Error(`unsupported Daejeon coverage source: ${sourceId ?? "missing"}`);
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  const url = new URL(operation.endpoint);
  url.searchParams.set("serviceKey", key);
  for (const [name, value] of Object.entries(operation.query ?? {})) url.searchParams.set(name, value);

  const response = await fetchWithRetry(url, operation.format, fetchImpl);
  if (!response.ok) throw new Error(`Daejeon coverage API HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const raw = await response.text();
  let parsed;
  try {
    parsed = operation.format === "xml"
      ? parseXmlEvidence(raw, operation.expectedFields)
      : parseJsonEvidence(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daejeon coverage API parse failure";
    throw new Error(`${message}; observedAt=${now.toISOString()}; httpStatus=${response.status}; `
      + `contentType=${contentType || "missing"}; rawBytes=${Buffer.byteLength(raw)}; rawSha256=${sha256(raw)}`);
  }
  if (operation.format === "xml" && !new Set(["application/xml", "text/xml"]).has(contentType)) {
    throw new Error(`Daejeon coverage API schema mismatch: content-type ${contentType || "missing"}`);
  }
  if (operation.format === "json" && contentType !== "application/json") {
    throw new Error(`Daejeon coverage API schema mismatch: content-type ${contentType || "missing"}`);
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
    rawSha256: sha256(raw),
    credentialRedacted: true,
  };
}

async function fetchWithRetry(url, format, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: format === "xml" ? "application/xml,text/xml" : "application/json" },
      });
    } catch (error) {
      if (attempt === 1) throw new Error("Daejeon coverage API transport failure", { cause: error });
    }
  }
  throw new Error("Daejeon coverage API transport failure");
}

function parseXmlEvidence(raw, expectedFields) {
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
  const outputFields = expectedFields.filter((field) => tags.has(field));
  if (parsed.itemCount > 0 && outputFields.length !== expectedFields.length) {
    throw new Error("Daejeon coverage API schema mismatch: XML item fields");
  }
  return { providerResultCode: "00", rowCount: parsed.itemCount, outputFields };
}

function xmlScalar(raw, field) {
  const match = new RegExp(`<${field}\\b[^>]*>([^<]{0,64})<\\/${field}>`, "i").exec(raw);
  return match?.[1].trim() ?? null;
}

function parseJsonEvidence(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Daejeon coverage API schema mismatch: invalid JSON");
  }
  if (!Array.isArray(parsed?.data) || !Number.isInteger(parsed.currentCount)
    || parsed.currentCount !== parsed.data.length || !Number.isInteger(parsed.totalCount)) {
    throw new Error("Daejeon coverage API schema mismatch: JSON envelope");
  }
  const outputFields = [...new Set(parsed.data.flatMap((row) => (
    row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []
  )))].sort((left, right) => left.localeCompare(right, "ko"));
  return { providerResultCode: "00", rowCount: parsed.data.length, outputFields };
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
