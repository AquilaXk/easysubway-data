#!/usr/bin/env node
import { constants as fileSystemConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyKricTransportFailure as classifyTransportFailure } from "./collect-kric-accessibility-snapshots.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import {
  createTransientRetryBudget,
  fullJitterBackoffMs,
  isTransientTransportError,
  parseRetryAfterMs,
  unwrapTransientRetryFailure,
  withTransientRetry,
} from "./lib/transient-retry.mjs";

const SOURCES = {
  accessibility: {
    endpoint: "https://apis.data.go.kr/B553766/wksn/getWksnElvtr",
    sourceId: "seoul-metro-accessibility",
    artifactKind: "seoul-accessibility-snapshot",
    schemaFields: ["dtlPstn", "lineNm", "oprtngSitu", "stnNm"],
  },
  "facility-location": {
    endpoint: "https://apis.data.go.kr/B553766/facility/getFcElvtr",
    sourceId: "seoul-metro-facility-location",
    artifactKind: "seoul-facility-location-snapshot",
    schemaFields: ["dtlPstn", "lineNm", "oprtngSitu", "stnCd", "stnNm"],
  },
};
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// 일시 오류 재시도(#1326, Refs #870): 멱등 GET만, 최초 1회 + 재시도 2회. 대기는 full jitter random(0, min(cap, base·2^n))이고 Retry-After는 cap 안에서 따르고 cap을 넘으면 기다리지 않고 실패한다.
// 요청 하나의 최악 시간은 3 × 요청 timeout + 2 × cap = 130초다(workflow timeout 45분 안, 요청은 page마다 하나).
export const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
export const RETRY_CAP_DELAY_MS = 20_000;
const RATE_LIMITED_STATUS = 429;
const TRANSIENT_HTTP_STATUSES = new Set([RATE_LIMITED_STATUS, 502, 503, 504]);
const RETRY_AFTER_EXCEEDS_CAP = "RETRY_AFTER_EXCEEDS_CAP";
// 429는 쿼터 신호다: Retry-After가 있으면 cap 안에서 그 값을 기다려 재시도하고, 없으면 jitter 대기로 한 번만 재시도한다.
const MAX_UNHINTED_RATE_LIMIT_RETRIES = 1;
const INVALID_RESPONSE = "Seoul accessibility API response invalid";
const INVALID_OUTPUT_PATH = "output path must stay within allowed root";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_SNAPSHOT_ROOT = resolve(REPOSITORY_ROOT, "tools/datapack/sources");

// 공식 oprtngSitu 코드(서울교통공사 wksnElvtr): M 사용가능 / D 삭제 / S 보수중 / T 중지 / I 점검중 / B 공사중.
// M만 실측 가동, S/T/I/B는 실측 비가동(검증된 비가용), D는 폐기 행이므로 증거에서 제외한다.
const OPERATION_SITUATION_STATES = new Map([
  ["M", { operational: true, situationCode: "M", situation: "사용가능" }],
  ["S", { operational: false, situationCode: "S", situation: "보수중" }],
  ["T", { operational: false, situationCode: "T", situation: "중지" }],
  ["I", { operational: false, situationCode: "I", situation: "점검중" }],
  ["B", { operational: false, situationCode: "B", situation: "공사중" }],
]);
const REMOVED_OPERATION_SITUATION = "D";

export function normalizeAccessibilityRows(rows, { source = "accessibility" } = {}) {
  if (!Object.hasOwn(SOURCES, source)) throw new Error(`${INVALID_RESPONSE}: source`);
  if (!Array.isArray(rows)) {
    throw new Error(INVALID_RESPONSE);
  }
  const normalized = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${INVALID_RESPONSE}: row`);
    }
    const { lineNm, stnNm, stnCd, oprtngSitu, dtlPstn } = row;
    const requiredFields = source === "facility-location"
      ? { lineNm, stnNm, stnCd, dtlPstn }
      : { lineNm, stnNm, dtlPstn };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${INVALID_RESPONSE}: requiredField:${field}`);
      }
    }
    if (oprtngSitu !== undefined && oprtngSitu !== null && typeof oprtngSitu !== "string") {
      throw new Error(`${INVALID_RESPONSE}: requiredField:oprtngSitu`);
    }
    const operationCode = oprtngSitu?.trim() ?? "";
    if (operationCode === REMOVED_OPERATION_SITUATION) {
      continue;
    }
    const state = !operationCode
      ? { operational: null, situationCode: null, situation: "PROVIDER_STATUS_MISSING" }
      : OPERATION_SITUATION_STATES.get(operationCode);
    if (!state) {
      throw new Error(`${INVALID_RESPONSE}: operationState`);
    }
    normalized.push({
      stationName: stnNm.trim(),
      lineName: lineNm.trim(),
      ...(source === "facility-location" ? { providerStationCode: stnCd.trim() } : {}),
      operational: state.operational,
      situationCode: state.situationCode,
      situation: state.situation,
      pathDescription: dtlPstn.trim(),
    });
  }
  return normalized;
}

