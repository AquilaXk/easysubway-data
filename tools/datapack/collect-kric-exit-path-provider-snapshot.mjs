import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { classifyKricTransportFailure } from "./collect-kric-accessibility-snapshots.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";

const QUERY_KEYS = [
  "queryId", "routeEdgeId", "providerOperatorId", "providerLineId",
  "providerStationId", "providerNextStationId", "operatorName", "lineName",
  "stationName", "regionId",
];
const ROW_FIELDS = [
  "edMovePath", "elvtSttCd", "elvtTpCd", "exitMvTpOrdr",
  "imgPath", "mvContDtl", "mvPathMgNo", "stMovePath",
];
const SNAPSHOT_KEYS = [
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "freshUntil",
  "credentialRedacted", "collectionPlanDigest", "queryPlanSha256", "coverage", "queryPlan",
  "results", "snapshotDigest",
];
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_INTERVAL_MS = 60_000;
const COLLECTION_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export const KRIC_EXIT_PATH_SOURCES = Object.freeze({
  "kric-station-movement-standard": Object.freeze({
    endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationMovement",
    responseFields: Object.freeze([...ROW_FIELDS]),
  }),
  "kric-station-movement-detailed": Object.freeze({
    endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/stationMovement",
    responseFields: Object.freeze([...ROW_FIELDS]),
  }),
});

export async function collectKricExitPathProviderSnapshot({
  collectionPlan,
  sourceId,
  serviceKey,
  fetchImpl = fetch,
  now = new Date(),
  requestTimeoutMs = 30_000,
  requestIntervalMs = 0,
  delayImpl = delay,
} = {}) {
  const source = KRIC_EXIT_PATH_SOURCES[sourceId];
  if (!source) throw new Error(`unsupported KRIC EXIT source: ${sourceId ?? "[missing]"}`);
  const queryPlan = validateCollectionPlan(collectionPlan);
  if (typeof serviceKey !== "string" || serviceKey.length === 0) throw new Error("KRIC_SERVICE_KEY is required");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("collection time must be valid");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error("KRIC EXIT request timeout is invalid");
  }
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > MAX_REQUEST_INTERVAL_MS) {
    throw new Error("KRIC EXIT request interval is invalid");
  }
  if (typeof fetchImpl !== "function" || typeof delayImpl !== "function") {
    throw new TypeError("KRIC EXIT collector dependencies are invalid");
  }

  const results = [];
  for (let index = 0; index < queryPlan.length; index += 1) {
    if (index > 0 && requestIntervalMs > 0) await delayImpl(requestIntervalMs);
    results.push(await collectQuery({
      fetchImpl,
      query: queryPlan[index],
      requestTimeoutMs,
      serviceKey,
      source,
    }));
  }

  const capturedAt = now.toISOString();
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "kric-exit-path-provider-snapshot",
    sourceId,
    snapshotId: `${sourceId}-${capturedAt.replaceAll(/[-:.]/g, "")}`,
    capturedAt,
    freshUntil: new Date(now.getTime() + COLLECTION_FRESHNESS_MS).toISOString(),
    credentialRedacted: true,
    collectionPlanDigest: collectionPlan.collectionPlanDigest,
    queryPlanSha256: collectionPlan.queryPlanSha256,
    coverage: canonicalObject({
      requestPlanComplete: true,
      queryIds: queryPlan.map(({ queryId }) => queryId),
    }),
    queryPlan,
    results,
  });
  const snapshot = canonicalObject({ ...payload, snapshotDigest: sha256(canonicalJson(payload)) });
  if (containsCredential(snapshot, serviceKey)) throw new Error("KRIC EXIT credential appeared in output");
  return snapshot;
}

export function resolveKricExitPathProviderQuery({ collectionPlan, queryId, sourceId } = {}) {
  const source = KRIC_EXIT_PATH_SOURCES[sourceId];
  if (!source) throw new Error(`unsupported KRIC EXIT source: ${sourceId ?? "[missing]"}`);
  if (typeof queryId !== "string" || !/^[0-9a-f]{64}$/.test(queryId)) {
    throw new Error("KRIC EXIT query ID is invalid");
  }
  const query = validateCollectionPlan(collectionPlan).find((candidate) => candidate.queryId === queryId);
  if (!query) throw new Error("KRIC EXIT query ID is not present in the collection plan");
  return { query, source };
}

