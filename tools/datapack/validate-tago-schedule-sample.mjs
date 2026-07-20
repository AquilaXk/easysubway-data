#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const REQUIRED_FIELDS = [
  "subwayRouteId",
  "subwayStationId",
  "subwayStationNm",
  "dailyTypeCode",
  "upDownTypeCode",
  "depTime",
  "arrTime",
];
const OBSERVED_FIELDS = [
  ...REQUIRED_FIELDS,
  "endSubwayStationNm",
  "endSubwayStationId",
];
const DAILY_TYPE_CODES = new Set(["01", "02", "03"]);
const UP_DOWN_CODES = new Set(["U", "D"]);
const TAGO_SCHEDULE_ENDPOINT = "https://apis.data.go.kr/1613000/SubwayInfo/GetSubwaySttnAcctoSchdulList";
const TAGO_STATION_DISCOVERY_ENDPOINT = "https://apis.data.go.kr/1613000/SubwayInfo/GetKwrdFndSubwaySttnList";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    if (
      flag === "--plan" ||
      flag === "--summary" ||
      flag === "--collect" ||
      flag === "--discover-stations" ||
      flag === "--quiet"
    ) {
      args[flag.slice(2)] = true;
      continue;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    args[flag.slice(2)] = value;
    index += 1;
  }
  args.input ??= args.sample;
  if (!args.input) {
    throw new Error("--input is required");
  }
  return args;
}

function validateTagoScheduleSample(rawText, options = {}) {
  const payload = JSON.parse(rawText);
  rejectCredentialLeak(rawText, payload);
  if (payload.response?.header && payload.response.header.resultCode !== "00") {
    throw new Error(`TAGO response is not normal service: ${payload.response?.header?.resultCode ?? "missing"}`);
  }

  const rows = normalizeRows(payload.response?.body?.items?.item);
  if (rows.length === 0) {
    if (!options.allowEmptyRows) {
      throw new Error("TAGO schedule sample has no rows");
    }
    if (!isNormalEmptyTagoSchedulePayload(payload)) {
      throw new Error("TAGO schedule empty response shape is invalid");
    }
    return buildTagoScheduleValidationResult(rawText, rows, [], [], true);
  }
  const observedFields = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const field of OBSERVED_FIELDS) {
    if (!observedFields.has(field)) {
      throw new Error(`TAGO schedule sample missing observed field: ${field}`);
    }
  }

  const parsedRows = [];
  for (const [index, row] of rows.entries()) {
    for (const field of REQUIRED_FIELDS) {
      if (typeof row[field] !== "string" || row[field].length === 0) {
        throw new Error(`TAGO schedule row ${index} missing field: ${field}`);
      }
    }
    if (!DAILY_TYPE_CODES.has(row.dailyTypeCode)) {
      throw new Error(`TAGO schedule row ${index} has unknown dailyTypeCode: ${row.dailyTypeCode}`);
    }
    if (!UP_DOWN_CODES.has(row.upDownTypeCode)) {
      throw new Error(`TAGO schedule row ${index} has unknown upDownTypeCode: ${row.upDownTypeCode}`);
    }
    // 서울교통공사 스케줄은 시발(origin) 열차의 arrTime, 종착(terminal) 열차의 depTime을 "0"으로 채운다.
    // 한쪽이 없으면 있는 쪽으로 대체(도착=출발 무정차 대기). 코레일 등은 둘 다 정상 HHMMSS로 제공한다.
    const arrMissing = isMissingTagoTime(row.arrTime);
    const depMissing = isMissingTagoTime(row.depTime);
    if (arrMissing && depMissing) {
      throw new Error(`TAGO schedule row ${index} has neither arrTime nor depTime`);
    }
    const parsedArrival = arrMissing ? null : parseHhmmss(row.arrTime, `row ${index} arrTime`);
    const parsedDeparture = depMissing ? null : parseHhmmss(row.depTime, `row ${index} depTime`);
    const arrivalSeconds = parsedArrival ?? parsedDeparture;
    const departureSeconds = parsedDeparture ?? parsedArrival;
    if (arrivalSeconds > departureSeconds) {
      throw new Error(`TAGO schedule row ${index} arrival must be <= departure`);
    }
    const rowHash = sha256(JSON.stringify(sortObject(row)));
    parsedRows.push({
      row,
      rowHash,
      subwayStationId: row.subwayStationId,
      subwayRouteId: row.subwayRouteId,
      dailyTypeCode: row.dailyTypeCode,
      upDownTypeCode: row.upDownTypeCode,
      arrivalSeconds,
      departureSeconds,
    });
  }
  parsedRows.sort(
    (left, right) =>
      left.departureSeconds - right.departureSeconds ||
      left.arrivalSeconds - right.arrivalSeconds ||
      codepointCompare(left.rowHash, right.rowHash),
  );
  const providerRecordHashes = parsedRows.map(({ rowHash }) => rowHash);
  const departures = parsedRows.map(({ row: _row, rowHash: _rowHash, ...departure }) => departure);

  const scheduleRows = parsedRows.map(({ row }) => sortObject(row));

  return buildTagoScheduleValidationResult(rawText, rows, providerRecordHashes, departures, false, scheduleRows);
}