export function buildAccessibilitySnapshot(
  rows,
  retrievedAt,
  { source = "accessibility", rawRowCount, rawSha256, previousSnapshot = null },
) {
  if (!Object.hasOwn(SOURCES, source)) throw new Error(`${INVALID_RESPONSE}: source`);
  const sourceConfig = SOURCES[source];
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.stationName !== "string" ||
        row.stationName.trim() === "" ||
        typeof row.lineName !== "string" ||
        row.lineName.trim() === "" ||
        (source === "facility-location" &&
          (typeof row.providerStationCode !== "string" || row.providerStationCode.trim() === "")) ||
        !(
          (typeof row.operational === "boolean" &&
            typeof row.situationCode === "string" &&
            OPERATION_SITUATION_STATES.has(row.situationCode)) ||
          (row.operational === null &&
            row.situationCode === null &&
            row.situation === "PROVIDER_STATUS_MISSING")
        ) ||
        typeof row.situation !== "string" ||
        row.situation.trim() === "" ||
        typeof row.pathDescription !== "string" ||
        row.pathDescription.trim() === "",
    )
  ) {
    throw new Error(INVALID_RESPONSE);
  }
  if (!Number.isSafeInteger(rawRowCount) || rawRowCount < rows.length || !/^[0-9a-f]{64}$/.test(rawSha256 ?? "")) {
    throw new Error(`${INVALID_RESPONSE}: rawIdentity`);
  }
  const retrievedMillis = Date.parse(retrievedAt);
  const snapshotId = `${sourceConfig.sourceId}-${typeof retrievedAt === "string" ? retrievedAt.replaceAll(/[-:.]/g, "") : ""}`;
  if (typeof retrievedAt !== "string"
    || !Number.isFinite(retrievedMillis)
    || new Date(retrievedMillis).toISOString() !== retrievedAt) {
    throw new Error(`${INVALID_RESPONSE}: snapshotIdentity`);
  }
  let previousSnapshotId = null;
  if (previousSnapshot !== null) {
    const previousMillis = Date.parse(previousSnapshot?.retrievedAt);
    const previousFullId = `${sourceConfig.sourceId}-${typeof previousSnapshot?.retrievedAt === "string"
      ? previousSnapshot.retrievedAt.replaceAll(/[-:.]/g, "") : ""}`;
    const previousLegacyId = `${sourceConfig.sourceId}-${typeof previousSnapshot?.retrievedAt === "string"
      ? previousSnapshot.retrievedAt.slice(0, 10).replaceAll("-", "") : ""}`;
    if (previousSnapshot?.schemaVersion !== 1
      || previousSnapshot?.artifactKind !== sourceConfig.artifactKind
      || previousSnapshot?.sourceId !== sourceConfig.sourceId
      || !Number.isFinite(previousMillis)
      || new Date(previousMillis).toISOString() !== previousSnapshot.retrievedAt
      || ![previousFullId, previousLegacyId].includes(previousSnapshot.snapshotId)
      || previousMillis >= retrievedMillis) {
      throw new Error(`${INVALID_RESPONSE}: snapshotIdentity`);
    }
    previousSnapshotId = previousSnapshot.snapshotId;
  }
  const stationsByIdentity = new Map();
  const stationIdentity = (station) => `${station.lineName}\0${station.stationName}${
    source === "facility-location" ? `\0${station.providerStationCode}` : ""
  }`;
  for (const row of rows) {
    const key = stationIdentity(row);
    const station = stationsByIdentity.get(key) ?? {
      stationName: row.stationName,
      lineName: row.lineName,
      ...(source === "facility-location" ? { providerStationCode: row.providerStationCode } : {}),
      facilities: [],
    };
    station.facilities.push({
      operational: row.operational,
      situationCode: row.situationCode,
      situation: row.situation,
      pathDescription: row.pathDescription,
    });
    stationsByIdentity.set(key, station);
  }
  const stations = [...stationsByIdentity.values()].sort((left, right) => (
    compare(stationIdentity(left), stationIdentity(right))
  ));
  for (const station of stations) {
    station.facilities.sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  }
  const contentSha256 = hash(stations);
  return {
    schemaVersion: 1,
    artifactKind: sourceConfig.artifactKind,
    sourceId: sourceConfig.sourceId,
    snapshotId,
    previousSnapshotId,
    retrievedAt,
    capturedAt: retrievedAt,
    observedAt: retrievedAt,
    freshUntil: new Date(retrievedMillis + 86_400_000).toISOString(),
    credentialRedacted: true,
    absenceEvidenceMode: "EXHAUSTIVE_LIST",
    rowCount: rawRowCount,
    normalizedRowCount: rows.length,
    rawSha256,
    contentSha256,
    schemaFingerprint: hash(sourceConfig.schemaFields),
    stations,
  };
}