export async function probeKricExitPathProviderQuery({
  collectionPlan,
  queryId,
  sourceId,
  serviceKey,
  fetchImpl = fetch,
  requestTimeoutMs = 30_000,
} = {}) {
  const { query, source } = resolveKricExitPathProviderQuery({ collectionPlan, queryId, sourceId });
  if (typeof serviceKey !== "string" || serviceKey.length === 0) throw new Error("KRIC_SERVICE_KEY is required");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error("KRIC EXIT request timeout is invalid");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("KRIC EXIT probe dependency is invalid");
  return collectQuery({ fetchImpl, query, requestTimeoutMs, serviceKey, source });
}

export function canonicalKricExitPathProviderSnapshotJson(snapshot) {
  assertKeys(snapshot, SNAPSHOT_KEYS, "KRIC EXIT provider snapshot keys");
  assertSha256(snapshot.snapshotDigest, "KRIC EXIT provider snapshot digest");
  const { snapshotDigest, ...payload } = snapshot;
  if (sha256(canonicalJson(payload)) !== snapshotDigest) {
    throw new Error("KRIC EXIT provider snapshot digest mismatch");
  }
  return canonicalJson(snapshot);
}

function validateCollectionPlan(plan) {
  canonicalKricExitPathCollectionPlanJson(plan);
  if (!Array.isArray(plan.queryPlan) || plan.queryPlan.length === 0) {
    throw new Error("KRIC EXIT query plan must be non-empty");
  }
  const queryIds = new Set();
  const providerTuples = new Set();
  const queries = plan.queryPlan.map((query) => {
    assertKeys(query, QUERY_KEYS, "KRIC EXIT provider query keys");
    for (const key of QUERY_KEYS) assertNonBlank(query[key], `KRIC EXIT provider query ${key}`);
    const identity = canonicalObject({
      providerLineId: query.providerLineId,
      providerNextStationId: query.providerNextStationId,
      providerOperatorId: query.providerOperatorId,
      providerStationId: query.providerStationId,
      routeEdgeId: query.routeEdgeId,
    });
    if (query.queryId !== sha256(canonicalJson(identity))) {
      throw new Error("KRIC EXIT provider query identity mismatch");
    }
    if (queryIds.has(query.queryId)) throw new Error("duplicate KRIC EXIT provider query id");
    queryIds.add(query.queryId);
    const providerTuple = [
      query.providerOperatorId,
      query.providerLineId,
      query.providerStationId,
      query.providerNextStationId,
    ].join("\0");
    if (providerTuples.has(providerTuple)) throw new Error("duplicate KRIC EXIT provider request tuple");
    providerTuples.add(providerTuple);
    return canonicalObject(query);
  });
  if (canonicalJson(queries) !== canonicalJson([...queries].sort(compareQueries))) {
    throw new Error("KRIC EXIT provider query order mismatch");
  }
  if (sha256(canonicalJson(queries)) !== plan.queryPlanSha256) {
    throw new Error("EXIT query plan digest mismatch");
  }
  return queries;
}

async function collectQuery({ fetchImpl, query, requestTimeoutMs, serviceKey, source }) {
  const url = buildProviderUrl(source.endpoint, query, serviceKey);
  const bytes = await requestProviderBytes({ fetchImpl, queryId: query.queryId, requestTimeoutMs, url });
  const { providerResultCode, providerRows, resultState } = parseProviderResult({
    bytes,
    queryId: query.queryId,
    serviceKey,
  });
  const rows = normalizeProviderRows(providerRows, query.queryId);
  return canonicalObject({
    queryId: query.queryId,
    state: resultState,
    providerResultCode,
    rawResponseSha256: sha256(bytes),
    rawResponseByteSize: bytes.length,
    providerRecordHash: sha256(canonicalJson(rows)),
    rows,
  });
}

function buildProviderUrl(endpoint, query, serviceKey) {
  const url = new URL(endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("railOprIsttCd", query.providerOperatorId);
  url.searchParams.set("lnCd", query.providerLineId);
  url.searchParams.set("stinCd", query.providerStationId);
  url.searchParams.set("nextStinCd", query.providerNextStationId);
  return url;
}

async function requestProviderBytes({ fetchImpl, queryId, requestTimeoutMs, url }) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`KRIC EXIT request failed: ${classifyKricTransportFailure(error) ?? "NETWORK_UNKNOWN"}: ${queryId}`);
  }
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : "unknown";
    throw new Error(`KRIC EXIT HTTP ${status}: ${queryId}`);
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`KRIC EXIT request failed: ${classifyKricTransportFailure(error) ?? "NETWORK_UNKNOWN"}: ${queryId}`);
  }
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(`KRIC EXIT response size invalid: ${queryId}`);
  }
  return bytes;
}