function buildTagoScheduleValidationResult(
  rawText,
  rows,
  providerRecordHashes,
  departures,
  emptyProviderResponse,
  scheduleRows = [],
) {
  return {
    artifactKind: "tago-schedule-sample-importer-validation",
    candidateId: "molit-tago-subway-info",
    endpoint: TAGO_SCHEDULE_ENDPOINT,
    rowCount: rows.length,
    providerRecordHashes,
    rawSha256: sha256(rawText),
    departures,
    scheduleRows,
    emptyProviderResponse,
    stationLevelOnly: true,
    productionUseAllowed: false,
    remainingAdmissionBlocker: "line_wide_trip_stop_sequence_validation_required",
    stationTimetableProjectionStatus: "validated",
    productionCanonicalStopTimesStatus: "blocked_requires_trip_stop_sequence",
    plannedEtaUseAllowed: false,
  };
}

function buildTagoScheduleCollectionPlan(input, checkpoint = {}, dailyLimit = 1000) {
  if (!Number.isInteger(dailyLimit) || dailyLimit <= 0) {
    throw new Error("dailyLimit must be a positive integer");
  }
  const completed = new Set(checkpoint.completedRequestKeys ?? []);
  const stationIds = tagoStationIds(input);
  const allRequests = stationIds.flatMap((stationId) =>
    [...DAILY_TYPE_CODES].flatMap((dailyTypeCode) =>
      [...UP_DOWN_CODES].map((upDownTypeCode) => {
        const requestKey = `${stationId}|${dailyTypeCode}|${upDownTypeCode}`;
        return {
          requestKey,
          stationId,
          dailyTypeCode,
          upDownTypeCode,
          url: `${TAGO_SCHEDULE_ENDPOINT}?serviceKey=[서비스키값]&pageNo=1&numOfRows=1000&_type=json&subwayStationId=${stationId}&dailyTypeCode=${dailyTypeCode}&upDownTypeCode=${upDownTypeCode}`,
        };
      }),
    ),
  );
  const pending = allRequests.filter((request) => !completed.has(request.requestKey));
  return {
    artifactKind: "tago-schedule-collection-plan",
    sourceId: "molit-tago-subway-info",
    endpoint: TAGO_SCHEDULE_ENDPOINT,
    dailyLimit,
    stationCount: stationIds.length,
    totalRequestCount: allRequests.length,
    completedRequestCount: allRequests.length - pending.length,
    pendingRequestCount: pending.length,
    batches: chunk(pending, dailyLimit).map((requests, index) => ({ batchNumber: index + 1, requests })),
  };
}