const logRetryLine = (line) => { process.stderr.write(`${line}\n`); };

function failureKind(error) {
  return classifyTransportFailure(error) ?? "NETWORK_UNKNOWN";
}

const attemptFailureKind = ({ error, result }) => (error === undefined ? `HTTP_${result.response.status}` : failureKind(error));

// 본문 수신 중 전송 오류(timeout·reset)는 시도를 다시 하게 던지고, 그 밖의 읽기 실패는 raw 없음으로 돌려줘 호출자가 응답 형식 오류로 거부한다.
async function readBodyOrTransportError(response) {
  try {
    return await response.text();
  } catch (error) {
    if (isTransientTransportError(error)) throw error;
    return undefined;
  }
}

const retryAfterOf = (response) => parseRetryAfterMs(response.headers?.get("retry-after"));

// 서버가 정한 대기보다 일찍 다시 요청하면 안 된다: cap을 넘는 Retry-After는 잘라서 재시도하지 않고 실패한다(fail-closed).
class RetryAfterExceedsCapError extends Error {
  constructor(status, retryAfterMilliseconds) {
    super(`Seoul accessibility API HTTP ${status}: ${RETRY_AFTER_EXCEEDS_CAP} retryAfterSeconds=${Math.ceil(retryAfterMilliseconds / 1_000)} capSeconds=${RETRY_CAP_DELAY_MS / 1_000}`);
    this.code = RETRY_AFTER_EXCEEDS_CAP;
  }
}

// 재시도하려고 버리는 응답의 본문은 읽지 않으므로 취소해 연결이 남지 않게 한다. 취소 실패는 수집을 막지 않는다.
const discardBody = (response) => { response.body?.cancel?.().catch(() => {}); };

function retryDelayMs({ retryIndex, result, random }) {
  const retryAfter = result === undefined ? undefined : retryAfterOf(result.response);
  if (retryAfter === undefined) return fullJitterBackoffMs(retryIndex, { baseMs: RETRY_BASE_DELAY_MS, capMs: RETRY_CAP_DELAY_MS, random });
  if (retryAfter > RETRY_CAP_DELAY_MS) throw new RetryAfterExceedsCapError(result.response.status, retryAfter);
  return retryAfter;
}

// 요청과 본문 읽기를 한 번의 시도로 묶어 일시 오류(timeout·연결 reset·HTTP 429/502/503/504)면 같은 GET을 다시 보낸다.
// 그 밖의 4xx·408·500·501·505·인증·스키마·원천 오류 코드는 재시도하지 않는다. 소진하면 기존 오류 분류로 그대로 실패한다(대체 데이터 없음).
// 로그에는 시도 번호·오류 종류·대기 ms만 남기고 URL·키·쿼리 값은 쓰지 않는다.
async function fetchSeoulPage({ url, fetchImpl, requestTimeoutMs, requestAttempts, sleepImpl, randomImpl, logImpl }) {
  let attempts = 0;
  let unhintedRateLimits = 0;
  let outcome;
  try {
    outcome = await withTransientRetry(async () => {
      attempts += 1;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (response.status === RATE_LIMITED_STATUS && retryAfterOf(response) === undefined) unhintedRateLimits += 1;
      return response.ok ? { response, raw: await readBodyOrTransportError(response) } : { response };
    }, {
      isTransientResult: ({ response }) => TRANSIENT_HTTP_STATUSES.has(response.status)
        && (response.status !== RATE_LIMITED_STATUS || retryAfterOf(response) !== undefined || unhintedRateLimits <= MAX_UNHINTED_RATE_LIMIT_RETRIES),
      isTransientError: isTransientTransportError,
      retryLimit: requestAttempts - 1,
      budget: createTransientRetryBudget(),
      sleep: sleepImpl,
      delayMs: ({ retryIndex, result }) => retryDelayMs({ retryIndex, result, random: randomImpl }),
      onRetry: (event) => {
        if (event.result !== undefined) discardBody(event.result.response);
        logImpl(`Seoul accessibility retry attempt=${event.retryIndex + 1}/${requestAttempts} kind=${attemptFailureKind(event)} delayMs=${event.delayMs}`);
      },
    });
  } catch (error) {
    if (error.code === RETRY_AFTER_EXCEEDS_CAP) {
      logImpl(`Seoul accessibility request failed after ${attempts} attempts: ${RETRY_AFTER_EXCEEDS_CAP}`);
      throw error;
    }
    const cause = unwrapTransientRetryFailure(error);
    if (attempts > 1) logImpl(`Seoul accessibility request failed after ${attempts} attempts: ${failureKind(cause)}`);
    throw new Error(`Seoul accessibility API request failed: ${failureKind(cause)}`);
  }
  if (!outcome.response.ok && attempts > 1) {
    logImpl(`Seoul accessibility request failed after ${attempts} attempts: HTTP_${outcome.response.status}`);
  }
  return outcome;
}