function parseProviderResult({ bytes, queryId, serviceKey }) {
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`KRIC EXIT response must be strict UTF-8 JSON: ${queryId}`);
  }
  if (raw.includes(serviceKey)) throw new Error(`KRIC EXIT response echoed credential: ${queryId}`);
  let payload;
  try {
    payload = parseStrictJson(raw);
  } catch (error) {
    if (error instanceof Error && error.message === "duplicate JSON key") throw error;
    throw new Error(`KRIC EXIT response must be strict UTF-8 JSON: ${queryId}`);
  }
  if (containsCredential(payload, serviceKey)) {
    throw new Error(`KRIC EXIT response echoed credential: ${queryId}`);
  }
  return classifyProviderPayload(payload, queryId);
}

function classifyProviderPayload(payload, queryId) {
  let providerResultCode = null;
  let resultState = "PROVIDER_RESULT_UNVERIFIED";
  let providerRows;
  if (Array.isArray(payload)) {
    providerRows = payload;
  } else {
    let headerOnly = false;
    try {
      assertKeys(payload, ["body", "header"], "KRIC EXIT response envelope keys");
    } catch {
      try {
        assertKeys(payload, ["header"], "KRIC EXIT response envelope keys");
        headerOnly = true;
      } catch {
        throw new Error(buildEnvelopeDiagnostic(payload, queryId));
      }
    }
    if (!payload.header || typeof payload.header !== "object" || Array.isArray(payload.header)) {
      throw new Error(`KRIC EXIT response header mismatch: ${queryId}`);
    }
    providerResultCode = payload.header.resultCode;
    if (typeof providerResultCode !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(providerResultCode)) {
      throw new Error(`KRIC EXIT provider result invalid: ${queryId}/UNKNOWN`);
    }
    if (providerResultCode !== "00" && providerResultCode !== "03") {
      throw new Error(`KRIC EXIT provider result invalid: ${queryId}/${providerResultCode}`);
    }
    if (headerOnly) {
      if (providerResultCode !== "03") {
        throw new Error(`KRIC EXIT provider header-only shape mismatch: ${queryId}/${providerResultCode}`);
      }
      providerRows = [];
      resultState = "PROVIDER_NO_DATA";
      return { providerResultCode, providerRows, resultState };
    }
    if (!Array.isArray(payload.body)) {
      throw new TypeError(`KRIC EXIT response body must be an array: ${queryId}`);
    }
    providerRows = payload.body;
    if (providerResultCode === "03") {
      if (providerRows.length !== 0) throw new Error(`KRIC EXIT provider no-data shape mismatch: ${queryId}`);
      resultState = "PROVIDER_NO_DATA";
    } else if (providerResultCode === "00") {
      resultState = providerRows.length === 0 ? "EXPLICIT_ZERO" : "ROWS_OBSERVED";
    }
  }
  return { providerResultCode, providerRows, resultState };
}

function normalizeProviderRows(providerRows, queryId) {
  const rows = providerRows.map(validateProviderRow).sort(compareProviderRows);
  const seenRows = new Set();
  for (const row of rows) {
    const key = canonicalJson(row);
    if (seenRows.has(key)) throw new Error(`duplicate KRIC EXIT provider row: ${queryId}`);
    seenRows.add(key);
  }
  return rows;
}

function containsCredential(value, serviceKey) {
  const encodedVariants = new Set([
    encodeURIComponent(serviceKey),
    new URLSearchParams({ serviceKey }).toString().slice("serviceKey=".length),
  ].map(normalizePercentEncoding));
  const visit = (candidate) => {
    if (typeof candidate === "string") {
      if (candidate.includes(serviceKey)) return true;
      const normalized = normalizePercentEncoding(candidate);
      return [...encodedVariants].some((variant) => variant.length > 0 && normalized.includes(variant));
    }
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (candidate && typeof candidate === "object") {
      return Object.entries(candidate).some(([key, nested]) => visit(key) || visit(nested));
    }
    return false;
  };
  return visit(value);
}