function buildTagoScheduleCollectionSummary(collection) {
  const responses = collection?.responses;
  if (!Array.isArray(responses)) {
    throw new Error("responses must be an array");
  }
  const checkpointRequestKeys = collection?.checkpoint?.completedRequestKeys ?? [];
  if (responses.length === 0 && checkpointRequestKeys.length === 0) {
    throw new Error("responses must be non-empty unless checkpoint has completedRequestKeys");
  }
  for (const requestKey of checkpointRequestKeys) {
    requestKeyParts(requestKey);
  }
  const responseRequestKeys = [];
  const emptyResponseRequestKeys = [];
  const rawSha256ByRequest = {};
  const providerRecordHashes = [];
  const scheduleRows = [];
  let rowCount = 0;

  for (const response of responses) {
    requestKeyParts(response.requestKey);
  }
  for (const response of [...responses].sort((left, right) => codepointCompare(left.requestKey, right.requestKey))) {
    if (responseRequestKeys.includes(response.requestKey)) {
      throw new Error(`duplicate requestKey: ${response.requestKey}`);
    }
    if (typeof response.rawText !== "string" || response.rawText.length === 0) {
      throw new Error(`responses.rawText is required: ${response.requestKey}`);
    }
    const validation = validateTagoScheduleSample(response.rawText, { allowEmptyRows: true });
    assertResponseMatchesRequestKey(validation, response.requestKey);
    responseRequestKeys.push(response.requestKey);
    if (validation.emptyProviderResponse) {
      emptyResponseRequestKeys.push(response.requestKey);
    }
    rawSha256ByRequest[response.requestKey] = validation.rawSha256;
    providerRecordHashes.push(...validation.providerRecordHashes);
    scheduleRows.push(...validation.scheduleRows);
    rowCount += validation.rowCount;
  }
  const completedRequestKeys = [...new Set([...checkpointRequestKeys, ...responseRequestKeys])].sort(
    (left, right) => codepointCompare(left, right),
  );

  const evidencePayload = {
    sourceId: "molit-tago-subway-info",
    endpoint: TAGO_SCHEDULE_ENDPOINT,
    completedRequestKeys,
    responseRequestKeys,
    emptyResponseRequestKeys,
    rawSha256ByRequest,
    providerRecordHashes,
    scheduleRows,
  };
  return {
    artifactKind: "tago-schedule-collection-summary",
    sourceId: evidencePayload.sourceId,
    endpoint: evidencePayload.endpoint,
    completedRequestKeys,
    responseRequestKeys,
    emptyResponseRequestKeys,
    checkpoint: { completedRequestKeys },
    responseCount: responseRequestKeys.length,
    rowCount,
    rawSha256ByRequest,
    providerRecordHashes,
    scheduleRows,
    evidenceHash: sha256(JSON.stringify(evidencePayload)),
    stationLevelOnly: true,
    productionUseAllowed: false,
    remainingAdmissionBlocker: "line_wide_trip_stop_sequence_validation_required",
  };
}

async function collectTagoSchedules(input, options = {}) {
  const serviceKey = requiredString(options.serviceKey, "serviceKey");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch is required for TAGO schedule collection");
  }
  const checkpoint = options.checkpoint ?? {};
  const dailyLimit = options.dailyLimit ?? 1000;
  const plan = buildTagoScheduleCollectionPlan(input, checkpoint, dailyLimit);
  const requests = plan.batches[0]?.requests ?? [];
  const collectedAt = options.collectedAt ?? new Date().toISOString();
  const responses = [];

  for (const request of requests) {
    let response;
    try {
      response = await fetchImpl(buildTagoScheduleRequestUrl(request, serviceKey));
    } catch {
      throw new TagoScheduleCollectionError(
        `TAGO schedule fetch failed before response: ${request.requestKey}`,
        buildTagoScheduleCollectionArtifact(plan, options, collectedAt, responses, {
          failedRequestKey: request.requestKey,
        }),
      );
    }
    if (!response.ok) {
      throw new TagoScheduleCollectionError(
        `TAGO schedule fetch failed: ${request.requestKey} status ${response.status}`,
        buildTagoScheduleCollectionArtifact(plan, options, collectedAt, responses, {
          failedRequestKey: request.requestKey,
        }),
      );
    }
    let rawText;
    try {
      rawText = await response.text();
    } catch {
      throw new TagoScheduleCollectionError(
        `TAGO schedule response read failed: ${request.requestKey}`,
        buildTagoScheduleCollectionArtifact(plan, options, collectedAt, responses, {
          failedRequestKey: request.requestKey,
        }),
      );
    }
    try {
      const validation = validateTagoScheduleSample(rawText, { allowEmptyRows: true });
      assertResponseMatchesRequestKey(validation, request.requestKey);
    } catch (error) {
      throw new TagoScheduleCollectionError(
        error instanceof Error ? error.message : `TAGO schedule validation failed: ${request.requestKey}`,
        buildTagoScheduleCollectionArtifact(plan, options, collectedAt, responses, {
          failedRequestKey: request.requestKey,
        }),
      );
    }
    responses.push({ requestKey: request.requestKey, rawText });
  }

  return buildTagoScheduleCollectionArtifact(plan, options, collectedAt, responses);
}