export async function collectSeoulAccessibility({
  endpoint,
  serviceKey,
  source = "accessibility",
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  requestAttempts = source === "facility-location" ? 1 : MAX_REQUEST_ATTEMPTS,
  sleepImpl,
  randomImpl,
  logImpl = logRetryLine,
  retainRawResponses = false,
}) {
  if (!Object.hasOwn(SOURCES, source)) throw new Error(`${INVALID_RESPONSE}: source`);
  const sourceConfig = SOURCES[source];
  if (source === "facility-location" && endpoint !== sourceConfig.endpoint) {
    throw new Error(`${INVALID_RESPONSE}: endpoint`);
  }
  const normalizedServiceKey = normalizeDataGoKrServiceKey(serviceKey);
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:") {
    throw new Error("HTTPS endpoint is required");
  }
  const collected = [];
  const rawPages = [];
  const rawResponses = [];
  const rowIdentities = new Set();
  if (!Number.isSafeInteger(requestAttempts) || requestAttempts < 1 || requestAttempts > MAX_REQUEST_ATTEMPTS
    || (source === "facility-location" && requestAttempts !== 1)) {
    throw new Error(`${INVALID_RESPONSE}: requestAttempts`);
  }
  let receivedCount = 0;
  let pageNo = 1;
  let totalCount;
  while (totalCount === undefined || receivedCount < totalCount) {
    const url = new URL(endpointUrl);
    url.searchParams.set("serviceKey", normalizedServiceKey);
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("numOfRows", "1000");
    url.searchParams.set("dataType", "JSON");
    const { response, raw } = await fetchSeoulPage({
      url, fetchImpl, requestTimeoutMs, requestAttempts, sleepImpl, randomImpl, logImpl,
    });
    if (!response.ok) {
      throw new Error(`Seoul accessibility API HTTP ${response.status}`);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
      if (normalizedServiceKey.length >= 16
        && containsCredentialRepresentation(payload, normalizedServiceKey)) {
        throw new Error(INVALID_RESPONSE);
      }
    } catch {
      throw new Error(INVALID_RESPONSE);
    }
    if (payload?.response?.header?.resultCode !== "00") {
      throw new Error(`${INVALID_RESPONSE}: envelope`);
    }
    const body = payload.response?.body;
    const rows = body?.items?.item;
    if (!Array.isArray(rows)) {
      throw new Error(`${INVALID_RESPONSE}: items`);
    }
    const pageTotal = Number(body.totalCount);
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || (totalCount !== undefined && pageTotal !== totalCount)) {
      throw new Error(`${INVALID_RESPONSE}: totalCount`);
    }
    totalCount = pageTotal;
    for (const row of rows) {
      const rowIdentity = hash(row);
      if (rowIdentities.has(rowIdentity)) throw new Error(`${INVALID_RESPONSE}: pagination`);
      rowIdentities.add(rowIdentity);
    }
    const rawResponseSha256 = hashText(raw);
    rawPages.push({ pageNo, totalCount: pageTotal, rawSha256: rawResponseSha256 });
    if (retainRawResponses) {
      const bytes = Buffer.from(raw);
      rawResponses.push({
        pageNo,
        providerResultCode: "00",
        rawResponseSha256,
        byteSize: bytes.length,
        bodyBase64: bytes.toString("base64"),
      });
    }
    const normalizedRows = normalizeAccessibilityRows(rows, { source });
    collected.push(...normalizedRows);
    receivedCount += rows.length;
    if (receivedCount > totalCount || (receivedCount < totalCount && rows.length === 0)) {
      throw new Error(`${INVALID_RESPONSE}: pagination`);
    }
    pageNo += 1;
  }
  if (totalCount === 0 || collected.length === 0) {
    throw new Error(`${INVALID_RESPONSE}: emptyExhaustiveList`);
  }
  return {
    rows: collected,
    rawRowCount: totalCount,
    rawSha256: hash(rawPages),
    ...(retainRawResponses ? { rawResponses } : {}),
  };
}