function normalizePercentEncoding(value) {
  return value.replaceAll(/%[0-9a-f]{2}/gi, (token) => token.toUpperCase());
}

function validateProviderRow(row) {
  assertKeys(row, ROW_FIELDS, "KRIC EXIT provider row keys");
  for (const field of ROW_FIELDS) {
    const value = row[field];
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`KRIC EXIT provider row scalar mismatch: ${field}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`KRIC EXIT provider row scalar mismatch: ${field}`);
    }
  }
  for (const field of ["mvPathMgNo", "exitMvTpOrdr"]) {
    const value = row[field];
    if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
      throw new Error(`KRIC EXIT provider row ordering identity missing: ${field}`);
    }
  }
  return canonicalObject(row);
}

function parseStrictJson(raw) {
  let index = 0;
  const fail = () => { throw new Error("invalid JSON"); };
  const skipWhitespace = () => {
    while (isJsonWhitespace(raw[index])) index += 1;
  };
  const parseString = () => {
    if (raw[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") {
        index += 2;
        continue;
      }
      if (raw[index] === '"') {
        index += 1;
        try {
          return JSON.parse(raw.slice(start, index));
        } catch {
          fail();
        }
      }
      if (raw.codePointAt(index) < 0x20) fail();
      index += 1;
    }
    fail();
  };
  const parseNumber = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(index));
    if (!match) fail();
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail();
    return value;
  };
  const parseValue = () => {
    skipWhitespace();
    if (raw[index] === '"') return parseString();
    if (raw[index] === "{") return parseObject();
    if (raw[index] === "[") return parseArray();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (raw.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    return parseNumber();
  };
  const parseObject = () => {
    index += 1;
    skipWhitespace();
    const value = Object.create(null);
    const keys = new Set();
    if (raw[index] === "}") {
      index += 1;
      return value;
    }
    while (index < raw.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) throw new Error("duplicate JSON key");
      keys.add(key);
      skipWhitespace();
      if (raw[index] !== ":") fail();
      index += 1;
      value[key] = parseValue();
      skipWhitespace();
      if (raw[index] === "}") {
        index += 1;
        return value;
      }
      if (raw[index] !== ",") fail();
      index += 1;
    }
    fail();
  };
  const parseArray = () => {
    index += 1;
    skipWhitespace();
    const value = [];
    if (raw[index] === "]") {
      index += 1;
      return value;
    }
    while (index < raw.length) {
      value.push(parseValue());
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return value;
      }
      if (raw[index] !== ",") fail();
      index += 1;
    }
    fail();
  };
  const value = parseValue();
  skipWhitespace();
  if (index !== raw.length) fail();
  return value;
}

function isJsonWhitespace(character) {
  const codePoint = character?.codePointAt(0);
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20;
}

function assertKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} mismatch`);
  const actual = Object.keys(value).sort(compareBytes);
  const expected = [...keys].sort(compareBytes);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} mismatch`);
}

function buildEnvelopeDiagnostic(payload, queryId) {
  const candidateResultCode = payload?.header?.resultCode ?? payload?.resultCode;
  const resultCode = typeof candidateResultCode === "string"
    && /^[A-Za-z0-9._-]{1,32}$/.test(candidateResultCode)
    ? candidateResultCode
    : "UNKNOWN";
  return [
    `KRIC EXIT response envelope keys mismatch: ${queryId}/${resultCode}`,
    `keys=${safeDiagnosticKeys(payload).join(",")}`,
    `bodyKeys=${safeDiagnosticKeys(payload?.body).join(",")}`,
  ].join("; ");
}

function safeDiagnosticKeys(value) {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value)
    .filter((key) => /^[A-Za-z0-9._-]{1,32}$/.test(key))
    .sort(compareBytes)
    .slice(0, 12);
}

function assertNonBlank(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be non-blank`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be lowercase sha256`);
}

function compareQueries(left, right) {
  return compareBytes(left.providerStationId, right.providerStationId)
    || compareBytes(left.providerNextStationId, right.providerNextStationId)
    || compareBytes(left.routeEdgeId, right.routeEdgeId)
    || compareBytes(left.queryId, right.queryId);
}

function compareProviderRows(left, right) {
  return compareBytes(String(left.mvPathMgNo), String(right.mvPathMgNo))
    || compareBytes(String(left.exitMvTpOrdr), String(right.exitMvTpOrdr))
    || compareBytes(canonicalJson(left), canonicalJson(right));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