async function collectTagoStationDiscovery(input, options = {}) {
  const serviceKey = requiredString(options.serviceKey, "serviceKey");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch is required for TAGO station discovery");
  }
  const stationNames = [...new Set((input.stationLineRows ?? []).map((row) => row.stationNameKo).filter(Boolean))];
  if (stationNames.length === 0) {
    throw new Error("stationLineRows must contain stationNameKo");
  }
  const discoveredAt = options.discoveredAt ?? new Date().toISOString();
  const queries = [];

  for (const stationNameKo of stationNames) {
    try {
      const response = await fetchImpl(buildTagoStationDiscoveryRequestUrl(stationNameKo, serviceKey));
      if (!response.ok) {
        throw new Error(`TAGO station discovery failed: ${stationNameKo} status ${response.status}`);
      }
      const rawText = await response.text();
      const payload = JSON.parse(rawText);
      rejectCredentialLeak(rawText, payload);
      if (payload.response?.header && payload.response.header.resultCode !== "00") {
        throw new Error(`TAGO station discovery is not normal service: ${stationNameKo}`);
      }
      const candidates = normalizeRows(payload.response?.body?.items?.item).map((row) => sortObject(row));
      queries.push({
        stationNameKo,
        rawSha256: sha256(rawText),
        rowCount: candidates.length,
        providerRecordHashes: candidates.map((row) => sha256(JSON.stringify(row))),
        candidates,
      });
    } catch (error) {
      throw new TagoStationDiscoveryError(
        error instanceof Error ? error.message : `TAGO station discovery failed: ${stationNameKo}`,
        buildTagoStationDiscoveryArtifact(options, discoveredAt, queries, { failedStationNameKo: stationNameKo }),
      );
    }
  }

  return buildTagoStationDiscoveryArtifact(options, discoveredAt, queries);
}

function buildTagoStationDiscoveryArtifact(options, discoveredAt, queries, failure = {}) {
  const failedRequestCount = failure.failedStationNameKo ? 1 : 0;
  return {
    artifactKind: "tago-station-discovery",
    sourceId: "molit-tago-subway-info",
    endpoint: TAGO_STATION_DISCOVERY_ENDPOINT,
    serviceKeyEnv: options.serviceKeyEnv ?? "DATA_GO_KR_SERVICE_KEY",
    discoveredAt,
    queryCount: queries.length,
    quotaObservedRequestCount: queries.length + failedRequestCount,
    collectionStatus: failure.failedStationNameKo ? "partial_failed" : "completed_batch",
    ...(failure.failedStationNameKo ? { failedStationNameKo: failure.failedStationNameKo } : {}),
    queries,
  };
}

function buildTagoScheduleCollectionArtifact(plan, options, collectedAt, responses, failure = {}) {
  const checkpoint = options.checkpoint ?? {};
  const failedRequestCount = failure.failedRequestKey ? 1 : 0;
  const completedRequestKeys = [
    ...new Set([...(checkpoint.completedRequestKeys ?? []), ...responses.map((response) => response.requestKey)]),
  ].sort((left, right) => codepointCompare(left, right));
  return {
    artifactKind: "tago-schedule-collection",
    sourceId: plan.sourceId,
    endpoint: plan.endpoint,
    serviceKeyEnv: options.serviceKeyEnv ?? "DATA_GO_KR_SERVICE_KEY",
    collectedAt,
    dailyLimit: plan.dailyLimit,
    totalRequestCount: plan.totalRequestCount,
    requestedCount: responses.length,
    completedRequestCount: completedRequestKeys.length,
    pendingRequestCount: Math.max(0, plan.pendingRequestCount - responses.length),
    completedRequestKeys,
    checkpoint: { completedRequestKeys },
    collectionStatus: failure.failedRequestKey ? "partial_failed" : "completed_batch",
    collectionReport: {
      stationCount: plan.stationCount,
      totalCallCount: plan.totalRequestCount,
      attemptedCallCount: responses.length + failedRequestCount,
      successfulCallCount: responses.length,
      failedCallCount: failedRequestCount,
      // ponytail: no retry loop yet; count actual retries here if collection adds one.
      retryCount: 0,
      quotaObservedRequestCount: responses.length + failedRequestCount,
      quotaDailyLimit: plan.dailyLimit,
    },
    ...(failure.failedRequestKey ? { failedRequestKey: failure.failedRequestKey } : {}),
    responses,
  };
}