export async function collectSeoulAccessibilityObservation({
  source = "accessibility",
  endpoint = SOURCES[source]?.endpoint,
  serviceKey,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  requestAttempts = source === "facility-location" ? 1 : MAX_REQUEST_ATTEMPTS,
  sleepImpl,
  randomImpl,
  logImpl,
  retrievedAt = new Date().toISOString(),
  previousSnapshot = null,
} = {}) {
  if (!Object.hasOwn(SOURCES, source)) throw new Error(`${INVALID_RESPONSE}: source`);
  const collected = await collectSeoulAccessibility({
    endpoint,
    serviceKey,
    source,
    fetchImpl,
    requestTimeoutMs,
    requestAttempts,
    sleepImpl,
    randomImpl,
    logImpl,
    retainRawResponses: true,
  });
  const snapshot = validateSeoulAccessibilitySnapshotIdentity(buildAccessibilitySnapshot(
    collected.rows,
    retrievedAt,
    { source, ...collected, previousSnapshot },
  ), { source });
  const responses = collected.rawResponses;
  const rawArtifact = validateSeoulAccessibilityRawCollection({
    schemaVersion: 1,
    artifactKind: "seoul-accessibility-raw-collection",
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    snapshotRawSha256: snapshot.rawSha256,
    credentialRedacted: true,
    requestCount: responses.length,
    inventorySha256: hash(responses.map(({ bodyBase64: _, ...response }) => response)),
    responses,
  }, snapshot, { source });
  return { snapshot, rawArtifact };
}

export function validateSeoulAccessibilitySnapshotIdentity(snapshot, { source = "accessibility" } = {}) {
  if (!Object.hasOwn(SOURCES, source)) throw new Error(`${INVALID_RESPONSE}: source`);
  const sourceConfig = SOURCES[source];
  const stationKeys = source === "facility-location"
    ? ["stationName", "lineName", "providerStationCode", "facilities"]
    : ["stationName", "lineName", "facilities"];
  const expectedKeys = [
    "schemaVersion", "artifactKind", "sourceId", "snapshotId", "previousSnapshotId",
    "retrievedAt", "capturedAt", "observedAt", "freshUntil", "credentialRedacted",
    "absenceEvidenceMode", "rowCount", "normalizedRowCount", "rawSha256", "contentSha256",
    "schemaFingerprint", "stations",
  ];
  const capturedAt = Date.parse(snapshot?.capturedAt);
  const expectedId = `${sourceConfig.sourceId}-${typeof snapshot?.capturedAt === "string"
    ? snapshot.capturedAt.replaceAll(/[-:.]/g, "") : ""}`;
  if (!exactKeys(snapshot, expectedKeys)
    || snapshot.schemaVersion !== 1
    || snapshot.artifactKind !== sourceConfig.artifactKind
    || snapshot.sourceId !== sourceConfig.sourceId
    || snapshot.snapshotId !== expectedId
    || !(snapshot.previousSnapshotId === null
      || (typeof snapshot.previousSnapshotId === "string"
        && snapshot.previousSnapshotId.startsWith(`${snapshot.sourceId}-`)))
    || !Number.isFinite(capturedAt)
    || new Date(capturedAt).toISOString() !== snapshot.capturedAt
    || snapshot.retrievedAt !== snapshot.capturedAt
    || snapshot.observedAt !== snapshot.capturedAt
    || Date.parse(snapshot.freshUntil) !== capturedAt + 86_400_000
    || snapshot.credentialRedacted !== true
    || snapshot.absenceEvidenceMode !== "EXHAUSTIVE_LIST"
    || !Number.isSafeInteger(snapshot.rowCount) || snapshot.rowCount < 1
    || !Number.isSafeInteger(snapshot.normalizedRowCount) || snapshot.normalizedRowCount < 1
    || snapshot.normalizedRowCount > snapshot.rowCount
    || !/^[0-9a-f]{64}$/.test(snapshot.rawSha256 ?? "")
    || !/^[0-9a-f]{64}$/.test(snapshot.contentSha256 ?? "")
    || snapshot.schemaFingerprint !== hash(sourceConfig.schemaFields)
    || !Array.isArray(snapshot.stations) || snapshot.stations.length < 1
    || snapshot.contentSha256 !== hash(snapshot.stations)) {
    throw new Error("Seoul accessibility snapshot identity is invalid");
  }
  let facilityCount = 0;
  for (const station of snapshot.stations) {
    if (!exactKeys(station, stationKeys)
      || (source === "facility-location"
        && (typeof station.providerStationCode !== "string" || station.providerStationCode === ""))
      || typeof station.stationName !== "string" || station.stationName === ""
      || typeof station.lineName !== "string" || station.lineName === ""
      || !Array.isArray(station.facilities) || station.facilities.length < 1) {
      throw new Error("Seoul accessibility snapshot identity is invalid");
    }
    for (const facility of station.facilities) {
      if (!exactKeys(facility, ["operational", "situationCode", "situation", "pathDescription"])
        || !(typeof facility.operational === "boolean" || facility.operational === null)
        || !(typeof facility.situationCode === "string" || facility.situationCode === null)
        || typeof facility.situation !== "string" || facility.situation === ""
        || typeof facility.pathDescription !== "string" || facility.pathDescription === "") {
        throw new Error("Seoul accessibility snapshot identity is invalid");
      }
      facilityCount += 1;
    }
  }
  if (facilityCount !== snapshot.normalizedRowCount) {
    throw new Error("Seoul accessibility snapshot identity is invalid");
  }
  return snapshot;
}

