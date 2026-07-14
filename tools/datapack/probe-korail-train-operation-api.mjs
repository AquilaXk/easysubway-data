#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API_ORIGIN = "https://apis.data.go.kr";

export const KORAIL_TRAIN_OPERATION_APIS = Object.freeze({
  "korail-train-operation-codes": Object.freeze({
    endpoint: `${API_ORIGIN}/B551457/run/v2/codes2`,
    expectedFields: Object.freeze(["code", "type", "value"]),
    query: Object.freeze({ "cond[type::EQ]": "mrnt_cd" }),
  }),
  "korail-traveler-train-run-plan": Object.freeze({
    endpoint: `${API_ORIGIN}/B551457/run/v2/travelerTrainRunPlan2`,
    expectedFields: Object.freeze([
      "run_ymd", "trn_no", "dptre_stn_cd", "dptre_stn_nm", "arvl_stn_cd", "arvl_stn_nm",
      "trn_plan_dptre_dt", "trn_plan_arvl_dt",
    ]),
    requiresRunDate: true,
  }),
  "korail-traveler-train-run-info": Object.freeze({
    endpoint: `${API_ORIGIN}/B551457/run/v2/travelerTrainRunInfo2`,
    expectedFields: Object.freeze([
      "run_ymd", "trn_no", "trn_run_sn", "stn_cd", "stn_nm", "mrnt_cd", "mrnt_nm",
      "uppln_dn_se_cd", "stop_se_cd", "stop_se_nm", "trn_dptre_dt", "trn_arvl_dt",
    ]),
    requiresRunDate: true,
  }),
});

export async function probeKorailTrainOperationApi({
  sourceId,
  runDate,
  serviceKey,
  fetchImpl = fetch,
} = {}) {
  const operation = KORAIL_TRAIN_OPERATION_APIS[sourceId];
  if (!operation) throw new Error(`unsupported Korail train operation source: ${sourceId ?? "missing"}`);
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  if (operation.requiresRunDate && !/^\d{8}$/.test(runDate ?? "")) {
    throw new Error("KORAIL_TRAIN_OPERATION_RUN_DATE must be YYYYMMDD");
  }

  const url = new URL(operation.endpoint);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "10");
  url.searchParams.set("returnType", "JSON");
  for (const [name, value] of Object.entries(operation.query ?? {})) url.searchParams.set(name, value);
  if (operation.requiresRunDate) {
    url.searchParams.set("cond[run_ymd::GTE]", runDate);
    url.searchParams.set("cond[run_ymd::LTE]", runDate);
  }

  const response = await fetchWithRetry(url, fetchImpl);
  if (!response.ok) throw new Error(`Korail train operation API HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (contentType !== "application/json") {
    throw new Error(`Korail train operation API schema mismatch: content-type ${safeToken(contentType)}`);
  }
  const raw = await response.text();
  const parsed = parseJsonEvidence(raw, operation.expectedFields);
  return {
    schemaVersion: 1,
    artifactKind: "korail-train-operation-api-probe-evidence",
    sourceId,
    endpoint: operation.endpoint,
    runDate: operation.requiresRunDate ? runDate : null,
    httpStatus: response.status,
    providerResultCode: parsed.providerResultCode,
    schemaStatus: "EXPECTED",
    rowCount: parsed.rowCount,
    totalCount: parsed.totalCount,
    outputFields: operation.expectedFields,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    credentialRedacted: true,
  };
}

async function fetchWithRetry(url, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json" },
      });
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 1) return response;
      if (response.body) await response.body.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error) {
      if (attempt === 1) throw new Error("Korail train operation API transport failure", { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Korail train operation API transport failure");
}

function parseJsonEvidence(raw, expectedFields) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error("Korail train operation API schema mismatch: invalid JSON");
  }
  const response = objectValue(document?.response, "response", document);
  const header = objectValue(response.header, "response.header", response);
  const resultCode = safeToken(header.resultCode);
  if (resultCode !== "0") {
    throw new Error(`Korail train operation API provider resultCode ${resultCode}`);
  }
  const body = objectValue(response.body, "response.body", response);
  const items = objectValue(body.items, "response.body.items", body);
  const rows = Array.isArray(items.item) ? items.item : items.item == null ? [] : [items.item];
  if (rows.length === 0) throw new Error("Korail train operation API returned zero rows");
  if (rows.some((row) => row == null || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("Korail train operation API schema mismatch: item must be an object");
  }
  for (const [index, row] of rows.entries()) {
    const observedFields = Object.keys(row).sort((left, right) => left.localeCompare(right, "en"));
    const missingFields = expectedFields.filter((field) => !Object.hasOwn(row, field));
    if (missingFields.length > 0) {
      throw new Error(
        `Korail train operation API schema mismatch: item[${index}] fields missing=${missingFields.join(",")}; observed=${observedFields.map(safeToken).join(",")}`,
      );
    }
  }
  const totalCount = Number(body.totalCount);
  if (!Number.isInteger(totalCount) || totalCount < rows.length) {
    throw new Error("Korail train operation API schema mismatch: totalCount");
  }
  return { providerResultCode: resultCode, rowCount: rows.length, totalCount };
}

function objectValue(value, label, parent) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    const observed = parent && typeof parent === "object" && !Array.isArray(parent)
      ? Object.keys(parent).map(safeToken).sort((left, right) => left.localeCompare(right, "en")).join(",")
      : "none";
    throw new Error(`Korail train operation API schema mismatch: ${label}; observed=${observed}`);
  }
  return value;
}

function safeToken(value) {
  const text = String(value ?? "UNKNOWN");
  return /^[A-Za-z0-9._/+:-]{1,64}$/.test(text) ? text : "UNKNOWN";
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

async function main() {
  const sourceId = requiredString(process.env.KORAIL_TRAIN_OPERATION_API_SOURCE_ID, "KORAIL_TRAIN_OPERATION_API_SOURCE_ID");
  const output = requiredString(process.env.KORAIL_TRAIN_OPERATION_API_OUTPUT, "KORAIL_TRAIN_OPERATION_API_OUTPUT");
  if (!path.isAbsolute(output)) throw new Error("KORAIL_TRAIN_OPERATION_API_OUTPUT must be absolute");
  const evidence = await probeKorailTrainOperationApi({
    sourceId,
    runDate: process.env.KORAIL_TRAIN_OPERATION_RUN_DATE,
    serviceKey: process.env.DATA_GO_KR_SERVICE_KEY,
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitized Korail train operation API evidence ready: ${sourceId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Korail train operation API probe failed");
    process.exitCode = 1;
  });
}