class TagoScheduleCollectionError extends Error {
  constructor(message, collection) {
    super(message);
    this.name = "TagoScheduleCollectionError";
    this.collection = collection;
  }
}

class TagoStationDiscoveryError extends Error {
  constructor(message, collection) {
    super(message);
    this.name = "TagoStationDiscoveryError";
    this.collection = collection;
  }
}

function buildTagoScheduleRequestUrl(request, serviceKey) {
  const [stationId, dailyTypeCode, upDownTypeCode] = requestKeyParts(request.requestKey);
  const params = new URLSearchParams();
  params.set("pageNo", "1");
  params.set("numOfRows", "1000");
  params.set("_type", "json");
  params.set("subwayStationId", stationId);
  params.set("dailyTypeCode", dailyTypeCode);
  params.set("upDownTypeCode", upDownTypeCode);
  return `${TAGO_SCHEDULE_ENDPOINT}?serviceKey=${encodeDataGoKrServiceKey(serviceKey)}&${params.toString()}`;
}

function buildTagoStationDiscoveryRequestUrl(stationNameKo, serviceKey) {
  const params = new URLSearchParams();
  params.set("pageNo", "1");
  params.set("numOfRows", "100");
  params.set("_type", "json");
  params.set("subwayStationName", stationNameKo);
  return `${TAGO_STATION_DISCOVERY_ENDPOINT}?serviceKey=${encodeDataGoKrServiceKey(serviceKey)}&${params.toString()}`;
}

function encodeDataGoKrServiceKey(serviceKey) {
  return /%[0-9a-f]{2}/i.test(serviceKey) ? serviceKey : encodeURIComponent(serviceKey);
}

function assertResponseMatchesRequestKey(validation, requestKey) {
  const [stationId, dailyTypeCode, upDownTypeCode] = requestKeyParts(requestKey);
  if (
    validation.departures.some(
      (row) =>
        row.subwayStationId !== stationId ||
        row.dailyTypeCode !== dailyTypeCode ||
        row.upDownTypeCode !== upDownTypeCode,
    )
  ) {
    throw new Error(`response does not match requestKey: ${requestKey}`);
  }
}

function requestKeyParts(requestKey) {
  if (typeof requestKey !== "string" || requestKey.length === 0) {
    throw new Error("responses.requestKey is required");
  }
  const parts = requestKey.split("|");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(`response does not match requestKey: ${requestKey}`);
  }
  return parts;
}

function tagoStationIds(input) {
  const stationIds = new Set();
  for (const row of input.stationLineRows ?? []) {
    // discovery(GetKwrdFndSubwaySttnList)로 확인된 실제 provider station id를 formula보다 우선한다.
    // 운영기관 prefix가 다르므로(코레일 MTRKR vs 서울교통공사 MTRS1) formula는 사당 등 비-코레일 역에서 틀린다.
    if (row.providerStationId) {
      stationIds.add(row.providerStationId);
      continue;
    }
    if (!row.stationCode) continue;
    // seoul-4 코레일 구간 한정 폴백. 비-코레일 역은 providerStationId를 명시해야 한다.
    if (row.stationCode.startsWith("MTRKR")) {
      stationIds.add(row.stationCode);
      continue;
    }
    if (row.lineId !== "seoul-4") {
      throw new Error(`Unsupported lineId for pilot mapping: ${row.lineId}`);
    }
    stationIds.add(`MTRKR4${row.stationCode}`);
  }
  if (stationIds.size === 0) {
    throw new Error("stationLineRows must contain at least one providerStationId or stationCode");
  }
  return [...stationIds];
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeRows(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return [value];
  }
  return [];
}

function isNormalEmptyTagoSchedulePayload(payload) {
  if (payload.response?.header?.resultCode !== "00") {
    return false;
  }
  const items = payload.response?.body?.items;
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return false;
  }
  return !("item" in items) || (Array.isArray(items.item) && items.item.length === 0);
}