export function validateSeoulAccessibilityRawCollection(rawArtifact, snapshotValue, { source = "accessibility" } = {}) {
  const snapshot = validateSeoulAccessibilitySnapshotIdentity(snapshotValue, { source });
  const expectedKeys = [
    "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "snapshotRawSha256",
    "credentialRedacted", "requestCount", "inventorySha256", "responses",
  ];
  if (!exactKeys(rawArtifact, expectedKeys)
    || rawArtifact.schemaVersion !== 1
    || rawArtifact.artifactKind !== "seoul-accessibility-raw-collection"
    || rawArtifact.sourceId !== snapshot.sourceId
    || rawArtifact.snapshotId !== snapshot.snapshotId
    || rawArtifact.capturedAt !== snapshot.capturedAt
    || rawArtifact.snapshotRawSha256 !== snapshot.rawSha256
    || rawArtifact.credentialRedacted !== true
    || !Array.isArray(rawArtifact.responses)
    || rawArtifact.requestCount !== rawArtifact.responses.length
    || rawArtifact.requestCount < 1
    || !/^[0-9a-f]{64}$/.test(rawArtifact.inventorySha256 ?? "")) {
    throw new Error("Seoul accessibility raw collection is invalid");
  }
  const rawPages = [];
  const providerRows = [];
  let received = 0;
  let totalCount;
  for (const [index, response] of rawArtifact.responses.entries()) {
    if (!exactKeys(response, [
      "pageNo", "providerResultCode", "rawResponseSha256", "byteSize", "bodyBase64",
    ]) || response.pageNo !== index + 1
      || response.providerResultCode !== "00"
      || !/^[0-9a-f]{64}$/.test(response.rawResponseSha256 ?? "")
      || !Number.isSafeInteger(response.byteSize) || response.byteSize < 1
      || typeof response.bodyBase64 !== "string" || response.bodyBase64 === "") {
      throw new Error("Seoul accessibility raw collection is invalid");
    }
    const bytes = Buffer.from(response.bodyBase64, "base64");
    if (bytes.toString("base64") !== response.bodyBase64
      || bytes.length !== response.byteSize
      || hashBytes(bytes) !== response.rawResponseSha256) {
      throw new Error("Seoul accessibility raw collection is invalid");
    }
    let payload;
    try { payload = JSON.parse(bytes); } catch { throw new Error("Seoul accessibility raw collection is invalid"); }
    const body = payload?.response?.body;
    const rows = body?.items?.item;
    const pageTotal = Number(body?.totalCount);
    if (payload?.response?.header?.resultCode !== "00" || !Array.isArray(rows)
      || !Number.isSafeInteger(pageTotal) || pageTotal < 1
      || (totalCount !== undefined && totalCount !== pageTotal)) {
      throw new Error("Seoul accessibility raw collection is invalid");
    }
    totalCount = pageTotal;
    received += rows.length;
    providerRows.push(...rows);
    rawPages.push({ pageNo: response.pageNo, totalCount: pageTotal, rawSha256: response.rawResponseSha256 });
  }
  const projected = buildAccessibilitySnapshot(
    normalizeAccessibilityRows(providerRows, { source }),
    snapshot.capturedAt,
    { source, rawRowCount: totalCount, rawSha256: snapshot.rawSha256 },
  );
  if (received !== totalCount || received !== snapshot.rowCount
    || snapshot.rawSha256 !== hash(rawPages)
    || projected.normalizedRowCount !== snapshot.normalizedRowCount
    || projected.contentSha256 !== snapshot.contentSha256
    || JSON.stringify(projected.stations) !== JSON.stringify(snapshot.stations)
    || rawArtifact.inventorySha256 !== hash(rawArtifact.responses.map(({ bodyBase64: _, ...response }) => response))) {
    throw new Error("Seoul accessibility raw collection is invalid");
  }
  return rawArtifact;
}

export async function writeSeoulAccessibilityObservation({ outputRoot, observation, source = "accessibility" } = {}) {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot)) {
    throw new Error("Seoul observation output root must be absolute");
  }
  try {
    await lstat(outputRoot);
    throw new Error("Seoul observation output root already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const { snapshot, rawArtifact } = observation ?? {};
  validateSeoulAccessibilityRawCollection(rawArtifact, snapshot, { source });
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  const rawArtifactBytes = Buffer.from(`${JSON.stringify(rawArtifact, null, 2)}\n`);
  const manifest = seoulObservationManifest(snapshot, snapshotBytes, rawArtifactBytes);
  const { snapshotFile, rawArtifactFile } = manifest;
  await mkdir(dirname(outputRoot), { recursive: true });
  const temporary = join(dirname(outputRoot), `.${basename(outputRoot)}.${randomUUID()}.tmp`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await Promise.all([
      writeFile(join(temporary, snapshotFile), snapshotBytes, { flag: "wx", mode: 0o600 }),
      writeFile(join(temporary, rawArtifactFile), rawArtifactBytes, { flag: "wx", mode: 0o600 }),
      writeFile(join(temporary, "observation.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 }),
    ]);
    await rename(temporary, outputRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

function seoulObservationManifest(snapshot, snapshotBytes, rawArtifactBytes) {
  return {
    schemaVersion: 1,
    artifactKind: "seoul-accessibility-observation",
    sourceId: snapshot.sourceId,
    capturedAt: snapshot.capturedAt,
    snapshotId: snapshot.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    snapshotFile: `${snapshot.snapshotId}.json`,
    snapshotFileSha256: hashBytes(snapshotBytes),
    rawArtifactFile: `${snapshot.snapshotId}.raw.json`,
    rawObjectSha256: hashBytes(rawArtifactBytes),
    rawObjectChecksumSha256: createHash("sha256").update(rawArtifactBytes).digest("base64"),
    rawObjectByteSize: rawArtifactBytes.length,
    credentialRedacted: true,
  };
}

// #834: 커밋된 observation manifest·snapshot·raw 보관본 bytes가 서로 결속되고 원문으로 snapshot이 재현되는지 검증한다.
export function validateSeoulAccessibilityObservation({ observation, snapshotBytes, rawArtifactBytes, source = "accessibility" } = {}) {
  if (!Buffer.isBuffer(snapshotBytes) || !Buffer.isBuffer(rawArtifactBytes)) {
    throw new Error("Seoul observation bytes are required");
  }
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const expected = seoulObservationManifest(snapshot, snapshotBytes, rawArtifactBytes);
  if (JSON.stringify(observation) !== JSON.stringify(expected)
    || !snapshotBytes.equals(Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`))) {
    throw new Error("Seoul observation manifest mismatch");
  }
  validateSeoulAccessibilityRawCollection(JSON.parse(rawArtifactBytes.toString("utf8")), snapshot, { source });
  return snapshot;
}

export async function writeSeoulAccessibilityEvidence({
  endpoint,
  serviceKey,
  source = "accessibility",
  output,
  outputRoot = REPOSITORY_ROOT,
  fetchImpl = fetch,
  retrievedAt = new Date().toISOString(),
  previousSnapshot = null,
}) {
  const { outputPath: requestedOutputPath } = await validatedOutputPath(output, outputRoot);
  if (!Object.hasOwn(SOURCES, source)) throw new Error(`${INVALID_RESPONSE}: source`);
  const sourceConfig = SOURCES[source];
  const collected = await collectSeoulAccessibility({
    endpoint: endpoint ?? sourceConfig.endpoint,
    serviceKey,
    source,
    fetchImpl,
  });
  const snapshot = buildAccessibilitySnapshot(collected.rows, retrievedAt, {
    source,
    ...collected,
    previousSnapshot,
  });
  const outputPath = extname(requestedOutputPath) === ".json"
    ? requestedOutputPath
    : join(requestedOutputPath, `${snapshot.snapshotId}.json`);
  if (extname(requestedOutputPath) === ".json"
    && basename(requestedOutputPath) !== `${snapshot.snapshotId}.json`) {
    throw new Error("output filename must match snapshot ID");
  }
  const { canonicalRoot } = await validatedOutputPath(outputPath, outputRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  const canonicalParent = await realpath(dirname(outputPath));
  if (!isPathWithin(canonicalRoot, canonicalParent)) {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  await writeOutputFileNoFollow(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

async function validatedOutputPath(output, outputRoot) {
  if (typeof output !== "string" || output.trim() === "") {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  const resolvedRoot = resolve(outputRoot);
  const outputPath = resolve(resolvedRoot, output);
  if (!isPathWithin(resolvedRoot, outputPath)) {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalAncestor = await nearestExistingCanonicalPath(dirname(outputPath));
  if (!isPathWithin(canonicalRoot, canonicalAncestor)) {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  try {
    if ((await lstat(outputPath)).isSymbolicLink()) {
      throw new Error(INVALID_OUTPUT_PATH);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return { outputPath, canonicalRoot };
}

async function writeOutputFileNoFollow(outputPath, contents) {
  if (!Number.isInteger(fileSystemConstants.O_NOFOLLOW)) {
    throw new Error(INVALID_OUTPUT_PATH);
  }
  let outputFile;
  try {
    outputFile = await open(
      outputPath,
      fileSystemConstants.O_WRONLY |
        fileSystemConstants.O_CREAT |
        fileSystemConstants.O_EXCL |
        fileSystemConstants.O_NOFOLLOW,
      0o600,
    );
    await outputFile.writeFile(contents);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(INVALID_OUTPUT_PATH);
    }
    throw error;
  } finally {
    await outputFile?.close();
  }
}

async function nearestExistingCanonicalPath(candidate) {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(INVALID_OUTPUT_PATH);
      }
      current = parent;
    }
  }
}

function isPathWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function containsCredentialRepresentation(payload, credential) {
  const encoded = encodeURIComponent(credential);
  const pending = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes(credential) || value.includes(encoded)) return true;
      try {
        if (decodeURIComponent(value).includes(credential)) return true;
      } catch {
        // An unrelated malformed percent escape is not a credential representation.
      }
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value != null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) pending.push(key, child);
    }
  }
  return false;
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key, index) => Object.keys(value)[index] === key);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readPreviousSnapshot(relativePath) {
  const canonicalSourceRoot = await realpath(SOURCE_SNAPSHOT_ROOT);
  const canonicalPreviousPath = await realpath(resolve(REPOSITORY_ROOT, relativePath));
  if (!isPathWithin(canonicalSourceRoot, canonicalPreviousPath)) {
    throw new Error(`${INVALID_RESPONSE}: snapshotIdentity`);
  }
  return JSON.parse(await readFile(canonicalPreviousPath, "utf8"));
}

export async function seoulObservationOutputRoot(directoryName) {
  if (typeof directoryName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(directoryName)) {
    throw new Error("Seoul observation directory name is invalid");
  }
  const canonicalTempRoot = await realpath(tmpdir());
  return join(canonicalTempRoot, `easysubway-seoul-accessibility-${directoryName}`);
}

async function runObservationCli() {
    const sourceArgument = process.argv[4] === "--source";
    const previousSnapshotIndex = sourceArgument ? 6 : 4;
    const previousSnapshotArgument = process.argv[previousSnapshotIndex] === "--previous-snapshot";
    if (process.argv.length !== previousSnapshotIndex + (previousSnapshotArgument ? 2 : 0)
      || process.argv[2] !== "--observation-name") {
      throw new Error(
        "usage: collect-seoul-accessibility-evidence.mjs --observation-name <safe-name> [--source <accessibility|facility-location>] [--previous-snapshot <repository-relative-path>]",
      );
    }
    const source = sourceArgument ? process.argv[5] : "accessibility";
    if (!Object.hasOwn(SOURCES, source)) throw new Error(`${INVALID_RESPONSE}: source`);
    const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
    if (!serviceKey) throw new Error("DATA_GO_KR_SERVICE_KEY env is required");
    const previousSnapshot = previousSnapshotArgument
      ? await readPreviousSnapshot(process.argv[previousSnapshotIndex + 1])
      : null;
    const observation = await collectSeoulAccessibilityObservation({ source, serviceKey, previousSnapshot });
    const outputRoot = await seoulObservationOutputRoot(process.argv[3]);
    await writeSeoulAccessibilityObservation({ outputRoot, observation, source });
}

async function runLegacyCli() {
  const sourceArgument = process.argv[6] === "--source";
  const previousSnapshotIndex = sourceArgument ? 8 : 6;
  const previousSnapshotArgument = process.argv[previousSnapshotIndex] === "--previous-snapshot";
  if (
    ![6, sourceArgument ? 8 : -1, previousSnapshotArgument ? previousSnapshotIndex + 2 : -1].includes(process.argv.length) ||
    process.argv[2] !== "--output" ||
    process.argv[4] !== "--output-root"
  ) {
    throw new Error(
      "usage: collect-seoul-accessibility-evidence.mjs --output <path-or-directory> --output-root <path> [--source <accessibility|facility-location>] [--previous-snapshot <repository-relative-path>]",
    );
  }
  const source = sourceArgument ? process.argv[7] : "accessibility";
  if (!Object.hasOwn(SOURCES, source)) throw new Error(`${INVALID_RESPONSE}: source`);
  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!serviceKey) {
    throw new Error("DATA_GO_KR_SERVICE_KEY env is required");
  }
  const previousSnapshot = previousSnapshotArgument
    ? await readPreviousSnapshot(process.argv[previousSnapshotIndex + 1])
    : null;
  await writeSeoulAccessibilityEvidence({
    source,
    serviceKey,
    output: process.argv[3],
    outputRoot: process.argv[5],
    previousSnapshot,
  });
}

async function main() {
  if (process.argv[2] === "--observation-name") return runObservationCli();
  return runLegacyCli();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "accessibility collection failed"}\n`);
    process.exitCode = 1;
  });
}