function isMissingTagoTime(value) {
  // 서울교통공사 스케줄은 시발역 arrTime·종착역 depTime을 "0"(또는 전부 0)으로 채운다(미제공 표기).
  return /^0+$/.test(value);
}

function parseHhmmss(value, label) {
  if (!/^\d{6}$/.test(value)) {
    throw new Error(`${label} must use HHMMSS`);
  }
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2, 4));
  const seconds = Number(value.slice(4, 6));
  if (hours > 29 || minutes > 59 || seconds > 59) {
    throw new Error(`${label} is out of range`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function rejectCredentialLeak(rawText, parsed, pathParts = []) {
  if (
    /serviceKey=(?!\[서비스키값\])[^&\s"]+/i.test(rawText) ||
    /"serviceKey"\s*:\s*"(?!\[서비스키값\]")[^"]+"/i.test(rawText)
  ) {
    throw new Error("TAGO schedule sample must not contain serviceKey credentials");
  }
  if (Array.isArray(parsed)) {
    for (const [index, item] of parsed.entries()) {
      rejectCredentialLeak("", item, [...pathParts, String(index)]);
    }
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (/serviceKey/i.test(key) && value !== "[서비스키값]") {
      throw new Error(`TAGO schedule sample must not contain serviceKey credentials: ${[...pathParts, key].join(".")}`);
    }
    rejectCredentialLeak("", value, [...pathParts, key]);
  }
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => codepointCompare(left, right)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  let result;
  if (args.plan) {
    const checkpoint = args.checkpoint ? JSON.parse(await readFile(path.resolve(args.checkpoint), "utf8")) : {};
    const dailyLimit = args["daily-limit"] === undefined ? undefined : Number(args["daily-limit"]);
    result = buildTagoScheduleCollectionPlan(JSON.parse(await readFile(inputPath, "utf8")), checkpoint, dailyLimit);
  } else if (args.collect) {
    const checkpoint = args.checkpoint ? JSON.parse(await readFile(path.resolve(args.checkpoint), "utf8")) : {};
    const dailyLimit = args["daily-limit"] === undefined ? undefined : Number(args["daily-limit"]);
    const serviceKeyEnv = args["service-key-env"] ?? "DATA_GO_KR_SERVICE_KEY";
    try {
      result = await collectTagoSchedules(JSON.parse(await readFile(inputPath, "utf8")), {
        checkpoint,
        dailyLimit,
        serviceKey: process.env[serviceKeyEnv],
        serviceKeyEnv,
      });
    } catch (error) {
      if (error instanceof TagoScheduleCollectionError && args.output) {
        await writeJsonOutput(args.output, error.collection);
      }
      throw error;
    }
  } else if (args["discover-stations"]) {
    const serviceKeyEnv = args["service-key-env"] ?? "DATA_GO_KR_SERVICE_KEY";
    try {
      result = await collectTagoStationDiscovery(JSON.parse(await readFile(inputPath, "utf8")), {
        serviceKey: process.env[serviceKeyEnv],
        serviceKeyEnv,
      });
    } catch (error) {
      if (error instanceof TagoStationDiscoveryError && args.output) {
        await writeJsonOutput(args.output, error.collection);
      }
      throw error;
    }
  } else if (args.summary) {
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    const inputDir = path.dirname(inputPath);
    result = buildTagoScheduleCollectionSummary({
      ...input,
      responses: await Promise.all(
        (input.responses ?? []).map(async (response) => ({
          ...response,
          rawText:
            response.rawText ??
            (await readFile(path.resolve(inputDir, requiredString(response.rawPath, "responses.rawPath")), "utf8")),
        })),
      ),
    });
  } else {
    result = validateTagoScheduleSample(await readFile(inputPath, "utf8"));
  }
  if (args.output) {
    await writeJsonOutput(args.output, result);
  }
  if (!args.quiet) {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function writeJsonOutput(outputPath, value) {
  const resolvedOutput = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutput), { recursive: true, mode: 0o700 });
  await writeFile(resolvedOutput, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export {
  buildTagoScheduleCollectionPlan,
  buildTagoScheduleCollectionSummary,
  collectTagoStationDiscovery,
  collectTagoSchedules,
  validateTagoScheduleSample,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
